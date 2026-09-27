import { useState } from 'react'
import { AlertTriangle, Boxes, Search, X } from 'lucide-react'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { CountSessionProjection } from '../../distributed/types'
import { matchesSearch } from '../../domain'

type Props = {
  projection: ArgusAppProjection
  session: CountSessionProjection
  catalogId?: string
  itemId?: string
  canCreateSizes: boolean
  onSelectCatalog: (catalogId: string | undefined) => void
  onSelectVariant: (itemId: string) => void
  notify: (message: string) => void
}

/** Step 1 of counting: find the catalog item, then tap the size on the shelf in front of you. */
export function CountPicker({ projection, session, catalogId, itemId, canCreateSizes, onSelectCatalog, onSelectVariant, notify }: Props) {
  const [query, setQuery] = useState('')
  const activeVariants = (id: string) => projection.inventory.filter(item => item.catalogId === id && item.active)
  const countedFor = (id: string) => activeVariants(id).reduce((sum, item) => sum + (session.totals[item.entityId] ?? 0), 0)
  const selected = projection.catalog.find(item => item.catalogId === catalogId && item.active)

  if (selected) {
    const variants = activeVariants(selected.catalogId)
    return (
      <section className="table-card count-picker" aria-labelledby="count-picker-heading">
        <div className="count-picker-head">
          <div className="item-icon">
            <Boxes />
          </div>
          <div>
            <small className="operational-label">{selected.category}</small>
            <h3 id="count-picker-heading">{selected.name}</h3>
            <p>{selected.niin ? `NIIN ${selected.niin}` : 'No NIIN'} · {variants.length ? 'Tap the size you are counting' : 'No sizes yet'}</p>
          </div>
          <button type="button" className="secondary-button count-change" onClick={() => onSelectCatalog(undefined)}>
            Change item
          </button>
        </div>
        {variants.length > 0 ? (
          <div className="count-size-chips" role="group" aria-label={`Sizes of ${selected.name}`}>
            {variants.map(variant => (
              <button
                key={variant.entityId}
                type="button"
                className="count-size-chip"
                aria-pressed={variant.entityId === itemId}
                aria-label={`${variant.variant}: ${session.totals[variant.entityId] ?? 0} counted so far`}
                onClick={() => onSelectVariant(variant.entityId)}
              >
                <b>{variant.variant}</b>
                <small>{session.totals[variant.entityId] ?? 0} counted</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="workflow-warning count-no-sizes">
            <AlertTriangle />
            <div>
              <strong>{selected.name} has no sizes yet.</strong>
              <p>Sizes are configured in Inventory. Once the sizes you stock are added, they appear here for counting.</p>
              {canCreateSizes && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => notify(`Open Inventory, choose ${selected.name}, then use “Add sizes” to pick sizes from the supply-manual size charts or type your own.`)}
                >
                  How do I add sizes?
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    )
  }

  const matches = projection.catalog.filter(
    item =>
      item.active &&
      matchesSearch(query, [item.name, item.category, item.niin, ...activeVariants(item.catalogId).map(variant => variant.variant)].join(' ')),
  )
  return (
    <section className="table-card count-picker" aria-labelledby="count-picker-heading">
      <div className="count-picker-intro">
        <small className="operational-label">Step 1</small>
        <h3 id="count-picker-heading">What are you counting?</h3>
      </div>
      <div className="inline-search count-search">
        <Search />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search name, category, NIIN or size…"
          aria-label="Search items to count"
        />
        {query && (
          <button type="button" className="count-clear" aria-label="Clear search" onClick={() => setQuery('')}>
            <X />
          </button>
        )}
      </div>
      {matches.length > 0 ? (
        <ul className="count-picker-results" aria-label="Items to count">
          {matches.map(item => {
            const sizes = activeVariants(item.catalogId).length
            const counted = countedFor(item.catalogId)
            return (
              <li key={item.catalogId}>
                <button type="button" onClick={() => onSelectCatalog(item.catalogId)}>
                  <span className="category-mark" aria-hidden="true">
                    {item.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="item-name">
                    <strong>{item.name}</strong>
                    <small>
                      {item.category} · {!item.sized ? 'One size' : sizes ? `${sizes} size${sizes === 1 ? '' : 's'}` : 'Sizes not set'}
                    </small>
                  </span>
                  <span className="count-picker-counted">
                    <b>{counted}</b>
                    <small>counted</small>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="empty-state">
          <strong>No items match that search</strong>
          <span>Try a name, category, NIIN or size — or clear the search.</span>
        </p>
      )}
    </section>
  )
}
