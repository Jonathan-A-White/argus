import type { ArgusAppProjection } from '../distributed/appIntegration'
import { COUNT_WINDOW_DAYS, countCoverage, countDiscrepancies, openCountSessions, type CountCoverage, type CountDiscrepancy } from './countHealth'
import { cadetLabel } from './domain'

/**
 * End-of-Year review (master spec §19): the count and property reconciliation that has to be
 * finished before the annual rollover, plus the rollover readiness checklist shown both on the
 * End-of-Year event and in the rollover panel.
 */
export type ReturnPendingCadet = { cadetId: string; label: string; reason: 'INACTIVE' | 'GRADUATING'; items: number }
export type RolloverCheckKey = 'conflicts' | 'open-counts' | 'returns' | 'full-count'
export type RolloverCheck = { key: RolloverCheckKey; label: string; done: boolean; detail: string }
export type EndOfYearReview = { coverage: CountCoverage; discrepancies: CountDiscrepancy[]; returnPending: ReturnPendingCadet[]; checklist: RolloverCheck[]; ready: boolean; percent: number }

type Projection = Pick<ArgusAppProjection, 'cadets' | 'conflicts' | 'countSessions' | 'inventory'>
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** Cadets who must hand gear back: inactive cadets still holding property, and NS4 cadets who graduate at the rollover. */
export function returnPendingCadets(projection: Pick<Projection, 'cadets'>): ReturnPendingCadet[] {
  return projection.cadets
    .map(cadet => ({ cadet, items: cadet.currentProperty.reduce((sum, line) => sum + line.quantity, 0) }))
    .filter(({ cadet, items }) => items > 0 && (cadet.status === 'INACTIVE' || cadet.nsLevel === 'NS4'))
    .map(({ cadet, items }) => ({ cadetId: cadet.cadetId, label: cadetLabel(cadet), reason: cadet.status === 'INACTIVE' ? ('INACTIVE' as const) : ('GRADUATING' as const), items }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function endOfYearReview(projection: Projection, now = new Date(), countWindowDays = COUNT_WINDOW_DAYS): EndOfYearReview {
  const coverage = countCoverage(projection, now, countWindowDays)
  const discrepancies = countDiscrepancies(projection, now, countWindowDays)
  const returnPending = returnPendingCadets(projection)
  const openConflicts = projection.conflicts.filter(conflict => conflict.status === 'OPEN').length
  const openCounts = openCountSessions(projection).length
  const checklist: RolloverCheck[] = [
    { key: 'conflicts', label: 'No open conflicts', done: openConflicts === 0, detail: openConflicts ? `${plural(openConflicts, 'conflict')} still need a decision.` : 'Every competing change has been decided.' },
    { key: 'open-counts', label: 'No count sessions left open', done: openCounts === 0, detail: openCounts ? `${plural(openCounts, 'count')} still open — finalize or cancel.` : 'Every count is finalized or cancelled.' },
    { key: 'returns', label: 'No return-pending cadets', done: returnPending.length === 0, detail: returnPending.length ? `${plural(returnPending.length, 'cadet')} still ${returnPending.length === 1 ? 'holds' : 'hold'} property.` : 'No inactive or graduating cadet holds property.' },
    { key: 'full-count', label: 'Full physical count finalized', done: coverage.total > 0 && coverage.counted === coverage.total, detail: coverage.total ? `${coverage.counted} of ${plural(coverage.total, 'active size')} counted in the last ${countWindowDays} days.` : 'No sizes are set up to count yet.' },
  ]
  const done = checklist.filter(check => check.done).length
  return { coverage, discrepancies, returnPending, checklist, ready: done === checklist.length, percent: Math.round((100 * done) / checklist.length) }
}
