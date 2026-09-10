import { l, err, warn } from "$lib/logging";
import config from "$config";
import { SESClient } from "@aws-sdk/client-ses";
import { SendEmailCommand } from "@aws-sdk/client-ses";
import handlebars from "handlebars";
import fs from "fs";
import nodemailer from "nodemailer";

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

let transport: any;
const smtpTransport = () => {
  const s = smtpConfig();
  if (!s?.host) return null;
  if (!transport)
    transport = nodemailer.createTransport({
      host: s.host,
      port: s.port || 587,
      // Implicit TLS on 465; everything else negotiates STARTTLS.
      secure: s.secure ?? (s.port === 465),
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    });
  return transport;
};

const from = () => smtpConfig()?.from || `"Coinos " <${config.support}>`;

// Send one message. Throws on failure — the callers below decide whether that
// should be swallowed, and they both do, for different reasons.
const send = async ({
  to,
  subject,
  html,
  text,
}: { to: string; subject: string; html?: string; text?: string }) => {
  const smtp = smtpTransport();
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
    l("sending alert", subject, smtpTransport() ? "via smtp" : "via ses");
    await send({ to, subject, text: body });
  } catch (e: any) {
    err("failed to send alert", subject, e.message);
  }
};

export const mail = async (user, subject, template, params) => {
  try {
    l("sending mail", user.username, subject);
    if (!user.email) return;

    const source = fs.readFileSync(template, "utf8");
    const html = handlebars.compile(source)(params);

    await send({ to: user.email, subject, html });
  } catch (e) {
    err("failed to send email", e.message);
  }
};
