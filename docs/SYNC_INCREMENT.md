# Sync Increment — T-301..T-310

The PRD calls this the highest-risk part of the build (§9). It is the last big block before release.
Everything below is the contract; the Captain sequences it DB → Backend → Frontend like Sprint 2.

## Why it matters more than it looks

Today the web app queues writes in an outbox and retries them at their own REST endpoints. That works
for one device and it has a hole: `POST /items` and `POST /cash-entries` carry no `op_id`, so a retry
after an ambiguous timeout can create a duplicate. Sales and stock moves dedupe because they carry an
`op_id`. Sync closes that class of bug properly and is the only thing that makes a second device safe.

## The rule that makes the whole thing tractable

**Append-only entities never conflict.** Two devices adding a sale both add a sale. Only master data
(items, categories, settings) can conflict, and that is last-write-wins on the *server* clock with a
visible notice. Do not build CRDTs, peer-to-peer sync, or real-time collaboration — the PRD rules them
out for one shop with 1–3 devices.

## Push

```http
POST /v1/sync/push
{ "device_id": "<uuid>", "ops": [ { "op_id":"<uuidv7>", "type":"...", "payload":{…}, "client_ts":"..." } ] }
→ 200 { "results":[{"op_id":"…","status":"applied|duplicate|rejected","reason":null}], "cursor": 88421 }
```

- Max 50 ops. One DB transaction per batch, applied in `client_ts` then `op_id` order.
- `op_log.op_id` is the primary key: the same op twice is `duplicate`, never a second effect.
- A rejected op (validation, closed period, forbidden) reports `rejected` with a reason and **does not
  abort the batch** — the other ops in it still apply. The client routes rejected ops to the
  "Perlu dicek" inbox; nothing silently disappears.
- Op types for this increment: `stock_move.create`, `sale.create`, `cash_entry.create`,
  `item.create`, `item.update`, `opname.post`. Partial success per op, never per batch.

## Pull

```http
GET /v1/sync/pull?cursor=88421&limit=500
→ 200 { "changes":[{"table":"item","row":{…},"server_seq":88422,"deleted":false}], "cursor":88940, "has_more":false }
```

- Cursor is a `server_seq` watermark, never a timestamp. Client clock is never trusted for ordering.
- Cursor advances **only after the client commits** the pulled rows (T-304).
- `deleted: true` is a tombstone; soft-deleted items still pull so a device knows to hide them.
- Server-written rows (a QRIS confirm, a settlement import) arrive through this same path. The client
  must never assume it authored everything it sees, and must not clobber a server-set `paid` flag with
  a stale local value.

## Client rules

- Outbox persists in SQLite; the row and its op are written in the **same local transaction**.
- UI reads only local tables — one source of render, so a screen never flickers between local and server.
- Triggers: app foreground, network regained, 1 s debounce after a mutation, and every 15 min in background.
- Sync state visible but quiet: a dot with synced / pending / error + count, never a blocking modal. A
  failed push must never render as synced — that invariant is already tested on the web side and stays.
- Conflicts and rejections land in "Perlu dicek" (T-220) as actionable items: retry, edit, discard.

## Acceptance (section C — currently 2/5)

14. Airplane mode: stock in, 5-line sale, cash entry, QRIS confirm all succeed; dot shows pending.
15. Reconnect: all four sync once; counts and laba rugi identical; no duplicates.
16. Replay the same push batch manually: every op returns `duplicate`, totals unchanged.
17. Kill the app mid-sync: reopen, no lost op, no duplicate.
18. Second device: sees the same stock and report within one cycle; edit an item on both, newer server
    write wins, device A shows "diubah di perangkat lain".

## Test that must exist (T-307)

Two scripted devices, 500 random ops, then assert both converge to identical stock and money totals.
This is the one test whose absence would let a silent corruption ship.

## Explicitly out of scope

CRDT merge, P2P, live cursors, multi-outlet transfer, offline settlement edits. Closed periods (V1)
still reject backdated ops — that path exists in the schema and must keep working.
