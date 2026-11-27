# Stokku

**Catatan stok dan uang untuk UMKM Indonesia.** Simple bookkeeping for Indonesian micro and small shops: record stock in and out, record money in and out, and get one number you can trust — your real profit (*laba rugi*) — without accounting jargon.

Built for a warung, toko, laundry, katering, or bengkel. Bahasa Indonesia, rupiah, WIB/WITA/WIT, and QRIS at checkout.

```mermaid
flowchart LR
  A[Barang masuk] --> B[Stok]
  B --> C[Penjualan]
  B --> D[Stok opname]
  C --> E[Buku kas]
  D --> B
  E --> F[Laba rugi]
  C --> F
```

## What it does

| Area | What you get |
|---|---|
| Stock | Items, units and conversions, barcodes, stock in/out, stock opname, low and dead stock |
| Money | Sales, cash book, operating expenses, payables and receivables |
| Profit | Revenue − cost of goods − operating expenses = net profit, every line drillable to its transactions |
| Offline | Core flows work without a connection; changes queue and sync when it returns |
| Roles | Owner sees everything; staff cannot see cost price or profit |
| Data | CSV exports, a printable profit report, and a full account archive the owner can download |

## Status: v0.1 demo

The web app is finished and tested: item list, stock in/out, sales, cash book, stock opname, profit report, contacts and bills, offline sync across two devices, exports, and owner/staff permissions.

The native shells (Tauri for desktop, Capacitor for Android/iOS) are **not built yet**. See [Platform support](docs/PLATFORMS.md) for exactly what runs where today.

## Run it

Three options. The release bundle is the path that has been tested end to end.

### Option 1 — release bundle (tested)

You need PostgreSQL 17 and Python 3 (for a static file server). The bundle contains `api/`, `web/`, and `db/`.

```sh
# 1. Database
export DATABASE_URL="postgres://stokku:CHANGE_ME_PASSWORD@127.0.0.1:5432/stokku"
export MIGRATION_DATABASE_URL="postgres://postgres@127.0.0.1:5432/stokku"
./db/migrate.sh
./db/seed.sh

# 2. API (terminal 1)
DATABASE_URL="$DATABASE_URL" JWT_SECRET="$(openssl rand -base64 48)" \
  APP_BASE_URL="http://127.0.0.1:8080" PORT=8099 ./api/stokku-api

# 3. Web (terminal 2)
cd web && python3 -m http.server 8080 --bind 127.0.0.1
```

Open <http://127.0.0.1:8080> and sign in with the demo shop:

- Owner: `owner@demo.test` / `Demo1234!`
- Staff: `staff@demo.test` / `Demo1234!`

`MIGRATION_DATABASE_URL` must name the **same database** as `DATABASE_URL`; it is an admin login used to run migrations, not a different database.

### Option 2 — Docker

```sh
cp .env.example .env    # fill in the passwords
make up                 # postgres + api + web, migrated and seeded
make down               # stop, data is kept
```

The compose stack is included but was not run in the environment this build came from (no Docker daemon there), so treat it as the less-travelled path.

### Option 3 — from source

You need Node 20+, pnpm, Rust, and PostgreSQL 17.

```sh
pnpm install
cp .env.example .env    # fill in DATABASE_URL and JWT_SECRET
make migrate
make seed
make dev                # web on :5173, API on :8080
```

`make dev` is documented but was not exercised in the build environment; the tested path is Option 1.

## Platforms

| Platform | Browser today | Native app | Notes |
|---|---|---|---|
| Windows 10+ | ✓ | — | Chrome, Edge, Firefox |
| Linux (Ubuntu 22.04+) | ✓ | — | Chrome, Firefox |
| macOS 12+ | ✓ | — | Safari, Chrome |
| Android 8+ | ✓ | — | Chrome; 2 GB RAM is the target floor |
| iOS 15+ | ✓ | — | Safari |

"Browser today" means the web app runs there. The API must be reachable from that device; see [docs/PLATFORMS.md](docs/PLATFORMS.md) for the LAN and hosting steps, and for what each native shell still needs.

## Repository map

```
apps/web            React + Vite web app (the real client today)
apps/desktop        Tauri 2 shell          — placeholder (T-203)
apps/mobile         Capacitor shell        — placeholder (T-204)
services/api        Rust + axum API, sqlx migrations
packages/shared     DTOs and zod schemas shared by web and API
infra               Dockerfiles, compose assets, deploy scripts
docs                product and engineering docs
scripts             migrate, seed, verify helpers
```

## Docs

- [Product requirements](docs/PRD.md) · [task breakdown](docs/TASKS.md)
- [Platform support](docs/PLATFORMS.md) · [deploying](docs/DEPLOY.md)
- [API contract](docs/API_CONTRACT.md) · [data model](docs/DATA_MODEL.md)
- [Decisions](docs/DECISIONS.md) · [acceptance criteria](docs/ACCEPTANCE.md)

## Conventions

- Money is integer rupiah. Quantity is `NUMERIC(14,3)`. IDs are UUIDv7.
- Timestamps are stored in UTC; the outlet timezone is used for display and business dates.
- User-visible strings live in `i18n` (Indonesian default, English secondary).
- Every mutating client write gets a UUIDv7 `op_id` and an outbox row in the same local transaction.

## Data and privacy

Financial data is sensitive. The app has no ad SDKs and no third-party analytics with payloads. A draft Indonesian privacy policy (UU PDP) is being finalised before release.

## Licence

No licence has been chosen yet. Until one is added, the default is all rights reserved. Pick one before publishing if you want others to reuse the code.