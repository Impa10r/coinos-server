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

// Description marker for every rule this feature has ever created — both
// the old one-rule-per-IP format (`coinos evicted-auth: <reason>`, one POST
// per ban) and the current single consolidated rule below. Filtering on this
// prefix is how syncCloudflareBanRule finds (and replaces) its own rule(s)
// without touching anything else on the ruleset.
const CF_RULE_DESCRIPTION_PREFIX = "coinos evicted-auth";

// Push the full `cf:banned` IP set to Cloudflare's edge as ONE rule (an
// `ip.src in {...}` set-membership expression), replacing whatever rule(s)
// this feature previously created. The old version created a brand-new rule
// PER banned IP, which hit the account's custom-ruleset rule cap ("6 out of
// 5") after only a handful of bans — GET+PUT the whole ruleset instead of
// individual rule create/update calls so this self-heals that: any leftover
// per-IP rules from the old code get folded into the same single rule on the
// next ban. Stateless by design (always re-derives from `cf:banned`, never
// tracks a rule id) so it can't drift from what's actually banned.
const syncCloudflareBanRule = async () => {
  const { apiToken, zoneId, rulesetId } = config.cloudflare || {};
  if (!apiToken || !zoneId || !rulesetId) return;

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  try {
    const ips = [...(await db.sMembers("cf:banned"))].map(String);
    if (!ips.length) return;

    const getRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/${rulesetId}`,
      { headers },
    );
    const getData = (await getRes.json().catch(() => ({}))) as any;
    // Bail rather than proceed on an empty/guessed rule list — a failed GET
    // treated as "no other rules" would PUT an empty set and silently wipe
    // any unrelated rules already on this ruleset.
    if (!getData.success) {
      console.error("cloudflare ruleset fetch failed, skipping ban-rule sync", JSON.stringify(getData.errors));
      return;
    }
    const existingRules: any[] = getData?.result?.rules || [];
    const keptRules = existingRules.filter(
      (r: any) => !String(r.description || "").startsWith(CF_RULE_DESCRIPTION_PREFIX),
    );

    const rules = [
      ...keptRules,
      {
        description: `${CF_RULE_DESCRIPTION_PREFIX}: auto-banned IPs`,
        expression: `(ip.src in {${ips.join(" ")}})`,
        action: "block",
        enabled: true,
      },
    ];

    const putRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/${rulesetId}`,
      { method: "PUT", headers, body: JSON.stringify({ rules }) },
    );
    const putData = (await putRes.json().catch(() => ({}))) as any;
    if (!putData.success)
      console.error("cloudflare ban-rule sync failed", JSON.stringify(putData.errors));
  } catch (e: any) {
    console.error("cloudflare ban-rule sync request failed", e.message);
  }
};

// Ban a source IP: adds it to the `cf:banned` redis set (the app-level
// blacklist enforced on every request — see lib/app.ts) and, if Cloudflare
// is configured, pushes the full set to the edge as one consolidated rule.
// Used to auto-ban the instant an evicted (hard-killed) account's credential
// is used again. The eviction check elsewhere already 401s the request
// regardless; this is a second layer so the same IP can't immediately try
// other stolen credentials or keep probing. Fire-and-forget and fully
// best-effort: must never add latency to, or fail, the actual auth check.
const banIp = async (ip: string, reason: string) => {
  if (!net.isIP(ip)) return;

  // SADD returns 1 only when the IP is newly added — skip the Cloudflare
  // round-trip entirely on a repeat hit from an already-banned IP.
  const added = await db.sAdd("cf:banned", ip);
  if (!added) return;
  console.error(`IP_BANNED ${ip} ${reason}`);

  void syncCloudflareBanRule();
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
