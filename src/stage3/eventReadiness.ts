import type { ArgusAppProjection } from '../distributed/appIntegration'
import type { CalendarEventProjection, CurrentPropertyLine, SupplyEventKind } from '../distributed/types'
import { amiReadiness } from './amiReadiness'
import { calendarDaysUntil } from './calendar'
import { cadetLabel } from './domain'
import { endOfYearReview } from './endOfYear'
import type { SyncSnapshot } from './readinessTypes'
import { activeBundleVersions, unmetItems, variantFor, variantsOf, type UnmetItem } from './requirements'

/**
 * Event readiness engine (master spec §15 NCO, §16 BLT, §18 Military Ball): who the event is for,
 * what each of them still needs from the event's bundles, how that demand compares with stock,
 * and what has already been issued. Pure; every device computes the same report.
 */
export type EventRosterSource = 'ATTENDEES' | 'NS1_DEFAULT' | 'NONE'
export type EventCadetReadiness = { cadetId: string; label: string; required: number; satisfied: number; status: 'PREPARED' | 'PARTIAL' | 'NOT_STARTED'; missing: UnmetItem[] }
/** Unmet demand for one catalog item in one size ("size unknown" when the cadet has no recorded size). */
export type EventDemand = { key: string; name: string; size?: string; itemId?: string; needed: number; onHand: number; shortage: number; stocked: boolean; cadetIds: string[] }
export type EventReadiness = {
  calendarEventId: string
  rosterSource: EventRosterSource
  incoming: number
  fullyPrepared: number
  partiallyPrepared: number
  notStarted: number
  /** Units of required gear the roster does not hold yet. */
  missingItems: number
  /** Unmet sized lines whose size is not recorded, or recorded in a size the unit does not stock. */
  missingSizes: number
  sizesUnknown: number
  sizesNotStocked: number
  requiredLines: number
  satisfiedLines: number
  /** Share of the roster's required lines already held (100 when there is nothing to prepare). */
  percent: number
  demand: EventDemand[]
  /** Demand lines that on-hand stock cannot cover: the event's low-stock conflicts. */
  shortages: EventDemand[]
  completedIssues: { transactions: number; cadets: number }
  cadets: EventCadetReadiness[]
}

type Projection = ArgusAppProjection
type Cadet = Projection['cadets'][number]
const DAY = 86_400_000
/** Demand keys are catalog IDs, or "item:<id>" for a legacy line pinned to one SKU (see lineKey). */
const requiredOf = (entry: Pick<EventDemand, 'key'>) => ({ key: entry.key, ...(entry.key.startsWith('item:') ? { itemId: entry.key.slice(5) } : {}) })

/** Events whose gear is loaned and comes back afterwards. */
export const RETURNABLE_KINDS: readonly SupplyEventKind[] = ['BLT', 'MILITARY_BALL']
/** Events that issue bundles in bulk and get the preparation readiness section. */
export const PREPARATION_KINDS: readonly SupplyEventKind[] = ['NCO', 'BLT', 'MILITARY_BALL']

/** Who the event is for: its attendee roster, or for an NCO with no roster yet, every active NS1 cadet. */
export function eventRoster(event: Pick<CalendarEventProjection, 'kind' | 'cadetIds'>, projection: Pick<Projection, 'cadets'>): { source: EventRosterSource; cadets: Cadet[] } {
  if (event.cadetIds.length) {
    const ids = new Set(event.cadetIds)
    return { source: 'ATTENDEES', cadets: projection.cadets.filter(cadet => ids.has(cadet.cadetId) && cadet.status === 'ACTIVE') }
  }
  if (event.kind === 'NCO') return { source: 'NS1_DEFAULT', cadets: projection.cadets.filter(cadet => cadet.status === 'ACTIVE' && cadet.nsLevel === 'NS1') }
  return { source: 'NONE', cadets: [] }
}

export function eventReadiness(event: CalendarEventProjection, projection: Projection): EventReadiness {
  const { source, cadets } = eventRoster(event, projection)
  const versions = activeBundleVersions(projection, event.bundleIds)
  const rows: EventCadetReadiness[] = []
  const known = new Map<string, EventDemand>(), unknown = new Map<string, EventDemand>()
  for (const cadet of [...cadets].sort((a, b) => cadetLabel(a).localeCompare(cadetLabel(b)))) {
    const { required, unmet } = unmetItems(cadet, versions, projection)
    const satisfied = required.length - unmet.length
    rows.push({ cadetId: cadet.cadetId, label: cadetLabel(cadet), required: required.length, satisfied, status: satisfied === required.length ? 'PREPARED' : satisfied ? 'PARTIAL' : 'NOT_STARTED', missing: unmet })
    for (const item of unmet) {
      const bucket = item.size ? known : unknown, id = `${item.key}|${item.size?.toLowerCase() ?? ''}`
      const entry = bucket.get(id) ?? { key: item.key, name: item.label, ...(item.size ? { size: item.size } : {}), needed: 0, onHand: 0, shortage: 0, stocked: false, cadetIds: [] }
      entry.needed += item.quantity
      entry.cadetIds.push(cadet.cadetId)
      bucket.set(id, entry)
    }
  }
  for (const entry of known.values()) {
    const variant = variantFor(projection.inventory, requiredOf(entry), entry.size!)
    Object.assign(entry, { stocked: Boolean(variant), onHand: variant?.onHand ?? 0, ...(variant ? { itemId: variant.entityId } : {}) })
    entry.shortage = Math.max(0, entry.needed - entry.onHand)
  }
  // Size-unknown demand can only draw on what is left after the known sizes are covered.
  for (const entry of unknown.values()) {
    const variants = variantsOf(projection.inventory, requiredOf(entry))
    const total = variants.reduce((sum, item) => sum + item.onHand, 0)
    const reserved = [...known.values()].filter(other => other.key === entry.key).reduce((sum, other) => sum + Math.min(other.needed, other.onHand), 0)
    Object.assign(entry, { stocked: variants.length > 0, onHand: Math.max(0, total - reserved) })
    entry.shortage = Math.max(0, entry.needed - entry.onHand)
  }
  const demand = [...known.values(), ...unknown.values()].sort((a, b) => a.name.localeCompare(b.name) || Number(!a.size) - Number(!b.size) || (a.size ?? '').localeCompare(b.size ?? '', undefined, { numeric: true }))
  const roster = new Set(cadets.map(cadet => cadet.cadetId)), bundles = new Set(event.bundleIds)
  const issues = projection.transactions.filter(transaction => transaction.transactionType === 'ISSUE' && transaction.bundleId !== undefined && bundles.has(transaction.bundleId) && roster.has(transaction.cadetId))
  const requiredLines = rows.reduce((sum, row) => sum + row.required, 0), satisfiedLines = rows.reduce((sum, row) => sum + row.satisfied, 0)
  const unmetSized = rows.flatMap(row => row.missing.filter(item => item.sized))
  const sizesUnknown = unmetSized.filter(item => !item.size).length
  const sizesNotStocked = unmetSized.filter(item => item.size && !known.get(`${item.key}|${item.size.toLowerCase()}`)?.stocked).length
  return {
    calendarEventId: event.calendarEventId,
    rosterSource: source,
    incoming: rows.length,
    fullyPrepared: rows.filter(row => row.status === 'PREPARED').length,
    partiallyPrepared: rows.filter(row => row.status === 'PARTIAL').length,
    notStarted: rows.filter(row => row.status === 'NOT_STARTED').length,
    missingItems: rows.reduce((sum, row) => sum + row.missing.reduce((total, item) => total + item.quantity, 0), 0),
    missingSizes: sizesUnknown + sizesNotStocked,
    sizesUnknown,
    sizesNotStocked,
    requiredLines,
    satisfiedLines,
    percent: requiredLines ? Math.round((100 * satisfiedLines) / requiredLines) : 100,
    demand,
    shortages: demand.filter(entry => entry.shortage > 0),
    completedIssues: { transactions: issues.length, cadets: new Set(issues.map(transaction => transaction.cadetId)).size },
    cadets: rows,
  }
}

export type PendingReturn = { cadetId: string; label: string; lines: CurrentPropertyLine[]; quantity: number }
/**
 * Post-event reconciliation for loaned gear (BLT, Military Ball): once the event day is over,
 * attendees still holding gear issued from the event's bundles for it. Without an attendee roster,
 * anyone issued the event's bundles in the 90 days up to the event is treated as an attendee.
 */
export function postEventReturns(event: CalendarEventProjection, projection: Pick<Projection, 'cadets'>, now: Date): PendingReturn[] {
  if (!event.active || !RETURNABLE_KINDS.includes(event.kind) || calendarDaysUntil(event.startsAt, now) >= 0) return []
  const start = Date.parse(event.startsAt), bundles = new Set(event.bundleIds), roster = event.cadetIds.length ? new Set(event.cadetIds) : undefined
  return projection.cadets
    .filter(cadet => !roster || roster.has(cadet.cadetId))
    .map(cadet => {
      const lines = cadet.currentProperty.filter(line => {
        const issued = Date.parse(line.issuedAt)
        return line.bundleId !== undefined && bundles.has(line.bundleId) && issued <= start + DAY && (roster !== undefined || issued >= start - 90 * DAY)
      })
      return { cadetId: cadet.cadetId, label: cadetLabel(cadet), lines, quantity: lines.reduce((sum, line) => sum + line.quantity, 0) }
    })
    .filter(entry => entry.quantity > 0)
    .sort((a, b) => a.label.localeCompare(b.label))
}

export type EventReadinessPart = { key: 'tasks' | 'preparation' | 'ami' | 'end-of-year'; label: string; percent: number }
/**
 * The readiness percentage the calendar shows for an event: the average of its preparation
 * tasks and whatever its kind adds — cadet preparation for bundle events, the AMI dashboard for
 * an AMI, the rollover checklist for End-of-Year. 100 when there is nothing to assess.
 */
export function combinedEventReadiness(event: CalendarEventProjection, projection: Projection, now = new Date(), sync: SyncSnapshot = {}): { percent: number; parts: EventReadinessPart[] } {
  const parts: EventReadinessPart[] = []
  if (event.tasks.length) parts.push({ key: 'tasks', label: 'Preparation tasks', percent: Math.round((100 * event.tasks.filter(task => task.completed).length) / event.tasks.length) })
  if (event.bundleIds.length) {
    const report = eventReadiness(event, projection)
    if (report.requiredLines) parts.push({ key: 'preparation', label: 'Cadets prepared', percent: report.percent })
  }
  if (event.kind === 'AMI') parts.push({ key: 'ami', label: 'AMI readiness', percent: amiReadiness(projection, sync, now).overall })
  if (event.kind === 'END_OF_YEAR') parts.push({ key: 'end-of-year', label: 'Rollover checklist', percent: endOfYearReview(projection, now).percent })
  return { percent: parts.length ? Math.round(parts.reduce((sum, part) => sum + part.percent, 0) / parts.length) : 100, parts }
}
