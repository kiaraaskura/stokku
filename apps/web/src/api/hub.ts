/**
 * Runtime resolution of the sync hub (API) base URL.
 *
 * The web build has no API URL compiled in that works for a phone: the default
 * `http://localhost:8099` only works on the machine running the hub. A phone
 * must be able to point at the desktop that holds the data — typically by
 * opening a pairing URL/QR such as `https://192.168.1.20:8443/?api=https://192.168.1.20:8443`.
 *
 * Precedence: `?api=` page parameter (remembered) > saved hub URL > build
 * default (VITE_API_URL, else localhost:8099).
 *
 * Pure and dependency-free so it is unit-testable in node; the browser glue
 * (localStorage, history cleanup) lives in client.ts.
 */

export const HUB_URL_STORAGE_KEY = 'stokku.api_url'
export const HUB_URL_PARAM = 'api'

/** Accepts a bare origin or base URL; returns a normalized base without /v1 or trailing slash, or null if invalid. */
export function normalizeHubUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '' ) return null
  // The client appends the /v1 prefix itself, so accept and strip it if present.
  url.pathname = url.pathname.replace(/\/v1\/?$/, '/')
  url.search = ''
  url.hash = ''
  let out = url.toString()
  if (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

export type HubSource = 'query' | 'stored' | 'default'

export interface HubResolution {
  url: string
  source: HubSource
}

/** Pick the hub URL: a valid `?api=` param wins and must be persisted; then a valid stored URL; then the build default. */
export function pickHubUrl(args: {
  pageUrl?: string | null
  storedUrl?: string | null
  buildDefault: string
}): HubResolution {
  if (args.pageUrl) {
    try {
      const page = new URL(args.pageUrl)
      const fromQuery = page.searchParams.get(HUB_URL_PARAM)
      if (fromQuery) {
        const normalized = normalizeHubUrl(fromQuery)
        if (normalized) return { url: normalized, source: 'query' }
      }
    } catch {
      /* unparsable page URL — fall through */
    }
  }
  if (args.storedUrl) {
    const normalized = normalizeHubUrl(args.storedUrl)
    if (normalized) return { url: normalized, source: 'stored' }
  }
  return { url: args.buildDefault, source: 'default' }
}
