import { useState, type FormEvent } from 'react'
import { AlertTriangle, Eye, Lock } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CadetGender, NsLevel } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { cadetCodeError, normalizeCadetCode } from './cadetDisplay'
import './cadets.css'

type Cadet = ArgusAppProjection['cadets'][number]
type CadetStatus = Cadet['status']
type CadetChanges = Parameters<DistributedAppController['updateCadet']>[1]

const GENDERS: CadetGender[] = ['Male', 'Female']
const NS_LEVELS: NsLevel[] = ['NS1', 'NS2', 'NS3', 'NS4']
const NAME_LABEL = 'Name (optional · encrypted)'
const MAX_NAME_LENGTH = 120

export type CadetFormProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  /** The cadet being edited; omit to add a new cadet. */
  cadet?: Cadet
  /** Edit mode only: whether the operator already chose to reveal this cadet's name. */
  nameRevealed?: boolean
  /** Edit mode only: reveals the name (same per-cadet reveal as the record drawer). */
  onRevealName?: () => void
  onSaved: (projection: ArgusAppProjection, cadet: Cadet | undefined) => void
  onCancel: () => void
}

/** Sized, active catalog items with the size labels currently stocked for each. */
function sizeRows(projection: ArgusAppProjection, saved: Record<string, string>) {
  const rows = projection.catalog
    .filter(item => item.sized && item.active)
    .map(item => {
      const labels = projection.inventory.filter(variant => variant.catalogId === item.catalogId && variant.active).map(variant => variant.variant)
      const current = saved[item.name]
      return { item, labels: current && !labels.includes(current) ? [...labels, current] : labels, stocked: labels }
    })
  return { shown: rows.filter(row => row.labels.length > 0), unconfigured: rows.filter(row => row.labels.length === 0).length }
}

function sameSizes(a: Record<string, string>, b: Record<string, string>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if ((a[key] ?? '') !== (b[key] ?? '')) return false
  return true
}

export function CadetForm({ projection, controller, cadet, nameRevealed = false, onRevealName, onSaved, onCancel }: CadetFormProps) {
  const editing = Boolean(cadet)
  const [gender, setGender] = useState<CadetGender | ''>(cadet?.gender ?? '')
  const [nsLevel, setNsLevel] = useState<NsLevel>(cadet?.nsLevel ?? 'NS1')
  const [status, setStatus] = useState<CadetStatus>(cadet?.status ?? 'ACTIVE')
  const [name, setName] = useState(cadet?.fullName ?? '')
  const [codeInput, setCodeInput] = useState('')
  const [sizes, setSizes] = useState<Record<string, string>>(() => ({ ...(cadet?.sizes ?? {}) }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // An existing name stays hidden in the form too, until the operator explicitly reveals it.
  const nameHidden = Boolean(cadet?.fullName) && !nameRevealed
  const { shown, unconfigured } = sizeRows(projection, sizes)
  const code = normalizeCadetCode(codeInput)
  const codeProblem = editing ? '' : cadetCodeError(code, projection.cadets.flatMap(other => (other.cadetCode ? [other.cadetCode] : [])))

  const changes: CadetChanges = {}
  if (cadet) {
    if (gender && gender !== cadet.gender) changes.gender = gender
    if (nsLevel !== cadet.nsLevel) changes.nsLevel = nsLevel
    if (status !== cadet.status) changes.status = status
    if (!nameHidden && name.trim() !== cadet.fullName) changes.fullName = name.trim()
    if (!sameSizes(sizes, cadet.sizes)) changes.sizes = sizes
  }
  const unchanged = editing && Object.keys(changes).length === 0

  const setSize = (itemName: string, label: string) =>
    setSizes(current => {
      const next = { ...current }
      if (label) next[itemName] = label
      else delete next[itemName]
      return next
    })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!gender) return setError('Choose a gender.')
    if (codeProblem) return setError(codeProblem)
    if (name.trim().length > MAX_NAME_LENGTH) return setError(`Names must be ${MAX_NAME_LENGTH} characters or fewer.`)
    if (unchanged) return
    setBusy(true)
    setError('')
    try {
      if (cadet) {
        const next = await controller.updateCadet(cadet.cadetId, changes)
        onSaved(next, next.cadets.find(candidate => candidate.cadetId === cadet.cadetId))
      } else {
        const existing = new Set(projection.cadets.map(candidate => candidate.cadetId))
        const next = await controller.createCadet({
          gender,
          nsLevel,
          status,
          sizes,
          ...(name.trim() ? { fullName: name.trim() } : {}),
          ...(code ? { cadetCode: code } : {}),
        })
        const created = (code ? next.cadets.find(candidate => candidate.cadetCode === code) : undefined) ?? next.cadets.filter(candidate => !existing.has(candidate.cadetId)).at(-1)
        onSaved(next, created)
      }
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : 'The cadet could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="cadet-form" aria-label={cadet ? `Edit cadet ${cadetLabel(cadet)}` : 'Add cadet'} onSubmit={event => void submit(event)} noValidate>
      {cadet ? (
        <div className="cadet-form-id">
          <small>Cadet ID</small>
          <strong>{cadetLabel(cadet)}</strong>
        </div>
      ) : (
        <label className="field">
          Cadet ID (optional)
          <input
            aria-label="Cadet ID (optional)"
            value={codeInput}
            onChange={event => setCodeInput(event.target.value)}
            placeholder="Leave blank to generate · e.g. C-4F7K"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(codeProblem)}
          />
          <small className="field-hint">Leave blank and a random cadet ID is generated. IDs never contain a name.</small>
        </label>
      )}

      <div className="cadet-form-grid">
        <label className="field">
          Gender
          <select aria-label="Gender" value={gender} onChange={event => setGender(event.target.value as CadetGender)} required>
            {!gender && <option value="">Choose…</option>}
            {GENDERS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label className="field">
          NS level
          <select aria-label="NS level" value={nsLevel} onChange={event => setNsLevel(event.target.value as NsLevel)}>
            {NS_LEVELS.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Status
          <select aria-label="Status" value={status} onChange={event => setStatus(event.target.value as CadetStatus)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </label>
      </div>

      {nameHidden ? (
        <div className="field">
          {NAME_LABEL}
          <div className="cadet-name-locked">
            <span><Lock aria-hidden="true" /> Name on file is hidden</span>
            {onRevealName && (
              <button type="button" className="secondary-button" onClick={onRevealName}>
                <Eye aria-hidden="true" /> Show name
              </button>
            )}
          </div>
        </div>
      ) : (
        <label className="field">
          {NAME_LABEL}
          <input
            aria-label={NAME_LABEL}
            value={name}
            onChange={event => setName(event.target.value)}
            maxLength={MAX_NAME_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
          <small className="field-hint">Stored and synced only encrypted. Lists and receipts always show the cadet ID.</small>
        </label>
      )}

      <fieldset className="cadet-sizes">
        <legend>Size profile (optional)</legend>
        <p>Pre-selects each item’s size when issuing bundles. Every item keeps its own size.</p>
        {shown.length ? (
          <div className="cadet-form-grid">
            {shown.map(({ item, labels, stocked }) => (
              <label className="field" key={item.catalogId}>
                {item.name}
                <select aria-label={`${item.name} size`} value={sizes[item.name] ?? ''} onChange={event => setSize(item.name, event.target.value)}>
                  <option value="">Not recorded</option>
                  {labels.map(label => (
                    <option key={label} value={label}>{stocked.includes(label) ? label : `${label} (not stocked)`}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : (
          <p className="field-hint">No sizes are set up yet. Add sizes to catalog items in Inventory to record them here.</p>
        )}
        {shown.length > 0 && unconfigured > 0 && (
          <p className="field-hint">{unconfigured} sized item{unconfigured === 1 ? ' has' : 's have'} no sizes set up yet.</p>
        )}
      </fieldset>

      {error && (
        <div className="workflow-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || unchanged}>
          {busy ? 'Saving…' : cadet ? 'Save changes' : 'Add cadet'}
        </button>
      </div>
    </form>
  )
}
