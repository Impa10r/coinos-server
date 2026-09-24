import config from "$config";
import { db } from "$lib/db";
import { banKey, fail, getClientIp, getPayment, getUser } from "$lib/utils";
import { timingSafeEqual } from "crypto";
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
// fail("Unauthorized", 401)` check would otherwise still block a whitelisted ops
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

// The eviction itself, with no cascade. cascadeFundPayouts() below calls this
// rather than evictUser() so an automatic eviction can never trigger another
// round of automatic evictions — depth is capped at one structurally.
const evictAccount = async (user: any, reason: string, ip?: string) => {
  if (!user?.id) return;
  const username = user.username?.toLowerCase?.().trim();
  // Both the uid AND the username. changeid() rekeys an account to a fresh
  // uid while KEEPING its username (see lib/changeid.ts), so a uid-only entry
  // is silently shed if that account is ever rekeyed — by the blocked-address
  // handler in lib/payments.ts, or by hand. isEvicted() and debit()'s
  // blacklist check both already match on either.
  const entries = [user.id, username].filter(Boolean);
  await Promise.all([db.sAdd("evicted", entries), db.sAdd("blacklist", entries)]);
  console.error(`AUTO_EVICT ${user.username} ${reason} ${ip ?? ""}`);
  if (ip) void banIp(ip, reason);
  void disableFoundedFunds(user.id);
};

// When an account is evicted, everyone it paid out of its own funds is
// suspect — that's the money-mule pattern (a fund is drained to accomplice
// accounts, which then withdraw). This is the inline form of
// scripts/evict-fund-payout-recipients.ts, scoped to just this account's
// funds (user:<uid>:funds, populated for any funder) rather than the script's
// full keyspace scan, so it's cheap enough to run on eviction.
//
// GRIEFING RISK, and why this is advisory by default: the trigger is
// "received money from a fund", which the *sender* chooses. Someone who
// worked out that this rule exists could pay gift-link payouts to innocent
// accounts specifically to get them auto-evicted. Whitelisted accounts are
// exempt, but that only covers ops. So this logs its verdict and does nothing
// until you opt in:
//
//   SET evict:cascade 1     (act)     DEL evict:cascade   (advisory again)
//
// Run the script by hand for the full cross-fund sweep either way; it also
// covers funds this account manages but never funded.
const cascadeFundPayouts = async (user: any, reason: string) => {
  try {
    const fundIds = [...(await db.sMembers(`user:${user.id}:funds`))].map(String);
    if (!fundIds.length) return;

    const recipients = new Map<string, Set<string>>();
    for (const fundId of fundIds) {
      const pids = (await db.lRange(`fund:${fundId}:payments`, 0, -1)) || [];
      for (const pid of pids) {
        // A payout FROM the fund, matching take()'s
        // credit({ aid: user.id, ref: id, type: "fund" }).
        const p: any = await getPayment(String(pid));
        if (!p || p.type !== "fund" || p.ref !== fundId || !(p.amount > 0)) continue;
        const uid = p.aid || p.uid;
        if (!uid || uid === user.id) continue;
        if (!recipients.has(uid)) recipients.set(uid, new Set());
        recipients.get(uid)!.add(fundId);
      }
    }
    if (!recipients.size) return;

    const act = !!(await db.get("evict:cascade"));
    for (const [uid, funds] of recipients) {
      if (await db.sIsMember("evicted", uid)) continue;
      const recipient = await getUser(uid);
      if (!recipient) continue;
      const name = recipient.username?.toLowerCase?.().trim();
      if (name && (await db.sIsMember("whitelist", name))) continue;
      // Check the username too: entries predating evictAccount's dual write,
      // and anything an admin added by hand, are username-only. Without this
      // an already-evicted account gets re-evicted on every pass — harmless
      // but it re-logs AUTO_EVICT and re-runs disableFoundedFunds each time.
      if (name && (await db.sIsMember("evicted", name))) continue;

      const why = `paid from fund(s) ${[...funds].join(",")} of evicted ${user.username} (${reason})`;
      if (act) await evictAccount(recipient, why);
      else console.error(`EVICT_CANDIDATE ${recipient.username} ${why}`);
    }
  } catch (e: any) {
    console.error("cascadeFundPayouts failed", user?.id, e.message);
  }
};

export const evictUser = async (user: any, reason: string, ip?: string) => {
  await evictAccount(user, reason, ip);
  void cascadeFundPayouts(user, reason);
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
    const method = c.req.method;

    // Read-only tokens (users.ro) carry "<uid>-ro" and are upgraded to the
    // full uid only on the routes a POS terminal actually needs. lib/sockets.ts
    // mirrors this for websockets, with the intent stated there: a POS device
    // "can log in and receive payment events, but nothing else".
    //
    // Match the RESOLVED ROUTE PATTERN, not a url prefix. `startsWith("/invoice")`
    // also matched POST /invoice/:id -> invoices.update, whose webhook+secret
    // branch is gated on `invoice.uid === c.get("user")?.id` — exactly the check
    // this upgrade satisfies. A read-only token could therefore rewrite the
    // webhook destination and secret on the merchant's own invoices, pointing
    // payment notifications (address, amount, hash, memo, and the shared secret)
    // at a url of its choosing and silently cutting off the real integration.
    // That token is flashed into POS printer firmware and lives on a device in a
    // shop, so treating it as read-only is the whole point of issuing it.
    //
    // POST /invoice stays: invoices.create takes `optional` auth, and without the
    // upgrade the invoice is raised anonymously instead of under the merchant.
    // Tip updates on /invoice/:id keep working for everyone — that branch
    // deliberately requires no ownership, so the POS is unaffected.
    const wl = {
      GET: ["/invoices", "/payments", "/payments/:hash"],
      POST: ["/invoice"],
    };
    // Captured BEFORE the strip below: on an allowlisted route the suffix is
    // removed, after which a read-only token is indistinguishable from a full
    // one — and the watermark check further down would then revoke the POS
    // tokens it is meant to spare.
    const readonly = id.endsWith("-ro");
    if (readonly && wl[method]?.includes(c.req.routePath)) id = id.slice(0, -3);

    // A password change ends every session that predates it. Tokens carry no
    // exp, there is no logout endpoint and no server-side session store, so
    // without this the standard remediation for a leaked token — change your
    // password — achieved nothing: the attacker's token stayed valid for ever.
    // `reset()` made it worse, since it also clears the pin, removing the gate
    // on sending from an account it was called to secure.
    //
    // `iat` is already on every token (jsonwebtoken adds it), so this needs no
    // change to what we issue. Strictly-less-than, so a token minted in the
    // same second as the change survives — the acting session keeps working.
    //
    // Read-only POS tokens are deliberately exempt: they are flashed into
    // printer firmware and cannot refresh themselves, so a routine password
    // rotation would silently stop a shop's receipts until someone reflashed
    // every device. Revoking those is what eviction is for.
    if (!readonly) {
      const since = await db.get(`tokens:since:${id}`);
      if (since && ((payload as any).iat ?? 0) < Number(since)) return null;
    }

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

// The `admin` middleware was removed with its only two consumers, POST
// /hidepay and POST /unlimit. The remaining admin-gated paths (reset(),
// sanitizeImages()) compare config.adminpass inside the handler instead.

// The pin is a credential, so it is stored as a digest, never compared with
// `!==`, and checked in one place rather than three.
//
// lib/migrate.ts's hashPins() hashed every pin once and set `pins:hashed` so
// it can never run again — but nothing hashed on WRITE, so every pin set since
// went back into redis as six plaintext digits. The property that migration
// existed for lapsed the moment it finished.
//
// It also left the accounts it migrated unable to use their pin at all: their
// stored value became a 64-char digest while the client kept sending six
// digits, so requirePin() failed for ever, and requirePin() gates sending.
// Hashing the supplied value repairs those accounts as a side effect —
// sha256(their pin) is exactly what is stored.
export const hashPin = (v: string) =>
  new Bun.CryptoHasher("sha256").update(v).digest("hex");

const constantEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x as any, y as any);
};

export const pinMatches = (user: any, supplied: unknown): boolean => {
  const stored = user?.pin;
  if (!stored) return true; // no pin set — nothing to satisfy
  if (typeof supplied !== "string" || !supplied) return false;

  // A stored digest accepts the hash of what was typed. It also accepts the
  // digest itself, because update() has always allowed a client to send a
  // 64-char value directly and some may.
  if (stored.length === 64)
    return constantEqual(hashPin(supplied), stored) || constantEqual(supplied, stored);

  // Legacy plaintext, from any pin set between the migration and this change.
  return constantEqual(supplied, stored);
};

export const requirePin = async ({ body, user }) => {
  if (!user || !pinMatches(user, body?.pin)) fail("Invalid pin");
};
