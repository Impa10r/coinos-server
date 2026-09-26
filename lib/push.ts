// Web-push subscriptions are client-supplied, and webpush.sendNotification
// POSTs to whatever `endpoint` they carry — on every incoming payment and every
// DM. Without a check on the endpoint, an authenticated user could register a
// subscription pointing at an internal host (169.254.169.254, a service on the
// docker network, localhost) and turn each payment they receive into a
// server-side POST to it: a blind SSRF, the same class lib/safe-fetch.ts closes
// for webhooks. Validate at write time so only vendor push endpoints, over
// https, are ever stored; cap size and count while here.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

const MAX_SUBSCRIPTION_BYTES = 2048;
export const MAX_SUBSCRIPTIONS = 10;

// Returns the canonical JSON string to store, or null if the subscription is
// not a well-formed push subscription aimed at a known vendor endpoint.
export const validPushSubscription = (s: unknown): string | null => {
  let sub: any = s;
  if (typeof sub === "string") {
    try {
      sub = JSON.parse(sub);
    } catch {
      return null;
    }
  }
  if (!sub || typeof sub !== "object") return null;
  if (typeof sub.endpoint !== "string") return null;
  if (!sub.keys || typeof sub.keys !== "object") return null;
  if (typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string")
    return null;

  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;

  // Store only the fields web-push needs, so a client cannot pad the record
  // with arbitrary extra keys, and re-check the trimmed size.
  const canonical = JSON.stringify({
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
  if (Buffer.byteLength(canonical) > MAX_SUBSCRIPTION_BYTES) return null;

  return canonical;
};
