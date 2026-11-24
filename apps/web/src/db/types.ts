/**
 * Local DTO shapes. Field names follow docs/API_CONTRACT.md (camelCase JSON)
 * so a remote Repository adapter can reuse the same types later.
 * Money: integer rupiah. Qty: integer milli-units (qty * 1000), suffix `M`.
 */

export type PaymentMethod = 'cash' | 'transfer' | 'qris' | 'credit'
export type StockMoveType = 'in' | 'sale' | 'loss' | 'return' | 'adjust' | 'transfer'
export type CashDirection = 'in' | 'out'

export interface Tenant {
  id: string
  name: string
  taxRate: number
  businessType: string | null
}

export interface Outlet {
  id: string
  tenantId: string
  name: string
  timezone: string
}

export interface Item {
  id: string
  sku: string | null
  name: string
  categoryId: string | null
  baseUnit: string
  salePrice: number
  costAvg: number
  minStockM: number
  active: boolean
  stockM: number
  lowStock: boolean
  updatedAt: string
}

export interface ItemUnit {
  id: string
  itemId: string
  name: string
  factorM: number
}

export interface ItemBarcode {
  id: string
  itemId: string
  barcode: string
}

export interface ItemDetail extends Item {
  units: ItemUnit[]
  barcodes: ItemBarcode[]
  stockMoves: StockMove[]
}

export interface StockMove {
  id: string
  outletId: string
  itemId: string
  qtyM: number
  unitCost: number
  type: StockMoveType
  refType: string | null
  refId: string | null
  businessDate: string
  note: string | null
  createdAt: string
}

export interface SaleLine {
  id: string
  saleId: string
  itemId: string
  qtyM: number
  unitPrice: number
  discount: number
  costAtSale: number
}

export interface Sale {
  id: string
  number: number
  total: number
  discount: number
  paymentMethod: PaymentMethod
  paid: boolean
  mode: 'per_item' | 'daily_total'
  businessDate: string
  voidedAt: string | null
  note: string | null
  createdAt: string
  lines?: SaleLine[]
  cashEntryId?: string | null
}

export interface CashEntry {
  id: string
  direction: CashDirection
  amount: number
  category: string
  method: PaymentMethod | null
  refType: string | null
  refId: string | null
  businessDate: string
  note: string | null
  createdAt: string
}

export interface OutboxOp {
  opId: string
  type: string
  payload: unknown
  clientTs: string
  status: 'pending'
}

export interface LabaRugi {
  month: string
  revenue: number
  hpp: number
  grossProfit: number
  opex: number
  netProfit: number
  unpaidRevenue: number
}

export interface DrillRow {
  id: string
  label: string
  sublabel: string | null
  amount: number
  flagged?: string | null
  businessDate: string
}

/** ---------- Inputs ---------- */

export interface ItemInput {
  name: string
  sku: string | null
  barcodes: string[]
  categoryId: string | null
  baseUnit: string
  units: { name: string; factorM: number }[]
  salePrice: number
  cost: number
  minStockM: number
  active: boolean
}

export interface StockInInput {
  itemId: string
  qtyM: number
  unitCost: number
  businessDate: string
  note: string | null
  supplier: string | null
}

export interface SaleLineInput {
  itemId: string
  qtyM: number
  unitPrice: number
  discount: number
}

export interface SaleInput {
  businessDate: string
  discount: number
  paymentMethod: PaymentMethod
  paid: boolean
  note: string | null
  lines: SaleLineInput[]
}

export interface CashEntryInput {
  direction: CashDirection
  amount: number
  category: string
  method: PaymentMethod
  businessDate: string
  note: string | null
  refType: string | null
  refId: string | null
}

export interface OnboardingDraft {
  step: number
  businessName: string
  businessType: string
  taxRatePercent: number
  openingItemName: string
  openingQtyText: string
  openingCost: number
  openingSalePrice: number
}
