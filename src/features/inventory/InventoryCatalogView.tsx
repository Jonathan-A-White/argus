import { useState, type JSX } from 'react'
import { ArrowRight, PackagePlus, Search, X } from 'lucide-react'
import { Summary } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, CatalogItemProjection, InventoryProjection } from '../../distributed/types'
import { matchesSearch } from '../../domain'
import { AddCatalogItemDrawer } from './AddCatalogItemDrawer'
import { ItemEditorDrawer } from './ItemEditorDrawer'
import { catalogStatus, categoriesOf, needsAttention, plural, sumOf, toneClass, variantsOf, type CatalogStatus } from './catalogModel'
import './inventory.css'

export type InventoryCatalogViewProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  /** Jump to the Count tab with this size selected. */
  onCount: (itemId: string) => void
}

type CatalogRowData = { item: CatalogItemProjection; variants: InventoryProjection[]; status: CatalogStatus }

/** The unit's catalog: every kind of gear, its sizes and stock, with editing for officers. */
export function InventoryCatalogView({ projection, controller, can, onProjection, notify, onCount }: InventoryCatalogViewProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>()
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [adding, setAdding] = useState(false)

  const activeVariants = projection.inventory.filter(variant => variant.active)
  const onHand = sumOf(activeVariants, 'onHand')
  const issued = sumOf(activeVariants, 'issued')
  const attention = activeVariants.filter(needsAttention).length
  const rows: CatalogRowData[] = projection.catalog.map(item => {
    const variants = variantsOf(projection.inventory, item.catalogId)
    return { item, variants, status: catalogStatus(item, variants) }
  })
  const withoutSizes = rows.filter(row => row.item.active && row.status.label === 'Sizes not set').length
  const categories = categoriesOf(projection.catalog)
  const visible = rows.filter(
    ({ item, variants, status }) =>
      (!category || item.category === category) &&
      (!attentionOnly || status.tone === 'warning' || status.tone === 'danger') &&
      matchesSearch(query, [item.name, item.category, item.niin, ...variants.map(variant => variant.variant)].join(' ')),
  )
  const activeRows = visible.filter(row => row.item.active)
  const inactiveRows = visible.filter(row => !row.item.active)
  const filtering = Boolean(query || category || attentionOnly)
  const clearFilters = () => {
    setQuery('')
    setCategory(undefined)
    setAttentionOnly(false)
  }

  return (
    <div className="content inventory-catalog">
      <section className="page-intro catalog-intro">
        <div>
          <p className="eyebrow">SERVICEABLE INVENTORY</p>
          <h2>Every asset, accounted for.</h2>
          <p>Search by item, size, category, or NIIN. Open an item to set its sizes, receive stock or start a count.</p>
        </div>
        {can('inventory.create') && (
          <button type="button" className="gold-button" onClick={() => setAdding(true)}>
            <PackagePlus />
            Add item
          </button>
        )}
      </section>
      <div className="summary-grid catalog-summary">
        <Summary
          label="On hand"
          value={String(onHand)}
          detail={onHand ? `Across ${plural(activeVariants.length, 'active size')}` : 'Nothing on hand yet — record a count or receive stock'}
        />
        <Summary label="Issued" value={String(issued)} detail="Currently with cadets" />
        <Summary label="Low / out of stock" value={String(attention)} detail="Sizes at their threshold, or out while issued" accent={attention > 0} />
        <Summary label="Items without sizes" value={String(withoutSizes)} detail="Add sizes so they can be counted" accent={withoutSizes > 0} />
      </div>
      <div className="table-card">
        <div className="table-tools catalog-tools">
          <div className="inline-search">
            <Search />
            <input aria-label="Search catalog" value={query} placeholder="Search name, size, category or NIIN…" onChange={event => setQuery(event.target.value)} />
            {query && (
              <button type="button" className="catalog-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                <X />
              </button>
            )}
          </div>
          <div className="catalog-filters">
            <div role="group" aria-label="Filter by category">
              <button type="button" className="catalog-chip" aria-pressed={!category} onClick={() => setCategory(undefined)}>
                All
              </button>
              {categories.map(option => (
                <button
                  key={option}
                  type="button"
                  className="catalog-chip"
                  aria-pressed={category === option}
                  onClick={() => setCategory(category === option ? undefined : option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <button type="button" className="catalog-chip attention" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(value => !value)}>
              Needs attention
            </button>
          </div>
        </div>
        {activeRows.length ? (
          <ul className="catalog-list" aria-label="Catalog items">
            {activeRows.map(row => (
              <CatalogRow key={row.item.catalogId} row={row} open={() => setEditingId(row.item.catalogId)} />
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <strong>{filtering ? 'No items match' : 'No active items'}</strong>
            <span>{filtering ? 'Try another name, size or NIIN, or clear the filters.' : 'Add an item to start tracking it.'}</span>
            {filtering && (
              <button type="button" className="secondary-button catalog-clear-filters" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        )}
        {inactiveRows.length > 0 && (
          <details className="catalog-inactive">
            <summary>Inactive items ({inactiveRows.length})</summary>
            <ul className="catalog-list" aria-label="Inactive catalog items">
              {inactiveRows.map(row => (
                <CatalogRow key={row.item.catalogId} row={row} open={() => setEditingId(row.item.catalogId)} />
              ))}
            </ul>
          </details>
        )}
      </div>
      {editingId && (
        <ItemEditorDrawer
          catalogId={editingId}
          projection={projection}
          controller={controller}
          can={can}
          onProjection={onProjection}
          notify={notify}
          onCount={itemId => {
            setEditingId(undefined)
            onCount(itemId)
          }}
          close={() => setEditingId(undefined)}
        />
      )}
      {adding && (
        <AddCatalogItemDrawer
          projection={projection}
          controller={controller}
          onProjection={onProjection}
          notify={notify}
          close={() => setAdding(false)}
          onCreated={catalogId => {
            setAdding(false)
            setEditingId(catalogId)
          }}
        />
      )}
    </div>
  )
}

function CatalogRow({ row, open }: { row: CatalogRowData; open: () => void }) {
  const { item, variants, status } = row
  const active = variants.filter(variant => variant.active)
  const onHand = sumOf(active, 'onHand')
  const sizes = !item.sized ? 'One size' : variants.length ? String(active.length) : '—'
  const sizeSummary = !item.sized ? 'one size' : variants.length ? plural(active.length, 'size') : 'no sizes'
  return (
    <li>
      <button
        type="button"
        className="inventory-row catalog-row"
        aria-label={`${item.name}: ${onHand} on hand, ${sizeSummary}, ${status.label}`}
        onClick={open}
      >
        <span className="category-mark" aria-hidden="true">
          {item.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="item-name">
          <strong>{item.name}</strong>
          <small>
            {item.category} · {item.niin || 'No NIIN'}
          </small>
        </span>
        <span>
          <small>SIZES</small>
          <b>{sizes}</b>
        </span>
        <span>
          <small>ON HAND</small>
          <b>{onHand}</b>
        </span>
        <span>
          <small>ISSUED</small>
          <b>{sumOf(active, 'issued')}</b>
        </span>
        <em className={`status-badge ${toneClass(status.tone)}`}>{status.label}</em>
        <ArrowRight aria-hidden="true" />
      </button>
    </li>
  )
}
