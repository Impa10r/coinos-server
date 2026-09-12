#!/usr/bin/env bash
#
# Set up the outbound mail relay on the VPS — the half that makes coinos.pro's
# own DMARC policy pass.
#
# The domain publishes `p=reject; adkim=s; aspf=s`, the strictest setting
# there is. Relaying through Gmail cannot satisfy it: Gmail rewrites the
# envelope sender to the authenticating account, so SPF never aligns with
# coinos.pro, and it signs as gmail.com, so DKIM never aligns either. Mail sent
# that way is flagged by lenient receivers and rejected by the rest — which is
# the likely reason account-verification email was not arriving.
#
# Sending from a host we control fixes both: the envelope sender stays
# @coinos.pro (SPF aligns strictly) and OpenDKIM signs with d=coinos.pro (DKIM
# aligns strictly).
#
# This is the VPS side. The app side is the `mail` service in compose, a
# Postfix null client that forwards here over WireGuard so the app holds no
# credentials and gets queuing if the tunnel drops.
#
# DRY RUN BY DEFAULT, like the other scripts here — it prints what it would do
# and changes nothing. Pass --apply to act.
#
#   sudo ./setup-mail-relay.sh                 # inspect
#   sudo ./setup-mail-relay.sh --apply         # do it
#
# Overridable:  DOMAIN SELECTOR WG_IP WG_SUBNET MYHOSTNAME

set -euo pipefail

DOMAIN=${DOMAIN:-coinos.pro}
SELECTOR=${SELECTOR:-mail}
WG_IP=${WG_IP:-10.9.0.11}
WG_SUBNET=${WG_SUBNET:-10.9.0.0/24}
MYHOSTNAME=${MYHOSTNAME:-$(hostname -f 2>/dev/null || hostname)}
KEYDIR=/etc/dkimkeys
STAMP=$(date +%Y%m%d-%H%M%S)

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run()  { if [[ $APPLY -eq 1 ]]; then "$@"; else say "   would run: $*"; fi; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# For steps that must not abort the script. `postfix check` and systemctl can
# fail for environment reasons, and under `set -e` that killed the run before
# the DNS records were printed — losing the one output the operator needs, with
# no indication anything was missing.
soft() {
  if [[ $APPLY -eq 0 ]]; then say "   would run: $*"; return 0; fi
  if ! "$@"; then
    say "   WARNING: '$*' failed (continuing — see above for its output)"
    SOFT_FAILED=1
  fi
}
SOFT_FAILED=0

[[ $EUID -eq 0 ]] || die "run with sudo"

say "domain     $DOMAIN"
say "selector   $SELECTOR"
say "hostname   $MYHOSTNAME"
say "listen on  127.0.0.1 and $WG_IP (submission from $WG_SUBNET only)"
[[ $APPLY -eq 1 ]] || say "
DRY RUN — nothing will be changed. Re-run with --apply."

# ---------------------------------------------------------------- preflight
# These are the things that cannot be fixed later, so check before installing.
step "preflight"

PUB4=$(curl -s -4 --max-time 10 ifconfig.me || true)
[[ -n "$PUB4" ]] || die "could not determine the public IPv4 address"
say "   public IPv4: $PUB4"

# Port 25 egress. Most providers block it silently; without it nothing can be
# delivered directly and the rest of this is pointless.
if timeout 10 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25; head -c 3 <&3' 2>/dev/null | grep -q 220; then
  say "   port 25 egress: ok"
else
  die "port 25 egress blocked or filtered — ask the provider to open it"
fi

# Forward-confirmed reverse DNS. Receivers check both directions; a PTR that
# does not resolve back to this IP is rejected outright by Google.
PTR=$(timeout 10 host "$PUB4" 2>/dev/null | awk '/domain name pointer/ {print $NF}' | sed 's/\.$//' || true)
if [[ -z "$PTR" ]]; then
  say "   WARNING: no PTR for $PUB4 — ask the provider to set one"
else
  FWD=$(timeout 10 host "$PTR" 2>/dev/null | awk '/has address/ {print $NF}' | head -1 || true)
  if [[ "$FWD" == "$PUB4" ]]; then
    say "   rDNS: $PTR -> $PUB4 (forward-confirmed)"
  else
    say "   WARNING: $PTR resolves to '${FWD:-nothing}', not $PUB4 — receivers will reject"
  fi
fi

# Postfix refuses a myhostname that is not fully qualified, and reports it by
# exiting non-zero from `postfix check` with NO message at all — so catch it
# here where the cause can be stated. `hostname -f` returns a bare name on a
# host with no domain set (and inside a container).
#
# Suggest the PTR name rather than something under $DOMAIN: postfix HELOs as
# myhostname, and receivers prefer that to match reverse DNS. The PTR already
# forward-confirms, so using it is consistent for free, whereas a name under
# $DOMAIN needs the provider to change the PTR as well. It makes no difference
# to DMARC either way — alignment is about the envelope and From domains.
if [[ "$MYHOSTNAME" != *.* ]]; then
  die "MYHOSTNAME is '$MYHOSTNAME', which is not fully qualified — postfix requires a FQDN.
       Re-run with the name this host's reverse DNS already points at:
         sudo env MYHOSTNAME=${PTR:-mail.$DOMAIN} $0 --apply"
fi
say "   hostname is fully qualified: $MYHOSTNAME"
if [[ -n "$PTR" && "$MYHOSTNAME" != "$PTR" ]]; then
  say "   NOTE: HELO name differs from reverse DNS ($PTR) — some receivers penalise that"
fi

# ------------------------------------------------------------------ install
step "packages"
if command -v postconf >/dev/null && command -v opendkim >/dev/null; then
  say "   postfix and opendkim already installed"
else
  run apt-get update -qq
  # Preseed so postfix does not open an interactive configuration dialog.
  if [[ $APPLY -eq 1 ]]; then
    debconf-set-selections <<< "postfix postfix/main_mailer_type select Internet Site"
    debconf-set-selections <<< "postfix postfix/mailname string $DOMAIN"
  fi
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y postfix opendkim opendkim-tools bind9-host
fi

# ------------------------------------------------------------------ backups
# Never modify mail config without a copy — a broken main.cf takes outbound
# mail down silently, and that includes the alerts that would tell you.
step "backups"
for f in /etc/postfix/main.cf /etc/postfix/master.cf /etc/opendkim.conf; do
  if [[ -f "$f" ]]; then
    run cp -a "$f" "$f.bak-$STAMP"
    say "   $f -> $f.bak-$STAMP"
  fi
done

# ------------------------------------------------------------------ postfix
step "postfix"
# postconf -e edits in place rather than rewriting the file, so anything else
# already configured here survives.
pc() { run postconf -e "$1"; say "   $1"; }

pc "myhostname = $MYHOSTNAME"
pc "mydomain = $DOMAIN"
pc "myorigin = \$mydomain"
# No local delivery: this host has no mailboxes. Inbound for the domain is
# Cloudflare Email Routing and must stay there.
pc "mydestination ="
pc "local_transport = error: local delivery is disabled"
# THE IMPORTANT LINE. Listening only on loopback and the WireGuard address
# means there is no public listener at all, so this can never be an open relay
# no matter what the restrictions below say. Outbound still works: that is the
# smtp client, not smtpd.
pc "inet_interfaces = 127.0.0.1, $WG_IP"
# IPv4 only. Google rejects rather than spam-folders IPv6 mail that misses any
# authentication detail, and there is nothing to gain by taking that risk.
pc "inet_protocols = ipv4"
pc "mynetworks = 127.0.0.0/8 $WG_SUBNET"
# Belt and braces with inet_interfaces: accept relaying only from the tunnel.
pc "smtpd_relay_restrictions = permit_mynetworks, reject"
pc "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination"
pc "smtp_tls_security_level = may"
pc "maillog_file = /var/log/mail.log"
# Hand every message to OpenDKIM for signing. accept (not reject) on milter
# failure so a broken signer degrades to unsigned mail rather than halting
# outbound entirely — unsigned gets rejected by DMARC, but the queue survives
# and the cause is visible in the log.
pc "milter_default_action = accept"
pc "milter_protocol = 6"
pc "smtpd_milters = inet:127.0.0.1:8891"
pc "non_smtpd_milters = inet:127.0.0.1:8891"

# Submission on 587, reachable only on the interfaces above.
if ! grep -qE '^submission[[:space:]]+inet' /etc/postfix/master.cf 2>/dev/null; then
  if [[ $APPLY -eq 1 ]]; then
    printf 'submission inet n - y - - smtpd\n  -o syslog_name=postfix/submission\n' >> /etc/postfix/master.cf
  fi
  say "   enabled submission (587) in master.cf"
else
  say "   submission already present in master.cf"
fi

# ------------------------------------------------------------------ opendkim
step "opendkim"
if [[ -f "$KEYDIR/$SELECTOR.private" ]]; then
  # Regenerating would invalidate the key already published in DNS and break
  # every message until the new one propagates. Never overwrite silently.
  say "   key exists at $KEYDIR/$SELECTOR.private — keeping it"
else
  run mkdir -p "$KEYDIR"
  run opendkim-genkey -b 2048 -d "$DOMAIN" -s "$SELECTOR" -D "$KEYDIR"
  run chown opendkim:opendkim "$KEYDIR/$SELECTOR.private"
  run chmod 600 "$KEYDIR/$SELECTOR.private"
  say "   generated a 2048-bit key"
fi

if [[ $APPLY -eq 1 ]]; then
  cat > /etc/opendkim.conf <<EOF
Syslog                  yes
UMask                   007
Socket                  inet:8891@127.0.0.1
PidFile                 /run/opendkim/opendkim.pid
UserID                  opendkim
Domain                  $DOMAIN
Selector                $SELECTOR
KeyFile                 $KEYDIR/$SELECTOR.private
# relaxed/simple survives the header rewriting some relays do; strict
# canonicalization breaks signatures over trivial whitespace changes.
Canonicalization        relaxed/simple
Mode                    s
SubDomains              no
EOF
fi
say "   wrote /etc/opendkim.conf (socket 127.0.0.1:8891)"

step "restart"
soft systemctl enable --now opendkim
soft systemctl restart opendkim
soft postfix check
soft systemctl restart postfix

# ---------------------------------------------------------------------- dns
step "DNS records to publish in Cloudflare"
say ""
say "1. SPF — add this host to the existing record, keeping Email Routing:"
say "   coinos.pro  TXT"
say "     v=spf1 include:_spf.mx.cloudflare.net ip4:$PUB4 ~all"
say ""
say "2. DKIM — the public key:"
if [[ -f "$KEYDIR/$SELECTOR.txt" ]]; then
  say "   $SELECTOR._domainkey.$DOMAIN  TXT"
  sed 's/^/     /' "$KEYDIR/$SELECTOR.txt"
else
  say "   (generated on --apply; it will be printed at $KEYDIR/$SELECTOR.txt)"
fi
say ""
say "3. DMARC — leave as is. p=reject with strict alignment is correct, and"
say "   this setup is what finally satisfies it."

step "verify, once DNS has propagated"
say "   opendkim-testkey -d $DOMAIN -s $SELECTOR -vvv     # key matches DNS"
say "   docker exec -it app bun scripts/test-alert.ts     # from the app host"
say "   then check the received headers show: spf=pass dkim=pass dmarc=pass"
say ""
say "   A new sending IP has no reputation, so expect some spam-foldering at"
say "   first. Your DMARC rua= reports and Google Postmaster Tools are how you"
say "   watch that, rather than guessing from whether one test arrived."

if [[ $APPLY -eq 1 && $SOFT_FAILED -eq 1 ]]; then
  say ""
  say "NOTE: a restart or check step failed above. The configuration and keys"
  say "are in place, but verify the services are actually running before"
  say "relying on this:  systemctl status postfix opendkim"
fi

[[ $APPLY -eq 1 ]] || say "
DRY RUN — nothing was changed. Re-run with --apply."
