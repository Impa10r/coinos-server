#!/usr/bin/env bash
# Send L-BTC on Liquid regtest and trigger coinos to process it.
# Usage: ./scripts/regtest-send-liquid.sh <address> <amount>
#   e.g. ./scripts/regtest-send-liquid.sh el1qq... 1

set -euo pipefail

ADDRESS="${1:?Usage: $0 <address> <amount>}"
AMOUNT="${2:?Usage: $0 <address> <amount>}"
API="${COINOS_URL:-http://localhost:3119}"

echo "Sending ${AMOUNT} L-BTC to ${ADDRESS}..."
TXID=$(docker exec lq elements-cli sendtoaddress "$ADDRESS" "$AMOUNT")
echo "txid: $TXID"

echo "Mining a block..."
docker exec lq elements-cli generatetoaddress 1 "$(docker exec lq elements-cli getnewaddress)" > /dev/null

echo "Notifying coinos..."
curl -s -X POST "$API/confirm" \
  -H "Content-Type: application/json" \
  -d "{\"txid\": \"$TXID\", \"wallet\": \"coinos\", \"type\": \"liquid\"}" | python3 -m json.tool

echo "Done."
