/**
 * Wire DTOs, typed from docs/API_CONTRACT.md and verified against the live
 * API (:8099). Field names are exactly as on the wire (snake_case).
 * Money: integer rupiah. Qty: number with up to 3 dp.
 */

export interface AuthTokens {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface UserRef {
  id: string
  name: string
  email: string
}

export interface TenantRef {
  id: string
  name: string
  tax_rate: number
}

export interface OutletRef {
  id: string
  name: string
  timezone: string
}

export interface Session extends AuthTokens {
  user: UserRef
  tenant: TenantRef
  outlet: OutletRef
  role: 'owner' | 'staff'
}

export interface Me extends Omit<Session, keyof AuthTokens> {
  capabilities: string[]
  outlets: OutletRef[]
}

export type Capability =
  | 'stock.write'
  | 'sales.write'
  | 'cash.write'
  | 'cost.read'
  | 'report.read'
  | 'item.write'
  | 'member.manage'
  | 'export'

export interface ApiItem {
  id: string
  sku: string | null
  name: string
  category_id: string | null
  base_unit: string
  sale_price: number
  cost_avg?: number // omitted for staff
  min_stock: number
  active: boolean
  stock: number
  low_stock: boolean
  negative_stock?: boolean
  units?: { name: string; factor: number }[]
  barcodes?: string[]
  updated_at: string
}

export interface ApiStockMove {
  id: string
  outlet_id: string
  item_id: string
  qty: number
  unit_cost: number | null
  type: 'in' | 'sale' | 'loss' | 'return' | 'adjust' | 'transfer'
  ref_type: string | null
  ref_id: string | null
  business_date: string
  note: string | null
  created_at: string
}

export interface ApiSaleLine {
  item_id: string
  qty: number
  unit_price: number
  discount: number
  cost_at_sale?: number
}

export interface ApiSale {
  id: string
  number: string
  outlet_id: string
  business_date: string
  total: number
  discount: number
  payment_method: 'cash' | 'transfer' | 'qris' | 'credit'
  paid: boolean
  mode: 'per_item' | 'daily_total'
  note?: string | null
  voided_at: string | null
  lines?: ApiSaleLine[]
  cash_entry_id?: string | null
  payment?: { id: string; method: string; amount_gross: number; mdr_amount: number; amount_net: number; status: string } | null
  created_moves?: string[]
}

export interface ApiCashEntry {
  id: string
  outlet_id: string
  direction: 'in' | 'out'
  amount: number
  category: string
  method: string
  ref_type: string | null
  ref_id: string | null
  business_date: string
  note: string | null
  created_at: string
}

export interface ApiCashCategory {
  id: string
  name: string
  direction: 'in' | 'out'
  seeded: boolean
  sort: number
}

export interface ApiLabaRugiLine {
  key: string
  label: string
  amount: number
  drill?: string | null
}

export interface ApiLabaRugi {
  from: string
  to: string
  revenue: number
  hpp: number
  gross_profit: number
  opex: number
  net_profit: number
  unpaid_revenue: number
  lines: ApiLabaRugiLine[]
}

export interface ApiDrillRow {
  sale_id?: string
  label?: string
  name?: string
  qty?: number
  unit_cost?: number
  amount?: number
  total?: number
  number?: string
  business_date: string
  [k: string]: unknown
}

export interface ApiLedgerRow {
  business_date: string
  type: string
  qty_delta: number
  unit_cost: number | null
  balance: number
  ref_type: string | null
  ref_id: string | null
  note: string | null
}

export interface ApiLedger {
  closing_qty: number
  negative_stock?: boolean
  rows: ApiLedgerRow[]
}

export interface ApiList<T> {
  data: T[]
  next_cursor: string | null
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message)
  }
}

export class NetworkError extends Error {
  constructor(msg = 'network') {
    super(msg)
  }
}

/** ---------- Sprint 2 wire shapes (QRIS, reports, opname) ---------- */

export interface ApiQrisSettings {
  outlet_id: string
  mode: 'none' | 'static_image' | 'static_payload'
  image_url: string | null
  payload: string | null
  mdr_pct: number
}

export interface ApiQrisConfirm {
  payment: {
    id: string
    sale_id: string
    method: string
    amount_gross: number
    mdr_amount: number
    amount_net: number
    status: string
    paid_at?: string
  }
}

export interface ApiStockReportItem {
  item_id?: string
  item_name?: string
  name?: string
  qty?: number
  min_stock?: number
  cost_avg?: number
  sale_price?: number
  value_at_cost?: number
  value_at_sale?: number
  last_movement_date?: string
  low_stock?: boolean
  negative_stock?: boolean
  dead_stock?: boolean
  [k: string]: unknown
}

export interface ApiStockReport {
  at_cost: number
  at_sale: number
  data: ApiStockReportItem[]
  low_stock: ApiStockReportItem[]
  dead_stock: ApiStockReportItem[]
  low_stock_count?: number
  dead_stock_count?: number
  [k: string]: unknown
}

export interface ApiSalesReportRow {
  day?: string
  business_date?: string
  item_id?: string
  item_name?: string
  category_id?: string
  category_name?: string
  revenue: number
  sale_count?: number
  line_count?: number
  daily_total_count?: number
  [k: string]: unknown
}

export interface ApiDashboard {
  today_sales: number
  cash_position: number
  low_stock_count: number
  month_profit: number
  [k: string]: unknown
}

export interface ApiOpnameLine {
  id?: string
  item_id: string
  item_name?: string
  system_qty: number
  counted_qty: number | null
  current_qty?: number
  [k: string]: unknown
}

export interface ApiOpnameSession {
  id: string
  outlet_id: string
  status: 'open' | 'posted' | 'cancelled'
  category_id?: string | null
  business_date: string
  lines: ApiOpnameLine[]
  [k: string]: unknown
}
