import { PaymentsTable } from '../components/payments';
import { CreditNotesTable } from '../components/creditNotes';
import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { compactMoney, date, initials, money, number } from '../lib/format';
import { exportAdjustments, exportData, exportStockLedger, type ExportType } from '../lib/exports';
import {
  Badge,
  Button,
  DataTable,
  Callout,
  Field,
  Filter,
  Heading,
  Icon,
  IconButton,
  Metric,
  PanelHeader,
  ProductArt,
  ProductBadges,
  SearchInput,
  StockQuantity,
  useStockAlerts,
  type IconName,
} from '../components/ui';
import type { Invoice, Movement, MoveType } from '../types';
import { CountFreezeBanner, StockCountsTable } from '../components/stockCounts';
import { ControlledRegister } from '../components/ControlledRegister';
import { RecallsTable } from '../components/recalls';
import { ReorderSuggestions } from '../components/reorder';
import { CustomerGroups } from '../components/forms';
import { ToInvoice } from '../components/invoicing';

export function ExportButton({
  type,
  label = 'Export',
  small = true,
}: {
  type: ExportType;
  label?: string;
  small?: boolean;
}) {
  const { state, period, toast } = useWorkspace();
  return (
    <Button
      icon="download"
      tone={small ? 'small' : ''}
      onClick={() => {
        exportData(state, type, period);
        toast('Report downloaded.');
      }}
    >
      {label}
    </Button>
  );
}
export function InvoiceRow({ invoice: i }: { invoice: Invoice }) {
  const { state, open } = useWorkspace();
  return (
    <tr>
      <td>
        <button className="table-link mono" onClick={() => open('invoice-detail', i.id)}>
          {i.number}
        </button>
      </td>
      <td>
        <strong>{A.contact(state, i.customerId)?.name}</strong>
      </td>
      <td>{date(i.date)}</td>
      <td className="num">
        <strong>{money(i.total)}</strong>
      </td>
      <td>
        <Badge status={A.invoiceStatus(i)} />
        {i.status === 'Draft' &&
          state.reservations.some(
            (r) => r.source === 'invoice' && r.sourceId === i.id && r.status === 'Active',
          ) && <Badge status="Reserved" />}
      </td>
      <td>{date(i.due)}</td>
      <td>
        <div className="table-actions">
          <IconButton
            name="eye"
            label={`View ${i.number}`}
            onClick={() => open('invoice-detail', i.id)}
          />
        </div>
      </td>
    </tr>
  );
}
export function InventoryPage() {
  const { state, open, warehouseFilter, setWarehouseFilter } = useWorkspace();
  const [q, setQ] = useState(''),
    [category, setCategory] = useState(''),
    [status, setStatus] = useState(''),
    [asOf, setAsOf] = useState(''),
    [storage, setStorage] = useState(''),
    [rx, setRx] = useState(''),
    [controlled, setControlled] = useState(''),
    [missing, setMissing] = useState(''),
    [showInactive, setShowInactive] = useState(false);
  const { low } = useStockAlerts();
  const products = state.products.filter(
    (p) =>
      `${p.name} ${p.nameKm} ${p.sku} ${p.barcode} ${p.generic}`
        .toLowerCase()
        .includes(q.toLowerCase()) &&
      (showInactive || p.active) &&
      (!storage || p.storage === storage) &&
      (!rx || p.rx === (rx === 'yes')) &&
      (!controlled || p.controlled === (controlled === 'yes')) &&
      (!missing || A.missingRegistration(p) === (missing === 'yes')) &&
      (!category || p.category === category) &&
      (!status || A.productStatus(state, p) === status) &&
      (!warehouseFilter ||
        (asOf
          ? A.movesFor(state, { productId: p.id, warehouseId: warehouseFilter, to: asOf }).length >
            0
          : A.onHand(state, p.id, warehouseFilter) > 0)),
  );
  return (
    <>
      <Heading
        title="Inventory"
        subtitle="Every product. Every unit. One clear catalog."
        actions={
          <>
            <Button tone="" icon="receive" onClick={() => open('receive')}>
              Receive stock
            </Button>
            <Button onClick={() => open('product-form')}>Add product</Button>
          </>
        }
      />
      <CountFreezeBanner warehouseId={warehouseFilter} />
      <div className="metrics">
        <Metric
          label="Catalog products"
          value={number(state.products.filter((p) => p.active).length)}
          icon="box"
          foot="Active products in your catalog"
        />
        <Metric
          label="Units on hand"
          value={number(A.sum(state.batches, (b) => b.qty))}
          icon="layers"
          foot="Includes quarantined & expired stock"
        />
        <Metric
          label="Inventory value"
          value={compactMoney(A.inventoryValue(state))}
          icon="wallet"
          foot="At actual batch purchase cost"
        />
        <Metric
          label="Replenishment needed"
          value={number(low.length)}
          icon="alert"
          foot="Below minimum stock levels"
        />
      </div>
      <section className="panel">
        <div className="toolbar">
          <div className="toolbar-left">
            <SearchInput value={q} onChange={setQ} placeholder="Search products, SKU, barcode..." />
            <Filter
              label="Product category"
              value={category}
              onChange={setCategory}
              items={A.categories}
              placeholder="All categories"
            />
            <Filter
              label="Stock status"
              value={status}
              onChange={setStatus}
              items={['In stock', 'Low stock', 'Out of stock']}
            />
            <Filter
              label="Warehouse"
              value={warehouseFilter}
              onChange={setWarehouseFilter}
              items={state.warehouses}
              placeholder="All warehouses"
            />
            <Field
              label="As of date"
              name="asOf"
              type="date"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
            />
          </div>
          <ExportButton type="products" />
        </div>
        <div className="toolbar">
          <div className="toolbar-left">
            <Filter
              label="Product storage"
              value={storage}
              onChange={setStorage}
              items={[
                { id: 'ambient', name: 'Ambient' },
                { id: 'cold', name: 'Cold chain' },
              ]}
              placeholder="All storage"
            />
            <Filter
              label="Rx"
              value={rx}
              onChange={setRx}
              items={[
                { id: 'yes', name: 'Rx only' },
                { id: 'no', name: 'Non-prescription' },
              ]}
              placeholder="All Rx flags"
            />
            <Filter
              label="Controlled"
              value={controlled}
              onChange={setControlled}
              items={[
                { id: 'yes', name: 'Controlled' },
                { id: 'no', name: 'Not controlled' },
              ]}
              placeholder="All controlled flags"
            />
            <Filter
              label="Missing registration"
              value={missing}
              onChange={setMissing}
              items={[
                { id: 'yes', name: 'Missing registration' },
                { id: 'no', name: 'Registration complete / exempt' },
              ]}
              placeholder="All registrations"
            />
            <Field
              label="Show inactive"
              name="showInactive"
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
          </div>
        </div>
        {asOf && <Callout>Showing stock as of {date(asOf)}</Callout>}
        {(asOf || warehouseFilter) && (
          <Callout>Reserved and Free show current quantities across all warehouses.</Callout>
        )}
        <DataTable
          items={products}
          filterKey={`${q}|${category}|${status}|${warehouseFilter}|${asOf}|${storage}|${rx}|${controlled}|${missing}|${showInactive}`}
          columns={[
            'Product',
            'Category',
            'Available',
            'Reserved',
            'Free',
            'Cost / sell',
            'Status',
            '',
          ]}
          row={(p) => {
            const qty = asOf
              ? A.stockAt(state, { date: asOf, productId: p.id, warehouseId: warehouseFilter })
              : A.available(state, p.id, warehouseFilter);
            return (
              <tr key={p.id}>
                <td>
                  <button
                    className="table-product text-left p-0"
                    onClick={() => open('product-detail', p.id)}
                  >
                    <ProductArt product={p} />
                    <div>
                      <strong>{p.name}</strong>
                      <ProductBadges product={p} />
                      <small>
                        {p.sku} · {p.unit}
                      </small>
                    </div>
                  </button>
                </td>
                <td>{p.category}</td>
                <td>
                  <div className="table-status-stock">
                    <strong>
                      <StockQuantity product={p} qty={qty} />
                    </strong>
                    <span className={`stock-track ${qty <= p.reorder ? 'low' : ''}`}>
                      <i
                        style={{
                          width: `${Math.min(100, (qty / Math.max(1, p.reorder * 5)) * 100)}%`,
                        }}
                      />
                    </span>
                  </div>
                </td>
                <td>
                  <StockQuantity product={p} qty={A.reserved(state, p.id)} />
                </td>
                <td>
                  <StockQuantity product={p} qty={A.free(state, p.id)} />
                </td>
                <td>
                  <span className="muted">{money(p.cost)}</span> / <strong>{money(p.price)}</strong>
                </td>
                <td>
                  <Badge status={A.productStatus(state, p)} />
                  {A.free(state, p.id) < 0 && <Badge status="Over-reserved" />}
                </td>
                <td>
                  <div className="table-actions">
                    <IconButton
                      name="receive"
                      label={`Receive ${p.name}`}
                      disabled={!p.active}
                      onClick={() => open('receive', p.id)}
                    />
                    <IconButton
                      name="edit"
                      label={`Edit ${p.name}`}
                      onClick={() => open('product-form', p.id)}
                    />
                  </div>
                </td>
              </tr>
            );
          }}
        />
      </section>
    </>
  );
}
export function BatchesPage() {
  const { state, open } = useWorkspace();
  const [tab, setTab] = useState<'batches' | 'controlled' | 'recalls'>('batches');
  const [q, setQ] = useState(''),
    [status, setStatus] = useState(''),
    [warehouse, setWarehouse] = useState('');
  const items = state.batches
    .filter(
      (b) =>
        b.qty > 0 &&
        `${A.product(state, b.productId)?.name} ${b.code}`
          .toLowerCase()
          .includes(q.toLowerCase()) &&
        (!status ||
          (status === 'Quarantined'
            ? b.quarantined
            : status === 'Short-dated'
              ? A.shortDated(state, b)
              : A.batchStatus(state, b, state.settings.expiryWindow) === status)) &&
        (!warehouse || b.warehouseId === warehouse),
    )
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  return (
    <>
      <Heading
        title="Batches & expiry"
        subtitle="Trace every lot, protect every shelf."
        actions={
          <>
            <Button tone="" icon="transfer" onClick={() => open('transfer')}>
              Transfer stock
            </Button>
            <Button icon="receive" onClick={() => open('receive')}>
              Receive stock
            </Button>
          </>
        }
      />
      <div className="metrics">
        <Metric
          label="Active batches"
          value={number(state.batches.filter((b) => b.qty > 0).length)}
          icon="layers"
          foot="Across all warehouse locations"
        />
        <Metric
          label={`Expiring within ${state.settings.expiryWindow} days`}
          value={number(
            state.batches.filter(
              (b) =>
                b.qty > 0 &&
                A.daysLeft(b.expiry) > 0 &&
                A.daysLeft(b.expiry) <= state.settings.expiryWindow,
            ).length,
          )}
          icon="clock"
          foot="Prioritize these batches for sale"
        />
        <Metric
          label="Expired stock value"
          value={money(
            A.sum(
              state.batches.filter((b) => A.daysLeft(b.expiry) <= 0),
              (b) => b.qty * b.cost,
            ),
          )}
          icon="alert"
          foot="Automatically excluded from sales"
        />
        <Metric
          label="Quarantined batches"
          value={number(state.batches.filter((b) => b.qty > 0 && b.quarantined).length)}
          icon="shield"
          foot="Held until a quality review"
        />
      </div>
      <div className="tab-bar">
        <button
          className={tab === 'batches' ? 'active' : ''}
          aria-pressed={tab === 'batches'}
          onClick={() => setTab('batches')}
        >
          Batches &amp; expiry
        </button>
        <button
          className={tab === 'recalls' ? 'active' : ''}
          aria-pressed={tab === 'recalls'}
          onClick={() => setTab('recalls')}
        >
          Recalls
        </button>
        <button
          className={tab === 'controlled' ? 'active' : ''}
          aria-pressed={tab === 'controlled'}
          onClick={() => setTab('controlled')}
        >
          Controlled substances register
        </button>
      </div>
      {tab === 'controlled' && <ControlledRegister />}
      {tab === 'recalls' && <RecallsTable />}
      {tab === 'batches' && (
        <>
          <section className="panel">
            <div className="toolbar">
              <div className="toolbar-left">
                <SearchInput
                  value={q}
                  onChange={setQ}
                  placeholder="Search product or batch number..."
                />
                <Filter
                  label="Batch status"
                  value={status}
                  onChange={setStatus}
                  items={[
                    'Active',
                    'Expiring soon',
                    'Expired',
                    'Quarantined',
                    'Recalled',
                    'Short-dated',
                  ]}
                />
                <Filter
                  label="Warehouse"
                  value={warehouse}
                  onChange={setWarehouse}
                  items={state.warehouses}
                  placeholder="All warehouses"
                />
              </div>
              <ExportButton type="batches" />
            </div>
            <DataTable
              items={items}
              filterKey={`${q}|${status}|${warehouse}`}
              columns={['Product / batch', 'Warehouse', 'Quantity', 'Expiry date', 'Status', '']}
              row={(b) => {
                const p = A.product(state, b.productId);
                return (
                  <tr key={b.id}>
                    <td>
                      <button
                        className="table-product text-left p-0"
                        onClick={() => open('batch-detail', b.id)}
                      >
                        <ProductArt product={p} />
                        <div>
                          <strong>{p?.name}</strong>
                          <small>{b.code}</small>
                        </div>
                      </button>
                    </td>
                    <td>{A.warehouse(state, b.warehouseId)?.name}</td>
                    <td>
                      <strong>
                        <StockQuantity product={p} qty={b.qty} />
                      </strong>
                    </td>
                    <td>
                      <strong>{date(b.expiry)}</strong>
                      <div className="text-[8px] mt-[5px] text-[#a1ab97]">
                        {A.daysLeft(b.expiry) > 0
                          ? `${A.daysLeft(b.expiry)} days remaining`
                          : `${Math.abs(A.daysLeft(b.expiry))} days past expiry`}
                      </div>
                    </td>
                    <td>
                      <Badge status={A.batchStatus(state, b, state.settings.expiryWindow)} />
                      {state.stockMoves.some((m) => m.batchId === b.id && m.type === 'return') && (
                        <Badge status="Returned" />
                      )}
                      {A.shortDated(state, b) && <Badge status="Short-dated" />}
                    </td>
                    <td>
                      <IconButton
                        name="eye"
                        label={`View batch ${b.code}`}
                        onClick={() => open('batch-detail', b.id)}
                      />
                    </td>
                  </tr>
                );
              }}
            />
          </section>
          <div className="info-callout">
            <Icon name="shield" /> Invoices use first-expiry-first-out (FEFO). Expired and
            quarantined batches are automatically blocked from sale.
          </div>
        </>
      )}
    </>
  );
}
export function MovementTable({ items }: { items: Movement[] }) {
  return (
    <div className="table-wrap mt-[18px]">
      <table>
        <thead>
          <tr>
            <th>Activity</th>
            <th>Details</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {items.length ? (
            items.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.title}</strong>
                </td>
                <td className="whitespace-normal min-w-[200px] leading-[1.6]">{m.description}</td>
                <td>{date(m.date)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3}>No activity yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
export function WarehousesPage() {
  const {
    state,
    open,
    navigate,
    toast,
    ledgerProductFilter,
    setLedgerProductFilter,
    warehouseTab,
    setWarehouseTab,
  } = useWorkspace();
  const [q, setQ] = useState(''),
    [warehouse, setWarehouse] = useState(''),
    [type, setType] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [reason, setReason] = useState('');
  const filters = {
    productId: ledgerProductFilter,
    warehouseId: warehouse,
    type: type as MoveType | undefined,
    from,
    to,
  };
  const items = A.movesFor(state, filters)
    .filter((m) => {
      const p = A.product(state, m.productId);
      return `${p?.name} ${p?.sku} ${p?.barcode} ${p?.generic}`
        .toLowerCase()
        .includes(q.toLowerCase());
    })
    .reverse();
  const adjustments = state.adjustments.filter(
    (a) =>
      (!warehouse || a.warehouseId === warehouse) &&
      (!reason || a.reason === reason) &&
      (!from || a.date >= from) &&
      (!to || a.date <= to),
  );
  return (
    <>
      <Heading
        title="Warehouses"
        subtitle="Know what is where. Keep your stock moving."
        actions={
          <>
            <Button icon="clock" tone="" onClick={() => open('activity')}>
              Activity log
            </Button>
            <Button icon="transfer" onClick={() => open('transfer')}>
              Transfer stock
            </Button>
          </>
        }
      />
      <div className="wide-grid">
        {state.warehouses.map((w) => {
          const batches = state.batches.filter((b) => b.warehouseId === w.id && b.qty > 0),
            qty = A.sum(batches, (b) => b.qty),
            occupancy = Math.min(100, (qty / w.capacity) * 100);
          return (
            <section className="panel warehouse-card" key={w.id}>
              <div className="warehouse-top">
                <span className="warehouse-art">
                  <Icon name="warehouse" />
                </span>
                <Badge status="Active" />
              </div>
              <h2>{w.name}</h2>
              <p>{w.address}</p>
              <CountFreezeBanner warehouseId={w.id} />
              <div className="warehouse-stats">
                <div>
                  <strong>{number(qty)}</strong>
                  <small>units on hand</small>
                </div>
                <div>
                  <strong>{new Set(batches.map((b) => b.productId)).size}</strong>
                  <small>products</small>
                </div>
              </div>
              <div className="warehouse-occupancy">
                <span>Storage occupancy</span>
                <span>
                  {Math.round(occupancy)}% of {number(w.capacity)}
                </span>
              </div>
              <div className="progress-track">
                <span style={{ width: `${occupancy}%` }} />
              </div>
              <div className="mt-[16px] text-[9px] text-[#94a292]">
                {w.code} · {w.temperature} · {compactMoney(A.inventoryValue(state, w.id))}
              </div>
              <Button tone="wide" icon="box" onClick={() => navigate('inventory', w.id)}>
                View inventory
              </Button>
            </section>
          );
        })}
      </div>
      <div className="tab-bar">
        {(['ledger', 'adjustments', 'counts'] as const).map((tab) => (
          <button
            key={tab}
            className={warehouseTab === tab ? 'active' : ''}
            aria-pressed={warehouseTab === tab}
            onClick={() => setWarehouseTab(tab)}
          >
            {tab === 'ledger'
              ? 'Stock ledger'
              : tab === 'adjustments'
                ? 'Adjustments'
                : 'Stock counts'}
          </button>
        ))}
      </div>
      {warehouseTab === 'counts' && <StockCountsTable />}
      {warehouseTab === 'ledger' && (
        <section className="panel">
          <PanelHeader
            title="Stock ledger"
            subtitle="A clear trail between receiving, selling, and transferring."
          />
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput
                value={q}
                onChange={setQ}
                placeholder="Search ledger products, SKU, barcode..."
              />
              {ledgerProductFilter && (
                <Button tone="small" icon="close" onClick={() => setLedgerProductFilter('')}>
                  Clear product: {A.product(state, ledgerProductFilter)?.name}
                </Button>
              )}
              <Filter
                label="Ledger warehouse"
                value={warehouse}
                onChange={setWarehouse}
                items={state.warehouses}
                placeholder="All warehouses"
              />
              <Filter
                label="Movement type"
                value={type}
                onChange={setType}
                items={[
                  'opening',
                  'receipt',
                  'sale',
                  'return',
                  'transfer_out',
                  'transfer_in',
                  'adjustment',
                ]}
                placeholder="All types"
              />
              <Field
                label="Date from"
                name="ledgerFrom"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
              <Field
                label="Date to"
                name="ledgerTo"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <Button
              tone="small"
              icon="download"
              onClick={() => {
                exportStockLedger(state, items);
                toast('Report downloaded.');
              }}
            >
              Export CSV
            </Button>
          </div>
          <DataTable
            items={items}
            filterKey={`${q}|${ledgerProductFilter}|${warehouse}|${type}|${from}|${to}`}
            columns={['Date', 'Reference', 'Product', 'Lot', 'Warehouse', 'Type', 'Qty', 'User']}
            row={(m) => (
              <tr key={m.id}>
                <td>{date(m.date)}</td>
                <td>{m.reference}</td>
                <td>
                  <button
                    className="table-link"
                    onClick={() => open('product-detail', m.productId)}
                  >
                    {A.product(state, m.productId)?.name}
                  </button>
                </td>
                <td>
                  <button className="table-link" onClick={() => open('batch-detail', m.batchId)}>
                    {m.lotCode}
                  </button>
                </td>
                <td>{A.warehouse(state, m.warehouseId)?.name}</td>
                <td>
                  <Badge status={m.type} />
                </td>
                <td className={m.qty > 0 ? 'text-[#10765b]' : 'text-[#b74a43]'}>
                  {m.qty > 0 ? '+' : '−'}
                  {number(Math.abs(m.qty))}
                </td>
                <td>{m.user}</td>
              </tr>
            )}
          />
        </section>
      )}
      {warehouseTab === 'adjustments' && (
        <section className="panel">
          <PanelHeader
            title="Adjustments"
            subtitle="Quantity corrections with their reasons and value changes."
          />
          <div className="toolbar">
            <div className="toolbar-left">
              <Filter
                label="Adjustment warehouse"
                value={warehouse}
                onChange={setWarehouse}
                items={state.warehouses}
                placeholder="All warehouses"
              />
              <Filter
                label="Adjustment reason"
                value={reason}
                onChange={setReason}
                items={Object.entries(A.adjustmentReasons).map(([id, name]) => ({ id, name }))}
                placeholder="All reasons"
              />
              <Field
                label="Date from"
                name="adjustmentFrom"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
              <Field
                label="Date to"
                name="adjustmentTo"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <Button
              tone="small"
              icon="download"
              onClick={() => {
                exportAdjustments(state, adjustments);
                toast('Report downloaded.');
              }}
            >
              Export CSV
            </Button>
          </div>
          <DataTable
            items={adjustments}
            filterKey={`${warehouse}|${reason}|${from}|${to}`}
            columns={[
              'Number',
              'Date',
              'Product',
              'Lot',
              'Warehouse',
              'Qty',
              'Value',
              'Reason',
              'User',
            ]}
            row={(a) => (
              <tr key={a.id}>
                <td className="mono">{a.number}</td>
                <td>{date(a.date)}</td>
                <td>
                  <button
                    className="table-link"
                    onClick={() => open('product-detail', a.productId)}
                  >
                    {A.product(state, a.productId)?.name}
                  </button>
                </td>
                <td>
                  <button className="table-link" onClick={() => open('batch-detail', a.batchId)}>
                    {a.lotCode}
                  </button>
                </td>
                <td>{A.warehouse(state, a.warehouseId)?.name}</td>
                <td className={a.qty > 0 ? 'text-[#10765b]' : 'text-[#b74a43]'}>
                  {a.qty > 0 ? '+' : '−'}
                  {number(Math.abs(a.qty))}
                </td>
                <td
                  className={a.value > 0 ? 'text-[#10765b]' : a.value < 0 ? 'text-[#b74a43]' : ''}
                >
                  {a.value > 0 ? '+' : a.value < 0 ? '−' : ''}
                  {money(Math.abs(a.value))}
                </td>
                <td>{A.adjustmentReasons[a.reason]}</td>
                <td>{a.user}</td>
              </tr>
            )}
          />
        </section>
      )}
    </>
  );
}
export function PurchasingPage() {
  const { state, open } = useWorkspace();
  const [tab, setTab] = useState('orders');
  const [q, setQ] = useState(''),
    [status, setStatus] = useState('');
  const items = state.purchases.filter(
    (p) =>
      `${p.number} ${A.contact(state, p.supplierId)?.name}`
        .toLowerCase()
        .includes(q.toLowerCase()) &&
      (!status || p.status === status),
  );
  const ordered = state.purchases.filter((p) => p.status === 'Ordered');
  return (
    <>
      <Heading
        title="Purchasing"
        subtitle="Replenish with confidence, from order to receipt."
        actions={<Button onClick={() => open('purchase-form')}>New purchase order</Button>}
      />
      <div className="metrics three-metrics">
        <Metric
          label="Open purchase orders"
          value={number(ordered.length)}
          icon="cart"
          foot="Awaiting delivery"
        />
        <Metric
          label="On order"
          value={compactMoney(A.sum(ordered, (p) => p.total))}
          icon="box"
          foot="Value of incoming inventory"
        />
        <Metric
          label="Supplier bills due"
          value={compactMoney(
            A.sum(
              [...state.purchases.filter((p) => p.status === 'Received'), ...state.receipts],
              (p) => p.total - p.paid,
            ),
          )}
          icon="wallet"
          foot="Outstanding accounts payable"
        />
      </div>
      <div className="tab-bar">
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>
          Purchase orders
        </button>
        <button className={tab === 'reorder' ? 'active' : ''} onClick={() => setTab('reorder')}>
          Reorder suggestions
        </button>
      </div>
      {tab === 'reorder' ? (
        <ReorderSuggestions />
      ) : (
        <section className="panel">
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput
                value={q}
                onChange={setQ}
                placeholder="Search purchase order or supplier..."
              />
              <Filter
                label="Order status"
                value={status}
                onChange={setStatus}
                items={['Ordered', 'Received', 'Canceled']}
              />
            </div>
            <ExportButton type="purchases" />
          </div>
          <DataTable
            items={items}
            filterKey={`${q}|${status}`}
            columns={['Purchase order', 'Supplier', 'Warehouse', 'Expected', 'Total', 'Status', '']}
            row={(p) => (
              <tr key={p.id}>
                <td>
                  <button className="table-link mono" onClick={() => open('purchase-detail', p.id)}>
                    {p.number}
                  </button>
                </td>
                <td>
                  <strong>{A.contact(state, p.supplierId)?.name}</strong>
                </td>
                <td>{A.warehouse(state, p.warehouseId)?.name}</td>
                <td>{date(p.expected)}</td>
                <td className="num">
                  <strong>{money(p.total)}</strong>
                </td>
                <td>
                  <Badge status={p.status} />
                </td>
                <td>
                  {p.status === 'Ordered' ? (
                    <Button
                      icon="receive"
                      tone="small"
                      onClick={() => open('purchase-receive', p.id)}
                    >
                      Receive
                    </Button>
                  ) : (
                    <IconButton
                      name="eye"
                      label="View order"
                      onClick={() => open('purchase-detail', p.id)}
                    />
                  )}
                </td>
              </tr>
            )}
          />
        </section>
      )}
    </>
  );
}
export function InvoicesPage() {
  const { state, period, open, invoiceTab, setInvoiceTab } = useWorkspace();
  const [q, setQ] = useState(''),
    [status, setStatus] = useState('');
  const items = [...state.invoices]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter(
      (i) =>
        `${i.number} ${A.contact(state, i.customerId)?.name}`
          .toLowerCase()
          .includes(q.toLowerCase()) &&
        (!status || A.invoiceStatus(i) === status),
    );
  const overdue = state.invoices.filter((i) => A.invoiceStatus(i) === 'Overdue');
  return (
    <>
      <Heading
        title="Invoices"
        subtitle="Simple billing. A complete paper trail."
        actions={
          <>
            <Button tone="" onClick={() => open('invoice-payment')}>
              Record payment
            </Button>
            <Button onClick={() => open('invoice-form')}>New invoice</Button>
          </>
        }
      />
      <div className="metrics">
        <Metric
          label="Invoiced this period"
          value={compactMoney(
            A.sum(
              state.invoices.filter(
                (i) =>
                  i.status !== 'Draft' && i.date >= A.shift(-period + 1) && i.date <= A.today(),
              ),
              (i) => i.total,
            ),
          )}
          icon="invoice"
          foot={`Last ${period} days`}
        />
        <Metric
          label="Outstanding balance"
          value={compactMoney(A.sum(state.invoices, A.invoiceBalance))}
          icon="wallet"
          foot="Unpaid and partially paid invoices"
        />
        <Metric
          label="Overdue amount"
          value={compactMoney(A.sum(overdue, A.invoiceBalance))}
          icon="clock"
          foot={`${overdue.length} invoices past their due date`}
        />
        <Metric
          label="Draft invoices"
          value={number(state.invoices.filter((i) => i.status === 'Draft').length)}
          icon="file"
          foot="Ready for review and issue"
        />
      </div>
      <div className="tab-bar" role="tablist" aria-label="Invoices">
        <button
          role="tab"
          aria-selected={invoiceTab === 'invoices'}
          className={invoiceTab === 'invoices' ? 'active' : ''}
          onClick={() => setInvoiceTab('invoices')}
        >
          Invoices
        </button>
        <button
          role="tab"
          aria-selected={invoiceTab === 'to-invoice'}
          className={invoiceTab === 'to-invoice' ? 'active' : ''}
          onClick={() => setInvoiceTab('to-invoice')}
        >
          To invoice
        </button>
        <button
          role="tab"
          aria-selected={invoiceTab === 'credit-notes'}
          className={invoiceTab === 'credit-notes' ? 'active' : ''}
          onClick={() => setInvoiceTab('credit-notes')}
        >
          Credit notes
        </button>
        <button
          role="tab"
          aria-selected={invoiceTab === 'payments'}
          className={invoiceTab === 'payments' ? 'active' : ''}
          onClick={() => setInvoiceTab('payments')}
        >
          Payments
        </button>
      </div>
      {invoiceTab === 'payments' ? (
        <PaymentsTable />
      ) : invoiceTab === 'credit-notes' ? (
        <CreditNotesTable />
      ) : invoiceTab === 'to-invoice' ? (
        <ToInvoice />
      ) : (
        <section className="panel">
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput value={q} onChange={setQ} placeholder="Search invoice or customer..." />
              <Filter
                label="Invoice status"
                value={status}
                onChange={setStatus}
                items={['Draft', 'Paid', 'Credited', 'Partial', 'Unpaid', 'Overdue']}
              />
            </div>
            <ExportButton type="invoices" />
          </div>
          <DataTable
            items={items}
            filterKey={`${q}|${status}`}
            columns={['Invoice', 'Customer', 'Issue date', 'Amount', 'Status', 'Due date', '']}
            row={(i) => <InvoiceRow key={i.id} invoice={i} />}
          />
        </section>
      )}
    </>
  );
}
export function ContactsPage() {
  const { state, open } = useWorkspace();
  const [tab, setTab] = useState('contacts');
  const [showOverdue, setShowOverdue] = useState(false);
  const [overdueSort, setOverdueSort] = useState<'none' | 'asc' | 'desc'>('none');
  const overdue = (id: string) => A.overdueAmount(state, id, state.settings.overdueGraceDays);
  const [q, setQ] = useState(''),
    [type, setType] = useState('');
  const items = state.contacts.filter(
    (c) =>
      `${c.name} ${c.email} ${c.phone}`.toLowerCase().includes(q.toLowerCase()) &&
      (!type || c.type === type),
  );
  if (showOverdue && overdueSort !== 'none')
    items.sort((a, b) => (overdue(a.id) - overdue(b.id)) * (overdueSort === 'asc' ? 1 : -1));
  return (
    <>
      <Heading
        title="Contacts"
        subtitle="The people on both sides of your business."
        actions={<Button onClick={() => open('contact-form')}>Add contact</Button>}
      />
      <div className="metrics three-metrics">
        <Metric
          label="Customers"
          value={state.contacts.filter((c) => c.type === 'Customer').length}
          icon="users"
          foot="Active customer accounts"
        />
        <Metric
          label="Suppliers"
          value={state.contacts.filter((c) => c.type === 'Supplier').length}
          icon="warehouse"
          foot="Your distribution network"
        />
        <Metric
          label="Customer balances"
          value={compactMoney(A.sum(state.invoices, A.invoiceBalance))}
          icon="invoice"
          foot="Outstanding accounts receivable"
        />
      </div>
      <div className="tabs">
        <button className={tab === 'contacts' ? 'active' : ''} onClick={() => setTab('contacts')}>
          Contacts
        </button>
        <button className={tab === 'groups' ? 'active' : ''} onClick={() => setTab('groups')}>
          Customer groups
        </button>
      </div>
      {tab === 'groups' ? (
        <section className="panel">
          <CustomerGroups />
        </section>
      ) : (
        <section className="panel">
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput value={q} onChange={setQ} placeholder="Search name, email or phone..." />
              <Filter
                label="Contact type"
                value={type}
                onChange={setType}
                items={['Customer', 'Supplier']}
                placeholder="All contacts"
              />
            </div>
            <label>
              <input
                type="checkbox"
                checked={showOverdue}
                onChange={(e) => setShowOverdue(e.target.checked)}
              />{' '}
              Show overdue
            </label>
            <ExportButton type="contacts" />
          </div>
          <DataTable
            items={items}
            filterKey={`${q}|${type}|${showOverdue}|${overdueSort}`}
            columns={[
              'Contact',
              'Type',
              'Group',
              'Email / phone',
              'Location',
              'Balance',
              ...(showOverdue
                ? [
                    <button
                      aria-label="Sort by overdue amount"
                      onClick={() => setOverdueSort(overdueSort === 'desc' ? 'asc' : 'desc')}
                    >
                      Overdue {overdueSort === 'desc' ? '↓' : overdueSort === 'asc' ? '↑' : '↕'}
                    </button>,
                  ]
                : []),
              '',
            ]}
            row={(c) => {
              const balance =
                c.type === 'Customer'
                  ? A.sum(
                      state.invoices.filter((i) => i.customerId === c.id),
                      A.invoiceBalance,
                    )
                  : A.sum(
                      [
                        ...state.purchases.filter((p) => p.status === 'Received'),
                        ...state.receipts,
                      ].filter((p) => p.supplierId === c.id),
                      (p) => p.total - p.paid,
                    );
              return (
                <tr key={c.id}>
                  <td>
                    <button
                      className="table-product text-left p-0"
                      onClick={() => open('contact-detail', c.id)}
                    >
                      <span className="contact-initials">{initials(c.name)}</span>
                      <div>
                        <strong>{c.name}</strong>
                        <small>{c.person}</small>
                      </div>
                    </button>
                  </td>
                  <td>
                    <Badge status={c.type} />
                    {c.type === 'Customer' && A.customerAccountStatus(state, c.id) !== 'OK' && (
                      <Badge status={A.customerAccountStatus(state, c.id)} />
                    )}
                  </td>
                  <td>{state.customerGroups.find((g) => g.id === c.groupId)?.name || '—'}</td>
                  <td>
                    {c.email}
                    <div className="muted text-[9px] mt-[5px]">{c.phone}</div>
                  </td>
                  <td>{c.address}</td>
                  <td>
                    <strong>{money(balance)}</strong>
                  </td>
                  {showOverdue && (
                    <td className="num">{c.type === 'Customer' ? money(overdue(c.id)) : '?'}</td>
                  )}
                  <td>
                    <IconButton
                      name="edit"
                      label={`Edit ${c.name}`}
                      onClick={() => open('contact-form', c.id)}
                    />
                  </td>
                </tr>
              );
            }}
          />
        </section>
      )}
    </>
  );
}
export const movementIcons: Record<string, IconName> = {
  receive: 'receive',
  sale: 'invoice',
  payment: 'wallet',
  transfer: 'transfer',
  adjust: 'alert',
  product: 'box',
  order: 'cart',
  expense: 'wallet',
};
