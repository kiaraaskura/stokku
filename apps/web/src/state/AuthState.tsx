import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiClient } from '../api/client'
import type { Me, Session } from '../api/types'

interface AuthContextValue {
  api: ApiClient
  session: Session | null
  me: Me | null
  booting: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (input: { email: string; password: string; name: string; business_name: string }) => Promise<void>
  logout: () => Promise<void>
  refreshMe: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [booting, setBooting] = useState(true)
  const apiRef = useRef<ApiClient | null>(null)

  if (!apiRef.current) {
    apiRef.current = new ApiClient({
      onSessionChange: (s) => {
        setSession(s)
        if (s === null) setMe(null)
      },
    })
  }
  const api = apiRef.current

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const restored = await api.restoreSession()
      if (cancelled) return
      if (restored) {
        try {
          setMe(await api.me())
        } catch {
          // session expired between restore and /me
        }
      }
      setBooting(false)
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  const refreshMe = async () => {
    if (!api.hasSession()) return
    try {
      setMe(await api.me())
    } catch {
      // network hiccup — keep the last known capabilities
    }
  }

  const login = async (email: string, password: string) => {
    await api.login(email, password)
    setMe(await api.me())
  }

  const signup = async (input: { email: string; password: string; name: string; business_name: string }) => {
    await api.signup(input)
    setMe(await api.me())
  }

  const logout = async () => {
    await api.logout()
    setMe(null)
  }

  const value = useMemo<AuthContextValue>(
    () => ({ api, session, me, booting, login, signup, logout, refreshMe }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, session, me, booting],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/** Role helpers: the UI must not offer what the role cannot do (staff: no cost, no reports). */
export function useCapabilities(): { role: 'owner' | 'staff' | null; can: (cap: string) => boolean } {
  const { session, me } = useAuth()
  const role = me?.role ?? session?.role ?? null
  const caps = me?.capabilities ?? null
  return {
    role,
    can: (cap: string) => (caps ? caps.includes(cap) : role === 'owner'),
  }
}
