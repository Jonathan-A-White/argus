import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { DistributedAppController } from '../distributed/appIntegration'
import type { InventoryProjection } from '../distributed/types'
import { MockIdentityProvider } from '../identity/identity'
import { MemoryRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { GENESIS_CATALOG } from './domain'
import { describeReconciliation, inventoryStatus, inventoryStatuses, isCountDue, stockLevel } from './inventoryStatus'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const DAY = 86_400_000
const variant = (overrides: Partial<InventoryProjection> = {}): InventoryProjection => ({ entityId: 'shorts-m', catalogId: PT_SHORTS, name: 'PT Shorts', category: 'PT', variant: 'M', niin: '', onHand: 10, issued: 0, countIncrement: 1, active: true, version: 1, appliedEventIds: [], ...overrides })
const empty = { conflicts: [], countSessions: [] }

async function officers(count = 2) {
  const root = new MockIdentityProvider('status-root'), authorization = new AuthorizationService(await root.getPublicIdentity(), root), provider = new MockSyncProvider()
  const controllers: DistributedAppController[] = []
  for (let index = 0; index < count; index++) {
    const identity = new MockIdentityProvider(`status-officer-${index}`)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2026-01-01T00:00:00.000Z' }))
    const controller = new DistributedAppController(new MemoryRepository(), { identity, authorization, provider, organizationId: 'unit-status' })
    await controller.initialize(); controllers.push(controller)
  }
  return controllers
}

describe('stock level', () => {
  it('matches the existing Low / Out rules and treats zero with nothing issued as not stocked', () => {
    expect(stockLevel(variant())).toBe('HEALTHY')
    expect(stockLevel(variant({ reorderAt: 10 }))).toBe('LOW')
    expect(stockLevel(variant({ onHand: 0, reorderAt: 2 }))).toBe('OUT_OF_STOCK')
    expect(stockLevel(variant({ onHand: 0, issued: 3 }))).toBe('OUT_OF_STOCK')
    expect(stockLevel(variant({ onHand: 0 }))).toBe('NOT_STOCKED')
    expect(stockLevel(variant({ active: false, onHand: 0, issued: 3 }))).toBe('INACTIVE')
  })
})

describe('Count Due', () => {
  const now = Date.parse('2026-06-30T12:00:00.000Z')
  it('is due when never counted or counted longer ago than the interval (default 90 days)', () => {
    expect(isCountDue(variant(), now)).toBe(true)
    expect(isCountDue(variant({ lastCountedAt: new Date(now - 30 * DAY).toISOString() }), now)).toBe(false)
    expect(isCountDue(variant({ lastCountedAt: new Date(now - 90 * DAY).toISOString() }), now)).toBe(false)
    expect(isCountDue(variant({ lastCountedAt: new Date(now - 91 * DAY).toISOString() }), now)).toBe(true)
    expect(isCountDue(variant({ lastCountedAt: new Date(now - 31 * DAY).toISOString() }), now, 30)).toBe(true)
    expect(isCountDue(variant({ active: false }), now)).toBe(false)
  })

  it('reports days since the count and lists every label, most urgent first', () => {
    const status = inventoryStatus(variant({ reorderAt: 12, lastCountedAt: new Date(now - 120 * DAY).toISOString(), lastCountEventId: 'finalize' }), empty, new Date(now))
    expect(status).toMatchObject({ stock: 'LOW', stockAttention: true, countDue: true, daysSinceCount: 120, lastCountEventId: 'finalize', reconciliationRequired: false, labels: ['Low', 'Count due'] })
    expect(inventoryStatus(variant({ lastCountedAt: new Date(now - DAY).toISOString() }), empty, now)).toMatchObject({ countDue: false, labels: ['Healthy'] })
  })

  it('clears once a real count is finalized, using the finalizing event’s time', async () => {
    const [officer] = await officers(1)
    await officer.addCatalogSizes(PT_SHORTS, ['M'])
    let projection = await officer.createCountSession({ sessionId: 'count', scope: 'Spring' })
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS)!
    expect(inventoryStatus(medium, projection).countDue).toBe(true)
    await officer.contributeCount('count', { itemId: medium.entityId }, 4)
    projection = await officer.finalizeCountSession('count')
    const counted = projection.inventory.find(item => item.entityId === medium.entityId)!
    const finalize = projection.countSessions[0]
    expect(counted).toMatchObject({ lastCountedAt: finalize.reconciledAt, lastCountEventId: finalize.reconciledEventId })
    expect(inventoryStatus(counted, projection).countDue).toBe(false)
    expect(inventoryStatus(counted, projection, Date.parse(finalize.reconciledAt!) + 100 * DAY).countDue).toBe(true)
  })
})

describe('Reconciliation Required', () => {
  it('flags both sizes of a concurrent issue of the last unit (an open conflict) until it is resolved', async () => {
    const [a, b] = await officers()
    let projection = await a.addCatalogSizes(PT_SHORTS, ['M'])
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await a.receiveStock(medium, 1)
    projection = await a.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    const first = projection.cadets[0].cadetId
    projection = await a.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE' })
    const second = projection.cadets.find(cadet => cadet.cadetId !== first)!.cadetId
    await b.sync()
    a.setOnline(false); b.setOnline(false)
    await a.issueTransaction({ transactionId: 'tx-a', cadetId: first, lines: [{ lineId: 'l', itemId: medium, quantity: 1 }] })
    await b.issueTransaction({ transactionId: 'tx-b', cadetId: second, lines: [{ lineId: 'l', itemId: medium, quantity: 1 }] })
    a.setOnline(true); b.setOnline(true)
    await a.sync(); await b.sync(); projection = await a.sync()
    const conflict = projection.conflicts.find(candidate => candidate.status === 'OPEN')!
    const status = inventoryStatus(projection.inventory.find(item => item.entityId === medium)!, projection)
    expect(status.reconciliationRequired).toBe(true)
    expect(status.reconciliation).toEqual([{ kind: 'CONFLICT', conflictId: conflict.id, detail: conflict.reason }])
    expect(status.labels[0]).toBe('Reconciliation required')
    projection = await a.resolveConflict(conflict.id, 'Second cadet gets the next delivery')
    expect(inventoryStatus(projection.inventory.find(item => item.entityId === medium)!, projection).reconciliationRequired).toBe(false)
  })

  it('flags a catalog item’s sizes while two edits of its details conflict', async () => {
    const [a, b] = await officers()
    await a.addCatalogSizes(PT_SHORTS, ['M']); await b.sync()
    a.setOnline(false); b.setOnline(false)
    await a.updateCatalogItem(PT_SHORTS, { name: 'Navy PT Shorts' })
    await b.updateCatalogItem(PT_SHORTS, { name: 'PT Shorts (Navy)' })
    a.setOnline(true); b.setOnline(true)
    await a.sync(); await b.sync()
    const projection = await a.sync()
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS)!
    expect(inventoryStatus(medium, projection).reconciliation).toMatchObject([{ kind: 'CONFLICT' }])
  })

  it('flags stock that moves while a count of that size is open, and after finalization until it is recounted', async () => {
    const [officer] = await officers(1)
    let projection = await officer.addCatalogSizes(PT_SHORTS, ['S', 'M'])
    const [small, medium] = ['S', 'M'].map(size => projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === size)!.entityId)
    await officer.createCountSession({ sessionId: 'count', scope: 'Spring' })
    await officer.contributeCount('count', { itemId: medium }, 4)
    projection = await officer.receiveStock(medium, 2, 'Delivery during count')
    await officer.receiveStock(small, 1)
    projection = await officer.project()
    const statuses = inventoryStatuses(projection.inventory, projection)
    expect(statuses.get(medium)?.reconciliation).toEqual([{ kind: 'MOVED_DURING_COUNT', sessionId: 'count', scope: 'Spring', open: true }])
    // S moved too, but nobody is counting it, so finalizing would not touch it.
    expect(statuses.get(small)?.reconciliationRequired).toBe(false)

    projection = await officer.finalizeCountSession('count')
    const after = inventoryStatus(projection.inventory.find(item => item.entityId === medium)!, projection)
    expect(after.reconciliation).toEqual([{ kind: 'MOVED_DURING_COUNT', sessionId: 'count', scope: 'Spring', open: false }])
    expect(describeReconciliation(after.reconciliation[0])).toMatch(/recount to confirm/)

    await officer.createCountSession({ sessionId: 'recount', scope: 'Recount M' })
    await officer.contributeCount('recount', { itemId: medium }, 6)
    projection = await officer.finalizeCountSession('recount')
    expect(inventoryStatus(projection.inventory.find(item => item.entityId === medium)!, projection).reconciliationRequired).toBe(false)
  })

  it('flags late contributions to a finalized count until the size is counted again', async () => {
    const [a, b] = await officers()
    let projection = await a.addCatalogSizes(PT_SHORTS, ['M'])
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await a.createCountSession({ sessionId: 'count', scope: 'Spring' })
    await b.sync()
    b.setOnline(false)
    await b.contributeCount('count', { itemId: medium }, 5)
    await a.contributeCount('count', { itemId: medium }, 3)
    await a.finalizeCountSession('count')
    b.setOnline(true); await b.sync()
    projection = await a.sync()
    const late = projection.countSessions[0].lateEventIds
    expect(late).toHaveLength(1)
    expect(inventoryStatus(projection.inventory.find(item => item.entityId === medium)!, projection).reconciliation).toEqual([{ kind: 'LATE_COUNT', sessionId: 'count', scope: 'Spring', eventIds: late }])
  })

  it('never flags an inactive size', () => {
    const conflicts = [{ id: 'conflict:x', entityId: 'shorts-m', eventIds: ['x'], status: 'OPEN' as const, reason: 'Test' }]
    expect(inventoryStatus(variant({ active: false }), { conflicts, countSessions: [] }).reconciliationRequired).toBe(false)
    expect(inventoryStatus(variant(), { conflicts, countSessions: [] }).reconciliationRequired).toBe(true)
  })
})
