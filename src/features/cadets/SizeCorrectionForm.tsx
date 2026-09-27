import { useState, type FormEvent } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CurrentPropertyLine } from '../../distributed/types'
import { correctionOptions } from './cadetDisplay'
import './cadets.css'

const MAX_REASON_LENGTH = 500

export type SizeCorrection = { label: string; from: string; to: string; quantity: number }

export type SizeCorrectionFormProps = {
  cadetId: string
  property: CurrentPropertyLine
  projection: ArgusAppProjection
  controller: DistributedAppController
  onCorrected: (projection: ArgusAppProjection, correction: SizeCorrection) => void
  onCancel: () => void
}

/**
 * Master spec §12 ("34R was issued, 32R is correct"). The original issue event stays in history; a
 * new signed correction moves the cadet's line and the stock to the right size of the same item.
 */
export function SizeCorrectionForm({ cadetId, property, projection, controller, onCorrected, onCancel }: SizeCorrectionFormProps) {
  const [toItemId, setToItemId] = useState('')
  const [quantityText, setQuantityText] = useState(String(property.quantity))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const options = correctionOptions(projection.inventory, property.itemId)
  const quantity = Number(quantityText)
  const quantityValid = Number.isInteger(quantity) && quantity >= 1 && quantity <= property.quantity
  const needed = quantityValid ? quantity : 1
  const target = options.find(option => option.entityId === toItemId)
  const title = `${property.label} · ${property.variant}`

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!target) return setError('Choose the size the cadet actually has.')
    if (!quantityValid) return setError(`Quantity must be a whole number from 1 to ${property.quantity}.`)
    if (target.onHand < quantity) return setError(`Only ${target.onHand} of ${target.variant} on hand.`)
    if (!reason.trim()) return setError('Give a reason for the correction.')
    if (reason.length > MAX_REASON_LENGTH) return setError(`Keep the reason to ${MAX_REASON_LENGTH} characters or fewer.`)
    setBusy(true)
    setError('')
    try {
      const next = await controller.correctIssuedSize({ cadetId, propertyId: property.propertyId, toItemId: target.entityId, quantity, reason: reason.trim() })
      onCorrected(next, { label: property.label, from: property.variant, to: target.variant, quantity })
    } catch (reasonForFailure) {
      setError(reasonForFailure instanceof Error && reasonForFailure.message ? reasonForFailure.message : 'The correction could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="cadet-correction" aria-label={`Correct size of ${title}`} onSubmit={event => void submit(event)} noValidate>
      <p className="cadet-correction-intro">
        Recorded as <b>{property.variant}</b>. Choose the size the cadet actually has. The original issue stays in history; stock moves between the two sizes.
      </p>
      {options.length === 0 ? (
        <p className="field-hint">No other active sizes of {property.label} are set up. Add the correct size in Inventory first.</p>
      ) : (
        <>
          <label className="field">
            Correct to size
            <select aria-label="Correct to size" value={toItemId} onChange={event => setToItemId(event.target.value)} disabled={busy}>
              <option value="">Choose a size…</option>
              {options.map(option => {
                const short = option.onHand < needed
                return (
                  <option key={option.entityId} value={option.entityId} disabled={short}>
                    {option.variant} · {option.onHand} on hand{short ? ' · not enough' : ''}
                  </option>
                )
              })}
            </select>
          </label>
          {property.quantity > 1 && (
            <label className="field">
              Quantity to correct
              <input
                aria-label="Quantity to correct"
                type="number"
                inputMode="numeric"
                min={1}
                max={property.quantity}
                value={quantityText}
                onChange={event => setQuantityText(event.target.value)}
                aria-invalid={!quantityValid}
                disabled={busy}
              />
              <small className="field-hint">Of {property.quantity} issued. The rest stay as {property.variant}.</small>
            </label>
          )}
          <label className="field">
            Reason
            <textarea
              aria-label="Reason"
              rows={2}
              maxLength={MAX_REASON_LENGTH}
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder={`e.g. Recorded ${property.variant}; cadet wears ${options[0].variant}`}
              disabled={busy}
            />
            <small className="field-hint">Required. Kept with the correction in the cadet’s history.</small>
          </label>
        </>
      )}
      {error && (
        <div className="workflow-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        {options.length > 0 && (
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        )}
      </div>
    </form>
  )
}
