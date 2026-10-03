import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import type { IssuedCadetTicket } from '../../unit/runtime'
import { CadetsView } from './CadetsView'
import type { PhoneTicketMaker } from './PhoneTicketPanel'
import { ticketWaiting } from './phoneTicket'

const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2-34567'
async function setup() {
  const controller = new DistributedAppController()
  await controller.initialize()
  const projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-4F7K', fullName: 'Avery Private' })
  return { controller, projection, cadetId: projection.cadets[0].cadetId }
}
const issued = (cadetId: string): IssuedCadetTicket => ({ ticketId: 't-0123456789abcdef0123', code: CODE, cadetId, displayName: 'Avery Private', ticketAddress: 'addr', channelAddress: 'chan', issuedAt: '2026-10-03T12:00:00.000Z', expiresAt: '2026-10-10T12:00:00.000Z', funding: { txid: 'f'.repeat(64), vout: 0, satoshis: 1000 } })
function Harness({ controller, initial, toasts, make, send, can = () => true }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; make?: PhoneTicketMaker; send?: Parameters<typeof CadetsView>[0]['sendNotice']; can?: (permission: ArgusPermission) => boolean }) {
  const [projection, setProjection] = useState(initial)
  return <CadetsView projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} onIssue={() => undefined} onReturn={() => undefined} {...(make ? { makePhoneTicket: make } : {})} {...(send ? { sendNotice: send } : {})} />
}
const openDrawer = () => { fireEvent.click(screen.getByRole('button', { name: /C-4F7K/ })); return screen.getByRole('dialog', { name: 'C-4F7K' }) }

afterEach(() => { Reflect.deleteProperty(navigator, 'share'); Reflect.deleteProperty(navigator, 'clipboard') })

describe('Make phone ticket in the cadet drawer (mw-kmgi38.13)', () => {
  it('a cadet with no ticket offers Make phone ticket; tapping it shows the code, a QR and Copy, labelled by cadet ID and never the name', async () => {
    const { controller, projection, cadetId } = await setup(), toasts: string[] = []
    const make = vi.fn(async (id: string) => ({ ticket: issued(id), waiting: false }))
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<Harness controller={controller} initial={projection} toasts={toasts} make={make} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Make phone ticket' }))
    expect(await within(drawer).findByText('Phone ticket ready for C-4F7K')).toBeInTheDocument()
    expect(make).toHaveBeenCalledWith(cadetId)
    expect(within(drawer).getByLabelText('Ticket code')).toHaveTextContent(CODE)
    expect(await within(drawer).findByRole('img', { name: 'Ticket QR code for C-4F7K' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE))
    expect(await within(drawer).findByRole('button', { name: 'Code copied ✓' })).toBeInTheDocument()
    expect(toasts).toEqual(['Phone ticket made for C-4F7K.'])
    expect(drawer).not.toHaveTextContent('Avery Private')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Hide' }))
    expect(within(drawer).queryByLabelText('Ticket code')).toBeNull()
  })

  it('a refused ticket (no coins, say) shows the reason and leaves Make phone ticket to try again', async () => {
    const { controller, projection } = await setup()
    const make = vi.fn(async () => { throw new Error('This device does not have enough testnet coins') })
    render(<Harness controller={controller} initial={projection} toasts={[]} make={make} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Make phone ticket' }))
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('not have enough testnet coins')
    expect(within(drawer).getByRole('button', { name: 'Make phone ticket' })).toBeEnabled()
  })

  it('offline, the drawer and the toast say the ticket is saved here and goes out when the network is reachable', async () => {
    const { controller, projection } = await setup(), toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} make={async id => ({ ticket: issued(id), waiting: true })} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Make phone ticket' }))
    expect(await within(drawer).findByText(/saved on this phone and goes out when the network is reachable/)).toBeInTheDocument()
    expect(toasts[0]).toMatch(/^Phone ticket for C-4F7K is saved on this phone and goes out when the network is reachable/)
  })

  it('shows no Make phone ticket without cadets.admit, or on a screen with no way to make one', async () => {
    const { controller, projection } = await setup()
    const view = render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} can={permission => permission !== 'cadets.admit'} />)
    expect(within(openDrawer()).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
    view.unmount()
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    expect(within(openDrawer()).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
  })

  it('a cadet who has a ticket shows when and by whom, no Make phone ticket and no code again; Message this cadet then sends', async () => {
    const { controller, cadetId } = await setup(), toasts: string[] = []
    const send = vi.fn(async () => ({ noticeId: 'n', published: true }))
    await controller.createCadetChannel(cadetId)
    const { channelAddress } = (await controller.technicalState()).cadetChannels[0]
    await controller.recordCadetTicketIssued({ ticketId: 't-0123456789abcdef0123', cadetId, ticketAddress: channelAddress, channelAddress, issuedAt: '2026-10-03T12:00:00.000Z', expiresAt: '2026-10-10T12:00:00.000Z', funding: { txid: 'f'.repeat(64), vout: 0, satoshis: 1000 } })
    const make = vi.fn()
    render(<Harness controller={controller} initial={await controller.project()} toasts={toasts} make={make} send={send} />)
    const drawer = openDrawer()
    expect(await within(drawer).findByText(`Phone ticket made ${new Date('2026-10-03T12:00:00.000Z').toLocaleDateString()} by You`)).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
    expect(within(drawer).queryByLabelText('Ticket code')).toBeNull()
    expect(make).not.toHaveBeenCalled()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Message this cadet' }))
    fireEvent.change(within(drawer).getByLabelText('Message to this cadet'), { target: { value: 'Come to supply Thursday' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(toasts).toEqual(['Message sent to C-4F7K']))
    expect(send).toHaveBeenCalledWith({ cadetId }, 'Come to supply Thursday')
  })

  it('a ticket waits when the phone is offline, the network errored or the wallet needs coins, and not when synced or syncing', () => {
    expect(ticketWaiting({ state: 'offline' })).toBe(true)
    expect(ticketWaiting({ state: 'error' })).toBe(true)
    expect(ticketWaiting({ state: 'synced', needsFunding: { address: 'a', spendable: 0, needed: 1 } })).toBe(true)
    expect(ticketWaiting({ state: 'synced' })).toBe(false)
    expect(ticketWaiting({ state: 'syncing' })).toBe(false)
  })

  it('staff without cadets.admit still see that a ticket was made, but are offered no way to make one', async () => {
    const { controller, cadetId } = await setup()
    await controller.createCadetChannel(cadetId)
    const { channelAddress } = (await controller.technicalState()).cadetChannels[0]
    await controller.recordCadetTicketIssued({ ticketId: 't-0123456789abcdef0123', cadetId, ticketAddress: channelAddress, channelAddress, issuedAt: '2026-10-03T12:00:00.000Z', expiresAt: '2026-10-10T12:00:00.000Z', funding: { txid: 'f'.repeat(64), vout: 0, satoshis: 1000 } })
    render(<Harness controller={controller} initial={await controller.project()} toasts={[]} make={vi.fn()} can={permission => permission !== 'cadets.admit'} />)
    const drawer = openDrawer()
    expect(await within(drawer).findByText(/^Phone ticket made .* by You$/)).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
  })
})
