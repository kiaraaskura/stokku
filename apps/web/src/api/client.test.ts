import { describe, expect, it } from 'vitest'
import { ApiClient } from './client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const session = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 900,
  user: { id: 'u1', name: 'Toko', email: 't@t.test' },
  tenant: { id: 'ten1', name: 'Toko', tax_rate: 0 },
  outlet: { id: 'out1', name: 'Toko', timezone: 'Asia/Jakarta' },
  role: 'owner' as const,
})

/** In-memory refresh-token store (browsers use localStorage). */
function memoryStore() {
  let token: string | null = null
  return {
    loadRefresh: () => token,
    saveRefresh: (t: string | null) => {
      token = t
    },
  }
}

describe('ApiClient 401 -> refresh once -> retry', () => {
  it('refreshes the token once and retries the original request', async () => {
    const calls: string[] = []
    let refreshed = 0
    const api = new ApiClient({
      baseUrl: 'http://test',
      ...memoryStore(),
      fetchImpl: async (input, init) => {
        const url = String(input)
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? ''
        calls.push(`${init?.method ?? 'GET'} ${url} ${auth}`)
        if (url.endsWith('/v1/auth/login')) return jsonResponse(200, session(1))
        if (url.endsWith('/v1/auth/refresh')) {
          refreshed += 1
          return jsonResponse(200, session(2))
        }
        if (url.includes('/v1/items')) {
          if (auth === 'Bearer access-2') return jsonResponse(200, { data: [{ id: 'i1', name: 'Gula' }], next_cursor: null })
          return jsonResponse(401, { error: { code: 'unauthorized', message: 'kadaluarsa' } })
        }
        return jsonResponse(404, {})
      },
    })
    await api.login('t@t.test', 'password123')
    const items = await api.listItems()
    expect(items).toEqual([{ id: 'i1', name: 'Gula' }])
    expect(refreshed).toBe(1)
    // exactly one refresh call, and the retry carried the new token
    expect(calls.filter((c) => c.includes('/v1/auth/refresh'))).toHaveLength(1)
    expect(calls.some((c) => c.startsWith('GET http://test/v1/items') && c.endsWith('Bearer access-2'))).toBe(true)
  })

  it('concurrent 401s share a single refresh', async () => {
    let refreshCalls = 0
    const api = new ApiClient({
      baseUrl: 'http://test',
      ...memoryStore(),
      fetchImpl: async (input, init) => {
        const url = String(input)
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? ''
        if (url.endsWith('/v1/auth/login')) return jsonResponse(200, session(1))
        if (url.endsWith('/v1/auth/refresh')) {
          refreshCalls += 1
          await new Promise((r) => setTimeout(r, 10))
          return jsonResponse(200, session(2))
        }
        if (auth === 'Bearer access-2') return jsonResponse(200, { data: [], next_cursor: null })
        return jsonResponse(401, { error: { code: 'unauthorized', message: 'kadaluarsa' } })
      },
    })
    await api.login('t@t.test', 'password123')
    const [a, b] = await Promise.all([api.listItems(), api.listItems()])
    expect(a).toEqual([])
    expect(b).toEqual([])
    expect(refreshCalls).toBe(1)
  })

  it('clears the session and throws when the refresh fails', async () => {
    const api = new ApiClient({
      baseUrl: 'http://test',
      ...memoryStore(),
      fetchImpl: async (input, init) => {
        const url = String(input)
        const auth = (init?.headers as Record<string, string>)?.Authorization ?? ''
        if (url.endsWith('/v1/auth/login')) return jsonResponse(200, session(1))
        if (url.endsWith('/v1/auth/refresh')) return jsonResponse(401, { error: { code: 'unauthorized', message: 'reuse' } })
        if (auth === 'Bearer access-1') return jsonResponse(401, { error: { code: 'unauthorized', message: 'kadaluarsa' } })
        return jsonResponse(500, {})
      },
    })
    await api.login('t@t.test', 'password123')
    await expect(api.listItems()).rejects.toThrow()
    expect(api.hasSession()).toBe(false)
    expect(api.currentSession).toBeNull()
  })
})
