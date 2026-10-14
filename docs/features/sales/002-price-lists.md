# 002 — Price lists

## Goal
Different customers pay different prices. A wholesaler sets prices **per customer group** (Pharmacy, Clinic, Hospital), with occasional **special prices for one customer**, and per pack (a carton isn't always 50 × the box price). Every sales document should fill in the right price automatically.

## Data model
```ts
export interface PriceEntry {
  id: string;            // uid('price')
  productId: string;
  unit: Unit;            // base unit or one of the product's pack units (inventory 002)
  price: number;         // USD per that unit
  groupId?: string;      // exactly one of groupId / customerId is set
  customerId?: string;
  note: string;
}
Workspace.prices: PriceEntry[];

// CustomerGroup.discountPercent (added in 001) is used here.
```
**Uniqueness:** at most one entry per `(productId, unit, groupId)` and per `(productId, unit, customerId)`.

## Price resolution
```ts
priceFor(s, { productId, unit, customerId? }): {
  price: number;
  source: 'customer' | 'group' | 'group_discount' | 'default';
  entryId?: string;
}
```
The first match wins:
1. **Customer entry** for this product and unit
2. **Group entry** for the customer's group, this product and unit
3. **Group discount:** the default price (step 4) × (1 − `discountPercent` / 100), rounded. Only when the group's `discountPercent > 0`.
4. **Default:** `pack.price ?? round(product.price × factor)`. This is the existing `unitPrice()` from inventory 002.

There's no automatic conversion between units. A carton entry only applies to cartons; a box entry only to boxes. This keeps prices exactly what the business typed. Leave this comment: `// ponytail: no unit conversion between price entries; add if they want box prices to imply carton prices`.

## Rules
- `savePrice(s, { productId, unit, price, groupId?, customerId?, note? }, id?)`:
  - exactly one target, which must be an existing group or a **Customer** contact
  - the product must be active
  - the unit must be valid for the product
  - `moneyCheck(price)`, and the price must be > 0
  - the uniqueness rule above
- `deletePrice(s, id)`.
- **Price below cost warning.** Not blocking. `belowCost(s, productId, unit, price)` is true when `price < round(product.cost × factor)`. The UI shows it.
- **Where it's used.** Every sales line that gets a product or unit, or whose customer changes, takes its default price from `priceFor`:
  - the existing invoice form (`TransactionForm`, sale mode)
  - orders and quotations (003)
  - the POS later

  Staff can still type a different price on the line.
- **Changing the customer** on a draft document re-prices lines whose price still equals the old resolved price. Lines the user edited by hand keep their price.
- Deleting a customer group (001) also deletes its price entries. Show the count in the confirm dialog.
- Deactivated products (inventory 005) keep their entries but don't show in the editor unless *Show inactive* is on.

## Migration
- `prices: []`.

## Backup validation
- Valid product, unit and target.
- Unique keys.
- `price > 0`.

## UI
1. **New page "Price lists"** (`pricing`, SALES section):
   - **Matrix view:** one row per active product (and per pack unit), with columns:
     - Cost
     - Default price
     - one column per group: entry price, or the computed group-discount price shown in muted italics, or blank
   - Click a cell to edit inline. Clearing it deletes the entry.
   - A cell below cost gets a red outline and the tooltip *"Below cost ($X)"*.
   - Filters: search, category, unit.
   - **Export CSV.**
2. **Group discount** is editable in the column header: *Clinic · 3% off default*.
3. **Contact detail → "Special prices"** (customers):
   - list of that customer's entries: product, unit, price, the price they'd otherwise get, and the difference
   - add, edit and delete
4. **Line editors** (invoice form, later the order form):
   - after picking product and unit, show the price source as a small badge: *Special*, *Clinic price*, *Clinic −3%*, or *Default*
   - a *Below cost* warning when it applies

## Sample data
- **Group entries:**
  - Hospital: special prices on 6 high-volume products, including Paracetamol **carton** and **box**
  - Clinic: 4 products
- **Group discounts:** from 001 (Clinic 3%, Hospital 8%).
- **Customer specials:** Greenlife gets 3 special prices, one of them on a carton.
- **One deliberate below-cost entry**, so the warning is visible.
- The seed's historical invoices keep their stored prices. Only **new** documents use the price lists.

## Tests
- Resolution order: customer > group entry > group discount > default. Each step is tested by removing the one above it.
- A carton entry doesn't affect the box price, and vice versa.
- Group discount 8% on a $10 default gives $9.20, rounded to cents.
- Uniqueness and target validation throw. A supplier as target throws.
- Deleting a group removes its entries.
- `belowCost` is true and false at the boundary.
- **Browser test:** set a Clinic price, create an invoice for a Clinic customer, check the line price and the *Clinic price* badge, then switch the customer to a Pharmacy and check the line re-prices.

## Acceptance criteria
- [ ] Prices can be set per group and per customer, per unit, plus an optional percentage discount per group.
- [ ] Every new sales line gets the right price automatically, and shows where it came from.
- [ ] Prices below cost are flagged.
