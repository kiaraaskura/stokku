import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Empty, Loading } from '../../components/state'
import { formatIDR } from '../../lib/money'
import type { ApiDashboard } from '../../api/types'

/** Dashboard (T-405): today's sales, cash position, low stock, month profit, from GET /reports/dashboard. */
export function Dashboard(): React.ReactNode {
  const { repo, outlet, online, apiMode, dataTick } = useAppState()
  const { api } = useAuth()
  const { role } = useCapabilities()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [data, setData] = useState<ApiDashboard | null>(null)
  const [source, setSource] = useState<'server' | 'local'>('local')

  useEffect(() => {
    if (!repo || !outlet || role === 'staff') return
    const cacheKey = `report:dashboard:${outlet.id}`
    const localRead = (): Promise<ApiDashboard | null> =>
      repo.call('getServerCache', cacheKey).then((c) => (c ? (c.payload as ApiDashboard) : null))
    if (online && apiMode) {
      api
        .dashboard(outlet.id)
        .then(async (d) => {
          await repo.call('setServerCache', cacheKey, d)
          setData(d)
          setSource('server')
        })
        .catch(() => {
          void localRead().then((d) => {
            setData(d)
            setSource('local')
          })
        })
    } else {
      void localRead().then((d) => {
        setData(d)
        setSource('local')
      })
    }
  }, [repo, api, outlet, online, apiMode, dataTick, role])

  if (role === 'staff') {
    return (
      <div className="screen">
        <Empty icon="🔒">{t('auth.noAccess')}</Empty>
      </div>
    )
  }

  const cards: {
    label: string
    value: string
    to: string
    tone?: 'success' | 'danger'
    drill: string
  }[] = data
    ? [
        {
          label: t('dashboard.todaySales'),
          value: formatIDR(data.today_sales ?? 0),
          to: '/penjualan',
          tone: data.today_sales > 0 ? 'success' : undefined,
          drill: t('dashboard.seeSales'),
        },
        {
          label: t('dashboard.cashPosition'),
          value: formatIDR(data.cash_position ?? 0),
          to: '/kas',
          tone: data.cash_position < 0 ? 'danger' : undefined,
          drill: t('dashboard.seeCash'),
        },
        {
          label: t('dashboard.lowStock'),
          value: String(data.low_stock_count ?? 0),
          to: '/laporan/stok',
          tone: data.low_stock_count > 0 ? 'danger' : undefined,
          drill: t('dashboard.seeStock'),
        },
        {
          label: t('dashboard.monthProfit'),
          value: formatIDR(data.month_profit ?? 0),
          to: '/laporan/laba-rugi',
          tone: data.month_profit < 0 ? 'danger' : 'success',
          drill: t('dashboard.seeLaba'),
        },
      ]
    : []

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('dashboard.title')}</h1>
        <div className="screen__actions">
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {source === 'server' ? t('common.serverData') : t('common.cachedData')}
          </span>
        </div>
      </div>

      {data === null && <Loading label={source === 'local' ? t('common.cachedData') : undefined} />}

      {data !== null && (
        <div className="card-list">
          {cards.map((c) => (
            <Link key={c.label} to={c.to} className="card-row" style={{ textDecoration: 'none' }}>
              <div className="card-row__main">
                <span className="card-row__title">{c.label}</span>
                <span className="card-row__sub">{c.drill}</span>
              </div>
              <div className="card-row__end">
                <span
                  className="num"
                  style={{
                    fontSize: 'var(--text-lg)',
                    fontWeight: 700,
                    color:
                      c.tone === 'danger'
                        ? 'var(--color-danger)'
                        : c.tone === 'success'
                          ? 'var(--color-success)'
                          : 'inherit',
                  }}
                >
                  {c.value}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
        {t('dashboard.cashHint')} · <button type="button" className="btn btn--ghost btn--sm" style={{ padding: 0 }} onClick={() => navigate('/laporan')}>{t('common.back')}</button>
      </p>
    </div>
  )
}
