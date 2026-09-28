import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../../auth/authorization'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import { MockIdentityProvider } from '../../identity/identity'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { MemoryRepository } from '../../storage/repository'
import { MockSyncProvider } from '../../sync/mock'
import { InventoryCatalogView, type InventoryCatalogViewProps } from './InventoryCatalogView'

const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId
const PT_SHORTS = catalogId('PT Shorts')
const DAY = 86_400_000

type HarnessProps = Partial<Omit<InventoryCatalogViewProps, 'projection' | 'onProjection'>> & { controller: DistributedAppController; initial: ArgusAppProjection }

/** Holds the projection the way App.tsx does, so onProjection re-renders the view. */
function Harness({ controller, initial, ...props }: HarnessProps) {
  const [projection, setProjection] = useState(initial)
  return <InventoryCatalogView can={() => true} notify={() => undefined} onCount={() => undefined} {...props} projection={projection} controller={controller} onProjection={setProjection} />
}

async function demo() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  return { controller, projection }
}

const catalogList = () => screen.getByRole('list', { name: 'Catalog items' })
const rowNames = () => within(catalogList()).getAllByRole('button').map(row => row.getAttribute('aria-label')?.split(':')[0])
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}:`) })

describe('inventory statuses: Count Due', () => {
  it('flags never-counted sizes, filters by them, and clears them once a count is finalized', async () => {
    const { controller } = await demo()
    await controller.addCatalogSizes(PT_SHORTS, ['S', 'M'])
    await controller.createCountSession({ sessionId: 'count', scope: 'Spring count' })
    let projection = await controller.project()
    const [small, medium] = ['S', 'M'].map(size => projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === size)!.entityId)
    await controller.contributeCount('count', { itemId: small }, 2)
    await controller.contributeCount('count', { itemId: medium }, 4)
    projection = await controller.finalizeCountSession('count')
    const countedAt = Date.parse(projection.countSessions[0].reconciledAt!)
    const view = render(<Harness controller={controller} initial={projection} now={countedAt + DAY} />)

    // The six unsized genesis items have never been counted; PT Shorts was counted yesterday.
    expect(row('Buckle')).toHaveAccessibleDescription('Count due')
    expect(row('PT Shorts')).not.toHaveAccessibleDescription(/Count due/)
    fireEvent.click(screen.getByRole('button', { name: 'Count due (6)' }))
    expect(rowNames()).toEqual(['Black Belt', 'Buckle', 'Necktie', 'Neck Tabs', 'Khaki Belt', 'Brass Buckle'])
    fireEvent.click(screen.getByRole('button', { name: 'Count due (6)' }))
    expect(within(catalogList()).getAllByRole('button')).toHaveLength(25)

    fireEvent.click(row('PT Shorts'))
    const drawer = screen.getByRole('dialog', { name: 'PT Shorts' })
    const sizes = within(drawer).getByRole('list', { name: 'Sizes of PT Shorts' })
    const counted = new Date(countedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    expect(within(sizes).getByRole('listitem', { name: 'M' })).toHaveTextContent(`Counted${counted}`)
    expect(within(within(sizes).getByRole('listitem', { name: 'M' })).queryByText('Count due')).not.toBeInTheDocument()
    view.unmount()

    // 40 days later with a 30-day interval (a per-device preference) both sizes are due again.
    render(<Harness controller={controller} initial={projection} now={countedAt + 40 * DAY} countIntervalDays={30} />)
    expect(row('PT Shorts')).toHaveAccessibleDescription('Count due · 2 sizes')
    fireEvent.click(row('PT Shorts'))
    const later = screen.getByRole('dialog', { name: 'PT Shorts' })
    expect(within(later).getByText(/2 sizes are due for a count — never counted, or not counted in the last 30 days\./)).toBeInTheDocument()
    expect(within(within(later).getByRole('listitem', { name: 'S' })).getByText('Count due')).toBeInTheDocument()
  })
})

describe('inventory statuses: Reconciliation Required', () => {
  it('flags stock that moved during an open count, with a Recount link to the count', async () => {
    const { controller } = await demo()
    let projection = await controller.addCatalogSizes(PT_SHORTS, ['M'])
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await controller.createCountSession({ sessionId: 'count', scope: 'Spring count' })
    await controller.contributeCount('count', { itemId: medium }, 4)
    projection = await controller.receiveStock(medium, 2, 'Delivery during count')
    const onCount = vi.fn()
    render(<Harness controller={controller} initial={projection} onCount={onCount} />)

    expect(row('PT Shorts')).toHaveAccessibleDescription(/Reconciliation required/)
    fireEvent.click(screen.getByRole('button', { name: 'Reconciliation required (1)' }))
    expect(rowNames()).toEqual(['PT Shorts'])
    fireEvent.click(row('PT Shorts'))
    const drawer = screen.getByRole('dialog', { name: 'PT Shorts' })
    const panel = within(drawer).getByRole('list', { name: 'Reconciliation required' })
    expect(panel).toHaveTextContent('Stock moved while “Spring count” is being counted')
    expect(within(within(drawer).getByRole('list', { name: 'Sizes of PT Shorts' })).getByText('Reconcile')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /Open conflicts/ })).not.toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'Recount M' }))
    expect(onCount).toHaveBeenCalledWith(medium)
  })

  it('links a size caught in an open conflict to the conflicts list', async () => {
    const root = new MockIdentityProvider('inventory-root'), authorization = new AuthorizationService(await root.getPublicIdentity(), root), provider = new MockSyncProvider()
    const controllers: DistributedAppController[] = []
    for (const name of ['a', 'b']) {
      const identity = new MockIdentityProvider(`inventory-${name}`)
      await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2026-01-01T00:00:00.000Z' }))
      const controller = new DistributedAppController(new MemoryRepository(), { identity, authorization, provider, organizationId: 'unit-inventory' })
      await controller.initialize(); controllers.push(controller)
    }
    const [a, b] = controllers
    await a.addCatalogSizes(PT_SHORTS, ['M']); await b.sync()
    a.setOnline(false); b.setOnline(false)
    await a.updateCatalogItem(PT_SHORTS, { niin: '8415-01-111-1111' })
    await b.updateCatalogItem(PT_SHORTS, { niin: '8415-01-222-2222' })
    a.setOnline(true); b.setOnline(true)
    await a.sync(); await b.sync()
    const projection = await a.sync()
    expect(projection.conflicts.filter(conflict => conflict.status === 'OPEN')).toHaveLength(1)
    const onOpenConflicts = vi.fn()
    render(<Harness controller={a} initial={projection} onOpenConflicts={onOpenConflicts} />)
    fireEvent.click(row('PT Shorts'))
    const panel = within(screen.getByRole('dialog', { name: 'PT Shorts' })).getByRole('list', { name: 'Reconciliation required' })
    expect(panel).toHaveTextContent('Open conflict: Concurrent catalog item edits require reconciliation.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Open conflicts for M' }))
    expect(onOpenConflicts).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('inventory search', () => {
  it('finds items by size (any punctuation), abbreviation and NIIN', async () => {
    const { controller } = await demo()
    await controller.addCatalogSizes(catalogId('Male SDB Jacket'), ['34R', '36L'])
    await controller.updateCatalogItem(catalogId('Pumps'), { niin: '8430-01-555-1234' })
    await controller.addCatalogSizes(catalogId('Pumps'), ['7.5W'])
    const projection = await controller.addCatalogSizes(PT_SHORTS, ['M'])
    render(<Harness controller={controller} initial={projection} />)
    const search = screen.getByLabelText('Search catalog')
    for (const [query, expected] of [
      ['34 R', ['Male SDB Jacket']],
      ['34-r', ['Male SDB Jacket']],
      ['m', ['PT Shorts']],
      ['7.5 w', ['Pumps']],
      ['blk ox', ['Black Oxfords']],
      ['sdb jkt', ['Male SDB Jacket', 'Female SDB Jacket']],
      ['sdb jkt 34r', ['Male SDB Jacket']],
      ['555 1234', ['Pumps']],
      ['pt shorts m', ['PT Shorts']],
    ] as const) {
      fireEvent.change(search, { target: { value: query } })
      expect(rowNames(), query).toEqual(expected)
    }
  })
})

describe('likely duplicates', () => {
  it('warns on add without blocking, and can open the existing item instead', async () => {
    const { controller, projection } = await demo()
    render(<Harness controller={controller} initial={projection} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    const drawer = screen.getByRole('dialog', { name: 'Add item' })
    fireEvent.change(within(drawer).getByLabelText('Item name'), { target: { value: 'Blk Oxford' } })
    const duplicates = within(drawer).getByRole('list', { name: 'Likely duplicates' })
    expect(duplicates).toHaveTextContent('“Black Oxfords” · Footwear — same name')
    fireEvent.click(within(duplicates).getByRole('button', { name: 'Open Black Oxfords' }))
    expect(await screen.findByRole('dialog', { name: 'Black Oxfords' })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Close panel'))

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    const again = screen.getByRole('dialog', { name: 'Add item' })
    fireEvent.change(within(again).getByLabelText('Item name'), { target: { value: 'Physical Training Short' } })
    fireEvent.change(within(again).getByLabelText('Category'), { target: { value: 'PT' } })
    expect(within(again).getByRole('list', { name: 'Likely duplicates' })).toHaveTextContent('“PT Shorts” · PT — same name')
    fireEvent.click(within(again).getByRole('button', { name: 'Add item' }))
    expect(await screen.findByRole('dialog', { name: 'Physical Training Short' })).toBeInTheDocument()
    expect((await controller.project()).catalog).toHaveLength(26)
  })

  it('warns when a rename makes an item look like another one, and still saves', async () => {
    const { controller, projection } = await demo()
    render(<Harness controller={controller} initial={projection} />)
    fireEvent.click(row('Necktie'))
    const drawer = screen.getByRole('dialog', { name: 'Necktie' })
    const details = within(drawer).getByRole('form', { name: 'Item details' })
    expect(within(details).queryByRole('list', { name: 'Likely duplicates' })).not.toBeInTheDocument()
    fireEvent.change(within(details).getByLabelText('Name'), { target: { value: 'neck-tab' } })
    expect(within(details).getByRole('list', { name: 'Likely duplicates' })).toHaveTextContent('“Neck Tabs” · Accessories — same name')
    fireEvent.click(within(details).getByRole('button', { name: 'Save details' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'neck-tab' })).toBeInTheDocument())
  })
})
