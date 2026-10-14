# 007 — Reorder levels and suggestions

## Goal
Set **minimum and maximum stock per product per warehouse**, and get a list of what to reorder, grouped by supplier, that turns into purchase orders in one click.

Today there's a single company-wide `Product.reorder`, used only for the "Low stock" badge.

## Data model
```ts
export interface ReorderRule {
  productId: string;
  warehouseId: string;
  min: number;   // reorder point, integer ≥ 0, base units
  max: number;   // order up to, integer > min, base units
}
Workspace.reorderRules: ReorderRule[];   // unique per (productId, warehouseId)
```
`Product.reorder` stays as it is: the **company-wide low-stock threshold** for the status badge and alerts. Rules are optional and per warehouse. A product without a rule for a warehouse gets no suggestion there.

## Operations
```ts
saveReorderRule(s, { productId, warehouseId, min, max }): ReorderRule   // create or replace
deleteReorderRule(s, productId, warehouseId): void
onOrder(s, productId, warehouseId): number   // Σ base qty (qty × factor) on 'Ordered' POs to that warehouse
reorderSuggestions(s, warehouseId?): Suggestion[]
```
```ts
interface Suggestion {
  productId: string;
  warehouseId: string;
  supplierId: string;       // product.supplierId, '' when none
  available: number;        // A.available(s, productId, warehouseId)
  onOrder: number;
  position: number;         // available + onOrder
  min: number;
  max: number;
  orderBase: number;        // suggested base qty (after rounding up to the pack)
  orderUnit: Unit;          // pack unit used for ordering, or the base unit
  orderQty: number;         // orderBase / factor
  estimatedCost: number;    // round(orderQty × default purchase cost per that unit) — 002 rule 5
}
```

### Rules
1. `min` and `max` are safe integers, with `0 ≤ min < max`. The product and warehouse must exist, and the product must be active (005).
2. A suggestion is created when `position ≤ min`. Then `need = max − position`.
3. **Pack rounding:** order in the product's **largest pack** (002) when it has one, rounding `need` **up** to whole packs. Otherwise order in base units.
   *Example:* need 130 boxes, carton = 50 → 3 cartons = 150 boxes.
4. `available` already leaves out expired, quarantined and recalled stock (006), so they don't count as stock on hand.
5. Reservations (008) are product-level, not per warehouse, so suggestions **don't** subtract them. Add this comment: `// ponytail: ignores reservations; subtract per-warehouse reservations if they're added`.
6. Suggestions are computed on demand and never stored.

## UI
1. **Product detail → "Reorder levels" section:**
   - One row per warehouse: min, max, available, on order.
   - Inline edit with Save and Remove. Empty means no rule.
2. **Purchasing page → new "Reorder suggestions" tab:**
   - Filter by warehouse.
   - **Grouped by supplier + warehouse.** Products without a preferred supplier go in a *"No preferred supplier"* group.
   - Each row: product, warehouse, available, on order, min/max, **suggested** (`3 cartons (150 boxes)`), est. cost, and a checkbox (checked by default).
   - Each group has a **Create purchase order** button. It opens the existing purchase form (`TransactionForm`, purchase mode) **prefilled** with the supplier, warehouse and the checked lines (product, unit, qty, cost), so the user reviews it before saving. Add an optional `initial` prop to `TransactionForm` for this.
   - After the PO is created, `onOrder` covers those lines, so they leave the list automatically.
3. **Purchasing nav badge:** the number of suggestions. Optional, if it's cheap.

## Sample data
- Rules for **every product in `wh_main`**: `min = product.reorder`, `max = product.reorder × 4`.
- Rules for about 8 products in `wh_branch`.
- Make sure the seed produces suggestions in at least **three supplier groups**, including one product with a carton pack, so pack rounding shows.

## Tests
- No suggestion when `position > min`. A suggestion when `position ≤ min`, with `orderBase = max − position`.
- An `Ordered` PO to the same warehouse raises `position`, and the suggestion disappears or shrinks. A PO to another warehouse doesn't count.
- Pack rounding: need 130, carton 50 → orderQty 3, orderBase 150.
- Quarantined and expired stock aren't counted as available.
- `min ≥ max` throws. A rule for an inactive product throws.
- **Browser test:** open Reorder suggestions, create a PO from a group, and that group's lines disappear from the list.

## Acceptance criteria
- [ ] Each product can have min and max levels per warehouse.
- [ ] Suggestions account for stock on hand and stock already ordered, and round up to purchase packs.
- [ ] A supplier group becomes a reviewed purchase order in one click.
