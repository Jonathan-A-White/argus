import { useId, useState, type FormEvent } from 'react'
import { AlertTriangle, ClipboardCheck, GitMerge, Shirt } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, CatalogItemProjection, InventoryProjection } from '../../distributed/types'
import { sizeScheme } from '../../stage3/sizes'
import { ReceiptHistory } from '../corrections/ReceiptHistory'
import { AddSizesPanel } from './AddSizesPanel'
import { SizeList } from './SizeList'
import { describeDuplicate, findLikelyDuplicates } from './duplicates'
import {
  MAX_COUNT_INCREMENT,
  MAX_COUNT_QUANTITY,
  catalogFlags,
  catalogStatus,
  categoriesOf,
  describeReconciliation,
  errorMessage,
  parseWhole,
  plural,
  sumOf,
  toneClass,
  variantsOf,
  type InventoryStatus,
} from './catalogModel'

type Props = {
  catalogId: string
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  onCount: (itemId: string) => void
  /** Status of every size (Count Due, Reconciliation Required), keyed by inventory entityId. */
  statuses: ReadonlyMap<string, InventoryStatus>
  countIntervalDays: number
  onOpenConflicts?: () => void
  close: () => void
}

/** Everything about one catalog item: its sizes and stock, adding sizes, and the item's details. */
export function ItemEditorDrawer({ catalogId, projection, controller, can, onProjection, notify, onCount, statuses, countIntervalDays, onOpenConflicts, close }: Props) {
  const item = projection.catalog.find(candidate => candidate.catalogId === catalogId)
  if (!item) return null
  const variants = variantsOf(projection.inventory, catalogId)
  const onHand = sumOf(variants, 'onHand')
  const issued = sumOf(variants, 'issued')
  const status = catalogStatus(item, variants)
  const activeSizes = variants.filter(variant => variant.active).length
  const canCreate = can('inventory.create')
  const flags = catalogFlags(item.active ? variants : [], statuses)

  return (
    <Drawer title={item.name} icon={<Shirt />} close={close}>
      <div className="inventory-catalog-drawer">
        <div className="record-hero">
          <div>
            <small>
              {item.category.toUpperCase()} · {item.niin ? `NIIN ${item.niin}` : 'NO NIIN'}
            </small>
            <b>
              {onHand} on hand · {issued} issued
            </b>
            <p>{item.sized ? (variants.length ? `${plural(activeSizes, 'active size')} of ${variants.length}` : 'No sizes set yet') : 'One size'}</p>
          </div>
          <span className="catalog-hero-badges">
            <em className={`status-badge ${toneClass(status.tone)}`}>{status.label}</em>
            {flags.reconcile > 0 && <em className="status-badge danger">Reconciliation required</em>}
            {flags.countDue > 0 && <em className="status-badge warning">Count due</em>}
          </span>
        </div>
        {onHand === 0 && activeSizes > 0 && <p className="catalog-zero-hint">0 on hand — record a count or receive stock.</p>}
        {flags.countDue > 0 && (
          <p className="catalog-zero-hint">
            {item.sized ? `${plural(flags.countDue, 'size')} ${flags.countDue === 1 ? 'is' : 'are'}` : 'This item is'} due for a count — never counted, or not counted in the last{' '}
            {countIntervalDays} days.
          </p>
        )}
        {flags.reconcile > 0 && (
          <ReconciliationPanel
            item={item}
            variants={variants}
            statuses={statuses}
            canCount={can('inventory.count')}
            onCount={onCount}
            {...(onOpenConflicts ? { onOpenConflicts } : {})}
          />
        )}
        <SizeList
          item={item}
          variants={variants}
          statuses={statuses}
          canAdjust={can('inventory.adjust')}
          canCount={can('inventory.count')}
          controller={controller}
          onProjection={onProjection}
          notify={notify}
          onCount={onCount}
        />
        <ReceiptHistory variants={variants} projection={projection} controller={controller} canCorrect={can('inventory.adjust')} onProjection={onProjection} notify={notify} />
        {item.sized && item.active && canCreate && (
          <AddSizesPanel key={item.catalogId} item={item} variants={variants} controller={controller} onProjection={onProjection} notify={notify} />
        )}
        {item.sized && !canCreate && !variants.length && (
          <p className="catalog-section-text">Ask a supply officer to add the sizes your unit stocks.</p>
        )}
        {/* Re-keyed on version so an edit saved here or synced from another device refreshes the form instead of leaving stale values that would revert it. */}
        <ItemDetailsForm
          key={`${item.catalogId}:${item.version}`}
          item={item}
          variants={variants}
          catalog={projection.catalog}
          categories={categoriesOf(projection.catalog)}
          canEdit={can('inventory.adjust')}
          controller={controller}
          onProjection={onProjection}
          notify={notify}
        />
      </div>
    </Drawer>
  )
}

/** Sizes that need an officer's attention, why, and where to go to settle it. */
function ReconciliationPanel({
  item,
  variants,
  statuses,
  canCount,
  onCount,
  onOpenConflicts,
}: {
  item: CatalogItemProjection
  variants: InventoryProjection[]
  statuses: ReadonlyMap<string, InventoryStatus>
  canCount: boolean
  onCount: (itemId: string) => void
  onOpenConflicts?: () => void
}) {
  const ids = useId()
  const flagged = variants.filter(variant => variant.active && statuses.get(variant.entityId)?.reconciliationRequired)
  return (
    <section className="workflow-warning catalog-reconcile" aria-labelledby={`${ids}-heading`}>
      <GitMerge />
      <div>
        <strong id={`${ids}-heading`}>Reconciliation required</strong>
        <ul aria-label="Reconciliation required">
          {flagged.map(variant => {
            const reasons = statuses.get(variant.entityId)?.reconciliation ?? []
            const conflict = reasons.some(reason => reason.kind === 'CONFLICT')
            const counting = reasons.some(reason => reason.kind !== 'CONFLICT')
            const label = item.sized ? variant.variant : item.name
            return (
              <li key={variant.entityId}>
                <b>{label}</b>
                <span>{reasons.map(describeReconciliation).join(' · ')}</span>
                <span className="catalog-reconcile-actions">
                  {conflict && onOpenConflicts && (
                    <button type="button" className="secondary-button" aria-label={`Open conflicts for ${label}`} onClick={onOpenConflicts}>
                      Open conflicts
                    </button>
                  )}
                  {counting && canCount && (
                    <button type="button" className="secondary-button" aria-label={`Recount ${label}`} onClick={() => onCount(variant.entityId)}>
                      <ClipboardCheck />
                      Recount
                    </button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

type CatalogChanges = Parameters<DistributedAppController['updateCatalogItem']>[1]
type FieldErrors = Partial<Record<'name' | 'category' | 'niin' | 'threshold' | 'increment', string>>

const thresholdText = (value?: number) => (value === undefined ? '' : String(value))

function ItemDetailsForm({
  item,
  variants,
  catalog,
  categories,
  canEdit,
  controller,
  onProjection,
  notify,
}: {
  item: CatalogItemProjection
  variants: InventoryProjection[]
  catalog: CatalogItemProjection[]
  categories: string[]
  canEdit: boolean
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
}) {
  const ids = useId()
  const [name, setName] = useState(item.name)
  const [category, setCategory] = useState(item.category)
  const [niin, setNiin] = useState(item.niin)
  const [threshold, setThreshold] = useState(thresholdText(item.reorderAt))
  const [increment, setIncrement] = useState(String(item.countIncrement))
  const [active, setActive] = useState(item.active)
  const [applyToSizes, setApplyToSizes] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const scheme = sizeScheme(item.sizeScheme)
  const dirty =
    name !== item.name ||
    category !== item.category ||
    niin !== item.niin ||
    threshold !== thresholdText(item.reorderAt) ||
    increment !== String(item.countIncrement) ||
    active !== item.active ||
    applyToSizes
  // Only a new name or NIIN can make this item look like another one; the warning never blocks saving.
  const renamed = name.trim() !== item.name || niin.trim() !== item.niin
  const duplicates = canEdit && renamed ? findLikelyDuplicates({ name, niin }, catalog, { excludeCatalogId: item.catalogId }) : []

  const validate = () => {
    const found: FieldErrors = {}
    if (!name.trim() || name.trim().length > 80) found.name = 'Enter an item name of up to 80 characters.'
    if (!category.trim() || category.trim().length > 40) found.category = 'Enter a category of up to 40 characters.'
    if (niin.trim().length > 40) found.niin = 'NIIN / reference must be at most 40 characters.'
    const thresholdValue = threshold.trim() ? parseWhole(threshold, 0, MAX_COUNT_QUANTITY) : undefined
    if (threshold.trim() && thresholdValue === undefined) found.threshold = 'Use a whole number of 0 or more.'
    if (!threshold.trim() && item.reorderAt !== undefined) found.threshold = 'A threshold can’t be removed once set. Use 0 to warn only when a size runs out.'
    const incrementValue = parseWhole(increment, 1, MAX_COUNT_INCREMENT)
    if (incrementValue === undefined) found.increment = `Use a whole number from 1 to ${MAX_COUNT_INCREMENT}.`
    return { found, thresholdValue, incrementValue }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const { found, thresholdValue, incrementValue } = validate()
    setErrors(found)
    if (Object.keys(found).length || incrementValue === undefined) return
    const changes: CatalogChanges = {}
    if (name.trim() !== item.name) changes.name = name.trim()
    if (category.trim() !== item.category) changes.category = category.trim()
    if (niin.trim() !== item.niin) changes.niin = niin.trim()
    if (thresholdValue !== undefined && thresholdValue !== item.reorderAt) changes.reorderAt = thresholdValue
    if (incrementValue !== item.countIncrement) changes.countIncrement = incrementValue
    if (active !== item.active) changes.active = active
    // The item threshold is the default for new sizes; existing sizes keep their own unless asked.
    const sizesToUpdate = applyToSizes && thresholdValue !== undefined ? variants.filter(variant => variant.reorderAt !== thresholdValue) : []
    setBusy(true)
    setFormError('')
    let latest: ArgusAppProjection | undefined
    try {
      if (Object.keys(changes).length) latest = await controller.updateCatalogItem(item.catalogId, changes)
      for (const variant of sizesToUpdate) latest = await controller.updateInventoryItem(variant.entityId, { reorderAt: thresholdValue })
      setName(name.trim())
      setCategory(category.trim())
      setNiin(niin.trim())
      setApplyToSizes(false)
      notify(`${name.trim()} saved.`)
    } catch (reason) {
      setFormError(errorMessage(reason))
    } finally {
      // Publish whatever did save, even if a later step failed.
      if (latest) onProjection(latest)
      setBusy(false)
    }
  }

  const fieldProps = (key: keyof FieldErrors) => ({
    id: `${ids}-${key}`,
    'aria-invalid': Boolean(errors[key]),
    'aria-describedby': errors[key] ? `${ids}-${key}-error` : undefined,
  })
  const fieldError = (key: keyof FieldErrors) =>
    errors[key] ? (
      <small id={`${ids}-${key}-error`} className="catalog-field-error">
        {errors[key]}
      </small>
    ) : null

  return (
    <section className="catalog-section" aria-labelledby={`${ids}-heading`}>
      <div className="catalog-section-head">
        <h3 id={`${ids}-heading`}>Item details</h3>
      </div>
      {!canEdit && <p className="catalog-section-text">Only supply officers can change item details.</p>}
      <form aria-label="Item details" onSubmit={event => void submit(event)} noValidate>
        <fieldset className="catalog-fieldset" disabled={!canEdit || busy}>
          <div className="field catalog-field">
            <label htmlFor={`${ids}-name`}>Name</label>
            <input {...fieldProps('name')} maxLength={80} value={name} onChange={event => setName(event.target.value)} />
            {fieldError('name')}
          </div>
          {duplicates.length > 0 && (
            <div className="workflow-warning catalog-duplicates" role="status">
              <AlertTriangle />
              <div>
                <strong>Looks like an item you already have</strong>
                <ul aria-label="Likely duplicates">
                  {duplicates.map(duplicate => (
                    <li key={duplicate.item.catalogId}>
                      “{duplicate.item.name}” · {duplicate.item.category}
                      {duplicate.item.active ? '' : ' (inactive)'} — {describeDuplicate(duplicate)}
                    </li>
                  ))}
                </ul>
                <small>You can still save. Keeping one catalog item per kind of gear keeps counts and issue history in one place.</small>
              </div>
            </div>
          )}
          <div className="catalog-field-row">
            <div className="field catalog-field">
              <label htmlFor={`${ids}-category`}>Category</label>
              <input {...fieldProps('category')} maxLength={40} list={`${ids}-categories`} value={category} onChange={event => setCategory(event.target.value)} />
              <datalist id={`${ids}-categories`}>
                {categories.map(option => (
                  <option key={option} value={option} />
                ))}
              </datalist>
              {fieldError('category')}
            </div>
            <div className="field catalog-field">
              <label htmlFor={`${ids}-niin`}>NIIN / reference</label>
              <input {...fieldProps('niin')} maxLength={40} value={niin} placeholder="Optional" onChange={event => setNiin(event.target.value)} />
              {fieldError('niin')}
            </div>
          </div>
          <div className="catalog-field-row">
            <div className="field catalog-field">
              <label htmlFor={`${ids}-threshold`}>Default low-stock threshold</label>
              <input
                {...fieldProps('threshold')}
                type="number"
                inputMode="numeric"
                min={0}
                value={threshold}
                placeholder="No warning"
                onChange={event => setThreshold(event.target.value)}
              />
              {fieldError('threshold') ?? <small className="catalog-field-help">Applied to sizes added from now on.</small>}
            </div>
            <div className="field catalog-field">
              <label htmlFor={`${ids}-increment`}>Count increment</label>
              <input
                {...fieldProps('increment')}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_COUNT_INCREMENT}
                value={increment}
                onChange={event => setIncrement(event.target.value)}
              />
              {fieldError('increment') ?? <small className="catalog-field-help">Default “count by” step, e.g. 12 for boxed socks.</small>}
            </div>
          </div>
          {variants.length > 0 && threshold.trim() !== '' && (
            <label className="catalog-check">
              <input type="checkbox" checked={applyToSizes} onChange={event => setApplyToSizes(event.target.checked)} />
              <span>Also apply this threshold to the {plural(variants.length, 'existing size')}</span>
            </label>
          )}
          <label className="catalog-check">
            <input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />
            <span>
              Active — shown for counting and issue
              <small>
                {item.active
                  ? 'Turning this off also deactivates every size.'
                  : 'Reactivating the item does not reactivate its sizes; reactivate the ones you still stock.'}
              </small>
            </span>
          </label>
          {item.sized && <p className="catalog-section-text">Size chart: {scheme ? scheme.label : 'none chosen'}</p>}
        </fieldset>
        {formError && (
          <p className="workflow-error" role="alert">
            <AlertTriangle />
            {formError}
          </p>
        )}
        {canEdit && (
          <button type="submit" className="primary-button" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save details'}
          </button>
        )}
      </form>
    </section>
  )
}
