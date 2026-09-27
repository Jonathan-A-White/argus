import { useId, useState } from 'react'
import { AlertTriangle, CircleCheck, Lock, UserPlus, Users } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import { MAX_IMPORT_CADETS } from '../../distributed/replica'
import type { ArgusPermission } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { MAX_PASTED_ROWS, MAX_QUICK_ADD, cadetCount, chunk, parseCount, parseRoster, previewOf, quickClass, withoutLines, type ImportRow, type RosterPreview } from './rosterModel'
import './admin.css'

export type RosterImportPanelProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  close: () => void
}

type ImportOutcome = { imported: number; codes: string[]; failure?: string }

const EXAMPLE = 'gender,nsLevel,cadetCode,name\nM,1\nF,NS1,C-7K4M\nFemale,2,,(optional name)'

/**
 * Bulk roster entry (master spec §6, §15). Cadets are minors: the preview identifies rows by line
 * number and cadet ID only. A pasted name is encrypted on import and shown here only as
 * "name provided" — never its text.
 */
export function RosterImportPanel({ projection, controller, can, onProjection, notify, close }: RosterImportPanelProps) {
  const ids = useId()
  const [text, setText] = useState('')
  const [maleText, setMaleText] = useState('')
  const [femaleText, setFemaleText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<ImportOutcome>()

  if (!can('cadets.manage')) {
    return (
      <Drawer title="Import cadets" icon={<UserPlus />} close={close}>
        <p className="safe-note admin-locked">
          <Lock aria-hidden="true" /> Importing cadets needs cadet management permission. A Supply Officer or the Master can add the roster.
        </p>
      </Drawer>
    )
  }

  const takenCodes = projection.cadets.flatMap(cadet => (cadet.cadetCode ? [cadet.cadetCode] : []))
  const parsed = parseRoster(text, takenCodes)
  const tooMany = parsed.rows.length > MAX_PASTED_ROWS
  const pasteReady = parsed.valid.length > 0 && parsed.invalidCount === 0 && !tooMany
  const male = parseCount(maleText)
  const female = parseCount(femaleText)
  const quickTotal = (male ?? 0) + (female ?? 0)
  const quickValid = male !== undefined && female !== undefined && quickTotal > 0 && quickTotal <= MAX_QUICK_ADD

  /** Imports in chunks the controller accepts, publishing progress after each chunk. */
  const runImport = async (rows: ImportRow[]): Promise<ImportOutcome> => {
    const before = new Set(projection.cadets.map(cadet => cadet.cadetId))
    let latest: ArgusAppProjection | undefined
    let imported = 0
    let failure: string | undefined
    for (const part of chunk(rows, MAX_IMPORT_CADETS)) {
      try {
        latest = await controller.importCadets(part)
        imported += part.length
        onProjection(latest)
      } catch (reason) {
        failure = reason instanceof Error && reason.message ? reason.message : 'The import could not be saved.'
        break
      }
    }
    const codes = latest ? latest.cadets.filter(cadet => !before.has(cadet.cadetId)).map(cadetLabel) : []
    return { imported, codes, ...(failure ? { failure } : {}) }
  }

  const finish = (result: ImportOutcome, total: number) => {
    setOutcome(result)
    if (result.imported) notify(`Imported ${cadetCount(result.imported)}.`)
    setError(result.failure ? (result.imported ? `Imported ${result.imported} of ${total}, then stopped: ${result.failure}` : result.failure) : '')
  }

  const importPasted = async () => {
    if (busy) return
    if (!pasteReady) {
      setError(tooMany ? `Paste at most ${MAX_PASTED_ROWS} cadets at a time.` : 'Fix the rows marked in the preview before importing.')
      return
    }
    setBusy(true)
    setError('')
    // Every row is valid here, so parsed.rows and parsed.valid line up one to one.
    const { rows, valid } = parsed
    const result = await runImport(valid)
    // Drop exactly the lines that were imported, so a retry after a partial failure cannot duplicate them.
    const done = new Set(rows.slice(0, result.imported).map(row => row.line))
    setText(current => (result.imported === rows.length ? '' : withoutLines(current, done)))
    finish(result, rows.length)
    setBusy(false)
  }

  const importQuick = async () => {
    if (busy || !quickValid) return
    setBusy(true)
    setError('')
    const result = await runImport(quickClass(male ?? 0, female ?? 0))
    if (!result.failure) {
      setMaleText('')
      setFemaleText('')
    }
    finish(result, quickTotal)
    setBusy(false)
  }

  return (
    <Drawer title="Import cadets" icon={<UserPlus />} close={close}>
      <p className="admin-intro">
        Cadets are listed everywhere by cadet ID. Names are optional, encrypted before they leave this device, and never shown in lists.
      </p>

      {outcome && outcome.imported > 0 && (
        <div className="validation admin-result" role="status">
          <CircleCheck aria-hidden="true" />
          <div>
            <strong>Imported {cadetCount(outcome.imported)}.</strong>
            <details>
              <summary>Show new cadet IDs</summary>
              <p className="admin-codes">{outcome.codes.join(' · ')}</p>
            </details>
          </div>
        </div>
      )}
      {error && (
        <div className="workflow-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          {error}
        </div>
      )}

      <section className="admin-section" aria-labelledby={`${ids}-quick`}>
        <h3 id={`${ids}-quick`}>
          <Users aria-hidden="true" /> Incoming NS1 class
        </h3>
        <p>For New Cadet Orientation: create cadets by head count, without names. Cadet IDs are generated.</p>
        <div className="form-grid admin-count-grid">
          <label className="field">
            Male cadets
            <input aria-label="Male cadets" type="number" inputMode="numeric" min={0} max={MAX_QUICK_ADD} placeholder="0" value={maleText} onChange={event => setMaleText(event.target.value)} aria-invalid={male === undefined} disabled={busy} />
          </label>
          <label className="field">
            Female cadets
            <input aria-label="Female cadets" type="number" inputMode="numeric" min={0} max={MAX_QUICK_ADD} placeholder="0" value={femaleText} onChange={event => setFemaleText(event.target.value)} aria-invalid={female === undefined} disabled={busy} />
          </label>
        </div>
        {(male === undefined || female === undefined || quickTotal > MAX_QUICK_ADD) && (
          <p className="admin-field-error">Enter whole numbers; at most {MAX_QUICK_ADD} cadets at a time.</p>
        )}
        <button type="button" className="primary-button" disabled={busy || !quickValid} onClick={() => void importQuick()}>
          {busy ? 'Importing…' : `Add ${quickValid ? `${quickTotal} ` : ''}new NS1 cadet${quickTotal === 1 ? '' : 's'}`}
        </button>
      </section>

      <section className="admin-section" aria-labelledby={`${ids}-paste`}>
        <h3 id={`${ids}-paste`}>
          <UserPlus aria-hidden="true" /> Paste a roster
        </h3>
        <p>
          One cadet per line: <code>gender, NS level, cadet ID, name</code>. Cadet ID and name are optional; a blank ID is generated. Paste from a spreadsheet (tabs) or type commas. A header row is fine.
        </p>
        <label className="field">
          Roster lines
          <textarea
            aria-label="Roster lines"
            aria-describedby={`${ids}-paste-help`}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            value={text}
            placeholder={EXAMPLE}
            onChange={event => setText(event.target.value)}
            disabled={busy}
          />
          <small id={`${ids}-paste-help`} className="admin-hint">
            Gender: M, F, Male or Female. NS level: NS1–NS4 or 1–4.
          </small>
        </label>

        {parsed.rows.length > 0 && (
          <>
            <p className="admin-count" aria-live="polite">
              <strong>{cadetCount(parsed.valid.length)} ready</strong>
              {parsed.invalidCount > 0 && <span className="admin-count-bad"> · {parsed.invalidCount} with problems</span>}
              {parsed.headerSkipped && <span> · header row skipped</span>}
            </p>
            <div className="admin-table-wrap">
              <table className="admin-table" aria-label="Import preview">
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Gender</th>
                    <th scope="col">Level</th>
                    <th scope="col">Cadet ID</th>
                    <th scope="col">Name</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map(row => (
                    <RosterPreviewRow key={row.line} row={previewOf(row)} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <button type="button" className="primary-button admin-import-button" disabled={busy || !pasteReady} onClick={() => void importPasted()}>
          {busy ? 'Importing…' : `Import ${cadetCount(parsed.valid.length)}`}
        </button>
        {parsed.invalidCount > 0 && <p className="admin-field-error">Fix or remove the lines marked above to import.</p>}
        {tooMany && <p className="admin-field-error">Paste at most {MAX_PASTED_ROWS} cadets at a time.</p>}
      </section>
    </Drawer>
  )
}

/** One preview row. It is handed a RosterPreview, which has no name text: only whether one was provided. */
function RosterPreviewRow({ row }: { row: RosterPreview }) {
  const bad = row.errors.length > 0
  return (
    <>
      <tr className={bad ? 'admin-row-bad' : undefined}>
        <th scope="row">{row.line}</th>
        <td>{row.gender ?? '—'}</td>
        <td>{row.nsLevel ?? '—'}</td>
        <td>{row.codeProvided ? (row.displayCode ?? <span className="admin-muted">invalid ID</span>) : <span className="admin-muted">auto</span>}</td>
        <td>{row.hasName ? 'name provided' : <span className="admin-muted">—</span>}</td>
      </tr>
      {bad && (
        <tr className="admin-row-errors">
          <td colSpan={5}>
            <AlertTriangle aria-hidden="true" /> Line {row.line}: {row.errors.join(' ')}
          </td>
        </tr>
      )}
    </>
  )
}
