import { beforeEach, describe, expect, test } from "bun:test";
import { requireAccount } from "$lib/payments";

// POST /bitcoin/send and POST /bitcoin/fee both do `{ ...body, user }`, so
// `aid` is whatever the caller put in the request body. Nothing downstream
// checked it: debit() reads account:${aid} only for its currency, and tbDebit
// debits balanceId(aid) — so the body chose whose balance to take. A victim's
// aid isn't secret either; GET /invoice/:id is unauthenticated and returns it.

const lists = () => (globalThis as any).__testStore.listStore;

const ATTACKER = "11111111-1111-1111-1111-111111111111";
const VICTIM_ACCOUNT = "22222222-2222-2222-2222-222222222222";
const OWN_SUBACCOUNT = "33333333-3333-3333-3333-333333333333";

const attacker = { id: ATTACKER, username: "attacker" };

describe("a caller may only act on an account it owns", () => {
  beforeEach(() => {
    for (const k of Object.keys(lists())) delete lists()[k];
    // register.ts seeds the user's own id into their list, then sub-accounts.
    lists()[`${ATTACKER}:accounts`] = [ATTACKER, OWN_SUBACCOUNT];
  });

  test("another user's account is refused", async () => {
    await expect(requireAccount(attacker, VICTIM_ACCOUNT)).rejects.toThrow("Unauthorized");
  });

  test("the caller's own id passes", async () => {
    expect(await requireAccount(attacker, ATTACKER)).toBeUndefined();
  });

  test("a sub-account the caller owns passes", async () => {
    expect(await requireAccount(attacker, OWN_SUBACCOUNT)).toBeUndefined();
  });

  test("an omitted aid passes — callers that send none act as themselves", async () => {
    expect(await requireAccount(attacker, undefined)).toBeUndefined();
  });

  test("the caller's own id passes even if their list predates the seeding", async () => {
    // Older accounts may not have their own id in the list; spending from
    // yourself must not depend on that backfill.
    lists()[`${ATTACKER}:accounts`] = [OWN_SUBACCOUNT];
    expect(await requireAccount(attacker, ATTACKER)).toBeUndefined();
  });

  test("an empty membership list refuses everything but self", async () => {
    lists()[`${ATTACKER}:accounts`] = [];
    await expect(requireAccount(attacker, OWN_SUBACCOUNT)).rejects.toThrow("Unauthorized");
    expect(await requireAccount(attacker, ATTACKER)).toBeUndefined();
  });
});
