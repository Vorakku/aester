# 001 — Supplier accounts

## Goal
Give each supplier the account details purchasing needs:
- **payment terms** (how many days we have to pay their bills)
- **lead time** (how many days they usually take to deliver)
- **minimum order value** (some distributors won't deliver below an amount)

And make new purchase orders faster and more accurate by **prefilling each line with the last price we paid** that supplier for that product.

Today suppliers are plain contacts. `Contact.paymentTermsDays` exists (sales 001) but only customers can edit it, and the PO form fills costs from `Product.cost`.

## Data model
```ts
// Contact — new fields (customers keep their defaults and never use them)
leadTimeDays: number;          // whole days 0–365, default 0
minOrderValue: number | null;  // USD; null = no minimum
// paymentTermsDays (existing) now applies to suppliers too.
```
`ContactInput` gains optional `leadTimeDays?: NumericInput` and `minOrderValue?: NumericInput | null`.

## Operations

### `saveContact` (extend)
- For **suppliers**, read and validate:
  - `paymentTermsDays` with the existing `accountDays(…, 'Payment terms')`. Default when creating: `s.settings.defaultPaymentTermsDays`. When editing and omitted: keep the old value.
  - `leadTimeDays` with `accountDays(…, 'Lead time')`. Default `0`; keep the old value when omitted.
  - `minOrderValue`: `null` or `''` → `null`; otherwise `moneyCheck(value, 'Minimum order')` and must be `> 0`, error `Minimum order must be greater than zero.`
- For **customers**: `leadTimeDays = 0`, `minOrderValue = null`. Nothing else changes.
- The customer-only block (`groupId`, `creditLimit`, `onHold`, `billing`) stays customer-only.

### `lastPurchasePrice(s, supplierId, productId, unit): { price: number; date: string; reference: string } | null`
- Looks at **received** purchase orders of this supplier (status `Received`), newest `received` date first (tie: higher PO number first).
- Returns the price of the first line with the same `productId` **and** the same `unit`, with `date = po.received` and `reference = po.number`.
- `null` when there's none. Don't convert between units (same limitation as sales price entries).
- Leave a marker: `// 003: read actual prices from receipt lines instead`. Spec 003 switches the source to goods-receipt lines, which hold the actual billed price.

### `purchaseLinePrice(s, supplierId, productId, unit): number`
`lastPurchasePrice(...)?.price ?? unitPrice(product, unit, true)`. This is the single default for a PO line cost.

### `createPurchase` (extend)
- When a line has no `cost`, use `purchaseLinePrice(s, data.supplierId, l.productId, l.unit ?? product.unit)` before calling `normalizedLines`.
- Lines that pass a `cost` keep it, as today.

### `expectedDate(s, supplierId, orderDate): string`
`shift(contact.leadTimeDays, orderDate)`. The PO form uses it as the default *Expected delivery*.

### `belowMinimumOrder(s, supplierId, total): number | null`
Returns the supplier's `minOrderValue` when it's set and `total < minOrderValue`, otherwise `null`. It's only used for **warnings**; nothing is blocked.

### Reorder suggestions (inventory 007)
`reorderSuggestions` computes `estimatedCost` with `purchaseLinePrice(s, rule's supplier, productId, orderUnit)` instead of `unitPrice(p, orderUnit, true)`, so the prefilled PO and the suggestion agree.

## Migration
- Every contact without `leadTimeDays` gets `0`. Every contact without `minOrderValue` gets `null`.
- Suppliers already have `paymentTermsDays` (sales 001 migration). Leave it.

## Backup validation
- `leadTimeDays` passes `accountDays`. `minOrderValue` is `null` or a number > 0 that passes `moneyCheck`.
- Customers have `leadTimeDays === 0` and `minOrderValue === null`.

## UI
1. **Contact form, supplier type:** a *Supplier account* section with *Payment terms (days)*, *Lead time (days)*, *Minimum order ($, optional)*. Hide it for customers; the existing customer account section stays hidden for suppliers.
2. **Supplier detail:** show terms (e.g. "30 days", or "Cash on delivery" for 0), lead time, minimum order ("None" when null).
3. **Purchase order form:**
   - Picking a supplier sets *Expected delivery* to `expectedDate(...)` (staff can change it).
   - Adding a product or changing its unit fills *Cost* with `purchaseLinePrice(...)`. Under the cost, show a small hint: *"Last paid $8.50 on 12 Sep (PO-0203)"*, or *"No previous purchase — default cost"*.
   - When `belowMinimumOrder(...)` returns a value, show a warning `Callout`: *"BioHealth Pharma's minimum order is $500.00. This order is $320.00."* Saving is still allowed.

## Sample data
Set the four seed suppliers through `saveContact`:
| Supplier | Terms | Lead time | Minimum order |
|---|---|---|---|
| s1 MediCore Distribution | 30 | 2 | — |
| s2 BioHealth Pharma | 45 | 5 | $500 |
| s3 Pacific Medical Supply | 15 | 3 | — |
| s4 VitaWell Laboratories | 0 (cash on delivery) | 7 | $300 |

Set them **before** the seed creates purchase orders, so the seeded open POs are consistent. Change one seeded received PO line's cost so `lastPurchasePrice` visibly differs from `Product.cost` for at least one product.

## Tests
- `saveContact` stores supplier terms, lead time and minimum order. Invalid values throw the spec's messages. Editing without the fields keeps them.
- Customers always get `leadTimeDays 0` and `minOrderValue null`, even if the input has values.
- `lastPurchasePrice`:
  - returns the newest received PO line for that supplier, product and unit
  - ignores other suppliers, other units, and POs that aren't `Received`
  - returns `null` when there's no history
- `createPurchase` without a line cost uses the last price; without history it uses the product default; an explicit cost wins.
- `expectedDate` adds the supplier's lead time.
- `belowMinimumOrder` returns the minimum only when the total is below it.
- `reorderSuggestions` `estimatedCost` uses the last price.
- Migration: a v3 backup without the new fields loads with the defaults, and invariants hold.
- **Browser test:** edit a supplier's lead time and minimum order, open *New purchase order* for it, and see the expected date, the last-price hint, and the minimum-order warning.

## Acceptance criteria
- [ ] Suppliers have editable payment terms, lead time and minimum order.
- [ ] New PO lines prefill with the last price paid to that supplier, with a visible hint.
- [ ] The expected delivery date defaults from the supplier's lead time.
- [ ] A PO below the supplier's minimum shows a warning but can still be saved.
