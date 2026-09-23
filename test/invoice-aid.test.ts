import { beforeEach, describe, expect, test } from "bun:test";
import { generate } from "$lib/invoices";
import { PaymentType } from "$lib/types";

// POST /invoice takes `optional` auth — anyone may raise a payment request for
// a merchant — and `aid` arrives inside the caller's invoice object. Unchecked,
// that let an unauthenticated caller name ANY account: for a non-custodial one
// generate() derives the next address from that account's xpub, returns it, and
// writes the incremented nextIndex back. A stranger enumerating someone's
// wallet addresses, one request at a time.

const ALICE = "aaaa1111-1111-1111-1111-111111111111";
const VICTIM = "bbbb2222-2222-2222-2222-222222222222";
const VICTIM_ACCT = "cccc3333-3333-3333-3333-333333333333";

const kv = () => (globalThis as any).__testStore.kvStore;

beforeEach(() => {
  // Exercise the real generate(), not preload's echo stub — the stub spreads
  // `...invoice` back, so an assertion on `aid` would pass without the
  // ownership check ever running.
  (globalThis as any).__testStore.realGenerate = true;
  for (const k of Object.keys(kv())) delete kv()[k];
  kv().rates = JSON.stringify({ USD: 100_000 });

  kv()[`user:${ALICE}`] = JSON.stringify({ id: ALICE, username: "alice", currency: "USD" });
  kv()["user:alice"] = JSON.stringify(ALICE);
  kv()[`account:${ALICE}`] = JSON.stringify({ id: ALICE, uid: ALICE, currency: "USD" });

  // The victim's non-custodial account: the one with an xpub to derive from.
  kv()[`account:${VICTIM_ACCT}`] = JSON.stringify({
    id: VICTIM_ACCT,
    uid: VICTIM,
    currency: "USD",
    pubkey: "tpubDCBWBScQPGv4Xk3JSbhw6wYYpayMjb2eAYyArpbSqQTbLDpphHGAetB6VQgVeftLML8vDSUEWcC2xDi3qJJ3YCDChJDvqVzpgoYSuT52MhJ",
    fingerprint: "00000000",
    nextIndex: 7,
  });
});

const raise = (aid?: string) =>
  generate({
    invoice: { aid, amount: 1000, type: PaymentType.bitcoin },
    user: { username: "alice" },
  });

describe("generate() only honours an aid the named user owns", () => {
  test("a stranger's account is ignored, not used", async () => {
    const inv = await raise(VICTIM_ACCT);
    expect(inv.aid).toBe(ALICE);
    expect(inv.aid).not.toBe(VICTIM_ACCT);
  });

  test("and the stranger's derivation counter is left alone", async () => {
    await raise(VICTIM_ACCT);
    const acct = JSON.parse(kv()[`account:${VICTIM_ACCT}`]);
    expect(acct.nextIndex).toBe(7);
  });

  test("the user's own account is still honoured", async () => {
    const inv = await raise(ALICE);
    expect(inv.aid).toBe(ALICE);
  });

  test("no aid falls back to the user's own account", async () => {
    const inv = await raise(undefined);
    expect(inv.aid).toBe(ALICE);
  });
});
