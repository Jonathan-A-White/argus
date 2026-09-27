export type BlockchainMode = 'embedded-testnet' | 'external-brc100-testnet' | 'unconfigured' | 'mock-development'

export function resolveBlockchainMode(value: string | undefined): BlockchainMode {
  const mode = (value ?? 'unconfigured').toLowerCase()
  if (mode === 'mainnet') throw new Error('BSV mainnet integration is disabled in this build.')
  if (!['embedded-testnet', 'external-brc100-testnet', 'unconfigured', 'mock-development'].includes(mode)) throw new Error(`Unsupported A.R.G.U.S. blockchain mode: ${value}`)
  if (mode === 'mock-development' && import.meta.env.PROD) throw new Error('Mock wallets cannot be used in a production build.')
  return mode as BlockchainMode
}

/** Every chain code path calls this before touching a network: there is no mainnet adapter at all. */
export function assertTestnetOnly(network: string): asserts network is 'TESTNET' {
  if (network !== 'TESTNET') throw new Error('Only BSV TESTNET is permitted; mainnet is disabled and has no adapter.')
}
