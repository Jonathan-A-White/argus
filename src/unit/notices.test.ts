import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { joinByTicket, memoryStorage } from '../test/joinByTicket'
import { readChannelRecords } from './channelReader'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { createMasterDevice } from './vault'

afterEach(() => { vi.useRealTimers() })

type Notice = { noticeId: string; text: string; sentAt: string; from: string }
async function setup() {
  const chain = new FakeChain()
  const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
  chain.fund(device.record.walletAddress, 400_000, { confirmed: true })
  const storage = memoryStorage(), master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage })
  const withPhone = (await master.controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Avery Private', cadetCode: 'C-T001' })).cadets[0].cadetId
  const other = (await master.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Blake Private', cadetCode: 'C-T002' })).cadets.find(cadet => cadet.cadetId !== withPhone)!.cadetId
  const bare = (await master.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Casey Private', cadetCode: 'C-T003' })).cadets.find(cadet => ![withPhone, other].includes(cadet.cadetId))!.cadetId
  await master.controller.createCadetChannel(withPhone); await master.controller.createCadetChannel(other); await master.controller.createNoticesKey()
  const state = await master.controller.technicalState()
  const channel = (cadetId: string) => state.cadetChannels.find(entry => entry.cadetId === cadetId)!
  /** The notices this key opens at this address: what a cadet's phone reads. */
  const noticesAt = async (address: string, key: string) => (await readChannelRecords(chain, address, key)).filter(record => record.kind === 'notice').map(record => record.plaintext as Notice)
  return { chain, master, storage, withPhone, other, bare, channel, notices: state.noticesChannel!, noticesAt }
}

describe('sending notices (ADR 013, mw-kmgi38.5)', { timeout: 240_000 }, () => {
  let world: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => { world = await setup() })

  it('a notice to all leaves one record at the notices address that opens under the notices key and under no cadet’s key', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { master, notices, channel, withPhone, other, noticesAt } = world
    const result = await master.sendNotice('all', 'Military ball: bring your SDBs')
    expect(result.published).toBe(true)
    const event = (await master.controller.technicalState()).events.find(record => record.event.eventType === 'NOTICE_SENT')!.event
    expect(event.payload).toMatchObject({ audience: 'all', text: 'Military ball: bring your SDBs' })
    const sent = await noticesAt(notices.address, notices.key)
    expect(sent).toEqual([{ noticeId: result.noticeId, text: 'Military ball: bring your SDBs', sentAt: event.timestamp, from: 'Chief' }])
    // Not under a cadet's channel key, nor read at a cadet's address.
    expect(await noticesAt(notices.address, channel(withPhone).channelKey)).toEqual([])
    expect(await noticesAt(channel(withPhone).channelAddress, notices.key)).toEqual([])
    expect(await noticesAt(channel(other).channelAddress, channel(other).channelKey)).toEqual([])
    expect(master.cadetPublisher.queuedNotices()).toEqual([])
  })

  it('a notice to one cadet leaves one record at that cadet’s address that opens under that cadet’s key only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { master, notices, channel, withPhone, other, noticesAt } = world
    const result = await master.sendNotice({ cadetId: withPhone }, 'Come to supply Thursday')
    expect(result.published).toBe(true)
    const mine = channel(withPhone)
    expect((await noticesAt(mine.channelAddress, mine.channelKey)).map(notice => notice.text)).toEqual(['Come to supply Thursday'])
    expect(await noticesAt(mine.channelAddress, channel(other).channelKey)).toEqual([])
    expect(await noticesAt(mine.channelAddress, notices.key)).toEqual([])
    expect((await noticesAt(notices.address, notices.key)).map(notice => notice.text)).toEqual(['Military ball: bring your SDBs'])
    expect((await master.controller.project()).notices.map(notice => notice.text)).toEqual(['Come to supply Thursday', 'Military ball: bring your SDBs'])
  })

  it('a cadet with no channel gets This cadet has no phone yet, and nothing is recorded or sent', async () => {
    const { master, bare } = world, before = (await master.controller.technicalState()).events.length
    await expect(master.sendNotice({ cadetId: bare }, 'Hello')).rejects.toThrow('This cadet has no phone yet')
    expect((await master.controller.technicalState()).events).toHaveLength(before)
  })

  it('text over 500 characters is refused with a message and nothing is recorded', async () => {
    const { master } = world, before = (await master.controller.technicalState()).events.length
    await expect(master.sendNotice('all', 'x'.repeat(501))).rejects.toThrow('A notice can be at most 500 characters.')
    expect((await master.controller.technicalState()).events).toHaveLength(before)
  })

  it('a Supply Assistant’s send is refused before anything is written', async () => {
    const { master, chain } = world
    const { runtime: assistant } = await joinByTicket(master, chain, 'Sam Assistant', 'SUPPLY_ASSISTANT', { satoshis: 30_000 })
    await assistant.syncNow()
    const before = (await assistant.controller.technicalState()).events.length
    await expect(assistant.sendNotice('all', 'Hello')).rejects.toThrow(/notices\.send/)
    expect((await assistant.controller.technicalState()).events).toHaveLength(before)
  })

  it('offline: the notice is recorded, stays queued as an ID, never its text, in storage, and goes out when the network is back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { master, chain, notices, noticesAt, storage } = world
    await master.syncNow() // the unit's own records go out first
    chain.failNextBroadcasts('rejected', 2) // the notice's own record in the unit log, then the sealed text
    const result = await master.sendNotice('all', 'Secret ball plans')
    expect(result.published).toBe(false)
    expect(master.cadetPublisher.queuedNotices()).toEqual([result.noticeId])
    expect([...storage.values.values()].filter(value => value.includes('Secret ball plans'))).toEqual([])
    expect((await noticesAt(notices.address, notices.key)).map(notice => notice.text)).not.toContain('Secret ball plans')
    expect(master.cadetPublisher.noticeErrorsById()[result.noticeId]).toMatch(/\S/)
    await master.cadetPublisher.run(); await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queuedNotices()).toEqual([])
    expect((await noticesAt(notices.address, notices.key)).filter(notice => notice.text === 'Secret ball plans')).toHaveLength(1)
  })
})
