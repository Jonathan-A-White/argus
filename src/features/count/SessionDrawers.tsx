import { useId, useState } from 'react'
import { AlertTriangle, Ban, ClipboardCheck } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CountSessionProjection, InventoryProjection } from '../../distributed/types'
import { countedRows, errorMessage, signed, variantLabel } from './countModel'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * Officer review before finalizing: every counted size shows on-hand now → new on-hand, and every
 * size nobody counted is listed as unchanged, so nothing about the replacement is a surprise.
 */
export function FinalizeCountDrawer({
  session,
  inventory,
  controller,
  onFinalized,
  close,
}: {
  session: CountSessionProjection
  inventory: InventoryProjection[]
  controller: DistributedAppController
  onFinalized: (projection: ArgusAppProjection, countedSizes: number) => void
  close: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const rows = countedRows(session, inventory).filter(row => row.itemId in session.totals)
  const counted = new Set(rows.map(row => row.itemId))
  const notCounted = inventory.filter(item => item.active && !counted.has(item.entityId))
  const changing = rows.filter(row => row.difference !== 0).length

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      onFinalized(await controller.finalizeCountSession(session.sessionId), rows.length)
    } catch (reason) {
      setError(errorMessage(reason, 'The count could not be finalized. Nothing changed — try again.'))
      setBusy(false)
    }
  }

  return (
    <Drawer title="Finalize shared count" icon={<ClipboardCheck />} close={close}>
      <div className="record-hero">
        <div>
          <small>SHARED COUNT</small>
          <b>{session.scope}</b>
          <p>
            {plural(rows.length, 'size')} counted · {changing} will change · {plural(session.participants.length, 'person')} counted
          </p>
        </div>
      </div>
      <div className="workflow-warning count-callout">
        <AlertTriangle />
        <div>
          <strong>This replaces on-hand for every counted size — for everyone.</strong>
          <p>
            Each counted size’s official on-hand becomes its shared total on every device. Sizes nobody counted keep their current on-hand.
            Counts added after this are kept as late and do not change stock.
          </p>
        </div>
      </div>
      <div className="review-group">
        <h4>
          Counted sizes<span>{rows.length}</span>
        </h4>
        {rows.length ? (
          <ul className="count-review-lines" aria-label="Counted sizes">
            {rows.map(row => (
              <li key={row.itemId} className={row.difference ? 'changed' : ''}>
                <span>
                  <b>{row.label}</b>
                  <small>
                    {plural(row.contributions, 'contribution')} · {plural(row.contributors, 'person')}
                  </small>
                </span>
                <em>
                  <span aria-hidden="true">
                    {row.onHand} → {row.total}
                  </span>
                  <span className="sr-only">
                    On hand changes from {row.onHand} to {row.total}
                  </span>
                  <span className={row.difference === 0 ? 'count-diff zero' : row.difference > 0 ? 'count-diff up' : 'count-diff down'}>
                    {row.difference === 0 ? 'no change' : signed(row.difference)}
                  </span>
                </em>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            <strong>Nothing has been counted yet</strong>
            <span>Finalizing now would change no stock. Cancel the count instead if it is not needed.</span>
          </p>
        )}
      </div>
      {notCounted.length > 0 && (
        <details className="review-group count-uncounted" open={notCounted.length <= 8}>
          <summary>
            <h4>
              Not counted — on-hand unchanged<span>{notCounted.length}</span>
            </h4>
          </summary>
          <ul className="count-review-lines" aria-label="Sizes not counted">
            {notCounted.map(item => (
              <li key={item.entityId}>
                <span>
                  <b>{variantLabel(item)}</b>
                  <small>not counted — on-hand unchanged</small>
                </span>
                <em className="count-unchanged">{item.onHand}</em>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p className="workflow-error" role="alert">
          <AlertTriangle />
          {error}
        </p>
      )}
      <div className="split-actions">
        <button type="button" onClick={close}>
          Keep counting
        </button>
        <button type="button" className="primary-button" disabled={busy || !rows.length} onClick={() => void confirm()}>
          {busy ? 'Finalizing…' : 'Finalize and update on-hand'}
        </button>
      </div>
    </Drawer>
  )
}

/** Cancelling keeps every contribution in history but never changes stock. */
export function CancelCountDrawer({
  session,
  controller,
  onCancelled,
  close,
}: {
  session: CountSessionProjection
  controller: DistributedAppController
  onCancelled: (projection: ArgusAppProjection) => void
  close: () => void
}) {
  const id = useId()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    if (!reason.trim()) {
      setError('Give a short reason so others know why the count stopped.')
      return
    }
    setBusy(true)
    setError('')
    try {
      onCancelled(await controller.cancelCountSession(session.sessionId, reason.trim()))
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }
  return (
    <Drawer title="Cancel shared count" icon={<Ban />} close={close}>
      <div className="record-hero">
        <div>
          <small>SHARED COUNT</small>
          <b>{session.scope}</b>
          <p>{plural(session.observations.length, 'contribution')} so far</p>
        </div>
      </div>
      <p className="count-drawer-text">Cancelling stops the count for everyone. Contributions stay in the history, and no on-hand quantity changes.</p>
      <div className="field count-field">
        <label htmlFor={`${id}-reason`}>Reason</label>
        <input
          id={`${id}-reason`}
          maxLength={500}
          value={reason}
          placeholder="e.g. Started by mistake"
          aria-invalid={Boolean(error)}
          onChange={event => setReason(event.target.value)}
        />
      </div>
      {error && (
        <p className="workflow-error" role="alert">
          <AlertTriangle />
          {error}
        </p>
      )}
      <div className="split-actions">
        <button type="button" onClick={close}>
          Keep counting
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Cancelling…' : 'Cancel this count'}
        </button>
      </div>
    </Drawer>
  )
}
