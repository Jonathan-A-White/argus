import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { CadetGender, CalendarEventProjection, NsLevel } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { upcomingEvents } from '../../stage3/readiness'
import { cadetMatches } from '../cadets/cadetDisplay'

/**
 * Pure helpers for an event's attendees (master spec §14–16, §18). Cadets are identified by the
 * opaque cadet ID; names are only ever searched here, never returned for display.
 */

type Cadet = ArgusAppProjection['cadets'][number]

export const NS_LEVELS: readonly NsLevel[] = ['NS1', 'NS2', 'NS3', 'NS4']
export const GENDERS: readonly CadetGender[] = ['Male', 'Female']

export type AttendeeFilter = { level: NsLevel | 'ALL'; gender: CadetGender | 'ALL' }
export const NO_FILTER: AttendeeFilter = { level: 'ALL', gender: 'ALL' }

/** One attendee. `cadet` is missing when the cadet record has not reached this device yet. */
export type AttendeeRow = { cadetId: string; code: string; cadet?: Cadet }

export const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code)

export function attendeeRows(event: Pick<CalendarEventProjection, 'cadetIds'>, cadets: Cadet[]): AttendeeRow[] {
  const index = new Map(cadets.map(cadet => [cadet.cadetId, cadet]))
  return event.cadetIds
    .map(cadetId => {
      const cadet = index.get(cadetId)
      return { cadetId, code: cadetLabel(cadet ?? { cadetId }), ...(cadet ? { cadet } : {}) }
    })
    .sort(byCode)
}

export const matchesFilter = (cadet: Pick<Cadet, 'nsLevel' | 'gender'>, filter: AttendeeFilter) =>
  (filter.level === 'ALL' || cadet.nsLevel === filter.level) && (filter.gender === 'ALL' || cadet.gender === filter.gender)

/** Active cadets not yet attending that match the filters and the search (cadet ID, NS level or name), in cadet-ID order. */
export function candidates(event: Pick<CalendarEventProjection, 'cadetIds'>, cadets: Cadet[], filter: AttendeeFilter, query = '') {
  const attending = new Set(event.cadetIds)
  return cadets
    .filter(cadet => cadet.status === 'ACTIVE' && !attending.has(cadet.cadetId) && matchesFilter(cadet, filter) && cadetMatches(cadet, query))
    .map(cadet => ({ cadetId: cadet.cadetId, code: cadetLabel(cadet), cadet }))
    .sort(byCode)
}

/** Cadet IDs the quick actions would add: every active NS1 (the NCO class) and every active cadet, not yet attending. */
export function quickAdds(event: Pick<CalendarEventProjection, 'cadetIds'>, cadets: Cadet[]) {
  const pending = candidates(event, cadets, NO_FILTER)
  return { ns1: pending.filter(row => row.cadet.nsLevel === 'NS1').map(row => row.cadetId), active: pending.map(row => row.cadetId) }
}

export type AttendeeSummary = { total: number; gender: Record<CadetGender, number>; level: Record<NsLevel, number> }

export function attendeeSummary(rows: AttendeeRow[]): AttendeeSummary {
  const summary: AttendeeSummary = { total: rows.length, gender: { Male: 0, Female: 0 }, level: { NS1: 0, NS2: 0, NS3: 0, NS4: 0 } }
  for (const { cadet } of rows) {
    if (!cadet) continue
    summary.gender[cadet.gender]++
    summary.level[cadet.nsLevel]++
  }
  return summary
}

/** Events a roster import can add its cadets to: active ones, soonest upcoming first, then older ones newest first. */
export function linkableEvents(calendar: CalendarEventProjection[], now: Date) {
  const upcoming = upcomingEvents({ calendar }, now)
  const current = new Set(upcoming.map(event => event.calendarEventId))
  const older = calendar.filter(event => event.active && !current.has(event.calendarEventId)).sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1))
  return [...upcoming, ...older]
}
