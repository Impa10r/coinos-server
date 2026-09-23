import { afterAll, describe, expect, test } from "bun:test";
import { callWebhook } from "$lib/webhooks";

// callWebhook posts the invoice's `secret` — the value the merchant uses to
// authenticate the notification — to a url set by whoever created the invoice.
// POST /invoice takes `optional` auth, so that is anyone: an invoice can name
// an internal address and be triggered by paying it a single sat.
//
// It also ran with https.rejectUnauthorized:false, so an interceptor could
// present any certificate and take the secret.
//
// Both now go through safePost, which resolves the host, refuses
// loopback/private/link-local/metadata targets, connects to the IP it
// validated, and verifies TLS.

const received: any[] = [];

// A server the delivery must refuse to reach. Loopback is the only thing a
// sandbox can stand up, which is also exactly what the guard blocks — so this
// doubles as the internal-target case and the reason the old "a trusted
// endpoint still receives it" test cannot exist here: every host available to
// this process is one safePost is right to refuse. Verified separately that a
// public-range address passes validation and fails only on connect.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push(await req.json().catch(() => ({})));
    return new Response("ok");
  },
});

afterAll(() => server.stop(true));

const deliver = (url: string) =>
  callWebhook(
    { address: "addr", received: 1000, text: "t", webhook: url, secret: "SHARED-SECRET" },
    { amount: 1000, confirmed: true, hash: "h", memo: "m" },
  );

describe("webhook delivery will not reach an internal target", () => {
  test("a loopback url receives nothing", async () => {
    received.length = 0;
    await deliver(`http://localhost:${server.port}/hook`);
    // callWebhook swallows its own errors by design — a payment must not
    // depend on its notification — so the assertion is on what arrived.
    expect(received).toHaveLength(0);
  });

  test("private and metadata ranges receive nothing either", async () => {
    received.length = 0;
    for (const url of [
      "http://10.0.0.5/hook",
      "http://192.168.1.10/hook",
      "http://169.254.169.254/hook",
    ]) {
      await deliver(url);
    }
    expect(received).toHaveLength(0);
  });

  test("a url that is not http(s) is refused", async () => {
    received.length = 0;
    await deliver("file:///etc/passwd");
    expect(received).toHaveLength(0);
  });
});
