import { useSyncExternalStore } from 'react'
import type { CountObservation, CountSessionProjection, InventoryProjection } from '../../distributed/types'
import { MAX_COUNT_QUANTITY } from '../../distributed/replica'
import { ONE_SIZE_LABEL } from '../../stage3/domain'

export { MAX_COUNT_QUANTITY }

const byNewest = (a?: string, b?: string) => (b ?? '').localeCompare(a ?? '')

/** The session everyone is currently counting into: the newest one that has not been finalized or cancelled. */
export function findActiveSession(sessions: CountSessionProjection[]) {
  return sessions
    .filter(session => session.status === 'ACTIVE' || session.status === 'SUBMITTED' || session.status === 'DRAFT')
    .sort((a, b) => byNewest(a.createdAt, b.createdAt))[0]
}

export function findLastReconciledSession(sessions: CountSessionProjection[]) {
  return sessions
    .filter(session => session.status === 'RECONCILED')
    .sort((a, b) => byNewest(a.reconciledAt ?? a.createdAt, b.reconciledAt ?? b.createdAt))[0]
}

/** The replica only accepts contributions and corrections while a session is DRAFT or ACTIVE. */
export const acceptsContributions = (session: CountSessionProjection) => session.status === 'DRAFT' || session.status === 'ACTIVE'

/** Contributions that make up the shared total (LATE and SUPERSEDED ones are history only). */
export const countsTowardTotal = (observation: CountObservation) =>
  observation.status === 'ACCEPTED' || observation.status === 'CORRECTED'

export const variantLabel = (item: Pick<InventoryProjection, 'name' | 'variant'>) =>
  item.variant === ONE_SIZE_LABEL ? item.name : `${item.name} · ${item.variant}`

export const signed = (value: number) => (value > 0 ? `+${value}` : String(value))

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

export type CountedRow = {
  itemId: string
  label: string
  total: number
  onHand: number
  /** On-hand when the session started (absent for sizes added after it began). */
  before?: number
  difference: number
  contributors: number
  contributions: number
}

/** One row per size that has at least one contribution in the session, in inventory order. */
export function countedRows(session: CountSessionProjection, inventory: InventoryProjection[]): CountedRow[] {
  const itemIds = new Set([...Object.keys(session.totals), ...session.observations.map(observation => observation.itemId)])
  const order = (itemId: string) => {
    const index = inventory.findIndex(item => item.entityId === itemId)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return [...itemIds]
    .sort((a, b) => order(a) - order(b))
    .map(itemId => {
      const item = inventory.find(candidate => candidate.entityId === itemId)
      const counted = session.observations.filter(observation => observation.itemId === itemId && countsTowardTotal(observation))
      const total = session.totals[itemId] ?? 0
      const onHand = item?.onHand ?? 0
      return {
        itemId,
        label: item ? variantLabel(item) : 'Removed item',
        total,
        onHand,
        before: session.baseline[itemId]?.quantity,
        difference: total - onHand,
        contributors: new Set(counted.map(observation => observation.actorPublicIdentity)).size,
        contributions: counted.length,
      }
    })
}

// ---------- personal draft tally (per session + size, survives reloads) ----------

export const draftStorageKey = (sessionId: string, itemId: string) => `argus.count.draft.${sessionId}.${itemId}`

export function loadDraftTally(sessionId: string, itemId: string) {
  try {
    const raw = localStorage.getItem(draftStorageKey(sessionId, itemId))
    if (raw === null) return 0
    const value = Number(raw)
    return Number.isInteger(value) && value >= 0 && value <= MAX_COUNT_QUANTITY ? value : 0
  } catch {
    return 0
  }
}

export function saveDraftTally(sessionId: string, itemId: string, tally: number) {
  try {
    const key = draftStorageKey(sessionId, itemId)
    if (tally > 0) localStorage.setItem(key, String(tally))
    else localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable (private browsing, quota); the tally still lives in memory.
  }
}

// ---------- small parsing / formatting helpers ----------

/** Parses a whole number typed by a person; undefined when blank, fractional or out of range. */
export function parseWhole(text: string, min: number, max: number) {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value >= min && value <= max ? value : undefined
}

export const errorMessage = (reason: unknown, fallback = 'That change could not be saved. Please try again.') =>
  reason instanceof Error && reason.message ? reason.message : fallback

export function defaultSessionName(date = new Date()) {
  return `Physical count ${date.toLocaleString('en-US', { month: 'long', year: 'numeric' })}`
}

export function relativeTime(iso: string | undefined, now: number) {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// A shared, coarse clock so "3 min ago" labels refresh without reading Date.now() during render.
let clockNow = Date.now()
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | undefined

function subscribeClock(listener: () => void) {
  if (!clockListeners.size) clockNow = Date.now()
  clockListeners.add(listener)
  clockTimer ??= setInterval(() => {
    clockNow = Date.now()
    clockListeners.forEach(notify => notify())
  }, 30_000)
  return () => {
    clockListeners.delete(listener)
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}

const clockSnapshot = () => clockNow

export function useNow() {
  return useSyncExternalStore(subscribeClock, clockSnapshot, clockSnapshot)
}
