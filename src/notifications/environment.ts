import type { AlertTarget } from '../stage3/readiness'
import { HOUR, type ClosedAppSummary } from './policy'
import { deliverNotificationOpen } from './routing'

/**
 * Everything browser-specific about device notifications, behind one interface so the policy and
 * the settings UI can be tested with a fake. Every call feature-detects and fails quietly: a
 * browser without an API simply gets fewer notifications, never an error.
 * Keep NOTIFY_CACHE, SUMMARY_PATH and PERIODIC_SYNC_TAG in sync with public/sw.js.
 */
export const NOTIFY_CACHE = 'argus-notify-v1'
export const SUMMARY_PATH = 'argus-notification-summary.json'
export const PERIODIC_SYNC_TAG = 'argus-deadline-check'
export const CLOSED_APP_MIN_INTERVAL = 12 * HOUR

export type DevicePermission = NotificationPermission | 'unsupported'
/** available: installed app with Periodic Background Sync allowed; needs-install: the API exists but is not granted. */
export type ClosedAppSupport = 'available' | 'needs-install' | 'unsupported'
export type DeviceNotification = { tag: string; title: string; body: string; alertId?: string; target?: AlertTarget }
export type PlatformInfo = { ios: boolean; standalone: boolean }

export interface NotificationEnvironment {
  permission(): DevicePermission
  requestPermission(): Promise<DevicePermission>
  /** True unless the page is known to be hidden (a background tab, minimized, or the screen is off). */
  visible(): boolean
  platform(): PlatformInfo
  show(notification: DeviceNotification): Promise<boolean>
  close(tags: readonly string[]): Promise<void>
  closedAppSupport(): Promise<ClosedAppSupport>
  /** Registers or removes the Periodic Background Sync check; resolves true only when it is registered. */
  setClosedAppChecks(enabled: boolean): Promise<boolean>
  /** Stores the closed-app summary, or deletes it (and the worker's own state) when undefined. */
  writeSummary(summary: ClosedAppSummary | undefined): Promise<void>
}

type NotificationConstructor = {
  new (title: string, options?: NotificationOptions): Notification
  readonly permission: NotificationPermission
  requestPermission(callback?: (permission: NotificationPermission) => void): Promise<NotificationPermission> | undefined
}
type PeriodicSyncManager = { register(tag: string, options?: { minInterval?: number }): Promise<void>; unregister(tag: string): Promise<void> }
type PeriodicRegistration = ServiceWorkerRegistration & { periodicSync?: PeriodicSyncManager }

const notificationApi = () => {
  const api = (globalThis as { Notification?: unknown }).Notification as NotificationConstructor | undefined
  return typeof api === 'function' && typeof api.permission === 'string' ? api : undefined
}

async function registration(): Promise<PeriodicRegistration | undefined> {
  try { return await globalThis.navigator?.serviceWorker?.getRegistration() } catch { return undefined }
}

/** Page-level notifications (no service worker, e.g. development builds), so they can be withdrawn. */
const pageNotifications = new Map<string, Notification>()
const iconUrl = (base?: string) => { try { return new URL('argus-mark.svg', base ?? document.baseURI).href } catch { return undefined } }

export const browserNotificationEnvironment: NotificationEnvironment = {
  permission: () => notificationApi()?.permission ?? 'unsupported',

  async requestPermission() {
    const api = notificationApi()
    if (!api) return 'unsupported'
    try {
      // Older Safari only supports the callback form and returns undefined.
      const result = await new Promise<NotificationPermission>(resolve => {
        const promise = api.requestPermission(resolve)
        if (promise && typeof promise.then === 'function') promise.then(resolve, () => resolve(api.permission))
      })
      return result ?? api.permission
    } catch { return api.permission }
  },

  visible: () => globalThis.document?.visibilityState !== 'hidden',

  platform() {
    const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined
    const ua = nav?.userAgent ?? ''
    const ios = /iPad|iPhone|iPod/.test(ua) || (nav?.platform === 'MacIntel' && (nav?.maxTouchPoints ?? 0) > 1)
    let standalone = nav?.standalone === true
    try { standalone ||= Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches) } catch { /* no matchMedia */ }
    return { ios, standalone }
  },

  async show({ tag, title, body, alertId, target }) {
    const api = notificationApi()
    if (!api || api.permission !== 'granted') return false
    const data = { argus: true, ...(alertId ? { alertId } : {}), ...(target ? { target } : {}) }
    const worker = await registration()
    // renotify: a replacement with the same tag alerts again (Chromium); silently ignored elsewhere.
    const options: NotificationOptions & { renotify?: boolean } = { body, tag, data, renotify: true, icon: iconUrl(worker?.scope), badge: iconUrl(worker?.scope), lang: 'en' }
    try {
      if (worker?.active && typeof worker.showNotification === 'function') { await worker.showNotification(title, options); return true }
    } catch { /* fall back to a page notification */ }
    try {
      const shown = new api(title, options)
      pageNotifications.get(tag)?.close()
      pageNotifications.set(tag, shown)
      shown.onclick = () => {
        try { globalThis.focus?.() } catch { /* focusing is best effort */ }
        shown.close()
        pageNotifications.delete(tag)
        if (alertId && target) deliverNotificationOpen({ alertId, target })
      }
      return true
    } catch { return false } // Android Chrome forbids the constructor; nothing else to try.
  },

  async close(tags) {
    const wanted = new Set(tags)
    if (!wanted.size) return
    for (const [tag, shown] of pageNotifications) if (wanted.has(tag)) { shown.close(); pageNotifications.delete(tag) }
    try {
      const worker = await registration()
      for (const shown of await worker?.getNotifications?.() ?? []) if (wanted.has(shown.tag)) shown.close()
    } catch { /* nothing to withdraw */ }
  },

  async closedAppSupport() {
    if (!('PeriodicSyncManager' in globalThis)) return 'unsupported'
    try {
      const status = await globalThis.navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName })
      return status.state === 'granted' ? 'available' : 'needs-install'
    } catch { return 'needs-install' }
  },

  async setClosedAppChecks(enabled) {
    const periodic = (await registration())?.periodicSync
    if (!periodic) return false
    try {
      if (!enabled) { await periodic.unregister(PERIODIC_SYNC_TAG); return false }
      await periodic.register(PERIODIC_SYNC_TAG, { minInterval: CLOSED_APP_MIN_INTERVAL })
      return true
    } catch { return false } // not installed, or the browser declined
  },

  async writeSummary(summary) {
    const storage = globalThis.caches
    if (!storage) return
    try {
      if (!summary) { await storage.delete(NOTIFY_CACHE); return }
      const worker = await registration()
      if (!worker) return
      const cache = await storage.open(NOTIFY_CACHE)
      await cache.put(new URL(SUMMARY_PATH, worker.scope).href, new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } }))
    } catch { /* storage unavailable (private mode, quota); closed-app checks simply see nothing */ }
  },
}
