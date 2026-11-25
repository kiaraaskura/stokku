import { beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { makeDbAdapter, type Db } from '../db/db-api'
import { resetAll, stockIn, postSale, pendingOutboxCount, pendingOutboxList } from '../db/repo'
import { flushOutbox } from './flush'
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

function freshRepo() {
  return {
    persisted: true,
    call: (method: string, ...args: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (repoMethods as Record<string, (d: Db, ...a: unknown[]) => unknown>)[method]
      if (!fn) throw new Error(`no repo method ${method}`)
      return fn(db, ...args)
    },
  } as unknown as import('../db/store').Repository
}

async function setupShop() {
  const { completeOnboarding, createItem } = await import('../db/repo')
  resetAll(db)
  completeOnboarding(db, { businessName: 'Warung Uji', businessType: 'kelontong', taxRatePercent: 0, opening: null })
  return createItem(db, {
    name: 'Gula Uji',
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const repoMethods = (await import('../db/repo')) as any

describe('outbox flush: clears only on confirmed success', () => {
  it('keeps the op queued on network failure, clears it on confirmed 2xx', async () => {
    const item = await setupShop()
    // one queued stock-in (offline optimistic write) on top of the queued item.create
    await stockIn(db, { itemId: item.id, qtyM: 10000, unitCost: 6000, businessDate: todayISO(), note: null, supplier: null })
    const before = pendingOutboxCount(db)
    expect(before).toBe(2) // item.create + stock_move.create

    let succeed = false
    const posted: string[] = []
    const fakeApi = {
      hasSession: () => true,
      createItem: async (_body: Record<string, unknown>) => {
        return {
          id: 'srv-item-1',
          sku: null,
          name: 'Gula Uji',
          category_id: null,
          base_unit: 'pcs',
          sale_price: 12000,
          cost_avg: 0,
          min_stock: 0,
          active: true,
          stock: 0,
          updated_at: todayISO(),
          units: [],
          barcodes: [],
        }
      },
      stockMove: async (body: Record<string, unknown>) => {
        if (!succeed) throw new NetworkError('down')
        posted.push(String(body['op_id']))
        return {
          id: 'srv-move-1',
          outlet_id: 'srv-outlet',
          item_id: 'srv-item-1',
          qty: 10,
          unit_cost: 6000,
          type: 'in',
          business_date: todayISO(),
          note: null,
          created_at: todayISO(),
        }
      },
      getItem: async () => ({ id: 'srv-item-1', stock: 10, cost_avg: 6000, name: 'Gula Uji', base_unit: 'pcs', sale_price: 12000, min_stock: 0, active: true, sku: null, category_id: null, updated_at: todayISO() }),
    } as unknown as ApiClient

    // network down: the stock-move op stays queued (item.create may have posted first)
    let res = await flushOutbox(freshRepo(), fakeApi, true)
    expect(res.networkStopped).toBe(true)
    expect(pendingOutboxCount(db)).toBeGreaterThanOrEqual(1)

    // confirmed success: op cleared, server rows cached
    succeed = true
    res = await flushOutbox(freshRepo(), fakeApi, true)
    expect(res.posted).toBeGreaterThanOrEqual(1)
    expect(pendingOutboxCount(db)).toBe(0)
    expect(posted).toHaveLength(1)
    // the item cache now carries the server's stock and cost (id remapped to the server id)
    const { getItem } = await import('../db/repo')
    expect(getItem(db, 'srv-item-1')!.stockM).toBe(10000)
    expect(getItem(db, 'srv-item-1')!.costAvg).toBe(6000)
  })

  it('marks a rejected op failed instead of blocking the queue forever', async () => {
    const item = await setupShop()
    await stockIn(db, { itemId: item.id, qtyM: 1000, unitCost: 500, businessDate: todayISO(), note: null, supplier: null })
    const fakeApi = {
      hasSession: () => true,
      createItem: async () => {
        throw new ApiError(422, 'validation_failed', 'Nama wajib diisi')
      },
      stockMove: async () => {
        throw new ApiError(422, 'validation_failed', 'Qty harus lebih dari 0')
      },
    } as unknown as ApiClient
    const before = pendingOutboxCount(db)
    const res = await flushOutbox(freshRepo(), fakeApi, true)
    expect(res.failed).toBe(before)
    expect(pendingOutboxCount(db)).toBe(0)
  })
})

describe('duplicate retry does not double-post', () => {
  it('retries with the SAME op_id and applies exactly once', async () => {
    const item = await setupShop()
    // offline sale -> queued with op_id (item.create is also queued from setup)
    const sale = await postSale(db, {
      businessDate: todayISO(),
      discount: 0,
      paymentMethod: 'cash',
      paid: true,
      note: null,
      lines: [{ itemId: item.id, qtyM: 5000, unitPrice: 12000, discount: 0 }],
    })
    const ops = pendingOutboxList(db)
    expect(ops).toHaveLength(2) // item.create + sale.create
    const saleOp = ops.find((o) => o.type === 'sale.create')!
    const opId = saleOp.opId

    // fake server: dedupes by op_id, and the first response is LOST after applying
    const applied = new Map<string, unknown>()
    let loseFirstResponse = true
    const sentOpIds: string[] = []
    const fakeApi = {
      hasSession: () => true,
      createItem: async () => ({
        id: 'srv-item-1',
        sku: null,
        name: 'Gula Uji',
        category_id: null,
        base_unit: 'pcs',
        sale_price: 12000,
        cost_avg: 0,
        min_stock: 0,
        active: true,
        stock: 0,
        updated_at: todayISO(),
        units: [],
        barcodes: [],
      }),
      postSale: async (body: Record<string, unknown>) => {
        const opId2 = String(body['op_id'])
        sentOpIds.push(opId2)
        if (!applied.has(opId2)) {
          applied.set(opId2, body)
        }
        if (loseFirstResponse) {
          loseFirstResponse = false
          throw new NetworkError('connection dropped after send')
        }
        // server returns the confirmed sale (duplicate replays get the same row)
        return {
          id: 'srv-sale-1',
          number: 'S000001',
          outlet_id: 'srv-outlet',
          business_date: todayISO(),
          total: 60000,
          discount: 0,
          payment_method: 'cash',
          paid: true,
          mode: 'per_item',
          lines: [{ item_id: 'srv-item-1', qty: 5, unit_price: 12000, discount: 0, cost_at_sale: 6000 }],
          cash_entry_id: 'srv-cash-1',
          payment: { id: 'pay-1', method: 'cash', amount_gross: 60000, status: 'paid' },
        }
      },
      getItem: async () => ({ id: 'srv-item-1', stock: 5, cost_avg: 6000, name: 'Gula Uji', base_unit: 'pcs', sale_price: 12000, min_stock: 0, active: true, sku: null, category_id: null, updated_at: todayISO() }),
    } as unknown as ApiClient

    // flush 1: server applied it but the response was lost -> op must stay queued
    const r1 = await flushOutbox(freshRepo(), fakeApi, true)
    expect(r1.networkStopped).toBe(true)
    expect(pendingOutboxCount(db)).toBeGreaterThanOrEqual(1)

    // flush 2: retry with the same op_id -> server dedupes, op confirmed once
    const r2 = await flushOutbox(freshRepo(), fakeApi, true)
    expect(r2.posted).toBeGreaterThanOrEqual(1)
    expect(pendingOutboxCount(db)).toBe(0)

    // exactly-once: one unique op applied server-side despite two POSTs
    expect(applied.size).toBe(1)
    expect(sentOpIds.every((id) => id === opId)).toBe(true)
    expect(sentOpIds).toHaveLength(2)

    // the local optimistic sale row was replaced by the server row
    const { getSale } = await import('../db/repo')
    expect(getSale(db, 'srv-sale-1')).not.toBeNull()
    expect(getSale(db, sale.id)).toBeNull()
  })
})
