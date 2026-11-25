import { beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { makeDbAdapter, type Db } from './db-api'
import { resetAll, applyPullPage, createItem, completeOnboarding } from './repo'

let db: Db
let ITEM_ID: string

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => wasmPath, useOldExtensionFunctions: true })
  db = makeDbAdapter(new SQL.Database())
  resetAll(db)
  completeOnboarding(db, {
    businessName: 'Warung C',
    businessType: 'kelontong',
    taxRatePercent: 0,
    opening: null,
  })
  // a real item row: sale_line.item_id is a foreign key
  createItem(db, {
    name: 'Gula 1 kg',
    sku: 'GULA1KG',
    barcodes: [],
    categoryId: null,
    baseUnit: 'kg',
    units: [],
    salePrice: 10000,
    cost: 6000,
    minStockM: 0,
    active: true,
  })
  const item = db.get<{ id: string }>('SELECT id FROM item LIMIT 1')
  if (!item) throw new Error('seed item missing')
  ITEM_ID = item.id
})

// Proves the section C requirement: a sale arriving through /sync/pull must bring
// its lines, so device B can render the HPP drill-down instead of revenue-only.
describe('pull applies embedded sale lines', () => {
  it('writes the lines of a pulled sale and yields a non-zero HPP', () => {
    applyPullPage(
      db,
      [
        {
          table: 'sale',
          server_seq: 101,
          deleted: false,
          row: {
            id: 'sale-1',
            outlet_id: 'outlet-1',
            number: 'S000001',
            total: 50000,
            discount: 0,
            payment_method: 'cash',
            paid: true,
            mode: 'per_item',
            business_date: '2026-11-25',
            voided_at: null,
            void_reason: null,
            note: null,
            op_id: null,
            created_at: '2026-11-25T10:00:00Z',
            lines: [
              { id: 'line-1', item_id: ITEM_ID, qty: 5, unit_price: 10000, discount: 0, cost_at_sale: 6000 },
            ],
          },
        },
      ],
      101,
      false,
    )

    const lines = db.all<{ item_id: string; qty_m: number; cost_at_sale: number }>(
      'SELECT item_id, qty_m, cost_at_sale FROM sale_line WHERE sale_id = ?',
      ['sale-1'],
    )
    expect(lines.length).toBe(1)
    expect(lines[0]!.item_id).toBe(ITEM_ID)
    expect(lines[0]!.qty_m).toBe(5000) // 5 units stored as milli-units
    expect(lines[0]!.cost_at_sale).toBe(6000)

    const hpp = lines.reduce((sum, l) => sum + (l.qty_m / 1000) * l.cost_at_sale, 0)
    expect(hpp).toBe(30000) // 5 x 6.000
  })

  it('does not crash when staff-pulled lines omit cost_at_sale', () => {
    applyPullPage(
      db,
      [
        {
          table: 'sale',
          server_seq: 102,
          deleted: false,
          row: {
            id: 'sale-2',
            outlet_id: 'outlet-1',
            number: 'S000002',
            total: 10000,
            discount: 0,
            payment_method: 'cash',
            paid: true,
            mode: 'per_item',
            business_date: '2026-11-25',
            voided_at: null,
            void_reason: null,
            note: null,
            op_id: null,
            created_at: '2026-11-25T10:00:00Z',
            lines: [{ id: 'line-2', item_id: ITEM_ID, qty: 1, unit_price: 10000, discount: 0 }],
          },
        },
      ],
      102,
      false,
    )
    const lines = db.all<{ cost_at_sale: number }>('SELECT cost_at_sale FROM sale_line WHERE sale_id = ?', ['sale-2'])
    expect(lines.length).toBe(1)
    expect(lines[0]!.cost_at_sale).toBe(0)
  })
})
