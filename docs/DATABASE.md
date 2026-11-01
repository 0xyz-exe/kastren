# Database design

PostgreSQL schema and generated migration: `services/api/prisma/schema.prisma` and `services/api/prisma/migrations/20261026000000_initial/migration.sql`.

| Table | Purpose | Integrity |
|---|---|---|
| `users` | credentials/profile | unique normalized email |
| `sessions` | persisted session hashes and expiry | unique token hash, cascade with owner |
| `accounts` | account metadata + opening amount | `(id,user_id)` unique for owner-bound references |
| `categories` | income/expense categories | per-owner `(name,type)` unique; owner-bound ID |
| `transactions` | income/expense/transfer ledger rows | indexed owner/time, composite owner/account/category FK |

Amounts use PostgreSQL `BIGINT` integer currency minor units and API JSON decimal strings. Never parse `amountMinor` as JS `number` in a financial calculation. Opening amount is balance seed, not income. Transactions in another currency cannot be combined or applied to account balance. Transfer is one row containing source, destination, amount, currency; both balances apply opposing legs. Only same-currency transfers accepted.

Ownership composite foreign keys stop references to another owner's accounts/category even if an API validation regresses. ORM checks enforce transfer/category semantics. DB-specific `CHECK` constraints for positive amounts and allowed kind values are not yet added. Database migrations are generated but not applied/tested because Docker engine is not running. Accounts/categories currently have archival timestamps; no archive routes yet.

`GET /dashboard/summary` replays transaction history to calculate balances and month totals. It queries all user rows; not a scalable optimization, and no pagination on this internal aggregation. Optimize after measurement (query grouped aggregate / compact append-only ledger / snapshots with reconciliation). Do not add a second mutable balance source without a deterministic reconciliation invariant.
