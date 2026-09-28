import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import { combinedEventReadiness } from '../../stage3/eventReadiness'
import type { AlertTarget } from '../../stage3/readinessTypes'
import { cadetByCode, demoUnit, oneSize, stockSizes } from '../../test/supplyFixtures'
import { CalendarView } from './CalendarView'

/** Local 27 Sep 2026, 14:30. */
const NOW = new Date(2026, 8, 27, 14, 30)

function Harness({ controller, initial, initialEventId, navigate }: { controller: DistributedAppController; initial: ArgusAppProjection; initialEventId?: string; navigate?: (target: AlertTarget) => void }) {
  const [projection, setProjection] = useState(initial)
  return (
    <CalendarView
      projection={projection}
      controller={controller}
      can={() => true}
      memberName={() => 'You'}
      onProjection={setProjection}
      notify={() => undefined}
      now={() => NOW}
      initialEventId={initialEventId}
      navigate={navigate}
    />
  )
}

const stat = (region: HTMLElement, label: string) => within(region).getByText(label).nextElementSibling?.textContent

describe('EventDrawer readiness section', () => {
  it('opens straight onto an NCO and shows roster, preparation counts, shortages and who still needs gear', async () => {
    const { controller } = await demoUnit()
    await stockSizes(controller, 'PT Shorts', { M: 1 })
    await controller.importCadets([
      { gender: 'Male', nsLevel: 'NS1', cadetCode: 'C-M001', sizes: { 'PT Shorts': 'M' } },
      { gender: 'Male', nsLevel: 'NS1', cadetCode: 'C-M002', sizes: { 'PT Shorts': 'M' } },
      { gender: 'Female', nsLevel: 'NS1', cadetCode: 'C-F001' },
      { gender: 'Female', nsLevel: 'NS3', cadetCode: 'C-F301' },
    ])
    let projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9).toISOString() })
    projection = await controller.completeTask(projection.calendar[0].calendarEventId, projection.calendar[0].tasks[0].taskId)
    const nco = projection.calendar[0]
    const navigate = vi.fn<(target: AlertTarget) => void>()
    render(<Harness controller={controller} initial={projection} initialEventId={nco.calendarEventId} navigate={navigate} />)

    const dialog = screen.getByRole('dialog', { name: 'New Cadet Orientation' })
    const region = within(dialog).getByRole('region', { name: 'Event readiness' })
    expect(within(region).getByText('No attendee roster yet, so every active NS1 cadet counts: 3 cadets.')).toBeInTheDocument()
    expect(stat(region, 'Incoming')).toBe('3')
    expect(stat(region, 'Fully prepared')).toBe('0')
    expect(stat(region, 'Not started')).toBe('3')
    expect(stat(region, 'Missing items')).toBe(String(11 + 11 + 8))
    // One task of nine (11%) averaged with cadet preparation (nothing held yet, 0%).
    const combined = combinedEventReadiness(nco, projection, NOW).percent
    expect(combined).toBe(6)
    expect(within(region).getByRole('progressbar', { name: 'Event readiness' })).toHaveAttribute('aria-valuenow', String(combined))

    const shortages = within(region).getByText('Low-stock conflicts').closest('div')!
    const shorts = within(shortages).getByText('PT Shorts · M').closest('li')!
    expect(shorts).toHaveTextContent('Need 2 · 1 on hand')
    expect(shorts).toHaveTextContent('−1')
    expect(within(shortages).getByText('PT Shorts · size unknown')).toBeInTheDocument()

    fireEvent.click(within(region).getByText('Cadets still missing gear (3)'))
    fireEvent.click(within(region).getByRole('button', { name: 'Open cadet C-M002' }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'cadets', cadetId: cadetByCode(projection, 'C-M002').cadetId })

    // The event card uses the same combined readiness (tasks + cadet preparation).
    expect(screen.getByRole('button', { name: /New Cadet Orientation/ })).toHaveTextContent('6% ready · 1/9 tasks')
  })

  it('shows the six AMI categories on an AMI event, each linking to its screen', async () => {
    const { controller } = await demoUnit()
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 12, 9).toISOString() })
    const navigate = vi.fn<(target: AlertTarget) => void>()
    render(<Harness controller={controller} initial={projection} initialEventId={projection.calendar[0].calendarEventId} navigate={navigate} />)
    const region = within(screen.getByRole('dialog', { name: 'Area Manager Inspection' })).getByRole('region', { name: 'AMI readiness' })
    const categories = within(region).getByRole('list', { name: 'AMI readiness categories' })
    expect(within(categories).getAllByRole('progressbar').map(bar => bar.getAttribute('aria-label'))).toEqual([
      'Inventory Count readiness',
      'Cadet Records readiness',
      'Outstanding Corrections readiness',
      'Still Needed readiness',
      'Audit Health readiness',
      'Synchronization Health readiness',
    ])
    fireEvent.click(within(region).getByRole('button', { name: /Review Inventory Count/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'count' })
  })

  it('shows the End-of-Year review with the rollover checklist and starts the annual rollover', async () => {
    const { controller } = await demoUnit()
    await controller.receiveStock(oneSize('Black Belt'), 1)
    let projection = await controller.importCadets([{ gender: 'Male', nsLevel: 'NS4', cadetCode: 'C-M401' }])
    await controller.issueTransaction({ transactionId: 'tx-belt', cadetId: cadetByCode(projection, 'C-M401').cadetId, lines: [{ lineId: 'belt', itemId: oneSize('Black Belt'), quantity: 1 }] })
    projection = await controller.createCalendarEvent({ kind: 'END_OF_YEAR', startsAt: new Date(2027, 4, 28, 9).toISOString() })
    const navigate = vi.fn<(target: AlertTarget) => void>()
    render(<Harness controller={controller} initial={projection} initialEventId={projection.calendar[0].calendarEventId} navigate={navigate} />)

    const region = within(screen.getByRole('dialog', { name: 'End-of-Year Count' })).getByRole('region', { name: 'End-of-Year review' })
    const checklist = within(region).getByRole('list', { name: 'Rollover readiness checklist' })
    expect(within(checklist).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent)).toEqual([
      'Done: No open conflicts',
      'Done: No count sessions left open',
      'Not done: No return-pending cadets',
      'Not done: Full physical count finalized',
    ])
    fireEvent.click(within(region).getByText('Return-pending cadets (1)'))
    expect(within(region).getByRole('button', { name: 'Open cadet C-M401' })).toHaveTextContent('Graduating NS4 · holds 1 item')
    fireEvent.click(within(region).getByRole('button', { name: 'Start annual rollover' }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'more', panel: 'rollover' })
  })

  it('lists post-event returns on a past BLT', async () => {
    const { controller } = await demoUnit()
    await controller.receiveStock(oneSize('Khaki Belt'), 1)
    let projection = await controller.importCadets([{ gender: 'Male', nsLevel: 'NS2', cadetCode: 'C-M201' }])
    const cadet = cadetByCode(projection, 'C-M201')
    await controller.createCalendarEvent({ kind: 'BLT', startsAt: new Date(2026, 8, 20, 9).toISOString(), cadetIds: [cadet.cadetId] })
    projection = await controller.issueTransaction({ transactionId: 'tx-blt', cadetId: cadet.cadetId, bundleId: 'bundle-blt', bundleVersion: 1, lines: [{ lineId: 'belt', itemId: oneSize('Khaki Belt'), quantity: 1 }] }, { timestamp: new Date(2026, 8, 18).toISOString() })
    render(<Harness controller={controller} initial={projection} initialEventId={projection.calendar[0].calendarEventId} />)

    const region = within(screen.getByRole('dialog', { name: 'Basic Leadership Training' })).getByRole('region', { name: 'Event readiness' })
    expect(within(region).getByText('Attendee roster: 1 active cadet.')).toBeInTheDocument()
    expect(within(region).getByText('Post-event returns')).toBeInTheDocument()
    expect(within(region).getByText('Still holds Khaki Belt · One size')).toBeInTheDocument()
  })
})
