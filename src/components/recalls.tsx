import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, errorMessage, number } from '../lib/format';
import { exportRecall } from '../lib/exports';
import { Badge, Button, Callout, DataTable, Empty, Field, FormFooter, Summary } from './ui';
import { WorkspaceForm } from './forms';

export function RecallForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const b = state.batches.find((b) => b.id === id);
  if (!b) return <Empty />;
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.createRecall(s, {
              productId: b.productId,
              lotCode: b.code,
              reason: data.reason,
              date: data.date,
              note: data.note,
            }),
          'Recall started. This lot is blocked in every warehouse.',
          (r) => open('recall-detail', r.id),
        )
      }
    >
      <Callout>
        {A.product(state, b.productId)?.name} · Lot {b.code}
      </Callout>
      <div className="form-grid">
        <Field label="Reason" name="reason" full required />
        <Field label="Recall date" name="date" type="date" defaultValue={A.today()} full required />
        <Field label="Note" name="note" full />
      </div>
      <FormFooter label="Start recall" />
    </WorkspaceForm>
  );
}

export function RecallsTable() {
  const { state, open } = useWorkspace();
  return (
    <section className="panel">
      <DataTable
        items={state.recalls}
        columns={['Number', 'Product', 'Lot', 'Date', 'Status', 'Customers reached', 'On hand']}
        row={(r) => {
          const trace = A.recallTrace(state, r.id);
          return (
            <tr key={r.id}>
              <td>
                <button className="text-button" onClick={() => open('recall-detail', r.id)}>
                  {r.number}
                </button>
              </td>
              <td>{A.product(state, r.productId)?.name}</td>
              <td>{r.lotCode}</td>
              <td>{date(r.date)}</td>
              <td>
                <Badge status={r.status} />
              </td>
              <td>{new Set(trace.sold.map((row) => row.customerId)).size}</td>
              <td>{number(trace.totals.onHand)}</td>
            </tr>
          );
        }}
      />
    </section>
  );
}

export function RecallDetail({ id }: { id: string }) {
  const { state, open, mutate, toast } = useWorkspace();
  const r = state.recalls.find((r) => r.id === id);
  if (!r) return <Empty />;
  const trace = A.recallTrace(state, id);
  return (
    <>
      <div className="detail-hero">
        <div>
          <h3>
            {r.number} · {A.product(state, r.productId)?.name}
          </h3>
          <p>Lot {r.lotCode}</p>
        </div>
      </div>
      <Badge status={r.status} />
      <Callout>{r.reason}</Callout>
      <Summary
        items={[
          ['Date', date(r.date)],
          ['Created by', r.createdBy],
          ['Note', r.note || '—'],
          ...(r.closedAt ? [['Closed at', date(r.closedAt.slice(0, 10))] as [string, string]] : []),
        ]}
      />
      <h3 className="detail-label">Sold to</h3>
      <DataTable
        items={trace.sold}
        columns={['Customer', 'Phone', 'Delivery', 'Invoice', 'Date', 'Qty', 'Returned']}
        row={(row) => (
          <tr key={row.delivery || row.invoice}>
            <td>{row.customerName}</td>
            <td>{row.phone}</td>
            <td>{row.delivery || '—'}</td>
            <td>{row.invoice}</td>
            <td>{date(row.date)}</td>
            <td>{number(row.qty)}</td>
            <td>{number(row.returned)}</td>
            <td>{number(row.returned)}</td>
          </tr>
        )}
      />
      <h3 className="detail-label">Still in stock</h3>
      <DataTable
        items={trace.onHand}
        columns={['Warehouse', 'Qty', '']}
        row={(row) => (
          <tr key={row.batchId}>
            <td>{A.warehouse(state, row.warehouseId)?.name}</td>
            <td>{number(row.qty)}</td>
            <td>
              <Button tone="danger" onClick={() => open('recall-write-off', row.batchId)}>
                Write off
              </Button>
            </td>
          </tr>
        )}
      />
      <Summary items={Object.entries(trace.totals).map(([label, qty]) => [label, number(qty)])} />
      <div className="detail-actions">
        <Button tone="" icon="download" onClick={() => exportRecall(state, id)}>
          Export CSV
        </Button>
        {r.status === 'Open' && (
          <Button
            tone="danger"
            onClick={() => {
              try {
                mutate(
                  (s) => A.closeRecall(s, id),
                  'Recall closed.',
                  () => open('recall-detail', id),
                );
              } catch (error) {
                toast(errorMessage(error), true);
              }
            }}
          >
            Close recall
          </Button>
        )}
      </div>
    </>
  );
}
