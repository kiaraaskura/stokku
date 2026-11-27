// Stokku service worker: makes the web app installable and fully offline-capable
// on Windows, Linux, Android, and iOS.
// The build (vite.config.ts, plugin "stokku-sw-precache") injects PRECACHE with
// the real list of built files and VERSION with a per-build hash; the source
// placeholders below are never served in dev (registration is prod-only).
const PRECACHE = [] // injected at build: ['/', '/assets/index-<hash>.js', ...]
const VERSION = 'stokku-dev' // injected at build: 'stokku-<buildhash>'
const SHELL = `${VERSION}-shell`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Only cache this app's own static assets — never the API or other origins.
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/sw.js' || url.pathname.startsWith('/api/') || url.pathname === '/health')
    return

  // Pages: network first so updates land; cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL).then((cache) => cache.put('/', copy))
          return res
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  // Build assets have content-hashed names, so cache-first is safe.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(SHELL).then((cache) => cache.put(request, copy))
          }
          return res
        }),
    ),
  )
})
