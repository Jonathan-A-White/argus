import { describe, expect, it } from 'vitest'
import { alerts } from '../../stage3/readiness'
import { demoUnit, stockSizes } from '../../test/supplyFixtures'
import { ACK_STORAGE_KEY, acknowledge, isAcknowledged, loadAcknowledgements, pruneAcknowledgements, saveAcknowledgements, unacknowledge } from './alertAcknowledgements'

const memoryStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values }
}
const NOW = new Date(2026, 8, 27, 14, 30)

describe('device-local alert acknowledgement', () => {
  it('keeps the same condition quiet but re-alerts when the condition changes', async () => {
    const { controller } = await demoUnit()
    const { ids } = await stockSizes(controller, 'PT Shorts', { M: 2, L: 6 })
    let projection = await controller.updateInventoryItem(ids.M, { reorderAt: 3 })
    const low = alerts(projection, {}, NOW).find(alert => alert.id === 'low-stock')!
    const acks = acknowledge({}, low)
    expect(isAcknowledged(low, acks)).toBe(true)

    // Same sizes, fewer on hand: still the same condition.
    projection = await controller.issue(ids.M, 1)
    expect(isAcknowledged(alerts(projection, {}, NOW).find(alert => alert.id === 'low-stock')!, acks)).toBe(true)

    // Another size drops to its threshold: a new condition, so it alerts again.
    projection = await controller.updateInventoryItem(ids.L, { reorderAt: 6 })
    const changed = alerts(projection, {}, NOW).find(alert => alert.id === 'low-stock')!
    expect(changed.fingerprint).not.toBe(low.fingerprint)
    expect(isAcknowledged(changed, acks)).toBe(false)
  })

  it('re-alerts when a task that was due soon becomes overdue', async () => {
    const { controller } = await demoUnit()
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(2026, 9, 12, 9).toISOString() })
    const task = projection.calendar[0].tasks.find(candidate => candidate.dueOffsetDays === -14)!
    const soon = alerts(projection, {}, NOW).find(alert => alert.id === `task-${task.taskId}`)!
    expect(soon.severity).toBe('warning')
    const acks = acknowledge({}, soon)
    const overdue = alerts(projection, {}, new Date(2026, 9, 1, 9)).find(alert => alert.id === `task-${task.taskId}`)!
    expect(overdue.severity).toBe('critical')
    expect(isAcknowledged(overdue, acks)).toBe(false)
  })

  it('persists in storage, survives corrupt or unavailable storage, and forgets cleared conditions', () => {
    const storage = memoryStorage()
    const alert = { id: 'low-stock', fingerprint: 'warning|a,b' }
    saveAcknowledgements(storage, acknowledge({}, alert))
    expect(loadAcknowledgements(storage)).toEqual({ 'low-stock': 'warning|a,b' })
    expect(unacknowledge(loadAcknowledgements(storage), alert)).toEqual({})

    storage.setItem(ACK_STORAGE_KEY, '{not json')
    expect(loadAcknowledgements(storage)).toEqual({})
    storage.setItem(ACK_STORAGE_KEY, JSON.stringify({ ok: 'x', bad: 3 }))
    expect(loadAcknowledgements(storage)).toEqual({ ok: 'x' })

    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } }
    expect(loadAcknowledgements(throwing)).toEqual({})
    expect(() => saveAcknowledgements(throwing, { a: 'b' })).not.toThrow()
    expect(loadAcknowledgements(undefined)).toEqual({})

    expect(pruneAcknowledgements({ 'low-stock': 'x', conflicts: 'y' }, [{ id: 'conflicts' }])).toEqual({ conflicts: 'y' })
  })
})
