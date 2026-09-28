import type { ArgusAppProjection } from '../distributed/appIntegration'
import { isVerified } from '../distributed/delivery'
import { AMI_CRITICAL_DAYS, amiReadiness, nextAmiEvent } from './amiReadiness'
import { calendarDaysUntil, taskDueDate } from './calendar'
import { countDiscrepancies, lateCountSessions, reconciliationIssues } from './countHealth'
import { cadetLabel } from './domain'
import { combinedEventReadiness, postEventReturns, RETURNABLE_KINDS } from './eventReadiness'
import type { AlertTarget, SyncSnapshot } from './readinessTypes'
import { plural } from '../plural'
import { activeBundleVersions, requiredItemOf, standardIssueBundles, unmetItems, variantFor, variantsOf } from './requirements'

export type { AlertTarget, SyncSnapshot } from './readinessTypes'

/**
 * Readiness engine (master spec §35) and in-app alerts (§20 tier 1), derived purely from the
 * shared projection so every device computes the same numbers. Only the weights are per device.
 */
export type ReadinessWeights = { cadets: number; inventory: number; events: number; audit: number }
export type ReadinessBreakdown = {
  cadets: number
  inventory: number
  events: number
  audit: number
  overall: number
  cadetsNeedingItems: number
  stockNeedingAttention: number
  activePreparations: number
  activeCadets: number
  /** Stock lines the unit's bundles and cadets need, and how many are sufficiently stocked. */
  inventoryNeeded: number
  inventoryReady: number
  /** The event the Events component scores: the next active one today or later. */
  scoredEventId?: string
  weights: ReadinessWeights
  /**
   * Whether each category has anything to measure (active cadets, stock the unit needs or tracks, an
   * upcoming event with preparation, recorded changes). A category with nothing to measure keeps its
   * legacy 100 above but is left out of `overall` and shown as "Not measured yet", so an empty unit
   * never reads as fully ready.
   */
  measured: Record<keyof ReadinessWeights, boolean>
  /** False when no weighted category has anything to measure yet (overall is then 0 and not shown as a score). */
  overallMeasured: boolean
}
export type AlertSeverity = 'critical' | 'warning' | 'info'
/**
 * `fingerprint` describes the condition behind the alert (which items, cadets, sessions…). A
 * device-local acknowledgement stores it, so the same condition stays quiet but a changed one
 * alerts again. Ids and fingerprints are deterministic for the same projection and clock.
 */
export type SupplyAlert = { id: string; severity: AlertSeverity; title: string; detail: string; target: AlertTarget; fingerprint: string }
export const READINESS_WEIGHTS: Readonly<ReadinessWeights> = Object.freeze({ cadets: 1, inventory: 1, events: 1, audit: 1 })
export const READINESS_KEYS = ['cadets', 'inventory', 'events', 'audit'] as const
export const MAX_READINESS_WEIGHT = 10

/** Every weight a finite number from 0 to MAX_READINESS_WEIGHT, and at least one above zero. */
export function validReadinessWeights(value: unknown): value is ReadinessWeights {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!READINESS_KEYS.every(key => typeof record[key] === 'number' && Number.isFinite(record[key]) && (record[key] as number) >= 0 && (record[key] as number) <= MAX_READINESS_WEIGHT)) return false
  return READINESS_KEYS.reduce((sum, key) => sum + (record[key] as number), 0) > 0
}

const DAY = 86_400_000
const percent = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 100)
const sortedKey = (values: string[]) => [...values].sort().join(',')
type Projection = ArgusAppProjection
type Cadet = Projection['cadets'][number]
type InventoryItem = Projection['inventory'][number]

export function upcomingEvents(projection: Pick<ArgusAppProjection, 'calendar'>, now = new Date()) {
  return projection.calendar.filter(event => event.active && new Date(event.startsAt).getTime() >= now.getTime() - 7 * DAY).sort((a, b) => a.startsAt < b.startsAt ? -1 : 1)
}

/** A stocked size needs attention when it is at or below its low-stock threshold, or empty while cadets hold that size. */
export function stockNeedsAttention(item: ArgusAppProjection['inventory'][number]) {
  return item.active && ((item.reorderAt !== undefined && item.onHand <= item.reorderAt) || (item.onHand === 0 && item.issued > 0))
}

/**
 * Audit readiness (spec §35) counts only records VERIFIED on chain: mined, with a known block
 * height. A record that is queued, publishing, merely broadcast, or only on this device is not
 * verified yet, however the rest of the app treats it.
 */
export function auditSummary(projection: Pick<ArgusAppProjection, 'events'>) {
  const verified = projection.events.filter(isVerified).length
  const awaitingBlock = projection.events.filter(record => !isVerified(record) && record.syncStatus === 'SYNCHRONIZED').length
  const notOnChain = projection.events.filter(record => record.syncStatus !== 'SYNCHRONIZED' && record.syncStatus !== 'CONFLICT' && !isVerified(record)).length
  return { total: projection.events.length, verified, awaitingBlock, notOnChain }
}

/** Standard-issue (NSU + PT) items this active cadet does not hold yet. */
export const standardIssueGaps = (cadet: Cadet, projection: Projection) => unmetItems(cadet, standardIssueBundles(projection), projection).unmet
/** Fully issued: holds every standard-issue item that applies to them and has no open Still Needed requirement. */
export const cadetFullyIssued = (cadet: Cadet, projection: Projection) => cadet.stillNeededCount === 0 && standardIssueGaps(cadet, projection).length === 0

export type StockLine = { key: string; name: string; variant?: string; itemId?: string; onHand: number; demand: number; ready: boolean; reason: 'READY' | 'NO_SIZES' | 'EMPTY' | 'LOW' | 'SHORT' | 'NOT_STOCKED' }
/**
 * The stock the unit's bundles need: every active size of every catalog item a bundle requires
 * (an item with no sizes set up is one unready line), plus sizes active cadets need that the unit
 * does not stock. A size is ready when it is on hand, above its low-stock level, and covers the
 * standard-issue demand of cadets who still need that size — so an all-zero unit is never ready.
 */
export function inventoryNeeds(projection: Projection): StockLine[] {
  const demand = new Map<string, { key: string; itemId?: string; size: string; quantity: number; name: string }>()
  const standard = standardIssueBundles(projection)
  for (const cadet of projection.cadets.filter(candidate => candidate.status === 'ACTIVE')) {
    for (const item of unmetItems(cadet, standard, projection).unmet) {
      if (!item.size) continue
      const id = `${item.key}|${item.size.toLowerCase()}`, entry = demand.get(id) ?? { key: item.key, ...(item.itemId ? { itemId: item.itemId } : {}), size: item.size, quantity: 0, name: item.label }
      entry.quantity += item.quantity
      demand.set(id, entry)
    }
  }
  const lines: StockLine[] = [], keys = new Set<string>()
  for (const version of activeBundleVersions(projection)) for (const line of version.lines.filter(candidate => candidate.required)) {
    const item = requiredItemOf(line, version.bundleId, projection)
    if (keys.has(item.key) || projection.catalog.some(candidate => candidate.catalogId === item.key && !candidate.active)) continue
    keys.add(item.key)
    const variants = variantsOf(projection.inventory, item)
    if (!variants.length) { lines.push({ key: item.key, name: item.label, onHand: 0, demand: 0, ready: false, reason: 'NO_SIZES' }); continue }
    for (const variant of variants) {
      const needed = demand.get(`${item.key}|${variant.variant.toLowerCase()}`)?.quantity ?? 0
      const reason: StockLine['reason'] = variant.onHand === 0 ? 'EMPTY' : variant.reorderAt !== undefined && variant.onHand <= variant.reorderAt ? 'LOW' : variant.onHand < needed ? 'SHORT' : 'READY'
      lines.push({ key: item.key, name: variant.name, variant: variant.variant, itemId: variant.entityId, onHand: variant.onHand, demand: needed, ready: reason === 'READY', reason })
    }
  }
  for (const entry of demand.values()) {
    if (!keys.has(entry.key) || variantFor(projection.inventory, entry, entry.size)) continue
    lines.push({ key: entry.key, name: entry.name, variant: entry.size, onHand: 0, demand: entry.quantity, ready: false, reason: 'NOT_STOCKED' })
  }
  return lines
}

export function readiness(projection: ArgusAppProjection, now = new Date(), options: { weights?: ReadinessWeights; sync?: SyncSnapshot } = {}): ReadinessBreakdown {
  const weights = options.weights && validReadinessWeights(options.weights) ? options.weights : READINESS_WEIGHTS
  const activeCadets = projection.cadets.filter(cadet => cadet.status === 'ACTIVE')
  const cadetsNeedingItems = activeCadets.filter(cadet => !cadetFullyIssued(cadet, projection)).length
  const needs = inventoryNeeds(projection)
  const tracked = projection.inventory.filter(item => item.active && (item.reorderAt !== undefined || item.issued > 0 || item.onHand > 0))
  const stockNeedingAttention = projection.inventory.filter(stockNeedsAttention).length
  // A unit without any bundles falls back to the sizes it tracks.
  const inventory = needs.length ? percent(needs.filter(line => line.ready).length, needs.length) : percent(tracked.length - tracked.filter(stockNeedsAttention).length, tracked.length)
  const next = upcomingEvents(projection, now).filter(event => new Date(event.startsAt).getTime() >= now.getTime())
  const activePreparations = next.filter(event => new Date(event.startsAt).getTime() - now.getTime() <= 60 * DAY).length
  const nextEvent = next[0]
  const eventReadiness = nextEvent ? combinedEventReadiness(nextEvent, projection, now, options.sync) : undefined
  const events = eventReadiness?.percent ?? 100
  // Only records verified in a mined block count (see auditSummary).
  const audit = percent(auditSummary(projection).verified, projection.events.length)
  const parts = { cadets: percent(activeCadets.length - cadetsNeedingItems, activeCadets.length), inventory, events, audit }
  const measured = { cadets: activeCadets.length > 0, inventory: needs.length > 0 || tracked.length > 0, events: Boolean(eventReadiness?.parts.length), audit: projection.events.length > 0 }
  // The weighted average of the categories that have something to measure.
  const counted = READINESS_KEYS.filter(key => measured[key] && weights[key] > 0)
  const weight = counted.reduce((sum, key) => sum + weights[key], 0)
  const overall = weight ? Math.round(counted.reduce((sum, key) => sum + parts[key] * weights[key], 0) / weight) : 0
  return { ...parts, overall, cadetsNeedingItems, stockNeedingAttention, activePreparations, activeCadets: activeCadets.length, inventoryNeeded: needs.length, inventoryReady: needs.filter(line => line.ready).length, ...(nextEvent ? { scoredEventId: nextEvent.calendarEventId } : {}), weights: { ...weights }, measured, overallMeasured: weight > 0 }
}

const holding = (cadet: Cadet) => cadet.currentProperty.reduce((sum, line) => sum + line.quantity, 0)
const stockTarget = (items: InventoryItem[]): AlertTarget => ({ tab: 'inventory', filter: 'attention', ...(items.length === 1 ? { itemId: items[0].entityId } : {}) })

export function alerts(projection: ArgusAppProjection, sync: SyncSnapshot = {}, now = new Date()): SupplyAlert[] {
  const list: SupplyAlert[] = []
  const add = (alert: Omit<SupplyAlert, 'fingerprint'> & { condition: string }) => { const { condition, ...rest } = alert; list.push({ ...rest, fingerprint: `${alert.severity}|${condition}` }) }

  // Authorization: this device's own removal first, it changes what everything else means.
  const me = projection.members.find(member => member.publicIdentity === projection.actor)
  if (sync.revoked || me?.status === 'REVOKED') add({ id: 'device-removed', severity: 'critical', title: 'This device’s access was removed', detail: 'A Master removed you from the unit. Nothing new you record will be accepted.', target: { tab: 'more', panel: 'members' }, condition: me?.revokedAt ?? 'revoked' })

  const conflicts = projection.conflicts.filter(conflict => conflict.status === 'OPEN')
  if (conflicts.length) add({ id: 'conflicts', severity: 'critical', title: `${plural(conflicts.length, 'unresolved conflict')}`, detail: 'Competing offline changes need a decision.', target: { tab: 'more', panel: 'conflicts' }, condition: sortedKey(conflicts.map(conflict => conflict.id)) })
  if (!projection.integrity.healthy) add({ id: 'integrity', severity: 'critical', title: 'Integrity check failed', detail: `${plural(projection.integrity.issues.length, 'problem')} found in the local records: ${projection.integrity.issues.slice(0, 2).map(issue => issue.message).join(' ')}`, target: { tab: 'more', panel: 'diagnostics' }, condition: sortedKey(projection.integrity.issues.map(issue => `${issue.code}:${issue.entityId}`)) })
  if (sync.needsFunding) add({ id: 'funding', severity: 'critical', title: 'This device needs testnet coins', detail: `${sync.queued ?? 0} change(s) are waiting to publish.`, target: { tab: 'more', panel: 'wallet' }, condition: 'needs-funding' })
  else if (sync.state === 'error') add({ id: 'sync', severity: 'warning', title: 'Synchronization issue', detail: 'Work is saved on this device and will publish when the testnet service responds.', target: { tab: 'more', panel: 'wallet' }, condition: 'error' })
  const failed = projection.events.filter(record => record.syncStatus === 'FAILED' || record.auditStatus === 'FAILED')
  if (failed.length) add({ id: 'audit-failed', severity: 'warning', title: `${plural(failed.length, 'change')} failed to publish`, detail: 'The audit submission or broadcast failed; A.R.G.U.S. keeps them and retries.', target: { tab: 'activity' }, condition: sortedKey(failed.map(record => record.event.eventId)) })
  if (sync.unreadable) add({ id: 'unreadable', severity: 'warning', title: `${plural(sync.unreadable, 'record')} this device cannot read`, detail: 'They were sealed with a unit key this device has not received yet.', target: { tab: 'more', panel: 'diagnostics' }, condition: String(sync.unreadable) })

  // Stock: one rule (stockNeedsAttention) for both, so a threshold with nothing on hand is never silent.
  const attention = projection.inventory.filter(stockNeedsAttention)
  const out = attention.filter(item => item.onHand === 0), low = attention.filter(item => item.onHand > 0)
  if (out.length) add({ id: 'out-of-stock', severity: 'critical', title: `${plural(out.length, 'size')} out of stock`, detail: out.slice(0, 3).map(item => `${item.name} · ${item.variant}`).join(', '), target: stockTarget(out), condition: sortedKey(out.map(item => item.entityId)) })
  if (low.length) add({ id: 'low-stock', severity: 'warning', title: `${plural(low.length, 'size')} low on stock`, detail: low.slice(0, 3).map(item => `${item.name} · ${item.variant} (${item.onHand})`).join(', '), target: stockTarget(low), condition: sortedKey(low.map(item => item.entityId)) })

  // Cadets and returns.
  const incomplete = projection.cadets.filter(cadet => cadet.status === 'ACTIVE' && !cadetFullyIssued(cadet, projection)).sort((a, b) => cadetLabel(a).localeCompare(cadetLabel(b)))
  if (incomplete.length) add({ id: 'cadets-incomplete', severity: 'warning', title: `${plural(incomplete.length, 'cadet')} still ${incomplete.length === 1 ? 'needs' : 'need'} items`, detail: incomplete.length === 1 ? `${cadetLabel(incomplete[0])} is missing standard-issue gear or has Still Needed items.` : 'Missing standard-issue (NSU/PT) gear or open Still Needed items.', target: incomplete.length === 1 ? { tab: 'cadets', cadetId: incomplete[0].cadetId } : { tab: 'more', panel: 'needed' }, condition: sortedKey(incomplete.map(cadet => cadet.cadetId)) })
  const inactiveHolding = projection.cadets.filter(cadet => cadet.status === 'INACTIVE' && holding(cadet) > 0).sort((a, b) => cadetLabel(a).localeCompare(cadetLabel(b)))
  if (inactiveHolding.length) add({ id: 'inactive-holding', severity: 'warning', title: `${plural(inactiveHolding.length, 'inactive cadet')} still ${inactiveHolding.length === 1 ? 'holds' : 'hold'} property`, detail: inactiveHolding.slice(0, 4).map(cadet => `${cadetLabel(cadet)} (${plural(holding(cadet), 'item')})`).join(', '), target: inactiveHolding.length === 1 ? { tab: 'cadets', cadetId: inactiveHolding[0].cadetId } : { tab: 'cadets', filter: 'inactive' }, condition: sortedKey(inactiveHolding.map(cadet => cadet.cadetId)) })
  for (const kind of RETURNABLE_KINDS) {
    // The most recent past event of each loaned-gear kind; older events' returns roll into it.
    const event = projection.calendar.filter(candidate => candidate.active && candidate.kind === kind && calendarDaysUntil(candidate.startsAt, now) < 0).sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0]
    const pending = event ? postEventReturns(event, projection, now) : []
    if (event && pending.length) add({ id: `overdue-return-${event.calendarEventId}`, severity: 'warning', title: `Overdue return: ${plural(pending.length, 'cadet')} still ${pending.length === 1 ? 'holds' : 'hold'} ${event.title} gear`, detail: pending.slice(0, 4).map(entry => `${entry.label} (${plural(entry.quantity, 'item')})`).join(', '), target: { tab: 'calendar', calendarEventId: event.calendarEventId }, condition: sortedKey(pending.map(entry => entry.cadetId)) })
  }

  // Counts.
  const discrepancies = countDiscrepancies(projection, now), late = lateCountSessions(projection, now)
  if (discrepancies.length || late.length) {
    const differing = discrepancies.filter(entry => entry.expected !== entry.counted).length, moved = discrepancies.filter(entry => entry.movement).length
    const parts = [differing && `${plural(differing, 'size')} counted differently from the records`, moved && `${plural(moved, 'size')} moved while being counted`, late.length && `${plural(late.length, 'finalized count')} left late tallies out`].filter(Boolean)
    add({ id: 'count-discrepancy', severity: 'warning', title: 'Count discrepancies to review', detail: `${parts.join(' · ')}.`, target: discrepancies.length === 1 ? { tab: 'inventory', filter: 'attention', itemId: discrepancies[0].itemId } : { tab: 'count' }, condition: sortedKey([...discrepancies.map(entry => `${entry.sessionId}:${entry.itemId}`), ...late.map(session => `${session.sessionId}:late`)]) })
  }
  const reconcile = reconciliationIssues(projection, now)
  if (reconcile.length) add({ id: 'reconciliation-required', severity: 'warning', title: `Reconciliation required: ${plural(reconcile.length, 'count')}`, detail: reconcile.slice(0, 3).map(issue => `${issue.scope} — ${issue.reason === 'SUBMITTED' ? 'submitted, not finalized' : issue.reason === 'LATE_WORK' ? 'late tallies to review' : `open ${issue.days} days`}`).join('; '), target: { tab: 'count' }, condition: sortedKey(reconcile.map(issue => `${issue.sessionId}:${issue.reason}`)) })

  const unsized = projection.catalog.filter(item => item.active && item.sized && !projection.inventory.some(variant => variant.catalogId === item.catalogId))
  if (unsized.length) add({ id: 'sizes-not-set', severity: 'info', title: `${plural(unsized.length, 'item')} ${unsized.length === 1 ? 'has' : 'have'} no sizes yet`, detail: 'Add the sizes your unit stocks before counting or issuing them.', target: { tab: 'inventory', filter: 'attention' }, condition: sortedKey(unsized.map(item => item.catalogId)) })

  // Calendar: task deadlines, approaching events, and AMI gaps in the final days.
  for (const event of upcomingEvents(projection, now)) {
    for (const task of event.tasks.filter(candidate => !candidate.completed)) {
      const due = new Date(taskDueDate(event.startsAt, task.dueOffsetDays)).getTime(), days = Math.ceil((due - now.getTime()) / DAY)
      const target: AlertTarget = { tab: 'calendar', calendarEventId: event.calendarEventId }
      if (days < 0) add({ id: `task-${task.taskId}`, severity: 'critical', title: `Overdue: ${task.title}`, detail: `${event.title} · due ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`, target, condition: 'overdue' })
      else if (days <= 3) add({ id: `task-${task.taskId}`, severity: 'warning', title: `Due ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}: ${task.title}`, detail: event.title, target, condition: 'due-soon' })
    }
    const days = calendarDaysUntil(event.startsAt, now)
    if (days < 0 || days > 7) continue
    const { percent: ready } = combinedEventReadiness(event, projection, now, sync)
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
    add({ id: `event-${event.calendarEventId}`, severity: ready >= 100 ? 'info' : ready < 50 || days <= 1 ? 'critical' : 'warning', title: `${event.title} ${when}${ready >= 100 ? ' — ready' : ` — ${ready}% ready`}`, detail: ready >= 100 ? 'Every preparation check is complete.' : 'Open the event to see what is still missing.', target: { tab: 'calendar', calendarEventId: event.calendarEventId }, condition: days <= 1 ? 'imminent' : 'this-week' })
  }
  const ami = nextAmiEvent(projection, now)
  if (ami && ami.days <= AMI_CRITICAL_DAYS) {
    for (const category of amiReadiness(projection, sync, now).categories.filter(candidate => candidate.percent < 100)) {
      add({ id: `ami-${ami.event.calendarEventId}-${category.key}`, severity: 'critical', title: `AMI ${ami.days === 0 ? 'today' : `in ${plural(ami.days, 'day')}`}: ${category.label} ${category.percent}%`, detail: category.detail, target: category.target, condition: category.key })
    }
  }

  // Authorization changes this week, and credentials about to lapse.
  const since = now.getTime() - 7 * DAY
  const admittedAt = (eventId: string, fallback: string) => projection.events.find(record => record.event.eventId === eventId)?.event.timestamp ?? fallback
  const changes = projection.members.flatMap(member => [
    ...(member.admittedBy !== member.publicIdentity && Date.parse(admittedAt(member.admittedEventId, member.issuedAt)) >= since ? [{ id: member.admittedEventId, text: `${member.displayName} admitted` }] : []),
    ...(member.roleChangedAt && Date.parse(member.roleChangedAt) >= since ? [{ id: `${member.publicIdentity}:role:${member.roleChangedAt}`, text: `${member.displayName}’s role changed` }] : []),
    ...(member.revokedAt && Date.parse(member.revokedAt) >= since ? [{ id: `${member.publicIdentity}:revoked`, text: `${member.displayName} removed` }] : []),
  ])
  if (changes.length) add({ id: 'authorization-changes', severity: 'info', title: `${plural(changes.length, 'access change')} this week`, detail: changes.slice(0, 3).map(change => change.text).join(', '), target: { tab: 'more', panel: 'members' }, condition: sortedKey(changes.map(change => change.id)) })
  const expiring = projection.members.filter(member => member.status === 'ACTIVE' && member.expiresAt && Date.parse(member.expiresAt) - now.getTime() <= 14 * DAY)
  if (expiring.length) add({ id: 'credentials-expiring', severity: 'warning', title: `${plural(expiring.length, 'credential')} ${expiring.some(member => Date.parse(member.expiresAt!) < now.getTime()) ? 'expired or expiring' : 'expiring within 14 days'}`, detail: expiring.slice(0, 3).map(member => `${member.displayName} · ${new Date(member.expiresAt!).toLocaleDateString()}`).join(', '), target: { tab: 'more', panel: 'members' }, condition: sortedKey(expiring.map(member => `${member.publicIdentity}:${member.expiresAt}`)) })

  if (projection.rejected.length) add({ id: 'rejected', severity: 'info', title: `${plural(projection.rejected.length, 'record')} not applied`, detail: 'Usually waiting for another device’s records; see Diagnostics.', target: { tab: 'more', panel: 'diagnostics' }, condition: sortedKey(projection.rejected.map(record => record.eventId)) })
  const order: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }
  return list.sort((a, b) => order[a.severity] - order[b.severity])
}

/** Active cadets missing standard-issue gear, with each missing item and its recorded size where known. */
export function cadetsMissingStandardIssue(projection: Projection) {
  return projection.cadets
    .filter(cadet => cadet.status === 'ACTIVE')
    .map(cadet => ({ cadetId: cadet.cadetId, label: cadetLabel(cadet), missing: standardIssueGaps(cadet, projection) }))
    .filter(entry => entry.missing.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label))
}
