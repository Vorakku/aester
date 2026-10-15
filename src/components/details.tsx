import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, initials, money, number, errorMessage } from '../lib/format';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Empty,
  ProductArt,
  ProductBadges,
  StockQuantity,
  Summary,
} from './ui';
import { InvoiceDocument, InvoiceIssueForm } from './forms';
import { ReorderLevels } from './reorder';
import { ReservationsList } from './reservations';

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
      {i.status === 'Draft' && reserved && <Badge status="Reserved" />}
      <div className="detail-actions">
        <Button tone="" icon="print" onClick={() => window.print()}>
          Print / PDF
        </Button>
        {i.status === 'Draft' ? (
          <>
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
            <Button tone="" icon="edit" onClick={() => open('invoice-form', id)}>
              Edit draft
            </Button>
            <InvoiceIssueForm id={id} />
          </>
        ) : A.invoiceBalance(i) > 0 ? (
          <Button icon="wallet" onClick={() => open('invoice-payment', id)}>
            Record payment
          </Button>
        ) : (
          <Badge status="Paid" />
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
      {i.payments.length > 0 && (
        <>
          <h3 className="detail-label">Payment history</h3>
          {i.payments.map((p) => (
            <div className="detail-batch" key={p.id}>
              <div>
                <strong>{p.method}</strong>
                <small>{date(p.date)}</small>
              </div>
              <strong>{money(p.amount)}</strong>
            </div>
          ))}
        </>
      )}
      {i.allocations.length > 0 && (
        <>
          <h3 className="detail-label">Allocated batches (FEFO)</h3>
          {i.allocations.map((a, index) => (
            <div className="detail-batch" key={index}>
              <div>
                <strong>{a.code}</strong>
                <small>
                  {A.product(state, a.productId)?.name} · {A.warehouse(state, a.warehouseId)?.name}
                </small>
              </div>
              <strong>{a.qty} units</strong>
            </div>
          ))}
        </>
      )}
    </>
  );
}
export function PurchaseDetail({ id }: { id: string }) {
  const { state, open, mutate, confirm } = useWorkspace();
  const p = state.purchases.find((p) => p.id === id);
  if (!p) return <Empty />;
  return (
    <>
      <Badge status={p.status} />
      <div className="my-[18px]">
        <Summary
          items={[
            ['Supplier', A.contact(state, p.supplierId)?.name],
            ['Warehouse', A.warehouse(state, p.warehouseId)?.name],
            ['Order date', date(p.date)],
            ['Expected delivery', date(p.expected)],
            ...(p.received ? [['Received', date(p.received)] as [string, string]] : []),
          ]}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty</th>
              <th>Cost</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, index) => (
              <tr key={index}>
                <td>
                  <strong>{l.name}</strong>
                </td>
                <td>
                  {number(l.qty)} {A.unitLabel(l.unit, l.qty)}
                </td>
                <td>{money(l.price)}</td>
                <td>{money(l.qty * l.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-[18px]">
        <Summary
          items={[
            ['Order total', money(p.total)],
            ...(p.status === 'Received'
              ? [['Supplier balance', money(p.total - p.paid)] as [string, string]]
              : []),
          ]}
        />
      </div>
      {p.notes && <Callout>{p.notes}</Callout>}
      <div className="detail-actions">
        {p.status === 'Ordered' ? (
          <>
            <Button
              tone="danger"
              icon="close"
              onClick={() =>
                confirm(
                  'Cancel this purchase order?',
                  'The unreceived order remains in your history with a canceled status.',
                  () => mutate((s) => A.cancelPurchase(s, id), 'Purchase order canceled.'),
                  'Cancel order',
                )
              }
            >
              Cancel order
            </Button>
            <Button icon="receive" onClick={() => open('purchase-receive', id)}>
              Receive order
            </Button>
          </>
        ) : (
          p.status === 'Received' &&
          p.paid < p.total && (
            <Button icon="wallet" onClick={() => open('bill-payment', id)}>
              Pay supplier
            </Button>
          )
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
      {customer && <ReservationsList customerId={id} />}
      {customer && (
        <>
          <h3 className="detail-label">Account</h3>
          <Summary
            items={[
              ['Group', state.customerGroups.find((g) => g.id === c.groupId)?.name || 'No group'],
              ['Payment terms', `${c.paymentTermsDays} days`],
              ['Credit limit', c.creditLimit === null ? 'No limit' : money(c.creditLimit)],
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
      <h3 className="detail-label">{customer ? 'Invoice' : 'Purchase order'} history</h3>
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
            <Badge status={'due' in item ? A.invoiceStatus(item) : item.status} />
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
