# Changelog

All notable changes to Stokku. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versions once it leaves `0.x`.

For the current state and what is still missing, see [PROGRESS.md](PROGRESS.md).
For downloads, see [Releases](https://github.com/kiaraaskura/stokku/releases).

## [Unreleased]

### Added
- IndexedDB fallback for the desktop build, so the database survives a restart
  on engines without OPFS. Verified across process restarts in WebKitGTK
  (`aa34374`, on the `frontend` branch — not merged yet).
- A download table on the README with the five installable files
  (`4292149`, on the `backend` branch — not merged yet).

### Changed
- Project progress is now recorded in `PROGRESS.md` and this changelog.

## [0.1.0] — 2026-11-28

First public release. Repo: <https://github.com/kiaraaskura/stokku>.

### Added

**Core bookkeeping**
- Item catalog: SKU, barcode, units with conversions, categories, minimum stock.
- Stock in/out, moving-average cost, append-only movement ledger, corrections as
  reversals, stock opname with atomic posting.
- Sales with line items, discounts, payment methods, credit sales, and void.
- Cash book with categories; contacts, payables, receivables, and bill payments.
- Profit and loss: revenue − HPP − operating expenses = net, with drill-down to
  the transactions behind every line.
- Stock, sales, and dashboard reports; low-stock and dead-stock views.

**Offline and multi-device**
- Local-first client: SQLite compiled to WebAssembly, an outbox for every write,
  and the UI reading local data first.
- Sync push/pull with an idempotent operation log, cursor after commit, a
  "Perlu dicek" inbox, and a last-writer-wins notice for master data.
- Two-device convergence, including embedded sale lines so the second device
  shows the same HPP breakdown.

**Access and payments**
- Owner and staff roles, enforced on the server: staff cannot read cost or
  profit through any endpoint.
- Staff invites with hashed, one-time codes.
- QRIS Tier 0: validate and store the shop's own QRIS payload, show it at
  checkout, confirm manually, and record the MDR fee separately from revenue.

**Data ownership**
- CSV export for sales, stock, movements, cash, and profit and loss.
- Printable profit-and-loss and opname pages.
- Full account archive (JSON + CSVs) as a ZIP, owner-only.
- Bulk item import from CSV with a dry-run report.
- Stock reconcile check comparing the ledger against stock levels.

**Platforms**
- Installable PWA: manifest, icons, and a service worker that precaches the app.
- Desktop shells (Tauri 2): Windows NSIS installer, Linux AppImage and `.deb`,
  macOS `.dmg`.
- Android shell (Capacitor): debug APK.
- GitHub Actions CI: tests, migrations, and installer builds.

### Changed
- Public repository under the MIT licence.
- README rewritten for a first-time visitor, with a quick start, a platform
  matrix, and a list of known gaps.
- The API binds to loopback by default and uses a CORS allow-list.
- The run instructions now match the real ports (web 5173, API 8099).

### Fixed
- F-15: voiding a paid sale no longer books the reversal as an operating
  expense, which had understated net profit by the sale total.
- Cross-tenant `sale_line` leak closed with forced row-level security through
  the parent sale (migration 0016).
- The account archive can no longer carry another shop's sale lines.
- The local optimistic sale row is removed after the server applies it, so a
  second device does not show duplicates.
- Pulled sales include their lines, so the HPP drill-down is not empty.
- Keyboard-only stock-in works end to end (G29): focus, Enter to save, Escape
  to close.
- Contrast and tap targets pass (G30): lowest pair 5.47:1, 44 px targets.
- `MIGRATION_DATABASE_URL` is documented as the same database, not just an
  admin login.

### Security
- Forced row-level security on every tenant table; report views are
  `security_invoker`.
- Refresh tokens and invite codes are stored hash-only.
- API loopback bind and CORS allow-list by default.
- Secret scan before publication: no `.env`, tokens, or private keys tracked.

### Known issues
- Search over 5,000 items meets the median target but misses p95 (157 ms
  against a 100 ms target); the fix is an FTS5 index.
- Installers are unsigned. Windows SmartScreen and macOS Gatekeeper warn; the
  APK is debug-signed.
- No installer has been verified on real Windows, macOS, or Android hardware.
- Phone-to-PC QR pairing is designed, not built.
- Docker `make up` serves the page but cannot log in until the web build's API
  URL is wired.
- iOS has no native build; it uses the PWA until a Mac and an Apple Developer
  account are available.
