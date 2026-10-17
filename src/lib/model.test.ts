import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { A, CURRENT_USER } from './model';
import type { AdjustmentInput, CreditNoteInput, OrderInput, PackInput, Workspace } from '../types';

describe('statements and aging', () => {
  function setup() {
    const data = stocked();
    const invoice = (date: string, due: string, price = 10, qty = 1) => {
      const i = A.createInvoice(data.s, {
        customerId: data.customer.id,
        date,
        due,
        taxRate: 0,
        lines: [{ productId: data.p.id, qty, price }],
      });
      A.issueInvoice(data.s, i.id, { reason: 'Historical account reconciliation' });
      return i;
    };
    const row = (asOf = A.today()) =>
      A.agingReport(data.s, asOf).find((r) => r.customerId === data.customer.id)!;
    return { ...data, invoice, row };
  }
  it('ages only open amounts into every bucket, including exact due and bucket boundaries', () => {
    const { s, customer, invoice, row } = setup();
    for (const days of [-10, 0, 10, 30, 31, 45, 60, 61, 75, 90, 91, 120])
      invoice(A.shift(-180), A.shift(-days));
    A.recordPayment(s, { customerId: customer.id, date: A.today(), amount: 4, method: 'Cash' });
    expect(row()).toEqual({
      customerId: customer.id,
      current: 20,
      d1_30: 20,
      d31_60: 30,
      d61_90: 30,
      d90plus: 16,
      credit: 0,
      total: 116,
    });
    expect(A.agingReport(s).at(-1)).toEqual({ ...row(), customerId: '' });
    assertInvariants(s);
  });
  it('ignores later payments and includes allocations of payments voided after the reporting date', () => {
    const { s, customer, invoice, row } = setup();
    const i = invoice(A.shift(-150), A.shift(-130), 100);
    const p = A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-100),
      amount: 40,
      method: 'Cheque',
      allocations: [{ invoiceId: i.id, amount: 40 }],
    });
    const allocations = structuredClone(p.allocations);
    A.voidPayment(s, p.id, 'Cheque returned unpaid', A.shift(-30));
    expect(p.voidedAllocations).toEqual(allocations);
    expect(p.voidedAllocations[0]).not.toBe(allocations[0]);
    expect(p.allocations).toEqual([]);
    A.payInvoice(s, i.id, 20, 'Cash', A.shift(-10));
    expect(row(A.shift(-120)).d1_30).toBe(100);
    expect(row(A.shift(-60))).toMatchObject({ d61_90: 60, credit: 0, total: 60 });
    expect(row(A.shift(-30))).toMatchObject({ d90plus: 100, credit: 0, total: 100 });
    expect(row()).toMatchObject({ d90plus: 80, credit: 0, total: 80 });
    assertInvariants(s);
  });
  it('uses allocation dates for deposits and credit notes, and refund dates instead of refunded caches', () => {
    const { s, customer, invoice, row } = setup();
    const original = invoice(A.shift(-150), A.shift(-130), 100);
    A.payInvoice(s, original.id, 100, 'Cash', A.shift(-140));
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: original.id,
        kind: 'correction',
        reason: 'price_error',
        settlement: 'credit',
        date: A.shift(-120),
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 40 }],
      }).id,
    );
    const target = invoice(A.shift(-100), A.shift(-90), 100);
    // Automatic application is dated today; remove it to choose the business allocation date.
    A.removeAllocation(s, { source: 'credit_note', id: cn.id, invoiceId: target.id });
    A.applyCredit(s, {
      customerId: customer.id,
      invoiceId: target.id,
      amount: 20,
      date: A.shift(-50),
    });
    A.refundCredit(s, { customerId: customer.id, amount: 20, method: 'Cash', date: A.shift(-20) });
    const deposit = A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-80),
      amount: 30,
      method: 'Cash',
      allocations: [],
    });
    A.applyCredit(s, {
      customerId: customer.id,
      invoiceId: target.id,
      amount: 30,
      date: A.shift(-10),
    });
    expect(row(A.shift(-60))).toMatchObject({ d1_30: 100, credit: 70, total: 30 });
    expect(row(A.shift(-30))).toMatchObject({ d31_60: 80, credit: 50, total: 30 });
    expect(row()).toMatchObject({ d61_90: 50, credit: 0, total: 50 });
    expect(deposit.allocations[0].date).toBe(A.shift(-10));
    assertInvariants(s);
  });
  it.each([0, -60])(
    'reconciles aging to the receivable ledger and statements at day offset %i',
    (offset) => {
      const s = A.seed(),
        asOf = A.shift(offset);
      const rows = A.agingReport(s, asOf),
        customers = rows.filter((r) => r.customerId);
      expect(A.sum(customers, (r) => r.total)).toBe(A.balances(s, '', asOf).receivable.balance);
      expect(rows.at(-1)!.total).toBe(A.balances(s, '', asOf).receivable.balance);
      for (const c of s.contacts.filter((c) => c.type === 'Customer')) {
        const statement = A.customerStatement(s, c.id, { from: A.shift(-30, asOf), to: asOf });
        expect(A.round(statement.opening + A.sum(statement.lines, (l) => l.debit - l.credit))).toBe(
          statement.closing,
        );
        expect(statement.closing).toBe(statement.aging.total);
        expect(statement.aging.total).toBe(
          customers.find((r) => r.customerId === c.id)?.total ?? 0,
        );
        let running = statement.opening;
        for (const l of statement.lines) {
          running = A.round(running + l.debit - l.credit);
          expect(l.balance).toBe(running);
        }
      }
      assertInvariants(s);
    },
  );
  it.each([0, -60])(
    'shows every dated event once, with its sign, opening and inclusive range at offset %i',
    (offset) => {
      const { s, customer, invoice, row } = setup(),
        to = A.shift(offset),
        from = A.shift(-30, to);
      invoice(A.shift(-40, to), A.shift(-10, to), 10);
      const i = invoice(from, A.shift(10, to), 100);
      const p = A.recordPayment(s, {
        customerId: customer.id,
        date: from,
        amount: 120,
        method: 'Bank transfer',
        allocations: [{ invoiceId: i.id, amount: 100 }],
      });
      const cn = A.issueCreditNote(
        s,
        A.saveCreditNote(s, {
          invoiceId: i.id,
          date: from,
          kind: 'correction',
          reason: 'price_error',
          settlement: 'credit',
          lines: [{ invoiceLineIndex: 0, qty: 1, price: 40 }],
        }).id,
      );
      A.refundCredit(s, { customerId: customer.id, amount: 20, method: 'Cash', date: from });
      const bounced = A.recordPayment(s, {
        customerId: customer.id,
        date: A.shift(-1, to),
        amount: 5,
        method: 'Cheque',
        allocations: [],
      });
      A.voidPayment(s, bounced.id, 'Bounced cheque', to);
      A.recordPayment(s, {
        customerId: customer.id,
        date: to,
        amount: 3,
        method: 'Cash',
        allocations: [],
      });
      const statement = A.customerStatement(s, customer.id, { from, to });
      expect(statement.opening).toBe(10);
      expect(statement.lines.slice(0, 4).map((l) => l.type)).toEqual([
        'Invoice',
        'Credit note',
        'Payment',
        'Refund',
      ]);
      for (const [type, reference, debit, credit] of [
        ['Invoice', i.number, 100, 0],
        ['Credit note', cn.number, 0, 40],
        ['Payment', p.number, 0, 120],
        ['Refund', cn.number, 20, 0],
        ['Payment voided', bounced.number, 5, 0],
      ] as const) {
        const lines = statement.lines.filter((l) => l.type === type && l.reference === reference);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ debit, credit });
      }
      expect(statement.lines.at(-1)!.date).toBe(to);
      expect(statement.closing).toBe(-33);
      expect(A.round(statement.opening + A.sum(statement.lines, (l) => l.debit - l.credit))).toBe(
        -33,
      );
      expect(statement.aging).toEqual(row(to));
      expect(statement.closing).toBe(A.balances(s, '', to).receivable.balance);
      assertInvariants(s);
    },
  );
  it('shows an unallocated deposit as credit and ignores current cached paid, credited and refunded values', () => {
    const { s, customer, invoice, row } = setup();
    invoice(A.shift(-90), A.shift(-60), 10);
    A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-70),
      amount: 30,
      method: 'Cash',
      allocations: [],
    });
    const statement = A.customerStatement(s, customer.id, { from: A.shift(-80), to: A.shift(-60) });
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]).toMatchObject({
      type: 'Payment',
      debit: 0,
      credit: 30,
      balance: -20,
    });
    expect(row(A.shift(-60))).toMatchObject({ current: 10, credit: 30, total: -20 });
    const copy = structuredClone(s);
    copy.invoices.forEach((i) => {
      i.paid = 999;
      i.credited = 999;
    });
    copy.payments.forEach((p) => {
      p.refunded = 999;
    });
    expect(A.agingReport(copy, A.shift(-60))).toEqual(A.agingReport(s, A.shift(-60)));
    expect(
      A.customerStatement(copy, customer.id, { from: A.shift(-80), to: A.shift(-60) }),
    ).toEqual(statement);
    assertInvariants(s);
  });
  it.each([0, 7])('shares the credit-check overdue boundary with grace %i', (grace) => {
    const { s, customer, invoice } = setup();
    invoice(A.shift(-40), A.shift(-grace), 10);
    const old = invoice(A.shift(-40), A.shift(-grace - 1), 20);
    A.payInvoice(s, old.id, 5, 'Cash');
    A.setAccountSettings(s, { defaultPaymentTermsDays: 30, overdueGraceDays: grace });
    expect(A.overdueAmount(s, customer.id, grace)).toBe(15);
    expect(A.creditCheck(s, customer.id, 0).overdue).toBe(15);
    expect(A.creditCheck(s, customer.id, 0).reasons).toContain(
      `$15.00 is overdue by more than ${grace} days.`,
    );
    assertInvariants(s);
  });
  it.each([1, 2, 3])(
    'defaults missing void history idempotently in version %i backups',
    (version) => {
      const { s, customer, invoice } = setup();
      const i = invoice(A.shift(-150), A.shift(-120), 100);
      const payment = A.payInvoice(s, i.id, 40, 'Cheque', A.shift(-100));
      A.voidPayment(s, payment.id, 'Unpaid cheque', A.shift(-30));
      const raw = version < 3 ? legacyBackup(s) : JSON.parse(JSON.stringify(s));
      raw.version = version;
      raw.payments.forEach((p: { voidedAllocations?: unknown }) => delete p.voidedAllocations);
      const migrated = A.validateBackup(raw);
      expect(
        migrated.payments.every(
          (p) => Array.isArray(p.voidedAllocations) && !p.voidedAllocations.length,
        ),
      ).toBe(true);
      expect(
        A.agingReport(migrated, A.shift(-60)).find((r) => r.customerId === customer.id),
      ).toMatchObject({ d31_60: 100, credit: 40, total: 60 });
      expect(A.migrate(structuredClone(migrated))).toEqual(migrated);
      assertInvariants(migrated);
    },
  );
  it('validates historical allocation fields, customer links, amount caps and posted payment history', () => {
    const { s, customer, invoice } = setup();
    const i = invoice(A.shift(-90), A.shift(-60));
    const p = A.payInvoice(s, i.id, 4, 'Cheque', A.shift(-80));
    A.voidPayment(s, p.id, 'Unpaid cheque', A.shift(-20));
    for (const change of [
      (copy: Workspace) => {
        copy.payments[0].voidedAllocations = null as never;
      },
      (copy: Workspace) => {
        copy.payments[0].voidedAllocations[0].date = 'invalid';
      },
      (copy: Workspace) => {
        copy.payments[0].voidedAllocations[0].invoiceId = 'missing';
      },
      (copy: Workspace) => {
        copy.payments[0].voidedAllocations[0].amount = 5;
      },
      (copy: Workspace) => {
        copy.payments[0].voidedAllocations[0].amount = -1;
      },
    ]) {
      const copy = structuredClone(s);
      change(copy);
      expect(() => A.validateBackup(copy)).toThrow();
    }
    const posted = A.recordPayment(s, {
      customerId: customer.id,
      date: A.today(),
      amount: 1,
      method: 'Cash',
      allocations: [],
    });
    const copy = structuredClone(s);
    copy.payments.find((entry) => entry.id === posted.id)!.voidedAllocations = [
      { invoiceId: i.id, amount: 1, date: A.today() },
    ];
    expect(() => A.validateBackup(copy)).toThrow('Posted payments cannot have void details.');
    assertInvariants(s);
  });
  it('omits zero rows, validates report inputs, and seeds every bucket plus unapplied credit', () => {
    const { s, customer } = setup();
    expect(A.agingReport(s)).toEqual([
      {
        customerId: '',
        current: 0,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        d90plus: 0,
        credit: 0,
        total: 0,
      },
    ]);
    expect(() => A.agingReport(s, '2026-02-30')).toThrow('Enter a valid date.');
    expect(() => A.overdueAmount(s, customer.id, 0, 'bad')).toThrow('Enter a valid date.');
    expect(() => A.customerStatement(s, 'missing', { from: A.shift(-1), to: A.today() })).toThrow(
      'Select a customer.',
    );
    expect(() => A.customerStatement(s, customer.id, { from: A.today(), to: A.shift(-1) })).toThrow(
      'Statement end date cannot be before its start date.',
    );
    const seed = A.seed(),
      totals = A.agingReport(seed).at(-1)!;
    for (const key of ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'credit'] as const)
      expect(totals[key]).toBeGreaterThan(0);
    assertInvariants(s);
    assertInvariants(seed);
  });
});

function assertInvariants(s: Workspace) {
  s.batches.forEach((b) => {
    expect(b.qty).toBe(A.movesFor(s, { batchId: b.id }).reduce((n, m) => n + m.qty, 0));
    expect(Number.isInteger(b.qty) && b.qty >= 0).toBe(true);
  });
  expect(A.balances(s).inventory.balance).toBe(A.inventoryValue(s));
  s.journal.forEach((j) => {
    expect(A.sum(j.entries, (e) => e.debit)).toBe(A.sum(j.entries, (e) => e.credit));
  });
  s.deliveries
    .filter((d) => !d.legacy && ['Dispatched', 'Delivered', 'Returned'].includes(d.status))
    .forEach((d) => {
      const sales = s.stockMoves.filter((m) => m.type === 'sale' && m.sourceId === d.id);
      const picks = d.lines.flatMap((l) => l.picks);
      expect(sales.map((m) => [m.batchId, -m.qty])).toEqual(picks.map((p) => [p.batchId, p.qty]));
      expect(sales.every((m) => m.reference === d.number)).toBe(true);
      if (d.status === 'Returned')
        expect(
          A.sum(
            s.stockMoves.filter((m) => m.type === 'return' && m.sourceId === d.id),
            (m) => m.qty,
          ),
        ).toBe(A.sum(picks, (p) => p.qty));
    });
  s.deliveries.forEach((d) => {
    const invoices = s.invoices.filter((i) => i.deliveryIds.includes(d.id));
    expect(invoices.length).toBeLessThanOrEqual(1);
    expect(invoices.find((i) => i.status === 'Issued')?.id).toBe(d.invoiceId);
  });
  s.invoices.forEach((i) => {
    expect(i.paid).toBe(
      A.sum(
        s.payments.filter((p) => p.status === 'Posted'),
        (p) =>
          A.sum(
            p.allocations.filter((a) => a.invoiceId === i.id),
            (a) => a.amount,
          ),
      ),
    );
    expect(i.credited).toBe(
      A.sum(
        s.creditNotes.filter((cn) => cn.status === 'Issued'),
        (cn) =>
          A.sum(
            cn.allocations.filter((a) => a.invoiceId === i.id),
            (a) => a.amount,
          ),
      ),
    );
    expect(A.round(i.total - i.paid - i.credited)).toBeGreaterThanOrEqual(0);
    if (i.deliveryIds.length) {
      const lines = A.deliveriesOf(s, i).flatMap((d) =>
        d.lines.map(({ productId, name, sku, unit, factor, qty, price }) => ({
          productId,
          name,
          sku,
          unit,
          factor,
          qty,
          price,
        })),
      );
      expect(i.lines).toEqual(lines);
    }
  });
  expect(A.balances(s).receivable.balance).toBe(
    A.round(
      A.sum(s.invoices, A.invoiceBalance) -
        A.sum(
          s.contacts.filter((c) => c.type === 'Customer'),
          (c) => A.customerCredit(s, c.id),
        ),
    ),
  );
  s.orders.forEach((o) =>
    o.lines.forEach((l) => {
      expect(A.deliveredQty(s, o, l.id)).toBeLessThanOrEqual(l.qty - l.cancelledQty);
      expect(A.openQty(s, o, l.id)).toBeGreaterThanOrEqual(0);
    }),
  );
  s.purchases.forEach((po) => {
    po.lines.forEach((l) => {
      expect(A.receivedQty(s, po, l.id) + l.closedQty).toBeLessThanOrEqual(l.qty);
      expect(A.openQty(s, po, l)).toBeGreaterThanOrEqual(0);
    });
  });
  s.receipts
    .filter((r) => !r.legacy)
    .forEach((r) => {
      const moves = s.stockMoves.filter((m) => m.type === 'receipt' && m.sourceId === r.id);
      expect(moves).toHaveLength(r.lines.length);
      r.lines.forEach((l) => {
        const match = moves.find((m) => m.batchId === l.batchId && m.qty === l.qty * l.factor);
        expect(match).toBeDefined();
      });
    });
  expect(A.balances(s).payable.balance).toBe(A.round(A.sum(s.receipts, A.billBalance)));
  expect(A.validateBackup(JSON.parse(JSON.stringify(s)))).toEqual(s);
}
function empty(): Workspace {
  const s = A.emptyWorkspace(A.seed());
  s.settings.minShelfLifeDays = 0;
  return s;
}
function stocked() {
  const s = empty();
  const supplier = A.saveContact(s, {
    type: 'Supplier',
    name: 'Test supplier',
    person: '',
    email: '',
    phone: '',
    address: '',
  });
  const customer = A.saveContact(s, {
    type: 'Customer',
    name: 'Test customer',
    person: '',
    email: '',
    phone: '',
    address: '',
  });
  const p = A.saveProduct(s, {
    name: 'Test product',
    sku: 'TEST-1',
    barcode: '',
    generic: '',
    category: 'Pain relief',
    unit: 'box',
    cost: 2,
    price: 5,
    reorder: 10,
    supplierId: supplier.id,
    color: '#10765b',
    shape: 'box',
  });
  const late = A.receiveStock(s, {
    productId: p.id,
    qty: 20,
    cost: 2,
    code: 'LATE',
    expiry: A.shift(120),
    warehouseId: 'wh_main',
    supplierId: supplier.id,
    payment: 'credit',
  });
  const early = A.receiveStock(s, {
    productId: p.id,
    qty: 10,
    cost: 3,
    code: 'EARLY',
    expiry: A.shift(30),
    warehouseId: 'wh_main',
    supplierId: supplier.id,
    payment: 'credit',
  });
  return { s, supplier, customer, p, late, early };
}

describe('supplier accounts', () => {
  const baseContact = { person: '', email: '', phone: '', address: '' };

  it('stores supplier terms, lead time and minimum order, rejects invalid values, and keeps values when editing without fields', () => {
    const { s } = stocked();
    const supplier = A.saveContact(s, {
      ...baseContact,
      type: 'Supplier',
      name: 'MediCare Supplies',
      paymentTermsDays: 45,
      leadTimeDays: 5,
      minOrderValue: 500,
    });
    expect(supplier.paymentTermsDays).toBe(45);
    expect(supplier.leadTimeDays).toBe(5);
    expect(supplier.minOrderValue).toBe(500);

    // Invalid values throw the spec's messages
    expect(() =>
      A.saveContact(s, {
        ...baseContact,
        type: 'Supplier',
        name: 'Bad Terms',
        paymentTermsDays: 400,
      }),
    ).toThrow('Payment terms must be a whole number between 0 and 365 days.');
    expect(() =>
      A.saveContact(s, {
        ...baseContact,
        type: 'Supplier',
        name: 'Bad Terms',
        paymentTermsDays: -1,
      }),
    ).toThrow('Payment terms must be a whole number between 0 and 365 days.');
    expect(() =>
      A.saveContact(s, {
        ...baseContact,
        type: 'Supplier',
        name: 'Bad Terms',
        paymentTermsDays: 1.5,
      }),
    ).toThrow('Payment terms must be a whole number between 0 and 365 days.');
    expect(() =>
      A.saveContact(s, { ...baseContact, type: 'Supplier', name: 'Bad Lead', leadTimeDays: -1 }),
    ).toThrow('Lead time must be a whole number between 0 and 365 days.');
    expect(() =>
      A.saveContact(s, { ...baseContact, type: 'Supplier', name: 'Bad Lead', leadTimeDays: 366 }),
    ).toThrow('Lead time must be a whole number between 0 and 365 days.');
    expect(() =>
      A.saveContact(s, {
        ...baseContact,
        type: 'Supplier',
        name: 'Bad Min Zero',
        minOrderValue: 0,
      }),
    ).toThrow('Minimum order must be greater than zero.');
    expect(() =>
      A.saveContact(s, {
        ...baseContact,
        type: 'Supplier',
        name: 'Bad Min Neg',
        minOrderValue: -10,
      }),
    ).toThrow('Minimum order must be between 0 and 100,000,000.');

    // Editing without the fields keeps them
    const edited = A.saveContact(
      s,
      { ...baseContact, type: 'Supplier', name: 'MediCare Supplies Renamed' },
      supplier.id,
    );
    expect(edited.paymentTermsDays).toBe(45);
    expect(edited.leadTimeDays).toBe(5);
    expect(edited.minOrderValue).toBe(500);

    // Setting minOrderValue to null or '' clears it to null
    const cleared = A.saveContact(
      s,
      { ...baseContact, type: 'Supplier', name: 'MediCare Supplies Renamed', minOrderValue: null },
      supplier.id,
    );
    expect(cleared.minOrderValue).toBeNull();
    const emptyCleared = A.saveContact(
      s,
      { ...baseContact, type: 'Supplier', name: 'MediCare Supplies Renamed', minOrderValue: '' },
      supplier.id,
    );
    expect(emptyCleared.minOrderValue).toBeNull();

    assertInvariants(s);
  });

  it('customers always get leadTimeDays 0 and minOrderValue null, even if the input has values', () => {
    const { s } = stocked();
    const customer = A.saveContact(s, {
      ...baseContact,
      type: 'Customer',
      name: 'Custom Customer',
      leadTimeDays: 10,
      minOrderValue: 200,
    });
    expect(customer.leadTimeDays).toBe(0);
    expect(customer.minOrderValue).toBeNull();

    const editedCustomer = A.saveContact(
      s,
      {
        ...baseContact,
        type: 'Customer',
        name: 'Custom Customer Edited',
        leadTimeDays: 14,
        minOrderValue: 500,
      },
      customer.id,
    );
    expect(editedCustomer.leadTimeDays).toBe(0);
    expect(editedCustomer.minOrderValue).toBeNull();

    assertInvariants(s);
  });

  it('lastPurchasePrice returns newest received PO line, ignores other suppliers/units/non-received POs, and returns null without history', () => {
    const { s, supplier, p } = stocked();
    A.saveProduct(
      s,
      {
        ...p,
        packs: [{ unit: 'carton', factor: 10, barcode: '' }],
      },
      p.id,
    );

    // Returns null when there's no history
    expect(A.lastPurchasePrice(s, supplier.id, p.id, 'box')).toBeNull();

    // Ignores POs that aren't Received
    const poDraft = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-10),
      expected: A.shift(-5),
      lines: [{ productId: p.id, qty: 5, cost: 7.5 }],
    });
    expect(A.lastPurchasePrice(s, supplier.id, p.id, 'box')).toBeNull();

    // Receive the PO
    A.sendPurchase(s, poDraft.id, A.shift(-8));
    const rc1 = A.receivePurchase(s, poDraft.id, {
      lines: [
        { purchaseLineId: poDraft.lines[0].id, qty: 5, code: 'LOT-REC-1', expiry: A.shift(300) },
      ],
      date: A.shift(-8),
    });
    expect(A.lastPurchasePrice(s, supplier.id, p.id, 'box')).toEqual({
      price: 7.5,
      date: A.shift(-8),
      reference: rc1.number,
    });

    // Ignores other units
    expect(A.lastPurchasePrice(s, supplier.id, p.id, 'carton')).toBeNull();

    // Ignores other suppliers
    const otherSupplier = A.saveContact(s, {
      ...baseContact,
      type: 'Supplier',
      name: 'Other Supplier',
    });
    expect(A.lastPurchasePrice(s, otherSupplier.id, p.id, 'box')).toBeNull();

    // Newer received PO line returned
    const poNewer = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-4),
      expected: A.shift(-1),
      lines: [{ productId: p.id, qty: 10, cost: 8.4 }],
    });
    A.sendPurchase(s, poNewer.id, A.shift(-2));
    const rc2 = A.receivePurchase(s, poNewer.id, {
      lines: [
        { purchaseLineId: poNewer.lines[0].id, qty: 10, code: 'LOT-REC-2', expiry: A.shift(300) },
      ],
      date: A.shift(-2),
    });
    expect(A.lastPurchasePrice(s, supplier.id, p.id, 'box')).toEqual({
      price: 8.4,
      date: A.shift(-2),
      reference: rc2.number,
    });

    // Tie breaker: higher PO number wins if same received date
    const po3 = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-1),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 9.1 }],
    });
    const po4 = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-1),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 9.5 }],
    });
    A.sendPurchase(s, po3.id, A.today());
    A.sendPurchase(s, po4.id, A.today());
    A.receivePurchase(s, po3.id, {
      lines: [
        { purchaseLineId: po3.lines[0].id, qty: 10, code: 'LOT-REC-3', expiry: A.shift(300) },
      ],
      date: A.today(),
    });
    const rc4 = A.receivePurchase(s, po4.id, {
      lines: [
        { purchaseLineId: po4.lines[0].id, qty: 10, code: 'LOT-REC-4', expiry: A.shift(300) },
      ],
      date: A.today(),
    });
    expect(A.lastPurchasePrice(s, supplier.id, p.id, 'box')).toEqual({
      price: 9.5,
      date: A.today(),
      reference: rc4.number,
    });

    assertInvariants(s);
  });

  it('createPurchase without a line cost uses the last price; without history it uses the product default; an explicit cost wins', () => {
    const { s, supplier, p } = stocked();
    const otherSupplier = A.saveContact(s, {
      ...baseContact,
      type: 'Supplier',
      name: 'Fresh Supplier',
    });

    // Seed history on supplier: last price = 6.8
    const histPO = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-5),
      expected: A.shift(-2),
      lines: [{ productId: p.id, qty: 5, cost: 6.8 }],
    });
    A.sendPurchase(s, histPO.id, A.shift(-4));
    A.receivePurchase(s, histPO.id, {
      lines: [{ purchaseLineId: histPO.lines[0].id, qty: 5, code: 'HIST-1', expiry: A.shift(200) }],
      date: A.shift(-3),
    });

    // Without a line cost -> uses last price (6.8)
    const poLast = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10 }],
    });
    expect(poLast.lines[0].price).toBe(6.8);

    // Without history -> uses product default cost (p.cost = 2)
    const poDefault = A.createPurchase(s, {
      supplierId: otherSupplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10 }],
    });
    expect(poDefault.lines[0].price).toBe(p.cost);

    // An explicit cost wins
    const poExplicit = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 12.5 }],
    });
    expect(poExplicit.lines[0].price).toBe(12.5);

    assertInvariants(s);
  });

  it('expectedDate adds the supplier lead time', () => {
    const { s } = stocked();
    const supplier = A.saveContact(s, {
      ...baseContact,
      type: 'Supplier',
      name: 'Lead Time Supplier',
      leadTimeDays: 7,
    });
    expect(A.expectedDate(s, supplier.id, '2026-08-10')).toBe('2026-08-17');
    assertInvariants(s);
  });

  it('belowMinimumOrder returns the minimum only when the total is below it', () => {
    const { s } = stocked();
    const supplier = A.saveContact(s, {
      ...baseContact,
      type: 'Supplier',
      name: 'Min Order Supplier',
      minOrderValue: 400,
    });
    expect(A.belowMinimumOrder(s, supplier.id, 350)).toBe(400);
    expect(A.belowMinimumOrder(s, supplier.id, 399.99)).toBe(400);
    expect(A.belowMinimumOrder(s, supplier.id, 400)).toBeNull();
    expect(A.belowMinimumOrder(s, supplier.id, 550)).toBeNull();

    const noMinSupplier = A.saveContact(s, {
      ...baseContact,
      type: 'Supplier',
      name: 'No Min Order Supplier',
      minOrderValue: null,
    });
    expect(A.belowMinimumOrder(s, noMinSupplier.id, 50)).toBeNull();
    assertInvariants(s);
  });

  it('reorderSuggestions estimatedCost uses the last price', () => {
    const { s, supplier, p } = stocked();
    A.saveProduct(s, { ...p, supplierId: supplier.id }, p.id);
    A.saveReorderRule(s, { productId: p.id, warehouseId: 'wh_main', min: 10, max: 50 });
    // Empty all batches of p
    s.batches
      .filter((b) => b.productId === p.id && b.qty > 0)
      .forEach((b) => A.adjustStock(s, { batchId: b.id, qty: -b.qty, reason: 'damaged' }));

    // Position is now 0 <= min 10. Max is 50. Order qty is 50.
    // Without history: cost is p.cost = 2 -> 50 * 2 = 100
    const sugDefault = A.reorderSuggestions(s, 'wh_main').find((x) => x.productId === p.id)!;
    expect(sugDefault.estimatedCost).toBe(100);

    // Record and receive a purchase order from this supplier with cost 4.5
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-3),
      expected: A.shift(-1),
      lines: [{ productId: p.id, qty: 5, cost: 4.5 }],
    });
    A.sendPurchase(s, po.id, A.shift(-2));
    A.receivePurchase(s, po.id, [{ code: 'REC-SUG-LOT', expiry: A.shift(365) }], A.shift(-1));

    // Clear the received batch so position is 0 again
    const recBatch = s.batches.find((b) => b.code === 'REC-SUG-LOT')!;
    A.adjustStock(s, { batchId: recBatch.id, qty: -recBatch.qty, reason: 'damaged' });

    // Now reorder suggestion should use last price 4.5 -> 50 * 4.5 = 225
    const sugLast = A.reorderSuggestions(s, 'wh_main').find((x) => x.productId === p.id)!;
    expect(sugLast.estimatedCost).toBe(225);

    assertInvariants(s);
  });

  it('migration: a v3 backup without the new fields loads with the defaults, and invariants hold', () => {
    const raw = JSON.parse(JSON.stringify(A.seed()));
    raw.version = 3;
    raw.contacts.forEach((c: any) => {
      delete c.leadTimeDays;
      delete c.minOrderValue;
    });
    const loaded = A.validateBackup(raw);
    loaded.contacts.forEach((c) => {
      expect(c.leadTimeDays).toBe(0);
      expect(c.minOrderValue).toBeNull();
    });
    assertInvariants(loaded);
  });
});

describe('purchase order lifecycle and approvals (spec 002)', () => {
  it('createPurchase makes a Draft; with send: true it is Sent; over limit without approval it throws and saves nothing', () => {
    const { s, supplier, p } = stocked();
    s.settings.poApprovalLimit = 2000;

    // Default makes a Draft
    const draft = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }],
    });
    expect(draft.status).toBe('Draft');
    expect(draft.total).toBe(500);
    expect(draft.sentAt).toBeUndefined();
    expect(draft.sentBy).toBeUndefined();
    expect(draft.createdAt).toBeDefined();
    expect(draft.createdBy).toBe('Krisstoff');

    // With send: true under limit -> Sent
    const sent = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }],
      send: true,
    });
    expect(sent.status).toBe('Sent');
    expect(sent.sentAt).toBe(A.today());
    expect(sent.sentBy).toBe('Krisstoff');

    // Over limit with send: true throws and saves nothing
    const countBefore = s.purchases.length;
    expect(() =>
      A.createPurchase(s, {
        supplierId: supplier.id,
        warehouseId: 'wh_main',
        date: A.today(),
        expected: A.shift(2),
        lines: [{ productId: p.id, qty: 100, cost: 50 }], // total 5000 > 2000
        send: true,
      }),
    ).toThrow('Purchase orders over $2,000.00 need approval before sending.');
    expect(s.purchases.length).toBe(countBefore);

    assertInvariants(s);
  });

  it('approvePurchase: records user, time, amount and note; refuses a PO under the limit, and a non-Draft', () => {
    const { s, supplier, p } = stocked();
    s.settings.poApprovalLimit = 2000;

    const poOver = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 50, cost: 50 }], // 2500
    });

    const poUnder = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }], // 500
    });

    // Refuses PO under limit
    expect(() => A.approvePurchase(s, poUnder.id)).toThrow(
      "This purchase order doesn't need approval.",
    );

    // Records user, time, amount and note on valid Draft
    const approved = A.approvePurchase(s, poOver.id, 'Urgent winter restock');
    expect(approved.approval).toEqual({
      by: 'Krisstoff',
      at: expect.any(String),
      amount: 2500,
      note: 'Urgent winter restock',
    });

    // Refuses non-Draft
    A.sendPurchase(s, approved.id);
    expect(approved.status).toBe('Sent');
    expect(() => A.approvePurchase(s, approved.id)).toThrow(
      'Only draft purchase orders can be approved.',
    );

    assertInvariants(s);
  });

  it('sendPurchase: refuses when approval is required; works after approval and when limit is 0; refuses date before order date or in future', () => {
    const { s, supplier, p } = stocked();
    s.settings.poApprovalLimit = 2000;

    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 50, cost: 50 }], // 2500
    });

    // Refuses when approval required
    expect(() => A.sendPurchase(s, po.id)).toThrow(
      'Purchase orders over $2,000.00 need approval before sending.',
    );

    // Refuses invalid sent dates
    A.approvePurchase(s, po.id);
    expect(() => A.sendPurchase(s, po.id, A.shift(-1))).toThrow(
      'Send date must be between the order date and today.',
    );
    expect(() => A.sendPurchase(s, po.id, A.shift(1))).toThrow(
      'Send date must be between the order date and today.',
    );

    // Works after approval
    const sent = A.sendPurchase(s, po.id, A.today());
    expect(sent.status).toBe('Sent');
    expect(sent.sentAt).toBe(A.today());
    expect(sent.sentBy).toBe('Krisstoff');

    // Works without approval when limit is 0
    A.setPurchaseSettings(s, { poApprovalLimit: 0 });
    expect(s.settings.poApprovalLimit).toBe(0);
    const poNoLimit = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 100, cost: 50 }], // 5000
    });
    const sentNoLimit = A.sendPurchase(s, poNoLimit.id);
    expect(sentNoLimit.status).toBe('Sent');

    assertInvariants(s);
  });

  it('savePurchase: edits Draft and Sent POs, recomputes total, refuses supplier change on Sent PO, re-requires approval when raised above approved amount, keeps approval when lowered', () => {
    const { s, supplier, p } = stocked();
    const otherSupplier = A.saveContact(s, {
      name: 'Other Supplier',
      type: 'Supplier',
      person: '',
      email: '',
      phone: '',
      address: '',
    });
    s.settings.poApprovalLimit = 2000;

    // Edits Draft PO
    const draft = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }], // 500
    });
    const editedDraft = A.savePurchase(
      s,
      {
        supplierId: otherSupplier.id,
        warehouseId: 'wh_branch',
        date: draft.date,
        expected: A.shift(5),
        lines: [{ productId: p.id, qty: 20, cost: 50 }], // 1000
        notes: 'Updated notes',
      },
      draft.id,
    );
    expect(editedDraft.supplierId).toBe(otherSupplier.id);
    expect(editedDraft.warehouseId).toBe('wh_branch');
    expect(editedDraft.total).toBe(1000);
    expect(editedDraft.notes).toBe('Updated notes');

    // Create a PO over limit, approve it, and send it
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 50, cost: 50 }], // 2500
    });
    A.approvePurchase(s, po.id, 'Approved for $2500');
    A.sendPurchase(s, po.id);
    expect(po.status).toBe('Sent');

    // Refuses supplier change on Sent PO
    expect(() =>
      A.savePurchase(
        s,
        {
          supplierId: otherSupplier.id,
          warehouseId: po.warehouseId,
          date: po.date,
          expected: po.expected,
          lines: po.lines,
        },
        po.id,
      ),
    ).toThrow(
      "The supplier can't change after the order was sent. Cancel it and create a new one.",
    );

    // Lowering total keeps approval and Sent status
    const lowered = A.savePurchase(
      s,
      {
        supplierId: po.supplierId,
        warehouseId: po.warehouseId,
        date: po.date,
        expected: po.expected,
        lines: [{ productId: p.id, qty: 45, cost: 50 }], // 2250 <= 2500
      },
      po.id,
    );
    expect(lowered.status).toBe('Sent');
    expect(lowered.total).toBe(2250);
    expect(lowered.approval?.amount).toBe(2500);

    // Raising total above approved amount clears approval and returns to Draft
    const raised = A.savePurchase(
      s,
      {
        supplierId: po.supplierId,
        warehouseId: po.warehouseId,
        date: po.date,
        expected: po.expected,
        lines: [{ productId: p.id, qty: 60, cost: 50 }], // 3000 > 2500
      },
      po.id,
    );
    expect(raised.status).toBe('Draft');
    expect(raised.total).toBe(3000);
    expect(raised.approval).toBeUndefined();
    expect(raised.sentAt).toBeUndefined();
    expect(raised.sentBy).toBeUndefined();

    assertInvariants(s);
  });

  it('cancelPurchase needs a reason for a Sent PO, not for a Draft', () => {
    const { s, supplier, p } = stocked();

    const draft = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }],
    });
    // Draft cancels without reason
    const canceledDraft = A.cancelPurchase(s, draft.id);
    expect(canceledDraft.status).toBe('Canceled');
    expect(canceledDraft.cancelReason).toBeUndefined();

    const sent = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }],
      send: true,
    });
    // Sent cancels without reason throws
    expect(() => A.cancelPurchase(s, sent.id)).toThrow(
      'Enter a reason for canceling a sent order.',
    );
    expect(() => A.cancelPurchase(s, sent.id, '   ')).toThrow(
      'Enter a reason for canceling a sent order.',
    );

    // Sent cancels with reason
    const canceledSent = A.cancelPurchase(s, sent.id, 'Supplier discontinues product');
    expect(canceledSent.status).toBe('Canceled');
    expect(canceledSent.cancelReason).toBe('Supplier discontinues product');

    assertInvariants(s);
  });

  it('receivePurchase refuses a Draft', () => {
    const { s, supplier, p } = stocked();
    const draft = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }],
    });
    expect(() =>
      A.receivePurchase(s, draft.id, {
        lines: [
          { purchaseLineId: draft.lines[0].id, qty: 10, code: 'LOT-FAIL', expiry: A.shift(200) },
        ],
      }),
    ).toThrow('Send this purchase order before receiving it.');

    assertInvariants(s);
  });

  it('onOrder counts Draft and Sent lines, and stops counting once received or canceled', () => {
    const { s, supplier, p } = stocked();

    expect(A.onOrder(s, p.id, 'wh_main')).toBe(0);

    // Draft line counts
    const draft = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 10, cost: 50 }],
    });
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(10);

    // Sent line still counts
    A.sendPurchase(s, draft.id);
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(10);

    // Received line stops counting
    A.receivePurchase(s, draft.id, {
      lines: [
        { purchaseLineId: draft.lines[0].id, qty: 10, code: 'LOT-ONORDER', expiry: A.shift(200) },
      ],
    });
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(0);

    // Canceled line stops counting
    const second = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(2),
      lines: [{ productId: p.id, qty: 15, cost: 50 }],
    });
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(15);
    A.cancelPurchase(s, second.id);
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(0);

    assertInvariants(s);
  });

  it('migration: an Ordered PO in a v3 backup becomes Sent with sentAt = date, and invariants hold', () => {
    const raw = JSON.parse(JSON.stringify(A.seed()));
    raw.version = 3;
    delete raw.settings.poApprovalLimit;

    // Simulate an old Ordered PO
    const targetPo = raw.purchases.find(
      (p: any) => p.status === 'Sent' && !raw.receipts.some((r: any) => r.purchaseId === p.id),
    )!;
    targetPo.status = 'Ordered';
    delete targetPo.sentAt;
    delete targetPo.sentBy;
    delete targetPo.createdAt;
    delete targetPo.createdBy;
    delete targetPo.approval;

    const loaded = A.validateBackup(raw);
    expect(loaded.settings.poApprovalLimit).toBe(2000);

    const migratedPO = loaded.purchases.find((p: any) => p.id === targetPo.id)!;
    expect(migratedPO.status).toBe('Sent');
    expect(migratedPO.sentAt).toBe(migratedPO.date);
    expect(migratedPO.sentBy).toBe(A.CURRENT_USER);
    expect(migratedPO.createdAt).toBe(`${migratedPO.date}T00:00:00.000Z`);
    expect(migratedPO.createdBy).toBe(A.CURRENT_USER);

    assertInvariants(loaded);
  });
});

describe('partial receiving and supplier bills (spec 003)', () => {
  it('partial receipt creates a GRN for received lines, PO stays Sent and Partly received, second receipt completes it', () => {
    const { s, supplier, p } = stocked();
    const otherProduct = A.saveProduct(s, {
      ...p,
      sku: 'TEST-2',
      name: 'Second product',
    });
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-5),
      expected: A.shift(2),
      lines: [
        { productId: p.id, qty: 10, cost: 20 },
        { productId: otherProduct.id, qty: 6, cost: 30 },
      ],
      send: true,
    });
    const l1 = po.lines[0];
    const l2 = po.lines[1];

    // First receipt: receive 4 of line 1 only (line 2 receives 0 / skipped)
    const rc1 = A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: l1.id, qty: 4, code: 'LOT-A1', expiry: A.shift(180) }],
      reference: 'INV-SUP-001',
      date: A.shift(-3),
    });

    expect(rc1.number).toMatch(/^GRN-\d{4,}$/);
    expect(rc1.purchaseId).toBe(po.id);
    expect(rc1.lines).toHaveLength(1);
    expect(rc1.lines[0]).toMatchObject({
      productId: p.id,
      qty: 4,
      price: 20,
      orderedPrice: 20,
      purchaseLineId: l1.id,
      lotCode: 'LOT-A1',
    });
    expect(rc1.total).toBe(80);
    expect(rc1.reference).toBe('INV-SUP-001');

    // PO status stays Sent, but purchaseStatus is Partly received
    expect(po.status).toBe('Sent');
    expect(A.purchaseStatus(s, po)).toBe('Partly received');
    expect(A.receivedQty(s, po, l1.id)).toBe(4);
    expect(A.receivedQty(s, po, l2.id)).toBe(0);
    expect(A.openQty(s, po, l1)).toBe(6);
    expect(A.openQty(s, po, l2)).toBe(6);

    // Second receipt: receive remaining 6 of line 1 and all 6 of line 2
    const rc2 = A.receivePurchase(s, po.id, {
      lines: [
        { purchaseLineId: l1.id, qty: 6, code: 'LOT-A2', expiry: A.shift(200) },
        { purchaseLineId: l2.id, qty: 6, code: 'LOT-B1', expiry: A.shift(250) },
      ],
      reference: 'INV-SUP-002',
      date: A.shift(-1),
    });

    expect(rc2.lines).toHaveLength(2);
    expect(po.status).toBe('Received');
    expect(A.purchaseStatus(s, po)).toBe('Received');
    expect(po.received).toBe(A.shift(-1));
    expect(A.openQty(s, po, l1)).toBe(0);
    expect(A.openQty(s, po, l2)).toBe(0);

    assertInvariants(s);
  });

  it('over-receipt throws spec message, and multiple lots exceeding open qty also throw', () => {
    const { s, supplier, p } = stocked();
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-2),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 5, cost: 15 }],
      send: true,
    });
    const line = po.lines[0];

    // Single line over-receipt
    expect(() =>
      A.receivePurchase(s, po.id, {
        lines: [{ purchaseLineId: line.id, qty: 6, code: 'LOT-1', expiry: A.shift(100) }],
      }),
    ).toThrow(
      `${p.name}: only 5 ${line.unit} still open on this order. Raise the PO quantity first.`,
    );

    // Two lots on same line together exceeding open qty
    expect(() =>
      A.receivePurchase(s, po.id, {
        lines: [
          { purchaseLineId: line.id, qty: 3, code: 'LOT-1A', expiry: A.shift(100) },
          { purchaseLineId: line.id, qty: 3, code: 'LOT-1B', expiry: A.shift(120) },
        ],
      }),
    ).toThrow(
      `${p.name}: only 5 ${line.unit} still open on this order. Raise the PO quantity first.`,
    );

    assertInvariants(s);
  });

  it('records actual price: batch cost, bill total, orderedPrice preservation, and journal payable entry', () => {
    const { s, supplier, p } = stocked();
    A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 10, barcode: '' }] }, p.id);
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-2),
      expected: A.today(),
      lines: [{ productId: p.id, unit: 'carton', qty: 2, cost: 50 }], // ordered @ $50/carton ($5/box)
      send: true,
    });
    const line = po.lines[0];

    // Receive at actual billed price $55/carton ($5.50/box)
    const rc = A.receivePurchase(s, po.id, {
      lines: [
        { purchaseLineId: line.id, qty: 2, price: 55, code: 'LOT-DIFF', expiry: A.shift(300) },
      ],
    });

    expect(rc.total).toBe(110);
    expect(rc.lines[0].price).toBe(55);
    expect(rc.lines[0].orderedPrice).toBe(50);

    const batch = s.batches.find((b) => b.id === rc.lines[0].batchId)!;
    expect(batch.cost).toBe(5.5); // 55 / 10
    expect(batch.qty).toBe(20);

    // Journal entry payable is at the actual total ($110)
    const lastJournal = s.journal[0];
    expect(lastJournal.reference).toBe(rc.number);
    const payableEntry = lastJournal.entries.find((e) => e.account === 'payable')!;
    expect(payableEntry.credit).toBe(110);

    assertInvariants(s);
  });

  it('receives one PO line into two lots, creating two batches and two receipt lines', () => {
    const { s, supplier, p } = stocked();
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-2),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 10 }],
      send: true,
    });
    const line = po.lines[0];

    const rc = A.receivePurchase(s, po.id, {
      lines: [
        { purchaseLineId: line.id, qty: 4, code: 'LOT-SPLIT-1', expiry: A.shift(180) },
        { purchaseLineId: line.id, qty: 6, code: 'LOT-SPLIT-2', expiry: A.shift(360) },
      ],
    });

    expect(rc.lines).toHaveLength(2);
    expect(rc.lines[0].batchId).not.toBe(rc.lines[1].batchId);
    expect(rc.lines[0].lotCode).toBe('LOT-SPLIT-1');
    expect(rc.lines[1].lotCode).toBe('LOT-SPLIT-2');
    expect(rc.lines[0].qty).toBe(4);
    expect(rc.lines[1].qty).toBe(6);

    const b1 = s.batches.find((b) => b.id === rc.lines[0].batchId)!;
    const b2 = s.batches.find((b) => b.id === rc.lines[1].batchId)!;
    expect(b1.qty).toBe(4);
    expect(b2.qty).toBe(6);
    expect(b1.expiry).toBe(A.shift(180));
    expect(b2.expiry).toBe(A.shift(360));

    assertInvariants(s);
  });

  it('closeRemaining sets closedQty and Received, requires receipts and reason, and works in receivePurchase', () => {
    const { s, supplier, p } = stocked();
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-3),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 15 }],
      send: true,
    });

    // Refused before any receipt
    expect(() => A.closeRemaining(s, po.id, 'No stock')).toThrow(
      'Nothing was received yet. Cancel the order instead.',
    );

    // Partial receipt of 6 items
    A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: po.lines[0].id, qty: 6, code: 'LOT-P', expiry: A.shift(180) }],
      date: A.shift(-1),
    });

    // Refused without reason
    expect(() => A.closeRemaining(s, po.id, '')).toThrow(
      'Enter a reason for closing the rest of the order.',
    );

    // Close remaining 4 items
    A.closeRemaining(s, po.id, 'Supplier out of stock');
    expect(po.status).toBe('Received');
    expect(A.purchaseStatus(s, po)).toBe('Received');
    expect(po.closeReason).toBe('Supplier out of stock');
    expect(po.lines[0].closedQty).toBe(4);
    expect(A.openQty(s, po, po.lines[0])).toBe(0);
    expect(po.received).toBe(A.shift(-1));

    // Test combined call: receivePurchase with closeRemaining
    const po2 = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-2),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 15 }],
      send: true,
    });
    A.receivePurchase(s, po2.id, {
      lines: [{ purchaseLineId: po2.lines[0].id, qty: 7, code: 'LOT-COMB', expiry: A.shift(200) }],
      closeRemaining: { reason: 'Rest discontinued' },
    });
    expect(po2.status).toBe('Received');
    expect(po2.closeReason).toBe('Rest discontinued');
    expect(po2.lines[0].closedQty).toBe(3);
    expect(A.openQty(s, po2, po2.lines[0])).toBe(0);

    assertInvariants(s);
  });

  it('cancelPurchase is refused after any goods receipt', () => {
    const { s, supplier, p } = stocked();
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-2),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 10 }],
      send: true,
    });
    A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: po.lines[0].id, qty: 3, code: 'LOT-C', expiry: A.shift(180) }],
    });
    expect(() => A.cancelPurchase(s, po.id, 'Cancel attempt')).toThrow(
      'Part of this order was already received. Close the remainder instead.',
    );
    assertInvariants(s);
  });

  it('savePurchase after receipt refuses removing received line, changing product/unit, reducing below received qty, and changing warehouse', () => {
    const { s, supplier, p } = stocked();
    const otherProduct = A.saveProduct(s, { ...p, sku: 'TEST-P2', name: 'Product 2' });
    A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 10, barcode: '' }] }, p.id);
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-3),
      expected: A.today(),
      lines: [
        { productId: p.id, qty: 10, cost: 10 },
        { productId: otherProduct.id, qty: 5, cost: 20 },
      ],
      send: true,
    });
    const l1 = po.lines[0];
    const l2 = po.lines[1];

    A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: l1.id, qty: 4, code: 'LOT-SAVE', expiry: A.shift(180) }],
    });

    // Cannot remove received line
    expect(() =>
      A.savePurchase(
        s,
        {
          supplierId: po.supplierId,
          warehouseId: po.warehouseId,
          date: po.date,
          expected: po.expected,
          lines: [{ productId: otherProduct.id, qty: 5, cost: 20 }],
        },
        po.id,
      ),
    ).toThrow(`${p.name} was already received and can't be removed.`);

    // Cannot change product of received line
    expect(() =>
      A.savePurchase(
        s,
        {
          supplierId: po.supplierId,
          warehouseId: po.warehouseId,
          date: po.date,
          expected: po.expected,
          lines: [
            { id: l1.id, productId: otherProduct.id, qty: 10, cost: 10 },
            { id: l2.id, productId: otherProduct.id, qty: 5, cost: 20 },
          ],
        },
        po.id,
      ),
    ).toThrow(`${p.name} was already received; its product and unit can't change.`);

    // Cannot change unit of received line
    expect(() =>
      A.savePurchase(
        s,
        {
          supplierId: po.supplierId,
          warehouseId: po.warehouseId,
          date: po.date,
          expected: po.expected,
          lines: [
            { id: l1.id, productId: p.id, unit: 'carton', qty: 1, cost: 100 },
            { id: l2.id, productId: otherProduct.id, qty: 5, cost: 20 },
          ],
        },
        po.id,
      ),
    ).toThrow(`${p.name} was already received; its product and unit can't change.`);

    // Cannot reduce qty below received qty (4)
    expect(() =>
      A.savePurchase(
        s,
        {
          supplierId: po.supplierId,
          warehouseId: po.warehouseId,
          date: po.date,
          expected: po.expected,
          lines: [
            { id: l1.id, productId: p.id, qty: 3, cost: 10 },
            { id: l2.id, productId: otherProduct.id, qty: 5, cost: 20 },
          ],
        },
        po.id,
      ),
    ).toThrow(`${p.name}: quantity can't go below the 4 already received.`);

    // Cannot change warehouse
    expect(() =>
      A.savePurchase(
        s,
        {
          supplierId: po.supplierId,
          warehouseId: 'wh_branch',
          date: po.date,
          expected: po.expected,
          lines: po.lines,
        },
        po.id,
      ),
    ).toThrow("The warehouse can't change after goods were received.");

    // Editing qty down to received qty sets Received if all lines have openQty === 0
    A.savePurchase(
      s,
      {
        supplierId: po.supplierId,
        warehouseId: po.warehouseId,
        date: po.date,
        expected: po.expected,
        lines: [{ id: l1.id, productId: p.id, qty: 4, cost: 10 }], // dropped unreceived l2, lowered l1 to 4
      },
      po.id,
    );
    expect(po.status).toBe('Received');

    assertInvariants(s);
  });

  it('receiveStock creates a one-line GRN, and cash path has due = date', () => {
    const { s, supplier, p } = stocked();
    const batch = A.receiveStock(s, {
      productId: p.id,
      warehouseId: 'wh_main',
      qty: 8,
      cost: 5,
      code: 'DIRECT-CASH',
      expiry: A.shift(300),
      supplierId: supplier.id,
      payment: 'cash',
      reference: 'INV-CASH-999',
    });

    const rc = s.receipts.find((r) => r.lines.some((l) => l.batchId === batch.id))!;
    expect(rc).toBeDefined();
    expect(rc.number).toMatch(/^GRN-\d{4,}$/);
    expect(rc.purchaseId).toBeUndefined();
    expect(rc.lines).toHaveLength(1);
    expect(rc.lines[0].orderedPrice).toBeUndefined();
    expect(rc.reference).toBe('INV-CASH-999');
    expect(rc.due).toBe(A.today());
    expect(rc.paid).toBe(40);
    expect(A.billStatus(rc)).toBe('Paid');

    assertInvariants(s);
  });

  it('payBill works on receipts and refuses more than billBalance', () => {
    const { s, supplier, p } = stocked();
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-5),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 5, cost: 20 }], // 100
      send: true,
    });
    const rc = A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: po.lines[0].id, qty: 5, code: 'LOT-PAY', expiry: A.shift(180) }],
      date: A.shift(-3),
    });

    expect(A.billBalance(rc)).toBe(100);
    expect(A.billStatus(rc)).toBe('Open');

    // Refuses more than balance
    expect(() => A.payBill(s, rc.id, 105)).toThrow(
      'Payment must be positive and cannot exceed the bill balance.',
    );

    // Partial payment
    A.payBill(s, rc.id, 40, A.shift(-2));
    expect(rc.paid).toBe(40);
    expect(A.billBalance(rc)).toBe(60);
    expect(A.billStatus(rc)).toBe('Partly paid');

    // Remaining payment
    A.payBill(s, rc.id, 60, A.today());
    expect(rc.paid).toBe(100);
    expect(A.billBalance(rc)).toBe(0);
    expect(A.billStatus(rc)).toBe('Paid');

    assertInvariants(s);
  });

  it('lastPurchasePrice returns latest actual receipt price instead of PO price', () => {
    const { s, supplier, p } = stocked();
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-4),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 5, cost: 12 }],
      send: true,
    });
    const rc = A.receivePurchase(s, po.id, {
      lines: [
        {
          purchaseLineId: po.lines[0].id,
          qty: 5,
          price: 14.5,
          code: 'LOT-ACT',
          expiry: A.shift(200),
        },
      ],
      date: A.shift(-1),
    });

    const last = A.lastPurchasePrice(s, supplier.id, p.id, 'box');
    expect(last).toEqual({
      price: 14.5,
      date: A.shift(-1),
      reference: rc.number,
    });

    assertInvariants(s);
  });

  it('onOrder counts only open quantities of Draft and Sent POs', () => {
    const { s, supplier, p } = stocked();
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-2),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 10, cost: 10 }],
      send: true,
    });
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(10);

    // Partial receipt of 4
    A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: po.lines[0].id, qty: 4, code: 'LOT-OO1', expiry: A.shift(180) }],
    });
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(6);

    // Close remaining 6
    A.closeRemaining(s, po.id, 'Rest cancelled');
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(0);

    assertInvariants(s);
  });
});

describe('contact type history guard', () => {
  it.each([
    ['invoices', 'customerId'],
    ['orders', 'customerId'],
    ['deliveries', 'customerId'],
    ['reservations', 'customerId'],
    ['payments', 'customerId'],
    ['refunds', 'customerId'],
    ['creditNotes', 'customerId'],
    ['prices', 'customerId'],
    ['purchases', 'supplierId'],
    ['receipts', 'supplierId'],
    ['products', 'supplierId'],
  ] as const)('checks contact references in %s', (collection, field) => {
    const s = A.seed();
    const references = s[collection] as unknown as Record<string, unknown>[];
    const reference = references.find((r) => typeof r[field] === 'string' && r[field]);
    expect(reference).toBeDefined();
    const id = reference![field] as string;
    const c = A.contact(s, id)!;
    // Isolate the helper's collection check; the complete seed below stays valid.
    const isolated = { ...A.emptyWorkspace(s), [collection]: [reference] };
    expect(A.contactInUse(isolated, id)).toBe(true);
    expect(A.contactInUse(isolated, 'unused-contact')).toBe(false);
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) =>
        A.saveContact(copy, { ...c, type: c.type === 'Customer' ? 'Supplier' : 'Customer' }, id),
      ),
    ).toThrow('This contact has transaction history, so its type cannot be changed.');
    expect(s).toEqual(before);
    A.saveContact(s, { ...c, phone: '012345678' }, id);
    assertInvariants(s);
  });

  it.each(['hold', 'released hold', 'deposit', 'voided deposit', 'refunded deposit'])(
    'keeps a customer with only a %s from becoming a supplier',
    (history) => {
      const { s, customer, p } = stocked();
      if (history.includes('hold')) {
        const hold = A.holdStock(s, { customerId: customer.id, productId: p.id, qty: 1 });
        if (history === 'released hold') A.releaseReservation(s, hold.id);
      } else {
        const payment = A.recordPayment(s, {
          customerId: customer.id,
          date: A.today(),
          amount: 10,
          method: 'Cash',
        });
        if (history === 'voided deposit') A.voidPayment(s, payment.id, 'Duplicate deposit');
        if (history === 'refunded deposit')
          A.refundCredit(s, {
            customerId: customer.id,
            date: A.today(),
            amount: 10,
            method: 'Cash',
          });
      }
      expect(s.invoices).toHaveLength(0);
      expect(s.orders).toHaveLength(0);
      expect(() =>
        A.transact(s, (copy) =>
          A.saveContact(copy, { ...customer, type: 'Supplier' }, customer.id),
        ),
      ).toThrow('transaction history');
      assertInvariants(s);
    },
  );

  it('allows changing an unused contact type in either direction', () => {
    const { s, customer } = stocked();
    expect(A.contactInUse(s, customer.id)).toBe(false);
    const supplier = A.saveContact(s, { ...customer, type: 'Supplier' }, customer.id);
    expect(supplier.type).toBe('Supplier');
    const restored = A.saveContact(s, { ...supplier, type: 'Customer' }, customer.id);
    expect(restored.type).toBe('Customer');
    assertInvariants(s);
  });
});
// Build a genuine pre-v3 fixture: invoices own picks/cost; no order deliveries existed.
function legacyBackup(s: Workspace, keepOrders = false, beforeCreditNotes = false) {
  const raw = JSON.parse(JSON.stringify(s));
  for (const invoice of raw.invoices) {
    const original = s.invoices.find((i) => i.id === invoice.id)!;
    invoice.allocations = A.deliveriesOf(s, original).flatMap((d) =>
      d.lines.flatMap((l) =>
        l.picks.map((p) => ({
          batchId: p.batchId,
          warehouseId: p.warehouseId,
          code: p.lotCode,
          productId: l.productId,
          qty: p.qty,
          cost: p.cost,
        })),
      ),
    );
    if (invoice.status === 'Issued') invoice.cogs = A.invoiceCost(s, original);
    for (const move of raw.stockMoves)
      if (original.deliveryIds.includes(move.sourceId)) {
        move.sourceId = invoice.id;
        move.reference = invoice.number;
      }
    delete invoice.deliveryIds;
    delete invoice.orderId;
  }
  if (keepOrders) {
    // A pre-v3 order cannot yet have dispatched quantities. Preserve its line data.
    raw.orders.forEach((order: { id: string; status: string; closedAt?: string }) => {
      const current = s.orders.find((o) => o.id === order.id)!;
      if (
        order.status === 'Done' &&
        current.lines.some((l) => A.deliveredQty(s, current, l.id) > 0)
      ) {
        order.status = 'Confirmed';
        delete order.closedAt;
      }
    });
  } else {
    raw.orders = [];
    raw.reservations = raw.reservations.filter(
      (r: { source: string }) => r.source !== 'sales_order',
    );
  }
  if (beforeCreditNotes) {
    // A genuine pre-ledger backup cannot contain 006 return documents or their postings.
    const creditIds = new Set(s.creditNotes.map((cn) => cn.id));
    const returnedBatches = new Set(
      s.creditNotes.flatMap((cn) => cn.lines.flatMap((l) => l.returns.map((p) => p.returnBatchId))),
    );
    const adjustments = s.adjustments.filter((a) => returnedBatches.has(a.batchId));
    const removedSources = new Set([...creditIds, ...adjustments.map((a) => a.id)]);
    const references = new Set([
      ...s.creditNotes.map((cn) => cn.number),
      ...s.refunds.filter((r) => r.from.some((f) => f.kind === 'credit_note')).map((r) => r.id),
      ...adjustments.map((a) => a.number),
    ]);
    raw.stockMoves = raw.stockMoves.filter(
      (m: { sourceId?: string }) => !removedSources.has(m.sourceId || ''),
    );
    raw.batches.forEach((b: { id: string; qty: number }) => {
      b.qty = raw.stockMoves
        .filter((m: { batchId: string }) => m.batchId === b.id)
        .reduce((n: number, m: { qty: number }) => n + m.qty, 0);
    });
    raw.adjustments = raw.adjustments.filter((a: { id: string }) => !removedSources.has(a.id));
    raw.journal = raw.journal.filter((j: { reference: string }) => !references.has(j.reference));
    raw.invoices.forEach((i: { credited?: number }) => delete i.credited);
    delete raw.creditNotes;
    raw.refunds = raw.refunds.filter((r: { from: { kind: string }[] }) =>
      r.from.every((f) => f.kind !== 'credit_note'),
    );
    delete raw.counters.creditNote;
  }
  delete raw.deliveries;
  delete raw.counters.delivery;
  raw.version = 2;
  return raw;
}
describe('customer payment migration', () => {
  it('migrates the current seed from pre-007 without changing balances, invoice caches or journal', () => {
    const seed = A.seed();
    const raw = JSON.parse(JSON.stringify(seed));
    // Reconstruct the old invoice-owned payment shape from either seed generation.
    raw.invoices.forEach((i: { id: string; payments?: unknown[] }) => {
      if (!i.payments)
        i.payments = (raw.payments || [])
          .filter((p: { status: string }) => p.status === 'Posted')
          .flatMap(
            (p: {
              id: string;
              date: string;
              method: string;
              allocations: { invoiceId: string; amount: number }[];
            }) =>
              p.allocations
                .filter((a) => a.invoiceId === i.id)
                .map((a) => ({ id: p.id, date: p.date, method: p.method, amount: a.amount })),
          );
    });
    delete raw.payments;
    delete raw.refunds;
    delete raw.counters.payment;
    raw.creditNotes.forEach((cn: { allocations: { date?: string }[] }) =>
      cn.allocations.forEach((a) => delete a.date),
    );
    const balances = A.balances(raw);
    const invoices = raw.invoices.map((i: { id: string; paid: number; credited: number }) => [
      i.id,
      i.paid,
      i.credited,
    ]);
    const journal = JSON.parse(JSON.stringify(raw.journal));
    const count = raw.invoices.reduce(
      (n: number, i: { payments: unknown[] }) => n + i.payments.length,
      0,
    );
    const migrated = A.migrate(raw);
    expect(migrated.payments.filter((p) => p.legacy)).toHaveLength(count);
    expect(migrated.invoices.every((i) => !('payments' in i))).toBe(true);
    expect(A.balances(migrated)).toEqual(balances);
    expect(migrated.invoices.map((i) => [i.id, i.paid, i.credited])).toEqual(invoices);
    expect(migrated.journal).toEqual(journal);
    expect(A.validateBackup(migrated)).toBe(migrated);
    expect(A.migrate(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
    assertInvariants(migrated);
  });
});

describe('credit notes and returns', () => {
  function setup(qty = 4, taxRate = 10, discount = 2, price = 5) {
    const data = stocked();
    const { s, customer, p } = data;
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      taxRate,
      discount,
      lines: [{ productId: p.id, qty, price }],
    });
    A.issueInvoice(s, invoice.id);
    const input: CreditNoteInput = {
      invoiceId: invoice.id,
      kind: 'return',
      reason: 'wrong_prescription',
      settlement: 'credit',
      lines: [{ invoiceLineIndex: 0, qty: 2 }],
    };
    return { ...data, invoice, input };
  }
  it('returns two boxes into an original-lot quarantined twin and reverses inventory, COGS, revenue and tax exactly', () => {
    const { s, invoice, input, early } = setup();
    const before = A.balances(s);
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        ...input,
        lines: [{ invoiceLineIndex: 0, qty: 2, returns: [{ batchId: early.id, qty: 2 }] }],
      }).id,
    );
    const twin = s.batches.find((b) => b.id === cn.lines[0].returns[0].returnBatchId)!;
    expect(twin).toMatchObject({
      productId: early.productId,
      code: early.code,
      expiry: early.expiry,
      cost: early.cost,
      warehouseId: early.warehouseId,
      qty: 2,
      quarantined: true,
    });
    expect(twin.id).not.toBe(early.id);
    expect(cn).toMatchObject({
      subtotal: 10,
      discount: 1,
      taxRate: 10,
      taxAmount: 0.9,
      total: 9.9,
      returnCost: 6,
      status: 'Issued',
      createdBy: CURRENT_USER,
    });
    const after = A.balances(s);
    expect(after.inventory.balance).toBe(A.round(before.inventory.balance + 6));
    expect(after.cogs.balance).toBe(A.round(before.cogs.balance - 6));
    expect(after.revenue.balance).toBe(A.round(before.revenue.balance - 9));
    expect(after.tax.balance).toBe(A.round(before.tax.balance - 0.9));
    expect(
      s.journal.find((j) => j.description === `Credit note — ${invoice.number}`)?.reference,
    ).toBe(cn.number);
    expect(s.movements[0].description).toContain(
      'Returned stock is in quarantine — release or write it off in Batches.',
    );
    expect(s.movements[0].description).toContain(`${cn.number} · ${invoice.number}`);
    assertInvariants(s);
  });
  it('reduces an unpaid invoice balance without refund or available credit and updates exposure and overdue metrics', () => {
    const { s, invoice, input, customer } = setup();
    const cn = A.issueCreditNote(s, A.saveCreditNote(s, input).id);
    expect(invoice.credited).toBe(cn.total);
    expect(A.invoiceBalance(invoice)).toBe(9.9);
    expect(cn.allocations).toEqual([{ invoiceId: invoice.id, amount: cn.total, date: cn.date }]);
    expect(cn.refunded).toBe(0);
    expect(A.creditAvailable(cn)).toBe(0);
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(9.9);
    invoice.due = A.shift(-10);
    expect(A.creditCheck(s, customer.id, 0).overdue).toBe(9.9);
    assertInvariants(s);
  });
  it.each(['refund', 'credit'] as const)('settles a paid invoice with %s', (settlement) => {
    const { s, invoice, input } = setup();
    A.payInvoice(s, invoice.id, invoice.total, 'Cash');
    const before = A.balances(s).cash.balance;
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, { ...input, settlement, refundMethod: 'Cash' }).id,
    );
    expect(cn.allocations).toEqual([]);
    expect(invoice.credited).toBe(0);
    expect(cn.refunded).toBe(settlement === 'refund' ? cn.total : 0);
    expect(A.creditAvailable(cn)).toBe(settlement === 'credit' ? cn.total : 0);
    expect(A.balances(s).cash.balance).toBe(A.round(before - cn.refunded));
    if (settlement === 'refund')
      expect(s.journal[0]).toMatchObject({
        reference: cn.number,
        description: 'Refund — Cash',
        entries: [
          { account: 'receivable', debit: cn.total, credit: 0 },
          { account: 'cash', debit: 0, credit: cn.total },
        ],
      });
    assertInvariants(s);
  });
  it.each(['refund', 'credit'] as const)(
    'fills a partly paid balance before settling the remainder with %s',
    (settlement) => {
      const { s, invoice, input } = setup();
      A.payInvoice(s, invoice.id, 15);
      const cn = A.issueCreditNote(
        s,
        A.saveCreditNote(s, { ...input, settlement, refundMethod: 'Cash' }).id,
      );
      expect(invoice.credited).toBe(4.8);
      expect(A.invoiceBalance(invoice)).toBe(0);
      expect(cn.refunded).toBe(settlement === 'refund' ? 5.1 : 0);
      expect(A.creditAvailable(cn)).toBe(settlement === 'credit' ? 5.1 : 0);
      assertInvariants(s);
    },
  );
  it('defaults return lots to latest expiry first and caps original batches across repeated product lines', () => {
    const { s, invoice, input, late, early } = setup(14, 0, 0);
    const first = A.issueCreditNote(s, A.saveCreditNote(s, input).id);
    expect(first.lines[0].returns).toMatchObject([{ batchId: late.id, qty: 2, cost: 2 }]);
    const second = A.issueCreditNote(
      s,
      A.saveCreditNote(s, { ...input, lines: [{ invoiceLineIndex: 0, qty: 3 }] }).id,
    );
    expect(second.lines[0].returns.map((p) => [p.batchId, p.qty])).toEqual([
      [late.id, 2],
      [early.id, 1],
    ]);
    expect(A.invoiceBalance(invoice)).toBe(45);
    assertInvariants(s);
  });
  it('uses stored pack factors and original pick costs for returns', () => {
    const { s, customer, p } = stocked();
    A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 5, barcode: '' }] }, p.id);
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [{ productId: p.id, unit: 'carton', qty: 3, price: 25 }],
    });
    A.issueInvoice(s, invoice.id);
    A.saveProduct(s, { ...s.products[0], packs: [] }, p.id);
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: invoice.id,
        kind: 'return',
        reason: 'wrong_item',
        settlement: 'credit',
        lines: [{ invoiceLineIndex: 0, qty: 2 }],
      }).id,
    );
    expect(cn.lines[0].factor).toBe(5);
    expect(A.sum(cn.lines[0].returns, (p) => p.qty)).toBe(10);
    expect(cn.returnCost).toBe(25);
    assertInvariants(s);
  });
  it('shares original batch caps across repeated product lines, including lines on the same note', () => {
    const { s, customer, p, early } = stocked();
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [
        { productId: p.id, qty: 2 },
        { productId: p.id, qty: 2 },
      ],
    });
    A.issueInvoice(s, invoice.id);
    const input: CreditNoteInput = {
      invoiceId: invoice.id,
      kind: 'return',
      reason: 'wrong_item',
      settlement: 'credit',
      lines: [
        { invoiceLineIndex: 0, qty: 2 },
        { invoiceLineIndex: 1, qty: 2 },
      ],
    };
    const cn = A.issueCreditNote(s, A.saveCreditNote(s, input).id);
    expect(cn.lines.flatMap((l) => l.returns).map((p) => [p.batchId, p.qty])).toEqual([
      [early.id, 2],
      [early.id, 2],
    ]);
    expect(() =>
      A.saveCreditNote(s, { ...input, lines: [{ invoiceLineIndex: 1, qty: 1 }] }),
    ).toThrow('This would credit more than was invoiced.');
    assertInvariants(s);
  });
  it('accepts free returned goods at their original zero price', () => {
    const { s, customer, p } = stocked();
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [
        { productId: p.id, qty: 1, price: 0 },
        { productId: p.id, qty: 1, price: 5 },
      ],
    });
    A.issueInvoice(s, invoice.id);
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: invoice.id,
        kind: 'return',
        reason: 'wrong_item',
        settlement: 'credit',
        lines: [{ invoiceLineIndex: 0, qty: 1 }],
      }).id,
    );
    expect(cn.total).toBe(0);
    expect(cn.returnCost).toBe(3);
    expect(A.invoiceBalance(invoice)).toBe(5);
    assertInvariants(s);
  });
  it.each(['quantity', 'lot', 'price', 'line amount', 'total'] as const)(
    'rejects the %s cap atomically',
    (testCase) => {
      const { s, invoice, input, late } = setup(
        testCase === 'total' ? 3 : 4,
        testCase === 'total' ? 10 : 0,
        0,
        testCase === 'total' ? 0.05 : 5,
      );
      let invalid: CreditNoteInput = input;
      if (testCase === 'quantity') {
        A.issueCreditNote(s, A.saveCreditNote(s, input).id);
        invalid = { ...input, lines: [{ invoiceLineIndex: 0, qty: 3 }] };
      } else if (testCase === 'lot')
        invalid = {
          ...input,
          lines: [{ invoiceLineIndex: 0, qty: 2, returns: [{ batchId: late.id, qty: 2 }] }],
        };
      else if (testCase === 'price')
        invalid = {
          ...input,
          kind: 'correction',
          lines: [{ invoiceLineIndex: 0, qty: 1, price: 6 }],
        };
      else if (testCase === 'line amount') {
        A.issueCreditNote(
          s,
          A.saveCreditNote(s, {
            ...input,
            kind: 'correction',
            lines: [{ invoiceLineIndex: 0, qty: 4, price: 4 }],
          }).id,
        );
        invalid = { ...input, lines: [{ invoiceLineIndex: 0, qty: 1 }] };
      } else {
        invalid = { ...input, lines: [{ invoiceLineIndex: 0, qty: 1 }] };
        A.issueCreditNote(s, A.saveCreditNote(s, invalid).id);
        A.issueCreditNote(s, A.saveCreditNote(s, invalid).id);
      }
      const before = structuredClone(s);
      expect(() => A.transact(s, (copy) => A.saveCreditNote(copy, invalid))).toThrow(
        testCase === 'lot'
          ? 'Return lot must be one of the invoice picks.'
          : 'This would credit more than was invoiced.',
      );
      expect(s).toEqual(before);
      expect(invoice.status).toBe('Issued');
      assertInvariants(s);
    },
  );
  it('revalidates stale drafts on issue and never edits or deletes an issued note', () => {
    const { s, input } = setup();
    const draft = A.saveCreditNote(s, input);
    const other = A.issueCreditNote(
      s,
      A.saveCreditNote(s, { ...input, lines: [{ invoiceLineIndex: 0, qty: 3 }] }).id,
    );
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueCreditNote(copy, draft.id))).toThrow(
      'This would credit more than was invoiced.',
    );
    expect(() => A.saveCreditNote(s, input, other.id)).toThrow(
      'Only draft credit notes can be edited.',
    );
    expect(() => A.deleteCreditNote(s, other.id)).toThrow(
      'Only draft credit notes can be deleted.',
    );
    expect(() => A.issueCreditNote(s, other.id)).toThrow('Only draft credit notes can be issued.');
    expect(s).toEqual(before);
    A.deleteCreditNote(s, draft.id);
    expect(A.saveCreditNote(s, { ...input, lines: [{ invoiceLineIndex: 0, qty: 1 }] }).number).toBe(
      'CN-0003',
    );
    assertInvariants(s);
  });
  it('returns a retired product and retains the cold-chain and warehouse count checks', () => {
    const { s, invoice, input, p } = setup();
    const draft = A.saveCreditNote(s, input);
    const count = A.startCount(s, { warehouseId: 'wh_main', categories: [], blind: false });
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueCreditNote(copy, draft.id))).toThrow('count');
    expect(s).toEqual(before);
    A.cancelCount(s, count.id);
    s.batches
      .filter((b) => b.productId === p.id && b.qty > 0)
      .forEach((b) =>
        A.adjustStock(s, {
          batchId: b.id,
          qty: -b.qty,
          reason: 'other',
          note: 'Clear remaining stock before retirement.',
        }),
      );
    A.saveProduct(s, { ...p, active: false }, p.id);
    const cn = A.issueCreditNote(s, draft.id);
    expect(cn.returnCost).toBe(6);
    expect(A.invoiceBalance(invoice)).toBe(9.9);
    const twin = s.batches.find((b) => b.id === cn.lines[0].returns[0].returnBatchId)!;
    const retired = s.products.find((product) => product.id === p.id)!;
    retired.storage = 'cold';
    expect(() =>
      A.moveStock(s, twin, 1, { type: 'return', date: A.today(), reference: 'TEST' }),
    ).toThrow('cold-storage');
    retired.storage = 'ambient';
    assertInvariants(s);
  });
  it('includes returned quantities in recall sold-to rows and reconciles total stock', () => {
    const { s, input, p, early } = setup();
    const recall = A.createRecall(s, {
      productId: p.id,
      lotCode: early.code,
      reason: 'Packaging check',
    });
    A.issueCreditNote(s, A.saveCreditNote(s, input).id);
    const trace = A.recallTrace(s, recall.id);
    expect(trace.sold[0]).toMatchObject({ qty: 4, returned: 2 });
    expect(trace.totals).toEqual({ received: 10, sold: 4, returned: 2, adjusted: 0, onHand: 8 });
    assertInvariants(s);
  });
  it('shows Credited for a fully credited unpaid invoice and caps subsequent payments at the new balance', () => {
    const { s, invoice, input } = setup();
    A.issueCreditNote(
      s,
      A.saveCreditNote(s, { ...input, lines: [{ invoiceLineIndex: 0, qty: 4 }] }).id,
    );
    expect(A.invoiceStatus(invoice)).toBe('Credited');
    expect(() => A.payInvoice(s, invoice.id, 1)).toThrow('outstanding amount');
    assertInvariants(s);
  });
  it('posts price corrections without stock, permits partial corrections and reports net sales by credit note date', () => {
    const { s, invoice, input } = setup();
    invoice.date = A.shift(-2);
    const stock = structuredClone(s.stockMoves);
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        ...input,
        kind: 'correction',
        reason: 'price_error',
        lines: [{ invoiceLineIndex: 0, qty: 2, price: 1 }],
      }).id,
    );
    expect(s.stockMoves).toEqual(stock);
    expect(cn.returnCost).toBe(0);
    expect(A.netSales(s, A.shift(-2), A.shift(-1))).toBe(18);
    expect(A.netSales(s, A.today())).toBe(-1.8);
    expect(A.netSales(s, A.shift(-2))).toBe(16.2);
    assertInvariants(s);
  });
  it('validates required fields, dates, original return prices, correction quantities and drafts without posting', () => {
    const { s, invoice, input } = setup();
    const invalid: CreditNoteInput[] = [
      { ...input, invoiceId: 'missing' },
      { ...input, reason: 'other' },
      { ...input, settlement: 'refund' },
      { ...input, date: A.shift(1) },
      { ...input, date: A.shift(-1) },
      { ...input, lines: [] },
      { ...input, lines: [{ invoiceLineIndex: 0, qty: 1, price: 1 }] },
      { ...input, kind: 'correction', lines: [{ invoiceLineIndex: 0, qty: 1, price: 0 }] },
      { ...input, kind: 'correction', lines: [{ invoiceLineIndex: 0, qty: 5, price: 1 }] },
      {
        ...input,
        kind: 'correction',
        lines: [
          { invoiceLineIndex: 0, qty: 1, price: 1, returns: [{ batchId: 'missing', qty: 1 }] },
        ],
      },
    ];
    const before = structuredClone(s);
    invalid.forEach((value) =>
      expect(() => A.transact(s, (copy) => A.saveCreditNote(copy, value))).toThrow(),
    );
    expect(s).toEqual(before);
    const draft = A.saveCreditNote(s, input);
    A.saveCreditNote(s, { ...input, note: 'Reviewed draft' }, draft.id);
    expect(s.stockMoves).toEqual(before.stockMoves);
    expect(s.journal).toEqual(before.journal);
    expect(invoice.credited).toBe(0);
    assertInvariants(s);
  });
  it.each([1, 2, 3])(
    'migrates v%i missing defaults idempotently, including the current seed with all invariants',
    (version) => {
      const { s } = setup();
      const raw = JSON.parse(JSON.stringify(s));
      raw.version = version;
      delete raw.creditNotes;
      delete raw.counters.creditNote;
      raw.invoices.forEach((i: { credited?: number }) => delete i.credited);
      const migrated = A.validateBackup(raw);
      expect(migrated.creditNotes).toEqual([]);
      expect(migrated.counters.creditNote).toBe(1);
      expect(migrated.invoices.every((i) => i.credited === 0)).toBe(true);
      expect(A.migrate(structuredClone(migrated))).toEqual(migrated);
      assertInvariants(migrated);
      const seed = JSON.parse(JSON.stringify(A.seed()));
      seed.version = version;
      assertInvariants(A.validateBackup(seed));
    },
  );
  it('rejects malformed credit fields, links, amounts, allocations, S2, S3 and return moves in backups', () => {
    const { s, invoice, input } = setup();
    const cn = A.issueCreditNote(s, A.saveCreditNote(s, input).id);
    const badChanges: ((copy: Workspace) => void)[] = [
      (copy) => {
        copy.creditNotes[0].total += 1;
      },
      (copy) => {
        copy.creditNotes[0].returnCost += 1;
      },
      (copy) => {
        copy.creditNotes[0].customerId = 'missing';
      },
      (copy) => {
        copy.creditNotes[0].lines[0].invoiceLineIndex = 99;
      },
      (copy) => {
        copy.creditNotes[0].lines[0].returns[0].batchId = 'missing';
      },
      (copy) => {
        copy.creditNotes[0].lines[0].returns[0].returnBatchId = 'missing';
      },
      (copy) => {
        copy.creditNotes[0].lines[0].returns[0].cost += 1;
      },
      (copy) => {
        copy.creditNotes[0].allocations[0].amount += 1;
      },
      (copy) => {
        copy.creditNotes[0].refunded = 1;
      },
      (copy) => {
        copy.invoices.find((i) => i.id === invoice.id)!.credited += 1;
      },
      (copy) => {
        copy.stockMoves.find((m) => m.sourceId === cn.id)!.sourceId = 'missing';
      },
      (copy) => {
        copy.journal = copy.journal.filter(
          (j) => j.description !== `Credit note — ${invoice.number}`,
        );
      },
      (copy) => {
        copy.counters.creditNote = 1;
      },
      (copy) => {
        copy.creditNotes.push(structuredClone(copy.creditNotes[0]));
      },
    ];
    badChanges.forEach((change) => {
      const copy = structuredClone(s);
      change(copy);
      expect(() => A.validateBackup(copy)).toThrow();
    });
    assertInvariants(s);
  });
  it.each(['credit', 'refund'] as const)(
    'accepts future allocations to another invoice for %s notes',
    (settlement) => {
      const { s, input, invoice, customer, p } = setup();
      const cn = A.issueCreditNote(
        s,
        A.saveCreditNote(s, { ...input, settlement, refundMethod: 'Cash' }).id,
      );
      const other = A.createInvoice(s, {
        customerId: customer.id,
        date: A.today(),
        lines: [{ productId: p.id, qty: 4 }],
      });
      A.issueInvoice(s, other.id);
      // A backup may already contain a later allocation made by 007. Allocation itself posts no journal.
      const raw = structuredClone(s);
      raw.creditNotes.find((note) => note.id === cn.id)!.allocations[0].invoiceId = other.id;
      raw.invoices.find((i) => i.id === invoice.id)!.credited = 0;
      raw.invoices.find((i) => i.id === other.id)!.credited = cn.total;
      assertInvariants(A.validateBackup(raw));
      assertInvariants(s);
    },
  );
  it('seeds all four credit-note examples plus unapplied credit, a released twin and a damaged write-off', () => {
    const s = A.seed();
    expect(s.creditNotes).toHaveLength(5);
    const issued = s.creditNotes.filter((cn) => cn.status === 'Issued');
    expect(
      issued.some(
        (cn) => cn.kind === 'return' && cn.refunded === cn.total && cn.refundMethod === 'Cash',
      ),
    ).toBe(true);
    expect(
      issued.some((cn) => cn.reason === 'damaged' && cn.allocations[0].amount === cn.total),
    ).toBe(true);
    expect(
      issued.some(
        (cn) =>
          cn.kind === 'correction' &&
          cn.allocations.length > 0 &&
          cn.refunded > 0 &&
          A.creditAvailable(cn) === 0,
      ),
    ).toBe(true);
    const twins = issued
      .flatMap((cn) => cn.lines.flatMap((l) => l.returns))
      .map((p) => s.batches.find((b) => b.id === p.returnBatchId)!);
    expect(twins.some((b) => !b.quarantined && b.qty > 0)).toBe(true);
    expect(
      twins.some(
        (b) =>
          s.adjustments.some((a) => a.batchId === b.id && a.reason === 'damaged') && b.qty === 0,
      ),
    ).toBe(true);
    assertInvariants(s);
  });
});

describe('invoicing from deliveries', () => {
  function setup() {
    const data = stocked();
    const { s, customer, p } = data;
    A.saveContact(s, { ...customer, paymentTermsDays: 45 }, customer.id);
    const order = (discountPercent = 10, taxRate = 10, customerId = customer.id) => {
      const o = A.saveOrder(s, {
        customerId,
        date: A.today(),
        requestedDate: A.today(),
        fulfilment: 'delivery',
        discountPercent,
        taxRate,
        lines: [{ productId: p.id, qty: 6, price: 5 }],
      });
      A.confirmOrder(s, o.id);
      return o;
    };
    const deliver = (o: ReturnType<typeof order>, qty = 1, date = A.shift(-2)) => {
      const d = A.createDelivery(s, {
        orderId: o.id,
        warehouseId: 'wh_main',
        lines: [{ orderLineId: o.lines[0].id, qty }],
      });
      A.dispatchDelivery(s, d.id, { date, driver: 'Dara' });
      return d;
    };
    return { ...data, order, deliver };
  }
  it('copies one line per delivery line, totals each order discount and defaults due from customer terms', () => {
    const { s, order, deliver } = setup();
    const first = order(10),
      second = order(20);
    const a = deliver(first, 2),
      b = deliver(second, 3);
    const invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: [a.id, b.id] });
    expect(invoice.lines.map((l) => [l.productId, l.qty, l.price])).toEqual([
      [a.lines[0].productId, 2, 5],
      [b.lines[0].productId, 3, 5],
    ]);
    expect(invoice).toMatchObject({
      status: 'Draft',
      subtotal: 25,
      discount: 4,
      taxRate: 10,
      taxAmount: 2.1,
      total: 23.1,
      date: A.today(),
      due: A.shift(45),
    });
    expect(invoice.orderId).toBeUndefined();
    expect(invoice.lines[0]).not.toBe(a.lines[0]);
    assertInvariants(s);
  });
  it('sets orderId for two deliveries from one partly delivered order and rounds discount per order', () => {
    const { s, order, deliver } = setup();
    const o = order(0.1);
    const a = deliver(o),
      b = deliver(o);
    const invoice = A.createInvoiceFromDeliveries(s, {
      deliveryIds: [a.id, b.id],
      date: A.shift(-1),
      notes: ' Monthly bill ',
    });
    expect(invoice).toMatchObject({
      orderId: o.id,
      discount: 0.01,
      due: A.shift(45, A.shift(-1)),
      notes: 'Monthly bill',
    });
    expect(A.openQty(s, o, o.lines[0].id)).toBe(4);
    assertInvariants(s);
  });
  it.each([
    'mixed customers',
    'mixed tax',
    'invoiced',
    'drafted',
    'Picking',
    'Returned',
    'empty',
    'duplicate',
  ])('rejects %s atomically', (kind) => {
    const { s, order, deliver, customer } = setup();
    const o = order(),
      a = deliver(o);
    let ids = [a.id];
    let message = '';
    if (kind === 'mixed customers') {
      const other = A.saveContact(s, { ...customer, name: 'Other customer' });
      ids.push(deliver(order(10, 10, other.id)).id);
      message = 'Select deliveries for the same customer.';
    } else if (kind === 'mixed tax') {
      ids.push(deliver(order(10, 0)).id);
      message = 'Invoice deliveries with different tax rates separately.';
    } else if (kind === 'invoiced' || kind === 'drafted') {
      const invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: ids });
      if (kind === 'invoiced') A.issueInvoice(s, invoice.id);
      message =
        kind === 'invoiced'
          ? `${a.number} is already invoiced (${invoice.number}).`
          : `${a.number} is on draft ${invoice.number}.`;
    } else if (kind === 'Picking') {
      const d = A.createDelivery(s, { orderId: o.id, warehouseId: 'wh_main' });
      ids = [d.id];
      message = `${d.number} must be Dispatched or Delivered.`;
    } else if (kind === 'Returned') {
      A.markNotDelivered(s, a.id, 'Customer closed');
      message = `${a.number} must be Dispatched or Delivered.`;
    } else if (kind === 'empty') {
      ids = [];
      message = 'Select at least one delivery.';
    } else {
      ids.push(a.id);
      message = 'Select distinct deliveries.';
    }
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => A.createInvoiceFromDeliveries(copy, { deliveryIds: ids })),
    ).toThrow(message);
    expect(s).toEqual(before);
    assertInvariants(s);
  });
  it('validates creation and header dates against today, latest dispatch and due date', () => {
    const { s, order, deliver } = setup();
    const o = order(),
      a = deliver(o, 1, A.shift(-3)),
      b = deliver(o, 1, A.shift(-1));
    for (const input of [
      { date: A.shift(1) },
      { date: A.shift(-2) },
      { date: A.today(), due: A.shift(-1) },
      { date: 'invalid' },
    ]) {
      expect(() =>
        A.transact(s, (copy) =>
          A.createInvoiceFromDeliveries(copy, { deliveryIds: [a.id, b.id], ...input }),
        ),
      ).toThrow();
    }
    const invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: [a.id, b.id] });
    expect(() =>
      A.transact(s, (copy) =>
        A.saveInvoiceHeader(copy, invoice.id, { date: A.shift(-2), due: A.today(), notes: '' }),
      ),
    ).toThrow('Invoice date cannot be before the latest delivery date.');
    assertInvariants(s);
  });
  it('issues with only receivable, revenue and tax, links both deliveries and skips credit and stock checks', () => {
    const { s, order, deliver, customer, p } = setup();
    const o = order(),
      a = deliver(o, 2),
      b = deliver(o);
    const invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: [a.id, b.id] });
    A.saveContact(
      s,
      { ...customer, onHold: true, holdReason: 'Account frozen', creditLimit: 0 },
      customer.id,
    );
    p.active = false;
    const moves = structuredClone(s.stockMoves),
      batches = structuredClone(s.batches),
      journal = structuredClone(s.journal),
      balances = A.balances(s);
    A.issueInvoice(s, invoice.id);
    expect(s.stockMoves).toEqual(moves);
    expect(s.batches).toEqual(batches);
    expect(s.journal).toHaveLength(journal.length + 1);
    expect(s.journal[0].entries).toEqual([
      { account: 'receivable', debit: 14.85, credit: 0 },
      { account: 'revenue', debit: 0, credit: 13.5 },
      { account: 'tax', debit: 0, credit: 1.35 },
    ]);
    expect(A.balances(s).cogs).toEqual(balances.cogs);
    expect(A.balances(s).inventory).toEqual(balances.inventory);
    expect([a.invoiceId, b.invoiceId]).toEqual([invoice.id, invoice.id]);
    expect(A.invoicedQty(s, o, o.lines[0].id)).toBe(3);
    expect(() => A.issueInvoice(s, invoice.id)).toThrow('Only draft invoices can be issued.');
    assertInvariants(s);
  });
  it('rechecks delivery status and links when issuing without partially posting', () => {
    const { s, order, deliver } = setup();
    const a = deliver(order()),
      invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: [a.id] });
    const before = structuredClone(s);
    // Simulate a stale/corrupt draft: the return operation now prevents this state.
    expect(() =>
      A.transact(s, (copy) => {
        copy.deliveries.find((d) => d.id === a.id)!.status = 'Returned';
        A.issueInvoice(copy, invoice.id);
      }),
    ).toThrow(`${a.number} must be Dispatched or Delivered.`);
    expect(s).toEqual(before);
    A.deleteDraft(s, invoice.id);
    assertInvariants(s);
  });
  it('locks delivery lines, saves headers for both kinds, refuses reservations and frees deleted drafts', () => {
    const { s, order, deliver, customer, p } = setup();
    const d = deliver(order()),
      invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: [d.id] });
    expect(() =>
      A.createInvoice(s, { ...invoice, lines: [{ ...invoice.lines[0], qty: 2 }] }, invoice.id),
    ).toThrow("Lines come from delivery notes and can't be edited.");
    expect(() => A.reserveInvoice(s, invoice.id)).toThrow(
      'Delivery drafts cannot reserve stock. Their stock has already left.',
    );
    A.saveInvoiceHeader(s, invoice.id, {
      date: A.shift(-1),
      due: A.shift(10),
      notes: ' Reviewed ',
    });
    expect(invoice).toMatchObject({ date: A.shift(-1), due: A.shift(10), notes: 'Reviewed' });
    const direct = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [{ productId: p.id, qty: 1 }],
    });
    A.saveInvoiceHeader(s, direct.id, { date: A.shift(-1), due: A.today(), notes: 'Pickup' });
    expect(direct.notes).toBe('Pickup');
    expect(A.deliveredNotInvoiced(s)).toEqual([]);
    const number = invoice.number;
    A.deleteDraft(s, invoice.id);
    expect(A.deliveredNotInvoiced(s).map((r) => r.delivery.id)).toEqual([d.id]);
    expect(A.createInvoiceFromDeliveries(s, { deliveryIds: [d.id] }).number).not.toBe(number);
    assertInvariants(s);
  });
  it('reports per-delivery late after one day, monthly late only in earlier months, and excludes drafts', () => {
    const { s, order, deliver, customer } = setup();
    const o = order(),
      old = deliver(o, 1, A.shift(-2)),
      yesterday = deliver(o, 1, A.shift(-1));
    expect(A.deliveredNotInvoiced(s).find((r) => r.delivery.id === old.id)).toMatchObject({
      value: 4.95,
      ageDays: 2,
      late: true,
    });
    expect(A.deliveredNotInvoiced(s).find((r) => r.delivery.id === yesterday.id)?.late).toBe(false);
    A.saveContact(s, { ...customer, billing: 'monthly' }, customer.id);
    const prior = deliver(o, 1, A.shift(-1, A.today().slice(0, 7) + '-01'));
    const current = deliver(o, 1, A.today().slice(0, 7) + '-01');
    const report = A.deliveredNotInvoiced(s, { customerId: customer.id });
    expect(report.find((r) => r.delivery.id === prior.id)?.late).toBe(true);
    expect(report.find((r) => r.delivery.id === current.id)?.late).toBe(false);
    A.createInvoiceFromDeliveries(s, { deliveryIds: [prior.id] });
    expect(A.deliveredNotInvoiced(s).some((r) => r.delivery.id === prior.id)).toBe(false);
    expect(A.deliveredNotInvoiced(s, { customerId: 'missing' })).toEqual([]);
    expect(A.deliveredNotInvoiced(s, { asOf: A.shift(-1, prior.date!) })).toEqual([]);
    assertInvariants(s);
  });
  it('keeps uninvoiced deliveries in exposure through drafting, issuing and deleting without double counting', () => {
    const { s, order, deliver, customer } = setup();
    const o = order(),
      initial = A.creditCheck(s, customer.id, 0).exposure;
    const d = deliver(o, 2);
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(initial);
    const invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: [d.id] });
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(initial);
    A.deleteDraft(s, invoice.id);
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(initial);
    A.issueInvoice(s, A.createInvoiceFromDeliveries(s, { deliveryIds: [d.id] }).id);
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(initial);
    assertInvariants(s);
  });
  it('validates draft line snapshots, order links and direct-sale separation', () => {
    const { s, order, deliver, customer, p } = setup();
    const d = deliver(order()),
      invoice = A.createInvoiceFromDeliveries(s, { deliveryIds: [d.id] });
    for (const key of ['productId', 'name', 'sku', 'unit', 'factor', 'qty', 'price'] as const) {
      const copy = structuredClone(s),
        line = copy.invoices[0].lines[0];
      Object.assign(line, {
        [key]: typeof line[key] === 'number' ? Number(line[key]) + 1 : 'changed',
      });
      expect(() => A.validateBackup(copy)).toThrow();
    }
    const wrong = structuredClone(s);
    wrong.invoices[0].orderId = 'missing';
    expect(() => A.validateBackup(wrong)).toThrow('Invoice order does not match its deliveries.');
    const duplicate = structuredClone(s);
    duplicate.invoices.push({ ...duplicate.invoices[0], id: 'another-invoice' });
    expect(() => A.validateBackup(duplicate)).toThrow();
    A.issueInvoice(s, invoice.id);
    const direct = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [{ productId: p.id, qty: 1 }],
    });
    A.issueInvoice(s, direct.id);
    const mixed = structuredClone(s);
    const directCopy = mixed.invoices.find((i) => i.id === direct.id)!,
      deliveryCopy = mixed.invoices.find((i) => i.id === invoice.id)!;
    const dn = mixed.deliveries.find((d) => d.id === directCopy.deliveryIds[0])!;
    dn.invoiceId = deliveryCopy.id;
    deliveryCopy.deliveryIds.push(dn.id);
    delete deliveryCopy.orderId;
    mixed.invoices = mixed.invoices.filter((i) => i.id !== direct.id);
    expect(() => A.validateBackup(mixed)).toThrow(
      'An invoice cannot mix order deliveries and direct-sale deliveries.',
    );
    assertInvariants(s);
  });
  it('seeds late Greenlife, combined last-month Sunrise billing, current unbilled deliveries and a draft', () => {
    const s = A.seed(),
      report = A.deliveredNotInvoiced(s);
    expect(report.some((r) => r.customerId === 'c1' && r.ageDays === 3 && r.late)).toBe(true);
    expect(report.some((r) => r.customerId === 'c5' && !r.late)).toBe(true);
    expect(
      s.invoices.some(
        (i) =>
          i.customerId === 'c5' &&
          i.status === 'Issued' &&
          i.deliveryIds.length === 2 &&
          i.date.slice(0, 7) < A.today().slice(0, 7),
      ),
    ).toBe(true);
    expect(s.invoices.some((i) => i.status === 'Draft' && i.deliveryIds.length)).toBe(true);
    assertInvariants(s);
  });
});

describe('delivery migration', () => {
  it('migrates a v2 seed without changing any account balance or batch quantity', () => {
    const current = A.seed();
    const raw = legacyBackup(current, true);
    const orders = structuredClone(raw.orders);
    const before = A.balances(raw);
    const journal = structuredClone(raw.journal),
      moves = structuredClone(raw.stockMoves);
    const quantities = raw.batches.map((b: { id: string; qty: number }) => [b.id, b.qty]);
    const expected = raw.invoices
      .filter((i: { status: string }) => i.status === 'Issued')
      .map(
        (i: {
          id: string;
          allocations: { batchId: string; qty: number; cost: number }[];
          cogs: number;
        }) => ({ id: i.id, picks: i.allocations, cost: i.cogs }),
      );
    const migrated = A.migrate(raw);
    expect(migrated.version).toBe(4);
    expect(A.balances(migrated)).toEqual(before);
    expect(migrated.orders).toEqual(orders);
    expect(migrated.journal).toEqual(journal);
    expect(migrated.stockMoves).toEqual(moves);
    expect(migrated.batches.map((b) => [b.id, b.qty])).toEqual(quantities);
    for (const old of expected) {
      const invoice = migrated.invoices.find((i) => i.id === old.id)!;
      const delivery = migrated.deliveries.find((d) => d.id === invoice.deliveryIds[0])!;
      expect(invoice.deliveryIds).toHaveLength(1);
      expect(delivery).toMatchObject({
        legacy: true,
        status: 'Delivered',
        method: 'pickup',
        invoiceId: invoice.id,
        cost: old.cost,
      });
      expect(
        delivery.lines
          .flatMap((l) => l.picks)
          .map((p) => ({ batchId: p.batchId, qty: p.qty, cost: p.cost })),
      ).toEqual(
        old.picks.map((p: { batchId: string; qty: number; cost: number }) => ({
          batchId: p.batchId,
          qty: p.qty,
          cost: p.cost,
        })),
      );
    }
    expect(migrated.invoices.every((i) => !('allocations' in i) && !('cogs' in i))).toBe(true);
    expect(A.migrate(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
    assertInvariants(migrated);
  });
});
describe('picking and delivery', () => {
  function setup(qty = 15, method: 'delivery' | 'pickup' = 'delivery') {
    const data = stocked();
    const order = A.saveOrder(data.s, {
      customerId: data.customer.id,
      date: A.today(),
      requestedDate: A.today(),
      fulfilment: method,
      deliveryAddress: 'Receiving desk',
      lines: [{ productId: data.p.id, qty }],
    });
    A.confirmOrder(data.s, order.id);
    return { ...data, order };
  }
  it('proposes FEFO from the selected warehouse without moving stock or posting cost', () => {
    const { s, order, p, supplier, early, late } = setup();
    A.receiveStock(s, {
      productId: p.id,
      qty: 10,
      cost: 2,
      code: 'BRANCH',
      expiry: A.shift(5),
      warehouseId: 'wh_branch',
      supplierId: supplier.id,
      payment: 'credit',
    });
    const moves = structuredClone(s.stockMoves),
      journal = structuredClone(s.journal);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    expect(d).toMatchObject({
      number: 'DN-0001',
      status: 'Picking',
      method: 'delivery',
      address: 'Receiving desk',
      cost: 0,
      createdBy: CURRENT_USER,
    });
    expect(d.lines[0].picks.map((p) => [p.batchId, p.qty, p.cost])).toEqual([
      [early.id, 10, 0],
      [late.id, 5, 0],
    ]);
    expect(s.stockMoves).toEqual(moves);
    expect(s.journal).toEqual(journal);
    assertInvariants(s);
  });
  it('respects customer shelf life, short-dated consent and another customer hold', () => {
    const { s, order, p, customer, early, late } = setup(30);
    customer.minShelfLifeDays = 90;
    s.reservations
      .filter((r) => r.sourceId === order.id)
      .forEach((r) => A.releaseReservation(s, r.id));
    const other = A.saveContact(s, { ...customer, name: 'Other customer' });
    A.holdStock(s, { customerId: other.id, productId: p.id, qty: 7 });
    A.reserveOrder(s, order.id);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    expect(d.lines[0].qty).toBe(13);
    expect(d.lines[0].picks.map((p) => p.batchId)).toEqual([late.id]);
    A.cancelDelivery(s, d.id);
    order.allowShortDated = true;
    const consent = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    expect(consent.lines[0].qty).toBe(23);
    expect(consent.lines[0].picks[0]).toMatchObject({ batchId: early.id, qty: 10 });
    assertInvariants(s);
  });
  it('skips counted warehouses and reports when nothing can be picked there', () => {
    const { s, order, p, supplier } = setup();
    A.startCount(s, { warehouseId: 'wh_main' });
    expect(() =>
      A.transact(s, (copy) =>
        A.createDelivery(copy, { orderId: order.id, warehouseId: 'wh_main' }),
      ),
    ).toThrow('Nothing can be picked from Central warehouse for this order.');
    A.receiveStock(s, {
      productId: p.id,
      qty: 5,
      cost: 2,
      code: 'BRANCH',
      expiry: A.shift(100),
      warehouseId: 'wh_branch',
      supplierId: supplier.id,
      payment: 'credit',
    });
    expect(A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_branch' }).lines[0].qty).toBe(
      5,
    );
    assertInvariants(s);
  });
  it('does not plan the same open quantity twice and validates explicit quantities', () => {
    const { s, order } = setup();
    A.createDelivery(s, {
      orderId: order.id,
      warehouseId: 'wh_main',
      lines: [{ orderLineId: order.lines[0].id, qty: 10 }],
    });
    const before = structuredClone(s);
    for (const qty of [0, -1, 1.5, 6])
      expect(() =>
        A.transact(s, (copy) =>
          A.createDelivery(copy, {
            orderId: order.id,
            warehouseId: 'wh_main',
            lines: [{ orderLineId: order.lines[0].id, qty }],
          }),
        ),
      ).toThrow();
    expect(s).toEqual(before);
    expect(A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' }).lines[0].qty).toBe(5);
    expect(() => A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' })).toThrow(
      'Nothing can be picked',
    );
    assertInvariants(s);
  });
  it('caps repeated product lines together and picks whole packs only', () => {
    const { s, p, customer } = stocked();
    A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 12, barcode: '' }] }, p.id);
    const order = A.saveOrder(s, {
      customerId: customer.id,
      date: A.today(),
      requestedDate: A.today(),
      fulfilment: 'delivery',
      lines: [
        { productId: p.id, unit: 'carton', qty: 2 },
        { productId: p.id, qty: 12 },
      ],
    });
    A.confirmOrder(s, order.id);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    expect(d.lines.map((l) => l.qty)).toEqual([2, 6]);
    A.dispatchDelivery(s, d.id);
    expect(A.deliveredQty(s, order, order.lines[0].id)).toBe(2);
    expect(A.deliveredQty(s, order, order.lines[1].id)).toBe(6);
    assertInvariants(s);
  });
  it('setPicks accepts eligible alternatives and rejects wrong totals, lots, warehouses and excess stock', () => {
    const { s, order, p, early, late, supplier } = setup(5);
    const branch = A.receiveStock(s, {
      productId: p.id,
      qty: 10,
      cost: 2,
      code: 'BRANCH',
      expiry: A.shift(100),
      warehouseId: 'wh_branch',
      supplierId: supplier.id,
      payment: 'credit',
    });
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    const change = (picks: { batchId: string; qty: number }[]) =>
      A.transact(s, (copy) => A.setPicks(copy, d.id, d.lines[0].id, picks));
    for (const picks of [
      [{ batchId: branch.id, qty: 5 }],
      [{ batchId: late.id, qty: 4 }],
      [{ batchId: late.id, qty: 21 }],
      [
        { batchId: late.id, qty: 2 },
        { batchId: late.id, qty: 3 },
      ],
    ])
      expect(() => change(picks)).toThrow();
    A.setQuarantine(s, early.id, true);
    expect(() => change([{ batchId: early.id, qty: 5 }])).toThrow('eligible lot');
    A.setPicks(s, d.id, d.lines[0].id, [{ batchId: late.id, qty: 5 }]);
    expect(d.lines[0].picks).toMatchObject([{ batchId: late.id, qty: 5, cost: 0 }]);
    assertInvariants(s);
  });
  it('dispatch posts exactly one sale per pick and COGS, updates delivered quantities and reservations', () => {
    const { s, order, early, late } = setup(20);
    const d = A.createDelivery(s, {
      orderId: order.id,
      warehouseId: 'wh_main',
      lines: [{ orderLineId: order.lines[0].id, qty: 15 }],
    });
    const receivable = A.balances(s).receivable.balance;
    A.dispatchDelivery(s, d.id, { date: A.shift(-1), driver: 'Dara' });
    expect(d).toMatchObject({
      status: 'Dispatched',
      driver: 'Dara',
      cost: 40,
      dispatchedBy: CURRENT_USER,
      date: A.shift(-1),
    });
    expect(s.stockMoves.filter((m) => m.sourceId === d.id)).toMatchObject([
      { batchId: early.id, qty: -10, type: 'sale', reference: d.number },
      { batchId: late.id, qty: -5, type: 'sale', reference: d.number },
    ]);
    expect(A.balances(s).cogs.balance).toBe(40);
    expect(A.balances(s).receivable.balance).toBe(receivable);
    expect(A.deliveredQty(s, order, order.lines[0].id)).toBe(15);
    expect(A.openQty(s, order, order.lines[0].id)).toBe(5);
    expect(A.orderLineReserved(s, order, order.lines[0].id)).toBe(5);
    expect(A.fulfilmentStatus(s, order)).toBe('Partly delivered');
    expect(order.status).toBe('Confirmed');
    const snapshot = structuredClone(s);
    expect(() => A.dispatchDelivery(s, d.id)).toThrow('Delivery must be Picking.');
    expect(s).toEqual(snapshot);
    assertInvariants(s);
  });
  it('closes a fully dispatched order, then confirmation records receipt without posting again', () => {
    const { s, order } = setup(5);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, d.id);
    expect(order.status).toBe('Done');
    expect(order.closedAt).toBeTruthy();
    expect(A.fulfilmentStatus(s, order)).toBe('Delivered');
    expect(A.orderLineReserved(s, order, order.lines[0].id)).toBe(0);
    const balances = A.balances(s),
      moves = structuredClone(s.stockMoves),
      journal = structuredClone(s.journal);
    expect(() => A.confirmDelivered(s, d.id, { receivedBy: ' ' })).toThrow('Enter who received');
    A.confirmDelivered(s, d.id, { receivedBy: ' Receiving desk ' });
    expect(d).toMatchObject({ status: 'Delivered', receivedBy: 'Receiving desk' });
    expect(A.balances(s)).toEqual(balances);
    expect(s.stockMoves).toEqual(moves);
    expect(s.journal).toEqual(journal);
    assertInvariants(s);
  });
  it.each(['quarantine', 'recall', 'stock', 'count', 'shelf life'] as const)(
    'dispatch rolls back when a picked lot changes: %s',
    (change) => {
      const { s, order, early, customer, p } = setup(5);
      const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
      if (change === 'quarantine') A.setQuarantine(s, early.id, true);
      if (change === 'recall')
        A.createRecall(s, { productId: p.id, lotCode: early.code, reason: 'Supplier notice' });
      if (change === 'stock') A.adjustStock(s, { batchId: early.id, qty: -8, reason: 'damaged' });
      if (change === 'count') A.startCount(s, { warehouseId: 'wh_main' });
      if (change === 'shelf life') customer.minShelfLifeDays = 60;
      const before = structuredClone(s);
      expect(() => A.transact(s, (copy) => A.dispatchDelivery(copy, d.id))).toThrow(
        'Lot EARLY changed since picking. Update the picks.',
      );
      expect(s).toEqual(before);
      assertInvariants(s);
    },
  );
  it('pickup requires receivedBy and goes straight to Delivered; invalid dates roll back', () => {
    const { s, order } = setup(5, 'pickup');
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    expect(d.method).toBe('pickup');
    for (const input of [
      {},
      { receivedBy: 'Desk', date: A.shift(1) },
      { receivedBy: 'Desk', date: 'invalid' },
    ])
      expect(() => A.transact(s, (copy) => A.dispatchDelivery(copy, d.id, input))).toThrow();
    A.dispatchDelivery(s, d.id, { receivedBy: 'Customer' });
    expect(d).toMatchObject({ status: 'Delivered', receivedBy: 'Customer', driver: '' });
    assertInvariants(s);
  });
  it('cancels Picking without stock or accounting changes, freeing planned open quantity', () => {
    const { s, order } = setup();
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    const balances = A.balances(s),
      moves = structuredClone(s.stockMoves);
    A.cancelDelivery(s, d.id);
    expect(d.status).toBe('Cancelled');
    expect(A.balances(s)).toEqual(balances);
    expect(s.stockMoves).toEqual(moves);
    expect(A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' }).lines[0].qty).toBe(
      15,
    );
    assertInvariants(s);
  });
  it('returns into a quarantined twin at original cost, reverses COGS and reopens a Done order', () => {
    const { s, order, early, p } = setup(5);
    const before = A.balances(s),
      inventory = A.inventoryValue(s);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, d.id);
    expect(order.status).toBe('Done');
    A.markNotDelivered(s, d.id, 'Customer closed, redeliver tomorrow');
    const twin = s.batches.find((b) => b.id !== early.id && b.code === early.code)!;
    expect(twin).toMatchObject({
      qty: 5,
      quarantined: true,
      productId: early.productId,
      warehouseId: early.warehouseId,
      expiry: early.expiry,
      cost: early.cost,
      received: early.received,
    });
    expect(early.qty).toBe(5);
    expect(A.available(s, p.id)).toBe(25);
    expect(A.balances(s)).toEqual({
      ...before,
      cogs: { debit: 15, credit: 15, balance: 0 },
      inventory: {
        ...before.inventory,
        debit: before.inventory.debit + 15,
        credit: before.inventory.credit + 15,
      },
    });
    expect(A.inventoryValue(s)).toBe(inventory);
    expect(d.status).toBe('Returned');
    expect(order.status).toBe('Confirmed');
    expect(order.closedAt).toBeUndefined();
    expect(A.deliveredQty(s, order, order.lines[0].id)).toBe(0);
    expect(A.openQty(s, order, order.lines[0].id)).toBe(5);
    expect(A.orderLineReserved(s, order, order.lines[0].id)).toBe(5);
    assertInvariants(s);
  });
  it('reuses a matching quarantined twin and returnToStock can also return to clean stock', () => {
    const { s, order, early } = setup(5);
    const first = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, first.id);
    A.markNotDelivered(s, first.id, 'Closed');
    const twin = s.batches.find((b) => b.quarantined)!;
    const second = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, second.id);
    A.markNotDelivered(s, second.id, 'Closed again');
    expect(twin.qty).toBe(10);
    expect(s.batches.filter((b) => b.quarantined)).toHaveLength(1);
    // Shared helper changes stock only; its caller posts the matching accounting reversal.
    const returned = A.returnToStock(s, {
      batchId: early.id,
      qty: 1,
      quarantine: false,
      reference: 'RETURN-TEST',
      sourceId: 'test',
      counterpartyId: order.customerId,
      date: A.today(),
    });
    A.ledger(s, A.today(), 'RETURN-TEST', 'Test return', [
      { account: 'inventory', debit: early.cost },
      { account: 'cogs', credit: early.cost },
    ]);
    expect(returned.id).toBe(early.id);
    expect(early.qty).toBe(1);
    assertInvariants(s);
  });
  it('refuses not-delivered once invoiced and does not change stock or journals', () => {
    const { s, order } = setup(5);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, d.id);
    // 005 will create this link; isolate the guard without adding order invoicing here.
    const result = A.transact(s, (copy) => {
      copy.deliveries.find((item) => item.id === d.id)!.invoiceId = 'future-invoice';
      expect(() => A.markNotDelivered(copy, d.id, 'Closed')).toThrow(
        'This delivery is invoiced. Issue a credit note instead.',
      );
    });
    expect(result.state.stockMoves).toEqual(s.stockMoves);
    expect(result.state.journal).toEqual(s.journal);
    assertInvariants(s);
  });
  it('refuses not-delivered on a draft invoice until the draft is deleted', () => {
    const { s, order } = setup(5);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, d.id);
    const draft = A.createInvoiceFromDeliveries(s, { deliveryIds: [d.id] });
    expect(d.invoiceId).toBeUndefined();
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.markNotDelivered(copy, d.id, 'Closed'))).toThrow(
      `${d.number} is on draft ${draft.number}. Delete the draft first.`,
    );
    expect(s).toEqual(before);
    assertInvariants(s);
    A.deleteDraft(s, draft.id);
    A.markNotDelivered(s, d.id, 'Closed');
    expect(d.status).toBe('Returned');
    assertInvariants(s);
  });
  it.each([5, 8])('cancels only unpicked quantities of an order for %i', (qty) => {
    const { s, order } = setup(qty);
    const d = A.createDelivery(s, {
      orderId: order.id,
      warehouseId: 'wh_main',
      lines: [{ orderLineId: order.lines[0].id, qty: 5 }],
    });
    A.cancelRemaining(s, order.id, { reason: 'No more deliveries needed' });
    expect(order.status).toBe('Confirmed');
    expect(order.lines[0].cancelledQty).toBe(qty - 5);
    expect(d.status).toBe('Picking');
    expect(A.pendingDeliveryQty(s, order, order.lines[0].id)).toBe(0);
    assertInvariants(s);
    A.dispatchDelivery(s, d.id);
    expect(d.status).toBe('Dispatched');
    expect(order.status).toBe('Done');
    expect(A.deliveredQty(s, order, order.lines[0].id)).toBe(5);
    assertInvariants(s);
  });
  it('cancelOrder refuses after partial delivery and cancelRemaining closes the remainder', () => {
    const { s, order } = setup(15);
    const d = A.createDelivery(s, {
      orderId: order.id,
      warehouseId: 'wh_main',
      lines: [{ orderLineId: order.lines[0].id, qty: 5 }],
    });
    A.dispatchDelivery(s, d.id);
    expect(() => A.transact(s, (copy) => A.cancelOrder(copy, order.id, 'Cancelled'))).toThrow(
      'Part of this order was delivered. Cancel the remaining quantities instead.',
    );
    A.cancelRemaining(s, order.id, { reason: 'Remainder no longer needed' });
    expect(order.status).toBe('Done');
    expect(order.lines[0].cancelledQty).toBe(10);
    assertInvariants(s);
  });
  it('direct issue creates one pickup, posts receivable and COGS once, and fulfils its reservation', () => {
    const { s, p, customer } = stocked();
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [{ productId: p.id, qty: 15 }],
      discount: 5,
      taxRate: 10,
    });
    A.reserveInvoice(s, invoice.id);
    A.issueInvoice(s, invoice.id);
    const deliveries = A.deliveriesOf(s, invoice);
    expect(deliveries).toHaveLength(1);
    expect(s.deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      method: 'pickup',
      status: 'Delivered',
      invoiceId: invoice.id,
      receivedBy: customer.name,
      cost: 40,
    });
    expect(deliveries[0].orderId).toBeUndefined();
    expect(deliveries[0].warehouseId).toBeUndefined();
    expect(A.balances(s).receivable.balance).toBe(invoice.total);
    expect(A.balances(s).cogs.balance).toBe(40);
    expect(A.invoiceCost(s, invoice)).toBe(40);
    expect(A.invoicePicks(s, invoice)).toHaveLength(2);
    const entry = s.journal.find((j) => j.reference === invoice.number)!;
    expect(entry.entries.map((e) => e.account)).toEqual(['receivable', 'revenue', 'tax']);
    expect(s.reservations[0].status).toBe('Fulfilled');
    assertInvariants(s);
  });
  it('validates delivery fields, links, pick totals, sale/return moves and invoice product totals', () => {
    const { s, order } = setup(5);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, d.id);
    A.markNotDelivered(s, d.id, 'Closed');
    const corruptions: ((copy: Workspace) => void)[] = [
      (copy) => {
        copy.deliveries[0].returnReason = '';
      },
      (copy) => {
        copy.deliveries[0].lines[0].picks[0].qty++;
      },
      (copy) => {
        copy.deliveries[0].cost++;
      },
      (copy) => {
        copy.deliveries[0].invoiceId = 'missing';
      },
      (copy) => {
        copy.deliveries[0].status = 'Delivered';
      },
      (copy) => {
        copy.stockMoves.find((m) => m.sourceId === d.id && m.type === 'sale')!.sourceId = 'missing';
      },
      (copy) => {
        copy.stockMoves.find((m) => m.sourceId === d.id && m.type === 'return')!.sourceId =
          'missing';
      },
      (copy) => {
        copy.stockMoves.push({
          ...copy.stockMoves.find((m) => m.sourceId === d.id && m.type === 'sale')!,
          id: 'duplicate',
        });
      },
    ];
    corruptions.forEach((change) => {
      const copy = structuredClone(s);
      change(copy);
      expect(() => A.validateBackup(copy)).toThrow();
    });
    assertInvariants(s);
  });
  it('keeps changed picking plans valid as snapshots and blocks stale dispatch after order edits', () => {
    const { s, order } = setup(15);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.saveOrder(s, { ...order, lines: [{ ...order.lines[0], price: 6 }] }, order.id);
    const snapshot = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.dispatchDelivery(copy, d.id))).toThrow(
      'Order changed since picking. Cancel this delivery and create it again.',
    );
    expect(s).toEqual(snapshot);
    A.cancelDelivery(s, d.id);
    const updated = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    expect(updated.lines[0].price).toBe(6);
    A.dispatchDelivery(s, updated.id);
    assertInvariants(s);
  });
  it('retains cancelled and returned line history when an undelivered order line is removed', () => {
    const { s, order, p } = setup(5);
    const d = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.dispatchDelivery(s, d.id);
    A.markNotDelivered(s, d.id, 'Closed');
    const planned = A.createDelivery(s, { orderId: order.id, warehouseId: 'wh_main' });
    A.saveOrder(s, { ...order, lines: [{ productId: p.id, qty: 3 }] }, order.id);
    expect(() => A.transact(s, (copy) => A.dispatchDelivery(copy, planned.id))).toThrow(
      'Order changed since picking.',
    );
    assertInvariants(s);
  });
  it('recall trace groups unbilled picks by DN, resolves legacy invoice links and accounts for returns', () => {
    const { s, order, p, early } = setup(15);
    const first = A.createDelivery(s, {
      orderId: order.id,
      warehouseId: 'wh_main',
      lines: [{ orderLineId: order.lines[0].id, qty: 5 }],
    });
    const second = A.createDelivery(s, {
      orderId: order.id,
      warehouseId: 'wh_main',
      lines: [{ orderLineId: order.lines[0].id, qty: 5 }],
    });
    A.dispatchDelivery(s, first.id);
    A.dispatchDelivery(s, second.id);
    A.markNotDelivered(s, second.id, 'Closed');
    const recall = A.createRecall(s, {
      productId: p.id,
      lotCode: early.code,
      reason: 'Supplier notice',
    });
    const trace = A.recallTrace(s, recall.id);
    expect(trace.sold.map((r) => [r.delivery, r.invoice, r.qty])).toEqual([
      [first.number, '—', 5],
      [second.number, '—', 5],
    ]);
    expect(
      trace.totals.received - trace.totals.sold + trace.totals.returned + trace.totals.adjusted,
    ).toBe(trace.totals.onHand);
    assertInvariants(s);
    const migrated = A.validateBackup(legacyBackup(A.seed()));
    const legacy = migrated.deliveries.find((d) => d.legacy && d.lines[0].picks.length)!;
    const lot = legacy.lines[0].picks[0];
    let r = migrated.recalls.find(
      (r) =>
        r.productId === legacy.lines[0].productId &&
        r.lotCode.toLowerCase() === lot.lotCode.toLowerCase(),
    );
    if (!r)
      r = A.createRecall(migrated, {
        productId: legacy.lines[0].productId,
        lotCode: lot.lotCode,
        reason: 'Migration trace',
      });
    expect(
      A.recallTrace(migrated, r.id).sold.some(
        (row) =>
          row.delivery === legacy.number &&
          row.invoice === migrated.invoices.find((i) => i.id === legacy.invoiceId)!.number,
      ),
    ).toBe(true);
    assertInvariants(migrated);
  });
  it('migrates repeated product allocations into lines in order and leaves draft deliveries empty', () => {
    const { s, p, customer } = stocked();
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [
        { productId: p.id, qty: 6 },
        { productId: p.id, qty: 9 },
      ],
    });
    A.issueInvoice(s, invoice.id);
    const draft = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      lines: [{ productId: p.id, qty: 1 }],
    });
    const raw = legacyBackup(s);
    // Old allocations can span two lines of the same product.
    raw.invoices.find((i: { id: string }) => i.id === invoice.id).allocations = [
      {
        batchId: s.batches[1].id,
        code: s.batches[1].code,
        warehouseId: s.batches[1].warehouseId,
        productId: p.id,
        qty: 10,
        cost: 3,
      },
      {
        batchId: s.batches[0].id,
        code: s.batches[0].code,
        warehouseId: s.batches[0].warehouseId,
        productId: p.id,
        qty: 5,
        cost: 2,
      },
    ];
    const migrated = A.validateBackup(raw);
    const delivery = A.deliveriesOf(
      migrated,
      migrated.invoices.find((i) => i.id === invoice.id)!,
    )[0];
    expect(delivery.lines.map((l) => l.picks.map((p) => p.qty))).toEqual([[6], [4, 5]]);
    expect(migrated.invoices.find((i) => i.id === draft.id)!.deliveryIds).toEqual([]);
    assertInvariants(migrated);
  });
  it('keeps the sale stock-move path exclusively in dispatchDelivery', () => {
    const source = ts.createSourceFile(
      'model.ts',
      readFileSync('src/lib/model.ts', 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const owners: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'moveStock'
      ) {
        const meta = node.arguments[3];
        if (
          meta &&
          ts.isObjectLiteralExpression(meta) &&
          meta.properties.some(
            (p) =>
              ts.isPropertyAssignment(p) &&
              p.name.getText(source) === 'type' &&
              ts.isStringLiteral(p.initializer) &&
              p.initializer.text === 'sale',
          )
        ) {
          let owner: ts.Node | undefined = node.parent;
          while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
          owners.push(owner && ts.isFunctionDeclaration(owner) ? owner.name!.text : '');
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(owners).toEqual(['dispatchDelivery']);
    assertInvariants(A.seed());
  });
  it('seed includes unbilled delivered, partial, picking, dispatched and returned examples', () => {
    const s = A.seed();
    for (const status of ['Picking', 'Dispatched', 'Returned', 'Delivered'])
      expect(s.deliveries.some((d) => d.orderId && d.status === status && !d.invoiceId)).toBe(true);
    expect(s.orders.some((o) => A.fulfilmentStatus(s, o) === 'Partly delivered')).toBe(true);
    assertInvariants(s);
  });
});
describe('sales orders and quotations', () => {
  function setup(qty = 10) {
    const data = stocked();
    const input: OrderInput = {
      customerId: data.customer.id,
      date: A.today(),
      requestedDate: A.shift(3),
      fulfilment: 'delivery',
      lines: [{ productId: data.p.id, qty }],
    };
    return { ...data, input };
  }
  it('defaults priceFor prices, date, address, tax, line ids and quote numbering', () => {
    const { s, p, customer, input } = setup();
    A.savePrice(s, { productId: p.id, unit: p.unit, customerId: customer.id, price: 4 });
    s.settings.taxRate = 10;
    const order = A.saveOrder(s, input);
    expect(order).toMatchObject({
      number: 'SO-0001',
      status: 'Quote',
      validUntil: A.shift(14),
      deliveryAddress: customer.address,
      discountPercent: 0,
      taxRate: 10,
      allowShortDated: false,
      createdBy: CURRENT_USER,
    });
    expect(order.id.startsWith('so_')).toBe(true);
    expect(order.lines[0]).toMatchObject({ price: 4, cancelledQty: 0, factor: 1 });
    expect(order.lines[0].id.startsWith('sol_')).toBe(true);
    expect(
      A.saveOrder(s, { ...input, lines: [{ productId: p.id, qty: 1, price: 9 }] }).lines[0].price,
    ).toBe(9);
    expect(s.orders.map((o) => o.number)).toEqual(['SO-0002', 'SO-0001']);
    assertInvariants(s);
  });
  it('validates customers, active products, units, quantities, percentages, and dates atomically', () => {
    const { s, p, supplier, input } = setup();
    const patches: Partial<OrderInput>[] = [
      { customerId: supplier.id },
      { customerId: 'missing' },
      { date: A.shift(1) },
      { date: '2026-02-30' },
      { requestedDate: A.shift(-1) },
      { validUntil: A.shift(-1) },
      { requestedDate: 'invalid' },
      { discountPercent: 101 },
      { taxRate: 101 },
      { lines: [] },
      { lines: [{ productId: 'missing', qty: 1 }] },
      { lines: [{ productId: p.id, unit: 'carton', qty: 1 }] },
      { lines: [{ productId: p.id, qty: 0.5 }] },
    ];
    for (const patch of patches)
      expect(() => A.transact(s, (copy) => A.saveOrder(copy, { ...input, ...patch }))).toThrow();
    p.active = false;
    expect(() => A.transact(s, (copy) => A.saveOrder(copy, input))).toThrow(
      `${p.name} is inactive.`,
    );
    p.active = true;
    expect(s.orders).toEqual([]);
    expect(s.counters.order).toBe(1);
    assertInvariants(s);
  });
  it('rejects an expired quote until it is re-saved with a new validUntil', () => {
    const { s, input } = setup();
    let order = A.saveOrder(s, { ...input, date: A.shift(-20), validUntil: A.shift(-1) });
    expect(A.quoteStatus(order)).toBe('Expired');
    expect(() => A.transact(s, (copy) => A.confirmOrder(copy, order.id))).toThrow(
      `Quote expired on ${A.shift(-1)}. Update and save it first.`,
    );
    order = A.saveOrder(s, { ...input, lines: order.lines, validUntil: A.shift(1) }, order.id);
    A.confirmOrder(s, order.id);
    expect(order).toMatchObject({ status: 'Confirmed', confirmedBy: CURRENT_USER });
    assertInvariants(s);
  });
  it('confirms despite short stock, reserving min(need, free) per product in base units', () => {
    const { s, p, input } = setup(40);
    A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 10, barcode: '' }] }, p.id);
    const other = A.saveProduct(s, { ...p, sku: 'OTHER', name: 'Other product', barcode: '' });
    A.receiveStock(s, {
      productId: other.id,
      qty: 8,
      cost: 2,
      code: 'OTHER',
      expiry: A.shift(100),
      warehouseId: 'wh_main',
      payment: 'cash',
    });
    const order = A.saveOrder(s, {
      ...input,
      lines: [
        { productId: p.id, unit: 'carton', qty: 4 },
        { productId: other.id, qty: 5 },
      ],
    });
    expect(() => A.confirmOrder(s, order.id)).not.toThrow();
    expect(
      s.reservations.filter((r) => r.sourceId === order.id).map((r) => [r.productId, r.qty]),
    ).toEqual([
      [other.id, 5],
      [p.id, 30],
    ]);
    expect(A.orderLineReserved(s, order, order.lines[0].id)).toBe(3);
    expect(A.openQty(s, order, order.lines[0].id)).toBe(4);
    expect(A.fulfilmentStatus(s, order)).toBe('Not delivered');
    assertInvariants(s);
  });
  it('blocks an on-hold customer and records an override using the existing credit pattern', () => {
    const { s, customer, input } = setup();
    A.saveContact(s, { ...customer, onHold: true, holdReason: 'Cheque returned' }, customer.id);
    const order = A.saveOrder(s, input);
    expect(() => A.transact(s, (copy) => A.confirmOrder(copy, order.id))).toThrow(
      'Account on hold: Cheque returned.',
    );
    expect(() =>
      A.transact(s, (copy) => A.confirmOrder(copy, order.id, { override: { reason: 'bad' } })),
    ).toThrow('Enter an override reason of at least 5 characters.');
    A.confirmOrder(s, order.id, { override: { reason: ' Owner approved, cheque replaced ' } });
    expect(order.creditOverride).toMatchObject({
      by: CURRENT_USER,
      reason: 'Owner approved, cheque replaced',
      reasons: ['Account on hold: Cheque returned.'],
    });
    expect(new Date(order.creditOverride!.at).toISOString()).toBe(order.creditOverride!.at);
    assertInvariants(s);
  });
  it('saves and confirms a new order atomically, preserving numbering on a blocked action', () => {
    const { s, customer, input } = setup();
    A.saveContact(s, { ...customer, creditLimit: 0 }, customer.id);
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => {
        const order = A.saveOrder(copy, input);
        A.confirmOrder(copy, order.id);
      }),
    ).toThrow('Credit limit');
    expect(s).toEqual(before);
    const result = A.transact(s, (copy) =>
      A.saveOrder(copy, {
        ...input,
        asQuote: false,
        override: { reason: 'Owner approved payment' },
      }),
    );
    expect(result.value).toMatchObject({ status: 'Confirmed', number: 'SO-0001' });
    assertInvariants(s);
    assertInvariants(result.state);
  });
  it('rejects confirmed qty below delivered plus cancelled, locks customer and closed orders', () => {
    const { s, input } = setup();
    const order = A.saveOrder(s, input);
    A.confirmOrder(s, order.id);
    A.cancelRemaining(s, order.id, {
      lineId: order.lines[0].id,
      reason: 'Customer reduced demand',
    });
    expect(order.status).toBe('Done');
    expect(() => A.transact(s, (copy) => A.saveOrder(copy, input, order.id))).toThrow(
      'This order is closed.',
    );
    const partial = A.saveOrder(s, { ...input, lines: [...input.lines, ...input.lines] });
    A.confirmOrder(s, partial.id);
    A.cancelRemaining(s, partial.id, { lineId: partial.lines[0].id, reason: 'Duplicate request' });
    expect(() =>
      A.transact(s, (copy) =>
        A.saveOrder(
          copy,
          { ...input, lines: partial.lines.map((l) => ({ ...l, qty: 9 })) },
          partial.id,
        ),
      ),
    ).toThrow(`${partial.lines[0].name}: 10 already delivered or cancelled.`);
    expect(() =>
      A.transact(s, (copy) =>
        A.saveOrder(copy, { ...input, customerId: 'missing', lines: partial.lines }, partial.id),
      ),
    ).toThrow();
    assertInvariants(s);
  });
  it('extends reservations on added lines, shrinks them on reductions, and allocates duplicate products once', () => {
    const { s, p, input } = setup();
    let order = A.saveOrder(s, input);
    A.confirmOrder(s, order.id);
    const reservationId = s.reservations[0].id;
    order = A.saveOrder(
      s,
      { ...input, lines: [...order.lines, { productId: p.id, qty: 5 }] },
      order.id,
    );
    expect(s.reservations[0]).toMatchObject({ id: reservationId, qty: 15 });
    order = A.saveOrder(
      s,
      { ...input, lines: [{ ...order.lines[0], qty: 2 }, order.lines[1]] },
      order.id,
    );
    expect(s.reservations[0].qty).toBe(7);
    expect(A.orderLineReserved(s, order, order.lines[0].id)).toBe(2);
    expect(A.orderLineReserved(s, order, order.lines[1].id)).toBe(5);
    A.reserveOrder(s, order.id);
    A.reserveOrder(s, order.id);
    expect(
      s.reservations.filter((r) => r.sourceId === order.id && r.status === 'Active'),
    ).toHaveLength(1);
    assertInvariants(s);
  });
  it('locks the confirmed customer, allows undelivered price and unit edits, and releases removed products', () => {
    const { s, p, customer, input } = setup();
    const otherCustomer = A.saveContact(s, { ...customer, name: 'Other customer' });
    A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 2, barcode: '' }] }, p.id);
    const other = A.saveProduct(s, { ...p, sku: 'OTHER', name: 'Other product', barcode: '' });
    let order = A.saveOrder(s, {
      ...input,
      lines: [...input.lines, { productId: other.id, qty: 2 }],
    });
    expect(A.baseUnitLocked(s, other.id)).toBe(true);
    A.confirmOrder(s, order.id);
    expect(() =>
      A.transact(s, (copy) =>
        A.saveOrder(copy, { ...input, customerId: otherCustomer.id, lines: order.lines }, order.id),
      ),
    ).toThrow('The customer cannot change on a confirmed order.');
    order = A.saveOrder(
      s,
      { ...input, lines: [{ ...order.lines[0], qty: 2, unit: 'carton', price: 6 }] },
      order.id,
    );
    expect(order.lines[0]).toMatchObject({ unit: 'carton', factor: 2, price: 6 });
    expect(s.reservations.find((r) => r.sourceId === order.id && r.productId === p.id)?.qty).toBe(
      4,
    );
    expect(A.baseUnitLocked(s, other.id)).toBe(false);
    expect(() =>
      A.transact(s, (copy) => A.saveContact(copy, { ...customer, type: 'Supplier' }, customer.id)),
    ).toThrow('transaction history');
    assertInvariants(s);
  });
  it('checks only a confirmed edit increase and stores an override without counting the order twice', () => {
    const { s, customer, input } = setup(2);
    A.saveContact(s, { ...customer, creditLimit: 15 }, customer.id);
    let order = A.saveOrder(s, input);
    A.confirmOrder(s, order.id);
    order = A.saveOrder(s, { ...input, lines: [{ ...order.lines[0], qty: 3 }] }, order.id);
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(15);
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) =>
        A.saveOrder(copy, { ...input, lines: [{ ...order.lines[0], qty: 4 }] }, order.id),
      ),
    ).toThrow('exposure $20.00');
    expect(s).toEqual(before);
    order = A.saveOrder(
      s,
      {
        ...input,
        lines: [{ ...order.lines[0], qty: 4 }],
        override: { reason: 'Approved additional supply' },
      },
      order.id,
    );
    expect(order.creditOverride?.reason).toBe('Approved additional supply');
    assertInvariants(s);
  });
  it('another customer hold reduces reservation and new receipts top it up only on reserveOrder', () => {
    const { s, p, customer, input, supplier } = setup(40);
    const other = A.saveContact(s, { ...customer, name: 'Other customer' });
    A.holdStock(s, { productId: p.id, customerId: other.id, qty: 10 });
    const order = A.saveOrder(s, input);
    A.confirmOrder(s, order.id);
    expect(s.reservations.find((r) => r.sourceId === order.id)?.qty).toBe(20);
    A.receiveStock(s, {
      productId: p.id,
      qty: 25,
      cost: 2,
      code: 'NEW',
      expiry: A.shift(120),
      warehouseId: 'wh_main',
      supplierId: supplier.id,
      payment: 'credit',
    });
    expect(s.reservations.find((r) => r.sourceId === order.id)?.qty).toBe(20);
    A.reserveOrder(s, order.id);
    A.reserveOrder(s, order.id);
    expect(
      s.reservations.filter((r) => r.sourceId === order.id && r.status === 'Active'),
    ).toHaveLength(1);
    expect(s.reservations.find((r) => r.sourceId === order.id)?.qty).toBe(40);
    assertInvariants(s);
  });
  it('excludes matching sourceIds of any reservation source, and handles negative free stock', () => {
    const { s, p, input, early, late } = setup(30);
    const order = A.saveOrder(s, input);
    A.confirmOrder(s, order.id);
    expect(A.reserved(s, p.id, { exceptSourceId: order.id })).toBe(0);
    expect(A.free(s, p.id, { exceptSourceId: order.id })).toBe(30);
    A.adjustStock(s, { batchId: early.id, qty: -10, reason: 'damaged' });
    A.adjustStock(s, { batchId: late.id, qty: -20, reason: 'damaged' });
    expect(A.free(s, p.id)).toBe(-30);
    A.reserveOrder(s, order.id);
    expect(A.reserved(s, p.id)).toBe(0);
    expect(s.reservations[0].status).toBe('Released');
    assertInvariants(s);
  });
  it('cancels a line or all remaining quantities, requires reasons and closes with released promises', () => {
    const { s, input } = setup();
    const order = A.saveOrder(s, { ...input, lines: [...input.lines, ...input.lines] });
    expect(() =>
      A.transact(s, (copy) => A.cancelRemaining(copy, order.id, { reason: 'No longer needed' })),
    ).toThrow('Only confirmed orders');
    A.confirmOrder(s, order.id);
    expect(() =>
      A.transact(s, (copy) => A.cancelRemaining(copy, order.id, { reason: '' })),
    ).toThrow('Enter a cancellation reason.');
    A.cancelRemaining(s, order.id, { lineId: order.lines[0].id, reason: 'Duplicate line' });
    expect(order.status).toBe('Confirmed');
    expect(s.reservations[0].qty).toBe(10);
    A.cancelRemaining(s, order.id, { reason: 'Cancelled collection' });
    expect(order.status).toBe('Done');
    expect(order.closedAt).toBeDefined();
    expect(order.lines.map((l) => A.openQty(s, order, l.id))).toEqual([0, 0]);
    expect(A.reserved(s, order.lines[0].productId)).toBe(0);
    assertInvariants(s);
  });
  it('cancelOrder cancels quotes and confirmed orders, releases everything and never reuses numbers', () => {
    const { s, input } = setup();
    const quote = A.saveOrder(s, input);
    A.cancelOrder(s, quote.id, 'Changed request');
    const order = A.saveOrder(s, input);
    A.confirmOrder(s, order.id);
    A.cancelOrder(s, order.id, 'Customer cancelled');
    expect(order.status).toBe('Cancelled');
    expect(order.cancelReason).toBe('Customer cancelled');
    expect(s.reservations.every((r) => r.status === 'Released')).toBe(true);
    expect(A.saveOrder(s, input).number).toBe('SO-0003');
    expect(() => A.transact(s, (copy) => A.saveOrder(copy, input, order.id))).toThrow(
      'This order is closed.',
    );
    // cancelOrder after delivery belongs to 004, when deliveredQty has a source.
    assertInvariants(s);
  });
  it('exposure includes only confirmed open order value with percentage discount and tax', () => {
    const { s, customer, input } = setup();
    const order = A.saveOrder(s, { ...input, discountPercent: 10, taxRate: 10 });
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(0);
    expect(A.orderTotals(order)).toMatchObject({
      subtotal: 50,
      discount: 5,
      taxAmount: 4.5,
      total: 49.5,
    });
    A.confirmOrder(s, order.id);
    expect(A.creditCheck(s, customer.id, 1).exposure).toBe(50.5);
    A.cancelRemaining(s, order.id, { reason: 'No longer required' });
    expect(A.creditCheck(s, customer.id, 0).exposure).toBe(0);
    expect(A.orderTotals(order).total).toBe(0);
    assertInvariants(s);
  });
  it.each([1, 2])(
    'migrates v%i order defaults idempotently and preserves existing orders',
    (version) => {
      const s = A.seed();
      assertInvariants(s);
      const raw = legacyBackup(s);
      raw.version = version;
      delete raw.orders;
      delete raw.counters.order;
      raw.reservations = raw.reservations.filter(
        (r: { source: string }) => r.source !== 'sales_order',
      );
      const migrated = A.validateBackup(raw);
      expect(migrated.orders).toEqual([]);
      expect(migrated.counters.order).toBe(1);
      expect(A.migrate(structuredClone(migrated))).toEqual(migrated);
      expect(A.migrate(structuredClone(s))).toEqual(s);
      assertInvariants(migrated);
    },
  );
  it('validates order backups, source references and unique Active order reservations', () => {
    const { s, input } = setup();
    const order = A.saveOrder(s, input);
    A.confirmOrder(s, order.id);
    const patches = [
      { status: 'Invalid' },
      { date: '2026-02-30' },
      { requestedDate: A.shift(-1) },
      { discountPercent: 101 },
      { status: 'Cancelled', cancelReason: '' },
      { status: 'Quote', validUntil: undefined },
    ];
    for (const patch of patches) {
      const bad = structuredClone(s);
      Object.assign(bad.orders[0], patch);
      expect(() => A.validateBackup(bad)).toThrow();
    }
    for (const cancelledQty of [-1, 11, 0.5]) {
      const bad = structuredClone(s);
      bad.orders[0].lines[0].cancelledQty = cancelledQty;
      expect(() => A.validateBackup(bad)).toThrow();
    }
    const unknown = structuredClone(s);
    unknown.reservations[0].sourceId = 'missing';
    expect(() => A.validateBackup(unknown)).toThrow('invalid reservation order');
    const duplicate = structuredClone(s);
    duplicate.reservations.push({
      ...duplicate.reservations[0],
      id: 'duplicate',
      number: 'RSV-9999',
    });
    expect(() => A.validateBackup(duplicate)).toThrow('duplicate Active order reservations');
    const nonConfirmed = structuredClone(s);
    nonConfirmed.orders[0].status = 'Quote';
    nonConfirmed.orders[0].validUntil = A.shift(14);
    expect(() => A.validateBackup(nonConfirmed)).toThrow(
      'Active order reservations require a Confirmed order.',
    );
    assertInvariants(s);
  });
  it('seeds a valid and expired quote, fully reserved Greenlife, Amoxicillin backorder, held override and cancelled order', () => {
    const s = A.seed();
    expect(s.orders).toHaveLength(11);
    const quotes = s.orders.filter((o) => o.status === 'Quote');
    expect(quotes.map(A.quoteStatus).sort()).toEqual(['Expired', 'Quote']);
    const greenlife = s.orders.find((o) => o.customerId === 'c1' && o.lines[0].productId === 'p3')!;
    expect(A.fulfilmentStatus(s, greenlife)).toBe('Delivered');
    expect(
      greenlife.lines.every(
        (l) => A.openQty(s, greenlife, l.id) === A.orderLineReserved(s, greenlife, l.id),
      ),
    ).toBe(true);
    const backorder = s.orders.find(
      (o) => o.status === 'Confirmed' && o.lines.some((l) => l.productId === 'p2'),
    )!;
    expect(A.openQty(s, backorder, backorder.lines[0].id)).toBeGreaterThan(
      A.orderLineReserved(s, backorder, backorder.lines[0].id),
    );
    expect(s.orders.find((o) => o.customerId === 'c2')?.creditOverride?.reason).toBe(
      'Owner approved, cheque replaced',
    );
    expect(s.orders.find((o) => o.status === 'Cancelled')?.cancelReason).toBeTruthy();
    assertInvariants(s);
  });
});
describe('price lists', () => {
  function pricing() {
    const setup = stocked();
    const { s, p, customer } = setup;
    const group = A.saveCustomerGroup(s, { name: 'Hospital', discountPercent: 8 });
    A.saveContact(s, { ...customer, groupId: group.id }, customer.id);
    A.saveProduct(
      s,
      { ...p, price: 10, packs: [{ unit: 'carton', factor: 50, barcode: '', price: 450 }] },
      p.id,
    );
    return { ...setup, p: A.product(s, p.id)!, group };
  }
  it('resolves customer > group entry > group discount > default, removing each higher priority', () => {
    const { s, p, customer, group } = pricing();
    const input = { productId: p.id, unit: p.unit, customerId: customer.id };
    const groupEntry = A.savePrice(s, {
      productId: p.id,
      unit: p.unit,
      groupId: group.id,
      price: 8,
    });
    const special = A.savePrice(s, { ...input, price: 7, note: ' Contract ' });
    expect(special.id.startsWith('price_')).toBe(true);
    expect(special.note).toBe('Contract');
    expect(A.priceFor(s, input)).toEqual({ price: 7, source: 'customer', entryId: special.id });
    A.deletePrice(s, special.id);
    expect(A.priceFor(s, input)).toEqual({ price: 8, source: 'group', entryId: groupEntry.id });
    A.deletePrice(s, groupEntry.id);
    expect(A.priceFor(s, input)).toEqual({ price: 9.2, source: 'group_discount' });
    A.saveCustomerGroup(s, { ...group, discountPercent: 0 }, group.id);
    expect(A.priceFor(s, input)).toEqual({ price: 10, source: 'default' });
    expect(A.priceFor(s, { ...input, customerId: undefined })).toEqual({
      price: 10,
      source: 'default',
    });
    assertInvariants(s);
  });
  it.each(['group', 'customer'] as const)(
    'keeps carton and box %s entries independent in both directions',
    (target) => {
      const { s, p, customer, group } = pricing();
      const input = { productId: p.id, customerId: customer.id };
      const owner = target === 'group' ? { groupId: group.id } : { customerId: customer.id };
      const carton = A.savePrice(s, { productId: p.id, unit: 'carton', price: 400, ...owner });
      expect(A.priceFor(s, { ...input, unit: 'carton' }).price).toBe(400);
      expect(A.priceFor(s, { ...input, unit: 'box' })).toEqual({
        price: 9.2,
        source: 'group_discount',
      });
      const box = A.savePrice(s, { productId: p.id, unit: 'box', price: 8, ...owner });
      expect(A.priceFor(s, { ...input, unit: 'box' }).price).toBe(8);
      expect(A.priceFor(s, { ...input, unit: 'carton' }).price).toBe(400);
      A.deletePrice(s, carton.id);
      expect(A.priceFor(s, { ...input, unit: 'carton' }).price).toBe(414);
      expect(A.priceFor(s, { ...input, unit: 'box' }).price).toBe(8);
      A.deletePrice(s, box.id);
      assertInvariants(s);
    },
  );
  it('discounts a $10 default by 8% to $9.20 and rounds fractional cents', () => {
    const { s, p, customer } = pricing();
    const input = { productId: p.id, unit: p.unit, customerId: customer.id };
    expect(A.priceFor(s, input).price).toBe(9.2);
    A.saveProduct(s, { ...p, price: 10.01 }, p.id);
    expect(A.priceFor(s, input).price).toBe(9.21);
    A.saveProduct(
      s,
      { ...A.product(s, p.id)!, packs: [{ unit: 'carton', factor: 50, barcode: '' }] },
      p.id,
    );
    expect(A.priceFor(s, { ...input, unit: 'carton' }).price).toBe(460.46);
    assertInvariants(s);
  });
  it('rejects duplicate keys on create and edit, permits updating an entry and separate targets', () => {
    const { s, p, customer, group } = pricing();
    const input = { productId: p.id, unit: p.unit, groupId: group.id, price: 8 };
    const entry = A.savePrice(s, input);
    expect(() => A.savePrice(s, input)).toThrow(
      'A price already exists for this product, unit and target.',
    );
    expect(A.savePrice(s, { ...input, price: '8.126' }, entry.id).price).toBe(8.13);
    const special = A.savePrice(s, {
      productId: p.id,
      unit: p.unit,
      customerId: customer.id,
      price: 7,
    });
    expect(() => A.savePrice(s, input, special.id)).toThrow(
      'A price already exists for this product, unit and target.',
    );
    expect(() => A.savePrice(s, input, 'missing')).toThrow('Price not found.');
    expect(() => A.deletePrice(s, 'missing')).toThrow('Price not found.');
    assertInvariants(s);
  });
  it('validates exactly one existing target, rejecting suppliers, inactive products, invalid units and nonpositive prices atomically', () => {
    const { s, p, customer, supplier, group } = pricing();
    const input = { productId: p.id, unit: p.unit, groupId: group.id, price: 8 };
    const cases = [
      { groupId: undefined },
      { customerId: customer.id },
      { groupId: 'missing' },
      { groupId: undefined, customerId: 'missing' },
      { groupId: undefined, customerId: supplier.id },
      { productId: 'missing' },
      { unit: 'tube' as const },
      { price: 0 },
      { price: -1 },
      { price: NaN },
      { price: Infinity },
      { price: 100000001 },
      { price: 0.001 },
    ];
    const before = structuredClone(s);
    cases.forEach((change) => {
      expect(() => A.transact(s, (copy) => A.savePrice(copy, { ...input, ...change }))).toThrow();
      expect(s).toEqual(before);
    });
    const inactive = A.saveProduct(s, {
      ...p,
      sku: 'INACTIVE',
      active: false,
      barcode: '',
      packs: [],
    });
    expect(() => A.savePrice(s, { ...input, productId: inactive.id })).toThrow(
      `${inactive.name} is inactive.`,
    );
    assertInvariants(s);
  });
  it('deleting an unused group removes only its entries and preserves customer specials', () => {
    const { s, p, customer, group } = pricing();
    const other = A.saveCustomerGroup(s, { name: 'Clinic' });
    A.savePrice(s, { productId: p.id, unit: p.unit, groupId: group.id, price: 8 });
    A.savePrice(s, { productId: p.id, unit: 'carton', groupId: group.id, price: 400 });
    const retained = A.savePrice(s, { productId: p.id, unit: p.unit, groupId: other.id, price: 9 });
    const special = A.savePrice(s, {
      productId: p.id,
      unit: p.unit,
      customerId: customer.id,
      price: 7,
    });
    expect(() => A.deleteCustomerGroup(s, group.id)).toThrow('Hospital is used by 1 customers.');
    A.saveContact(s, { ...customer, groupId: '' }, customer.id);
    A.deleteCustomerGroup(s, group.id);
    expect(s.prices).toEqual([retained, special]);
    assertInvariants(s);
  });
  it('flags prices strictly below rounded base and carton costs, permitting equality', () => {
    const { s, p } = pricing();
    for (const unit of [p.unit, 'carton'] as const) {
      const cost = A.round(p.cost * A.unitFactor(p, unit));
      expect(A.belowCost(s, p.id, unit, cost - 0.01)).toBe(true);
      expect(A.belowCost(s, p.id, unit, cost)).toBe(false);
      expect(A.belowCost(s, p.id, unit, cost + 0.01)).toBe(false);
    }
    assertInvariants(s);
  });
  it('uses resolved defaults for new invoices, preserves explicit prices and does not reprice stored documents', () => {
    const { s, p, customer } = pricing();
    const input = {
      customerId: customer.id,
      date: A.today(),
      lines: [{ productId: p.id, qty: 1 }],
    };
    const old = A.createInvoice(s, input);
    expect(old.lines[0].price).toBe(9.2);
    A.savePrice(s, { productId: p.id, unit: p.unit, customerId: customer.id, price: 7 });
    expect(A.createInvoice(s, input).lines[0].price).toBe(7);
    expect(
      A.createInvoice(s, { ...input, lines: [{ ...input.lines[0], price: 6 }] }).lines[0].price,
    ).toBe(6);
    expect(old.lines[0].price).toBe(9.2);
    assertInvariants(s);
  });
  it('retains inactive product prices in backups, allows deletion and prevents removing a priced unit or changing a special customer to supplier', () => {
    const s = empty();
    const p = A.saveProduct(s, {
      ...A.seed().products[0],
      sku: 'PRICED',
      barcode: '',
      packs: [{ unit: 'carton', factor: 50, barcode: '' }],
    });
    const customer = A.saveContact(s, {
      type: 'Customer',
      name: 'Special buyer',
      person: '',
      email: '',
      phone: '',
      address: '',
    });
    const entry = A.savePrice(s, {
      productId: p.id,
      unit: 'carton',
      customerId: customer.id,
      price: 240,
    });
    expect(() => A.saveProduct(s, { ...p, packs: [] }, p.id)).toThrow(
      'Delete price entries for this unit before removing it.',
    );
    expect(() => A.saveContact(s, { ...customer, type: 'Supplier' }, customer.id)).toThrow();
    A.saveProduct(s, { ...p, active: false }, p.id);
    expect(s.prices).toEqual([entry]);
    expect(() => A.savePrice(s, { ...entry, price: 250 }, entry.id)).toThrow(
      `${p.name} is inactive.`,
    );
    assertInvariants(s);
    A.deletePrice(s, entry.id);
    assertInvariants(s);
  });
  it('reprices untouched draft lines on customer changes, retaining manual prices and obsolete unit snapshots', () => {
    const { s, p, customer } = pricing();
    const specialCustomer = A.saveContact(s, { ...customer, name: 'Special buyer', groupId: '' });
    A.savePrice(s, { productId: p.id, unit: p.unit, customerId: specialCustomer.id, price: 7 });
    const lines = [
      { productId: p.id, unit: p.unit, qty: 1, price: '9.20' },
      { productId: p.id, unit: p.unit, qty: 1, price: '8.50' },
      { productId: p.id, unit: 'carton' as const, qty: 1, price: 414 },
      { productId: p.id, unit: 'case' as const, qty: 1, price: 123 },
      { productId: '', qty: 1, price: 0 },
    ];
    const before = structuredClone(lines);
    const repriced = A.repriceLines(s, lines, customer.id, specialCustomer.id);
    expect(repriced.map((l) => l.price)).toEqual([7, '8.50', 450, 123, 0]);
    expect(lines).toEqual(before);
    expect(
      A.repriceLines(s, repriced, specialCustomer.id, customer.id).map((l) => l.price),
    ).toEqual([9.2, '8.50', 414, 123, 0]);
    assertInvariants(s);
  });
  it.each([1, 2])(
    'migrates v%i prices and missing discount defaults idempotently, preserving stored line prices',
    (version) => {
      const raw = JSON.parse(JSON.stringify(A.seed()));
      raw.version = version;
      delete raw.prices;
      raw.customerGroups.forEach((g: { discountPercent?: number }) => delete g.discountPercent);
      const lines = structuredClone(raw.invoices);
      const s = A.validateBackup(raw);
      expect(s.prices).toEqual([]);
      expect(s.customerGroups.every((g) => g.discountPercent === 0)).toBe(true);
      expect(s.invoices).toEqual(lines);
      const before = structuredClone(s);
      expect(A.migrate(s)).toEqual(before);
      assertInvariants(s);
    },
  );
  it('rejects malformed price backups, including duplicate target keys and identifiers', () => {
    const { s, p, customer, supplier, group } = pricing();
    const entry = A.savePrice(s, {
      productId: p.id,
      unit: p.unit,
      customerId: customer.id,
      price: 7,
    });
    const changes = [
      { productId: 'missing' },
      { unit: 'tube' },
      { unit: undefined },
      { customerId: undefined },
      { customerId: 'missing' },
      { customerId: supplier.id },
      { groupId: group.id },
      { customerId: undefined, groupId: 'missing' },
      { groupId: '' },
      { price: 0 },
      { price: -1 },
      { price: '7' },
      { price: 7.001 },
      { note: 42 },
    ];
    changes.forEach((change) => {
      const raw = structuredClone(s);
      Object.assign(raw.prices[0], change);
      expect(() => A.validateBackup(raw)).toThrow();
    });
    const duplicate = structuredClone(s);
    duplicate.prices.push({ ...entry, id: 'another' });
    expect(() => A.validateBackup(duplicate)).toThrow(
      'A price already exists for this product, unit and target.',
    );
    const ids = structuredClone(s);
    ids.prices.push({ ...entry });
    expect(() => A.validateBackup(ids)).toThrow(
      'Backup contains duplicate or missing identifiers.',
    );
    assertInvariants(s);
  });
  it('seeds six Hospital products with box and carton Paracetamol, four Clinic products, three Greenlife specials and exactly one below-cost entry', () => {
    const s = A.seed();
    const hospital = s.customerGroups.find((g) => g.name === 'Hospital')!;
    const clinic = s.customerGroups.find((g) => g.name === 'Clinic')!;
    const hospitalPrices = s.prices.filter((e) => e.groupId === hospital.id);
    expect(new Set(hospitalPrices.map((e) => e.productId)).size).toBe(6);
    expect(
      hospitalPrices
        .filter((e) => e.productId === 'p1')
        .map((e) => e.unit)
        .sort(),
    ).toEqual(['box', 'carton']);
    expect(s.prices.filter((e) => e.groupId === clinic.id)).toHaveLength(4);
    expect(s.prices.filter((e) => e.customerId === 'c1')).toHaveLength(3);
    expect(s.prices.some((e) => e.customerId === 'c1' && e.unit === 'carton')).toBe(true);
    expect(s.prices.filter((e) => A.belowCost(s, e.productId, e.unit, e.price))).toHaveLength(1);
    expect(clinic.discountPercent).toBe(3);
    expect(hospital.discountPercent).toBe(8);
    assertInvariants(s);
  });
});

describe('customer accounts', () => {
  function draft(
    s: Workspace,
    customerId: string,
    productId: string,
    date = A.today(),
    due?: string,
  ) {
    return A.createInvoice(s, { customerId, date, due, lines: [{ productId, qty: 1 }] });
  }
  it.each([0, 30, 60, 365])(
    'defaults the due date to invoice date plus %i days and allows a chosen due date',
    (terms) => {
      const { s, customer, p } = stocked();
      A.saveContact(s, { ...customer, paymentTermsDays: terms }, customer.id);
      const date = A.shift(-5);
      expect(draft(s, customer.id, p.id, date).due).toBe(A.shift(terms, date));
      expect(draft(s, customer.id, p.id, date, A.shift(10, date)).due).toBe(A.shift(10, date));
      assertInvariants(s);
    },
  );
  it('blocks a held account with its reason', () => {
    const { s, customer } = stocked();
    A.saveContact(
      s,
      { ...customer, onHold: true, holdReason: ' Cheque returned unpaid ' },
      customer.id,
    );
    expect(A.creditCheck(s, customer.id, 5)).toEqual({
      ok: false,
      reasons: ['Account on hold: Cheque returned unpaid.'],
      exposure: 5,
      limit: null,
      overdue: 0,
    });
    assertInvariants(s);
  });
  it('blocks above the limit, permits the exact limit, and excludes drafts from exposure', () => {
    const { s, customer, p } = stocked();
    const invoice = draft(s, customer.id, p.id);
    A.issueInvoice(s, invoice.id);
    A.payInvoice(s, invoice.id, 2, 'Cash', A.today());
    draft(s, customer.id, p.id);
    A.saveContact(s, { ...customer, creditLimit: 10 }, customer.id);
    expect(A.creditCheck(s, customer.id, 7)).toMatchObject({ ok: true, exposure: 10, limit: 10 });
    expect(A.creditCheck(s, customer.id, 8)).toMatchObject({
      ok: false,
      exposure: 11,
      reasons: ['Credit limit $10.00 exceeded (exposure $11.00).'],
    });
    assertInvariants(s);
  });
  it('never blocks an unlimited customer by amount and blocks any credit sale with a zero limit', () => {
    const { s, customer } = stocked();
    expect(A.creditCheck(s, customer.id, 100000000).ok).toBe(true);
    A.saveContact(s, { ...customer, creditLimit: 0 }, customer.id);
    expect(A.creditCheck(s, customer.id, 0).ok).toBe(true);
    expect(A.creditCheck(s, customer.id, 0.01)).toMatchObject({
      ok: false,
      exposure: 0.01,
      limit: 0,
    });
    assertInvariants(s);
  });
  it('blocks overdue balances beyond grace, permits the grace boundary, and ignores paid invoices and drafts', () => {
    const { s, customer, p } = stocked();
    const old = draft(s, customer.id, p.id, A.shift(-30), A.shift(-7));
    A.issueInvoice(s, old.id);
    draft(s, customer.id, p.id, A.shift(-30), A.shift(-20));
    expect(A.creditCheck(s, customer.id, 0)).toMatchObject({ ok: true, overdue: 0 });
    A.setAccountSettings(s, { defaultPaymentTermsDays: 30, overdueGraceDays: 6 });
    A.payInvoice(s, old.id, 2, 'Cash', A.today());
    expect(A.creditCheck(s, customer.id, 0)).toMatchObject({
      ok: false,
      overdue: 3,
      reasons: ['$3.00 is overdue by more than 6 days.'],
    });
    A.payInvoice(s, old.id, 3, 'Cash', A.today());
    expect(A.creditCheck(s, customer.id, 0).ok).toBe(true);
    assertInvariants(s);
  });
  it('lists every applicable reason and overrides an issue atomically with a recorded user, timestamp, and reason', () => {
    const { s, customer, p } = stocked();
    const old = draft(s, customer.id, p.id, A.shift(-30), A.shift(-8));
    A.issueInvoice(s, old.id);
    A.saveContact(
      s,
      { ...customer, creditLimit: 5, onHold: true, holdReason: 'Cheque returned unpaid' },
      customer.id,
    );
    const invoice = draft(s, customer.id, p.id);
    const reasons = [
      'Account on hold: Cheque returned unpaid.',
      'Credit limit $5.00 exceeded (exposure $10.00).',
      '$5.00 is overdue by more than 7 days.',
    ];
    expect(A.creditCheck(s, customer.id, invoice.total).reasons).toEqual(reasons);
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, invoice.id))).toThrow(
      reasons.join(' '),
    );
    expect(s).toEqual(before);
    for (const reason of ['', ' abcd ']) {
      expect(() => A.transact(s, (copy) => A.issueInvoice(copy, invoice.id, { reason }))).toThrow(
        'Enter an override reason of at least 5 characters.',
      );
      expect(s).toEqual(before);
    }
    assertInvariants(s);
    const result = A.transact(s, (copy) =>
      A.issueInvoice(copy, invoice.id, { reason: ' Manager approved collection ' }),
    );
    const issued = result.state.invoices.find((i) => i.id === invoice.id)!;
    expect(issued.status).toBe('Issued');
    expect(issued.creditOverride).toEqual({
      by: CURRENT_USER,
      at: expect.any(String),
      reason: 'Manager approved collection',
      reasons,
    });
    expect(new Date(issued.creditOverride!.at).toISOString()).toBe(issued.creditOverride!.at);
    assertInvariants(result.state);
  });
  it('manages trimmed, unique group names and prevents deleting groups used by customers', () => {
    const { s, customer } = stocked();
    const group = A.saveCustomerGroup(s, { name: ' Pharmacy ' });
    expect(group).toMatchObject({ name: 'Pharmacy', discountPercent: 0 });
    expect(group.id.startsWith('grp_')).toBe(true);
    expect(() => A.saveCustomerGroup(s, { name: 'phARMacy' })).toThrow(
      'Customer group names must be unique.',
    );
    const other = A.saveCustomerGroup(s, { name: 'Clinic' });
    expect(() => A.saveCustomerGroup(s, { name: ' Pharmacy ' }, other.id)).toThrow(
      'Customer group names must be unique.',
    );
    A.saveContact(s, { ...customer, groupId: group.id }, customer.id);
    expect(() => A.deleteCustomerGroup(s, group.id)).toThrow('Pharmacy is used by 1 customers.');
    A.saveCustomerGroup(s, { name: 'Retail pharmacy' }, group.id);
    A.deleteCustomerGroup(s, other.id);
    expect(s.customerGroups).toHaveLength(1);
    A.saveContact(s, { ...customer, groupId: '' }, customer.id);
    A.deleteCustomerGroup(s, group.id);
    expect(s.customerGroups).toEqual([]);
    assertInvariants(s);
  });
  it('validates account fields, supplier defaults, group ranges, and settings in model operations', () => {
    const { s, customer, supplier } = stocked();
    for (const patch of [
      { paymentTermsDays: -1 },
      { paymentTermsDays: 366 },
      { paymentTermsDays: 1.5 },
      { creditLimit: -1 },
      { creditLimit: Infinity },
      { onHold: true, holdReason: ' ' },
      { groupId: 'missing' },
      { billing: 'invalid' as typeof customer.billing },
    ]) {
      const before = structuredClone(s);
      expect(() =>
        A.transact(s, (copy) => A.saveContact(copy, { ...customer, ...patch }, customer.id)),
      ).toThrow();
      expect(s).toEqual(before);
    }
    for (const name of ['x', 'a'.repeat(41)])
      expect(() => A.saveCustomerGroup(s, { name })).toThrow();
    for (const discountPercent of [-1, 101, NaN])
      expect(() => A.saveCustomerGroup(s, { name: 'Invalid discount', discountPercent })).toThrow();
    A.setAccountSettings(s, { defaultPaymentTermsDays: 45, overdueGraceDays: 0 });
    const c = A.saveContact(s, {
      ...supplier,
      type: 'Customer',
      name: 'New customer',
      paymentTermsDays: undefined,
    });
    expect(c.paymentTermsDays).toBe(45);
    const saved = A.saveContact(
      s,
      {
        ...supplier,
        groupId: 'invalid',
        creditLimit: -1,
        onHold: true,
        holdReason: '',
        billing: 'monthly',
      },
      supplier.id,
    );
    expect(saved).toMatchObject({
      groupId: '',
      paymentTermsDays: 30,
      creditLimit: null,
      onHold: false,
      holdReason: '',
      billing: 'per_delivery',
    });
    for (const value of [-1, 366, 0.5]) {
      expect(() =>
        A.setAccountSettings(s, { defaultPaymentTermsDays: value, overdueGraceDays: 7 }),
      ).toThrow();
      expect(() =>
        A.setAccountSettings(s, { defaultPaymentTermsDays: 30, overdueGraceDays: value }),
      ).toThrow();
    }
    assertInvariants(s);
  });
  it.each([1, 2])('migrates v%i account defaults idempotently and loads old backups', (version) => {
    const raw = JSON.parse(JSON.stringify(A.seed()));
    raw.version = version;
    delete raw.customerGroups;
    delete raw.prices;
    delete raw.settings.defaultPaymentTermsDays;
    delete raw.settings.overdueGraceDays;
    for (const c of raw.contacts)
      for (const field of [
        'groupId',
        'paymentTermsDays',
        'creditLimit',
        'onHold',
        'holdReason',
        'billing',
      ])
        delete c[field];
    const stored = JSON.stringify(raw);
    const s = A.validateBackup(raw);
    expect(s.customerGroups).toEqual([]);
    expect(s.settings).toMatchObject({ defaultPaymentTermsDays: 30, overdueGraceDays: 7 });
    s.contacts.forEach((c) =>
      expect(c).toMatchObject({
        groupId: '',
        paymentTermsDays: 30,
        creditLimit: null,
        onHold: false,
        holdReason: '',
        billing: 'per_delivery',
      }),
    );
    const before = structuredClone(s);
    expect(A.migrate(s)).toEqual(before);
    assertInvariants(s);
    vi.stubGlobal('localStorage', { getItem: () => stored });
    try {
      assertInvariants(A.load());
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('preserves existing account settings and uses a migrated company default for missing contact terms', () => {
    const raw = JSON.parse(JSON.stringify(A.seed()));
    raw.settings.defaultPaymentTermsDays = 45;
    delete raw.contacts[0].paymentTermsDays;
    const s = A.migrate(raw);
    expect(s.contacts[0].paymentTermsDays).toBe(45);
    expect(A.contact(s, 'c5')!.paymentTermsDays).toBe(60);
    const before = structuredClone(s);
    expect(A.migrate(s)).toEqual(before);
    assertInvariants(s);
  });
  it('rejects malformed account backups and credit overrides', () => {
    const { s, customer, p } = stocked();
    const group = A.saveCustomerGroup(s, { name: 'Pharmacy' });
    A.saveContact(
      s,
      { ...customer, groupId: group.id, onHold: true, holdReason: 'Awaiting cheque clearance' },
      customer.id,
    );
    const invoice = draft(s, customer.id, p.id);
    A.issueInvoice(s, invoice.id, { reason: 'Approved by manager' });
    for (const patch of [
      { paymentTermsDays: -1 },
      { paymentTermsDays: 366 },
      { paymentTermsDays: 0.5 },
      { creditLimit: -1 },
      { creditLimit: '5' },
      { groupId: 'missing' },
      { onHold: 'yes' },
      { holdReason: ' ' },
      { billing: 'invalid' },
    ]) {
      const bad = structuredClone(s);
      Object.assign(
        bad.contacts.find((c) => c.id === customer.id)!,
        patch,
      );
      expect(() => A.validateBackup(bad)).toThrow();
    }
    for (const patch of [
      { name: 'x' },
      { name: 'a'.repeat(41) },
      { name: ' Pharmacy ' },
      { discountPercent: -1 },
      { discountPercent: 101 },
    ]) {
      const bad = structuredClone(s);
      Object.assign(bad.customerGroups[0], patch);
      expect(() => A.validateBackup(bad)).toThrow();
    }
    const duplicate = structuredClone(s);
    duplicate.customerGroups.push({ ...group, id: 'other', name: 'pHARMACY' });
    expect(() => A.validateBackup(duplicate)).toThrow();
    for (const key of ['defaultPaymentTermsDays', 'overdueGraceDays'] as const)
      for (const value of [-1, 366, 1.5]) {
        const bad = structuredClone(s);
        bad.settings[key] = value;
        expect(() => A.validateBackup(bad)).toThrow();
      }
    for (const patch of [{ by: '' }, { reason: ' ' }, { at: 'invalid' }, { reasons: null }]) {
      const bad = structuredClone(s);
      Object.assign(bad.invoices[0].creditOverride!, patch);
      expect(() => A.validateBackup(bad)).toThrow('Backup contains an invalid credit override.');
    }
    assertInvariants(s);
  });
  it('seeds groups, customer terms, limits, billing, a held customer, and Greenlife near its limit', () => {
    const s = A.seed();
    expect(s.customerGroups.map((g) => [g.name, g.discountPercent])).toEqual([
      ['Pharmacy', 0],
      ['Clinic', 3],
      ['Hospital', 8],
    ]);
    for (const [id, name, terms, limit, billing] of [
      ['c1', 'Pharmacy', 30, 3000, 'per_delivery'],
      ['c2', 'Clinic', 30, 5000, 'monthly'],
      ['c3', 'Clinic', 30, 5000, 'per_delivery'],
      ['c4', 'Pharmacy', 0, 0, 'per_delivery'],
      ['c5', 'Hospital', 60, null, 'monthly'],
    ] as const) {
      const c = A.contact(s, id)!;
      expect(s.customerGroups.find((g) => g.id === c.groupId)?.name).toBe(name);
      expect(c).toMatchObject({ paymentTermsDays: terms, creditLimit: limit, billing });
    }
    expect(A.contact(s, 'c2')).toMatchObject({
      onHold: true,
      holdReason: 'Cheque returned unpaid',
    });
    expect(A.creditCheck(s, 'c1', 0).exposure).toBeGreaterThan(2700);
    expect(A.creditCheck(s, 'c1', 0).exposure).toBeLessThan(3000);
    assertInvariants(s);
  });
});

describe('workspace recovery', () => {
  it('empties every collection and resets counters while keeping settings and warehouses', () => {
    const seed = A.seed();
    const before = structuredClone(seed);
    const s = A.emptyWorkspace(seed);
    expect(s.settings).toEqual(seed.settings);
    expect(s.warehouses).toEqual(seed.warehouses);
    expect(Object.values(s.counters).every((value) => value === 1)).toBe(true);
    for (const [key, value] of Object.entries(s)) {
      if (Array.isArray(value) && key !== 'warehouses') expect(value).toEqual([]);
    }
    assertInvariants(s);
    s.settings.company = 'Independent workspace';
    s.warehouses[0].name = 'Independent warehouse';
    expect(seed).toEqual(before);
    assertInvariants(s);
    assertInvariants(seed);
  });

  it.each(['', '{ unreadable JSON', '{}', '{"version":999}'])(
    'preserves unreadable storage exactly before opening samples: %j',
    (raw) => {
      const storage = new Map([[A.KEY, raw]]);
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      });
      try {
        const s = A.load();
        expect(s.products.length).toBeGreaterThan(0);
        expect(storage.get(A.KEY)).toBe(raw);
        expect(storage.get(A.RECOVERY_KEY)).toBe(raw);
        assertInvariants(s);
        const next = A.emptyWorkspace(s);
        A.persist(next);
        expect(A.load()).toEqual(next);
        expect(storage.get(A.RECOVERY_KEY)).toBe(raw);
        assertInvariants(next);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('loads valid data and missing storage without creating recovery data', () => {
    const s = empty();
    const getItem = vi.fn().mockReturnValue(JSON.stringify(s));
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    try {
      expect(A.load()).toEqual(s);
      getItem.mockReturnValue(null);
      assertInvariants(A.load());
      expect(setItem).not.toHaveBeenCalled();
      assertInvariants(s);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to open if recovery cannot be saved or storage cannot be read', () => {
    const getItem = vi.fn().mockReturnValue('{ unreadable JSON');
    const setItem = vi.fn(() => {
      throw new Error('Storage is full.');
    });
    vi.stubGlobal('localStorage', { getItem, setItem });
    try {
      expect(A.load).toThrow('Storage is full.');
      expect(setItem).toHaveBeenCalledExactlyOnceWith(A.RECOVERY_KEY, '{ unreadable JSON');
      getItem.mockImplementation(() => {
        throw new Error('Storage is unavailable.');
      });
      expect(A.load).toThrow('Storage is unavailable.');
      expect(setItem).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('reserved stock', () => {
  const draft = (s: Workspace, customerId: string, productId: string, qty: number) =>
    A.createInvoice(s, {
      customerId,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId, qty }],
    });

  it('a hold of 100 protects stock from another customer and reports the product', () => {
    const { s, p, supplier, customer } = stocked();
    A.receiveStock(s, {
      productId: p.id,
      qty: 200,
      cost: 2,
      code: 'HOLD',
      expiry: A.shift(500),
      warehouseId: 'wh_main',
      supplierId: supplier.id,
    });
    const other = A.saveContact(s, { ...customer, name: 'Other customer' });
    const before = A.free(s, p.id);
    const hold = A.holdStock(s, { productId: p.id, customerId: customer.id, qty: 100 });
    expect(hold).toMatchObject({
      id: expect.stringMatching(/^rsv_/),
      number: 'RSV-0001',
      expires: A.shift(3),
      createdBy: CURRENT_USER,
      source: 'hold',
      status: 'Active',
    });
    expect(A.free(s, p.id)).toBe(before - 100);
    const invoice = draft(s, other.id, p.id, 131);
    const saved = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, invoice.id))).toThrow(
      'Not enough free stock: Test product (need 131, free 130).',
    );
    expect(s).toEqual(saved);
    assertInvariants(s);
  });

  it('sums base factors per product and fulfills a draft using its own reserved units', () => {
    const { s, p, customer } = stocked();
    A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 10, barcode: '' }] }, p.id);
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [
        { productId: p.id, unit: 'carton', qty: 2 },
        { productId: p.id, qty: 5 },
      ],
    });
    const reservations = A.reserveInvoice(s, invoice.id);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].qty).toBe(25);
    expect(A.reserved(s, p.id)).toBe(25);
    expect(A.free(s, p.id)).toBe(5);
    expect(A.free(s, p.id, { customerId: customer.id, exceptSourceId: invoice.id })).toBe(30);
    expect(() => A.reserveInvoice(s, invoice.id)).toThrow('This draft is already reserved.');
    A.issueInvoice(s, invoice.id);
    expect(reservations[0]).toMatchObject({ status: 'Fulfilled', closedAt: expect.any(String) });
    expect(A.reserved(s, p.id)).toBe(0);
    expect(A.free(s, p.id)).toBe(5);
    assertInvariants(s);
  });

  it('deleteDraft releases promises and retains valid released history', () => {
    const { s, p, customer } = stocked();
    const invoice = draft(s, customer.id, p.id, 25);
    const [r] = A.reserveInvoice(s, invoice.id);
    A.deleteDraft(s, invoice.id);
    expect(s.invoices).toHaveLength(0);
    expect(r).toMatchObject({ status: 'Released', closedAt: expect.any(String) });
    expect(A.free(s, p.id)).toBe(30);
    assertInvariants(s);
  });

  it('rolls back an oversized reserved edit, and replaces reservations on a valid edit', () => {
    const { s, p, customer } = stocked();
    const invoice = draft(s, customer.id, p.id, 25);
    const [r] = A.reserveInvoice(s, invoice.id);
    const before = structuredClone(s);
    const input = {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 31 }],
    };
    expect(() => A.transact(s, (copy) => A.createInvoice(copy, input, invoice.id))).toThrow(
      'Not enough free stock to keep this draft reserved: Test product (need 31, free 30).',
    );
    expect(s).toEqual(before);
    expect(r.status).toBe('Active');
    const { state } = A.transact(s, (copy) =>
      A.createInvoice(copy, { ...input, lines: [{ productId: p.id, qty: 20 }] }, invoice.id),
    );
    expect(state.reservations.find((reservation) => reservation.id === r.id)?.status).toBe(
      'Released',
    );
    expect(A.reserved(state, p.id)).toBe(20);
    assertInvariants(state);
    const other = A.saveContact(state, { ...customer, name: 'Replacement customer' });
    A.createInvoice(
      state,
      { ...input, customerId: other.id, lines: [{ productId: p.id, qty: 15 }] },
      invoice.id,
    );
    expect(
      state.reservations.find(
        (reservation) => reservation.sourceId === invoice.id && reservation.status === 'Active',
      ),
    ).toMatchObject({ customerId: other.id, qty: 15 });
    expect(state.reservations.find((reservation) => reservation.id === r.id)?.customerId).toBe(
      customer.id,
    );
    assertInvariants(state);
    assertInvariants(s);
  });

  it('evaluates expired holds lazily, includes today, and permits releasing an expired hold', () => {
    const { s, p, customer } = stocked();
    const r = A.holdStock(s, {
      productId: p.id,
      customerId: customer.id,
      qty: 10,
      expires: A.today(),
    });
    expect(A.reservationStatus(r)).toBe('Active');
    const tomorrow = A.shift(1);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(tomorrow + 'T12:00:00'));
      expect(A.reserved(s, p.id)).toBe(0);
      expect(A.reservationStatus(r)).toBe('Expired');
      expect(r.status).toBe('Active');
      A.releaseReservation(s, r.id);
      expect(A.reservationStatus(r)).toBe('Released');
      expect(r.closedAt).toBeTruthy();
      assertInvariants(s);
    } finally {
      vi.useRealTimers();
    }
    assertInvariants(s);
  });

  it('converts holds atomically to a reserved draft and rejects another customer or expired hold', () => {
    const { s, p, customer } = stocked();
    const hold = A.holdStock(s, { productId: p.id, customerId: customer.id, qty: 25 });
    const input = {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 25 }],
      fromHoldIds: [hold.id],
    };
    const other = A.saveContact(s, { ...customer, name: 'Other customer' });
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => A.createInvoice(copy, { ...input, customerId: other.id })),
    ).toThrow('The hold must be for the same customer.');
    expect(() =>
      A.transact(s, (copy) =>
        A.createInvoice(copy, { ...input, lines: [{ productId: p.id, qty: 31 }] }),
      ),
    ).toThrow('Not enough free stock: Test product (need 31, free 30).');
    expect(s).toEqual(before);
    const { state, value: invoice } = A.transact(s, (copy) => A.createInvoice(copy, input));
    expect(state.reservations.find((r) => r.id === hold.id)?.status).toBe('Released');
    expect(state.reservations.find((r) => r.sourceId === invoice.id)).toMatchObject({
      qty: 25,
      status: 'Active',
    });
    expect(A.free(state, p.id)).toBe(5);
    const afterExpiry = A.shift(4);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(afterExpiry + 'T12:00:00'));
      expect(() =>
        A.transact(s, (copy) =>
          A.createInvoice(copy, { ...input, date: A.today(), due: A.shift(30) }),
        ),
      ).toThrow('Select an active, non-expired hold.');
    } finally {
      vi.useRealTimers();
    }
    assertInvariants(state);
    assertInvariants(s);
  });

  it('allows physical write-offs below promises and reports negative free stock', () => {
    const { s, p, customer, late } = stocked();
    A.holdStock(s, { productId: p.id, customerId: customer.id, qty: 25 });
    A.adjustStock(s, { batchId: late.id, qty: -20, reason: 'damaged' });
    expect(A.reserved(s, p.id)).toBe(25);
    expect(A.free(s, p.id)).toBe(-15);
    assertInvariants(s);
  });

  it('respects a 365-day customer shelf life and subtracts promises from eligible stock', () => {
    const { s, p, customer, supplier } = stocked();
    A.saveContact(s, { ...customer, minShelfLifeDays: 365 }, customer.id);
    A.receiveStock(s, {
      productId: p.id,
      qty: 40,
      cost: 2,
      code: 'LONG',
      expiry: A.shift(500),
      warehouseId: 'wh_main',
      supplierId: supplier.id,
    });
    A.holdStock(s, { productId: p.id, customerId: customer.id, qty: 10 });
    expect(A.free(s, p.id, { customerId: customer.id })).toBe(30);
    expect(A.free(s, p.id)).toBe(60);
    expect(A.free(s, p.id, { customerId: customer.id, allowShortDated: true })).toBe(60);
    assertInvariants(s);
  });

  it('reports every short product and creates no partial invoice reservation', () => {
    const { s, p, customer } = stocked();
    const second = A.saveProduct(s, { ...p, name: 'Second product', sku: 'TEST-2' });
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [
        { productId: p.id, qty: 31 },
        { productId: second.id, qty: 2 },
      ],
    });
    const before = structuredClone(s);
    expect(() => A.reserveInvoice(s, invoice.id)).toThrow(
      'Not enough free stock: Test product (need 31, free 30), Second product (need 2, free 0).',
    );
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('validates hold quantity, active products, customers, dates and release status', () => {
    const { s, p, customer, supplier } = stocked();
    const input = { productId: p.id, customerId: customer.id, qty: 1 };
    for (const qty of [0, -1, 1.5, NaN, Infinity])
      expect(() => A.holdStock(s, { ...input, qty })).toThrow(
        'Quantity must be a positive whole number below 10,000,000.',
      );
    expect(() => A.holdStock(s, { ...input, customerId: supplier.id })).toThrow(
      'Select a customer.',
    );
    for (const expires of [A.shift(-1), A.shift(31)])
      expect(() => A.holdStock(s, { ...input, expires })).toThrow(
        'Hold expiry must be between today and 30 days from today.',
      );
    expect(() => A.holdStock(s, { ...input, expires: '2026-02-30' })).toThrow(
      'Enter a valid date.',
    );
    const r = A.holdStock(s, { ...input, expires: A.shift(30) });
    A.releaseReservation(s, r.id);
    expect(() => A.releaseReservation(s, r.id)).toThrow(
      'Only active or expired reservations can be released.',
    );
    p.active = false;
    expect(() => A.holdStock(s, input)).toThrow('Test product is inactive.');
    p.active = true;
    assertInvariants(s);
  });

  it('seeds reservations, migrates v1 defaults idempotently and validates reservation backups', () => {
    const s = A.seed();
    const draft = s.invoices.find((i) => i.status === 'Draft' && !i.deliveryIds.length)!;
    expect(A.contact(s, draft.customerId)?.name).toBe('Lotus Health Pharmacy');
    expect(s.reservations.filter((r) => r.sourceId === draft.id).map((r) => r.status)).toEqual([
      'Active',
      'Active',
    ]);
    const active = s.reservations.find(
      (r) => r.source === 'hold' && A.reservationStatus(r) === 'Active',
    )!;
    expect(A.contact(s, active.customerId)?.name).toBe('Greenlife Pharmacy');
    expect(active).toMatchObject({ productId: 'p1', qty: 100, expires: A.shift(2) });
    const expired = s.reservations.find((r) => A.reservationStatus(r) === 'Expired')!;
    expect(A.contact(s, expired.customerId)?.name).toBe('Wellness Medical Center');
    expect(s.reservations.some((r) => r.status === 'Released')).toBe(true);
    assertInvariants(s);
    const raw = JSON.parse(JSON.stringify(s));
    raw.version = 1;
    delete raw.reservations;
    delete raw.counters.reservation;
    const migrated = A.validateBackup(raw);
    expect(migrated.reservations).toEqual([]);
    expect(migrated.counters.reservation).toBe(1);
    expect(A.migrate(structuredClone(migrated))).toEqual(migrated);
    expect(A.migrate(structuredClone(s))).toEqual(s);
    assertInvariants(migrated);
    expect(() => A.validateBackup({ ...s, reservations: null })).toThrow(
      'Backup is missing reservations.',
    );
    for (const patch of [
      { productId: 'missing' },
      { customerId: 's1' },
      { qty: 0 },
      { qty: 1.5 },
      { status: 'Expired' },
      { source: 'sales_order' },
      { expires: 'bad' },
    ]) {
      const bad = structuredClone(s);
      Object.assign(
        bad.reservations.find((r) => r.id === active.id)!,
        patch,
      );
      expect(() => A.validateBackup(bad)).toThrow();
    }
    const bad = structuredClone(s);
    bad.reservations.find((r) => r.sourceId === draft.id)!.sourceId = 'missing';
    expect(() => A.validateBackup(bad)).toThrow('Backup contains an invalid reservation invoice.');
    const { s: issuedState, p, customer } = stocked();
    const issued = A.createInvoice(issuedState, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 5 }],
    });
    const [r] = A.reserveInvoice(issuedState, issued.id);
    A.issueInvoice(issuedState, issued.id);
    expect(() => A.reserveInvoice(issuedState, issued.id)).toThrow(
      'Only draft invoices can be reserved.',
    );
    assertInvariants(issuedState);
    r.status = 'Active';
    expect(() => A.validateBackup(issuedState)).toThrow(
      'Issued invoices cannot have Active reservations.',
    );
    r.status = 'Fulfilled';
    assertInvariants(issuedState);
    assertInvariants(s);
  });
});

describe('reorder levels and suggestions', () => {
  it('creates, replaces and removes per-warehouse rules without changing the company threshold', () => {
    const { s, p } = stocked();
    const rule = A.saveReorderRule(s, {
      productId: p.id,
      warehouseId: 'wh_main',
      min: 10,
      max: 50,
    });
    expect(rule).toEqual(s.reorderRules[0]);
    A.saveReorderRule(s, { ...rule, min: 0, max: 20 });
    A.saveReorderRule(s, { ...rule, warehouseId: 'wh_branch' });
    expect(s.reorderRules).toHaveLength(2);
    expect(p.reorder).toBe(10);
    A.deleteReorderRule(s, p.id, 'wh_main');
    expect(s.reorderRules).toEqual([{ ...rule, warehouseId: 'wh_branch' }]);
    A.deleteReorderRule(s, p.id, 'wh_main');
    assertInvariants(s);
  });

  it('suggests at or below min, uses max minus position, and leaves products without rules out', () => {
    const { s, p } = stocked();
    expect(A.reorderSuggestions(s)).toEqual([]);
    const rule = { productId: p.id, warehouseId: 'wh_main', min: 29, max: 100 };
    A.saveReorderRule(s, rule);
    expect(A.reorderSuggestions(s)).toEqual([]);
    A.saveReorderRule(s, { ...rule, min: 30 });
    expect(A.reorderSuggestions(s)).toEqual([
      {
        ...rule,
        min: 30,
        supplierId: p.supplierId,
        available: 30,
        onOrder: 0,
        position: 30,
        orderBase: 70,
        orderUnit: 'box',
        orderQty: 70,
        estimatedCost: 140,
      },
    ]);
    A.saveReorderRule(s, { ...rule, min: 40 });
    expect(A.reorderSuggestions(s)[0].orderBase).toBe(70);
    expect(A.reorderSuggestions(s, 'wh_branch')).toEqual([]);
    assertInvariants(s);
  });

  it('counts only Ordered POs at the same warehouse, using stored base factors', () => {
    const { s, p, supplier } = stocked();
    const packed = A.saveProduct(
      s,
      { ...p, packs: [{ unit: 'carton', factor: 10, barcode: '' }] },
      p.id,
    );
    A.saveReorderRule(s, { productId: p.id, warehouseId: 'wh_main', min: 60, max: 100 });
    const order = (warehouseId: string, qty: number) =>
      A.createPurchase(s, {
        supplierId: supplier.id,
        warehouseId,
        date: A.today(),
        expected: A.shift(5),
        lines: [{ productId: p.id, unit: 'carton', qty }],
      });
    order('wh_branch', 20);
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(0);
    const first = order('wh_main', 2);
    expect(A.reorderSuggestions(s)[0]).toMatchObject({ onOrder: 20, position: 50, orderBase: 50 });
    // Historical order factors stay valid even when today's pack size changes.
    A.saveProduct(s, { ...packed, packs: [{ unit: 'carton', factor: 20, barcode: '' }] }, p.id);
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(20);
    const second = order('wh_main', 1);
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(40);
    expect(A.reorderSuggestions(s)).toEqual([]);
    A.cancelPurchase(s, second.id);
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(20);
    A.sendPurchase(s, first.id);
    A.receivePurchase(s, first.id, [{ code: 'PO-REORDER', expiry: A.shift(400) }]);
    expect(A.onOrder(s, p.id, 'wh_main')).toBe(0);
    expect(A.reorderSuggestions(s)[0].available).toBe(50);
    assertInvariants(s);
  });

  it('rounds need 130 up to three cartons of 50 and prices the largest pack using purchase cost', () => {
    const { s, p } = stocked();
    A.saveProduct(
      s,
      {
        ...p,
        packs: [
          { unit: 'case', factor: 10, barcode: '', price: 999 },
          { unit: 'carton', factor: 50, barcode: '', price: 9999 },
        ],
      },
      p.id,
    );
    A.saveReorderRule(s, { productId: p.id, warehouseId: 'wh_main', min: 30, max: 160 });
    expect(A.reorderSuggestions(s)[0]).toMatchObject({
      orderQty: 3,
      orderBase: 150,
      orderUnit: 'carton',
      estimatedCost: 300,
    });
    assertInvariants(s);
  });

  it('excludes quarantined, expired and recalled stock from available', () => {
    const { s, p, early, late } = stocked();
    A.setQuarantine(s, early.id, true);
    A.saveReorderRule(s, { productId: p.id, warehouseId: 'wh_main', min: 20, max: 100 });
    expect(A.reorderSuggestions(s)[0].available).toBe(20);
    const future = new Date(A.shift(121) + 'T12:00:00');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(future);
      expect(A.reorderSuggestions(s)[0]).toMatchObject({ available: 0, orderBase: 100 });
    } finally {
      vi.useRealTimers();
    }
    A.createRecall(s, { productId: p.id, lotCode: late.code, reason: 'Supplier defect notice' });
    expect(A.reorderSuggestions(s)[0].available).toBe(0);
    assertInvariants(s);
  });

  it('rejects min ≥ max, unsafe or fractional levels, unknown references and inactive products atomically', () => {
    const { s, p } = stocked();
    const rule = { productId: p.id, warehouseId: 'wh_main', min: 0, max: 50 };
    for (const levels of [
      { min: 50, max: 50 },
      { min: 51, max: 50 },
      { min: -1, max: 50 },
      { min: 0.5, max: 50 },
      { min: 0, max: 50.5 },
      { min: 0, max: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() =>
        A.transact(s, (draft) => A.saveReorderRule(draft, { ...rule, ...levels })),
      ).toThrow('Reorder levels must be whole numbers with 0 ≤ min < max.');
    }
    expect(() => A.saveReorderRule(s, { ...rule, productId: 'missing' })).toThrow(
      'Product not found.',
    );
    expect(() => A.saveReorderRule(s, { ...rule, warehouseId: 'missing' })).toThrow(
      'Select a warehouse.',
    );
    A.saveReorderRule(s, rule);
    for (const b of s.batches) A.adjustStock(s, { batchId: b.id, qty: -b.qty, reason: 'damaged' });
    A.saveProduct(s, { ...p, active: false }, p.id);
    expect(() => A.saveReorderRule(s, rule)).toThrow(`${p.name} is inactive.`);
    expect(A.reorderSuggestions(s)).toEqual([]);
    expect(s.reorderRules).toEqual([rule]);
    assertInvariants(s);
  });

  it('seeds all main and eight branch rules, three supplier groups and visible carton rounding; migrates v1 idempotently', () => {
    const s = A.seed();
    expect(s.reorderRules.filter((r) => r.warehouseId === 'wh_main')).toEqual(
      s.products.map((p) => ({
        productId: p.id,
        warehouseId: 'wh_main',
        min: p.reorder,
        max: p.reorder * 4,
      })),
    );
    expect(s.reorderRules.filter((r) => r.warehouseId === 'wh_branch')).toHaveLength(8);
    const suggestions = A.reorderSuggestions(s);
    expect(new Set(suggestions.map((r) => r.supplierId)).size).toBeGreaterThanOrEqual(3);
    expect(
      suggestions.some((r) => r.orderUnit === 'carton' && r.orderBase > r.max - r.position),
    ).toBe(true);
    assertInvariants(s);
    const raw = JSON.parse(JSON.stringify(s));
    raw.version = 1;
    delete raw.reorderRules;
    const migrated = A.validateBackup(raw);
    expect(migrated.reorderRules).toEqual([]);
    expect(A.migrate(structuredClone(migrated))).toEqual(migrated);
    expect(A.migrate(structuredClone(s))).toEqual(s);
    assertInvariants(migrated);
    const bad = structuredClone(s);
    bad.reorderRules.push({ ...bad.reorderRules[0] });
    expect(() => A.validateBackup(bad)).toThrow('Backup contains duplicate reorder rules.');
    expect(() => A.validateBackup({ ...s, reorderRules: null })).toThrow(
      'Backup is missing reorderRules.',
    );
  });
});
describe('expiry rules and recalls', () => {
  const invoiceFor = (
    s: Workspace,
    customerId: string,
    productId: string,
    qty: number,
    allowShortDated = false,
  ) =>
    A.createInvoice(s, {
      customerId,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId, qty }],
      allowShortDated,
    });

  it('enforces a 365-day override and uses short-dated stock in FEFO order only with explicit consent', () => {
    const { s, customer, p, early, late } = stocked();
    A.setMinShelfLife(s, 180);
    A.saveContact(s, { ...customer, minShelfLifeDays: 365 }, customer.id);
    const long = A.receiveStock(s, {
      productId: p.id,
      warehouseId: 'wh_main',
      qty: 40,
      cost: 2,
      code: 'LONG',
      expiry: A.shift(365),
    });
    const opts = { customerId: customer.id, allowShortDated: false };
    expect(A.eligibleBatches(s, p.id, opts).map((b) => b.id)).toEqual([long.id]);
    expect(A.sellableQty(s, p.id, opts)).toBe(40);
    expect(A.available(s, p.id)).toBe(70);
    const regular = invoiceFor(s, customer.id, p.id, 5);
    A.issueInvoice(s, regular.id);
    expect(A.invoicePicks(s, regular).map((a) => a.batchId)).toEqual([long.id]);
    assertInvariants(s);
    const consent = invoiceFor(s, customer.id, p.id, 15, true);
    expect(
      A.shortDatedBatches(
        s,
        [
          { productId: p.id, qty: 2, factor: 1 },
          { productId: p.id, qty: 13, factor: 1 },
        ],
        { ...opts, allowShortDated: true },
      ).map((b) => b.id),
    ).toEqual([early.id, late.id]);
    expect(A.shortDatedBatches(s, consent.lines, opts)).toEqual([]);
    A.issueInvoice(s, consent.id);
    expect(A.invoicePicks(s, consent).map((a) => [a.batchId, a.qty])).toEqual([
      [early.id, 10],
      [late.id, 5],
    ]);
    assertInvariants(s);
  });

  it('reports the exact short-dated quantity and falls back to the company setting for null', () => {
    const { s, customer, p } = stocked();
    A.setMinShelfLife(s, 180);
    expect(A.shelfLifeFor(s, customer.id)).toBe(180);
    A.saveContact(s, { ...customer, minShelfLifeDays: 0 }, customer.id);
    expect(A.shelfLifeFor(s, customer.id)).toBe(0);
    A.saveContact(s, { ...customer, minShelfLifeDays: null }, customer.id);
    expect(A.shelfLifeFor(s, customer.id)).toBe(180);
    const inv = invoiceFor(s, customer.id, p.id, 1);
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, inv.id))).toThrow(
      'Only 0 boxes of Test product have at least 180 days of shelf life (30 more are short-dated). Tick "Allow short-dated stock" if the customer accepts them.',
    );
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('reports sellable stock shortages without suggesting consent already given', () => {
    const { s, customer, p } = stocked();
    A.setMinShelfLife(s, 180);
    const inv = invoiceFor(s, customer.id, p.id, 31, true);
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, inv.id))).toThrow(
      'Not enough sellable stock: Test product (need 31, available 30).',
    );
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('blocks sales and receipts across warehouses case-insensitively, allows transfers, and closes after recall write-offs', () => {
    const { s, customer, p, early, late } = stocked();
    const sale = invoiceFor(s, customer.id, p.id, 3);
    A.issueInvoice(s, sale.id);
    const recall = A.createRecall(s, { productId: p.id, lotCode: 'early', reason: 'Seal defect' });
    expect(recall).toMatchObject({ number: 'RCL-0001', createdBy: CURRENT_USER, status: 'Open' });
    A.transferStock(s, { batchId: early.id, qty: 2, to: 'wh_branch' });
    const branch = s.batches.find((b) => b.code === early.code && b.warehouseId === 'wh_branch')!;
    expect(A.isRecalled(s, branch)).toBe(true);
    expect(
      A.eligibleBatches(s, p.id, { customerId: customer.id, allowShortDated: true }).map(
        (b) => b.id,
      ),
    ).toEqual([late.id]);
    expect(A.available(s, p.id)).toBe(20);
    expect(A.available(s, p.id, 'wh_branch')).toBe(0);
    const inv = invoiceFor(s, customer.id, p.id, 21, true);
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, inv.id))).toThrow(
      'Not enough sellable stock: Test product (need 21, available 20).',
    );
    expect(() =>
      A.transact(s, (copy) =>
        A.receiveStock(copy, {
          productId: p.id,
          warehouseId: 'wh_branch',
          code: 'early',
          qty: 1,
          cost: 3,
          expiry: early.expiry,
        }),
      ),
    ).toThrow('Lot EARLY is under recall (RCL-0001).');
    expect(s).toEqual(before);
    expect(() => A.closeRecall(s, recall.id)).toThrow(
      '7 units of lot EARLY are still in stock. Write them off first.',
    );
    expect(() =>
      A.createRecall(s, { productId: p.id, lotCode: 'EaRlY', reason: 'Duplicate' }),
    ).toThrow('This lot already has an Open recall.');
    const trace = A.recallTrace(s, recall.id);
    expect(trace.sold).toEqual([
      {
        customerId: customer.id,
        customerName: customer.name,
        phone: customer.phone,
        invoice: sale.number,
        delivery: A.deliveriesOf(s, sale)[0].number,
        date: sale.date,
        qty: 3,
        returned: 0,
      },
    ]);
    expect(trace.totals).toEqual({ received: 10, sold: 3, returned: 0, adjusted: 0, onHand: 7 });
    assertInvariants(s);
    trace.onHand.forEach((b) =>
      A.adjustStock(s, { batchId: b.batchId, qty: -b.qty, reason: 'recall' }),
    );
    const totals = A.recallTrace(s, recall.id).totals;
    expect(totals).toEqual({ received: 10, sold: 3, returned: 0, adjusted: -7, onHand: 0 });
    expect(totals.received - totals.sold + totals.returned + totals.adjusted).toBe(totals.onHand);
    A.closeRecall(s, recall.id);
    expect(recall.status).toBe('Closed');
    expect(recall.closedAt).toBeTruthy();
    expect(A.isRecalled(s, early)).toBe(false);
    A.receiveStock(s, {
      productId: p.id,
      warehouseId: 'wh_main',
      code: early.code,
      qty: 1,
      cost: 3,
      expiry: early.expiry,
    });
    expect(
      A.eligibleBatches(s, p.id, { customerId: customer.id, allowShortDated: true }),
    ).toContain(early);
    expect(() => A.closeRecall(s, recall.id)).toThrow('Only Open recalls can be closed.');
    assertInvariants(s);
  });

  it('requires an Open recall for recall adjustments and validates recall inputs atomically', () => {
    const { s, p, early } = stocked();
    const before = structuredClone(s);
    expect(() => A.adjustStock(s, { batchId: early.id, qty: -1, reason: 'recall' })).toThrow(
      'Recall adjustments require an Open recall for the lot.',
    );
    for (const input of [
      { productId: p.id, lotCode: early.code, reason: '   ' },
      { productId: p.id, lotCode: 'missing', reason: 'Defect' },
      { productId: 'missing', lotCode: early.code, reason: 'Defect' },
      { productId: p.id, lotCode: early.code, reason: 'Defect', date: '2026-02-30' },
    ])
      expect(() => A.transact(s, (copy) => A.createRecall(copy, input))).toThrow();
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('keeps Recalled > Quarantined > Expired > Expiring soon > Active precedence and a secondary short-dated flag', () => {
    const { s, p, early } = stocked();
    A.setMinShelfLife(s, 180);
    expect(A.batchStatus(s, early)).toBe('Expiring soon');
    expect(A.shortDated(s, early)).toBe(true);
    early.expiry = A.shift(180);
    expect(A.batchStatus(s, early)).toBe('Active');
    expect(A.shortDated(s, early)).toBe(false);
    early.expiry = A.today();
    expect(A.batchStatus(s, early)).toBe('Expired');
    expect(A.shortDated(s, early)).toBe(false);
    early.quarantined = true;
    expect(A.batchStatus(s, early)).toBe('Quarantined');
    A.createRecall(s, { productId: p.id, lotCode: early.code, reason: 'Defect' });
    expect(A.batchStatus(s, early)).toBe('Recalled');
    assertInvariants(s);
  });

  it('seeds realistic Open and Closed recalls, customer overrides, and historical short-dated consent', () => {
    const s = A.seed();
    assertInvariants(s);
    expect(s.settings.minShelfLifeDays).toBe(180);
    expect(s.contacts.find((c) => c.name === 'Sunrise Hospital')!.minShelfLifeDays).toBe(365);
    expect(s.contacts.find((c) => c.name === 'CarePlus Clinic')!.minShelfLifeDays).toBe(90);
    const open = s.recalls.find((r) => r.status === 'Open')!,
      closed = s.recalls.find((r) => r.status === 'Closed')!;
    const trace = A.recallTrace(s, open.id);
    expect(open.reason).toBe('Supplier notice: packaging seal defect');
    expect(trace.totals.onHand).toBeGreaterThan(0);
    expect(new Set(trace.sold.map((row) => row.customerId)).size).toBeGreaterThan(1);
    const customersByLot = new Map<string, Set<string>>();
    s.stockMoves
      .filter((m) => m.type === 'sale')
      .forEach((m) => {
        const key = `${m.productId}|${m.lotCode.toLowerCase()}`,
          customers = customersByLot.get(key) || new Set<string>();
        customers.add(m.counterpartyId!);
        customersByLot.set(key, customers);
      });
    expect(new Set(trace.sold.map((row) => row.customerId)).size).toBe(
      Math.max(...[...customersByLot.values()].map((customers) => customers.size)),
    );
    expect(A.recallTrace(s, closed.id).totals.onHand).toBe(0);
    expect(s.invoices.some((i) => i.status === 'Issued' && i.allowShortDated)).toBe(true);
    for (const r of s.recalls) {
      const t = A.recallTrace(s, r.id).totals;
      expect(t.received - t.sold + t.returned + t.adjusted).toBe(t.onHand);
    }
    assertInvariants(s);
  });

  it('migrates missing fields from a v1 seed idempotently and rejects invalid expiry and recall backup fields', () => {
    const s = A.seed(),
      raw = JSON.parse(JSON.stringify(s));
    raw.version = 1;
    delete raw.settings.minShelfLifeDays;
    delete raw.recalls;
    delete raw.counters.recall;
    raw.contacts.forEach((c: Record<string, unknown>) => delete c.minShelfLifeDays);
    raw.invoices.forEach((i: Record<string, unknown>) => delete i.allowShortDated);
    const migrated = A.validateBackup(raw);
    expect(migrated.settings.minShelfLifeDays).toBe(180);
    expect(migrated.recalls).toEqual([]);
    expect(migrated.counters.recall).toBe(1);
    expect(migrated.contacts.every((c) => c.minShelfLifeDays === null)).toBe(true);
    expect(migrated.invoices.every((i) => i.allowShortDated === false)).toBe(true);
    expect(A.migrate(structuredClone(migrated))).toEqual(migrated);
    assertInvariants(migrated);
    for (const value of [-1, 1.5, 1096, '180', null]) {
      const bad = structuredClone(s);
      Object.assign(bad.settings, { minShelfLifeDays: value });
      expect(() => A.validateBackup(bad)).toThrow();
      const contactBad = structuredClone(s);
      Object.assign(contactBad.contacts[0], { minShelfLifeDays: value === null ? 'bad' : value });
      expect(() => A.validateBackup(contactBad)).toThrow();
    }
    for (const patch of [{ productId: 'missing' }, { status: 'Invalid' }]) {
      const bad = structuredClone(s);
      Object.assign(bad.recalls[0], patch);
      expect(() => A.validateBackup(bad)).toThrow();
    }
    const duplicate = structuredClone(s),
      open = duplicate.recalls.find((r) => r.status === 'Open')!;
    duplicate.recalls.push({
      ...open,
      id: 'another',
      number: 'RCL-9999',
      lotCode: open.lotCode.toLowerCase(),
    });
    expect(() => A.validateBackup(duplicate)).toThrow(
      'Backup contains multiple Open recalls for a lot.',
    );
    const invalid = structuredClone(s);
    Object.assign(invalid.invoices[0], { allowShortDated: 'yes' });
    expect(() => A.validateBackup(invalid)).toThrow('Allow short-dated stock must be a boolean.');
    assertInvariants(s);
  });
});

describe('pharma product fields', () => {
  it('enforces cold storage for receipts and transfers while allowing ambient products in cold storage', () => {
    const { s, p } = stocked();
    const cold = A.saveProduct(s, { ...p, sku: 'COLD-1', name: 'Cold medicine', storage: 'cold' });
    const receipt = {
      productId: cold.id,
      qty: 10,
      cost: 2,
      code: 'COLD-LOT',
      expiry: A.shift(100),
      warehouseId: 'wh_main',
    };
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.receiveStock(copy, receipt))).toThrow(
      'Cold medicine must be stored at 2–8°C. Choose a cold-storage warehouse.',
    );
    expect(s).toEqual(before);
    s.warehouses.find((w) => w.id === 'wh_branch')!.storage = 'cold';
    const batch = A.receiveStock(s, { ...receipt, warehouseId: 'wh_branch' });
    const stockedBefore = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => A.transferStock(copy, { batchId: batch.id, qty: 2, to: 'wh_main' })),
    ).toThrow('Cold medicine must be stored at 2–8°C. Choose a cold-storage warehouse.');
    expect(s).toEqual(stockedBefore);
    A.transferStock(s, { batchId: batch.id, qty: 2, to: 'wh_cold' });
    expect(A.onHand(s, cold.id, 'wh_cold')).toBe(2);
    A.receiveStock(s, { ...receipt, productId: p.id, warehouseId: 'wh_cold' });
    assertInvariants(s);
  });

  it('covers opening stock, positive adjustments, count differences and purchase receipts through moveStock', () => {
    const { s, p, supplier, late } = stocked();
    const cold = A.saveProduct(s, { ...p, sku: 'COLD-2', name: 'Cold medicine', storage: 'cold' });
    const stock = {
      productId: cold.id,
      qty: 2,
      cost: 2,
      code: 'COLD-ZERO',
      expiry: A.shift(100),
      warehouseId: 'wh_main',
    };
    expect(() => A.transact(s, (copy) => A.addBatch(copy, stock, { moveType: 'opening' }))).toThrow(
      'Cold medicine must be stored at 2–8°C. Choose a cold-storage warehouse.',
    );
    // A historical empty ambient lot may remain after a product becomes cold-chain.
    A.saveProduct(s, { ...cold, storage: 'ambient' }, cold.id);
    const zero = A.receiveStock(s, stock);
    A.adjustStock(s, { batchId: zero.id, qty: -2, reason: 'lost' });
    A.saveProduct(s, { ...cold, storage: 'cold' }, cold.id);
    expect(() =>
      A.transact(s, (copy) =>
        A.adjustStock(copy, { batchId: zero.id, qty: 1, reason: 'found', note: 'Found on shelf' }),
      ),
    ).toThrow('Cold medicine must be stored at 2–8°C. Choose a cold-storage warehouse.');
    const count = A.startCount(s, { warehouseId: 'wh_main' });
    A.addCountLine(s, count.id, zero.id);
    count.lines.forEach((l) =>
      A.recordCount(s, count.id, l.batchId, l.batchId === zero.id ? 1 : l.expected),
    );
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.postCount(copy, count.id))).toThrow(
      'Cold medicine must be stored at 2–8°C. Choose a cold-storage warehouse.',
    );
    expect(s).toEqual(before);
    A.cancelCount(s, count.id);
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(1),
      lines: [{ productId: cold.id, qty: 2 }],
      send: true,
    });
    expect(() =>
      A.transact(s, (copy) =>
        A.receivePurchase(copy, po.id, {
          lines: [
            { purchaseLineId: po.lines[0].id, qty: 2, code: 'COLD-PO', expiry: A.shift(100) },
          ],
        }),
      ),
    ).toThrow('Cold medicine must be stored at 2–8°C. Choose a cold-storage warehouse.');
    const coldPo = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_cold',
      date: A.today(),
      expected: A.shift(1),
      lines: [{ productId: cold.id, qty: 2 }],
      send: true,
    });
    A.receivePurchase(s, coldPo.id, {
      lines: [
        { purchaseLineId: coldPo.lines[0].id, qty: 2, code: 'COLD-PO', expiry: A.shift(100) },
      ],
    });
    const coldBatch = s.batches.find((b) => b.productId === cold.id && b.qty > 0)!;
    A.adjustStock(s, {
      batchId: coldBatch.id,
      qty: 1,
      reason: 'found',
      note: 'Found in cold storage',
    });
    A.adjustStock(s, { batchId: late.id, qty: -1, reason: 'lost' });
    assertInvariants(s);
  });

  it('blocks switching to cold-chain until all physical stock, including quarantined lots, is in cold storage', () => {
    const { s, p, late, early } = stocked();
    A.setQuarantine(s, early.id, true);
    expect(() => A.saveProduct(s, { ...p, storage: 'cold' }, p.id)).toThrow(
      'Move Test product into cold storage before marking it cold-chain.',
    );
    A.transferStock(s, { batchId: late.id, qty: late.qty, to: 'wh_cold' });
    expect(() => A.saveProduct(s, { ...p, storage: 'cold' }, p.id)).toThrow(
      'Move Test product into cold storage before marking it cold-chain.',
    );
    A.transferStock(s, { batchId: early.id, qty: early.qty, to: 'wh_cold' });
    const changed = A.saveProduct(s, { ...p, storage: 'cold' }, p.id);
    expect(changed.storage).toBe('cold');
    assertInvariants(s);
  });

  it('normalizes registrations, rejects duplicates case-insensitively and treats missing registration as a warning', () => {
    const { s, p } = stocked();
    const saved = A.saveProduct(
      s,
      {
        ...p,
        registrationNo: ' reg-00123 ',
        dosageForm: 'tablet',
        manufacturer: ' Test factory ',
        strength: ' 500 mg ',
      },
      p.id,
    );
    expect(saved).toMatchObject({
      registrationNo: 'REG-00123',
      manufacturer: 'Test factory',
      strength: '500 mg',
    });
    expect(() =>
      A.saveProduct(s, { ...p, sku: 'DUP', name: 'Duplicate', registrationNo: 'ReG-00123' }),
    ).toThrow('Registration number REG-00123 is already used by Test product.');
    A.saveProduct(s, { ...saved }, p.id);
    const missing = A.saveProduct(s, {
      ...p,
      sku: 'NO-REG',
      dosageForm: 'tablet',
      registrationNo: '',
    });
    expect(A.missingRegistration(missing)).toBe(true);
    expect(A.missingRegistration(saved)).toBe(false);
    expect(A.missingRegistration({ ...missing, dosageForm: 'device' })).toBe(false);
    expect(A.missingRegistration({ ...missing, dosageForm: 'other' })).toBe(false);
    assertInvariants(s);
  });

  it('blocks retirement with stock, draft invoices or ordered purchases, preserves history and always allows reactivation', () => {
    const { s, p, late, early, customer, supplier } = stocked();
    expect(() => A.saveProduct(s, { ...p, active: false }, p.id)).toThrow(
      'Test product still has stock or open documents.',
    );
    const history = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 30 }],
    });
    A.issueInvoice(s, history.id);
    expect(late.qty + early.qty).toBe(0);
    const draft = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 1 }],
    });
    expect(() => A.saveProduct(s, { ...p, active: false }, p.id)).toThrow(
      'Test product still has stock or open documents.',
    );
    A.deleteDraft(s, draft.id);
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(1),
      lines: [{ productId: p.id, qty: 1 }],
    });
    expect(() => A.saveProduct(s, { ...p, active: false }, p.id)).toThrow(
      'Test product still has stock or open documents.',
    );
    A.cancelPurchase(s, po.id);
    const retired = A.saveProduct(s, { ...p, active: false }, p.id);
    expect(retired.active).toBe(false);
    expect(A.inactiveReason(s, p.id)).toBe('');
    expect(s.invoices.find((i) => i.id === history.id)).toEqual(history);
    expect(s.batches).toHaveLength(2);
    expect(() =>
      A.createInvoice(s, {
        customerId: customer.id,
        date: A.today(),
        due: A.shift(30),
        lines: [{ productId: p.id, qty: 1 }],
      }),
    ).toThrow('Test product is inactive.');
    expect(() =>
      A.createPurchase(s, {
        supplierId: supplier.id,
        warehouseId: 'wh_main',
        date: A.today(),
        expected: A.shift(1),
        lines: [{ productId: p.id, qty: 1 }],
      }),
    ).toThrow('Test product is inactive.');
    expect(() =>
      A.transact(s, (copy) =>
        A.receiveStock(copy, {
          productId: p.id,
          qty: 1,
          cost: 2,
          code: 'INACTIVE',
          expiry: A.shift(100),
          warehouseId: 'wh_main',
        }),
      ),
    ).toThrow('Test product is inactive.');
    const active = A.saveProduct(s, { ...retired, active: true }, p.id);
    expect(active.active).toBe(true);
    A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 1 }],
    });
    assertInvariants(s);
  });

  it.each(['Active', 'Expired', 'Released'] as const)(
    'only blocks retirement for a non-expired Active reservation: %s',
    (status) => {
      const { s, p, customer, early, late } = stocked();
      const hold = A.holdStock(s, {
        productId: p.id,
        customerId: customer.id,
        qty: 1,
        expires: A.today(),
      });
      A.adjustStock(s, { batchId: early.id, qty: -early.qty, reason: 'lost' });
      A.adjustStock(s, { batchId: late.id, qty: -late.qty, reason: 'lost' });
      if (status === 'Expired') hold.expires = A.shift(-1);
      if (status === 'Released') A.releaseReservation(s, hold.id);
      if (status === 'Active') {
        const before = structuredClone(s);
        expect(A.inactiveReason(s, p.id)).toBe('Test product still has stock or open documents.');
        expect(() =>
          A.transact(s, (copy) => A.saveProduct(copy, { ...p, active: false }, p.id)),
        ).toThrow('Test product still has stock or open documents.');
        expect(s).toEqual(before);
        A.releaseReservation(s, hold.id);
      }
      expect(A.inactiveReason(s, p.id)).toBe('');
      expect(A.saveProduct(s, { ...p, active: false }, p.id).active).toBe(false);
      assertInvariants(s);
    },
  );

  it('returns Diazepam moves with running balances, including carry-in and grouping per product and lot across warehouses', () => {
    const s = A.seed();
    assertInvariants(s);
    const diazepam = s.products.find((p) => p.name === 'Diazepam 5 mg')!;
    const moves = A.controlledRegister(s, {
      from: A.shift(-365),
      to: A.today(),
      productId: diazepam.id,
    });
    expect(moves.map((m) => [m.qty, m.balanceAfter])).toEqual([
      [100, 100],
      [-12, 88],
      [-8, 80],
    ]);
    const batch = s.batches.find((b) => b.productId === diazepam.id)!;
    A.transferStock(s, { batchId: batch.id, qty: 5, to: 'wh_branch' });
    expect(
      A.controlledRegister(s, { from: A.today(), to: A.today() })
        .slice(-2)
        .map((m) => m.balanceAfter),
    ).toEqual([75, 80]);
    const before = A.shift(-1);
    s.stockMoves.find((m) => m.id === moves[0].id)!.date = before;
    expect(
      A.controlledRegister(s, { from: A.today(), to: A.today(), productId: diazepam.id })[0]
        .balanceAfter,
    ).toBe(88);
    A.receiveStock(s, {
      productId: diazepam.id,
      qty: 7,
      cost: 3,
      code: 'DZ-SECOND',
      expiry: A.shift(100),
      warehouseId: 'wh_main',
    });
    expect(A.controlledRegister(s, { from: A.today(), to: A.today() }).at(-1)!.balanceAfter).toBe(
      7,
    );
    expect(
      A.controlledRegister(s, { from: A.shift(-2), to: before }).map((m) => m.balanceAfter),
    ).toEqual([100]);
    expect(() => A.controlledRegister(s, { from: A.today(), to: before })).toThrow(
      'Date from must be on or before date to.',
    );
    assertInvariants(s);
  });

  it('applies all v1 migration defaults, infers storage from positive stock and preserves explicit fields idempotently', () => {
    const s = A.seed();
    assertInvariants(s);
    const raw = JSON.parse(JSON.stringify(s));
    raw.version = 1;
    for (const p of raw.products)
      for (const key of [
        'registrationNo',
        'manufacturer',
        'dosageForm',
        'strength',
        'rx',
        'controlled',
        'storage',
        'nameKm',
        'active',
      ])
        delete p[key];
    raw.warehouses.forEach((w: { storage?: unknown }) => delete w.storage);
    const migrated = A.validateBackup(raw);
    expect(migrated.warehouses.map((w) => w.storage)).toEqual(['ambient', 'ambient', 'cold']);
    migrated.products.forEach((p) => {
      const batches = migrated.batches.filter((b) => b.productId === p.id && b.qty > 0);
      expect(p).toMatchObject({
        registrationNo: '',
        manufacturer: '',
        strength: '',
        nameKm: '',
        dosageForm: p.unit === 'device' ? 'device' : 'other',
        rx: false,
        controlled: false,
        active: true,
        storage:
          batches.length && batches.every((b) => b.warehouseId === 'wh_cold') ? 'cold' : 'ambient',
      });
    });
    const before = structuredClone(migrated);
    expect(A.migrate(migrated)).toEqual(before);
    const current = structuredClone(s);
    expect(A.migrate(s)).toEqual(current);
    assertInvariants(migrated);
    assertInvariants(s);
  });

  it('validates pharma enums, flags, duplicate registrations and cold stock in backups', () => {
    const s = A.seed();
    for (const patch of [
      { dosageForm: 'gel' },
      { storage: 'freezer' },
      { active: 'true' },
      { rx: 1 },
      { controlled: null },
      { nameKm: 42 },
    ]) {
      const bad = structuredClone(s);
      Object.assign(bad.products[0], patch);
      expect(() => A.validateBackup(bad)).toThrow();
    }
    const duplicate = structuredClone(s);
    duplicate.products[1].registrationNo = s.products[0].registrationNo.toLowerCase();
    expect(() => A.validateBackup(duplicate)).toThrow(
      'Registration number REG-00001 is already used by Amoxicillin 500mg.',
    );
    const cold = structuredClone(s);
    cold.products[0].storage = 'cold';
    expect(() => A.validateBackup(cold)).toThrow(
      'must be stored at 2–8°C. Choose a cold-storage warehouse.',
    );
    const warehouse = structuredClone(s);
    warehouse.warehouses[0].storage = 'freezer' as Workspace['warehouses'][number]['storage'];
    expect(() => A.validateBackup(warehouse)).toThrow('Backup contains an invalid warehouse.');
    expect(s.products.filter(A.missingRegistration)).toHaveLength(2);
    const inactive = s.products.filter((p) => !p.active);
    expect(inactive).toHaveLength(1);
    expect(A.onHand(s, inactive[0].id)).toBe(0);
    expect(s.products.every((p) => p.nameKm === '')).toBe(true);
    for (const p of s.products.filter((p) => !['device', 'other'].includes(p.dosageForm)))
      expect(p.manufacturer && p.strength).toBeTruthy();
    assertInvariants(s);
  });
});
describe('stock counts', () => {
  it('snapshots stock in the warehouse and selected categories, including held and expired lots', () => {
    const { s, p, late, early } = stocked();
    A.setQuarantine(s, early.id, true);
    late.expiry = A.shift(-1);
    const other = A.saveProduct(s, {
      ...p,
      sku: 'COUNT-OTHER',
      name: 'Other category',
      category: 'First aid',
    });
    A.receiveStock(s, {
      productId: other.id,
      qty: 2,
      cost: 1,
      code: 'OTHER',
      expiry: A.shift(40),
      warehouseId: 'wh_main',
    });
    A.receiveStock(s, {
      productId: p.id,
      qty: 2,
      cost: 2,
      code: 'BRANCH',
      expiry: A.shift(40),
      warehouseId: 'wh_branch',
    });
    const zero = A.receiveStock(s, {
      productId: p.id,
      qty: 1,
      cost: 2,
      code: 'ZERO',
      expiry: A.shift(40),
      warehouseId: 'wh_main',
    });
    A.adjustStock(s, { batchId: zero.id, qty: -1, reason: 'lost' });
    const c = A.startCount(s, {
      warehouseId: 'wh_main',
      categories: ['Pain relief'],
      blind: true,
      note: ' Shelf count ',
    });
    expect(c).toMatchObject({
      number: 'SC-0001',
      status: 'Open',
      blind: true,
      note: 'Shelf count',
      createdBy: CURRENT_USER,
      categories: ['Pain relief'],
    });
    expect(c.id).toMatch(/^count_/);
    expect(c.lines).toEqual(
      [late, early].map((b) => ({
        batchId: b.id,
        productId: b.productId,
        lotCode: b.code,
        expiry: b.expiry,
        expected: b.qty,
        counted: null,
      })),
    );
    expect(() => A.startCount(s, { warehouseId: 'wh_main' })).toThrow(
      'already has an Open stock count.',
    );
    const branch = A.startCount(s, { warehouseId: 'wh_branch' });
    expect(s.stockCounts).toEqual([branch, c]);
    expect(s.counters.count).toBe(3);
    A.cancelCount(s, c.id);
    const all = A.startCount(s, { warehouseId: 'wh_main' });
    expect(all.lines.map((l) => l.batchId)).toEqual(
      s.batches.filter((b) => b.warehouseId === 'wh_main' && b.qty > 0).map((b) => b.id),
    );
    expect(() => A.startCount(s, { warehouseId: 'wh_cold' })).toThrow(
      'There is no stock to count in Cold storage.',
    );
    expect(() => A.startCount(s, { warehouseId: 'missing' })).toThrow('Select a warehouse.');
    assertInvariants(s);
  });

  it.each([
    'receive',
    'transfer out',
    'transfer in',
    'invoice',
    'adjust',
    'purchase receipt',
  ] as const)('blocks %s in the counted warehouse atomically', (operation) => {
    const { s, p, late, customer, supplier } = stocked();
    A.transferStock(s, { batchId: late.id, qty: 5, to: 'wh_branch' });
    const branch = s.batches.find((b) => b.warehouseId === 'wh_branch')!;
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 6 }],
    });
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.shift(1),
      lines: [{ productId: p.id, qty: 2 }],
      send: true,
    });
    const count = A.startCount(s, { warehouseId: 'wh_main' });
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => {
        if (operation === 'receive')
          return A.receiveStock(copy, {
            productId: p.id,
            qty: 2,
            cost: 2,
            code: 'NEW',
            expiry: A.shift(100),
            warehouseId: 'wh_main',
          });
        if (operation === 'transfer out')
          return A.transferStock(copy, { batchId: late.id, qty: 1, to: 'wh_branch' });
        if (operation === 'transfer in')
          return A.transferStock(copy, { batchId: branch.id, qty: 1, to: 'wh_main' });
        if (operation === 'invoice') return A.issueInvoice(copy, invoice.id);
        if (operation === 'adjust')
          return A.adjustStock(
            copy,
            { batchId: late.id, qty: 1, reason: 'count', sourceId: count.id } as AdjustmentInput,
            { sourceId: count.id },
          );
        return A.receivePurchase(copy, po.id, {
          lines: [
            { purchaseLineId: po.lines[0].id, qty: 1, code: 'PO-COUNT', expiry: A.shift(100) },
          ],
        });
      }),
    ).toThrow(
      `Central warehouse is being counted (${count.number}). Post or cancel the count first.`,
    );
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('sells the same product from the branch while the main warehouse is being counted', () => {
    const { s, p, customer, early, late } = stocked();
    const branch = A.receiveStock(s, {
      productId: p.id,
      warehouseId: 'wh_branch',
      qty: 10,
      cost: 2,
      code: 'BRANCH',
      expiry: A.shift(150),
    });
    const count = A.startCount(s, { warehouseId: 'wh_main' });
    const snapshot = structuredClone(count);
    const opts = { customerId: customer.id, allowShortDated: false };
    expect(A.eligibleBatches(s, p.id, opts).map((b) => b.id)).toEqual([branch.id]);
    expect(A.sellableQty(s, p.id, opts)).toBe(10);
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 10 }],
    });
    A.issueInvoice(s, invoice.id);
    expect(invoice.status).toBe('Issued');
    expect(A.invoicePicks(s, invoice)).toMatchObject([{ batchId: branch.id, qty: 10 }]);
    expect(branch.qty).toBe(0);
    expect([early.qty, late.qty]).toEqual([10, 20]);
    expect(count).toEqual(snapshot);
    assertInvariants(s);

    const frozen = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 1 }],
    });
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, frozen.id))).toThrow(
      `Central warehouse is being counted (${count.number}). Post or cancel the count first.`,
    );
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('reports a shortage when even frozen stock cannot cover demand', () => {
    const { s, p, customer } = stocked();
    A.startCount(s, { warehouseId: 'wh_main' });
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      allowShortDated: true,
      lines: [{ productId: p.id, qty: 31 }],
    });
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, invoice.id))).toThrow(
      'Not enough sellable stock: Test product (need 31, available 0).',
    );
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('allows receipts, transfers, invoices, adjustments and purchase receipts in other warehouses', () => {
    const { s, p, customer, supplier } = stocked();
    A.startCount(s, { warehouseId: 'wh_main' });
    const other = A.saveProduct(s, { ...p, sku: 'OTHER-WH', name: 'Branch product' });
    const branch = A.receiveStock(s, {
      productId: other.id,
      qty: 20,
      cost: 2,
      code: 'BRANCH',
      expiry: A.shift(100),
      warehouseId: 'wh_branch',
    });
    A.transferStock(s, { batchId: branch.id, qty: 2, to: 'wh_cold' });
    A.adjustStock(s, { batchId: branch.id, qty: -1, reason: 'lost' });
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: other.id, qty: 1 }],
    });
    A.issueInvoice(s, invoice.id);
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_branch',
      date: A.today(),
      expected: A.shift(1),
      lines: [{ productId: other.id, qty: 2 }],
      send: true,
    });
    A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: po.lines[0].id, qty: 2, code: 'BRANCH-PO', expiry: A.shift(100) }],
    });
    expect(invoice.status).toBe('Issued');
    expect(branch.qty).toBe(16);
    assertInvariants(s);
  });

  it('adds only missing lots from the same warehouse and records, edits and clears safe non-negative counts', () => {
    const { s, late, early, p } = stocked();
    A.adjustStock(s, { batchId: early.id, qty: -early.qty, reason: 'lost' });
    const branch = A.receiveStock(s, {
      productId: p.id,
      qty: 1,
      cost: 2,
      code: 'BRANCH',
      expiry: A.shift(100),
      warehouseId: 'wh_branch',
    });
    const c = A.startCount(s, { warehouseId: 'wh_main' });
    A.addCountLine(s, c.id, early.id);
    expect(c.lines[1]).toMatchObject({ expected: 0, counted: null });
    expect(() => A.addCountLine(s, c.id, early.id)).toThrow('This lot is already in the count.');
    expect(() => A.addCountLine(s, c.id, branch.id)).toThrow(
      'Select a lot in the count warehouse.',
    );
    expect(() => A.recordCount(s, c.id, branch.id, 1)).toThrow('Count line not found.');
    A.recordCount(s, c.id, late.id, '12');
    expect(c.lines[0].counted).toBe(12);
    A.recordCount(s, c.id, late.id, 0);
    expect(c.lines[0].counted).toBe(0);
    A.recordCount(s, c.id, late.id, null);
    expect(c.lines[0].counted).toBeNull();
    for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'oops'])
      expect(() => A.recordCount(s, c.id, late.id, invalid)).toThrow(
        'Counted quantity must be a non-negative safe integer.',
      );
    A.recordCount(s, c.id, late.id, Number.MAX_SAFE_INTEGER);
    expect(c.lines[0].counted).toBe(Number.MAX_SAFE_INTEGER);
    A.recordCount(s, c.id, late.id, late.qty);
    A.recordCount(s, c.id, early.id, 1);
    A.postCount(s, c.id);
    expect(early.qty).toBe(1);
    for (const operation of [
      () => A.addCountLine(s, c.id, branch.id),
      () => A.recordCount(s, c.id, late.id, 1),
      () => A.postCount(s, c.id),
      () => A.cancelCount(s, c.id),
    ])
      expect(operation).toThrow('Stock count must be Open.');
    assertInvariants(s);
  });

  it('rejects incomplete posting without changing anything, then posts only differences with signed values and journals', () => {
    const { s, late, early, p } = stocked();
    const same = A.receiveStock(s, {
      productId: p.id,
      qty: 4,
      cost: 2,
      code: 'SAME',
      expiry: A.shift(100),
      warehouseId: 'wh_main',
    });
    const c = A.startCount(s, { warehouseId: 'wh_main' });
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.postCount(copy, c.id))).toThrow(
      '3 lines are not counted yet.',
    );
    expect(s).toEqual(before);
    A.recordCount(s, c.id, late.id, late.qty - 3);
    A.recordCount(s, c.id, early.id, early.qty + 1);
    A.recordCount(s, c.id, same.id, same.qty);
    const summary = A.postCount(s, c.id);
    expect(summary).toEqual({ lines: 3, differences: 2, value: -3 });
    expect(c).toMatchObject({ status: 'Posted', postedBy: CURRENT_USER });
    expect(c.postedAt).toBeTruthy();
    expect(s.adjustments).toHaveLength(2);
    expect(s.adjustments.map((a) => [a.qty, a.value, a.reason, a.note, a.sourceId])).toEqual([
      [1, 3, 'count', c.number, c.id],
      [-3, -6, 'count', c.number, c.id],
    ]);
    expect(s.journal[0].entries).toEqual([
      { account: 'inventory', debit: 3, credit: 0 },
      { account: 'loss', debit: 0, credit: 3 },
    ]);
    expect(s.journal[1].entries).toEqual([
      { account: 'loss', debit: 6, credit: 0 },
      { account: 'inventory', debit: 0, credit: 6 },
    ]);
    expect(s.movements[0]).toMatchObject({ type: 'count', title: 'Stock count posted' });
    expect(A.movesFor(s, { batchId: same.id })).toHaveLength(1);
    assertInvariants(s);
  });

  it('cancels without changing stock and lifts the freeze', () => {
    const { s, late } = stocked();
    const c = A.startCount(s, { warehouseId: 'wh_main' });
    A.recordCount(s, c.id, late.id, 0);
    const before = structuredClone({
      batches: s.batches,
      stockMoves: s.stockMoves,
      journal: s.journal,
      adjustments: s.adjustments,
    });
    A.cancelCount(s, c.id);
    expect(c.status).toBe('Canceled');
    expect({
      batches: s.batches,
      stockMoves: s.stockMoves,
      journal: s.journal,
      adjustments: s.adjustments,
    }).toEqual(before);
    expect(() => A.recordCount(s, c.id, late.id, 1)).toThrow('Stock count must be Open.');
    A.adjustStock(s, { batchId: late.id, qty: -1, reason: 'lost' });
    A.startCount(s, { warehouseId: 'wh_main' });
    assertInvariants(s);
  });

  it('seeds one posted branch count twenty days ago with -3 and +1, and migrates defaults idempotently', () => {
    const s = A.seed();
    expect(s.stockCounts).toHaveLength(1);
    const c = s.stockCounts[0];
    expect(c).toMatchObject({
      warehouseId: 'wh_branch',
      status: 'Posted',
      createdBy: CURRENT_USER,
      postedBy: CURRENT_USER,
    });
    expect(c.createdAt.slice(0, 10)).toBe(A.shift(-20));
    expect(c.postedAt!.slice(0, 10)).toBe(A.shift(-20));
    expect(
      c.lines.filter((l) => l.expected !== l.counted).map((l) => l.counted! - l.expected),
    ).toEqual([-3, 1]);
    expect(s.adjustments.filter((a) => a.sourceId === c.id).map((a) => a.date)).toEqual([
      A.shift(-20),
      A.shift(-20),
    ]);
    assertInvariants(s);
    const raw = legacyBackup(s, false, true);
    raw.version = 1;
    delete raw.stockMoves;
    delete raw.adjustments;
    delete raw.stockCounts;
    delete raw.counters.count;
    const migrated = A.validateBackup(raw);
    expect(migrated.stockCounts).toEqual([]);
    expect(migrated.counters.count).toBe(1);
    const before = structuredClone(migrated);
    expect(A.migrate(migrated)).toEqual(before);
    assertInvariants(migrated);
  });

  it('rejects invalid backups, cross-warehouse lots, multiple Open counts and uncounted Posted counts', () => {
    const { s, late } = stocked();
    const c = A.startCount(s, { warehouseId: 'wh_main' });
    for (const patch of [
      { counted: -1 },
      { counted: 1.5 },
      { counted: Number.MAX_SAFE_INTEGER + 1 },
      { expected: -1 },
      { batchId: 'missing' },
    ]) {
      const bad = structuredClone(s);
      Object.assign(bad.stockCounts[0].lines[0], patch);
      expect(() => A.validateBackup(bad)).toThrow();
    }
    const cross = structuredClone(s);
    cross.stockCounts[0].warehouseId = 'wh_branch';
    expect(() => A.validateBackup(cross)).toThrow(
      'Backup contains an invalid count line reference.',
    );
    const duplicate = structuredClone(s);
    duplicate.stockCounts.push({ ...structuredClone(c), id: 'count_other', number: 'SC-0002' });
    expect(() => A.validateBackup(duplicate)).toThrow(
      'Backup contains multiple Open counts for a warehouse.',
    );
    const posted = structuredClone(s);
    Object.assign(posted.stockCounts[0], {
      status: 'Posted',
      postedAt: new Date().toISOString(),
      postedBy: CURRENT_USER,
    });
    expect(() => A.validateBackup(posted)).toThrow(
      'Backup contains uncounted lines in a Posted count.',
    );
    const stale = structuredClone(s);
    stale.stockCounts[0].lines[0].expected = late.qty + 1;
    expect(() => A.validateBackup(stale)).toThrow('Backup stock changed during an Open count.');
    expect(() => A.validateBackup({ ...s, stockCounts: null })).toThrow(
      'Backup is missing stockCounts.',
    );
    assertInvariants(s);
  });
});
describe('migration and accounting', () => {
  it('accepts a complete sample backup with balanced stock, receivables, and payables', () => {
    const state = A.seed();
    assertInvariants(state);
    expect(A.validateBackup(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(A.balances(state).inventory.balance).toBe(A.inventoryValue(state));
  });
  it('allocates the earliest expiry first and posts the actual batch costs', () => {
    const { s, customer, p, early, late } = stocked();
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 15, price: 5 }],
    });
    A.issueInvoice(s, invoice.id);
    expect(A.invoicePicks(s, invoice).map((a) => [a.lotCode, a.qty])).toEqual([
      ['EARLY', 10],
      ['LATE', 5],
    ]);
    expect(early.qty).toBe(0);
    expect(late.qty).toBe(15);
    expect(A.invoiceCost(s, invoice)).toBe(40);
    expect(A.balances(s).receivable.balance).toBe(75);
    expect(A.balances(s).inventory.balance).toBe(30);
    expect(A.validateBackup(s)).toBe(s);
  });
  it('blocks quarantined and expired stock and rolls back duplicate-line demand failures', () => {
    const { s, customer, p, early } = stocked();
    A.setQuarantine(s, early.id, true);
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [
        { productId: p.id, qty: 15, price: 5 },
        { productId: p.id, qty: 15, price: 5 },
      ],
    });
    const before = structuredClone(s);
    expect(() => A.transact(s, (copy) => A.issueInvoice(copy, invoice.id))).toThrow(
      'Only 20 boxes of Test product have at least 0 days of shelf life (0 more are short-dated).',
    );
    expect(s).toEqual(before);
    early.quarantined = false;
    early.expiry = A.shift(-1);
    expect(A.available(s, p.id)).toBe(20);
  });
  it('records partial payments, rejects overpayment, and closes the receivable', () => {
    const { s, customer, p } = stocked();
    const invoice = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 2, price: 5 }],
    });
    A.issueInvoice(s, invoice.id);
    A.payInvoice(s, invoice.id, 4, 'Cash');
    expect(A.invoiceStatus(invoice)).toBe('Partial');
    expect(() => A.payInvoice(s, invoice.id, 7)).toThrow('outstanding amount');
    A.payInvoice(s, invoice.id, 6);
    expect(A.invoiceStatus(invoice)).toBe('Paid');
    expect(A.balances(s).receivable.balance).toBe(0);
    expect(A.validateBackup(s)).toBe(s);
  });
  it('transfers units while preserving inventory value and batch traceability', () => {
    const { s, early } = stocked();
    const value = A.inventoryValue(s);
    A.transferStock(s, { batchId: early.id, qty: 4, to: 'wh_branch' });
    const target = s.batches.find((b) => b.warehouseId === 'wh_branch')!;
    expect(target).toMatchObject({
      code: early.code,
      cost: early.cost,
      expiry: early.expiry,
      qty: 4,
      quarantined: false,
    });
    expect(early.qty).toBe(6);
    expect(A.inventoryValue(s)).toBe(value);
    expect(A.validateBackup(s)).toBe(s);
  });
  it('receives purchase orders once, creates a supplier bill, and pays it', () => {
    const { s, supplier, p } = stocked();
    const order = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_branch',
      date: A.today(),
      expected: A.shift(5),
      lines: [{ productId: p.id, qty: 3, cost: 2 }],
      send: true,
    });
    const receipt = A.receivePurchase(s, order.id, {
      lines: [
        { purchaseLineId: order.lines[0].id, qty: 3, code: 'ORDER-LOT', expiry: A.shift(365) },
      ],
    });
    expect(order.status).toBe('Received');
    expect(A.onHand(s, p.id, 'wh_branch')).toBe(3);
    expect(() =>
      A.receivePurchase(s, order.id, {
        lines: [
          { purchaseLineId: order.lines[0].id, qty: 3, code: 'ORDER-LOT', expiry: A.shift(365) },
        ],
      }),
    ).toThrow('Only sent purchase orders can be received.');
    A.payBill(s, receipt.id, 6);
    expect(receipt.paid).toBe(6);
    expect(A.validateBackup(s)).toBe(s);
  });
  it('records expenses and write-offs in the corresponding ledger accounts', () => {
    const { s, early } = stocked();
    A.addExpense(s, { amount: 12, date: A.today(), description: 'Delivery' });
    A.adjustStock(s, {
      batchId: early.id,
      qty: -early.qty,
      reason: 'damaged',
      note: 'Damaged packaging',
    });
    expect(early.qty).toBe(0);
    expect(A.balances(s).loss.balance).toBe(30);
    expect(A.balances(s).expense.balance).toBe(12);
    expect(A.validateBackup(s)).toBe(s);
  });
  it('rejects duplicate SKUs, invalid quantities, and unbalanced backups', () => {
    const { s, p } = stocked();
    expect(() => A.saveProduct(s, { ...p, sku: p.sku.toLowerCase() })).toThrow(
      'SKU already exists',
    );
    expect(() =>
      A.transferStock(s, { batchId: s.batches[0].id, qty: 1.5, to: 'wh_branch' }),
    ).toThrow('whole number');
    const bad = structuredClone(s);
    bad.journal[0].entries[0].debit += 1;
    expect(() => A.validateBackup(bad)).toThrow('unbalanced journal');
  });
  it('rejects changing the type of a contact with transaction history', () => {
    const { s, supplier } = stocked();
    expect(() => A.saveContact(s, { ...supplier, type: 'Customer' }, supplier.id)).toThrow(
      'transaction history',
    );
  });
});

describe('stock movement ledger', () => {
  it('seeds every stocked batch through stock moves', () => {
    const s = A.seed();
    s.batches
      .filter((b) => b.qty > 0)
      .forEach((b) => {
        expect(A.movesFor(s, { batchId: b.id }).length).toBeGreaterThan(0);
      });
    s.stockMoves.forEach((m) => expect(m.user).toBe(CURRENT_USER));
    s.stockMoves
      .filter((m) => m.type === 'opening')
      .forEach((m) => {
        expect(m.date).toBe(s.batches.find((b) => b.id === m.batchId)!.received);
      });
    assertInvariants(s);
  });

  it('records direct receipts with supplier, reference, and batch snapshots', () => {
    const { s, p, supplier } = stocked();
    const batch = A.receiveStock(s, {
      productId: p.id,
      warehouseId: 'wh_branch',
      qty: 7,
      cost: 2.004,
      expiry: A.shift(365),
      code: 'DIRECT',
      reference: 'DELIVERY-001',
      supplierId: supplier.id,
      payment: 'credit',
    });
    expect(s.stockMoves.at(-1)).toMatchObject({
      type: 'receipt',
      qty: 7,
      date: A.today(),
      reference: s.receipts[0].number,
      sourceId: s.receipts[0].id,
      counterpartyId: supplier.id,
      batchId: batch.id,
      productId: p.id,
      warehouseId: 'wh_branch',
      lotCode: 'DIRECT',
      unitCost: 2,
      user: CURRENT_USER,
    });
    expect(s.receipts[0].reference).toBe('DELIVERY-001');
    expect(s.stockMoves.at(-1)!.id).toMatch(/^sm_/);
    expect(new Date(s.stockMoves.at(-1)!.at).toISOString()).toBe(s.stockMoves.at(-1)!.at);
    // Receiving into the same lot appends a move and preserves the old one.
    const before = structuredClone(s.stockMoves);
    A.receiveStock(s, {
      productId: p.id,
      warehouseId: 'wh_branch',
      qty: 3,
      cost: 2,
      expiry: batch.expiry,
      code: 'DIRECT',
      payment: 'credit',
    });
    expect(s.stockMoves.slice(0, -1)).toEqual(before);
    expect(s.stockMoves.at(-1)).toMatchObject({
      reference: s.receipts[0].number,
      sourceId: s.receipts[0].id,
      counterpartyId: supplier.id,
      qty: 3,
    });
    expect(batch.qty).toBe(10);
    assertInvariants(s);
  });

  it('records purchase receipts with their business date, source, and supplier', () => {
    const { s, p, supplier } = stocked();
    const date = A.shift(-2);
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.shift(-3),
      expected: date,
      lines: [{ productId: p.id, qty: 4, cost: 2 }],
    });
    A.sendPurchase(s, po.id, date);
    const rc = A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: po.lines[0].id, qty: 4, code: 'PO-LOT', expiry: A.shift(365) }],
      date,
    });
    expect(s.stockMoves.at(-1)).toMatchObject({
      type: 'receipt',
      qty: 4,
      date,
      reference: rc.number,
      sourceId: rc.id,
      counterpartyId: supplier.id,
    });
    assertInvariants(s);
  });

  it('records sale moves exactly matching every invoice allocation', () => {
    const { s, p, customer } = stocked();
    const inv = A.createInvoice(s, {
      customerId: customer.id,
      date: A.shift(-1),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 15, price: 5 }],
    });
    A.issueInvoice(s, inv.id);
    const moves = A.movesFor(s, { type: 'sale' });
    expect(moves.map((m) => ({ batchId: m.batchId, qty: -m.qty }))).toEqual(
      A.invoicePicks(s, inv).map((a) => ({ batchId: a.batchId, qty: a.qty })),
    );
    moves.forEach((m) =>
      expect(m).toMatchObject({
        date: inv.date,
        reference: A.deliveriesOf(s, inv)[0].number,
        sourceId: inv.deliveryIds[0],
        counterpartyId: customer.id,
        user: CURRENT_USER,
      }),
    );
    assertInvariants(s);
  });

  it('pairs transfer moves and increments the transfer reference for existing targets', () => {
    const { s, early } = stocked();
    A.transferStock(s, { batchId: early.id, qty: 4, to: 'wh_branch' });
    const pair = s.stockMoves.slice(-2);
    expect(pair.map((m) => [m.type, m.qty])).toEqual([
      ['transfer_out', -4],
      ['transfer_in', 4],
    ]);
    expect(pair[0].reference).toBe('TR-0001');
    expect(pair[1].reference).toBe(pair[0].reference);
    expect(pair[0].sourceId).toBeTruthy();
    expect(pair[1].sourceId).toBe(pair[0].sourceId);
    expect(pair.reduce((n, m) => n + m.qty, 0)).toBe(0);
    A.transferStock(s, { batchId: early.id, qty: 2, to: 'wh_branch' });
    expect(s.stockMoves.at(-1)).toMatchObject({ reference: 'TR-0002', batchId: pair[1].batchId });
    expect(s.counters.transfer).toBe(3);
    assertInvariants(s);
  });

  it('shows zero before a receipt and the received quantity on its business date', () => {
    const { s, p, late, customer } = stocked();
    expect(A.stockAt(s, { date: A.shift(-1), productId: p.id })).toBe(0);
    expect(A.stockAt(s, { date: A.today(), productId: p.id })).toBe(30);
    expect(A.stockAt(s, { date: A.today(), batchId: late.id })).toBe(20);
    expect(A.stockAt(s, { date: A.today(), warehouseId: 'wh_branch' })).toBe(0);
    expect(
      A.movesFor(s, { lotCode: 'LATE', type: 'receipt', from: A.today(), to: A.today() }),
    ).toHaveLength(1);
    const inv = A.createInvoice(s, {
      customerId: customer.id,
      date: A.shift(-2),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 2, price: 5 }],
    });
    A.issueInvoice(s, inv.id);
    expect(A.stockAt(s, { date: A.shift(-1), productId: p.id })).toBe(-2);
    assertInvariants(s);
  });

  it('rejects negative balances and invalid signed quantities with atomic rollback', () => {
    const { s, early } = stocked();
    const meta = { type: 'adjustment' as const, date: A.today(), reference: 'TEST' };
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => {
        const batch = copy.batches.find((b) => b.id === early.id)!;
        A.moveStock(copy, batch, -1, meta);
        A.moveStock(copy, batch, -10, meta);
      }),
    ).toThrow('Not enough stock in lot EARLY (9 available).');
    expect(s).toEqual(before);
    for (const qty of [0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => A.moveStock(s, early, qty, meta)).toThrow(
        'Quantity must be a non-zero safe integer.',
      );
      expect(s).toEqual(before);
    }
    assertInvariants(s);
  });

  it('records a write-off with its reason and keeps the full lot history', () => {
    const { s, early } = stocked();
    const first = structuredClone(s.stockMoves);
    const adjustment = A.adjustStock(s, {
      batchId: early.id,
      qty: -early.qty,
      reason: 'damaged',
      note: 'Damaged packaging',
    });
    expect(s.stockMoves.slice(0, -1)).toEqual(first);
    expect(s.stockMoves.at(-1)).toMatchObject({
      type: 'adjustment',
      qty: -10,
      batchId: early.id,
      reference: adjustment.number,
      sourceId: adjustment.id,
      reason: 'damaged',
      user: CURRENT_USER,
    });
    expect(A.movesFor(s, { batchId: early.id })).toHaveLength(2);
    assertInvariants(s);
  });

  it('migrates v1 data and backups idempotently, excluding empty batches', () => {
    const seed = A.seed();
    const batch = seed.batches.find((b) => b.qty > 0)!;
    A.adjustStock(seed, {
      batchId: batch.id,
      qty: -batch.qty,
      reason: 'other',
      note: 'Migration test',
    });
    const raw = legacyBackup(seed, false, true);
    delete raw.stockMoves;
    delete raw.counters.transfer;
    delete raw.adjustments;
    delete raw.counters.adjustment;
    raw.version = 1;
    const backup = structuredClone(raw);
    const s = A.migrate(raw);
    expect(s.version).toBe(4);
    expect(s.counters.transfer).toBe(1);
    expect(s.stockMoves).toHaveLength(s.batches.filter((b) => b.qty > 0).length);
    expect(A.movesFor(s, { batchId: batch.id })).toEqual([]);
    s.stockMoves.forEach((m) =>
      expect(m).toMatchObject({
        type: 'opening',
        date: A.today(),
        reference: 'MIGRATION',
        user: 'system',
        qty: s.batches.find((b) => b.id === m.batchId)!.qty,
      }),
    );
    const before = structuredClone(s);
    expect(A.migrate(s)).toEqual(before);
    assertInvariants(A.validateBackup(backup));
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ ...backup, version: 1, stockMoves: undefined }),
    });
    try {
      const loaded = A.load();
      expect(loaded.createdAt).toBe(s.createdAt);
      expect(loaded.stockMoves.every((m) => m.reference === 'MIGRATION')).toBe(true);
      assertInvariants(loaded);
    } finally {
      vi.unstubAllGlobals();
    }
    assertInvariants(s);
  });

  it('rejects malformed moves and quantities that disagree with the ledger', () => {
    const { s } = stocked();
    for (const patch of [
      { qty: 0 },
      { qty: 0.5 },
      { date: 'invalid' },
      { date: '2026-02-30' },
      { batchId: 'unknown' },
      { productId: 'unknown' },
      { warehouseId: 'unknown' },
    ]) {
      const bad = structuredClone(s);
      Object.assign(bad.stockMoves[0], patch);
      expect(() => A.validateBackup(bad)).toThrow();
    }
    const bad = structuredClone(s);
    bad.stockMoves[0].qty += 1;
    expect(() => A.validateBackup(bad)).toThrow(
      'Backup batch quantities do not match the stock ledger.',
    );
    expect(() => A.validateBackup({ ...s, stockMoves: null })).toThrow(
      'Backup is missing stockMoves.',
    );
    assertInvariants(s);
  });

  it('guards all quantity assignments so only moveStock can write batch.qty', () => {
    const source = readFileSync('src/lib/model.ts', 'utf8');
    const file = ts.createSourceFile('model.ts', source, ts.ScriptTarget.Latest, true);
    const writes: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isBinaryExpression(node) &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === 'qty' &&
        [
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.PlusEqualsToken,
          ts.SyntaxKind.MinusEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        writes.push(owner && ts.isFunctionDeclaration(owner) ? owner.name?.text || '' : '');
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(writes).toEqual(['moveStock']);
    assertInvariants(A.seed());
  });
});

describe('units of measure', () => {
  function packaged(factor = 50) {
    const fixture = stocked();
    const p = A.saveProduct(
      fixture.s,
      {
        ...fixture.p,
        barcode: 'BASE-001',
        packs: [
          { unit: 'carton', factor, barcode: 'CARTON-001' },
          { unit: 'case', factor: factor * 2, barcode: 'CASE-001', price: 450 },
        ],
      },
      fixture.p.id,
    );
    return { ...fixture, p };
  }

  it('sells two cartons as 100 base units, earliest expiry first across two batches', () => {
    const { s, p, customer, early, late } = packaged();
    A.receiveStock(s, {
      productId: p.id,
      qty: 80,
      cost: late.cost,
      code: late.code,
      expiry: late.expiry,
      warehouseId: late.warehouseId,
      payment: 'credit',
    });
    const inv = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 2, unit: 'carton' }],
    });
    A.issueInvoice(s, inv.id);
    expect(inv.lines[0]).toMatchObject({ qty: 2, unit: 'carton', factor: 50, price: 250 });
    expect(inv.total).toBe(500);
    expect(A.invoicePicks(s, inv).map((a) => [a.batchId, a.qty])).toEqual([
      [early.id, 10],
      [late.id, 90],
    ]);
    expect(early.qty).toBe(0);
    expect(late.qty).toBe(10);
    expect(A.invoiceCost(s, inv)).toBe(210);
    assertInvariants(s);
  });

  it('receives three cartons at $58.50 with the exact inventory, payable, and rounding entries', () => {
    const { s, p, supplier } = packaged(20);
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_branch',
      date: A.today(),
      expected: A.today(),
      lines: [{ productId: p.id, qty: 3, unit: 'carton', cost: 58.5 }],
      send: true,
    });
    A.receivePurchase(s, po.id, {
      lines: [{ purchaseLineId: po.lines[0].id, qty: 3, code: 'ROUNDING', expiry: A.shift(365) }],
    });
    expect(s.batches.find((b) => b.code === 'ROUNDING')).toMatchObject({ qty: 60, cost: 2.93 });
    expect(po.total).toBe(175.5);
    expect(s.journal[0].description).toContain('Purchase rounding');
    expect(s.journal[0].entries).toEqual([
      { account: 'inventory', debit: 175.8, credit: 0 },
      { account: 'payable', debit: 0, credit: 175.5 },
      { account: 'loss', debit: 0, credit: 0.3 },
    ]);
    assertInvariants(s);
  });

  it('uses the same rounding for direct receipts and handles both debit and credit differences', () => {
    const { s, p } = packaged(20);
    for (const payment of ['credit', 'cash']) {
      A.receiveStock(s, {
        productId: p.id,
        unit: 'carton',
        qty: 3,
        cost: 58.5,
        code: 'DIRECT-' + payment,
        expiry: A.shift(365),
        warehouseId: 'wh_branch',
        payment,
      });
      expect(s.journal[0].entries).toEqual([
        { account: 'inventory', debit: 175.8, credit: 0 },
        { account: payment === 'credit' ? 'payable' : 'cash', debit: 0, credit: 175.5 },
        { account: 'loss', debit: 0, credit: 0.3 },
      ]);
      expect(s.receipts[0]).toMatchObject({ total: 175.5, paid: payment === 'cash' ? 175.5 : 0 });
    }
    A.receiveStock(s, {
      productId: p.id,
      unit: 'carton',
      qty: 3,
      cost: 58.48,
      code: 'ROUND-DOWN',
      expiry: A.shift(365),
      warehouseId: 'wh_branch',
      payment: 'credit',
    });
    expect(s.journal[0].entries).toEqual([
      { account: 'inventory', debit: 175.2, credit: 0 },
      { account: 'payable', debit: 0, credit: 175.44 },
      { account: 'loss', debit: 0.24, credit: 0 },
    ]);
    assertInvariants(s);
  });

  it.each([
    ['carton', 3, '3 cartons'],
    ['carton', 1, '1 carton'],
    ['box', 3, '3 boxes'],
    ['box', 1, '1 box'],
    [undefined, 3, '3 boxes'],
  ] as const)('describes receipts in the received unit (%s, %s)', (unit, qty, label) => {
    const { s, p } = packaged();
    A.receiveStock(s, {
      productId: p.id,
      warehouseId: 'wh_main',
      unit,
      qty,
      cost: 2,
      code: 'ACTIVITY-UNIT',
      expiry: A.shift(365),
    });
    expect(s.movements[0].description).toBe(`${label} · ${p.name} · Central warehouse`);
    assertInvariants(s);
  });

  it('locks the base unit after stock or documents exist, including zero-stock batches', () => {
    const { s, p, early, late, customer, supplier } = stocked();
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => A.saveProduct(copy, { ...p, unit: 'bottle' }, p.id)),
    ).toThrow("The base unit can't change after stock or documents exist.");
    expect(s).toEqual(before);
    A.adjustStock(s, { batchId: early.id, qty: -early.qty, reason: 'damaged' });
    A.adjustStock(s, { batchId: late.id, qty: -late.qty, reason: 'damaged' });
    expect(() => A.saveProduct(s, { ...p, unit: 'bottle' }, p.id)).toThrow(
      "The base unit can't change after stock or documents exist.",
    );
    const fresh = A.saveProduct(s, { ...p, sku: 'FRESH', name: 'Fresh product' });
    const changed = A.saveProduct(s, { ...fresh, unit: 'bottle' }, fresh.id);
    expect(changed.unit).toBe('bottle');
    A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: changed.id, qty: 1 }],
    });
    expect(() => A.saveProduct(s, { ...changed, unit: 'box' }, changed.id)).toThrow(
      "The base unit can't change after stock or documents exist.",
    );
    const ordered = A.saveProduct(s, { ...p, sku: 'ORDERED', name: 'Ordered product' });
    A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_main',
      date: A.today(),
      expected: A.today(),
      lines: [{ productId: ordered.id, qty: 1 }],
    });
    expect(() => A.saveProduct(s, { ...ordered, unit: 'bottle' }, ordered.id)).toThrow(
      "The base unit can't change after stock or documents exist.",
    );
    assertInvariants(s);
  });

  it('rejects duplicate base and pack barcodes across products and within a product', () => {
    const { s, p } = packaged();
    const before = structuredClone(s);
    expect(() =>
      A.saveProduct(s, { ...p, sku: 'OTHER', name: 'Other product', packs: [] }),
    ).toThrow('Barcode BASE-001 is already used by Test product (box).');
    expect(() =>
      A.saveProduct(s, {
        ...p,
        sku: 'OTHER',
        name: 'Other product',
        barcode: 'CARTON-001',
        packs: [],
      }),
    ).toThrow('Barcode CARTON-001 is already used by Test product (carton).');
    expect(() =>
      A.saveProduct(s, {
        ...p,
        sku: 'OTHER',
        name: 'Other product',
        barcode: '',
        packs: [{ unit: 'case', factor: 10, barcode: 'BASE-001' }],
      }),
    ).toThrow('Barcode BASE-001 is already used by Test product (box).');
    expect(() =>
      A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor: 50, barcode: p.barcode }] }, p.id),
    ).toThrow('Barcode BASE-001 is already used by Test product (box).');
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('looks up base and pack barcodes and formats the largest pack with a remainder', () => {
    const { s, p } = packaged();
    expect(A.findBarcode(s, 'BASE-001')).toEqual({ product: p, pack: null });
    expect(A.findBarcode(s, 'CARTON-001')).toEqual({ product: p, pack: p.packs[0] });
    expect(A.findBarcode(s, '')).toBeNull();
    expect(A.findBarcode(s, 'missing')).toBeNull();
    expect(A.formatQty(p, 1240)).toEqual({ main: '1,240 boxes', packs: '12 cases + 40 boxes' });
    const cartonOnly = { ...p, packs: [p.packs[0]] };
    expect(A.formatQty(cartonOnly, 1240)).toEqual({
      main: '1,240 boxes',
      packs: '24 cartons + 40 boxes',
    });
    expect(A.formatQty(cartonOnly, 50)).toEqual({ main: '50 boxes', packs: '1 carton' });
    expect(A.formatQty(p, 1)).toEqual({ main: '1 box' });
    expect(A.formatQty({ ...p, packs: [] }, 1240)).toEqual({ main: '1,240 boxes' });
    expect(A.formatQty(p, -5)).toEqual({ main: '-5 boxes' });
    assertInvariants(s);
  });

  it('preserves saved factors when packs are edited or removed and mixes document units', () => {
    const { s, p, customer, supplier } = packaged(10);
    const inv = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [
        { productId: p.id, qty: 2, unit: 'carton' },
        { productId: p.id, qty: 3 },
      ],
    });
    const po = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_branch',
      date: A.today(),
      expected: A.today(),
      lines: [
        { productId: p.id, qty: 2, unit: 'carton' },
        { productId: p.id, qty: 3 },
      ],
    });
    expect(inv.lines.map((l) => [l.unit, l.factor, l.price])).toEqual([
      ['carton', 10, 50],
      ['box', 1, 5],
    ]);
    expect(po.lines.map((l) => [l.unit, l.factor, l.price])).toEqual([
      ['carton', 10, 20],
      ['box', 1, 2],
    ]);
    expect(A.unitPrice(p, 'case')).toBe(450);
    expect(A.unitPrice(p, 'case', true)).toBe(40);
    const oldInvoice = structuredClone(inv.lines),
      oldPurchase = structuredClone(po.lines);
    A.saveProduct(s, { ...p, packs: [{ ...p.packs[0], factor: 20 }] }, p.id);
    A.saveProduct(s, { ...p, packs: [] }, p.id);
    expect(inv.lines).toEqual(oldInvoice);
    expect(po.lines).toEqual(oldPurchase);
    A.issueInvoice(s, inv.id);
    A.sendPurchase(s, po.id);
    A.receivePurchase(s, po.id, [
      { code: 'MIXED', expiry: A.shift(365) },
      { code: 'MIXED', expiry: A.shift(365) },
    ]);
    expect(A.invoicePicks(s, inv).reduce((n, a) => n + a.qty, 0)).toBe(23);
    expect(s.batches.find((b) => b.code === 'MIXED')).toMatchObject({ qty: 23, cost: 2 });
    assertInvariants(s);
  });

  it('validates pack factors, unique pack units, and unknown line units', () => {
    const { s, p, customer } = packaged();
    for (const factor of [1, 1.5, 10001, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        A.saveProduct(s, { ...p, packs: [{ unit: 'carton', factor, barcode: '' }] }, p.id),
      ).toThrow('Pack factor must be a whole number between 2 and 10,000.');
    }
    for (const packs of [
      [{ unit: 'box', factor: 10, barcode: '' }],
      [
        { unit: 'carton', factor: 10, barcode: '' },
        { unit: 'carton', factor: 20, barcode: '' },
      ],
    ] as PackInput[][])
      expect(() => A.saveProduct(s, { ...p, packs }, p.id)).toThrow();
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) =>
        A.createInvoice(copy, {
          customerId: customer.id,
          date: A.today(),
          due: A.shift(30),
          lines: [{ productId: p.id, qty: 1, unit: 'vial' }],
        }),
      ),
    ).toThrow('Select a valid unit for Test product.');
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('migrates legacy v1 packs and line factors, idempotently and with all invariants', () => {
    const s = A.seed();
    assertInvariants(s);
    const raw = legacyBackup(s, false, true);
    // A genuine v1 document represented every quantity and price in base units.
    for (const d of [...raw.invoices, ...raw.purchases])
      for (const line of d.lines) {
        line.qty *= line.factor;
        line.price = A.round(line.price / line.factor);
        line.unit = raw.products.find((p: { id: string }) => p.id === line.productId).unit;
        delete line.factor;
      }
    raw.products.forEach((p: { packs?: unknown }) => delete p.packs);
    delete raw.stockMoves;
    delete raw.counters.transfer;
    delete raw.adjustments;
    delete raw.counters.adjustment;
    raw.version = 1;
    delete raw.prices;
    const migrated = A.validateBackup(raw);
    expect(migrated.products.every((p) => p.packs.length === 0)).toBe(true);
    expect(
      [...migrated.invoices, ...migrated.purchases].every((d) =>
        d.lines.every((l) => l.factor === 1),
      ),
    ).toBe(true);
    const before = structuredClone(migrated);
    expect(A.migrate(migrated)).toEqual(before);
    assertInvariants(migrated);
  });

  it('validates pack barcodes and saved factors without requiring current pack definitions', () => {
    const { s, p, customer } = packaged(10);
    const inv = A.createInvoice(s, {
      customerId: customer.id,
      date: A.today(),
      due: A.shift(30),
      lines: [{ productId: p.id, qty: 2, unit: 'carton' }],
    });
    A.issueInvoice(s, inv.id);
    for (const factor of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const bad = structuredClone(s);
      bad.invoices[0].lines[0].factor = factor;
      expect(() => A.validateBackup(bad)).toThrow('Invalid invoice line unit or factor.');
    }
    const bad = structuredClone(s);
    bad.invoices[0].lines[0].factor = 11;
    expect(() => A.validateBackup(bad)).toThrow(
      'Invoice deliveries do not match its base quantities.',
    );
    const duplicate = structuredClone(s);
    duplicate.products[0].packs[0].barcode = duplicate.products[0].barcode;
    expect(() => A.validateBackup(duplicate)).toThrow('already used');
    A.saveProduct(s, { ...p, packs: [] }, p.id);
    assertInvariants(s);
  });
});

describe('stock adjustments', () => {
  function adjustable() {
    const fixture = stocked();
    const batch = A.receiveStock(fixture.s, {
      productId: fixture.p.id,
      warehouseId: 'wh_branch',
      qty: 20,
      cost: 3,
      expiry: A.shift(90),
      code: 'ADJUST-LOT',
      payment: 'credit',
    });
    return { ...fixture, batch };
  }

  it('removes 5 of 20 at $3 with a numbered adjustment, one move, and exact journal entries', () => {
    const { s, p, batch } = adjustable();
    const before = structuredClone(s.stockMoves);
    const a = A.adjustStock(s, {
      batchId: batch.id,
      qty: '-5',
      reason: 'damaged',
      note: '  Torn seals  ',
    });
    expect(batch.qty).toBe(15);
    expect(a.id).toMatch(/^adj_/);
    expect(a).toMatchObject({
      number: 'ADJ-0001',
      date: A.today(),
      batchId: batch.id,
      productId: p.id,
      warehouseId: 'wh_branch',
      lotCode: 'ADJUST-LOT',
      qty: -5,
      unitCost: 3,
      value: -15,
      reason: 'damaged',
      note: 'Torn seals',
      user: CURRENT_USER,
    });
    expect(s.adjustments).toEqual([a]);
    expect(s.counters.adjustment).toBe(2);
    expect(s.stockMoves.slice(0, -1)).toEqual(before);
    expect(s.stockMoves.filter((m) => m.sourceId === a.id)).toHaveLength(1);
    expect(s.stockMoves.at(-1)).toMatchObject({
      type: 'adjustment',
      qty: -5,
      sourceId: a.id,
      reference: a.number,
      reason: 'damaged',
      date: a.date,
    });
    expect(s.journal[0]).toMatchObject({
      reference: a.number,
      description: 'Stock adjustment — Damaged',
      entries: [
        { account: 'loss', debit: 15, credit: 0 },
        { account: 'inventory', debit: 0, credit: 15 },
      ],
    });
    expect(s.movements[0]).toMatchObject({
      type: 'adjust',
      title: 'Stock adjusted',
      description: '-5 boxes · Test product · ADJUST-LOT · damaged',
    });
    assertInvariants(s);
  });

  it('adds 2 found units with a trimmed note and credits loss', () => {
    const { s, batch } = adjustable();
    const a = A.adjustStock(s, {
      batchId: batch.id,
      qty: 2,
      reason: 'found',
      note: '  Recovered from the packing shelf.  ',
      date: A.shift(-1),
    });
    expect(batch.qty).toBe(22);
    expect(a).toMatchObject({
      qty: 2,
      value: 6,
      reason: 'found',
      note: 'Recovered from the packing shelf.',
      date: A.shift(-1),
    });
    expect(s.journal[0]).toMatchObject({
      date: a.date,
      reference: a.number,
      description: 'Stock adjustment — Found',
      entries: [
        { account: 'inventory', debit: 6, credit: 0 },
        { account: 'loss', debit: 0, credit: 6 },
      ],
    });
    expect(s.stockMoves.at(-1)).toMatchObject({ qty: 2, sourceId: a.id, date: a.date });
    expect(s.movements[0].description).toBe('+2 boxes · Test product · ADJUST-LOT · found');
    assertInvariants(s);
  });

  it('rolls back every effect when removing more than on hand', () => {
    const { s, batch } = adjustable();
    const before = structuredClone(s);
    expect(() =>
      A.transact(s, (copy) => A.adjustStock(copy, { batchId: batch.id, qty: -21, reason: 'lost' })),
    ).toThrow('Not enough stock in lot ADJUST-LOT (20 available).');
    expect(s).toEqual(before);
    expect(() =>
      A.transact(s, (copy) => {
        A.adjustStock(copy, { batchId: batch.id, qty: -5, reason: 'damaged' });
        A.adjustStock(copy, { batchId: batch.id, qty: -16, reason: 'lost' });
      }),
    ).toThrow('Not enough stock in lot ADJUST-LOT (15 available).');
    expect(s).toEqual(before);
    assertInvariants(s);
  });

  it('enforces reason directions, notes, and the stock-count-only entry point', () => {
    const { s, batch } = adjustable();
    const before = structuredClone(s);
    const cases: [Partial<AdjustmentInput>, string][] = [
      [
        { qty: -1, reason: 'found', note: 'Found stock' },
        '"found" can\'t be used to remove stock.',
      ],
      ...(['damaged', 'expired', 'lost', 'sample', 'recall'] as const).map(
        (reason): [Partial<AdjustmentInput>, string] => [
          { qty: 1, reason },
          `"${reason}" can't be used to add stock.`,
        ],
      ),
      [{ reason: 'count' }, 'Count differences are posted from a stock count.'],
      [{ reason: 'other' }, 'Enter a note for this adjustment.'],
      [{ qty: 1, reason: 'found', note: '   ' }, 'Enter a note for this adjustment.'],
    ];
    for (const [patch, message] of cases) {
      expect(() =>
        A.transact(s, (copy) =>
          A.adjustStock(copy, { batchId: batch.id, qty: -1, reason: 'damaged', ...patch }),
        ),
      ).toThrow(message);
      expect(s).toEqual(before);
      assertInvariants(s);
    }
    expect(A.adjustmentReasonsFor(1)).toEqual(['found', 'other']);
    expect(A.adjustmentReasonsFor(-1)).not.toContain('found');
    expect(A.adjustmentReasonsFor(-1)).not.toContain('count');
    assertInvariants(s);
  });

  it('writes off all units at full value and allows found stock on the emptied batch', () => {
    const { s, batch } = adjustable();
    batch.expiry = A.shift(-1);
    const a = A.adjustStock(s, { batchId: batch.id, qty: -batch.qty, reason: 'expired' });
    expect(batch.qty).toBe(0);
    expect(a).toMatchObject({ qty: -20, value: -60, reason: 'expired' });
    expect(s.journal[0]).toMatchObject({
      description: 'Stock adjustment — Expired',
      entries: [
        { account: 'loss', debit: 60, credit: 0 },
        { account: 'inventory', debit: 0, credit: 60 },
      ],
    });
    assertInvariants(s);
    const found = A.adjustStock(s, {
      batchId: batch.id,
      qty: 2,
      reason: 'found',
      note: 'Recovered intact stock.',
    });
    expect(batch.qty).toBe(2);
    expect(found.number).toBe('ADJ-0002');
    expect(s.adjustments).toEqual([found, a]);
    assertInvariants(s);
  });

  it('accepts count adjustments with a source and other adjustments in either direction', () => {
    const { s, batch } = adjustable();
    const a = A.adjustStock(
      s,
      { batchId: batch.id, qty: -2, reason: 'count' },
      { sourceId: 'count-test' },
    );
    expect(a.sourceId).toBe('count-test');
    expect(s.stockMoves.at(-1)!.sourceId).toBe(a.id);
    expect(s.journal[0].description).toBe('Stock adjustment — Count difference');
    assertInvariants(s);
    A.adjustStock(s, { batchId: batch.id, qty: 2, reason: 'count' }, { sourceId: 'count-test' });
    assertInvariants(s);
    for (const qty of [-2, 2]) {
      A.adjustStock(s, { batchId: batch.id, qty, reason: 'other', note: 'Approved correction.' });
      assertInvariants(s);
    }
    expect(batch.qty).toBe(20);
    assertInvariants(s);
  });

  it('rejects invalid quantities, missing batches, unknown reasons, and invalid dates atomically', () => {
    const { s, batch } = adjustable();
    const before = structuredClone(s);
    const cases: Partial<AdjustmentInput>[] = [
      ...[0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', 'invalid'].map((qty) => ({
        qty,
      })),
      { batchId: 'missing' },
      { reason: 'invalid' as AdjustmentInput['reason'] },
      { date: '2026-02-30' },
      { date: A.shift(1) },
    ];
    for (const patch of cases) {
      expect(() =>
        A.transact(s, (copy) =>
          A.adjustStock(copy, { batchId: batch.id, qty: -1, reason: 'damaged', ...patch }),
        ),
      ).toThrow();
      expect(s).toEqual(before);
      assertInvariants(s);
    }
    assertInvariants(s);
  });

  it('seeds the requested six adjustments over 60 days and migrates missing fields idempotently', () => {
    const s = A.seed();
    assertInvariants(s);
    expect(
      s.adjustments.filter((a) => !['count', 'other', 'recall'].includes(a.reason)),
    ).toHaveLength(7);
    expect(s.adjustments.some((a) => a.reason === 'recall')).toBe(true);
    expect(s.adjustments.filter((a) => a.reason === 'damaged')).toHaveLength(3);
    for (const reason of ['lost', 'found', 'sample', 'expired'])
      expect(s.adjustments.filter((a) => a.reason === reason)).toHaveLength(1);
    s.adjustments.forEach((a) => {
      expect(a.date >= A.shift(-60) && a.date <= A.today()).toBe(true);
      expect(a.user).toBe(CURRENT_USER);
    });
    expect(s.adjustments.find((a) => a.reason === 'found')!.note.trim()).not.toBe('');
    const expired = s.batches.find((b) => b.code === 'BT-OLD-009')!;
    expect(expired.qty).toBe(0);
    expect(s.adjustments.find((a) => a.batchId === expired.id)).toMatchObject({
      reason: 'expired',
      qty: -26,
      value: -54.6,
    });
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.adjustments;
    delete raw.counters.adjustment;
    const migrated = A.validateBackup(raw);
    expect(migrated.adjustments).toEqual([]);
    expect(migrated.counters.adjustment).toBe(1);
    const before = structuredClone(migrated);
    expect(A.migrate(migrated)).toEqual(before);
    assertInvariants(migrated);
    const seeded = structuredClone(s);
    expect(A.migrate(s)).toEqual(seeded);
    assertInvariants(s);
  });

  it('rejects malformed adjustments and missing or duplicate matching stock moves', () => {
    const { s, batch } = adjustable();
    const a = A.adjustStock(s, { batchId: batch.id, qty: -5, reason: 'damaged' });
    for (const patch of [
      { qty: 0 },
      { qty: 0.5 },
      { value: -14 },
      { reason: 'invalid' },
      { reason: 'count', sourceId: '   ' },
      { sourceId: 42 },
      { batchId: 'unknown' },
      { productId: 'unknown' },
      { warehouseId: 'unknown' },
    ]) {
      const bad = structuredClone(s);
      Object.assign(bad.adjustments[0], patch);
      expect(() => A.validateBackup(bad)).toThrow();
      assertInvariants(s);
    }
    const missing = structuredClone(s);
    missing.stockMoves.find((m) => m.sourceId === a.id)!.sourceId = 'missing';
    expect(() => A.validateBackup(missing)).toThrow(
      'Backup adjustment does not match its stock move.',
    );
    const duplicate = structuredClone(s),
      move = duplicate.stockMoves.find((m) => m.sourceId === a.id)!;
    move.qty = -2;
    duplicate.stockMoves.push({ ...move, id: 'duplicate-move', qty: -3 });
    expect(() => A.validateBackup(duplicate)).toThrow(
      'Backup adjustment does not match its stock move.',
    );
    expect(() => A.validateBackup({ ...s, adjustments: null })).toThrow(
      'Backup is missing adjustments.',
    );
    assertInvariants(s);
  });
});

describe('customer payments and credit', () => {
  function setup() {
    const data = stocked();
    const invoice = (amount = 5, date = A.today(), due = A.shift(30)) => {
      const i = A.createInvoice(data.s, {
        customerId: data.customer.id,
        date,
        due,
        lines: [{ productId: data.p.id, qty: 1, price: amount }],
      });
      A.issueInvoice(data.s, i.id, { reason: 'Test customer collection approved' });
      return i;
    };
    return { ...data, invoice };
  }
  it('auto allocates by oldest due date and leaves the excess as credit', () => {
    const { s, customer, invoice } = setup();
    const newest = invoice(5, A.today(), A.shift(20));
    const oldest = invoice(7, A.today(), A.shift(2));
    const middle = invoice(6, A.today(), A.shift(10));
    const p = A.recordPayment(s, {
      customerId: customer.id,
      date: A.today(),
      amount: 20,
      method: 'Bank transfer',
      reference: 'BANK-42',
      note: 'Combined remittance',
    });
    expect(p.allocations.map((a) => [a.invoiceId, a.amount, a.date])).toEqual([
      [oldest.id, 7, A.today()],
      [middle.id, 6, A.today()],
      [newest.id, 5, A.today()],
    ]);
    expect(A.paymentCredit(p)).toBe(2);
    expect(A.customerCredit(s, customer.id)).toBe(2);
    expect(s.journal[0]).toMatchObject({
      reference: p.number,
      description: 'Customer payment \u2014 Bank transfer',
      entries: [
        { account: 'cash', debit: 20, credit: 0 },
        { account: 'receivable', debit: 0, credit: 20 },
      ],
    });
    assertInvariants(s);
  });
  it('rejects explicit allocations above a balance or above the payment and rolls back', () => {
    const { s, customer, invoice } = setup();
    const a = invoice(),
      b = invoice();
    for (const allocations of [
      [{ invoiceId: a.id, amount: 6 }],
      [
        { invoiceId: a.id, amount: 3 },
        { invoiceId: b.id, amount: 3 },
      ],
      [
        { invoiceId: a.id, amount: 2 },
        { invoiceId: a.id, amount: 2 },
      ],
    ]) {
      const before = structuredClone(s);
      expect(() =>
        A.transact(s, (copy) =>
          A.recordPayment(copy, {
            customerId: customer.id,
            date: A.today(),
            amount: 5,
            method: 'Cash',
            allocations,
          }),
        ),
      ).toThrow();
      expect(s).toEqual(before);
    }
    assertInvariants(s);
  });
  it('turns a deposit without invoices into credit and automatically pays a direct invoice', () => {
    const { s, customer, invoice } = setup();
    const p = A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-2),
      amount: 8,
      method: 'Cash',
    });
    expect(p.allocations).toEqual([]);
    expect(A.customerCredit(s, customer.id)).toBe(8);
    const i = invoice(5);
    expect(i.paid).toBe(5);
    expect(A.invoiceStatus(i)).toBe('Paid');
    expect(p.allocations).toEqual([{ invoiceId: i.id, amount: 5, date: A.today() }]);
    expect(A.customerCredit(s, customer.id)).toBe(3);
    assertInvariants(s);
  });
  it('automatically applies deposits and credit notes when issuing from deliveries', () => {
    const { s, customer, invoice } = setup();
    const origin = invoice(8);
    A.payInvoice(s, origin.id, 8);
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: origin.id,
        kind: 'correction',
        reason: 'price_error',
        settlement: 'credit',
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 3 }],
      }).id,
    );
    const p = A.recordPayment(s, {
      customerId: customer.id,
      date: A.today(),
      amount: 2,
      method: 'Cash',
      allocations: [],
    });
    const target = invoice(5);
    expect(target.paid).toBe(2);
    expect(target.credited).toBe(3);
    // The direct path consumed both sources; move them back and exercise the other issue path.
    A.removeAllocation(s, { source: 'credit_note', id: cn.id, invoiceId: target.id });
    A.removeAllocation(s, { source: 'payment', id: p.id, invoiceId: target.id });
    const delivery = A.deliveriesOf(s, target)[0];
    // A fresh delivery from an order is invoiced via the 005 path.
    const order = A.saveOrder(s, {
      customerId: customer.id,
      date: A.today(),
      requestedDate: A.today(),
      fulfilment: 'pickup',
      lines: [{ productId: target.lines[0].productId, qty: 1, price: 5 }],
    });
    A.confirmOrder(s, order.id);
    const d = A.createDelivery(s, {
      orderId: order.id,
      warehouseId: delivery.lines[0].picks[0].warehouseId,
    });
    A.dispatchDelivery(s, d.id, { receivedBy: 'Customer' });
    const i = A.createInvoiceFromDeliveries(s, { deliveryIds: [d.id] });
    A.issueInvoice(s, i.id);
    expect(i.paid).toBe(2);
    expect(i.credited).toBe(3);
    expect(A.invoiceBalance(i)).toBe(0);
    assertInvariants(s);
  });
  it('applies sources oldest first by date and number, using paid and credited with no journal entry', () => {
    const { s, customer, invoice } = setup();
    const origin = invoice(10, A.shift(-7));
    A.payInvoice(s, origin.id, 10, 'Cash', A.shift(-6));
    const target = invoice(10);
    const first = A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-5),
      amount: 3,
      method: 'Cash',
      allocations: [],
    });
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: origin.id,
        date: A.shift(-4),
        kind: 'correction',
        reason: 'price_error',
        settlement: 'credit',
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 4 }],
      }).id,
    );
    const last = A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-3),
      amount: 6,
      method: 'Cash',
      allocations: [],
    });
    const journal = structuredClone(s.journal);
    A.applyCredit(s, { customerId: customer.id, invoiceId: target.id });
    expect(first.allocations[0].amount).toBe(3);
    expect(cn.allocations[0].amount).toBe(4);
    expect(last.allocations[0].amount).toBe(3);
    expect(target.paid).toBe(6);
    expect(target.credited).toBe(4);
    expect(A.customerCredit(s, customer.id)).toBe(3);
    expect(s.journal).toEqual(journal);
    assertInvariants(s);
  });
  it('orders sources on the same date by document number', () => {
    const { s, customer, invoice } = setup();
    const target = invoice(5);
    const first = A.recordPayment(s, {
      customerId: customer.id,
      amount: 3,
      method: 'Cash',
      date: A.today(),
      allocations: [],
    });
    const second = A.recordPayment(s, {
      customerId: customer.id,
      amount: 3,
      method: 'Cash',
      date: A.today(),
      allocations: [],
    });
    expect(s.payments[0].id).toBe(second.id);
    A.applyCredit(s, { customerId: customer.id, invoiceId: target.id, amount: 4 });
    expect(first.allocations[0].amount).toBe(3);
    expect(second.allocations[0].amount).toBe(1);
    assertInvariants(s);
  });
  it('returns removed payment and credit note allocations to available credit without a journal entry', () => {
    const { s, customer, invoice } = setup();
    const i = invoice(10);
    const p = A.payInvoice(s, i.id, 5);
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: i.id,
        kind: 'correction',
        reason: 'price_error',
        settlement: 'credit',
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 3 }],
      }).id,
    );
    const journal = structuredClone(s.journal);
    A.removeAllocation(s, { source: 'payment', id: p.id, invoiceId: i.id });
    A.removeAllocation(s, { source: 'credit_note', id: cn.id, invoiceId: i.id });
    expect(i.paid).toBe(0);
    expect(i.credited).toBe(0);
    expect(A.customerCredit(s, customer.id)).toBe(8);
    expect(s.journal).toEqual(journal);
    assertInvariants(s);
  });
  it('rejects excessive refunds and refunds oldest sources with matching caches and cash postings', () => {
    const { s, customer, invoice } = setup();
    const origin = invoice(5, A.shift(-6));
    A.payInvoice(s, origin.id, 5, 'Cash', A.shift(-5));
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: origin.id,
        date: A.shift(-4),
        kind: 'correction',
        reason: 'price_error',
        settlement: 'credit',
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 3 }],
      }).id,
    );
    const p = A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-3),
      amount: 5,
      method: 'Cash',
      allocations: [],
    });
    expect(() =>
      A.refundCredit(s, { customerId: customer.id, amount: 9, method: 'Cash', date: A.today() }),
    ).toThrow('available credit');
    const before = A.balances(s);
    const refund = A.refundCredit(s, {
      customerId: customer.id,
      amount: 6,
      method: 'Cash',
      date: A.today(),
    });
    expect(refund.from).toEqual([
      { kind: 'credit_note', id: cn.id, amount: 3 },
      { kind: 'payment', id: p.id, amount: 3 },
    ]);
    expect(cn.refunded).toBe(3);
    expect(p.refunded).toBe(3);
    expect(A.customerCredit(s, customer.id)).toBe(2);
    expect(A.balances(s).cash.balance).toBe(A.round(before.cash.balance - 6));
    expect(A.balances(s).receivable.balance).toBe(A.round(before.receivable.balance + 6));
    expect(s.journal[0].description).toBe('Refund \u2014 Cash');
    assertInvariants(s);
  });
  it('refunds at credit note issue only from that note, preserving older payment credit', () => {
    const { s, customer, invoice } = setup();
    const i = invoice(5);
    A.payInvoice(s, i.id, 5);
    const p = A.recordPayment(s, {
      customerId: customer.id,
      date: A.shift(-1),
      amount: 10,
      method: 'Cash',
      allocations: [],
    });
    const cn = A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: i.id,
        kind: 'correction',
        reason: 'price_error',
        settlement: 'refund',
        refundMethod: 'Cash',
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 2 }],
      }).id,
    );
    expect(s.refunds[0].from).toEqual([{ kind: 'credit_note', id: cn.id, amount: 2 }]);
    expect(p.refunded).toBe(0);
    expect(A.paymentCredit(p)).toBe(10);
    assertInvariants(s);
  });
  it('voids a bounced cheque, reopens all invoices and reverses the full cash entry', () => {
    const { s, customer, invoice } = setup();
    const a = invoice(),
      b = invoice();
    const before = A.balances(s);
    const p = A.recordPayment(s, {
      customerId: customer.id,
      amount: 12,
      method: 'Cheque',
      date: A.shift(-2),
    });
    expect(() => A.voidPayment(s, p.id, '')).toThrow('reason');
    expect(() => A.voidPayment(s, p.id, 'Bounced', A.shift(-3))).toThrow('Void date');
    expect(() => A.voidPayment(s, p.id, 'Bounced', A.shift(1))).toThrow('Void date');
    A.voidPayment(s, p.id, 'Cheque returned unpaid', A.shift(-1));
    expect(p).toMatchObject({
      status: 'Voided',
      voidDate: A.shift(-1),
      allocations: [],
      refunded: 0,
    });
    expect(a.paid).toBe(0);
    expect(b.paid).toBe(0);
    expect(A.customerCredit(s, customer.id)).toBe(0);
    expect(Object.values(A.balances(s)).map((a) => a.balance)).toEqual(
      Object.values(before).map((a) => a.balance),
    );
    expect(s.journal[0].description).toBe('Payment voided \u2014 Cheque returned unpaid');
    expect(() => A.voidPayment(s, p.id, 'Again')).toThrow('posted');
    assertInvariants(s);
  });
  it('refuses to void a payment after a refund', () => {
    const { s, customer } = setup();
    const p = A.recordPayment(s, {
      customerId: customer.id,
      date: A.today(),
      amount: 10,
      method: 'Cash',
    });
    A.refundCredit(s, { customerId: customer.id, amount: 1, method: 'Cash', date: A.today() });
    expect(() => A.voidPayment(s, p.id, 'Mistake')).toThrow('refunds');
    assertInvariants(s);
  });
  it('keeps payInvoice compatible as one explicit allocation', () => {
    const { s, invoice } = setup();
    const a = invoice(),
      b = invoice();
    const p = A.payInvoice(s, b.id, 3, 'Cash');
    expect(a.paid).toBe(0);
    expect(b.paid).toBe(3);
    expect(p.allocations).toEqual([{ invoiceId: b.id, amount: 3, date: A.today() }]);
    expect(() => A.payInvoice(s, b.id, 3)).toThrow('outstanding amount');
    assertInvariants(s);
  });
  it('subtracts payment and credit note credit from exposure', () => {
    const { s, customer, invoice } = setup();
    const i = invoice(5);
    A.payInvoice(s, i.id, 5);
    A.issueCreditNote(
      s,
      A.saveCreditNote(s, {
        invoiceId: i.id,
        kind: 'correction',
        reason: 'price_error',
        settlement: 'credit',
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 2 }],
      }).id,
    );
    A.recordPayment(s, {
      customerId: customer.id,
      date: A.today(),
      amount: 3,
      method: 'Cash',
      allocations: [],
    });
    expect(A.creditCheck(s, customer.id, 10).exposure).toBe(5);
    assertInvariants(s);
  });
  it('rejects malformed payment and refund backups and cache mismatches', () => {
    const { s, customer, invoice } = setup();
    const i = invoice();
    A.recordPayment(s, { customerId: customer.id, amount: 10, method: 'Cash', date: A.today() });
    A.refundCredit(s, { customerId: customer.id, amount: 2, method: 'Cash', date: A.today() });
    const corruptions: ((copy: Workspace) => void)[] = [
      (c) => {
        c.payments[0].amount = 1;
      },
      (c) => {
        c.payments[0].allocations[0].date = 'bad';
      },
      (c) => {
        c.payments[0].allocations[0].invoiceId = 'missing';
      },
      (c) => {
        c.payments[0].refunded = 0;
      },
      (c) => {
        c.payments[0].status = 'Voided';
      },
      (c) => {
        c.payments[0].voidDate = A.today();
      },
      (c) => {
        c.refunds[0].from[0].amount = 1;
      },
      (c) => {
        c.refunds[0].from[0].id = 'missing';
      },
      (c) => {
        c.invoices.find((a) => a.id === i.id)!.paid = 0;
      },
      (c) => {
        c.counters.payment = 1;
      },
      (c) => {
        c.journal.shift();
      },
    ];
    corruptions.forEach((change) => {
      const copy = structuredClone(s);
      change(copy);
      expect(() => A.validateBackup(copy)).toThrow();
    });
    assertInvariants(s);
  });
  it('seeds a three-invoice remittance, prepaid Lotus order, void cheque, and applied/refunded correction', () => {
    const s = A.seed();
    expect(
      s.payments.some(
        (p) => p.customerId === 'c1' && p.allocations.length === 3 && p.method === 'Bank transfer',
      ),
    ).toBe(true);
    const deposit = s.payments.find((p) => p.reference === 'Lotus pickup deposit')!;
    expect(deposit.customerId).toBe('c4');
    expect(deposit.allocations).toHaveLength(1);
    expect(A.paymentCredit(deposit)).toBe(0);
    expect(
      s.payments.some(
        (p) =>
          p.customerId === 'c2' &&
          p.status === 'Voided' &&
          p.voidReason === 'Cheque returned unpaid' &&
          p.voidDate === A.today(),
      ),
    ).toBe(true);
    expect(
      s.creditNotes.some(
        (cn) => cn.kind === 'correction' && cn.allocations.length > 0 && cn.refunded > 0,
      ),
    ).toBe(true);
    assertInvariants(s);
  });

  it('round-trips the seed through v3 back to v4 with all balances, batches, and journal unchanged', () => {
    const seed = A.seed();
    // Turn the seed back into v3 shape:
    const v3: any = JSON.parse(JSON.stringify(seed));
    v3.version = 3;
    delete v3.counters.receipt;
    // Put paid back on received POs from their receipts, remove closeReason, strip id/closedQty from lines
    for (const po of v3.purchases) {
      if (po.status === 'Received') {
        const receipt = seed.receipts.find((r) => r.purchaseId === po.id);
        po.paid = receipt ? receipt.paid : 0;
        if (receipt) {
          po.total = receipt.total;
          po.lines = receipt.lines.map((l) => ({
            productId: l.productId,
            name: l.name,
            sku: l.sku,
            unit: l.unit,
            factor: l.factor,
            qty: l.qty,
            price: l.price,
          }));
        }
      } else {
        po.paid = 0;
      }
      delete po.closeReason;
      for (const line of po.lines) {
        delete line.id;
        delete line.closedQty;
      }
    }
    // Drop the receipts that came from Received POs (their bills are in po.paid in v3),
    // and keep direct receipts or partial receipts as v3 receipts.
    v3.receipts = seed.receipts
      .filter(
        (r) =>
          !r.purchaseId ||
          !v3.purchases.some((p: any) => p.id === r.purchaseId && p.status === 'Received'),
      )
      .map((r) => ({
        id: r.id,
        date: r.date,
        reference: r.reference,
        supplierId: r.supplierId,
        total: r.total,
        paid: r.paid,
        warehouseId: r.warehouseId,
      }));

    const migrated = A.migrate(v3);

    // Prove that the payable balance is unchanged
    expect(A.balances(migrated).payable.balance).toBe(A.balances(seed).payable.balance);

    // Prove every supplier's open-bill total is unchanged
    for (const supp of seed.contacts.filter((c) => c.type === 'Supplier')) {
      const seedBillsTotal = A.sum(A.openBills(seed, supp.id), A.billBalance);
      const migratedBillsTotal = A.sum(A.openBills(migrated, supp.id), A.billBalance);
      expect(migratedBillsTotal).toBe(seedBillsTotal);
    }

    // Prove inventoryValue is unchanged
    expect(A.inventoryValue(migrated)).toBe(A.inventoryValue(seed));

    // Prove every batch qty is unchanged
    expect(migrated.batches.map((b) => [b.id, b.qty])).toEqual(
      seed.batches.map((b) => [b.id, b.qty]),
    );

    // Prove the journal is unchanged (no journal entries added in migration)
    expect(migrated.journal).toEqual(v3.journal);
    expect(migrated.journal).toEqual(seed.journal);

    // Prove invariants hold
    assertInvariants(migrated);
  });
});
