import type { AuthorizationService } from '../auth/authorization'
import type { AuthorityCredential, AuthorityRevocation, SignedArgusEvent } from '../distributed/types'
import type { EventSyncProvider } from '../sync/mock'
import { openEnvelope, sealEnvelope } from './envelope'
import type { LedgerStore } from './ledgerStore'

export type UnitSyncProviderDependencies = {
  unitId: string
  store: LedgerStore
  currentEpoch: () => string
  keyFor: (epochId: string) => Promise<CryptoKey | undefined>
  /** This device's own current credential (it changes when a Master changes this person's role); it travels inside every envelope this device writes. */
  credential: () => AuthorityCredential
  authorization: AuthorizationService
  /** Called after a local event is durably queued so the chain transport can publish promptly. */
  onQueued?: () => void
}

/**
 * Bridges the replica (plaintext, in memory) and the ledger store (ciphertext, on disk).
 *
 * publish(): encrypt the signed event together with the author's credential and store the
 *            envelope durably as QUEUED. Idempotent per event ID; the stored bytes never change,
 *            so a retried publication is byte-identical on chain.
 * pull():    decrypt envelopes that arrived from the chain (or were on disk at startup) and have
 *            not yet been handed to the replica. Before an event is returned, the credential it
 *            carries is verified against the unit authority, so every device can check every
 *            member's role without any directory server.
 */
export class UnitEventSyncProvider implements EventSyncProvider {
  private readonly delivered = new Set<string>()
  private readonly backlog = new Set<string>()
  private readonly acceptedCredentials = new Set<string>()
  private readonly acceptedRevocations = new Set<string>()
  /** Credentials whose issuer (a delegated Master) is not known yet; retried after every pull until their issuer's credential arrives. */
  private readonly pendingCredentials = new Map<string, AuthorityCredential>()
  /** Revocations can arrive before the credential they revoke (history is not delivered in causal order); they are retried the same way. */
  private readonly pendingRevocations = new Map<string, AuthorityRevocation>()
  /** Envelopes that could not be opened yet (no key for their epoch, damaged): retried on each pull. */
  readonly unreadable = new Map<string, string>()

  constructor(private readonly deps: UnitSyncProviderDependencies) {}

  /** Loads every stored envelope ID so the first pull rebuilds the whole projection from disk. */
  async prime() { for (const record of await this.deps.store.envelopes()) if (!this.delivered.has(record.eventId)) this.backlog.add(record.eventId) }
  enqueueRemote(eventIds: string[]) { for (const id of eventIds) if (!this.delivered.has(id)) this.backlog.add(id) }

  async publish(event: SignedArgusEvent) {
    if (this.delivered.has(event.eventId) || await this.deps.store.envelope(event.eventId)) { this.delivered.add(event.eventId); this.backlog.delete(event.eventId); return }
    // A new key generation is announced under the previous key: remaining members can read it, and only they can unwrap their copy.
    const epochId = event.eventType === 'UNIT_KEY_ROTATED' && typeof event.payload.previousEpoch === 'string' ? event.payload.previousEpoch : this.deps.currentEpoch(), key = await this.deps.keyFor(epochId)
    if (!key) throw new Error(`This device has no unit key for ${epochId}.`)
    const envelope = await sealEnvelope({ unitId: this.deps.unitId, epochId, key, plaintext: { event, credential: this.deps.credential() } })
    await this.deps.store.addEnvelope({ eventId: event.eventId, envelope, origin: 'local', status: 'QUEUED', addedAt: new Date().toISOString() })
    this.delivered.add(event.eventId); this.backlog.delete(event.eventId)
    this.deps.onQueued?.()
  }

  async pull(): Promise<SignedArgusEvent[]> {
    const events: SignedArgusEvent[] = []
    for (const eventId of [...this.backlog]) {
      const record = await this.deps.store.envelope(eventId)
      if (!record) { this.backlog.delete(eventId); continue }
      try {
        const { event, credential } = await openEnvelope(record.envelope, this.deps.keyFor)
        if (credential) await this.acceptCredential(credential)
        await this.acceptAuthorityPayload(event)
        events.push(event)
        this.delivered.add(eventId); this.backlog.delete(eventId); this.unreadable.delete(eventId)
      } catch (error) { this.unreadable.set(eventId, error instanceof Error ? error.message : 'Unreadable record.') }
    }
    await this.retryPendingCredentials()
    return events
  }

  /** Accepts a credential now if its issuer is known, otherwise keeps it until the issuer's own credential arrives. */
  async offerCredential(credential: AuthorityCredential) { await this.acceptCredential(credential); await this.retryPendingCredentials() }
  private async retryPendingCredentials() {
    for (let progress = true; progress && (this.pendingCredentials.size || this.pendingRevocations.size);) {
      progress = false
      for (const credential of [...this.pendingCredentials.values()]) { if (await this.tryAccept(credential)) { this.pendingCredentials.delete(credential.credentialId); progress = true } }
      for (const revocation of [...this.pendingRevocations.values()]) { if (await this.tryRevoke(revocation)) { this.pendingRevocations.delete(revocation.revocationId); progress = true } }
    }
  }
  private async tryRevoke(revocation: AuthorityRevocation) {
    try { await this.deps.authorization.acceptRevocation(revocation); this.acceptedRevocations.add(revocation.revocationId); return true } catch { return false }
  }

  /** The transaction each event arrived in (or was published in), so every device links every change to the chain. */
  async transactionIds(eventIds: string[]) {
    const found: Record<string, string> = {}
    for (const eventId of eventIds) { const txid = (await this.deps.store.envelope(eventId))?.txid; if (txid) found[eventId] = txid }
    return found
  }

  private async acceptCredential(credential: AuthorityCredential) {
    if (this.acceptedCredentials.has(credential.credentialId)) return
    // An invalid or foreign credential is simply not accepted; the replica then rejects that author's events as unauthorized
    // (and re-folds them once a later credential makes them valid). Unknown issuers are retried; the list is bounded.
    if (!(await this.tryAccept(credential)) && this.pendingCredentials.size < 1_000) this.pendingCredentials.set(credential.credentialId, credential)
  }
  private async tryAccept(credential: AuthorityCredential) {
    try { await this.deps.authorization.acceptCredential(credential); this.acceptedCredentials.add(credential.credentialId); return true } catch { return false }
  }
  private async acceptAuthorityPayload(event: SignedArgusEvent) {
    if (event.eventType === 'AUTHORITY_GRANTED' && event.payload.credential) await this.acceptCredential(event.payload.credential as AuthorityCredential)
    if (event.eventType === 'ROLE_CHANGED' && event.payload.credential) await this.acceptCredential(event.payload.credential as AuthorityCredential)
    if ((event.eventType === 'AUTHORITY_REVOKED' || event.eventType === 'ROLE_CHANGED') && event.payload.revocation) {
      const revocation = event.payload.revocation as AuthorityRevocation
      if (this.acceptedRevocations.has(revocation.revocationId)) return
      // Unknown credential (not delivered yet) or bad signature: retried after each pull; a forged one simply never applies.
      if (!(await this.tryRevoke(revocation)) && this.pendingRevocations.size < 1_000) this.pendingRevocations.set(revocation.revocationId, revocation)
    }
  }
}
