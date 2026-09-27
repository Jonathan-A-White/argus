import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { createRuntimeController } from './runtime'

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('argus-operational-v2')
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('test database is still open'))
  })
})

describe('runtime composition root', () => {
  it('creates a working local-only controller now that shared history sync is mock/local-only', async () => {
    const controller = await createRuntimeController()
    const projection = await controller.initialize()
    expect(projection.sync.mode).toBe('local')
  })
})
