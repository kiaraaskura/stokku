import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Badge, Button } from '../../components/primitives'
import { Empty, Loading } from '../../components/state'
import { formatDateTime } from '../../lib/date'
import type { InboxRow } from '../../db/repo'

/**
 * "Perlu dicek" inbox (T-220): rejected or conflicted ops as actionable rows —
 * retry (requeue), edit (open the right screen), discard — plus the
 * "diubah di perangkat lain" master-data notices from pulls.
 */
export function InboxScreen(): React.ReactNode {
  const { repo, refresh, syncAgain, toast, dataTick } = useAppState()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [rows, setRows] = useState<InboxRow[] | null>(null)
  const [notices, setNotices] = useState<{ itemId: string; noticedAt: string; name: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const reload = () => {
    if (!repo) return
    void (async () => {
      const [inbox, changed, items] = await Promise.all([
        repo.call('listInbox'),
        repo.call('listChangedElsewhere'),
        repo.call('listItems', '', false),
      ])
      setRows(inbox)
      const nameById = new Map(items.map((i) => [i.id, i.name]))
      setNotices(changed.map((c) => ({ itemId: c.itemId, noticedAt: c.noticedAt, name: nameById.get(c.itemId) ?? c.itemId.slice(0, 8) })))
    })()
  }

  useEffect(reload, [repo, dataTick])

  if (rows === null) return <Loading />

  const retry = async (row: InboxRow) => {
    if (!repo) return
    setBusy(row.id)
    try {
      // Requeue: write the op back into the outbox as pending.
      await repo.call('addOutboxOpDirect', {
        opId: row.id,
        type: row.type,
        payload: row.payload,
      })
      await repo.call('removeInboxRow', row.id)
      await refresh()
      toast(t('inbox.requeued'))
      syncAgain()
      reload()
    } finally {
      setBusy(null)
    }
  }

  const discard = async (row: InboxRow) => {
    if (!repo) return
    setBusy(row.id)
    try {
      await repo.call('removeInboxRow', row.id)
      await refresh()
      reload()
    } finally {
      setBusy(null)
    }
  }

  const dismissNotice = async (itemId: string) => {
    if (!repo) return
    await repo.call('clearChangedElsewhere', itemId)
    reload()
  }

  const editTarget = (row: InboxRow): string | null => {
    const id = typeof row.payload['id'] === 'string' ? row.payload['id'] : null
    if (row.type.startsWith('item')) return id ? `/barang/${id}` : '/barang/baru'
    return null
  }

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('inbox.title')}</h1>
        <div className="screen__actions">
          <Button variant="secondary" size="sm" onClick={() => navigate('/barang')}>
            {t('common.close')}
          </Button>
        </div>
      </div>

      {notices.length > 0 && (
        <>
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('inbox.changedElsewhere')}</h2>
          <div className="card-list">
            {notices.map((n) => (
              <div key={n.itemId} className="card-row" style={{ cursor: 'default' }}>
                <div className="card-row__main">
                  <span className="card-row__title">{n.name}</span>
                  <span className="card-row__sub">{t('inbox.changedAt', { when: formatDateTime(n.noticedAt, 'id') })}</span>
                </div>
                <div className="card-row__end">
                  <Badge tone="warning">{t('inbox.notice')}</Badge>
                  <Button variant="ghost" size="sm" onClick={() => void dismissNotice(n.itemId)}>
                    ✓
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('inbox.ops')}</h2>
      {rows.length === 0 ? (
        <Empty icon="✅">{t('inbox.empty')}</Empty>
      ) : (
        <div className="card-list">
          {rows.map((row) => (
            <div key={row.id} className="card-row" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="card-row__main">
                  <span className="card-row__title">{row.title}</span>
                  <span className="card-row__sub">
                    {row.kind === 'rejected' ? t('inbox.rejected') : t('inbox.conflict')}
                    {row.reason ? ` · ${row.reason}` : ''}
                  </span>
                </div>
                <Badge tone={row.kind === 'rejected' ? 'danger' : 'warning'}>{row.type}</Badge>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
                <Button variant="secondary" size="sm" disabled={busy === row.id} onClick={() => void retry(row)}>
                  {t('inbox.retry')}
                </Button>
                {editTarget(row) && (
                  <Button variant="secondary" size="sm" onClick={() => navigate(editTarget(row)!)}>
                    {t('common.edit')}
                  </Button>
                )}
                <Button variant="danger" size="sm" disabled={busy === row.id} onClick={() => void discard(row)}>
                  {t('inbox.discard')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
        {t('inbox.hint')}
      </p>
    </div>
  )
}
