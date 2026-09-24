import { beforeEach, describe, expect, test } from "bun:test";
import users from "$routes/users";

// A fail() inside an unguarded handler escaped to app.onError, so an intended
// refusal reached the caller as a bare {ok:false} 500 and was logged as a
// server fault. These two are the handlers where that was reachable.

const OWNER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OTHER = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const kv = () => (globalThis as any).__testStore.kvStore;
const lists = () => (globalThis as any).__testStore.listStore;

const ctx = (user: any, params: any = {}, body: any = {}) =>
  ({
    req: { json: async () => body, param: (k: string) => params[k] },
    get: () => user,
    json: (payload: any, status?: number) => ({ payload, status: status ?? 200 }),
  }) as any;

describe("handlers return their refusal instead of throwing", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
    for (const k of Object.keys(lists())) delete lists()[k];
  });

  test("GET /app/:pubkey refuses someone else's connection", async () => {
    kv()["app:somepubkey"] = JSON.stringify({ uid: OTHER, pubkey: "somepubkey" });

    const res = await users.app(
      ctx({ id: OWNER, username: "owner" }, { pubkey: "somepubkey" }),
    );

    // bail()'s shape — a refusal carrying its reason, not a bare {ok:false}.
    // 401, not 500: fail() now tags a refusal with its status and bail() keeps
    // it, so a 500 means an actual server fault again.
    expect(res.status).toBe(401);
    expect(res.payload).toBe("unauthorized");
  });

  test("GET /app/:pubkey still 404s a missing connection", async () => {
    const res = await users.app(
      ctx({ id: OWNER, username: "owner" }, { pubkey: "nope" }),
    );
    expect(res.status).toBe(404);
  });

  test("POST /account/:id refuses an account the caller does not own", async () => {
    lists()[`${OWNER}:accounts`] = [OWNER];

    const res = await users.updateAccount(
      ctx({ id: OWNER }, { id: "someone-elses-account" }, { name: "renamed" }),
    );

    expect(res.payload).toBe("account not found");
  });
});
