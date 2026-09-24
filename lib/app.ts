import config from "$config";
import { db } from "$lib/db";
import { banKey } from "$lib/utils";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { getCookie } from "hono/cookie";
import jwt from "jsonwebtoken";

const app = new Hono();

// There is no request/response file logging. `req` and `res` were pino
// destinations that nothing read, nothing rotated and nothing bounded: on one
// deployment they reached 42 MB and 111 MB. `req` held the full body of every
// non-GET request — memos, addresses, amounts, nostr events, each tied to a
// username and IP — and, until the redaction was fixed, plaintext signup
// passwords for 138 accounts.
//
// The app's own logging (lib/logging.ts -> stdout, capped by compose.yml at
// 100m x 5) is what is actually read. If body-level capture is ever needed for
// an incident, take it from a proxy in front of the app rather than
// accumulating it here for ever.

// IP blacklist — the app-level enforcement layer for the `cf:banned` redis
// set that lib/auth.ts's banIp() maintains. Checked first, before CORS/rate-
// limiting/routing, so a banned IP is rejected as cheaply as possible. This
// exists independent of (and faster than) the Cloudflare edge rule the same
// set feeds: that sync is best-effort, subject to the account's ruleset rule
// cap, and racy under concurrent bans, so this is the layer that always
// takes effect the instant an IP is added to the set.
app.use("*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip");
  if (ip) {
    // Match on the same unit banIp() stores — the /64 for IPv6, the address
    // itself for IPv4 — plus the raw address, since entries banned before
    // that normalization existed are still in the set as full /128s. One
    // round trip either way.
    //
    // Fail OPEN on any error. This middleware runs before everything, so a
    // throw here 500s every request on the server; letting traffic through
    // while the ban lookup is broken is strictly better than a total outage,
    // and the eviction check in lib/auth.ts still blocks the account itself.
    try {
      const key = banKey(ip);
      const members = key && key !== ip ? [key, ip] : [key ?? ip];
      // Replies as an array of 0/1 per member — this command has no boolean
      // transform, so don't type it as boolean[].
      const hits = (await db.smIsMember("cf:banned", members)) as unknown as number[];
      if (hits.some((n) => Number(n) === 1)) return c.text("Forbidden", 403);
    } catch (e: any) {
      console.error("ban check failed", ip, e.message);
    }
  }
  await next();
});

// CORS
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
  }),
);
app.use("*", async (c, next) => {
  await next();
  if (c.req.path.startsWith("/public/")) {
    c.res.headers.delete("vary");
    c.res.headers.delete("last-modified");
  }
});

// Static files
app.use("/public/*", async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
  c.res.headers.delete("vary");
  c.res.headers.delete("last-modified");
});
app.use(
  "/public/*",
  serveStatic({
    root: "/home/bun/app/data/uploads",
    rewriteRequestPath: (p) => p.replace("/public", ""),
  }),
);

// Rate limiting (disabled in development)
const prod = process.env.NODE_ENV === "production";
const rateLimits = new Map<string, { count: number; reset: number }>();
const strictLimits = new Map<string, { count: number; reset: number }>();

if (prod) {
  app.use("*", async (c, next) => {
    const url = c.req.path;

    // Skip rate limiting for public assets
    if (url.includes("public")) return next();

    const ip = (c.req.header("cf-connecting-ip") as string) || (c.env as any)?.ip || "unknown";
    const ua = c.req.header("user-agent") || "unknown-ua";
    // Always key on IP. This used to switch to the user-agent whenever the
    // caller sent `rate-limit-by: ua`, which handed every client an opt-out:
    // send that header, rotate the UA per request, and each request lands in
    // a fresh bucket — the general limit stopped applying at all. Nothing in
    // the UI sends the header. The strict limit below was never exposed to
    // this (it keys on uid, or ip+ua together).
    const key = ip;
    const now = Date.now();

    // General rate limit: 2000 req / 2s
    const gen = rateLimits.get(key);
    if (gen && now < gen.reset) {
      gen.count++;
      if (gen.count > 2000) {
        return c.json(
          {
            statusCode: 429,
            error: "Too Many Requests",
            message: "Rate limit exceeded, retry in 2 seconds",
          },
          429,
        );
      }
    } else {
      rateLimits.set(key, { count: 1, reset: now + 2000 });
    }

    // Strict rate limit for the credential-guessing surface: 10 req / 10s.
    //
    // /pin is here because a pin is six digits — the entire space is 10^6, and
    // under the general limit alone (2000 req / 2s) an attacker holding a
    // stolen session could walk all of it in minutes. The pin is the last
    // thing standing between such a session and a send, so it needs a limit
    // that makes guessing it pointless rather than merely slow. Exact match,
    // not includes(): a substring test would rope in any future path
    // containing "pin".
    //
    // /email, /freeze and /admin/sanitize-images join them because each tests a
    // caller-supplied string against config.adminpass — the master credential
    // login() accepts as any account's password — and each answers differently
    // on a hit. That makes them online guessing oracles, and they are all
    // unauthenticated, so the general 2000-req/2s bucket was the only thing
    // bounding an attacker. Exact matches: these are fixed paths.
    const isStrict =
      url.includes("/login") ||
      url.includes("/send") ||
      url === "/pin" ||
      url === "/email" ||
      url === "/freeze" ||
      url === "/admin/sanitize-images";
    if (isStrict) {
      // Keying on UA alone lets anyone bypass this by rotating the header.
      // Tie it to the authenticated account when there's a valid session
      // (cheap signature check, no DB lookup), otherwise fall back to
      // ip+ua so a shared/absent UA doesn't bucket unrelated clients.
      let uid = "";
      const bearer = c.req.header("authorization");
      const token = (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null) || getCookie(c, "token");
      if (token) {
        try {
          uid = (jwt.verify(token, config.jwt) as any).id;
        } catch {}
      }
      const strictKey = `strict:${uid || `${ip}:${ua}`}`;
      const s = strictLimits.get(strictKey);
      if (s && now < s.reset) {
        s.count++;
        if (s.count > 10) {
          return c.json(
            { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded" },
            429,
          );
        }
      } else {
        strictLimits.set(strictKey, { count: 1, reset: now + 10000 });
      }
    }

    return next();
  });

  // Clean up rate limit maps periodically
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimits) if (now >= v.reset) rateLimits.delete(k);
    for (const [k, v] of strictLimits) if (now >= v.reset) strictLimits.delete(k);
  }, 5000);
}

// Error handler
app.onError((err, c) => {
  // A body that isn't JSON is the caller's mistake, not a server fault. Most
  // handlers call `await c.req.json()` without guarding it, so any request
  // with a malformed body produced a 500 and an "unhandled error" log line —
  // trivially reachable on the unauthenticated routes, and every one of those
  // lines is noise in the stream where real faults have to be visible.
  // Answering 400 here fixes it for every handler at once, including the ones
  // written after this.
  const msg = err?.message || String(err);
  if (/JSON Parse error|Unexpected end of JSON|is not valid JSON/i.test(msg)) {
    console.warn("invalid request body:", c.req.method, c.req.path);
    return c.json({ error: "Invalid request body" }, 400);
  }

  console.error("unhandled error:", c.req.method, c.req.path, msg);
  return c.json({ ok: false }, 500);
});

// Not found handler
app.notFound((c) => c.text("Not Found", 404));

// Per-route rate limit — ported from upstream's Fastify `config.rateLimit`
// route option (this fork uses Hono, which has no equivalent), applied as
// middleware on individual routes rather than globally.
export const routeRateLimit = ({
  max,
  windowMs,
  keyPrefix,
}: {
  max: number;
  windowMs: number;
  keyPrefix: string;
}) => {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (c: any, next: any) => {
    const ip = (c.req.header("cf-connecting-ip") as string) || (c.env as any)?.ip || "unknown";
    const token = (c.req.header("authorization") || "").slice(0, 50);
    const key = `${keyPrefix}:${token || ip}`;
    const now = Date.now();
    const hit = hits.get(key);
    if (hit && now < hit.reset) {
      hit.count++;
      if (hit.count > max) {
        return c.json(
          { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded" },
          429,
        );
      }
    } else {
      hits.set(key, { count: 1, reset: now + windowMs });
    }
    return next();
  };
};

export default app;
