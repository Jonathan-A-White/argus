import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from '../../App'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { LocalSettingsStorage } from '../../settings'
import { MemoryRepository } from '../../storage/repository'
import { CadetDrawer } from '../cadets/CadetDrawer'

const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) } }
const NEED = { quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN' as const, firstNeededAt: '2026-09-01T00:00:00.000Z', source: 'MANUAL' as const }

async function cadetWithNeeds(controller = new DistributedAppController()) {
  await controller.initialize()
  let projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-NEED' })
  const cadetId = projection.cadets[0].cadetId
  await controller.addStillNeeded({ ...NEED, cadetId, displayLabel: 'Pumps', size: '8' })
  projection = await controller.addStillNeeded({ ...NEED, cadetId, displayLabel: 'Neck Tabs' })
  return { controller, projection, cadetId }
}

function Drawer({ controller, initial, cadetId, can = () => true, toasts }: { controller: DistributedAppController; initial: ArgusAppProjection; cadetId: string; can?: (permission: ArgusPermission) => boolean; toasts: string[] }) {
  const [projection, setProjection] = useState(initial)
  return <CadetDrawer cadet={projection.cadets.find(cadet => cadet.cadetId === cadetId)!} projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} onIssue={() => undefined} onReturn={() => undefined} close={() => undefined} />
}

describe('Still Needed fulfil / cancel controls', () => {
  it('in the cadet record: cancel requires a reason, fulfil takes an optional note, both are signed events', async () => {
    const { controller, projection, cadetId } = await cadetWithNeeds()
    const toasts: string[] = []
    render(<Drawer controller={controller} initial={projection} cadetId={cadetId} toasts={toasts} />)
    const drawer = screen.getByRole('dialog', { name: 'C-NEED' })

    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel Pumps' }))
    const cancel = within(drawer).getByRole('form', { name: 'Cancel Pumps' })
    fireEvent.click(within(cancel).getByRole('button', { name: 'Cancel requirement' }))
    expect(within(cancel).getByRole('alert')).toHaveTextContent('Give a reason for cancelling.')
    fireEvent.change(within(cancel).getByLabelText('Reason'), { target: { value: 'Cadet wears boots on medical chit' } })
    fireEvent.click(within(cancel).getByRole('button', { name: 'Cancel requirement' }))
    await waitFor(() => expect(within(drawer).queryByText('Pumps')).toBeNull())

    fireEvent.click(within(drawer).getByRole('button', { name: 'Fulfil Neck Tabs' }))
    fireEvent.click(within(within(drawer).getByRole('form', { name: 'Fulfil Neck Tabs' })).getByRole('button', { name: 'Mark fulfilled' }))
    await waitFor(() => expect(within(drawer).getByText('No open requirements.')).toBeInTheDocument())
    expect(toasts).toEqual(['Pumps cancelled.', 'Neck Tabs marked fulfilled.'])

    const state = await controller.technicalState()
    expect(state.stillNeeded.map(need => [need.displayLabel, need.status, need.closeReason])).toEqual([['Pumps', 'CANCELLED', 'Cadet wears boots on medical chit'], ['Neck Tabs', 'FULFILLED', undefined]])
    expect(state.events.map(record => record.event.eventType).slice(-2)).toEqual(['STILL_NEEDED_CANCELLED', 'STILL_NEEDED_FULFILLED'])
  })

  it('are hidden without cadets.manage', async () => {
    const { controller, projection, cadetId } = await cadetWithNeeds()
    render(<Drawer controller={controller} initial={projection} cadetId={cadetId} can={permission => permission !== 'cadets.manage'} toasts={[]} />)
    const drawer = screen.getByRole('dialog', { name: 'C-NEED' })
    expect(within(drawer).getByText('Pumps')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /^(Fulfil|Cancel) / })).toBeNull()
  })

  it('in the Still Needed panel, names the cadet and closes the requirement', async () => {
    const { controller } = await cadetWithNeeds(new DistributedAppController(new MemoryRepository()))
    render(<App controller={controller} settingsStorage={new LocalSettingsStorage(memoryStorage())} />)
    const tiles = await screen.findByRole('navigation', { name: 'Dashboard navigation' })
    fireEvent.click(within(tiles).getByRole('button', { name: /Command Center/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Still needed/ }))
    const panel = screen.getByRole('dialog', { name: 'Still Needed' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Fulfil Pumps for C-NEED' }))
    fireEvent.change(within(panel).getByLabelText('Note (optional)'), { target: { value: 'Brought her own' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Mark fulfilled' }))
    await waitFor(async () => expect((await controller.technicalState()).stillNeeded.find(need => need.displayLabel === 'Pumps')).toMatchObject({ status: 'FULFILLED', closeReason: 'Brought her own' }))
    // The requirement leaves the list (the cadet may still show Pumps among missing standard-issue gear, which is a separate list).
    await waitFor(() => expect(within(panel).queryByRole('button', { name: /Pumps for C-NEED/ })).toBeNull())
    expect(within(panel).getByRole('button', { name: 'Cancel Neck Tabs for C-NEED' })).toBeInTheDocument()
  })
})
