# eB2B Mock Seller NP

A mock ONDC **eB2B (DigiDukaan)** Seller NP (BPP) for buyer-app developers. Point your buyer app's
`bpp_uri` at it: **your app makes every call** (`/search`, `/select`, `/init`, `/confirm`, `/status`,
`/cancel`) and the mock answers with protocol-shaped callbacks to the app's `bap_uri`, per the
scenario you activate for the app's `bap_id`. It covers search, every pre-order outcome the Qwipo
pre-order-service handles, every offer type in the contract, and post-order status / cancel.

## How to test your buyer app

The playground (`/`) works like the ONDC Workbench's flow testing:

1. **Endpoints:** point your app at *Send your calls to* (`<host>/ondc/<action>`) and enter where
   you receive calls: your `bap_uri` (or `bap_id`). Apps that called recently are one-click chips.
2. **Flows:** each scenario is a flow card with a progress bar and **▶**. Press ▶ and use your app.
3. Every call of the flow is a card: **YOU SEND** `search` (*awaiting* → *received*) paired with
   **MOCK** `on_search` (*on hold* → *sending…* → *sent · ACK*). Cards turn red on a NACK, an
   undelivered callback or an answer that doesn't match the scenario. A catalogue search before an
   order is *skipped* if the app uses its cached catalogue.
4. **UNSOLICITED** seller calls (`on_status` Packed / Out for delivery / Delivered, seller
   `on_cancel`) are sent by the page itself once the step before them completes.
5. Click any card to see its actual JSON on the right: **Request** (what your app sent, or the
   callback the mock sent), **Response** (the mock's ACK, or your app's reply to the callback),
   **Guide** (what to do in the app and what the mock answers). **Follow live** tracks the latest.
6. **All calls** lists every call from your app; **■** stops the flow (seller back to normal).

Order flows take **any items**: the seller mode acts on whatever the app ordered (the first item,
or the items given to `/api/mock/mode`). Only offer flows name items, because each offer qualifies
specific items.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000, bpp_uri = http://localhost:3000/ondc
npm test             # every scenario, every seller mode on other carts, offer rules, signing
```

The local server also exposes a throwaway inbox. Set `context.bap_uri` to
`http://localhost:3000/local-bap` and read the callbacks at `GET /local-bap/inbox`.

## Deploy to Vercel

Framework preset **Other**, no build command (`vercel.json` serves `public/` and `api/`).

| Env var | Default | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | request host | Base for image URLs and `bpp_uri` |
| `BPP_ID` / `BPP_URI` | host / `<base>/ondc` | Sent in callback `context` |
| `SIGNING_PRIVATE_KEY`, `BPP_UNIQUE_KEY_ID` | unset | Sign callbacks (ed25519 + BLAKE2b-512). Unsigned if unset |
| `POSTGRES_URL` | unset | Postgres for orders, activated scenarios, per-transaction state and the activity log. Set by Vercel's Supabase integration (the pooled URL). Tables `mock_kv` / `mock_list` are created on first use, with RLS on |
| `FINDER_FEE_TYPE` / `FINDER_FEE_AMOUNT` | `percent` / `3.54` | Used in `on_init` when `/init` doesn't carry it |
| `CREATION_DELAY_MS` | `5000` | Delay before the unsolicited "retailer created" `on_search` |
| `PUSH_DELAY_MS` | `3000` | Delay before the incremental push update |

Without `POSTGRES_URL`, state lives in one function instance's memory, which is fine for
`npm run dev` but not on Vercel: `/status` may answer **30018**, and an activated scenario or the
activity log may not be seen by the next request.

## API

`POST /ondc/{search|select|init|confirm|status|cancel}`

- **Async (default, real ONDC behaviour):** returns `{"message":{"ack":{"status":"ACK"}}}` and then
  POSTs `on_<action>` to `context.bap_uri + "/on_<action>"`. Every `on_search` callback carries
  `X-ONDC-Search-Response: full | inc | p2p`.
- **Sync (Postman, curl, CI):** header `X-Mock-Sync: true` or `?sync=1`. The reply is
  `{ response, callbacks: [{ url, delay_ms, headers, body }] }` and nothing is POSTed.
- **Wait:** header `X-Mock-Deliver: wait`. The callbacks are POSTed now and returned with the buyer
  app's reply (used for seller actions).
- Every reply has an `X-Mock-Scenario` header naming the branch the mock took.

Mock-only endpoints (not ONDC):

- `POST /api/mock/push { order_id, event }`: the seller acts on a confirmed order. `event` is
  `packed | out_for_delivery | delivered` (unsolicited `on_status`) or `seller_cancel`
  (unsolicited `on_cancel`, reason 005).
- `GET /api/mock/mode?bap_id=…`, `POST /api/mock/mode { bap_id, mode, items?, scenario? }`: the
  seller mode for a buyer app (below). It lasts 24h; set `normal` to switch it off.
- `GET /api/mock/activity?bap_id=…`: the calls from that buyer app (last 50, with callbacks and the
  app's answers) and the orders it confirmed. Simulations are not recorded.

## Seller modes

What happens at order time comes from a **seller mode**, not from fixed items. The mode acts on the
items the buyer actually ordered: the ones named for the mode, else the first item of the cart.

| Mode | At | What the seller does to the affected item |
|---|---|---|
| `normal` | | Nothing: in stock at catalogue prices |
| `item_inactive` | `/select` | Disables it: unsolicited incremental `on_search` (`label: disable`), then `on_select` with qty 0 + **40002** |
| `out_of_stock` | `/select` | qty 0 + **40002** |
| `partial_quantity` | `/select` | Half the ordered qty + **40002** |
| `price_changed` | `/select` | 5% above the catalogue price |
| `init_qty_reduced` | `/init` | Half the ordered qty, no error (the buyer re-selects) |
| `confirm_rejected` | `/confirm` | `on_confirm` with **30019** |

- **Your buyer app:** activating a scenario arms its mode for the app's `bap_id`
  (`POST /api/mock/mode`); every call from that `bap_id` then gets it, on whatever items it orders.
- **Simulation / curl:** send the mode on the request as `X-Mock-Mode`, with `X-Mock-Mode-Items`
  for the affected items. The header wins over the armed mode.
- **A mode acts once per transaction and is remembered for it.** The re-select / re-init that
  follows sees the same seller state, so an item stays out of stock and a halved quantity is not
  halved again.
- **Minimum order value is always a real check** against the provider's published
  `order_value.min_value` (P1 500, P2 2000, P3 1500), returning **30023** with the quote.

## Offers

Every offer is published in the full catalogue `on_search` (`offers` per provider): discount
(percent and flat), slab by quantity, weight and value, freebie, buy X get Y, combo.

- **`/select`:** `on_select` lists every offer the cart qualifies for, opt-in ones included, as `offer`
  breakup lines (with the `offer` tag: `type`, `additive`, `auto`, plus `item_id` / `item_count` /
  `item_value` for freebie and buy X get Y). **Only `auto: yes` offers are applied** (all auto +
  additive ones, plus the first auto non-additive one), and only those count in `quote.price`.
  Offers the buyer sends on `/select` are ignored.
- **`/init`:** the buyer sends its selection in `order.offers`. The seller validates it and applies
  exactly that selection, dropping offers the cart doesn't qualify for and keeping only the first of
  the non-additive ones. `on_init` returns the applied ones in `order.offers` and the quote.
  `/confirm` does the same, so the quote matches `on_init`.

## Providers

| Provider | Locations | Items | Minimum order value |
|---|---|---|---|
| **P1** ABC Distributors × ITC (distributor) | L1 Jayanagar, L2 BTM Layout | 8 | 500.00 |
| **P2** XYZ Distributors × HUL (distributor) | L3 Whitefield | 7 | 2000.00 |
| **P3** Ganesh Wholesale × Parle Agro (wholesaler) | L4 Peenya | 5 | 1500.00 |

P1 offers two delivery options: F1 `Standard Delivery` (beat, P2D) and F2 `Immediate Delivery`
(tomorrow, P1D). P2 and P3 offer F1 only.

## Seeded retailers

| Retailer | customer_id | phone | PAN | Credit |
|---|---|---|---|---|
| Sharma Kirana Store | `CUST-2024-001234` | 9876543210 | AABCU9603R | P1 25000, P2 10000 |
| Lakshmi General Stores | `CUST-2024-003311` | 9845011122 | AAKPL1234C | P2 15000 |
| Fresh Mart | `CUST-2024-005678` | 9900112233 | AAFCF4321D | P1 20000 |
| Ravi Provision Store (new) | issued as `CUST-NEW-<last 6 of phone>` | 9811122233 | AAGPR7788M | registers with P1 |

P2P is optional. If a buyer NP sends a P2P `/search`, the mock still resolves the retailer by
customer_id, or by phone_number + PAN, and returns credit, POC, customer and scheme progress.

## Scenarios

Each flow lists the calls your app makes and what the mock answers to each, tracked live once
started. `npm test` runs every flow, every any-items flow with 15 random carts, every mode on other
carts, and the live tracker against a buyer app's calls.

| Group | Scenario | Seller |
|---|---|---|
| Pre-order | Search | Full catalogue `on_search` (header `full`) |
| | Place order (positive) | select (2 delivery options) → init (credit) → confirm, `Accepted` |
| | Place order - tomorrow delivery | Buyer picks F2 `Immediate Delivery` |
| | Place order - walk-in, prepaid (P3) | No customer_id, `ON-ORDER` with a payment link |
| | Item inactive | mode `item_inactive`, then re-select |
| | Item out of stock | mode `out_of_stock`, then re-select |
| | Partial quantity | mode `partial_quantity`, then re-select |
| | Price changed | mode `price_changed` |
| | Minimum order value | Cart below the provider's minimum → **30023**; the buyer scales up and re-selects |
| | Quantity reduced at init | mode `init_qty_reduced` → re-select → re-init |
| | Seller rejects confirm | mode `confirm_rejected` |
| Offers | Discount - opt-in | `discp10` listed but not applied at select; selected at init |
| | Discount - flat amount | `flat150` (auto + additive) |
| | Slab - by quantity / weight / value | `slab1`/`slab2`, `slabw1`/`slabw2`, `slabv1` |
| | Freebie | `freebie1`: free I7 with 10 × I6 |
| | Buy X get Y | `buy2get1` on Frooti |
| | Combo | `combo1`: Atta + both B Natural packs |
| | Stacking | Select applies slab2; the buyer chooses freebie1 + discp10 at init |
| Retailer (P2P) | customer_id / phone + PAN / new retailer | Optional P2P answers |
| Post-order | Status and delivery | `/status`, then seller pushes Packed → Out-for-delivery → Order-delivered |
| | Buyer cancels | `/cancel` (reason 053) → `on_cancel` |
| | Seller cancels | Unsolicited `on_cancel`, reason 005 |

## Known simplifications

- It does not check MOQ, max quantity, TAT changes or customer validity on `/select`.
- It does not remember the finder fee from `/search`. `CUST-NEW-*` ids are accepted anywhere.
- It does not verify signatures on incoming requests.
- Structural errors NACK: bad JSON, wrong `domain`/`action`, missing context fields, unknown
  provider (`30001`) or item (`30004`), `customer` + `retailer_mapping` together (`30000`),
  unknown order (`30018`), cancelling a cancelled/completed order (`50001`).
