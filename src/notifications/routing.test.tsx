import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { DistributedAppController } from '../distributed/appIntegration'
import { DEFAULT_SETTINGS, LocalSettingsStorage, SETTINGS_KEY } from '../settings'
import { MemoryRepository } from '../storage/repository'
import { DAY } from './policy'
import {
  NOTIFICATION_OPEN_MESSAGE,
  installNotificationRouter,
  notificationOpenFromUrl,
  onNotificationOpen,
  parseNotificationOpen,
  resetNotificationRouting,
  withoutOpenParams,
} from './routing'

const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key), values } }
const openMessage = (target: unknown, alertId = 'conflicts') => new MessageEvent('message', { data: { type: NOTIFICATION_OPEN_MESSAGE, alertId, target } })

afterEach(() => resetNotificationRouting())

describe('notification open messages', () => {
  it('accepts only well-formed opens with a known destination', () => {
    expect(parseNotificationOpen({ type: NOTIFICATION_OPEN_MESSAGE, alertId: 'conflicts', target: { tab: 'more', panel: 'conflicts' } })).toEqual({ alertId: 'conflicts', target: { tab: 'more', panel: 'conflicts' } })
    expect(parseNotificationOpen({ type: NOTIFICATION_OPEN_MESSAGE, alertId: 'x', target: { tab: 'calendar', panel: 'members-admin' } })).toEqual({ alertId: 'x', target: { tab: 'calendar' } })
    expect(parseNotificationOpen({ type: NOTIFICATION_OPEN_MESSAGE, alertId: 'x', target: { tab: 'javascript:alert(1)' } })).toBeUndefined()
    expect(parseNotificationOpen({ type: 'ARGUS_ACTIVATE_UPDATE' })).toBeUndefined()
    expect(parseNotificationOpen({ type: NOTIFICATION_OPEN_MESSAGE, target: { tab: 'calendar' } })).toBeUndefined()
    expect(parseNotificationOpen('ARGUS_NOTIFICATION_OPEN')).toBeUndefined()
  })

  it('reads an open from the URL the service worker opens, and strips it afterwards', () => {
    const href = 'https://example.test/argus/?argus-alert=event-1&argus-tab=more&argus-panel=diagnostics'
    expect(notificationOpenFromUrl(href)).toEqual({ alertId: 'event-1', target: { tab: 'more', panel: 'diagnostics' } })
    expect(notificationOpenFromUrl('https://example.test/argus/')).toBeUndefined()
    expect(withoutOpenParams(href)).toBe('https://example.test/argus/')

    const replaceState = vi.fn()
    const opens: unknown[] = []
    installNotificationRouter({ location: { href }, history: { replaceState } })
    onNotificationOpen(open => opens.push(open))
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://example.test/argus/')
    expect(opens).toEqual([{ alertId: 'event-1', target: { tab: 'more', panel: 'diagnostics' } }])
  })

  it('holds a click that arrives before the app is unlocked, then delivers it once', () => {
    const worker = new EventTarget()
    installNotificationRouter({ serviceWorker: worker as ServiceWorkerContainer })
    worker.dispatchEvent(openMessage({ tab: 'calendar' }, 'event-9'))
    const first = vi.fn(), second = vi.fn()
    const stop = onNotificationOpen(first)
    onNotificationOpen(second)
    expect(first).toHaveBeenCalledWith({ alertId: 'event-9', target: { tab: 'calendar' } })
    expect(second).not.toHaveBeenCalled()
    stop()
    worker.dispatchEvent(openMessage({ tab: 'inventory' }, 'out-of-stock'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ alertId: 'out-of-stock', target: { tab: 'inventory' } })
  })
})

describe('notification clicks in the app', { timeout: 30_000 }, () => {
  let worker: EventTarget
  beforeEach(() => {
    worker = new EventTarget()
    installNotificationRouter({ serviceWorker: worker as ServiceWorkerContainer })
  })

  it('routes a service worker click message exactly like a dashboard alert click', async () => {
    render(<App controller={new DistributedAppController(new MemoryRepository())} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    expect(await screen.findByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByRole('switch', { name: 'Device notifications' })).not.toBeChecked()

    act(() => { worker.dispatchEvent(openMessage({ tab: 'calendar' }, 'event-1')) })
    expect(await screen.findByRole('heading', { name: 'Supply Calendar', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()

    act(() => { worker.dispatchEvent(openMessage({ tab: 'more', panel: 'diagnostics' }, 'rejected')) })
    expect(await screen.findByRole('heading', { name: 'Command Center', level: 1 })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog', { name: 'Diagnostics' })).getByText('Data integrity healthy')).toBeInTheDocument()
  })

  it('shows a generic page notification for an overdue event while hidden, and its click opens the calendar', async () => {
    const created: Array<{ title: string; options?: NotificationOptions; onclick: null | (() => void) }> = []
    vi.stubGlobal('Notification', class {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      onclick: null | (() => void) = null
      constructor(public title: string, public options?: NotificationOptions) { created.push(this) }
      close() {}
    })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    try {
      const controller = new DistributedAppController(new MemoryRepository())
      await controller.initialize()
      await controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', fullName: 'Jordan Rivera', cadetCode: 'C-7K4M' })
      await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(Date.now() + 2 * DAY - 60_000).toISOString() })
      const preferences = memoryStorage()
      preferences.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, deviceNotifications: true }))
      render(<App controller={controller} settingsStorage={new LocalSettingsStorage(preferences)} />)
      expect(await screen.findByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument()
      await vi.waitFor(() => expect(created).toHaveLength(1))
      expect(created[0].title).toBe('A.R.G.U.S.: AMI in 2 days — 5 preparation tasks overdue')
      expect(created[0].options).toMatchObject({ tag: expect.stringMatching(/^event-calendar_/), data: { argus: true, target: { tab: 'calendar' } } })
      expect(JSON.stringify(created[0])).not.toMatch(/Jordan|Rivera|C-7K4M/)

      act(() => created[0].onclick?.())
      expect(await screen.findByRole('heading', { name: 'Supply Calendar', level: 1 })).toBeInTheDocument()
      expect(focus).toHaveBeenCalled()
    } finally {
      visibility.mockRestore()
      focus.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
