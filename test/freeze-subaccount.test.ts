import { beforeEach, describe, expect, test } from "bun:test";

// A blacklisted account's balance is meant to be unreachable — evictUser() in
// lib/auth.ts sets `blacklist` for exactly that. tbDebit enforces it as
// `balance(aid) - frozen < total`, so the frozen figure has to come from the
// same account the debit is drawn from. It came from `uid`, the user's main
// account, so a sub-account holding more than the main one stayed spendable.

const MAIN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Per-account balances, so a frozen figure taken from the wrong one is visible.
const balances: Record<string, number> = { [MAIN]: 0, [SUB]: 1_000_000 };

import { debit } from "$lib/payments";
import { tbDebit } from "$lib/tb";

const kv = () => (globalThis as any).__testStore.kvStore;
const sets = () => (globalThis as any).__testStore.setStore;

const user = { id: MAIN, username: "frozen", currency: "USD" };

const frozenArgOf = (call: any[]) => call[7]; // tbDebit(aid, uid, type, amount, tip, fee, ourfee, frozen, msg)

describe("a frozen account is frozen in every account it owns", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
    for (const k of Object.keys(sets())) delete sets()[k];
    kv().rates = JSON.stringify({ USD: 100_000 });
    // debit() reserves against the per-asset hot-wallet limit; unset reads as
    // 0 and blocks every external send before it reaches tbDebit.
    kv()["bitcoin:limit"] = "100000000";
    (tbDebit as any).mockClear();
    (globalThis as any).__testStore.balances = balances;
    sets().blacklist = new Set([MAIN]);
  });

  test("spending from a sub-account freezes the SUB-account's balance", async () => {
    await debit({
      aid: SUB,
      hash: "h1",
      amount: 1000,
      user,
      type: "bitcoin" as any,
    }).catch(() => {});

    expect(tbDebit).toHaveBeenCalled();
    // The whole sub-account balance, so balance - frozen leaves nothing.
    expect(frozenArgOf((tbDebit as any).mock.calls[0] as any)).toBe(balances[SUB]);
  });

  test("spending from the main account is unchanged", async () => {
    balances[MAIN] = 50_000;
    await debit({
      aid: MAIN,
      hash: "h2",
      amount: 1000,
      user,
      type: "bitcoin" as any,
    }).catch(() => {});

    expect(frozenArgOf((tbDebit as any).mock.calls[0] as any)).toBe(50_000);
    balances[MAIN] = 0;
  });

  test("an account that is not blacklisted freezes nothing", async () => {
    sets().blacklist = new Set();
    await debit({
      aid: SUB,
      hash: "h3",
      amount: 1000,
      user,
      type: "bitcoin" as any,
    }).catch(() => {});

    expect(frozenArgOf((tbDebit as any).mock.calls[0] as any)).toBe(0);
  });
});
