/**
 * Sync engine (T-304/T-305, docs/SYNC_INCREMENT.md) — replaces the
 * per-endpoint retry. Pushes the outbox in batches of up to 50 and applies
 * pulls in ONE local transaction per page, advancing the cursor only after
 * that commit.
 *
 * Invariants:
 * - an op is removed from the queue only after the server answered for it
 *   (applied or duplicate) — a network failure keeps the whole batch queued
 * - rejected ops are routed to the "Perlu dicek" inbox, never dropped
 * - the pull cursor advances only inside the transaction that applied the page
 * - a server-set paid flag is never clobbered (repo applyPullPage)
 */
import type { Repository } from '../db/store'
import type { ApiClient } from '../api/client'
import { NetworkError } from '../api/types'

export interface SyncRunResult {
  pushed: number
  duplicates: number
  rejected: number
  pulled: number
  ok: boolean
  error?: string
}

const CLIENT_ONLY_KEYS = ['op_id', 'local_id']

function cleanPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (!CLIENT_ONLY_KEYS.includes(k)) out[k] = v
  }
  return out
}

function opTitle(op: { type: string; payload: Record<string, unknown> }): string {
  const p = op.payload
  const name = typeof p['name'] === 'string' ? p['name'] : typeof p['note'] === 'string' ? p['note'] : ''
  switch (op.type) {
    case 'item.create':
    case 'item.update':
      return name || 'Barang'
    case 'stock_move.create':
      return `Stok masuk${name ? ` — ${name}` : ''}`
    case 'sale.create':
      return `Penjualan ${formatAmount(p['lines'])}`
    case 'cash_entry.create':
      return `Catatan kas ${p['category'] ?? ''} ${p['amount'] ?? ''}`
    case 'opname.post':
      return 'Opname'
    default:
      return op.type
  }
}

function formatAmount(lines: unknown): string {
  if (!Array.isArray(lines)) return ''
  const total = lines.reduce((s, l) => s + Number((l as { unit_price?: number; qty?: number })?.unit_price ?? 0) * Number((l as { qty?: number })?.qty ?? 0), 0)
  return total > 0 ? String(total) : ''
}

/** One sync run: push every pending batch, then pull until exhausted. */
export async function runSync(repo: Repository, api: ApiClient, online: boolean): Promise<SyncRunResult> {
  const result: SyncRunResult = { pushed: 0, duplicates: 0, rejected: 0, pulled: 0, ok: true }
  if (!online || !api.hasSession()) {
    result.ok = false
    result.error = 'offline'
    return result
  }

  const { deviceId } = await repo.call('getSyncState')

  // ---- push: batches of 50, in client order ----
  const ownEchoSignatures: string[] = []
  for (;;) {
    const ops = await repo.call('pendingOutboxList', 50)
    if (ops.length === 0) break
    try {
      const res = await api.syncPush({
        device_id: deviceId,
        ops: ops.map((op) => ({
          op_id: op.opId,
          type: op.type,
          payload: cleanPayload(op.payload),
          client_ts: op.clientTs,
        })),
      })
      for (const r of res.results ?? []) {
        const op = ops.find((o) => o.opId === r.op_id)
        if (r.status === 'rejected') {
          await repo.call('addInboxRow', {
            id: r.op_id,
            kind: 'rejected',
            type: op?.type ?? 'unknown',
            payload: op?.payload ?? {},
            reason: r.reason,
            title: op ? opTitle(op) : r.op_id,
          })
          await repo.call('clearOutboxOp', r.op_id)
          result.rejected += 1
        } else {
          // applied or duplicate: either way the op is settled server-side.
          // The server assigns its OWN row ids (create payloads never carry the
          // local row id), so the pull will bring the server row under a new id.
          // Remove the local optimistic row now or the store would hold both
          // and double-count offline views (sales list, local laba rugi).
          const localId = typeof op?.payload?.['local_id'] === 'string' ? (op.payload['local_id'] as string) : null
          if (localId && r.status === 'applied') {
            if (op?.type === 'sale.create') await repo.call('deleteLocalSale', localId)
            else if (op?.type === 'cash_entry.create') await repo.call('deleteCashEntryRow', localId)
            else if (op?.type === 'stock_move.create') await repo.call('deleteStockMoveRow', localId)
            // item.create cannot be resolved here: the push result carries no
            // server row id, so the local item stays until a contract-level
            // id mapping exists (see the channel report).
          }
          if (op?.type === 'item.update' && op?.payload) {
            const p = op.payload
            ownEchoSignatures.push(
              [
                typeof p['name'] === 'string' ? p['name'] : '',
                Number(p['sale_price'] ?? 0),
                Math.round(Number(p['min_stock'] ?? 0) * 1000),
                p['active'] === false ? 0 : 1,
              ].join('|'),
            )
          }
          await repo.call('clearOutboxOp', r.op_id)
          if (r.status === 'duplicate') result.duplicates += 1
          else result.pushed += 1
        }
      }
    } catch (err) {
      if (err instanceof NetworkError) {
        result.ok = false
        result.error = 'network'
        return result
      }
      result.ok = false
      result.error = err instanceof Error ? err.message : String(err)
      return result
    }
  }

  // ---- pull: one transaction per page; cursor only after the commit ----
  for (;;) {
    const { cursor } = await repo.call('getSyncState')
    let page: Awaited<ReturnType<typeof api.syncPull>>
    try {
      page = await api.syncPull(cursor)
    } catch (err) {
      if (err instanceof NetworkError) {
        result.ok = false
        result.error = 'network'
        break
      }
      result.ok = false
      result.error = err instanceof Error ? err.message : String(err)
      break
    }
    await repo.call('applyPullPage', page.changes ?? [], page.cursor, page.has_more ?? false, ownEchoSignatures)
    result.pulled += (page.changes ?? []).length
    if (!page.has_more) break
  }

  return result
}
