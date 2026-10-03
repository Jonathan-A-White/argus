# Many phones at once: request budget and shared wifi

Every device talks to the BSV testnet through WhatsOnChain (WoC). WoC allows about **3 requests per second per IP address**
without an API key. Phones on the same wifi share one address, so for them the limit is shared too. This page states what one
device costs, what a whole unit costs, and what the chain client does when WoC says "slow down".

The numbers below are measured, not guessed: `src/unit/manyDevices.test.ts` runs 20 devices (one Master and 19 Supply
Officers) on one in-memory chain and asserts them. If the code changes and a number moves, that test fails and this page needs
the new figure.

## What one device costs

| What the device does | Requests to the chain API |
|---|---|
| A sync with nothing new anywhere (the steady state) | **2** per scan: 1 confirmed-history page, 1 mempool-history list |
| A sync that publishes one command | **5**: 1 broadcast and 2 scans (the scan runs again after the publish) |
| Reading a transaction another device published | **1** per transaction, once (the hex is fetched, then the transaction is remembered) |
| Anything else in steady state (coin lookups, block height) | 0 |

So the per-device budget is **2 requests per scan at steady state**, plus 1 request for every new transaction from someone else.
A scan with no new transactions never fetches a transaction. A busy minute is dominated by the third row, not the first.

Measured with the 20-device test: 100 commands (5 per device, issues and returns, spread over 10 cadets) went out in 100
transactions; every one of the 19 other devices fetched each of them exactly once (1,900 fetches), and all the scans came to
about 390 more requests. That is **about 24 requests per command for a 20-device unit** (19 fetches plus about 2 scans per device
shared out), and it grows with the number of devices because every device reads every transaction.

A single phone is never the problem: the client spaces its own requests 350 ms apart (at most about 2.9 a second from one device).

## Cadence

* **Staff devices** scan every **15 s** (`ChainTransport.start`, default `intervalMs`), and again at once when the app comes to
  the front or the phone comes back online, or when a command is queued.
* **Cadet devices** are planned to scan every **5 minutes**. There is no cadet-side build yet; this is the budget it is held to.

## The shared-wifi math (one IP, about 3 requests per second)

20 staff and 250 cadets on the same wifi, nothing being issued:

| Group | Calculation | Requests per second |
|---|---|---|
| 20 staff at 15 s | 20 × 2 ÷ 15 | 2.67 |
| 250 cadets at 5 min | 250 × 2 ÷ 300 | 1.67 |
| **Total, idle** | | **4.33** (about 144 % of the limit) |

So on one shared address the planned cadences are **over the limit before anyone issues anything**. Ways to fit, each by itself:

* Keep staff at 15 s (2.67 per second) and let cadets scan only every 2 × 250 ÷ (3 − 2.67) ≈ **25 minutes**.
* Keep cadets at 5 minutes (1.67 per second) and let staff scan only every 20 × 2 ÷ (3 − 1.67) ≈ **30 seconds**.
* Put the 20 staff phones on mobile data: each phone then has its own address and its own 3 per second. Only the 250 cadets
  share the wifi (1.67 per second, inside the limit).
* Use a WoC API key (the client already accepts extra headers) for a higher limit.

Activity makes it worse, not better. Every transaction costs every reading device one fetch. With all 270 devices reading
everything, one new transaction costs 269 fetches, so a shared 3 per second allows only about 3 ÷ 269 ≈ 0.011 transactions per
second (**about 40 transactions an hour**) even with no polling at all. With the 20 staff alone on the address it is
19 fetches per transaction: after the 2.67 per second of polling, the 0.33 per second left allows about one transaction a minute.
During a busy issue day a shared address will be rate-limited, so the client has to cope with it (below).

Levers outside this page's scope: publish several records per transaction (the wallet already allows many records in one
transaction; today each synced command goes out alone), scan less often when a scan was limited, give cadets read-only views that
do not need every transaction, mobile data or a key for staff.

## When WoC answers 429

`src/chain/woc.ts` (`WhatsOnChainApi.get`) retries a limited read instead of failing the scan:

* The wait starts at 500 ms and doubles each time, up to 8 s, and **random jitter of up to the same amount is added** to every wait
  (so a wait is between 1× and 2× its base). Without jitter, phones that were limited together would come back together and
  be limited again.
* A 429 is retried up to **6 attempts** (5 waits: about 0.5, 1, 2, 4 and 8 s before jitter). Other server errors and rejected
  requests are retried up to 3 attempts, as before.
* If it still fails, the scan fails and the transport tries again on its next tick. Nothing is lost: queued records stay queued,
  a transaction already broadcast is not sent again, and a missed scan does not make the device think its transaction was lost
  (that needs three successful scans that do not see it, over at least a minute).
* Broadcasts are never retried by the client: re-sending after an unclear answer is the wallet's decision.

One limit to know about: WoC's 429 reply carries no CORS header, so **a browser sees a failed request, not a 429**. The client
cannot tell the two apart and applies the 3-attempt limit with the same doubling and jitter. The 6-attempt patience applies where
the status is visible (a key, or a proxy that adds the header).
