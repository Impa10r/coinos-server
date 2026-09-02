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

[ -f "${HOME}/coinos-server/.env" ] && set -a && source "${HOME}/coinos-server/.env" && set +a

# --- TigerBeetle: pause → copy → unpause (pause lasts <1s) ---
STAGE="/tmp/tb-snapshot/0_0.tigerbeetle"
mkdir -p "$(dirname "$STAGE")"
docker pause tb
cp "${BASE}/tigerbeetle/0_0.tigerbeetle" "$STAGE"
docker unpause tb
rsync -az --inplace "$STAGE" "${DEST}/tigerbeetle/"

# --- Valkey: request a background save, then rsync ---
docker exec db valkey-cli -a "${DB_PASSWORD:?Set DB_PASSWORD in .env}" --no-auth-warning BGSAVE SCHEDULE 2>/dev/null || true
rsync -az --delete "${BASE}/db/" "${DEST}/db/"

# --- Kvrocks ---
rsync -az --delete "${BASE}/archive-kv/" "${DEST}/archive-kv/"

# --- CLN: full directory, preserving structure ---
rsync -az --delete --exclude=cln.log --exclude=.gossip_store\
  "${BASE}/lightning/" "${DEST}/lightning/" 2>/dev/null || true

# --- CLN: hsm_secret separately for upload 
rsync -az 
  "${BASE}/lightning/bitcoin/hsm_secret" "${BACKUP_HOST}:${TARGET_HOME}/hsm_secret" 2>/dev/null || true

# --- LND: full directory, preserving structure ---
rsync -az --delete --exclude=chan-backup-archives --exclude=logs \
  "${HOME}/.lnd/" "${DEST}/lnd/" 2>/dev/null || true

# --- LND: channel backup separately for upload
rsync -az \
  "${HOME}/data/chain/bitcoin/mainnet/channel.backup" "${BACKUP_HOST}:${TARGET_HOME}/channel.backup" 2>/dev/null || true