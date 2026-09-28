import { defineConfig } from 'vitest/config'

// Live BSV TESTNET checks. Never part of `npm test` or CI: they spend real (test) satoshis and
// need network access to api.whatsonchain.com. Run with `npm run test:testnet` after
// `npm run testnet:keys` and funding the printed address from a testnet faucet.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('0.1.0') },
  test: {
    include: ['testnet/**/*.testnet.ts'],
    environment: 'node',
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
})
