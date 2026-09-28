import { useId, useState, type FormEvent, type JSX } from 'react'
import { Ban, CalendarClock, Circle, CircleCheck, Pencil, RotateCcw, Shirt, TriangleAlert } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CalendarEventProjection, CalendarTaskProjection, SupplyEventKind } from '../../distributed/types'
import { SUPPLY_EVENT_KINDS } from '../../stage3/calendar'
import { EventAttendees } from './EventAttendees'
import { InlineError } from './InlineError'
import { TaskEditor } from './TaskEditor'
import { useMutation } from './useMutation'
import {
  KIND_LABEL,
  STOCKED_KINDS,
  bundleName,
  bundleStockReadiness,
  currentBundleVersion,
  countdownLabel,
  dateBlock,
  daysUntil,
  eventProgress,
  formatDate,
  formatShortDate,
  formatTime,
  fromDateTimeInputs,
  offsetLabel,
  overdueTasks,
  sortTasks,
  taskDueAt,
  taskStatus,
  toDateInput,
  toTimeInput,
  type TaskTone,
} from './calendarModel'

export type EventDrawerProps = {
  event: CalendarEventProjection
  projection: ArgusAppProjection
  controller: DistributedAppController
  /** calendar.write: without it everything is shown read-only. */
  canWrite: boolean
  /** cadets.read: may reveal attendee names on request. Defaults to hidden. */
  canRevealNames?: boolean
  memberName: (publicIdentity: string) => string
  now: Date
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  close: () => void
}

type Mutations = Pick<EventDrawerProps, 'controller' | 'onProjection' | 'notify'>

const BADGE: Record<TaskTone, string> = { done: 'success', overdue: 'danger', soon: 'warning', later: '' }

/** Supply event detail: countdown, preparation checklist, bundle stock readiness, attendees and (with calendar.write) editing. */
export function EventDrawer({ event, projection, controller, canWrite, canRevealNames = false, memberName, now, onProjection, notify, close }: EventDrawerProps): JSX.Element {
  const progress = eventProgress(event)
  const days = daysUntil(event.startsAt, now)
  const leaf = dateBlock(event.startsAt)
  const overdue = event.active ? overdueTasks(event, now).length : 0
  const editable = canWrite && event.active
  const mutations: Mutations = { controller, onProjection, notify }
  const conflicts = projection.conflicts.filter(conflict => conflict.status === 'OPEN' && conflict.entityId === event.calendarEventId)
  return (
    <Drawer title={event.title} icon={<CalendarClock />} close={close}>
      <section className="calendar-hero">
        <span className="calendar-leaf" aria-hidden="true">
          <small>{leaf.month}</small>
          <b>{leaf.day}</b>
        </span>
        <div>
          <small>
            {KIND_LABEL[event.kind].toUpperCase()}
            {event.active ? '' : ' · CANCELLED'}
          </small>
          <b>
            {formatDate(event.startsAt)} · {formatTime(event.startsAt)}
          </b>
          <p>
            <span className="calendar-hero-countdown">{countdownLabel(days)}</span> · added by {memberName(event.createdBy)}
          </p>
        </div>
      </section>
      {event.notes && <p className="calendar-notes">{event.notes}</p>}
      {!event.active && (
        <p className="workflow-warning calendar-cancelled-note">
          <Ban aria-hidden="true" />
          <span>This event is cancelled. It no longer raises alerts; its history is kept.</span>
        </p>
      )}
      {conflicts.map(conflict => (
        <p key={conflict.id} className="workflow-warning calendar-conflict-note" role="status">
          <TriangleAlert aria-hidden="true" />
          <span>
            <strong>Conflicting edit.</strong> {conflict.reason} The first change is shown; the other is kept in history for review under More → Conflicts.
          </span>
        </p>
      ))}

      <section className="calendar-progress" aria-label="Preparation progress summary">
        <div className="calendar-progress-head">
          <strong>Preparation</strong>
          <span>{progress.total ? `${progress.done}/${progress.total} tasks · ${progress.percent}%` : 'No tasks yet'}</span>
        </div>
        <div
          className="calendar-meter"
          role="progressbar"
          aria-label="Preparation progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          aria-valuetext={`${progress.done} of ${progress.total} tasks complete`}
        >
          <span style={{ width: `${progress.percent}%` }} />
        </div>
        {overdue > 0 && (
          <p className="calendar-overdue-note">
            <TriangleAlert aria-hidden="true" />
            {overdue} task{overdue === 1 ? ' is' : 's are'} overdue
          </p>
        )}
      </section>

      <TaskList event={event} canWrite={editable} now={now} memberName={memberName} {...mutations} />
      {editable && <AddTaskForm event={event} {...mutations} />}
      <EventBundles event={event} projection={projection} />
      <EventAttendees event={event} projection={projection} canWrite={editable} canRevealNames={canRevealNames} {...mutations} />
      {editable && <EventDetailsForm key={event.calendarEventId} event={event} projection={projection} {...mutations} />}
      {canWrite && <EventStatusControl event={event} close={close} {...mutations} />}
    </Drawer>
  )
}

function TaskList({
  event,
  canWrite,
  now,
  memberName,
  controller,
  onProjection,
  notify,
}: Mutations & { event: CalendarEventProjection; canWrite: boolean; now: Date; memberName: (publicIdentity: string) => string }) {
  const id = useId()
  const { error, run } = useMutation({ onProjection, notify })
  const [pendingTask, setPendingTask] = useState<string>()
  const [editingTask, setEditingTask] = useState<string>()
  const toggle = async (task: CalendarTaskProjection, completed: boolean) => {
    setPendingTask(task.taskId)
    await run(() => controller.completeTask(event.calendarEventId, task.taskId, completed))
    setPendingTask(undefined)
  }
  return (
    <section className="calendar-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Preparation tasks</h3>
      <InlineError message={error} />
      {event.tasks.length ? (
        <ul className="calendar-tasks">
          {sortTasks(event.tasks).map(task => {
            const status = taskStatus(event, task, now, memberName)
            const describedBy = `${id}-${task.taskId}`
            return (
              <li key={task.taskId} className={`calendar-task tone-${status.tone}${canWrite ? ' editable' : ''}`}>
                {canWrite ? (
                  <label className="calendar-task-main">
                    <input
                      type="checkbox"
                      checked={task.completed}
                      disabled={pendingTask === task.taskId}
                      aria-describedby={describedBy}
                      onChange={change => void toggle(task, change.target.checked)}
                    />
                    <span>{task.title}</span>
                  </label>
                ) : (
                  <span className="calendar-task-main">
                    {task.completed ? <CircleCheck role="img" aria-label="Done" /> : <Circle role="img" aria-label="Not done" />}
                    <span>{task.title}</span>
                  </span>
                )}
                <span className="calendar-task-meta" id={describedBy}>
                  <small>
                    Due {formatShortDate(taskDueAt(event, task))} · {offsetLabel(task.dueOffsetDays)}
                  </small>
                  <em className={`status-badge ${BADGE[status.tone]}`}>{status.label}</em>
                </span>
                {canWrite && editingTask !== task.taskId && (
                  <button type="button" className="calendar-icon-button calendar-task-edit" aria-label={`Edit task: ${task.title}`} onClick={() => setEditingTask(task.taskId)}>
                    <Pencil aria-hidden="true" />
                  </button>
                )}
                {canWrite && editingTask === task.taskId && (
                  <TaskEditor event={event} task={task} controller={controller} onProjection={onProjection} notify={notify} close={() => setEditingTask(undefined)} />
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="calendar-muted">No preparation tasks yet.{canWrite ? ' Add the first one below.' : ''}</p>
      )}
    </section>
  )
}

function AddTaskForm({ event, controller, onProjection, notify }: Mutations & { event: CalendarEventProjection }) {
  const [title, setTitle] = useState('')
  const [days, setDays] = useState('7')
  const [direction, setDirection] = useState<'before' | 'after'>('before')
  const { pending, error, setError, run } = useMutation({ onProjection, notify })
  const submit = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault()
    const count = Number(days)
    if (!title.trim()) return setError('Enter what needs to be done.')
    if (days.trim() === '' || !Number.isInteger(count) || count < 0 || count > 365) return setError('Days must be a whole number from 0 to 365.')
    const dueOffsetDays = count === 0 ? 0 : direction === 'before' ? -count : count
    if (await run(() => controller.addCalendarTask(event.calendarEventId, { title: title.trim(), dueOffsetDays }), 'Task added.')) {
      setTitle('')
    }
  }
  return (
    <form className="calendar-section calendar-add-task" aria-label="Add task" noValidate onSubmit={form => void submit(form)}>
      <h3>Add a preparation task</h3>
      <label className="field">
        Task
        <input value={title} maxLength={120} placeholder="e.g. Launder loaner PT gear" onChange={change => setTitle(change.target.value)} />
      </label>
      <div className="calendar-form-row">
        <label className="field">
          Days
          <input type="number" inputMode="numeric" min={0} max={365} step={1} value={days} onChange={change => setDays(change.target.value)} />
        </label>
        <label className="field">
          When
          <select value={direction} onChange={change => setDirection(change.target.value === 'after' ? 'after' : 'before')}>
            <option value="before">Before event</option>
            <option value="after">After event</option>
          </select>
        </label>
      </div>
      <InlineError message={error} />
      <button type="submit" className="secondary-button calendar-inline-action" disabled={pending}>
        {pending ? 'Adding…' : 'Add task'}
      </button>
    </form>
  )
}

function EventBundles({ event, projection }: { event: CalendarEventProjection; projection: ArgusAppProjection }) {
  const id = useId()
  const showStock = STOCKED_KINDS.includes(event.kind)
  const bundles = event.bundleIds.flatMap(bundleId => projection.bundles.filter(bundle => bundle.bundleId === bundleId))
  if (!bundles.length && !showStock) return null
  return (
    <section className="calendar-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{showStock ? 'Bundle readiness' : 'Bundles'}</h3>
      {bundles.length ? (
        <ul className="calendar-bundles">
          {bundles.map(bundle => {
            const stock = bundleStockReadiness(bundle, projection.inventory)
            const percent = stock.total ? Math.round((100 * stock.ready) / stock.total) : 0
            return (
              <li key={bundle.bundleId}>
                <Shirt aria-hidden="true" />
                <span>
                  <strong>{stock.name}</strong>
                  {showStock && <small>{`Stock ready for ${stock.ready}/${stock.total} ${stock.name} lines`}</small>}
                  {showStock && stock.missing.length > 0 && <small className="calendar-missing">Nothing on hand: {stock.missing.join(', ')}</small>}
                </span>
                {showStock && (
                  <span className={stock.ready === stock.total ? 'calendar-meter small ready' : 'calendar-meter small'} aria-hidden="true">
                    <span style={{ width: `${percent}%` }} />
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="calendar-muted">No bundles are linked to this event.</p>
      )}
    </section>
  )
}

type Details = { title: string; date: string; time: string; notes: string; kind: SupplyEventKind; bundleIds: string[] }
const detailsOf = (event: CalendarEventProjection): Details => ({ title: event.title, date: toDateInput(event.startsAt), time: toTimeInput(event.startsAt), notes: event.notes ?? '', kind: event.kind, bundleIds: event.bundleIds })
const joinWords = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)
const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000)

/**
 * Edits the event's details and linked bundles. Changes are measured against `base`, the event as
 * it was when the form was loaded: only fields this person changed are sent (with that base), so an
 * edit made meanwhile on another device either merges (different field) or becomes a visible
 * conflict (same field) instead of being overwritten.
 */
function EventDetailsForm({ event, projection, controller, onProjection, notify }: Mutations & { event: CalendarEventProjection; projection: ArgusAppProjection }) {
  const id = useId()
  const [base, setBase] = useState(event)
  const [draft, setDraft] = useState(() => detailsOf(event))
  const [notice, setNotice] = useState('')
  const { pending, error, setError, run } = useMutation({ onProjection, notify })
  const set = <K extends keyof Details>(key: K, value: Details[K]) => setDraft(current => ({ ...current, [key]: value }))
  const when = fromDateTimeInputs(draft.date, draft.time)
  const changes = {
    ...(draft.title.trim() !== base.title ? { title: draft.title.trim() } : {}),
    ...('startsAt' in when && minute(when.startsAt) !== minute(base.startsAt) ? { startsAt: when.startsAt } : {}),
    ...(draft.notes.trim() !== (base.notes ?? '') ? { notes: draft.notes.trim() } : {}),
    ...(draft.kind !== base.kind ? { kind: draft.kind } : {}),
  }
  // Bundle links are a set: only what this person linked or unlinked is sent, so others' changes merge.
  const linking = draft.bundleIds.filter(bundleId => !base.bundleIds.includes(bundleId))
  const unlinking = base.bundleIds.filter(bundleId => !draft.bundleIds.includes(bundleId))
  const dirty = Object.keys(changes).length > 0 || linking.length > 0 || unlinking.length > 0 || 'error' in when
  // While this form's own save is in flight the event moves ahead of `base`; that is not someone else's change.
  const changedElsewhere = pending ? [] : [
    ...(event.title !== base.title ? ['title'] : []),
    ...(event.startsAt !== base.startsAt ? ['date and time'] : []),
    ...((event.notes ?? '') !== (base.notes ?? '') ? ['notes'] : []),
    ...(event.kind !== base.kind ? ['event type'] : []),
    ...([...event.bundleIds].sort().join() !== [...base.bundleIds].sort().join() ? ['bundles'] : []),
  ]
  const bundleOptions = projection.bundles.filter(bundle => currentBundleVersion(bundle)?.active !== false || draft.bundleIds.includes(bundle.bundleId))
  const load = (source: CalendarEventProjection) => {
    setBase(source)
    setDraft(detailsOf(source))
    setNotice('')
  }
  const toggleBundle = (bundleId: string) =>
    set('bundleIds', draft.bundleIds.includes(bundleId) ? draft.bundleIds.filter(candidate => candidate !== bundleId) : [...draft.bundleIds, bundleId])

  const submit = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault()
    if ('error' in when) return setError(when.error)
    const calendarEventId = event.calendarEventId
    const known = new Set(projection.conflicts.map(conflict => conflict.id))
    const result: { projection?: ArgusAppProjection } = {}
    const step = async (operation: () => Promise<ArgusAppProjection>) => {
      result.projection = await operation()
      onProjection(result.projection)
    }
    const saved = await run(async () => {
      if (Object.keys(changes).length) await step(() => controller.updateCalendarEvent(calendarEventId, changes, base))
      const current = result.projection?.calendar.find(candidate => candidate.calendarEventId === calendarEventId) ?? event
      const link = linking.filter(bundleId => !current.bundleIds.includes(bundleId))
      const unlink = unlinking.filter(bundleId => current.bundleIds.includes(bundleId))
      if (link.length) await step(() => controller.addCalendarBundles(calendarEventId, link))
      if (unlink.length) await step(() => controller.removeCalendarBundles(calendarEventId, unlink))
      return result.projection ?? (await controller.project())
    })
    const latest = result.projection?.calendar.find(candidate => candidate.calendarEventId === calendarEventId)
    if (!saved) return
    if (result.projection?.conflicts.some(conflict => conflict.status === 'OPEN' && conflict.entityId === calendarEventId && !known.has(conflict.id))) {
      // Keep what this person typed; the next save is a deliberate replacement made with the other change in view.
      if (latest) setBase(latest)
      setNotice('Another device changed the same details while you were editing. Its change was kept and yours is recorded as a conflict for review. Save again to replace it with yours.')
      notify('Saved as a conflict for review.')
      return
    }
    if (latest) load(latest)
    notify('Event updated.')
  }

  return (
    <details
      className="panel-rows calendar-edit"
      onToggle={toggle => {
        if (toggle.currentTarget.open && !dirty) load(event)
      }}
    >
      <summary>Edit details and bundles</summary>
      <form aria-label="Edit event details" noValidate onSubmit={form => void submit(form)}>
        {changedElsewhere.length > 0 && (
          <div className="workflow-warning calendar-stale" role="status">
            <TriangleAlert aria-hidden="true" />
            <span>Another device changed the {joinWords(changedElsewhere)} since this form was loaded.</span>
            <button type="button" className="calendar-chip-button" onClick={() => load(event)}>
              Load latest
            </button>
          </div>
        )}
        <div className="calendar-form-row">
          <label className="field">
            Date
            <input type="date" required value={draft.date} onChange={change => set('date', change.target.value)} />
          </label>
          <label className="field">
            Time
            <input type="time" required value={draft.time} onChange={change => set('time', change.target.value)} />
          </label>
        </div>
        <label className="field">
          Title
          <input value={draft.title} maxLength={80} onChange={change => set('title', change.target.value)} />
        </label>
        <label className="field">
          Event type
          <select value={draft.kind} onChange={change => set('kind', change.target.value as SupplyEventKind)}>
            {SUPPLY_EVENT_KINDS.map(kind => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Notes
          <textarea value={draft.notes} maxLength={1000} onChange={change => set('notes', change.target.value)} />
        </label>
        <div className="calendar-bundle-picker" role="group" aria-labelledby={`${id}-bundles`}>
          <span id={`${id}-bundles`} className="calendar-picker-label">
            Bundles issued at this event
          </span>
          <div className="calendar-chips">
            {bundleOptions.map(bundle => (
              <button key={bundle.bundleId} type="button" aria-pressed={draft.bundleIds.includes(bundle.bundleId)} onClick={() => toggleBundle(bundle.bundleId)}>
                {bundleName(bundle)}
              </button>
            ))}
          </div>
        </div>
        {notice && (
          <p className="workflow-warning" role="status">
            <TriangleAlert aria-hidden="true" />
            <span>{notice}</span>
          </p>
        )}
        <InlineError message={error} />
        <button type="submit" className="primary-button" disabled={!dirty || pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </details>
  )
}

/** Cancelling is a two-step action; a cancelled event can be restored. */
function EventStatusControl({ event, close, controller, onProjection, notify }: Mutations & { event: CalendarEventProjection; close: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const { pending, error, run } = useMutation({ onProjection, notify })
  if (!event.active) {
    return (
      <section className="calendar-section calendar-status">
        <InlineError message={error} />
        <button
          type="button"
          className="secondary-button calendar-inline-action"
          disabled={pending}
          onClick={() => void run(() => controller.updateCalendarEvent(event.calendarEventId, { active: true }, event), 'Event restored.')}
        >
          <RotateCcw aria-hidden="true" /> Restore event
        </button>
      </section>
    )
  }
  const cancel = async () => {
    if (await run(() => controller.updateCalendarEvent(event.calendarEventId, { active: false }, event), `${event.title} cancelled.`)) close()
  }
  return (
    <section className="calendar-section calendar-status">
      <InlineError message={error} />
      {confirming ? (
        <div className="calendar-confirm" role="group" aria-label="Confirm cancellation">
          <p>
            <strong>Cancel {event.title}?</strong> It leaves the calendar and stops raising alerts. Its history is kept and it can be
            restored.
          </p>
          <div className="calendar-confirm-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>
              Keep event
            </button>
            <button type="button" className="calendar-danger" disabled={pending} onClick={() => void cancel()}>
              Yes, cancel event
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="calendar-cancel" onClick={() => setConfirming(true)}>
          <Ban aria-hidden="true" /> Cancel event
        </button>
      )}
    </section>
  )
}
