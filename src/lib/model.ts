import type {
  NumericInput,
  Unit,
  AccountId,
  AccountType,
  Product,
  Contact,
  Invoice,
  Purchase,
  Batch,
  Workspace,
  LineInput,
  ProductInput,
  ContactInput,
  StockInput,
  InvoiceInput,
  PurchaseInput,
  ExpenseInput,
  Allocation,
  Balances,
  Shape,
  MoveType,
  StockMove,
  Adjustment,
  AdjustmentInput,
  AdjustmentReason,
  StockCount,
  CountLine,
  DosageForm,
  Storage,
  Recall,
  ReorderRule,
  Suggestion,
  Reservation,
} from '../types';

// ponytail: fake user until auth exists; replace with the session user
export const CURRENT_USER = 'Krisstoff';
const COUNT_POSTING = Symbol('count posting');
const KEY = 'aster_pharmacy_workspace_v1';
const RECOVERY_KEY = 'aster_pharmacy_recovery';
const round = (n: NumericInput) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shift = (days: number, base = today()) => {
  const d = new Date(base + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysLeft = (date: string, base = today()) =>
  Math.round(
    (new Date(date + 'T12:00:00').getTime() - new Date(base + 'T12:00:00').getTime()) / 86400000,
  );
const uid = (prefix: string) =>
  prefix +
  '_' +
  (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sum = <T>(items: T[], fn: (item: T) => number) => round(items.reduce((s, x) => s + fn(x), 0));
function required(value: unknown, msg: string): asserts value {
  if (!value) throw new Error(msg);
}
const qtyCheck = (value: NumericInput) => {
  const n = Number(value);
  required(
    Number.isSafeInteger(n) && n > 0 && n < 10000000,
    'Quantity must be a positive whole number below 10,000,000.',
  );
  return n;
};
const moneyCheck = (value: unknown, label = 'Amount') => {
  const n = Number(value);
  required(
    Number.isFinite(n) && n >= 0 && n <= 100000000,
    `${label} must be between 0 and 100,000,000.`,
  );
  return round(n);
};
const dateCheck = (value: string) => {
  required(
    /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
      !isNaN(new Date(value + 'T12:00:00Z').getTime()) &&
      new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value,
    'Enter a valid date.',
  );
  return value;
};
const units: Unit[] = [
  'box',
  'bottle',
  'pack',
  'tube',
  'device',
  'unit',
  'strip',
  'vial',
  'ampoule',
  'sachet',
  'carton',
  'case',
];
const dosageForms: DosageForm[] = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'injection',
  'cream',
  'ointment',
  'drops',
  'inhaler',
  'powder',
  'solution',
  'device',
  'other',
];
const storageTypes: Storage[] = ['ambient', 'cold'];
const missingRegistration = (p: Product) =>
  !['device', 'other'].includes(p.dosageForm) && !p.registrationNo;
function inactiveReason(s: Workspace, id: string): string {
  const p = product(s, id);
  required(p, 'Product not found.');
  return onHand(s, id) > 0 ||
    s.invoices.some((i) => i.status === 'Draft' && i.lines.some((l) => l.productId === id)) ||
    s.purchases.some((p) => p.status === 'Ordered' && p.lines.some((l) => l.productId === id)) ||
    reserved(s, id) > 0
    ? `${p.name} still has stock or open documents.`
    : '';
}
function activeProduct(s: Workspace, id: string): Product {
  const p = product(s, id);
  required(p, 'Select a product.');
  required(p.active, `${p.name} is inactive.`);
  return p;
}
function validatePharma(s: Workspace, p: Product) {
  required(
    dosageForms.includes(p.dosageForm) && storageTypes.includes(p.storage),
    'Select a valid dosage form and storage.',
  );
  required(
    ['rx', 'controlled', 'active'].every(
      (key) => typeof p[key as 'rx' | 'controlled' | 'active'] === 'boolean',
    ),
    'Product flags must be booleans.',
  );
  required(
    ['registrationNo', 'manufacturer', 'strength', 'nameKm'].every(
      (key) =>
        typeof p[key as 'registrationNo' | 'manufacturer' | 'strength' | 'nameKm'] === 'string',
    ),
    'Enter valid regulatory product information.',
  );
  const no = p.registrationNo.trim().toUpperCase(),
    used = s.products.find(
      (other) =>
        other.id !== p.id &&
        no &&
        typeof other.registrationNo === 'string' &&
        other.registrationNo.trim().toUpperCase() === no,
    );
  required(!used, `Registration number ${no} is already used by ${used?.name}.`);
}
function controlledRegister(
  s: Workspace,
  filters: { from: string; to: string; productId?: string },
): Array<StockMove & { balanceAfter: number }> {
  dateCheck(filters.from);
  dateCheck(filters.to);
  required(filters.from <= filters.to, 'Date from must be on or before date to.');
  const balances = new Map<string, number>();
  return s.stockMoves
    .filter(
      (m) =>
        product(s, m.productId)?.controlled &&
        m.date <= filters.to &&
        (!filters.productId || m.productId === filters.productId),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at))
    .map((m) => {
      const key = JSON.stringify([m.productId, m.lotCode]),
        balanceAfter = (balances.get(key) || 0) + m.qty;
      balances.set(key, balanceAfter);
      return { ...m, balanceAfter };
    })
    .filter((m) => m.date >= filters.from);
}
const adjustmentReasons: Record<AdjustmentReason, string> = {
  damaged: 'Damaged',
  expired: 'Expired',
  lost: 'Lost / missing',
  sample: 'Sample / promotion',
  recall: 'Recall',
  found: 'Found',
  count: 'Count difference',
  other: 'Other',
};
function adjustmentReasonsFor(qty: number, sourceId?: string): AdjustmentReason[] {
  return (Object.keys(adjustmentReasons) as AdjustmentReason[]).filter(
    (reason) =>
      (reason !== 'count' || !!sourceId) &&
      (qty > 0 ? ['found', 'count', 'other'].includes(reason) : reason !== 'found'),
  );
}
const categories = [
  'Pain relief',
  'Antibiotics',
  'Vitamins & supplements',
  'First aid',
  'Digestive health',
  'Medical devices',
  'Respiratory',
  'Dermatology',
];
const accounts: { id: AccountId; name: string; type: AccountType }[] = [
  { id: 'cash', name: 'Cash & bank', type: 'Asset' },
  { id: 'receivable', name: 'Accounts receivable', type: 'Asset' },
  { id: 'inventory', name: 'Inventory', type: 'Asset' },
  { id: 'payable', name: 'Accounts payable', type: 'Liability' },
  { id: 'tax', name: 'Tax payable', type: 'Liability' },
  { id: 'equity', name: 'Opening equity', type: 'Equity' },
  { id: 'revenue', name: 'Sales revenue', type: 'Income' },
  { id: 'cogs', name: 'Cost of goods sold', type: 'Expense' },
  { id: 'expense', name: 'Operating expenses', type: 'Expense' },
  { id: 'loss', name: 'Inventory write-offs', type: 'Expense' },
];
const product = (s: Workspace, id: string) => s.products.find((x) => x.id === id);
const contact = (s: Workspace, id: string) => s.contacts.find((x) => x.id === id);
const warehouse = (s: Workspace, id: string) => s.warehouses.find((x) => x.id === id);
const baseUnitLocked = (s: Workspace, id: string) =>
  s.batches.some((b) => b.productId === id) ||
  [...s.invoices, ...s.purchases].some((d) => d.lines.some((l) => l.productId === id));
const unitLabel = (unit: Unit, qty = 2) =>
  qty === 1 ? unit : unit === 'box' ? 'boxes' : unit + 's';
function unitFactor(p: Product, unit: Unit = p.unit): number {
  const factor = unit === p.unit ? 1 : p.packs.find((pack) => pack.unit === unit)?.factor;
  required(factor, `Select a valid unit for ${p.name}.`);
  return factor;
}
function unitPrice(p: Product, unit: Unit = p.unit, purchase = false): number {
  const factor = unitFactor(p, unit);
  return purchase
    ? round(p.cost * factor)
    : (p.packs.find((pack) => pack.unit === unit)?.price ?? round(p.price * factor));
}
function formatQty(p: Product, baseQty: number): { main: string; packs?: string } {
  const count = (qty: number, unit: Unit) =>
    `${new Intl.NumberFormat('en-US').format(qty)} ${unitLabel(unit, qty)}`;
  const main = count(baseQty, p.unit);
  const pack = [...p.packs].sort((a, b) => b.factor - a.factor)[0];
  if (!pack || baseQty < pack.factor) return { main };
  const qty = Math.floor(baseQty / pack.factor),
    remainder = baseQty % pack.factor;
  return {
    main,
    packs: count(qty, pack.unit) + (remainder ? ' + ' + count(remainder, p.unit) : ''),
  };
}
function findBarcode(s: Workspace, code: string) {
  code = String(code || '').trim();
  if (!code) return null;
  for (const p of s.products) {
    if (p.barcode === code) return { product: p, pack: null };
    const pack = p.packs.find((pack) => pack.barcode === code);
    if (pack) return { product: p, pack };
  }
  return null;
}
function validatePacks(s: Workspace, p: Product) {
  required(Array.isArray(p.packs), 'Product packaging is missing.');
  const packUnits = new Set<Unit>(),
    packIds = new Set<string>(),
    barcodes = new Map<string, { name: string; unit: Unit }>();
  s.products
    .filter((other) => other.id !== p.id)
    .forEach((other) => {
      if (other.barcode) barcodes.set(other.barcode, { name: other.name, unit: other.unit });
      other.packs.forEach((pack) => {
        if (pack.barcode) barcodes.set(pack.barcode, { name: other.name, unit: pack.unit });
      });
    });
  const checkBarcode = (barcode: string, unit: Unit) => {
    required(typeof barcode === 'string', 'Enter a valid barcode.');
    if (!barcode) return;
    const used = barcodes.get(barcode);
    required(!used, `Barcode ${barcode} is already used by ${used?.name} (${used?.unit}).`);
    barcodes.set(barcode, { name: p.name, unit });
  };
  checkBarcode(p.barcode, p.unit);
  p.packs.forEach((pack) => {
    required(
      pack.id && !packIds.has(pack.id),
      'Packaging contains duplicate or missing identifiers.',
    );
    packIds.add(pack.id);
    required(
      units.includes(pack.unit) && pack.unit !== p.unit,
      'Select a pack unit different from the base unit.',
    );
    required(!packUnits.has(pack.unit), 'Each pack unit must be unique within the product.');
    packUnits.add(pack.unit);
    required(
      Number.isSafeInteger(pack.factor) && pack.factor >= 2 && pack.factor <= 10000,
      'Pack factor must be a whole number between 2 and 10,000.',
    );
    checkBarcode(pack.barcode, pack.unit);
    if (pack.price !== undefined) moneyCheck(pack.price, 'Pack selling price');
  });
}
function purchaseEntries(
  inventoryDebit: number,
  supplierCredit: number,
  credit: 'cash' | 'payable',
) {
  const difference = round(supplierCredit - inventoryDebit);
  const entries: { account: AccountId; debit?: number; credit?: number }[] = [
    { account: 'inventory', debit: inventoryDebit },
    { account: credit, credit: supplierCredit },
  ];
  if (difference)
    entries.push({
      account: 'loss',
      ...(difference > 0 ? { debit: difference } : { credit: -difference }),
    });
  return entries;
}
const onHand = (s: Workspace, id: string, wh = '') =>
  s.batches
    .filter((b) => b.productId === id && (!wh || b.warehouseId === wh))
    .reduce((n, b) => n + b.qty, 0);
const sameLot = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const openRecall = (s: Workspace, b: Batch) =>
  s.recalls.find(
    (r) => r.status === 'Open' && r.productId === b.productId && sameLot(r.lotCode, b.code),
  );
const isRecalled = (s: Workspace, b: Batch) => !!openRecall(s, b);
function shelfLifeCheck(value: unknown): number {
  required(
    Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1095,
    'Minimum shelf life must be a whole number between 0 and 1095 days.',
  );
  return Number(value);
}
function setMinShelfLife(s: Workspace, value: NumericInput): void {
  s.settings.minShelfLifeDays = shelfLifeCheck(Number(value));
}
const shelfLifeFor = (s: Workspace, customerId: string) =>
  contact(s, customerId)?.minShelfLifeDays ?? s.settings.minShelfLifeDays;
type SaleOptions = { customerId: string; allowShortDated: boolean };
const warehouseOpenCount = (s: Workspace, warehouseId: string) =>
  s.stockCounts.find((c) => c.warehouseId === warehouseId && c.status === 'Open');
const countFreezeMessage = (s: Workspace, count: StockCount) =>
  `${warehouse(s, count.warehouseId)!.name} is being counted (${count.number}). Post or cancel the count first.`;
const sellableBatch = (s: Workspace, b: Batch, productId: string, opts: SaleOptions) =>
  b.productId === productId &&
  b.qty > 0 &&
  !b.quarantined &&
  !isRecalled(s, b) &&
  daysLeft(b.expiry) > 0 &&
  (opts.allowShortDated || daysLeft(b.expiry) >= shelfLifeFor(s, opts.customerId));
const eligibleBatches = (s: Workspace, productId: string, opts: SaleOptions): Batch[] =>
  s.batches
    .filter((b) => sellableBatch(s, b, productId, opts) && !warehouseOpenCount(s, b.warehouseId))
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.received.localeCompare(b.received));
const sellableQty = (s: Workspace, productId: string, opts: SaleOptions) =>
  eligibleBatches(s, productId, opts).reduce((n, b) => n + b.qty, 0);
function shortDatedBatches(
  s: Workspace,
  lines: Array<{ productId: string; qty: NumericInput; factor: number }>,
  opts: SaleOptions,
): Batch[] {
  if (!opts.allowShortDated) return [];
  return [...new Set(lines.map((l) => l.productId))].flatMap((productId) => {
    let remaining = lines
      .filter((l) => l.productId === productId)
      .reduce((n, l) => n + Number(l.qty) * l.factor, 0);
    return eligibleBatches(s, productId, opts).filter((b) => {
      const used = Math.min(Math.max(0, remaining), b.qty);
      remaining -= used;
      return used > 0 && daysLeft(b.expiry) < shelfLifeFor(s, opts.customerId);
    });
  });
}
const shortDated = (s: Workspace, b: Batch) =>
  daysLeft(b.expiry) > 0 && daysLeft(b.expiry) < s.settings.minShelfLifeDays;
function createRecall(
  s: Workspace,
  input: {
    productId: string;
    lotCode: string;
    reason: string;
    date?: string;
    note?: string;
  },
): Recall {
  required(product(s, input.productId), 'Product not found.');
  const batch = s.batches.find(
    (b) => b.productId === input.productId && sameLot(b.code, String(input.lotCode || '').trim()),
  );
  required(batch, 'No batch exists for this product and lot.');
  required(!isRecalled(s, batch), 'This lot already has an Open recall.');
  const reason = String(input.reason || '').trim();
  required(reason, 'Enter a recall reason.');
  const recall: Recall = {
    id: uid('recall'),
    number: `RCL-${String(s.counters.recall).padStart(4, '0')}`,
    productId: batch.productId,
    lotCode: batch.code,
    reason,
    date: dateCheck(input.date ?? today()),
    status: 'Open',
    createdBy: CURRENT_USER,
    note: String(input.note || '').trim(),
  };
  s.recalls.unshift(recall);
  s.counters.recall++;
  activity(
    s,
    'recall',
    'Recall started',
    `${recall.number} · ${batch.code} · ${reason}`,
    recall.date,
  );
  return recall;
}
function recallTrace(s: Workspace, recallId: string) {
  const r = s.recalls.find((r) => r.id === recallId);
  required(r, 'Recall not found.');
  const moves = s.stockMoves.filter(
    (m) => m.productId === r.productId && sameLot(m.lotCode, r.lotCode),
  );
  const sold: Array<{
    customerId: string;
    customerName: string;
    phone: string;
    invoice: string;
    date: string;
    qty: number;
  }> = [];
  moves
    .filter((m) => m.type === 'sale')
    .forEach((m) => {
      const existing = sold.find((row) => row.invoice === m.reference);
      if (existing) sold[sold.indexOf(existing)] = { ...existing, qty: existing.qty - m.qty };
      else {
        const customerId = m.counterpartyId || '',
          c = contact(s, customerId);
        sold.push({
          customerId,
          customerName: c?.name || 'Unknown customer',
          phone: c?.phone || '',
          invoice: m.reference,
          date: m.date,
          qty: -m.qty,
        });
      }
    });
  const onHand = s.batches
    .filter((b) => b.productId === r.productId && sameLot(b.code, r.lotCode) && b.qty > 0)
    .map((b) => ({ batchId: b.id, warehouseId: b.warehouseId, qty: b.qty }));
  return {
    sold,
    onHand,
    totals: {
      received: sum(
        moves.filter((m) => ['receipt', 'opening'].includes(m.type)),
        (m) => m.qty,
      ),
      sold: sum(sold, (row) => row.qty),
      adjusted: sum(
        moves.filter((m) => m.type === 'adjustment'),
        (m) => m.qty,
      ),
      onHand: sum(onHand, (row) => row.qty),
    },
  };
}
function closeRecall(s: Workspace, recallId: string): void {
  const r = s.recalls.find((r) => r.id === recallId);
  required(r && r.status === 'Open', 'Only Open recalls can be closed.');
  const qty = recallTrace(s, recallId).totals.onHand;
  required(qty === 0, `${qty} units of lot ${r.lotCode} are still in stock. Write them off first.`);
  r.status = 'Closed';
  r.closedAt = new Date().toISOString();
  activity(s, 'recall', 'Recall closed', `${r.number} · ${r.lotCode}`);
}
const available = (s: Workspace, id: string, wh = '') =>
  s.batches
    .filter(
      (b) =>
        b.productId === id &&
        b.qty > 0 &&
        !b.quarantined &&
        !isRecalled(s, b) &&
        daysLeft(b.expiry) > 0 &&
        (!wh || b.warehouseId === wh),
    )
    .reduce((n, b) => n + b.qty, 0);
const inventoryValue = (s: Workspace, wh = '') =>
  sum(
    s.batches.filter((b) => !wh || b.warehouseId === wh),
    (b) => b.qty * b.cost,
  );
const reservationStatus = (r: Reservation): Reservation['status'] | 'Expired' =>
  r.status === 'Active' && r.source === 'hold' && r.expires! < today() ? 'Expired' : r.status;
const reserved = (s: Workspace, productId: string, opts: { exceptSourceId?: string } = {}) =>
  s.reservations
    .filter(
      (r) =>
        r.productId === productId &&
        reservationStatus(r) === 'Active' &&
        (!opts.exceptSourceId || r.source !== 'invoice' || r.sourceId !== opts.exceptSourceId),
    )
    .reduce((n, r) => n + r.qty, 0);
const free = (
  s: Workspace,
  productId: string,
  opts: { customerId?: string; allowShortDated?: boolean; exceptSourceId?: string } = {},
) =>
  (opts.customerId
    ? sellableQty(s, productId, {
        customerId: opts.customerId,
        allowShortDated: opts.allowShortDated ?? false,
      })
    : available(s, productId)) - reserved(s, productId, opts);
function addReservation(
  s: Workspace,
  input: Pick<
    Reservation,
    'productId' | 'customerId' | 'qty' | 'source' | 'sourceId' | 'expires' | 'note'
  >,
): Reservation {
  const r: Reservation = {
    ...input,
    id: uid('rsv'),
    number: `RSV-${String(s.counters.reservation++).padStart(4, '0')}`,
    status: 'Active',
    createdAt: new Date().toISOString(),
    createdBy: CURRENT_USER,
  };
  s.reservations.unshift(r);
  return r;
}
function holdStock(
  s: Workspace,
  input: {
    productId: string;
    customerId: string;
    qty: NumericInput;
    expires?: string;
    note?: string;
  },
): Reservation {
  const p = activeProduct(s, input.productId);
  required(contact(s, input.customerId)?.type === 'Customer', 'Select a customer.');
  const qty = qtyCheck(input.qty),
    expires = dateCheck(input.expires ?? shift(3)),
    stock = free(s, p.id, { customerId: input.customerId });
  required(
    expires >= today() && expires <= shift(30),
    'Hold expiry must be between today and 30 days from today.',
  );
  required(qty <= stock, `Not enough free stock: ${p.name} (need ${qty}, free ${stock}).`);
  return addReservation(s, {
    productId: p.id,
    customerId: input.customerId,
    qty,
    expires,
    source: 'hold',
    note: String(input.note || '').trim(),
  });
}
function reserveInvoice(s: Workspace, invoiceId: string): Reservation[] {
  const i = s.invoices.find((i) => i.id === invoiceId);
  required(i?.status === 'Draft', 'Only draft invoices can be reserved.');
  required(
    !s.reservations.some(
      (r) => r.source === 'invoice' && r.sourceId === invoiceId && r.status === 'Active',
    ),
    'This draft is already reserved.',
  );
  const demand = new Map<string, number>();
  i.lines.forEach((l) => {
    activeProduct(s, l.productId);
    demand.set(l.productId, (demand.get(l.productId) || 0) + l.qty * l.factor);
  });
  const shortages = [...demand].flatMap(([id, qty]) => {
    const stock = free(s, id, { customerId: i.customerId, allowShortDated: i.allowShortDated });
    return qty > stock ? [`${product(s, id)!.name} (need ${qty}, free ${stock})`] : [];
  });
  required(!shortages.length, `Not enough free stock: ${shortages.join(', ')}.`);
  return [...demand].map(([productId, qty]) =>
    addReservation(s, {
      productId,
      qty,
      customerId: i.customerId,
      source: 'invoice',
      sourceId: i.id,
      note: '',
    }),
  );
}
function releaseReservation(s: Workspace, reservationId: string): void {
  const r = s.reservations.find((r) => r.id === reservationId);
  required(r?.status === 'Active', 'Only active or expired reservations can be released.');
  r.status = 'Released';
  r.closedAt = new Date().toISOString();
}
function releaseInvoiceReservations(s: Workspace, invoiceId: string): void {
  s.reservations
    .filter((r) => r.source === 'invoice' && r.sourceId === invoiceId && r.status === 'Active')
    .forEach((r) => releaseReservation(s, r.id));
}
function checkReorderRule(s: Workspace, rule: ReorderRule): void {
  required(product(s, rule.productId), 'Product not found.');
  required(warehouse(s, rule.warehouseId), 'Select a warehouse.');
  required(
    Number.isSafeInteger(rule.min) &&
      Number.isSafeInteger(rule.max) &&
      rule.min >= 0 &&
      rule.min < rule.max,
    'Reorder levels must be whole numbers with 0 ≤ min < max.',
  );
}
function saveReorderRule(s: Workspace, input: ReorderRule): ReorderRule {
  checkReorderRule(s, input);
  activeProduct(s, input.productId);
  const rule: ReorderRule = {
    productId: input.productId,
    warehouseId: input.warehouseId,
    min: input.min,
    max: input.max,
  };
  const index = s.reorderRules.findIndex(
    (r) => r.productId === rule.productId && r.warehouseId === rule.warehouseId,
  );
  if (index === -1) s.reorderRules.push(rule);
  else s.reorderRules[index] = rule;
  return rule;
}
function deleteReorderRule(s: Workspace, productId: string, warehouseId: string): void {
  s.reorderRules = s.reorderRules.filter(
    (r) => r.productId !== productId || r.warehouseId !== warehouseId,
  );
}
function onOrder(s: Workspace, productId: string, warehouseId: string): number {
  return s.purchases
    .filter((p) => p.status === 'Ordered' && p.warehouseId === warehouseId)
    .reduce(
      (n, p) =>
        n +
        p.lines
          .filter((l) => l.productId === productId)
          .reduce((qty, l) => qty + l.qty * l.factor, 0),
      0,
    );
}
function reorderSuggestions(s: Workspace, warehouseId?: string): Suggestion[] {
  // ponytail: ignores reservations; subtract per-warehouse reservations if they're added
  return s.reorderRules
    .filter(
      (r) => (!warehouseId || r.warehouseId === warehouseId) && product(s, r.productId)?.active,
    )
    .flatMap((r) => {
      const p = product(s, r.productId)!,
        stock = available(s, p.id, r.warehouseId),
        ordered = onOrder(s, p.id, r.warehouseId),
        position = stock + ordered;
      if (position > r.min) return [];
      const pack = [...p.packs].sort((a, b) => b.factor - a.factor)[0],
        orderUnit = pack?.unit || p.unit,
        factor = unitFactor(p, orderUnit),
        orderQty = Math.ceil((r.max - position) / factor);
      return [
        {
          ...r,
          supplierId: p.supplierId || '',
          available: stock,
          onOrder: ordered,
          position,
          orderBase: orderQty * factor,
          orderUnit,
          orderQty,
          estimatedCost: round(orderQty * unitPrice(p, orderUnit, true)),
        },
      ];
    });
}
const batchStatus = (s: Workspace, b: Batch, window = 90) =>
  isRecalled(s, b)
    ? 'Recalled'
    : b.quarantined
      ? 'Quarantined'
      : daysLeft(b.expiry) <= 0
        ? 'Expired'
        : daysLeft(b.expiry) <= window
          ? 'Expiring soon'
          : 'Active';
const productStatus = (s: Workspace, p: Product) =>
  available(s, p.id) === 0
    ? 'Out of stock'
    : available(s, p.id) <= p.reorder
      ? 'Low stock'
      : 'In stock';
const invoiceStatus = (i: Invoice) =>
  i.status === 'Draft'
    ? 'Draft'
    : round(i.total - i.paid) <= 0
      ? 'Paid'
      : daysLeft(i.due) < 0
        ? 'Overdue'
        : i.paid > 0
          ? 'Partial'
          : 'Unpaid';
const invoiceBalance = (i: Invoice) => (i.status === 'Draft' ? 0 : round(i.total - i.paid));
function ledger(
  s: Workspace,
  date: string,
  reference: string,
  description: string,
  entries: { account: AccountId; debit?: number; credit?: number }[],
) {
  const dr = sum(entries, (e) => e.debit || 0),
    cr = sum(entries, (e) => e.credit || 0);
  required(dr === cr, 'Journal entry is not balanced.');
  const entry = {
    id: uid('journal'),
    date,
    reference,
    description,
    entries: entries.map((e) => ({
      ...e,
      debit: round(e.debit || 0),
      credit: round(e.credit || 0),
    })),
  };
  s.journal.unshift(entry);
  return entry;
}
function activity(s: Workspace, type: string, title: string, description: string, date = today()) {
  s.movements.unshift({
    id: uid('move'),
    type,
    title,
    description,
    date,
    createdAt: new Date().toISOString(),
  });
}
function totals(
  lines: { qty: number; price: number }[],
  discount: NumericInput = 0,
  taxRate: NumericInput = 0,
) {
  const subtotal = sum(lines, (l) => l.qty * l.price),
    disc = moneyCheck(discount, 'Discount'),
    tax = moneyCheck(taxRate, 'Tax rate');
  required(disc <= subtotal, 'Discount cannot exceed the subtotal.');
  required(tax <= 100, 'Tax rate cannot exceed 100%.');
  const taxAmount = round(((subtotal - disc) * tax) / 100);
  return {
    subtotal,
    discount: disc,
    taxRate: tax,
    taxAmount,
    total: round(subtotal - disc + taxAmount),
  };
}
function saveProduct(s: Workspace, data: ProductInput, id?: string) {
  required(data.packs === undefined || Array.isArray(data.packs), 'Enter valid product packaging.');
  const previous = id ? product(s, id) : undefined;
  required(!id || previous, 'Product not found.');
  required(
    !previous || previous.unit === data.unit || !baseUnitLocked(s, previous.id),
    "The base unit can't change after stock or documents exist.",
  );
  const name = String(data.name || '').trim(),
    sku = String(data.sku || '')
      .trim()
      .toUpperCase();
  required(name.length >= 2, 'Enter a product name.');
  required(sku.length > 0, 'Enter a SKU.');
  required(
    !s.products.some((p) => p.sku.toLowerCase() === sku.toLowerCase() && p.id !== id),
    'This SKU already exists.',
  );
  required(categories.includes(data.category), 'Select a valid category.');
  required(units.includes(data.unit), 'Select a valid stock unit.');
  const reorder = Number(data.reorder);
  required(
    Number.isSafeInteger(reorder) && reorder >= 0 && reorder < 10000000,
    'Reorder level must be a non-negative whole number.',
  );
  const p: Product = {
    id: id || uid('product'),
    name,
    sku,
    barcode: String(data.barcode || '').trim(),
    generic: String(data.generic || '').trim(),
    category: data.category,
    unit: data.unit,
    packs: (data.packs ?? previous?.packs ?? []).map((pack) => ({
      id: pack.id || uid('pack'),
      unit: pack.unit,
      factor: Number(pack.factor),
      barcode: String(pack.barcode || '').trim(),
      ...(pack.price === undefined || pack.price === ''
        ? {}
        : { price: moneyCheck(pack.price, 'Pack selling price') }),
    })),
    cost: moneyCheck(data.cost, 'Cost'),
    price: moneyCheck(data.price, 'Selling price'),
    reorder,
    supplierId: data.supplierId || '',
    color: data.color || '#689e89',
    shape: data.shape || 'box',
    registrationNo: String(data.registrationNo ?? previous?.registrationNo ?? '')
      .trim()
      .toUpperCase(),
    manufacturer: String(data.manufacturer ?? previous?.manufacturer ?? '').trim(),
    dosageForm:
      data.dosageForm === undefined
        ? (previous?.dosageForm ?? (data.unit === 'device' ? 'device' : 'other'))
        : data.dosageForm,
    strength: String(data.strength ?? previous?.strength ?? '').trim(),
    rx: data.rx === undefined ? (previous?.rx ?? false) : data.rx,
    controlled: data.controlled === undefined ? (previous?.controlled ?? false) : data.controlled,
    storage: data.storage === undefined ? (previous?.storage ?? 'ambient') : data.storage,
    nameKm: String(data.nameKm ?? previous?.nameKm ?? '').trim(),
    active: data.active === undefined ? (previous?.active ?? true) : data.active,
  };
  validatePharma(s, p);
  required(
    p.storage !== 'cold' ||
      !s.batches.some(
        (b) => b.productId === p.id && b.qty > 0 && warehouse(s, b.warehouseId)?.storage !== 'cold',
      ),
    `Move ${p.name} into cold storage before marking it cold-chain.`,
  );
  if (!p.active && previous)
    required(!inactiveReason(s, p.id), `${p.name} still has stock or open documents.`);
  validatePacks(s, p);
  if (id) {
    required(product(s, id), 'Product not found.');
    s.products = s.products.map((x) => (x.id === id ? p : x));
  } else s.products.push(p);
  activity(s, 'product', id ? 'Product updated' : 'Product added', p.name);
  return p;
}
function moveStock(
  s: Workspace,
  batch: Batch,
  qty: number,
  meta: {
    type: MoveType;
    date: string;
    reference: string;
    sourceId?: string;
    counterpartyId?: string;
    reason?: string;
  },
  countPosting?: typeof COUNT_POSTING,
): StockMove {
  const recall = openRecall(s, batch);
  required(
    !(qty > 0 && meta.type === 'receipt' && recall),
    `Lot ${batch.code} is under recall (${recall?.number}).`,
  );
  if (qty > 0) {
    const p = activeProduct(s, batch.productId);
    required(
      p.storage !== 'cold' || warehouse(s, batch.warehouseId)?.storage === 'cold',
      `${p.name} must be stored at 2–8°C. Choose a cold-storage warehouse.`,
    );
  }
  // ponytail: whole-warehouse freeze keeps counts exact; counts must be short (after hours). Upgrade to per-line snapshots if counts need to run during trading.
  const count = warehouseOpenCount(s, batch.warehouseId);
  required(!count || countPosting === COUNT_POSTING, count ? countFreezeMessage(s, count) : '');
  required(Number.isSafeInteger(qty) && qty !== 0, 'Quantity must be a non-zero safe integer.');
  dateCheck(meta.date);
  required(batch.qty + qty >= 0, `Not enough stock in lot ${batch.code} (${batch.qty} available).`);
  required(Number.isSafeInteger(batch.qty + qty), 'Stock quantity must be a safe integer.');
  batch.qty += qty;
  const move: StockMove = {
    ...meta,
    id: uid('sm'),
    at: new Date().toISOString(),
    batchId: batch.id,
    productId: batch.productId,
    warehouseId: batch.warehouseId,
    lotCode: batch.code,
    qty,
    unitCost: batch.cost,
    user: CURRENT_USER,
  };
  s.stockMoves.push(move);
  return move;
}
function openCount(s: Workspace, countId: string): StockCount {
  const count = s.stockCounts.find((c) => c.id === countId);
  required(count, 'Stock count not found.');
  required(count.status === 'Open', 'Stock count must be Open.');
  return count;
}
function countLine(batch: Batch): CountLine {
  return {
    batchId: batch.id,
    productId: batch.productId,
    lotCode: batch.code,
    expiry: batch.expiry,
    expected: batch.qty,
    counted: null,
  };
}
function startCount(
  s: Workspace,
  input: { warehouseId: string; categories?: string[]; blind?: boolean; note?: string },
  createdAt = new Date().toISOString(),
): StockCount {
  const wh = warehouse(s, input.warehouseId);
  required(wh, 'Select a warehouse.');
  required(
    !s.stockCounts.some((c) => c.warehouseId === wh.id && c.status === 'Open'),
    `${wh.name} already has an Open stock count.`,
  );
  const selected = input.categories ?? [];
  required(
    Array.isArray(selected) && selected.every((c) => categories.includes(c)),
    'Select valid categories.',
  );
  const lines = s.batches
    .filter(
      (b) =>
        b.warehouseId === wh.id &&
        b.qty > 0 &&
        (!selected.length || selected.includes(product(s, b.productId)!.category)),
    )
    .map(countLine);
  required(lines.length, `There is no stock to count in ${wh.name}.`);
  const count: StockCount = {
    id: uid('count'),
    number: `SC-${String(s.counters.count).padStart(4, '0')}`,
    warehouseId: wh.id,
    categories: [...new Set(selected)],
    blind: !!input.blind,
    status: 'Open',
    note: String(input.note || '').trim(),
    createdAt,
    createdBy: CURRENT_USER,
    lines,
  };
  s.stockCounts.unshift(count);
  s.counters.count++;
  return count;
}
function addCountLine(s: Workspace, countId: string, batchId: string): void {
  const count = openCount(s, countId),
    batch = s.batches.find((b) => b.id === batchId);
  required(batch, 'Batch not found.');
  required(batch.warehouseId === count.warehouseId, 'Select a lot in the count warehouse.');
  required(!count.lines.some((l) => l.batchId === batchId), 'This lot is already in the count.');
  count.lines.push(countLine(batch));
}
function recordCount(
  s: Workspace,
  countId: string,
  batchId: string,
  counted: NumericInput | null,
): void {
  const count = openCount(s, countId),
    line = count.lines.find((l) => l.batchId === batchId);
  required(line, 'Count line not found.');
  const qty = counted === null ? null : Number(counted);
  required(
    qty === null || (Number.isSafeInteger(qty) && qty >= 0),
    'Counted quantity must be a non-negative safe integer.',
  );
  line.counted = qty;
}
function postCount(
  s: Workspace,
  countId: string,
  postedAt = new Date().toISOString(),
  date = today(),
) {
  const count = openCount(s, countId),
    missing = count.lines.filter((l) => l.counted === null).length;
  required(!missing, `${missing} lines are not counted yet.`);
  const differences = count.lines.filter((l) => l.counted !== l.expected);
  differences.forEach((l) => {
    const batch = s.batches.find((b) => b.id === l.batchId);
    required(
      batch && batch.qty === l.expected,
      `Stock in lot ${l.lotCode} changed during the count.`,
    );
  });
  const adjustments = differences.map((l) =>
    adjustStock(
      s,
      {
        batchId: l.batchId,
        qty: l.counted! - l.expected,
        reason: 'count',
        note: count.number,
        date,
      },
      { sourceId: count.id, countPosting: COUNT_POSTING },
    ),
  );
  count.status = 'Posted';
  count.postedAt = postedAt;
  count.postedBy = CURRENT_USER;
  const result = {
    lines: count.lines.length,
    differences: differences.length,
    value: sum(adjustments, (a) => a.value),
  };
  activity(
    s,
    'count',
    'Stock count posted',
    `${count.number} · ${warehouse(s, count.warehouseId)!.name} · ${result.differences} differences`,
    date,
  );
  return result;
}
function cancelCount(s: Workspace, countId: string): void {
  openCount(s, countId).status = 'Canceled';
}
function stockAt(
  s: Workspace,
  filters: { date: string; productId?: string; warehouseId?: string; batchId?: string },
): number {
  dateCheck(filters.date);
  return movesFor(s, { ...filters, to: filters.date }).reduce((n, m) => n + m.qty, 0);
}
function movesFor(
  s: Workspace,
  filters: {
    productId?: string;
    warehouseId?: string;
    batchId?: string;
    lotCode?: string;
    type?: MoveType;
    from?: string;
    to?: string;
  } = {},
): StockMove[] {
  return s.stockMoves.filter(
    (m) =>
      (!filters.productId || m.productId === filters.productId) &&
      (!filters.warehouseId || m.warehouseId === filters.warehouseId) &&
      (!filters.batchId || m.batchId === filters.batchId) &&
      (!filters.lotCode || m.lotCode === filters.lotCode) &&
      (!filters.type || m.type === filters.type) &&
      (!filters.from || m.date >= filters.from) &&
      (!filters.to || m.date <= filters.to),
  );
}
function addBatch(
  s: Workspace,
  data: StockInput,
  options: {
    allowExpired?: boolean;
    moveType?: 'opening' | 'receipt';
    date?: string;
    reference?: string;
    sourceId?: string;
    counterpartyId?: string;
  } = {},
) {
  const p = product(s, data.productId);
  required(p, 'Select a product.');
  required(warehouse(s, data.warehouseId), 'Select a warehouse.');
  const qty = qtyCheck(data.qty),
    cost = moneyCheck(data.cost, 'Unit cost'),
    expiry = dateCheck(data.expiry),
    code = String(data.code || '').trim();
  required(code.length > 0, 'Enter the batch / lot number.');
  required(
    options.allowExpired || daysLeft(expiry) > 0,
    'New stock must have a future expiry date.',
  );
  const existing = s.batches.find(
    (b) =>
      b.productId === p.id &&
      b.code.toLowerCase() === code.toLowerCase() &&
      b.warehouseId === data.warehouseId &&
      !b.quarantined,
  );
  if (existing) {
    required(
      existing.expiry === expiry && existing.cost === cost,
      'This lot already exists with a different expiry date or cost. Use a unique lot number.',
    );
  } else
    s.batches.push({
      id: uid('batch'),
      productId: p.id,
      code,
      qty: 0,
      cost,
      expiry,
      warehouseId: data.warehouseId,
      received: data.received || today(),
      quarantined: !!data.quarantined,
    });
  const batch = existing || s.batches[s.batches.length - 1];
  moveStock(s, batch, qty, {
    type: options.moveType || 'receipt',
    date: options.date || today(),
    reference: options.reference || code,
    sourceId: options.sourceId,
    counterpartyId: options.counterpartyId,
  });
  return batch;
}
function receiveStock(s: Workspace, data: StockInput) {
  const p = product(s, data.productId);
  required(p, 'Select a product.');
  const factor = unitFactor(p, data.unit),
    qty = qtyCheck(data.qty),
    cost = moneyCheck(data.cost, 'Unit cost'),
    amount = round(qty * cost);
  const batch = addBatch(
    s,
    { ...data, qty: qty * factor, cost: round(cost / factor) },
    {
      date: today(),
      reference: data.reference,
      counterpartyId: data.supplierId || product(s, data.productId)?.supplierId,
    },
  );
  const inventoryDebit = round(qty * factor * batch.cost);
  ledger(
    s,
    today(),
    data.reference || batch.code,
    'Stock receipt — ' + p.name + (amount !== inventoryDebit ? ' · Purchase rounding' : ''),
    purchaseEntries(inventoryDebit, amount, data.payment === 'credit' ? 'payable' : 'cash'),
  );
  const receipt = {
    id: uid('receipt'),
    date: today(),
    reference: batch.code,
    supplierId: data.supplierId || product(s, data.productId)!.supplierId,
    total: amount,
    paid: data.payment === 'credit' ? 0 : amount,
    warehouseId: data.warehouseId,
  };
  s.receipts.unshift(receipt);
  activity(
    s,
    'receive',
    'Stock received',
    `${qty} ${unitLabel(data.unit ?? p.unit, qty)} · ${p.name} · ${warehouse(s, data.warehouseId)!.name}`,
  );
  return batch;
}
function transferStock(s: Workspace, data: { batchId: string; qty: NumericInput; to: string }) {
  const batch = s.batches.find((b) => b.id === data.batchId),
    qty = qtyCheck(data.qty);
  required(batch, 'Select a batch.');
  required(warehouse(s, data.to), 'Select the destination warehouse.');
  required(batch.warehouseId !== data.to, 'Choose a different destination warehouse.');
  required(qty <= batch.qty, 'Transfer quantity exceeds stock in this batch.');
  const from = warehouse(s, batch.warehouseId)!.name,
    to = warehouse(s, data.to)!.name;
  let target = s.batches.find(
    (b) =>
      b.productId === batch.productId &&
      b.code === batch.code &&
      b.expiry === batch.expiry &&
      b.cost === batch.cost &&
      b.warehouseId === data.to &&
      b.quarantined === batch.quarantined,
  );
  if (!target) {
    target = { ...batch, id: uid('batch'), warehouseId: data.to, qty: 0 };
    s.batches.push(target);
  }
  const reference = `TR-${String(s.counters.transfer++).padStart(4, '0')}`,
    sourceId = uid('transfer'),
    date = today();
  moveStock(s, batch, -qty, { type: 'transfer_out', date, reference, sourceId });
  moveStock(s, target, qty, { type: 'transfer_in', date, reference, sourceId });
  activity(
    s,
    'transfer',
    'Stock transferred',
    `${qty} ${product(s, batch.productId)!.unit}s · ${product(s, batch.productId)!.name} · ${from} → ${to}`,
  );
}
function setQuarantine(s: Workspace, id: string, value: boolean) {
  const b = s.batches.find((x) => x.id === id);
  required(b, 'Batch not found.');
  b.quarantined = !!value;
  activity(
    s,
    'adjust',
    value ? 'Batch quarantined' : 'Batch released',
    `${b.code} · ${product(s, b.productId)!.name}`,
  );
}
function adjustStock(
  s: Workspace,
  input: AdjustmentInput,
  options: { sourceId?: string; countPosting?: typeof COUNT_POSTING } = {},
): Adjustment {
  const batch = s.batches.find((b) => b.id === input.batchId);
  required(batch, 'Batch not found.');
  const qty = Number(input.qty),
    reason = input.reason,
    note = String(input.note || '').trim(),
    date = dateCheck(input.date ?? today());
  required(Number.isSafeInteger(qty) && qty !== 0, 'Quantity must be a non-zero safe integer.');
  required(date <= today(), 'Adjustment date cannot be in the future.');
  required(Object.hasOwn(adjustmentReasons, reason), 'Select a valid adjustment reason.');
  required(
    reason !== 'count' || options.sourceId?.trim(),
    'Count differences are posted from a stock count.',
  );
  required(
    adjustmentReasonsFor(qty, options.sourceId).includes(reason),
    `"${reason}" can't be used to ${qty > 0 ? 'add' : 'remove'} stock.`,
  );
  required(!['other', 'found'].includes(reason) || note, 'Enter a note for this adjustment.');
  required(
    reason !== 'recall' || isRecalled(s, batch),
    'Recall adjustments require an Open recall for the lot.',
  );
  const unitCost = moneyCheck(batch.cost, 'Unit cost'),
    value = round(qty * unitCost),
    amount = moneyCheck(Math.abs(value));
  const adjustment: Adjustment = {
    id: uid('adj'),
    number: `ADJ-${String(s.counters.adjustment).padStart(4, '0')}`,
    date,
    batchId: batch.id,
    productId: batch.productId,
    warehouseId: batch.warehouseId,
    lotCode: batch.code,
    qty,
    unitCost,
    value,
    reason,
    note,
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    user: CURRENT_USER,
  };
  moveStock(
    s,
    batch,
    qty,
    {
      type: 'adjustment',
      date,
      reference: adjustment.number,
      sourceId: adjustment.id,
      reason,
    },
    options.countPosting,
  );
  ledger(
    s,
    date,
    adjustment.number,
    'Stock adjustment — ' + adjustmentReasons[reason],
    qty < 0
      ? [
          { account: 'loss', debit: amount },
          { account: 'inventory', credit: amount },
        ]
      : [
          { account: 'inventory', debit: amount },
          { account: 'loss', credit: amount },
        ],
  );
  s.adjustments.unshift(adjustment);
  s.counters.adjustment++;
  activity(
    s,
    'adjust',
    'Stock adjusted',
    `${qty > 0 ? '+' : ''}${qty} ${unitLabel(product(s, batch.productId)!.unit, Math.abs(qty))} · ${product(s, batch.productId)!.name} · ${batch.code} · ${reason}`,
    date,
  );
  return adjustment;
}
function normalizedLines(s: Workspace, lines: LineInput[], key: 'price' | 'cost' = 'price') {
  required(Array.isArray(lines) && lines.length, 'Add at least one product.');
  return lines.map((l) => {
    const p = product(s, l.productId);
    required(p, 'Select a product for every line.');
    activeProduct(s, p.id);
    const unit = l.unit ?? p.unit,
      factor = unitFactor(p, unit),
      qty = qtyCheck(l.qty);
    qtyCheck(qty * factor);
    return {
      productId: p.id,
      name: p.name,
      sku: p.sku,
      unit,
      factor,
      qty,
      price: moneyCheck(
        l[key] ?? unitPrice(p, unit, key === 'cost'),
        key === 'price' ? 'Unit price' : 'Unit cost',
      ),
    };
  });
}
function createInvoice(s: Workspace, data: InvoiceInput, id?: string) {
  required(
    data.allowShortDated === undefined || typeof data.allowShortDated === 'boolean',
    'Allow short-dated stock must be a boolean.',
  );
  required(contact(s, data.customerId)?.type === 'Customer', 'Select a customer.');
  const date = dateCheck(data.date),
    due = dateCheck(data.due);
  required(due >= date, 'Due date must be on or after the invoice date.');
  required(date <= today(), 'Invoice date cannot be in the future.');
  const lines = normalizedLines(s, data.lines),
    amounts = totals(lines, data.discount, data.taxRate);
  required(amounts.total > 0, 'Invoice total must be greater than zero.');
  const previous = id ? s.invoices.find((i) => i.id === id) : null;
  required(!id || previous?.status === 'Draft', 'Only draft invoices can be edited.');
  const wasReserved =
    !!previous &&
    s.reservations.some(
      (r) => r.source === 'invoice' && r.sourceId === previous.id && r.status === 'Active',
    );
  required(
    data.fromHoldIds === undefined ||
      (Array.isArray(data.fromHoldIds) &&
        new Set(data.fromHoldIds).size === data.fromHoldIds.length),
    'Select valid, distinct holds.',
  );
  const holds = (data.fromHoldIds ?? []).map((holdId) => {
    const r = s.reservations.find((r) => r.id === holdId);
    required(
      r?.source === 'hold' && reservationStatus(r) === 'Active',
      'Select an active, non-expired hold.',
    );
    required(r.customerId === data.customerId, 'The hold must be for the same customer.');
    return r;
  });
  const invoice: Invoice = {
    id: id || uid('invoice'),
    number:
      previous?.number ||
      `${s.settings.invoicePrefix}-${String(s.counters.invoice++).padStart(4, '0')}`,
    customerId: data.customerId,
    allowShortDated: data.allowShortDated ?? previous?.allowShortDated ?? false,
    date,
    due,
    lines,
    ...amounts,
    status: 'Draft',
    paid: 0,
    payments: [],
    allocations: [],
    notes: String(data.notes || '').trim(),
  };
  if (id) s.invoices = s.invoices.map((i) => (i.id === id ? invoice : i));
  else s.invoices.unshift(invoice);
  holds.forEach((r) => releaseReservation(s, r.id));
  if (wasReserved) releaseInvoiceReservations(s, invoice.id);
  if (wasReserved || holds.length) {
    try {
      reserveInvoice(s, invoice.id);
    } catch (error) {
      if (
        wasReserved &&
        error instanceof Error &&
        error.message.startsWith('Not enough free stock: ')
      )
        throw new Error(
          error.message.replace(
            'Not enough free stock: ',
            'Not enough free stock to keep this draft reserved: ',
          ),
        );
      throw error;
    }
  }
  return invoice;
}
function issueInvoice(s: Workspace, id: string) {
  const inv = s.invoices.find((i) => i.id === id);
  required(inv && inv.status === 'Draft', 'Only draft invoices can be issued.');
  inv.lines.forEach((l) => activeProduct(s, l.productId));
  const demand: Record<string, number> = {};
  inv.lines.forEach((l) => {
    demand[l.productId] = (demand[l.productId] || 0) + l.qty * l.factor;
  });
  const opts = { customerId: inv.customerId, allowShortDated: inv.allowShortDated };
  Object.keys(demand).forEach((id) => {
    const p = product(s, id)!,
      qty = free(s, id, { ...opts, exceptSourceId: inv.id }),
      sellable = sellableQty(s, id, opts),
      long = sellableQty(s, id, { ...opts, allowShortDated: false }),
      short = sellableQty(s, id, { ...opts, allowShortDated: true }) - long;
    if (qty < demand[id]) {
      const frozen = s.batches.filter(
        (b) => sellableBatch(s, b, id, opts) && warehouseOpenCount(s, b.warehouseId),
      );
      if (frozen.length && qty + sum(frozen, (b) => b.qty) >= demand[id]) {
        throw new Error(countFreezeMessage(s, warehouseOpenCount(s, frozen[0].warehouseId)!));
      }
    }
    required(
      qty >= demand[id],
      sellable >= demand[id]
        ? `Not enough free stock: ${p.name} (need ${demand[id]}, free ${qty}).`
        : opts.allowShortDated
          ? `Not enough sellable stock: ${p.name} (need ${demand[id]}, available ${sellable}).`
          : `Only ${long} ${unitLabel(p.unit, long)} of ${p.name} have at least ${shelfLifeFor(s, inv.customerId)} days of shelf life (${short} more are short-dated). Tick "Allow short-dated stock" if the customer accepts them.`,
    );
  });
  const allocations: Allocation[] = [];
  inv.lines.forEach((l) => {
    let remaining = l.qty * l.factor;
    const batches = eligibleBatches(s, l.productId, opts);
    for (const b of batches) {
      if (!remaining) break;
      const take = Math.min(remaining, b.qty);
      moveStock(s, b, -take, {
        type: 'sale',
        date: inv.date,
        reference: inv.number,
        sourceId: inv.id,
        counterpartyId: inv.customerId,
      });
      remaining -= take;
      allocations.push({
        batchId: b.id,
        code: b.code,
        warehouseId: b.warehouseId,
        productId: l.productId,
        qty: take,
        cost: b.cost,
      });
    }
  });
  const cost = sum(allocations, (a) => a.qty * a.cost);
  const entries: { account: AccountId; debit?: number; credit?: number }[] = [
    { account: 'receivable', debit: inv.total },
    { account: 'revenue', credit: round(inv.subtotal - inv.discount) },
  ];
  if (inv.taxAmount) entries.push({ account: 'tax', credit: inv.taxAmount });
  entries.push({ account: 'cogs', debit: cost }, { account: 'inventory', credit: cost });
  ledger(s, inv.date, inv.number, 'Sale — ' + contact(s, inv.customerId)!.name, entries);
  inv.status = 'Issued';
  s.reservations
    .filter((r) => r.source === 'invoice' && r.sourceId === inv.id && r.status === 'Active')
    .forEach((r) => {
      r.status = 'Fulfilled';
      r.closedAt = new Date().toISOString();
    });
  inv.allocations = allocations;
  inv.cogs = cost;
  activity(
    s,
    'sale',
    'Invoice issued',
    `${inv.number} · ${contact(s, inv.customerId)!.name}`,
    inv.date,
  );
  return inv;
}
function payInvoice(
  s: Workspace,
  id: string,
  amount: NumericInput,
  method = 'Bank transfer',
  date = today(),
) {
  const i = s.invoices.find((x) => x.id === id);
  required(i && i.status !== 'Draft', 'Issue this invoice before recording a payment.');
  amount = moneyCheck(amount);
  required(
    amount > 0 && amount <= invoiceBalance(i),
    'Payment must be positive and cannot exceed the outstanding amount.',
  );
  dateCheck(date);
  required(
    date >= i.date && date <= today(),
    'Payment date must be between the invoice date and today.',
  );
  i.paid = round(i.paid + Number(amount));
  i.payments.push({ id: uid('payment'), amount, date, method });
  ledger(s, date, i.number, 'Customer payment — ' + method, [
    { account: 'cash', debit: amount },
    { account: 'receivable', credit: amount },
  ]);
  activity(s, 'payment', 'Payment received', `${i.number} · ${method}`, date);
}
function deleteDraft(s: Workspace, id: string) {
  required(s.invoices.find((i) => i.id === id)?.status === 'Draft', 'Only drafts can be deleted.');
  releaseInvoiceReservations(s, id);
  s.invoices = s.invoices.filter((i) => i.id !== id);
}
function createPurchase(s: Workspace, data: PurchaseInput) {
  required(contact(s, data.supplierId)?.type === 'Supplier', 'Select a supplier.');
  required(warehouse(s, data.warehouseId), 'Select a receiving warehouse.');
  dateCheck(data.date);
  dateCheck(data.expected);
  required(data.expected >= data.date, 'Expected delivery must be on or after the order date.');
  const lines = normalizedLines(s, data.lines, 'cost');
  const po: Purchase = {
    id: uid('purchase'),
    number: `PO-${String(s.counters.purchase++).padStart(4, '0')}`,
    supplierId: data.supplierId,
    warehouseId: data.warehouseId,
    date: data.date,
    expected: data.expected,
    lines,
    total: sum(lines, (l) => l.qty * l.price),
    paid: 0,
    status: 'Ordered',
    notes: String(data.notes || ''),
  };
  required(po.total > 0, 'Purchase order total must be greater than zero.');
  s.purchases.unshift(po);
  activity(
    s,
    'order',
    'Purchase order created',
    `${po.number} · ${contact(s, po.supplierId)!.name}`,
  );
  return po;
}
function receivePurchase(
  s: Workspace,
  id: string,
  batches: { code: string; expiry: string }[],
  date = today(),
) {
  const po = s.purchases.find((p) => p.id === id);
  required(po && po.status === 'Ordered', 'This purchase order is already received or canceled.');
  dateCheck(date);
  required(
    date >= po.date && date <= today(),
    'Receipt date must be between the order date and today.',
  );
  required(batches.length === po.lines.length, 'Enter batch details for each order line.');
  // Validate all receipts before applying any of them.
  po.lines.forEach((l, i) => {
    const b = batches[i];
    dateCheck(b.expiry);
    required(daysLeft(b.expiry) > 0, 'Every expiry date must be in the future.');
    required(String(b.code || '').trim(), 'Enter every batch number.');
    const existing = s.batches.find(
      (x) =>
        x.productId === l.productId &&
        x.code.toLowerCase() === String(b.code).trim().toLowerCase() &&
        x.warehouseId === po.warehouseId &&
        !x.quarantined,
    );
    required(
      !existing || (existing.expiry === b.expiry && existing.cost === round(l.price / l.factor)),
      'An existing batch has conflicting expiry or cost.',
    );
    for (let j = 0; j < i; j++)
      if (
        po.lines[j].productId === l.productId &&
        String(batches[j].code).trim().toLowerCase() === String(b.code).trim().toLowerCase()
      )
        required(
          batches[j].expiry === b.expiry &&
            round(po.lines[j].price / po.lines[j].factor) === round(l.price / l.factor),
          'Duplicate lot numbers must have matching expiry and cost.',
        );
  });
  po.lines.forEach((l, i) =>
    addBatch(
      s,
      {
        productId: l.productId,
        qty: l.qty * l.factor,
        cost: round(l.price / l.factor),
        warehouseId: po.warehouseId,
        code: batches[i].code,
        expiry: batches[i].expiry,
        received: date,
      },
      { date, reference: po.number, sourceId: po.id, counterpartyId: po.supplierId },
    ),
  );
  const inventoryDebit = sum(po.lines, (l) => round(l.qty * l.factor * round(l.price / l.factor)));
  ledger(
    s,
    date,
    po.number,
    'Purchase receipt — ' +
      contact(s, po.supplierId)!.name +
      (po.total !== inventoryDebit ? ' · Purchase rounding' : ''),
    purchaseEntries(inventoryDebit, po.total, 'payable'),
  );
  po.status = 'Received';
  po.received = date;
  activity(
    s,
    'receive',
    'Purchase order received',
    `${po.number} · ${warehouse(s, po.warehouseId)!.name}`,
    date,
  );
}
function payBill(s: Workspace, id: string, amount: NumericInput, date = today()) {
  const bill = [...s.purchases.filter((p) => p.status === 'Received'), ...s.receipts].find(
    (x) => x.id === id,
  );
  required(bill, 'This supplier bill is not ready for payment.');
  amount = moneyCheck(amount);
  required(
    amount > 0 && amount <= round(bill.total - bill.paid),
    'Payment must be positive and cannot exceed the bill balance.',
  );
  dateCheck(date);
  required(
    date >= (bill.received || bill.date) && date <= today(),
    'Choose a payment date between receipt and today.',
  );
  bill.paid = round(bill.paid + Number(amount));
  ledger(s, date, bill.number || bill.reference || bill.id, 'Supplier payment', [
    { account: 'payable', debit: amount },
    { account: 'cash', credit: amount },
  ]);
  activity(
    s,
    'payment',
    'Supplier payment recorded',
    bill.number || bill.reference || bill.id,
    date,
  );
}
function cancelPurchase(s: Workspace, id: string) {
  const p = s.purchases.find((x) => x.id === id);
  required(p?.status === 'Ordered', 'Only unreceived orders can be canceled.');
  p.status = 'Canceled';
  activity(s, 'order', 'Purchase order canceled', p.number);
}
function addExpense(s: Workspace, data: ExpenseInput) {
  const amount = moneyCheck(data.amount);
  required(amount > 0, 'Expense must be greater than zero.');
  const date = dateCheck(data.date);
  required(date <= today(), 'Expense date cannot be in the future.');
  required(String(data.description || '').trim(), 'Enter an expense description.');
  const e = {
    id: uid('expense'),
    date,
    description: String(data.description).trim(),
    category: data.category || 'Other',
    amount,
    reference:
      String(data.reference || '').trim() ||
      `EXP-${String(s.expenses.length + 1).padStart(3, '0')}`,
  };
  s.expenses.unshift(e);
  ledger(s, date, e.reference, e.description, [
    { account: 'expense', debit: amount },
    { account: 'cash', credit: amount },
  ]);
  activity(s, 'expense', 'Expense recorded', e.description, date);
  return e;
}
function saveContact(s: Workspace, data: ContactInput, id?: string) {
  required(['Customer', 'Supplier'].includes(data.type), 'Select a contact type.');
  required(String(data.name || '').trim().length >= 2, 'Enter a contact name.');
  const c: Contact = {
    id: id || uid('contact'),
    type: data.type,
    name: String(data.name).trim(),
    person: String(data.person || '').trim(),
    email: String(data.email || '').trim(),
    phone: String(data.phone || '').trim(),
    address: String(data.address || '').trim(),
    minShelfLifeDays:
      data.type === 'Supplier' || data.minShelfLifeDays === null || data.minShelfLifeDays === ''
        ? null
        : data.minShelfLifeDays === undefined
          ? id
            ? (contact(s, id)?.minShelfLifeDays ?? null)
            : null
          : shelfLifeCheck(Number(data.minShelfLifeDays)),
  };
  if (id) {
    const old = contact(s, id);
    required(old, 'Contact not found.');
    required(
      old.type === c.type ||
        ![
          ...s.invoices.map((i) => i.customerId),
          ...s.purchases.map((p) => p.supplierId),
          ...s.receipts.map((r) => r.supplierId),
          ...s.products.map((p) => p.supplierId),
        ].includes(id),
      'This contact has transaction history, so its type cannot be changed.',
    );
    s.contacts = s.contacts.map((x) => (x.id === id ? c : x));
  } else s.contacts.push(c);
  return c;
}
function balances(s: Workspace, from = '', to = today()) {
  const b = Object.fromEntries(
    accounts.map((a) => [a.id, { debit: 0, credit: 0, balance: 0 }]),
  ) as Balances;
  s.journal
    .filter((j) => (!from || j.date >= from) && j.date <= to)
    .forEach((j) =>
      j.entries.forEach((e) => {
        b[e.account].debit = round(b[e.account].debit + e.debit);
        b[e.account].credit = round(b[e.account].credit + e.credit);
      }),
    );
  accounts.forEach((a) => {
    b[a.id].balance = round(
      ['Liability', 'Equity', 'Income'].includes(a.type)
        ? b[a.id].credit - b[a.id].debit
        : b[a.id].debit - b[a.id].credit,
    );
  });
  return b;
}
function transact<T>(s: Workspace, fn: (copy: Workspace) => T) {
  const copy: Workspace = structuredClone(s);
  const value = fn(copy);
  return { state: copy, value };
}
function persist(s: Workspace) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
function load(): Workspace {
  const raw = localStorage.getItem(KEY);
  if (raw === null) return seed();
  try {
    return validateBackup(JSON.parse(raw));
  } catch {
    // Preserve the exact input before allowing any mutations to the fresh workspace.
    // If recovery cannot be saved, fail to open rather than risk overwriting the original.
    localStorage.setItem(RECOVERY_KEY, raw);
    return seed();
  }
}
function emptyWorkspace(s: Workspace): Workspace {
  return {
    version: s.version,
    createdAt: s.createdAt,
    settings: structuredClone(s.settings),
    warehouses: structuredClone(s.warehouses),
    counters: {
      invoice: 1,
      purchase: 1,
      transfer: 1,
      adjustment: 1,
      count: 1,
      recall: 1,
      reservation: 1,
    },
    products: [],
    batches: [],
    contacts: [],
    invoices: [],
    purchases: [],
    receipts: [],
    journal: [],
    expenses: [],
    movements: [],
    stockMoves: [],
    adjustments: [],
    stockCounts: [],
    recalls: [],
    reorderRules: [],
    reservations: [],
  };
}
function seed(): Workspace {
  const s: Workspace = {
    version: 2,
    createdAt: today(),
    settings: {
      company: 'Aster Pharmaceuticals',
      address: 'Phnom Penh, Cambodia',
      email: 'hello@asterpharma.com',
      phone: '+855 23 880 420',
      currency: 'USD',
      invoicePrefix: 'INV',
      taxRate: 0,
      expiryWindow: 90,
      minShelfLifeDays: 0,
    },
    counters: {
      invoice: 1024,
      purchase: 208,
      transfer: 1,
      adjustment: 1,
      count: 1,
      recall: 1,
      reservation: 1,
    },
    products: [],
    batches: [],
    invoices: [],
    purchases: [],
    receipts: [],
    expenses: [],
    movements: [],
    stockMoves: [],
    adjustments: [],
    stockCounts: [],
    recalls: [],
    reorderRules: [],
    reservations: [],
    journal: [],
    contacts: [],
    warehouses: [
      {
        id: 'wh_main',
        name: 'Central warehouse',
        address: 'Sen Sok · Phnom Penh',
        capacity: 25000,
        temperature: '15–25°C',
        code: 'WH-01',
        storage: 'ambient',
      },
      {
        id: 'wh_branch',
        name: 'Riverside branch',
        address: 'Daun Penh · Phnom Penh',
        capacity: 12000,
        temperature: '15–25°C',
        code: 'WH-02',
        storage: 'ambient',
      },
      {
        id: 'wh_cold',
        name: 'Cold storage',
        address: 'Sen Sok · Phnom Penh',
        capacity: 6000,
        temperature: '2–8°C',
        code: 'WH-03',
        storage: 'cold',
      },
    ],
  };
  s.contacts = [
    {
      id: 'c1',
      minShelfLifeDays: null,
      type: 'Customer',
      name: 'Greenlife Pharmacy',
      person: 'Sophea Chan',
      email: 'orders@greenlife.example',
      phone: '+855 12 430 882',
      address: 'Toul Kork, Phnom Penh',
    },
    {
      id: 'c2',
      minShelfLifeDays: null,
      type: 'Customer',
      name: 'Wellness Medical Center',
      person: 'Dara Lim',
      email: 'supply@wellness.example',
      phone: '+855 15 782 110',
      address: 'BKK1, Phnom Penh',
    },
    {
      id: 'c3',
      minShelfLifeDays: null,
      type: 'Customer',
      name: 'CarePlus Clinic',
      person: 'Nita Sok',
      email: 'admin@careplus.example',
      phone: '+855 10 223 851',
      address: 'Chbar Ampov, Phnom Penh',
    },
    {
      id: 'c4',
      minShelfLifeDays: null,
      type: 'Customer',
      name: 'Lotus Health Pharmacy',
      person: 'Vanna Chea',
      email: 'orders@lotus.example',
      phone: '+855 17 860 352',
      address: 'Siem Reap, Cambodia',
    },
    {
      id: 'c5',
      minShelfLifeDays: null,
      type: 'Customer',
      name: 'Sunrise Hospital',
      person: 'Sokha Men',
      email: 'pharmacy@sunrise.example',
      phone: '+855 23 912 884',
      address: 'Sen Sok, Phnom Penh',
    },
    {
      id: 's1',
      minShelfLifeDays: null,
      type: 'Supplier',
      name: 'MediCore Distribution',
      person: 'David Tan',
      email: 'sales@medicore.example',
      phone: '+855 23 884 990',
      address: 'Khan Sen Sok, Phnom Penh',
    },
    {
      id: 's2',
      minShelfLifeDays: null,
      type: 'Supplier',
      name: 'BioHealth Pharma',
      person: 'Anna Lee',
      email: 'orders@biohealth.example',
      phone: '+855 23 688 241',
      address: 'Khan Meanchey, Phnom Penh',
    },
    {
      id: 's3',
      minShelfLifeDays: null,
      type: 'Supplier',
      name: 'Pacific Medical Supply',
      person: 'Rithy Sao',
      email: 'team@pacificmed.example',
      phone: '+855 12 851 277',
      address: 'Khan Toul Kork, Phnom Penh',
    },
    {
      id: 's4',
      minShelfLifeDays: null,
      type: 'Supplier',
      name: 'VitaWell Laboratories',
      person: 'Lisa Kim',
      email: 'supply@vitawell.example',
      phone: '+855 15 663 818',
      address: 'Khan Chamkar Mon, Phnom Penh',
    },
  ];
  const specs: [string, string, string, Unit, number, number, number, string, Shape][] = [
    ['Paracetamol 500mg', 'Acetaminophen', 'Pain relief', 'box', 3.2, 5.8, 80, '#74a18c', 'box'],
    [
      'Amoxicillin 500mg',
      'Amoxicillin trihydrate',
      'Antibiotics',
      'box',
      8.5,
      13.8,
      70,
      '#88abc0',
      'box',
    ],
    [
      'Vitamin C 1000mg',
      'Ascorbic acid',
      'Vitamins & supplements',
      'bottle',
      7.4,
      12.5,
      60,
      '#ddb179',
      'bottle',
    ],
    ['Ibuprofen 400mg', 'Ibuprofen', 'Pain relief', 'box', 5.2, 8.9, 60, '#7e9bb6', 'box'],
    [
      'Cetirizine 10mg',
      'Cetirizine hydrochloride',
      'Respiratory',
      'box',
      4.1,
      7.5,
      50,
      '#a59bbf',
      'box',
    ],
    ['Omeprazole 20mg', 'Omeprazole', 'Digestive health', 'box', 6.4, 10.8, 50, '#87a794', 'box'],
    ['Azithromycin 250mg', 'Azithromycin', 'Antibiotics', 'box', 11.2, 17.9, 45, '#b59499', 'box'],
    [
      'Multivitamin Daily',
      'Multivitamin & minerals',
      'Vitamins & supplements',
      'bottle',
      9.8,
      16.4,
      50,
      '#bdaa77',
      'bottle',
    ],
    ['Sterile Gauze 10×10', 'Cotton gauze', 'First aid', 'pack', 2.1, 4.2, 75, '#a6b9a6', 'box'],
    [
      'Digital Thermometer',
      'Electronic thermometer',
      'Medical devices',
      'device',
      4.8,
      9.5,
      35,
      '#84aec0',
      'device',
    ],
    [
      'Salbutamol Inhaler',
      'Salbutamol sulfate',
      'Respiratory',
      'unit',
      7.6,
      12.9,
      40,
      '#97b8bf',
      'bottle',
    ],
    [
      'Oral Rehydration Salts',
      'Glucose & electrolytes',
      'Digestive health',
      'box',
      2.9,
      5.4,
      55,
      '#aaba76',
      'box',
    ],
    [
      'Hydrocortisone 1%',
      'Hydrocortisone cream',
      'Dermatology',
      'tube',
      3.5,
      6.8,
      40,
      '#a6b4bf',
      'tube',
    ],
    [
      'Zinc 20mg',
      'Zinc sulfate',
      'Vitamins & supplements',
      'bottle',
      5.2,
      9.3,
      40,
      '#c2ac81',
      'bottle',
    ],
    [
      'Alcohol Swabs 100s',
      'Isopropyl alcohol 70%',
      'First aid',
      'box',
      1.8,
      3.6,
      60,
      '#8aaec0',
      'box',
    ],
    [
      'Blood Pressure Monitor',
      'Automatic digital monitor',
      'Medical devices',
      'device',
      22.5,
      38,
      20,
      '#95aaad',
      'device',
    ],
    ['Loratadine 10mg', 'Loratadine', 'Respiratory', 'box', 4.4, 7.8, 35, '#b4a2c4', 'box'],
    [
      'Diclofenac Gel 1%',
      'Diclofenac sodium',
      'Pain relief',
      'tube',
      4.6,
      8.5,
      45,
      '#8daec3',
      'tube',
    ],
    [
      'Probiotic Capsules',
      'Lactobacillus blend',
      'Digestive health',
      'bottle',
      10.5,
      18.9,
      40,
      '#b5b984',
      'bottle',
    ],
    [
      'Vitamin D3 1000IU',
      'Cholecalciferol',
      'Vitamins & supplements',
      'bottle',
      6.1,
      10.8,
      50,
      '#cfb087',
      'bottle',
    ],
    [
      'Cefixime 200mg',
      'Cefixime trihydrate',
      'Antibiotics',
      'box',
      12.6,
      19.8,
      30,
      '#9cabbf',
      'box',
    ],
    [
      'Surgical Masks 50s',
      '3-ply medical mask',
      'First aid',
      'box',
      2.5,
      4.9,
      100,
      '#89b7ad',
      'box',
    ],
    [
      'Pulse Oximeter',
      'Fingertip oxygen monitor',
      'Medical devices',
      'device',
      8.4,
      15.9,
      25,
      '#93a9b8',
      'device',
    ],
    [
      'Clotrimazole 1%',
      'Clotrimazole cream',
      'Dermatology',
      'tube',
      3.8,
      7.2,
      35,
      '#b8a993',
      'tube',
    ],
    [
      'Insulin Storage Kit',
      'Temperature-controlled kit',
      'Medical devices',
      'unit',
      18.5,
      29.9,
      20,
      '#90b3ba',
      'box',
    ],
    [
      'Calcium + D3',
      'Calcium carbonate & D3',
      'Vitamins & supplements',
      'bottle',
      8.4,
      14.5,
      45,
      '#b5b896',
      'bottle',
    ],
    [
      'Povidone-Iodine 10%',
      'Povidone-iodine solution',
      'First aid',
      'bottle',
      3.1,
      6.2,
      35,
      '#c3997c',
      'bottle',
    ],
    [
      'Antacid Suspension',
      'Aluminum & magnesium',
      'Digestive health',
      'bottle',
      4.9,
      8.6,
      40,
      '#9db7ab',
      'bottle',
    ],
  ];
  specs.forEach((a, i) => {
    let p: Product = {
      id: 'p' + (i + 1),
      name: a[0],
      generic: a[1],
      category: a[2],
      unit: a[3],
      packs: [],
      cost: a[4],
      price: a[5],
      reorder: a[6],
      color: a[7],
      shape: a[8],
      sku: 'AST-' + String(i + 1).padStart(4, '0'),
      barcode: '885009' + String(i + 1).padStart(7, '0'),
      supplierId: 's' + ((i % 4) + 1),
      registrationNo: '',
      manufacturer: '',
      dosageForm: a[3] === 'device' ? 'device' : 'other',
      strength: '',
      rx: false,
      controlled: false,
      storage: 'ambient',
      nameKm: '',
      active: true,
    };
    s.products.push(p);
    const forms: DosageForm[] = [
      'tablet',
      'capsule',
      'tablet',
      'tablet',
      'tablet',
      'capsule',
      'tablet',
      'tablet',
      'other',
      'device',
      'inhaler',
      'powder',
      'cream',
      'tablet',
      'other',
      'device',
      'tablet',
      'cream',
      'capsule',
      'tablet',
      'capsule',
      'other',
      'device',
      'cream',
      'device',
      'tablet',
      'solution',
      'suspension',
    ];
    const strengths = [
      '500 mg',
      '500 mg',
      '1000 mg',
      '400 mg',
      '10 mg',
      '20 mg',
      '250 mg',
      'Daily formula',
      '',
      '',
      '100 mcg/dose',
      'WHO formula',
      '1%',
      '20 mg',
      '',
      '',
      '10 mg',
      '1%',
      '10 billion CFU',
      '1000 IU',
      '200 mg',
      '',
      '',
      '1%',
      '',
      '600 mg / 400 IU',
      '10%',
      '200 mg / 200 mg per 5 ml',
    ];
    p = saveProduct(
      s,
      {
        ...p,
        registrationNo:
          ['device', 'other'].includes(forms[i]) || [13, 19].includes(i)
            ? ''
            : `REG-${String(i + 1).padStart(5, '0')}`,
        manufacturer: 'Aster Pharma Manufacturing',
        dosageForm: forms[i],
        strength: strengths[i],
        rx: [1, 6, 10, 20].includes(i),
      },
      p.id,
    );
    const packaging: Record<string, { unit: Unit; factor: number; price?: number }> = {
      p1: { unit: 'carton', factor: 50, price: 280 },
      p2: { unit: 'carton', factor: 40 },
      p3: { unit: 'case', factor: 24 },
      p22: { unit: 'carton', factor: 40 },
      p9: { unit: 'carton', factor: 100 },
    };
    if (packaging[p.id])
      saveProduct(
        s,
        {
          ...p,
          packs: [
            {
              ...packaging[p.id],
              barcode: '885019' + String(i + 1).padStart(7, '0'),
            },
          ],
        },
        p.id,
      );
    const isLow = [1, 9, 14, 20].includes(i),
      q = isLow ? 19 + i : 460 + i * 21;
    addBatch(
      s,
      {
        productId: p.id,
        code: `BT-26${String(i + 1).padStart(3, '0')}A`,
        qty: q,
        cost: p.cost,
        expiry: shift([2, 5, 12, 18].includes(i) ? 25 + i : 240 + i * 8),
        warehouseId: i === 24 ? 'wh_cold' : 'wh_main',
        received: shift(-200),
      },
      { allowExpired: true, moveType: 'opening', date: shift(-200) },
    );
    if (!isLow)
      addBatch(
        s,
        {
          productId: p.id,
          code: `BT-26${String(i + 1).padStart(3, '0')}B`,
          qty: 180 + i * 8,
          cost: p.cost,
          expiry: shift(480 + i * 5),
          warehouseId: i === 24 ? 'wh_cold' : 'wh_branch',
          received: shift(-190),
        },
        { allowExpired: true, moveType: 'opening', date: shift(-190) },
      );
  });
  addBatch(
    s,
    {
      productId: 'p9',
      code: 'BT-OLD-009',
      qty: 26,
      cost: 2.1,
      expiry: shift(-12),
      warehouseId: 'wh_main',
      received: shift(-350),
    },
    { allowExpired: true, moveType: 'opening', date: shift(-350) },
  );
  addBatch(
    s,
    {
      productId: 'p17',
      code: 'BT-QA-017',
      qty: 18,
      cost: 4.4,
      expiry: shift(300),
      warehouseId: 'wh_main',
      received: shift(-18),
      quarantined: true,
    },
    { moveType: 'opening', date: shift(-18) },
  );
  ledger(s, shift(-210), 'OPENING', 'Opening balances', [
    { account: 'inventory', debit: inventoryValue(s) },
    { account: 'cash', debit: 28000 },
    { account: 'equity', credit: round(inventoryValue(s) + 28000) },
  ]);
  for (let n = 0; n < 6; n++) {
    const date = shift(-130 + n * 22),
      lines: LineInput[] = [
        n === 0
          ? { productId: 'p1', qty: 3, unit: 'carton', cost: 160 }
          : { productId: 'p' + (n + 1), qty: 120 + n * 12, cost: specs[n][4] },
        { productId: 'p' + (n + 8), qty: 90, cost: specs[n + 7][4] },
      ];
    const po = createPurchase(s, {
      supplierId: 's' + ((n % 4) + 1),
      warehouseId: 'wh_main',
      date,
      expected: shift(5, date),
      lines,
    });
    receivePurchase(
      s,
      po.id,
      po.lines.map((_, i) => ({ code: `RC-${n + 1}-${i + 1}`, expiry: shift(430 + n * 10) })),
      shift(4, date),
    );
    if (n < 4) payBill(s, po.id, po.total, shift(7, date));
  }
  const sellIds = s.products
    .filter((p) => !['p2', 'p10', 'p15', 'p21'].includes(p.id))
    .map((p) => p.id);
  for (let n = 0; n < 62; n++) {
    const date = shift(-177 + n * 3),
      lines: LineInput[] = [0, 1, 2].map((k) => {
        const p = product(s, sellIds[(n * 2 + k * 5) % sellIds.length])!;
        return { productId: p.id, qty: 6 + ((n * 7 + k * 11) % 25), price: p.price };
      });
    if (n < 2)
      lines.push({
        productId: 'p1',
        qty: 1,
        unit: 'carton',
        price: unitPrice(product(s, 'p1')!, 'carton'),
      });
    const inv = createInvoice(s, {
      allowShortDated: true,
      customerId: 'c' + ((n % 5) + 1),
      date: date > today() ? today() : date,
      due: shift(30, date > today() ? today() : date),
      lines,
      discount: n % 6 === 0 ? 6 : 0,
      taxRate: 0,
      notes: 'Thank you for your business. Please include the invoice number with your payment.',
    });
    issueInvoice(s, inv.id);
    if (n < 48 || n % 3 === 0)
      payInvoice(
        s,
        inv.id,
        inv.total,
        'Bank transfer',
        date > today() ? today() : shift(2, date) > today() ? today() : shift(2, date),
      );
    else if (n % 4 === 0)
      payInvoice(s, inv.id, round(inv.total / 2), 'Cash', date > today() ? today() : date);
  }
  for (let n = 0; n < 6; n++) {
    addExpense(s, {
      date: shift(-145 + n * 28),
      amount: 980 + n * 45,
      description: 'Warehouse rent & utilities',
      category: 'Rent & utilities',
    });
    addExpense(s, {
      date: shift(-140 + n * 28),
      amount: 245 + n * 14,
      description: 'Delivery & distribution',
      category: 'Logistics',
    });
  }
  createPurchase(s, {
    supplierId: 's2',
    warehouseId: 'wh_main',
    date: shift(-3),
    expected: shift(3),
    lines: [
      { productId: 'p2', qty: 200, cost: 8.5 },
      { productId: 'p10', qty: 80, cost: 4.8 },
    ],
    notes: 'Priority replenishment for low-stock products.',
  });
  createPurchase(s, {
    supplierId: 's3',
    warehouseId: 'wh_branch',
    date: shift(-1),
    expected: shift(5),
    lines: [
      { productId: 'p15', qty: 250, cost: 1.8 },
      { productId: 'p21', qty: 100, cost: 12.6 },
    ],
  });
  createInvoice(s, {
    customerId: 'c4',
    date: today(),
    due: shift(30),
    lines: [
      { productId: 'p1', qty: 30, price: 5.8 },
      { productId: 'p3', qty: 15, price: 12.5 },
    ],
    discount: 0,
    taxRate: 0,
    notes: 'Pending confirmation from customer.',
  });
  transferStock(s, {
    batchId: s.batches.find(
      (b) => b.productId === 'p1' && b.warehouseId === 'wh_main' && b.qty >= 24,
    )!.id,
    to: 'wh_branch',
    qty: 24,
  });
  activity(
    s,
    'adjust',
    'Quality review pending',
    'BT-QA-017 · Quarantined for packaging inspection',
  );
  const adjustmentBatch = (productId: string) =>
    s.batches.find((b) => b.productId === productId && b.qty >= 10 && !b.quarantined)!;
  adjustStock(s, {
    batchId: adjustmentBatch('p1').id,
    qty: -3,
    reason: 'damaged',
    date: shift(-55),
    note: 'Crushed cartons during handling.',
  });
  adjustStock(s, {
    batchId: adjustmentBatch('p3').id,
    qty: -4,
    reason: 'damaged',
    date: shift(-41),
    note: 'Bottle seals damaged in storage.',
  });
  adjustStock(s, { batchId: adjustmentBatch('p22').id, qty: -2, reason: 'lost', date: shift(-28) });
  adjustStock(s, {
    batchId: adjustmentBatch('p1').id,
    qty: 5,
    reason: 'found',
    date: shift(-17),
    note: 'Boxes recovered from an incorrectly labelled shelf.',
  });
  adjustStock(s, {
    batchId: adjustmentBatch('p9').id,
    qty: -6,
    reason: 'sample',
    date: shift(-6),
    note: 'Samples supplied to a pharmacy partner.',
  });
  const expired = s.batches.find((b) => b.code === 'BT-OLD-009')!;
  adjustStock(s, { batchId: expired.id, qty: -expired.qty, reason: 'expired', date: shift(-3) });
  const countDate = shift(-20) + 'T18:00:00.000Z';
  const count = startCount(
    s,
    { warehouseId: 'wh_branch', note: 'Monthly shelf count after closing.' },
    countDate,
  );
  count.lines.forEach((line, index) =>
    recordCount(
      s,
      count.id,
      line.batchId,
      line.expected + (index === 0 ? -3 : index === 1 ? 1 : 0),
    ),
  );
  postCount(s, count.id, countDate, shift(-20));
  const insulin = saveProduct(s, {
    ...product(s, 'p1')!,
    name: 'Insulin Glargine 100 IU/ml',
    sku: 'AST-0029',
    barcode: '8850090000029',
    packs: [],
    generic: 'Insulin glargine',
    category: 'First aid',
    unit: 'vial',
    registrationNo: 'REG-00029',
    manufacturer: 'Aster Biologics',
    dosageForm: 'injection',
    strength: '100 IU/ml',
    rx: true,
    storage: 'cold',
    cost: 12,
    price: 19,
    shape: 'bottle',
  });
  receiveStock(s, {
    productId: insulin.id,
    warehouseId: 'wh_cold',
    qty: 80,
    cost: 12,
    code: 'IG-26001',
    expiry: shift(300),
    supplierId: 's1',
    payment: 'credit',
  });
  const diazepam = saveProduct(s, {
    ...product(s, 'p1')!,
    name: 'Diazepam 5 mg',
    sku: 'AST-0030',
    barcode: '8850090000030',
    packs: [],
    generic: 'Diazepam',
    registrationNo: 'REG-00030',
    manufacturer: 'Aster Pharma Manufacturing',
    dosageForm: 'tablet',
    strength: '5 mg',
    rx: true,
    controlled: true,
    cost: 3,
    price: 6,
  });
  receiveStock(s, {
    productId: diazepam.id,
    warehouseId: 'wh_main',
    qty: 100,
    cost: 3,
    code: 'DZ-26001',
    expiry: shift(400),
    supplierId: 's1',
    payment: 'credit',
  });
  for (const qty of [12, 8]) {
    const invoice = createInvoice(s, {
      customerId: 'c1',
      date: today(),
      due: shift(30),
      lines: [{ productId: diazepam.id, qty }],
    });
    issueInvoice(s, invoice.id);
  }
  s.products.forEach((p) =>
    saveReorderRule(s, {
      productId: p.id,
      warehouseId: 'wh_main',
      min: p.reorder,
      max: p.reorder * 4,
    }),
  );
  s.products.slice(0, 8).forEach((p) => {
    const min = Math.max(
      p.reorder,
      available(s, p.id, 'wh_branch') + onOrder(s, p.id, 'wh_branch'),
    );
    saveReorderRule(s, { productId: p.id, warehouseId: 'wh_branch', min, max: min * 4 });
  });
  const retired = product(s, 'p23')!;
  s.batches
    .filter((b) => b.productId === retired.id && b.qty > 0)
    .forEach((b) =>
      adjustStock(s, {
        batchId: b.id,
        qty: -b.qty,
        reason: 'other',
        note: 'Retiring the previous oximeter model; remaining units removed from sale.',
      }),
    );
  saveProduct(s, { ...retired, active: false }, retired.id);
  const customersByLot = new Map<
    string,
    { productId: string; lotCode: string; customers: Set<string> }
  >();
  s.stockMoves
    .filter((m) => m.type === 'sale')
    .forEach((m) => {
      const key = JSON.stringify([m.productId, m.lotCode.toLowerCase()]);
      const lot = customersByLot.get(key) || {
        productId: m.productId,
        lotCode: m.lotCode,
        customers: new Set<string>(),
      };
      lot.customers.add(m.counterpartyId || '');
      customersByLot.set(key, lot);
    });
  const lot = [...customersByLot.values()].sort((a, b) => b.customers.size - a.customers.size)[0];
  createRecall(s, { ...lot, reason: 'Supplier notice: packaging seal defect' });
  const other = s.batches.find((b) => b.qty > 0 && !isRecalled(s, b))!;
  const closed = createRecall(s, {
    productId: other.productId,
    lotCode: other.code,
    reason: 'Supplier notice: damaged outer packaging',
  });
  recallTrace(s, closed.id).onHand.forEach((b) =>
    adjustStock(s, { batchId: b.batchId, qty: -b.qty, reason: 'recall' }),
  );
  closeRecall(s, closed.id);
  for (const c of s.contacts.filter((c) => c.type === 'Customer'))
    saveContact(
      s,
      {
        ...c,
        minShelfLifeDays:
          c.name === 'Sunrise Hospital' ? 365 : c.name === 'CarePlus Clinic' ? 90 : null,
      },
      c.id,
    );
  setMinShelfLife(s, 180);
  reserveInvoice(s, s.invoices.find((i) => i.status === 'Draft')!.id);
  holdStock(s, {
    productId: 'p1',
    customerId: 'c1',
    qty: 2 * unitFactor(product(s, 'p1')!, 'carton'),
    expires: shift(2),
    note: 'Phone order; collect in two days.',
  });
  const expiredHold = holdStock(s, {
    productId: 'p3',
    customerId: 'c2',
    qty: 5,
    note: 'Collection was due yesterday.',
  });
  // Historical sample: create through the operation, then age the hold for lazy expiry.
  expiredHold.expires = shift(-1);
  const releasedHold = holdStock(s, {
    productId: 'p3',
    customerId: 'c1',
    qty: 3,
    note: 'Customer cancelled the collection.',
  });
  releaseReservation(s, releasedHold.id);
  return s;
}
function migrate(raw: unknown): Workspace {
  required(typeof raw === 'object' && raw !== null, 'This is not a supported Aster backup.');
  const legacy = raw as { version?: number };
  required(legacy.version === 1 || legacy.version === 2, 'This is not a supported Aster backup.');
  const s = raw as Workspace;
  required(Array.isArray(s.batches), 'Backup is missing batches.');
  required(s.counters, 'Backup settings are missing.');
  if (s.stockMoves === undefined) {
    s.stockMoves = s.batches
      .filter((b) => b.qty > 0)
      .map((b) => ({
        id: uid('sm'),
        date: today(),
        at: new Date().toISOString(),
        batchId: b.id,
        productId: b.productId,
        warehouseId: b.warehouseId,
        lotCode: b.code,
        qty: b.qty,
        unitCost: b.cost,
        type: 'opening',
        reference: 'MIGRATION',
        user: 'system',
      }));
  }
  if (s.counters.transfer === undefined) s.counters.transfer = 1;
  if (s.counters.adjustment === undefined) s.counters.adjustment = 1;
  if (s.adjustments === undefined) s.adjustments = [];
  if (s.stockCounts === undefined) s.stockCounts = [];
  if (s.counters.count === undefined) s.counters.count = 1;
  if (s.counters.recall === undefined) s.counters.recall = 1;
  if (s.recalls === undefined) s.recalls = [];
  if (s.reorderRules === undefined) s.reorderRules = [];
  if (s.reservations === undefined) s.reservations = [];
  if (s.counters.reservation === undefined) s.counters.reservation = 1;
  if (s.settings?.minShelfLifeDays === undefined && s.settings) s.settings.minShelfLifeDays = 180;
  if (Array.isArray(s.contacts))
    s.contacts.forEach((c) => {
      if (c.minShelfLifeDays === undefined) c.minShelfLifeDays = null;
    });
  if (Array.isArray(s.invoices))
    s.invoices.forEach((i) => {
      if (i.allowShortDated === undefined) i.allowShortDated = false;
    });
  if (Array.isArray(s.warehouses))
    s.warehouses.forEach((w) => {
      if (w.storage === undefined) w.storage = w.temperature?.includes('2–8') ? 'cold' : 'ambient';
    });
  if (Array.isArray(s.products))
    s.products.forEach((p) => {
      if (p.packs === undefined) p.packs = [];
      for (const key of ['registrationNo', 'manufacturer', 'strength', 'nameKm'] as const)
        if (p[key] === undefined) p[key] = '';
      if (p.dosageForm === undefined) p.dosageForm = p.unit === 'device' ? 'device' : 'other';
      if (p.rx === undefined) p.rx = false;
      if (p.controlled === undefined) p.controlled = false;
      if (p.active === undefined) p.active = true;
      if (p.storage === undefined) {
        const stock = s.batches.filter((b) => b.productId === p.id && b.qty > 0);
        p.storage =
          stock.length && stock.every((b) => warehouse(s, b.warehouseId)?.storage === 'cold')
            ? 'cold'
            : 'ambient';
      }
    });
  for (const documents of [s.invoices, s.purchases]) {
    if (Array.isArray(documents))
      documents.forEach((d) => {
        if (Array.isArray(d.lines))
          d.lines.forEach((l) => {
            if (l.factor === undefined) l.factor = 1;
          });
      });
  }
  s.version = 2;
  return s;
}
function validateBackup(value: unknown): Workspace {
  required(typeof value === 'object' && value !== null, 'This is not a supported Aster backup.');
  const s = migrate(value);
  for (const key of [
    'products',
    'batches',
    'invoices',
    'purchases',
    'receipts',
    'journal',
    'contacts',
    'warehouses',
    'movements',
    'expenses',
    'stockMoves',
    'adjustments',
    'stockCounts',
    'recalls',
    'reorderRules',
    'reservations',
  ])
    required(Array.isArray(s[key as keyof Workspace]), 'Backup is missing ' + key + '.');
  required(s.settings && s.counters, 'Backup settings are missing.');
  const ids: Record<string, Set<string>> = {};
  (
    [
      'products',
      'batches',
      'contacts',
      'warehouses',
      'invoices',
      'purchases',
      'adjustments',
      'stockCounts',
      'recalls',
      'reservations',
    ] as const
  ).forEach((key) => {
    ids[key] = new Set();
    s[key].forEach((x) => {
      required(x.id && !ids[key].has(x.id), 'Backup contains duplicate or missing identifiers.');
      ids[key].add(x.id);
    });
  });
  s.contacts.forEach((c) =>
    required(
      typeof c.name === 'string' && ['Customer', 'Supplier'].includes(c.type),
      'Backup contains an invalid contact.',
    ),
  );
  const reorderPairs = new Set<string>();
  const reservationNumbers = new Set<string>();
  s.reservations.forEach((r) => {
    required(
      ids.products.has(r.productId) && contact(s, r.customerId)?.type === 'Customer',
      'Backup contains an unknown reservation product or customer.',
    );
    required(
      Number.isSafeInteger(r.qty) &&
        r.qty > 0 &&
        ['hold', 'invoice'].includes(r.source) &&
        ['Active', 'Released', 'Fulfilled'].includes(r.status) &&
        typeof r.number === 'string' &&
        /^RSV-\d{4,}$/.test(r.number) &&
        !reservationNumbers.has(r.number) &&
        typeof r.note === 'string' &&
        typeof r.createdBy === 'string' &&
        r.createdBy &&
        typeof r.createdAt === 'string' &&
        !isNaN(new Date(r.createdAt).getTime()),
      'Backup contains an invalid reservation.',
    );
    reservationNumbers.add(r.number);
    if (r.source === 'hold') {
      dateCheck(r.expires!);
      required(r.sourceId === undefined, 'Backup contains an invalid hold reference.');
    } else {
      const invoice = s.invoices.find((i) => i.id === r.sourceId);
      // Released history survives draft deletion; live promises always need an invoice.
      required(
        typeof r.sourceId === 'string' &&
          r.sourceId &&
          (invoice ? ['Draft', 'Issued'].includes(invoice.status) : r.status === 'Released'),
        'Backup contains an invalid reservation invoice.',
      );
      required(
        !invoice || invoice.status !== 'Issued' || r.status !== 'Active',
        'Issued invoices cannot have Active reservations.',
      );
      required(r.expires === undefined, 'Invoice reservations cannot have an expiry.');
    }
    if (r.status !== 'Active')
      required(
        typeof r.closedAt === 'string' && !isNaN(new Date(r.closedAt).getTime()),
        'Closed reservations must have a valid closedAt.',
      );
  });
  s.reorderRules.forEach((r) => {
    checkReorderRule(s, r);
    const key = JSON.stringify([r.productId, r.warehouseId]);
    required(!reorderPairs.has(key), 'Backup contains duplicate reorder rules.');
    reorderPairs.add(key);
  });
  shelfLifeCheck(s.settings.minShelfLifeDays);
  s.contacts.forEach((c) => {
    if (c.minShelfLifeDays !== null) shelfLifeCheck(c.minShelfLifeDays);
  });
  s.invoices.forEach((i) =>
    required(typeof i.allowShortDated === 'boolean', 'Allow short-dated stock must be a boolean.'),
  );
  const openLots = new Set<string>(),
    recallNumbers = new Set<string>();
  s.recalls.forEach((r) => {
    required(ids.products.has(r.productId), 'Backup contains an unknown recall product.');
    required(
      ['Open', 'Closed'].includes(r.status) &&
        typeof r.lotCode === 'string' &&
        r.lotCode.trim() &&
        typeof r.reason === 'string' &&
        r.reason.trim() &&
        typeof r.note === 'string' &&
        typeof r.createdBy === 'string' &&
        r.createdBy &&
        typeof r.number === 'string' &&
        /^RCL-\d{4,}$/.test(r.number) &&
        !recallNumbers.has(r.number),
      'Backup contains an invalid recall.',
    );
    dateCheck(r.date);
    recallNumbers.add(r.number);
    if (r.status === 'Closed')
      required(
        typeof r.closedAt === 'string' && !isNaN(new Date(r.closedAt).getTime()),
        'Backup contains an invalid closed recall.',
      );
    if (r.status === 'Open') {
      const key = JSON.stringify([r.productId, r.lotCode.toLowerCase()]);
      required(!openLots.has(key), 'Backup contains multiple Open recalls for a lot.');
      openLots.add(key);
    }
  });
  s.warehouses.forEach((w) =>
    required(
      typeof w.name === 'string' &&
        Number.isFinite(w.capacity) &&
        w.capacity > 0 &&
        storageTypes.includes(w.storage),
      'Backup contains an invalid warehouse.',
    ),
  );
  required(
    typeof s.settings.company === 'string' &&
      /^[A-Z0-9-]{1,12}$/.test(s.settings.invoicePrefix) &&
      Number.isInteger(s.settings.expiryWindow) &&
      s.settings.expiryWindow >= 1 &&
      s.settings.expiryWindow <= 365,
    'Invalid company settings in backup.',
  );
  required(
    Number.isSafeInteger(s.counters.invoice) &&
      s.counters.invoice > 0 &&
      Number.isSafeInteger(s.counters.purchase) &&
      s.counters.purchase > 0 &&
      Number.isSafeInteger(s.counters.transfer) &&
      s.counters.transfer > 0 &&
      Number.isSafeInteger(s.counters.adjustment) &&
      s.counters.adjustment > 0 &&
      Number.isSafeInteger(s.counters.count) &&
      s.counters.count > 0 &&
      Number.isSafeInteger(s.counters.recall) &&
      s.counters.recall > 0 &&
      Number.isSafeInteger(s.counters.reservation) &&
      s.counters.reservation > 0,
    'Invalid record counters in backup.',
  );
  s.products.forEach((p) => required(Array.isArray(p.packs), 'Product packaging is missing.'));
  s.products.forEach((p) => {
    required(
      typeof p.name === 'string' &&
        typeof p.sku === 'string' &&
        units.includes(p.unit) &&
        Number.isSafeInteger(p.reorder) &&
        p.reorder >= 0 &&
        categories.includes(p.category),
      'Backup contains an invalid product.',
    );
    moneyCheck(p.cost);
    moneyCheck(p.price);
    validatePacks(s, p);
    validatePharma(s, p);
  });
  s.batches.forEach((b) => {
    required(
      ids.products.has(b.productId) && ids.warehouses.has(b.warehouseId),
      'Backup contains an unknown batch reference.',
    );
    required(
      Number.isSafeInteger(b.qty) && b.qty >= 0,
      'Backup contains an invalid batch quantity.',
    );
    moneyCheck(b.cost);
    dateCheck(b.expiry);
    const p = product(s, b.productId)!;
    required(
      !b.qty || p.storage !== 'cold' || warehouse(s, b.warehouseId)?.storage === 'cold',
      `${p.name} must be stored at 2–8°C. Choose a cold-storage warehouse.`,
    );
  });
  const moveIds = new Set<string>(),
    quantities = new Map<string, number>();
  s.stockMoves.forEach((m) => {
    required(m.id && !moveIds.has(m.id), 'Backup contains duplicate or missing identifiers.');
    moveIds.add(m.id);
    const batch = s.batches.find((b) => b.id === m.batchId);
    required(
      batch &&
        ids.products.has(m.productId) &&
        ids.warehouses.has(m.warehouseId) &&
        batch.productId === m.productId &&
        batch.warehouseId === m.warehouseId &&
        batch.code === m.lotCode,
      'Backup contains an unknown stock move reference.',
    );
    required(
      Number.isSafeInteger(m.qty) && m.qty !== 0,
      'Backup contains an invalid stock move quantity.',
    );
    dateCheck(m.date);
    moneyCheck(m.unitCost);
    required(
      ['opening', 'receipt', 'sale', 'transfer_out', 'transfer_in', 'adjustment'].includes(
        m.type,
      ) &&
        typeof m.reference === 'string' &&
        m.reference.length > 0 &&
        typeof m.user === 'string' &&
        m.user.length > 0 &&
        typeof m.at === 'string' &&
        !isNaN(new Date(m.at).getTime()),
      'Backup contains an invalid stock move.',
    );
    quantities.set(m.batchId, (quantities.get(m.batchId) || 0) + m.qty);
  });
  s.batches.forEach((b) =>
    required(
      b.qty === (quantities.get(b.id) || 0),
      'Backup batch quantities do not match the stock ledger.',
    ),
  );
  const adjustmentNumbers = new Set<string>();
  s.adjustments.forEach((a) => {
    const batch = s.batches.find((b) => b.id === a.batchId);
    required(
      batch &&
        ids.products.has(a.productId) &&
        ids.warehouses.has(a.warehouseId) &&
        batch.productId === a.productId &&
        batch.warehouseId === a.warehouseId &&
        batch.code === a.lotCode,
      'Backup contains an unknown adjustment reference.',
    );
    required(
      Number.isSafeInteger(a.qty) && a.qty !== 0,
      'Backup contains an invalid adjustment quantity.',
    );
    moneyCheck(a.unitCost);
    moneyCheck(Math.abs(a.value));
    required(a.value === round(a.qty * a.unitCost), 'Backup contains an invalid adjustment value.');
    required(
      a.sourceId === undefined || typeof a.sourceId === 'string',
      'Backup contains an invalid adjustment source.',
    );
    required(
      Object.hasOwn(adjustmentReasons, a.reason) &&
        (a.reason !== 'count' || a.sourceId?.trim()) &&
        adjustmentReasonsFor(a.qty, a.sourceId).includes(a.reason),
      'Backup contains an invalid adjustment reason.',
    );
    required(
      typeof a.note === 'string' && (!['other', 'found'].includes(a.reason) || a.note.trim()),
      'Backup contains an invalid adjustment note.',
    );
    dateCheck(a.date);
    required(a.date <= today(), 'Adjustment date cannot be in the future.');
    required(
      typeof a.number === 'string' &&
        /^ADJ-\d{4,}$/.test(a.number) &&
        !adjustmentNumbers.has(a.number) &&
        typeof a.user === 'string' &&
        a.user.length > 0,
      'Backup contains an invalid adjustment.',
    );
    adjustmentNumbers.add(a.number);
    const moves = s.stockMoves.filter((m) => m.sourceId === a.id);
    required(
      moves.length === 1 &&
        moves[0].qty === a.qty &&
        moves[0].type === 'adjustment' &&
        moves[0].batchId === a.batchId &&
        moves[0].productId === a.productId &&
        moves[0].warehouseId === a.warehouseId &&
        moves[0].lotCode === a.lotCode &&
        moves[0].reference === a.number &&
        moves[0].date === a.date &&
        moves[0].unitCost === a.unitCost &&
        moves[0].reason === a.reason &&
        moves[0].user === a.user,
      'Backup adjustment does not match its stock move.',
    );
  });
  const openWarehouses = new Set<string>(),
    countNumbers = new Set<string>();
  s.stockCounts.forEach((c) => {
    required(ids.warehouses.has(c.warehouseId), 'Backup contains an unknown count warehouse.');
    required(
      ['Open', 'Posted', 'Canceled'].includes(c.status) &&
        typeof c.number === 'string' &&
        /^SC-\d{4,}$/.test(c.number) &&
        !countNumbers.has(c.number) &&
        typeof c.blind === 'boolean' &&
        typeof c.note === 'string' &&
        typeof c.createdBy === 'string' &&
        c.createdBy.length &&
        typeof c.createdAt === 'string' &&
        !isNaN(new Date(c.createdAt).getTime()) &&
        Array.isArray(c.categories) &&
        c.categories.every((category) => categories.includes(category)) &&
        Array.isArray(c.lines) &&
        c.lines.length,
      'Backup contains an invalid stock count.',
    );
    countNumbers.add(c.number);
    if (c.status === 'Open') {
      required(
        !openWarehouses.has(c.warehouseId),
        'Backup contains multiple Open counts for a warehouse.',
      );
      openWarehouses.add(c.warehouseId);
    }
    if (c.status === 'Posted')
      required(
        typeof c.postedAt === 'string' &&
          !isNaN(new Date(c.postedAt).getTime()) &&
          typeof c.postedBy === 'string' &&
          c.postedBy.length,
        'Backup contains an invalid posted stock count.',
      );
    const batchIds = new Set<string>();
    c.lines.forEach((l) => {
      const batch = s.batches.find((b) => b.id === l.batchId);
      required(
        batch &&
          batch.warehouseId === c.warehouseId &&
          batch.productId === l.productId &&
          batch.code === l.lotCode &&
          batch.expiry === l.expiry &&
          !batchIds.has(l.batchId),
        'Backup contains an invalid count line reference.',
      );
      batchIds.add(l.batchId);
      required(
        Number.isSafeInteger(l.expected) &&
          l.expected >= 0 &&
          (l.counted === null || (Number.isSafeInteger(l.counted) && l.counted >= 0)),
        'Backup contains an invalid count quantity.',
      );
      required(
        c.status !== 'Posted' || l.counted !== null,
        'Backup contains uncounted lines in a Posted count.',
      );
      required(
        c.status !== 'Open' || batch.qty === l.expected,
        'Backup stock changed during an Open count.',
      );
    });
  });
  s.journal.forEach((j) => {
    dateCheck(j.date);
    required(Array.isArray(j.entries), 'Invalid journal.');
    j.entries.forEach((e) => {
      required(
        accounts.some((a) => a.id === e.account),
        'Unknown account in backup.',
      );
      moneyCheck(e.debit);
      moneyCheck(e.credit);
    });
    required(
      sum(j.entries, (e) => e.debit) === sum(j.entries, (e) => e.credit),
      'Backup contains an unbalanced journal.',
    );
  });
  s.invoices.forEach((i) => {
    required(
      contact(s, i.customerId)?.type === 'Customer' &&
        Array.isArray(i.lines) &&
        i.lines.length &&
        ['Draft', 'Issued'].includes(i.status) &&
        Array.isArray(i.payments) &&
        Array.isArray(i.allocations),
      'Invalid invoice in backup.',
    );
    dateCheck(i.date);
    dateCheck(i.due);
    moneyCheck(i.total);
    moneyCheck(i.paid);
    required(i.paid <= i.total && i.paid >= 0, 'Invalid invoice payment balance.');
    i.lines.forEach((l) => {
      required(
        ids.products.has(l.productId) && typeof l.name === 'string' && typeof l.sku === 'string',
        'Unknown invoice product.',
      );
      qtyCheck(l.qty);
      moneyCheck(l.price);
      required(
        units.includes(l.unit) &&
          Number.isSafeInteger(l.factor) &&
          l.factor >= 1 &&
          Number.isSafeInteger(l.qty * l.factor),
        'Invalid invoice line unit or factor.',
      );
    });
    const t = totals(i.lines, i.discount, i.taxRate);
    required(
      t.subtotal === i.subtotal && t.taxAmount === i.taxAmount && t.total === i.total,
      'Invoice totals do not match its items.',
    );
    required(
      sum(i.payments, (p) => p.amount) === i.paid,
      'Invoice payments do not match the paid balance.',
    );
    i.payments.forEach((p) => {
      moneyCheck(p.amount);
      dateCheck(p.date);
    });
    i.allocations.forEach((a) => {
      required(
        ids.batches.has(a.batchId) &&
          ids.products.has(a.productId) &&
          ids.warehouses.has(a.warehouseId),
        'Unknown invoice batch allocation.',
      );
      qtyCheck(a.qty);
      moneyCheck(a.cost);
    });
    if (i.status === 'Issued') {
      required(
        sum(i.allocations, (a) => a.qty * a.cost) === i.cogs,
        'Invoice batch costs are inconsistent.',
      );
      const productIds = new Set([
        ...i.lines.map((l) => l.productId),
        ...i.allocations.map((a) => a.productId),
      ]);
      productIds.forEach((id) =>
        required(
          i.allocations.filter((a) => a.productId === id).reduce((n, a) => n + a.qty, 0) ===
            i.lines.filter((l) => l.productId === id).reduce((n, l) => n + l.qty * l.factor, 0),
          'Invoice allocations do not match its base quantities.',
        ),
      );
    }
  });
  s.purchases.forEach((p) => {
    required(
      contact(s, p.supplierId)?.type === 'Supplier' &&
        ids.warehouses.has(p.warehouseId) &&
        Array.isArray(p.lines) &&
        p.lines.length &&
        ['Ordered', 'Received', 'Canceled'].includes(p.status),
      'Invalid purchase order.',
    );
    p.lines.forEach((l) => {
      required(ids.products.has(l.productId), 'Unknown purchase product.');
      qtyCheck(l.qty);
      moneyCheck(l.price);
      required(
        units.includes(l.unit) &&
          Number.isSafeInteger(l.factor) &&
          l.factor >= 1 &&
          Number.isSafeInteger(l.qty * l.factor),
        'Invalid purchase line unit or factor.',
      );
    });
    required(
      sum(p.lines, (l) => l.qty * l.price) === p.total && p.paid >= 0 && p.paid <= p.total,
      'Invalid purchase order totals.',
    );
  });
  s.receipts.forEach((r) => {
    moneyCheck(r.total);
    moneyCheck(r.paid);
    required(r.paid <= r.total && ids.warehouses.has(r.warehouseId), 'Invalid stock receipt.');
  });
  const b = balances(s);
  required(
    b.inventory.balance === inventoryValue(s),
    'Backup inventory does not match the ledger.',
  );
  required(
    b.receivable.balance === sum(s.invoices, invoiceBalance),
    'Backup customer balances do not match the ledger.',
  );
  required(
    b.payable.balance ===
      sum(
        [...s.purchases.filter((p) => p.status === 'Received'), ...s.receipts],
        (p) => p.total - p.paid,
      ),
    'Backup supplier balances do not match the ledger.',
  );
  return s;
}
export const A = {
  KEY,
  RECOVERY_KEY,
  round,
  today,
  shift,
  daysLeft,
  uid,
  sum,
  units,
  dosageForms,
  storageTypes,
  missingRegistration,
  inactiveReason,
  activeProduct,
  controlledRegister,
  adjustmentReasons,
  adjustmentReasonsFor,
  categories,
  accounts,
  product,
  contact,
  warehouse,
  baseUnitLocked,
  unitLabel,
  unitFactor,
  unitPrice,
  formatQty,
  findBarcode,
  validatePacks,
  purchaseEntries,
  onHand,
  available,
  reservationStatus,
  reserved,
  free,
  holdStock,
  reserveInvoice,
  releaseReservation,
  releaseInvoiceReservations,
  saveReorderRule,
  deleteReorderRule,
  onOrder,
  reorderSuggestions,
  inventoryValue,
  batchStatus,
  shelfLifeFor,
  eligibleBatches,
  sellableQty,
  shortDatedBatches,
  shortDated,
  setMinShelfLife,
  isRecalled,
  createRecall,
  closeRecall,
  recallTrace,
  productStatus,
  invoiceStatus,
  invoiceBalance,
  ledger,
  activity,
  totals,
  normalizedLines,
  saveProduct,
  addBatch,
  moveStock,
  stockAt,
  movesFor,
  receiveStock,
  transferStock,
  setQuarantine,
  adjustStock: (s: Workspace, input: AdjustmentInput, options: { sourceId?: string } = {}) =>
    adjustStock(s, input, { sourceId: options.sourceId }),
  startCount: (s: Workspace, input: Parameters<typeof startCount>[1]) => startCount(s, input),
  addCountLine,
  recordCount,
  postCount: (s: Workspace, countId: string) => postCount(s, countId),
  cancelCount,
  createInvoice,
  issueInvoice,
  payInvoice,
  deleteDraft,
  createPurchase,
  receivePurchase,
  payBill,
  cancelPurchase,
  addExpense,
  saveContact,
  balances,
  transact,
  persist,
  load,
  emptyWorkspace,
  seed,
  migrate,
  validateBackup,
};
