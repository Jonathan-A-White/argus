import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { CADET_CODE_PATTERN } from '../../stage3/domain'
import { RosterImportPanel } from './RosterImportPanel'
import { chunk, parseCount, parseLevel, parseRoster, splitRosterLine, withoutLines } from './rosterModel'

const NAME = 'Jordan Rivera'

async function setup() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  return { controller, projection }
}

function Harness({ controller, initial, toasts, can = () => true, onClose = () => undefined }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; can?: (permission: ArgusPermission) => boolean; onClose?: () => void }) {
  const [projection, setProjection] = useState(initial)
  return <RosterImportPanel projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} close={onClose} />
}

const paste = (value: string) => fireEvent.change(screen.getByLabelText('Roster lines'), { target: { value } })
const preview = () => screen.getByRole('table', { name: 'Import preview' })

describe('RosterImportPanel', () => {
  it('previews pasted rows without ever showing a name, then imports them', async () => {
    const { controller, projection } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    expect(screen.getByRole('dialog', { name: 'Import cadets' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 0 cadets' })).toBeDisabled()

    paste(`gender,nsLevel,cadetCode,name\nM,1\nf,NS2,c-7k4m\nFemale,4,,${NAME}`)
    const table = preview()
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map(row => [...row.querySelectorAll('th,td')].map(cell => cell.textContent))).toEqual([
      ['2', 'Male', 'NS1', 'auto', '—'],
      ['3', 'Female', 'NS2', 'C-7K4M', '—'],
      ['4', 'Female', 'NS4', 'auto', 'name provided'],
    ])
    expect(table.textContent).not.toMatch(/Jordan|Rivera/)
    expect(screen.getByText('3 cadets ready')).toBeInTheDocument()
    expect(screen.getByText(/header row skipped/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import 3 cadets' }))
    await screen.findByRole('status')
    expect(toasts).toEqual(['Imported 3 cadets.'])
    expect(screen.getByRole('status')).toHaveTextContent('Imported 3 cadets.')
    // The pasted text is cleared, so the name no longer exists anywhere on screen.
    expect(screen.getByLabelText('Roster lines')).toHaveValue('')
    expect(document.body.innerHTML).not.toMatch(/Jordan|Rivera/)
    expect(toasts.join(' ')).not.toMatch(/Jordan|Rivera/)

    const cadets = (await controller.project()).cadets
    expect(cadets).toHaveLength(3)
    expect(cadets.every(cadet => CADET_CODE_PATTERN.test(cadet.cadetCode ?? ''))).toBe(true)
    expect(cadets.find(cadet => cadet.cadetCode === 'C-7K4M')).toMatchObject({ gender: 'Female', nsLevel: 'NS2', fullName: '', status: 'ACTIVE' })
    expect(cadets.find(cadet => cadet.nsLevel === 'NS4')).toMatchObject({ gender: 'Female', fullName: NAME })
    // The new cadet IDs are listed (codes only) for labelling at NCO.
    for (const cadet of cadets) expect(screen.getByRole('status')).toHaveTextContent(cadet.cadetCode!)
  })

  it('blocks the import while any row is invalid and explains each problem by line number', async () => {
    const { controller } = await setup()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-AAAA' })
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    paste(`M,NS1\nX,NS5,,${NAME}\nF,2,C-AAAA\nM,3,C-12\nF,1,C-BBBB\nM,1,C-BBBB`)

    expect(screen.getByText('2 cadets ready')).toBeInTheDocument()
    expect(screen.getByText(/4 with problems/)).toBeInTheDocument()
    const table = preview()
    expect(within(table).getByText('Line 2: Gender must be M, F, Male or Female. NS level must be NS1–NS4 or 1–4.')).toBeInTheDocument()
    expect(within(table).getByText('Line 3: Cadet ID C-AAAA is already in use.')).toBeInTheDocument()
    expect(within(table).getByText(/^Line 4: Cadet IDs look like C-4F7K/)).toBeInTheDocument()
    expect(within(table).getByText('invalid ID')).toBeInTheDocument()
    expect(within(table).getByText('Line 6: Cadet ID C-BBBB is also on line 5.')).toBeInTheDocument()
    expect(table.textContent).not.toMatch(/Jordan|Rivera/)
    expect(screen.getByRole('button', { name: 'Import 2 cadets' })).toBeDisabled()
    expect(screen.getByText('Fix or remove the lines marked above to import.')).toBeInTheDocument()

    const spy = vi.spyOn(controller, 'importCadets')
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 cadets' }))
    expect(spy).not.toHaveBeenCalled()
    expect((await controller.project()).cadets).toHaveLength(1)

    // Fixing the text re-validates immediately.
    paste('M,NS1\nF,1,C-BBBB')
    expect(screen.getByRole('button', { name: 'Import 2 cadets' })).toBeEnabled()
  })

  it('adds an NCO class by head count: "Add 4 new NS1 cadets" with a 2/2 split and no names', async () => {
    const { controller, projection } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    expect(screen.getByRole('button', { name: /new NS1 cadets/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Male cadets'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Female cadets'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 4 new NS1 cadets' }))
    await screen.findByRole('status')
    expect(toasts).toEqual(['Imported 4 cadets.'])
    const cadets = (await controller.project()).cadets
    expect(cadets).toHaveLength(4)
    expect(cadets.every(cadet => cadet.nsLevel === 'NS1' && cadet.status === 'ACTIVE' && cadet.fullName === '')).toBe(true)
    expect(cadets.filter(cadet => cadet.gender === 'Male')).toHaveLength(2)
    expect(cadets.filter(cadet => cadet.gender === 'Female')).toHaveLength(2)
    expect(screen.getByLabelText('Male cadets')).toHaveValue(null)

    fireEvent.change(screen.getByLabelText('Female cadets'), { target: { value: '2.5' } })
    expect(screen.getByRole('button', { name: /new NS1 cadet/ })).toBeDisabled()
    expect(screen.getByText(/Enter whole numbers/)).toBeInTheDocument()
  })

  it('imports more than 200 cadets in chunks the controller accepts', async () => {
    const { controller, projection } = await setup()
    const spy = vi.spyOn(controller, 'importCadets')
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    fireEvent.change(screen.getByLabelText('Male cadets'), { target: { value: '130' } })
    fireEvent.change(screen.getByLabelText('Female cadets'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 250 new NS1 cadets' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Imported 250 cadets.'))
    expect(spy.mock.calls.map(([rows]) => rows.length)).toEqual([200, 50])
    expect((await controller.project()).cadets).toHaveLength(250)
  })

  it('keeps the panel open with the error and removes already-imported lines after a partial failure', async () => {
    const { controller, projection } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    paste(Array.from({ length: 201 }, (_, index) => (index === 200 ? `F,2,,${NAME}` : 'M,1')).join('\n'))
    const real = controller.importCadets.bind(controller)
    vi.spyOn(controller, 'importCadets').mockImplementationOnce(real).mockRejectedValueOnce(new Error('Device is locked.'))
    fireEvent.click(screen.getByRole('button', { name: 'Import 201 cadets' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Imported 200 of 201, then stopped: Device is locked.')
    expect(toasts).toEqual(['Imported 200 cadets.'])
    expect(screen.getByLabelText('Roster lines')).toHaveValue(`F,2,,${NAME}`)
    expect(screen.getByRole('button', { name: 'Import 1 cadet' })).toBeEnabled()
    expect((await controller.project()).cadets).toHaveLength(200)
  })

  it('shows only a permission note without cadets.manage', async () => {
    const { controller, projection } = await setup()
    render(<Harness controller={controller} initial={projection} toasts={[]} can={permission => permission !== 'cadets.manage'} />)
    const drawer = screen.getByRole('dialog', { name: 'Import cadets' })
    expect(within(drawer).getByText(/needs cadet management permission/)).toBeInTheDocument()
    expect(within(drawer).queryByLabelText('Roster lines')).toBeNull()
    expect(within(drawer).queryByRole('button', { name: /Import|Add/ })).toBeNull()
  })
})

describe('roster parsing', () => {
  it('accepts tabs, quoted commas, names in the third column and several level spellings', () => {
    expect(splitRosterLine('Male\tNS3\t\tRivera, Jordan')).toEqual(['Male', 'NS3', '', 'Rivera, Jordan'])
    expect(splitRosterLine('F,2,,"Rivera, ""JR"" Jordan"')).toEqual(['F', '2', '', 'Rivera, "JR" Jordan'])
    expect(splitRosterLine('F;2;C-7K4M')).toEqual(['F', '2', 'C-7K4M'])
    expect(['NS1', 'ns 2', '3', 'NS-4', 'NS5', '0'].map(parseLevel)).toEqual(['NS1', 'NS2', 'NS3', 'NS4', undefined, undefined])
    const parsed = parseRoster('M,1,Jordan Rivera\nF,2,Rivera, Jordan\nM,3,C-7K4M,Jordan\n\n', [])
    expect(parsed.rows.map(row => [row.line, row.cadetCode ?? 'auto', row.fullName ?? ''])).toEqual([
      [1, 'auto', 'Jordan Rivera'],
      [2, 'auto', 'Rivera, Jordan'],
      [3, 'C-7K4M', 'Jordan'],
    ])
    expect(parsed.valid).toEqual([
      { gender: 'Male', nsLevel: 'NS1', fullName: 'Jordan Rivera' },
      { gender: 'Female', nsLevel: 'NS2', fullName: 'Rivera, Jordan' },
      { gender: 'Male', nsLevel: 'NS3', cadetCode: 'C-7K4M', fullName: 'Jordan' },
    ])
    expect(parseRoster(`M,1,,${'x'.repeat(121)}`, []).rows[0].errors).toEqual(['Name is longer than 120 characters.'])
  })

  it('has small helpers for counts, chunks and removing imported lines', () => {
    expect([' ', '0', '35', '501', '-1', '1.5', 'x'].map(value => parseCount(value))).toEqual([0, 0, 35, undefined, undefined, undefined, undefined])
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(withoutLines('a\nb\nc', new Set([1, 3]))).toBe('b')
  })
})
