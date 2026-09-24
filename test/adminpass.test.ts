import { describe, expect, test } from "bun:test";
import { adminpassMatches } from "$lib/auth";

// config.adminpass is a MASTER credential — routes/users.ts login() accepts it
// as the password for any account. It was compared with `===` at three
// unauthenticated endpoints (/email, /freeze, /admin/sanitize-images), each of
// which answered differently on a hit, making every one an online oracle.
// preload.ts sets it to "test".
describe("adminpassMatches", () => {
  test("accepts the configured value", () => {
    expect(adminpassMatches("test")).toBe(true);
  });

  test("rejects a wrong value of the same length", () => {
    expect(adminpassMatches("tes_")).toBe(false);
  });

  test("rejects a correct prefix — no short-circuit on the first bytes", () => {
    expect(adminpassMatches("tes")).toBe(false);
    expect(adminpassMatches("te")).toBe(false);
    expect(adminpassMatches("t")).toBe(false);
  });

  test("rejects a value that merely extends the configured one", () => {
    expect(adminpassMatches("testx")).toBe(false);
  });

  // The failure mode the old `!!config.adminpass && x === config.adminpass`
  // guard existed to prevent: an omitted field coinciding with an unset config
  // value. Kept as an explicit test so a refactor cannot reintroduce it.
  test("fails closed on anything that is not a non-empty string", () => {
    for (const v of [undefined, null, "", 0, false, {}, [], NaN])
      expect(adminpassMatches(v as any)).toBe(false);
  });
});
