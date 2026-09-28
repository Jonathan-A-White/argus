import { useId, useState, type FormEvent } from 'react'
import { AlertTriangle, ClipboardCheck, Minus, Plus, RotateCcw, ShieldCheck } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { InventoryProjection } from '../../distributed/types'
import { MAX_COUNT_QUANTITY, errorMessage, loadDraftTally, parseWhole, saveDraftTally, variantLabel } from './countModel'

type Props = {
  sessionId: string
  variant: InventoryProjection
  /** False when the session no longer accepts contributions or the person lacks 'inventory.count'. */
  canContribute: boolean
  readOnlyReason?: string
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
}

const PRESET_STEPS = [1, 5, 10]
const MAX_STEP = 1000
const MAX_UNDO = 50

/**
 * The person's private tally for one size. Nothing is shared until they press "Add my count";
 * until then it is kept in localStorage so a reload or a tab switch never loses it.
 * Mount with key={sessionId + itemId} so each size gets its own tally.
 */
export function TallyCard({ sessionId, variant, canContribute, readOnlyReason, controller, onProjection, notify }: Props) {
  const itemId = variant.entityId
  const [tally, setTally] = useState(() => loadDraftTally(sessionId, itemId))
  const [history, setHistory] = useState<number[]>([])
  const [step, setStep] = useState(variant.countIncrement)
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const [customError, setCustomError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ids = useId()
  const isCustomStep = !PRESET_STEPS.includes(step)

  const setAndSave = (value: number) => {
    setTally(value)
    saveDraftTally(sessionId, itemId, value)
  }
  const change = (next: number) => {
    const safe = Math.min(MAX_COUNT_QUANTITY, Math.max(0, next))
    if (safe === tally) return
    setHistory(previous => [...previous, tally].slice(-MAX_UNDO))
    setAndSave(safe)
  }
  const undo = () => {
    const previous = history.at(-1)
    if (previous === undefined) return
    setHistory(history.slice(0, -1))
    setAndSave(previous)
  }
  const chooseStep = (value: number) => {
    setStep(value)
    setCustomOpen(false)
    setCustomError('')
  }
  const applyCustomStep = (event: FormEvent) => {
    event.preventDefault()
    const value = parseWhole(customText, 1, MAX_STEP)
    if (value === undefined) {
      setCustomError(`Enter a whole number from 1 to ${MAX_STEP}.`)
      return
    }
    chooseStep(value)
    setCustomText('')
  }
  const contribute = async (quantity: number) => {
    if (busy || !canContribute) return
    setBusy(true)
    setError('')
    try {
      const next = await controller.contributeCount(sessionId, { itemId }, quantity, note.trim())
      saveDraftTally(sessionId, itemId, 0)
      setTally(0)
      setHistory([])
      setNote('')
      onProjection(next)
      notify(quantity ? `Added ${quantity} to the shared total for ${variantLabel(variant)}.` : `Recorded an empty shelf (0) for ${variantLabel(variant)}.`)
    } catch (reason) {
      setError(errorMessage(reason, 'Your count could not be added. It is still saved on this device — try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="count-card marble-card count-tally" aria-labelledby={`${ids}-heading`}>
      <div className="item-heading">
        <div className="item-icon">
          <ClipboardCheck />
        </div>
        <div>
          <span>{variant.category.toUpperCase()}</span>
          <h3 id={`${ids}-heading`}>{variant.name}</h3>
          <p>
            Size: <strong>{variant.variant}</strong>
            {variant.niin ? ` · ${variant.niin}` : ''}
          </p>
        </div>
      </div>
      <div className="count-display">
        <small>YOUR DRAFT COUNT (NOT YET ADDED)</small>
        <output aria-label="Your count">{tally}</output>
        <span>ONLY ON THIS DEVICE UNTIL YOU ADD IT</span>
      </div>
      <div className="step-label">
        <span>COUNT BY</span>
        <div role="group" aria-label="Count by">
          {PRESET_STEPS.map(value => (
            <button key={value} type="button" className={step === value ? 'active' : ''} aria-pressed={step === value} onClick={() => chooseStep(value)}>
              {value}
            </button>
          ))}
          <button
            type="button"
            className={isCustomStep ? 'active' : ''}
            aria-pressed={isCustomStep}
            aria-expanded={customOpen}
            aria-label={isCustomStep ? `Custom step ${step}` : 'Custom step'}
            onClick={() => setCustomOpen(open => !open)}
          >
            {isCustomStep ? step : 'Custom'}
          </button>
        </div>
      </div>
      {customOpen && (
        <form className="count-custom-step" onSubmit={applyCustomStep} noValidate>
          <label htmlFor={`${ids}-step`}>Custom count step</label>
          <input
            id={`${ids}-step`}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_STEP}
            value={customText}
            placeholder={String(step)}
            aria-invalid={Boolean(customError)}
            aria-describedby={customError ? `${ids}-step-error` : undefined}
            onChange={event => setCustomText(event.target.value)}
          />
          <button type="submit" className="secondary-button">
            Use
          </button>
          {customError && (
            <small id={`${ids}-step-error`} className="count-field-error" role="alert">
              {customError}
            </small>
          )}
        </form>
      )}
      <div className="counter-actions">
        <button type="button" className="stone-button minus" disabled={busy || tally === 0} onClick={() => change(tally - step)}>
          <Minus />
          <span>Subtract {step}</span>
        </button>
        <button type="button" className="stone-button plus" disabled={busy} onClick={() => change(tally + step)}>
          <Plus />
          <span>Add {step}</span>
        </button>
      </div>
      <button type="button" className="undo-button" disabled={busy || !history.length} onClick={undo}>
        <RotateCcw size={16} />
        {history.length ? `Undo last tap (${tally} → ${history.at(-1)})` : 'Nothing to undo'}
      </button>
      <div className="count-contribute">
        <div className="field count-field">
          <label htmlFor={`${ids}-note`}>Note (optional)</label>
          <input
            id={`${ids}-note`}
            maxLength={500}
            value={note}
            disabled={!canContribute}
            placeholder="Where you counted, e.g. Shelf B"
            onChange={event => setNote(event.target.value)}
          />
        </div>
        {error && (
          <p className="workflow-error" role="alert">
            <AlertTriangle />
            {error}
          </p>
        )}
        <button type="button" className="primary-button" disabled={!canContribute || busy || tally === 0} onClick={() => void contribute(tally)}>
          {busy ? 'Adding…' : 'Add my count to shared total'}
        </button>
        {tally === 0 && (
          <button type="button" className="secondary-button count-zero" disabled={!canContribute || busy} onClick={() => void contribute(0)}>
            Counted zero here
          </button>
        )}
        <p className="safe-note">
          <ShieldCheck />
          {readOnlyReason ?? (tally === 0 ? 'Tap Add to tally, or record an empty shelf with “Counted zero here”.' : 'Your tally is saved on this device until you add it.')}
        </p>
      </div>
    </section>
  )
}
