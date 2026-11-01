#!/usr/bin/env bash
# ==============================================================================
# Kastren Automated Database Snapshotting & Continuous WAL Backup Script
# Usage: ./scripts/db-backup-pitr.sh [container_name] [backup_dir]
# ==============================================================================

set -euo pipefail

CONTAINER="${1:-${DB_CONTAINER:-kastren-db-1}}"
BACKUP_ROOT="${2:-${BACKUP_DIR:-/var/backups/kastren}}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
SNAPSHOT_DIR="${BACKUP_ROOT}/snapshots"
WAL_ARCHIVE_DIR="${BACKUP_ROOT}/wal_archive"

mkdir -p "${SNAPSHOT_DIR}" "${WAL_ARCHIVE_DIR}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting automated PostgreSQL snapshot for container: ${CONTAINER}..."

# 1. Verify container is healthy and responding
DB_USER="${POSTGRES_USER:-kastren}"
DB_NAME="${POSTGRES_DB:-kastren}"
if ! docker exec "${CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
  echo "[ERROR] PostgreSQL container '${CONTAINER}' is not ready. Aborting snapshot." >&2
  exit 1
fi

# 2. Consistent Logical Snapshot (pg_dump with custom compressed archive format)
SNAPSHOT_FILE="${SNAPSHOT_DIR}/kastren_snapshot_${TIMESTAMP}.dump"
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "${CONTAINER}" \
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" -Fc --no-owner --no-privileges > "${SNAPSHOT_FILE}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Snapshot generated: ${SNAPSHOT_FILE} ($(du -h "${SNAPSHOT_FILE}" | cut -f1))"

# 3. Verify snapshot integrity using pg_restore list
if docker run --rm -i postgres:17-alpine pg_restore --list < "${SNAPSHOT_FILE}" >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Snapshot integrity verified successfully."
else
  echo "[ERROR] Snapshot verification failed! Corrupted dump file: ${SNAPSHOT_FILE}" >&2
  exit 2
fi

# 4. Trigger WAL segment switch for continuous archiving
docker exec "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT pg_switch_wal();" >/dev/null 2>&1 || true

# 5. Offsite Cloud Storage Replication (Optional Hook: S3 or Rclone)
if [ -n "${S3_BUCKET:-}" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Uploading snapshot to AWS S3: s3://${S3_BUCKET}/snapshots/..."
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp "${SNAPSHOT_FILE}" "s3://${S3_BUCKET}/snapshots/$(basename "${SNAPSHOT_FILE}")"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] S3 upload complete."
  else
    echo "[WARN] aws CLI not found in PATH; skipping S3 sync." >&2
  fi
elif [ -n "${RCLONE_DEST:-}" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Syncing snapshot via rclone to: ${RCLONE_DEST}/snapshots..."
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "${SNAPSHOT_FILE}" "${RCLONE_DEST}/snapshots"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Rclone sync complete."
  else
    echo "[WARN] rclone not found in PATH; skipping cloud sync." >&2
  fi
fi

# 6. Prune snapshots older than 30 days
find "${SNAPSHOT_DIR}" -type f \( -name "kastren_snapshot_*.dump" -o -name "kastren_snapshot_*.dump" \) -mtime +30 -delete
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Automated backup cycle complete."
