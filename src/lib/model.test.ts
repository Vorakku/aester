import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { A, CURRENT_USER } from './model';
import type { AdjustmentInput, PackInput, Workspace } from '../types';

function assertInvariants(s: Workspace) {
  s.batches.forEach((b) => {
    expect(b.qty).toBe(A.movesFor(s, { batchId: b.id }).reduce((n, m) => n + m.qty, 0));
    expect(Number.isInteger(b.qty) && b.qty >= 0).toBe(true);
  });
  expect(A.balances(s).inventory.balance).toBe(A.inventoryValue(s));
  s.journal.forEach((j) => {
    expect(A.sum(j.entries, (e) => e.debit)).toBe(A.sum(j.entries, (e) => e.credit));
  });
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
    const draft = s.invoices.find((i) => i.status === 'Draft')!;
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
    expect(regular.allocations.map((a) => a.batchId)).toEqual([long.id]);
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
    expect(consent.allocations.map((a) => [a.batchId, a.qty])).toEqual([
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
        date: sale.date,
        qty: 3,
      },
    ]);
    expect(trace.totals).toEqual({ received: 10, sold: 3, adjusted: 0, onHand: 7 });
    assertInvariants(s);
    trace.onHand.forEach((b) =>
      A.adjustStock(s, { batchId: b.batchId, qty: -b.qty, reason: 'recall' }),
    );
    const totals = A.recallTrace(s, recall.id).totals;
    expect(totals).toEqual({ received: 10, sold: 3, adjusted: -7, onHand: 0 });
    expect(totals.received - totals.sold + totals.adjusted).toBe(totals.onHand);
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
      expect(t.received - t.sold + t.adjusted).toBe(t.onHand);
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
    });
    expect(() =>
      A.transact(s, (copy) =>
        A.receivePurchase(copy, po.id, [{ code: 'COLD-PO', expiry: A.shift(100) }]),
      ),
    ).toThrow('Cold medicine must be stored at 2–8°C. Choose a cold-storage warehouse.');
    const coldPo = A.createPurchase(s, {
      supplierId: supplier.id,
      warehouseId: 'wh_cold',
      date: A.today(),
      expected: A.shift(1),
      lines: [{ productId: cold.id, qty: 2 }],
    });
    A.receivePurchase(s, coldPo.id, [{ code: 'COLD-PO', expiry: A.shift(100) }]);
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
        return A.receivePurchase(copy, po.id, [{ code: 'PO-COUNT', expiry: A.shift(100) }]);
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
    expect(invoice.allocations).toMatchObject([{ batchId: branch.id, qty: 10 }]);
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
    });
    A.receivePurchase(s, po.id, [{ code: 'BRANCH-PO', expiry: A.shift(100) }]);
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
    const raw = JSON.parse(JSON.stringify(s));
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
    expect(invoice.allocations.map((a) => [a.code, a.qty])).toEqual([
      ['EARLY', 10],
      ['LATE', 5],
    ]);
    expect(early.qty).toBe(0);
    expect(late.qty).toBe(15);
    expect(invoice.cogs).toBe(40);
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
    });
    A.receivePurchase(s, order.id, [{ code: 'ORDER-LOT', expiry: A.shift(365) }]);
    expect(order.status).toBe('Received');
    expect(A.onHand(s, p.id, 'wh_branch')).toBe(3);
    expect(() =>
      A.receivePurchase(s, order.id, [{ code: 'ORDER-LOT', expiry: A.shift(365) }]),
    ).toThrow('already received');
    A.payBill(s, order.id, 6);
    expect(order.paid).toBe(6);
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
      reference: 'DELIVERY-001',
      counterpartyId: supplier.id,
      batchId: batch.id,
      productId: p.id,
      warehouseId: 'wh_branch',
      lotCode: 'DIRECT',
      unitCost: 2,
      user: CURRENT_USER,
    });
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
      reference: 'DIRECT',
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
    A.receivePurchase(s, po.id, [{ code: 'PO-LOT', expiry: A.shift(365) }], date);
    expect(s.stockMoves.at(-1)).toMatchObject({
      type: 'receipt',
      qty: 4,
      date,
      reference: po.number,
      sourceId: po.id,
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
      inv.allocations.map((a) => ({ batchId: a.batchId, qty: a.qty })),
    );
    moves.forEach((m) =>
      expect(m).toMatchObject({
        date: inv.date,
        reference: inv.number,
        sourceId: inv.id,
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
    const raw = JSON.parse(JSON.stringify(seed));
    delete raw.stockMoves;
    delete raw.counters.transfer;
    delete raw.adjustments;
    delete raw.counters.adjustment;
    raw.version = 1;
    const backup = structuredClone(raw);
    const s = A.migrate(raw);
    expect(s.version).toBe(2);
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
    expect(inv.allocations.map((a) => [a.batchId, a.qty])).toEqual([
      [early.id, 10],
      [late.id, 90],
    ]);
    expect(early.qty).toBe(0);
    expect(late.qty).toBe(10);
    expect(inv.cogs).toBe(210);
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
    });
    A.receivePurchase(s, po.id, [{ code: 'ROUNDING', expiry: A.shift(365) }]);
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
    A.receivePurchase(s, po.id, [
      { code: 'MIXED', expiry: A.shift(365) },
      { code: 'MIXED', expiry: A.shift(365) },
    ]);
    expect(inv.allocations.reduce((n, a) => n + a.qty, 0)).toBe(23);
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
    const raw = JSON.parse(JSON.stringify(s));
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
      'Invoice allocations do not match its base quantities.',
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
    ).toHaveLength(6);
    expect(s.adjustments.some((a) => a.reason === 'recall')).toBe(true);
    expect(s.adjustments.filter((a) => a.reason === 'damaged')).toHaveLength(2);
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
