# 008 — Statements and aging

## Goal
Answer *"who owes us what, and for how long?"* with:
- an **aging report** across all customers
- a **customer statement** to send each customer

These also power the overdue rule of the credit check (001).

## Balance as of a date
Both reports must work for **any past date**, not only today. Build them from dated events, never from today's cached `paid` / `credited`:

| Event | Date | Effect on what the customer owes |
|---|---|---|
| Invoice issued | `invoice.date` | + total |
| Payment received | `payment.date` | − amount (the full amount, allocated or not) |
| Payment voided | `payment.voidDate` (007) | + amount |
| Credit note issued | `cn.date` | − total |
| Refund paid | `refund.date` | + amount |

**Customer balance** at date D = sum of all events dated ≤ D. A negative balance means the customer has credit with us.

For **aging per invoice**, an invoice's open amount at date D = `total` − its payment and credit-note allocations dated ≤ D. Allocations of a payment voided on or before D don't count.

Voiding removes a payment's allocations (007), so keep a copy of them on the payment for history when voiding: add `voidedAllocations: PaymentAllocation[]` to `CustomerPayment`, set by `voidPayment`. Past-date aging uses them for dates before `voidDate`.

## Operations

### `agingReport(s, asOf = today()): AgingRow[]`
```ts
interface AgingRow {
  customerId: string;
  current: number;   // open amounts not yet due (due >= asOf)
  d1_30: number;     // 1–30 days past due
  d31_60: number;
  d61_90: number;
  d90plus: number;
  credit: number;    // unapplied customer credit at asOf (shown separately, as a positive number)
  total: number;     // current + all buckets − credit
}
```
- Days past due = `asOf − invoice.due`, using each invoice's open amount at `asOf`.
- Only customers with a non-zero row are listed. A totals row is included.
- **Consistency:** Σ `total` over all customers = the receivable ledger balance at `asOf` (`balances(s, '', asOf).receivable.balance`). Add this as a test.

### `customerStatement(s, customerId, { from, to }): Statement`
```ts
interface Statement {
  opening: number;   // balance at the day before `from`
  lines: Array<{
    date: string;
    type: 'Invoice' | 'Payment' | 'Payment voided' | 'Credit note' | 'Refund';
    reference: string;  // INV / PAY / CN number
    description: string;
    debit: number;      // increases what they owe
    credit: number;     // decreases it
    balance: number;    // running
  }>;
  closing: number;   // balance at `to`
  aging: AgingRow;   // as of `to`
}
```
- Events dated within `[from, to]`, oldest first. Same-day events are ordered invoice → credit note → payment → refund.
- `closing = opening + Σ debit − Σ credit` must hold. Test it.

### Overdue rule (001)
`creditCheck`'s overdue condition uses the aging data as of today: any amount more than `overdueGraceDays` past due. Refactor 001's check to call this shared helper:
```ts
overdueAmount(s, customerId, graceDays, asOf = today()): number
```

## Migration
`CustomerPayment.voidedAllocations = []` when missing. A payment voided before this spec has no record of its old allocations; treat it as never allocated for past dates.

**Change to 007:** `voidPayment` copies the allocations into `voidedAllocations` before removing them.

## UI
1. **Accounting page → new "Receivables" tab:**
   - **Aging table:** customer, current, 1–30, 31–60, 61–90, 90+, credit, total. Buckets above 60 days are highlighted.
   - *As of* date picker.
   - Click a customer to open their statement.
   - **Export CSV.**
2. **Customer statement** (customer detail → **Statement**):
   - date range: default **first day of last month → today**
   - opening balance, lines with running balance, closing balance
   - an aging summary box
   - **Print** (company header like the invoice; customer address; *"Please pay the amount due by…"*) and **Export CSV**
3. **Dashboard:** replace or extend the existing *Overdue amount* metric with a compact **aging bar** (current / 1–30 / 31–60 / 61–90 / 90+) that links to the Receivables tab.
4. **Contacts list:** an optional *Overdue* column (amount past grace), which can be sorted.

## Sample data
The data from 001–007 should already give spread-out ages. Check that the seed produces something in **every bucket**: at least one invoice 31–60 days overdue, one 61–90, one 90+ (e.g. an unpaid seed invoice from about 120 days ago), and at least one customer with **unapplied credit**. Adjust the seed (through operations) if any bucket is empty.

## Tests
- Buckets: invoices due 10, 45, 75 and 120 days ago land in `d1_30`, `d31_60`, `d61_90` and `d90plus`. A not-yet-due invoice lands in `current`.
- **As of a past date:**
  - a payment made after that date doesn't reduce the aging then
  - a payment voided after that date still counts as paid then
- A partly paid invoice ages only its open amount.
- **Consistency:** Σ aging totals = receivable ledger balance, for today and for a date 60 days ago.
- Statement:
  - `opening` + movements = `closing`
  - an invoice, a payment, a credit note and a refund each appear once, with the right side and sign
  - a deposit (unallocated payment) shows as a credit and reduces the balance
- `overdueAmount` matches 001's credit-check behaviour with grace 0 and with grace 7.
- **Browser test:** open Receivables, set *As of* 30 days ago, open a customer's statement, check that the closing balance equals their aging total, and print.

## Acceptance criteria
- [ ] Management sees who owes what, by age, for any date, and it always matches the books.
- [ ] Each customer can be sent a clear statement with opening balance, movements and closing balance.
- [ ] The credit check's overdue rule uses the same numbers.
