import { beforeEach, describe, expect, test } from "bun:test";
import { emit } from "$lib/sockets";
import users from "$routes/users";

// lib/sockets.ts keys store.sockets by the JWT's `id` claim, and every
// jwt.sign in routes/users.ts signs `{ id: user.id }` — so an emit addressed
// to a username lands on a bucket that is never populated and reaches nobody.
// The 2FA handlers were the only three call sites doing that, so a client
// never saw its own 2FA state change until it reloaded.

const ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USERNAME = "someone";

const ctx = (user: any, body: any = {}) =>
  ({
    req: { json: async () => body },
    get: () => user,
    json: (payload: any, status?: number) => ({ payload, status: status ?? 200 }),
    code: (s: number) => ({ send: (m: any) => ({ payload: m, status: s }) }),
  }) as any;

const user = () => ({
  id: ID,
  username: USERNAME,
  twofa: false,
  otpsecret: "TOTPSECRET",
  currency: "USD",
});

describe("2FA state changes reach the client's socket", () => {
  beforeEach(() => (emit as any).mockClear());

  test("disable2fa emits on the user id, not the username", async () => {
    await users.disable2fa(ctx(user(), { token: "000000" }));

    expect(emit).toHaveBeenCalled();
    const keys = (emit as any).mock.calls.map((c: any[]) => c[0]);
    expect(keys).toContain(ID);
    expect(keys).not.toContain(USERNAME);
  });

  test("disable2fa does not push the TOTP secret over the socket", async () => {
    await users.disable2fa(ctx(user(), { token: "000000" }));

    const types = (emit as any).mock.calls.map((c: any[]) => c[1]);
    expect(types).not.toContain("otpsecret");
    // and the secret must not appear in any payload
    const payloads = JSON.stringify((emit as any).mock.calls);
    expect(payloads).not.toContain("TOTPSECRET");
  });

  test("a user with 2FA on still needs a valid token to disable it", async () => {
    const res = await users.disable2fa(ctx({ ...user(), twofa: true }, { token: "000000" }));
    expect(res.status).toBe(401);
    expect(emit).not.toHaveBeenCalled();
  });
});
