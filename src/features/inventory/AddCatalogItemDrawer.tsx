import { useId, useState, type FormEvent } from 'react'
import { AlertTriangle, PackagePlus } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import { SIZE_SCHEMES } from '../../stage3/sizes'
import { MAX_COUNT_INCREMENT, MAX_COUNT_QUANTITY, categoriesOf, errorMessage, parseWhole } from './catalogModel'

type Props = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  /** Called after a successful save with the new catalog item, so its sizes can be set up next. */
  onCreated: (catalogId: string | undefined) => void
  close: () => void
}

type FieldErrors = Partial<Record<'name' | 'category' | 'niin' | 'threshold' | 'increment', string>>

/** Adds a catalog item. The drawer only closes once the signed event has been saved. */
export function AddCatalogItemDrawer({ projection, controller, onProjection, notify, onCreated, close }: Props) {
  const ids = useId()
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [niin, setNiin] = useState('')
  const [sized, setSized] = useState(true)
  const [schemeId, setSchemeId] = useState('')
  const [threshold, setThreshold] = useState('')
  const [increment, setIncrement] = useState('1')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const duplicate = projection.catalog.find(item => name.trim() && item.name.trim().toLowerCase() === name.trim().toLowerCase())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const found: FieldErrors = {}
    if (!name.trim()) found.name = 'Enter an item name.'
    else if (name.trim().length > 80) found.name = 'Item names can be at most 80 characters.'
    if (!category.trim()) found.category = 'Enter a category, e.g. PT or Accessories.'
    else if (category.trim().length > 40) found.category = 'Categories can be at most 40 characters.'
    if (niin.trim().length > 40) found.niin = 'NIIN / reference must be at most 40 characters.'
    const thresholdValue = threshold.trim() ? parseWhole(threshold, 0, MAX_COUNT_QUANTITY) : undefined
    if (threshold.trim() && thresholdValue === undefined) found.threshold = 'Use a whole number of 0 or more, or leave it blank.'
    const incrementValue = parseWhole(increment, 1, MAX_COUNT_INCREMENT)
    if (incrementValue === undefined) found.increment = `Use a whole number from 1 to ${MAX_COUNT_INCREMENT}.`
    setErrors(found)
    const firstInvalid = Object.keys(found)[0]
    if (firstInvalid) {
      document.getElementById(`${ids}-${firstInvalid}`)?.focus()
      return
    }
    setBusy(true)
    setFormError('')
    try {
      const next = await controller.createCatalogItem({
        name: name.trim(),
        category: category.trim(),
        niin: niin.trim(),
        sized,
        ...(sized && schemeId ? { sizeScheme: schemeId } : {}),
        ...(thresholdValue === undefined ? {} : { reorderAt: thresholdValue }),
        countIncrement: incrementValue,
      })
      const created = next.catalog.find(item => !projection.catalog.some(existing => existing.catalogId === item.catalogId))
      onProjection(next)
      notify(sized ? `${name.trim()} added. Now add the sizes you stock.` : `${name.trim()} added with one size, at 0 on hand.`)
      onCreated(created?.catalogId)
    } catch (reason) {
      setFormError(errorMessage(reason, 'The item could not be saved. Your entries are kept — try again.'))
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
    <Drawer title="Add item" icon={<PackagePlus />} close={close}>
      <form className="inventory-catalog-drawer" aria-label="Add catalog item" onSubmit={event => void submit(event)} noValidate>
        <p className="catalog-section-text">
          New items start at 0 on hand. Quantities only come from counts and received stock, never from this form.
        </p>
        {duplicate && (
          <p className="workflow-warning">
            <AlertTriangle />
            <span>
              “{duplicate.name}” already exists in {duplicate.category}. If it just needs another size, open it and add sizes instead.
            </span>
          </p>
        )}
        <div className="field catalog-field">
          <label htmlFor={`${ids}-name`}>Item name</label>
          <input {...fieldProps('name')} maxLength={80} value={name} placeholder="e.g. Rifle Sling" onChange={event => setName(event.target.value)} />
          {fieldError('name')}
        </div>
        <div className="catalog-field-row">
          <div className="field catalog-field">
            <label htmlFor={`${ids}-category`}>Category</label>
            <input {...fieldProps('category')} maxLength={40} list={`${ids}-categories`} value={category} onChange={event => setCategory(event.target.value)} />
            <datalist id={`${ids}-categories`}>
              {categoriesOf(projection.catalog).map(option => (
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
        <label className="catalog-check">
          <input type="checkbox" checked={sized} onChange={event => setSized(event.target.checked)} />
          <span>
            Comes in sizes
            <small>{sized ? 'You will pick its sizes next.' : 'It gets a single “One size” entry you can count right away.'}</small>
          </span>
        </label>
        {sized && (
          <div className="field catalog-field">
            <label htmlFor={`${ids}-scheme`}>Size chart (optional)</label>
            <select id={`${ids}-scheme`} value={schemeId} onChange={event => setSchemeId(event.target.value)}>
              <option value="">Choose later</option>
              {SIZE_SCHEMES.map(scheme => (
                <option key={scheme.id} value={scheme.id}>
                  {scheme.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="catalog-field-row">
          <div className="field catalog-field">
            <label htmlFor={`${ids}-threshold`}>Low-stock threshold</label>
            <input
              {...fieldProps('threshold')}
              type="number"
              inputMode="numeric"
              min={0}
              value={threshold}
              placeholder="No warning"
              onChange={event => setThreshold(event.target.value)}
            />
            {fieldError('threshold')}
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
            {fieldError('increment')}
          </div>
        </div>
        {Object.keys(errors).length > 0 && (
          <p className="workflow-error" role="alert">
            <AlertTriangle />
            Fix the highlighted fields to add this item.
          </p>
        )}
        {formError && (
          <p className="workflow-error" role="alert">
            <AlertTriangle />
            {formError}
          </p>
        )}
        <div className="split-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Add item'}
          </button>
        </div>
      </form>
    </Drawer>
  )
}
