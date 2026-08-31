import config from "$config";
import { db } from "$lib/db";
import { fail, getClientIp, getUser } from "$lib/utils";
import jwt from "jsonwebtoken";
import { getCookie } from "hono/cookie";
import net from "node:net";

const extractToken = (c) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return getCookie(c, "token") || null;
};

// Append a banned IP to the Cloudflare IP List (Manage account >
// Configurations > Lists) that the account's single "coinos evicted-auth"
// custom rule references via `ip.src in $<list name>` — see
// config.ts.sample for the one-time dashboard setup (create the list once,
// point one rule at it). Unlike editing a rule/ruleset directly, the rule
// itself never changes — only the list's membership does — so there's no
// rule-count cap to hit (the earlier per-IP-rule version hit the account's
// 5-rule cap after a handful of bans) and no risk of clobbering unrelated
// rules by rewriting the ruleset.
const appendCloudflareBanList = async (ip: string, reason: string) => {
  const { apiToken, accountId, bannedIpListId } = config.cloudflare || {};
  if (!apiToken || !accountId || !bannedIpListId) return;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/rules/lists/${bannedIpListId}/items`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ ip, comment: reason.slice(0, 100) }]),
      },
    );
    const data = (await res.json().catch(() => ({}))) as any;
    if (!data.success)
      console.error("cloudflare ban-list append failed", ip, JSON.stringify(data.errors));
  } catch (e: any) {
    console.error("cloudflare ban-list append request failed", ip, e.message);
  }
};

// Ban a source IP: adds it to the `cf:banned` redis set (the app-level
// blacklist enforced on every request — see lib/app.ts) and, if Cloudflare
// is configured, appends it to the edge IP list above. Used to auto-ban the
// instant an evicted (hard-killed) account's credential is used again. The
// eviction check elsewhere already 401s the request regardless; this is a
// second layer so the same IP can't immediately try other stolen
// credentials or keep probing. Fire-and-forget and fully best-effort: must
// never add latency to, or fail, the actual auth check.
const banIp = async (ip: string, reason: string) => {
  if (!net.isIP(ip)) return;

  // SADD returns 1 only when the IP is newly added — skip the Cloudflare
  // round-trip entirely on a repeat hit from an already-banned IP.
  const added = await db.sAdd("cf:banned", ip);
  if (!added) return;
  console.error(`IP_BANNED ${ip} ${reason}`);

  void appendCloudflareBanList(ip, reason);
};

// Hard eviction: an account in the `evicted` set cannot authenticate AT ALL —
// every request, every endpoint, INCLUDING login itself (an evicted account
// must not be able to complete a fresh login just because the resulting
// token is what actually gets blocked; login has its own call site for this
// in routes/users.ts, since it doesn't go through the `auth` middleware).
// Unlike the `blacklist` freeze (which only blocks sends), this kills the
// value of a compromised/attacker credential outright. Match on the
// immutable uid OR username so a rename can't shake it.
// Auto-eviction: called from abuse-detection points elsewhere in the app
// (e.g. attempting to create a fund under a non-UUID name) to hard-kill an
// account the instant it's caught, without waiting for manual admin action.
// Adds to the same `evicted` set isEvicted() checks, so the account is dead
// starting with its very next request. Also bans the current IP immediately
// — via the same Cloudflare Rulesets call isEvicted() uses — rather than
// waiting on that next request to trip isEvicted()'s own ban.
export const evictUser = async (user: any, reason: string, ip?: string) => {
  if (!user?.id) return;
  await db.sAdd("evicted", user.id);
  console.error(`AUTO_EVICT ${user.username} ${reason} ${ip ?? ""}`);
  if (ip) void banIp(ip, reason);
};

export const isEvicted = async (c, user) => {
  if (!user) return false;
  const evicted =
    (await db.sIsMember("evicted", user.id)) ||
    (await db.sIsMember("evicted", user.username?.toLowerCase?.().trim()));
  if (evicted) {
    const ip = getClientIp(c);
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
