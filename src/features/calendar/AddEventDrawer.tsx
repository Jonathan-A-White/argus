import { useId, useState, type FormEvent, type JSX } from 'react'
import { CalendarPlus, Shirt, TriangleAlert } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { SupplyEventKind } from '../../distributed/types'
import { SUPPLY_EVENT_KINDS, templateFor } from '../../stage3/calendar'
import { KIND_LABEL, bundleName, errorMessage, formatDate, fromDateTimeInputs, offsetLabel } from './calendarModel'

export type AddEventDrawerProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  /** Template preselected when the drawer opens. */
  initialKind?: SupplyEventKind
  close: () => void
  /** Called with the new projection and a confirmation message once the event is saved. */
  onCreated: (projection: ArgusAppProjection, message: string) => void
}

const CUSTOM_DESCRIPTION = 'Any other supply event. Give it a title; add its preparation tasks once it is created.'

/**
 * Schedules a supply event from a template (spec §14–19). The date is always entered by hand; the
 * template supplies the title, the bundles it usually issues and the preparation checklist.
 */
export function AddEventDrawer({ projection, controller, initialKind = 'NCO', close, onCreated }: AddEventDrawerProps): JSX.Element {
  const id = useId()
  const [kind, setKind] = useState<SupplyEventKind>(initialKind)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('09:00')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const template = templateFor(kind)
  const bundleNames = (template?.bundleIds ?? []).map(bundleId => {
    const bundle = projection.bundles.find(candidate => candidate.bundleId === bundleId)
    return bundle ? bundleName(bundle) : bundleId
  })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const when = fromDateTimeInputs(date, time)
    if ('error' in when) {
      setError(when.error)
      return
    }
    const finalTitle = title.trim() || template?.title || ''
    if (!finalTitle) {
      setError('Give this event a title.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await controller.createCalendarEvent({
        kind,
        startsAt: when.startsAt,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      onCreated(next, `${finalTitle} scheduled for ${formatDate(when.startsAt)}.`)
    } catch (reason) {
      setError(errorMessage(reason, 'The event could not be saved. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer title="Add supply event" icon={<CalendarPlus />} close={close}>
      <form className="calendar-form" aria-label="Add supply event" noValidate onSubmit={event => void submit(event)}>
        <fieldset className="calendar-templates">
          <legend>Event template</legend>
          {SUPPLY_EVENT_KINDS.map(option => {
            const candidate = templateFor(option)
            return (
              <label key={option} className={option === kind ? 'calendar-template selected' : 'calendar-template'}>
                <input
                  type="radio"
                  name={`${id}-kind`}
                  value={option}
                  checked={option === kind}
                  onChange={() => {
                    setKind(option)
                    setError('')
                  }}
                />
                <span>
                  <b>{KIND_LABEL[option]}</b>
                  <small>{candidate ? `${candidate.tasks.length} tasks` : 'From scratch'}</small>
                </span>
              </label>
            )
          })}
        </fieldset>

        <section className="calendar-preview" aria-label="Template preview" aria-live="polite">
          <h3>{template?.title ?? 'Custom event'}</h3>
          <p>{template?.description ?? CUSTOM_DESCRIPTION}</p>
          {bundleNames.length > 0 && (
            <p className="calendar-preview-bundles">
              <Shirt aria-hidden="true" />
              Issues {bundleNames.join(', ')}
            </p>
          )}
          {template && (
            <>
              <h4>{template.tasks.length} preparation tasks</h4>
              <ol className="calendar-preview-tasks">
                {template.tasks.map(task => (
                  <li key={task.title}>
                    <span>{task.title}</span>
                    <small>{offsetLabel(task.dueOffsetDays)}</small>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>

        <div className="calendar-form-row">
          <label className="field">
            Date
            <input type="date" required value={date} onChange={event => setDate(event.target.value)} />
          </label>
          <label className="field">
            Time
            <input type="time" required value={time} onChange={event => setTime(event.target.value)} />
          </label>
        </div>
        <label className="field">
          {kind === 'CUSTOM' ? 'Title' : 'Title (optional)'}
          <input
            value={title}
            maxLength={80}
            placeholder={template?.title ?? 'e.g. Color guard uniform issue'}
            onChange={event => setTitle(event.target.value)}
          />
        </label>
        <label className="field">
          Notes (optional)
          <textarea value={notes} maxLength={1000} onChange={event => setNotes(event.target.value)} />
        </label>

        {error && (
          <p className="workflow-error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        <div className="modal-actions calendar-actions">
          <button type="button" className="secondary-button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Saving…' : 'Create event'}
          </button>
        </div>
      </form>
    </Drawer>
  )
}
