import { useId, useState, type JSX } from 'react'
import { MAX_READINESS_WEIGHT, READINESS_KEYS, READINESS_WEIGHTS, validReadinessWeights, type ReadinessWeights } from '../../stage3/readiness'
import '../readiness/readiness.css'

const LABELS: Record<keyof ReadinessWeights, string> = { cadets: 'Cadets', inventory: 'Inventory', events: 'Events', audit: 'Audit' }
type Draft = Record<keyof ReadinessWeights, string>
const draftOf = (weights: ReadinessWeights): Draft => ({ cadets: String(weights.cadets), inventory: String(weights.inventory), events: String(weights.events), audit: String(weights.audit) })

/** Parses the four fields; returns the weights or a readable reason they cannot be used. */
function parse(draft: Draft): { weights: ReadinessWeights } | { error: string } {
  const weights = {} as ReadinessWeights
  for (const key of READINESS_KEYS) {
    const text = draft[key].trim(), value = Number(text)
    if (!text || !Number.isFinite(value) || value < 0 || value > MAX_READINESS_WEIGHT) return { error: `${LABELS[key]} weight must be a number from 0 to ${MAX_READINESS_WEIGHT}.` }
    weights[key] = value
  }
  return validReadinessWeights(weights) ? { weights } : { error: 'At least one weight must be above zero.' }
}

/**
 * Per-device readiness weights (spec §35: "Weights should eventually be configurable"). Each valid
 * edit is applied straight away; an invalid one is explained and not saved.
 */
export function ReadinessWeightsEditor({ value, change }: { value: ReadinessWeights; change: (weights: ReadinessWeights) => void }): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<Draft>(() => draftOf(value))
  const [error, setError] = useState('')
  const edit = (key: keyof ReadinessWeights, text: string) => {
    const next = { ...draft, [key]: text }
    setDraft(next)
    const result = parse(next)
    if ('error' in result) return setError(result.error)
    setError('')
    change(result.weights)
  }
  const reset = () => {
    setDraft(draftOf(READINESS_WEIGHTS))
    setError('')
    change({ ...READINESS_WEIGHTS })
  }
  return (
    <fieldset className="readiness-weights" aria-describedby={`${id}-help`}>
      <legend>Readiness weights</legend>
      <p id={`${id}-help`} className="field-hint">
        How much each category counts toward overall supply readiness on this device (0–{MAX_READINESS_WEIGHT}).
      </p>
      <div className="readiness-weights-grid">
        {READINESS_KEYS.map(key => (
          <label key={key} className="field">
            {LABELS[key].toUpperCase()}
            <input
              aria-label={`${LABELS[key]} weight`}
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_READINESS_WEIGHT}
              step={0.5}
              value={draft[key]}
              aria-invalid={Boolean(error)}
              onChange={event => edit(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="text-button" onClick={reset}>
        Reset to equal weights
      </button>
    </fieldset>
  )
}
