import type { ArgusAppProjection } from '../distributed/appIntegration'
import type { SupplyEventKind } from '../distributed/types'
import { taskDueDate } from '../stage3/calendar'
import type { AlertSeverity, AlertTarget, SupplyAlert } from '../stage3/readiness'

/**
 * Device notification policy (master spec §20, tier 2). Pure: given the in-app alerts, the clock,
 * page visibility and this device's notification history, it decides what to show. It never
 * reads alert titles or details into a notification, because those can carry cadet IDs, names or
 * free text; every word shown on a lock screen is chosen here from a fixed vocabulary.
 */
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const NOTIFICATION_RULES = {
  /** A warning becomes notifiable once its deadline is this close. */
  warningWindowMs: DAY,
  /** The same alert in the same condition is shown at most once in this window. */
  dedupeMs: DAY,
  /** A changed condition may re-notify, but not sooner than this after the last one for that alert. */
  perAlertCooldownMs: HOUR,
  /** At most this many notifications per rolling window, across all alerts. */
  globalCap: 3,
  globalWindowMs: HOUR,
} as const

/** Optional fields other alert producers may add; read defensively, never required. */
export type AlertInput = SupplyAlert & { dueAt?: string | number | Date; acknowledged?: boolean }

export type NotificationCandidate = {
  /** Notification tag: repeats replace the previous notification. A supply event groups its task alerts. */
  id: string
  alertIds: string[]
  severity: AlertSeverity
  /** Changes when the underlying condition changes (a new overdue task, a different count). */
  fingerprint: string
  dueAt?: number
  title: string
  body: string
  target: AlertTarget
}

/** Device-local and plaintext: only alert ids, hashes and times, never alert text. */
export type NotificationHistory = {
  /** Last time A.R.G.U.S. was on screen (or opened from a notification). */
  lastOpenedAt?: number
  /** Notifiable conditions currently raised, with the time this device first saw each one. */
  raised: Record<string, { fingerprint: string; raisedAt: number }>
  /** `${id}|${fingerprint}` → when it was shown; kept for the dedupe window. */
  notified: Record<string, number>
}
export const emptyHistory = (): NotificationHistory => ({ raised: {}, notified: {} })

export type PolicyInput = {
  candidates: NotificationCandidate[]
  now: number
  /** Whether A.R.G.U.S. is on screen. Nothing is ever shown while it is. */
  visible: boolean
  history: NotificationHistory
  /** Alert ids acknowledged on this device. */
  acknowledged?: ReadonlySet<string>
}
export type PolicyDecision = {
  notify: NotificationCandidate[]
  /** Tags of notifications already shown that no longer apply (resolved, acknowledged, or the app was opened). */
  withdraw: string[]
  history: NotificationHistory
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }
const notifiedKey = (candidate: Pick<NotificationCandidate, 'id' | 'fingerprint'>) => `${candidate.id}|${candidate.fingerprint}`
const idOfKey = (key: string) => key.slice(0, key.lastIndexOf('|'))

/** Only critical alerts, and warnings whose deadline is within 24 hours, ever reach the device. */
export function isNotifiable(candidate: Pick<NotificationCandidate, 'severity' | 'dueAt'>, now: number) {
  if (candidate.severity === 'critical') return true
  return candidate.severity === 'warning' && candidate.dueAt !== undefined && candidate.dueAt - now <= NOTIFICATION_RULES.warningWindowMs
}

export function decideNotifications({ candidates, now, visible, history, acknowledged = new Set() }: PolicyInput): PolicyDecision {
  const lastOpenedAt = visible ? now : history.lastOpenedAt
  const notified = Object.fromEntries(Object.entries(history.notified).filter(([, at]) => now - at < NOTIFICATION_RULES.dedupeMs))
  const live = candidates
    .filter(candidate => isNotifiable(candidate, now) && !candidate.alertIds.every(id => acknowledged.has(id)))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
  const raised: NotificationHistory['raised'] = {}
  for (const candidate of live) {
    const previous = history.raised[candidate.id]
    raised[candidate.id] = previous && previous.fingerprint === candidate.fingerprint ? previous : { fingerprint: candidate.fingerprint, raisedAt: now }
  }
  const notify: NotificationCandidate[] = []
  if (!visible) {
    let recent = Object.values(notified).filter(at => now - at < NOTIFICATION_RULES.globalWindowMs).length
    for (const candidate of live) {
      if (recent >= NOTIFICATION_RULES.globalCap) break
      // The person has looked at A.R.G.U.S. since this condition arose: it is no longer news.
      if (lastOpenedAt !== undefined && lastOpenedAt >= raised[candidate.id].raisedAt) continue
      if (notified[notifiedKey(candidate)] !== undefined) continue
      const cooling = Object.entries(notified).some(([key, at]) => idOfKey(key) === candidate.id && now - at < NOTIFICATION_RULES.perAlertCooldownMs)
      if (cooling) continue
      notified[notifiedKey(candidate)] = now
      recent++
      notify.push(candidate)
    }
  }
  const liveIds = new Set(live.map(candidate => candidate.id))
  const shown = new Set(Object.keys(history.notified).map(idOfKey))
  const withdraw = [...shown].filter(id => visible || !liveIds.has(id))
  return { notify, withdraw, history: { ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}), raised, notified } }
}

/** Records that the person opened A.R.G.U.S. (for example from a notification): escalation stops. */
export function markOpened(history: NotificationHistory, now: number): NotificationHistory {
  return { ...history, lastOpenedAt: Math.max(now, history.lastOpenedAt ?? 0) }
}

/** FNV-1a: a short, non-reversible-in-practice condition fingerprint, so no alert text is stored. */
export function fingerprint(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const EVENT_LABEL: Record<SupplyEventKind, string> = {
  NCO: 'New Cadet Orientation',
  BLT: 'BLT',
  AMI: 'AMI',
  MILITARY_BALL: 'Military Ball',
  END_OF_YEAR: 'End-of-Year Count',
  CUSTOM: 'A supply event',
}
/** Generic label for a supply event: its kind, never its (free-text) title. */
export const eventLabel = (kind: SupplyEventKind) => EVENT_LABEL[kind] ?? EVENT_LABEL.CUSTOM
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const when = (startsAt: number, now: number) => {
  if (startsAt < now) return ''
  const days = Math.ceil((startsAt - now) / DAY)
  return days <= 0 ? ' today' : ` in ${plural(days, 'day')}`
}
const dueTime = (value: AlertInput['dueAt']) => {
  if (value === undefined) return undefined
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : undefined
}
const DESTINATION: Record<AlertTarget['tab'], string> = {
  count: 'Shared Count',
  inventory: 'Inventory',
  cadets: 'Cadets',
  activity: 'Activity',
  calendar: 'the Supply Calendar',
  more: 'the Command Center',
}
const destination = (target: AlertTarget) => DESTINATION[target.tab] ?? 'A.R.G.U.S.'

/** Fixed, non-identifying wording for one alert. Unknown alert kinds get a category phrase, never their text. */
function genericText(alert: SupplyAlert): { title: string; body: string } {
  const count = Number(/^\d+/.exec(alert.title)?.[0] ?? '0')
  const open = `Open A.R.G.U.S. to see ${destination(alert.target)}.`
  switch (alert.id) {
    case 'conflicts':
      return { title: 'A.R.G.U.S.: conflicts need a decision', body: `${count ? plural(count, 'unresolved conflict') : 'Unresolved conflicts'} from offline changes. ${open}` }
    case 'funding':
      return { title: 'A.R.G.U.S.: changes are waiting to publish', body: `This device needs testnet coins before its changes can reach the unit. ${open}` }
    case 'out-of-stock':
      return { title: 'A.R.G.U.S.: sizes out of stock', body: `${count ? plural(count, 'stocked size') : 'Stocked sizes'} out of stock while cadets hold that size. ${open}` }
  }
  const phrase = alert.target.panel === 'conflicts' ? 'conflicts need a decision'
    : alert.target.panel === 'wallet' ? 'synchronization needs attention'
    : alert.target.panel === 'diagnostics' ? 'a data check needs attention'
    : alert.target.panel === 'needed' ? 'Still Needed items need attention'
    : ({ calendar: 'a supply deadline needs attention', inventory: 'an inventory alert needs attention', cadets: 'a cadet record needs attention', count: 'a count needs attention', activity: 'recent activity needs review', more: 'a supply alert needs attention' } as const)[alert.target.tab] ?? 'a supply alert needs attention'
  return { title: `A.R.G.U.S.: ${alert.severity === 'critical' ? 'critical — ' : ''}${phrase}`, body: open }
}

/**
 * Turns in-app alerts into notification candidates. Calendar task alerts are grouped per supply
 * event ("AMI in 2 days — 3 preparation tasks overdue") so one event never produces a burst.
 */
export function notificationCandidates(alerts: readonly AlertInput[], projection: Pick<ArgusAppProjection, 'calendar'>, now: number): NotificationCandidate[] {
  const tasks = projection.calendar.flatMap(event => event.active ? event.tasks.map(task => ({ event, task, dueAt: new Date(taskDueDate(event.startsAt, task.dueOffsetDays)).getTime() })) : [])
  const groups = new Map<string, { event: (typeof tasks)[number]['event']; members: Array<{ alert: AlertInput; dueAt: number }> }>()
  const candidates: NotificationCandidate[] = []
  for (const alert of alerts) {
    const task = tasks.find(entry => alert.id.includes(entry.task.taskId))
    if (task) {
      const group = groups.get(task.event.calendarEventId) ?? { event: task.event, members: [] }
      group.members.push({ alert, dueAt: dueTime(alert.dueAt) ?? task.dueAt })
      groups.set(task.event.calendarEventId, group)
      continue
    }
    const text = genericText(alert)
    const dueAt = dueTime(alert.dueAt)
    candidates.push({ id: alert.id, alertIds: [alert.id], severity: alert.severity, fingerprint: fingerprint(`${alert.severity}|${alert.title}`), ...(dueAt !== undefined ? { dueAt } : {}), ...text, target: alert.target })
  }
  for (const { event, members } of groups.values()) {
    const overdue = members.filter(member => member.alert.severity === 'critical')
    const soon = members.filter(member => member.alert.severity === 'warning' && member.dueAt - now <= NOTIFICATION_RULES.warningWindowMs)
    const severity: AlertSeverity = overdue.length ? 'critical' : members.some(member => member.alert.severity === 'warning') ? 'warning' : 'info'
    const counted = overdue.length ? overdue : soon.length ? soon : members
    const parts = [
      ...(overdue.length ? [`${plural(overdue.length, 'preparation task')} overdue`] : []),
      ...(soon.length ? [`${plural(soon.length, 'preparation task')} due within a day`] : []),
    ]
    const ids = (list: typeof members) => list.map(member => member.alert.id).sort().join(',')
    candidates.push({
      id: `event-${event.calendarEventId}`,
      alertIds: members.map(member => member.alert.id),
      severity,
      fingerprint: fingerprint(`${severity}|overdue:${ids(overdue)}|soon:${ids(soon)}`),
      dueAt: Math.min(...counted.map(member => member.dueAt)),
      title: `A.R.G.U.S.: ${eventLabel(event.kind)}${when(new Date(event.startsAt).getTime(), now)} — ${parts[0] ?? 'preparation tasks coming due'}`,
      body: `${parts.length > 1 ? `${parts.slice(1).join(' · ')}. ` : ''}Open A.R.G.U.S. to see ${destination(members[0].alert.target)}.`,
      target: members[0].alert.target,
    })
  }
  return candidates
}

export const acknowledgedIds = (alerts: readonly AlertInput[], acknowledged: ReadonlySet<string> = new Set()) =>
  new Set([...acknowledged, ...alerts.filter(alert => alert.acknowledged === true).map(alert => alert.id)])

/** Whole pipeline: acknowledged alerts leave first (so a group only counts what is still open), then the policy decides. */
export function planDeviceNotifications(input: { alerts: readonly AlertInput[]; projection: Pick<ArgusAppProjection, 'calendar'>; now: number; visible: boolean; history: NotificationHistory; acknowledged?: ReadonlySet<string> }): PolicyDecision & { candidates: NotificationCandidate[] } {
  const acknowledged = acknowledgedIds(input.alerts, input.acknowledged)
  const candidates = notificationCandidates(input.alerts.filter(alert => !acknowledged.has(alert.id)), input.projection, input.now)
  return { ...decideNotifications({ candidates, now: input.now, visible: input.visible, history: input.history, acknowledged }), candidates }
}

/* ------------------------------------------------------------------------------------------------
 * Closed-app summary for Periodic Background Sync. Stored in plaintext Cache storage so the service
 * worker can read it without the passphrase, so it holds only: an opaque id, a generic label (the
 * event kind), a due time, a severity and where to navigate. No cadet, name, item or free text.
 * --------------------------------------------------------------------------------------------- */
export const CLOSED_APP_HORIZON = { pastMs: 14 * DAY, aheadMs: 45 * DAY, maxItems: 25 } as const
export type ClosedAppItem = { id: string; label: string; dueAt: number; target: AlertTarget }
export type ClosedAppSummary = { version: 1; updatedAt: number; lastOpenedAt: number; items: ClosedAppItem[] }

export function closedAppSummary(projection: Pick<ArgusAppProjection, 'calendar'>, now: number, lastOpenedAt: number, acknowledged: ReadonlySet<string> = new Set()): ClosedAppSummary {
  const items = projection.calendar
    .filter(event => event.active)
    .flatMap(event => event.tasks.filter(task => !task.completed).map(task => ({
      id: `task-${task.taskId}`,
      label: `${eventLabel(event.kind)} preparation task`,
      dueAt: new Date(taskDueDate(event.startsAt, task.dueOffsetDays)).getTime(),
      target: { tab: 'calendar' } as AlertTarget,
    })))
    .filter(item => !acknowledged.has(item.id) && item.dueAt >= now - CLOSED_APP_HORIZON.pastMs && item.dueAt <= now + CLOSED_APP_HORIZON.aheadMs)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, CLOSED_APP_HORIZON.maxItems)
  return { version: 1, updatedAt: now, lastOpenedAt, items }
}
