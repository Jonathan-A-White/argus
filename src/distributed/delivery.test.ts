import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { GENESIS_CATALOG } from '../stage3/domain'
import { auditSummary, readiness } from '../stage3/readiness'
import { MemoryRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { envelopeDelivery } from '../unit/syncProvider'
import { DistributedAppController } from './appIntegration'
import { isVerified } from './delivery'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId

async function pair() {
  const root = new MockIdentityProvider('root'), authorization = new AuthorizationService(await root.getPublicIdentity(), root), provider = new MockSyncProvider()
  const controllers: DistributedAppController[] = []
  for (const name of ['officer-a', 'officer-b']) {
    const identity = new MockIdentityProvider(name)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2026-01-01T00:00:00.000Z' }))
    const controller = new DistributedAppController(new MemoryRepository(), { identity, authorization, provider, organizationId: 'unit-delivery' })
    await controller.initialize(); controllers.push(controller)
  }
  return controllers
}

describe('per-record sync status from the ledger envelope (spec §22)', () => {
  it('maps every envelope state to the status and verification the app shows', () => {
    expect(envelopeDelivery({ status: 'QUEUED' })).toEqual({ syncStatus: 'QUEUED', auditStatus: 'PENDING' })
    expect(envelopeDelivery({ status: 'QUEUED', lastError: 'FakeChain: injected rejected.' })).toEqual({ syncStatus: 'FAILED', auditStatus: 'FAILED', lastError: 'FakeChain: injected rejected.' })
    expect(envelopeDelivery({ status: 'PUBLISHING', txid: 'aa' })).toEqual({ syncStatus: 'SYNCING', auditStatus: 'PENDING' })
    expect(envelopeDelivery({ status: 'BROADCAST', txid: 'aa' })).toEqual({ syncStatus: 'SYNCHRONIZED', auditStatus: 'BROADCAST', transactionId: 'aa' })
    expect(envelopeDelivery({ status: 'CONFIRMED', txid: 'aa', height: 0 })).toEqual({ syncStatus: 'SYNCHRONIZED', auditStatus: 'BROADCAST', transactionId: 'aa' })
    expect(envelopeDelivery({ status: 'CONFIRMED', txid: 'aa', height: 1760183 })).toEqual({ syncStatus: 'SYNCHRONIZED', auditStatus: 'CONFIRMED', transactionId: 'aa', blockHeight: 1760183 })
    // VERIFIED means mined with a known block, never merely broadcast.
    expect(isVerified({ auditStatus: 'BROADCAST' })).toBe(false)
    expect(isVerified({ auditStatus: 'CONFIRMED' })).toBe(false)
    expect(isVerified({ auditStatus: 'CONFIRMED', blockHeight: 1760183 })).toBe(true)
  })

  it('mock mode (no chain) shows every record as LOCAL and never counts it as verified', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    expect(projection.events.map(record => record.syncStatus)).toEqual(['LOCAL'])
    expect(projection.events[0]).toMatchObject({ auditStatus: 'NOT_SUBMITTED' })
    expect(projection.events[0].transactionId).toBeUndefined()
    expect(projection.sync.outbox).toBe(0)
    expect(auditSummary(projection)).toEqual({ total: 1, verified: 0, awaitingBlock: 0, notOnChain: 1 })
    expect(readiness(projection).audit).toBe(0)
  })

  it('a record that lost an open conflict shows CONFLICT on every device until the conflict is resolved', async () => {
    const [a, b] = await pair()
    let projection = await a.addCatalogSizes(PT_SHORTS, ['M'])
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await a.receiveStock(medium, 1)
    const cadetId = (await a.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE' })).cadets[0].cadetId
    await b.sync()
    // Both officers issue the last pair while offline.
    a.setOnline(false); b.setOnline(false)
    await a.issueTransaction({ transactionId: 'issue-a', cadetId, lines: [{ lineId: 'l1', itemId: medium, quantity: 1 }] })
    await b.issueTransaction({ transactionId: 'issue-b', cadetId, lines: [{ lineId: 'l1', itemId: medium, quantity: 1 }] })
    expect((await a.project()).events.find(record => record.event.entityId === 'issue-a')?.syncStatus).toBe('QUEUED')
    a.setOnline(true); b.setOnline(true)
    await a.sync(); await b.sync(); await a.sync()
    for (const controller of [a, b]) {
      projection = await controller.project()
      const conflict = projection.conflicts.find(candidate => candidate.status === 'OPEN')!
      const winner = projection.transactions.find(transaction => ['issue-a', 'issue-b'].includes(transaction.transactionId))!.eventId
      const loser = conflict.eventIds.find(id => id !== winner)!
      expect(projection.events.find(record => record.event.eventId === loser)?.syncStatus).toBe('CONFLICT')
      expect(projection.events.find(record => record.event.eventId === winner)?.syncStatus).toBe('LOCAL')
    }
    projection = await a.resolveConflict(projection.conflicts[0].id, 'Second pair ordered.')
    expect(projection.events.filter(record => record.syncStatus === 'CONFLICT')).toEqual([])
  })
})
