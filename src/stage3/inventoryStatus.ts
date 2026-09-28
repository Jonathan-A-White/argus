import type { ConflictRecord, CountSessionProjection, DistributedEventType, InventoryProjection, SignedArgusEvent } from '../distributed/types'

/**
 * Inventory status for one stock keeping variant (master spec §7): Healthy, Low, Out of Stock,
 * Count Due and Reconciliation Required. Pure and derived only from the shared projection plus
 * the caller's clock, so the inventory screens, readiness and alerts all agree.
 */
export const DEFAULT_COUNT_INTERVAL_DAYS = 90
export const COUNT_INTERVAL_CHOICES = [30, 60, 90, 180, 365] as const

/** Stock level only — what "Low / out of stock" attention is about. */
export type StockLevel = 'HEALTHY' | 'LOW' | 'OUT_OF_STOCK' | 'NOT_STOCKED' | 'INACTIVE'

/** Why a variant needs an officer's reconciliation; each points at the conflict or count to open. */
export type ReconciliationReason =
  | { kind: 'CONFLICT'; conflictId: string; detail: string }
  /** Stock was issued, returned or received while a count of this size was open. */
  | { kind: 'MOVED_DURING_COUNT'; sessionId: string; scope: string; open: boolean }
  /** Contributions or corrections reached the count after its cutoff (submission or finalization). */
  | { kind: 'LATE_COUNT'; sessionId: string; scope: string; eventIds: string[] }

export type InventoryStatus = {
  itemId: string
  stock: StockLevel
  /** LOW or OUT_OF_STOCK: at or below the low-stock threshold, or none left while cadets hold some. */
  stockAttention: boolean
  /** Never counted, or counted longer ago than the interval. */
  countDue: boolean
  lastCountedAt?: string
  lastCountEventId?: string
  /** Whole days since the last count; undefined when never counted. */
  daysSinceCount?: number
  reconciliationRequired: boolean
  reconciliation: ReconciliationReason[]
  /** Every status that applies, most urgent first, e.g. ['Reconciliation required', 'Low', 'Count due']. */
  labels: InventoryStatusLabel[]
}
export type InventoryStatusLabel = 'Reconciliation required' | 'Out of stock' | 'Low' | 'Count due' | 'Healthy' | 'Nothing on hand' | 'Inactive'
/**
 * The slice of the projection the derivation needs (an ArgusAppProjection or repository state both
 * fit). With `events`, stock movement during an open count ignores metadata-only edits.
 */
export type InventoryStatusSource = { conflicts: ConflictRecord[]; countSessions: CountSessionProjection[]; events?: Array<{ event: Pick<SignedArgusEvent, 'eventId' | 'eventType'> }> }
export type InventoryStatusOptions = { countIntervalDays?: number }

const DAY = 86_400_000
const OPEN_COUNT = new Set<CountSessionProjection['status']>(['DRAFT', 'ACTIVE', 'SUBMITTED'])

export function stockLevel(item: InventoryProjection): StockLevel {
  if (!item.active) return 'INACTIVE'
  const attention = (item.reorderAt !== undefined && item.onHand <= item.reorderAt) || (item.onHand === 0 && item.issued > 0)
  if (attention) return item.onHand === 0 ? 'OUT_OF_STOCK' : 'LOW'
  return item.onHand === 0 ? 'NOT_STOCKED' : 'HEALTHY'
}

/** Count Due: an active size never counted, or last counted more than `countIntervalDays` ago. */
export function isCountDue(item: InventoryProjection, now: Date | number, countIntervalDays = DEFAULT_COUNT_INTERVAL_DAYS) {
  if (!item.active) return false
  const counted = item.lastCountedAt ? Date.parse(item.lastCountedAt) : Number.NaN
  if (Number.isNaN(counted)) return true
  return time(now) - counted > countIntervalDays * DAY
}

/** Edits that bump a size's version without moving any stock. */
const METADATA_ONLY = new Set<DistributedEventType>(['INVENTORY_ITEM_UPDATED', 'CATALOG_ITEM_UPDATED'])

/**
 * Whether stock moved (issue, return, receipt, correction, another count…) since a count's baseline.
 * Every change to a size bumps its version once and appends its event, so the events since the
 * baseline are the last (version − baseline) entries; renames and threshold edits do not count.
 * Unknown events count as movement, so new stock-moving event types are never missed.
 */
export function stockMovedSince(item: InventoryProjection, baselineVersion: number, eventType: (eventId: string) => DistributedEventType | undefined) {
  const since = item.version - baselineVersion
  if (since <= 0) return false
  return item.appliedEventIds.slice(-since).some(eventId => { const type = eventType(eventId); return type === undefined || !METADATA_ONLY.has(type) })
}

/** Every reason this variant needs reconciling, in a stable order (conflicts, then counts by session ID). */
export function reconciliationReasons(item: InventoryProjection, source: InventoryStatusSource): ReconciliationReason[] {
  return reasonsFrom(item, indexSource(source))
}

export function inventoryStatus(item: InventoryProjection, projection: InventoryStatusSource, now: Date | number = Date.now(), options: InventoryStatusOptions = {}): InventoryStatus {
  return statusFrom(item, indexSource(projection), now, options)
}

/** Status for every variant, keyed by inventory entityId (indexes the projection once). */
export function inventoryStatuses(inventory: InventoryProjection[], projection: InventoryStatusSource, now: Date | number = Date.now(), options: InventoryStatusOptions = {}) {
  const index = indexSource(projection)
  return new Map(inventory.map(item => [item.entityId, statusFrom(item, index, now, options)]))
}

/** Short plain-language explanation of one reason, for lists and screen readers. */
export function describeReconciliation(reason: ReconciliationReason) {
  switch (reason.kind) {
    case 'CONFLICT':
      return `Open conflict: ${reason.detail}`
    case 'MOVED_DURING_COUNT':
      return reason.open ? `Stock moved while “${reason.scope}” is being counted` : `Stock moved while “${reason.scope}” was being counted — recount to confirm`
    case 'LATE_COUNT':
      return `${reason.eventIds.length} late count change${reason.eventIds.length === 1 ? '' : 's'} in “${reason.scope}”`
  }
}

const STOCK_LABEL: Record<StockLevel, InventoryStatusLabel> = { HEALTHY: 'Healthy', LOW: 'Low', OUT_OF_STOCK: 'Out of stock', NOT_STOCKED: 'Nothing on hand', INACTIVE: 'Inactive' }
const LABEL_ORDER: InventoryStatusLabel[] = ['Reconciliation required', 'Out of stock', 'Low', 'Count due', 'Healthy', 'Nothing on hand', 'Inactive']
const time = (now: Date | number) => (typeof now === 'number' ? now : now.getTime())

type SessionIndex = { session: CountSessionProjection; open: boolean; counted: Set<string>; late: Map<string, string[]> }
type SourceIndex = { conflicts: ConflictRecord[]; sessions: SessionIndex[]; eventType?: (eventId: string) => DistributedEventType | undefined }

function indexSource(source: InventoryStatusSource): SourceIndex {
  const sessions = source.countSessions
    .filter(session => session.status !== 'CANCELLED')
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
    .map(session => {
      const counted = new Set(Object.keys(session.totals)), late = new Map<string, string[]>()
      for (const observation of session.observations) {
        if (observation.status !== 'LATE') counted.add(observation.itemId)
        const ids = [...(observation.status === 'LATE' ? [observation.eventId] : []), ...(observation.corrections ?? []).filter(correction => correction.late).map(correction => correction.eventId)]
        if (ids.length) late.set(observation.itemId, [...(late.get(observation.itemId) ?? []), ...ids].sort())
      }
      return { session, open: OPEN_COUNT.has(session.status), counted, late }
    })
  const types = source.events ? new Map(source.events.map(record => [record.event.eventId, record.event.eventType])) : undefined
  return { conflicts: source.conflicts.filter(conflict => conflict.status === 'OPEN'), sessions, ...(types ? { eventType: (eventId: string) => types.get(eventId) } : {}) }
}

/** Open count: stock-moving events since the baseline when the history is at hand, otherwise a net change in on-hand. */
function movedDuringOpenCount(item: InventoryProjection, baseline: CountSessionProjection['baseline'][string], index: SourceIndex) {
  return index.eventType ? stockMovedSince(item, baseline.inventoryVersion, index.eventType) : baseline.quantity !== item.onHand
}

function reasonsFrom(item: InventoryProjection, index: SourceIndex): ReconciliationReason[] {
  const reasons: ReconciliationReason[] = []
  for (const conflict of index.conflicts) {
    if (conflict.entityId === item.entityId || conflict.inventoryItemIds?.includes(item.entityId) || (item.catalogId !== undefined && conflict.entityId === item.catalogId)) reasons.push({ kind: 'CONFLICT', conflictId: conflict.id, detail: conflict.reason })
  }
  for (const { session, open, counted, late } of index.sessions) {
    // A finished count only matters while it is still this size's latest count; recounting clears it.
    if (!open && !stillLatestCount(item, session)) continue
    const baseline = session.baseline[item.entityId]
    const moved = open ? counted.has(item.entityId) && baseline !== undefined && movedDuringOpenCount(item, baseline, index) : (session.movementWarnings ?? []).includes(item.entityId)
    if (moved) reasons.push({ kind: 'MOVED_DURING_COUNT', sessionId: session.sessionId, scope: session.scope, open })
    const lateIds = late.get(item.entityId)
    if (lateIds) reasons.push({ kind: 'LATE_COUNT', sessionId: session.sessionId, scope: session.scope, eventIds: lateIds })
  }
  return reasons
}

function statusFrom(item: InventoryProjection, index: SourceIndex, now: Date | number, options: InventoryStatusOptions): InventoryStatus {
  const stock = stockLevel(item)
  const countDue = isCountDue(item, now, options.countIntervalDays)
  const reconciliation = item.active ? reasonsFrom(item, index) : []
  const counted = item.lastCountedAt ? Date.parse(item.lastCountedAt) : Number.NaN
  const labels: InventoryStatusLabel[] = [STOCK_LABEL[stock]]
  if (reconciliation.length) labels.push('Reconciliation required')
  if (countDue) labels.push('Count due')
  return {
    itemId: item.entityId,
    stock,
    stockAttention: stock === 'LOW' || stock === 'OUT_OF_STOCK',
    countDue,
    ...(item.lastCountedAt ? { lastCountedAt: item.lastCountedAt } : {}),
    ...(item.lastCountEventId ? { lastCountEventId: item.lastCountEventId } : {}),
    ...(Number.isNaN(counted) ? {} : { daysSinceCount: Math.max(0, Math.floor((time(now) - counted) / DAY)) }),
    reconciliationRequired: reconciliation.length > 0,
    reconciliation,
    labels: labels.sort((a, b) => LABEL_ORDER.indexOf(a) - LABEL_ORDER.indexOf(b)),
  }
}

function stillLatestCount(item: InventoryProjection, session: CountSessionProjection) {
  if (!session.reconciledEventId) return false
  if (item.lastCountEventId === session.reconciledEventId) return true
  // This size was not in the finalized totals (e.g. only late work named it): it matters until a later count.
  if (item.entityId in session.totals) return false
  if (!item.lastCountedAt) return true
  return !session.reconciledAt || Date.parse(item.lastCountedAt) <= Date.parse(session.reconciledAt)
}
