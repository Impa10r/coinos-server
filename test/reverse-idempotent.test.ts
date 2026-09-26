import { beforeEach, describe, expect, test } from "bun:test";
import { reverse } from "$lib/payments";
import { tbReverse } from "$lib/tb";

// reverse() refunds a failed lightning send. tbReverse uses non-deterministic
// TigerBeetle transfer ids, so calling it twice for one payment credits the
// full amount back twice; and reverse() must never run on a payment that
// finalize() already settled (finalize keeps the record and sets `ref`).
const kv = () => (globalThis as any).__testStore.kvStore;
const spy = tbReverse as any;

const seed = (p: any) => {
  kv()[`payment:${p.id}`] = JSON.stringify(p);
};

describe("reverse is exactly-once and refuses settled payments", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
    spy.mockClear();
  });

  test("two concurrent reverses of one payment refund exactly once", async () => {
    const p = { id: "pay-conc", uid: "u1", hash: "lnbcRACE", amount: -5000, fee: 10, ourfee: 0 };
    seed(p);
    await Promise.all([reverse(p), reverse(p).catch(() => {})]);
    expect(spy.mock.calls.length).toBe(1);
    expect(kv()["payment:pay-conc"]).toBeUndefined(); // record cleaned up once
  });

  test("a payment finalize() already settled is never reversed", async () => {
    // finalize keeps the record and sets ref (the preimage) + confirmed.
    const p = { id: "pay-done", uid: "u1", hash: "lnbcDONE", amount: -5000, fee: 10, ourfee: 0 };
    seed({ ...p, ref: "a".repeat(64), confirmed: true });
    await reverse(p).catch(() => {});
    expect(spy.mock.calls.length).toBe(0); // never refunded a settled payment
    expect(kv()["payment:pay-done"]).toBeDefined(); // record left intact
  });

  test("a genuine single reverse still refunds once", async () => {
    const p = { id: "pay-one", uid: "u1", hash: "lnbcONE", amount: -3000, fee: 5, ourfee: 0 };
    seed(p);
    await reverse(p);
    expect(spy.mock.calls.length).toBe(1);
  });
});
