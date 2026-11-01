# Architecture

## Implemented shape

```text
React + TypeScript + Vite web client
           │ HTTPS / JSON / cookie session
           ▼
Fastify API (Node.js + TypeScript) ── Prisma 7 adapter-pg ── PostgreSQL
```

`apps/web` is the current UI. `services/api/src/app.ts` contains injectable Fastify routes and application policy; `server.ts` owns process, connection pool and shutdown. Prisma/PostgreSQL schema lives in `services/api/prisma`. The financial engine is a dependency-free TS module in `packages/financial-engine` using `bigint` minor units. Vite package output remains one web bundle; route-level lazy loading, separate desktop and mobile targets remain unimplemented.

## Decisions

- Browser state remains illustrative; wire a small API client to persisted user data before using as a finance app. API client currently supports session credentials and CSRF header.
- Shared web UI may be packaged in Tauri and Capacitor, but the present repo has no shell configuration. Avoid opening filesystem/shell native capabilities unless a verified product need appears.
- Web API uses cookie sessions, not local-storage bearer tokens. PostgreSQL owner-composite foreign keys reinforce API-level ownership checks.
- Dashboard currently aggregates persisted API transactions at request time. It is exact for integer units but reads all user transactions; optimize when realistic data/query measurements warrant.
- No FX conversion. Each account and transaction must use the same ISO-like three-character currency. One report response does not sum balances across multiple currencies; frontend demo remains USD and conflicts with requested default IDR until backend UI integration.

## Required next architecture slice

A single owner-scoped UI vertical slice: register/login/logout, create accounts/categories/transactions, query persisted ledger, dashboard summary computed only from persisted records. Add PostgreSQL integration tests that prove owner isolation, transfer paired balance effects and mutation behavior. Then implement dedicated domain models for budgets, goals, recurrence, debts, settings and auditing. Avoid claiming their routes/features based on currently decorative navigation.

## Production checklist

- TLS reverse proxy; exact HTTPS `WEB_ORIGIN`; secure cookie; strong unique `SESSION_SECRET` and database credentials.
- Secure secret distribution, migrations/backup/recovery, rate limiting strategy, CORS origin, monitoring, restore test.
- Argon2id, CSRF+Origin validation, Helmet, strict Zod schemas and user-scoped queries are implemented; validate controls through integration tests before deployment.
- Remove password reset routes from release or add a real one-time expiring signed token flow through an approved mail provider, token hashing/rate-limit/anti-enumeration and regression tests.
- Add immutable financial audit/event policy, data retention/deletion policy, logging redaction review, privacy terms and applicable legal review.
