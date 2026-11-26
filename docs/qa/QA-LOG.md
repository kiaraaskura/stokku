
## Run 2 — 2026-11-24, browser hand pass of section A on merged `main`

Driven through the real UI in a browser at 1893x951, dev server on :5199, local store
(API not merged). Fresh shop "Warung Bu Sri", item **Gula 1 kg** at sale price 12.000.

| Step | Expected | Actual (screen) | Verdict |
|---|---|---|---|
| A1 item created | exists, stock 0, cost 0 | "Gula 1 kg sisa 0 kg Rp12.000 · Stok habis" | PASS |
| A2 stock in 10 @ 6.000 | stock 10, avg 6.000 | "Stok sekarang: 10 · Rata-rata modal: Rp6.000" | PASS |
| A3 stock in 10 @ 9.000 | stock 20, avg **7.500** | "Stok sekarang: 20 · Rata-rata modal: Rp7.500" | PASS |
| A4 sell 5 @ 12.000 cash | total 60.000, stock 15 | cart total Rp60.000, saved, then 15 kg @ 7.500 | PASS |
| A5 cash out 5.000 listrik | opex 5.000 | "Listrik − Rp5.000", kas masuk 60.000, selisih 55.000 | PASS |
| A6 laba rugi | 60.000 / 37.500 / 22.500 / 5.000 / 17.500 | **exactly** those five numbers | PASS |
| A7 drill-downs | sale, line, cash entry | revenue → "#1 24 Nov 2026 · cash Rp60.000"; HPP → "Gula 1 kg … Rp37.500"; opex → "listrik … Rp5.000" | PASS |
| A8 buy 10 @ 6.000 | net unchanged, stock 172.500 @ 6.900 | net still 17.500; "Stok sekarang: 25 · Rata-rata modal: Rp6.900" = 172.500 | PASS |
| reload persistence | data survives reload | full reload kept 2 items and the report | PASS |
| onboarding resume | resumes mid-wizard | reopened at "Langkah 2 dari 4 · Melanjutkan dari langkah terakhir" | PASS |

Second sale used for A8 showed the report move by exactly one sale: revenue 120.000,
HPP 75.000, gross 45.000, opex 5.000, net 40.000 — every delta reconciles.

### Not covered by this increment (honest gaps)

| Section | Why not | Owner / task |
|---|---|---|
| B9 reverse with cost warning | no reverse endpoint or UI | Backend T-123, then Frontend |
| B10 negative stock flag | repo allows the sale; no warning UI verified | Frontend (T-125 surfacing) |
| B11 opname | Sprint 2 | T-124 |
| B12 void sale | no void endpoint or UI | Backend T-131 void |
| B13 delete item with movements | no delete UI | Backend T-110 |
| C offline + sync | sync is unimplemented by design this increment; offline entry works, outbox accumulates | T-301..T-306 |
| D QRIS | not in this increment | T-150..T-154 |
| E roles | API not merged; staff account needs invites (T-140) | Backend T-141 |

### F-07 — false alarm during this run (not a product bug)
Two stock-ins first appeared to store cost 0 (average fell to 4.327). The cause was the test
harness typing into the currency field while its select-on-focus ran, so the field kept only
the last digit. Re-run with the value read back before saving gave 6.900 every time, and the
repository's own unit test of the A8 chain gives 172.500 / 6.900. No code change made.

### F-08 — two pnpm lockfiles (already fixed, see F-05)
Merging alone did not produce a runnable workspace; the lockfile fix in commit f3b6965 is
required. Anyone re-merging frontend must not restore apps/web/pnpm-lock.yaml.

## Run 3 — 2026-11-24, after merging DB's 0010 auth functions

Merged: `db` 2fb1f84 → `main` 8e79782 (0010 auth functions only).

### Verified good

| Check | Result |
|---|---|
| migrate as superuser, fresh DB | applied 1..10 |
| seed | ok |
| as role `stokku`, no app context: `auth_find_user('owner@demo.test')` | exactly 1 row (Bu Sri, `$argon2id$`) |
| as role `stokku`: `auth_lookup_refresh('bogus')` | 0 rows |
| function properties | `prosecdef = t`, owner `stokku_auth`, `has_function_privilege('public', …) = f` |
| `stokku` itself | `rolsuper f`, `rolbypassrls f`; `stokku_auth` nologin + bypassrls, 0 members |
| failed-run safety | 0010 raised, `_sqlx_migrations` stayed at 9 — no partial state |

### F-09 — REGRESSION: 0010 fails on the documented dev path (blocker)

`scripts/migrate.sh` on a fresh DB with the non-superuser `DATABASE_URL` from `.env.example`:

```
Applied 9/migrate views qris
error: while executing migration 10: error returned from database: permission denied to alter role at line 779
```

`make migrate-check` (what CI runs) fails the same way:

```
error: while executing migration 10: error returned from database: permission denied to alter role
make: *** [Makefile:96: migrate-check] Error 1
```

Impact: `make test` is red on a clean clone, and WORKSPLIT's definition of done requires
migrate-from-zero. The security design is sound; only the runner identity is wrong. Sent back
to DB: run privilege-needing migrations on an admin connection (e.g. `MIGRATION_DATABASE_URL`
falling back to `DATABASE_URL`) while the API keeps connecting as non-superuser `stokku`.
`.env.example` is Deployment's file, so the new variable needs their edit too.

### F-10 — Backend branch had no commits, and its test fixture collided with 0010

All of `services/api` was untracked, so nothing of the API existed on branch `backend`.
Its `cargo build` is clean and the contract surface matches API_CONTRACT.md (error envelope
with `fields`, `{data, next_cursor}`, `ctx.require(Cap::*)` in handlers, `qty_positive`,
`cost_impact_warning`, `cost_at_sale`). But `cargo test` failed:

```
panicked at tests/auth_flow.rs:45:52: fixture stmt: Database(PgDatabaseError { code: "42P13",
message: "cannot change name of input parameter \"p_token_hash\"" })
```

The temporary fixture re-creates `auth_lookup_refresh` with `p_hash` over DB's real
`p_token_hash`. PRDTASK already said to retire the fixture once 0010 landed. Sent to Backend.

## Run 4 — 2026-11-24, API merged: sections A + B + E green against the real server

Merged to main: DB's `ce51265` (migration runs on an admin connection + `security_invoker`
report views) and Backend's `cfd8bc5`/`e4f91c2` (the whole API spine). main = `8e3766a`.

Fresh DB `stokku_qa`: `scripts/migrate.sh` applied 1..11 with the documented non-superuser
`DATABASE_URL` and exited 0 — the F-09 regression is fixed. `make migrate-check` → OK.
`verify.sh` → exit 0, zero ERROR/FAIL lines.

API run as `stokku` on :8099 (8080 is taken on this machine), against that seeded DB.
`docs/qa/acceptance-spine.sh` result: **pass=38 fail=0**.

| Acceptance | Expected | Actual |
|---|---|---|
| A2 stock in 10 @ 6.000 | stock 10, avg 6.000 | 10 / 6000 |
| A3 stock in 10 @ 9.000 | stock 20, avg **7.500** | 20 / 7500 |
| A4 sell 5 @ 12.000 | total 60.000, cost_at_sale 7.500, stock 15 | 60000 / 7500 / 15 |
| A6 laba rugi | 60.000 / 37.500 / 22.500 / 5.000 / 17.500 | exact, and revenue−hpp−opex = net |
| A7 drill-downs | sale, line, cash entry | all three 200 and list the right rows |
| A8 buy 10 @ 6.000 | net unchanged, 25 units | net 17.500, stock 25, avg 6.900 = **172.500** |
| B9 reverse 10 @ 9.000 | warning first, stock 15, balance == sum of deltas | warning "6900 → 5500", stock 15, ledger true on every row |
| B10 negative stock | sale succeeds, flagged | stock −15, low_stock true, nothing blocked |
| B12 void sale | stock restored, cash reversed, marked void | stock back to 20, voided_at set, sale kept |
| B13 delete with movements | 409, Indonesian | 409 "Item tidak bisa dihapus karena sudah ada pergerakan stok…" |

E21/E22 run by hand against the seeded demo tenant (staff@demo.test):
`GET /me` capabilities are exactly `["stock.write","sales.write","cash.write"]`;
`/reports/laba-rugi` **403**, `/reports/laba-rugi/drill` **403**, `POST /items` **403**;
item rows contain no `cost_avg`; staff stock-in and a staff sale both **200**, recorded with
`created_by` = the staff user id.

B11 (opname) is Sprint 2 and remains the only B line not implemented.

### F-11 — contract gap: `sale.note` (open, needs PRDTASK)
`API_CONTRACT.md`'s `POST /sales` body includes `note`, but `sale` has no `note` column in
DATA_MODEL.md or 0005_sales.sql. Backend correctly does not invent one — the field is accepted
and silently not stored on the sale (it is stored on the linked cash entry). Either DB adds an
additive `note text` or the contract drops the field. One-line decision, either way.

### F-12 — T-125 has no dedicated negative-stock field (open, minor)
`stock < 0` plus `low_stock: true` is the only signal; the frozen item shape has no
`negative_stock` flag. Matches the contract as written; flagged so nobody thinks it was missed.

---

## PRDTASK ruling — 2026-11-24 (contract calls + one live regression)

Ratified in `docs/DATA_MODEL.md` §1/§4 and `docs/API_CONTRACT.md`:
- `refresh_token` recorded in §1 (SHA-256 hash only, not in change_log).
- §4.1 documents the three `SECURITY DEFINER` auth functions and the `security_invoker` view rule.
- `sale.note` **approved as an additive column** — the contract keeps `note`; DB adds it.
- `negative_stock` **approved as an additive item field** (`stock < 0`), separate from `low_stock`.

### F-13 — `GET /v1/sales` returns 500 on merged main (BLOCKER, found by PRDTASK)
Reproduced against the live API on :8099 with a fresh owner signup, one item, one stock-in,
one sale:

```
GET /v1/sales        -> HTTP 500  {"error":{"code":"internal","message":"Kesalahan internal"}}
GET /v1/sales/{id}   -> HTTP 200
```

Cause: `services/api/src/routes/sales.rs` `list()` selects `... void_reason, note, created_by, ...`
but `sale` has no `note` column (`0005_sales.sql`), so Postgres raises 42703 and the handler maps it
to `internal`. Every other read endpoint returns 200; only this one fails.

Why QA missed it: `docs/qa/acceptance-spine.sh` never calls `GET /v1/sales` (it reads the sale from
the POST response and the report drill-downs). Section F24 ("sales report by day/item matches the
sales list") is the line that would have caught it, and it is Sprint 2.

Fix: DB adds `note text` to `sale` (additive), Backend keeps the select. Backend should also add a
regression test that lists sales after posting one — a one-row `GET /v1/sales` assertion.

## Run 5 — 2026-11-24, F-13 fix: docs ratified, harness widened, 0012 merged

Merged: `docs-ratify` 190b543 (refresh_token §1, §4.1 auth bypass + security_invoker rule,
sale.note additive, negative_stock additive, F-13 recorded), then `db` fe2ad4d (0012 sale.note),
then my two harness commits.

### The harness gap, closed and proved
`GET /v1/sales` 500'd on main and the harness passed 38/38 because it never called the list —
it read the sale from the POST response and the report drill-downs. Fixed in two parts:

1. after posting the sale, assert `GET /sales` is 200, that its first row total is 60.000, and
   that its first row id is the sale just posted; also `GET /sales/{id}` 200 with total 60.000.
2. a sweep of every read endpoint in API_CONTRACT.md — 200, or 404 when documented
   unimplemented, and **any 500 fails the run**. Covers /me, /items, /items/{id},
   /items/search, /categories, /stock-moves, /items/{id}/ledger, /sales, /sales/{id},
   /cash-entries, /cash-categories, /reports/laba-rugi, its drill, and the four Sprint-2
   endpoints that must 404 rather than 500.

Proof it bites: run against the unfixed build → **4 failures**, all `GET /sales` 500. That is
the regression the old 38/38 could not see.

### After 0012 (0012 only; Backend's own fix not merged yet)
Fresh DB `stokku_0012cap`: migrate applied 1..12, exit 0; `sale.note` is `text`, nullable.
`GET /sales` → **200** and lists the sale; `GET /sales/{id}` → 200.
Harness against that build: **pass=60 fail=0**.

### Still open at the end of this run
- `note` sent on `POST /sales` is **not persisted** by the merged build (list shows `null`):
  the insert does not name the column yet. Backend's uncommitted fix adds it; not mergeable
  until committed.
- `negative_stock` is in the contract but not returned by the merged build yet (same commit).
- Staff password: the seed's `Demo1234!` works; earlier failed E21 attempts in this run were my
  wrong password in the call, not an API fault.

## Run 6 — 2026-11-24, F-13 closed on main: harness 63/63

Merged: `backend` 27abf92 (persist `sale.note`, `negative_stock`, PATCH items numeric cast,
ledger coalesce, regression test). main = `846e4c2`. Merge gate honoured: DB's 0012 was in main
(`aa38f74`) before Backend's fix went in, and 0012 is in Backend's history too.

### My verification of merged main (not the report)

| Check | Result |
|---|---|
| `cargo fmt --check` | OK |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo test` with `STOKKU_TEST_ADMIN_URL` | **4/4** — auth flow, moving-average math, 2500-op property test, sales-list regression |
| fresh DB `stokku_mainqa`, migrate with non-superuser `DATABASE_URL` | applied 1..12, exit 0 |
| seed | ok |

### Harness on merged main — fresh DB, API as `stokku` on :8099

**pass=63 fail=0**, including section E (`staff@demo.test` / the seeded password).

- Section 16 sweep: all 13 implemented read endpoints **200**; `/reports/stock`,
  `/reports/sales`, `/reports/dashboard`, `/outlets/{id}/qris` **404** as documented; no 500.
- `GET /sales` now 200 with the posted row, total 60.000, id match (the F-13 check).
- E21: staff `403` on laba rugi and item-create, no `cost_avg` in staff item rows.

### The three bugs F-13's audit exposed, verified by hand on main

1. `sale.note` round-trips: POST returns it and `GET /sales` row carries it ("pelanggan langganan").
2. Item with **no** `stock_level` row: `GET /items/{id}/ledger` = **200** with rows (was 404).
3. `PATCH /items/{id}` with `min_stock` = **200** (was 500, text/numeric bind).

Plus `negative_stock` present and correct: an item sold to `stock -1` returns
`{"stock":-1,"low_stock":true,"negative_stock":true,"min_stock":3}` — `negative_stock` is
`stock < 0` and `low_stock` stays `stock <= min_stock`, as ratified.

### Honest notes
- Harness `STAFF_PASSWORD` must be the real seed password (`Demo1234!`); two intermediate runs
  showed a false `staff login 401` because of my own wrong value, not an API fault.
- The debug binary had to be rebuilt before the run; a stale `target/debug` binary makes any
  harness result meaningless.
- Still out of scope: sections C (sync), D (QRIS), B11 (opname) and the web app's API wiring.

---

## PRDTASK — harness wrong-target trap (2026-11-25)

I ran `acceptance-spine.sh` exactly as written and got **pass=24 fail=36**, then ran it with
`API_BASE=http://127.0.0.1:8099/v1` and got **pass=60 fail=0**. Same code, same API.

Cause: the script defaulted to `:8080`, which on this machine is an unrelated local app
(`catat-usaha`). That app answers `200` to `/health` — and also to `/reports/stock` — so the
read-endpoint sweep in section 16 went green against the wrong service while every spine
assertion failed. A wrong-target run can therefore look *nearly* green, and the only signal was
a result nobody would read twice.

Fix (this branch):
- default `BASE` is now `:8099` (the port this project actually uses on this machine)
- an identity guard after the health check: `/health` must contain `db.status`. Stokku's health
  payload has it; the other app's does not. On mismatch the script prints FAIL and **exits 90**
  rather than reporting a pass count.

Proof: wrong target → `FAIL target is NOT the Stokku API` then `exit=90`. Correct target →
`pass=61 fail=0`, `exit=0`.

Rule for the team: never quote a harness pass count without the target. The guard enforces it now.

## Run 7 — 2026-11-25, merged main after the guard + frontend + deploy merges

Merged in this order, after reviewing each for ownership (only docs/, apps/web/, and
.github+infra+.env.example respectively) and confirming the merge base explained the apparent
file churn:

| # | Branch | Commit | What |
|---|---|---|---|
| 1 | docs-ratify | b8d464b | harness defaults to :8099, identity guard on /health |
| 2 | frontend | e2ac08c, 3d5e0d5 | web app wired to the live API |
| 3 | deploy | ee4b601 | CI runs the DB-backed tests; admin DSNs documented |

main = `2478c72`. Plus my own follow-up `4f1a59b` hardening the guard (below).

### Guard: verified by trying to defeat it

| Target | Result |
|---|---|
| `:8099` (real API) | `PASS target is the Stokku API`, prints `TARGET ...`, exit 0 |
| `:8098` (fake server, 200 without `db.status`) | `FAIL target is NOT the Stokku API`, **exit 90** |
| `:9` (closed port) | **exit 90** |

Found while testing: the original guard read a fixed `/tmp/qa-health.json`, so a dead target
passed on a **stale** file from a previous run and then printed 59 failures instead of aborting.
Fixed in `4f1a59b`: fresh `mktemp` per run, non-200 is a FAIL, and the target URL is printed
with every result.

### Trap found in the environment, not the code

The API listening on `:8099` was running from Backend's **unmerged** worktree
(`/wt/backend/.../stokku-api`) and answered `/outlets/{id}/qris` with 200 — an endpoint that
does not exist on merged main. A 64/64 there would have been a pass against unmerged code.
Every number below therefore comes from a binary built from `main` (`git archive main` into a
temp dir, built there). `/proc/<pid>/exe` is how I caught it; worth checking before any report.

### Results on merged main

| Check | Result |
|---|---|
| `apps/web` tests / build | **43/43**, 127.50 KB gz |
| `cargo fmt --check` / `clippy -D warnings` | clean |
| `cargo test` with `STOKKU_TEST_ADMIN_URL` | **4/4** |
| fresh DB, migrate as non-superuser, seed | 1..12, exit 0 |
| harness, **main-built** binary, rebuilt dev DB, incl. staff | **64 pass, 0 fail**, `TARGET http://127.0.0.1:8096/v1` |
| harness, own fresh DB | **61 pass, 0 fail**, `TARGET http://127.0.0.1:8097/v1` |

`/outlets/{id}/qris`, `/reports/stock`, `/reports/sales`, `/reports/dashboard` all 404 on merged
main, as documented.

### Browser pass against the API (not the local store)

Logged in as `owner@demo.test` at `:5197` with `VITE_API_URL=http://127.0.0.1:8096`. Item list
showed the server's 20 seeded items, sync dot read "Tersinkron", no console errors. Laba rugi
November was empty (correct — the seed covers Aug–Oct); October showed **981.000 / 508.500 /
472.500 / 230.000 / 242.500** with "Pendapatan belum dibayar Rp96.000", labelled **"Data
server"** — identical to `GET /reports/laba-rugi` on the main-built API. So the read path is
genuinely server-backed, not locally computed.

### Still unproven
- Section C (sync T-301..T-310) — not built. The outbox is queued-retry only, no `/sync/push`.
- Section D (QRIS) and B11 (opname) — Backend/Frontend/DB on Sprint 2, unmerged branches.
- Report screens and F24 ("sales report matches the sales list") — the endpoints are Sprint 2.
- `POST /items` and `/cash-entries` carry no `op_id`, so those two are not exactly-once.
- Staff can post an item cost through the API even though the UI hides it.
- Docker absent: `make up`, image builds and compose never run. Repo not on GitHub: CI inactive.
- Browser offline/queued-retry flow not re-run by me this pass (Frontend demonstrated it).

---

## PRDTASK — Sprint 2 verified independently (2026-11-25)

Ran the new endpoints myself against :8099 (Backend's branch build), fresh tenants, not from reports:

| Check | Result |
|---|---|
| B11 opname: 2 items, count Kopi 9 of system 10 | posted 1 adjustment (−1), stock 9, re-post **409** |
| B11 opname with no items in scope | 422, readable Indonesian |
| D19 QRIS: valid EMVCo payload + MDR 0,7 | **200**, settings returned |
| D19 QRIS: malformed payload | 422 `Payload QRIS tidak valid…`, server-side TLV validation real |
| D20 QRIS confirm 60.000 @ 0,7% | gross 60.000 / mdr **420** / net **59.580**, status paid |
| D20 second confirm | **409** `sudah dikonfirmasi` |
| T-404 by-day total vs laba rugi (Oct) | **981.000 = 981.000** |
| T-404 by-item + daily_total | 731.000 + 250.000 = **981.000** exact; category == item |
| T-405 dashboard | cash −2.358.000, low_stock 4 (matches DB's proof) |
| `qris_mdr_fee` in laba rugi | present, 420, reported separately from gross revenue |

Ratified in docs (this branch): `qris_mdr_fee` and stock-report `data[]` added to API_CONTRACT;
opname session/line tables added to DATA_MODEL §1 with the immutability rule.

Note for the record: my first two QRIS payload attempts were rejected — that was my hand-built TLV,
not a server fault. A correct CRC payload was accepted. The validator is doing its job.

---

## PRDTASK — the `sale_line` sync gap (2026-11-25), decided

Reproduced on :8099 myself, fresh tenant, a 2-line sale (total 25.000):

```
pull?cursor=0&limit=200 -> tables {tenant, outlet, membership, cash_category,
  item, stock_move, stock_level, sale, payment, cash_entry}
sale rows pulled: 1   has "lines" key: false
sale_line rows pulled: 0
```

So a second device receives revenue but cannot render the sale's lines or the HPP drill-down.
This would fail acceptance A7 on device B and it is exactly the class of quiet data loss section C
exists to catch.

Decision (in docs/SYNC_INCREMENT.md): embed lines in the sale payload on pull, handler-side, no
schema change. Rejected the alternative of giving sale_line its own tenant_id + change_log + RLS —
a migration to fix an artefact of per-row fetching, when a sale is always an aggregate.

Also confirmed from the same pull: `stock_level` does pull (so device B can render stock without
replaying moves), and `voided` is carried on the sale rather than being a tombstone.

## Run 8 — 2026-11-25, Sprint-2 + sync merged; section C gate built and proved

Merged in PRDTASK's order, each reviewed for ownership first:

| # | Branch | Commits | What |
|---|---|---|---|
| 1 | db | 64dcca8, 6641e6a, b4f4d3e | 0013 report views, 0014 opname tables, sync-substrate proofs |
| 2 | backend | 797e36c, 8c3f0dd, 93d14be, 043c002, 3b1a8c8 | QRIS Tier 0, opname, report endpoints, sync push/pull, sale-line embed |
| 3 | docs-ratify | beec0a7, b1c05f9, 548b23b | qris_mdr_fee/data[], SYNC_INCREMENT.md, sale_line decision |

main = `d6513e7`. Frontend is **not** merged — see below.

DB had to land first because Backend reads those views/tables, and Backend's branch carried an
older `scripts/verify.sql` snapshot from its own db merge. Checked that DB's newer sync-substrate
proofs survived the merge: `grep -c "sync substrate" scripts/verify.sql` → 1. No conflict.

### Verified myself on merged main

| Check | Result |
|---|---|
| fresh DB, migrate as non-superuser | 1..14, exit 0 |
| seed | ok |
| `scripts/verify.sh` | exit 0, 0 FAIL/ERROR |
| `cargo build` / `clippy -D warnings` / `fmt --check` | clean |
| `cargo test` with `STOKKU_TEST_ADMIN_URL` | **11/11** |
| `acceptance-spine.sh` @ :8095 (main-built) | **64 pass, 0 fail** |
| `/reports/stock`, `/reports/sales?group_by=day|item`, `/reports/dashboard` | all **200** (were 404) |

Report figures cross-checked against DB's independent numbers: stock at cost 20 rows, dashboard
`cash_position −2.358.000`, `low_stock_count 4`.

### NEW: `docs/qa/two-device.sh` — the section C gate

Device B sees the tenant **only** through `/sync/pull` with its own cursor — never a REST read.
That is the property the demo depends on, and it is what makes the HPP assertion meaningful.

Sharp assertions (totals matching is not enough):
- the pulled sale row must carry an embedded `lines` array with both lines
- device B's HPP must be non-empty **and equal** device A's — revenue with an empty HPP
  breakdown is a FAIL
- a voided sale must arrive with `voided_at` set and `deleted=false` (void is not a tombstone)
- replaying the same push batch returns `duplicate` and does not double-apply

**Proved to fail on pre-fix code.** Built `043c002` (before the embed) and ran the same gate:

```
FAIL  pulled sale carries an embedded lines array — expected [2] got [MISSING]
FAIL  device B HPP breakdown is EMPTY — revenue would show with no HPP (section C blocker)
PASS  device B sale total matches (72000)
```

Totals matched while the breakdown was empty — exactly the case that would have shipped silently.

**On merged main (3b1a8c8):** **24 pass, 0 fail**, `TARGET http://127.0.0.1:8095/v1`.
Device B pulled 28 rows, stock 15, both line ids present, HPP 43.500 = device A's
(5 × 7.500 + 3 × 2.000), total 72.000, replay `duplicate`, stock 17 not 19, void carried
`voided_at` with `deleted=false`.

### F-14 — Frontend's sale applier does not read the embedded `lines` array (open, blocking C)

Frontend's branch tip is `d95edd6` with `apps/web/src/db/repo.ts` **uncommitted**. Its
`case 'sale'` in `applyOneChange` writes the sale row only; it handles a separate `sale_line`
change row, which no longer exists now that lines are embedded (the same gap that just bit
Backend, client-side). So the server fix is merged but the browser would still show revenue with
an empty HPP drill-down on device B. Not merged for this reason. Frontend also still owes the
two-device browser evidence; this script is the HTTP-level equivalent and is now the gate.

## Run 9 — 2026-11-25, Frontend merged; browser two-device evidence; F-15 found

Merged `frontend` (c999b40, 9b6c278, 6a9fdd5, d95edd6, 3dbacd7, cc2e6c1) → main `b4709f9`.
Reviewed the `cc2e6c1` diff first as asked: it only adds an embedded-lines block inside
`case 'sale'` of `applyOneChange`; `postSale` is untouched, so the local-post path is unchanged.
Lines are written inside `applyPullPage`'s single transaction before the cursor update, so
cursor-after-commit holds.

Fail-proof checked myself: with the lines block removed, `pull-sale-lines.test.ts` fails 3/3;
restored, passes 3/3. Merged main: **64/64 tests**, tsc clean, build **150.12 KB gz**.

### Browser two-device run (main-built API on :8093, fresh DB `stokku_b2`)

Device A = origin `:5191`, device B = origin `:5192` (separate OPFS, so B's data can only
arrive by pull). Fresh tenant "Warung Dua Perangkat", owner signup on A only.

| | Device A (`:5191`) | Device B (`:5192`, pull only) |
|---|---|---|
| Item | Gula 1 kg, 20 kg | Gula 1 kg, **sisa 15 kg** (never created it) |
| Laba rugi Nov | Pendapatan 60.000 · HPP 37.500 · laba kotor 22.500 · opex 0 · net 22.500 | **identical**, labelled "Data server" |
| HPP drill-down | Rp37.500 | **"S000001 · 25 Nov 2026 · Rp37.500" — non-empty** |
| Sync dot | Tersinkron | Tersinkron |

Voided sale: voided on A, device B's Nota screen shows `S000001 … Rp60.000 **void**` and the
sale is still listed (not deleted, not a tombstone). **Section C browser half: PASS.**

### F-15 — BLOCKER: voiding a paid sale books the reversal as opex (server-side)

Found while checking the void above. Voiding the only paid sale of the period gives:

```
GET /v1/sales            -> S000001, voided_at set, payment status "refunded"
GET /v1/cash-entries     -> out 60000 category "penjualan" ref_type "sale_void"
GET /v1/reports/laba-rugi -> revenue 0, hpp 0, opex 60000, net_profit -60000
```

Net profit should be **0**: revenue correctly excludes the voided sale, but `v_opex` counts the
reversal entry as an operating expense. Cause is one line in `0009_views_qris.sql`:

```sql
and coalesce(c.ref_type, '') not in ('purchase', 'stock_move')
```

`sale_void` is a newer ref_type (Backend's void path) and is not excluded. Every voided paid sale
therefore inflates opex and understates net profit by the sale total — the demo's most important
number. The seeded October figures are unaffected only because the seed's voided sale was not paid.

My harness missed this because B12 only asserted stock restored + voided_at; it never re-read the
report. Now added: revenue must drop by exactly the voided sale, opex must be unchanged by the
void, and revenue−hpp−opex must equal net. On the current build that assertion fails
`opex expected [5000] got [65000]`.

Fix belongs to DB (their view): exclude `ref_type = 'sale_void'` (and ideally also `ref_type =
'sale'`, so a paid sale's cash_in can never be double-classified) from `v_opex`, in a new
migration — do not edit 0009, it is checksummed on main.

## Run 10 — 2026-11-25, section C browser evidence re-run on merged main

Frontend was already merged in run 9 (`b4709f9`), including all seven commits
`c999b40, 9b6c278, 6a9fdd5, d95edd6, 3dbacd7, cc2e6c1, 4cf6a0f`. Verified each is an ancestor
of main rather than re-merging. main = `d120d8d`.

Re-ran both gates against a binary built from `main` (`git archive main` → own build), fresh DB
`stokku_c3` migrated 1..14, API on :8092, and two fresh browser origins (:5181 / :5182) so
device B's storage cannot contain anything device A wrote.

| Gate | Target | Result |
|---|---|---|
| `docs/qa/two-device.sh` (HTTP) | `http://127.0.0.1:8092/v1` | **24 pass, 0 fail** |
| `docs/qa/acceptance-spine.sh` (HTTP) | `http://127.0.0.1:8092/v1` | **63 pass, 1 fail** — F-15 only |

### Browser two-device, 2-line sale

Device A only ever signed up, created both items and sold; device B signed in afterwards on a
separate origin.

| | Device A (:5181) | Device B (:5182, pull only) |
|---|---|---|
| Items | Gula 1 kg 20 kg, Kopi Sachet 10 pcs | both present, **never created on B** |
| Stock after sale | Gula 15 kg, Kopi 7 pcs | **identical** |
| Laba rugi Nov | Pendapatan 72.000 · HPP 43.500 · laba kotor 28.500 · opex 0 · net 28.500 | **identical**, "Data server" |
| HPP drill-down | — | **two lines: Rp37.500 (5 × 7.500) + Rp6.000 (3 × 2.000) = 43.500** |
| Dot | Tersinkron | Tersinkron |

**Section C browser evidence: PASS.** The HPP drill-down on the pull-only device is non-empty and
equals device A's, which is the assertion this gate exists for.

### Void on device B

Voided the sale on A, synced B: Nota shows `S000001 · 25 Nov 2026 · Tunai Rp72.000 void` — still
listed, marked void, not deleted. Correct.

### F-15 still open, and now visibly wrong in the UI

Same void makes both devices show `opex Rp72.000, net −Rp72.000` where it must be 0 — the
server's `v_opex` counts the `sale_void` reversal as an operating expense. The client faithfully
renders the server's wrong number. DB has the fix assigned; the harness assertion
`voiding does not create opex` is the failing line and stays until it passes.

## Run 11 — 2026-11-25, sale detail sheet merged (998d23b)

Reviewed `998d23b` before merging: it touches only `apps/web/src/db/repo.ts`,
`features/sales/SalesList.tsx`, `i18n/messages.ts`. The repo change is one read-only query
(`getSaleLinesLocal`, `SELECT ... FROM sale_line WHERE sale_id = ?`) registered in `repoMethods`
— no write path, no change to the embedded-lines applier. tsc clean, 64/64 tests,
build 150.56 KB gz, merge-tree clean.

main = `c50e82a`. Both gates re-run against a binary built from main, fresh DB `stokku_c4`
(migrated 1..14), API on :8091:

| Gate | Target | Result |
|---|---|---|
| `docs/qa/two-device.sh` | `http://127.0.0.1:8091/v1` | **24 pass, 0 fail** |
| `docs/qa/acceptance-spine.sh` | `http://127.0.0.1:8091/v1` | **63 pass, 1 fail** (F-15 only) |

### Where the queue stands

| Branch | Tip | Ahead of main |
|---|---|---|
| db | b4f4d3e | 0 — merged |
| backend | a6f4d33 | 0 — merged |
| frontend | 998d23b | 0 — merged (this run) |
| docs-ratify | 548b23b | 0 — merged |

Nothing is left in the merge queue from this round. `services/api/migrations` still ends at
`0014_opname.sql`: **DB has not yet shipped the F-15 view fix**, so the one failing assertion
above is unchanged and expected.

---

## PRDTASK — F-15 fixed (2026-11-25)

Reproduced first, on a fresh tenant: one paid 60.000 sale plus a real 5.000 listrik
expense, then void the sale.

Before: `revenue 0 | hpp 0 | opex 65000 | net -65000` — the void's mirror cash entry was
counted as operating expense, understating net by the sale total.

Root cause was worse than the view: the exclusion rule exists in **three** places, and the
API's report handler never read `v_opex` at all — it re-implemented the rule inline in the
totals query *and* in the opex drill-down. So fixing only DB's view changed nothing on the
wire. That is the real defect: one accounting rule, three copies, already drifting.

Fixed:
- `0015_opex_excludes_sale_reversal.sql` — `v_opex` excludes `ref_type in ('sale','sale_void')`
  as well as `purchase`/`stock_move`, keeps `security_invoker = true`.
- `routes/reports.rs` — the same exclusion added to both inline queries (totals and drill),
  with a comment pointing at the view so the next person sees the duplication.

After: `revenue 0 | hpp 0 | opex 5000 | net -5000`, and the opex drill-down lists only
`[('listrik', 5000)]`. That is correct: the sale vanished, the real expense remains.

Verified: cargo build, fmt, clippy `-D warnings` clean; cargo test 10/10 with
STOKKU_TEST_ADMIN_URL; acceptance harness **67 pass / 0 fail** on :8099, which includes the
three void assertions (revenue drops by exactly the sale, opex unchanged by the void,
revenue − hpp − opex = net).

Filed for a later increment (not fixed here, because it is a refactor rather than a bug):
the opex rule should live in exactly one place. Two of the three copies are gone from the
API path, but the handler still computes totals instead of reading `v_opex`.
