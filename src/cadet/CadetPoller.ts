import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChainApi } from '../chain/types'
import type { CadetView } from '../distributed/types'
import { readCadetNotices, readCadetRecord, type NoticeRecord } from '../unit/cadetPublisher'
import type { CadetDevice } from '../unit/vault'

/** The poller never reads faster than this on its own; the cadet's own Refresh and a return to the tab are the only other reads. */
export const CADET_POLL_MS = 5 * 60_000

export type CadetPoll = { view?: CadetView; /** the notices the latest read that reached the network found, newest first */ notices?: NoticeRecord[]; /** a read has finished at least once */ loaded: boolean; checking: boolean; /** the latest read could not reach the network */ offline: boolean; refresh: () => void }

/**
 * Reads this phone's own channel (readCadetRecord) and its notices (readCadetNotices: the unit's notices channel and the same own channel) on mount, when the tab becomes visible again and every `intervalMs`. One read at a
 * time. A read that fails keeps the last record on screen and marks the poll offline; a newer record replaces the old one. The record
 * lives in memory only: nothing about the cadet is written to the phone in plain text.
 */
export function useCadetPoller(cadet: CadetDevice, api: ChainApi, intervalMs = CADET_POLL_MS): CadetPoll {
  const [state, setState] = useState<Omit<CadetPoll, 'refresh'>>({ loaded: false, checking: true, offline: false })
  const running = useRef(false), again = useRef(false), alive = useRef(true)
  const read = useCallback(async () => {
    if (running.current) return
    running.current = true
    try {
      do {
        again.current = false
        setState(previous => ({ ...previous, checking: true }))
        // Both reads in one poll; one that cannot reach the network marks the poll offline and keeps what the other found.
        const [record, notices] = await Promise.allSettled([readCadetRecord({ cadet }, api), readCadetNotices({ cadet }, api)])
        if (!alive.current) continue
        setState(previous => {
          const view = record.status === 'fulfilled' ? record.value ?? previous.view : previous.view
          const found = notices.status === 'fulfilled' ? notices.value : previous.notices
          return { loaded: true, checking: false, offline: record.status === 'rejected' || notices.status === 'rejected', ...(view ? { view } : {}), ...(found ? { notices: found } : {}) }
        })
      } while (again.current && alive.current)
    } finally {
      running.current = false
    }
  }, [cadet, api])
  useEffect(() => {
    alive.current = true
    void read()
    const timer = setInterval(() => { void read() }, intervalMs)
    const onVisible = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [read, intervalMs])
  // A press of Refresh during a read is not lost: it reads once more when that read ends.
  const refresh = useCallback(() => { if (running.current) again.current = true; else void read() }, [read])
  return { ...state, refresh }
}
