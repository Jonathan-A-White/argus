import { useEffect, useRef, useState } from 'react'
import type { ArgusAppProjection } from '../distributed/appIntegration'
import { alerts, type AlertTarget } from '../stage3/readiness'
import type { NotificationEnvironment } from './environment'
import { DeviceNotifier, NotificationHistoryStore } from './notifier'
import { MINUTE } from './policy'
import { onNotificationOpen } from './routing'

export const RECHECK_INTERVAL_MS = 5 * MINUTE

export type DeviceNotificationOptions = {
  /** The person's "Device notifications" setting (off by default). */
  enabled: boolean
  projection?: ArgusAppProjection
  sync?: { needsFunding?: boolean; state?: string; queued?: number }
  /** Alert ids acknowledged on this device; acknowledged alerts never notify. */
  acknowledged?: ReadonlySet<string>
  /** Navigate to an alert's target, exactly like clicking it on the dashboard. */
  onOpen: (target: AlertTarget) => void
  environment?: NotificationEnvironment
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  clock?: () => number
}

/**
 * Tier 2 device notifications while A.R.G.U.S. is unlocked (open or in a background tab). Decrypted
 * data only exists while unlocked, so this lives inside the unlocked app; a closed app is covered
 * only by the service worker's best-effort Periodic Background Sync check.
 */
export function useDeviceNotifications({ enabled, projection, sync = {}, acknowledged, onOpen, environment, storage, clock = Date.now }: DeviceNotificationOptions) {
  const [notifier] = useState(() => new DeviceNotifier(environment, new NotificationHistoryStore(storage)))
  const [tick, setTick] = useState(0)
  const onOpenRef = useRef(onOpen)
  const clockRef = useRef(clock)
  useEffect(() => {
    onOpenRef.current = onOpen
    clockRef.current = clock
  })

  // Notification clicks route even when the setting was turned off after the notification appeared.
  useEffect(() => onNotificationOpen(open => {
    notifier.markOpened(open.alertId, clockRef.current())
    onOpenRef.current(open.target)
  }), [notifier])

  useEffect(() => {
    let active = true
    const bump = () => { if (active) setTick(value => value + 1) }
    void notifier.setEnabled(enabled).then(bump, bump)
    if (!enabled) return () => { active = false }
    // Deadlines arrive with time, not only with new data, so re-check periodically and on tab switches.
    const timer = setInterval(bump, RECHECK_INTERVAL_MS)
    globalThis.document?.addEventListener('visibilitychange', bump)
    return () => {
      active = false
      clearInterval(timer)
      globalThis.document?.removeEventListener('visibilitychange', bump)
    }
  }, [enabled, notifier])

  const { needsFunding, state, queued } = sync
  useEffect(() => {
    if (!enabled || !projection) return
    const now = clockRef.current()
    notifier.evaluate({ alerts: alerts(projection, { needsFunding, state, queued }, new Date(now)), projection, now, ...(acknowledged ? { acknowledged } : {}) })
  }, [enabled, projection, needsFunding, state, queued, acknowledged, tick, notifier])
}
