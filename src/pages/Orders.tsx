import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, money, number, errorMessage } from '../lib/format';
import { Badge, Button, DataTable, Heading } from '../components/ui';

export function OrdersPage() {
  const { state, open, mutate, toast } = useWorkspace();
  const [tab, setTab] = useState('Quotations');
  const orders = state.orders.filter((o) =>
    tab === 'Quotations' ? o.status === 'Quote' : o.status !== 'Quote',
  );
  const backorders = state.orders
    .filter((o) => o.status === 'Confirmed')
    .flatMap((order) =>
      order.lines
        .filter((l) => A.openQty(state, order, l.id) > A.orderLineReserved(state, order, l.id))
        .map((line) => ({ order, line })),
    );
  return (
    <>
      <Heading
        title="Orders"
        subtitle="Quotations, confirmed orders and stock still to reserve."
        actions={
          <>
            <Button tone="" onClick={() => open('order-form')}>
              New quotation
            </Button>
            <Button onClick={() => open('new-order')}>New order</Button>
          </>
        }
      />
      <div className="tab-bar" role="tablist" aria-label="Order views">
        {['Quotations', 'Orders', 'Backorders'].map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? 'active' : ''}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="panel">
        {tab === 'Backorders' ? (
          <DataTable
            items={backorders}
            columns={['Order', 'Customer', 'Product', 'Open qty', 'Reserved', 'Free now', '']}
            row={({ order, line }) => (
              <tr key={line.id}>
                <td>
                  <button className="table-link" onClick={() => open('order-detail', order.id)}>
                    {order.number}
                  </button>
                </td>
                <td>{A.contact(state, order.customerId)?.name}</td>
                <td>{line.name}</td>
                <td>
                  {number(A.openQty(state, order, line.id))} {A.unitLabel(line.unit)}
                </td>
                <td>
                  {number(A.orderLineReserved(state, order, line.id))} {A.unitLabel(line.unit)}
                </td>
                <td>
                  {number(
                    A.free(state, line.productId, {
                      customerId: order.customerId,
                      allowShortDated: order.allowShortDated,
                    }) / line.factor,
                  )}{' '}
                  {A.unitLabel(line.unit)}
                </td>
                <td>
                  {order.lines.find(
                    (l) => A.openQty(state, order, l.id) > A.orderLineReserved(state, order, l.id),
                  )?.id === line.id && (
                    <Button
                      tone="small"
                      onClick={() => {
                        try {
                          mutate((s) => A.reserveOrder(s, order.id), 'Available stock reserved.');
                        } catch (error) {
                          toast(errorMessage(error), true);
                        }
                      }}
                    >
                      Reserve available stock
                    </Button>
                  )}
                </td>
              </tr>
            )}
          />
        ) : (
          <DataTable
            items={orders}
            columns={[
              'Number',
              'Customer',
              'Date',
              tab === 'Quotations' ? 'Valid until' : 'Requested date',
              'Total',
              'Status',
            ]}
            row={(o) => (
              <tr key={o.id}>
                <td>
                  <button className="table-link" onClick={() => open('order-detail', o.id)}>
                    {o.number}
                  </button>
                </td>
                <td>{A.contact(state, o.customerId)?.name}</td>
                <td>{date(o.date)}</td>
                <td>{date(tab === 'Quotations' ? o.validUntil! : o.requestedDate)}</td>
                <td>{money(A.orderTotals(o).total)}</td>
                <td>
                  <Badge
                    status={
                      o.status === 'Quote'
                        ? A.quoteStatus(o)
                        : o.status === 'Confirmed'
                          ? A.fulfilmentStatus(state, o)
                          : o.status
                    }
                  />
                  {o.status === 'Confirmed' &&
                    o.lines.some(
                      (l) => A.openQty(state, o, l.id) > A.orderLineReserved(state, o, l.id),
                    ) && <Badge status="Backorder" />}
                </td>
              </tr>
            )}
          />
        )}
      </div>
    </>
  );
}
