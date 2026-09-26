import { describe, expect, test } from "bun:test";
import { MAX_SUBSCRIPTIONS, validPushSubscription } from "$lib/push";

// web-push POSTs to subscription.endpoint on every notification, so an
// unvalidated endpoint is a server-side request to a host the caller chose.
// validPushSubscription is the write-time gate: vendor hosts, https, bounded.
const keys = { p256dh: "x".repeat(87), auth: "y".repeat(22) };

describe("validPushSubscription rejects SSRF endpoints", () => {
  for (const [name, endpoint] of [
    ["cloud metadata IP", "http://169.254.169.254/latest/meta-data/"],
    ["internal service", "http://mint:3338/admin"],
    ["internal over https", "https://arc:6480/"],
    ["localhost", "https://127.0.0.1/x"],
    ["file scheme", "file:///etc/passwd"],
    ["vendor host but http", "http://fcm.googleapis.com/x"],
    ["vendor lookalike suffix", "https://fcm.googleapis.com.evil.com/x"],
  ] as const) {
    test(name, () => {
      expect(validPushSubscription({ endpoint, keys })).toBeNull();
    });
  }
});

describe("validPushSubscription accepts real vendor endpoints", () => {
  for (const [name, endpoint] of [
    ["FCM", "https://fcm.googleapis.com/fcm/send/abc"],
    ["Apple", "https://web.push.apple.com/xyz"],
    ["Mozilla", "https://updates.push.services.mozilla.com/wpush/v2/z"],
    ["Windows", "https://db5.notify.windows.com/w"],
  ] as const) {
    test(name, () => {
      expect(validPushSubscription({ endpoint, keys })).not.toBeNull();
    });
  }

  test("accepts a JSON-string subscription and returns canonical JSON", () => {
    const s = validPushSubscription(
      JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys, extra: "dropped" }),
    );
    expect(s).not.toBeNull();
    const parsed = JSON.parse(s as string);
    expect(parsed.extra).toBeUndefined(); // padding stripped
    expect(parsed.endpoint).toBe("https://fcm.googleapis.com/fcm/send/x");
  });
});

describe("validPushSubscription rejects malformed input", () => {
  test("missing keys", () =>
    expect(validPushSubscription({ endpoint: "https://fcm.googleapis.com/x" })).toBeNull());
  test("not an object", () => expect(validPushSubscription("nonsense")).toBeNull());
  test("oversized", () =>
    expect(
      validPushSubscription({ endpoint: "https://fcm.googleapis.com/" + "a".repeat(3000), keys }),
    ).toBeNull());
  test("MAX_SUBSCRIPTIONS is a sane cap", () => {
    expect(MAX_SUBSCRIPTIONS).toBeGreaterThan(0);
    expect(MAX_SUBSCRIPTIONS).toBeLessThanOrEqual(20);
  });
});
