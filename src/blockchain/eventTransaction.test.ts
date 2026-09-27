import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { encodeEventOutput } from './EncryptedEventTestnet'
import type { EncryptedArgusEnvelope } from '../private-sync/types'
import { anchorLockingScript, unitAnchorAddress } from './anchor'
import { decodeEventTransaction } from './eventTransaction'

const envelope: EncryptedArgusEnvelope = {
  protocol: 'ARGUS_PRIVATE_EVENT',
  protocolVersion: 1,
  organizationId: 'org-njrotc-1',
  eventId: 'event-a',
  epochId: 'epoch-a',
  senderPublicIdentity: 'pubkey-a',
  algorithm: 'AES-256-GCM',
  nonce: 'nonce-a',
  ciphertext: 'ciphertext-a',
  ciphertextHash: 'hash-a',
  signature: 'signature-a',
}

describe('decodeEventTransaction', () => {
  it('round-trips the envelope and the anchor address out of a raw transaction', async () => {
    const funding = new Transaction()
    const fundingKey = PrivateKey.fromRandom()
    funding.addOutput({ satoshis: 10_000, lockingScript: new P2PKH().lock(fundingKey.toAddress('testnet')) })

    const anchorAddress = unitAnchorAddress(envelope.organizationId)
    const transaction = new Transaction()
    transaction.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(fundingKey) })
    transaction.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex(encodeEventOutput(envelope)) })
    transaction.addOutput({ satoshis: 1, lockingScript: anchorLockingScript(anchorAddress) })
    await transaction.sign()

    const decoded = decodeEventTransaction(transaction.toHex())
    expect(decoded.envelope).toEqual(envelope)
    expect(decoded.anchorAddress).toBe(anchorAddress)
  })

  it('returns an undefined anchor address when there is no anchor output', () => {
    const transaction = new Transaction()
    transaction.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex(encodeEventOutput(envelope)) })
    const decoded = decodeEventTransaction(transaction.toHex())
    expect(decoded.envelope).toEqual(envelope)
    expect(decoded.anchorAddress).toBeUndefined()
  })

  it('throws when the transaction carries no A.R.G.U.S. data output', () => {
    const transaction = new Transaction()
    const key = PrivateKey.fromRandom()
    transaction.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress('testnet')) })
    expect(() => decodeEventTransaction(transaction.toHex())).toThrow(/A\.R\.G\.U\.S\. data output/)
  })
})
