import { OP, Transaction, Utils } from '@bsv/sdk'
import { decodeEventOutput } from './EncryptedEventTestnet'

const TESTNET_PREFIX = [0x6f]

function isP2pkhLockingScript(chunks: Array<{ op: number; data?: number[] }>): boolean {
  return chunks.length === 5 && chunks[0]?.op === OP.OP_DUP && chunks[1]?.op === OP.OP_HASH160 && chunks[2]?.data?.length === 20 && chunks[3]?.op === OP.OP_EQUALVERIFY && chunks[4]?.op === OP.OP_CHECKSIG
}

/** Reads a raw testnet transaction and recovers the A.R.G.U.S. envelope plus, if present, the anchor output's address. */
export function decodeEventTransaction(txHex: string) {
  const transaction = Transaction.fromHex(txHex)
  const dataOutput = transaction.outputs.find(output => {
    const chunks = output.lockingScript.chunks
    return chunks[0]?.op === OP.OP_FALSE && chunks[1]?.op === OP.OP_RETURN
  })
  if (!dataOutput) throw new Error('Transaction does not contain an A.R.G.U.S. data output.')
  const envelope = decodeEventOutput(dataOutput.lockingScript.toHex())
  const anchorOutput = transaction.outputs.find(output => isP2pkhLockingScript(output.lockingScript.chunks))
  const anchorAddress = anchorOutput ? Utils.toBase58Check(anchorOutput.lockingScript.chunks[2].data as number[], TESTNET_PREFIX) : undefined
  return { envelope, anchorAddress }
}
