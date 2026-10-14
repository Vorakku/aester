# 006 — Expiry rules and recalls

## Goal
Three wholesale expiry rules:
- **A. Minimum remaining shelf life:** don't ship stock the customer will refuse. Many pharmacies and hospitals reject stock with less than, say, 6 months to expiry.
- **B. Short-dated override:** sell short-dated stock knowingly when the customer agrees, often at a discount.
- **C. Recalls:** block a lot everywhere and list every customer who received it.

## Data model
```ts
// Settings
minShelfLifeDays: number;        // default 180, integer 0..1095

// Contact (customers only)
minShelfLifeDays: number | null; // null = use the company default

// Invoice
allowShortDated: boolean;        // default false

export interface Recall {
  id: string;            // uid('recall')
  number: string;        // RCL-0001 from counters.recall  (not "RC-": seed lot codes already use RC-…)
  productId: string;
  lotCode: string;       // a lot can exist in several warehouses after transfers
  reason: string;
  date: string;
  status: 'Open' | 'Closed';
  createdBy: string;
  closedAt?: string;
  note: string;
}
Workspace.recalls: Recall[];     // newest first
Workspace.counters.recall: number;
```

## A + B: Minimum shelf life on sale

### Rules
```ts
shelfLifeFor(s, customerId): number   // contact.minShelfLifeDays ?? settings.minShelfLifeDays

eligibleBatches(s, productId, { customerId, allowShortDated }): Batch[]
// sellable (qty > 0, not quarantined, not recalled, daysLeft > 0)
// AND (allowShortDated || daysLeft(expiry) >= shelfLifeFor(customerId))
// sorted FEFO exactly like issueInvoice today

sellableQty(s, productId, opts): number  // Σ qty of eligibleBatches
```
- `issueInvoice` uses `eligibleBatches` for both the availability check and the allocation, with `inv.customerId` and `inv.allowShortDated`.
- When stock is short, the error says how much short-dated stock exists:

  `Only 40 boxes of Paracetamol 500mg have at least 180 days of shelf life (60 more are short-dated). Tick "Allow short-dated stock" if the customer accepts them.`
- `A.available()` keeps its company-level meaning ("not expired, quarantined or recalled"). The dashboard and status badges keep using it.
- **Short-dated** (display flag): `0 < daysLeft < settings.minShelfLifeDays`. It's a *secondary* badge shown next to the main batch status. It's not a new `batchStatus` value.

### Settings and seed ordering
- The seed generates historical invoices first, with `minShelfLifeDays: 0`.
- It sets `settings.minShelfLifeDays = 180` **at the end**, so historical allocations don't change and the seed never throws.

## C: Recalls

### Status
`batchStatus` gains **`Recalled`**. Precedence: `Recalled` > `Quarantined` > `Expired` > `Expiring soon` > `Active`.
```ts
isRecalled(s, batch): boolean
// an Open recall exists for batch.productId + batch.code (case-insensitive)
```
`batchStatus` needs `s` (or the recalls) for this. Update its signature and all callers.

### Operations
```ts
createRecall(s, { productId, lotCode, reason, date?, note? }): Recall
```
- At least one batch with this product and lot code must exist, in any warehouse.
- Only one **Open** recall per product and lot.
- `reason` is required.

```ts
closeRecall(s, recallId): void
```
Open only, and only when the on-hand stock of the lot (all warehouses) is 0. Error: `<n> units of lot <code> are still in stock. Write them off first.`

### Effects of an Open recall
- **Excluded from sale.** Leave recalled batches out of `eligibleBatches` and `available`.
- **Receiving more of the lot is blocked.** In `moveStock`: no positive `receipt` move into a recalled lot. Error: `Lot <code> is under recall (RCL-0001).`
- **Transfers are allowed**, for example to gather stock for return.
- **Removal:** recalled stock is removed with `adjustStock` reason `recall`. Turn on 003 rule 5 now: reason `recall` requires an Open recall for the lot.
- A **Closed** recall no longer blocks anything.

### Recall trace (the report)
```ts
recallTrace(s, recallId): {
  sold: Array<{ customerId: string; customerName: string; phone: string; invoice: string; date: string; qty: number }>;
  onHand: Array<{ batchId: string; warehouseId: string; qty: number }>;
  totals: { received: number; sold: number; adjusted: number; onHand: number };
}
```
Built entirely from `stockMoves` (001) where `productId` matches and `lotCode` matches case-insensitively:
- `sale` moves: sold (grouped by invoice)
- `receipt` / `opening`: received
- `adjustment`: adjusted
- current batch quantities: on hand

Transfers net to 0.

## Backup validation
- `minShelfLifeDays` ranges are valid. `allowShortDated` is a boolean.
- Recalls reference a known product, have valid statuses, and have at most one Open recall per product and lot.

## UI
1. **Settings › Company:** *Minimum shelf life on sale (days)*.
2. **Contact form** (customers only): *Minimum shelf life (days)*, with placeholder "Company default (180)".
3. **Invoice form:**
   - *Allow short-dated stock* checkbox.
   - Each line shows `sellableQty` for the selected customer.
   - When short-dated stock would be used, a callout lists the lots and their expiry dates.
4. **Batches page:**
   - `Recalled` in the status filter, plus a *Short-dated* filter.
   - The secondary *Short-dated* badge on rows.
5. **Batch detail:**
   - **Start recall** (danger button) opens a dialog: reason, date, note.
   - When the batch is recalled, a red banner links to the recall.
6. **Batches page, new "Recalls" tab:**
   - List columns: number, product, lot, date, status, customers reached, on hand.
   - **Recall drawer:**
     - reason
     - the *Sold to* table (customer, phone, invoice, date, qty)
     - *Still in stock* per warehouse, each row with a **Write off** action (opens Adjust prefilled with reason `recall`)
     - totals
     - **Export CSV** (for phoning customers)
     - **Close recall**
7. **Alerts dialog** and dashboard attention panel: list Open recalls with stock still on hand.

## Sample data
- Customer overrides: *Sunrise Hospital* `minShelfLifeDays: 365`, *CarePlus Clinic* `90`.
- One **Open recall**. Pick the lot programmatically: the lot whose `sale` moves reach the **most distinct customers**, so the trace has several rows. Reason: *"Supplier notice: packaging seal defect"*. Leave part of it in stock.
- One **Closed recall** on another lot that's fully written off with reason `recall`.
- At least one historical invoice with `allowShortDated: true`.

## Tests
- A customer with 365 days gets only long-dated batches. With `allowShortDated`, the short-dated ones are used, earliest expiry first.
- The insufficient-stock error mentions the short-dated quantity.
- A customer override of `null` falls back to the company setting.
- Recall:
  - blocks sale of that lot in **every** warehouse
  - blocks receiving more of the lot
  - allows transfers
- `closeRecall` with stock on hand throws. After a `recall` write-off, it succeeds, and the lot is no longer blocked.
- `adjustStock` with reason `recall` and no Open recall throws.
- `recallTrace` totals: `received − sold + adjusted = onHand` (adjusted is signed).
- `batchStatus` precedence is correct.

## Acceptance criteria
- [ ] Invoices never ship stock below the customer's minimum shelf life, unless short-dated stock is explicitly allowed.
- [ ] A recall blocks the lot everywhere and produces a call list of affected customers.
- [ ] Recalled stock is written off with a recall reason, then the recall can be closed.
