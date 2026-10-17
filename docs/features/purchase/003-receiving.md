# 003 — Partial receiving and supplier bills

## Goal
Receive goods the way they really arrive:
- a supplier delivers **part of an order**; the rest stays open on the PO and comes later
- one PO line can arrive in **several lots**
- the supplier's bill can have a **different price** than the PO; staff enter the **actual price** while receiving, and stock cost and what we owe use it
- if the supplier won't send the rest, staff **close the remainder**

Each delivery from a supplier becomes a **goods receipt** (`GRN-0001`). **The goods receipt is the supplier bill**: it's what we owe, with a due date from the supplier's payment terms.

Today `receivePurchase` receives every line at once, and the PO itself is the bill (`po.paid`).

## Data model
```ts
export interface PurchaseLine extends Line {
  id: string;           // uid('pol')
  closedQty: number;    // in the line's unit; set by closeRemaining
}
// Purchase — changes
lines: PurchaseLine[];
received?: string;      // existing: now the date the PO became fully received / closed
closeReason?: string;
// Purchase.paid is REMOVED (money moves to receipts)

export interface ReceiptLine extends Line {   // qty in the line's unit; price = actual billed cost per that unit
  purchaseLineId?: string;  // absent on direct receipts
  orderedPrice?: number;    // the PO line price at the time of receipt
  batchId: string;          // the lot this line went into ('' only on legacy lines)
  lotCode: string;
  expiry: string;
}
export interface Receipt {          // the goods receipt AND the supplier bill
  id: string;                       // uid('receipt')
  number: string;                   // GRN-0001 from counters.receipt (no longer optional)
  date: string;                     // the day the goods arrived
  supplierId: string;
  warehouseId: string;
  purchaseId?: string;              // absent on direct receipts
  reference: string;                // the supplier's invoice / delivery note number ('' if none)
  lines: ReceiptLine[];
  total: number;                    // Σ qty × price — the bill amount
  paid: number;                     // cached; 005 makes it Σ payment allocations
  credited: number;                 // cached; 004 makes it Σ supplier-return allocations
  due: string;                      // date + supplier.paymentTermsDays, fixed at receipt time
  notes: string;
  legacy?: true;
  createdAt: string;
  createdBy: string;
}
// Receipt.received is REMOVED (it's always `date`)
Workspace.counters.receipt: number;
Workspace.version: 4;
```
`PurchaseInput.lines` becomes `(LineInput & { id?: string })[]`, like `OrderInput`, so edits keep line ids.

### Quantities
```ts
receivedQty(s, po, lineId) = Σ qty of receipt lines with that purchaseLineId
openQty(s, po, line)       = line.qty − receivedQty − line.closedQty      // ≥ 0
purchaseStatus(s, po)      = po.status === 'Sent' && some line has receivedQty > 0 ? 'Partly received' : po.status
billBalance(r)             = round(r.total − r.paid − r.credited)
```
`purchaseStatus` is a **display status**. Stored statuses stay `Draft | Sent | Received | Canceled`.

## Operations

### `receivePurchase(s, id, input): Receipt` (rewrite)
```ts
input: {
  date?: string;                      // default today
  reference?: string;                 // supplier invoice / delivery note no.
  notes?: string;
  lines: { purchaseLineId: string; qty: NumericInput; price?: NumericInput; code: string; expiry: string }[];
  closeRemaining?: { reason: string };
}
```
- The PO is `Sent`, error `Only sent purchase orders can be received.` (002's Draft message still applies to Drafts.)
- `po.date ≤ date ≤ today()`, the existing message `Receipt date must be between the order date and today.`
- At least one line, error `Enter the quantity received for at least one line.`
- Each input line:
  - `purchaseLineId` is a line of this PO, error `Unknown purchase order line.`
  - `qty` passes `qtyCheck` (a positive whole number, in the PO line's unit)
  - `price` defaults to the PO line `price`; it passes `moneyCheck(…, 'Unit cost')`
  - lot code and expiry: the same checks as today (non-empty code, future expiry; an existing lot must have the same expiry and cost; duplicates within this receipt must match). Keep today's messages.
- Several input lines may share a `purchaseLineId` (one PO line arriving in several lots). Per PO line, Σ qty ≤ `openQty`, error `<product name>: only <open> <unit> still open on this order. Raise the PO quantity first.`
- **Validate everything before changing anything** (as today).
- Create the `Receipt`: number from `counters.receipt`, `orderedPrice` = PO line price, `total = Σ qty × price`, `paid 0`, `credited 0`, `due = shift(supplier.paymentTermsDays, date)`.
- For each line, `addBatch` with base qty `qty × factor`, cost `round(price / factor)`, the lot code and expiry, `received = date`, and move meta `{ date, reference: receipt.number, sourceId: receipt.id, counterpartyId: supplierId }`. Store the resulting `batchId`, `lotCode`, `expiry` on the line.
- **Journal entry:** `purchaseEntries(inventoryDebit, receipt.total, 'payable')`, where `inventoryDebit = Σ round(qty × factor × batch cost)`. Reference `receipt.number`. Description `Goods receipt — <supplier> · <PO number>`, plus ` · Purchase rounding` when they differ (as today).
- If every line now has `openQty = 0`, set the PO to `Received` with `received = date`.
- If `closeRemaining` is given, call `closeRemaining(s, po.id, reason)` after posting.
- Activity `Goods received`, `<GRN> · <PO> · <warehouse>`.

### `closeRemaining(s, id, reason)`
- The PO is `Sent`, error `Only sent purchase orders can be closed.`
- At least one receipt for it, error `Nothing was received yet. Cancel the order instead.`
- Reason required, error `Enter a reason for closing the rest of the order.`
- For every line, `closedQty += openQty`. Status `Received`, `received` = the latest receipt date, `closeReason = reason`. Activity `Purchase order closed short`.

### `cancelPurchase` (fill the 002 marker)
Refuse when the PO has any receipt, error `Part of this order was already received. Close the remainder instead.`

### `savePurchase` (fill the 002 marker)
For a `Sent` PO that has receipts:
- a line with receipts can't be removed, error `<product name> was already received and can't be removed.`
- its product and unit can't change, error `<product name> was already received; its product and unit can't change.`
- its qty can't go below `receivedQty + closedQty`, error `<product name>: quantity can't go below the <n> already received.`
- the warehouse can't change, error `The warehouse can't change after goods were received.`

Lines keep their `id` when the input passes it; new lines get a new id and `closedQty 0`. If after an edit every line has `openQty = 0`, set the PO to `Received` with `received` = the latest receipt date.

### `receiveStock` (direct receipt, change)
- It now creates a full `Receipt` with a `GRN-` number and one line (no `purchaseId`, no `orderedPrice`). `reference = data.reference || ''` (no longer the batch code).
- The move reference and journal reference become the GRN number, and the move gets `sourceId = receipt.id`.
- `due = date` when paid in cash, otherwise `shift(supplier.paymentTermsDays, date)`.
- The cash / credit choice and its journal entry stay as they are (005 changes the cash path).

### Bills
- **Supplier bills are `s.receipts` only.** Replace every `[...s.purchases.filter((p) => p.status === 'Received'), ...s.receipts]` (Purchasing page metric, contact balances, the Accounting page bill list, `payBill`, `validateBackup`) with `s.receipts`.
- `payBill(s, receiptId, amount, date)` works on receipts. The amount must be ≤ `billBalance`. The date must be between `receipt.date` and today. Journal reference `receipt.number`. Messages unchanged.
- `openBills(s, supplierId?)`: receipts with `billBalance > 0`, oldest `due` first (tie: number).
- `billStatus(r)`: `Paid` when the balance is 0; `Overdue` when `due < today`; `Partly paid` when `paid + credited > 0`; else `Open`.

### `lastPurchasePrice` (fill the 001 marker)
Read from **receipt lines** instead of PO lines: newest receipt `date` first (tie: higher number), same supplier, product and unit. `reference` is the GRN number. The price is the **actual billed** price.

### `onOrder`
Count `openQty × factor` of Draft and Sent PO lines, not the full line qty.

## Migration (v3 → v4)
Run it only when the backup's version is below 4.
1. Every PO line gets `id = uid('pol')` and `closedQty = 0`.
2. Collect the old bills, **oldest date first**, and number them `GRN-0001…` from `counters.receipt`:
   - **Each `Received` PO** becomes a legacy `Receipt`:
     - `date = po.received ?? po.date`, `purchaseId = po.id`, `reference = po.reference ?? ''`
     - `lines`: one per PO line, with `purchaseLineId`, `orderedPrice = price`, same qty / unit / factor / price. Take `batchId` / `lotCode` / `expiry` from the PO's `receipt` stock moves (`sourceId === po.id`), matched in line order. When the number of moves doesn't match the number of lines (v1 data), use `''` for all three.
     - `total = po.total`, `paid = po.paid`, `credited = 0`, `due = shift(supplier.paymentTermsDays, date)`, `notes = ''`, `legacy: true`
   - **Each old direct `Receipt`** keeps its id, total and paid. Give it a number if it has none, `lines = []`, `credited = 0`, `due = shift(terms, date)`, `notes = ''`, `legacy: true`, and remove `received`.
3. Delete `po.paid` from every PO.
4. `counters.receipt` = the next free number. `version = 4`.
- The old journal entries stay as they are. **Add no journal entries.**
- **Write this test before the migration:** take the seed, turn it back into the v3 shape (put `paid` back on received POs from their receipts, drop the receipts that came from POs, strip the new receipt fields), migrate it, and prove that the payable balance, every supplier's open-bill total, `inventoryValue`, every batch qty and the journal are unchanged.

## Backup validation
- Receipts:
  - unique `GRN-` numbers; supplier is a Supplier; the warehouse exists
  - `purchaseId`, when present, is a PO of the same supplier and warehouse
  - lines valid (product, unit, factor, `qtyCheck`, `moneyCheck` price); `total = Σ qty × price`
  - `paid ≥ 0`, `credited ≥ 0`, `paid + credited ≤ total`, `due ≥ date`
  - non-legacy: at least one line, every `batchId` is a batch of the same product and warehouse
  - legacy: `lines` may be empty and `batchId` may be `''`
- PO lines have unique ids and an integer `closedQty ≥ 0`. POs have no `paid` field.
- `Received` ⇔ every line has `openQty = 0`. A `Sent` PO has at least one line with `openQty > 0`.
- **P1** and **P4** (README). **Payable:** `b.payable.balance === Σ billBalance(receipts)` (004 subtracts supplier credit).

## UI
1. **Receive dialog** (rewrite `PurchaseReceiveForm`):
   - Fields: *Receipt date*, *Supplier invoice / delivery note no.*, *Notes*.
   - One row per open PO line: product, ordered, already received, still open, **Receive now** (defaults to the open qty; 0 skips the line), **Actual cost** (defaults to the PO price), lot no., expiry.
   - When the actual cost differs from the PO price, show it next to the cost: *"+$0.40 vs PO"* (or *"−$0.25 vs PO"*).
   - **Split lot** on a row adds another lot row for the same PO line.
   - When something stays open: a checkbox *"Close the rest of this order"* with a required reason.
   - Footer summary: *"Bill total $1,240.00 · ordered value of these items $1,200.00 · difference +$40.00"*. Button **Receive**.
2. **PO detail:**
   - Lines with *Ordered / Received / Closed / Open* columns, and the display status (*Partly received*).
   - A *Receipts* list (GRN number, date, supplier reference, total), each opening the receipt detail.
   - *"Billed $1,240.00 vs ordered $1,200.00"* when they differ.
   - The close reason, when closed short.
   - Actions: **Receive** and **Close remainder** (asks for a reason) while Sent; **Cancel order** only while nothing is received.
3. **Receipt / bill detail** (new dialog `receipt-detail`):
   - GRN number, supplier, PO link, supplier reference, date, due date, `billStatus` badge
   - lines: product, lot, expiry, qty, cost, PO cost, difference
   - total, paid, credited, balance
   - actions **Pay supplier** (the existing `bill-payment` dialog, now by receipt id) and **Print GRN**
4. **Purchasing page:** a new tab **Receipts & bills**: GRN, date, supplier, PO, reference, total, balance, due, status. Filter by status, search by GRN / supplier / reference. The *Supplier bills due* metric reads `s.receipts`.
5. **Direct "Receive stock" form:** add the *Supplier invoice / delivery note no.* field.
6. Badge colours: `Partly received`, `Partly paid`.
7. CSV export for receipts (follow the `purchases` export pattern).

## Sample data
Build through the operations:
- One PO **partly received**: half of one line now, the other line not yet. It stays Sent.
- One PO received with a **higher actual price** on one line than ordered (the supplier raised the price).
- One PO **closed short**, reason "Supplier out of stock until next quarter".
- One PO line received in **two lots** with different expiry dates.
- The historical seed POs are received through the new `receivePurchase` (one receipt each), and paid through `payBill` as before.

## Tests
- Partial receipt:
  - creates a GRN for the received lines only
  - the PO stays Sent and shows *Partly received*
  - `openQty` drops; a second receipt finishes it and sets `Received`
- Over-receipt throws the spec's message. Two lot rows on one line together over the open qty also throw.
- Actual price:
  - batch cost = actual price ÷ factor
  - the bill total uses the actual price; `orderedPrice` keeps the PO price
  - the journal posts `payable` at the actual total
- One PO line into two lots creates two batches and two receipt lines.
- `closeRemaining`:
  - sets `closedQty` and `Received`
  - is refused with no receipts and without a reason
  - `receivePurchase` with `closeRemaining` does both in one call
- `cancelPurchase` is refused after a receipt.
- `savePurchase` after a receipt refuses removing a received line, changing its product or unit, going below the received qty, and changing the warehouse.
- `receiveStock` creates a one-line GRN; the cash path has `due = date`.
- `payBill` works on receipts and refuses more than `billBalance`.
- `lastPurchasePrice` returns the latest **actual** receipt price.
- `onOrder` counts only open quantities.
- **Migration:** the round-trip test described above. Invariants (including P1, P4) hold afterwards.
- **Browser test:** receive part of a PO with a changed price and two lots, see *Partly received* and the GRN with the price difference, then receive the rest and see *Received*.

## Acceptance criteria
- [ ] A PO can be received in several deliveries; what's left stays open.
- [ ] One PO line can be received into several lots.
- [ ] The actual billed price is entered at receiving and used for stock cost and the bill.
- [ ] The remainder of a PO can be closed with a reason.
- [ ] Receiving more than ordered is refused.
- [ ] Every goods receipt is a supplier bill with a due date; old POs and receipts migrate with balances unchanged.
