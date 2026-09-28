import type { EventDelivery } from '../distributed/delivery'
import type { SignedArgusEvent } from '../distributed/types'

export interface EventSyncProvider {
  publish(event: SignedArgusEvent): Promise<unknown>
  pull(): Promise<SignedArgusEvent[]>
  /** The chain transaction that carried each pulled event, where the provider knows it. */
  transactionIds?(eventIds: string[]): Promise<Record<string, string>>
  /**
   * Where each of these records stands on its way to the shared ledger (queued, publishing, on
   * chain, mined), for the ones the provider holds. The replica shows exactly this instead of
   * guessing from whether a publish call returned.
   */
  deliveryStatus?(eventIds: string[]): Promise<Record<string, EventDelivery>>
}

/** Stands in for the shared ledger in tests and the mock-development demo. Nothing leaves the device, so every record it holds is LOCAL. */
export class MockSyncProvider implements EventSyncProvider {
  private events = new Map<string, SignedArgusEvent>()
  unavailable = false
  duplicateDelivery = false
  reorderDelivery = false
  async publish(event: SignedArgusEvent) {
    if (this.unavailable) throw new Error('Sync provider unavailable.')
    this.events.set(event.eventId, structuredClone(event))
  }
  async pull(): Promise<SignedArgusEvent[]> {
    if (this.unavailable) throw new Error('Sync provider unavailable.')
    let values = [...this.events.values()].map(event => structuredClone(event))
    if (this.reorderDelivery) values = values.reverse()
    return this.duplicateDelivery ? values.flatMap(event => [event, structuredClone(event)]) : values
  }
  async deliveryStatus(eventIds: string[]) {
    const local: EventDelivery = { syncStatus: 'LOCAL', auditStatus: 'NOT_SUBMITTED' }
    return Object.fromEntries(eventIds.filter(eventId => this.events.has(eventId)).map(eventId => [eventId, { ...local }]))
  }
}
