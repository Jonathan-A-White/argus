import type { ArgusAppProjection } from '../distributed/appIntegration'
import type { BundleLineProjection, BundleProjection, BundleVersionProjection, CadetGender, CadetProjection, InventoryProjection } from '../distributed/types'
import { ONE_SIZE_LABEL } from './domain'

/**
 * What a cadet is expected to hold, derived from the unit's bundle definitions (spec §8, §9, §35).
 * Bundles are matched by their gender applicability and purpose, never by name, so a unit that
 * renames or re-scopes a bundle gets the same answers on every device.
 */
type Projection = Pick<ArgusAppProjection, 'bundles' | 'inventory' | 'catalog'>
type Cadet = Pick<CadetProjection, 'cadetId' | 'gender' | 'sizes' | 'currentProperty'>

/** Bundle purposes every active cadet is expected to hold: the uniform and PT gear. */
export const STANDARD_ISSUE_PURPOSES = ['NSU', 'PT'] as const

export const currentBundleVersion = (bundle: Pick<BundleProjection, 'versions' | 'currentVersion'>) => bundle.versions.find(version => version.version === bundle.currentVersion)
export const bundleAppliesTo = (version: Pick<BundleVersionProjection, 'genderApplicability'>, gender: CadetGender) => version.genderApplicability === 'Any' || version.genderApplicability === gender
const isStandardIssue = (version: Pick<BundleVersionProjection, 'purpose'>) => (STANDARD_ISSUE_PURPOSES as readonly string[]).includes(version.purpose.trim().toUpperCase())

/** Active current versions of the given bundle IDs (unknown or deactivated bundles are skipped). */
export function activeBundleVersions(projection: Pick<Projection, 'bundles'>, bundleIds?: string[]): BundleVersionProjection[] {
  const bundles = bundleIds ? bundleIds.flatMap(id => projection.bundles.filter(bundle => bundle.bundleId === id)) : projection.bundles
  return bundles.map(currentBundleVersion).filter((version): version is BundleVersionProjection => Boolean(version?.active))
}
/** The standard-issue bundles (NSU + PT purposes) that every active cadet should hold. */
export const standardIssueBundles = (projection: Pick<Projection, 'bundles'>) => activeBundleVersions(projection).filter(isStandardIssue)

/** One catalog item a cadet must hold, merged across bundles (a cap in two bundles is still one cap). */
export type RequiredItem = { key: string; catalogId?: string; itemId?: string; label: string; quantity: number; sized: boolean; bundleIds: string[] }
export type UnmetItem = RequiredItem & { size?: string }

/** Lines are matched by catalog item; a legacy line pinned to one SKU uses that SKU's catalog item. */
export function lineKey(line: Pick<BundleLineProjection, 'catalogId' | 'itemId' | 'lineId'>, inventory: Pick<InventoryProjection, 'entityId' | 'catalogId'>[]) {
  if (line.catalogId) return line.catalogId
  const pinned = line.itemId ? inventory.find(item => item.entityId === line.itemId) : undefined
  return pinned?.catalogId ?? (line.itemId ? `item:${line.itemId}` : `line:${line.lineId}`)
}
const propertyKey = (itemId: string, inventory: Pick<InventoryProjection, 'entityId' | 'catalogId'>[]) => inventory.find(item => item.entityId === itemId)?.catalogId ?? `item:${itemId}`

/** Quantity the cadet holds per catalog item. */
export function heldByCatalog(cadet: Pick<Cadet, 'currentProperty'>, inventory: Pick<InventoryProjection, 'entityId' | 'catalogId'>[]) {
  const held = new Map<string, number>()
  for (const line of cadet.currentProperty) { const key = propertyKey(line.itemId, inventory); held.set(key, (held.get(key) ?? 0) + line.quantity) }
  return held
}

/** The catalog item one bundle line stands for, named and sized from the catalog where it is known. */
export function requiredItemOf(line: BundleLineProjection, bundleId: string, projection: Projection): RequiredItem {
  const key = lineKey(line, projection.inventory), catalog = projection.catalog.find(item => item.catalogId === key)
  return { key, ...(catalog || line.catalogId ? { catalogId: catalog?.catalogId ?? line.catalogId } : {}), ...(line.itemId ? { itemId: line.itemId } : {}), label: catalog?.name ?? line.displayLabel, quantity: line.defaultQuantity, sized: catalog ? catalog.sized : line.supportsSizing, bundleIds: [bundleId] }
}

/** Required lines of the bundles that apply to this cadet's gender, merged by catalog item. */
export function requiredItemsFor(cadet: Pick<Cadet, 'gender'>, versions: BundleVersionProjection[], projection: Projection): RequiredItem[] {
  const merged = new Map<string, RequiredItem>()
  for (const version of versions.filter(candidate => bundleAppliesTo(candidate, cadet.gender))) {
    for (const line of [...version.lines].sort((a, b) => a.order - b.order).filter(candidate => candidate.required)) {
      const item = requiredItemOf(line, version.bundleId, projection), existing = merged.get(item.key)
      if (!existing) { merged.set(item.key, item); continue }
      existing.quantity = Math.max(existing.quantity, item.quantity)
      if (!existing.bundleIds.includes(version.bundleId)) existing.bundleIds.push(version.bundleId)
    }
  }
  return [...merged.values()]
}

/** The cadet's recorded size for an item (sizes are keyed by item name), or ONE_SIZE_LABEL for unsized gear. */
export function recordedSize(cadet: Pick<Cadet, 'sizes'>, item: Pick<RequiredItem, 'label' | 'sized' | 'itemId'>, inventory: Pick<InventoryProjection, 'entityId' | 'name' | 'variant'>[]) {
  if (!item.sized) return ONE_SIZE_LABEL
  const pinned = item.itemId ? inventory.find(candidate => candidate.entityId === item.itemId) : undefined
  const size = cadet.sizes[item.label] ?? (pinned ? cadet.sizes[pinned.name] : undefined)
  return size?.trim() ? size.trim() : undefined
}

/** Required items the cadet does not hold yet (a line is satisfied by holding any size of that catalog item). */
export function unmetItems(cadet: Cadet, versions: BundleVersionProjection[], projection: Projection) {
  const required = requiredItemsFor(cadet, versions, projection), held = heldByCatalog(cadet, projection.inventory)
  const unmet: UnmetItem[] = required.filter(item => !held.get(item.key)).map(item => { const size = recordedSize(cadet, item, projection.inventory); return { ...item, ...(size ? { size } : {}) } })
  return { required, unmet }
}

/** The active sizes of a required item: its catalog item's variants, or its pinned legacy SKU. */
export function variantsOf(inventory: InventoryProjection[], item: Pick<RequiredItem, 'key' | 'itemId'>) {
  const pinned = item.key.startsWith('item:')
  return inventory.filter(candidate => candidate.active && (pinned ? candidate.entityId === item.itemId : candidate.catalogId === item.key))
}
/** Active variant of a required item in the given size (case-insensitive), if the unit stocks it. */
export function variantFor(inventory: InventoryProjection[], item: Pick<RequiredItem, 'key' | 'itemId'>, size: string) {
  const variants = variantsOf(inventory, item)
  return item.key.startsWith('item:') ? variants[0] : variants.find(candidate => candidate.variant.toLowerCase() === size.toLowerCase())
}
