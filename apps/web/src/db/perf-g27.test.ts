import { beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { makeDbAdapter, type Db } from './db-api'
import { resetAll, seedItemsBulk, listItems, searchItems } from './repo'

let db: Db

beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => wasmPath, useOldExtensionFunctions: true })
  db = makeDbAdapter(new SQL.Database())
  resetAll(db)
  // an onboarding row so listItems has a tenant/outlet to key stock against
  const { completeOnboarding } = await import('./repo')
  completeOnboarding(db, { businessName: 'Warung G27', businessType: 'kelontong', taxRatePercent: 0, opening: null })
  seedItemsBulk(db, 5000)
})

/**
 * G27 (ACCEPTANCE.md line 27): with 5.000 items, local search returns in
 * < 100 ms. The bound asserted here is the acceptance number; the measured
 * figure on this machine is reported by the channel (usually single-digit ms
 * on in-memory sql.js; OPFS-backed runs are the same engine).
 */
describe('G27: 5.000-item local search', () => {
  it('seeds exactly 5.000 items', () => {
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM item')!.n).toBe(5000)
  })

  it('a search query returns in well under 100 ms', () => {
    const t0 = performance.now()
    const rows = listItems(db, 'sembako')
    const elapsed = performance.now() - t0
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(5000)
    expect(elapsed).toBeLessThan(100)
  })

  it('an empty query lists all 5.000 in under 100 ms', () => {
    const t0 = performance.now()
    const rows = listItems(db, '')
    const elapsed = performance.now() - t0
    expect(rows.length).toBe(5000)
    expect(elapsed).toBeLessThan(100)
  })

  it('the cart typeahead path is equally fast and bounded to 10 rows', () => {
    const t0 = performance.now()
    const rows = searchItems(db, 'Nomor 499')
    const elapsed = performance.now() - t0
    expect(rows.length).toBeLessThanOrEqual(10)
    expect(elapsed).toBeLessThan(100)
  })
})
