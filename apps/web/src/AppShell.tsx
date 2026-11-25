import { Navigate, Outlet, NavLink } from 'react-router'
import { useAppState } from './state/AppState'
import { useAuth, useCapabilities } from './state/AuthState'
import { useI18n } from './i18n/I18nProvider'
import { SyncDot, Loading, ErrorView } from './components/state'
import { Button } from './components/primitives'
import type { ReactNode } from 'react'

export function AppShell(): ReactNode {
  const { tenant, pendingOps, online, ready, openError, onboarded, statusLoaded, apiMode } = useAppState()
  const { session, logout } = useAuth()
  const { role } = useCapabilities()
  const { t } = useI18n()

  if (!ready || !statusLoaded) {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Loading />
      </div>
    )
  }
  if (openError) {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)' }}>
        <ErrorView message={openError} />
      </div>
    )
  }
  // In API mode the server session replaces onboarding; wait for the bind instead of bouncing.
  if (!onboarded && !session) {
    return <Navigate to="/login" replace />
  }
  if (!onboarded && session) {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Loading />
      </div>
    )
  }

  const navItems: {
    to: string
    key: 'nav.items' | 'nav.sell' | 'nav.cash' | 'nav.reports' | 'nav.sales'
    icon: string
    primary: boolean
  }[] = [
    { to: '/barang', key: 'nav.items', icon: '📦', primary: false },
    { to: '/jual', key: 'nav.sell', icon: '🛒', primary: true },
    { to: '/kas', key: 'nav.cash', icon: '💵', primary: false },
    { to: '/penjualan', key: 'nav.sales', icon: '🧾', primary: false },
    // Staff must not be offered reports (the API 403s them anyway).
    ...(role === 'owner' ? [{ to: '/laporan', key: 'nav.reports' as const, icon: '📈', primary: false }] : []),
  ]

  return (
    <div className="app">
      <nav className="sidebar" aria-label={t('app.name')}>
        <div className="sidebar__brand">Stokku</div>
        <NavLink to="/jual" className="sidebar__link sidebar__link--primary">
          <span className="bottom-nav__icon" aria-hidden="true">
            🛒
          </span>
          {t('nav.sell')}
        </NavLink>
        {navItems
          .filter((i) => !i.primary)
          .map((item) => (
            <NavLink key={item.to} to={item.to} className="sidebar__link">
              <span className="bottom-nav__icon" aria-hidden="true">
                {item.icon}
              </span>
              {t(item.key)}
            </NavLink>
          ))}
        <NavLink to="/dev" className="sidebar__link">
          <span className="bottom-nav__icon" aria-hidden="true">
            🧪
          </span>
          {t('nav.dev')}
        </NavLink>
        <div className="sidebar__footer">
          {tenant?.name}
          {role === 'staff' ? ' · ' + t('auth.roleStaff') : ''}
          <br />
          <SyncDot pending={pendingOps > 0} offline={!online} synced={apiMode && pendingOps === 0} />
          {session ? (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Button variant="secondary" size="sm" onClick={() => void logout().then(() => location.assign('/login'))}>
                {t('auth.logout')}
              </Button>
            </div>
          ) : (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <NavLink to="/login" className="sidebar__link" style={{ minHeight: 36 }}>
                {t('auth.login')}
              </NavLink>
            </div>
          )}
        </div>
      </nav>

      <div className="app-main">
        <header className="app-header">
          <div className="app-header__brand">
            <span className="app-header__title">Stokku</span>
            <span className="app-header__subtitle">
              {tenant?.name ?? ''}
              {role === 'staff' ? ` · ${t('auth.roleStaff')}` : ''}
            </span>
          </div>
          <div className="app-header__spacer" />
          <LanguageSwitch />
          <SyncDot pending={pendingOps > 0} offline={!online} synced={apiMode && pendingOps === 0} />
          {session ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void logout().then(() => location.assign('/login'))}
              aria-label={t('auth.logout')}
            >
              ⏏
            </Button>
          ) : (
            <NavLink to="/login" className="btn btn--secondary btn--sm">
              {t('auth.login')}
            </NavLink>
          )}
        </header>
        <main className="app-content">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label={t('app.name')}>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={`bottom-nav__item${item.primary ? ' bottom-nav__item--primary' : ''}`}
          >
            <span className="bottom-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{t(item.key)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function LanguageSwitch(): ReactNode {
  const { locale, setLocale } = useI18n()
  return (
    <select
      className="input"
      style={{ minHeight: '36px', width: 'auto', padding: '2px 6px', fontSize: 'var(--text-sm)' }}
      value={locale}
      aria-label="Language"
      onChange={(e) => setLocale(e.target.value as 'id' | 'en')}
    >
      <option value="id">ID</option>
      <option value="en">EN</option>
    </select>
  )
}

/** Entry route: waits for the store + auth, then routes to login or the default screen. */
export function RootRedirect(): ReactNode {
  const { ready, onboarded } = useAppState()
  const { session, booting } = useAuth()
  if (!ready || booting) return <Loading />
  if (session) return <Navigate to="/barang" replace />
  return <Navigate to={onboarded ? '/barang' : '/login'} replace />
}
