import { useState } from 'react'
import { loadDeviceIdentityRecord, unlockDeviceIdentity, type DeviceIdentityRecord, type UnlockedDeviceIdentity } from '../deviceIdentity'
import { FirstRunScreen } from './FirstRunScreen'
import { UnlockScreen } from './UnlockScreen'

/** First run creates and unlocks a device identity in one step; every later mount shows the unlock screen. */
export function IdentityGate({ onUnlock }: { onUnlock: (unlocked: UnlockedDeviceIdentity, record: DeviceIdentityRecord) => void }) {
  const [record, setRecord] = useState<DeviceIdentityRecord | undefined>(() => loadDeviceIdentityRecord())

  const unlockWith = async (target: DeviceIdentityRecord, password: string) => {
    onUnlock(await unlockDeviceIdentity(target, password), target)
  }

  if (!record) {
    return (
      <FirstRunScreen
        onReady={async (created, password) => {
          setRecord(created)
          await unlockWith(created, password)
        }}
      />
    )
  }
  return <UnlockScreen onUnlock={password => unlockWith(record, password)} />
}
