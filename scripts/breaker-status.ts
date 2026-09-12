// Show whether the withdrawal circuit breaker is actually armed and working.
//
// It is opt-in and deliberately quiet: unset WITHDRAW_CUM_MAX_SAT and it does
// nothing at all, with no startup message and no log line. That is right for a
// mechanism nobody has configured, and wrong for one you believe is guarding
// you — "configured" and "functioning" are different claims, and the gap
// between them is where every silent failure in this codebase has lived.
//
// So this checks the whole chain: the cap reached the process, the state
// directory exists and is writable, the counter is readable, and whether the
// breaker is currently tripped. Exits non-zero if it is configured but cannot
// function, so it can go in a deploy check.
//
// Read-only apart from writing and deleting one probe file in GUARD_DIR.
//
// Usage:
//   docker exec -it app bun scripts/breaker-status.ts

import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { breakerEnabled, withdrawWindowTotal } from "$lib/withdraw-breaker";

const DIR = process.env.GUARD_DIR || "/locks";
const STATE = `${DIR}/withdraw-window.json`;
const LOCK = `${DIR}/ALL.locked`;

const CAP = Number(process.env.WITHDRAW_CUM_MAX_SAT || 0);
const WINDOW_H = Number(process.env.WITHDRAW_WINDOW_HOURS) || 24;

const fmt = (n: number) => n.toLocaleString("en-US");

let broken = false;
const bad = (msg: string) => {
  broken = true;
  console.log(`  PROBLEM: ${msg}`);
};

console.log("withdrawal circuit breaker\n");

if (!breakerEnabled()) {
  console.log("  DISABLED — WITHDRAW_CUM_MAX_SAT is unset or 0.");
  console.log("  Nothing caps cumulative outflow; every other control limits a single payment.");
  process.exit(1);
}

console.log(`  cap:      ${fmt(CAP)} sat over ${WINDOW_H}h`);

// The state directory is the whole mechanism: without it the counter can't
// persist and the trip can't write its lock.
if (!existsSync(DIR)) {
  bad(`${DIR} does not exist — is the /locks volume mounted? (docker exec app ls -d /locks)`);
} else {
  const probe = `${DIR}/.breaker-probe`;
  try {
    writeFileSync(probe, "x");
    rmSync(probe);
  } catch (e: any) {
    bad(`${DIR} is not writable (${e.message}) — the breaker cannot record or trip`);
  }
}

// Rolling total. withdrawWindowTotal() swallows a corrupt file and returns 0,
// which would read as "nothing withdrawn" here, so check the file separately.
if (existsSync(STATE)) {
  try {
    const entries = JSON.parse(readFileSync(STATE, "utf8"));
    if (!Array.isArray(entries)) bad(`${STATE} is not an array — the counter is corrupt`);
    else console.log(`  entries:  ${entries.length} in the state file`);
  } catch (e: any) {
    bad(`${STATE} is unreadable (${e.message}) — withdrawals will fail CLOSED until fixed`);
  }
} else {
  console.log("  entries:  none yet (no external withdrawal since the breaker was armed)");
}

const total = withdrawWindowTotal();
const pct = CAP > 0 ? Math.round((total / CAP) * 100) : 0;
console.log(`  used:     ${fmt(total)} sat (${pct}% of cap)`);
if (pct >= 80) console.log("  NOTE: above the 80% warning threshold");

const tripped = existsSync(LOCK);
if (tripped) {
  console.log("\n  TRIPPED — external withdrawals are halted, for everyone.");
  try {
    console.log(`  ${readFileSync(LOCK, "utf8").trim()}`);
  } catch {}
  console.log(`  To resume after review:  rm ${LOCK}`);
  console.log(`  To reset the total too:  rm ${STATE}`);
} else {
  console.log("  state:    armed, not tripped");
}

// Distinct exit codes so a deploy or monitoring check can tell the three
// apart. A tripped breaker is the mechanism working, but it still needs a
// human, so it must not exit 0 and read as all-clear.
if (broken) {
  console.log("\nConfigured but NOT functioning — fix the above.");
  process.exit(1);
}
if (tripped) {
  console.log("\nWorking, but currently halting all withdrawals — operator action needed.");
  process.exit(2);
}

console.log("\nArmed and functioning.");
process.exit(0);
