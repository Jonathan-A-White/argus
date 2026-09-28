import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission, BundleVersionProjection } from '../../distributed/types'
import { BundleEditorPanel } from './BundleEditorPanel'
import { definitionError, newBundleId, slugify, versionChanges } from './bundleModel'

async function setup() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  const catalogId = (name: string) => projection.catalog.find(item => item.name === name)!.catalogId
  return { controller, projection, catalogId }
}

function Harness({ controller, initial, toasts, can = () => true }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; can?: (permission: ArgusPermission) => boolean }) {
  const [projection, setProjection] = useState(initial)
  const memberName = (identity: string) => (identity === projection.actor ? 'You' : 'Unit member')
  return <BundleEditorPanel projection={projection} controller={controller} can={can} memberName={memberName} onProjection={setProjection} notify={message => toasts.push(message)} close={() => undefined} />
}

const card = (name: string) => screen.getByRole('article', { name })
const history = (name: string) =>
  within(screen.getByRole('list', { name: `${name} version history` }))
    .getAllByRole('listitem')
    .map(item => item.textContent)

describe('BundleEditorPanel', () => {
  it('edits the PT bundle into version 2 (adds Tracksuit Top, makes Khaki Ball Cap optional) while keeping v1', async () => {
    const { controller, projection, catalogId } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    expect(screen.getByRole('dialog', { name: 'Issue bundles' })).toBeInTheDocument()
    const pt = card('PT')
    expect(pt).toHaveTextContent('Any cadet · PT · v1')
    expect(pt).toHaveTextContent('0/3 lines ready')

    fireEvent.click(within(pt).getByRole('button', { name: 'Edit PT' }))
    const form = screen.getByRole('form', { name: 'Edit PT' })
    expect(within(form).getByRole('button', { name: 'Save as v2' })).toBeDisabled()
    expect(within(form).getByLabelText('Line 1 item')).toHaveValue(catalogId('Gold PT Shirt'))
    // Items already in the bundle are not offered again.
    const addable = within(within(form).getByLabelText('Add item')).getAllByRole('option').map(option => option.textContent)
    expect(addable).toContain('Tracksuit Top')
    expect(addable).not.toContain('PT Shorts')

    fireEvent.change(within(form).getByLabelText('Add item'), { target: { value: catalogId('Tracksuit Top') } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }))
    expect(within(form).getByLabelText('Line 4 item')).toHaveValue(catalogId('Tracksuit Top'))
    const cap = within(form).getByLabelText('Khaki Ball Cap required')
    expect(cap).toBeChecked()
    fireEvent.click(cap)
    expect(cap).not.toBeChecked()
    fireEvent.click(within(form).getByRole('button', { name: 'Save as v2' }))

    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    expect(toasts).toEqual(['PT saved as version 2.'])
    const saved = (await controller.project()).bundles.find(bundle => bundle.bundleId === 'bundle-pt')!
    expect(saved.currentVersion).toBe(2)
    expect(saved.versions.map(version => version.version)).toEqual([1, 2])
    const v2 = saved.versions[1]
    expect(v2.lines.map(line => [line.displayLabel, line.required, line.order])).toEqual([
      ['Gold PT Shirt', true, 0],
      ['PT Shorts', true, 1],
      ['Khaki Ball Cap', false, 2],
      ['Tracksuit Top', true, 3],
    ])
    const added = v2.lines[3]
    expect(added).toMatchObject({ catalogId: catalogId('Tracksuit Top'), supportsSizing: true, defaultQuantity: 1 })
    expect(added.itemId).toBeUndefined()
    expect(added.lineId).toMatch(/^bundle-pt:[0-9a-f-]{36}$/)
    expect(new Set(v2.lines.map(line => line.lineId)).size).toBe(4)
    // Version 1 is untouched.
    expect(saved.versions[0].lines.find(line => line.displayLabel === 'Khaki Ball Cap')?.required).toBe(true)
    expect(saved.versions[0].lines).toHaveLength(3)

    // The saved bundle is expanded: v2 is current, v1 (the default preset) is still listed.
    const after = card('PT')
    expect(after).toHaveTextContent('v2')
    expect(history('PT')).toEqual([
      expect.stringMatching(/^v2 · Current.* · You · 4 lines.*Khaki Ball Cap optional/),
      'v1Default preset · 3 lines',
    ])
    expect(history('PT')[0]).toContain('Added Tracksuit Top')
    expect(within(after).getByText('Tracksuit Top')).toBeInTheDocument()
  })

  it('reorders, removes and changes lines, and shows validation errors without closing', async () => {
    const { controller, projection, catalogId } = await setup()
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Drill' }))
    const form = screen.getByRole('form', { name: 'Edit Drill' })

    fireEvent.click(within(form).getByRole('button', { name: 'Move Tracksuit Bottom up' }))
    expect(within(form).getByLabelText('Line 1 item')).toHaveValue(catalogId('Tracksuit Bottom'))
    expect(within(form).getByRole('button', { name: 'Move Tracksuit Bottom up' })).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Tracksuit Bottom default quantity'), { target: { value: '2' } })
    fireEvent.change(within(form).getByLabelText('Line 2 item'), { target: { value: catalogId('Tracksuit Bottom') } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save as v2' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('Tracksuit Bottom is listed twice.')

    fireEvent.change(within(form).getByLabelText('Line 2 item'), { target: { value: catalogId('Platoon Shirt') } })
    fireEvent.click(within(form).getAllByRole('button', { name: 'Remove Tracksuit Bottom' })[0])
    fireEvent.click(within(form).getByRole('button', { name: 'Remove Platoon Shirt' }))
    expect(within(form).getByText('No lines yet. Add at least one item.')).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Save as v2' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('A bundle must contain at least one line.')

    // A refusal from the controller also keeps the drawer open.
    fireEvent.change(within(form).getByLabelText('Add item'), { target: { value: catalogId('Tracksuit Top') } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }))
    fireEvent.click(within(form).getByLabelText('Active'))
    const refused = vi.spyOn(controller, 'updateBundleDefinition').mockRejectedValueOnce(new Error('Missing permission: bundles.manage'))
    fireEvent.click(within(form).getByRole('button', { name: 'Save as v2' }))
    expect(await within(form).findByText('Missing permission: bundles.manage')).toBeInTheDocument()
    refused.mockRestore()
    fireEvent.click(within(form).getByRole('button', { name: 'Save as v2' }))
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    const drill = (await controller.project()).bundles.find(bundle => bundle.bundleId === 'bundle-drill')!
    expect(drill.versions[1]).toMatchObject({ active: false, lines: [expect.objectContaining({ displayLabel: 'Tracksuit Top', order: 0 })] })
    expect(card('Drill')).toHaveTextContent('Inactive')
  })

  it('creates a new bundle with a generated ID', async () => {
    const { controller, projection, catalogId } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    fireEvent.click(screen.getByRole('button', { name: 'New bundle' }))
    const form = screen.getByRole('form', { name: 'New bundle' })
    fireEvent.click(within(form).getByRole('button', { name: 'Create bundle' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('Bundle name is required.')

    fireEvent.change(within(form).getByLabelText('Bundle name'), { target: { value: 'Color Guard' } })
    fireEvent.change(within(form).getByLabelText('Applies to'), { target: { value: 'Female' } })
    fireEvent.change(within(form).getByLabelText('Purpose'), { target: { value: 'Ceremony' } })
    fireEvent.change(within(form).getByLabelText('Add item'), { target: { value: catalogId('White Dress Shirt') } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }))
    fireEvent.change(within(form).getByLabelText('Add item'), { target: { value: catalogId('Neck Tabs') } })
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Create bundle' }))

    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    expect(toasts).toEqual(['Bundle Color Guard created.'])
    const created = (await controller.project()).bundles.find(bundle => bundle.versions[0].displayName === 'Color Guard')!
    expect(created.bundleId).toMatch(/^bundle-color-guard-[0-9a-f]{6}$/)
    expect(created.versions[0]).toMatchObject({ genderApplicability: 'Female', purpose: 'Ceremony', active: true, version: 1 })
    expect(created.versions[0].lines.map(line => [line.displayLabel, line.supportsSizing, line.lineId.startsWith(`${created.bundleId}:`)])).toEqual([
      ['White Dress Shirt', true, true],
      ['Neck Tabs', false, true],
    ])
    expect(card('Color Guard')).toHaveTextContent('Female cadets · Ceremony · v1')
  })

  it('refuses to save over a version another device saved while the form was open', async () => {
    const { controller, projection } = await setup()
    const props = { controller, can: () => true, memberName: () => 'Unit member', onProjection: () => undefined, notify: () => undefined, close: () => undefined }
    const view = render(<BundleEditorPanel projection={projection} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit BLT' }))
    fireEvent.click(within(screen.getByRole('form', { name: 'Edit BLT' })).getByLabelText('Platoon Shirt required'))

    // Another device's edit reaches this device's replica (the React projection has not caught up yet).
    const v1 = projection.bundles.find(bundle => bundle.bundleId === 'bundle-blt')!.versions[0]
    const newer = await controller.updateBundleDefinition('bundle-blt', { displayName: 'BLT', genderApplicability: 'Any', purpose: 'BLT', active: true, lines: v1.lines.slice(0, 4) })
    fireEvent.click(screen.getByRole('button', { name: 'Save as v2' }))
    const stale = 'Another device saved version 2 of this bundle while you were editing. Cancel and reopen it to edit the latest version.'
    expect(await screen.findByRole('alert')).toHaveTextContent(stale)

    // Once auto-sync delivers the projection, the form knows immediately.
    view.rerender(<BundleEditorPanel projection={newer} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save as v2' }))
    expect(screen.getByRole('alert')).toHaveTextContent(stale)
    const blt = (await controller.project()).bundles.find(bundle => bundle.bundleId === 'bundle-blt')!
    expect(blt.currentVersion).toBe(2)
    expect(blt.versions[1].lines).toHaveLength(4)
  })

  it('is read-only without bundles.manage', async () => {
    const { controller, projection } = await setup()
    render(<Harness controller={controller} initial={projection} toasts={[]} can={permission => permission !== 'bundles.manage'} />)
    expect(screen.getByText(/Read only\. A Supply Officer or the Master edits bundles\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New bundle' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull()
    fireEvent.click(within(card('Male SDB')).getByRole('button', { expanded: false }))
    expect(within(card('Male SDB')).getByText('White Dress Shirt')).toBeInTheDocument()
    expect(within(card('Male SDB')).getByText('Optional · ×1 · Sized')).toBeInTheDocument()
    expect(history('Male SDB')).toEqual(['v1 · CurrentDefault preset · 3 lines'])
  })
})

describe('bundle model', () => {
  it('builds IDs, validates definitions and summarises version changes', () => {
    expect(slugify('  Color Guard / Drill Team! ')).toBe('color-guard-drill-team')
    expect(slugify('!!!')).toBe('custom')
    expect(newBundleId('Color Guard', 'ABCDEF12-3456')).toBe('bundle-color-guard-abcdef')
    const line = { lineId: 'a', catalogId: 'catalog:x', displayLabel: 'X', required: true, supportsSizing: true, defaultQuantity: 1, order: 0 }
    expect(definitionError({ displayName: 'X', genderApplicability: 'Any', purpose: '', active: true, lines: [{ ...line, defaultQuantity: 11 }] })).toBe('X: default quantity must be 1 to 10.')
    const v1: BundleVersionProjection = { bundleId: 'b', displayName: 'Old', genderApplicability: 'Any', purpose: 'PT', lines: [line, { ...line, lineId: 'b', catalogId: 'catalog:y', displayLabel: 'Y', order: 1 }], active: true, version: 1, createdAt: '', actorPublicIdentity: 'factory:x', eventId: 'e1' }
    const v2: BundleVersionProjection = { ...v1, displayName: 'New', active: false, version: 2, lines: [{ ...line, required: false, defaultQuantity: 2 }, { ...line, lineId: 'c', catalogId: 'catalog:z', displayLabel: 'Z', order: 1 }] }
    expect(versionChanges(undefined, v1)).toEqual([])
    expect(versionChanges(v1, v2)).toEqual(['Renamed from Old', 'Deactivated', 'X optional', 'X ×2', 'Added Z', 'Removed Y'])
  })
})
