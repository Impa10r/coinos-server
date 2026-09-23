import { afterAll, describe, expect, test } from "bun:test";
import { callWebhook } from "$lib/webhooks";

// callWebhook posts the invoice's `secret` — the shared value the merchant
// uses to authenticate the notification — to a merchant-supplied URL. It ran
// with https.rejectUnauthorized:false, so anyone able to intercept that
// connection could present their own certificate, take the secret, and forge
// "payment received" callbacks to that merchant from then on.
//
// A self-signed server stands in for the interceptor: if the secret reaches it,
// verification is off.

const received: any[] = [];

const server = Bun.serve({
  port: 0,
  tls: {
    cert: Bun.file(`${import.meta.dir}/fixtures/cert.pem`),
    key: Bun.file(`${import.meta.dir}/fixtures/key.pem`),
  },
  async fetch(req) {
    received.push(await req.json().catch(() => ({})));
    return new Response("ok");
  },
});

const url = `https://localhost:${server.port}/hook`;

afterAll(() => server.stop(true));

describe("webhook delivery verifies TLS", () => {
  test("the shared secret is not handed to an untrusted certificate", async () => {
    received.length = 0;

    await callWebhook(
      { address: "addr", received: 1000, text: "t", webhook: url, secret: "SHARED-SECRET" },
      { amount: 1000, confirmed: true, hash: "h", memo: "m" },
    );

    // callWebhook swallows its own errors by design — the payment must not
    // depend on the notification — so the assertion is on what arrived.
    expect(received).toHaveLength(0);
  });

  test("a trusted endpoint still receives the notification", async () => {
    received.length = 0;
    const plain = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.json().catch(() => ({})));
        return new Response("ok");
      },
    });

    await callWebhook(
      {
        address: "addr",
        received: 1000,
        text: "t",
        webhook: `http://localhost:${plain.port}/hook`,
        secret: "SHARED-SECRET",
      },
      { amount: 1000, confirmed: true, hash: "h", memo: "m" },
    );

    expect(received).toHaveLength(1);
    expect(received[0].secret).toBe("SHARED-SECRET");
    plain.stop(true);
  });
});
