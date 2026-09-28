const CACHE_PREFIX = 'argus-shell-'
const CACHE = `${CACHE_PREFIX}v2`
const SHELL = ['./', './manifest.webmanifest', './argus-mark.svg']

self.addEventListener('install', event => {
  // Do not skipWaiting: an active workflow must never be reloaded underneath a user.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)))
})

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]))
})

self.addEventListener('message', event => {
  if (event.data?.type === 'ARGUS_ACTIVATE_UPDATE') self.skipWaiting()
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put('./', response.clone()))
      return response
    }).catch(() => caches.match('./')))
    return
  }
  // Assets use cache-first with background refresh. Failed scripts/styles never
  // receive the HTML application shell, which would cause misleading MIME errors.
  if (['script', 'style', 'image', 'font', 'manifest'].includes(request.destination)) event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()))
      return response
    })),
  )
})

// Device notifications (docs/DEVICE_NOTIFICATIONS.md). Names match src/notifications/environment.ts
// and src/notifications/routing.ts. The worker never sees decrypted data: it only routes clicks and
// reads the page's plaintext deadline summary (opaque ids, event kinds and due times).
const NOTIFY_CACHE = 'argus-notify-v1'
const SUMMARY_PATH = 'argus-notification-summary.json'
const WORKER_STATE_PATH = 'argus-notification-worker.json'
const PERIODIC_SYNC_TAG = 'argus-deadline-check'
const OPEN_MESSAGE = 'ARGUS_NOTIFICATION_OPEN'
const HOUR = 3_600_000
const RECENTLY_OPENED = 12 * HOUR
const STALE_DUE = 14 * 24 * HOUR

const inScope = client => typeof client.url === 'string' && client.url.startsWith(self.registration.scope)
const argusWindows = () => self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list.filter(inScope))

self.addEventListener('notificationclick', event => {
  const data = event.notification.data
  event.notification.close()
  if (!data || data.argus !== true) return
  const target = data.target && typeof data.target.tab === 'string' ? data.target : undefined
  const message = { type: OPEN_MESSAGE, alertId: typeof data.alertId === 'string' ? data.alertId : '', target }
  event.waitUntil(argusWindows().then(async windows => {
    const client = windows.find(candidate => candidate.focused) || windows[0]
    if (client) {
      const focused = await client.focus().catch(() => client)
      if (message.alertId && target) (focused || client).postMessage(message)
      return
    }
    // No window: open one; the page reads these parameters and routes after it is unlocked.
    const url = new URL(self.registration.scope)
    if (message.alertId && target) {
      url.searchParams.set('argus-alert', message.alertId)
      url.searchParams.set('argus-tab', target.tab)
      if (typeof target.panel === 'string') url.searchParams.set('argus-panel', target.panel)
    }
    await self.clients.openWindow(url.href)
  }).catch(() => undefined))
})

// Closed-app best effort: installed Chromium apps only, when the browser chooses to run it.
self.addEventListener('periodicsync', event => {
  if (event.tag === PERIODIC_SYNC_TAG) event.waitUntil(checkPassedDeadlines().catch(() => undefined))
})

async function readJson(cache, url) {
  const response = await cache.match(url)
  if (!response) return undefined
  try { return await response.json() } catch { return undefined }
}

async function checkPassedDeadlines(now = Date.now()) {
  if (self.Notification && self.Notification.permission !== 'granted') return
  // An open A.R.G.U.S. window notifies for itself, with current data.
  if ((await argusWindows()).length) return
  const cache = await caches.open(NOTIFY_CACHE)
  const summaryUrl = new URL(SUMMARY_PATH, self.registration.scope).href
  const stateUrl = new URL(WORKER_STATE_PATH, self.registration.scope).href
  const summary = await readJson(cache, summaryUrl)
  if (!summary || summary.version !== 1 || !Array.isArray(summary.items)) return
  if (typeof summary.lastOpenedAt === 'number' && now - summary.lastOpenedAt < RECENTLY_OPENED) return
  const notified = {}
  const previous = (await readJson(cache, stateUrl))?.notified ?? {}
  for (const [key, at] of Object.entries(previous)) if (typeof at === 'number' && now - at < STALE_DUE + 24 * HOUR) notified[key] = at
  // Each passed deadline is reported once; older than two weeks is too stale to be worth a notification.
  const due = summary.items.filter(item => item && typeof item.id === 'string' && typeof item.dueAt === 'number'
    && item.dueAt <= now && now - item.dueAt < STALE_DUE && !notified[`${item.id}|${item.dueAt}`])
  if (!due.length) return
  for (const item of due) notified[`${item.id}|${item.dueAt}`] = now
  await cache.put(stateUrl, new Response(JSON.stringify({ notified }), { headers: { 'content-type': 'application/json' } }))
  const first = due[0]
  const label = typeof first.label === 'string' ? first.label.slice(0, 60) : 'A preparation task'
  const icon = new URL('argus-mark.svg', self.registration.scope).href
  await self.registration.showNotification(due.length === 1 ? `A.R.G.U.S.: ${label} past due` : `A.R.G.U.S.: ${due.length} preparation deadlines have passed`, {
    body: 'Open A.R.G.U.S. to check. This reminder uses what this device knew when A.R.G.U.S. was last unlocked.',
    tag: PERIODIC_SYNC_TAG,
    icon,
    badge: icon,
    data: { argus: true, alertId: first.id, target: first.target },
  })
}
