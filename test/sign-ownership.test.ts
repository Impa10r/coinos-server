import { beforeEach, describe, expect, test } from "bun:test";
import invoices from "$routes/invoices";

// POST /sign has the hot wallet sign a message under an address the caller
// names. Users hold no per-user keys in this custodial design — every address
// belongs to the server wallet — so with no ownership check any authenticated
// account could produce a signature under another user's deposit address, a
// change address, or a cold-storage address published as ours. Proof of
// control over coins the signer does not control.

const MINE = "11111111-1111-1111-1111-111111111111";
const THEIRS = "22222222-2222-2222-2222-222222222222";

const kv = () => (globalThis as any).__testStore.kvStore;

const ctx = (user: any, body: any) =>
  ({
    req: { json: async () => body },
    get: () => user,
    json: (payload: any, status?: number) => ({ payload, status: status ?? 200 }),
  }) as any;

const invoiceFor = (address: string, uid: string) => {
  kv()[`invoice:${address}`] = JSON.stringify({ id: address, hash: address, uid, aid: uid });
};

describe("POST /sign only signs under an address the caller owns", () => {
  beforeEach(() => {
    for (const k of Object.keys(kv())) delete kv()[k];
  });

  test("refuses another user's address", async () => {
    invoiceFor("bc1qvictim", THEIRS);
    const res = await invoices.sign(
      ctx({ id: MINE }, { address: "bc1qvictim", message: "I control this" }),
    );
    expect(res.payload).toBe("unauthorized");
  });

  test("refuses an address with no invoice — a change or cold address", async () => {
    const res = await invoices.sign(
      ctx({ id: MINE }, { address: "bc1qchange", message: "I control this" }),
    );
    expect(res.payload).toBe("unauthorized");
  });

  test("refuses an unauthenticated caller", async () => {
    invoiceFor("bc1qmine", MINE);
    const res = await invoices.sign(
      ctx(undefined, { address: "bc1qmine", message: "hi" }),
    );
    expect(res.payload).toBe("unauthorized");
  });

  test("gets past the ownership check for the caller's own address", async () => {
    invoiceFor("bc1qmine", MINE);
    const res = await invoices.sign(ctx({ id: MINE }, { address: "bc1qmine", message: "hi" }));
    // The rpc client is a stub in tests, so this proceeds to signMessage and
    // returns whatever that yields; the assertion is only that it was not
    // stopped by the ownership gate.
    expect(res.payload).not.toBe("unauthorized");
  });

  test("an account matching on aid rather than uid is allowed", async () => {
    kv()["invoice:bc1qsub"] = JSON.stringify({ id: "bc1qsub", hash: "bc1qsub", uid: THEIRS, aid: MINE });
    const res = await invoices.sign(ctx({ id: MINE }, { address: "bc1qsub", message: "hi" }));
    expect(res.payload).not.toBe("unauthorized");
  });
});
