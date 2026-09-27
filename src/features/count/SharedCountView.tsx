import { useId, useState, type FormEvent, type JSX } from 'react'
import { AlertTriangle, Ban, ClipboardCheck, RefreshCw, Users } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { CountPicker } from './CountPicker'
import { CancelCountDrawer, FinalizeCountDrawer } from './SessionDrawers'
import { FinalizedSummary, SessionSummary } from './SessionSummary'
import { SharedPanel } from './SharedPanel'
import { TallyCard } from './TallyCard'
import {
  acceptsContributions,
  defaultSessionName,
  errorMessage,
  findActiveSession,
  findLastReconciledSession,
  relativeTime,
  useNow,
} from './countModel'
import './count.css'

export type SharedCountViewProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  /** Returns "You" for projection.actor and display names for other members. */
  memberName: (publicIdentity: string) => string
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  /** Preselects this size, e.g. when jumping here from Inventory's "Count" action. */
  initialItemId?: string
}

type Selection = { catalogId?: string; itemId?: string }

const EXPLAINER = "Everyone's counts add up into one shared total. An officer finalizes the count to update on-hand."

const selectionFor = (projection: ArgusAppProjection, itemId?: string): Selection => {
  const variant = itemId ? projection.inventory.find(item => item.entityId === itemId) : undefined
  return variant ? { catalogId: variant.catalogId, itemId: variant.entityId } : {}
}

/**
 * Shared, additive physical counting. Each person keeps a private tally for a size and adds it to
 * the session's shared total; an officer finalizes, which replaces on-hand with the totals.
 */
export function SharedCountView({ projection, controller, can, memberName, onProjection, notify, initialItemId }: SharedCountViewProps): JSX.Element {
  const [selection, setSelection] = useState<Selection>(() => selectionFor(projection, initialItemId))
  const [seenInitialItemId, setSeenInitialItemId] = useState(initialItemId)
  const [drawer, setDrawer] = useState<'finalize' | 'cancel'>()
  const [syncing, setSyncing] = useState(false)
  const now = useNow()

  // The parent may point us at a different size while this view stays mounted.
  if (initialItemId !== seenInitialItemId) {
    setSeenInitialItemId(initialItemId)
    if (initialItemId) setSelection(selectionFor(projection, initialItemId))
  }

  const session = findActiveSession(projection.countSessions)
  const lastFinalized = findLastReconciledSession(projection.countSessions)
  const canCount = can('inventory.count')
  const canAdjust = can('inventory.adjust')

  const selectCatalog = (catalogId?: string) => {
    const variants = catalogId ? projection.inventory.filter(item => item.catalogId === catalogId && item.active) : []
    // Unsized items have exactly one variant, so there is nothing to choose.
    setSelection({ catalogId, itemId: variants.length === 1 ? variants[0].entityId : undefined })
  }
  const selectVariant = (itemId: string) => setSelection(selectionFor(projection, itemId))
  const sync = async () => {
    setSyncing(true)
    try {
      onProjection(await controller.sync())
    } catch (reason) {
      notify(errorMessage(reason, 'Could not reach the shared history. Your work is saved on this device.'))
    } finally {
      setSyncing(false)
    }
  }

  const syncButton = (
    <button type="button" className="secondary-button" disabled={syncing} onClick={() => void sync()}>
      <RefreshCw />
      {syncing ? 'Syncing…' : 'Sync now'}
    </button>
  )

  if (!session) {
    return (
      <div className="content shared-count">
        <section className="page-intro count-hero">
          <div>
            <p className="eyebrow">SHARED PHYSICAL COUNT</p>
            <h2>Count together.</h2>
            <p>{EXPLAINER}</p>
          </div>
          <div className="count-hero-actions">{syncButton}</div>
        </section>
        <StartCountPanel
          canStart={canCount}
          controller={controller}
          onStarted={next => {
            onProjection(next)
            notify('Shared count started. Everyone in the unit can add their counts now.')
          }}
        />
        {lastFinalized && <FinalizedSummary session={lastFinalized} inventory={projection.inventory} memberName={memberName} />}
      </div>
    )
  }

  const variant = projection.inventory.find(item => item.entityId === selection.itemId && item.active)
  const open = acceptsContributions(session)
  const readOnlyReason = !canCount
    ? 'Your role can view this count but not add to it.'
    : !open
      ? 'This count is closed to new contributions while it waits to be finalized.'
      : undefined
  const people = session.participants.length

  return (
    <div className="content shared-count">
      <section className="hero-row count-hero">
        <div>
          <div className="section-kicker">
            <span />
            <b>{open ? 'SHARED COUNT · LIVE' : 'SHARED COUNT · SUBMITTED'}</b>
            <span />
          </div>
          <h2>{session.scope}</h2>
          <p>{EXPLAINER}</p>
          <p className="count-meta">
            Started{session.createdBy ? ` by ${memberName(session.createdBy)}` : ''}
            {session.createdAt ? ` ${relativeTime(session.createdAt, now)}` : ''} · {people} {people === 1 ? 'person' : 'people'} counting
          </p>
        </div>
        <div className="count-hero-actions">
          {syncButton}
          {canAdjust && (
            <button type="button" className="gold-button" onClick={() => setDrawer('finalize')}>
              <ClipboardCheck />
              Finalize count
            </button>
          )}
          {canAdjust && (
            <button type="button" className="secondary-button" onClick={() => setDrawer('cancel')}>
              <Ban />
              Cancel count
            </button>
          )}
        </div>
      </section>
      {!open && (
        <div className="workflow-warning count-callout">
          <AlertTriangle />
          <div>
            <strong>Contributions are closed</strong>
            <p>This count was submitted for review. An officer can finalize it to update on-hand.</p>
          </div>
        </div>
      )}
      <CountPicker
        projection={projection}
        session={session}
        catalogId={selection.catalogId}
        itemId={variant?.entityId}
        canCreateSizes={can('inventory.create')}
        onSelectCatalog={selectCatalog}
        onSelectVariant={selectVariant}
        notify={notify}
      />
      {variant && (
        <div className="count-layout">
          <TallyCard
            key={`${session.sessionId}:${variant.entityId}`}
            sessionId={session.sessionId}
            variant={variant}
            canContribute={canCount && open}
            readOnlyReason={readOnlyReason}
            controller={controller}
            onProjection={onProjection}
            notify={notify}
          />
          <SharedPanel
            session={session}
            variant={variant}
            actor={projection.actor}
            canCorrect={canCount && open}
            memberName={memberName}
            controller={controller}
            onProjection={onProjection}
            notify={notify}
          />
        </div>
      )}
      <SessionSummary session={session} inventory={projection.inventory} memberName={memberName} onSelect={selectVariant} />
      {drawer === 'finalize' && (
        <FinalizeCountDrawer
          session={session}
          inventory={projection.inventory}
          controller={controller}
          close={() => setDrawer(undefined)}
          onFinalized={(next, countedSizes) => {
            setDrawer(undefined)
            onProjection(next)
            notify(`Count finalized — on-hand updated for ${countedSizes} size${countedSizes === 1 ? '' : 's'}.`)
          }}
        />
      )}
      {drawer === 'cancel' && (
        <CancelCountDrawer
          session={session}
          controller={controller}
          close={() => setDrawer(undefined)}
          onCancelled={next => {
            setDrawer(undefined)
            onProjection(next)
            notify('Count cancelled. No on-hand quantities changed.')
          }}
        />
      )}
    </div>
  )
}

function StartCountPanel({
  canStart,
  controller,
  onStarted,
}: {
  canStart: boolean
  controller: DistributedAppController
  onStarted: (projection: ArgusAppProjection) => void
}) {
  const id = useId()
  const [name, setName] = useState(defaultSessionName)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const start = async (event: FormEvent) => {
    event.preventDefault()
    const scope = name.trim()
    if (!scope || scope.length > 120) {
      setError('Give the count a name of up to 120 characters, e.g. “Fall inventory 2026”.')
      return
    }
    setBusy(true)
    setError('')
    try {
      onStarted(await controller.createCountSession({ sessionId: `count_${crypto.randomUUID()}`, scope }))
    } catch (reason) {
      setError(errorMessage(reason, 'The count could not be started. Try again.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="marble-card count-start" aria-labelledby={`${id}-heading`}>
      <div className="item-icon">
        <Users />
      </div>
      <h3 id={`${id}-heading`}>No shared count is open</h3>
      <p>{EXPLAINER}</p>
      <ol className="count-steps">
        <li>Start a count and give it a name everyone will recognise.</li>
        <li>Each person picks an item and size, tallies what they see, and adds it. Counts from different people add up.</li>
        <li>An officer reviews the shared totals and finalizes, which updates on-hand for everyone.</li>
      </ol>
      <form onSubmit={event => void start(event)} noValidate>
        <div className="field count-field">
          <label htmlFor={`${id}-name`}>Count name</label>
          <input
            id={`${id}-name`}
            maxLength={120}
            value={name}
            disabled={!canStart}
            aria-invalid={Boolean(error)}
            onChange={event => setName(event.target.value)}
          />
        </div>
        {error && (
          <p className="workflow-error" role="alert">
            <AlertTriangle />
            {error}
          </p>
        )}
        <button type="submit" className="primary-button" disabled={!canStart || busy}>
          {busy ? 'Starting…' : 'Start shared count'}
        </button>
        {!canStart && <p className="safe-note">Your role can’t start a count. Ask a supply officer to start one.</p>}
      </form>
    </section>
  )
}
