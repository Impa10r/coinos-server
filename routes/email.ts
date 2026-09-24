import { bail } from "$lib/utils";
import got from "got";
import config from "$config";
import { warn } from "$lib/logging";
import { SESClient } from "@aws-sdk/client-ses";
import { SendEmailCommand } from "@aws-sdk/client-ses";

export default {
  async send(c) {
    try {
      const body = await c.req.json();
      const { email, message, username, token: response } = body;

      const Charset = "UTF-8";

      const { recaptcha: secret } = config;
      const { success } = (await got
        .post("https://www.google.com/recaptcha/api/siteverify", {
          form: {
            secret,
            response,
          },
        })
        .json()) as any;

      // No adminpass bypass. This endpoint is unauthenticated, and answering
      // differently for a correct guess made it an online oracle for the master
      // credential that login() accepts as any user's password — reachable at
      // the general rate limit, with no account needed. An admin who wants to
      // reach support can solve a captcha like everyone else.
      if (success) {
        body.token = undefined;

        warn("support request from", email);
        const client = new SESClient({ region: "us-east-2" });
        await client.send(
          new SendEmailCommand({
            Destination: {
              CcAddresses: [],
              ToAddresses: [config.support],
            },
            Message: {
              Body: {
                Html: { Charset, Data: message.replace(/\n/g, "<br>") },
                Text: { Charset, Data: message },
              },
              Subject: {
                Charset,
                Data: body.subject || `Support Request${username ? ` From ${username}` : ""}`,
              },
            },
            ReplyToAddresses: [email],
            Source: config.support,
          }),
        );

        return c.json({ ok: true });
      } else {
        return bail(c, "failed captcha");
      }
    } catch {}
  },
};
