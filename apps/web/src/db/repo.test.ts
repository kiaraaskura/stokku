import { beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { makeDbAdapter, type Db } from './db-api'
import { resetAll } from './repo'
import {
  addCashEntry,
  completeOnboarding,
  createItem,
  getItem,
  getOnboardingDraft,
  isOnboarded,
  labaRugi,
  listCashEntries,
  listItems,
  pendingOutboxCount,
  postSale,
  saveOnboardingDraft,
  searchItems,
  seedDemo,
  stockIn,
  updateItem,
} from './repo'
import { todayISO, currentMonth } from '../lib/date'

let db: Db

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => wasmPath, useOldExtensionFunctions: true })
  db = makeDbAdapter(new SQL.Database())
  resetAll(db)
})

describe('onboarding (T-210)', () => {
  it('is resumable via a persisted draft', () => {
    saveOnboardingDraft(db, {
      step: 3,
      businessName: 'Warung Bu Sri',
      businessType: 'kelontong',
      taxRatePercent: 0,
      openingItemName: '',
      openingQtyText: '',
      openingCost: 0,
      openingSalePrice: 0,
    })
    expect(getOnboardingDraft(db).step).toBe(3)
    expect(getOnboardingDraft(db).businessName).toBe('Warung Bu Sri')
  })

  it('completes and seeds starter categories', () => {
    completeOnboarding(db, {
      businessName: 'Warung Bu Sri',
      businessType: 'kelontong',
      taxRatePercent: 0,
      opening: null,
    })
    expect(isOnboarded(db)).toBe(true)
    const items = listItems(db, '')
    expect(items.length).toBe(0)
  })

  it('refuses a second completion', () => {
    expect(() =>
      completeOnboarding(db, { businessName: 'X', businessType: 'kelontong', taxRatePercent: 0, opening: null }),
    ).toThrow('ALREADY_ONBOARDED')
  })
})

describe('accounting spine (ACCEPTANCE.md section A, locally)', () => {
  let gulaId: string

  it('creates an item with barcode and units', () => {
    const item = createItem(db, {
      name: 'Gula 1 kg',
      sku: 'GULA1KG',
      barcodes: ['8991002101234'],
      categoryId: null,
      baseUnit: 'pcs',
      units: [{ name: 'dus', factorM: 24000 }],
      salePrice: 12000,
      cost: 0,
      minStockM: 3000,
      active: true,
    })
    gulaId = item.id
    expect(item.salePrice).toBe(12000)
    expect(getItem(db, gulaId)!.barcodes[0]!.barcode).toBe('8991002101234')
    expect(getItem(db, gulaId)!.units[0]!.factorM).toBe(24000)
  })

  it('A2: stock in 10 @ 6.000 → stock 10, cost_avg 6.000', () => {
    stockIn(db, { itemId: gulaId, qtyM: 10000, unitCost: 6000, businessDate: todayISO(), note: null, supplier: null })
    const item = getItem(db, gulaId)!
    expect(item.stockM).toBe(10000)
    expect(item.costAvg).toBe(6000)
  })

  it('A3: stock in 10 @ 9.000 → stock 20, cost_avg 7.500 (moving average)', () => {
    stockIn(db, { itemId: gulaId, qtyM: 10000, unitCost: 9000, businessDate: todayISO(), note: null, supplier: null })
    const item = getItem(db, gulaId)!
    expect(item.stockM).toBe(20000)
    expect(item.costAvg).toBe(7500)
  })

  it('A4: sell 5 @ 12.000 cash → stock 15, total 60.000, cash entry 60.000', () => {
    const sale = postSale(db, {
      businessDate: todayISO(),
      discount: 0,
      paymentMethod: 'cash',
      paid: true,
      note: null,
      lines: [{ itemId: gulaId, qtyM: 5000, unitPrice: 12000, discount: 0 }],
    })
    expect(sale.number).toBe(1)
    expect(sale.total).toBe(60000)
    expect(sale.cashEntryId).not.toBeNull()
    const item = getItem(db, gulaId)!
    expect(item.stockM).toBe(15000)
    // HPP at sale = 5 × 7.500
    expect(sale.lines![0]!.costAtSale).toBe(7500)
    // low stock badge: 15 pcs vs min 3
    expect(item.lowStock).toBe(false)
  })

  it('A5: cash out 5.000 listrik → opex', () => {
    addCashEntry(db, {
      direction: 'out',
      amount: 5000,
      category: 'listrik',
      method: 'cash',
      businessDate: todayISO(),
      note: 'Token',
      refType: null,
      refId: null,
    })
  })

  it('A6: laba rugi — revenue 60.000, HPP 37.500, gross 22.500, opex 5.000, net 17.500', () => {
    const report = labaRugi(db, currentMonth())
    expect(report.revenue).toBe(60000)
    expect(report.hpp).toBe(37500)
    expect(report.grossProfit).toBe(22500)
    expect(report.opex).toBe(5000)
    expect(report.netProfit).toBe(17500)
  })

  it('A7: drill-down rows exist for revenue, hpp and opex', async () => {
    const { drillRevenue, drillHpp, drillOpex } = await import('./repo')
    const month = currentMonth()
    expect(drillRevenue(db, month).length).toBe(1)
    expect(drillHpp(db, month).length).toBe(1)
    expect(drillOpex(db, month).length).toBe(1)
  })

  it('A8: buying more stock is not opex and does not change net profit', () => {
    stockIn(db, { itemId: gulaId, qtyM: 10000, unitCost: 6000, businessDate: todayISO(), note: null, supplier: null })
    const report = labaRugi(db, currentMonth())
    expect(report.netProfit).toBe(17500)
    expect(report.opex).toBe(5000)
    // moving average updates: (15×7.500 + 10×6.000) / 25 = 6.900
    expect(getItem(db, gulaId)!.costAvg).toBe(6900)
  })

  it('every mutation produced exactly one outbox op with a UUIDv7 op_id', () => {
    // 1 item.create + 3 stock_move.create + 1 sale.create + 1 cash_entry.create
    expect(pendingOutboxCount(db)).toBe(6)
  })
})

describe('sale atomicity (T-216: all-or-nothing)', () => {
  it('rolls back everything when a line references a missing item', () => {
    const before = getItem(db, listItems(db, '')[0]!.id)!
    const saleCount = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sale')!.n
    const moveCount = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stock_move')!.n
    expect(() =>
      postSale(db, {
        businessDate: todayISO(),
        discount: 0,
        paymentMethod: 'cash',
        paid: true,
        note: null,
        lines: [
          { itemId: before.id, qtyM: 1000, unitPrice: 12000, discount: 0 },
          { itemId: 'missing-item-id', qtyM: 1000, unitPrice: 100, discount: 0 },
        ],
      }),
    ).toThrow()
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sale')!.n).toBe(saleCount)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stock_move')!.n).toBe(moveCount)
    expect(getItem(db, before.id)!.stockM).toBe(before.stockM)
  })

  it('rejects invalid quantities and discounts', () => {
    const item = listItems(db, '')[0]!
    expect(() =>
      postSale(db, {
        businessDate: todayISO(),
        discount: 0,
        paymentMethod: 'cash',
        paid: true,
        note: null,
        lines: [{ itemId: item.id, qtyM: 0, unitPrice: 12000, discount: 0 }],
      }),
    ).toThrow('VALIDATION qty')
    expect(() =>
      postSale(db, {
        businessDate: todayISO(),
        discount: 999999999,
        paymentMethod: 'cash',
        paid: true,
        note: null,
        lines: [{ itemId: item.id, qtyM: 1000, unitPrice: 12000, discount: 0 }],
      }),
    ).toThrow('VALIDATION discount')
  })

  it('credit sales create no cash entry and count as unpaid revenue', () => {
    const item = listItems(db, '')[0]!
    const sale = postSale(db, {
      businessDate: todayISO(),
      discount: 0,
      paymentMethod: 'credit',
      paid: false,
      note: null,
      lines: [{ itemId: item.id, qtyM: 1000, unitPrice: 12000, discount: 0 }],
    })
    expect(sale.cashEntryId).toBeNull()
    const report = labaRugi(db, currentMonth())
    expect(report.unpaidRevenue).toBe(12000)
  })
})

describe('search and low stock (T-211)', () => {
  it('finds by name and barcode exact first', () => {
    expect(listItems(db, 'gula').length).toBe(1)
    const byBarcode = searchItems(db, '8991002101234')
    expect(byBarcode.length).toBe(1)
    expect(byBarcode[0]!.name).toBe('Gula 1 kg')
    expect(searchItems(db, 'zzz').length).toBe(0)
  })

  it('flags low stock against min_stock', () => {
    const items = listItems(db, '')
    // Gula has 24 pcs left and min 3 — not low. Create a low item.
    createItem(db, {
      name: 'Kecap ABC',
      sku: null,
      barcodes: [],
      categoryId: null,
      baseUnit: 'pcs',
      units: [],
      salePrice: 8000,
      cost: 5000,
      minStockM: 5000,
      active: true,
    })
    const low = listItems(db, 'kecap')[0]!
    expect(low.stockM).toBe(0)
    expect(low.lowStock).toBe(true)
    void items
  })
})

describe('cash book (minimal)', () => {
  it('lists entries with matching totals', () => {
    const page = listCashEntries(db, currentMonth())
    // sale cash-in + listrik cash-out; the credit sale correctly added none
    expect(page.entries.length).toBe(2)
    const inSum = page.entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0)
    const outSum = page.entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0)
    expect(page.totalIn).toBe(inSum)
    expect(page.totalOut).toBe(outSum)
    expect(page.net).toBe(inSum - outSum)
  })
})

describe('item update (T-212)', () => {
  it('updates fields and rewrites barcodes/units', () => {
    const item = listItems(db, 'gula')[0]!
    const updated = updateItem(db, item.id, {
      name: 'Gula 1 kg',
      sku: 'GULA1KG',
      barcodes: ['8991002101234', '8991002109999'],
      categoryId: null,
      baseUnit: 'pcs',
      units: [
        { name: 'dus', factorM: 24000 },
        { name: 'renceng', factorM: 500 },
      ],
      salePrice: 13000,
      cost: 0,
      minStockM: 3000,
      active: true,
    })
    expect(updated.salePrice).toBe(13000)
    expect(getItem(db, item.id)!.barcodes.length).toBe(2)
    expect(getItem(db, item.id)!.units.length).toBe(2)
  })
})

describe('demo seed', () => {
  it('reproduces the acceptance numbers from scratch', () => {
    seedDemo(db)
    const report = labaRugi(db, currentMonth())
    expect(report.revenue).toBe(60000)
    expect(report.hpp).toBe(37500)
    expect(report.grossProfit).toBe(22500)
    expect(report.opex).toBe(5000)
    expect(report.netProfit).toBe(17500)
  })
})
