import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import { I18nProvider } from './i18n/I18nProvider'
import { AuthProvider, useAuth } from './state/AuthState'
import { AppStateProvider, useAppState } from './state/AppState'
import { AppShell, RootRedirect } from './AppShell'
import { OnboardingWizard } from './features/onboarding/OnboardingWizard'
import { LoginScreen } from './features/auth/LoginScreen'
import { ItemList } from './features/items/ItemList'
import { ItemForm } from './features/items/ItemForm'
import { Cart } from './features/sales/Cart'
import { SalesList } from './features/sales/SalesList'
import { CashBook } from './features/cash/CashBook'
import { LabaRugi } from './features/reports/LabaRugi'
import { DevRoute } from './dev/DevRoute'

const LANG_KEY = 'stokku.lang'
const savedLang = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_KEY) : null
const initialLocale = savedLang === 'en' ? 'en' : 'id'

function OnboardingRoute(): React.ReactNode {
  const { session } = useAuth()
  const { ready, onboarded } = useAppState()
  if (session) return <Navigate to="/barang" replace />
  if (!ready) return null
  if (onboarded) return <Navigate to="/barang" replace />
  return <OnboardingWizard />
}

export function App(): React.ReactNode {
  return (
    <I18nProvider initialLocale={initialLocale}>
      <AuthProvider>
        <AppStateProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginScreen />} />
              <Route path="/onboarding" element={<OnboardingRoute />} />
              <Route path="/" element={<AppShell />}>
                <Route index element={<RootRedirect />} />
                <Route path="barang" element={<ItemList />} />
                <Route path="barang/baru" element={<ItemForm />} />
                <Route path="barang/:id" element={<ItemForm />} />
                <Route path="jual" element={<Cart />} />
                <Route path="penjualan" element={<SalesList />} />
                <Route path="kas" element={<CashBook />} />
                <Route path="laporan" element={<LabaRugi />} />
                <Route path="dev" element={<DevRoute />} />
                <Route path="*" element={<Navigate to="/barang" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AppStateProvider>
      </AuthProvider>
    </I18nProvider>
  )
}
