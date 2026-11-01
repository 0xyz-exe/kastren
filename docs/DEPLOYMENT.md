# Kastren Production Deployment & Hardening Guide

This document details the configuration, hardening, and verification required to deploy Kastren to production.

---

## 1. Architecture Overview

In production, Kastren runs as a multi-container stack:
1. **Hardened Nginx Reverse Proxy (`proxy`):**
   - Terminates TLS/HTTPS (TLS 1.2 & 1.3 only).
   - Serves static pre-built Vite client assets with HTTP caching.
   - Enforces rate limiting (`/auth/` and general API).
   - Enforces strict security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).
   - Proxies authenticated requests to the internal API container.
2. **Fastify API Container (`api`):**
   - Runs as a non-root user (`node`) under `dumb-init`.
   - Accessible only via the internal Docker bridge network (`kastren-internal`).
   - Validates CSRF tokens, strict Origin headers, and session cookies (`HttpOnly`, `SameSite=Strict`, `Secure`).
3. **PostgreSQL 17 Database (`db`):**
   - Restricted to `kastren-internal` network (no host ports exposed).
   - Persistent named volume (`kastren-postgres-prod`).

---

## 2. Secrets & Environment Setup

Never use development secrets in production.

### Step 1: Generate Cryptographically Secure Secrets
Run the generation utility on the target host:
```bash
node scripts/generate-production-secrets.js
```
This generates `.env.production` with high-entropy values for `SESSION_SECRET` and `POSTGRES_PASSWORD`.

### Step 2: Configure Public HTTPS Origin
Open `.env.production` and verify:
```ini
NODE_ENV=production
API_PORT=3000
WEB_ORIGIN=https://kastren.yourdomain.com
SESSION_SECRET=<random_64_characters>
POSTGRES_PASSWORD=<random_32_characters>
DATABASE_URL=postgresql://kastren:<encoded_db_password>@db:5432/kastren?schema=public
```

---

## 3. Reverse Proxy & TLS Hardening

The production configuration is located in `deploy/nginx/nginx.conf`:

- **HSTS:** `max-age=63072000; includeSubDomains; preload`
- **CSP:** Strict `default-src 'self'` with Google Fonts allowlist and `frame-ancestors 'none'`.
- **Anti-DoD / Buffer Tuning:** `client_max_body_size 1m; client_body_buffer_size 128k;`.
- **Rate Limiting:**
  - `/auth/`: Max 5 requests per minute with burst of 5 (protects against credential stuffing).
  - General API: Max 30 requests per second with burst of 20.
- **Documentation Shield:** `/docs` and `/documentation` are blocked to external traffic.

### Provisioning Let's Encrypt TLS Certificates
```bash
# Initial certbot challenge
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot --webroot-path=/var/www/certbot \
  -d kastren.yourdomain.com
```

---

## 4. Production Build & Deployment

### Step 1: Build the Static Web Frontend
```bash
npm ci
npm run build
```
This produces optimized production assets in `/dist`.

### Step 2: Apply Database Migrations
```bash
npx prisma migrate deploy --schema services/api/prisma/schema.prisma
```

### Step 3: Launch the Production Stack
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

### Step 4: Verify Service Health
```bash
docker compose -f docker-compose.prod.yml ps
curl -I https://kastren.yourdomain.com/health
```

---

## 5. Automated Backup Procedure

Set up a daily cron task to export an encrypted backup of PostgreSQL:

```bash
#!/usr/bin/env bash
# /opt/kastren/backup.sh
set -euo pipefail

BACKUP_DIR="/var/backups/kastren"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/kastren_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

docker compose -f /opt/kastren/docker-compose.prod.yml exec -T db \
  pg_dump -U kastren kastren | gzip > "${BACKUP_FILE}"

# Keep only the last 30 days of backups
find "${BACKUP_DIR}" -name "kastren_*.sql.gz" -mtime +30 -delete

echo "Backup successful: ${BACKUP_FILE}"
```
Schedule via crontab:
```cron
0 2 * * * /opt/kastren/backup.sh >> /var/log/kastren-backup.log 2>&1
```

---

## 6. Verification & Monitoring

- **CI/CD Automation:** Every commit is validated via `.github/workflows/ci-release.yml` (typecheck, 12 integration tests with real PostgreSQL, build verification).
- **Log Inspection:** Logs are redacted by Fastify to prevent password, token, or session leakage:
  ```bash
  docker compose -f docker-compose.prod.yml logs -f api
  ```
