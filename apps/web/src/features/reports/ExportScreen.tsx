import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../../components/primitives'
import { Empty } from '../../components/state'
import { currentMonth, formatMonth, monthRange, recentMonths } from '../../lib/date'
import { NetworkError } from '../../api/types'

/**
 * Export screen (F25, T-407/T-408 client): owner-only downloads against
 * GET /v1/exports/*. Files stream straight from the API with the app's auth
 * header; the laba-rugi "PDF" opens the server's printable HTML and invokes
 * the browser's print dialog (phone print-to-PDF).
 */
export function ExportScreen(): React.ReactNode {
  const { api } = useAuth()
  const { role } = useCapabilities()
  const { t, locale } = useI18n()
  const [month, setMonth] = useState(currentMonth())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (role === 'staff') {
    return (
      <div className="screen">
        <Empty icon="🔒">{t('auth.noAccess')}</Empty>
      </div>
    )
  }

  const { from, to } = monthRange(month)

  const download = async (path: string, filename: string, label: string) => {
    setBusy(label)
    setError(null)
    setDone(null)
    try {
      const res = await api.exportFile(path)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      const sizeLabel = blob.size < 1024 ? `${blob.size} B` : `${(blob.size / 1024).toFixed(1)} KB`
      setDone(`${label} · ${sizeLabel}`)
    } catch (err) {
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const printLaba = async () => {
    setBusy('laba')
    setError(null)
    setDone(null)
    try {
      const res = await api.exportFile(`/exports/laba-rugi.html?from=${from}&to=${to}`)
      const html = await res.text()
      const w = window.open('', '_blank')
      if (!w) {
        setError(t('export.popupBlocked'))
        return
      }
      w.document.open()
      w.document.write(html)
      w.document.close()
      w.focus()
      w.print()
      setDone(t('export.printOpened'))
    } catch (err) {
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const items: { key: string; label: string; action: () => void; note: string }[] = [
    {
      key: 'sales',
      label: t('export.salesCsv'),
      note: t('export.salesCsvNote'),
      action: () => void download(`/exports/sales.csv?from=${from}&to=${to}`, `stokku-penjualan-${month}.csv`, t('export.salesCsv')),
    },
    {
      key: 'laba',
      label: t('export.labaPrint'),
      note: t('export.labaPrintNote'),
      action: () => void printLaba(),
    },
    {
      key: 'archive',
      label: t('export.archive'),
      note: t('export.archiveNote'),
      action: () => void download('/exports/account.zip', 'stokku-arsip.zip', t('export.archive')),
    },
  ]

  return (
    <div className="screen" style={{ maxWidth: 620 }}>
      <div className="screen__header">
        <h1 className="screen__title">{t('export.title')}</h1>
        <div className="screen__actions">
          <Link to="/laporan" className="btn btn--secondary btn--sm">
            {t('common.back')}
          </Link>
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="export-month">
          {t('reports.month')}
        </label>
        <select id="export-month" className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
          {recentMonths(12).map((m) => (
            <option key={m} value={m}>
              {formatMonth(m, locale)}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
        {t('export.monthNote')}
      </p>

      <div className="card-list">
        {items.map((it) => (
          <div key={it.key} className="card-row" style={{ cursor: 'default' }}>
            <div className="card-row__main">
              <span className="card-row__title">{it.label}</span>
              <span className="card-row__sub">{it.note}</span>
            </div>
            <Button disabled={busy !== null} onClick={it.action}>
              {busy === it.label ? '…' : t('export.download')}
            </Button>
          </div>
        ))}
      </div>

      {busy !== null && busy === 'laba' && <p className="muted" style={{ margin: 0 }}>…</p>}
      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {error}
        </p>
      )}
      {done && (
        <p style={{ color: 'var(--color-success)', margin: 0 }} role="status">
          {done}
        </p>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
        {t('export.ownerOnly')}
      </p>
    </div>
  )
}
