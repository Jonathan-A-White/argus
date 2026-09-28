import { describe, expect, it } from 'vitest'
import { cadetByCode, demoUnit, oneSize, stockSizes } from '../test/supplyFixtures'
import { combinedEventReadiness, eventReadiness, eventRoster, postEventReturns } from './eventReadiness'

/** Local 27 Sep 2026, 14:30. */
const NOW = new Date(2026, 8, 27, 14, 30)

/**
 * Three incoming NS1 cadets (two male with some PT sizes recorded, one female with none), one NS2
 * cadet who is not part of an NCO, PT shirts in M (5) and L (0), PT shorts in M (1), and an NCO
 * on 9 Oct. Cadet C-M001 already received a PT shirt from the PT bundle.
 */
async function ncoUnit() {
  const { controller } = await demoUnit()
  const shirts = await stockSizes(controller, 'Gold PT Shirt', { M: 5, L: 0 })
  const shorts = await stockSizes(controller, 'PT Shorts', { M: 1 })
  let projection = await controller.importCadets([
    { gender: 'Male', nsLevel: 'NS1', cadetCode: 'C-M001', sizes: { 'Gold PT Shirt': 'M', 'PT Shorts': 'M' } },
    { gender: 'Male', nsLevel: 'NS1', cadetCode: 'C-M002', sizes: { 'Gold PT Shirt': 'L', 'PT Shorts': 'M' } },
    { gender: 'Female', nsLevel: 'NS1', cadetCode: 'C-F001' },
    { gender: 'Male', nsLevel: 'NS2', cadetCode: 'C-M201' },
  ])
  const first = cadetByCode(projection, 'C-M001')
  await controller.issueTransaction({ transactionId: 'tx-pt-shirt', cadetId: first.cadetId, bundleId: 'bundle-pt', bundleVersion: 1, lines: [{ lineId: 'shirt', itemId: shirts.ids.M, quantity: 1 }] })
  projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9).toISOString() })
  return { controller, projection, nco: projection.calendar[0], shirts: shirts.ids, shorts: shorts.ids }
}

describe('event readiness engine (spec §15, §16, §18)', () => {
  it('uses every active NS1 cadet for an NCO without an attendee roster, and the roster once one is set', async () => {
    const { controller, projection, nco } = await ncoUnit()
    const roster = eventRoster(nco, projection)
    expect(roster.source).toBe('NS1_DEFAULT')
    expect(roster.cadets.map(cadet => cadet.cadetCode).sort()).toEqual(['C-F001', 'C-M001', 'C-M002'])

    const second = cadetByCode(projection, 'C-M002'), ns2 = cadetByCode(projection, 'C-M201')
    const updated = await controller.addCalendarAttendees(nco.calendarEventId, [second.cadetId, ns2.cadetId])
    const report = eventReadiness(updated.calendar[0], updated)
    expect(report).toMatchObject({ rosterSource: 'ATTENDEES', incoming: 2 })
    // A BLT without attendees has nobody to prepare.
    expect(eventRoster({ kind: 'BLT', cadetIds: [] }, projection)).toMatchObject({ source: 'NONE', cadets: [] })
  })

  it('applies each bundle by gender, groups demand by recorded size or "size unknown", and finds shortages', async () => {
    const { projection, nco, shirts, shorts } = await ncoUnit()
    const report = eventReadiness(nco, projection)
    expect(report).toMatchObject({ incoming: 3, fullyPrepared: 0, partiallyPrepared: 1, notStarted: 2, requiredLines: 11 + 11 + 8, satisfiedLines: 1 })
    expect(report.percent).toBe(Math.round(100 / 30))

    const female = report.cadets.find(cadet => cadet.label === 'C-F001')!
    expect(female.required).toBe(8)
    expect(female.missing.map(item => item.label)).toContain('Pumps')
    expect(female.missing.map(item => item.label)).not.toContain('Buckle')
    expect(report.cadets.find(cadet => cadet.label === 'C-M001')).toMatchObject({ status: 'PARTIAL', satisfied: 1, required: 11 })

    const demand = (name: string, size?: string) => report.demand.find(entry => entry.name === name && entry.size === size)
    expect(demand('Gold PT Shirt', 'L')).toMatchObject({ needed: 1, onHand: 0, shortage: 1, stocked: true, itemId: shirts.L })
    // The female cadet has no recorded size: her shirt draws on what is left after known sizes (4 M).
    expect(demand('Gold PT Shirt', undefined)).toMatchObject({ needed: 1, onHand: 4, shortage: 0 })
    expect(demand('PT Shorts', 'M')).toMatchObject({ needed: 2, onHand: 1, shortage: 1, itemId: shorts.M })
    expect(demand('PT Shorts', undefined)).toMatchObject({ needed: 1, onHand: 0, shortage: 1 })
    expect(demand('Buckle', 'One size')).toMatchObject({ needed: 2, onHand: 0, shortage: 2, stocked: true, itemId: oneSize('Buckle') })
    expect(report.shortages.map(entry => `${entry.name}·${entry.size ?? '?'}`)).toEqual(expect.arrayContaining(['Gold PT Shirt·L', 'PT Shorts·M', 'PT Shorts·?', 'Buckle·One size']))
    expect(report.shortages.some(entry => entry.name === 'Gold PT Shirt' && !entry.size)).toBe(false)

    // Missing items are units of required gear; missing sizes are unmet sized lines with no recorded size.
    expect(report.missingItems).toBe(10 + 11 + 8)
    expect(report).toMatchObject({ sizesUnknown: 7 + 7 + 8, sizesNotStocked: 0, missingSizes: 22 })
  })

  it('flags a recorded size the unit does not stock', async () => {
    const { controller, nco } = await ncoUnit()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-M003', sizes: { 'Gold PT Shirt': 'XXL' } })
    const report = eventReadiness(nco, projection)
    expect(report.demand.find(entry => entry.name === 'Gold PT Shirt' && entry.size === 'XXL')).toMatchObject({ stocked: false, onHand: 0, shortage: 1 })
    expect(report.sizesNotStocked).toBe(1)
  })

  it('counts completed issues of the event’s bundles to the roster, and a fully prepared cadet', async () => {
    const { controller } = await demoUnit()
    const top = await stockSizes(controller, 'Tracksuit Top', { M: 2 })
    const bottom = await stockSizes(controller, 'Tracksuit Bottom', { M: 2 })
    let projection = await controller.importCadets([{ gender: 'Female', nsLevel: 'NS2', cadetCode: 'C-F201' }, { gender: 'Male', nsLevel: 'NS3', cadetCode: 'C-M301' }])
    const [ready, waiting] = [cadetByCode(projection, 'C-F201'), cadetByCode(projection, 'C-M301')]
    projection = await controller.createCalendarEvent({ kind: 'CUSTOM', title: 'Drill meet', startsAt: new Date(2026, 9, 20, 8).toISOString(), bundleIds: ['bundle-drill'], cadetIds: [ready.cadetId, waiting.cadetId], tasks: [{ title: 'Confirm the drill team', dueOffsetDays: -7 }] })
    const drill = projection.calendar[0]
    projection = await controller.issueTransaction({ transactionId: 'tx-drill', cadetId: ready.cadetId, bundleId: 'bundle-drill', bundleVersion: 1, lines: [{ lineId: 'top', itemId: top.ids.M, quantity: 1 }, { lineId: 'bottom', itemId: bottom.ids.M, quantity: 1 }] })
    const report = eventReadiness(drill, projection)
    expect(report).toMatchObject({ incoming: 2, fullyPrepared: 1, notStarted: 1, completedIssues: { transactions: 1, cadets: 1 }, percent: 50 })
    expect(report.cadets.find(cadet => cadet.cadetId === ready.cadetId)).toMatchObject({ status: 'PREPARED', missing: [] })

    // The calendar combines the task checklist (0%) with cadet preparation (50%).
    expect(combinedEventReadiness(drill, projection, NOW)).toEqual({ percent: 25, parts: [{ key: 'tasks', label: 'Preparation tasks', percent: 0 }, { key: 'preparation', label: 'Cadets prepared', percent: 50 }] })
  })

  it('lists BLT attendees still holding BLT gear once the event day is over', async () => {
    const { controller } = await demoUnit()
    await controller.receiveStock(oneSize('Khaki Belt'), 2)
    await controller.receiveStock(oneSize('Brass Buckle'), 2)
    let projection = await controller.importCadets([{ gender: 'Male', nsLevel: 'NS2', cadetCode: 'C-M201' }, { gender: 'Female', nsLevel: 'NS2', cadetCode: 'C-F201' }])
    const [kept, returned] = [cadetByCode(projection, 'C-M201'), cadetByCode(projection, 'C-F201')]
    projection = await controller.createCalendarEvent({ kind: 'BLT', startsAt: new Date(2026, 8, 20, 9).toISOString(), cadetIds: [kept.cadetId, returned.cadetId] })
    const blt = projection.calendar[0]
    const issuedAt = { timestamp: new Date(2026, 8, 16).toISOString() }
    await controller.issueTransaction({ transactionId: 'tx-kept', cadetId: kept.cadetId, bundleId: 'bundle-blt', bundleVersion: 1, lines: [{ lineId: 'belt', itemId: oneSize('Khaki Belt'), quantity: 1 }, { lineId: 'buckle', itemId: oneSize('Brass Buckle'), quantity: 1 }] }, issuedAt)
    projection = await controller.issueTransaction({ transactionId: 'tx-returned', cadetId: returned.cadetId, bundleId: 'bundle-blt', bundleVersion: 1, lines: [{ lineId: 'belt', itemId: oneSize('Khaki Belt'), quantity: 1 }] }, issuedAt)
    const property = cadetByCode(projection, 'C-F201').currentProperty[0]
    projection = await controller.returnTransaction({ transactionId: 'tx-return', cadetId: returned.cadetId, lines: [{ lineId: 'belt', propertyId: property.propertyId, quantity: 1 }] })

    expect(postEventReturns(blt, projection, new Date(2026, 8, 20, 18))).toEqual([])
    const pending = postEventReturns(blt, projection, NOW)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ cadetId: kept.cadetId, label: 'C-M201', quantity: 2 })
    expect(pending[0].lines.map(line => line.label).sort()).toEqual(['Brass Buckle', 'Khaki Belt'])
  })
})
