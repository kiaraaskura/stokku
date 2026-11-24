
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
