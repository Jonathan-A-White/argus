import type { SupplyAlert } from '../../stage3/readiness'

/**
 * Device-local alert acknowledgement (master spec §20). An acknowledgement remembers the alert's
 * id together with the fingerprint of the condition it saw, so the same condition stays quiet but
 * a changed one (another size out of stock, a task now overdue) alerts again. Acknowledgements of
 * alerts whose condition has cleared are forgotten, so a condition that returns later alerts anew.
 * Nothing here is shared with other devices, and storage failures never break the dashboard.
 */
export const ACK_STORAGE_KEY = 'argus.alerts.acknowledged.v1'
export type AckStorage = Pick<Storage, 'getItem' | 'setItem'>
/** Alert id → fingerprint of the condition that was acknowledged. */
export type Acknowledgements = Record<string, string>

/** The browser's localStorage, or undefined where it is unavailable (private modes, previews). */
export function browserAckStorage(): AckStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

export function loadAcknowledgements(storage: AckStorage | undefined): Acknowledgements {
  try {
    const raw = storage?.getItem(ACK_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

export function saveAcknowledgements(storage: AckStorage | undefined, value: Acknowledgements) {
  try {
    storage?.setItem(ACK_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the acknowledgement lasts for this session only.
  }
}

export const isAcknowledged = (alert: Pick<SupplyAlert, 'id' | 'fingerprint'>, acknowledgements: Acknowledgements) => acknowledgements[alert.id] === alert.fingerprint

export const acknowledge = (acknowledgements: Acknowledgements, alert: Pick<SupplyAlert, 'id' | 'fingerprint'>): Acknowledgements => ({ ...acknowledgements, [alert.id]: alert.fingerprint })
export const unacknowledge = (acknowledgements: Acknowledgements, alert: Pick<SupplyAlert, 'id'>): Acknowledgements => Object.fromEntries(Object.entries(acknowledgements).filter(([id]) => id !== alert.id))

/** Keeps only acknowledgements of alerts that are still raised. */
export function pruneAcknowledgements(acknowledgements: Acknowledgements, alerts: Pick<SupplyAlert, 'id'>[]): Acknowledgements {
  const live = new Set(alerts.map(alert => alert.id))
  return Object.fromEntries(Object.entries(acknowledgements).filter(([id]) => live.has(id)))
}
