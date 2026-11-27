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

/** Read one meta value (or null) — RPC-friendly for the AppState wipe check. */
export function getMetaValue(db: Db, key: string): string | null {
  return getMeta(db, key)
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
      local_id: id,
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
      local_id: moveId,
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
      local_id: saleId,
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
      local_id: id,
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

/** Dev-only: bulk-insert N items for the G27 search/scroll performance pass. */
export function seedItemsBulk(db: Db, count: number): number {
  db.transaction(() => {
    const stmt = db.run // keep linters happy about unused
    void stmt
    for (let i = 0; i < count; i++) {
      db.run(
        `INSERT INTO item (id, sku, name, category_id, base_unit, sale_price, cost_avg, min_stock_m, active, updated_at)
         VALUES (?, ?, ?, NULL, 'pcs', ?, ?, 0, 1, ?)`,
        [uuidv7(), `SKU${100000 + i}`, `Barang Uji Nomor ${i} ${i % 7 === 0 ? 'Sembako' : i % 5 === 0 ? 'Minuman' : 'Lainnya'}`, 1000 + (i % 50) * 100, 500, new Date().toISOString()],
      )
    }
  })
  return count
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

/** Local-row cleanup after the server confirmed an op (server rows are cached instead). */
export function deleteStockMoveRow(db: Db, id: string): void {
  db.run('DELETE FROM stock_move WHERE id = ?', [id])
}

export function deleteCashEntryRow(db: Db, id: string): void {
  db.run('DELETE FROM cash_entry WHERE id = ?', [id])
}

/** Remove a local optimistic sale and its lines, auto cash entry and history moves. */
export function deleteLocalSale(db: Db, saleId: string): void {
  db.transaction(() => {
    db.run('DELETE FROM sale_line WHERE sale_id = ?', [saleId])
    db.run('DELETE FROM cash_entry WHERE ref_type = ? AND ref_id = ?', ['sale', saleId])
    db.run('DELETE FROM stock_move WHERE ref_type = ? AND ref_id = ?', ['sale', saleId])
    db.run('DELETE FROM sale WHERE id = ?', [saleId])
  })
}

/** Requeue an inbox op back into the outbox (retry action, T-220). */
export function addOutboxOpDirect(db: Db, input: { opId: string; type: string; payload: Record<string, unknown> }): void {
  db.run(
    `INSERT INTO outbox (op_id, type, payload, client_ts, status) VALUES (?, ?, ?, ?, 'pending')
     ON CONFLICT(op_id) DO UPDATE SET status = 'pending', fail_reason = NULL`,
    [input.opId, input.type, JSON.stringify(input.payload), new Date().toISOString()],
  )
}

/** ---------- sync state (T-301..T-306) ---------- */

export interface SyncState {
  deviceId: string
  cursor: number
  lastSyncedAt: string | null
}

export function getSyncState(db: Db): SyncState {
  const row = db.get<{ device_id: string; cursor: number; last_synced_at: string | null }>(
    'SELECT device_id, cursor, last_synced_at FROM sync_state WHERE singleton = 1',
  )
  if (!row) {
    const deviceId = uuidv7()
    db.run('INSERT INTO sync_state (singleton, device_id, cursor) VALUES (1, ?, 0)', [deviceId])
    return { deviceId, cursor: 0, lastSyncedAt: null }
  }
  return { deviceId: row.device_id, cursor: row.cursor, lastSyncedAt: row.last_synced_at }
}

/**
 * Apply one pull page and advance the cursor ONLY inside the same local
 * transaction (T-304) — if the commit fails, the cursor stays where it was
 * and the page re-pulls next time.
 *
 * `ownEchoes` carries field signatures of items this device just pushed in
 * the same sync run, so our own edits coming back do not raise the
 * "diubah di perangkat lain" notice.
 */
export function itemSignature(row: Record<string, unknown>): string {
  return [
    typeof row['name'] === 'string' ? row['name'] : '',
    Number(row['sale_price'] ?? 0),
    Math.round(Number(row['min_stock'] ?? 0) * 1000),
    row['active'] === false ? 0 : 1,
  ].join('|')
}

export function applyPullPage(
  db: Db,
  changes: { table: string; row: Record<string, unknown>; server_seq: number; deleted: boolean }[],
  newCursor: number,
  hasMore: boolean,
  ownEchoSignatures: string[] = [],
): void {
  const echoes = new Set(ownEchoSignatures)
  db.transaction(() => {
    for (const change of changes) {
      applyOneChange(db, change, echoes)
    }
    // Cursor advances only now — after every row of the page is committed.
    db.run('UPDATE sync_state SET cursor = ?, last_synced_at = ? WHERE singleton = 1', [
      newCursor,
      new Date().toISOString(),
    ])
  })
  void hasMore
}

function applyOneChange(
  db: Db,
  change: { table: string; row: Record<string, unknown>; server_seq: number; deleted: boolean },
  ownEchoes: Set<string>,
): void {
  const row = change.row ?? {}
  const id = String(row['id'] ?? '')
  if (id === '') return
  switch (change.table) {
    case 'item': {
      if (change.deleted) {
        db.run('UPDATE item SET deleted_at = ?, active = 0 WHERE id = ?', [new Date().toISOString(), id])
        return
      }
      const existing = db.get<{ updated_at: string | null }>('SELECT updated_at FROM item WHERE id = ?', [id])
      const name = typeof row['name'] === 'string' ? row['name'] : ''
      const baseUnit = typeof row['base_unit'] === 'string' ? row['base_unit'] : 'pcs'
      const updatedAt = typeof row['updated_at'] === 'string' ? row['updated_at'] : new Date().toISOString()
      if (existing) {
        // LWW on the server clock: the server row wins; notice other devices' edits.
        db.run(
          `UPDATE item SET sku = ?, name = ?, category_id = ?, base_unit = ?, sale_price = ?, cost_avg = ?, min_stock_m = ?, active = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`,
          [
            (row['sku'] as string | null) ?? null,
            name,
            (row['category_id'] as string | null) ?? null,
            baseUnit,
            Number(row['sale_price'] ?? 0),
            Number(row['cost_avg'] ?? 0),
            Math.round(Number(row['min_stock'] ?? 0) * 1000),
            row['active'] === false ? 0 : 1,
            updatedAt,
            id,
          ],
        )
        // LWW notice — but not for our own edit echoing back in this run.
        if (!ownEchoes.has(itemSignature(row))) {
          markChangedElsewhere(db, id, name)
        }
      } else {
        db.run(
          `INSERT INTO item (id, sku, name, category_id, base_unit, sale_price, cost_avg, min_stock_m, active, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            (row['sku'] as string | null) ?? null,
            name,
            (row['category_id'] as string | null) ?? null,
            baseUnit,
            Number(row['sale_price'] ?? 0),
            Number(row['cost_avg'] ?? 0),
            Math.round(Number(row['min_stock'] ?? 0) * 1000),
            row['active'] === false ? 0 : 1,
            updatedAt,
          ],
        )
      }
      // Stock projection from the server when present.
      if (row['stock'] !== undefined) {
        const outletId = getMeta(db, 'outlet_id')
        if (outletId) {
          db.run(
            `INSERT INTO stock_level (outlet_id, item_id, qty_m) VALUES (?, ?, ?)
             ON CONFLICT(outlet_id, item_id) DO UPDATE SET qty_m = excluded.qty_m`,
            [outletId, id, Math.round(Number(row['stock'] ?? 0) * 1000)],
          )
        }
      }
      return
    }
    case 'stock_move': {
      const existing = db.get<{ id: string }>('SELECT id FROM stock_move WHERE id = ?', [id])
      if (existing) return
      const outletId = getMeta(db, 'outlet_id')
      db.run(
        `INSERT INTO stock_move (id, outlet_id, item_id, qty_m, unit_cost, type, ref_type, ref_id, business_date, note, created_at, op_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          (row['outlet_id'] as string) ?? outletId ?? '',
          String(row['item_id'] ?? ''),
          Math.round(Number(row['qty'] ?? 0) * 1000),
          row['unit_cost'] !== undefined && row['unit_cost'] !== null ? Number(row['unit_cost']) : 0,
          String(row['type'] ?? 'in'),
          (row['ref_type'] as string | null) ?? null,
          (row['ref_id'] as string | null) ?? null,
          String(row['business_date'] ?? ''),
          (row['note'] as string | null) ?? null,
          typeof row['created_at'] === 'string' ? row['created_at'] : new Date().toISOString(),
          (row['op_id'] as string | null) ?? null,
        ],
      )
      // Stock projection: replay the delta only for rows we did not have.
      if (outletId) {
        db.run(
          `INSERT INTO stock_level (outlet_id, item_id, qty_m) VALUES (?, ?, ?)
           ON CONFLICT(outlet_id, item_id) DO UPDATE SET qty_m = qty_m + excluded.qty_m`,
          [outletId, String(row['item_id'] ?? ''), Math.round(Number(row['qty'] ?? 0) * 1000)],
        )
      }
      return
    }
    case 'sale': {
      const existing = db.get<{ id: string }>('SELECT id FROM sale WHERE id = ?', [id])
      const number = Number(String(row['number'] ?? '').replace(/\D/g, '')) || 0
      const serverPaid = row['paid'] === true
      if (existing) {
        // Never clobber a server-set paid flag with a stale local value (T-305).
        db.run(
          `UPDATE sale SET number = ?, total = ?, discount = ?, payment_method = ?, paid = MAX(paid, ?), mode = ?, note = ?, voided_at = ?, void_reason = ? WHERE id = ?`,
          [
            number,
            Number(row['total'] ?? 0),
            Number(row['discount'] ?? 0),
            String(row['payment_method'] ?? 'cash'),
            serverPaid ? 1 : 0,
            String(row['mode'] ?? 'per_item'),
            (row['note'] as string | null) ?? null,
            (row['voided_at'] as string | null) ?? null,
            (row['void_reason'] as string | null) ?? null,
            id,
          ],
        )
      } else {
        db.run(
          `INSERT INTO sale (id, outlet_id, number, total, discount, payment_method, paid, mode, business_date, voided_at, void_reason, note, op_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            (row['outlet_id'] as string) ?? '',
            number,
            Number(row['total'] ?? 0),
            Number(row['discount'] ?? 0),
            String(row['payment_method'] ?? 'cash'),
            serverPaid ? 1 : 0,
            String(row['mode'] ?? 'per_item'),
            String(row['business_date'] ?? ''),
            (row['voided_at'] as string | null) ?? null,
            (row['void_reason'] as string | null) ?? null,
            (row['note'] as string | null) ?? null,
            (row['op_id'] as string | null) ?? null,
            typeof row['created_at'] === 'string' ? row['created_at'] : new Date().toISOString(),
          ],
        )
      }
      // The server embeds a sale's lines in the sale row (sale_line is not a pulled
      // table). Without this, a second device shows revenue with an empty HPP
      // breakdown — the section C case the two-device gate exists to catch.
      // Lines never change after posting, so replace-then-insert is safe.
      const lines = row['lines']
      if (Array.isArray(lines)) {
        db.run('DELETE FROM sale_line WHERE sale_id = ?', [id])
        for (const raw of lines) {
          const l = raw as Record<string, unknown>
          const lineId = (l['id'] as string) ?? `${id}-${String(l['item_id'] ?? '')}`
          // qty arrives in base units as a JSON number (e.g. 5); local stores milli-units.
          const qtyM = Math.round(Number(l['qty'] ?? 0) * 1000)
          // Staff pulls omit cost_at_sale; store 0 rather than throwing.
          const costAtSale = Number(l['cost_at_sale'] ?? 0) || 0
          db.run(
            `INSERT INTO sale_line (id, sale_id, item_id, qty_m, unit_price, discount, cost_at_sale)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              lineId,
              id,
              (l['item_id'] as string) ?? '',
              qtyM,
              Number(l['unit_price'] ?? 0),
              Number(l['discount'] ?? 0),
              costAtSale,
            ],
          )
        }
      }
      return
    }
    case 'cash_entry': {
      if (db.get<{ id: string }>('SELECT id FROM cash_entry WHERE id = ?', [id])) return
      db.run(
        `INSERT INTO cash_entry (id, outlet_id, direction, amount, category, method, ref_type, ref_id, business_date, note, op_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          (row['outlet_id'] as string) ?? '',
          String(row['direction'] ?? 'in'),
          Number(row['amount'] ?? 0),
          String(row['category'] ?? ''),
          (row['method'] as string | null) ?? null,
          (row['ref_type'] as string | null) ?? null,
          (row['ref_id'] as string | null) ?? null,
          String(row['business_date'] ?? ''),
          (row['note'] as string | null) ?? null,
          (row['op_id'] as string | null) ?? null,
          typeof row['created_at'] === 'string' ? row['created_at'] : new Date().toISOString(),
        ],
      )
      return
    }
    case 'stock_level': {
      const outletId = (row['outlet_id'] as string) ?? getMeta(db, 'outlet_id')
      if (!outletId) return
      db.run(
        `INSERT INTO stock_level (outlet_id, item_id, qty_m) VALUES (?, ?, ?)
         ON CONFLICT(outlet_id, item_id) DO UPDATE SET qty_m = excluded.qty_m`,
        [outletId, String(row['item_id'] ?? ''), Math.round(Number(row['qty'] ?? 0) * 1000)],
      )
      return
    }
    case 'sale_line': {
      const existing = db.get<{ id: string }>('SELECT id FROM sale_line WHERE id = ?', [id])
      if (existing) return
      const saleId = String(row['sale_id'] ?? '')
      if (!db.get<{ id: string }>('SELECT id FROM sale WHERE id = ?', [saleId])) return
      db.run(
        `INSERT INTO sale_line (id, sale_id, item_id, qty_m, unit_price, discount, cost_at_sale)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          saleId,
          String(row['item_id'] ?? ''),
          Math.round(Number(row['qty'] ?? 0) * 1000),
          Number(row['unit_price'] ?? 0),
          Number(row['discount'] ?? 0),
          Number(row['cost_at_sale'] ?? 0),
        ],
      )
      return
    }
    case 'outlet': {
      // QRIS settings arrive here: cache them for offline QR.
      const outletId = getMeta(db, 'outlet_id')
      if (outletId && id === outletId && (row['qris_payload'] !== undefined || row['qris_mode'] !== undefined)) {
        setServerCache(db, `qris:${id}`, {
          outlet_id: id,
          mode: row['qris_mode'] ?? 'none',
          image_url: null,
          payload: (row['qris_payload'] as string | null) ?? null,
          mdr_pct: Number(row['mdr_pct'] ?? 0),
        })
      }
      return
    }
    case 'category': {
      db.run(
        'INSERT INTO category (id, name, sort) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort = excluded.sort',
        [id, String(row['name'] ?? ''), Number(row['sort'] ?? 0)],
      )
      return
    }
    default:
      // Unknown table: ignore, cursor still advances past it.
      return
  }
}

 /** Detect another device's edit (LWW notice, T-305). */
function markChangedElsewhere(db: Db, itemId: string, itemName: string): void {
  db.run(
    'INSERT INTO changed_elsewhere (item_id, item_name, noticed_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET noticed_at = excluded.noticed_at, item_name = excluded.item_name',
    [itemId, itemName, new Date().toISOString()],
  )
}

export function listChangedElsewhere(db: Db): { itemId: string; itemName: string; noticedAt: string }[] {
  return db
    .all<{ item_id: string; item_name: string; noticed_at: string }>('SELECT item_id, item_name, noticed_at FROM changed_elsewhere')
    .map((r) => ({ itemId: r.item_id, itemName: r.item_name, noticedAt: r.noticed_at }))
}

export function clearChangedElsewhere(db: Db, itemId: string): void {
  db.run('DELETE FROM changed_elsewhere WHERE item_id = ?', [itemId])
}

/** ---------- "Perlu dicek" inbox (T-220) ---------- */

export interface InboxRow {
  id: string
  kind: 'rejected' | 'conflict'
  type: string
  payload: Record<string, unknown>
  reason: string | null
  title: string
  createdAt: string
}

export function addInboxRow(
  db: Db,
  entry: { id: string; kind: 'rejected' | 'conflict'; type: string; payload: Record<string, unknown>; reason: string | null; title: string },
): void {
  db.run(
    `INSERT INTO inbox (id, kind, type, payload, reason, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, reason = excluded.reason, title = excluded.title, created_at = excluded.created_at`,
    [
      entry.id,
      entry.kind,
      entry.type,
      JSON.stringify(entry.payload),
      entry.reason,
      entry.title,
      new Date().toISOString(),
    ],
  )
}

export function listInbox(db: Db): InboxRow[] {
  return db
    .all<{ id: string; kind: string; type: string; payload: string; reason: string | null; title: string; created_at: string }>(
      'SELECT id, kind, type, payload, reason, title, created_at FROM inbox ORDER BY created_at DESC',
    )
    .map((r) => ({
      id: r.id,
      kind: r.kind as InboxRow['kind'],
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      reason: r.reason,
      title: r.title,
      createdAt: r.created_at,
    }))
}

export function removeInboxRow(db: Db, id: string): void {
  db.run('DELETE FROM inbox WHERE id = ?', [id])
}

export function inboxCount(db: Db): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM inbox')!.n
}

/** ---------- outbox (sync increment) ---------- */

export interface PendingOp {
  opId: string
  type: string
  payload: Record<string, unknown>
  clientTs: string
}

/** Pending ops in client_ts order — the flush engine posts them in this order. */
export function pendingOutboxList(db: Db, limit = 50): PendingOp[] {
  return db
    .all<{ op_id: string; type: string; payload: string; client_ts: string }>(
      "SELECT op_id, type, payload, client_ts FROM outbox WHERE status = 'pending' ORDER BY client_ts, rowid LIMIT ?",
      [limit],
    )
    .map((r) => ({ opId: r.op_id, type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown>, clientTs: r.client_ts }))
}

/** Remove a queued op after the API confirmed it. Only confirmed success may call this. */
export function clearOutboxOp(db: Db, opId: string): void {
  db.run('DELETE FROM outbox WHERE op_id = ?', [opId])
}

/** Mark an op as rejected by the server (4xx/5xx) so it stops blocking the queue. */
export function markOutboxFailed(db: Db, opId: string, reason: string): void {
  db.run('UPDATE outbox SET status = ?, fail_reason = ? WHERE op_id = ?', ['failed', reason.slice(0, 300), opId])
}

/** ---------- server session + cache (demo-spine API increment) ---------- */

/**
 * Bind the local store to a server identity. When the local store belongs to a
 * different tenant (or has local-only data), business data is wiped so the
 * cache starts clean from the server's truth.
 */
export function setServerSession(
  db: Db,
  tenant: { id: string; name: string },
  outlet: { id: string; name: string; timezone: string },
): 'fresh' | 'kept' {
  const currentTenantId = getMeta(db, 'tenant_id')
  const serverMode = getMeta(db, 'api_tenant_id')
  if (currentTenantId !== tenant.id || serverMode !== tenant.id) {
    const hasAnyData = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM item')!.n > 0
    if (hasAnyData || currentTenantId !== null) {
      resetAll(db)
    }
    db.transaction(() => {
      db.run('INSERT INTO tenant (id, name, tax_rate, business_type, created_at) VALUES (?, ?, 0, NULL, ?)', [
        tenant.id,
        tenant.name,
        new Date().toISOString(),
      ])
      db.run('INSERT INTO outlet (id, tenant_id, name, timezone) VALUES (?, ?, ?, ?)', [
        outlet.id,
        tenant.id,
        outlet.name,
        outlet.timezone,
      ])
      setMeta(db, 'tenant_id', tenant.id)
      setMeta(db, 'outlet_id', outlet.id)
      setMeta(db, 'onboarded', 'true')
      setMeta(db, 'api_tenant_id', tenant.id)
    })
    return 'fresh'
  }
  return 'kept'
}

export function getServerCache(db: Db, key: string): { payload: unknown; fetched_at: string } | null {
  const row = db.get<{ payload: string; fetched_at: string }>('SELECT payload, fetched_at FROM server_cache WHERE key = ?', [key])
  if (!row) return null
  return { payload: JSON.parse(row.payload), fetched_at: row.fetched_at }
}

export function setServerCache(db: Db, key: string, payload: unknown): void {
  db.run(
    'INSERT INTO server_cache (key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at',
    [key, JSON.stringify(payload), new Date().toISOString()],
  )
}

/** Wire-format item row (snake_case, decimal qty) — subset of the API contract shape. */
export interface ServerItemRow {
  id: string
  sku: string | null
  name: string
  category_id: string | null
  base_unit: string
  sale_price: number
  cost_avg?: number
  min_stock: number
  active: boolean
  stock: number
  low_stock?: boolean
  units?: { name: string; factor: number }[]
  barcodes?: string[]
  updated_at?: string
}

function qtyToMilli(q: number): number {
  return Math.round(q * 1000)
}

/** Upsert server item rows into the local cache (server ids are the ids). */
export function applyServerItems(db: Db, items: ServerItemRow[]): void {
  const outletId = getMeta(db, 'outlet_id')
  if (!outletId) throw new Error('NOT_ONBOARDED')
  db.transaction(() => {
    for (const it of items) {
      const minStockM = qtyToMilli(it.min_stock ?? 0)
      const stockM = qtyToMilli(it.stock ?? 0)
      const existing = db.get<{ id: string }>('SELECT id FROM item WHERE id = ?', [it.id])
      if (existing) {
        db.run(
          `UPDATE item SET sku = ?, name = ?, category_id = ?, base_unit = ?, sale_price = ?, cost_avg = ?, min_stock_m = ?, active = ?, updated_at = ? WHERE id = ?`,
          [
            it.sku ?? null,
            it.name,
            it.category_id ?? null,
            it.base_unit,
            it.sale_price,
            it.cost_avg ?? 0,
            minStockM,
            it.active ? 1 : 0,
            it.updated_at ?? new Date().toISOString(),
            it.id,
          ],
        )
      } else {
        db.run(
          `INSERT INTO item (id, sku, name, category_id, base_unit, sale_price, cost_avg, min_stock_m, active, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            it.id,
            it.sku ?? null,
            it.name,
            it.category_id ?? null,
            it.base_unit,
            it.sale_price,
            it.cost_avg ?? 0,
            minStockM,
            it.active ? 1 : 0,
            it.updated_at ?? new Date().toISOString(),
          ],
        )
      }
      // Stock projection comes from the server's number.
      db.run(
        `INSERT INTO stock_level (outlet_id, item_id, qty_m) VALUES (?, ?, ?)
         ON CONFLICT(outlet_id, item_id) DO UPDATE SET qty_m = excluded.qty_m`,
        [outletId, it.id, stockM],
      )
      if (it.barcodes) {
        db.run('DELETE FROM item_barcode WHERE item_id = ?', [it.id])
        for (const b of it.barcodes) {
          if (b.trim() === '') continue
          db.run('INSERT INTO item_barcode (id, item_id, barcode) VALUES (?, ?, ?)', [uuidv7(), it.id, b])
        }
      }
      if (it.units) {
        db.run('DELETE FROM item_unit WHERE item_id = ?', [it.id])
        for (const u of it.units) {
          const factorM = qtyToMilli(u.factor)
          if (u.name.trim() === '' || factorM <= 0) continue
          db.run('INSERT INTO item_unit (id, item_id, name, factor_m) VALUES (?, ?, ?, ?)', [uuidv7(), it.id, u.name, factorM])
        }
      }
    }
  })
}

export function applyServerCategories(db: Db, cats: { id: string; name: string; sort?: number }[]): void {
  db.transaction(() => {
    for (const c of cats) {
      const existing = db.get<{ id: string }>('SELECT id FROM category WHERE id = ?', [c.id])
      if (existing) {
        db.run('UPDATE category SET name = ?, sort = ? WHERE id = ?', [c.name, c.sort ?? 0, c.id])
      } else {
        db.run('INSERT INTO category (id, name, sort) VALUES (?, ?, ?)', [c.id, c.name, c.sort ?? 0])
      }
    }
  })
}

export interface ServerStockMoveRow {
  id: string
  outlet_id: string
  item_id: string
  qty: number
  unit_cost: number | null
  type: string
  ref_type?: string | null
  ref_id?: string | null
  business_date: string
  note?: string | null
  created_at?: string
}

/** Cache a server stock move row (history display); stock levels come via applyServerItems. */
export function applyServerStockMove(db: Db, move: ServerStockMoveRow): void {
  const existing = db.get<{ id: string }>('SELECT id FROM stock_move WHERE id = ?', [move.id])
  if (existing) return
  db.run(
    `INSERT INTO stock_move (id, outlet_id, item_id, qty_m, unit_cost, type, ref_type, ref_id, business_date, note, created_at, op_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      move.id,
      move.outlet_id,
      move.item_id,
      qtyToMilli(move.qty),
      move.unit_cost,
      move.type,
      move.ref_type ?? null,
      move.ref_id ?? null,
      move.business_date,
      move.note ?? null,
      move.created_at ?? new Date().toISOString(),
    ],
  )
}

export interface ServerSaleRow {
  id: string
  number: string
  outlet_id: string
  business_date: string
  total: number
  discount: number
  payment_method: string
  paid: boolean
  mode: string
  note?: string | null
  voided_at?: string | null
  lines?: { item_id: string; qty: number; unit_price: number; discount: number; cost_at_sale?: number }[]
  cash_entry_id?: string | null
  payment?: { method: string; amount_gross: number; status: string } | null
}

/** Cache a server sale (lines + cash entry) so offline views show server truth. */
export function applyServerSale(db: Db, sale: ServerSaleRow): void {
  const outletId = getMeta(db, 'outlet_id')
  if (!outletId) throw new Error('NOT_ONBOARDED')
  const existing = db.get<{ id: string }>('SELECT id FROM sale WHERE id = ?', [sale.id])
  const number = Number(String(sale.number).replace(/\D/g, '')) || 0
  db.transaction(() => {
    if (existing) {
      db.run(
        `UPDATE sale SET number = ?, total = ?, discount = ?, payment_method = ?, paid = ?, mode = ?, note = ?, voided_at = ? WHERE id = ?`,
        [
          number,
          sale.total,
          sale.discount,
          sale.payment_method,
          sale.paid ? 1 : 0,
          sale.mode,
          sale.note ?? null,
          sale.voided_at ?? null,
          sale.id,
        ],
      )
      db.run('DELETE FROM sale_line WHERE sale_id = ?', [sale.id])
    } else {
      db.run(
        `INSERT INTO sale (id, outlet_id, number, total, discount, payment_method, paid, mode, business_date, voided_at, void_reason, note, op_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
        [
          sale.id,
          sale.outlet_id,
          number,
          sale.total,
          sale.discount,
          sale.payment_method,
          sale.paid ? 1 : 0,
          sale.mode,
          sale.business_date,
          sale.voided_at ?? null,
          sale.note ?? null,
          new Date().toISOString(),
        ],
      )
    }
    for (const l of sale.lines ?? []) {
      db.run(
        `INSERT INTO sale_line (id, sale_id, item_id, qty_m, unit_price, discount, cost_at_sale)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv7(), sale.id, l.item_id, qtyToMilli(l.qty), l.unit_price, l.discount, l.cost_at_sale ?? 0],
      )
    }
    if (sale.cash_entry_id) {
      const cashExists = db.get<{ id: string }>('SELECT id FROM cash_entry WHERE id = ?', [sale.cash_entry_id])
      if (!cashExists) {
        db.run(
          `INSERT INTO cash_entry (id, outlet_id, direction, amount, category, method, ref_type, ref_id, business_date, note, op_id, created_at)
           VALUES (?, ?, 'in', ?, 'penjualan', ?, 'sale', ?, ?, NULL, NULL, ?)`,
          [
            sale.cash_entry_id,
            sale.outlet_id,
            sale.payment?.amount_gross ?? sale.total,
            sale.payment?.method ?? sale.payment_method,
            sale.id,
            sale.business_date,
            new Date().toISOString(),
          ],
        )
      }
    }
  })
}

export interface ServerCashEntryRow {
  id: string
  outlet_id: string
  direction: 'in' | 'out'
  amount: number
  category: string
  method: string
  ref_type?: string | null
  ref_id?: string | null
  business_date: string
  note?: string | null
  created_at?: string
}

export function applyServerCashEntry(db: Db, entry: ServerCashEntryRow): void {
  const existing = db.get<{ id: string }>('SELECT id FROM cash_entry WHERE id = ?', [entry.id])
  if (existing) {
    db.run(
      `UPDATE cash_entry SET direction = ?, amount = ?, category = ?, method = ?, ref_type = ?, ref_id = ?, business_date = ?, note = ? WHERE id = ?`,
      [
        entry.direction,
        entry.amount,
        entry.category,
        entry.method,
        entry.ref_type ?? null,
        entry.ref_id ?? null,
        entry.business_date,
        entry.note ?? null,
        entry.id,
      ],
    )
    return
  }
  db.run(
    `INSERT INTO cash_entry (id, outlet_id, direction, amount, category, method, ref_type, ref_id, business_date, note, op_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      entry.id,
      entry.outlet_id,
      entry.direction,
      entry.amount,
      entry.category,
      entry.method,
      entry.ref_type ?? null,
      entry.ref_id ?? null,
      entry.business_date,
      entry.note ?? null,
      entry.created_at ?? new Date().toISOString(),
    ],
  )
}

/** ---------- offline id remapping ---------- */

/**
 * Replace a local row id with the server id everywhere it is referenced.
 * Must run outside a transaction with foreign_keys off (PKs are being rewritten).
 */
export function remapItemId(db: Db, localId: string, serverId: string): void {
  if (localId === serverId) return
  const row = db.get<{ server_id: string }>('SELECT server_id FROM id_map WHERE local_id = ?', [localId])
  if (row) return // already remapped
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.run('UPDATE item SET id = ? WHERE id = ?', [serverId, localId])
      db.run('UPDATE item_unit SET item_id = ? WHERE item_id = ?', [serverId, localId])
      db.run('UPDATE item_barcode SET item_id = ? WHERE item_id = ?', [serverId, localId])
      db.run('UPDATE stock_move SET item_id = ? WHERE item_id = ?', [serverId, localId])
      db.run('UPDATE stock_level SET item_id = ? WHERE item_id = ?', [serverId, localId])
      db.run('UPDATE sale_line SET item_id = ? WHERE item_id = ?', [serverId, localId])
      db.run('INSERT INTO id_map (local_id, server_id) VALUES (?, ?)', [localId, serverId])
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

/** Resolve a possibly-local id to its server id (one hop). */
export function resolveIdMap(db: Db, localId: string): string {
  const row = db.get<{ server_id: string }>('SELECT server_id FROM id_map WHERE local_id = ?', [localId])
  return row?.server_id ?? localId
}

export interface LocalSaleLine {
  id: string
  saleId: string
  itemId: string
  qtyM: number
  unitPrice: number
  discount: number
  costAtSale: number
}

/** Lines of one local sale (sale detail sheet — includes pulled lines). */
export function getSaleLinesLocal(db: Db, saleId: string): LocalSaleLine[] {
  return db
    .all<Record<string, unknown>>('SELECT * FROM sale_line WHERE sale_id = ? ORDER BY rowid', [saleId])
    .map(rowToSaleLine)
}

/** Local sale rows for a month (offline sales-list fallback: queued sales not yet on the server). */
export function listSalesLocal(db: Db, month: string): Sale[] {
  const { from, to } = monthRange(month)
  return db
    .all<Record<string, unknown>>(
      'SELECT * FROM sale WHERE business_date BETWEEN ? AND ? ORDER BY business_date DESC, number DESC',
      [from, to],
    )
    .map((r) => {
      const lines = db
        .all<Record<string, unknown>>('SELECT * FROM sale_line WHERE sale_id = ? ORDER BY rowid', [String(r.id)])
        .map(rowToSaleLine)
      return {
        id: String(r.id),
        number: Number(r.number),
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
        cashEntryId: null,
      }
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
  getMetaValue,
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
  getSaleLinesLocal,
  listSalesLocal,
  addCashEntry,
  listCashEntries,
  cashCategories: (_db: Db) => cashCategories(),
  labaRugi,
  drillRevenue,
  drillHpp,
  drillOpex,
  pendingOutboxCount,
  pendingOutboxList,
  listOutbox,
  clearOutboxOp,
  markOutboxFailed,
  addOutboxOpDirect,
  getSyncState,
  applyPullPage,
  addInboxRow,
  listInbox,
  removeInboxRow,
  inboxCount,
  listChangedElsewhere,
  clearChangedElsewhere,
  setServerSession,
  getServerCache,
  setServerCache,
  applyServerItems,
  applyServerCategories,
  applyServerStockMove,
  applyServerSale,
  applyServerCashEntry,
  remapItemId,
  resolveIdMap,
  deleteStockMoveRow,
  deleteCashEntryRow,
  deleteLocalSale,
  seedDemo,
  seedItemsBulk,
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
  'setServerSession',
  'setServerCache',
  'clearOutboxOp',
  'markOutboxFailed',
  'addOutboxOpDirect',
  'getSyncState',
  'applyPullPage',
  'addInboxRow',
  'removeInboxRow',
  'clearChangedElsewhere',
  'applyServerItems',
  'applyServerCategories',
  'applyServerStockMove',
  'applyServerSale',
  'applyServerCashEntry',
  'remapItemId',
  'deleteStockMoveRow',
  'deleteCashEntryRow',
  'deleteLocalSale',
  'seedDemo',
  'seedItemsBulk',
  'resetAll',
])

export const DB_VERSION = SCHEMA_VERSION
