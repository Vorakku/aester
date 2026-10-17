# 005 — Supplier payments and credit

## Goal
Pay suppliers the way the business really does:
- **one payment can cover several bills** (e.g. a monthly bank transfer), or pay one bill at a time
- **supplier credit** from returns (004) is applied to bills, automatically for credit returns
- a payment made by mistake, or a **cancelled cheque**, can be voided

There are **no supplier prepayments**: a payment can't be more than the supplier's open bills.

Today `payBill` adds to one bill's `paid` and posts a journal entry, with no payment record.

## Data model
```ts
export interface SupplierPayment {
  id: string;                               // uid('spay')
  number: string;                           // SP-0001 from counters.supplierPayment
  supplierId: string;
  date: string;
  amount: number;
  method: 'Bank transfer' | 'Cash' | 'Card' | 'Cheque' | 'Other';
  reference: string;                        // bank ref / cheque no.
  note: string;
  allocations: SupplierCreditAllocation[];  // the type from 004: { receiptId, amount, date }
  status: 'Posted' | 'Voided';
  voidReason: string;
  voidDate: string;                         // '' while Posted
  voidedAllocations: SupplierCreditAllocation[];   // what it paid before the void, for dated reports (006)
  legacy?: true;
  createdAt: string;
  createdBy: string;
}
Workspace.supplierPayments: SupplierPayment[];
Workspace.counters.supplierPayment: number;
```
A Posted payment is **always fully allocated**: Σ allocations = amount.

## Operations

### `paySupplier(s, input): SupplierPayment`
```ts
input: { supplierId; date?; amount: NumericInput; method; reference?; note?;
         allocations?: { receiptId: string; amount: NumericInput }[] }   // omitted = auto
```
- A Supplier contact. `amount > 0`. `date` defaults to today and can't be in the future.
- **Auto allocation** (when `allocations` is omitted): `openBills(s, supplierId)`, oldest due first, each up to its balance, until the money runs out. If the money is more than all open bills: error `This payment is more than the $<open> open on <supplier>'s bills. Supplier prepayments aren't supported.`
- **Explicit allocations:**
  - receipts of this supplier, each ≤ its `billBalance`
  - Σ = amount, error `Allocate the full payment to bills.`
- Every allocated bill has `receipt.date ≤ date`, the existing message `Choose a payment date between receipt and today.`
- The allocation `date` is the payment date. `receipt.paid += amount` for each allocation.
- **Journal entry:** `payable` debit, `cash` credit, for the full amount. Reference `number`. Description `Supplier payment — <method>`.
- Activity `Supplier payment recorded`.

### `payBill(s, receiptId, amount, date)` (compatibility)
A thin wrapper: `paySupplier` with one explicit allocation and method `Bank transfer`. Existing callers and tests keep working.

### `applySupplierCredit(s, { supplierId, receiptId, amount?, date?, onlyCredit? })`
- A receipt of this supplier with a balance.
- `amount` defaults to `min(billBalance, available)` and must be ≤ both. `available` = `supplierCredit`, or, with `onlyCredit: true`, only the credit of returns with `settlement: 'credit'`.
- Take the money from returns **oldest first**. Each one gets an allocation `{ receiptId, amount, date }`, and `receipt.credited += amount`.
- **No journal entry.** The credit is already inside accounts payable.

### Automatic application
At the end of `receivePurchase` and of `receiveStock` (credit path), call `applySupplierCredit` with `onlyCredit: true` when that credit is > 0. A supplier credit from a *credit* return then reduces the next bill on its own. *Refund* returns are never applied automatically: we're waiting for cash.

### `removeReturnAllocation(s, { returnId, receiptId })`
Moves that credit back into supplier credit, for credit applied to the wrong bill. Updates `receipt.credited`. No journal entry.

There's **no** "remove allocation" for payments, because a payment must stay fully allocated. To fix a payment applied to the wrong bills, void it and record it again.

### `voidSupplierPayment(s, id, reason, date = today())`
- `Posted`, error `Only posted payments can be voided.` A reason is required, error `Enter a reason for voiding this payment.`
- `payment.date ≤ date ≤ today()`.
- Move `allocations` to `voidedAllocations`, and reduce each `receipt.paid`.
- **Journal entry:** `cash` debit, `payable` credit, the amount. Description `Supplier payment voided — <reason>`.
- Status `Voided`, `voidReason`, `voidDate`.

### `receiveStock` cash path (change)
A direct receipt paid in cash now posts like any bill (`purchaseEntries(…, 'payable')`), then calls `paySupplier` for the full amount with method `Cash`. The net effect on the ledger is the same as today (`inventory` debit, `cash` credit), and `receipt.paid` comes from a real payment, so P2 holds.

### Guards
`contactInUse`, `emptyWorkspace`, the seed's initial object, `migrate`, the `validateBackup` lists: add `supplierPayments` and `counters.supplierPayment`.

## Migration
Turn every receipt's `paid` into payment records. **Add no journal entries.**
1. For each receipt with `paid > 0`, find the old payment journal entries: description `Supplier payment`, a `payable` debit, and a reference equal to one of the receipt's old references. Those are the PO number (when `purchaseId` is set), `receipt.number`, `receipt.reference`, and `receipt.id`. Use each journal entry **at most once**, oldest first, until their sum reaches `paid`.
2. Each matched entry becomes a legacy `SupplierPayment`: `date` = the entry date, `amount` = its payable debit, `method: 'Other'`, one allocation to the receipt dated the same, `status: 'Posted'`, `legacy: true`.
3. Whatever is still unmatched becomes one more legacy payment dated `receipt.date`, with `method: 'Cash'` for a direct receipt (no `purchaseId`), else `'Other'`.
4. Number the payments `SP-0001…` from `counters.supplierPayment`, in date order.
5. Defaults: `supplierPayments: []`, `counters.supplierPayment = 1`, and `voidedAllocations: []` where missing.
- **Write a test before the migration:** turn the seed back into the pre-005 shape (drop `supplierPayments`, keep `receipt.paid`), migrate it, and prove every `receipt.paid`, the payable balance and the journal are unchanged.

## Backup validation
- Payments:
  - unique `SP-` numbers; supplier is a Supplier; a valid method and status
  - Posted: `Σ allocations = amount`, `voidedAllocations` empty
  - Voided: `allocations` empty, `Σ voidedAllocations = amount`, a reason, and a valid `voidDate ≥ date`
  - allocations point at receipts of the same supplier
- **P2** in full: `receipt.paid` = Σ allocations from Posted payments; `receipt.credited` = Σ return allocations; `0 ≤ total − paid − credited`.
- **P3** as in 004 (payments create no credit).

## UI
1. **Pay supplier dialog** (replaces the bill mode of `PaymentForm`):
   - Fields: supplier, date, amount, method, reference, note.
   - A table of the supplier's open bills, **oldest due first** (GRN, supplier ref, due, balance, *Apply*). *Apply* is auto-filled oldest-first from the amount and editable.
   - Footer: *"$X applied of $Y"*. Save is disabled until they match.
   - When the supplier has credit: *"Supplier credit $Z available"*, with **Apply credit first**, which applies it to the oldest bills before the payment.
   - Opened from: the Payments tab, receipt detail (that bill pre-selected), and supplier detail.
2. **Purchasing page → Payments tab:** SP, date, supplier, method, reference, amount, bills paid, status.
3. **Payment detail:** the bills it paid; **Void payment** (asks for a reason); **Print payment voucher** (SP number, supplier, amount, method, reference, bills paid, with *Prepared by* / *Approved by* / *Received by* signature lines).
4. **Receipt detail:** a *Payments & credits* list (SP / RTS number, date, amount); **Apply credit** when the supplier has credit; **Remove** on return credits.
5. **Supplier detail:** a payments list, and **Apply credit to oldest bills**.
6. Badge colour for `Voided` (reuse the sales one).

## Sample data
- The existing seed `payBill` calls become payments through the wrapper.
- **One payment covering three bills** of MediCore Distribution, by bank transfer.
- A **cheque** payment to BioHealth Pharma, **voided** with reason "Cheque cancelled — wrong amount", then paid again correctly.
- A *credit* return's leftover credit (from 004's seed) **applied automatically** to that supplier's next receipt.

## Tests
- Auto allocation pays the oldest due bills first. More than the open bills throws the spec's message.
- Explicit allocations: over a bill's balance, Σ ≠ amount, or a bill of another supplier all throw.
- A payment date before a bill's receipt date throws.
- `payBill` still works as before.
- `applySupplierCredit` uses returns oldest first, posts no journal entry, and updates `credited`. `onlyCredit` ignores refund returns.
- A new receipt auto-applies credit from *credit* returns, and not from *refund* returns.
- `removeReturnAllocation` returns the credit.
- `voidSupplierPayment`:
  - reopens the bills
  - reverses the cash entry
  - keeps `voidedAllocations`
  - is refused twice and without a reason
- The `receiveStock` cash path creates a `Cash` payment, and the bill shows Paid.
- **Migration:** the round-trip test above. P2/P3 hold.
- **Browser test:** pay two bills of one supplier with one payment, see both Paid, then void it and see them open again.

## Acceptance criteria
- [ ] One payment can settle several supplier bills.
- [ ] Supplier credit from returns can be applied to bills, automatically for credit returns.
- [ ] A payment can be voided, reopening its bills.
- [ ] `receipt.paid` always equals its payments, and payables equal open bills minus supplier credit.
