import { AuthorizationService, ROLE_PERMISSIONS, issueCredential, issueRevocation } from '../auth/authorization'
import type { ChainApi, WalletBalance, WalletStateStore } from '../chain/types'
import { DeviceWallet } from '../chain/wallet'
import { IndexedDbWalletStateStore } from '../chain/walletStore'
import { WhatsOnChainApi } from '../chain/woc'
import { canonicalize } from '../distributed/canonical'
import { DistributedAppController, type ArgusAppProjection } from '../distributed/appIntegration'
import type { ArgusRole, AuthorityCredential } from '../distributed/types'
import { unsignedKeyGrantFields, unwrapEpochKeyFromGrant, wrapEpochKeyForGrant } from '../private-sync/keyGrant'
import { parseKeyGrantRecord } from '../private-sync/schema'
import type { KeyGrantRecord } from '../private-sync/types'
import { MemoryRepository } from '../storage/repository'
import { IndexedDbLedgerStore, type LedgerStore } from './ledgerStore'
import { UnitEventSyncProvider } from './syncProvider'
import { ChainTransport, type TransportStatus } from './transport'
import { openEnvelope } from './envelope'
import { admitMember, exportRecoveryFile, installUnitKey, newUnitKey, recoveryFingerprint, recoveryGranteeIdentity, setCurrentEpoch, updateDeviceCredential, type UnlockedDevice } from './vault'

export type UnitRuntimeOptions = {
  api?: ChainApi
  ledger?: LedgerStore
  walletStore?: WalletStateStore
  /** Where the device record is saved (defaults to localStorage). */
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}
/** revoked: a Master removed this person; the device can still show what it knew but nothing it does is accepted. */
export type UnitStatus = TransportStatus & { unitId: string; unitName: string; role: ArgusRole; displayName: string; walletAddress: string; unreadable: number; revoked: boolean; holdsAuthority: boolean; currentEpoch: string }
/** Default satoshis the Master sends a newly admitted member so they can publish right away (≈ 400+ records at 1 sat/kB). Editable at admission. */
export const DEFAULT_MEMBER_TOP_UP_SATOSHIS = 2_000
export type KeyRotationResult = { epochId: string; recipients: number; missing: string[] }

const importEcdhPublic = (spki: string) => { const normalized = spki.replaceAll('-', '+').replaceAll('_', '/'); const bytes = Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)); return crypto.subtle.importKey('spki', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }

/**
 * Everything one unlocked, admitted device needs to share the unit's data over BSV TESTNET:
 * its own identity and wallet, the unit key, an encrypted local ledger, the chain transport, and
 * the application controller whose projection every screen reads.
 */
export class UnitRuntime {
  private listeners = new Set<(projection: ArgusAppProjection) => void>()
  private statusListeners = new Set<(status: UnitStatus) => void>()
  private revoked = false
  private reconciling?: Promise<ArgusAppProjection>
  private constructor(
    readonly device: UnlockedDevice,
    readonly controller: DistributedAppController,
    readonly transport: ChainTransport,
    readonly wallet: DeviceWallet,
    readonly authorization: AuthorizationService,
    private readonly provider: UnitEventSyncProvider,
    private readonly options: UnitRuntimeOptions,
  ) {}

  private get storage() { return this.options.storage ?? localStorage }

  static async open(device: UnlockedDevice, options: UnitRuntimeOptions = {}) {
    const { record } = device, unit = record.unit
    if (!unit || !record.credential || record.role === 'PENDING') throw new Error('This device has not been admitted to a unit yet.')
    const authorization = new AuthorizationService(unit.authorityIdentity, device.identity)
    const api = options.api ?? new WhatsOnChainApi()
    const ledger = options.ledger ?? new IndexedDbLedgerStore(unit.unitId)
    const wallet = DeviceWallet.fromWif(device.walletWif, api, options.walletStore ?? new IndexedDbWalletStateStore())
    // The provider, transport and runtime refer to each other through callbacks that only run after construction.
    const late: { transport?: ChainTransport; runtime?: UnitRuntime } = {}
    // Epoch and credential are read live: a key rotation or role change takes effect for the very next record.
    const provider = new UnitEventSyncProvider({ unitId: unit.unitId, store: ledger, currentEpoch: () => device.record.unit!.currentEpoch, keyFor: async epoch => device.unitKeys.get(epoch), credential: () => device.record.credential!, authorization, onQueued: () => { void late.transport?.poke() } })
    // A device admitted by a delegated Master needs that Master's credential before its own can be verified.
    if (record.issuerCredential) await provider.offerCredential(record.issuerCredential)
    await provider.offerCredential(record.credential)
    const controller = new DistributedAppController(new MemoryRepository(), { identity: device.identity, authorization, provider, organizationId: unit.unitId, genesisCatalog: true, strictPublish: true })
    const transport = late.transport = new ChainTransport({
      unitId: unit.unitId, api, wallet, store: ledger,
      onRemoteEnvelopes: async records => { provider.enqueueRemote(records.map(item => item.eventId)); await late.runtime?.settle(await controller.sync()) },
      onPublished: async (eventIds, txid) => { await late.runtime?.settle(await controller.markPublished(eventIds, txid)) },
      // Rolled back, re-queued, seen on chain, mined: only the records' delivery changed, so just show it.
      onDelivery: async eventIds => { if (late.runtime) late.runtime.emit(await controller.refreshDelivery(eventIds)) },
      onStatus: () => late.runtime?.emitStatus(),
      checkEnvelope: async envelope => { try { await openEnvelope(envelope, async epoch => device.unitKeys.get(epoch)); return 'valid' } catch (error) { return error instanceof Error && error.message.startsWith('NO_EPOCH_KEY') ? 'unknown' : 'invalid' } },
    })
    await provider.prime()
    const runtime = late.runtime = new UnitRuntime(device, controller, transport, wallet, authorization, provider, options)
    let projection = await controller.initialize()
    // A Master introduces itself once, so every other device can show its name instead of a key and can hand it future unit keys.
    if (record.role === 'MASTER' && !projection.members.some(member => member.publicIdentity === record.signingIdentity && member.credentialId === record.credential!.credentialId))
      projection = await controller.recordAdmission({ credential: record.credential, displayName: record.displayName, walletAddress: record.walletAddress, ecdhPublicKey: record.ecdhPublicKey })
    await runtime.reconcile(projection)
    return runtime
  }

  start(intervalMs?: number) { this.transport.start(intervalMs) }
  stop() { this.transport.stop() }
  /** Publish anything queued and pull everything new right now. */
  async syncNow() { await this.transport.poke(); return this.settle(await this.controller.sync()) }
  onProjection(listener: (projection: ArgusAppProjection) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onStatus(listener: (status: UnitStatus) => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  private emit(projection: ArgusAppProjection) { for (const listener of this.listeners) listener(projection) }
  private emitStatus() { const status = this.status(); for (const listener of this.statusListeners) listener(status) }
  /** Applies what a new projection means for this device (new unit keys, a changed role, removal), then shows it. */
  private async settle(projection: ArgusAppProjection) { const settled = await this.reconcile(projection); this.emit(settled); return settled }
  status(): UnitStatus {
    const { record } = this.device
    return { ...this.transport.status(), unitId: record.unit!.unitId, unitName: record.unit!.unitName, role: record.role as ArgusRole, displayName: record.displayName, walletAddress: record.walletAddress, unreadable: this.provider.unreadable.size, revoked: this.revoked, holdsAuthority: Boolean(this.device.authoritySigner), currentEpoch: record.unit!.currentEpoch }
  }
  balance(): Promise<WalletBalance> { return this.wallet.refresh() }

  // ---------- keeping this device in step with the unit ----------
  private reconcile(projection: ArgusAppProjection): Promise<ArgusAppProjection> {
    // One at a time: a reconcile can itself sync (after installing a key), which must not start another.
    const run = (this.reconciling ?? Promise.resolve(projection)).then(() => this.reconcileOnce(projection))
    this.reconciling = run.finally(() => { if (this.reconciling === guarded) this.reconciling = undefined })
    const guarded = this.reconciling
    return run
  }
  private async reconcileOnce(initial: ArgusAppProjection): Promise<ArgusAppProjection> {
    let projection = initial
    for (let round = 0; round < 4; round++) {
      await this.adoptOwnCredential(projection)
      const installed = await this.installGrantedKeys(projection)
      this.adoptCurrentEpoch(projection)
      if (!installed) break
      // Records sealed under a key this device just received become readable: fold them in.
      projection = await this.controller.sync().catch(() => this.controller.project())
    }
    this.emitStatus()
    return projection
  }
  private async adoptOwnCredential(projection: ArgusAppProjection) {
    const { record } = this.device, me = projection.members.find(member => member.publicIdentity === record.signingIdentity)
    if (!me) return
    this.revoked = me.status === 'REVOKED'
    if (me.status !== 'ACTIVE' || me.credentialId === record.credential?.credentialId || !me.credentialEventId) return
    const credential = projection.events.find(stored => stored.event.eventId === me.credentialEventId)?.event.payload.credential as AuthorityCredential | undefined
    if (!credential || credential.credentialId !== me.credentialId || credential.subjectPublicIdentity !== record.signingIdentity || !this.authorization.hasCredential(credential.credentialId)) return
    await updateDeviceCredential(this.device, credential, this.storage)
  }
  /** Opens this device's copy of every unit key generation it has been given (directly, or through the unit recovery key). */
  private async installGrantedKeys(projection: ArgusAppProjection) {
    let installed = 0
    const recoveryId = this.device.record.recoveryPublicKey && this.device.recoveryEcdhPrivateKey ? recoveryGranteeIdentity(await recoveryFingerprint(this.device.record.recoveryPublicKey)) : undefined
    for (const epoch of projection.keyEpochs) {
      if (this.device.unitKeys.has(epoch.epochId)) continue
      const event = projection.events.find(stored => stored.event.eventId === epoch.eventId)?.event
      const payload = event?.payload as { grants?: unknown[]; grantorEcdhPublicKey?: string } | undefined
      if (!event || !payload?.grantorEcdhPublicKey || !Array.isArray(payload.grants)) continue
      const grants = payload.grants.map(grant => parseKeyGrantRecord(grant))
      const mine = grants.find(grant => grant.granteePublicIdentity === this.device.record.signingIdentity), viaRecovery = !mine && recoveryId ? grants.find(grant => grant.granteePublicIdentity === recoveryId) : undefined
      const grant = mine ?? viaRecovery
      if (!grant || grant.grantorPublicIdentity !== event.actorPublicIdentity || !(await this.device.identity.verify(canonicalize(unsignedKeyGrantFields(grant)), grant.signature, grant.grantorPublicIdentity))) continue
      try {
        const key = await unwrapEpochKeyFromGrant(grant, { granteeEcdhPrivateKey: mine ? this.device.ecdhPrivateKey : this.device.recoveryEcdhPrivateKey!, grantorEcdhPublicKey: await importEcdhPublic(payload.grantorEcdhPublicKey), extractable: true })
        await installUnitKey(this.device, epoch.epochId, key, { makeCurrent: false }, this.storage)
        installed++
      } catch { /* wrapped for a different key pair: not this device's to open */ }
    }
    return installed
  }
  /** Every device writes with the newest key generation it holds; concurrent rotations resolve to the same one everywhere (canonical order). */
  private adoptCurrentEpoch(projection: ArgusAppProjection) {
    const newest = [...projection.keyEpochs].reverse().find(epoch => this.device.unitKeys.has(epoch.epochId))
    if (newest) setCurrentEpoch(this.device, newest.epochId, this.storage)
  }

  // ---------- Master actions ----------
  private requireMaster() { if (this.device.record.role !== 'MASTER' || this.revoked) throw new Error('Only a unit Master can do this.') }
  /**
   * Master only. Admits the person behind a join code: returns the admission code to hand them,
   * publishes the admission to the whole unit (encrypted), and optionally sends their wallet some
   * testnet satoshis so they can publish immediately. Making someone a Master needs the unit authority.
   */
  async admit(joinCode: string, role: ArgusRole, options: { expiresAt?: string; displayName?: string; topUpSatoshis?: number } = {}) {
    this.requireMaster()
    const result = await admitMember(this.device, joinCode, role, { ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}), ...(options.displayName ? { displayName: options.displayName } : {}), storage: this.storage })
    await this.controller.recordAdmission({ credential: result.credential, displayName: result.displayName, walletAddress: result.walletAddress, ecdhPublicKey: result.ecdhPublicKey })
    let topUpTxid: string | undefined, topUpError: string | undefined
    if (options.topUpSatoshis) { try { topUpTxid = await this.sendSatoshis(result.walletAddress, options.topUpSatoshis) } catch (error) { topUpError = error instanceof Error ? error.message : 'Top-up failed.' } }
    void this.transport.poke()
    return { ...result, ...(topUpTxid ? { topUpTxid } : {}), ...(topUpError ? { topUpError } : {}) }
  }
  private signerFor(targetRole: ArgusRole, newRole?: ArgusRole) {
    // Masters are made and removed only with the unit authority key; everyone else by any Master's own key.
    if (targetRole === 'MASTER' || newRole === 'MASTER') { if (!this.device.authoritySigner) throw new Error(newRole === 'MASTER' ? 'Only the unit authority (the original or a recovered Master device) can make someone a Master.' : 'Only the unit authority (the original or a recovered Master device) can remove a Master.'); return this.device.authoritySigner }
    return this.device.authoritySigner ?? this.device.identity
  }
  private async activeMember(publicIdentity: string) {
    const projection = await this.controller.project(), member = projection.members.find(candidate => candidate.publicIdentity === publicIdentity && candidate.status === 'ACTIVE')
    if (!member) throw new Error('That person is not an active member.')
    if (publicIdentity === this.device.record.signingIdentity) throw new Error('You cannot change your own access.')
    return member
  }
  /**
   * Master only: removes a person from now on. Their past work stays in history, and the unit key is
   * replaced so they cannot read anything written after this moment.
   */
  async revoke(publicIdentity: string): Promise<ArgusAppProjection & { rotation: KeyRotationResult }> {
    this.requireMaster()
    const member = await this.activeMember(publicIdentity)
    const revocation = await issueRevocation(this.signerFor(member.role), { credentialId: member.credentialId, subjectPublicIdentity: member.publicIdentity } as AuthorityCredential, new Date().toISOString())
    await this.controller.recordRevocation(revocation)
    const rotation = await this.rotateUnitKey('REVOCATION')
    return { ...(await this.settle(await this.controller.project())), rotation }
  }
  /** Master only: gives a person a different role (a new credential replaces the old one in one signed event). */
  async changeRole(publicIdentity: string, role: ArgusRole) {
    this.requireMaster()
    const member = await this.activeMember(publicIdentity)
    if (member.role === role) throw new Error(`${member.displayName} is already ${role}.`)
    const signer = this.signerFor(member.role, role), now = new Date().toISOString()
    const credential = await issueCredential(signer, { subjectPublicIdentity: member.publicIdentity, role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: now, ...(member.expiresAt && member.expiresAt > now ? { expiresAt: member.expiresAt } : {}) })
    const revocation = await issueRevocation(signer, { credentialId: member.credentialId, subjectPublicIdentity: member.publicIdentity } as AuthorityCredential, now)
    const projection = await this.controller.changeRole({ credential, revocation })
    void this.transport.poke()
    return this.settle(projection)
  }
  /**
   * Master only: creates a new unit key and hands one wrapped copy to every active member (and to
   * the unit recovery key). The announcement is encrypted under the old key; members who were
   * removed can read the announcement but cannot open any copy, nor anything written afterwards.
   */
  async rotateUnitKey(reason: 'REVOCATION' | 'MANUAL' = 'MANUAL'): Promise<KeyRotationResult> {
    this.requireMaster()
    const { record } = this.device, projection = await this.controller.project(), unit = record.unit!
    const { epochId, key, raw } = await newUnitKey(this.device)
    const recipients = projection.members.filter(member => member.status === 'ACTIVE'), missing = recipients.filter(member => !member.ecdhPublicKey && member.publicIdentity !== record.signingIdentity).map(member => member.displayName)
    const wrap = async (grantee: string, publicKey: string) => wrapEpochKeyForGrant({ epochKey: key, organizationId: unit.unitId, epochId, granteePublicIdentity: grantee, grantorPublicIdentity: record.signingIdentity, grantorEcdhPrivateKey: this.device.ecdhPrivateKey, granteeEcdhPublicKey: await importEcdhPublic(publicKey), grantorSigner: this.device.identity })
    const grants: KeyGrantRecord[] = [await wrap(record.signingIdentity, record.ecdhPublicKey)]
    for (const member of recipients) if (member.ecdhPublicKey && member.publicIdentity !== record.signingIdentity) grants.push(await wrap(member.publicIdentity, member.ecdhPublicKey))
    if (projection.recoveryKey) grants.push(await wrap(recoveryGranteeIdentity(projection.recoveryKey.fingerprint), projection.recoveryKey.publicKey))
    await this.controller.rotateUnitKey({ epochId, previousEpoch: unit.currentEpoch, reason, grants, grantorEcdhPublicKey: record.ecdhPublicKey })
    await installUnitKey(this.device, epochId, raw, { makeCurrent: true }, this.storage)
    void this.transport.poke()
    this.emitStatus()
    return { epochId, recipients: grants.length - (projection.recoveryKey ? 1 : 0), missing }
  }
  /**
   * Original (or recovered) Master only: an encrypted recovery file for getting the unit authority
   * back on a new device. Registers the recovery key with the unit so future key generations stay
   * openable from the file.
   */
  async exportRecovery(recoveryPassphrase: string) {
    this.requireMaster()
    const result = await exportRecoveryFile(this.device, recoveryPassphrase, this.storage)
    const projection = await this.controller.project()
    if (projection.recoveryKey?.fingerprint !== result.fingerprint) {
      await this.controller.registerRecoveryKey({ publicKey: result.publicKey, fingerprint: result.fingerprint })
      // Key generations created before the recovery key existed are already in the file; later ones will include it.
    }
    void this.transport.poke()
    return result.fileText
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
