# 002 — Units of measure

## Goal
Let the business buy and sell in **packs** (carton, case, box) while stock is always counted in one **base unit**. A wholesaler typically buys *cartons of 50 boxes* from the supplier and sells *2 cartons + 10 boxes* to a pharmacy.

## Concepts
- **Base unit** = the existing `Product.unit`. It's the smallest unit that's stocked and sold. All stored stock quantities are integers in this unit (README, *Quantities and money*).
- **Pack** = a bigger unit holding a whole number of base units, for example `1 carton = 50 boxes`.
- **Document lines** (invoice / purchase order) are written in whatever unit the user picked. Stock code converts them to base units with `factor`.

## Data model
```ts
// Extend Unit (and A.units)
export type Unit =
  | 'box' | 'bottle' | 'pack' | 'tube' | 'device' | 'unit'
  | 'strip' | 'vial' | 'ampoule' | 'sachet' | 'carton' | 'case';

export interface Pack {
  id: string;        // uid('pack')
  unit: Unit;        // e.g. 'carton'
  factor: number;    // base units per pack, integer 2..10000
  barcode: string;   // optional ('' allowed); unique across the whole catalog when set
  price?: number;    // optional selling price for this pack; default round(product.price × factor)
}

Product.packs: Pack[];   // default []

// Line already has `unit`. Add:
Line.factor: number;     // base units per 1 line unit; 1 when the line is in the base unit
```

### Line meaning (important)
- `line.qty` and `line.price` are **in the line's unit**: what's printed on the document and agreed with the customer or supplier.
- Base quantity = `line.qty × line.factor`.
- `totals()` doesn't change (`qty × price`).
- `Allocation.qty` stays in **base units**.

## Rules
1. `factor` is a safe integer from 2 to 10000. A pack's `unit` can't be the base unit, and it's unique within the product.
2. Barcodes, both product barcodes and pack barcodes, are unique across the catalog when not empty. Error: `Barcode 885… is already used by <product> (<unit>).`
3. **A product's base unit can't change** once the product has any batch or appears on any invoice or purchase line. Error: `The base unit can't change after stock or documents exist.`
4. Packs can be added, edited or removed at any time. Documents copy `unit` and `factor` onto each line, so old documents never change.
5. Default prices when a pack is picked on a line:
   - **Sale:** `pack.price ?? round(product.price × factor)`
   - **Purchase:** `round(product.cost × factor)`
6. `normalizedLines` accepts an optional `unit` per line input (default: base unit). It resolves `factor` from the product's packs and throws `Select a valid unit for <product>.` for an unknown unit.

## Effect on stock operations
| Operation | Change |
|---|---|
| `issueInvoice` | Demand per product = Σ `qty × factor`. Allocation works in base units. |
| `receivePurchase` | Batch qty = `qty × factor`. Batch cost: see below. |
| `receiveStock` | The form gets a unit select. `qty` and `cost` are entered per that unit and converted the same way. |

### Cost per base unit and rounding
`batch.cost` stays at 2 decimals per **base unit**:

```
batch.cost      = round(linePrice / factor)
inventoryDebit  = Σ round(baseQty × batch.cost)    // exact batch values → keeps invariant I3
supplierCredit  = document total                   // what the supplier actually bills
difference      = supplierCredit − inventoryDebit
```
If `difference ≠ 0`, add a third journal line on the `loss` account, described *"Purchase rounding"*:
- **debit** when the difference is positive
- **credit** when it's negative

The entry stays balanced, accounts payable matches the supplier's bill, and the inventory ledger matches the batch values.

*Example:* 3 cartons at $58.50, factor 20 → batch qty 60, cost 2.93 → inventory 175.80, payable 175.50, loss credit 0.30.

### Display helper
```ts
formatQty(product, baseQty): { main: string; packs?: string }
// 1240 boxes with carton = 50 → { main: '1,240 boxes', packs: '24 cartons + 40 boxes' }
```
Use the largest pack. Leave out `packs` when the product has none, or when `baseQty` is smaller than one pack.

### Barcode lookup
```ts
findBarcode(s, code): { product: Product; pack: Pack | null } | null
```

## Migration
- `Product.packs = []` when missing.
- `Line.factor = 1` when missing, on invoices and purchases.

## Backup validation
- Packs are valid (rules 1–2).
- Every line has `factor` as a safe integer ≥ 1.
- For every issued invoice, Σ allocation qty per product = Σ `line.qty × line.factor` per product.

## UI
1. **Product form, new "Packaging" section:**
   - Base unit select. It's disabled once rule 3 applies, with a hint explaining why.
   - Pack rows: `[unit] contains [N] <base unit>s · barcode · sale price (optional)`, plus Add and Remove.
2. **Invoice and purchase line editor** (`TransactionForm`):
   - Add a unit select after the product select, listing the base unit and the product's packs.
   - Changing the unit refills the price using rule 5.
   - Hint under the qty: `= 600 boxes`.
   - Add a **Scan barcode** input above the lines. A scanner types the code and presses Enter. `findBarcode` then adds a line with the right product and unit, or increases the qty if the line already exists.
3. **Receive stock form:** unit select. Labels change to "Quantity (cartons)" and "Unit cost per carton".
4. **Purchase receive form:** show `20 cartons (= 1,000 boxes)` for each line.
5. **Invoice document and print:** quantity column shows `20 cartons`.
6. **Inventory table, product detail, batch detail:** show `formatQty`, with the pack breakdown as muted secondary text.
7. **Global search** (`SearchDialog`) also matches pack barcodes.

## Sample data
Add packs to at least these products:

| Product | Pack |
|---|---|
| Paracetamol 500mg | carton = 50 boxes, with its own barcode |
| Amoxicillin 500mg | carton = 40 boxes |
| Vitamin C 1000mg | case = 24 bottles |
| Surgical Masks 50s | carton = 40 boxes |
| Sterile Gauze | carton = 100 packs |

Seed at least **one purchase order received in cartons** and **two issued invoices with a carton line**, one of them mixing carton and box lines.

## Tests
- Selling 2 cartons (factor 50) deducts 100 base units, earliest expiry first, across two batches.
- Receiving 3 cartons at $58.50 (factor 20) produces the exact entries in the example above, and I3 holds.
- Changing the base unit after a receipt throws. Before any history, it succeeds.
- A duplicate barcode across two products throws.
- `findBarcode` returns the pack for a pack barcode and `pack: null` for the base barcode.
- A migrated v1 workspace has `factor: 1` on every line and passes `validateBackup`.

## Acceptance criteria
- [ ] A product can have carton and case packs with their own barcodes.
- [ ] Invoices and purchase orders can mix units. Stock, cost and the ledger stay exact.
- [ ] Stock is shown in base units with a pack breakdown.
- [ ] Scanning a carton barcode on an invoice adds a carton line.
