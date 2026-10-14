# Inventory module — feature specs

Specs for the next round of inventory work. Each numbered file is one feature. Implement them **in order**, because later specs build on earlier ones.

| # | Spec | Depends on |
|---|---|---|
| 001 | [Stock movement ledger](001-stock-movement-ledger.md) | — |
| 002 | [Units of measure](002-units-of-measure.md) | 001 |
| 003 | [Stock adjustments](003-stock-adjustments.md) | 001 |
| 004 | [Stock counts](004-stock-counts.md) | 001, 003 |
| 005 | [Pharma product fields](005-pharma-fields.md) | 001 |
| 006 | [Expiry rules and recalls](006-expiry-rules.md) | 001, 003 |
| 007 | [Reorder levels](007-reorder-levels.md) | 002 |
| 008 | [Reserved stock](008-reserve-stock.md) | 002, 006 |

## Ground rules

### Client-side for now, server-ready in shape
Everything still runs in the browser with `localStorage` and generated sample data. Write business rules **as if they will move to a server unchanged**:

- Rules live in `src/lib/model.ts` as plain functions `(s: Workspace, input) => result`, exported on `A`. No React, DOM or `localStorage` inside them.
- Invalid input throws `Error` with a message a user can read. Use the existing `required()`, `qtyCheck()`, `moneyCheck()` and `dateCheck()`.
- The UI calls operations only through `mutate()` in `WorkspaceContext`. `A.transact` works on a copy, so when an operation throws, nothing is saved. Rely on that, and never split one user action across several `mutate()` calls.
- Types go in `src/types.ts`.

### Quantities and money
- Every stored stock quantity is an **integer in the product's base unit** (see 002). This covers batches, moves, adjustments, counts, reorder rules and reservations.
- Money is rounded to 2 decimals with `round()`. Every journal entry must balance, through `ledger()`.

### Schema version and migration
- 001 bumps `Workspace.version` to `2` and adds one `migrate(raw): Workspace` function.
- `load()` and `validateBackup()` both run `migrate()` before validating, so existing v1 browser data and v1 backup files keep working.
- Every later spec **adds its new fields to `migrate()`, with defaults**. `migrate()` only fills in what's missing, so running it twice changes nothing.
- Keep the `localStorage` key as it is.

### Current user
There's no login yet. Add `export const CURRENT_USER = 'Krisstoff'` in `model.ts` with this comment: `// ponytail: fake user until auth exists; replace with the session user`. Every record that has a `user` / `createdBy` field gets this value.

### Activity feed vs. stock ledger
The existing `activity()` / `Movement` list stays as the human-readable activity feed. From 001 on, the **stock ledger (`stockMoves`) is the source of truth for quantities**. Never compute stock from `movements`.

### Sample data
- Every feature adds realistic fake data to `seed()`, **created by calling the new operations**, not by writing arrays directly. That way the seed exercises the code and stays consistent.
- Don't invent Khmer text. Leave Khmer fields empty in the seed.

### Workspace additions (all specs together)

| Field | Spec |
|---|---|
| `stockMoves: StockMove[]` | 001 |
| `counters.transfer`, `counters.adjustment`, `counters.count`, `counters.recall`, `counters.reservation` | 001, 003, 004, 006, 008 |
| `Product.packs`, `Line.factor` | 002 |
| `adjustments: Adjustment[]` | 003 |
| `stockCounts: StockCount[]` | 004 |
| `Product.registrationNo`, `.manufacturer`, `.dosageForm`, `.strength`, `.rx`, `.controlled`, `.storage`, `.nameKm`, `.active`; `Warehouse.storage` | 005 |
| `Settings.minShelfLifeDays`, `Contact.minShelfLifeDays`, `Invoice.allowShortDated`, `recalls: Recall[]` | 006 |
| `reorderRules: ReorderRule[]` | 007 |
| `reservations: Reservation[]` | 008 |

## Invariants
Add one helper, `assertInvariants(s)`, to `model.test.ts`. Call it after `seed()` and at the end of every new operation test.

- **I1:** for every batch, `batch.qty === sum of stockMoves.qty` for that batch.
- **I2:** every `batch.qty` is an integer ≥ 0.
- **I3:** `balances(s).inventory.balance === inventoryValue(s)`.
- **I4:** every journal entry balances.
- **I5:** `validateBackup(JSON.parse(JSON.stringify(s)))` succeeds.

## Tests
- Unit tests go in `src/lib/model.test.ts` (Vitest). Each spec lists the cases it needs.
- Each feature gets **one** happy-path browser test in `tests/workspace.pw.ts` (Playwright). Don't write a test for every edge case.
- **Retire the HTML parity test** (`preserves the original demo records…`). `aster-pharmacy.html` is the legacy reference, and these features change the seed on purpose. The invariants above replace it.

## UI conventions
- Reuse the existing components in `src/components/ui.tsx`: `DataTable`, `Metric`, `Badge`, `Field`, `SelectField`, `Callout`, `FormFooter`, `Summary`, `Empty`.
- New dialogs go in `DialogKind` (`WorkspaceContext.tsx`) and `DialogContents` (`Dialogs.tsx`).
- New statuses (`Recalled`, `Short-dated`, `Reserved`, `Over-reserved`, `Open`, `Posted`, `Closed`, `Released`, `Fulfilled`, plus the 005 badges `Rx`, `CD`, `Cold`, `Inactive`, `No reg.`) need a colour in the `Badge` mapping in `ui.tsx`.
- CSV exports go in `src/lib/exports.ts`, using the existing pattern.

## Definition of done (every spec)
1. `npm run typecheck`, `npm test` and `npm run test:e2e` pass.
2. `migrate()` upgrades the current seed, saved as a v1 backup, without errors, and invariants I1–I5 hold afterwards.
3. The seed shows the feature with realistic data.
4. Run `npm run format`.

## Out of scope for this module
- Sales orders. 008 reserves stock against draft invoices and manual holds instead.
- Supplier returns.
- Real users and roles.
- A server.
