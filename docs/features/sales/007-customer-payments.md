# 007 — Customer payments and credit

## Goal
Record money as it really arrives:
- **one payment can cover several invoices**
- money that isn't for a specific invoice yet, such as a **deposit before delivery** or an overpayment, is kept as **customer credit**
- credit is **applied automatically** when the next invoice is issued
- a **bounced cheque** can be voided

Today each payment lives inside one invoice (`invoice.payments`).

## Data model
```ts
export interface Allocation {        // reuse the name; different from inventory picks
  invoiceId: string;
  amount: number;
  date: string;                      // when it was applied (may be after the payment date)
}
export interface CustomerPayment {
  id: string;                        // uid('pay')
  number: string;                    // PAY-0001 from counters.payment
  customerId: string;
  date: string;
  amount: number;
  method: 'Bank transfer' | 'Cash' | 'Card' | 'Cheque' | 'Other';
  reference: string;                 // bank ref / cheque no.
  note: string;
  allocations: Allocation[];
  refunded: number;                  // cached: Σ refunds taken from this payment
  status: 'Posted' | 'Voided';
  voidReason: string;
  voidDate: string;                  // business date of the void, '' while Posted (used by 008)
  legacy?: true;
  createdAt: string; createdBy: string;
}
export interface Refund {
  id: string;                        // uid('refund')
  date: string;
  customerId: string;
  amount: number;
  method: string;
  from: { kind: 'payment' | 'credit_note'; id: string; amount: number }[];
  createdBy: string;
}
Workspace.payments: CustomerPayment[];
Workspace.refunds: Refund[];
Workspace.counters.payment: number;
// CreditNote.allocations (006) gain `date`; CreditNote.refunded becomes Σ Refund.from for that note.
// Invoice.payments is removed (moved to Workspace.payments).
```
Name the TypeScript type `PaymentAllocation`, to avoid clashing with the existing `Allocation` type.

### Credit sources
```ts
paymentCredit(p)  = p.status === 'Posted' ? p.amount − Σ allocations − p.refunded : 0
creditNoteCredit(cn) = cn.total − Σ allocations − cn.refunded          // 006 creditAvailable
customerCredit(s, customerId) = Σ paymentCredit + Σ creditNoteCredit  // ≥ 0
```
Sources are used **oldest first** (by date, then number) whenever credit is applied or refunded.

## Operations

### `recordPayment(s, input): CustomerPayment`
```ts
input: { customerId; date; amount; method; reference?; note?;
         allocations?: { invoiceId: string; amount: NumericInput }[] }   // omitted = auto
```
- A Customer contact. `amount > 0`. `date ≤ today`.
- **Auto allocation** (when `allocations` is omitted): open issued invoices of this customer, **oldest due date first**, each up to its balance, until the money runs out.
- **Explicit allocations:** issued invoices of this customer, each ≤ its balance, and Σ ≤ amount. The allocation `date` is the payment date.
- **Leftover:** whatever isn't allocated stays as customer credit.
- **Journal entry:** `cash` debit, `receivable` credit, for the **full amount**. Reference `number`, description `Customer payment — <method>`.
- `invoice.paid += allocation.amount` for each allocation.

### `applyCredit(s, { customerId, invoiceId, amount?, date? })`
- An issued invoice of this customer with a balance.
- `amount` defaults to `min(balance, customerCredit)`, and must be ≤ both.
- Take the money from sources oldest first. Each source gets an allocation `{ invoiceId, amount, date }`:
  - from a payment: `invoice.paid += amount`
  - from a credit note: `invoice.credited += amount`
- **No journal entry.** The money is already inside accounts receivable.

### Automatic application
Fill in the `// 007:` markers in `issueInvoice` (both paths, 004 and 005): after posting, call `applyCredit` for `min(balance, customerCredit)` when credit > 0.

This covers *pay before delivery*: the deposit is a payment with no allocation, and it pays the invoice the moment the invoice is issued.

### `removeAllocation(s, { source: 'payment' | 'credit_note', id, invoiceId })`
Moves that money back into customer credit, for fixing a payment applied to the wrong invoice. It updates the invoice's `paid` or `credited`. No journal entry.

### `refundCredit(s, { customerId, amount, method, date })`
- `amount > 0`, `amount ≤ customerCredit`.
- Take from sources oldest first. Record a `Refund` with `from`, and increase each source's `refunded`.
- Journal entry: `receivable` debit, `cash` credit. Description `Refund — <method>`.
- **006's refund at issue** now goes through this same function, limited to that credit note.

### `voidPayment(s, id, reason)`
For a bounced cheque or a payment recorded by mistake. Takes an optional `date` (default today, ≥ the payment date, ≤ today), stored as `voidDate`.
- `Posted`, and nothing refunded from it. The reason is required.
- Remove all its allocations (reduce `invoice.paid`).
- Journal entry: `receivable` debit, `cash` credit, amount, description `Payment voided — <reason>`.
- Status `Voided`.

### Compatibility
- `payInvoice(s, id, amount, method, date)` stays as a thin wrapper: `recordPayment` with one explicit allocation. Existing callers and tests keep working.
- **Supplier bills** (`payBill`) are unchanged.

### Credit exposure (001)
At the `// 007:` marker, subtract `customerCredit`.

## Migration
- For every invoice with `payments`: create one `CustomerPayment` per old payment, with:
  - `legacy: true`, a number from the counter, same date, amount and method
  - one allocation to that invoice, dated the payment date
  - `status: 'Posted'`, `refunded: 0`, `voidReason: ''`, `voidDate: ''`
- Then delete `invoice.payments`.
- The old journal entries already match (`cash` debit, `receivable` credit), so add no new entries.
- For every credit note: give allocations without a `date` the credit-note date. When `refunded > 0` and there's no matching `Refund`, create one dated the credit-note date.
- Defaults: `payments: []`, `refunds: []`, `counters.payment = 1`.

## Backup validation
- Valid fields. Allocations point at issued invoices of the same customer.
- **S2:** `invoice.paid` = Σ allocations from **Posted** payments. `invoice.credited` = Σ credit-note allocations.
- Every source has `allocations + refunded ≤ amount` (or total).
- `Refund.from` sums to `amount`, and matches the sources' `refunded`.
- Voided payments have no allocations or refunds.
- **S3:** receivable balance = Σ open invoice balances − Σ `customerCredit` over all customers.

## UI
1. **Record payment dialog.** It replaces the per-invoice payment form for customers and can be opened from the Invoices page, invoice detail, or customer detail.
   - Fields: customer, date, amount, method, reference, note.
   - A table of the customer's open invoices, **oldest due first**, with an *Apply* amount auto-filled oldest-first and editable.
   - Footer: *"$X applied · $Y kept as credit"*.
   - Opened from an invoice, that invoice is pre-selected.
2. **Invoices page → "Payments" tab:** number, date, customer, method, reference, amount, applied, credit left, status.
3. **Payment detail:**
   - its allocations, with **Remove** per allocation
   - **Void payment** (with a reason)
   - **Print receipt** (official receipt: PAY number, customer, amount, invoices paid)
4. **Invoice detail:**
   - *Payments & credits* list: payment number or credit-note number, date, amount
   - **Apply credit** when the customer has credit
5. **Customer detail:**
   - **Available credit**, with **Apply to oldest invoices** and **Refund credit**
   - payments list

## Sample data
- Existing seed payments become `CustomerPayment`s through `payInvoice`.
- **One payment covering three invoices** of Greenlife by bank transfer.
- **Lotus Health** (terms 0) pays a **deposit** before its order is delivered. Its invoice is then issued and the deposit applies automatically.
- **Wellness Medical Center:** a cheque payment that was **voided**, reason "Cheque returned unpaid". This matches its account hold in 001.
- The price-correction credit from 006 is partly **applied** to another invoice, and the rest **refunded**.

## Tests
- Auto allocation pays the oldest due invoices first. The leftover becomes credit.
- Explicit allocations over an invoice's balance, or over the amount, throw.
- **Deposit:** a payment with no invoice gives credit. Issuing an invoice applies it automatically, and the invoice shows paid.
- `applyCredit` uses sources oldest first, updating `paid` for payments and `credited` for credit notes. No journal entry.
- `removeAllocation` returns the money to credit.
- `refundCredit` beyond the available credit throws. A valid refund posts the cash entry and updates sources and `Refund.from`.
- `voidPayment`:
  - reopens the invoices
  - reverses the cash entry
  - is refused after a refund
- `payInvoice` still works as before.
- Migration turns every `invoice.payments` entry into a legacy payment. Balances don't change, and S2/S3 hold.
- `creditCheck` exposure subtracts customer credit.
- **Browser test:** record one payment for two invoices plus extra, see both paid and the extra as credit, then issue a new invoice for that customer and see the credit applied.

## Acceptance criteria
- [ ] One payment can settle several invoices. Any extra becomes customer credit.
- [ ] Deposits and credit notes are applied to invoices automatically, or manually, or refunded.
- [ ] Bounced payments can be voided, reopening the invoices.
- [ ] Accounts receivable always equals open invoices minus customer credit.
