import type {
  AgingRow,
  Statement,
  CustomerPayment,
  CustomerPaymentInput,
  PaymentAllocation,
  Refund,
  CreditNote,
  CreditNoteInput,
  CreditNoteLine,
  CreditReason,
  NumericInput,
  Unit,
  AccountId,
  AccountType,
  Product,
  Contact,
  CustomerGroup,
  PriceEntry,
  Invoice,
  Purchase,
  PurchaseLine,
  PurchaseApproval,
  Receipt,
  ReceiptLine,
  PurchaseReceiveInput,
  Batch,
  Workspace,
  LineInput,
  ProductInput,
  ContactInput,
  StockInput,
  InvoiceInput,
  PurchaseInput,
  ExpenseInput,
  Delivery,
  DeliveryLine,
  Pick as DeliveryPick,
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
  SalesOrder,
  OrderInput,
  CreditOverride,
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
    s.purchases.some(
      (p) => ['Draft', 'Sent'].includes(p.status) && p.lines.some((l) => l.productId === id),
    ) ||
    s.orders.some(
      (o) =>
        ['Quote', 'Confirmed'].includes(o.status) &&
        o.lines.some((l) => l.productId === id && openQty(s, o, l.id) > 0),
    ) ||
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
  [...s.invoices, ...s.purchases, ...s.orders].some((d) =>
    d.lines.some((l) => l.productId === id),
  ) ||
  s.receipts.some((r) => r.lines.some((l) => l.productId === id));
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
function priceFor(
  s: Workspace,
  { productId, unit, customerId }: { productId: string; unit: Unit; customerId?: string },
): {
  price: number;
  source: 'customer' | 'group' | 'group_discount' | 'default';
  entryId?: string;
} {
  const p = product(s, productId);
  required(p, 'Select a product.');
  unitFactor(p, unit);
  const customer = contact(s, customerId || '');
  // ponytail: no unit conversion between price entries; add if they want box prices to imply carton prices
  const entries = s.prices.filter((e) => e.productId === productId && e.unit === unit);
  const special =
    customer?.type === 'Customer' && entries.find((e) => e.customerId === customer.id);
  if (special) return { price: special.price, source: 'customer', entryId: special.id };
  return groupPriceFor(s, {
    productId,
    unit,
    groupId: customer?.type === 'Customer' ? customer.groupId : undefined,
  });
}
function groupPriceFor(
  s: Workspace,
  { productId, unit, groupId }: { productId: string; unit: Unit; groupId?: string },
): { price: number; source: 'group' | 'group_discount' | 'default'; entryId?: string } {
  const p = product(s, productId);
  required(p, 'Select a product.');
  const defaultPrice = unitPrice(p, unit);
  const group = s.customerGroups.find((g) => g.id === groupId);
  const groupPrice =
    group &&
    s.prices.find((e) => e.productId === productId && e.unit === unit && e.groupId === group.id);
  if (groupPrice) return { price: groupPrice.price, source: 'group', entryId: groupPrice.id };
  if (group && group.discountPercent > 0)
    return {
      price: round(defaultPrice * (1 - group.discountPercent / 100)),
      source: 'group_discount',
    };
  return { price: defaultPrice, source: 'default' };
}
function repriceLines(
  s: Workspace,
  lines: LineInput[],
  oldCustomerId: string,
  customerId: string,
): LineInput[] {
  return lines.map((line) => {
    const p = product(s, line.productId);
    const unit = line.unit || p?.unit;
    if (!p || !unit || (unit !== p.unit && !p.packs.some((pack) => pack.unit === unit)))
      return line;
    const input = { productId: p.id, unit };
    return Number(line.price) === priceFor(s, { ...input, customerId: oldCustomerId }).price
      ? { ...line, price: priceFor(s, { ...input, customerId }).price }
      : line;
  });
}
function belowCost(s: Workspace, productId: string, unit: Unit, price: number): boolean {
  const p = product(s, productId);
  required(p, 'Select a product.');
  return price < round(p.cost * unitFactor(p, unit));
}
function validatePrice(s: Workspace, entry: PriceEntry) {
  const p = product(s, entry.productId);
  required(p, 'Select a product.');
  required(units.includes(entry.unit), `Select a valid unit for ${p.name}.`);
  unitFactor(p, entry.unit);
  required(
    (entry.groupId !== undefined) !== (entry.customerId !== undefined),
    'Select exactly one customer group or customer.',
  );
  if (entry.groupId !== undefined)
    required(
      s.customerGroups.some((g) => g.id === entry.groupId),
      'Select a valid customer group.',
    );
  if (entry.customerId !== undefined)
    required(contact(s, entry.customerId)?.type === 'Customer', 'Select a customer.');
  required(moneyCheck(entry.price, 'Price') > 0, 'Price must be greater than 0.');
  required(
    entry.price === moneyCheck(entry.price, 'Price'),
    'Price must be a number rounded to cents.',
  );
  required(typeof entry.note === 'string', 'Enter a valid price note.');
  required(
    !s.prices.some(
      (e) =>
        e.id !== entry.id &&
        e.productId === entry.productId &&
        e.unit === entry.unit &&
        e.groupId === entry.groupId &&
        e.customerId === entry.customerId,
    ),
    'A price already exists for this product, unit and target.',
  );
}
function savePrice(
  s: Workspace,
  data: Omit<PriceEntry, 'id' | 'price' | 'note'> & { price: NumericInput; note?: string },
  id?: string,
) {
  required(!id || s.prices.some((e) => e.id === id), 'Price not found.');
  activeProduct(s, data.productId);
  const entry: PriceEntry = {
    id: id || uid('price'),
    productId: data.productId,
    unit: data.unit,
    price: moneyCheck(data.price, 'Price'),
    ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
    ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
    note: String(data.note || '').trim(),
  };
  validatePrice(s, entry);
  if (id) s.prices = s.prices.map((e) => (e.id === id ? entry : e));
  else s.prices.push(entry);
  return entry;
}
function deletePrice(s: Workspace, id: string) {
  required(
    s.prices.some((e) => e.id === id),
    'Price not found.',
  );
  s.prices = s.prices.filter((e) => e.id !== id);
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
    delivery: string;
    date: string;
    qty: number;
    returned: number;
  }> = [];
  moves
    .filter((m) => m.type === 'sale')
    .forEach((m) => {
      const delivery = s.deliveries.find(
        (d) => d.id === m.sourceId || (d.legacy && d.invoiceId === m.sourceId),
      );
      const invoice = s.invoices.find((i) => i.id === delivery?.invoiceId || i.id === m.sourceId);
      const invoiceNumber = invoice?.number || (delivery ? '—' : m.reference);
      const existing = sold.find(
        (row) => row.delivery === (delivery?.number || '') && row.invoice === invoiceNumber,
      );
      if (existing) sold[sold.indexOf(existing)] = { ...existing, qty: existing.qty - m.qty };
      else {
        const customerId = m.counterpartyId || '',
          c = contact(s, customerId);
        sold.push({
          customerId,
          customerName: c?.name || 'Unknown customer',
          phone: c?.phone || '',
          invoice: invoiceNumber,
          delivery: delivery?.number || '',
          date: m.date,
          qty: -m.qty,
          returned: 0,
        });
      }
    });
  moves
    .filter((m) => m.type === 'return')
    .forEach((m) => {
      const cn = s.creditNotes.find((cn) => cn.id === m.sourceId);
      const delivery = s.deliveries.find((d) => d.id === m.sourceId);
      const invoiceId = cn?.invoiceId || delivery?.invoiceId;
      const invoice = s.invoices.find((i) => i.id === invoiceId);
      const rows = sold.filter((row) =>
        invoice ? row.invoice === invoice.number : row.delivery === delivery?.number,
      );
      let remaining = m.qty;
      for (const row of rows) {
        const qty = Math.min(remaining, row.qty - row.returned);
        row.returned += qty;
        remaining -= qty;
      }
      if (remaining > 0) {
        const customerId = m.counterpartyId || '';
        sold.push({
          customerId,
          customerName: contact(s, customerId)?.name || 'Unknown customer',
          phone: contact(s, customerId)?.phone || '',
          invoice: invoice?.number || '\u2014',
          delivery: delivery?.number || '',
          date: m.date,
          qty: 0,
          returned: remaining,
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
      returned: sum(
        moves.filter((m) => m.type === 'return'),
        (m) => m.qty,
      ),
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
        (!opts.exceptSourceId || r.sourceId !== opts.exceptSourceId),
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
    !i.deliveryIds.length,
    'Delivery drafts cannot reserve stock. Their stock has already left.',
  );
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

function receivedQty(s: Workspace, po: Purchase, lineOrId: string | PurchaseLine): number {
  const lineId = typeof lineOrId === 'string' ? lineOrId : lineOrId.id;
  return sum(
    s.receipts
      .filter((r) => r.purchaseId === po.id)
      .flatMap((r) => r.lines)
      .filter((l) => l.purchaseLineId === lineId),
    (l) => l.qty,
  );
}

function deliveredQty(s: Workspace, order: SalesOrder, lineId: string): number {
  return s.deliveries
    .filter((d) => d.orderId === order.id && ['Dispatched', 'Delivered'].includes(d.status))
    .flatMap((d) => d.lines)
    .filter((l) => l.orderLineId === lineId)
    .reduce((n, l) => n + l.qty, 0);
}

function openQty(s: Workspace, doc: any, lineOrId: any): number {
  if ('supplierId' in doc) {
    const line =
      typeof lineOrId === 'string'
        ? doc.lines.find((l: any) => l.id === lineOrId)
        : (lineOrId as PurchaseLine);
    if (!line) return 0;
    return Math.max(0, line.qty - receivedQty(s, doc, line.id) - (line.closedQty || 0));
  } else {
    const lineId = typeof lineOrId === 'string' ? lineOrId : lineOrId.id;
    const line = doc.lines.find((l: any) => l.id === lineId);
    required(line, 'Order line not found.');
    return Math.max(0, line.qty - line.cancelledQty - deliveredQty(s, doc, lineId));
  }
}

function purchaseStatus(
  s: Workspace,
  po: Purchase,
): 'Draft' | 'Sent' | 'Partly received' | 'Received' | 'Canceled' {
  if (po.status === 'Sent' && po.lines.some((l) => receivedQty(s, po, l.id) > 0)) {
    return 'Partly received';
  }
  return po.status;
}

function billBalance(r: Receipt): number {
  return round(r.total - r.paid - r.credited);
}

function billStatus(r: Receipt): 'Paid' | 'Overdue' | 'Partly paid' | 'Open' {
  if (billBalance(r) === 0) return 'Paid';
  if (r.due < today()) return 'Overdue';
  if (r.paid + r.credited > 0) return 'Partly paid';
  return 'Open';
}

function openBills(s: Workspace, supplierId?: string): Receipt[] {
  return s.receipts
    .filter((r) => (!supplierId || r.supplierId === supplierId) && billBalance(r) > 0)
    .sort(
      (a, b) =>
        a.due.localeCompare(b.due) ||
        a.number.localeCompare(b.number, undefined, { numeric: true }) ||
        a.number.localeCompare(b.number),
    );
}

function onOrder(s: Workspace, productId: string, warehouseId: string): number {
  return s.purchases
    .filter((p) => ['Draft', 'Sent'].includes(p.status) && p.warehouseId === warehouseId)
    .reduce(
      (n, p) =>
        n +
        p.lines
          .filter((l) => l.productId === productId)
          .reduce((qty, l) => qty + openQty(s, p, l) * l.factor, 0),
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
          estimatedCost: round(
            orderQty * purchaseLinePrice(s, p.supplierId || '', p.id, orderUnit),
          ),
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
    : invoiceBalance(i) <= 0
      ? i.credited > 0 && i.credited >= round(i.total - i.paid)
        ? 'Credited'
        : 'Paid'
      : daysLeft(i.due) < 0
        ? 'Overdue'
        : i.paid > 0
          ? 'Partial'
          : 'Unpaid';
const invoiceBalance = (i: Invoice) =>
  i.status === 'Draft' ? 0 : round(i.total - i.paid - i.credited);
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
  for (const entry of s.prices.filter((e) => e.productId === p.id))
    required(
      entry.unit === p.unit || p.packs.some((pack) => pack.unit === entry.unit),
      'Delete price entries for this unit before removing it.',
    );
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
    const p =
      meta.type === 'return' ? product(s, batch.productId)! : activeProduct(s, batch.productId);
    required(p, 'Product not found.');
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
  const supplierId = data.supplierId || p.supplierId;
  const supplier = contact(s, supplierId);
  const date = today();
  const receiptNumber = `GRN-${String(s.counters.receipt++).padStart(4, '0')}`;
  const receiptId = uid('receipt');

  const batch = addBatch(
    s,
    { ...data, qty: qty * factor, cost: round(cost / factor), received: date },
    {
      date,
      reference: receiptNumber,
      sourceId: receiptId,
      counterpartyId: supplierId,
    },
  );
  const inventoryDebit = round(qty * factor * batch.cost);
  ledger(
    s,
    date,
    receiptNumber,
    'Stock receipt — ' + p.name + (amount !== inventoryDebit ? ' · Purchase rounding' : ''),
    purchaseEntries(inventoryDebit, amount, data.payment === 'credit' ? 'payable' : 'cash'),
  );
  const due = data.payment === 'cash' ? date : shift(supplier?.paymentTermsDays ?? 30, date);

  const line: ReceiptLine = {
    productId: p.id,
    name: p.name,
    sku: p.sku,
    unit: data.unit ?? p.unit,
    factor,
    qty,
    price: cost,
    batchId: batch.id,
    lotCode: batch.code,
    expiry: batch.expiry,
  };

  const receipt: Receipt = {
    id: receiptId,
    number: receiptNumber,
    date,
    reference: String(data.reference || '').trim(),
    supplierId,
    warehouseId: data.warehouseId,
    lines: [line],
    total: amount,
    paid: data.payment === 'credit' ? 0 : amount,
    credited: 0,
    due,
    notes: '',
    createdAt: new Date().toISOString(),
    createdBy: CURRENT_USER,
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
  const deliveryDraft = id ? s.invoices.find((i) => i.id === id) : undefined;
  if (deliveryDraft?.status === 'Draft' && deliveryDraft.deliveryIds.length) {
    required(
      data.lines.length === deliveryDraft.lines.length &&
        data.lines.every((l, index) => {
          const source = deliveryDraft.lines[index];
          return (
            l.productId === source.productId &&
            (l.unit ?? source.unit) === source.unit &&
            Number(l.qty) === source.qty &&
            (l.price === undefined || Number(l.price) === source.price)
          );
        }) &&
        data.customerId === deliveryDraft.customerId &&
        (data.discount === undefined || Number(data.discount) === deliveryDraft.discount) &&
        (data.taxRate === undefined || Number(data.taxRate) === deliveryDraft.taxRate),
      "Lines come from delivery notes and can't be edited.",
    );
    return saveInvoiceHeader(s, deliveryDraft.id, {
      date: data.date,
      due: data.due ?? deliveryDraft.due,
      notes: data.notes ?? deliveryDraft.notes,
    });
  }
  required(
    data.allowShortDated === undefined || typeof data.allowShortDated === 'boolean',
    'Allow short-dated stock must be a boolean.',
  );
  required(contact(s, data.customerId)?.type === 'Customer', 'Select a customer.');
  const date = dateCheck(data.date),
    due = dateCheck(data.due ?? shift(contact(s, data.customerId)!.paymentTermsDays, date));
  required(due >= date, 'Due date must be on or after the invoice date.');
  required(date <= today(), 'Invoice date cannot be in the future.');
  required(Array.isArray(data.lines) && data.lines.length, 'Add at least one product.');
  const lines = normalizedLines(
      s,
      data.lines.map((line) => {
        const p = product(s, line.productId);
        return {
          ...line,
          price:
            line.price ??
            (p
              ? priceFor(s, {
                  productId: p.id,
                  unit: line.unit || p.unit,
                  customerId: data.customerId,
                }).price
              : undefined),
        };
      }),
    ),
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
    credited: 0,
    deliveryIds: [],
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
function invoiceDeliveryCheck(s: Workspace, ids: string[], exceptInvoiceId?: string): Delivery[] {
  required(Array.isArray(ids) && ids.length > 0, 'Select at least one delivery.');
  required(new Set(ids).size === ids.length, 'Select distinct deliveries.');
  const deliveries = ids.map((id) => {
    const d = deliveryById(s, id);
    if (d.invoiceId) {
      const invoice = s.invoices.find((i) => i.id === d.invoiceId)!;
      throw new Error(`${d.number} is already invoiced (${invoice.number}).`);
    }
    const draft = s.invoices.find(
      (i) => i.id !== exceptInvoiceId && i.status === 'Draft' && i.deliveryIds.includes(id),
    );
    required(!draft, `${d.number} is on draft ${draft?.number}.`);
    required(
      ['Dispatched', 'Delivered'].includes(d.status),
      `${d.number} must be Dispatched or Delivered.`,
    );
    required(d.orderId, 'Select deliveries from sales orders.');
    return d;
  });
  required(
    deliveries.every((d) => d.customerId === deliveries[0].customerId),
    'Select deliveries for the same customer.',
  );
  const taxRate = orderById(s, deliveries[0].orderId!).taxRate;
  required(
    deliveries.every((d) => orderById(s, d.orderId!).taxRate === taxRate),
    'Invoice deliveries with different tax rates separately.',
  );
  return deliveries;
}
function invoiceHeader(
  s: Workspace,
  deliveries: Delivery[],
  customerId: string,
  input: { date?: string; due?: string; notes?: string },
) {
  const date = dateCheck(input.date ?? today());
  required(date <= today(), 'Invoice date cannot be in the future.');
  required(
    deliveries.every((d) => date >= d.date!),
    'Invoice date cannot be before the latest delivery date.',
  );
  const due = dateCheck(input.due ?? shift(contact(s, customerId)!.paymentTermsDays, date));
  required(due >= date, 'Due date must be on or after the invoice date.');
  return { date, due, notes: String(input.notes || '').trim() };
}
function createInvoiceFromDeliveries(
  s: Workspace,
  input: { deliveryIds: string[]; date?: string; due?: string; notes?: string },
): Invoice {
  const deliveries = invoiceDeliveryCheck(s, input.deliveryIds);
  const customerId = deliveries[0].customerId;
  const lines = deliveries.flatMap((d) =>
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
  const orderIds = [...new Set(deliveries.map((d) => d.orderId!))];
  const discount = sum(orderIds, (id) =>
    round(
      (deliveries
        .filter((d) => d.orderId === id)
        .reduce((n, d) => n + d.lines.reduce((v, l) => v + l.qty * l.price, 0), 0) *
        orderById(s, id).discountPercent) /
        100,
    ),
  );
  const header = invoiceHeader(s, deliveries, customerId, input);
  const invoice: Invoice = {
    id: uid('invoice'),
    number: `${s.settings.invoicePrefix}-${String(s.counters.invoice++).padStart(4, '0')}`,
    customerId,
    ...header,
    lines,
    ...totals(lines, discount, orderById(s, orderIds[0]).taxRate),
    status: 'Draft',
    paid: 0,
    credited: 0,
    allowShortDated: false,
    deliveryIds: [...input.deliveryIds],
    orderId: orderIds.length === 1 ? orderIds[0] : undefined,
  };
  required(invoice.total > 0, 'Invoice total must be greater than zero.');
  s.invoices.unshift(invoice);
  return invoice;
}
function saveInvoiceHeader(
  s: Workspace,
  id: string,
  input: { date: string; due: string; notes: string },
): Invoice {
  const invoice = s.invoices.find((i) => i.id === id);
  required(invoice?.status === 'Draft', 'Only draft invoices can be edited.');
  Object.assign(invoice, invoiceHeader(s, deliveriesOf(s, invoice), invoice.customerId, input));
  return invoice;
}
function uninvoicedDeliveries(s: Workspace, customerId?: string): Delivery[] {
  return s.deliveries.filter(
    (d) =>
      ['Dispatched', 'Delivered'].includes(d.status) &&
      !d.invoiceId &&
      (!customerId || d.customerId === customerId),
  );
}
function deliveryValue(s: Workspace, d: Delivery): number {
  const order = d.orderId ? orderById(s, d.orderId) : undefined;
  const subtotal = sum(d.lines, (l) => l.qty * l.price);
  return totals(
    d.lines,
    round((subtotal * (order?.discountPercent ?? 0)) / 100),
    order?.taxRate ?? 0,
  ).total;
}
function deliveredNotInvoiced(
  s: Workspace,
  { customerId, asOf = today() }: { customerId?: string; asOf?: string } = {},
) {
  dateCheck(asOf);
  return uninvoicedDeliveries(s, customerId)
    .filter(
      (d) =>
        d.date! <= asOf &&
        !s.invoices.some((i) => i.status === 'Draft' && i.deliveryIds.includes(d.id)),
    )
    .map((delivery) => {
      const ageDays = daysLeft(asOf, delivery.date!);
      return {
        delivery,
        customerId: delivery.customerId,
        value: deliveryValue(s, delivery),
        ageDays,
        late:
          contact(s, delivery.customerId)!.billing === 'monthly'
            ? delivery.date!.slice(0, 7) < asOf.slice(0, 7)
            : ageDays > 1,
      };
    });
}
function invoicedQty(s: Workspace, order: SalesOrder, lineId: string): number {
  return s.deliveries
    .filter((d) => d.orderId === order.id && d.invoiceId)
    .reduce(
      (n, d) => n + d.lines.filter((l) => l.orderLineId === lineId).reduce((v, l) => v + l.qty, 0),
      0,
    );
}
function orderTotals(order: SalesOrder) {
  const lines = order.lines.map((l) => ({ ...l, qty: l.qty - l.cancelledQty }));
  return totals(
    lines,
    round((sum(lines, (l) => l.qty * l.price) * order.discountPercent) / 100),
    order.taxRate,
  );
}
function orderOpenValue(s: Workspace, order: SalesOrder): number {
  const lines = order.lines.map((l) => ({ ...l, qty: openQty(s, order, l.id) }));
  return totals(
    lines,
    round((sum(lines, (l) => l.qty * l.price) * order.discountPercent) / 100),
    order.taxRate,
  ).total;
}
function fulfilmentStatus(
  s: Workspace,
  order: SalesOrder,
): 'Not delivered' | 'Partly delivered' | 'Delivered' {
  const delivered = order.lines.reduce((n, l) => n + deliveredQty(s, order, l.id), 0);
  return delivered === 0
    ? 'Not delivered'
    : order.lines.some((l) => openQty(s, order, l.id) > 0)
      ? 'Partly delivered'
      : 'Delivered';
}
function quoteStatus(order: SalesOrder): 'Quote' | 'Expired' {
  return order.validUntil! < today() ? 'Expired' : 'Quote';
}
function orderById(s: Workspace, id: string): SalesOrder {
  const order = s.orders.find((o) => o.id === id);
  required(order, 'Order not found.');
  return order;
}
function orderCreditOverride(
  s: Workspace,
  customerId: string,
  amount: number,
  override?: { reason: string },
): CreditOverride | undefined {
  const check = creditCheck(s, customerId, amount);
  if (check.ok) return undefined;
  required(override, check.reasons.join(' '));
  const reason = String(override.reason || '').trim();
  required(reason.length >= 5, 'Enter an override reason of at least 5 characters.');
  // ponytail: anyone can override until roles exist; restrict to managers then
  return { by: CURRENT_USER, at: new Date().toISOString(), reason, reasons: check.reasons };
}
function saveOrder(s: Workspace, input: OrderInput, id?: string): SalesOrder {
  const previous = id ? orderById(s, id) : undefined;
  required(!previous || !['Done', 'Cancelled'].includes(previous.status), 'This order is closed.');
  const customer = contact(s, input.customerId);
  required(customer?.type === 'Customer', 'Select a customer.');
  required(
    previous?.status !== 'Confirmed' || previous.customerId === input.customerId,
    'The customer cannot change on a confirmed order.',
  );
  const date = dateCheck(input.date),
    requestedDate = dateCheck(input.requestedDate);
  required(date <= today(), 'Order date cannot be in the future.');
  required(requestedDate >= date, 'Requested date must be on or after the order date.');
  required(['delivery', 'pickup'].includes(input.fulfilment), 'Select delivery or pickup.');
  required(
    input.allowShortDated === undefined || typeof input.allowShortDated === 'boolean',
    'Allow short-dated stock must be a boolean.',
  );
  required(Array.isArray(input.lines) && input.lines.length, 'Add at least one product.');
  const normalized = normalizedLines(
    s,
    input.lines.map((l) => {
      const p = product(s, l.productId);
      return {
        ...l,
        price:
          l.price ??
          (p
            ? priceFor(s, { productId: p.id, unit: l.unit ?? p.unit, customerId: customer.id })
                .price
            : undefined),
      };
    }),
  );
  const lineIds = new Set<string>();
  const lines = normalized.map((line, index) => {
    const lineId = input.lines[index].id;
    const old = lineId ? previous?.lines.find((l) => l.id === lineId) : undefined;
    required(!lineId || old, 'Order line not found.');
    const delivered = old && previous ? deliveredQty(s, previous, old.id) : 0;
    const cancelledQty = old?.cancelledQty ?? 0;
    required(
      line.qty >= delivered + cancelledQty,
      `${line.name}: ${delivered + cancelledQty} already delivered or cancelled.`,
    );
    required(
      !delivered || line.productId === old!.productId,
      `${line.name}: delivered lines cannot be removed.`,
    );
    required(
      !delivered ||
        (line.price === old!.price && line.unit === old!.unit && line.factor === old!.factor),
      `${line.name}: price and unit cannot change after delivery.`,
    );
    const result = { ...line, id: old?.id || uid('sol'), cancelledQty };
    required(!lineIds.has(result.id), 'Order contains duplicate lines.');
    lineIds.add(result.id);
    return result;
  });
  previous?.lines.forEach((l) =>
    required(
      lineIds.has(l.id) || deliveredQty(s, previous, l.id) === 0,
      `${l.name}: delivered lines cannot be removed.`,
    ),
  );
  const discountPercent = moneyCheck(
    input.discountPercent ?? previous?.discountPercent ?? 0,
    'Discount percent',
  );
  const taxRate = moneyCheck(input.taxRate ?? previous?.taxRate ?? s.settings.taxRate, 'Tax rate');
  required(discountPercent <= 100, 'Discount percent cannot exceed 100%.');
  required(taxRate <= 100, 'Tax rate cannot exceed 100%.');
  const validUntil =
    previous?.status === 'Confirmed' ? undefined : dateCheck(input.validUntil ?? shift(14, date));
  required(!validUntil || validUntil >= date, 'Valid until must be on or after the order date.');
  const order: SalesOrder = {
    ...previous,
    id: previous?.id || uid('so'),
    number: previous?.number || `SO-${String(s.counters.order).padStart(4, '0')}`,
    status: previous?.status || 'Quote',
    customerId: customer.id,
    date,
    validUntil,
    requestedDate,
    fulfilment: input.fulfilment,
    deliveryAddress: String(input.deliveryAddress ?? customer.address).trim(),
    lines,
    discountPercent,
    taxRate,
    allowShortDated: input.allowShortDated ?? previous?.allowShortDated ?? false,
    notes: String(input.notes || '').trim(),
    createdAt: previous?.createdAt || new Date().toISOString(),
    createdBy: previous?.createdBy || CURRENT_USER,
  };
  if (previous?.status === 'Confirmed') {
    const increase = round(orderTotals(order).total - orderTotals(previous).total);
    if (increase > 0)
      order.creditOverride =
        orderCreditOverride(s, customer.id, increase, input.override) ?? previous.creditOverride;
  }
  if (previous) s.orders = s.orders.map((o) => (o.id === id ? order : o));
  else {
    s.counters.order++;
    s.orders.unshift(order);
  }
  if (order.status === 'Confirmed') {
    reserveOrder(s, order.id);
    closeIfDone(s, order.id);
  } else if (!previous && input.asQuote === false)
    confirmOrder(s, order.id, { override: input.override });
  return order;
}
function confirmOrder(
  s: Workspace,
  id: string,
  { override }: { override?: { reason: string } } = {},
): SalesOrder {
  const order = orderById(s, id);
  required(order.status === 'Quote', 'Only quotations can be confirmed.');
  required(
    quoteStatus(order) !== 'Expired',
    `Quote expired on ${order.validUntil}. Update and save it first.`,
  );
  order.lines.forEach((l) => activeProduct(s, l.productId));
  const creditOverride = orderCreditOverride(
    s,
    order.customerId,
    orderOpenValue(s, order),
    override,
  );
  if (creditOverride) order.creditOverride = creditOverride;
  order.status = 'Confirmed';
  order.confirmedAt = new Date().toISOString();
  order.confirmedBy = CURRENT_USER;
  delete order.validUntil;
  reserveOrder(s, id);
  return order;
}
function reserveOrder(s: Workspace, id: string): void {
  // ponytail: backorders aren't auto-reserved when stock arrives; staff use "Reserve available stock". Hook into receipts if this gets missed.
  const order = orderById(s, id),
    demand = new Map<string, number>();
  if (order.status === 'Confirmed')
    order.lines.forEach((l) =>
      demand.set(l.productId, (demand.get(l.productId) || 0) + openQty(s, order, l.id) * l.factor),
    );
  const existing = s.reservations.filter(
    (r) => r.source === 'sales_order' && r.sourceId === id && r.status === 'Active',
  );
  const productIds = new Set([...demand.keys(), ...existing.map((r) => r.productId)]);
  productIds.forEach((productId) => {
    const target = Math.max(
      0,
      Math.min(
        demand.get(productId) || 0,
        free(s, productId, {
          customerId: order.customerId,
          allowShortDated: order.allowShortDated,
          exceptSourceId: id,
        }),
      ),
    );
    const reservation = existing.find((r) => r.productId === productId);
    if (reservation) {
      if (target > 0) Object.assign(reservation, { qty: target });
      else releaseReservation(s, reservation.id);
    } else if (target > 0)
      addReservation(s, {
        productId,
        customerId: order.customerId,
        qty: target,
        source: 'sales_order',
        sourceId: id,
        note: '',
      });
  });
}
function closeIfDone(s: Workspace, id: string): void {
  const order = orderById(s, id);
  if (order.status === 'Confirmed' && order.lines.every((l) => openQty(s, order, l.id) === 0)) {
    order.status = 'Done';
    order.closedAt = new Date().toISOString();
  }
}
function cancelRemaining(
  s: Workspace,
  id: string,
  { lineId, reason }: { lineId?: string; reason: string },
): void {
  const order = orderById(s, id);
  required(order.status === 'Confirmed', 'Only confirmed orders can cancel remaining quantities.');
  required(String(reason || '').trim(), 'Enter a cancellation reason.');
  required(!lineId || order.lines.some((l) => l.id === lineId), 'Order line not found.');
  order.lines
    .filter((l) => !lineId || l.id === lineId)
    .forEach((l) => (l.cancelledQty += pendingDeliveryQty(s, order, l.id)));
  order.cancelReason = String(reason).trim();
  reserveOrder(s, id);
  closeIfDone(s, id);
}
function cancelOrder(s: Workspace, id: string, reason: string): void {
  const order = orderById(s, id);
  required(['Quote', 'Confirmed'].includes(order.status), 'This order is closed.');
  required(
    !order.lines.some((l) => deliveredQty(s, order, l.id) > 0),
    'Part of this order was delivered. Cancel the remaining quantities instead.',
  );
  required(String(reason || '').trim(), 'Enter a cancellation reason.');
  order.status = 'Cancelled';
  order.cancelReason = String(reason).trim();
  order.closedAt = new Date().toISOString();
  reserveOrder(s, id);
}
// Product reservations are shared by lines; allocate in document order for display.
function orderLineReserved(s: Workspace, order: SalesOrder, lineId: string): number {
  const line = order.lines.find((l) => l.id === lineId);
  required(line, 'Order line not found.');
  let remaining = s.reservations
    .filter(
      (r) =>
        r.source === 'sales_order' &&
        r.sourceId === order.id &&
        r.productId === line.productId &&
        r.status === 'Active',
    )
    .reduce((n, r) => n + r.qty, 0);
  for (const l of order.lines.filter((l) => l.productId === line.productId)) {
    const allocated = Math.min(openQty(s, order, l.id) * l.factor, remaining);
    if (l.id === lineId) return allocated / l.factor;
    remaining -= allocated;
  }
  return 0;
}
function creditCheck(
  s: Workspace,
  customerId: string,
  addAmount: number,
): {
  ok: boolean;
  reasons: string[];
  exposure: number;
  limit: number | null;
  overdue: number;
} {
  const c = contact(s, customerId);
  required(c?.type === 'Customer', 'Select a customer.');
  const invoices = s.invoices.filter((i) => i.customerId === customerId);
  let exposure = sum(invoices, invoiceBalance);
  exposure = round(
    exposure +
      sum(
        s.orders.filter((o) => o.customerId === customerId && o.status === 'Confirmed'),
        (o) => orderOpenValue(s, o),
      ),
  );
  exposure = round(exposure + sum(uninvoicedDeliveries(s, customerId), (d) => deliveryValue(s, d)));
  exposure = round(exposure - customerCredit(s, customerId));
  exposure = round(exposure + moneyCheck(addAmount));
  const overdue = overdueAmount(s, customerId, s.settings.overdueGraceDays);
  const reasons: string[] = [];
  if (c.onHold) reasons.push(`Account on hold: ${c.holdReason}.`);
  if (c.creditLimit !== null && exposure > c.creditLimit)
    reasons.push(
      `Credit limit $${c.creditLimit.toFixed(2)} exceeded (exposure $${exposure.toFixed(2)}).`,
    );
  if (overdue > 0)
    reasons.push(
      `$${overdue.toFixed(2)} is overdue by more than ${s.settings.overdueGraceDays} days.`,
    );
  return { ok: reasons.length === 0, reasons, exposure, limit: c.creditLimit, overdue };
}
const deliveriesOf = (s: Workspace, invoice: Invoice): Delivery[] =>
  invoice.deliveryIds.map((id) => s.deliveries.find((d) => d.id === id)!).filter(Boolean);
const invoiceCost = (s: Workspace, invoice: Invoice): number =>
  sum(deliveriesOf(s, invoice), (d) => d.cost);
const invoicePicks = (s: Workspace, invoice: Invoice): DeliveryPick[] =>
  deliveriesOf(s, invoice).flatMap((d) => d.lines.flatMap((l) => l.picks));
function deliveryById(s: Workspace, id: string, status?: Delivery['status']): Delivery {
  const delivery = s.deliveries.find((d) => d.id === id);
  required(delivery, 'Delivery not found.');
  required(!status || delivery.status === status, `Delivery must be ${status}.`);
  return delivery;
}
function deliveryOptions(s: Workspace, d: Delivery): SaleOptions {
  return {
    customerId: d.customerId,
    allowShortDated: d.orderId
      ? orderById(s, d.orderId).allowShortDated
      : (s.invoices.find((i) => i.deliveryIds.includes(d.id))?.allowShortDated ?? false),
  };
}
function pickOf(batch: Batch, qty: number): DeliveryPick {
  return {
    batchId: batch.id,
    warehouseId: batch.warehouseId,
    lotCode: batch.code,
    expiry: batch.expiry,
    qty,
    cost: 0,
  };
}
function proposePicks(
  s: Workspace,
  lines: Array<DeliveryLine | Invoice['lines'][number]>,
  opts: SaleOptions,
  warehouseId?: string,
): DeliveryLine[] {
  const used = new Map<string, number>();
  return lines.map((line) => {
    let remaining = line.qty * line.factor;
    const picks: DeliveryPick[] = [];
    for (const batch of eligibleBatches(s, line.productId, opts).filter(
      (b) => !warehouseId || b.warehouseId === warehouseId,
    )) {
      const take = Math.min(remaining, batch.qty - (used.get(batch.id) || 0));
      if (take > 0) {
        picks.push(pickOf(batch, take));
        used.set(batch.id, (used.get(batch.id) || 0) + take);
        remaining -= take;
      }
      if (!remaining) break;
    }
    required(!remaining, `Not enough pickable stock: ${line.name}.`);
    return {
      id: uid('dl'),
      ...('orderLineId' in line ? { orderLineId: line.orderLineId } : {}),
      productId: line.productId,
      name: line.name,
      sku: line.sku,
      unit: line.unit,
      factor: line.factor,
      qty: line.qty,
      price: line.price,
      picks,
    };
  });
}
function newDelivery(
  s: Workspace,
  input: Pick<Delivery, 'customerId' | 'method' | 'address' | 'lines'> & {
    orderId?: string;
    warehouseId?: string;
  },
): Delivery {
  const delivery: Delivery = {
    ...input,
    id: uid('dn'),
    number: `DN-${String(s.counters.delivery++).padStart(4, '0')}`,
    status: 'Picking',
    cost: 0,
    driver: '',
    receivedBy: '',
    returnReason: '',
    createdAt: new Date().toISOString(),
    createdBy: CURRENT_USER,
  };
  s.deliveries.unshift(delivery);
  return delivery;
}
function pendingDeliveryQty(
  s: Workspace,
  order: SalesOrder,
  lineId: string,
  exceptId?: string,
): number {
  return (
    openQty(s, order, lineId) -
    s.deliveries
      .filter((d) => d.orderId === order.id && d.status === 'Picking' && d.id !== exceptId)
      .flatMap((d) => d.lines)
      .filter((l) => l.orderLineId === lineId)
      .reduce((n, l) => n + l.qty, 0)
  );
}
function deliveryPickable(
  s: Workspace,
  order: SalesOrder,
  productId: string,
  warehouseId: string,
): number {
  const opts = {
    customerId: order.customerId,
    allowShortDated: order.allowShortDated,
    exceptSourceId: order.id,
  };
  return Math.max(
    0,
    Math.min(
      sum(
        eligibleBatches(s, productId, opts).filter((b) => b.warehouseId === warehouseId),
        (b) => b.qty,
      ),
      free(s, productId, opts),
    ),
  );
}
function deliveryQuantities(
  s: Workspace,
  order: SalesOrder,
  warehouseId: string,
): { orderLineId: string; qty: number }[] {
  const used = new Map<string, number>();
  return order.lines.map((l) => {
    const pickable = Math.max(
      0,
      deliveryPickable(s, order, l.productId, warehouseId) - (used.get(l.productId) || 0),
    );
    const qty = Math.max(
      0,
      Math.min(pendingDeliveryQty(s, order, l.id), Math.floor(pickable / l.factor)),
    );
    used.set(l.productId, (used.get(l.productId) || 0) + qty * l.factor);
    return { orderLineId: l.id, qty };
  });
}
function createDelivery(
  s: Workspace,
  input: {
    orderId: string;
    warehouseId: string;
    method?: Delivery['method'];
    lines?: { orderLineId: string; qty: number }[];
  },
): Delivery {
  const order = orderById(s, input.orderId),
    wh = warehouse(s, input.warehouseId);
  required(order.status === 'Confirmed', 'Only confirmed orders can create deliveries.');
  required(wh, 'Select a warehouse.');
  const method = input.method ?? order.fulfilment;
  required(['delivery', 'pickup'].includes(method), 'Select Delivery or Pickup.');
  if (input.lines)
    required(
      new Set(input.lines.map((l) => l.orderLineId)).size === input.lines.length,
      'Select distinct order lines.',
    );
  const used = new Map<string, number>();
  const lines = (
    input.lines ?? deliveryQuantities(s, order, wh.id).filter((l) => l.qty > 0)
  ).flatMap((inputLine) => {
    const line = order.lines.find((l) => l.id === inputLine.orderLineId);
    required(line, 'Order line not found.');
    const pending = pendingDeliveryQty(s, order, line.id);
    const pickable = Math.max(
      0,
      deliveryPickable(s, order, line.productId, wh.id) - (used.get(line.productId) || 0),
    );
    const qty = qtyCheck(inputLine.qty);
    required(qty <= pending, `${line.name}: only ${pending} remain to pick.`);
    required(
      qty * line.factor <= pickable,
      `${line.name}: only ${Math.floor(pickable / line.factor)} can be picked here.`,
    );
    used.set(line.productId, (used.get(line.productId) || 0) + qty * line.factor);
    return [{ ...line, orderLineId: line.id, qty, picks: [] }];
  });
  required(lines.length, `Nothing can be picked from ${wh.name} for this order.`);
  return newDelivery(s, {
    orderId: order.id,
    warehouseId: wh.id,
    customerId: order.customerId,
    method,
    address: order.deliveryAddress,
    lines: proposePicks(
      s,
      lines,
      { customerId: order.customerId, allowShortDated: order.allowShortDated },
      wh.id,
    ),
  });
}
function setPicks(
  s: Workspace,
  deliveryId: string,
  lineId: string,
  picks: { batchId: string; qty: number }[],
): void {
  const d = deliveryById(s, deliveryId, 'Picking'),
    line = d.lines.find((l) => l.id === lineId);
  required(line, 'Delivery line not found.');
  required(
    new Set(picks.map((p) => p.batchId)).size === picks.length,
    'Select each lot only once.',
  );
  const eligible = eligibleBatches(s, line.productId, deliveryOptions(s, d));
  const next = picks.map((p) => {
    const batch = eligible.find((b) => b.id === p.batchId);
    required(
      batch && (!d.warehouseId || batch.warehouseId === d.warehouseId),
      'Select an eligible lot in the delivery warehouse.',
    );
    const qty = qtyCheck(p.qty),
      other = d.lines
        .filter((l) => l.id !== lineId)
        .flatMap((l) => l.picks)
        .filter((p) => p.batchId === batch.id)
        .reduce((n, p) => n + p.qty, 0);
    required(
      qty + other <= batch.qty,
      `Not enough stock in lot ${batch.code} (${batch.qty} available).`,
    );
    return pickOf(batch, qty);
  });
  required(
    next.reduce((n, p) => n + p.qty, 0) === line.qty * line.factor,
    'Pick quantities must equal the delivery line base quantity.',
  );
  line.picks = next;
}
function cancelDelivery(s: Workspace, id: string): void {
  deliveryById(s, id, 'Picking').status = 'Cancelled';
}
function dispatchDelivery(
  s: Workspace,
  id: string,
  input: { date?: string; driver?: string; receivedBy?: string } = {},
): Delivery {
  const d = deliveryById(s, id, 'Picking'),
    date = dateCheck(input.date ?? today());
  required(date <= today(), 'Dispatch date cannot be in the future.');
  const receivedBy = String(input.receivedBy || '').trim();
  required(d.method !== 'pickup' || receivedBy, 'Enter who received the goods.');
  const opts = deliveryOptions(s, d),
    used = new Map<string, number>();
  if (d.orderId) {
    const order = orderById(s, d.orderId);
    required(order.status === 'Confirmed', 'Only confirmed orders can dispatch deliveries.');
    d.lines.forEach((l) => {
      const current = order.lines.find((line) => line.id === l.orderLineId);
      required(
        current &&
          current.productId === l.productId &&
          current.unit === l.unit &&
          current.factor === l.factor &&
          current.price === l.price,
        'Order changed since picking. Cancel this delivery and create it again.',
      );
      required(
        l.qty <= openQty(s, order, l.orderLineId!),
        `${l.name}: delivery exceeds the open quantity.`,
      );
    });
  }
  d.lines.forEach((l) => {
    activeProduct(s, l.productId);
    required(
      l.picks.reduce((n, p) => n + p.qty, 0) === l.qty * l.factor,
      'Pick quantities must equal the delivery line base quantity.',
    );
    l.picks.forEach((p) => {
      const b = eligibleBatches(s, l.productId, opts).find((b) => b.id === p.batchId);
      const need = (used.get(p.batchId) || 0) + p.qty;
      required(
        b &&
          (!d.warehouseId || b.warehouseId === d.warehouseId) &&
          b.warehouseId === p.warehouseId &&
          b.code === p.lotCode &&
          b.expiry === p.expiry &&
          b.qty >= need,
        `Lot ${p.lotCode} changed since picking. Update the picks.`,
      );
      used.set(p.batchId, need);
    });
  });
  if (d.orderId) {
    const order = orderById(s, d.orderId);
    for (const productId of new Set(d.lines.map((l) => l.productId))) {
      const need = d.lines
        .filter((l) => l.productId === productId)
        .reduce((n, l) => n + l.qty * l.factor, 0);
      required(
        need <= free(s, productId, { ...opts, exceptSourceId: order.id }),
        `Not enough free stock: ${product(s, productId)!.name}.`,
      );
    }
  }
  d.lines.forEach((l) =>
    l.picks.forEach((p) => {
      const batch = s.batches.find((b) => b.id === p.batchId)!;
      p.cost = batch.cost;
      moveStock(s, batch, -p.qty, {
        type: 'sale',
        date,
        reference: d.number,
        sourceId: d.id,
        counterpartyId: d.customerId,
      });
    }),
  );
  d.cost = sum(
    d.lines.flatMap((l) => l.picks),
    (p) => p.qty * p.cost,
  );
  ledger(s, date, d.number, `Delivery — ${contact(s, d.customerId)!.name}`, [
    { account: 'cogs', debit: d.cost },
    { account: 'inventory', credit: d.cost },
  ]);
  d.date = date;
  d.dispatchedAt = new Date().toISOString();
  d.dispatchedBy = CURRENT_USER;
  d.driver = d.method === 'pickup' ? '' : String(input.driver || '').trim();
  d.status = d.method === 'pickup' ? 'Delivered' : 'Dispatched';
  if (d.method === 'pickup') {
    d.receivedBy = receivedBy;
    d.deliveredAt = new Date(date + 'T12:00:00').toISOString();
  }
  if (d.orderId) {
    reserveOrder(s, d.orderId);
    closeIfDone(s, d.orderId);
  }
  activity(
    s,
    'sale',
    'Delivery dispatched',
    `${d.number} · ${contact(s, d.customerId)!.name}`,
    date,
  );
  return d;
}
function confirmDelivered(
  s: Workspace,
  id: string,
  input: { receivedBy: string; date?: string },
): void {
  const d = deliveryById(s, id, 'Dispatched'),
    receivedBy = String(input.receivedBy || '').trim(),
    date = dateCheck(input.date ?? today());
  required(receivedBy, 'Enter who received the goods.');
  required(date >= d.date! && date <= today(), 'Delivery date must be between dispatch and today.');
  d.status = 'Delivered';
  d.receivedBy = receivedBy;
  d.deliveredAt = new Date(date + 'T12:00:00').toISOString();
}
function returnToStock(
  s: Workspace,
  input: {
    batchId: string;
    qty: number;
    quarantine: boolean;
    reference: string;
    sourceId: string;
    counterpartyId: string;
    date: string;
  },
): Batch {
  const original = s.batches.find((b) => b.id === input.batchId);
  required(original, 'Batch not found.');
  const qty = qtyCheck(input.qty);
  let target = original;
  if (input.quarantine) {
    target = s.batches.find(
      (b) =>
        b.productId === original.productId &&
        b.code === original.code &&
        b.expiry === original.expiry &&
        b.cost === original.cost &&
        b.warehouseId === original.warehouseId &&
        b.quarantined,
    )! || { ...original, id: uid('batch'), qty: 0, quarantined: true };
    if (!s.batches.includes(target)) s.batches.push(target);
  }
  moveStock(s, target, qty, {
    type: 'return',
    date: input.date,
    reference: input.reference,
    sourceId: input.sourceId,
    counterpartyId: input.counterpartyId,
  });
  return target;
}
function markNotDelivered(s: Workspace, id: string, reason: string): void {
  const d = deliveryById(s, id);
  required(!d.invoiceId, 'This delivery is invoiced. Issue a credit note instead.');
  const draft = s.invoices.find((i) => i.status === 'Draft' && i.deliveryIds.includes(id));
  required(!draft, `${d.number} is on draft ${draft?.number}. Delete the draft first.`);
  required(d.status === 'Dispatched', 'Delivery must be Dispatched.');
  required(String(reason || '').trim(), 'Enter a return reason.');
  d.lines.forEach((l) =>
    l.picks.forEach((p) =>
      returnToStock(s, {
        batchId: p.batchId,
        qty: p.qty,
        quarantine: true,
        reference: d.number,
        sourceId: d.id,
        counterpartyId: d.customerId,
        date: today(),
      }),
    ),
  );
  ledger(s, today(), d.number, `Delivery returned — ${contact(s, d.customerId)!.name}`, [
    { account: 'inventory', debit: d.cost },
    { account: 'cogs', credit: d.cost },
  ]);
  d.status = 'Returned';
  d.returnReason = String(reason).trim();
  if (d.orderId) {
    const order = orderById(s, d.orderId);
    if (order.status === 'Done') {
      order.status = 'Confirmed';
      delete order.closedAt;
    }
    reserveOrder(s, order.id);
  }
}
function issueInvoice(
  s: Workspace,
  id: string,
  options?: { reason: string } | { override?: { reason: string } },
) {
  const inv = s.invoices.find((i) => i.id === id);
  required(inv && inv.status === 'Draft', 'Only draft invoices can be issued.');
  if (inv.deliveryIds.length) {
    const deliveries = invoiceDeliveryCheck(s, inv.deliveryIds, inv.id);
    invoiceHeader(s, deliveries, inv.customerId, inv);
    const entries: { account: AccountId; debit?: number; credit?: number }[] = [
      { account: 'receivable', debit: inv.total },
      { account: 'revenue', credit: round(inv.subtotal - inv.discount) },
    ];
    if (inv.taxAmount) entries.push({ account: 'tax', credit: inv.taxAmount });
    ledger(s, inv.date, inv.number, 'Sale — ' + contact(s, inv.customerId)!.name, entries);
    inv.status = 'Issued';
    deliveries.forEach((d) => (d.invoiceId = inv.id));
    if (customerCredit(s, inv.customerId) > 0 && invoiceBalance(inv) > 0)
      applyCredit(s, { customerId: inv.customerId, invoiceId: inv.id });
    activity(
      s,
      'sale',
      'Invoice issued',
      `${inv.number} · ${contact(s, inv.customerId)!.name}`,
      inv.date,
    );
    return inv;
  }
  const override = options && 'reason' in options ? options : options?.override;
  const check = creditCheck(s, inv.customerId, inv.total);
  let creditOverride: Invoice['creditOverride'];
  if (!check.ok) {
    required(override, check.reasons.join(' '));
    const reason = String(override.reason || '').trim();
    required(reason.length >= 5, 'Enter an override reason of at least 5 characters.');
    // ponytail: anyone can override until roles exist; restrict to managers then
    creditOverride = {
      by: CURRENT_USER,
      at: new Date().toISOString(),
      reason,
      reasons: check.reasons,
    };
  }
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
  const delivery = newDelivery(s, {
    customerId: inv.customerId,
    method: 'pickup',
    address: contact(s, inv.customerId)!.address,
    lines: proposePicks(s, inv.lines, opts),
  });
  inv.deliveryIds = [delivery.id];
  dispatchDelivery(s, delivery.id, {
    date: inv.date,
    receivedBy: contact(s, inv.customerId)!.name,
  });
  const entries: { account: AccountId; debit?: number; credit?: number }[] = [
    { account: 'receivable', debit: inv.total },
    { account: 'revenue', credit: round(inv.subtotal - inv.discount) },
  ];
  if (inv.taxAmount) entries.push({ account: 'tax', credit: inv.taxAmount });
  ledger(s, inv.date, inv.number, 'Sale — ' + contact(s, inv.customerId)!.name, entries);
  inv.status = 'Issued';
  if (creditOverride) inv.creditOverride = creditOverride;
  s.reservations
    .filter((r) => r.source === 'invoice' && r.sourceId === inv.id && r.status === 'Active')
    .forEach((r) => {
      r.status = 'Fulfilled';
      r.closedAt = new Date().toISOString();
    });
  inv.deliveryIds = [delivery.id];
  delivery.invoiceId = inv.id;
  if (customerCredit(s, inv.customerId) > 0 && invoiceBalance(inv) > 0)
    applyCredit(s, { customerId: inv.customerId, invoiceId: inv.id });
  activity(
    s,
    'sale',
    'Invoice issued',
    `${inv.number} · ${contact(s, inv.customerId)!.name}`,
    inv.date,
  );
  return inv;
}
function customerAccountStatus(s: Workspace, customerId: string) {
  const c = contact(s, customerId)!,
    check = creditCheck(s, customerId, 0);
  return c.onHold
    ? 'On hold'
    : check.limit !== null && check.exposure > check.limit
      ? 'Over limit'
      : check.overdue > 0
        ? 'Overdue'
        : 'OK';
}
const creditReasons: CreditReason[] = [
  'wrong_prescription',
  'wrong_item',
  'damaged',
  'expired',
  'not_ordered',
  'price_error',
  'other',
];
function netSales(s: Workspace, from: string, to = today()) {
  return round(
    sum(
      s.invoices.filter((i) => i.status === 'Issued' && i.date >= from && i.date <= to),
      (i) => i.subtotal - i.discount,
    ) -
      sum(
        s.creditNotes.filter((cn) => cn.status === 'Issued' && cn.date >= from && cn.date <= to),
        (cn) => cn.subtotal - cn.discount,
      ),
  );
}
const creditAvailable = (cn: CreditNote) =>
  round(cn.total - sum(cn.allocations, (a) => a.amount) - cn.refunded);
function creditNoteAmounts(invoice: Invoice, lines: { qty: number; price: number }[]) {
  const subtotal = sum(lines, (l) => l.qty * l.price);
  return totals(
    lines,
    invoice.subtotal ? round((subtotal * invoice.discount) / invoice.subtotal) : 0,
    invoice.taxRate,
  );
}
function creditNotePicks(s: Workspace, invoice: Invoice, productId: string): DeliveryPick[] {
  const picks: DeliveryPick[] = [];
  deliveriesOf(s, invoice)
    .flatMap((d) => d.lines)
    .filter((l) => l.productId === productId)
    .flatMap((l) => l.picks)
    .forEach((pick) => {
      const existing = picks.find((p) => p.batchId === pick.batchId);
      if (existing) picks[picks.indexOf(existing)] = { ...existing, qty: existing.qty + pick.qty };
      else picks.push({ ...pick });
    });
  return picks.sort((a, b) => b.expiry.localeCompare(a.expiry));
}
function creditReturnOptions(
  s: Workspace,
  invoice: Invoice,
  productId: string,
  pending: CreditNoteLine[] = [],
) {
  const returned = [
    ...s.creditNotes
      .filter((cn) => cn.status === 'Issued' && cn.invoiceId === invoice.id)
      .flatMap((cn) => cn.lines),
    ...pending,
  ]
    .filter((l) => l.productId === productId)
    .flatMap((l) => l.returns);
  return creditNotePicks(s, invoice, productId).map((pick) => ({
    ...pick,
    remaining:
      pick.qty -
      sum(
        returned.filter((p) => p.batchId === pick.batchId),
        (p) => p.qty,
      ),
  }));
}
function proposeCreditReturns(options: ReturnType<typeof creditReturnOptions>, baseQty: number) {
  let need = baseQty;
  return options.flatMap((pick) => {
    const qty = Math.max(0, Math.min(need, pick.remaining));
    need -= qty;
    return qty > 0 ? [{ batchId: pick.batchId, qty }] : [];
  });
}
function prepareCreditNote(s: Workspace, input: CreditNoteInput, id?: string, checkCaps = true) {
  const invoice = s.invoices.find((i) => i.id === input.invoiceId);
  required(invoice?.status === 'Issued', 'Select an issued invoice.');
  required(['return', 'correction'].includes(input.kind), 'Select return or correction.');
  required(creditReasons.includes(input.reason), 'Select a credit reason.');
  required(['refund', 'credit'].includes(input.settlement), 'Select refund or customer credit.');
  const date = dateCheck(input.date || today());
  required(
    date >= invoice.date && date <= today(),
    'Credit note date must be between the invoice date and today.',
  );
  const note = String(input.note || '').trim();
  required(input.reason !== 'other' || note, 'Enter a note for other.');
  const refundMethod = String(input.refundMethod || '').trim();
  required(input.settlement !== 'refund' || refundMethod, 'Select a refund method.');
  required(Array.isArray(input.lines) && input.lines.length, 'Add at least one credit note line.');
  const issued = checkCaps
    ? s.creditNotes.filter(
        (cn) => cn.id !== id && cn.invoiceId === invoice.id && cn.status === 'Issued',
      )
    : [];
  const priorLines = issued.flatMap((cn) => cn.lines);
  const lines: CreditNoteLine[] = [];
  const capMessage = 'This would credit more than was invoiced.';
  for (const inputLine of input.lines) {
    const index = inputLine.invoiceLineIndex;
    const original = invoice.lines[index];
    required(
      Number.isInteger(index) && original && !lines.some((l) => l.invoiceLineIndex === index),
      'Select a distinct invoice line.',
    );
    const qty = qtyCheck(inputLine.qty);
    required(qty <= original.qty, capMessage);
    const price =
      input.kind === 'return' ? original.price : moneyCheck(inputLine.price, 'Credit price');
    required((input.kind === 'return' || price > 0) && price <= original.price, capMessage);
    required(
      input.kind !== 'return' || inputLine.price === undefined || Number(inputLine.price) === price,
      'Return price must match the invoice price.',
    );
    const line: CreditNoteLine = { ...original, invoiceLineIndex: index, qty, price, returns: [] };
    if (input.kind === 'return') {
      const already = issued.filter((cn) => cn.kind === 'return').flatMap((cn) => cn.lines);
      required(
        qty +
          sum(
            already.filter((l) => l.invoiceLineIndex === index),
            (l) => l.qty,
          ) <=
          original.qty,
        capMessage,
      );
      const picks = creditNotePicks(s, invoice, original.productId);
      const used = [...already, ...lines]
        .filter((l) => l.productId === original.productId)
        .flatMap((l) => l.returns);
      const remaining = (batchId: string) =>
        (picks.find((p) => p.batchId === batchId)?.qty || 0) -
        sum(
          used.filter((p) => p.batchId === batchId),
          (p) => p.qty,
        );
      let returns = inputLine.returns;
      if (returns === undefined) {
        returns = proposeCreditReturns(
          picks.map((p) => ({ ...p, remaining: remaining(p.batchId) })),
          qty * original.factor,
        );
        required(sum(returns, (p) => Number(p.qty)) === qty * original.factor, capMessage);
      }
      required(Array.isArray(returns), 'Select return lots.');
      for (const returned of returns) {
        const pick = picks.find((p) => p.batchId === returned.batchId);
        required(
          pick && !line.returns.some((p) => p.batchId === returned.batchId),
          'Return lot must be one of the invoice picks.',
        );
        const returnQty = qtyCheck(returned.qty);
        required(returnQty <= remaining(pick.batchId), capMessage);
        line.returns.push({
          batchId: pick.batchId,
          warehouseId: pick.warehouseId,
          lotCode: pick.lotCode,
          qty: returnQty,
          cost: pick.cost,
        });
      }
      required(
        sum(line.returns, (p) => p.qty) === qty * original.factor,
        'Return quantities must match the credited base quantity.',
      );
    } else required(!inputLine.returns?.length, 'Price corrections cannot return stock.');
    required(
      round(
        sum(
          priorLines.filter((l) => l.invoiceLineIndex === index),
          (l) => l.qty * l.price,
        ) +
          qty * price,
      ) <= round(original.qty * original.price),
      capMessage,
    );
    lines.push(line);
  }
  const amounts = creditNoteAmounts(invoice, lines);
  required(round(sum(issued, (cn) => cn.total) + amounts.total) <= invoice.total, capMessage);
  return {
    invoiceId: invoice.id,
    customerId: invoice.customerId,
    date,
    kind: input.kind,
    reason: input.reason,
    note,
    lines,
    ...amounts,
    returnCost: sum(lines, (l) => sum(l.returns, (p) => p.qty * p.cost)),
    settlement: input.settlement,
    refundMethod,
  };
}
function saveCreditNote(s: Workspace, input: CreditNoteInput, id?: string): CreditNote {
  const previous = s.creditNotes.find((cn) => cn.id === id);
  required(!id || previous?.status === 'Draft', 'Only draft credit notes can be edited.');
  const prepared = prepareCreditNote(s, input, id);
  const cn: CreditNote = {
    ...prepared,
    id: id || uid('cn'),
    number: previous?.number || `CN-${String(s.counters.creditNote++).padStart(4, '0')}`,
    allocations: [],
    refunded: 0,
    status: 'Draft',
    createdAt: previous?.createdAt || new Date().toISOString(),
    createdBy: previous?.createdBy || CURRENT_USER,
  };
  if (id) s.creditNotes = s.creditNotes.map((c) => (c.id === id ? cn : c));
  else s.creditNotes.unshift(cn);
  return cn;
}
function deleteCreditNote(s: Workspace, id: string): void {
  required(
    s.creditNotes.find((cn) => cn.id === id)?.status === 'Draft',
    'Only draft credit notes can be deleted.',
  );
  s.creditNotes = s.creditNotes.filter((cn) => cn.id !== id);
}
function issueCreditNote(s: Workspace, id: string): CreditNote {
  const cn = s.creditNotes.find((cn) => cn.id === id);
  required(cn?.status === 'Draft', 'Only draft credit notes can be issued.');
  Object.assign(cn, prepareCreditNote(s, cn, id));
  const invoice = s.invoices.find((i) => i.id === cn.invoiceId)!;
  cn.lines.forEach((l) =>
    l.returns.forEach((p) => {
      p.returnBatchId = returnToStock(s, {
        batchId: p.batchId,
        qty: p.qty,
        quarantine: true,
        reference: cn.number,
        sourceId: cn.id,
        counterpartyId: cn.customerId,
        date: cn.date,
      }).id;
    }),
  );
  if (cn.returnCost)
    ledger(s, cn.date, cn.number, 'Returned stock \u2014 ' + invoice.number, [
      { account: 'inventory', debit: cn.returnCost },
      { account: 'cogs', credit: cn.returnCost },
    ]);
  ledger(s, cn.date, cn.number, 'Credit note \u2014 ' + invoice.number, [
    { account: 'revenue', debit: round(cn.subtotal - cn.discount) },
    { account: 'tax', debit: cn.taxAmount },
    { account: 'receivable', credit: cn.total },
  ]);
  const applied = Math.min(cn.total, invoiceBalance(invoice));
  if (applied > 0) {
    cn.allocations.push({ invoiceId: invoice.id, amount: applied, date: cn.date });
    invoice.credited = round(invoice.credited + applied);
  }
  const remainder = round(cn.total - applied);
  cn.status = 'Issued';
  if (cn.settlement === 'refund' && remainder > 0)
    refundCredit(
      s,
      { customerId: cn.customerId, amount: remainder, method: cn.refundMethod, date: cn.date },
      cn.id,
    );
  cn.issuedAt = new Date().toISOString();
  activity(
    s,
    'return',
    'Credit note issued',
    `${cn.number} · ${invoice.number}${cn.kind === 'return' ? '. Returned stock is in quarantine \u2014 release or write it off in Batches.' : ''}`,
    cn.date,
  );
  return cn;
}
const paymentMethods: CustomerPayment['method'][] = [
  'Bank transfer',
  'Cash',
  'Card',
  'Cheque',
  'Other',
];
const paymentCredit = (p: CustomerPayment) =>
  p.status === 'Posted' ? round(p.amount - sum(p.allocations, (a) => a.amount) - p.refunded) : 0;
const customerCredit = (s: Workspace, customerId: string) =>
  round(
    sum(
      s.payments.filter((p) => p.customerId === customerId),
      paymentCredit,
    ) +
      sum(
        s.creditNotes.filter((cn) => cn.customerId === customerId && cn.status === 'Issued'),
        creditAvailable,
      ),
  );
const openInvoices = (s: Workspace, customerId: string) =>
  s.invoices
    .filter((i) => i.customerId === customerId && i.status === 'Issued' && invoiceBalance(i) > 0)
    .sort((a, b) => a.due.localeCompare(b.due) || a.number.localeCompare(b.number));
function creditSources(s: Workspace, customerId: string) {
  return [
    ...s.payments
      .filter((p) => p.customerId === customerId && paymentCredit(p) > 0)
      .map((p) => ({ kind: 'payment' as const, source: p, available: paymentCredit(p) })),
    ...s.creditNotes
      .filter(
        (cn) => cn.customerId === customerId && cn.status === 'Issued' && creditAvailable(cn) > 0,
      )
      .map((cn) => ({ kind: 'credit_note' as const, source: cn, available: creditAvailable(cn) })),
  ].sort(
    (a, b) =>
      a.source.date.localeCompare(b.source.date) || a.source.number.localeCompare(b.source.number),
  );
}
function recordPayment(s: Workspace, input: CustomerPaymentInput): CustomerPayment {
  required(contact(s, input.customerId)?.type === 'Customer', 'Select a customer.');
  const amount = moneyCheck(input.amount);
  required(amount > 0, 'Payment must be positive.');
  const date = dateCheck(input.date);
  required(date <= today(), 'Payment date cannot be in the future.');
  required(paymentMethods.includes(input.method), 'Select a payment method.');
  let remaining = amount;
  const requested =
    input.allocations ??
    openInvoices(s, input.customerId)
      .map((i) => {
        const applied = Math.min(remaining, invoiceBalance(i));
        remaining = round(remaining - applied);
        return { invoiceId: i.id, amount: applied };
      })
      .filter((a) => a.amount > 0);
  const seen = new Set<string>();
  const allocations: PaymentAllocation[] = requested.map((a) => {
    const invoice = s.invoices.find((i) => i.id === a.invoiceId);
    required(
      invoice?.status === 'Issued' && invoice.customerId === input.customerId,
      'Select an issued invoice for this customer.',
    );
    required(!seen.has(invoice.id), 'An invoice may be allocated only once.');
    seen.add(invoice.id);
    const applied = moneyCheck(a.amount);
    required(
      applied > 0 && applied <= invoiceBalance(invoice),
      'Payment must be positive and cannot exceed the outstanding amount.',
    );
    return { invoiceId: invoice.id, amount: applied, date };
  });
  required(
    sum(allocations, (a) => a.amount) <= amount,
    'Allocations cannot exceed the payment amount.',
  );
  const p: CustomerPayment = {
    id: uid('pay'),
    number: `PAY-${String(s.counters.payment++).padStart(4, '0')}`,
    customerId: input.customerId,
    date,
    amount,
    method: input.method,
    reference: String(input.reference || '').trim(),
    note: String(input.note || '').trim(),
    allocations,
    voidedAllocations: [],
    refunded: 0,
    status: 'Posted',
    voidReason: '',
    voidDate: '',
    createdAt: new Date().toISOString(),
    createdBy: CURRENT_USER,
  };
  s.payments.unshift(p);
  allocations.forEach((a) => {
    const invoice = s.invoices.find((i) => i.id === a.invoiceId)!;
    invoice.paid = round(invoice.paid + a.amount);
  });
  ledger(s, date, p.number, 'Customer payment — ' + p.method, [
    { account: 'cash', debit: amount },
    { account: 'receivable', credit: amount },
  ]);
  activity(s, 'payment', 'Payment received', `${p.number} · ${p.method}`, date);
  return p;
}
function applyCredit(
  s: Workspace,
  input: { customerId: string; invoiceId: string; amount?: NumericInput; date?: string },
) {
  const invoice = s.invoices.find((i) => i.id === input.invoiceId);
  required(
    invoice?.status === 'Issued' && invoice.customerId === input.customerId,
    'Select an issued invoice for this customer.',
  );
  const available = customerCredit(s, input.customerId);
  const amount =
    input.amount === undefined
      ? Math.min(invoiceBalance(invoice), available)
      : moneyCheck(input.amount);
  required(
    amount > 0 && amount <= invoiceBalance(invoice) && amount <= available,
    'Amount must be positive and cannot exceed the invoice balance or available credit.',
  );
  const date = dateCheck(input.date ?? today());
  required(date <= today(), 'Allocation date cannot be in the future.');
  let remaining = amount;
  for (const { kind, source, available } of creditSources(s, input.customerId)) {
    const taken = Math.min(remaining, available);
    source.allocations.push({ invoiceId: invoice.id, amount: taken, date });
    if (kind === 'payment') invoice.paid = round(invoice.paid + taken);
    else invoice.credited = round(invoice.credited + taken);
    remaining = round(remaining - taken);
    if (!remaining) break;
  }
  return invoice;
}
function removeAllocation(
  s: Workspace,
  input: { source: 'payment' | 'credit_note'; id: string; invoiceId: string },
) {
  required(['payment', 'credit_note'].includes(input.source), 'Select a credit source.');
  const source =
    input.source === 'payment'
      ? s.payments.find((p) => p.id === input.id && p.status === 'Posted')
      : s.creditNotes.find((cn) => cn.id === input.id && cn.status === 'Issued');
  required(source, 'Credit source not found.');
  const allocations = source.allocations.filter((a) => a.invoiceId === input.invoiceId);
  required(allocations.length, 'Allocation not found.');
  const invoice = s.invoices.find((i) => i.id === input.invoiceId)!;
  const field = input.source === 'payment' ? 'paid' : 'credited';
  invoice[field] = round(invoice[field] - sum(allocations, (a) => a.amount));
  source.allocations = source.allocations.filter((a) => a.invoiceId !== input.invoiceId);
}
function refundCredit(
  s: Workspace,
  input: { customerId: string; amount: NumericInput; method: string; date: string },
  creditNoteId?: string,
): Refund {
  required(contact(s, input.customerId)?.type === 'Customer', 'Select a customer.');
  const amount = moneyCheck(input.amount);
  const sources = creditSources(s, input.customerId).filter(
    (x) => !creditNoteId || (x.kind === 'credit_note' && x.source.id === creditNoteId),
  );
  required(
    amount > 0 && amount <= sum(sources, (x) => x.available),
    'Refund must be positive and cannot exceed available credit.',
  );
  const method = String(input.method || '').trim();
  required(method, 'Select a refund method.');
  const date = dateCheck(input.date);
  required(date <= today(), 'Refund date cannot be in the future.');
  const refund: Refund = {
    id: uid('refund'),
    customerId: input.customerId,
    amount,
    method,
    date,
    from: [],
    createdBy: CURRENT_USER,
  };
  let remaining = amount;
  for (const { kind, source, available } of sources) {
    const taken = Math.min(remaining, available);
    source.refunded = round(source.refunded + taken);
    refund.from.push({ kind, id: source.id, amount: taken });
    remaining = round(remaining - taken);
    if (!remaining) break;
  }
  s.refunds.unshift(refund);
  ledger(
    s,
    date,
    creditNoteId ? s.creditNotes.find((cn) => cn.id === creditNoteId)!.number : refund.id,
    'Refund — ' + method,
    [
      { account: 'receivable', debit: amount },
      { account: 'cash', credit: amount },
    ],
  );
  return refund;
}
function voidPayment(s: Workspace, id: string, reason: string, date = today()) {
  const p = s.payments.find((p) => p.id === id);
  required(p?.status === 'Posted', 'Only posted payments can be voided.');
  required(p.refunded === 0, 'Payments with refunds cannot be voided.');
  reason = String(reason || '').trim();
  required(reason, 'Enter a void reason.');
  dateCheck(date);
  required(
    date >= p.date && date <= today(),
    'Void date must be between the payment date and today.',
  );
  p.voidedAllocations = p.allocations.map((a) => ({ ...a }));
  [...p.allocations].forEach((a) => {
    if (p.allocations.some((entry) => entry.invoiceId === a.invoiceId))
      removeAllocation(s, { source: 'payment', id, invoiceId: a.invoiceId });
  });
  ledger(s, date, p.number, 'Payment voided — ' + reason, [
    { account: 'receivable', debit: p.amount },
    { account: 'cash', credit: p.amount },
  ]);
  p.status = 'Voided';
  p.voidReason = reason;
  p.voidDate = date;
  return p;
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
  return recordPayment(s, {
    customerId: i.customerId,
    date,
    amount,
    method: method as CustomerPayment['method'],
    allocations: [{ invoiceId: id, amount }],
  });
}
function deleteDraft(s: Workspace, id: string) {
  required(s.invoices.find((i) => i.id === id)?.status === 'Draft', 'Only drafts can be deleted.');
  releaseInvoiceReservations(s, id);
  s.invoices = s.invoices.filter((i) => i.id !== id);
}
function lastPurchasePrice(
  s: Workspace,
  supplierId: string,
  productId: string,
  unit: Unit,
): { price: number; date: string; reference: string } | null {
  const receipts = s.receipts
    .filter((r) => r.supplierId === supplierId && r.purchaseId)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.number.localeCompare(a.number, undefined, { numeric: true }) ||
        b.number.localeCompare(a.number),
    );
  for (const r of receipts) {
    const line = r.lines.find((l) => l.productId === productId && l.unit === unit);
    if (line) {
      return { price: line.price, date: r.date, reference: r.number };
    }
  }
  return null;
}
function purchaseLinePrice(
  s: Workspace,
  supplierId: string,
  productId: string,
  unit: Unit,
): number {
  const p = product(s, productId);
  required(p, 'Select a product.');
  const last = lastPurchasePrice(s, supplierId, productId, unit);
  return last?.price ?? unitPrice(p, unit, true);
}
function expectedDate(s: Workspace, supplierId: string, orderDate = today()): string {
  const c = contact(s, supplierId);
  return shift(c?.leadTimeDays ?? 0, orderDate);
}
function belowMinimumOrder(s: Workspace, supplierId: string, total: NumericInput): number | null {
  const c = contact(s, supplierId);
  if (!c || c.minOrderValue === null) return null;
  const t = Number(total);
  return t < c.minOrderValue ? c.minOrderValue : null;
}
const formatLimit = (limit: number) =>
  new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(limit);

function approvalRequired(
  s: Workspace,
  po: { total: number; approval?: PurchaseApproval },
): boolean {
  return (
    s.settings.poApprovalLimit > 0 &&
    po.total > s.settings.poApprovalLimit &&
    !(po.approval && po.approval.amount >= po.total)
  );
}
function createPurchase(s: Workspace, data: PurchaseInput): Purchase {
  required(contact(s, data.supplierId)?.type === 'Supplier', 'Select a supplier.');
  required(warehouse(s, data.warehouseId), 'Select a receiving warehouse.');
  dateCheck(data.date);
  dateCheck(data.expected);
  required(data.expected >= data.date, 'Expected delivery must be on or after the order date.');
  const mappedLines = (data.lines || []).map((l) => {
    if (l.cost === undefined) {
      const p = product(s, l.productId);
      const unit = l.unit ?? p?.unit;
      if (p && unit) {
        return {
          ...l,
          cost: purchaseLinePrice(s, data.supplierId, l.productId, unit),
        };
      }
    }
    return l;
  });
  const lines = normalizedLines(s, mappedLines, 'cost');
  const total = sum(lines, (l) => l.qty * l.price);
  required(total > 0, 'Purchase order total must be greater than zero.');

  if (data.send) {
    required(
      !approvalRequired(s, { total }),
      `Purchase orders over $${formatLimit(s.settings.poApprovalLimit)} need approval before sending.`,
    );
    required(data.date <= today(), 'Send date must be between the order date and today.');
  }

  const po: Purchase = {
    id: uid('purchase'),
    number: `PO-${String(s.counters.purchase++).padStart(4, '0')}`,
    supplierId: data.supplierId,
    warehouseId: data.warehouseId,
    date: data.date,
    expected: data.expected,
    lines: lines.map((l) => ({ ...l, id: uid('pol'), closedQty: 0 })),
    total,
    status: 'Draft',
    notes: String(data.notes || ''),
    createdAt: new Date().toISOString(),
    createdBy: CURRENT_USER,
  };
  s.purchases.unshift(po);
  activity(
    s,
    'order',
    'Purchase order created',
    `${po.number} · ${contact(s, po.supplierId)!.name}`,
  );
  if (data.send) {
    sendPurchase(s, po.id, data.date > today() ? today() : data.date);
  }
  return po;
}
function savePurchase(s: Workspace, data: PurchaseInput, id: string): Purchase {
  const po = s.purchases.find((p) => p.id === id);
  required(po && ['Draft', 'Sent'].includes(po.status), 'Only open purchase orders can be edited.');
  if (po.status === 'Sent') {
    required(
      po.supplierId === data.supplierId,
      "The supplier can't change after the order was sent. Cancel it and create a new one.",
    );
  }
  const poReceipts = s.receipts.filter((r) => r.purchaseId === po.id);
  if (po.status === 'Sent' && poReceipts.length > 0) {
    required(
      po.warehouseId === data.warehouseId,
      "The warehouse can't change after goods were received.",
    );
  }
  required(contact(s, data.supplierId)?.type === 'Supplier', 'Select a supplier.');
  required(warehouse(s, data.warehouseId), 'Select a receiving warehouse.');
  dateCheck(data.date);
  dateCheck(data.expected);
  required(data.expected >= data.date, 'Expected delivery must be on or after the order date.');

  const mappedLines = (data.lines || []).map((l) => {
    if (l.cost === undefined) {
      const p = product(s, l.productId);
      const unit = l.unit ?? p?.unit;
      if (p && unit) {
        return {
          ...l,
          cost: purchaseLinePrice(s, data.supplierId, l.productId, unit),
        };
      }
    }
    return l;
  });
  const normalized = normalizedLines(s, mappedLines, 'cost');
  const total = sum(normalized, (l) => l.qty * l.price);
  required(total > 0, 'Purchase order total must be greater than zero.');

  const lineIds = new Set<string>();
  const lines: PurchaseLine[] = normalized.map((line, index) => {
    const inputLine = (data.lines || [])[index];
    const lineId = inputLine?.id;
    const old = lineId ? po.lines.find((l) => l.id === lineId) : undefined;
    required(!lineId || old, 'Unknown purchase order line.');
    const received = old ? receivedQty(s, po, old.id) : 0;
    const closedQty = old?.closedQty ?? 0;
    if (po.status === 'Sent' && received > 0) {
      required(
        line.productId === old!.productId && line.unit === old!.unit && line.factor === old!.factor,
        `${old!.name} was already received; its product and unit can't change.`,
      );
      required(
        line.qty >= received + closedQty,
        `${line.name}: quantity can't go below the ${received} already received.`,
      );
    }
    const result: PurchaseLine = { ...line, id: old?.id || uid('pol'), closedQty };
    required(!lineIds.has(result.id), 'Purchase order contains duplicate lines.');
    lineIds.add(result.id);
    return result;
  });

  if (po.status === 'Sent') {
    po.lines.forEach((l) => {
      if (!lineIds.has(l.id)) {
        const received = receivedQty(s, po, l.id);
        required(received === 0, `${l.name} was already received and can't be removed.`);
      }
    });
  }

  po.supplierId = data.supplierId;
  po.warehouseId = data.warehouseId;
  po.date = data.date;
  po.expected = data.expected;
  po.lines = lines;
  po.total = total;
  po.notes = String(data.notes || '');

  if (po.status === 'Sent' && lines.every((l) => openQty(s, po, l) === 0)) {
    const latestDate =
      poReceipts
        .map((r) => r.date)
        .sort()
        .reverse()[0] || po.date;
    po.status = 'Received';
    po.received = latestDate;
  }

  if (approvalRequired(s, po) && po.approval) {
    delete po.approval;
    if (po.status === 'Sent') {
      po.status = 'Draft';
      delete po.sentAt;
      delete po.sentBy;
    }
    activity(s, 'order', 'Purchase order changed — needs approval again', po.number);
  }
  return po;
}
// ponytail: anyone can approve until roles exist; restrict to managers then
function approvePurchase(s: Workspace, id: string, note = ''): Purchase {
  const po = s.purchases.find((p) => p.id === id);
  required(po, 'Purchase order not found.');
  required(po.status === 'Draft', 'Only draft purchase orders can be approved.');
  required(
    s.settings.poApprovalLimit > 0 && po.total > s.settings.poApprovalLimit,
    "This purchase order doesn't need approval.",
  );
  po.approval = {
    by: CURRENT_USER,
    at: new Date().toISOString(),
    amount: po.total,
    note: String(note || '').trim(),
  };
  activity(s, 'order', 'Purchase order approved', po.number);
  return po;
}
function sendPurchase(s: Workspace, id: string, date = today()): Purchase {
  const po = s.purchases.find((p) => p.id === id);
  required(po, 'Purchase order not found.');
  required(po.status === 'Draft', 'Only draft purchase orders can be sent.');
  required(
    !approvalRequired(s, po),
    `Purchase orders over $${formatLimit(s.settings.poApprovalLimit)} need approval before sending.`,
  );
  dateCheck(date);
  required(
    date >= po.date && date <= today(),
    'Send date must be between the order date and today.',
  );
  po.status = 'Sent';
  po.sentAt = date;
  po.sentBy = CURRENT_USER;
  activity(s, 'order', 'Purchase order sent', po.number);
  return po;
}
function receivePurchase(
  s: Workspace,
  id: string,
  input:
    | PurchaseReceiveInput
    | Array<{
        code: string;
        expiry: string;
        qty?: number;
        price?: number;
        purchaseLineId?: string;
      }>,
  legacyDate?: string,
): Receipt {
  const po = s.purchases.find((p) => p.id === id);
  required(po, 'Purchase order not found.');
  required(po.status !== 'Draft', 'Send this purchase order before receiving it.');
  required(po.status === 'Sent', 'Only sent purchase orders can be received.');

  const actualInput: PurchaseReceiveInput = Array.isArray(input)
    ? {
        date: legacyDate || today(),
        lines: input.map((item, idx) => ({
          purchaseLineId: item.purchaseLineId || po.lines[idx]?.id || '',
          qty: item.qty ?? (po.lines[idx] ? openQty(s, po, po.lines[idx].id) : 0),
          price: item.price,
          code: item.code,
          expiry: item.expiry,
        })),
      }
    : input;

  const date = actualInput.date || today();
  dateCheck(date);
  required(
    date >= po.date && date <= today(),
    'Receipt date must be between the order date and today.',
  );
  required(
    Array.isArray(actualInput.lines) && actualInput.lines.length > 0,
    'Enter the quantity received for at least one line.',
  );

  const supplier = contact(s, po.supplierId);
  required(supplier, 'Supplier not found.');

  type ParsedLine = {
    poLine: PurchaseLine;
    qty: number;
    price: number;
    batchCost: number;
    code: string;
    expiry: string;
  };

  const parsedLines: ParsedLine[] = [];
  const lineQtyMap = new Map<string, number>();

  for (let i = 0; i < actualInput.lines.length; i++) {
    const item = actualInput.lines[i];
    const poLine = po.lines.find((l) => l.id === item.purchaseLineId);
    required(poLine, 'Unknown purchase order line.');

    const qty = qtyCheck(item.qty);
    const price = item.price !== undefined ? moneyCheck(item.price, 'Unit cost') : poLine.price;
    const batchCost = round(price / poLine.factor);

    dateCheck(item.expiry);
    required(daysLeft(item.expiry) > 0, 'Every expiry date must be in the future.');
    const code = String(item.code || '').trim();
    required(code, 'Enter every batch number.');

    const existing = s.batches.find(
      (x) =>
        x.productId === poLine.productId &&
        x.code.toLowerCase() === code.toLowerCase() &&
        x.warehouseId === po.warehouseId &&
        !x.quarantined,
    );
    required(
      !existing || (existing.expiry === item.expiry && existing.cost === batchCost),
      'An existing batch has conflicting expiry or cost.',
    );

    for (let j = 0; j < i; j++) {
      const prev = parsedLines[j];
      if (
        prev.poLine.productId === poLine.productId &&
        prev.code.toLowerCase() === code.toLowerCase()
      ) {
        required(
          prev.expiry === item.expiry && prev.batchCost === batchCost,
          'Duplicate lot numbers must have matching expiry and cost.',
        );
      }
    }

    lineQtyMap.set(poLine.id, (lineQtyMap.get(poLine.id) || 0) + qty);
    parsedLines.push({
      poLine,
      qty,
      price,
      batchCost,
      code,
      expiry: item.expiry,
    });
  }

  for (const [lineId, totalQty] of lineQtyMap.entries()) {
    const poLine = po.lines.find((l) => l.id === lineId)!;
    const open = openQty(s, po, poLine);
    required(
      totalQty <= open,
      `${poLine.name}: only ${open} ${poLine.unit} still open on this order. Raise the PO quantity first.`,
    );
  }

  const receiptNumber = `GRN-${String(s.counters.receipt++).padStart(4, '0')}`;
  const receiptId = uid('receipt');
  const receiptTotal = round(sum(parsedLines, (l) => l.qty * l.price));
  const due = shift(supplier.paymentTermsDays, date);

  const receiptLines: ReceiptLine[] = [];

  for (const line of parsedLines) {
    const batch = addBatch(
      s,
      {
        productId: line.poLine.productId,
        qty: line.qty * line.poLine.factor,
        cost: line.batchCost,
        warehouseId: po.warehouseId,
        code: line.code,
        expiry: line.expiry,
        received: date,
      },
      {
        date,
        reference: receiptNumber,
        sourceId: receiptId,
        counterpartyId: po.supplierId,
      },
    );

    receiptLines.push({
      productId: line.poLine.productId,
      name: line.poLine.name,
      sku: line.poLine.sku,
      unit: line.poLine.unit,
      factor: line.poLine.factor,
      qty: line.qty,
      price: line.price,
      orderedPrice: line.poLine.price,
      purchaseLineId: line.poLine.id,
      batchId: batch.id,
      lotCode: batch.code,
      expiry: batch.expiry,
    });
  }

  const receipt: Receipt = {
    id: receiptId,
    number: receiptNumber,
    date,
    supplierId: po.supplierId,
    warehouseId: po.warehouseId,
    purchaseId: po.id,
    reference: String(actualInput.reference || '').trim(),
    lines: receiptLines,
    total: receiptTotal,
    paid: 0,
    credited: 0,
    due,
    notes: String(actualInput.notes || '').trim(),
    createdAt: new Date().toISOString(),
    createdBy: CURRENT_USER,
  };
  s.receipts.unshift(receipt);

  const inventoryDebit = sum(receiptLines, (l) =>
    round(l.qty * l.factor * round(l.price / l.factor)),
  );

  ledger(
    s,
    date,
    receipt.number,
    'Goods receipt — ' +
      supplier.name +
      ' · ' +
      po.number +
      (receipt.total !== inventoryDebit ? ' · Purchase rounding' : ''),
    purchaseEntries(inventoryDebit, receipt.total, 'payable'),
  );

  if (actualInput.closeRemaining) {
    closeRemaining(s, po.id, actualInput.closeRemaining.reason);
  } else if (po.lines.every((l) => openQty(s, po, l) === 0)) {
    po.status = 'Received';
    po.received = date;
  }

  activity(
    s,
    'receive',
    'Goods received',
    `${receipt.number} · ${po.number} · ${warehouse(s, po.warehouseId)!.name}`,
    date,
  );

  return receipt;
}
function closeRemaining(s: Workspace, id: string, reason: string): Purchase {
  const po = s.purchases.find((p) => p.id === id);
  required(po, 'Purchase order not found.');
  required(po.status === 'Sent', 'Only sent purchase orders can be closed.');
  const poReceipts = s.receipts.filter((r) => r.purchaseId === po.id);
  required(poReceipts.length > 0, 'Nothing was received yet. Cancel the order instead.');
  const r = String(reason || '').trim();
  required(r, 'Enter a reason for closing the rest of the order.');
  for (const line of po.lines) {
    line.closedQty += openQty(s, po, line);
  }
  po.status = 'Received';
  const latestDate =
    poReceipts
      .map((rc) => rc.date)
      .sort()
      .reverse()[0] || po.date;
  po.received = latestDate;
  po.closeReason = r;
  activity(s, 'order', 'Purchase order closed short', po.number);
  return po;
}
function payBill(s: Workspace, id: string, amount: NumericInput, date = today()) {
  const bill = s.receipts.find((x) => x.id === id);
  required(bill, 'This supplier bill is not ready for payment.');
  amount = moneyCheck(amount);
  required(
    amount > 0 && amount <= billBalance(bill),
    'Payment must be positive and cannot exceed the bill balance.',
  );
  dateCheck(date);
  required(
    date >= bill.date && date <= today(),
    'Choose a payment date between receipt and today.',
  );
  bill.paid = round(bill.paid + Number(amount));
  ledger(s, date, bill.number, 'Supplier payment', [
    { account: 'payable', debit: amount },
    { account: 'cash', credit: amount },
  ]);
  activity(s, 'payment', 'Supplier payment recorded', bill.number, date);
}
function cancelPurchase(s: Workspace, id: string, reason = ''): Purchase {
  const p = s.purchases.find((x) => x.id === id);
  required(p && ['Draft', 'Sent'].includes(p.status), 'Only open purchase orders can be canceled.');
  required(
    !s.receipts.some((r) => r.purchaseId === p.id),
    'Part of this order was already received. Close the remainder instead.',
  );
  if (p.status === 'Sent') {
    required(String(reason || '').trim(), 'Enter a reason for canceling a sent order.');
  }
  p.status = 'Canceled';
  const r = String(reason || '').trim();
  if (r) p.cancelReason = r;
  activity(s, 'order', 'Purchase order canceled', p.number);
  return p;
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
function accountDays(value: unknown, label: string): number {
  required(
    Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 365,
    `${label} must be a whole number between 0 and 365 days.`,
  );
  return Number(value);
}
function setPurchaseSettings(s: Workspace, data: { poApprovalLimit: NumericInput } | NumericInput) {
  const value =
    typeof data === 'object' && data !== null && 'poApprovalLimit' in data
      ? (data as { poApprovalLimit: NumericInput }).poApprovalLimit
      : data;
  s.settings.poApprovalLimit = moneyCheck(value, 'Approval limit');
}
function setAccountSettings(
  s: Workspace,
  data: { defaultPaymentTermsDays: NumericInput; overdueGraceDays: NumericInput },
) {
  const terms = accountDays(Number(data.defaultPaymentTermsDays), 'Default payment terms');
  const grace = accountDays(Number(data.overdueGraceDays), 'Overdue grace period');
  s.settings.defaultPaymentTermsDays = terms;
  s.settings.overdueGraceDays = grace;
}
function accountDefaults(s: Workspace) {
  return {
    groupId: '',
    paymentTermsDays: s.settings.defaultPaymentTermsDays,
    creditLimit: null,
    onHold: false,
    holdReason: '',
    billing: 'per_delivery' as const,
    leadTimeDays: 0,
    minOrderValue: null,
  };
}
function validateAccount(s: Workspace, c: Contact) {
  accountDays(c.paymentTermsDays, 'Payment terms');
  accountDays(c.leadTimeDays, 'Lead time');
  required(
    c.minOrderValue === null || typeof c.minOrderValue === 'number',
    'Minimum order must be a number or null.',
  );
  if (c.minOrderValue !== null) {
    moneyCheck(c.minOrderValue, 'Minimum order');
    required(c.minOrderValue > 0, 'Minimum order must be greater than zero.');
  }
  if (c.type === 'Customer') {
    required(
      c.leadTimeDays === 0 && c.minOrderValue === null,
      'Customer must have default lead time and minimum order.',
    );
    required(
      c.creditLimit === null || typeof c.creditLimit === 'number',
      'Enter a valid credit limit.',
    );
    if (c.creditLimit !== null) moneyCheck(c.creditLimit, 'Credit limit');
    required(typeof c.onHold === 'boolean', 'On hold must be a boolean.');
    required(typeof c.holdReason === 'string', 'Enter a hold reason.');
    required(!c.onHold || c.holdReason.trim(), 'Enter a hold reason.');
    required(
      c.groupId === '' || s.customerGroups.some((g) => g.id === c.groupId),
      'Select a valid customer group.',
    );
    required(['per_delivery', 'monthly'].includes(c.billing), 'Select a valid billing habit.');
  }
}
function saveCustomerGroup(
  s: Workspace,
  data: { name: string; discountPercent?: number },
  id?: string,
) {
  const previous = s.customerGroups.find((g) => g.id === id);
  required(!id || previous, 'Customer group not found.');
  const name = String(data.name || '').trim();
  required(
    name.length >= 2 && name.length <= 40,
    'Group name must be between 2 and 40 characters.',
  );
  required(
    !s.customerGroups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase()),
    'Customer group names must be unique.',
  );
  const discountPercent = data.discountPercent ?? previous?.discountPercent ?? 0;
  required(
    Number.isFinite(discountPercent) && discountPercent >= 0 && discountPercent <= 100,
    'Discount must be between 0 and 100.',
  );
  const group: CustomerGroup = { id: id || uid('grp'), name, discountPercent };
  if (id) s.customerGroups = s.customerGroups.map((g) => (g.id === id ? group : g));
  else s.customerGroups.push(group);
  return group;
}
function deleteCustomerGroup(s: Workspace, id: string) {
  const group = s.customerGroups.find((g) => g.id === id);
  required(group, 'Customer group not found.');
  const count = s.contacts.filter((c) => c.type === 'Customer' && c.groupId === id).length;
  required(count === 0, `${group.name} is used by ${count} customers.`);
  s.customerGroups = s.customerGroups.filter((g) => g.id !== id);
  s.prices = s.prices.filter((e) => e.groupId !== id);
}
function contactInUse(s: Workspace, id: string): boolean {
  return (
    s.invoices.some((i) => i.customerId === id) ||
    s.orders.some((o) => o.customerId === id) ||
    s.deliveries.some((d) => d.customerId === id) ||
    s.reservations.some((r) => r.customerId === id) ||
    s.payments.some((p) => p.customerId === id) ||
    s.refunds.some((r) => r.customerId === id) ||
    s.creditNotes.some((cn) => cn.customerId === id) ||
    s.prices.some((p) => p.customerId === id) ||
    s.purchases.some((p) => p.supplierId === id) ||
    s.receipts.some((r) => r.supplierId === id) ||
    s.products.some((p) => p.supplierId === id)
  );
}
function saveContact(s: Workspace, data: ContactInput, id?: string) {
  required(['Customer', 'Supplier'].includes(data.type), 'Select a contact type.');
  required(String(data.name || '').trim().length >= 2, 'Enter a contact name.');
  const old = id ? contact(s, id) : undefined;
  const c: Contact = {
    ...accountDefaults(s),
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
          ? (old?.minShelfLifeDays ?? null)
          : shelfLifeCheck(Number(data.minShelfLifeDays)),
  };
  if (c.type === 'Customer') {
    c.leadTimeDays = 0;
    c.minOrderValue = null;
    const old = id ? contact(s, id) : undefined;
    c.groupId = data.groupId ?? old?.groupId ?? '';
    c.paymentTermsDays =
      data.paymentTermsDays === undefined
        ? (old?.paymentTermsDays ?? s.settings.defaultPaymentTermsDays)
        : accountDays(Number(data.paymentTermsDays), 'Payment terms');
    c.creditLimit =
      data.creditLimit === undefined
        ? (old?.creditLimit ?? null)
        : data.creditLimit === null || data.creditLimit === ''
          ? null
          : moneyCheck(data.creditLimit, 'Credit limit');
    c.onHold = data.onHold ?? old?.onHold ?? false;
    c.holdReason = String(data.holdReason ?? old?.holdReason ?? '').trim();
    c.billing = data.billing ?? old?.billing ?? 'per_delivery';
    validateAccount(s, c);
  } else if (c.type === 'Supplier') {
    c.paymentTermsDays =
      data.paymentTermsDays === undefined
        ? (old?.paymentTermsDays ?? s.settings.defaultPaymentTermsDays)
        : accountDays(Number(data.paymentTermsDays), 'Payment terms');
    c.leadTimeDays =
      data.leadTimeDays === undefined
        ? (old?.leadTimeDays ?? 0)
        : accountDays(Number(data.leadTimeDays), 'Lead time');
    if (data.minOrderValue === undefined) {
      c.minOrderValue = old?.minOrderValue ?? null;
    } else if (data.minOrderValue === null || data.minOrderValue === '') {
      c.minOrderValue = null;
    } else {
      const val = moneyCheck(data.minOrderValue, 'Minimum order');
      required(val > 0, 'Minimum order must be greater than zero.');
      c.minOrderValue = val;
    }
    validateAccount(s, c);
  }
  if (id) {
    const old = contact(s, id);
    required(old, 'Contact not found.');
    required(
      old.type === c.type || !contactInUse(s, id),
      'This contact has transaction history, so its type cannot be changed.',
    );
    s.contacts = s.contacts.map((x) => (x.id === id ? c : x));
  } else s.contacts.push(c);
  return c;
}
// Dated source documents, rather than today's paid/credited/refunded caches, drive reports.
function receivableEvents(
  s: Workspace,
  customerId: string,
): Omit<Statement['lines'][number], 'balance'>[] {
  const events: Omit<Statement['lines'][number], 'balance'>[] = [];
  const add = (
    date: string,
    type: Statement['lines'][number]['type'],
    reference: string,
    description: string,
    debit: number,
    credit: number,
  ) => events.push({ date, type, reference, description, debit, credit });
  s.invoices
    .filter((i) => i.customerId === customerId && i.status === 'Issued')
    .forEach((i) => add(i.date, 'Invoice', i.number, `Invoice due ${i.due}`, i.total, 0));
  s.creditNotes
    .filter((cn) => cn.customerId === customerId && cn.status === 'Issued')
    .forEach((cn) =>
      add(
        cn.date,
        'Credit note',
        cn.number,
        cn.note || cn.reason.replaceAll('_', ' '),
        0,
        cn.total,
      ),
    );
  s.payments
    .filter((p) => p.customerId === customerId)
    .forEach((p) => {
      add(
        p.date,
        'Payment',
        p.number,
        `${p.method}${p.reference ? ` · ${p.reference}` : ''}`,
        0,
        p.amount,
      );
      if (p.status === 'Voided')
        add(p.voidDate, 'Payment voided', p.number, p.voidReason, p.amount, 0);
    });
  s.refunds
    .filter((r) => r.customerId === customerId)
    .forEach((r) => {
      const reference = r.from
        .map((f) =>
          f.kind === 'payment'
            ? s.payments.find((p) => p.id === f.id)!.number
            : s.creditNotes.find((cn) => cn.id === f.id)!.number,
        )
        .join(', ');
      add(r.date, 'Refund', reference, `Refund · ${r.method}`, r.amount, 0);
    });
  const order = { Invoice: 0, 'Credit note': 1, Payment: 2, 'Payment voided': 3, Refund: 4 };
  return events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      order[a.type] - order[b.type] ||
      a.reference.localeCompare(b.reference),
  );
}
function invoiceOpenAt(s: Workspace, invoice: Invoice, asOf: string): number {
  if (invoice.status !== 'Issued' || invoice.date > asOf) return 0;
  const allocated = (allocations: PaymentAllocation[]) =>
    sum(
      allocations.filter((a) => a.invoiceId === invoice.id && a.date <= asOf),
      (a) => a.amount,
    );
  return round(
    invoice.total -
      sum(
        s.payments.filter((p) => p.date <= asOf && (p.status === 'Posted' || p.voidDate > asOf)),
        (p) => allocated(p.status === 'Voided' ? p.voidedAllocations : p.allocations),
      ) -
      sum(
        s.creditNotes.filter((cn) => cn.status === 'Issued' && cn.date <= asOf),
        (cn) => allocated(cn.allocations),
      ),
  );
}
const emptyAging = (customerId: string): AgingRow => ({
  customerId,
  current: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90plus: 0,
  credit: 0,
  total: 0,
});
function customerAging(s: Workspace, customerId: string, asOf: string): AgingRow {
  const row = emptyAging(customerId);
  s.invoices
    .filter((i) => i.customerId === customerId)
    .forEach((i) => {
      const open = invoiceOpenAt(s, i, asOf),
        days = daysLeft(asOf, i.due);
      const bucket =
        days <= 0
          ? 'current'
          : days <= 30
            ? 'd1_30'
            : days <= 60
              ? 'd31_60'
              : days <= 90
                ? 'd61_90'
                : 'd90plus';
      row[bucket] = round(row[bucket] + open);
    });
  row.total =
    sum(
      receivableEvents(s, customerId).filter((e) => e.date <= asOf),
      (e) => e.debit - e.credit,
    ) || 0;
  // The difference is unapplied credit: allocations move it into invoice buckets without a posting.
  row.credit = round(row.current + row.d1_30 + row.d31_60 + row.d61_90 + row.d90plus - row.total);
  return row;
}
function agingReport(s: Workspace, asOf = today()): AgingRow[] {
  dateCheck(asOf);
  const rows = s.contacts
    .filter((c) => c.type === 'Customer')
    .map((c) => customerAging(s, c.id, asOf))
    .filter((r) => r.current || r.d1_30 || r.d31_60 || r.d61_90 || r.d90plus || r.credit);
  // An empty customerId identifies the totals row and is never a customer reference.
  const totals = emptyAging('');
  for (const key of ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'credit', 'total'] as const)
    totals[key] = sum(rows, (r) => r[key]);
  return [...rows, totals];
}
function customerStatement(
  s: Workspace,
  customerId: string,
  { from, to }: { from: string; to: string },
): Statement {
  required(contact(s, customerId)?.type === 'Customer', 'Select a customer.');
  dateCheck(from);
  dateCheck(to);
  required(from <= to, 'Statement end date cannot be before its start date.');
  const events = receivableEvents(s, customerId);
  const opening =
    sum(
      events.filter((e) => e.date < from),
      (e) => e.debit - e.credit,
    ) || 0;
  let balance = opening;
  const lines = events
    .filter((e) => e.date >= from && e.date <= to)
    .map((e) => {
      balance = round(balance + e.debit - e.credit) || 0;
      return { ...e, balance };
    });
  return { opening, lines, closing: balance, aging: customerAging(s, customerId, to) };
}
function overdueAmount(
  s: Workspace,
  customerId: string,
  graceDays: number,
  asOf = today(),
): number {
  dateCheck(asOf);
  return sum(
    s.invoices.filter((i) => i.customerId === customerId && daysLeft(i.due, asOf) < -graceDays),
    (i) => invoiceOpenAt(s, i, asOf),
  );
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
      order: 1,
      delivery: 1,
      creditNote: 1,
      payment: 1,
      receipt: 1,
    },
    products: [],
    batches: [],
    contacts: [],
    customerGroups: [],
    prices: [],
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
    orders: [],
    deliveries: [],
    creditNotes: [],
    payments: [],
    refunds: [],
  };
}
function seed(): Workspace {
  const s: Workspace = {
    version: 4,
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
      defaultPaymentTermsDays: 30,
      overdueGraceDays: 7,
      poApprovalLimit: 2000,
    },
    counters: {
      invoice: 1024,
      purchase: 208,
      transfer: 1,
      adjustment: 1,
      count: 1,
      recall: 1,
      reservation: 1,
      order: 1,
      delivery: 1,
      creditNote: 1,
      payment: 1,
      receipt: 1,
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
    orders: [],
    deliveries: [],
    creditNotes: [],
    payments: [],
    refunds: [],
    journal: [],
    contacts: [],
    customerGroups: [],
    prices: [],
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
  [
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
      paymentTermsDays: 30,
      leadTimeDays: 2,
      minOrderValue: null,
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
      paymentTermsDays: 45,
      leadTimeDays: 5,
      minOrderValue: 500,
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
      paymentTermsDays: 15,
      leadTimeDays: 3,
      minOrderValue: null,
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
      paymentTermsDays: 0,
      leadTimeDays: 7,
      minOrderValue: 300,
    },
  ].forEach((data) => {
    const c = saveContact(s, { ...data, type: data.type as Contact['type'] });
    c.id = data.id;
  });
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
          : n === 1
            ? { productId: 'p2', qty: 132, cost: 8.2 }
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
    if (approvalRequired(s, po)) approvePurchase(s, po.id, 'Approved');
    sendPurchase(s, po.id, date);
    const rc = receivePurchase(s, po.id, {
      date: shift(4, date),
      lines: po.lines.map((l, i) => ({
        purchaseLineId: l.id,
        qty: l.qty,
        code: `RC-${n + 1}-${i + 1}`,
        expiry: shift(430 + n * 10),
      })),
    });
    if (n < 4) payBill(s, rc.id, rc.total, shift(7, date));
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
    issueInvoice(s, inv.id, { reason: 'Consolidated bank remittance pending' });
    if (![0, 5, 10].includes(n) && (n < 48 || n % 3 === 0))
      payInvoice(
        s,
        inv.id,
        inv.total,
        'Bank transfer',
        date > today() ? today() : shift(2, date) > today() ? today() : shift(2, date),
      );
    else if (![0, 5, 10].includes(n) && n % 4 === 0)
      payInvoice(s, inv.id, round(inv.total / 2), 'Cash', date > today() ? today() : date);
  }
  const greenlifeInvoices = s.invoices.filter(
    (i) => i.customerId === 'c1' && i.paid === 0 && i.date <= shift(-147),
  );
  recordPayment(s, {
    customerId: 'c1',
    date: shift(-145),
    amount: sum(greenlifeInvoices, (i) => i.total),
    method: 'Bank transfer',
    reference: 'GL consolidated remittance',
    allocations: greenlifeInvoices.map((i) => ({ invoiceId: i.id, amount: i.total })),
  });
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
  const openPo1 = createPurchase(s, {
    supplierId: 's2',
    warehouseId: 'wh_main',
    date: shift(-3),
    expected: expectedDate(s, 's2', shift(-3)),
    lines: [
      { productId: 'p5', qty: 180, cost: 8.5 },
      { productId: 'p10', qty: 80, cost: 4.8 },
    ],
    notes: 'Priority replenishment for low-stock products.',
  });
  sendPurchase(s, openPo1.id, shift(-3));
  receivePurchase(s, openPo1.id, {
    date: shift(-2),
    lines: [
      {
        purchaseLineId: openPo1.lines[0].id,
        qty: 90,
        code: 'LOT-SEED-PART-1',
        expiry: shift(365),
      },
    ],
  });

  const openPo2 = createPurchase(s, {
    supplierId: 's3',
    warehouseId: 'wh_branch',
    date: shift(-1),
    expected: expectedDate(s, 's3', shift(-1)),
    lines: [
      { productId: 'p15', qty: 250, cost: 1.8 },
      { productId: 'p21', qty: 100, cost: 12.6 },
    ],
  });
  sendPurchase(s, openPo2.id, shift(-1));

  createPurchase(s, {
    supplierId: 's1',
    warehouseId: 'wh_main',
    date: today(),
    expected: expectedDate(s, 's1', today()),
    lines: [{ productId: 'p1', qty: 15, unit: 'carton', cost: 160 }],
    notes: 'Bulk stock-up for main distribution.',
  });

  const approvedPo = createPurchase(s, {
    supplierId: 's4',
    warehouseId: 'wh_main',
    date: shift(-2),
    expected: expectedDate(s, 's4', shift(-2)),
    lines: [{ productId: 'p4', qty: 100, cost: 22 }],
    notes: 'Quarterly order.',
  });
  approvePurchase(s, approvedPo.id, 'Quarterly stock-up');
  sendPurchase(s, approvedPo.id, shift(-2));
  receivePurchase(s, approvedPo.id, {
    date: shift(-1),
    reference: 'INV-UP-201',
    lines: [
      {
        purchaseLineId: approvedPo.lines[0].id,
        qty: 100,
        price: 24,
        code: 'LOT-SEED-PRICE-UP',
        expiry: shift(400),
      },
    ],
  });

  const closedPo = createPurchase(s, {
    supplierId: 's3',
    warehouseId: 'wh_branch',
    date: shift(-5),
    expected: expectedDate(s, 's3', shift(-5)),
    lines: [
      { productId: 'p15', qty: 100, cost: 1.8 },
      { productId: 'p21', qty: 50, cost: 12.6 },
    ],
  });
  sendPurchase(s, closedPo.id, shift(-5));
  receivePurchase(s, closedPo.id, {
    date: shift(-4),
    lines: [
      {
        purchaseLineId: closedPo.lines[0].id,
        qty: 40,
        code: 'LOT-SEED-SHORT-1',
        expiry: shift(350),
      },
    ],
    closeRemaining: { reason: 'Supplier out of stock until next quarter' },
  });

  const twoLotsPo = createPurchase(s, {
    supplierId: 's4',
    warehouseId: 'wh_main',
    date: shift(-4),
    expected: expectedDate(s, 's4', shift(-4)),
    lines: [{ productId: 'p11', qty: 100, cost: 3.5 }],
  });
  sendPurchase(s, twoLotsPo.id, shift(-4));
  receivePurchase(s, twoLotsPo.id, {
    date: shift(-3),
    reference: 'DN-2LOTS',
    lines: [
      {
        purchaseLineId: twoLotsPo.lines[0].id,
        qty: 60,
        code: 'LOT-SEED-2A',
        expiry: shift(300),
      },
      {
        purchaseLineId: twoLotsPo.lines[0].id,
        qty: 40,
        code: 'LOT-SEED-2B',
        expiry: shift(450),
      },
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
  const pharmacy = saveCustomerGroup(s, { name: 'Pharmacy' });
  const clinic = saveCustomerGroup(s, { name: 'Clinic', discountPercent: 3 });
  const hospital = saveCustomerGroup(s, { name: 'Hospital', discountPercent: 8 });
  s.contacts
    .filter((c) => c.type === 'Customer')
    .forEach((c) => {
      saveContact(
        s,
        {
          ...c,
          groupId: ['c1', 'c4'].includes(c.id)
            ? pharmacy.id
            : c.id === 'c5'
              ? hospital.id
              : clinic.id,
          paymentTermsDays: c.id === 'c5' ? 60 : c.id === 'c4' ? 0 : 30,
          creditLimit: c.id === 'c1' ? 3000 : c.id === 'c4' ? 0 : c.id === 'c5' ? null : 5000,
          billing: ['c2', 'c5'].includes(c.id) ? 'monthly' : 'per_delivery',
          onHold: c.id === 'c2',
          holdReason: c.id === 'c2' ? 'Cheque returned unpaid' : '',
        },
        c.id,
      );
    });
  const accountSale = createInvoice(s, {
    customerId: 'c1',
    date: today(),
    lines: [{ productId: 'p16', qty: 48 }],
    notes: 'Blood pressure monitors for the pharmacy expansion; payment on account.',
  });
  issueInvoice(s, accountSale.id);
  for (const productId of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
    const p = product(s, productId)!;
    savePrice(s, { productId, unit: p.unit, price: round(p.price * 0.88), groupId: hospital.id });
  }
  savePrice(s, { productId: 'p1', unit: 'carton', price: 250, groupId: hospital.id });
  for (const productId of ['p1', 'p2', 'p3', 'p4']) {
    const p = product(s, productId)!;
    savePrice(s, { productId, unit: p.unit, price: round(p.price * 0.95), groupId: clinic.id });
  }
  for (const [productId, unit, price] of [
    ['p1', 'carton', 240],
    ['p1', 'box', 5.1],
    ['p4', 'box', 4.9],
  ] as const)
    savePrice(s, { productId, unit, price, customerId: 'c1', note: 'Agreed volume price.' });
  const makeOrder = (
    customerId: string,
    productId: string,
    qty: number,
    date = today(),
    validUntil = shift(14, date),
  ) =>
    saveOrder(s, {
      customerId,
      date,
      validUntil,
      requestedDate: shift(3),
      fulfilment: 'delivery',
      lines: [{ productId, qty }],
    });
  makeOrder('c5', 'p1', 20);
  makeOrder('c3', 'p3', 12, shift(-20), shift(-1));
  const greenlife = makeOrder('c1', 'p3', 2, shift(-3));
  confirmOrder(s, greenlife.id);
  const backorder = makeOrder('c5', 'p2', free(s, 'p2', { customerId: 'c5' }) + 25);
  confirmOrder(s, backorder.id);
  const wellness = makeOrder('c2', 'p3', 8);
  confirmOrder(s, wellness.id, { override: { reason: 'Owner approved, cheque replaced' } });
  const cancelled = makeOrder('c3', 'p1', 10);
  cancelOrder(s, cancelled.id, 'Customer chose a different pack size.');
  const orderDelivery = (order: SalesOrder) => {
    const line = order.lines[0];
    const batch = eligibleBatches(s, line.productId, {
      customerId: order.customerId,
      allowShortDated: order.allowShortDated,
    })[0];
    required(batch, 'Seed delivery requires eligible stock.');
    return createDelivery(s, { orderId: order.id, warehouseId: batch.warehouseId });
  };
  const collected = orderDelivery(greenlife);
  dispatchDelivery(s, collected.id, { driver: 'Dara', date: shift(-3) });
  confirmDelivered(s, collected.id, { receivedBy: 'Greenlife receiving desk' });
  const partial = orderDelivery(backorder);
  dispatchDelivery(s, partial.id, { driver: 'Sokha' });
  confirmDelivered(s, partial.id, { receivedBy: 'Sunrise pharmacy stores' });
  orderDelivery(wellness);
  const outOrder = makeOrder('c1', 'p4', 1);
  confirmOrder(s, outOrder.id);
  const draftDelivery = orderDelivery(outOrder);
  dispatchDelivery(s, draftDelivery.id, { driver: 'Dara' });
  createInvoiceFromDeliveries(s, {
    deliveryIds: [draftDelivery.id],
    notes: 'Awaiting billing review.',
  });
  const returnedOrder = makeOrder('c1', 'p4', 1);
  confirmOrder(s, returnedOrder.id);
  const returned = orderDelivery(returnedOrder);
  dispatchDelivery(s, returned.id, { driver: 'Sokha' });
  markNotDelivered(s, returned.id, 'Customer closed, redeliver tomorrow');
  const monthlyDelivery = (date: string, productId: string) => {
    const order = makeOrder('c5', productId, 1, date, shift(14));
    confirmOrder(s, order.id);
    const delivery = orderDelivery(order);
    dispatchDelivery(s, delivery.id, { date, driver: 'Sokha' });
    confirmDelivered(s, delivery.id, { receivedBy: 'Sunrise pharmacy stores' });
    return delivery;
  };
  const lastMonth = shift(-1, today().slice(0, 7) + '-01');
  const monthly = [monthlyDelivery(shift(-1, lastMonth), 'p3'), monthlyDelivery(lastMonth, 'p4')];
  issueInvoice(
    s,
    createInvoiceFromDeliveries(s, { deliveryIds: monthly.map((d) => d.id), date: lastMonth }).id,
  );
  const paidReturnInvoice = s.invoices.find(
    (i) =>
      i.status === 'Issued' &&
      i.paid === i.total &&
      i.customerId === 'c3' &&
      i.lines.every((l) => product(s, l.productId)!.active) &&
      !deliveriesOf(s, i)
        .flatMap((d) => d.lines)
        .flatMap((l) => l.picks)
        .some((p) =>
          isRecalled(
            s,
            s.batches.find((b) => b.id === p.batchId)!,
          ),
        ),
  )!;
  const refund = issueCreditNote(
    s,
    saveCreditNote(s, {
      invoiceId: paidReturnInvoice.id,
      kind: 'return',
      reason: 'wrong_prescription',
      settlement: 'refund',
      refundMethod: 'Cash',
      lines: [{ invoiceLineIndex: 0, qty: 1 }],
    }).id,
  );
  refund.lines.flatMap((l) => l.returns).forEach((p) => setQuarantine(s, p.returnBatchId!, false));
  const unpaidInvoice = s.invoices.find(
    (i) =>
      i.status === 'Issued' &&
      i.paid === 0 &&
      i.customerId !== 'c1' &&
      i.lines[0].qty > 1 &&
      !creditNotePicks(s, i, i.lines[0].productId).some((p) =>
        s.batches.some(
          (b) =>
            b.productId === i.lines[0].productId &&
            b.code === p.lotCode &&
            b.quarantined &&
            b.qty > 0,
        ),
      ),
  )!;
  const damaged = issueCreditNote(
    s,
    saveCreditNote(s, {
      invoiceId: unpaidInvoice.id,
      kind: 'return',
      reason: 'damaged',
      settlement: 'credit',
      lines: [{ invoiceLineIndex: 0, qty: 1 }],
    }).id,
  );
  damaged.lines
    .flatMap((l) => l.returns)
    .forEach((p) =>
      adjustStock(s, {
        batchId: p.returnBatchId!,
        qty: -p.qty,
        reason: 'damaged',
        note: 'Returned packaging was damaged.',
      }),
    );
  const correction = issueCreditNote(
    s,
    saveCreditNote(s, {
      invoiceId: paidReturnInvoice.id,
      kind: 'correction',
      reason: 'price_error',
      settlement: 'credit',
      lines: [{ invoiceLineIndex: 0, qty: 1, price: round(paidReturnInvoice.lines[0].price / 2) }],
    }).id,
  );
  saveCreditNote(s, {
    invoiceId: paidReturnInvoice.id,
    kind: 'correction',
    reason: 'price_error',
    settlement: 'credit',
    lines: [{ invoiceLineIndex: 0, qty: 1, price: 0.1 }],
  });
  const correctionTarget = openInvoices(s, correction.customerId)[0];
  const correctionApplied = Math.min(round(correction.total / 2), invoiceBalance(correctionTarget));
  applyCredit(s, {
    customerId: correction.customerId,
    invoiceId: correctionTarget.id,
    amount: correctionApplied,
  });
  refundCredit(s, {
    customerId: correction.customerId,
    amount: creditAvailable(correction),
    method: 'Bank transfer',
    date: today(),
  });
  const cheque = recordPayment(s, {
    customerId: 'c2',
    amount: 120,
    method: 'Cheque',
    date: today(),
    reference: 'WMC-0042',
  });
  voidPayment(s, cheque.id, 'Cheque returned unpaid');
  const deposit = recordPayment(s, {
    customerId: 'c4',
    amount: product(s, 'p3')!.price,
    method: 'Bank transfer',
    date: today(),
    reference: 'Lotus pickup deposit',
    allocations: [],
  });
  const prepaidOrder = makeOrder('c4', 'p3', 1);
  confirmOrder(s, prepaidOrder.id, { override: { reason: 'Prepaid pickup approved by owner' } });
  const prepaidDelivery = orderDelivery(prepaidOrder);
  dispatchDelivery(s, prepaidDelivery.id, { driver: 'Dara' });
  confirmDelivered(s, prepaidDelivery.id, { receivedBy: 'Lotus Health receiving desk' });
  issueInvoice(s, createInvoiceFromDeliveries(s, { deliveryIds: [prepaidDelivery.id] }).id);
  required(paymentCredit(deposit) === 0, 'Seed deposit must be fully applied.');
  for (const [bucket, days] of [
    ['current', -10],
    ['d1_30', 10],
    ['d31_60', 45],
    ['d61_90', 75],
    ['d90plus', 120],
  ] as const) {
    if (agingReport(s).at(-1)![bucket] > 0) continue;
    const invoice = createInvoice(s, {
      customerId: 'c2',
      date: shift(-Math.max(0, days + 30)),
      due: shift(-days),
      lines: [{ productId: 'p3', qty: 1, price: round(customerCredit(s, 'c2') + 25) }],
      notes: 'Monthly account reconciliation awaiting remittance.',
    });
    issueInvoice(s, invoice.id, {
      reason: 'Historical account balance approved for reconciliation',
    });
  }
  if (!agingReport(s).at(-1)!.credit) {
    const invoice = s.invoices.find(
      (i) =>
        i.status === 'Issued' &&
        i.paid === i.total &&
        i.lines[0].price >= 1 &&
        !s.creditNotes.some((cn) => cn.invoiceId === i.id),
    )!;
    issueCreditNote(
      s,
      saveCreditNote(s, {
        invoiceId: invoice.id,
        kind: 'correction',
        reason: 'price_error',
        settlement: 'credit',
        note: 'Agreed price correction kept for the next order.',
        lines: [{ invoiceLineIndex: 0, qty: 1, price: 1 }],
      }).id,
    );
  }
  return s;
}
function migrate(raw: unknown): Workspace {
  required(typeof raw === 'object' && raw !== null, 'This is not a supported Aster backup.');
  const legacy = raw as { version?: number };
  required(
    legacy.version === 1 || legacy.version === 2 || legacy.version === 3 || legacy.version === 4,
    'This is not a supported Aster backup.',
  );
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
  if (s.creditNotes === undefined) s.creditNotes = [];
  if (s.counters.creditNote === undefined) s.counters.creditNote = 1;
  if (s.orders === undefined) s.orders = [];
  if (s.counters.order === undefined) s.counters.order = 1;
  if (s.customerGroups === undefined) s.customerGroups = [];
  if (s.prices === undefined) s.prices = [];
  if (s.receipts === undefined) s.receipts = [];
  if (s.counters.receipt === undefined) s.counters.receipt = 1;
  if (Array.isArray(s.customerGroups))
    s.customerGroups.forEach((g) => {
      if (g.discountPercent === undefined) g.discountPercent = 0;
    });
  if (s.settings) {
    if (s.settings.defaultPaymentTermsDays === undefined) s.settings.defaultPaymentTermsDays = 30;
    if (s.settings.overdueGraceDays === undefined) s.settings.overdueGraceDays = 7;
    if (s.settings.poApprovalLimit === undefined) s.settings.poApprovalLimit = 2000;
  }
  if (s.settings?.minShelfLifeDays === undefined && s.settings) s.settings.minShelfLifeDays = 180;
  if (Array.isArray(s.contacts))
    s.contacts.forEach((c) => {
      if (c.minShelfLifeDays === undefined) c.minShelfLifeDays = null;
      if (c.leadTimeDays === undefined) c.leadTimeDays = 0;
      if (c.minOrderValue === undefined) c.minOrderValue = null;
      if (c.type === 'Customer') {
        c.leadTimeDays = 0;
        c.minOrderValue = null;
      }
      const defaults = accountDefaults(s);
      for (const key of Object.keys(defaults) as Array<keyof typeof defaults>)
        if (c[key] === undefined) Object.assign(c, { [key]: defaults[key] });
    });
  if (Array.isArray(s.invoices))
    s.invoices.forEach((i) => {
      if (i.credited === undefined) i.credited = 0;
      if (i.allowShortDated === undefined) i.allowShortDated = false;
      if (i.orderId === undefined) i.orderId = undefined;
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
  if (Array.isArray(s.purchases))
    s.purchases.forEach((p) => {
      if ((p.status as string) === 'Ordered') {
        p.status = 'Sent';
        if (p.sentAt === undefined) p.sentAt = p.date;
        if (p.sentBy === undefined) p.sentBy = CURRENT_USER;
      } else if (p.status === 'Received') {
        if (p.sentAt === undefined) p.sentAt = p.date;
        if (p.sentBy === undefined) p.sentBy = CURRENT_USER;
      }
      if (p.createdAt === undefined) p.createdAt = `${p.date}T00:00:00.000Z`;
      if (p.createdBy === undefined) p.createdBy = CURRENT_USER;
    });
  if (s.deliveries === undefined) s.deliveries = [];
  if (s.counters.delivery === undefined) s.counters.delivery = 1;
  if (legacy.version < 3 && Array.isArray(s.invoices))
    [...s.invoices].reverse().forEach((invoice) => {
      const old = invoice as Invoice & {
        allocations?: {
          batchId: string;
          code: string;
          warehouseId: string;
          productId: string;
          qty: number;
          cost: number;
        }[];
        cogs?: number;
      };
      if (invoice.deliveryIds === undefined) {
        invoice.deliveryIds = [];
        if (invoice.status === 'Issued') {
          required(Array.isArray(old.allocations), 'Invalid legacy invoice allocations.');
          const remaining = old.allocations.map((a) => ({ ...a, remainingQty: a.qty }));
          const lines = invoice.lines.map((line) => {
            let need = line.qty * line.factor;
            const picks: DeliveryPick[] = [];
            for (const allocation of remaining.filter((a) => a.productId === line.productId)) {
              const take = Math.min(need, allocation.remainingQty);
              if (!take) continue;
              const batch = s.batches.find((b) => b.id === allocation.batchId);
              required(batch, 'Unknown legacy invoice batch allocation.');
              picks.push({
                batchId: allocation.batchId,
                warehouseId: allocation.warehouseId,
                lotCode: allocation.code,
                expiry: batch.expiry,
                qty: take,
                cost: allocation.cost,
              });
              need -= take;
              allocation.remainingQty -= take;
            }
            required(need === 0, 'Legacy invoice allocations do not match its base quantities.');
            return {
              id: uid('dl'),
              productId: line.productId,
              name: line.name,
              sku: line.sku,
              unit: line.unit,
              factor: line.factor,
              qty: line.qty,
              price: line.price,
              picks,
            };
          });
          required(
            remaining.every((a) => a.remainingQty === 0),
            'Legacy invoice allocations do not match its base quantities.',
          );
          const delivery = newDelivery(s, {
            customerId: invoice.customerId,
            method: 'pickup',
            address: contact(s, invoice.customerId)?.address || '',
            lines,
          });
          Object.assign(delivery, {
            legacy: true,
            status: 'Delivered',
            date: invoice.date,
            receivedBy: contact(s, invoice.customerId)?.name || '',
            cost: old.cogs,
            invoiceId: invoice.id,
            dispatchedAt: new Date(invoice.date + 'T12:00:00').toISOString(),
            dispatchedBy: CURRENT_USER,
            deliveredAt: new Date(invoice.date + 'T12:00:00').toISOString(),
          });
          invoice.deliveryIds = [delivery.id];
        }
      }
      delete old.allocations;
      delete old.cogs;
    });
  if (s.payments === undefined) s.payments = [];
  if (s.refunds === undefined) s.refunds = [];
  if (s.counters.payment === undefined) s.counters.payment = 1;
  if (Array.isArray(s.payments) && Array.isArray(s.invoices))
    [...s.invoices].reverse().forEach((invoice) => {
      const old = invoice as Invoice & {
        payments?: { date: string; amount: number; method: CustomerPayment['method'] }[];
      };
      if (old.payments !== undefined) {
        required(Array.isArray(old.payments), 'Invalid legacy invoice payments.');
        old.payments.forEach((p) =>
          s.payments.push({
            id: uid('pay'),
            number: `PAY-${String(s.counters.payment++).padStart(4, '0')}`,
            customerId: invoice.customerId,
            date: p.date,
            amount: p.amount,
            method: p.method,
            reference: '',
            note: '',
            allocations: [{ invoiceId: invoice.id, amount: p.amount, date: p.date }],
            voidedAllocations: [],
            refunded: 0,
            status: 'Posted',
            voidReason: '',
            voidDate: '',
            legacy: true,
            createdAt: new Date(p.date + 'T12:00:00').toISOString(),
            createdBy: CURRENT_USER,
          }),
        );
        delete old.payments;
      }
    });
  if (Array.isArray(s.payments))
    s.payments.forEach((p) => {
      if (p.voidedAllocations === undefined) p.voidedAllocations = [];
    });
  if (Array.isArray(s.creditNotes) && Array.isArray(s.refunds))
    s.creditNotes.forEach((cn) => {
      if (Array.isArray(cn.allocations))
        cn.allocations.forEach((a) => {
          if (a.date === undefined) a.date = cn.date;
        });
      if (
        cn.refunded > 0 &&
        !s.refunds.some(
          (r) =>
            Array.isArray(r.from) && r.from.some((f) => f.kind === 'credit_note' && f.id === cn.id),
        )
      )
        s.refunds.push({
          id: uid('refund'),
          date: cn.date,
          customerId: cn.customerId,
          amount: cn.refunded,
          method: cn.refundMethod || 'Other',
          from: [{ kind: 'credit_note', id: cn.id, amount: cn.refunded }],
          createdBy: CURRENT_USER,
        });
    });
  if (legacy.version < 4) {
    if (Array.isArray(s.purchases)) {
      s.purchases.forEach((p) => {
        if ((p as any).paid !== undefined) {
          delete (p as any).closeReason;
        }
        if (Array.isArray(p.lines)) {
          p.lines.forEach((l) => {
            if (!l.id) l.id = uid('pol');
            if (l.closedQty === undefined || (p as any).paid !== undefined) {
              l.closedQty = 0;
            }
          });
        }
      });
    }
    const existingReceipts = Array.isArray(s.receipts) ? [...s.receipts] : [];
    type OldBillItem =
      | { kind: 'po'; po: Purchase; date: string }
      | { kind: 'receipt'; receipt: Receipt; date: string };
    const oldBills: OldBillItem[] = [];
    if (Array.isArray(s.purchases)) {
      s.purchases
        .filter((p) => p.status === 'Received')
        .forEach((po) => {
          oldBills.push({ kind: 'po', po, date: po.received ?? po.date });
        });
    }
    const isReceivedPoReceipt = (r: Receipt) =>
      !!r.purchaseId &&
      Array.isArray(s.purchases) &&
      s.purchases.some((p) => p.id === r.purchaseId && p.status === 'Received');
    if (Array.isArray(s.receipts)) {
      s.receipts
        .filter((r) => !isReceivedPoReceipt(r))
        .forEach((receipt) => {
          oldBills.push({
            kind: 'receipt',
            receipt,
            date: receipt.date ?? (receipt as any).received ?? today(),
          });
        });
    }
    oldBills.sort((a, b) => a.date.localeCompare(b.date));
    const migratedReceipts: Receipt[] = [];
    for (const item of oldBills) {
      if (item.kind === 'po') {
        const po = item.po;
        const supp = contact(s, po.supplierId);
        const date = item.date;
        const moves = (s.stockMoves || []).filter(
          (m) => m.type === 'receipt' && m.sourceId === po.id,
        );
        const matchMoves = moves.length === po.lines.length;
        const existingReceipt = existingReceipts.find((r) => r.purchaseId === po.id);
        const isRealLegacy = (po as any).paid !== undefined;
        const number =
          !isRealLegacy && existingReceipt?.number
            ? existingReceipt.number
            : `GRN-${String(s.counters.receipt++).padStart(4, '0')}`;
        const useExisting =
          !isRealLegacy &&
          existingReceipt &&
          existingReceipt.lines.every((el) =>
            po.lines.some((pl) => pl.id === el.purchaseLineId && pl.unit === el.unit),
          );
        const lines: ReceiptLine[] = useExisting
          ? existingReceipt.lines
          : po.lines.map((l: PurchaseLine, idx: number) => {
              const move = matchMoves ? moves[idx] : undefined;
              const b = move ? s.batches.find((batch) => batch.id === move.batchId) : undefined;
              return {
                productId: l.productId,
                name: l.name,
                sku: l.sku,
                unit: l.unit,
                factor: l.factor,
                qty: l.qty,
                price: l.price,
                orderedPrice: l.price,
                purchaseLineId: l.id,
                batchId: b?.id || move?.batchId || '',
                lotCode: b?.code || move?.lotCode || '',
                expiry: b?.expiry || '',
              };
            });
        const total = isRealLegacy
          ? po.total
          : useExisting
            ? existingReceipt.total
            : sum(lines, (l) => l.qty * l.price);
        const paid = isRealLegacy ? (po as any).paid : (existingReceipt?.paid ?? 0);
        migratedReceipts.push({
          id: !isRealLegacy && existingReceipt?.id ? existingReceipt.id : uid('receipt'),
          number,
          date,
          supplierId: po.supplierId,
          warehouseId: po.warehouseId,
          purchaseId: po.id,
          reference: po.reference ?? '',
          lines,
          total,
          paid,
          credited: 0,
          due:
            !isRealLegacy && existingReceipt?.due
              ? existingReceipt.due
              : shift(supp?.paymentTermsDays ?? 30, date),
          notes: !isRealLegacy && existingReceipt?.notes !== undefined ? existingReceipt.notes : '',
          legacy: true,
          createdAt:
            !isRealLegacy && existingReceipt?.createdAt
              ? existingReceipt.createdAt
              : `${date}T12:00:00.000Z`,
          createdBy:
            !isRealLegacy && existingReceipt?.createdBy ? existingReceipt.createdBy : CURRENT_USER,
        });
      } else {
        const r = item.receipt;
        const supp = contact(s, r.supplierId);
        if (!r.number) r.number = `GRN-${String(s.counters.receipt++).padStart(4, '0')}`;
        if (r.lines === undefined) r.lines = [];
        if (!r.reference) r.reference = '';
        r.credited = 0;
        r.due = shift(supp?.paymentTermsDays ?? 30, r.date);
        r.notes = r.notes ?? '';
        r.legacy = true;
        if (r.createdAt === undefined) r.createdAt = `${r.date}T12:00:00.000Z`;
        if (r.createdBy === undefined) r.createdBy = CURRENT_USER;
        delete (r as any).received;
        migratedReceipts.push(r as Receipt);
      }
    }
    s.receipts = migratedReceipts;
    const maxGrn = Math.max(0, ...s.receipts.map((r) => Number(r.number.slice(4)) || 0));
    if (s.counters.receipt <= maxGrn) s.counters.receipt = maxGrn + 1;
    if (Array.isArray(s.purchases)) {
      s.purchases.forEach((p) => {
        delete (p as any).paid;
      });
    }
  }
  s.version = 4;
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
    'customerGroups',
    'prices',
    'orders',
    'deliveries',
    'creditNotes',
    'payments',
    'refunds',
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
      'receipts',
      'adjustments',
      'stockCounts',
      'recalls',
      'reservations',
      'customerGroups',
      'prices',
      'orders',
      'deliveries',
      'creditNotes',
      'payments',
      'refunds',
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
  accountDays(s.settings.defaultPaymentTermsDays, 'Default payment terms');
  accountDays(s.settings.overdueGraceDays, 'Overdue grace period');
  moneyCheck(s.settings.poApprovalLimit, 'Approval limit');
  required(
    s.settings.poApprovalLimit >= 0,
    'Approval limit must be greater than or equal to zero.',
  );
  s.contacts.forEach((c) => validateAccount(s, c));
  const groupNames = new Set<string>();
  s.customerGroups.forEach((g) => {
    required(
      typeof g.name === 'string' &&
        g.name === g.name.trim() &&
        g.name.length >= 2 &&
        g.name.length <= 40 &&
        !groupNames.has(g.name.toLowerCase()),
      'Backup contains invalid or duplicate customer group names.',
    );
    groupNames.add(g.name.toLowerCase());
    required(
      Number.isFinite(g.discountPercent) && g.discountPercent >= 0 && g.discountPercent <= 100,
      'Discount must be between 0 and 100.',
    );
  });
  const reorderPairs = new Set<string>();
  s.prices.forEach((entry) => validatePrice(s, entry));
  const reservationNumbers = new Set<string>();
  const orderReservations = new Set<string>();
  const orderNumbers = new Set<string>();
  s.orders.forEach((o) => {
    required(
      contact(s, o.customerId)?.type === 'Customer' &&
        ['Quote', 'Confirmed', 'Done', 'Cancelled'].includes(o.status) &&
        Array.isArray(o.lines) &&
        o.lines.length,
      'Invalid order in backup.',
    );
    required(
      typeof o.number === 'string' && /^SO-\d{4,}$/.test(o.number) && !orderNumbers.has(o.number),
      'Invalid or duplicate order number.',
    );
    orderNumbers.add(o.number);
    required(
      Number(o.number.slice(3)) < s.counters.order,
      'Order counter must exceed existing order numbers.',
    );
    dateCheck(o.date);
    dateCheck(o.requestedDate);
    required(o.date <= today() && o.requestedDate >= o.date, 'Invalid order dates.');
    if (o.status === 'Quote' || o.validUntil !== undefined) {
      dateCheck(o.validUntil!);
      required(o.validUntil! >= o.date, 'Valid until must be on or after the order date.');
    }
    required(
      o.status !== 'Cancelled' || (typeof o.cancelReason === 'string' && o.cancelReason.trim()),
      'Cancelled orders require a cancellation reason.',
    );
    required(
      ['delivery', 'pickup'].includes(o.fulfilment) &&
        typeof o.deliveryAddress === 'string' &&
        typeof o.notes === 'string' &&
        typeof o.allowShortDated === 'boolean',
      'Invalid order details.',
    );
    required(
      typeof o.createdBy === 'string' &&
        o.createdBy.trim() &&
        typeof o.createdAt === 'string' &&
        !isNaN(new Date(o.createdAt).getTime()),
      'Invalid order creation audit.',
    );
    if (o.status === 'Confirmed' || o.status === 'Done')
      required(
        typeof o.confirmedBy === 'string' &&
          o.confirmedBy.trim() &&
          typeof o.confirmedAt === 'string' &&
          !isNaN(new Date(o.confirmedAt).getTime()),
        'Invalid order confirmation audit.',
      );
    if (o.status === 'Done' || o.status === 'Cancelled')
      required(
        typeof o.closedAt === 'string' && !isNaN(new Date(o.closedAt).getTime()),
        'Closed orders require a valid closedAt.',
      );
    required(
      typeof o.discountPercent === 'number' &&
        moneyCheck(o.discountPercent) === o.discountPercent &&
        o.discountPercent <= 100 &&
        typeof o.taxRate === 'number' &&
        moneyCheck(o.taxRate) === o.taxRate &&
        o.taxRate <= 100,
      'Invalid order discount or tax rate.',
    );
    const lineIds = new Set<string>();
    o.lines.forEach((l) => {
      required(
        typeof l.id === 'string' && l.id && !lineIds.has(l.id),
        'Invalid or duplicate order line identifier.',
      );
      lineIds.add(l.id);
      required(
        ids.products.has(l.productId) && typeof l.name === 'string' && typeof l.sku === 'string',
        'Unknown order product.',
      );
      qtyCheck(l.qty);
      moneyCheck(l.price);
      required(
        units.includes(l.unit) &&
          Number.isSafeInteger(l.factor) &&
          l.factor >= 1 &&
          Number.isSafeInteger(l.qty * l.factor),
        'Invalid order line unit or factor.',
      );
      required(
        Number.isSafeInteger(l.cancelledQty) &&
          l.cancelledQty >= 0 &&
          l.cancelledQty <= l.qty &&
          deliveredQty(s, o, l.id) <= l.qty - l.cancelledQty,
        'Invalid order cancelled or delivered quantity.',
      );
    });
    if (o.creditOverride !== undefined) {
      const c = o.creditOverride;
      required(
        c &&
          typeof c.by === 'string' &&
          c.by.trim() &&
          typeof c.reason === 'string' &&
          c.reason.trim().length >= 5 &&
          typeof c.at === 'string' &&
          !isNaN(new Date(c.at).getTime()) &&
          Array.isArray(c.reasons) &&
          c.reasons.every((r) => typeof r === 'string'),
        'Backup contains an invalid credit override.',
      );
    }
    required(
      o.status !== 'Done' || o.lines.every((l) => openQty(s, o, l.id) === 0),
      'Done orders cannot have open quantities.',
    );
    orderTotals(o);
  });
  s.reservations.forEach((r) => {
    required(
      ids.products.has(r.productId) && contact(s, r.customerId)?.type === 'Customer',
      'Backup contains an unknown reservation product or customer.',
    );
    required(
      Number.isSafeInteger(r.qty) &&
        r.qty > 0 &&
        ['hold', 'invoice', 'sales_order'].includes(r.source) &&
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
    } else if (r.source === 'sales_order') {
      const order = s.orders.find((o) => o.id === r.sourceId);
      required(
        order && order.customerId === r.customerId,
        'Backup contains an invalid reservation order.',
      );
      required(
        r.status !== 'Active' || order.status === 'Confirmed',
        'Active order reservations require a Confirmed order.',
      );
      required(r.expires === undefined, 'Order reservations cannot have an expiry.');
      if (r.status === 'Active') {
        const key = JSON.stringify([r.sourceId, r.productId]);
        required(
          !orderReservations.has(key),
          'Backup contains duplicate Active order reservations.',
        );
        orderReservations.add(key);
      }
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
      s.counters.reservation > 0 &&
      Number.isSafeInteger(s.counters.order) &&
      s.counters.order > 0 &&
      Number.isSafeInteger(s.counters.delivery) &&
      s.counters.delivery > 0 &&
      Number.isSafeInteger(s.counters.creditNote) &&
      s.counters.creditNote > 0 &&
      Number.isSafeInteger(s.counters.receipt) &&
      s.counters.receipt > 0,
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
      [
        'opening',
        'receipt',
        'sale',
        'return',
        'transfer_out',
        'transfer_in',
        'adjustment',
      ].includes(m.type) &&
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
  const deliveryNumbers = new Set<string>();
  s.deliveries.forEach((d) => {
    required(
      contact(s, d.customerId)?.type === 'Customer' &&
        ['Picking', 'Dispatched', 'Delivered', 'Returned', 'Cancelled'].includes(d.status) &&
        ['delivery', 'pickup'].includes(d.method) &&
        Array.isArray(d.lines) &&
        d.lines.length,
      'Invalid delivery in backup.',
    );
    required(
      typeof d.number === 'string' &&
        /^DN-\d{4,}$/.test(d.number) &&
        !deliveryNumbers.has(d.number) &&
        Number(d.number.slice(3)) < s.counters.delivery,
      'Invalid delivery number or counter.',
    );
    deliveryNumbers.add(d.number);
    required(!d.warehouseId || ids.warehouses.has(d.warehouseId), 'Unknown delivery warehouse.');
    required(
      ['address', 'driver', 'receivedBy', 'returnReason', 'createdAt', 'createdBy'].every(
        (key) => typeof d[key as 'address'] === 'string',
      ) &&
        d.createdBy.trim() &&
        !isNaN(new Date(d.createdAt).getTime()),
      'Invalid delivery fields.',
    );
    required(
      d.legacy === undefined ||
        (d.legacy === true &&
          d.method === 'pickup' &&
          d.status === 'Delivered' &&
          !d.orderId &&
          !!d.invoiceId),
      'Invalid legacy delivery flag.',
    );
    required(
      d.status !== 'Delivered' || d.receivedBy.trim(),
      'Delivered deliveries require receivedBy.',
    );
    required(
      d.status !== 'Returned' || d.returnReason.trim(),
      'Returned deliveries require returnReason.',
    );
    const dispatched = ['Dispatched', 'Delivered', 'Returned'].includes(d.status);
    if (dispatched) {
      dateCheck(d.date!);
      required(
        d.date! <= today() &&
          typeof d.dispatchedBy === 'string' &&
          d.dispatchedBy.trim() &&
          typeof d.dispatchedAt === 'string' &&
          !isNaN(new Date(d.dispatchedAt).getTime()),
        'Invalid delivery dispatch audit.',
      );
    }
    if (d.status === 'Delivered')
      required(
        typeof d.deliveredAt === 'string' && !isNaN(new Date(d.deliveredAt).getTime()),
        'Invalid deliveredAt.',
      );
    const linked = s.invoices.filter(
      (i) => Array.isArray(i.deliveryIds) && i.deliveryIds.includes(d.id),
    );
    required(
      linked.length <= 1 &&
        (d.invoiceId
          ? linked.length === 1 && linked[0].id === d.invoiceId && linked[0].status === 'Issued'
          : linked.every((i) => i.status === 'Draft')),
      'Delivery invoice links are inconsistent.',
    );
    const order = d.orderId ? s.orders.find((o) => o.id === d.orderId) : undefined;
    required(!d.orderId || (order && order.customerId === d.customerId), 'Unknown delivery order.');
    const lineIds = new Set<string>();
    d.lines.forEach((l) => {
      required(
        l.id &&
          !lineIds.has(l.id) &&
          ids.products.has(l.productId) &&
          typeof l.name === 'string' &&
          typeof l.sku === 'string' &&
          Array.isArray(l.picks),
        'Invalid delivery line.',
      );
      lineIds.add(l.id);
      qtyCheck(l.qty);
      moneyCheck(l.price);
      required(
        units.includes(l.unit) &&
          Number.isSafeInteger(l.factor) &&
          l.factor >= 1 &&
          Number.isSafeInteger(l.qty * l.factor),
        'Invalid delivery line unit or factor.',
      );
      if (order) {
        required(
          typeof l.orderLineId === 'string' && l.orderLineId,
          'Invalid delivery order line.',
        );
        if (['Dispatched', 'Delivered'].includes(d.status))
          required(
            order.lines.some(
              (ol) =>
                ol.id === l.orderLineId &&
                ol.productId === l.productId &&
                ol.unit === l.unit &&
                ol.factor === l.factor,
            ),
            'Invalid delivery order line.',
          );
      } else
        required(l.orderLineId === undefined, 'Direct delivery cannot reference an order line.');
      required(
        l.picks.reduce((n, p) => n + p.qty, 0) === l.qty * l.factor,
        'Delivery picks do not match its base quantity.',
      );
      const batchIds = new Set<string>();
      l.picks.forEach((p) => {
        const batch = s.batches.find((b) => b.id === p.batchId);
        required(
          batch &&
            batch.productId === l.productId &&
            batch.warehouseId === p.warehouseId &&
            batch.code === p.lotCode &&
            batch.expiry === p.expiry &&
            (!d.warehouseId || p.warehouseId === d.warehouseId) &&
            (d.legacy || !batchIds.has(p.batchId)),
          'Invalid delivery pick batch.',
        );
        batchIds.add(p.batchId);
        qtyCheck(p.qty);
        moneyCheck(p.cost);
      });
    });
    const picks = d.lines.flatMap((l) => l.picks);
    required(
      typeof d.cost === 'number' &&
        moneyCheck(d.cost) === d.cost &&
        d.cost === (dispatched ? sum(picks, (p) => p.qty * p.cost) : 0),
      'Delivery costs are inconsistent.',
    );
    if (dispatched && !d.legacy) {
      const sales = s.stockMoves.filter((m) => m.sourceId === d.id && m.type === 'sale');
      const remaining = [...sales];
      picks.forEach((p) => {
        const index = remaining.findIndex(
          (m) =>
            m.batchId === p.batchId &&
            m.qty === -p.qty &&
            m.unitCost === p.cost &&
            m.reference === d.number &&
            m.counterpartyId === d.customerId &&
            m.date === d.date,
        );
        required(index !== -1, 'Delivery sale moves do not match its picks.');
        remaining.splice(index, 1);
      });
      required(!remaining.length, 'Delivery sale moves do not match its picks.');
      if (d.status === 'Returned') {
        const returns = s.stockMoves.filter((m) => m.sourceId === d.id && m.type === 'return');
        const remaining = [...returns];
        picks.forEach((p) => {
          const original = s.batches.find((b) => b.id === p.batchId)!;
          const index = remaining.findIndex((m) => {
            const twin = s.batches.find((b) => b.id === m.batchId);
            return (
              twin &&
              twin.productId === original.productId &&
              twin.code === original.code &&
              twin.expiry === original.expiry &&
              twin.cost === p.cost &&
              twin.warehouseId === p.warehouseId &&
              m.qty === p.qty &&
              m.unitCost === p.cost &&
              m.reference === d.number &&
              m.counterpartyId === d.customerId
            );
          });
          required(index !== -1, 'Delivery return moves do not match its picks.');
          remaining.splice(index, 1);
        });
        required(!remaining.length, 'Delivery return moves do not match its picks.');
      }
    }
  });
  s.orders.forEach((o) =>
    o.lines.forEach((l) =>
      required(
        deliveredQty(s, o, l.id) <= l.qty - l.cancelledQty,
        'Order delivered quantity exceeds its open quantity.',
      ),
    ),
  );
  s.invoices.forEach((i) => {
    required(
      contact(s, i.customerId)?.type === 'Customer' &&
        Array.isArray(i.lines) &&
        i.lines.length &&
        ['Draft', 'Issued'].includes(i.status) &&
        Array.isArray(i.deliveryIds),
      'Invalid invoice in backup.',
    );
    dateCheck(i.date);
    dateCheck(i.due);
    if (i.creditOverride !== undefined) {
      const o = i.creditOverride;
      required(
        o &&
          typeof o.by === 'string' &&
          o.by.trim() &&
          typeof o.reason === 'string' &&
          o.reason.trim() &&
          typeof o.at === 'string' &&
          /^\d{4}-\d{2}-\d{2}T/.test(o.at) &&
          !isNaN(new Date(o.at).getTime()) &&
          Array.isArray(o.reasons) &&
          o.reasons.every((reason) => typeof reason === 'string'),
        'Backup contains an invalid credit override.',
      );
    }
    moneyCheck(i.total);
    moneyCheck(i.paid);
    required(
      Number.isFinite(i.credited) &&
        i.credited >= 0 &&
        round(i.credited) === i.credited &&
        i.paid >= 0 &&
        round(i.total - i.paid - i.credited) >= 0,
      'Invalid invoice payment balance.',
    );
    required(
      i.credited ===
        sum(
          s.creditNotes.filter((cn) => cn.status === 'Issued'),
          (cn) =>
            sum(
              cn.allocations.filter((a) => a.invoiceId === i.id),
              (a) => a.amount,
            ),
        ),
      'Invoice credit notes do not match the credited balance.',
    );
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
      sum(
        s.payments.filter((p) => p.status === 'Posted'),
        (p) =>
          sum(
            p.allocations.filter((a) => a.invoiceId === i.id),
            (a) => a.amount,
          ),
      ) === i.paid,
      'Invoice payments do not match the paid balance.',
    );
    required(
      new Set(i.deliveryIds).size === i.deliveryIds.length,
      'A delivery may appear only once on an invoice.',
    );
    const deliveries = deliveriesOf(s, i);
    required(
      deliveries.length === i.deliveryIds.length &&
        deliveries.every(
          (d) =>
            (i.status === 'Draft' ? !d.invoiceId : d.invoiceId === i.id) &&
            d.customerId === i.customerId &&
            ['Dispatched', 'Delivered'].includes(d.status),
        ),
      'Invoice delivery links are inconsistent.',
    );
    required(
      i.orderId === undefined ||
        (typeof i.orderId === 'string' &&
          ids.orders.has(i.orderId) &&
          deliveries.length > 0 &&
          deliveries.every((d) => d.orderId === i.orderId)),
      'Invoice order does not match its deliveries.',
    );
    const orderDeliveries = deliveries.filter((d) => d.orderId);
    required(
      !orderDeliveries.length || orderDeliveries.length === deliveries.length,
      'An invoice cannot mix order deliveries and direct-sale deliveries.',
    );
    required(
      i.status !== 'Issued' ||
        orderDeliveries.length ||
        (deliveries.length === 1 && deliveries[0].method === 'pickup'),
      'Direct-sale invoices require exactly one pickup delivery.',
    );
    required(
      orderDeliveries.length || i.status === 'Issued' || !deliveries.length,
      'Drafts must reference order deliveries.',
    );
    if (orderDeliveries.length) {
      const lines = deliveries.flatMap((d) => d.lines);
      required(
        lines.length === i.lines.length &&
          lines.every((l, index) => {
            const line = i.lines[index];
            return (['productId', 'name', 'sku', 'unit', 'factor', 'qty', 'price'] as const).every(
              (key) => l[key] === line[key],
            );
          }),
        'Invoice lines do not match its delivery notes.',
      );
      required(
        deliveries.every((d) => i.date >= d.date!),
        'Invoice date cannot be before the latest delivery date.',
      );
    }
    if (i.status === 'Issued') {
      const lines = deliveries.flatMap((d) => d.lines);
      for (const id of new Set([...i.lines, ...lines].map((l) => l.productId)))
        required(
          lines.filter((l) => l.productId === id).reduce((n, l) => n + l.qty * l.factor, 0) ===
            i.lines.filter((l) => l.productId === id).reduce((n, l) => n + l.qty * l.factor, 0),
          'Invoice deliveries do not match its base quantities.',
        );
    }
  });

  const creditNumbers = new Set<string>();
  s.creditNotes.forEach((cn) => {
    required(
      ['Draft', 'Issued'].includes(cn.status) &&
        Array.isArray(cn.allocations) &&
        Array.isArray(cn.lines),
      'Invalid credit note in backup.',
    );
    required(
      typeof cn.number === 'string' &&
        /^CN-\d{4,}$/.test(cn.number) &&
        !creditNumbers.has(cn.number) &&
        Number(cn.number.slice(3)) < s.counters.creditNote,
      'Invalid credit note number or counter.',
    );
    creditNumbers.add(cn.number);
    required(
      typeof cn.createdAt === 'string' &&
        !isNaN(new Date(cn.createdAt).getTime()) &&
        typeof cn.createdBy === 'string' &&
        cn.createdBy.trim(),
      'Invalid credit note audit.',
    );
    const prepared = prepareCreditNote(s, cn, cn.id, cn.status === 'Issued');
    for (const key of [
      'invoiceId',
      'customerId',
      'date',
      'kind',
      'reason',
      'note',
      'subtotal',
      'discount',
      'taxRate',
      'taxAmount',
      'total',
      'returnCost',
      'settlement',
      'refundMethod',
    ] as const)
      required(cn[key] === prepared[key], 'Credit note amounts or fields do not match.');
    cn.lines.forEach((l, index) => {
      const expected = prepared.lines[index];
      for (const key of [
        'invoiceLineIndex',
        'productId',
        'name',
        'sku',
        'unit',
        'factor',
        'qty',
        'price',
      ] as const)
        required(l[key] === expected[key], 'Credit note line does not match its invoice.');
      l.returns.forEach((p, pickIndex) => {
        const expectedPick = expected.returns[pickIndex];
        for (const key of ['batchId', 'warehouseId', 'lotCode', 'qty', 'cost'] as const)
          required(p[key] === expectedPick[key], 'Invalid credit note return pick.');
        if (cn.status === 'Issued') {
          const original = s.batches.find((b) => b.id === p.batchId)!;
          const twin = s.batches.find((b) => b.id === p.returnBatchId);
          required(
            twin &&
              twin.productId === original.productId &&
              twin.code === original.code &&
              twin.expiry === original.expiry &&
              twin.cost === p.cost &&
              twin.warehouseId === p.warehouseId,
            'Invalid returned twin batch.',
          );
        } else required(p.returnBatchId === undefined, 'Draft credit notes cannot return stock.');
      });
    });
    required(
      typeof cn.refunded === 'number' &&
        cn.refunded >= 0 &&
        round(cn.refunded) === cn.refunded &&
        Number.isFinite(cn.refunded),
      'Invalid credit note refund.',
    );
    cn.allocations.forEach((a) => {
      const invoice = s.invoices.find((i) => i.id === a.invoiceId);
      required(
        invoice?.status === 'Issued' &&
          invoice.customerId === cn.customerId &&
          typeof a.amount === 'number' &&
          a.amount > 0 &&
          Number.isFinite(a.amount) &&
          round(a.amount) === a.amount,
        'Invalid credit note allocation.',
      );
      dateCheck(a.date);
    });
    required(creditAvailable(cn) >= 0, 'Invalid credit note settlement.');
    const moves = s.stockMoves.filter((m) => m.sourceId === cn.id);
    if (cn.status === 'Issued') {
      required(
        typeof cn.issuedAt === 'string' && !isNaN(new Date(cn.issuedAt).getTime()),
        'Invalid credit note issuedAt.',
      );
      const picks = cn.lines.flatMap((l) =>
        l.returns.map((p) => ({ ...p, productId: l.productId })),
      );
      required(
        moves.length === picks.length &&
          picks.every((p) => {
            const index = moves.findIndex(
              (m) =>
                m.type === 'return' &&
                m.batchId === p.returnBatchId &&
                m.productId === p.productId &&
                m.qty === p.qty &&
                m.unitCost === p.cost &&
                m.reference === cn.number &&
                m.counterpartyId === cn.customerId &&
                m.date === cn.date,
            );
            if (index < 0) return false;
            moves.splice(index, 1);
            return true;
          }),
        'Credit note return moves do not match its picks.',
      );
    } else
      required(
        !cn.allocations.length && cn.refunded === 0 && !cn.issuedAt && !moves.length,
        'Draft credit notes cannot be posted.',
      );
  });

  const validMoney = (n: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000000 && round(n) === n;
  const validateAllocations = (allocations: PaymentAllocation[], customerId: string) => {
    required(Array.isArray(allocations), 'Invalid payment allocations.');
    allocations.forEach((a) => {
      const invoice = s.invoices.find((i) => i.id === a.invoiceId);
      required(
        invoice?.status === 'Issued' &&
          invoice.customerId === customerId &&
          validMoney(a.amount) &&
          a.amount > 0,
        'Invalid payment allocation.',
      );
      dateCheck(a.date);
      required(a.date <= today(), 'Allocation date cannot be in the future.');
    });
  };
  const numbers = new Set<string>();
  s.payments.forEach((p) => {
    required(
      contact(s, p.customerId)?.type === 'Customer' &&
        /^PAY-\d{4,}$/.test(p.number) &&
        !numbers.has(p.number) &&
        validMoney(p.amount) &&
        p.amount > 0 &&
        paymentMethods.includes(p.method) &&
        typeof p.reference === 'string' &&
        typeof p.note === 'string' &&
        ['Posted', 'Voided'].includes(p.status) &&
        validMoney(p.refunded) &&
        typeof p.voidReason === 'string' &&
        typeof p.voidDate === 'string' &&
        typeof p.createdBy === 'string' &&
        !!p.createdBy.trim() &&
        typeof p.createdAt === 'string' &&
        !isNaN(new Date(p.createdAt).getTime()) &&
        (p.legacy === undefined || p.legacy === true),
      'Invalid customer payment.',
    );
    numbers.add(p.number);
    dateCheck(p.date);
    required(p.date <= today(), 'Payment date cannot be in the future.');
    validateAllocations(p.allocations, p.customerId);
    validateAllocations(p.voidedAllocations, p.customerId);
    required(
      sum(p.voidedAllocations, (a) => a.amount) <= p.amount,
      'Payment allocations and refunds exceed its amount.',
    );
    required(
      sum(p.allocations, (a) => a.amount) + p.refunded <= p.amount,
      'Payment allocations and refunds exceed its amount.',
    );
    if (p.status === 'Voided') {
      required(
        !p.allocations.length && p.refunded === 0 && p.voidReason.trim(),
        'Voided payments cannot have allocations or refunds.',
      );
      dateCheck(p.voidDate);
      required(p.voidDate >= p.date && p.voidDate <= today(), 'Invalid payment void date.');
    } else
      required(
        p.voidReason === '' && p.voidDate === '' && !p.voidedAllocations.length,
        'Posted payments cannot have void details.',
      );
  });
  required(
    Number.isSafeInteger(s.counters.payment) &&
      s.counters.payment >= 1 &&
      s.payments.every((p) => Number(p.number.slice(4)) < s.counters.payment),
    'Invalid payment counter.',
  );
  s.refunds.forEach((r) => {
    required(
      contact(s, r.customerId)?.type === 'Customer' &&
        validMoney(r.amount) &&
        r.amount > 0 &&
        typeof r.method === 'string' &&
        r.method.trim() &&
        typeof r.createdBy === 'string' &&
        r.createdBy.trim() &&
        Array.isArray(r.from) &&
        r.from.length,
      'Invalid refund.',
    );
    dateCheck(r.date);
    required(r.date <= today(), 'Refund date cannot be in the future.');
    const sources = new Set<string>();
    r.from.forEach((f) => {
      required(
        ['payment', 'credit_note'].includes(f.kind) && !sources.has(f.kind + f.id),
        'Invalid refund source.',
      );
      sources.add(f.kind + f.id);
      const source =
        f.kind === 'payment'
          ? s.payments.find((p) => p.id === f.id && p.status === 'Posted')
          : s.creditNotes.find((cn) => cn.id === f.id && cn.status === 'Issued');
      required(
        source?.customerId === r.customerId && validMoney(f.amount) && f.amount > 0,
        'Invalid refund source.',
      );
    });
    required(sum(r.from, (f) => f.amount) === r.amount, 'Refund sources do not match its amount.');
  });
  for (const [kind, sources] of [
    ['payment', s.payments],
    ['credit_note', s.creditNotes],
  ] as const)
    sources.forEach((source) =>
      required(
        source.refunded ===
          sum(s.refunds, (r) =>
            sum(
              r.from.filter((f) => f.kind === kind && f.id === source.id),
              (f) => f.amount,
            ),
          ),
        'Source refunds do not match the refunded balance.',
      ),
    );

  s.purchases.forEach((p) => {
    required(
      contact(s, p.supplierId)?.type === 'Supplier' &&
        ids.warehouses.has(p.warehouseId) &&
        Array.isArray(p.lines) &&
        p.lines.length &&
        ['Draft', 'Sent', 'Received', 'Canceled'].includes(p.status),
      'Invalid purchase order.',
    );
    required((p as any).paid === undefined, 'Purchase orders cannot have paid balance.');
    const lineIds = new Set<string>();
    p.lines.forEach((l) => {
      required(
        typeof l.id === 'string' && l.id && !lineIds.has(l.id),
        'Invalid or duplicate purchase order line identifier.',
      );
      lineIds.add(l.id);
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
      required(
        Number.isSafeInteger(l.closedQty) && l.closedQty >= 0,
        'Invalid purchase line closed quantity.',
      );
      required(
        receivedQty(s, p, l.id) + l.closedQty <= l.qty,
        'Purchase order line received quantity plus closed quantity exceeds ordered quantity.',
      );
      required(openQty(s, p, l.id) >= 0, 'Purchase order line cannot have negative open quantity.');
    });
    required(sum(p.lines, (l) => l.qty * l.price) === p.total, 'Invalid purchase order totals.');
    if (p.status === 'Received') {
      required(
        p.lines.every((l) => openQty(s, p, l.id) === 0),
        'Received purchase orders cannot have open quantities.',
      );
    }
    if (p.status === 'Sent') {
      required(
        p.lines.some((l) => openQty(s, p, l.id) > 0),
        'Sent purchase orders must have open quantities.',
      );
    }
    if (p.closeReason !== undefined) {
      required(
        typeof p.closeReason === 'string' && p.closeReason.trim(),
        'Invalid purchase close reason.',
      );
    }
    dateCheck(p.date);
    dateCheck(p.expected);
    required(
      typeof p.createdAt === 'string' &&
        !isNaN(new Date(p.createdAt).getTime()) &&
        typeof p.createdBy === 'string' &&
        p.createdBy.trim(),
      'Invalid purchase order creation audit.',
    );
    if (['Sent', 'Received'].includes(p.status)) {
      required(
        typeof p.sentAt === 'string' && p.sentAt && typeof p.sentBy === 'string' && p.sentBy.trim(),
        'Invalid purchase order sent audit.',
      );
      dateCheck(p.sentAt);
    } else if (p.status === 'Draft') {
      required(
        p.sentAt === undefined && p.sentBy === undefined,
        'Draft purchase orders cannot have sent audit.',
      );
    }
    if (p.sentAt !== undefined) {
      dateCheck(p.sentAt);
      required(
        typeof p.sentBy === 'string' && p.sentBy.trim(),
        'Invalid purchase order sent audit.',
      );
    }
    if (p.approval !== undefined) {
      const a = p.approval;
      required(
        a &&
          typeof a.by === 'string' &&
          a.by.trim() &&
          typeof a.at === 'string' &&
          !isNaN(new Date(a.at).getTime()) &&
          moneyCheck(a.amount) === a.amount &&
          typeof a.note === 'string',
        'Invalid purchase order approval.',
      );
    }
  });

  const receiptNumbers = new Set<string>();
  s.receipts.forEach((r) => {
    required(
      typeof r.number === 'string' &&
        /^GRN-\d{4,}$/.test(r.number) &&
        !receiptNumbers.has(r.number),
      'Invalid or duplicate receipt number.',
    );
    receiptNumbers.add(r.number);
    required(
      Number(r.number.slice(4)) < s.counters.receipt,
      'Receipt counter must exceed existing receipt numbers.',
    );
    required(contact(s, r.supplierId)?.type === 'Supplier', 'Unknown receipt supplier.');
    required(ids.warehouses.has(r.warehouseId), 'Unknown receipt warehouse.');
    dateCheck(r.date);
    dateCheck(r.due);
    required(r.due >= r.date, 'Receipt due date cannot be before receipt date.');
    moneyCheck(r.total);
    moneyCheck(r.paid);
    moneyCheck(r.credited);
    required(
      r.paid >= 0 && r.credited >= 0 && round(r.paid + r.credited) <= r.total,
      'Invalid receipt payment balance.',
    );
    if (r.purchaseId !== undefined) {
      const po = s.purchases.find((p) => p.id === r.purchaseId);
      required(
        po && po.supplierId === r.supplierId && po.warehouseId === r.warehouseId,
        'Invalid receipt purchase order reference.',
      );
    }
    required(Array.isArray(r.lines), 'Receipt lines must be an array.');
    if (!r.legacy) {
      required(r.lines.length > 0, 'Receipt must have at least one line.');
    }
    r.lines.forEach((l) => {
      required(ids.products.has(l.productId), 'Unknown receipt product.');
      qtyCheck(l.qty);
      moneyCheck(l.price);
      required(
        units.includes(l.unit) &&
          Number.isSafeInteger(l.factor) &&
          l.factor >= 1 &&
          Number.isSafeInteger(l.qty * l.factor),
        'Invalid receipt line unit or factor.',
      );
      if (!r.legacy) {
        const b = s.batches.find((b) => b.id === l.batchId);
        required(
          b && b.productId === l.productId && b.warehouseId === r.warehouseId,
          'Invalid receipt batch reference.',
        );
      }
    });
    if (!r.legacy || r.lines.length > 0) {
      required(
        round(sum(r.lines, (l) => l.qty * l.price)) === r.total,
        'Receipt total does not match its lines.',
      );
    }
  });

  s.receipts
    .filter((r) => !r.legacy)
    .forEach((r) => {
      const moves = s.stockMoves.filter((m) => m.type === 'receipt' && m.sourceId === r.id);
      required(moves.length === r.lines.length, 'Receipt stock moves do not match its lines.');
      r.lines.forEach((l) => {
        const match = moves.find((m) => m.batchId === l.batchId && m.qty === l.qty * l.factor);
        required(match, 'Receipt line stock move missing or mismatch.');
      });
    });

  const b = balances(s);
  required(
    b.inventory.balance === inventoryValue(s),
    'Backup inventory does not match the ledger.',
  );
  required(
    b.receivable.balance ===
      round(
        sum(s.invoices, invoiceBalance) -
          sum(
            s.contacts.filter((c) => c.type === 'Customer'),
            (c) => customerCredit(s, c.id),
          ),
      ),
    'Backup customer balances do not match the ledger.',
  );
  required(
    b.payable.balance === round(sum(s.receipts, billBalance)),
    'Backup supplier balances do not match the ledger.',
  );
  return s;
}
export const A = {
  contactInUse,
  agingReport,
  customerStatement,
  overdueAmount,
  paymentCredit,
  customerCredit,
  openInvoices,
  recordPayment,
  applyCredit,
  removeAllocation,
  refundCredit,
  voidPayment,
  netSales,
  creditReasons,
  creditNoteAmounts,
  creditNotePicks,
  creditReturnOptions,
  proposeCreditReturns,
  creditAvailable,
  saveCreditNote,
  deleteCreditNote,
  issueCreditNote,
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
  priceFor,
  groupPriceFor,
  repriceLines,
  savePrice,
  deletePrice,
  belowCost,
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
  deliveriesOf,
  invoiceCost,
  invoicePicks,
  createDelivery,
  deliveryPickable,
  deliveryQuantities,
  pendingDeliveryQty,
  setPicks,
  cancelDelivery,
  dispatchDelivery,
  confirmDelivered,
  markNotDelivered,
  returnToStock,
  deliveredQty,
  openQty,
  orderTotals,
  orderOpenValue,
  fulfilmentStatus,
  quoteStatus,
  saveOrder,
  confirmOrder,
  reserveOrder,
  cancelRemaining,
  cancelOrder,
  closeIfDone,
  orderLineReserved,
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
  createInvoiceFromDeliveries,
  saveInvoiceHeader,
  deliveredNotInvoiced,
  invoicedQty,
  issueInvoice,
  payInvoice,
  deleteDraft,
  createPurchase,
  savePurchase,
  approvePurchase,
  sendPurchase,
  receivePurchase,
  receivedQty,
  purchaseStatus,
  billBalance,
  billStatus,
  openBills,
  closeRemaining,
  payBill,
  cancelPurchase,
  approvalRequired,
  setPurchaseSettings,
  lastPurchasePrice,
  purchaseLinePrice,
  expectedDate,
  belowMinimumOrder,
  accountDays,
  addExpense,
  saveContact,
  saveCustomerGroup,
  deleteCustomerGroup,
  creditCheck,
  customerAccountStatus,
  setAccountSettings,
  balances,
  transact,
  persist,
  load,
  emptyWorkspace,
  seed,
  migrate,
  validateBackup,
  CURRENT_USER,
};
