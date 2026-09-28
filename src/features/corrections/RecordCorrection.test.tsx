import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { CadetDrawer } from '../cadets/CadetDrawer'
import { ReceiptHistory } from './ReceiptHistory'

async function stockedShorts() {
  const controller = new DistributedAppController()
  let projection = await controller.initialize()
  const shorts = projection.catalog.find(item => item.name === 'PT Shorts')!
  projection = await controller.addCatalogSizes(shorts.catalogId, ['M'])
  const medium = projection.inventory.find(item => item.catalogId === shorts.catalogId)!
  projection = await controller.receiveStock(medium.entityId, 5, 'District shipment')
  return { controller, projection, medium: medium.entityId }
}

function CadetRecord({ controller, initial, cadetId, can = () => true, toasts }: { controller: DistributedAppController; initial: ArgusAppProjection; cadetId: string; can?: (permission: ArgusPermission) => boolean; toasts: string[] }) {
  const [projection, setProjection] = useState(initial)
  return <CadetDrawer cadet={projection.cadets.find(cadet => cadet.cadetId === cadetId)!} projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} onIssue={() => undefined} onReturn={() => undefined} close={() => undefined} />
}

function Receipts({ controller, initial, itemId }: { controller: DistributedAppController; initial: ArgusAppProjection; itemId: string }) {
  const [projection, setProjection] = useState(initial)
  return <ReceiptHistory variants={projection.inventory.filter(item => item.entityId === itemId)} projection={projection} controller={controller} canCorrect onProjection={setProjection} notify={() => undefined} />
}

describe('record corrections in the UI (spec §12)', () => {
  it('corrects an issued quantity from the cadet history; the original stays and the record shows the corrected value', async () => {
    const { controller, medium } = await stockedShorts()
    let projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-FX12' })
    const cadetId = projection.cadets[0].cadetId
    projection = await controller.issueTransaction({ transactionId: 'tx', cadetId, lines: [{ lineId: 'shorts', itemId: medium, quantity: 2 }] })
    const toasts: string[] = []
    render(<CadetRecord controller={controller} initial={projection} cadetId={cadetId} toasts={toasts} />)
    const drawer = screen.getByRole('dialog', { name: 'C-FX12' })
    expect(within(drawer).getByText('PT Shorts · M × 2')).toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole('button', { name: /^Correct quantity in issue of / }))
    const form = within(drawer).getByRole('form', { name: /^Correct quantity of issue of / })
    expect(within(form).getByLabelText('Correct quantity')).toHaveValue(2)
    fireEvent.change(within(form).getByLabelText('Correct quantity'), { target: { value: '1' } })
    expect(within(form).getByText(/The cadet holds 1 fewer and 1 go back on hand\./)).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('Give a reason for the correction.')
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Only one pair handed over' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(within(drawer).queryByRole('form')).toBeNull())

    expect(within(drawer).getByText('PT Shorts · M × 1 (corrected from 2)')).toBeInTheDocument()
    expect(within(drawer).getByText(/^M · Qty 1 · Issued /)).toBeInTheDocument()
    expect(within(drawer).getByText('Issue: PT Shorts · M 2 → 1')).toBeInTheDocument()
    expect(within(drawer).getByText('Only one pair handed over')).toBeInTheDocument()
    expect(toasts).toEqual(['Issue corrected for C-FX12: PT Shorts · M: 2 → 1.'])
    const after = await controller.project()
    expect(after.inventory.find(item => item.entityId === medium)).toMatchObject({ onHand: 4, issued: 1 })
    expect(after.events.find(record => record.event.eventType === 'ITEM_ISSUED')!.event.payload.lines).toEqual([expect.objectContaining({ quantity: 2 })])
  })

  it('offers no correction without inventory.adjust', async () => {
    const { controller, medium } = await stockedShorts()
    let projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-FX34' })
    const cadetId = projection.cadets[0].cadetId
    projection = await controller.issueTransaction({ transactionId: 'tx', cadetId, lines: [{ lineId: 'shorts', itemId: medium, quantity: 1 }] })
    render(<CadetRecord controller={controller} initial={projection} cadetId={cadetId} can={permission => permission !== 'inventory.adjust'} toasts={[]} />)
    expect(screen.queryByRole('button', { name: /^Correct quantity/ })).toBeNull()
  })

  it('corrects a receipt from the item’s received-stock history', async () => {
    const { controller, projection, medium } = await stockedShorts()
    render(<Receipts controller={controller} initial={projection} itemId={medium} />)
    const history = screen.getByRole('region', { name: 'Received stock' })
    expect(within(history).getByText('M · 5 received')).toBeInTheDocument()
    fireEvent.click(within(history).getByRole('button', { name: /^Correct receipt of 5 × PT Shorts · M on / }))
    const form = within(history).getByRole('form')
    fireEvent.change(within(form).getByLabelText('Correct quantity'), { target: { value: '3' } })
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Box held 3' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }))
    await waitFor(() => expect(within(history).getByText('M · 3 received (corrected from 5)')).toBeInTheDocument())
    expect((await controller.project()).inventory.find(item => item.entityId === medium)?.onHand).toBe(3)
  })
})
