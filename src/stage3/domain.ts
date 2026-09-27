import { matchesSearch } from '../domain'
import type { BundleLineProjection, BundleVersionProjection, CadetGender, CadetProjection, CatalogItemProjection, InventoryProjection, NsLevel, StillNeededProjection } from '../distributed/types'

const levels: NsLevel[] = ['NS1', 'NS2', 'NS3', 'NS4']
const genders: CadetGender[] = ['Male', 'Female']
export function validateCadet(value: Pick<CadetProjection, 'fullName' | 'gender' | 'nsLevel' | 'status' | 'sizes'> & { cadetCode?: string }) {
  if (typeof value.fullName !== 'string' || value.fullName.length > 120) throw new Error('Cadet name is invalid.')
  if (!value.fullName.trim() && !value.cadetCode?.trim()) throw new Error('A cadet needs a cadet ID or a name.')
  if (value.cadetCode !== undefined && !CADET_CODE_PATTERN.test(value.cadetCode)) throw new Error('Cadet IDs look like C-4F7K.')
  if (!genders.includes(value.gender)) throw new Error('Gender must be Male or Female.')
  if (!levels.includes(value.nsLevel)) throw new Error('NS level must be NS1, NS2, NS3, or NS4.')
  if (!['ACTIVE', 'INACTIVE'].includes(value.status)) throw new Error('Cadet status is invalid.')
  if (!value.sizes || typeof value.sizes !== 'object') throw new Error('Cadet size profile is invalid.')
}
export function searchCadets(cadets: CadetProjection[], query: string, status: 'ALL' | CadetProjection['status'] = 'ACTIVE') {
  return cadets.filter(c => (status === 'ALL' || c.status === status) && matchesSearch(query, c.cadetCode ?? '', c.fullName, c.fullName.split(/\s+/).reverse().join(' '), c.nsLevel, c.status))
}

/** Short, opaque, human-usable cadet ID. Random, never derived from a name or school ID, so it reveals nothing on its own. */
export const CADET_CODE_PATTERN = /^C-[0-9A-HJKMNP-TV-Z]{4,6}$/
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function generateCadetCode(taken: Iterable<string> = [], length = 4) {
  const used = new Set(taken)
  for (let attempt = 0; attempt < 64; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(length))
    const code = `C-${Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')}`
    if (!used.has(code)) return code
  }
  return generateCadetCode(used, length + 1)
}
/** What every screen shows for a cadet unless the operator explicitly reveals the encrypted name. */
export const cadetLabel = (cadet: Pick<CadetProjection, 'cadetCode' | 'cadetId'>) => cadet.cadetCode ?? `C-${cadet.cadetId.replace(/[^0-9a-z]/gi, '').slice(-4).toUpperCase()}`
export function validateBundle(value: Pick<BundleVersionProjection, 'displayName' | 'genderApplicability' | 'lines' | 'version'>, inventory?: InventoryProjection[]) {
  if (!value.displayName.trim()) throw new Error('Bundle name is required.')
  if (![...genders, 'Any'].includes(value.genderApplicability)) throw new Error('Bundle gender applicability is invalid.')
  if (!Number.isInteger(value.version) || value.version < 1) throw new Error('Bundle version is invalid.')
  if (!value.lines.length) throw new Error('A bundle must contain at least one line.')
  if (new Set(value.lines.map(l => l.lineId)).size !== value.lines.length) throw new Error('Bundle line IDs must be unique.')
  const itemIds = value.lines.flatMap(l => l.itemId ? [l.itemId] : [])
  if (new Set(itemIds).size !== itemIds.length) throw new Error('Duplicate inventory lines are not allowed.')
  for (const line of value.lines) {
    if (!line.lineId || !line.displayLabel.trim() || !Number.isInteger(line.defaultQuantity) || line.defaultQuantity <= 0) throw new Error('Every bundle line requires a label and positive whole quantity.')
    if (line.itemId && inventory && !inventory.some(i => i.entityId === line.itemId)) throw new Error(`Inventory reference ${line.itemId} is invalid.`)
  }
}
export function validateRequirement(value: Pick<StillNeededProjection, 'cadetId' | 'displayLabel' | 'quantityNeeded' | 'quantityFulfilled' | 'status' | 'source'>) {
  if (!value.cadetId || !value.displayLabel.trim()) throw new Error('Still Needed requires a cadet and item label.')
  if (!Number.isInteger(value.quantityNeeded) || value.quantityNeeded <= 0 || !Number.isInteger(value.quantityFulfilled) || value.quantityFulfilled < 0 || value.quantityFulfilled > value.quantityNeeded) throw new Error('Still Needed quantities are invalid.')
  if (!['OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'].includes(value.status) || !['MANUAL', 'INCOMPLETE_ISSUE', 'CORRECTION'].includes(value.source)) throw new Error('Still Needed lifecycle value is invalid.')
}
export function requirementAvailability(requirement: StillNeededProjection, inventory: Array<Pick<InventoryProjection, 'entityId'|'onHand'> & Partial<InventoryProjection>>) { const item = requirement.itemId ? inventory.find(i => i.entityId === requirement.itemId) : undefined; const remaining = requirement.quantityNeeded - requirement.quantityFulfilled; return { onHand: item?.onHand ?? 0, configured: Boolean(item), available: Boolean(item && item.onHand >= remaining) } }
export function cadetReadiness(requirements: StillNeededProjection[]) { const required = requirements.filter(r => r.status !== 'CANCELLED'); const fulfilled = required.filter(r => r.status === 'FULFILLED').length; return { status: required.some(r => r.status === 'OPEN' || r.status === 'PARTIALLY_FULFILLED') ? 'INCOMPLETE' as const : 'READY' as const, fulfilled, total: required.length, percent: required.length ? Math.round(fulfilled / required.length * 100) : 100 } }
export const bundleSuggestions = (gender: CadetGender) => gender === 'Male' ? ['Male NSU', 'Male SDB', 'PT', 'Drill', 'BLT'] : ['Female NSU', 'Female SDB', 'PT', 'Drill', 'BLT']

export const ONE_SIZE_LABEL = 'One size'
const UNSIZED = ['Buckle', 'Black Belt', 'Khaki Belt', 'Brass Buckle', 'Necktie', 'Neck Tabs']
const catalogIdFor = (label: string) => `catalog:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
/**
 * The unit's starting catalog: every item the master specification's default bundles name, at
 * zero on hand, with NO sizes yet. Supply staff add the sizes they actually stock (see
 * SIZE_SCHEMES) and quantities come only from real counts and receipts. Every device starts
 * from this same constant, so catalog IDs agree everywhere without publishing anything.
 */
const genesis = (name: string, category: string, sizeScheme?: string): CatalogItemProjection => ({ catalogId: catalogIdFor(name), name, category, niin: '', sized: !UNSIZED.includes(name), ...(sizeScheme && !UNSIZED.includes(name) ? { sizeScheme } : {}), countIncrement: 1, active: true, origin: 'GENESIS', version: 1, appliedEventIds: [] })
export const GENESIS_CATALOG: CatalogItemProjection[] = [
  genesis('Male Khaki Shirt', 'NSU', 'shirt-neck'), genesis('Black Trousers', 'NSU', 'trouser'), genesis('Khaki Overblouse', 'NSU', 'female-coat'), genesis('Black Slacks', 'NSU', 'trouser'),
  genesis('Garrison Cap', 'Covers', 'cap'), genesis('Khaki Ball Cap', 'Covers', 'unisex-alpha'),
  genesis('White Dress Shirt', 'SDB', 'shirt-neck'), genesis('Male SDB Jacket', 'SDB', 'male-coat'), genesis('Female SDB Jacket', 'SDB', 'female-coat'),
  genesis('Black Belt', 'Accessories'), genesis('Buckle', 'Accessories'), genesis('Necktie', 'Accessories'), genesis('Neck Tabs', 'Accessories'),
  genesis('Black Socks', 'Footwear', 'unisex-alpha'), genesis('Black Oxfords', 'Footwear', 'shoe-men'), genesis('Pumps', 'Footwear', 'shoe-women'),
  genesis('Gold PT Shirt', 'PT', 'unisex-alpha'), genesis('PT Shorts', 'PT', 'unisex-alpha'),
  genesis('Tracksuit Top', 'Drill', 'unisex-alpha'), genesis('Tracksuit Bottom', 'Drill', 'unisex-alpha'),
  genesis('Khaki Shirt', 'BLT', 'unisex-alpha'), genesis('Khaki Trousers', 'BLT', 'trouser'), genesis('Khaki Belt', 'BLT'), genesis('Brass Buckle', 'BLT'), genesis('Platoon Shirt', 'BLT', 'unisex-alpha'),
]
/** Unsized genesis items start with their single variant so they can be counted immediately. */
export const oneSizeVariantId = (catalogId: string) => `${catalogId}:one-size`
export const GENESIS_INVENTORY: InventoryProjection[] = GENESIS_CATALOG.filter(item => !item.sized).map(item => ({ entityId: oneSizeVariantId(item.catalogId), catalogId: item.catalogId, name: item.name, category: item.category, variant: ONE_SIZE_LABEL, niin: '', onHand: 0, issued: 0, countIncrement: 1, active: true, version: 0, appliedEventIds: [] }))
const line = (bundle: string, label: string, order: number, required = true): BundleLineProjection => ({ lineId: `${bundle}:${order}`, catalogId: catalogIdFor(label), displayLabel: label, required, supportsSizing: !UNSIZED.includes(label), defaultQuantity: 1, order })
const preset = (bundleId: string, displayName: string, genderApplicability: CadetGender | 'Any', purpose: string, names: Array<string | [string, boolean]>): BundleVersionProjection => ({ bundleId, displayName, genderApplicability, purpose, lines: names.map((entry, i) => line(bundleId, typeof entry === 'string' ? entry : entry[0], i, typeof entry === 'string' ? true : entry[1])), active: true, version: 1, createdAt: '2026-09-11T00:00:00.000Z', actorPublicIdentity: 'factory:argus-stage3a', eventId: `factory:${bundleId}:v1` })
export const FACTORY_BUNDLES = [
  preset('bundle-male-nsu', 'Male NSU', 'Male', 'NSU', ['Male Khaki Shirt','Black Trousers','Garrison Cap','Black Belt','Buckle','White Dress Shirt','Black Socks','Black Oxfords']),
  preset('bundle-female-nsu', 'Female NSU', 'Female', 'NSU', ['Khaki Overblouse','Black Slacks','Garrison Cap','Black Oxfords','Pumps']),
  preset('bundle-male-sdb', 'Male SDB', 'Male', 'SDB', ['Male SDB Jacket','Necktie',['White Dress Shirt', false]]),
  preset('bundle-female-sdb', 'Female SDB', 'Female', 'SDB', ['Female SDB Jacket','Neck Tabs','White Dress Shirt']),
  preset('bundle-pt', 'PT', 'Any', 'PT', ['Gold PT Shirt','PT Shorts','Khaki Ball Cap']),
  preset('bundle-drill', 'Drill', 'Any', 'DRILL', ['Tracksuit Top','Tracksuit Bottom']),
  preset('bundle-blt', 'BLT', 'Any', 'BLT', ['Khaki Shirt','Khaki Trousers','Khaki Belt','Brass Buckle','Platoon Shirt']),
]
