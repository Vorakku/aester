import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, money, number, errorMessage } from '../lib/format';
import { Badge, Button, DataTable, Empty, Field, FormFooter, PanelHeader } from './ui';
import { WorkspaceForm } from './forms';

export function CreateDeliveryInvoiceButton({
  deliveryIds,
  children = 'Create invoice',
  disabled = false,
}: {
  deliveryIds: string[];
  children?: string;
  disabled?: boolean;
}) {
  const { mutate, open, toast } = useWorkspace();
  return (
    <Button
      disabled={disabled || !deliveryIds.length}
      onClick={() => {
        try {
          mutate(
            (s) => A.createInvoiceFromDeliveries(s, { deliveryIds }),
            'Invoice draft created.',
            (invoice) => open('invoice-detail', invoice.id),
          );
        } catch (error) {
          toast(errorMessage(error), true);
        }
      }}
    >
      {children}
    </Button>
  );
}

export function ToInvoice() {
  const { state, open } = useWorkspace();
  const [selected, setSelected] = useState<string[]>([]);
  const rows = A.deliveredNotInvoiced(state);
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  if (!rows.length) return <Empty title="Nothing waiting to be invoiced" />;
  return (
    <>
      {customerIds.map((customerId) => {
        const customer = A.contact(state, customerId)!;
        const items = rows.filter((r) => r.customerId === customerId);
        const ids = items.map((r) => r.delivery.id);
        const checked = selected.filter((id) => ids.includes(id));
        return (
          <section
            className="panel mb-[20px]"
            key={customerId}
            aria-label={`To invoice: ${customer.name}`}
          >
            <PanelHeader
              title={customer.name}
              subtitle={`${money(A.sum(items, (r) => r.value))} waiting to be invoiced`}
              action={
                <Badge status={customer.billing === 'monthly' ? 'Monthly' : 'Per delivery'} />
              }
            />
            <DataTable
              items={items}
              columns={['Select', 'DN', 'Order', 'Date', 'Age', 'Value', '']}
              row={({ delivery: d, ageDays, value, late }) => (
                <tr key={d.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${d.number}`}
                      checked={checked.includes(d.id)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...checked, d.id]
                            : checked.filter((id) => id !== d.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button className="table-link" onClick={() => open('delivery-detail', d.id)}>
                      {d.number}
                    </button>
                  </td>
                  <td>
                    <button className="table-link" onClick={() => open('order-detail', d.orderId)}>
                      {state.orders.find((o) => o.id === d.orderId)?.number}
                    </button>
                  </td>
                  <td>{date(d.date!)}</td>
                  <td>{number(ageDays)} days</td>
                  <td>{money(value)}</td>
                  <td>{late && <Badge status="Late" />}</td>
                </tr>
              )}
            />
            <div className="detail-actions">
              <CreateDeliveryInvoiceButton deliveryIds={checked} />
              <CreateDeliveryInvoiceButton deliveryIds={ids}>
                Invoice all
              </CreateDeliveryInvoiceButton>
            </div>
          </section>
        );
      })}
    </>
  );
}

export function InvoiceHeaderForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const invoice = state.invoices.find((i) => i.id === id)!;
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) => A.saveInvoiceHeader(s, id, { date: data.date, due: data.due, notes: data.notes }),
          'Invoice header saved.',
          () => open('invoice-detail', id),
        )
      }
    >
      <Field
        label="Invoice date"
        name="date"
        type="date"
        defaultValue={invoice.date}
        max={A.today()}
        required
      />
      <Field label="Due date" name="due" type="date" defaultValue={invoice.due} required />
      <Field label="Notes" name="notes" defaultValue={invoice.notes} />
      <FormFooter label="Save header" />
    </WorkspaceForm>
  );
}

export function BillingAttention() {
  const { state, navigate, setInvoiceTab } = useWorkspace();
  const late = A.deliveredNotInvoiced(state).filter((r) => r.late);
  if (!late.length) return null;
  return (
    <div className="notification-item">
      <button
        className="table-link"
        onClick={() => {
          setInvoiceTab('to-invoice');
          navigate('invoices');
        }}
      >
        {late.length} deliveries waiting to be invoiced ({money(A.sum(late, (r) => r.value))})
      </button>
    </div>
  );
}
