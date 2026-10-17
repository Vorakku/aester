import { useState } from 'react';
import { CustomerCreditActions, PaymentsTable, InvoicePayments } from './payments';
import { CreditNotesTable } from './creditNotes';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, shortDate, initials, money, number, errorMessage } from '../lib/format';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Empty,
  Field,
  ProductArt,
  ProductBadges,
  StockQuantity,
  Summary,
} from './ui';
import { InvoiceDocument, InvoiceIssueForm, WorkspaceForm } from './forms';
import type { Purchase } from '../types';
import { ReorderLevels } from './reorder';
import { ReservationsList } from './reservations';
import { SpecialPrices } from '../pages/Pricing';
import { CustomerOrders } from './orders';
import { InvoiceHeaderForm } from './invoicing';

export function ProductDetail({ id }: { id: string }) {
  const { state, open, navigate } = useWorkspace();
  const p = A.product(state, id);
  if (!p) return <Empty />;
  const batches = state.batches
    .filter((b) => b.productId === id && b.qty > 0)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  return (
    <>
      <div className="detail-hero">
        <ProductArt product={p} />
        <div>
          <h3>{p.name}</h3>
          {p.nameKm && <p lang="km">{p.nameKm}</p>}
          <p>
            {p.generic} · {p.category}
          </p>
        </div>
      </div>
      <Badge status={A.productStatus(state, p)} />
      {A.free(state, id) < 0 && <Badge status="Over-reserved" />}
      <ProductBadges product={p} />
      <div className="detail-stats">
        <div>
          <small>Available</small>
          <strong>
            <StockQuantity product={p} qty={A.available(state, id)} />
          </strong>
        </div>
        <div>
          <small>Reserved</small>
          <strong>
            <StockQuantity product={p} qty={A.reserved(state, id)} />
          </strong>
        </div>
        <div>
          <small>Free</small>
          <strong>
            <StockQuantity product={p} qty={A.free(state, id)} />
          </strong>
        </div>
        <div>
          <small>Physical stock</small>
          <strong>
            <StockQuantity product={p} qty={A.onHand(state, id)} />
          </strong>
        </div>
        <div>
          <small>Selling price</small>
          <strong>{money(p.price)}</strong>
        </div>
        <div>
          <small>Reorder threshold</small>
          <strong>{p.reorder}</strong>
        </div>
      </div>
      <Summary
        items={[
          ['SKU', p.sku],
          ['Barcode', p.barcode || '—'],
          ['Registration no.', p.registrationNo || '—'],
          ['Manufacturer', p.manufacturer || '—'],
          ['Dosage form', p.dosageForm],
          ['Strength', p.strength || '—'],
          ['Prescription only', p.rx ? 'Yes' : 'No'],
          ['Controlled substance', p.controlled ? 'Yes' : 'No'],
          ['Storage', p.storage === 'cold' ? 'Cold chain (2–8°C)' : 'Ambient (15–25°C)'],
          ['Active', p.active ? 'Yes' : 'No'],
          ['Preferred supplier', A.contact(state, p.supplierId)?.name || '—'],
          ['Stock value at batch cost', money(A.sum(batches, (b) => b.qty * b.cost))],
        ]}
      />
      <ReorderLevels product={p} />
      <ReservationsList productId={id} />
      <h3 className="detail-label">Batches on hand</h3>
      <button className="table-link" onClick={() => navigate('warehouses', undefined, id)}>
        View stock history
      </button>
      {batches.map((b) => (
        <button
          className="detail-batch w-full text-left"
          key={b.id}
          onClick={() => open('batch-detail', b.id)}
        >
          <div>
            <strong>{b.code}</strong>
            <small>
              {A.warehouse(state, b.warehouseId)?.name} · Exp {date(b.expiry)}
            </small>
          </div>
          <div className="text-right">
            <strong>
              <StockQuantity product={p} qty={b.qty} />
            </strong>
            <br />
            <Badge status={A.batchStatus(state, b, state.settings.expiryWindow)} />
          </div>
        </button>
      ))}
      {!batches.length && (
        <Empty title="No stock yet" description="Receive a batch to add inventory." />
      )}
      <div className="detail-actions">
        <Button tone="" disabled={!p.active} onClick={() => open('hold-stock', id)}>
          Hold stock
        </Button>
        <Button tone="" icon="edit" onClick={() => open('product-form', id)}>
          Edit product
        </Button>
        <Button icon="receive" disabled={!p.active} onClick={() => open('receive', id)}>
          Receive stock
        </Button>
      </div>
    </>
  );
}
export function BatchDetail({ id }: { id: string }) {
  const { state, open, mutate, toast } = useWorkspace();
  const b = state.batches.find((b) => b.id === id);
  if (!b) return <Empty />;
  const p = A.product(state, b.productId);
  let balance = 0;
  const history = A.movesFor(state, { batchId: id })
    .map((move) => {
      balance += move.qty;
      return { ...move, balance };
    })
    .reverse();
  return (
    <>
      <div className="detail-hero">
        <ProductArt product={p} />
        <div>
          <h3>{p?.name}</h3>
          <p>Lot {b.code}</p>
        </div>
      </div>
      <Badge status={A.batchStatus(state, b, state.settings.expiryWindow)} />
      {A.shortDated(state, b) && <Badge status="Short-dated" />}
      {A.isRecalled(state, b) && (
        <div className="form-error" role="alert">
          This lot is under recall.{' '}
          <button
            className="text-button"
            onClick={() =>
              open(
                'recall-detail',
                state.recalls.find(
                  (r) =>
                    r.status === 'Open' &&
                    r.productId === b.productId &&
                    r.lotCode.toLowerCase() === b.code.toLowerCase(),
                )!.id,
              )
            }
          >
            View recall
          </button>
        </div>
      )}
      <div className="detail-stats">
        <div>
          <small>Quantity on hand</small>
          <strong>
            <StockQuantity product={p} qty={b.qty} />
          </strong>
        </div>
        <div>
          <small>Batch value</small>
          <strong>{money(b.qty * b.cost)}</strong>
        </div>
      </div>
      <Summary
        items={[
          ['Warehouse', A.warehouse(state, b.warehouseId)?.name],
          ['Received', date(b.received)],
          ['Expiry date', date(b.expiry)],
          ['Actual unit cost', money(b.cost)],
          ['Quality status', b.quarantined ? 'Quarantined' : 'Released'],
        ]}
      />
      <Callout>
        {A.daysLeft(b.expiry) <= 0
          ? 'This batch has expired and cannot be used for invoices.'
          : b.quarantined
            ? 'This batch is held for quality review and cannot be sold.'
            : 'Invoices allocate this batch by earliest expiry first.'}
      </Callout>
      <h3 className="detail-label">Movement history</h3>
      <DataTable
        items={history}
        filterKey={id}
        columns={['Date', 'Type', 'Reference', 'Qty', 'Balance after', 'User']}
        row={(m) => (
          <tr key={m.id}>
            <td>{date(m.date)}</td>
            <td>
              <Badge status={m.type} />
            </td>
            <td>{m.reference}</td>
            <td className={m.qty > 0 ? 'text-[#10765b]' : 'text-[#b74a43]'}>
              {m.qty > 0 ? '+' : '−'}
              {number(Math.abs(m.qty))}
            </td>
            <td>{number(m.balance)}</td>
            <td>{m.user}</td>
          </tr>
        )}
      />
      <div className="detail-actions">
        <Button tone="" icon="transfer" onClick={() => open('transfer', id)}>
          Transfer
        </Button>
        <Button
          tone="danger"
          disabled={A.isRecalled(state, b)}
          onClick={() => open('recall-form', id)}
        >
          Start recall
        </Button>
        <Button
          tone=""
          icon="shield"
          onClick={() => {
            try {
              mutate(
                (s) => A.setQuarantine(s, id, !b.quarantined),
                b.quarantined ? 'Batch released.' : 'Batch quarantined.',
              );
            } catch (error) {
              toast(errorMessage(error), true);
            }
          }}
        >
          {b.quarantined ? 'Release batch' : 'Quarantine'}
        </Button>
        <Button tone="" icon="edit" onClick={() => open('adjust-stock', id)}>
          Adjust stock
        </Button>
        <Button
          tone="danger"
          icon="trash"
          disabled={b.qty === 0}
          onClick={() => open('write-off-all', id)}
        >
          Write off all
        </Button>
      </div>
    </>
  );
}
export function InvoiceDetail({ id }: { id: string }) {
  const { state, open, mutate, confirm, toast } = useWorkspace();
  const i = state.invoices.find((i) => i.id === id);
  if (!i) return <Empty />;
  const reserved = state.reservations.some(
    (r) => r.source === 'invoice' && r.sourceId === id && r.status === 'Active',
  );
  return (
    <>
      <InvoiceDocument invoice={i} />
      {i.status === 'Issued' && (
        <>
          <div className="detail-actions">
            <Button onClick={() => open('credit-note-form', id)}>Credit note / return</Button>
          </div>
          <h3 className="detail-label">Credit notes</h3>
          <CreditNotesTable invoiceId={id} />
        </>
      )}
      {i.orderId && (
        <p>
          Order:{' '}
          <button className="table-link" onClick={() => open('order-detail', i.orderId)}>
            {state.orders.find((o) => o.id === i.orderId)?.number}
          </button>
        </p>
      )}
      {i.status === 'Draft' && i.deliveryIds.length > 0 && (
        <>
          <Callout>Lines come from delivery notes and can't be edited.</Callout>
          <InvoiceHeaderForm id={id} />
        </>
      )}
      {i.status === 'Draft' && reserved && <Badge status="Reserved" />}
      <div className="detail-actions">
        <Button tone="" icon="print" onClick={() => window.print()}>
          Print / PDF
        </Button>
        {i.status === 'Draft' ? (
          <>
            {!i.deliveryIds.length && (
              <Button
                tone=""
                onClick={() => {
                  try {
                    mutate(
                      (s) =>
                        reserved ? A.releaseInvoiceReservations(s, id) : A.reserveInvoice(s, id),
                      reserved ? 'Reservation released.' : 'Stock reserved.',
                      undefined,
                      true,
                    );
                  } catch (error) {
                    toast(errorMessage(error), true);
                  }
                }}
              >
                {reserved ? 'Release reservation' : 'Reserve stock'}
              </Button>
            )}
            {!i.deliveryIds.length && (
              <Button tone="" icon="edit" onClick={() => open('invoice-form', id)}>
                Edit draft
              </Button>
            )}
            <InvoiceIssueForm id={id} />
          </>
        ) : A.invoiceBalance(i) > 0 ? (
          <Button icon="wallet" onClick={() => open('invoice-payment', id)}>
            Record payment
          </Button>
        ) : (
          <Badge status={A.invoiceStatus(i)} />
        )}
      </div>
      {i.status === 'Draft' && (
        <div className="form-footer">
          <Button
            tone="danger"
            icon="trash"
            onClick={() =>
              confirm(
                'Delete this draft?',
                `Draft ${i.number} will be removed. Stock and accounts are unaffected.`,
                () => mutate((s) => A.deleteDraft(s, id), 'Draft deleted.'),
                'Delete draft',
              )
            }
          >
            Delete draft
          </Button>
        </div>
      )}
      {i.creditOverride && (
        <Callout>
          Credit override by {i.creditOverride.by}: {i.creditOverride.reason}
          <ul>
            {i.creditOverride.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Callout>
      )}
      {i.status === 'Issued' && (
        <>
          <InvoicePayments id={id} />
          {A.invoiceBalance(i) > 0 && (
            <CustomerCreditActions customerId={i.customerId} invoiceId={id} />
          )}
        </>
      )}
      {A.deliveriesOf(state, i).map((d) => (
        <section key={d.id}>
          <h3 className="detail-label">
            <button className="table-link" onClick={() => open('delivery-detail', d.id)}>
              {d.number}
            </button>{' '}
            · <Badge status={d.status} />
          </h3>
          {d.lines.map((l) => (
            <div key={l.id}>
              <strong>{l.name}</strong>
              {l.picks.map((p, index) => (
                <div className="detail-batch" key={index}>
                  <div>
                    <strong>{p.lotCode}</strong>
                    <small>
                      {date(p.expiry)} · {A.warehouse(state, p.warehouseId)?.name}
                    </small>
                  </div>
                  <strong>{p.qty} units</strong>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
export function PurchaseOrderDocument({ order }: { order: Purchase }) {
  const { state } = useWorkspace();
  const s = state.settings;
  const supplier = A.contact(state, order.supplierId);
  const warehouse = A.warehouse(state, order.warehouseId);
  return (
    <div className="invoice-document mt-[24px]" id="print-document">
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
          <h3>PURCHASE ORDER</h3>
          <p>{order.number}</p>
          <p>{date(order.date)}</p>
          <div className="mt-[9px]">
            <span className="badge">{order.status}</span>
          </div>
        </div>
      </div>
      <div className="invoice-document-parties">
        <div>
          <span>Supplier</span>
          <strong>{supplier?.name}</strong>
          {supplier?.address && (
            <>
              {supplier.address}
              <br />
            </>
          )}
          {supplier?.phone && (
            <>
              {supplier.phone}
              <br />
            </>
          )}
          {supplier?.email && <>{supplier.email}</>}
        </div>
        <div className="text-right">
          <span>Deliver to</span>
          <strong>{warehouse?.name}</strong>
          {warehouse?.address && <p>{warehouse.address}</p>}
          <p className="mt-[6px]">
            <span>Expected delivery: </span>
            <strong>{date(order.expected)}</strong>
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>SKU</th>
              <th>Qty</th>
              <th>Unit cost</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, index) => (
              <tr key={index}>
                <td className="whitespace-normal">
                  <strong>{line.name}</strong>
                </td>
                <td className="mono text-[9px]">{line.sku}</td>
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
        <div className="invoice-total">
          <span>Order total</span>
          <span>{money(order.total)}</span>
        </div>
      </div>
      {order.notes && <div className="invoice-note">{order.notes}</div>}
      {order.approval && (
        <div className="invoice-note mt-[12px]">
          Approved by {order.approval.by} on {date(order.approval.at)}
          {order.approval.note ? ` · ${order.approval.note}` : ''}
        </div>
      )}
    </div>
  );
}

export function PurchaseDetail({ id }: { id: string }) {
  const { state, open, mutate, confirm } = useWorkspace();
  const [approving, setApproving] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const p = state.purchases.find((p) => p.id === id);
  if (!p) return <Empty />;
  const canApprove =
    p.status === 'Draft' &&
    state.settings.poApprovalLimit > 0 &&
    p.total > state.settings.poApprovalLimit;

  const receipts = state.receipts.filter((r) => r.purchaseId === p.id);
  const totalBilled = A.round(A.sum(receipts, (r) => r.total));
  const orderedReceivedValue = A.round(
    A.sum(
      receipts.flatMap((r) => r.lines),
      (l) => l.qty * (l.orderedPrice ?? l.price),
    ),
  );

  return (
    <>
      <div className="flex items-center gap-[8px]">
        <Badge status={A.purchaseStatus(state, p)} />
        {A.approvalRequired(state, p) && <Badge status="Needs approval" />}
      </div>
      {p.approval && (
        <Callout>
          Approved by {p.approval.by} on {shortDate(p.approval.at)}
          {p.approval.note ? ` · ${p.approval.note}` : ''}
        </Callout>
      )}
      {p.closeReason && <Callout>Closed short: {p.closeReason}</Callout>}
      {p.cancelReason && <Callout>Cancellation: {p.cancelReason}</Callout>}
      <div className="my-[18px]">
        <Summary
          items={[
            ['Supplier', A.contact(state, p.supplierId)?.name],
            ['Warehouse', A.warehouse(state, p.warehouseId)?.name],
            ['Order date', date(p.date)],
            ['Expected delivery', date(p.expected)],
            ...(p.sentAt ? [['Sent', date(p.sentAt)] as [string, string]] : []),
            ...(p.received ? [['Received', date(p.received)] as [string, string]] : []),
          ]}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Ordered</th>
              <th>Received</th>
              <th>Closed</th>
              <th>Open</th>
              <th>Cost</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, index) => {
              const rec = A.receivedQty(state, p, l.id);
              const closed = l.closedQty || 0;
              const open = A.openQty(state, p, l);
              return (
                <tr key={l.id || index}>
                  <td>
                    <strong>{l.name}</strong>
                  </td>
                  <td>
                    {number(l.qty)} {A.unitLabel(l.unit, l.qty)}
                  </td>
                  <td>{number(rec)}</td>
                  <td>{number(closed)}</td>
                  <td>{number(open)}</td>
                  <td>{money(l.price)}</td>
                  <td>{money(l.qty * l.price)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-[18px]">
        <Summary
          items={[
            ['Order total', money(p.total)],
            ...(receipts.length > 0
              ? [
                  ['Billed total', money(totalBilled)] as [string, string],
                  ['Outstanding payables', money(A.sum(receipts, A.billBalance))] as [
                    string,
                    string,
                  ],
                ]
              : []),
          ]}
        />
      </div>
      {receipts.length > 0 && totalBilled !== orderedReceivedValue && (
        <Callout>
          Billed {money(totalBilled)} vs ordered {money(orderedReceivedValue)}
        </Callout>
      )}
      {receipts.length > 0 && (
        <div className="mt-[18px]">
          <h4 className="detail-label">Receipts</h4>
          <div className="table-wrap mt-[8px]">
            <table>
              <thead>
                <tr>
                  <th>GRN</th>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Total</th>
                  <th>Balance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        className="table-link mono"
                        onClick={() => open('receipt-detail', r.id)}
                      >
                        {r.number}
                      </button>
                    </td>
                    <td>{shortDate(r.date)}</td>
                    <td>{r.reference || '—'}</td>
                    <td>{money(r.total)}</td>
                    <td>{money(A.billBalance(r))}</td>
                    <td>
                      <Badge status={A.billStatus(r)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {p.notes && <Callout>{p.notes}</Callout>}
      <div className="detail-actions">
        {p.status === 'Draft' ? (
          <>
            <Button tone="" icon="edit" onClick={() => open('purchase-form', id)}>
              Edit
            </Button>
            {canApprove && (
              <Button icon="check" onClick={() => setApproving(true)}>
                Approve
              </Button>
            )}
            <Button
              disabled={A.approvalRequired(state, p)}
              title={
                A.approvalRequired(state, p)
                  ? `Purchase orders over ${money(state.settings.poApprovalLimit)} need approval before sending.`
                  : undefined
              }
              onClick={() =>
                mutate((s) => A.sendPurchase(s, id), 'Purchase order sent.', undefined, true)
              }
            >
              Send
            </Button>
            <Button
              tone="danger"
              icon="close"
              onClick={() =>
                confirm(
                  'Cancel this purchase order?',
                  'The unreceived order remains in your history with a canceled status.',
                  () =>
                    mutate(
                      (s) => A.cancelPurchase(s, id),
                      'Purchase order canceled.',
                      undefined,
                      true,
                    ),
                  'Cancel order',
                )
              }
            >
              Cancel order
            </Button>
          </>
        ) : p.status === 'Sent' ? (
          <>
            <Button tone="" icon="edit" onClick={() => open('purchase-form', id)}>
              Edit
            </Button>
            <Button tone="" icon="print" onClick={() => window.print()}>
              Print / PDF
            </Button>
            <Button icon="receive" onClick={() => open('purchase-receive', id)}>
              Receive
            </Button>
            {receipts.length > 0 && (
              <Button tone="" onClick={() => open('close-remainder', id)}>
                Close remainder
              </Button>
            )}
            {!receipts.length && (
              <Button tone="danger" icon="close" onClick={() => setCanceling(true)}>
                Cancel order
              </Button>
            )}
          </>
        ) : (
          p.status === 'Received' && (
            <Button tone="" icon="print" onClick={() => window.print()}>
              Print / PDF
            </Button>
          )
        )}
      </div>
      {approving && (
        <WorkspaceForm
          onSubmit={(data) => {
            mutate(
              (s) => A.approvePurchase(s, id, data.note),
              'Purchase order approved.',
              undefined,
              true,
            );
            setApproving(false);
          }}
        >
          <Field label="Approval note (optional)" name="note" />
          <div className="form-footer">
            <Button tone="" onClick={() => setApproving(false)}>
              Cancel
            </Button>
            <Button type="submit" icon="check">
              Confirm approval
            </Button>
          </div>
        </WorkspaceForm>
      )}
      {canceling && (
        <WorkspaceForm
          onSubmit={(data) => {
            mutate(
              (s) => A.cancelPurchase(s, id, data.reason),
              'Purchase order canceled.',
              undefined,
              true,
            );
            setCanceling(false);
          }}
        >
          <Field label="Cancellation reason" name="reason" required />
          <div className="form-footer">
            <Button tone="" onClick={() => setCanceling(false)}>
              Keep order
            </Button>
            <Button type="submit" icon="check">
              Confirm cancellation
            </Button>
          </div>
        </WorkspaceForm>
      )}
      <PurchaseOrderDocument order={p} />
    </>
  );
}

export function ReceiptDetail({ id }: { id: string }) {
  const { state, open } = useWorkspace();
  const r = state.receipts.find((rec) => rec.id === id);
  if (!r) return <Empty />;
  const supplier = A.contact(state, r.supplierId);
  const po = r.purchaseId ? state.purchases.find((p) => p.id === r.purchaseId) : undefined;
  const balance = A.billBalance(r);
  const status = A.billStatus(r);

  return (
    <>
      <div className="flex items-center gap-[8px]">
        <Badge status={status} />
      </div>
      <div className="my-[18px]">
        <Summary
          items={[
            ['GRN number', r.number],
            ['Supplier', supplier?.name || r.supplierId],
            ...(po
              ? [
                  [
                    'Purchase order',
                    <button
                      type="button"
                      key="po-link"
                      className="table-link mono"
                      onClick={() => open('purchase-detail', po.id)}
                    >
                      {po.number}
                    </button>,
                  ] as [string, any],
                ]
              : []),
            ['Supplier reference', r.reference || '—'],
            ['Receipt date', date(r.date)],
            ['Due date', date(r.due)],
            ['Warehouse', A.warehouse(state, r.warehouseId)?.name || '—'],
          ]}
        />
      </div>
      {r.lines.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Lot / Batch</th>
                <th>Expiry</th>
                <th>Qty</th>
                <th>Cost</th>
                {po && <th>PO Cost</th>}
                {po && <th>Diff</th>}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l, index) => {
                const poCost = l.orderedPrice;
                const diff = poCost !== undefined ? A.round(l.price - poCost) : undefined;
                return (
                  <tr key={index}>
                    <td>
                      <strong>{l.name}</strong>
                    </td>
                    <td>{l.lotCode || '—'}</td>
                    <td>{l.expiry ? shortDate(l.expiry) : '—'}</td>
                    <td>
                      {number(l.qty)} {A.unitLabel(l.unit, l.qty)}
                    </td>
                    <td>{money(l.price)}</td>
                    {po && <td>{poCost !== undefined ? money(poCost) : '—'}</td>}
                    {po && (
                      <td>
                        {diff !== undefined && diff !== 0 ? (
                          <span className={diff > 0 ? 'text-amber-600' : 'text-green-600'}>
                            {diff > 0 ? `+${money(diff)}` : `-${money(Math.abs(diff))}`}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td>{money(l.qty * l.price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-[18px]">
        <Summary
          items={[
            ['Total', money(r.total)],
            ['Paid', money(r.paid)],
            ['Credited', money(r.credited)],
            ['Balance', money(balance)],
          ]}
        />
      </div>
      {r.notes && <Callout>{r.notes}</Callout>}
      <div className="detail-actions">
        <Button tone="" icon="print" onClick={() => window.print()}>
          Print GRN
        </Button>
        {balance > 0 && (
          <Button icon="wallet" onClick={() => open('bill-payment', r.id)}>
            Pay supplier
          </Button>
        )}
      </div>
    </>
  );
}
export function ContactDetail({ id }: { id: string }) {
  const { state, open } = useWorkspace();
  const c = A.contact(state, id);
  if (!c) return <Empty />;
  const customer = c.type === 'Customer',
    items = customer
      ? state.invoices.filter((i) => i.customerId === id)
      : state.purchases.filter((p) => p.supplierId === id);
  return (
    <>
      <div className="detail-hero">
        <span className="contact-initials !w-[55px] !h-[55px] !text-[17px]">
          {initials(c.name)}
        </span>
        <div>
          <h3>{c.name}</h3>
          <p>{c.person}</p>
        </div>
      </div>
      <Summary
        items={[
          ['Email', c.email || '—'],
          ['Phone', c.phone || '—'],
          ['Address', c.address || '—'],
        ]}
      />
      {customer && (
        <>
          <Button onClick={() => open('invoice-payment', id)}>Record payment</Button>
          <Button tone="" onClick={() => open('customer-statement', id)}>
            Statement
          </Button>
          <CustomerCreditActions customerId={id} />
          <h3 className="detail-label">Payments</h3>
          <PaymentsTable customerId={id} />
        </>
      )}
      {customer && <ReservationsList customerId={id} />}
      {customer && <SpecialPrices customerId={id} />}
      {customer && (
        <>
          <h3 className="detail-label">Account</h3>
          <Summary
            items={[
              ['Group', state.customerGroups.find((g) => g.id === c.groupId)?.name || 'No group'],
              ['Payment terms', `${c.paymentTermsDays} days`],
              ['Credit limit', c.creditLimit === null ? 'No limit' : money(c.creditLimit)],
              ['Available credit', money(A.customerCredit(state, id))],
              ['Current exposure', money(A.creditCheck(state, id, 0).exposure)],
              ['Overdue amount', money(A.creditCheck(state, id, 0).overdue)],
              [
                'Billing habit',
                c.billing === 'monthly' ? 'Monthly billing' : 'Invoice each delivery',
              ],
              ['Status', <Badge status={A.customerAccountStatus(state, id)} />],
            ]}
          />
          {c.onHold && <Callout>{c.holdReason}</Callout>}
          <div className="detail-actions">
            <Button tone="" onClick={() => open('contact-hold', id)}>
              {c.onHold ? 'Release hold' : 'Put on hold'}
            </Button>
          </div>
        </>
      )}
      {!customer && (
        <>
          <h3 className="detail-label">Account</h3>
          <Summary
            items={[
              [
                'Payment terms',
                c.paymentTermsDays === 0 ? 'Cash on delivery' : `${c.paymentTermsDays} days`,
              ],
              ['Lead time', `${c.leadTimeDays} ${c.leadTimeDays === 1 ? 'day' : 'days'}`],
              ['Minimum order', c.minOrderValue === null ? 'None' : money(c.minOrderValue)],
              [
                'Outstanding payables',
                money(
                  A.sum(
                    state.receipts.filter((r) => r.supplierId === id),
                    A.billBalance,
                  ),
                ),
              ],
            ]}
          />
          <h3 className="detail-label">Supplier bills</h3>
          {state.receipts
            .filter((r) => r.supplierId === id)
            .slice(0, 10)
            .map((bill) => (
              <button
                className="detail-batch w-full text-left"
                key={bill.id}
                onClick={() => open('receipt-detail', bill.id)}
              >
                <div>
                  <strong>{bill.number}</strong>
                  <small>
                    {date(bill.date)}
                    {bill.reference ? ` · ${bill.reference}` : ''}
                  </small>
                </div>
                <div className="text-right">
                  <strong>{money(bill.total)}</strong>
                  <br />
                  <Badge status={A.billStatus(bill)} />
                </div>
              </button>
            ))}
          {!state.receipts.some((r) => r.supplierId === id) && (
            <Empty
              title="No supplier bills yet"
              description="Goods receipts and bills will appear here."
            />
          )}
        </>
      )}
      <h3 className="detail-label">{customer ? 'Invoice' : 'Purchase order'} history</h3>
      {customer && <CustomerOrders customerId={id} />}
      {customer && (
        <>
          <h3 className="detail-label">Credit notes</h3>
          <CreditNotesTable customerId={id} />
        </>
      )}
      {items.slice(0, 10).map((item) => (
        <button
          className="detail-batch w-full text-left"
          key={item.id}
          onClick={() => open(customer ? 'invoice-detail' : 'purchase-detail', item.id)}
        >
          <div>
            <strong>{item.number}</strong>
            <small>{date(item.date)}</small>
          </div>
          <div className="text-right">
            <strong>{money(item.total)}</strong>
            <br />
            <Badge
              status={
                'due' in item ? A.invoiceStatus(item) : A.purchaseStatus(state, item as Purchase)
              }
            />
          </div>
        </button>
      ))}
      {!items.length && (
        <Empty
          title="No transactions yet"
          description="Activity will appear here after your first transaction."
        />
      )}
      <div className="detail-actions">
        <Button tone="" icon="edit" onClick={() => open('contact-form', id)}>
          Edit contact
        </Button>
      </div>
    </>
  );
}
