import { describe, expect, it } from 'vitest'
import { plural } from '../../plural'
import { plainChainError, syncOutcome } from './labels'

describe('chain errors in plain words (minor 2)', () => {
  it('never shows HTTP, CORS or service internals to people', () => {
    const cors = 'Could not reach WhatsOnChain after 3 tries (offline, timed out, or rate-limited; its 429 reply carries no CORS header).'
    expect(plainChainError(cors)).toBe('The BSV testnet service could not be reached (no connection, or it is busy).')
    expect(plainChainError('WhatsOnChain /address/x/history answered 503: busy')).toBe('The BSV testnet service is having problems right now.')
    expect(plainChainError('WhatsOnChain /tx/raw answered 400: bad-txns')).toBe('The BSV testnet service refused the request.')
    expect(plainChainError('WhatsOnChain /chain/info returned an unexpected shape: {}')).toBe('The BSV testnet service sent an answer this app could not read.')
    expect(plainChainError(undefined)).toBe('The BSV testnet service could not be reached.')
    for (const technical of [cors, 'WhatsOnChain /x answered 503', 'something odd']) expect(plainChainError(technical)).not.toMatch(/CORS|429|503|WhatsOnChain|\//)
  })
})

describe('Sync now outcome (M4)', () => {
  it('reports success only when the sync reached the network', () => {
    expect(syncOutcome({ state: 'synced', queued: 0 })).toEqual({ ok: true, message: 'Synchronized with BSV testnet.' })
    expect(syncOutcome({ state: 'offline', queued: 1 })).toEqual({ ok: false, message: 'This device is offline, so it could not sync with BSV testnet. 1 change is saved on this device and will publish automatically.' })
    expect(syncOutcome({ state: 'error', queued: 0, lastError: 'Could not reach WhatsOnChain after 3 tries' }).message).toBe('Could not sync with BSV testnet. The BSV testnet service could not be reached (no connection, or it is busy). Your work is saved on this device.')
    expect(syncOutcome({ state: 'synced', queued: 3, needsFunding: { address: 'm', spendable: 0, needed: 5 } })).toMatchObject({ ok: false, message: expect.stringMatching(/^Not published: this device needs testnet coins to publish 3 queued changes\./) })
  })
})

describe('plural (shared helper)', () => {
  it('uses the singular for exactly one and an irregular plural when given', () => {
    expect(plural(1, 'item')).toBe('1 item')
    expect(plural(0, 'item')).toBe('0 items')
    expect(plural(2, 'cadet')).toBe('2 cadets')
    expect(plural(0, 'person', 'people')).toBe('0 people')
    expect(plural(1, 'person', 'people')).toBe('1 person')
  })
})
