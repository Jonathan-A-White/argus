import { useId, useState } from 'react'
import { AlertTriangle, BookOpen, Check, Search } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CatalogItemProjection, InventoryProjection } from '../../distributed/types'
import { SIZE_SCHEMES, sizeScheme } from '../../stage3/sizes'
import { MAX_SIZES_PER_ADD, errorMessage, newSizeLabels, parseSizeLabels, plural } from './catalogModel'

type Props = {
  item: CatalogItemProjection
  variants: InventoryProjection[]
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
}

/**
 * Staff choose the sizes they really stock, from a supply-manual size chart and/or free text.
 * Every added size starts at zero; quantities only ever come from counts and receipts.
 */
export function AddSizesPanel({ item, variants, controller, onProjection, notify }: Props) {
  const ids = useId()
  const [schemeId, setSchemeId] = useState(item.sizeScheme ?? '')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [customText, setCustomText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const scheme = sizeScheme(schemeId)
  const existing = new Set(variants.map(variant => variant.variant.toLowerCase()))
  const isAdded = (size: string) => existing.has(size.toLowerCase())
  const needle = filter.trim().toLowerCase()
  const shown = scheme ? scheme.sizes.filter(size => !needle || size.toLowerCase().includes(needle)) : []
  const selectable = shown.filter(size => !isAdded(size))
  const custom = parseSizeLabels(customText)
  const chosenFromChart = scheme ? scheme.sizes.filter(size => selected.includes(size)) : []
  const pending = newSizeLabels([...chosenFromChart, ...custom.labels], variants.map(variant => variant.variant))
  const alreadyTyped = custom.labels.filter(isAdded)

  const changeScheme = (id: string) => {
    setSchemeId(id)
    setSelected([])
    setFilter('')
  }
  const toggle = (size: string) => setSelected(current => (current.includes(size) ? current.filter(entry => entry !== size) : [...current, size]))
  const selectShown = () => setSelected(current => [...new Set([...current, ...selectable])])

  const submit = async () => {
    if (custom.invalid.length) {
      setError(`Size labels must be 1–24 characters: ${custom.invalid.join(', ')}`)
      return
    }
    if (!pending.length) {
      setError('Choose at least one size that is not already added.')
      return
    }
    if (pending.length > MAX_SIZES_PER_ADD) {
      setError(`Add at most ${MAX_SIZES_PER_ADD} sizes at a time.`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await controller.addCatalogSizes(item.catalogId, pending)
      setSelected([])
      setCustomText('')
      onProjection(next)
      notify(`Added ${plural(pending.length, 'size')} to ${item.name}. Each starts at 0 — count or receive stock next.`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="catalog-section add-sizes" aria-labelledby={`${ids}-heading`}>
      <div className="catalog-section-head">
        <h3 id={`${ids}-heading`}>Add sizes</h3>
      </div>
      <p className="catalog-section-text">Pick the sizes you actually stock. New sizes start at 0 on hand.</p>
      <div className="field catalog-field">
        <label htmlFor={`${ids}-scheme`}>Size chart</label>
        <select id={`${ids}-scheme`} value={schemeId} onChange={event => changeScheme(event.target.value)}>
          <option value="">No chart — type sizes below</option>
          {SIZE_SCHEMES.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {scheme && (
        <>
          <p className="add-sizes-source">
            <BookOpen />
            {scheme.description}
          </p>
          {scheme.sizes.length > 12 && (
            <div className="inline-search size-filter">
              <Search />
              <input
                aria-label="Filter chart sizes"
                placeholder={`Filter ${scheme.sizes.length} sizes…`}
                value={filter}
                onChange={event => setFilter(event.target.value)}
              />
            </div>
          )}
          <div className="size-toggle-tools">
            <button type="button" className="secondary-button" disabled={!selectable.length} onClick={selectShown}>
              Select all shown
            </button>
            <button type="button" className="secondary-button" disabled={!selected.length} onClick={() => setSelected([])}>
              Clear
            </button>
            <span>{selected.length} selected</span>
          </div>
          <div className="size-toggles" role="group" aria-label={`Sizes in ${scheme.label}`}>
            {shown.map(size => {
              const added = isAdded(size)
              return (
                <button
                  key={size}
                  type="button"
                  className="size-toggle"
                  aria-pressed={!added && selected.includes(size)}
                  aria-label={added ? `${size} (already added)` : size}
                  disabled={added}
                  onClick={() => toggle(size)}
                >
                  {added && <Check aria-hidden="true" />}
                  {size}
                </button>
              )
            })}
            {!shown.length && <p className="catalog-section-text">No chart sizes match “{filter}”.</p>}
          </div>
        </>
      )}
      <div className="field catalog-field">
        <label htmlFor={`${ids}-custom`}>Custom sizes</label>
        <textarea
          id={`${ids}-custom`}
          rows={2}
          value={customText}
          placeholder="Separate with commas or new lines, e.g. 34R, 36R, Youth M"
          aria-invalid={custom.invalid.length > 0}
          aria-describedby={`${ids}-custom-help`}
          onChange={event => setCustomText(event.target.value)}
        />
        <small id={`${ids}-custom-help`} className={custom.invalid.length ? 'catalog-field-error' : 'catalog-field-help'}>
          {custom.invalid.length
            ? `Size labels must be 1–24 characters: ${custom.invalid.join(', ')}`
            : alreadyTyped.length
              ? `Already added, will be skipped: ${alreadyTyped.join(', ')}`
              : 'Labels are matched without regard to case, so “m” and “M” are the same size.'}
        </small>
      </div>
      {error && (
        <p className="workflow-error" role="alert">
          <AlertTriangle />
          {error}
        </p>
      )}
      <button type="button" className="primary-button" disabled={busy || !pending.length || custom.invalid.length > 0} onClick={() => void submit()}>
        {busy ? 'Adding…' : pending.length ? `Add ${plural(pending.length, 'size')}` : 'Add sizes'}
      </button>
    </section>
  )
}
