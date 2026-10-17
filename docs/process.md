# Aster — project process log

**Read this first if you're a new session (Claude or anyone else) picking up this project.** It records what the project is, how we work, every decision made so far, what's done, where we are, and what's next.

Last updated: **2026-10-17**.

---

## 1. The project

**Aster** is an ERP for the user's family business: a **wholesale pharmacy (pharmaceutical distributor) in Phnom Penh, Cambodia**, with about **10 workers**.
- **Customers:** pharmacies, clinics and hospitals.
- **Suppliers:** pharma distributors and labs.
- **What it covers:** warehouse and batch tracking, purchasing, sales, invoicing, accounting and analysis. A separate **POS** is planned for counter sales.

### Agreed architecture (not built yet)
- **One shared backend and database. Two front-ends:**
  - the **React ERP** (this repo): back office for owner, accountant and warehouse
  - a **Flutter POS**: counter sales on Android POS terminals (e.g. Sunmi with built-in printer) or Windows
- **The ERP and POS must not have separate databases.** Sync between them was explicitly rejected.
- **Business rules will move to the server** (planned: Supabase / Postgres functions). React (JS) and Flutter (Dart) can't share code, so the rules must live in one place.
- **For now everything runs client-side:** `localStorage` with generated fake seed data, but with real working operations. `src/lib/model.ts` is written as plain functions over a `Workspace` object, so it can be ported to the server later.
- **The Supabase plugin is installed but not authorized yet.** Authorize it with `/mcp` in an interactive session before doing server work.

### Known future needs (not built)
- **Riel (KHR) and USD at the POS counter**, including mixed-currency payment and change. Wholesale ERP invoices stay **USD only** (decided).
- **Khmer language** on screens and printed documents. Never machine-generate Khmer text in seed data.
- **Real users, logins, roles** (owner, accountant, warehouse, cashier) and an audit log. They come with the server. Until then the code uses a fake `CURRENT_USER = 'Krisstoff'`.

---

## 2. Roles and how we work

| Who | Does what |
|---|---|
| **User** | Product owner. Decides scope. Talks to the family. Runs Codex. Commits to git. |
| **Claude** | Explains concepts, asks the decision questions, **writes the feature specs**, writes the **Codex prompts**, **reviews and verifies** Codex's work, and writes **fix prompts**. |
| **Codex** | **Implements** one spec at a time from the specs and prompts. |

### The workflow (follow it for every module)
1. **Discuss the module** with the user. List its sub-features (same style as inventory and sales).
2. **Ask the decision questions** in plain language, with a recommended option. `AskUserQuestion` with 4 questions per round worked well. Save the answers to memory.
3. **Write the specs** in `docs/features/<module>/`:
   - a `README.md`: ground rules, decisions, numbering, invariants, workspace additions
   - one numbered file per sub-feature: Goal, Data model (TypeScript), Operations with exact rules and error messages, Accounting entries, Migration, Backup validation, UI, Sample data, Tests, Acceptance criteria
   - Ground the specs in the **real code**: read `model.ts`, `types.ts` and the relevant components first.
4. **Give the user one Codex prompt per spec**, in order. Use the template in section 4.
5. **The user commits after each spec.** Remind them; in practice they often batched several specs into one commit.
6. **After a module (or a risky spec), Claude reviews:**
   - run typecheck, unit tests and browser tests
   - read the code against the specs
   - **write throwaway probe tests** (`src/lib/zz-*.test.ts`, deleted afterwards) to confirm suspected bugs before reporting them
   - report the findings, ranked, plus a **fix prompt** for Codex
7. **Re-verify the fixes** by re-running the same probes, then tell the user to commit.

### Communication preferences (important)
- The user wants **plain language and short answers**. They got lost in accounting jargon once ("I have no idea what you're talking about. In short which option?"). Lead with the answer and a recommendation. Explain only if asked.
- Don't re-ask decisions that are already recorded here.
- The user often just says "next". Give the next prompt, but **do a quick state check first** (git log, `npm test`, typecheck), and say clearly when work is uncommitted.

---

## 3. Tech stack, layout, commands

- **Stack:** React 19, TypeScript, Vite, Tailwind 4, Vitest (unit tests), Playwright (browser tests), `lucide-react`.
- **Git:** initialized. The `.gitignore` excludes `node_modules`, `dist`, test output, `.env*`, editor and OS files, and `.claude/settings.local.json`.
- **Key files:**

| Path | What it is |
|---|---|
| `src/lib/model.ts` | **All business rules** (about 6,600 lines), exported as `A`. Includes `migrate()`, `validateBackup()`, `seed()`. |
| `src/lib/model.test.ts` | Unit tests (about 6,500 lines, 279 tests). Has an `assertInvariants()` helper. |
| `tests/workspace.pw.ts` | Browser tests (22). |
| `src/types.ts` | All domain types. |
| `src/context/WorkspaceContext.tsx` | State, `mutate()` (atomic transactions, validates before saving), dialogs, toasts, recovery banner data. |
| `src/pages/*`, `src/components/*` | Screens and components. |
| `aster-pharmacy.html` | The **original single-file HTML version**, kept as a legacy reference. Its parity test was retired. |
| `docs/features/inventory/`, `docs/features/sales/` | Specs, both done. |
| `docs/features/purchase/` | Purchasing specs 001–006 (written 2026-10-17, not implemented yet). |

- **Commands (PowerShell).** The default Node on this machine is v14, which is too old, so put Node 24 on the path first:
  ```powershell
  $env:Path = 'D:\SDK\Node\nodejs;' + $env:Path
  npm run typecheck
  npm test
  $env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Users\Panha_sw\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
  npm run test:e2e
  npm run format
  ```
  In Git Bash: `export PATH="/d/SDK/Node/nodejs:$PATH"`. The browser tests take about 2 minutes, so run them in the background.

---

## 4. Codex prompt template

Every spec prompt followed this shape. Adapt the read-list and the "Rules" bullets to the spec.

```text
Implement <module> spec <NNN> for this project.

Read first, in this order:
1. docs/features/inventory/README.md (base ground rules, invariants I1–I5, definition of done)
2. docs/features/<module>/README.md (module decisions; overrides the inventory README where they differ)
3. docs/features/<module>/<NNN>-<name>.md (what to build)
4. <related earlier specs it builds on>
5. The code it touches: src/lib/model.ts (<functions>), src/types.ts, <components/pages>.

<Specs already implemented>. Build on them: <what to reuse>.

Rules:
- Implement ONLY spec <NNN>. Don't start later specs, even where they're mentioned. <stubs / markers to leave>
- <spec-specific must-dos, e.g. required changes to older code, markers to fill in>
- <for risky migrations: write a test that turns the seed back into the old shape, migrates it,
  and proves every balance / qty / journal is unchanged, BEFORE writing the migration>
- Business rules go in src/lib/model.ts as plain functions exported on `A`. No React/DOM/localStorage in them. The UI changes state only through mutate().
- Follow the spec's data model, function names and error messages exactly. If the spec conflicts with the existing code or is ambiguous, pick the option closest to the spec, keep going, and list it under "Deviations" in your final report. Don't edit the spec files.
- Add new fields to migrate() with defaults, and to validateBackup(). Old v1/v2/v3 backups must still load.
- Reuse existing helpers and components. Add no new dependencies. Match the surrounding code style.

Tests:
- Add every test listed in the spec's Tests section to src/lib/model.test.ts, and call assertInvariants in them.
- Add the browser test the spec describes to tests/workspace.pw.ts.
- All existing tests must keep passing. List any you changed, and why.

Before finishing, run (Node 22+ is required; the default Node on this machine is 14):
  $env:Path = 'D:\SDK\Node\nodejs;' + $env:Path
  npm run typecheck
  npm test
  npm run test:e2e
  npm run format
All must pass. If one fails and you can't fix it, stop and report the failing output. Don't skip or delete tests to make them pass.

Final report:
1. Files changed, one line each.
2. Every acceptance criterion from the spec, ticked or explained.
3. Deviations from the spec, and why.
4. Every existing test you changed, and why.
5. Anything you noticed that a later spec should know about.
```

---

## 5. Review checklist and lessons learned

Run these on every review:
1. `git log` / `git status`: what's committed, and what changed?
2. Typecheck, unit tests and browser tests: all must pass.
3. Read the new `model.ts` functions against the spec: rules, error messages, journal entries.
4. **Check the "can saved data become unloadable?" class of bug.** It has happened **three times**:
   - *Inventory:* the empty-workspace reset forgot `reorderRules`.
   - *Sales:* the contact-type-change guard forgot holds, payments and refunds.
   - *Original HTML:* changing a contact's type broke backups.

   The pattern: `validateBackup()` learns about a new collection, but a save path or a guard doesn't. Whenever a collection is added, check `emptyWorkspace()`, `contactInUse()` and any delete or type-change guard.
5. Check status machines for stuck states: something left in a state no action can leave, such as a `Picking` delivery on a closed order, or a draft referring to a returned delivery.
6. Check that migrations preserve every balance, using the "back to old shape → migrate → compare" test.
7. Probe before claiming a bug. Write a `zz-*.test.ts`, run it with `npx vitest run <file>`, then **delete it**. `console.log` output from the first log line in a test can be hidden by Vitest's formatting; start the message with `\n`.

**Safety nets now in place** (from review fixes):
- `load()` never silently discards data. Unreadable data is copied to `aster_pharmacy_recovery`, and a banner offers it for download.
- `mutate()` runs `validateBackup()` on the new state **before saving**. If it fails, the change is refused with an "Internal check failed" toast.
- `contactInUse()` is the single guard for contact type changes.
- `emptyWorkspace()` lists every collection explicitly.

---

## 6. History (what's been done)

| Step | What | Result |
|---|---|---|
| 1 | Reviewed the original `aster-pharmacy.html` | Found and fixed 6 bugs: contact-type change breaking backups, the expiry window half-wired, form errors in the wrong place, XSS via product unit, prototype-key hash routing, mislabeled weekly chart. |
| 2 | Concept discussion | What an ERP is. Aster's gaps. ERP + POS decision. Flutter POS. Server-side rules. |
| 3 | Codex converted the HTML to React/TS | The repo as it is now. |
| 4 | **Inventory specs 001–008** written by Claude | `docs/features/inventory/` |
| 5 | Codex implemented inventory 001–008 | Commit `194e67b` |
| 6 | Claude reviewed inventory | 5 findings: **data loss** on empty-workspace reset + silent seed fallback in `load()`; deactivation ignoring holds; the count freeze blocking all sales; a misleading short-dated error; wrong unit text. Plus a spec change: sales now skip warehouses being counted. |
| 7 | Codex fixed them, Claude verified | Commit `ce7f660` |
| 8 | Sales decisions with the user (section 8) | Saved to memory |
| 9 | **Sales specs 001–008** written by Claude | Commit `c3e1ded` |
| 10 | Codex implemented sales 001–008 | Commits `0f6cdc2` (001), `8f26d67` (002), and the rest batched |
| 11 | Claude reviewed sales | 4 findings: **unloadable data** via contact type change (holds, payments, refunds missed); "not delivered" allowed on a drafted delivery; cancel-remaining stranding a `Picking` delivery; a mis-encoded "·". Plus a safety net: validate before every save. |
| 12 | Codex fixed them, Claude verified | Commit `d7a2e6c` "Sales 003-008 and review fixes". 279 unit + 22 browser tests pass. |
| 13 | Purchasing decisions with the user (section 10) | Saved to memory (`purchase-spec-decisions.md`) |
| 14 | **Purchasing specs 001–006** written by Claude | `docs/features/purchase/` (not yet committed) |

---

## 7. Inventory module (done)

The specs are in `docs/features/inventory/`. Its README holds the **base ground rules for all modules**: business rules in `model.ts`, `mutate()` only, `migrate()` fills defaults, `CURRENT_USER`, the seed built through operations, invariants **I1–I5**:
- **I1:** batch qty = sum of its stock moves
- **I2:** quantities are integers ≥ 0
- **I3:** the inventory ledger = `inventoryValue`
- **I4:** journal entries balance
- **I5:** a backup round-trips

| # | Feature | Key design decisions |
|---|---|---|
| 001 | Stock movement ledger | Every stock change goes through **`moveStock()`**; a guard test enforces it. Append-only `stockMoves`. `stockAt(date)`. |
| 002 | Units of measure | Base unit + packs (carton = N boxes). Lines store `unit` + `factor`. Batch cost is 2 decimals per base unit. Purchase rounding is posted to the `loss` account. |
| 003 | Stock adjustments | Numbered ADJ-xxxx. Reason codes with a direction rule. Posts to the `loss` account. `disposeBatch` was replaced. |
| 004 | Stock counts | SC-xxxx, blind counts. **Whole-warehouse freeze** while Open. After the review fix, sales skip lots in a warehouse being counted. |
| 005 | Pharma fields | Registration no., dosage form, Rx, controlled, cold-chain storage (enforced in `moveStock`), active flag, controlled register. |
| 006 | Expiry rules and recalls | Minimum shelf life (company + per customer). Short-dated consent. Recalls (RCL-xxxx) block a lot everywhere. Recall trace report. |
| 007 | Reorder levels | Min/max per warehouse. Suggestions rounded up to packs. A one-click prefilled PO. |
| 008 | Reserved stock | Holds + draft-invoice reservations (RSV-xxxx). **Product-level**, not per warehouse. Lazy hold expiry. |

---

## 8. Sales module (done)

The specs are in `docs/features/sales/`. Its README adds invariants **S1–S5** (sale moves match picks; `paid`/`credited` match allocations; receivable = open balances − customer credit; delivered ≤ ordered; one invoice per delivery). `Workspace.version` is now **3**.

### Decisions (the user agreed; don't re-ask)
- **Accounting "Option A", fixed:**
  - **Delivery dispatched:** stock leaves, and cost of goods is posted.
  - **Invoice issued:** receivable and revenue are posted.

  Stock leaves **only** through `dispatchDelivery`. The direct "Issue invoice" (counter sale) creates a pickup delivery + invoice in one transaction.
- **Billing timing:** all habits are supported. Invoice per delivery; monthly (one invoice for many deliveries); pay first (the deposit becomes customer credit and auto-applies at invoicing).
- **Delivery and pickup** both exist. Pickup = a delivery completed on the spot. Only the driver name and received-by are recorded; no routes.
- **Currency:** USD only on invoices.
- **Pricing:** customer-group prices + group discount % + per-customer special prices, per pack unit.
- **Credit limit / overdue / hold:** blocks the sale, but can be overridden with a reason (stored with the user). Restrict to managers when roles exist.
- **Quotations:** included.
- **Short orders:** the remainder stays as a backorder.
- **Returns:** staff choose refund or customer credit. Returned stock goes back to **its original lot in quarantine** (a "quarantined twin" batch).
- **VAT:** keep the simple `taxRate`. A proper VAT invoice comes later, with their accountant.
- **Left out:** promotions, delivery routes, commissions, e-invoicing.

| # | Feature | Notes |
|---|---|---|
| 001 | Customer accounts | Groups, terms, credit limit, hold, billing habit. `creditCheck()` with override. |
| 002 | Price lists | `priceFor()`: customer > group entry > group % > default. Below-cost warning. "Price lists" page. |
| 003 | Sales orders and quotations | SO-xxxx. `reserveOrder()` (source `sales_order`). Backorders. Cancel remaining / cancel. |
| 004 | Picking and delivery | DN-xxxx. Picking → Dispatched → Delivered / Returned. `returnToStock()` into a quarantined twin. **Restructured `issueInvoice`.** Migration v2→v3 created legacy deliveries for old invoices. |
| 005 | Invoicing from deliveries | Delivery drafts (locked lines). "To invoice" list. `deliveredNotInvoiced()` with a "late" rule per billing habit. |
| 006 | Credit notes and returns | CN-xxxx. Return or correction. Credit applied to the invoice first; the remainder refunded or kept as credit. |
| 007 | Customer payments and credit | PAY-xxxx. One payment → many invoices. Deposits. `applyCredit` (oldest first). `refundCredit`. `voidPayment` (bounced cheque). Migrated out of `invoice.payments`. |
| 008 | Statements and aging | Built from **dated events**, so it's correct for any past date. Aging total = receivable ledger (verified). `overdueAmount()` drives the credit check. |

---

## 9. Where we are now (2026-10-17)

- **Inventory and Sales are complete, reviewed, fixed and committed** (`d7a2e6c`).
- **Tests:** typecheck clean, **279 unit tests**, **22 browser tests**, all passing.
- **Not committed:** only this file (`docs/process.md`).
- **Purchasing specs 001–006 are written** in `docs/features/purchase/` (README + 6 specs). Next: the user hands them to Codex one at a time, starting with 001.

---

## 10. What's next

### Roadmap (Claude's recommendation, agreed in principle)
| # | Module | Size | Why this order |
|---|---|---|---|
| **1** | **Purchasing** ← next | Small | Completes the buy → stock → sell cycle. Supplier returns close an inventory gap: recalled stock can currently only be written off. |
| 2 | **Server + users/roles/audit log** | **Big** | The real blocker. Nobody can use the app yet (single browser, no logins). Each module built before it adds to what has to be ported. |
| 3 | Accounting | Medium | Multiple cash and bank accounts (cash drawer, ABA, KHQR), bank reconciliation, month-end close, expense categories, VAT later. Needs roles. |
| 4 | Khmer + riel | Medium, cross-cutting | Screens and print in Khmer; riel at the counter. |
| 5 | POS (Flutter) | Big | Reuses the sales flow (order + delivery + invoice + payment) through the server. |
| 6 | Go-live | Small but essential | Import their real products, customers and opening balances. Train staff. Run in parallel with the old method. |

### Purchasing (specs written, not implemented)
Decisions (the user agreed; don't re-ask), all recorded in `docs/features/purchase/README.md`:
- **Partial receiving:** yes; remainder stays open; staff can close it with a reason. Over-receipt is refused.
- **Price differences:** fixed **at receiving** (actual billed price drives batch cost and the bill). No 3-way matching.
- **The goods receipt (`GRN-xxxx`) is the supplier bill.** `Workspace.version` becomes **4** in 003 (money moves from POs to `receipts`).
- **Supplier returns (`RTS-xxxx`):** credit or refund per return; any lot incl. quarantined twins and recalled lots.
- **Approval:** only above `Settings.poApprovalLimit` (default $2,000; 0 = off). **PO steps:** Draft → Sent.
- **Payments (`SP-xxxx`):** one payment for many bills or per bill; **no prepayments**. Payables aging + supplier statements.
- **Prices:** prefill from the **last price paid**; no supplier price lists. **No landed costs** (local suppliers only).

| # | Spec | Notes |
|---|---|---|
| 001 | Supplier accounts | Terms, lead time, min order (warning only). `lastPurchasePrice`, `purchaseLinePrice`. |
| 002 | PO lifecycle | Draft → Sent, `approvePurchase`, `savePurchase` (re-approval when total rises), print. `Ordered` migrates to `Sent`. |
| 003 | Partial receiving and bills | Rewritten `receivePurchase`, `closeRemaining`, Receipt = bill with `due`. v3→v4 migration with round-trip test. |
| 004 | Supplier returns | `returnToSupplier` (move type `supplier_return`), `recordSupplierRefund`. Invariant P5. |
| 005 | Supplier payments | `paySupplier`, `applySupplierCredit`, `voidSupplierPayment`. `payBill` becomes a wrapper. Invariants P2/P3. |
| 006 | Payables aging | `payablesAging`, `supplierStatement`, `billsDue`, `supplierBalance`. |

After Purchasing: review it (section 2, step 6), then **Server + users/roles/audit log**.

---

## 11. Known limitations and deliberate shortcuts

These are marked in code with `// ponytail:` comments. List them with `/ponytail-debt`.
- `CURRENT_USER` is a fake user until auth exists. **Anyone can override** credit blocks until roles exist.
- A count freezes the whole warehouse (counts must be short / after hours). Sales skip frozen warehouses.
- Reservations are **product-level**, not per warehouse. Reorder suggestions ignore reservations.
- Backorders aren't auto-reserved when stock arrives; staff click "Reserve available stock".
- Price entries don't convert between units (a carton price doesn't imply a box price).
- `mutate()` runs full validation on every save. Make it incremental if it gets slow.
- Recovery banner (inventory review): it can't be dismissed, and a second load failure overwrites the recovery copy. Both are minor.
- VAT is a single `taxRate` per document. No e-invoicing.
- `localStorage` holds about 5 MB. It's fine for the demo, not for production, which is why the server comes next.
- `aster-pharmacy.html` is a legacy reference only.

---

## 12. Memory

Claude's persistent memory for this project lives at `C:\Users\Panha_sw\.claude\projects\d--side-aester\memory\`. It holds `aster-project-context.md` and `sales-spec-decisions.md`. Keep this file and memory consistent. **This file is the full record; memory holds the short version.**
