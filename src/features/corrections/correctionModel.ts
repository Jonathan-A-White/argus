import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { eventSortKey } from '../../distributed/replica'
import type { RecordCorrectionKind, SupplyTransaction, SupplyTransactionLine } from '../../distributed/types'
import { ONE_SIZE_LABEL, RETURN_CONDITION_LABELS } from '../../stage3/domain'

const KINDS: RecordCorrectionKind[] = ['RECEIPT_QUANTITY', 'ISSUE_QUANTITY', 'RETURN_QUANTITY']
export const KIND_LABELS: Record<RecordCorrectionKind, string> = { RECEIPT_QUANTITY: 'Receipt', ISSUE_QUANTITY: 'Issue', RETURN_QUANTITY: 'Return' }

/** One signed RECORD_CORRECTED with an explicit kind. applied is false while it sits in an open conflict. */
export type RecordCorrectionView = { eventId: string; kind: RecordCorrectionKind; targetEventId: string; lineId?: string; from: number; to: number; reason: string; actor: string; at: string; applied: boolean }

/** What one correctable record currently shows (after earlier corrections), for the correction form. */
export type CorrectionTarget = { kind: RecordCorrectionKind; targetEventId: string; lineId?: string; label: string; recorded: number }

export const sizeLabel = (variant: string) => (variant === ONE_SIZE_LABEL || variant === 'No variant' ? 'One size' : variant)
export const lineLabel = (line: Pick<SupplyTransactionLine, 'label' | 'variant'>) => `${line.label} · ${line.variant}`
export const effectiveQuantity = (line: Pick<SupplyTransactionLine, 'quantity' | 'correctedQuantity'>) => line.correctedQuantity ?? line.quantity

/** "PT Shorts · M × 1", plus the correction and (returns) the condition and note, as shown in a cadet's history. */
export function describeLine(line: SupplyTransactionLine) {
  const quantity = effectiveQuantity(line)
  const corrected = line.correctedQuantity !== undefined ? ` (corrected from ${line.quantity})` : ''
  const condition = line.condition ? ` · ${RETURN_CONDITION_LABELS[line.condition]}` : ''
  const note = line.note ? ` · “${line.note}”` : ''
  return `${lineLabel(line)} × ${quantity}${corrected}${condition}${note}`
}

/** Every kind-bearing correction, in canonical order. Applied ones touched an inventory size; the rest are in conflict. */
export function recordCorrections(projection: Pick<ArgusAppProjection, 'events' | 'inventory'>): RecordCorrectionView[] {
  const applied = new Set(projection.inventory.flatMap(item => item.appliedEventIds))
  return [...projection.events].sort((a, b) => eventSortKey(a.event) < eventSortKey(b.event) ? -1 : 1).flatMap(({ event }) => {
    const payload = event.payload
    if (event.eventType !== 'RECORD_CORRECTED' || !KINDS.includes(payload.kind as RecordCorrectionKind) || typeof payload.targetEventId !== 'string') return []
    return [{ eventId: event.eventId, kind: payload.kind as RecordCorrectionKind, targetEventId: payload.targetEventId, ...(typeof payload.lineId === 'string' ? { lineId: payload.lineId } : {}), from: Number(payload.from), to: Number(payload.to), reason: String(payload.reason ?? ''), actor: event.actorPublicIdentity, at: event.timestamp, applied: applied.has(event.eventId) }]
  })
}

export function transactionTargets(transaction: SupplyTransaction): CorrectionTarget[] {
  const kind: RecordCorrectionKind = transaction.transactionType === 'ISSUE' ? 'ISSUE_QUANTITY' : 'RETURN_QUANTITY'
  return transaction.lines.map(line => ({ kind, targetEventId: transaction.eventId, lineId: line.lineId, label: lineLabel(line), recorded: effectiveQuantity(line) }))
}

export type ReceiptRecord = { eventId: string; itemId: string; variant: string; recorded: number; quantity: number; note?: string; actor: string; at: string }
/** Applied stock receipts for the given sizes, newest first, with the quantity after corrections. */
export function receiptsFor(projection: Pick<ArgusAppProjection, 'events' | 'inventory'>, itemIds: string[]): ReceiptRecord[] {
  const corrections = recordCorrections(projection).filter(correction => correction.kind === 'RECEIPT_QUANTITY' && correction.applied)
  return projection.events.flatMap(({ event }) => {
    const item = projection.inventory.find(candidate => candidate.entityId === event.entityId)
    if (event.eventType !== 'INVENTORY_RECEIVED' || !item || !itemIds.includes(item.entityId) || !item.appliedEventIds.includes(event.eventId)) return []
    const recorded = Number(event.payload.quantity), latest = corrections.filter(correction => correction.targetEventId === event.eventId).at(-1)
    return [{ eventId: event.eventId, itemId: item.entityId, variant: item.variant, recorded, quantity: latest ? latest.to : recorded, ...(typeof event.payload.note === 'string' ? { note: event.payload.note } : {}), actor: event.actorPublicIdentity, at: event.timestamp }]
  }).sort((a, b) => b.at.localeCompare(a.at))
}
