import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential, issueRevocation } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { MemoryRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { canonicalize } from './canonical'
import { ArgusReplica, MAX_CLOCK_JUMP } from './replica'
import type { ArgusRole, SignedArgusEvent, UnsignedArgusEvent } from './types'

// Regression tests for defects found by a code review of the shared-state engine. Each one failed before its fix.
const BELT = 'catalog:black-belt:one-size'
const ISSUED_AT = '2026-01-01T00:00:00.000Z'

async function unit(names: string[], roles: ArgusRole[] = names.map(() => 'SUPPLY_OFFICER')) {
  const root = new MockIdentityProvider('unit-root'), verifier = new MockIdentityProvider('verifier')
  const authorization = new AuthorizationService(await root.getPublicIdentity(), verifier)
  const identities = names.map(name => new MockIdentityProvider(name))
  for (const [index, identity] of identities.entries()) await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: roles[index], permissions: [...ROLE_PERMISSIONS[roles[index]]], issuedAt: ISSUED_AT }))
  const replicas = identities.map(identity => new ArgusReplica(new MemoryRepository(), identity, authorization, new MockSyncProvider(), 'unit-a', { genesisCatalog: true }))
  for (const replica of replicas) { await replica.initialize(); replica.online = false }
  return { replicas, authorization, identities, root }
}
const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)
const onHand = async (replica: ArgusReplica) => (await replica.snapshot()).inventory.find(item => item.entityId === BELT)!.onHand
async function forge(signer: MockIdentityProvider, fields: Partial<UnsignedArgusEvent> & Pick<UnsignedArgusEvent, 'eventId' | 'eventType' | 'entityId' | 'payload'>): Promise<SignedArgusEvent> {
  const event: UnsignedArgusEvent = { protocol: 'ARGUS', protocolVersion: 1, organizationId: 'unit-a', eventVersion: 1, actorPublicIdentity: await signer.getPublicIdentity(), timestamp: '2026-03-01T00:00:00.000Z', clock: 1, ...fields }
  return { ...event, signature: await signer.sign(canonicalize(event)) }
}

describe('shared-state engine robustness', () => {
  it('a record with a huge logical clock cannot stall the ordering of everyone’s later work', async () => {
    const { replicas: [a], identities: [officer] } = await unit(['officer-a'])
    const outsider = new MockIdentityProvider('not-a-member')
    await a.receiveMany([await forge(outsider, { eventId: 'poison-max', eventType: 'RECORD_CORRECTED', entityId: 'x', payload: {}, clock: Number.MAX_SAFE_INTEGER })])
    // Even a member cannot jump the clock far ahead: that record is set aside and does not move anyone's clock.
    await a.receiveMany([await forge(officer, { eventId: 'poison-jump', eventType: 'INVENTORY_RECEIVED', entityId: BELT, payload: { quantity: 1 }, clock: MAX_CLOCK_JUMP * 5 })])
    const state = await a.snapshot()
    expect(state.clock).toBeLessThan(10)
    expect(state.rejected.map(record => record.eventId)).toContain('poison-jump')
    const cadet = await a.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' }, { eventId: 'zzzz-cadet' })
    await a.receiveStock(BELT, 3, '', { eventId: 'zzzz-receive' })
    await expect(a.issueTransaction({ transactionId: 't1', cadetId: cadet.entityId, lines: [{ lineId: 'l', itemId: BELT, quantity: 1 }] }, { eventId: 'aaaa-issue' })).resolves.toBeDefined()
    expect(await onHand(a)).toBe(2)
  })

  it('one record that would leave an impossible state is set aside; the rest of the history still loads on a fresh device', async () => {
    const { replicas: [, b, fresh], identities } = await unit(['officer-a', 'officer-b', 'fresh'])
    const poison = await forge(identities[0], { eventId: 'poison', eventType: 'INVENTORY_ITEM_CREATED', entityId: 'item-x', payload: { name: 'Gloves', category: 'Misc', onHand: 1, issued: -1, countIncrement: 1 } })
    await b.receiveStock(BELT, 4, '', { eventId: 'good' })
    await expect(fresh.receiveMany([poison, ...(await events(b))])).resolves.toBeDefined()
    const state = await fresh.snapshot()
    expect(await onHand(fresh)).toBe(4)
    expect(state.inventory.some(item => item.entityId === 'item-x')).toBe(false)
    expect(state.rejected.map(record => record.eventId)).toContain('poison')
  })

  it('a removed member cannot slip in work by back-dating it once the removal is in the shared history', async () => {
    const { replicas: [master, x], authorization, root } = await unit(['master', 'x'], ['MASTER', 'SUPPLY_OFFICER'])
    const credential = authorization.credentialFor('mock:x', '2026-02-01T00:00:00.000Z')!
    await master.recordAdmission({ credential, displayName: 'Officer X' }, { timestamp: '2026-02-01T00:00:00.000Z' })
    const revocation = await issueRevocation(root, credential, '2026-06-01T00:00:00.000Z')
    await authorization.acceptRevocation(revocation)
    await master.recordRevocation(revocation, { timestamp: '2026-06-01T00:00:01.000Z' })
    await x.receiveMany(await events(master))
    // x's device has seen the removal (its clock is past it) and signs a timestamp from before it.
    const late = await forge(new MockIdentityProvider('x'), { eventId: 'after-removal', eventType: 'INVENTORY_RECEIVED', entityId: BELT, payload: { quantity: 9 }, timestamp: '2026-05-01T00:00:00.000Z', clock: (await x.snapshot()).clock + 1 })
    await master.receiveMany([late])
    expect(await onHand(master)).toBe(0)
  })

  it('authorization does not depend on the order a device learned a member’s credentials', async () => {
    const root = new MockIdentityProvider('unit-root'), verifier = new MockIdentityProvider('verifier'), rootId = await root.getPublicIdentity()
    const asAssistant = await issueCredential(root, { subjectPublicIdentity: 'mock:x', role: 'SUPPLY_ASSISTANT', permissions: [...ROLE_PERMISSIONS.SUPPLY_ASSISTANT], issuedAt: ISSUED_AT, credentialId: 'cred-assistant' })
    const asOfficer = await issueCredential(root, { subjectPublicIdentity: 'mock:x', role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2026-02-01T00:00:00.000Z', credentialId: 'cred-officer' })
    const learned = async (order: typeof asOfficer[]) => { const auth = new AuthorizationService(rootId, verifier); for (const credential of order) await auth.acceptCredential(credential); return auth }
    const make = async (auth: AuthorizationService, name: string) => { const replica = new ArgusReplica(new MemoryRepository(), new MockIdentityProvider(name), auth, new MockSyncProvider(), 'unit-a', { genesisCatalog: true }); await replica.initialize(); replica.online = false; return replica }
    const author = await make(await learned([asOfficer]), 'x')
    await author.receiveStock(BELT, 5, '', { eventId: 'rx', timestamp: '2026-03-01T00:00:00.000Z' })
    const first = await make(await learned([asAssistant, asOfficer]), 'd1'), second = await make(await learned([asOfficer, asAssistant]), 'd2')
    for (const device of [first, second]) await device.receiveMany(await events(author))
    expect(await onHand(first)).toBe(5)
    expect(await onHand(second)).toBe(5)
  })

  it('the annual rollover advances only the cadets its author saw, not a class imported at the same time elsewhere', async () => {
    const { replicas: [a, b] } = await unit(['officer-a', 'officer-b'])
    await a.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-AB12' })
    await b.receiveMany(await events(a))
    await b.importCadets([{ gender: 'Female', nsLevel: 'NS1', cadetCode: 'C-NEW1' }])
    await a.completeAnnualRollover('2026-2027')
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    for (const device of [a, b]) {
      const cadets = (await device.snapshot()).cadets
      expect(cadets.find(cadet => cadet.cadetCode === 'C-AB12')?.nsLevel).toBe('NS3')
      expect(cadets.find(cadet => cadet.cadetCode === 'C-NEW1')?.nsLevel).toBe('NS1')
    }
  })
})
