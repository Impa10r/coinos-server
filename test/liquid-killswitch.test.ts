import { beforeEach, describe, expect, test } from "bun:test";
import { warn } from "$lib/logging";
import payments from "$routes/payments";

// Hiding Liquid in the UI (coinos-ui comments the option out of
// InvoiceTypes.svelte) removes the entry point and nothing else. The server
// still issued an address to anyone asking for type "liquid", and — the half
// that matters more — still credited whatever arrived at an address already
// handed out. `liquid:deposits:disabled` is what makes "Liquid deposits are
// off" a fact rather than a UI state.
//
// This covers the credit half, through confirm(). The generation half, in
// lib/invoices.ts's generate(), cannot be reached from here: preload replaces
// $lib/invoices wholesale with a stub, so a test importing it exercises the
// stub rather than the guard.

const kv = () => (globalThis as any).__testStore.kvStore;
const store = () => (globalThis as any).__testStore;

const liquidDeposit = {
  confirmations: 1,
  details: [{ address: "lq1qdeposit", amount: 0.001, asset: "test-asset", category: "receive", vout: 0 }],
};

const ctx = (body: any) =>
  ({
    req: { json: async () => body },
    get: () => undefined,
    json: (payload: any, status?: number) => ({ payload, status: status ?? 200 }),
  }) as any;

const call = () =>
  payments.confirm(ctx({ txid: "tx1", type: "liquid", secret: "test", wallet: "test" }));

const blocked = () =>
  (warn as any).mock.calls.some((c: any[]) => c[0] === "liquid deposit blocked (disabled)");

describe("liquid:deposits:disabled stops deposits being credited", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
    store().rpcOverride = { getTransaction: async () => liquidDeposit };
    (warn as any).mockClear();
  });

  test("an arriving deposit is refused while the switch is set", async () => {
    kv()["liquid:deposits:disabled"] = JSON.stringify("1");
    await call();
    expect(blocked()).toBe(true);
  });

  test("nothing is blocked when the switch is clear", async () => {
    await call();
    expect(blocked()).toBe(false);
  });

  test("bitcoin deposits are unaffected by the liquid switch", async () => {
    kv()["liquid:deposits:disabled"] = JSON.stringify("1");
    await payments.confirm(
      ctx({ txid: "tx2", type: "bitcoin", secret: "test", wallet: "test" }),
    );
    expect(blocked()).toBe(false);
  });
});
