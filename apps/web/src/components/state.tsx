import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { Button } from './primitives'

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
}: {
  columns: { key: string; header: ReactNode; render: (row: T) => ReactNode; num?: boolean }[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  empty?: ReactNode
}) {
  if (rows.length === 0 && empty) return <>{empty}</>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.num ? 'num' : undefined} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(row)
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Empty({ icon = '📦', children, action }: { icon?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="state-view">
      <span className="state-view__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="state-view__text">{children}</p>
      {action}
    </div>
  )
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n()
  return (
    <div className="state-view" role="status">
      <div className="spinner" aria-hidden="true" />
      <p className="state-view__text">{label ?? t('common.loading')}</p>
    </div>
  )
}

export function ErrorView({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useI18n()
  return (
    <div className="state-view state-view--error">
      <span className="state-view__icon" aria-hidden="true">
        ⚠️
      </span>
      <p className="state-view__text">{message ?? t('common.errorTitle')}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  )
}

export function SyncDot({ pending, offline, synced }: { pending: boolean; offline: boolean; synced?: boolean }) {
  const { t } = useI18n()
  // The dot must never look synced when a write is unconfirmed: offline > pending > synced.
  const cls = offline ? 'sync-dot--offline' : pending ? 'sync-dot--pending' : synced ? 'sync-dot--synced' : ''
  const label = offline ? t('sync.offline') : pending ? t('sync.pending') : synced ? t('sync.synced') : t('sync.local')
  return (
    <span className={`sync-dot ${cls}`} title={label} role="status">
      <span className="sync-dot__dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

export function Toast({ children }: { children: ReactNode }) {
  return <div className="toast" role="status" aria-live="polite">{children}</div>
}
