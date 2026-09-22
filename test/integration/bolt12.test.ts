process.env.INTEGRATION = "1";

import { describe, test, expect, beforeAll } from "bun:test";

// =====================================================================
// Helpers
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

const updateUser = (token: string, settings: any) =>
  api("/user", token, {
    method: "POST",
    body: JSON.stringify(settings),
  });

const getMe = (token: string) => api("/me", token);

const createInvoice = (token: string, invoice: any) =>
  api("/invoice", token, {
    method: "POST",
    body: JSON.stringify({ invoice }),
  });

const sendInternal = (token: string, username: string, amount: number) =>
  api("/send", token, {
    method: "POST",
    body: JSON.stringify({ username, amount }),
  });

const getPayments = (token: string) => api("/payments", token);

// =====================================================================
// Test state
// =====================================================================

let funderToken: string;
let withdrawerToken: string;

// =====================================================================
// Setup: register users, fund the funder via lightning
// =====================================================================

// Each pass of this suite spends real channel liquidity: test users are funded
// by having clb pay invoices into coinos. Once clb's outbound toward cl runs
// out, every test fails with CLN routing errors ("not reachable directly and
// all routehints were unusable") that read like application bugs. Top up first
// so the suite is repeatable instead of green exactly once.
const ensureLiquidity = async (minSat: number) => {
  const outbound = async (): Promise<number> => {
    const cl = await clExec("cl", "getinfo");
    const chans = await clExec("clb", "listpeerchannels");
    const c = (chans.channels || []).find((x: any) => x.peer_id === cl.id);
    return c ? Math.floor(c.to_us_msat / 1000) : 0;
  };
  if ((await outbound()) >= minSat) return;
  await exec("./scripts/regtest-setup.sh");
  const after = await outbound();
  if (after < minSat)
    throw new Error(
      `clb has ${after} sat outbound toward cl, needs ${minSat}. ` +
        "Run ./scripts/regtest-setup.sh (it mines and rebalances); if it can't " +
        "reach the target, cl's side of the channel is exhausted and the " +
        "channel needs reopening.",
    );
};

const ts = Date.now();
const funderName = `intfunder${ts}`;
const withdrawerName = `intwdraw${ts}`;

beforeAll(async () => {
  // Verify containers are running
  try {
    await exec("docker exec cl lightning-cli getinfo");
    await exec("docker exec clb lightning-cli getinfo");
    await exec("docker exec clc lightning-cli getinfo");
  } catch {
    throw new Error(
      "Lightning containers not running. Start with: docker compose up -d cl clb clc",
    );
  }

  await ensureLiquidity(1500000);

  // Register test users
  const funder = await register(funderName, "testpass123");
  funderToken = funder.token;

  const withdrawer = await register(withdrawerName, "testpass123");
  withdrawerToken = withdrawer.token;

  // Fund the funder: generate a lightning invoice and pay from clb
  const inv = await createInvoice(funderToken, {
    amount: 500_000,
    type: "lightning",
  });

  await clExec("clb", "pay", inv.hash);

  // Wait for the payment to be credited
  await waitFor(async () => {
    const me = await getMe(funderToken);
    return me.balance >= 500_000 ? me : null;
  });
}, 180000);

// =====================================================================
// Tests
// =====================================================================

describe("BOLT12 autowithdraw", () => {
  test("autowithdraw to direct peer (clb)", async () => {
    // Create a BOLT12 offer on clb
    const offer = await clExec("clb", "offer", "any", "integration-test");
    expect(offer.bolt12).toBeTruthy();

    // Get clb's initial balance
    const clbFundsBefore = await clExec("clb", "listfunds");
    const clbBalanceBefore = clbFundsBefore.channels.reduce(
      (s: number, c: any) => s + c.our_amount_msat,
      0,
    );

    // Configure withdrawer with autowithdraw to clb's offer
    await updateUser(withdrawerToken, {
      autowithdraw: "lightning",
      threshold: 1000,
      reserve: 0,
      destination: offer.bolt12,
    });

    // Send 100k sats from funder to withdrawer (triggers autowithdraw)
    const sendAmount = 100_000;
    const sendResult = await sendInternal(funderToken, withdrawerName, sendAmount);
    expect(sendResult.amount).toBe(-sendAmount);

    // Wait for autowithdraw to complete — withdrawer balance should drop near 0
    const finalMe = await waitFor(async () => {
      const me = await getMe(withdrawerToken);
      return me.balance < 1000 ? me : null;
    }, 20000);

    expect(finalMe.balance).toBeLessThan(1000);

    // clb should have received the payment
    // Poll rather than read once. The withdrawer's balance drops when coinos
    // DEBITS, which happens before the HTLC settles on the destination node —
    // so reading the destination's balance here raced the settlement and read
    // a figure from before the payment landed. The tell was clc holding the
    // PREVIOUS run's sats: they arrived after that run had already failed.
    const clbBalanceAfter = await waitFor(async () => {
      const f = await clExec("clb", "listfunds");
      const bal = f.channels.reduce((s: number, c: any) => s + c.our_amount_msat, 0);
      return bal > clbBalanceBefore ? bal : null;
    }, 20000);
    expect(clbBalanceAfter).toBeGreaterThan(clbBalanceBefore);

    // Check payment records on withdrawer
    const payments = await getPayments(withdrawerToken);
    const withdrawal = payments.payments?.find((p: any) => p.amount < 0 && p.type === "lightning");
    expect(withdrawal).toBeTruthy();
    expect(withdrawal.fee).toBeGreaterThanOrEqual(0);
  }, 30000);

  test("autowithdraw routes through clb to clc (multi-hop)", async () => {
    // Create a BOLT12 offer on clc
    const offer = await clExec("clc", "offer", "any", "multihop-test");
    expect(offer.bolt12).toBeTruthy();

    // Configure withdrawer with autowithdraw to clc's offer
    await updateUser(withdrawerToken, {
      autowithdraw: "lightning",
      threshold: 1000,
      reserve: 0,
      destination: offer.bolt12,
    });

    // Get clc's balance before
    const clcFundsBefore = await clExec("clc", "listfunds");
    const clcBalanceBefore = clcFundsBefore.channels.reduce(
      (s: number, c: any) => s + c.our_amount_msat,
      0,
    );

    // Send 50k sats from funder to withdrawer
    const sendAmount = 50_000;
    await sendInternal(funderToken, withdrawerName, sendAmount);

    // Wait for autowithdraw to complete
    const finalMe = await waitFor(async () => {
      const me = await getMe(withdrawerToken);
      return me.balance < 1000 ? me : null;
    }, 30000);

    expect(finalMe.balance).toBeLessThan(1000);

    // clc should have received the payment (routed cl→clb→clc)
    // Settlement race — see the note in the direct-peer test above.
    const clcBalanceAfter = await waitFor(async () => {
      const f = await clExec("clc", "listfunds");
      const bal = f.channels.reduce((s: number, c: any) => s + c.our_amount_msat, 0);
      return bal > clcBalanceBefore ? bal : null;
    }, 20000);
    expect(clcBalanceAfter).toBeGreaterThan(clcBalanceBefore);

    // Check payment record has routing fee
    const payments = await getPayments(withdrawerToken);
    const withdrawal = payments.payments?.find((p: any) => p.amount < 0 && p.type === "lightning");
    expect(withdrawal).toBeTruthy();
    // Multi-hop should have non-zero routing fee
    expect(withdrawal.fee).toBeGreaterThan(0);
  }, 45000);

  test("finalize() refunds unused routing budget", async () => {
    // Create offer on clb (direct peer — minimal actual routing cost)
    const offer = await clExec("clb", "offer", "any", "refund-test");

    await updateUser(withdrawerToken, {
      autowithdraw: "lightning",
      threshold: 1000,
      reserve: 0,
      destination: offer.bolt12,
    });

    // Send 20k sats
    const sendAmount = 20_000;
    await sendInternal(funderToken, withdrawerName, sendAmount);

    // Wait for autowithdraw
    await waitFor(async () => {
      const me = await getMe(withdrawerToken);
      return me.balance < 1000 ? me : null;
    }, 20000);

    // Wait for the record finalize() writes: `ref` (the preimage) and the
    // settled fee are both set after the payment lands, not when it is sent.
    const withdrawal = await waitFor(async () => {
      const payments = await getPayments(withdrawerToken);
      const p = payments.payments?.find(
        (x: any) => x.amount < 0 && x.type === "lightning",
      );
      return p?.ref ? p : null;
    }, 20000);
    expect(withdrawal).toBeTruthy();

    // For a direct peer, actual routing fee should be 0 or very small
    // The pre-allocated budget (2% or getroutes estimate) should have been refunded
    // via finalize(), so p.fee reflects the actual cost, not the budget
    expect(withdrawal.fee).toBeLessThan(Math.abs(withdrawal.amount) * 0.02);

    // Verify the refund happened — user should have gotten back the difference
    // between the pre-allocated fee budget and the actual fee
    expect(withdrawal.ref).toBeTruthy(); // preimage set by finalize()
  }, 30000);
});
