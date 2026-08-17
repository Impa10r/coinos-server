import config from "$config";
import { HDKey } from "@scure/bip32";
import { p2wpkh, NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import got from "got";
import { SocksProxyAgent } from "socks-proxy-agent";

const { esploraUrl } = config.bitcoin;
// Optional onion mirror + Tor SOCKS5 proxy (same LNURL_PROXY used for lnurl
// fetches elsewhere). Public esplora instances often rate-limit their
// clearnet IP harder than their onion service. Bun's native fetch only
// speaks HTTP(S) proxies, not SOCKS5, so the onion path goes through got +
// SocksProxyAgent instead — same pattern routes/lnurl.ts already uses.
const esploraOnionUrl = (config.bitcoin as any).esploraOnionUrl as string | undefined;
const { LNURL_PROXY } = process.env;
const torAgent = LNURL_PROXY && esploraOnionUrl ? new SocksProxyAgent(LNURL_PROXY) : undefined;

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

// Try the onion mirror over Tor. Returns undefined (never throws) on any
// failure — connection refused, bad TLS, wrong shape, whatever — so the
// caller falls straight back to clearnet rather than surfacing an onion-
// specific error for what's ultimately an optional path.
const fetchOnion = async (path: string, init?: RequestInit): Promise<EsploraResponse | undefined> => {
  if (!torAgent || !esploraOnionUrl) return undefined;
  try {
    const res = await got(`${esploraOnionUrl}${path}`, {
      method: (init?.method as any) || "GET",
      body: init?.body as any,
      headers: init?.headers as any,
      agent: { http: torAgent as any, https: torAgent as any },
      throwHttpErrors: false,
      timeout: { request: 15_000 },
      retry: { limit: 0 },
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => JSON.parse(res.body),
      text: async () => res.body,
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
