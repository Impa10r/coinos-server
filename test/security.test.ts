// Regression tests for the 2026-08 security-disclosure fixes.
//
// Runs against the live regtest stack (the app on :3119 and the redis `db`).
// Because redis isn't port-mapped to the host, run this INSIDE the app
// container so `redis://db` resolves and `localhost:3119` is the app:
//
//   docker exec app sh -c 'cd /home/bun/app && bun test test/security.test.ts'
//
// Override endpoints with TEST_API / TEST_REDIS if needed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import { createClient } from "redis";

const API = process.env.TEST_API || "http://localhost:3119";
const REDIS = process.env.TEST_REDIS || `redis://:${process.env.DB_PASSWORD}@db`;

let db: any;
const username = `sectest${Date.now()}${Math.floor(Math.random() * 1000)}`;
const password = "correct horse battery staple";
let uid: string | null = null;
let pubkey: string | undefined;

const post = (path: string, body?: any, headers: any = {}) =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// S3 deliberately performs failed logins, and routes/users.ts counts those
// against both the username and the client IP, locking the IP with a 429 for
// 600s once it passes five. Two runs of this file is enough to trip it, after
// which S3's success case and S5 both fail with 429 and the suite looks broken
// for ten minutes. Clear the counters so the file is repeatable — otherwise
// the only fix is to wait.
const clearLoginLockouts = async () => {
  const keys = [
    `${username.toLowerCase()}:failures`,
    ...((await db.keys("ip:*:login:fail")) as string[]),
    ...((await db.keys("ip:*:login")) as string[]),
  ];
  if (keys.length) await db.del(keys);
};

beforeAll(async () => {
  db = createClient({ url: REDIS });
  // Deliberately fatal rather than skipped: this suite is the regression net
  // for the 2026-08 security disclosures, and a version that quietly no-ops
  // when it can't reach the stack would report green while covering nothing.
  // Fail, but say what to do — the bare DNS exception this replaces gave no
  // hint that the suite simply needs to run inside the app container.
  try {
    await db.connect();
  } catch (e: any) {
    throw new Error(
      // Redacted: REDIS carries DB_PASSWORD, and this string goes to stdout
      // and into whatever CI log captures it.
      `cannot reach redis at ${REDIS.replace(/\/\/[^@]*@/, "//")} (${e.message}). This suite runs against ` +
        "the live regtest stack from INSIDE the app container, where `db` " +
        "resolves:\n\n" +
        "  docker exec app sh -c 'cd /home/bun/app && bun test test/security.test.ts'\n\n" +
        "Override with TEST_API / TEST_REDIS to point somewhere else.",
    );
  }

  const reg = await post("/signup", { user: { username, password } });
  if (reg.status !== 200)
    throw new Error(`signup failed: ${reg.status} ${await reg.text()}`);

  uid = await db.get(`user:${username.toLowerCase()}`);
  if (uid) {
    const rec = JSON.parse(await db.get(`user:${uid}`));
    pubkey = rec?.pubkey;
  }
});

afterAll(async () => {
  // Best-effort cleanup of the throwaway user's keys.
  if (uid) {
    const keys = [
      `user:${uid}`,
      `user:${username.toLowerCase()}`,
      `balance:${uid}`,
      `account:${uid}`,
      `${uid}:accounts`,
      `${uid}:apps`,
    ];
    if (pubkey)
      keys.push(
        `user:${pubkey}`,
        `${pubkey}:follows:n`,
        `${pubkey}:followers:n`,
        `${pubkey}:pubkeys`,
      );
    try {
      await db.del(keys);
    } catch {}
  }
  await db.quit();
});

beforeEach(clearLoginLockouts);

describe("S1 — websocket auth verifies the JWT signature", () => {
  const secret = "s1-test-secret";

  test("jwt.verify accepts a properly signed token", () => {
    const token = jwt.sign({ id: "u1" }, secret);
    expect((jwt.verify(token, secret) as any).id).toBe("u1");
  });

  test("jwt.verify rejects an alg:none forgery that jwt.decode would trust", () => {
    const forged = jwt.sign({ id: "victim" }, "", { algorithm: "none" });
    // The old code used jwt.decode() and would have trusted this uid.
    expect((jwt.decode(forged) as any).id).toBe("victim");
    expect(() => jwt.verify(forged, secret)).toThrow();
  });

  test("jwt.verify rejects a token signed with the wrong key", () => {
    const forged = jwt.sign({ id: "victim" }, "attacker-key");
    expect(() => jwt.verify(forged, secret)).toThrow();
  });
});

describe("S2 — passwords hashed at bcrypt cost 12", () => {
  test("a freshly registered account is stored at cost 12", async () => {
    expect(uid).toBeTruthy();
    const rec = JSON.parse(await db.get(`user:${uid}`));
    expect(rec.password.startsWith("$2b$12$")).toBe(true);
  });

  test("legacy cost-4 hashes are detected for transparent upgrade", async () => {
    const legacy = await Bun.password.hash("x", { algorithm: "bcrypt", cost: 4 });
    const modern = await Bun.password.hash("x", { algorithm: "bcrypt", cost: 12 });
    const costOf = (h: string) =>
      Number.parseInt(h.match(/^\$2[aby]\$(\d{2})\$/)?.[1] ?? "0", 10);
    expect(costOf(legacy)).toBe(4);
    expect(costOf(modern)).toBe(12);
    expect(costOf(legacy) < 12).toBe(true);
    // A legacy hash must still verify (so the upgrade is transparent).
    expect(await Bun.password.verify("x", legacy)).toBe(true);
  });
});

describe("S3 — adminpass login fails closed", () => {
  // A rejected login sleeps 5s before answering, on purpose — the
  // anti-bruteforce penalty in routes/users.ts login(). That is exactly bun's
  // default per-test timeout, so these two were racing the server's own delay
  // and timing out on a 401 that was on its way. Give them room for it.
  const REJECT_DELAY = 15000;

  test("a login with an omitted password never authenticates", async () => {
    const r = await post("/login", { username });
    expect(r.status).toBe(401);
  }, REJECT_DELAY);

  test("a login with the wrong password is rejected", async () => {
    const r = await post("/login", { username, password: "not the password" });
    expect(r.status).toBe(401);
  }, REJECT_DELAY);

  test("the real password still logs in (fix didn't break auth)", async () => {
    const r = await post("/login", { username, password });
    expect(r.status).toBe(200);
    const { token } = await r.json();
    expect(typeof token).toBe("string");
  });
});

describe("S5 — session cookie carries httpOnly/secure/sameSite", () => {
  test("Set-Cookie on login has the hardening flags", async () => {
    const r = await post("/login", { username, password });
    expect(r.status).toBe(200);
    const cookie = (r.headers.get("set-cookie") || "").toLowerCase();
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("secure");
    expect(cookie).toContain("samesite");
  });
});

describe("S6 — NWC dedup claim is atomic (SET NX)", () => {
  test("two concurrent claims of one event id yield exactly one winner", async () => {
    const key = `test:nwcdedup:${Date.now()}:${Math.random()}`;
    const [a, b] = await Promise.all([
      db.set(key, "1", { NX: true, EX: 30 }),
      db.set(key, "1", { NX: true, EX: 30 }),
    ]);
    const winners = [a, b].filter((x) => x === "OK").length;
    expect(winners).toBe(1);
    await db.del(key);
  });
});

describe("S7 — /upload/:type requires auth", () => {
  // Bare POST (no JSON content-type): the auth preValidation runs before the
  // handler, so an unauthenticated upload is rejected with 401. (Sending a JSON
  // content-type here would 400 in the body parser first — a different reject
  // path that doesn't exercise the auth gate.)
  test("POST /upload/banner without a token is rejected", async () => {
    const r = await fetch(`${API}/upload/banner`, { method: "POST" });
    expect(r.status).toBe(401);
  });
  test("POST /upload/photo without a token is rejected", async () => {
    const r = await fetch(`${API}/upload/photo`, { method: "POST" });
    expect(r.status).toBe(401);
  });
});

describe("fnd-003/004 — oversized memo is truncated, not fatal", () => {
  // Mirrors the credit() choke point: memo.length > 5000 => slice, never throw.
  const cap = (memo: string) =>
    memo && memo.length > 5000 ? memo.slice(0, 5000) : memo;

  test("a 6000-char memo is clipped to 5000", () => {
    expect(cap("A".repeat(6000)).length).toBe(5000);
  });
  test("a normal memo is untouched", () => {
    expect(cap("thanks!")).toBe("thanks!");
  });
});

describe("fnd-006 — deleteSelf guard sums every account", () => {
  test("funds in a sub-account count toward the guard", async () => {
    const base = `test:acct:${Date.now()}:${Math.floor(Math.random() * 1000)}`;
    const sub = `${base}:sub`;
    await db.rPush(`${base}:accounts`, base);
    await db.rPush(`${base}:accounts`, sub);
    await db.set(`balance:${base}`, "500"); // dust in main
    await db.set(`balance:${sub}`, "5000000"); // savings in sub

    // Same summation the guard now performs.
    const aids = await db.lRange(`${base}:accounts`, 0, -1);
    let total = 0;
    for (const aid of aids) {
      total += Number(await db.get(`balance:${aid}`)) || 0;
      total += Number(await db.get(`pending:${aid}`)) || 0;
    }

    expect(total).toBe(5000500);
    expect(total > 10000).toBe(true); // => deletion refused

    await db.del(`${base}:accounts`, `balance:${base}`, `balance:${sub}`);
  });
});

describe("S8 / fnd-007 — the spend/cash mutex serializes critical sections", () => {
  test("no two sections run concurrently and FIFO order holds", async () => {
    // Same shape as withBudgetLock (nwc.ts) and withCashLock (ecash.ts).
    let lock: Promise<void> = Promise.resolve();
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      const prev = lock;
      let release: () => void = () => {};
      lock = new Promise((res) => {
        release = res;
      });
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    };

    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const job = (n: number) =>
      withLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        order.push(n);
        active--;
      });

    await Promise.all([job(1), job(2), job(3)]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("ro-token — the read-only POS token cannot write merchant config", () => {
  // users.ro issues `{ id: "<uid>-ro" }`, and lib/auth.ts upgrades it to the
  // full uid on an allowlist of routes. That allowlist used to prefix-match the
  // url, so `POST "/invoice"` also matched POST /invoice/:id -> invoices.update,
  // whose webhook+secret branch checks only `invoice.uid === c.get("user")?.id`
  // — which the upgrade satisfies. The token is flashed into POS printer
  // firmware, so a device pulled off a shop counter could repoint the
  // merchant's payment notifications. Matching the resolved route pattern
  // instead closes it without touching what a POS legitimately does.
  let A: any, RO: any, meId: string, invId: string;

  beforeAll(async () => {
    const u = `rosec${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const reg = await post("/signup", { user: { username: u, password } });
    const { token } = await reg.json();
    A = { authorization: `Bearer ${token}` };
    meId = (await (await fetch(`${API}/me`, { headers: A })).json()).id;
    const ro = await (await fetch(`${API}/ro`, { headers: A })).json();
    RO = { authorization: `Bearer ${ro}` };
    invId = (await (await post("/invoice", { invoice: { amount: 500, type: "lightning" } }, RO)).json()).id;
  });

  test("a POS invoice is still raised under the merchant, not anonymously", () => {
    expect(invId).toBeTruthy();
  });

  test("the read-only token still reads payments and invoices", async () => {
    expect((await fetch(`${API}/payments`, { headers: RO })).status).toBe(200);
    expect((await fetch(`${API}/invoices`, { headers: RO })).status).toBe(200);
  });

  test("a tip may still be set — that branch requires no ownership by design", async () => {
    const r = await post(`/invoice/${invId}`, { invoice: { tip: 120 } }, RO);
    expect(r.status).toBe(200);
    expect((await r.json()).tip).toBe(120);
  });

  test("the read-only token cannot repoint the webhook", async () => {
    const r = await post(`/invoice/${invId}`, { invoice: { webhook: "https://attacker.example/h", secret: "s" } }, RO);
    expect(r.status).not.toBe(200);
    const inv = await (await fetch(`${API}/invoice/${invId}`)).json();
    expect(inv.webhook).not.toBe("https://attacker.example/h");
  });

  test("the owner's full token still can", async () => {
    const r = await post(`/invoice/${invId}`, { invoice: { webhook: "https://merchant.example/h", secret: "s" } }, A);
    expect(r.status).toBe(200);
    expect((await r.json()).webhook).toBe("https://merchant.example/h");
  });
});
