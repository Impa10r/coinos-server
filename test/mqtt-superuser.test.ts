import { describe, expect, test } from "bun:test";
import users from "$routes/users";

// POST /superuser is unauthenticated — the MQTT broker calls it. It read
// config.mqtt2.username, and config.mqtt2 is not set on this deployment, so
// every call threw a TypeError and escaped to app.onError as an unhandled
// server fault. It has to refuse explicitly instead: what a broker does with a
// 500 from its authorization backend is the broker's business.

const ctx = (body: any) => {
  let status = 200;
  return {
    req: { json: async () => body },
    json: (payload: any, s?: number) => ({ payload, status: s ?? status }),
    code: (s: number) => ((status = s), ctx(body)),
  } as any;
};

describe("POST /superuser with no configured superuser", () => {
  test("refuses rather than throwing", async () => {
    const res = await users.superuser(ctx({ username: "anyone" }));
    expect(res).toBeTruthy();
    expect(res.status).toBe(500); // bail()'s shape — a refusal, not an unhandled throw
    expect(res.payload).toBe("unauthorized");
  });

  test("refuses an undefined username too", async () => {
    // The old code compared `undefined === config.mqtt2.username`; with no
    // superuser configured, nothing may match — least of all a missing field.
    const res = await users.superuser(ctx({}));
    expect(res.payload).toBe("unauthorized");
  });
});
