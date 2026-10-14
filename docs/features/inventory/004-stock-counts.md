# 004 — Stock counts (stocktake)

## Goal

Let staff count what's physically on the shelves, compare it with the system, and post the differences as adjustments, so system stock stays trustworthy.

## Flow

```
Start count  →  Record counted quantities  →  Review differences  →  Post   (or Cancel)
  (Open)              (Open)                       (Open)            (Posted) (Canceled)
```

## Data model

```ts
export interface CountLine {
  batchId: string;
  productId: string;
  lotCode: string;
  expiry: string;
  expected: number;        // batch.qty when the line was added (base units)
  counted: number | null;  // null = not counted yet
}

export interface StockCount {
  id: string;              // uid('count')
  number: string;          // SC-0001 from counters.count
  warehouseId: string;
  categories: string[];    // [] = all categories
  blind: boolean;          // hide expected quantities while counting
  status: 'Open' | 'Posted' | 'Canceled';
  note: string;
  createdAt: string;       // ISO
  createdBy: string;
  postedAt?: string;
  postedBy?: string;
  lines: CountLine[];
}
Workspace.stockCounts: StockCount[];   // newest first
Workspace.counters.count: number;
```

## Rules

### Freeze while counting

While a count is **Open**, stock movements in that warehouse are **blocked**.

- Enforce it in `moveStock` (001), so every path is covered.
- Sales skip batches in warehouses with an Open count and allocate from other warehouses in FEFO order. If only frozen stock could cover the demand, issuing fails with the count freeze error below.
- Error: `<warehouse> is being counted (SC-0003). Post or cancel the count first.`
- Posting the count is the one exception (pass an internal flag).
- Add this comment at the check: `// ponytail: whole-warehouse freeze keeps counts exact; counts must be short (after hours). Upgrade to per-line snapshots if counts need to run during trading.`

### Operations

```ts
startCount(s, { warehouseId, categories?: string[], blind?: boolean, note?: string }): StockCount
```

- The warehouse must exist and have no other Open count.
- Create one line per batch in that warehouse with `qty > 0`, in the selected categories (or all). Include quarantined, recalled and expired batches, because they're physically on the shelf.
- `expected = batch.qty`, `counted = null`.
- Throw `There is no stock to count in <warehouse>.` when there are no lines.

```ts
addCountLine(s, countId, batchId): void
```

For a batch of the **same warehouse** that wasn't in the snapshot (for example `qty 0`, but it was found on the shelf). It adds a line with `expected = batch.qty`. Lots that don't exist in the system at all are received with **Receive stock** after posting; say this in the UI.

```ts
recordCount(s, countId, batchId, counted: NumericInput | null): void
```

`counted` is a safe integer ≥ 0, or `null` to clear it. It can be changed any number of times while the count is Open.

```ts
postCount(s, countId): { lines: number; differences: number; value: number }
```

1. The count must be Open.
2. Every line must be counted. Error: `<n> lines are not counted yet.`
3. For each line where `counted !== expected`: assert `batch.qty === expected` (guaranteed by the freeze), then call `adjustStock({ batchId, qty: counted − expected, reason: 'count', note: count.number }, { sourceId: count.id })`.
4. Set status `Posted`, `postedAt` and `postedBy`.
5. Call `activity(...)`.
6. Return a summary. `value` is the signed sum of the adjustment values.

```ts
cancelCount(s, countId): void
```

Open only. Sets `Canceled` and lifts the freeze. No stock changes.

## Backup validation

- `stockCounts` is an array, with at most one Open count per warehouse.
- Lines reference batches that are in the count's warehouse.
- `counted` is `null` or an integer ≥ 0.
- A Posted count has no `null` lines.

## UI

1. **Warehouses page, new "Stock counts" tab:**
   - List columns: number, warehouse, status, progress `counted / lines`, difference value, created by and date.
   - **Start count** button opens a dialog: warehouse, categories (multi-select, empty = all), _Blind count_ checkbox, note.
2. **Count sheet** (large dialog or drawer, opened from the list):
   - **Scan / search box** at the top. A lot code or product barcode (including pack barcodes from 002) jumps to the matching line.
   - Table: product, lot, expiry, expected, counted, difference.
     - Expected and difference are **hidden while `blind` is on and lines are still uncounted**.
     - The counted input accepts base units, with a "+ packs" helper, e.g. "3 cartons + 12".
   - Each entry saves immediately with `recordCount`.
   - Header shows progress, e.g. "142 / 180 counted".
   - **Add lot** (calls `addCountLine`), **Print count sheet** (print CSS; leaves the counted column empty for counting on paper), **Cancel count**.
   - **Review & post** opens a review of the lines with differences (product, lot, expected, counted, ±qty, ±value) and the total value, then a confirm dialog.
3. **Freeze banner:** while a warehouse is being counted, its warehouse card and the Inventory page show _"Counting in progress (SC-0003) — stock movements in Central warehouse are paused."_

## Sample data

- One **Posted** count on `wh_branch`, about 20 days ago. Most lines match. Post two differences: one −3 and one +1.
- Don't leave an Open count in the seed. It would freeze a warehouse in the demo.

## Tests

- `startCount` snapshots exactly the batches with stock in that warehouse and categories.
- A second Open count for the same warehouse throws. A count on another warehouse is allowed.
- While Open:
  - Receiving, transferring, invoicing or adjusting stock **in that warehouse** throws.
  - The same operations in **another** warehouse succeed.
- `postCount` with uncounted lines throws, and nothing changes.
- `postCount` creates one `count` adjustment per differing line, with the right journal entries. Lines without a difference create nothing.
- `cancelCount` lifts the freeze and leaves stock untouched.
- I1–I5 hold after posting.
- **Browser test:** start a blind count, check expected is hidden, count everything with one difference, post it, and see the adjustment in the Adjustments tab.

## Acceptance criteria

- [ ] A warehouse can be counted, fully or by category, including blind counts.
- [ ] Differences are reviewed before posting and become count adjustments in the books.
- [ ] Stock in a warehouse can't change while it's being counted, and the UI explains why.
