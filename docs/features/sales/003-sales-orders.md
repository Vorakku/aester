# 003 — Sales orders and quotations

## Goal
Record what a customer wants **before** anything is delivered or invoiced.
- A **quotation** is a priced offer.
- A confirmed **sales order** reserves stock and tracks what's still to deliver.
- Anything that can't be delivered now stays on the order as a **backorder**.

## Data model
```ts
export interface OrderLine {
  id: string;            // uid('sol')
  productId: string;
  name: string;          // copied, like invoice lines
  sku: string;
  unit: Unit;
  factor: number;        // base units per line unit (inventory 002)
  qty: number;           // ordered, in line units
  price: number;         // per line unit (default from priceFor, 002)
  cancelledQty: number;  // in line units, default 0
}

export interface SalesOrder {
  id: string;            // uid('so')
  number: string;        // SO-0001 from counters.order (quotes and orders share it)
  customerId: string;
  status: 'Quote' | 'Confirmed' | 'Done' | 'Cancelled';
  date: string;          // quote/order date, <= today
  validUntil?: string;   // quotes only; default date + 14
  requestedDate: string; // when the customer wants it; >= date
  fulfilment: 'delivery' | 'pickup';
  deliveryAddress: string;   // default: customer address
  lines: OrderLine[];
  discountPercent: number;   // 0..100, applied to the whole order
  taxRate: number;           // 0..100, default settings.taxRate
  allowShortDated: boolean;  // inventory 006 consent, default false
  notes: string;
  creditOverride?: CreditOverride;   // from 001
  cancelReason?: string;
  createdAt: string; createdBy: string;
  confirmedAt?: string; confirmedBy?: string;
  closedAt?: string;
}
Workspace.orders: SalesOrder[];   // newest first
Workspace.counters.order: number;

// Inventory 008 Reservation
source: 'hold' | 'invoice' | 'sales_order';   // add 'sales_order'
```
`discountPercent` is a percentage, not an amount. That way partial invoices (005) can each apply it.

### Derived values (functions, never stored)
```ts
deliveredQty(s, order, lineId): number  // line units; 0 until 004, then from dispatched deliveries
openQty(s, order, lineId): number        // qty − cancelledQty − deliveredQty
orderTotals(order): Totals               // on (qty − cancelledQty); discount = round(subtotal × pct / 100)
orderOpenValue(s, order): number         // open lines' value incl. discount and tax, used by creditCheck
fulfilmentStatus(s, order): 'Not delivered' | 'Partly delivered' | 'Delivered'
quoteStatus(order): 'Quote' | 'Expired'  // Expired when validUntil < today (computed lazily, like holds)
```

## Operations

### `saveOrder(s, input, id?): SalesOrder`
```ts
input: {
  customerId: string;
  date: string;
  validUntil?: string;
  requestedDate: string;
  fulfilment: 'delivery' | 'pickup';
  deliveryAddress?: string;
  lines: { id?: string; productId: string; unit?: Unit; qty: NumericInput; price?: NumericInput }[];
  discountPercent?: NumericInput;
  taxRate?: NumericInput;
  allowShortDated?: boolean;
  notes?: string;
  asQuote?: boolean;  // new documents only; default true
}
```
**Always:**
- A Customer contact, active products, valid units (`normalizedLines`).
- `price` defaults to `priceFor` (002).
- Dates are valid. Quotes get `validUntil ≥ date`.

**By status when editing:**

| Status | What can change |
|---|---|
| **Quote** | Everything. |
| **Confirmed** | The customer is locked.<br>Lines can be added.<br>A line's qty can't drop below `deliveredQty + cancelledQty`. Error: `<product>: <n> already delivered or cancelled.`<br>Price and unit can change only on lines with nothing delivered.<br>Only lines with nothing delivered can be removed.<br>If the total increases, run `creditCheck` with the increase (needs `override` when blocked).<br>Afterwards, call `reserveOrder`. |
| **Done / Cancelled** | Nothing. Error: `This order is closed.` |

### `confirmOrder(s, id, { override? } = {}): SalesOrder`
- The order must be a Quote that isn't expired. Error: `Quote expired on <date>. Update and save it first.`
- Run `creditCheck(s, customerId, orderOpenValue)`. When blocked and there's no override, throw the reasons joined into one message. With an override, store `creditOverride`.
- Set status `Confirmed`, `confirmedAt` and `confirmedBy`.
- Call `reserveOrder`.
- **Not enough stock doesn't block confirming.** The shortfall is a backorder.

A form can also save and confirm in one action. Call `saveOrder` and then `confirmOrder` inside the **same** `mutate()`.

### `reserveOrder(s, id): void`
Brings the order's reservations in line with what's still open:
- For each product: `need` = Σ `openQty × factor` (base units).
- `target` = `min(need, free(s, productId, { customerId, allowShortDated, exceptSourceId: order.id }))`.
- **One Active reservation per order and product** (`source: 'sales_order'`, `sourceId: order.id`):
  - create it if `target > 0` and none exists
  - set its `qty = target` if one exists
  - release it if `target === 0`
- **Change in inventory 008:** `reserved()` / `free()` `exceptSourceId` must exclude a matching `sourceId` of **any** source, not only invoices.
- Called on confirm, after every edit, from the Backorders screen, after each delivery (004), and on cancel.
- Add this comment: `// ponytail: backorders aren't auto-reserved when stock arrives; staff use "Reserve available stock". Hook into receipts if this gets missed.`

### `cancelRemaining(s, id, { lineId?, reason }): void`
- Confirmed orders only. `reason` is required.
- For the given line (or all lines): `cancelledQty += openQty`.
- Then `reserveOrder`, then `closeIfDone`.

### `cancelOrder(s, id, reason): void`
- Allowed for a Quote, or a Confirmed order with **nothing delivered**. Otherwise the error is: `Part of this order was delivered. Cancel the remaining quantities instead.`
- Set `Cancelled` and `cancelReason`.
- Release all its reservations.

### `closeIfDone(s, id)`
A Confirmed order where every line has `openQty === 0` becomes `Done`, with `closedAt`. 004 calls it after each delivery.

### Credit exposure (001)
Add `+ Σ orderOpenValue` of the customer's Confirmed orders to `creditCheck`, at the `// 003:` marker.

## Migration
- `orders: []`
- `counters.order = 1`

## Backup validation
- Statuses and dates are valid.
- Lines are valid (as for invoice lines), with `0 ≤ cancelledQty ≤ qty`.
- Quotes have `validUntil`. Cancelled orders have `cancelReason`.
- `sales_order` reservations point to an existing order. **Active** ones only to a `Confirmed` order.
- At most one Active reservation per order and product.

## UI
1. **New page "Orders"** (`orders`, SALES section). Tabs:
   - **Quotations:** number, customer, date, valid until, total, status (`Quote` / `Expired`).
   - **Orders:** number, customer, date, requested date, total, fulfilment status, a `Backorder` badge when anything is open and unreserved.
   - **Backorders:** one row per open line not fully reserved: order, customer, product, open qty, reserved, **free now**. A **Reserve available stock** button per order.

   Buttons: **New quotation**, **New order**.
2. **Order form** (large dialog). Reuse the line editor from `TransactionForm`: product, unit, price badge from 002, barcode scan, below-cost warning. Fields:
   - customer, with an account status badge from 001
   - date, valid until (quotes), requested date
   - Delivery / Pickup, delivery address
   - discount %, tax %, *Allow short-dated stock*, notes

   Each line shows `free` for this customer. Buttons: **Save quotation**, **Save & confirm order**.

   When the credit check blocks, show the reasons and **Override and confirm** (asks for a reason).
3. **Order drawer:**
   - Header: status, customer, dates, totals, credit override note if any.
   - Lines table: ordered, delivered, cancelled, **open**, reserved.
   - Actions by status:

     | Status | Actions |
     |---|---|
     | Quote | Confirm, Edit, Cancel, Print quotation |
     | Confirmed | Edit, Reserve available stock, Cancel remaining (per line or all), Cancel order (only when nothing delivered), Print order confirmation, **Create delivery** (enabled by 004) |
4. **Print:** quotation and order confirmation, using the existing invoice print layout.
5. **Customer detail:** an *Orders* list.

## Sample data
| # | Order | Details |
|---|---|---|
| 1 | Quotation | Valid, for Sunrise Hospital |
| 2 | Quotation | **Expired**, for CarePlus |
| 3 | Confirmed order | Fully reserved, for Greenlife |
| 4 | Confirmed order | With a **backorder** on a low-stock product (Amoxicillin) |
| 5 | Confirmed order | For Wellness (on hold), confirmed **with an override**: "Owner approved, cheque replaced" |
| 6 | Cancelled order | With a reason |

004 adds a partly delivered order on top of these.

## Tests
- `saveOrder` defaults prices from `priceFor`. Customer, product and date validation throws.
- An expired quote can't be confirmed until it's re-saved with a new `validUntil`.
- Confirming:
  - reserves `min(need, free)` per product
  - leaves a backorder when stock is short
  - doesn't throw for short stock
- Credit check: an on-hold customer can't be confirmed without an override. With an override, `creditOverride` is stored.
- Confirmed edits:
  - qty below delivered + cancelled throws
  - adding a line extends the reservation
  - reducing qty shrinks it
- `reserveOrder` keeps one Active reservation per order and product. Another customer's hold reduces what the order can reserve. Re-running it after stock arrives tops it up.
- `cancelRemaining` closes the order when nothing is left open. `cancelOrder` releases everything, and is refused once something has been delivered (test it after 004).
- `creditCheck` exposure includes the order's open value.
- **Browser test:** create a quotation, confirm it, see the reservation in product detail, then cancel the remaining qty.

## Acceptance criteria
- [ ] Quotes can be created, printed, and turned into confirmed orders.
- [ ] Confirming checks credit (with override) and reserves the stock that's free. The rest is visible as a backorder.
- [ ] Orders can be edited safely, partly cancelled or cancelled, and close themselves when everything is delivered or cancelled.
