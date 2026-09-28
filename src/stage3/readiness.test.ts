import { describe, expect, it } from 'vitest'
import type { ArgusAppProjection } from '../distributed/appIntegration'
import type { MemberProjection } from '../distributed/types'
import { DAY, cadetByCode, demoUnit, oneSize, stockSizes } from '../test/supplyFixtures'
import { READINESS_WEIGHTS, alerts, cadetFullyIssued, inventoryNeeds, readiness, standardIssueGaps, stockNeedsAttention, validReadinessWeights } from './readiness'

/** Local 27 Sep 2026, 14:30. */
const NOW = new Date(2026, 8, 27, 14, 30)
const FEMALE_STANDARD_ISSUE = ['Gold PT Shirt', 'PT Shorts', 'Khaki Ball Cap', 'Khaki Overblouse', 'Black Slacks', 'Garrison Cap', 'Black Oxfords', 'Pumps']

describe('cadet readiness (spec §35) comes from the bundles that apply to each cadet', () => {
  it('counts a new cadet with nothing issued as NOT ready, even with no Still Needed records', async () => {
    const { controller } = await demoUnit()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-M001' })
    const cadet = cadetByCode(projection, 'C-M001')
    expect(cadet.stillNeededCount).toBe(0)
    expect(cadetFullyIssued(cadet, projection)).toBe(false)
    // Male NSU + PT (by gender applicability and purpose, not by name): 8 + 3 items.
    expect(standardIssueGaps(cadet, projection).map(item => item.label).sort()).toEqual(['Black Belt', 'Black Oxfords', 'Black Socks', 'Black Trousers', 'Buckle', 'Garrison Cap', 'Gold PT Shirt', 'Khaki Ball Cap', 'Male Khaki Shirt', 'PT Shorts', 'White Dress Shirt'])
    expect(readiness(projection, NOW)).toMatchObject({ cadets: 0, cadetsNeedingItems: 1, activeCadets: 1 })
    expect(alerts(projection, {}, NOW).find(alert => alert.id === 'cadets-incomplete')).toMatchObject({ title: '1 cadet still needs items', target: { tab: 'cadets', cadetId: cadet.cadetId } })
  })

  it('counts a cadet holding every standard-issue item for their gender as ready, and an open Still Needed makes them not ready again', async () => {
    const { controller } = await demoUnit()
    const lines: Array<{ lineId: string; itemId: string; quantity: number }> = []
    for (const name of FEMALE_STANDARD_ISSUE) {
      const { ids } = await stockSizes(controller, name, { M: 2 })
      lines.push({ lineId: name, itemId: ids.M, quantity: 1 })
    }
    let projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-F001' })
    const cadetId = cadetByCode(projection, 'C-F001').cadetId
    projection = await controller.issueTransaction({ transactionId: 'tx-female-standard', cadetId, lines })
    // Female cadets need neither the Buckle nor the Male Khaki Shirt of the Male NSU bundle.
    expect(standardIssueGaps(cadetByCode(projection, 'C-F001'), projection)).toEqual([])
    expect(readiness(projection, NOW)).toMatchObject({ cadets: 100, cadetsNeedingItems: 0 })
    expect(alerts(projection, {}, NOW).some(alert => alert.id === 'cadets-incomplete')).toBe(false)

    projection = await controller.addStillNeeded({ cadetId, displayLabel: 'Garrison Cap', quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-01T00:00:00.000Z', source: 'MANUAL' })
    expect(readiness(projection, NOW)).toMatchObject({ cadets: 0, cadetsNeedingItems: 1 })
  })

  it('ignores inactive cadets', async () => {
    const { controller } = await demoUnit()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS4', status: 'INACTIVE', cadetCode: 'C-M400' })
    expect(readiness(projection, NOW)).toMatchObject({ cadets: 100, cadetsNeedingItems: 0, activeCadets: 0 })
  })
})

describe('inventory readiness scores the sizes bundles need', () => {
  it('never scores an all-zero unit as 100%', async () => {
    const { projection } = await demoUnit()
    const result = readiness(projection, NOW)
    expect(result.inventoryNeeded).toBeGreaterThan(0)
    expect(result.inventory).toBe(0)
    // Sized items without sizes are one unready line each; unsized items are empty.
    const needs = inventoryNeeds(projection)
    expect(needs.find(line => line.name === 'PT Shorts')).toMatchObject({ reason: 'NO_SIZES', ready: false })
    expect(needs.find(line => line.name === 'Buckle')).toMatchObject({ reason: 'EMPTY', ready: false })
  })

  it('counts a stocked size as ready only above its threshold and when it covers cadets waiting for that size', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 1, L: 4 })
    await controller.updateInventoryItem(ids.L, { reorderAt: 4 })
    await controller.importCadets([{ gender: 'Male', nsLevel: 'NS1', cadetCode: 'C-M001', sizes: { 'PT Shorts': 'M' } }, { gender: 'Female', nsLevel: 'NS1', cadetCode: 'C-F001', sizes: { 'PT Shorts': 'M', 'Gold PT Shirt': 'XS' } }])
    const projection = await controller.project()
    const needs = inventoryNeeds(projection)
    expect(needs.find(line => line.itemId === ids.M)).toMatchObject({ onHand: 1, demand: 2, reason: 'SHORT', ready: false })
    expect(needs.find(line => line.itemId === ids.L)).toMatchObject({ onHand: 4, reason: 'LOW', ready: false })
    // A recorded size the unit does not stock is its own unready line.
    expect(needs.find(line => line.name === 'Gold PT Shirt' && line.variant === 'XS')).toMatchObject({ reason: 'NOT_STOCKED', demand: 1 })

    const restocked = await controller.receiveStock(ids.M, 1)
    expect(inventoryNeeds(restocked).find(line => line.itemId === ids.M)).toMatchObject({ onHand: 2, reason: 'READY', ready: true })
    const result = readiness(restocked, NOW)
    expect(result.inventory).toBe(Math.round((100 * result.inventoryReady) / result.inventoryNeeded))
    expect(result.inventory).toBeGreaterThan(0)
    expect(result.inventory).toBeLessThan(100)
  })
})

describe('readiness weights (per device)', () => {
  it('weights the overall score and falls back to equal weights when invalid', async () => {
    const { controller } = await demoUnit()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    const equal = readiness(projection, NOW)
    expect(equal.weights).toEqual(READINESS_WEIGHTS)
    expect(equal.overall).toBe(Math.round((equal.cadets + equal.inventory + equal.events + equal.audit) / 4))

    const auditOnly = readiness(projection, NOW, { weights: { cadets: 0, inventory: 0, events: 0, audit: 1 } })
    expect(auditOnly.overall).toBe(equal.audit)
    const weighted = readiness(projection, NOW, { weights: { cadets: 3, inventory: 1, events: 0, audit: 0 } })
    expect(weighted.overall).toBe(Math.round((3 * equal.cadets + equal.inventory) / 4))
    expect(readiness(projection, NOW, { weights: { cadets: 0, inventory: 0, events: 0, audit: 0 } }).overall).toBe(equal.overall)
  })

  it('validates weights: finite, 0–10, and summing above zero', () => {
    expect(validReadinessWeights({ cadets: 1, inventory: 2, events: 0, audit: 0.5 })).toBe(true)
    expect(validReadinessWeights({ cadets: 0, inventory: 0, events: 0, audit: 0 })).toBe(false)
    expect(validReadinessWeights({ cadets: -1, inventory: 2, events: 1, audit: 1 })).toBe(false)
    expect(validReadinessWeights({ cadets: 11, inventory: 2, events: 1, audit: 1 })).toBe(false)
    expect(validReadinessWeights({ cadets: Number.NaN, inventory: 2, events: 1, audit: 1 })).toBe(false)
    expect(validReadinessWeights({ cadets: 1, inventory: 2, events: 1 })).toBe(false)
    expect(validReadinessWeights(null)).toBe(false)
  })
})

describe('alerts (spec §20 tier 1)', () => {
  it('raises out of stock for a size with a threshold, nothing on hand and nothing issued (the old silent case)', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 0 })
    const projection = await controller.updateInventoryItem(ids.M, { reorderAt: 2 })
    const item = projection.inventory.find(candidate => candidate.entityId === ids.M)!
    expect(item).toMatchObject({ onHand: 0, issued: 0, reorderAt: 2 })
    expect(stockNeedsAttention(item)).toBe(true)
    expect(readiness(projection, NOW).stockNeedingAttention).toBe(1)
    const out = alerts(projection, {}, NOW).find(alert => alert.id === 'out-of-stock')
    expect(out).toMatchObject({ severity: 'critical', title: '1 size out of stock', target: { tab: 'inventory', filter: 'attention', itemId: ids.M } })
    expect(alerts(projection, {}, NOW).some(alert => alert.id === 'low-stock')).toBe(false)
  })

  it('lists several low sizes with the inventory attention filter as the target', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 2, L: 1 })
    await controller.updateInventoryItem(ids.M, { reorderAt: 3 })
    const projection = await controller.updateInventoryItem(ids.L, { reorderAt: 3 })
    expect(alerts(projection, {}, NOW).find(alert => alert.id === 'low-stock')).toMatchObject({ severity: 'warning', title: '2 sizes low on stock', target: { tab: 'inventory', filter: 'attention' } })
  })

  it('raises overdue returns for BLT attendees still holding BLT gear after the event, and for inactive cadets holding property', async () => {
    const { controller } = await demoUnit()
    await controller.receiveStock(oneSize('Khaki Belt'), 3)
    let projection = await controller.importCadets([{ gender: 'Male', nsLevel: 'NS2', cadetCode: 'C-M201' }, { gender: 'Female', nsLevel: 'NS3', cadetCode: 'C-F301' }])
    const attendee = cadetByCode(projection, 'C-M201'), leaver = cadetByCode(projection, 'C-F301')
    const bltDay = new Date(2026, 8, 20, 9).toISOString()
    projection = await controller.createCalendarEvent({ kind: 'BLT', startsAt: bltDay, cadetIds: [attendee.cadetId] })
    const blt = projection.calendar[0]
    await controller.issueTransaction({ transactionId: 'tx-blt', cadetId: attendee.cadetId, bundleId: 'bundle-blt', bundleVersion: 1, lines: [{ lineId: 'belt', itemId: oneSize('Khaki Belt'), quantity: 1 }] }, { timestamp: new Date(2026, 8, 17).toISOString() })
    await controller.issueTransaction({ transactionId: 'tx-leaver', cadetId: leaver.cadetId, lines: [{ lineId: 'belt', itemId: oneSize('Khaki Belt'), quantity: 1 }] })
    projection = await controller.updateCadet(leaver.cadetId, { status: 'INACTIVE' })

    // The day before the event nothing is overdue yet.
    expect(alerts(projection, {}, new Date(2026, 8, 19, 12)).some(alert => alert.id.startsWith('overdue-return-'))).toBe(false)
    const list = alerts(projection, {}, NOW)
    expect(list.find(alert => alert.id === `overdue-return-${blt.calendarEventId}`)).toMatchObject({ severity: 'warning', detail: 'C-M201 (1 item)', target: { tab: 'calendar', calendarEventId: blt.calendarEventId } })
    expect(list.find(alert => alert.id === 'inactive-holding')).toMatchObject({ title: '1 inactive cadet still holds property', target: { tab: 'cadets', cadetId: leaver.cadetId } })
  })

  it('raises count discrepancies and reconciliation-required from the shared counts', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 5, L: 3 })
    await controller.createCountSession({ sessionId: 'count-1', scope: 'PT shelf' })
    await controller.contributeCount('count-1', { itemId: ids.M }, 4)
    await controller.contributeCount('count-1', { itemId: ids.L }, 3)
    await controller.receiveStock(ids.L, 1) // stock moves while L is being counted
    await controller.finalizeCountSession('count-1')
    await controller.createCountSession({ sessionId: 'count-2', scope: 'Covers' })
    await controller.contributeCount('count-2', { itemId: oneSize('Buckle') }, 1)
    await controller.submitCountSession('count-2')
    await controller.createCountSession({ sessionId: 'count-3', scope: 'Footwear' })
    const projection = await controller.project()

    const now = new Date(Date.now() + 8 * DAY)
    const list = alerts(projection, {}, now)
    expect(list.find(alert => alert.id === 'count-discrepancy')).toMatchObject({ severity: 'warning', detail: '1 size counted differently from the records · 1 size moved while being counted.', target: { tab: 'count' } })
    const reconcile = list.find(alert => alert.id === 'reconciliation-required')!
    expect(reconcile).toMatchObject({ title: 'Reconciliation required: 2 counts', target: { tab: 'count' } })
    expect(reconcile.detail).toContain('Covers — submitted, not finalized')
    expect(reconcile.detail).toContain('Footwear — open 8 days')
    // A count opened today is not stale yet.
    expect(alerts(projection, {}, new Date()).find(alert => alert.id === 'reconciliation-required')?.title).toBe('Reconciliation required: 1 count')
  })

  it('warns as an event approaches with low readiness, and turns AMI gaps into critical alerts in the last three days', async () => {
    const { controller } = await demoUnit()
    let projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 7, 9).toISOString() })
    const ami = projection.calendar[0]
    expect(alerts(projection, {}, NOW).some(alert => alert.id.startsWith('event-') || alert.id.startsWith('ami-'))).toBe(false)

    const fiveDaysOut = new Date(2026, 9, 2, 10)
    expect(alerts(projection, {}, fiveDaysOut).find(alert => alert.id === `event-${ami.calendarEventId}`)).toMatchObject({ severity: 'critical', target: { tab: 'calendar', calendarEventId: ami.calendarEventId } })
    expect(alerts(projection, {}, fiveDaysOut).some(alert => alert.id.startsWith('ami-'))).toBe(false)

    const twoDaysOut = new Date(2026, 9, 5, 10)
    const amiAlerts = alerts(projection, {}, twoDaysOut).filter(alert => alert.id.startsWith(`ami-${ami.calendarEventId}-`))
    expect(amiAlerts.map(alert => alert.id)).toContain(`ami-${ami.calendarEventId}-inventory-count`)
    expect(amiAlerts.every(alert => alert.severity === 'critical')).toBe(true)
    expect(amiAlerts.find(alert => alert.id.endsWith('inventory-count'))).toMatchObject({ title: 'AMI in 2 days: Inventory Count 0%', target: { tab: 'count' } })

    // A custom event with nothing to prepare is ready: only an info reminder.
    projection = await controller.createCalendarEvent({ kind: 'CUSTOM', title: 'Color guard fitting', startsAt: new Date(2026, 8, 30, 9).toISOString(), tasks: [] })
    const custom = projection.calendar.find(event => event.kind === 'CUSTOM')!
    expect(alerts(projection, {}, NOW).find(alert => alert.id === `event-${custom.calendarEventId}`)).toMatchObject({ severity: 'info', title: 'Color guard fitting in 3 days — ready' })
  })

  it('reports authorization changes, expiring credentials and this device’s removal', async () => {
    const { projection } = await demoUnit()
    const member = (overrides: Partial<MemberProjection>): MemberProjection => ({ publicIdentity: 'mock:someone', displayName: 'Someone', role: 'SUPPLY_OFFICER', credentialId: 'cred', issuedAt: '2026-01-01T00:00:00.000Z', admittedBy: 'mock:master', admittedEventId: 'admit-old', status: 'ACTIVE', ...overrides })
    const members: MemberProjection[] = [
      member({ publicIdentity: 'mock:founder', displayName: 'Chief', admittedBy: 'mock:founder', issuedAt: '2026-09-26T00:00:00.000Z', admittedEventId: 'admit-founder' }),
      member({ publicIdentity: 'mock:jordan', displayName: 'Jordan', issuedAt: '2026-09-25T00:00:00.000Z', admittedEventId: 'admit-jordan', expiresAt: '2026-10-05T00:00:00.000Z' }),
      member({ publicIdentity: 'mock:riley', displayName: 'Riley', roleChangedAt: '2026-09-26T12:00:00.000Z' }),
      member({ publicIdentity: 'mock:sam', displayName: 'Sam', status: 'REVOKED', revokedAt: '2026-09-24T12:00:00.000Z' }),
      member({ publicIdentity: 'mock:old', displayName: 'Old timer', roleChangedAt: '2026-08-01T00:00:00.000Z' }),
    ]
    const list = alerts({ ...projection, members }, {}, NOW)
    const changes = list.find(alert => alert.id === 'authorization-changes')!
    expect(changes).toMatchObject({ severity: 'info', title: '3 access changes this week', target: { tab: 'more', panel: 'members' } })
    expect(changes.detail).toBe('Jordan admitted, Riley’s role changed, Sam removed')
    expect(list.find(alert => alert.id === 'credentials-expiring')).toMatchObject({ severity: 'warning', title: '1 credential expiring within 14 days', target: { tab: 'more', panel: 'members' } })
    expect(list.some(alert => alert.id === 'device-removed')).toBe(false)

    const removed = alerts({ ...projection, members: [...members, member({ publicIdentity: projection.actor, status: 'REVOKED', revokedAt: '2026-09-27T08:00:00.000Z' })] }, {}, NOW)
    expect(removed[0]).toMatchObject({ id: 'device-removed', severity: 'critical' })
    expect(alerts(projection, { revoked: true }, NOW)[0].id).toBe('device-removed')
  })

  it('raises integrity failures, unreadable records and failed broadcasts', async () => {
    const { controller } = await demoUnit()
    const base = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    const broken: ArgusAppProjection = {
      ...base,
      integrity: { ...base.integrity, healthy: false, issues: [{ code: 'ORPHAN_PROPERTY_ITEM', entityId: 'cadet-x', message: 'Current property references missing inventory.' }] },
      events: base.events.map((record, index) => (index === 0 ? { ...record, syncStatus: 'FAILED' as const } : record)),
    }
    const list = alerts(broken, { unreadable: 2 }, NOW)
    expect(list.find(alert => alert.id === 'integrity')).toMatchObject({ severity: 'critical', target: { tab: 'more', panel: 'diagnostics' } })
    expect(list.find(alert => alert.id === 'unreadable')).toMatchObject({ severity: 'warning', title: '2 records this device cannot read', target: { tab: 'more', panel: 'diagnostics' } })
    expect(list.find(alert => alert.id === 'audit-failed')).toMatchObject({ title: '1 change failed to publish', target: { tab: 'activity' } })
  })

  it('keeps ids and fingerprints deterministic, and every alert opens a screen', async () => {
    const { controller } = await demoUnit()
    await stockSizes(controller, 'PT Shorts', { M: 0 })
    await controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE' })
    const projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 1, 9).toISOString() })
    const first = alerts(projection, { needsFunding: true, queued: 1 }, NOW), second = alerts(projection, { needsFunding: true, queued: 1 }, NOW)
    expect(second.map(alert => [alert.id, alert.fingerprint])).toEqual(first.map(alert => [alert.id, alert.fingerprint]))
    expect(new Set(first.map(alert => alert.id)).size).toBe(first.length)
    for (const alert of first) expect(alert.target.tab).toBeTruthy()
    expect(first.find(alert => alert.id === 'out-of-stock')).toBeUndefined()
  })
})
