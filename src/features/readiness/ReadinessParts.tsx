import type { JSX } from 'react'
import { ChevronRight, CircleAlert, CircleCheck } from 'lucide-react'
import type { AmiCategory } from '../../stage3/amiReadiness'
import type { RolloverCheck } from '../../stage3/endOfYear'
import type { AlertTarget } from '../../stage3/readinessTypes'
import { readinessTone } from './readinessModel'
import './readiness.css'

/** Accessible 0–100 meter, coloured by the shared readiness scale. */
export function ReadinessMeter({ label, percent, small = false }: { label: string; percent: number; small?: boolean }): JSX.Element {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div
      className={`readiness-meter tone-${readinessTone(value)}${small ? ' small' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  )
}

/** The six AMI readiness categories (spec §17), each with its explanation and a link to the screen that fixes it. */
export function AmiCategoryList({ categories, navigate }: { categories: AmiCategory[]; navigate?: (target: AlertTarget) => void }): JSX.Element {
  return (
    <ul className="readiness-categories" aria-label="AMI readiness categories">
      {categories.map(category => (
        <li key={category.key} className={`tone-${readinessTone(category.percent)}`}>
          <div className="readiness-category-head">
            <strong>{category.label}</strong>
            <b>{category.percent}%</b>
          </div>
          <ReadinessMeter label={`${category.label} readiness`} percent={category.percent} small />
          <p>{category.detail}</p>
          {navigate && category.percent < 100 && (
            <button type="button" className="text-button readiness-link" onClick={() => navigate(category.target)}>
              Review {category.label} <ChevronRight aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Annual rollover readiness (spec §19): what should be true before cadets advance a year. */
export function RolloverChecklist({ checklist }: { checklist: RolloverCheck[] }): JSX.Element {
  return (
    <ul className="rollover-checklist" aria-label="Rollover readiness checklist">
      {checklist.map(check => (
        <li key={check.key} className={check.done ? 'done' : 'open'}>
          {check.done ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
          <span>
            <strong>
              <span className="sr-only">{check.done ? 'Done: ' : 'Not done: '}</span>
              {check.label}
            </strong>
            <small>{check.detail}</small>
          </span>
        </li>
      ))}
    </ul>
  )
}
