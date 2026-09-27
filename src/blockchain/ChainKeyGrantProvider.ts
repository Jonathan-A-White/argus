import { Transaction } from '@bsv/sdk'
import { anchorLockingScript, keyGrantAnchorAddress } from './anchor'
import type { ChainPrivateHistoryWallet } from './ChainPrivateHistoryProvider'
import { decodeKeyGrantOutput, encodeKeyGrantOutput } from './EncryptedEventTestnet'
import { InsufficientFundsError } from './ChainPrivateHistoryProvider'
import type { WhatsOnChainAddressHistoryEntry, WhatsOnChainTestnetClient } from './whatsonchain'
import { parseKeyGrantRecord } from '../private-sync/schema'
import type { KeyGrantChainProvider, KeyGrantPage, KeyGrantRecord } from '../private-sync/types'

const DATA_OUTPUT_SATOSHIS = 1
const ANCHOR_OUTPUT_SATOSHIS = 1
const MIN_FEE_ESTIMATE_SATOSHIS = 200
const PAGE_LIMIT = 25

type SortKey = { tier: 0 | 1; height: number; txid: string }
const sortKeyFor = (entry: WhatsOnChainAddressHistoryEntry): SortKey =>
  entry.height != null ? { tier: 0, height: entry.height, txid: entry.txHash } : { tier: 1, height: 0, txid: entry.txHash }
const compareSortKeys = (a: SortKey, b: SortKey): number =>
  a.tier !== b.tier ? a.tier - b.tier : a.height !== b.height ? a.height - b.height : a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0
const cursorFor = (entry: WhatsOnChainAddressHistoryEntry): string => `h:${entry.height ?? 'u'}:${entry.txHash}`

/** Extracts the OP_FALSE OP_RETURN data output from a raw transaction and decodes it as a KEY_GRANT record. */
function keyGrantFromTxHex(hex: string): KeyGrantRecord {
  const tx = Transaction.fromHex(hex)
  for (const output of tx.outputs) {
    try { return decodeKeyGrantOutput(output.lockingScript.toHex()) } catch { continue }
  }
  throw new Error('Transaction does not contain an A.R.G.U.S. key grant data output.')
}

/**
 * Publishes and reads ARGUS_KEY_GRANT records anchored to a key-grant-only address, kept distinct
 * from the unit's event anchor so this provider's scan never has to decode an event envelope.
 */
export class ChainKeyGrantProvider implements KeyGrantChainProvider {
  private readonly envelopeCache = new Map<string, KeyGrantRecord>()
  private readonly deliveredViaScan = new Set<string>()

  constructor(
    private readonly wallet: ChainPrivateHistoryWallet,
    private readonly client: WhatsOnChainTestnetClient,
    private readonly organizationId: string,
  ) {}

  async publishKeyGrant(input: KeyGrantRecord): Promise<void> {
    const record = parseKeyGrantRecord(input)
    if (record.organizationId !== this.organizationId) throw new Error('Cannot publish a key grant for another organization.')

    const status = await this.wallet.getStatus()
    const address = status.receivingAddress ?? ''
    const balance = status.balanceSatoshis ?? 0
    if (balance < DATA_OUTPUT_SATOSHIS + ANCHOR_OUTPUT_SATOSHIS + MIN_FEE_ESTIMATE_SATOSHIS) throw new InsufficientFundsError(address, balance)

    const anchorAddress = keyGrantAnchorAddress(this.organizationId)
    const result = await this.wallet.createAction({
      outputs: [
        { lockingScript: encodeKeyGrantOutput(record), satoshis: DATA_OUTPUT_SATOSHIS },
        { lockingScript: anchorLockingScript(anchorAddress).toHex(), satoshis: ANCHOR_OUTPUT_SATOSHIS },
      ],
    })
    if (!result.txid || !/^[0-9a-f]{64}$/i.test(result.txid)) throw new Error('Testnet wallet did not durably acknowledge a transaction ID; query before retrying.')
    this.envelopeCache.set(result.txid, record)
  }

  async getKeyGrantsSince(cursor = '0'): Promise<KeyGrantPage> {
    const anchorAddress = keyGrantAnchorAddress(this.organizationId)
    const history = await this.client.addressHistory(anchorAddress)
    const ordered = [...history].sort((a, b) => compareSortKeys(sortKeyFor(a), sortKeyFor(b)))
    const novel = ordered.filter(entry => !this.deliveredViaScan.has(entry.txHash))

    const page = novel.slice(0, PAGE_LIMIT)
    const records: KeyGrantRecord[] = []
    for (const entry of page) {
      const record = await this.resolveRecordForTx(entry.txHash)
      this.deliveredViaScan.add(entry.txHash)
      records.push(record)
    }

    const last = page[page.length - 1]
    return { records, cursor: last ? cursorFor(last) : cursor, hasMore: novel.length > PAGE_LIMIT }
  }

  private async resolveRecordForTx(txid: string): Promise<KeyGrantRecord> {
    const cached = this.envelopeCache.get(txid)
    if (cached) return cached
    const hex = await this.client.txHex(txid)
    const record = keyGrantFromTxHex(hex)
    this.envelopeCache.set(txid, record)
    return record
  }
}
