const DEFAULT_BASE = 'https://api.whatsonchain.com/v1/bsv/test'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_RETRY_DELAY_MS = 200

export type WhatsOnChainAddressHistoryEntry = { txHash: string; height: number | null }
export type TscMerkleProof = { index: number; txOrId: string; target: string; nodes: string[] }
export type WhatsOnChainBlockHeader = { hash: string; height: number; time: number; merkleroot: string; nonce: number; bits: string; version: number; previousblockhash?: string }
export type WhatsOnChainChainInfo = { blocks: number; bestblockhash: string }

export class WhatsOnChainError extends Error {
  constructor(public readonly status: number, public readonly path: string, message?: string) {
    super(message ?? `WhatsOnChain request to ${path} failed with status ${status}.`)
    this.name = 'WhatsOnChainError'
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A read-only WhatsOnChain testnet client behind an injectable fetcher, so callers never depend on a live network. */
export class WhatsOnChainTestnetClient {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly base: string = DEFAULT_BASE,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly retryDelayMs: number = DEFAULT_RETRY_DELAY_MS,
  ) {}

  async addressHistory(address: string): Promise<WhatsOnChainAddressHistoryEntry[]> {
    const path = `/address/${address}/history`
    const response = await this.request(path)
    const body = await response.json()
    if (!Array.isArray(body)) throw new WhatsOnChainError(response.status, path, 'WhatsOnChain returned an invalid address history response.')
    return (body as Array<{ tx_hash: string; height?: number }>).map(entry => ({
      txHash: entry.tx_hash,
      height: typeof entry.height === 'number' && entry.height > 0 ? entry.height : null,
    }))
  }

  async txHex(txHash: string): Promise<string> {
    const response = await this.request(`/tx/${txHash}/hex`)
    return response.text()
  }

  async merkleProof(txHash: string): Promise<TscMerkleProof> {
    const response = await this.request(`/tx/${txHash}/proof/tsc`)
    return response.json() as Promise<TscMerkleProof>
  }

  async blockHeader(hash: string): Promise<WhatsOnChainBlockHeader> {
    const response = await this.request(`/block/${hash}/header`)
    return response.json() as Promise<WhatsOnChainBlockHeader>
  }

  async chainInfo(): Promise<WhatsOnChainChainInfo> {
    const response = await this.request('/chain/info')
    return response.json() as Promise<WhatsOnChainChainInfo>
  }

  private async request(path: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetcher(`${this.base}${path}`, { signal: controller.signal })
        if (response.ok) return response
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) { await sleep(this.retryDelayMs); continue }
        throw new WhatsOnChainError(response.status, path)
      } catch (error) {
        if (error instanceof WhatsOnChainError) throw error
        if (error instanceof DOMException && error.name === 'AbortError') throw new WhatsOnChainError(0, path, `WhatsOnChain request to ${path} timed out after ${this.timeoutMs}ms.`)
        throw error
      } finally {
        clearTimeout(timeout)
      }
    }
  }
}
