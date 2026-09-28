import { useState, type FormEvent, type JSX } from 'react'
import { Trash2 } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CalendarEventProjection, CalendarTaskProjection } from '../../distributed/types'
import { InlineError } from './InlineError'
import { useMutation } from './useMutation'

export type TaskEditorProps = {
  event: CalendarEventProjection
  task: CalendarTaskProjection
  controller: DistributedAppController
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  close: () => void
}

/**
 * Renames a preparation task, moves its due date, or removes it (two-step). Only the changed field
 * is sent, so another officer's edit of the other field still lands. Completion is never touched,
 * and a removed task keeps its history.
 */
export function TaskEditor({ event, task, controller, onProjection, notify, close }: TaskEditorProps): JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [days, setDays] = useState(String(Math.abs(task.dueOffsetDays)))
  const [direction, setDirection] = useState<'before' | 'after'>(task.dueOffsetDays > 0 ? 'after' : 'before')
  const [confirming, setConfirming] = useState(false)
  const { pending, error, setError, run } = useMutation({ onProjection, notify })

  const submit = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault()
    const count = Number(days)
    if (!title.trim()) return setError('Enter what needs to be done.')
    if (days.trim() === '' || !Number.isInteger(count) || count < 0 || count > 365) return setError('Days must be a whole number from 0 to 365.')
    const dueOffsetDays = count === 0 ? 0 : direction === 'before' ? -count : count
    const changes = {
      ...(title.trim() !== task.title ? { title: title.trim() } : {}),
      ...(dueOffsetDays !== task.dueOffsetDays ? { dueOffsetDays } : {}),
    }
    if (!Object.keys(changes).length) return close()
    if (await run(() => controller.updateCalendarTask(event.calendarEventId, task.taskId, changes), 'Task updated.')) close()
  }
  const remove = async () => {
    if (await run(() => controller.removeCalendarTask(event.calendarEventId, task.taskId), 'Task removed.')) close()
  }

  return (
    <form className="calendar-task-editor" aria-label="Edit task" noValidate onSubmit={form => void submit(form)}>
      <label className="field">
        Task
        <input value={title} maxLength={120} onChange={change => setTitle(change.target.value)} />
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
      {confirming ? (
        <div className="calendar-confirm" role="group" aria-label="Confirm task removal">
          <p>
            <strong>Remove this task?</strong> It leaves the checklist on every device. Who completed it, and when, stays in the history.
          </p>
          <div className="calendar-confirm-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>
              Keep task
            </button>
            <button type="button" className="calendar-danger" disabled={pending} onClick={() => void remove()}>
              Yes, remove task
            </button>
          </div>
        </div>
      ) : (
        <div className="calendar-task-editor-actions">
          <button type="submit" className="primary-button" disabled={pending}>
            {pending ? 'Saving…' : 'Save task'}
          </button>
          <button type="button" className="secondary-button" onClick={close}>
            Cancel
          </button>
          <button type="button" className="calendar-cancel" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" /> Remove task
          </button>
        </div>
      )}
    </form>
  )
}
