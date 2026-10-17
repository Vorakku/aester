# 004 — Supplier returns

## Goal
Send stock back to the supplier when it's **damaged, expired, short-dated, recalled, the wrong item, or not ordered**, and get the money back:
- **Credit:** the supplier takes it off what we owe. It's applied to that lot's bill first, then to other open bills.
- **Refund:** the supplier pays us back. It waits as *refund expected* until the money arrives.

Staff pick credit or refund per return. Any lot with stock can be returned, including **quarantined twins** from customer returns (sales 004/006) and **recalled** lots (inventory 006). Today recalled stock can only be written off.

## Data model
```ts
export type SupplierReturnReason =
  'damaged' | 'expired' | 'short_dated' | 'recalled' | 'wrong_item' | 'not_ordered' | 'other';
export interface SupplierReturnLine extends Line {   // qty in the chosen unit; price = credit per that unit
  batchId: string;
  warehouseId: string;
  lotCode: string;
  expiry: string;
  unitCost: number;        // the batch cost per base unit at the time of the return
  receiptId?: string;      // the bill this lot came from, when it can be traced
}
export interface SupplierCreditAllocation {
  receiptId: string;
  amount: number;
  date: string;
}
export interface SupplierReturn {
  id: string;                         // uid('rts')
  number: string;                     // RTS-0001 from counters.supplierReturn
  supplierId: string;
  date: string;
  reason: SupplierReturnReason;
  note: string;
  reference: string;                  // the supplier's credit note number ('' if none yet)
  settlement: 'credit' | 'refund';
  lines: SupplierReturnLine[];
  total: number;                      // supplier credit value = Σ qty × price
  cost: number;                       // stock value removed = Σ round(qty × factor × unitCost)
  allocations: SupplierCreditAllocation[];
  refunded: number;                   // cached: Σ SupplierRefund.from for this return
  recallId?: string;
  createdAt: string;
  createdBy: string;
}
export interface SupplierRefund {
  id: string;                         // uid('srefund')
  date: string;
  supplierId: string;
  amount: number;
  method: 'Bank transfer' | 'Cash' | 'Card' | 'Cheque' | 'Other';
  reference: string;
  from: { returnId: string; amount: number }[];
  createdBy: string;
}
Workspace.supplierReturns: SupplierReturn[];
Workspace.supplierRefunds: SupplierRefund[];
Workspace.counters.supplierReturn: number;
MoveType gains 'supplier_return';
```

### Credit
```ts
returnCredit(r)               = round(r.total − Σ r.allocations.amount − r.refunded)    // ≥ 0
supplierCredit(s, supplierId) = Σ returnCredit over that supplier's returns
```

## Operations

### `returnToSupplier(s, input): SupplierReturn`
```ts
input: {
  supplierId: string; date?: string; reason: SupplierReturnReason; note?: string; reference?: string;
  settlement: 'credit' | 'refund'; recallId?: string;
  lines: { batchId: string; unit?: Unit; qty: NumericInput; price?: NumericInput }[];
}
```
- A Supplier contact, error `Select a supplier.`
- `date` defaults to today and can't be in the future, error `Return date cannot be in the future.`
- A valid reason. `other` needs a note, error `Enter a note for this return.`
- `recallId`, when given, is an Open recall; then the reason must be `recalled`.
- At least one line. For each line:
  - the batch exists; the unit is valid for its product (`unitFactor`); `qty` passes `qtyCheck`
  - Σ base qty per batch ≤ `batch.qty`, error `Not enough stock in lot <code> (<qty> available).`
  - **Right supplier:** look at the `receipt` stock moves of the same product and lot code (`sameLot`, any batch, so quarantined twins are found too). If any of them has a `counterpartyId`, the return's supplier must be one of those, error `Lot <code> was bought from <name>, not <supplier name>.` Lots without a supplier on record (opening stock) can go to any supplier.
  - `receiptId` = the `sourceId` of the newest of those moves from this supplier, when it's a receipt id.
  - `price` defaults to `batch.cost × factor` (what we paid). It passes `moneyCheck(…, 'Credit per unit')`.
- `total > 0`, error `The supplier credit must be greater than zero. Use a stock adjustment to write stock off.`
- **Validate everything before changing anything.**
- **Stock:** for each line, `moveStock(batch, −qty × factor, { type: 'supplier_return', date, reference: number, sourceId: id, counterpartyId: supplierId, reason })`. Recalled and quarantined lots are allowed. The count freeze still applies (`moveStock` already does that).
- **Journal entry:** `payable` debit `total`, `inventory` credit `cost`, and the difference to `loss` (debit when `cost > total`, credit when `total > cost`). Reference `number`. Description `Supplier return — <supplier> · <reason label>`.
- **Settlement `credit`:** apply the credit right away:
  1. to the lines' `receiptId` bills first (in line order), each up to its `billBalance`
  2. then to the supplier's other open bills, oldest due first

  Each application adds `{ receiptId, amount, date }` to `allocations` and `receipt.credited += amount`. Whatever is left stays as supplier credit (005 applies it to later bills).
- **Settlement `refund`:** no allocations. The whole total waits for `recordSupplierRefund`.
- Activity `Stock returned to supplier`, `<RTS> · <supplier> · <reason>`.

### `recordSupplierRefund(s, input): SupplierRefund`
```ts
input: { supplierId: string; amount: NumericInput; date?: string; method; reference?: string; returnId?: string }
```
- `amount > 0`. With `returnId`: `amount ≤ returnCredit(that return)`. Without it: `amount ≤ supplierCredit`, error `This supplier owes us only $<credit>.`
- `date` ≤ today and ≥ the date of every return it draws from.
- Take the money from the given return, or else from the supplier's returns with credit left: **`refund` returns first, then `credit` ones, oldest first**.
- Record a `SupplierRefund` with `from`. `return.refunded += amount` for each source.
- **Journal entry:** `cash` debit, `payable` credit. Reference: the return number(s). Description `Supplier refund — <method>`.

### Labels and guards
- Stock ledger and recall trace: `supplier_return` shows as *Returned to supplier* (outgoing).
- `recallTrace` lists supplier returns of the lot (they're stock moves, so check that the trace's move filter includes the new type).
- `contactInUse`: add `supplierReturns` and `supplierRefunds`. The product-in-use guards: add return lines. `emptyWorkspace`, the seed's initial object, `migrate`, `validateBackup` lists: add both collections and the counter.

## Migration
`supplierReturns: []`, `supplierRefunds: []`, `counters.supplierReturn = 1`. Nothing else.

## Backup validation
- Returns:
  - unique `RTS-` numbers; supplier is a Supplier; a valid reason and settlement; lines valid
  - every `batchId` exists with the same product; `total = Σ qty × price`; `cost = Σ round(qty × factor × unitCost)`
  - allocations point at receipts of the same supplier; `Σ allocations + refunded ≤ total`
- **P5** (README).
- For every receipt, `credited` = Σ allocations to it from all returns (the credited half of **P2**).
- Refunds: `from` sums to `amount`; for every return, `refunded` = Σ `from` amounts that point at it.
- **Payable:** `b.payable.balance === Σ billBalance(receipts) − Σ supplierCredit over all suppliers` (**P3**).
- `MoveType` accepts `supplier_return`. A `supplier_return` move has qty < 0.

## UI
1. **Return dialog** (`supplier-return-form`):
   - Supplier, date, reason, note, *Supplier credit note no.*
   - Settlement as two choices: **Credit** *"Take it off what we owe"* / **Refund** *"Supplier pays us back"*.
   - Lines: product → lot. The lot list shows every batch with stock, including quarantined and recalled ones, with warehouse, expiry and badges (*Quarantined*, *Recalled*, *Expired*). Then qty + unit, and *Credit per unit* (defaults to the cost).
   - Footer: *"Stock value $X · supplier credit $Y"*, plus *"· loss $Z"* when the credit is below the stock value.
   - Opened from: the **Returns** tab (*New supplier return*), **batch detail** (*Return to supplier*), **recall detail** (*Return to supplier*, prefilled with every batch of that lot that has stock, reason `recalled`, and `recallId`), and **receipt detail** (*Return items*, prefilled with that receipt's lots).
2. **Purchasing page → Returns tab:** RTS, date, supplier, reason, settlement, total, applied, refunded, credit left.
3. **Return detail:** lines, the bills it was applied to, refunds, **Record refund** (when it has credit left), and **Print return note** (RTS, supplier, lots, qty, expiry, reason, with *Released by* / *Received by* signature lines for the driver).
4. **Receipt detail:** the *Credited* amount links to the return numbers.
5. **Supplier detail:** *Supplier credit $X*, with **Record refund received**.
6. Badge colours for the reasons, `Credit` and `Refund`.

## Sample data
Through the operations:
- A **damaged** return from a received lot, settlement **credit**, applied to that lot's still-open bill.
- The seed **recall** lot (inventory 006) returned to its supplier, reason **recalled**, settlement **refund**, and the refund recorded a few days later by bank transfer.
- An **expired** quarantined lot returned for **less than its cost** (the supplier credits 50%), so the loss line shows.

## Tests
- A return removes the stock (`supplier_return` moves, P5) and posts `payable` / `inventory` / `loss` correctly, for credit both equal to and below the cost.
- Settlement `credit`:
  - applies to the lot's bill first, then the oldest open bills
  - keeps the leftover as supplier credit
  - `receipt.credited` and `billBalance` update
- Settlement `refund` leaves no allocations. `recordSupplierRefund` posts `cash` / `payable` and updates `refunded`. Over the credit throws.
- Refund sources: `refund` returns first, then `credit` ones, oldest first.
- Returning more than the lot holds throws. Two lines on the same batch are summed.
- The wrong supplier for a traced lot throws; an opening-stock lot can go to any supplier.
- Quarantined twins and recalled lots can be returned. A return with `recallId` must use the reason `recalled`.
- A zero total throws.
- A lot under an open stock count can't be returned (the count freeze message).
- P2 (credited), P3 and P5 hold after every case.
- **Browser test:** open a receipt, *Return items* for one lot as damaged with credit, and see the bill balance drop and the return in the Returns tab.

## Acceptance criteria
- [ ] Any lot with stock, including quarantined and recalled ones, can be returned to its supplier.
- [ ] Staff choose credit or refund per return.
- [ ] A credit reduces what we owe, starting with that lot's bill.
- [ ] A refund is recorded when the supplier's money arrives.
- [ ] Stock, inventory value and payables stay consistent (P3, P5).
