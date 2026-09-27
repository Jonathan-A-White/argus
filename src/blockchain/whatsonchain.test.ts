import { describe, expect, it } from 'vitest'
import { WhatsOnChainError, WhatsOnChainTestnetClient } from './whatsonchain'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('WhatsOnChainTestnetClient', () => {
  it('fetches address history and normalises unconfirmed heights to null', async () => {
    let requestedUrl = ''
    const fetcher = async (url: RequestInfo | URL) => { requestedUrl = String(url); return jsonResponse([{ tx_hash: 'a'.repeat(64), height: 700_000 }, { tx_hash: 'b'.repeat(64), height: 0 }, { tx_hash: 'c'.repeat(64), height: -1 }]) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch)
    const history = await client.addressHistory('mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef')
    expect(requestedUrl).toBe('https://api.whatsonchain.com/v1/bsv/test/address/mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef/history')
    expect(history).toEqual([{ txHash: 'a'.repeat(64), height: 700_000 }, { txHash: 'b'.repeat(64), height: null }, { txHash: 'c'.repeat(64), height: null }])
  })

  it('fetches raw transaction hex', async () => {
    let requestedUrl = ''
    const fetcher = async (url: RequestInfo | URL) => { requestedUrl = String(url); return new Response('deadbeef') }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch)
    expect(await client.txHex('a'.repeat(64))).toBe('deadbeef')
    expect(requestedUrl).toBe(`https://api.whatsonchain.com/v1/bsv/test/tx/${'a'.repeat(64)}/hex`)
  })

  it('fetches a TSC merkle proof', async () => {
    const proof = { index: 3, txOrId: 'a'.repeat(64), target: 'b'.repeat(64), nodes: ['c'.repeat(64)] }
    let requestedUrl = ''
    const fetcher = async (url: RequestInfo | URL) => { requestedUrl = String(url); return jsonResponse(proof) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch)
    expect(await client.merkleProof('a'.repeat(64))).toEqual(proof)
    expect(requestedUrl).toBe(`https://api.whatsonchain.com/v1/bsv/test/tx/${'a'.repeat(64)}/proof/tsc`)
  })

  it('fetches a block header', async () => {
    const header = { hash: 'a'.repeat(64), height: 5, time: 1700000000, merkleroot: 'b'.repeat(64), nonce: 1, bits: '1d00ffff', version: 1 }
    let requestedUrl = ''
    const fetcher = async (url: RequestInfo | URL) => { requestedUrl = String(url); return jsonResponse(header) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch)
    expect(await client.blockHeader('a'.repeat(64))).toEqual(header)
    expect(requestedUrl).toBe(`https://api.whatsonchain.com/v1/bsv/test/block/${'a'.repeat(64)}/header`)
  })

  it('fetches chain tip info', async () => {
    let requestedUrl = ''
    const fetcher = async (url: RequestInfo | URL) => { requestedUrl = String(url); return jsonResponse({ blocks: 1_500_000, bestblockhash: 'a'.repeat(64) }) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch)
    expect(await client.chainInfo()).toEqual({ blocks: 1_500_000, bestblockhash: 'a'.repeat(64) })
    expect(requestedUrl).toBe('https://api.whatsonchain.com/v1/bsv/test/chain/info')
  })

  it('retries once on a 500 and succeeds if the retry works', async () => {
    let calls = 0
    const fetcher = async () => { calls += 1; return calls === 1 ? new Response('server error', { status: 500 }) : jsonResponse({ blocks: 1, bestblockhash: 'a'.repeat(64) }) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch, undefined, 15_000, 1)
    const result = await client.chainInfo()
    expect(result).toEqual({ blocks: 1, bestblockhash: 'a'.repeat(64) })
    expect(calls).toBe(2)
  })

  it('retries once on a 429 and surfaces the typed error if it fails again', async () => {
    let calls = 0
    const fetcher = async () => { calls += 1; return new Response('rate limited', { status: 429 }) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch, undefined, 15_000, 1)
    await expect(client.chainInfo()).rejects.toMatchObject({ status: 429, path: '/chain/info' })
    expect(calls).toBe(2)
  })

  it('surfaces a 404 as a typed error with status and path, without retrying', async () => {
    let calls = 0
    const fetcher = async () => { calls += 1; return new Response('not found', { status: 404 }) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch)
    await expect(client.txHex('a'.repeat(64))).rejects.toBeInstanceOf(WhatsOnChainError)
    await expect(client.txHex('a'.repeat(64))).rejects.toMatchObject({ status: 404, path: `/tx/${'a'.repeat(64)}/hex` })
    expect(calls).toBe(2)
  })

  it('aborts and throws a typed error when a request exceeds its timeout', async () => {
    const fetcher = (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch, undefined, 20)
    await expect(client.chainInfo()).rejects.toMatchObject({ path: '/chain/info' })
  })

  it('uses a caller-supplied base URL', async () => {
    let requestedUrl = ''
    const fetcher = async (url: RequestInfo | URL) => { requestedUrl = String(url); return jsonResponse({ blocks: 1, bestblockhash: 'a'.repeat(64) }) }
    const client = new WhatsOnChainTestnetClient(fetcher as typeof fetch, 'https://example.test/custom-base')
    await client.chainInfo()
    expect(requestedUrl).toBe('https://example.test/custom-base/chain/info')
  })
})
