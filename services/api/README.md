# Stokku API (services/api)

One Rust binary: axum 0.8 + tokio + sqlx 0.8 with **runtime queries only**
(no `sqlx::query!` compile-time macros, per docs/WORKSPLIT.md §1.4).
Binary name: `stokku-api`.

## Run

```bash
cp ../../.env.example ../../.env   # DATABASE_URL, JWT_SECRET, APP_BASE_URL
cargo run --release                # binds 0.0.0.0:8080, or BIND_ADDR/PORT
```

Env vars:

| Var | Meaning |
|---|---|
| `DATABASE_URL` | Postgres URL as the **non-superuser** role `stokku` (forced RLS binds it; superuser would silently bypass) |
| `JWT_SECRET` | HS256 secret for access JWTs (15 min) |
| `BIND_ADDR` / `PORT` | listen address (default `0.0.0.0:8080`) |
| `BUILD_HASH` | optional, compiled into `GET /health` |
| `RUST_LOG` | tracing filter, default `info` |

Migrations live in `services/api/migrations` (owned by the DB member) and
must be applied by a **superuser** (migration 0010 needs it): see
`scripts/migrate.sh` / `make migrate`.

## Test

```bash
STOKKU_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:PORT/postgres cargo test
```

Each DB test creates a throwaway database, migrates as the superuser,
grants the app role `stokku`, and connects **as the app role** so forced
RLS is exercised for real. Without the env var the DB tests skip.

- `tests/ledger_property.rs` — sum(qty deltas) == stock_level over 2500
  random ops (checked continuously, not just at the end); cost_avg never
  negative; negative stock allowed and flagged.
- `tests/auth_flow.rs` — signup/login/refresh rotation, reuse ⇒ revoke all,
  staff capability matrix + 403s.

## Endpoints

Base `/v1`, JSON. Error envelope exactly per docs/API_CONTRACT.md "Errors".
Auth: `Authorization: Bearer <access_jwt>`.

- `POST /auth/signup|login|refresh|logout`, `GET /me`
- `GET/POST /items`, `GET/PATCH/DELETE /items/{id}`, `GET /items/search?q=`,
  `GET /items/{id}/ledger`
- `GET/POST /categories`
- `GET/POST /stock-moves`, `POST /stock-moves/{id}/reverse`,
  `POST /stock-moves/preview-reverse/{id}`
- `GET/POST /cash-entries`, `DELETE /cash-entries/{id}` (reversal entry),
  `GET /cash-categories`
- `GET/POST /sales`, `GET /sales/{id}`, `POST /sales/{id}/void`
- `GET /reports/laba-rugi?from=&to=&compare=`,
  `GET /reports/laba-rugi/drill?line=revenue|hpp|opex`
- `GET /health` (public: build hash + DB status)

Money is integer rupiah; qty is serialized as a JSON number (parsed from
number or decimal string, max 3 dp); IDs are UUIDv7; every write runs in a
transaction with `set_app_context(tenant, user)` so RLS scopes every query.

## Notes / known gaps (see channel report)

- `sale` has no `note` column in docs/DATA_MODEL.md or the DB schema, but
  the API contract's sale body carries one — not stored, reported as a
  contract gap rather than inventing a column.
- `/sales/daily` (T-132) is Sprint 2, not built here.
- Op-id idempotency is recorded in `op_log` on the REST writes that take an
  `op_id`; replaying one returns `{"duplicate": true, ...}` (the full
  `/sync` protocol is the next increment).
