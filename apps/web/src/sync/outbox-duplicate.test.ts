import { beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { makeDbAdapter, type Db } from '../db/db-api'
import { resetAll, stockIn, postSale, pendingOutboxCount } from '../db/repo'
import { runSync } from './engine'
import { NetworkError } from '../api/types'
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
  const { completeOnboarding, createItem } = await import('../db/repo')
  resetAll(db)
  completeOnboarding(db, { businessName: 'Warung Duplikat', businessType: 'kelontong', taxRatePercent: 0, opening: null })
  return createItem(db, {
    name: 'Kopi Duplikat',
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

/**
 * The duplicate-row bug the review found: the engine cleared the outbox op but
 * never removed the local optimistic row, so after push+pull the store held
 * BOTH the local sale (local id) and the server sale (server id). The fix
 * deletes the local row when the push is applied; the pull then inserts the
 * server row — exactly one sale, with the server id.
 */
describe('push+pull leaves exactly one sale row (no local duplicate)', () => {
  it('after a full sync the local sale is replaced by the server sale', async () => {
    const item = await setupShop()
    await stockIn(db, { itemId: item.id, qtyM: 10000, unitCost: 6000, businessDate: todayISO(), note: null, supplier: null })
    const localSale = await postSale(db, {
      businessDate: todayISO(),
      discount: 0,
      paymentMethod: 'cash',
      paid: true,
      note: null,
      lines: [{ itemId: item.id, qtyM: 2000, unitPrice: 12000, discount: 0 }],
    })
    expect(pendingOutboxCount(db)).toBeGreaterThan(0)

    const SERVER_SALE_ID = '01a99999-9999-7999-8999-999999999999'
    const fakeApi = {
      hasSession: () => true,
      syncPush: async (body: { ops: { op_id: string; type: string }[] }) => ({
        results: body.ops.map((o) => ({ op_id: o.op_id, status: o.type === 'sale.create' ? 'applied' : 'applied', reason: null })),
        cursor: 500,
      }),
      syncPull: async () => ({
        changes: [
          {
            table: 'sale',
            server_seq: 501,
            deleted: false,
            row: {
              id: SERVER_SALE_ID,
              outlet_id: 'outlet-1',
              number: 'S000001',
              total: 24000,
              discount: 0,
              payment_method: 'cash',
              paid: true,
              mode: 'per_item',
              business_date: todayISO(),
              voided_at: null,
              void_reason: null,
              note: null,
              op_id: null,
              created_at: '2026-11-26T10:00:00Z',
              lines: [{ id: 'srv-line-1', item_id: item.id, qty: 2, unit_price: 12000, discount: 0, cost_at_sale: 6000 }],
            },
          },
        ],
        cursor: 501,
        has_more: false,
      }),
    } as unknown as ApiClient

    const res = await runSync(freshRepo(), fakeApi, true)
    expect(res.ok).toBe(true)
    expect(pendingOutboxCount(db)).toBe(0)

    // Exactly ONE sale row, and it is the server's, not the local optimistic one.
    const sales = db.all<{ id: string }>('SELECT id FROM sale')
    expect(sales.length).toBe(1)
    expect(sales[0]!.id).toBe(SERVER_SALE_ID)
    const localGone = db.get<{ id: string }>('SELECT id FROM sale WHERE id = ?', [localSale.id])
    expect(localGone).toBeUndefined()

    // One line row from the pulled embedded lines — not the local line plus the server line.
    const lines = db.all<{ id: string }>('SELECT id FROM sale_line WHERE sale_id = ?', [SERVER_SALE_ID])
    expect(lines.length).toBe(1)

    // The local sale's line is gone with the local row.
    const localLines = db.all<{ id: string }>('SELECT id FROM sale_line WHERE sale_id = ?', [localSale.id])
    expect(localLines.length).toBe(0)
  })

  it('a network failure during pull keeps the queue consistent (op settled, retry heals)', async () => {
    const item = await setupShop()
    await postSale(db, {
      businessDate: todayISO(),
      discount: 0,
      paymentMethod: 'cash',
      paid: true,
      note: null,
      lines: [{ itemId: item.id, qtyM: 1000, unitPrice: 12000, discount: 0 }],
    })
    const fakeApi = {
      hasSession: () => true,
      syncPush: async (body: { ops: { op_id: string }[] }) => ({
        results: body.ops.map((o) => ({ op_id: o.op_id, status: 'applied' as const, reason: null })),
        cursor: 600,
      }),
      syncPull: async () => {
        throw new NetworkError('down')
      },
    } as unknown as ApiClient
    const res = await runSync(freshRepo(), fakeApi, true)
    // push settled; pull failed — that is an error state, not silent success
    expect(res.ok).toBe(false)
    expect(pendingOutboxCount(db)).toBe(0)
  })
})
