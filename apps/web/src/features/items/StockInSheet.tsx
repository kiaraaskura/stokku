import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import { useAuth } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Sheet } from '../../components/Sheet'
import { Button } from '../../components/primitives'
import { CurrencyInput, Input, QtyInput } from '../../components/inputs'
import { formatIDR, formatQty, qtyTimesUnitCost } from '../../lib/money'
import { todayISO } from '../../lib/date'
import { remoteOrLocal } from '../../api/gateway'
import { NetworkError } from '../../api/types'
import type { Item } from '../../db/types'

/**
 * 3-tap stock-in (T-213): tap "Stok masuk" on a row → qty (defaults to 1, +/− buttons)
 * → cost (prefilled with the current average cost) → Simpan. Works fully offline.
 * Online the move posts straight to the API; offline it queues with an op_id.
 */
export function StockInSheet({
  item,
  onClose,
  onSaved,
}: {
  item: Item | null
  onClose: () => void
  onSaved: () => void
}) {
  const { repo, toast, online, apiMode, outlet, syncAgain } = useAppState()
  const { api } = useAuth()
  const { t } = useI18n()
  const [qtyM, setQtyM] = useState(1000)
  const [cost, setCost] = useState(0)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (item) {
      setQtyM(1000)
      setCost(item.costAvg)
      setNote('')
      setError(null)
    }
  }, [item])

  if (!item) return null

  const save = async () => {
    if (!repo) return
    if (qtyM <= 0) {
      setError(t('common.required'))
      return
    }
    setSaving(true)
    const businessDate = todayISO()
    const noteText = note.trim() === '' ? null : note.trim()
    try {
      const { source } = await remoteOrLocal({
        online,
        session: apiMode,
        remote: () =>
          api.stockMove({
            item_id: item.id,
            outlet_id: outlet?.id ?? '',
            type: 'in',
            qty_positive: qtyM / 1000,
            unit_cost: cost,
            business_date: businessDate,
            note: noteText ?? undefined,
          }),
        onRemoteSuccess: async (move) => {
          await repo.call('applyServerStockMove', move)
          // refresh the item so stock / cost_avg are the server's numbers
          try {
            const fresh = await api.getItem(item.id)
            await repo.call('applyServerItems', [fresh])
          } catch {
            // read path will refresh it
          }
        },
        local: () =>
          repo.call('stockIn', {
            itemId: item.id,
            qtyM,
            unitCost: cost,
            businessDate,
            note: noteText,
            supplier: null,
          }),
      })
      if (source === 'server') {
        toast(t('stockin.saved'))
      } else {
        // queued optimistically; the flusher posts it when the network returns
        syncAgain()
        toast(t('sync.queued'))
      }
      onSaved()
    } catch (err) {
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={item !== null} title={`${t('stockin.title')} — ${item.name}`} onClose={onClose}>
      {/* A real form so Enter in any field saves (G29 keyboard-only stock-in). */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
      <p className="muted" style={{ margin: 0 }}>
        {t('stockin.currentStock', { qty: formatQty(item.stockM) })} · {t('stockin.avgCost', { cost: formatIDR(item.costAvg) })}
      </p>
      <QtyInput label={`${t('stockin.qty')} (${item.baseUnit})`} value={qtyM} onValueChange={setQtyM} minM={0} />
      <CurrencyInput label={t('stockin.cost')} value={cost} onValueChange={setCost} />
      <Input label={t('stockin.note')} value={note} onChange={(e) => setNote(e.target.value)} />
      {cost > 0 && (
        <p className="muted" style={{ margin: 0 }}>
          {t('common.total')}: {formatIDR(qtyTimesUnitCost(qtyM, cost))}
        </p>
      )}
      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {error}
        </p>
      )}
      <Button block type="submit" disabled={saving}>
        {t('common.save')}
      </Button>
      </form>
    </Sheet>
  )
}
