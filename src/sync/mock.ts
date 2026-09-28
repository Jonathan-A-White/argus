import type { SignedArgusEvent } from '../distributed/types'

export interface EventSyncProvider {
  publish(event: SignedArgusEvent): Promise<unknown>
  pull(): Promise<SignedArgusEvent[]>
  /** The chain transaction that carried each pulled event, where the provider knows it. */
  transactionIds?(eventIds: string[]): Promise<Record<string, string>>
  /** Throws if this event could never be published (e.g. too large), before it is applied locally. */
  preflight?(event: SignedArgusEvent): Promise<void>
  /** Pulled events the replica could not fold: hand them over again on the next pull. */
  requeue?(eventIds: string[]): void
}

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
}
