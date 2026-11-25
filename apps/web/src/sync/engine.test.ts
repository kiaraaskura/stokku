import { beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { makeDbAdapter, type Db } from '../db/db-api'
import {
  resetAll,
  stockIn,
  postSale,
  addCashEntry,
  pendingOutboxCount,
  applyPullPage,
  listInbox,
  addOutboxOpDirect,
} from '../db/repo'
import { runSync } from './engine'
import { NetworkError, ApiError } from '../api/types'
import type { ApiClient } from '../api/client'
import { todayISO } from '../lib/date'

let db: Db

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => wasmPath, useOldExtensionFunctions: true })
  db = makeDbAdapter(new SQL.Database())
  resetAll(db)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const repoMethods = (await import('../db/repo')) as any

function freshRepo() {
  return {
    persisted: true,
    call: (method: string, ...args: unknown[]) => {
      const fn = (repoMethods as Record<string, (d: Db, ...a: unknown[]) => unknown>)[method]
      if (!fn) throw new Error(`no repo method ${method}`)
      return fn(db, ...args)
    },
  } as unknown as import('../db/store').Repository
}

async function setupShop() {
  const { completeOnboarding, createItem, getItem } = await import('../db/repo')
  resetAll(db)
  completeOnboarding(db, { businessName: 'Warung Sync', businessType: 'kelontong', taxRatePercent: 0, opening: null })
  const item = createItem(db, {
    name: 'Gula Sinkron',
    sku: null,
    barcodes: [],
    categoryId: null,
    baseUnit: 'pcs',
    units: [],
    salePrice: 12000,
    cost: 0,
    minStockM: 0,
    active: true,
  })
  void getItem
  return item
}

describe('push: outbox clears only on a confirmed server answer', () => {
  it('keeps the whole batch queued on network failure', async () => {
    const item = await setupShop()
    await stockIn(db, { itemId: item.id, qtyM: 1000, unitCost: 500, businessDate: todayISO(), note: null, supplier: null })
    const before = pendingOutboxCount(db)
    const fakeApi = {
      hasSession: () => true,
      syncPush: async () => {
        throw new NetworkError('down')
      },
      syncPull: async () => ({ changes: [], cursor: 0, has_more: false }),
    } as unknown as ApiClient
    const res = await runSync(freshRepo(), fakeApi, true)
    expect(res.ok).toBe(false)
    expect(pendingOutboxCount(db)).toBe(before) // nothing silently settled
  })

  it('clears applied and duplicate ops; a duplicate never double-applies locally', async () => {
    await setupShop()
    await addCashEntry(db, {
      direction: 'out',
      amount: 5000,
      category: 'listrik',
      method: 'cash',
      businessDate: todayISO(),
      note: null,
      refType: null,
      refId: null,
    })
    const { listCashEntries } = await import('../db/repo')
    const before = (await listCashEntries(db, todayISO().slice(0, 7))).entries.length
    const seenOpIds: string[] = []
    const fakeApi = {
      hasSession: () => true,
      syncPush: async (body: { ops: { op_id: string }[] }) => {
        for (const op of body.ops) seenOpIds.push(op.op_id)
        return {
          results: body.ops.map((o) => ({ op_id: o.op_id, status: 'duplicate', reason: null })),
          cursor: 0,
        }
      },
      syncPull: async () => ({ changes: [], cursor: 0, has_more: false }),
    } as unknown as ApiClient
    const res = await runSync(freshRepo(), fakeApi, true)
    expect(res.duplicates).toBeGreaterThanOrEqual(1)
    expect(pendingOutboxCount(db)).toBe(0)
    // duplicates are settled server-side; the local rows are unchanged
    expect((await listCashEntries(db, todayISO().slice(0, 7))).entries.length).toBe(before)
    // replaying the identical batch: same op_ids, still no local double-apply
    await addOutboxOpDirect(db, {
      opId: seenOpIds[0]!,
      type: 'cash_entry.create',
      payload: { direction: 'out', amount: 5000, category: 'listrik', method: 'cash', business_date: todayISO() },
    })
    const res2 = await runSync(freshRepo(), fakeApi, true)
    expect(res2.duplicates).toBeGreaterThanOrEqual(1)
    expect((await listCashEntries(db, todayISO().slice(0, 7))).entries.length).toBe(before)
  })
})

describe('rejected ops land in the "Perlu dicek" inbox', () => {
  it('routes a rejected op to the inbox with its reason', async () => {
    const item = await setupShop()
    await stockIn(db, { itemId: item.id, qtyM: 1000, unitCost: 500, businessDate: todayISO(), note: null, supplier: null })
    const fakeApi = {
      hasSession: () => true,
      syncPush: async (body: { ops: { op_id: string; type: string }[] }) => ({
        results: body.ops.map((o) =>
          o.type === 'item.create'
            ? { op_id: o.op_id, status: 'applied' as const, reason: null }
            : { op_id: o.op_id, status: 'rejected' as const, reason: 'Qty harus lebih dari 0' },
        ),
        cursor: 0,
      }),
      syncPull: async () => ({ changes: [], cursor: 0, has_more: false }),
    } as unknown as ApiClient
    const res = await runSync(freshRepo(), fakeApi, true)
    expect(res.rejected).toBe(1)
    expect(pendingOutboxCount(db)).toBe(0)
    const inbox = listInbox(db)
    expect(inbox.length).toBe(1)
    expect(inbox[0]!.kind).toBe('rejected')
    expect(inbox[0]!.reason).toContain('Qty')
  })

  it('a rejected op does not abort the batch — the other ops still settle', async () => {
    const item = await setupShop()
    await stockIn(db, { itemId: item.id, qtyM: 1000, unitCost: 500, businessDate: todayISO(), note: null, supplier: null })
    const fakeApi = {
      hasSession: () => true,
      syncPush: async (body: { ops: { op_id: string; type: string }[] }) => ({
        results: body.ops.map((o, i) =>
          i === 0
            ? { op_id: o.op_id, status: 'rejected' as const, reason: 'reason' }
            : { op_id: o.op_id, status: 'applied' as const, reason: null },
        ),
        cursor: 0,
      }),
      syncPull: async () => ({ changes: [], cursor: 0, has_more: false }),
    } as unknown as ApiClient
    const res = await runSync(freshRepo(), fakeApi, true)
    expect(res.pushed).toBeGreaterThanOrEqual(1)
    expect(res.rejected).toBe(1)
  })
})

describe('pull: cursor advances ONLY after the apply commits', () => {
  it('advances the cursor after a successful page', async () => {
    await setupShop()
    const { getSyncState } = await import('../db/repo')
    const startCursor = getSyncState(db).cursor
    const changes = [
      { table: 'item', row: { id: 'srv-item-1', name: 'Teh Tarik', base_unit: 'pcs', sale_price: 5000, min_stock: 0, active: true, stock: 3 }, server_seq: 101, deleted: false },
      { table: 'cash_entry', row: { id: 'srv-cash-1', direction: 'out', amount: 2000, category: 'listrik', method: 'cash', business_date: todayISO() }, server_seq: 102, deleted: false },
    ]
    applyPullPage(db, changes, 102, false, 'device-1')
    const after = getSyncState(db)
    expect(after.cursor).toBe(102)
    // the rows applied
    const { getItem, listCashEntries } = await import('../db/repo')
    expect(getItem(db, 'srv-item-1')?.stockM).toBe(3000)
    expect((await listCashEntries(db, todayISO().slice(0, 7))).entries.some((e) => e.id === 'srv-cash-1')).toBe(true)
    void startCursor
  })

  it('a mid-page failure rolls back rows AND leaves the cursor untouched', async () => {
    await setupShop()
    const { getSyncState, getItem } = await import('../db/repo')
    const before = getSyncState(db).cursor
    const changes = [
      { table: 'item', row: { id: 'srv-item-2', name: 'Kopi Rollback', base_unit: 'pcs', sale_price: 3000, min_stock: 0, active: true, stock: 1 }, server_seq: 201, deleted: false },
      // invalid row: sale with a bad payment_method violates the CHECK constraint -> throws mid-transaction
      { table: 'sale', row: { id: 'srv-sale-bad', number: 'S000099', payment_method: 'bitcoin', paid: true, business_date: todayISO() }, server_seq: 202, deleted: false },
    ]
    expect(() => applyPullPage(db, changes, 202, false, 'device-1')).toThrow()
    // rollback: no partial row, cursor unchanged
    expect(getItem(db, 'srv-item-2')).toBeNull()
    expect(getSyncState(db).cursor).toBe(before)
  })
})

describe('pull: paid flag and conflict notice', () => {
  it('never clobbers a server-set paid flag with a stale local value', async () => {
    const item = await setupShop()
    // local unpaid sale (pending push)
    const sale = await postSale(db, {
      businessDate: todayISO(),
      discount: 0,
      paymentMethod: 'qris',
      paid: false,
      note: null,
      lines: [{ itemId: item.id, qtyM: 1000, unitPrice: 12000, discount: 0 }],
    })
    // the server later confirms it paid (QRIS confirm by another path)
    applyPullPage(
      db,
      [
        {
          table: 'sale',
          row: { id: sale.id, number: String(sale.number), total: sale.total, discount: 0, payment_method: 'qris', paid: true, mode: 'per_item', business_date: todayISO() },
          server_seq: 300,
          deleted: false,
        },
      ],
      300,
      false,
      'device-1',
    )
    const { getSale } = await import('../db/repo')
    expect(getSale(db, sale.id)!.paid).toBe(true)
  })

  it('marks an item changed elsewhere when a pull modifies it', async () => {
    const item = await setupShop()
    applyPullPage(
      db,
      [{ table: 'item', row: { id: item.id, name: item.name, base_unit: 'pcs', sale_price: 999, min_stock: 0, active: true }, server_seq: 400, deleted: false }],
      400,
      false,
      'device-2',
    )
    const { listChangedElsewhere, getItem } = await import('../db/repo')
    expect(listChangedElsewhere(db).some((n) => n.itemId === item.id)).toBe(true)
    expect(getItem(db, item.id)!.salePrice).toBe(999) // server write won
  })
})

describe('push payload hygiene', () => {
  it('sends contract-shaped ops: op_id in the envelope, client-only keys stripped from payloads', async () => {
    const item = await setupShop()
    await stockIn(db, { itemId: item.id, qtyM: 1000, unitCost: 500, businessDate: todayISO(), note: null, supplier: null })
    const captured: { device_id: string; ops: Record<string, unknown>[] }[] = []
    const fakeApi = {
      hasSession: () => true,
      syncPush: async (body: { device_id: string; ops: Record<string, unknown>[] }) => {
        captured.push(body)
        return { results: body.ops.map((o) => ({ op_id: o['op_id'], status: 'applied', reason: null })), cursor: 0 }
      },
      syncPull: async () => ({ changes: [], cursor: 0, has_more: false }),
    } as unknown as ApiClient
    await runSync(freshRepo(), fakeApi, true)
    expect(captured.length).toBeGreaterThanOrEqual(1)
    const ops = captured.flatMap((c) => c.ops)
    for (const op of ops) {
      expect(typeof op['op_id']).toBe('string')
      expect(typeof op['type']).toBe('string')
      expect(typeof op['client_ts']).toBe('string')
      const payload = op['payload'] as Record<string, unknown>
      expect(payload['op_id']).toBeUndefined()
      expect(payload['local_id']).toBeUndefined()
    }
    expect(pendingOutboxCount(db)).toBe(0)
  })
})

describe('error paths', () => {
  it('an ApiError on push surfaces as an error state without clearing ops', async () => {
    const item = await setupShop()
    await stockIn(db, { itemId: item.id, qtyM: 1000, unitCost: 500, businessDate: todayISO(), note: null, supplier: null })
    const before = pendingOutboxCount(db)
    const fakeApi = {
      hasSession: () => true,
      syncPush: async () => {
        throw new ApiError(500, 'internal', 'Kesalahan internal')
      },
      syncPull: async () => ({ changes: [], cursor: 0, has_more: false }),
    } as unknown as ApiClient
    const res = await runSync(freshRepo(), fakeApi, true)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('internal')
    expect(pendingOutboxCount(db)).toBe(before)
  })
})
