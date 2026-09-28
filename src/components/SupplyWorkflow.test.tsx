import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SupplyWorkflow } from './SupplyWorkflow'
import { DistributedAppController, type ArgusAppProjection } from '../distributed/appIntegration'
import { FACTORY_BUNDLES } from '../stage3/domain'

function Workflow({ mode = 'ISSUE', controller, initial, cadetId }: { mode?: 'ISSUE' | 'RETURN'; controller: DistributedAppController; initial: ArgusAppProjection; cadetId?: string }) {
  const [projection, setProjection] = useState(initial)
  return <SupplyWorkflow mode={mode} projection={projection} controller={controller} selectedCadetId={cadetId} onClose={() => undefined} onChanged={setProjection} />
}

/** Genesis catalog plus sizes and stock for the named catalog items. */
async function stocked(sizes: Record<string, Record<string, number>>) {
  const controller = new DistributedAppController()
  let projection = await controller.initialize()
  for (const [name, stock] of Object.entries(sizes)) {
    const item = projection.catalog.find(candidate => candidate.name === name)!
    if (item.sized) projection = await controller.addCatalogSizes(item.catalogId, Object.keys(stock))
    for (const [label, quantity] of Object.entries(stock)) {
      const variant = projection.inventory.find(candidate => candidate.catalogId === item.catalogId && (item.sized ? candidate.variant === label : true))!
      if (quantity > 0) projection = await controller.receiveStock(variant.entityId, quantity)
    }
  }
  const variant = (name: string, label?: string) => {
    const catalogId = projection.catalog.find(candidate => candidate.name === name)!.catalogId
    return projection.inventory.find(candidate => candidate.catalogId === catalogId && (label === undefined || candidate.variant === label))!
  }
  return { controller, variant }
}
const bundleButton = (workflow: HTMLElement, name: string) => within(workflow).getAllByRole('button').find(button => button.querySelector('b')?.textContent === name)!

describe('issue workflow (spec §10)', () => {
  it('step 2 shows what the cadet actually holds and still needs, and recommends bundles by their gender field', async () => {
    const { controller, variant } = await stocked({ 'PT Shorts': { M: 3 } })
    const fields = (id: string) => { const { displayName, genderApplicability, purpose, lines, active } = FACTORY_BUNDLES.find(bundle => bundle.bundleId === id)!; return { displayName, genderApplicability, purpose, lines, active } }
    // Renamed bundles keep being recommended by genderApplicability, not by name.
    await controller.updateBundle('bundle-male-nsu', { ...fields('bundle-male-nsu'), displayName: 'Service Uniform A' })
    await controller.updateBundle('bundle-drill', { ...fields('bundle-drill'), displayName: 'Female Drill', genderApplicability: 'Female' })
    let projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-AB12' })
    const cadetId = projection.cadets[0].cadetId
    await controller.issueTransaction({ transactionId: 'earlier', cadetId, lines: [{ lineId: 'shorts', itemId: variant('PT Shorts', 'M').entityId, quantity: 2 }] })
    projection = await controller.addStillNeeded({ cadetId, displayLabel: 'Garrison Cap', size: '7 1/4', quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-01T00:00:00.000Z', source: 'MANUAL' })
    render(<Workflow controller={controller} initial={projection} cadetId={cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })

    const held = within(workflow).getByRole('region', { name: 'Current property' })
    expect(within(held).getByText('PT Shorts')).toBeInTheDocument()
    expect(within(held).getByText(/^Size M · Issued /)).toBeInTheDocument()
    expect(within(held).getByLabelText('Quantity 2')).toHaveTextContent('× 2')
    const needed = within(workflow).getByRole('region', { name: 'Still needed' })
    expect(within(needed).getByText('Garrison Cap')).toBeInTheDocument()
    expect(within(needed).getByText(/^Size 7 1\/4 · Since /)).toBeInTheDocument()
    expect(within(needed).getByLabelText('1 still needed')).toBeInTheDocument()

    const recommended = (name: string) => bundleButton(workflow, name).textContent?.includes('Recommended')
    expect(recommended('Service Uniform A')).toBe(true)
    expect(recommended('Male SDB')).toBe(true)
    expect(recommended('PT')).toBe(true)
    expect(recommended('Female NSU')).toBe(false)
    expect(recommended('Female Drill')).toBe(false)
    expect(bundleButton(workflow, 'Female Drill')).toHaveTextContent('DRILL · Female cadets')
  })

  it('step 6 adds and removes lines on a bundle issue; each sized line keeps its own size and unsized items get no size picker', async () => {
    const { controller, variant } = await stocked({ 'Male SDB Jacket': { '40R': 2, '42R': 2 }, Necktie: { one: 3 }, 'White Dress Shirt': { '15': 2 }, 'PT Shorts': { S: 2, M: 2 } })
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS3', status: 'ACTIVE' })
    const cadetId = projection.cadets[0].cadetId
    render(<Workflow controller={controller} initial={projection} cadetId={cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    fireEvent.click(bundleButton(workflow, 'Male SDB'))

    // Necktie is unsized: no size picker at all. The jacket offers its sizes.
    expect(within(workflow).queryByLabelText('Necktie variant')).toBeNull()
    expect(within(workflow).getByLabelText('Male SDB Jacket variant')).toBeInTheDocument()
    // Required lines cannot be removed (unchecking them records Still Needed); the optional shirt can.
    expect(within(workflow).queryByRole('button', { name: 'Remove Male SDB Jacket' })).toBeNull()
    fireEvent.click(within(workflow).getByRole('button', { name: 'Remove White Dress Shirt' }))
    expect(within(workflow).queryByText('White Dress Shirt')).toBeNull()

    // Extra individual lines can be added to a bundle issue.
    fireEvent.click(within(workflow).getByRole('button', { name: 'Add another item' }))
    fireEvent.change(within(workflow).getByLabelText('Search inventory'), { target: { value: 'pt shorts' } })
    fireEvent.click(within(workflow).getAllByRole('button').find(button => button.querySelector('b')?.textContent === 'PT Shorts' && button.querySelector('small')?.textContent === 'PT · S')!)
    fireEvent.click(within(workflow).getByRole('button', { name: 'Done adding' }))
    expect(within(workflow).getByRole('button', { name: 'Remove PT Shorts' })).toBeInTheDocument()

    // Sizes are independent per line.
    fireEvent.change(within(workflow).getByLabelText('Male SDB Jacket variant'), { target: { value: variant('Male SDB Jacket', '42R').entityId } })
    fireEvent.change(within(workflow).getByLabelText('PT Shorts variant'), { target: { value: variant('PT Shorts', 'M').entityId } })
    expect(within(workflow).getByLabelText('Male SDB Jacket variant')).toHaveValue(variant('Male SDB Jacket', '42R').entityId)
    fireEvent.click(within(workflow).getByRole('button', { name: 'Review Issue' }))
    fireEvent.click(within(workflow).getByRole('button', { name: /Confirm Issue/ }))
    await within(workflow).findByText(/Saved locally/)

    const after = await controller.project()
    expect(after.cadets[0].currentProperty.map(line => `${line.label} ${line.variant}`).sort()).toEqual(['Male SDB Jacket 42R', 'Necktie One size', 'PT Shorts M'])
    expect(after.transactions[0]).toMatchObject({ bundleId: 'bundle-male-sdb', bundleVersion: 1 })
    expect(after.inventory.find(item => item.entityId === variant('White Dress Shirt', '15').entityId)?.onHand).toBe(2)
    expect(after.stillNeeded).toEqual([])
  })
})

describe('return workflow conditions (spec §11)', () => {
  it('records a condition and note per line and returns only serviceable items to on-hand', async () => {
    const { controller, variant } = await stocked({ 'Gold PT Shirt': { M: 4 }, 'PT Shorts': { M: 4 } })
    let projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE' })
    const cadetId = projection.cadets[0].cadetId, shirt = variant('Gold PT Shirt', 'M').entityId, shorts = variant('PT Shorts', 'M').entityId
    projection = await controller.issueTransaction({ transactionId: 'pt', cadetId, lines: [{ lineId: 'shirt', itemId: shirt, quantity: 1 }, { lineId: 'shorts', itemId: shorts, quantity: 1 }] })
    render(<Workflow mode="RETURN" controller={controller} initial={projection} cadetId={cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Return property' })
    expect(within(workflow).getByText(/not added back to on-hand stock/)).toHaveTextContent('Serviceable items go back on the shelf')

    for (const checkbox of within(workflow).getAllByRole('checkbox')) fireEvent.click(checkbox)
    expect(within(workflow).getByLabelText('Gold PT Shirt condition')).toHaveValue('SERVICEABLE')
    fireEvent.change(within(workflow).getByLabelText('PT Shorts condition'), { target: { value: 'LOST' } })
    fireEvent.change(within(workflow).getByLabelText('PT Shorts return note'), { target: { value: 'Left at BLT' } })
    expect(within(workflow).getByText('Clears the cadet’s record · not added back to stock')).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: 'Configure Return' }))
    fireEvent.click(within(workflow).getByRole('button', { name: 'Review Return' }))
    expect(within(workflow).getByLabelText('Stock changes from 3 to 4')).toBeInTheDocument()
    expect(within(workflow).getByLabelText('Stock stays at 3')).toBeInTheDocument()
    expect(within(workflow).getByText(/Quantity 1 · Lost · Left at BLT/)).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: /Confirm Return/ }))
    expect(await within(workflow).findByText('2 items returned · 1 back on the shelf')).toBeInTheDocument()

    const after = await controller.project()
    expect(after.inventory.find(item => item.entityId === shirt)).toMatchObject({ onHand: 4, issued: 0 })
    expect(after.inventory.find(item => item.entityId === shorts)).toMatchObject({ onHand: 3, issued: 0 })
    expect(after.cadets[0].currentProperty).toEqual([])
    expect(after.transactions.find(transaction => transaction.transactionType === 'RETURN')!.lines.map(line => [line.label, line.condition, line.note]).sort()).toEqual([['Gold PT Shirt', 'SERVICEABLE', undefined], ['PT Shorts', 'LOST', 'Left at BLT']])
    // Return lines show what the cadet holds, never the issue-only "Optional item" label.
    expect(within(workflow).queryByText(/Optional item/)).toBeNull()
  })
})

describe('closing the workflow (C1) and moving between steps', () => {
  it('a brand-new unit with no cadets says what to do next and can be left with Cancel, the X, Escape or the backdrop', async () => {
    const controller = new DistributedAppController()
    const projection = await controller.initialize()
    const onClose = vi.fn()
    render(<SupplyWorkflow mode="ISSUE" projection={projection} controller={controller} onClose={onClose} onChanged={() => undefined} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    // Focus moved into the workflow when it opened.
    expect(workflow).toHaveFocus()
    expect(within(workflow).getByText('No cadets yet')).toBeInTheDocument()
    expect(within(workflow).getByText('Add cadets on the Cadets screen, then issue their gear here.')).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // The same close control as every drawer: .icon-button is hidden on phones, .drawer-close never is.
    const close = within(workflow).getByRole('button', { name: 'Close workflow' })
    expect(close).toHaveClass('drawer-close')
    expect(close).not.toHaveClass('icon-button')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
    fireEvent.mouseDown(within(workflow).getByText('No cadets yet'))
    expect(onClose).toHaveBeenCalledTimes(3)
    fireEvent.mouseDown(workflow.parentElement!)
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('offers Back and Cancel on the issue-type step and Back on the configure step', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-BK12' })
    const onClose = vi.fn()
    render(<SupplyWorkflow mode="ISSUE" projection={projection} controller={controller} onClose={onClose} onChanged={() => undefined} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    fireEvent.click(within(workflow).getByRole('button', { name: /C-BK12/ }))
    expect(within(workflow).getByRole('heading', { name: 'Choose issue type' })).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: 'Back' }))
    expect(within(workflow).getByRole('heading', { name: 'Select a cadet' })).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: /C-BK12/ }))
    fireEvent.click(bundleButton(workflow, 'PT'))
    expect(within(workflow).getByRole('heading', { name: 'Configure issue' })).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: 'Back' }))
    expect(within(workflow).getByRole('heading', { name: 'Choose issue type' })).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('each workflow step starts at its top', () => {
  it('opens the review (and Edit) scrolled to the top, not where the previous step was scrolled', async () => {
    const { controller } = await stocked({ 'Black Belt': { one: 5 } })
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    render(<Workflow controller={controller} initial={projection} cadetId={projection.cadets[0].cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    // jsdom does no layout: record what the workflow does to the drawer's scroll position.
    let scrollTop = 0
    Object.defineProperty(workflow, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value } })
    fireEvent.click(bundleButton(workflow, 'Male NSU'))
    expect(scrollTop).toBe(0)
    scrollTop = 640 // the person scrolled down the configure step
    fireEvent.click(within(workflow).getByRole('button', { name: 'Review Issue' }))
    expect(within(workflow).getByText('Issue to')).toBeInTheDocument()
    expect(scrollTop).toBe(0)
    scrollTop = 300
    fireEvent.click(within(workflow).getByRole('button', { name: /Edit/ }))
    expect(within(workflow).getByRole('heading', { name: 'Configure issue' })).toBeInTheDocument()
    expect(scrollTop).toBe(0)
  })
})

describe('required lines above stock (M5)', () => {
  it('issues what is on hand and records the remainder as Still Needed, shown on the line and the review screen', async () => {
    const { controller, variant } = await stocked({ 'Black Belt': { one: 5 } })
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-BB12' })
    const cadetId = projection.cadets[0].cadetId, belt = variant('Black Belt').entityId
    render(<Workflow controller={controller} initial={projection} cadetId={cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    fireEvent.click(bundleButton(workflow, 'Male NSU'))
    fireEvent.change(within(workflow).getByLabelText('Black Belt quantity'), { target: { value: '7' } })

    const line = (label: string) => [...workflow.querySelectorAll<HTMLElement>('.line-editor article')].find(article => article.querySelector('b')?.textContent === label)!
    expect(within(line('Black Belt')).getByText('Partial')).toBeInTheDocument()
    expect(within(line('Black Belt')).getByText('5 issued now · 2 go to Still Needed')).toBeInTheDocument()
    // Required lines that go to Still Needed by design get a neutral note, not a red "Only 0 available." error.
    expect(within(line('Buckle')).getByText('Goes to Still Needed · none on hand')).toBeInTheDocument()
    expect(within(workflow).queryByText(/^Only \d+ available\.$/)).toBeNull()
    expect(within(workflow).queryByRole('alert')).toBeNull()

    fireEvent.click(within(workflow).getByRole('button', { name: 'Review Issue' }))
    const group = (title: string) => within(workflow).getByText(title).closest('.review-group') as HTMLElement
    expect(within(group('Ready to issue')).getByText(/Quantity 5 · 2 more to Still Needed/)).toBeInTheDocument()
    expect(within(group('Still needed after issue')).getByText(/Quantity 2 · only 5 on hand/)).toBeInTheDocument()
    fireEvent.click(within(workflow).getByRole('button', { name: /Confirm Issue/ }))
    expect(await within(workflow).findByText('5 items issued · 9 added to Still Needed')).toBeInTheDocument()

    const after = await controller.project()
    expect(after.inventory.find(item => item.entityId === belt)?.onHand).toBe(0)
    expect(after.cadets[0].currentProperty).toEqual([expect.objectContaining({ itemId: belt, quantity: 5 })])
    expect(after.stillNeeded.find(need => need.displayLabel === 'Black Belt')).toMatchObject({ itemId: belt, quantityNeeded: 2, quantityFulfilled: 0 })
  })

  it('still refuses an optional line above stock', async () => {
    const { controller } = await stocked({ 'Black Belt': { one: 1 } })
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    render(<Workflow controller={controller} initial={projection} cadetId={projection.cadets[0].cadetId} />)
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    fireEvent.click(within(workflow).getByRole('button', { name: /Individual Issue/ }))
    fireEvent.change(within(workflow).getByLabelText('Search inventory'), { target: { value: 'black belt' } })
    fireEvent.click(within(workflow).getAllByRole('button').find(button => button.querySelector('b')?.textContent === 'Black Belt')!)
    fireEvent.change(within(workflow).getByLabelText('Black Belt quantity'), { target: { value: '2' } })
    expect(within(workflow).getByRole('alert')).toHaveTextContent('Only 1 available.')
    expect(within(workflow).getByRole('button', { name: 'Review Issue' })).toBeDisabled()
  })
})
