import { useEffect, useRef, useState } from 'react'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { CalendarEventProjection, CalendarTaskProjection, SupplyEventKind } from '../../distributed/types'
import { taskDueDate } from '../../stage3/calendar'
import { upcomingEvents } from '../../stage3/readiness'
import { plural } from '../../plural'

/**
 * Pure helpers shared by the Supply Calendar and the Dashboard. Everything here is derived from
 * the shared projection plus an injectable clock, so every device shows the same countdowns and
 * readiness for the same moment.
 */

type Bundle = ArgusAppProjection['bundles'][number]
type InventoryItem = ArgusAppProjection['inventory'][number]

export const DAY_MS = 86_400_000

/** Default clock. Module-level so hooks that depend on it stay stable between renders. */
export const systemClock = () => new Date()

/** Short badge text per event kind; templates supply the full title. */
export const KIND_LABEL: Record<SupplyEventKind, string> = {
  NCO: 'NCO',
  BLT: 'BLT',
  AMI: 'AMI',
  MILITARY_BALL: 'Military Ball',
  END_OF_YEAR: 'End-of-Year',
  CUSTOM: 'Custom',
}

/** Events that issue bundles in bulk, so the stock behind each bundle is worth showing. */
export const STOCKED_KINDS: readonly SupplyEventKind[] = ['NCO', 'BLT', 'MILITARY_BALL']

export const errorMessage = (reason: unknown, fallback = 'That change could not be saved. Please try again.') =>
  reason instanceof Error && reason.message ? reason.message : fallback

/**
 * Current time from an injectable clock, refreshed every `intervalMs`. The latest clock is kept in
 * a ref so a host that passes a new function each render does not keep resetting the interval.
 */
export function useClock(now: () => Date, intervalMs: number) {
  const source = useRef(now)
  const [current, setCurrent] = useState(() => now())
  useEffect(() => {
    source.current = now
  }, [now])
  useEffect(() => {
    const timer = setInterval(() => setCurrent(source.current()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return current
}

// ---------- dates ----------

const localMidnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/** Whole local calendar days from `now` until `when` (negative = in the past). */
export const daysUntil = (when: string | Date, now: Date) =>
  Math.round((localMidnight(new Date(when)) - localMidnight(now)) / DAY_MS)


/** "in 12 days", "tomorrow", "today", "yesterday", "3 days ago". */
export function countdownLabel(days: number) {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 0 ? `in ${days} days` : `${-days} days ago`
}

/** Task offset relative to the event: "14 days before", "On the event day", "2 days after". */
export function offsetLabel(offset: number) {
  if (offset === 0) return 'On the event day'
  return `${plural(Math.abs(offset), 'day')} ${offset < 0 ? 'before' : 'after'}`
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
export const formatShortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** Calendar-leaf date block: { month: 'OCT', day: '9' }. */
export function dateBlock(iso: string) {
  const date = new Date(iso)
  return { month: date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(), day: String(date.getDate()) }
}

const pad = (value: number) => String(value).padStart(2, '0')
/** ISO instant → value for <input type="date"> in local time. */
export const toDateInput = (iso: string) => {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
/** ISO instant → value for <input type="time"> in local time. */
export const toTimeInput = (iso: string) => {
  const date = new Date(iso)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Local date and time inputs → ISO instant. Returns a readable error instead when either is
 * missing, because dates are always entered by hand (spec §14) and must never be guessed.
 */
export function fromDateTimeInputs(date: string, time: string): { startsAt: string } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Enter the event date.' }
  if (!/^\d{2}:\d{2}$/.test(time)) return { error: 'Enter the event time.' }
  const value = new Date(`${date}T${time}`)
  return Number.isNaN(value.getTime()) ? { error: 'Enter a valid date and time.' } : { startsAt: value.toISOString() }
}

// ---------- events and tasks ----------

export type EventProgress = { done: number; total: number; percent: number }

/**
 * Completed tasks / tasks, for progress bars. An event without tasks has no progress to show (0%,
 * next to "No tasks yet"), never a full bar; the readiness engine scores events separately.
 */
export function eventProgress(event: Pick<CalendarEventProjection, 'tasks'>): EventProgress {
  const total = event.tasks.length
  const done = event.tasks.filter(task => task.completed).length
  return { done, total, percent: total ? Math.round((100 * done) / total) : 0 }
}

/** Tasks in due order; template order is kept for tasks due the same day. */
export const sortTasks = (tasks: CalendarTaskProjection[]) =>
  [...tasks].sort((a, b) => a.dueOffsetDays - b.dueOffsetDays)

export const taskDueAt = (event: Pick<CalendarEventProjection, 'startsAt'>, task: Pick<CalendarTaskProjection, 'dueOffsetDays'>) =>
  taskDueDate(event.startsAt, task.dueOffsetDays)

export type TaskTone = 'done' | 'overdue' | 'soon' | 'later'
export type TaskStatus = { tone: TaskTone; label: string }

export function taskStatus(
  event: Pick<CalendarEventProjection, 'startsAt'>,
  task: CalendarTaskProjection,
  now: Date,
  memberName: (publicIdentity: string) => string,
): TaskStatus {
  if (task.completed) {
    const who = task.completedBy ? memberName(task.completedBy) : 'a unit member'
    const when = task.completedAt ? ` on ${formatShortDate(task.completedAt)}` : ''
    return { tone: 'done', label: `Done by ${who}${when}` }
  }
  const days = daysUntil(taskDueAt(event, task), now)
  if (days < 0) return { tone: 'overdue', label: 'Overdue' }
  if (days === 0) return { tone: 'soon', label: 'Due today' }
  if (days === 1) return { tone: 'soon', label: 'Due tomorrow' }
  return { tone: days <= 3 ? 'soon' : 'later', label: `Due in ${days} days` }
}

export const overdueTasks = (event: CalendarEventProjection, now: Date) =>
  event.tasks.filter(task => !task.completed && daysUntil(taskDueAt(event, task), now) < 0)

/**
 * Upcoming = active events from a week ago onward (the same window the alert engine watches, so
 * post-event tasks stay visible); past = older active events, newest first; cancelled = inactive.
 */
export function partitionEvents(calendar: CalendarEventProjection[], now: Date) {
  const upcoming = upcomingEvents({ calendar }, now)
  const current = new Set(upcoming.map(event => event.calendarEventId))
  const byDateDesc = (a: CalendarEventProjection, b: CalendarEventProjection) => (a.startsAt < b.startsAt ? 1 : -1)
  return {
    upcoming,
    past: calendar.filter(event => event.active && !current.has(event.calendarEventId)).sort(byDateDesc),
    cancelled: calendar.filter(event => !event.active).sort(byDateDesc),
  }
}

/** The event the dashboard counts down to: the next one today or later, else the most recent one still in its follow-up window. */
export function nextSupplyEvent(projection: Pick<ArgusAppProjection, 'calendar'>, now: Date) {
  const upcoming = upcomingEvents(projection, now)
  return upcoming.find(event => daysUntil(event.startsAt, now) >= 0) ?? upcoming.at(-1)
}

// ---------- bundles ----------

export const currentBundleVersion = (bundle: Bundle) =>
  bundle.versions.find(version => version.version === bundle.currentVersion)

export const bundleName = (bundle: Bundle) => currentBundleVersion(bundle)?.displayName ?? bundle.bundleId

export type BundleStock = { bundleId: string; name: string; ready: number; total: number; missing: string[] }

/** A bundle line is stock-ready when at least one active size of its catalog item (or its pinned SKU) is on hand. */
export function bundleStockReadiness(bundle: Bundle, inventory: InventoryItem[]): BundleStock {
  const lines = [...(currentBundleVersion(bundle)?.lines ?? [])].sort((a, b) => a.order - b.order)
  const inStock = (line: (typeof lines)[number]) =>
    inventory.some(
      item =>
        item.active &&
        item.onHand > 0 &&
        ((line.catalogId !== undefined && item.catalogId === line.catalogId) || (line.itemId !== undefined && item.entityId === line.itemId)),
    )
  const missing = lines.filter(line => !inStock(line)).map(line => line.displayLabel)
  return { bundleId: bundle.bundleId, name: bundleName(bundle), ready: lines.length - missing.length, total: lines.length, missing }
}
