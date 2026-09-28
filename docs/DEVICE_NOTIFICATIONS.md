# Device notifications (master spec §20, tier 2)

A.R.G.U.S. can put a notification on a phone or computer when something important needs attention
and nobody is looking at the app. It does this **without a server**, which is a deliberate product
decision, and that decision limits what is possible. This page says exactly what works, where, and
why a notification for a fully closed app is not something A.R.G.U.S. can promise.

In short:

* **While A.R.G.U.S. is unlocked and open — including in a background tab — it can notify.**
* **When A.R.G.U.S. is closed, it can only make a best-effort check,** and only as an installed app
  in Chrome or Edge (desktop or Android).
* **Reliable notifications for a closed app would need a push server.** A.R.G.U.S. has none, on
  purpose, so it does not offer them.

## Turning it on

**Settings → Notifications → Device notifications.** It is off by default on every device. Turning
it on asks the browser for notification permission; if you refuse, it stays off and tells you how to
allow it later in your browser's site settings. The same panel shows what this browser supports and
has a **Send a test notification** button.

The setting is per device (it lives in this browser's preferences, like the theme), so each person
chooses for their own phone or computer.

## What gets a notification

Notifications are reserved for conditions worth interrupting someone for (spec: "do not create
notification spam"). They come from the same alerts as the dashboard's Alerts panel:

| Rule | Detail |
| --- | --- |
| Which alerts | Only **critical** alerts (unresolved conflict, device out of testnet coins, a size out of stock while cadets hold it, an overdue preparation task …), and **warnings whose deadline is less than 24 hours away** (a preparation task due within the next day). Info alerts never notify. |
| Never on screen | Nothing is shown while A.R.G.U.S. is visible. You already see the Alerts panel. |
| Only news | An alert that was already there when you last looked at A.R.G.U.S. does not notify. Leaving the app counts as having seen what was on it. |
| Once per condition per day | The same alert in the same condition notifies at most once every 24 hours. If the condition changes (another task becomes overdue, the count changes, a warning becomes critical) it may notify again, but not sooner than one hour after the last notification for that alert. |
| Global cap | At most **3 notifications per hour** across all alerts, most urgent first. |
| Grouped | Preparation tasks are grouped per supply event: one notification such as *"A.R.G.U.S.: AMI in 2 days — 3 preparation tasks overdue"*, not one per task. Each notification is tagged with its alert (or event), so an update replaces the previous one instead of stacking. |
| Stops | Escalation for an alert stops once you **open A.R.G.U.S.** after it was raised (or tap the notification), once it is **acknowledged** on this device, or once it is **resolved** (no longer in the alert list). Notifications that no longer apply are withdrawn from the notification tray where the browser allows it, and all of them are withdrawn when you open the app. |

Tapping a notification focuses (or opens) A.R.G.U.S. and goes straight to the alert's target — the
Supply Calendar, Inventory, Conflicts and so on — exactly as clicking the alert on the dashboard
would. If A.R.G.U.S. was locked, you unlock first and then land there.

## What a notification says (privacy)

Notifications appear on lock screens and in notification centres that other people can see, and
alert text can contain cadet IDs, item names or free text someone typed into a task. So a
notification **never contains** cadet names, cadet IDs, quantities for a person, item names or any
free text from the unit's data. Its words come from a fixed vocabulary in
`src/notifications/policy.ts`: the kind of alert, the supply event's *kind* (NCO, BLT, AMI, Military
Ball, End-of-Year Count, or "A supply event" for custom events — never the event's own title), and
counts of tasks or sizes. Alert kinds the notifier does not recognise get a category phrase such as
"a cadet record needs attention", never their own text.

## What works where

"Background tab" means A.R.G.U.S. is unlocked in a tab or window you are not looking at. Browsers
slow such pages down (timers run about once a minute), and mobile operating systems suspend them, so
background notifications on phones are best effort even while the app is "open".

| Browser / platform | Open or background tab | Closed app |
| --- | --- | --- |
| Chrome, Edge (Windows, macOS, Linux, ChromeOS) — in a tab | Yes | No |
| Chrome, Edge — **installed** as an app (Install app) | Yes | **Best effort**: Periodic Background Sync, described below |
| Chrome on Android — in a tab | Yes, while Android keeps the tab running; it may freeze background tabs within minutes | No |
| Chrome on Android — **installed** (Add to Home screen / Install app) | Yes, same caveat | **Best effort**: Periodic Background Sync |
| Firefox (desktop) | Yes | No — Firefox does not implement Periodic Background Sync |
| Firefox for Android | Usually, while the tab is running | No |
| Safari on macOS (tab, or added to the Dock) | Yes | No — no Periodic Background Sync |
| Safari on iPhone / iPad — in a tab | **No** — iOS offers notifications only to Home Screen web apps | No |
| iPhone / iPad, iOS or iPadOS **16.4+**, A.R.G.U.S. **added to the Home Screen** and opened from there | Yes, but iOS suspends a web app shortly after you switch away, so in practice only briefly | No — iOS only wakes a closed web app for Web Push, which needs a server |

The Settings panel reports the situation for the browser you are using ("Your browser does not
support closed-app checks", "add A.R.G.U.S. to the Home Screen", and so on).

## Closed app: the best-effort check

Where the browser supports **Periodic Background Sync** (Chromium, installed app only), A.R.G.U.S.
registers a check named `argus-deadline-check`. The browser — not A.R.G.U.S. — decides when it runs:
at most about every 12 hours, only if you use the app regularly (site engagement), usually only on a
known network, and possibly never. When it runs, the service worker (`public/sw.js`):

1. does nothing if an A.R.G.U.S. window is open (the page handles notifications itself, with current
   data), if notification permission is gone, or if A.R.G.U.S. was opened in the last 12 hours;
2. reads the deadline summary the page last saved (below);
3. shows **one** notification if any preparation deadline in it has passed — e.g. *"A.R.G.U.S.: AMI
   preparation task past due"* or *"A.R.G.U.S.: 3 preparation deadlines have passed"* — reporting
   each deadline at most once and ignoring deadlines more than 14 days old.

The service worker cannot decrypt anything, cannot sync, and cannot know whether someone on another
device already finished the task. That is why the notification says the reminder "uses what this
device knew when A.R.G.U.S. was last unlocked", and why only deadlines — which pass with time alone —
are checked.

### The deadline summary

To make that check possible, the page stores a small **plaintext** summary in Cache Storage
(`argus-notify-v1`, entry `argus-notification-summary.json`), readable without the passphrase:

```json
{ "version": 1, "updatedAt": 1790000000000, "lastOpenedAt": 1790000000000,
  "items": [ { "id": "task-task_5c1e…", "label": "AMI preparation task", "dueAt": 1790100000000, "target": { "tab": "calendar" } } ] }
```

It holds only opaque task ids, the event *kind*, due times, where to navigate, and when A.R.G.U.S.
was last on screen: **no cadet names or IDs, no task or event titles, no items or quantities.** It
covers incomplete tasks of active events due from 14 days ago to 45 days ahead (at most 25), leaves
out acknowledged ones, and is written only while the setting is on **and** the browser has actually
registered the periodic check. Turning the setting off unregisters the check and deletes the whole
cache, including the service worker's record of which deadlines it already reported
(`argus-notification-worker.json`).

This device also keeps a notification history in `localStorage` (`argus.notifications.v1`): alert
ids, 8-character hashes of each alert's condition (so a change can be recognised without storing
its text), and times. It contains no alert text.

## Why a closed app cannot be notified reliably

Every browser's mechanism for waking a closed web app to show a notification is **Web Push**: the
app subscribes with the browser's push service (Firebase Cloud Messaging for Chrome, Mozilla's
autopush for Firefox, the Apple Push Notification service for Safari and iOS), and later an
**application server** sends a message, signed with the app's VAPID private key, to that
subscription's endpoint. Something therefore has to be running while every device is off, has to
hold the subscriptions and the signing key, and has to know *when* to send — which means knowing the
unit's deadlines and alert state.

A.R.G.U.S. has no server, by design: shared state lives only as encrypted records on BSV testnet,
decrypted only on members' unlocked devices. The chain does not run scheduled code or send pushes.
Adding push would mean operating an always-on service that stores device subscriptions and either
sees the unit's (decrypted) deadline data or at least a schedule of them — a new service to run,
secure and trust, which conflicts with the no-server goal. So A.R.G.U.S. does not claim it.

If closed-app reminders become essential, the options that keep the no-server property are
outside the browser's notification system — for example exporting supply events with reminders to
the device's own calendar app. That is not built.

## For developers

* `src/notifications/policy.ts` — the pure policy (`decideNotifications`, `planDeviceNotifications`),
  grouping and wording (`notificationCandidates`), and the closed-app summary. Unit tested in
  `policy.test.ts`.
* `src/notifications/notifier.ts`, `useDeviceNotifications.ts` — apply the policy in the unlocked
  app: re-evaluated on every projection change, on visibility changes and every 5 minutes (deadlines
  arrive with time); history persisted per device. The hook takes an optional `acknowledged` set of
  alert ids, and also honours an `acknowledged: true` flag or a `dueAt` on an alert.
* `src/notifications/environment.ts` — the browser boundary: permission, `showNotification` through
  the service worker registration (falling back to `new Notification`, which Android forbids),
  withdrawal, Periodic Background Sync and the summary. Everything is feature-detected.
* `src/notifications/routing.ts` + `public/sw.js` — the click path: the worker focuses an open
  window and posts `{ type: 'ARGUS_NOTIFICATION_OPEN', alertId, target }`, or opens a window with
  `?argus-alert=…&argus-tab=…&argus-panel=…`; the page validates the target and routes after unlock.
* To try the closed-app check: install the production build in Chrome, turn the setting on, then in
  DevTools → Application → Periodic background sync, trigger `argus-deadline-check`. The service
  worker is only registered in production builds (`npm run build` and serve `dist`); development
  builds use page notifications.
