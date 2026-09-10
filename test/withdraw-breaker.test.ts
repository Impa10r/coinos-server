import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The module reads its config from env at import time, so set it before the
// dynamic import below.
const DIR = mkdtempSync(join(tmpdir(), "breaker-"));
process.env.GUARD_DIR = DIR;
process.env.WITHDRAW_CUM_MAX_SAT = "10000";
process.env.WITHDRAW_WINDOW_HOURS = "24";

const { assertWithdrawBreaker, recordWithdrawal, withdrawWindowTotal, breakerEnabled } =
  await import("$lib/withdraw-breaker");

const STATE = join(DIR, "withdraw-window.json");
const LOCK = join(DIR, "ALL.locked");

const send = (amount: number) => ({ amount, type: "lightning", username: "someone" });

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(STATE, { force: true });
  rmSync(LOCK, { force: true });
});

describe("withdraw breaker", () => {
  it("is enabled when a cap is configured", () => {
    expect(breakerEnabled()).toBe(true);
  });

  it("allows sends below the cap and accumulates them", async () => {
    await assertWithdrawBreaker(send(3000));
    recordWithdrawal(send(3000));
    await assertWithdrawBreaker(send(4000));
    recordWithdrawal(send(4000));

    expect(withdrawWindowTotal()).toBe(7000);
  });

  it("blocks the send that would cross the cap, and does not count it", async () => {
    recordWithdrawal(send(9000));

    expect(assertWithdrawBreaker(send(2000))).rejects.toThrow(
      "External withdrawals temporarily disabled",
    );
    // The blocked amount must not be recorded — otherwise failed attempts
    // would burn the allowance.
    expect(withdrawWindowTotal()).toBe(9000);
  });

  it("writes ALL.locked when it trips, so isWithdrawLocked() enforces it", async () => {
    recordWithdrawal(send(9500));
    expect(existsSync(LOCK)).toBe(false);

    await assertWithdrawBreaker(send(1000)).catch(() => {});

    expect(existsSync(LOCK)).toBe(true);
    expect(readFileSync(LOCK, "utf8")).toContain("withdraw breaker");
  });

  it("lets a send through once older entries fall outside the window", async () => {
    // An entry from 25h ago, with the window at 24h.
    const stale = Date.now() - 25 * 3600_000;
    writeFileSync(STATE, JSON.stringify([{ t: stale, amount: 9999, type: "lightning" }]));

    expect(withdrawWindowTotal()).toBe(0);
    await assertWithdrawBreaker(send(5000)); // would exceed if the stale entry still counted
  });

  it("still counts entries inside the window", async () => {
    const recent = Date.now() - 1 * 3600_000;
    writeFileSync(STATE, JSON.stringify([{ t: recent, amount: 9999, type: "lightning" }]));

    expect(withdrawWindowTotal()).toBe(9999);
    expect(assertWithdrawBreaker(send(5000))).rejects.toThrow(
      "External withdrawals temporarily disabled",
    );
  });

  it("fails CLOSED on a corrupt state file rather than resetting the count", async () => {
    writeFileSync(STATE, "{ not json");

    expect(assertWithdrawBreaker(send(1))).rejects.toThrow(
      "External withdrawals temporarily disabled",
    );
  });

  it("never throws out of recordWithdrawal, even with the state file unreadable", () => {
    writeFileSync(STATE, "{ not json");
    // The debit has already happened by this point; bookkeeping must not
    // surface as a payment failure.
    expect(() => recordWithdrawal(send(1000))).not.toThrow();
  });
});
