import { Navigate, Outlet, NavLink } from 'react-router'
import { useAppState } from './state/AppState'
import { useI18n } from './i18n/I18nProvider'
import { SyncDot, Loading, ErrorView } from './components/state'
import type { ReactNode } from 'react'

const NAV_ITEMS: {
  to: string
  key: 'nav.items' | 'nav.sell' | 'nav.cash' | 'nav.reports'
  icon: string
  primary: boolean
}[] = [
  { to: '/barang', key: 'nav.items', icon: '📦', primary: false },
  { to: '/jual', key: 'nav.sell', icon: '🛒', primary: true },
  { to: '/kas', key: 'nav.cash', icon: '💵', primary: false },
  { to: '/laporan', key: 'nav.reports', icon: '📈', primary: false },
]

export function AppShell(): ReactNode {
  const { tenant, pendingOps, online, ready, openError, onboarded } = useAppState()
  const { t } = useI18n()

  if (!ready) {
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
  if (!onboarded) {
    return <Navigate to="/onboarding" replace />
  }

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
        {NAV_ITEMS.filter((i) => !i.primary).map((item) => (
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
          <br />
          <SyncDot pending={pendingOps > 0} offline={!online} />
        </div>
      </nav>

      <div className="app-main">
        <header className="app-header">
          <div className="app-header__brand">
            <span className="app-header__title">Stokku</span>
            <span className="app-header__subtitle">{tenant?.name ?? ''}</span>
          </div>
          <div className="app-header__spacer" />
          <LanguageSwitch />
          <SyncDot pending={pendingOps > 0} offline={!online} />
        </header>
        <main className="app-content">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label={t('app.name')}>
        {NAV_ITEMS.map((item) => (
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

/** Entry route: waits for the store, then routes to onboarding or the default screen. */
export function RootRedirect(): ReactNode {
  const { ready, onboarded } = useAppState()
  if (!ready) return <Loading />
  return <Navigate to={onboarded ? '/barang' : '/onboarding'} replace />
}
