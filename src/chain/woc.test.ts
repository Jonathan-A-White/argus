import { P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainApiError, WHATSONCHAIN_TESTNET_BASE_URL, WhatsOnChainApi, type WhatsOnChainApiOptions } from './woc'

const BASE = WHATSONCHAIN_TESTNET_BASE_URL
const ADDRESS = PrivateKey.fromRandom().toAddress('testnet')
const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)
const TXID_C = 'c'.repeat(64)

type Reply = Response | Error
type Call = { url: string; method: string; headers: Record<string, string>; body?: string; at: number }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function text(body: string, status = 200): Response {
  return new Response(body, { status })
}

function sampleTxHex(seed = 1): string {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: seed, unlockingScript: UnlockingScript.fromHex('51'), sequence: 0xffffffff })
  tx.addOutput({ lockingScript: new P2PKH().lock(ADDRESS), satoshis: 1000 + seed })
  return tx.toHex()
}

/**
 * A WhatsOnChainApi over a scripted fetch and a fake clock: sleep() advances the clock
 * instantly, so pacing and backoff are observable without real waiting.
 */
function harness(route: (url: string, method: string) => Reply | Reply[], options: WhatsOnChainApiOptions = {}) {
  let clock = 0
  const calls: Call[] = []
  const sleeps: number[] = []
  const queues = new Map<string, Reply[]>()
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, headers: { ...(init?.headers as Record<string, string>) }, body: typeof init?.body === 'string' ? init.body : undefined, at: clock })
    const key = `${method} ${url}`
    if (!queues.has(key)) {
      const reply = route(url, method)
      queues.set(key, Array.isArray(reply) ? [...reply] : [reply])
    }
    const queue = queues.get(key) ?? []
    // The last scripted reply repeats forever.
    const reply = queue.length > 1 ? queue.shift() : queue[0]
    if (!reply) throw new Error(`unscripted request ${key}`)
    if (reply instanceof Error) throw reply
    return reply.clone()
  })
  const api = new WhatsOnChainApi({
    fetcher,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    ...options,
  })
  return { api, calls, sleeps, fetcher, advance: (ms: number) => (clock += ms) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('construction', () => {
  it('binds the global fetch so browsers do not throw "Illegal invocation"', async () => {
    const strictFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(json({ blocks: 7 }))
    })
    vi.stubGlobal('fetch', strictFetch)
    const api = new WhatsOnChainApi({ sleep: async () => undefined })
    await expect(api.tipHeight()).resolves.toBe(7)
    expect(strictFetch).toHaveBeenCalledWith(`${BASE}/chain/info`, expect.anything())
  })

  it('refuses a mainnet base URL', () => {
    expect(() => new WhatsOnChainApi({ baseUrl: 'https://api.whatsonchain.com/v1/bsv/main' })).toThrow(/Mainnet/)
  })

  it('sends custom headers on every request', async () => {
    const { api, calls } = harness(() => json({ blocks: 1 }), { headers: { Authorization: 'key' } })
    await api.tipHeight()
    expect(calls[0].headers.Authorization).toBe('key')
  })
})

describe('pacing and retries', () => {
  it('starts requests at least 350 ms apart, even when issued concurrently', async () => {
    const { api, calls } = harness(() => json({ blocks: 1 }))
    await Promise.all([api.tipHeight(), api.tipHeight(), api.tipHeight()])
    expect(calls.map((call) => call.at)).toEqual([0, 350, 700])
  })

  it('does not wait when the previous request started long enough ago', async () => {
    const { api, calls, sleeps, advance } = harness(() => json({ blocks: 1 }))
    await api.tipHeight()
    advance(1000)
    await api.tipHeight()
    expect(calls.map((call) => call.at)).toEqual([0, 1000])
    expect(sleeps).toEqual([])
  })

  it('retries a 429 with doubling backoff and then succeeds', async () => {
    const { api, calls, sleeps } = harness(() => [text('slow down', 429), text('slow down', 429), json({ blocks: 9 })])
    await expect(api.tipHeight()).resolves.toBe(9)
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([500, 1000])
  })

  it('retries 5xx and gives up after three attempts with the status', async () => {
    const { api, calls } = harness(() => text('bad gateway', 502))
    const error = await api.tipHeight().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ChainApiError)
    expect((error as ChainApiError).status).toBe(502)
    expect(calls).toHaveLength(3)
  })

  it('retries a rejected fetch (a browser sees WoC 429s as CORS failures)', async () => {
    const { api, calls } = harness(() => [new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), json({ blocks: 3 })])
    await expect(api.tipHeight()).resolves.toBe(3)
    expect(calls).toHaveLength(3)
  })

  it('throws a ChainApiError without status when every attempt is rejected', async () => {
    const { api, calls } = harness(() => new TypeError('Failed to fetch'))
    const error = await api.tipHeight().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ChainApiError)
    expect((error as ChainApiError).status).toBeUndefined()
    expect(calls).toHaveLength(3)
  })

  it('does not retry other 4xx answers', async () => {
    const { api, calls } = harness(() => text('nope', 403))
    await expect(api.tipHeight()).rejects.toMatchObject({ status: 403, path: '/chain/info' })
    expect(calls).toHaveLength(1)
  })
})

describe('unspent', () => {
  it('reads /unspent/all in either shape, drops mempool-spent outputs and normalizes heights', async () => {
    const { api, calls } = harness(() =>
      json({
        address: ADDRESS,
        result: [
          { tx_hash: TXID_A, tx_pos: 0, value: 500, height: 120 },
          { tx_hash: TXID_B, tx_pos: 1, value: 700, height: 0 },
          { tx_hash: TXID_C, tx_pos: 2, value: 900, height: -1 },
          { tx_hash: TXID_C, tx_pos: 3, value: 900, height: 118, isSpentInMempoolTx: true },
          { tx_hash: 'bogus', tx_pos: 0, value: 1 },
        ],
      }),
    )
    await expect(api.unspent(ADDRESS)).resolves.toEqual([
      { txid: TXID_A, vout: 0, satoshis: 500, height: 120 },
      { txid: TXID_B, vout: 1, satoshis: 700, height: 0 },
      { txid: TXID_C, vout: 2, satoshis: 900, height: 0 },
    ])
    expect(calls[0].url).toBe(`${BASE}/address/${ADDRESS}/unspent/all`)
  })

  it('accepts a bare array and de-duplicates outpoints, keeping the greater height', async () => {
    const { api } = harness(() =>
      json([
        { tx_hash: TXID_A, tx_pos: 0, value: 500, height: 0 },
        { tx_hash: TXID_A, tx_pos: 0, value: 500, height: 130 },
        { tx_hash: TXID_A, tx_pos: 0, value: 500, height: 0 },
      ]),
    )
    await expect(api.unspent(ADDRESS)).resolves.toEqual([{ txid: TXID_A, vout: 0, satoshis: 500, height: 130 }])
  })

  it.each([404, 400])('falls back to the legacy endpoint on %i', async (status) => {
    const { api, calls } = harness((url) =>
      url.endsWith('/unspent/all')
        ? text('not found', status)
        : json([
            { tx_hash: TXID_B, tx_pos: 1, value: 42, height: 101 },
            { tx_hash: TXID_B, tx_pos: 1, value: 42, height: 0 },
          ]),
    )
    await expect(api.unspent(ADDRESS)).resolves.toEqual([{ txid: TXID_B, vout: 1, satoshis: 42, height: 101 }])
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/address/${ADDRESS}/unspent/all`, `${BASE}/address/${ADDRESS}/unspent`])
  })

  it('treats a legacy 404 as no coins', async () => {
    const { api } = harness(() => text('not found', 404))
    await expect(api.unspent(ADDRESS)).resolves.toEqual([])
  })

  it('refuses non-testnet addresses without a request', async () => {
    const { api, calls } = harness(() => json([]))
    await expect(api.unspent(PrivateKey.fromRandom().toAddress('mainnet'))).rejects.toThrow(/testnet/)
    expect(calls).toHaveLength(0)
  })
})

describe('txHex', () => {
  it('validates the txid before any request', async () => {
    const { api, calls } = harness(() => text(''))
    await expect(api.txHex('xyz')).rejects.toBeInstanceOf(ChainApiError)
    expect(calls).toHaveLength(0)
  })

  it('returns trimmed hex that hashes to the requested txid', async () => {
    const hex = sampleTxHex()
    const txid = Transaction.fromHex(hex).id('hex')
    const { api, calls } = harness(() => text(`${hex}\n`))
    await expect(api.txHex(txid.toUpperCase())).resolves.toBe(hex)
    expect(calls[0].url).toBe(`${BASE}/tx/${txid}/hex`)
  })

  it('retries a 404 every second while the index catches up', async () => {
    const hex = sampleTxHex()
    const txid = Transaction.fromHex(hex).id('hex')
    const { api, calls, sleeps } = harness(() => [text('', 404), text('', 404), text(hex)])
    await expect(api.txHex(txid)).resolves.toBe(hex)
    expect(calls).toHaveLength(3)
    expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(2)
  })

  it('gives up with a 404 ChainApiError after the timeout', async () => {
    const { api, calls } = harness(() => text('', 404), { txHexNotFoundRetryMs: 1000, txHexNotFoundTimeoutMs: 3000 })
    await expect(api.txHex(TXID_A)).rejects.toMatchObject({ name: 'ChainApiError', status: 404 })
    expect(calls).toHaveLength(4)
  })

  it('rejects hex that is not the requested transaction', async () => {
    const { api } = harness(() => text(sampleTxHex(2)))
    await expect(api.txHex(TXID_A)).rejects.toThrow(/different transaction/)
  })
})

describe('confirmedHistory', () => {
  it('builds the paged query and returns items ascending with the next token', async () => {
    const { api, calls } = harness(() =>
      json({
        result: [
          { tx_hash: TXID_C, height: 105 },
          { tx_hash: TXID_B, height: 103 },
          { tx_hash: TXID_A, height: 105 },
          { tx_hash: TXID_A.replace(/a$/, 'd'), height: 99 },
        ],
        nextPageToken: 'page-2',
      }),
    )
    await expect(api.confirmedHistory(ADDRESS, { fromHeight: 100, token: 'page 1', limit: 50 })).resolves.toEqual({
      items: [
        { txid: TXID_B, height: 103 },
        { txid: TXID_A, height: 105 },
        { txid: TXID_C, height: 105 },
      ],
      nextToken: 'page-2',
    })
    expect(calls[0].url).toBe(`${BASE}/address/${ADDRESS}/confirmed/history?order=asc&limit=50&height=100&token=page%201`)
  })

  it('defaults the limit, accepts next_page_token and bare arrays', async () => {
    const snake = harness(() => json({ result: [{ tx_hash: TXID_A, height: 5 }], next_page_token: 'n2' }))
    await expect(snake.api.confirmedHistory(ADDRESS)).resolves.toEqual({ items: [{ txid: TXID_A, height: 5 }], nextToken: 'n2' })
    expect(snake.calls[0].url).toBe(`${BASE}/address/${ADDRESS}/confirmed/history?order=asc&limit=1000`)

    const bare = harness(() => json([{ tx_hash: TXID_B, height: 6 }]))
    await expect(bare.api.confirmedHistory(ADDRESS)).resolves.toEqual({ items: [{ txid: TXID_B, height: 6 }] })
  })

  it('falls back to the legacy history on 404, keeping confirmed entries from fromHeight', async () => {
    const { api, calls } = harness((url) =>
      url.includes('/confirmed/history')
        ? text('', 404)
        : json([
            { tx_hash: TXID_C, height: 0 },
            { tx_hash: TXID_B, height: 210 },
            { tx_hash: TXID_A, height: 200 },
            { tx_hash: TXID_A.replace(/a$/, 'e'), height: 150 },
          ]),
    )
    await expect(api.confirmedHistory(ADDRESS, { fromHeight: 200 })).resolves.toEqual({
      items: [
        { txid: TXID_A, height: 200 },
        { txid: TXID_B, height: 210 },
      ],
    })
    expect(calls[1].url).toBe(`${BASE}/address/${ADDRESS}/history`)
  })
})

describe('unconfirmedHistory', () => {
  it.each([
    ['envelope', { result: [{ tx_hash: TXID_A }, { tx_hash: TXID_B }] }],
    ['array of objects', [{ tx_hash: TXID_A }, { tx_hash: TXID_B }]],
    ['array of strings', [TXID_A, TXID_B, TXID_A]],
  ])('reads the %s shape', async (_label, body) => {
    const { api, calls } = harness(() => json(body))
    await expect(api.unconfirmedHistory(ADDRESS)).resolves.toEqual([TXID_A, TXID_B])
    expect(calls[0].url).toBe(`${BASE}/address/${ADDRESS}/unconfirmed/history`)
  })

  it('treats 404 as an empty mempool', async () => {
    const { api } = harness(() => text('', 404))
    await expect(api.unconfirmedHistory(ADDRESS)).resolves.toEqual([])
  })
})

describe('broadcast', () => {
  const hex = sampleTxHex(3)
  const txid = Transaction.fromHex(hex).id('hex')

  it('POSTs {txhex} as JSON and reports the txid computed from the bytes', async () => {
    const { api, calls } = harness(() => text(JSON.stringify(txid)))
    await expect(api.broadcast(hex)).resolves.toEqual({ status: 'accepted', txid, alreadyKnown: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/tx/raw`)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ txhex: hex })
  })

  it('prefers the computed txid when the body disagrees', async () => {
    const { api } = harness(() => text(`"${TXID_A}"`))
    await expect(api.broadcast(hex)).resolves.toEqual({ status: 'accepted', txid, alreadyKnown: false })
  })

  it.each([
    [400, 'unexpected response code 500: 257: txn-already-known', 'accepted'],
    [400, 'Transaction already in the mempool', 'accepted'],
    [400, 'already in block chain', 'accepted'],
    [500, 'Missing inputs', 'conflict'],
    [400, '258: txn-mempool-conflict', 'conflict'],
    [400, 'bad-txns-inputs-missingorspent', 'conflict'],
    [400, 'double spend attempt', 'conflict'],
    [400, '66: insufficient priority', 'fee-too-low'],
    [400, 'mempool min fee not met', 'fee-too-low'],
    [429, 'Too Many Requests', 'ambiguous'],
    [503, 'Service Unavailable', 'ambiguous'],
    [400, '16: mandatory-script-verify-flag-failed', 'rejected'],
    [422, 'dust', 'rejected'],
  ])('classifies %i "%s" as %s', async (status, body, expected) => {
    const { api, calls } = harness(() => text(body, status))
    const outcome = await api.broadcast(hex)
    expect(outcome.status).toBe(expected)
    if (outcome.status === 'accepted') expect(outcome).toEqual({ status: 'accepted', txid, alreadyKnown: true })
    // Never retried, whatever the answer.
    expect(calls).toHaveLength(1)
  })

  it('reports a network failure as ambiguous without retrying', async () => {
    const { api, calls } = harness(() => new TypeError('Failed to fetch'))
    await expect(api.broadcast(hex)).resolves.toMatchObject({ status: 'ambiguous' })
    expect(calls).toHaveLength(1)
  })

  it('rejects malformed hex without a request', async () => {
    const { api, calls } = harness(() => text(''))
    await expect(api.broadcast('xyz')).resolves.toMatchObject({ status: 'rejected' })
    expect(calls).toHaveLength(0)
  })
})

describe('tipHeight', () => {
  it('reads blocks from /chain/info', async () => {
    const { api, calls } = harness(() => json({ chain: 'test', blocks: 1_650_000 }))
    await expect(api.tipHeight()).resolves.toBe(1_650_000)
    expect(calls[0].url).toBe(`${BASE}/chain/info`)
  })

  it('rejects an unexpected shape', async () => {
    const { api } = harness(() => json({ height: 'x' }))
    await expect(api.tipHeight()).rejects.toBeInstanceOf(ChainApiError)
  })
})
