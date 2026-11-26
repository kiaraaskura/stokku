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
import { ReportsHub } from './features/reports/ReportsHub'
import { StockReport } from './features/reports/StockReport'
import { SalesReport } from './features/reports/SalesReport'
import { Dashboard } from './features/reports/Dashboard'
import { ExportScreen } from './features/reports/ExportScreen'
import { OpnameScreen } from './features/opname/OpnameScreen'
import { QrScreen } from './features/qris/QrScreen'
import { QrisSettings } from './features/qris/QrisSettings'
import { InboxScreen } from './features/inbox/InboxScreen'
import { DevRoute } from './dev/DevRoute'
import { CrashBoundary } from './components/CrashBoundary'

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
            <CrashBoundary>
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
                <Route path="laporan" element={<ReportsHub />} />
                <Route path="laporan/laba-rugi" element={<LabaRugi />} />
                <Route path="laporan/stok" element={<StockReport />} />
                <Route path="laporan/penjualan" element={<SalesReport />} />
                <Route path="laporan/ringkasan" element={<Dashboard />} />
                <Route path="laporan/unduh" element={<ExportScreen />} />
                <Route path="opname" element={<OpnameScreen />} />
                <Route path="qris-settings" element={<QrisSettings />} />
                <Route path="perlu-dicek" element={<InboxScreen />} />
                <Route path="dev" element={<DevRoute />} />
                <Route path="*" element={<Navigate to="/barang" replace />} />
              </Route>
              <Route path="/qris/:saleId" element={<QrScreen />} />
            </Routes>
            </CrashBoundary>
          </BrowserRouter>
        </AppStateProvider>
      </AuthProvider>
    </I18nProvider>
  )
}
