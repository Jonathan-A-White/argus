import { useId, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowRight, CircleCheck, GraduationCap, Lock } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, RolloverRecord } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { memberLabel } from '../cadets/cadetDisplay'
import { NEXT_LEVEL_LABEL, NS_LEVELS, defaultSchoolYear, plural, rolloverPreview, schoolYearError } from './rolloverModel'
import './admin.css'

export type RolloverPanelProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  close: () => void
}

const formatDate = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString()
}

/**
 * End-of-year rollover (master spec §19): every active cadet advances one NS level and NS4 cadets
 * graduate (inactive, record and property kept for return). One signed event per school year that
 * every device applies; the two-step confirmation makes it hard to run by accident.
 */
export function RolloverPanel({ projection, controller, can, onProjection, notify, close }: RolloverPanelProps) {
  const ids = useId()
  const [schoolYearInput, setSchoolYearInput] = useState(() => defaultSchoolYear(new Date(), projection.rollovers))
  const [step, setStep] = useState<'review' | 'confirm'>('review')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<RolloverRecord>()

  const canManage = can('cadets.manage')
  const schoolYear = schoolYearInput.trim()
  const yearProblem = schoolYearError(schoolYear, projection.rollovers)
  const preview = rolloverPreview(projection.cadets)
  const holding = preview.graduatingWithProperty
  const past = [...projection.rollovers].sort((a, b) => b.schoolYear.localeCompare(a.schoolYear))

  const changeYear = (value: string) => {
    setSchoolYearInput(value)
    setStep('review')
    setTyped('')
    setError('')
  }

  const confirm = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || yearProblem || typed.trim() !== schoolYear) return
    setBusy(true)
    setError('')
    try {
      const next = await controller.completeAnnualRollover(schoolYear)
      const record = next.rollovers.find(candidate => candidate.schoolYear === schoolYear)
      onProjection(next)
      setResult(record)
      setStep('review')
      setTyped('')
      notify(record ? `Rollover ${schoolYear} complete: ${record.advanced} advanced, ${record.graduated} graduated.` : `Rollover ${schoolYear} complete.`)
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : 'The rollover could not be completed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer title="Annual rollover" icon={<GraduationCap />} close={close}>
      <p className="admin-intro">
        At the end of the school year every active cadet moves up one NS level. NS4 cadets graduate: they become inactive but keep their record and any issued property until it is returned. This runs once per school year and every device applies it.
      </p>

      {result && (
        <div className="validation admin-result" role="status">
          <CircleCheck aria-hidden="true" />
          <div>
            <strong>Rollover {result.schoolYear} complete</strong>
            <p>
              {plural(result.advanced, 'cadet')} advanced · {plural(result.graduated, 'cadet')} graduated
            </p>
          </div>
        </div>
      )}

      <label className="field admin-year-field">
        School year
        <input
          aria-label="School year"
          aria-describedby={`${ids}-year-help`}
          aria-invalid={Boolean(yearProblem)}
          value={schoolYearInput}
          onChange={event => changeYear(event.target.value)}
          placeholder="2026-2027"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <small id={`${ids}-year-help`} className={yearProblem ? 'admin-field-error' : 'admin-hint'}>
          {yearProblem || 'The school year the cadets are moving into.'}
        </small>
      </label>

      <section className="admin-section" aria-labelledby={`${ids}-preview`}>
        <h3 id={`${ids}-preview`}>What will change</h3>
        <ul className="rollover-preview" aria-label="Rollover preview">
          {NS_LEVELS.map(level => (
            <li key={level} className={level === 'NS4' ? 'rollover-graduate' : undefined}>
              <span>
                {level} <ArrowRight aria-hidden="true" /> <span className="sr-only">to</span> {NEXT_LEVEL_LABEL[level]}
              </span>
              <b>{plural(preview.byLevel[level], 'cadet')}</b>
            </li>
          ))}
        </ul>
        <p className="admin-count">
          <strong>{plural(preview.active, 'active cadet')}</strong> · {preview.advancing} advance · {preview.graduating} graduate
        </p>
        {preview.active === 0 && <p className="admin-hint">There are no active cadets, so the rollover would change nobody.</p>}
        {holding.length > 0 && (
          <div className="workflow-warning" role="alert">
            <AlertTriangle aria-hidden="true" />
            <div>
              <strong>
                {plural(holding.length, 'graduating cadet')} still {holding.length === 1 ? 'holds' : 'hold'} issued items; collect returns.
              </strong>
              <p className="admin-codes">
                {holding.map(cadet => `${cadetLabel(cadet)} (${plural(cadet.currentProperty.reduce((sum, line) => sum + line.quantity, 0), 'item')})`).join(' · ')}
              </p>
              <p>They can still return items after graduating; their records stay visible under Inactive.</p>
            </div>
          </div>
        )}
      </section>

      {canManage ? (
        step === 'review' ? (
          <button type="button" className="primary-button admin-wide" disabled={busy || Boolean(yearProblem)} onClick={() => setStep('confirm')}>
            Review and confirm rollover
          </button>
        ) : (
          <form className="rollover-confirm" aria-label="Confirm rollover" onSubmit={event => void confirm(event)} noValidate>
            <p>
              <strong>This changes every active cadet’s NS level and cannot be undone automatically.</strong> Type <b>{schoolYear}</b> to confirm.
            </p>
            <label className="field">
              Type the school year to confirm
              <input aria-label="Type the school year to confirm" value={typed} onChange={event => setTyped(event.target.value)} placeholder={schoolYear} autoComplete="off" spellCheck={false} inputMode="numeric" disabled={busy} autoFocus />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => changeYear(schoolYearInput)} disabled={busy}>
                Back
              </button>
              <button type="submit" className="primary-button" disabled={busy || Boolean(yearProblem) || typed.trim() !== schoolYear}>
                {busy ? 'Completing…' : `Complete ${schoolYear} rollover`}
              </button>
            </div>
          </form>
        )
      ) : (
        <p className="safe-note admin-locked">
          <Lock aria-hidden="true" /> A Supply Officer or the Master completes the annual rollover.
        </p>
      )}

      {error && (
        <div className="workflow-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          {error}
        </div>
      )}

      <section className="admin-section" aria-labelledby={`${ids}-past`}>
        <h3 id={`${ids}-past`}>Past rollovers</h3>
        {past.length ? (
          <ul className="admin-history">
            {past.map(record => (
              <li key={record.eventId}>
                <strong>{record.schoolYear}</strong>
                <small>
                  Completed {formatDate(record.at)} by {memberLabel(projection, record.actor)} · {record.advanced} advanced · {record.graduated} graduated
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="admin-hint">No rollovers yet.</p>
        )}
      </section>
    </Drawer>
  )
}
