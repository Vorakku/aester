# 003 — Stock adjustments

## Goal
Correct a batch's quantity **up or down by any amount** with a reason, and post the inventory value change to the books. Today only `disposeBatch` exists, and it writes off the *whole* batch.

## Data model
```ts
export type AdjustmentReason =
  | 'damaged' | 'expired' | 'lost' | 'sample' | 'recall'  // remove only
  | 'found'                                               // add only
  | 'count' | 'other';                                    // either direction

export interface Adjustment {
  id: string;            // uid('adj')
  number: string;        // ADJ-0001 from counters.adjustment
  date: string;
  batchId: string;
  productId: string;
  warehouseId: string;
  lotCode: string;
  qty: number;           // signed integer, base units
  unitCost: number;      // batch.cost at the time
  value: number;         // signed, round(qty × unitCost)
  reason: AdjustmentReason;
  note: string;
  sourceId?: string;     // stock count id when reason = 'count'
  user: string;
}
Workspace.adjustments: Adjustment[];   // newest first (unshift), like other document lists
Workspace.counters.adjustment: number;
```

## Operation
```ts
adjustStock(s, input: {
  batchId: string;
  qty: NumericInput;          // signed, non-zero integer
  reason: AdjustmentReason;
  note?: string;
  date?: string;              // default today(), must be <= today()
}, options: { sourceId?: string } = {}): Adjustment
```

### Rules
1. The batch must exist. `qty` must be a non-zero safe integer.
2. The reason must match the direction:
   - **Negative qty:** `damaged`, `expired`, `lost`, `sample`, `recall`, `count`, `other`.
   - **Positive qty:** `found`, `count`, `other`.

   Error: `"<reason>" can't be used to add stock.` (or `…to remove stock.`).
3. `note` is required (trimmed) for `other` and `found`.
4. `count` is only allowed when `options.sourceId` is set. Stock counts call it this way (004). Error: `Count differences are posted from a stock count.`
5. `recall` requires an open recall for this product and lot. Add this check when 006 lands.
6. Removing more than `batch.qty` is rejected by `moveStock`.
7. To add stock for a lot that **isn't** in the system, use **Receive stock**, not an adjustment. Say this in the form's hint text.

### Effects
- `moveStock(batch, qty, { type: 'adjustment', reference: number, sourceId: adjustment.id, reason })`
- Journal entry, reference = `number`, description `Stock adjustment — <reason label>`:
  - remove: `loss` debit, `inventory` credit, both `|value|`
  - add: `inventory` debit, `loss` credit, both `|value|`
- `activity(s, 'adjust', 'Stock adjusted', '<±qty> <unit>s · <product> · <lot> · <reason>')`

### Replace `disposeBatch`
Remove `disposeBatch` and update its callers.
- The **Write off all** UI action calls `adjustStock` with `qty = −batch.qty`.
- The reason is `expired` when the batch has expired, otherwise the reason the user picks.

Reason labels: Damaged, Expired, Lost / missing, Sample / promotion, Recall, Found, Count difference, Other.

## Backup validation
- `adjustments` is an array.
- References point to a known batch, product and warehouse.
- `qty` is a non-zero integer, `value === round(qty × unitCost)`, and the reason is valid.
- Each adjustment has exactly one stock move with `sourceId === adjustment.id` and the same qty.

## UI
1. **Batch detail drawer:** replace **Write off** with **Adjust stock**, and keep a **Write off all** shortcut.
2. **Adjust stock dialog:**
   - Direction toggle: **Remove** or **Add**.
   - Quantity in base units, with the pack helper from 002, e.g. "2 cartons + 5 boxes".
   - Reason select, filtered by direction.
   - Note (required for Other and Found).
   - Date.
   - Live preview: *"Stock 120 → 115 boxes · Inventory −$45.60"*.
3. **Warehouses page, new "Adjustments" tab** (next to the Stock ledger from 001):
   - Columns: number, date, product, lot, warehouse, qty (±), value (±), reason, user.
   - Filters: warehouse, reason, date range.
   - Export CSV.
4. **Accounting P&L:** rename the "Stock write-offs" line to **"Stock write-offs & adjustments"**. It's the same `loss` account.

## Sample data
Create these through `adjustStock`, spread over the last 60 days:

| Count | Reason | Size |
|---|---|---|
| 2 | `damaged` | small |
| 1 | `lost` | |
| 1 | `found` | with a note |
| 1 | `sample` | |

Also convert the expired seed batch `BT-OLD-009` into an `expired` write-off of its full quantity.

## Tests
- Removing 5 of 20 at $3.00 leaves 15. Loss debit 15.00, inventory credit 15.00. One move of −5.
- Adding 2 with `found` and a note increases qty and credits `loss`.
- Removing more than on hand throws, and the workspace is unchanged.
- `found` with a negative qty throws. `count` without `sourceId` throws. `other` without a note throws.
- **Write off all** zeroes the batch and posts its full value.
- I1–I5 hold after each case.

## Acceptance criteria
- [ ] Staff can remove or add any quantity on a batch with a reason.
- [ ] Every adjustment is numbered, shows in the Adjustments list and the stock ledger, and posts to the books.
- [ ] Full-batch write-off still works as a shortcut.
