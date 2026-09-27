# ADR 010 — One encrypted, deterministic unit ledger on BSV testnet

Date: 2026-09-27 · Status: accepted (owner decisions recorded below)

## Context

The owner’s goal: a collaborative central data pool where every person has their own key but
everyone sees the same data — e.g. A counts 3 PT Shorts and B counts 3 → 6 everywhere — stored on
BSV instead of a database or server, with cadet data encrypted and identified by IDs, starting from
zeroed data with editable sizes.

Before this change the deployed app bypassed its identity gate and ran as one mock user; sync went
to an in-memory mock; counts replaced stock instead of adding; application depended on arrival
order, so devices diverged; seed data was fake; cadet names were stored in plaintext; and several
parallel, unwired implementations (relay sync engine, embedded wallet, chain history/key-grant
providers, v1 identity) coexisted.

## Owner decisions (2026-09-27)

1. Cadet names: **encrypted name + cadet ID** — IDs shown everywhere; names optional, encrypted,
   revealed on tap.
2. Wallets: **one per device; the Master tops members up** from its own testnet wallet.
3. Counting: contributions **add up**; an **officer finalizes** and on-hand is replaced by the total.
4. Catalog: **specification items at zero quantity, sizes to be added** by staff.

## Decision

* A single event-sourced ledger per unit. Projection = deterministic fold of all signature-valid
  events in (Lamport clock, eventId) order over a constant genesis catalog.
* Envelope v2: only `{v, unit, epoch, eventId, z, nonce, ct}` is public; the signed event and the
  author’s Master-signed credential are inside AES-256-GCM under the unit data key.
* Transport: this device’s wallet writes batched `OP_FALSE OP_RETURN "ARGUS" 0x02 'E' <envelope>`
  outputs plus a 1-satoshi output to the unit anchor address; devices discover records by walking
  the anchor address history on WhatsOnChain testnet. The wallet persists signed transactions
  before broadcast and rebroadcasts identical bytes after ambiguous failures (exactly-once).
* Local storage holds ciphertext only (IndexedDB); plaintext exists in memory while unlocked.
* Device vault v2: one passphrase unlocks the signing, ECDH, wallet, (authority) and unit keys.
  Admission by public join/admission codes; no key is ever copied between people.
* Generic chain code (WhatsOnChain client, OP_RETURN record codec, pending-spend handling) is
  adapted from spell-forge `src/bsv` (MIT) — rather than installing the package, which pulls in
  scrypt-ts — with three of its bugs fixed (duplicate outpoints, recording unspent outpoints as
  pending, broadcast retry misreporting success as failure).

## Removed (superseded) modules

`src/blockchain/{EmbeddedTestnetWallet, ChainPrivateHistoryProvider, ChainKeyGrantProvider,
EncryptedEventTestnet, eventTransaction, walletRuntime, whatsonchain, ArgusWalletAdapter,
AuditOutbox, BlockchainTransactionCoordinator, MockBlockchainProvider, MockSigner,
UtxoReservationStore}`, `src/private-sync/{ChainKeyDistribution, crypto, engine,
eventSyncProvider, keys, provider, runtime}`, `src/identity/{deviceIdentity, runtime, screens/*}`,
`src/audit/*`, `src/data.ts` and the legacy AppData functions in `src/domain.ts`. Their
replacements are `src/chain/*` and `src/unit/*`. History remains in git.

## Consequences

* Works with no A.R.G.U.S. server; depends on a public testnet indexer (WhatsOnChain).
* Mainnet remains impossible. Live proof requires network access + a faucet-funded wallet
  (`npm run testnet:keys`, `npm run test:testnet`).
* Open work: key rotation on revocation, SPV inclusion proofs, dashboard/calendar/alerts (master
  spec stages 4–5), roster import and annual rollover.
