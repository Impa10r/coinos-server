import config from "$config";
import { db, g } from "$lib/db";
import { lnb } from "$lib/ln";
import { warn } from "$lib/logging";
import { fail, wait } from "$lib/utils";
import {
  CashuMint,
  CashuWallet,
  MintQuoteState,
  PaymentRequest,
  PaymentRequestTransportType,
  getDecodedToken,
  getEncodedToken,
} from "@cashu/cashu-ts";

const { URL } = process.env;
const m = new CashuMint(config.mintUrl);

// The mint issues NUT-02 v1 keyset ids (`01…`, 33 bytes). cashu-ts 2.9.0 only
// derives v0 ids, so CashuWallet.getKeys() rejects every keyset with "Couldn't
// verify keyset ID" and receive()/send() can never run — ecash claims have been
// failing since the July keyset cutover. (4.x derives v1 ids, but not the way
// this nutshell build does, so upgrading wouldn't help either.) config.mintUrl
// is our own mint, so skip the derivation check: CashuMint.getKeys() returns
// the keys unverified, and a wallet constructed with them preloaded uses them
// as-is. Re-fetched periodically so a keyset rotation is picked up.
const KEYS_TTL = 10 * 60 * 1000;
let cached: { w: CashuWallet; keysets: any[]; at: number } | undefined;
const wallet = async () => {
  if (cached && Date.now() - cached.at < KEYS_TTL) return cached;
  const [{ keysets: keys }, { keysets }] = await Promise.all([
    m.getKeys(),
    m.getKeySets(),
  ]);
  const w = new CashuWallet(m, { keys, keysets });
  cached = { w, keysets, at: Date.now() };
  return cached;
};

// 2.9.0 writes v1 keyset ids into V4 tokens in their 8-byte short form, and
// refuses to decode a short id unless it's handed the mint's keysets to expand
// it against — so every token we encode (the house pool included) has to be
// decoded through here rather than with a bare getDecodedToken().
//
// The non-token cases reach cashu-ts as an opaque throw — null yields
// "null is not an object (evaluating 'n.startsWith')", which is what a burst
// of six context-free error lines in production turned out to be. Guard here
// so every entry point gets a message an operator can read.
const decode = async (token) => {
  if (typeof token !== "string" || !token) fail("Invalid token");
  try {
    return getDecodedToken(token, (await wallet()).keysets);
  } catch (e: any) {
    throw new Error(`Invalid token: ${e.message}`);
  }
};

const enc = (proofs) =>
  getEncodedToken({
    mint: config.mintUrl,
    proofs,
  });

// The house wallet is a single encoded token under the `cash` key. g() JSON-
// parses whatever is stored there, and the key has been found holding a bare
// integer — getDecodedToken(number) then threw "n.startsWith is not a function"
// on every claim. Only trust the value when it decodes; otherwise start from
// no proofs and let the next write replace it.
export const pool = async () => {
  const v = await g("cash");
  if (typeof v === "string") {
    try {
      return (await decode(v)).proofs;
    } catch (e: any) {
      warn("cash pool token unreadable, treating as empty:", e.message);
    }
  } else {
    warn("cash pool key is not a token, treating as empty:", typeof v);
  }
  return [];
};

// s() is fire-and-forget; a dropped write here would silently strand the
// proofs we just swapped in, so await the set directly.
const setPool = (proofs) => db.set("cash", JSON.stringify(enc(proofs)));

// Serialize every read-modify-write of the shared `cash` house-wallet token. The
// mint swap sits between reading the current proofs and writing the merged set,
// so two concurrent claim()/mint() calls would each read the same `current` and
// the later write would clobber the earlier — the earlier call's freshly-swapped
// proofs vanish from the stored token while both users stay credited (an
// insolvency leak). This mutex is in-process; if the server ever runs
// multi-process, move to a redis lock (WATCH/MULTI or SET NX).
let cashLock: Promise<void> = Promise.resolve();
const withCashLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = cashLock;
  let release: () => void = () => {};
  cashLock = new Promise((res) => {
    release = res;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
};

// Is this token from someone else's mint?
//
// This used to answer by CONNECTING to the mint named in the token and
// comparing its pubkey to ours. The mint URL comes from inside a token the
// caller supplies, and both /cash routes are unauthenticated, so that made the
// server into an HTTP client pointed wherever an anonymous caller liked —
// 127.0.0.1, the wireguard subnet, bitcoind, the mail relay — with the failure
// text handed back in the 500, which distinguishes an open port from a closed
// one. Production logs showed it being exercised: repeated "Unable to connect.
// Is the computer able to access the url?" is cashu-ts failing to reach a URL
// someone chose.
//
// A URL comparison answers the same question without dialling anything. Every
// token this server issues is encoded with config.mintUrl verbatim (see enc()
// above), so "the URL is ours" and "the mint is ours" are the same statement.
// Routing the old call through safe-fetch was the other option, but that only
// blocks internal targets — it would leave an anonymous outbound fetcher on
// every external address, which is not something this needs at all.
const norm = (u: string) =>
  String(u ?? "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
const ext = (mint) => norm(mint) !== norm(config.mintUrl);

export async function get(id) {
  const token = await g(`cash:${id}`);
  return token;
}

export async function claim(token) {
  const { mint } = await decode(token);

  if (ext(mint)) fail("Unable to receive from other mints");

  const { w } = await wallet();
  return withCashLock(async () => {
    const current = await pool();
    const rcvd = await w.receive(token);
    await setPool([...current, ...rcvd]);
    return rcvd.reduce((a, b) => a + b.amount, 0);
  });
}

export async function mint(amount) {
  const { w } = await wallet();
  return withCashLock(async () => {
    const proofs = await pool();
    const { send, keep } = await w.send(amount, proofs);
    const rcvd = await w.receive(enc(send));
    await setPool(keep);
    return enc(rcvd);
  });
}

export async function check(token) {
  const { mint, proofs } = await decode(token);
  const total = proofs.reduce((a, b) => a + b.amount, 0);

  const external = ext(mint);

  const { w } = await wallet();
  let spent = 0;
  for (const [i, p] of (await w.checkProofsStates(proofs)).entries()) {
    if (p.state === "SPENT") spent += proofs[i].amount;
  }

  return { total, spent, mint, external };
}

export async function init(amount = 100000) {
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const { w } = await wallet();
    const { quote, request } = await w.createMintQuote(amount);
    await lnb.pay(request);

    await wait(async () => {
      const { state } = await w.checkMintQuote(quote);
      return state === MintQuoteState.PAID;
    });

    const proofs = await w.mintProofs(amount, quote);
    await setPool(proofs);
  } catch {}
}

export function request(uuid, amount, memo) {
  const target = `${URL}/api/ecash/${uuid}`;

  const { POST: type } = PaymentRequestTransportType;
  const transport = [{ type, target }];
  const unit = "sat";

  return new PaymentRequest(
    transport,
    uuid,
    amount,
    unit,
    [config.mintUrl],
    memo,
  ).toEncodedRequest();
}
