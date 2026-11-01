# Kastren Database Backup, PITR & Failover Architecture

This document defines Kastren's automated snapshotting, Point-In-Time Recovery (PITR), and high-availability failover strategy.

---

## 1. Automated Snapshotting & Backup Schedule

### Backup Tiers
1. **Continuous WAL Archiving:**
   - PostgreSQL logs all transactions sequentially to Write-Ahead Log (WAL) files.
   - WAL segments are copied to an isolated backup directory or object storage bucket upon generation.
2. **Daily Consistent Snapshots:**
   - Created at `02:00 UTC` using `scripts/db-backup-pitr.sh`.
   - Uses PostgreSQL's custom archive format (`pg_dump -Fc`) with zlib compression and atomic catalog isolation.
   - Integrity verified immediately after dump with `pg_restore --list`.

### Cron Automation
```cron
# Daily Snapshot & WAL segment rollover
0 2 * * * /opt/kastren/scripts/db-backup-pitr.sh kastren-db-1 /var/backups/kastren >> /var/log/kastren-backup.log 2>&1
```

---

## 2. Point-In-Time Recovery (PITR)

PITR allows restoring the database to any exact second (e.g. `2026-10-27 14:22:15 UTC`) before an accidental deletion, corruption, or catastrophic host event occurred.

### PITR Recovery Procedure

1. **Stop the Application Services:**
   ```bash
   docker compose -f docker-compose.prod.yml stop api proxy
   ```

2. **Restore the Most Recent Base Snapshot:**
   ```bash
   docker compose -f docker-compose.prod.yml stop db
   # Clear corrupted data directory
   rm -rf /var/lib/postgresql/data/*
   
   # Unpack the base backup snapshot
   tar -xzf /var/backups/kastren/base_backup_latest.tar.gz -C /var/lib/postgresql/data/
   ```

3. **Configure Recovery Target in `postgresql.conf` / `recovery.signal`:**
   Create `/var/lib/postgresql/data/recovery.signal`:
   ```bash
   touch /var/lib/postgresql/data/recovery.signal
   ```
   Append to `/var/lib/postgresql/data/postgresql.auto.conf`:
   ```ini
   restore_command = 'cp /var/backups/kastren/wal_archive/%f %p'
   recovery_target_time = '2026-10-27 14:22:15 UTC'
   recovery_target_action = 'promote'
   ```

4. **Start PostgreSQL Container:**
   ```bash
   docker compose -f docker-compose.prod.yml up -d db
   ```
   PostgreSQL reads the base backup, replays WAL segments up to the exact target millisecond, promotes itself to read-write primary, and deletes `recovery.signal`.

5. **Verify Data & Restart API:**
   ```bash
   docker compose -f docker-compose.prod.yml up -d api proxy
   ```

---

## 3. High-Availability & Failover Strategy

### Primary-Replica Topology (Streaming Replication)
For mission-critical production environments:
- **Primary Node:** Handles all read/write traffic.
- **Standby Node (Hot Standby):** Continuously replicates transactions from primary over TLS (`primary_conninfo = 'host=primary.internal user=replicator password=...'`).
- **Health Check & Failover:**
  - Automated health probes ping `pg_isready` every 5 seconds.
  - If Primary fails 3 consecutive health checks:
    1. Standby node is promoted to primary (`pg_ctl promote`).
    2. Nginx proxy upstream / internal DNS updates target IP to promoted node.
    3. Old primary node rejoins as standby after recovery using `pg_rewind`.
