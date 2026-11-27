# Project progress

**Last updated:** 28 November 2026 · `main` at `ccfade0` · release **v0.1.0**

This is the project logbook: where Stokku stands, how it got here, and what is
still missing. For the version-by-version list, see [CHANGELOG.md](CHANGELOG.md).
For downloads, see [Releases](https://github.com/kiaraaskura/stokku/releases).

## Status at a glance

| Area | State | Evidence |
|---|---|---|
| Web app and PWA | **Done** | item, stock, sales, cash, opname, reports, exports; installable offline |
| Rust API | **Done** | auth, catalog, ledger, cash, sales, reports, sync, exports, invites |
| Database and security | **Done** | 17 migrations; forced RLS; `verify.sh` 0 FAIL |
| Offline and two-device sync | **Done** | push/pull, outbox, two-device gate 24/24 |
| Desktop (Windows, Linux, macOS) | **Built, one fix pending** | installers in v0.1.0; IndexedDB persistence fix on `frontend` |
| Android | **Debug APK built** | not installed on a real device |
| iPhone / iPad | **PWA only** | native build needs a Mac and an Apple account |
| Phone-to-PC QR pairing | **Designed, not built** | [LOCAL_FIRST_SYNC.md](docs/LOCAL_FIRST_SYNC.md) |
| Signing and store listings | **Not started** | needs paid certificates and store accounts |
| Docker one-command stack | **Config only** | page loads, login cannot reach the API yet |

The last task-based count, recorded on 27 November: **57 of 74 core tasks
(77%)** and **58 of 91 full-MVP tasks (64%)**. The release work after that
(public repo, PWA, native shells, installers) sits outside those task lists, so
the percentages are a floor, not the whole picture.

## Timeline

### 24 November — foundations

- PRD, task breakdown, API contract, and data model written.
- PostgreSQL schema, row-level security, change log, audit triggers, report
  views, and an idempotent demo seed.
- First web increment: onboarding, items, stock-in, cart, profit report, local
  SQLite and outbox.
- pnpm workspace, Makefile command contract, CI, Dockerfiles, deploy path.
- Rust API spine: auth with refresh rotation, catalog, append-only ledger with
  moving-average cost, cash, atomic sales and void, profit report.
- Acceptance sections A, B, and E green against the real API.

### 25 November — the working app

- Report views for stock, sales, and dashboard.
- Stock opname with atomic posting.
- QRIS Tier 0 with payload validation and MDR handling.
- Sync push/pull, idempotent operation log, cursor after commit, conflict inbox.
- Two-device test gate; a real browser pass with a second device.
- Sale lines embedded on pull so the second device shows the HPP breakdown.
- **F-15 found:** voiding a paid sale inflated operating expenses.

### 26 November — closing the gaps

- **F-15 fixed:** sale and sale-void reversals excluded from opex, in both the
  view and the report queries.
- Owner exports: CSV reports, printable profit and opname, full account ZIP.
- Contacts, payables, receivables, and bill payments.
- Bulk item import and stock reconcile check.
- Staff invites with hashed one-time codes.
- Forced RLS on `sale_line` through the parent sale (migration 0016).
- Owner-only export screen.

### 27 November — release preparation

- One-command release bundle with checksums.
- Keyboard-only stock-in fixed and proven.
- Ratified Indonesian title and SDG mapping.

### 28 November — public release

- Non-functional pass: 5,000-item search, keyboard flow, contrast and tap
  targets.
- Public repository under the MIT licence.
- Installable PWA with manifest, icons, and offline service worker.
- Real Tauri desktop shells and a Capacitor Android shell.
- GitHub Actions builds the `.exe`, `.AppImage`, `.deb`, `.dmg`, and `.apk`.
- **v0.1.0 published** with seven downloadable assets.
- API loopback bind and CORS allow-list by default.
- Local-first phone-access design recorded, including the security trade-offs.
- README corrected so the first run actually connects.

## What is still missing

| Item | Why it is not done | What it needs |
|---|---|---|
| Desktop data across restarts | Fix exists on the `frontend` branch (`aa34374`), not merged | merge, rebuild the installers, re-release |
| Phone sees the PC's data (QR) | No `/pair` endpoint, no TLS listener, no `paired_device` table yet | about a day of backend + frontend work, then a two-device test |
| Real-device verification | This machine is Linux only | install the `.exe`, `.dmg`, and `.apk` on real hardware |
| Signed installers | Certificates cost money and need an identity | Windows code-signing certificate, Apple Developer account |
| App Store / Play Store | Accounts and listings | Play Console (US$25 once), Apple Developer (US$99/year), screenshots, privacy URL |
| iOS native app | Needs macOS + Xcode | a Mac and an Apple account |
| Docker one-command | Web image is built without the API URL | wire `VITE_API_URL` or the proxy, then test |
| Search p95 | Contains-search is slower than the 100 ms target | FTS5 index |
| Beta shops | Needs people, not code | 20–30 shops and a feedback loop |

## How progress is tracked on GitHub

- **Releases** — versions and downloadable files. This is the page that shows
  "v0.1.0" with its assets.
- **CHANGELOG.md** — what changed in each version, grouped as added, changed,
  fixed, and security.
- **Commit history** — every change, with a message that says why.
- **PROGRESS.md** (this file) — the plain-language dashboard.
- **Issues and Projects** — GitHub's task board. They are not enabled for this
  repository yet; they become useful when several people work on the remaining
  items at once.

## Honest limits

- The installers are built but **not verified on real devices**, and they are
  unsigned. Treat them as a preview, not a finished product.
- The phone-to-PC pairing is a design, not a feature. The existing app can sync
  two devices through one API, but the desktop does not run that API for a phone
  to join yet.
- Percentages are the last recorded count, not a live measurement.