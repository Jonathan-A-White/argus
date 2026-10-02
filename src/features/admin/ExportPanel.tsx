import { useState } from 'react'
import { Download, FileSpreadsheet, ShieldAlert } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { createWorkbook, exportFilename } from './exportModel'
import './admin.css'

export type ExportPanelProps = { projection: ArgusAppProjection; close: () => void; notify: (message: string) => void; now?: () => Date }

export function ExportPanel({ projection, close, notify, now = () => new Date() }: ExportPanelProps) {
  const [busy, setBusy] = useState(false)
  const problems = [projection.sync.outbox ? `${projection.sync.outbox} record${projection.sync.outbox === 1 ? '' : 's'} waiting to sync` : '', projection.sync.openConflicts ? `${projection.sync.openConflicts} open conflict${projection.sync.openConflicts === 1 ? '' : 's'}` : '', projection.rejected.length ? `${projection.rejected.length} rejected record${projection.rejected.length === 1 ? '' : 's'}` : '', !projection.integrity.healthy ? 'a data-integrity problem' : ''].filter(Boolean)
  const download = async () => {
    setBusy(true)
    try {
      // Yield once so the busy state is painted before larger units are assembled.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      const generatedAt = now(), bytes = createWorkbook(projection, generatedAt)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const link = document.createElement('a'); link.href = url; link.download = exportFilename(generatedAt); link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      notify('Unit spreadsheet downloaded.')
    } catch {
      notify('The spreadsheet could not be created. Try again.')
    } finally { setBusy(false) }
  }
  return (
    <Drawer title="Export unit spreadsheet" icon={<FileSpreadsheet />} close={close}>
      <p className="admin-intro">Download a complete, human-readable snapshot for Excel or Google Sheets. It includes every cadet, current property, inventory, and outstanding needs.</p>
      <section className="admin-section" aria-labelledby="export-includes">
        <h3 id="export-includes"><FileSpreadsheet aria-hidden="true" /> What is included</h3>
        <ul className="admin-history"><li><strong>Cadets and Cadet Property</strong><small>Names, gender, NS level, status, and everything currently issued.</small></li><li><strong>Inventory and Still Needed</strong><small>What supply has and what cadets still require.</small></li><li><strong>Report Information</strong><small>When the snapshot was created and whether its records were complete.</small></li></ul>
      </section>
      {problems.length > 0 && <div className="workflow-warning" role="alert"><ShieldAlert aria-hidden="true" /><div><strong>Finish resolving unit data before exporting.</strong><p>This report is blocked because there {problems.length === 1 ? 'is' : 'are'} {problems.join(', ')}.</p></div></div>}
      <p className="safe-note"><ShieldAlert aria-hidden="true" />This file contains names and supply records. Share it only with authorized personnel.</p>
      <button type="button" className="primary-button admin-wide" disabled={busy || problems.length > 0} onClick={() => void download()}><Download aria-hidden="true" />{busy ? 'Creating spreadsheet…' : 'Download spreadsheet'}</button>
      <p className="admin-hint">To use Google Sheets: upload the downloaded file to Google Drive, then open it with Google Sheets. Each download is a new, complete snapshot.</p>
    </Drawer>
  )
}
