/**
 * LIVE BSV TESTNET proof of the owner's acceptance scenario, end to end, with no server:
 *
 *   1. A Master creates a unit (fresh unit ID ⇒ fresh anchor address) with a faucet-funded wallet.
 *   2. The Master admits Officer B and Assistant C by exchanging public codes and tops up
 *      their wallets from its own — each person has their own key; nothing secret is shared.
 *   3. A adds sizes to PT Shorts and opens a shared count; everything is encrypted and written
 *      to testnet; B and C discover it by walking the anchor address history on WhatsOnChain.
 *   4. A counts 3 PT Shorts (M) and B counts 3 PT Shorts (M) → every device shows 6.
 *   5. A finalizes → on-hand 6 on every device.
 *   6. A brand-new device with an empty local ledger rebuilds the same state from chain alone.
 *
 * Run: npm run testnet:keys (once; fund the printed address) then npm run test:testnet
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WhatsOnChainApi } from '../src/chain/woc'
import { DeviceWallet } from '../src/chain/wallet'
import { MemoryWalletStateStore } from '../src/chain/walletStore'
import { GENESIS_CATALOG } from '../src/stage3/domain'
import { MemoryLedgerStore } from '../src/unit/ledgerStore'
import { UnitRuntime } from '../src/unit/runtime'
import { acceptAdmission, createJoiningDevice, createMasterDevice, encodeJoinRequest } from '../src/unit/vault'

const KEY_FILE = process.env.ARGUS_TESTNET_KEYS ?? join(homedir(), '.config', 'argus', 'testnet-keys.json')
const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const MIN_MASTER_SATOSHIS = 12_000
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const log = (line: string) => process.stdout.write(`${new Date().toISOString()}  ${line}\n`)

/** WhatsOnChain indexes mempool transactions within seconds, but not instantly: poll until a condition holds. */
async function until<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 4 * 60_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (ok(value)) { log(`✓ ${label} (${Math.round((Date.now() - started) / 1000)} s)`); return value }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${label}`)
    await sleep(6_000)
  }
}

const keys = existsSync(KEY_FILE) ? JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { master: { wif: string; address: string } } : undefined

describe.skipIf(!keys)('LIVE BSV TESTNET: shared count across three devices', () => {
  it('A counts 3 + B counts 3 = 6 on every device, finalizes to on-hand 6, and a fresh device rebuilds it from chain', async () => {
    const api = new WhatsOnChainApi()
    const funded = await DeviceWallet.fromWif(keys!.master.wif, api, new MemoryWalletStateStore()).refresh()
    log(`Master wallet ${funded.address}: ${funded.spendable} spendable satoshis (${funded.confirmed} confirmed)`)
    if (funded.spendable < MIN_MASTER_SATOSHIS) throw new Error(`Fund ${funded.address} with at least ${MIN_MASTER_SATOSHIS} testnet satoshis from a BSV testnet faucet, then rerun.`)

    const masterDevice = await createMasterDevice({ passphrase: 'live testnet check 1', displayName: 'Master A', unitName: `ARGUS live check ${new Date().toISOString().slice(0, 16)}`, walletWif: keys!.master.wif }, storage())
    const open = (device: typeof masterDevice) => UnitRuntime.open(device, { api, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: storage() })
    const a = await open(masterDevice)
    log(`Unit ${masterDevice.record.unit!.unitId} · anchor ${a.transport.anchorAddress}`)
    const members: UnitRuntime[] = []
    for (const [name, role] of [['Officer B', 'SUPPLY_OFFICER'], ['Assistant C', 'SUPPLY_ASSISTANT']] as const) {
      const pending = await createJoiningDevice({ passphrase: 'live testnet check 2', displayName: name }, storage())
      const admitted = await a.admit(await encodeJoinRequest(pending), role, { topUpSatoshis: 3_000 })
      if (admitted.topUpError) throw new Error(admitted.topUpError)
      log(`Admitted ${name}; top-up tx ${admitted.topUpTxid}`)
      members.push(await open(await acceptAdmission(pending, admitted.admissionCode, storage())))
    }
    const [b, c] = members

    await a.controller.addCatalogSizes(PT_SHORTS, ['S', 'M', 'L'])
    const projection = await a.controller.createCountSession({ sessionId: `count_${crypto.randomUUID()}`, scope: 'Live testnet count' })
    const sessionId = projection.countSessions[0].sessionId
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!.entityId
    await a.syncNow()
    log(`A published setup: ${JSON.stringify(a.status())}`)
    await until('B sees the count session', () => b.syncNow(), view => view.countSessions.some(session => session.sessionId === sessionId))

    await a.controller.contributeCount(sessionId, { itemId: medium }, 3, 'Shelf A')
    await b.controller.contributeCount(sessionId, { itemId: medium }, 3, 'Shelf B')
    await a.syncNow(); await b.syncNow()
    const totalOf = (view: typeof projection) => view.countSessions.find(session => session.sessionId === sessionId)?.totals[medium]
    for (const [name, runtime] of [['A', a], ['B', b], ['C', c]] as const) await until(`${name} shows a shared total of 6`, () => runtime.syncNow(), view => totalOf(view) === 6)

    await a.controller.finalizeCountSession(sessionId)
    await a.syncNow()
    for (const [name, runtime] of [['A', a], ['B', b], ['C', c]] as const) await until(`${name} shows on-hand 6 after finalization`, () => runtime.syncNow(), view => view.inventory.find(item => item.entityId === medium)?.onHand === 6)

    const fresh = await open(b.device)
    const rebuilt = await until('a brand-new device rebuilds on-hand 6 from chain alone', () => fresh.syncNow(), view => view.inventory.find(item => item.entityId === medium)?.onHand === 6)
    expect(totalOf(rebuilt)).toBe(6)
    expect(rebuilt.members.map(member => member.displayName).sort()).toEqual(['Assistant C', 'Master A', 'Officer B'])

    const txids = [...new Set((await a.controller.project()).events.flatMap(record => record.transactionId ? [record.transactionId] : []))]
    const report = { at: new Date().toISOString(), unitId: masterDevice.record.unit!.unitId, anchor: a.transport.anchorAddress, anchorExplorer: `https://test.whatsonchain.com/address/${a.transport.anchorAddress}`, transactions: txids.map(txid => `https://test.whatsonchain.com/tx/${txid}`), masterBalanceAfter: (await a.balance()).spendable }
    writeFileSync(join(process.cwd(), 'testnet', 'last-run.json'), JSON.stringify(report, null, 2))
    log(`Report written to testnet/last-run.json\n${JSON.stringify(report, null, 2)}`)
    expect(txids.length).toBeGreaterThan(0)
  })
})
