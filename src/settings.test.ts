import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, LEGACY_SETTINGS_KEY, LocalSettingsStorage, SETTINGS_KEY } from './settings'

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values } }

describe('local settings storage', () => {
  it('loads a preferences record carrying fields from the removed shared-sync enrollment without error and without those fields', () => {
    const local = storage()
    local.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'dark', density: 'compact', motion: 'full', textSize: 'standard', defaultSection: 'count', endpoint: 'https://sync.example.org', organizationId: 'org-legacy', enrollmentSecret: 'a-strong-legacy-secret' }))
    const settings = new LocalSettingsStorage(local)
    const loaded = settings.load()
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', density: 'compact', defaultSection: 'count' })
    expect(loaded).not.toHaveProperty('endpoint')
    expect(loaded).not.toHaveProperty('organizationId')
    expect(loaded).not.toHaveProperty('enrollmentSecret')
  })

  it('migrates v1 preferences, turning the old automatic Count landing into the Home dashboard but keeping other choices', () => {
    const local = storage()
    local.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ theme: 'light', density: 'comfortable', motion: 'reduced', textSize: 'large', defaultSection: 'count' }))
    expect(new LocalSettingsStorage(local).load()).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', motion: 'reduced', textSize: 'large', defaultSection: 'home' })
    local.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({ defaultSection: 'inventory' }))
    expect(new LocalSettingsStorage(local).load().defaultSection).toBe('inventory')
  })

  it('keeps valid per-device readiness weights and replaces invalid ones with equal weights', () => {
    const local = storage()
    local.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, readinessWeights: { cadets: 2, inventory: 1, events: 0, audit: 0.5, extra: 9 } }))
    expect(new LocalSettingsStorage(local).load().readinessWeights).toEqual({ cadets: 2, inventory: 1, events: 0, audit: 0.5 })
    for (const invalid of [{ cadets: 0, inventory: 0, events: 0, audit: 0 }, { cadets: -1, inventory: 1, events: 1, audit: 1 }, 'heavy', null]) {
      local.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, readinessWeights: invalid }))
      expect(new LocalSettingsStorage(local).load().readinessWeights).toEqual({ cadets: 1, inventory: 1, events: 1, audit: 1 })
    }
    expect(new LocalSettingsStorage(storage()).load().readinessWeights).toEqual({ cadets: 1, inventory: 1, events: 1, audit: 1 })
  })
})
