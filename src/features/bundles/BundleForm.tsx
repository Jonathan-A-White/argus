import { useId, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { BundleLineProjection, BundleProjection, CatalogItemProjection } from '../../distributed/types'
import {
  APPLICABILITY,
  MAX_DEFAULT_QUANTITY,
  MAX_NAME_LENGTH,
  MAX_PURPOSE_LENGTH,
  currentVersionOf,
  definitionError,
  definitionOf,
  draftFrom,
  emptyDraft,
  lineFor,
  lineReady,
  newBundleId,
  newLineId,
  sameDefinition,
  type Applicability,
  type BundleDraft,
} from './bundleModel'
import './bundles.css'

export type BundleFormProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  /** The bundle to edit; omit to create a new one. */
  bundle?: BundleProjection
  onCancel: () => void
  onSaved: (projection: ArgusAppProjection, bundleId: string, message: string) => void
}

const QUANTITIES = Array.from({ length: MAX_DEFAULT_QUANTITY }, (_, index) => index + 1)
const DRAFT_PREFIX = 'draft'
const staleMessage = (version: number) => `Another device saved version ${version} of this bundle while you were editing. Cancel and reopen it to edit the latest version.`

/** Active catalog items grouped by category, in catalog order. */
function groupByCategory(items: CatalogItemProjection[]) {
  const groups = new Map<string, CatalogItemProjection[]>()
  for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item])
  return [...groups.entries()]
}

function CatalogOptions({ groups }: { groups: Array<[string, CatalogItemProjection[]]> }) {
  return (
    <>
      {groups.map(([category, items]) => (
        <optgroup key={category} label={category}>
          {items.map(item => (
            <option key={item.catalogId} value={item.catalogId}>
              {item.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
}

/**
 * Master spec §8: bundles are editable, versioned and never rewrite history. Saving publishes a new
 * immutable version; earlier versions and every past issue keep exactly the contents they had.
 */
export function BundleForm({ projection, controller, bundle, onCancel, onSaved }: BundleFormProps) {
  const ids = useId()
  const [draft, setDraft] = useState<BundleDraft>(() => (bundle ? draftFrom(currentVersionOf(bundle), projection.catalog) : emptyDraft()))
  const [baseVersion] = useState(() => bundle?.currentVersion ?? 0)
  const [baseline] = useState(() => definitionOf(draft))
  const [addCatalogId, setAddCatalogId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const activeCatalog = projection.catalog.filter(item => item.active)
  const used = new Set(draft.lines.flatMap(line => (line.catalogId ? [line.catalogId] : [])))
  const addable = groupByCategory(activeCatalog.filter(item => !used.has(item.catalogId)))
  const allGroups = groupByCategory(activeCatalog)
  const purposes = [...new Set(projection.bundles.map(candidate => currentVersionOf(candidate).purpose).filter(Boolean))].sort()
  const definition = definitionOf(draft)
  const unchanged = Boolean(bundle) && sameDefinition(definition, baseline)
  const nextVersion = baseVersion + 1

  const update = (changes: Partial<BundleDraft>) => setDraft(current => ({ ...current, ...changes }))
  const updateLine = (index: number, changes: Partial<BundleLineProjection>) =>
    setDraft(current => ({ ...current, lines: current.lines.map((line, position) => (position === index ? { ...line, ...changes } : line)) }))
  const changeItem = (index: number, catalogId: string) => {
    const item = projection.catalog.find(candidate => candidate.catalogId === catalogId)
    // A catalog line names the item; the size is chosen per cadet at issue time, so no SKU is pinned.
    if (item) updateLine(index, { catalogId: item.catalogId, displayLabel: item.name, supportsSizing: item.sized, itemId: undefined })
  }
  const move = (index: number, delta: -1 | 1) =>
    setDraft(current => {
      const target = index + delta
      if (target < 0 || target >= current.lines.length) return current
      const lines = [...current.lines]
      const moving = lines[index]
      lines[index] = lines[target]
      lines[target] = moving
      return { ...current, lines }
    })
  const remove = (index: number) => setDraft(current => ({ ...current, lines: current.lines.filter((_, position) => position !== index) }))
  const addLine = () => {
    const item = projection.catalog.find(candidate => candidate.catalogId === addCatalogId)
    if (!item) return
    const lineId = newLineId(bundle?.bundleId ?? DRAFT_PREFIX)
    setDraft(current => ({ ...current, lines: [...current.lines, lineFor(item, lineId)] }))
    setAddCatalogId('')
    setError('')
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const problem = definitionError(definition)
    if (problem) return setError(problem)
    if (bundle && bundle.currentVersion !== baseVersion) return setError(staleMessage(bundle.currentVersion))
    if (unchanged) return setError('Nothing has changed yet.')
    setBusy(true)
    setError('')
    try {
      if (bundle) {
        // The controller versions from its own latest state, so check it too: a synced edit must never be overwritten unseen.
        const latest = (await controller.project()).bundles.find(candidate => candidate.bundleId === bundle.bundleId)
        if (latest && latest.currentVersion !== baseVersion) return setError(staleMessage(latest.currentVersion))
        const next = await controller.updateBundleDefinition(bundle.bundleId, definition)
        const saved = next.bundles.find(candidate => candidate.bundleId === bundle.bundleId)
        onSaved(next, bundle.bundleId, `${definition.displayName} saved as version ${saved?.currentVersion ?? nextVersion}.`)
      } else {
        const bundleId = newBundleId(definition.displayName)
        const lines = definition.lines.map(line => ({ ...line, lineId: newLineId(bundleId) }))
        const next = await controller.createBundle(bundleId, { ...definition, lines })
        onSaved(next, bundleId, `Bundle ${definition.displayName} created.`)
      }
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : 'The bundle could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const title = bundle ? currentVersionOf(bundle).displayName : 'New bundle'
  return (
    <form className="bundle-form" aria-label={bundle ? `Edit ${title}` : 'New bundle'} onSubmit={event => void save(event)} noValidate>
      <div className="bundle-form-intro">
        <small>{bundle ? `Editing ${title} · v${baseVersion}` : 'New bundle'}</small>
        <p>{bundle ? `Saving creates version ${nextVersion}. Version ${baseVersion} and every past issue stay exactly as they were.` : 'Saving creates version 1. Later edits add versions; issues always keep the version they used.'}</p>
      </div>

      <label className="field">
        Bundle name
        <input aria-label="Bundle name" value={draft.displayName} maxLength={MAX_NAME_LENGTH} onChange={event => update({ displayName: event.target.value })} placeholder="e.g. Color Guard" autoComplete="off" disabled={busy} />
      </label>
      <div className="form-grid bundle-form-grid">
        <label className="field">
          Applies to
          <select aria-label="Applies to" value={draft.genderApplicability} onChange={event => update({ genderApplicability: event.target.value as Applicability })} disabled={busy}>
            {APPLICABILITY.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Purpose / event
          <input aria-label="Purpose" list={`${ids}-purposes`} value={draft.purpose} maxLength={MAX_PURPOSE_LENGTH} onChange={event => update({ purpose: event.target.value })} placeholder="e.g. NSU, PT, BLT" autoComplete="off" disabled={busy} />
          <datalist id={`${ids}-purposes`}>
            {purposes.map(purpose => (
              <option key={purpose} value={purpose} />
            ))}
          </datalist>
        </label>
      </div>
      <label className="line-toggle bundle-active-toggle">
        <input type="checkbox" aria-label="Active" checked={draft.active} onChange={event => update({ active: event.target.checked })} disabled={busy} />
        <span>
          <strong>Active</strong>
          <small>Offered when issuing. Inactive bundles keep their history.</small>
        </span>
      </label>

      <h3 className="bundle-lines-heading">
        Lines <span>{draft.lines.length}</span>
      </h3>
      {draft.lines.length ? (
        <ol className="bundle-lines">
          {draft.lines.map((line, index) => {
            const label = line.displayLabel
            const ready = lineReady(line, projection.inventory)
            const known = line.catalogId !== undefined && activeCatalog.some(item => item.catalogId === line.catalogId)
            return (
              <li key={line.lineId} className="bundle-line">
                <div className="bundle-line-top">
                  <span className="bundle-line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <select aria-label={`Line ${index + 1} item`} value={line.catalogId ?? ''} onChange={event => changeItem(index, event.target.value)} disabled={busy}>
                    {!known && <option value={line.catalogId ?? ''}>{label} ({line.catalogId ? 'inactive' : 'fixed size'})</option>}
                    <CatalogOptions groups={allGroups} />
                  </select>
                  <div className="bundle-line-order">
                    <button type="button" aria-label={`Move ${label} up`} disabled={busy || index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp aria-hidden="true" />
                    </button>
                    <button type="button" aria-label={`Move ${label} down`} disabled={busy || index === draft.lines.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown aria-hidden="true" />
                    </button>
                    <button type="button" className="bundle-line-remove" aria-label={`Remove ${label}`} disabled={busy} onClick={() => remove(index)}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="bundle-line-options">
                  <label className="line-toggle">
                    <input type="checkbox" aria-label={`${label} required`} checked={line.required} onChange={event => updateLine(index, { required: event.target.checked })} disabled={busy} />
                    <span>{line.required ? 'Required' : 'Optional'}</span>
                  </label>
                  <label className="bundle-line-quantity">
                    Default qty
                    <select aria-label={`${label} default quantity`} value={line.defaultQuantity} onChange={event => updateLine(index, { defaultQuantity: Number(event.target.value) })} disabled={busy}>
                      {QUANTITIES.map(quantity => (
                        <option key={quantity} value={quantity}>
                          {quantity}
                        </option>
                      ))}
                    </select>
                  </label>
                  <em className={`status-badge ${ready ? 'success' : 'warning'}`}>
                    {line.supportsSizing ? 'Sized' : 'One size'}
                    {ready ? '' : ' · no sizes yet'}
                  </em>
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="bundle-empty">No lines yet. Add at least one item.</p>
      )}

      <div className="bundle-add-line">
        <label className="field">
          Add item
          <select aria-label="Add item" value={addCatalogId} onChange={event => setAddCatalogId(event.target.value)} disabled={busy || !addable.length}>
            <option value="">{addable.length ? 'Choose a catalog item…' : 'Every active item is already listed'}</option>
            <CatalogOptions groups={addable} />
          </select>
        </label>
        <button type="button" className="secondary-button" disabled={busy || !addCatalogId} onClick={addLine}>
          <Plus aria-hidden="true" /> Add line
        </button>
      </div>

      {error && (
        <div className="workflow-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          {error}
        </div>
      )}
      <div className="modal-actions bundle-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={busy || unchanged}>
          {busy ? 'Saving…' : bundle ? `Save as v${nextVersion}` : 'Create bundle'}
        </button>
      </div>
      {unchanged && <p className="bundle-hint">Make a change to save a new version.</p>}
    </form>
  )
}
