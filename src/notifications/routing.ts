import type { AlertTarget } from '../stage3/readiness'

/**
 * Notification click → app navigation. The service worker (public/sw.js) focuses an open
 * A.R.G.U.S. window and posts NOTIFICATION_OPEN_MESSAGE to it, or opens a new window with the same
 * information in the query string. Opens that arrive while the app is locked or still loading are
 * held until the unlocked app subscribes. Keep the message shape in sync with public/sw.js.
 */
export const NOTIFICATION_OPEN_MESSAGE = 'ARGUS_NOTIFICATION_OPEN'
export const OPEN_PARAMS = { alert: 'argus-alert', tab: 'argus-tab', panel: 'argus-panel' } as const
export type NotificationOpen = { alertId: string; target: AlertTarget }

const TABS = ['count', 'inventory', 'cadets', 'activity', 'calendar', 'more'] as const satisfies readonly AlertTarget['tab'][]
const PANELS = ['conflicts', 'needed', 'wallet', 'diagnostics'] as const satisfies ReadonlyArray<NonNullable<AlertTarget['panel']>>

/** Validates a target from outside the page (a message or URL); anything unexpected is dropped, never routed. */
export function parseTarget(value: unknown): AlertTarget | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { tab, panel } = value as Record<string, unknown>
  const knownTab = TABS.find(candidate => candidate === tab)
  if (!knownTab) return undefined
  const knownPanel = PANELS.find(candidate => candidate === panel)
  return knownPanel ? { tab: knownTab, panel: knownPanel } : { tab: knownTab }
}

export function parseNotificationOpen(data: unknown): NotificationOpen | undefined {
  if (!data || typeof data !== 'object') return undefined
  const message = data as Record<string, unknown>
  if (message.type !== NOTIFICATION_OPEN_MESSAGE || typeof message.alertId !== 'string') return undefined
  const target = parseTarget(message.target)
  return target ? { alertId: message.alertId.slice(0, 200), target } : undefined
}

export function notificationOpenFromUrl(href: string): NotificationOpen | undefined {
  let url: URL
  try { url = new URL(href) } catch { return undefined }
  const alertId = url.searchParams.get(OPEN_PARAMS.alert)
  if (!alertId) return undefined
  return parseNotificationOpen({ type: NOTIFICATION_OPEN_MESSAGE, alertId, target: { tab: url.searchParams.get(OPEN_PARAMS.tab), panel: url.searchParams.get(OPEN_PARAMS.panel) ?? undefined } })
}

export function withoutOpenParams(href: string) {
  const url = new URL(href)
  for (const name of Object.values(OPEN_PARAMS)) url.searchParams.delete(name)
  return url.href
}

type Listener = (open: NotificationOpen) => void
const listeners = new Set<Listener>()
let pending: NotificationOpen | undefined

/** Delivers an open to the app, or holds the latest one until the app subscribes. */
export function deliverNotificationOpen(open: NotificationOpen) {
  if (!listeners.size) { pending = open; return }
  for (const listener of listeners) listener(open)
}

export function onNotificationOpen(listener: Listener) {
  listeners.add(listener)
  if (pending) {
    const held = pending
    pending = undefined
    listener(held)
  }
  return () => { listeners.delete(listener) }
}

type RouterEnvironment = {
  serviceWorker?: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>
  location?: Pick<Location, 'href'>
  history?: Pick<History, 'replaceState'>
}
let uninstall: (() => void) | undefined

/** Installed once at startup (main.tsx), before the unit gate, so a click on a locked app is not lost. */
export function installNotificationRouter(environment: RouterEnvironment = { serviceWorker: globalThis.navigator?.serviceWorker, location: globalThis.location, history: globalThis.history }) {
  uninstall?.()
  const href = environment.location?.href
  const fromUrl = href ? notificationOpenFromUrl(href) : undefined
  if (fromUrl && href) {
    try { environment.history?.replaceState(null, '', withoutOpenParams(href)) } catch { /* the params are harmless if they stay */ }
    deliverNotificationOpen(fromUrl)
  }
  const onMessage = (event: Event) => {
    const open = parseNotificationOpen((event as MessageEvent).data)
    if (open) deliverNotificationOpen(open)
  }
  environment.serviceWorker?.addEventListener('message', onMessage)
  const remove = () => { environment.serviceWorker?.removeEventListener('message', onMessage); if (uninstall === remove) uninstall = undefined }
  uninstall = remove
  return remove
}

/** Test helper: forget subscribers and anything held. */
export function resetNotificationRouting() {
  uninstall?.()
  listeners.clear()
  pending = undefined
}
