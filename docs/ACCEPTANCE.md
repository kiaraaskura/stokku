# Acceptance — MVP demo spine

The Captain runs this end-to-end after each sprint gate. A task is not done until its line here passes **by hand**, with the result noted.
Seed: `owner@demo.test / Demo1234!`, `staff@demo.test`.

## A. Accounting spine (most important)

1. Fresh shop, item **Gula 1 kg**, sale price 12.000, cost 0.
2. Stock in 10 @ 6.000 → stock 10, `cost_avg` 6.000.
3. Stock in 10 @ 9.000 → stock 20, `cost_avg` **7.500** (moving average, not 9.000, not 6.000).
4. Sell 5 @ 12.000 cash → stock 15; sale total 60.000; `cost_at_sale` 7.500; HPP 37.500.
5. Cash out 5.000 category `listrik` → opex 5.000.
6. Laba rugi this month: revenue **60.000**, HPP **37.500**, gross **22.500**, opex **5.000**, net **17.500** — to the rupiah.
7. Tap revenue → the sale is listed. Tap HPP → the sale line is listed. Tap opex → the cash entry is listed.
8. Buy 10 more @ 6.000 (stock purchase 60.000). Net profit **does not change**; stock value rises to 150.000. This is the "stok bukan beban" rule.

## B. Ledger integrity

9. Reverse the 10 @ 9.000 stock-in after the sale. A cost-impact warning appears before confirming. After: stock 15, ledger running balance equals the sum of deltas at every row.
10. Negative stock: sell 20 of an item with 5 → sale succeeds, item flagged, warning visible, nothing blocked.
11. Opname: system 15, count 14 → one −1 adjustment. Force an error mid-post → **zero** adjustments posted (retry works).
12. Void a sale → stock restored, cash reversed, sale marked void, revenue drops by exactly that sale. Nothing deleted.
13. Try to delete an item with movements → refused with a readable Indonesian reason.

## C. Offline and sync

14. Airplane mode. Do: stock in, 5-line sale, cash entry, QRIS confirm. All succeed. Sync dot shows pending.
15. Reconnect → all four sync once. Counts and the laba rugi are identical to before, no duplicates.
16. Repeat the same push batch manually → every op returns `duplicate`, totals unchanged.
17. Kill the app mid-sync → reopen → no lost op, no duplicate.
18. Second device (browser profile B) signs in → sees the same stock and report within one sync cycle. Edit an item on both → newer server write wins and device A shows "diubah di perangkat lain".

## D. QRIS (Tier 0)

19. Outlet QRIS: paste a static payload with a valid CRC → QR renders scannable at 100% on a 5" viewport; bad CRC → readable rejection.
20. Checkout → QRIS → QR opens < 300 ms, works offline → "Sudah dibayar" → payment gross 60.000, MDR 0,7% → fee 420, net 59.580. Report shows gross revenue and the fee separately.

## E. Roles

21. Staff login: no cost column, no HPP, no profit, no report nav. Direct `GET /reports/laba-rugi` with the staff token → **403**.
22. Staff can record stock in/out, a sale, and a cash entry. Owner sees the actor in the ledger and audit log.

## F. Reports and export

23. Stock report at cost = Σ(qty × cost_avg) = ledger value; low-stock list updates immediately after a sale.
24. Sales report by day/item matches the sales list.
25. Export sales CSV → row count and total match the screen. Export laba rugi PDF → opens on a phone.
26. Dashboard loads < 1 s from local data and every number matches its report.

## G. Non-functional spot checks

27. 5.000 seeded items: search returns < 100 ms locally, list scrolls smoothly.
28. 360 px width: no horizontal scroll, all primary buttons reachable with a thumb.
29. Keyboard-only desktop: complete a stock-in without a mouse.
30. Contrast ≥ 4.5:1 on body text and the sync dot has a text label, not colour alone.

## Pass rule

Sections A–E must be **all green** before the demo is called done. F–G may carry a known-issue note, signed by the Captain, with impact and workaround. Any data-loss or wrong-number finding reopens its task with priority over new work.