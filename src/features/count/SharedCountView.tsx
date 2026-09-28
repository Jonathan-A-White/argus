import { useId, useState, type FormEvent, type JSX } from 'react'
import { AlertTriangle, Ban, ClipboardCheck, RefreshCw, Send, Undo2, Users } from 'lucide-react'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, InventoryProjection, MemberProjection } from '../../distributed/types'
import { CountPicker } from './CountPicker'
import { CancelCountDrawer, FinalizeCountDrawer, SendBackDrawer, SubmitCountDrawer } from './SessionDrawers'
import { CountHistory, FinalizedSummary, SessionSummary } from './SessionSummary'
import { SharedPanel } from './SharedPanel'
import { TallyCard } from './TallyCard'
import {
  LIFECYCLE_LABEL,
  LIFECYCLE_TONE,
  MAX_ASSIGNED_SIZES,
  acceptsContributions,
  categoryAssignees,
  categoryAssignments,
  countLifecycle,
  countableCategories,
  defaultSessionName,
  errorMessage,
  findActiveSession,
  findLastReconciledSession,
  lateWork,
  lateWorkText,
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
type SessionDrawer = 'finalize' | 'cancel' | 'submit' | 'sendBack'

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
  const [drawer, setDrawer] = useState<SessionDrawer>()
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
          inventory={projection.inventory}
          members={projection.members.filter(member => member.status === 'ACTIVE')}
          memberName={memberName}
          onStarted={next => {
            onProjection(next)
            notify('Shared count started. Everyone in the unit can add their counts now.')
          }}
        />
        {lastFinalized && <FinalizedSummary session={lastFinalized} inventory={projection.inventory} memberName={memberName} />}
        <CountHistory sessions={projection.countSessions} memberName={memberName} />
      </div>
    )
  }

  const variant = projection.inventory.find(item => item.entityId === selection.itemId && item.active)
  const open = acceptsContributions(session)
  const lifecycle = countLifecycle(session, projection.events)
  const waiting = lifecycle === 'NEEDS_APPROVAL'
  const late = lateWorkText(lateWork(session))
  const assignees = categoryAssignees(session)
  const mine = [...assignees].filter(([, who]) => who === projection.actor).map(([category]) => category)
  const assignedLabel = (category: string) => {
    const who = assignees.get(category)
    return who ? (who === projection.actor ? 'Assigned to you' : `Assigned to ${memberName(who)}`) : undefined
  }
  const readOnlyReason = !canCount
    ? 'Your role can view this count but not add to it.'
    : !open
      ? 'This count is waiting for an officer’s approval, so it is closed to new contributions.'
      : undefined
  const people = session.participants.length

  return (
    <div className="content shared-count">
      <section className="hero-row count-hero">
        <div>
          <div className="section-kicker">
            <span />
            <b>SHARED COUNT · {LIFECYCLE_LABEL[lifecycle].toUpperCase()}</b>
            <span />
          </div>
          <h2>{session.scope}</h2>
          <p>{EXPLAINER}</p>
          <p className="count-meta">
            <em className={`status-badge count-lifecycle ${LIFECYCLE_TONE[lifecycle]}`}>{LIFECYCLE_LABEL[lifecycle]}</em> Started
            {session.createdBy ? ` by ${memberName(session.createdBy)}` : ''}
            {session.createdAt ? ` ${relativeTime(session.createdAt, now)}` : ''} · {people} {people === 1 ? 'person' : 'people'} counting
          </p>
          {mine.length > 0 && <p className="count-meta">Assigned to you: {mine.join(', ')}</p>}
        </div>
        <div className="count-hero-actions">
          {syncButton}
          {canAdjust && (
            <button type="button" className="gold-button" onClick={() => setDrawer('finalize')}>
              <ClipboardCheck />
              {waiting ? 'Review and approve' : 'Finalize count'}
            </button>
          )}
          {canAdjust && waiting && (
            <button type="button" className="secondary-button" onClick={() => setDrawer('sendBack')}>
              <Undo2 />
              Send back
            </button>
          )}
          {canCount && !canAdjust && open && (
            <button type="button" className="gold-button" onClick={() => setDrawer('submit')}>
              <Send />
              Submit for approval
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
      {waiting && (
        <div className="workflow-warning count-callout" role="status">
          <AlertTriangle />
          <div>
            <strong>Needs approval — contributions are closed</strong>
            <p>
              Submitted{session.submittedBy ? ` by ${memberName(session.submittedBy)}` : ''}
              {session.submittedAt ? ` ${relativeTime(session.submittedAt, now)}` : ''}.{' '}
              {canAdjust
                ? 'Review the shared totals, then approve them to update on-hand or send the count back for more counting.'
                : 'An officer approves it to update on-hand, or sends it back for more counting.'}
            </p>
            {late && <p>{late} arrived after it was submitted{canAdjust ? ' — send it back to include them.' : '.'}</p>}
          </div>
        </div>
      )}
      {open && session.sentBack && (
        <div className="workflow-warning count-callout" role="status">
          <Undo2 />
          <div>
            <strong>Sent back by {memberName(session.sentBack.by)}</strong>
            <p>“{session.sentBack.reason}”</p>
          </div>
        </div>
      )}
      {lifecycle === 'DRAFT' && (
        <div className="workflow-warning count-callout" role="status">
          <AlertTriangle />
          <div>
            <strong>Draft — only on this device so far</strong>
            <p>Others can join this count once it syncs. Your counts are saved here in the meantime.</p>
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
        {...(assignees.size ? { assignedLabel } : {})}
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
          approving={waiting}
          close={() => setDrawer(undefined)}
          onFinalized={(next, countedSizes) => {
            setDrawer(undefined)
            onProjection(next)
            notify(`Count ${waiting ? 'approved' : 'finalized'} — on-hand updated for ${countedSizes} size${countedSizes === 1 ? '' : 's'}.`)
          }}
        />
      )}
      {drawer === 'submit' && (
        <SubmitCountDrawer
          session={session}
          inventory={projection.inventory}
          controller={controller}
          close={() => setDrawer(undefined)}
          onSubmitted={next => {
            setDrawer(undefined)
            onProjection(next)
            notify('Count submitted for approval. An officer will review it.')
          }}
        />
      )}
      {drawer === 'sendBack' && (
        <SendBackDrawer
          session={session}
          controller={controller}
          close={() => setDrawer(undefined)}
          onSentBack={next => {
            setDrawer(undefined)
            onProjection(next)
            notify('Count sent back. Everyone can add counts again.')
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
  inventory,
  members,
  memberName,
  onStarted,
}: {
  canStart: boolean
  controller: DistributedAppController
  inventory: InventoryProjection[]
  members: MemberProjection[]
  memberName: (publicIdentity: string) => string
  onStarted: (projection: ArgusAppProjection) => void
}) {
  const id = useId()
  const [name, setName] = useState(defaultSessionName)
  const [assignees, setAssignees] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const categories = countableCategories(inventory)
  const assign = (category: string, publicIdentity: string) =>
    setAssignees(current => {
      const next = new Map(current)
      if (publicIdentity) next.set(category, publicIdentity)
      else next.delete(category)
      return next
    })
  const start = async (event: FormEvent) => {
    event.preventDefault()
    const scope = name.trim()
    if (!scope || scope.length > 120) {
      setError('Give the count a name of up to 120 characters, e.g. “Fall inventory 2026”.')
      return
    }
    const assignments = categoryAssignments(inventory, assignees)
    if (assignments.length > MAX_ASSIGNED_SIZES) {
      setError(`Those categories have ${assignments.length} sizes; assign at most ${MAX_ASSIGNED_SIZES} sizes in one count. Leave the largest categories as “Anyone”.`)
      return
    }
    setBusy(true)
    setError('')
    try {
      onStarted(await controller.createCountSession({ sessionId: `count_${crypto.randomUUID()}`, scope, ...(assignments.length ? { assignments } : {}) }))
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
        {canStart && members.length > 1 && categories.length > 0 && (
          <details className="count-assign">
            <summary>Assign categories to people (optional)</summary>
            <p>Each person sees what they are asked to count. Anyone can still count anything, and all counts add up.</p>
            {categories.map((category, index) => (
              <div className="field count-field" key={category}>
                <label htmlFor={`${id}-assign-${index}`}>{category}</label>
                <select id={`${id}-assign-${index}`} value={assignees.get(category) ?? ''} onChange={event => assign(category, event.target.value)}>
                  <option value="">Anyone</option>
                  {members.map(member => (
                    <option key={member.publicIdentity} value={member.publicIdentity}>
                      {memberName(member.publicIdentity)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </details>
        )}
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
