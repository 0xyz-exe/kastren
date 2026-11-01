# Kastren — Project Snapshot

**Product:** Smart money management. **Tagline:** Take Control of Your Money.
**Workspace:** `/apps/web` (shared React web UI), `/packages/financial-engine` (exact integer minor-unit rules), `/services/api` (Fastify API). This is a deliberately staged build, not yet a complete finance platform.

## Phase 1 — Repository & environment audit

- Created the new isolated repo `C:/Users/wondr/HermesWorkspace/kastren`; existing workspace projects untouched.
- Verified Node `v26.10.0`, npm `11.19.1`, Git `2.53.0.windows.3`, PHP `8.5.0`; Docker CLI exists but daemon unavailable. Rust/Cargo unavailable on PATH.
- Initial npm install collided with a concurrent install and failed `ENOTEMPTY`, with many `ENOENT` warnings. A second controlled install (`--ignore-scripts --no-audit --no-fund`) is running; wait for it before validation.
- No DB daemon available; PostgreSQL migrations are generated, DB tests skip until configured. `.env.example` is local-dev-only sample; replace secret before any server exposure.

## Initial vertical slice and API foundation

- React/TypeScript/Vite responsive Kastren dashboard with real interactive local transaction create/delete/search/CSV export, dark theme, summary calculated from transaction rows + initial sample ledger, accessible controls, mobile navigation.
- Fastify/Prisma API includes registration/login/logout, argon2id password hashes, hashed opaque 30-day HttpOnly/SameSite session cookies, CSRF token and Origin checks, rate limits, allowlisted CORS, Helmet headers, redacted logs, input schemas, user-scoped account/category/transaction CRUD, owner-composite foreign keys, OpenAPI JSON/YAML, account-deletion endpoint, summary aggregation. Password-reset delivery is intentionally unavailable: request is enumeration-safe and completion returns 501.
- PostgreSQL migration SQL generated from the Prisma schema. Schema currently covers users, sessions, accounts, categories, transactions; budgets/savings/debts/repeats/audit log not yet implemented.
- Financial-engine functions: account balance and paired internal transfer legs; income/expense cash flow excludes transfers; budget utilization and savings progress. Uses bigint integer minor units; rejects non-positive money and mixed currencies.
- Unit tests in `packages/financial-engine/test/engine.test.ts`.
- Important boundary: dashboard stores demo/sample data and user edits in browser `localStorage`, not a server or database. Not appropriate for real financial records. Widgets still labeled by UI include roadmap/stub interactions. Static chart/category visualization currently illustrative, not data-derived. Replace demo layer after backend/auth exists.

## Implementation roadmap

1. Current checks: TS typecheck, frontend build, engine tests and API security-boundary tests run; PostgreSQL integration cannot run until local Docker daemon is available.
2. Replace dashboard local demo data with API-backed auth/user data; derive all visible charts and categories from persisted source data. Add UI flow tests.
3. Implement budgets, savings, recurring (idempotent), debts, reports/settings, audit log, forgot-password email/token flow, password change, session revoke-all, account archive workflow.
4. Expand database integration tests, cross-user access regression, deployment, security docs, full E2E.
5. Add Tauri/Capacitor after installing/checking toolchains; no desktop/mobile build claims until verified.

## Decisions / rules

- Stack per brief: React+TS+Vite, Fastify+TS, PostgreSQL+Prisma; no extra web-state or chart libraries until needed. pnpm/workspaces not yet adopted.
- Money held as bigint integer minor units. Supported single-currency transaction ledger only; multi-currency calculations fail closed, no implied FX.
- Opening balances are account equity, excluded from income. Transfers alter both accounts but not income/expense cash flow. Edits/deletes must mutate immutable ledger safely (future server implementation must use DB transactions/audit history).
- Core architecture, security checklist, DB design, test plan remain incomplete. Desktop/mobile shells absent; offline-sync absent.
