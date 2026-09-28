# Demo: A.R.G.U.S. foundation

> **Superseded (2026-09-27):** see [BSV_SHARED_LEDGER.md](BSV_SHARED_LEDGER.md) and [ADR 010](adr/010-bsv-shared-ledger.md) for the current design. Kept for history.

This is the demo for the "A.R.G.U.S. foundation" epic: the fork runs and is gated on Node 24, Pages is live, the relay is
gone, and the runtime uses real identities — a passphrase-unlocked key per device, the first device the unit's Master,
and people admitted by the Master's signed credential with a role — instead of the mock identity provider.

Do this on your phone, in its normal browser. You will need two browser tabs open at the same time to play the parts of
two separate devices: a normal tab for the Master, and a private/incognito tab for the joining device (a private tab
keeps its own separate storage, so it behaves like a second phone).

## 1. Open the app

Open **https://jonathan-a-white.github.io/argus/** in a normal browser tab. Call this **Device A**.

**Expect:** a screen titled "Set up this device" with the text "A.R.G.U.S. has not been set up on this device yet." and
two buttons: **Create this unit's Master identity** and **Join a unit**.

## 2. Create the Master identity (Device A)

Tap **Create this unit's Master identity**.

**Expect:** a form titled "Create this unit's Master identity" with two fields, **PASSPHRASE** and **CONFIRM
PASSPHRASE**, and two buttons, **Back** and **Create Master identity**.

Type a passphrase of at least 12 characters that includes a letter and a number (for example `supply closet 42`) into
both fields, then tap **Create Master identity**.

**Expect:** after a short pause while the device generates and encrypts its keys, the app opens directly to the main
screen (the Count tab, showing "Count with confidence.").

## 3. Check the Master's own roles panel (Device A)

Tap the **More** tab at the bottom, then tap the **Roles & access** tile.

**Expect:** a panel titled "Roles & access" showing:
- **IDENTITY**: a long text starting with `p256:`
- **ROLE**: `MASTER`
- **PEOPLE THIS DEVICE KNOWS**: one entry, "You · MASTER"

Leave this panel open; you will come back to it in step 6.

## 4. Join a unit from a second device (Device B)

Open a new **private/incognito** browser tab at the same address, **https://jonathan-a-white.github.io/argus/**. Call
this **Device B**.

**Expect:** the same "Set up this device" screen as step 1.

Tap **Join a unit** this time.

**Expect:** a form titled "Join a unit" with the same **PASSPHRASE** / **CONFIRM PASSPHRASE** fields and a **Join this
unit** button. Type a passphrase into both fields (it can be the same one or a different one — each device's passphrase
is independent) and tap **Join this unit**.

**Expect:** a screen titled "Waiting for admission" explaining that the device is waiting to be admitted, with a box
labeled **YOUR IDENTITY CODE** containing a long text code starting with `ARGUS-IDENTITY-1:`, and a **Copy identity
code** button beneath it.

## 5. Copy Device B's identity code

On Device B, tap **Copy identity code**.

**Expect:** the button's label changes to "Identity code copied ✓". This code contains no secret key material — it is
safe to share by any text channel (a message, an email, reading it aloud).

## 6. Admit Device B (Device A)

Switch back to Device A's "Roles & access" panel from step 3. Scroll down to the **ADMIT A PERSON** section.

Paste the identity code you copied from Device B into the **IDENTITY CODE** box. Choose **Supply Officer** from the
**ROLE** dropdown (the other choices are Instructor and Supply Assistant). Leave **EXPIRES (OPTIONAL)** blank. Tap
**Admit**.

**Expect:**
- A new box, **CREDENTIAL CODE FOR THIS PERSON**, appears containing a long text code starting with
  `ARGUS-CREDENTIAL-1:`, with a **Copy credential code** button beneath it.
- The **PEOPLE THIS DEVICE KNOWS** list now shows a second entry for the admitted person, showing role `SUPPLY_OFFICER`
  and today's date.

Tap **Copy credential code**.

**Expect:** the button's label changes to "Credential code copied ✓".

## 7. Enter the credential on the joining device (Device B)

Switch back to Device B, still on "Waiting for admission". Paste the credential code you copied from Device A into the
**CREDENTIAL CODE** box under "Enter your credential", then tap **Join with this credential**.

**Expect:** the device unlocks directly into the main screen (the Count tab), now signed in with the Supply Officer
role.

## 8. Check Device B's roles panel

On Device B, tap **More**, then **Roles & access**.

**Expect:** a panel showing:
- **ROLE**: `SUPPLY_OFFICER`
- **PEOPLE THIS DEVICE KNOWS**: two entries — "You · SUPPLY_OFFICER" and the Master, shown with role `MASTER` — plus a
  note that other people are learned through the chain in a later epic.

## 9. Confirm a bad credential is refused

Open a third, fresh private tab at the same address and tap **Join a unit** as in step 4 to reach "Waiting for
admission" again. Type anything (for example `not a real credential`) into the **CREDENTIAL CODE** box and tap **Join
with this credential**.

**Expect:** a red error message explaining that the credential could not be accepted, and the device stays on the
"Waiting for admission" screen.

## 10. Lock a device

On either Device A or Device B, tap **More**, then **Lock this device**.

**Expect:** the device returns to an "Unlock A.R.G.U.S." screen asking for its passphrase, confirming the passphrase is
required again on the next visit.
