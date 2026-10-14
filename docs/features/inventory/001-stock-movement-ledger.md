# 001 — Stock movement ledger

## Goal
Record every change to a batch quantity as a permanent **stock move**, so the system can answer:
- How much of a product or lot did we have on a given date?
- Who changed a quantity, when, and why?
- Where did each lot go, and to which customers? (006 builds recalls on this.)

## Current state
`batch.qty` is changed in place in five spots in `src/lib/model.ts`, and no history is kept:

| Function | Mutation |
|---|---|
| `addBatch` | `existing.qty += qty`, or a new batch pushed with `qty` |
| `transferStock` | `target.qty += qty`, `batch.qty -= qty`, or a new batch pushed |
| `disposeBatch` | `b.qty = 0` |
| `issueInvoice` | `b.qty -= take` |

`Movement` / `activity()` is display text only and can't be queried.

## Data model (`src/types.ts`)
```ts
export type MoveType =
  | 'opening'      // stock that existed before the ledger (seed or v1 migration)
  | 'receipt'      // direct receipt or purchase-order receipt
  | 'sale'         // invoice issue
  | 'transfer_out'
  | 'transfer_in'
  | 'adjustment';  // write-offs, damages, count differences (003, 004)

export interface StockMove {
  id: string;              // uid('sm')
  date: string;            // business date YYYY-MM-DD (invoice date, receipt date, today…)
  at: string;              // ISO timestamp when recorded
  batchId: string;
  productId: string;       // copied from the batch for fast filtering
  warehouseId: string;     // the batch's warehouse at the time
  lotCode: string;         // copied from the batch
  qty: number;             // signed integer in base units: + in, − out, never 0
  unitCost: number;        // batch.cost at the time
  type: MoveType;
  reference: string;       // INV-1024, PO-0208, TR-0001, ADJ-0001, SC-0001, or the lot code for direct receipts
  sourceId?: string;       // id of the invoice / purchase / transfer / adjustment / count
  counterpartyId?: string; // customer for sales, supplier for receipts
  reason?: string;
  user: string;            // CURRENT_USER
}
```
- `Workspace.stockMoves: StockMove[]`. It's **append-only**: add with `push`, in chronological order. Never edit or delete a move.
- `Workspace.counters.transfer: number`, starting at 1. Transfers get the reference `TR-0001`.
- `Workspace.version` becomes `2` (see README, *Schema version and migration*).

## Operations (`src/lib/model.ts`)

### `moveStock(s, batch, qty, meta)`: the only way to change stock
```ts
function moveStock(
  s: Workspace,
  batch: Batch,
  qty: number,
  meta: { type: MoveType; date: string; reference: string; sourceId?: string; counterpartyId?: string; reason?: string },
): StockMove
```
- `qty` must be a non-zero safe integer.
- If `batch.qty + qty < 0`, throw `Not enough stock in lot <code> (<available> available).`
- Apply `batch.qty += qty`, then push the move.
- **No other code may write `batch.qty`.** Later specs add their checks here (004 count freeze, 005 cold chain, 006 recalls), so every path is covered once.

### Rewire the existing operations
| Function | Change |
|---|---|
| `addBatch` | Create new batches with `qty: 0`, then `moveStock(+qty)`. Add options `{ moveType?: 'opening' \| 'receipt' (default 'receipt'), date?, reference?, sourceId?, counterpartyId? }`. |
| `receiveStock` | type `receipt`, date `today()`, reference `data.reference \|\| code`, counterparty = supplier |
| `receivePurchase` | type `receipt`, date = receipt date, reference `po.number`, sourceId `po.id`, counterparty = supplier |
| `transferStock` | Reference `TR-xxxx` from `counters.transfer`. One `transfer_out` move on the source batch and one `transfer_in` move on the target batch. Both share the reference and sourceId, and their quantities sum to 0. A new target batch starts at `qty: 0`. |
| `disposeBatch` | type `adjustment`, `reason` = the write-off reason. 003 replaces this function. |
| `issueInvoice` | One `sale` move per allocation: date `inv.date`, reference `inv.number`, sourceId `inv.id`, counterparty = customer |
| `seed()` initial batches | Use `moveType: 'opening'` with date = the batch's `received` date |

Keep calling `activity()` exactly as today.

### Queries
```ts
stockAt(s, { date, productId?, warehouseId?, batchId? }): number  // sum of moves with move.date <= date
movesFor(s, { productId?, warehouseId?, batchId?, lotCode?, type?, from?, to? }): StockMove[]
```
**Known limit:** `stockAt` uses the business date. A backdated invoice can make a past balance negative for a day. Show it as it is, and don't try to correct it.

## Migration (v1 → v2)
In `migrate()`:
- If `stockMoves` is missing, create one `opening` move for each batch with `qty > 0`, using:
  - date = today
  - reference `MIGRATION`
  - user `system`
- Batches with `qty === 0` get no move.
- Set `counters.transfer = 1` if it's missing, and set `version = 2`.

## Backup validation
- `stockMoves` is an array.
- Every move references a known batch, product and warehouse.
- Every `qty` is a non-zero integer and every `date` is valid.
- **I1** holds for every batch.

## UI
1. **Batch detail drawer** (`BatchDetail` in `details.tsx`): add a **Movement history** section. Columns: date, type, reference, qty (green +, red −), balance after, user. Newest first.
2. **Warehouses page:** replace the current *Stock movement* panel, which shows activity text, with a **Stock ledger** table backed by `movesFor`.
   - Filters: product search, warehouse, type, date from/to.
   - Columns: date, reference, product, lot, warehouse, type, qty, user.
   - Paginated with `DataTable`.
   - **Export CSV** (`exports.ts`).
3. **Inventory page:** add an **As of date** filter, empty by default. When it's set, the stock column shows `stockAt(...)` for that date, and a callout says *"Showing stock as of 12 Mar 2026"*.
4. **Product detail drawer:** add a **View stock history** link that opens the Warehouses page with the ledger filtered to that product.

## Tests (`model.test.ts`)
- After `seed()`, I1 holds and every batch with stock has at least one move.
- Receiving creates a `receipt` move with the right counterparty and reference.
- Issuing an invoice creates `sale` moves that exactly match `invoice.allocations` (batch and qty).
- A transfer creates two moves with the same reference whose quantities sum to 0.
- `stockAt` returns 0 the day before a receipt and the received quantity on the receipt date.
- `moveStock` rejects going below zero, and the workspace is unchanged after a failed `transact`.
- Migration: a v1 workspace (the seed with `stockMoves` deleted and `version: 1`) migrates, gets opening moves, and passes `validateBackup`.
- **Guard test:** read `src/lib/model.ts` as text and assert that `.qty +=`, `.qty -=` and `.qty =` on batches appear only inside `moveStock`.

## Acceptance criteria
- [ ] Every stock change in the app appears in the stock ledger, with its user and reference.
- [ ] Batch detail shows the full history of the lot.
- [ ] The Inventory page can show stock as of a past date.
- [ ] Old v1 data and backups still load.
