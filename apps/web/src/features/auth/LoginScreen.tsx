import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../../state/AuthState'
import { useAppState } from '../../state/AppState'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../../components/primitives'
import { Input } from '../../components/inputs'
import { NetworkError } from '../../api/types'

export function LoginScreen(): React.ReactNode {
  const { t } = useI18n()
  const { login, signup } = useAuth()
  const { repo, refresh, toast } = useAppState()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    setError(null)
    setSubmitting(true)
    try {
      if (mode === 'login') {
        await login(email.trim(), password)
        toast(t('auth.welcome'))
      } else {
        await signup({
          email: email.trim(),
          password,
          name: name.trim(),
          business_name: businessName.trim(),
        })
        toast(t('auth.welcome'))
      }
      if (repo && mode === 'signup') {
        // Starter categories mirror the local wizard for a fresh account.
        await refresh()
      }
      navigate('/barang', { replace: true })
    } catch (err) {
      if (err instanceof NetworkError) setError(t('auth.networkError'))
      else if (err instanceof Error) setError(err.message)
      else setError(String(err))
      setSubmitting(false)
    }
  }

  const canSubmit =
    email.trim() !== '' &&
    password.length >= 8 &&
    (mode === 'login' || (name.trim() !== '' && businessName.trim() !== ''))

  return (
    <div
      style={{
        maxWidth: 420,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-4) var(--space-12)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        minHeight: '100dvh',
        justifyContent: 'center',
      }}
    >
      <header style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--text-2xl)', color: 'var(--color-primary-strong)' }}>Stokku</h1>
        <p className="muted" style={{ margin: 'var(--space-1) 0 0' }}>
          {t('auth.subtitle')}
        </p>
      </header>

      <div className="row" role="tablist" style={{ justifyContent: 'center' }}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'login'}
          className={`btn btn--${mode === 'login' ? 'primary' : 'secondary'} btn--sm`}
          onClick={() => setMode('login')}
        >
          {t('auth.login')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'signup'}
          className={`btn btn--${mode === 'signup' ? 'primary' : 'secondary'} btn--sm`}
          onClick={() => setMode('signup')}
        >
          {t('auth.signup')}
        </button>
      </div>

      <Input
        label={t('auth.email')}
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
      />
      <Input
        label={t('auth.password')}
        type="password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {mode === 'signup' && (
        <>
          <Input label={t('auth.name')} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            label={t('auth.businessName')}
            placeholder={t('onboarding.businessNamePlaceholder')}
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
          />
        </>
      )}

      {error && (
        <p style={{ color: 'var(--color-danger)', margin: 0 }} role="alert">
          {error}
        </p>
      )}

      <Button block disabled={!canSubmit || submitting} onClick={() => void submit()}>
        {mode === 'login' ? t('auth.login') : t('auth.signup')}
      </Button>

      <p style={{ textAlign: 'center', margin: 0 }}>
        <Link to="/onboarding" className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          {t('auth.offlineMode')}
        </Link>
      </p>
    </div>
  )
}
