# 005 — Pharma product fields

## Goal
Store the product information a pharmaceutical wholesaler needs, and enforce the rules that come with it:
- registration and regulatory data
- prescription and controlled flags
- cold-chain storage
- a Khmer name
- retiring products without deleting them

## Data model
```ts
export type DosageForm =
  | 'tablet' | 'capsule' | 'syrup' | 'suspension' | 'injection' | 'cream' | 'ointment'
  | 'drops' | 'inhaler' | 'powder' | 'solution' | 'device' | 'other';
export type Storage = 'ambient' | 'cold';

// Product additions
registrationNo: string;   // drug registration number, '' allowed
manufacturer: string;
dosageForm: DosageForm;
strength: string;         // free text, e.g. "500 mg", "100 IU/ml"
rx: boolean;              // prescription-only
controlled: boolean;      // controlled substance
storage: Storage;
nameKm: string;           // Khmer name, '' allowed
active: boolean;

// Warehouse addition
storage: Storage;
```

## Rules

### Registration
- `registrationNo` is trimmed and uppercased, and unique across products when not empty. Error: `Registration number <no> is already used by <product>.`
- It's optional. A product counts as **"Missing registration"** when `dosageForm` is not `device` or `other` and `registrationNo` is empty. This drives a filter and a warning badge, but doesn't block anything.

### Cold chain
1. Stock of a `storage: 'cold'` product may only **enter** a `storage: 'cold'` warehouse.
   - Enforce it in `moveStock` for **positive** moves (receipt, transfer_in, adjustment add, opening), so receiving, purchase-order receipt, transfers and adjustments are all covered.
   - Error: `<product> must be stored at 2–8°C. Choose a cold-storage warehouse.`
2. Ambient products **may** be stored in cold warehouses.
3. Changing a product from `ambient` to `cold` is blocked while it has stock in any non-cold warehouse. Error: `Move <product> into cold storage before marking it cold-chain.`
4. There's no warehouse edit UI today. Warehouse storage is set in the seed and in migration.

### Active / inactive
- **Inactive products** are hidden from the product pickers for new invoices, purchase orders, receipts and holds (008). Operations reject them: `<product> is inactive.`
- Deactivating is blocked while the product:
  - has stock on hand
  - is on an `Ordered` purchase order or a `Draft` invoice
  - has an active reservation (008)

  Error: `<product> still has stock or open documents.`
- Reactivating is always allowed.
- Products are never deleted.

### Flags
- `rx`: badge only for now. The POS will use it later.
- `controlled`: badge, plus the **Controlled substances register** (below).

## Controlled substances register
```ts
controlledRegister(s, { from, to, productId? }): Array<StockMove & { balanceAfter: number }>
```
- The stock moves (001) of controlled products in the date range, oldest first.
- `balanceAfter` is the running balance **per product and lot**.

## Migration defaults
| Field | Default |
|---|---|
| `registrationNo`, `manufacturer`, `strength`, `nameKm` | `''` |
| `dosageForm` | `'device'` when `unit === 'device'`, otherwise `'other'` |
| `rx`, `controlled` | `false` |
| `active` | `true` |
| `Product.storage` | `'cold'` when the product has stock and **all** of it is in cold warehouses, otherwise `'ambient'` |
| `Warehouse.storage` | `'cold'` when `temperature` contains `2–8`, otherwise `'ambient'` |

## Backup validation
- Valid enum values and booleans.
- Unique non-empty registration numbers.
- No stock of a cold product in an ambient warehouse.

## UI
1. **Product form** — new sections:
   - **Regulatory:** registration no., manufacturer, dosage form, strength, *Prescription only* checkbox, *Controlled substance* checkbox.
   - **Storage:** Ambient (15–25°C) or Cold chain (2–8°C).
   - **Khmer name**.
   - **Active** toggle (edit only). The blocking reason shows inline when it can't be switched off.
2. **Product detail:** show all the new fields. Show the Khmer name under the English name when set.
3. **Inventory table:**
   - Badges next to the name: `Rx`, `CD` (controlled), `❄ Cold`, `Inactive`, `No reg.` (missing registration).
   - New filters: storage, Rx, controlled, missing registration, and *Show inactive* (off by default).
4. **Receive, transfer and purchase forms:** for a cold product, the warehouse select only lists cold warehouses, with the hint *"Cold-chain product — cold storage only"*.
5. **Controlled substances register:** a tab on the **Batches & expiry** page.
   - Date range and product filters.
   - Columns: date, reference, counterparty, lot, in, out, balance.
   - Export CSV.

## Sample data
- Fill `registrationNo` (fake values like `REG-00123`), `manufacturer`, `dosageForm` and `strength` for every medicine. Leave 2 medicines without a registration, so the filter has something to show.
- `rx: true` for the antibiotics (Amoxicillin, Azithromycin, Cefixime) and Salbutamol.
- **Add two products:**
  - *Insulin Glargine 100 IU/ml*: injection, `rx`, `storage: 'cold'`. Receive it into `wh_cold`.
  - *Diazepam 5 mg*: tablet, `rx`, `controlled`. Receive it, and sell it on two invoices so the register has rows.
- Mark one old product as **inactive** with zero stock.
- Leave `nameKm` empty (README: don't invent Khmer).

## Tests
- Receiving or transferring a cold product into an ambient warehouse throws. Into `wh_cold`, it succeeds.
- Switching a product to cold while it has ambient stock throws.
- A duplicate registration number throws, case-insensitively.
- Deactivating a product with stock, or on a draft invoice, throws. With nothing open, it succeeds, and `createInvoice` with it then throws.
- `controlledRegister` returns the Diazepam moves with correct running balances.
- The migration defaults from the table apply to a v1 workspace.

## Acceptance criteria
- [ ] Products carry regulatory, storage, Rx and controlled information, and the inventory list can filter on it.
- [ ] Cold-chain products can't end up in an ambient warehouse by any path.
- [ ] Products can be retired, not deleted, without breaking history.
- [ ] The controlled substances register can be viewed and exported.
