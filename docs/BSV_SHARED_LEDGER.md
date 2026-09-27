# A.R.G.U.S. shared ledger on BSV testnet

Status: **implemented and tested against an in-memory chain; live BSV testnet run pending**
(needs `api.whatsonchain.com` network access and a faucet-funded wallet — see “Live testnet check”).
Supersedes the relay-era documents (`BSV_SHARED_SYNC_IMPLEMENTATION.md`,
`SHARED_COUNTING_MILESTONE.md`, `IMPLEMENTATION_STATUS_2026-09-26.md`) and the demo in
`demo-argus-foundation.md`. Decision record: [ADR 010](adr/010-bsv-shared-ledger.md).

## What the unit gets

* **One shared data pool, no server, no database.** Every change anyone makes — counts, sizes,
  stock receipts, cadets, issues, returns, bundles, conflict resolutions, admissions — is a signed
  event that is encrypted and written to BSV **testnet**. Every device reads the same history back
  from the chain and computes the same numbers.
* **Each person has their own key.** The Master admits people; nobody ever copies a key.
* **Shared, additive counting.** A counts 3 PT Shorts, B counts 3 PT Shorts → every device shows
  **6**. A Supply Officer (or Master) finalizes the count and on-hand becomes 6 everywhere.
* **Cadets by ID.** Cadets are shown as short opaque IDs (e.g. `C-4F7K`). A name is optional; if
  entered it only ever exists encrypted on chain/disk and is shown on screen only when someone taps
  “Show name”.
* **No placeholder data.** A new unit starts with the 25 items named in the master
  specification’s bundles, at **zero** on hand and with **no sizes**. Sizes are added per item from
  presets transcribed from the NJROTC Supply Manual size charts (Tables 2-6 … 2-10) or typed in.

## How it works

```text
UI ──► DistributedAppController ──► ArgusReplica (plaintext, in memory only)
                                        │  signed event (ECDSA P-256, per person)
                                        ▼
                               UnitEventSyncProvider ── seals { event, author credential }
                                        │                with the unit data key (AES-256-GCM)
                                        ▼
                               LedgerStore (IndexedDB, ciphertext only)
                                        │
                                        ▼
                               ChainTransport ──► DeviceWallet (this device’s testnet key)
                                        │            builds: OP_FALSE OP_RETURN "ARGUS" 0x02 'E' <envelope> …
                                        │                    + 1 sat → unit anchor address + change
                                        ▼
                               WhatsOnChain testnet  ◄── every device walks the anchor address
                                                          history (confirmed + mempool) to find
                                                          everyone’s records
```

### Deterministic convergence (why every device shows the same number)

Every event carries a **Lamport clock** (one more than the highest clock its author had seen).
The projection is always *the fold of all known, signature-valid events in (clock, eventId)
order over the genesis catalog*. Events that extend the order are applied incrementally; anything
that arrives “in the past” (an offline device catching up, a reordered chain page) triggers a full
rebuild. Consequently two devices holding the same events hold byte-identical projections — a
property tested with randomized delivery orders (`src/distributed/convergence.test.ts`).

Conflicts are only raised for **physically impossible** outcomes — issuing stock that is not
there, returning property a cadet no longer holds — or genuinely concurrent edits of the same
fields. Two officers issuing from a well-stocked shelf at the same time is not a conflict. Each
conflict is deterministic (every device sees the same one) and is resolved with a signed
`CONFLICT_RESOLVED` event (More → Conflicts).

### Counting rules

* A **shared count** (Count tab) is open until an officer finalizes or cancels it.
* Each person’s “Add my count” is an immutable contribution; contributions **add up** per size.
  People fix their own mistakes with an append-only correction.
* **Finalize** (Supply Officer / Master) freezes exactly the contributions that device has seen and
  replaces on-hand of every counted size with the shared total. Sizes nobody counted are
  unchanged. Contributions that reach the chain after finalization are shown as **LATE** and never
  silently change stock. Stock movements during the count are listed as “verify” warnings.
* **Receive stock** (Inventory → item → size) is additive (+N) and commutes across devices.

### Identity, admission and keys

| Secret (per device, sealed under the passphrase) | Purpose |
|---|---|
| signing key (ECDSA P-256) | signs every event this person creates |
| ECDH key (P-256) | lets the Master hand this device the unit data key |
| wallet key (secp256k1, testnet) | pays the few satoshis each record costs |
| unit data key (AES-256), per epoch | encrypts everything the unit writes |
| authority key (Master only) | signs member credentials |

One PBKDF2-SHA-256 (600k) derivation unlocks them; each secret is separately AES-GCM sealed.
Admission uses two **public** codes: the joiner’s `ARGUS-JOIN-1` (signing key, ECDH public key,
wallet address, display name) and the Master’s `ARGUS-ADMIT-1` (Master-signed credential + the unit
key wrapped with ECDH→HKDF→AES-GCM to the joiner). Neither code is useful to anyone else. The
Master also publishes an `AUTHORITY_GRANTED` event so every device learns the member’s name, role
and wallet, and can optionally send the new member testnet satoshis (default 2,000, editable).

Every envelope carries its author’s Master-signed credential inside the ciphertext, so any member
can verify any other member’s role without a directory server. Revocation is an
`AUTHORITY_REVOKED` event; it forces a re-fold so a revoked member’s later events stop applying.

### What is public on chain

Per record, only: format version, opaque unit ID, key epoch, random event ID, nonce, ciphertext
(`PUBLIC_ENVELOPE_FIELDS`, asserted in tests). Who acted, what they did, when, item names, sizes,
quantities, cadet IDs and names, member names, notes — all inside AES-256-GCM. Observers can still
see: that a unit exists (anchor address), how many records it writes and when, their sizes, and
which testnet wallets paid for them.

### Cost

About 1–3 KB per record at 1 sat/kB (the rate proven on testnet by spell-forge) plus the 1-satoshi
anchor output: roughly **2–5 satoshis per change**. Queued changes are batched (up to 25 per
transaction). 1,000 satoshis covers a few hundred changes; 20,000 covers thousands. Mainnet is impossible in this build.

## Operating it

1. **Master (first person):** open the app → *Create a new unit* → unit name, your name,
   passphrase. Fund the Master wallet: More → Wallet & sync → copy the address → send testnet
   coins from a BSV testnet faucet.
2. **Everyone else:** open the app → *Join my unit* → your name, passphrase → send the join code to
   the Master.
3. **Master:** More → Members & access → paste the join code, choose the role, keep “Send them testnet satoshis” checked (default 2,000) → *Admit* → send back the admission code.
4. **Joiner:** paste the admission code → *Join unit*.
5. Inventory → pick an item → *Add sizes* (presets or custom) → Count → start a shared count →
   everyone adds their tallies → an officer finalizes.

Status indicators: the top-right pill shows `SYNCHRONIZED`, `N QUEUED`, `SYNCING`, `OFFLINE ·
WORKING LOCALLY`, `NEEDS TESTNET COINS`, or `CONFLICT · ACTION REQUIRED`. Work done offline is
kept (encrypted) and published when the device is back online and funded.

## Live testnet check

```bash
npm run testnet:keys     # once: creates ~/.config/argus/testnet-keys.json (0600, never committed) and prints an address
# fund that address from a BSV testnet faucet (600+ satoshis is enough for one run)
npm run test:testnet     # creates a fresh unit, admits two members, A 3 + B 3 = 6, finalizes, rebuilds a fresh device from chain
```

The run writes `testnet/last-run.json` with the anchor address and every transaction ID
(WhatsOnChain testnet links) as evidence. It needs outbound HTTPS to `api.whatsonchain.com`.

## Known limits and open decisions

* **Discovery relies on WhatsOnChain** (a third-party indexer) — it is not our server, but it is a
  dependency. An outage means devices keep working locally and catch up later. Swapping in another
  indexer means implementing `ChainApi` (`src/chain/types.ts`).
* **Key rotation after revocation is not yet implemented.** A revoked member can no longer write,
  but a device that already holds the unit key could still decrypt new records if it keeps reading
  the chain. Rotation (new epoch key wrapped to remaining members as `'G'` records) is the next
  security task.
* **Encrypted data on a public chain is permanent.** If a unit key ever leaks, that epoch’s history
  is readable forever. The school/command should approve storing even encrypted, ID-only student
  records this way before real cadet data is entered.
* **Timestamps are device-claimed.** Authorization windows (expiry/revocation) use them; a dishonest
  device could backdate. Keep credential lifetimes bounded.
* **Merkle-proof (SPV) verification is not wired in.** `VERIFIED` means signature and role were
  checked by this device; `src/blockchain/spv.ts` is ready for adding chain-inclusion proofs.
* **Passphrases cannot be recovered.** Losing one means erasing the device and being re-admitted;
  unpublished changes on that device are lost.
