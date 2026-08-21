#!/bin/bash
USERID="${1:?Usage: $0 <user-uuid>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/../.env" ] && set -a && source "$SCRIPT_DIR/../.env" && set +a
REDIS="docker exec db redis-cli -a ${DB_PASSWORD:?Set DB_PASSWORD in .env} --no-auth-warning"

# Get all invoice hashes from user's list
HASHES=$($REDIS LRANGE "${USERID}:invoices" 0 -1)

for HASH in $HASHES; do
  INV=$($REDIS GET "invoice:${HASH}")

  if [ -z "$INV" ]; then continue; fi

  # bolt12 invoices: type is "bolt12"
  TYPE=$(echo "$INV" | jq -r '.type // empty')
  INV_HASH=$(echo "$INV" | jq -r '.hash // empty')

  if [[ "$TYPE" == "bolt12" ]] ; then
    echo "Deleting bolt12 invoice: $INV_HASH"
    $REDIS DEL "invoice:${HASH}"
    $REDIS LREM "${USERID}:invoices" 0 "$HASH"
  fi
done

echo "Done."
