import type { ChainApi } from '../chain/types'
import type { DeviceWallet } from '../chain/wallet'
import type { CadetView, SignedArgusEvent } from '../distributed/types'
import { readChannelRecords } from './channelReader'
import { importChannelKey, serializeChannelEnvelope, sealToChannel } from './envelope'
import type { CadetDevice } from './vault'

/** Where a cadet's channel is: its key and the address its records are paid to (ADR 013). */
export type CadetChannelRef = { key: string; address: string }
/** What a drain reports: how many cadets it set out to publish for, how many went out, how many did not (they stay queued, bar a refusal). */
export type CadetPublishProgress = { done: number; total: number; failed: number }
/** What a notice's sealed record holds (ADR 013, mw-kmgi38.5): the cadet's phone shows the text, who sent it and when. */
export type NoticeRecord = { noticeId: string; text: string; sentAt: string; from: string }
/** Where a notice goes and what it says, as the unit log has it; none when the notice or its channel is gone. */
export type NoticeToPublish = { channel: CadetChannelRef; record: NoticeRecord }
export type CadetPublisherDeps = {
  /** The cadet's channel as the unit log has it, or none (a cadet with no channel has nowhere to be published). */
  channelFor: (cadetId: string) => Promise<CadetChannelRef | undefined>
  viewFor: (cadetId: string) => Promise<CadetView>
  /** A notice staff sent, read from the unit log when it is published (so the queue holds IDs, never text). Without it no notice is published. */
  noticeFor?: (noticeId: string) => Promise<NoticeToPublish | undefined>
  /** Which cadets' records an event changes (none: an empty list). Only used by noteEvent. */
  cadetIdsFor?: (event: SignedArgusEvent) => Promise<string[]>
  wallet: Pick<DeviceWallet, 'prepareRecords' | 'flush' | 'pending' | 'ownTxHex'>
  /** Holds the queue, so a reload or an offline spell resumes where it stopped. */
  storage: Pick<Storage, 'getItem' | 'setItem'>
  storageKey: string
  /** Events for one cadet closer together than this fold into one publish. */
  debounceMs?: number
  /** A drain that left cadets queued runs again after this long. */
  retryMs?: number
}
/** A cadet's record that can never be published as it is (over the cap): refused, not retried. */
export class CadetRecordTooLargeError extends Error {
  constructor(readonly cadetName: string) { super(`The record for ${cadetName} is too large to publish (over 60 KB).`) }
}
export const CADET_PUBLISH_DEBOUNCE_MS = 2_000
export const CADET_PUBLISH_RETRY_MS = 30_000

/**
 * Keeps each cadet's channel up to date (ADR 013, mw-kmgi38.3): when this device commits a change that touches a cadet who has a
 * channel, the cadet's CadetView is sealed to that channel and paid there, in one transaction of this device's wallet, one record
 * per transaction. Several changes within the debounce make one record. The queue of cadets waiting is kept in storage; a record the
 * network did not take stays queued and goes out again, and a transaction the wallet already built is finished, never built twice.
 */
export class CadetPublisher {
  private queue: string[]
  /** Notices waiting to be sealed to their audience's channel, by notice ID (ADR 013, mw-kmgi38.5). */
  private noticeQueue: string[]
  private readonly noticeErrors: Record<string, string> = {}
  /** Bumped on every note, so a change that arrives while a record is being published keeps its cadet queued. */
  private readonly generation = new Map<string, number>()
  private readonly errors: Record<string, string> = {}
  private readonly noting = new Set<Promise<unknown>>()
  private timer?: ReturnType<typeof setTimeout>
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: CadetPublisherDeps) { this.queue = this.load(this.deps.storageKey); this.noticeQueue = this.load(this.noticeStorageKey) }
  private get noticeStorageKey() { return `${this.deps.storageKey}.notices` }

  private get debounceMs() { return this.deps.debounceMs ?? CADET_PUBLISH_DEBOUNCE_MS }
  private load(key: string): string[] {
    try { const parsed: unknown = JSON.parse(this.deps.storage.getItem(key) ?? '[]'); return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string'))] : [] } catch { return [] }
  }
  private save() { this.deps.storage.setItem(this.deps.storageKey, JSON.stringify(this.queue)) }
  private saveNotices() { this.deps.storage.setItem(this.noticeStorageKey, JSON.stringify(this.noticeQueue)) }
  private schedule(ms: number) {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; this.run().catch(() => undefined) }, ms)
  }
  private add(cadetId: string) {
    this.generation.set(cadetId, (this.generation.get(cadetId) ?? 0) + 1)
    if (!this.queue.includes(cadetId)) { this.queue.push(cadetId); this.save() }
  }

  /** The cadets waiting for a record, oldest first. */
  queued() { return [...this.queue] }
  /** The notices waiting to go out, oldest first (IDs only). */
  queuedNotices() { return [...this.noticeQueue] }
  /** Why a notice's last attempt did not go out, by notice ID (cleared by a success). */
  noticeErrorsById() { return { ...this.noticeErrors } }
  /** Queues a notice for a drain (run). Its text stays in the unit log, not in this queue. */
  enqueueNotice(noticeId: string) { if (!this.noticeQueue.includes(noticeId)) { this.noticeQueue.push(noticeId); this.saveNotices() } }
  /** Why each cadet's last attempt did not go out (cleared by a success). */
  lastErrors() { return { ...this.errors } }
  /** A change touched this cadet: queue them and (re)start the debounce. */
  note(cadetId: string) { this.stopped = false; this.add(cadetId); this.schedule(this.debounceMs) }
  /** A committed event of this device: queue every cadet it touches who has a channel. Never throws: a failure here must not fail the command. */
  noteEvent(event: SignedArgusEvent) {
    const work = (async () => {
      for (const cadetId of new Set(await this.deps.cadetIdsFor?.(event) ?? [])) if (await this.deps.channelFor(cadetId)) this.note(cadetId)
    })().catch(() => undefined).finally(() => { this.noting.delete(work) })
    this.noting.add(work)
  }
  /** Picks the queue up again (after a reload): starts the debounce when anything is waiting. */
  resume() { this.stopped = false; if (this.queue.length || this.noticeQueue.length) this.schedule(this.debounceMs) }
  /** Stops the timer; the queue stays in storage for the next time. */
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined }
  /** Resolves when every event noted so far has been queued and no drain is running. */
  async idle() { while (this.noting.size) await Promise.all([...this.noting]); await this.tail.catch(() => undefined) }

  /** Queues every one of these cadets for a drain without waiting for the debounce. */
  enqueue(cadetIds: string[]) { for (const id of cadetIds) this.add(id) }

  /**
   * Publishes for every queued cadet, one transaction at a time, and says how it went. Runs after any drain already going. A cadet
   * whose record the network did not take stays queued (and is tried again later); one whose record is over the cap is refused and dropped.
   */
  run(onProgress?: (progress: CadetPublishProgress) => void): Promise<CadetPublishProgress> {
    const next = this.tail.catch(() => undefined).then(() => this.drain(onProgress))
    this.tail = next
    return next
  }
  private async drain(onProgress?: (progress: CadetPublishProgress) => void): Promise<CadetPublishProgress> {
    clearTimeout(this.timer); this.timer = undefined
    const ids: string[] = []
    for (const id of [...this.queue]) { if (await this.deps.channelFor(id)) ids.push(id); else this.drop(id) }
    const progress: CadetPublishProgress = { done: 0, total: ids.length, failed: 0 }, started = new Map(ids.map(id => [id, this.generation.get(id)]))
    onProgress?.({ ...progress })
    for (const cadetId of ids) {
      try {
        await this.publishNow(cadetId)
        delete this.errors[cadetId]
        if (this.generation.get(cadetId) === started.get(cadetId)) this.drop(cadetId)
        progress.done++
      } catch (error) {
        progress.failed++
        this.errors[cadetId] = error instanceof Error ? error.message : 'The record could not be published.'
        if (error instanceof CadetRecordTooLargeError) this.drop(cadetId)
      }
      onProgress?.({ ...progress })
    }
    await this.drainNotices()
    // Changes noted while this drain ran, or records the network did not take: again, after the debounce or a longer wait.
    if (this.queue.some(id => !started.has(id) || this.generation.get(id) !== started.get(id))) this.schedule(this.debounceMs)
    else if (this.queue.length || this.noticeQueue.length) this.schedule(this.deps.retryMs ?? CADET_PUBLISH_RETRY_MS)
    return progress
  }
  /** One at a time, after the cadets' records: a notice the network did not take stays queued; one that cannot be sealed or whose notice is gone is dropped. */
  private async drainNotices() {
    for (const noticeId of [...this.noticeQueue]) {
      try {
        const notice = await this.deps.noticeFor?.(noticeId)
        if (!notice) { this.dropNotice(noticeId); continue }
        await this.publishRecord(notice.channel, 'notice', notice.record, `notice:${noticeId}`, 'this notice')
        delete this.noticeErrors[noticeId]; this.dropNotice(noticeId)
      } catch (error) {
        this.noticeErrors[noticeId] = error instanceof Error ? error.message : 'The notice could not be published.'
        if (error instanceof CadetRecordTooLargeError) this.dropNotice(noticeId)
      }
    }
  }
  private dropNotice(noticeId: string) { const before = this.noticeQueue.length; this.noticeQueue = this.noticeQueue.filter(id => id !== noticeId); if (this.noticeQueue.length !== before) this.saveNotices() }
  private drop(cadetId: string) { const before = this.queue.length; this.queue = this.queue.filter(id => id !== cadetId); if (this.queue.length !== before) this.save() }

  /**
   * Seals this cadet's current record to their channel and has it accepted by the network, in one transaction. Throws when the record is
   * too large (naming the cadet), the wallet cannot pay, or the network does not take it yet (a transaction the wallet built is kept and
   * finished by the next call, never duplicated).
   */
  async publishNow(cadetId: string): Promise<{ txid: string; version: number }> {
    const channel = await this.deps.channelFor(cadetId)
    if (!channel) throw new Error('This cadet has no channel yet.')
    const view = await this.deps.viewFor(cadetId)
    const txid = await this.publishRecord(channel, 'view', view, `cadet-record:${cadetId}:${view.version}`, view.fullName.trim() || view.cadetCode)
    return { txid, version: view.version }
  }
  /**
   * Seals one record to a channel and has the network accept it, in one transaction of this device's wallet. A transaction the wallet
   * already built under this correlation (an answer that never came) is finished, never built twice.
   */
  private async publishRecord(channel: CadetChannelRef, kind: 'view' | 'notice', plaintext: unknown, correlation: string, name: string): Promise<string> {
    let payload: Uint8Array
    try { payload = serializeChannelEnvelope(await sealToChannel({ channelId: channel.address, key: await importChannelKey(channel.key), kind, plaintext })) } catch (error) {
      if (error instanceof Error && error.message.includes('too large')) throw new CadetRecordTooLargeError(name)
      throw error
    }
    const { wallet } = this.deps
    // The wallet already built this very record (an answer that never came): finish that one.
    const txid = (await wallet.pending()).find(tx => tx.correlationIds.includes(correlation))?.txid ?? (await wallet.prepareRecords([{ kind: 'C', payload }], channel.address, [correlation])).txid
    const flushed = await wallet.flush()
    const refused = flushed.rolledBack.find(entry => entry.txid === txid)
    if (refused) throw new Error(`The network refused the record: ${refused.reason}`)
    if ((await wallet.pending()).some(tx => tx.txid === txid)) throw new Error('The network has not taken the record yet; it will be tried again.')
    if (!(await wallet.ownTxHex(txid))) throw new Error('The record was not accepted by the network.')
    return txid
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A CadetView as read back from a channel: shape-checked, since the channel is public and anyone holding the key could write to it. */
function parseCadetView(value: unknown): CadetView {
  if (!isRecord(value) || typeof value.cadetId !== 'string' || typeof value.cadetCode !== 'string' || typeof value.fullName !== 'string' || !isRecord(value.sizes) || !Array.isArray(value.have) || !Array.isArray(value.stillNeeded) || !Number.isSafeInteger(value.version) || typeof value.updatedAt !== 'string') throw new Error('Not a cadet record.')
  return value as unknown as CadetView
}

/**
 * The cadet's side (ADR 013): reads this phone's own channel and returns the newest record, the one with the highest version (of
 * equal versions, the one the chain lists last). Fetches one address and opens only what its own key opens. No record yet: undefined.
 */
export async function readCadetRecord(device: { cadet?: Pick<CadetDevice, 'cadetId' | 'channelKey' | 'channelAddress'> }, api: ChainApi): Promise<CadetView | undefined> {
  const { cadet } = device
  if (!cadet) return undefined
  let best: CadetView | undefined
  for (const entry of await readChannelRecords(api, cadet.channelAddress, cadet.channelKey)) {
    if (entry.kind !== 'view') continue
    let view: CadetView
    try { view = parseCadetView(entry.plaintext) } catch { continue }
    if (view.cadetId === cadet.cadetId && (!best || view.version >= best.version)) best = view
  }
  return best
}

/** A notice as read back from a channel: shape-checked, since anyone holding the key could write to it. */
function parseNotice(value: unknown): NoticeRecord {
  if (!isRecord(value) || typeof value.noticeId !== 'string' || typeof value.text !== 'string' || typeof value.sentAt !== 'string' || typeof value.from !== 'string') throw new Error('Not a notice.')
  return { noticeId: value.noticeId, text: value.text, sentAt: value.sentAt, from: value.from }
}

/**
 * The cadet's side of notices (ADR 013, mw-kmgi38.6): the notices sealed to the unit's notices channel (to all cadets) and to this cadet's
 * own channel (to this cadet), each opened only with its own key; a note sealed to another cadet is at another address under another key.
 * Newest first, each notice ID once.
 */
export async function readCadetNotices(device: { cadet?: Pick<CadetDevice, 'channelKey' | 'channelAddress' | 'noticesKey' | 'noticesAddress'> }, api: ChainApi): Promise<NoticeRecord[]> {
  const { cadet } = device
  if (!cadet) return []
  const found = new Map<string, NoticeRecord>()
  for (const [address, key] of [[cadet.noticesAddress, cadet.noticesKey], [cadet.channelAddress, cadet.channelKey]] as const) {
    for (const entry of await readChannelRecords(api, address, key)) {
      if (entry.kind !== 'notice') continue
      try { const notice = parseNotice(entry.plaintext); if (!found.has(notice.noticeId)) found.set(notice.noticeId, notice) } catch { continue }
    }
  }
  return [...found.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.noticeId.localeCompare(b.noticeId))
}
