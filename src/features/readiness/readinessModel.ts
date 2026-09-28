export type ReadinessTone = 'ok' | 'attention' | 'critical'

/** One colour scale for every readiness number: 85%+ is fine, 60%+ needs attention, below is critical. */
export const readinessTone = (percent: number): ReadinessTone => (percent >= 85 ? 'ok' : percent >= 60 ? 'attention' : 'critical')
