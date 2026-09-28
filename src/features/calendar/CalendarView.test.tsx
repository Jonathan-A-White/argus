import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { CalendarView } from './CalendarView'
import { eventProgress } from './calendarModel'

/** Local 27 Sep 2026, 14:30 — every date in these tests is local so they pass in any time zone. */
const NOW = new Date(2026, 8, 27, 14, 30)
const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId

async function setup() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  return { controller, projection }
}

type HarnessProps = {
  controller: DistributedAppController
  initial: ArgusAppProjection
  toasts?: string[]
  can?: (permission: ArgusPermission) => boolean
  now?: () => Date
}

/** Mirrors how App hosts the view: it owns the projection and the toasts. */
function Harness({ controller, initial, toasts = [], can = () => true, now = () => NOW }: HarnessProps) {
  const [projection, setProjection] = useState(initial)
  return (
    <CalendarView
      projection={projection}
      controller={controller}
      can={can}
      memberName={identity => (identity === projection.actor ? 'You' : 'Unit member')}
      onProjection={setProjection}
      notify={message => toasts.push(message)}
      now={now}
    />
  )
}

const eventCard = (title: string) => screen.getByRole('button', { name: new RegExp(title) })
function openEvent(title: string) {
  fireEvent.click(eventCard(title))
  return screen.getByRole('dialog', { name: title })
}
const taskRow = (dialog: HTMLElement, title: string) => within(dialog).getByText(title).closest('li')!

describe('Supply Calendar', () => {
  it('creates an NCO event from its template through the UI and shows it with its preparation tasks', async () => {
    const { controller, projection } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    expect(screen.getByText('No supply events scheduled')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add supply event' }))
    const form = screen.getByRole('form', { name: 'Add supply event' })
    fireEvent.click(within(form).getByRole('radio', { name: /^AMI/ }))
    expect(within(form).getByText('Complete a physical count of Supply')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('radio', { name: /^NCO/ }))
    expect(within(form).getByRole('radio', { name: /^NCO/ })).toBeChecked()
    expect(within(form).getByText('Issue incoming NS1 cadets their PT and gender-appropriate NSU bundles.')).toBeInTheDocument()
    expect(within(form).getByText('Issues PT, Male NSU, Female NSU')).toBeInTheDocument()
    expect(within(form).getByText('Verify the incoming NS1 roster')).toBeInTheDocument()
    expect(within(form).getByText('21 days before')).toBeInTheDocument()

    // The date is required and never guessed: the drawer stays open with an inline error.
    fireEvent.click(within(form).getByRole('button', { name: 'Create event' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('Enter the event date.')

    fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2026-10-09' } })
    fireEvent.change(within(form).getByLabelText('Time'), { target: { value: '08:30' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create event' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add supply event' })).not.toBeInTheDocument())
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/^New Cadet Orientation scheduled for /)

    const card = eventCard('New Cadet Orientation')
    expect(card).toHaveTextContent('in 12 days')
    expect(card).toHaveTextContent('0% ready · 0/9 tasks')

    const dialog = openEvent('New Cadet Orientation')
    const tasks = within(dialog).getAllByRole('checkbox')
    expect(tasks).toHaveLength(9)
    expect(tasks[0]).toHaveAccessibleName('Verify the incoming NS1 roster')
    expect(tasks.at(-1)).toHaveAccessibleName('Confirm every new cadet record is complete')
    expect(within(taskRow(dialog, 'Verify the incoming NS1 roster')).getByText('Overdue')).toBeInTheDocument()
    expect(within(taskRow(dialog, 'Issue PT bundles')).getByText('Due in 12 days')).toBeInTheDocument()
    expect(within(dialog).getByText('Stock ready for 0/3 PT lines')).toBeInTheDocument()
    const bundles = within(dialog).getByRole('region', { name: 'Bundle readiness' })
    expect(within(bundles).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent)).toEqual(['PT', 'Male NSU', 'Female NSU'])
  })

  it('keeps the add drawer open and shows the controller error inline when saving fails', async () => {
    const { controller, projection } = await setup()
    vi.spyOn(controller, 'createCalendarEvent').mockRejectedValueOnce(new Error('Missing permission calendar.write.'))
    render(<Harness controller={controller} initial={projection} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add supply event' }))
    const form = screen.getByRole('form', { name: 'Add supply event' })
    fireEvent.click(within(form).getByRole('radio', { name: /^Custom/ }))
    fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2026-11-02' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create event' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('Give this event a title.')

    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Color guard uniform issue' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create event' }))
    expect(await within(form).findByText('Missing permission calendar.write.')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Add supply event' })).toBeInTheDocument()

    fireEvent.click(within(form).getByRole('button', { name: 'Create event' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add supply event' })).not.toBeInTheDocument())
    expect(eventCard('Color guard uniform issue')).toHaveTextContent('No tasks yet')
    // Nothing to prepare means no progress to show: an empty bar, never a full one beside "No tasks yet" (minor 11).
    expect(eventCard('Color guard uniform issue').querySelector<HTMLElement>('.calendar-meter > span')?.style.width).toBe('0%')
    expect(eventProgress({ tasks: [] })).toEqual({ done: 0, total: 0, percent: 0 })
  })

  it('completes and un-completes a task from its checkbox and the progress follows', async () => {
    const { controller } = await setup()
    const projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    render(<Harness controller={controller} initial={projection} />)

    const dialog = openEvent('New Cadet Orientation')
    const progress = within(dialog).getByRole('progressbar', { name: 'Preparation progress' })
    expect(progress).toHaveAttribute('aria-valuenow', '0')

    const roster = within(dialog).getByRole('checkbox', { name: 'Verify the incoming NS1 roster' })
    fireEvent.click(roster)
    await waitFor(() => expect(roster).toBeChecked())
    expect(progress).toHaveAttribute('aria-valuenow', '11')
    expect(within(dialog).getByText('1/9 tasks · 11%')).toBeInTheDocument()
    expect(within(taskRow(dialog, 'Verify the incoming NS1 roster')).getByText(/^Done by You on /)).toBeInTheDocument()
    expect(eventCard('New Cadet Orientation')).toHaveTextContent('11% ready · 1/9 tasks')

    fireEvent.click(roster)
    await waitFor(() => expect(roster).not.toBeChecked())
    expect(progress).toHaveAttribute('aria-valuenow', '0')
  })

  it('labels overdue, due-soon and later tasks against the injected clock', async () => {
    const { controller } = await setup()
    // AMI on 5 Oct: the count (−14 → 21 Sep) and records review (−10 → 25 Sep) are overdue on 27 Sep.
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 5, 12, 0).toISOString() })
    render(<Harness controller={controller} initial={projection} />)

    expect(eventCard('Area Manager Inspection')).toHaveTextContent('2 overdue')
    const dialog = openEvent('Area Manager Inspection')
    expect(within(dialog).getByText('2 tasks are overdue')).toBeInTheDocument()
    expect(within(taskRow(dialog, 'Complete a physical count of Supply')).getByText('Overdue')).toBeInTheDocument()
    expect(within(taskRow(dialog, 'Review cadet property records')).getByText('Overdue')).toBeInTheDocument()
    expect(within(taskRow(dialog, 'Review Still Needed')).getByText('Due tomorrow')).toBeInTheDocument()
    expect(within(taskRow(dialog, 'Prepare the final readiness report')).getByText('Due in 7 days')).toBeInTheDocument()
  })

  it('shows stock readiness for each bundle of an NCO', async () => {
    const { controller } = await setup()
    for (const name of ['Gold PT Shirt', 'PT Shorts']) {
      const projection = await controller.addCatalogSizes(catalogId(name), ['M'])
      const size = projection.inventory.find(item => item.catalogId === catalogId(name))!.entityId
      await controller.receiveStock(size, 4)
    }
    const projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    render(<Harness controller={controller} initial={projection} />)

    const dialog = openEvent('New Cadet Orientation')
    expect(within(dialog).getByText('Stock ready for 2/3 PT lines')).toBeInTheDocument()
    expect(within(dialog).getByText('Nothing on hand: Khaki Ball Cap')).toBeInTheDocument()
    expect(within(dialog).getByText('Stock ready for 0/8 Male NSU lines')).toBeInTheDocument()
  })

  it('adds a task, edits the date, and cancels the event with a two-step confirmation', async () => {
    const { controller } = await setup()
    const toasts: string[] = []
    const projection = await controller.createCalendarEvent({ kind: 'BLT', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const dialog = openEvent('Basic Leadership Training')

    const addTask = within(dialog).getByRole('form', { name: 'Add task' })
    fireEvent.change(within(addTask).getByLabelText('Task'), { target: { value: 'Launder loaner PT gear' } })
    fireEvent.change(within(addTask).getByLabelText('Days'), { target: { value: '2' } })
    fireEvent.change(within(addTask).getByLabelText('When'), { target: { value: 'after' } })
    fireEvent.click(within(addTask).getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: 'Launder loaner PT gear' })).toBeInTheDocument())
    expect(within(taskRow(dialog, 'Launder loaner PT gear')).getByText(/2 days after/)).toBeInTheDocument()
    expect(within(dialog).getAllByRole('checkbox').at(-2)).toHaveAccessibleName('Launder loaner PT gear')
    expect(toasts).toContain('Task added.')

    const details = within(dialog).getByRole('form', { name: 'Edit event details' })
    fireEvent.change(within(details).getByLabelText('Date'), { target: { value: '2026-10-16' } })
    fireEvent.click(within(details).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(eventCard('Basic Leadership Training')).toHaveTextContent('in 19 days'))
    expect(toasts).toContain('Event updated.')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel event' }))
    const confirm = within(dialog).getByRole('group', { name: 'Confirm cancellation' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep event' }))
    expect(within(dialog).queryByRole('group', { name: 'Confirm cancellation' })).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel event' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, cancel event' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Basic Leadership Training/ })).not.toBeInTheDocument()
    expect(screen.getByText('No upcoming supply events')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show cancelled events (1)' }))
    expect(eventCard('Basic Leadership Training')).toHaveTextContent('Cancelled')
  })

  it('collapses past events into their own section', async () => {
    const { controller } = await setup()
    await controller.createCalendarEvent({ kind: 'MILITARY_BALL', startsAt: new Date(2026, 3, 18, 18, 0).toISOString() })
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 5, 12, 0).toISOString() })
    render(<Harness controller={controller} initial={projection} />)

    const upcoming = screen.getByRole('region', { name: 'Upcoming' })
    expect(within(upcoming).getAllByRole('listitem')).toHaveLength(1)
    expect(within(upcoming).getByRole('button', { name: /Area Manager Inspection/ })).toBeInTheDocument()
    const past = screen.getByText('Past events').closest('details')!
    expect(past).not.toHaveAttribute('open')
    expect(within(past).getByRole('button', { name: /Military Ball/ })).toHaveTextContent('days ago')
  })

  it('lets read-only members see events and tasks without any edit controls', async () => {
    const { controller } = await setup()
    const projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    render(<Harness controller={controller} initial={projection} can={permission => permission === 'calendar.read'} />)

    expect(screen.queryByRole('button', { name: 'Add supply event' })).not.toBeInTheDocument()
    const dialog = openEvent('New Cadet Orientation')
    expect(within(dialog).getByText('Verify the incoming NS1 roster')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('img', { name: 'Not done' })).toHaveLength(9)
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('form', { name: 'Add task' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('form', { name: 'Edit event details' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Cancel event' })).not.toBeInTheDocument()
  })

  it('hides the template quick-start from read-only members of a new unit', async () => {
    const { controller, projection } = await setup()
    const { unmount } = render(<Harness controller={controller} initial={projection} />)
    const quickStart = screen.getByRole('group', { name: 'Start from a template' })
    fireEvent.click(within(quickStart).getByRole('button', { name: 'Military Ball' }))
    expect(screen.getByRole('radio', { name: /^Military Ball/ })).toBeChecked()
    unmount()

    render(<Harness controller={controller} initial={projection} can={() => false} />)
    expect(screen.queryByRole('group', { name: 'Start from a template' })).not.toBeInTheDocument()
    expect(screen.getByText('A supply officer adds events; they appear here on every device.')).toBeInTheDocument()
  })
})
