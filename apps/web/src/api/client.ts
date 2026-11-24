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
  type ApiSale,
  type ApiStockMove,
  type Me,
  type Session,
} from './types'

export const API_BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8099'

const REFRESH_KEY = 'stokku.refresh_token'

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
    this.onSessionChange(session)
  }

  clearSession(): void {
    this.session = null
    this.accessToken = null
    this.saveRefresh(null)
    this.onSessionChange(null)
  }

  /** Restore a session from the persisted refresh token. Returns null when unavailable. */
  async restoreSession(): Promise<Session | null> {
    const refresh = this.loadRefresh()
    if (!refresh) return null
    try {
      const session = await this.request<Session>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refresh }),
      })
      this.setSession(session)
      return session
    } catch {
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
      } catch {
        this.clearSession()
        return null
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }
}
