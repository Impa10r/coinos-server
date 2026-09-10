// Send a real operator alert, to prove the notification path works.
//
// alert() swallows its own failures on purpose — a failed notification must
// not take down the incident it's reporting — so a misconfigured transport,
// an expired credential or a sender address the provider won't accept produce
// nothing but one error line in the logs. The first time you'd notice is
// during an actual drain, which is the worst moment to discover it.
//
// This exercises the same path lib/withdraw-breaker.ts uses on a trip: same
// transport selection, same From, same recipient.
//
// Unlike alert() itself, this reports failure loudly and exits non-zero, so it
// can be wired into a deploy check.
//
// Usage:
//   docker exec -it app bun scripts/test-alert.ts
//   docker exec -it app bun scripts/test-alert.ts ops@example.com

import config from "$config";
import { alert } from "$lib/mail";

const override = process.argv[2];
if (override) (config as any).alertEmail = override;

const to = (config as any).alertEmail || config.support;
const smtp = (config as any).smtp;

console.log(`transport:  ${smtp?.host ? `smtp ${smtp.host}:${smtp.port || 587}` : "ses us-east-2"}`);
console.log(`from:       ${smtp?.from || config.support}`);
console.log(`to:         ${to || "(none configured)"}`);

if (!to) {
  console.error("\nNo recipient: set config.alertEmail (or config.support).");
  process.exit(1);
}

// alert() never throws, so watch the log stream for its failure line rather
// than relying on a rejected promise here.
let failed = false;
const origError = console.error;
console.error = (...a: any[]) => {
  if (String(a[0] ?? "").includes("failed to send alert")) failed = true;
  origError(...a);
};

await alert(
  "coinos: test alert",
  [
    "This is a test of the operator alert path.",
    "",
    "If you are reading this, a withdrawal circuit breaker trip will reach you.",
    `Sent ${new Date().toISOString()} from ${process.env.HOSTNAME || "unknown host"}.`,
  ].join("\n"),
);

console.error = origError;

if (failed) {
  console.error("\nFAILED — see the error line above. Nothing was delivered.");
  process.exit(1);
}

console.log(`\nSent. Confirm it arrived at ${to} — the send returning cleanly`);
console.log("only means the transport accepted it, not that it was delivered.");
process.exit(0);
