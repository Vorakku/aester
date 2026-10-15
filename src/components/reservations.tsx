import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, errorMessage } from '../lib/format';
import { WorkspaceForm } from './forms';
import {
  Badge,
  Button,
  Callout,
  ContactOptions,
  DataTable,
  Empty,
  Field,
  FormFooter,
  SelectField,
  StockQuantity,
  useStockAlerts,
} from './ui';

export function HoldStockForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const p = A.product(state, id);
  const [customerId, setCustomerId] = useState('');
  const [qty, setQty] = useState('1');
  if (!p) return <Empty />;
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.holdStock(s, {
              productId: id,
              customerId: data.customerId,
              qty: data.qty,
              expires: data.expires,
              note: data.note,
            }),
          'Stock held for customer.',
          () => open('product-detail', id),
        )
      }
    >
      <Callout>
        {p.name} · <StockQuantity product={p} qty={A.free(state, id, { customerId })} /> free
      </Callout>
      <div className="form-grid">
        <SelectField label="Customer" name="customerId" onChange={setCustomerId} full>
          <ContactOptions type="Customer" />
        </SelectField>
        <Field
          label={`Quantity (${A.unitLabel(p.unit)})`}
          name="qty"
          type="number"
          min="1"
          step="1"
          required
          value={qty}
          onChange={(event) => setQty(event.target.value)}
        />
        <Field
          label="Expires"
          name="expires"
          type="date"
          required
          defaultValue={A.shift(3)}
          min={A.today()}
          max={A.shift(30)}
        />
        <div className="form-field full">
          <small>
            <StockQuantity product={p} qty={Number(qty)} />
          </small>
        </div>
        <Field label="Note" name="note" full />
      </div>
      <FormFooter label="Hold stock" />
    </WorkspaceForm>
  );
}

export function ReservationsList({
  productId,
  customerId,
}: {
  productId?: string;
  customerId?: string;
}) {
  const { state, mutate, open, toast } = useWorkspace();
  const items = state.reservations.filter((r) =>
    productId
      ? r.productId === productId
      : r.customerId === customerId && r.source === 'hold' && A.reservationStatus(r) === 'Active',
  );
  return (
    <>
      <h3 className="detail-label">{productId ? 'Reservations' : 'Active holds'}</h3>
      <DataTable
        items={items}
        columns={[
          'Number',
          productId ? 'Customer' : 'Product',
          'Quantity',
          'Source',
          'Expires',
          'Status',
          '',
        ]}
        row={(r) => (
          <tr key={r.id}>
            <td>{r.number}</td>
            <td>
              {productId
                ? A.contact(state, r.customerId)?.name
                : A.product(state, r.productId)?.name}
            </td>
            <td>
              <StockQuantity product={A.product(state, r.productId)} qty={r.qty} />
            </td>
            <td>
              {r.source === 'hold' ? (
                'Hold'
              ) : r.source === 'sales_order' ? (
                <button className="table-link" onClick={() => open('order-detail', r.sourceId)}>
                  {state.orders.find((o) => o.id === r.sourceId)?.number}
                </button>
              ) : (
                state.invoices.find((i) => i.id === r.sourceId)?.number || 'Deleted draft'
              )}
            </td>
            <td>{r.expires ? date(r.expires) : '—'}</td>
            <td>
              <Badge status={A.reservationStatus(r)} />
            </td>
            <td>
              <div className="table-actions">
                {r.status === 'Active' && (
                  <Button
                    tone="small"
                    onClick={() => {
                      try {
                        mutate(
                          (s) => A.releaseReservation(s, r.id),
                          'Reservation released.',
                          undefined,
                          true,
                        );
                      } catch (error) {
                        toast(errorMessage(error), true);
                      }
                    }}
                  >
                    Release
                  </Button>
                )}
                {customerId && (
                  <Button
                    tone="small"
                    onClick={() =>
                      open('invoice-form', undefined, {
                        customerId: r.customerId,
                        lines: [
                          {
                            productId: r.productId,
                            qty: r.qty,
                            price: A.product(state, r.productId)!.price,
                          },
                        ],
                        fromHoldIds: [r.id],
                      })
                    }
                  >
                    Create invoice
                  </Button>
                )}
              </div>
            </td>
          </tr>
        )}
      />
    </>
  );
}

export function ReservationAlerts() {
  const { state, open } = useWorkspace();
  const { holds, overReserved: products } = useStockAlerts();
  return (
    <>
      {holds.map((r) => (
        <div className="notification-item" key={r.id}>
          <div>
            <strong>
              {r.number} · Hold expiring {r.expires === A.today() ? 'today' : 'tomorrow'}
            </strong>
            <p>
              {A.contact(state, r.customerId)?.name} · {A.product(state, r.productId)?.name} ·{' '}
              {r.qty} units
            </p>
            <button className="text-button" onClick={() => open('contact-detail', r.customerId)}>
              Review hold
            </button>
          </div>
        </div>
      ))}
      {products.map((p) => (
        <div className="notification-item" key={p.id}>
          <div>
            <strong>
              {p.name} <Badge status="Over-reserved" />
            </strong>
            <p>
              <StockQuantity product={p} qty={A.free(state, p.id)} /> free ·{' '}
              {A.reserved(state, p.id)} reserved
            </p>
            <button className="text-button" onClick={() => open('product-detail', p.id)}>
              Review reservations
            </button>
          </div>
        </div>
      ))}
      {!holds.length && !products.length && <Empty title="No reservation alerts" />}
    </>
  );
}
