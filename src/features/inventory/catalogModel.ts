import type { CatalogItemProjection, InventoryProjection } from '../../distributed/types'
import { MAX_COUNT_QUANTITY, MAX_RECEIVE_QUANTITY } from '../../distributed/replica'
import { normalizeSizeLabel } from '../../stage3/sizes'
import type { InventoryStatus } from '../../stage3/inventoryStatus'

export { MAX_COUNT_QUANTITY, MAX_RECEIVE_QUANTITY }
export const MAX_COUNT_INCREMENT = 1000
export const MAX_SIZES_PER_ADD = 200

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral'
export type CatalogStatus = { label: string; tone: StatusTone }

export const variantsOf = (inventory: InventoryProjection[], catalogId: string) => inventory.filter(item => item.catalogId === catalogId)

export const sumOf = (variants: InventoryProjection[], field: 'onHand' | 'issued') =>
  variants.filter(item => item.active).reduce((sum, item) => sum + item[field], 0)

/** At or below its low-stock threshold, or none left while cadets still hold some. */
export const needsAttention = (item: InventoryProjection) =>
  item.active && ((item.reorderAt !== undefined && item.onHand <= item.reorderAt) || (item.onHand === 0 && item.issued > 0))

export function catalogStatus(item: CatalogItemProjection, variants: InventoryProjection[]): CatalogStatus {
  if (!item.active) return { label: 'Inactive', tone: 'neutral' }
  if (item.sized && !variants.length) return { label: 'Sizes not set', tone: 'warning' }
  const active = variants.filter(variant => variant.active)
  if (!active.length) return { label: 'No active sizes', tone: 'neutral' }
  if (active.some(variant => needsAttention(variant) && variant.onHand === 0)) return { label: 'Out of stock', tone: 'danger' }
  if (active.some(needsAttention)) return { label: 'Low stock', tone: 'warning' }
  // Zero with nothing issued and no threshold is simply "not stocked yet", not an alarm.
  if (sumOf(active, 'onHand') === 0) return { label: 'Nothing on hand', tone: 'neutral' }
  return { label: 'Healthy', tone: 'success' }
}

export const toneClass = (tone: StatusTone) => (tone === 'neutral' ? '' : tone)

// Count Due and Reconciliation Required (spec §7) are derived per size in src/stage3/inventoryStatus.ts.
export {
  COUNT_INTERVAL_CHOICES,
  DEFAULT_COUNT_INTERVAL_DAYS,
  describeReconciliation,
  inventoryStatus,
  inventoryStatuses,
  type InventoryStatus,
  type ReconciliationReason,
} from '../../stage3/inventoryStatus'

/** How many active sizes of an item are Count Due / need reconciliation. */
export type CatalogFlags = { countDue: number; reconcile: number }
export function catalogFlags(variants: InventoryProjection[], statuses: ReadonlyMap<string, InventoryStatus>): CatalogFlags {
  const active = variants.filter(variant => variant.active).map(variant => statuses.get(variant.entityId))
  return { countDue: active.filter(status => status?.countDue).length, reconcile: active.filter(status => status?.reconciliationRequired).length }
}

/** "Mar 3, 2026", or "Never" for a size that has not been counted. */
export const countedOn = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never')

export const categoriesOf = (catalog: CatalogItemProjection[]) => [...new Set(catalog.map(item => item.category).filter(Boolean))]

/** Splits free text on commas/new lines into normalized size labels, reporting the ones that are invalid. */
export function parseSizeLabels(text: string) {
  const labels: string[] = []
  const invalid: string[] = []
  for (const raw of text.split(/[,\n]/)) {
    if (!raw.trim()) continue
    try {
      labels.push(normalizeSizeLabel(raw))
    } catch {
      invalid.push(raw.trim())
    }
  }
  return { labels, invalid }
}

/** Keeps the first spelling of each label (case-insensitive) and drops labels the item already has. */
export function newSizeLabels(candidates: string[], existing: string[]) {
  const seen = new Set(existing.map(label => label.toLowerCase()))
  const result: string[] = []
  for (const label of candidates) {
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(label)
  }
  return result
}

/** Parses a whole number typed by a person; undefined when blank, fractional or out of range. */
export function parseWhole(text: string, min: number, max: number) {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value >= min && value <= max ? value : undefined
}

export const errorMessage = (reason: unknown, fallback = 'That change could not be saved. Please try again.') =>
  reason instanceof Error && reason.message ? reason.message : fallback

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
