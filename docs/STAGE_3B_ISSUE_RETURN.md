# Stage 3B — Issue and Return

Stage 3B is integrated into the Stage 3A.5 consolidated architecture. `RepositoryState` remains the only operational authority, `DistributedAppController` returns `ArgusAppProjection`, and React never joins supply operations to legacy `AppData` or performs parallel business writes.

## SKU and bundle rules

One `InventoryProjection` is one stock-keeping variant. Selectors display real variants and store the selected inventory entity ID; the domain derives canonical name and variant from that ID. Client labels or free-text sizes cannot redirect one SKU while recording another. Inactive SKUs are excluded and rejected.

Bundle lines use only explicit `itemId`. Mapping status comes from the Stage 3A.5 `FULLY_MAPPED`, `PARTIALLY_MAPPED`, or `UNMAPPED` projection. Names are never guessed. Current versions resolve by `currentVersion`, not array order, and Issue stores the exact immutable version snapshot.

## Atomic transaction model

One confirmation creates one signed `ITEM_ISSUED` or `ITEM_RETURNED` event whose opaque entity ID is the stable transaction ID. Lines include unique IDs, canonical SKU snapshots, quantities, and base versions. Returns reference original property IDs. Event, outbox, inventory, property, Still Needed, and history commit in one repository transaction.

Validation completes before mutation. An Issue may not name one SKU twice; a Return may return two separate holdings of the same size but never the same holding twice. Separate Issues retain separate property provenance. Quantities are whole numbers from 1 through 100, a guardrail against accidental bulk entry. Duplicate delivery is idempotent, while event or transaction IDs reused for different content are rejected.

## Partial Issue and Still Needed

Required mapped out-of-stock and unmapped lines remain missing during review and become `INCOMPLETE_ISSUE` requirements after explicit partial confirmation. Optional omissions do not. A line for an item with no sizes yet records the bundle line's `catalogId`. Equivalent requirements append to `relatedTransactionIds`, preserving provenance.

Fulfillment is deterministic and always for the same cadet, oldest requirement first within each tier: (1) the requirement an issued line names by `requirementId`; (2) requirements pinned to that exact SKU (`itemId`); (3) requirements raised before the item had sizes — matched by `catalogId`, or by label against the item name when no catalog item was recorded — whose recorded size equals the issued size; (4) the same without a recorded size. A requirement pinned to another SKU, or recording a different size, stays open. One line may fulfil several requirements; partial quantities remain `PARTIALLY_FULFILLED`. Staff with `cadets.manage` can also close an open requirement by hand from the cadet record or the Still Needed panel: Fulfil (optional note) or Cancel (reason required), signed as `STILL_NEEDED_FULFILLED` / `STILL_NEEDED_CANCELLED` with `closeReason`.

The Issue workflow shows the cadet's actual current property (item, size, quantity, issue date) and open Still Needed before the issue type is chosen. Recommended bundles come only from each bundle's `genderApplicability` and `purpose` (`recommendBundles`): per purpose, bundles for the cadet's gender win and an `Any` bundle is recommended when none serves that purpose; every other bundle stays available as the manual override. Bundle issues can gain extra individual lines and drop optional ones; each sized line keeps its own size, and unsized items never show a size picker.

## Return, offline, and conflicts

Return shows only selected-cadet property and permits inactive cadets to return gear. Quantities cannot exceed possession. Returns do not create Still Needed.

Each return line may carry a `condition` and a short `note`. **Decision:** only `SERVICEABLE` returns go back on the shelf and increase on-hand. `NEEDS_REPAIR`, `UNSERVICEABLE` and `LOST` still clear the cadet's property (and reduce `issued`) but add nothing to on-hand, because none of them can be issued again. A return without a condition (older events) counts as serviceable. The workflow states this rule and shows "Stock stays N" for non-serviceable lines in review; the condition and note appear in the cadet's history.

Offline confirmations persist signed events, projections, transactions, and outbox entries in IndexedDB. Reopen restores them. A stale final-unit Issue quarantines the entire remote transaction. The inventory-keyed conflict identifies the losing cadet, inventory IDs, the losing event and the resulting impossible state (`shortfalls`, e.g. "would leave −1 SDB Jacket · M"), includes the competing signed events, leaves stock nonnegative, and requires `conflicts.resolve`.

A conflict ID names only its losing event and lists the events folded before it, so it is identical however the history was delivered. `CONFLICT_RESOLVED` carries an explicit `outcome`: `KEEP_AS_IS` leaves the losing event unapplied; `RECORD_STILL_NEEDED` (losing Issues only) makes every device create the same `CONFLICT_RESOLUTION` requirements (`need:<resolution event>:<line>`) for each line of the losing Issue and its cadet. The first resolution in canonical order wins; later ones stay in history without effect. Resolutions without an outcome, and those naming a conflict by an older all-event-ID form, still apply as `KEEP_AS_IS`.

## Corrections

Size mistakes use `PROPERTY_CORRECTED`. Quantity mistakes use `RECORD_CORRECTED` with an explicit `kind` — `RECEIPT_QUANTITY` (an `INVENTORY_RECEIVED`), `ISSUE_QUANTITY` or `RETURN_QUANTITY` (one line, by `lineId`) — plus `targetEventId`, `from`, `to` and a `reason`; it requires `inventory.adjust`. The original event stays; state shows the corrected value (`correctedQuantity` on transaction lines). A receipt correction moves on-hand by the difference; an issue correction moves on-hand and the cadet's holding; a return correction moves the holding (restoring it from the return's snapshot if it was removed) and, for serviceable returns, on-hand. When a physical count of that size was folded after the original record, the count already measured the shelf, so only the record and holding change. A correction whose `from` no longer matches (a concurrent correction) or that would leave negative stock or property becomes a conflict instead of applying; the command refuses such a correction locally. A `RECORD_CORRECTED` without `kind` (legacy annotation) changes nothing. Corrections are offered from the cadet's issue/return history and the inventory item's received-stock history.

## Migration, privacy, and limitations

The logical repository schema advances from 4 to 5 and initializes `transactions: []`. Physical IndexedDB remains version 4 because no store or index changed. Existing upgrade guards and source-preserving failures remain. Legacy property references receive unique deterministic `legacy:<cadet>:<index>:...` identifiers.

Full events use private synchronization. Public commitments remain opaque and hash-based, excluding cadet names, gender, NS level, sizes, property, and Still Needed details. Mainnet remains disabled. Production transport/custody, persisted drafts and disposition of non-serviceable returns (repair, write-off) remain later work.
