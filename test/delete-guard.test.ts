import { beforeEach, describe, expect, test } from "bun:test";
import users from "$routes/users";

// deleteSelf refuses to destroy an account holding real funds. The guard summed
// redis `balance:`/`pending:` keys, which have not been written since balances
// moved to TigerBeetle (lib/migrate.ts copied them across once). For any
// account created since, those keys are absent, the total came out 0, and the
// guard waved the deletion through.
//
// test/security.test.ts's fnd-006 re-implements the summation inside the test
// and sets the redis keys itself, so it passed throughout. This one calls the
// handler and puts the balance where the ledger keeps it.

const ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const SUB = "99999999-9999-9999-9999-999999999999";
const USERNAME = "leaver";

const kv = () => (globalThis as any).__testStore.kvStore;
const lists = () => (globalThis as any).__testStore.listStore;

const ctx = (body: any) =>
  ({
    req: { json: async () => body },
    get: () => ({ id: ID, username: USERNAME, pubkey: "pk" }),
    json: (payload: any, status?: number) => ({ payload, status: status ?? 200 }),
  }) as any;

describe("deleteSelf reads the ledger, not dead redis keys", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
    for (const k of Object.keys(lists())) delete lists()[k];
    lists()[`${ID}:accounts`] = [ID, SUB];
    // Deliberately NOT setting redis balance:/pending: keys — nothing writes
    // them any more, so a live account looks like this.
    (globalThis as any).__testStore.balances = { [ID]: 0, [SUB]: 5_000_000 };
  });

  test("refuses when a sub-account holds funds in the ledger", async () => {
    const res = await users.deleteSelf(ctx({ confirm: USERNAME }));
    expect(res.payload).toBe("Withdraw your balance before deleting your account");
  });

  test("still allows deletion through dust", async () => {
    (globalThis as any).__testStore.balances = { [ID]: 500, [SUB]: 0 };
    const res = await users.deleteSelf(ctx({ confirm: USERNAME }));
    expect(res.payload).not.toBe("Withdraw your balance before deleting your account");
  });

  test("still requires the username confirmation", async () => {
    const res = await users.deleteSelf(ctx({ confirm: "wrong" }));
    expect(res.payload).toBe("Type your username to confirm account deletion");
  });
});

describe("deleteAccount will not orphan a funded sub-account", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
    for (const k of Object.keys(lists())) delete lists()[k];
    lists()[`${ID}:accounts`] = [ID, SUB];
    kv()[`account:${SUB}`] = JSON.stringify({ type: "bitcoin", name: "savings" });
  });

  test("refuses while the sub-account holds funds", async () => {
    (globalThis as any).__testStore.balances = { [SUB]: 5_000_000 };
    const res = await users.deleteAccount(ctx({ id: SUB }));
    expect(res.payload).toBe("Withdraw this account's balance before deleting it");
  });

  test("allows deletion of an empty sub-account", async () => {
    (globalThis as any).__testStore.balances = { [SUB]: 0 };
    const res = await users.deleteAccount(ctx({ id: SUB }));
    expect(res.payload).toEqual({ ok: true });
  });
});
