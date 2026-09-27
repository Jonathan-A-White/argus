import { describe, expect, it } from 'vitest'
import { anchorLockingScript, unitAnchorAddress } from './anchor'

describe('unit anchor address derivation', () => {
  it('derives a fixed testnet address for a fixed organizationId', () => {
    const address = unitAnchorAddress('org-njrotc-1')
    expect(address).toBe(unitAnchorAddress('org-njrotc-1'))
    expect(address).toMatch(/^[mn]/)
  })

  it('derives different addresses for different organizations', () => {
    expect(unitAnchorAddress('org-a')).not.toBe(unitAnchorAddress('org-b'))
  })

  it('refuses mainnet', () => {
    expect(() => unitAnchorAddress('org-njrotc-1', 'mainnet')).toThrow(/testnet/i)
  })

  it('builds a P2PKH locking script for the anchor address', () => {
    const address = unitAnchorAddress('org-njrotc-1')
    const script = anchorLockingScript(address)
    expect(script.toASM()).toMatch(/^OP_DUP OP_HASH160 [0-9a-f]{40} OP_EQUALVERIFY OP_CHECKSIG$/)
  })
})
