import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { cadetByCode, demoUnit, stockSizes } from '../../test/supplyFixtures'
import { ACK_STORAGE_KEY } from './alertAcknowledgements'
import { Dashboard, type DashboardProps, type DashboardTarget } from './Dashboard'

/** Local 27 Sep 2026, 14:30. */
const NOW = new Date(2026, 8, 27, 14, 30)
const memoryStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values }
}

function renderDashboard(projection: ArgusAppProjection, overrides: Partial<DashboardProps> = {}) {
  const navigate = vi.fn<(target: DashboardTarget) => void>()
  const view = render(
    <Dashboard projection={projection} sync={{ label: 'SYNCHRONIZED' }} unitName="Harbor High NJROTC" navigate={navigate} onQuickAction={() => undefined} now={() => NOW} {...overrides} />,
  )
  return { navigate, ...view }
}
const alertsRegion = () => screen.getByRole('region', { name: 'Alerts' })
const alertRow = (name: RegExp) => within(alertsRegion()).getByRole('button', { name }).closest('li')!

describe('Dashboard alerts: actionable and acknowledgeable', () => {
  it('opens the exact record: the out-of-stock size, and a cadet from the readiness drawer', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 0 })
    await controller.updateInventoryItem(ids.M, { reorderAt: 2 })
    const projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-F001' })
    const { navigate } = renderDashboard(projection)

    expect(screen.getByRole('button', { name: 'Stock: 1 needs attention' })).toBeInTheDocument()
    fireEvent.click(within(alertsRegion()).getByRole('button', { name: /1 size out of stock/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'inventory', filter: 'attention', itemId: ids.M })

    fireEvent.click(screen.getByRole('button', { name: /^Readiness:/ }))
    const dialog = screen.getByRole('dialog', { name: 'Supply readiness' })
    const missing = within(dialog).getByRole('list', { name: 'Cadets missing standard-issue gear' })
    fireEvent.click(within(missing).getByRole('button', { name: /C-F001/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'cadets', cadetId: cadetByCode(projection, 'C-F001').cadetId })
  })

  it('acknowledges an alert on this device, shows it under "Show acknowledged", and re-alerts when the condition changes', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 2, L: 6 })
    let projection = await controller.updateInventoryItem(ids.M, { reorderAt: 3 })
    const storage = memoryStorage()
    const first = renderDashboard(projection, { acknowledgementStorage: storage })

    fireEvent.click(within(alertRow(/1 size low on stock/)).getByRole('button', { name: 'Acknowledge' }))
    expect(within(alertsRegion()).queryByRole('button', { name: /low on stock/ })).not.toBeInTheDocument()
    expect(JSON.parse(storage.values.get(ACK_STORAGE_KEY)!)).toHaveProperty('low-stock')

    fireEvent.click(within(alertsRegion()).getByRole('button', { name: 'Show acknowledged (1)' }))
    const acknowledged = within(alertsRegion()).getByRole('list', { name: 'Acknowledged alerts' })
    expect(within(acknowledged).getByRole('button', { name: /1 size low on stock/ })).toBeInTheDocument()
    first.unmount()

    // Remembered on this device across visits.
    const second = renderDashboard(projection, { acknowledgementStorage: storage })
    expect(within(alertsRegion()).queryByRole('button', { name: /low on stock/ })).not.toBeInTheDocument()
    expect(within(alertsRegion()).getByRole('button', { name: 'Show acknowledged (1)' })).toBeInTheDocument()
    second.unmount()

    // A second size reaching its threshold is a new condition: the alert is back.
    projection = await controller.updateInventoryItem(ids.L, { reorderAt: 6 })
    renderDashboard(projection, { acknowledgementStorage: storage })
    expect(within(alertsRegion()).getByRole('button', { name: /2 sizes low on stock/ })).toBeInTheDocument()
  })

  it('restores an acknowledged alert', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 2 })
    const projection = await controller.updateInventoryItem(ids.M, { reorderAt: 3 })
    renderDashboard(projection, { acknowledgementStorage: memoryStorage() })
    fireEvent.click(within(alertRow(/low on stock/)).getByRole('button', { name: 'Acknowledge' }))
    fireEvent.click(within(alertsRegion()).getByRole('button', { name: 'Show acknowledged (1)' }))
    fireEvent.click(within(within(alertsRegion()).getByRole('list', { name: 'Acknowledged alerts' })).getByRole('button', { name: 'Restore' }))
    expect(within(alertsRegion()).getByRole('button', { name: /low on stock/ })).toBeInTheDocument()
    expect(within(alertsRegion()).queryByRole('button', { name: /Show acknowledged/ })).not.toBeInTheDocument()
  })
})

describe('Dashboard AMI readiness card (spec §17)', () => {
  async function withAmi(daysOut: number) {
    const { controller } = await demoUnit()
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 8, 27 + daysOut, 9).toISOString() })
    return projection
  }
  const precedes = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('stays hidden more than 45 days out', async () => {
    renderDashboard(await withAmi(46))
    expect(screen.queryByRole('region', { name: 'AMI readiness' })).not.toBeInTheDocument()
  })

  it('appears below the alerts 45 days out and opens the AMI event', async () => {
    const projection = await withAmi(30)
    const { navigate, container } = renderDashboard(projection)
    const card = screen.getByRole('region', { name: 'AMI readiness' })
    expect(container.querySelector('.dashboard')).toHaveClass('has-ami')
    expect(container.querySelector('.dashboard')).not.toHaveClass('ami-top')
    expect(precedes(alertsRegion(), card)).toBe(true)
    expect(within(card).getAllByRole('progressbar')).toHaveLength(6)
    fireEvent.click(within(card).getByRole('button', { name: /Area Manager Inspection/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'calendar', calendarEventId: projection.calendar[0].calendarEventId })
    fireEvent.click(within(card).getByRole('button', { name: /Review Inventory Count/ }))
    expect(navigate).toHaveBeenLastCalledWith({ tab: 'count' })
    expect(within(alertsRegion()).queryByRole('button', { name: /^Critical:\s*AMI/ })).not.toBeInTheDocument()
  })

  it('moves to the top of the dashboard in the last 14 days', async () => {
    const { container } = renderDashboard(await withAmi(10))
    const card = screen.getByRole('region', { name: 'AMI readiness' })
    expect(container.querySelector('.dashboard')).toHaveClass('ami-top')
    expect(precedes(card, screen.getByRole('region', { name: 'Quick actions' }))).toBe(true)
    expect(within(card).getByText('in 10 days')).toBeInTheDocument()
  })

  it('turns every category under 100% into a critical alert in the last three days', async () => {
    const projection = await withAmi(2)
    renderDashboard(projection)
    const card = screen.getByRole('region', { name: 'AMI readiness' })
    expect(within(card).getByText('in 2 days')).toHaveClass('critical')
    fireEvent.click(within(alertsRegion()).getByRole('button', { name: /^View all \d+ alerts$/ }))
    expect(within(alertsRegion()).getByRole('button', { name: /^Critical:\s*AMI in 2 days: Inventory Count 0%/ })).toBeInTheDocument()
  })
})
