# API Contract — Stokku v1

Frozen interface between `services/api` and `apps/web`. Change only by PRDTASK or Captain note.
Base: `/v1`. JSON. Auth: `Authorization: Bearer <access_jwt>` unless marked public.
All money = integer rupiah. All qty = decimal string or number with max 3 dp. Dates = ISO-8601 UTC; `business_date` = `YYYY-MM-DD` in the outlet timezone.

## Errors

```json
{ "error": { "code": "validation_failed", "message": "Qty harus lebih dari 0", "fields": { "qty": "min 0.001" } } }
```

Codes: `unauthorized` 401 · `forbidden` 403 · `not_found` 404 · `validation_failed` 422 · `conflict` 409 · `period_closed` 423 · `rate_limited` 429 · `internal` 500.
Every list response: `{ "data": [...], "next_cursor": null }`. Every write response returns the full created/updated row.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/signup` | `{email, password, name, business_name}` | public; creates tenant + owner membership; returns tokens |
| POST | `/auth/login` | `{email, password}` | public; rate-limited |
| POST | `/auth/refresh` | `{refresh_token}` | public; rotates; reuse ⇒ revoke all |
| POST | `/auth/logout` | `{refresh_token}` | public |
| GET | `/me` | — | user, tenant, outlets, role, capabilities |

```json
{ "access_token": "…", "refresh_token": "…", "expires_in": 900,
  "user": {"id":"…","name":"…","email":"…"},
  "tenant": {"id":"…","name":"…","tax_rate":0},
  "outlet": {"id":"…","name":"…","timezone":"Asia/Jakarta"},
  "role": "owner" }
```

`GET /me` adds `"capabilities": ["stock.write","sales.write","cash.write","report.read","cost.read","item.write","member.manage","export"]`. Staff never receives `cost.read`, `report.read`, `item.write`, `member.manage`, `export`.

## Catalog

| Method | Path | Notes |
|---|---|---|
| GET | `/items?q=&category_id=&active=&low_stock=true&cursor=` | search name/SKU/barcode; 50/page |
| POST | `/items` | `{name, sku?, barcodes[], category_id?, base_unit, units:[{name,factor}], sale_price, cost, min_stock, active}` |
| GET | `/items/{id}` | item + units + barcodes + stock per outlet |
| PATCH | `/items/{id}` | partial; price/cost changes are owner-only |
| DELETE | `/items/{id}` | soft delete; 409 if movements exist |
| GET | `/items/search?q=` | typeahead, max 10, supports barcode exact match first |
| GET/POST | `/categories` | flat list, `{name, sort}` |
| POST | `/items/import` | multipart CSV; dry-run returns per-row errors |

Item shape: `{id, sku, name, category_id, base_unit, sale_price, cost_avg, min_stock, active, stock, low_stock, negative_stock, updated_at}`.
`low_stock` = `stock <= min_stock`; `negative_stock` = `stock < 0` (additive, approved 2026-11-24 — a data-integrity flag, not a reorder hint).
`cost_avg` and any margin field are omitted for staff.

## Stock

| Method | Path | Body / notes |
|---|---|---|
| GET | `/stock-moves?item_id=&outlet_id=&from=&to=&cursor=` | 100/page, newest first |
| GET | `/items/{id}/ledger?outlet_id=` | `{rows:[{business_date, type, qty_delta, unit_cost, balance, ref_type, ref_id, note, actor}], closing_qty}` |
| POST | `/stock-moves` | `{item_id, outlet_id, type: "in"|"loss"|"return"|"adjust", qty_positive, unit_cost?, business_date, supplier?, note?, op_id?}` |
| POST | `/stock-moves/{id}/reverse` | `{reason, business_date, op_id?}`; response includes `cost_impact_warning?` |
| POST | `/stock-moves/preview-reverse/{id}` | returns the warning before confirming |
| POST | `/opname` | `{outlet_id, category_id?, item_ids?}` → session with `system_qty` per line |
| GET | `/opname/{id}` | session + counted values |
| PATCH | `/opname/{id}/lines` | `{lines:[{item_id, counted_qty}]}` |
| POST | `/opname/{id}/post` | atomic; returns `posted`, `adjustments[]` |

Sale stock moves are created by `/sales`, never by the client directly.

## Sales

| Method | Path | Body / notes |
|---|---|---|
| POST | `/sales` | see below; atomic |
| GET | `/sales?from=&to=&cursor=` | |
| GET | `/sales/{id}` | with lines + payment |
| POST | `/sales/{id}/void` | `{reason}`; reverses stock and money; never deletes |
| POST | `/sales/daily` | `{outlet_id, business_date, amount, note?}` daily-total mode: revenue only, no stock moves, `mode:"daily_total"` |

```json
{ "outlet_id": "…", "business_date": "2026-11-24",
  "customer_id": null, "discount": 0,
  "payment_method": "cash|transfer|qris|credit",
  "paid": true, "note": "",
  "lines": [ {"item_id":"…","qty":2,"unit_price":15000,"discount":0} ],
  "op_id": "0193…" }
```

Response: sale with `number`, `total`, `lines[]` (each with `cost_at_sale` for owner), `payment`, `note`, `created_moves[]`.
Credit sale (`payment_method:"credit"` or `paid:false`) stores a receivable stub and appears in laba rugi as revenue with `unpaid: true`.

## Cash book

| Method | Path | Notes |
|---|---|---|
| GET | `/cash-entries?from=&to=&category=&cursor=` | `{data:[…], totals:{in,out,net}}` |
| POST | `/cash-entries` | `{outlet_id, direction:"in"|"out", amount, category, method, business_date, note?, ref_type?, ref_id?}` |
| DELETE | `/cash-entries/{id}` | reversal entry, not deletion |
| GET | `/cash-categories` | seeded + custom |

## QRIS (Tier 0 — no provider integration)

| Method | Path | Notes |
|---|---|---|
| GET | `/outlets/{id}/qris` | `{mode:"none"|"static_image"|"static_payload", image_url?, payload?, mdr_pct}` |
| PUT | `/outlets/{id}/qris` | owner only; validates payload + CRC; rejects unreadable image |
| POST | `/sales/{id}/qris/confirm` | `{amount_gross, mdr_pct?, paid_at}` → payment `{gross, mdr_amount, net, status:"paid"}`; idempotent per sale |

`net = gross − round(gross * mdr_pct / 100)`. Confirm works offline on the client and syncs as an op; the server rejects a second confirm for the same sale.

## Reports (owner only)

| Method | Path | Notes |
|---|---|---|
| GET | `/reports/laba-rugi?from=&to=&compare=true` | `{revenue, hpp, gross_profit, opex, qris_mdr_fee, net_profit, unpaid_revenue, comparison:{...}, lines:[...]}` |
| GET | `/reports/laba-rugi/drill?line=revenue` | contributing transactions |
| GET | `/reports/stock?outlet_id=` | `{at_cost, at_sale, low_stock[], dead_stock[], data:[{item_id,item_name,qty,cost_avg,sale_price,value_at_cost,value_at_sale,low_stock,negative_stock,last_movement_date,dead_stock,move_count,move_count_90d}]}` |
| GET | `/reports/sales?from=&to=&group_by=day\|item\|category` | `{data:[{day?,item_id?,category_id?,revenue,sale_count,daily_total_count,line_count}], …}`; `group_by=day` is the only one that includes `daily_total` sales |
| GET | `/reports/dashboard?outlet_id=` | `{today_sales, cash_position, low_stock_count, month_profit}` |

Laba rugi definition is fixed: `revenue − hpp − opex = net_profit`; stock purchases are inventory, not expense.
`qris_mdr_fee` (approved 2026-11-25) reports the MDR withheld on QRIS separately; revenue stays **gross**, so profit is not understated by the fee. `data[]` on the stock report (approved 2026-11-25) is the per-item detail behind the four totals; totals are authoritative, `data` is the drill-down.

## Exports (owner only)

| Method | Path | Notes |
|---|---|---|
| GET | `/exports/sales.csv?from=&to=` | one row per non-voided sale; row count and total reconcile with `/reports/sales` for the same range |
| GET | `/exports/stock.csv` | current stock per item with `cost_avg`, `sale_price`, `value_at_cost`, `value_at_sale` |
| GET | `/exports/stock-moves.csv?from=&to=` | stock ledger rows in `business_date` order |
| GET | `/exports/cash.csv?from=&to=` | cash-book entries (`direction`, `category`, `amount`, `ref_type`) |
| GET | `/exports/laba-rugi.csv?from=&to=` | `kunci,label,jumlah` rows for the same totals as `/reports/laba-rugi` |
| GET | `/exports/laba-rugi.html?from=&to=&compare=true` | printable laba rugi; self-contained HTML, no scripts, prints to PDF from any phone browser |
| GET | `/exports/opname/{id}` | printable stock count sheet for one opname session |
| GET | `/exports/account.zip` | full account archive: `manifest.json`, `full_data.json` and 7 CSVs (items, stock levels, stock moves, sales with lines, cash entries, contacts, laba rugi all time) |

`from`/`to` default to 1 January of the current year through today (Asia/Jakarta). CSV is deliberately spreadsheet-safe for an Indonesian locale: header row, integer rupiah without thousand separators, qty fixed to 3 decimals, ISO-8601 dates, CRLF, minimal quoting. Exports stream; a 50k-row ledger must finish under 60 s. Every path is `Cap::Export`, so a staff token gets `403` on all of them, and every query runs under the caller's RLS context.

## Contacts, payables and receivables (T-133)

Contacts are operational, so both owner and staff may read and write them. Payables
and receivables are money, so writing one uses `Cap::CashWrite` like the cash book.
Every payment against a bill posts a `cash_entry` in the same transaction — the cash
book stays the only record of money movement.

| Method | Path | Notes |
|---|---|---|
| GET | `/contacts?type=customer\|supplier&q=` | `{items:[{id,type,name,phone,created_at}]}`; `q` matches name or phone |
| POST | `/contacts` | `{type,name,phone?}`; 422 on an unknown type or empty name |
| PATCH | `/contacts/{id}` | `{name?,phone?}`; type is immutable once set |
| DELETE | `/contacts/{id}` | 409 once the contact is on a sale, payable or receivable — history never dangles |
| GET | `/payables?contact_id=&open=true` | `{items:[…,outstanding], outstanding_total}`; `open=true` hides settled bills |
| POST | `/payables` | `{contact_id,amount,due_date?}`; contact must be a supplier; `amount` is integer rupiah > 0 |
| POST | `/payables/{id}/payments` | `{amount,business_date?,method?,category?,outlet_id?,note?,op_id?}`; posts a `cash_entry` `out`, `ref_type="payable_payment"`, `ref_id`=bill id. Overpayment is refused with 422 and the exact remainder — never clamped. Returns `{bill, cash_entry_id, settled}` |
| GET | `/receivables?contact_id=&open=true` | same shape as `/payables` |
| POST | `/receivables` | `{contact_id,amount,due_date?,sale_id?}`; contact must be a customer |
| POST | `/receivables/{id}/payments` | posts a `cash_entry` `in`, `ref_type="receivable_payment"`. Returns `{bill, cash_entry_id, settled}` |

A payable payment defaults to category `pembelian_stok`, which the opex rule already
excludes ("stok bukan beban"), so settling a supplier debt is not booked as a second
expense. A receivable payment is money in against revenue already recognised at the
sale, so it adds no revenue. Payers pick another category when the debt is operating
(e.g. `sewa`), and then it does count as opex — once.

## Opname

| Method | Path | Notes |
|---|---|---|
| POST | `/opname` | `{outlet_id, category_id?}` or `{outlet_id, item_ids?}`; snapshots `system_qty` per line; 422 on an empty scope |
| GET | `/opname/{id}` | session + lines with `system_qty`, `counted_qty`, live `current_qty` |
| PATCH | `/opname/{id}/lines` | `{lines:[{item_id, counted_qty}]}`; open sessions only, 409 after post |
| POST | `/opname/{id}/post` | one `adjust` move per non-zero variance, measured against live stock, in one transaction; `{posted, adjustments:[{item_id, qty, system_qty_at_post, counted_qty, move_id}], session}`; re-post 409 |

`system_qty` is an immutable snapshot (DB trigger). Posted lines are immutable forever; session history is never edited. A count of 0 is a count, not "unset".

## Sync

```http
POST /sync/push
{ "device_id":"…", "ops":[ {"op_id":"uuidv7","type":"stock_move.create|sale.create|cash_entry.create|item.update|opname.post","payload":{…},"client_ts":"…"} ] }
→ 200 { "results":[{"op_id":"…","status":"applied|duplicate|rejected","reason":null}], "cursor": 88421 }
```

Max 50 ops; applied in one transaction ordered by `client_ts`, then `op_id`; unique `op_log.op_id` gives exactly-once.

```http
GET /sync/pull?cursor=88421&limit=500
→ 200 { "changes":[{"table":"item","row":{…},"server_seq":88422,"deleted":false}], "cursor":88940, "has_more":false }
```

Server-written rows (QRIS confirm, settlement) arrive through the same pull path.

## Access

| Capability | owner | staff |
|---|---|---|
| stock.write, sales.write, cash.write | ✓ | ✓ |
| cost.read, report.read, item.write, member.manage, export | ✓ | — |

Enforced in handlers, not just the UI. Staff token hitting a restricted endpoint gets `403 forbidden`.

## Ops format

Every mutating client call carries a client-generated UUIDv7 `op_id` (server generates one if absent). Same `op_id` twice = `duplicate`, no second effect. Local SQLite writes the op to an outbox in the same transaction as the local row.