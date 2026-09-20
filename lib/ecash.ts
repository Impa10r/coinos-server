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
    if (/short keyset id/i.test(e.message))
      fail("Unable to receive from other mints");
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
// Three answers have been tried here. Connecting to the mint named in the
// token and comparing pubkeys made every /cash entry point an unauthenticated
// SSRF — the URL comes from the caller, so an anonymous request could point
// the server at 127.0.0.1, the wireguard subnet, bitcoind or the mail relay,
// with the failure text returned in the 500 to tell open ports from closed.
// Comparing that URL to config.mintUrl as a string stopped the dialling but
// broke valid claims: the mint URL is a label the SENDING wallet writes in,
// and tokens of ours come back carrying stray ports and paths, so a string
// match rejects our own money.
//
// Keyset ids are derived from the mint's public keys, so they identify the
// issuer cryptographically. A token whose proofs are all on our keysets is
// ours whatever URL it names, and the URL is never read. A miss refreshes the
// cached list once, in case a keyset was rotated in since it was fetched.
const ext = async (proofs) => {
  const ours = (ks) => {
    const ids = new Set(ks.map((k) => k.id));
    return proofs.every((p) => ids.has(p.id));
  };
  if (ours((await wallet()).keysets)) return false;
  cached = undefined;
  return !ours((await wallet()).keysets);
};

export async function get(id) {
  const token = await g(`cash:${id}`);
  return token;
}

export async function claim(token) {
  const { proofs: incoming } = await decode(token);
  if (!incoming?.length) fail("Token has no proofs");

  if (await ext(incoming)) fail("Unable to receive from other mints");

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

  const external = await ext(proofs);

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
