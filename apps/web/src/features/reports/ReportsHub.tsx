import { Link, Navigate } from 'react-router'
import { useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import type { ReactNode } from 'react'

/** Laporan hub: entry cards for the four report screens (owner only — staff get nothing to click). */
export function ReportsHub(): ReactNode {
  const { role } = useCapabilities()
  const { t } = useI18n()

  if (role === 'staff') return <Navigate to="/barang" replace />

  const cards = [
    { to: '/laporan/laba-rugi', icon: '📈', title: t('reports.title'), sub: t('reports.hubLaba') },
    { to: '/laporan/stok', icon: '📦', title: t('stockReport.title'), sub: t('stockReport.subtitle') },
    { to: '/laporan/penjualan', icon: '🧾', title: t('salesReport.title'), sub: t('salesReport.subtitle') },
    { to: '/laporan/ringkasan', icon: '🏠', title: t('dashboard.title'), sub: t('dashboard.subtitle') },
    // owner-only export section (F25); staff never see the card
    { to: '/laporan/unduh', icon: '⬇️', title: t('export.title'), sub: t('export.subtitle') },
  ]

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('nav.reports')}</h1>
      </div>
      <div className="card-list">
        {cards.map((c) => (
          <Link key={c.to} to={c.to} className="card-row" style={{ textDecoration: 'none' }}>
            <span className="bottom-nav__icon" aria-hidden="true" style={{ fontSize: '1.6rem' }}>
              {c.icon}
            </span>
            <div className="card-row__main">
              <span className="card-row__title">{c.title}</span>
              <span className="card-row__sub">{c.sub}</span>
            </div>
            <span className="muted" aria-hidden="true">
              ›
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
