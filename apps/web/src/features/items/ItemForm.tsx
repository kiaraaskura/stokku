import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../../components/primitives'
import { CurrencyInput, Input } from '../../components/inputs'
import { ErrorView, Loading, Empty } from '../../components/state'
import { Sheet } from '../../components/Sheet'
import { parseQty, formatQty, formatIDR } from '../../lib/money'
import { remoteOrLocal } from '../../api/gateway'
import { NetworkError } from '../../api/types'
import type { ItemDetail, StockMove } from '../../db/types'

interface UnitDraft {
  name: string
  factorText: string
}

export function ItemForm() {
  const { id } = useParams()
  const isEdit = id !== undefined
  const { repo, toast, refresh, online, apiMode, syncAgain } = useAppState()
  const { api } = useAuth()
  const { can } = useCapabilities()
  const showCost = can('cost.read')
  const { t, locale } = useI18n()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [baseUnit, setBaseUnit] = useState('')
  const [units, setUnits] = useState<UnitDraft[]>([])
  const [salePrice, setSalePrice] = useState(0)
  const [cost, setCost] = useState(0)
  const [minStockText, setMinStockText] = useState('')
  const [active, setActive] = useState(true)
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [detail, setDetail] = useState<ItemDetail | null>(null)
  const [loading, setLoading] = useState(isEdit)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [ledgerRows, setLedgerRows] = useState<StockMove[] | null>(null)
  const [ledgerSource, setLedgerSource] = useState<'server' | 'local'>('local')

  useEffect(() => {
    if (!repo) return
    // Categories: local + server merge when online.
    void repo.call('listCategories').then(setCategories)
    if (online && apiMode) {
      void api
        .cashCategories()
        .then(async (cats) => {
          await repo.call('applyServerCategories', cats)
          setCategories(await repo.call('listCategories'))
        })
        .catch(() => undefined)
    }
    if (isEdit && id) {
      const localRead = (): Promise<ItemDetail | null> => repo.call('getItem', id)
      const finish = (d: ItemDetail | null) => {
        if (d) {
          setDetail(d)
          setName(d.name)
          setSku(d.sku ?? '')
          setBarcode(d.barcodes.map((b) => b.barcode).join(', '))
          setCategoryId(d.categoryId ?? '')
          setBaseUnit(d.baseUnit)
          setUnits(d.units.map((u) => ({ name: u.name, factorText: String(u.factorM / 1000).replace('.', ',') })))
          setSalePrice(d.salePrice)
          setCost(d.costAvg)
          setMinStockText(d.minStockM > 0 ? String(d.minStockM / 1000).replace('.', ',') : '')
          setActive(d.active)
        }
        setLoading(false)
      }
      if (online && apiMode) {
        api
          .getItem(id)
          .then(async (wire) => {
            await repo.call('applyServerItems', [wire])
            await void localRead().then(finish)
          })
          .catch(() => void localRead().then(finish))
      } else {
        void localRead().then(finish)
      }
    } else {
      setBaseUnit('pcs')
      setLoading(false)
    }
  }, [repo, api, id, isEdit, online, apiMode])

  if (loading) return <Loading />
  if (error) return <ErrorView message={error} onRetry={() => navigate('/barang')} />
  if (isEdit && !detail) return <ErrorView message="NOT_FOUND" onRetry={() => navigate('/barang')} />

  const save = async () => {
    if (!repo) return
    setFieldError(null)
    const minStockM = minStockText.trim() === '' ? 0 : parseQty(minStockText)
    if (minStockM === null) {
      setFieldError(t('form.minStock'))
      return
    }
    const unitDrafts = units
      .map((u) => ({ name: u.name.trim(), factorM: parseQty(u.factorText) }))
      .filter((u): u is { name: string; factorM: number } => u.name !== '' || u.factorM !== null)
    for (const u of unitDrafts) {
      if (u.factorM === null || u.factorM <= 0 || u.name === '') {
        setFieldError(t('form.units'))
        return
      }
    }
    const barcodes = barcode
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b !== '')

    setSaving(true)
    try {
      // The API rejects an empty-string category_id; omit it when unset.
      const wire: Record<string, unknown> = {
        name,
        sku: sku.trim() === '' ? null : sku.trim(),
        barcodes,
        base_unit: baseUnit.trim(),
        units: unitDrafts.map((u) => ({ name: u.name, factor: u.factorM! / 1000 })),
        sale_price: salePrice,
        cost,
        min_stock: minStockM / 1000,
        active,
      }
      if (categoryId !== '') wire['category_id'] = categoryId
      const localInput = {
        name,
        sku: sku.trim() === '' ? null : sku.trim(),
        barcodes,
        categoryId: categoryId === '' ? null : categoryId,
        baseUnit,
        units: unitDrafts.map((u) => ({ name: u.name, factorM: u.factorM! })),
        salePrice,
        cost,
        minStockM,
        active,
      }
      const { source } = await remoteOrLocal({
        online,
        session: apiMode,
        remote: () => (isEdit && id ? api.updateItem(id, wire) : api.createItem(wire)),
        onRemoteSuccess: async (item) => {
          await repo.call('applyServerItems', [item])
        },
        local: () => (isEdit && id ? repo.call('updateItem', id, localInput) : repo.call('createItem', localInput)),
      })
      if (source === 'local') syncAgain()
      toast(t('form.itemSaved'))
      void refresh()
      navigate('/barang')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else if (msg.startsWith('VALIDATION')) setFieldError(msg.replace('VALIDATION ', ''))
      else setError(msg)
      setSaving(false)
    }
  }

  const openLedger = () => {
    if (!repo || !id) return
    setLedgerOpen(true)
    setLedgerRows(null)
    const localRead = (): Promise<StockMove[]> =>
      repo.call('getItem', id).then((d: ItemDetail | null) => d?.stockMoves ?? [])
    if (online && apiMode) {
      repo
        .call('getOutlet')
        .then((outlet) => api.ledger(id, outlet?.id ?? ''))
        .then(async (res) => {
          const rows: StockMove[] = res.rows.map((r, i) => ({
            id: String(i),
            outletId: '',
            itemId: id,
            qtyM: Math.round(r.qty_delta * 1000),
            unitCost: r.unit_cost ?? 0,
            type: r.type as StockMove['type'],
            refType: r.ref_type ?? null,
            refId: r.ref_id ?? null,
            businessDate: r.business_date,
            note: r.note ?? null,
            createdAt: r.business_date,
          }))
          await repo.call('setServerCache', `ledger:${id}`, res)
          setLedgerRows(rows)
          setLedgerSource('server')
        })
        .catch(() =>
          void localRead().then((rows) => {
            setLedgerRows(rows)
            setLedgerSource('local')
          }),
        )
    } else {
      repo
        .call('getServerCache', `ledger:${id}`)
        .then((cached) => {
          if (cached) {
            const res = cached.payload as { rows: { business_date: string; type: string; qty_delta: number; unit_cost: number | null; ref_type: string | null; ref_id: string | null; note: string | null }[] }
            setLedgerRows(
              res.rows.map((r, i) => ({
                id: String(i),
                outletId: '',
                itemId: id!,
                qtyM: Math.round(r.qty_delta * 1000),
                unitCost: r.unit_cost ?? 0,
                type: r.type as StockMove['type'],
                refType: r.ref_type ?? null,
                refId: r.ref_id ?? null,
                businessDate: r.business_date,
                note: r.note ?? null,
                createdAt: r.business_date,
              })),
            )
            setLedgerSource('local')
          } else {
            void localRead().then((rows) => {
              setLedgerRows(rows)
              setLedgerSource('local')
            })
          }
        })
        .catch(() => void localRead().then((rows) => setLedgerRows(rows)))
    }
  }

  return (
    <div className="screen" style={{ maxWidth: 560 }}>
      <div className="screen__header">
        <h1 className="screen__title">{isEdit ? t('form.editItem') : t('form.newItem')}</h1>
        <div className="screen__actions">
          <Button variant="secondary" onClick={() => navigate('/barang')}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>

      <Input label={t('form.name')} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!isEdit} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <Input label={t('form.sku')} value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <Input
            label={t('form.barcode')}
            inputMode="numeric"
            hint={locale === 'id' ? 'Pisahkan dengan koma untuk lebih dari satu' : 'Separate multiple with commas'}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label className="field__label" htmlFor="item-category">
            {t('form.category')}
          </label>
          <select
            id="item-category"
            className="input"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <Input
            label={t('form.baseUnit')}
            placeholder={t('form.baseUnitPlaceholder')}
            value={baseUnit}
            onChange={(e) => setBaseUnit(e.target.value)}
          />
        </div>
      </div>

      <div className="stack" style={{ gap: 'var(--space-2)' }}>
        <div className="field__label">{t('form.units')}</div>
        <p className="field__hint" style={{ margin: 0 }}>
          {t('form.unitsHint')}
        </p>
        {units.map((u, i) => (
          <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
            <div style={{ flex: 1 }}>
              <Input
                label={i === 0 ? t('form.unitName') : undefined}
                placeholder={locale === 'id' ? 'cth. dus' : 'e.g. box'}
                value={u.name}
                onChange={(e) => setUnits((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
            </div>
            <div style={{ width: 140 }}>
              <Input
                label={i === 0 ? t('form.factor') : undefined}
                inputMode="decimal"
                placeholder="24"
                value={u.factorText}
                onChange={(e) => setUnits((arr) => arr.map((x, j) => (j === i ? { ...x, factorText: e.target.value } : x)))}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('common.delete')}
              onClick={() => setUnits((arr) => arr.filter((_, j) => j !== i))}
            >
              ✕
            </Button>
          </div>
        ))}
        <div>
          <Button variant="secondary" size="sm" onClick={() => setUnits((arr) => [...arr, { name: '', factorText: '' }])}>
            + {t('form.addUnit')}
          </Button>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <CurrencyInput label={t('form.salePrice')} value={salePrice} onValueChange={setSalePrice} />
        </div>
        {showCost && (
          <div style={{ flex: '1 1 200px' }}>
            <CurrencyInput label={t('form.cost')} value={cost} onValueChange={setCost} />
          </div>
        )}
      </div>
      <Input
        label={t('form.minStock')}
        inputMode="decimal"
        placeholder="0"
        value={minStockText}
        onChange={(e) => setMinStockText(e.target.value)}
      />
      <label className="row" style={{ minHeight: 'var(--tap-target)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          style={{ width: 20, height: 20 }}
        />
        {t('form.active')}
      </label>

      {fieldError && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {fieldError}
        </p>
      )}
      {error && <ErrorView message={error} onRetry={() => setError(null)} />}

      <Button block disabled={saving || name.trim() === '' || baseUnit.trim() === ''} onClick={() => void save()}>
        {t('common.save')}
      </Button>

      {isEdit && (
        <Button variant="secondary" block onClick={openLedger}>
          {t('common.viewLedger')}
        </Button>
      )}

      <Sheet open={ledgerOpen} title={t('itemledger.title')} onClose={() => setLedgerOpen(false)}>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
          {ledgerSource === 'server' ? t('common.serverData') : t('common.localData')}
        </p>
        {ledgerRows === null && <Loading />}
        {ledgerRows !== null && ledgerRows.length === 0 && <Empty icon="📦">{t('itemledger.empty')}</Empty>}
        {ledgerRows !== null && ledgerRows.length > 0 && (
          <div className="card-list">
            {ledgerRows.map((m) => (
              <div key={m.id} className="card-row" style={{ cursor: 'default' }}>
                <div className="card-row__main">
                  <span className="card-row__title">{m.type === 'in' ? '↑ in' : m.type === 'sale' ? '↓ jual' : m.type === 'adjust' ? '± sesuaikan' : m.type === 'loss' ? '↓ rugi' : m.type}</span>
                  <span className="card-row__sub">{m.businessDate}</span>
                </div>
                <div className="card-row__end">
                  <span className="num">{formatQty(m.qtyM)}</span>
                  {showCost && m.unitCost > 0 ? <span className="muted num">@{formatIDR(m.unitCost)}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  )
}
