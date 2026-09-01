import config from "$config";
import { db } from "$lib/db";
import { banKey, fail, getClientIp, getUser } from "$lib/utils";
import jwt from "jsonwebtoken";
import { getCookie } from "hono/cookie";

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

  const headers = { Authorization: `Bearer ${apiToken}` };
  const itemsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/rules/lists/${bannedIpListId}/items`;

  try {
    // No pre-read/dedupe check: Cloudflare's cursor for this endpoint
    // returned "invalid or expired cursor" on the very next paginated
    // request in production, which made a failed read abort the append
    // entirely — silently disabling the whole ban mechanism, worse than
    // the duplicate it was meant to prevent. The `cf:banned` redis SADD
    // guard in banIp() already skips this call for any IP this app has
    // already banned; a duplicate item can only happen if that set drifts
    // from Cloudflare's list (a redis flush, or an IP added manually), and
    // a harmless duplicate list entry is an acceptable cost for that.
    const res = await fetch(itemsUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify([{ ip, comment: reason.slice(0, 100) }]),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!data.success)
      console.error("cloudflare ban-list append failed", ip, JSON.stringify(data.errors));
  } catch (e: any) {
    console.error("cloudflare ban-list request failed", ip, e.message);
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
  // What lands in the set is the /64 for IPv6, the address itself for IPv4 —
  // see banKey(). lib/app.ts's enforcement middleware normalizes the incoming
  // IP the same way, so the two always agree.
  const key = banKey(ip);
  if (!key) return;

  // SADD returns 1 only when the entry is newly added — skip the Cloudflare
  // round-trip entirely on a repeat hit from an already-banned source.
  const added = await db.sAdd("cf:banned", key);
  if (!added) return;
  console.error(`IP_BANNED ${key} ${reason}`);

  void appendCloudflareBanList(key, reason);
};

// Hard eviction: an account in the `evicted` set cannot authenticate AT ALL —
// every request, every endpoint, INCLUDING login itself (an evicted account
// must not be able to complete a fresh login just because the resulting
// token is what actually gets blocked; login has its own call site for this
// in routes/users.ts, since it doesn't go through the `auth` middleware).
// Match on the immutable uid OR username so a rename can't shake it.
//
// Eviction alone does NOT freeze spending — it only blocks the evicted
// account from making its OWN authenticated requests. Some code paths debit
// a user fetched independently of the request's caller (e.g. take()'s
// authorization-claim funding step debits the authorization's original
// creator, looked up by uid, regardless of who is calling /take) — those
// bypass isEvicted() entirely and are only stopped by debit()'s `blacklist`
// check (which reserves the account's whole balance as unspendable via
// tbDebit's frozen-balance argument). evictUser() below adds to BOTH sets so
// a hard eviction can't leave a compromised account's balance reachable
// through a path like that.
// A fund is withdrawable by "anyone with the link" (see take()/authorize()
// in routes/payments.ts) — its own balance check never looks at who founded
// or funded it, only at the fund's own TigerBeetle balance. Blacklisting
// the evicted account (above) does nothing for money already sitting in a
// fund: it's a separate TigerBeetle account, reachable by anyone who knows
// the fund id regardless of the founder's own status. Disable every fund
// this account has ever funded (user:<uid>:funds — populated for ANY
// funder, not just the fund's original creator) so it can no longer be
// withdrawn from or added to. Also clear the fund's manager list: take()'s
// separate `if (managers.length && !managers.includes(user.id))
// fail("Unauthorized")` check would otherwise still block a whitelisted ops
// account from sweeping/cleaning up the fund even though the disabled
// check's own whitelist exemption lets them past THAT gate — with no
// managers left, the disabled flag becomes the sole gatekeeper. Scoped to
// this one account's own fund list (not a global fund scan), so it's cheap
// enough to run inline; still fire-and-forget so it can never add latency
// to the eviction itself.
export const disableFoundedFunds = async (uid: string) => {
  try {
    const fundIds = [...(await db.sMembers(`user:${uid}:funds`))].map(String);
    if (!fundIds.length) return;
    await Promise.all(
      fundIds.map((id) =>
        Promise.all([db.set(`fund:${id}:disabled`, "1"), db.del(`fund:${id}:managers`)]),
      ),
    );
    // Deliberately unlogged: this re-runs on EVERY request an evicted account
    // makes (it doubles as a backfill for manually-evicted accounts), so a log
    // line here just repeats forever while the account keeps probing. The
    // eviction itself is already logged by EVICTED_AUTH / AUTO_EVICT.
  } catch (e: any) {
    console.error("disableFoundedFunds failed", uid, e.message);
  }
};

export const evictUser = async (user: any, reason: string, ip?: string) => {
  if (!user?.id) return;
  await Promise.all([db.sAdd("evicted", user.id), db.sAdd("blacklist", user.id)]);
  console.error(`AUTO_EVICT ${user.username} ${reason} ${ip ?? ""}`);
  if (ip) void banIp(ip, reason);
  void disableFoundedFunds(user.id);
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
    // Backfill blacklist + fund-disabling for an account evicted manually
    // (an admin adding only to `evicted`, not through evictUser()) — without
    // this, eviction blocks this account's own requests but leaves its
    // balance AND any fund it founded reachable (see evictUser()'s comments
    // above for both).
    void db.sAdd("blacklist", user.id);
    void disableFoundedFunds(user.id);
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
