# Stokku — Inventaris UMKM

Bookkeeping for Indonesian micro and small shops: stock in, money in, one honest **laba rugi** out.

Bahasa Indonesia first · IDR rupiah · offline-first · works in any modern browser · QRIS at checkout.

- **Stok** — items, barcodes, units, 3-tap stock-in, running average cost
- **Kas** — cash book, expenses, payables/receivables
- **Penjualan** — cart, credit sales, void, receipts
- **Laba rugi** — revenue, HPP, gross, opex, net — every number drills down
- **Multi-perangkat** — local SQLite + outbox, sync when online; staff roles with server-side capability checks

## Quick start

You need: [Node.js 22+](https://nodejs.org) with [pnpm](https://pnpm.io), [Rust](https://rustup.rs), and [PostgreSQL 16+](https://www.postgresql.org).

```sh
git clone https://github.com/kiaraaskura/stokku.git && cd stokku
cp .env.example .env        # then edit: DATABASE_URL, JWT_SECRET, APP_BASE_URL
make migrate                # create schema (from zero)
make seed                   # optional: demo tenant "Warung Bu Sri"

# terminal 1 — API on the port the web client expects
(cd services/api && PORT=8099 cargo run)

# terminal 2 — web
(cd apps/web && pnpm dev)   # open http://localhost:5173
```

Demo login (after `make seed`): `owner@demo.test` / `Demo1234!`

`make dev` starts both processes but puts the API on 8080, while the web client's default is `http://localhost:8099`. Until that is wired, use the two terminals above, or start the web app with `VITE_API_URL=http://localhost:8080`.

Other commands: `make test` (web tests, API tests + clippy, migration check) · `make build` · `make up` / `make down` (Docker: postgres + api + web) · `make release` (one-command release bundle) · `make backup` (pg_dump with 7-day retention).

Env vars and the migration step: [docs/DEPLOY.md](docs/DEPLOY.md). Which platform runs what: [docs/PLATFORMS.md](docs/PLATFORMS.md).

## Known gaps

- **Docker:** `make up` is included, but the web image is built without `VITE_API_URL`, so it calls `http://localhost:8099` while compose publishes the API on 8080. The page loads; login cannot reach the API until that build argument is wired.
- **Native apps:** the Tauri and Capacitor shells are placeholders. Browsers and the PWA are the supported clients.
- **PWA offline:** the service worker registers only on HTTPS or `localhost`. Opening the build over a plain `http://` LAN address gives you the app, but not the install/offline cache.

## Platforms

| Platform | Status |
|---|---|
| Linux, Windows, macOS — **any browser** | ✓ works today (web app + API) |
| Linux — native API binary | ✓ `make build` (Rust, single binary) |
| Windows — WSL2 | ✓ same as Linux |
| Windows — Docker | — `make up` present, not verified (see known gaps) |
| Android, iPhone, iPad — browser / PWA | ✓ works today, over HTTPS or localhost |
| Android, Windows, macOS native app | planned — Capacitor / Tauri shells (`apps/mobile`, `apps/desktop` are placeholders) |

Details and limits: [docs/PLATFORMS.md](docs/PLATFORMS.md).

## Layout

```
apps/web            React + Vite app (the client — offline-first, local SQLite)
apps/desktop        Tauri 2 shell (placeholder, planned)
apps/mobile         Capacitor shell (placeholder, planned)
services/api        Rust axum API + sqlx migrations
packages/shared     DTOs shared by web and API
infra               deploy, Dockerfiles, compose, backup, release
docs                specs: PRD, API contract, data model, acceptance
```

## Conventions

- Money: integer rupiah, no floats. Qty: `NUMERIC(14,3)`. IDs: UUIDv7.
- UTC storage, rendered in the outlet timezone.
- Every tenant's data is isolated by **forced row-level security** — the API always connects as a non-superuser role.
- User-visible strings via i18n (Indonesian default, English secondary).

## Docs

[PRD](docs/PRD.md) · [tasks](docs/TASKS.md) · [API contract](docs/API_CONTRACT.md) · [data model](docs/DATA_MODEL.md) · [decisions](docs/DECISIONS.md) · [acceptance](docs/ACCEPTANCE.md) · [deploy](docs/DEPLOY.md)

## Status

MVP core complete and green: acceptance, API, web and two-device sync suites all pass (`make test` runs them). Native app shells and store listings are the remaining roadmap. License: [MIT](LICENSE).

Progress log: [PROGRESS.md](PROGRESS.md) · version history: [CHANGELOG.md](CHANGELOG.md).
