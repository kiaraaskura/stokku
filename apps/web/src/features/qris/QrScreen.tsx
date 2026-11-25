import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import QRCode from 'qrcode'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../../components/primitives'
import { formatIDR } from '../../lib/money'
import { NetworkError, type ApiQrisConfirm, type ApiQrisSettings } from '../../api/types'

/**
 * QRIS checkout (D19/D20): full-screen QR at maximum brightness (white
 * background, no dimming). Renders from the locally cached outlet QR settings
 * IMMEDIATELY so the screen opens offline; network refresh happens in the
 * background. "Sudah dibayar" confirms via POST /sales/{id}/qris/confirm and
 * then shows gross / fee / net.
 */
export function QrScreen(): React.ReactNode {
  const { saleId } = useParams()
  const location = useLocation() as { state?: { total?: number; offlineSale?: boolean } }
  const { repo, online, apiMode, outlet, tenant } = useAppState()
  const { api } = useAuth()
  const { can } = useCapabilities()
  const { t } = useI18n()
  const [settings, setSettings] = useState<ApiQrisSettings | null>(null)
  const [amount, setAmount] = useState<number | null>(location.state?.total ?? null)
  const [confirmResult, setConfirmResult] = useState<ApiQrisConfirm | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<'cache' | 'server'>('cache')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // 1. Render the cached QR instantly (offline-safe, < 300 ms).
  useEffect(() => {
    if (!repo || !outlet) return
    void repo
      .call('getServerCache', `qris:${outlet.id}`)
      .then((cached) => {
        if (cached) {
          setSettings(cached.payload as ApiQrisSettings)
          setSource('cache')
        }
      })
      .catch(() => undefined)
  }, [repo, outlet])

  // 2. Refresh settings from the server in the background.
  useEffect(() => {
    if (!repo || !outlet || !online || !apiMode) return
    void api
      .getQrisSettings(outlet.id)
      .then(async (fresh) => {
        await repo.call('setServerCache', `qris:${outlet.id}`, fresh)
        setSettings(fresh)
        setSource('server')
      })
      .catch(() => undefined)
  }, [repo, api, outlet, online, apiMode])

  // 3. Server truth for the amount when we do not have it yet.
  useEffect(() => {
    if (amount !== null || !saleId || !online || !apiMode) return
    void api
      .getSale(saleId)
      .then((sale) => setAmount(sale.total))
      .catch(() => undefined)
  }, [api, saleId, amount, online, apiMode])

  // 4. Draw the QR.
  useEffect(() => {
    if (!settings || !canvasRef.current) return
    if (settings.mode === 'static_payload' && settings.payload) {
      const size = Math.min(window.innerWidth * 0.72, window.innerHeight * 0.42, 420)
      void QRCode.toCanvas(canvasRef.current, settings.payload, {
        width: Math.floor(size),
        margin: 2,
        errorCorrectionLevel: 'M',
      }).catch(() => setError(t('qris.renderError')))
    }
  }, [settings, t])

  const gross = amount

  const confirm = useCallback(async () => {
    if (!api || !saleId || gross === null) return
    setConfirming(true)
    setError(null)
    try {
      const result = await api.qrisConfirm(saleId, {
        amount_gross: gross,
        mdr_pct: settings?.mdr_pct ?? undefined,
        paid_at: new Date().toISOString(),
      })
      setConfirmResult(result)
    } catch (err) {
      if (err instanceof NetworkError) setError(t('qris.confirmOffline'))
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfirming(false)
    }
  }, [api, saleId, gross, settings, t])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#ffffff',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-4)',
        overflow: 'auto',
      }}
    >
      <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
        {tenant?.name ?? 'Stokku'} · QRIS
      </p>

      {gross !== null && (
        <p className="num" style={{ margin: 0, fontSize: 'clamp(2rem, 9vw, 3.5rem)', fontWeight: 800, color: '#111' }}>
          {formatIDR(gross)}
        </p>
      )}

      {settings === null && (
        <p style={{ color: 'var(--color-danger)', margin: 0, textAlign: 'center' }}>
          {online ? t('qris.notSetup') : t('qris.noCache')}
        </p>
      )}

      {settings?.mode === 'none' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--color-danger)', margin: 0 }}>{t('qris.notSetup')}</p>
          {can('item.write') && (
            <Link to={`/qris-settings`} style={{ fontSize: 'var(--text-sm)' }}>
              {t('qris.setup')}
            </Link>
          )}
        </div>
      )}

      {settings?.mode === 'static_image' && settings.image_url && (
        <img src={settings.image_url} alt="QRIS" style={{ width: 'min(72vw, 420px)', imageRendering: 'pixelated' }} />
      )}

      {settings?.mode === 'static_payload' && (
        <canvas ref={canvasRef} aria-label="QRIS" style={{ maxWidth: '72vw', height: 'auto' }} />
      )}

      {confirmResult ? (
        <div
          className="card-list"
          style={{ padding: 'var(--space-5)', gap: 'var(--space-2)', width: 'min(92vw, 420px)', border: '1px solid var(--color-border)' }}
        >
          <p style={{ margin: 0, textAlign: 'center', fontWeight: 700, color: 'var(--color-success)' }}>
            ✓ {t('qris.paid')}
          </p>
          <div className="total-line">
            <span>{t('qris.gross')}</span>
            <span className="num">{formatIDR(confirmResult.payment.amount_gross)}</span>
          </div>
          <div className="total-line">
            <span>
              {t('qris.fee')} ({settings?.mdr_pct ?? 0}%)
            </span>
            <span className="num">−{formatIDR(confirmResult.payment.mdr_amount)}</span>
          </div>
          <div className="total-line total-line--grand">
            <span>{t('qris.net')}</span>
            <span className="num">{formatIDR(confirmResult.payment.amount_net)}</span>
          </div>
          <Link to="/jual" className="btn btn--primary btn--block" style={{ marginTop: 'var(--space-2)' }}>
            {t('qris.backToSell')}
          </Link>
        </div>
      ) : (
        <>
          <Button
            variant="primary"
            block
            disabled={confirming || gross === null || settings === null || settings.mode === 'none' || !!location.state?.offlineSale}
            onClick={() => void confirm()}
            style={{ maxWidth: 420 }}
          >
            {t('qris.confirmPaid')}
          </Button>
          {location.state?.offlineSale && (
            <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
              {t('sync.queued')}
            </p>
          )}
        </>
      )}

      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0, textAlign: 'center', maxWidth: 420 }} role="alert">
          {error}
        </p>
      )}

      <div style={{ position: 'fixed', top: 'var(--space-3)', right: 'var(--space-3)' }}>
        <Link to="/jual" className="btn btn--secondary btn--sm" aria-label={t('common.close')}>
          ✕
        </Link>
      </div>
      <p className="muted" style={{ position: 'fixed', bottom: 'var(--space-3)', left: 0, right: 0, textAlign: 'center', margin: 0, fontSize: 'var(--text-xs)' }}>
        {source === 'server' ? t('common.serverData') : t('common.cachedData')}
      </p>
    </div>
  )
}
