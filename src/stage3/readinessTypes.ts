/**
 * Shared types for the readiness engine and its alerts. Kept in their own module so the event,
 * AMI and End-of-Year engines can name alert targets without importing the alert engine itself.
 */

/**
 * Where an alert or readiness row leads. `tab`/`panel` pick the screen; the optional fields open
 * the exact record there: a calendar event's drawer, a cadet's record, a catalog item's editor
 * (via one of its sizes) or the inventory list filtered to what needs attention.
 */
export type AlertTarget = {
  tab: 'count' | 'inventory' | 'cadets' | 'activity' | 'calendar' | 'more'
  panel?: 'conflicts' | 'needed' | 'wallet' | 'diagnostics' | 'members' | 'rollover'
  calendarEventId?: string
  cadetId?: string
  itemId?: string
  filter?: 'attention' | 'inactive'
}

/** What this device knows about its own synchronization (from the unit runtime; empty in the demo). */
export type SyncSnapshot = {
  needsFunding?: boolean
  state?: string
  queued?: number
  /** Chain records this device holds but cannot decrypt (e.g. sealed under a key it has not received). */
  unreadable?: number
  lastScanAt?: string
  /** A Master removed this device's access. */
  revoked?: boolean
}
