/** User-facing wording for the device notification settings (kept apart so tests can assert on it). */
export const NOTIFICATION_TEXT = {
  intro: 'A.R.G.U.S. can notify this device when something critical happens, or a preparation deadline is less than a day away, while you are not looking at it. Notifications only say what kind of alert it is — never cadet names, cadet IDs or anyone’s items.',
  whileOpen: 'Notifies while A.R.G.U.S. is unlocked and open, including in a background tab.',
  closedAvailable: 'While A.R.G.U.S. is closed, this installed app can also check for passed preparation deadlines about twice a day (your browser decides exactly when).',
  closedNeedsInstall: 'Closed-app checks need A.R.G.U.S. installed as an app (Chrome or Edge: Install app); until then nothing is checked while it is closed.',
  closedUnsupported: 'Your browser does not support closed-app checks, so nothing is checked while A.R.G.U.S. is closed.',
  noServer: 'Reliable notifications for a fully closed app would need a push server, which A.R.G.U.S. deliberately does not have.',
  unsupported: 'This browser cannot show notifications.',
  ios: 'On iPhone and iPad, notifications need iOS 16.4 or later and A.R.G.U.S. on the Home Screen: tap Share → Add to Home Screen, then open A.R.G.U.S. from the new icon and turn this on there.',
  denied: 'Notifications are blocked for this site. Allow them for A.R.G.U.S. in your browser’s site settings, then turn this on again.',
  blockedWhileOn: 'Notifications are blocked in your browser’s settings, so none will be shown until you allow them again.',
  dismissed: 'Notifications were not allowed, so they stay off. You can try again at any time.',
  on: 'Device notifications are on for this device.',
  off: 'Device notifications are off for this device.',
  testSent: 'Test notification sent. If nothing appeared, check your system’s notification settings (Do Not Disturb or Focus).',
  testFailed: 'This browser did not show the test notification.',
} as const
