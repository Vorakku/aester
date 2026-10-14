# 008 — Reserved stock

## Goal
Promise stock to a customer **before** invoicing, so two sales can't promise the same units. Common cases:
- **Hold:** a pharmacy phones and asks to keep 10 cartons until Friday.
- **Reserved draft invoice:** an order is prepared now and issued once the customer confirms.

There's no Sales Orders module yet (README, *Out of scope*). Reservations come from **holds** and **draft invoices**. Sales Orders will later create reservations through this same API with `source: 'sales_order'`.

## Data model
```ts
export interface Reservation {
  id: string;             // uid('rsv')
  number: string;         // RSV-0001 from counters.reservation
  productId: string;
  customerId: string;
  qty: number;            // integer > 0, base units
  source: 'hold' | 'invoice';
  sourceId?: string;      // invoice id when source = 'invoice'
  status: 'Active' | 'Released' | 'Fulfilled';
  expires?: string;       // YYYY-MM-DD, holds only
  note: string;
  createdAt: string;      // ISO
  createdBy: string;
  closedAt?: string;
}
Workspace.reservations: Reservation[];   // newest first
Workspace.counters.reservation: number;
```
**Expiry is evaluated lazily.** An `Active` hold with `expires < today()` is *treated as expired*: it isn't counted and shows the status **Expired**. It isn't rewritten, and there are no timers.

```ts
reservationStatus(r): 'Active' | 'Expired' | 'Released' | 'Fulfilled'
```

### Scope decision
Reservations are **product-level**, not tied to a batch or warehouse. The batch is still chosen at issue time (earliest expiry, plus the 006 eligibility rules). Add this comment: `// ponytail: product-level reservations; add warehouseId if branches start selling from their own stock`.

## Quantities
```ts
reserved(s, productId, { exceptSourceId?: string } = {}): number
// Σ qty of Active, non-expired reservations, optionally excluding one invoice's own

free(s, productId, { customerId?, allowShortDated?, exceptSourceId? } = {}): number
// sellableQty(s, productId, { customerId, allowShortDated }) − reserved(s, productId, { exceptSourceId })
// without customerId: A.available(s, productId) − reserved(...)
```
`free` may be **negative** when stock dropped after reserving (see *Physical reality wins*). The UI calls this **Over-reserved**.

## Operations
```ts
holdStock(s, { productId, customerId, qty, expires?, note? }): Reservation
```
- Customer only. The product must be active (005).
- `qty` uses `qtyCheck` and must be ≤ `free(s, productId, { customerId })`.
- `expires` defaults to `shift(3)`, must be ≥ today and ≤ `shift(30)`.

```ts
reserveInvoice(s, invoiceId): Reservation[]
```
- Draft only, and not already reserved.
- Creates **one reservation per product**, summing `qty × factor` (002) across the draft's lines.
- **All or nothing.** When any product is short, throw one error listing every short product:

  `Not enough free stock: Paracetamol 500mg (need 600, free 450), Vitamin C (need 48, free 30).`

```ts
releaseReservation(s, reservationId): void
// Active (or expired) → Released, sets closedAt
releaseInvoiceReservations(s, invoiceId): void
```

### Changes to existing invoice operations
| Operation | Change |
|---|---|
| `createInvoice` (editing a draft) | If the draft was reserved, release its reservations and run `reserveInvoice` again **in the same transaction**. When the edited quantities no longer fit, throw `Not enough free stock to keep this draft reserved: …`. Nothing changes, because `transact` discards the copy. |
| `deleteDraft` | Release its reservations first. |
| `issueInvoice` | The availability check uses `free(s, productId, { customerId, allowShortDated, exceptSourceId: invoice.id })`, so the invoice can use its **own** reserved units but nobody else's. On success, its reservations become `Fulfilled`. |

### Hold → invoice
`InvoiceInput` gains `fromHoldIds?: string[]`. In `createInvoice`:
- Each listed hold must be Active, non-expired, and for the same customer.
- Release them in the same transaction.
- When the invoice is saved as a **draft**, call `reserveInvoice` straight away, so the promise carries over without a gap.

### Physical reality wins
Adjustments, write-offs, recalls and transfers are **not** blocked by reservations. If stock falls below what's reserved, the product shows **Over-reserved** and appears in the alerts dialog. Someone has to call the customer; the system doesn't hide the problem.

## Backup validation
- `reservations` is an array.
- References point to a known product and customer, and to a Draft or Issued invoice for `source: 'invoice'`.
- `qty` is an integer > 0, and statuses are valid.
- Holds have a valid `expires`.
- Issued invoices have no `Active` reservations.

## UI
1. **Inventory table:** columns **Available | Reserved | Free**, in base units with the 002 pack breakdown. Show the `Over-reserved` badge when free < 0.
2. **Product detail:**
   - **Reservations** list: number, customer, qty, source (Hold / INV-xxxx), expires, status, with **Release** on active rows.
   - **Hold stock** button opens a dialog: customer, qty (with pack helper), expires (default +3 days), note.
3. **Draft invoice detail:**
   - **Reserve stock** or **Release reservation** button.
   - A `Reserved` badge on reserved drafts, also in the invoice list.
4. **Invoice form:** each line hints `450 free · 150 reserved` for the chosen customer.
5. **Contact detail** (customers): active holds, each with **Create invoice**. It opens the invoice form prefilled with the customer, product and qty, and sets `fromHoldIds`.
6. **Alerts dialog** and dashboard attention panel:
   - holds expiring today or tomorrow
   - over-reserved products

## Sample data
- **Reserve** the existing seed draft invoice for *Lotus Health Pharmacy*.
- Active hold: *Greenlife Pharmacy*, 2 cartons of Paracetamol, expires in 2 days.
- Expired hold: *Wellness Medical Center*, expired yesterday, never released. It shows as **Expired** and isn't counted.
- One `Released` hold, for history.

## Tests
- A hold of 100 lowers `free` by 100. Another customer's invoice for more than the remaining free stock fails, and the error names the product.
- A reserved draft can be issued using its own reserved units. Its reservations become `Fulfilled`, and `reserved()` drops back.
- `deleteDraft` releases the reservations.
- Editing a reserved draft beyond free stock throws, and the old reservation is still Active (state unchanged).
- An expired hold isn't counted in `reserved()`, and its status is `Expired`.
- `fromHoldIds`: the hold is released and the draft is reserved in one transaction. A hold for a different customer throws.
- A write-off below the reserved quantity succeeds, and `free` goes negative (Over-reserved).
- 006 is respected: `free` for a 365-day customer only counts long-dated stock.
- **Browser test:** hold stock from product detail, check Free drops, then create an invoice from the hold and issue it.

## Acceptance criteria
- [ ] Stock can be held for a customer with an expiry date, or reserved by a draft invoice.
- [ ] No sale can use stock reserved for someone else.
- [ ] Reservations are released or fulfilled automatically by draft deletion, editing and issuing.
- [ ] Over-reserved products and expiring holds are visible.
