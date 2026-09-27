import type { UnitStatus } from '../runtime'

export const roleLabel = (role: string) => ({ MASTER: 'Master', INSTRUCTOR: 'Instructor', SUPPLY_OFFICER: 'Supply Officer', SUPPLY_ASSISTANT: 'Supply Assistant', PENDING: 'Waiting for admission' } as Record<string, string>)[role] ?? role

export function syncLabel(status: Pick<UnitStatus, 'state' | 'queued' | 'needsFunding'>) {
  if (status.needsFunding) return `NEEDS TESTNET COINS · ${status.queued} QUEUED`
  if (status.state === 'offline') return status.queued ? `OFFLINE · ${status.queued} QUEUED` : 'OFFLINE · WORKING LOCALLY'
  if (status.state === 'error') return status.queued ? `SYNC ISSUE · ${status.queued} QUEUED` : 'SYNC ISSUE · RETRYING'
  if (status.state === 'starting' || status.state === 'syncing') return status.queued ? `SYNCING · ${status.queued} QUEUED` : 'SYNCING'
  return status.queued ? `${status.queued} QUEUED` : 'SYNCHRONIZED'
}
