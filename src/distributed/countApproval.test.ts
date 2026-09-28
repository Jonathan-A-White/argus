import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { GENESIS_CATALOG } from '../stage3/domain'
import { MemoryRepository, type RepositoryState } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { canonicalize } from './canonical'
import { ArgusReplica } from './replica'
import type { ArgusRole, SignedArgusEvent, UnsignedArgusEvent } from './types'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const ORG = 'unit-approval'

async function unit(roles: ArgusRole[]) {
  const root = new MockIdentityProvider('approval-root'), verifier = new MockIdentityProvider('verifier')
  const authorization = new AuthorizationService(await root.getPublicIdentity(), verifier)
  const identities = roles.map((role, index) => new MockIdentityProvider(`${role.toLowerCase()}-${index}`))
  for (const [index, identity] of identities.entries()) await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: roles[index], permissions: [...ROLE_PERMISSIONS[roles[index]]], issuedAt: '2026-01-01T00:00:00.000Z' }))
  const provider = new MockSyncProvider()
  const replicas = identities.map(identity => new ArgusReplica(new MemoryRepository(), identity, authorization, provider, ORG, { genesisCatalog: true }))
  for (const replica of replicas) { await replica.initialize(); replica.online = false }
  return { replicas, identities, authorization, provider }
}

const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)
/** Everything a person can see; transport bookkeeping (sync status, receivedAt) legitimately differs per device. */
const visible = (state: RepositoryState) => canonicalize({ inventory: state.inventory, catalog: state.catalog, countSessions: state.countSessions, conflicts: state.conflicts, rejected: state.rejected })
const exchange = async (...replicas: ArgusReplica[]) => { for (const target of replicas) for (const source of replicas) if (source !== target) await target.receiveMany(await events(source)) }
const at = (day: number) => `2026-03-${String(day).padStart(2, '0')}T10:00:00.000Z`

/** Officer A with sizes S/M/L of PT Shorts and an open count everyone has seen. */
async function countingUnit(roles: ArgusRole[] = ['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT']) {
  const context = await unit(roles)
  const [officer] = context.replicas
  await officer.addCatalogSizes(PT_SHORTS, ['S', 'M', 'L'], { eventId: 'sizes' })
  const variants = (await officer.snapshot()).inventory.filter(item => item.catalogId === PT_SHORTS)
  const [small, medium] = ['S', 'M'].map(size => variants.find(item => item.variant === size)!.entityId)
  await officer.createCountSession({ sessionId: 's', scope: 'Spring count' }, { eventId: 'session', timestamp: at(1) })
  await exchange(...context.replicas)
  return { ...context, small, medium }
}

async function forge(identity: MockIdentityProvider, input: Pick<UnsignedArgusEvent, 'eventId' | 'eventType' | 'entityId' | 'payload' | 'clock'> & { baseVersion?: number }): Promise<SignedArgusEvent> {
  const event: UnsignedArgusEvent = { protocol: 'ARGUS', protocolVersion: 1, organizationId: ORG, eventVersion: 1, actorPublicIdentity: await identity.getPublicIdentity(), timestamp: at(20), ...input }
  return { ...event, signature: await identity.sign(canonicalize(event)) }
}

describe('last counted time per size', () => {
  it('records the finalizing event’s own timestamp and ID on every counted size, identically on every device', async () => {
    const { replicas: [officer, assistant], small, medium } = await countingUnit()
    await assistant.contributeCount('s', { itemId: medium }, 4, '', { eventId: 'm-4', timestamp: at(2) })
    await officer.receiveMany(await events(assistant))
    await officer.finalizeCountSession('s', { eventId: 'finalize', timestamp: at(3) })
    await assistant.receiveMany(await events(officer))
    for (const replica of [officer, assistant]) {
      const state = await replica.snapshot()
      expect(state.inventory.find(item => item.entityId === medium)).toMatchObject({ onHand: 4, lastCountedAt: at(3), lastCountEventId: 'finalize' })
      // Nobody counted S, so it keeps "never counted".
      expect(state.inventory.find(item => item.entityId === small)).not.toHaveProperty('lastCountedAt')
    }
    expect(visible(await officer.snapshot())).toBe(visible(await assistant.snapshot()))
  })

  it('flags only real stock movement during a count: a rename is not movement, a receipt is', async () => {
    const { replicas: [officer], small, medium } = await countingUnit()
    await officer.contributeCount('s', { itemId: small }, 1)
    await officer.contributeCount('s', { itemId: medium }, 4)
    await officer.updateCatalogItem(PT_SHORTS, { name: 'Navy PT Shorts' })
    await officer.receiveStock(medium, 2)
    await officer.finalizeCountSession('s')
    expect((await officer.snapshot()).countSessions[0].movementWarnings).toEqual([medium])
  })

  it('a zero count is still a count, and the legacy absolute count also records the time', async () => {
    const { replicas: [officer], small, medium } = await countingUnit()
    await officer.contributeCount('s', { itemId: small }, 0, '', { eventId: 'zero', timestamp: at(2) })
    await officer.finalizeCountSession('s', { eventId: 'finalize', timestamp: at(3) })
    await officer.submitCount(medium, 2, 'legacy-sheet', '', { eventId: 'legacy', timestamp: at(4) })
    const state = await officer.snapshot()
    expect(state.inventory.find(item => item.entityId === small)).toMatchObject({ onHand: 0, lastCountedAt: at(3), lastCountEventId: 'finalize' })
    expect(state.inventory.find(item => item.entityId === medium)).toMatchObject({ onHand: 2, lastCountedAt: at(4), lastCountEventId: 'legacy' })
  })
})

describe('count approval lifecycle (spec §13)', () => {
  it('lets an assistant submit for approval but not finalize or send back; an officer finalizes', async () => {
    const { replicas: [officer, assistant], medium } = await countingUnit()
    await assistant.contributeCount('s', { itemId: medium }, 5, '', { eventId: 'm-5' })
    await expect(assistant.finalizeCountSession('s')).rejects.toThrow(/inventory\.adjust/)
    await assistant.submitCountSession('s', { eventId: 'submit', timestamp: at(5) })
    let session = (await assistant.snapshot()).countSessions[0]
    expect(session).toMatchObject({ status: 'SUBMITTED', submittedAt: at(5), acceptedEventIds: ['m-5'] })
    expect(session.submittedBy).toBe('mock:supply_assistant-1')
    // Contributions are closed once it waits for approval.
    await expect(assistant.contributeCount('s', { itemId: medium }, 1)).rejects.toThrow(/not open/)
    await expect(assistant.reopenCountSession('s', 'Recount the back room')).rejects.toThrow(/inventory\.adjust/)
    await expect(assistant.finalizeCountSession('s')).rejects.toThrow(/inventory\.adjust/)

    await officer.receiveMany(await events(assistant))
    await officer.finalizeCountSession('s', { eventId: 'approve', timestamp: at(6) })
    await assistant.receiveMany(await events(officer))
    for (const replica of [officer, assistant]) {
      const state = await replica.snapshot()
      session = state.countSessions[0]
      expect(session).toMatchObject({ status: 'RECONCILED', reconciledEventId: 'approve', totals: { [medium]: 5 } })
      expect(state.inventory.find(item => item.entityId === medium)).toMatchObject({ onHand: 5, lastCountEventId: 'approve' })
    }
  })

  it('refuses forged approval events from an assistant in the shared fold', async () => {
    const { replicas: [officer, assistant], identities: [, assistantIdentity], medium } = await countingUnit()
    await assistant.contributeCount('s', { itemId: medium }, 5, '', { eventId: 'm-5' })
    await assistant.submitCountSession('s', { eventId: 'submit' })
    await officer.receiveMany(await events(assistant))
    const clock = (await officer.snapshot()).clock + 1
    await officer.receiveMany([
      await forge(assistantIdentity, { eventId: 'forged-reopen', eventType: 'COUNT_SESSION_REOPENED', entityId: 's', clock, payload: { reason: 'I want to change it' } }),
      await forge(assistantIdentity, { eventId: 'forged-finalize', eventType: 'COUNT_SESSION_RECONCILED', entityId: 's', clock: clock + 1, payload: { acceptedEventIds: ['m-5'], acceptedCorrectionIds: [], totals: { [medium]: 5 } } }),
    ])
    const state = await officer.snapshot()
    expect(state.countSessions[0].status).toBe('SUBMITTED')
    expect(state.rejected.map(record => record.eventId).sort()).toEqual(['forged-finalize', 'forged-reopen'])
    expect(state.inventory.find(item => item.entityId === medium)?.onHand).toBe(0)
  })

  it('an officer sends a count back with a reason; late work counts again and can then be finalized', async () => {
    const { replicas: [officer, assistant, second], medium } = await countingUnit(['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT', 'SUPPLY_ASSISTANT'])
    await assistant.contributeCount('s', { itemId: medium }, 5, '', { eventId: 'm-5' })
    await assistant.submitCountSession('s', { eventId: 'submit' })
    // A second assistant was offline and counted the other shelf after the submission.
    await second.contributeCount('s', { itemId: medium }, 2, 'Back shelf', { eventId: 'late-2' })
    await exchange(officer, assistant, second)
    let session = (await officer.snapshot()).countSessions[0]
    expect(session).toMatchObject({ status: 'SUBMITTED', lateEventIds: ['late-2'], totals: { [medium]: 5 } })
    await expect(officer.finalizeCountSession('s')).rejects.toThrow(/late work/)

    await expect(officer.reopenCountSession('s', '   ')).rejects.toThrow(/reason/)
    await officer.reopenCountSession('s', 'Include the back shelf', { eventId: 'send-back', timestamp: at(7) })
    session = (await officer.snapshot()).countSessions[0]
    expect(session).toMatchObject({ status: 'ACTIVE', lateEventIds: [], totals: { [medium]: 7 }, sentBack: { by: 'mock:supply_officer-0', at: at(7), reason: 'Include the back shelf', eventId: 'send-back' } })
    expect(session).not.toHaveProperty('acceptedEventIds')
    expect(session.observations.map(observation => observation.status)).toEqual(['ACCEPTED', 'ACCEPTED'])
    await expect(officer.reopenCountSession('s', 'Again')).rejects.toThrow(/waiting for approval/)

    await officer.finalizeCountSession('s', { eventId: 'finalize' })
    await exchange(officer, assistant, second)
    for (const replica of [officer, assistant, second]) expect((await replica.snapshot()).inventory.find(item => item.entityId === medium)?.onHand).toBe(7)
    expect(visible(await officer.snapshot())).toBe(visible(await assistant.snapshot()))
    expect(visible(await assistant.snapshot())).toBe(visible(await second.snapshot()))
  })

  it('converges when one officer sends back and another finalizes the same submission concurrently, in every delivery order', async () => {
    const { replicas: [a, assistant, b, fresh], medium } = await countingUnit(['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT', 'SUPPLY_OFFICER', 'SUPPLY_ASSISTANT'])
    await assistant.contributeCount('s', { itemId: medium }, 5, '', { eventId: 'm-5' })
    await assistant.submitCountSession('s', { eventId: 'submit' })
    await exchange(a, assistant, b)
    await a.reopenCountSession('s', 'Recount please', { eventId: 'a-send-back' })
    await b.finalizeCountSession('s', { eventId: 'b-finalize' })
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    await assistant.receiveMany([...(await events(b))].reverse())
    await fresh.receiveMany([...(await events(a))].reverse())
    const states = await Promise.all([a, b, assistant, fresh].map(replica => replica.snapshot()))
    for (const state of states) expect(visible(state)).toBe(visible(states[0]))
    // Same clock: 'a-send-back' sorts first, so the count reopens and B's finalization (of the submitted cutoff) then applies to it.
    expect(states[0].countSessions[0]).toMatchObject({ status: 'RECONCILED', reconciledEventId: 'b-finalize' })
    expect(states[0].rejected).toEqual([])
  })
})

describe('a concurrent correction or recount never undoes an officer’s finalization', () => {
  it('keeps the finalization and shows an unseen correction as late (assistant corrects while the officer finalizes)', async () => {
    const { replicas: [officer, assistant], medium } = await countingUnit()
    await officer.contributeCount('s', { itemId: medium }, 3, '', { eventId: 'a-count' })
    await assistant.receiveMany(await events(officer))
    await assistant.correctCount('s', 'a-count', 5, 'Recounted', { eventId: 'b-fix' })
    await officer.finalizeCountSession('s', { eventId: 'z-finalize' })
    expect((await officer.snapshot()).inventory.find(item => item.entityId === medium)?.onHand).toBe(3)
    await exchange(officer, assistant)
    for (const replica of [officer, assistant]) {
      const state = await replica.snapshot()
      expect(state.rejected).toEqual([])
      expect(state.inventory.find(item => item.entityId === medium)?.onHand).toBe(3)
      const session = state.countSessions[0]
      expect(session).toMatchObject({ status: 'RECONCILED', reconciledEventId: 'z-finalize', lateEventIds: ['b-fix'], totals: { [medium]: 3 } })
      expect(session.observations[0]).toMatchObject({ eventId: 'a-count', status: 'ACCEPTED', effectiveQuantity: 3, corrections: [{ eventId: 'b-fix', quantity: 5, late: true }] })
    }
    expect(visible(await officer.snapshot())).toBe(visible(await assistant.snapshot()))
  })

  it('keeps a correction the finalizer had seen', async () => {
    const { replicas: [officer, assistant], medium } = await countingUnit()
    await officer.contributeCount('s', { itemId: medium }, 3, '', { eventId: 'a-count' })
    await assistant.receiveMany(await events(officer))
    await assistant.correctCount('s', 'a-count', 5, 'Recounted', { eventId: 'b-fix' })
    await officer.receiveMany(await events(assistant))
    await officer.finalizeCountSession('s', { eventId: 'z-finalize' })
    await exchange(officer, assistant)
    const state = await assistant.snapshot()
    expect(state.inventory.find(item => item.entityId === medium)?.onHand).toBe(5)
    expect(state.countSessions[0]).toMatchObject({ status: 'RECONCILED', lateEventIds: [] })
  })

  it('keeps the finalization when a recount of an assignment was not seen by the finalizer', async () => {
    const context = await unit(['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT'])
    const [officer, assistant] = context.replicas
    await officer.addCatalogSizes(PT_SHORTS, ['M'], { eventId: 'sizes' })
    const medium = (await officer.snapshot()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await officer.createCountSession({ sessionId: 's', scope: 'Shelves', assignments: [{ assignmentId: 'shelf-a', itemId: medium, scope: 'Shelf A' }] }, { eventId: 'session' })
    await officer.contributeCount('s', 'shelf-a', 3, '', { eventId: 'a-count' })
    await assistant.receiveMany(await events(officer))
    await assistant.recount('s', 'shelf-a', 8, 'Supervisor recount', { eventId: 'b-recount' })
    await officer.finalizeCountSession('s', { eventId: 'z-finalize' })
    const reversed = new ArgusReplica(new MemoryRepository(), context.identities[0], context.authorization, context.provider, ORG, { genesisCatalog: true })
    await reversed.initialize(); reversed.online = false
    await exchange(officer, assistant)
    await reversed.receiveMany([...(await events(officer))].reverse())
    for (const replica of [officer, assistant, reversed]) {
      const state = await replica.snapshot()
      expect(state.rejected).toEqual([])
      expect(state.inventory.find(item => item.entityId === medium)?.onHand).toBe(3)
      expect(state.countSessions[0]).toMatchObject({ status: 'RECONCILED', lateEventIds: ['b-recount'] })
      expect(state.countSessions[0].observations.find(observation => observation.eventId === 'a-count')?.status).toBe('ACCEPTED')
    }
    expect(visible(await officer.snapshot())).toBe(visible(await reversed.snapshot()))
  })

  it('treats a correction unseen by the submitter as late until an officer sends the count back', async () => {
    const { replicas: [officer, assistant, second], medium } = await countingUnit(['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT', 'SUPPLY_ASSISTANT'])
    await assistant.contributeCount('s', { itemId: medium }, 3, '', { eventId: 'a-count' })
    await second.receiveMany(await events(assistant))
    await second.correctCount('s', 'a-count', 4, 'Missed one', { eventId: 'b-fix' })
    await assistant.submitCountSession('s', { eventId: 'z-submit' })
    await exchange(officer, assistant, second)
    let session = (await officer.snapshot()).countSessions[0]
    expect(session).toMatchObject({ status: 'SUBMITTED', lateEventIds: ['b-fix'], totals: { [medium]: 3 } })
    await officer.reopenCountSession('s', 'Take the correction', { eventId: 'send-back' })
    session = (await officer.snapshot()).countSessions[0]
    expect(session).toMatchObject({ status: 'ACTIVE', lateEventIds: [], totals: { [medium]: 4 } })
    expect(session.observations[0]).toMatchObject({ status: 'CORRECTED', effectiveQuantity: 4 })
  })
})

describe('concurrent catalog item edits', () => {
  async function renames() {
    const { replicas: [a, b, c] } = await unit(['SUPPLY_OFFICER', 'SUPPLY_OFFICER', 'SUPPLY_OFFICER'])
    await a.updateCatalogItem(PT_SHORTS, { name: 'PT Shorts (Navy)' }, { eventId: 'a-rename' })
    await b.updateCatalogItem(PT_SHORTS, { name: 'Navy PT Shorts' }, { eventId: 'b-rename' })
    return { a, b, c }
  }

  it('turns two offline renames into one visible conflict with the same ID on every device, whatever the delivery order', async () => {
    const { a, b, c } = await renames()
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    await c.receiveMany([...(await events(a))].reverse())
    for (const replica of [a, b, c]) {
      const state = await replica.snapshot()
      // Same clock: 'a-rename' sorts first and stands; the rival is a conflict named after itself.
      expect(state.catalog.find(item => item.catalogId === PT_SHORTS)?.name).toBe('PT Shorts (Navy)')
      expect(state.conflicts).toEqual([{ id: 'conflict:b-rename', entityId: PT_SHORTS, eventIds: ['a-rename', 'b-rename'], status: 'OPEN', reason: 'Concurrent catalog item edits require reconciliation.' }])
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
    expect(visible(await b.snapshot())).toBe(visible(await c.snapshot()))
  })

  it('merges concurrent edits of different fields, and a later edit that saw the first applies normally', async () => {
    const { replicas: [a, b] } = await unit(['SUPPLY_OFFICER', 'SUPPLY_OFFICER'])
    await a.updateCatalogItem(PT_SHORTS, { name: 'Navy PT Shorts' }, { eventId: 'a-rename' })
    await b.updateCatalogItem(PT_SHORTS, { niin: '8415-01-123-4567' }, { eventId: 'b-niin' })
    await exchange(a, b)
    await b.updateCatalogItem(PT_SHORTS, { name: 'Navy PT Shorts (unisex)' }, { eventId: 'b-rename-after' })
    await exchange(a, b)
    for (const replica of [a, b]) {
      const state = await replica.snapshot()
      expect(state.catalog.find(item => item.catalogId === PT_SHORTS)).toMatchObject({ name: 'Navy PT Shorts (unisex)', niin: '8415-01-123-4567' })
      expect(state.conflicts).toEqual([])
    }
  })

  it('still applies legacy catalog edits that carry no base version, in canonical order', async () => {
    const { replicas: [a], identities: [identity] } = await unit(['SUPPLY_OFFICER'])
    await a.receiveMany([
      await forge(identity, { eventId: 'legacy-1', eventType: 'CATALOG_ITEM_UPDATED', entityId: PT_SHORTS, clock: 1, payload: { name: 'Legacy One' } }),
      await forge(identity, { eventId: 'legacy-2', eventType: 'CATALOG_ITEM_UPDATED', entityId: PT_SHORTS, clock: 1, payload: { name: 'Legacy Two' } }),
    ])
    const state = await a.snapshot()
    expect(state.catalog.find(item => item.catalogId === PT_SHORTS)?.name).toBe('Legacy Two')
    expect(state.conflicts).toEqual([])
  })
})
