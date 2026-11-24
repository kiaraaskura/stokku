
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
