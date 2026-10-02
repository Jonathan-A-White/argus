import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { CadetsView } from './CadetsView'
import { correctionOptions, memberLabel } from './cadetDisplay'

const CODE = 'C-SDB1'
const NAME = 'Jordan Rivera'

function Harness({ controller, initial, toasts, can = () => true }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; can?: (permission: ArgusPermission) => boolean }) {
  const [projection, setProjection] = useState(initial)
  return (
    <CadetsView
      projection={projection}
      controller={controller}
      can={can}
      onProjection={setProjection}
      notify={message => toasts.push(message)}
      onIssue={() => undefined}
      onReturn={() => undefined}
    />
  )
}

/** A cadet who was issued one 34R Male SDB Jacket; 32R has stock, 36R is set up but empty. */
async function issuedWrongSize(quantity = 1) {
  const controller = new DistributedAppController()
  let projection = await controller.initialize()
  const jacket = projection.catalog.find(item => item.name === 'Male SDB Jacket')!
  projection = await controller.addCatalogSizes(jacket.catalogId, ['34R', '32R', '36R'])
  const size = (label: string) => projection.inventory.find(item => item.catalogId === jacket.catalogId && item.variant === label)!.entityId
  const [r34, r32, r36] = [size('34R'), size('32R'), size('36R')]
  await controller.receiveStock(r34, 3)
  await controller.receiveStock(r32, 2)
  projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS3', status: 'ACTIVE', cadetCode: CODE, fullName: NAME })
  const cadetId = projection.cadets[0].cadetId
  projection = await controller.issueTransaction({ transactionId: 'tx-jacket', cadetId, lines: [{ lineId: 'jacket', itemId: r34, quantity }] })
  return { controller, projection, cadetId, r34, r32, r36 }
}

const openRecord = () => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(CODE) }))
  return screen.getByRole('dialog', { name: CODE })
}

describe('issued size correction in the cadet record (spec §12)', () => {
  it('corrects 34R to 32R through the UI: the record shows 32R, stock moves, and the history keeps both', async () => {
    const { controller, projection, cadetId, r34, r32, r36 } = await issuedWrongSize()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    const drawer = openRecord()
    expect(within(drawer).getByText(/^34R · Qty 1 · Issued /)).toBeInTheDocument()
    expect(within(drawer).getByText('No size corrections.')).toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole('button', { name: /Correct size/ }))
    const form = within(drawer).getByRole('form', { name: 'Correct size of Male SDB Jacket · 34R' })
    const select = within(form).getByLabelText('Correct to size')
    // Only other active sizes of the same catalog item are offered, each with its on-hand count.
    const options = within(select).getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual(['Choose a size…', '32R · 2 on hand', '36R · 0 on hand · not enough'])
    expect(options.find(option => option.getAttribute('value') === r36)).toBeDisabled()
    expect(options.some(option => option.getAttribute('value') === r34)).toBe(false)
    // Single-unit lines need no quantity field.
    expect(within(form).queryByLabelText('Quantity to correct')).toBeNull()

    // The reason is required.
    fireEvent.change(select, { target: { value: r32 } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('Give a reason for the correction.')
    expect((await controller.project()).corrections).toHaveLength(0)

    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Recorded 34R; cadet wears 32R' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(within(drawer).queryByRole('form')).toBeNull())

    expect(within(drawer).getByText(/^32R · Qty 1 · Issued /)).toBeInTheDocument()
    expect(within(drawer).queryByText(/^34R · Qty/)).toBeNull()
    expect(toasts).toEqual([`Size corrected for ${CODE}: Male SDB Jacket 34R → 32R.`])

    // Correction history, while the original issue stays in the issue history.
    expect(within(drawer).getByText('Male SDB Jacket: 34R → 32R')).toBeInTheDocument()
    expect(within(drawer).getByText('Recorded 34R; cadet wears 32R')).toBeInTheDocument()
    expect(within(drawer).getByText(/ · You$/)).toBeInTheDocument()
    expect(within(drawer).getByText('Male SDB Jacket · 34R × 1')).toBeInTheDocument()
    expect(screen.getByText(NAME)).toBeInTheDocument()

    const after = await controller.project()
    expect(after.inventory.find(item => item.entityId === r34)).toMatchObject({ onHand: 3, issued: 0 })
    expect(after.inventory.find(item => item.entityId === r32)).toMatchObject({ onHand: 1, issued: 1 })
    expect(after.cadets[0].currentProperty).toMatchObject([{ itemId: r32, variant: '32R', quantity: 1 }])
    expect(after.corrections).toMatchObject([{ cadetId, fromItemId: r34, toItemId: r32, quantity: 1, reason: 'Recorded 34R; cadet wears 32R' }])
    expect(after.events.map(record => record.event.eventType)).toEqual(expect.arrayContaining(['ITEM_ISSUED', 'PROPERTY_CORRECTED']))
  })

  it('corrects part of a multi-unit line and blocks sizes without enough stock', async () => {
    const { controller, projection, r34, r32 } = await issuedWrongSize(3)
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    const drawer = openRecord()
    fireEvent.click(within(drawer).getByRole('button', { name: /Correct size/ }))
    const form = within(drawer).getByRole('form')
    const quantity = within(form).getByLabelText('Quantity to correct')
    expect(quantity).toHaveValue(3)
    // All 3 cannot move to 32R (2 on hand), so 32R is disabled until the quantity is lowered.
    const option32 = () => within(form).getAllByRole('option').find(option => option.getAttribute('value') === r32)!
    expect(option32()).toBeDisabled()
    fireEvent.change(quantity, { target: { value: '2' } })
    expect(option32()).toBeEnabled()
    fireEvent.change(within(form).getByLabelText('Correct to size'), { target: { value: r32 } })
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Two of three were 32R' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(within(drawer).queryByRole('form')).toBeNull())

    expect(within(drawer).getByText(/^34R · Qty 1 · /)).toBeInTheDocument()
    expect(within(drawer).getByText(/^32R · Qty 2 · /)).toBeInTheDocument()
    const after = await controller.project()
    expect(after.inventory.find(item => item.entityId === r34)).toMatchObject({ onHand: 2, issued: 1 })
    expect(after.inventory.find(item => item.entityId === r32)).toMatchObject({ onHand: 0, issued: 2 })
  })

  it('keeps the form open with the error when the correction is refused', async () => {
    const { controller, projection, r32 } = await issuedWrongSize()
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    const drawer = openRecord()
    fireEvent.click(within(drawer).getByRole('button', { name: /Correct size/ }))
    const form = within(drawer).getByRole('form')
    fireEvent.change(within(form).getByLabelText('Correct to size'), { target: { value: r32 } })
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Wrong size recorded' } })
    const refused = vi.spyOn(controller, 'correctIssuedSize').mockRejectedValueOnce(new Error('Missing permission: inventory.adjust'))
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }))
    expect(await within(form).findByText('Missing permission: inventory.adjust')).toBeInTheDocument()
    expect(within(form).getByLabelText('Reason')).toHaveValue('Wrong size recorded')
    refused.mockRestore()
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(within(drawer).queryByRole('form')).toBeNull()
    expect(within(drawer).getByRole('button', { name: /Correct size/ })).toBeInTheDocument()
  })

  it('offers "Correct size" only to people with inventory.adjust', async () => {
    const { controller, projection } = await issuedWrongSize()
    render(<Harness controller={controller} initial={projection} toasts={[]} can={permission => permission !== 'inventory.adjust'} />)
    const drawer = openRecord()
    expect(within(drawer).getByText('Male SDB Jacket')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /Correct size/ })).toBeNull()
    expect(within(drawer).getByRole('heading', { name: 'Size corrections' })).toBeInTheDocument()
  })
})

describe('cadet display helpers', () => {
  it('lists sibling sizes of the same catalog item only, and names staff without exposing identities', async () => {
    const { projection, r34, r32, r36 } = await issuedWrongSize()
    expect(correctionOptions(projection.inventory, r34).map(item => item.entityId)).toEqual([r32, r36])
    expect(correctionOptions(projection.inventory, 'missing')).toEqual([])
    const members = [{ publicIdentity: 'key:officer', displayName: 'Officer Lee' }]
    expect(memberLabel({ actor: 'key:me', members }, 'key:me')).toBe('You')
    expect(memberLabel({ actor: 'key:me', members }, 'key:officer')).toBe('Officer Lee')
    expect(memberLabel({ actor: 'key:me', members }, 'key:stranger')).toBe('Unit member')
  })
})
