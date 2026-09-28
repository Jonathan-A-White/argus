import { useState } from 'react'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { errorMessage } from './calendarModel'

/** One async controller call with its own pending flag and inline error. */
export function useMutation({ onProjection, notify }: { onProjection: (projection: ArgusAppProjection) => void; notify: (message: string) => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const run = async (operation: () => Promise<ArgusAppProjection>, success?: string) => {
    setPending(true)
    setError('')
    try {
      onProjection(await operation())
      if (success) notify(success)
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    } finally {
      setPending(false)
    }
  }
  return { pending, error, setError, run }
}
