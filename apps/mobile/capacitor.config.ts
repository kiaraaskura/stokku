import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'id.stokku.app',
  appName: 'Stokku',
  // The built web app (apps/web/dist) is copied into the Android project by
  // `cap sync`. The app runs fully offline: SQLite in the WebView's local
  // storage; the sync API URL is configured at runtime.
  webDir: '../web/dist',
}

export default config
