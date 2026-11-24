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

interface AppStateValue {
  ready: boolean
  statusLoaded: boolean
  repo: Repository | null
  persisted: boolean
  openError: string | null
  onboarded: boolean
  tenant: Tenant | null
  outlet: Outlet | null
  pendingOps: number
  online: boolean
  refresh: () => Promise<void>
  toast: (message: string) => void
  toastMessage: string | null
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
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
  const toastTimer = useRef<number | null>(null)

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

  const toast = useCallback((message: string) => {
    setToastMessage(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMessage(null), 2600)
  }, [])

  const value = useMemo<AppStateValue>(
    () => ({
      ready: repo !== null || openError !== null,
      statusLoaded,
      repo,
      persisted,
      openError,
      onboarded: status.onboarded,
      tenant: status.tenant,
      outlet: status.outlet,
      pendingOps: status.pendingOps,
      online,
      refresh,
      toast,
      toastMessage,
    }),
    [repo, statusLoaded, status, persisted, openError, online, refresh, toast, toastMessage],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
