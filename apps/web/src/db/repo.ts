import type { Db } from './db-api'
import { migrate, SCHEMA_VERSION } from './schema'
import { uuidv7 } from '../lib/uuid'
import { todayISO, monthRange, DEFAULT_TIMEZONE } from '../lib/date'
import { qtyTimesUnitCost } from '../lib/money'
import type {
  CashEntry,
  CashEntryInput,
  DrillRow,
  Item,
  ItemDetail,
  ItemInput,
  LabaRugi,
  OnboardingDraft,
  OutboxOp,
  Outlet,
  Sale,
  SaleInput,
  SaleLine,
  StockInInput,
  StockMove,
  Tenant,
} from './types'

/** Categories seeded per business type (DECISIONS.md D5: kelontong, katering, laundry, bengkel, fashion). */
const STARTER_CATEGORIES: Record<string, string[]> = {
  kelontong: ['Makanan', 'Minuman', 'Sembako', 'Rumah Tangga', 'Lainnya'],
  katering: ['Menu Utama', 'Lauk', 'Minuman', 'Lainnya'],
  laundry: ['Layanan', 'Perlengkapan', 'Lainnya'],
  bengkel: ['Suku Cadang', 'Jasa', 'Oli & Cairan', 'Lainnya'],
  fashion: ['Pakaian', 'Aksesori', 'Sepatu', 'Lainnya'],
}

export const OPEX_EXCLUDED_CATEGORIES = ['pembelian_stok', 'modal']

/** ---------- meta / settings ---------- */

export function getMeta(db: Db, key: string): string | null {
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])
  return row?.value ?? null
}

export function setMeta(db: Db, key: string, value: string): void {
  db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
}

export function isOnboarded(db: Db): boolean {
  return getMeta(db, 'onboarded') === 'true'
}

export function getTenant(db: Db): Tenant | null {
  const row = db.get<{ id: string; name: string; tax_rate: number; business_type: string | null }>(
    'SELECT id, name, tax_rate, business_type FROM tenant LIMIT 1',
  )
  if (!row) return null
  return { id: row.id, name: row.name, taxRate: row.tax_rate / 100, businessType: row.business_type }
}

export function getOutlet(db: Db): Outlet | null {
  const row = db.get<{ id: string; tenant_id: string; name: string; timezone: string }>(
    'SELECT id, tenant_id, name, timezone FROM outlet LIMIT 1',
  )
  if (!row) return null
  return { id: row.id, tenantId: row.tenant_id, name: row.name, timezone: row.timezone ?? DEFAULT_TIMEZONE }
}

function requireOutletId(db: Db): string {
  const outlet = getOutlet(db)
  if (!outlet) throw new Error('NOT_ONBOARDED')
  return outlet.id
}

/** ---------- onboarding ---------- */

const EMPTY_DRAFT: OnboardingDraft = {
  step: 1,
  businessName: '',
  businessType: '',
  taxRatePercent: 0,
  openingItemName: '',
  openingQtyText: '',
  openingCost: 0,
  openingSalePrice: 0,
}

export function getOnboardingDraft(db: Db): OnboardingDraft {
  const raw = getMeta(db, 'onboarding_draft')
  if (!raw) return EMPTY_DRAFT
  try {
    return { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<OnboardingDraft>) }
  } catch {
    return EMPTY_DRAFT
  }
}

export function saveOnboardingDraft(db: Db, draft: OnboardingDraft): void {
  setMeta(db, 'onboarding_draft', JSON.stringify(draft))
}

export interface CompleteOnboardingInput {
  businessName: string
  businessType: string
  taxRatePercent: number
  opening: { name: string; qtyM: number; unitCost: number; salePrice: number } | null
}

export function completeOnboarding(db: Db, input: CompleteOnboardingInput): void {
  if (isOnboarded(db)) throw new Error('ALREADY_ONBOARDED')
  const businessName = input.businessName.trim()
  if (businessName === '') throw new Error('VALIDATION businessName')
  db.transaction(() => {
    const tenantId = uuidv7()
    const outletId = uuidv7()
    const now = new Date().toISOString()
    db.run('INSERT INTO tenant (id, name, tax_rate, business_type, created_at) VALUES (?, ?, ?, ?, ?)', [
      tenantId,
      businessName,
      Math.round(input.taxRatePercent * 100),
      input.businessType || null,
      now,
    ])
    db.run('INSERT INTO outlet (id, tenant_id, name, timezone) VALUES (?, ?, ?, ?)', [
      outletId,
      tenantId,
      businessName,
      DEFAULT_TIMEZONE,
    ])
    const cats = STARTER_CATEGORIES[input.businessType] ?? STARTER_CATEGORIES.kelontong
    cats.forEach((name, i) => {
      db.run('INSERT INTO category (id, name, sort) VALUES (?, ?, ?)', [uuidv7(), name, i])
    })
    setMeta(db, 'tenant_id', tenantId)
    setMeta(db, 'outlet_id', outletId)
    setMeta(db, 'onboarded', 'true')
    db.run("DELETE FROM meta WHERE key = 'onboarding_draft'")

    if (input.opening && input.opening.name.trim() !== '' && input.opening.qtyM > 0) {
      createItem(db, {
        name: input.opening.name.trim(),
        sku: null,
        barcodes: [],
        categoryId: null,
        baseUnit: 'pcs',
        units: [],
        salePrice: input.opening.salePrice,
        cost: input.opening.unitCost,
        minStockM: 0,
        active: true,
      })
      stockIn(db, {
        itemId: getItemByName(db, input.opening.name.trim())?.id ?? '',
        qtyM: input.opening.qtyM,
        unitCost: input.opening.unitCost,
        businessDate: todayISO(),
        note: 'Stok awal',
        supplier: null,
      })
    }
  })
}

function getItemByName(db: Db, name: string): Item | null {
  const id = db.get<{ id: string }>('SELECT id FROM item WHERE name = ? AND deleted_at IS NULL LIMIT 1', [name])?.id
  if (!id) return null
  return getItemRow(db, id)
}

/** ---------- outbox ---------- */

function enqueueOutboxOp(db: Db, opId: string, type: string, payload: unknown): void {
  db.run('INSERT INTO outbox (op_id, type, payload, client_ts, status) VALUES (?, ?, ?, ?, ?)', [
    opId,
    type,
    JSON.stringify(payload),
    new Date().toISOString(),
    'pending',
  ])
}

export function pendingOutboxCount(db: Db): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'")?.n ?? 0
}

export function listOutbox(db: Db, limit = 100): OutboxOp[] {
  return db
    .all<{ op_id: string; type: string; payload: string; client_ts: string; status: string }>(
      'SELECT op_id, type, payload, client_ts, status FROM outbox ORDER BY client_ts LIMIT ?',
      [limit],
    )
    .map((r) => ({
      opId: r.op_id,
      type: r.type,
      payload: JSON.parse(r.payload),
      clientTs: r.client_ts,
      status: 'pending',
    }))
}

/** ---------- items ---------- */

const ITEM_SELECT = `
  SELECT i.id, i.sku, i.name, i.category_id, i.base_unit, i.sale_price, i.cost_avg,
         i.min_stock_m, i.active, i.updated_at,
         COALESCE(sl.qty_m, 0) AS stock_m
  FROM item i
  LEFT JOIN stock_level sl ON sl.item_id = i.id AND sl.outlet_id = ?
`

function rowToItem(r: Record<string, unknown>): Item {
  const stockM = Number(r.stock_m ?? 0)
  const minStockM = Number(r.min_stock_m ?? 0)
  return {
    id: String(r.id),
    sku: (r.sku as string | null) ?? null,
    name: String(r.name),
    categoryId: (r.category_id as string | null) ?? null,
    baseUnit: String(r.base_unit),
    salePrice: Number(r.sale_price ?? 0),
    costAvg: Number(r.cost_avg ?? 0),
    minStockM,
    active: Boolean(r.active),
    stockM,
    lowStock: minStockM > 0 && stockM <= minStockM,
    updatedAt: String(r.updated_at),
  }
}

function getItemRow(db: Db, id: string): Item | null {
  const r = db.get<Record<string, unknown>>(
    `${ITEM_SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`,
    [requireOutletId(db), id],
  )
  return r ? rowToItem(r) : null
}

export function listCategories(db: Db): { id: string; name: string }[] {
  return db.all<{ id: string; name: string }>('SELECT id, name FROM category ORDER BY sort, name')
}

export function validateItemInput(input: ItemInput): string | null {
  if (input.name.trim() === '') return 'name'
  if (input.baseUnit.trim() === '') return 'base_unit'
  if (input.salePrice < 0 || input.cost < 0) return 'price'
  for (const u of input.units) {
    if (u.name.trim() === '' || !Number.isInteger(u.factorM) || u.factorM <= 0) return 'units'
  }
  const barcodeSet = new Set<string>()
  for (const b of input.barcodes) {
    const barcode = b.trim()
    if (barcode === '') continue
    if (barcodeSet.has(barcode)) return 'barcodes'
    barcodeSet.add(barcode)
  }
  return null
}

export function createItem(db: Db, input: ItemInput): Item {
  const err = validateItemInput(input)
  if (err) throw new Error(`VALIDATION ${err}`)
  const id = uuidv7()
  const opId = uuidv7()
  db.transaction(() => {
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO item (id, sku, name, category_id, base_unit, sale_price, cost_avg, min_stock_m, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.sku && input.sku.trim() !== '' ? input.sku.trim() : null,
        input.name.trim(),
        input.categoryId,
        input.baseUnit.trim(),
        input.salePrice,
        input.cost,
        input.minStockM,
        input.active ? 1 : 0,
        now,
      ],
    )
    for (const b of input.barcodes) {
      const barcode = b.trim()
      if (barcode === '') continue
      db.run('INSERT INTO item_barcode (id, item_id, barcode) VALUES (?, ?, ?)', [uuidv7(), id, barcode])
    }
    for (const u of input.units) {
      if (u.name.trim() === '') continue
      db.run('INSERT INTO item_unit (id, item_id, name, factor_m) VALUES (?, ?, ?, ?)', [
        uuidv7(),
        id,
        u.name.trim(),
        u.factorM,
      ])
    }
    enqueueOutboxOp(db, opId, 'item.create', {
      op_id: opId,
      name: input.name.trim(),
      sku: input.sku || null,
      barcodes: input.barcodes.filter((b) => b.trim() !== ''),
      category_id: input.categoryId,
      base_unit: input.baseUnit.trim(),
      units: input.units.map((u) => ({ name: u.name.trim(), factor: u.factorM / 1000 })),
      sale_price: input.salePrice,
      cost: input.cost,
      min_stock: input.minStockM / 1000,
      active: input.active,
    })
  })
  return getItemRow(db, id)!
}

export function updateItem(db: Db, id: string, input: ItemInput): Item {
  const err = validateItemInput(input)
  if (err) throw new Error(`VALIDATION ${err}`)
  const existing = getItemRow(db, id)
  if (!existing) throw new Error('NOT_FOUND')
  const opId = uuidv7()
  db.transaction(() => {
    db.run(
      `UPDATE item SET sku = ?, name = ?, category_id = ?, base_unit = ?, sale_price = ?, min_stock_m = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.sku && input.sku.trim() !== '' ? input.sku.trim() : null,
        input.name.trim(),
        input.categoryId,
        input.baseUnit.trim(),
        input.salePrice,
        input.minStockM,
        input.active ? 1 : 0,
        new Date().toISOString(),
        id,
      ],
    )
    db.run('DELETE FROM item_barcode WHERE item_id = ?', [id])
    for (const b of input.barcodes) {
      const barcode = b.trim()
      if (barcode === '') continue
      db.run('INSERT INTO item_barcode (id, item_id, barcode) VALUES (?, ?, ?)', [uuidv7(), id, barcode])
    }
    db.run('DELETE FROM item_unit WHERE item_id = ?', [id])
    for (const u of input.units) {
      if (u.name.trim() === '') continue
      db.run('INSERT INTO item_unit (id, item_id, name, factor_m) VALUES (?, ?, ?, ?)', [
        uuidv7(),
        id,
        u.name.trim(),
        u.factorM,
      ])
    }
    enqueueOutboxOp(db, opId, 'item.update', {
      op_id: opId,
      id,
      name: input.name.trim(),
      sku: input.sku || null,
      barcodes: input.barcodes.filter((b) => b.trim() !== ''),
      category_id: input.categoryId,
      base_unit: input.baseUnit.trim(),
      sale_price: input.salePrice,
      min_stock: input.minStockM / 1000,
      active: input.active,
    })
  })
  return getItemRow(db, id)!
}

export function getItem(db: Db, id: string): ItemDetail | null {
  const item = getItemRow(db, id)
  if (!item) return null
  const units = db
    .all<{ id: string; item_id: string; name: string; factor_m: number }>(
      'SELECT id, item_id, name, factor_m FROM item_unit WHERE item_id = ? ORDER BY rowid',
      [id],
    )
    .map((u) => ({ id: u.id, itemId: u.item_id, name: u.name, factorM: u.factor_m }))
  const barcodes = db
    .all<{ id: string; item_id: string; barcode: string }>('SELECT id, item_id, barcode FROM item_barcode WHERE item_id = ?', [id])
    .map((b) => ({ id: b.id, itemId: b.item_id, barcode: b.barcode }))
  const stockMoves = db
    .all<Record<string, unknown>>(
      `SELECT id, outlet_id, item_id, qty_m, unit_cost, type, ref_type, ref_id, business_date, note, created_at
       FROM stock_move WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`,
      [id],
    )
    .map(rowToStockMove)
  return { ...item, units, barcodes, stockMoves }
}

function rowToStockMove(r: Record<string, unknown>): StockMove {
  return {
    id: String(r.id),
    outletId: String(r.outlet_id),
    itemId: String(r.item_id),
    qtyM: Number(r.qty_m),
    unitCost: Number(r.unit_cost ?? 0),
    type: String(r.type) as StockMove['type'],
    refType: (r.ref_type as string | null) ?? null,
    refId: (r.ref_id as string | null) ?? null,
    businessDate: String(r.business_date),
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
  }
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function listItems(db: Db, query: string, onlyLowStock = false): Item[] {
  const outletId = requireOutletId(db)
  const q = query.trim()
  if (q !== '') {
    const pattern = `%${escapeLike(q)}%`
    const rows = db.all<Record<string, unknown>>(
      `${ITEM_SELECT}
       WHERE i.deleted_at IS NULL AND (
         i.name LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM item_barcode b WHERE b.item_id = i.id AND b.barcode LIKE ? ESCAPE '\\')
       )
       ORDER BY CASE WHEN i.name = ? THEN 0 ELSE 1 END, i.name COLLATE NOCASE`,
      [outletId, pattern, pattern, pattern, q],
    )
    return rows.map(rowToItem)
  }
  if (onlyLowStock) {
    const rows = db.all<Record<string, unknown>>(
      `${ITEM_SELECT} WHERE i.deleted_at IS NULL AND i.min_stock_m > 0 AND COALESCE(sl.qty_m, 0) <= i.min_stock_m
       ORDER BY i.name COLLATE NOCASE`,
      [outletId],
    )
    return rows.map(rowToItem)
  }
  const rows = db.all<Record<string, unknown>>(
    `${ITEM_SELECT} WHERE i.deleted_at IS NULL ORDER BY i.name COLLATE NOCASE`,
    [outletId],
  )
  return rows.map(rowToItem)
}

/** Typeahead search: barcode exact match first, then name (max 10). */
export function searchItems(db: Db, query: string): Item[] {
  const q = query.trim()
  if (q === '') return []
  const outletId = requireOutletId(db)
  const exact = db.all<Record<string, unknown>>(
    `${ITEM_SELECT} JOIN item_barcode b ON b.item_id = i.id WHERE i.deleted_at IS NULL AND b.barcode = ? LIMIT 1`,
    [outletId, q],
  )
  const pattern = `%${escapeLike(q)}%`
  const byName = db.all<Record<string, unknown>>(
    `${ITEM_SELECT} WHERE i.deleted_at IS NULL AND (i.name LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\') LIMIT 10`,
    [outletId, pattern, pattern],
  )
  const merged: Item[] = []
  const seen = new Set<string>()
  for (const r of [...exact, ...byName]) {
    const item = rowToItem(r)
    if (!seen.has(item.id)) {
      seen.add(item.id)
      merged.push(item)
    }
  }
  return merged.slice(0, 10)
}

/** ---------- stock ---------- */

export function stockIn(db: Db, input: StockInInput): StockMove {
  if (!Number.isInteger(input.qtyM) || input.qtyM <= 0) throw new Error('VALIDATION qty')
  if (!Number.isInteger(input.unitCost) || input.unitCost < 0) throw new Error('VALIDATION unit_cost')
  const item = getItemRow(db, input.itemId)
  if (!item) throw new Error('NOT_FOUND')
  const moveId = uuidv7()
  const opId = uuidv7()
  const outletId = requireOutletId(db)
  db.transaction(() => {
    const now = new Date().toISOString()
    // Moving weighted average cost (T-121 rule): only positive current stock participates.
    const current = db.get<{ qty_m: number }>('SELECT qty_m FROM stock_level WHERE outlet_id = ? AND item_id = ?', [
      outletId,
      input.itemId,
    ])
    const currentQtyM = current?.qty_m ?? 0
    let newCostAvg = item.costAvg
    if (currentQtyM > 0) {
      newCostAvg = Math.round((currentQtyM * item.costAvg + input.qtyM * input.unitCost) / (currentQtyM + input.qtyM))
    } else {
      newCostAvg = input.unitCost
    }
    db.run(
      `INSERT INTO stock_move (id, outlet_id, item_id, qty_m, unit_cost, type, ref_type, ref_id, business_date, note, created_at, op_id)
       VALUES (?, ?, ?, ?, ?, 'in', NULL, NULL, ?, ?, ?, ?)`,
      [moveId, outletId, input.itemId, input.qtyM, input.unitCost, input.businessDate, input.note ?? input.supplier, now, opId],
    )
    applyStockDelta(db, outletId, input.itemId, input.qtyM)
    db.run('UPDATE item SET cost_avg = ?, updated_at = ? WHERE id = ?', [newCostAvg, now, input.itemId])
    enqueueOutboxOp(db, opId, 'stock_move.create', {
      op_id: opId,
      item_id: input.itemId,
      outlet_id: outletId,
      type: 'in',
      qty_positive: input.qtyM / 1000,
      unit_cost: input.unitCost,
      business_date: input.businessDate,
      supplier: input.supplier ?? undefined,
      note: input.note ?? undefined,
    })
  })
  return db.get<Record<string, unknown>>('SELECT * FROM stock_move WHERE id = ?', [moveId])! as unknown as StockMove
}

function applyStockDelta(db: Db, outletId: string, itemId: string, deltaM: number): void {
  db.run(
    `INSERT INTO stock_level (outlet_id, item_id, qty_m) VALUES (?, ?, ?)
     ON CONFLICT(outlet_id, item_id) DO UPDATE SET qty_m = qty_m + excluded.qty_m`,
    [outletId, itemId, deltaM],
  )
}

function nextSaleNumber(db: Db): number {
  const n = db.get<{ next_number: number }>('SELECT next_number FROM sale_number_seq WHERE singleton = 1')!.next_number
  db.run('UPDATE sale_number_seq SET next_number = ? WHERE singleton = 1', [n + 1])
  return n
}

/** ---------- sales (atomic local posting — T-216) ---------- */

export function postSale(db: Db, input: SaleInput): Sale {
  if (input.lines.length === 0) throw new Error('VALIDATION lines')
  for (const line of input.lines) {
    if (!Number.isInteger(line.qtyM) || line.qtyM <= 0) throw new Error('VALIDATION qty')
    if (line.unitPrice < 0) throw new Error('VALIDATION unit_price')
    if (line.discount < 0 || line.discount > qtyTimesUnitCost(line.qtyM, line.unitPrice)) {
      throw new Error('VALIDATION discount')
    }
  }
  const outletId = requireOutletId(db)
  const saleId = uuidv7()
  const opId = uuidv7()

  const saleNumber = db.transaction(() => {
    let subtotal = 0
    for (const line of input.lines) {
      subtotal += qtyTimesUnitCost(line.qtyM, line.unitPrice) - line.discount
    }
    if (input.discount < 0 || input.discount > subtotal) throw new Error('VALIDATION discount')
    const total = subtotal - input.discount

    const number = nextSaleNumber(db)
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO sale (id, outlet_id, number, total, discount, payment_method, paid, mode, business_date, note, op_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'per_item', ?, ?, ?, ?)`,
      [saleId, outletId, number, total, input.discount, input.paymentMethod, input.paid ? 1 : 0, input.businessDate, input.note ?? null, opId, now],
    )

    for (const line of input.lines) {
      const item = getItemRow(db, line.itemId)
      if (!item) throw new Error(`NOT_FOUND item ${line.itemId}`)
      const lineId = uuidv7()
      const costAtSale = item.costAvg
      db.run(
        `INSERT INTO sale_line (id, sale_id, item_id, qty_m, unit_price, discount, cost_at_sale)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [lineId, saleId, line.itemId, line.qtyM, line.unitPrice, line.discount, costAtSale],
      )
      // One stock move per line (type 'sale', negative delta).
      const moveId = uuidv7()
      db.run(
        `INSERT INTO stock_move (id, outlet_id, item_id, qty_m, unit_cost, type, ref_type, ref_id, business_date, note, created_at, op_id)
         VALUES (?, ?, ?, ?, ?, 'sale', 'sale', ?, ?, NULL, ?, ?)`,
        [moveId, outletId, line.itemId, -line.qtyM, costAtSale, saleId, input.businessDate, now, opId],
      )
      applyStockDelta(db, outletId, line.itemId, -line.qtyM)
    }

    // Cash entry when paid and not credit (credit creates a receivable stub instead).
    const createsCash = input.paid && input.paymentMethod !== 'credit' && total > 0
    let cashEntryId: string | null = null
    if (createsCash) {
      cashEntryId = uuidv7()
      db.run(
        `INSERT INTO cash_entry (id, outlet_id, direction, amount, category, method, ref_type, ref_id, business_date, note, op_id, created_at)
         VALUES (?, ?, 'in', ?, 'penjualan', ?, 'sale', ?, ?, NULL, ?, ?)`,
        [cashEntryId, outletId, total, input.paymentMethod, saleId, input.businessDate, opId, now],
      )
    }

    enqueueOutboxOp(db, opId, 'sale.create', {
      op_id: opId,
      outlet_id: outletId,
      business_date: input.businessDate,
      customer_id: null,
      discount: input.discount,
      payment_method: input.paymentMethod,
      paid: input.paid,
      note: input.note ?? '',
      lines: input.lines.map((l) => ({
        item_id: l.itemId,
        qty: l.qtyM / 1000,
        unit_price: l.unitPrice,
        discount: l.discount,
      })),
    })
    return number
  })

  return getSale(db, saleId, saleNumber)!
}

export function getSale(db: Db, id: string, knownNumber?: number): Sale | null {
  const r = db.get<Record<string, unknown>>('SELECT * FROM sale WHERE id = ?', [id])
  if (!r) return null
  const lines = db
    .all<Record<string, unknown>>('SELECT * FROM sale_line WHERE sale_id = ? ORDER BY rowid', [id])
    .map(rowToSaleLine)
  const cash = db.get<{ id: string }>('SELECT id FROM cash_entry WHERE ref_type = ? AND ref_id = ?', ['sale', id])
  return {
    id: String(r.id),
    number: Number(r.number ?? knownNumber ?? 0),
    total: Number(r.total ?? 0),
    discount: Number(r.discount ?? 0),
    paymentMethod: String(r.payment_method) as Sale['paymentMethod'],
    paid: Boolean(r.paid),
    mode: String(r.mode) as Sale['mode'],
    businessDate: String(r.business_date),
    voidedAt: (r.voided_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
    lines,
    cashEntryId: cash?.id ?? null,
  }
}

function rowToSaleLine(r: Record<string, unknown>): SaleLine {
  return {
    id: String(r.id),
    saleId: String(r.sale_id),
    itemId: String(r.item_id),
    qtyM: Number(r.qty_m),
    unitPrice: Number(r.unit_price),
    discount: Number(r.discount ?? 0),
    costAtSale: Number(r.cost_at_sale ?? 0),
  }
}

/** ---------- cash book ---------- */

const CASH_CATEGORIES = ['modal', 'penjualan', 'pembelian_stok', 'listrik', 'sewa', 'gaji', 'transport', 'lain']

export function cashCategories(): string[] {
  return CASH_CATEGORIES
}

export function addCashEntry(db: Db, input: CashEntryInput): CashEntry {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('VALIDATION amount')
  if (input.direction !== 'in' && input.direction !== 'out') throw new Error('VALIDATION direction')
  const id = uuidv7()
  const opId = uuidv7()
  const outletId = requireOutletId(db)
  db.transaction(() => {
    db.run(
      `INSERT INTO cash_entry (id, outlet_id, direction, amount, category, method, ref_type, ref_id, business_date, note, op_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        outletId,
        input.direction,
        input.amount,
        input.category,
        input.method,
        input.refType ?? null,
        input.refId ?? null,
        input.businessDate,
        input.note ?? null,
        opId,
        new Date().toISOString(),
      ],
    )
    enqueueOutboxOp(db, opId, 'cash_entry.create', {
      op_id: opId,
      outlet_id: outletId,
      direction: input.direction,
      amount: input.amount,
      category: input.category,
      method: input.method,
      business_date: input.businessDate,
      note: input.note ?? undefined,
      ref_type: input.refType ?? undefined,
      ref_id: input.refId ?? undefined,
    })
  })
  const r = db.get<Record<string, unknown>>('SELECT * FROM cash_entry WHERE id = ?', [id])!
  return {
    id: String(r.id),
    direction: String(r.direction) as CashEntry['direction'],
    amount: Number(r.amount),
    category: String(r.category),
    method: (r.method as CashEntry['method']) ?? null,
    refType: (r.ref_type as string | null) ?? null,
    refId: (r.ref_id as string | null) ?? null,
    businessDate: String(r.business_date),
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
  }
}

export interface CashBookPage {
  entries: CashEntry[]
  totalIn: number
  totalOut: number
  net: number
}

export function listCashEntries(db: Db, month: string): CashBookPage {
  const { from, to } = monthRange(month)
  const rows = db.all<Record<string, unknown>>(
    'SELECT * FROM cash_entry WHERE business_date BETWEEN ? AND ? ORDER BY business_date DESC, created_at DESC',
    [from, to],
  )
  const entries = rows.map((r) => ({
    id: String(r.id),
    direction: String(r.direction) as CashEntry['direction'],
    amount: Number(r.amount),
    category: String(r.category),
    method: (r.method as CashEntry['method']) ?? null,
    refType: (r.ref_type as string | null) ?? null,
    refId: (r.ref_id as string | null) ?? null,
    businessDate: String(r.business_date),
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
  }))
  let totalIn = 0
  let totalOut = 0
  for (const e of entries) {
    if (e.direction === 'in') totalIn += e.amount
    else totalOut += e.amount
  }
  return { entries, totalIn, totalOut, net: totalIn - totalOut }
}

/** ---------- laba rugi (T-402) ---------- */

export function labaRugi(db: Db, month: string): LabaRugi {
  const { from, to } = monthRange(month)
  const revenueRow = db.get<{ revenue: number; unpaid: number }>(
    `SELECT COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(CASE WHEN paid = 0 OR payment_method = 'credit' THEN total ELSE 0 END), 0) AS unpaid
     FROM sale WHERE voided_at IS NULL AND business_date BETWEEN ? AND ?`,
    [from, to],
  )
  const hppMicroRow = db.get<{ hpp_micro: number }>(
    `SELECT COALESCE(SUM(l.qty_m * l.cost_at_sale), 0) AS hpp_micro
     FROM sale_line l JOIN sale s ON s.id = l.sale_id
     WHERE s.voided_at IS NULL AND s.business_date BETWEEN ? AND ?`,
    [from, to],
  )
  const opexRow = db.get<{ opex: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS opex FROM cash_entry
     WHERE direction = 'out' AND business_date BETWEEN ? AND ? AND category NOT IN ('pembelian_stok', 'modal')`,
    [from, to],
  )
  const revenue = revenueRow?.revenue ?? 0
  const hpp = Math.round((hppMicroRow?.hpp_micro ?? 0) / 1000)
  const opex = opexRow?.opex ?? 0
  const gross = revenue - hpp
  return {
    month,
    revenue,
    hpp,
    grossProfit: gross,
    opex,
    netProfit: gross - opex,
    unpaidRevenue: revenueRow?.unpaid ?? 0,
  }
}

/** Drill-down rows for each laba rugi line (each line is tappable). */

export function drillRevenue(db: Db, month: string): DrillRow[] {
  const { from, to } = monthRange(month)
  return db
    .all<Record<string, unknown>>(
      `SELECT id, number, total, payment_method, paid, mode, business_date
       FROM sale WHERE voided_at IS NULL AND business_date BETWEEN ? AND ?
       ORDER BY business_date DESC, number DESC`,
      [from, to],
    )
    .map((r) => {
      const method = String(r.payment_method)
      const unpaid = !r.paid || method === 'credit'
      return {
        id: String(r.id),
        label: `#${r.number}`,
        sublabel: method,
        amount: Number(r.total),
        flagged: String(r.mode) === 'daily_total' ? 'daily_total' : unpaid ? 'unpaid' : null,
        businessDate: String(r.business_date),
      }
    })
}

export function drillHpp(db: Db, month: string): DrillRow[] {
  const { from, to } = monthRange(month)
  return db
    .all<Record<string, unknown>>(
      `SELECT l.id, i.name, l.qty_m, l.cost_at_sale, l.unit_price, s.number, s.business_date, s.mode
       FROM sale_line l
       JOIN sale s ON s.id = l.sale_id
       JOIN item i ON i.id = l.item_id
       WHERE s.voided_at IS NULL AND s.business_date BETWEEN ? AND ?
       ORDER BY s.business_date DESC, s.number DESC`,
      [from, to],
    )
    .map((r) => ({
      id: String(r.id),
      label: String(r.name),
      sublabel: `#${r.number}`,
      amount: qtyTimesUnitCost(Number(r.qty_m), Number(r.cost_at_sale)),
      flagged: String(r.mode) === 'daily_total' ? 'daily_total' : null,
      businessDate: String(r.business_date),
    }))
}

export function drillOpex(db: Db, month: string): DrillRow[] {
  const { from, to } = monthRange(month)
  return db
    .all<Record<string, unknown>>(
      `SELECT id, category, note, amount, business_date FROM cash_entry
       WHERE direction = 'out' AND business_date BETWEEN ? AND ? AND category NOT IN ('pembelian_stok', 'modal')
       ORDER BY business_date DESC, created_at DESC`,
      [from, to],
    )
    .map((r) => ({
      id: String(r.id),
      label: String(r.category),
      sublabel: (r.note as string | null) ?? null,
      amount: Number(r.amount),
      businessDate: String(r.business_date),
    }))
}

/** ---------- demo + reset (dev only) ---------- */

export function resetAll(db: Db): void {
  db.exec(
    `DROP TABLE IF EXISTS outbox; DROP TABLE IF EXISTS cash_entry; DROP TABLE IF EXISTS sale_line; DROP TABLE IF EXISTS sale;
     DROP TABLE IF EXISTS sale_number_seq; DROP TABLE IF EXISTS stock_level; DROP TABLE IF EXISTS stock_move;
     DROP TABLE IF EXISTS item_unit; DROP TABLE IF EXISTS item_barcode; DROP TABLE IF EXISTS item;
     DROP TABLE IF EXISTS category; DROP TABLE IF EXISTS outlet; DROP TABLE IF EXISTS tenant; DROP TABLE IF EXISTS meta;
     PRAGMA user_version = 0;`,
  )
  migrate(db)
}

/** Demo seed reproducing ACCEPTANCE.md section A exactly. */
export function seedDemo(db: Db): void {
  resetAll(db)
  completeOnboarding(db, {
    businessName: 'Warung Bu Sri',
    businessType: 'kelontong',
    taxRatePercent: 0,
    opening: null,
  })
  const gula = createItem(db, {
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
  const beras = createItem(db, {
    name: 'Beras 5 kg',
    sku: null,
    barcodes: [],
    categoryId: null,
    baseUnit: 'pcs',
    units: [],
    salePrice: 62000,
    cost: 55000,
    minStockM: 2000,
    active: true,
  })
  void beras
  stockIn(db, { itemId: gula.id, qtyM: 10000, unitCost: 6000, businessDate: todayISO(), note: 'Belanja awal', supplier: null })
  stockIn(db, { itemId: gula.id, qtyM: 10000, unitCost: 9000, businessDate: todayISO(), note: 'Belanja tambahan', supplier: null })
  postSale(db, {
    businessDate: todayISO(),
    discount: 0,
    paymentMethod: 'cash',
    paid: true,
    note: null,
    lines: [{ itemId: gula.id, qtyM: 5000, unitPrice: 12000, discount: 0 }],
  })
  addCashEntry(db, {
    direction: 'out',
    amount: 5000,
    category: 'listrik',
    method: 'cash',
    businessDate: todayISO(),
    note: 'Token listrik',
    refType: null,
    refId: null,
  })
}

/**
 * RPC method table shared by the OPFS worker and the in-memory fallback.
 * The main thread never calls SQL directly — only these methods (T-202).
 */
export const repoMethods = {
  migrate: (db: Db) => migrate(db),
  isOnboarded,
  getTenant,
  getOutlet,
  getOnboardingDraft,
  saveOnboardingDraft,
  completeOnboarding,
  createItem,
  updateItem,
  getItem,
  listCategories,
  listItems,
  searchItems,
  stockIn,
  postSale,
  getSale,
  addCashEntry,
  listCashEntries,
  cashCategories: (_db: Db) => cashCategories(),
  labaRugi,
  drillRevenue,
  drillHpp,
  drillOpex,
  pendingOutboxCount,
  listOutbox,
  seedDemo,
  resetAll,
} as const

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : []

export type RepoMethodName = keyof typeof repoMethods
export type RepoMethodArgs<M extends RepoMethodName> = DropFirst<Parameters<(typeof repoMethods)[M]>>
export type RepoMethodResult<M extends RepoMethodName> = ReturnType<(typeof repoMethods)[M]>

/** Methods that change persisted data; the worker flushes to OPFS after these. */
export const MUTATING_METHODS = new Set<RepoMethodName>([
  'migrate',
  'saveOnboardingDraft',
  'completeOnboarding',
  'createItem',
  'updateItem',
  'stockIn',
  'postSale',
  'addCashEntry',
  'seedDemo',
  'resetAll',
])

export const DB_VERSION = SCHEMA_VERSION
