# 006 — Credit notes and returns

## Goal
Correct an issued invoice without editing it:
- **Return:** goods come back, for example a wrong prescription or a damaged box. Returned stock goes back to **its original lot, in quarantine**.
- **Price correction:** no goods move. The customer was overcharged.

The credit first reduces what's still owed on that invoice. Anything beyond that is **refunded** or **kept as customer credit**; staff choose per credit note.

## Data model
```ts
export type CreditReason =
  | 'wrong_prescription' | 'wrong_item' | 'damaged' | 'expired'
  | 'not_ordered' | 'price_error' | 'other';

export interface ReturnPick {
  batchId: string;        // the ORIGINAL batch the goods were picked from (one of the invoice's picks)
  warehouseId: string;
  lotCode: string;
  qty: number;            // base units returned
  cost: number;           // original pick cost
  returnBatchId?: string; // the quarantined twin it went into (set on issue)
}
export interface CreditNoteLine {
  invoiceLineIndex: number;   // index into invoice.lines (issued lines never change)
  productId: string; name: string; sku: string;
  unit: Unit; factor: number;
  qty: number;                // line units credited
  price: number;              // per line unit; return = the invoice price; correction = credit per unit
  returns: ReturnPick[];      // kind 'return' only; Σ qty === line.qty × factor
}
export interface CreditNote {
  id: string;                 // uid('cn')
  number: string;             // CN-0001 from counters.creditNote
  invoiceId: string;
  customerId: string;
  date: string;
  kind: 'return' | 'correction';
  reason: CreditReason;
  note: string;
  lines: CreditNoteLine[];
  subtotal: number; discount: number; taxRate: number; taxAmount: number; total: number;
  returnCost: number;         // Σ returned qty × cost
  settlement: 'refund' | 'credit';   // what happens to the part the invoice can't absorb
  refundMethod: string;       // when settlement = 'refund'
  allocations: { invoiceId: string; amount: number }[];  // credit applied to invoices
  refunded: number;           // cash paid back from this credit note
  status: 'Draft' | 'Issued';
  createdAt: string; createdBy: string; issuedAt?: string;
}
Workspace.creditNotes: CreditNote[];   // newest first
Workspace.counters.creditNote: number;
Invoice.credited: number;              // Σ allocations from credit notes (cached, S2)
```

### Amounts
- `subtotal` = Σ `qty × price`.
- `discount` = `round(subtotal × invoice.discount / invoice.subtotal)` (the same share as the invoice).
- `taxRate` = the invoice's rate. `taxAmount` and `total` are calculated as in `totals()`.

### Invoice balance (changes everywhere)
- `invoiceBalance(i)` = `total − paid − credited`.
- `invoiceStatus` adds **`Credited`**: when the balance is 0 and `credited ≥ total − paid`, i.e. it was settled mostly by credit.

### Customer credit (used by 007)
`creditAvailable(cn)` = `total − Σ allocations − refunded`. It's > 0 only for `settlement: 'credit'`.

## Operations

### `saveCreditNote(s, input, id?): CreditNote` (status `Draft`)
```ts
input: {
  invoiceId: string;
  kind: 'return' | 'correction';
  reason: CreditReason;
  note?: string;
  date?: string;
  settlement: 'refund' | 'credit';
  refundMethod?: string;
  lines: { invoiceLineIndex: number; qty: NumericInput; price?: NumericInput; returns?: { batchId: string; qty: NumericInput }[] }[];
}
```
- The invoice must be `Issued`.
- `date` is ≥ the invoice date and ≤ today. `note` is required for `other`.
- **Return lines:**
  - `price` = the invoice line price. It can't be changed.
  - `qty` ≤ invoiced qty − qty already returned on issued credit notes for that line.
  - `returns` default to the invoice's picks for that product. Use the latest expiry first, because the customer most likely still has the fresher stock. Staff can change them.
  - Each `batchId` must be one of the invoice's picks for that product, and Σ returned per batch ≤ picked from it − already returned from it.
- **Correction lines:**
  - `price` is > 0 and ≤ the invoice line price.
  - `qty` ≤ the invoice line qty.
  - No `returns`.
- **Caps across all issued credit notes of the invoice:**
  - per line: Σ `qty × price` ≤ the line amount
  - in total: Σ `total` ≤ `invoice.total`

  Error: `This would credit more than was invoiced.`
- `refundMethod` is required when `settlement` is `refund`.

`deleteCreditNote(s, id)` deletes drafts only.

### `issueCreditNote(s, id): CreditNote`
Re-validate everything, then:
1. **Returns:**
   - For each return pick, call `returnToStock` (004) with `quarantine: true`, the original batch, `reference: number`, `sourceId: cn.id`, `counterpartyId: customerId`, and `date`. Store `returnBatchId`.
   - Journal entry: `inventory` debit, `cogs` credit, both `returnCost`.
2. **Revenue reversal:** `revenue` debit (subtotal − discount), `tax` debit, `receivable` credit (total). Reference `number`, description `Credit note — <invoice number>`.
3. **Apply to its own invoice:**
   - `applied = min(total, invoiceBalance(invoice))`
   - if `applied > 0`: push `{ invoiceId, amount: applied }` to `allocations`, and add `applied` to `invoice.credited`
4. **Remainder** `r = total − applied`:
   - **refund:** `refunded = r`. Journal entry: `receivable` debit r, `cash` credit r, description `Refund — <method>`.
   - **credit:** nothing more. The remainder stays as customer credit (007).
5. Set status `Issued`, `issuedAt`. Call `activity(...)`.

When there are returns, the activity text should say: *"Returned stock is in quarantine — release or write it off in Batches."*

### Changes in inventory code
- **`moveStock`** must allow positive `return` moves for **inactive** products. Goods physically come back even when a product was retired. Keep the cold-chain check.
- **`recallTrace`** (inventory 006): add `return` moves to the totals: `received − sold + returned + adjusted = onHand`. Show returned quantities in the *Sold to* rows.
- **Analytics** "Net sales" for a period: invoices minus issued credit notes dated in the period. The Accounting P&L is already correct, because it reads the ledger.

## Migration
- `creditNotes: []`
- `counters.creditNote = 1`
- `Invoice.credited = 0`

## Backup validation
- Valid fields and links.
- Return picks reference the invoice's picks, and the caps hold.
- Amounts recompute exactly.
- **S2:** `invoice.credited` = Σ credit-note allocations to it.
- Every issued return has `return` stock moves with `sourceId` = the credit note id, matching its return picks.
- `allocations + refunded ≤ total`. A credit-note refund requires `settlement: 'refund'`; applying credit to other invoices later (007) is allowed for both settlements.
- **S3:** receivable balance = Σ invoice balances − Σ `creditAvailable`. 007 extends this with payments.

## UI
1. **Invoice detail** (issued): **Credit note / return** button.
2. **Credit note dialog:**
   - Toggle: **Return goods** or **Price correction**. Reason, date, note.
   - One row per invoice line: invoiced qty, already credited, qty to credit, price (editable only for corrections).
   - **Returns:** each row shows its lots (lot, expiry, warehouse, qty), editable by choosing from the invoice's picks.
   - **Preview:** *"Reduces INV-1090's balance by $X."* and, when there's a remainder: *"$Y more: ○ Refund (method) ○ Keep as customer credit."*
   - Buttons: **Save draft**, **Issue credit note**.
3. **Invoices page → "Credit notes" tab:** number, invoice, customer, date, kind, reason, total, settlement, status.
4. **Credit note detail and print:** a document like the invoice, titled **CREDIT NOTE**, referencing the invoice.
5. **Invoice detail:** lists its credit notes. The balance line shows *Credited −$X*.
6. **Customer detail:** credit notes and **available credit**.
7. **Batches page:** the existing *Quarantined* filter shows returned stock. Returned twin batches get a `Returned` badge, recognised by having `return` moves.

## Sample data
| # | Credit note | Settlement |
|---|---|---|
| 1 | **Return**, wrong prescription, on a **paid** invoice | **Refund** in cash |
| 2 | **Return**, damaged, on an **unpaid** invoice | Reduces the balance only |
| 3 | **Price correction** on a paid invoice | **Kept as credit**, so 007 has credit to apply |
| 4 | **Draft** credit note | Not issued |

Of the returned quarantine stock:
- one twin batch is **released**
- one (damaged) is **written off** with reason `damaged`

## Tests
- Return of 2 boxes from an invoice line, from one of its lots:
  - stock goes into a quarantined twin with the same lot, expiry and cost
  - inventory and cost of goods reverse at the original cost
  - revenue and tax reverse
- Unpaid invoice: the credit reduces `invoice.credited` and the balance. No refund, no customer credit.
- Paid invoice with `refund`: the cash entry is posted and `refunded = total`. With `credit`: `creditAvailable = total`.
- Partly paid invoice: the credit fills the open balance first, and only the remainder is refunded or kept.
- **Caps:**
  - returning more than invoiced minus already returned throws
  - a lot not on the invoice throws
  - correction price above the invoice price throws
  - total over the invoice total throws
- A return of a **retired** (inactive) product works.
- `recallTrace` totals include returns.
- `invoiceStatus` shows `Credited` for a fully credited unpaid invoice.
- Invariants I1–I5 and S1–S5 hold.
- **Browser test:** on a paid invoice, return one line (wrong prescription), choose refund, issue it, see the quarantined twin in Batches, then release it.

## Acceptance criteria
- [ ] Issued invoices are corrected only through credit notes: returns or price corrections, fully or partly.
- [ ] Returned medicine goes back to its original lot in quarantine, with stock and cost of goods reversed exactly.
- [ ] Credit reduces what the customer still owes. The rest is refunded or kept as customer credit, as staff choose.
