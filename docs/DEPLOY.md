# Deploying Stokku

Owner: Deployment. Free-tier staging path (Render + Neon, Singapore) and the
Fly.io alternative: see [infra/deploy/README.md](../infra/deploy/README.md).
This file is the short operational reference.

## Environment variables (API, `services/api`)

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres DSN the **API** connects with. Must be the **non-superuser role `stokku`** — see below. |
| `JWT_SECRET` | yes | HMAC secret for access tokens. Generate: `openssl rand -base64 48`. |
| `APP_BASE_URL` | yes | Public base URL of the web app, no trailing slash (CORS, share links). |
| `PORT` | no | Listen port, default `8080`. `BIND_ADDR` overrides the whole address. |
| `MIGRATION_DATABASE_URL` | no | Admin (superuser) DSN used **only** by `scripts/migrate.sh`. It must name **the same database** as `DATABASE_URL` — the migrations run on this DSN, so pointing it at another database (e.g. `.../postgres`) silently migrates the wrong one. **Never the API's runtime DSN.** |
| `STOKKU_TEST_ADMIN_URL` | no | Admin DSN for the DB-backed `cargo test`s only. **Never the API's runtime DSN.** |

Set them via `.env` (gitignored; copy `.env.example`) or the platform's
secrets (never in git).

## The RLS rule

The API **must** connect as the non-superuser role `stokku`. Row-level
security is `FORCE`d on every tenant table, but a superuser connection
bypasses RLS **silently** — the API would see every tenant with no error at
all. The admin DSNs above exist only because migrations (0010 auth functions)
and the test harness need a superuser; keep the split strict.

## Migrations

From zero or incremental, one command:

```sh
make migrate                                  # DATABASE_URL from .env
# or explicitly as an admin (needed where the app role is not superuser):
MIGRATION_DATABASE_URL=postgres://postgres@host:port/SAME_DB_AS_DATABASE_URL make migrate
```

`make migrate-check` proves the full set applies from zero on a throwaway
database (it always ignores an inherited `MIGRATION_DATABASE_URL`) and that
the seed is idempotent. `make seed` seeds the demo tenant;
`make verify` runs the DB self-checks (RLS, change_log, reconcile).

## Docker / compose

```sh
make up      # postgres:16 + migrate + api + web, healthchecks, data persists in the pgdata volume
make down    # stop (volumes kept)
make images  # multi-arch (amd64+arm64) api + web images via buildx
```

Files: `compose.yml` (postgres + api + web; the one-shot `migrate` service
runs on a `tools` profile), `infra/api.Dockerfile`, `infra/web.Dockerfile`,
`infra/migrate.Dockerfile`, `infra/pg-init.sh` (creates the non-superuser
`stokku` role inside compose), `infra/web.nginx.conf`.

Docker is **not installed** on the current dev machine, so these have never
been executed here — they are config/syntax-verified only (`docker compose
config` runs in CI once the repo is on GitHub). First machine with Docker:
`make up`, then `curl http://localhost:8080/health`.

## Local development

```sh
make dev     # web on :5173 (vite), API via cargo run
make test    # web typecheck+tests, fmt+clippy -D warnings+cargo test, migrate-check
make build
```

Backups: `make backup` (pg_dump -Fc, 7-day retention, copy-paste restore
command; see `infra/backup.sh`).
