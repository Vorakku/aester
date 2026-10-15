import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date } from '../lib/format';
import { Badge, DataTable, Heading } from '../components/ui';

export function DeliveriesPage() {
  const { state, open } = useWorkspace();
  const [tab, setTab] = useState('To pick');
  const items = state.deliveries.filter((d) =>
    tab === 'To pick'
      ? d.status === 'Picking'
      : tab === 'Out for delivery'
        ? d.status === 'Dispatched'
        : tab === 'Delivered'
          ? d.status === 'Delivered'
          : ['Returned', 'Cancelled'].includes(d.status),
  );
  return (
    <>
      <Heading title="Deliveries" subtitle="Pick lots, dispatch goods and record their arrival." />
      <div className="tab-bar" role="tablist" aria-label="Delivery views">
        {['To pick', 'Out for delivery', 'Delivered', 'Returned / cancelled'].map((name) => (
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
        <DataTable
          filterKey={tab}
          items={items}
          columns={[
            'DN',
            'Customer',
            'Order',
            'Warehouse',
            'Method',
            'Lines',
            'Date',
            'Status',
            'Invoiced',
          ]}
          row={(d) => (
            <tr key={d.id}>
              <td>
                <button className="table-link" onClick={() => open('delivery-detail', d.id)}>
                  {d.number}
                </button>
              </td>
              <td>{A.contact(state, d.customerId)?.name}</td>
              <td>
                {d.orderId ? (
                  <button className="table-link" onClick={() => open('order-detail', d.orderId)}>
                    {state.orders.find((o) => o.id === d.orderId)?.number}
                  </button>
                ) : (
                  '—'
                )}
              </td>
              <td>{A.warehouse(state, d.warehouseId || '')?.name || 'Any'}</td>
              <td>{d.method}</td>
              <td>{d.lines.length}</td>
              <td>{d.date ? date(d.date) : '—'}</td>
              <td>
                <Badge status={d.status} />
              </td>
              <td>{d.invoiceId ? '✓' : '—'}</td>
            </tr>
          )}
        />
      </div>
    </>
  );
}
