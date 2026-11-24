import { useState } from 'react'
import { useAppState } from '../state/AppState'
import { useI18n } from '../i18n/I18nProvider'
import { Badge, Button, Stepper } from '../components/primitives'
import { CurrencyInput, Input, QtyInput } from '../components/inputs'
import { Sheet } from '../components/Sheet'
import { Table, Empty, Loading, ErrorView, SyncDot } from '../components/state'
import { formatIDR, formatQty, groupAmount } from '../lib/money'
import { formatMonth } from '../lib/date'

interface DemoRow {
  id: string
  name: string
  qty: string
  price: number
}

const DEMO_ROWS: DemoRow[] = [
  { id: '1', name: 'Gula 1 kg', qty: '15', price: 12000 },
  { id: '2', name: 'Beras 5 kg', qty: '8', price: 62000 },
  { id: '3', name: 'Minyak Goreng 1 L', qty: '2', price: 18500 },
]

export function DevRoute() {
  const { t, locale } = useI18n()
  const { repo, persisted, pendingOps, online, refresh, toast } = useAppState()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [amount, setAmount] = useState(1234567)
  const [qty, setQty] = useState<number | null>(1500)
  const [text, setText] = useState('')
  const [errorText, setErrorText] = useState('')
  const [stepper, setStepper] = useState('1')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('dev.title')}</h1>
      </div>

      <section className="stack">
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('dev.buttons')}</h2>
        <div className="row">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Badge tone="success">{t('items.lowStock')}: no</Badge>
          <Badge tone="warning">{t('items.lowStock')}</Badge>
          <Badge tone="danger">{t('items.outOfStock')}</Badge>
          <Badge tone="neutral">Badge</Badge>
        </div>
      </section>

      <section className="stack">
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('dev.inputs')}</h2>
        <Input label={t('form.name')} placeholder="Gula 1 kg" value={text} onChange={(e) => setText(e.target.value)} />
        <Input label={t('form.sku')} value={errorText} error={t('common.required')} onChange={(e) => setErrorText(e.target.value)} />
        <Input label={t('common.search')} type="search" placeholder="8991002101234" />
        <CurrencyInput label={t('dev.currencyInput')} value={amount} onValueChange={setAmount} />
        <QtyInput label={t('stockin.qty')} value={qty} onValueChange={setQty} />
        <div className="row">
          <span className="field__hint">
            formatIDR({amount}) = <strong>{formatIDR(amount)}</strong> · groupAmount = {groupAmount(amount)}
          </span>
        </div>
        <div className="row">
          <Stepper
            label="stepper"
            value={stepper}
            onDecrement={() => setStepper(String(Math.max(0, Number(stepper) - 1)))}
            onIncrement={() => setStepper(String(Number(stepper) + 1))}
          />
          <span className="field__hint">formatQty(1500) = {formatQty(1500)}</span>
        </div>
      </section>

      <section className="stack">
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('dev.sheet')}</h2>
        <Button variant="secondary" onClick={() => setSheetOpen(true)}>
          {t('dev.openSheet')}
        </Button>
        <Sheet open={sheetOpen} title={t('dev.sheet')} onClose={() => setSheetOpen(false)}>
          <p className="muted" style={{ margin: 0 }}>
            {t('onboarding.subtitle')}
          </p>
          <CurrencyInput label={t('dev.currencyInput')} value={amount} onValueChange={setAmount} autoFocus />
          <Button block onClick={() => setSheetOpen(false)}>
            {t('common.done')}
          </Button>
        </Sheet>
      </section>

      <section className="stack">
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('dev.table')}</h2>
        <Table<DemoRow>
          columns={[
            { key: 'name', header: t('form.name'), render: (r) => r.name },
            { key: 'qty', header: t('sell.qty'), num: true, render: (r) => r.qty },
            { key: 'price', header: t('form.salePrice'), num: true, render: (r) => formatIDR(r.price) },
          ]}
          rows={DEMO_ROWS}
          rowKey={(r) => r.id}
          onRowClick={(r) => toast(r.name)}
        />
      </section>

      <section className="stack">
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('dev.states')}</h2>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: '1 1 220px' }}>
            <Empty icon="📦">{t('common.emptyList')}</Empty>
          </div>
          <div style={{ flex: '1 1 220px' }}>
            <Loading />
          </div>
          <div style={{ flex: '1 1 220px' }}>
            <ErrorView onRetry={() => toast(t('common.retry'))} />
          </div>
        </div>
        <div className="row">
          <SyncDot pending={false} offline={false} />
          <SyncDot pending={pendingOps > 0} offline={!online} />
          {locale === 'id' ? formatMonth('2026-11', 'id') : formatMonth('2026-11', 'en')}
        </div>
      </section>

      <section className="stack">
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{t('dev.storage')}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {persisted ? t('dev.storageOk') : t('dev.storageFallback')} · {repo?.mode ?? ''} · {t('sync.pending')}: {pendingOps}
        </p>
        <div className="row">
          <Button
            variant="secondary"
            disabled={!repo || busy}
            onClick={() =>
              void run(async () => {
                await repo!.call('seedDemo')
                await refresh()
                toast(t('dev.demoDataDone'))
              })
            }
          >
            {t('dev.demoData')}
          </Button>
          <Button
            variant="danger"
            disabled={!repo || busy}
            onClick={() =>
              void run(async () => {
                await repo!.call('resetAll')
                await refresh()
                toast(t('dev.resetDone'))
              })
            }
          >
            {t('dev.reset')}
          </Button>
        </div>
      </section>
    </div>
  )
}
