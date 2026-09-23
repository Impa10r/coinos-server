import { describe, expect, test } from "bun:test";
import { hashPin, pinMatches, requirePin } from "$lib/auth";

// lib/migrate.ts's hashPins() hashed every pin once and set `pins:hashed` so
// it can never run again. Nothing hashed on WRITE, so every pin set since went
// back into redis as six plaintext digits — the property the migration existed
// for lapsed the moment it finished.
//
// It also stranded the accounts it migrated: their stored value became a
// 64-char digest while the client kept sending six digits, so every comparison
// failed. requirePin() gates sending, so those accounts could not send at all.

const DIGITS = "123456";
const DIGEST = hashPin(DIGITS);

describe("pinMatches", () => {
  test("a migrated account can use its pin again", () => {
    // Stored as the digest hashPins() wrote; the client still sends digits.
    expect(pinMatches({ pin: DIGEST }, DIGITS)).toBe(true);
  });

  test("the wrong pin is refused against a digest", () => {
    expect(pinMatches({ pin: DIGEST }, "654321")).toBe(false);
  });

  test("legacy plaintext still works, so nobody is locked out mid-migration", () => {
    expect(pinMatches({ pin: DIGITS }, DIGITS)).toBe(true);
    expect(pinMatches({ pin: DIGITS }, "000000")).toBe(false);
  });

  test("a client that sends the digest itself is still accepted", () => {
    // update() has always allowed a 64-char newpin, so some client may send one.
    expect(pinMatches({ pin: DIGEST }, DIGEST)).toBe(true);
  });

  test("no pin set means nothing to satisfy", () => {
    expect(pinMatches({}, undefined)).toBe(true);
    expect(pinMatches({ pin: "" }, undefined)).toBe(true);
  });

  test("a missing or non-string pin never satisfies a set one", () => {
    expect(pinMatches({ pin: DIGEST }, undefined)).toBe(false);
    expect(pinMatches({ pin: DIGEST }, "")).toBe(false);
    expect(pinMatches({ pin: DIGEST }, 123456 as any)).toBe(false);
    expect(pinMatches({ pin: DIGEST }, null as any)).toBe(false);
  });

  test("the digest is not the six digits", () => {
    expect(DIGEST).not.toBe(DIGITS);
    expect(DIGEST).toHaveLength(64);
  });
});

describe("requirePin", () => {
  test("throws on a wrong pin", async () => {
    await expect(requirePin({ body: { pin: "000000" }, user: { pin: DIGEST } })).rejects.toThrow(
      "Invalid pin",
    );
  });

  test("passes on the right one", async () => {
    expect(await requirePin({ body: { pin: DIGITS }, user: { pin: DIGEST } })).toBeUndefined();
  });

  test("throws with no user at all", async () => {
    await expect(requirePin({ body: { pin: DIGITS }, user: null })).rejects.toThrow("Invalid pin");
  });
});
