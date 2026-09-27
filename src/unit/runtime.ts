import { AuthorizationService, issueRevocation } from '../auth/authorization'
import type { ChainApi, WalletBalance, WalletStateStore } from '../chain/types'
import { DeviceWallet } from '../chain/wallet'
import { IndexedDbWalletStateStore } from '../chain/walletStore'
import { WhatsOnChainApi } from '../chain/woc'
import { DistributedAppController, type ArgusAppProjection } from '../distributed/appIntegration'
import type { ArgusRole } from '../distributed/types'
import { MemoryRepository } from '../storage/repository'
import { IndexedDbLedgerStore, type LedgerStore } from './ledgerStore'
import { UnitEventSyncProvider } from './syncProvider'
import { ChainTransport, type TransportStatus } from './transport'
import { openEnvelope } from './envelope'
import { admitMember, type UnlockedDevice } from './vault'

export type UnitRuntimeOptions = {
  api?: ChainApi
  ledger?: LedgerStore
  walletStore?: WalletStateStore
  /** Where the Master's admission list is saved (defaults to localStorage). */
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}
export type UnitStatus = TransportStatus & { unitId: string; unitName: string; role: ArgusRole; displayName: string; walletAddress: string; unreadable: number }
/** Default satoshis the Master sends a newly admitted member so they can publish right away (≈ 400+ records at 1 sat/kB). Editable at admission. */
export const DEFAULT_MEMBER_TOP_UP_SATOSHIS = 2_000

/**
 * Everything one unlocked, admitted device needs to share the unit's data over BSV TESTNET:
 * its own identity and wallet, the unit key, an encrypted local ledger, the chain transport, and
 * the application controller whose projection every screen reads.
 */
export class UnitRuntime {
  private listeners = new Set<(projection: ArgusAppProjection) => void>()
  private statusListeners = new Set<(status: UnitStatus) => void>()
  private constructor(
    readonly device: UnlockedDevice,
    readonly controller: DistributedAppController,
    readonly transport: ChainTransport,
    readonly wallet: DeviceWallet,
    readonly authorization: AuthorizationService,
    private readonly provider: UnitEventSyncProvider,
    private readonly options: UnitRuntimeOptions,
  ) {}

  static async open(device: UnlockedDevice, options: UnitRuntimeOptions = {}) {
    const { record } = device, unit = record.unit
    if (!unit || !record.credential || record.role === 'PENDING') throw new Error('This device has not been admitted to a unit yet.')
    const authorization = new AuthorizationService(unit.authorityIdentity, device.identity)
    await authorization.acceptCredential(record.credential)
    const api = options.api ?? new WhatsOnChainApi()
    const ledger = options.ledger ?? new IndexedDbLedgerStore(unit.unitId)
    const wallet = DeviceWallet.fromWif(device.walletWif, api, options.walletStore ?? new IndexedDbWalletStateStore())
    // The provider, transport and runtime refer to each other through callbacks that only run after construction.
    const late: { transport?: ChainTransport; runtime?: UnitRuntime } = {}
    const provider = new UnitEventSyncProvider({ unitId: unit.unitId, store: ledger, currentEpoch: () => unit.currentEpoch, keyFor: async epoch => device.unitKeys.get(epoch), credential: record.credential, authorization, onQueued: () => { void late.transport?.poke() } })
    const controller = new DistributedAppController(new MemoryRepository(), { identity: device.identity, authorization, provider, organizationId: unit.unitId, genesisCatalog: true, strictPublish: true })
    const transport = late.transport = new ChainTransport({
      unitId: unit.unitId, api, wallet, store: ledger,
      onRemoteEnvelopes: async records => { provider.enqueueRemote(records.map(item => item.eventId)); const projection = await controller.sync(); late.runtime?.emit(projection) },
      onPublished: async (eventIds, txid) => { const projection = await controller.markPublished(eventIds, txid); late.runtime?.emit(projection) },
      onStatus: () => late.runtime?.emitStatus(),
      checkEnvelope: async envelope => { try { await openEnvelope(envelope, async epoch => device.unitKeys.get(epoch)); return 'valid' } catch (error) { return error instanceof Error && error.message.startsWith('NO_EPOCH_KEY') ? 'unknown' : 'invalid' } },
    })
    await provider.prime()
    const runtime = late.runtime = new UnitRuntime(device, controller, transport, wallet, authorization, provider, options)
    const projection = await controller.initialize()
    // The Master introduces itself once, so every other device can show its name instead of a key.
    if (record.role === 'MASTER' && !projection.members.some(member => member.publicIdentity === record.signingIdentity))
      await controller.recordAdmission({ credential: record.credential, displayName: record.displayName, walletAddress: record.walletAddress })
    return runtime
  }

  start(intervalMs?: number) { this.transport.start(intervalMs) }
  stop() { this.transport.stop() }
  /** Publish anything queued and pull everything new right now. */
  async syncNow() { await this.transport.poke(); const projection = await this.controller.sync(); this.emit(projection); return projection }
  onProjection(listener: (projection: ArgusAppProjection) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onStatus(listener: (status: UnitStatus) => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  private emit(projection: ArgusAppProjection) { for (const listener of this.listeners) listener(projection) }
  private emitStatus() { const status = this.status(); for (const listener of this.statusListeners) listener(status) }
  status(): UnitStatus {
    const { record } = this.device
    return { ...this.transport.status(), unitId: record.unit!.unitId, unitName: record.unit!.unitName, role: record.role as ArgusRole, displayName: record.displayName, walletAddress: record.walletAddress, unreadable: this.provider.unreadable.size }
  }
  balance(): Promise<WalletBalance> { return this.wallet.refresh() }

  /**
   * Master only. Admits the person behind a join code: returns the admission code to hand them,
   * publishes the admission to the whole unit (encrypted), and optionally sends their wallet some
   * testnet satoshis so they can publish immediately.
   */
  async admit(joinCode: string, role: Exclude<ArgusRole, 'MASTER'>, options: { expiresAt?: string; displayName?: string; topUpSatoshis?: number } = {}) {
    const result = await admitMember(this.device, joinCode, role, { ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}), ...(options.displayName ? { displayName: options.displayName } : {}), ...(this.options.storage ? { storage: this.options.storage } : {}) })
    await this.controller.recordAdmission({ credential: result.credential, displayName: result.displayName, walletAddress: result.walletAddress })
    let topUpTxid: string | undefined, topUpError: string | undefined
    if (options.topUpSatoshis) { try { topUpTxid = await this.sendSatoshis(result.walletAddress, options.topUpSatoshis) } catch (error) { topUpError = error instanceof Error ? error.message : 'Top-up failed.' } }
    void this.transport.poke()
    return { ...result, ...(topUpTxid ? { topUpTxid } : {}), ...(topUpError ? { topUpError } : {}) }
  }
  /** Master only: revoke a member from now on. Their past work stays in history. */
  async revoke(publicIdentity: string) {
    const signer = this.device.authoritySigner, member = this.device.record.admissions?.find(entry => entry.credential.subjectPublicIdentity === publicIdentity)
    if (!signer || !member) throw new Error('Only the Master that admitted this person can revoke them.')
    const revocation = await issueRevocation(signer, member.credential, new Date().toISOString())
    const projection = await this.controller.recordRevocation(revocation)
    void this.transport.poke(); return projection
  }
  /** Sends testnet satoshis from this device's wallet (e.g. the Master topping up a member). */
  async sendSatoshis(address: string, satoshis: number) {
    const prepared = await this.wallet.prepareTransfer(address, satoshis)
    const flushed = await this.wallet.flush()
    const rolledBack = flushed.rolledBack.find(entry => entry.txid === prepared.txid)
    if (rolledBack) throw new Error(`The top-up was refused by the network: ${rolledBack.reason}`)
    return prepared.txid
  }
}
