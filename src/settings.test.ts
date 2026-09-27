import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, LocalSettingsStorage, SETTINGS_KEY } from './settings'

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values } }

describe('local settings storage', () => {
  it('loads a preferences record carrying fields from the removed shared-sync enrollment without error and without those fields', () => {
    const local = storage()
    local.setItem(SETTINGS_KEY, JSON.stringify({ theme: 'dark', density: 'compact', motion: 'full', textSize: 'standard', defaultSection: 'count', endpoint: 'https://sync.example.org', organizationId: 'org-legacy', enrollmentSecret: 'a-strong-legacy-secret' }))
    const settings = new LocalSettingsStorage(local)
    const loaded = settings.load()
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', density: 'compact' })
    expect(loaded).not.toHaveProperty('endpoint')
    expect(loaded).not.toHaveProperty('organizationId')
    expect(loaded).not.toHaveProperty('enrollmentSecret')
  })
})
