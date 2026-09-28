import { useEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission, CadetGender, NsLevel } from '../../distributed/types'
import { CalendarView } from './CalendarView'

/** Local 27 Sep 2026, 14:30, as in CalendarView.test.tsx. */
const NOW = new Date(2026, 8, 27, 14, 30)
const NAME = 'Jordan Rivera'

type Roster = Array<[code: string, gender: CadetGender, level: NsLevel, status?: 'ACTIVE' | 'INACTIVE', name?: string]>
const ROSTER: Roster = [
  ['C-1111', 'Male', 'NS1', 'ACTIVE', NAME],
  ['C-2222', 'Female', 'NS1'],
  ['C-3333', 'Male', 'NS1'],
  ['C-4444', 'Female', 'NS2'],
  ['C-5555', 'Male', 'NS1', 'INACTIVE'],
]

async function setup(roster: Roster = ROSTER) {
  const controller = new DistributedAppController()
  await controller.initialize()
  for (const [cadetCode, gender, nsLevel, status = 'ACTIVE', fullName] of roster) await controller.createCadet({ cadetCode, gender, nsLevel, status, ...(fullName ? { fullName } : {}) })
  return controller
}
const idOf = (projection: ArgusAppProjection, code: string) => projection.cadets.find(cadet => cadet.cadetCode === code)!.cadetId

type Deliver = (projection: ArgusAppProjection) => void
type HarnessProps = { controller: DistributedAppController; initial: ArgusAppProjection; toasts?: string[]; can?: (permission: ArgusPermission) => boolean; onSync?: (deliver: Deliver) => void }

/** Mirrors App: it owns the projection. `onSync` hands out a setter that stands in for the auto-sync bringing in another device's work. */
function Harness({ controller, initial, toasts = [], can = () => true, onSync }: HarnessProps) {
  const [projection, setProjection] = useState(initial)
  useEffect(() => onSync?.(setProjection), [onSync])
  return (
    <CalendarView
      projection={projection}
      controller={controller}
      can={can}
      memberName={identity => (identity === projection.actor ? 'You' : 'Unit member')}
      onProjection={setProjection}
      notify={message => toasts.push(message)}
      now={() => NOW}
    />
  )
}

function openEvent(title: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }))
  return screen.getByRole('dialog', { name: title })
}
const attendeesOf = (dialog: HTMLElement) => within(dialog).getByRole('region', { name: 'Attendees' })
const listedCodes = (region: HTMLElement) =>
  within(region)
    .queryAllByRole('listitem')
    .map(item => item.querySelector('strong')?.textContent)

describe('Event attendees', () => {
  it('adds the NCO class in one tap, filters, reveals names only on request, and removes a cadet', async () => {
    const controller = await setup()
    const projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const dialog = openEvent('New Cadet Orientation')
    const attendees = attendeesOf(dialog)
    expect(within(attendees).getByText(/No cadets are linked to this event yet/)).toBeInTheDocument()

    fireEvent.click(within(attendees).getByRole('button', { name: 'Add all active NS1 (3)' }))
    await waitFor(() => expect(listedCodes(attendees)).toEqual(['C-1111', 'C-2222', 'C-3333']))
    expect(toasts).toContain('Added 3 cadets (all active NS1) to New Cadet Orientation.')
    expect(within(attendees).getByText('3 cadets · 2 male · 1 female · NS1 3')).toBeInTheDocument()
    expect(within(attendees).getByRole('button', { name: 'Add all active NS1 (0)' })).toBeDisabled()
    expect(within(attendees).getByText('C-2222').closest('li')).toHaveTextContent('NS1 · Female')

    // Names stay hidden until someone explicitly shows them.
    expect(dialog.textContent).not.toMatch(/Jordan|Rivera/)
    fireEvent.click(within(attendees).getByRole('button', { name: 'Show names' }))
    expect(within(attendees).getByText(NAME)).toBeInTheDocument()
    fireEvent.click(within(attendees).getByRole('button', { name: 'Hide names' }))
    expect(dialog.textContent).not.toMatch(/Jordan|Rivera/)

    fireEvent.click(within(within(attendees).getByRole('group', { name: 'Filter by gender' })).getByRole('button', { name: 'Female' }))
    expect(listedCodes(attendees)).toEqual(['C-2222'])
    expect(within(attendees).getByText('Showing 1 of 3.')).toBeInTheDocument()
    fireEvent.click(within(within(attendees).getByRole('group', { name: 'Filter by NS level' })).getByRole('button', { name: 'NS2' }))
    expect(within(attendees).getByText('No attendees match these filters.')).toBeInTheDocument()
    fireEvent.click(within(attendees).getByRole('button', { name: 'All levels' }))
    fireEvent.click(within(attendees).getByRole('button', { name: 'Any gender' }))

    fireEvent.click(within(attendees).getByRole('button', { name: 'Remove C-3333' }))
    await waitFor(() => expect(listedCodes(attendees)).toEqual(['C-1111', 'C-2222']))
    expect(toasts).toContain('C-3333 removed from New Cadet Orientation.')

    // "All active cadets" brings C-3333 back and adds the NS2 cadet; the inactive cadet is never offered.
    fireEvent.click(within(attendees).getByRole('button', { name: 'Add all active cadets (2)' }))
    await waitFor(() => expect(listedCodes(attendees)).toEqual(['C-1111', 'C-2222', 'C-3333', 'C-4444']))
    const latest = await controller.project()
    expect(latest.calendar[0].cadetIds).toEqual(['C-1111', 'C-2222', 'C-3333', 'C-4444'].map(code => idOf(latest, code)).sort())
    expect(latest.events.filter(record => record.event.eventType.startsWith('CALENDAR_ATTENDEES')).map(record => record.event.eventType)).toEqual(['CALENDAR_ATTENDEES_ADDED', 'CALENDAR_ATTENDEES_REMOVED', 'CALENDAR_ATTENDEES_ADDED'])
  })

  it('chooses cadets by search and filters, keeping the selection across searches', async () => {
    const controller = await setup()
    const projection = await controller.createCalendarEvent({ kind: 'MILITARY_BALL', startsAt: new Date(2026, 9, 30, 18, 0).toISOString() })
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const attendees = attendeesOf(openEvent('Military Ball'))
    // The NS1 shortcut belongs to NCO; other events offer every active cadet.
    expect(within(attendees).queryByRole('button', { name: /all active NS1/ })).toBeNull()
    expect(within(attendees).queryByRole('checkbox')).toBeNull()

    fireEvent.click(within(attendees).getByRole('button', { name: 'Choose cadets' }))
    const candidates = () => within(within(attendees).getByRole('list', { name: 'Cadets you can add' })).getAllByRole('checkbox')
    expect(candidates().map(box => box.closest('li')?.querySelector('strong')?.textContent)).toEqual(['C-1111', 'C-2222', 'C-3333', 'C-4444'])
    const search = within(attendees).getByLabelText('Find cadets to add')
    fireEvent.change(search, { target: { value: 'NS2' } })
    expect(candidates()).toHaveLength(1)
    fireEvent.click(candidates()[0])
    // A name search finds the cadet but still shows only the cadet ID.
    fireEvent.change(search, { target: { value: 'rivera' } })
    expect(candidates()).toHaveLength(1)
    expect(within(attendees).getByText('C-1111')).toBeInTheDocument()
    expect(attendees.textContent).not.toMatch(/Jordan|Rivera/)
    fireEvent.click(candidates()[0])
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(within(attendees).getByRole('button', { name: 'Female' }))
    expect(candidates()).toHaveLength(2)
    expect(within(attendees).getByRole('checkbox', { name: /C-4444/ })).toBeChecked()

    fireEvent.click(within(attendees).getByRole('button', { name: 'Add 2 cadets' }))
    await waitFor(() => expect(toasts).toContain('Added 2 cadets to Military Ball.'))
    fireEvent.click(within(attendees).getByRole('button', { name: 'Any gender' }))
    expect(listedCodes(within(attendees).getByRole('list', { name: 'Attending cadets' }))).toEqual(['C-1111', 'C-4444'])
    expect(within(attendees).getByRole('button', { name: 'Add 0 cadets' })).toBeDisabled()
    expect(within(attendees).getByText('2 available')).toBeInTheDocument()
  })

  it('shows attendees read-only to members without calendar.write', async () => {
    const controller = await setup()
    let projection = await controller.createCalendarEvent({ kind: 'BLT', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    projection = await controller.addCalendarAttendees(projection.calendar[0].calendarEventId, [idOf(projection, 'C-4444')])
    render(<Harness controller={controller} initial={projection} can={permission => permission === 'calendar.read'} />)
    const attendees = attendeesOf(openEvent('Basic Leadership Training'))
    expect(listedCodes(attendees)).toEqual(['C-4444'])
    expect(within(attendees).getByText('1 cadet · 1 female · NS2 1')).toBeInTheDocument()
    expect(within(attendees).queryByRole('button', { name: /Remove|Add|Choose|Show names/ })).toBeNull()
  })
})

describe('Event details: bundles, type and concurrent edits', () => {
  it('links bundles to a custom event from the details form and unlinks them again', async () => {
    const controller = await setup([])
    const projection = await controller.createCalendarEvent({ kind: 'CUSTOM', title: 'Color guard issue', startsAt: new Date(2026, 10, 2, 9, 0).toISOString() })
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const dialog = openEvent('Color guard issue')
    expect(within(dialog).queryByRole('region', { name: 'Bundles' })).toBeNull()

    const form = within(dialog).getByRole('form', { name: 'Edit event details' })
    const picker = within(form).getByRole('group', { name: 'Bundles issued at this event' })
    expect(within(picker).getAllByRole('button').map(button => button.textContent)).toEqual(expect.arrayContaining(['PT', 'Male SDB', 'Female SDB', 'BLT']))
    fireEvent.click(within(picker).getByRole('button', { name: 'Male SDB' }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Female SDB' }))
    expect(within(picker).getByRole('button', { name: 'Male SDB' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(within(form).getByLabelText('Event type'), { target: { value: 'MILITARY_BALL' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    // A Military Ball issues bundles, so their stock readiness is shown.
    const bundles = await within(dialog).findByRole('region', { name: 'Bundle readiness' })
    await waitFor(() => expect(within(bundles).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent)).toEqual(['Male SDB', 'Female SDB']))
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Save changes' })).toBeDisabled())
    expect(toasts).toContain('Event updated.')

    fireEvent.click(within(picker).getByRole('button', { name: 'Male SDB' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(within(bundles).getAllByRole('listitem')).toHaveLength(1))
    const latest = (await controller.project()).calendar[0]
    expect(latest).toMatchObject({ kind: 'MILITARY_BALL', bundleIds: ['bundle-female-sdb'] })
  })

  it('records a same-field edit made meanwhile on another device as a visible conflict, then lets the editor replace it deliberately', async () => {
    const controller = await setup([])
    const projection = await controller.createCalendarEvent({ kind: 'BLT', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    const calendarEventId = projection.calendar[0].calendarEventId
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const dialog = openEvent('Basic Leadership Training')
    const form = within(dialog).getByRole('form', { name: 'Edit event details' })
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'BLT at the gym' } })
    // Another officer renames the event while this form is open.
    await controller.updateCalendarEvent(calendarEventId, { title: 'BLT at the pool' })

    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    expect(await within(form).findByText(/Its change was kept and yours is recorded as a conflict/)).toBeInTheDocument()
    expect(toasts).toContain('Saved as a conflict for review.')
    expect(within(dialog).getByText('Conflicting edit.').closest('p')).toHaveTextContent('Two devices changed the title of BLT at the pool at the same time.')
    expect(screen.getByRole('dialog', { name: 'BLT at the pool' })).toBe(dialog)
    expect(within(form).getByLabelText('Title')).toHaveValue('BLT at the gym')
    expect((await controller.project()).conflicts).toMatchObject([{ status: 'OPEN', entityId: calendarEventId }])

    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'BLT at the gym' })).toBe(dialog))
    expect(toasts).toContain('Event updated.')
    expect((await controller.project()).conflicts).toHaveLength(1)
  })
})

describe('Event details: merging with work from another device', () => {
  it('flags a change that synced in while editing, and merges an edit of a different field', async () => {
    const controller = await setup([])
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 5, 12, 0).toISOString() })
    const calendarEventId = projection.calendar[0].calendarEventId
    const toasts: string[] = []
    let deliver: Deliver = () => undefined
    render(<Harness controller={controller} initial={projection} toasts={toasts} onSync={setter => (deliver = setter)} />)
    const dialog = openEvent('Area Manager Inspection')
    const form = within(dialog).getByRole('form', { name: 'Edit event details' })
    fireEvent.change(within(form).getByLabelText('Notes'), { target: { value: 'Binder is in the supply office' } })

    const synced = await controller.updateCalendarEvent(calendarEventId, { title: 'AMI (spring)' })
    act(() => deliver(synced))
    expect(within(form).getByRole('status')).toHaveTextContent('Another device changed the title since this form was loaded.')

    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(toasts).toContain('Event updated.'))
    expect(within(form).queryByRole('status')).toBeNull()
    expect(within(form).getByLabelText('Title')).toHaveValue('AMI (spring)')
    const latest = await controller.project()
    expect(latest.calendar[0]).toMatchObject({ title: 'AMI (spring)', notes: 'Binder is in the supply office' })
    expect(latest.conflicts).toEqual([])
  })
})

describe('Editing preparation tasks', () => {
  it('renames a task, moves its due date, keeps its completion, and removes a task after confirmation', async () => {
    const controller = await setup([])
    const projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const dialog = openEvent('New Cadet Orientation')
    const roster = within(dialog).getByRole('checkbox', { name: 'Verify the incoming NS1 roster' })
    fireEvent.click(roster)
    await waitFor(() => expect(roster).toBeChecked())

    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit task: Verify the incoming NS1 roster' }))
    const editor = within(dialog).getByRole('form', { name: 'Edit task' })
    expect(within(editor).getByLabelText('Days')).toHaveValue(21)
    fireEvent.change(within(editor).getByLabelText('Task'), { target: { value: 'Verify the NS1 roster with the SNSI' } })
    fireEvent.change(within(editor).getByLabelText('Days'), { target: { value: '28' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save task' }))
    const renamed = await within(dialog).findByRole('checkbox', { name: 'Verify the NS1 roster with the SNSI' })
    expect(renamed).toBeChecked()
    expect(renamed.closest('li')).toHaveTextContent('28 days before')
    expect(within(dialog).queryByRole('form', { name: 'Edit task' })).toBeNull()
    expect(toasts).toContain('Task updated.')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit task: Prepare PT gear' }))
    const second = within(dialog).getByRole('form', { name: 'Edit task' })
    fireEvent.click(within(second).getByRole('button', { name: 'Remove task' }))
    fireEvent.click(within(within(second).getByRole('group', { name: 'Confirm task removal' })).getByRole('button', { name: 'Keep task' }))
    fireEvent.click(within(second).getByRole('button', { name: 'Remove task' }))
    fireEvent.click(within(second).getByRole('button', { name: 'Yes, remove task' }))
    await waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: 'Prepare PT gear' })).toBeNull())
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(8)
    expect(within(dialog).getByText('1/8 tasks · 13%')).toBeInTheDocument()
    expect(toasts).toContain('Task removed.')
    expect((await controller.project()).calendar[0].removedTasks).toMatchObject([{ title: 'Prepare PT gear' }])
  })
})
