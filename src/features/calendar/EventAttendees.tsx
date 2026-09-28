import { useId, useState, type JSX } from 'react'
import { Eye, EyeOff, UserPlus, Users, X } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { CalendarEventProjection } from '../../distributed/types'
import { InlineError } from './InlineError'
import { GENDERS, NO_FILTER, NS_LEVELS, attendeeRows, attendeeSummary, candidates, matchesFilter, quickAdds, type AttendeeFilter, type AttendeeSummary } from './attendeesModel'
import { useMutation } from './useMutation'
import './attendees.css'

export type EventAttendeesProps = {
  event: CalendarEventProjection
  projection: ArgusAppProjection
  controller: DistributedAppController
  /** calendar.write on an active event: add and remove attendees. */
  canWrite: boolean
  /** Names are encrypted and hidden until the operator explicitly shows them (never persisted). */
  canRevealNames: boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
}

/** How many candidates the chooser lists at once; search or filter to reach the rest. */
export const MAX_LISTED_CANDIDATES = 60

const cadets = (count: number) => `${count} cadet${count === 1 ? '' : 's'}`

function summaryLine(summary: AttendeeSummary) {
  const parts = [cadets(summary.total)]
  for (const gender of GENDERS) if (summary.gender[gender]) parts.push(`${summary.gender[gender]} ${gender.toLowerCase()}`)
  for (const level of NS_LEVELS) if (summary.level[level]) parts.push(`${level} ${summary.level[level]}`)
  return parts.join(' · ')
}

/**
 * The cadets associated with a supply event (master spec §14–16, §18): the NCO class, the BLT
 * roster, Military Ball attendees. Attendees are a shared set, so two officers adding cadets from
 * different phones both land. Cadets are listed by cadet ID; names stay hidden unless revealed.
 */
export function EventAttendees({ event, projection, controller, canWrite, canRevealNames, onProjection, notify }: EventAttendeesProps): JSX.Element {
  const id = useId()
  const [filter, setFilter] = useState<AttendeeFilter>(NO_FILTER)
  const [namesShown, setNamesShown] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<string>()
  const { pending, error, run } = useMutation({ onProjection, notify })
  const rows = attendeeRows(event, projection.cadets)
  const summary = attendeeSummary(rows)
  const shown = rows.filter(row => !row.cadet || matchesFilter(row.cadet, filter))
  const filtered = filter.level !== 'ALL' || filter.gender !== 'ALL'
  const anyNames = projection.cadets.some(cadet => cadet.fullName)
  const revealed = canRevealNames && namesShown

  const add = (cadetIds: string[], message: string) => run(() => controller.addCalendarAttendees(event.calendarEventId, cadetIds), message)
  const remove = async (cadetId: string, code: string) => {
    setPendingRemoval(cadetId)
    await run(() => controller.removeCalendarAttendees(event.calendarEventId, [cadetId]), `${code} removed from ${event.title}.`)
    setPendingRemoval(undefined)
  }

  return (
    <section className="calendar-section calendar-attendees" aria-labelledby={`${id}-heading`}>
      <div className="calendar-section-head">
        <h3 id={`${id}-heading`}>Attendees</h3>
        {canRevealNames && anyNames && (rows.length > 0 || choosing) && (
          <button type="button" className="calendar-chip-button" aria-pressed={namesShown} onClick={() => setNamesShown(value => !value)}>
            {namesShown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {namesShown ? 'Hide names' : 'Show names'}
          </button>
        )}
      </div>
      <InlineError message={error} />
      {rows.length ? (
        <p className="calendar-attendee-summary">
          <Users aria-hidden="true" />
          {summaryLine(summary)}
        </p>
      ) : (
        <p className="calendar-muted">No cadets are linked to this event yet.{canWrite ? ' Add the roster below.' : ''}</p>
      )}

      {(rows.length > 0 || choosing) && <AttendeeFilters filter={filter} setFilter={setFilter} />}

      {rows.length > 0 && (
        <>
          {shown.length ? (
            <ul className="calendar-attendee-list" aria-label="Attending cadets">
              {shown.map(row => (
                <li key={row.cadetId}>
                  <span className="calendar-attendee-id">
                    <strong>{row.code}</strong>
                    <small>
                      {row.cadet ? `${row.cadet.nsLevel} · ${row.cadet.gender}${row.cadet.status === 'ACTIVE' ? '' : ' · Inactive'}` : 'Record not on this device yet'}
                    </small>
                    {revealed && row.cadet?.fullName && <em className="calendar-attendee-name">{row.cadet.fullName}</em>}
                  </span>
                  {canWrite && (
                    <button
                      type="button"
                      className="calendar-icon-button"
                      aria-label={`Remove ${row.code}`}
                      disabled={pending || pendingRemoval === row.cadetId}
                      onClick={() => void remove(row.cadetId, row.code)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="calendar-muted">No attendees match these filters.</p>
          )}
          {filtered && shown.length > 0 && <p className="calendar-muted">Showing {shown.length} of {rows.length}.</p>}
        </>
      )}

      {canWrite && (
        <AddAttendees
          event={event}
          projection={projection}
          filter={filter}
          revealed={revealed}
          choosing={choosing}
          setChoosing={setChoosing}
          pending={pending}
          add={add}
        />
      )}
    </section>
  )
}

function AttendeeFilters({ filter, setFilter }: { filter: AttendeeFilter; setFilter: (filter: AttendeeFilter) => void }) {
  return (
    <div className="calendar-attendee-filters">
      <div className="calendar-segments" role="group" aria-label="Filter by NS level">
        {(['ALL', ...NS_LEVELS] as const).map(level => (
          <button key={level} type="button" aria-pressed={filter.level === level} onClick={() => setFilter({ ...filter, level })}>
            {level === 'ALL' ? 'All levels' : level}
          </button>
        ))}
      </div>
      <div className="calendar-segments" role="group" aria-label="Filter by gender">
        {(['ALL', ...GENDERS] as const).map(gender => (
          <button key={gender} type="button" aria-pressed={filter.gender === gender} onClick={() => setFilter({ ...filter, gender })}>
            {gender === 'ALL' ? 'Any gender' : gender}
          </button>
        ))}
      </div>
    </div>
  )
}

type AddAttendeesProps = {
  event: CalendarEventProjection
  projection: ArgusAppProjection
  filter: AttendeeFilter
  revealed: boolean
  choosing: boolean
  setChoosing: (value: boolean) => void
  pending: boolean
  add: (cadetIds: string[], message: string) => Promise<boolean>
}

function AddAttendees({ event, projection, filter, revealed, choosing, setChoosing, pending, add }: AddAttendeesProps) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const quick = quickAdds(event, projection.cadets)
  const matches = candidates(event, projection.cadets, filter, query)
  const listed = matches.slice(0, MAX_LISTED_CANDIDATES)
  // A selection survives filter changes, but only cadets still available can be added.
  const available = new Set(quick.active)
  const chosen = [...selected].filter(cadetId => available.has(cadetId))
  const allListedChosen = listed.length > 0 && listed.every(row => selected.has(row.cadetId))

  const toggle = (cadetId: string) =>
    setSelected(current => {
      const next = new Set(current)
      if (next.has(cadetId)) next.delete(cadetId)
      else next.add(cadetId)
      return next
    })
  const toggleListed = () =>
    setSelected(current => {
      const next = new Set(current)
      for (const row of listed) {
        if (allListedChosen) next.delete(row.cadetId)
        else next.add(row.cadetId)
      }
      return next
    })
  const addChosen = async () => {
    if (await add(chosen, `Added ${cadets(chosen.length)} to ${event.title}.`)) setSelected(new Set())
  }

  return (
    <div className="calendar-attendee-add">
      <div className="calendar-quick-add" role="group" aria-label="Quick add attendees">
        {event.kind === 'NCO' && (
          <button type="button" className="secondary-button" disabled={pending || !quick.ns1.length} onClick={() => void add(quick.ns1, `Added ${cadets(quick.ns1.length)} (all active NS1) to ${event.title}.`)}>
            <UserPlus aria-hidden="true" /> Add all active NS1 ({quick.ns1.length})
          </button>
        )}
        <button type="button" className="secondary-button" disabled={pending || !quick.active.length} onClick={() => void add(quick.active, `Added ${cadets(quick.active.length)} to ${event.title}.`)}>
          <Users aria-hidden="true" /> Add all active cadets ({quick.active.length})
        </button>
        <button type="button" className="secondary-button" aria-expanded={choosing} aria-controls={`${id}-chooser`} onClick={() => setChoosing(!choosing)}>
          {choosing ? 'Done choosing' : 'Choose cadets'}
        </button>
      </div>

      {choosing && (
        <div className="calendar-chooser" id={`${id}-chooser`}>
          <label className="field">
            Find cadets to add
            <input type="search" value={query} placeholder="Cadet ID, NS level or name" autoComplete="off" onChange={change => setQuery(change.target.value)} />
          </label>
          {listed.length ? (
            <>
              <div className="calendar-chooser-head">
                <span>
                  {matches.length} available{matches.length > listed.length ? ` · showing the first ${listed.length}` : ''}
                </span>
                <button type="button" className="calendar-chip-button" onClick={toggleListed}>
                  {allListedChosen ? 'Clear these' : `Select these ${listed.length}`}
                </button>
              </div>
              <ul className="calendar-candidates" aria-label="Cadets you can add">
                {listed.map(row => (
                  <li key={row.cadetId}>
                    <label>
                      <input type="checkbox" checked={selected.has(row.cadetId)} onChange={() => toggle(row.cadetId)} />
                      <span className="calendar-attendee-id">
                        <strong>{row.code}</strong>
                        <small>
                          {row.cadet.nsLevel} · {row.cadet.gender}
                        </small>
                        {revealed && row.cadet.fullName && <em className="calendar-attendee-name">{row.cadet.fullName}</em>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="calendar-muted">{quick.active.length ? 'No available cadets match. Change the search or filters.' : 'Every active cadet is already attending.'}</p>
          )}
          <button type="button" className="primary-button calendar-inline-action" disabled={pending || !chosen.length} onClick={() => void addChosen()}>
            {pending ? 'Adding…' : `Add ${cadets(chosen.length)}`}
          </button>
        </div>
      )}
    </div>
  )
}
