import type { CadetProjection, NsLevel, RolloverRecord } from '../../distributed/types'
import { plural } from '../../plural'

export const NS_LEVELS: NsLevel[] = ['NS1', 'NS2', 'NS3', 'NS4']
export const NEXT_LEVEL_LABEL: Record<NsLevel, string> = { NS1: 'NS2', NS2: 'NS3', NS3: 'NS4', NS4: 'Graduated (inactive)' }

const SCHOOL_YEAR = /^(\d{4})-(\d{4})$/

export const schoolYearFor = (startYear: number) => `${startYear}-${startYear + 1}`

/** Month (0-based) from which the school year that started this calendar year is well under way: November. */
export const SCHOOL_YEAR_UNDER_WAY_MONTH = 10

/**
 * The school year the cadets are moving into (the panel's hint). Rollovers happen over the summer
 * and sometimes in the first weeks of the new year, so through October it is the year starting this
 * calendar year (2026-2027 from January to October 2026); from November, once that year is well
 * under way, it is the following one. Always moved forward past any year already rolled over, so a
 * unit that rolled over in June sees 2027-2028 in September.
 */
export function defaultSchoolYear(now: Date, rollovers: Pick<RolloverRecord, 'schoolYear'>[]) {
  const done = new Set(rollovers.map(record => record.schoolYear))
  let year = now.getFullYear() + (now.getMonth() >= SCHOOL_YEAR_UNDER_WAY_MONTH ? 1 : 0)
  while (done.has(schoolYearFor(year))) year++
  return schoolYearFor(year)
}

export function schoolYearError(value: string, rollovers: Pick<RolloverRecord, 'schoolYear'>[]) {
  const match = SCHOOL_YEAR.exec(value)
  if (!match) return 'School year looks like 2026-2027.'
  if (Number(match[2]) !== Number(match[1]) + 1) return 'The second year must follow the first, e.g. 2026-2027.'
  if (rollovers.some(record => record.schoolYear === value)) return `Rollover for ${value} is already complete.`
  return ''
}

/** What completeAnnualRollover will do to the current roster (it only touches ACTIVE cadets). */
export function rolloverPreview(cadets: Pick<CadetProjection, 'cadetId' | 'cadetCode' | 'nsLevel' | 'status' | 'currentProperty'>[]) {
  const active = cadets.filter(cadet => cadet.status === 'ACTIVE')
  const byLevel = Object.fromEntries(NS_LEVELS.map(level => [level, active.filter(cadet => cadet.nsLevel === level).length])) as Record<NsLevel, number>
  const graduatingWithProperty = active.filter(cadet => cadet.nsLevel === 'NS4' && cadet.currentProperty.some(line => line.quantity > 0))
  return { active: active.length, byLevel, advancing: byLevel.NS1 + byLevel.NS2 + byLevel.NS3, graduating: byLevel.NS4, graduatingWithProperty }
}

export { plural }
