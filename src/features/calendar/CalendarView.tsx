import { useCallback, useId, useState, type JSX } from 'react'
import { CalendarPlus, ChevronRight } from 'lucide-react'
import { Summary } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, CalendarEventProjection, SupplyEventKind } from '../../distributed/types'
import { SUPPLY_EVENT_TEMPLATES } from '../../stage3/calendar'
import { AddEventDrawer } from './AddEventDrawer'
import { EventDrawer } from './EventDrawer'
import {
  KIND_LABEL,
  countdownLabel,
  dateBlock,
  daysUntil,
  eventProgress,
  formatDate,
  formatTime,
  overdueTasks,
  partitionEvents,
  systemClock,
  useClock,
} from './calendarModel'
import './calendar.css'

export type CalendarViewProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  /** Returns "You" for projection.actor and display names for other members. */
  memberName: (publicIdentity: string) => string
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  /** Injectable clock for tests; defaults to the system clock. */
  now?: () => Date
}

const CLOCK_INTERVAL_MS = 60_000

const nextLabel = (days: number) => (days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`)

/**
 * Supply Calendar (master spec §14–19): a readiness and preparation system, not just a list. Dates
 * are entered by hand every year; each event carries its preparation checklist, due relative to
 * the date, plus the stock readiness of the bundles it issues.
 */
export function CalendarView({ projection, controller, can, memberName, onProjection, notify, now = systemClock }: CalendarViewProps): JSX.Element {
  const id = useId()
  const current = useClock(now, CLOCK_INTERVAL_MS)
  const canWrite = can('calendar.write')
  const [adding, setAdding] = useState<SupplyEventKind | null>(null)
  const [openEventId, setOpenEventId] = useState<string>()
  const [showCancelled, setShowCancelled] = useState(false)
  const closeAdd = useCallback(() => setAdding(null), [])
  const closeEvent = useCallback(() => setOpenEventId(undefined), [])

  const { upcoming, past, cancelled } = partitionEvents(projection.calendar, current)
  const openEvent = projection.calendar.find(event => event.calendarEventId === openEventId)
  const next = upcoming.find(event => daysUntil(event.startsAt, current) >= 0)
  const openTasks = upcoming.reduce((sum, event) => sum + event.tasks.filter(task => !task.completed).length, 0)
  const overdue = upcoming.reduce((sum, event) => sum + overdueTasks(event, current).length, 0)

  const card = (event: CalendarEventProjection) => (
    <li key={event.calendarEventId}>
      <EventCard event={event} current={current} open={() => setOpenEventId(event.calendarEventId)} />
    </li>
  )

  return (
    <div className="content calendar-view">
      <section className="page-intro calendar-intro">
        <div>
          <p className="eyebrow">SUPPLY READINESS &amp; PREPARATION</p>
          <h2>Supply Calendar</h2>
          <p>Dates change every year, so they are entered by hand. Each event brings its preparation checklist, due relative to its date.</p>
        </div>
        {canWrite && (
          <button type="button" className="gold-button calendar-add" onClick={() => setAdding('NCO')}>
            <CalendarPlus aria-hidden="true" /> Add supply event
          </button>
        )}
      </section>

      <div className="summary-grid calendar-summary">
        <Summary label="Upcoming" value={String(upcoming.length)} detail="Active events, this week and ahead" />
        <Summary
          label="Next event"
          value={next ? nextLabel(daysUntil(next.startsAt, current)) : '—'}
          detail={next ? next.title : 'Nothing scheduled'}
          accent={Boolean(next)}
        />
        <Summary label="Open tasks" value={String(openTasks)} detail={overdue ? `${overdue} overdue` : 'None overdue'} accent={overdue > 0} />
      </div>

      <section className="calendar-block" aria-labelledby={`${id}-upcoming`}>
        <h3 id={`${id}-upcoming`}>Upcoming</h3>
        {upcoming.length ? (
          <ol className="calendar-list">{upcoming.map(card)}</ol>
        ) : (
          <div className="calendar-empty">
            <CalendarPlus aria-hidden="true" />
            <strong>{projection.calendar.length ? 'No upcoming supply events' : 'No supply events scheduled'}</strong>
            <p>
              A.R.G.U.S. never guesses dates. When your unit sets this year’s NCO, BLT, AMI, Military Ball and End-of-Year dates,
              add each one — it arrives with its preparation checklist.
            </p>
            {canWrite ? (
              <div className="calendar-quick-start" role="group" aria-label="Start from a template">
                {SUPPLY_EVENT_TEMPLATES.map(template => (
                  <button key={template.kind} type="button" className="secondary-button" onClick={() => setAdding(template.kind)}>
                    {KIND_LABEL[template.kind]}
                  </button>
                ))}
              </div>
            ) : (
              <p className="calendar-muted">A supply officer adds events; they appear here on every device.</p>
            )}
          </div>
        )}
      </section>

      {past.length > 0 && (
        <details className="calendar-block calendar-past">
          <summary>
            <ChevronRight className="calendar-past-chevron" aria-hidden="true" />
            Past events <span>{past.length}</span>
          </summary>
          <ol className="calendar-list">{past.map(card)}</ol>
        </details>
      )}

      {cancelled.length > 0 && (
        <section className="calendar-block calendar-cancelled" aria-label="Cancelled events">
          <button type="button" className="text-button" aria-expanded={showCancelled} onClick={() => setShowCancelled(value => !value)}>
            {showCancelled ? 'Hide' : 'Show'} cancelled events ({cancelled.length})
          </button>
          {showCancelled && <ol className="calendar-list">{cancelled.map(card)}</ol>}
        </section>
      )}

      {adding && (
        <AddEventDrawer
          projection={projection}
          controller={controller}
          initialKind={adding}
          close={closeAdd}
          onCreated={(next, message) => {
            onProjection(next)
            notify(message)
            setAdding(null)
          }}
        />
      )}
      {openEvent && (
        <EventDrawer
          event={openEvent}
          projection={projection}
          controller={controller}
          canWrite={canWrite}
          canRevealNames={can('cadets.read') || can('cadets.manage')}
          memberName={memberName}
          now={current}
          onProjection={onProjection}
          notify={notify}
          close={closeEvent}
        />
      )}
    </div>
  )
}

function EventCard({ event, current, open }: { event: CalendarEventProjection; current: Date; open: () => void }) {
  const progress = eventProgress(event)
  const days = daysUntil(event.startsAt, current)
  const leaf = dateBlock(event.startsAt)
  const overdue = event.active ? overdueTasks(event, current).length : 0
  return (
    <button type="button" className={event.active ? 'calendar-card' : 'calendar-card cancelled'} onClick={open}>
      <span className="calendar-leaf" aria-hidden="true">
        <small>{leaf.month}</small>
        <b>{leaf.day}</b>
      </span>
      <span className="calendar-card-body">
        <span className="calendar-card-tags">
          <em className="calendar-kind">{KIND_LABEL[event.kind]}</em>
          {!event.active && <em className="status-badge">Cancelled</em>}
          {overdue > 0 && <em className="status-badge danger">{overdue} overdue</em>}
        </span>
        <strong>{event.title}</strong>
        <small>
          {formatDate(event.startsAt)} · {formatTime(event.startsAt)}
        </small>
      </span>
      <span className="calendar-card-status">
        <b className={days < 0 ? 'calendar-countdown past' : 'calendar-countdown'}>{countdownLabel(days)}</b>
        <span className="calendar-meter" aria-hidden="true">
          <span style={{ width: `${progress.percent}%` }} />
        </span>
        <small>{progress.total ? `${progress.percent}% ready · ${progress.done}/${progress.total} tasks` : 'No tasks yet'}</small>
      </span>
      <ChevronRight className="calendar-card-chevron" aria-hidden="true" />
    </button>
  )
}
