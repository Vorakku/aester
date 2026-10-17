import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { errorMessage, money, number, shortDate } from '../lib/format';
import {
  Button,
  Badge,
  Callout,
  ContactOptions,
  Empty,
  Field,
  FormFooter,
  Icon,
  IconButton,
  SelectField,
  WarehouseOptions,
} from './ui';
import type {
  AdjustmentReason,
  ContactType,
  DosageForm,
  FormValues,
  Invoice,
  InvoiceInitial,
  LineInput,
  PurchaseInitial,
  Storage,
  Unit,
  SalesOrder,
} from '../types';

export function WorkspaceForm({
  onSubmit,
  children,
  className = '',
}: {
  onSubmit: (values: FormValues, mode: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget)) as FormValues;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    try {
      onSubmit(values, submitter instanceof HTMLButtonElement ? submitter.value : '');
    } catch (error) {
      setError(errorMessage(error));
      setTimeout(() => errorRef.current?.scrollIntoView({ block: 'nearest' }), 0);
    }
  }
  return (
    <form onSubmit={submit} className={className}>
      <div className="form-error" ref={errorRef} role="alert">
        {error}
      </div>
      {children}
    </form>
  );
}
export function ProductForm({ id }: { id?: string }) {
  const { state, mutate } = useWorkspace();
  const p = id ? A.product(state, id) : undefined;
  const [baseUnit, setBaseUnit] = useState<Unit>(p?.unit || 'box');
  const [active, setActive] = useState(p?.active ?? true);
  const inactiveReason = p?.active ? A.inactiveReason(state, p.id) : '';
  const [packs, setPacks] = useState(() =>
    (p?.packs || []).map((pack) => ({
      key: pack.id,
      id: pack.id,
      unit: pack.unit,
      factor: String(pack.factor),
      barcode: pack.barcode,
      price: pack.price === undefined ? '' : String(pack.price),
    })),
  );
  const locked = !!id && A.baseUnitLocked(state, id);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.saveProduct(
              s,
              {
                name: data.name,
                sku: data.sku,
                barcode: data.barcode,
                generic: data.generic,
                registrationNo: data.registrationNo,
                manufacturer: data.manufacturer,
                dosageForm: data.dosageForm as DosageForm,
                strength: data.strength,
                rx: data.rx === 'on',
                controlled: data.controlled === 'on',
                storage: data.storage as Storage,
                nameKm: data.nameKm,
                active,
                category: data.category,
                unit: baseUnit,
                packs: packs.map(({ id, unit, factor, barcode, price }) => ({
                  id,
                  unit,
                  factor,
                  barcode,
                  price,
                })),
                cost: data.cost,
                price: data.price,
                reorder: data.reorder,
                supplierId: data.supplierId,
                color: p?.color || '#78a68c',
                shape:
                  p?.shape ||
                  (data.unit === 'bottle' ? 'bottle' : data.unit === 'tube' ? 'tube' : 'box'),
              },
              id,
            ),
          'Product saved.',
        )
      }
    >
      <div className="form-grid">
        <Field label="Product name" name="name" defaultValue={p?.name} full required />
        <Field label="Khmer name" name="nameKm" defaultValue={p?.nameKm} full />
        <Field
          label="SKU"
          name="sku"
          defaultValue={p?.sku || `AST-${String(state.products.length + 1).padStart(4, '0')}`}
          required
        />
        <Field label="Barcode (optional)" name="barcode" defaultValue={p?.barcode} />
        <Field label="Generic / active ingredient" name="generic" defaultValue={p?.generic} full />
        <SelectField label="Category" name="category" defaultValue={p?.category || A.categories[0]}>
          {A.categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </SelectField>
        <Field
          label="Default purchase cost ($)"
          name="cost"
          type="number"
          defaultValue={p?.cost || 0}
          min="0"
          step="0.01"
          required
        />
        <Field
          label="Selling price ($)"
          name="price"
          type="number"
          defaultValue={p?.price || 0}
          min="0"
          step="0.01"
          required
        />
        <Field
          label="Reorder level (units)"
          name="reorder"
          type="number"
          defaultValue={p?.reorder ?? 40}
          min="0"
          step="1"
          required
        />
        <SelectField
          label="Preferred supplier"
          name="supplierId"
          defaultValue={p?.supplierId || ''}
          required={false}
        >
          <ContactOptions type="Supplier" placeholder="No preferred supplier" />
        </SelectField>
      </div>
      <div className="form-section">Regulatory</div>
      <div className="form-grid">
        <Field label="Registration no." name="registrationNo" defaultValue={p?.registrationNo} />
        <Field label="Manufacturer" name="manufacturer" defaultValue={p?.manufacturer} />
        <SelectField label="Dosage form" name="dosageForm" defaultValue={p?.dosageForm || 'other'}>
          {A.dosageForms.map((form) => (
            <option key={form}>{form}</option>
          ))}
        </SelectField>
        <Field label="Strength" name="strength" defaultValue={p?.strength} />
        <Field label="Prescription only" name="rx" type="checkbox" defaultChecked={p?.rx} />
        <Field
          label="Controlled substance"
          name="controlled"
          type="checkbox"
          defaultChecked={p?.controlled}
        />
      </div>
      <div className="form-section">Storage</div>
      <SelectField label="Storage" name="storage" defaultValue={p?.storage || 'ambient'}>
        <option value="ambient">Ambient (15–25°C)</option>
        <option value="cold">Cold chain (2–8°C)</option>
      </SelectField>
      {id && (
        <>
          <Field
            label="Active"
            name="active"
            type="checkbox"
            checked={active}
            disabled={active && !!inactiveReason}
            onChange={(event) => setActive(event.target.checked)}
          />
          {active && inactiveReason && <Callout>{inactiveReason}</Callout>}
        </>
      )}
      <div className="form-section">Packaging</div>
      <SelectField
        label="Base unit"
        name="unit"
        defaultValue={baseUnit}
        disabled={locked}
        onChange={(value) => setBaseUnit(value as Unit)}
      >
        {A.units.map((unit) => (
          <option key={unit}>{unit}</option>
        ))}
      </SelectField>
      {locked && <Callout>The base unit can't change after stock or documents exist.</Callout>}
      {packs.map((pack, index) => (
        <div className="my-[18px]" key={pack.key}>
          <div className="form-grid">
            <SelectField
              label="Pack unit"
              name={`packUnit-${index}`}
              defaultValue={pack.unit}
              onChange={(value) =>
                setPacks((items) =>
                  items.map((item) =>
                    item.key === pack.key ? { ...item, unit: value as Unit } : item,
                  ),
                )
              }
            >
              {A.units
                .filter((unit) => unit !== baseUnit)
                .map((unit) => (
                  <option key={unit}>{unit}</option>
                ))}
            </SelectField>
            <Field
              label={`Contains (${A.unitLabel(baseUnit)})`}
              name={`packFactor-${index}`}
              type="number"
              min="2"
              max="10000"
              step="1"
              required
              value={pack.factor}
              onChange={(event) =>
                setPacks((items) =>
                  items.map((item) =>
                    item.key === pack.key ? { ...item, factor: event.target.value } : item,
                  ),
                )
              }
            />
            <Field
              label="Pack barcode (optional)"
              name={`packBarcode-${index}`}
              value={pack.barcode}
              onChange={(event) =>
                setPacks((items) =>
                  items.map((item) =>
                    item.key === pack.key ? { ...item, barcode: event.target.value } : item,
                  ),
                )
              }
            />
            <Field
              label="Pack sale price (optional)"
              name={`packPrice-${index}`}
              type="number"
              min="0"
              step="0.01"
              value={pack.price}
              onChange={(event) =>
                setPacks((items) =>
                  items.map((item) =>
                    item.key === pack.key ? { ...item, price: event.target.value } : item,
                  ),
                )
              }
            />
          </div>
          <Button
            tone="small"
            icon="trash"
            onClick={() => setPacks((items) => items.filter((item) => item.key !== pack.key))}
          >
            Remove pack
          </Button>
        </div>
      ))}
      <Button
        tone="small"
        onClick={() =>
          setPacks((items) => [
            ...items,
            {
              key: A.uid('pack-row'),
              id: '',
              unit:
                (['carton', 'case', ...A.units] as Unit[]).find(
                  (unit) => unit !== baseUnit && !items.some((item) => item.unit === unit),
                ) || 'carton',
              factor: '50',
              barcode: '',
              price: '',
            },
          ])
        }
      >
        Add pack
      </Button>
      <FormFooter label={id ? 'Save product' : 'Add product'} />
    </WorkspaceForm>
  );
}
export function ReceiveForm({ id }: { id?: string }) {
  const { state, mutate } = useWorkspace();
  const [productId, setProductId] = useState(id || '');
  const [unit, setUnit] = useState<Unit>(A.product(state, id || '')?.unit || 'box');
  const p = A.product(state, productId);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.receiveStock(s, {
              productId: data.productId,
              unit,
              code: data.code,
              expiry: data.expiry,
              qty: data.qty,
              cost: data.cost,
              warehouseId: data.warehouseId,
              supplierId: data.supplierId,
              payment: data.payment,
              reference: data.reference,
            }),
          'Stock received. Inventory and accounts updated.',
        )
      }
    >
      <div className="form-grid">
        <SelectField
          label="Product"
          name="productId"
          defaultValue={id || ''}
          full
          onChange={(value) => {
            setProductId(value);
            setUnit(A.product(state, value)?.unit || 'box');
          }}
        >
          <option value="">Select product</option>
          {state.products
            .filter((p) => p.active)
            .map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
        </SelectField>
        <SelectField
          key={`unit-${productId}`}
          label="Receipt unit"
          name="unit"
          defaultValue={unit}
          onChange={(value) => setUnit(value as Unit)}
        >
          {p &&
            [p.unit, ...p.packs.map((pack) => pack.unit)].map((unit) => (
              <option key={unit}>{unit}</option>
            ))}
        </SelectField>
        <Field label="Batch / lot number" name="code" required />
        <Field
          label="Expiry date"
          name="expiry"
          type="date"
          defaultValue={A.shift(365)}
          min={A.shift(1)}
          required
        />
        <Field
          label={`Quantity (${A.unitLabel(unit)})`}
          name="qty"
          type="number"
          defaultValue={100}
          min="1"
          step="1"
          required
        />
        <Field
          key={`cost-${productId}-${unit}`}
          label={`Unit cost per ${unit} ($)`}
          name="cost"
          type="number"
          defaultValue={p ? A.unitPrice(p, unit, true) : 0}
          min="0"
          step="0.01"
          required
        />
        <SelectField
          key={`warehouse-${p?.storage}`}
          label="Warehouse"
          name="warehouseId"
          defaultValue={
            p?.storage === 'cold'
              ? state.warehouses.find((w) => w.storage === 'cold')?.id
              : 'wh_main'
          }
        >
          <WarehouseOptions coldOnly={p?.storage === 'cold'} />
        </SelectField>
        <SelectField
          key={`supplier-${productId}`}
          label="Supplier"
          name="supplierId"
          defaultValue={p?.supplierId || ''}
        >
          <ContactOptions type="Supplier" />
        </SelectField>
        <Field
          label="Supplier invoice / delivery note no."
          name="reference"
          placeholder="e.g. INV-10492"
          full
        />
        <SelectField label="Payment source" name="payment" defaultValue="credit" full>
          <option value="credit">Supplier credit — accounts payable</option>
          <option value="cash">Paid from cash & bank</option>
        </SelectField>
      </div>
      <Callout>
        {p?.storage === 'cold' && (
          <>
            Cold-chain product — cold storage only
            <br />
          </>
        )}
        Stock value uses the actual batch cost. Supplier credit creates a bill in Accounting →
        Payables.
      </Callout>
      <FormFooter label="Receive stock" />
    </WorkspaceForm>
  );
}
export function TransferForm({ id }: { id?: string }) {
  const { state, mutate } = useWorkspace();
  const [batchId, setBatchId] = useState(id || '');
  const batch = state.batches.find((b) => b.id === batchId),
    p = A.product(state, batch?.productId || '');
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) => A.transferStock(s, { batchId: data.batchId, qty: data.qty, to: data.to }),
          'Stock transferred.',
        )
      }
    >
      <div className="form-grid">
        <SelectField
          label="Source batch"
          name="batchId"
          defaultValue={id || ''}
          onChange={setBatchId}
          full
        >
          <option value="">Select a batch</option>
          {state.batches
            .filter((b) => b.qty > 0)
            .map((b) => (
              <option key={b.id} value={b.id}>
                {A.product(state, b.productId)?.name} · {b.code} ·{' '}
                {A.warehouse(state, b.warehouseId)?.name} ({b.qty})
              </option>
            ))}
        </SelectField>
        <SelectField key={`destination-${p?.storage}`} label="Destination warehouse" name="to">
          <WarehouseOptions placeholder="Select destination" coldOnly={p?.storage === 'cold'} />
        </SelectField>
        <Field
          label="Quantity to transfer"
          name="qty"
          type="number"
          defaultValue={1}
          min="1"
          step="1"
          required
        />
      </div>
      <Callout>
        {p?.storage === 'cold' && (
          <>
            Cold-chain product — cold storage only
            <br />
          </>
        )}
        The batch number, expiry date, quality status and unit cost are preserved. Total inventory
        value stays the same.
      </Callout>
      <FormFooter label="Transfer stock" />
    </WorkspaceForm>
  );
}
export function AdjustmentForm({
  id,
  writeOffAll = false,
  recall = false,
}: {
  id: string;
  writeOffAll?: boolean;
  recall?: boolean;
}) {
  const { state, mutate } = useWorkspace();
  const b = state.batches.find((b) => b.id === id);
  const [direction, setDirection] = useState<'remove' | 'add'>('remove');
  const [qty, setQty] = useState(String(writeOffAll || recall ? b?.qty || 0 : 1));
  const [selectedReason, setSelectedReason] = useState<AdjustmentReason>(
    recall ? 'recall' : 'damaged',
  );
  if (!b) return null;
  const p = A.product(state, b.productId)!;
  const expired = A.daysLeft(b.expiry) <= 0;
  const reason = writeOffAll && expired ? 'expired' : selectedReason;
  const quantity = writeOffAll ? b.qty : Number(qty),
    signedQty = direction === 'add' ? quantity : -quantity,
    value = A.round(signedQty * b.cost);
  const formatted = A.formatQty(p, Number.isFinite(quantity) ? quantity : 0);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.adjustStock(s, {
              batchId: id,
              qty: signedQty,
              reason,
              note: data.note,
              date: data.date,
            }),
          writeOffAll
            ? 'Stock written off. Inventory and accounts updated.'
            : 'Stock adjusted. Inventory and accounts updated.',
        )
      }
    >
      <Callout>
        {p.name} · {b.code} · {A.warehouse(state, b.warehouseId)?.name}. To add stock for a lot that
        isn't in the system, use Receive stock.
      </Callout>
      {!writeOffAll && !recall && (
        <div className="detail-actions" role="group" aria-label="Adjustment direction">
          <Button
            tone={direction === 'remove' ? 'primary' : ''}
            icon="trash"
            aria-pressed={direction === 'remove'}
            onClick={() => {
              setDirection('remove');
              setSelectedReason('damaged');
            }}
          >
            Remove
          </Button>
          <Button
            tone={direction === 'add' ? 'primary' : ''}
            aria-pressed={direction === 'add'}
            onClick={() => {
              setDirection('add');
              setSelectedReason('found');
            }}
          >
            Add
          </Button>
        </div>
      )}
      <div className="form-grid mt-[18px]">
        <Field
          label={`Quantity (${A.unitLabel(p.unit)})`}
          name="qty"
          type="number"
          value={qty}
          min="1"
          step="1"
          required
          disabled={writeOffAll}
          onChange={(event) => setQty(event.target.value)}
        />
        <SelectField
          key={`${direction}-${reason === 'expired' && writeOffAll}`}
          label="Reason"
          name="reason"
          defaultValue={reason}
          disabled={recall || (writeOffAll && expired)}
          onChange={(value) => setSelectedReason(value as AdjustmentReason)}
        >
          {A.adjustmentReasonsFor(direction === 'add' ? 1 : -1).map((reason) => (
            <option key={reason} value={reason}>
              {A.adjustmentReasons[reason]}
            </option>
          ))}
        </SelectField>
        <div className="form-field full muted text-[10px]">{formatted.packs || formatted.main}</div>
        <Field label="Note" name="note" full required={reason === 'other' || reason === 'found'} />
        <Field
          label="Adjustment date"
          name="date"
          type="date"
          defaultValue={A.today()}
          max={A.today()}
          full
          required
        />
      </div>
      {Number.isFinite(value) && (
        <Callout>
          Stock {number(b.qty)} → {number(b.qty + signedQty)} {A.unitLabel(p.unit)} · Inventory{' '}
          {value > 0 ? '+' : value < 0 ? '−' : ''}
          {money(Math.abs(value))}
        </Callout>
      )}
      <FormFooter label={writeOffAll ? 'Write off all' : 'Adjust stock'} />
    </WorkspaceForm>
  );
}
interface EditableLine {
  key: string;
  id?: string;
  productId: string;
  qty: string;
  price: string;
  unit?: Unit;
  factor: number;
}
function newLine(line?: LineInput & { factor?: number; id?: string }): EditableLine {
  return {
    key: A.uid('line'),
    id: line?.id,
    productId: line?.productId || '',
    qty: String(line?.qty || 1),
    price: String(line?.price ?? line?.cost ?? 0),
    unit: line?.unit,
    factor: line?.factor || 1,
  };
}
export function TransactionForm({
  id,
  purchase = false,
  order = false,
  asQuote = true,
  initial,
}: {
  id?: string;
  purchase?: boolean;
  order?: boolean;
  asQuote?: boolean;
  initial?: PurchaseInitial | InvoiceInitial;
}) {
  const { state, mutate, open, close, toast } = useWorkspace();
  const invoice = id ? state.invoices.find((i) => i.id === id) : undefined;
  const salesOrder = order && id ? state.orders.find((o) => o.id === id) : undefined;
  const purchaseOrder = purchase && id ? state.purchases.find((p) => p.id === id) : undefined;
  const quotation = salesOrder ? salesOrder.status === 'Quote' : asQuote;
  const [lines, setLines] = useState<EditableLine[]>(
    () =>
      purchaseOrder?.lines.map(newLine) ||
      salesOrder?.lines.map(newLine) ||
      invoice?.lines.map(newLine) ||
      initial?.lines.map((line) =>
        newLine({
          ...line,
          factor: A.unitFactor(A.product(state, line.productId)!, line.unit),
          ...(!purchase
            ? {
                price: A.priceFor(state, {
                  productId: line.productId,
                  unit: line.unit || A.product(state, line.productId)!.unit,
                  customerId: initial && 'customerId' in initial ? initial.customerId : undefined,
                }).price,
              }
            : line.cost !== undefined
              ? { cost: line.cost }
              : {
                  cost: A.purchaseLinePrice(
                    state,
                    initial && 'supplierId' in initial ? initial.supplierId : '',
                    line.productId,
                    line.unit || A.product(state, line.productId)!.unit,
                  ),
                }),
        }),
      ) || [newLine()],
  );
  const [discount, setDiscount] = useState(
      String(salesOrder?.discountPercent ?? invoice?.discount ?? 0),
    ),
    [taxRate, setTaxRate] = useState(
      String(salesOrder?.taxRate ?? invoice?.taxRate ?? state.settings.taxRate),
    );
  const [scan, setScan] = useState('');
  const [customerId, setCustomerId] = useState(
    salesOrder?.customerId ||
      invoice?.customerId ||
      (initial && 'customerId' in initial ? initial.customerId : ''),
  );
  const [supplierId, setSupplierId] = useState(
    purchaseOrder?.supplierId || (initial && 'supplierId' in initial ? initial.supplierId : ''),
  );
  const [allowShortDated, setAllowShortDated] = useState(
    salesOrder?.allowShortDated || invoice?.allowShortDated || false,
  );
  const [invoiceDate, setInvoiceDate] = useState(
    purchaseOrder?.date || salesOrder?.date || invoice?.date || A.today(),
  );
  const [expected, setExpected] = useState(
    () =>
      purchaseOrder?.expected ||
      (supplierId ? A.expectedDate(state, supplierId, invoiceDate) : A.shift(5, invoiceDate)),
  );
  const defaultDue = (date: string, customer: string) =>
    A.shift(
      A.contact(state, customer)?.paymentTermsDays ?? state.settings.defaultPaymentTermsDays,
      date,
    );
  const [due, setDue] = useState(invoice?.due || defaultDue(invoiceDate, customerId));
  const [attemptedIssue, setAttemptedIssue] = useState(false);
  const saleOptions = {
    customerId,
    allowShortDated,
    exceptSourceId: salesOrder?.id || invoice?.id,
  };
  const shortLots = purchase ? [] : A.shortDatedBatches(state, lines, saleOptions);
  const coldOnly = purchase && lines.some((l) => A.product(state, l.productId)?.storage === 'cold');
  const subtotal = A.sum(
    lines,
    (l) =>
      (Number(l.qty) - (salesOrder?.lines.find((old) => old.id === l.id)?.cancelledQty || 0)) *
      Number(l.price),
  );
  const poApprovalReq =
    purchase &&
    A.approvalRequired(state, {
      total: subtotal,
      approval: purchaseOrder?.approval,
    });
  const discountValue = purchase
      ? 0
      : order
        ? A.round((subtotal * (Number(discount) || 0)) / 100)
        : Number(discount) || 0,
    taxValue = purchase ? 0 : Number(taxRate) || 0;
  const tax = A.round((Math.max(0, subtotal - discountValue) * taxValue) / 100);
  const saleTotal = Math.max(0, subtotal - discountValue + tax);
  const credit =
    !purchase && customerId && Number.isFinite(saleTotal) && saleTotal <= 100000000
      ? A.creditCheck(
          state,
          customerId,
          salesOrder?.status === 'Confirmed'
            ? Math.max(0, A.round(saleTotal - A.orderTotals(salesOrder).total))
            : saleTotal,
        )
      : undefined;
  function update(key: string, field: 'productId' | 'unit' | 'qty' | 'price', value: string) {
    setLines((current) =>
      current.map((line) => {
        if (line.key !== key) return line;
        if (field === 'productId' || field === 'unit') {
          const p = A.product(state, field === 'productId' ? value : line.productId);
          const unit = field === 'productId' ? p?.unit : (value as Unit);
          return {
            ...line,
            ...(field === 'productId' ? { productId: value } : {}),
            unit,
            factor: p ? A.unitFactor(p, unit) : 1,
            price: String(
              p
                ? purchase
                  ? A.purchaseLinePrice(state, supplierId, p.id, unit || p.unit)
                  : A.priceFor(state, { productId: p.id, unit: unit || p.unit, customerId }).price
                : 0,
            ),
          };
        }
        return { ...line, [field]: value };
      }),
    );
  }
  function scanBarcode() {
    const found = A.findBarcode(state, scan);
    if (!found) {
      toast('Barcode not found.', true);
      return;
    }
    const p = found.product,
      unit = found.pack?.unit || p.unit;
    try {
      A.activeProduct(state, p.id);
    } catch (error) {
      toast(errorMessage(error), true);
      return;
    }
    setLines((current) => {
      const existing = current.find(
        (line) => line.productId === p.id && (line.unit || p.unit) === unit,
      );
      if (existing)
        return current.map((line) =>
          line.key === existing.key ? { ...line, qty: String(Number(line.qty) + 1) } : line,
        );
      const line = newLine({
        productId: p.id,
        unit,
        factor: A.unitFactor(p, unit),
        qty: 1,
        price: purchase
          ? A.purchaseLinePrice(state, supplierId, p.id, unit)
          : A.priceFor(state, { productId: p.id, unit, customerId }).price,
      });
      const blank = current.find((line) => !line.productId);
      return blank
        ? current.map((item) => (item.key === blank.key ? line : item))
        : [...current, line];
    });
    setScan('');
  }
  if (invoice && invoice.status !== 'Draft')
    return <Callout>Only draft invoices can be edited.</Callout>;
  if (salesOrder && ['Done', 'Cancelled'].includes(salesOrder.status))
    return <Callout>This order is closed.</Callout>;
  return (
    <WorkspaceForm
      onSubmit={(data, mode) => {
        const issuing = mode === 'issue' || mode === 'override';
        if (!purchase && issuing) setAttemptedIssue(true);
        const items: LineInput[] = lines.map((line) => ({
          productId: line.productId,
          unit: line.unit,
          qty: Number(line.qty),
          [purchase ? 'cost' : 'price']: Number(line.price),
        }));
        if (order) {
          mutate(
            (s) => {
              const saved = A.saveOrder(
                s,
                {
                  customerId,
                  date: data.date,
                  validUntil: data.validUntil,
                  requestedDate: data.requestedDate,
                  fulfilment: data.fulfilment as 'delivery' | 'pickup',
                  deliveryAddress: data.deliveryAddress,
                  lines: lines.map((line, index) => ({ ...items[index], id: line.id })),
                  discountPercent: discount,
                  taxRate,
                  allowShortDated,
                  notes: data.notes,
                  override: mode === 'override' ? { reason: data.overrideReason } : undefined,
                },
                id,
              );
              if (issuing && saved.status === 'Quote')
                A.confirmOrder(s, saved.id, {
                  override: mode === 'override' ? { reason: data.overrideReason } : undefined,
                });
              return saved;
            },
            issuing ? 'Order confirmed.' : 'Order saved.',
            (saved) => open('order-detail', saved.id),
          );
        } else if (purchase) {
          const sending = mode === 'send';
          mutate(
            (s) => {
              if (id) {
                const po = A.savePurchase(
                  s,
                  {
                    supplierId: data.supplierId,
                    warehouseId: data.warehouseId,
                    date: data.date,
                    expected: data.expected,
                    lines: lines.map((line, index) => ({ ...items[index], id: line.id })),
                    notes: data.notes,
                  },
                  id,
                );
                if (sending) {
                  A.sendPurchase(s, id, data.date > A.today() ? A.today() : data.date);
                }
                return po;
              }
              return A.createPurchase(s, {
                supplierId: data.supplierId,
                warehouseId: data.warehouseId,
                date: data.date,
                expected: data.expected,
                lines: items,
                notes: data.notes,
                send: sending,
              });
            },
            id
              ? sending
                ? 'Purchase order sent.'
                : 'Purchase order saved.'
              : sending
                ? 'Purchase order sent.'
                : 'Draft saved.',
          );
        } else
          mutate(
            (s) => {
              const i = A.createInvoice(
                s,
                {
                  customerId: data.customerId,
                  fromHoldIds:
                    initial && 'fromHoldIds' in initial ? initial.fromHoldIds : undefined,
                  allowShortDated,
                  date: data.date,
                  due: data.due,
                  lines: items,
                  discount,
                  taxRate,
                  notes: data.notes,
                },
                id,
              );
              if (issuing)
                A.issueInvoice(
                  s,
                  i.id,
                  mode === 'override' ? { reason: data.overrideReason } : undefined,
                );
              return i;
            },
            issuing ? 'Invoice issued. Stock and accounts updated.' : 'Draft saved.',
            (i) => open('invoice-detail', i.id),
          );
      }}
    >
      <div className="form-grid">
        {purchase ? (
          <>
            <SelectField
              label="Supplier"
              name="supplierId"
              disabled={purchaseOrder?.status === 'Sent'}
              defaultValue={supplierId}
              onChange={(value) => {
                setSupplierId(value);
                if (value) {
                  setExpected(A.expectedDate(state, value, invoiceDate));
                  setLines((current) =>
                    current.map((line) => {
                      const p = A.product(state, line.productId);
                      if (!p) return line;
                      const unit = line.unit || p.unit;
                      return {
                        ...line,
                        price: String(A.purchaseLinePrice(state, value, p.id, unit)),
                      };
                    }),
                  );
                }
              }}
              full
            >
              <ContactOptions type="Supplier" />
            </SelectField>
            <SelectField
              key={`receiving-${coldOnly}`}
              label="Receiving warehouse"
              name="warehouseId"
              defaultValue={
                purchaseOrder?.warehouseId ||
                (initial && 'warehouseId' in initial ? initial.warehouseId : undefined) ||
                (coldOnly ? state.warehouses.find((w) => w.storage === 'cold')?.id : 'wh_main')
              }
            >
              <WarehouseOptions
                coldOnly={coldOnly}
                includeId={
                  purchaseOrder?.warehouseId ||
                  (initial && 'warehouseId' in initial ? initial.warehouseId : undefined)
                }
              />
            </SelectField>
            <Field
              label="Order date"
              name="date"
              type="date"
              value={invoiceDate}
              onChange={(event) => {
                setInvoiceDate(event.target.value);
                if (supplierId && event.target.value) {
                  setExpected(A.expectedDate(state, supplierId, event.target.value));
                }
              }}
              max={A.today()}
              required
            />
            <Field
              label="Expected delivery"
              name="expected"
              type="date"
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
              full
              required
            />
          </>
        ) : (
          <>
            <SelectField
              label="Customer"
              name="customerId"
              disabled={salesOrder?.status === 'Confirmed'}
              defaultValue={customerId}
              onChange={(value) => {
                setLines((current) => {
                  const repriced = A.repriceLines(state, current, customerId, value);
                  return current.map((line, index) => ({
                    ...line,
                    price: String(repriced[index].price),
                  }));
                });
                setCustomerId(value);
                setDue(defaultDue(invoiceDate, value));
                setAttemptedIssue(false);
              }}
              full
            >
              <ContactOptions type="Customer" />
            </SelectField>
            {order && customerId && <Badge status={A.customerAccountStatus(state, customerId)} />}
            <Field
              label={order ? 'Order date' : 'Invoice date'}
              name="date"
              type="date"
              value={invoiceDate}
              onChange={(event) => {
                setInvoiceDate(event.target.value);
                if (event.target.value) setDue(defaultDue(event.target.value, customerId));
              }}
              max={A.today()}
              required
            />
            {order ? (
              <>
                {quotation && (
                  <Field
                    label="Valid until"
                    name="validUntil"
                    type="date"
                    defaultValue={salesOrder?.validUntil || A.shift(14, invoiceDate)}
                    min={invoiceDate}
                    required
                  />
                )}
                <Field
                  label="Requested date"
                  name="requestedDate"
                  type="date"
                  defaultValue={salesOrder?.requestedDate || A.shift(3)}
                  min={invoiceDate}
                  required
                />
                <SelectField
                  label="Fulfilment"
                  name="fulfilment"
                  defaultValue={salesOrder?.fulfilment || 'delivery'}
                >
                  <option value="delivery">Delivery</option>
                  <option value="pickup">Pickup</option>
                </SelectField>
                <Field
                  key={customerId}
                  label="Delivery address"
                  name="deliveryAddress"
                  defaultValue={
                    salesOrder?.deliveryAddress ?? A.contact(state, customerId)?.address
                  }
                  full
                />
              </>
            ) : (
              <Field
                label="Due date"
                name="due"
                type="date"
                value={due}
                onChange={(event) => setDue(event.target.value)}
                required
              />
            )}
          </>
        )}
      </div>
      <div className="form-section">{purchase || order ? 'Order' : 'Invoice'} items</div>
      {!purchase && (
        <label className="flex items-center gap-[8px] mb-[16px]">
          <input
            type="checkbox"
            checked={allowShortDated}
            onChange={(event) => setAllowShortDated(event.target.checked)}
          />
          Allow short-dated stock
        </label>
      )}
      {shortLots.length > 0 && (
        <Callout>
          Short-dated stock would be used:{' '}
          {shortLots.map((b) => `${b.code} (expires ${b.expiry})`).join(', ')}.
        </Callout>
      )}
      {coldOnly && <Callout>Cold-chain product — cold storage only</Callout>}
      {purchase &&
        state.settings.poApprovalLimit > 0 &&
        subtotal > state.settings.poApprovalLimit && (
          <Callout>
            Orders over {money(state.settings.poApprovalLimit)} need approval before they&apos;re
            sent.
          </Callout>
        )}
      {purchase &&
        supplierId &&
        (() => {
          const minOrder = A.belowMinimumOrder(state, supplierId, subtotal);
          const supplier = A.contact(state, supplierId);
          if (minOrder === null || !supplier) return null;
          return (
            <Callout>
              {supplier.name}&apos;s minimum order is {money(minOrder)}. This order is{' '}
              {money(subtotal)}.
            </Callout>
          );
        })()}
      <Field
        label="Scan barcode"
        name="scanBarcode"
        value={scan}
        onChange={(event) => setScan(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            scanBarcode();
          }
        }}
      />
      <div className="line-items">
        <div className="line-items-head">
          <span>Product</span>
          <span>Unit</span>
          <span>Qty</span>
          <span>{purchase ? 'Cost' : 'Price'} ($)</span>
          <span>Total</span>
          <span />
        </div>
        <div>
          {lines.map((line) => {
            const p = A.product(state, line.productId),
              unit = line.unit || p?.unit;
            const choices = p ? [p.unit, ...p.packs.map((pack) => pack.unit)] : [];
            const validUnit = unit && choices.includes(unit);
            if (unit && !choices.includes(unit)) choices.push(unit);
            return (
              <div className="line-item" key={line.key}>
                <select
                  className="line-product"
                  required
                  aria-label="Line product"
                  value={line.productId}
                  onChange={(event) => update(line.key, 'productId', event.target.value)}
                >
                  <option value="">Select product</option>
                  {state.products
                    .filter((p) => p.active)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {purchase
                          ? ''
                          : ` · ${A.free(state, p.id, saleOptions)} free · ${A.reserved(state, p.id)} reserved`}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Line unit"
                  value={unit || ''}
                  required
                  disabled={!p}
                  onChange={(event) => update(line.key, 'unit', event.target.value)}
                >
                  {!p && <option value="">Unit</option>}
                  {choices.map((unit) => (
                    <option key={unit}>{unit}</option>
                  ))}
                </select>
                <div>
                  <input
                    type="number"
                    required
                    min="1"
                    step="1"
                    aria-label="Line quantity"
                    value={line.qty}
                    onChange={(event) => update(line.key, 'qty', event.target.value)}
                  />
                  {p && (
                    <small className="muted text-[9px] block mt-[5px]">
                      = {A.formatQty(p, Number(line.qty) * line.factor).main}
                    </small>
                  )}
                  {p && !purchase && (
                    <small className="muted text-[9px] block">
                      {A.formatQty(p, A.free(state, p.id, saleOptions)).main} free ·{' '}
                      {A.reserved(state, p.id)} reserved
                    </small>
                  )}
                </div>
                <div>
                  <input
                    type="number"
                    required
                    min="0"
                    step="0.01"
                    aria-label={`Line unit ${purchase ? 'cost' : 'price'}`}
                    value={line.price}
                    onChange={(event) => update(line.key, 'price', event.target.value)}
                  />
                  {p && unit && validUnit && !purchase && (
                    <>
                      <PriceSource
                        productId={p.id}
                        unit={unit}
                        customerId={customerId}
                        price={Number(line.price)}
                      />
                      {A.belowCost(state, p.id, unit, Number(line.price)) && (
                        <Badge status="Below cost" />
                      )}
                    </>
                  )}
                  {p && !validUnit && !purchase && <Badge status="Manual" />}
                  {p && unit && purchase && (
                    <small className="muted text-[9px] block mt-[5px]">
                      {(() => {
                        const last = supplierId
                          ? A.lastPurchasePrice(state, supplierId, p.id, unit)
                          : null;
                        return last
                          ? `Last paid ${money(last.price)} on ${shortDate(last.date).replace('Sept', 'Sep')} (${last.reference})`
                          : 'No previous purchase — default cost';
                      })()}
                    </small>
                  )}
                </div>
                <span className="line-total">{money(Number(line.qty) * Number(line.price))}</span>
                <IconButton
                  name="trash"
                  label="Remove line"
                  onClick={() => {
                    if (lines.length === 1) {
                      toast('Keep at least one product line.', true);
                      return;
                    }
                    setLines((current) => current.filter((l) => l.key !== line.key));
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <button
        type="button"
        className="text-button"
        onClick={() => setLines((current) => [...current, newLine()])}
      >
        <Icon name="plus" />
        Add another product
      </button>
      {!purchase && (
        <div className="form-grid mt-[24px]">
          <Field
            label={order ? 'Discount (%)' : 'Discount ($)'}
            name="discount"
            type="number"
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
            min="0"
            max={order ? '100' : undefined}
            step="0.01"
          />
          <Field
            label="Tax rate (%)"
            name="taxRate"
            type="number"
            value={taxRate}
            onChange={(event) => setTaxRate(event.target.value)}
            min="0"
            max="100"
            step="0.01"
          />
        </div>
      )}
      <div className="invoice-summary">
        <div>
          <span>Subtotal</span>
          <span>{money(subtotal)}</span>
        </div>
        {!purchase && (
          <>
            <div>
              <span>Discount</span>
              <span>− {money(discountValue)}</span>
            </div>
            <div>
              <span>Tax ({taxValue}%)</span>
              <span>{money(tax)}</span>
            </div>
          </>
        )}
        <div className="invoice-total">
          <span>Total</span>
          <span>{money(subtotal - discountValue + tax)}</span>
        </div>
      </div>
      <div className="form-field full">
        <label htmlFor="f-notes">{purchase ? 'Notes' : 'Notes / payment terms'}</label>
        <textarea
          name="notes"
          id="f-notes"
          defaultValue={
            purchaseOrder?.notes ??
            salesOrder?.notes ??
            invoice?.notes ??
            (purchase
              ? ''
              : 'Thank you for your business. Please include the invoice number with your payment.')
          }
          placeholder={purchase ? 'Delivery instructions, supplier reference...' : undefined}
        />
      </div>
      {order ? (
        <>
          <Callout>
            Confirmation checks credit and reserves available stock. Any shortfall stays on
            backorder.
          </Callout>
          <div className="form-footer">
            <Button icon="close" tone="" onClick={close}>
              Cancel
            </Button>
            {quotation && (
              <button type="submit" className="btn" value="quote">
                Save quotation
              </button>
            )}
            <button type="submit" className="btn primary" value="issue">
              {salesOrder?.status === 'Confirmed' ? 'Save order' : 'Save & confirm order'}
            </button>
          </div>
          {attemptedIssue && credit && !credit.ok && (
            <CreditOverrideFields reasons={credit.reasons} label="Override and confirm" />
          )}
        </>
      ) : purchase ? (
        <div className="form-footer">
          <Button icon="close" tone="" onClick={close}>
            Cancel
          </Button>
          {purchaseOrder?.status === 'Sent' ? (
            <button type="submit" className="btn primary" value="draft">
              Save order
            </button>
          ) : (
            <>
              <button type="submit" className="btn" value="draft">
                Save draft
              </button>
              <button
                type="submit"
                className="btn primary"
                value="send"
                disabled={poApprovalReq}
                title={poApprovalReq ? 'Approval required before sending' : undefined}
              >
                Save & send
              </button>
              {poApprovalReq && (
                <small className="muted self-center">Approval required before sending</small>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <Callout>
            Save as a draft to review later. Issuing deducts sellable stock using
            first-expiry-first-out and records the sale in your accounts.
          </Callout>
          <div className="form-footer">
            <Button icon="close" tone="" onClick={close}>
              Cancel
            </Button>
            <button type="submit" className="btn" value="draft">
              Save draft
            </button>
            <button type="submit" className="btn primary" value="issue">
              <Icon name="check" />
              Issue invoice
            </button>
          </div>
          {attemptedIssue && credit && !credit.ok && (
            <CreditOverrideFields reasons={credit.reasons} />
          )}
        </>
      )}
    </WorkspaceForm>
  );
}
export function CreditOverrideFields({
  reasons,
  label = 'Override and issue',
}: {
  reasons: string[];
  label?: string;
}) {
  return (
    <>
      <Callout>
        <ul>
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </Callout>
      <Field label="Override reason" name="overrideReason" minLength={5} />
      <div className="form-footer">
        <button type="submit" className="btn primary" value="override">
          {label}
        </button>
      </div>
    </>
  );
}
export function InvoiceIssueForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const [attempted, setAttempted] = useState(false);
  const invoice = state.invoices.find((i) => i.id === id)!;
  const credit = invoice.deliveryIds.length
    ? { ok: true, reasons: [] }
    : A.creditCheck(state, invoice.customerId, invoice.total);
  return (
    <WorkspaceForm
      onSubmit={(data, mode) => {
        setAttempted(true);
        mutate(
          (s) =>
            A.issueInvoice(
              s,
              id,
              mode === 'override' ? { reason: data.overrideReason } : undefined,
            ),
          invoice.deliveryIds.length
            ? 'Invoice issued. Accounts updated.'
            : 'Invoice issued. Stock and accounts updated.',
          () => open('invoice-detail', id),
        );
      }}
    >
      <Button type="submit" icon="check">
        Issue invoice
      </Button>
      {attempted && !credit.ok && <CreditOverrideFields reasons={credit.reasons} />}
    </WorkspaceForm>
  );
}
export function ContactHoldForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const c = A.contact(state, id)!;
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.saveContact(
              s,
              { ...c, onHold: !c.onHold, holdReason: c.onHold ? '' : data.holdReason },
              id,
            ),
          c.onHold ? 'Hold released.' : 'Customer put on hold.',
          () => open('contact-detail', id),
        )
      }
    >
      {c.onHold ? (
        <Callout>{c.holdReason}</Callout>
      ) : (
        <Field label="Hold reason" name="holdReason" required />
      )}
      <FormFooter label={c.onHold ? 'Release hold' : 'Put on hold'} />
    </WorkspaceForm>
  );
}
export function CustomerGroups() {
  const { state, mutate, confirm } = useWorkspace();
  return (
    <div className="panel-body">
      <h3 className="detail-label">Customer groups</h3>
      {state.customerGroups.map((g) => (
        <WorkspaceForm
          key={g.id}
          className="mb-[20px]"
          onSubmit={(data, mode) => {
            if (mode === 'delete') {
              const count = state.prices.filter((e) => e.groupId === g.id).length;
              confirm(
                'Delete customer group?',
                `${g.name}: ${count} price entries will also be deleted.`,
                () => mutate((s) => A.deleteCustomerGroup(s, g.id), 'Customer group deleted.'),
                'Delete',
              );
              return;
            }
            mutate(
              (s) => A.saveCustomerGroup(s, { name: data[`group-${g.id}`] }, g.id),
              'Customer group saved.',
              undefined,
              true,
            );
          }}
        >
          <div className="flex items-end gap-[10px] flex-wrap">
            <Field label={`Group name (${g.name})`} name={`group-${g.id}`} defaultValue={g.name} />
            <Button type="submit" tone="">
              Rename
            </Button>
            <button type="submit" className="btn danger" value="delete">
              Delete
            </button>
          </div>
        </WorkspaceForm>
      ))}
      <WorkspaceForm
        key={state.customerGroups.length}
        onSubmit={(data) =>
          mutate(
            (s) => A.saveCustomerGroup(s, { name: data.newGroupName }),
            'Customer group added.',
            undefined,
            true,
          )
        }
      >
        <Field label="New group name" name="newGroupName" minLength={2} maxLength={40} required />
        <div className="form-footer">
          <Button type="submit" icon="plus">
            Add group
          </Button>
        </div>
      </WorkspaceForm>
    </div>
  );
}
function PriceSource({
  productId,
  unit,
  customerId,
  price,
}: {
  productId: string;
  unit: Unit;
  customerId: string;
  price: number;
}) {
  const { state } = useWorkspace();
  const resolved = A.priceFor(state, { productId, unit, customerId });
  const group = state.customerGroups.find((g) => g.id === A.contact(state, customerId)?.groupId);
  const label =
    price !== resolved.price
      ? 'Manual'
      : resolved.source === 'customer'
        ? 'Special'
        : resolved.source === 'group'
          ? `${group?.name} price`
          : resolved.source === 'group_discount'
            ? `${group?.name} −${group?.discountPercent}%`
            : 'Default';
  return <Badge status={label} />;
}
export function PaymentForm({ id }: { id: string; bill?: boolean }) {
  const { state, mutate } = useWorkspace();
  const receipt = state.receipts.find((r) => r.id === id);
  if (!receipt) return null;
  const amount = A.billBalance(receipt);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate((s) => A.payBill(s, id, data.amount, data.date), 'Supplier payment recorded.')
      }
    >
      <Callout>
        Bill {receipt.number} · Outstanding {money(amount)}
      </Callout>
      <div className="form-grid">
        <Field
          label="Payment amount ($)"
          name="amount"
          type="number"
          defaultValue={amount}
          min="0.01"
          max={amount}
          step="0.01"
          required
        />
        <Field
          label="Payment date"
          name="date"
          type="date"
          defaultValue={A.today()}
          max={A.today()}
          required
        />
      </div>
      <Callout>This reduces accounts payable and cash &amp; bank.</Callout>
      <FormFooter label="Record supplier payment" />
    </WorkspaceForm>
  );
}

interface ReceiveRowItem {
  key: string;
  purchaseLineId: string;
  qty: string;
  price: string;
  code: string;
  expiry: string;
}

export function PurchaseReceiveForm({ id }: { id: string }) {
  const { state, mutate } = useWorkspace();
  const p = state.purchases.find((item) => item.id === id);
  if (!p) return <Empty />;
  if (p.status === 'Draft') return <Callout>Send this purchase order before receiving it.</Callout>;
  if (p.status !== 'Sent') return <Callout>This order is already received or canceled.</Callout>;

  const openLines = p.lines.filter((line) => A.openQty(state, p, line) > 0);
  if (openLines.length === 0)
    return (
      <Callout>All items on this purchase order have already been received or closed.</Callout>
    );

  const [rows, setRows] = useState<ReceiveRowItem[]>(() =>
    openLines.map((line, idx) => ({
      key: `${line.id}-${idx}`,
      purchaseLineId: line.id,
      qty: String(A.openQty(state, p, line)),
      price: String(line.price),
      code: '',
      expiry: A.shift(365),
    })),
  );

  const [closeRemaining, setCloseRemaining] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  const anyOpenRemaining = p.lines.some((line) => {
    const open = A.openQty(state, p, line);
    const receivingThisTime = rows
      .filter((r) => r.purchaseLineId === line.id)
      .reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
    return open - receivingThisTime > 0;
  });

  function updateRow(key: string, updates: Partial<ReceiveRowItem>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...updates } : r)));
  }

  function splitLot(lineId: string) {
    const poLine = p!.lines.find((l) => l.id === lineId);
    setRows((current) => [
      ...current,
      {
        key: `${lineId}-${Date.now()}-${Math.random()}`,
        purchaseLineId: lineId,
        qty: '0',
        price: String(poLine?.price ?? 0),
        code: '',
        expiry: A.shift(365),
      },
    ]);
  }

  function removeLotRow(key: string) {
    setRows((current) => current.filter((r) => r.key !== key));
  }

  const activeRows = rows.filter((r) => Number(r.qty) > 0);
  const billTotal = A.round(
    A.sum(activeRows, (r) => (Number(r.qty) || 0) * (Number(r.price) || 0)),
  );
  const orderedValue = A.round(
    A.sum(activeRows, (r) => {
      const poLine = p!.lines.find((l) => l.id === r.purchaseLineId);
      return (Number(r.qty) || 0) * (poLine?.price ?? 0);
    }),
  );
  const diff = A.round(billTotal - orderedValue);
  const diffFormatted = diff >= 0 ? `+${money(diff)}` : `-${money(Math.abs(diff))}`;

  return (
    <WorkspaceForm
      onSubmit={(data) => {
        const receivedLines = rows
          .filter((r) => Number(r.qty) > 0)
          .map((r) => ({
            purchaseLineId: r.purchaseLineId,
            qty: Number(r.qty),
            price: Number(r.price),
            code: r.code,
            expiry: r.expiry,
          }));
        mutate(
          (s) =>
            A.receivePurchase(s, id, {
              date: data.date,
              reference: data.reference,
              notes: data.notes,
              lines: receivedLines,
              closeRemaining:
                closeRemaining && closeReason.trim() ? { reason: closeReason.trim() } : undefined,
            }),
          'Purchase order received. Stock and supplier bill created.',
        );
      }}
    >
      <div className="form-grid">
        <Field
          label="Receipt date"
          name="date"
          type="date"
          defaultValue={A.today()}
          max={A.today()}
          required
        />
        <Field
          label="Supplier invoice / delivery note no."
          name="reference"
          placeholder="e.g. INV-10492"
        />
        <Field label="Notes" name="notes" placeholder="Delivery notes or comments" full />
      </div>

      {openLines.map((line) => {
        const lineReceived = A.receivedQty(state, p, line.id);
        const lineOpen = A.openQty(state, p, line);
        const prod = A.product(state, line.productId);
        const lineRows = rows.filter((r) => r.purchaseLineId === line.id);

        return (
          <div key={line.id} className="mt-[16px]">
            <div className="form-section flex items-center justify-between">
              <div>
                {line.name}{' '}
                <span className="muted font-normal">
                  · {number(line.qty)} {A.unitLabel(line.unit, line.qty)} (={' '}
                  {prod
                    ? A.formatQty(prod, line.qty * line.factor).main
                    : `${line.qty * line.factor} base`}
                  ) · Ordered: {number(line.qty)} · Received: {number(lineReceived)} · Open:{' '}
                  {number(lineOpen)}
                </span>
              </div>
              <Button
                type="button"
                tone=""
                icon="plus"
                className="!py-[3px] !px-[8px] text-[12px]"
                onClick={() => splitLot(line.id)}
              >
                Split lot
              </Button>
            </div>

            {lineRows.map((row) => {
              const rowCost = Number(row.price) || 0;
              const costDiff = A.round(rowCost - line.price);
              const costDiffLabel =
                costDiff !== 0
                  ? costDiff > 0
                    ? `+$${costDiff.toFixed(2)} vs PO`
                    : `-$${Math.abs(costDiff).toFixed(2)} vs PO`
                  : undefined;

              return (
                <div
                  key={row.key}
                  className="p-[10px] bg-[rgba(0,0,0,0.02)] rounded-[6px] mb-[8px]"
                >
                  <div className="form-grid">
                    <Field
                      label={`Receive now (${A.unitLabel(line.unit)})`}
                      name={`qty-${row.key}`}
                      type="number"
                      value={row.qty}
                      min="0"
                      step="1"
                      onChange={(e) => updateRow(row.key, { qty: e.target.value })}
                      required
                    />
                    <Field
                      label={`Actual cost per ${line.unit} ($)`}
                      name={`cost-${row.key}`}
                      type="number"
                      value={row.price}
                      min="0"
                      step="0.01"
                      hint={costDiffLabel}
                      onChange={(e) => updateRow(row.key, { price: e.target.value })}
                      required
                    />
                    <Field
                      label="Actual batch / lot number"
                      name={`code-${row.key}`}
                      value={row.code}
                      onChange={(e) => updateRow(row.key, { code: e.target.value })}
                      required={Number(row.qty) > 0}
                    />
                    <Field
                      label="Actual expiry date"
                      name={`expiry-${row.key}`}
                      type="date"
                      min={A.shift(1)}
                      value={row.expiry}
                      onChange={(e) => updateRow(row.key, { expiry: e.target.value })}
                      required={Number(row.qty) > 0}
                    />
                  </div>
                  {lineRows.length > 1 && (
                    <div className="flex justify-end mt-[4px]">
                      <Button
                        type="button"
                        tone="danger"
                        icon="trash"
                        className="!py-[2px] !px-[6px] text-[11px]"
                        onClick={() => removeLotRow(row.key)}
                      >
                        Remove lot row
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {anyOpenRemaining && (
        <div className="form-field full mt-[12px]">
          <label className="checkbox-label flex items-center gap-[8px] cursor-pointer">
            <input
              type="checkbox"
              checked={closeRemaining}
              onChange={(e) => setCloseRemaining(e.target.checked)}
            />
            <span>Close the rest of this order</span>
          </label>
          {closeRemaining && (
            <Field
              label="Reason for closing remainder"
              name="closeReason"
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="e.g. Supplier out of stock until next quarter"
              required
              full
            />
          )}
        </div>
      )}

      <Callout>
        Bill total {money(billTotal)} · ordered value of these items {money(orderedValue)} ·
        difference {diffFormatted}
      </Callout>

      <FormFooter label="Receive" />
    </WorkspaceForm>
  );
}

export function CloseRemainderForm({ id }: { id: string }) {
  const { state, mutate } = useWorkspace();
  const p = state.purchases.find((item) => item.id === id);
  if (!p) return <Empty />;
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) => A.closeRemaining(s, id, data.reason),
          'Purchase order remainder closed.',
          undefined,
          true,
        )
      }
    >
      <Callout>
        Closing the remainder marks this purchase order as Received and cancels any outstanding
        quantities.
      </Callout>
      <Field
        label="Reason for closing remainder"
        name="reason"
        placeholder="e.g. Supplier out of stock until next quarter"
        required
        full
      />
      <FormFooter label="Close remainder" />
    </WorkspaceForm>
  );
}
export function ExpenseForm() {
  const { mutate } = useWorkspace();
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.addExpense(s, {
              description: data.description,
              amount: data.amount,
              date: data.date,
              category: data.category,
              reference: data.reference,
            }),
          'Expense recorded.',
        )
      }
    >
      <div className="form-grid">
        <Field label="Description" name="description" full required />
        <Field label="Amount ($)" name="amount" type="number" min="0.01" step="0.01" required />
        <Field
          label="Expense date"
          name="date"
          type="date"
          defaultValue={A.today()}
          max={A.today()}
          required
        />
        <SelectField label="Category" name="category">
          {[
            'Rent & utilities',
            'Logistics',
            'Payroll',
            'Office supplies',
            'Maintenance',
            'Other',
          ].map((category) => (
            <option key={category}>{category}</option>
          ))}
        </SelectField>
        <Field label="Reference (optional)" name="reference" />
      </div>
      <FormFooter label="Record expense" />
    </WorkspaceForm>
  );
}
export function ContactForm({ id }: { id?: string }) {
  const { state, mutate } = useWorkspace();
  const c = id ? A.contact(state, id) : undefined;
  const [type, setType] = useState<ContactType>(c?.type || 'Customer');
  const [onHold, setOnHold] = useState(c?.onHold || false);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.saveContact(
              s,
              {
                type: data.type as ContactType,
                name: data.name,
                person: data.person,
                phone: data.phone,
                email: data.email,
                address: data.address,
                minShelfLifeDays: data.minShelfLifeDays || null,
                groupId: data.groupId || '',
                paymentTermsDays: data.paymentTermsDays,
                creditLimit: data.creditLimit || null,
                billing: data.billing as 'per_delivery' | 'monthly',
                onHold,
                holdReason: data.holdReason || '',
                leadTimeDays: data.leadTimeDays,
                minOrderValue: data.minOrderValue || null,
              },
              id,
            ),
          'Contact saved.',
        )
      }
    >
      <div className="form-grid">
        <SelectField
          label="Contact type"
          name="type"
          defaultValue={type}
          onChange={(value) => setType(value as ContactType)}
          full
        >
          <option>Customer</option>
          <option>Supplier</option>
        </SelectField>
        <Field label="Business / contact name" name="name" defaultValue={c?.name} full required />
        <Field label="Contact person" name="person" defaultValue={c?.person} />
        <Field label="Phone number" name="phone" type="tel" defaultValue={c?.phone} />
        <Field label="Email address" name="email" type="email" defaultValue={c?.email} full />
        <Field label="Address" name="address" defaultValue={c?.address} full />
        {type === 'Customer' && (
          <Field
            label="Minimum shelf life (days)"
            name="minShelfLifeDays"
            type="number"
            defaultValue={c?.minShelfLifeDays ?? ''}
            placeholder={`Company default (${state.settings.minShelfLifeDays})`}
            min="0"
            max="1095"
            step="1"
            full
          />
        )}
      </div>
      {type === 'Customer' && (
        <>
          <div className="form-section">Account</div>
          <div className="form-grid">
            <SelectField
              label="Customer group"
              name="groupId"
              defaultValue={c?.groupId || ''}
              required={false}
            >
              <option value="">No group</option>
              {state.customerGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </SelectField>
            <Field
              label="Payment terms (days)"
              name="paymentTermsDays"
              type="number"
              defaultValue={c?.paymentTermsDays ?? state.settings.defaultPaymentTermsDays}
              min="0"
              max="365"
              step="1"
              required
            />
            <Field
              label="Credit limit ($, empty = no limit)"
              name="creditLimit"
              type="number"
              defaultValue={c?.creditLimit ?? ''}
              min="0"
              step="0.01"
            />
            <SelectField
              label="Billing habit"
              name="billing"
              defaultValue={c?.billing || 'per_delivery'}
            >
              <option value="per_delivery">Invoice each delivery</option>
              <option value="monthly">Monthly billing</option>
            </SelectField>
            <label className="flex items-center gap-[8px]">
              <input
                type="checkbox"
                checked={onHold}
                onChange={(event) => setOnHold(event.target.checked)}
              />
              On hold
            </label>
            {onHold && (
              <Field label="Hold reason" name="holdReason" defaultValue={c?.holdReason} required />
            )}
          </div>
        </>
      )}
      {type === 'Supplier' && (
        <>
          <div className="form-section">Supplier account</div>
          <div className="form-grid">
            <Field
              label="Payment terms (days)"
              name="paymentTermsDays"
              type="number"
              defaultValue={c?.paymentTermsDays ?? state.settings.defaultPaymentTermsDays}
              min="0"
              max="365"
              step="1"
              required
            />
            <Field
              label="Lead time (days)"
              name="leadTimeDays"
              type="number"
              defaultValue={c?.leadTimeDays ?? 0}
              min="0"
              max="365"
              step="1"
              required
            />
            <Field
              label="Minimum order ($, optional)"
              name="minOrderValue"
              type="number"
              defaultValue={c?.minOrderValue ?? ''}
              min="0"
              step="0.01"
            />
          </div>
        </>
      )}
      <FormFooter label="Save contact" />
    </WorkspaceForm>
  );
}

export function InvoiceDocument({ invoice, order }: { invoice?: Invoice; order?: SalesOrder }) {
  const { state } = useWorkspace();
  const i = order
    ? { ...order, ...A.orderTotals(order), due: order.requestedDate, paid: 0, credited: 0 }
    : invoice!;
  const c = A.contact(state, i.customerId),
    s = state.settings;
  return (
    <div className="invoice-document" id="print-document">
      <div className="invoice-document-header">
        <div>
          <div className="invoice-brand">
            aster<span className="text-[#adc298] text-[15px] ml-[3px]">✳</span>
            <small>{s.company}</small>
          </div>
          <p className="mt-[12px]">{s.address}</p>
          <p>{s.email}</p>
          <p>{s.phone}</p>
        </div>
        <div>
          <h3>
            {order ? (order.status === 'Quote' ? 'QUOTATION' : 'ORDER CONFIRMATION') : 'INVOICE'}
          </h3>
          <p>{i.number}</p>
          <p>{new Date(`${i.date}T12:00:00`).toLocaleDateString('en-GB')}</p>
          <div className="mt-[9px]">
            <span className="badge">
              {order
                ? order.status === 'Quote'
                  ? A.quoteStatus(order)
                  : order.status
                : A.invoiceStatus(invoice!)}
            </span>
          </div>
        </div>
      </div>
      <div className="invoice-document-parties">
        <div>
          <span>{order ? 'Customer' : 'Bill to'}</span>
          <strong>{c?.name}</strong>
          {c?.address}
          <br />
          {c?.email}
        </div>
        <div className="text-right">
          <span>{order ? 'Requested date' : 'Payment due'}</span>
          <strong>{new Date(`${i.due}T12:00:00`).toLocaleDateString('en-GB')}</strong>Currency: USD
          {order && (
            <p>{order.fulfilment === 'pickup' ? 'Pickup' : `Delivery: ${order.deliveryAddress}`}</p>
          )}
          {order?.validUntil && <p>Valid until: {order.validUntil}</p>}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty</th>
              <th>Unit price</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {i.lines.map((line, index) => (
              <tr key={index}>
                <td className="whitespace-normal">
                  <strong>{line.name}</strong>
                  <div className="text-[9px] mt-[5px]">{line.sku}</div>
                </td>
                <td>
                  {number(line.qty - (order?.lines[index].cancelledQty || 0))}{' '}
                  {A.unitLabel(line.unit, line.qty)}
                </td>
                <td>{money(line.price)}</td>
                <td>{money((line.qty - (order?.lines[index].cancelledQty || 0)) * line.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="invoice-summary">
        <div>
          <span>Subtotal</span>
          <span>{money(i.subtotal)}</span>
        </div>
        <div>
          <span>Discount</span>
          <span>− {money(i.discount)}</span>
        </div>
        <div>
          <span>Tax ({i.taxRate}%)</span>
          <span>{money(i.taxAmount)}</span>
        </div>
        <div className="invoice-total">
          <span>Total</span>
          <span>{money(i.total)}</span>
        </div>
        {!order && (
          <>
            <div>
              <span>Amount paid</span>
              <span>{money(i.paid)}</span>
            </div>
            <div>
              <span>Credited</span>
              <span>
                {'\u2212'}
                {money(i.credited)}
              </span>
            </div>
            <div>
              <span>{i.status === 'Draft' ? 'On issue' : 'Balance due'}</span>
              <strong>{money(i.status === 'Draft' ? i.total : A.invoiceBalance(invoice!))}</strong>
            </div>
          </>
        )}
      </div>
      {i.notes && <div className="invoice-note">{i.notes}</div>}
    </div>
  );
}
