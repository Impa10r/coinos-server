#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/../.env" ] && set -a && source "$SCRIPT_DIR/../.env" && set +a

docker exec -it db valkey-cli -a "${DB_PASSWORD:?Set DB_PASSWORD in .env}" --no-auth-warning get "user:$1"
