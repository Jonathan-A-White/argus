import type { SupplyEventKind } from '../distributed/types'

/**
 * Supply event templates from the master specification (§14–19). Dates change every year, so an
 * event is only a template until someone enters its date; tasks are due relative to that date
 * (negative = days before). Bundles named here are the ones the event usually issues.
 */
export type SupplyEventTemplate = { kind: SupplyEventKind; title: string; description: string; bundleIds: string[]; tasks: Array<{ title: string; dueOffsetDays: number }> }
export const SUPPLY_EVENT_TEMPLATES: SupplyEventTemplate[] = [
  { kind: 'NCO', title: 'New Cadet Orientation', description: 'Issue incoming NS1 cadets their PT and gender-appropriate NSU bundles.', bundleIds: ['bundle-pt', 'bundle-male-nsu', 'bundle-female-nsu'], tasks: [
    { title: 'Verify the incoming NS1 roster', dueOffsetDays: -21 },
    { title: 'Verify inventory availability for PT and NSU sizes', dueOffsetDays: -14 },
    { title: 'Prepare PT gear', dueOffsetDays: -10 },
    { title: 'Prepare NSU gear', dueOffsetDays: -7 },
    { title: 'Issue PT bundles', dueOffsetDays: 0 },
    { title: 'Issue gender-appropriate NSU bundles', dueOffsetDays: 0 },
    { title: 'Verify sizes and record shortages as Still Needed', dueOffsetDays: 2 },
    { title: 'Reconcile inventory after the mass issue', dueOffsetDays: 7 },
    { title: 'Confirm every new cadet record is complete', dueOffsetDays: 7 },
  ] },
  { kind: 'BLT', title: 'Basic Leadership Training', description: 'Issue participating cadets the BLT bundle.', bundleIds: ['bundle-blt'], tasks: [
    { title: 'Confirm the BLT attendee roster', dueOffsetDays: -21 },
    { title: 'Check BLT bundle stock and required sizes', dueOffsetDays: -14 },
    { title: 'Resolve shortages', dueOffsetDays: -10 },
    { title: 'Issue BLT bundles', dueOffsetDays: -3 },
    { title: 'Post-event returns and reconciliation', dueOffsetDays: 3 },
  ] },
  { kind: 'AMI', title: 'Area Manager Inspection', description: 'Complete count, current records, discrepancies resolved, readiness report.', bundleIds: [], tasks: [
    { title: 'Complete a physical count of Supply', dueOffsetDays: -14 },
    { title: 'Review cadet property records', dueOffsetDays: -10 },
    { title: 'Resolve open conflicts and corrections', dueOffsetDays: -7 },
    { title: 'Review Still Needed', dueOffsetDays: -7 },
    { title: 'Check sync and audit health', dueOffsetDays: -3 },
    { title: 'Prepare the final readiness report', dueOffsetDays: -1 },
  ] },
  { kind: 'MILITARY_BALL', title: 'Military Ball', description: 'Issue SDB bundles to attending cadets.', bundleIds: ['bundle-male-sdb', 'bundle-female-sdb'], tasks: [
    { title: 'Identify attending cadets', dueOffsetDays: -30 },
    { title: 'Determine SDB bundles and sizes', dueOffsetDays: -21 },
    { title: 'Check SDB stock and shortages', dueOffsetDays: -21 },
    { title: 'Issue SDB bundles', dueOffsetDays: -7 },
    { title: 'Collect SDB returns', dueOffsetDays: 7 },
  ] },
  { kind: 'END_OF_YEAR', title: 'End-of-Year Count', description: 'Full inventory and property reconciliation before rollover.', bundleIds: [], tasks: [
    { title: 'Complete a full physical inventory', dueOffsetDays: -14 },
    { title: 'Reconcile cadet property', dueOffsetDays: -10 },
    { title: 'Review discrepancies', dueOffsetDays: -7 },
    { title: 'Collect items from return-pending cadets', dueOffsetDays: -7 },
    { title: 'Review missing inventory', dueOffsetDays: -5 },
    { title: 'Review the audit trail', dueOffsetDays: -3 },
    { title: 'Confirm school-year rollover readiness', dueOffsetDays: 0 },
  ] },
]
export const templateFor = (kind: SupplyEventKind) => SUPPLY_EVENT_TEMPLATES.find(template => template.kind === kind)
export const SUPPLY_EVENT_KINDS: SupplyEventKind[] = ['NCO', 'BLT', 'AMI', 'MILITARY_BALL', 'END_OF_YEAR', 'CUSTOM']
export const taskDueDate = (startsAt: string, dueOffsetDays: number) => new Date(new Date(startsAt).getTime() + dueOffsetDays * 86_400_000).toISOString()
const localMidnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
/** Whole local calendar days from `now` until `when` (negative = in the past); the same count the calendar shows. */
export const calendarDaysUntil = (when: string | Date, now: Date) => Math.round((localMidnight(new Date(when)) - localMidnight(now)) / 86_400_000)
