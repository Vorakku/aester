# 004 — Picking and delivery

## Goal
Get goods from the shelf to the customer, and make **delivery the only way stock leaves for a sale**:
- **pick** the right lots
- **dispatch** them (stock leaves, cost of goods is posted)
- record that they were **delivered**, or that they came back

Pickup at the counter is a delivery completed on the spot.

This spec also **restructures the existing direct "Issue invoice"** so it creates a delivery behind the scenes (README, *Accounting*). It's the riskiest change in the Sales module, so read the *Restructure* section carefully.

## Data model
```ts
export interface Pick {
  batchId: string;
  warehouseId: string;
  lotCode: string;
  expiry: string;
  qty: number;      // base units
  cost: number;     // batch.cost when dispatched (set on dispatch)
}
export interface DeliveryLine {
  id: string;             // uid('dl')
  orderLineId?: string;   // set when delivering a sales order
  productId: string;
  name: string; sku: string;
  unit: Unit; factor: number;
  qty: number;            // line units delivered
  price: number;          // per line unit; from the order line or the direct invoice line (005 bills this)
  picks: Pick[];          // Σ pick.qty === qty × factor
}
export interface Delivery {
  id: string;             // uid('dn')
  number: string;         // DN-0001 from counters.delivery
  customerId: string;
  orderId?: string;
  method: 'delivery' | 'pickup';
  status: 'Picking' | 'Dispatched' | 'Delivered' | 'Returned' | 'Cancelled';
  warehouseId?: string;   // restrict picking to one warehouse; undefined = any (direct sales)
  address: string;
  lines: DeliveryLine[];
  cost: number;           // Σ pick.qty × pick.cost; 0 until dispatched
  date?: string;          // business date of dispatch
  driver: string;         // '' for pickups
  receivedBy: string;     // set when Delivered
  returnReason: string;   // set when Returned
  invoiceId?: string;     // set by invoicing (this spec for direct sales, 005 otherwise)
  legacy?: true;          // created by migration from pre-v3 invoices
  createdAt: string; createdBy: string;
  dispatchedAt?: string; dispatchedBy?: string; deliveredAt?: string;
}
Workspace.deliveries: Delivery[];   // newest first
Workspace.counters.delivery: number;
Invoice.deliveryIds: string[];      // added here for direct sales; 005 uses it for all invoices
MoveType: add 'return';             // stock coming back from a customer (inventory 001 type list)
```
**Removed from `Invoice`:** `allocations` and `cogs`. They move to the invoice's deliveries (see *Migration*). Replace every reader with the helpers below.
```ts
deliveriesOf(s, invoice): Delivery[]
invoiceCost(s, invoice): number           // Σ delivery.cost — replaces invoice.cogs (analytics, dashboard)
invoicePicks(s, invoice): Pick[]          // replaces invoice.allocations (invoice detail, recall trace)
```

## Status flow
```
Picking ──dispatch──► Dispatched ──confirm──► Delivered
   │                       └──not delivered──► Returned
   └──cancel──► Cancelled
Pickup:  Picking ──hand over──► Delivered (dispatch + confirm in one step)
```
Stock moves **only on dispatch** (out) and on **not delivered** (back in). `Picking` is a plan: nothing moves yet.

## Operations

### `createDelivery(s, { orderId, warehouseId, method?, lines? }): Delivery`
- The order must be `Confirmed`. The warehouse must exist.
- `method` defaults to `order.fulfilment`. `address` defaults to `order.deliveryAddress`.
- `lines?: { orderLineId, qty }[]` (line units). When omitted, every open line is included with:

  `qty = min(pendingOpen, floor(pickable ÷ factor))`

  - `pendingOpen` = `openQty` (003) − qty already on this order's `Picking` deliveries, so the same goods can't be planned twice.
  - `pickable` = what the customer can receive **from this warehouse**: eligible batches (inventory 006 rules, using `order.allowShortDated`, skipping warehouses being counted), capped by `free(s, productId, { customerId, allowShortDated, exceptSourceId: order.id })`.
  - Lines with qty 0 are skipped. When nothing is left: `Nothing can be picked from <warehouse> for this order.`
- Each explicit line qty must be > 0 and ≤ `pendingOpen` and ≤ `pickable ÷ factor`.
- **Proposes picks** earliest expiry first from the eligible batches in that warehouse.
- Status `Picking`. No stock moves and no journal entry.

### `setPicks(s, deliveryId, lineId, picks: { batchId, qty }[]): void`
- `Picking` only. Lets staff choose a different lot, for example the one physically at the front.
- Every batch must be eligible for this customer (same rules as above) and in `delivery.warehouseId` when set.
- Σ qty must equal `line.qty × factor`, and each pick's qty must be ≤ the batch qty.

### `cancelDelivery(s, id)`
`Picking` only. Status `Cancelled`, nothing else changes.

### `dispatchDelivery(s, id, { date?, driver?, receivedBy? }): Delivery`
- `Picking` only. `date` defaults to today and must be ≤ today.
- For `method: 'pickup'`, `receivedBy` is required and the status goes straight to `Delivered`. Otherwise the status is `Dispatched` and `driver` is stored.
- **Re-check every pick:** still eligible, still enough qty, not under recall. A change since picking throws `Lot <code> changed since picking. Update the picks.`
- For each pick:
  - `moveStock(batch, −qty, { type: 'sale', date, reference: number, sourceId: delivery.id, counterpartyId: customerId })`
  - set `pick.cost = batch.cost`
- `delivery.cost = Σ pick.qty × pick.cost`.
- Journal entry, reference `number`, description `Delivery — <customer>`: `cogs` debit, `inventory` credit, both `delivery.cost`.
- When linked to an order: `reserveOrder` (003), then `closeIfDone`.
- `activity(...)`.

### `confirmDelivered(s, id, { receivedBy, date? })`
`Dispatched` → `Delivered`. `receivedBy` is required. No stock or journal change.

### `markNotDelivered(s, id, reason)`
- `Dispatched` only, and not invoiced. Otherwise: `This delivery is invoiced. Issue a credit note instead.`
- Every pick goes back through `returnToStock` (below) **into quarantine**, with `reference: number`.
- Journal entry: `inventory` debit, `cogs` credit, `delivery.cost`.
- Status `Returned`, `returnReason`.
- Order lines become open again (the delivered qty only counts `Dispatched` and `Delivered`), then `reserveOrder`.

### `returnToStock(s, { batchId, qty, quarantine, reference, sourceId, counterpartyId, date })`
Shared helper; 006 reuses it.
- Puts stock back into **the same lot**: same product, lot code, expiry, cost and warehouse.
- With `quarantine: true`, it uses a **quarantined twin batch**. It finds a batch with the same product, code, expiry, cost and warehouse and `quarantined: true`, or creates one with `qty: 0` and `received` = the original's.
- Then `moveStock(+qty, { type: 'return', … })`.
- This keeps returned goods separate from the clean stock of the same lot, which keeps selling. Release them with the existing *Release batch* action, or write them off with an adjustment.

## Restructure: direct "Issue invoice"
`issueInvoice` (draft invoice issued directly, i.e. a counter sale) keeps its checks: credit (001), free stock, shelf life, reservations. Then, in the **same transaction**:
1. Create a `Delivery` with:
   - `method: 'pickup'`, no order, no `warehouseId`
   - lines = the invoice lines (unit, factor, qty, price)
   - picks = earliest expiry first across all warehouses, exactly as today's allocation
2. Dispatch it as a pickup: date = invoice date, `receivedBy` = customer name. That posts the stock moves and the cost of goods.
3. Post the invoice entry: `receivable` debit; `revenue` and `tax` credit. No cost of goods here any more.
4. Link them: `invoice.deliveryIds = [delivery.id]`, `delivery.invoiceId = invoice.id`.
5. Mark the invoice's reservations `Fulfilled`, as today.

There's now **one** code path that removes stock for a sale (`dispatchDelivery`). Delete the old allocation loop.

**Other code to update:**
- **`recallTrace`** (inventory 006): the `sale` moves now reference the DN number. Show both DN and invoice in the *Sold to* table (via `delivery.invoiceId`).
- **Analytics and dashboard:** gross margin uses `invoiceCost`.

## Migration (version 2 → 3)
For every **issued** invoice that has no `deliveryIds`:
- Create a `Delivery` with:
  - `legacy: true`, `status: 'Delivered'`, `method: 'pickup'`
  - `number` from `counters.delivery`
  - `date` = invoice date, `receivedBy` = customer name
  - lines = the invoice lines
  - picks = `invoice.allocations` (assigned to lines by product, in order)
  - `cost` = `invoice.cogs`
  - `invoiceId` = the invoice
- Set `invoice.deliveryIds`, then delete `allocations` and `cogs`.

Draft invoices get `deliveryIds: []`.

The existing stock moves and journal entries stay as they are: they reference the invoice, and the legacy flag tells validation so. Then set `deliveries: []` if missing, `counters.delivery`, and `version = 3`.

## Backup validation
- Statuses, fields and links are consistent:
  - `Delivered` has `receivedBy`; `Returned` has `returnReason`
  - `invoiceId` and `deliveryIds` point at each other
  - a delivery is on at most one invoice
- For every line, Σ pick qty = `qty × factor`.
- **S1** for non-legacy dispatched, delivered and returned deliveries: one `sale` move per pick with the same batch and −qty. Returned deliveries also have matching `return` moves.
- For issued invoices: per product, Σ invoice line base qty = Σ the deliveries' line base qty.
- Replace the old allocation and cogs checks.

## UI
1. **New page "Deliveries"** (`deliveries`, SALES section).
   - Tabs:
     - **To pick** (`Picking`)
     - **Out for delivery** (`Dispatched`)
     - **Delivered**
     - **Returned / cancelled**
   - Columns: DN, customer, order, warehouse, method, lines, date, status, invoiced (✓ / —).
2. **Order drawer → Create delivery:**
   - Choose the warehouse (default `wh_main`) and Delivery or Pickup.
   - Pre-filled quantities per line, each showing *open* and *pickable here*.
3. **Delivery drawer:**
   - Header and lines, each with its **picks**: lot, expiry, warehouse, qty.
   - **Change lot** opens a dialog for `setPicks`, listing eligible lots earliest expiry first.
   - Actions by status:

     | Status | Actions |
     |---|---|
     | Picking | Print pick list, **Dispatch** (driver name) or **Hand over** (pickup, received by), Cancel |
     | Dispatched | **Confirm delivered** (received by), **Not delivered** (reason) |

   - Always: **Print delivery note**. It shows lots and expiry dates, but **no prices** (pharma practice), plus a signature line.
4. **Invoice detail:** replace *Allocated batches* with the linked delivery notes and their picks.
5. **Order drawer:** the delivered column now has numbers, and the deliveries are listed.

## Sample data
Using the seeded orders from 003:

| Delivery | Status | Notes |
|---|---|---|
| Greenlife order | `Delivered` | **Not invoiced yet**, for 005 |
| Amoxicillin backorder order | `Delivered` partly | The order shows *Partly delivered* |
| One order | `Picking` | To pick |
| One order | `Dispatched` | Today, with a driver name |
| One order | `Returned` | Reason "Customer closed, redeliver tomorrow". Stock is in a quarantined twin batch. |

All historical seed invoices become deliveries through the restructured `issueInvoice`.

## Tests
- `createDelivery`:
  - proposes earliest expiry first from the chosen warehouse only
  - respects the customer's shelf life and `free` (another customer's hold isn't picked)
  - skips warehouses being counted
  - can't plan the same open qty on two `Picking` deliveries
- `setPicks` rejects ineligible lots, the wrong warehouse, and wrong totals.
- `dispatchDelivery`:
  - posts one `sale` move per pick and the cost of goods
  - updates the order's delivered qty and reservations
  - closes the order when everything is done
  - fails cleanly when a lot changed since picking
- Pickup goes straight to `Delivered` and requires `receivedBy`.
- `markNotDelivered`:
  - stock returns into a **quarantined twin** of the same lot, with the same cost
  - cost of goods is reversed
  - order lines reopen
  - refused once invoiced
- **Restructured `issueInvoice`:**
  - creates exactly one pickup delivery
  - the receivable equals the invoice total
  - cost of goods is posted once
  - invariants I1–I5 and S1 hold
- Migration of a v2 seed: every issued invoice gets one legacy delivery with matching picks and cost. `allocations` and `cogs` are gone. `validateBackup` passes.
- **Browser test:** create a delivery from an order, change one lot, dispatch it, confirm delivered, and check the order shows *Delivered* and the stock ledger shows the DN.

## Acceptance criteria
- [ ] Orders are picked, dispatched and delivered, fully or in parts, with lots chosen earliest expiry first and editable before dispatch.
- [ ] Stock and cost of goods move at dispatch. Undelivered goods come back into quarantine.
- [ ] Counter sales still work in one click, through the same delivery path.
- [ ] Existing invoices migrate without changing any balance.
