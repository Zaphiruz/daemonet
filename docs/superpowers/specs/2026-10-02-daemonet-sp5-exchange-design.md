# Daemonet — SP5: Exchange (design)

**Status:** approved for planning · **Date:** 2026-10-02
**Parents:** `2026-09-27-daemonet-design.md` §9 (locks), §10 (Exchange, Economy), `2026-09-30-daemonet-sp3b-economy-subnets-design.md` (ledger, fragments), `2026-09-30-daemonet-sp4-social-design.md` (bus).

## 1. Goal

Bits circulate between players. SP5 adds the Exchange: an order book for
fungible items (tools, restores, fragments, evolution and held items, Bit
Flippers), fixed-price listings for daemon images with their capture log,
direct two-sided trades, and a REST API so trading bots can do all of it
headlessly. The 1/16 sales fee is the economy's main recurring sink.

## 2. Scope

**In:** the Exchange vault (items held for trading), `deposit` / `withdraw`
at a host, daemon locks, bearer-token auth for bots on the api, the order
book with matching / fees / expiry, daemon listings, direct trades, fill
notifications to online operators, an `ExchangeClient` in the SDK, the
client's Exchange tab, admin market view (volume, fees destroyed).

**Out:** auctions / bidding, org banks, price charts beyond a last-trades
list, cross-server markets, lending, breeding.

## 3. Decisions fixed here

| Question | Decision |
|---|---|
| Limits | **16 open item orders and 16 active daemon listings per operator; both expire after 7 days** (escrow returns, daemon unlocks). Any daemon may be listed, clean and signature included. |
| Fee | **1/16 of the bits a seller receives** (`floor(total / 16)`, taken from the proceeds, destroyed; ledger reason `exchange:fee`). Direct trades pay the same fee on the bits they move, so they are not a way around it. |
| Bot auth | **Authentik bearer token.** `Authorization: Bearer <access token>` from the `daemonet-bot` device-flow client is accepted on `/api/exchange/*` (and `/api/me`); verified against the issuer's JWKS exactly as the sim does; no CSRF header needed for bearer requests; 120 requests / minute per operator. |
| Where traded goods live | Live inventory belongs to the sim (in memory while online), so the api never touches it. Items are traded from an **Exchange vault** (`ExchangeVault` rows, api-owned). `deposit { item, qty }` / `withdraw { item, qty }` are sim commands at a host (durable intents that move items between inventory and vault). Daemons are listed **from Disk** (database-only state) and locked while listed or offered. Bits are spent by guarded decrements with ledger rows, as everywhere since SP3b; the bus `bits` push keeps online operators' balances current. |
| Direct trades and hosts | The design's "confirmed by both operators at a host" is satisfied by the deposit step: everything a trade can move (vault items, Disk daemons, bits) is database state, so the confirmation itself is a REST call from anywhere. |
| Traded daemons | Ownership moves (`Daemon.operatorId`), `originalOperatorId` does not — `originalOperator` evolution requirements fail for traded daemons, as designed. A `traded` history entry is appended. The buyer needs a free Disk slot. |

## 4. Vault, locks, bearer auth (plan 1)

- `ExchangeVault { operatorId, item, qty }` (`@@id([operatorId, item])`).
- Sim commands at a host: `deposit { item, qty }`, `withdraw { item, qty }`
  (1–1024). Tools, restores, fragments, held / evolution items and Bit
  Flippers are depositable; a held item must be unheld first. Optimistic
  inventory change + intent (`vault` intent: inventory and vault row in one
  transaction; `withdraw` fails with `not enough in the vault`).
- `Daemon.lockedBy String?` (`listing:<id>` or `trade:<id>`). The sim's
  `load` intent refuses a locked daemon (`E_STATE 'locked on the Exchange'`);
  `/api/disk` shows the lock; decompile is impossible anyway (RAM only).
- API auth: `requireAuth` accepts a session cookie **or** a bearer token
  (`createBearerVerifier` — issuer, audience `daemonet-bot`, required group;
  dev tokens `dev:<name>` under the dev bypass). Bearer requests skip the
  CSRF header check. `GET /api/exchange/vault`.

## 5. Order book (plan 2)

- `Order { id, operatorId, item, side: BUY | SELL, price, qty, remaining,
  status: OPEN | FILLED | CANCELLED | EXPIRED, createdAt, expiresAt }`;
  `Fill { id, item, price, qty, buyOrderId, sellOrderId, buyerId, sellerId,
  fee, at }`.
- Placing a SELL escrows `qty` from the vault; placing a BUY escrows
  `price × qty` bits (ledger `exchange:escrow`). Price 1 – 1,048,576 bits,
  qty 1 – 1024.
- Matching happens in the placing transaction (serialisable per item via
  `pg_advisory_xact_lock(hash(item))`): best price first, then oldest; the
  trade executes at the **resting** order's price; a BUY that fills below its
  limit gets the difference back. Each fill: items to the buyer's vault,
  `price × qty − fee` bits to the seller (ledger `exchange:sale`), fee
  destroyed (`exchange:fee`), `Fill` row, bus `exchange { kind: 'fill', … }`
  to both sides and `admin bits` pushes.
- Cancel returns the unfilled escrow. An api timer expires orders past
  `expiresAt` every 5 minutes.
- REST: `GET /api/exchange/book/:item` (top 16 levels each side + last 16
  fills), `GET /api/exchange/orders` (mine), `POST /api/exchange/orders`,
  `DELETE /api/exchange/orders/:id`, `GET /api/exchange/items` (tradable ids
  with best bid / ask).

## 6. Daemon listings (plan 3)

- `Listing { id, sellerId, daemonId @unique, price, status: ACTIVE | SOLD |
  CANCELLED | EXPIRED, createdAt, expiresAt, buyerId?, soldAt? }` with a
  denormalised snapshot for browsing (`species, level, clean, signature,
  ivSum, nature, traitSlot`).
- `POST /api/exchange/listings { daemonId, price }` (daemon on the seller's
  Disk, not locked) locks it; `DELETE` unlocks; `POST …/:id/buy`: bits ≥
  price, a free Disk slot (lowest), one transaction — bits (fee as §3),
  ownership, slot, `traded` history, listing SOLD, lock cleared. Browse:
  `GET /api/exchange/listings?species=&line=&type=&clean=&minSignature=&maxPrice=&sort=price|new&cursor=`
  returning the daemon view with capture log and history.
- Expiry as for orders.

## 7. Direct trades (plan 4)

- `Trade { id, aId, bId, status: OPEN | DONE | CANCELLED, aOffer Json,
  bOffer Json, aConfirmed, bConfirmed, createdAt, updatedAt }` with offers
  `{ bits, items: { item: qty }, daemonIds: [] }`.
- `POST /api/exchange/trades { withId }`, `PUT …/:id/offer` (sets my offer;
  validated against vault / Disk / balance; locks offered daemons; **any
  offer change clears both confirmations**), `POST …/:id/confirm`,
  `POST …/:id/cancel`. When both have confirmed, the swap executes in one
  transaction (re-validating everything; Disk slots for incoming daemons;
  fee on each side's bits). Open trades are cancelled after 1 hour idle. At
  most 4 open trades per operator.
- Bus `exchange { kind: 'trade', … }` events so both clients update live.

## 8. Sim, SDK, client

- The sim forwards bus `exchange` messages to the affected online operators
  as the event `exchange { kind, … }`.
- SDK: `ExchangeClient({ baseUrl, auth })` (fetch-based, works in Node and in
  the sandbox through the bridge's allowed origin): `vault()`, `book(item)`,
  `placeOrder`, `cancelOrder`, `orders()`, `listings(query)`, `list`,
  `unlist`, `buy`, trades. `client.operator.deposit / withdraw`.
- Client **Exchange** tab: vault (deposit / withdraw at a host), order book
  per item with a place-order form, my orders, daemon listings browser with
  filters and a buy button, my listings (list from the Disk tab), trades.

## 9. Persistence summary

New tables `ExchangeVault`, `Order`, `Fill`, `Listing`, `Trade`;
`Daemon.lockedBy`. Ledger reasons `exchange:escrow`, `exchange:refund`,
`exchange:sale`, `exchange:buy`, `exchange:fee`. Sim intent `vault`.

## 10. Testing

- sim: deposit / withdraw guards and store contract; locked daemons cannot
  be loaded; exchange events forwarded.
- api: bearer auth (valid, wrong audience, missing group, dev token);
  matching (price-time priority, partial fills, maker price, refund of the
  difference, fee rounding, self-trade prevention, per-operator caps,
  expiry); listings (lock, buy, full Disk, expiry, concurrent buyers — one
  wins); trades (offer change clears confirmations, atomic swap, re-check at
  execution, fee, cancel on idle); ledger sums equal balance changes in every
  scenario (property test over random order sequences: bits and items are
  conserved except for fees).
- client: order form and book rendering unit tests; e2e: two operators —
  one deposits fragments and sells, the other buys; a daemon is listed and
  bought.

## 11. Plans

1. **SP5 plan 1 — Vault, locks and bearer auth.**
2. **SP5 plan 2 — Order book.**
3. **SP5 plan 3 — Daemon listings.**
4. **SP5 plan 4 — Direct trades, SDK client, Exchange tab polish, admin market view.**
