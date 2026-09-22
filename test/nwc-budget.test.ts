import { beforeEach, describe, expect, test } from "bun:test";
import { checkBudget } from "$lib/nwc";

// An NWC connection's max_amount is the only thing standing between a
// third-party app holding the secret and the user's whole balance. A BLANK
// budget is deliberately unlimited; an explicit 0 must not be, and those two
// used to collapse into the same branch.

const lists = () => (globalThis as any).__testStore.listStore;
const PUBKEY = "a".repeat(64);
const app = (max_amount: any, budget_renewal = "daily") => ({
  max_amount,
  budget_renewal,
  pubkey: PUBKEY,
  created: Date.now(),
});

describe("NWC spending budget", () => {
  beforeEach(() => {
    for (const k of Object.keys(lists())) delete lists()[k];
  });

  test("a budget of 0 permits nothing", async () => {
    const { budgetError, remaining } = await checkBudget(app(0), 1000);
    expect(budgetError).toBeTruthy();
    expect(remaining).toBe(0);
  });

  test("a budget of \"0\" permits nothing either", async () => {
    // updateApp stores whatever the client sent; it validates the number but
    // does not coerce the type.
    const { budgetError } = await checkBudget(app("0"), 1);
    expect(budgetError).toBeTruthy();
  });

  test("a blank budget stays deliberately unlimited", async () => {
    for (const blank of [undefined, null, ""]) {
      const { budgetError, remaining } = await checkBudget(app(blank), 10_000_000);
      expect(budgetError).toBeNull();
      // undefined remaining is what assertWithinSpendLimit reads as "no ceiling"
      expect(remaining).toBeUndefined();
    }
  });

  test("a positive budget still allows a spend under it", async () => {
    const { budgetError, remaining } = await checkBudget(app(5000), 1000);
    expect(budgetError).toBeNull();
    expect(remaining).toBe(5000);
  });

  test("a positive budget still refuses a spend over it", async () => {
    const { budgetError } = await checkBudget(app(5000), 5001);
    expect(budgetError).toBeTruthy();
  });

  test("a connection with no created timestamp is refused", async () => {
    const { budgetError } = await checkBudget({ ...app(5000), created: undefined }, 1);
    expect(budgetError).toBeTruthy();
  });

  test("a negative budget is refused rather than treated as a ceiling", async () => {
    const { budgetError } = await checkBudget(app(-1), 1);
    expect(budgetError).toBeTruthy();
  });
});
