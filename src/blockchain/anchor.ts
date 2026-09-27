import { Hash, P2PKH, Utils, type LockingScript } from '@bsv/sdk'
import { assertTestnetOnly } from './ArgusWalletAdapter'

const ANCHOR_LABEL = 'argus-unit-anchor:'
const TESTNET_PREFIX = [0x6f]

/** A fixed, non-spendable 20-byte pubkey hash derived from the organizationId; not a real key, just a chain-visible label. */
function unitAnchorHash(organizationId: string): number[] {
  return Hash.sha256(`${ANCHOR_LABEL}${organizationId}`, 'utf8').slice(0, 20)
}

export function unitAnchorAddress(organizationId: string, network: 'mainnet' | 'testnet' = 'testnet'): string {
  assertTestnetOnly(network.toUpperCase())
  return Utils.toBase58Check(unitAnchorHash(organizationId), TESTNET_PREFIX)
}

export function anchorLockingScript(address: string): LockingScript {
  return new P2PKH().lock(address)
}
