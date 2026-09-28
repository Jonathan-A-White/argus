import type { ArgusAppProjection } from '../distributed/appIntegration'
import { isVerified } from '../distributed/delivery'
import { taskDueDate } from './calendar'

/**
 * Readiness engine (master spec §35) and in-app alerts (§20 tier 1), derived purely from the
 * shared projection so every device computes the same numbers. Weights are equal for now and live
 * in one place so they can become configurable.
 */
export type ReadinessBreakdown = { cadets: number; inventory: number; events: number; audit: number; overall: number; cadetsNeedingItems: number; stockNeedingAttention: number; activePreparations: number }
export type AlertSeverity = 'critical' | 'warning' | 'info'
export type AlertTarget = { tab: 'count' | 'inventory' | 'cadets' | 'activity' | 'calendar' | 'more'; panel?: 'conflicts' | 'needed' | 'wallet' | 'diagnostics' }
export type SupplyAlert = { id: string; severity: AlertSeverity; title: string; detail: string; target: AlertTarget }
export const READINESS_WEIGHTS = { cadets: 1, inventory: 1, events: 1, audit: 1 }

const DAY = 86_400_000
const percent = (part: number, whole: number) => whole ? Math.round(100 * part / whole) : 100

export function upcomingEvents(projection: Pick<ArgusAppProjection, 'calendar'>, now = new Date()) {
  return projection.calendar.filter(event => event.active && new Date(event.startsAt).getTime() >= now.getTime() - 7 * DAY).sort((a, b) => a.startsAt < b.startsAt ? -1 : 1)
}

/** A stocked size needs attention when it is at or below its low-stock threshold, or empty while cadets hold that size. */
export function stockNeedsAttention(item: ArgusAppProjection['inventory'][number]) {
  return item.active && ((item.reorderAt !== undefined && item.onHand <= item.reorderAt) || (item.onHand === 0 && item.issued > 0))
}

/**
 * Audit readiness (spec §35) counts only records VERIFIED on chain: mined, with a known block
 * height. A record that is queued, publishing, merely broadcast, or only on this device is not
 * verified yet, however the rest of the app treats it.
 */
export function auditSummary(projection: Pick<ArgusAppProjection, 'events'>) {
  const verified = projection.events.filter(isVerified).length
  const awaitingBlock = projection.events.filter(record => !isVerified(record) && record.syncStatus === 'SYNCHRONIZED').length
  const notOnChain = projection.events.filter(record => record.syncStatus !== 'SYNCHRONIZED' && record.syncStatus !== 'CONFLICT' && !isVerified(record)).length
  return { total: projection.events.length, verified, awaitingBlock, notOnChain }
}

export function readiness(projection: ArgusAppProjection, now = new Date()): ReadinessBreakdown {
  const activeCadets = projection.cadets.filter(cadet => cadet.status === 'ACTIVE')
  const cadetsNeedingItems = activeCadets.filter(cadet => cadet.stillNeededCount > 0).length
  const tracked = projection.inventory.filter(item => item.active && (item.reorderAt !== undefined || item.issued > 0 || item.onHand > 0))
  const stockNeedingAttention = projection.inventory.filter(stockNeedsAttention).length
  const next = upcomingEvents(projection, now).filter(event => new Date(event.startsAt).getTime() >= now.getTime())
  const activePreparations = next.filter(event => new Date(event.startsAt).getTime() - now.getTime() <= 60 * DAY).length
  const nextEvent = next[0]
  const events = nextEvent ? percent(nextEvent.tasks.filter(task => task.completed).length, nextEvent.tasks.length) : 100
  const audit = percent(auditSummary(projection).verified, projection.events.length)
  const parts = { cadets: percent(activeCadets.length - cadetsNeedingItems, activeCadets.length), inventory: percent(tracked.length - tracked.filter(stockNeedsAttention).length, tracked.length), events, audit }
  const weight = Object.values(READINESS_WEIGHTS).reduce((sum, value) => sum + value, 0)
  const overall = Math.round((parts.cadets * READINESS_WEIGHTS.cadets + parts.inventory * READINESS_WEIGHTS.inventory + parts.events * READINESS_WEIGHTS.events + parts.audit * READINESS_WEIGHTS.audit) / weight)
  return { ...parts, overall, cadetsNeedingItems, stockNeedingAttention, activePreparations }
}

export function alerts(projection: ArgusAppProjection, sync: { needsFunding?: boolean; state?: string; queued?: number } = {}, now = new Date()): SupplyAlert[] {
  const list: SupplyAlert[] = []
  const conflicts = projection.conflicts.filter(conflict => conflict.status === 'OPEN').length
  if (conflicts) list.push({ id: 'conflicts', severity: 'critical', title: `${conflicts} unresolved conflict${conflicts === 1 ? '' : 's'}`, detail: 'Competing offline changes need a decision.', target: { tab: 'more', panel: 'conflicts' } })
  if (sync.needsFunding) list.push({ id: 'funding', severity: 'critical', title: 'This device needs testnet coins', detail: `${sync.queued ?? 0} change(s) are waiting to publish.`, target: { tab: 'more', panel: 'wallet' } })
  else if (sync.state === 'error') list.push({ id: 'sync', severity: 'warning', title: 'Synchronization issue', detail: 'Work is saved on this device and will publish when the testnet service responds.', target: { tab: 'more', panel: 'wallet' } })
  const out = projection.inventory.filter(item => item.active && item.onHand === 0 && item.issued > 0)
  const low = projection.inventory.filter(item => item.active && item.reorderAt !== undefined && item.onHand > 0 && item.onHand <= item.reorderAt)
  if (out.length) list.push({ id: 'out-of-stock', severity: 'critical', title: `${out.length} size${out.length === 1 ? '' : 's'} out of stock`, detail: out.slice(0, 3).map(item => `${item.name} · ${item.variant}`).join(', '), target: { tab: 'inventory' } })
  if (low.length) list.push({ id: 'low-stock', severity: 'warning', title: `${low.length} size${low.length === 1 ? '' : 's'} low on stock`, detail: low.slice(0, 3).map(item => `${item.name} · ${item.variant} (${item.onHand})`).join(', '), target: { tab: 'inventory' } })
  const incomplete = projection.cadets.filter(cadet => cadet.status === 'ACTIVE' && cadet.stillNeededCount > 0).length
  if (incomplete) list.push({ id: 'cadets-incomplete', severity: 'warning', title: `${incomplete} cadet${incomplete === 1 ? '' : 's'} still need items`, detail: 'See Still Needed for what is missing and whether it is in stock.', target: { tab: 'more', panel: 'needed' } })
  const unsized = projection.catalog.filter(item => item.active && item.sized && !projection.inventory.some(variant => variant.catalogId === item.catalogId)).length
  if (unsized) list.push({ id: 'sizes-not-set', severity: 'info', title: `${unsized} item${unsized === 1 ? '' : 's'} have no sizes yet`, detail: 'Add the sizes your unit stocks before counting or issuing them.', target: { tab: 'inventory' } })
  for (const event of upcomingEvents(projection, now)) {
    for (const task of event.tasks.filter(candidate => !candidate.completed)) {
      const due = new Date(taskDueDate(event.startsAt, task.dueOffsetDays)).getTime(), days = Math.ceil((due - now.getTime()) / DAY)
      if (days < 0) list.push({ id: `task-${task.taskId}`, severity: 'critical', title: `Overdue: ${task.title}`, detail: `${event.title} · due ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`, target: { tab: 'calendar' } })
      else if (days <= 3) list.push({ id: `task-${task.taskId}`, severity: 'warning', title: `Due ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}: ${task.title}`, detail: event.title, target: { tab: 'calendar' } })
    }
  }
  if (projection.rejected.length) list.push({ id: 'rejected', severity: 'info', title: `${projection.rejected.length} record${projection.rejected.length === 1 ? '' : 's'} not applied`, detail: 'Usually waiting for another device’s records; see Diagnostics.', target: { tab: 'more', panel: 'diagnostics' } })
  const order: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }
  return list.sort((a, b) => order[a.severity] - order[b.severity])
}
