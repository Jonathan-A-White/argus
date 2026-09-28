#!/usr/bin/env node
// Creates (once) and prints the BSV TESTNET key used by `npm run test:testnet`.
// The key file lives OUTSIDE the repository (default ~/.config/argus/testnet-keys.json, mode 0600)
// and is never committed. Only the public address is printed. Fund it from a BSV testnet faucet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'

const file = process.env.ARGUS_TESTNET_KEYS ?? join(homedir(), '.config', 'argus', 'testnet-keys.json')
if (!existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const key = PrivateKey.fromRandom()
  writeFileSync(file, JSON.stringify({ version: 1, network: 'testnet', master: { wif: key.toWif([0xef]), address: key.toAddress('testnet') } }, null, 2), { mode: 0o600, flag: 'wx' })
  process.stdout.write(`Created ${file}\n`)
}
const keys = JSON.parse(readFileSync(file, 'utf8'))
if (keys.network !== 'testnet' || !keys.master?.address) throw new Error(`${file} is not an A.R.G.U.S. testnet key file.`)
process.stdout.write([
  '',
  'A.R.G.U.S. live testnet check — funding address (TESTNET ONLY, never send mainnet BSV):',
  `  ${keys.master.address}`,
  '',
  `Explorer: https://test.whatsonchain.com/address/${keys.master.address}`,
  'Send at least 1,000 testnet satoshis from any BSV testnet faucet (one run uses well under that), then run: npm run test:testnet',
  '',
].join('\n'))
