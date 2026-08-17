process.env.INTEGRATION = "1";

import { describe, test, expect, beforeAll } from "bun:test";

// =====================================================================
// Helpers (mirrors test/integration/bolt12.test.ts conventions)
// =====================================================================

const APP = "http://localhost:3119";

const exec = async (cmd: string): Promise<string> => {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`exec failed (${code}): ${stderr || stdout}`);
  }
  return stdout.trim();
};

const clExec = async (container: string, ...args: string[]): Promise<any> => {
  const escaped = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const result = await exec(`docker exec ${container} lightning-cli ${escaped}`);
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
};

const waitFor = async <T>(fn: () => Promise<T>, timeout = 30000): Promise<T> => {
  const start = Date.now();
  let lastError: any;
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await Bun.sleep(500);
  }
  throw new Error(`waitFor timed out: ${lastError?.message || "no result"}`);
};

const register = async (username: string, password: string): Promise<any> => {
  const res = await fetch(`${APP}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: { username, password } }),
  });
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`);
  return res.json() as any;
};

const api = async (path: string, token: string, opts: any = {}): Promise<any> => {
  const res = await fetch(`${APP}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    ...opts,
  });
  return res.json() as any;
};

const getMe = (token: string) => api("/me", token);
const getPayments = (token: string) => api("/payments", token);
const createInvoice = (token: string, invoice: any) =>
  api("/invoice", token, { method: "POST", body: JSON.stringify({ invoice }) });
const updateUser = (token: string, settings: any) =>
  api("/user", token, { method: "POST", body: JSON.stringify(settings) });
const authorize = (token: string, body: any) =>
  api("/authorize", token, { method: "POST", body: JSON.stringify(body) });
const take = (token: string, body: any) =>
  api("/take", token, { method: "POST", body: JSON.stringify(body) });
const getOffer = (token: string) => api("/offer", token);
const getRates = async (): Promise<any> => (await fetch(`${APP}/rates`)).json();

const fundViaLightning = async (token: string, amount: number) => {
  const inv = await createInvoice(token, { amount, type: "lightning" });
  await clExec("clb", "pay", inv.hash);
  return waitFor(async () => {
    const me = await getMe(token);
    return me.balance >= amount ? me : null;
  });
};

// =====================================================================
// Setup
// =====================================================================

const ts = Date.now();

beforeAll(async () => {
  try {
    await exec("docker exec cl lightning-cli getinfo");
    await exec("docker exec clb lightning-cli getinfo");
  } catch {
    throw new Error("Lightning containers not running. Start with: docker compose up -d cl clb");
  }
}, 30000);

// =====================================================================
// Lightning send: pending -> confirmed lifecycle
// =====================================================================

describe("lightning send status lifecycle", () => {
  test("payment record starts unconfirmed and flips to confirmed once the HTLC settles", async () => {
    const funderName = `pendtest${ts}`;
    const funder = await register(funderName, "testpass123");
    const funderToken = funder.token;

    await fundViaLightning(funderToken, 200_000);

    // An invoice on clb that our node will pay into — clb is a real external
    // node, so the payment takes a real round trip and isn't already settled
    // by the time the HTTP response comes back.
    const clbInvoice = await clExec(
      "clb",
      "invoice",
      "50000sat",
      `pendtest-${ts}`,
      "integration pending-status test",
    );
    expect(clbInvoice.bolt11).toBeTruthy();

    const sendRes = await api("/payments", funderToken, {
      method: "POST",
      body: JSON.stringify({ payreq: clbInvoice.bolt11 }),
    });
    expect(sendRes.id).toBeTruthy();
    expect(sendRes.type).toBe("lightning");

    // sendLightning is fire-and-forget: the HTTP response returns the
    // optimistic debit before the HTLC has had a chance to settle, so this
    // must observe confirmed:false at the moment of response.
    expect(sendRes.confirmed).toBe(false);
    expect(sendRes.ref).toBeFalsy();

    // Poll until finalize() has run and flipped it.
    const settled = await waitFor(async () => {
      const { payments } = await getPayments(funderToken);
      const p = payments?.find((x: any) => x.id === sendRes.id);
      return p?.confirmed ? p : null;
    }, 20000);

    expect(settled.confirmed).toBe(true);
    expect(settled.ref).toBeTruthy(); // preimage set by finalize()

    // clb should actually have received it. `invoice` doesn't echo back the
    // label, so match by payment_hash instead.
    const paidInvoice = await clExec(
      "clb",
      "listinvoices",
      "-k",
      `payment_hash=${clbInvoice.payment_hash}`,
    );
    expect(paidInvoice.invoices?.[0]?.status).toBe("paid");
  }, 30000);
});

// =====================================================================
// GET /offer — standing bolt12 offer
// =====================================================================

describe("bolt12 standing offer", () => {
  test("is created lazily and reused on subsequent calls", async () => {
    const name = `offertest${ts}`;
    const { token } = await register(name, "testpass123");

    const first = await getOffer(token);
    expect(first.hash).toMatch(/^lno1/);
    expect(first.type).toBe("bolt12");

    const second = await getOffer(token);
    expect(second.id).toBe(first.id);
    expect(second.hash).toBe(first.hash);
  }, 20000);

  test("two different users get two different offers", async () => {
    const a = await register(`offera${ts}`, "testpass123");
    const b = await register(`offerb${ts}`, "testpass123");

    const offerA = await getOffer(a.token);
    const offerB = await getOffer(b.token);

    expect(offerA.hash).not.toBe(offerB.hash);
  }, 20000);
});

// =====================================================================
// POST /take — atomic single-use authorization claim (COINOS-3)
// =====================================================================

describe("fund authorization race safety", () => {
  test("N concurrent /take calls on one authorization debit the authorizer exactly once", async () => {
    const authorizerName = `authorizer${ts}`;
    const takerName = `taker${ts}`;
    const authorizer = await register(authorizerName, "testpass123");
    const taker = await register(takerName, "testpass123");

    // Give the authorizer plenty of balance — enough to survive the bug
    // (multiple real debits) without hitting "insufficient funds" and
    // masking the vulnerability.
    await fundViaLightning(authorizer.token, 2_000_000);
    const balanceBefore = (await getMe(authorizer.token)).balance;

    const { USD } = await getRates();
    const fiat = 10; // $10 authorization
    // Mirrors the server's sats(fiat / rates[currency]) so the test knows
    // the exact per-claim amount without depending on take()'s response.
    const expectedClaimSats = Math.round((fiat / USD) * 1e8);

    const fundId = `race-fund-${ts}`;
    await authorize(authorizer.token, { id: fundId, currency: "USD", fiat });

    // Request far more than the fiat cap each time, so every successful
    // claim (buggy or not) draws exactly expectedClaimSats — isolating the
    // race to "how many times did the authorizer get debited", not "how
    // much did each racer ask for".
    const concurrency = 10;
    await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        take(taker.token, { id: fundId, amount: expectedClaimSats * 5 }),
      ),
    );

    const balanceAfter = (await getMe(authorizer.token)).balance;
    const debited = balanceBefore - balanceAfter;

    // Without the atomic SET NX claim, this reliably lands at N x
    // expectedClaimSats (was reproduced at 5x in the original disclosure).
    // With it, exactly one racer wins the claim.
    expect(debited).toBe(expectedClaimSats);
  }, 30000);
});

// =====================================================================
// migrated flag round-trips through POST /user
// =====================================================================

describe("v3 migration flag", () => {
  test("POST /user {migrated} round-trips and is visible on /me", async () => {
    const name = `migrateflag${ts}`;
    const { token } = await register(name, "testpass123");

    // register.ts stamps migrated:true on every new account by default (it
    // means "this name isn't reserved for v3", not "user moved away" — see
    // routes/lnurl.ts's registrarLookup comment). Toggle it off then back on
    // to prove POST /user actually persists the field either direction,
    // rather than assuming a particular default.
    const cleared = await updateUser(token, { migrated: false });
    expect(cleared.user.migrated).toBe(false);

    const clearedMe = await getMe(token);
    expect(clearedMe.migrated).toBe(false);

    const updated = await updateUser(token, { migrated: true });
    expect(updated.user.migrated).toBe(true);

    const after = await getMe(token);
    expect(after.migrated).toBe(true);
  }, 15000);
});
