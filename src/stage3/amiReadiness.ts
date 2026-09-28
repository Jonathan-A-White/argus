import type { ArgusAppProjection } from '../distributed/appIntegration'
import type { CadetProjection, CalendarEventProjection } from '../distributed/types'
import { calendarDaysUntil } from './calendar'
import { COUNT_WINDOW_DAYS, countCoverage, countDiscrepancies, lateCountSessions } from './countHealth'
import type { AlertTarget, SyncSnapshot } from './readinessTypes'
import { heldByCatalog, recordedSize, requiredItemsFor, standardIssueBundles } from './requirements'
import { plural } from '../plural'

/**
 * AMI readiness dashboard (master spec §17). Six categories, each a 0–100 score with a plain
 * explanation and the screen that fixes it. Pure: the same projection, sync snapshot and clock
 * give the same report on every device.
 */
export type AmiCategoryKey = 'inventory-count' | 'cadet-records' | 'corrections' | 'still-needed' | 'audit' | 'sync'
export type AmiCategory = { key: AmiCategoryKey; label: string; percent: number; detail: string; target: AlertTarget }
export type AmiReadiness = { overall: number; categories: AmiCategory[] }

/** The AMI card appears 45 days out, moves to the top of the dashboard at 14, and gaps become critical alerts at 3. */
export const AMI_CARD_DAYS = 45
export const AMI_TOP_DAYS = 14
export const AMI_CRITICAL_DAYS = 3
/** A chain scan older than this counts against synchronization health. */
export const SCAN_FRESH_MINUTES = 60

const share = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 100)

type Projection = ArgusAppProjection
type Cadet = Projection['cadets'][number]

/** Sized standard-issue items this cadet has neither a recorded size for nor already holds. Items without sizes set up yet are skipped. */
export function missingSizeRecords(cadet: Pick<CadetProjection, 'gender' | 'sizes' | 'currentProperty'>, projection: Pick<Projection, 'bundles' | 'inventory' | 'catalog'>) {
  const held = heldByCatalog(cadet, projection.inventory)
  return requiredItemsFor(cadet, standardIssueBundles(projection), projection)
    .filter(item => item.sized && projection.inventory.some(variant => variant.active && variant.catalogId === item.key))
    .filter(item => !held.get(item.key) && !recordedSize(cadet, item, projection.inventory))
    .map(item => item.label)
}
/** A cadet record is complete when its profile needs no review and every standard-issue size is known. */
export const cadetRecordComplete = (cadet: Cadet, projection: Projection) => !cadet.profileNeedsReview && missingSizeRecords(cadet, projection).length === 0

export function amiReadiness(projection: Projection, sync: SyncSnapshot = {}, now = new Date(), countWindowDays = COUNT_WINDOW_DAYS): AmiReadiness {
  const coverage = countCoverage(projection, now, countWindowDays)
  const inventoryCount: AmiCategory = {
    key: 'inventory-count',
    label: 'Inventory Count',
    percent: coverage.percent,
    detail: coverage.total
      ? `${coverage.counted} of ${plural(coverage.total, 'active size')} counted in a finalized count in the last ${countWindowDays} days.`
      : 'No sizes are set up to count yet.',
    target: { tab: 'count' },
  }

  const active = projection.cadets.filter(cadet => cadet.status === 'ACTIVE')
  const incomplete = active.filter(cadet => !cadetRecordComplete(cadet, projection))
  const review = incomplete.filter(cadet => cadet.profileNeedsReview).length
  const recordGaps = [incomplete.length - review && `${plural(incomplete.length - review, 'record')} missing sizes`, review && `${plural(review, 'record')} flagged for review`].filter(Boolean)
  const cadetRecords: AmiCategory = {
    key: 'cadet-records',
    label: 'Cadet Records',
    percent: share(active.length - incomplete.length, active.length),
    detail: active.length ? `${active.length - incomplete.length} of ${plural(active.length, 'active cadet record')} complete${recordGaps.length ? ` · ${recordGaps.join(' · ')}` : ''}.` : 'No active cadets.',
    target: incomplete.length === 1 ? { tab: 'cadets', cadetId: incomplete[0].cadetId } : { tab: 'cadets' },
  }

  const openConflicts = projection.conflicts.filter(conflict => conflict.status === 'OPEN').length
  const resolved = projection.conflicts.length - openConflicts
  const movement = countDiscrepancies(projection, now, countWindowDays).filter(entry => entry.movement).length
  const late = lateCountSessions(projection, now, countWindowDays).length
  const outstanding = openConflicts + projection.rejected.length + movement + late
  const correctionParts = [
    openConflicts && plural(openConflicts, 'open conflict'),
    projection.rejected.length && plural(projection.rejected.length, 'record', 'records') + ' not applied',
    movement && plural(movement, 'size') + ' moved while counted',
    late && plural(late, 'count') + ' with late tallies',
  ].filter(Boolean)
  const corrections: AmiCategory = {
    key: 'corrections',
    label: 'Outstanding Corrections',
    percent: outstanding ? share(resolved, resolved + outstanding) : 100,
    detail: outstanding ? `${correctionParts.join(' · ')}.` : 'Nothing waiting for a decision.',
    target: openConflicts ? { tab: 'more', panel: 'conflicts' } : projection.rejected.length ? { tab: 'more', panel: 'diagnostics' } : { tab: 'count' },
  }

  const fulfilled = projection.cadets.reduce((sum, cadet) => sum + cadet.readiness.fulfilled, 0)
  const total = projection.cadets.reduce((sum, cadet) => sum + cadet.readiness.total, 0)
  const stillNeeded: AmiCategory = {
    key: 'still-needed',
    label: 'Still Needed',
    percent: projection.stillNeeded.length ? Math.min(share(fulfilled, total), 99) : 100,
    detail: projection.stillNeeded.length ? `${plural(projection.stillNeeded.length, 'open requirement')} · ${fulfilled} of ${total} fulfilled.` : 'No open requirements.',
    target: { tab: 'more', panel: 'needed' },
  }

  const synced = projection.events.filter(record => record.syncStatus === 'SYNCHRONIZED').length
  const healthy = projection.integrity.healthy
  const audit: AmiCategory = {
    key: 'audit',
    label: 'Audit Health',
    percent: Math.round((share(synced, projection.events.length) + (healthy ? 100 : 0)) / 2),
    detail: `${synced} of ${plural(projection.events.length, 'record')} synchronized and verified · ${healthy ? 'integrity check healthy' : `${plural(projection.integrity.issues.length, 'integrity issue')}`}.`,
    target: healthy ? { tab: 'activity' } : { tab: 'more', panel: 'diagnostics' },
  }

  const queued = sync.queued ?? projection.sync.outbox
  const checks = [
    { pass: queued === 0, text: queued ? `${queued} waiting to publish` : 'nothing waiting to publish' },
    { pass: !sync.needsFunding, text: sync.needsFunding ? 'needs testnet coins' : 'funded' },
  ]
  if (projection.sync.mode === 'remote') {
    const minutes = sync.lastScanAt ? Math.floor((now.getTime() - Date.parse(sync.lastScanAt)) / 60_000) : undefined
    checks.push({ pass: minutes !== undefined && minutes <= SCAN_FRESH_MINUTES && sync.state !== 'error', text: sync.state === 'error' ? 'sync issue' : minutes === undefined ? 'no chain scan yet' : `last chain scan ${minutes < 1 ? 'just now' : `${minutes} min ago`}` })
  }
  const passed = checks.filter(check => check.pass).length
  const syncHealth: AmiCategory = {
    key: 'sync',
    label: 'Synchronization Health',
    percent: sync.needsFunding ? 0 : share(passed, checks.length),
    detail: `${passed} of ${checks.length} checks pass: ${checks.map(check => check.text).join(' · ')}.`,
    target: { tab: 'more', panel: 'wallet' },
  }

  const categories = [inventoryCount, cadetRecords, corrections, stillNeeded, audit, syncHealth]
  return { overall: Math.round(categories.reduce((sum, category) => sum + category.percent, 0) / categories.length), categories }
}

export type AmiProminence = 'hidden' | 'card' | 'top' | 'critical'
/** How prominent the AMI readiness card is `days` before the inspection. */
export function amiProminence(days: number): AmiProminence {
  if (days < 0 || days > AMI_CARD_DAYS) return 'hidden'
  if (days <= AMI_CRITICAL_DAYS) return 'critical'
  return days <= AMI_TOP_DAYS ? 'top' : 'card'
}

/** The next active AMI on or after today, with its day count. */
export function nextAmiEvent(projection: Pick<Projection, 'calendar'>, now: Date): { event: CalendarEventProjection; days: number } | undefined {
  const event = projection.calendar
    .filter(candidate => candidate.active && candidate.kind === 'AMI' && calendarDaysUntil(candidate.startsAt, now) >= 0)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
  return event ? { event, days: calendarDaysUntil(event.startsAt, now) } : undefined
}
