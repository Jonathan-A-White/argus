import { plural } from '../../plural'
import type { UnitStatus } from '../runtime'

export const roleLabel = (role: string) => ({ MASTER: 'Master', INSTRUCTOR: 'Instructor', SUPPLY_OFFICER: 'Supply Officer', SUPPLY_ASSISTANT: 'Supply Assistant', PENDING: 'Waiting for admission' } as Record<string, string>)[role] ?? role

export function syncLabel(status: Pick<UnitStatus, 'state' | 'queued' | 'needsFunding'>) {
  if (status.needsFunding) return `NEEDS TESTNET COINS · ${status.queued} QUEUED`
  if (status.state === 'offline') return status.queued ? `OFFLINE · ${status.queued} QUEUED` : 'OFFLINE · WORKING LOCALLY'
  if (status.state === 'error') return status.queued ? `SYNC ISSUE · ${status.queued} QUEUED` : 'SYNC ISSUE · RETRYING'
  if (status.state === 'starting' || status.state === 'syncing') return status.queued ? `SYNCING · ${status.queued} QUEUED` : 'SYNCING'
  return status.queued ? `${status.queued} QUEUED` : 'SYNCHRONIZED'
}

/**
 * Plain words for a chain error. The technical text (HTTP status, CORS, txids) stays available
 * for diagnostics, but people see what it means for them.
 */
export function plainChainError(technical?: string) {
  const text = technical ?? ''
  if (!text) return 'The BSV testnet service could not be reached.'
  if (/could not reach|failed to fetch|network|timed? ?out|offline|rate.?limit|\b429\b|cors/i.test(text)) return 'The BSV testnet service could not be reached (no connection, or it is busy).'
  if (/\b5\d\d\b/.test(text)) return 'The BSV testnet service is having problems right now.'
  if (/refused|rejected|\b4\d\d\b/.test(text)) return 'The BSV testnet service refused the request.'
  if (/unexpected shape|invalid json|malformed|different transaction/i.test(text)) return 'The BSV testnet service sent an answer this app could not read.'
  if (/never appeared on chain|withdrawn/i.test(text)) return 'A change did not reach the chain and is being published again.'
  return 'The BSV testnet service did not answer as expected.'
}

/** What a "Sync now" actually achieved, read from the status after the attempt (never "synchronized" when it failed). */
export function syncOutcome(status: Pick<UnitStatus, 'state' | 'queued' | 'needsFunding' | 'lastError'>): { ok: boolean; message: string } {
  const saved = status.queued ? ` ${plural(status.queued, 'change')} ${status.queued === 1 ? 'is' : 'are'} saved on this device and will publish automatically.` : ' Your work is saved on this device.'
  if (status.needsFunding) return { ok: false, message: `Not published: this device needs testnet coins to publish ${plural(status.queued, 'queued change')}. Ask your Master for a top-up.` }
  if (status.state === 'synced') return { ok: true, message: status.queued ? `Synchronized with BSV testnet; ${plural(status.queued, 'change')} still waiting to publish.` : 'Synchronized with BSV testnet.' }
  if (status.state === 'offline') return { ok: false, message: `This device is offline, so it could not sync with BSV testnet.${saved}` }
  if (status.state === 'error') return { ok: false, message: `Could not sync with BSV testnet. ${plainChainError(status.lastError)}${saved}` }
  return { ok: false, message: `Still syncing with BSV testnet.${saved}` }
}
