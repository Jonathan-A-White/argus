import type { AuditDeliveryStatus, ConflictRecord, LocalSyncStatus, StoredEvent } from './types'

/**
 * Where one record stands on its way to the shared ledger, as this device's sync provider knows
 * it (master spec §22). Per-device metadata only: it is never an input to the fold, so it may
 * differ between devices and change after the fact without changing any projection.
 */
export type EventDelivery = {
  syncStatus: Exclude<LocalSyncStatus, 'CONFLICT'>
  auditStatus: AuditDeliveryStatus
  transactionId?: string
  /** Height of the block that mined the record's transaction; absent until it is mined. */
  blockHeight?: number
  /** Why the last attempt to publish failed (it is retried). Technical detail, never shown as the primary status. */
  lastError?: string
}

/** Copies a provider's delivery report onto a stored record. Never touches the event itself. */
export function applyDelivery(record: StoredEvent, delivery: EventDelivery) {
  record.syncStatus = delivery.syncStatus
  record.auditStatus = record.auditStatus === 'PROOF_VERIFIED' && delivery.auditStatus === 'CONFIRMED' ? 'PROOF_VERIFIED' : delivery.auditStatus
  if (delivery.transactionId) record.transactionId = delivery.transactionId
  else if (delivery.syncStatus !== 'SYNCHRONIZED') delete record.transactionId
  if (delivery.blockHeight) record.blockHeight = delivery.blockHeight
  else delete record.blockHeight
  if (delivery.lastError) record.lastError = delivery.lastError
  else delete record.lastError
}

/** True when applying the report would change nothing, so a refresh can skip the write. */
export function sameDelivery(record: StoredEvent, delivery: EventDelivery) {
  const next = { ...record }
  applyDelivery(next, delivery)
  return next.syncStatus === record.syncStatus && next.auditStatus === record.auditStatus && next.transactionId === record.transactionId && next.blockHeight === record.blockHeight && next.lastError === record.lastError
}

/** VERIFIED means mined: the record's transaction is in a block whose height is known — not merely broadcast. */
export const isVerified = (record: Pick<StoredEvent, 'auditStatus' | 'blockHeight'>) =>
  (record.auditStatus === 'CONFIRMED' || record.auditStatus === 'PROOF_VERIFIED') && (record.blockHeight ?? 0) > 0

type FoldedState = {
  conflicts: ConflictRecord[]
  transactions: Array<{ eventId: string }>
  corrections: Array<{ eventId: string }>
  inventory: Array<{ appliedEventIds: string[] }>
  catalog: Array<{ appliedEventIds: string[] }>
  cadets: Array<{ appliedEventIds: string[] }>
  bundles: Array<{ appliedEventIds: string[] }>
  stillNeeded: Array<{ appliedEventIds: string[] }>
  calendar: Array<{ appliedEventIds: string[] }>
  countSessions: Array<{ appliedEventIds: string[] }>
}

/** Events named by a still-open conflict that the fold did not apply to any record: the side that lost and needs a decision. */
export function conflictLosers(state: FoldedState): Set<string> {
  const open = state.conflicts.filter(conflict => conflict.status === 'OPEN')
  if (!open.length) return new Set()
  const applied = new Set<string>([...state.transactions, ...state.corrections].map(entry => entry.eventId))
  for (const list of [state.inventory, state.catalog, state.cadets, state.bundles, state.stillNeeded, state.calendar, state.countSessions]) for (const entry of list) for (const id of entry.appliedEventIds) applied.add(id)
  return new Set(open.flatMap(conflict => conflict.eventIds).filter(id => !applied.has(id)))
}

/** The sync status every screen shows: a record that lost an open conflict reads CONFLICT, whatever its delivery. */
export function withConflictStatus(events: StoredEvent[], losers: Set<string>): StoredEvent[] {
  return losers.size ? events.map(record => losers.has(record.event.eventId) ? { ...record, syncStatus: 'CONFLICT' } : record) : events
}
