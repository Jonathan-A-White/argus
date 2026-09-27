export type ArgusRole = 'MASTER' | 'INSTRUCTOR' | 'SUPPLY_OFFICER' | 'SUPPLY_ASSISTANT'

export const permissions = [
  'inventory.read', 'inventory.issue', 'inventory.return', 'inventory.count', 'inventory.adjust', 'inventory.create',
  'cadets.read', 'cadets.manage', 'calendar.read', 'calendar.write', 'bundles.read', 'bundles.manage',
  'audit.read', 'conflicts.resolve', 'users.authorize', 'users.revoke', 'users.manageRoles',
] as const
export type ArgusPermission = typeof permissions[number]

export type AuthorityCredential = {
  credentialVersion: 1
  credentialId: string
  subjectPublicIdentity: string
  role: ArgusRole
  permissions: ArgusPermission[]
  issuedAt: string
  issuedBy: string
  expiresAt?: string
  signature: string
}

export type AuthorityRevocation = {
  revocationVersion: 1
  revocationId: string
  credentialId: string
  subjectPublicIdentity: string
  effectiveAt: string
  issuedBy: string
  signature: string
}

export type DistributedEventType = 'INVENTORY_ITEM_CREATED' | 'INVENTORY_ITEM_UPDATED' | 'INVENTORY_RECEIVED' | 'CATALOG_ITEM_CREATED' | 'CATALOG_ITEM_UPDATED' | 'CATALOG_SIZES_ADDED' | 'ITEM_ISSUED' | 'ITEM_RETURNED' | 'INVENTORY_COUNT_SUBMITTED' | 'COUNT_SESSION_CREATED' | 'COUNT_CONTRIBUTED' | 'COUNT_CORRECTED' | 'COUNT_RECOUNTED' | 'COUNT_SESSION_SUBMITTED' | 'COUNT_SESSION_RECONCILED' | 'COUNT_SESSION_CANCELLED' | 'AUTHORITY_GRANTED' | 'AUTHORITY_REVOKED' | 'ROLE_CHANGED' | 'CONFLICT_DETECTED' | 'CONFLICT_RESOLVED' | 'RECORD_CORRECTED' | 'CADET_CREATED' | 'CADET_UPDATED' | 'BUNDLE_CREATED' | 'BUNDLE_UPDATED' | 'BUNDLE_DEACTIVATED' | 'STILL_NEEDED_ADDED' | 'STILL_NEEDED_UPDATED' | 'STILL_NEEDED_CANCELLED' | 'STILL_NEEDED_FULFILLED' | 'CALENDAR_EVENT_CREATED' | 'CALENDAR_EVENT_UPDATED' | 'CALENDAR_TASK_ADDED' | 'TASK_COMPLETED' | 'PROPERTY_CORRECTED' | 'ANNUAL_ROLLOVER_COMPLETED' | 'CADETS_IMPORTED'
export type LocalSyncStatus = 'LOCAL' | 'QUEUED' | 'SYNCING' | 'SYNCHRONIZED' | 'CONFLICT' | 'FAILED'

export type UnsignedArgusEvent = {
  protocol: 'ARGUS'
  protocolVersion: 1
  organizationId: string
  eventVersion: 1
  eventId: string
  eventType: DistributedEventType
  entityId: string
  actorPublicIdentity: string
  timestamp: string
  /**
   * Lamport clock: one more than the highest clock the author had seen. Every device folds
   * events in (clock, eventId) order, so the same set of events always yields the same state
   * no matter which order the chain delivered them in. Absent on legacy events (treated as 0).
   */
  clock?: number
  baseVersion?: number
  payload: Record<string, unknown>
}
export type SignedArgusEvent = UnsignedArgusEvent & { signature: string }

export type AuditDeliveryStatus = 'NOT_SUBMITTED' | 'PENDING' | 'BROADCAST' | 'CONFIRMED' | 'PROOF_VERIFIED' | 'FAILED'
export type StoredEvent = { event: SignedArgusEvent; syncStatus: LocalSyncStatus; auditStatus: AuditDeliveryStatus; receivedAt: string; transactionId?: string; blockHeight?: number }
export type OutboxRecord = { eventId: string; attempts: number; status: 'QUEUED' | 'SYNCING' | 'FAILED'; lastError?: string }
/** One projection represents exactly one stock keeping variant (one size of one catalog item). */
export type InventoryProjection = { entityId: string; catalogId?: string; name: string; category: string; variant: string; niin: string; onHand: number; issued: number; reorderAt?: number; countIncrement: number; active: boolean; version: number; appliedEventIds: string[] }
/**
 * A catalog item groups the sizes (inventory variants) of one kind of gear, e.g. "PT Shorts"
 * with sizes S/M/L. Unsized gear has exactly one variant labelled ONE_SIZE_LABEL.
 */
export type CatalogItemProjection = { catalogId: string; name: string; category: string; niin: string; sized: boolean; sizeScheme?: string; reorderAt?: number; countIncrement: number; active: boolean; origin: 'GENESIS' | 'EVENT'; version: number; appliedEventIds: string[] }
export type ConflictRecord = { id: string; entityId: string; eventIds: string[]; status: 'OPEN' | 'RESOLVED'; reason: string; resolutionEventId?: string; transactionId?: string; inventoryItemIds?: string[]; cadetId?: string }
/** A signed event that could not be applied in canonical order (missing dependency, invalid, unauthorized). Kept, never dropped: a later event may make it applicable. */
export type RejectedEventRecord = { eventId: string; eventType: DistributedEventType; reason: string }
export type MemberProjection = { publicIdentity: string; displayName: string; role: ArgusRole; credentialId: string; issuedAt: string; expiresAt?: string; walletAddress?: string; admittedBy: string; admittedEventId: string; status: 'ACTIVE' | 'REVOKED'; revokedAt?: string }

export type CountSessionStatus = 'DRAFT' | 'ACTIVE' | 'SUBMITTED' | 'RECONCILED' | 'CANCELLED'
export type CountAssignment = { assignmentId: string; itemId: string; scope: string; assignedTo?: string }
export type CountObservation = { eventId: string; itemId: string; assignmentId: string; actorPublicIdentity: string; quantity: number; effectiveQuantity: number; status: 'ACCEPTED' | 'SUPERSEDED' | 'CORRECTED' | 'LATE'; note?: string; timestamp?: string }
export type CountSessionProjection = {
  sessionId: string
  scope: string
  status: CountSessionStatus
  createdBy?: string
  createdAt?: string
  baseline: Record<string, { quantity: number; inventoryVersion: number }>
  assignments: CountAssignment[]
  participants: string[]
  observations: CountObservation[]
  totals: Record<string, number>
  acceptedEventIds?: string[]
  lateEventIds: string[]
  reconciledEventId?: string
  reconciledBy?: string
  reconciledAt?: string
  /** Counted items whose stock moved (issue/return/receive) between session start and finalization. Shown for review; never silently ignored. */
  movementWarnings?: string[]
  appliedEventIds: string[]
}

export type NsLevel = 'NS1' | 'NS2' | 'NS3' | 'NS4'
export type CadetGender = 'Male' | 'Female'
export type CurrentPropertyLine = { propertyId: string; itemId: string; label: string; variant: string; quantity: number; issuedAt: string; issueEventId: string; issueTransactionId: string; bundleId?: string; bundleVersion?: number }
/**
 * cadetCode is the short opaque ID shown everywhere by default (e.g. "C-4F7K"). fullName is
 * optional: when present it only ever travels inside AES-GCM ciphertext and lives in memory on
 * unlocked devices; it is never written to disk or the chain in plaintext.
 */
export type CadetProjection = { cadetId: string; cadetCode?: string; fullName: string; gender: CadetGender; profileNeedsReview?: boolean; nsLevel: NsLevel; status: 'ACTIVE' | 'INACTIVE'; sizes: Record<string, string>; currentProperty: CurrentPropertyLine[]; createdAt: string; updatedAt: string; version: number; appliedEventIds: string[] }
/** itemId pins one exact variant (legacy); catalogId names the catalog item whose size is chosen per cadet at issue time. */
export type BundleLineProjection = { lineId: string; itemId?: string; catalogId?: string; displayLabel: string; required: boolean; supportsSizing: boolean; defaultQuantity: number; order: number }
export type BundleVersionProjection = { bundleId: string; displayName: string; genderApplicability: CadetGender | 'Any'; purpose: string; lines: BundleLineProjection[]; active: boolean; version: number; createdAt: string; actorPublicIdentity: string; priorVersion?: number; eventId: string }
export type BundleProjection = { bundleId: string; currentVersion: number; versions: BundleVersionProjection[]; appliedEventIds: string[] }
export type StillNeededProjection = { requirementId: string; cadetId: string; itemId?: string; displayLabel: string; size?: string; quantityNeeded: number; quantityFulfilled: number; status: 'OPEN' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED'; firstNeededAt: string; updatedAt: string; source: 'MANUAL' | 'INCOMPLETE_ISSUE' | 'CORRECTION'; relatedTransactionIds?: string[]; relatedBundleId?: string; bundleVersion?: number; version: number; appliedEventIds: string[] }
export type SupplyTransactionLine = { lineId: string; itemId: string; label: string; variant: string; quantity: number; baseVersion: number; propertyId?: string; requirementId?: string }
export type MissingIssueLine = { lineId: string; itemId?: string; label: string; variant?: string; quantity: number; required: true }
export type SupplyTransaction = { transactionId: string; transactionType: 'ISSUE'|'RETURN'; cadetId: string; actorId: string; createdAt: string; eventId: string; bundleId?: string; bundleVersion?: number; bundleSnapshot?: BundleVersionProjection; lines: SupplyTransactionLine[]; missingLines?: MissingIssueLine[] }

/** Supply calendar (master spec §14–19). Dates are entered by hand each year; tasks are due relative to the event date. */
export type SupplyEventKind = 'NCO' | 'BLT' | 'AMI' | 'MILITARY_BALL' | 'END_OF_YEAR' | 'CUSTOM'
export type CalendarTaskProjection = { taskId: string; title: string; dueOffsetDays: number; completed: boolean; completedBy?: string; completedAt?: string }
export type CalendarEventProjection = { calendarEventId: string; kind: SupplyEventKind; title: string; startsAt: string; notes?: string; bundleIds: string[]; cadetIds: string[]; tasks: CalendarTaskProjection[]; active: boolean; createdBy: string; createdAt: string; version: number; appliedEventIds: string[] }
/** Append-only record that one issued line was wrong (e.g. 34R issued, 32R correct). The original issue event stays in history. */
export type PropertyCorrection = { correctionId: string; cadetId: string; propertyId: string; originalEventId: string; fromItemId: string; toItemId: string; quantity: number; reason: string; actor: string; at: string; eventId: string }
export type RolloverRecord = { schoolYear: string; eventId: string; at: string; actor: string; advanced: number; graduated: number }
