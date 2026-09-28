import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SupplyWorkflow } from '../../components/SupplyWorkflow'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'

type WorkflowProps = { controller: DistributedAppController; initial: ArgusAppProjection; cadetId?: string }

function Workflow({ controller, initial, cadetId }: WorkflowProps) {
  const [projection, setProjection] = useState(initial)
  return <SupplyWorkflow mode="ISSUE" projection={projection} controller={controller} selectedCadetId={cadetId} onClose={() => undefined} onChanged={setProjection} />
}

/** Genesis catalog plus the given sizes and stock for catalog items (by name). */
async function stocked(sizes: Record<string, Record<string, number>>) {
  const controller = new DistributedAppController()
  let projection = await controller.initialize()
  for (const [name, stock] of Object.entries(sizes)) {
    const item = projection.catalog.find(candidate => candidate.name === name)!
    projection = await controller.addCatalogSizes(item.catalogId, Object.keys(stock))
    for (const [label, quantity] of Object.entries(stock)) {
      const variant = projection.inventory.find(candidate => candidate.catalogId === item.catalogId && candidate.variant === label)!
      if (quantity > 0) projection = await controller.receiveStock(variant.entityId, quantity)
    }
  }
  const variant = (name: string, label: string) => {
    const catalogId = projection.catalog.find(candidate => candidate.name === name)!.catalogId
    return projection.inventory.find(candidate => candidate.catalogId === catalogId && candidate.variant === label)!
  }
  return { controller, projection, variant }
}

const chooseBundle = (workflow: HTMLElement, name: string) =>
  fireEvent.click(within(workflow).getAllByRole('button').find(button => button.querySelector('b')?.textContent === name)!)

async function confirmIssue(workflow: HTMLElement) {
  fireEvent.click(within(workflow).getByRole('button', { name: 'Review Issue' }))
  fireEvent.click(within(workflow).getByRole('button', { name: /Confirm Issue/ }))
  await within(workflow).findByText(/Saved locally/)
}

describe('SupplyWorkflow with cadet IDs and catalog bundle lines', () => {
  it('searches cadets by name or code but shows only the cadet ID', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    await controller.createCadet({ fullName: 'Casey Bennett', gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-CB12' })
    const projection = await controller.createCadet({ fullName: 'Jordan Rivera', gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-JR34' })
    render(<Workflow controller={controller} initial={projection} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    expect(within(workflow).getByRole('button', { name: /C-CB12/ })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Casey|Bennett|Jordan|Rivera/)

    fireEvent.change(within(workflow).getByLabelText('Search cadets'), { target: { value: 'bennett' } })
    expect(within(workflow).queryByRole('button', { name: /C-JR34/ })).toBeNull()
    fireEvent.click(within(workflow).getByRole('button', { name: /C-CB12/ }))
    expect(within(workflow).getByText('C-CB12')).toBeInTheDocument()

    fireEvent.click(within(workflow).getByRole('button', { name: 'Change Cadet' }))
    fireEvent.change(within(workflow).getByLabelText('Search cadets'), { target: { value: 'jr34' } })
    expect(within(workflow).getByRole('button', { name: /C-JR34/ })).toBeInTheDocument()
    expect(within(workflow).queryByRole('button', { name: /C-CB12/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Casey|Bennett|Jordan|Rivera/)
  })

  it('picks the saved size, else the first size in stock, and lets each sized line choose its own size', async () => {
    const { controller, projection: stockedProjection, variant } = await stocked({ 'Gold PT Shirt': { S: 0, M: 2, L: 1 }, 'PT Shorts': { S: 4, M: 0 } })
    const projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', sizes: { 'Gold PT Shirt': 'L' } })
    const cadetId = projection.cadets[0].cadetId
    expect(stockedProjection.bundles.find(bundle => bundle.bundleId === 'bundle-pt')?.mapping).toMatchObject({ mapped: 2, total: 3 })
    render(<Workflow controller={controller} initial={projection} cadetId={cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    chooseBundle(workflow, 'PT')

    const shirt = within(workflow).getByLabelText('Gold PT Shirt variant')
    const shorts = within(workflow).getByLabelText('PT Shorts variant')
    expect(shirt).toHaveValue(variant('Gold PT Shirt', 'L').entityId)
    expect(shorts).toHaveValue(variant('PT Shorts', 'S').entityId)
    // Sizes are independent per line: changing the shirt leaves the shorts alone.
    fireEvent.change(shirt, { target: { value: variant('Gold PT Shirt', 'M').entityId } })
    expect(shorts).toHaveValue(variant('PT Shorts', 'S').entityId)
    await confirmIssue(workflow)

    const after = await controller.project()
    const onHand = (name: string, label: string) => after.inventory.find(item => item.entityId === variant(name, label).entityId)?.onHand
    expect(onHand('Gold PT Shirt', 'M')).toBe(1)
    expect(onHand('Gold PT Shirt', 'L')).toBe(1)
    expect(onHand('PT Shorts', 'S')).toBe(3)
    expect(after.cadets[0].currentProperty.map(line => `${line.label} ${line.variant}`).sort()).toEqual(['Gold PT Shirt M', 'PT Shorts S'])
    // Khaki Ball Cap has no sizes yet, so it stays an unmapped Still Needed line.
    expect(after.stillNeeded).toEqual([expect.objectContaining({ displayLabel: 'Khaki Ball Cap', itemId: undefined })])
  })

  it('keeps an out-of-stock saved size instead of swapping it, recording that exact size as Still Needed', async () => {
    const { controller, variant } = await stocked({ 'PT Shorts': { S: 4, M: 0 } })
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', sizes: { 'PT Shorts': 'M' } })
    render(<Workflow controller={controller} initial={projection} cadetId={projection.cadets[0].cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    chooseBundle(workflow, 'PT')
    expect(within(workflow).getByLabelText('PT Shorts variant')).toHaveValue(variant('PT Shorts', 'M').entityId)
    // Nothing is in stock for this cadet, so the partial issue records only Still Needed lines.
    await confirmIssue(workflow)
    const after = await controller.project()
    expect(after.inventory.find(item => item.entityId === variant('PT Shorts', 'S').entityId)?.onHand).toBe(4)
    expect(after.stillNeeded).toEqual(expect.arrayContaining([expect.objectContaining({ displayLabel: 'PT Shorts', itemId: variant('PT Shorts', 'M').entityId, size: 'M' })]))
  })
})
