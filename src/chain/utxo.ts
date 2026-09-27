import type { ChainUtxo } from './types'

/** "txid:vout" — the identity of an output. */
export function outpointKey(outpoint: { txid: string; vout: number }): string {
  return `${outpoint.txid.toLowerCase()}:${outpoint.vout}`
}

/**
 * Collapses repeated outpoints into one entry, keeping the one with the greater height.
 * WhatsOnChain has been observed listing the same outpoint twice around confirmation
 * (once as mempool, once as mined); counting both would double the balance.
 * Output order follows each outpoint's first appearance.
 */
export function dedupeUtxos(utxos: readonly ChainUtxo[]): ChainUtxo[] {
  const byOutpoint = new Map<string, ChainUtxo>()
  for (const utxo of utxos) {
    const key = outpointKey(utxo)
    const existing = byOutpoint.get(key)
    if (!existing || utxo.height > existing.height) byOutpoint.set(key, { ...utxo })
  }
  return [...byOutpoint.values()]
}
