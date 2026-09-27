import type { DistributedAppController } from '../../distributed/appIntegration'
import { canonicalize } from '../../distributed/canonical'
import type { BundleLineProjection, BundleProjection, BundleVersionProjection, CadetGender, CatalogItemProjection, InventoryProjection } from '../../distributed/types'

/** Exactly what updateBundleDefinition / createBundle accept. */
export type BundleDefinition = Parameters<DistributedAppController['updateBundleDefinition']>[1]
export type Applicability = CadetGender | 'Any'
export type BundleDraft = { displayName: string; genderApplicability: Applicability; purpose: string; active: boolean; lines: BundleLineProjection[] }

export const APPLICABILITY: Array<{ value: Applicability; label: string }> = [
  { value: 'Any', label: 'Any cadet' },
  { value: 'Male', label: 'Male cadets' },
  { value: 'Female', label: 'Female cadets' },
]
export const MAX_DEFAULT_QUANTITY = 10
export const MAX_NAME_LENGTH = 60
export const MAX_PURPOSE_LENGTH = 40

export const currentVersionOf = (bundle: Pick<BundleProjection, 'versions' | 'currentVersion'>) =>
  bundle.versions.find(version => version.version === bundle.currentVersion) ?? bundle.versions[bundle.versions.length - 1]

export const isDefaultPreset = (version: Pick<BundleVersionProjection, 'actorPublicIdentity'>) => version.actorPublicIdentity.startsWith('factory:')

/** A line is ready to issue when its catalog item has at least one active size (or its pinned legacy SKU is active). */
export function lineReady(line: Pick<BundleLineProjection, 'catalogId' | 'itemId'>, inventory: Pick<InventoryProjection, 'entityId' | 'catalogId' | 'active'>[]) {
  if (line.catalogId && inventory.some(item => item.catalogId === line.catalogId && item.active)) return true
  return Boolean(line.itemId && inventory.some(item => item.entityId === line.itemId && item.active))
}

export const activeSizeCount = (line: Pick<BundleLineProjection, 'catalogId' | 'itemId'>, inventory: InventoryProjection[]) =>
  inventory.filter(item => item.active && ((line.catalogId && item.catalogId === line.catalogId) || item.entityId === line.itemId)).length

/** Copies a line without undefined keys, so an untouched line compares equal to the stored one. */
function cleanLine(line: BundleLineProjection): BundleLineProjection {
  return Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined)) as BundleLineProjection
}

/** Editable copy of a version. Sizing is derived from the catalog item wherever it is known. */
export function draftFrom(version: BundleVersionProjection, catalog: CatalogItemProjection[]): BundleDraft {
  return {
    displayName: version.displayName,
    genderApplicability: version.genderApplicability,
    purpose: version.purpose,
    active: version.active,
    lines: [...version.lines]
      .sort((a, b) => a.order - b.order)
      .map(line => {
        const item = catalog.find(candidate => candidate.catalogId === line.catalogId)
        return cleanLine({ ...line, supportsSizing: item ? item.sized : line.supportsSizing })
      }),
  }
}

export const emptyDraft = (): BundleDraft => ({ displayName: '', genderApplicability: 'Any', purpose: '', active: true, lines: [] })

/** The definition to save: trimmed text, and each line's order equal to its position. */
export function definitionOf(draft: BundleDraft): BundleDefinition {
  return {
    displayName: draft.displayName.trim(),
    genderApplicability: draft.genderApplicability,
    purpose: draft.purpose.trim(),
    active: draft.active,
    lines: draft.lines.map((line, index) => cleanLine({ ...line, order: index })),
  }
}

export const sameDefinition = (a: BundleDefinition, b: BundleDefinition) => canonicalize(a) === canonicalize(b)

/** Mirrors validateBundle (src/stage3/domain.ts) plus the editor's own limits, with friendlier wording. */
export function definitionError(definition: BundleDefinition) {
  if (!definition.displayName) return 'Bundle name is required.'
  if (definition.displayName.length > MAX_NAME_LENGTH) return `Bundle name must be ${MAX_NAME_LENGTH} characters or fewer.`
  if (definition.purpose.length > MAX_PURPOSE_LENGTH) return `Purpose must be ${MAX_PURPOSE_LENGTH} characters or fewer.`
  if (!definition.lines.length) return 'A bundle must contain at least one line.'
  const catalogIds = definition.lines.flatMap(line => (line.catalogId ? [line.catalogId] : []))
  const repeated = definition.lines.find((line, index) => line.catalogId && catalogIds.indexOf(line.catalogId) !== index)
  if (repeated) return `${repeated.displayLabel} is listed twice. Use one line and raise its default quantity.`
  const badQuantity = definition.lines.find(line => !Number.isInteger(line.defaultQuantity) || line.defaultQuantity < 1 || line.defaultQuantity > MAX_DEFAULT_QUANTITY)
  if (badQuantity) return `${badQuantity.displayLabel}: default quantity must be 1 to ${MAX_DEFAULT_QUANTITY}.`
  return ''
}

export function slugify(name: string) {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return slug || 'custom'
}

/** `bundle-<slug>-<6 random hex>`; the random part keeps two devices' "Color Guard" bundles distinct. */
export const newBundleId = (name: string, random: string = crypto.randomUUID()) => `bundle-${slugify(name)}-${random.replace(/[^0-9a-z]/gi, '').slice(0, 6).toLowerCase()}`

export const newLineId = (bundleId: string, random: string = crypto.randomUUID()) => `${bundleId}:${random}`

/** A new line for a catalog item: sized per the catalog, required, quantity 1. itemId stays unset (size is chosen per cadet). */
export function lineFor(item: CatalogItemProjection, lineId: string): BundleLineProjection {
  return { lineId, catalogId: item.catalogId, displayLabel: item.name, required: true, supportsSizing: item.sized, defaultQuantity: 1, order: 0 }
}

/** Short, human description of what changed between two versions (for the version history). */
export function versionChanges(previous: BundleVersionProjection | undefined, next: BundleVersionProjection) {
  if (!previous) return []
  const changes: string[] = []
  if (previous.displayName !== next.displayName) changes.push(`Renamed from ${previous.displayName}`)
  if (previous.genderApplicability !== next.genderApplicability) changes.push(`Now for ${next.genderApplicability === 'Any' ? 'any cadet' : `${next.genderApplicability.toLowerCase()} cadets`}`)
  if (previous.purpose !== next.purpose) changes.push(`Purpose ${next.purpose || 'cleared'}`)
  if (previous.active !== next.active) changes.push(next.active ? 'Reactivated' : 'Deactivated')
  const key = (line: BundleLineProjection) => line.catalogId ?? line.itemId ?? line.lineId
  const before = new Map(previous.lines.map(line => [key(line), line]))
  const after = new Map(next.lines.map(line => [key(line), line]))
  for (const [id, line] of after) {
    const old = before.get(id)
    if (!old) changes.push(`Added ${line.displayLabel}`)
    else {
      if (old.required !== line.required) changes.push(`${line.displayLabel} ${line.required ? 'required' : 'optional'}`)
      if (old.defaultQuantity !== line.defaultQuantity) changes.push(`${line.displayLabel} ×${line.defaultQuantity}`)
    }
  }
  for (const [id, line] of before) if (!after.has(id)) changes.push(`Removed ${line.displayLabel}`)
  const order = (lines: BundleLineProjection[]) => [...lines].sort((a, b) => a.order - b.order).map(key).filter(id => before.has(id) && after.has(id)).join('|')
  if (order(previous.lines) !== order(next.lines)) changes.push('Reordered')
  return changes
}
