import { describe, test, expect, beforeEach } from "bun:test";

// Mocks are loaded via test/preload.ts (bunfig.toml [test].preload)
// Access the mock functions we need for assertions
import { tbCredit } from "$lib/tb";
import { warn } from "$lib/logging";
import { callWebhook } from "$lib/webhooks";
import ln from "$lib/ln";

const mockTbCredit = tbCredit as any;
const mockWarn = warn as any;
const mockCallWebhook = callWebhook as any;
const mockLnXpay = ln.xpay as any;
const mockLnFetchinvoice = ln.fetchinvoice as any;
const mockLnDecode = ln.decode as any;
const mockLnGetroutes = ln.getroutes as any;

import { completePayment } from "$lib/payments";

// =====================================================================
// Helpers
// =====================================================================

const store = () => globalThis.__testStore;

const custodialUid = "custodial-uid";
const arkAccountId = "ark-account-123";
const bolt11 = "lnbcrt10u1pntestqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

const makeUser = (overrides = {}) => ({
  id: custodialUid,
  username: "testuser",
  currency: "USD",
  language: "en",
  autowithdraw: false,
  threshold: 0,
  reserve: 0,
  destination: "",
  ...overrides,
});

const makeInvoice = (overrides: any = {}) => ({
  id: "inv-001",
  uid: custodialUid,
  aid: custodialUid,
  type: "ark",
  currency: "USD",
  amount: 1000,
  received: 0,
  pending: 0,
  rate: 50000,
  forward: null as string | null,
  forwarded: false,
  hash: "inv-hash-001",
  memo: "",
  tip: null,
  webhook: null,
  secret: null,
  ...overrides,
});

const seedUser = (user: any) => {
  store().kvStore[`user:${user.username}`] = JSON.stringify(user);
  store().kvStore[`user:${user.id}`] = JSON.stringify(user);
};

const resetAll = () => {
  const s = store();
  for (const k of Object.keys(s.kvStore)) delete s.kvStore[k];
  for (const k of Object.keys(s.listStore)) delete s.listStore[k];
  for (const k of Object.keys(s.setStore)) delete s.setStore[k];

  mockTbCredit.mockClear();
  mockWarn.mockClear();
  mockCallWebhook.mockClear();
  mockLnXpay.mockClear();
  mockLnFetchinvoice.mockClear();
  mockLnDecode.mockClear();
  mockLnGetroutes.mockClear();

  mockLnGetroutes.mockImplementation(async () => ({ routes: [] }));

  mockLnXpay.mockImplementation(async () => ({
    amount_sent_msat: 1_000_000,
    payment_preimage: "preimage-abc123",
  }));

  mockLnDecode.mockImplementation(async () => ({
    type: "bolt11",
    amount_msat: 1_000_000,
    payee: "test-payee",
  }));

  // Seed rates and limits
  s.kvStore["rates"] = JSON.stringify({ USD: 50000, CAD: 68000 });
  s.kvStore["limit"] = JSON.stringify(100_000_000);
  s.kvStore["lightning:limit"] = JSON.stringify(100_000_000);
  s.kvStore["internal:limit"] = JSON.stringify(100_000_000);
  s.kvStore["freeze"] = JSON.stringify(false);
  s.kvStore["hardfreeze"] = JSON.stringify(false);

  seedUser(makeUser());
};

// =====================================================================
// Tests: completePayment forward logic
// =====================================================================

describe("completePayment", () => {
  beforeEach(resetAll);

  test("forwards payment and debit stays in custodial", async () => {
    const user = makeUser();
    const inv = makeInvoice({ aid: arkAccountId, forward: bolt11 });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "ark",
      uid: custodialUid,
      created: Date.now(),
    };

    await completePayment(inv, p, user);

    expect(mockLnXpay).toHaveBeenCalled();
    expect(inv.forwarded).toBe(true);
    expect(mockCallWebhook).toHaveBeenCalled();
  });

  test("forwards and debit stays in custodial when aid matches user", async () => {
    const user = makeUser();
    const inv = makeInvoice({ aid: custodialUid, forward: bolt11 });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "ark",
      uid: custodialUid,
      created: Date.now(),
    };

    await completePayment(inv, p, user);

    expect(mockLnXpay).toHaveBeenCalled();
    expect(inv.forwarded).toBe(true);
  });

  test("handles forward failure gracefully", async () => {
    const user = makeUser();
    const inv = makeInvoice({ aid: arkAccountId, forward: bolt11 });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "ark",
      uid: custodialUid,
      created: Date.now(),
    };

    mockLnXpay.mockImplementationOnce(async () => {
      throw new Error("route not found");
    });

    const w = await completePayment(inv, p, user);

    expect(w).toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
    expect(mockWarn.mock.calls.some((c: any[]) => c.includes("forward failed"))).toBe(true);
  });

  test("skips forward when already forwarded", async () => {
    const user = makeUser();
    const inv = makeInvoice({ aid: arkAccountId, forward: bolt11, forwarded: true });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "ark",
      uid: custodialUid,
      created: Date.now(),
    };

    const w = await completePayment(inv, p, user);

    expect(w).toBeUndefined();
    expect(mockLnXpay).not.toHaveBeenCalled();
  });

  test("skips forward when payment not confirmed", async () => {
    const user = makeUser();
    const inv = makeInvoice({ aid: arkAccountId, forward: bolt11 });
    const p = {
      amount: 1000,
      confirmed: false,
      type: "ark",
      uid: custodialUid,
      created: Date.now(),
    };

    const w = await completePayment(inv, p, user);

    expect(w).toBeUndefined();
    expect(mockLnXpay).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Tests: BOLT12 offer autowithdraw
// =====================================================================

const bolt12Offer = "lno1qgsqvgnwgcg35z6ee2h3yczraddm72xrfua9uve2rlrm9deu7xyfzrcgqyqs";
const bolt12Invoice = "lni1qqg86n2pddz86n2ptszien5gqp3zzqmpkv93rjd";

describe("BOLT12 autowithdraw", () => {
  beforeEach(resetAll);

  test("fetches invoice from BOLT12 offer and sends via Lightning", async () => {
    mockLnFetchinvoice.mockImplementation(async () => ({
      invoice: bolt12Invoice,
    }));

    mockLnDecode.mockImplementation(async (s: string) =>
      s.startsWith("lno")
        ? { type: "bolt12 offer", offer_issuer_id: "bolt12-payee" }
        : { type: "bolt12 invoice", invoice_amount_msat: 980_000, invoice_node_id: "bolt12-payee" },
    );

    const user = makeUser({
      autowithdraw: true,
      threshold: 500,
      reserve: 0,
      destination: bolt12Offer,
    });
    seedUser(user);

    const inv = makeInvoice({ type: "lightning", amount: 1000 });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "lightning",
      uid: custodialUid,
      created: Date.now(),
    };

    await completePayment(inv, p, user);

    // decode called first with the offer to get node id
    expect(mockLnDecode).toHaveBeenCalled();
    expect(mockLnDecode.mock.calls[0][0]).toBe(bolt12Offer);

    // getroutes called to estimate routing fee
    expect(mockLnGetroutes).toHaveBeenCalled();

    // fetchinvoice called with the offer and amount in msats
    expect(mockLnFetchinvoice).toHaveBeenCalled();
    const [offer, amountMsat] = mockLnFetchinvoice.mock.calls[0];
    expect(offer).toBe(bolt12Offer);
    expect(amountMsat).toBeGreaterThan(0);

    // xpay called with the fetched bolt12 invoice
    expect(mockLnXpay).toHaveBeenCalled();
  });

  test("forwards BOLT12 offer via invoice forward field", async () => {
    mockLnFetchinvoice.mockImplementation(async () => ({
      invoice: bolt12Invoice,
    }));

    mockLnDecode.mockImplementation(async (s: string) =>
      s.startsWith("lno")
        ? { type: "bolt12 offer", offer_issuer_id: "bolt12-payee" }
        : { type: "bolt12 invoice", invoice_amount_msat: 980_000, invoice_node_id: "bolt12-payee" },
    );

    const user = makeUser();
    const inv = makeInvoice({ forward: bolt12Offer });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "lightning",
      uid: custodialUid,
      created: Date.now(),
    };

    await completePayment(inv, p, user);

    expect(mockLnFetchinvoice).toHaveBeenCalled();
    expect(mockLnXpay).toHaveBeenCalled();
    expect(inv.forwarded).toBe(true);
  });

  test("regular ln invoice is NOT passed through fetchinvoice", async () => {
    const user = makeUser({
      autowithdraw: true,
      threshold: 500,
      reserve: 0,
      destination: bolt11,
    });
    seedUser(user);

    const inv = makeInvoice({ type: "lightning", amount: 1000 });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "lightning",
      uid: custodialUid,
      created: Date.now(),
    };

    await completePayment(inv, p, user);

    expect(mockLnFetchinvoice).not.toHaveBeenCalled();
    expect(mockLnXpay).toHaveBeenCalled();
  });

  test("accounts for routing fee from getroutes on multi-hop", async () => {
    // Mock balance is 10_000_000; autowithdraw sends balance - reserve
    const balance = 10_000_000;
    const routingFee = 50;

    mockLnDecode.mockImplementation(async (s: string) =>
      s.startsWith("lno")
        ? { type: "bolt12 offer", offer_issuer_id: "bolt12-payee" }
        : { type: "bolt12 invoice", invoice_amount_msat: null, invoice_node_id: "bolt12-payee" },
    );

    // Simulate a route with 50 sat routing fee (getroutes response format)
    mockLnGetroutes.mockImplementation(async () => ({
      routes: [
        {
          amount_msat: balance * 1000,
          path: [{ amount_msat: (balance + routingFee) * 1000 }],
        },
      ],
    }));

    mockLnFetchinvoice.mockImplementation(async () => ({
      invoice: bolt12Invoice,
    }));

    const user = makeUser({
      autowithdraw: true,
      threshold: 500,
      reserve: 0,
      destination: bolt12Offer,
    });
    seedUser(user);

    const inv = makeInvoice({ type: "lightning", amount: 1000 });
    const p = {
      amount: 1000,
      confirmed: true,
      type: "lightning",
      uid: custodialUid,
      created: Date.now(),
    };

    await completePayment(inv, p, user);

    // fetchinvoice amount should exclude routing fee and ourfee
    const [, amountMsat] = mockLnFetchinvoice.mock.calls[0];
    const ourfee = Math.round(balance * 0.001);
    expect(amountMsat).toBe((balance - routingFee - ourfee) * 1000);

    expect(mockLnXpay).toHaveBeenCalled();
  });
});
