import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { alerts, readiness } from '../../stage3/readiness'
import { Dashboard, type DashboardProps, type DashboardTarget } from './Dashboard'

/** Local 27 Sep 2026, 14:30 — every date in these tests is local so they pass in any time zone. */
const NOW = new Date(2026, 8, 27, 14, 30)
const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId
const longDate = (date: Date) => date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
const clockTime = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

async function setup() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  return { controller, projection }
}

/** One cadet still needing an item, one low-stock size and an AMI on 5 Oct whose first tasks are already overdue. */
async function busyUnit() {
  const { controller } = await setup()
  let projection = await controller.addCatalogSizes(catalogId('PT Shorts'), ['M'])
  const medium = projection.inventory.find(item => item.catalogId === catalogId('PT Shorts'))!.entityId
  await controller.updateInventoryItem(medium, { reorderAt: 5 })
  await controller.receiveStock(medium, 3)
  projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
  await controller.addStillNeeded({
    cadetId: projection.cadets[0].cadetId,
    displayLabel: 'Garrison Cap',
    quantityNeeded: 1,
    quantityFulfilled: 0,
    status: 'OPEN',
    firstNeededAt: '2026-09-01T00:00:00.000Z',
    source: 'MANUAL',
  })
  projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 5, 12).toISOString() })
  return { controller, projection }
}

function renderDashboard(projection: ArgusAppProjection, overrides: Partial<DashboardProps> = {}) {
  const navigate = vi.fn<(target: DashboardTarget) => void>()
  const onQuickAction = vi.fn<(action: 'issue' | 'return' | 'count') => void>()
  const view = render(
    <Dashboard
      projection={projection}
      sync={{ label: 'SYNCHRONIZED' }}
      unitName="Harbor High NJROTC"
      navigate={navigate}
      onQuickAction={onQuickAction}
      now={() => NOW}
      {...overrides}
    />,
  )
  return { navigate, onQuickAction, ...view }
}

describe('Dashboard command center', () => {
  it('shows the local date, clock, unit and sync status, and stays intentional for a brand-new unit', async () => {
    const { projection } = await setup()
    const { navigate } = renderDashboard(projection)

    expect(screen.getByText(longDate(NOW))).toBeInTheDocument()
    expect(screen.getByText(clockTime(NOW))).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Harbor High NJROTC' })).toBeInTheDocument()
    expect(screen.getByText('SYNCHRONIZED')).toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Cadets: 0 need items' })).toHaveTextContent('0 NEED ITEMS')
    expect(screen.getByRole('button', { name: 'Stock: 0 need attention' })).toHaveTextContent('0 NEED ATTENTION')
    expect(screen.getByRole('button', { name: 'Events: 0 active preparations' })).toHaveTextContent('0 ACTIVE PREPARATIONS')

    const next = screen.getByRole('region', { name: 'Next supply event' })
    expect(within(next).getByText('No supply events scheduled')).toBeInTheDocument()
    fireEvent.click(within(next).getByRole('button', { name: 'Open supply calendar' }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'calendar' })

    const setupSteps = screen.getByRole('region', { name: 'Set up your unit' })
    fireEvent.click(within(setupSteps).getByRole('button', { name: /Add your cadets/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'cadets' })
  })

  it('renders the four readiness-tree nodes from live data and each node navigates', async () => {
    const { projection } = await busyUnit()
    const { navigate } = renderDashboard(projection)
    const expected = readiness(projection, NOW)
    expect(expected).toMatchObject({ cadetsNeedingItems: 1, stockNeedingAttention: 1, activePreparations: 1 })

    const cadets = screen.getByRole('button', { name: 'Cadets: 1 needs items' })
    expect(cadets.tagName).toBe('BUTTON')
    expect(cadets).toHaveTextContent('CADETS 1 NEED ITEMS')
    const stock = screen.getByRole('button', { name: 'Stock: 1 needs attention' })
    expect(stock).toHaveTextContent('1 NEED ATTENTION')
    const events = screen.getByRole('button', { name: 'Events: 1 active preparation' })
    expect(events).toHaveTextContent('1 ACTIVE PREPARATION')
    expect(screen.getByRole('button', { name: `Readiness: ${expected.overall}% overall` })).toHaveTextContent(`${expected.overall}%`)

    fireEvent.click(cadets)
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'more', panel: 'needed' })
    fireEvent.click(stock)
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'inventory' })
    fireEvent.click(events)
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'calendar' })
  })

  it('makes ISSUE, RETURN and COUNT one tap away', async () => {
    const { projection } = await setup()
    const { onQuickAction } = renderDashboard(projection)
    const actions = screen.getByRole('region', { name: 'Quick actions' })
    fireEvent.click(within(actions).getByRole('button', { name: /^ISSUE/ }))
    fireEvent.click(within(actions).getByRole('button', { name: /^RETURN/ }))
    fireEvent.click(within(actions).getByRole('button', { name: /^COUNT/ }))
    expect(onQuickAction.mock.calls).toEqual([['issue'], ['return'], ['count']])
  })

  it('lists the top five alerts, expands to all of them, and each alert opens its target', async () => {
    const { projection } = await busyUnit()
    const sync = { label: 'NEEDS TESTNET COINS', needsFunding: true, queued: 2 }
    const expected = alerts(projection, sync, NOW)
    expect(expected.length).toBeGreaterThan(5)
    const { navigate } = renderDashboard(projection, { sync })

    const region = screen.getByRole('region', { name: 'Alerts' })
    expect(within(region).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(within(region).getByRole('button', { name: /This device needs testnet coins/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'more', panel: 'wallet' })
    fireEvent.click(within(region).getByRole('button', { name: /Overdue: Complete a physical count of Supply/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'calendar' })

    fireEvent.click(within(region).getByRole('button', { name: `View all ${expected.length} alerts` }))
    expect(within(region).getAllByRole('listitem')).toHaveLength(expected.length)
    fireEvent.click(within(region).getByRole('button', { name: /cadet still need items/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'more', panel: 'needed' })
    fireEvent.click(within(region).getByRole('button', { name: /low on stock/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'inventory' })
  })

  it('opens the supply readiness breakdown from the READINESS node and from the trunk', async () => {
    const { projection } = await busyUnit()
    const expected = readiness(projection, NOW)
    const { navigate } = renderDashboard(projection)

    fireEvent.click(screen.getByRole('button', { name: /^Readiness:/ }))
    const dialog = screen.getByRole('dialog', { name: 'Supply readiness' })
    expect(within(dialog).getByText(`${expected.overall}%`)).toBeInTheDocument()
    expect(within(dialog).getByRole('progressbar', { name: 'Cadets readiness' })).toHaveAttribute('aria-valuenow', String(expected.cadets))
    expect(within(dialog).getByRole('progressbar', { name: 'Inventory readiness' })).toHaveAttribute('aria-valuenow', String(expected.inventory))
    expect(within(dialog).getByRole('progressbar', { name: 'Events readiness' })).toHaveAttribute('aria-valuenow', String(expected.events))
    expect(within(dialog).getByRole('progressbar', { name: 'Audit readiness' })).toHaveAttribute('aria-valuenow', String(expected.audit))
    expect(within(dialog).getByText('0 of 1 active cadets are fully issued.')).toBeInTheDocument()
    expect(within(dialog).getByText('0 of 6 preparation tasks complete for Area Manager Inspection.')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /Open Still Needed/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'more', panel: 'needed' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'A.R.G.U.S. supply readiness details' }))
    expect(screen.getByRole('dialog', { name: 'Supply readiness' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('counts down to the next supply event with task progress, using the injected clock', async () => {
    const { controller } = await setup()
    let projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    const nco = projection.calendar[0]
    projection = await controller.completeTask(nco.calendarEventId, nco.tasks[0].taskId)

    const { navigate, unmount } = renderDashboard(projection)
    const next = screen.getByRole('region', { name: 'Next supply event' })
    expect(within(next).getByText('in 12 days')).toBeInTheDocument()
    expect(within(next).getByText(`1/${nco.tasks.length} tasks done`)).toBeInTheDocument()
    fireEvent.click(within(next).getByRole('button', { name: /New Cadet Orientation/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'calendar' })
    unmount()

    renderDashboard(projection, { now: () => new Date(2026, 9, 9, 7, 0) })
    expect(within(screen.getByRole('region', { name: 'Next supply event' })).getByText('today')).toBeInTheDocument()
  })

  it('keeps a recent event on screen during its follow-up week ("3 days ago")', async () => {
    const { controller } = await setup()
    const projection = await controller.createCalendarEvent({ kind: 'BLT', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    renderDashboard(projection, { now: () => new Date(2026, 9, 12, 14, 30) })
    expect(within(screen.getByRole('region', { name: 'Next supply event' })).getByText('3 days ago')).toBeInTheDocument()
  })

  it('ticks the clock every 30 seconds and stops ticking once unmounted', async () => {
    const { projection } = await setup()
    vi.useFakeTimers()
    try {
      let time = new Date(2026, 8, 27, 14, 30)
      const clock = vi.fn(() => time)
      const { unmount } = renderDashboard(projection, { now: clock })
      expect(screen.getByText(clockTime(time))).toBeInTheDocument()

      time = new Date(2026, 8, 27, 14, 31)
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      expect(screen.getByText(clockTime(time))).toBeInTheDocument()

      unmount()
      const calls = clock.mock.calls.length
      act(() => {
        vi.advanceTimersByTime(120_000)
      })
      expect(clock.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers navigation tiles to every major area', async () => {
    const { projection } = await setup()
    const { navigate } = renderDashboard(projection)
    const tiles = screen.getByRole('navigation', { name: 'Dashboard navigation' })
    const targets: Array<[RegExp, DashboardTarget]> = [
      [/^Inventory/, { tab: 'inventory' }],
      [/^Cadets/, { tab: 'cadets' }],
      [/^Calendar/, { tab: 'calendar' }],
      [/^Activity/, { tab: 'activity' }],
      [/^Command Center/, { tab: 'more' }],
    ]
    for (const [name, target] of targets) {
      fireEvent.click(within(tiles).getByRole('button', { name }))
      expect(navigate).toHaveBeenLastCalledWith(target)
    }
  })
})
