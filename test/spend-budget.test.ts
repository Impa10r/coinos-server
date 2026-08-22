import { describe, expect, test } from "bun:test";
import {
  assertWithinSpendLimit,
  debitTotal,
} from "$lib/spend-budget";

describe("NWC budget covers the final captured tip and fees", () => {
  test("a small invoice with an oversized mutable tip is rejected", () => {
    expect(
      debitTotal({ amount: 19, tip: 1_701_450, fee: 0, ourfee: 0 }),
    ).toBe(1_701_469);
    expect(() =>
      assertWithinSpendLimit({
        amount: 19,
        tip: 1_701_450,
        maxTotal: 10_000,
      }),
    ).toThrow("Budget exceeded");
  });

  test("the exact remaining allowance succeeds", () => {
    expect(
      assertWithinSpendLimit({
        amount: 9_000,
        tip: 500,
        fee: 400,
        ourfee: 100,
        maxTotal: 10_000,
      }),
    ).toBe(10_000);
  });

  test("an unlimited first-party debit remains unaffected", () => {
    expect(
      assertWithinSpendLimit({ amount: 19, tip: 1_701_450 }),
    ).toBe(1_701_469);
  });
});
