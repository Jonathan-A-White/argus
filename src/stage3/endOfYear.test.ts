import { describe, expect, it } from 'vitest'
import { cadetByCode, demoUnit, oneSize, stockSizes } from '../test/supplyFixtures'
import { endOfYearReview, returnPendingCadets } from './endOfYear'

describe('End-of-Year review (spec §19)', () => {
  it('finds return-pending cadets: inactive cadets holding property, and NS4 cadets who graduate at rollover', async () => {
    const { controller } = await demoUnit()
    await controller.receiveStock(oneSize('Black Belt'), 5)
    let projection = await controller.importCadets([
      { gender: 'Male', nsLevel: 'NS4', cadetCode: 'C-M401' },
      { gender: 'Female', nsLevel: 'NS4', cadetCode: 'C-F401' },
      { gender: 'Male', nsLevel: 'NS2', cadetCode: 'C-M201' },
      { gender: 'Female', nsLevel: 'NS3', cadetCode: 'C-F301' },
    ])
    for (const code of ['C-M401', 'C-M201', 'C-F301']) await controller.issueTransaction({ transactionId: `tx-${code}`, cadetId: cadetByCode(projection, code).cadetId, lines: [{ lineId: 'belt', itemId: oneSize('Black Belt'), quantity: 1 }] })
    projection = await controller.updateCadet(cadetByCode(projection, 'C-F301').cadetId, { status: 'INACTIVE' })
    expect(returnPendingCadets(projection)).toEqual([
      { cadetId: cadetByCode(projection, 'C-F301').cadetId, label: 'C-F301', reason: 'INACTIVE', items: 1 },
      { cadetId: cadetByCode(projection, 'C-M401').cadetId, label: 'C-M401', reason: 'GRADUATING', items: 1 },
    ])
  })

  it('reports count coverage, discrepancies and the rollover checklist, and is ready once everything is closed', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 4 })
    await controller.createCountSession({ sessionId: 'eoy-1', scope: 'PT shorts only' })
    await controller.contributeCount('eoy-1', { itemId: ids.M }, 3)
    await controller.finalizeCountSession('eoy-1')
    await controller.createCountSession({ sessionId: 'eoy-open', scope: 'Left open' })
    let projection = await controller.project()

    let review = endOfYearReview(projection)
    const active = projection.inventory.filter(item => item.active)
    expect(review.coverage).toMatchObject({ counted: 1, total: active.length })
    expect(review.discrepancies).toEqual([expect.objectContaining({ itemId: ids.M, name: 'PT Shorts', variant: 'M', expected: 4, counted: 3, difference: -1, movement: false })])
    expect(review.checklist.map(check => [check.key, check.done])).toEqual([['conflicts', true], ['open-counts', false], ['returns', true], ['full-count', false]])
    expect(review).toMatchObject({ ready: false, percent: 50 })

    await controller.cancelCountSession('eoy-open', 'Replaced by the full count')
    await controller.createCountSession({ sessionId: 'eoy-full', scope: 'Everything' })
    for (const item of active) await controller.contributeCount('eoy-full', { itemId: item.entityId }, item.entityId === ids.M ? 3 : 0)
    projection = await controller.finalizeCountSession('eoy-full')
    review = endOfYearReview(projection)
    expect(review.coverage).toMatchObject({ counted: active.length, total: active.length, percent: 100 })
    // The newest finalized count is what matters: M now matches the records.
    expect(review.discrepancies).toEqual([])
    expect(review).toMatchObject({ ready: true, percent: 100 })
    expect(review.checklist.every(check => check.done)).toBe(true)
  })
})
