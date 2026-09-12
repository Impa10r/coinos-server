import { l, err, warn } from "$lib/logging";
import config from "$config";
import { SESClient } from "@aws-sdk/client-ses";
import { SendEmailCommand } from "@aws-sdk/client-ses";
import handlebars from "handlebars";
import fs from "fs";

const Charset = "UTF-8";

export const templates = {
  verifyEmail: "templates/payments/verify.html",
  paymentReceived: "templates/payments/received.html",
  passwordReset: "templates/payments/reset.html",
};

// Two transports, chosen by config rather than by caller.
//
// SMTP wins when `config.smtp.host` is set — one place to point everything, so
// an operator with SMTP credentials doesn't need an AWS account for the server
// to be able to send mail at all. Otherwise it falls back to SES, which is
// what this has always used, so leaving `smtp` unset changes nothing.
//
// The SES client is built per call deliberately: it reads credentials through
// the AWS SDK's default provider chain (env, then /root/.aws via the compose
// mount), and a long-lived client would pin whatever was valid at boot.
const smtpConfig = () => (config as any).smtp;

// nodemailer is imported lazily, and only when SMTP is actually configured.
// As a top-level import it took the whole server down when the package was
// missing: lib/mail is pulled in by routes/users, lib/notifications and the
// withdraw breaker, so `Cannot find package 'nodemailer'` became a boot
// failure. That's a wildly disproportionate outcome for an optional transport
// — and it happens in practice, because the container's node_modules is a
// named docker volume, so a dependency added to package.json isn't present
// until `bun install` runs INSIDE the container.
let transport: any;
let nodemailerUnavailable = false;

const smtpTransport = async () => {
  const s = smtpConfig();
  if (!s?.host) return null;
  if (transport) return transport;
  if (nodemailerUnavailable) return null;

  try {
    const nodemailer = (await import("nodemailer")).default;
    transport = nodemailer.createTransport({
      host: s.host,
      port: s.port || 587,
      // Implicit TLS on 465; everything else negotiates STARTTLS.
      secure: s.secure ?? (s.port === 465),
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    });
    return transport;
  } catch (e: any) {
    // Try once, then stop: this is on the path of every outgoing message.
    nodemailerUnavailable = true;
    err(
      "smtp configured but nodemailer could not be loaded — falling back to ses.",
      "run `bun install` inside the app container.",
      e.message,
    );
    return null;
  }
};

const from = () => smtpConfig()?.from || `"Coinos " <${config.support}>`;

// Send one message. Throws on failure — the callers below decide whether that
// should be swallowed, and they both do, for different reasons. Exported so
// scripts/test-alert.ts can get at the real error: going through alert() means
// failures are swallowed and logged via pino, which a script cannot reliably
// detect, so a broken transport read as success.
export const send = async ({
  to,
  subject,
  html,
  text,
}: { to: string; subject: string; html?: string; text?: string }) => {
  const smtp = await smtpTransport();
  if (smtp) {
    await smtp.sendMail({ from: from(), to, subject, html, text });
    return;
  }

  const client = new SESClient({ region: "us-east-2" });
  await client.send(
    new SendEmailCommand({
      Destination: { ToAddresses: [to] },
      Message: {
        Body: html ? { Html: { Charset, Data: html } } : { Text: { Charset, Data: text ?? "" } },
        Subject: { Charset, Data: subject },
      },
      Source: from(),
    }),
  );
};

// Operator alert. Unlike mail(), this takes no user and no handlebars
// template — it goes to config.alertEmail (falling back to config.support) and
// carries a preformatted body, so a safety mechanism can raise the alarm
// without needing a template file or a user record to hang it on.
//
// Never throws: callers are incident paths, and a failed notification must not
// take down whatever it was reporting on. That does mean a misconfigured
// transport is only visible as the error line below — see
// scripts/test-alert.ts to prove delivery end to end before you need it.
export const alert = async (subject: string, body: string) => {
  const to = (config as any).alertEmail || config.support;
  try {
    if (!to) return warn("alert: no alertEmail or support address configured", subject);
    l("sending alert", subject, (await smtpTransport()) ? "via smtp" : "via ses");
    await send({ to, subject, text: body });
  } catch (e: any) {
    err("failed to send alert", subject, e.message);
  }
};

export const mail = async (user, subject, template, params) => {
  try {
    // Record the transport, as alert() does. Without it a delivery complaint
    // is undiagnosable from the logs: SMTP and the SES fallback look
    // identical, so "sent, never arrived" can't be separated from "went out
    // over a transport you thought was retired".
    l("sending mail", user.username, subject, (await smtpTransport()) ? "via smtp" : "via ses");
    if (!user.email) return warn("sending mail: no address for", user.username, subject);

    const source = fs.readFileSync(template, "utf8");
    const html = handlebars.compile(source)(params);

    await send({ to: user.email, subject, html });
  } catch (e) {
    err("failed to send email", e.message);
  }
};
