export type EncryptedArgusEnvelope = {
  protocol: 'ARGUS_PRIVATE_EVENT'
  protocolVersion: 1
  organizationId: string
  eventId: string
  epochId: string
  senderPublicIdentity: string
  algorithm: 'AES-256-GCM'
  nonce: string
  ciphertext: string
  ciphertextHash: string
  signature: string
}

/**
 * Wraps a raw epoch key to one admitted device's ECDH public identity. Plaintext carries no
 * name, role, or anything derived from a person beyond the two public identities involved.
 */
export type KeyGrantRecord = {
  protocol: 'ARGUS_KEY_GRANT'
  protocolVersion: 1
  organizationId: string
  epochId: string
  granteePublicIdentity: string
  grantorPublicIdentity: string
  wrappedKey: string
  nonce: string
  signature: string
}

export type HistoryPage = { envelopes: unknown[]; cursor: string; hasMore?: boolean }
export type PublishResult = { accepted: true; duplicate: boolean; sequence: number }
export type ProviderHealth = { ok: boolean; provider: string; protocolVersion: number }
export interface PrivateHistoryProvider {
  readonly name: string
  publish(envelope: EncryptedArgusEnvelope): Promise<void | PublishResult>
  getSince(cursor?: string): Promise<HistoryPage>
  getByEventId(eventId: string): Promise<unknown | undefined>
  health?(): Promise<ProviderHealth>
}

export type KeyGrantPage = { records: KeyGrantRecord[]; cursor: string; hasMore?: boolean }
/** Carries KEY_GRANT records the same way a PrivateHistoryProvider carries event envelopes. */
export interface KeyGrantChainProvider {
  publishKeyGrant(record: KeyGrantRecord): Promise<void>
  getKeyGrantsSince(cursor?: string): Promise<KeyGrantPage>
}

/** Resolves an admitted device's ECDH public key from its signing public identity. Real discovery
 * (e.g. an on-chain announcement) is a composition-layer concern outside this module. */
export interface EcdhKeyDirectory {
  publicKeyFor(identity: string): Promise<CryptoKey>
}
