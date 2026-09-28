import { useRef, useState, type FormEvent } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { RecordCorrectionKind } from '../../distributed/types'
import type { CorrectionTarget } from './correctionModel'
import './corrections.css'

const MAX_REASON_LENGTH = 500

export type RecordCorrectionFormProps = {
  /** e.g. "issue of 27/09/2026" or "receipt of 5 × M"; used for the form's accessible name. */
  title: string
  /** One target, or one per line of a transaction (the form then asks which line). */
  targets: CorrectionTarget[]
  controller: DistributedAppController
  onCorrected: (projection: ArgusAppProjection, summary: string) => void
  onCancel: () => void
}

const EFFECT: Record<RecordCorrectionKind, (delta: number) => string> = {
  RECEIPT_QUANTITY: delta => `On hand ${delta > 0 ? 'rises' : 'falls'} by ${Math.abs(delta)}.`,
  ISSUE_QUANTITY: delta => delta > 0 ? `The cadet holds ${delta} more and on hand falls by ${delta}.` : `The cadet holds ${-delta} fewer and ${-delta} go back on hand.`,
  RETURN_QUANTITY: delta => delta > 0 ? `The cadet holds ${delta} fewer; a serviceable return adds ${delta} to on hand.` : `The cadet holds ${-delta} more; a serviceable return takes ${-delta} off on hand.`,
}

/**
 * Master spec §12 for quantities: "recorded 10, 8 were received". Saving signs a RECORD_CORRECTED
 * event that names the original record, the recorded and corrected values and the reason. The
 * original stays in history; stock and property show the corrected value. When a physical count
 * of that size happened after the original record, the count already measured the shelf, so only
 * the record (and the cadet's holding) changes.
 */
export function RecordCorrectionForm({ title, targets, controller, onCorrected, onCancel }: RecordCorrectionFormProps) {
  const [index, setIndex] = useState(0)
  const target = targets[index] ?? targets[0]
  const [quantityText, setQuantityText] = useState(String(target?.recorded ?? 0))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const eventId = useRef(`correction:${crypto.randomUUID()}`)
  if (!target) return null

  const quantity = Number(quantityText)
  const quantityValid = quantityText.trim() !== '' && Number.isInteger(quantity) && quantity >= 0
  const delta = quantityValid ? quantity - target.recorded : 0

  const choose = (next: number) => {
    setIndex(next)
    setQuantityText(String(targets[next].recorded))
    setError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!quantityValid) return setError('Enter the correct quantity as a whole number (0 or more).')
    if (!delta) return setError(`The record already shows ${target.recorded}.`)
    if (!reason.trim()) return setError('Give a reason for the correction.')
    if (reason.length > MAX_REASON_LENGTH) return setError(`Keep the reason to ${MAX_REASON_LENGTH} characters or fewer.`)
    setBusy(true)
    setError('')
    try {
      const next = await controller.correctRecord({ kind: target.kind, targetEventId: target.targetEventId, ...(target.lineId ? { lineId: target.lineId } : {}), from: target.recorded, to: quantity, reason: reason.trim() }, { eventId: eventId.current })
      onCorrected(next, `${target.label}: ${target.recorded} → ${quantity}`)
    } catch (cause) {
      // The event ID stays: a retry after a failed hand-off returns the already-signed correction instead of signing a second one.
      setError(cause instanceof Error && cause.message ? cause.message : 'The correction could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="record-correction" aria-label={`Correct quantity of ${title}`} onSubmit={event => void submit(event)} noValidate>
      <p className="record-correction-intro">The original record stays in history. A signed correction records the right quantity and your reason.</p>
      {targets.length > 1 && (
        <label className="field">
          Line
          <select aria-label="Line to correct" value={index} onChange={event => choose(Number(event.target.value))} disabled={busy}>
            {targets.map((option, position) => <option key={`${option.targetEventId}:${option.lineId ?? ''}`} value={position}>{option.label} · recorded {option.recorded}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        Correct quantity
        <input aria-label="Correct quantity" type="number" inputMode="numeric" min={0} value={quantityText} onChange={event => setQuantityText(event.target.value)} aria-invalid={!quantityValid} disabled={busy} />
        <small className="field-hint">Recorded as {target.recorded}{targets.length === 1 ? ` (${target.label})` : ''}.{delta ? ` ${EFFECT[target.kind](delta)}` : ''}</small>
      </label>
      <label className="field">
        Reason
        <textarea aria-label="Reason" rows={2} maxLength={MAX_REASON_LENGTH} value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Box held 8, not 10" disabled={busy} />
      </label>
      {error && <div className="workflow-error" role="alert"><AlertTriangle aria-hidden="true" />{error}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save correction'}</button>
      </div>
    </form>
  )
}
