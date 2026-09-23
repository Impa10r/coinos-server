import { describe, expect, test } from "bun:test";
import { redactBody } from "$lib/app";

// The request logger writes every non-GET body. Redaction only handled
// top-level keys, and POST /signup posts {user:{password}} — one level down —
// so every registration wrote its plaintext password to `req`. Confirmed
// against the running app with a marker password before this was fixed.

describe("redactBody", () => {
  test("redacts a nested password — the signup shape", () => {
    const out = redactBody({ user: { username: "alice", password: "hunter2" } });
    expect(out.user.password).toBe("[redacted]");
    expect(out.user.username).toBe("alice");
  });

  test("still redacts top-level", () => {
    expect(redactBody({ password: "hunter2" }).password).toBe("[redacted]");
  });

  test("covers pin and newpin, which were not on the list at all", () => {
    const out = redactBody({ pin: "123456", newpin: "654321" });
    expect(out.pin).toBe("[redacted]");
    expect(out.newpin).toBe("[redacted]");
  });

  test("covers key material", () => {
    const out = redactBody({ nsec: "nsec1...", seed: "abandon abandon", mnemonic: "x y z" });
    expect(out.nsec).toBe("[redacted]");
    expect(out.seed).toBe("[redacted]");
    expect(out.mnemonic).toBe("[redacted]");
  });

  test("reaches inside arrays", () => {
    const out = redactBody({ accounts: [{ seed: "s1" }, { seed: "s2" }] });
    expect(out.accounts[0].seed).toBe("[redacted]");
    expect(out.accounts[1].seed).toBe("[redacted]");
  });

  test("leaves absent and empty values alone, so the log still shows what was sent", () => {
    const out = redactBody({ pin: "", password: null, secret: undefined });
    expect(out.pin).toBe("");
    expect(out.password).toBeNull();
    expect(out.secret).toBeUndefined();
  });

  test("does not mutate the caller's object", () => {
    const body = { user: { password: "hunter2" } };
    redactBody(body);
    expect(body.user.password).toBe("hunter2");
  });

  test("terminates on a deeply nested body", () => {
    let deep: any = { password: "leaf" };
    for (let i = 0; i < 50; i++) deep = { nest: deep };
    expect(() => redactBody(deep)).not.toThrow();
  });

  test("passes non-objects through", () => {
    expect(redactBody(null)).toBeNull();
    expect(redactBody("str")).toBe("str");
  });
});
