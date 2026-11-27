# Work Split — Stokku MVP

Source of truth for who builds what. Derived from `PRD.md` + `TASKS.md`.
Owner: PRDTASK. Distribution and tracking: **Captain**.

Repo: this repository (branch `main` = integrated build).

---

## 1. Ground rules

1. **Never commit to `main`.** Each member works in their own worktree, for example:
   `git worktree add ../wt/<role> -b <role>`
   Roles: `captain`, `backend`, `frontend`, `db`, `deploy`.
2. **File ownership** (do not edit another owner's tree without asking in the channel):

   | Path | Owner |
   |---|---|
   | `services/api/**` | Backend |
   | `services/api/migrations/**`, `scripts/seed*` | DB |
   | `apps/web/**` | Frontend |
   | `packages/shared/**` | Backend (Frontend consumes; changes land only with both agreeing) |
   | `infra/**`, `.github/**`, `docker-compose.yml`, root `package.json`, `pnpm-workspace.yaml`, `Makefile`, `.env.example` | Deployment |
   | `docs/**` | PRDTASK + Captain |

3. **Contract freeze.** `docs/API_CONTRACT.md` and `docs/DATA_MODEL.md` are the interface. Any change needs a channel note from PRDTASK or the Captain first. Do not silently rename fields.
4. **No compile-time DB coupling.** API uses runtime `sqlx::query(...)` / `query_as`, not `sqlx::query!` macros, until the schema is declared frozen in this file.
5. **Definition of done for every task:** builds locally, no console/compile warnings that break CI, acceptance line in `docs/ACCEPTANCE.md` verified by hand, Indonesian UI strings present where user-visible.
6. Merge flow: member pushes branch → asks Captain for review → Captain merges to `main`. Captain is the only merger.
7. Report status in the channel in this shape: `T-xxx — done/blocked — what changed — how verified`. No status without a verification line.

---

## 2. Role charters

| Member | Owns | Not their job |
|---|---|---|
| **PRDTASK** (lead) | PRD, task split, API/data contract, acceptance checklist, scope calls | Writing feature code |
| **Captain** | Distributing tasks, unblocking, review + merge to `main`, integration QA, final demo | Silent scope changes |
| **Backend** | Rust axum API: auth, catalog, ledger, sales, cash, QRIS Tier 0, reports, sync, role checks | DB migrations, UI |
| **DB** | Postgres schema + migrations, RLS, change log triggers, indexes, seed data, report SQL views, reconcile queries | API handlers |
| **Frontend** | React UI, local SQLite + outbox, offline behaviour, all screens, IDR/i18n formatting | Server logic |
| **Deployment** | Monorepo wiring, CI, Docker, staging deploy, env/secrets, release builds, observability | Product decisions |

---

## 3. Build order and assignments

Five sprints. Sprints 1–2 are the demo spine; 3–5 make it trustworthy.
Sizes from `TASKS.md` (XS/S/M/L). Parallel work is expected inside a sprint.

### Sprint 0 — skeleton (days 1–2, all parallel)

| ID | Owner | Task | Done when |
|---|---|---|---|
| T-001 | Deployment | pnpm workspace, root scripts, `apps/web`, `apps/desktop`, `apps/mobile`, `services/api`, `packages/shared` wired | `pnpm dev` starts web + API; `pnpm build` builds all |
| T-002 | Deployment | CI: lint, typecheck, `cargo clippy -D warnings`, tests, migration check | Red CI blocks merge |
| T-004 | Backend | axum skeleton: config, tracing, error envelope, `/health` | `/health` returns build + DB status |
| T-003+T-101 | DB | Postgres dev DB, `sqlx migrate` tooling, core tenancy schema | `sqlx migrate run` from empty DB succeeds; seed creates demo shop |
| T-008 | Frontend | i18n (id default), IDR + date formatters, tokens | `Rp1.234.567` unit-tested; language switch works |

**Gate:** staging API reachable, CI green, one demo tenant seeded.

### Sprint 1 — the ledger and the money (days 3–7)

| ID | Owner | Task | Done when |
|---|---|---|---|
| T-102, T-103, T-104 | DB | RLS on every tenant table, `op_log`/`change_log` triggers, audit log | cross-tenant read returns 0 rows; every write lands one change_log row |
| T-110, T-111 | Backend | Item/barcode/unit/category CRUD + search | 5k items search p95 < 30 ms |
| T-120, T-121, T-122 | Backend | Append-only `stock_move` + posting engine + moving-average cost | property test: sum(deltas) == stock_level |
| T-123, T-125 | Backend | Reversal with cost warning; negative-stock allow+flag | reverse after sale adjusts cost; sale below zero flags |
| T-130 | Backend | `cash_entry` CRUD + seeded categories | period balance == sum of entries |
| T-131 | Backend | Sale posting: sale + lines + stock moves + cash, atomic; void | one call all-or-nothing; void reverses all |
| T-141 | Backend | Server-side cost/profit capability checks | staff token gets 403 on cost and report endpoints |
| T-150, T-151 | Backend | Outlet QRIS settings + EMVCo payload parser/renderer + CRC | round-trips sample payloads, bad CRC rejected |
| T-210, T-211, T-212, T-213 | Frontend | Onboarding, item list, item form, stock-in flow | setup < 3 min; 3-tap stock-in; offline |
| T-201, T-202, T-205 | Frontend | SQLite mirror, Repository layer, app shell + nav | UI never calls network directly; 360 px usable |
| T-006 | Frontend | Design tokens + primitives | all states visible on `/dev` route |
| T-005 | Deployment | Dockerfile + one-command staging deploy | staging URL live |

**Gate (demo spine):** create shop → add item → stock in → sell → cash entry → laba rugi shows the right number.

### Sprint 2 — counter, opname, QRIS checkout (days 8–11)

| ID | Owner | Task | Done when |
|---|---|---|---|
| T-124 | Backend | Opname session, count sheet, atomic post | mid-transaction failure posts nothing |
| T-132 | Backend | Daily sales-total mode (revenue only, no stock) | revenue in laba rugi, stock untouched, labelled |
| T-152, T-153, T-154 | Backend | QRIS checkout confirm, payment record gross/MDR/net, share text | net = gross − fee to the rupiah; works offline |
| T-214, T-216, T-217 | Frontend | Stock-out, sales cart, cash book screens | 5-line sale posts offline < 2 s |
| T-218, T-219 | Frontend | Opname screen, item ledger with running balance | 100 items without focus bug |
| T-401 | DB | Report SQL views: revenue, HPP, opex, gross/net | matches hand-computed ledger for 3 seeded months |
| T-402, T-403, T-404, T-405 | Frontend (+DB views) | Laba rugi, stock reports, sales report, dashboard | every figure drills down |

**Gate:** a full shop day works end-to-end on one device, offline, and the report reconciles to the rupiah.

### Sprint 3 — sync, multi-device, roles (days 12–16)

| ID | Owner | Task | Done when |
|---|---|---|---|
| T-301, T-302, T-303 | Backend | Outbox op format, `/sync/push` idempotent, `/sync/pull` cursor | replaying a batch changes nothing; 10k changes pull without gaps |
| T-304, T-305, T-306 | Frontend | Client applier, LWW master data + notice, sync dot/retry | two devices converge; killed mid-sync recovers clean |
| T-140 | Backend | Invites + roles + remove member | staff invite → restricted nav |
| T-307 | Backend+Frontend | Two-device test harness, 500 random ops | both devices identical numbers |
| T-308, T-126 | DB | Reconcile jobs: device totals vs server; stock_level vs sum(moves) | mismatch raises alert + repair report |
| T-220, T-221, T-222 | Frontend | "Perlu dicek" inbox, all empty/loading/error/offline states, low-stock notification | no blank screen anywhere |

**Gate:** 30-day-offline soak passes (T-310) and a second device syncs without duplicates.

### Sprint 4 — harden and ship (days 17–21)

| ID | Owner | Task | Done when |
|---|---|---|---|
| T-407, T-408 | Backend | CSV/PDF export + full account archive | 50k rows < 60 s |
| T-502 | Captain + Backend | Security review: RLS coverage, rate limits, token storage, deps | no P1/P2 open |
| T-501, T-505 | Frontend | Perf + accessibility pass | bundle < 300 KB gz; contrast/targets/keyboard checks |
| T-507, T-508, T-512, T-514 | Deployment | Android internal track, Windows installer, 5 vertical seed templates, help docs | clean machine install/update/uninstall |
| T-517 | PRDTASK | Privacy policy + UU PDP page (data location, retention, deletion, QRIS terms) | published, plain language |
| T-516 | Captain | Launch checklist + rollback plan | rehearsed once |

**Gate:** public-beta checklist signed by Captain; demo script passes twice in a row.

---

## 4. Critical path

`T-001 → T-004 → T-101 → T-102 → T-120 → T-121 → T-131 → T-301 → T-302 → T-303 → T-307 → T-401 → T-402 → T-507 → T-515`

Do not compress T-120–T-126 (ledger) or T-301–T-310 (sync). Everything else parallelises.
QRIS Tier 0 hangs off checkout and must not delay the demo spine.
QRIS Tier 1 / M6 is **out of scope** for this build.

## 5. Blocking rules

- Backend blocked on a table → ask DB in the channel with the exact columns needed; do not invent a parallel table.
- Frontend blocked on a response shape → quote the endpoint from `API_CONTRACT.md`; if it is missing, ask PRDTASK.
- Deployment blocked on a build → give the failing command and the first error line.
- Captain escalates to PRDTASK only for scope questions. Everything else the Captain decides.