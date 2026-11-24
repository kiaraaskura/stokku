/**
 * Outbox flush (demo-spine API increment). Posts queued ops to the real API
 * in client order. No /sync/push — that is Backend's next increment; this
 * engine replays each op against its contract endpoint.
 *
 * Guarantees:
 * - an op is removed from the queue only after a confirmed 2xx (never silently "synced")
 * - a network failure keeps the op queued; a later retry sends the SAME op_id
 *   (sales and stock moves carry op_id, so the server deduplicates)
 * - ops rejected with 4xx/5xx are marked failed so they stop blocking the queue
 */
import type { Repository } from '../db/store'
import type { ApiClient } from '../api/client'
import { NetworkError, ApiError } from '../api/types'

export interface FlushResult {
  posted: number
  failed: number
  networkStopped: boolean
}

const CLIENT_ONLY_KEYS = ['op_id', 'local_id']

function stripClientKeys<T extends Record<string, unknown>>(payload: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (!CLIENT_ONLY_KEYS.includes(k)) out[k] = v
  }
  return out
}

/**
 * Flush pending ops. Stops at the first network failure (order matters);
 * rejected ops are marked failed and skipped.
 */
export async function flushOutbox(repo: Repository, api: ApiClient, online: boolean): Promise<FlushResult> {
  const result: FlushResult = { posted: 0, failed: 0, networkStopped: false }
  if (!online || !api.hasSession()) return result

  let ops: Awaited<ReturnType<typeof repo.call<'pendingOutboxList'>>>
  try {
    ops = await repo.call('pendingOutboxList', 50)
  } catch {
    return result
  }

  for (const op of ops) {
    try {
      await postOp(repo, api, op)
      await repo.call('clearOutboxOp', op.opId)
      result.posted += 1
    } catch (err) {
      if (err instanceof NetworkError) {
        // keep this op and everything behind it queued
        result.networkStopped = true
        break
      }
      const reason = err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err)
      await repo.call('markOutboxFailed', op.opId, reason)
      result.failed += 1
    }
  }
  return result
}

async function postOp(
  repo: Repository,
  api: ApiClient,
  op: { opId: string; type: string; payload: Record<string, unknown> },
): Promise<void> {
  const payload = op.payload
  switch (op.type) {
    case 'item.create': {
      const localId = typeof payload['local_id'] === 'string' ? (payload['local_id'] as string) : null
      const body = stripClientKeys(payload)
      const item = await api.createItem(body)
      if (localId) {
        await repo.call('remapItemId', localId, item.id)
      }
      await repo.call('applyServerItems', [item])
      return
    }
    case 'item.update': {
      const id = await repo.call('resolveIdMap', String(payload['id'] ?? ''))
      const body = stripClientKeys(payload)
      const item = await api.updateItem(id, body)
      await repo.call('applyServerItems', [item])
      return
    }
    case 'stock_move.create': {
      const body = stripClientKeys(payload)
      body['item_id'] = await repo.call('resolveIdMap', String(body['item_id'] ?? ''))
      const move = await api.stockMove(body)
      await repo.call('applyServerStockMove', move)
      // refresh the item so stock / cost_avg reflect server truth immediately
      try {
        const item = await api.getItem(String(body['item_id']))
        await repo.call('applyServerItems', [item])
      } catch {
        // the move posted; item refresh can happen on the next read
      }
      const localId = typeof payload['local_id'] === 'string' ? (payload['local_id'] as string) : null
      if (localId) {
        await repo.call('deleteStockMoveRow', localId)
      }
      return
    }
    case 'sale.create': {
      const body = stripClientKeys(payload)
      // op_id IS part of the POST /sales contract body — keep it for dedupe.
      body['op_id'] = op.opId
      const lines = Array.isArray(body['lines']) ? (body['lines'] as Record<string, unknown>[]) : []
      for (const line of lines) {
        if (typeof line['item_id'] === 'string') {
          line['item_id'] = await repo.call('resolveIdMap', line['item_id'])
        }
      }
      const sale = await api.postSale(body)
      await repo.call('applyServerSale', sale)
      for (const line of lines) {
        try {
          const item = await api.getItem(String(line['item_id']))
          await repo.call('applyServerItems', [item])
        } catch {
          // stock refresh can happen on the next read
        }
      }
      const localId = typeof payload['local_id'] === 'string' ? (payload['local_id'] as string) : null
      if (localId) {
        await repo.call('deleteLocalSale', localId)
      }
      return
    }
    case 'cash_entry.create': {
      const body = stripClientKeys(payload)
      const entry = await api.addCashEntry(body)
      await repo.call('applyServerCashEntry', entry)
      const localId = typeof payload['local_id'] === 'string' ? (payload['local_id'] as string) : null
      if (localId) {
        await repo.call('deleteCashEntryRow', localId)
      }
      return
    }
    default:
      throw new ApiError(0, 'unsupported_op', `unknown outbox op type: ${op.type}`)
  }
}
