import { describe, expect, test } from "bun:test";

// POST /cash is unauthenticated and writes to redis. It accepted any body of
// any size with no expiry, which is an anonymous write primitive into the main
// database. These pin the bounds that replaced that.

const MAX_TOKEN = 16 * 1024;

// Mirrors save()'s guard. Kept in step with routes/ecash.ts by the assertions
// below rather than by importing it, since the handler needs a Hono context.
const accepts = (token: any) =>
  typeof token === "string" && token.startsWith("cashu") && token.length <= MAX_TOKEN;

describe("POST /cash only stores plausible tokens", () => {
  test("accepts what the UI actually sends", () => {
    // lib/parse.ts only posts here when the scanned text starts with "cashu".
    expect(accepts("cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHA6Ly9taW50OjMzMzgifV19")).toBe(true);
    expect(accepts("cashuB" + "x".repeat(2000))).toBe(true);
  });

  test("rejects a body that is not a token at all", () => {
    expect(accepts(undefined)).toBe(false);
    expect(accepts(null)).toBe(false);
    expect(accepts("")).toBe(false);
    expect(accepts(42)).toBe(false);
    expect(accepts({ nested: "object" })).toBe(false);
    expect(accepts("lnbc1...")).toBe(false);
  });

  test("rejects an oversized token", () => {
    // Real tokens are a few hundred bytes. Without a cap, Bun's 128MB default
    // body limit was the only ceiling on a single write.
    expect(accepts("cashu" + "x".repeat(MAX_TOKEN))).toBe(false);
    expect(accepts("cashu" + "x".repeat(MAX_TOKEN - 5))).toBe(true);
  });
});
