# Sales module — feature specs

Specs for the Sales module of the family's wholesale pharmacy ERP. Each numbered file is one feature. Implement them **in order**, because later specs build on earlier ones.

The **inventory specs are finished and are a prerequisite.** Read [`../inventory/README.md`](../inventory/README.md) first. Its ground rules apply here unchanged, unless this README overrides them.

| # | Spec | Depends on |
|---|---|---|
| 001 | [Customer accounts](001-customer-accounts.md) | — |
| 002 | [Price lists](002-price-lists.md) | 001 |
| 003 | [Sales orders and quotations](003-sales-orders.md) | 001, 002 |
| 004 | [Picking and delivery](004-picking-delivery.md) | 003 |
| 005 | [Invoicing from deliveries](005-invoicing.md) | 004 |
| 006 | [Credit notes and returns](006-credit-notes-returns.md) | 005 |
| 007 | [Customer payments and credit](007-customer-payments.md) | 006 |
| 008 | [Statements and aging](008-statements-aging.md) | 001, 007 |

## The sales flow
```
Quotation ─► Sales order ─► Delivery (pick → dispatch → delivered) ─► Invoice ─► Payment
 (003)         (003)          (004)                                    (005)      (007)
                                                     returns / corrections ─► Credit note (006)
Counter sale / pickup = order + delivery + invoice in one step (the existing "Issue invoice").
```

## Decisions already made (don't re-open them)

### 1. Accounting: when things are posted
| Event | Stock | Journal entry |
|---|---|---|
| **Delivery dispatched** (004) | Stock leaves the shelf (`moveStock`, type `sale`) | `cogs` debit, `inventory` credit, at batch cost |
| **Invoice issued** (005) | — | `receivable` debit; `revenue` credit (net of discount); `tax` credit |

- This is fixed, not a setting.
- **Stock only ever leaves through a delivery.** The direct "Issue invoice" (counter sale) creates a delivery and an invoice in one transaction.
- A **"Delivered, not invoiced"** report (005) catches deliveries that haven't been billed yet.

### 2. Other decisions
| Topic | Decision | Spec |
|---|---|---|
| Fulfilment | Both **delivery** (driver) and **pickup**. Pickup = a delivery completed on the spot. No routes or vehicles. | 004 |
| Billing timing | All habits work: invoice per delivery, invoice several deliveries at once (monthly billing), or pay first (the payment is kept as customer credit and applied automatically when the invoice is issued). | 001, 005, 007 |
| Currency | **USD only.** Riel is for the POS later, not here. | all |
| Pricing | Price per **customer group**, plus optional **special prices per customer**, per pack | 002 |
| Credit limit / overdue | New orders are **blocked**, but can be overridden with a reason. Record who overrode it. There are no roles yet; restrict the override to managers when logins exist. | 001, 003 |
| Quotations | Included | 003 |
| Short orders | The undelivered remainder stays on the order as a **backorder**. Staff may cancel it explicitly. | 003, 004 |
| Returns | Staff choose **refund or customer credit** per return. Returned stock goes back to **its original lot in quarantine**, then gets released or written off with the existing inventory tools. | 006 |
| VAT | Keep the existing single `taxRate` per document. Proper VAT invoices come later, with the accountant. | — |

## Ground rules (in addition to the inventory README)
- **Schema version.** 004 bumps `Workspace.version` to **3**, because the meaning of an issued invoice changes: stock and cost move to deliveries. Every other spec only adds fields with defaults in `migrate()`, as before. `migrate()` must still accept versions 1, 2 and 3.
- **Cached numbers must match their source.** Inventory keeps `batch.qty` equal to the sum of its stock moves. Sales follows the same pattern:
  - `invoice.paid` = sum of payment allocations to it
  - `invoice.credited` = sum of credit-note allocations to it

  Only the functions named in the specs may change these numbers. Backup validation checks them.
- **Document numbers.** Each counter starts at 1. Never reuse a number, even after a delete or cancel.

  | Document | Prefix | Counter |
  |---|---|---|
  | Sales order / quotation | `SO-0001` | `counters.order` |
  | Delivery note | `DN-0001` | `counters.delivery` |
  | Credit note | `CN-0001` | `counters.creditNote` |
  | Customer payment | `PAY-0001` | `counters.payment` |

  Don't use `RC-` or `RCL-`; those are already taken by lot codes and recalls.
- **New pages.** Add a **SALES** section to the sidebar with **Orders** (`orders`), **Deliveries** (`deliveries`), **Invoices** (existing) and **Price lists** (`pricing`). Update `Page`, `pageNames` and the navigation.

## Workspace additions (all specs together)
| Field | Spec |
|---|---|
| `customerGroups`, `Contact.groupId`, `.paymentTermsDays`, `.creditLimit`, `.onHold`, `.holdReason`, `.billing`; `Settings.defaultPaymentTermsDays`, `.overdueGraceDays` | 001 |
| `prices: PriceEntry[]`, `CustomerGroup.discountPercent` | 002 |
| `orders: SalesOrder[]`, `counters.order`; `Reservation.source` gains `'sales_order'` | 003 |
| `deliveries: Delivery[]`, `counters.delivery`, `Invoice.deliveryIds`, `Delivery.invoiceId`; `MoveType` gains `'return'`; `Invoice.allocations` / `Invoice.cogs` move to deliveries | 004 |
| `Invoice.orderId` | 005 |
| `creditNotes: CreditNote[]`, `counters.creditNote`, `Invoice.credited` | 006 |
| `payments: CustomerPayment[]`, `refunds: Refund[]`, `counters.payment`; `Invoice.payments` moves to `payments` | 007 |
| `CustomerPayment.voidedAllocations` | 008 |

## Invariants (add to `assertInvariants` in `model.test.ts`)
The inventory checks I1–I5 still apply. Add:
- **S1:** every non-legacy delivery that has been dispatched has exactly one `sale` stock move per pick, with the same batch and qty.
- **S2:** for every invoice, `paid` = sum of its payment allocations, `credited` = sum of its credit-note allocations, and `0 ≤ total − paid − credited`.
- **S3:** `balances(s).receivable.balance` = sum of open invoice balances − total customer credit (007).
- **S4:** for every order line, delivered qty ≤ ordered qty − cancelled qty.
- **S5:** every delivery is on at most one invoice. Every invoice line comes from either its deliveries or a direct sale.

## Definition of done
Same as the inventory README: typecheck, unit tests, browser tests and format all pass. Old backups (v1, v2) migrate cleanly. The seed shows the feature with realistic data.

## Out of scope
- Promotions and volume discounts
- Delivery routes and vehicles
- Sales commissions
- VAT and e-invoicing
- Riel on invoices
- Customer portal
- The POS. It will reuse 003–007 through the backend later.
