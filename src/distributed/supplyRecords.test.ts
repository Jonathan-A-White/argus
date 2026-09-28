import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { FACTORY_BUNDLES, GENESIS_CATALOG, recommendBundles } from '../stage3/domain'
import { MemoryRepository, type RepositoryState } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { canonicalize } from './canonical'
import { ArgusReplica } from './replica'
import type { SignedArgusEvent, UnsignedArgusEvent } from './types'

const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId
const NEED = { quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN' as const, firstNeededAt: '2026-09-01T00:00:00.000Z', source: 'MANUAL' as const }

async function unit(names: string[]) {
  const root = new MockIdentityProvider('unit-root'), authorization = new AuthorizationService(await root.getPublicIdentity(), new MockIdentityProvider('verifier'))
  const identities = names.map(name => new MockIdentityProvider(name))
  for (const identity of identities) await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2026-01-01T00:00:00.000Z' }))
  const replicas = identities.map(identity => new ArgusReplica(new MemoryRepository(), identity, authorization, new MockSyncProvider(), 'unit-a', { genesisCatalog: true }))
  for (const replica of replicas) { await replica.initialize(); replica.online = false }
  return { replicas, identities }
}
const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)
/** Everything a user can see; transport bookkeeping legitimately differs per device. */
const visible = (state: RepositoryState) => canonicalize({ inventory: state.inventory, catalog: state.catalog, cadets: state.cadets, stillNeeded: state.stillNeeded, transactions: state.transactions, conflicts: state.conflicts, bundles: state.bundles, rejected: state.rejected })
const shuffle = <T,>(values: T[], seed: number) => { const copy = [...values]; let state = seed; for (let i = copy.length - 1; i > 0; i--) { state = (state * 1103515245 + 12345) % 2 ** 31; const j = state % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]] } return copy }

/** Adds sizes to a genesis catalog item and receives stock; returns size label → inventory ID. */
async function stock(replica: ArgusReplica, name: string, sizes: Record<string, number>) {
  await replica.addCatalogSizes(catalogId(name), Object.keys(sizes))
  const state = await replica.snapshot(), ids: Record<string, string> = {}
  for (const [label, quantity] of Object.entries(sizes)) {
    ids[label] = state.inventory.find(item => item.catalogId === catalogId(name) && item.variant === label)!.entityId
    if (quantity) await replica.receiveStock(ids[label], quantity)
  }
  return ids
}
const cadet = async (replica: ArgusReplica, gender: 'Male' | 'Female' = 'Male') => (await replica.createCadet({ gender, nsLevel: 'NS1', status: 'ACTIVE' })).entityId
const onHand = async (replica: ArgusReplica, itemId: string) => (await replica.snapshot()).inventory.find(item => item.entityId === itemId)!
const need = async (replica: ArgusReplica, requirementId: string) => (await replica.snapshot()).stillNeeded.find(requirement => requirement.requirementId === requirementId)!

describe('Still Needed raised before an item had sizes (spec §6, §10)', () => {
  it('fulfils a catalog-level requirement once that item is issued in any size', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const cadetId = await cadet(a)
    // A PT bundle issue while Khaki Ball Cap had no sizes: the whole line is Still Needed at catalog level.
    await a.issueTransaction({ transactionId: 'pt-bundle', cadetId, lines: [], missingLines: [{ lineId: 'cap', catalogId: catalogId('Khaki Ball Cap'), label: 'Khaki Ball Cap', quantity: 1, required: true }] }, { eventId: 'pt-bundle-event' })
    expect(await need(a, 'need:pt-bundle-event:cap')).toMatchObject({ status: 'OPEN', catalogId: catalogId('Khaki Ball Cap'), itemId: undefined })
    const caps = await stock(a, 'Khaki Ball Cap', { M: 2, L: 1 })
    await a.issueTransaction({ transactionId: 'cap-issue', cadetId, lines: [{ lineId: 'cap', itemId: caps.M, quantity: 1 }] })
    expect(await need(a, 'need:pt-bundle-event:cap')).toMatchObject({ status: 'FULFILLED', quantityFulfilled: 1 })
    expect((await a.snapshot()).cadets[0].currentProperty).toEqual([expect.objectContaining({ itemId: caps.M, variant: 'M' })])
  })

  it('matches a label-only requirement by item name, preferring the same size, and leaves a different recorded size open', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const cadetId = await cadet(a)
    await a.addStillNeeded({ ...NEED, requirementId: 'large', cadetId, displayLabel: 'PT Shorts', size: 'L' })
    await a.addStillNeeded({ ...NEED, requirementId: 'any-size', cadetId, displayLabel: ' pt  shorts ', firstNeededAt: '2026-09-02T00:00:00.000Z' })
    await a.addStillNeeded({ ...NEED, requirementId: 'medium', cadetId, displayLabel: 'PT Shorts', size: 'm', firstNeededAt: '2026-09-03T00:00:00.000Z' })
    const shorts = await stock(a, 'PT Shorts', { M: 5, L: 5 })
    // The exact size wins over "any size", even though it was raised later.
    await a.issueTransaction({ transactionId: 'm1', cadetId, lines: [{ lineId: 'm', itemId: shorts.M, quantity: 1 }] })
    expect([(await need(a, 'medium')).status, (await need(a, 'any-size')).status, (await need(a, 'large')).status]).toEqual(['FULFILLED', 'OPEN', 'OPEN'])
    await a.issueTransaction({ transactionId: 'm2', cadetId, lines: [{ lineId: 'm', itemId: shorts.M, quantity: 1 }] })
    expect([(await need(a, 'any-size')).status, (await need(a, 'large')).status]).toEqual(['FULFILLED', 'OPEN'])
    await a.issueTransaction({ transactionId: 'l1', cadetId, lines: [{ lineId: 'l', itemId: shorts.L, quantity: 1 }] })
    expect((await need(a, 'large')).status).toBe('FULFILLED')
  })

  it('lets one line fulfil several requirements, oldest first, and an unsized item fulfil a sized-less requirement', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const cadetId = await cadet(a)
    await a.addStillNeeded({ ...NEED, requirementId: 'first', cadetId, displayLabel: 'Black Belt' })
    await a.addStillNeeded({ ...NEED, requirementId: 'second', cadetId, displayLabel: 'Black Belt', quantityNeeded: 2, firstNeededAt: '2026-09-05T00:00:00.000Z' })
    const belt = (await a.snapshot()).inventory.find(item => item.catalogId === catalogId('Black Belt'))!.entityId
    await a.receiveStock(belt, 5)
    await a.issueTransaction({ transactionId: 'belts', cadetId, lines: [{ lineId: 'belt', itemId: belt, quantity: 2 }] })
    expect(await need(a, 'first')).toMatchObject({ status: 'FULFILLED', quantityFulfilled: 1 })
    expect(await need(a, 'second')).toMatchObject({ status: 'PARTIALLY_FULFILLED', quantityFulfilled: 1 })
  })

  it('honours an explicit requirementId first, even for a requirement without size or matching label', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const cadetId = await cadet(a), other = await cadet(a, 'Female')
    await a.addStillNeeded({ ...NEED, requirementId: 'rank-device', cadetId, displayLabel: 'Rank device (any cover)' })
    await a.addStillNeeded({ ...NEED, requirementId: 'someone-else', cadetId: other, displayLabel: 'Garrison Cap' })
    const caps = await stock(a, 'Garrison Cap', { '7': 3 })
    await expect(a.issueTransaction({ transactionId: 'wrong-cadet', cadetId, lines: [{ lineId: 'cap', itemId: caps['7'], quantity: 1, requirementId: 'someone-else' }] })).rejects.toThrow(/no longer open/)
    await a.issueTransaction({ transactionId: 'explicit', cadetId, lines: [{ lineId: 'cap', itemId: caps['7'], quantity: 1, requirementId: 'rank-device' }] })
    expect(await need(a, 'rank-device')).toMatchObject({ status: 'FULFILLED', quantityFulfilled: 1 })
    expect(await need(a, 'someone-else')).toMatchObject({ status: 'OPEN' })
  })

  it('closes requirements by hand: fulfil with an optional note, cancel only with a reason', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    const cadetId = await cadet(a)
    await a.addStillNeeded({ ...NEED, requirementId: 'tabs', cadetId, displayLabel: 'Neck Tabs' })
    await a.addStillNeeded({ ...NEED, requirementId: 'pumps', cadetId, displayLabel: 'Pumps' })
    await a.fulfilStillNeeded('tabs', 'Issued from the old spreadsheet')
    await expect(a.cancelStillNeeded('pumps', '  ')).rejects.toThrow(/reason/)
    await a.cancelStillNeeded('pumps', 'Cadet transferred out')
    await expect(a.fulfilStillNeeded('pumps')).rejects.toThrow(/already closed/)
    await b.receiveMany(await events(a))
    expect(await need(b, 'tabs')).toMatchObject({ status: 'FULFILLED', quantityFulfilled: 1, closeReason: 'Issued from the old spreadsheet' })
    expect(await need(b, 'pumps')).toMatchObject({ status: 'CANCELLED', closeReason: 'Cadet transferred out' })
    expect((await events(b)).filter(event => event.eventType.startsWith('STILL_NEEDED_')).map(event => event.eventType)).toEqual(['STILL_NEEDED_ADDED', 'STILL_NEEDED_ADDED', 'STILL_NEEDED_FULFILLED', 'STILL_NEEDED_CANCELLED'])
  })
})

describe('bundle recommendations come from bundle fields, never names (spec §6, §8)', () => {
  it('follows genderApplicability and purpose through renames and unit-created bundles', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const fields = (id: string) => { const { displayName, genderApplicability, purpose, lines, active } = FACTORY_BUNDLES.find(bundle => bundle.bundleId === id)!; return { displayName, genderApplicability, purpose, lines, active } }
    await a.updateBundle('bundle-male-nsu', { ...fields('bundle-male-nsu'), displayName: 'Service Uniform A' })
    await a.updateBundle('bundle-female-sdb', { ...fields('bundle-female-sdb'), displayName: 'Male SDB (old label)' })
    await a.createBundle('bundle-male-pt', { displayName: 'Cold-weather PT', genderApplicability: 'Male', purpose: 'pt', lines: [{ lineId: 'male-pt:0', catalogId: catalogId('Tracksuit Top'), displayLabel: 'Tracksuit Top', required: true, supportsSizing: true, defaultQuantity: 1, order: 0 }], active: true })
    const versions = (await a.snapshot()).bundles.map(bundle => bundle.versions.find(version => version.version === bundle.currentVersion)!)
    const male = recommendBundles(versions, 'Male'), female = recommendBundles(versions, 'Female')
    // The male-specific PT bundle serves purpose "PT" for male cadets, so the "Any" PT bundle drops to Other options for them only.
    expect(male.recommended.map(version => version.displayName)).toEqual(['Service Uniform A', 'Male SDB', 'Drill', 'BLT', 'Cold-weather PT'])
    expect(male.other.map(version => version.displayName)).toEqual(['Female NSU', 'Male SDB (old label)', 'PT'])
    expect(female.recommended.map(version => version.displayName)).toEqual(['Female NSU', 'Male SDB (old label)', 'PT', 'Drill', 'BLT'])
    expect(female.other.map(version => version.bundleId)).toEqual(['bundle-male-nsu', 'bundle-male-sdb', 'bundle-male-pt'])
  })
})

describe('return conditions (spec §11)', () => {
  it('returns only serviceable items to on-hand, clears every holding, keeps condition and note, and allows two holdings of one size', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    const cadetId = await cadet(a), shorts = await stock(a, 'PT Shorts', { M: 10 })
    // Four separate issues of the same size: four separate holdings.
    for (const id of ['i1', 'i2', 'i3', 'i4']) await a.issueTransaction({ transactionId: id, cadetId, lines: [{ lineId: 'm', itemId: shorts.M, quantity: 1 }] })
    const holdings = (await a.snapshot()).cadets[0].currentProperty.map(property => property.propertyId)
    expect(holdings).toHaveLength(4)
    await expect(a.returnTransaction({ transactionId: 'twice', cadetId, lines: [{ lineId: 'x', propertyId: holdings[0], quantity: 1 }, { lineId: 'y', propertyId: holdings[0], quantity: 1 }] })).rejects.toThrow(/same holding/)
    await expect(a.returnTransaction({ transactionId: 'bad', cadetId, lines: [{ lineId: 'x', propertyId: holdings[0], quantity: 1, condition: 'SHREDDED' as never }] })).rejects.toThrow(/condition/)
    await a.returnTransaction({ transactionId: 'end-of-year', cadetId, lines: [
      { lineId: 'ok', propertyId: holdings[0], quantity: 1, condition: 'SERVICEABLE' },
      { lineId: 'repair', propertyId: holdings[1], quantity: 1, condition: 'NEEDS_REPAIR', note: 'Torn seam' },
      { lineId: 'worn', propertyId: holdings[2], quantity: 1, condition: 'UNSERVICEABLE' },
      { lineId: 'lost', propertyId: holdings[3], quantity: 1, condition: 'LOST', note: 'Left at BLT' },
    ] }, { eventId: 'return-event' })
    await b.receiveMany([...(await events(a))].reverse())
    for (const replica of [a, b]) {
      const state = await replica.snapshot()
      expect(state.inventory.find(item => item.entityId === shorts.M)).toMatchObject({ onHand: 7, issued: 0 })
      expect(state.cadets[0].currentProperty).toEqual([])
      expect(state.transactions.find(transaction => transaction.transactionId === 'end-of-year')!.lines.map(line => [line.condition, line.note])).toEqual([['SERVICEABLE', undefined], ['NEEDS_REPAIR', 'Torn seam'], ['UNSERVICEABLE', undefined], ['LOST', 'Left at BLT']])
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
    // A retried confirmation with the same event ID is idempotent.
    await a.returnTransaction({ transactionId: 'end-of-year', cadetId, lines: [{ lineId: 'ok', propertyId: holdings[0], quantity: 1, condition: 'SERVICEABLE' }, { lineId: 'repair', propertyId: holdings[1], quantity: 1, condition: 'NEEDS_REPAIR', note: 'Torn seam' }, { lineId: 'worn', propertyId: holdings[2], quantity: 1, condition: 'UNSERVICEABLE' }, { lineId: 'lost', propertyId: holdings[3], quantity: 1, condition: 'LOST', note: 'Left at BLT' }] }, { eventId: 'return-event' })
    expect((await onHand(a, shorts.M)).onHand).toBe(7)
  })
})

describe('RECORD_CORRECTED quantity corrections (spec §12)', () => {
  it('RECEIPT_QUANTITY: fixes on-hand, keeps the original receipt, chains corrections and replays identically', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    const shorts = await stock(a, 'PT Shorts', { M: 0 })
    const receipt = await a.receiveStock(shorts.M, 10, 'Box from district')
    await a.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, from: 10, to: 8, reason: 'Box held 8' })
    expect((await onHand(a, shorts.M)).onHand).toBe(8)
    await expect(a.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, from: 10, to: 9, reason: 'stale view' })).rejects.toThrow(/now reads 8/)
    await a.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, to: 9, reason: 'Found one more' })
    expect((await onHand(a, shorts.M)).onHand).toBe(9)
    const state = await a.snapshot()
    expect(state.events.map(record => record.event.eventType).filter(type => type === 'INVENTORY_RECEIVED' || type === 'RECORD_CORRECTED')).toEqual(['INVENTORY_RECEIVED', 'RECORD_CORRECTED', 'RECORD_CORRECTED'])
    expect(state.events.find(record => record.event.eventId === receipt.eventId)!.event.payload.quantity).toBe(10)
    // Replay: a full re-fold and a fresh device reading the history out of order agree exactly.
    await a.rebuildNow(); await b.receiveMany(shuffle(await events(a), 7)); await b.receiveMany(await events(a))
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
    expect((await onHand(b, shorts.M)).onHand).toBe(9)
  })

  it('RECEIPT_QUANTITY: an impossible correction is refused locally and becomes a conflict, never negative stock, when it arrives from elsewhere', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    const shorts = await stock(a, 'PT Shorts', { M: 0 }), receipt = await a.receiveStock(shorts.M, 5)
    const cadetId = await cadet(a)
    await b.receiveMany(await events(a))
    // Offline from each other: A issues 4, B decides the receipt was really 2.
    await a.issueTransaction({ transactionId: 'four', cadetId, lines: [{ lineId: 'm', itemId: shorts.M, quantity: 4 }] })
    await b.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, to: 2, reason: 'Miscounted box' }, { eventId: 'z-correction' })
    await expect(a.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, to: 2, reason: 'Miscounted box' })).rejects.toThrow(/negative stock/)
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    for (const replica of [a, b]) {
      const state = await replica.snapshot(), item = state.inventory.find(candidate => candidate.entityId === shorts.M)!
      expect(item.onHand).toBe(1)
      expect(state.conflicts).toEqual([expect.objectContaining({ id: 'conflict:z-correction', status: 'OPEN', losingEventId: 'z-correction', shortfalls: [expect.objectContaining({ kind: 'STOCK', available: 1, requested: 3 })] })])
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
  })

  it('RECEIPT_QUANTITY: after a physical count the record changes but on-hand stays what was counted', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const shorts = await stock(a, 'PT Shorts', { M: 0 }), receipt = await a.receiveStock(shorts.M, 12)
    await a.createCountSession({ sessionId: 'count', scope: 'Shelf' })
    await a.contributeCount('count', { itemId: shorts.M }, 10)
    await a.finalizeCountSession('count')
    await a.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, to: 10, reason: 'Packing slip said 12, box held 10' })
    expect((await onHand(a, shorts.M)).onHand).toBe(10)
  })

  it('ISSUE_QUANTITY: moves stock and the cadet holding both ways, and refuses removing property the cadet no longer holds', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const cadetId = await cadet(a), shirts = await stock(a, 'Gold PT Shirt', { L: 5 })
    const issue = await a.issueTransaction({ transactionId: 'shirts', cadetId, lines: [{ lineId: 'l', itemId: shirts.L, quantity: 2 }] })
    await a.correctRecord({ kind: 'ISSUE_QUANTITY', targetEventId: issue.eventId, lineId: 'l', to: 1, reason: 'Only one handed over' })
    let state = await a.snapshot()
    expect(state.inventory.find(item => item.entityId === shirts.L)).toMatchObject({ onHand: 4, issued: 1 })
    expect(state.cadets[0].currentProperty).toEqual([expect.objectContaining({ quantity: 1 })])
    expect(state.transactions[0].lines[0]).toMatchObject({ quantity: 2, correctedQuantity: 1 })
    await a.correctRecord({ kind: 'ISSUE_QUANTITY', targetEventId: issue.eventId, lineId: 'l', to: 3, reason: 'Three after all' })
    state = await a.snapshot()
    expect(state.inventory.find(item => item.entityId === shirts.L)).toMatchObject({ onHand: 2, issued: 3 })
    expect(state.cadets[0].currentProperty[0].quantity).toBe(3)
    await expect(a.correctRecord({ kind: 'ISSUE_QUANTITY', targetEventId: issue.eventId, lineId: 'l', to: 6, reason: 'too many' })).rejects.toThrow(/negative stock/)
    // Everything came back; now "only 1 was issued" would remove property the cadet no longer holds.
    await a.returnTransaction({ transactionId: 'back', cadetId, lines: [{ lineId: 'r', propertyId: state.cadets[0].currentProperty[0].propertyId, quantity: 3 }] })
    await expect(a.correctRecord({ kind: 'ISSUE_QUANTITY', targetEventId: issue.eventId, lineId: 'l', to: 1, reason: 'no' })).rejects.toThrow(/holds 0/)
  })

  it('RETURN_QUANTITY: restores the returned holding, and a lost return never touches on-hand', async () => {
    const { replicas: [a] } = await unit(['officer'])
    const cadetId = await cadet(a), slacks = await stock(a, 'Black Slacks', { '10': 6 })
    await a.issueTransaction({ transactionId: 'slacks', cadetId, lines: [{ lineId: 's', itemId: slacks['10'], quantity: 3 }] })
    const propertyId = (await a.snapshot()).cadets[0].currentProperty[0].propertyId
    const serviceable = await a.returnTransaction({ transactionId: 'r1', cadetId, lines: [{ lineId: 'r', propertyId, quantity: 2, condition: 'SERVICEABLE' }] })
    expect((await onHand(a, slacks['10'])).onHand).toBe(5)
    await a.correctRecord({ kind: 'RETURN_QUANTITY', targetEventId: serviceable.eventId, lineId: 'r', to: 1, reason: 'Only one came back' })
    let state = await a.snapshot()
    expect(state.inventory.find(item => item.entityId === slacks['10'])).toMatchObject({ onHand: 4, issued: 2 })
    expect(state.cadets[0].currentProperty).toEqual([expect.objectContaining({ propertyId, quantity: 2 })])
    const lost = await a.returnTransaction({ transactionId: 'r2', cadetId, lines: [{ lineId: 'r', propertyId, quantity: 2, condition: 'LOST' }] })
    expect((await a.snapshot()).cadets[0].currentProperty).toEqual([])
    // The holding was removed entirely; correcting the lost return to 1 restores it from the return's record.
    await a.correctRecord({ kind: 'RETURN_QUANTITY', targetEventId: lost.eventId, lineId: 'r', to: 1, reason: 'One pair turned up' })
    state = await a.snapshot()
    expect(state.inventory.find(item => item.entityId === slacks['10'])).toMatchObject({ onHand: 4, issued: 1 })
    expect(state.cadets[0].currentProperty).toEqual([expect.objectContaining({ propertyId, quantity: 1, variant: '10', issueTransactionId: 'slacks' })])
  })

  it('ISSUE_QUANTITY and RETURN_QUANTITY: impossible corrections from another device become conflicts, and every device replays to the same state', async () => {
    const { replicas: [a, b, c] } = await unit(['officer-a', 'officer-b', 'fresh-c'])
    const cadetId = await cadet(a), other = await cadet(a, 'Female'), shirts = await stock(a, 'Gold PT Shirt', { M: 3 })
    const issue = await a.issueTransaction({ transactionId: 'shirts', cadetId, lines: [{ lineId: 's', itemId: shirts.M, quantity: 2 }] }, { eventId: 'issue' })
    const propertyId = (await a.snapshot()).cadets.find(candidate => candidate.cadetId === cadetId)!.currentProperty[0].propertyId
    const returned = await a.returnTransaction({ transactionId: 'back', cadetId, lines: [{ lineId: 'r', propertyId, quantity: 1 }] }, { eventId: 'return' })
    await b.receiveMany(await events(a))
    // Offline from each other. A: the cadet returns the other shirt, and the last two on the shelf go to someone else.
    await a.returnTransaction({ transactionId: 'back-2', cadetId, lines: [{ lineId: 'r', propertyId, quantity: 1 }] }, { eventId: 'return-2' })
    await a.issueTransaction({ transactionId: 'other', cadetId: other, lines: [{ lineId: 's', itemId: shirts.M, quantity: 3 }] }, { eventId: 'issue-other' })
    // B: "only 1 was issued" (would remove a shirt the cadet no longer holds) and "the return never happened" (needs a shirt back off an empty shelf).
    await b.correctRecord({ kind: 'ISSUE_QUANTITY', targetEventId: issue.eventId, lineId: 's', to: 1, reason: 'One shirt' }, { eventId: 'z-issue-fix' })
    await b.correctRecord({ kind: 'RETURN_QUANTITY', targetEventId: returned.eventId, lineId: 'r', to: 0, reason: 'Return entered by mistake' }, { eventId: 'z-return-fix' })
    await a.receiveMany(await events(b)); await b.receiveMany(shuffle(await events(a), 2)); await c.receiveMany([...(await events(b))].reverse())
    const expected = visible(await a.snapshot())
    for (const replica of [b, c]) expect(visible(await replica.snapshot())).toBe(expected)
    const state = await c.snapshot()
    expect(state.inventory.find(item => item.entityId === shirts.M)).toMatchObject({ onHand: 0, issued: 3 })
    expect(state.conflicts.map(conflict => [conflict.id, conflict.cadetId, conflict.shortfalls?.map(shortfall => [shortfall.kind, shortfall.available, shortfall.requested])])).toEqual([
      ['conflict:z-issue-fix', cadetId, [['PROPERTY', 0, 1]]],
      ['conflict:z-return-fix', cadetId, [['STOCK', 0, 1]]],
    ])
    expect(state.transactions.find(transaction => transaction.transactionId === 'shirts')!.lines[0].correctedQuantity).toBeUndefined()
    // Re-folding the whole history changes nothing.
    await c.rebuildNow()
    expect(visible(await c.snapshot())).toBe(expected)
  })

  it('makes the later of two concurrent corrections of the same record a conflict on every device', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    const shorts = await stock(a, 'PT Shorts', { S: 0 }), receipt = await a.receiveStock(shorts.S, 10)
    await b.receiveMany(await events(a))
    await a.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, to: 8, reason: 'A counted 8' }, { eventId: 'fix-a' })
    await b.correctRecord({ kind: 'RECEIPT_QUANTITY', targetEventId: receipt.eventId, to: 9, reason: 'B counted 9' }, { eventId: 'fix-b' })
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    for (const replica of [a, b]) {
      const state = await replica.snapshot()
      expect(state.inventory.find(item => item.entityId === shorts.S)!.onHand).toBe(8)
      expect(state.conflicts).toEqual([expect.objectContaining({ id: 'conflict:fix-b', eventIds: [receipt.eventId, 'fix-a', 'fix-b'].sort(), reason: expect.stringMatching(/already changed this receipt to 8/) })])
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
  })
})

describe('conflict resolution outcomes (spec §23)', () => {
  async function lastJacket() {
    const { replicas: [a, b, c] } = await unit(['officer-a', 'officer-b', 'fresh-c'])
    const jackets = await stock(a, 'Female SDB Jacket', { M: 1 }), belt = (await a.snapshot()).inventory.find(item => item.catalogId === catalogId('Black Belt'))!.entityId
    await a.receiveStock(belt, 3)
    const cadetA = await cadet(a, 'Female'), cadetB = await cadet(a, 'Female')
    await b.receiveMany(await events(a))
    // Offline from each other, both officers issue the last Medium jacket.
    await a.issueTransaction({ transactionId: 'tx-a', cadetId: cadetA, lines: [{ lineId: 'jacket', itemId: jackets.M, quantity: 1 }] }, { eventId: 'issue-a' })
    await b.issueTransaction({ transactionId: 'tx-b', cadetId: cadetB, lines: [{ lineId: 'jacket', itemId: jackets.M, quantity: 1 }, { lineId: 'belt', itemId: belt, quantity: 1 }], missingLines: [{ lineId: 'tabs', catalogId: catalogId('Neck Tabs'), label: 'Neck Tabs', quantity: 1, required: true }] }, { eventId: 'issue-b' })
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    return { a, b, c, jackets, belt, cadetA, cadetB }
  }

  it('shows the impossible state and losing cadet, then RECORD_STILL_NEEDED creates the same requirements on every device whatever the delivery order', async () => {
    const { a, b, c, jackets, belt, cadetB } = await lastJacket()
    const conflict = (await a.snapshot()).conflicts[0]
    expect(conflict).toMatchObject({ id: 'conflict:issue-b', losingEventId: 'issue-b', cadetId: cadetB, eventIds: ['issue-a', 'issue-b'], shortfalls: [{ kind: 'STOCK', itemId: jackets.M, label: 'Female SDB Jacket', variant: 'M', available: 0, requested: 1 }] })
    // A records the outcome while B, still offline, receives more jackets.
    await a.resolve(conflict.id, 'Second cadet gets the next delivery', 'RECORD_STILL_NEEDED', { eventId: 'resolution' })
    await b.receiveStock(jackets.M, 2, '', { eventId: 'restock' })
    await a.receiveMany(shuffle(await events(b), 3)); await b.receiveMany([...(await events(a))].reverse()); await c.receiveMany(shuffle(await events(a), 11))
    const expected = visible(await a.snapshot())
    for (const replica of [b, c]) expect(visible(await replica.snapshot())).toBe(expected)
    const state = await c.snapshot()
    expect(state.conflicts[0]).toMatchObject({ status: 'RESOLVED', outcome: 'RECORD_STILL_NEEDED', resolutionEventId: 'resolution' })
    expect(state.stillNeeded.filter(requirement => requirement.source === 'CONFLICT_RESOLUTION').map(requirement => [requirement.requirementId, requirement.cadetId, requirement.itemId, requirement.catalogId, requirement.displayLabel, requirement.size, requirement.status])).toEqual([
      ['need:resolution:jacket', cadetB, jackets.M, catalogId('Female SDB Jacket'), 'Female SDB Jacket', 'M', 'OPEN'],
      ['need:resolution:belt', cadetB, belt, catalogId('Black Belt'), 'Black Belt', 'One size', 'OPEN'],
      ['need:resolution:tabs', cadetB, undefined, catalogId('Neck Tabs'), 'Neck Tabs', undefined, 'OPEN'],
    ])
    // The losing issue itself stays unapplied and in history; stock never went negative.
    expect(state.transactions.map(transaction => transaction.transactionId)).toEqual(['tx-a'])
    expect(state.inventory.find(item => item.entityId === jackets.M)!.onHand).toBe(2)
    expect(state.events.some(record => record.event.eventId === 'issue-b')).toBe(true)
    // Issuing the restocked jacket later fulfils the recorded requirement.
    await c.issueTransaction({ transactionId: 'make-good', cadetId: cadetB, lines: [{ lineId: 'jacket', itemId: jackets.M, quantity: 1 }] })
    expect((await c.snapshot()).stillNeeded.find(requirement => requirement.requirementId === 'need:resolution:jacket')!.status).toBe('FULFILLED')
  })

  it('settles concurrent resolutions deterministically: the first in canonical order wins on every device', async () => {
    const { a, b, c } = await lastJacket()
    const conflictId = (await a.snapshot()).conflicts[0].id
    await a.resolve(conflictId, 'Keep it', 'KEEP_AS_IS', { eventId: 'resolve-a' })
    await b.resolve(conflictId, 'Record it', 'RECORD_STILL_NEEDED', { eventId: 'resolve-b' })
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a)); await c.receiveMany(shuffle(await events(a), 5))
    const expected = visible(await a.snapshot())
    for (const replica of [b, c]) expect(visible(await replica.snapshot())).toBe(expected)
    const state = await a.snapshot()
    expect(state.conflicts[0]).toMatchObject({ status: 'RESOLVED', outcome: 'KEEP_AS_IS', resolutionEventId: 'resolve-a' })
    expect(state.stillNeeded.filter(requirement => requirement.source === 'CONFLICT_RESOLUTION')).toEqual([])
  })

  it('offers RECORD_STILL_NEEDED only for a losing issue', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    const cadetId = await cadet(a)
    await b.receiveMany(await events(a))
    await a.updateCadet(cadetId, { nsLevel: 'NS2' }, { eventId: 'edit-a' }); await b.updateCadet(cadetId, { nsLevel: 'NS3' }, { eventId: 'edit-b' })
    await a.receiveMany(await events(b))
    const conflictId = (await a.snapshot()).conflicts[0].id
    await expect(a.resolve(conflictId, 'Asked the cadet', 'RECORD_STILL_NEEDED')).rejects.toThrow(/Only a conflicting issue/)
    await a.resolve(conflictId, 'Asked the cadet: NS2 is right')
    expect((await a.snapshot()).conflicts[0]).toMatchObject({ status: 'RESOLVED', outcome: 'KEEP_AS_IS' })
  })
})

describe('conflict IDs do not depend on delivery timing', () => {
  async function threeEdits() {
    const { replicas, identities } = await unit(['one', 'two', 'three', 'reader-a', 'reader-b'])
    const base = FACTORY_BUNDLES.find(bundle => bundle.bundleId === 'bundle-drill')!
    const edits: SignedArgusEvent[] = []
    for (const [index, replica] of replicas.slice(0, 3).entries()) edits.push(await replica.updateBundle(base.bundleId, { displayName: `Drill v${index + 1}`, genderApplicability: 'Any', purpose: base.purpose, lines: base.lines, active: true }, { eventId: `u${index + 1}` }))
    return { readers: replicas.slice(3), edits, identities, bundleId: base.bundleId }
  }

  it('gives the same conflicts whether three concurrent edits arrive one at a time or in one batch', async () => {
    const { readers: [oneByOne, batch], edits } = await threeEdits()
    for (const edit of edits) await oneByOne.receiveMany([edit])
    await batch.receiveMany([...edits].reverse())
    for (const replica of [oneByOne, batch]) expect((await replica.snapshot()).conflicts.map(conflict => [conflict.id, conflict.eventIds])).toEqual([['conflict:u2', ['u1', 'u2']], ['conflict:u3', ['u1', 'u2', 'u3']]])
    expect(visible(await oneByOne.snapshot())).toBe(visible(await batch.snapshot()))
  })

  it('keeps a resolution resolved when a further concurrent edit arrives later, and still honours legacy resolution IDs', async () => {
    const { readers: [reader, legacyReader], edits, identities, bundleId } = await threeEdits()
    await reader.receiveMany(edits.slice(0, 2))
    await reader.resolve('conflict:u2', 'Kept v1', 'KEEP_AS_IS', { eventId: 'resolution-u2' })
    await reader.receiveMany([edits[2]])
    expect((await reader.snapshot()).conflicts.map(conflict => [conflict.id, conflict.status])).toEqual([['conflict:u2', 'RESOLVED'], ['conflict:u3', 'OPEN']])
    // A resolution recorded by an older release named the conflict "conflict:u1:u2".
    const legacy: UnsignedArgusEvent = { protocol: 'ARGUS', protocolVersion: 1, organizationId: 'unit-a', eventVersion: 1, eventId: 'legacy-resolution', eventType: 'CONFLICT_RESOLVED', entityId: bundleId, actorPublicIdentity: await identities[3].getPublicIdentity(), timestamp: '2026-09-20T00:00:00.000Z', clock: 9, payload: { conflictId: 'conflict:u1:u2', resolution: 'Kept v1' } }
    await legacyReader.receiveMany([...edits, { ...legacy, signature: await identities[3].sign(canonicalize(legacy)) }])
    expect((await legacyReader.snapshot()).conflicts.map(conflict => [conflict.id, conflict.status, conflict.outcome])).toEqual([['conflict:u2', 'RESOLVED', 'KEEP_AS_IS'], ['conflict:u3', 'OPEN', undefined]])
  })
})
