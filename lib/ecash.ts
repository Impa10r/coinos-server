import config from "$config";
import { g, s } from "$lib/db";
import { lnb } from "$lib/ln";
import { fail, wait } from "$lib/utils";
import {
  CashuMint,
  CashuWallet,
  MintQuoteState,
  PaymentRequest,
  PaymentRequestTransportType,
  getDecodedToken,
  getEncodedToken,
  getEncodedTokenV4,
} from "@cashu/cashu-ts";

const { URL } = process.env;
const m = new CashuMint(config.mintUrl);
const w = new CashuWallet(m);

const enc = (proofs) =>
  getEncodedToken({
    mint: config.mintUrl,
    proofs,
  });

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

// getDecodedToken() throws opaquely on anything that isn't a token string: null
// gives "null is not an object (evaluating 'n.startsWith')", which is what a
// burst of six context-free error lines turned out to be. Fail with something
// an operator can read, and do it in one place so every entry point gets it.
const decode = (token) => {
  if (typeof token !== "string" || !token) fail("Invalid token");
  try {
    return getDecodedToken(token);
  } catch (e: any) {
    throw new Error(`Invalid token: ${e.message}`);
  }
};

export async function get(id) {
  const token = await g(`cash:${id}`);
  return token;
}

// Proofs currently held, or none. The `cash` key is simply unset until this
// instance first holds ecash, so an unguarded read made the FIRST claim or
// mint fail (see decode() above) rather than starting from an empty balance.
const currentProofs = async () => {
  const token = await g("cash");
  if (!token) return [];
  return decode(token).proofs ?? [];
};

export async function claim(token) {
  const { mint } = decode(token);

  if (ext(mint)) fail("Unable to receive from other mints");

  return withCashLock(async () => {
    const current = await currentProofs();
    const rcvd = await w.receive(token);
    await s("cash", enc([...current, ...rcvd]));
    return rcvd.reduce((a, b) => a + b.amount, 0);
  });
}

export async function mint(amount) {
  const { keysets } = await m.getKeySets();
  const w = new CashuWallet(m, { keysets });
  return withCashLock(async () => {
    const proofs = await currentProofs();
    const { send, keep } = await w.send(amount, proofs);
    const rcvd = await w.receive(enc(send));
    const change = enc(keep);
    await s("cash", change);
    return enc(rcvd);
  });
}

export async function check(token) {
  const { mint, proofs } = decode(token);
  const total = proofs.reduce((a, b) => a + b.amount, 0);

  const external = ext(mint);

  let spent = 0;
  for (const [i, p] of (await w.checkProofsStates(proofs)).entries()) {
    if (p.state === "SPENT") spent += proofs[i].amount;
  }

  return { total, spent, mint, external };
}

export async function init(amount = 100000) {
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const { quote, request } = await w.createMintQuote(amount);
    await lnb.pay(request);

    await wait(async () => {
      const { state } = await w.checkMintQuote(quote);
      return state === MintQuoteState.PAID;
    });

    const proofs = await w.mintProofs(amount, quote);

    const cash = getEncodedTokenV4({
      mint: config.mintUrl,
      proofs,
    });

    await s("cash", cash);
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
