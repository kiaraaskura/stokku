# Stokku Web (apps/web)

React 19 + Vite + TypeScript front end for Stokku. Bahasa Indonesia default, English secondary. No UI kit — plain CSS with design tokens in `src/styles/tokens.css`.

## Storage choice (T-201/T-202)

**sql.js (SQLite compiled to WASM) running in a dedicated Web Worker, persisted to OPFS** (Origin Private File System) via a sync access handle on `stokku.db`.

- The worker owns the only database handle. The main thread talks to it through an async RPC (`src/db/store.ts`).
- Every mutating repository call is wrapped in a SQLite `SAVEPOINT` transaction that writes the business row **and its outbox op (UUIDv7 `op_id`)** atomically, then flushes the database file to OPFS — so a kill at any moment leaves a consistent, committed state.
- Fallback: when OPFS is unavailable the database lives in memory for the session only (flagged in the UI via `persisted: false`).
- Sync is not implemented yet (next increment): ops accumulate in the `outbox` table and the sync dot shows the pending count.

The UI never calls the network or SQL directly — only the `Repository` interface (`src/db/store.ts`) backed by `repoMethods` (`src/db/repo.ts`), so a server-backed adapter can slot in later.

## Layout

```
src/
  styles/        tokens.css (design tokens), base.css (shell), primitives.css
  i18n/          id/en dictionaries + provider (no i18n dependency)
  lib/           money (integer rupiah, milli-unit qty), date (Asia/Jakarta), uuidv7
  db/            schema, repo (posting engine), sqlite.worker (OPFS), store (Repository)
  components/    Button, Input, CurrencyInput, Sheet, Table, states, SyncDot
  features/      onboarding, items, stock-in, sales cart, cash book, laba rugi
  dev/           /dev route showing every primitive and state
```

## Commands

```sh
pnpm install
pnpm dev        # vite dev server
pnpm test       # vitest (money formatter, posting engine, atomicity)
pnpm build      # tsc + vite production build
```

## Data conventions

- Money: integer rupiah, never floats. `formatIDR(1234567)` → `Rp1.234.567`.
- Qty: integer milli-units (`qty * 1000`) mirroring `NUMERIC(14,3)` without float drift.
- IDs and `op_id`: client-generated UUIDv7.
- `business_date`: `YYYY-MM-DD` in the outlet timezone (Asia/Jakarta default).

## Implemented (first increment)

T-006 design tokens + primitives with `/dev` gallery · T-008 i18n + IDR/date formatters · T-205 app shell (bottom nav mobile / sidebar desktop) · T-201/T-202 local persistence + outbox · T-210 onboarding (resumable) · T-211/T-212/T-213 item list/form/3-tap stock-in · T-216 sales cart with atomic local posting · T-402 laba rugi with drill-downs · minimal cash book (needed to record opex; full T-217 is Sprint 2).
