import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../../auth/authorization'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission, ArgusRole } from '../../distributed/types'
import { MockIdentityProvider } from '../../identity/identity'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { MemoryRepository } from '../../storage/repository'
import { MockSyncProvider } from '../../sync/mock'
import { SharedCountView } from './SharedCountView'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const permitted = (role: ArgusRole) => (permission: ArgusPermission) => ROLE_PERMISSIONS[role].includes(permission)

function Harness({ controller, initial, role, notify = () => undefined }: { controller: DistributedAppController; initial: ArgusAppProjection; role: ArgusRole; notify?: (message: string) => void }) {
  const [projection, setProjection] = useState(initial)
  const memberName = (id: string) => (id === projection.actor ? 'You' : id.includes('assistant') ? 'Cadet Assistant' : 'Supply Officer')
  return <SharedCountView projection={projection} controller={controller} can={permitted(role)} memberName={memberName} onProjection={setProjection} notify={notify} />
}

/** One officer and two assistants on separate devices sharing one history. */
async function unit() {
  const root = new MockIdentityProvider('approval-ui-root'), authorization = new AuthorizationService(await root.getPublicIdentity(), root), provider = new MockSyncProvider()
  const people: Record<'officer' | 'assistant' | 'second', DistributedAppController> = {} as never
  for (const [name, role] of [['officer', 'SUPPLY_OFFICER'], ['assistant', 'SUPPLY_ASSISTANT'], ['second', 'SUPPLY_ASSISTANT']] as const) {
    const identity = new MockIdentityProvider(`${name === 'officer' ? 'officer' : `assistant-${name}`}`)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: '2026-01-01T00:00:00.000Z' }))
    people[name] = new DistributedAppController(new MemoryRepository(), { identity, authorization, provider, organizationId: 'unit-approval-ui' })
    await people[name].initialize()
  }
  const started = await people.officer.addCatalogSizes(PT_SHORTS, ['S', 'M'])
  const medium = started.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!.entityId
  await people.officer.createCountSession({ sessionId: 'count', scope: 'Spring count' })
  for (const name of ['assistant', 'second'] as const) await people[name].sync()
  return { ...people, medium }
}

const kicker = () => screen.getByText(/^SHARED COUNT · /)

describe('count approval (spec §13)', () => {
  it('an assistant submits the count for approval; it then reads Needs approval and closes to contributions', async () => {
    const { officer, assistant, medium } = await unit()
    const notify = vi.fn()
    await assistant.contributeCount('count', { itemId: medium }, 5)
    render(<Harness controller={assistant} initial={await assistant.project()} role="SUPPLY_ASSISTANT" notify={notify} />)
    expect(kicker()).toHaveTextContent('SHARED COUNT · ACTIVE')
    expect(screen.queryByRole('button', { name: /finalize|approve|send back/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }))
    const drawer = screen.getByRole('dialog', { name: 'Submit for approval' })
    expect(drawer).toHaveTextContent('1 size counted')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Submit to an officer' }))
    await waitFor(() => expect(kicker()).toHaveTextContent('SHARED COUNT · NEEDS APPROVAL'))
    expect(notify).toHaveBeenCalledWith('Count submitted for approval. An officer will review it.')
    expect(screen.getByText('Needs approval', { selector: '.count-lifecycle' })).toBeInTheDocument()
    expect(screen.getByText('Needs approval — contributions are closed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).not.toBeInTheDocument()
    expect((await officer.sync()).countSessions[0]).toMatchObject({ status: 'SUBMITTED', totals: { [medium]: 5 } })
  })

  it('the officer sees late work, sends the count back with a reason, then finalizes it', async () => {
    const { officer, assistant, second, medium } = await unit()
    await assistant.contributeCount('count', { itemId: medium }, 5)
    second.setOnline(false)
    await assistant.submitCountSession('count')
    // The second assistant was offline and counted the back shelf after the submission.
    await second.contributeCount('count', { itemId: medium }, 2, 'Back shelf')
    second.setOnline(true); await second.sync()
    const notify = vi.fn()
    render(<Harness controller={officer} initial={await officer.sync()} role="SUPPLY_OFFICER" notify={notify} />)
    expect(kicker()).toHaveTextContent('SHARED COUNT · NEEDS APPROVAL')
    expect(screen.getByText(/Submitted by Cadet Assistant/)).toBeInTheDocument()
    expect(screen.getByText('1 late contribution arrived after it was submitted — send it back to include them.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Review and approve' }))
    const approve = screen.getByRole('dialog', { name: 'Approve shared count' })
    expect(within(approve).getByRole('alert')).toHaveTextContent('1 late contribution arrived after this was submitted')
    expect(within(approve).getByRole('button', { name: 'Approve and update on-hand' })).toBeDisabled()
    fireEvent.click(within(approve).getByRole('button', { name: 'Keep counting' }))

    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
    const sendBack = screen.getByRole('dialog', { name: 'Send count back' })
    expect(sendBack).toHaveTextContent('The 1 late contribution will count.')
    fireEvent.click(within(sendBack).getByRole('button', { name: 'Send back for recounting' }))
    expect(within(sendBack).getByRole('alert')).toHaveTextContent('Say what needs another look')
    fireEvent.change(within(sendBack).getByLabelText('What needs another look?'), { target: { value: 'Include the back shelf' } })
    fireEvent.click(within(sendBack).getByRole('button', { name: 'Send back for recounting' }))
    await waitFor(() => expect(kicker()).toHaveTextContent('SHARED COUNT · ACTIVE'))
    expect(notify).toHaveBeenCalledWith('Count sent back. Everyone can add counts again.')
    expect(screen.getByText('Sent back by You')).toBeInTheDocument()
    expect(screen.getByText('“Include the back shelf”')).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: /PT Shorts · M/ })).getAllByRole('cell')[0]).toHaveTextContent('7')

    fireEvent.click(screen.getByRole('button', { name: 'Finalize count' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Finalize shared count' })).getByRole('button', { name: 'Finalize and update on-hand' }))
    expect(await screen.findByRole('region', { name: 'Spring count' })).toHaveTextContent('Reconciled')
    expect((await officer.project()).inventory.find(item => item.entityId === medium)?.onHand).toBe(7)
    expect(within(screen.getByRole('list', { name: 'Earlier counts' })).getByText('Reconciled')).toBeInTheDocument()
  })

  it('assigns categories to people when starting a count, and shows each person what they were asked to count', async () => {
    const controller = new DistributedAppController()
    const initial = await controller.initialize()
    await controller.addCatalogSizes(PT_SHORTS, ['S', 'M'])
    const projection = await controller.addCatalogSizes(GENESIS_CATALOG.find(item => item.name === 'Black Oxfords')!.catalogId, ['9M'])
    const member = (publicIdentity: string, displayName: string) => ({ publicIdentity, displayName, role: 'SUPPLY_ASSISTANT' as const, credentialId: publicIdentity, issuedAt: '2026-01-01T00:00:00.000Z', admittedBy: 'root', admittedEventId: publicIdentity, status: 'ACTIVE' as const })
    const withMembers = { ...projection, members: [member(initial.actor, 'Me'), member('mock:assistant-lee', 'Cadet Lee')] }
    render(<Harness controller={controller} initial={withMembers} role="SUPPLY_OFFICER" />)
    fireEvent.click(screen.getByText('Assign categories to people (optional)'))
    fireEvent.change(screen.getByLabelText('PT'), { target: { value: 'mock:assistant-lee' } })
    fireEvent.change(screen.getByLabelText('Footwear'), { target: { value: initial.actor } })
    fireEvent.click(screen.getByRole('button', { name: 'Start shared count' }))
    expect(await screen.findByText('Assigned to you: Footwear')).toBeInTheDocument()
    const session = (await controller.project()).countSessions[0]
    expect(session.assignments.map(assignment => [assignment.scope, assignment.assignedTo])).toEqual([['PT', 'mock:assistant-lee'], ['PT', 'mock:assistant-lee'], ['Footwear', initial.actor]])
    fireEvent.change(screen.getByLabelText('Search items to count'), { target: { value: 'shorts' } })
    expect(within(screen.getByRole('list', { name: 'Items to count' })).getByRole('button', { name: /PT Shorts/ })).toHaveTextContent('PT · 2 sizes · Assigned to Cadet Assistant')
  })

  it('shows a count that has not synced yet as a Draft, and a cancelled count as Cancelled in the history', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    await controller.createCountSession({ sessionId: 'old', scope: 'Started by mistake' })
    await controller.cancelCountSession('old', 'Wrong day')
    controller.setOnline(false)
    const projection = await controller.createCountSession({ sessionId: 'offline', scope: 'Offline count' })
    const view = render(<Harness controller={controller} initial={projection} role="SUPPLY_OFFICER" />)
    expect(kicker()).toHaveTextContent('SHARED COUNT · DRAFT')
    expect(screen.getByText('Draft — only on this device so far')).toBeInTheDocument()
    view.unmount()

    controller.setOnline(true)
    render(<Harness controller={controller} initial={await controller.sync()} role="SUPPLY_OFFICER" />)
    expect(kicker()).toHaveTextContent('SHARED COUNT · ACTIVE')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel count' }))
    const drawer = screen.getByRole('dialog', { name: 'Cancel shared count' })
    fireEvent.change(within(drawer).getByLabelText('Reason'), { target: { value: 'Duplicate' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel this count' }))
    const history = await screen.findByRole('list', { name: 'Earlier counts' })
    expect(within(history).getAllByText('Cancelled')).toHaveLength(2)
  })
})
