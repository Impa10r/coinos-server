import { beforeEach, describe, expect, test } from "bun:test";
import { finalize } from "$lib/payments";
import { tbRefund } from "$lib/tb";

// finalize() refunds the unused fee reserve via tbRefund, which (like tbReverse)
// uses non-deterministic TigerBeetle transfer ids. The `ref` check that used to
// gate it was check-then-act, so two concurrent finalizes could refund twice.
const kv = () => (globalThis as any).__testStore.kvStore;
const spy = tbRefund as any;
const PREIMAGE = "a".repeat(64);

// A completed xpay result: preimage present, amount_sent below the reserve so
// there is a positive fee delta to refund.
const r = { payment_preimage: PREIMAGE, amount_sent_msat: 100_500 };

const seed = (p: any) => {
  kv()[`payment:${p.id}`] = JSON.stringify(p);
};

describe("finalize refunds the fee reserve exactly once", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
    spy.mockClear();
  });

  test("two concurrent finalizes refund the reserve once", async () => {
    // amount 100 sat, fee reserve 10 sat; actual ~0 => a real positive refund.
    const p = { id: "fin-conc", uid: "u1", hash: "lnbcFIN", amount: 100, fee: 10, ourfee: 0 };
    seed(p);
    await Promise.all([
      finalize(r, { ...p }).catch(() => {}),
      finalize(r, { ...p }).catch(() => {}),
    ]);
    expect(spy.mock.calls.length).toBe(1);
  });

  test("a single finalize still refunds once", async () => {
    const p = { id: "fin-one", uid: "u1", hash: "lnbcONE", amount: 100, fee: 10, ourfee: 0 };
    seed(p);
    await finalize(r, { ...p }).catch(() => {});
    expect(spy.mock.calls.length).toBe(1);
  });
});
