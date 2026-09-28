import { useEffect, useId, useState } from 'react'
import { BellRing } from 'lucide-react'
import { browserNotificationEnvironment, type ClosedAppSupport, type DevicePermission, type NotificationEnvironment } from './environment'
import { NOTIFICATION_TEXT } from './text'
import './notifications.css'

type Message = { tone: 'status' | 'alert'; text: string }

/** Settings section for tier 2 device notifications. Turning it on asks for permission first, and explains a refusal. */
export function DeviceNotificationSettings({ enabled, onChange, environment = browserNotificationEnvironment }: { enabled: boolean; onChange: (enabled: boolean) => void; environment?: NotificationEnvironment }) {
  const [permission, setPermission] = useState<DevicePermission>(() => environment.permission())
  const [closedApp, setClosedApp] = useState<ClosedAppSupport | 'checking'>('checking')
  const [message, setMessage] = useState<Message>()
  const [busy, setBusy] = useState(false)
  const statusId = useId()
  const platform = environment.platform()

  useEffect(() => {
    let active = true
    environment.closedAppSupport().then(support => { if (active) setClosedApp(support) }, () => { if (active) setClosedApp('unsupported') })
    return () => { active = false }
  }, [environment, enabled])

  const unsupportedText = platform.ios && !platform.standalone ? NOTIFICATION_TEXT.ios : NOTIFICATION_TEXT.unsupported
  const toggle = async (on: boolean) => {
    if (!on) { onChange(false); setMessage({ tone: 'status', text: NOTIFICATION_TEXT.off }); return }
    const current = environment.permission()
    setPermission(current)
    if (current === 'unsupported') { setMessage({ tone: 'alert', text: unsupportedText }); return }
    if (current === 'denied') { setMessage({ tone: 'alert', text: NOTIFICATION_TEXT.denied }); return }
    setBusy(true)
    const result = current === 'granted' ? current : await environment.requestPermission()
    setBusy(false)
    setPermission(result)
    if (result === 'granted') { onChange(true); setMessage({ tone: 'status', text: NOTIFICATION_TEXT.on }) }
    else setMessage({ tone: 'alert', text: result === 'denied' ? NOTIFICATION_TEXT.denied : result === 'unsupported' ? unsupportedText : NOTIFICATION_TEXT.dismissed })
  }
  const sendTest = async () => {
    const shown = await environment.show({ tag: 'argus-test', title: 'A.R.G.U.S. test notification', body: 'Device notifications work on this device. Real ones never include cadet names or IDs.' })
    setMessage(shown ? { tone: 'status', text: NOTIFICATION_TEXT.testSent } : { tone: 'alert', text: NOTIFICATION_TEXT.testFailed })
  }

  const closedAppText = closedApp === 'checking' ? 'Checking whether this browser supports closed-app checks…'
    : closedApp === 'available' ? NOTIFICATION_TEXT.closedAvailable
    : closedApp === 'needs-install' ? NOTIFICATION_TEXT.closedNeedsInstall
    : NOTIFICATION_TEXT.closedUnsupported
  return (
    <section className="notification-settings" aria-label="Device notifications">
      <p className="notification-intro">{NOTIFICATION_TEXT.intro}</p>
      <label className="notification-toggle">
        <BellRing aria-hidden="true" />
        <span>Device notifications</span>
        <input type="checkbox" role="switch" checked={enabled} disabled={busy} aria-describedby={statusId} onChange={event => { void toggle(event.target.checked) }} />
      </label>
      <ul className="notification-status" id={statusId} aria-label="Notification support in this browser">
        {permission === 'unsupported' ? <li>{unsupportedText}</li> : <>
          <li>{NOTIFICATION_TEXT.whileOpen}</li>
          <li>{closedAppText}</li>
        </>}
        <li>{NOTIFICATION_TEXT.noServer}</li>
      </ul>
      {enabled && permission === 'denied' && <p className="workflow-warning" role="alert">{NOTIFICATION_TEXT.blockedWhileOn}</p>}
      {message && <p className={message.tone === 'alert' ? 'workflow-warning' : 'notification-message'} role={message.tone}>{message.text}</p>}
      {enabled && permission === 'granted' && (
        <button type="button" className="secondary-button notification-test" onClick={() => { void sendTest() }}>Send a test notification</button>
      )}
    </section>
  )
}
