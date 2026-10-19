# eB2B Mock Seller NP

A mock ONDC **eB2B (DigiDukaan)** Seller NP (BPP) for buyer-app developers. Point your buyer app's
`bpp_uri` at it and it answers with protocol-shaped callbacks: search, every pre-order outcome the
Qwipo pre-order-service handles, every offer type in the contract, and post-order status / cancel.

- Domain `ONDC:RETeB2B`, core version `1.2.5`, city `std:080`
- 3 providers, 20 items, variant groups, serviceability (radius, pincode, polygon), timings, `brand_images`, `retailer_info_required`, offers
- No tax and no delivery charge: those quote lines are sent at `0.00`

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000, bpp_uri = http://localhost:3000/ondc
npm test             # every scenario + 4 end-to-end journeys + signed async callback
```

The local server also exposes a throwaway inbox. Set `context.bap_uri` to
`http://localhost:3000/local-bap` and read the callbacks at `GET /local-bap/inbox`.

## Deploy to Vercel

```bash
npx vercel           # framework preset: Other, no build command
```

| Env var | Default | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | request host | Base for image URLs and `bpp_uri` |
| `BPP_ID` / `BPP_URI` | host / `<base>/ondc` | Sent in callback `context` |
| `SIGNING_PRIVATE_KEY`, `BPP_UNIQUE_KEY_ID` | unset | Sign callbacks (ed25519 + BLAKE2b-512). Unsigned if unset |
| `FINDER_FEE_TYPE` / `FINDER_FEE_AMOUNT` | `percent` / `3.54` | Used in `on_init` when `/init` doesn't carry it |
| `CREATION_DELAY_MS` | `5000` | Delay before the unsolicited "retailer created" `on_search` |
| `PUSH_DELAY_MS` | `3000` | Delay before the incremental push update |

## API

`POST /ondc/{search|select|init|confirm|status|cancel}`

- **Async (default, real ONDC behaviour):** returns `{"message":{"ack":{"status":"ACK"}}}` and then
  POSTs `on_<action>` to `context.bap_uri + "/on_<action>"`. Every `on_search` callback carries
  `X-ONDC-Search-Response: full | inc | p2p`.
- **Sync (for Postman, curl and CI):** add header `X-Mock-Sync: true` or `?sync=1`. The reply is
  `{ response, callbacks: [{ url, delay_ms, headers, body }] }` and nothing is POSTed.
- Every reply has an `X-Mock-Scenario` header that names the branch the mock took.

The playground at `/` runs each scenario and each journey. You can edit any request before sending it.

## Providers: one per catalogue-visibility rule

| Provider | `retailer_info_required` | Buyer app must… |
|---|---|---|
| **P1** ABC Distributors × ITC (distributor), L1 Jayanagar + L2 BTM, 8 items | `new` + `existing`(customer_id) + `existing`(phone + PAN) | show the catalogue to everyone and offer registration |
| **P2** XYZ Distributors × HUL (distributor), L3 Whitefield, 7 items | `existing` × 2 only | list the provider but withhold items until P2P resolves the retailer |
| **P3** Ganesh Wholesale × Parle Agro (wholesaler), L4 Peenya, 5 items | none | show the catalogue to everyone and order without P2P |

## Seeded retailers

| Retailer | customer_id | phone | PAN | Mapped to |
|---|---|---|---|---|
| Sharma Kirana Store | `CUST-2024-001234` | 9876543210 | AABCU9603R | P1 (credit 25000), P2 (credit 10000) |
| Lakshmi General Stores | `CUST-2024-003311` | 9845011122 | AAKPL1234C | P2 (credit 15000) |
| Fresh Mart | `CUST-2024-005678` | 9900112233 | AAFCF4321D | P1 (credit 20000) |
| Ravi Provision Store (new) | issued as `CUST-NEW-<last 6 of phone>` | 9811122233 | AAGPR7788M | registers with P1 |

A retailer is resolved when the request fully satisfies one `type=existing` variant (customer_id, or
phone_number + PAN). A new-retailer request whose phone + PAN already match a held retailer is
resolved directly, not re-created.

## Scenarios

Each scenario is a flow of steps; in the playground every step has ▶ (send the callback to your
`bap_uri`) and Preview, and states what it expects. `npm test` runs all of them. Order scenarios
start at `/select` with the retailer already identified (seeded customer_id); the catalogue they
need is fetched as a preview and never sent to the buyer app.

| Group | Scenario | What the seller does |
|---|---|---|
| Pre-order | Search | Full catalogue `on_search` (header `full`) |
| | Place order (positive) | select (2 delivery options) → init (credit) → confirm, `Accepted` |
| | Place order - tomorrow delivery | Buyer picks F2 `Immediate Delivery` (P1D) instead of the beat (F1 `Standard Delivery`) |
| | Place order - registered-only distributor | Order from P2 for an identified retailer |
| | Place order - walk-in, prepaid | P3: no P2P, no customer_id, `ON-ORDER` with a payment link |
| | Item inactive | Incremental `on_search` disables I8; `on_select` returns it at qty 0 with **40002**; re-select |
| | Item out of stock | I13 at qty 0, **40002**; re-select |
| | Partial quantity | I7: 8 of 20, **40002**; re-select at 8 |
| | Price changed | I14 at 139.00 instead of the catalogue's 135.00 |
| | Minimum order value | Cart below P2's 2000.00 → **30023** with the quote; re-select with more |
| | Location not serviceable | PIN outside P2's range → `Non-serviceable`, **30009** |
| | Quantity reduced at init | `on_init` returns I15 at 2 (no error) → re-select → re-init |
| | Seller rejects confirm | `on_confirm` with **30019** |
| Offers | Discount - opt-in (percent) | `discp10` listed, applied only when chosen |
| | Discount - flat amount | `flat150` auto + additive |
| | Slab - by quantity / weight / value | `slab1`/`slab2`, `slabw1`/`slabw2`, `slabv1` |
| | Freebie | `freebie1`: free I7 with 10 × I6 |
| | Buy X get Y | `buy2get1` on Frooti |
| | Combo | `combo1`: Atta + both B Natural packs |
| | Stacking | Non-additive offers are exclusive; additive ones stack |
| Retailer (P2P) | Existing retailer - customer_id | `on_search` (p2p): credit, POC, customer, offers with `scheme_progress` |
| | Existing retailer - phone + PAN | P2 resolves the outlet code from its `type=existing` variant |
| | New retailer registration | Pending, then unsolicited created with the new customer_id |
| Post-order | Status and delivery | `/status` → `on_status`; seller pushes Packed → Out-for-delivery → Order-delivered |
| | Buyer cancels | `/cancel` (reason 053) → `on_cancel` |
| | Seller cancels | Unsolicited `on_cancel`, reason 005 |

Seller behaviour is driven by the seed data, so a real buyer app triggers the same outcomes by
ordering the same items: I7 has 8 in stock, I8 is disabled, I11 cannot be confirmed, I13 is out of
stock, I14 has a live price, I15 drops to 2 at init (see the header of `lib/data.js`).

Offers applied (the same rule pre-order-service uses to pre-select): the buyer's chosen offers
(`order.offers`) plus every auto + additive offer; with none chosen, the first auto non-additive
offer plus every auto + additive offer. `on_select` lists every eligible offer; only applied ones
count in `quote.price`, and only applied ones appear in `on_init` / `on_confirm`.

Seller pushes (not ONDC): `POST /api/mock/push { order_id, event }` with event
`packed | out_for_delivery | delivered | seller_cancel`. Same sync / play / async modes.

Post-order needs the confirmed order. On Vercel, add an Upstash Redis (KV) integration so
`KV_REST_API_URL` / `KV_REST_API_TOKEN` are set; without it orders live in one function
instance's memory and `/status` may answer **30018** (order not found).

## Known simplifications

- It does not check MOQ, max quantity, TAT changes or customer validity on `/select`.
- Pre-order is stateless: it does not remember the finder fee from `/search` or registered
  retailers. `CUST-NEW-*` ids are accepted anywhere. Only confirmed orders are stored.
- It does not verify signatures on incoming requests.
- Structural errors NACK: bad JSON, wrong `domain`/`action`, missing context fields, unknown
  provider (`30001`) or item (`30004`), `customer` + `retailer_mapping` together (`30000`),
  unknown order (`30018`), cancelling a cancelled/completed order (`50001`).
