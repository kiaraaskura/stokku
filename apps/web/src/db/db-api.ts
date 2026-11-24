/**
 * Minimal database interface implemented by sql.js (in tests and the
 * no-OPFS fallback) and by the OPFS-backed worker. The repository logic
 * only ever sees this interface.
 */
import type initSqlJs from 'sql.js'

export type DbParam = initSqlJs.SqlValue

export interface Db {
  run(sql: string, params?: DbParam[]): void
  get<T>(sql: string, params?: DbParam[]): T | undefined
  all<T>(sql: string, params?: DbParam[]): T[]
  exec(sql: string): void
  transaction<T>(fn: () => T): T
}

/** Wrap a sql.js Database into the Db interface. */
export function makeDbAdapter(sqlDb: initSqlJs.Database): Db {
  let depth = 0
  return {
    run(sql, params) {
      sqlDb.run(sql, params)
    },
    exec(sql) {
      sqlDb.exec(sql)
    },
    get<T>(sql: string, params?: DbParam[]): T | undefined {
      const stmt = sqlDb.prepare(sql)
      try {
        if (params) stmt.bind(params)
        if (stmt.step()) return stmt.getAsObject() as unknown as T
        return undefined
      } finally {
        stmt.free()
      }
    },
    all<T>(sql: string, params?: DbParam[]): T[] {
      const stmt = sqlDb.prepare(sql)
      try {
        if (params) stmt.bind(params)
        const rows: T[] = []
        while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T)
        return rows
      } finally {
        stmt.free()
      }
    },
    transaction<T>(fn: () => T): T {
      depth += 1
      const savepoint = `tx_${depth}`
      sqlDb.run(`SAVEPOINT ${savepoint}`)
      try {
        const result = fn()
        sqlDb.run(`RELEASE ${savepoint}`)
        return result
      } catch (err) {
        sqlDb.run(`ROLLBACK TO ${savepoint}`)
        sqlDb.run(`RELEASE ${savepoint}`)
        throw err
      } finally {
        depth -= 1
      }
    },
  }
}
