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

// Operator alert. Unlike mail(), this takes no user and no handlebars
// template — it goes to config.alertEmail (falling back to config.support) and
// carries a preformatted body, so a safety mechanism can raise the alarm
// without needing a template file or a user record to hang it on.
//
// Never throws: callers are incident paths, and a failed notification must not
// take down whatever it was reporting on.
export const alert = async (subject: string, body: string) => {
  const to = (config as any).alertEmail || config.support;
  try {
    if (!to) return warn("alert: no alertEmail or support address configured", subject);
    l("sending alert", subject);

    const client = new SESClient({ region: "us-east-2" });
    await client.send(
      new SendEmailCommand({
        Destination: { ToAddresses: [to] },
        Message: {
          Body: { Text: { Charset, Data: body } },
          Subject: { Charset, Data: subject },
        },
        Source: `"Coinos " <${config.support}>`,
      }),
    );
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

    const client = new SESClient({ region: "us-east-2" });

    await client.send(
      new SendEmailCommand({
        Destination: {
          ToAddresses: [user.email],
        },
        Message: {
          Body: {
            Html: { Charset, Data: html },
          },
          Subject: { Charset, Data: subject },
        },
        Source: `"Coinos " <${config.support}>`,
      }),
    );
  } catch (e) {
    err("failed to send email", e.message);
  }
};
