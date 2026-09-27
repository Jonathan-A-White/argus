import { useId, useState, type FormEvent, type JSX } from 'react'
import { Ban, CalendarClock, Circle, CircleCheck, RotateCcw, Shirt, TriangleAlert, Users } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CalendarEventProjection, CalendarTaskProjection } from '../../distributed/types'
import {
  KIND_LABEL,
  STOCKED_KINDS,
  bundleStockReadiness,
  countdownLabel,
  dateBlock,
  daysUntil,
  errorMessage,
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
  memberName: (publicIdentity: string) => string
  now: Date
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  close: () => void
}

type Mutations = Pick<EventDrawerProps, 'controller' | 'onProjection' | 'notify'>

const BADGE: Record<TaskTone, string> = { done: 'success', overdue: 'danger', soon: 'warning', later: '' }

/** One async controller call with its own pending flag and inline error. */
function useMutation({ onProjection, notify }: Pick<Mutations, 'onProjection' | 'notify'>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const run = async (operation: () => Promise<ArgusAppProjection>, success?: string) => {
    setPending(true)
    setError('')
    try {
      onProjection(await operation())
      if (success) notify(success)
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    } finally {
      setPending(false)
    }
  }
  return { pending, error, setError, run }
}

function InlineError({ message }: { message: string }) {
  if (!message) return null
  return (
    <p className="workflow-error" role="alert">
      <TriangleAlert aria-hidden="true" />
      <span>{message}</span>
    </p>
  )
}

/** Supply event detail: countdown, preparation checklist, bundle stock readiness and (with calendar.write) editing. */
export function EventDrawer({ event, projection, controller, canWrite, memberName, now, onProjection, notify, close }: EventDrawerProps): JSX.Element {
  const progress = eventProgress(event)
  const days = daysUntil(event.startsAt, now)
  const leaf = dateBlock(event.startsAt)
  const overdue = event.active ? overdueTasks(event, now).length : 0
  const editable = canWrite && event.active
  const mutations: Mutations = { controller, onProjection, notify }
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
        <p className="workflow-warning">
          <Ban aria-hidden="true" />
          <span>This event is cancelled. It no longer raises alerts; its history is kept.</span>
        </p>
      )}

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
      {event.cadetIds.length > 0 && (
        <p className="calendar-cadets">
          <Users aria-hidden="true" />
          {event.cadetIds.length} cadet{event.cadetIds.length === 1 ? '' : 's'} linked to this event
        </p>
      )}
      {editable && <EventDetailsForm key={event.calendarEventId} event={event} {...mutations} />}
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
              <li key={task.taskId} className={`calendar-task tone-${status.tone}`}>
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
            <option value="before">Before the event</option>
            <option value="after">After the event</option>
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

function EventDetailsForm({ event, controller, onProjection, notify }: Mutations & { event: CalendarEventProjection }) {
  const [title, setTitle] = useState(event.title)
  const [date, setDate] = useState(toDateInput(event.startsAt))
  const [time, setTime] = useState(toTimeInput(event.startsAt))
  const [notes, setNotes] = useState(event.notes ?? '')
  const { pending, error, setError, run } = useMutation({ onProjection, notify })
  const when = fromDateTimeInputs(date, time)
  const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000)
  const changes = {
    ...(title.trim() !== event.title ? { title: title.trim() } : {}),
    ...('startsAt' in when && minute(when.startsAt) !== minute(event.startsAt) ? { startsAt: when.startsAt } : {}),
    ...(notes.trim() !== (event.notes ?? '') ? { notes: notes.trim() } : {}),
  }
  const dirty = Object.keys(changes).length > 0 || 'error' in when
  const submit = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault()
    if ('error' in when) return setError(when.error)
    await run(() => controller.updateCalendarEvent(event.calendarEventId, changes), 'Event updated.')
  }
  return (
    <details className="panel-rows calendar-edit">
      <summary>Edit date, title and notes</summary>
      <form aria-label="Edit event details" noValidate onSubmit={form => void submit(form)}>
        <div className="calendar-form-row">
          <label className="field">
            Date
            <input type="date" required value={date} onChange={change => setDate(change.target.value)} />
          </label>
          <label className="field">
            Time
            <input type="time" required value={time} onChange={change => setTime(change.target.value)} />
          </label>
        </div>
        <label className="field">
          Title
          <input value={title} maxLength={80} onChange={change => setTitle(change.target.value)} />
        </label>
        <label className="field">
          Notes
          <textarea value={notes} maxLength={1000} onChange={change => setNotes(change.target.value)} />
        </label>
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
          onClick={() => void run(() => controller.updateCalendarEvent(event.calendarEventId, { active: true }), 'Event restored.')}
        >
          <RotateCcw aria-hidden="true" /> Restore event
        </button>
      </section>
    )
  }
  const cancel = async () => {
    if (await run(() => controller.updateCalendarEvent(event.calendarEventId, { active: false }), `${event.title} cancelled.`)) close()
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
