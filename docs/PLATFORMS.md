# Platform support

Stokku is **one web application**. That is what runs on every platform today. The desktop and mobile shells exist only as placeholders (tasks T-203 and T-204), so there is no double-click installer or store app yet.

This page says exactly what works, how to try it, and what each native target still needs.

## What works today

| Platform | Browser today | Native installable app | How you reach it |
|---|---|---|---|
| Windows 10+ | ✓ | — | Chrome, Edge, or Firefox at the web URL |
| Linux (Ubuntu 22.04+) | ✓ | — | Chrome or Firefox at the web URL |
| macOS 12+ | ✓ | — | Safari or Chrome at the web URL |
| Android 8+ | ✓ | — | Chrome at the web URL; 2 GB RAM is the target floor |
| iOS 15+ | ✓ | — | Safari at the web URL |

"Web URL" means wherever the web build is served: `http://127.0.0.1:8080` on the same machine, a LAN address for a phone, or a hosted domain once deployed.

## Try it on a phone on the same Wi-Fi

The API already listens on all interfaces (`0.0.0.0`), and CORS is permissive, so a phone on the same network can reach it.

1. Find the computer's LAN address, for example `192.168.1.20`.
2. Start the API with that address as the public base:

   ```sh
   APP_BASE_URL="http://192.168.1.20:8080" PORT=8099 ./api/stokku-api
   ```

3. Build or serve the web app so it calls that API. A prebuilt web bundle has `http://localhost:8099` compiled in, which on a phone means the phone itself — it will not work. Rebuild with the LAN address:

   ```sh
   VITE_API_URL="http://192.168.1.20:8099" pnpm --filter @stokku/web build
   ```

4. Serve the build on all interfaces, then open `http://192.168.1.20:8080` on the phone:

   ```sh
   cd apps/web/dist && python3 -m http.server 8080 --bind 0.0.0.0
   ```

## Native apps: what is missing

The code paths are scoped, but none of these can be finished by code alone. They need toolchains, signing identities, and paid accounts.

### Windows, macOS, Linux — Tauri 2 (T-203)

- **Status:** placeholder. `apps/desktop/` contains only a README.
- **Needs:** Rust toolchain plus each platform's webview; a Windows code-signing certificate and an Apple Developer ID for distribution; an auto-update channel.
- **Why Tauri:** installers around 10 MB instead of ~120 MB for Electron, using the system webview.

### Android — Capacitor (T-204)

- **Status:** placeholder. `apps/mobile/` contains only a README.
- **Needs:** JDK 17, Android SDK, a signing keystore, and a Google Play Console account (US$25 once) for distribution. A debug APK can be built without the store account.
- **Note:** an APK can be built on Linux; an iOS build cannot.

### iOS — Capacitor (T-510)

- **Status:** placeholder.
- **Needs:** a Mac with Xcode, the Apple Developer Program (US$99/year), and TestFlight review. There is no way to build or sign an iOS app from this Linux machine.

## Installable web app (PWA)

Not yet. The web app stores its data locally and works without a connection once the page is loaded, but there is **no web app manifest and no service worker** in `apps/web` today. That means:

- browsers will not offer "Install app" or "Add to Home Screen" as a real install;
- the page itself is not cached for a cold offline start.

Adding a manifest and a service worker is the cheapest route to an app-like experience on all five platforms, and it does not need store accounts. It has not been done.

## What you must provide

| To reach | You need |
|---|---|
| A public web URL | A host for the static build and the API (for example Render + Neon; the cardless path is in `infra/deploy/README.md`) |
| Android app | Google Play Console account, signing keystore |
| iOS app | Mac + Xcode, Apple Developer Program |
| Windows/macOS desktop app | Code-signing certificate, build machine per OS |

## Honest summary

- "Runs on Windows, Linux, Android, and Apple products" is **true today in a browser**.
- It is **not yet** a double-click installer or a store app.
- The native path is known and scoped, but it depends on accounts and signing, not only on code.