import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { GENESIS_CATALOG } from '../stage3/domain'
import { alerts, readiness } from '../stage3/readiness'
import { MemoryRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { DistributedAppController } from './appIntegration'
import type { ArgusRole } from './types'

const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId

async function pair(roles: ArgusRole[] = ['SUPPLY_OFFICER', 'SUPPLY_OFFICER']) {
  const root = new MockIdentityProvider('root'), authorization = new AuthorizationService(await root.getPublicIdentity(), root), provider = new MockSyncProvider()
  const controllers = []
  for (const [index, role] of roles.entries()) {
    const identity = new MockIdentityProvider(`person-${index}`)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: '2026-01-01T00:00:00.000Z' }))
    const controller = new DistributedAppController(new MemoryRepository(), { identity, authorization, provider, organizationId: 'unit-spec' })
    await controller.initialize(); controllers.push(controller)
  }
  return controllers
}

describe('supply calendar (spec §14–19)', () => {
  it('creates an NCO event from its template, syncs it, and tracks task completion on every device', async () => {
    const [a, b] = await pair()
    let projection = await a.createCalendarEvent({ kind: 'NCO', startsAt: '2026-08-15T12:00:00.000Z' })
    const nco = projection.calendar[0]
    expect(nco).toMatchObject({ title: 'New Cadet Orientation', bundleIds: ['bundle-pt', 'bundle-male-nsu', 'bundle-female-nsu'] })
    expect(nco.tasks.length).toBeGreaterThanOrEqual(8)
    await a.completeTask(nco.calendarEventId, nco.tasks[0].taskId)
    projection = await b.sync()
    expect(projection.calendar[0].tasks[0]).toMatchObject({ completed: true, completedBy: 'mock:person-0' })
    await b.updateCalendarEvent(nco.calendarEventId, { startsAt: '2026-08-22T12:00:00.000Z' })
    projection = await a.sync()
    expect(projection.calendar[0].startsAt).toBe('2026-08-22T12:00:00.000Z')
  })

  it('refuses calendar edits from roles without calendar.write', async () => {
    const [, assistant] = await pair(['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT'])
    await expect(assistant.createCalendarEvent({ kind: 'AMI', startsAt: '2026-03-01T12:00:00.000Z' })).rejects.toThrow(/calendar.write/)
  })
})

describe('size correction (spec §12)', () => {
  it('moves the cadet and the stock from 34R to 32R while keeping the original issue in history', async () => {
    const [a, b] = await pair()
    let projection = await a.addCatalogSizes(catalogId('Male SDB Jacket'), ['34R', '32R'])
    const [r34, r32] = ['34R', '32R'].map(size => projection.inventory.find(item => item.variant === size)!.entityId)
    await a.receiveStock(r34, 2); await a.receiveStock(r32, 2)
    projection = await a.createCadet({ gender: 'Male', nsLevel: 'NS3', status: 'ACTIVE' })
    const cadetId = projection.cadets[0].cadetId
    projection = await a.issueTransaction({ transactionId: 'tx', cadetId, lines: [{ lineId: 'jacket', itemId: r34, quantity: 1 }] })
    const property = projection.cadets[0].currentProperty[0]
    projection = await a.correctIssuedSize({ cadetId, propertyId: property.propertyId, toItemId: r32, reason: 'Recorded 34R; cadet wears 32R' })
    projection = await b.sync()
    expect(projection.cadets[0].currentProperty).toMatchObject([{ variant: '32R', quantity: 1 }])
    expect(projection.inventory.find(item => item.entityId === r34)).toMatchObject({ onHand: 2, issued: 0 })
    expect(projection.inventory.find(item => item.entityId === r32)).toMatchObject({ onHand: 1, issued: 1 })
    expect(projection.corrections).toMatchObject([{ fromItemId: r34, toItemId: r32, reason: 'Recorded 34R; cadet wears 32R' }])
    expect(projection.events.map(record => record.event.eventType)).toEqual(expect.arrayContaining(['ITEM_ISSUED', 'PROPERTY_CORRECTED']))
  })
})

describe('annual rollover and roster import', () => {
  it('imports an NS1 class by cadet ID, then advances levels and graduates NS4 on rollover exactly once', async () => {
    const [a, b] = await pair()
    let projection = await a.importCadets([{ gender: 'Male', nsLevel: 'NS1' }, { gender: 'Female', nsLevel: 'NS1', fullName: 'Encrypted Name' }, { gender: 'Female', nsLevel: 'NS4' }])
    expect(projection.cadets).toHaveLength(3)
    expect(projection.cadets.every(cadet => /^C-[0-9A-Z]{4}$/.test(cadet.cadetCode ?? ''))).toBe(true)
    await a.completeAnnualRollover('2026-2027')
    projection = await b.sync()
    expect(projection.cadets.map(cadet => [cadet.nsLevel, cadet.status]).sort()).toEqual([['NS2', 'ACTIVE'], ['NS2', 'ACTIVE'], ['NS4', 'INACTIVE']])
    expect(projection.rollovers).toMatchObject([{ schoolYear: '2026-2027', advanced: 2, graduated: 1 }])
    await expect(b.completeAnnualRollover('2026-2027')).rejects.toThrow(/already complete/)
  })
})

describe('readiness engine and alerts (spec §20, §35)', () => {
  it('derives readiness and actionable alerts from shared data', async () => {
    const [a] = await pair()
    let projection = await a.addCatalogSizes(catalogId('PT Shorts'), ['M'])
    const medium = projection.inventory.find(item => item.catalogId === catalogId('PT Shorts'))!.entityId
    await a.updateInventoryItem(medium, { reorderAt: 5 })
    await a.receiveStock(medium, 3)
    projection = await a.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    await a.addStillNeeded({ cadetId: projection.cadets[0].cadetId, displayLabel: 'Garrison Cap', quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-01T00:00:00.000Z', source: 'MANUAL' })
    const now = new Date('2026-09-27T12:00:00.000Z')
    projection = await a.createCalendarEvent({ kind: 'AMI', startsAt: '2026-10-05T12:00:00.000Z' })
    const breakdown = readiness(projection, now)
    expect(breakdown).toMatchObject({ cadets: 0, cadetsNeedingItems: 1, stockNeedingAttention: 1, inventory: 0, activePreparations: 1 })
    const list = alerts(projection, {}, now)
    expect(list.map(alert => alert.id)).toEqual(expect.arrayContaining(['low-stock', 'cadets-incomplete', 'sizes-not-set']))
    // The AMI count task was due 14 days before 5 Oct = 21 Sep: overdue on 27 Sep.
    expect(list.find(alert => alert.title.includes('physical count'))).toMatchObject({ severity: 'critical', target: { tab: 'calendar' } })
  })
})
