import { useId, type JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { cadetsMissingStandardIssue } from '../../stage3/readiness'
import './readiness.css'

/**
 * Cadets who are not fully issued because they lack standard-issue (NSU + PT) gear, even though
 * nobody recorded it as Still Needed — e.g. a new cadet who has been issued nothing yet. Shown with
 * Still Needed so the dashboard's CADETS number always matches what this screen lists.
 */
export function StandardIssueGaps({ projection, openCadet }: { projection: ArgusAppProjection; openCadet?: (cadetId: string) => void }): JSX.Element | null {
  const id = useId()
  const gaps = cadetsMissingStandardIssue(projection)
  if (!gaps.length) return null
  return (
    <section className="standard-issue-gaps" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Missing standard issue ({gaps.length})</h3>
      <p>Active cadets who do not hold every item of the NSU and PT bundles that apply to them.</p>
      <ul className="event-readiness-list">
        {gaps.map(entry => {
          const detail = entry.missing.map(item => `${item.label}${item.sized ? ` (${item.size ?? 'size?'})` : ''}`).join(', ')
          const body = (
            <span>
              <strong>{entry.label}</strong>
              <small>{detail}</small>
            </span>
          )
          return (
            <li key={entry.cadetId}>
              {openCadet ? (
                <button type="button" className="event-readiness-cadet" aria-label={`Open cadet ${entry.label}`} onClick={() => openCadet(entry.cadetId)}>
                  {body}
                  <ChevronRight aria-hidden="true" />
                </button>
              ) : (
                body
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
