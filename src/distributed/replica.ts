import { ROLE_PERMISSIONS, type AuthorizationService } from '../auth/authorization'
import { canonicalize, sha256 } from './canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { ArgusPermission, AuthorityCredential, AuthorityRevocation, CalendarEventProjection, CalendarFieldRevisions, CalendarScalarField, CalendarTaskProjection, CatalogItemProjection, NsLevel, SupplyEventKind, ConflictRecord, CountAssignment, CountObservation, CountSessionProjection, DistributedEventType, InventoryProjection, MissingIssueLine, SignedArgusEvent, SupplyTransactionLine, UnsignedArgusEvent } from './types'
import type { ArgusRepository, RepositoryState } from '../storage/repository'
import type { EventSyncProvider } from '../sync/mock'
import type { BundleVersionProjection, CadetProjection, StillNeededProjection } from './types'
import { FACTORY_BUNDLES, GENESIS_CATALOG, GENESIS_INVENTORY, ONE_SIZE_LABEL, generateCadetCode, oneSizeVariantId, validateBundle, validateCadet, validateRequirement } from '../stage3/domain'
import { normalizeSizeLabel } from '../stage3/sizes'
import { SUPPLY_EVENT_KINDS, templateFor } from '../stage3/calendar'
import { parseKeyGrantRecord } from '../private-sync/schema'
import type { KeyGrantRecord } from '../private-sync/types'

const PERMISSION_FOR: Partial<Record<DistributedEventType, ArgusPermission>> = {
  INVENTORY_ITEM_CREATED: 'inventory.create', INVENTORY_ITEM_UPDATED: 'inventory.adjust', INVENTORY_RECEIVED: 'inventory.adjust',
  CATALOG_ITEM_CREATED: 'inventory.create', CATALOG_ITEM_UPDATED: 'inventory.adjust', CATALOG_SIZES_ADDED: 'inventory.create',
  ITEM_ISSUED: 'inventory.issue', ITEM_RETURNED: 'inventory.return', INVENTORY_COUNT_SUBMITTED: 'inventory.count',
  COUNT_SESSION_CREATED: 'inventory.count', COUNT_CONTRIBUTED: 'inventory.count', COUNT_CORRECTED: 'inventory.count', COUNT_RECOUNTED: 'inventory.count', COUNT_SESSION_SUBMITTED: 'inventory.count',
  COUNT_SESSION_RECONCILED: 'inventory.adjust', COUNT_SESSION_CANCELLED: 'inventory.adjust', RECORD_CORRECTED: 'inventory.adjust', CONFLICT_RESOLVED: 'conflicts.resolve',
  CADET_CREATED: 'cadets.manage', CADET_UPDATED: 'cadets.manage', BUNDLE_CREATED: 'bundles.manage', BUNDLE_UPDATED: 'bundles.manage', BUNDLE_DEACTIVATED: 'bundles.manage',
  STILL_NEEDED_ADDED: 'cadets.manage', STILL_NEEDED_UPDATED: 'cadets.manage', STILL_NEEDED_CANCELLED: 'cadets.manage', STILL_NEEDED_FULFILLED: 'cadets.manage',
  AUTHORITY_GRANTED: 'users.authorize', AUTHORITY_REVOKED: 'users.revoke', ROLE_CHANGED: 'users.manageRoles',
  CALENDAR_EVENT_CREATED: 'calendar.write', CALENDAR_EVENT_UPDATED: 'calendar.write', CALENDAR_TASK_ADDED: 'calendar.write', TASK_COMPLETED: 'calendar.write',
  CALENDAR_ATTENDEES_ADDED: 'calendar.write', CALENDAR_ATTENDEES_REMOVED: 'calendar.write', CALENDAR_BUNDLES_ADDED: 'calendar.write', CALENDAR_BUNDLES_REMOVED: 'calendar.write', CALENDAR_TASK_UPDATED: 'calendar.write', CALENDAR_TASK_REMOVED: 'calendar.write',
  PROPERTY_CORRECTED: 'inventory.adjust', ANNUAL_ROLLOVER_COMPLETED: 'cadets.manage', CADETS_IMPORTED: 'cadets.manage',
  UNIT_KEY_ROTATED: 'users.revoke', RECOVERY_KEY_REGISTERED: 'users.authorize',
}
/** Unit key generations are named e<n>-<random> so two Masters rotating at once never reuse a name. */
export const EPOCH_ID_PATTERN = /^e[1-9][0-9]{0,5}(-[0-9a-f]{4,16})?$/
/** Lamport clocks stay far below the 12-digit sort key; one event may not jump the unit's clock far ahead (it would stall ordering for everyone). */
export const MAX_EVENT_CLOCK = 100_000_000_000
export const MAX_CLOCK_JUMP = 100_000
/** Short, public tag of an author: event IDs start with it, so nobody can publish a record under someone else's event ID. */
export const authorTag = async (actorPublicIdentity: string) => (await sha256(actorPublicIdentity)).slice(0, 12)
export const authorBoundEventId = async (actorPublicIdentity: string, base: string) => { const tag = await authorTag(actorPublicIdentity); return base.startsWith(`${tag}.`) ? base : `${tag}.${base}` }
export const isAuthorBoundEventId = async (eventId: string, actorPublicIdentity: string) => eventId.startsWith(`${await authorTag(actorPublicIdentity)}.`)
/** Thrown by the fold when an event would leave the projection in an impossible state; the event is set aside and history re-folded without it. */
class UnsafeEvent extends Error {}
/** The quantity rules every projection must keep (the repository enforces the same ones on save). Cheap enough to check after every event. */
function projectionViolation(state: RepositoryState) {
  for (const item of state.inventory) if (!Number.isInteger(item.onHand) || item.onHand < 0 || !Number.isInteger(item.issued) || item.issued < 0) return true
  for (const cadet of state.cadets) for (const line of cadet.currentProperty) if (!Number.isInteger(line.quantity) || line.quantity <= 0) return true
  for (const need of state.stillNeeded) if (!(need.quantityFulfilled >= 0 && need.quantityFulfilled <= need.quantityNeeded)) return true
  return false
}
const unsigned = (event: SignedArgusEvent) => { const rest: Partial<SignedArgusEvent> = { ...event }; delete rest.signature; return canonicalize(rest) }
/** The exact text an event's signature covers. */
export const unsignedEventJson = unsigned
/** Canonical fold order shared by every device: Lamport clock, then event ID as a stable tie-break. */
export const eventSortKey = (event: Pick<SignedArgusEvent, 'clock' | 'eventId'>) => `${String(Math.max(0, Math.floor(event.clock ?? 0))).padStart(12, '0')}|${event.eventId}`
const pick = <T extends object>(source: Record<string, unknown>, allowed: ReadonlyArray<keyof T>): Partial<T> => Object.fromEntries(Object.entries(source).filter(([key]) => (allowed as ReadonlyArray<string>).includes(key))) as Partial<T>
const INVENTORY_EDITABLE = ['name', 'category', 'variant', 'niin', 'reorderAt', 'countIncrement', 'active'] as const
const CATALOG_EDITABLE = ['name', 'category', 'niin', 'sizeScheme', 'reorderAt', 'countIncrement', 'active'] as const
const CADET_EDITABLE = ['fullName', 'gender', 'nsLevel', 'status', 'sizes', 'profileNeedsReview'] as const
const NEED_EDITABLE = ['displayLabel', 'itemId', 'size', 'quantityNeeded', 'quantityFulfilled', 'status'] as const
const CALENDAR_SCALARS: readonly CalendarScalarField[] = ['title', 'startsAt', 'notes', 'active', 'kind']
/** bundleIds/cadetIds stay here only so legacy whole-list updates still fold; new edits use the set-style ADDED/REMOVED events. */
const CALENDAR_EDITABLE = ['title', 'startsAt', 'notes', 'active', 'kind', 'bundleIds', 'cadetIds'] as const
export const MAX_EVENT_CADETS = 500
export const MAX_EVENT_BUNDLES = 50
export const MAX_IMPORT_CADETS = 200
const NEXT_LEVEL: Record<NsLevel, NsLevel | 'GRADUATED'> = { NS1: 'NS2', NS2: 'NS3', NS3: 'NS4', NS4: 'GRADUATED' }
export const MAX_SUPPLY_LINE_QUANTITY = 100
export const MAX_COUNT_QUANTITY = 100_000
export const MAX_RECEIVE_QUANTITY = 10_000

type CommandOptions = { eventId?: string; timestamp?: string }
type InitialInventory = Array<Pick<InventoryProjection, 'entityId' | 'name' | 'onHand' | 'version'> & Partial<Omit<InventoryProjection, 'entityId' | 'name' | 'onHand' | 'version' | 'appliedEventIds'>>>

/**
 * One device's view of the unit's shared, append-only event history.
 *
 * Convergence rule: the projection is always equal to folding every known, signature-valid event
 * over the genesis state in eventSortKey order. Events that arrive in order are applied
 * incrementally; anything that arrives "in the past" (an offline device catching up, a reordered
 * chain page) triggers a full deterministic rebuild. So two devices holding the same events
 * always show the same numbers — A's 3 PT Shorts plus B's 3 PT Shorts is 6 on every device.
 */
export class ArgusReplica {
  online = true
  private syncing?: Promise<void>
  constructor(readonly repository: ArgusRepository, private identity: ArgusIdentityProvider, private authorization: AuthorizationService, private provider: EventSyncProvider, readonly organizationId = 'argus-demo-organization', private readonly options: { genesisCatalog?: boolean; strictPublish?: boolean; authorBoundEventIds?: boolean } = {}) {}
  /** Events that would corrupt the projection at their place in history (derived, the same on every device). */
  private readonly unsafeEvents = new Set<string>()

  async initialize(items: InitialInventory = []) {
    await this.repository.initialize()
    await this.repository.transaction(state => {
      if (!state.genesis) {
        // Rows already present without event provenance (older releases) become part of genesis so a rebuild never drops them.
        const legacy = state.inventory.filter(item => !item.appliedEventIds.length)
        const seeded = items.map(item => ({ category: 'Uncategorized', variant: 'No variant', niin: 'Not assigned', issued: 0, countIncrement: 1, active: true, ...item, appliedEventIds: [] }))
        state.genesis = {
          inventory: structuredClone([...(this.options.genesisCatalog ? GENESIS_INVENTORY : []), ...(legacy.length ? legacy : seeded)]),
          catalog: structuredClone(this.options.genesisCatalog ? GENESIS_CATALOG : []),
        }
      }
      if (!state.events.length && !state.inventory.length) state.inventory = structuredClone(state.genesis.inventory)
      if (!state.events.length && !state.catalog.length) state.catalog = structuredClone(state.genesis.catalog)
      for (const source of FACTORY_BUNDLES) if (!state.bundles.some(b => b.bundleId === source.bundleId)) state.bundles.push(factoryBundle(source, state.inventory))
    })
  }

  private async signed(input: Omit<UnsignedArgusEvent, 'protocol' | 'protocolVersion' | 'organizationId' | 'eventVersion' | 'eventId' | 'actorPublicIdentity' | 'timestamp' | 'clock'> & CommandOptions) {
    const clock = (await this.repository.snapshot()).clock + 1
    const event: UnsignedArgusEvent = { protocol: 'ARGUS', protocolVersion: 1, organizationId: this.organizationId, eventVersion: 1, eventId: await this.ownEventId(input.eventId ?? crypto.randomUUID()), eventType: input.eventType, entityId: input.entityId, actorPublicIdentity: await this.identity.getPublicIdentity(), timestamp: input.timestamp ?? new Date().toISOString(), clock, ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }), payload: input.payload }
    return { ...event, signature: await this.identity.sign(canonicalize(event)) } as SignedArgusEvent
  }
  /** With author-bound IDs (the shared chain ledger), every event ID this device creates starts with its author tag; retries map to the same ID. */
  private async ownEventId(base: string) { return this.options.authorBoundEventIds ? authorBoundEventId(await this.identity.getPublicIdentity(), base) : base }
  private async actor(permission: ArgusPermission, at?: string) { const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, permission, at); return actor }
  /** Signs, applies locally (throwing if the event would be rejected), queues for publication, then opportunistically syncs. */
  private async commit(input: Parameters<ArgusReplica['signed']>[0]) {
    const event = await this.signed(input)
    // A record that can never be published (e.g. too large to seal) is refused before it touches local state.
    await this.provider.preflight?.(event)
    await this.persistLocal(event)
    // With a durable local provider (the encrypted chain ledger) a failed hand-off of THIS record must surface; another queued
    // record failing is reported by the sync status, not as this command's failure. A remote-only provider may fail quietly.
    if (this.online) await this.sync().catch(async error => { if (this.options.strictPublish && (await this.repository.snapshot()).outbox.some(record => record.eventId === event.eventId && record.status === 'FAILED')) throw error })
    return event
  }
  /** Re-folds the whole history (after authority changes that can alter past authorization). */
  async rebuildNow() { await this.repository.transaction(state => this.rebuild(state)) }

  // ---------- inventory & catalog ----------
  async issue(entityId: string, quantity: number, options: CommandOptions = {}) {
    const state = await this.repository.snapshot(); const item = state.inventory.find(i => i.entityId === entityId)
    if (!item) throw new Error('Inventory item was not found.'); if (quantity <= 0 || item.onHand < quantity) throw new Error('Insufficient inventory.')
    await this.actor('inventory.issue', options.timestamp)
    return this.commit({ eventType: 'ITEM_ISSUED', entityId, baseVersion: item.version, payload: { quantity }, ...options })
  }
  async returnItem(entityId: string, quantity: number, options: CommandOptions = {}) {
    const state = await this.repository.snapshot(); const item = state.inventory.find(i => i.entityId === entityId)
    if (!item) throw new Error('Inventory item was not found.'); if (!Number.isInteger(quantity) || quantity <= 0 || (item.issued ?? 0) < quantity) throw new Error('Invalid return quantity.')
    await this.actor('inventory.return', options.timestamp)
    return this.commit({ eventType: 'ITEM_RETURNED', entityId, baseVersion: item.version, payload: { quantity }, ...options })
  }
  async createInventoryItem(input: Omit<InventoryProjection, 'entityId' | 'version' | 'appliedEventIds' | 'issued'> & { entityId?: string; issued?: number }, options: CommandOptions = {}) {
    if (!input.name.trim() || !input.category.trim() || !Number.isInteger(input.onHand) || input.onHand < 0 || !Number.isInteger(input.countIncrement) || input.countIncrement < 1) throw new Error('Inventory item details are invalid.')
    await this.actor('inventory.create', options.timestamp)
    const id = input.entityId ?? `item_${crypto.randomUUID()}`; if ((await this.repository.snapshot()).inventory.some(item => item.entityId === id)) throw new Error('Inventory item ID already exists.')
    return this.commit({ eventType: 'INVENTORY_ITEM_CREATED', entityId: id, payload: { ...input, issued: input.issued ?? 0 }, ...options })
  }
  async updateInventoryItem(entityId: string, changes: Partial<Pick<InventoryProjection, 'name'|'category'|'variant'|'niin'|'reorderAt'|'countIncrement'|'active'>>, options: CommandOptions = {}) {
    const item = (await this.repository.snapshot()).inventory.find(candidate => candidate.entityId === entityId); if (!item) throw new Error('Inventory item was not found.')
    validateInventoryChanges(changes); await this.actor('inventory.adjust', options.timestamp)
    return this.commit({ eventType: 'INVENTORY_ITEM_UPDATED', entityId, baseVersion: item.version, payload: pick(changes, INVENTORY_EDITABLE), ...options })
  }
  /** Receiving new stock is additive and commutes: two officers each receiving 10 shorts yields +20 everywhere. */
  async receiveStock(itemId: string, quantity: number, note = '', options: CommandOptions = {}) {
    const item = (await this.repository.snapshot()).inventory.find(candidate => candidate.entityId === itemId); if (!item) throw new Error('Inventory item was not found.')
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_RECEIVE_QUANTITY) throw new Error(`Received quantity must be a whole number from 1 to ${MAX_RECEIVE_QUANTITY}.`)
    if (note.length > 500) throw new Error('Note is too long.')
    await this.actor('inventory.adjust', options.timestamp)
    return this.commit({ eventType: 'INVENTORY_RECEIVED', entityId: itemId, payload: { quantity, ...(note.trim() ? { note: note.trim() } : {}) }, ...options })
  }
  async createCatalogItem(input: { name: string; category: string; niin?: string; sized: boolean; sizeScheme?: string; reorderAt?: number; countIncrement?: number; catalogId?: string }, options: CommandOptions = {}) {
    const value = { name: input.name.trim(), category: input.category.trim(), niin: (input.niin ?? '').trim(), sized: input.sized, ...(input.sizeScheme ? { sizeScheme: input.sizeScheme } : {}), ...(input.reorderAt === undefined ? {} : { reorderAt: input.reorderAt }), countIncrement: input.countIncrement ?? 1 }
    validateCatalog(value)
    await this.actor('inventory.create', options.timestamp)
    const state = await this.repository.snapshot(), id = input.catalogId ?? `catalog_${crypto.randomUUID()}`
    if (state.catalog.some(item => item.catalogId === id)) throw new Error('Catalog item ID already exists.')
    return this.commit({ eventType: 'CATALOG_ITEM_CREATED', entityId: id, payload: value, ...options })
  }
  async updateCatalogItem(catalogId: string, changes: Partial<Pick<CatalogItemProjection, 'name'|'category'|'niin'|'sizeScheme'|'reorderAt'|'countIncrement'|'active'>>, options: CommandOptions = {}) {
    const state = await this.repository.snapshot(), item = state.catalog.find(candidate => candidate.catalogId === catalogId); if (!item) throw new Error('Catalog item was not found.')
    const payload = pick<CatalogItemProjection>(changes, CATALOG_EDITABLE); validateCatalog({ ...item, ...payload })
    await this.actor('inventory.adjust', options.timestamp)
    return this.commit({ eventType: 'CATALOG_ITEM_UPDATED', entityId: catalogId, payload, ...options })
  }
  /** Adds sizes (new zero-quantity variants) to a sized catalog item in one event, however many sizes are chosen. */
  async addCatalogSizes(catalogId: string, labels: string[], options: CommandOptions = {}) {
    const state = await this.repository.snapshot(), item = state.catalog.find(candidate => candidate.catalogId === catalogId)
    if (!item) throw new Error('Catalog item was not found.'); if (!item.sized) throw new Error(`${item.name} is not sized.`)
    const existing = new Set(state.inventory.filter(variant => variant.catalogId === catalogId).map(variant => variant.variant.toLowerCase()))
    const sizes: Array<{ itemId: string; label: string }> = []
    for (const raw of labels) { const label = normalizeSizeLabel(raw); if (existing.has(label.toLowerCase())) continue; existing.add(label.toLowerCase()); sizes.push({ itemId: `item_${crypto.randomUUID()}`, label }) }
    if (!sizes.length) throw new Error('Those sizes already exist.'); if (sizes.length > 200) throw new Error('Add at most 200 sizes at a time.')
    await this.actor('inventory.create', options.timestamp)
    return this.commit({ eventType: 'CATALOG_SIZES_ADDED', entityId: catalogId, payload: { sizes }, ...options })
  }

  // ---------- issue / return ----------
  async issueTransaction(input: { transactionId: string; cadetId: string; lines: Array<{ lineId: string; itemId: string; quantity: number; requirementId?: string }>; missingLines?: MissingIssueLine[]; bundleId?: string; bundleVersion?: number }, options: CommandOptions = {}) {
    await this.actor('inventory.issue', options.timestamp)
    const state = await this.repository.snapshot(), cadet = state.cadets.find(candidate => candidate.cadetId === input.cadetId)
    if (!cadet) throw new Error('Cadet was not found.'); if (cadet.status !== 'ACTIVE') throw new Error('Inactive cadets cannot receive inventory.')
    this.validateDraftIdentity(input.transactionId, input.lines, input.missingLines)
    const retryId = options.eventId ? await this.ownEventId(options.eventId) : undefined, retry = retryId ? state.events.find(record => record.event.eventId === retryId) : undefined
    if (retry) { const prior = retry.event.payload as { transactionId?:unknown;cadetId?:unknown;lines?:Array<{lineId:string;itemId:string;quantity:number}> }; if (retry.event.eventType !== 'ITEM_ISSUED' || prior.transactionId !== input.transactionId || prior.cadetId !== input.cadetId || canonicalize(prior.lines?.map(({lineId,itemId,quantity})=>({lineId,itemId,quantity}))??[]) !== canonicalize(input.lines.map(({lineId,itemId,quantity})=>({lineId,itemId,quantity})))) throw new Error('Event ID collision detected.'); return retry.event }
    const lines = input.lines.map(line => { const item = state.inventory.find(candidate => candidate.entityId === line.itemId); if (!item) throw new Error('Inventory item was not found.'); if (!item.active) throw new Error(`${item.name} · ${item.variant} is inactive.`); this.validateQuantity(line.quantity); if (item.onHand < line.quantity) throw new Error(`Stock changed before confirmation. ${item.name} · ${item.variant} is no longer available.`); return { ...line, label: item.name, variant: item.variant, baseVersion: item.version } })
    const bundle = input.bundleId ? state.bundles.find(candidate => candidate.bundleId === input.bundleId)?.versions.find(version => version.version === input.bundleVersion) : undefined
    if (input.bundleId && !bundle) throw new Error('The selected bundle version is no longer valid.')
    return this.commit({ eventType: 'ITEM_ISSUED', entityId: input.transactionId, payload: { ...input, lines, ...(bundle ? { bundleSnapshot: structuredClone(bundle) } : {}) }, ...options })
  }
  async returnTransaction(input: { transactionId: string; cadetId: string; lines: Array<{ lineId: string; propertyId: string; quantity: number }> }, options: CommandOptions = {}) {
    await this.actor('inventory.return', options.timestamp)
    const state = await this.repository.snapshot(), cadet = state.cadets.find(candidate => candidate.cadetId === input.cadetId); if (!cadet) throw new Error('Cadet was not found.')
    this.validateDraftIdentity(input.transactionId, input.lines)
    const retryId = options.eventId ? await this.ownEventId(options.eventId) : undefined, retry = retryId ? state.events.find(record => record.event.eventId === retryId) : undefined
    if (retry) { const prior = retry.event.payload as { transactionId?:unknown;cadetId?:unknown;lines?:Array<{lineId:string;propertyId:string;quantity:number}> }; if (retry.event.eventType !== 'ITEM_RETURNED' || prior.transactionId !== input.transactionId || prior.cadetId !== input.cadetId || canonicalize(prior.lines?.map(({lineId,propertyId,quantity})=>({lineId,propertyId,quantity}))??[]) !== canonicalize(input.lines)) throw new Error('Event ID collision detected.'); return retry.event }
    const lines = input.lines.map(line => { const property = cadet.currentProperty.find(candidate => candidate.propertyId === line.propertyId); if (!property) throw new Error('This cadet no longer has the selected item.'); this.validateQuantity(line.quantity); if (line.quantity > property.quantity) throw new Error('Return quantity exceeds current property.'); const item = state.inventory.find(candidate => candidate.entityId === property.itemId); if (!item) throw new Error('Inventory mapping for returned property was not found.'); return { ...line, itemId: item.entityId, label: item.name, variant: item.variant, baseVersion: item.version } })
    return this.commit({ eventType: 'ITEM_RETURNED', entityId: input.transactionId, payload: { transactionId: input.transactionId, cadetId: input.cadetId, lines }, ...options })
  }
  private validateDraftIdentity(transactionId: string, lines: Array<{ lineId: string; itemId?: string }>, missing: MissingIssueLine[] = []) { if (!transactionId || (!lines.length && !missing.length)) throw new Error('Supply transaction is empty.'); const ids = [...lines, ...missing].map(line => line.lineId); if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Supply transaction line IDs must be unique.'); const items = lines.map(line => line.itemId).filter(Boolean); if (new Set(items).size !== items.length) throw new Error('Duplicate inventory variants are not allowed in one transaction.') }
  private validateQuantity(quantity: number) { if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SUPPLY_LINE_QUANTITY) throw new Error(`Quantity must be a whole number from 1 to ${MAX_SUPPLY_LINE_QUANTITY}.`) }

  // ---------- counting ----------
  /** Legacy absolute count (replaces on-hand). The shared count session below is the normal path. */
  async submitCount(entityId: string, countedQuantity: number, sessionId: string, note = '', options: CommandOptions = {}) {
    const state = await this.repository.snapshot(); const item = state.inventory.find(i => i.entityId === entityId)
    if (!item || !Number.isInteger(countedQuantity) || countedQuantity < 0 || !sessionId.trim() || note.length > 500) throw new Error('Invalid physical count.')
    await this.actor('inventory.count', options.timestamp)
    return this.commit({ eventType: 'INVENTORY_COUNT_SUBMITTED', entityId, baseVersion: item.version, payload: { sessionId, expectedQuantity: item.onHand, countedQuantity, discrepancy: countedQuantity - item.onHand, ...(note.trim() ? { note: note.trim() } : {}) }, ...options })
  }
  /** Opens a shared count. Assignments are optional: without them anyone may contribute to any item and contributions add up. */
  async createCountSession(input: { sessionId: string; scope: string; assignments?: CountAssignment[] }, options: CommandOptions = {}) {
    const assignments = input.assignments ?? []
    if (!input.sessionId.trim() || !input.scope.trim() || input.scope.length > 120) throw new Error('Count session details are invalid.')
    const state = await this.repository.snapshot(), assignmentIds = assignments.map(a => a.assignmentId)
    if (state.countSessions.some(session => session.sessionId === input.sessionId)) throw new Error('Count session ID already exists.')
    if (new Set(assignmentIds).size !== assignmentIds.length || assignments.some(a => !a.assignmentId || !a.scope || !state.inventory.some(i => i.entityId === a.itemId))) throw new Error('Count assignments must be unique and reference inventory variants.')
    await this.actor('inventory.count', options.timestamp)
    return this.commit({ eventType: 'COUNT_SESSION_CREATED', entityId: input.sessionId, payload: { scope: input.scope.trim(), assignments }, ...options })
  }
  /** Adds this person's tally for one item (or one assignment) to the shared total. */
  async contributeCount(sessionId: string, target: string | { itemId: string }, quantity: number, note = '', options: CommandOptions = {}) {
    this.validateCountQuantity(quantity); if (note.length > 500) throw new Error('Count note is too long.')
    const state = await this.repository.snapshot(), session = state.countSessions.find(s => s.sessionId === sessionId)
    if (!session || !['DRAFT', 'ACTIVE'].includes(session.status)) throw new Error('Count session is not open.')
    let itemId: string, assignmentId: string | undefined
    if (typeof target === 'string') { const assignment = session.assignments.find(a => a.assignmentId === target); if (!assignment) throw new Error('Count session or assignment is not open.'); itemId = assignment.itemId; assignmentId = assignment.assignmentId }
    else { itemId = target.itemId; if (!state.inventory.some(item => item.entityId === itemId && item.active)) throw new Error('That item size is not available for counting.') }
    await this.actor('inventory.count', options.timestamp)
    return this.commit({ eventType: 'COUNT_CONTRIBUTED', entityId: sessionId, payload: { itemId, ...(assignmentId ? { assignmentId } : {}), quantity, ...(note.trim() ? { note: note.trim() } : {}) }, ...options })
  }
  async correctCount(sessionId: string, originalEventId: string, replacementQuantity: number, reason: string, options: CommandOptions = {}) {
    this.validateCountQuantity(replacementQuantity); if (!reason.trim() || reason.length > 500) throw new Error('A correction reason is required.')
    const session = (await this.repository.snapshot()).countSessions.find(s => s.sessionId === sessionId), original = session?.observations.find(o => o.eventId === originalEventId)
    if (!session || !original || !['DRAFT', 'ACTIVE'].includes(session.status)) throw new Error('The contribution cannot be corrected.')
    await this.actor('inventory.count', options.timestamp)
    return this.commit({ eventType: 'COUNT_CORRECTED', entityId: sessionId, payload: { originalEventId, replacementQuantity, reason: reason.trim() }, ...options })
  }
  async recount(sessionId: string, assignmentId: string, quantity: number, reason: string, options: CommandOptions = {}) {
    this.validateCountQuantity(quantity); if (!reason.trim()) throw new Error('A recount reason is required.')
    const session = (await this.repository.snapshot()).countSessions.find(s => s.sessionId === sessionId), assignment = session?.assignments.find(a => a.assignmentId === assignmentId)
    if (!session || !assignment || !['DRAFT', 'ACTIVE'].includes(session.status)) throw new Error('The assignment cannot be recounted.')
    const supersedesEventIds = session.observations.filter(o => o.assignmentId === assignmentId && o.status !== 'LATE').map(o => o.eventId)
    await this.actor('inventory.count', options.timestamp)
    return this.commit({ eventType: 'COUNT_RECOUNTED', entityId: sessionId, payload: { assignmentId, itemId: assignment.itemId, quantity, reason: reason.trim(), supersedesEventIds }, ...options })
  }
  async submitCountSession(sessionId: string, options: CommandOptions = {}) {
    const session = (await this.repository.snapshot()).countSessions.find(s => s.sessionId === sessionId)
    if (!session || !['DRAFT', 'ACTIVE'].includes(session.status)) throw new Error('Count session is not open.')
    await this.actor('inventory.count', options.timestamp)
    const acceptedEventIds = session.observations.filter(o => o.status !== 'LATE').map(o => o.eventId).sort()
    return this.commit({ eventType: 'COUNT_SESSION_SUBMITTED', entityId: sessionId, payload: { acceptedEventIds }, ...options })
  }
  async reconcileCountSession(sessionId: string, options: CommandOptions = {}) {
    const session = (await this.repository.snapshot()).countSessions.find(s => s.sessionId === sessionId)
    if (!session || session.status !== 'SUBMITTED') throw new Error('Count session is not ready for reconciliation.')
    if (session.lateEventIds.length) throw new Error('Submitted session has unresolved late work.')
    await this.actor('inventory.adjust', options.timestamp)
    return this.commit({ eventType: 'COUNT_SESSION_RECONCILED', entityId: sessionId, payload: { acceptedEventIds: session.acceptedEventIds, totals: session.totals }, ...options })
  }
  /**
   * Officer finalization in one step: freezes exactly the contributions this device has seen and
   * replaces on-hand for every counted size with the shared total. Contributions that reach the
   * chain afterwards stay visible as LATE and never silently change stock.
   */
  async finalizeCountSession(sessionId: string, options: CommandOptions = {}) {
    const session = (await this.repository.snapshot()).countSessions.find(s => s.sessionId === sessionId)
    if (!session || !['DRAFT', 'ACTIVE', 'SUBMITTED'].includes(session.status)) throw new Error('Count session is not open.')
    if (session.status === 'SUBMITTED' && session.lateEventIds.length) throw new Error('Submitted session has unresolved late work.')
    await this.actor('inventory.adjust', options.timestamp)
    const acceptedEventIds = session.acceptedEventIds ?? session.observations.filter(o => o.status !== 'LATE').map(o => o.eventId).sort()
    return this.commit({ eventType: 'COUNT_SESSION_RECONCILED', entityId: sessionId, payload: { acceptedEventIds, totals: totalsFor(session.observations, new Set(acceptedEventIds)) }, ...options })
  }
  async cancelCountSession(sessionId: string, reason: string, options: CommandOptions = {}) {
    const session = (await this.repository.snapshot()).countSessions.find(s => s.sessionId === sessionId)
    if (!session || ['RECONCILED', 'CANCELLED'].includes(session.status)) throw new Error('Count session cannot be cancelled.')
    await this.actor('inventory.adjust', options.timestamp)
    return this.commit({ eventType: 'COUNT_SESSION_CANCELLED', entityId: sessionId, payload: { reason: reason.trim().slice(0, 500) }, ...options })
  }
  private validateCountQuantity(quantity: number) { if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_COUNT_QUANTITY) throw new Error(`Count must be a whole number from 0 to ${MAX_COUNT_QUANTITY}.`) }

  // ---------- corrections & conflicts ----------
  async correct(originalEventId: string, entityId: string, field: string, value: unknown, reason: string) {
    await this.actor('inventory.adjust')
    const event = await this.signed({ eventType: 'RECORD_CORRECTED', entityId, payload: { originalEventId, field, value, reason } }); await this.persistLocal(event); return event
  }
  async resolve(conflictId: string, resolution: string) {
    await this.actor('conflicts.resolve')
    const state = await this.repository.snapshot(); const conflict = state.conflicts.find(c => c.id === conflictId && c.status === 'OPEN'); if (!conflict) throw new Error('Open conflict was not found.')
    if (!resolution.trim()) throw new Error('Describe how the conflict was resolved.')
    return this.commit({ eventType: 'CONFLICT_RESOLVED', entityId: conflict.entityId, payload: { conflictId, resolution: resolution.trim().slice(0, 500) } })
  }

  // ---------- cadets, bundles, still needed ----------
  async createCadet(input: Pick<CadetProjection, 'gender' | 'nsLevel' | 'status'> & { fullName?: string; sizes?: Record<string, string>; cadetCode?: string }, options: CommandOptions = {}) {
    const state = await this.repository.snapshot()
    const cadetCode = input.cadetCode ?? generateCadetCode(state.cadets.flatMap(c => c.cadetCode ? [c.cadetCode] : []))
    if (state.cadets.some(c => c.cadetCode === cadetCode)) throw new Error(`Cadet ID ${cadetCode} is already in use.`)
    const value = { fullName: (input.fullName ?? '').trim(), gender: input.gender, nsLevel: input.nsLevel, status: input.status, sizes: input.sizes ?? {}, cadetCode }
    validateCadet(value); await this.actor('cadets.manage', options.timestamp)
    return this.commit({ eventType: 'CADET_CREATED', entityId: `cadet_${crypto.randomUUID()}`, payload: value, ...options })
  }
  async updateCadet(cadetId: string, changes: Partial<Pick<CadetProjection, 'fullName' | 'gender' | 'nsLevel' | 'status' | 'sizes' | 'profileNeedsReview'>>, options: CommandOptions = {}) {
    const cadet = (await this.repository.snapshot()).cadets.find(c => c.cadetId === cadetId); if (!cadet) throw new Error('Cadet was not found.')
    const payload = pick<CadetProjection>(changes, CADET_EDITABLE); validateCadet({ ...cadet, ...payload }); await this.actor('cadets.manage', options.timestamp)
    return this.commit({ eventType: 'CADET_UPDATED', entityId: cadetId, baseVersion: cadet.version, payload, ...options })
  }
  async updateBundle(bundleId: string, input: Omit<BundleVersionProjection, 'bundleId' | 'version' | 'createdAt' | 'actorPublicIdentity' | 'priorVersion' | 'eventId'>, options: CommandOptions = {}) {
    const current = (await this.repository.snapshot()).bundles.find(b => b.bundleId === bundleId); if (!current) throw new Error('Bundle was not found.'); await this.actor('bundles.manage', options.timestamp); validateBundle({ ...input, version: current.currentVersion + 1 })
    return this.commit({ eventType: 'BUNDLE_UPDATED', entityId: bundleId, baseVersion: current.currentVersion, payload: input, ...options })
  }
  async createBundle(bundleId: string, input: Omit<BundleVersionProjection, 'bundleId' | 'version' | 'createdAt' | 'actorPublicIdentity' | 'priorVersion' | 'eventId'>, options: CommandOptions = {}) {
    const state = await this.repository.snapshot(); if (!bundleId || state.bundles.some(b => b.bundleId === bundleId)) throw new Error('Bundle ID is invalid or already exists.'); validateBundle({ ...input, version: 1 }, state.inventory); await this.actor('bundles.manage', options.timestamp)
    return this.commit({ eventType: 'BUNDLE_CREATED', entityId: bundleId, payload: input, ...options })
  }
  async addStillNeeded(input: Omit<StillNeededProjection, 'requirementId' | 'version' | 'appliedEventIds' | 'updatedAt'> & { requirementId?: string }, options: CommandOptions = {}) {
    validateRequirement(input); const state = await this.repository.snapshot(); if (!state.cadets.some(c => c.cadetId === input.cadetId)) throw new Error('Cadet was not found.'); await this.actor('cadets.manage', options.timestamp); const id = input.requirementId ?? `need_${crypto.randomUUID()}`
    return this.commit({ eventType: 'STILL_NEEDED_ADDED', entityId: id, payload: input, ...options })
  }
  async updateStillNeeded(requirementId: string, changes: Partial<Pick<StillNeededProjection,'displayLabel'|'itemId'|'size'|'quantityNeeded'|'quantityFulfilled'|'status'>>, options: CommandOptions = {}) {
    const requirement = (await this.repository.snapshot()).stillNeeded.find(r => r.requirementId === requirementId); if (!requirement) throw new Error('Still Needed requirement was not found.')
    const payload = pick<StillNeededProjection>(changes, NEED_EDITABLE), next = { ...requirement, ...payload }; validateRequirement(next); await this.actor('cadets.manage', options.timestamp)
    const type = next.status === 'CANCELLED' ? 'STILL_NEEDED_CANCELLED' : next.status === 'FULFILLED' ? 'STILL_NEEDED_FULFILLED' : 'STILL_NEEDED_UPDATED'
    return this.commit({ eventType: type, entityId: requirementId, baseVersion: requirement.version, payload, ...options })
  }

  // ---------- calendar (master spec §14–19) ----------
  /** Creates a supply event; tasks default to the event kind's template, due relative to the (hand-entered) date. */
  async createCalendarEvent(input: { kind: SupplyEventKind; title?: string; startsAt: string; notes?: string; bundleIds?: string[]; cadetIds?: string[]; tasks?: Array<{ title: string; dueOffsetDays: number }> }, options: CommandOptions = {}) {
    const template = templateFor(input.kind)
    const value = { kind: input.kind, title: (input.title ?? template?.title ?? '').trim(), startsAt: input.startsAt, ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}), bundleIds: input.bundleIds ?? template?.bundleIds ?? [], cadetIds: input.cadetIds ?? [], tasks: (input.tasks ?? template?.tasks ?? []).map(task => ({ taskId: `task_${crypto.randomUUID()}`, title: task.title, dueOffsetDays: task.dueOffsetDays })) }
    validateCalendar(value); await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_EVENT_CREATED', entityId: `calendar_${crypto.randomUUID()}`, payload: value, ...options })
  }
  /**
   * Edits scalar details (title, date/time, notes, kind, cancelled). The event names the revisions of
   * each changed field that the editor saw — `base` is the version on screen when editing began,
   * defaulting to this device's current one — so a concurrent edit of the same field on another
   * device becomes a visible conflict, while edits of different fields merge.
   */
  async updateCalendarEvent(calendarEventId: string, changes: Partial<Pick<CalendarEventProjection, CalendarScalarField>>, options: CommandOptions & { base?: Pick<CalendarEventProjection, 'version' | 'appliedEventIds' | 'fieldRevisions'> } = {}) {
    const event = (await this.repository.snapshot()).calendar.find(candidate => candidate.calendarEventId === calendarEventId); if (!event) throw new Error('Supply event was not found.')
    const changed = pick<CalendarEventProjection>(changes, CALENDAR_SCALARS); if (!Object.keys(changed).length) throw new Error('Nothing to change.')
    validateCalendar({ ...event, ...changed }); validateActive(changed); await this.actor('calendar.write', options.timestamp)
    const { base = event, ...command } = options
    const baseRevisions = Object.fromEntries(Object.keys(changed).map(field => [field, fieldWriters(base, field as CalendarScalarField)]))
    return this.commit({ eventType: 'CALENDAR_EVENT_UPDATED', entityId: calendarEventId, baseVersion: base.version, payload: { ...changed, baseRevisions }, ...command })
  }
  async addCalendarTask(calendarEventId: string, task: { title: string; dueOffsetDays: number }, options: CommandOptions = {}) {
    if (!(await this.repository.snapshot()).calendar.some(candidate => candidate.calendarEventId === calendarEventId)) throw new Error('Supply event was not found.')
    validateTask(task); await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_TASK_ADDED', entityId: calendarEventId, payload: { taskId: `task_${crypto.randomUUID()}`, title: task.title.trim(), dueOffsetDays: task.dueOffsetDays }, ...options })
  }
  async completeTask(calendarEventId: string, taskId: string, completed = true, options: CommandOptions = {}) {
    const event = (await this.repository.snapshot()).calendar.find(candidate => candidate.calendarEventId === calendarEventId)
    if (!event?.tasks.some(task => task.taskId === taskId)) throw new Error('Preparation task was not found.')
    await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'TASK_COMPLETED', entityId: calendarEventId, payload: { taskId, completed }, ...options })
  }
  /** Renames a task or moves its due date; its completion is kept. Only the changed fields travel, so different edits merge. */
  async updateCalendarTask(calendarEventId: string, taskId: string, changes: { title?: string; dueOffsetDays?: number }, options: CommandOptions = {}) {
    const task = (await this.repository.snapshot()).calendar.find(candidate => candidate.calendarEventId === calendarEventId)?.tasks.find(candidate => candidate.taskId === taskId)
    if (!task) throw new Error('Preparation task was not found.')
    const title = changes.title?.trim()
    const payload = { taskId, ...(title !== undefined && title !== task.title ? { title } : {}), ...(changes.dueOffsetDays !== undefined && changes.dueOffsetDays !== task.dueOffsetDays ? { dueOffsetDays: changes.dueOffsetDays } : {}) }
    if (Object.keys(payload).length === 1) throw new Error('Nothing to change.')
    validateTask({ ...task, ...payload }); await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_TASK_UPDATED', entityId: calendarEventId, payload, ...options })
  }
  /** Takes a task off the checklist. Its completion history stays with the event (removedTasks) and in the log. */
  async removeCalendarTask(calendarEventId: string, taskId: string, options: CommandOptions = {}) {
    const event = (await this.repository.snapshot()).calendar.find(candidate => candidate.calendarEventId === calendarEventId)
    if (!event?.tasks.some(task => task.taskId === taskId)) throw new Error('Preparation task was not found.')
    await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_TASK_REMOVED', entityId: calendarEventId, payload: { taskId }, ...options })
  }
  /** Attendees are a set: adds and removes from several devices merge instead of overwriting each other. */
  async addCalendarAttendees(calendarEventId: string, cadetIds: string[], options: CommandOptions = {}) {
    const state = await this.repository.snapshot(), event = state.calendar.find(candidate => candidate.calendarEventId === calendarEventId); if (!event) throw new Error('Supply event was not found.')
    const known = new Set(state.cadets.map(cadet => cadet.cadetId)); if (cadetIds.some(id => !known.has(id))) throw new Error('Cadet was not found.')
    const attending = new Set(event.cadetIds), fresh = sortedUnique(cadetIds.filter(id => !attending.has(id)))
    if (!fresh.length) throw new Error('Those cadets are already attending.')
    if (attending.size + fresh.length > MAX_EVENT_CADETS) throw new Error(`An event can have at most ${MAX_EVENT_CADETS} attendees.`)
    await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_ATTENDEES_ADDED', entityId: calendarEventId, payload: { calendarEventId, cadetIds: fresh }, ...options })
  }
  async removeCalendarAttendees(calendarEventId: string, cadetIds: string[], options: CommandOptions = {}) {
    const event = (await this.repository.snapshot()).calendar.find(candidate => candidate.calendarEventId === calendarEventId); if (!event) throw new Error('Supply event was not found.')
    const leaving = sortedUnique(cadetIds.filter(id => event.cadetIds.includes(id))); if (!leaving.length) throw new Error('Those cadets are not attending.')
    await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_ATTENDEES_REMOVED', entityId: calendarEventId, payload: { calendarEventId, cadetIds: leaving }, ...options })
  }
  /** Links bundles to an event (set-style, like attendees), so custom events can issue bundles too. */
  async addCalendarBundles(calendarEventId: string, bundleIds: string[], options: CommandOptions = {}) {
    const state = await this.repository.snapshot(), event = state.calendar.find(candidate => candidate.calendarEventId === calendarEventId); if (!event) throw new Error('Supply event was not found.')
    if (bundleIds.some(id => !state.bundles.some(bundle => bundle.bundleId === id))) throw new Error('Bundle was not found.')
    const fresh = [...new Set(bundleIds.filter(id => !event.bundleIds.includes(id)))]
    if (!fresh.length) throw new Error('Those bundles are already linked.')
    if (event.bundleIds.length + fresh.length > MAX_EVENT_BUNDLES) throw new Error(`An event can link at most ${MAX_EVENT_BUNDLES} bundles.`)
    await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_BUNDLES_ADDED', entityId: calendarEventId, payload: { calendarEventId, bundleIds: fresh }, ...options })
  }
  async removeCalendarBundles(calendarEventId: string, bundleIds: string[], options: CommandOptions = {}) {
    const event = (await this.repository.snapshot()).calendar.find(candidate => candidate.calendarEventId === calendarEventId); if (!event) throw new Error('Supply event was not found.')
    const leaving = [...new Set(bundleIds.filter(id => event.bundleIds.includes(id)))]; if (!leaving.length) throw new Error('Those bundles are not linked.')
    await this.actor('calendar.write', options.timestamp)
    return this.commit({ eventType: 'CALENDAR_BUNDLES_REMOVED', entityId: calendarEventId, payload: { calendarEventId, bundleIds: leaving }, ...options })
  }

  // ---------- corrections, rollover, roster import ----------
  /** Master spec §12: "34R was issued, 32R is correct". The original issue stays in history; stock and property move to the right size. */
  async correctIssuedSize(input: { cadetId: string; propertyId: string; toItemId: string; quantity?: number; reason: string }, options: CommandOptions = {}) {
    const state = await this.repository.snapshot(), cadet = state.cadets.find(candidate => candidate.cadetId === input.cadetId)
    const property = cadet?.currentProperty.find(candidate => candidate.propertyId === input.propertyId)
    if (!cadet || !property) throw new Error('That issued item was not found on the cadet record.')
    const quantity = input.quantity ?? property.quantity, target = state.inventory.find(item => item.entityId === input.toItemId)
    if (!target || !target.active) throw new Error('Choose an active size to correct to.')
    if (target.entityId === property.itemId) throw new Error('Choose a different size.')
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > property.quantity) throw new Error('Correction quantity is invalid.')
    if (target.onHand < quantity) throw new Error(`Only ${target.onHand} of ${target.name} · ${target.variant} on hand.`)
    if (!input.reason.trim() || input.reason.length > 500) throw new Error('Give a reason for the correction.')
    await this.actor('inventory.adjust', options.timestamp)
    return this.commit({ eventType: 'PROPERTY_CORRECTED', entityId: input.cadetId, payload: { propertyId: input.propertyId, originalEventId: property.issueEventId, fromItemId: property.itemId, toItemId: target.entityId, quantity, reason: input.reason.trim() }, ...options })
  }
  /** Advances every active cadet one NS level; NS4 cadets graduate (become inactive, keeping their record and property for return). */
  async completeAnnualRollover(schoolYear: string, options: CommandOptions = {}) {
    if (!/^\d{4}-\d{4}$/.test(schoolYear)) throw new Error('School year looks like 2026-2027.')
    if ((await this.repository.snapshot()).rollovers.some(record => record.schoolYear === schoolYear)) throw new Error(`Rollover for ${schoolYear} is already complete.`)
    await this.actor('cadets.manage', options.timestamp)
    // The cadets to advance are fixed when the rollover is made, so a class imported concurrently on another device is not promoted with it.
    const cadetIds = (await this.repository.snapshot()).cadets.filter(cadet => cadet.status === 'ACTIVE').map(cadet => cadet.cadetId).sort()
    return this.commit({ eventType: 'ANNUAL_ROLLOVER_COMPLETED', entityId: `rollover:${schoolYear}`, payload: { schoolYear, cadetIds }, ...options })
  }
  /** Adds many cadets in one event (e.g. the incoming NS1 class for NCO). Names are optional and stay encrypted. */
  async importCadets(rows: Array<{ gender: CadetProjection['gender']; nsLevel: NsLevel; fullName?: string; cadetCode?: string; sizes?: Record<string, string> }>, options: CommandOptions = {}) {
    if (!rows.length || rows.length > MAX_IMPORT_CADETS) throw new Error(`Import between 1 and ${MAX_IMPORT_CADETS} cadets at a time.`)
    const state = await this.repository.snapshot(), taken = new Set(state.cadets.flatMap(cadet => cadet.cadetCode ? [cadet.cadetCode] : []))
    const cadets = rows.map((row, index) => {
      const cadetCode = row.cadetCode?.trim().toUpperCase() || generateCadetCode(taken)
      if (taken.has(cadetCode) && row.cadetCode) throw new Error(`Row ${index + 1}: cadet ID ${cadetCode} is already in use.`)
      taken.add(cadetCode)
      const value = { cadetId: `cadet_${crypto.randomUUID()}`, cadetCode, fullName: (row.fullName ?? '').trim(), gender: row.gender, nsLevel: row.nsLevel, status: 'ACTIVE' as const, sizes: row.sizes ?? {} }
      try { validateCadet(value) } catch (error) { throw new Error(`Row ${index + 1}: ${error instanceof Error ? error.message : 'invalid cadet'}`, { cause: error }) }
      return value
    })
    await this.actor('cadets.manage', options.timestamp)
    return this.commit({ eventType: 'CADETS_IMPORTED', entityId: `import_${crypto.randomUUID()}`, payload: { cadets }, ...options })
  }

  // ---------- membership ----------
  /** Publishes an admission to the whole unit so every device learns the member's role, display name and wallet. */
  async recordAdmission(input: { credential: AuthorityCredential; displayName: string; walletAddress?: string; ecdhPublicKey?: string }, options: CommandOptions = {}) {
    const displayName = input.displayName.trim(); if (!displayName || displayName.length > 60) throw new Error('Enter a display name of 1–60 characters.')
    await this.actor('users.authorize', options.timestamp)
    return this.commit({ eventType: 'AUTHORITY_GRANTED', entityId: input.credential.subjectPublicIdentity, payload: { credential: input.credential, displayName, ...(input.walletAddress ? { walletAddress: input.walletAddress } : {}), ...(input.ecdhPublicKey ? { ecdhPublicKey: input.ecdhPublicKey } : {}) }, ...options })
  }
  async recordRevocation(revocation: AuthorityRevocation, options: CommandOptions = {}) {
    await this.actor('users.revoke', options.timestamp)
    return this.commit({ eventType: 'AUTHORITY_REVOKED', entityId: revocation.subjectPublicIdentity, payload: { revocation }, ...options })
  }
  /** A new credential with the new role replaces the old one, which is revoked in the same event, so there is never a moment with two roles or none. */
  async changeRole(input: { credential: AuthorityCredential; revocation: AuthorityRevocation }, options: CommandOptions = {}) {
    await this.actor('users.manageRoles', options.timestamp)
    return this.commit({ eventType: 'ROLE_CHANGED', entityId: input.credential.subjectPublicIdentity, payload: { credential: input.credential, revocation: input.revocation }, ...options })
  }
  /** Publishes a new unit key generation: one wrapped copy per remaining member. The envelope is sealed under previousEpoch (see UnitEventSyncProvider). */
  async rotateUnitKey(input: { epochId: string; previousEpoch: string; reason: 'REVOCATION' | 'MANUAL'; grants: KeyGrantRecord[]; grantorEcdhPublicKey: string }, options: CommandOptions = {}) {
    await this.actor('users.revoke', options.timestamp)
    return this.commit({ eventType: 'UNIT_KEY_ROTATED', entityId: input.epochId, payload: { epochId: input.epochId, previousEpoch: input.previousEpoch, reason: input.reason, grants: input.grants, grantorEcdhPublicKey: input.grantorEcdhPublicKey }, ...options })
  }
  async registerRecoveryKey(input: { publicKey: string; fingerprint: string }, options: CommandOptions = {}) {
    await this.actor('users.authorize', options.timestamp)
    return this.commit({ eventType: 'RECOVERY_KEY_REGISTERED', entityId: `recovery:${input.fingerprint}`, payload: { publicKey: input.publicKey, fingerprint: input.fingerprint }, ...options })
  }

  // ---------- canonical fold ----------
  private applyEvent(state: RepositoryState, event: SignedArgusEvent) {
    const permission = PERMISSION_FOR[event.eventType]; if (permission) this.authorization.require(event.actorPublicIdentity, permission, event.timestamp)
    if (permission) {
      // Judged by position in the shared history, not only by the author-claimed timestamp: once a removal or role change is
      // folded, the author's later records are held to it, so a back-dated timestamp cannot slip work past it.
      const member = state.members.find(candidate => candidate.publicIdentity === event.actorPublicIdentity)
      if (member?.status === 'REVOKED') throw new Error('Recorded after the author’s access was removed.')
      if (member?.roleChangedAt && !ROLE_PERMISSIONS[member.role].includes(permission)) throw new Error(`Unauthorized: ${permission} is required.`)
    }
    switch (event.eventType) {
      case 'INVENTORY_ITEM_CREATED': {
        if (state.inventory.some(item => item.entityId === event.entityId)) throw new Error('Inventory item ID already exists.')
        const value = event.payload as Record<string, unknown>
        if (typeof value.name !== 'string' || !value.name.trim() || typeof value.category !== 'string' || !Number.isInteger(value.onHand) || Number(value.onHand) < 0) throw new Error('Corrupted inventory item event.')
        if (value.catalogId !== undefined && !state.catalog.some(item => item.catalogId === value.catalogId)) throw new Error('Catalog projection is missing.')
        state.inventory.push({ entityId: event.entityId, ...(typeof value.catalogId === 'string' ? { catalogId: value.catalogId } : {}), name: value.name, category: value.category, variant: typeof value.variant === 'string' ? value.variant : ONE_SIZE_LABEL, niin: typeof value.niin === 'string' ? value.niin : '', onHand: Number(value.onHand), issued: Number.isInteger(value.issued) ? Number(value.issued) : 0, ...(Number.isInteger(value.reorderAt) ? { reorderAt: Number(value.reorderAt) } : {}), countIncrement: Number.isInteger(value.countIncrement) && Number(value.countIncrement) > 0 ? Number(value.countIncrement) : 1, active: value.active !== false, version: 1, appliedEventIds: [event.eventId] })
        return
      }
      case 'INVENTORY_ITEM_UPDATED': {
        const item = state.inventory.find(candidate => candidate.entityId === event.entityId); if (!item) throw new Error('Inventory projection is missing.')
        const changes = pick<InventoryProjection>(event.payload, INVENTORY_EDITABLE); validateInventoryChanges(changes)
        if (event.baseVersion !== undefined && event.baseVersion !== item.version && concurrentEditOfSameFields(state, event, item.appliedEventIds)) { this.addConflict(state, event, 'Concurrent inventory metadata updates require reconciliation.'); return }
        Object.assign(item, changes); item.version++; item.appliedEventIds.push(event.eventId); return
      }
      case 'INVENTORY_RECEIVED': {
        const item = state.inventory.find(candidate => candidate.entityId === event.entityId); if (!item) throw new Error('Inventory projection is missing.')
        const quantity = event.payload.quantity; if (!Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_RECEIVE_QUANTITY) throw new Error('Corrupted receive quantity.')
        item.onHand += Number(quantity); item.version++; item.appliedEventIds.push(event.eventId); return
      }
      case 'CATALOG_ITEM_CREATED': {
        if (state.catalog.some(item => item.catalogId === event.entityId)) throw new Error('Catalog item ID already exists.')
        const value = event.payload as Partial<CatalogItemProjection>
        const item: CatalogItemProjection = { catalogId: event.entityId, name: String(value.name ?? ''), category: String(value.category ?? ''), niin: String(value.niin ?? ''), sized: value.sized === true, ...(typeof value.sizeScheme === 'string' ? { sizeScheme: value.sizeScheme } : {}), ...(Number.isInteger(value.reorderAt) ? { reorderAt: value.reorderAt } : {}), countIncrement: Number.isInteger(value.countIncrement) && Number(value.countIncrement) > 0 ? Number(value.countIncrement) : 1, active: true, origin: 'EVENT', version: 1, appliedEventIds: [event.eventId] }
        validateCatalog(item); state.catalog.push(item)
        if (!item.sized) state.inventory.push({ entityId: oneSizeVariantId(item.catalogId), catalogId: item.catalogId, name: item.name, category: item.category, variant: ONE_SIZE_LABEL, niin: item.niin, onHand: 0, issued: 0, ...(item.reorderAt === undefined ? {} : { reorderAt: item.reorderAt }), countIncrement: item.countIncrement, active: true, version: 1, appliedEventIds: [event.eventId] })
        return
      }
      case 'CATALOG_ITEM_UPDATED': {
        const item = state.catalog.find(candidate => candidate.catalogId === event.entityId); if (!item) throw new Error('Catalog projection is missing.')
        const changes = pick<CatalogItemProjection>(event.payload, CATALOG_EDITABLE); validateCatalog({ ...item, ...changes })
        Object.assign(item, changes); item.version++; item.appliedEventIds.push(event.eventId)
        for (const variant of state.inventory.filter(candidate => candidate.catalogId === item.catalogId)) { variant.name = item.name; variant.category = item.category; variant.niin = item.niin; variant.countIncrement = item.countIncrement; if (changes.active === false) variant.active = false; variant.version++; variant.appliedEventIds.push(event.eventId) }
        return
      }
      case 'CATALOG_SIZES_ADDED': {
        const item = state.catalog.find(candidate => candidate.catalogId === event.entityId); if (!item) throw new Error('Catalog projection is missing.'); if (!item.sized) throw new Error('Catalog item is not sized.')
        const sizes = event.payload.sizes; if (!Array.isArray(sizes) || !sizes.length || sizes.length > 200) throw new Error('Corrupted size list.')
        const parsed = sizes.map(size => { const value = size as { itemId?: unknown; label?: unknown }; if (typeof value.itemId !== 'string' || !value.itemId || typeof value.label !== 'string') throw new Error('Corrupted size list.'); return { itemId: value.itemId, label: normalizeSizeLabel(value.label) } })
        if (new Set(parsed.map(size => size.itemId)).size !== parsed.length) throw new Error('Corrupted size list.')
        const existing = new Set(state.inventory.filter(variant => variant.catalogId === item.catalogId).map(variant => variant.variant.toLowerCase()))
        for (const size of parsed) {
          // A concurrent device may already have added the same size label; the first in canonical order wins and later duplicates are skipped.
          if (existing.has(size.label.toLowerCase()) || state.inventory.some(variant => variant.entityId === size.itemId)) continue
          existing.add(size.label.toLowerCase())
          state.inventory.push({ entityId: size.itemId, catalogId: item.catalogId, name: item.name, category: item.category, variant: size.label, niin: item.niin, onHand: 0, issued: 0, ...(item.reorderAt === undefined ? {} : { reorderAt: item.reorderAt }), countIncrement: item.countIncrement, active: true, version: 1, appliedEventIds: [event.eventId] })
        }
        item.appliedEventIds.push(event.eventId); return
      }
      case 'ITEM_ISSUED': case 'ITEM_RETURNED': {
        if (Array.isArray(event.payload.lines)) { this.applySupplyTransaction(state, event); return }
        const item = state.inventory.find(i => i.entityId === event.entityId); if (!item) throw new Error('Inventory projection is missing.')
        if (item.appliedEventIds.includes(event.eventId)) return
        const quantity = event.payload.quantity; if (!Number.isInteger(quantity) || Number(quantity) <= 0) throw new Error('Corrupted event quantity.')
        const delta = event.eventType === 'ITEM_ISSUED' ? -Number(quantity) : Number(quantity)
        if (item.onHand + delta < 0 || item.issued - delta < 0) {
          const related = state.events.filter(e => e.event.entityId === event.entityId && e.event.eventType === 'ITEM_ISSUED' && (item.appliedEventIds.includes(e.event.eventId) || e.event.eventId === event.eventId)).map(e => e.event.eventId)
          const eventIds = [...new Set([...related, event.eventId])].sort()
          const conflict: ConflictRecord = { id: `conflict:${eventIds.join(':')}`, entityId: event.entityId, eventIds, status: 'OPEN', reason: `Concurrent events attempted to consume unavailable ${item.name}.` }
          if (!state.conflicts.some(c => c.id === conflict.id)) state.conflicts.push(conflict)
          return
        }
        item.onHand += delta; item.issued = Math.max(0, (item.issued ?? 0) - delta); item.version += 1; item.appliedEventIds.push(event.eventId); return
      }
      case 'COUNT_SESSION_CREATED': {
        if (state.countSessions.some(session => session.sessionId === event.entityId)) throw new Error('Count session ID already exists.')
        const payload = event.payload as { scope?: unknown; assignments?: unknown; baseline?: unknown }
        const assignments = (payload.assignments ?? []) as CountAssignment[]
        if (typeof payload.scope !== 'string' || !Array.isArray(assignments)) throw new Error('Corrupted count session event.')
        if (new Set(assignments.map(a => a.assignmentId)).size !== assignments.length || assignments.some(a => !a.assignmentId || !a.itemId || !a.scope || !state.inventory.some(i => i.entityId === a.itemId))) throw new Error('Corrupted count assignments.')
        // The baseline is taken from the canonical fold at this point, so every device derives the same one without carrying it on chain.
        const baseline = payload.baseline && typeof payload.baseline === 'object' ? payload.baseline as CountSessionProjection['baseline'] : Object.fromEntries(state.inventory.filter(item => item.active).map(item => [item.entityId, { quantity: item.onHand, inventoryVersion: item.version }]))
        state.countSessions.push({ sessionId: event.entityId, scope: payload.scope, status: 'ACTIVE', createdBy: event.actorPublicIdentity, createdAt: event.timestamp, baseline: structuredClone(baseline), assignments: structuredClone(assignments), participants: [], observations: [], totals: {}, lateEventIds: [], appliedEventIds: [event.eventId] })
        return
      }
      case 'COUNT_CONTRIBUTED': case 'COUNT_RECOUNTED': case 'COUNT_CORRECTED': case 'COUNT_SESSION_SUBMITTED': this.applyCountEvent(state, event); return
      case 'COUNT_SESSION_CANCELLED': { const session = state.countSessions.find(s => s.sessionId === event.entityId); if (!session || session.status === 'RECONCILED') throw new Error('Count session cannot be cancelled.'); session.status = 'CANCELLED'; session.appliedEventIds.push(event.eventId); return }
      case 'COUNT_SESSION_RECONCILED': this.applyCountReconciliation(state, event); return
      case 'INVENTORY_COUNT_SUBMITTED': { const item = state.inventory.find(i => i.entityId === event.entityId); const counted = event.payload.countedQuantity; if (!item || !Number.isInteger(counted) || Number(counted) < 0) throw new Error('Corrupted count event.'); if (event.baseVersion !== item.version) this.addConflict(state, event, 'Physical count was based on a stale inventory version.'); else { item.onHand = Number(counted); item.version++; item.appliedEventIds.push(event.eventId) } return }
      case 'CADET_CREATED': {
        const value = pick<CadetProjection & { cadetCode: string }>(event.payload, ['fullName', 'gender', 'nsLevel', 'status', 'sizes', 'cadetCode']) as Pick<CadetProjection, 'fullName'|'gender'|'nsLevel'|'status'|'sizes'> & { cadetCode?: string }
        const cadet = { fullName: typeof value.fullName === 'string' ? value.fullName : '', gender: value.gender, nsLevel: value.nsLevel, status: value.status, sizes: value.sizes ?? {}, ...(typeof value.cadetCode === 'string' ? { cadetCode: value.cadetCode } : {}) }
        validateCadet(cadet); if (state.cadets.some(c => c.cadetId === event.entityId)) throw new Error('Cadet ID already exists.')
        // Two offline devices can draw the same random code; the later one in canonical order gets a deterministic suffix instead of a silent duplicate.
        if (cadet.cadetCode && state.cadets.some(c => c.cadetCode === cadet.cadetCode)) cadet.cadetCode = `${cadet.cadetCode}${event.eventId.replace(/[^0-9A-Z]/gi, '').slice(0, 2).toUpperCase()}`.slice(0, 8)
        state.cadets.push({ cadetId: event.entityId, ...cadet, currentProperty: [], createdAt: event.timestamp, updatedAt: event.timestamp, version: 1, appliedEventIds: [event.eventId] }); return
      }
      case 'CADET_UPDATED': {
        const cadet = state.cadets.find(c => c.cadetId === event.entityId); if (!cadet) throw new Error('Cadet projection is missing.')
        const changes = pick<CadetProjection>(event.payload, CADET_EDITABLE)
        // Issues and returns bump the cadet version too; only a concurrent profile edit of the same fields is a real conflict.
        if (event.baseVersion !== cadet.version && concurrentEditOfSameFields(state, event, cadet.appliedEventIds)) { this.addConflict(state, event, 'Concurrent cadet updates require reconciliation.'); return }
        validateCadet({ ...cadet, ...changes }); Object.assign(cadet, changes, { updatedAt: event.timestamp, version: cadet.version + 1 }); cadet.appliedEventIds.push(event.eventId); return
      }
      case 'BUNDLE_UPDATED': { const bundle = state.bundles.find(b => b.bundleId === event.entityId); if (!bundle) throw new Error('Bundle projection is missing.'); if (event.baseVersion !== bundle.currentVersion) { this.addConflict(state, event, 'Concurrent bundle edits require reconciliation.'); return } const version = { ...(event.payload as unknown as Omit<BundleVersionProjection,'bundleId'|'version'|'createdAt'|'actorPublicIdentity'|'priorVersion'|'eventId'>), bundleId: bundle.bundleId, version: bundle.currentVersion + 1, createdAt: event.timestamp, actorPublicIdentity: event.actorPublicIdentity, priorVersion: bundle.currentVersion, eventId: event.eventId }; validateBundle(version); bundle.versions.push(version); bundle.currentVersion++; bundle.appliedEventIds.push(event.eventId); return }
      case 'BUNDLE_CREATED': { const value = event.payload as unknown as Omit<BundleVersionProjection,'bundleId'|'version'|'createdAt'|'actorPublicIdentity'|'priorVersion'|'eventId'>; const version = { ...value, bundleId: event.entityId, version: 1, createdAt: event.timestamp, actorPublicIdentity: event.actorPublicIdentity, eventId: event.eventId }; validateBundle(version, state.inventory); if (state.bundles.some(b => b.bundleId === event.entityId)) throw new Error('Bundle ID already exists.'); state.bundles.push({ bundleId: event.entityId, currentVersion: 1, versions: [version], appliedEventIds: [event.eventId] }); return }
      case 'STILL_NEEDED_ADDED': { const value = event.payload as unknown as Omit<StillNeededProjection,'requirementId'|'version'|'appliedEventIds'|'updatedAt'>; validateRequirement(value); if (!state.cadets.some(c => c.cadetId === value.cadetId)) throw new Error('Cadet projection is missing.'); if (state.stillNeeded.some(r => r.requirementId === event.entityId)) throw new Error('Still Needed ID already exists.'); state.stillNeeded.push({ ...value, requirementId: event.entityId, updatedAt: event.timestamp, version: 1, appliedEventIds: [event.eventId] }); return }
      case 'STILL_NEEDED_UPDATED': case 'STILL_NEEDED_CANCELLED': case 'STILL_NEEDED_FULFILLED': {
        const requirement = state.stillNeeded.find(r => r.requirementId === event.entityId); if (!requirement) throw new Error('Still Needed projection is missing.')
        if (event.baseVersion !== requirement.version) { this.addConflict(state, event, 'Concurrent Still Needed updates require reconciliation.'); return }
        const changes = pick<StillNeededProjection>(event.payload, NEED_EDITABLE); validateRequirement({ ...requirement, ...changes }); Object.assign(requirement, changes, { updatedAt: event.timestamp, version: requirement.version + 1 }); requirement.appliedEventIds.push(event.eventId); return
      }
      case 'CONFLICT_RESOLVED': { const conflict = state.conflicts.find(c => c.id === event.payload.conflictId); if (conflict) { conflict.status = 'RESOLVED'; conflict.resolutionEventId = event.eventId } return }
      case 'AUTHORITY_GRANTED': {
        const credential = event.payload.credential as AuthorityCredential | undefined, displayName = event.payload.displayName
        if (!credential || credential.subjectPublicIdentity !== event.entityId || typeof displayName !== 'string' || !displayName.trim()) throw new Error('Corrupted admission event.')
        if (!this.authorization.credentialFor(credential.subjectPublicIdentity, credential.issuedAt) && credential.subjectPublicIdentity !== event.actorPublicIdentity) throw new Error('Admission credential has not been verified.')
        const previous = state.members.find(existing => existing.publicIdentity === credential.subjectPublicIdentity)
        const ecdhPublicKey = typeof event.payload.ecdhPublicKey === 'string' ? event.payload.ecdhPublicKey : previous?.ecdhPublicKey
        const member = { publicIdentity: credential.subjectPublicIdentity, displayName: displayName.trim().slice(0, 60), role: credential.role, credentialId: credential.credentialId, credentialEventId: event.eventId, issuedAt: credential.issuedAt, ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}), ...(typeof event.payload.walletAddress === 'string' ? { walletAddress: event.payload.walletAddress } : {}), ...(ecdhPublicKey ? { ecdhPublicKey } : {}), admittedBy: event.actorPublicIdentity, admittedEventId: event.eventId, status: 'ACTIVE' as const }
        state.members = [...state.members.filter(existing => existing.publicIdentity !== member.publicIdentity), member]; return
      }
      case 'AUTHORITY_REVOKED': {
        const revocation = event.payload.revocation as AuthorityRevocation | undefined; if (!revocation || revocation.subjectPublicIdentity !== event.entityId) throw new Error('Corrupted revocation event.')
        // Revoking a credential the member no longer uses (replaced by a role change) does not remove them.
        const member = state.members.find(candidate => candidate.publicIdentity === event.entityId); if (member && member.credentialId === revocation.credentialId) { member.status = 'REVOKED'; member.revokedAt = revocation.effectiveAt } return
      }
      case 'ROLE_CHANGED': {
        const credential = event.payload.credential as AuthorityCredential | undefined, revocation = event.payload.revocation as AuthorityRevocation | undefined
        if (!credential || !revocation || credential.subjectPublicIdentity !== event.entityId || revocation.subjectPublicIdentity !== event.entityId) throw new Error('Corrupted role change event.')
        const member = state.members.find(candidate => candidate.publicIdentity === event.entityId)
        if (!member || member.status !== 'ACTIVE') throw new Error('Role change for someone who is not an active member.')
        if (revocation.credentialId !== member.credentialId) throw new Error('Role change does not replace the member’s current credential.')
        if (!this.authorization.hasCredential(credential.credentialId)) throw new Error('New role credential has not been verified.')
        Object.assign(member, { role: credential.role, credentialId: credential.credentialId, credentialEventId: event.eventId, issuedAt: credential.issuedAt, roleChangedAt: event.timestamp })
        if (credential.expiresAt) member.expiresAt = credential.expiresAt; else delete member.expiresAt
        return
      }
      case 'UNIT_KEY_ROTATED': {
        const value = event.payload as { epochId?: unknown; previousEpoch?: unknown; reason?: unknown; grants?: unknown; grantorEcdhPublicKey?: unknown }
        if (typeof value.epochId !== 'string' || value.epochId !== event.entityId || !EPOCH_ID_PATTERN.test(value.epochId) || typeof value.previousEpoch !== 'string' || !EPOCH_ID_PATTERN.test(value.previousEpoch) || (value.reason !== 'REVOCATION' && value.reason !== 'MANUAL') || typeof value.grantorEcdhPublicKey !== 'string' || !Array.isArray(value.grants) || !value.grants.length) throw new Error('Corrupted key rotation event.')
        if (state.keyEpochs.some(epoch => epoch.epochId === value.epochId)) throw new Error('Unit key generation already exists.')
        const grants = value.grants.map(grant => parseKeyGrantRecord(grant))
        if (grants.some(grant => grant.epochId !== value.epochId || grant.organizationId !== this.organizationId || grant.grantorPublicIdentity !== event.actorPublicIdentity)) throw new Error('Key rotation contains a foreign key grant.')
        state.keyEpochs.push({ epochId: value.epochId, previousEpoch: value.previousEpoch, reason: value.reason, rotatedBy: event.actorPublicIdentity, rotatedAt: event.timestamp, eventId: event.eventId, recipients: [...new Set(grants.map(grant => grant.granteePublicIdentity))].sort() })
        return
      }
      case 'RECOVERY_KEY_REGISTERED': {
        const { publicKey, fingerprint } = event.payload as { publicKey?: unknown; fingerprint?: unknown }
        if (typeof publicKey !== 'string' || typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint) || event.entityId !== `recovery:${fingerprint}`) throw new Error('Corrupted recovery key event.')
        state.recoveryKey = { publicKey, fingerprint, registeredBy: event.actorPublicIdentity, registeredAt: event.timestamp, eventId: event.eventId }
        return
      }
      case 'CALENDAR_EVENT_CREATED': {
        if (state.calendar.some(candidate => candidate.calendarEventId === event.entityId)) throw new Error('Supply event ID already exists.')
        const value = event.payload as Partial<CalendarEventProjection>
        const created: CalendarEventProjection = { calendarEventId: event.entityId, kind: value.kind as SupplyEventKind, title: String(value.title ?? ''), startsAt: String(value.startsAt ?? ''), ...(typeof value.notes === 'string' ? { notes: value.notes } : {}), bundleIds: Array.isArray(value.bundleIds) ? [...new Set(value.bundleIds.filter((id): id is string => typeof id === 'string'))] : [], cadetIds: Array.isArray(value.cadetIds) ? sortedUnique(value.cadetIds.filter((id): id is string => typeof id === 'string')) : [], tasks: (Array.isArray(value.tasks) ? value.tasks : []).map(task => ({ taskId: String(task.taskId), title: String(task.title), dueOffsetDays: Number(task.dueOffsetDays), completed: false })), active: true, createdBy: event.actorPublicIdentity, createdAt: event.timestamp, version: 1, appliedEventIds: [event.eventId] }
        validateCalendar(created); if (new Set(created.tasks.map(task => task.taskId)).size !== created.tasks.length) throw new Error('Corrupted task list.')
        state.calendar.push(created); return
      }
      case 'CALENDAR_EVENT_UPDATED': {
        const target = state.calendar.find(candidate => candidate.calendarEventId === event.entityId); if (!target) throw new Error('Calendar projection is missing.')
        const changes = pick<CalendarEventProjection>(event.payload, CALENDAR_EDITABLE); validateCalendar({ ...target, ...changes }); validateActive(changes)
        const scalars = CALENDAR_SCALARS.filter(field => field in changes), base = event.payload.baseRevisions
        if (base !== undefined) {
          if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('Corrupted calendar update.')
          // Same field, different value, and the author had seen none of the edits that produced the current value: a real concurrent edit.
          const seen = (field: CalendarScalarField) => { const ids = (base as Record<string, unknown>)[field]; return Array.isArray(ids) ? ids : [] }
          const contested = scalars.filter(field => !sameScalar(target[field], changes[field]) && !fieldWriters(target, field).some(id => seen(field).includes(id)))
          if (contested.length) { this.addCalendarConflict(state, event, target, contested); return }
        } else if (event.baseVersion !== undefined && event.baseVersion !== target.version && concurrentEditOfSameFields(state, event, target.appliedEventIds)) { this.addCalendarConflict(state, event, target, scalars); return }
        const revisions: CalendarFieldRevisions = { ...target.fieldRevisions }
        for (const field of scalars) revisions[field] = sameScalar(target[field], changes[field]) ? [...new Set([...fieldWriters(target, field), event.eventId])] : [event.eventId]
        if (changes.cadetIds) changes.cadetIds = sortedUnique(changes.cadetIds)
        Object.assign(target, changes); if (scalars.length) target.fieldRevisions = revisions
        target.version++; target.appliedEventIds.push(event.eventId); return
      }
      case 'CALENDAR_ATTENDEES_ADDED': case 'CALENDAR_ATTENDEES_REMOVED': {
        const target = state.calendar.find(candidate => candidate.calendarEventId === event.entityId); if (!target) throw new Error('Calendar projection is missing.')
        const ids = setPayload(event, 'cadetIds', MAX_EVENT_CADETS)
        if (event.eventType === 'CALENDAR_ATTENDEES_ADDED') {
          const known = new Set(state.cadets.map(cadet => cadet.cadetId)); if (ids.some(id => !known.has(id))) throw new Error('Cadet projection is missing.')
          const next = sortedUnique([...target.cadetIds, ...ids]); if (next.length > MAX_EVENT_CADETS) throw new Error(`An event can have at most ${MAX_EVENT_CADETS} attendees.`)
          target.cadetIds = next
        } else target.cadetIds = target.cadetIds.filter(id => !ids.includes(id))
        target.version++; target.appliedEventIds.push(event.eventId); return
      }
      case 'CALENDAR_BUNDLES_ADDED': case 'CALENDAR_BUNDLES_REMOVED': {
        const target = state.calendar.find(candidate => candidate.calendarEventId === event.entityId); if (!target) throw new Error('Calendar projection is missing.')
        const ids = setPayload(event, 'bundleIds', MAX_EVENT_BUNDLES)
        if (event.eventType === 'CALENDAR_BUNDLES_ADDED') {
          if (ids.some(id => !state.bundles.some(bundle => bundle.bundleId === id))) throw new Error('Bundle projection is missing.')
          // Linked bundles keep the order they were added in (template order first); the canonical fold makes that order the same everywhere.
          const next = [...new Set([...target.bundleIds, ...ids])]; if (next.length > MAX_EVENT_BUNDLES) throw new Error(`An event can link at most ${MAX_EVENT_BUNDLES} bundles.`)
          target.bundleIds = next
        } else target.bundleIds = target.bundleIds.filter(id => !ids.includes(id))
        target.version++; target.appliedEventIds.push(event.eventId); return
      }
      case 'CALENDAR_TASK_UPDATED': {
        const target = state.calendar.find(candidate => candidate.calendarEventId === event.entityId), taskId = event.payload.taskId
        const task = target?.tasks.find(candidate => candidate.taskId === taskId) ?? target?.removedTasks?.find(candidate => candidate.taskId === taskId)
        if (!target || !task) throw new Error('Calendar projection is missing.')
        const { title, dueOffsetDays } = event.payload
        if ((title !== undefined && typeof title !== 'string') || (dueOffsetDays !== undefined && typeof dueOffsetDays !== 'number') || (title === undefined && dueOffsetDays === undefined)) throw new Error('Corrupted task update.')
        const changes = { ...(typeof title === 'string' ? { title: title.trim() } : {}), ...(typeof dueOffsetDays === 'number' ? { dueOffsetDays } : {}) }
        validateTask({ ...task, ...changes }); Object.assign(task, changes) // completion (who, when) is untouched
        target.version++; target.appliedEventIds.push(event.eventId); return
      }
      case 'CALENDAR_TASK_REMOVED': {
        const target = state.calendar.find(candidate => candidate.calendarEventId === event.entityId); if (!target) throw new Error('Calendar projection is missing.')
        const index = target.tasks.findIndex(candidate => candidate.taskId === event.payload.taskId)
        if (index < 0) { if (target.removedTasks?.some(candidate => candidate.taskId === event.payload.taskId)) { target.version++; target.appliedEventIds.push(event.eventId); return } throw new Error('Calendar projection is missing.') }
        const [task] = target.tasks.splice(index, 1)
        target.removedTasks = [...(target.removedTasks ?? []), { ...task, removedBy: event.actorPublicIdentity, removedAt: event.timestamp }]
        target.version++; target.appliedEventIds.push(event.eventId); return
      }
      case 'CALENDAR_TASK_ADDED': {
        const target = state.calendar.find(candidate => candidate.calendarEventId === event.entityId); if (!target) throw new Error('Calendar projection is missing.')
        const task: CalendarTaskProjection = { taskId: String(event.payload.taskId), title: String(event.payload.title ?? ''), dueOffsetDays: Number(event.payload.dueOffsetDays), completed: false }
        validateTask(task); if (target.tasks.some(existing => existing.taskId === task.taskId)) throw new Error('Task ID already exists.')
        target.tasks.push(task); target.version++; target.appliedEventIds.push(event.eventId); return
      }
      case 'TASK_COMPLETED': {
        const target = state.calendar.find(candidate => candidate.calendarEventId === event.entityId), task = target?.tasks.find(candidate => candidate.taskId === event.payload.taskId) ?? target?.removedTasks?.find(candidate => candidate.taskId === event.payload.taskId)
        if (!target || !task) throw new Error('Calendar projection is missing.')
        task.completed = event.payload.completed !== false
        if (task.completed) { task.completedBy = event.actorPublicIdentity; task.completedAt = event.timestamp } else { delete task.completedBy; delete task.completedAt }
        target.version++; target.appliedEventIds.push(event.eventId); return
      }
      case 'PROPERTY_CORRECTED': {
        const cadet = state.cadets.find(candidate => candidate.cadetId === event.entityId); if (!cadet) throw new Error('Cadet projection is missing.')
        const { propertyId, fromItemId, toItemId, reason, originalEventId } = event.payload, quantity = Number(event.payload.quantity)
        const property = cadet.currentProperty.find(candidate => candidate.propertyId === propertyId)
        const from = state.inventory.find(item => item.entityId === fromItemId), to = state.inventory.find(item => item.entityId === toItemId)
        if (!from || !to || typeof reason !== 'string' || !Number.isInteger(quantity) || quantity < 1) throw new Error('Corrupted correction event.')
        // Impossible physical states become visible conflicts, exactly like a concurrent issue of the last unit.
        if (!property || property.itemId !== from.entityId || property.quantity < quantity || !to.active || to.onHand < quantity) { this.addSupplyConflict(state, event, cadet.cadetId, [{ line: { lineId: 'correction', itemId: to.entityId, label: to.name, variant: to.variant, quantity, baseVersion: to.version }, item: to }], 'A size correction referenced property or stock that was no longer available.'); return }
        from.onHand += quantity; from.issued = Math.max(0, from.issued - quantity); from.version++; from.appliedEventIds.push(event.eventId)
        to.onHand -= quantity; to.issued += quantity; to.version++; to.appliedEventIds.push(event.eventId)
        if (quantity === property.quantity) Object.assign(property, { itemId: to.entityId, label: to.name, variant: to.variant })
        else { property.quantity -= quantity; cadet.currentProperty.push({ ...property, propertyId: `${event.eventId}:corrected`, itemId: to.entityId, label: to.name, variant: to.variant, quantity }) }
        cadet.version++; cadet.updatedAt = event.timestamp; cadet.appliedEventIds.push(event.eventId)
        state.corrections.push({ correctionId: event.eventId, cadetId: cadet.cadetId, propertyId: String(propertyId), originalEventId: String(originalEventId ?? ''), fromItemId: from.entityId, toItemId: to.entityId, quantity, reason, actor: event.actorPublicIdentity, at: event.timestamp, eventId: event.eventId })
        return
      }
      case 'ANNUAL_ROLLOVER_COMPLETED': {
        const schoolYear = String(event.payload.schoolYear ?? '')
        if (!/^\d{4}-\d{4}$/.test(schoolYear)) throw new Error('Corrupted rollover event.')
        if (state.rollovers.some(record => record.schoolYear === schoolYear)) throw new Error(`Rollover for ${schoolYear} is already complete.`)
        let advanced = 0, graduated = 0
        const chosen = Array.isArray(event.payload.cadetIds) ? new Set(event.payload.cadetIds.filter((id): id is string => typeof id === 'string')) : undefined
        for (const cadet of state.cadets.filter(candidate => candidate.status === 'ACTIVE' && (!chosen || chosen.has(candidate.cadetId)))) {
          const next = NEXT_LEVEL[cadet.nsLevel]
          if (next === 'GRADUATED') { cadet.status = 'INACTIVE'; graduated++ } else { cadet.nsLevel = next; advanced++ }
          cadet.version++; cadet.updatedAt = event.timestamp; cadet.appliedEventIds.push(event.eventId)
        }
        state.rollovers.push({ schoolYear, eventId: event.eventId, at: event.timestamp, actor: event.actorPublicIdentity, advanced, graduated }); return
      }
      case 'CADETS_IMPORTED': {
        const rows = event.payload.cadets; if (!Array.isArray(rows) || !rows.length || rows.length > MAX_IMPORT_CADETS) throw new Error('Corrupted cadet import.')
        const parsed = rows.map(row => { const value = row as Record<string, unknown>; const cadet = { cadetId: String(value.cadetId ?? ''), fullName: typeof value.fullName === 'string' ? value.fullName : '', gender: value.gender as CadetProjection['gender'], nsLevel: value.nsLevel as NsLevel, status: 'ACTIVE' as const, sizes: (value.sizes && typeof value.sizes === 'object' ? value.sizes : {}) as Record<string, string>, ...(typeof value.cadetCode === 'string' ? { cadetCode: value.cadetCode } : {}) }; if (!cadet.cadetId) throw new Error('Corrupted cadet import.'); validateCadet(cadet); return cadet })
        for (const cadet of parsed) {
          if (state.cadets.some(existing => existing.cadetId === cadet.cadetId)) continue
          if (cadet.cadetCode && state.cadets.some(existing => existing.cadetCode === cadet.cadetCode)) cadet.cadetCode = `${cadet.cadetCode}${event.eventId.replace(/[^0-9A-Z]/gi, '').slice(0, 2).toUpperCase()}`.slice(0, 8)
          state.cadets.push({ ...cadet, currentProperty: [], createdAt: event.timestamp, updatedAt: event.timestamp, version: 1, appliedEventIds: [event.eventId] })
        }
        return
      }
      default: return // RECORD_CORRECTED and other audit-only events are retained in history without changing projections.
    }
  }
  private applyCountEvent(state: RepositoryState, event: SignedArgusEvent) {
    const session = state.countSessions.find(s => s.sessionId === event.entityId)
    if (!session) throw new Error('Count session dependency is missing.')
    if (session.status === 'CANCELLED') throw new Error('Count session is closed.')
    const frozen = Boolean(session.acceptedEventIds)
    if (event.eventType === 'COUNT_CONTRIBUTED' || event.eventType === 'COUNT_RECOUNTED') {
      const { itemId, quantity } = event.payload, assignmentId = event.payload.assignmentId
      if (typeof itemId !== 'string' || !Number.isInteger(quantity) || Number(quantity) < 0 || Number(quantity) > MAX_COUNT_QUANTITY) throw new Error('Corrupted count contribution.')
      if (assignmentId !== undefined) { const assignment = session.assignments.find(a => a.assignmentId === assignmentId); if (!assignment || assignment.itemId !== itemId) throw new Error('Corrupted count contribution.') }
      else if (!state.inventory.some(item => item.entityId === itemId)) throw new Error('Inventory projection is missing.')
      const supersedes = event.eventType === 'COUNT_RECOUNTED' && Array.isArray(event.payload.supersedesEventIds) ? event.payload.supersedesEventIds as string[] : []
      const observation: CountObservation = { eventId: event.eventId, itemId, assignmentId: typeof assignmentId === 'string' ? assignmentId : '', actorPublicIdentity: event.actorPublicIdentity, quantity: Number(quantity), effectiveQuantity: Number(quantity), status: frozen && !session.acceptedEventIds!.includes(event.eventId) ? 'LATE' : 'ACCEPTED', ...(typeof event.payload.note === 'string' ? { note: event.payload.note } : {}), timestamp: event.timestamp }
      if (observation.status !== 'LATE') for (const prior of session.observations) if (supersedes.includes(prior.eventId) && prior.status !== 'LATE') prior.status = 'SUPERSEDED'
      session.observations.push(observation)
    } else if (event.eventType === 'COUNT_CORRECTED') {
      const original = session.observations.find(o => o.eventId === event.payload.originalEventId), replacement = event.payload.replacementQuantity
      if (!original || !Number.isInteger(replacement) || Number(replacement) < 0 || Number(replacement) > MAX_COUNT_QUANTITY) throw new Error('Corrupted or missing count correction dependency.')
      if (frozen) return // corrections after the cutoff are retained as history but cannot change a frozen total
      original.effectiveQuantity = Number(replacement); if (original.status === 'ACCEPTED') original.status = 'CORRECTED'
    } else {
      const accepted = event.payload.acceptedEventIds
      if (!Array.isArray(accepted) || accepted.some(id => typeof id !== 'string')) throw new Error('Corrupted count-session cutoff.')
      if (session.status === 'RECONCILED') throw new Error('Count session is closed.')
      if ((accepted as string[]).some(id => !session.observations.some(o => o.eventId === id))) throw new Error('Count session dependency is missing.')
      session.status = 'SUBMITTED'; session.acceptedEventIds = [...new Set(accepted as string[])].sort()
      for (const observation of session.observations) if (!session.acceptedEventIds.includes(observation.eventId)) observation.status = 'LATE'
    }
    this.refreshCountSession(session)
    if (!session.appliedEventIds.includes(event.eventId)) session.appliedEventIds.push(event.eventId)
  }
  private refreshCountSession(session: CountSessionProjection) {
    session.observations.sort((a, b) => a.eventId.localeCompare(b.eventId))
    session.totals = totalsFor(session.observations)
    session.participants = [...new Set(session.observations.map(o => o.actorPublicIdentity))].sort()
    session.lateEventIds = session.observations.filter(o => o.status === 'LATE').map(o => o.eventId)
  }
  private applyCountReconciliation(state: RepositoryState, event: SignedArgusEvent) {
    const session = state.countSessions.find(s => s.sessionId === event.entityId)
    if (!session) throw new Error('Count session dependency is missing.')
    if (!['ACTIVE', 'SUBMITTED'].includes(session.status) || session.reconciledEventId) throw new Error('Count session is not ready for reconciliation.')
    const accepted = event.payload.acceptedEventIds
    if (!Array.isArray(accepted) || accepted.some(id => typeof id !== 'string')) throw new Error('Corrupted count-session cutoff.')
    const acceptedIds = new Set(accepted as string[])
    if ([...acceptedIds].some(id => !session.observations.some(o => o.eventId === id))) throw new Error('Count session dependency is missing.')
    if (session.acceptedEventIds && canonicalize([...acceptedIds].sort()) !== canonicalize(session.acceptedEventIds)) throw new Error('Count reconciliation does not match the accepted cutoff.')
    const totals = totalsFor(session.observations, acceptedIds)
    if (canonicalize(event.payload.totals) !== canonicalize(totals)) throw new Error('Count reconciliation does not match the accepted cutoff.')
    const missingItems = Object.keys(totals).filter(itemId => !state.inventory.some(i => i.entityId === itemId)); if (missingItems.length) throw new Error('Counted inventory projection is missing.')
    session.acceptedEventIds = [...acceptedIds].sort()
    for (const observation of session.observations) if (!acceptedIds.has(observation.eventId)) observation.status = 'LATE'
    session.movementWarnings = Object.keys(totals).filter(itemId => { const baseline = session.baseline[itemId], item = state.inventory.find(i => i.entityId === itemId)!; return baseline !== undefined && item.version !== baseline.inventoryVersion })
    for (const [itemId, total] of Object.entries(totals)) { const item = state.inventory.find(i => i.entityId === itemId)!; item.onHand = total; item.version++; item.appliedEventIds.push(event.eventId) }
    session.status = 'RECONCILED'; session.reconciledEventId = event.eventId; session.reconciledBy = event.actorPublicIdentity; session.reconciledAt = event.timestamp; session.appliedEventIds.push(event.eventId)
    this.refreshCountSession(session); session.totals = totals
  }
  private applySupplyTransaction(state: RepositoryState, event: SignedArgusEvent) {
    const payload = event.payload as { transactionId?: unknown; cadetId?: unknown; lines?: unknown; missingLines?: unknown; bundleId?: unknown; bundleVersion?: unknown; bundleSnapshot?: unknown }
    if (typeof payload.transactionId !== 'string' || payload.transactionId !== event.entityId || typeof payload.cadetId !== 'string' || !Array.isArray(payload.lines)) throw new Error('Malformed supply transaction event.')
    const existing = state.transactions.find(transaction => transaction.transactionId === payload.transactionId)
    if (existing) { if (existing.eventId !== event.eventId) throw new Error('Transaction ID collision detected.'); return }
    const cadet = state.cadets.find(candidate => candidate.cadetId === payload.cadetId); if (!cadet) throw new Error('Cadet projection is missing.')
    const lines = payload.lines as SupplyTransactionLine[], missing = payload.missingLines === undefined ? [] : payload.missingLines as MissingIssueLine[]
    if (!Array.isArray(missing)) throw new Error('Malformed missing-lines payload.')
    this.validateDraftIdentity(payload.transactionId, lines, missing)
    // Labels/variants in the line are a historical snapshot; a later rename must not invalidate an offline issue, so only the SKU reference is authoritative.
    const resolved = lines.map(line => { this.validateQuantity(line.quantity); if (!line.itemId || typeof line.label !== 'string') throw new Error('Malformed supply transaction line.'); const item = state.inventory.find(candidate => candidate.entityId === line.itemId); if (!item) throw new Error('Inventory projection is missing.'); return { line, item } })
    for (const line of missing) { if (!line.required || !line.lineId || !line.label) throw new Error('Malformed missing issue line.'); this.validateQuantity(line.quantity) }
    const bundleSnapshot = payload.bundleSnapshot as BundleVersionProjection | undefined
    if ((payload.bundleId === undefined) !== (payload.bundleVersion === undefined) || (payload.bundleId !== undefined && (typeof payload.bundleId !== 'string' || !Number.isInteger(payload.bundleVersion) || !bundleSnapshot || bundleSnapshot.bundleId !== payload.bundleId || bundleSnapshot.version !== payload.bundleVersion))) throw new Error('Malformed bundle transaction snapshot.')
    // Conflicts are about impossible physical states only: stock that is not there, or property the cadet no longer holds.
    if (event.eventType === 'ITEM_ISSUED' && (cadet.status !== 'ACTIVE' || resolved.some(({ line, item }) => !item.active || item.onHand < line.quantity))) { this.addSupplyConflict(state, event, payload.cadetId, resolved.filter(({ line, item }) => !item.active || item.onHand < line.quantity), cadet.status !== 'ACTIVE' ? 'Issue transaction targeted a cadet who was made inactive.' : undefined); return }
    if (event.eventType === 'ITEM_RETURNED' && resolved.some(({ line, item }) => { const property = cadet.currentProperty.find(candidate => candidate.propertyId === line.propertyId); return !property || property.itemId !== item.entityId || property.quantity < line.quantity })) { this.addSupplyConflict(state, event, payload.cadetId, resolved, 'Concurrent return transaction referenced property the cadet no longer holds.'); return }
    if (event.eventType === 'ITEM_ISSUED') {
      for (const { line, item } of resolved) { item.onHand -= line.quantity; item.issued += line.quantity; item.version++; item.appliedEventIds.push(event.eventId); const requirement = state.stillNeeded.find(candidate => candidate.cadetId === cadet.cadetId && candidate.itemId === item.entityId && candidate.size === item.variant && !['FULFILLED','CANCELLED'].includes(candidate.status) && (!line.requirementId || candidate.requirementId === line.requirementId)); if (requirement) { requirement.quantityFulfilled = Math.min(requirement.quantityNeeded, requirement.quantityFulfilled + line.quantity); requirement.status = requirement.quantityFulfilled === requirement.quantityNeeded ? 'FULFILLED' : 'PARTIALLY_FULFILLED'; requirement.updatedAt = event.timestamp; requirement.version++; requirement.appliedEventIds.push(event.eventId) } cadet.currentProperty.push({ propertyId: `${event.eventId}:${line.lineId}`, itemId: item.entityId, label: item.name, variant: item.variant, quantity: line.quantity, issuedAt: event.timestamp, issueEventId: event.eventId, issueTransactionId: payload.transactionId, bundleId: payload.bundleId as string|undefined, bundleVersion: payload.bundleVersion as number|undefined }) }
      for (const line of missing) { const existingNeed = state.stillNeeded.find(requirement => requirement.cadetId === cadet.cadetId && requirement.itemId === line.itemId && requirement.size === line.variant && requirement.displayLabel === line.label && requirement.source === 'INCOMPLETE_ISSUE' && !['FULFILLED','CANCELLED'].includes(requirement.status)); if (existingNeed) { existingNeed.quantityNeeded += line.quantity; existingNeed.relatedTransactionIds = [...new Set([...(existingNeed.relatedTransactionIds ?? []), payload.transactionId])]; existingNeed.updatedAt = event.timestamp; existingNeed.version++; existingNeed.appliedEventIds.push(event.eventId) } else state.stillNeeded.push({ requirementId: `need:${event.eventId}:${line.lineId}`, cadetId: cadet.cadetId, itemId: line.itemId, displayLabel: line.label, size: line.variant, quantityNeeded: line.quantity, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: event.timestamp, updatedAt: event.timestamp, source: 'INCOMPLETE_ISSUE', relatedTransactionIds: [payload.transactionId], relatedBundleId: payload.bundleId as string|undefined, bundleVersion: payload.bundleVersion as number|undefined, version: 1, appliedEventIds: [event.eventId] }) }
    } else for (const { line, item } of resolved) { const property = cadet.currentProperty.find(candidate => candidate.propertyId === line.propertyId)!; property.quantity -= line.quantity; if (!property.quantity) cadet.currentProperty = cadet.currentProperty.filter(candidate => candidate.propertyId !== property.propertyId); item.onHand += line.quantity; item.issued = Math.max(0, item.issued - line.quantity); item.version++; item.appliedEventIds.push(event.eventId) }
    cadet.version++; cadet.updatedAt = event.timestamp; cadet.appliedEventIds.push(event.eventId)
    state.transactions.push({ transactionId: payload.transactionId, transactionType: event.eventType === 'ITEM_ISSUED' ? 'ISSUE' : 'RETURN', cadetId: cadet.cadetId, actorId: event.actorPublicIdentity, createdAt: event.timestamp, eventId: event.eventId, bundleId: payload.bundleId as string|undefined, bundleVersion: payload.bundleVersion as number|undefined, bundleSnapshot, lines: structuredClone(lines), missingLines: structuredClone(missing) })
  }
  private addSupplyConflict(state: RepositoryState, event: SignedArgusEvent, cadetId: string, resolved: Array<{line:SupplyTransactionLine;item:InventoryProjection}>, reason = 'Concurrent issue transaction attempted to consume unavailable inventory.') {
    const inventoryItemIds = resolved.map(({ item }) => item.entityId)
    // The conflict names the transactions that consumed the contested SKUs before this one in canonical order, plus this one.
    const related = state.transactions.filter(transaction => transaction.lines.some(line => inventoryItemIds.includes(line.itemId))).map(transaction => transaction.eventId)
    const eventIds = [...new Set([...related, event.eventId])].sort(); const entityId = inventoryItemIds[0] ?? event.entityId
    const conflict: ConflictRecord = { id: `conflict:${event.eventId}`, entityId, eventIds, status: 'OPEN', reason, transactionId: event.entityId, inventoryItemIds, cadetId }
    if (!state.conflicts.some(candidate => candidate.id === conflict.id)) state.conflicts.push(conflict)
  }
  /**
   * A concurrent edit of the same event details stays visible until someone resolves it. The ID and
   * the competing events come only from what is already folded (the edits that wrote the contested
   * fields, plus this one), so every device derives the same conflict whatever order it received them in.
   */
  private addCalendarConflict(state: RepositoryState, event: SignedArgusEvent, target: CalendarEventProjection, fields: CalendarScalarField[]) {
    const eventIds = [...new Set([...fields.flatMap(field => fieldWriters(target, field)), event.eventId])].sort()
    const conflict: ConflictRecord = { id: `conflict:${event.eventId}`, entityId: target.calendarEventId, eventIds, status: 'OPEN', reason: `Two devices changed the ${fields.length ? listJoin(fields.map(field => CALENDAR_FIELD_LABEL[field])) : 'details'} of ${target.title} at the same time.` }
    if (!state.conflicts.some(candidate => candidate.id === conflict.id)) state.conflicts.push(conflict)
  }
  private addConflict(state: RepositoryState, event: SignedArgusEvent, reason: string) { const related = state.events.filter(e => e.event.entityId === event.entityId && e.event.baseVersion === event.baseVersion).map(e => e.event.eventId); const ids = [...new Set([...related, event.eventId])].sort(); const conflict = { id: `conflict:${ids.join(':')}`, entityId: event.entityId, eventIds: ids, status: 'OPEN' as const, reason }; if (!state.conflicts.some(c => c.id === conflict.id)) state.conflicts.push(conflict) }

  /** Resets projections to genesis and folds every known event in canonical order. Deterministic: same events ⇒ same state on every device. */
  private rebuild(state: RepositoryState) {
    // Each pass either finishes or sets aside one more unsafe event, so this terminates.
    for (;;) { try { this.rebuildOnce(state); return } catch (error) { if (!(error instanceof UnsafeEvent)) throw error } }
  }
  private rebuildOnce(state: RepositoryState) {
    const genesis = state.genesis ?? { inventory: [], catalog: [] }
    state.clock = 0
    state.inventory = structuredClone(genesis.inventory); state.catalog = structuredClone(genesis.catalog)
    state.countSessions = []; state.cadets = []; state.stillNeeded = []; state.transactions = []; state.conflicts = []; state.members = []; state.rejected = []; state.calendar = []; state.corrections = []; state.rollovers = []; state.keyEpochs = []; delete state.recoveryKey
    state.bundles = FACTORY_BUNDLES.map(source => factoryBundle(source, state.inventory))
    const ordered = [...state.events].sort((a, b) => eventSortKey(a.event) < eventSortKey(b.event) ? -1 : 1)
    for (const record of ordered) this.tryApply(state, record.event)
    state.lastAppliedKey = ordered.length ? eventSortKey(ordered[ordered.length - 1].event) : undefined
  }
  private tryApply(state: RepositoryState, event: SignedArgusEvent) {
    const reject = (reason: string) => { state.rejected.push({ eventId: event.eventId, eventType: event.eventType, reason }) }
    const clock = Math.floor(event.clock ?? 0)
    if (this.unsafeEvents.has(event.eventId)) { reject('This record would have corrupted the shared state and was set aside.'); return }
    if (clock > state.clock + MAX_CLOCK_JUMP) { reject('This record’s logical clock jumps too far ahead of the unit’s history.'); return }
    try { this.applyEvent(state, event) }
    catch (error) { reject(error instanceof Error ? error.message : 'Event could not be applied.'); return }
    // An event that passed its own checks but leaves an impossible state (e.g. negative stock) is set aside and history re-folded without it.
    if (projectionViolation(state)) { this.unsafeEvents.add(event.eventId); throw new UnsafeEvent(event.eventId) }
    // Only applied records move the clock: a rejected one (e.g. from an outsider) cannot push everyone's ordering around.
    state.clock = Math.max(state.clock, clock)
  }
  /** Adds verified events and brings the projection up to date: incrementally when they extend the canonical order, otherwise by a full rebuild. */
  private integrate(state: RepositoryState, events: SignedArgusEvent[], status: StoredStatus) {
    const fresh: SignedArgusEvent[] = []
    for (const event of events) {
      const existing = state.events.find(record => record.event.eventId === event.eventId)
      if (existing) { if (canonicalize(existing.event) !== canonicalize(event)) throw new Error('Event ID collision detected.'); continue }
      if (fresh.some(candidate => candidate.eventId === event.eventId)) continue
      fresh.push(event)
    }
    if (!fresh.length) return fresh
    fresh.sort((a, b) => eventSortKey(a) < eventSortKey(b) ? -1 : 1)
    const receivedAt = new Date().toISOString()
    for (const event of fresh) state.events.push({ event, syncStatus: status.syncStatus, auditStatus: 'PENDING', receivedAt, ...(status.transactionId ? { transactionId: status.transactionId } : {}) })
    // A revocation can invalidate already-applied events of the revoked member, so it always re-folds history.
    const inOrder = !state.rejected.length && !fresh.some(event => event.eventType === 'AUTHORITY_REVOKED' || event.eventType === 'ROLE_CHANGED') && (state.lastAppliedKey === undefined || eventSortKey(fresh[0]) > state.lastAppliedKey)
    if (inOrder) {
      try { for (const event of fresh) this.tryApply(state, event); state.lastAppliedKey = eventSortKey(fresh[fresh.length - 1]) }
      catch (error) { if (!(error instanceof UnsafeEvent)) throw error; this.rebuild(state) }
    } else this.rebuild(state)
    return fresh
  }
  private async persistLocal(event: SignedArgusEvent) {
    await this.repository.transaction(state => {
      const added = this.integrate(state, [event], { syncStatus: 'QUEUED' })
      if (!added.length) return
      const rejected = state.rejected.find(record => record.eventId === event.eventId)
      if (rejected) throw new Error(rejected.reason) // a local command that cannot apply is refused, never queued
      if (!state.outbox.some(record => record.eventId === event.eventId)) state.outbox.push({ eventId: event.eventId, attempts: 0, status: 'QUEUED' })
    })
  }
  private async verify(event: SignedArgusEvent) {
    if (event.protocol !== 'ARGUS' || event.protocolVersion !== 1 || event.eventVersion !== 1 || event.organizationId !== this.organizationId || !event.eventId || !event.actorPublicIdentity || !event.signature || !event.payload || typeof event.payload !== 'object') throw new Error('Malformed or unsupported distributed event.')
    if (event.clock !== undefined && (!Number.isSafeInteger(event.clock) || event.clock < 0 || event.clock > MAX_EVENT_CLOCK)) throw new Error('Malformed event clock.')
    if (!(await this.identity.verify(unsigned(event), event.signature, event.actorPublicIdentity))) throw new Error('Invalid event signature.')
  }
  async receive(event: SignedArgusEvent) {
    await this.verify(event)
    await this.repository.transaction(state => { this.integrate(state, [event], { syncStatus: 'SYNCHRONIZED' }) })
  }
  /** Batch receive for chain pages: every signature is checked, invalid ones are quarantined, and the rest are folded in one transaction. */
  async receiveMany(events: SignedArgusEvent[], transactionIds: Record<string, string> = {}) {
    const valid: SignedArgusEvent[] = [], invalid: Array<{ eventId: string; reason: string }> = []
    for (const event of events) { try { await this.verify(event); valid.push(event) } catch (error) { invalid.push({ eventId: event?.eventId ?? 'unknown', reason: error instanceof Error ? error.message : 'Remote event was rejected.' }) } }
    await this.repository.transaction(state => {
      const known = new Map(state.events.map(record => [record.event.eventId, record]))
      const accepted = valid.filter(event => { const existing = known.get(event.eventId); if (!existing) return true; if (canonicalize(existing.event) !== canonicalize(event)) { invalid.push({ eventId: event.eventId, reason: 'Event ID collision detected.' }); return false } if (existing.syncStatus !== 'SYNCHRONIZED') existing.syncStatus = 'SYNCHRONIZED'; if (transactionIds[event.eventId]) existing.transactionId = transactionIds[event.eventId]; return false })
      this.integrate(state, accepted, { syncStatus: 'SYNCHRONIZED' })
      for (const event of accepted) { const record = state.events.find(candidate => candidate.event.eventId === event.eventId); if (record && transactionIds[event.eventId]) record.transactionId = transactionIds[event.eventId] }
      for (const item of invalid) if (!state.quarantine.some(existing => existing.eventId === item.eventId && existing.reason === item.reason)) state.quarantine.push({ ...item, receivedAt: new Date().toISOString() })
    })
    return { accepted: valid.length, rejected: invalid.length }
  }
  sync() { return this.syncing ?? (this.syncing = this.runSync().finally(() => { this.syncing = undefined })) }
  private async runSync() {
    if (!this.online) return
    const before = await this.repository.snapshot()
    let failure: unknown
    for (const record of before.outbox) {
      const event = before.events.find(e => e.event.eventId === record.eventId)?.event
      if (!event) continue
      try { await this.provider.publish(event); await this.repository.transaction(s => { s.outbox = s.outbox.filter(o => o.eventId !== event.eventId); const stored = s.events.find(e => e.event.eventId === event.eventId); if (stored && stored.syncStatus !== 'SYNCHRONIZED') stored.syncStatus = 'SYNCING' }) }
      catch (error) { failure = error; await this.repository.transaction(s => { const out = s.outbox.find(o => o.eventId === event.eventId); if (out) { out.status = 'FAILED'; out.attempts++; out.lastError = error instanceof Error ? error.message : 'Sync failed' }; const stored = s.events.find(e => e.event.eventId === event.eventId); if (stored) stored.syncStatus = 'FAILED' }) }
    }
    // A device that cannot publish (offline wallet, no testnet coins) must still receive everyone else's work.
    const pending = await this.provider.pull()
    if (pending.length) {
      // If folding fails, the provider hands the same records over again next time instead of dropping them for the session.
      try { await this.receiveMany(pending, await this.provider.transactionIds?.(pending.map(event => event.eventId)) ?? {}) }
      catch (error) { this.provider.requeue?.(pending.map(event => event.eventId)); throw error }
    }
    if (failure) throw failure
  }
  /** Marks locally authored events as confirmed on chain once the transport has published them. */
  async markPublished(eventIds: string[], transactionId: string, status: 'SYNCHRONIZED' | 'SYNCING' = 'SYNCHRONIZED') {
    await this.repository.transaction(state => { for (const record of state.events) if (eventIds.includes(record.event.eventId)) { record.transactionId = transactionId; if (record.syncStatus !== 'SYNCHRONIZED') record.syncStatus = status; record.auditStatus = 'BROADCAST' } })
  }
  async snapshot() { return this.repository.snapshot() }
}

type StoredStatus = { syncStatus: 'QUEUED' | 'SYNCHRONIZED'; transactionId?: string }

function factoryBundle(source: BundleVersionProjection, inventory: InventoryProjection[]) {
  const version = structuredClone(source)
  // Legacy exact-SKU mapping by name for inventories that predate the catalog; catalog lines resolve sizes at issue time.
  version.lines = version.lines.map(line => ({ ...line, itemId: line.itemId ?? (line.catalogId && inventory.some(item => item.catalogId === line.catalogId) ? undefined : inventory.find(item => item.name === line.displayLabel)?.entityId) }))
  return { bundleId: version.bundleId, currentVersion: 1, versions: [version], appliedEventIds: [version.eventId] }
}
function totalsFor(observations: CountObservation[], accepted?: Set<string>) {
  const totals: Record<string, number> = {}
  for (const observation of observations) {
    if (observation.status === 'SUPERSEDED') continue
    if (accepted ? !accepted.has(observation.eventId) : observation.status === 'LATE') continue
    totals[observation.itemId] = (totals[observation.itemId] ?? 0) + observation.effectiveQuantity
  }
  return totals
}
function validateInventoryChanges(changes: Partial<InventoryProjection>) {
  if (changes.name !== undefined && (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 80)) throw new Error('Item name must be 1–80 characters.')
  if (changes.category !== undefined && (typeof changes.category !== 'string' || !changes.category.trim() || changes.category.length > 40)) throw new Error('Category must be 1–40 characters.')
  if (changes.variant !== undefined) normalizeSizeLabel(String(changes.variant))
  if (changes.niin !== undefined && (typeof changes.niin !== 'string' || changes.niin.length > 40)) throw new Error('NIIN/reference must be at most 40 characters.')
  if (changes.reorderAt !== undefined && (!Number.isInteger(changes.reorderAt) || changes.reorderAt < 0 || changes.reorderAt > MAX_COUNT_QUANTITY)) throw new Error('Low-stock threshold must be a whole number of zero or more.')
  if (changes.countIncrement !== undefined && (!Number.isInteger(changes.countIncrement) || changes.countIncrement < 1 || changes.countIncrement > 1000)) throw new Error('Count increment must be a whole number from 1 to 1000.')
  if (changes.active !== undefined && typeof changes.active !== 'boolean') throw new Error('Active must be true or false.')
}
function validateCatalog(value: Pick<CatalogItemProjection, 'name' | 'category' | 'niin' | 'sized' | 'countIncrement'> & Partial<CatalogItemProjection>) {
  validateInventoryChanges({ name: value.name, category: value.category, niin: value.niin, countIncrement: value.countIncrement, ...(value.reorderAt === undefined ? {} : { reorderAt: value.reorderAt }), ...(value.active === undefined ? {} : { active: value.active }) })
  if (typeof value.sized !== 'boolean') throw new Error('Choose whether the item comes in sizes.')
  if (value.sizeScheme !== undefined && (typeof value.sizeScheme !== 'string' || value.sizeScheme.length > 40)) throw new Error('Size scheme is invalid.')
}
function validateCalendar(value: { kind?: unknown; title: string; startsAt: string; notes?: string; bundleIds?: unknown; cadetIds?: unknown; tasks?: Array<{ title: string; dueOffsetDays: number }> }) {
  if (value.kind !== undefined && !SUPPLY_EVENT_KINDS.includes(value.kind as SupplyEventKind)) throw new Error('Unknown supply event type.')
  if (!value.title.trim() || value.title.length > 80) throw new Error('Event title must be 1–80 characters.')
  if (Number.isNaN(Date.parse(value.startsAt))) throw new Error('Enter the event date.')
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 1000)) throw new Error('Notes are too long.')
  if (value.bundleIds !== undefined && !Array.isArray(value.bundleIds)) throw new Error('Bundle list is invalid.')
  if (value.cadetIds !== undefined && (!Array.isArray(value.cadetIds) || value.cadetIds.length > 500)) throw new Error('Cadet list is invalid.')
  for (const task of value.tasks ?? []) validateTask(task)
}
function validateTask(task: { title: string; dueOffsetDays: number }) {
  if (!task.title.trim() || task.title.length > 120) throw new Error('Task title must be 1–120 characters.')
  if (!Number.isInteger(task.dueOffsetDays) || Math.abs(task.dueOffsetDays) > 365) throw new Error('Task due date must be within a year of the event.')
}
function validateActive(changes: { active?: unknown }) { if (changes.active !== undefined && typeof changes.active !== 'boolean') throw new Error('Active must be true or false.') }
const CALENDAR_FIELD_LABEL: Record<CalendarScalarField, string> = { title: 'title', startsAt: 'date and time', notes: 'notes', active: 'cancellation', kind: 'event type' }
const listJoin = (words: string[]) => words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
const sortedUnique = (ids: string[]) => [...new Set(ids)].sort()
/** Events that wrote a field's current value; the creation event until someone edits it. */
function fieldWriters(event: Pick<CalendarEventProjection, 'appliedEventIds' | 'fieldRevisions'>, field: CalendarScalarField) { return event.fieldRevisions?.[field] ?? event.appliedEventIds.slice(0, 1) }
/** Notes are optional: absent and empty mean the same. */
const sameScalar = (a: unknown, b: unknown) => (a ?? '') === (b ?? '')
/** Validates a set-style calendar payload ({ calendarEventId, <key>: string[] }) and returns its IDs, de-duplicated. */
function setPayload(event: SignedArgusEvent, key: 'cadetIds' | 'bundleIds', max: number) {
  const ids = event.payload[key]
  if (event.payload.calendarEventId !== event.entityId || !Array.isArray(ids) || !ids.length || ids.length > max || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Corrupted calendar list change.')
  return [...new Set(ids as string[])]
}
/**
 * A metadata edit conflicts only with an edit of the same kind to the same fields that its author
 * had not seen (an already-applied edit whose base version is not older than this one's). Stock
 * movements also bump versions, but they never make a profile or catalog edit ambiguous.
 */
function concurrentEditOfSameFields(state: RepositoryState, event: SignedArgusEvent, appliedEventIds: string[]) {
  const fields = Object.keys(event.payload)
  return state.events.some(record => record.event.eventType === event.eventType && record.event.entityId === event.entityId && record.event.eventId !== event.eventId && appliedEventIds.includes(record.event.eventId) && record.event.baseVersion !== undefined && record.event.baseVersion >= (event.baseVersion ?? 0) && Object.keys(record.event.payload).some(field => fields.includes(field)))
}

