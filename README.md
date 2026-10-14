# Aster Pharmacy Workspace

The original pharmacy workspace, converted into a React application with TypeScript, Vite, and Tailwind CSS. All ten screens and their connected workflows are included.

## Run locally

Use **Node.js 22.12 or newer** (Node 24 recommended).

```sh
npm install
npm run dev
```

Open http://localhost:5173. Build a static production bundle with `npm run build`; preview it with `npm run preview`. Deploy the generated `dist/` directory to any static host. Navigation uses URL hashes, so server-side route rewrites are unnecessary.

On this Windows machine, the default Node executable is version 14. A supported Node 24 installation is available; select it in PowerShell before running npm:

```powershell
$env:Path = 'D:\SDK\Node\nodejs;' + $env:Path
npm run dev
```

## Included workflows

- Dashboard and analytics with reporting periods, charts, inventory health, alerts, and CSV exports.
- Product catalog, batch receipt, expiry tracking, quarantine, stock transfer, and write-offs.
- Product packs and barcodes, mixed-unit invoices and purchases, barcode scanning, and base-unit stock with pack breakdowns.
- Numbered stock adjustments with reasons, partial removal, found stock, full-batch write-offs, and filtered CSV exports.
- Warehouse stock views and movement history.
- Purchase orders, receipt by lot and expiry, cancellation, and supplier payments.
- Invoice drafts, issuing, first-expiry-first-out allocation, partial payments, and printable invoices.
- Balanced double-entry accounting, payables, expenses, profit and loss, trial balance, and ledger export.
- Customer and supplier management, global search (`Ctrl/Cmd+K`), and responsive navigation.
- Company settings, validated JSON backup/restore, sample reset, and an empty-workspace option.

## Project structure

```text
src/
  main.tsx                    React entry point and error boundary
  App.tsx                     Workspace shell and navigation
  types.ts                    Domain and input types
  styles.css                  Tailwind theme and shared component styles
  context/WorkspaceContext.tsx React state, transactions, dialogs, and notifications
  components/                 Shared controls, charts, forms, and dialogs
  pages/                      The ten workspace screens
  lib/model.ts                Typed inventory and accounting rules
  lib/format.ts               Formatting and downloads
  lib/exports.ts              CSV reports
  lib/model.test.ts           Inventory invariants and business-rule tests
tests/workspace.pw.ts          Browser workflow and mobile tests
```

Tailwind provides utility classes in the components and `@apply` styles for shared controls and the existing design. The original `aster-pharmacy.html` is retained as a legacy reference; the React app does not load it.

## Data and backups

Records stay in browser `localStorage` under the original `aster_pharmacy_workspace_v1` key. Workspaces use schema version 2 with an append-only stock ledger. Version 1 data and JSON backups migrate automatically, with opening stock moves dated on the migration day. Browser storage belongs to an origin: if the original HTML ran from a different URL or from `file://`, export its backup and restore it under **Workspace settings → Data & backups**.

This remains a browser demo with local records. It has no server, authentication, or multi-device synchronization. Initial sample data is generated relative to the current date.

## Verification

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

The unit tests check stock and accounting invariants and cover migration, stock history, units of measure, purchase rounding, stock adjustments, allocation, payments, transfers, receiving, expenses, and validation. Browser tests cover every screen, adjustments and full write-offs, packaging and barcode sales, the stock ledger and historical stock, the connected sales and purchasing workflows, backups, mobile navigation, focus handling, and empty/reset flows.

To use an existing Chromium executable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` before running browser tests. For the browser already installed on this machine:

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Users\Panha_sw\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
npm run test:e2e
```
