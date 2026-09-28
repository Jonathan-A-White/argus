import { describe, expect, it } from 'vitest'
import type { ArgusAppProjection } from '../distributed/appIntegration'
import { DAY, cadetByCode, demoUnit, stockSizes } from '../test/supplyFixtures'
import { AMI_CARD_DAYS, AMI_CRITICAL_DAYS, AMI_TOP_DAYS, amiProminence, amiReadiness, nextAmiEvent, type AmiCategoryKey } from './amiReadiness'

const category = (projection: ArgusAppProjection, key: AmiCategoryKey, sync = {}, now = new Date()) => amiReadiness(projection, sync, now).categories.find(entry => entry.key === key)!

describe('AMI readiness dashboard (spec §17)', () => {
  it('reports the six categories in order and averages them', async () => {
    const { projection } = await demoUnit()
    const report = amiReadiness(projection)
    expect(report.categories.map(entry => entry.label)).toEqual(['Inventory Count', 'Cadet Records', 'Outstanding Corrections', 'Still Needed', 'Audit Health', 'Synchronization Health'])
    expect(report.overall).toBe(Math.round(report.categories.reduce((sum, entry) => sum + entry.percent, 0) / 6))
  })

  it('Inventory Count: share of active sizes counted in a finalized count within the window', async () => {
    const { controller, projection: fresh } = await demoUnit()
    expect(category(fresh, 'inventory-count').percent).toBe(0)
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 2, L: 2 })
    await controller.createCountSession({ sessionId: 'count-pt', scope: 'PT shorts' })
    await controller.contributeCount('count-pt', { itemId: ids.M }, 2)
    await controller.contributeCount('count-pt', { itemId: ids.L }, 2)
    const projection = await controller.finalizeCountSession('count-pt')
    const active = projection.inventory.filter(item => item.active).length
    expect(category(projection, 'inventory-count')).toMatchObject({ percent: Math.round((100 * 2) / active), target: { tab: 'count' } })
    expect(category(projection, 'inventory-count').detail).toBe(`2 of ${active} active sizes counted in a finalized count in the last 30 days.`)
    // Outside the 30-day window the count no longer counts.
    expect(category(projection, 'inventory-count', {}, new Date(Date.now() + 31 * DAY)).percent).toBe(0)
  })

  it('Cadet Records: complete when the standard-issue sizes are known and the profile needs no review', async () => {
    const { controller } = await demoUnit()
    await stockSizes(controller, 'PT Shorts', { M: 1 })
    let projection = await controller.importCadets([
      { gender: 'Male', nsLevel: 'NS1', cadetCode: 'C-M001', sizes: { 'PT Shorts': 'M' } },
      { gender: 'Male', nsLevel: 'NS1', cadetCode: 'C-M002' },
      { gender: 'Female', nsLevel: 'NS2', cadetCode: 'C-F001', sizes: { 'PT Shorts': 'S' } },
    ])
    projection = await controller.updateCadet(cadetByCode(projection, 'C-F001').cadetId, { profileNeedsReview: true })
    const records = category(projection, 'cadet-records')
    expect(records.percent).toBe(33)
    expect(records.detail).toBe('1 of 3 active cadet records complete · 1 record missing sizes · 1 record flagged for review.')
    expect(records.target).toEqual({ tab: 'cadets' })
  })

  it('Outstanding Corrections: open conflicts, records not applied and count movement lower the score', async () => {
    const { projection } = await demoUnit()
    expect(category(projection, 'corrections')).toMatchObject({ percent: 100, detail: 'Nothing waiting for a decision.' })
    const withIssues: ArgusAppProjection = {
      ...projection,
      conflicts: [
        { id: 'c1', entityId: 'x', eventIds: [], status: 'OPEN', reason: 'Concurrent issue.' },
        { id: 'c2', entityId: 'y', eventIds: [], status: 'RESOLVED', reason: 'Concurrent return.' },
      ],
      rejected: [{ eventId: 'e1', eventType: 'ITEM_ISSUED', reason: 'Missing dependency.' }],
    }
    expect(category(withIssues, 'corrections')).toMatchObject({ percent: 33, detail: '1 open conflict · 1 record not applied.', target: { tab: 'more', panel: 'conflicts' } })
  })

  it('Still Needed and Audit Health follow open requirements and the integrity report', async () => {
    const { controller } = await demoUnit()
    let projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-M201' })
    expect(category(projection, 'still-needed')).toMatchObject({ percent: 100, detail: 'No open requirements.' })
    projection = await controller.addStillNeeded({ cadetId: cadetByCode(projection, 'C-M201').cadetId, displayLabel: 'Garrison Cap', quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-01T00:00:00.000Z', source: 'MANUAL' })
    expect(category(projection, 'still-needed')).toMatchObject({ percent: 0, detail: '1 open requirement · 0 of 1 fulfilled.', target: { tab: 'more', panel: 'needed' } })

    const healthy = category(projection, 'audit')
    const synced = projection.events.filter(record => record.syncStatus === 'SYNCHRONIZED').length
    expect(healthy.percent).toBe(Math.round((Math.round((100 * synced) / projection.events.length) + 100) / 2))
    const broken = { ...projection, integrity: { ...projection.integrity, healthy: false, issues: [{ code: 'ORPHAN_PROPERTY_ITEM', entityId: 'x', message: 'Missing inventory.' }] } }
    expect(category(broken, 'audit')).toMatchObject({ target: { tab: 'more', panel: 'diagnostics' } })
    expect(category(broken, 'audit').percent).toBeLessThanOrEqual(50)
  })

  it('Synchronization Health: queued records, funding and the age of the last chain scan', async () => {
    const { projection } = await demoUnit()
    expect(category(projection, 'sync')).toMatchObject({ percent: 100, detail: '2 of 2 checks pass: nothing waiting to publish · funded.' })
    expect(category(projection, 'sync', { needsFunding: true, queued: 3 }).percent).toBe(0)
    const remote: ArgusAppProjection = { ...projection, sync: { ...projection.sync, mode: 'remote' } }
    const now = new Date('2026-09-27T12:00:00.000Z')
    expect(category(remote, 'sync', { queued: 0, lastScanAt: '2026-09-27T11:55:00.000Z', state: 'idle' }, now)).toMatchObject({ percent: 100, detail: '3 of 3 checks pass: nothing waiting to publish · funded · last chain scan 5 min ago.' })
    expect(category(remote, 'sync', { queued: 2, lastScanAt: '2026-09-27T08:00:00.000Z' }, now)).toMatchObject({ percent: 33 })
    expect(category(remote, 'sync', { queued: 0 }, now).detail).toContain('no chain scan yet')
  })
})

describe('AMI prominence as the date approaches', () => {
  it('shows a card from 45 days, moves it to the top at 14 and turns critical at 3', () => {
    expect([AMI_CARD_DAYS, AMI_TOP_DAYS, AMI_CRITICAL_DAYS]).toEqual([45, 14, 3])
    expect(amiProminence(46)).toBe('hidden')
    expect(amiProminence(45)).toBe('card')
    expect(amiProminence(15)).toBe('card')
    expect(amiProminence(14)).toBe('top')
    expect(amiProminence(4)).toBe('top')
    expect(amiProminence(3)).toBe('critical')
    expect(amiProminence(0)).toBe('critical')
    expect(amiProminence(-1)).toBe('hidden')
  })

  it('finds the next active AMI on or after today', async () => {
    const { controller } = await demoUnit()
    await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 3, 2, 9).toISOString() })
    await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 10, 30, 9).toISOString() })
    let projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 12, 9).toISOString() })
    const now = new Date(2026, 8, 27, 14, 30)
    expect(nextAmiEvent(projection, now)).toMatchObject({ days: 15, event: { startsAt: new Date(2026, 9, 12, 9).toISOString() } })
    const october = projection.calendar.find(event => event.startsAt === new Date(2026, 9, 12, 9).toISOString())!
    projection = await controller.updateCalendarEvent(october.calendarEventId, { active: false })
    expect(nextAmiEvent(projection, now)?.days).toBe(64)
  })
})
