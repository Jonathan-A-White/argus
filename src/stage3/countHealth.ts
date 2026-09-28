import type { ArgusAppProjection } from '../distributed/appIntegration'
import type { CountSessionProjection, InventoryProjection } from '../distributed/types'

/**
 * Physical-count health shared by AMI readiness (§17), the End-of-Year review (§19) and the count
 * alerts (§20). Only finalized (RECONCILED) sessions count as a completed count.
 */
export const COUNT_WINDOW_DAYS = 30
export const STALE_COUNT_DAYS = 7
const DAY = 86_400_000

type Projection = Pick<ArgusAppProjection, 'inventory' | 'countSessions'>
const age = (iso: string | undefined, now: Date) => (iso ? now.getTime() - Date.parse(iso) : Number.POSITIVE_INFINITY)

/** Finalized sessions within the window, newest first. */
export function finalizedSessions(sessions: CountSessionProjection[], now: Date, days = COUNT_WINDOW_DAYS) {
  return sessions
    .filter(session => session.status === 'RECONCILED' && age(session.reconciledAt, now) <= days * DAY)
    .sort((a, b) => (b.reconciledAt ?? '').localeCompare(a.reconciledAt ?? '') || a.sessionId.localeCompare(b.sessionId))
}

export type CountCoverage = { counted: number; total: number; percent: number; uncounted: InventoryProjection[]; windowDays: number }
/** Share of active sizes counted in a finalized count within the window. No sizes at all is 0%, never "done". */
export function countCoverage(projection: Projection, now: Date, days = COUNT_WINDOW_DAYS): CountCoverage {
  const active = projection.inventory.filter(item => item.active)
  const counted = new Set(finalizedSessions(projection.countSessions, now, days).flatMap(session => Object.keys(session.totals)))
  const uncounted = active.filter(item => !counted.has(item.entityId))
  return { counted: active.length - uncounted.length, total: active.length, percent: active.length ? Math.round((100 * (active.length - uncounted.length)) / active.length) : 0, uncounted, windowDays: days }
}

export type CountDiscrepancy = { sessionId: string; scope: string; itemId: string; name: string; variant: string; expected: number; counted: number; difference: number; reconciledAt: string; movement: boolean }
/**
 * Sizes whose most recent finalized count (within the window) differed from what the records
 * expected when the count started, or whose stock moved while it was being counted.
 */
export function countDiscrepancies(projection: Projection, now: Date, days = COUNT_WINDOW_DAYS): CountDiscrepancy[] {
  const seen = new Set<string>(), list: CountDiscrepancy[] = []
  for (const session of finalizedSessions(projection.countSessions, now, days)) {
    for (const [itemId, counted] of Object.entries(session.totals).sort(([a], [b]) => a.localeCompare(b))) {
      if (seen.has(itemId)) continue
      seen.add(itemId)
      const expected = session.baseline[itemId]?.quantity, movement = Boolean(session.movementWarnings?.includes(itemId))
      if (expected === undefined || (expected === counted && !movement)) continue
      const item = projection.inventory.find(candidate => candidate.entityId === itemId)
      list.push({ sessionId: session.sessionId, scope: session.scope, itemId, name: item?.name ?? 'Unknown item', variant: item?.variant ?? '', expected, counted, difference: counted - expected, reconciledAt: session.reconciledAt ?? '', movement })
    }
  }
  return list
}

/** Finalized sessions in the window that left counts out because they arrived after the cutoff. */
export const lateCountSessions = (projection: Projection, now: Date, days = COUNT_WINDOW_DAYS) => finalizedSessions(projection.countSessions, now, days).filter(session => session.lateEventIds.length > 0)

export type ReconciliationIssue = { sessionId: string; scope: string; reason: 'SUBMITTED' | 'LATE_WORK' | 'OPEN_TOO_LONG'; days: number }
/** Counts that need an officer: submitted but not finalized, holding late work, or open longer than a week. */
export function reconciliationIssues(projection: Projection, now: Date): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = []
  for (const session of [...projection.countSessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const days = Math.floor(age(session.createdAt, now) / DAY)
    if (session.status === 'SUBMITTED') issues.push({ sessionId: session.sessionId, scope: session.scope, reason: session.lateEventIds.length ? 'LATE_WORK' : 'SUBMITTED', days })
    else if ((session.status === 'ACTIVE' || session.status === 'DRAFT') && Number.isFinite(days) && days > STALE_COUNT_DAYS) issues.push({ sessionId: session.sessionId, scope: session.scope, reason: 'OPEN_TOO_LONG', days })
  }
  return issues
}

export const openCountSessions = (projection: Pick<Projection, 'countSessions'>) => projection.countSessions.filter(session => session.status === 'ACTIVE' || session.status === 'SUBMITTED' || session.status === 'DRAFT')
