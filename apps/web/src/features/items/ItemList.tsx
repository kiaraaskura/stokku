import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAppState } from '../../state/AppState'
import { useAuth } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Badge, Button } from '../../components/primitives'
import { Empty, ErrorView, Loading } from '../../components/state'
import { formatQty, formatIDR } from '../../lib/money'
import type { Item } from '../../db/types'
import { StockInSheet } from './StockInSheet'
export function ItemList() {
  const { repo, refresh, online, apiMode } = useAppState()
  const { api } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stockInItem, setStockInItem] = useState<Item | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 120)
    return () => clearTimeout(timer)
  }, [query])

  const reload = () => {
    if (!repo) return
    setError(null)
    const localRead = (): Promise<Item[]> => repo.call('listItems', debounced, onlyLow)
    if (online && apiMode) {
      api
        .listItems(debounced)
        .then(async (rows) => {
          // Server rows write through to the local cache; rendering always reads the store.
          await repo.call('applyServerItems', rows)
          setItems(await localRead())
        })
        .catch(() => {
          void localRead().then(setItems).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        })
    } else {
      void localRead().then(setItems).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    }
  }

  useEffect(reload, [repo, api, debounced, onlyLow, online, apiMode])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const virtualizer = useVirtualizer({
    count: items?.length ?? 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 60,
    overscan: 8,
  })

  const totalCount = useMemo(() => items?.length ?? 0, [items])

  return (
    <div className="screen">
      <div className="screen__header">
        <h1 className="screen__title">{t('items.title')}</h1>
        <div className="screen__actions">
          {totalCount > 0 && <span className="muted">{t('items.count', { n: totalCount })}</span>}
          <Link to="/barang/baru" className="btn btn--primary">
            + {t('items.add')}
          </Link>
        </div>
      </div>

      <div className="row">
        <input
          className="input"
          type="search"
          placeholder={t('items.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('common.search')}
        />
        <button
          type="button"
          className={`btn btn--${onlyLow ? 'primary' : 'secondary'} btn--sm`}
          aria-pressed={onlyLow}
          onClick={() => setOnlyLow((v) => !v)}
        >
          {t('items.lowStock')}
        </button>
      </div>

      {error && <ErrorView message={error} onRetry={reload} />}
      {!error && items === null && <Loading />}

      {items !== null && !error && (
        <>
          {items.length === 0 ? (
            <Empty icon="📦" action={<Link to="/barang/baru" className="btn btn--primary">{t('items.emptyAdd')}</Link>}>
              {t('items.empty')}
            </Empty>
          ) : (
            <div
              ref={listRef}
              style={{ height: 'min(64vh, 640px)', overflow: 'auto', contain: 'strict' }}
              className="card-list"
            >
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vRow) => {
                  const item = items[vRow.index]!
                  return (
                    <div
                      key={item.id}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vRow.start}px)`,
                      }}
                    >
                      <div
                        className="card-row"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/barang/${item.id}`)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') navigate(`/barang/${item.id}`)
                        }}
                      >
                        <div className="card-row__main">
                          <span className="card-row__title">
                            {item.name}
                            {item.sku ? <span className="muted" style={{ fontWeight: 400 }}> · {item.sku}</span> : null}
                          </span>
                          <span className="card-row__sub">
                            {t('items.inStock', { qty: formatQty(item.stockM) })} {item.baseUnit}
                          </span>
                        </div>
                        <div className="card-row__end">
                          <span>{formatIDR(item.salePrice)}</span>
                          {item.stockM <= 0 ? (
                            <Badge tone="danger">{t('items.outOfStock')}</Badge>
                          ) : item.lowStock ? (
                            <Badge tone="warning">{t('items.lowStock')}</Badge>
                          ) : null}
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            setStockInItem(item)
                          }}
                        >
                          ⬇ {t('stockin.title')}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      <StockInSheet
        item={stockInItem}
        onClose={() => setStockInItem(null)}
        onSaved={() => {
          setStockInItem(null)
          reload()
          void refresh()
        }}
      />
    </div>
  )
}
