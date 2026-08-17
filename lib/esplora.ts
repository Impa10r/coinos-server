import config from "$config";
import { HDKey } from "@scure/bip32";
import { p2wpkh, NETWORK, TEST_NETWORK } from "@scure/btc-signer";

const { esploraUrl } = config.bitcoin;
// Optional onion mirror + Tor SOCKS5 proxy (same LNURL_PROXY used for lnurl
// fetches elsewhere). Public esplora instances often rate-limit their
// clearnet IP harder than their onion service.
//
// This shells out to curl rather than using got + socks-proxy-agent (the
// pattern routes/lnurl.ts uses for its own onion routing): Bun's fetch does
// not correctly honor Node-style http.Agent objects — including
// socks-proxy-agent — over a proxy, a currently-open Bun runtime bug
// (oven-sh/bun#15499 and related). Confirmed directly: the exact same
// SOCKS5 request that fails from Bun with "FailedToOpenSocket" succeeds
// immediately via curl. routes/lnurl.ts's onion proxying likely hits the
// same bug — out of scope to fix here, but worth knowing about.
const esploraOnionUrl = (config.bitcoin as any).esploraOnionUrl as string | undefined;
const { LNURL_PROXY } = process.env;
const torProxyHostPort = (() => {
  if (!LNURL_PROXY) return undefined;
  try {
    const u = new URL(LNURL_PROXY);
    return `${u.hostname}:${u.port}`;
  } catch {
    return undefined;
  }
})();

const REGTEST_NETWORK = {
  bech32: "bcrt",
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

const REGTEST_VERSIONS = { private: 0x04358394, public: 0x043587cf };

const btcNetwork =
  config.bitcoin.network === "regtest"
    ? REGTEST_NETWORK
    : config.bitcoin.network === "testnet"
      ? TEST_NETWORK
      : NETWORK;

const hdVersions =
  config.bitcoin.network === "regtest" || config.bitcoin.network === "testnet"
    ? REGTEST_VERSIONS
    : undefined;

// Esplora API

// Public esplora instances can rate-limit with a sustained 429 window (not
// just a brief burst), and every exported function here shares that one
// budget. A per-call retry loop doesn't help against a sustained limit: N
// concurrent/sequential callers each independently backing off still add up
// to more requests than the server wants, so they keep colliding. Track the
// cooldown as shared module state instead — once any call gets a 429,
// EVERY subsequent esplora call (regardless of which function or caller)
// waits out the same cooldown before trying again, so the whole process
// actually slows down to what the server is asking for.
let cooldownUntil = 0;

// Normalized response shape shared by both transports (fetch's Response and
// got's Response have different shapes) so callers below never need to care
// which one actually served the request.
type EsploraResponse = { ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> };

// Try the onion mirror over Tor via curl (see the module-level comment for
// why not a JS proxy agent). Returns undefined (never throws) on any
// failure — connection refused, curl missing, bad shape, whatever — so the
// caller falls straight back to clearnet rather than surfacing an onion-
// specific error for what's ultimately an optional path.
const HTTP_STATUS_MARKER = "\n__COINOS_HTTP_STATUS__:";
const fetchOnion = async (path: string, init?: RequestInit): Promise<EsploraResponse | undefined> => {
  if (!torProxyHostPort || !esploraOnionUrl) return undefined;
  try {
    const method = (init?.method as string) || "GET";
    const args = [
      "curl",
      "-s",
      "--max-time",
      "15",
      "--socks5-hostname",
      torProxyHostPort,
      "-X",
      method,
      "-w",
      `${HTTP_STATUS_MARKER}%{http_code}`,
    ];
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        args.push("-H", `${k}: ${v}`);
      }
    }
    if (init?.body) args.push("--data-binary", String(init.body));
    args.push(`${esploraOnionUrl}${path}`);

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return undefined;

    const markerAt = out.lastIndexOf(HTTP_STATUS_MARKER);
    if (markerAt === -1) return undefined;
    const body = out.slice(0, markerAt);
    const status = Number.parseInt(out.slice(markerAt + HTTP_STATUS_MARKER.length), 10);
    if (!Number.isFinite(status)) return undefined;

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    };
  } catch {
    return undefined;
  }
};

const fetchEsplora = async (path: string, init?: RequestInit, maxRetries = 6): Promise<EsploraResponse> => {
  const onion = await fetchOnion(path, init);
  if (onion) return onion;

  for (let attempt = 0; ; attempt++) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));

    const r = await fetch(`${esploraUrl}${path}`, init);
    if (r.status !== 429) return r;

    const retryAfter = Number.parseFloat(r.headers.get("retry-after") || "");
    const delayMs = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
    cooldownUntil = Math.max(cooldownUntil, Date.now() + delayMs);

    if (attempt >= maxRetries) return r;
  }
};

export const getUtxos = async (address: string) => {
  const r = await fetchEsplora(`/address/${address}/utxo`);
  if (!r.ok) throw new Error(`esplora getUtxos: ${r.status}`);
  return r.json();
};

export const getAddressUtxos = async (addresses: string[]) => {
  const results = [];
  for (const address of addresses) {
    const utxos = await getUtxos(address);
    for (const u of utxos as any) {
      u.address = address;
      results.push(u);
    }
  }
  return results;
};

export const broadcastTx = async (txHex: string) => {
  const r = await fetchEsplora("/tx", {
    method: "POST",
    body: txHex,
    headers: { "Content-Type": "text/plain" },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`broadcast failed: ${body}`);
  }
  return r.text();
};

export const getTxStatus = async (txid: string) => {
  const r = await fetchEsplora(`/tx/${txid}/status`);
  if (!r.ok) throw new Error(`esplora getTxStatus: ${r.status}`);
  return r.json();
};

export const getFeeEstimates = async () => {
  const r = await fetchEsplora("/fee-estimates");
  if (!r.ok) throw new Error(`esplora getFeeEstimates: ${r.status}`);
  return r.json();
};

export const getTx = async (txid: string) => {
  const r = await fetchEsplora(`/tx/${txid}`);
  if (!r.ok) throw new Error(`esplora getTx: ${r.status}`);
  return r.json();
};

export const getAddressTxs = async (address: string) => {
  const r = await fetchEsplora(`/address/${address}/txs`);
  if (!r.ok) throw new Error(`esplora getAddressTxs: ${r.status}`);
  return r.json();
};

export const getTxHex = async (txid: string) => {
  const r = await fetchEsplora(`/tx/${txid}/hex`);
  if (!r.ok) throw new Error(`esplora getTxHex: ${r.status}`);
  return r.text();
};

// Address derivation

const hdVersionsForKey = (pubkey: string) => {
  if (pubkey.startsWith("tpub") || pubkey.startsWith("tprv")) return REGTEST_VERSIONS;
  // xpub/xprv use default BITCOIN_VERSIONS (mainnet) — pass undefined
  return undefined;
};

export const deriveAddress = (
  pubkey: string,
  _fingerprint: string,
  index: number,
  internal = false,
) => {
  const accountKey = HDKey.fromExtendedKey(pubkey, hdVersionsForKey(pubkey));
  const chain = internal ? 1 : 0;
  const child = accountKey.deriveChild(chain).deriveChild(index);

  const { address } = p2wpkh(child.publicKey, btcNetwork);
  const path = `m/${chain}/${index}`;

  return { address, path };
};

export const deriveAddresses = (
  pubkey: string,
  fingerprint: string,
  count: number,
  internal = false,
) => {
  const addresses = [];
  for (let i = 0; i < count; i++) {
    const { address } = deriveAddress(pubkey, fingerprint, i, internal);
    addresses.push(address);
  }
  return addresses;
};

// Migration helpers

export const parseDescriptor = (desc: string) => {
  // Parse wpkh([fingerprint]pubkey/0/*)#checksum
  const match = desc.match(/wpkh\(\[([a-f0-9]+)\]([^/]+)\/\d+\/\*\)/);
  if (!match) return null;
  return { fingerprint: match[1], pubkey: match[2] };
};

export const findLastUsedIndex = async (pubkey: string, fingerprint: string, maxScan = 100) => {
  let lastUsed = -1;
  for (let i = 0; i < maxScan; i++) {
    const { address } = deriveAddress(pubkey, fingerprint, i, false);
    const txs = await getAddressTxs(address);
    if ((txs as any).length > 0) lastUsed = i;
  }
  return lastUsed + 1;
};

export { btcNetwork, hdVersions };
