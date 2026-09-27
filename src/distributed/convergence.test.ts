import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { MemoryRepository, type RepositoryState } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { GENESIS_CATALOG } from '../stage3/domain'
import { canonicalize } from './canonical'
import { ArgusReplica } from './replica'
import type { ArgusRole, SignedArgusEvent } from './types'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId

async function unit(names: string[], roles: ArgusRole[] = names.map(() => 'SUPPLY_OFFICER')) {
  const root = new MockIdentityProvider('unit-root'), verifier = new MockIdentityProvider('verifier')
  const authorization = new AuthorizationService(await root.getPublicIdentity(), verifier)
  const identities = names.map(name => new MockIdentityProvider(name))
  for (const [index, identity] of identities.entries()) await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: roles[index], permissions: [...ROLE_PERMISSIONS[roles[index]]], issuedAt: '2026-01-01T00:00:00.000Z' }))
  const provider = new MockSyncProvider()
  const replicas = identities.map(identity => new ArgusReplica(new MemoryRepository(), identity, authorization, provider, 'unit-a', { genesisCatalog: true }))
  for (const replica of replicas) { await replica.initialize(); replica.online = false }
  return { replicas, provider, authorization, identities }
}

/** The projection a user can see; transport bookkeeping (sync status, receivedAt) legitimately differs per device. */
const visible = (state: RepositoryState) => canonicalize({ inventory: state.inventory, catalog: state.catalog, countSessions: state.countSessions, cadets: state.cadets, stillNeeded: state.stillNeeded, transactions: state.transactions, conflicts: state.conflicts, members: state.members, bundles: state.bundles, rejected: state.rejected })
const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)
const shuffle = <T,>(values: T[], seed: number) => { const copy = [...values]; let state = seed; for (let i = copy.length - 1; i > 0; i--) { state = (state * 1103515245 + 12345) % 2 ** 31; const j = state % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]] } return copy }

describe('shared counting: A counts 3 PT Shorts, B counts 3 PT Shorts', () => {
  it('shows 6 on every device, including a fresh device that only reads history, and finalizes on-hand to 6', async () => {
    const { replicas: [a, b, c] } = await unit(['officer-a', 'officer-b', 'fresh-c'])
    await a.addCatalogSizes(PT_SHORTS, ['S', 'M', 'L'], { eventId: 'sizes' })
    const medium = (await a.snapshot()).inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!.entityId
    await a.createCountSession({ sessionId: 'fall-count', scope: 'Fall inventory' }, { eventId: 'session' })
    await b.receiveMany(await events(a))
    // Both people count at the same time, offline from each other.
    await a.contributeCount('fall-count', { itemId: medium }, 3, 'Shelf A', { eventId: 'a-counts-3' })
    await b.contributeCount('fall-count', { itemId: medium }, 3, 'Shelf B', { eventId: 'b-counts-3' })
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    await c.receiveMany([...(await events(b))].reverse())
    for (const replica of [a, b, c]) expect((await replica.snapshot()).countSessions[0].totals[medium]).toBe(6)
    const session = (await c.snapshot()).countSessions[0]
    expect(session.participants).toEqual(['mock:officer-a', 'mock:officer-b'])
    // The officer finalizes: on-hand becomes the shared total everywhere.
    await a.finalizeCountSession('fall-count', { eventId: 'finalize' })
    await b.receiveMany(await events(a)); await c.receiveMany(await events(a))
    for (const replica of [a, b, c]) {
      const state = await replica.snapshot()
      expect(state.inventory.find(item => item.entityId === medium)?.onHand).toBe(6)
      expect(state.countSessions[0].status).toBe('RECONCILED')
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
    expect(visible(await b.snapshot())).toBe(visible(await c.snapshot()))
  })

  it('keeps a contribution that reaches the chain after finalization visible as LATE without changing stock', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    await a.addCatalogSizes(PT_SHORTS, ['M'])
    const medium = (await a.snapshot()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await a.createCountSession({ sessionId: 'count', scope: 'Full' })
    await b.receiveMany(await events(a))
    await a.contributeCount('count', { itemId: medium }, 3)
    await b.contributeCount('count', { itemId: medium }, 3, '', { eventId: 'offline-b' }) // B is offline and A never sees this before finalizing
    await a.finalizeCountSession('count')
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    for (const replica of [a, b]) {
      const state = await replica.snapshot()
      expect(state.inventory.find(item => item.entityId === medium)?.onHand).toBe(3)
      expect(state.countSessions[0].lateEventIds).toEqual(['offline-b'])
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
  })
})

describe('deterministic convergence', () => {
  it('produces byte-identical projections for every delivery order of the same history', async () => {
    const { replicas: [a, b], authorization, identities } = await unit(['officer-a', 'officer-b'])
    await a.addCatalogSizes(PT_SHORTS, ['S', 'M'], { eventId: 'sizes' })
    const [small, medium] = (await a.snapshot()).inventory.filter(item => item.catalogId === PT_SHORTS).map(item => item.entityId)
    await a.receiveStock(small, 5, 'Initial shipment', { eventId: 'receive-a' })
    await b.receiveMany(await events(a))
    const cadet = await a.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Encrypted Only' }, { eventId: 'cadet' })
    await b.receiveMany(await events(a))
    // Concurrent, offline work on both devices: both issue from the same shelf and both receive stock.
    await a.issueTransaction({ transactionId: 'tx-a', cadetId: cadet.entityId, lines: [{ lineId: 'l', itemId: small, quantity: 3 }] }, { eventId: 'issue-a' })
    await b.issueTransaction({ transactionId: 'tx-b', cadetId: cadet.entityId, lines: [{ lineId: 'l', itemId: small, quantity: 3 }] }, { eventId: 'issue-b' })
    await b.receiveStock(medium, 4, '', { eventId: 'receive-b' })
    const history: SignedArgusEvent[] = [...new Map([...(await events(a)), ...(await events(b))].map(event => [event.eventId, event])).values()]
    const projections = new Set<string>()
    for (let seed = 1; seed <= 6; seed++) {
      const replica = new ArgusReplica(new MemoryRepository(), identities[0], authorization, new MockSyncProvider(), 'unit-a', { genesisCatalog: true })
      await replica.initialize(); replica.online = false
      // Deliver in a random order, in random batch sizes, sometimes twice.
      const order = shuffle(history, seed)
      for (let i = 0; i < order.length; i += 1 + (seed % 3)) await replica.receiveMany(order.slice(i, i + 1 + (seed % 3)))
      await replica.receiveMany(shuffle(history, seed + 100))
      projections.add(visible(await replica.snapshot()))
    }
    expect(projections.size).toBe(1)
    const state = await a.snapshot(); await a.receiveMany(history); const converged = await a.snapshot()
    expect(converged.inventory.find(item => item.entityId === small)?.onHand).toBe(2) // 5 received, one 3-issue applied, the other is an open conflict
    expect(converged.inventory.find(item => item.entityId === medium)?.onHand).toBe(4)
    expect(converged.conflicts.filter(conflict => conflict.status === 'OPEN')).toHaveLength(1)
    expect(state.events.length).toBeLessThan(converged.events.length)
  })

  it('does not treat concurrent issues of a well-stocked item as a conflict', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    await a.addCatalogSizes(PT_SHORTS, ['L'])
    const large = (await a.snapshot()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await a.receiveStock(large, 20)
    const cadet = await a.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE' })
    await b.receiveMany(await events(a))
    await a.issueTransaction({ transactionId: 'one', cadetId: cadet.entityId, lines: [{ lineId: 'l', itemId: large, quantity: 1 }] })
    await b.issueTransaction({ transactionId: 'two', cadetId: cadet.entityId, lines: [{ lineId: 'l', itemId: large, quantity: 1 }] })
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    for (const replica of [a, b]) { const state = await replica.snapshot(); expect(state.conflicts).toHaveLength(0); expect(state.inventory.find(item => item.entityId === large)?.onHand).toBe(18) }
  })

  it('refuses a remote update that tries to overwrite stock fields outside the editable whitelist', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    await a.addCatalogSizes(PT_SHORTS, ['S'])
    const small = (await a.snapshot()).inventory.find(item => item.catalogId === PT_SHORTS)!
    await b.receiveMany(await events(a))
    // Build a signed-but-malicious update: onHand/issued are not editable metadata.
    const forged = await a.updateInventoryItem(small.entityId, { reorderAt: 2, ...({ onHand: 999, issued: 50 } as object) })
    expect(forged.payload).toEqual({ reorderAt: 2 })
    await b.receiveMany(await events(a))
    expect((await b.snapshot()).inventory.find(item => item.entityId === small.entityId)).toMatchObject({ onHand: 0, issued: 0, reorderAt: 2 })
  })
})

describe('catalog, sizes and cadet privacy', () => {
  it('starts from a zeroed catalog of the specification items with no sizes and no people', async () => {
    const { replicas: [a] } = await unit(['officer-a'])
    const state = await a.snapshot()
    expect(state.catalog).toHaveLength(25)
    expect(state.catalog.every(item => item.niin === '')).toBe(true)
    expect(state.inventory.every(item => item.onHand === 0 && item.issued === 0)).toBe(true)
    expect(state.inventory.map(item => item.variant)).toEqual(expect.arrayContaining(['One size']))
    expect(state.inventory.filter(item => item.catalogId === PT_SHORTS)).toHaveLength(0)
    expect(state.cadets).toHaveLength(0)
    expect(state.bundles).toHaveLength(7)
  })

  it('adds, renames and deactivates sizes with signed events and skips duplicate labels', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    await a.addCatalogSizes(PT_SHORTS, ['S', 'M'])
    await expect(a.addCatalogSizes(PT_SHORTS, [' m '])).rejects.toThrow(/already exist/)
    await b.addCatalogSizes(PT_SHORTS, ['M', 'XL']) // B is offline and also adds M
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    for (const replica of [a, b]) expect((await replica.snapshot()).inventory.filter(item => item.catalogId === PT_SHORTS).map(item => item.variant).sort()).toEqual(['M', 'S', 'XL'])
    const small = (await a.snapshot()).inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'S')!
    await a.updateInventoryItem(small.entityId, { variant: 'Small', reorderAt: 5 })
    await a.updateCatalogItem(PT_SHORTS, { name: 'PT Shorts (Gold)', niin: '8415-01-000-0000' })
    const renamed = (await a.snapshot()).inventory.filter(item => item.catalogId === PT_SHORTS)
    expect(renamed.every(item => item.name === 'PT Shorts (Gold)' && item.niin === '8415-01-000-0000')).toBe(true)
    await a.updateInventoryItem(small.entityId, { active: false })
    expect((await a.snapshot()).inventory.find(item => item.entityId === small.entityId)?.active).toBe(false)
  })

  it('creates custom catalog items; unsized ones get a single countable variant', async () => {
    const { replicas: [a] } = await unit(['officer-a'])
    await a.createCatalogItem({ name: 'Rifle Sling', category: 'Drill', sized: false }, { eventId: 'sling' })
    const state = await a.snapshot()
    const sling = state.catalog.find(item => item.name === 'Rifle Sling')!
    expect(state.inventory.filter(item => item.catalogId === sling.catalogId)).toMatchObject([{ variant: 'One size', onHand: 0 }])
  })

  it('identifies cadets by an opaque short ID; the name is optional and never needed to issue', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    const idOnly = await a.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    const named = await a.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', fullName: 'Private Name' })
    await b.receiveMany(await events(a))
    const cadets = (await b.snapshot()).cadets
    expect(cadets.map(cadet => cadet.cadetCode)).toEqual([expect.stringMatching(/^C-[0-9A-Z]{4}$/), expect.stringMatching(/^C-[0-9A-Z]{4}$/)])
    expect(cadets.find(cadet => cadet.cadetId === idOnly.entityId)?.fullName).toBe('')
    expect(cadets.find(cadet => cadet.cadetId === named.entityId)?.fullName).toBe('Private Name')
    await expect(a.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: cadets[0].cadetCode })).rejects.toThrow(/already in use/)
  })

  it('records admissions so every device knows every member', async () => {
    const { replicas: [master, officer], authorization } = await unit(['master', 'officer'], ['MASTER', 'SUPPLY_OFFICER'])
    const credential = authorization.credentialFor('mock:officer', '2026-02-01T00:00:00.000Z')!
    await master.recordAdmission({ credential, displayName: 'Luke', walletAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn' })
    await officer.receiveMany(await events(master))
    expect((await officer.snapshot()).members).toMatchObject([{ publicIdentity: 'mock:officer', displayName: 'Luke', role: 'SUPPLY_OFFICER', status: 'ACTIVE' }])
    await expect(officer.recordAdmission({ credential, displayName: 'Self-promoted' })).rejects.toThrow(/users.authorize/)
  })
})
