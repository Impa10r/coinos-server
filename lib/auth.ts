import config from "$config";
import { db } from "$lib/db";
import { fail, getUser } from "$lib/utils";
import jwt from "jsonwebtoken";
import { getCookie } from "hono/cookie";
import net from "node:net";

const extractToken = (c) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return getCookie(c, "token") || null;
};

// Block a source IP at Cloudflare's edge via the Rulesets API — appends a
// block rule to an existing custom ruleset, used to auto-ban the instant an
// evicted (hard-killed) account's credential is used again. The eviction
// check below already 401s the request regardless; this is a second layer
// so the same IP can't immediately try other stolen credentials or keep
// probing. Fire-and-forget and fully best-effort: must never add latency to,
// or fail, the actual auth check. No-ops quietly if Cloudflare isn't
// configured (see config.ts.sample).
const banIp = async (ip: string, reason: string) => {
  const { apiToken, zoneId, rulesetId } = config.cloudflare || {};
  if (!apiToken || !zoneId || !rulesetId || !net.isIP(ip)) return;

  // The Rulesets API doesn't dedupe by expression — without this guard, every
  // repeat hit from an already-banned IP would append another identical rule.
  if (await db.sIsMember("cf:banned", ip)) return;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/${rulesetId}/rules`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          description: `coinos evicted-auth: ${reason}`,
          expression: `(ip.src eq ${ip})`,
          action: "block",
          enabled: true,
        }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as any;
    if (data.success) await db.sAdd("cf:banned", ip);
    else console.error("cloudflare ban failed", ip, JSON.stringify(data.errors));
  } catch (e: any) {
    console.error("cloudflare ban request failed", ip, e.message);
  }
};

// Hard eviction: an account in the `evicted` set cannot authenticate AT ALL —
// every request, every endpoint, INCLUDING login itself (an evicted account
// must not be able to complete a fresh login just because the resulting
// token is what actually gets blocked; login has its own call site for this
// in routes/users.ts, since it doesn't go through the `auth` middleware).
// Unlike the `blacklist` freeze (which only blocks sends), this kills the
// value of a compromised/attacker credential outright. Match on the
// immutable uid OR username so a rename can't shake it.
export const isEvicted = async (c, user) => {
  if (!user) return false;
  const evicted =
    (await db.sIsMember("evicted", user.id)) ||
    (await db.sIsMember("evicted", user.username?.toLowerCase?.().trim()));
  if (evicted) {
    const ip = c.req.header("cf-connecting-ip");
    // Distinctive, greppable line carrying the real source IP — kept even
    // though the ban below is now automatic, for visibility/search in logs.
    console.error(`EVICTED_AUTH ${user.username} ${ip}`);
    if (ip) void banIp(ip, user.username);
  }
  return evicted;
};

const authenticate = async (c) => {
  const token = extractToken(c);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, config.jwt);
    let { id } = payload as any;
    const url = c.req.path;
    const method = c.req.method;

    const wl = { GET: ["/invoice", "/payments"], POST: ["/invoice"] };
    if (id.endsWith("-ro") && wl[method]?.some((p) => url.startsWith(p))) id = id.slice(0, -3);

    const user = await getUser(id);
    if (await isEvicted(c, user)) return null;

    return user;
  } catch {
    return null;
  }
};

export const auth = async (c, next) => {
  const user = await authenticate(c);
  if (!user) return c.json("unauthorized", 401);
  c.set("user", user);
  await next();
};

export const optional = async (c, next) => {
  const user = await authenticate(c);
  if (user) c.set("user", user);
  await next();
};

export const admin = async (c, next) => {
  const user = await authenticate(c);
  if (!user?.admin) return c.json("unauthorized", 401);
  c.set("user", user);
  await next();
};

export const requirePin = async ({ body, user }) => {
  if (!user || (user.pin && user.pin !== body.pin)) fail("Invalid pin");
};
