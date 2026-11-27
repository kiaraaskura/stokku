# Local-first data and device-to-device sync — design

Answers the product question: *data saved locally, not on a server; check it from
my phone; sync both devices automatically; what is the most secure way?*

## What is already true today

- **All business data is local by default.** The web app keeps its own SQLite
  database (`sql.js` in a worker, persisted in the browser's Origin Private File
  System). In local/offline mode there is no server at all — the app is fully
  usable and the data never leaves the device. The API is optional and only used
  when a user signs in to it.
- **Every write is an operation in a durable outbox.** Sync is cursor-based and
  idempotent (op ids, batch push, transactional pull). Sync already runs
  automatically: on reconnect (`online` event), ~1 s after each write, and every
  15 minutes — "auto sync whenever connected" is already the engine's behavior.
- **Since commit `abef260` the web build is an installable PWA**, and the runtime
  hub URL (`src/api/hub.ts`) lets a phone adopt a desktop as its sync hub by
  opening `https://<desktop>/?api=<hub-url>` — the piece QR pairing plugs into.

## The exhibit, mapped to the architecture

> Installed on a computer, write data there, check it from my phone; the computer
> shows a QR; both devices sync whenever connected.

The computer is the **sync hub**: it runs the existing Rust API (single binary)
plus the static web app, and holds the authoritative data. The phone opens the
web app from the computer over the LAN — no internet, no cloud, nothing exposed
publicly. The QR simply encodes the pairing URL.

Recommended pairing flow (needs the pairing endpoint on the API side):

1. Desktop shows a QR: `https://<lan-ip>:<port>/?api=<same-origin>&pair=<one-time token>`.
2. Phone camera opens it; the app stores the hub URL (already implemented) and
   sends the pairing token to the hub.
3. The hub answers with device credentials; from then on the existing sync
   engine keeps both sides current whenever the phone can reach the hub.

## Security comparison

| Option | Data leaves the LAN | Resists WiFi snooping | Resists a stolen phone | Effort |
|---|---|---|---|---|
| A. Cloud server (current API on hosting) | ✓ yes | ✓ (TLS) | ✓ (password login + revoke) | needs account + hosting cost |
| B. LAN hub, plain HTTP + QR token | — no | — (cleartext on the WiFi) | — (token only until revoked) | small |
| C. **LAN hub, self-signed HTTPS + QR-pinned cert (recommended)** | — no | ✓ (TLS; QR carries the cert fingerprint, so a fake hub cannot impersonate) | ✓ (per-device key, revoke on the hub) | medium |
| D. C + VPN (Tailscale/WireGuard) for away-from-home | — no | ✓✓ (traffic inside an encrypted tunnel; hub never exposed to the internet) | ✓ | medium + user installs VPN |
| E. Bluetooth / USB cable sync | — no | ✓ | ✓ | large (web Bluetooth/USB is unreliable for bulk sync; not recommended) |

**Recommendation: C as the default, D as the "while I'm away" upgrade.**

- C is the same trust model as Syncthing/Signal-desktop pairing: the QR is the
  authenticated channel that bootstraps everything else. A one-time pairing
  token plus a certificate fingerprint in that QR defeats man-in-the-middle on
  shared/open WiFi, which plain QR-over-HTTP (B) does not.
- "Away" means the phone cannot see the LAN. Rather than port-forwarding the
  desktop (never do this), put both devices on a VPN — the hub stays unreachable
  from the internet, and the phone syncs exactly as on WiFi. No app changes.
- A stays available for shops that want multi-owner access from anywhere
  without a VPN; it is what the current API already supports.

## Why not full peer-to-peer (no hub)

The sync protocol is intentionally hub-and-spoke: one SQLite cursor per device,
server-assigned sequence numbers, idempotent ops. True P2P (any device syncs
with any other) needs conflict resolution between arbitrary replicas — slower
to build, easier to get wrong, and the hub model already gives the exhibit's
behavior with the code that exists.

## Packaging status (the .exe / AppImage / .apk ask)

| Package | Status |
|---|---|
| Linux `.AppImage` + `.deb` | Tauri 2 shell in `apps/desktop` — buildable on a Linux machine with Rust + webkit2gtk |
| Windows `.exe`/`.msi` | same Tauri shell; build **on Windows** (or cross-compile with NSIS + the Windows Rust target) |
| macOS `.dmg` | same Tauri shell; build on a Mac (signing needs an Apple account) |
| Android `.apk` | Capacitor 7 shell in `apps/mobile` (project scaffolded, web app synced in); build needs the Android SDK/Gradle, debug apk needs no signing identity |

The desktop and Android shells run the same offline-first web app with local
data — the hub is a separate concern and can be added behind the QR flow above.
