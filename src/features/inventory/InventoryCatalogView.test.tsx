import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ROLE_PERMISSIONS } from '../../auth/authorization'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { InventoryCatalogView } from './InventoryCatalogView'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const officer = () => true
const assistant = (permission: ArgusPermission) => ROLE_PERMISSIONS.SUPPLY_ASSISTANT.includes(permission)

type HarnessProps = {
  controller: DistributedAppController
  initial: ArgusAppProjection
  can?: (permission: ArgusPermission) => boolean
  notify?: (message: string) => void
  onCount?: (itemId: string) => void
}

/** Holds the projection the way App.tsx does, so onProjection re-renders the view. */
function Harness({ controller, initial, can = officer, notify = () => undefined, onCount = () => undefined }: HarnessProps) {
  const [projection, setProjection] = useState(initial)
  return <InventoryCatalogView projection={projection} controller={controller} can={can} onProjection={setProjection} notify={notify} onCount={onCount} />
}

async function demo() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  return { controller, projection }
}

const summaryCard = (label: string) => screen.getByText(label.toUpperCase(), { selector: '.summary-card small' }).parentElement!
const catalogList = () => screen.getByRole('list', { name: 'Catalog items' })

describe('InventoryCatalogView', () => {
  it('starts from the 25 spec items at zero on hand, with sized items flagged as needing sizes', async () => {
    const { controller, projection } = await demo()
    render(<Harness controller={controller} initial={projection} />)
    const rows = within(catalogList()).getAllByRole('button')
    expect(rows).toHaveLength(25)
    for (const row of rows) expect(row).toHaveAccessibleName(/: 0 on hand,/)
    expect(summaryCard('On hand')).toHaveTextContent('0')
    expect(summaryCard('On hand')).toHaveTextContent('Nothing on hand yet — record a count or receive stock')
    expect(summaryCard('Items without sizes')).toHaveTextContent('19')
    expect(screen.getByRole('button', { name: /^PT Shorts:/ })).toHaveTextContent('Sizes not set')
    expect(screen.getByRole('button', { name: /^Buckle:/ })).toHaveTextContent('One size')

    fireEvent.click(screen.getByRole('button', { name: 'PT', pressed: false }))
    expect(within(catalogList()).getAllByRole('button').map(row => row.getAttribute('aria-label')?.split(':')[0])).toEqual(['Gold PT Shirt', 'PT Shorts'])
    fireEvent.change(screen.getByLabelText('Search catalog'), { target: { value: 'nothing-like-this' } })
    expect(screen.getByText('No items match')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(within(catalogList()).getAllByRole('button')).toHaveLength(25)
  })

  it('adds sizes from the Letter sizes preset, receives stock, renames a size and jumps to counting', async () => {
    const { controller, projection } = await demo()
    const onCount = vi.fn()
    render(<Harness controller={controller} initial={projection} onCount={onCount} />)
    fireEvent.click(screen.getByRole('button', { name: /^PT Shorts:/ }))
    const drawer = screen.getByRole('dialog', { name: 'PT Shorts' })
    expect(within(drawer).getByText('No sizes yet')).toBeInTheDocument()

    const chart = within(drawer).getByLabelText('Size chart')
    fireEvent.change(chart, { target: { value: 'unisex-alpha' } })
    expect(within(drawer).getByRole('option', { name: 'Letter sizes (XS–3XL)' })).toHaveProperty('selected', true)
    expect(within(drawer).getByText(/Supply Manual Table 2-8/)).toBeInTheDocument()
    const chips = within(drawer).getByRole('group', { name: 'Sizes in Letter sizes (XS–3XL)' })
    for (const size of ['S', 'M', 'L']) fireEvent.click(within(chips).getByRole('button', { name: size }))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add 3 sizes' }))

    const sizes = await within(drawer).findByRole('list', { name: 'Sizes of PT Shorts' })
    expect(within(sizes).getAllByRole('listitem')).toHaveLength(3)
    for (const size of ['S', 'M', 'L']) expect(within(sizes).getByRole('listitem', { name: size })).toHaveTextContent('On hand0')
    expect(within(chips).getByRole('button', { name: 'M (already added)' })).toBeDisabled()

    // Receive 5 of M: additive new stock for one size.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Receive stock for M' }))
    const receive = within(drawer).getByRole('form', { name: 'Receive stock for M' })
    fireEvent.change(within(receive).getByLabelText('Quantity received'), { target: { value: '0' } })
    fireEvent.click(within(receive).getByRole('button', { name: 'Add to stock' }))
    expect(within(receive).getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 10000.')
    fireEvent.change(within(receive).getByLabelText('Quantity received'), { target: { value: '5' } })
    fireEvent.click(within(receive).getByRole('button', { name: 'Add to stock' }))
    const medium = within(sizes).getByRole('listitem', { name: 'M' })
    await waitFor(() => expect(within(medium).getAllByRole('definition')[0]).toHaveTextContent('5'))
    expect(within(drawer).getByText('5 on hand · 0 issued')).toBeInTheDocument()

    // Rename S and give it a low-stock threshold.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit size S' }))
    const edit = within(drawer).getByRole('form', { name: 'Edit size S' })
    fireEvent.change(within(edit).getByLabelText('Size label'), { target: { value: 'm' } })
    fireEvent.click(within(edit).getByRole('button', { name: 'Save size' }))
    expect(within(edit).getByRole('alert')).toHaveTextContent('Size m already exists.')
    fireEvent.change(within(edit).getByLabelText('Size label'), { target: { value: 'Small' } })
    fireEvent.change(within(edit).getByLabelText('Low-stock threshold'), { target: { value: '2' } })
    fireEvent.click(within(edit).getByRole('button', { name: 'Save size' }))
    const small = await within(drawer).findByRole('listitem', { name: 'Small' })
    expect(within(small).getByText('Out')).toBeInTheDocument()

    // "Count" hands the exact size to the Count tab.
    fireEvent.click(within(medium).getByRole('button', { name: 'Count M' }))
    const mediumId = (await controller.project()).inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!.entityId
    expect(onCount).toHaveBeenCalledWith(mediumId)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Only S ran out (M still has 5), so the item says how many sizes are out rather than "Out of stock".
    expect(screen.getByRole('button', { name: /^PT Shorts:/ })).toHaveAccessibleName('PT Shorts: 5 on hand, 3 sizes, 1 size out')
    expect(summaryCard('On hand')).toHaveTextContent('5')
    expect(summaryCard('Low / out of stock')).toHaveTextContent('1')
    expect(summaryCard('Items without sizes')).toHaveTextContent('18')
  })

  it('deactivates and reactivates a single size', async () => {
    const { controller } = await demo()
    const projection = await controller.addCatalogSizes(PT_SHORTS, ['S', 'M'])
    render(<Harness controller={controller} initial={projection} />)
    fireEvent.click(screen.getByRole('button', { name: /^PT Shorts:/ }))
    const drawer = screen.getByRole('dialog', { name: 'PT Shorts' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Deactivate size S' }))
    const reactivate = await within(drawer).findByRole('button', { name: 'Reactivate size S' })
    expect(within(within(drawer).getByRole('listitem', { name: 'S' })).getByText('Inactive')).toBeInTheDocument()
    expect(within(within(drawer).getByRole('listitem', { name: 'S' })).queryByRole('button', { name: 'Count S' })).not.toBeInTheDocument()
    fireEvent.click(reactivate)
    expect(await within(drawer).findByRole('button', { name: 'Deactivate size S' })).toBeInTheDocument()
  })

  it('keeps the add-item drawer open with inline errors, then adds an unsized item with a single "One size"', async () => {
    const { controller, projection } = await demo()
    const notify = vi.fn()
    render(<Harness controller={controller} initial={projection} notify={notify} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    const drawer = screen.getByRole('dialog', { name: 'Add item' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add item' }))
    expect(within(drawer).getByText('Enter an item name.')).toBeInTheDocument()
    expect(within(drawer).getByLabelText('Item name')).toHaveAttribute('aria-invalid', 'true')
    expect(within(drawer).getByRole('alert')).toHaveTextContent('Fix the highlighted fields')
    expect(screen.getByRole('dialog', { name: 'Add item' })).toBeInTheDocument()
    expect((await controller.technicalState()).events).toHaveLength(0)

    fireEvent.change(within(drawer).getByLabelText('Item name'), { target: { value: 'Rifle Sling' } })
    fireEvent.change(within(drawer).getByLabelText('Category'), { target: { value: 'Drill' } })
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /Comes in sizes/ }))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add item' }))

    // The new item's editor opens straight away.
    const editor = await screen.findByRole('dialog', { name: 'Rifle Sling' })
    expect(screen.queryByRole('dialog', { name: 'Add item' })).not.toBeInTheDocument()
    const stock = within(editor).getByRole('list', { name: 'Stock of Rifle Sling' })
    expect(within(stock).getByRole('listitem', { name: 'One size' })).toBeInTheDocument()
    expect(within(editor).queryByRole('heading', { name: 'Add sizes' })).not.toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith('Rifle Sling added with one size, at 0 on hand.')
    fireEvent.click(within(editor).getByLabelText('Close panel'))
    expect(within(catalogList()).getAllByRole('button')).toHaveLength(26)
    expect(screen.getByRole('button', { name: /^Rifle Sling:/ })).toHaveAccessibleName('Rifle Sling: 0 on hand, one size, Nothing on hand')
  })

  it('edits item details and moves deactivated items into the Inactive section', async () => {
    const { controller, projection } = await demo()
    render(<Harness controller={controller} initial={projection} />)
    fireEvent.click(screen.getByRole('button', { name: /^Necktie:/ }))
    const drawer = screen.getByRole('dialog', { name: 'Necktie' })
    const details = within(drawer).getByRole('form', { name: 'Item details' })
    expect(within(details).getByRole('button', { name: 'Save details' })).toBeDisabled()
    fireEvent.change(within(details).getByLabelText('Name'), { target: { value: '' } })
    fireEvent.click(within(details).getByRole('button', { name: 'Save details' }))
    expect(within(details).getByText('Enter an item name of up to 80 characters.')).toBeInTheDocument()
    fireEvent.change(within(details).getByLabelText('Name'), { target: { value: 'Black Necktie' } })
    fireEvent.change(within(details).getByLabelText('NIIN / reference'), { target: { value: '8440-01-000-0001' } })
    fireEvent.click(within(details).getByRole('checkbox', { name: /Active/ }))
    fireEvent.click(within(details).getByRole('button', { name: 'Save details' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Black Necktie' })).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Close panel'))
    expect(within(catalogList()).getAllByRole('button')).toHaveLength(24)
    const inactive = screen.getByRole('list', { name: 'Inactive catalog items' })
    expect(within(inactive).getByRole('button', { name: /^Black Necktie:/ })).toHaveTextContent('8440-01-000-0001')
    expect(within(inactive).getByRole('button', { name: /^Black Necktie:/ })).toHaveTextContent('Inactive')
  })

  it('is read-only for a role without inventory.create / inventory.adjust', async () => {
    const { controller } = await demo()
    const projection = await controller.addCatalogSizes(PT_SHORTS, ['M'])
    render(<Harness controller={controller} initial={projection} can={assistant} />)
    expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^PT Shorts:/ }))
    const drawer = screen.getByRole('dialog', { name: 'PT Shorts' })
    expect(within(drawer).getByRole('button', { name: 'Count M' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /Receive stock/ })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /Edit size/ })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('heading', { name: 'Add sizes' })).not.toBeInTheDocument()
    expect(within(drawer).getByLabelText('Name')).toBeDisabled()
    expect(within(drawer).queryByRole('button', { name: 'Save details' })).not.toBeInTheDocument()
  })
})
