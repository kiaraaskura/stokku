# Stokku Web (apps/web)

React 19 + Vite + TypeScript front end for Stokku. Bahasa Indonesia default, English secondary. No UI kit — plain CSS with design tokens in `src/styles/tokens.css`.

## API wiring (demo-spine increment)

- `src/api/client.ts` is the single HTTP layer: base URL from `VITE_API_URL` (default `http://localhost:8099`), `/v1` prefix, one place for auth headers, and **401 → refresh once → retry → logout** when the refresh fails. Components never call `fetch`.
- Auth screens (`/login`) do login + signup against the real API. **Token storage: access token + session in `sessionStorage` (per-tab, survives reloads — including offline reloads — until the 15-min access token expires), refresh token in `localStorage`** (`stokku.refresh_token`); a reload restores the session from the per-tab cache and refreshes when needed.
- Read path (items, item detail/ledger, cash book, sales list, laba rugi + drill-downs) hits the API when online and **writes responses through to the local SQLite store** (`server_cache` table + item rows), so offline still renders the last known numbers.
- Write path is remote-first when online: the API response is cached locally. On network failure the write lands in the local store optimistically **and queues an outbox op** exactly as before.
- Outbox flush (`src/sync/flush.ts`): when online with a session, queued ops replay against their contract endpoints in client order. An op is removed **only after a confirmed 2xx**; network failure keeps it queued and the retry sends the **same op_id**, so the server dedupes (verified for `/sales` and `/stock-moves`; `POST /items` and `POST /cash-entries` have no op_id in the contract — see the known-gaps note). Rejected ops (4xx/5xx) are marked failed and stop blocking the queue. **No `/sync/push` is called yet** — that endpoint is Backend's next increment; queue-and-retry is this pass's contract.
- Roles: `/me` capabilities drive the UI — staff see no reports nav, no cost fields, no HPP/profit (the API 403s them anyway).
- The sync dot reflects reality: Offline (red) > "Belum sinkron" when ops are queued > "Tersinkron" only when the API confirmed everything. In local-only mode it says "Mode lokal".

## Storage choice (T-201/T-202)

**sql.js (SQLite compiled to WASM) running in a dedicated Web Worker, persisted to OPFS** (Origin Private File System) on `stokku.db`.

- The worker owns the only database handle. The main thread talks to it through an async RPC (`src/db/store.ts`).
- Every mutating repository call is wrapped in a SQLite `SAVEPOINT` transaction that writes the business row **and its outbox op (UUIDv7 `op_id`)** atomically, then flushes the database file to OPFS before replying — so a kill at any moment leaves a consistent, committed state.
- Flush path: OPFS sync access handle when the browser supports it, otherwise the standard `FileSystemWritableFileStream` (async, serialized), otherwise memory-only for the session (flagged in the UI via `persisted: false`).
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
pnpm dev        # vite dev server (set VITE_API_URL to point at the API; default http://localhost:8099)
pnpm test       # vitest (money formatter, posting engine, atomicity, API client, outbox flush)
pnpm build      # tsc + vite production build
```

## Install as an app (Windows, Linux, Android, iOS)

The web build is an installable PWA — one codebase, installs as a real app on all four platforms:

- `public/manifest.webmanifest` + generated icons (`public/icon.svg`, `public/icons/`, `public/apple-touch-icon.png`)
- `public/sw.js` service worker; the build (`vite.config.ts`, plugin `stokku-sw-precache`) injects the full precache list and a per-build version, so the whole app works offline after the first visit. `src/pwa.test.ts` locks all of this in CI.

Install paths: **Android** Chrome menu → "Tambahkan ke layar utama" · **iOS** Safari Share → "Tambahkan ke Layar Utama" · **Windows/Linux** Chrome/Edge address-bar install icon. Browsers only register service workers in secure contexts, so serve over HTTPS (or `localhost`); `pnpm build && pnpm preview` is enough to try it locally.

## Data conventions

- Money: integer rupiah, never floats. `formatIDR(1234567)` → `Rp1.234.567`.
- Qty: integer milli-units (`qty * 1000`) mirroring `NUMERIC(14,3)` without float drift.
- IDs and `op_id`: client-generated UUIDv7.
- `business_date`: `YYYY-MM-DD` in the outlet timezone (Asia/Jakarta default).

## Implemented (first increment)

T-006 design tokens + primitives with `/dev` gallery · T-008 i18n + IDR/date formatters · T-205 app shell (bottom nav mobile / sidebar desktop) · T-201/T-202 local persistence + outbox · T-210 onboarding (resumable) · T-211/T-212/T-213 item list/form/3-tap stock-in · T-216 sales cart with atomic local posting · T-402 laba rugi with drill-downs · minimal cash book (needed to record opex; full T-217 is Sprint 2).
