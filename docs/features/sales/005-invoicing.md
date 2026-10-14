# 005 — Invoicing from deliveries

## Goal
Bill what was actually delivered: one delivery, several deliveries at once (monthly billing), or part of an order. Make sure nothing delivered is forgotten, using a **"Delivered, not invoiced"** list.

Counter sales keep working as restructured in 004: draft → issue = pickup delivery + invoice.

## Data model
```ts
// Invoice additions
orderId?: string;        // set when every delivery on it comes from one order
// Invoice.deliveryIds (added in 004) now also links order deliveries
```
There are now two kinds of draft invoice:

| Kind | `deliveryIds` | Lines |
|---|---|---|
| **Direct draft** | empty | Typed by the user. Issuing it creates the pickup delivery (004). |
| **Delivery draft** | not empty | Copied from the deliveries and **locked**. Issuing posts only the receivable and revenue. |

## Operations

### `createInvoiceFromDeliveries(s, { deliveryIds, date?, due?, notes? }): Invoice`
- **Deliveries:** at least one. All for the same customer, each `Dispatched` or `Delivered`, not invoiced, and not on another draft. Errors:
  - `DN-0012 is already invoiced (INV-1088).`
  - `DN-0012 is on draft INV-1090.`
- **Lines:** one invoice line per delivery line: product, name, sku, unit, factor, qty, price. Don't merge lines; it keeps the link to the delivery note readable.
- **Discount:** for each source order, `round(Σ that order's line amounts × order.discountPercent / 100)`, summed.
- **Tax:** every source order must have the same `taxRate`. Otherwise: `Invoice deliveries with different tax rates separately.`
- **Dates:**
  - `date` defaults to today, must be ≤ today, and must be ≥ the latest delivery date.
  - `due` defaults to date + the customer's terms (001).
- **Links:** `orderId` is set when all deliveries share one order. `deliveryIds` are stored. Status `Draft`, number from the usual counter.

### Editing a delivery draft
- `createInvoice(s, data, id)` must **refuse to change lines** on a delivery draft. Error: `Lines come from delivery notes and can't be edited.`
- Add `saveInvoiceHeader(s, id, { date, due, notes })` for drafts of either kind.
- `deleteDraft` works for both. A deleted delivery draft frees its deliveries.
- `reserveInvoice` (inventory 008) refuses delivery drafts. Their stock has already left.

### `issueInvoice(s, id, { override? })`: two paths
- **Direct draft** (no deliveries): unchanged from 004, including the credit check (001).
- **Delivery draft:**
  1. Re-check that each delivery is still `Dispatched` or `Delivered` and uninvoiced.
  2. **No credit check.** The goods are already with the customer, and they were counted in the exposure when delivered.
  3. Journal entry: `receivable` debit total; `revenue` credit (subtotal − discount); `tax` credit. **No stock, no cost of goods.**
  4. Set `delivery.invoiceId` on each delivery.
  5. Leave a `// 007: apply available customer credit` marker. Spec 007 fills it in.

### Delivered, not invoiced
```ts
deliveredNotInvoiced(s, { customerId?, asOf? }): Array<{
  delivery: Delivery;
  customerId: string;
  value: number;          // Σ qty × price, less the order discount %, plus the order tax %
  ageDays: number;        // asOf − delivery.date
  late: boolean;          // billing overdue for this customer's habit
}>
```
Only deliveries with status `Dispatched` or `Delivered` and no `invoiceId` that **aren't on a draft** are included.

`late` depends on the customer's billing habit (001):
- `per_delivery`: `ageDays > 1`
- `monthly`: delivered in an earlier calendar month than `asOf`

### Credit exposure (001)
At the `// 005:` marker, add Σ `value` of the customer's uninvoiced deliveries.

## Backup validation
- A delivery draft's lines match its deliveries' lines one to one.
- `orderId`, when set, matches the deliveries' order.
- An issued delivery invoice has no direct-sale delivery, and the other way round.

## UI
1. **Invoices page → new "To invoice" tab:**
   - Uninvoiced deliveries grouped by customer, each group showing the billing habit badge and a total.
   - Rows: DN, order, date, age, value, with a `Late` badge.
   - Checkboxes and **Create invoice** (selected rows of one customer). Per customer, **Invoice all**.
   - Creates the draft and opens the invoice detail.
2. **Delivery drawer:** **Create invoice** (this delivery) when uninvoiced, or a link to the invoice.
3. **Order drawer:** **Invoice delivered** (all of this order's uninvoiced deliveries) and an invoices list. Per line, show the **invoiced** qty next to ordered, delivered and open.
4. **Invoice detail:** shows the linked order and delivery notes. On delivery drafts, the line table is read-only, and only date, due date and notes are editable.
5. **Dashboard attention panel and alerts:** *"<n> deliveries waiting to be invoiced ($X)"*, counting `late` ones, linking to the *To invoice* tab.
6. **Accounting overview:** a *Delivered, not invoiced* line under the balance sheet, so month-end shows the cost already posted without matching revenue.

## Sample data
- **Greenlife:** `per_delivery`. The delivered order from 004 is still uninvoiced and is **3 days old**, so it's `late`.
- **Sunrise Hospital:** `monthly`.
  - Two deliveries last month, combined into **one issued invoice**.
  - One delivery this month, uninvoiced and not late.
- **One delivery draft** waiting to be issued.

## Tests
- Creating an invoice from two deliveries of one customer:
  - one line per delivery line
  - discount from each order's percentage
  - due date from terms
  - `orderId` only when they share one order
- Mixed customers, mixed tax rates, already invoiced, on another draft, `Picking` or `Returned` status: each throws.
- Issuing a delivery draft:
  - posts only receivable, revenue and tax
  - doesn't move stock or post cost of goods
  - links the deliveries
- Editing lines on a delivery draft throws. Header edits work. Deleting the draft frees the deliveries.
- `deliveredNotInvoiced`: `late` rules for `per_delivery` (2 days) and `monthly` (previous month vs. this month). Drafted deliveries are excluded.
- `creditCheck` exposure includes uninvoiced deliveries.
- Invariants I1–I5 and S1–S5 hold.
- **Browser test:** in *To invoice*, select two deliveries of one customer, create and issue the invoice, and they disappear from the list.

## Acceptance criteria
- [ ] Deliveries can be invoiced one at a time or together, and partly delivered orders can be invoiced so far.
- [ ] Revenue is posted at invoicing, without touching stock again.
- [ ] Nothing delivered goes unbilled unnoticed: a list shows what's waiting and what's late, per the customer's billing habit.
