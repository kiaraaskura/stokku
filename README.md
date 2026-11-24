# Stokku — Inventaris UMKM

Bookkeeping for Indonesian micro and small shops: stock + money in, one honest **laba rugi** out. Bahasa Indonesia first, IDR, offline-first, QRIS at checkout.

Docs: [PRD](docs/PRD.md) · [tasks](docs/TASKS.md) · [work split](docs/WORKSPLIT.md) · [API contract](docs/API_CONTRACT.md) · [data model](docs/DATA_MODEL.md) · [decisions](docs/DECISIONS.md) · [acceptance](docs/ACCEPTANCE.md)

## Layout

```
apps/web            React + Vite app (also the PWA shell)
apps/desktop        Tauri 2 shell          (Sprint 4)
apps/mobile         Capacitor shell        (Sprint 4)
services/api        Rust axum API + sqlx migrations
packages/shared     DTOs + zod schemas shared by web and API
infra               deploy, backup, compose
docs                specs
```

## Command contract

These are the commands every member may rely on; Deployment implements them.

| Command | Does |
|---|---|
| `make dev` | web + API locally, hot reload |
| `make migrate` | run Postgres migrations from zero |
| `make seed` | idempotent demo tenant |
| `make test` | web tests, API tests, clippy, migration check |
| `make build` | production build of every app |
| `make up` | docker compose: postgres + api + web |
| `make down` | stop compose |

Env: copy `.env.example` to `.env`; required at minimum `DATABASE_URL`, `JWT_SECRET`, `APP_BASE_URL`.

## Conventions

- Branches per member (`backend`, `frontend`, `db`, `deploy`), worktrees under `/home/kiara/OpenBot/Shared/wt/`. Only the Captain merges to `main`.
- Money integer rupiah; qty `NUMERIC(14,3)`; IDs UUIDv7; UTC storage, outlet timezone display.
- User-visible strings in `i18n` (id default, en secondary). No hardcoded Indonesian in components.
- Every mutating client write gets a UUIDv7 `op_id` and an outbox row in the same local transaction.

## Status

Sprint 0 skeleton. Demo spine target: shop → item → stock in → sale → payment → laba rugi, offline, with a second device syncing.