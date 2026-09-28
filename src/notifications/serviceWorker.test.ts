import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController } from '../distributed/appIntegration'
import { NOTIFY_CACHE, PERIODIC_SYNC_TAG, SUMMARY_PATH } from './environment'
import { DAY, HOUR, closedAppSummary, type ClosedAppSummary } from './policy'
import { NOTIFICATION_OPEN_MESSAGE, notificationOpenFromUrl, parseNotificationOpen } from './routing'

/** Runs public/sw.js against fake worker globals, so the shipped file itself is what is tested. */
const SOURCE = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8')
const SCOPE = 'https://example.test/argus/'
type Handler = (event: Record<string, unknown>) => void
type FakeWindow = { url: string; focused: boolean; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }

const fakeWindow = (url = SCOPE): FakeWindow => {
  const client: FakeWindow = { url, focused: false, focus: vi.fn(async () => client), postMessage: vi.fn() }
  return client
}

function loadWorker({ windows = [] as FakeWindow[], permission = 'granted' as NotificationPermission } = {}) {
  const handlers = new Map<string, Handler>()
  const shown: Array<{ title: string; options: NotificationOptions }> = []
  const stores = new Map<string, Map<string, string>>()
  const store = (name: string) => { const found = stores.get(name) ?? new Map<string, string>(); stores.set(name, found); return found }
  const caches = {
    open: async (name: string) => ({
      match: async (key: string) => store(name).has(key) ? new Response(store(name).get(key)) : undefined,
      put: async (key: string, response: Response) => { store(name).set(String(key), await response.text()) },
      addAll: async () => undefined,
    }),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  }
  const openWindow = vi.fn(async (url: string) => { void url; return undefined })
  const self = {
    addEventListener: (type: string, handler: Handler) => { handlers.set(type, handler) },
    registration: { scope: SCOPE, showNotification: async (title: string, options: NotificationOptions) => { shown.push({ title, options }) } },
    clients: { matchAll: async () => windows, openWindow, claim: async () => undefined },
    location: new URL('sw.js', SCOPE),
    skipWaiting: vi.fn(),
    Notification: { permission },
  }
  new Function('self', 'caches', SOURCE)(self, caches)
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Array<Promise<unknown>> = []
    handlers.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } })
    await Promise.all(pending)
  }
  const putSummary = (summary: ClosedAppSummary) => store(NOTIFY_CACHE).set(new URL(SUMMARY_PATH, SCOPE).href, JSON.stringify(summary))
  return { handlers, shown, openWindow, dispatch, putSummary }
}

const click = (data: unknown) => ({ notification: { data, close: vi.fn() } })

describe('service worker: notification clicks', () => {
  it('keeps the app-shell caching handlers alongside the notification ones', () => {
    const worker = loadWorker()
    expect([...worker.handlers.keys()].sort()).toEqual(['activate', 'fetch', 'install', 'message', 'notificationclick', 'periodicsync'])
  })

  it('focuses the open A.R.G.U.S. window and posts it the alert to open', async () => {
    const other = fakeWindow('https://example.test/another-app/'), argus = fakeWindow()
    const worker = loadWorker({ windows: [other, argus] })
    const event = click({ argus: true, alertId: 'event-calendar_1', target: { tab: 'calendar' } })
    await worker.dispatch('notificationclick', event)
    expect(event.notification.close).toHaveBeenCalled()
    expect(argus.focus).toHaveBeenCalled()
    expect(other.focus).not.toHaveBeenCalled()
    expect(argus.postMessage).toHaveBeenCalledWith({ type: NOTIFICATION_OPEN_MESSAGE, alertId: 'event-calendar_1', target: { tab: 'calendar' } })
    expect(parseNotificationOpen(argus.postMessage.mock.calls[0][0])).toEqual({ alertId: 'event-calendar_1', target: { tab: 'calendar' } })
    expect(worker.openWindow).not.toHaveBeenCalled()
  })

  it('opens a new window whose URL carries the alert when none is open', async () => {
    const worker = loadWorker({ windows: [fakeWindow('https://example.test/another-app/')] })
    await worker.dispatch('notificationclick', click({ argus: true, alertId: 'conflicts', target: { tab: 'more', panel: 'conflicts' } }))
    const url = worker.openWindow.mock.calls[0][0]
    expect(url.startsWith(SCOPE)).toBe(true)
    expect(notificationOpenFromUrl(url)).toEqual({ alertId: 'conflicts', target: { tab: 'more', panel: 'conflicts' } })
  })

  it('only focuses for a test notification, and ignores notifications that are not its own', async () => {
    const argus = fakeWindow()
    const worker = loadWorker({ windows: [argus] })
    await worker.dispatch('notificationclick', click({ argus: true }))
    expect(argus.focus).toHaveBeenCalledTimes(1)
    expect(argus.postMessage).not.toHaveBeenCalled()
    const foreign = click({ url: 'https://evil.test' })
    await worker.dispatch('notificationclick', foreign)
    expect(foreign.notification.close).toHaveBeenCalled()
    expect(argus.focus).toHaveBeenCalledTimes(1)
    expect(worker.openWindow).not.toHaveBeenCalled()
  })
})

describe('service worker: closed-app deadline check', () => {
  /** An AMI five days out: four of its preparation tasks are already past due. */
  async function summary(lastOpenedAt: number) {
    const controller = new DistributedAppController()
    await controller.initialize()
    await controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', fullName: 'Jordan Rivera', cadetCode: 'C-7K4M' })
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(Date.now() + 5 * DAY).toISOString() })
    return closedAppSummary(projection, Date.now(), lastOpenedAt)
  }
  const sync = (tag = PERIODIC_SYNC_TAG) => ({ tag })

  it('reports passed deadlines once, generically, when A.R.G.U.S. has not been opened recently', async () => {
    const worker = loadWorker()
    worker.putSummary(await summary(Date.now() - 2 * DAY))
    await worker.dispatch('periodicsync', sync())
    expect(worker.shown).toHaveLength(1)
    expect(worker.shown[0].title).toBe('A.R.G.U.S.: 4 preparation deadlines have passed')
    expect(worker.shown[0].options).toMatchObject({ tag: PERIODIC_SYNC_TAG, data: { argus: true, target: { tab: 'calendar' } } })
    expect(JSON.stringify(worker.shown)).not.toMatch(/Jordan|Rivera|C-7K4M|physical count/)
    await worker.dispatch('periodicsync', sync())
    expect(worker.shown).toHaveLength(1)
  })

  it('names the event kind when a single deadline has passed', async () => {
    const worker = loadWorker()
    worker.putSummary({ version: 1, updatedAt: Date.now() - DAY, lastOpenedAt: Date.now() - DAY, items: [
      { id: 'task-task_1', label: 'AMI preparation task', dueAt: Date.now() - HOUR, target: { tab: 'calendar' } },
      { id: 'task-task_2', label: 'AMI preparation task', dueAt: Date.now() + HOUR, target: { tab: 'calendar' } },
    ] })
    await worker.dispatch('periodicsync', sync())
    expect(worker.shown.map(entry => entry.title)).toEqual(['A.R.G.U.S.: AMI preparation task past due'])
  })

  it('stays quiet when the app was opened recently, is open now, lacks permission, or has no summary', async () => {
    const recent = loadWorker()
    recent.putSummary(await summary(Date.now() - HOUR))
    await recent.dispatch('periodicsync', sync())
    expect(recent.shown).toEqual([])

    const open = loadWorker({ windows: [fakeWindow()] })
    open.putSummary(await summary(Date.now() - 2 * DAY))
    await open.dispatch('periodicsync', sync())
    expect(open.shown).toEqual([])

    const denied = loadWorker({ permission: 'denied' })
    denied.putSummary(await summary(Date.now() - 2 * DAY))
    await denied.dispatch('periodicsync', sync())
    expect(denied.shown).toEqual([])

    const empty = loadWorker()
    await empty.dispatch('periodicsync', sync())
    await empty.dispatch('periodicsync', sync('something-else'))
    expect(empty.shown).toEqual([])
  })
})
