import { describe, expect, it } from "bun:test";
import { isReserved } from "$lib/reserved";

describe("reserved usernames", () => {
  it("reserves names that carry authority", () => {
    // routes/ecash.ts melt() authorizes on username === "mint", and
    // routes/payments.ts / lib/nwc.ts special-case it in the send path.
    expect(isReserved("mint")).toBe(true);
    expect(isReserved("ecash")).toBe(true);
    expect(isReserved("admin")).toBe(true);
  });

  it("normalizes case and whitespace, so the check can't be sidestepped", () => {
    expect(isReserved("MINT")).toBe(true);
    expect(isReserved("Mint")).toBe(true);
    expect(isReserved(" m i n t ")).toBe(true);
  });

  it("does not reserve lookalikes", () => {
    // The attacker in the logs held these; they're not privileged, so they
    // stay usable — only the exact names are blocked.
    expect(isReserved("min")).toBe(false);
    expect(isReserved("mintundefind")).toBe(false);
    expect(isReserved("victim")).toBe(false);
    expect(isReserved("minty")).toBe(false);
  });

  it("handles missing input", () => {
    expect(isReserved(undefined)).toBe(false);
    expect(isReserved("")).toBe(false);
  });
});
