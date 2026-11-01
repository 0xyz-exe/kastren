# Security model and release checklist

## Assets and trust boundary

- Assets: financial records, account balances, credentials, session secrets, user identity and exports.
- Actors: authenticated user, unauthenticated client, hostile third-party origin, compromised host/process, service operator.
- Trust boundaries: browser ↔ API; API ↔ PostgreSQL; packaged WebView ↔ remote API.
- Main risks: broken user isolation/IDOR, CSRF, credential stuffing, XSS, SQL injection, secret leakage, unsafe password reset, lost financial history, incorrect transaction mutation, compromised dependencies, insecure native bridge.

## Controls currently implemented

- Argon2id password hashes; opaque random session ID; DB stores SHA-256 token hash. 30-day HttpOnly, SameSite=Strict cookie. Production refuses insecure cookie configuration.
- CSRF token cookie + `x-csrf-token` header, timing-safe match, exact Origin check for authenticated mutations. Credentialed CORS allows only configured frontend origin. Proxy trust disabled; API process binds loopback by default.
- Zod strict object schemas and amount/type/account/category checks. Amounts use positive bounded integer minor units; no float persistence.
- User ID from authenticated session applied to account/category/transaction queries. Composite owner foreign keys constrain transaction account/category references.
- Authentication rate limits, Helmet headers, request-body cap, redaction for cookies/auth headers/password fields; production error messages suppress internal details.
- Account deletion requires password; docs UI available only from loopback.

- Hardened reverse proxy configuration (`deploy/nginx/nginx.conf`) enforcing HSTS, CSP (`default-src 'self'`), buffer overflow protection, rate limiting zones (`/auth/` 5r/m, general API 30r/s), and doc endpoint shielding.
- Multi-stage non-root containerization (`deploy/docker/Dockerfile.api`, `docker-compose.prod.yml`) isolating database and API to private internal networks.
- Cryptographic secret generation utility (`scripts/generate-production-secrets.js`) using `crypto.randomBytes` to prevent weak production keys.
- Automated CI/CD release verification pipeline (`.github/workflows/ci-release.yml`) testing strict typechecking, monorepo unit/integration suites against PostgreSQL service container, and frontend production build.
- PostgreSQL integration and authorization regression tests pass (12/12 test cases verifying session lifecycle, CSRF, balance recalculation on deletion, CSV export, and cross-user isolation).

## Known gaps / release blockers

- No password-reset completion, email delivery, password change, revoke-all sessions or dedicated session expiry cleanup. Reset request responds identically regardless of email existence; completion returns 501.
- No live cloud deployment; TLS certificates, production domain, and offsite automated database backups must be provisioned on the host infrastructure.
- No security audit log, immutable ledger, privacy retention policy or data export/delete verification.
- No attachments, external banks, or native permissions implemented. Do not add filesystem, shell, account-aggregator scopes or native plugins absent a reviewed requirement.
- npm production audit passes; full development audit not yet clean due flagged Prisma 7.10.1 `deepmerge-ts`/`effect` advisories. Re-evaluate advisory status and safe upgrade before release; avoid `npm audit fix --force` without compatibility review.

## Release gates

- [x] Hardened reverse-proxy configuration and production environment templates authored.
- [x] Cryptographic secret generation procedure implemented.
- [x] Automated CI/CD release verification workflow configured.
- [x] PostgreSQL integration and cross-user authorization regression tests pass (12/12).
- [ ] Deploy stack to public infrastructure with Let's Encrypt TLS and DNS verification.
- [ ] Configure mail provider for password reset completion and email verification.
- [ ] Document immutable/append-only financial corrections and account deletion/retention semantics.
- [ ] Configure automated offsite database backups and test point-in-time recovery drill.
- [ ] Production Android APK keystore signing and Play Store release compliance.
