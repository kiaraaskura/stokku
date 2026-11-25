import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { openRepository, type Repository } from '../db/store'
import type { Outlet, Tenant } from '../db/types'
import { useAuth } from './AuthState'
import { flushOutbox } from '../sync/flush'

interface AppStateValue {
  ready: boolean
  statusLoaded: boolean
  /** Bumped after a flush applied server rows, so screens re-read the store. */
  dataTick: number
  repo: Repository | null
  persisted: boolean
  openError: string | null
  onboarded: boolean
  tenant: Tenant | null
  outlet: Outlet | null
  pendingOps: number
  online: boolean
  /** True when operating against the API with a confirmed session. */
  apiMode: boolean
  flushAgain: () => void
  refresh: () => Promise<void>
  toast: (message: string) => void
  toastMessage: string | null
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { api, session } = useAuth()
  const [repo, setRepo] = useState<Repository | null>(null)
  const [persisted, setPersisted] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [status, setStatus] = useState<{
    onboarded: boolean
    tenant: Tenant | null
    outlet: Outlet | null
    pendingOps: number
  }>({ onboarded: false, tenant: null, outlet: null, pendingOps: 0 })
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [dataTick, setDataTick] = useState(0)
  const toastTimer = useRef<number | null>(null)
  const flushing = useRef(false)
  const [flushTick, setFlushTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    openRepository()
      .then((r) => {
        if (cancelled) return
        setRepo(r)
        setPersisted(r.persisted)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setOpenError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!repo) return
    try {
      const [onboarded, tenant, outlet, pendingOps] = await Promise.all([
        repo.call('isOnboarded'),
        repo.call('getTenant'),
        repo.call('getOutlet'),
        repo.call('pendingOutboxCount'),
      ])
      setStatus({ onboarded, tenant, outlet, pendingOps })
      setStatusLoaded(true)
    } catch {
      // keep the last good status; screens surface their own errors
    }
  }, [repo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Bind the local store to the server identity whenever a session appears.
  useEffect(() => {
    if (!repo || !session) return
    void (async () => {
      try {
        await repo.call('setServerSession', session.tenant, session.outlet)
        await refresh()
      } catch {
        // surfaced by the next read
      }
    })()
  }, [repo, session, refresh])

  // On logout, wipe the cached tenant data so a different account starts clean.
  useEffect(() => {
    if (!repo) return
    void (async () => {
      if (!api.hasSession()) {
        const wasApiMode = (await repo.call('getServerCache', 'api:had-session') as { payload: unknown } | null)?.payload === true
        if (wasApiMode) {
          await repo.call('resetAll')
          await refresh()
        }
      }
    })()
  }, [repo, api, refresh])

  useEffect(() => {
    if (session) {
      void repo?.call('setServerCache', 'api:had-session', true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.tenant.id])

  // Network state.
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // Flush the outbox: on demand, when the session appears, when back online, every 20 s.
  const runFlush = useCallback(async () => {
    if (!repo || flushing.current) return
    flushing.current = true
    try {
      const result = await flushOutbox(repo, api, online)
      await refresh()
      if (result.posted > 0) {
        // queued writes became server rows — screens must re-read the store
        setDataTick((t) => t + 1)
      }
    } finally {
      flushing.current = false
    }
  }, [repo, api, online, refresh])

  useEffect(() => {
    void runFlush()
  }, [runFlush, session?.tenant.id, online, flushTick])

  useEffect(() => {
    const timer = window.setInterval(() => setFlushTick((t) => t + 1), 20000)
    return () => window.clearInterval(timer)
  }, [])

  const flushAgain = useCallback(() => {
    setFlushTick((t) => t + 1)
  }, [])

  const toast = useCallback((message: string) => {
    setToastMessage(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMessage(null), 2600)
  }, [])

  const value = useMemo<AppStateValue>(
    () => ({
      ready: repo !== null || openError !== null,
      statusLoaded,
      dataTick,
      repo,
      persisted,
      openError,
      onboarded: status.onboarded,
      tenant: status.tenant,
      outlet: status.outlet,
      pendingOps: status.pendingOps,
      online,
      apiMode: session !== null,
      flushAgain,
      refresh,
      toast,
      toastMessage,
    }),
    [repo, statusLoaded, status, persisted, openError, online, session, dataTick, flushAgain, refresh, toast, toastMessage],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
