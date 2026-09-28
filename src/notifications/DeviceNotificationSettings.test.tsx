import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceNotificationSettings } from './DeviceNotificationSettings'
import { browserNotificationEnvironment, type NotificationEnvironment } from './environment'
import { NOTIFICATION_TEXT } from './text'

/** Stand-in for the browser's Notification API: `next` is what the permission prompt answers. */
class FakeNotification {
  static permission: NotificationPermission = 'default'
  static next: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => { FakeNotification.permission = FakeNotification.next; return FakeNotification.permission })
  static created: FakeNotification[] = []
  onclick: (() => void) | null = null
  constructor(public title: string, public options?: NotificationOptions) { FakeNotification.created.push(this) }
  close() {}
}

function Harness({ initial = false, onChange = () => undefined, environment }: { initial?: boolean; onChange?: (enabled: boolean) => void; environment?: NotificationEnvironment }) {
  const [enabled, setEnabled] = useState(initial)
  return <DeviceNotificationSettings enabled={enabled} onChange={next => { onChange(next); setEnabled(next) }} {...(environment ? { environment } : {})} />
}
const toggle = () => screen.getByRole('switch', { name: 'Device notifications' })

beforeEach(() => {
  FakeNotification.permission = 'default'
  FakeNotification.next = 'granted'
  FakeNotification.requestPermission.mockClear()
  FakeNotification.created = []
  vi.stubGlobal('Notification', FakeNotification)
})
afterEach(() => vi.unstubAllGlobals())

describe('Device notifications setting', () => {
  it('is off by default, explains itself, and turns on only after permission is granted', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    expect(toggle()).not.toBeChecked()
    expect(screen.getByText(NOTIFICATION_TEXT.intro)).toBeInTheDocument()
    expect(screen.getByText(NOTIFICATION_TEXT.whileOpen)).toBeInTheDocument()
    expect(screen.getByText(NOTIFICATION_TEXT.noServer)).toBeInTheDocument()
    // jsdom has no Periodic Background Sync, like Firefox and Safari.
    expect(await screen.findByText(NOTIFICATION_TEXT.closedUnsupported)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send a test notification' })).not.toBeInTheDocument()

    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toBeChecked())
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole('status')).toHaveTextContent(NOTIFICATION_TEXT.on)

    fireEvent.click(screen.getByRole('button', { name: 'Send a test notification' }))
    await screen.findByText(NOTIFICATION_TEXT.testSent)
    expect(FakeNotification.created).toHaveLength(1)
    expect(FakeNotification.created[0]).toMatchObject({ title: 'A.R.G.U.S. test notification', options: { tag: 'argus-test' } })

    fireEvent.click(toggle())
    expect(toggle()).not.toBeChecked()
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByRole('status')).toHaveTextContent(NOTIFICATION_TEXT.off)
  })

  it('stays off and explains how to allow notifications when the prompt is denied', async () => {
    FakeNotification.next = 'denied'
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTIFICATION_TEXT.denied)
    expect(toggle()).not.toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not prompt again when notifications are already blocked for the site', async () => {
    FakeNotification.permission = 'denied'
    render(<Harness />)
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTIFICATION_TEXT.denied)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(toggle()).not.toBeChecked()
  })

  it('stays off when the prompt is dismissed without an answer', async () => {
    FakeNotification.next = 'default'
    render(<Harness />)
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTIFICATION_TEXT.dismissed)
    expect(toggle()).not.toBeChecked()
  })

  it('warns when it is on but the browser has since blocked notifications', () => {
    FakeNotification.permission = 'denied'
    render(<Harness initial />)
    expect(screen.getByRole('alert')).toHaveTextContent(NOTIFICATION_TEXT.blockedWhileOn)
    expect(screen.queryByRole('button', { name: 'Send a test notification' })).not.toBeInTheDocument()
  })

  it('says so, and never turns on, in a browser without notifications', async () => {
    vi.stubGlobal('Notification', undefined)
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    expect(screen.getByText(NOTIFICATION_TEXT.unsupported)).toBeInTheDocument()
    expect(screen.queryByText(NOTIFICATION_TEXT.whileOpen)).not.toBeInTheDocument()
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTIFICATION_TEXT.unsupported)
    expect(toggle()).not.toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('tells iPhone and iPad users to add A.R.G.U.S. to the Home Screen first', async () => {
    vi.stubGlobal('Notification', undefined)
    render(<Harness environment={{ ...browserNotificationEnvironment, platform: () => ({ ios: true, standalone: false }) }} />)
    expect(screen.getByText(NOTIFICATION_TEXT.ios)).toBeInTheDocument()
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent('Add to Home Screen')
  })

  it('reports closed-app checks for an installed app, and what is missing otherwise', async () => {
    const view = render(<Harness environment={{ ...browserNotificationEnvironment, closedAppSupport: async () => 'available' }} />)
    expect(await screen.findByText(NOTIFICATION_TEXT.closedAvailable)).toBeInTheDocument()
    view.unmount()
    render(<Harness environment={{ ...browserNotificationEnvironment, closedAppSupport: async () => 'needs-install' }} />)
    expect(await screen.findByText(NOTIFICATION_TEXT.closedNeedsInstall)).toBeInTheDocument()
  })
})
