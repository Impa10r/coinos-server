// Cumulative withdrawal circuit breaker.
//
// The other outflow controls all cap a SINGLE payment: `limit` per user,
// `${type}:limit` per asset (refreshed from the node balance every 10s), NWC's
// per-app budget. None of them notice a steady drain made of individually
// unremarkable sends — the hot wallet just empties, and the first signal is
// someone reading logs. This is the control that trips on the total.
//
// Modelled on meltguard, which already does exactly this for the mint's melts:
// a rolling total, a cap, a STICKY trip, and state in a plain file rather than
// the db so a db-write compromise can neither reset the counter nor clear the
// trip.
//
// Enforcement deliberately reuses the withdrawal lockfiles rather than adding
// a parallel mechanism: tripping writes /locks/ALL.locked, which
// isWithdrawLocked() in lib/payments.ts already checks before every external
// send, ahead of every whitelist exemption. So the trip halts withdrawals for
// everyone including whitelisted accounts, and clearing it takes the same
// deliberate act as clearing any other lock (`rm`), not a db write.
//
// LIMIT OF THIS DEFENCE: the counter file has to be writable by the app, so
// app-level code execution can tamper with it — unlike the lock files
// themselves, which only need to be readable. It defends against a compromised
// credential or a db-write vector draining the wallet, not against RCE.
//
// Config (env):
//   WITHDRAW_CUM_MAX_SAT    cap over the window; unset or 0 disables the whole
//                           mechanism, so it is opt-in and cannot surprise an
//                           operator who hasn't chosen a number
//   WITHDRAW_WINDOW_HOURS   rolling window, default 24
//   GUARD_DIR               where state lives, default /locks

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { err, l, warn } from "$lib/logging";
import { alert } from "$lib/mail";

// Read at call time, not module load. As module-level consts these were fixed
// by whichever import pulled this file in first, which made behaviour depend
// on module load order — invisible in production and, less kindly, a test that
// passed alone and failed in a suite.
const DIR = () => process.env.GUARD_DIR || "/locks";
const STATE = () => `${DIR()}/withdraw-window.json`;
const LOCK = () => `${DIR()}/ALL.locked`;

const CAP = () => Number(process.env.WITHDRAW_CUM_MAX_SAT || 0);
const WINDOW_MS = () => (Number(process.env.WITHDRAW_WINDOW_HOURS) || 24) * 3600_000;
const WINDOW_H = () => WINDOW_MS() / 3600_000;

export const breakerEnabled = () => CAP() > 0;

type Entry = { t: number; amount: number; type: string };

const read = (): Entry[] => {
  try {
    if (!existsSync(STATE())) return [];
    const parsed = JSON.parse(readFileSync(STATE(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: any) {
    // A corrupt state file must not be read as "nothing withdrawn yet" — that
    // would silently reset the counter, which is the one thing this mechanism
    // exists to prevent. Surface it and let the caller fail closed.
    err("withdraw breaker: unreadable state", e.message);
    throw e;
  }
};

const write = (entries: Entry[]) => {
  if (!existsSync(DIR())) mkdirSync(DIR(), { recursive: true });
  writeFileSync(STATE(), JSON.stringify(entries));
};

const prune = (entries: Entry[], now: number) => entries.filter((e) => now - e.t < WINDOW_MS());

const sum = (entries: Entry[]) => entries.reduce((t, e) => t + (Number(e.amount) || 0), 0);

// Current rolling total, for reporting. Never throws.
export const withdrawWindowTotal = (): number => {
  try {
    return sum(prune(read(), Date.now()));
  } catch {
    return 0;
  }
};

const trip = async (total: number, attempted: number, type: string, username?: string) => {
  // Only shout once per trip. The lock file IS the tripped state, so its
  // absence is what distinguishes a new breach from every subsequent blocked
  // send while an operator is still investigating.
  const alreadyTripped = existsSync(LOCK());
  try {
    if (!existsSync(DIR())) mkdirSync(DIR(), { recursive: true });
    writeFileSync(LOCK(), `withdraw breaker: ${total} sat in ${WINDOW_H()}h\n`);
  } catch (e: any) {
    err("withdraw breaker: FAILED TO WRITE LOCK", e.message);
  }

  if (alreadyTripped) return;

  err(
    `SECURITY: withdraw breaker TRIPPED — ${total} sat withdrawn in ${WINDOW_H()}h exceeds cap ${CAP()}`,
    `blocked ${attempted} sat ${type} send by ${username ?? "unknown"}`,
  );

  void alert(
    "coinos: withdrawal circuit breaker tripped",
    [
      `Cumulative external withdrawals reached ${total} sat over the last ${WINDOW_H()}h,`,
      `which exceeds the configured cap of ${CAP()} sat.`,
      "",
      `The send that crossed it was blocked: ${attempted} sat (${type}) by ${username ?? "unknown"}.`,
      "",
      "ALL external withdrawals are now halted — /locks/ALL.locked has been written,",
      "which blocks every external send including whitelisted accounts.",
      "",
      "To resume after review:",
      `  rm ${LOCK()}`,
      `  rm ${STATE()}   # only if you intend to reset the rolling total too`,
      "",
      "Internal transfers and receives are unaffected.",
    ].join("\n"),
  );
};

// Called before the ledger debit. Throws to block the send that would cross
// the cap, so the cap is a ceiling rather than something noticed afterwards.
export const assertWithdrawBreaker = async ({
  amount,
  type,
  username,
}: { amount: number; type: string; username?: string }) => {
  if (!breakerEnabled()) return;

  let entries: Entry[];
  try {
    entries = prune(read(), Date.now());
  } catch {
    // read() already logged. Fail CLOSED: if the counter can't be trusted,
    // letting withdrawals continue unmetered is the worse outcome.
    throw new Error("External withdrawals temporarily disabled");
  }

  const total = sum(entries);
  const amt = Number(amount) || 0;
  if (total + amt > CAP()) {
    await trip(total + amt, amt, type, username);
    throw new Error("External withdrawals temporarily disabled");
  }
};

// Called after the debit succeeds, so attempts that fail for other reasons
// (insufficient funds, a rejected route) don't consume the allowance and
// can't be used to trip the breaker as a denial of service.
export const recordWithdrawal = ({ amount, type }: { amount: number; type: string }) => {
  if (!breakerEnabled()) return;
  try {
    const now = Date.now();
    const entries = prune(read(), now);
    entries.push({ t: now, amount: Number(amount) || 0, type });
    write(entries);

    const total = sum(entries);
    // Early warning at 80%, so a drain in progress is visible before the
    // breaker halts everything.
    if (total > CAP() * 0.8)
      warn("withdraw breaker: approaching cap", total, "of", CAP(), `over ${WINDOW_H()}h`);
    else l("withdraw window", total, "of", CAP());
  } catch (e: any) {
    // Never let bookkeeping fail a payment that has already been debited.
    err("withdraw breaker: failed to record", e.message);
  }
};
