import config from "$config";
import { db } from "$lib/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { getCookie } from "hono/cookie";
import jwt from "jsonwebtoken";
import { pino } from "pino";

const app = new Hono();

const reqLogger = pino((pino as any).destination("req"));
const resLogger = pino((pino as any).destination("res"));

// IP blacklist — the app-level enforcement layer for the `cf:banned` redis
// set that lib/auth.ts's banIp() maintains. Checked first, before CORS/rate-
// limiting/routing, so a banned IP is rejected as cheaply as possible. This
// exists independent of (and faster than) the Cloudflare edge rule the same
// set feeds: that sync is best-effort, subject to the account's ruleset rule
// cap, and racy under concurrent bans, so this is the layer that always
// takes effect the instant an IP is added to the set.
app.use("*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip");
  if (ip && (await db.sIsMember("cf:banned", ip))) return c.text("Forbidden", 403);
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
    const rateLimitBy = c.req.header("rate-limit-by");
    const key = rateLimitBy === "ua" ? ua : ip;
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

    // Strict rate limit for /login and /send: 10 req / 10s
    const isStrict = url.includes("/login") || url.includes("/send");
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

// Never log plaintext passwords. Redact password fields from request bodies
// before they reach the request log.
const REDACT_FIELDS = ["password", "confirm", "secret", "otpsecret"];
const redactBody = (body: any) => {
  if (!body || typeof body !== "object") return body;
  const copy: any = { ...body };
  for (const field of REDACT_FIELDS)
    if (field in copy) copy[field] = "[redacted]";
  return copy;
};

// Request logging
app.use("*", async (c, next) => {
  const start = Date.now();
  const url = c.req.path;

  const ignore = [
    "/ws",
    "/me",
    "/confirm",
    "/public",
    "/rates",
    "/challenge",
    "/rate",
    "/lnurlp",
    "/subscriptions",
    "/accounts",
    "/contacts",
  ];

  const shouldLog =
    !ignore.some((path) => url.startsWith(path)) &&
    !(c.req.method === "GET" && url.startsWith("/users"));

  if (shouldLog) {
    const xff = c.req.header("x-forwarded-for");
    const forwardedIp = xff?.split(",")[0]?.trim();
    const ip = c.req.header("cf-connecting-ip") || forwardedIp || (c.env as any)?.ip || "unknown";

    let body;
    // Only parse body for non-GET requests
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      try {
        body = await c.req.raw.clone().json();
      } catch {}
    }

    reqLogger.info({
      method: c.req.method,
      url,
      ip,
      query: c.req.query(),
      body: redactBody(body),
      user: (c.get("user" as never) as any)?.username,
    });
  }

  await next();

  const rawCookies = c.req.header("cookie") || "";
  const cookies: any = rawCookies.split(";").reduce((acc, cookie) => {
    const [key, value] = cookie.split("=").map((s) => s.trim());
    if (key && value) acc[key] = value;
    return acc;
  }, {});

  resLogger.info({
    url,
    statusCode: c.res.status,
    durationMs: Date.now() - start,
    username: cookies.username,
  });
});

// Error handler
app.onError((err, c) => {
  console.error("unhandled error:", c.req.method, c.req.path, err?.message || err);
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
