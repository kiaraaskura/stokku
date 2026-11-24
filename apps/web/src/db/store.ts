/**
 * Repository access from the UI (T-202): the UI never touches SQL or the
 * network directly — only this async Repository interface. MVP implementation
 * is local SQLite (worker + OPFS), with an in-memory fallback so the app still
 * runs where OPFS is unavailable.
 */
import { repoMethods, type RepoMethodArgs, type RepoMethodResult, type RepoMethodName } from './repo'
import type { Db } from './db-api'
import { makeDbAdapter } from './db-api'
import { migrate } from './schema'

export interface Repository {
  readonly persisted: boolean
  call<M extends RepoMethodName>(method: M, ...args: RepoMethodArgs<M>): Promise<RepoMethodResult<M>>
}

type Reply = { kind: 'reply'; id: number; ok: true; result: unknown } | { kind: 'reply'; id: number; ok: false; error: string }

class WorkerRepository implements Repository {
  readonly persisted: boolean
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private worker: Worker

  constructor(worker: Worker, persisted: boolean) {
    this.worker = worker
    this.persisted = persisted
    worker.onmessage = (ev: MessageEvent<Reply>) => {
      const msg = ev.data
      if (msg?.kind !== 'reply') return
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.ok) entry.resolve(msg.result)
      else entry.reject(new Error(msg.error))
    }
  }

  call<M extends RepoMethodName>(method: M, ...args: RepoMethodArgs<M>): Promise<RepoMethodResult<M>> {
    return new Promise<RepoMethodResult<M>>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ kind: 'call', id, method, args })
    })
  }
}

class MemoryRepository implements Repository {
  readonly persisted = false
  private db: Db

  constructor(db: Db) {
    this.db = db
  }

  async call<M extends RepoMethodName>(method: M, ...args: RepoMethodArgs<M>): Promise<RepoMethodResult<M>> {
    const fn = repoMethods[method] as (...fnArgs: unknown[]) => unknown
    return fn(this.db, ...args) as RepoMethodResult<M>
  }
}

/** Open the best available local repository. Resolves within `timeoutMs` or falls back. */
export async function openRepository(timeoutMs = 8000): Promise<Repository> {
  try {
    const worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' })
    const ready = await new Promise<{ persisted: boolean } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      worker.onmessage = (ev: MessageEvent) => {
        if (ev.data?.kind === 'ready') {
          clearTimeout(timer)
          resolve({ persisted: Boolean(ev.data.persisted) })
        }
      }
      worker.onerror = () => {
        clearTimeout(timer)
        resolve(null)
      }
    })
    if (ready) {
      return new WorkerRepository(worker, ready.persisted)
    }
    worker.terminate()
  } catch {
    // fall through to memory
  }
  const initSqlJs = (await import('sql.js')).default
  const wasmUrl = (await import('sql.js/dist/sql-wasm.wasm?url')).default
  const SQL = await initSqlJs({ locateFile: () => wasmUrl, useOldExtensionFunctions: true })
  const db = makeDbAdapter(new SQL.Database())
  migrate(db)
  return new MemoryRepository(db)
}
