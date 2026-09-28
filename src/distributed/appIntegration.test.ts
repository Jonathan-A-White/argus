import { describe, expect, it } from 'vitest'
import { GENESIS_CATALOG } from '../stage3/domain'
import { MemoryRepository } from '../storage/repository'
import { DistributedAppController } from './appIntegration'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId

describe('application controller', () => {
  it('starts with no placeholder data: a zeroed specification catalog, no sizes, no cadets, no history', async () => {
    const projection = await new DistributedAppController(new MemoryRepository()).initialize()
    expect(projection.catalog.map(item => item.name)).toEqual(expect.arrayContaining(['PT Shorts', 'Gold PT Shirt', 'Black Oxfords', 'Male SDB Jacket', 'Garrison Cap']))
    expect(projection.inventory.every(item => item.onHand === 0 && item.issued === 0 && item.niin === '')).toBe(true)
    expect(projection.cadets).toEqual([])
    expect(projection.events).toEqual([])
    expect(projection.stillNeeded).toEqual([])
    expect(projection.integrity.healthy).toBe(true)
  })

  it('runs a shared count through the controller and finalizes on-hand to the counted total', async () => {
    const controller = new DistributedAppController(new MemoryRepository())
    await controller.initialize(); controller.setOnline(false)
    let projection = await controller.addCatalogSizes(PT_SHORTS, ['M'])
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await controller.createCountSession({ sessionId: 'count-1', scope: 'Fall count' })
    await controller.contributeCount('count-1', { itemId: medium }, 4, 'Top shelf')
    projection = await controller.contributeCount('count-1', { itemId: medium }, 2)
    expect(projection.countSessions[0].totals[medium]).toBe(6)
    projection = await controller.finalizeCountSession('count-1')
    expect(projection.inventory.find(item => item.entityId === medium)?.onHand).toBe(6)
    // Notes and names never surface in audit rows, only in the encrypted events.
    expect(projection.audit.every(row => !('note' in row.data) && !('fullName' in row.data))).toBe(true)
  })

  it('computes cadet readiness from all of the cadet’s requirements, not only open ones', async () => {
    const controller = new DistributedAppController(new MemoryRepository())
    await controller.initialize(); controller.setOnline(false)
    let projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    const cadetId = projection.cadets[0].cadetId
    const need = (label: string) => controller.addStillNeeded({ cadetId, displayLabel: label, quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-01T00:00:00.000Z', source: 'MANUAL' })
    await need('Garrison Cap'); projection = await need('PT Shorts')
    const [first] = projection.stillNeeded
    projection = await controller.updateStillNeeded(first.requirementId, { quantityFulfilled: 1, status: 'FULFILLED' })
    expect(projection.cadets[0].readiness).toMatchObject({ status: 'INCOMPLETE', fulfilled: 1, total: 2, percent: 50 })
  })
})
