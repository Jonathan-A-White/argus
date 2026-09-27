import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { RolloverPanel } from './RolloverPanel'
import { defaultSchoolYear, rolloverPreview, schoolYearError } from './rolloverModel'

const NAME = 'Casey Bennett'

/** Two NS1, one NS3, and two NS4 cadets (one still holding a PT Shorts) plus one inactive NS2. */
async function roster() {
  const controller = new DistributedAppController()
  await controller.initialize()
  let projection = await controller.importCadets([
    { gender: 'Male', nsLevel: 'NS1' },
    { gender: 'Female', nsLevel: 'NS1' },
    { gender: 'Male', nsLevel: 'NS3' },
    { gender: 'Female', nsLevel: 'NS4', cadetCode: 'C-GRAD', fullName: NAME },
    { gender: 'Male', nsLevel: 'NS4', cadetCode: 'C-D0NE' },
  ])
  await controller.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'INACTIVE', cadetCode: 'C-0FF1' })
  const shorts = projection.catalog.find(item => item.name === 'PT Shorts')!
  projection = await controller.addCatalogSizes(shorts.catalogId, ['M'])
  const medium = projection.inventory.find(item => item.catalogId === shorts.catalogId)!.entityId
  await controller.receiveStock(medium, 2)
  const graduate = (await controller.project()).cadets.find(cadet => cadet.cadetCode === 'C-GRAD')!
  projection = await controller.issueTransaction({ transactionId: 'tx-shorts', cadetId: graduate.cadetId, lines: [{ lineId: 'shorts', itemId: medium, quantity: 1 }] })
  return { controller, projection }
}

function Harness({ controller, initial, toasts, can = () => true }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; can?: (permission: ArgusPermission) => boolean }) {
  const [projection, setProjection] = useState(initial)
  return <RolloverPanel projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} close={() => undefined} />
}

const previewRows = () =>
  within(screen.getByRole('list', { name: 'Rollover preview' }))
    .getAllByRole('listitem')
    .map(item => `${item.firstElementChild!.textContent!.replace(/\s+/g, ' ').trim()} = ${item.querySelector('b')!.textContent}`)

describe('RolloverPanel', () => {
  it('previews the level changes, warns about graduates holding property, and needs the year typed to confirm', async () => {
    const { controller, projection } = await roster()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    expect(screen.getByRole('dialog', { name: 'Annual rollover' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('School year'), { target: { value: '2026-2027' } })

    expect(previewRows()).toEqual(['NS1 to NS2 = 2 cadets', 'NS2 to NS3 = 0 cadets', 'NS3 to NS4 = 1 cadet', 'NS4 to Graduated (inactive) = 2 cadets'])
    expect(screen.getByText('5 active cadets')).toBeInTheDocument()
    const warning = screen.getByRole('alert')
    expect(warning).toHaveTextContent('1 graduating cadet still holds issued items; collect returns.')
    expect(warning).toHaveTextContent('C-GRAD (1 item)')
    expect(warning).not.toHaveTextContent('C-D0NE')
    expect(document.body.innerHTML).not.toContain(NAME)
    expect(screen.getByText('No rollovers yet.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Review and confirm rollover' }))
    const form = screen.getByRole('form', { name: 'Confirm rollover' })
    const complete = within(form).getByRole('button', { name: 'Complete 2026-2027 rollover' })
    expect(complete).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Type the school year to confirm'), { target: { value: '2026-2028' } })
    expect(complete).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Type the school year to confirm'), { target: { value: '2026-2027' } })
    expect(complete).toBeEnabled()
    fireEvent.click(complete)

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Rollover 2026-2027 complete')
    expect(status).toHaveTextContent('3 cadets advanced · 2 cadets graduated')
    expect(toasts).toEqual(['Rollover 2026-2027 complete: 3 advanced, 2 graduated.'])
    expect(screen.queryByRole('form', { name: 'Confirm rollover' })).toBeNull()

    const after = await controller.project()
    const level = (code: string) => after.cadets.find(cadet => cadet.cadetCode === code)
    expect(level('C-GRAD')).toMatchObject({ status: 'INACTIVE', nsLevel: 'NS4', currentProperty: [expect.objectContaining({ quantity: 1 })] })
    expect(level('C-0FF1')).toMatchObject({ status: 'INACTIVE', nsLevel: 'NS2' })
    expect(after.cadets.filter(cadet => cadet.status === 'ACTIVE').map(cadet => cadet.nsLevel).sort()).toEqual(['NS2', 'NS2', 'NS4'])
    expect(after.rollovers).toMatchObject([{ schoolYear: '2026-2027', advanced: 3, graduated: 2 }])

    // The same year is now refused, and the record is listed under past rollovers.
    expect(screen.getByText('Rollover for 2026-2027 is already complete.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review and confirm rollover' })).toBeDisabled()
    expect(screen.getByText('2026-2027')).toBeInTheDocument()
    expect(screen.getByText(/^Completed .* by You · 3 advanced · 2 graduated$/)).toBeInTheDocument()
    expect(previewRows()).toEqual(['NS1 to NS2 = 0 cadets', 'NS2 to NS3 = 2 cadets', 'NS3 to NS4 = 0 cadets', 'NS4 to Graduated (inactive) = 1 cadet'])
  })

  it('shows the controller’s "already complete" error when another device got there first', async () => {
    const { controller, projection } = await roster()
    await controller.completeAnnualRollover('2026-2027')
    // This panel still holds the projection from before the rollover (e.g. before auto-sync caught up).
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    fireEvent.change(screen.getByLabelText('School year'), { target: { value: '2026-2027' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review and confirm rollover' }))
    const form = screen.getByRole('form', { name: 'Confirm rollover' })
    fireEvent.change(within(form).getByLabelText('Type the school year to confirm'), { target: { value: '2026-2027' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Complete 2026-2027 rollover' }))
    await waitFor(() => expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toContain('Rollover for 2026-2027 is already complete.'))
    expect(screen.getByRole('form', { name: 'Confirm rollover' })).toBeInTheDocument()
    expect((await controller.project()).rollovers).toHaveLength(1)
  })

  it('validates the school year and lets people without cadets.manage only look', async () => {
    const { controller, projection } = await roster()
    render(<Harness controller={controller} initial={projection} toasts={[]} can={permission => permission !== 'cadets.manage'} />)
    fireEvent.change(screen.getByLabelText('School year'), { target: { value: '2026-2028' } })
    expect(screen.getByText('The second year must follow the first, e.g. 2026-2027.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('School year'), { target: { value: '26-27' } })
    expect(screen.getByText('School year looks like 2026-2027.')).toBeInTheDocument()
    expect(screen.getByText(/A Supply Officer or the Master completes the annual rollover/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /rollover/i })).toBeNull()
    expect(previewRows()[0]).toBe('NS1 to NS2 = 2 cadets')
  })
})

describe('rollover model', () => {
  it('suggests the next school year that has not been rolled over', () => {
    expect(defaultSchoolYear(new Date('2026-09-27T12:00:00'), [])).toBe('2026-2027')
    expect(defaultSchoolYear(new Date('2026-05-30T12:00:00'), [{ schoolYear: '2026-2027' }])).toBe('2027-2028')
    expect(schoolYearError('2026-2027', [])).toBe('')
    expect(schoolYearError('2026-2027', [{ schoolYear: '2026-2027' }])).toBe('Rollover for 2026-2027 is already complete.')
    expect(rolloverPreview([])).toMatchObject({ active: 0, advancing: 0, graduating: 0, graduatingWithProperty: [] })
  })
})
