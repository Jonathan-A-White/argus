import { describe, expect, it } from 'vitest'
import { DistributedAppController } from '../distributed/appIntegration'
import { alerts, type SupplyAlert } from '../stage3/readiness'
import {
  DAY,
  HOUR,
  MINUTE,
  closedAppSummary,
  decideNotifications,
  emptyHistory,
  fingerprint,
  markOpened,
  notificationCandidates,
  planDeviceNotifications,
  type NotificationCandidate,
  type NotificationHistory,
} from './policy'

/** Local 27 Sep 2026, 14:30. */
const NOW = new Date(2026, 8, 27, 14, 30).getTime()
const NAME = 'Jordan Rivera'
const CODE = 'C-7K4M'

const candidate = (overrides: Partial<NotificationCandidate> = {}): NotificationCandidate => ({
  id: 'conflicts',
  alertIds: ['conflicts'],
  severity: 'critical',
  fingerprint: 'aaaa0001',
  title: 'A.R.G.U.S.: conflicts need a decision',
  body: 'Open A.R.G.U.S.',
  target: { tab: 'more', panel: 'conflicts' },
  ...overrides,
})

/** Runs the policy over a timeline, threading history through, and returns the ids notified at each step. */
function timeline(start: NotificationHistory, steps: Array<{ at: number; candidates: NotificationCandidate[]; visible?: boolean; acknowledged?: string[] }>) {
  let history = start
  return steps.map(step => {
    const decision = decideNotifications({ candidates: step.candidates, now: step.at, visible: step.visible ?? false, history, acknowledged: new Set(step.acknowledged ?? []) })
    history = decision.history
    return { notified: decision.notify.map(item => item.id), withdraw: decision.withdraw, history }
  })
}

describe('device notification policy', () => {
  it('never notifies while A.R.G.U.S. is on screen, and records that the person has seen it', () => {
    const decision = decideNotifications({ candidates: [candidate()], now: NOW, visible: true, history: emptyHistory() })
    expect(decision.notify).toEqual([])
    expect(decision.history.lastOpenedAt).toBe(NOW)
    expect(decision.history.raised.conflicts).toEqual({ fingerprint: 'aaaa0001', raisedAt: NOW })
  })

  it('notifies a condition that arose while hidden, at most once per alert and condition every 24 hours', () => {
    const opened = { ...emptyHistory(), lastOpenedAt: NOW - HOUR }
    const steps = timeline(opened, [
      { at: NOW, candidates: [candidate()] },
      { at: NOW + 5 * MINUTE, candidates: [candidate()] },
      { at: NOW + 23 * HOUR, candidates: [candidate()] },
      { at: NOW + DAY, candidates: [candidate()] },
    ])
    expect(steps.map(step => step.notified)).toEqual([['conflicts'], [], [], ['conflicts']])
  })

  it('stays quiet about anything that was already there when the person last looked', () => {
    const steps = timeline(emptyHistory(), [
      { at: NOW, candidates: [candidate()], visible: true },
      { at: NOW + HOUR, candidates: [candidate()] },
      { at: NOW + 3 * DAY, candidates: [candidate()] },
    ])
    expect(steps.map(step => step.notified)).toEqual([[], [], []])
  })

  it('re-notifies when the condition fingerprint changes, but not sooner than an hour after the last one', () => {
    const opened = { ...emptyHistory(), lastOpenedAt: NOW - HOUR }
    const steps = timeline(opened, [
      { at: NOW, candidates: [candidate()] },
      { at: NOW + 30 * MINUTE, candidates: [candidate({ fingerprint: 'bbbb0002' })] },
      { at: NOW + 61 * MINUTE, candidates: [candidate({ fingerprint: 'bbbb0002' })] },
      { at: NOW + 3 * HOUR, candidates: [candidate({ fingerprint: 'bbbb0002' })] },
      { at: NOW + 4 * HOUR, candidates: [candidate({ fingerprint: 'cccc0003' })] },
    ])
    expect(steps.map(step => step.notified)).toEqual([['conflicts'], [], ['conflicts'], [], ['conflicts']])
  })

  it('caps notifications at three an hour across all alerts, most urgent first', () => {
    const many = [
      candidate({ id: 'w', alertIds: ['w'], severity: 'warning', dueAt: NOW + HOUR }),
      ...['a', 'b', 'c', 'd'].map(id => candidate({ id, alertIds: [id] })),
    ]
    const steps = timeline({ ...emptyHistory(), lastOpenedAt: NOW - HOUR }, [
      { at: NOW, candidates: many },
      { at: NOW + 59 * MINUTE, candidates: many },
      { at: NOW + 61 * MINUTE, candidates: many },
    ])
    expect(steps[0].notified).toEqual(['a', 'b', 'c'])
    expect(steps[1].notified).toEqual([])
    expect(steps[2].notified).toEqual(['d', 'w'])
  })

  it('only escalates critical alerts, and warnings whose deadline is within 24 hours', () => {
    const history = { ...emptyHistory(), lastOpenedAt: NOW - HOUR }
    const decide = (item: NotificationCandidate, at = NOW) => decideNotifications({ candidates: [item], now: at, visible: false, history }).notify.length
    expect(decide(candidate({ severity: 'info' }))).toBe(0)
    expect(decide(candidate({ severity: 'warning' }))).toBe(0)
    expect(decide(candidate({ severity: 'warning', dueAt: NOW + 25 * HOUR }))).toBe(0)
    expect(decide(candidate({ severity: 'warning', dueAt: NOW + 23 * HOUR }))).toBe(1)
    expect(decide(candidate({ severity: 'critical' }))).toBe(1)
  })

  it('notifies a warning when its deadline comes within 24 hours, even if the warning itself was seen earlier', () => {
    const warning = candidate({ id: 'deadline', alertIds: ['deadline'], severity: 'warning', dueAt: NOW + 2 * DAY })
    const steps = timeline(emptyHistory(), [
      { at: NOW, candidates: [warning], visible: true },
      { at: NOW + 12 * HOUR, candidates: [warning] },
      { at: NOW + 25 * HOUR, candidates: [warning] },
    ])
    expect(steps.map(step => step.notified)).toEqual([[], [], ['deadline']])
  })

  it('stops for an acknowledged alert and withdraws its notification', () => {
    const steps = timeline({ ...emptyHistory(), lastOpenedAt: NOW - HOUR }, [
      { at: NOW, candidates: [candidate()] },
      { at: NOW + 2 * HOUR, candidates: [candidate({ fingerprint: 'bbbb0002' })], acknowledged: ['conflicts'] },
      { at: NOW + 2 * DAY, candidates: [candidate({ fingerprint: 'cccc0003' })], acknowledged: ['conflicts'] },
    ])
    expect(steps.map(step => step.notified)).toEqual([['conflicts'], [], []])
    expect(steps[1].withdraw).toEqual(['conflicts'])
  })

  it('stops for a resolved alert, withdraws it, and does not repeat it if it flaps back within a day', () => {
    const steps = timeline({ ...emptyHistory(), lastOpenedAt: NOW - HOUR }, [
      { at: NOW, candidates: [candidate()] },
      { at: NOW + 2 * HOUR, candidates: [] },
      { at: NOW + 3 * HOUR, candidates: [candidate()] },
    ])
    expect(steps.map(step => step.notified)).toEqual([['conflicts'], [], []])
    expect(steps[1].withdraw).toEqual(['conflicts'])
    expect(steps[1].history.raised).toEqual({})
  })

  it('stops once the person opens A.R.G.U.S. after the alert was raised, and clears what is showing', () => {
    const steps = timeline({ ...emptyHistory(), lastOpenedAt: NOW - HOUR }, [
      { at: NOW, candidates: [candidate()] },
      { at: NOW + HOUR, candidates: [candidate()], visible: true },
      { at: NOW + 2 * DAY, candidates: [candidate()] },
    ])
    expect(steps.map(step => step.notified)).toEqual([['conflicts'], [], []])
    expect(steps[1].withdraw).toEqual(['conflicts'])

    // Opening from the notification itself has the same effect.
    const clicked = markOpened(steps[0].history, NOW + 10 * MINUTE)
    expect(decideNotifications({ candidates: [candidate()], now: NOW + 2 * DAY, visible: false, history: clicked }).notify).toEqual([])
  })

  it('fingerprints are short hashes, so the stored history holds no alert text', () => {
    expect(fingerprint(`critical|Overdue: call ${NAME}`)).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
  })
})

/** A cadet with a name and code, an AMI in two days with overdue preparation, and a custom event whose free text names the cadet. */
async function busyUnit() {
  const controller = new DistributedAppController()
  await controller.initialize()
  await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: NAME, cadetCode: CODE })
  await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(NOW + 2 * DAY).toISOString() })
  return controller.createCalendarEvent({ kind: 'CUSTOM', title: `Fitting for ${NAME}`, startsAt: new Date(NOW + 5 * DAY).toISOString(), tasks: [{ title: `Call ${NAME} (${CODE})`, dueOffsetDays: -6 }] })
}

describe('notification wording and grouping', () => {
  it('groups an event’s task alerts into one generic notification: “AMI in 2 days — 5 preparation tasks overdue”', async () => {
    const projection = await busyUnit()
    const list = alerts(projection, {}, new Date(NOW))
    const candidates = notificationCandidates(list, projection, NOW)
    const ami = projection.calendar.find(event => event.kind === 'AMI')!
    const group = candidates.find(item => item.id === `event-${ami.calendarEventId}`)!
    expect(group).toMatchObject({ severity: 'critical', title: 'A.R.G.U.S.: AMI in 2 days — 5 preparation tasks overdue', target: { tab: 'calendar' } })
    expect(group.body).toMatch(/^1 preparation task due within a day( · \d+ readiness categor(y|ies) below 100%)?\. Open A\.R\.G\.U\.S\. to see the Supply Calendar\.$/)
    // The six task alerts, plus the event's own and AMI-category alerts: one notification for the whole event.
    const taskIds = list.filter(alert => ami.tasks.some(task => alert.id.includes(task.taskId))).map(alert => alert.id)
    expect(taskIds).toHaveLength(6)
    expect(group.alertIds).toEqual(expect.arrayContaining(taskIds))
    expect(group.alertIds.every(id => taskIds.includes(id) || id === `event-${ami.calendarEventId}` || id.startsWith(`ami-${ami.calendarEventId}-`))).toBe(true)
    const custom = candidates.find(item => item.id.startsWith('event-') && item !== group)!
    expect(custom.title).toBe('A.R.G.U.S.: A supply event in 5 days — 1 preparation task overdue')
  })

  it('never puts cadet names, cadet IDs or free text into a notification, even for alert kinds it does not know', async () => {
    const projection = await busyUnit()
    const unknown: SupplyAlert[] = [
      { id: 'overdue-return-cadet_1', severity: 'critical', title: `${CODE} has an overdue return`, detail: `${NAME} · Garrison Cap`, target: { tab: 'cadets' }, fingerprint: 'test' },
      { id: 'revocation', severity: 'critical', title: `${NAME}'s access was removed`, detail: CODE, target: { tab: 'more', panel: 'diagnostics' }, fingerprint: 'test' },
    ]
    const list = [...alerts(projection, { needsFunding: true, queued: 4 }, new Date(NOW)), ...unknown]
    expect(list.some(alert => `${alert.title} ${alert.detail}`.includes(NAME))).toBe(true)
    const candidates = notificationCandidates(list, projection, NOW)
    const shown = candidates.map(item => `${item.title} ${item.body}`).join('\n')
    for (const secret of [NAME, 'Jordan', 'Rivera', CODE, 'Fitting', 'Call ', 'Garrison']) expect(shown).not.toContain(secret)
    expect(candidates.find(item => item.id === 'overdue-return-cadet_1')?.title).toBe('A.R.G.U.S.: critical — a cadet record needs attention')
    expect(candidates.find(item => item.id === 'funding')?.title).toBe('A.R.G.U.S.: changes are waiting to publish')
  })

  it('leaves acknowledged task alerts out of the group count, and drops the group once all are acknowledged', async () => {
    const projection = await busyUnit()
    const list = alerts(projection, {}, new Date(NOW))
    const ami = projection.calendar.find(event => event.kind === 'AMI')!
    // Every alert about the AMI: its tasks first, then the event's own and AMI-category alerts.
    const amiAlerts = [...list.filter(alert => ami.tasks.some(task => alert.id.includes(task.taskId))), ...list.filter(alert => alert.id === `event-${ami.calendarEventId}` || alert.id.startsWith(`ami-${ami.calendarEventId}-`))]
    const history = { ...emptyHistory(), lastOpenedAt: NOW - HOUR }
    const partly = planDeviceNotifications({ alerts: list, projection, now: NOW, visible: false, history, acknowledged: new Set(amiAlerts.slice(0, 2).map(alert => alert.id)) })
    expect(partly.notify.find(item => item.id === `event-${ami.calendarEventId}`)?.title).toBe('A.R.G.U.S.: AMI in 2 days — 3 preparation tasks overdue')
    const all = planDeviceNotifications({ alerts: list, projection, now: NOW, visible: false, history, acknowledged: new Set(amiAlerts.map(alert => alert.id)) })
    expect(all.notify.some(item => item.id === `event-${ami.calendarEventId}`)).toBe(false)
    // An alert carrying its own acknowledged flag is honoured too.
    const flagged = planDeviceNotifications({ alerts: list.map(alert => ({ ...alert, acknowledged: amiAlerts.includes(alert) })), projection, now: NOW, visible: false, history })
    expect(flagged.notify.some(item => item.id === `event-${ami.calendarEventId}`)).toBe(false)
  })

  it('builds a closed-app summary with only opaque ids, event kinds, due times and targets', async () => {
    const projection = await busyUnit()
    const ami = projection.calendar.find(event => event.kind === 'AMI')!
    const summary = closedAppSummary(projection, NOW, NOW - HOUR, new Set([`task-${ami.tasks[0].taskId}`]))
    expect(summary).toMatchObject({ version: 1, updatedAt: NOW, lastOpenedAt: NOW - HOUR })
    expect(summary.items).toHaveLength(6)
    expect(summary.items.every(item => Object.keys(item).sort().join() === 'dueAt,id,label,target')).toBe(true)
    expect(summary.items.map(item => item.label)).toContain('A supply event preparation task')
    expect(summary.items.map(item => item.id)).not.toContain(`task-${ami.tasks[0].taskId}`)
    expect(summary.items.map(item => item.dueAt)).toEqual([...summary.items.map(item => item.dueAt)].sort((a, b) => a - b))
    const stored = JSON.stringify(summary)
    for (const secret of ['Jordan', 'Rivera', CODE, 'Fitting', 'Call', 'physical count']) expect(stored).not.toContain(secret)
  })
})
