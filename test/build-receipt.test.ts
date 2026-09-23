import { beforeEach, describe, expect, test } from "bun:test";
import { sendOnchain } from "$lib/payments";

// POST /bitcoin/send accepts a raw `hex` and the hot wallet signs it. Without
// a check on where that hex came from, the only things between an arbitrary
// transaction and the chain were the debit arithmetic and the credit-side
// weSpent guard. build() now leaves a short-lived receipt keyed by txid and
// bound to the account that composed it; caller-supplied hex must match one.

const MINE = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";
const TXID = "deadbeef".repeat(8);

const kv = () => (globalThis as any).__testStore.kvStore;
const lists = () => (globalThis as any).__testStore.listStore;
const store = () => (globalThis as any).__testStore;

const user = { id: MINE, username: "sender", currency: "USD" };

beforeEach(() => {
  for (const k of Object.keys(kv())) delete kv()[k];
  for (const k of Object.keys(lists())) delete lists()[k];
  lists()[`${MINE}:accounts`] = [MINE];
  // decode() asks the node to parse the hex; give it a transaction.
  store().rpcOverride = {
    decodeRawTransaction: async () => ({ txid: TXID, vin: [], vout: [] }),
  };
});

const send = () => sendOnchain({ hex: "00", user, rate: 1, aid: MINE });

describe("the hot wallet only signs a transaction it composed", () => {
  test("hex with no build receipt is refused", async () => {
    await expect(send()).rejects.toThrow("unrecognized tx");
  });

  test("a receipt belonging to another account is refused", async () => {
    kv()[`build:${TXID}`] = OTHER;
    await expect(send()).rejects.toThrow("unrecognized tx");
  });

  test("the account's own receipt gets past the check", async () => {
    kv()[`build:${TXID}`] = MINE;
    // It proceeds into locking/signing, which the stubbed node does not
    // complete; the assertion is only that it was not refused here.
    await expect(send()).rejects.not.toThrow("unrecognized tx");
  });
});
