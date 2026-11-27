# Stokku on every platform

Owner: Deployment. The honest, current state of "runs on Windows, Linux,
Android and Apple products", and what each platform needs.

## Today (no new work required)

| Platform | How | Notes |
|---|---|---|
| **Linux** (x86_64, arm64) | API: `make build` → single Rust binary, or the Docker image (amd64 + arm64). Web: any browser or serve `apps/web/dist` statically. | Fully supported and tested here. |
| **Windows** (10/11) | **Any browser** → the web app. Or **Docker Desktop** → `make up` (postgres + api + web in one command). Or **WSL2** → same as Linux. | The Rust API cross-compiles to Windows (`x86_64-pc-windows-msvc`); a prebuilt `.exe` is not produced by our release script yet. |
| **macOS** (Intel/Apple Silicon) | **Any browser** → the web app. Docker images are built for both amd64 and arm64, so `make up` works on Apple Silicon. | Building a native macOS binary or a signed `.app` requires a Mac — not possible from this machine. |
| **Android** (phones/tablets) | **Any browser** → the web app; it is offline-first (SQLite in the browser via OPFS), so it keeps working without signal. Add to home screen for an app-like icon. | A native Capacitor app (`apps/mobile`) is planned; needs Android Studio + a signing key. |
| **iPhone / iPad** | **Any browser** (Safari) → the web app, same offline-first storage. | A native App Store build is planned and needs an Apple developer account — a human decision. |

The one architecture decision that makes this possible: **the client is the
web app** (React + Vite, local SQLite + outbox), and the server is **one Rust
binary + PostgreSQL**. Any device with a browser is a first-class client.

## What a real deployment looks like

- **Server (any cloud or a box in the shop)**: PostgreSQL 16+ and the
  `stokku-api` binary (or `docker compose up`). See [DEPLOY.md](DEPLOY.md).
- **Every device**: open the web app URL, sign in, use it — online or offline.
- **Options**: free-tier hosting (Render + Neon, Singapore) is documented in
  [infra/deploy/README.md](../infra/deploy/README.md).

## Native apps (planned, not built)

| Shell | Tech | What it still needs |
|---|---|---|
| `apps/desktop` (Windows/macOS/Linux installer) | Tauri 2 | Rust + the web build per platform, code signing identities |
| `apps/mobile` (Android APK) | Capacitor | Android Studio, a signing keystore, Play Console account |
| iOS | Capacitor | Apple developer account, Xcode on a Mac |

Until those land, "install" on a phone means: open the URL → add to home
screen. It works offline and updates itself on reload.
