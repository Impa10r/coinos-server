// Send a real operator alert, to prove the notification path works.
//
// alert() swallows its own failures on purpose — a failed notification must
// not take down the incident it's reporting — so a misconfigured transport,
// an expired credential or a sender address the provider won't accept produce
// nothing but one error line in the logs. The first time you'd notice is
// during an actual drain, which is the worst moment to discover it.
//
// So this calls send() directly rather than alert(): same transport selection,
// same From, same recipient, but the error propagates instead of being logged
// and dropped. An earlier version of this script did go through alert() and
// tried to detect trouble by watching console.error — which pino doesn't use,
// so it cheerfully reported success while nothing was delivered.
//
// Usage:
//   docker exec -it app bun scripts/test-alert.ts
//   docker exec -it app bun scripts/test-alert.ts ops@example.com

import config from "$config";
import { send } from "$lib/mail";

const to = process.argv[2] || (config as any).alertEmail || config.support;
const smtp = (config as any).smtp;

console.log(`transport:  ${smtp?.host ? `smtp ${smtp.host}:${smtp.port || 587}` : "ses us-east-2"}`);
console.log(`from:       ${smtp?.from || config.support}`);
console.log(`to:         ${to || "(none configured)"}`);
console.log();

if (!to) {
  console.error("No recipient: set config.alertEmail (or config.support), or pass one as an argument.");
  process.exit(1);
}

try {
  await send({
    to,
    subject: "coinos: test alert",
    text: [
      "This is a test of the operator alert path.",
      "",
      "If you are reading this, a withdrawal circuit breaker trip will reach you.",
      `Sent ${new Date().toISOString()} from ${process.env.HOSTNAME || "unknown host"}.`,
    ].join("\n"),
  });
} catch (e: any) {
  console.error(`FAILED: ${e.message}`);
  console.error();
  if (/Cannot find package 'nodemailer'/.test(e.message))
    console.error(
      "nodemailer isn't installed where the app looks. The container's node_modules is\n" +
        "a named docker volume, so neither a host `bun install` nor an image rebuild\n" +
        "reaches it — Docker won't repopulate an existing volume. Run:\n" +
        "  docker exec -it app bun install",
    );
  else if (/credentials/i.test(e.message))
    console.error(
      "No usable credentials. For SES that means /root/.aws is empty or expired; if you\n" +
        "meant to use SMTP, config.smtp.host isn't set — this fell back to SES.",
    );
  else if (/must equal|not allowed|sender|5\.7\./i.test(e.message))
    console.error(
      "The provider rejected the sender. Gmail in particular requires the From address\n" +
        "to be the authenticated account or a verified send-as alias.",
    );
  process.exit(1);
}

console.log(`Accepted by the transport, addressed to ${to}.`);
console.log("Confirm it actually arrived — acceptance is not delivery.");
process.exit(0);
