import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../../auth/authorization'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { MockIdentityProvider } from '../../identity/identity'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { MemoryRepository } from '../../storage/repository'
import { MockSyncProvider } from '../../sync/mock'
import { SharedCountView } from './SharedCountView'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const officer = () => true

type HarnessProps = {
  controller: DistributedAppController
  initial: ArgusAppProjection
  can?: (permission: ArgusPermission) => boolean
  names?: Record<string, string>
  notify?: (message: string) => void
  initialItemId?: string
}

/** Holds the projection the way App.tsx does, so onProjection re-renders the view. */
function Harness({ controller, initial, can = officer, names = {}, notify = () => undefined, initialItemId }: HarnessProps) {
  const [projection, setProjection] = useState(initial)
  const memberName = (id: string) => (id === projection.actor ? 'You' : (names[id] ?? 'Unit member'))
  return (
    <SharedCountView
      projection={projection}
      controller={controller}
      can={can}
      memberName={memberName}
      onProjection={setProjection}
      notify={notify}
      initialItemId={initialItemId}
    />
  )
}

async function twoPeople() {
  const root = new MockIdentityProvider('root')
  const auth = new AuthorizationService(await root.getPublicIdentity(), root)
  const a = new MockIdentityProvider('a')
  const b = new MockIdentityProvider('b')
  for (const id of [a, b]) {
    await auth.acceptCredential(
      await issueCredential(root, {
        subjectPublicIdentity: await id.getPublicIdentity(),
        role: 'SUPPLY_OFFICER',
        permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER],
        issuedAt: '2026-01-01T00:00:00.000Z',
      }),
    )
  }
  const provider = new MockSyncProvider()
  const ca = new DistributedAppController(new MemoryRepository(), { identity: a, authorization: auth, provider, organizationId: 'unit-test' })
  const cb = new DistributedAppController(new MemoryRepository(), { identity: b, authorization: auth, provider, organizationId: 'unit-test' })
  await ca.initialize()
  await cb.initialize()
  return { ca, cb, actorB: await b.getPublicIdentity() }
}

async function demoWithSession() {
  const controller = new DistributedAppController()
  await controller.initialize()
  await controller.addCatalogSizes(PT_SHORTS, ['S', 'M', 'L'])
  const projection = await controller.createCountSession({ sessionId: 'count_test', scope: 'Spring count' })
  const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!
  return { controller, projection, medium }
}

const yourCount = () => screen.getByRole('status', { name: 'Your count' })
const sharedTotal = () => screen.getByRole('status', { name: 'Shared total' })

describe('SharedCountView', () => {
  it('adds A’s 3 and B’s 3 into a shared total of 6, then finalizes on-hand to 6', async () => {
    const { ca, cb, actorB } = await twoPeople()
    const notify = vi.fn()
    const projection = await ca.addCatalogSizes(PT_SHORTS, ['S', 'M', 'L'])
    render(<Harness controller={ca} initial={projection} names={{ [actorB]: 'Officer B' }} notify={notify} />)

    expect(screen.getByText(/Everyone's counts add up into one shared total/, { selector: '.count-start > p' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start shared count' }))
    expect(await screen.findByRole('heading', { level: 2, name: /^Physical count / })).toBeInTheDocument()

    // Person A picks PT Shorts · M and taps 3 times.
    fireEvent.change(screen.getByLabelText('Search items to count'), { target: { value: 'PT Shorts' } })
    fireEvent.click(within(screen.getByRole('list', { name: 'Items to count' })).getByRole('button', { name: /PT Shorts/ }))
    fireEvent.click(screen.getByRole('button', { name: /^M:/ }))
    for (let tap = 0; tap < 3; tap++) fireEvent.click(screen.getByRole('button', { name: 'Add 1' }))
    expect(yourCount()).toHaveTextContent('3')
    fireEvent.click(screen.getByRole('button', { name: 'Add my count to shared total' }))
    await waitFor(() => expect(sharedTotal()).toHaveTextContent('3'))
    expect(yourCount()).toHaveTextContent('0')

    // Person B, on another device with their own key, adds 3 for the same size.
    await cb.sync()
    const seenByB = await cb.project()
    const medium = seenByB.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!
    await cb.contributeCount(seenByB.countSessions[0].sessionId, { itemId: medium.entityId }, 3, 'Shelf B')

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(sharedTotal()).toHaveTextContent('6'))
    const contributions = screen.getByRole('list', { name: 'Contributions' })
    expect(within(contributions).getByText('You')).toBeInTheDocument()
    expect(within(contributions).getByText('Officer B')).toBeInTheDocument()
    expect(within(contributions).getByText(/Shelf B/)).toBeInTheDocument()
    const summaryRow = screen.getByRole('row', { name: /PT Shorts · M/ })
    expect(within(summaryRow).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['6', '0', '+6', '2'])

    // The officer reviews and finalizes.
    fireEvent.click(screen.getByRole('button', { name: 'Finalize count' }))
    const drawer = screen.getByRole('dialog', { name: 'Finalize shared count' })
    expect(within(drawer).getByText('On hand changes from 0 to 6')).toBeInTheDocument()
    expect(within(drawer).getAllByText('not counted — on-hand unchanged').length).toBeGreaterThan(0)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Finalize and update on-hand' }))

    const finalized = await screen.findByRole('region', { name: /^Physical count / })
    const row = within(finalized).getByRole('row', { name: /PT Shorts · M/ })
    expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['0', '6', '6'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith('Count finalized — on-hand updated for 1 size.')
    expect((await ca.project()).inventory.find(item => item.entityId === medium.entityId)?.onHand).toBe(6)
    // With nothing open any more, anyone can start the next count.
    expect(screen.getByRole('button', { name: 'Start shared count' })).toBeInTheDocument()
  })

  it('keeps the personal draft tally across unmount and remount, and clears it once added', async () => {
    const { controller, projection, medium } = await demoWithSession()
    const key = `argus.count.draft.count_test.${medium.entityId}`
    const first = render(<Harness controller={controller} initial={projection} initialItemId={medium.entityId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }))
    fireEvent.click(screen.getByRole('button', { name: '5' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 5' }))
    expect(yourCount()).toHaveTextContent('7')
    expect(localStorage.getItem(key)).toBe('7')
    first.unmount()

    render(<Harness controller={controller} initial={projection} initialItemId={medium.entityId} />)
    expect(yourCount()).toHaveTextContent('7')
    fireEvent.click(screen.getByRole('button', { name: 'Add my count to shared total' }))
    await waitFor(() => expect(sharedTotal()).toHaveTextContent('7'))
    expect(localStorage.getItem(key)).toBeNull()
    expect(yourCount()).toHaveTextContent('0')
  })

  it('hides Finalize and Cancel for a role without inventory.adjust but still lets them count', async () => {
    const { controller, projection, medium } = await demoWithSession()
    const assistant = (permission: ArgusPermission) => ROLE_PERMISSIONS.SUPPLY_ASSISTANT.includes(permission)
    render(<Harness controller={controller} initial={projection} can={assistant} initialItemId={medium.entityId} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Spring count' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /finalize/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel count/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add my count to shared total' }))
    await waitFor(() => expect(sharedTotal()).toHaveTextContent('1'))
  })

  it('supports a custom step, undo, an explicit zero, and correcting your own contribution', async () => {
    const { controller, projection, medium } = await demoWithSession()
    const small = projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'S')!
    render(<Harness controller={controller} initial={projection} initialItemId={medium.entityId} />)

    fireEvent.click(screen.getByRole('button', { name: 'Custom step' }))
    fireEvent.change(screen.getByLabelText('Custom count step'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 1000.')
    fireEvent.change(screen.getByLabelText('Custom count step'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 12' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 12' }))
    expect(yourCount()).toHaveTextContent('24')
    fireEvent.click(screen.getByRole('button', { name: /Undo last tap/ }))
    expect(yourCount()).toHaveTextContent('12')
    expect(screen.getByRole('button', { name: 'Subtract 12' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Back room' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add my count to shared total' }))
    await waitFor(() => expect(sharedTotal()).toHaveTextContent('12'))

    fireEvent.click(screen.getByRole('button', { name: 'Correct your count of 12' }))
    fireEvent.change(screen.getByLabelText('Correct quantity'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))
    expect(await screen.findByText('Say briefly why you are correcting it.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Two were display samples' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(sharedTotal()).toHaveTextContent('10'))
    expect(within(screen.getByRole('list', { name: 'Contributions' })).getByText('Corrected')).toBeInTheDocument()

    // An empty shelf is recorded only through the explicit zero action.
    fireEvent.click(screen.getByRole('button', { name: /^S:/ }))
    expect(screen.getByRole('button', { name: 'Add my count to shared total' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Counted zero here' }))
    await waitFor(async () => {
      const session = (await controller.project()).countSessions[0]
      expect(session.observations.filter(observation => observation.itemId === small.entityId)).toMatchObject([{ quantity: 0 }])
    })
  })

  it('explains that sizes are configured in Inventory when a sized item has none', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    const projection = await controller.createCountSession({ sessionId: 'count_empty', scope: 'Empty sizes' })
    const notify = vi.fn()
    render(<Harness controller={controller} initial={projection} notify={notify} />)
    fireEvent.change(screen.getByLabelText('Search items to count'), { target: { value: 'garrison' } })
    fireEvent.click(screen.getByRole('button', { name: /Garrison Cap/ }))
    expect(screen.getByText('Garrison Cap has no sizes yet.')).toBeInTheDocument()
    expect(screen.getByText(/Sizes are configured in Inventory/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'How do I add sizes?' }))
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Open Inventory, choose Garrison Cap/))

    // Unsized items select their single "One size" variant straight away.
    fireEvent.click(screen.getByRole('button', { name: 'Change item' }))
    fireEvent.change(screen.getByLabelText('Search items to count'), { target: { value: 'buckle' } })
    fireEvent.click(screen.getByRole('button', { name: /^Buckle/ }))
    expect(yourCount()).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: 'Add 1' })).toBeInTheDocument()
  })

  it('cancels a count with a reason without touching stock', async () => {
    const { controller, projection } = await demoWithSession()
    render(<Harness controller={controller} initial={projection} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel count' }))
    const drawer = screen.getByRole('dialog', { name: 'Cancel shared count' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel this count' }))
    expect(within(drawer).getByRole('alert')).toHaveTextContent(/reason/)
    fireEvent.change(within(drawer).getByLabelText('Reason'), { target: { value: 'Started by mistake' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel this count' }))
    expect(await screen.findByRole('button', { name: 'Start shared count' })).toBeInTheDocument()
    expect((await controller.project()).countSessions[0].status).toBe('CANCELLED')
  })

  it('flags stock that moved during the count and contributions that arrived late', async () => {
    const { ca, cb } = await twoPeople()
    await ca.addCatalogSizes(PT_SHORTS, ['M'])
    const started = await ca.createCountSession({ sessionId: 'count_late', scope: 'Late work' })
    const medium = started.inventory.find(item => item.catalogId === PT_SHORTS)!
    await cb.sync()
    await ca.contributeCount('count_late', { itemId: medium.entityId }, 4)
    const projection = await ca.receiveStock(medium.entityId, 2, 'Delivery during count')
    cb.setOnline(false)
    await cb.contributeCount('count_late', { itemId: medium.entityId }, 5)
    render(<Harness controller={ca} initial={projection} />)

    fireEvent.click(screen.getByRole('button', { name: 'Finalize count' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Finalize and update on-hand' }))
    const finalized = await screen.findByRole('region', { name: 'Late work' })
    expect(within(finalized).getByText('Stock moved during this count — verify')).toBeInTheDocument()
    expect(within(finalized).getByText(/PT Shorts · M/, { selector: 'p' })).toBeInTheDocument()

    // B comes back online after the officer finalized: B's 5 is kept as late work and never changes stock.
    cb.setOnline(true)
    await cb.sync()
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(await within(finalized).findByText('1 late contribution')).toBeInTheDocument()
    expect((await ca.project()).inventory.find(item => item.entityId === medium.entityId)?.onHand).toBe(4)
  })
})

describe('Sync now feedback (M4)', () => {
  it('tells the person what the sync actually did, including a failure', async () => {
    const controller = new DistributedAppController()
    const projection = await controller.initialize()
    const notify = vi.fn()
    const message = 'Could not sync with BSV testnet. The BSV testnet service could not be reached (no connection, or it is busy). Your work is saved on this device.'
    const syncNow = vi.fn(async () => ({ projection, message }))
    render(<SharedCountView projection={projection} controller={controller} can={officer} memberName={() => 'You'} onProjection={() => undefined} notify={notify} syncNow={syncNow} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(message))
    expect(syncNow).toHaveBeenCalledTimes(1)
  })

  it('without a chain sync it still confirms the check on this device', async () => {
    const controller = new DistributedAppController()
    const projection = await controller.initialize()
    const notify = vi.fn()
    render(<SharedCountView projection={projection} controller={controller} can={officer} memberName={() => 'You'} onProjection={() => undefined} notify={notify} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Up to date with the records on this device.'))
  })
})
