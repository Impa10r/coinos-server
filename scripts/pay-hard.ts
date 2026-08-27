// pay-hard.ts — a "stubborn" Lightning payer for hard destinations.
//
// Motivation (fixedfloat swap, 2026-08-27): xpay/renepay are cost-first. To a
// well-connected but inbound-scarce node (an exchange), the CHEAPEST paths are
// exactly the depleted ones, so cost-optimizing payers keep failing on them —
// and after many failures CLN's askrene "learned capacity" turns pessimistic
// and steers them away from the ONE path that actually has room. The move that
// works is liquidity DISCOVERY, orthogonal to cost: enumerate the destination's
// peers, keep the ones WE can reach (bonus: ones we already channel), and probe
// each `us -> peer -> dest` leg for inbound room at the real amount. Then force
// the payment through the peer that has room.
//
// Strategy:
//   1. Preflight (decode, not-expired, not already-paid, nothing pending).
//   2. Try xpay normally (fast path — covers ~all payments).
//   3. On failure to a hint-less destination: rank the destination's peers
//      (ones we channel with >= amount outbound first), and for each, build a
//      route FORCED through peer->dest (getroute excluding all other dest
//      channels), with the CORRECT final CLTV from the invoice, then PROBE it
//      with a random hash. The first path that reaches the destination gets the
//      real payment.
//
// Safety: probe (unclaimable random hash) before every real send; refuse to
// start if a payment is already pending; if a real send doesn't resolve
// cleanly (still pending), STOP rather than risk a second in-flight payment.
//
// Usage:
//   bun pay-hard.ts <bolt11> [--node=cl|bcln] [--maxfee=<sat>] [--dry]
//                   [--skip-xpay] [--max-peers=N]
//   --node     which node pays (cl = local main node; bcln = boltz node on cs). default cl
//   --maxfee   fee ceiling in sat (default 5000)
//   --dry      find a working path and stop (no real payment)
//   --skip-xpay  go straight to the peer-force strategy
//   --max-peers  how many candidate peers to probe (default 12)
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { randomBytes } from "crypto";

const argv = process.argv.slice(2);
const inv = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const flag = (k: string) => argv.includes(`--${k}`);
const nodeName = opt("node", "cl");
const maxfeeSat = Number(opt("maxfee", "5000"));
const maxPeers = Number(opt("max-peers", "12"));
const DRY = flag("dry");
const skipXpay = flag("skip-xpay");

if (!inv) {
  console.error("usage: bun pay-hard.ts <bolt11> [--node=cl|bcln] [--maxfee=sat] [--dry] [--skip-xpay] [--max-peers=N]");
  process.exit(1);
}

// Node adapters. cl runs locally; bcln runs in a container on the `cs` host.
const NODES: Record<string, { remote: boolean; prefix: string }> = {
  cl: { remote: false, prefix: "docker exec cl lightning-cli" },
  bcln: { remote: true, prefix: "docker exec bcln lightning-cli --lightning-dir=/app/lightning" },
};
const node = NODES[nodeName];
if (!node) { console.error("unknown node:", nodeName, "(use cl or bcln)"); process.exit(1); }

const sh = (c: string) => { try { return execSync(c, { encoding: "utf8", maxBuffer: 1e8 }); } catch (e: any) { return (e.stdout || "") + (e.stderr || ""); } };
// run a shell command ON the node's host (local, or via ssh to cs). Single-quote
// for ssh so $(cat ...) is expanded remotely, not locally. Our route/exclude
// JSON never contains single quotes, so this quoting is safe.
const runOn = (cmd: string) => node.remote ? sh(`ssh -o ConnectTimeout=25 cs '${cmd}'`) : sh(cmd);
const cli = (sub: string) => runOn(`${node.prefix} ${sub}`);
const cliJSON = (sub: string): any => { const o = cli(sub); try { return JSON.parse(o); } catch { return { __raw: o }; } };
const putFile = (path: string, content: string) => { writeFileSync(path, content); if (node.remote) sh(`scp -q ${path} cs:${path}`); };
const log = (...a: any[]) => console.log(...a);
const sat = (msat: number) => Math.round(msat / 1000);

// waitsendpay that returns the parsed result whether it succeeded or failed.
const waitFor = (hash: string, secs = 60): any => { const o = cli(`waitsendpay ${hash} ${secs}`); try { return JSON.parse(o); } catch { return { __raw: o }; } };

// ---- 1. preflight ----
const dec = cliJSON(`decode ${inv}`);
if (!dec || dec.valid === false || !dec.payment_hash) { log("invalid/undecodable invoice:", JSON.stringify(dec).slice(0, 200)); process.exit(1); }
const amount = Number(dec.amount_msat);
const hash = dec.payment_hash;
const secret = dec.payment_secret;
const finalCltv = Number(dec.min_final_cltv_expiry || 18);
const dest = dec.payee;
const hints = (dec.routes || []).length;
if (!amount) { log("amountless invoice not supported"); process.exit(1); }
log(`invoice: ${sat(amount)} sat -> ${String(dest).slice(0, 16)}… | min_final_cltv ${finalCltv} | hints ${hints} | node ${nodeName}`);

const lp = cliJSON(`listpays bolt11=${inv}`);
const alreadyDone = (lp.pays || []).find((p: any) => p.status === "complete");
if (alreadyDone) { log("✅ already paid; preimage:", alreadyDone.preimage); process.exit(0); }
if ((lp.pays || []).some((p: any) => p.status === "pending")) { log("⚠️ a payment for this invoice is already PENDING — not starting another. Wait for it to resolve."); process.exit(1); }

// ---- 2. xpay fast path ----
if (!skipXpay) {
  log(`→ trying xpay (maxfee ${maxfeeSat} sat)…`);
  const x = cliJSON(`-k xpay invstring=${inv} maxfee=${maxfeeSat * 1000}`);
  if (x && x.payment_preimage) { log(`✅ xpay succeeded! preimage: ${x.payment_preimage} | fee ${sat(Number(x.amount_sent_msat) - amount)} sat`); process.exit(0); }
  log("  xpay did not complete:", String(x.__raw || x.message || JSON.stringify(x)).replace(/\s+/g, " ").slice(0, 160));
}

if (hints > 0) { log("invoice carries route hints — the peer-force strategy targets the public destination node and can't honor private hints. Rely on xpay/renepay here."); process.exit(1); }

// ---- 3. peer-force liquidity discovery ----
log("→ peer-force: probing the destination's reachable peers for inbound room…");
const destChans = (cliJSON(`listchannels destination=${dest}`).channels) || [];
if (!destChans.length) { log("destination advertises no public channels — cannot force-route."); process.exit(2); }
const bySource: Record<string, { scids: string[]; cap: number }> = {};
for (const c of destChans) { (bySource[c.source] ||= { scids: [], cap: 0 }); bySource[c.source].scids.push(c.short_channel_id); bySource[c.source].cap = Math.max(bySource[c.source].cap, Number(c.amount_msat || 0)); }
const allScids: string[] = destChans.map((c: any) => c.short_channel_id);

const ours: Record<string, number> = {};
for (const c of ((cliJSON(`listpeerchannels`).channels) || [])) if (c.state === "CHANNELD_NORMAL") ours[c.peer_id] = Number(c.spendable_msat || 0);

// rank: peers we already channel with enough outbound first, then by our
// outbound to them, then by their channel capacity to the destination.
const candidates = Object.entries(bySource)
  .map(([id, info]) => ({ id, scids: info.scids, cap: info.cap, our: ours[id] || 0 }))
  .sort((a, b) => (b.our >= amount ? 1 : 0) - (a.our >= amount ? 1 : 0) || b.our - a.our || b.cap - a.cap)
  .slice(0, maxPeers);
log(`  ${candidates.length} candidates (★ = we already channel with room): ` + candidates.slice(0, 8).map((c) => c.id.slice(0, 8) + (c.our >= amount ? "★" : "")).join(" "));

for (const P of candidates) {
  // force the route to use P->dest as the final hop by excluding every other dest channel
  const excl = allScids.filter((s) => !P.scids.includes(s)).flatMap((s) => [`${s}/0`, `${s}/1`]);
  putFile("/tmp/ph_excl.json", JSON.stringify(excl));
  const rr = cliJSON(`getroute ${dest} ${amount} 10 ${finalCltv + 5} null null "$(cat /tmp/ph_excl.json)"`);
  const route = rr.route;
  if (!route || !route.length) { continue; }
  putFile("/tmp/ph_route.json", JSON.stringify(route));

  // PROBE with an unclaimable random hash (correct amount + correct CLTV)
  const rh = randomBytes(32).toString("hex");
  runOn(`${node.prefix} sendpay "$(cat /tmp/ph_route.json)" ${rh} >/dev/null 2>&1 || true`);
  const wp = waitFor(rh, 45);
  const d = wp.data || wp;
  const fc = d.failcodename || d.failcode || "";
  // "reached the destination" = the DESTINATION node itself rejected the probe
  // (unclaimable hash) with an unknown-payment-details error. Keying on
  // erring_node (not an index) avoids CLN's sender-is-index-0 off-by-one.
  const reached = /UNKNOWN_PAYMENT_DETAILS|INCORRECT_OR_UNKNOWN/.test(String(fc)) && d.erring_node === dest;
  log(`  via ${P.id.slice(0, 12)}… (${route.length}h, out ${sat(P.our)} sat): ${reached ? "✅ reaches destination" : `✗ ${fc || "no reach"}@idx${d.erring_index}`}`);
  if (!reached) continue;

  if (DRY) { log(`DRY: a working path exists via ${P.id.slice(0, 16)}… (route in /tmp/ph_route.json). Not paying.`); process.exit(0); }

  // fire the REAL payment through this route (same route => correct amount+CLTV)
  log(`→ firing real payment via ${P.id.slice(0, 16)}…`);
  cliJSON(`-k sendpay route="$(cat /tmp/ph_route.json)" payment_hash=${hash} bolt11=${inv} payment_secret=${secret} amount_msat=${amount}`);
  const res = waitFor(hash, 70);
  if (res.payment_preimage || res.status === "complete") { log(`🎉 PAID via ${P.id.slice(0, 12)}…! preimage: ${res.payment_preimage} | fee ${sat(Number(res.amount_sent_msat) - amount)} sat`); process.exit(0); }
  const rd = res.data || res;
  const rfc = rd.failcodename || rd.failcode;
  if (!rfc) { log(`⚠️ real send did not resolve cleanly (${String(res.__raw || res.message || "").slice(0, 100)}). STOPPING to avoid a second in-flight payment — check listpays before retrying.`); process.exit(3); }
  log(`  real send failed here: ${rfc}@idx${rd.erring_index} (liquidity shifted). trying next peer…`);
}

log("✗ no reachable peer of the destination had inbound room for the full amount right now.");
log("  (destination inbound is exhausted across all paths we can reach, or the amount is too large for any single peer path.)");
process.exit(2);
