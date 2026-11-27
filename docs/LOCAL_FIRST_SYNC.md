# Local-first data, phone access, and native builds

Decision record for the request on 28 November 2026:
*"data saved locally, runs locally and lightweight; check it from my phone while
away; the computer shows a QR/code and both devices sync when connected; and
give me .exe / AppImage / .apk."*

Status: **design decided, the local half already ships, the phone bridge and the
native installers are not built.** This file says exactly which is which, and why.

---

## 1. What is already local (verified, not a plan)

The web client is offline-first **today**:

- the database is SQLite compiled to WASM (`sql.js`) running in a Web Worker,
  persisted to the browser's **OPFS** (origin-private file system), with an
  in-memory fallback when OPFS is unavailable;
- every write goes to a local **outbox** first; the UI reads local data;
- with the API switched off the app still lists items, sells, and records cash,
  and the sync dot shows "Menunggu" until it can reach a server;
- the API + PostgreSQL is **optional**, not required to use the app.

So the user's first sentence is already true: the data lives on the device.
What does **not** exist is a way for a second device to reach that local data.

## 2. The actual problem

"If the data is only on my PC, how does my phone see it while I am away?"
That is a **networking and trust** problem, not a storage problem. Four
realistic ways to solve it:

| # | Method | Works away from home | Security | Effort | Verdict |
|---|---|---|---|---|---|
| A | LAN HTTPS server on the PC + QR pairing, mDNS discovery | no | good on a trusted Wi-Fi; plain HTTP on a café Wi-Fi is not acceptable, so TLS + pinning is mandatory | medium | **use at home** |
| B | Same HTTPS server, reached through a **personal VPN overlay** (WireGuard / Tailscale) | **yes** | **best**: no port forwarded, no public listener, device-level auth, traffic encrypted end to end | low (no code, config + docs) | **recommended for away** |
| C | Relay server with end-to-end encryption (Syncthing-style) | yes | good if E2EE is real; the relay sees ciphertext only | high (new service, key management) | later, if B is not acceptable |
| D | Public tunnel (ngrok, Cloudflare Tunnel) exposing the PC port | yes | **worst**: puts a shop's books on a public hostname; one misconfigured route and it is open | low | **do not ship as the default** |
| E | Manual export/import (the ZIP archive that already exists) | yes, manual | fine (a file you carry) | zero | fallback for today |

**Recommendation: B for away, A for at home, both served by the same HTTPS
listener on the PC. E stays as the zero-setup fallback. D is rejected.**

Rationale: the shop's ledger is the most sensitive data a warung has. A VPN
overlay means the PC never listens on the public internet — the phone joins a
private network and talks to it as if it were on the same Wi-Fi. It also costs
almost no code, which matters with four days to the deadline.

## 3. The pairing design (if we build A + B)

The QR is a **pairing code, not a password**:

1. On the PC the app shows a QR containing `{url, spki_sha256, one_time_token}`
   and an expiry (120 s). The TLS certificate is self-signed; the **SPKI hash**
   in the QR is what makes it trustworthy without a CA — the phone pins it.
2. The phone scans it, opens `https://<pc>:<port>/pair?t=…`, validates the
   certificate against the pinned hash, and exchanges the one-time token for a
   **per-device key** (the token is deleted after first use).
3. From then on the phone authenticates with its device key, not the token.
4. The PC lists paired devices and can **revoke** any of them; revoking kills
   that key immediately.
5. Sync reuses what already exists: `POST /sync/push` and `GET /sync/pull`
   with `change_log`/`op_log`. The PC becomes the sync hub; the phone is a
   normal client. No new sync engine.

### What the current build gets wrong for this plan

Measured on the running release binary, not assumed. **Items 1 and 2 are now
fixed** (backend `c0b2d1e`): the API binds `127.0.0.1` by default, and CORS is
an allow-list (`APP_BASE_URL` plus `CORS_ORIGINS`), never `*`. Item 3 (TLS
listener + pairing endpoint) is still not built.

1. ~~the API binds `0.0.0.0` by default (only `PORT` sets the address), so on a
   shared Wi-Fi every device on the network can reach `/v1/auth/login`;~~
   now loopback unless `BIND_ADDR` is set explicitly.
2. ~~CORS is `CorsLayer::permissive()`, so `Access-Control-Allow-Origin: *` is
   returned to any origin.~~ now an allow-list; `CORS_ORIGINS` names LAN
   origins such as `http://192.168.1.5:8080`, and there is no wildcard.
3. There is still no TLS listener and no pairing endpoint.

Fix before any LAN/QR feature ships:

1. ~~`BIND_ADDR` defaults to `127.0.0.1:<port>` for desktop use; compose sets
   `BIND_ADDR=0.0.0.0:8080` explicitly, since a container must bind all
   interfaces to be reachable through the published port.~~ done.
2. ~~Replace permissive CORS with an allow-list of the configured web origin.~~
   done — `APP_BASE_URL` plus `CORS_ORIGINS`.
3. Add the TLS listener and the pairing endpoint together — never expose a
   plaintext pairing route.

Until then, the run instructions bind `127.0.0.1` explicitly.

Additional security rules:

- TLS 1.3 only, HSTS off (self-signed), no plaintext endpoint at all;
- bind the listener to the LAN interface, not `0.0.0.0`;
- rate-limit `/pair` and expire the token (already have a login limiter to copy);
- never put the database password or JWT secret in the QR;
- encrypt the at-rest database file when the desktop shell lands (SQLCipher or
  an OS keyring-wrapped key), because a laptop gets stolen;
- the phone keeps its own local copy, so losing the PC does not lose the books —
  and the reverse.

## 4. Native builds: exactly what is possible here

Honest state after checking this machine:

| Target | Technology | Toolchain needed | Present here |
|---|---|---|---|
| Windows `.exe` (installer) | Tauri 2 + NSIS, or cross-compile | `mingw-w64`, NSIS, Rust target `x86_64-pc-windows-gnu` | **no** |
| Linux AppImage / `.deb` | Tauri 2 | `webkit2gtk-4.1`, `libgtk-3-dev`, `appimagetool` | **no** (no webkit2gtk, no appimagetool) |
| Android `.apk` | Capacitor | JDK 17, Android SDK + build-tools, `gradle` | **no** (no SDK, no gradle) |
| iOS | Capacitor | macOS + Xcode + signing identity | **impossible on Linux** |
| **All four today** | **installable PWA** | a browser | **yes — shipped** |

The installable PWA is not a consolation prize: on Android it installs to the
home screen with its own icon and runs offline; on iPhone it is
Share → "Add to Home Screen"; on Windows/Linux Chrome or Edge it installs as a
windowed app. For a shop that needs the books working today, that covers the
requirement on every platform in the user's list.

To produce the actual installers, on a machine with the toolchains:

```sh
# Windows .exe on a Windows machine (or Linux + mingw-w64 + NSIS)
rustup target add x86_64-pc-windows-gnu
cargo tauri build --target x86_64-pc-windows-gnu

# Linux AppImage / deb
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev
cargo tauri build            # -> target/release/bundle/appimage/*.AppImage

# Android .apk
# install JDK 17 + Android SDK, set ANDROID_HOME, then:
npx cap add android && npx cap sync android
cd android && ./gradlew assembleRelease   # needs a signing keystore
```

Each of those also needs a signing identity (Windows code-signing certificate,
Android keystore, Apple developer account) — those are purchases and accounts,
not something an agent can create.

## 5. Order I would do it in

1. **Now (shipped):** local-first client + installable PWA + ZIP export/import.
2. **Next, small:** QR pairing + LAN HTTPS listener in the API (reuses the
   existing sync endpoints). This is the piece that makes the phone work at home.
3. **Then:** document the VPN overlay (Tailscale/WireGuard) for away access —
   config, not code.
4. **Only after that:** the Tauri and Capacitor shells, on machines with the
   toolchains, once signing identities exist.

Doing (4) before (2) would give the user four pretty installers that still
cannot see the shop's data from a phone — the wrong order.