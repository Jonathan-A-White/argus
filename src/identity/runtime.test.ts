import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockIdentityProvider } from './identity'
import { createMasterDeviceIdentity, unlockDeviceIdentity } from './deviceIdentity'
import { defaultRuntimeController } from './runtime'

const originalIndexedDb = globalThis.indexedDB
beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() })
})
afterEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb })
})

const fakeStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

describe('the runtime default identity provider', () => {
  it('is a real, non-mock identity provider outside mock-development once unlocked', async () => {
    const record = await createMasterDeviceIdentity('correct horse battery 7', fakeStorage())
    const unlocked = await unlockDeviceIdentity(record, 'correct horse battery 7')
    const controller = defaultRuntimeController('unconfigured', { ...unlocked, authorization: unlocked.authorization! })
    expect(controller.identity).not.toBeInstanceOf(MockIdentityProvider)
    expect(await controller.identity.getPublicIdentity()).toMatch(/^p256:/)
  })

  it('throws outside mock-development when no identity has been unlocked yet', () => {
    expect(() => defaultRuntimeController('embedded-testnet')).toThrow('An unlocked identity is required')
  })

  it('uses MockIdentityProvider only under mock-development', () => {
    const controller = defaultRuntimeController('mock-development')
    expect(controller.identity).toBeInstanceOf(MockIdentityProvider)
  })
})
