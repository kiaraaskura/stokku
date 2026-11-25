import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAppState } from '../../state/AppState'
import { useAuth, useCapabilities } from '../../state/AuthState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../../components/primitives'
import { Input } from '../../components/inputs'
import { ErrorView } from '../../components/state'
import QRCode from 'qrcode'
import { qrisCrcValid, qrisLooksLikePayload } from '../../lib/qris'
import { NetworkError, type ApiQrisSettings } from '../../api/types'

type Mode = 'none' | 'static_image' | 'static_payload'

/** Owner-only QRIS settings: paste a static payload or upload an image, set the MDR %. */
export function QrisSettings(): React.ReactNode {
  const { outlet, repo, online, apiMode } = useAppState()
  const { api } = useAuth()
  const { can, role } = useCapabilities()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('none')
  const [payload, setPayload] = useState('')
  const [imageData, setImageData] = useState('')
  const [mdrText, setMdrText] = useState('0')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [crcError, setCrcError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!outlet) return
    const load = async () => {
      setLoading(true)
      if (repo) {
        const cached = await repo.call('getServerCache', `qris:${outlet.id}`)
        if (cached) apply((cached.payload as ApiQrisSettings) ?? null)
      }
      if (online && apiMode) {
        try {
          const fresh = await api.getQrisSettings(outlet.id)
          await repo?.call('setServerCache', `qris:${outlet.id}`, fresh)
          apply(fresh)
        } catch {
          // cache (if any) stays
        }
      }
      setLoading(false)
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet?.id, online, apiMode])

  const apply = (s: ApiQrisSettings | null) => {
    if (!s) return
    setMode(s.mode)
    setPayload(s.payload ?? '')
    setImageData(s.image_url ?? '')
    setMdrText(String(s.mdr_pct ?? 0))
  }

  // Client-side CRC preview — the server remains the authority on save.
  useEffect(() => {
    if (mode !== 'static_payload' || payload.trim() === '') {
      setCrcError(null)
      return
    }
    if (!qrisLooksLikePayload(payload)) {
      setCrcError(t('qris.tlvError'))
      return
    }
    if (!qrisCrcValid(payload)) {
      setCrcError(t('qris.crcError'))
      return
    }
    setCrcError(null)
  }, [payload, mode, t])

  // Preview QR
  useEffect(() => {
    if (mode !== 'static_payload' || !canvasRef.current) return
    if (payload.trim() === '' || crcError) return
    void QRCode.toCanvas(canvasRef.current, payload.trim(), { width: 200, margin: 2 }).catch(() => undefined)
  }, [payload, mode, crcError])

  if (role !== 'owner') {
    return (
      <div className="screen">
        <ErrorView message={t('auth.noAccess')} onRetry={() => navigate('/barang')} />
      </div>
    )
  }

  const save = async () => {
    if (!outlet) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const mdr = Number(mdrText.replace(',', '.')) || 0
      const body: Record<string, unknown> = { mode, mdr_pct: mdr }
      if (mode === 'static_payload') body.payload = payload.trim()
      if (mode === 'static_image' && imageData !== '') body.image_url = imageData
      const fresh = await api.putQrisSettings(outlet.id, body)
      await repo?.call('setServerCache', `qris:${outlet.id}`, fresh)
      apply(fresh)
      setSaved(true)
    } catch (err) {
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="screen" style={{ maxWidth: 560 }}>
      <div className="screen__header">
        <h1 className="screen__title">{t('qris.settingsTitle')}</h1>
        <div className="screen__actions">
          <Link to="/barang" className="btn btn--secondary btn--sm">
            {t('common.close')}
          </Link>
        </div>
      </div>

      {loading && <p className="muted" style={{ margin: 0 }}>…</p>}

      <div className="field">
        <span className="field__label">{t('qris.mode')}</span>
        <div className="row" role="radiogroup" aria-label={t('qris.mode')}>
          {(['none', 'static_payload', 'static_image'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`btn btn--${mode === m ? 'primary' : 'secondary'} btn--sm`}
              onClick={() => setMode(m)}
            >
              {t(`qris.mode_${m}` as 'qris.mode_none')}
            </button>
          ))}
        </div>
      </div>

      {mode === 'static_payload' && (
        <>
          <div className="field">
            <label className="field__label" htmlFor="qris-payload">
              {t('qris.payload')}
            </label>
            <textarea
              id="qris-payload"
              className="input"
              rows={4}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="000201…"
            />
            {crcError ? (
              <span className="field__error" role="alert">
                {crcError}
              </span>
            ) : payload.trim() !== '' ? (
              <span className="field__hint">{t('qris.crcOk')}</span>
            ) : null}
          </div>
          <canvas ref={canvasRef} aria-label="QR preview" style={{ maxWidth: 200, height: 'auto' }} />
        </>
      )}

      {mode === 'static_image' && (
        <div className="field">
          <span className="field__label">{t('qris.image')}</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="input"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const reader = new FileReader()
              reader.onload = () => setImageData(String(reader.result))
              reader.readAsDataURL(file)
            }}
          />
          {imageData !== '' && <img src={imageData} alt="QRIS" style={{ maxWidth: 200, marginTop: 'var(--space-2)' }} />}
        </div>
      )}

      <Input
        label={t('qris.mdr')}
        hint={t('qris.mdrHint')}
        inputMode="decimal"
        value={mdrText}
        onChange={(e) => setMdrText(e.target.value)}
      />

      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0, wordBreak: 'break-word' }} role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p style={{ color: 'var(--color-success)', margin: 0 }} role="status">
          {t('qris.saved')}
        </p>
      )}

      <Button block disabled={saving || loading || (mode === 'static_payload' && (crcError !== null || payload.trim() === ''))} onClick={() => void save()}>
        {t('common.save')}
      </Button>
      <p className="muted" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>
        {t('qris.settingsHint')} · {can('item.write') ? 'PUT /v1/outlets/{id}/qris' : ''}
      </p>
    </div>
  )
}
