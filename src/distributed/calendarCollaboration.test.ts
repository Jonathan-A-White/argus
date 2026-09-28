import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { MemoryRepository, type RepositoryState } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { canonicalize } from './canonical'
import { ArgusReplica } from './replica'
import type { ArgusRole, SignedArgusEvent, UnsignedArgusEvent } from './types'

/** Master spec §14–16 and §23: shared event rosters, bundles and details that merge across offline devices, with conflicts never hidden. */

async function unit(names: string[], roles: ArgusRole[] = names.map(() => 'SUPPLY_OFFICER')) {
  const root = new MockIdentityProvider('unit-root'), verifier = new MockIdentityProvider('verifier')
  const authorization = new AuthorizationService(await root.getPublicIdentity(), verifier)
  const identities = names.map(name => new MockIdentityProvider(name))
  for (const [index, identity] of identities.entries()) await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: roles[index], permissions: [...ROLE_PERMISSIONS[roles[index]]], issuedAt: '2026-01-01T00:00:00.000Z' }))
  const replicas = identities.map(identity => new ArgusReplica(new MemoryRepository(), identity, authorization, new MockSyncProvider(), 'unit-a', { genesisCatalog: true }))
  for (const replica of replicas) { await replica.initialize(); replica.online = false }
  const fresh = async () => { const replica = new ArgusReplica(new MemoryRepository(), identities[0], authorization, new MockSyncProvider(), 'unit-a', { genesisCatalog: true }); await replica.initialize(); replica.online = false; return replica }
  return { replicas, identities, fresh }
}

const visible = (state: RepositoryState) => canonicalize({ calendar: state.calendar, cadets: state.cadets, conflicts: state.conflicts, rejected: state.rejected })
const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)
const exchange = async (...replicas: ArgusReplica[]) => { for (const target of replicas) for (const source of replicas) if (source !== target) await target.receiveMany(await events(source)) }
const calendarOf = async (replica: ArgusReplica) => (await replica.snapshot()).calendar[0]
const shuffle = <T,>(values: T[], seed: number) => { const copy = [...values]; let state = seed; for (let i = copy.length - 1; i > 0; i--) { state = (state * 1103515245 + 12345) % 2 ** 31; const j = state % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]] } return copy }

async function withEvent(names = ['officer-a', 'officer-b'], roles?: ArgusRole[]) {
  const setup = await unit(names, roles)
  const [a] = setup.replicas
  const cadets: string[] = []
  for (const gender of ['Male', 'Female', 'Male', 'Female'] as const) cadets.push((await a.createCadet({ gender, nsLevel: 'NS1', status: 'ACTIVE' })).entityId)
  const calendarEventId = (await a.createCalendarEvent({ kind: 'NCO', startsAt: '2026-10-09T12:00:00.000Z' })).entityId
  await exchange(...setup.replicas)
  return { ...setup, cadets, calendarEventId }
}

describe('event attendees are a set (spec §14–16)', () => {
  it('adds and removes idempotently, keeps cadet IDs sorted, and refuses unknown cadets', async () => {
    const { replicas: [a, b], cadets, calendarEventId } = await withEvent()
    const [c1, c2, c3] = cadets
    await a.addCalendarAttendees(calendarEventId, [c3, c1, c1])
    expect((await calendarOf(a)).cadetIds).toEqual([c1, c3].sort())
    await expect(a.addCalendarAttendees(calendarEventId, [c1])).rejects.toThrow(/already attending/)
    await expect(a.addCalendarAttendees(calendarEventId, ['cadet_nobody'])).rejects.toThrow(/Cadet was not found/)
    await expect(a.removeCalendarAttendees(calendarEventId, [c2])).rejects.toThrow(/not attending/)

    // Two offline devices add the same cadet, then both remove it: every duplicate is a no-op, never a rejection.
    await exchange(a, b)
    await a.addCalendarAttendees(calendarEventId, [c2])
    await b.addCalendarAttendees(calendarEventId, [c2])
    await exchange(a, b)
    for (const replica of [a, b]) expect((await calendarOf(replica)).cadetIds).toEqual([c1, c2, c3].sort())
    await a.removeCalendarAttendees(calendarEventId, [c2, c3])
    await b.removeCalendarAttendees(calendarEventId, [c2])
    await exchange(a, b)
    for (const replica of [a, b]) {
      const state = await replica.snapshot()
      expect(state.calendar[0].cadetIds).toEqual([c1])
      expect(state.rejected).toEqual([])
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
  })

  it('holds back an attendee whose cadet record has not arrived yet, then applies it once it does', async () => {
    const { replicas: [a, b], calendarEventId } = await withEvent()
    const cadet = await a.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE' }, { eventId: 'late-cadet' })
    await a.addCalendarAttendees(calendarEventId, [cadet.entityId], { eventId: 'late-attendee' })
    const history = await events(a)
    await b.receiveMany(history.filter(event => event.eventId === 'late-attendee'))
    expect((await b.snapshot()).rejected).toMatchObject([{ eventId: 'late-attendee', reason: 'Cadet projection is missing.' }])
    expect((await calendarOf(b)).cadetIds).not.toContain(cadet.entityId)
    await b.receiveMany(history)
    const state = await b.snapshot()
    expect(state.rejected).toEqual([])
    expect(state.calendar[0].cadetIds).toContain(cadet.entityId)
  })

  it('converges to one roster and bundle list for every delivery order of concurrent offline changes', async () => {
    const { replicas: [a, b, c], cadets, calendarEventId, fresh } = await withEvent(['officer-a', 'officer-b', 'officer-c'])
    const [c1, c2, c3, c4] = cadets
    await a.addCalendarAttendees(calendarEventId, [c1, c2, c3])
    await exchange(a, b, c)
    // All three work offline at once.
    await a.removeCalendarAttendees(calendarEventId, [c2])
    await a.addCalendarBundles(calendarEventId, ['bundle-blt'])
    await b.addCalendarAttendees(calendarEventId, [c4])
    await b.removeCalendarAttendees(calendarEventId, [c3])
    await b.removeCalendarBundles(calendarEventId, ['bundle-pt'])
    await c.addCalendarAttendees(calendarEventId, [c4])
    await c.addCalendarBundles(calendarEventId, ['bundle-male-sdb', 'bundle-blt'])
    const history: SignedArgusEvent[] = [...new Map([...(await events(a)), ...(await events(b)), ...(await events(c))].map(event => [event.eventId, event])).values()]
    const projections = new Set<string>()
    for (let seed = 1; seed <= 6; seed++) {
      const replica = await fresh()
      const order = shuffle(history, seed)
      for (let i = 0; i < order.length; i += 1 + (seed % 3)) await replica.receiveMany(order.slice(i, i + 1 + (seed % 3)))
      await replica.receiveMany(shuffle(history, seed + 100)) // redelivery changes nothing
      projections.add(visible(await replica.snapshot()))
    }
    await exchange(a, b, c)
    for (const replica of [a, b, c]) projections.add(visible(await replica.snapshot()))
    expect(projections.size).toBe(1)
    const merged = await calendarOf(a)
    // Distinct changes all survive; nobody's whole-list edit overwrote anyone else's.
    expect(merged.cadetIds).toEqual([c1, c4].sort())
    expect(merged.bundleIds).toEqual(['bundle-male-nsu', 'bundle-female-nsu', ...merged.bundleIds.slice(2)])
    expect(merged.bundleIds.slice(2).sort()).toEqual(['bundle-blt', 'bundle-male-sdb'])
    expect((await a.snapshot()).conflicts).toEqual([])
  })

  it('links bundles to a custom event and refuses unknown bundles', async () => {
    const { replicas: [a] } = await unit(['officer-a'])
    const custom = (await a.createCalendarEvent({ kind: 'CUSTOM', title: 'Color guard issue', startsAt: '2026-11-02T12:00:00.000Z' })).entityId
    expect((await calendarOf(a)).bundleIds).toEqual([])
    await a.addCalendarBundles(custom, ['bundle-male-sdb', 'bundle-female-sdb'])
    await expect(a.addCalendarBundles(custom, ['bundle-male-sdb'])).rejects.toThrow(/already linked/)
    await expect(a.addCalendarBundles(custom, ['bundle-imaginary'])).rejects.toThrow(/Bundle was not found/)
    await a.removeCalendarBundles(custom, ['bundle-male-sdb'])
    expect((await calendarOf(a)).bundleIds).toEqual(['bundle-female-sdb'])
  })

  it('requires calendar.write for roster, bundle and task changes', async () => {
    const { replicas: [, assistant], cadets, calendarEventId } = await withEvent(['officer-a', 'assistant'], ['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT'])
    const [task] = (await calendarOf(assistant)).tasks
    await expect(assistant.addCalendarAttendees(calendarEventId, [cadets[0]])).rejects.toThrow(/calendar.write/)
    await expect(assistant.addCalendarBundles(calendarEventId, ['bundle-blt'])).rejects.toThrow(/calendar.write/)
    await expect(assistant.updateCalendarTask(calendarEventId, task.taskId, { title: 'Renamed' })).rejects.toThrow(/calendar.write/)
    await expect(assistant.removeCalendarTask(calendarEventId, task.taskId)).rejects.toThrow(/calendar.write/)
    await expect(assistant.updateCalendarEvent(calendarEventId, { title: 'Renamed' })).rejects.toThrow(/calendar.write/)
  })
})

describe('concurrent edits of event details (spec §23)', () => {
  it('raises the same open conflict on every device when two devices change the same field, whatever the delivery order', async () => {
    const { replicas: [a, b, c], calendarEventId, fresh } = await withEvent(['officer-a', 'officer-b', 'officer-c'])
    await a.updateCalendarEvent(calendarEventId, { title: 'NCO — gym' }, { eventId: 'edit-a' })
    await b.updateCalendarEvent(calendarEventId, { title: 'NCO — library' }, { eventId: 'edit-b' })
    // A hears from B first, B hears from A first, and a third device gets everything backwards.
    await a.receiveMany(await events(b)); await b.receiveMany(await events(a))
    await c.receiveMany([...(await events(a))].reverse())
    const late = await fresh(); for (const event of [...(await events(b))].reverse()) await late.receive(event)
    const states = await Promise.all([a, b, c, late].map(replica => replica.snapshot()))
    const [first] = states
    expect(first.conflicts).toHaveLength(1)
    const conflict = first.conflicts[0]
    expect(conflict).toMatchObject({ status: 'OPEN', entityId: calendarEventId, eventIds: ['edit-a', 'edit-b'], reason: expect.stringMatching(/changed the title of/) })
    for (const state of states) {
      expect(state.conflicts).toEqual([conflict])
      expect(state.calendar[0].title).toBe(first.calendar[0].title)
      expect(visible(state)).toBe(visible(first))
    }
    // The kept title is the first edit in canonical order; the other is kept in history, not silently applied.
    expect(['NCO — gym', 'NCO — library']).toContain(first.calendar[0].title)
    expect(first.events.map(record => record.event.eventId)).toEqual(expect.arrayContaining(['edit-a', 'edit-b']))

    // Resolving it and editing again, having seen both, applies cleanly everywhere.
    await a.resolve(conflict.id, 'Agreed on the gym.')
    await a.updateCalendarEvent(calendarEventId, { title: 'NCO — main gym' })
    await exchange(a, b, c)
    for (const replica of [a, b, c]) {
      const state = await replica.snapshot()
      expect(state.calendar[0].title).toBe('NCO — main gym')
      expect(state.conflicts).toMatchObject([{ id: conflict.id, status: 'RESOLVED' }])
    }
  })

  it('merges concurrent edits of different fields without a conflict', async () => {
    const { replicas: [a, b], calendarEventId } = await withEvent()
    await a.updateCalendarEvent(calendarEventId, { title: 'NCO (fall)' })
    await b.updateCalendarEvent(calendarEventId, { startsAt: '2026-10-16T12:00:00.000Z', notes: 'Bring the roster' })
    await b.updateCalendarEvent(calendarEventId, { kind: 'CUSTOM' })
    await exchange(a, b)
    for (const replica of [a, b]) {
      const state = await replica.snapshot()
      expect(state.conflicts).toEqual([])
      expect(state.calendar[0]).toMatchObject({ title: 'NCO (fall)', startsAt: '2026-10-16T12:00:00.000Z', notes: 'Bring the roster', kind: 'CUSTOM' })
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
  })

  it('does not flag an edit whose author saw the current value, even if other work (task completions) reached devices unevenly', async () => {
    const { replicas: [a, b, c], calendarEventId } = await withEvent(['officer-a', 'officer-b', 'officer-c'])
    const [task] = (await calendarOf(c)).tasks
    await c.completeTask(calendarEventId, task.taskId, true, { eventId: 'task-done' })
    await a.receiveMany(await events(c))
    await a.updateCalendarEvent(calendarEventId, { title: 'NCO v2' }, { eventId: 'edit-a' })
    // B sees A's title edit but not C's task completion, then edits the title again.
    await b.receiveMany((await events(a)).filter(event => event.eventId === 'edit-a'))
    expect((await calendarOf(b)).title).toBe('NCO v2')
    await b.updateCalendarEvent(calendarEventId, { title: 'NCO v3' }, { eventId: 'edit-b' })
    await exchange(a, b, c)
    for (const replica of [a, b, c]) {
      const state = await replica.snapshot()
      expect(state.conflicts).toEqual([])
      expect(state.calendar[0].title).toBe('NCO v3')
      expect(state.calendar[0].tasks[0].completed).toBe(true)
    }
  })

  it('treats two devices writing the same value as agreement, not a conflict', async () => {
    const { replicas: [a, b, c], calendarEventId } = await withEvent(['officer-a', 'officer-b', 'officer-c'])
    await a.updateCalendarEvent(calendarEventId, { active: false }, { eventId: 'cancel-a' })
    await b.updateCalendarEvent(calendarEventId, { active: false }, { eventId: 'cancel-b' })
    // C only heard about B's cancellation before restoring the event.
    await c.receiveMany(await events(b))
    await c.updateCalendarEvent(calendarEventId, { active: true })
    await exchange(a, b, c)
    for (const replica of [a, b, c]) {
      const state = await replica.snapshot()
      expect(state.conflicts).toEqual([])
      expect(state.calendar[0].active).toBe(true)
    }
  })

  it('uses the version on screen when editing began, so a change that arrived mid-edit is not overwritten silently', async () => {
    const { replicas: [a, b], calendarEventId } = await withEvent()
    const onScreen = await calendarOf(a)
    await b.updateCalendarEvent(calendarEventId, { notes: 'Gym doors open at 07:00' })
    await a.receiveMany(await events(b)) // arrives while A is still typing
    await a.updateCalendarEvent(calendarEventId, { notes: 'Library' }, { base: onScreen })
    const state = await a.snapshot()
    expect(state.calendar[0].notes).toBe('Gym doors open at 07:00')
    expect(state.conflicts).toMatchObject([{ status: 'OPEN', reason: expect.stringMatching(/changed the notes/) }])
  })

  it('still folds legacy updates that carry neither a base version nor field revisions', async () => {
    const { replicas: [a, b], identities, calendarEventId } = await withEvent()
    const legacy: UnsignedArgusEvent = { protocol: 'ARGUS', protocolVersion: 1, organizationId: 'unit-a', eventVersion: 1, eventId: 'legacy-update', eventType: 'CALENDAR_EVENT_UPDATED', entityId: calendarEventId, actorPublicIdentity: await identities[0].getPublicIdentity(), timestamp: '2026-09-01T00:00:00.000Z', clock: 50, payload: { title: 'Legacy title', cadetIds: [] } }
    await b.receive({ ...legacy, signature: await identities[0].sign(canonicalize(legacy)) })
    const state = await b.snapshot()
    expect(state.rejected).toEqual([])
    expect(state.calendar[0].title).toBe('Legacy title')
    // The next edit on top of it is based on the legacy write and applies normally.
    await b.updateCalendarEvent(calendarEventId, { title: 'Current title' })
    await a.receiveMany(await events(b))
    expect((await calendarOf(a)).title).toBe('Current title')
    expect((await a.snapshot()).conflicts).toEqual([])
  })
})

describe('editing and removing preparation tasks', () => {
  it('edits title and due offset, merges edits of different fields, and keeps completion', async () => {
    const { replicas: [a, b], calendarEventId } = await withEvent()
    const [task] = (await calendarOf(a)).tasks
    await a.completeTask(calendarEventId, task.taskId)
    await exchange(a, b)
    await a.updateCalendarTask(calendarEventId, task.taskId, { title: 'Verify the NS1 roster with the SNSI' })
    await b.updateCalendarTask(calendarEventId, task.taskId, { dueOffsetDays: -28 })
    await expect(a.updateCalendarTask(calendarEventId, task.taskId, { title: '  Verify the NS1 roster with the SNSI ' })).rejects.toThrow(/Nothing to change/)
    await expect(a.updateCalendarTask(calendarEventId, task.taskId, { dueOffsetDays: 400 })).rejects.toThrow(/within a year/)
    await exchange(a, b)
    for (const replica of [a, b]) expect((await calendarOf(replica)).tasks[0]).toMatchObject({ title: 'Verify the NS1 roster with the SNSI', dueOffsetDays: -28, completed: true, completedBy: 'mock:officer-a' })
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
  })

  it('removes a task idempotently and keeps its completion history, even for a completion made concurrently', async () => {
    const { replicas: [a, b], calendarEventId, fresh } = await withEvent()
    const [first, second] = (await calendarOf(a)).tasks
    await a.removeCalendarTask(calendarEventId, first.taskId)
    await b.removeCalendarTask(calendarEventId, first.taskId) // both remove it offline
    await b.completeTask(calendarEventId, second.taskId)
    await a.removeCalendarTask(calendarEventId, second.taskId) // A removes a task B just completed
    await exchange(a, b)
    const late = await fresh(); await late.receiveMany([...(await events(b))].reverse())
    for (const replica of [a, b, late]) {
      const state = await replica.snapshot()
      expect(state.rejected).toEqual([])
      const remaining = state.calendar[0].tasks.map(task => task.taskId)
      expect(remaining).not.toContain(first.taskId)
      expect(remaining).not.toContain(second.taskId)
      expect(state.calendar[0].removedTasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: first.taskId, title: first.title }),
        expect.objectContaining({ taskId: second.taskId, completed: true, completedBy: 'mock:officer-b' }),
      ]))
    }
    expect(visible(await a.snapshot())).toBe(visible(await b.snapshot()))
    expect(visible(await a.snapshot())).toBe(visible(await late.snapshot()))
    await expect(a.removeCalendarTask(calendarEventId, first.taskId)).rejects.toThrow(/not found/)
  })
})
