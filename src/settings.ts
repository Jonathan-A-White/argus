export type ThemePreference = 'dark'|'light'|'system'
export type UserSettings = { theme: ThemePreference; density: 'comfortable'|'compact'; motion: 'full'|'reduced'; textSize: 'standard'|'large'; defaultSection: 'home'|'count'|'inventory'|'cadets'|'calendar'|'activity'|'more'; /** Tier 2 device notifications (src/notifications); off until the person turns them on. */ deviceNotifications: boolean }
export const SETTINGS_KEY = 'argus.preferences.v2'
/** v1 always stored defaultSection 'count' (the old default, saved on first launch), so migration drops it and new installs land on the Home dashboard. */
export const LEGACY_SETTINGS_KEY = 'argus.preferences.v1'
export const DEFAULT_SETTINGS: UserSettings = { theme: 'system', density: 'comfortable', motion: 'full', textSize: 'standard', defaultSection: 'home', deviceNotifications: false }
export interface SettingsStorage { load(): UserSettings; save(value: UserSettings): void }
export class LocalSettingsStorage implements SettingsStorage {
  constructor(private storage: Pick<Storage, 'getItem'|'setItem'> = localStorage) {}
  load() {
    const current = this.storage.getItem(SETTINGS_KEY), legacy = current ? null : this.storage.getItem(LEGACY_SETTINGS_KEY)
    const raw = current ?? legacy
    if (!raw) return { ...DEFAULT_SETTINGS }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (legacy && parsed.defaultSection === 'count') delete parsed.defaultSection
      const value = { ...DEFAULT_SETTINGS }
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof UserSettings>) if (key in parsed) (value[key] as unknown) = parsed[key]
      value.deviceNotifications = value.deviceNotifications === true
      return value
    } catch { return { ...DEFAULT_SETTINGS } }
  }
  save(value: UserSettings) { this.storage.setItem(SETTINGS_KEY, JSON.stringify(value)) }
}
