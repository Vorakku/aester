import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, money, number, errorMessage } from '../lib/format';
import { Badge, Button, Callout, DataTable, Empty, Field, Summary } from './ui';
import { CreditOverrideFields, InvoiceDocument, WorkspaceForm } from './forms';
import { CreateDeliveryInvoiceButton } from './invoicing';

export function CustomerOrders({ customerId }: { customerId: string }) {
  const { state, open } = useWorkspace();
  return (
    <>
      <h3 className="detail-label">Orders</h3>
      {state.orders
        .filter((o) => o.customerId === customerId)
        .map((o) => (
          <button
            className="detail-batch w-full text-left"
            key={o.id}
            onClick={() => open('order-detail', o.id)}
          >
            <div>
              <strong>{o.number}</strong>
              <small>{date(o.date)}</small>
            </div>
            <div>
              <strong>{money(A.orderTotals(o).total)}</strong>
              <Badge status={o.status === 'Quote' ? A.quoteStatus(o) : o.status} />
            </div>
          </button>
        ))}
    </>
  );
}
export function OrderDetail({ id }: { id: string }) {
  const { state, open, mutate, toast } = useWorkspace();
  const [attempted, setAttempted] = useState(false);
  const [cancel, setCancel] = useState<{ lineId?: string; whole?: boolean } | null>(null);
  const order = state.orders.find((o) => o.id === id);
  if (!order) return <Empty />;
  const credit = A.creditCheck(state, order.customerId, A.orderOpenValue(state, order));
  const refresh = () => open('order-detail', id);
  return (
    <>
      <Badge status={order.status === 'Quote' ? A.quoteStatus(order) : order.status} />
      {order.status !== 'Quote' && <Badge status={A.fulfilmentStatus(state, order)} />}
      <Summary
        items={[
          ['Customer', A.contact(state, order.customerId)?.name || ''],
          ['Date', date(order.date)],
          ['Requested date', date(order.requestedDate)],
          ['Fulfilment', order.fulfilment],
          ['Delivery address', order.deliveryAddress],
          ...(order.validUntil
            ? [['Valid until', date(order.validUntil)] as [string, string]]
            : []),
          ['Total', money(A.orderTotals(order).total)],
          ['Open value', money(A.orderOpenValue(state, order))],
        ]}
      />
      {order.creditOverride && (
        <Callout>
          Credit override by {order.creditOverride.by}: {order.creditOverride.reason}
          <br />
          {order.creditOverride.reasons.join(' ')}
        </Callout>
      )}
      {order.cancelReason && <Callout>Cancellation: {order.cancelReason}</Callout>}
      <DataTable
        items={order.lines}
        columns={[
          'Product',
          'Unit',
          'Ordered',
          'Delivered',
          'Invoiced',
          'Cancelled',
          'Open',
          'Reserved',
          '',
        ]}
        row={(l) => (
          <tr key={l.id}>
            <td>
              <button className="table-link" onClick={() => open('product-detail', l.productId)}>
                {l.name}
              </button>
            </td>
            <td>{l.unit}</td>
            <td>{number(l.qty)}</td>
            <td>{number(A.deliveredQty(state, order, l.id))}</td>
            <td>{number(A.invoicedQty(state, order, l.id))}</td>
            <td>{number(l.cancelledQty)}</td>
            <td>{number(A.openQty(state, order, l.id))}</td>
            <td>{number(A.orderLineReserved(state, order, l.id))}</td>
            <td>
              {order.status === 'Confirmed' && A.openQty(state, order, l.id) > 0 && (
                <Button tone="small" onClick={() => setCancel({ lineId: l.id })}>
                  Cancel remaining
                </Button>
              )}
            </td>
          </tr>
        )}
      />
      {order.notes && <Callout>{order.notes}</Callout>}
      {order.status === 'Quote' && (
        <WorkspaceForm
          onSubmit={(data, mode) => {
            setAttempted(true);
            mutate(
              (s) =>
                A.confirmOrder(s, id, {
                  override: mode === 'override' ? { reason: data.overrideReason } : undefined,
                }),
              'Order confirmed.',
              refresh,
            );
          }}
        >
          <div className="form-footer">
            <Button type="submit" icon="check">
              Confirm
            </Button>
          </div>
          {attempted && !credit.ok && (
            <CreditOverrideFields reasons={credit.reasons} label="Override and confirm" />
          )}
        </WorkspaceForm>
      )}
      <div className="detail-actions">
        <CreateDeliveryInvoiceButton
          deliveryIds={A.deliveredNotInvoiced(state)
            .filter((r) => r.delivery.orderId === id)
            .map((r) => r.delivery.id)}
        >
          Invoice delivered
        </CreateDeliveryInvoiceButton>
        {['Quote', 'Confirmed'].includes(order.status) && (
          <Button tone="" icon="edit" onClick={() => open('order-form', id)}>
            Edit
          </Button>
        )}
        {order.status === 'Confirmed' && (
          <>
            <Button
              tone=""
              onClick={() => {
                try {
                  mutate((s) => A.reserveOrder(s, id), 'Available stock reserved.', refresh);
                } catch (error) {
                  toast(errorMessage(error), true);
                }
              }}
            >
              Reserve available stock
            </Button>
            <Button tone="" onClick={() => setCancel({})}>
              Cancel remaining
            </Button>
            <Button onClick={() => open('delivery-form', id)}>Create delivery</Button>
          </>
        )}
        {(order.status === 'Quote' ||
          (order.status === 'Confirmed' &&
            order.lines.every((l) => A.deliveredQty(state, order, l.id) === 0))) && (
          <Button tone="" onClick={() => setCancel({ whole: true })}>
            {order.status === 'Quote' ? 'Cancel' : 'Cancel order'}
          </Button>
        )}
        <Button tone="" icon="print" onClick={() => window.print()}>
          {order.status === 'Quote' ? 'Print quotation' : 'Print order confirmation'}
        </Button>
      </div>
      {cancel && (
        <WorkspaceForm
          key={cancel.lineId || String(cancel.whole)}
          onSubmit={(data) =>
            mutate(
              (s) =>
                cancel.whole
                  ? A.cancelOrder(s, id, data.reason)
                  : A.cancelRemaining(s, id, { lineId: cancel.lineId, reason: data.reason }),
              'Order quantities cancelled.',
              refresh,
            )
          }
        >
          <Field label="Cancellation reason" name="reason" required />
          <div className="form-footer">
            <Button tone="" onClick={() => setCancel(null)}>
              Keep order
            </Button>
            <Button type="submit" icon="check">
              Confirm cancellation
            </Button>
          </div>
        </WorkspaceForm>
      )}
      <h3 className="detail-label">Deliveries</h3>
      {state.deliveries
        .filter((d) => d.orderId === id)
        .map((d) => (
          <button
            className="detail-batch w-full text-left"
            key={d.id}
            onClick={() => open('delivery-detail', d.id)}
          >
            <strong>{d.number}</strong>
            <Badge status={d.status} />
          </button>
        ))}
      <h3 className="detail-label">Invoices</h3>
      {state.invoices
        .filter((i) => A.deliveriesOf(state, i).some((d) => d.orderId === id))
        .map((i) => (
          <button
            key={i.id}
            className="detail-batch w-full text-left"
            onClick={() => open('invoice-detail', i.id)}
          >
            <strong>{i.number}</strong>
            <Badge status={A.invoiceStatus(i)} />
          </button>
        ))}
      <InvoiceDocument order={order} />
    </>
  );
}
