import { useState, type FormEvent } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { StillNeededProjection } from '../../distributed/types'
import './needs.css'

const MAX_REASON_LENGTH = 500

export type StillNeededActionsProps = {
  need: Pick<StillNeededProjection, 'requirementId' | 'displayLabel'>
  /** Whose requirement this is (e.g. the cadet ID) where the context does not already say so; used in accessible names and messages. */
  owner?: string
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
}

/**
 * Closes one open Still Needed requirement by hand (requires cadets.manage; the caller hides it
 * otherwise). Fulfil = the cadet has the item (a note is optional); Cancel = no longer needed (a
 * reason is required). Each is a signed STILL_NEEDED_FULFILLED / STILL_NEEDED_CANCELLED event.
 * Issuing the item through A.R.G.U.S. fulfils requirements automatically; this is for everything else.
 */
export function StillNeededActions({ need, owner, controller, onProjection, notify }: StillNeededActionsProps) {
  const [mode, setMode] = useState<'FULFIL' | 'CANCEL'>()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const subject = owner ? `${need.displayLabel} for ${owner}` : need.displayLabel

  const open = (next: 'FULFIL' | 'CANCEL') => { setMode(next); setText(''); setError('') }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !mode) return
    if (mode === 'CANCEL' && !text.trim()) return setError('Give a reason for cancelling.')
    if (text.length > MAX_REASON_LENGTH) return setError(`Keep it to ${MAX_REASON_LENGTH} characters or fewer.`)
    setBusy(true)
    setError('')
    try {
      const next = mode === 'FULFIL' ? await controller.fulfilStillNeeded(need.requirementId, text.trim()) : await controller.cancelStillNeeded(need.requirementId, text.trim())
      setMode(undefined)
      onProjection(next)
      notify(mode === 'FULFIL' ? `${subject} marked fulfilled.` : `${subject} cancelled.`)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'The change could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!mode) {
    return (
      <div className="need-actions">
        <button type="button" className="secondary-button" aria-label={`Fulfil ${subject}`} onClick={() => open('FULFIL')}><Check aria-hidden="true" /> Fulfil</button>
        <button type="button" className="secondary-button" aria-label={`Cancel ${subject}`} onClick={() => open('CANCEL')}><X aria-hidden="true" /> Cancel</button>
      </div>
    )
  }
  const fulfil = mode === 'FULFIL'
  return (
    <form className="need-action-form" aria-label={`${fulfil ? 'Fulfil' : 'Cancel'} ${subject}`} onSubmit={event => void submit(event)} noValidate>
      <p>{fulfil ? 'Mark this requirement fulfilled — the cadet already has it (for example, handed over outside A.R.G.U.S.). Stock does not change.' : 'Cancel this requirement — it is no longer needed. It stays in the cadet’s history with your reason.'}</p>
      <label className="field">
        {fulfil ? 'Note (optional)' : 'Reason'}
        <textarea aria-label={fulfil ? 'Note (optional)' : 'Reason'} rows={2} maxLength={MAX_REASON_LENGTH} value={text} onChange={event => setText(event.target.value)} disabled={busy} placeholder={fulfil ? 'e.g. Issued from the old spreadsheet' : 'e.g. Cadet left the unit'} />
      </label>
      {error && <div className="workflow-error" role="alert"><AlertTriangle aria-hidden="true" />{error}</div>}
      <div className="modal-actions">
        <button type="button" onClick={() => setMode(undefined)} disabled={busy}>Back</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : fulfil ? 'Mark fulfilled' : 'Cancel requirement'}</button>
      </div>
    </form>
  )
}
