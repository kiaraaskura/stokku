# Task Breakdown — Stokku (MVP v0.1)

Companion to `PRD.md`. Sizes: **XS** < 2 h · **S** ≈ 0.5 d · **M** ≈ 1–2 d · **L** ≈ 3–5 d. Estimates assume **one senior full-stack dev** with Rust + React experience, part-time design. Total ≈ **11 weeks** to public beta. Two devs compress this to ~7–8 weeks if M1/M2 are split.

Definition of done for every task: code merged, tests where it makes sense, works offline where applicable, no console errors, Indonesian strings in `i18n`, and the acceptance line verified by hand, not assumed.

**Kaitan SDGs.** Setiap milestone menyumbang pada SDG 8 (inti); M1–M3 juga menopang SDG 9 dan SDG 10 melalui biaya infrastruktur rendah dan keterjangkauan perangkat. Pemetaan lengkap ada di bagian "Judul dan SDGs" pada `PRD.md`.

---

## M0 — Foundations (week 1)

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-001 | Monorepo: pnpm workspace, `apps/web`, `apps/desktop`, `apps/mobile`, `services/api`, `packages/shared` | M | — | One command runs web + API locally; CI builds all |
| T-002 | CI: lint, typecheck, `cargo clippy -D warnings`, unit tests, migration check | M | T-001 | Red CI blocks merge |
| T-003 | Provision Postgres (Neon/Supabase) dev + staging; migration tooling (`sqlx migrate`) | S | T-001 | `sqlx migrate run` from zero DB succeeds |
| T-004 | API skeleton: axum, config, structured logging, error model, health endpoint, graceful shutdown | M | T-001 | `/health` returns build hash + DB status |
| T-005 | Dockerfile (multi-stage, arm64+amd64) + one-command deploy to Fly/Render | M | T-004 | Staging URL live, redeploy in < 5 min |
| T-006 | Shared design tokens + component primitives (button, input, sheet, table, empty state, currency input) | L | T-001 | Storybook (or a `/dev` route) shows all states incl. disabled/error |
| T-007 | `packages/shared`: zod schemas for all ops + API DTOs, generated from one source | M | T-001 | Client and server import the same op types; a bad payload fails typecheck |
| T-008 | i18n scaffolding (id default, en secondary), IDR + date formatters, `Asia/Jakarta` default | S | T-006 | Switching language changes UI; `Rp1.234.567` formatting unit-tested |
| T-009 | Auth skeleton: users table, Argon2id, JWT access + refresh rotation | M | T-004 | Login/refresh/revoke covered by integration tests |
| T-010 | Indonesia config: region (Singapore now / Jakarta path), per-outlet timezone WIB/WITA/WIT, `+62` phone normaliser, IDR integer money helpers | S | T-004 | Every timestamp stores UTC + outlet tz; formatters tested against WIB/WITA/WIT |

**Gate M0:** staging API reachable, CI green, design primitives usable.

---

## M1 — Backend core (weeks 1–4)

### Schema & tenancy

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-101 | Core schema: tenant, outlet, user, membership, device (+ UUIDv7, `tenant_id` everywhere) | M | T-003 | Migrations reversible; seed script creates a demo shop |
| T-102 | Postgres RLS on every tenant table + tenant-scoped connection helper | M | T-101 | Cross-tenant read attempt returns zero rows in a test |
| T-103 | `op_log` + `change_log` tables, triggers to write `server_seq` on every business table change | M | T-101 | Any insert/update lands exactly one `change_log` row |
| T-104 | Audit log (actor, action, entity, before/after, device) | S | T-101 | Item edit produces an audit row with the old value |

### Catalog

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-110 | CRUD items, barcodes, units + conversions, categories; soft delete rules | L | T-102 | Cannot delete an item with movements; SKU/barcode unique per tenant |
| T-111 | Item search endpoint (trigram index, name/SKU/barcode, prefix-ranked) | M | T-110 | 5k items search p95 < 30 ms server-side |
| T-112 | Bulk item import (CSV) — parse, validate, dry-run report | M | T-110 | 1k-row file imports with a per-row error list |
| T-113 | Item image upload to object storage (optional, 1 image) | S | T-005 | Upload → signed URL → shown in list |

### Ledger (the heart)

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-120 | `stock_move` append-only table + constraints (qty ≠ 0, valid type, period open) | M | T-103 | Direct UPDATE/DELETE on the table is blocked by trigger |
| T-121 | Posting engine: apply move in a transaction, update `stock_level`, recompute moving-average cost | L | T-120 | Property test: sum(deltas) == stock_level for 10k random ops |
| T-122 | Movement types: in, sale, loss, return, adjust, transfer (transfer = V1, schema only) | M | T-121 | Each type has an integration test |
| T-123 | Reversal/correction endpoint with cost-impact warning | M | T-121 | Reversing an in-move after a sale adjusts cost correctly |
| T-124 | Stock opname session: create, count sheet, variance preview, atomic post | L | T-121 | All-or-nothing verified by forcing a mid-transaction error |
| T-125 | Negative-stock policy (allow + flag, per-tenant setting) | S | T-121 | Selling below zero succeeds and flags the item |
| T-126 | Nightly reconcile job: `stock_level` vs `sum(stock_move)` | S | T-121 | Mismatch raises an alert and produces a repair report |

### Money

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-130 | `cash_entry` table + endpoints; seeded + editable categories | M | T-103 | Any period's balance equals sum of entries |
| T-131 | `sale` + `sale_line` posting: atomic sale + stock moves + cash entry + receivable stub | L | T-123, T-130 | One call posts all or nothing; void reverses everything |
| T-132 | Daily sales-total mode (no per-item stock deduction) — *pending PRD Q1* | M | T-131 | Revenue counts in laba rugi; stock untouched; clearly labelled |
| T-133 | Contacts (customer/supplier) + payable/receivable records + payment application | M | T-131 | Partial payment reduces outstanding correctly |

### Access

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-140 | Membership invites (email), role assignment, remove member | M | T-102 | Staff invite → accepts → sees restricted nav |
| T-141 | Server-side capability checks on cost/profit fields | M | T-140 | Staff token cannot read `cost_avg` or any report endpoint (tested) |

### QRIS — Tier 0 (static, ships in MVP)

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-150 | Outlet QRIS settings: upload image or paste payload, MDR %, preview + validation | M | T-113 | Invalid payload refused with a readable reason; image renders scannable |
| T-151 | QRIS payload parser/renderer (EMVCo TLV) to draw the QR locally, with CRC check | M | T-150 | Parser round-trips real sample payloads; bad CRC rejected |
| T-152 | Checkout QRIS screen: big QR, amount, "Sudah dibayar" confirm | M | T-216 | Opens < 300 ms; works in airplane mode |
| T-153 | Payment record on confirm: method, gross, MDR, net; cash book integration | M | T-152, T-130 | net = gross − fee to the rupiah; report separates gross revenue from fee |
| T-154 | Shareable payment confirmation for the customer | S | T-152 | Share to WhatsApp works on Android + Windows |
| T-155 | Cashier guidance copy for "customer says it failed" (check provider app, never charge twice) | XS | T-153 | Help article written; support class documented |

---

## M2 — Client (weeks 2–5)

### Shell & data layer

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-201 | Local SQLite schema mirroring server tables + migrations runner on device | L | T-007 | Fresh install creates DB; upgrade from prior version migrates |
| T-202 | `Repository` abstraction behind every read/write (SQLite only in MVP, adapter-ready) | M | T-201 | UI never calls the network directly |
| T-203 | Tauri 2 shell: window, menus, updater, keychain storage for tokens | M | T-001 | Signed dev build runs on Windows + Linux; token survives restart |
| T-204 | Capacitor shell: Android build, back-button handling, keystore tokens, safe areas | M | T-201 | Debug APK installs on a 2 GB device and runs core flows |
| T-205 | Router, app shell, bottom nav (mobile) / sidebar (desktop), responsive breakpoints | M | T-006 | 360 px and 1440 px both usable; no horizontal scroll |
| T-206 | Session handling: login, silent refresh, logout, "device not synced" state | M | T-009, T-203 | Token expiry mid-use doesn't lose form data |

### Screens

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-210 | Onboarding wizard (business → type → tax → opening stock) | M | T-205 | Completable in < 3 min; resumable after kill |
| T-211 | Item list: search, filter, virtualised, low-stock badge, swipe actions | L | T-202 | Smooth at 5k items; search < 100 ms locally |
| T-212 | Item create/edit form: units, barcode, prices, min stock, validation | L | T-211 | Keyboard-only entry on desktop; numeric keypad on mobile |
| T-213 | Stock in flow (item → qty → unit → cost → supplier → save) | M | T-212 | 3 taps from item to saved, offline |
| T-214 | Stock out flow (sale / loss / return / correction) | M | T-213 | Each type recorded with the right move type |
| T-215 | Barcode scan sheet (camera + manual + unknown-barcode → create) | L | T-204 | Works in low light; permission denial degrades gracefully |
| T-216 | Sales entry: cart, qty, discount, payment method, paid toggle, void | L | T-214 | 5-line sale posts offline in < 2 s |
| T-217 | Cash book: entry form, list, monthly totals, category chips | M | T-202 | Totals match list exactly |
| T-218 | Opname screen: count mode (big numbers, next-item auto), variance review | L | T-124 | 100 items counted without a wrong-focus bug |
| T-219 | Item detail: ledger history with running balance, cost, margin | M | T-211 | Balance column always equals sum above it |
| T-220 | Pending/"Perlu dicek" inbox for rejected or conflicting ops | M | T-202 | Item is actionable (retry, edit, discard) |
| T-221 | Empty, loading, error, and offline states for every screen | S | T-205 | No blank screen anywhere; offline banner is unobtrusive |
| T-222 | Low-stock notification (local, threshold-based) | S | T-211 | Fires once per item per day, not per sync |

---

## M3 — Sync (weeks 4–6)

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-301 | Outbox table + op serializer; enqueue on every mutation | M | T-202, T-103 | Every write produces exactly one op with a UUIDv7 |
| T-302 | `POST /sync/push`: batch apply, per-op result, idempotency via `op_log` | L | T-301 | Replaying the same batch changes nothing |
| T-303 | `GET /sync/pull`: cursor-based changes, pagination, soft-delete tombstones | L | T-302 | 10k changes pull in pages without gaps or dupes |
| T-304 | Client applier: apply pulled rows transactionally, bump local cursor | M | T-303 | Cursor only advances after commit |
| T-305 | Conflict policy: LWW for master data with server clock + user notice | M | T-304 | Two-device edit test keeps the newer and says so |
| T-306 | Sync state UI (dot + count), manual retry, backoff, foreground/network triggers | S | T-301 | Killed mid-sync → retries cleanly, no dupes |
| T-307 | Two-device integration test harness (scripted devices, 500 random ops) | L | T-305 | Both devices converge to identical numbers |
| T-308 | Reconcile job comparing device-reported totals vs server | M | T-307 | Divergence produces a ticket with the delta |
| T-309 | Migration path for local schema changes between app versions | M | T-201 | v1 → v2 upgrade on a device with pending ops loses nothing |
| T-310 | 30-day offline soak test | M | T-309 | Report figures after 30 days offline match server exactly |

---

## M4 — Reports (weeks 5–7)

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-401 | SQL views: revenue, HPP, opex, gross/net profit per period | L | T-121, T-131 | View output matches a hand-computed ledger for 3 seeded months |
| T-402 | Laba rugi screen: period picker, comparison, drill-down per line | L | T-401, T-220 | Every figure opens the underlying transactions |
| T-403 | Stock reports: current, value at cost/sale, low stock, dead stock | M | T-121 | Values reconcile to the ledger |
| T-404 | Sales report: by day, by item, by category, best sellers | M | T-131 | Totals match sales list |
| T-405 | Dashboard: today's sales, cash position, low stock, month profit | M | T-402 | Loads < 1 s from local data |
| T-406 | Plain-language explanation panels ("kenapa HPP bukan belanja stok?") | S | T-402 | Copy reviewed by a non-accountant |
| T-407 | Export CSV/PDF + share sheet (WhatsApp/email) | M | T-403 | 50k rows export in < 60 s; PDF renders on a phone |
| T-408 | Full account export (JSON + CSVs archive) | M | T-407 | Owner can download everything, unassisted |

---

## M5 — Hardening, beta, release (weeks 7–11)

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-501 | Performance pass: bundle budget < 300 KB gz, local index audit, cold start < 2 s | M | T-405 | Budgets enforced in CI |
| T-502 | Security review: RLS coverage, rate limits, auth flows, token storage, dependency audit | M | T-141 | No P1/P2 findings open |
| T-503 | Backup + restore drill (PITR and logical dump) | S | T-005 | Restored staging DB produces identical reports |
| T-504 | Error tracking + crash reporting (opt-in, no payloads) with release tagging | S | T-005 | A forced crash appears with a build tag |
| T-505 | Accessibility pass: contrast, targets, keyboard nav, screen reader on cash flow | M | T-221 | Checklist signed off |
| T-506 | Offline UX polish: sync dot, stale-data warning, "belum terkirim" copy | S | T-306 | A shop can tell, at a glance, whether data is safe |
| T-507 | Android release build (Play internal testing track), signing, versioning | M | T-204 | Internal testers install from Play |
| T-508 | Windows installer (NSIS/MSI) + code signing + auto-update channel | M | T-203 | Clean VM installs, updates, and uninstalls |
| T-509 | Linux packages (AppImage + deb), macOS dmg + notarisation | M | T-508 | Each installs on a clean machine |
| T-510 | iOS build, TestFlight, store metadata (last, per PRD risk) | M | T-204 | TestFlight build installs |
| T-511 | Store listings, screenshots, privacy labels, support email/WhatsApp | M | T-507 | Submitted for review |
| T-512 | Seed category templates for 5 verticals | S | T-110 | New shop of each type sees sensible categories |
| T-513 | Synthetic load test: 10k tenants, 1M moves | M | T-401 | p95 < 300 ms at target load |
| T-514 | Docs: in-app help (5 short articles), owner-facing data-safety page | S | T-406 | A new user can self-serve the top 5 questions |
| T-515 | Closed beta with 20–30 shops + feedback loop (weekly call, in-app note) | L | T-507 | G1 met, zero data-loss reports |
| T-516 | Launch checklist + rollback plan | S | all | Written, reviewed, rehearsed once |
| T-517 | Privacy policy + UU PDP basics: data location, retention, deletion, QRIS terms | M | T-516 | Published, plain-language, states where data sits |

---

## M6 — Dynamic QRIS (V1, weeks after launch)

Not MVP. Starts once the beta is stable, because it depends on a merchant account and KYC that run on the provider's clock, not ours.

| ID | Task | Size | Deps | Done when |
|---|---|---|---|---|
| T-601 | Choose PJSP (Xendit vs Midtrans vs Doku vs OY!) — sandbox spike on all, decision note | L | — | One page: fees, sub-merchant support, webhook reliability, docs quality |
| T-602 | Open merchant/sub-merchant accounts with the chosen provider (paperwork, not code) | — | T-601 | A real shop can receive a real payment into its own account |
| T-603 | `payment` / `settlement` schema, provider-agnostic | M | T-153 | Both providers' payloads fit |
| T-604 | Create-payment endpoint, idempotent on op id | L | T-603 | Duplicate call returns the same QR |
| T-605 | Webhook receiver: signature, idempotency, state machine, replay test | L | T-604 | Duplicate/out-of-order events never double-count |
| T-606 | Poll + manual confirm fallback, QR expiry | M | T-605 | Cashier never stuck when the webhook is late |
| T-607 | Refund/void across sale + payment | M | T-605 | Stock and money both reverse |
| T-608 | Settlement reconciliation report (gross, MDR, net vs provider) | M | T-603 | Matches provider dashboard to the rupiah |
| T-609 | Local display of server-confirmed payment (no manual refresh) | M | T-606 | Paired-device test passes |
| T-610 | Second provider behind the same interface | M | T-604 | Mock provider passes the suite |
| T-611 | Legal review: sub-merchant model, refund liability, terms | S | T-601 | Sign-off before real money |

**Effort:** ~2.5 dev-weeks. **Calendar:** add however long KYC takes — plan for 2–4 weeks and start the paperwork the week the MVP goes to beta.

---

## Critical path

`T-001 → T-004 → T-101 → T-102 → T-120 → T-121 → T-131 → T-301 → T-302 → T-303 → T-307 → T-401 → T-402 → T-507 → T-515`

Everything else parallelises around it. The ledger (T-120–T-126) and sync (T-301–T-310) are the two places where a shortcut costs a rewrite — do not compress those estimates.

QRIS Tier 0 (T-150–T-155) is **off** the critical path — it hangs off checkout and costs about three days. Do not let it delay the beta. QRIS Tier 1 waits for M6.

---

## Suggested first sprint (days 1–10)

1. T-001, T-002, T-003, T-004, T-010 — a deployable, tested skeleton with Indonesia config baked in.
2. T-101, T-102, T-103 — schema, tenancy, change log. Get these right before any feature.
3. T-120, T-121 — the ledger with property tests.
4. T-006, T-205 in parallel if a second pair of hands exists.

Ship nothing user-facing in sprint 1. The temptation is to build the item list first; it will be rebuilt once the ledger's shape is known.

Also in week 1, not a dev task: start the PJSP merchant-account conversation, because KYC runs on someone else's calendar and dynamic QRIS will be blocked on it long after the code is ready.

---

## Explicitly deferred (do not start early)

Multi-outlet, stock transfer, batch/expiry, thermal printing, dynamic QRIS, marketplace sync, e-Faktur, double-entry, AI reorder, public API, web storefront. Each one is a V1+ task and each one will try to sneak into MVP.

---

## Estimate summary

| Milestone | Weeks | Notes |
|---|---|---|
| M0 Foundations | 1 | One dev; includes Indonesia config |
| M1 Backend core | 3 | Overlaps M0; includes QRIS Tier 0 backend |
| M2 Client | 3 | Overlaps M1 after week 2 |
| M3 Sync | 3 | Overlaps M2; the riskiest block |
| M4 Reports | 2 | Needs a stable ledger |
| M5 Release | 3 | Store review + beta soak are calendar time |
| **MVP total** | **≈ 11** | 7–8 weeks with a second dev on M2 |
| M6 Dynamic QRIS | +2.5 dev | Plus 2–4 weeks of provider KYC in parallel |

Calendar time, not effort: store review, beta soak, PJSP onboarding, and signing certificates add days you cannot compress.