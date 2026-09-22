import { beforeEach, describe, expect, test } from "bun:test";
import { assertFundWithdrawable } from "$lib/payments";

// routes/lnurl.ts's lnurlw callback pays sats out over lightning without going
// through debit(), where every stop control lives. These assert that the guard
// standing in for debit() on that path actually refuses.
//
// The case that matters most is a fund disabled because its founder was
// evicted (lib/auth.ts writes fund:<id>:disabled on eviction): take() honoured
// that flag, the lnurlw path did not, so the fund stayed drainable by anyone
// holding its link.

const kv = () => (globalThis as any).__testStore.kvStore;
const FUND = "feb630df-943d-4454-b83b-077adcba1c30";

describe("fund withdrawals outside debit() still answer to the kill switches", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
  });

  test("an undisabled fund is allowed through", async () => {
    expect(await assertFundWithdrawable(FUND, 1000)).toBeUndefined();
  });

  test("a fund disabled by its founder's eviction is refused", async () => {
    kv()[`fund:${FUND}:disabled`] = JSON.stringify("1");
    await expect(assertFundWithdrawable(FUND, 1000)).rejects.toThrow(
      "This fund has been disabled",
    );
  });

  test("the global fund kill switch is refused", async () => {
    kv()["fund:disabled"] = JSON.stringify("1");
    await expect(assertFundWithdrawable(FUND, 1000)).rejects.toThrow(
      "Fund transfers temporarily disabled",
    );
  });

  test("a global freeze is refused", async () => {
    kv().freeze = JSON.stringify("1");
    await expect(assertFundWithdrawable(FUND, 1000)).rejects.toThrow(
      "Withdrawals temporarily disabled",
    );
  });

  test("a hardfreeze is refused", async () => {
    kv().hardfreeze = JSON.stringify("1");
    await expect(assertFundWithdrawable(FUND, 1000)).rejects.toThrow(
      "Withdrawals temporarily disabled",
    );
  });

  test("another fund is unaffected by a per-fund disable", async () => {
    kv()[`fund:${FUND}:disabled`] = JSON.stringify("1");
    expect(await assertFundWithdrawable("some-other-fund", 1000)).toBeUndefined();
  });
});
