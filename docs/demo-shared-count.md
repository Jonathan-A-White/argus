# Demo: two people, one shared count, on BSV testnet

What this proves: two people with **their own keys** share **one** data pool stored on the BSV
testnet chain — no server. Person A counts 3 PT Shorts, person B counts 3 PT Shorts, and both
phones show **6**. The officer finalizes and on-hand becomes 6 on both.

You need two browsers that do not share storage (two phones, or one normal and one private window)
and a few thousand testnet satoshis from a BSV **testnet** faucet. Never send real BSV.

## 1. Create the unit (Phone A — the Master)

1. Open the app. **Expect:** “Set up this device” with *Join my unit* and *Create a new unit*.
2. Tap **Create a new unit** → unit name (e.g. *Bethel NJROTC*), your name, a passphrase (12+
   characters with a letter and a number) twice → **Create unit**.
3. **Expect:** the main app with the **BSV TESTNET** banner, your name and role **Master**.
4. Tap the status pill (top right) → **Wallet & sync** → **Copy address**. Send testnet coins to it
   from a faucet. Tap **Refresh balance** until it shows them (a minute or two).

## 2. Join (Phone B)

1. Open the app → **Join my unit** → your name + a passphrase → **Create my key**.
2. **Expect:** “Waiting for admission” with **YOUR JOIN CODE**. Tap **Share or copy join code** and
   send it to Phone A (text/email is fine — it contains no secret).

## 3. Admit (Phone A)

1. **More → Members & access** → paste the join code, pick **Supply Officer**, leave the top-up
   checked (2,000 satoshis) → **Admit**.
2. **Expect:** an **ADMISSION CODE** and a “view transaction” link. Send the code back to Phone B.

## 4. Enter the admission code (Phone B)

Paste it into **ADMISSION CODE** → **Join unit**. **Expect:** the main app, role **Supply Officer**,
same unit name. Within ~15 seconds **More → Members & access** lists both people on both phones.

## 5. Set up sizes (either phone)

**Inventory → PT Shorts → Add sizes → Letter sizes (XS–3XL)** → tap **S, M, L** → **Add 3 sizes**.
**Expect:** three sizes at 0 on hand, on both phones after the next sync.

## 6. Count together

1. Phone A: **Count** → **Start shared count**.
2. Both phones: choose **PT Shorts → M**, with COUNT BY 1 tap **Add** three times, **Add my count to shared total**.
3. **Expect on both phones (within ~15 s, or tap Sync now):** **SHARED TOTAL 6**, with each
   person’s 3 listed.

## 7. Finalize (Phone A or any Supply Officer)

**Finalize count** → review (on-hand 0 → 6) → confirm. **Expect:** on both phones, Inventory shows
**PT Shorts · M — 6 on hand**, and Activity shows each change as **SYNCHRONIZED** with a testnet
transaction link; once the next testnet block is mined it also reads **VERIFIED in block N**.

## What to look at on chain

**More → Wallet & sync → Unit history address** opens the unit’s anchor address on WhatsOnChain.
Every transaction there carries only ciphertext: no names, items, sizes or quantities.
