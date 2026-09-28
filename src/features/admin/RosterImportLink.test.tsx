import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { RosterImportPanel } from './RosterImportPanel'

/** Local 27 Sep 2026: the NCO below is upcoming, the AMI long past. */
const NOW = new Date(2026, 8, 27, 14, 30)

async function setup() {
  const controller = new DistributedAppController()
  await controller.initialize()
  await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 2, 1, 9, 0).toISOString() })
  const projection = await controller.createCalendarEvent({ kind: 'NCO', startsAt: new Date(2026, 9, 9, 9, 0).toISOString() })
  const nco = projection.calendar.find(event => event.kind === 'NCO')!
  return { controller, projection, nco }
}

function Harness({ controller, initial, toasts, can = () => true }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; can?: (permission: ArgusPermission) => boolean }) {
  const [projection, setProjection] = useState(initial)
  return <RosterImportPanel projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} close={() => undefined} now={() => NOW} />
}

const linkSelect = () => screen.getByLabelText('Also add these cadets to event')

describe('RosterImportPanel: adding imported cadets to a supply event', () => {
  it('offers active events, soonest first, and adds the NS1 class to the chosen NCO', async () => {
    const { controller, projection, nco } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const options = [...(linkSelect() as HTMLSelectElement).options].map(option => option.textContent)
    expect(options[0]).toBe('Don’t add to an event')
    expect(options.slice(1).map(label => label?.split(' · ')[0])).toEqual(['New Cadet Orientation', 'Area Manager Inspection'])
    expect(linkSelect()).toHaveValue('')

    fireEvent.change(linkSelect(), { target: { value: nco.calendarEventId } })
    fireEvent.change(screen.getByLabelText('Male cadets'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Female cadets'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 new NS1 cadets' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added to New Cadet Orientation as attendees.'))
    expect(toasts).toEqual(['Imported 3 cadets and added them to New Cadet Orientation.'])

    const latest = await controller.project()
    expect(latest.calendar.find(event => event.kind === 'NCO')?.cadetIds).toEqual(latest.cadets.map(cadet => cadet.cadetId).sort())
    expect(latest.calendar.find(event => event.kind === 'AMI')?.cadetIds).toEqual([])
    expect(latest.events.map(record => record.event.eventType).slice(-2)).toEqual(['CADETS_IMPORTED', 'CALENDAR_ATTENDEES_ADDED'])
  })

  it('links a pasted roster too, and only the cadets it imported', async () => {
    const { controller, nco } = await setup()
    const existing = await controller.createCadet({ gender: 'Male', nsLevel: 'NS3', status: 'ACTIVE', cadetCode: 'C-9999' })
    const toasts: string[] = []
    render(<Harness controller={controller} initial={existing} toasts={toasts} />)
    fireEvent.change(linkSelect(), { target: { value: nco.calendarEventId } })
    fireEvent.change(screen.getByLabelText('Roster lines'), { target: { value: 'M,1,C-7K4M\nF,1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 cadets' }))
    await waitFor(() => expect(toasts).toEqual(['Imported 2 cadets and added them to New Cadet Orientation.']))
    const latest = await controller.project()
    const attendees = latest.calendar.find(event => event.kind === 'NCO')!.cadetIds
    expect(attendees).toHaveLength(2)
    expect(attendees).toContain(latest.cadets.find(cadet => cadet.cadetCode === 'C-7K4M')!.cadetId)
    expect(attendees).not.toContain(latest.cadets.find(cadet => cadet.cadetCode === 'C-9999')!.cadetId)
  })

  it('keeps the import and explains when the cadets could not be added to the event', async () => {
    const { controller, projection, nco } = await setup()
    vi.spyOn(controller, 'addCalendarAttendees').mockRejectedValueOnce(new Error('Missing permission calendar.write.'))
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    fireEvent.change(linkSelect(), { target: { value: nco.calendarEventId } })
    fireEvent.change(screen.getByLabelText('Female cadets'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 new NS1 cadets' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('They could not be added to New Cadet Orientation: Missing permission calendar.write.')
    expect(toasts).toEqual(['Imported 2 cadets.'])
    const latest = await controller.project()
    expect(latest.cadets).toHaveLength(2)
    expect(latest.calendar.find(event => event.kind === 'NCO')?.cadetIds).toEqual([])
  })

  it('does not offer linking without calendar.write, and imports as before', async () => {
    const { controller, projection } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} can={permission => permission !== 'calendar.write'} />)
    expect(screen.queryByLabelText('Also add these cadets to event')).toBeNull()
    fireEvent.change(screen.getByLabelText('Male cadets'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 new NS1 cadet' }))
    await waitFor(() => expect(toasts).toEqual(['Imported 1 cadet.']))
    expect((await controller.project()).calendar.every(event => event.cadetIds.length === 0)).toBe(true)
  })
})
