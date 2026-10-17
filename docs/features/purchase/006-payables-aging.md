# 006 — Payables aging and supplier statements

## Goal
Answer *"who do we owe, how much, and when is it due?"* with:
- a **payables aging report** across all suppliers
- a **supplier statement**, to check against the statement the supplier sends us
- a **due soon** list, so bills get paid on time

This mirrors sales 008 (`agingReport`, `customerStatement`). Reuse its structure and helpers.

## Balance as of a date
Both reports must work for **any past date**. Build them from dated events, never from today's cached `paid` / `credited`:

| Event | Date | Effect on what we owe the supplier |
|---|---|---|
| Goods receipt (bill) | `receipt.date` | + total |
| Supplier return | `return.date` | − total |
| Supplier payment | `payment.date` | − amount |
| Payment voided | `payment.voidDate` | + amount |
| Supplier refund received | `refund.date` | + amount |

**Supplier balance** at date D = sum of all events dated ≤ D. A negative balance means the supplier owes us (supplier credit).

For **aging per bill**, a bill's open amount at date D = `total` − its payment allocations dated ≤ D − its return allocations dated ≤ D. Allocations of a payment voided on or before D don't count. For dates before `voidDate`, use the payment's `voidedAllocations` (005), the same way `invoiceOpenAt` does.

## Operations

### `payableEvents(s, supplierId)`
Same shape as `receivableEvents`. Event types `'Bill' | 'Return' | 'Payment' | 'Payment voided' | 'Refund'`. References are the GRN / RTS / SP numbers. A bill's description is `<supplier ref> · due <date>`. Same-day order: bill → return → payment → payment voided → refund.

### `billOpenAt(s, receipt, asOf): number`
The per-bill open amount described above (mirror `invoiceOpenAt`).

### `payablesAging(s, asOf = today()): SupplierAgingRow[]`
```ts
interface SupplierAgingRow {
  supplierId: string;   // '' on the totals row
  current: number;      // not yet due (due >= asOf)
  d1_30: number;        // 1–30 days past due
  d31_60: number;
  d61_90: number;
  d90plus: number;
  credit: number;       // unapplied supplier credit at asOf, as a positive number
  total: number;        // what we owe at asOf = Σ payableEvents ≤ asOf
}
```
- Days past due = `asOf − receipt.due`, using each bill's open amount at `asOf`.
- `credit` = buckets − total (as in `customerAging`).
- Only suppliers with a non-zero row are listed, plus a totals row.
- **Consistency:** Σ `total` = `balances(s, '', asOf).payable.balance`. Add this as a test, for today and for a past date.

### `supplierStatement(s, supplierId, { from, to }): SupplierStatement`
```ts
interface SupplierStatement {
  opening: number;
  lines: Array<{ date: string; type: 'Bill' | 'Return' | 'Payment' | 'Payment voided' | 'Refund';
                 reference: string; description: string;
                 debit: number;    // decreases what we owe (payment, return)
                 credit: number;   // increases it (bill, void, refund)
                 balance: number }>;
  closing: number;
  aging: SupplierAgingRow;   // as of `to`
}
```
- Supplier-side convention: **credit increases what we owe**, debit decreases it, and `balance` = what we owe (opening + Σ credit − Σ debit).
- Same validation and messages as `customerStatement` (`Select a supplier.`, the date-order message).

### `billsDue(s, { days = 7, asOf = today() } = {})`
Open bills (`billBalance > 0`) with `due ≤ asOf + days`, overdue first, then by due date. Each row: receipt, supplier, due, balance, `daysOverdue` (0 when not yet due).

### Supplier balance helper
`supplierBalance(s, supplierId)` = Σ `billBalance` of their receipts − `supplierCredit`. Use it wherever a supplier's balance is shown (contacts list, supplier detail), replacing the inline sums.

## Migration
None. This spec only adds reports.

## UI
1. **Purchasing page → new "Payables aging" tab:**
   - **Aging table:** supplier, current, 1–30, 31–60, 61–90, 90+, credit, total. Buckets above 60 days are highlighted.
   - *As of* date picker.
   - Click a supplier to open their statement.
   - **Export CSV.**
2. **Due soon panel** at the top of the Purchasing page (above the tabs, under the metrics): `billsDue` for the next 7 days, with GRN, supplier, due (red when overdue), balance and a **Pay** button (opens 005's dialog with that bill). Hide it when empty.
3. **Supplier statement** (supplier detail → **Statement**):
   - date range: default **first day of last month → today**
   - opening balance, lines with running balance, closing balance, aging summary
   - **Print** (company header; supplier name and address; *"Statement of account"*) and **Export CSV**
4. **Dashboard:** a **Bills due this week** metric (Σ `billsDue` balances, with the overdue part in the foot text) that links to the Purchasing page.
5. **Contacts list and supplier detail:** the balance comes from `supplierBalance`.

## Sample data
Check that the seed (001–005) gives something in **every bucket**: at least one bill 1–30, one 31–60, one 61–90 and one 90+ days past due, one not yet due, and at least one supplier with **unapplied credit**. Make sure `billsDue` shows at least one overdue bill and one due within 7 days. If a bucket is empty, adjust the seed through the operations (e.g. leave an old seed bill unpaid).

## Tests
- Buckets: bills due 10, 45, 75 and 120 days ago land in `d1_30`, `d31_60`, `d61_90` and `d90plus`. A bill not yet due lands in `current`.
- **As of a past date:**
  - a payment made after that date doesn't reduce the aging then
  - a payment voided after that date still counts as paid then
  - a return credit applied after that date doesn't count then
- A partly paid bill ages only its open amount.
- **Consistency:** Σ aging totals = payable ledger balance, today and 60 days ago.
- Statement:
  - `opening` + movements = `closing`
  - a bill, a return, a payment, a voided payment and a refund each appear once, on the right side
- `billsDue` includes overdue bills and bills due within the window, excludes paid bills and later ones, and is sorted overdue first.
- `supplierBalance` = what `payablesAging` shows for that supplier today.
- **Browser test:** open *Payables aging*, set *As of* 30 days ago, open a supplier's statement, check that the closing balance equals their aging total, and print.

## Acceptance criteria
- [ ] Management sees who we owe, by age, for any date, and it always matches the books.
- [ ] Each supplier's statement can be printed and checked against theirs.
- [ ] Bills that are overdue or due this week are visible at a glance, with a way to pay them.
