import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController } from '../../distributed/appIntegration'
import { ExportPanel } from './ExportPanel'

describe('ExportPanel', () => {
  it('downloads a complete workbook and reports success', async () => {
    const controller = new DistributedAppController(), projection = await controller.initialize(), notify = vi.fn()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workbook')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<ExportPanel projection={projection} close={() => undefined} notify={notify} now={() => new Date('2026-10-02T10:30:00.000Z')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download spreadsheet' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Unit spreadsheet downloaded.'))
    expect(screen.getByRole('button', { name: 'Download spreadsheet' })).toBeEnabled()
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:workbook'))
  })

  it('blocks an export when shared data is incomplete', async () => {
    const controller = new DistributedAppController(), projection = await controller.initialize()
    projection.sync.outbox = 2
    render(<ExportPanel projection={projection} close={() => undefined} notify={() => undefined} />)
    expect(screen.getByRole('alert')).toHaveTextContent('2 records waiting to sync')
    expect(screen.getByRole('button', { name: 'Download spreadsheet' })).toBeDisabled()
  })
})
