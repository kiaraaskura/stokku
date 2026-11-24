/**
 * Screen-level gateway helpers: read-through (API when online, cache/local
 * otherwise) and remote-first writes with optimistic local fallback.
 * Components never call fetch — they compose these with the ApiClient.
 */
import { NetworkError } from './types'

export interface RemoteOptions {
  online: boolean
  session: boolean
}

/** Read through the API; on network failure fall back to the local/cache read. */
export async function readThrough<T>(opts: RemoteOptions & {
  remote: () => Promise<T>
  cacheWrite?: (data: T) => Promise<void> | void
  local: () => Promise<T> | T
}): Promise<{ data: T; source: 'server' | 'local' }> {
  if (opts.online && opts.session) {
    try {
      const data = await opts.remote()
      await opts.cacheWrite?.(data)
      return { data, source: 'server' }
    } catch (err) {
      if (!(err instanceof NetworkError)) {
        // 4xx/5xx from the server: show local data rather than a blank screen
        return { data: await opts.local(), source: 'local' }
      }
    }
  }
  return { data: await opts.local(), source: 'local' }
}

/**
 * Remote-first write: post to the API and apply the returned row; when the
 * network is down, write locally and queue the op (optimistic, as before).
 * ApiError (validation) is rethrown — invalid data must not be queued.
 */
export async function remoteOrLocal<TServer, TLocal>(opts: RemoteOptions & {
  remote: () => Promise<TServer>
  onRemoteSuccess: (row: TServer) => Promise<void> | void
  local: () => Promise<TLocal>
}): Promise<{ source: 'server' | 'local'; value: TServer | TLocal }> {
  if (opts.online && opts.session) {
    try {
      const row = await opts.remote()
      await opts.onRemoteSuccess(row)
      return { source: 'server', value: row }
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err
      // fall through to the optimistic local write
    }
  }
  const value = await opts.local()
  return { source: 'local', value }
}

/** Map a wire item row to the local Item shape used by the cart UI. */
export function wireItemToLocal(apiItem: {
  id: string
  sku: string | null
  name: string
  base_unit: string
  sale_price: number
  cost_avg?: number
  min_stock: number
  stock: number
  active: boolean
  updated_at?: string
}) {
  return {
    id: apiItem.id,
    sku: apiItem.sku ?? null,
    name: apiItem.name,
    categoryId: null,
    baseUnit: apiItem.base_unit,
    salePrice: apiItem.sale_price,
    costAvg: apiItem.cost_avg ?? 0,
    minStockM: Math.round((apiItem.min_stock ?? 0) * 1000),
    active: apiItem.active,
    stockM: Math.round((apiItem.stock ?? 0) * 1000),
    lowStock: (apiItem.min_stock ?? 0) > 0 && (apiItem.stock ?? 0) <= (apiItem.min_stock ?? 0),
    updatedAt: apiItem.updated_at ?? new Date().toISOString(),
  }
}
