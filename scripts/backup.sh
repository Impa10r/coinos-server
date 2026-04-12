#!/usr/bin/env bash
# Backup coinos data to a remote server.
# Run every 2 minutes via launchd or cron.
#
# Required env vars:
#   BACKUP_HOST  e.g. dietpi@192.168.1.101
#   TARGET_HOME  home dir on backup server, e.g. /home/dietpi

set -euo pipefail

BACKUP_HOST="${BACKUP_HOST:?Set BACKUP_HOST=user@host}"
TARGET_HOME="${TARGET_HOME:?Set TARGET_HOME=/home/user}"
BASE="${HOME}/coinos-server/data"
DEST="${BACKUP_HOST}:${TARGET_HOME}/coinos-server/data"

# --- TigerBeetle: pause → copy → unpause (pause lasts <1s) ---
STAGE="/tmp/tb-snapshot/0_0.tigerbeetle"
mkdir -p "$(dirname "$STAGE")"
docker pause tb
cp "${BASE}/tigerbeetle/0_0.tigerbeetle" "$STAGE"
docker unpause tb
rsync -az --inplace "$STAGE" "${DEST}/tigerbeetle/"

# --- Valkey: request a background save, then rsync ---
docker exec db valkey-cli BGSAVE SCHEDULE 2>/dev/null || true
rsync -az --delete "${BASE}/db/" "${DEST}/db/"

# --- Kvrocks ---
rsync -az --delete "${BASE}/archive-kv/" "${DEST}/archive-kv/"

# --- CLN: hsm_secret + channel DB ---
rsync -az --delete \
  "${BASE}/lightning/config" \
  "${BASE}/lightning/bitcoin/hsm_secret" \
  "${BASE}/lightning/bitcoin/lightningd.sqlite3" \
  "${BASE}/lightning/bitcoin/lightningd.sqlite3-wal" \
  "${BASE}/lightning/bitcoin/lightningd.sqlite3-shm" \
  "${DEST}/lightning/bitcoin/" 2>/dev/null || true

# --- LND: wallet + channel DB ---
rsync -az --delete --exclude=chan-backup-archives \
  "${HOME}/.lnd/data/chain/bitcoin/mainnet/" \
  "${HOME}/.lnd/data/graph/mainnet/" \
  "${HOME}/.lnd/lnd.conf" \
  "${DEST}/lnd/" 2>/dev/null || true
