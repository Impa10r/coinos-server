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

    // Hard eviction: an account in the `evicted` set cannot authenticate AT ALL
    // — every request, every endpoint — regardless of source IP/VPN. Unlike the
    // `blacklist` freeze (which only blocks sends), this kills the value of a
    // compromised/attacker JWT outright. Match on the immutable uid OR username
    // so a rename can't shake it.
    if (
      user &&
      ((await db.sIsMember("evicted", user.id)) ||
        (await db.sIsMember("evicted", user.username?.toLowerCase?.().trim())))
    )
      return null;

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
