import { useId, useState, type FormEvent } from 'react'
import { AlertTriangle, ClipboardCheck, Eye, EyeOff, PackagePlus, Pencil } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CatalogItemProjection, InventoryProjection } from '../../distributed/types'
import { sizeKey } from '../../domain'
import { normalizeSizeLabel } from '../../stage3/sizes'
import { MAX_COUNT_QUANTITY, MAX_RECEIVE_QUANTITY, countedOn, errorMessage, needsAttention, parseWhole, plural, type InventoryStatus } from './catalogModel'

type SizeChanges = Parameters<DistributedAppController['updateInventoryItem']>[1]
type OpenForm = { itemId: string; kind: 'receive' | 'edit' }

type Props = {
  item: CatalogItemProjection
  variants: InventoryProjection[]
  /** Count Due / Reconciliation Required per size, keyed by inventory entityId. */
  statuses?: ReadonlyMap<string, InventoryStatus>
  canAdjust: boolean
  canCount: boolean
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  onCount: (itemId: string) => void
}

/** Every size of one catalog item with its stock numbers and the per-size actions. */
export function SizeList({ item, variants, statuses, canAdjust, canCount, controller, onProjection, notify, onCount }: Props) {
  const ids = useId()
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<OpenForm>()
  const [busyId, setBusyId] = useState<string>()
  // "34 r", "34-R" and "7 1/2" find 34R and 7.5 the same way the catalog search does.
  const needle = sizeKey(filter.trim())
  const shown = variants.filter(variant => !needle || sizeKey(variant.variant).includes(needle))
  const ordered = [...shown.filter(variant => variant.active), ...shown.filter(variant => !variant.active)]
  const nameOf = (variant: InventoryProjection) => (item.sized ? variant.variant : item.name)
  const isOpen = (variant: InventoryProjection, kind: OpenForm['kind']) => open?.itemId === variant.entityId && open.kind === kind
  const toggleForm = (variant: InventoryProjection, kind: OpenForm['kind']) =>
    setOpen(isOpen(variant, kind) ? undefined : { itemId: variant.entityId, kind })
  const finish = (next: ArgusAppProjection, message: string) => {
    setOpen(undefined)
    onProjection(next)
    notify(message)
  }
  const toggleActive = async (variant: InventoryProjection) => {
    setBusyId(variant.entityId)
    try {
      const next = await controller.updateInventoryItem(variant.entityId, { active: !variant.active })
      finish(
        next,
        variant.active
          ? `${item.name} · ${variant.variant} deactivated. It no longer appears for counting or issue; reactivate it any time.`
          : `${item.name} · ${variant.variant} reactivated.`,
      )
    } catch (reason) {
      notify(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <section className="catalog-section" aria-labelledby={`${ids}-heading`}>
      <div className="catalog-section-head">
        <h3 id={`${ids}-heading`}>{item.sized ? `Sizes (${variants.length})` : 'Stock'}</h3>
        {variants.length > 12 && (
          <input className="size-list-filter" aria-label="Filter sizes" placeholder="Filter sizes…" value={filter} onChange={event => setFilter(event.target.value)} />
        )}
      </div>
      {!variants.length ? (
        <p className="empty-state catalog-empty">
          <strong>No sizes yet</strong>
          <span>Add the sizes you actually stock below. Each new size starts at 0 — then count it or receive stock.</span>
        </p>
      ) : (
        <ul className="size-list" aria-label={item.sized ? `Sizes of ${item.name}` : `Stock of ${item.name}`}>
          {ordered.map(variant => {
            const labelId = `${ids}-${variant.entityId}`
            const attention = needsAttention(variant)
            const status = statuses?.get(variant.entityId)
            return (
              <li key={variant.entityId} className={variant.active ? 'size-row' : 'size-row inactive'} aria-labelledby={labelId}>
                <div className="size-row-main">
                  <b id={labelId} className="size-label">
                    {variant.variant}
                  </b>
                  <dl className="size-stats">
                    <div>
                      <dt>On hand</dt>
                      <dd>{variant.onHand}</dd>
                    </div>
                    <div>
                      <dt>Issued</dt>
                      <dd>{variant.issued}</dd>
                    </div>
                    <div>
                      <dt>Low at</dt>
                      <dd>{variant.reorderAt ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Counted</dt>
                      <dd>{countedOn(variant.lastCountedAt)}</dd>
                    </div>
                  </dl>
                  {!variant.active ? (
                    <em className="status-badge">Inactive</em>
                  ) : attention ? (
                    <em className={`status-badge ${variant.onHand === 0 ? 'danger' : 'warning'}`}>{variant.onHand === 0 ? 'Out' : 'Low'}</em>
                  ) : null}
                  {status?.reconciliationRequired && <em className="status-badge danger">Reconcile</em>}
                  {status?.countDue && <em className="status-badge warning">Count due</em>}
                </div>
                <div className="size-actions">
                  {variant.active && canCount && (
                    <button type="button" className="secondary-button" aria-label={`Count ${nameOf(variant)}`} onClick={() => onCount(variant.entityId)}>
                      <ClipboardCheck />
                      Count
                    </button>
                  )}
                  {variant.active && canAdjust && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`Receive stock for ${nameOf(variant)}`}
                      aria-expanded={isOpen(variant, 'receive')}
                      onClick={() => toggleForm(variant, 'receive')}
                    >
                      <PackagePlus />
                      Receive
                    </button>
                  )}
                  {canAdjust && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={item.sized ? `Edit size ${variant.variant}` : `Edit ${item.name} threshold`}
                      aria-expanded={isOpen(variant, 'edit')}
                      onClick={() => toggleForm(variant, 'edit')}
                    >
                      <Pencil />
                      Edit
                    </button>
                  )}
                  {canAdjust && item.sized && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`${variant.active ? 'Deactivate' : 'Reactivate'} size ${variant.variant}`}
                      disabled={busyId === variant.entityId}
                      onClick={() => void toggleActive(variant)}
                    >
                      {variant.active ? <EyeOff /> : <Eye />}
                      {variant.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </div>
                {isOpen(variant, 'receive') && (
                  <ReceiveForm
                    variant={variant}
                    name={nameOf(variant)}
                    controller={controller}
                    onCancel={() => setOpen(undefined)}
                    onDone={(next, quantity) => finish(next, `Received ${quantity} × ${item.name}${item.sized ? ` · ${variant.variant}` : ''}.`)}
                  />
                )}
                {isOpen(variant, 'edit') && (
                  <EditSizeForm
                    variant={variant}
                    sized={item.sized}
                    siblings={variants}
                    controller={controller}
                    onCancel={() => setOpen(undefined)}
                    onDone={next => finish(next, `${item.name} · ${variant.variant} updated.`)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {variants.length > 0 && !ordered.length && <p className="catalog-section-text">No sizes match “{filter}”.</p>}
      {variants.length > 0 && <p className="catalog-section-text">{plural(variants.filter(variant => variant.active).length, 'active size')} · counting replaces on-hand, receiving adds to it.</p>}
    </section>
  )
}

function FormError({ message }: { message: string }) {
  return message ? (
    <p className="workflow-error" role="alert">
      <AlertTriangle />
      {message}
    </p>
  ) : null
}

/** Receiving is additive: two people each receiving 10 means +20 for everyone. */
function ReceiveForm({
  variant,
  name,
  controller,
  onDone,
  onCancel,
}: {
  variant: InventoryProjection
  name: string
  controller: DistributedAppController
  onDone: (projection: ArgusAppProjection, quantity: number) => void
  onCancel: () => void
}) {
  const ids = useId()
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = parseWhole(quantity, 1, MAX_RECEIVE_QUANTITY)
    if (value === undefined) {
      setError(`Enter a whole number from 1 to ${MAX_RECEIVE_QUANTITY}.`)
      return
    }
    setBusy(true)
    setError('')
    try {
      onDone(await controller.receiveStock(variant.entityId, value, note.trim()), value)
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }
  return (
    <form className="size-form" aria-label={`Receive stock for ${name}`} onSubmit={event => void submit(event)} noValidate>
      <p className="catalog-section-text">Adds to the {variant.onHand} on hand. To replace the number after a physical count, use Count instead.</p>
      <div className="field catalog-field">
        <label htmlFor={`${ids}-quantity`}>Quantity received</label>
        <input
          id={`${ids}-quantity`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_RECEIVE_QUANTITY}
          value={quantity}
          aria-invalid={Boolean(error)}
          onChange={event => setQuantity(event.target.value)}
        />
      </div>
      <div className="field catalog-field">
        <label htmlFor={`${ids}-note`}>Note (optional)</label>
        <input id={`${ids}-note`} maxLength={500} value={note} placeholder="e.g. Delivery, box 3 of 4" onChange={event => setNote(event.target.value)} />
      </div>
      <FormError message={error} />
      <div className="split-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? 'Saving…' : 'Add to stock'}
        </button>
      </div>
    </form>
  )
}

function EditSizeForm({
  variant,
  sized,
  siblings,
  controller,
  onDone,
  onCancel,
}: {
  variant: InventoryProjection
  sized: boolean
  siblings: InventoryProjection[]
  controller: DistributedAppController
  onDone: (projection: ArgusAppProjection) => void
  onCancel: () => void
}) {
  const ids = useId()
  const [label, setLabel] = useState(variant.variant)
  const [threshold, setThreshold] = useState(variant.reorderAt === undefined ? '' : String(variant.reorderAt))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const changesOrError = (): SizeChanges | string => {
    const changes: SizeChanges = {}
    if (sized) {
      let normalized: string
      try {
        normalized = normalizeSizeLabel(label)
      } catch (reason) {
        return errorMessage(reason)
      }
      const taken = siblings.some(other => other.entityId !== variant.entityId && other.variant.toLowerCase() === normalized.toLowerCase())
      if (taken) return `Size ${normalized} already exists.`
      if (normalized !== variant.variant) changes.variant = normalized
    }
    if (threshold.trim()) {
      const value = parseWhole(threshold, 0, MAX_COUNT_QUANTITY)
      if (value === undefined) return 'Low-stock threshold must be a whole number of 0 or more.'
      if (value !== variant.reorderAt) changes.reorderAt = value
    } else if (variant.reorderAt !== undefined) {
      return 'A threshold can’t be removed once set. Use 0 to warn only when this size runs out.'
    }
    return changes
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const changes = changesOrError()
    if (typeof changes === 'string') {
      setError(changes)
      return
    }
    if (!Object.keys(changes).length) {
      onCancel()
      return
    }
    setBusy(true)
    setError('')
    try {
      onDone(await controller.updateInventoryItem(variant.entityId, changes))
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }
  return (
    <form className="size-form" aria-label={sized ? `Edit size ${variant.variant}` : 'Edit low-stock threshold'} onSubmit={event => void submit(event)} noValidate>
      {sized && (
        <div className="field catalog-field">
          <label htmlFor={`${ids}-label`}>Size label</label>
          <input id={`${ids}-label`} maxLength={24} value={label} onChange={event => setLabel(event.target.value)} />
        </div>
      )}
      <div className="field catalog-field">
        <label htmlFor={`${ids}-threshold`}>Low-stock threshold</label>
        <input
          id={`${ids}-threshold`}
          type="number"
          inputMode="numeric"
          min={0}
          value={threshold}
          placeholder="No warning"
          onChange={event => setThreshold(event.target.value)}
        />
      </div>
      <FormError message={error} />
      <div className="split-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? 'Saving…' : 'Save size'}
        </button>
      </div>
    </form>
  )
}
