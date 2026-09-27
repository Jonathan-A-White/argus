import { IDBFactory } from 'fake-indexeddb'
import { P2PKH, Transaction } from '@bsv/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { anchorLockingScript, keyGrantAnchorAddress } from './anchor'
import { ChainKeyGrantProvider } from './ChainKeyGrantProvider'
import { InsufficientFundsError } from './ChainPrivateHistoryProvider'
import { EmbeddedTestnetWallet } from './EmbeddedTestnetWallet'
import { WhatsOnChainTestnetClient } from './whatsonchain'
import { MockIdentityProvider } from '../identity/identity'
import { generateEcdhKeyPair, wrapEpochKeyForGrant } from '../private-sync/keyGrant'
import type { KeyGrantRecord } from '../private-sync/types'

const originalIndexedDb = globalThis.indexedDB
function useFreshIndexedDb() {
  const factory = new IDBFactory()
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })
  return factory
}
afterEach(() => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb }))

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) } }

async function makeGrant(organizationId: string, epochId: string): Promise<KeyGrantRecord> {
  const master = new MockIdentityProvider('master')
  const masterEcdh = await generateEcdhKeyPair(), deviceEcdh = await generateEcdhKeyPair()
  const epochKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return wrapEpochKeyForGrant({
    epochKey,
    organizationId,
    epochId,
    granteePublicIdentity: 'p256:device',
    grantorPublicIdentity: await master.getPublicIdentity(),
    grantorEcdhPrivateKey: masterEcdh.privateKey,
    granteeEcdhPublicKey: deviceEcdh.publicKey,
    grantorSigner: master,
  })
}

/** A minimal fake WhatsOnChain + broadcast surface, mirroring ChainPrivateHistoryProvider.test.ts's fakeChain(). */
function fakeChain() {
  const unspent = new Map<string, Array<{ tx_hash: string; tx_pos: number; value: number; height?: number }>>()
  const txHex = new Map<string, string>()
  const history = new Map<string, Array<{ tx_hash: string; height: number }>>()
  const posted: string[] = []
  /** Address -> its P2PKH locking script hex; a broadcast tx paying one of these shows up in that address's history, as WhatsOnChain would report it. */
  const watchedScripts = new Map<string, string>()
  const watch = (address: string) => watchedScripts.set(anchorLockingScript(address).toHex(), address)
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const unspentMatch = /\/address\/([^/]+)\/unspent$/.exec(url)
    if (unspentMatch) return Response.json(unspent.get(unspentMatch[1]) ?? [])
    const historyMatch = /\/address\/([^/]+)\/history$/.exec(url)
    if (historyMatch) return Response.json(history.get(historyMatch[1]) ?? [])
    const hexMatch = /\/tx\/([0-9a-f]{64})\/hex$/i.exec(url)
    if (hexMatch) { const hex = txHex.get(hexMatch[1]); return hex ? new Response(hex) : new Response('not found', { status: 404 }) }
    if (url.endsWith('/tx/raw')) {
      const { txhex } = JSON.parse(String(init?.body)) as { txhex: string }
      posted.push(txhex)
      const tx = Transaction.fromHex(txhex)
      const txid = tx.id('hex')
      txHex.set(txid, txhex)
      for (const output of tx.outputs) {
        const address = watchedScripts.get(output.lockingScript.toHex())
        if (!address) continue
        const entries = history.get(address) ?? []
        if (!entries.some(entry => entry.tx_hash === txid)) history.set(address, [...entries, { tx_hash: txid, height: 0 }])
      }
      return Response.json({ txid })
    }
    if (url.endsWith('/chain/info')) return Response.json({ blocks: 100, bestblockhash: 'a'.repeat(64) })
    return new Response('not found', { status: 404 })
  }
  return { fetcher, unspent, txHex, history, posted, watch }
}

async function fundedWallet(chain: ReturnType<typeof fakeChain>) {
  const wallet = new EmbeddedTestnetWallet(storage(), chain.fetcher as typeof fetch)
  const created = await wallet.create('correct horse battery 7 staple')
  const address = created.receivingAddress!
  chain.unspent.set(address, [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 10_000, height: 1 }])
  const fundingTx = new Transaction()
  fundingTx.addOutput({ satoshis: 10_000, lockingScript: new P2PKH().lock(address) })
  chain.txHex.set('a'.repeat(64), fundingTx.toHex())
  return { wallet, address }
}

describe('ChainKeyGrantProvider', () => {
  it('publishes a key grant transaction with the record and anchor outputs, and getKeyGrantsSince returns it', async () => {
    useFreshIndexedDb()
    const organizationId = 'org-key-grant-chain-1'
    const chain = fakeChain()
    chain.watch(keyGrantAnchorAddress(organizationId))
    const { wallet } = await fundedWallet(chain)
    const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
    const provider = new ChainKeyGrantProvider(wallet, client, organizationId)

    const grant = await makeGrant(organizationId, 'epoch-001')
    await provider.publishKeyGrant(grant)
    expect(chain.posted).toHaveLength(1)

    const page = await provider.getKeyGrantsSince('0')
    expect(page.records).toEqual([grant])
    expect(page.hasMore).toBeFalsy()

    const again = await provider.getKeyGrantsSince(page.cursor)
    expect(again.records).toEqual([])
  })

  it('rejects publishing for a different organization, and refuses when the wallet is unfunded', async () => {
    useFreshIndexedDb()
    const organizationId = 'org-key-grant-chain-2'
    const chain = fakeChain()
    const wallet = new EmbeddedTestnetWallet(storage(), chain.fetcher as typeof fetch)
    await wallet.create('correct horse battery 7 staple')
    const client = new WhatsOnChainTestnetClient(chain.fetcher as typeof fetch)
    const provider = new ChainKeyGrantProvider(wallet, client, organizationId)

    const grant = await makeGrant('org-other', 'epoch-001')
    await expect(provider.publishKeyGrant(grant)).rejects.toThrow(/another organization/)

    const ownGrant = await makeGrant(organizationId, 'epoch-001')
    await expect(provider.publishKeyGrant(ownGrant)).rejects.toBeInstanceOf(InsufficientFundsError)
    expect(chain.posted).toHaveLength(0)
  })
})
