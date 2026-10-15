import { useState } from 'react';
import { CreateDeliveryInvoiceButton } from './invoicing';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, number, errorMessage } from '../lib/format';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Empty,
  Field,
  FormFooter,
  SelectField,
  Summary,
  WarehouseOptions,
} from './ui';
import { WorkspaceForm } from './forms';

export function DeliveryForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const [warehouseId, setWarehouseId] = useState('wh_main');
  const order = state.orders.find((o) => o.id === id);
  if (!order) return <Empty />;
  const quantities = A.deliveryQuantities(state, order, warehouseId);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.createDelivery(s, {
              orderId: id,
              warehouseId: data.warehouseId,
              method: data.method as 'delivery' | 'pickup',
              lines: order.lines
                .map((l) => ({ orderLineId: l.id, qty: Number(data[l.id]) }))
                .filter((l) => l.qty !== 0),
            }),
          'Delivery created.',
          (d) => open('delivery-detail', d.id),
        )
      }
    >
      <div className="form-grid">
        <SelectField
          label="Warehouse"
          name="warehouseId"
          defaultValue="wh_main"
          onChange={setWarehouseId}
        >
          <WarehouseOptions />
        </SelectField>
        <SelectField label="Method" name="method" defaultValue={order.fulfilment}>
          <option value="delivery">Delivery</option>
          <option value="pickup">Pickup</option>
        </SelectField>
      </div>
      <DataTable
        key={warehouseId}
        pageSize={Math.max(1, order.lines.length)}
        items={order.lines}
        columns={['Product', 'Open', 'Pickable here', 'Quantity to deliver']}
        row={(l) => {
          const pickable = Math.floor(
            A.deliveryPickable(state, order, l.productId, warehouseId) / l.factor,
          );
          return (
            <tr key={l.id}>
              <td>
                {l.name} ({l.unit})
              </td>
              <td>{number(A.openQty(state, order, l.id))}</td>
              <td>{number(pickable)}</td>
              <td>
                <Field
                  label={`Deliver ${l.name}`}
                  name={l.id}
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={quantities.find((q) => q.orderLineId === l.id)?.qty || 0}
                  required
                />
              </td>
            </tr>
          );
        }}
      />
      <FormFooter label="Create delivery" />
    </WorkspaceForm>
  );
}
export function DeliveryPicksForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const delivery = state.deliveries.find((d) => d.lines.some((l) => l.id === id));
  const line = delivery?.lines.find((l) => l.id === id);
  if (!delivery || !line) return <Empty />;
  const allowShortDated = delivery.orderId
    ? state.orders.find((o) => o.id === delivery.orderId)!.allowShortDated
    : (state.invoices.find((i) => i.id === delivery.invoiceId)?.allowShortDated ?? false);
  const batches = A.eligibleBatches(state, line.productId, {
    customerId: delivery.customerId,
    allowShortDated,
  }).filter((b) => !delivery.warehouseId || b.warehouseId === delivery.warehouseId);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.setPicks(
              s,
              delivery.id,
              id,
              batches
                .map((b) => ({ batchId: b.id, qty: Number(data[b.id]) }))
                .filter((p) => p.qty !== 0),
            ),
          'Picks updated.',
          () => open('delivery-detail', delivery.id),
        )
      }
    >
      <Callout>
        {line.name}: pick exactly {number(line.qty * line.factor)} base units.
      </Callout>
      <DataTable
        pageSize={Math.max(1, batches.length)}
        items={batches}
        columns={['Lot', 'Expiry', 'Warehouse', 'Available', 'Pick qty']}
        row={(b) => (
          <tr key={b.id}>
            <td>{b.code}</td>
            <td>{date(b.expiry)}</td>
            <td>{A.warehouse(state, b.warehouseId)?.name}</td>
            <td>{number(b.qty)}</td>
            <td>
              <Field
                label={`Pick ${b.code}`}
                name={b.id}
                type="number"
                min="0"
                step="1"
                defaultValue={line.picks.find((p) => p.batchId === b.id)?.qty || 0}
                required
              />
            </td>
          </tr>
        )}
      />
      <FormFooter label="Save picks" />
    </WorkspaceForm>
  );
}
export function DeliveryDetail({ id }: { id: string }) {
  const { state, open, mutate, toast } = useWorkspace();
  const [action, setAction] = useState('');
  const [pickList, setPickList] = useState(false);
  const d = state.deliveries.find((d) => d.id === id);
  if (!d) return <Empty />;
  const order = state.orders.find((o) => o.id === d.orderId),
    invoice = state.invoices.find((i) => i.id === d.invoiceId);
  const refresh = () => {
    setAction('');
    open('delivery-detail', id);
  };
  const print = (pick: boolean) => {
    setPickList(pick);
    setTimeout(() => window.print(), 0);
  };
  return (
    <>
      <Badge status={d.status} />
      <Summary
        items={[
          ['Customer', A.contact(state, d.customerId)?.name],
          [
            'Order',
            order ? (
              <button className="table-link" onClick={() => open('order-detail', order.id)}>
                {order.number}
              </button>
            ) : (
              '—'
            ),
          ],
          ['Warehouse', A.warehouse(state, d.warehouseId || '')?.name || 'Any warehouse'],
          ['Method', d.method],
          ['Address', d.address],
          ['Dispatch date', d.date ? date(d.date) : '—'],
          ['Driver', d.driver || '—'],
          ['Received by', d.receivedBy || '—'],
          [
            'Invoice',
            invoice ? (
              <button className="table-link" onClick={() => open('invoice-detail', invoice.id)}>
                {invoice.number}
              </button>
            ) : (
              '—'
            ),
          ],
        ]}
      />
      {d.returnReason && <Callout>{d.returnReason}</Callout>}
      {d.lines.map((l) => (
        <section key={l.id}>
          <h3 className="detail-label">
            {l.name} · {number(l.qty)} {A.unitLabel(l.unit, l.qty)}
          </h3>
          <DataTable
            items={l.picks}
            columns={['Lot', 'Expiry', 'Warehouse', 'Qty (base units)']}
            row={(p, index) => (
              <tr key={index}>
                <td>{p.lotCode}</td>
                <td>{date(p.expiry)}</td>
                <td>{A.warehouse(state, p.warehouseId)?.name}</td>
                <td>{number(p.qty)}</td>
              </tr>
            )}
          />
          {d.status === 'Picking' && (
            <Button tone="" icon="edit" onClick={() => open('delivery-picks', l.id)}>
              Change lot
            </Button>
          )}
        </section>
      ))}
      <div className="detail-actions">
        {!d.invoiceId &&
          ['Dispatched', 'Delivered'].includes(d.status) &&
          (state.invoices.find((i) => i.status === 'Draft' && i.deliveryIds.includes(id)) ? (
            <Button
              tone=""
              onClick={() =>
                open(
                  'invoice-detail',
                  state.invoices.find((i) => i.status === 'Draft' && i.deliveryIds.includes(id))!
                    .id,
                )
              }
            >
              Open invoice draft
            </Button>
          ) : (
            <CreateDeliveryInvoiceButton deliveryIds={[id]} />
          ))}
        <Button tone="" icon="print" onClick={() => print(false)}>
          Print delivery note
        </Button>
        {d.status === 'Picking' && (
          <>
            <Button tone="" icon="print" onClick={() => print(true)}>
              Print pick list
            </Button>
            <Button onClick={() => setAction('dispatch')}>
              {d.method === 'pickup' ? 'Hand over' : 'Dispatch'}
            </Button>
            <Button
              tone="danger"
              onClick={() => {
                try {
                  mutate((s) => A.cancelDelivery(s, id), 'Delivery cancelled.', refresh);
                } catch (error) {
                  toast(errorMessage(error), true);
                }
              }}
            >
              Cancel
            </Button>
          </>
        )}
        {d.status === 'Dispatched' && (
          <>
            <Button onClick={() => setAction('confirm')}>Confirm delivered</Button>
            <Button tone="danger" onClick={() => setAction('return')}>
              Not delivered
            </Button>
          </>
        )}
      </div>
      {action && (
        <WorkspaceForm
          key={action}
          onSubmit={(data) =>
            mutate(
              (s) => {
                if (action === 'dispatch')
                  return A.dispatchDelivery(s, id, {
                    date: data.date,
                    driver: data.driver,
                    receivedBy: data.receivedBy,
                  });
                if (action === 'confirm')
                  return A.confirmDelivered(s, id, {
                    receivedBy: data.receivedBy,
                    date: data.date,
                  });
                return A.markNotDelivered(s, id, data.reason);
              },
              'Delivery updated.',
              refresh,
            )
          }
        >
          {action !== 'return' && (
            <Field
              label={action === 'dispatch' ? 'Dispatch date' : 'Delivered date'}
              name="date"
              type="date"
              defaultValue={A.today()}
              max={A.today()}
              required
            />
          )}
          {action === 'dispatch' && d.method === 'delivery' ? (
            <Field label="Driver name" name="driver" />
          ) : action !== 'return' ? (
            <Field label="Received by" name="receivedBy" required />
          ) : (
            <Field label="Return reason" name="reason" required />
          )}
          <FormFooter
            label={
              action === 'dispatch'
                ? d.method === 'pickup'
                  ? 'Hand over goods'
                  : 'Dispatch goods'
                : action === 'confirm'
                  ? 'Confirm receipt'
                  : 'Return to quarantine'
            }
          />
        </WorkspaceForm>
      )}
      <div className="invoice-document print-only" id="print-document">
        <div className="invoice-document-header">
          <div>
            <h3>{state.settings.company}</h3>
            <p>{state.settings.address}</p>
            <p>{state.settings.phone}</p>
          </div>
          <div>
            <h3>{pickList ? 'PICK LIST' : 'DELIVERY NOTE'}</h3>
            <p>{d.number}</p>
            <p>{date(d.date || d.createdAt.slice(0, 10))}</p>
          </div>
        </div>
        <div className="invoice-document-parties">
          <div>
            <strong>{A.contact(state, d.customerId)?.name}</strong>
            <p>{d.address}</p>
          </div>
          <div>{order?.number}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty</th>
              <th>Lot</th>
              <th>Expiry</th>
              <th>Warehouse</th>
              <th>Base qty</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.flatMap((l) =>
              l.picks.map((p, index) => (
                <tr key={`${l.id}-${index}`}>
                  <td>{l.name}</td>
                  <td>
                    {l.qty} {A.unitLabel(l.unit, l.qty)}
                  </td>
                  <td>{p.lotCode}</td>
                  <td>{date(p.expiry)}</td>
                  <td>{A.warehouse(state, p.warehouseId)?.name}</td>
                  <td>{p.qty}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
        <p className="mt-[40px]">Received by / signature: __________________________________</p>
      </div>
    </>
  );
}
