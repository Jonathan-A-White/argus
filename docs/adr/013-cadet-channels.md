# ADR 013: Cadet channels

**Status:** accepted for implementation, 2026-10-03 (story mw-kmgi38.1 of epic mw-kmgi38). This first version covers the
domain: the unit-log events, the projections, the cadet's record (CadetView), sealing to a channel and the channel address.
The cadet ticket (mw-kmgi38.2), publishing (mw-kmgi38.3), cadet mode (mw-kmgi38.4) and notices (mw-kmgi38.5, .6) build on it
and will amend this ADR; mw-kmgi38.9 makes it final.

## Context

Luke wants a CADET role: every cadet in the unit can see what they have and what they still need to be issued, and nothing
else (epic mw-kmgi38, 2026-10-03). His decisions on that epic (cards on mw-6ww.66):

* **Q1 A, real privacy:** a cadet's phone can only ever read that cadet's own record. Cadets never join the unit log; staff
  phones write each cadet a small sealed record.
* **Q2 A, a ticket per cadet,** issued from the cadet's record the way staff are admitted today (ADR 012).
* **Q3 A, both kinds of notice:** to ALL cadets (one record, sealed to a notices key every cadet's ticket grants) and to ONE
  cadet (sealed to that cadet alone).
* **Q4 A, headroom:** 250 cadets.

Today every unit record is an event envelope (v2) sealed under the unit's epoch key and paid to the unit anchor address
(ADR 010, `src/unit/envelope.ts`, `src/blockchain/anchor.ts`). Whoever holds an epoch key reads the whole unit: every cadet's
name, sizes and gear, every member, every count. A cadet must never hold one. And a key rotation puts every member's grant in
one sealed record (about 100-120 fit), so 250 cadets could never be members anyway.

## Decision

Every cadet gets a **channel**: a key and an address of their own, outside the unit log. The unit has one more channel for
notices to all cadets.

### The channel key and address

* A channel key is 32 random bytes (AES-256), written as 64 lowercase hex characters (`newChannelKey`, `src/unit/envelope.ts`).
  A staff device makes it when it runs the command; the fold never makes randomness.
* The channel address is derived from the key: the first 20 bytes of `sha256("argus-cadet-channel:" || key bytes)`, as a
  testnet P2PKH address (`channelAddress`, `src/blockchain/anchor.ts`). Whoever holds the key can find the records; the address
  alone gives nobody the key; the label keeps it apart from every unit and key-grant anchor. Like those anchors it is a label,
  not a spendable key. Testnet only (`assertTestnetOnly`).

### Recorded in the unit log, which cadets never read

| Event | Payload | Permission | Fold |
|---|---|---|---|
| `CADET_CHANNEL_CREATED` | `{cadetId, channelKey, channelAddress}` | `cadets.admit` | `cadetChannels` gains `{cadetId, channelKey, channelAddress, version: 1, ...}` |
| `CADET_CHANNEL_ROTATED` | `{cadetId, channelKey, channelAddress, reason}` | `cadets.admit` | replaces the key and address, `version + 1` |
| `CADET_NOTICES_KEY_CREATED` | `{key, address}` | `notices.send` | sets `noticesChannel` once per unit |

The commands are `createCadetChannel(cadetId)`, `rotateCadetChannel(cadetId, reason)` and `createNoticesKey()` on
`ArgusReplica` (and `DistributedAppController`). The key travels inside the unit log, which is sealed under the epoch key:
every staff member can read every channel key (staff already read every cadet's record in the clear), and no outsider can.

The fold checks every one again, since events from other devices are untrusted: the author's permission; a key of exactly 64
lowercase hex characters; an address that `channelAddress(key)` reproduces; a cadet the unit has; one channel per cadet and one
notices key per unit (of two made offline, the first in the unit's `(clock, eventId)` order holds, and the second is a
visible rejection on every device); a rotation only of an existing channel, with a reason; and **no key used twice**, by two
cadets or by a cadet and the notices channel, since a shared key would let one phone read the other's records.

### Who may (provisional, Luke's to confirm)

MASTER, INSTRUCTOR and SUPPLY_OFFICER hold the new permissions `cadets.admit` and `notices.send`; SUPPLY_ASSISTANT does not.

The new role **CADET** holds no unit permission (`ROLE_PERMISSIONS.CADET = []`), and a cadet is never a member:

* `AuthorizationService.acceptCredential` refuses any credential with role CADET, so no device ever counts a cadet as a
  member, and no rotation ever wraps a unit key to one;
* `ticketRuleViolation(_, 'CADET')` refuses a staff ticket for a cadet (a staff ticket package carries the epoch keys); the
  ticket schema also refuses a CADET role. The cadet ticket is its own package (mw-kmgi38.2).

### The cadet's record: CadetView

`cadetViewFrom(state, cadetId)` (`src/distributed/cadetView.ts`, also `ArgusReplica.cadetViewFor`) builds it from the fold, so
every staff device holding the same events builds the same record:

```
{ cadetId, cadetCode, fullName, sizes,
  have: [{ itemId, label, size, quantity, issuedAt }],     // current property, in fold order
  stillNeeded: [{ label, size?, quantity }],               // open needs, the quantity still to issue
  version, updatedAt }
```

Nothing else: no gender, NS level, status, return notes, staff names, transaction or event IDs. `cadetCode` is the code staff
see (`cadetLabel`). `size` on a need is the need's own size, or the size of the exact item it names, or absent ("any size").

**version** is the cadet's projection version plus the versions of all of the cadet's Still Needed lines. The cadet's own
version counts every folded change to the cadet (create, profile edit, each issue and return); a Still Needed change does not
touch the cadet, so the record adds the needs' versions: every change a cadet can see raises it, and a phone keeps the
record with the highest version. **updatedAt** is the latest of those changes' times. This is a refinement of the story's
"version equal to the projection's": with the cadet's version alone, a new Still Needed line would not make a newer record.

### Sealing to a channel: envelope v3, record kind 'C'

`sealToChannel({channelId, key, kind, plaintext})` / `openFromChannel(envelope, key, channelId?)` in `src/unit/envelope.ts`:

```
{ v: 3, ch, kind: 'view' | 'notice', z, nonce, ct }
```

* `ch` is the channel's address. There is no unit ID and no epoch in the header: nothing ties a channel record to its unit
  in public. The public fields are exactly `PUBLIC_CHANNEL_ENVELOPE_FIELDS`.
* AES-256-GCM under the channel key, deflated when the runtime can (`z`), 12-byte random nonce, the canonical header
  `{v, ch, kind, z}` as additional data: a record moved to another channel, relabelled or with a changed flag does not open.
* Same cap as a unit record: a serialized envelope over 60 KB is refused ("This record is too large to publish.").
* A record sealed to one cadet's key does not open under another cadet's key, the notices key or any unit epoch key; a v2
  unit envelope does not open under a channel key. v2 unit envelopes are unchanged.

On chain a channel record is an A.R.G.U.S. record of kind **'C'** (`src/chain/codec.ts`), paid to the channel address.
The unit transport reads only kind 'E' at the unit address, so a 'C' record found there (anyone can pay any address) is
skipped, and an 'E' record beside it in the same transaction is still read.

## What a cadet phone holds

Only, from its cadet ticket (mw-kmgi38.2):

* its own channel key and channel address;
* the unit's notices key and notices address;
* its cadet ID and display name, and its own device keys.

It holds **no** epoch key, no unit credential, no key grant and no other cadet's key. It polls two small addresses and can
open nothing else: not the unit log, not another cadet's record. Losing the phone exposes that one cadet's record and the
notices; Replace phone rotates the channel (new key, new address), and the old phone reads nothing new.

## Consequences

* Staff can read every channel key, as they can read every cadet's record already. A removed staff member who copied
  channel keys before removal could read those cadets' records until each channel is rotated; a unit key rotation does not
  rotate cadet channels.
* A signed credential carries the permission list it was made with. Credentials made before this change lack
  `cadets.admit` and `notices.send`: the unit creator's own Master device credential (`createMasterDevice`,
  `src/unit/vault.ts`), direct admissions and role changes. Members admitted by ticket (whose permissions follow
  `ROLE_PERMISSIONS` when the fold reads them) and devices set up or restored after this change have them. An existing
  unit's Master needs a fresh credential before it can make channels: left to a later story (see mw-kmgi38.1's closing comment).
* Channel addresses are new addresses on WhatsOnChain: a cadet phone reads two, never the unit anchor, so 250 cadets add
  250 small readers, not 250 readers of the unit's history.
