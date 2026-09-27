import { resolveBlockchainMode, type BlockchainMode } from '../blockchain/config'

/** Outside mock-development, the app must go through first-run/unlock/admission before a runtime controller exists. */
export function identityGateRequired(mode: BlockchainMode = resolveBlockchainMode(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE)) {
  return mode !== 'mock-development'
}
