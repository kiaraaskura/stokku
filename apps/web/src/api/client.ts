/**
 * API client (demo-spine increment). One place for:
 * - base URL (VITE_API_URL, default http://localhost:8099), /v1 prefix
 * - auth headers
 * - 401 -> refresh once -> retry, then logout
 * Components never call fetch directly — they go through this client.
 */
import {
  ApiError,
  NetworkError,
  type ApiCashCategory,
  type ApiCashEntry,
  type ApiDrillRow,
  type ApiItem,
  type ApiLabaRugi,
  type ApiLedger,
  type ApiList,
  type ApiOpnameSession,
  type ApiQrisConfirm,
  type ApiQrisSettings,
  type ApiSale,
  type ApiSalesReportRow,
  type ApiStockMove,
  type ApiStockReport,
  type ApiDashboard,
  type Me,
  type Session,
} from './types'

export const API_BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8099'

const REFRESH_KEY = 'stokku.refresh_token'
const SESSION_KEY = 'stokku.session' // per-tab cache: survives reloads, including offline ones

type FetchLike = typeof fetch

export interface ApiClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
  /** Persisted refresh-token store; defaults to localStorage. */
  loadRefresh?: () => string | null
  saveRefresh?: (token: string | null) => void
  onSessionChange?: (session: Session | null) => void
}

export class ApiClient {
  readonly baseUrl: string
  private fetchImpl: FetchLike
  private accessToken: string | null = null
  private session: Session | null = null
  private refreshing: Promise<string | null> | null = null
  private loadRefresh: () => string | null
  private saveRefresh: (token: string | null) => void
  private onSessionChange: (session: Session | null) => void

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? API_BASE_URL
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.loadRefresh = opts.loadRefresh ?? (() => {
      try {
        return localStorage.getItem(REFRESH_KEY)
      } catch {
        return null
      }
    })
    this.saveRefresh = opts.saveRefresh ?? ((token) => {
      try {
        if (token === null) localStorage.removeItem(REFRESH_KEY)
        else localStorage.setItem(REFRESH_KEY, token)
      } catch {
        // storage unavailable — session-only login
      }
    })
    this.onSessionChange = opts.onSessionChange ?? (() => {})
  }

  // ---- session ----

  get currentSession(): Session | null {
    return this.session
  }

  hasSession(): boolean {
    return this.session !== null
  }

  setSession(session: Session): void {
    this.session = session
    this.accessToken = session.access_token
    this.saveRefresh(session.refresh_token)
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } catch {
      // storage unavailable — session-only login
    }
    this.onSessionChange(session)
  }

  clearSession(): void {
    this.session = null
    this.accessToken = null
    this.saveRefresh(null)
    try {
      sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // ignore
    }
    this.onSessionChange(null)
  }

  /**
   * Restore a session: first from the per-tab cache (works while offline, until
   * the 15-min access token expires), then via the persisted refresh token.
   */
  async restoreSession(): Promise<Session | null> {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY)
      if (raw) {
        const session = JSON.parse(raw) as Session
        this.session = session
        this.accessToken = session.access_token
        this.onSessionChange(session)
        // If the access token has gone stale, the first authed call 401s and
        // triggers a refresh when the network is back.
        return session
      }
    } catch {
      // fall through to the refresh path
    }
    const refresh = this.loadRefresh()
    if (!refresh) return null
    try {
      const session = await this.request<Session>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refresh }),
      })
      this.setSession(session)
      return session
    } catch (err) {
      // A network failure keeps the token for a later retry; only a real
      // auth rejection (401/reuse) clears the session.
      if (err instanceof NetworkError) return null
      this.clearSession()
      return null
    }
  }

  // ---- auth ----

  async login(email: string, password: string): Promise<Session> {
    const session = await this.request<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    this.setSession(session)
    return session
  }

  async signup(input: { email: string; password: string; name: string; business_name: string }): Promise<Session> {
    const session = await this.request<Session>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    this.setSession(session)
    return session
  }

  async logout(): Promise<void> {
    const refresh = this.loadRefresh()
    if (refresh) {
      try {
        await this.request('/auth/logout', { method: 'POST', body: JSON.stringify({ refresh_token: refresh }) })
      } catch {
        // best effort — local session is cleared regardless
      }
    }
    this.clearSession()
  }

  async me(): Promise<Me> {
    return this.request<Me>('/me', { auth: true })
  }

  // ---- catalog ----

  async listItems(q = ''): Promise<ApiItem[]> {
    const res = await this.request<ApiList<ApiItem>>(`/items?q=${encodeURIComponent(q)}`, { auth: true })
    return res.data
  }

  async getItem(id: string): Promise<ApiItem> {
    return this.request<ApiItem>(`/items/${id}`, { auth: true })
  }

  async searchItems(q: string): Promise<ApiItem[]> {
    const res = await this.request<ApiList<ApiItem>>(`/items/search?q=${encodeURIComponent(q)}`, { auth: true })
    return res.data
  }

  async createItem(input: Record<string, unknown>): Promise<ApiItem> {
    return this.request<ApiItem>('/items', { method: 'POST', body: JSON.stringify(input), auth: true })
  }

  async updateItem(id: string, input: Record<string, unknown>): Promise<ApiItem> {
    return this.request<ApiItem>(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(input), auth: true })
  }

  // ---- stock ----

  async stockMove(input: Record<string, unknown>): Promise<ApiStockMove> {
    return this.request<ApiStockMove>('/stock-moves', { method: 'POST', body: JSON.stringify(input), auth: true })
  }

  async ledger(itemId: string, outletId: string): Promise<ApiLedger> {
    return this.request<ApiLedger>(`/items/${itemId}/ledger?outlet_id=${encodeURIComponent(outletId)}`, { auth: true })
  }

  // ---- sales ----

  async postSale(input: Record<string, unknown>): Promise<ApiSale> {
    return this.request<ApiSale>('/sales', { method: 'POST', body: JSON.stringify(input), auth: true })
  }

  async getSale(id: string): Promise<ApiSale> {
    return this.request<ApiSale>(`/sales/${encodeURIComponent(id)}`, { auth: true })
  }

  async listSales(from: string, to: string): Promise<ApiSale[]> {
    const res = await this.request<ApiList<ApiSale>>(`/sales?from=${from}&to=${to}`, { auth: true })
    return res.data
  }

  // ---- cash ----

  async listCashEntries(from: string, to: string): Promise<{ data: ApiCashEntry[]; totals: { in: number; out: number; net: number } }> {
    return this.request(`/cash-entries?from=${from}&to=${to}`, { auth: true })
  }

  async addCashEntry(input: Record<string, unknown>): Promise<ApiCashEntry> {
    return this.request<ApiCashEntry>('/cash-entries', { method: 'POST', body: JSON.stringify(input), auth: true })
  }

  async cashCategories(): Promise<ApiCashCategory[]> {
    const res = await this.request<ApiList<ApiCashCategory>>('/cash-categories', { auth: true })
    return res.data
  }

  // ---- reports ----

  async labaRugi(from: string, to: string): Promise<ApiLabaRugi> {
    return this.request<ApiLabaRugi>(`/reports/laba-rugi?from=${from}&to=${to}`, { auth: true })
  }

  async drill(line: string): Promise<ApiDrillRow[]> {
    const res = await this.request<ApiList<ApiDrillRow>>(`/reports/laba-rugi/drill?line=${encodeURIComponent(line)}`, { auth: true })
    return res.data
  }

  async stockReport(outletId: string): Promise<ApiStockReport> {
    return this.request<ApiStockReport>(`/reports/stock?outlet_id=${encodeURIComponent(outletId)}`, { auth: true })
  }

  async salesReport(from: string, to: string, groupBy: 'day' | 'item' | 'category'): Promise<ApiSalesReportRow[]> {
    const res = await this.request<ApiList<ApiSalesReportRow>>(
      `/reports/sales?from=${from}&to=${to}&group_by=${groupBy}`,
      { auth: true },
    )
    return res.data
  }

  async dashboard(outletId: string): Promise<ApiDashboard> {
    return this.request<ApiDashboard>(`/reports/dashboard?outlet_id=${encodeURIComponent(outletId)}`, { auth: true })
  }

  // ---- QRIS (Tier 0) ----

  async getQrisSettings(outletId: string): Promise<ApiQrisSettings> {
    return this.request<ApiQrisSettings>(`/outlets/${encodeURIComponent(outletId)}/qris`, { auth: true })
  }

  async putQrisSettings(outletId: string, input: Record<string, unknown>): Promise<ApiQrisSettings> {
    return this.request<ApiQrisSettings>(`/outlets/${encodeURIComponent(outletId)}/qris`, {
      method: 'PUT',
      body: JSON.stringify(input),
      auth: true,
    })
  }

  async qrisConfirm(saleId: string, input: { amount_gross: number; mdr_pct?: number; paid_at?: string }): Promise<ApiQrisConfirm> {
    return this.request<ApiQrisConfirm>(`/sales/${encodeURIComponent(saleId)}/qris/confirm`, {
      method: 'POST',
      body: JSON.stringify(input),
      auth: true,
    })
  }

  // ---- opname ----

  async createOpname(input: { outlet_id: string; category_id?: string | null; item_ids?: string[] }): Promise<ApiOpnameSession> {
    return this.request<ApiOpnameSession>('/opname', { method: 'POST', body: JSON.stringify(input), auth: true })
  }

  /**
   * Download an export (CSV/HTML/ZIP). Returns the raw Response so the caller
   * can stream it to a download; NOT buffered row-by-row on the client.
   * Throws ApiError with the server's Indonesian message on failure.
   */
  async exportFile(path: string): Promise<Response> {
    if (!this.accessToken) await this.tryRefresh()
    const headers: Record<string, string> = {}
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, { headers })
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : 'network')
    }
    if (!response.ok) {
      let code = 'internal'
      let message = `HTTP ${response.status}`
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } }
        code = body.error?.code ?? code
        message = body.error?.message ?? message
      } catch {
        // non-JSON body
      }
      throw new ApiError(response.status, code, message)
    }
    return response
  }

  // ---- sync (T-302/T-303 wire contract, docs/SYNC_INCREMENT.md) ----

  async syncPush(input: {
    device_id: string
    ops: { op_id: string; type: string; payload: Record<string, unknown>; client_ts: string }[]
  }): Promise<{ results: { op_id: string; status: 'applied' | 'duplicate' | 'rejected'; reason: string | null }[]; cursor: number }> {
    return this.request('/sync/push', { method: 'POST', body: JSON.stringify(input), auth: true })
  }

  async syncPull(cursor: number, limit = 500): Promise<{
    changes: { table: string; row: Record<string, unknown>; server_seq: number; deleted: boolean }[]
    cursor: number
    has_more: boolean
  }> {
    return this.request(`/sync/pull?cursor=${cursor}&limit=${limit}`, { auth: true })
  }

  async getOpname(id: string): Promise<ApiOpnameSession> {
    return this.request<ApiOpnameSession>(`/opname/${encodeURIComponent(id)}`, { auth: true })
  }

  async patchOpnameLines(id: string, lines: { item_id: string; counted_qty: number }[]): Promise<ApiOpnameSession> {
    return this.request<ApiOpnameSession>(`/opname/${encodeURIComponent(id)}/lines`, {
      method: 'PATCH',
      body: JSON.stringify({ lines }),
      auth: true,
    })
  }

  async postOpname(id: string): Promise<{ posted: boolean; adjustments: unknown[] }> {
    return this.request(`/opname/${encodeURIComponent(id)}/post`, { method: 'POST', body: '{}', auth: true })
  }

  // ---- core ----

  private async request<T>(
    path: string,
    init: { method?: string; body?: string; auth?: boolean } = {},
  ): Promise<T> {
    return this.rawRequest<T>(path, init)
  }

  private async rawRequest<T>(
    path: string,
    init: { method?: string; body?: string; auth?: boolean },
    isRetry = false,
  ): Promise<T> {
    if (init.auth && !this.accessToken && !isRetry) {
      await this.tryRefresh()
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
      })
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : 'network')
    }
    if (response.status === 401 && !isRetry && init.auth) {
      const token = await this.tryRefresh()
      if (token) {
        return this.rawRequest<T>(path, init, true)
      }
    }
    if (!response.ok) {
      let code = 'internal'
      let message = `HTTP ${response.status}`
      let fields: Record<string, string> | undefined
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string; fields?: Record<string, string> } }
        code = body.error?.code ?? code
        message = body.error?.message ?? message
        fields = body.error?.fields
      } catch {
        // non-JSON body
      }
      throw new ApiError(response.status, code, message, fields)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /** Refresh the access token once; concurrent callers share one request. Returns null on failure. */
  private tryRefresh(): Promise<string | null> {
    if (this.refreshing) return this.refreshing
    const refresh = this.loadRefresh()
    if (!refresh) return Promise.resolve(null)
    this.refreshing = (async () => {
      try {
        const session = await this.request<Session>('/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refresh }),
        })
        this.setSession(session)
        return session.access_token
      } catch (err) {
        if (err instanceof NetworkError) {
          // offline: keep everything; a later call retries
          return null
        }
        this.clearSession()
        return null
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }
}
