import config from "$config";
import api from "$lib/api";
import { db, g, gf, s, sa } from "$lib/db";
import {
  broadcastTx,
  btcNetwork,
  deriveAddress,
  deriveAddresses,
  getAddressTxs,
  getAddressUtxos,
  getTxHex,
  getTxStatus,
  hdVersions,
  findLastUsedIndex,
} from "$lib/esplora";
import { HDKey } from "@scure/bip32";
import { generate } from "$lib/invoices";
import ln from "$lib/ln";
import lnd from "$lib/lnd";

const inFlight = new Set<string>();

const outLn = {
  async xpay(args: any, { noFallback = false } = {}) {
    l("cln: paying", args.invstring?.slice(-8), args.amount_msat, "maxfee", args.maxfee);
    inFlight.add(args.invstring);
    try {
      const r = await ln.xpay(args);
      l("cln: paid", args.invstring?.slice(-8));
      return r;
    } catch (e: any) {
      warn("cln: failed", args.invstring?.slice(-8), e.message);
      if (!noFallback && lnd && !e.message?.includes("already underway")) {
        l("lnd: paying", args.invstring?.slice(-8), args.amount_msat, "maxfee", args.maxfee);
        try {
          const r = await lnd.payinvoice({ ...args, retry_for: 60 });
          l("lnd: paid", args.invstring?.slice(-8));
          return r;
        } catch (e2: any) {
          warn("lnd: failed", args.invstring?.slice(-8), e2.message);
          throw e2;
        }
      }
      throw e;
    } finally {
      inFlight.delete(args.invstring);
    }
  },
  async keysend(args: any) {
    try {
      return await ln.keysend(args);
    } catch (e) {
      if (lnd) return await lnd.keysend(args);
      throw e;
    }
  },
  async listpeerchannels() {
    try {
      return await ln.listpeerchannels();
    } catch (e) {
      if (lnd) return await lnd.listpeerchannels();
      throw e;
    }
  },
  async listpays(bolt11: string) {
    const result = await ln.listpays(bolt11);
    const hasActiveOrComplete = result.pays.some(
      (p) => p.status === "complete" || p.status === "pending",
    );
    if (!hasActiveOrComplete && lnd) return await lnd.listpays(bolt11);
    return result;
  },
};
import { err, l, warn } from "$lib/logging";
import { notify, nwcNotify } from "$lib/notifications";
import { emit } from "$lib/sockets";
import { squarePayment } from "$lib/square";
import {
  getBalance,
  getCredit,
  tbConfirm,
  tbCredit,
  tbDebit,
  tbRefund,
  tbReverse,
  tbSetBalance,
  tbSetPending,
} from "$lib/tb";
import {
  SATS,
  btc,
  fail,
  fmt,
  formatReceipt,
  getInvoice,
  getPayment,
  getUser,
  link,
  sats,
  sleep,
  t,
} from "$lib/utils";
import { callWebhook } from "$lib/webhooks";
import changeid from "$lib/changeid";
import rpc from "@coinos/rpc";
import { selectUTXO, p2wpkh } from "@scure/btc-signer";
import { bech32 } from "bech32";
import got from "got";
import { v4 } from "uuid";

import { Payment, PaymentType } from "$lib/types";

const bc = rpc(config.bitcoin);
const lq = rpc(config.liquid);

// Throttled warn — emit at most once per WARN_THROTTLE_MS per (key, message) pair
// so a downed external service (lq, bc, etc.) doesn't flood the log every loop tick.
const WARN_THROTTLE_MS = 5 * 60 * 1000;
const warnLastEmitted: Record<string, number> = {};
const warnThrottled = (key: string, message: string) => {
  const k = `${key}|${message}`;
  const now = Date.now();
  if ((warnLastEmitted[k] || 0) + WARN_THROTTLE_MS > now) return;
  warnLastEmitted[k] = now;
  warn(`${key}:`, message);
};

// Per-asset-type async mutex. The May 18 2026 drain exploited the fact that
// the limit check + payment broadcast were non-atomic: a burst of concurrent
// withdrawals would each pass the same stale ${type}:limit value before any
// of them decremented it. This lock serializes the check + reservation per
// asset type. freezeCheck also takes the lock when overwriting limits so its
// periodic reconciliation can't race with an in-flight check.
const limitLocks: Record<string, Promise<void>> = {};
async function withLimitLock<T>(type: string, fn: () => Promise<T>): Promise<T> {
  const prev = limitLocks[type] || Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => { release = res; });
  limitLocks[type] = prev.then(() => next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
const { URL } = process.env;

const dust = 547;

const resolveBip353 = async (name: string, domain: string) => {
  const qname = `${name}.user._bitcoin-payment.${domain}`;
  const res = await fetch(`https://1.1.1.1/dns-query?name=${qname}&type=TXT`, {
    headers: { accept: "application/dns-json" },
  });
  const data = await res.json();
  if (!data.AD) return null; // DNSSEC validation failed
  if (!data.Answer?.length) return null;
  for (const ans of data.Answer) {
    const txt = ans.data?.replace(/^"|"$/g, "").replaceAll('" "', "");
    if (txt?.startsWith("bitcoin:")) return txt;
  }
  return null;
};

export const getUserRate = async (user) => {
  const rates = await g("rates");
  const { currency } = user;
  const rate = rates[currency];
  return { rates, rate, currency };
};

export const debit = async ({
  aid = undefined,
  hash,
  amount,
  fee = 0,
  memo = undefined,
  user,
  type = PaymentType.internal,
  rate = undefined,
  ourfee: ourfeeOverride = undefined,
  creditType: creditTypeOverride = undefined,
}) => {
  amount = Number.parseInt(amount);

  const whitelisted = await db.sIsMember("whitelist", user?.username?.toLowerCase().trim());

  const blacklisted = await db.sIsMember("blacklist", user?.username?.toLowerCase().trim());

  if (hash && await db.sIsMember("blocked_addresses", hash)) {
    err(`SECURITY: blocked send to ${hash} by ${user.username}`);
    await changeid(user.username);
    fail("address blocked");
  }

  const serverLimit = await g(`${type}:limit`);
  const userLimit = await g("limit");
  const frozen = (await g("hardfreeze")) || ((await g("freeze")) && type !== PaymentType.internal);
  const skipServerLimit = type === PaymentType.fund || type === PaymentType.internal;

  if (
    frozen && !whitelisted ||
    (userLimit != null && amount > userLimit && !whitelisted) ||
    (!skipServerLimit && serverLimit != null && amount > serverLimit)
  ) {
    warn("Blocking", user.username, amount, hash, user.id, type, frozen, userLimit, serverLimit);

    fail("Problem sending payment");
  }

  // Atomic check + reserve against the per-asset-type server limit. Decrement
  // immediately so concurrent calls can't reuse the same budget; freezeCheck
  // reconciles to actual on-chain balance every 10s.
  await withLimitLock(type, async () => {
    const serverLimit = Number.parseInt((await g(`${type}:limit`)) ?? "0", 10) || 0;
    if (amount > serverLimit) {
      warn("Blocking", user.username, amount, hash, user.id, type, "serverLimit", serverLimit);
      fail("Problem sending payment");
    }
    await db.decrBy(`${type}:limit`, amount);
  });

  let ref;
  const { id: uid } = user;
  if (!aid) aid = uid;
  const debitAccount = aid && aid !== uid ? await g(`account:${aid}`) : null;
  const currency = debitAccount?.currency || user.currency;

  const rates = await g("rates");
  if (!rate) rate = rates[currency];

  const invoice = await getInvoice(hash);
  let iid;

  if (invoice) {
    if (invoice.received >= amount && invoice.type !== PaymentType.bolt12)
      fail("Invoice already paid");
    ({ id: iid } = invoice);

    ref = invoice.uid;

    const equivalentRate = invoice.rate * (rates[currency] / rates[invoice.currency]);

    if (Math.abs(invoice.rate / rates[invoice.currency] - 1) < 0.01) {
      rate = equivalentRate;
    } else {
      warn("rate slipped", hash, invoice.rate, equivalentRate);
    }
  }

  const tip = Number.parseInt(invoice?.tip) || null;
  if (tip < 0) fail("Invalid tip");

  if (!amount || amount < 0) fail("Amount must be greater than zero");

  let creditType = type;
  if (creditType === PaymentType.bolt12) creditType = PaymentType.lightning;
  let ourfee: any = [PaymentType.bitcoin, PaymentType.liquid, PaymentType.lightning].includes(type)
    ? Math.round((amount + fee + tip) * config.fee[creditType])
    : 0;

  if (creditTypeOverride) creditType = creditTypeOverride;
  if (ourfeeOverride !== undefined) ourfee = ourfeeOverride;
  if (aid !== uid) ourfee = 0;
  const frozenBalance = !blacklisted || whitelisted ? 0 : await getBalance(uid);

  ourfee = await tbDebit(
    aid,
    uid,
    creditType,
    amount || 0,
    tip || 0,
    fee || 0,
    ourfee || 0,
    frozenBalance || 0,
    t(user).insufficientFunds,
  );

  if (ourfee.err) fail(ourfee.err);

  const id = v4();
  const p = {
    id,
    aid,
    amount: -amount,
    fee,
    hash,
    hex: undefined,
    ourfee,
    memo,
    iid,
    uid,
    // Lightning/bolt12 sends are IN-FLIGHT until the HTLC settles (preimage
    // revealed). Don't mark them confirmed on the optimistic debit — finalize()
    // flips this to true once the preimage arrives. Hold invoices (e.g. Ark)
    // can keep an HTLC pending for hours/days; showing "confirmed" while the
    // recipient hasn't been paid is misleading. Other send types settle
    // immediately (internal) or are broadcast right away (bitcoin/liquid/fund).
    confirmed: ![PaymentType.lightning, PaymentType.bolt12].includes(type),
    rate,
    currency,
    type,
    ref,
    tip,
    created: Date.now(),
  };

  await s(`payment:${hash}`, id);
  await s(`payment:${id}`, p);
  await db
    .multi()
    .lPush("payments", id)
    .lPush(`${aid || uid}:payments`, id)
    .set(`${aid || uid}:payments:last`, p.created)
    .exec();

  l(user.username, "sent", type, amount);
  if (![PaymentType.lightning, PaymentType.bolt12].includes(type)) nwcNotify(p);

  return p;
};

export const credit = async ({
  hash,
  amount,
  memo = "",
  ref = "",
  type = PaymentType.internal,
  aid = undefined,
  payment_hash = undefined,
  assetAmount = undefined,
  assetType = undefined,
  ourfee = undefined,
  tip = undefined,
  created = undefined,
}) => {
  amount = Number.parseInt(amount) || 0;

  let inv = await getInvoice(hash);
  if (!inv && type === PaymentType.bolt12) {
    const { invoices } = await ln.listinvoices({ invstring: hash });
    const { local_offer_id } = invoices[0];
    inv = await getInvoice(local_offer_id);
  }

  if (!inv) {
    await db.sAdd("missing", ref.split(":")[0]);
    return;
  }

  const lockKey = `lock:credit:${hash}`;
  const locked = await db.setNX(lockKey, "1");
  if (!locked) fail("Payment already being processed");
  await db.expire(lockKey, 30);

  if (inv.received >= amount && inv.type !== PaymentType.bolt12) fail("Invoice already paid");

  let { path } = inv;
  // Use the tip the sender was actually debited (passed in for internal
  // transfers) rather than re-reading the invoice. The invoice's tip can be
  // mutated between the sender debit and this credit (PUT /invoice), which
  // otherwise lets a payer credit a tip they were never charged — minting
  // balance. Fall back to the invoice tip only for external receipts
  // (lightning/ecash) where there is no paired coinos debit to diverge from.
  tip = tip !== undefined ? Number.parseInt(tip) || 0 : Number.parseInt(inv.tip) || 0;

  if (!memo) ({ memo } = inv);
  // Truncate rather than throw: credit() runs AFTER the payment has settled (an
  // incoming lightning/bolt12 deposit already advanced pay_index; an internal
  // send already debited the sender). Throwing here left the sats in the house
  // wallet with no retry path — the payer saw a completed payment and the
  // recipient was never credited. An oversized memo (attacker-controllable via
  // the lnurl comment or a bolt12 payer_note) must never destroy a settled
  // payment; a clipped note is harmless.
  if (memo && memo.length > 5000) memo = memo.slice(0, 5000);
  if (amount < 0 || tip < 0) fail("Invalid amount");
  if (type === PaymentType.internal) amount += tip;

  const user = await getUser(inv.uid);
  const { id: uid } = user;
  const creditAccount = aid && aid !== uid ? await g(`account:${aid}`) : null;
  const currency = creditAccount?.currency || user.currency;

  const rates = await g("rates");
  let rate = rates[currency];

  if (!rate) await sleep(1000);
  rate = rates[currency];

  const equivalentRate = inv.rate * (rates[currency] / rates[inv.currency]);

  if (Math.abs(inv.rate / rates[inv.currency] - 1) < 0.01) {
    rate = equivalentRate;
  } else {
    // warn("rate slipped", hash, invoice.rate, equivalentRate);
  }

  const id = v4();
  const p = {
    aid,
    id,
    iid: inv.id,
    hash,
    amount: amount - tip,
    path,
    uid,
    rate,
    currency,
    memo,
    payment_hash,
    ref,
    tip,
    type,
    confirmed: true,
    created: created || Date.now(),
    items: undefined,
    ...(assetAmount !== undefined && { assetAmount }),
    ...(assetType !== undefined && { assetType }),
    ...(ourfee !== undefined && { ourfee }),
  };

  if ([PaymentType.bitcoin, PaymentType.liquid].includes(type)) inv.pending += amount;
  else {
    inv.received += amount;
    inv.preimage = ref;
    inv.settled = Date.now();
  }

  if (assetType !== undefined) inv.assetType = assetType;
  if (assetAmount !== undefined) inv.assetAmount = assetAmount;

  let balanceKey = "balance";
  if ([PaymentType.bitcoin, PaymentType.liquid].includes(type)) {
    const [txid, vout] = ref.split(":").slice(-2);
    p.confirmed = false;
    balanceKey = "pending";
    await s(`payment:${txid}:${vout}`, id);
    // Mirror the txid:vout pointer into arc so future bulk /confirm sweeps find
    // the prior credit via gf() fallback and don't double-credit. See
    // feedback_apr29_double_credit_incident.md for the incident this prevents.
    await sa(`payment:${txid}:${vout}`, id);
  } else {
    await s(`payment:${hash}`, id);
    await sa(`payment:${hash}`, id);
  }

  let creditType = type;
  if (creditType === PaymentType.bolt12) creditType = PaymentType.lightning;
  const isPending = balanceKey === "pending";

  await tbCredit(aid || uid, uid, creditType, amount, isPending);

  await db
    .multi()
    .set(`invoice:${inv.id}`, JSON.stringify(inv))
    .set(`payment:${p.id}`, JSON.stringify(p))
    .lPush(`${aid || uid}:payments`, p.id)
    .set(`${aid || uid}:payments:last`, p.created)
    .exec();

  // Mirror the payment record + invoice into arc for the same protection.
  await sa(`payment:${p.id}`, p);
  await sa(`invoice:${inv.id}`, inv);

  if (inv.items?.length) {
    formatReceipt(inv.items, inv.currency);
    p.items = inv.items;
  }

  await completePayment(inv, p, user);

  return p;
};

export const completePayment = async (inv, p, user) => {
  const { id, username } = user;
  const aid = p.aid || id;
  const account = aid !== id ? await g(`account:${aid}`) : null;
  const autowithdraw = account?.autowithdraw;
  const threshold = account?.threshold ?? user.threshold;
  const reserve = account?.reserve ?? user.reserve;
  const destination = account?.destination ?? user.destination;

  let withdrawal;
  if (p.confirmed) {
    if (inv.forward && !inv.forwarded) {
      const lockKey = `forward:${inv.id}`;
      const locked = await db.setNX(lockKey, "1");
      if (locked) {
        await db.expire(lockKey, 300);
        try {
          inv.forwarded = true;
          await s(`invoice:${inv.id}`, inv);

          // Skip forward if destination is the same account (not just same user)
          const destInv = await getInvoice(inv.forward).catch(() => null);
          if (destInv?.uid === id && destInv?.aid === aid) return;

          await pay({ amount: p.amount, to: inv.forward, user });
        } catch (e) {
          warn(username, "forward failed", inv.forward, e.message);
        }
      }
    } else if (autowithdraw && p.type !== "ark") {
      try {
        const to = destination.trim();
        const balance = await getBalance(aid);
        const amount = balance - reserve;
        if (balance > threshold) {
          l("initiating autowithdrawal", amount, to, balance, threshold);
          const w = await pay({ aid, amount, to, user });
          withdrawal = {
            amount: fmt(-w.amount),
            link: link(w.id),
          };
        }
      } catch (e) {
        withdrawal = { failed: true };
        warn(username, "autowithdraw failed", e.message);
      }
    }
  }

  nwcNotify(p);
  notify(p, user, withdrawal);

  squarePayment(p, user);

  l(username, "received", p.type, p.amount);
  callWebhook(inv, p);
};

const confirmWatchedIncoming = async (address, existing) => {
  existing.confirmed = true;
  const inv = await getInvoice(address);
  if (inv) {
    inv.received += Number.parseInt(inv.pending);
    inv.pending = 0;
    await s(`invoice:${inv.id}`, inv);
  }
  await s(`payment:${existing.id}`, existing);
  await tbConfirm(existing.aid || existing.uid, existing.amount);
  const user = await getUser(existing.uid);
  if (inv) await completePayment(inv, existing, user);
  await db.sRem("watching", address);
};

export const processWatchedTx = async (tx) => {
  const txid = tx.txid;

  for (let vout = 0; vout < tx.vout.length; vout++) {
    const output = tx.vout[vout];
    const address = output.scriptpubkey_address;
    if (!address) continue;
    if (!(await db.sIsMember("watching", address))) continue;

    const invoice = await getInvoice(address);
    if (!invoice) continue;

    const existing = await getPayment(`${txid}:${vout}`);
    if (existing) {
      if (!existing.confirmed && tx.status?.confirmed) {
        await confirmWatchedIncoming(address, existing);
      }
      continue;
    }

    if (output.value < 300) continue;

    const lockKey = `lock:${txid}:${vout}`;
    const locked = await db.setNX(lockKey, "1");
    if (!locked) continue;
    await db.expire(lockKey, 60);

    await credit({
      hash: address,
      amount: output.value,
      ref: `${txid}:${vout}`,
      type: PaymentType.bitcoin,
      aid: invoice.aid,
    });

    if (tx.status?.confirmed) {
      const created = await getPayment(`${txid}:${vout}`);
      if (created && !created.confirmed) {
        await confirmWatchedIncoming(address, created);
      }
    }
  }
};

const pay = async ({ aid = undefined, amount, to, user }) => {
  if (!aid) aid = user.id;
  amount = Number.parseInt(amount) || 0;
  let lnurl;
  let pr;
  if (to.includes("@") && to.includes(".")) {
    const [name, domain] = to.split("@");
    if (URL.includes(domain)) to = name;
    else {
      try {
        const uri = await resolveBip353(name, domain);
        if (uri) {
          const params = new URLSearchParams(uri.split("?")[1]);
          if (params.has("lno")) to = params.get("lno");
          else if (params.has("sp")) to = params.get("sp");
          else if (params.has("lightning")) to = params.get("lightning");
          else {
            const addr = uri.replace("bitcoin:", "").split("?")[0];
            if (addr) to = addr;
          }
        }
      } catch (e) {
        warn("BIP 353 resolution failed, falling back to LNURL", e.message);
      }
      if (to.includes("@")) lnurl = `https://${domain}/.well-known/lnurlp/${name}`;
    }
  } else if (to.startsWith("lnurl")) {
    lnurl = Buffer.from(bech32.fromWords(bech32.decode(to, 20000).words)).toString();
  }

  const recipient = await getUser(to);
  if (recipient)
    return sendInternal({
      amount,
      recipient,
      sender: user,
    });

  // Check for local invoice before applying external fees
  if (to.startsWith("ln") && !to.startsWith("lnurl") && !to.startsWith("lno")) {
    const localInv = await getInvoice(to).catch(() => null);
    if (localInv) {
      const recipient = await getUser(localInv.uid);
      if (recipient) return sendInternal({ amount, invoice: localInv, recipient, sender: user });
    }
  }

  let fee;
  const ourfee = Math.round(amount * (config.fee.lightning || 0));
  if (lnurl) {
    fee = Math.max(5, Math.round(amount * 0.02));
    amount -= fee + ourfee;
    const { callback } = (await got(lnurl).json()) as any;
    ({ pr } = (await got(`${callback}?amount=${amount * 1000}`).json()) as any);
  } else if (to.startsWith("lno")) {
    const { id: source } = await ln.getinfo();
    const { offer_issuer_id } = await ln.decode(to);
    const { routes } = await ln.getroutes(
      source,
      offer_issuer_id,
      amount * 1000,
      ["auto.localchans", "auto.sourcefree"],
      Math.round(amount * 0.02) * 1000,
      6,
    );
    fee = routes.length
      ? Math.max(5, Math.round((routes[0].path[0].amount_msat - routes[0].amount_msat) / 1000))
      : 0;
    amount -= fee + ourfee;
    const { invoice } = await ln.fetchinvoice(to, amount * 1000);
    pr = invoice;
  } else if (to.startsWith("ln")) {
    fee = Math.max(5, Math.round(amount * 0.02));
    amount -= fee + ourfee;
    pr = to;
  }

  if (pr) return sendLightning({ user, pr, amount, fee });

  return sendOnchain({ aid, amount, address: to, user, subtract: true });
};

export const decode = async (hex) => {
  let type;
  let tx;
  try {
    tx = await bc.decodeRawTransaction(hex);
    type = PaymentType.bitcoin;
  } catch {
    try {
      tx = await lq.decodeRawTransaction(hex);
      type = PaymentType.liquid;
    } catch {
      err("invalid hex", hex);
      fail("unrecognized tx");
    }
  }

  return { tx, type };
};

const sendNonCustodial = async (params) => {
  let { aid, hex, rate, user } = params;
  if (!hex) ({ hex } = await build(params));

  const { tx } = await decode(hex);
  let { txid } = tx;
  let sendLockKey: string | undefined;

  try {
    sendLockKey = `sendlock:bitcoin:${txid}`;
    if (!(await db.set(sendLockKey, "1", { NX: true, EX: 60 }))) fail("payment in flight");
    if (await g(`payment:${txid}`)) fail("transaction already processed");

    const account = await g(`account:${aid}`);
    const nextIndex = account.nextIndex || 0;

    // Build set of own addresses for change detection
    const ownAddresses = new Set<string>();
    for (let i = 0; i <= nextIndex; i++) {
      ownAddresses.add(deriveAddress(account.pubkey, account.fingerprint, i, false).address);
      ownAddresses.add(deriveAddress(account.pubkey, account.fingerprint, i, true).address);
    }

    let totalIn = 0;
    for (const { txid: inputTxid, vout } of tx.vin) {
      const inputHex = await getTxHex(inputTxid);
      const inputTx = await bc.decodeRawTransaction(inputHex);
      totalIn += sats(inputTx.vout[vout].value);
    }

    let total = 0;
    let change = 0;
    for (const {
      scriptPubKey: { address },
      value,
    } of tx.vout) {
      total += sats(value);
      const invoice = await getInvoice(address);
      if (invoice?.aid === aid) fail("Cannot send to internal address");

      if (ownAddresses.has(address)) {
        change += sats(value);
      }
    }

    const fee = totalIn - total;
    const amount = total - change;

    const p = await debit({
      aid,
      hash: txid,
      amount,
      fee,
      rate,
      user,
      type: PaymentType.bitcoin,
    });

    p.hex = hex;
    await s(`payment:${p.id}`, p);

    await broadcastTx(hex);
    await db.sAdd(`inflight:${aid}`, p.id);

    if (sendLockKey) await db.del(sendLockKey);
    return p;
  } catch (e) {
    if (sendLockKey) await db.del(sendLockKey);
    throw e;
  }
};

export const sendOnchain = async (params) => {
  let { aid, hex, rate, user, signed, address: destAddress } = params;
  if (!aid) aid = user.id;

  // Non-custodial bitcoin account — use esplora
  if (aid !== user.id) {
    return sendNonCustodial(params);
  }

  let buildResult;
  if (!hex) {
    buildResult = await build(params);
    hex = buildResult.hex;
  }

  const { tx, type } = await decode(hex);
  const node = rpc(config[type]);
  const isBitcoin = type === PaymentType.bitcoin;
  let { txid } = tx;
  let sendLockKey: string | undefined;

  try {
    // Reserve UTXOs to keep concurrent sends from selecting the same inputs.
    // Released in the catch block on failure; spent UTXOs make the lock moot on success.
    try {
      const lockVin = tx.vin.map(({ txid, vout }) => ({ txid, vout }));
      if (lockVin.length) await node.lockUnspent(false, lockVin);
    } catch (e: any) {
      warn("lockUnspent failed", e.message);
    }

    if (!signed) {
      if (config[type].walletpass)
        await node.walletPassphrase(config[type].walletpass, config[type].walletpassSeconds);

      ({ hex } = await node.signRawTransactionWithWallet(
        type === PaymentType.liquid ? await node.blindRawTransaction(hex) : hex,
      ));
    }

    ({ txid } = await node.decodeRawTransaction(hex));

    // Persistent, atomic guard against the same txid being debited twice —
    // a client retry after a slow/timed-out response, or two overlapping
    // requests, can otherwise both pass every check below and both call
    // debit(), which has no dedup of its own against `hash`. The old
    // in-memory inflight[] lock only caught truly-concurrent calls in this
    // one process; this mirrors the confirmlock pattern already used for
    // the credit side (dfd31ad8) with a persistent existence check on top
    // for the case where a retry lands after the lock has expired.
    sendLockKey = `sendlock:${type}:${txid}`;
    if (!(await db.set(sendLockKey, "1", { NX: true, EX: 60 }))) fail("payment in flight");
    if (await g(`payment:${txid}`)) fail("transaction already processed");

    const r = await node.testMempoolAccept([hex]);
    if (!r[0].allowed) fail(`transaction rejected: ${r[0]["reject-reason"]}`);

    let total = 0;
    let fee = 0;
    let change = 0;

    if (type === PaymentType.liquid) {
      const destUnconf = destAddress
        ? (await node.getAddressInfo(destAddress)).unconfidential
        : null;
      for (const {
        asset,
        scriptPubKey: { address, type },
        value,
      } of tx.vout) {
        if (asset !== config.liquid.btc) fail("only L-BTC supported");
        if (type === "fee") fee = sats(value);
        else {
          total += sats(value);

          if (address && address !== destUnconf) {
            if ((await node.getAddressInfo(address)).ismine) {
              change += sats(value);
            }
          }
        }
      }
    } else {
      let totalIn = 0;
      for await (const { txid, vout } of tx.vin) {
        const hex = await node.getRawTransaction(txid);
        const tx = await node.decodeRawTransaction(hex);
        totalIn += sats(tx.vout[vout].value);
      }

      for (let i = 0; i < tx.vout.length; i++) {
        const { scriptPubKey, value } = tx.vout[i];
        if (!scriptPubKey.address) continue;

        total += sats(value);
        const invoice = await getInvoice(scriptPubKey.address);
        if (invoice?.aid === aid) fail("Cannot send to internal address");

        if (
          scriptPubKey.address !== destAddress &&
          (await node.getAddressInfo(scriptPubKey.address)).ismine
        ) {
          change += sats(value);
        }
      }

      fee = totalIn - total;
    }

    const amount = total - change;

    if (type === PaymentType.liquid) fee = 50;

    // When hex is pre-built, check if the fee rate is still acceptable
    if (isBitcoin && !buildResult) {
      const currentFees: any = await fetch(api.fees).then((r) => r.json());
      const minAcceptable = currentFees.hourFee;
      const decoded = await node.decodeRawTransaction(hex);
      const originalRate = fee / decoded.vsize;

      if (originalRate < minAcceptable) {
        buildResult = await build(params);
        hex = buildResult.hex;

        ({ hex } = await node.signRawTransactionWithWallet(hex));
        ({ txid } = await node.decodeRawTransaction(hex));

        const r2 = await node.testMempoolAccept([hex]);
        if (!r2[0].allowed) fail(`rebuilt transaction rejected: ${r2[0]["reject-reason"]}`);

        fee = buildResult.fee || 0;
      }
    }

    const p = await debit({
      aid,
      hash: txid,
      amount,
      fee,
      rate,
      user,
      type,
    });

    p.fee = fee;
    p.hex = hex;
    (p as any).address = params.address;

    if (isBitcoin) {
      p.confirmed = false;
    }

    await s(`payment:${p.id}`, p);

    await node.sendRawTransaction(hex);

    if (isBitcoin) {
      await db.sAdd("outgoing:unconfirmed", p.id);
    }

    if (sendLockKey) await db.del(sendLockKey);
    return p;
  } catch (e) {
    if (sendLockKey) await db.del(sendLockKey);
    // Release UTXOs that build() locked, so the user can retry without abandoning coins.
    try {
      const vin = tx?.vin?.map(({ txid, vout }) => ({ txid, vout })) ?? [];
      if (vin.length) await node.lockUnspent(true, vin);
    } catch {}
    throw e;
  }
};

export const sendUsdt = async ({ address, amount, user }) => {
  const { id: uid } = user;
  const rates = await g("rates");
  const usdtRate = rates["USD"];
  const effectiveRate = usdtRate / (1 + (config.fee as any).usdt); // fx fee baked into rate; lower than mid since user sells BTC
  const btcSats = Math.round((amount / effectiveRate) * SATS);

  const { rate } = await getUserRate(user);

  const LIQUID_NETWORK_FEE = 50;

  // No txid exists until after the send below, so there's nothing to lock
  // on the way sendOnchain/sendNonCustodial do — lock on the request shape
  // instead, closing the same client-retry double-debit gap for the window
  // a retry would otherwise re-debit and re-send.
  const sendLockKey = `sendlock:usdt:${uid}:${address}:${amount}`;
  if (!(await db.set(sendLockKey, "1", { NX: true, EX: 60 }))) fail("payment in flight");

  try {
    const p = (await debit({
      aid: uid,
      hash: address,
      amount: btcSats + LIQUID_NETWORK_FEE,
      fee: LIQUID_NETWORK_FEE,
      ourfee: 0,
      rate,
      user,
      type: PaymentType.liquid,
    })) as Payment;

    if (config.liquid.walletpass) await lq.walletPassphrase(config.liquid.walletpass, 300);

    const txid = await lq.sendToAddress(
      address,
      amount,
      "",
      "",
      false,
      false,
      1,
      "UNSET",
      false,
      (config.liquid as any).usdt,
    );

    p.hash = txid;
    p.assetAmount = amount;
    p.assetType = "USDT";
    await s(`payment:${p.id}`, p);

    l(user.username, "sent USDT", amount, "→", txid);
    return p;
  } finally {
    await db.del(sendLockKey);
  }
};

export const sendKeysend = async ({
  hash,
  amount,
  pubkey,
  fee = undefined,
  memo = undefined,
  user,
  extratlvs = undefined,
}) => {
  fee = Math.max(Number.parseInt(fee || amount * 0.005), 5);

  let p = await gf(`payment:${hash}`);
  if (p) fail("duplicate keysend");

  p = await debit({
    hash,
    amount,
    fee,
    memo,
    user,
    type: PaymentType.lightning,
  });

  let outcome = "unknown";

  // COINOS-1: keysend randomizes its payment hash (the CLN command takes no
  // preimage arg) and a throw yields no result object, so the caller-supplied
  // `hash` is NOT the payment's real hash — verifying with it is what made the
  // old code reverse on every throw. CLN keysend errors carry no payment_hash
  // either (verified on v26.06.2: the error is {code, message, attempts}).
  //
  // Instead, tag the payment with our own unique `label` and note where the
  // sendpays index stands beforehand. `wait sendpays created 0` returns the
  // current index immediately, so on a throw we can list only sendpays created
  // since — no full scan — and find ours by label regardless of error shape.
  // `wait` isn't in the rpc client's generated method list, so go through the
  // generic call(). nextvalue 0 never blocks — it returns the current index.
  let startIndex: number | undefined;
  try {
    const w = await ln.call("wait", {
      subsystem: "sendpays",
      indexname: "created",
      nextvalue: 0,
    });
    startIndex = w?.created;
  } catch (e: any) {
    warnThrottled("keysend: wait sendpays unavailable", e?.message ?? String(e));
  }

  try {
    const r = await outLn.keysend({
      destination: pubkey,
      amount_msat: amount * 1000,
      maxfee: fee * 1000,
      retry_for: 10,
      label: hash,
      extratlvs,
    });
    // Debit created this payment as confirmed:false (in-flight, same as any
    // other lightning send) — flip it now that keysend has settled, or it
    // would show "pending" forever despite having succeeded.
    try {
      await finalize(r, p);
    } catch (e: any) {
      warnThrottled("keysend: finalize failed", e?.message ?? String(e));
    }
    return r;
  } catch (e) {
    try {
      if (startIndex === undefined) {
        // Couldn't establish the index baseline, so we can't bound the search.
        // Never refund a payment that may have settled — leave the debit.
        warn("keysend threw with no sendpays baseline — NOT reversing (manual review)", p.id, pubkey);
        outcome = "unverified-after-keysend-throw (not reversed)";
      } else {
        const { payments = [] } = await ln.listsendpays({
          index: "created",
          start: startIndex,
        });
        const ours = payments.filter((x: any) => x.label === hash);
        warn("sendpays after keysend-threw", p.id, JSON.stringify(ours.map((x: any) => ({ status: x.status }))));

        if (ours.some((x: any) => x.status === "complete")) {
          // Settled despite the throw — reversing here is the drain.
          outcome = "keysend-completed-despite-throw";
        } else if (!ours.length) {
          // CLN records a sendpay BEFORE it sends the HTLC, so no record at all
          // means nothing left the node (the common no-route/no-path failure).
          // Safe — and necessary — to refund.
          await reverse(p);
          outcome = "reversed-after-keysend-throw (no htlc sent)";
        } else if (ours.every((x: any) => x.status === "failed")) {
          await reverse(p);
          outcome = "reversed-after-keysend-throw (confirmed failed)";
        } else {
          // Still in flight: CLN may yet settle it, so leave the debit.
          outcome = "pending-after-keysend-throw";
        }
      }
    } catch (verifyErr: any) {
      warnThrottled("sendpays verification failed (keysend)", verifyErr?.message ?? String(verifyErr));
      outcome = "verify-failed-after-keysend-throw";
    }
    warn("sendKeysend outcome", p.id, "=", outcome);
    throw e;
  }
};

export const sendLightning = async ({
  user,
  pr,
  amount,
  fee = undefined,
  memo = undefined,
  retryFor = undefined,
}) => {
  let p;

  if (typeof amount !== "undefined") {
    amount = Number.parseInt(amount);
    if (amount < 0 || amount > SATS || Number.isNaN(amount)) {
      warn("invalid amount", amount);
      fail("Invalid amount");
    }
  }

  // Whitelisted users get LND fallback (faster fail = OK; default 30s).
  // Non-whitelisted have only CLN, so give it more time to find a route.
  const whitelisted = await db.sIsMember("whitelist", user?.username?.toLowerCase().trim());
  if (typeof retryFor === "undefined") retryFor = whitelisted ? 30 : 60;

  let { type, invoice_amount_msat, amount_msat, invoice_node_id, payee } = await ln.decode(pr);
  if (type.includes("bolt12")) {
    amount_msat = invoice_amount_msat;
    payee = invoice_node_id;
  }

  const { channels } = await outLn.listpeerchannels();
  const isDirect = channels.some((c) => c.peer_id === payee);
  const minfee = isDirect ? 0 : Math.max(10, Math.round(amount * 0.005));

  const parsedFee = Number.parseInt(fee);
  const userSetFee = !Number.isNaN(parsedFee);
  fee = userSetFee ? parsedFee : minfee;

  if (fee < 0) fail("Fee cannot be negative");

  const { pays } = await outLn.listpays(pr);
  if (pays.find((p) => p.status === "complete")) fail("Invoice has already been paid");

  if (pays.find((p) => p.status === "pending")) fail("Payment is already underway");

  p = await debit({
    hash: pr,
    amount: amount_msat ? Math.round(amount_msat / 1000) : amount,
    fee,
    memo,
    user,
    type: PaymentType.lightning,
  });

  await db.sAdd("pending", pr);

  l("paying lightning invoice", pr.substr(-8), amount, fee);

  // Fire-and-forget the actual LN send. Resolution (success, reverse,
  // or queued for check()) emits a payment event so the UI can refresh
  // /sent/<id> in real time. We don't await — the response goes back to
  // the user immediately with p so the form action redirects right away.
  void completeLightningInBackground({
    p,
    pr,
    amount,
    amount_msat,
    fee,
    retryFor,
    whitelisted: !!whitelisted,
  });

  return p;
};

const completeLightningInBackground = async ({
  p,
  pr,
  amount,
  amount_msat,
  fee,
  retryFor,
  whitelisted,
}: {
  p: any;
  pr: string;
  amount: number;
  amount_msat: number | undefined;
  fee: number;
  retryFor: number;
  whitelisted: boolean;
}) => {
  try {
    const r = await outLn.xpay(
      {
        invstring: pr.replace(/\s/g, "").toLowerCase(),
        amount_msat: amount_msat ? undefined : amount * 1000,
        maxfee: fee * 1000,
        retry_for: retryFor,
      },
      { noFallback: !whitelisted || retryFor < 20 },
    );

    try {
      if (r.payment_preimage || r.preimage || !r.failed_parts) await finalize(r, p);
    } catch {
      warn("failed to process payment", p.id);
    }
  } catch {
    err("failed to pay", pr.substr(-8));

    // Before reversing, double-check whether the payment actually settled
    // on the LN network. xpay may throw on timeout while the HTLC still
    // completes — reversing in that case mints free balance for the user.
    let complete: any = null;
    let pending = false;
    let verified = false;
    try {
      const { pays } = await outLn.listpays(pr);
      complete = pays.find((x: any) => x.status === "complete");
      pending = pays.some((x: any) => x.status === "pending");
      verified = true;
    } catch (e2: any) {
      warn("listpays check failed", pr.substr(-8), e2.message);
      try {
        const line = `${new Date().toISOString()} ${pr.substr(-8)} pid=${p.id} amount=${amount} ${e2.message ?? e2}\n`;
        await (
          await import("fs/promises")
        ).appendFile("/home/bun/app/logs/verify-failed.log", line);
      } catch {}
    }

    if (verified && complete) {
      // Payment settled on LN. Finalize and clear from pending.
      await db.sRem("pending", pr);
      err("NOT reversing — payment completed on LN despite xpay error", pr.substr(-8));
      try {
        await finalize(complete, p);
      } catch {}
    } else if (!verified || pending) {
      // Either listpays errored (unknown state) or sendpay is still in
      // flight (could go either way). Keep entry in `pending` so check()
      // reconciles to finalize or reverse once the real status lands.
      err(
        "NOT reversing — payment pending or listpays unavailable, queued for check()",
        pr.substr(-8),
      );
      // No sRem here; the original sAdd from line ~968 stands.
    } else {
      // verified + no complete + no pending = all failed → safe to reverse.
      await db.sRem("pending", pr);
      try {
        await reverse(p);
      } catch {}
    }
  }
};

export const sendInternal = async ({
  amount,
  invoice = undefined,
  memo = undefined,
  recipient,
  sender,
}) => {
  if (!invoice)
    invoice = await generate({
      invoice: { amount, type: "lightning" },
      user: recipient,
    });

  const { hash } = invoice;
  const p = await debit({ hash, amount, memo, user: sender });
  await credit({ hash, amount, memo, ref: sender.id, tip: p.tip });

  if (invoice.memo?.includes("9734")) {
    const { invoices } = await ln.listinvoices({ invstring: hash });
    const inv = invoices[0];
    inv.payment_preimage = p.id;
    inv.paid_at = Math.floor(Date.now() / 1000);
    // Dynamic import to prevent circular dependency between payments.ts and nostr.ts
    const { handleZap } = await import("$lib/nostr");  
    handleZap(inv, sender.pubkey).catch(console.log);
  }

  return p;
};

const getAddressType = async (a) => {
  try {
    await bc.getAddressInfo(a);
    return PaymentType.bitcoin;
  } catch (e) {
    err("getAddressInfo failed", `code: ${e.code} message: ${e.message}`);
    try {
      await lq.getAddressInfo(a);
      return PaymentType.liquid;
    } catch {
      fail("unrecognized address");
    }
  }
};

const buildNonCustodial = async ({ aid, amount, address, feeRate, subtract }) => {
  const account = await g(`account:${aid}`);
  if (!account?.pubkey) fail("account missing pubkey");

  amount = Number.parseInt(amount);
  if (amount < 0) fail("invalid amount");

  const fees: any = await fetch(api.fees).then((r) => r.json());

  fees.fastestFee = Math.ceil(fees.fastestFee);
  for (const k of ["halfHourFee", "hourFee", "minimumFee"]) fees[k] = Math.ceil(fees[k] * 10) / 10;

  if (!feeRate) feeRate = fees.halfHourFee;

  const nextIndex = account.nextIndex || 0;

  // Derive all used external + internal addresses and fetch UTXOs
  const externalAddrs = deriveAddresses(account.pubkey, account.fingerprint, nextIndex + 1, false);
  const internalAddrs = deriveAddresses(account.pubkey, account.fingerprint, nextIndex + 1, true);
  const allAddrs = [...externalAddrs, ...internalAddrs];

  const rawUtxos = await getAddressUtxos(allAddrs);
  if (!rawUtxos.length) fail("no UTXOs available");

  // Build address-to-path lookup
  const addrToPath = {};
  for (let i = 0; i <= nextIndex; i++) {
    const { address: extAddr } = deriveAddress(account.pubkey, account.fingerprint, i, false);
    addrToPath[extAddr] = `m/0/${i}`;
    const { address: intAddr } = deriveAddress(account.pubkey, account.fingerprint, i, true);
    addrToPath[intAddr] = `m/1/${i}`;
  }

  // Convert esplora UTXOs to selectUTXO input format
  const keyVersions = account.pubkey.startsWith("tpub") ? hdVersions : undefined;
  const accountKey = HDKey.fromExtendedKey(account.pubkey, keyVersions);

  const utxoInputs = rawUtxos.map((u) => {
    const path = addrToPath[u.address];
    const parts = path.split("/").slice(-2);
    const child = accountKey
      .deriveChild(Number.parseInt(parts[0]))
      .deriveChild(Number.parseInt(parts[1]));
    const payment = p2wpkh(child.publicKey, btcNetwork);

    return {
      txid: u.txid,
      index: u.vout,
      witnessUtxo: {
        amount: BigInt(u.value),
        script: payment.script,
      },
    };
  });

  const balance = await getBalance(aid);
  let ourfee = 0; // Non-custodial accounts don't pay platform fee

  const outputs = [{ address, amount: BigInt(amount) }];

  // Derive a change address (next internal address)
  const { address: changeAddress } = deriveAddress(
    account.pubkey,
    account.fingerprint,
    nextIndex,
    true,
  );

  let selected = selectUTXO(utxoInputs, outputs, "default", {
    changeAddress,
    feePerByte: BigInt(Math.ceil(feeRate)),
    network: btcNetwork,
    createTx: true,
  });

  if (!selected) {
    subtract = true;
    if (amount <= dust) {
      fail(`insufficient funds ⚡️${balance} of ⚡️${amount + dust}`);
    }

    // Try with subtracted fee — send max
    const maxOutputs = [{ address, amount: BigInt(amount) }];
    selected = selectUTXO(utxoInputs, maxOutputs, "all", {
      changeAddress,
      feePerByte: BigInt(Math.ceil(feeRate)),
      network: btcNetwork,
      createTx: true,
    });

    if (!selected) fail("insufficient funds");
  }

  const fee = Number(selected.fee);

  // Build input metadata for client signing
  const inputs = selected.inputs.map((input) => {
    const inputTxid =
      typeof input.txid === "string" ? input.txid : Buffer.from(input.txid).toString("hex");
    const utxo = rawUtxos.find((u) => u.txid === inputTxid && u.vout === input.index);
    const path = utxo ? addrToPath[utxo.address] : undefined;
    return {
      witnessUtxo: {
        amount: Number(input.witnessUtxo.amount),
        script: Buffer.from(input.witnessUtxo.script).toString("hex"),
      },
      path,
    };
  });

  const hex = Buffer.from(selected.tx.toPSBT()).toString("hex");

  return { feeRate, ourfee, fee, fees, hex, inputs, subtract };
};

export const build = async ({ aid, amount, address, feeRate, subtract, user }) => {
  const type = await getAddressType(address);
  if (!aid) aid = user.id;

  // Non-custodial bitcoin account — use esplora
  if (type === PaymentType.bitcoin) {
    const account = await g(`account:${aid}`);
    if (account?.pubkey) {
      return buildNonCustodial({ aid, amount, address, feeRate, subtract });
    }
  }

  const node = rpc(config[type]);
  const isBitcoin = type === PaymentType.bitcoin;
  amount = Number.parseInt(amount);
  if (amount < 0) fail("invalid amount");

  const fees: any =
    type === PaymentType.liquid
      ? { fastestFee: 0.1, halfHourFee: 0.1, hourFee: 0.1, minimumFee: 0.1 }
      : await fetch(api.fees).then((r) => r.json());

  if (isBitcoin) {
    fees.fastestFee = Math.ceil(fees.fastestFee);
    for (const k of ["halfHourFee", "hourFee", "minimumFee"])
      fees[k] = Math.ceil(fees[k] * 10) / 10;
  }

  const rawFastestFee = fees.fastestFee;

  if (!feeRate) {
    feeRate = fees.halfHourFee;
  }

  if (feeRate < fees.minimumFee) fail("fee rate too low");

  let outs: any[] = [{ [address]: btc(amount) }];

  if (type === PaymentType.liquid) outs = outs.map((o) => ({ ...o, asset: config.liquid.btc }));

  let raw = await node.createRawTransaction([], outs, 0, true);

  let fee = 0;
  let tx;

  const LIQUID_NETWORK_FEE = 50;

  try {
    tx = await node.fundRawTransaction(raw, {
      fee_rate: feeRate,
      replaceable: true,
      subtractFeeFromOutputs: [],
    });

    fee = isBitcoin ? sats(tx.fee) : LIQUID_NETWORK_FEE;
  } catch (e) {
    if (e.message.startsWith("Insufficient")) subtract = true;
    else throw e;
  }

  const balance = await getBalance(aid);
  let ourfee = Math.round(amount * config.fee[type]);
  const creditBal = await getCredit(aid, type);
  const covered = Math.min(creditBal, ourfee);
  ourfee -= covered;

  const fullWithdrawal = subtract || amount + fee + ourfee > balance;

  if (fullWithdrawal) {
    subtract = true;
    feeRate = Math.max(rawFastestFee, 1);

    if (amount <= fee + ourfee + dust) {
      fail(`insufficient funds ⚡️${balance} of ⚡️${amount + fee + ourfee + dust}`);
    }

    outs = [{ [address]: btc(amount - ourfee) }];

    raw = await node.createRawTransaction([], outs, 0, true);

    tx = await node.fundRawTransaction(raw, {
      fee_rate: feeRate,
      replaceable: true,
      subtractFeeFromOutputs: [0],
    });

    fee = isBitcoin ? sats(tx.fee) : LIQUID_NETWORK_FEE;
  }

  const inputs = [];
  const { vin } = await node.decodeRawTransaction(tx.hex);

  for (const { txid, vout } of vin) {
    const rawTx = await node.getRawTransaction(txid);
    const tx = await node.decodeRawTransaction(rawTx);
    const prevOutput = tx.vout[vout];
    const { address } = prevOutput.scriptPubKey;
    const path = address ? (await node.getAddressInfo(address)).hdkeypath : null;
    const witnessUtxo = {
      amount: Math.round(prevOutput.value * SATS),
      script: prevOutput.scriptPubKey.hex,
    };
    inputs.push({ witnessUtxo, path });
  }

  return { feeRate, ourfee, fee, fees, hex: tx.hex, inputs, subtract };
};

export const checkOutgoingConfirmations = async () => {
  try {
    const paymentIds = await db.sMembers("outgoing:unconfirmed");
    for (const pid of paymentIds) {
      try {
        const p = await gf(`payment:${pid}`);
        if (!p) {
          await db.sRem("outgoing:unconfirmed", pid);
          continue;
        }

        if (p.confirmed) {
          await db.sRem("outgoing:unconfirmed", pid);
          continue;
        }

        const txInfo = await bc.getRawTransaction(p.hash, true).catch(() => null);
        if (!txInfo || !txInfo.confirmations || txInfo.confirmations < 1) continue;

        p.confirmed = true;
        await s(`payment:${p.id}`, p);
        await db.sRem("outgoing:unconfirmed", pid);
        emit(p.uid, "payment", p);
        l("outgoing confirmed", p.id);
      } catch (e) {
        err("problem checking outgoing confirmation", pid, e.message);
      }
    }
  } catch (e) {
    err("checkOutgoingConfirmations failed", e.message);
  }
};

// Watched addresses generated via bc.getNewAddress() (regular custodial
// bitcoin invoices) live in our own wallet, so bitcoind already tracks them
// with no external calls and no rate limit. Only non-custodial addresses
// derived from an imported xpub (deriveAddress in lib/esplora.ts) are unknown
// to the wallet — for those this returns undefined so the caller falls back
// to esplora. Reshapes gettransaction's per-address `details` into the
// esplora-vout shape processWatchedTx expects, indexed by real output
// position (details[].vout) since processWatchedTx addresses tx.vout by index.
const getOwnWalletTxs = async (address: string) => {
  const info: any = await bc.getAddressInfo(address);
  if (!info.ismine) return undefined;

  const received: any[] = await bc.listReceivedByAddress(0, true, true, address);
  const entry = received.find((r) => r.address === address);
  if (!entry) return [];

  const txs = [];
  for (const txid of entry.txids) {
    const txInfo: any = await bc.getTransaction(txid);
    const vout: any[] = [];
    for (const d of txInfo.details) {
      if (d.category !== "receive") continue;
      vout[d.vout] = { scriptpubkey_address: d.address, value: Math.round(d.amount * SATS) };
    }
    for (let i = 0; i < vout.length; i++) if (!vout[i]) vout[i] = {};
    txs.push({
      txid: txInfo.txid,
      vout,
      status: { confirmed: (txInfo.confirmations || 0) > 0 },
    });
  }
  return txs;
};

export const catchUp = async () => {
  try {
    // Check watched addresses for any missed bitcoin transactions
    const watched = await db.sMembers("watching");
    for (const address of watched as any) {
      await sleep(1000);
      try {
        const own = await getOwnWalletTxs(address as string);
        const txs = own !== undefined ? own : await getAddressTxs(address as string);
        for (const tx of txs as any) {
          await processWatchedTx(tx);
        }
      } catch (e) {
        err("catchUp address check failed", address, e.message);
      }
    }

    // Check custodial outgoing bitcoin tx confirmations
    await checkOutgoingConfirmations();

    // Non-custodial accounts: check pending outgoing payments
    const inflightAccounts = await db.keys("inflight:*");
    for (const key of inflightAccounts) {
      const keyType = await db.type(key);
      if (keyType !== "set") continue;
      const paymentIds = await db.sMembers(key);
      for (const pid of paymentIds) {
        try {
          const p = await gf(`payment:${pid}`);
          if (!p || p.confirmed) {
            await db.sRem(key, pid);
            continue;
          }
          const status = (await getTxStatus(p.hash)) as any;
          if (status.confirmed) {
            p.confirmed = true;
            await s(`payment:${p.id}`, p);
            await db.sRem(key, pid);
            emit(p.uid, "payment", p);
          }
        } catch (e) {
          err("problem checking inflight payment", e.message);
        }
      }
    }
  } catch (e) {
    err("problem catching up", e.message);
  }
};

export const syncBitcoinVault = async (account, user) => {
  const { id, uid, pubkey, fingerprint } = account;

  let nextIndex = account.nextIndex || 0;
  const lastUsed = await findLastUsedIndex(pubkey, fingerprint);
  if (lastUsed > nextIndex) {
    nextIndex = lastUsed;
    account.nextIndex = nextIndex;
    await s(`account:${id}`, account);
  }

  const count = nextIndex + 1;
  const externalAddrs = deriveAddresses(pubkey, fingerprint, count, false);
  const internalAddrs = deriveAddresses(pubkey, fingerprint, count, true);
  const allAddrs = [...externalAddrs, ...internalAddrs];
  const addressSet = new Set(allAddrs);
  const utxos = await getAddressUtxos(allAddrs);
  const confirmedUtxos = utxos.filter((u) => u.status.confirmed && u.value >= 300);
  const pendingUtxos = utxos.filter((u) => !u.status.confirmed && u.value >= 300);
  const confirmedTotal = confirmedUtxos.reduce((sum, u) => sum + u.value, 0);
  const pendingTotal = pendingUtxos.reduce((sum, u) => sum + u.value, 0);

  const { rate, currency } = await getUserRate(user);

  const newPayments = [];
  const externalSet = new Set(externalAddrs);

  // Scan pending UTXOs for unconfirmed incoming (external only)
  for (const u of pendingUtxos) {
    if (!externalSet.has(u.address)) continue;

    const ref = `${u.txid}:${u.vout}`;
    const existing = await getPayment(ref);
    if (existing?.aid === id) continue;

    if (existing) {
      existing.aid = id;
      await db
        .multi()
        .set(`payment:${existing.id}`, JSON.stringify(existing))
        .lPush(`${id}:payments`, existing.id)
        .exec();
      continue;
    }

    const p = {
      id: v4(),
      aid: id,
      amount: u.value,
      fee: 0,
      hash: u.address,
      confirmed: false,
      rate,
      currency,
      type: PaymentType.bitcoin,
      uid,
      ref,
      created: Date.now(),
    };

    await db
      .multi()
      .set(`payment:${ref}`, p.id)
      .set(`payment:${p.id}`, JSON.stringify(p))
      .lPush(`${id}:payments`, p.id)
      .set(`${id}:payments:last`, p.created)
      .exec();

    newPayments.push(p);
  }

  // Process all transactions from history (incoming + outgoing)
  const txsById = new Map();
  for (const address of allAddrs) {
    const txs = await getAddressTxs(address);
    for (const tx of txs as any) {
      txsById.set(tx.txid, tx);
    }
  }

  for (const tx of txsById.values()) {
    if (!tx.status?.confirmed) continue;

    let inputsFromUs = 0;
    let outputsToUs = 0;
    let outputsToExternal = 0;
    let totalIn = 0;
    let totalOut = 0;

    for (const vin of tx.vin || []) {
      const prev = vin.prevout;
      if (!prev) continue;
      const value = Number.parseInt(prev.value) || 0;
      totalIn += value;
      if (addressSet.has(prev.scriptpubkey_address)) inputsFromUs += value;
    }

    for (const vout of tx.vout || []) {
      const value = Number.parseInt(vout.value) || 0;
      totalOut += value;
      if (addressSet.has(vout.scriptpubkey_address)) outputsToUs += value;
      if (externalSet.has(vout.scriptpubkey_address)) outputsToExternal += value;
    }

    const created = tx.status?.block_time ? tx.status.block_time * 1000 : Date.now();

    if (inputsFromUs) {
      // Outgoing transaction
      const net = outputsToUs - inputsFromUs;
      if (net >= 0) continue;

      const amount = totalOut - outputsToUs;
      if (amount <= 0) continue;

      const existing = await getPayment(tx.txid);
      if (existing?.aid === id) continue;
      if (existing) {
        existing.aid = id;
        await db
          .multi()
          .set(`payment:${existing.id}`, JSON.stringify(existing))
          .lPush(`${id}:payments`, existing.id)
          .exec();
        continue;
      }

      const fee = Math.max(0, totalIn - totalOut);
      const p = {
        id: v4(),
        aid: id,
        amount: -amount,
        fee,
        hash: tx.txid,
        confirmed: true,
        rate,
        currency,
        type: PaymentType.bitcoin,
        uid,
        created,
      };

      await db
        .multi()
        .set(`payment:${tx.txid}`, p.id)
        .set(`payment:${p.id}`, JSON.stringify(p))
        .lPush(`${id}:payments`, p.id)
        .set(`${id}:payments:last`, p.created)
        .exec();
    } else if (outputsToExternal) {
      // Incoming transaction (to external addresses, not from us)
      for (const vout of tx.vout || []) {
        const value = Number.parseInt(vout.value) || 0;
        if (value < 300) continue;
        if (!externalSet.has(vout.scriptpubkey_address)) continue;

        const voutIndex = tx.vout.indexOf(vout);
        const ref = `${tx.txid}:${voutIndex}`;
        const existing = await getPayment(ref);
        if (existing?.aid === id) {
          if (!existing.confirmed) {
            existing.confirmed = true;
            await s(`payment:${existing.id}`, existing);
          }
          continue;
        }

        if (existing) {
          existing.aid = id;
          existing.confirmed = true;
          await db
            .multi()
            .set(`payment:${existing.id}`, JSON.stringify(existing))
            .lPush(`${id}:payments`, existing.id)
            .exec();
          continue;
        }

        const p = {
          id: v4(),
          aid: id,
          amount: value,
          fee: 0,
          hash: vout.scriptpubkey_address,
          confirmed: true,
          rate,
          currency,
          type: PaymentType.bitcoin,
          uid,
          ref,
          created,
        };

        await db
          .multi()
          .set(`payment:${ref}`, p.id)
          .set(`payment:${p.id}`, JSON.stringify(p))
          .lPush(`${id}:payments`, p.id)
          .set(`${id}:payments:last`, p.created)
          .exec();

        newPayments.push(p);
      }
    }
  }

  return { confirmedTotal, pendingTotal, newPayments };
};

export const importAccountHistory = async (account) => {
  try {
    const user = await getUser(account.uid);
    const { confirmedTotal } = await syncBitcoinVault(account, user);

    await tbSetBalance(account.id, confirmedTotal);
    await tbSetPending(account.id, 0);

    account.importedAt = account.importedAt || Date.now();
    await s(`account:${account.id}`, account);
  } catch (e) {
    console.log(e);
    warn("problem importing account history", e.message, account);
  }
};

export const check = async () => {
  if (process.env.URL.includes("dev")) return;
  try {
    const payments = await db.sMembers("pending");

    for (const pr of payments) {
      if (!String(pr).startsWith("ln")) {
        await db.sRem("pending", pr);
        continue;
      }
      const p = await getPayment(pr);
      if (!p || Date.now() - p.created < 10000) continue;
      if (inFlight.has(String(pr))) continue;
      const { pays } = await outLn.listpays(String(pr));

      const failed = !pays.length || pays.every((p) => p.status === "failed");
      const completed = pays.find((p) => p.status === "complete");

      try {
        if (completed) await finalize(completed, p);
        else if (failed) await reverse(p);
      } catch (e) {
        err("failed to finalize", p.id, e.message);
        if (e.message?.includes("already been reversed")) {
          await db.sRem("pending", p.hash);
        }
      }
    }
  } catch (e) {
    err("payment check failed", e.message);
  }

  setTimeout(check, 5000);
};

const finalize = async (r, p) => {
  let { preimage } = r;
  if (!preimage) preimage = r.preimage;
  if (!preimage) preimage = r.payment_preimage;

  // LND fallback often returns base64 preimages or missing preimage fields
  if (!preimage || (typeof preimage === 'string' && !/^[0-9a-fA-F]{64}$/.test(preimage))) {
    try {
      const { pays } = await outLn.listpays(p.hash);
      const completedPay = pays.find((x) => x.status === "complete");
      if (completedPay?.preimage) {
        preimage = completedPay.preimage;
      }
    } catch {}
  }

  if (!preimage) fail("missing preimage");

  // Ensure preimage is a hex string (LND sometimes returns base64)
  if (typeof preimage === 'string' && !/^[0-9a-fA-F]+$/.test(preimage)) {
    try {
      preimage = Buffer.from(preimage, 'base64').toString('hex');
    } catch {}
  }

  await db.sRem("pending", p.hash);
  l("payment completed", p.id, preimage);

  const maxfee = p.fee;
  p.ref = preimage;
  p.preimage = preimage; // Ensure preimage is available for frontend & Nostr emit
  // The HTLC settled (we have the preimage) — the send is now fully confirmed.
  p.confirmed = true;

  // Attempt to emit a Nostr Zap receipt if this payment was a NIP-57 zap
  try {
    let inv = await getInvoice(p.hash);
    if (inv?.memo?.includes("9734")) {
      inv.payment_preimage = preimage;
      inv.paid_at = Math.floor(Date.now() / 1000);
      const { handleZap } = await import("$lib/nostr");
      try {
        await handleZap(inv, p.uid);
      } catch (e: any) {
        warn("failed to emit zap receipt", p.id, e?.message);
      }
    }
  } catch (e: any) {
    warn("failed to emit zap receipt from finalize", p.id, e?.message);
  }

  // Best-effort: compute actual fee from invoice amount vs amount sent.
  // For open bolt11s (no amount in the invoice — typical for LNURL-pay)
  // decode returns no amount_msat, so fall back to the debited amount.
  // Wrap in try so a refund failure can't strand the payment without
  // notifying the UI — preimage is already in hand.
  try {
    const decoded: any = await ln.decode(p.hash);
    const invoiceMsat =
      decoded.amount_msat || decoded.invoice_amount_msat || Math.abs(p.amount) * 1000;
    l("finalize", p.id, "amount_sent_msat", r.amount_sent_msat, "invoice_msat", invoiceMsat);
    p.fee = Math.max(0, Math.round((r.amount_sent_msat - invoiceMsat) / 1000));
    if (!Number.isFinite(p.fee)) p.fee = maxfee;

    if (!(await g(`payment:${p.id}`)).ref) {
      await s(`payment:${p.id}`, p);
      l("refunding fee", maxfee, p.fee, maxfee - p.fee, p.ref);
      await tbRefund(p.uid, maxfee - p.fee);
    }
  } catch (e: any) {
    warn("finalize: fee/refund step failed", p.id, e?.message ?? String(e));
    // Still persist the preimage so the payment shows as completed even
    // if the refund step couldn't run.
    try {
      if (!(await g(`payment:${p.id}`)).ref) await s(`payment:${p.id}`, p);
    } catch {}
  }

  nwcNotify(p);

  emit(p.uid, "payment", p);
  return p;
};

export const reverse = async (p) => {
  await sleep(Math.floor(Math.random() * (1500 - 500 + 1)) + 500);

  const total = Math.abs(p.amount) + p.fee + p.ourfee;
  const ourfee = p.ourfee || 0;
  const credit = Math.round(total * config.fee[PaymentType.lightning]) - ourfee;

  l("reversing", p.id, p.amount, p.fee, total, ourfee, credit);

  // Check payment still exists before reversing
  const exists = await db.exists(`payment:${p.id}`);
  if (!exists) throw new Error("Payment has already been reversed");

  // TB: restore balance + credits
  await tbReverse(p.uid, total, credit);

  // Redis: clean up payment records
  await db
    .multi()
    .del(`payment:${p.id}`)
    .sRem("pending", p.hash)
    .del(`payment:${p.hash}`)
    .lRem(`${p.uid}:payments`, 0, p.id)
    .lRem("payments", 0, p.id)
    .exec();

  warn("reversed", p.id);
  emit(p.uid, "payment", { id: p.id, hash: p.hash, uid: p.uid, type: p.type, reversed: true });
};

const freezeCheck = async () => {
  // Each asset is fetched independently so e.g. lq being unreachable doesn't
  // prevent lightning and bitcoin limits from refreshing.
  let lnbalance: number | undefined;
  try {
    const funds = await ln.listfunds();
    lnbalance = Math.round(funds.channels.reduce((a, b) => a + b.our_amount_msat, 0) / 1000);
  } catch (e: any) {
    warnThrottled("freezeCheck lightning", e.message);
  }

  let bcbalance: number | undefined;
  try {
    bcbalance = Math.round((await bc.getBalance()) * SATS);
  } catch (e: any) {
    warnThrottled("freezeCheck bitcoin", e.message);
  }

  let lqbalance: number | undefined;
  try {
    const { bitcoin } = await lq.getBalance();
    lqbalance = Math.round(bitcoin * SATS);
  } catch (e: any) {
    warnThrottled("freezeCheck liquid", e.message);
  }

  if (lnbalance !== undefined) {
    const lnthreshold = await g("lightning:threshold");
    const lim = Math.max(lnbalance - lnthreshold, 0);
    for (const t of ["lightning", "fund", "ecash", "bolt12"]) {
      await withLimitLock(t, async () => { await s(`${t}:limit`, lim); });
    }
  }
  if (bcbalance !== undefined) {
    const bcthreshold = await g("bitcoin:threshold");
    await withLimitLock("bitcoin", async () => {
      await s("bitcoin:limit", Math.max(bcbalance - bcthreshold, 0));
    });
  }
  if (lqbalance !== undefined) {
    const lqthreshold = await g("liquid:threshold");
    await withLimitLock("liquid", async () => {
      await s("liquid:limit", Math.max(lqbalance - lqthreshold, 0));
    });
  }

  setTimeout(freezeCheck, 10000);
};
setTimeout(freezeCheck, 10_000);

const KEEP_LND_TIMEOUT = 30_000;
const withDeadline = <T>(p: Promise<T>, label: string) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${KEEP_LND_TIMEOUT}ms`)),
      KEEP_LND_TIMEOUT,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

export const keepLndConnected = async () => {
  try {
    if (!lnd || !(config as any).lnd?.clnp2p) return;
    const { id } = (await withDeadline(ln.getinfo(), "ln.getinfo")) as any;
    const connected = await withDeadline(lnd.isPeerConnected(id), "lnd.isPeerConnected");
    if (!connected) {
      l("lnd: CLN peer disconnected, reconnecting...");
      await withDeadline(lnd.connectPeer(id, (config as any).lnd.clnp2p), "lnd.connectPeer");
    }
  } catch (e: any) {
    warn("lnd reconnect", e?.message ?? String(e));
  } finally {
    setTimeout(keepLndConnected, 60_000);
  }
};
