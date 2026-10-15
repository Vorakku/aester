import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { errorMessage, money, number } from '../lib/format';
import {
  Button,
  Badge,
  Callout,
  ContactOptions,
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
  productId: string;
  qty: string;
  price: string;
  unit?: Unit;
  factor: number;
}
function newLine(line?: LineInput & { factor?: number }): EditableLine {
  return {
    key: A.uid('line'),
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
  initial,
}: {
  id?: string;
  purchase?: boolean;
  initial?: PurchaseInitial | InvoiceInitial;
}) {
  const { state, mutate, open, close, toast } = useWorkspace();
  const invoice = id ? state.invoices.find((i) => i.id === id) : undefined;
  const [lines, setLines] = useState<EditableLine[]>(
    () =>
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
            : {}),
        }),
      ) || [newLine()],
  );
  const [discount, setDiscount] = useState(String(invoice?.discount || 0)),
    [taxRate, setTaxRate] = useState(String(invoice?.taxRate ?? state.settings.taxRate));
  const [scan, setScan] = useState('');
  const [customerId, setCustomerId] = useState(
    invoice?.customerId || (initial && 'customerId' in initial ? initial.customerId : ''),
  );
  const [allowShortDated, setAllowShortDated] = useState(invoice?.allowShortDated || false);
  const [invoiceDate, setInvoiceDate] = useState(invoice?.date || A.today());
  const defaultDue = (date: string, customer: string) =>
    A.shift(
      A.contact(state, customer)?.paymentTermsDays ?? state.settings.defaultPaymentTermsDays,
      date,
    );
  const [due, setDue] = useState(invoice?.due || defaultDue(invoiceDate, customerId));
  const [attemptedIssue, setAttemptedIssue] = useState(false);
  const saleOptions = { customerId, allowShortDated, exceptSourceId: invoice?.id };
  const shortLots = purchase ? [] : A.shortDatedBatches(state, lines, saleOptions);
  const coldOnly = purchase && lines.some((l) => A.product(state, l.productId)?.storage === 'cold');
  const subtotal = A.sum(lines, (l) => Number(l.qty) * Number(l.price));
  const discountValue = purchase ? 0 : Number(discount) || 0,
    taxValue = purchase ? 0 : Number(taxRate) || 0;
  const tax = A.round((Math.max(0, subtotal - discountValue) * taxValue) / 100);
  const saleTotal = Math.max(0, subtotal - discountValue + tax);
  const credit =
    !purchase && customerId && Number.isFinite(saleTotal) && saleTotal <= 100000000
      ? A.creditCheck(state, customerId, saleTotal)
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
                  ? A.unitPrice(p, unit, true)
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
          ? A.unitPrice(p, unit, true)
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
        if (purchase)
          mutate(
            (s) =>
              A.createPurchase(s, {
                supplierId: data.supplierId,
                warehouseId: data.warehouseId,
                date: data.date,
                expected: data.expected,
                lines: items,
                notes: data.notes,
              }),
            'Purchase order created.',
          );
        else
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
              defaultValue={initial && 'supplierId' in initial ? initial.supplierId : undefined}
              full
            >
              <ContactOptions type="Supplier" />
            </SelectField>
            <SelectField
              key={`receiving-${coldOnly}`}
              label="Receiving warehouse"
              name="warehouseId"
              defaultValue={
                (initial && 'warehouseId' in initial ? initial.warehouseId : undefined) ||
                (coldOnly ? state.warehouses.find((w) => w.storage === 'cold')?.id : 'wh_main')
              }
            >
              <WarehouseOptions
                coldOnly={coldOnly}
                includeId={initial && 'warehouseId' in initial ? initial.warehouseId : undefined}
              />
            </SelectField>
            <Field
              label="Order date"
              name="date"
              type="date"
              defaultValue={A.today()}
              max={A.today()}
              required
            />
            <Field
              label="Expected delivery"
              name="expected"
              type="date"
              defaultValue={A.shift(5)}
              full
              required
            />
          </>
        ) : (
          <>
            <SelectField
              label="Customer"
              name="customerId"
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
            <Field
              label="Invoice date"
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
            <Field
              label="Due date"
              name="due"
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              required
            />
          </>
        )}
      </div>
      <div className="form-section">{purchase ? 'Order' : 'Invoice'} items</div>
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
            label="Discount ($)"
            name="discount"
            type="number"
            value={discount}
            onChange={(event) => setDiscount(event.target.value)}
            min="0"
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
            invoice?.notes ||
            (purchase
              ? ''
              : 'Thank you for your business. Please include the invoice number with your payment.')
          }
          placeholder={purchase ? 'Delivery instructions, supplier reference...' : undefined}
        />
      </div>
      {purchase ? (
        <FormFooter label="Create purchase order" />
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
function CreditOverrideFields({ reasons }: { reasons: string[] }) {
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
          Override and issue
        </button>
      </div>
    </>
  );
}
export function InvoiceIssueForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const [attempted, setAttempted] = useState(false);
  const invoice = state.invoices.find((i) => i.id === id)!;
  const credit = A.creditCheck(state, invoice.customerId, invoice.total);
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
          'Invoice issued. Stock and accounts updated.',
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
export function PaymentForm({ id, bill = false }: { id: string; bill?: boolean }) {
  const { state, mutate } = useWorkspace();
  const item = bill
    ? [...state.purchases, ...state.receipts].find((i) => i.id === id)
    : state.invoices.find((i) => i.id === id);
  if (!item) return null;
  const amount = A.round(item.total - item.paid);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            bill
              ? A.payBill(s, id, data.amount, data.date)
              : A.payInvoice(s, id, data.amount, data.method, data.date),
          bill ? 'Supplier payment recorded.' : 'Payment recorded. Accounts updated.',
        )
      }
    >
      <Callout>Outstanding {money(amount)}</Callout>
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
        {!bill && (
          <SelectField label="Payment method" name="method" full>
            {['Bank transfer', 'Cash', 'Card', 'Other'].map((method) => (
              <option key={method}>{method}</option>
            ))}
          </SelectField>
        )}
      </div>
      <Callout>
        {bill
          ? 'This reduces accounts payable and cash & bank.'
          : 'This reduces accounts receivable and increases cash & bank. Partial payments are supported.'}
      </Callout>
      <FormFooter label={bill ? 'Record supplier payment' : 'Record payment'} />
    </WorkspaceForm>
  );
}
export function PurchaseReceiveForm({ id }: { id: string }) {
  const { state, mutate } = useWorkspace();
  const p = state.purchases.find((p) => p.id === id);
  if (!p || p.status !== 'Ordered')
    return <Callout>This order is already received or canceled.</Callout>;
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.receivePurchase(
              s,
              id,
              p.lines.map((_, index) => ({
                code: data[`batch-${index}`],
                expiry: data[`expiry-${index}`],
              })),
              data.date,
            ),
          'Purchase order received. Stock and payables updated.',
        )
      }
    >
      <Field
        label="Receipt date"
        name="date"
        type="date"
        defaultValue={A.today()}
        max={A.today()}
        required
      />
      {p.lines.map((line, index) => (
        <div key={index}>
          <div className="form-section">
            {line.name}{' '}
            <span className="muted font-normal">
              · {number(line.qty)} {A.unitLabel(line.unit, line.qty)} (={' '}
              {A.formatQty(A.product(state, line.productId)!, line.qty * line.factor).main})
            </span>
          </div>
          <div className="form-grid">
            <Field label="Actual batch / lot number" name={`batch-${index}`} required />
            <Field
              label="Actual expiry date"
              name={`expiry-${index}`}
              type="date"
              min={A.shift(1)}
              required
            />
          </div>
        </div>
      ))}
      <Callout>
        Receives all ordered units into {A.warehouse(state, p.warehouseId)?.name}. The supplier bill
        is {money(p.total)}; any difference from the rounded base-unit stock value is posted as
        Purchase rounding.
      </Callout>
      <FormFooter label="Receive all items" />
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
      <FormFooter label="Save contact" />
    </WorkspaceForm>
  );
}

export function InvoiceDocument({ invoice: i }: { invoice: Invoice }) {
  const { state } = useWorkspace();
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
          <h3>INVOICE</h3>
          <p>{i.number}</p>
          <p>{new Date(`${i.date}T12:00:00`).toLocaleDateString('en-GB')}</p>
          <div className="mt-[9px]">
            <span className="badge">{A.invoiceStatus(i)}</span>
          </div>
        </div>
      </div>
      <div className="invoice-document-parties">
        <div>
          <span>Bill to</span>
          <strong>{c?.name}</strong>
          {c?.address}
          <br />
          {c?.email}
        </div>
        <div className="text-right">
          <span>Payment due</span>
          <strong>{new Date(`${i.due}T12:00:00`).toLocaleDateString('en-GB')}</strong>Currency: USD
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
                  {number(line.qty)} {A.unitLabel(line.unit, line.qty)}
                </td>
                <td>{money(line.price)}</td>
                <td>{money(line.qty * line.price)}</td>
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
        <div>
          <span>Amount paid</span>
          <span>{money(i.paid)}</span>
        </div>
        <div>
          <span>{i.status === 'Draft' ? 'On issue' : 'Balance due'}</span>
          <strong>{money(i.total - i.paid)}</strong>
        </div>
      </div>
      {i.notes && <div className="invoice-note">{i.notes}</div>}
    </div>
  );
}
