# Purchasing module — feature specs

Specs for the Purchasing module of the family's wholesale pharmacy ERP. Each numbered file is one feature. Implement them **in order**, because later specs build on earlier ones.

The **inventory and sales specs are finished and are prerequisites.** Read [`../inventory/README.md`](../inventory/README.md) first, then [`../sales/README.md`](../sales/README.md). Their ground rules apply here unchanged, unless this README overrides them. Purchasing deliberately **mirrors the sales side** (orders → receipts → bills → payments → aging), so reuse the sales patterns and helpers wherever they fit.

| # | Spec | Depends on |
|---|---|---|
| 001 | [Supplier accounts](001-supplier-accounts.md) | — |
| 002 | [Purchase order lifecycle](002-purchase-orders.md) | 001 |
| 003 | [Partial receiving and supplier bills](003-receiving.md) | 002 |
| 004 | [Supplier returns](004-supplier-returns.md) | 003 |
| 005 | [Supplier payments and credit](005-supplier-payments.md) | 004 |
| 006 | [Payables aging and supplier statements](006-payables-aging.md) | 005 |

## The purchasing flow
```
Purchase order ─► (Approve if over the limit) ─► Sent ─► Goods receipt(s) ─► Supplier payment
  Draft (002)            (002)                  (002)    GRN = the bill (003)       (005)
                                                         returns ─► Supplier return / credit (004)
Direct "Receive stock" (no PO) = a goods receipt without a purchase order (003).
```

## Today's code (what you're changing)
- `createPurchase` makes a `PO-xxxx` with status `Ordered`. `receivePurchase` receives **every line at once**, posts `inventory` debit / `payable` credit, and sets `Received`. `cancelPurchase` cancels.
- `receiveStock` is a direct receipt (no PO). It pushes a `Receipt` with `paid = total` when paid in cash.
- Supplier bills today = received POs **plus** `receipts`. `payBill` adds to `bill.paid`. `validateBackup` checks payable = Σ (total − paid) over both.
- After 003, **bills live only in `receipts`** (one per goods receipt). `Purchase` no longer holds money.

## Decisions already made (don't re-open them)

### 1. Accounting: when things are posted
| Event | Stock | Journal entry |
|---|---|---|
| **Goods received** (003) | Stock enters (`addBatch`, move type `receipt`) | `inventory` debit at batch cost, `payable` credit at the **actual billed amount**, rounding to `loss` (existing `purchaseEntries`) |
| **Supplier return** (004) | Stock leaves (`moveStock`, new type `supplier_return`) | `payable` debit (credit value), `inventory` credit (batch cost), difference to `loss` |
| **Supplier refund received** (004) | — | `cash` debit, `payable` credit |
| **Supplier payment** (005) | — | `payable` debit, `cash` credit |
| **Payment voided** (005) | — | `cash` debit, `payable` credit |

- **The goods receipt is the supplier bill.** There's no separate bill-entry step. What we owe is recorded when the goods arrive, at the price on the supplier's bill.
- A PO never posts anything. It's a plan.

### 2. Other decisions
| Topic | Decision | Spec |
|---|---|---|
| Supplier accounts | Payment terms, lead time, minimum order value per supplier. Minimum order is a **warning**, not a block. | 001 |
| Supplier prices | No supplier price lists. PO lines prefill with the **last price paid** to that supplier for that product and unit. | 001, 003 |
| PO steps | **Draft → Sent.** Editable until fully received. Print / PDF to send to the supplier. No "Confirmed" step. | 002 |
| Approval | POs over `Settings.poApprovalLimit` (default **$2,000**, `0` = off) must be **approved** before sending. Record who and when. No roles yet; restrict to managers when logins exist. | 002 |
| Partial deliveries | Receive what arrived. The rest stays open on the PO. Staff can **close the remainder** if the supplier won't send it. **Receiving more than ordered is refused**: raise the PO quantity first. | 003 |
| Price differences | Staff enter the **actual billed price** when receiving. Batch cost and the bill use it. The PO keeps its ordered price, and screens show the difference. No 3-way bill matching. | 003 |
| Supplier returns | Damaged, expired, recalled, wrong item. Staff choose **credit** (we owe them less) or **refund** (they pay us back) per return. Any lot can be returned, including quarantined and recalled lots. | 004 |
| Supplier payments | One payment for many bills, or one bill at a time. **No supplier prepayments / deposits.** A payment can't be more than the supplier's open bills. | 005 |
| Landed costs | **None.** Local suppliers only. Freight stays an expense. | — |
| Currency / VAT | USD only. Keep the simple model: no tax on purchase documents, as today. | — |

## Ground rules (in addition to the inventory and sales READMEs)
- **Schema version.** 003 bumps `Workspace.version` to **4**, because a received PO stops being a bill (the money moves to `receipts`). Every other spec only adds fields with defaults in `migrate()`. `migrate()` must accept versions **1, 2, 3 and 4**.
- **Cached numbers must match their source** (same pattern as sales):
  - `receipt.paid` = sum of Posted supplier-payment allocations to it (005)
  - `receipt.credited` = sum of supplier-return allocations to it (004)

  Only the functions named in the specs may change these numbers. Backup validation checks them.
- **Document numbers.** Each new counter starts at 1. Never reuse a number, even after a cancel.

  | Document | Prefix | Counter |
  |---|---|---|
  | Purchase order | `PO-0001` | `counters.purchase` (existing) |
  | Goods receipt (= supplier bill) | `GRN-0001` | `counters.receipt` |
  | Supplier return | `RTS-0001` | `counters.supplierReturn` |
  | Supplier payment | `SP-0001` | `counters.supplierPayment` |

  Don't use `RC-`, `RCL-`, `PAY-`, `CN-`; those are taken.
- **Lessons from earlier reviews (check every spec).** Data became unloadable three times because a new collection was known to `validateBackup()` but not to a save path or guard. Whenever a spec adds a collection or a reference to a contact / product / batch, update **all** of: `emptyWorkspace()`, `seed()`'s initial object, `migrate()` defaults, the `validateBackup()` array list and id sets, `contactInUse()`, `baseUnitLocked()` and any product-in-use / delete guard (grep for `s.purchases` and `s.receipts` to find them).
- **No stuck states.** Every status must have a way out: a Draft can be sent or canceled; a Sent PO can be received, closed or canceled; a bill can be paid, credited or have its payment voided.
- **Pages.** The existing **Purchasing** page (`purchasing`) gets tabs as the specs say: *Purchase orders*, *Receipts & bills* (003), *Returns* (004), *Payments* (005), *Payables aging* (006), plus the existing *Reorder suggestions*. Don't add sidebar entries.

## Workspace additions (all specs together)
| Field | Spec |
|---|---|
| `Contact.leadTimeDays`, `Contact.minOrderValue`; supplier `paymentTermsDays` becomes editable | 001 |
| `Purchase.status` gains `Draft`, `Sent` (`Ordered` migrates to `Sent`); `Purchase.approval`, `.sentAt`, `.sentBy`, `.createdAt`, `.createdBy`, `.cancelReason`; `Settings.poApprovalLimit` | 002 |
| `PurchaseLine` (`id`, `closedQty`); `Receipt` becomes the goods receipt / bill (`number`, `purchaseId`, `lines`, `due`, `credited`, …); `Purchase.paid` removed; `Purchase.closeReason`; `counters.receipt`; `version: 4` | 003 |
| `supplierReturns: SupplierReturn[]`, `counters.supplierReturn`; `MoveType` gains `'supplier_return'`; `supplierRefunds: SupplierRefund[]` | 004 |
| `supplierPayments: SupplierPayment[]`, `counters.supplierPayment` | 005 |
| — (reports only) | 006 |

## Invariants (add to `assertInvariants` in `model.test.ts`)
The inventory checks I1–I5 and sales checks S1–S5 still apply. Add:
- **P1:** every non-legacy receipt line has exactly one `receipt` stock move with `sourceId = receipt.id`, the same batch, and qty = `line.qty × line.factor`.
- **P2:** for every receipt, `paid` = Σ Posted supplier-payment allocations, `credited` = Σ supplier-return allocations, and `0 ≤ total − paid − credited`.
- **P3:** `balances(s).payable.balance` = Σ open bill balances − total supplier credit (004/005).
- **P4:** for every PO line, received qty + `closedQty` ≤ ordered qty.
- **P5:** every supplier return line has exactly one `supplier_return` stock move with `sourceId = return.id`, the same batch, and qty = −(`line.qty × line.factor`).

Add each one in the spec that introduces it (P4 and P1 in 003, P5 in 004, P2 and P3 fully in 005; 003/004 check the parts that exist then).

## Definition of done
Same as the inventory README: typecheck, unit tests, browser tests and format all pass. Old backups (v1, v2, v3) migrate cleanly, with **every balance unchanged**. The seed shows the feature with realistic data.

## Out of scope
- Supplier price lists, contracts, rebates
- Landed costs (freight, customs, duties)
- Supplier prepayments / deposits
- 3-way matching (PO ↔ receipt ↔ separate supplier invoice)
- Purchase VAT / input tax
- Request for quotation (RFQ) to several suppliers
- Emailing POs from the app (staff print / save PDF and send it themselves)
- Real users and roles (approval is recorded, not restricted)
