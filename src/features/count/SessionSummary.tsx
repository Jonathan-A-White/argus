import { useId } from 'react'
import { AlertTriangle, History } from 'lucide-react'
import type { CountSessionProjection, InventoryProjection } from '../../distributed/types'
import { countedRows, initials, relativeTime, signed, useNow } from './countModel'

const differenceClass = (difference: number) => (difference === 0 ? 'count-diff zero' : difference > 0 ? 'count-diff up' : 'count-diff down')
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function People({ participants, memberName }: { participants: string[]; memberName: (publicIdentity: string) => string }) {
  return (
    <div className="count-people">
      <small>PEOPLE COUNTING ({participants.length})</small>
      {participants.length ? (
        <ul aria-label="People counting">
          {participants.map(participant => {
            const name = memberName(participant)
            return (
              <li key={participant}>
                <span className="count-avatar" aria-hidden="true">
                  {initials(name)}
                </span>
                {name}
              </li>
            )
          })}
        </ul>
      ) : (
        <p>No one has added a count yet.</p>
      )}
    </div>
  )
}

/** Every size counted so far in the open session, with the live shared total next to official on-hand. */
export function SessionSummary({
  session,
  inventory,
  memberName,
  onSelect,
}: {
  session: CountSessionProjection
  inventory: InventoryProjection[]
  memberName: (publicIdentity: string) => string
  onSelect: (itemId: string) => void
}) {
  const headingId = useId()
  const rows = countedRows(session, inventory)
  return (
    <section className="table-card count-summary" aria-labelledby={headingId}>
      <div className="count-summary-head">
        <div>
          <small className="operational-label">Session summary</small>
          <h3 id={headingId}>Everything counted so far</h3>
        </div>
        <span className="status-badge">{plural(rows.length, 'size')}</span>
      </div>
      {rows.length ? (
        <div className="count-table-wrap">
          <table className="count-table">
            <thead>
              <tr>
                <th scope="col">Item · size</th>
                <th scope="col">Shared total</th>
                <th scope="col">On hand</th>
                <th scope="col">Difference</th>
                <th scope="col">Counters</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.itemId}>
                  <th scope="row">
                    <button type="button" className="count-row-link" onClick={() => onSelect(row.itemId)}>
                      {row.label}
                    </button>
                  </th>
                  <td>{row.total}</td>
                  <td>{row.onHand}</td>
                  <td className={differenceClass(row.difference)}>{signed(row.difference)}</td>
                  <td>{row.contributors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">
          <strong>Nothing counted yet</strong>
          <span>Pick an item above, tally what you see, then add it to the shared total.</span>
        </p>
      )}
      <People participants={session.participants} memberName={memberName} />
    </section>
  )
}

/** Result of the most recent finalized count, including anything that needs a second look. */
export function FinalizedSummary({
  session,
  inventory,
  memberName,
}: {
  session: CountSessionProjection
  inventory: InventoryProjection[]
  memberName: (publicIdentity: string) => string
}) {
  const now = useNow()
  const headingId = useId()
  const rows = countedRows(session, inventory).filter(row => row.itemId in session.totals)
  const labelFor = (itemId: string) => rows.find(row => row.itemId === itemId)?.label ?? 'Removed item'
  const moved = (session.movementWarnings ?? []).map(labelFor)
  const late = session.lateEventIds.length
  return (
    <section className="table-card count-summary count-finalized" aria-labelledby={headingId}>
      <div className="count-summary-head">
        <div>
          <small className="operational-label">Last finalized count</small>
          <h3 id={headingId}>{session.scope}</h3>
          <p>
            Finalized{session.reconciledBy ? ` by ${memberName(session.reconciledBy)}` : ''}
            {session.reconciledAt ? ` · ${relativeTime(session.reconciledAt, now)}` : ''} · {plural(rows.length, 'size')} updated
          </p>
        </div>
      </div>
      {moved.length > 0 && (
        <div className="workflow-warning count-callout">
          <AlertTriangle />
          <div>
            <strong>Stock moved during this count — verify</strong>
            <p>Issues, returns or receipts happened while these were being counted: {moved.join(', ')}. Recheck those shelves.</p>
          </div>
        </div>
      )}
      {late > 0 && (
        <div className="workflow-warning count-callout">
          <History />
          <div>
            <strong>{plural(late, 'late contribution')}</strong>
            <p>Arrived after the count was finalized. They are kept in history and did not change stock — start a new count if they matter.</p>
          </div>
        </div>
      )}
      {rows.length ? (
        <div className="count-table-wrap">
          <table className="count-table">
            <thead>
              <tr>
                <th scope="col">Item · size</th>
                <th scope="col">Before</th>
                <th scope="col">Counted</th>
                <th scope="col">On hand now</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.itemId}>
                  <th scope="row">{row.label}</th>
                  <td>{row.before ?? '—'}</td>
                  <td>{row.total}</td>
                  <td>{row.onHand}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">
          <strong>No sizes were counted</strong>
          <span>This count was finalized without contributions, so no stock changed.</span>
        </p>
      )}
      <People participants={session.participants} memberName={memberName} />
    </section>
  )
}
