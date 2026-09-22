#!/usr/bin/env bash
# Prepare the regtest stack so test/integration/* can actually run.
#
# The integration suites need a topology nothing sets up automatically:
#
#     clc  <--5M ch--  clb  <--5M ch-->  cl (coinos)
#
# and they need clb to hold real outbound liquidity toward cl, because every
# run funds its test users by having clb pay invoices into coinos. A full pass
# spends roughly 1.5-2.5M sat of that, so the suites go green until the
# liquidity runs out and then start failing for reasons that look like code
# bugs. Re-run this before a test pass; it is idempotent and only does the
# work that is actually missing.
#
# It also repairs the two things that silently break on a cold `compose up`:
# bitcoind sitting in initialblockdownload (regtest clears it by mining), and
# lightning peers never reconnecting afterwards, which leaves channels in
# CHANNELD_NORMAL but marked disabled in gossip so every payment fails with
# "All N channels to the source are disabled".
#
# Usage:  ./scripts/regtest-setup.sh
#         TARGET_CLB_OUT_SAT=8000000 ./scripts/regtest-setup.sh

set -euo pipefail

TARGET_CLB_OUT_SAT=${TARGET_CLB_OUT_SAT:-5000000}
CHANNEL_SAT=${CHANNEL_SAT:-5000000}
CHUNK_SAT=${CHUNK_SAT:-1000000}

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

cli() { local c=$1; shift; docker exec "$c" lightning-cli "$@" 2>/dev/null; }
bcli() { docker exec bc bitcoin-cli "$@" 2>/dev/null; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

# ---------------------------------------------------------------- guard
# This script mines blocks and opens channels. Refuse to do that anywhere but
# regtest, where both are free and meaningless.
chain=$(bcli getblockchaininfo | jget "d['chain']" || true)
if [ "$chain" != "regtest" ]; then
  echo "refusing: bitcoind reports chain='${chain:-unreachable}', not regtest" >&2
  exit 1
fi

# ---------------------------------------------------------------- bitcoind
step "bitcoind"
ibd=$(bcli getblockchaininfo | jget "d.get('initialblockdownload')")
if [ "$ibd" = "True" ]; then
  # On regtest IBD only clears once a block exists with a recent timestamp, so
  # a stack that has been sitting idle comes up "syncing" forever. Mining any
  # block fixes it, and until it does every CLN node refuses to route.
  say "in initialblockdownload — mining 10 blocks to clear it"
  bcli generatetoaddress 10 "$(bcli getnewaddress)" >/dev/null
  sleep 5
fi
say "height $(bcli getblockchaininfo | jget "d['blocks']"), ibd=$(bcli getblockchaininfo | jget "d.get('initialblockdownload')")"

# ---------------------------------------------------------------- clc config
step "clc"
if [ ! -f data/lightningc/config ]; then
  # clc ships with no config at all in a fresh checkout, so its bcli plugin
  # can't find bitcoind, lightningd dies at boot, and lightning-cli then looks
  # in the mainnet datadir — the confusing "Moving into
  # '/root/.lightning/bitcoin': No such file or directory" error.
  say "data/lightningc/config missing — deriving it from lightningb"
  sed 's/^addr=clb:9735$/addr=clc:9735/' data/lightningb/config > data/lightningc/config
  docker restart clc >/dev/null
  sleep 20
fi
if ! cli clc getinfo >/dev/null; then
  say "not responding — restarting"
  docker restart clc >/dev/null
  sleep 20
fi
cli clc getinfo >/dev/null || { echo "clc still down; check 'docker logs clc'" >&2; exit 1; }
say "up at height $(cli clc getinfo | jget "d['blockheight']")"

CL_ID=$(cli cl getinfo | jget "d['id']")
CLB_ID=$(cli clb getinfo | jget "d['id']")
CLC_ID=$(cli clc getinfo | jget "d['id']")

# ---------------------------------------------------------------- peers
step "peer connections"
# Channels survive a restart but the TCP sessions do not, and CLN will not
# reconnect on its own to a peer it has no address for. Without this every
# route lookup fails even though listpeerchannels says CHANNELD_NORMAL.
cli cl connect "$CLB_ID" clb 9735 >/dev/null || true
cli clb connect "$CLC_ID" clc 9735 >/dev/null || true
sleep 3
for n in cl clb clc; do
  say "$n: $(cli $n listpeers | jget "sum(1 for p in d['peers'] if p.get('connected'))") connected peer(s)"
done

# ---------------------------------------------------------------- clb <-> clc
step "clb -> clc channel (the multi-hop leg bolt12.test.ts needs)"
have=$(cli clc listpeerchannels | jget "sum(1 for c in d['channels'] if c.get('state') in ('CHANNELD_NORMAL','CHANNELD_AWAITING_LOCKIN'))")
if [ "${have:-0}" = "0" ]; then
  say "opening ${CHANNEL_SAT} sat from clb"
  cli clb fundchannel "$CLC_ID" "$CHANNEL_SAT" >/dev/null
  for i in $(seq 1 10); do
    bcli generatetoaddress 6 "$(bcli getnewaddress)" >/dev/null
    sleep 10
    st=$(cli clc listpeerchannels | jget "d['channels'][0]['state'] if d['channels'] else 'none'")
    say "waiting for lock-in ($st)"
    [ "$st" = "CHANNELD_NORMAL" ] && break
  done
fi
say "clc channel: $(cli clc listpeerchannels | jget "d['channels'][0]['state'] if d['channels'] else 'none'")"

# ---------------------------------------------------------------- liquidity
step "clb outbound toward cl (target ${TARGET_CLB_OUT_SAT} sat)"
outbound() {
  cli clb listpeerchannels | jget "next((c['to_us_msat']//1000 for c in d['channels'] if c['peer_id']=='$CL_ID'), 0)"
}
cur=$(outbound)
say "currently ${cur} sat"
# cl pays invoices raised on clb, which moves the channel balance to clb's
# side. Chunked because a single huge HTLC can exceed max_htlc_value_in_flight.
while [ "$cur" -lt "$TARGET_CLB_OUT_SAT" ]; do
  inv=$(cli clb invoice $((CHUNK_SAT * 1000)) "regtest-setup-$(date +%s%N)" topup | jget "d['bolt11']")
  [ -z "$inv" ] && { say "could not raise an invoice on clb — stopping"; break; }
  if ! cli cl pay "$inv" >/dev/null; then
    say "cl could not pay — its side of the channel is probably exhausted; stopping"
    break
  fi
  new=$(outbound)
  [ "$new" -le "$cur" ] && { say "no progress — stopping"; break; }
  cur=$new
  say "now ${cur} sat"
done

step "ready"
say "clb -> cl  : ${cur} sat outbound"
say "clb -> clc : $(cli clb listpeerchannels | jget "next((c['to_us_msat']//1000 for c in d['channels'] if c['peer_id']=='$CLC_ID'), 0)") sat outbound"
printf '\nRun the suites with:\n'
printf '  bun test test/integration/            # needs docker on the host\n'
printf "  docker exec app sh -c 'cd /home/bun/app && bun test test/security.test.ts'\n"
