#!/usr/bin/env bash
# List all completed CLN payments to a given destination node, with the
# originating coinos user resolved. Lines tagged "(reversed?)" had no
# coinos payment record and likely got reversed despite settling on LN —
# the sendLightning exploit signature.
#
# Usage:
#   ./scripts/pays-to-node.sh <node_pubkey>

set -euo pipefail

DEST="${1:?Usage: $0 <node_pubkey>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/../.env" ] && set -a && source "$SCRIPT_DIR/../.env" && set +a
REDIS="docker exec db redis-cli -a ${DB_PASSWORD:?Set DB_PASSWORD in .env} --no-auth-warning"

docker exec cl lightning-cli --lightning-dir=/app/lightning listpays \
  | jq -r --arg d "$DEST" '.pays[]
      | select(.destination==$d and .status=="complete")
      | "\(.bolt11)\t\(.amount_sent_msat)\t\(.completed_at)"' \
  | while IFS=$'\t' read -r bolt11 sent ts; do
      pid=$($REDIS GET "payment:$bolt11" 2>/dev/null | tr -d '"')
      if [ -n "$pid" ] && [ "$pid" != "(nil)" ]; then
        uid=$($REDIS GET "payment:$pid" | jq -r .uid)
        user=$($REDIS GET "user:$uid" | jq -r '.username // "(deleted)"')
      else
        uid="(none)"
        user="(reversed?)"
      fi
      printf "%s  %10d msat  sfx=%s  user=%-20s  uid=%s\n" \
        "$(date -u -r "$ts" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$ts")" \
        "$sent" \
        "$(echo "$bolt11" | tail -c 9)" \
        "$user" "$uid"
    done | sort
