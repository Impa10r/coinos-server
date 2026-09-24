import { describe, expect, test } from "bun:test";
import { Refusal, bail, fail } from "$lib/utils";

// bail() used to answer 500 for everything, so a deliberate refusal was
// indistinguishable from a server fault — in the logs and to the caller.
// fail() now tags the refusal and bail() reads it back off the error.
const c = { json: (payload: any, status: number) => ({ payload, status }) } as any;
const thrown = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
};

describe("bail carries a refusal's status and leaves real faults at 500", () => {
  test("fail() defaults to 400", () => {
    expect(bail(c, thrown(() => fail("nope")))).toEqual({ payload: "nope", status: 400 });
  });

  test("fail() with an explicit status keeps it", () => {
    expect(bail(c, thrown(() => fail("Unauthorized", 401)))).toEqual({
      payload: "Unauthorized",
      status: 401,
    });
    expect(bail(c, thrown(() => fail("gone", 404)))).toEqual({ payload: "gone", status: 404 });
  });

  // The point of the change: an error nobody tagged is a genuine fault.
  test("an untagged error is still a 500", () => {
    const e = thrown(() => {
      (undefined as any).x.y;
    });
    const res = bail(c, e);
    expect(res.status).toBe(500);
  });

  test("an inline string refusal is a 400, not a 500", () => {
    expect(bail(c, "url required")).toEqual({ payload: "url required", status: 400 });
  });

  test("an explicit status argument overrides", () => {
    expect(bail(c, "teapot", 418).status).toBe(418);
  });

  test("a Refusal is still an Error, so existing catch blocks are unaffected", () => {
    const e = thrown(() => fail("x"));
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(Refusal);
  });
});
