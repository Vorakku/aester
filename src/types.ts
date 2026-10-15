export type Page =
  | 'dashboard'
  | 'inventory'
  | 'batches'
  | 'warehouses'
  | 'purchasing'
  | 'invoices'
  | 'accounting'
  | 'analytics'
  | 'contacts'
  | 'settings';
export type AccountId =
  | 'cash'
  | 'receivable'
  | 'inventory'
  | 'payable'
  | 'tax'
  | 'equity'
  | 'revenue'
  | 'cogs'
  | 'expense'
  | 'loss';
export type AccountType = 'Asset' | 'Liability' | 'Equity' | 'Income' | 'Expense';
export type ContactType = 'Customer' | 'Supplier';
export type Unit =
  | 'box'
  | 'bottle'
  | 'pack'
  | 'tube'
  | 'device'
  | 'unit'
  | 'strip'
  | 'vial'
  | 'ampoule'
  | 'sachet'
  | 'carton'
  | 'case';
export interface Pack {
  id: string;
  unit: Unit;
  factor: number;
  barcode: string;
  price?: number;
}
export type Shape = 'box' | 'bottle' | 'tube' | 'device';
export type DosageForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'suspension'
  | 'injection'
  | 'cream'
  | 'ointment'
  | 'drops'
  | 'inhaler'
  | 'powder'
  | 'solution'
  | 'device'
  | 'other';
export type Storage = 'ambient' | 'cold';
export interface Product {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  generic: string;
  category: string;
  unit: Unit;
  packs: Pack[];
  cost: number;
  price: number;
  reorder: number;
  supplierId: string;
  color: string;
  shape: Shape;
  registrationNo: string;
  manufacturer: string;
  dosageForm: DosageForm;
  strength: string;
  rx: boolean;
  controlled: boolean;
  storage: Storage;
  nameKm: string;
  active: boolean;
}
export interface Batch {
  id: string;
  productId: string;
  code: string;
  qty: number;
  cost: number;
  expiry: string;
  warehouseId: string;
  received: string;
  quarantined: boolean;
}
export type MoveType =
  'opening' | 'receipt' | 'sale' | 'transfer_out' | 'transfer_in' | 'adjustment';
export interface StockMove {
  id: string;
  date: string;
  at: string;
  batchId: string;
  productId: string;
  warehouseId: string;
  lotCode: string;
  qty: number;
  unitCost: number;
  type: MoveType;
  reference: string;
  sourceId?: string;
  counterpartyId?: string;
  reason?: string;
  user: string;
}
export type AdjustmentReason =
  'damaged' | 'expired' | 'lost' | 'sample' | 'recall' | 'found' | 'count' | 'other';
export interface Adjustment {
  id: string;
  number: string;
  date: string;
  batchId: string;
  productId: string;
  warehouseId: string;
  lotCode: string;
  qty: number;
  unitCost: number;
  value: number;
  reason: AdjustmentReason;
  note: string;
  sourceId?: string;
  user: string;
}
export interface CountLine {
  batchId: string;
  productId: string;
  lotCode: string;
  expiry: string;
  expected: number;
  counted: number | null;
}
export interface StockCount {
  id: string;
  number: string;
  warehouseId: string;
  categories: string[];
  blind: boolean;
  status: 'Open' | 'Posted' | 'Canceled';
  note: string;
  createdAt: string;
  createdBy: string;
  postedAt?: string;
  postedBy?: string;
  lines: CountLine[];
}
export interface Contact {
  id: string;
  type: ContactType;
  name: string;
  person: string;
  email: string;
  phone: string;
  address: string;
  minShelfLifeDays: number | null;
  groupId: string;
  paymentTermsDays: number;
  creditLimit: number | null;
  onHold: boolean;
  holdReason: string;
  billing: 'per_delivery' | 'monthly';
}
export interface CustomerGroup {
  id: string;
  name: string;
  discountPercent: number;
}
export interface Recall {
  id: string;
  number: string;
  productId: string;
  lotCode: string;
  reason: string;
  date: string;
  status: 'Open' | 'Closed';
  createdBy: string;
  closedAt?: string;
  note: string;
}
export interface ReorderRule {
  productId: string;
  warehouseId: string;
  min: number;
  max: number;
}
// ponytail: product-level reservations; add warehouseId if branches start selling from their own stock
export interface Reservation {
  id: string;
  number: string;
  productId: string;
  customerId: string;
  qty: number;
  source: 'hold' | 'invoice';
  sourceId?: string;
  status: 'Active' | 'Released' | 'Fulfilled';
  expires?: string;
  note: string;
  createdAt: string;
  createdBy: string;
  closedAt?: string;
}
export interface Suggestion extends ReorderRule {
  supplierId: string;
  available: number;
  onOrder: number;
  position: number;
  orderBase: number;
  orderUnit: Unit;
  orderQty: number;
  estimatedCost: number;
}
export interface Warehouse {
  id: string;
  name: string;
  address: string;
  capacity: number;
  temperature: string;
  code: string;
  storage: Storage;
}
export interface Line {
  productId: string;
  name: string;
  sku: string;
  unit: Unit;
  factor: number;
  qty: number;
  price: number;
}
export interface Totals {
  subtotal: number;
  discount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}
export interface Payment {
  id: string;
  amount: number;
  date: string;
  method: string;
}
export interface Allocation {
  batchId: string;
  code: string;
  warehouseId: string;
  productId: string;
  qty: number;
  cost: number;
}
export interface Invoice extends Totals {
  creditOverride?: { by: string; at: string; reason: string; reasons: string[] };
  allowShortDated: boolean;
  id: string;
  number: string;
  customerId: string;
  date: string;
  due: string;
  lines: Line[];
  status: 'Draft' | 'Issued';
  paid: number;
  payments: Payment[];
  allocations: Allocation[];
  notes: string;
  cogs?: number;
}
export interface Purchase {
  id: string;
  number: string;
  supplierId: string;
  warehouseId: string;
  date: string;
  expected: string;
  lines: Line[];
  total: number;
  paid: number;
  status: 'Ordered' | 'Received' | 'Canceled';
  notes: string;
  received?: string;
  reference?: string;
}
export interface Receipt {
  id: string;
  date: string;
  reference: string;
  supplierId: string;
  total: number;
  paid: number;
  warehouseId: string;
  number?: string;
  received?: string;
}
export interface Expense {
  id: string;
  date: string;
  description: string;
  category: string;
  amount: number;
  reference: string;
}
export interface Movement {
  id: string;
  type: string;
  title: string;
  description: string;
  date: string;
  createdAt: string;
}
export interface JournalLine {
  account: AccountId;
  debit: number;
  credit: number;
}
export interface Journal {
  id: string;
  date: string;
  reference: string;
  description: string;
  entries: JournalLine[];
}
export interface Settings {
  defaultPaymentTermsDays: number;
  overdueGraceDays: number;
  minShelfLifeDays: number;
  company: string;
  address: string;
  email: string;
  phone: string;
  currency: 'USD';
  invoicePrefix: string;
  taxRate: number;
  expiryWindow: number;
}
export interface Workspace {
  version: 2;
  createdAt: string;
  settings: Settings;
  counters: {
    invoice: number;
    purchase: number;
    transfer: number;
    adjustment: number;
    count: number;
    recall: number;
    reservation: number;
  };
  products: Product[];
  batches: Batch[];
  contacts: Contact[];
  customerGroups: CustomerGroup[];
  warehouses: Warehouse[];
  invoices: Invoice[];
  purchases: Purchase[];
  receipts: Receipt[];
  journal: Journal[];
  expenses: Expense[];
  movements: Movement[];
  stockMoves: StockMove[];
  adjustments: Adjustment[];
  stockCounts: StockCount[];
  recalls: Recall[];
  reorderRules: ReorderRule[];
  reservations: Reservation[];
}
export type NumericInput = number | string;
export interface AdjustmentInput {
  batchId: string;
  qty: NumericInput;
  reason: AdjustmentReason;
  note?: string;
  date?: string;
}
export type FormValues = Record<string, string>;
export interface LineInput {
  productId: string;
  unit?: Unit;
  qty: NumericInput;
  price?: NumericInput;
  cost?: NumericInput;
}
export type PackInput = Omit<Pack, 'id' | 'factor' | 'price'> & {
  id?: string;
  factor: NumericInput;
  price?: NumericInput;
};
type PharmaFields = Pick<
  Product,
  | 'registrationNo'
  | 'manufacturer'
  | 'dosageForm'
  | 'strength'
  | 'rx'
  | 'controlled'
  | 'storage'
  | 'nameKm'
  | 'active'
>;
export type ProductInput = Omit<
  Product,
  'id' | 'cost' | 'price' | 'reorder' | 'packs' | keyof PharmaFields
> &
  Partial<PharmaFields> & {
    cost: NumericInput;
    price: NumericInput;
    reorder: NumericInput;
    packs?: PackInput[];
  };
type CustomerAccountFields = Pick<Contact, 'groupId' | 'onHold' | 'holdReason' | 'billing'>;
export type ContactInput = Omit<
  Contact,
  'id' | 'minShelfLifeDays' | 'paymentTermsDays' | 'creditLimit' | keyof CustomerAccountFields
> &
  Partial<CustomerAccountFields> & {
    minShelfLifeDays?: NumericInput | null;
    paymentTermsDays?: NumericInput;
    creditLimit?: NumericInput | null;
  };
export interface StockInput {
  productId: string;
  unit?: Unit;
  warehouseId: string;
  qty: NumericInput;
  cost: NumericInput;
  expiry: string;
  code: string;
  received?: string;
  quarantined?: boolean;
  reference?: string;
  supplierId?: string;
  payment?: string;
}
export interface InvoiceInput {
  fromHoldIds?: string[];
  allowShortDated?: boolean;
  customerId: string;
  date: string;
  due?: string;
  lines: LineInput[];
  discount?: NumericInput;
  taxRate?: NumericInput;
  notes?: string;
}
export interface PurchaseInput {
  supplierId: string;
  warehouseId: string;
  date: string;
  expected: string;
  lines: LineInput[];
  notes?: string;
}
export type PurchaseInitial = Pick<PurchaseInput, 'supplierId' | 'warehouseId' | 'lines'>;
export type InvoiceInitial = Pick<InvoiceInput, 'customerId' | 'lines' | 'fromHoldIds'>;
export interface ExpenseInput {
  amount: NumericInput;
  date: string;
  description: string;
  category?: string;
  reference?: string;
}
export type Balances = Record<AccountId, { debit: number; credit: number; balance: number }>;
