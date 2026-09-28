import { COUNT_INTERVAL_CHOICES, DEFAULT_COUNT_INTERVAL_DAYS } from './stage3/inventoryStatus'
import { READINESS_WEIGHTS, validReadinessWeights, type ReadinessWeights } from './stage3/readiness'

export type ThemePreference = 'dark'|'light'|'system'
export type UserSettings = { theme: ThemePreference; density: 'comfortable'|'compact'; motion: 'full'|'reduced'; textSize: 'standard'|'large'; defaultSection: 'home'|'count'|'inventory'|'cadets'|'calendar'|'activity'|'more'; readinessWeights: ReadinessWeights; /** Tier 2 device notifications (src/notifications); off until the person turns them on. */ deviceNotifications: boolean; /** A size is Count Due when it has not been counted for this many days (this device only). */ countIntervalDays: number }
export const SETTINGS_KEY = 'argus.preferences.v2'
/** v1 always stored defaultSection 'count' (the old default, saved on first launch), so migration drops it and new installs land on the Home dashboard. */
export const LEGACY_SETTINGS_KEY = 'argus.preferences.v1'
/** readinessWeights (spec §35) are per device: each person can weigh the overall readiness score their own way. */
export const DEFAULT_SETTINGS: UserSettings = { theme: 'system', density: 'comfortable', motion: 'full', textSize: 'standard', defaultSection: 'home', readinessWeights: { ...READINESS_WEIGHTS }, deviceNotifications: false, countIntervalDays: DEFAULT_COUNT_INTERVAL_DAYS }
const defaults = (): UserSettings => ({ ...DEFAULT_SETTINGS, readinessWeights: { ...READINESS_WEIGHTS } })
export interface SettingsStorage { load(): UserSettings; save(value: UserSettings): void }
export class LocalSettingsStorage implements SettingsStorage {
  constructor(private storage: Pick<Storage, 'getItem'|'setItem'> = localStorage) {}
  load() {
    const current = this.storage.getItem(SETTINGS_KEY), legacy = current ? null : this.storage.getItem(LEGACY_SETTINGS_KEY)
    const raw = current ?? legacy
    if (!raw) return defaults()
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (legacy && parsed.defaultSection === 'count') delete parsed.defaultSection
      const value = defaults()
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof UserSettings>) if (key in parsed) (value[key] as unknown) = parsed[key]
      value.deviceNotifications = value.deviceNotifications === true
      const weights = value.readinessWeights
      value.readinessWeights = validReadinessWeights(weights) ? { cadets: weights.cadets, inventory: weights.inventory, events: weights.events, audit: weights.audit } : { ...READINESS_WEIGHTS }
      if (!(COUNT_INTERVAL_CHOICES as readonly unknown[]).includes(value.countIntervalDays)) value.countIntervalDays = DEFAULT_COUNT_INTERVAL_DAYS
      return value
    } catch { return defaults() }
  }
  save(value: UserSettings) { this.storage.setItem(SETTINGS_KEY, JSON.stringify(value)) }
}
