import { A } from './model';
import { csv } from './format';
import type { Adjustment, Product, StockMove, Unit, Workspace } from '../types';
export function exportAging(state: Workspace, asOf: string) {
  csv(
    `aster-aging-${asOf}.csv`,
    [
      'Customer',
      'Current USD',
      '1–30 USD',
      '31–60 USD',
      '61–90 USD',
      '90+ USD',
      'Credit USD',
      'Total USD',
    ],
    A.agingReport(state, asOf).map((r) => [
      r.customerId ? A.contact(state, r.customerId)?.name : 'Totals',
      r.current,
      r.d1_30,
      r.d31_60,
      r.d61_90,
      r.d90plus,
      r.credit,
      r.total,
    ]),
  );
}
export function exportStatement(
  state: Workspace,
  customerId: string,
  range: { from: string; to: string },
) {
  const statement = A.customerStatement(state, customerId, range);
  csv(
    `aster-statement-${customerId}-${range.from}-${range.to}.csv`,
    ['Date', 'Type', 'Reference', 'Description', 'Debit USD', 'Credit USD', 'Balance USD'],
    [
      [
        range.from,
        'Opening balance',
        '',
        A.contact(state, customerId)?.name,
        '',
        '',
        statement.opening,
      ],
      ...statement.lines.map((l) => [
        l.date,
        l.type,
        l.reference,
        l.description,
        l.debit,
        l.credit,
        l.balance,
      ]),
      [range.to, 'Closing balance', '', '', '', '', statement.closing],
    ],
  );
}
export function exportPrices(state: Workspace, rows: Array<{ product: Product; unit: Unit }>) {
  csv(
    `aster-prices-${A.today()}.csv`,
    [
      'Product',
      'SKU',
      'Unit',
      'Cost',
      'Default price',
      ...state.customerGroups.map((g) => `${g.name} (${g.discountPercent}% off default)`),
    ],
    rows.map(({ product: p, unit }) => [
      p.name,
      p.sku,
      unit,
      A.unitPrice(p, unit, true),
      A.unitPrice(p, unit),
      ...state.customerGroups.map((g) => {
        const resolved = A.groupPriceFor(state, { productId: p.id, unit, groupId: g.id });
        return resolved.source === 'default' ? '' : resolved.price;
      }),
    ]),
  );
}
export function exportRecall(state: Workspace, recallId: string) {
  const recall = state.recalls.find((r) => r.id === recallId)!;
  csv(
    `aster-recall-${recall.number}-${A.today()}.csv`,
    ['Customer', 'Phone', 'Delivery', 'Invoice', 'Date', 'Qty', 'Returned'],
    A.recallTrace(state, recallId).sold.map((row) => [
      row.customerName,
      row.phone,
      row.delivery,
      row.invoice,
      row.date,
      row.qty,
      row.returned,
    ]),
  );
}
export function exportControlledRegister(
  state: Workspace,
  moves: Array<StockMove & { balanceAfter: number }>,
) {
  csv(
    `aster-controlled-register-${A.today()}.csv`,
    ['Date', 'Reference', 'Counterparty', 'Lot', 'In', 'Out', 'Balance'],
    moves.map((m) => [
      m.date,
      m.reference,
      A.contact(state, m.counterpartyId || '')?.name || '—',
      m.lotCode,
      m.qty > 0 ? m.qty : 0,
      m.qty < 0 ? -m.qty : 0,
      m.balanceAfter,
    ]),
  );
}

export function exportAdjustments(state: Workspace, adjustments: Adjustment[] = state.adjustments) {
  csv(
    `aster-adjustments-${A.today()}.csv`,
    ['Number', 'Date', 'Product', 'Lot', 'Warehouse', 'Qty', 'Value USD', 'Reason', 'User'],
    adjustments.map((a) => [
      a.number,
      a.date,
      A.product(state, a.productId)?.name,
      a.lotCode,
      A.warehouse(state, a.warehouseId)?.name,
      a.qty,
      a.value,
      A.adjustmentReasons[a.reason],
      a.user,
    ]),
  );
}

export function exportStockLedger(state: Workspace, moves: StockMove[] = A.movesFor(state)) {
  csv(
    `aster-stock-ledger-${A.today()}.csv`,
    ['Date', 'Reference', 'Product', 'Lot', 'Warehouse', 'Type', 'Qty', 'User'],
    moves.map((m) => [
      m.date,
      m.reference,
      A.product(state, m.productId)?.name,
      m.lotCode,
      A.warehouse(state, m.warehouseId)?.name,
      m.type,
      m.qty,
      m.user,
    ]),
  );
}

export function exportReceipts(state: Workspace) {
  csv(
    `aster-receipts-${A.today()}.csv`,
    [
      'GRN',
      'Date',
      'Supplier',
      'PO Number',
      'Reference',
      'Total USD',
      'Paid USD',
      'Credited USD',
      'Balance USD',
      'Due Date',
      'Status',
    ],
    state.receipts.map((r) => [
      r.number,
      r.date,
      A.contact(state, r.supplierId)?.name || '—',
      r.purchaseId ? state.purchases.find((p) => p.id === r.purchaseId)?.number || '' : '',
      r.reference || '',
      r.total,
      r.paid,
      r.credited,
      A.billBalance(r),
      r.due,
      A.billStatus(r),
    ]),
  );
}

export type ExportType =
  | 'products'
  | 'batches'
  | 'invoices'
  | 'purchases'
  | 'receipts'
  | 'contacts'
  | 'ledger'
  | 'overview'
  | 'analysis';
export function exportData(state: Workspace, type: ExportType, period: number) {
  const name = `aster-${type}-${A.today()}.csv`;
  if (type === 'products')
    csv(
      name,
      [
        'SKU',
        'Product',
        'Generic',
        'Category',
        'Unit',
        'Physical stock',
        'Sellable stock',
        'Default cost USD',
        'Selling price USD',
        'Reorder level',
        'Status',
      ],
      state.products.map((p) => [
        p.sku,
        p.name,
        p.generic,
        p.category,
        p.unit,
        A.onHand(state, p.id),
        A.available(state, p.id),
        p.cost,
        p.price,
        p.reorder,
        A.productStatus(state, p),
      ]),
    );
  if (type === 'batches')
    csv(
      name,
      [
        'Batch',
        'SKU',
        'Product',
        'Warehouse',
        'Quantity',
        'Unit cost USD',
        'Expiry',
        'Received',
        'Status',
      ],
      state.batches.map((b) => [
        b.code,
        A.product(state, b.productId)?.sku,
        A.product(state, b.productId)?.name,
        A.warehouse(state, b.warehouseId)?.name,
        b.qty,
        b.cost,
        b.expiry,
        b.received,
        A.batchStatus(state, b, state.settings.expiryWindow),
      ]),
    );
  if (type === 'invoices')
    csv(
      name,
      [
        'Invoice',
        'Customer',
        'Date',
        'Due',
        'Subtotal USD',
        'Discount USD',
        'Tax USD',
        'Total USD',
        'Paid USD',
        'Credited USD',
        'Outstanding USD',
        'Status',
      ],
      state.invoices.map((i) => [
        i.number,
        A.contact(state, i.customerId)?.name,
        i.date,
        i.due,
        i.subtotal,
        i.discount,
        i.taxAmount,
        i.total,
        i.paid,
        i.credited,
        A.invoiceBalance(i),
        A.invoiceStatus(i),
      ]),
    );
  if (type === 'purchases')
    csv(
      name,
      ['Purchase order', 'Supplier', 'Warehouse', 'Date', 'Expected', 'Total USD', 'Status'],
      state.purchases.map((p) => [
        p.number,
        A.contact(state, p.supplierId)?.name,
        A.warehouse(state, p.warehouseId)?.name,
        p.date,
        p.expected,
        p.total,
        A.purchaseStatus(state, p),
      ]),
    );
  if (type === 'receipts') exportReceipts(state);
  if (type === 'contacts')
    csv(
      name,
      ['Name', 'Type', 'Contact person', 'Email', 'Phone', 'Address'],
      state.contacts.map((c) => [c.name, c.type, c.person, c.email, c.phone, c.address]),
    );
  if (type === 'ledger')
    csv(
      name,
      ['Date', 'Reference', 'Description', 'Account', 'Debit USD', 'Credit USD'],
      [...state.journal]
        .sort((a, b) => a.date.localeCompare(b.date))
        .flatMap((j) =>
          j.entries.map((e) => [
            j.date,
            j.reference,
            j.description,
            A.accounts.find((a) => a.id === e.account)?.name,
            e.debit,
            e.credit,
          ]),
        ),
    );
  if (type === 'overview' || type === 'analysis') {
    const b = A.balances(state, A.shift(-period + 1));
    csv(
      name,
      ['Metric', 'Value', 'Period'],
      [
        ['Sales revenue USD', b.revenue.balance, `Last ${period} days`],
        ['Cost of goods USD', b.cogs.balance, `Last ${period} days`],
        ['Gross profit USD', A.round(b.revenue.balance - b.cogs.balance), `Last ${period} days`],
        ['Operating expenses USD', b.expense.balance, `Last ${period} days`],
        ['Stock write-offs & adjustments USD', b.loss.balance, `Last ${period} days`],
        [
          'Net profit USD',
          A.round(b.revenue.balance - b.cogs.balance - b.expense.balance - b.loss.balance),
          `Last ${period} days`,
        ],
        ['Inventory value USD', A.inventoryValue(state), 'Current'],
        [
          'Low-stock products',
          state.products.filter((p) => A.available(state, p.id) <= p.reorder).length,
          'Current',
        ],
        [
          'Expiry alerts',
          state.batches.filter(
            (b) => b.qty > 0 && A.daysLeft(b.expiry) <= state.settings.expiryWindow,
          ).length,
          `Within ${state.settings.expiryWindow} days`,
        ],
      ],
    );
  }
}
