import config from "$config";
import { db } from "$lib/db";
import { fail, getUser } from "$lib/utils";
import jwt from "jsonwebtoken";
import { getCookie } from "hono/cookie";

const extractToken = (c) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return getCookie(c, "token") || null;
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
    // Distinctive, greppable line carrying the real source IP so the realtime
    // auto-banner (scripts/atk-autoban.sh) can insta-ban it at Cloudflare.
    console.error(`EVICTED_AUTH ${user.username} ${c.req.header("cf-connecting-ip")}`);
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
