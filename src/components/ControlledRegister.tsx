import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, errorMessage, number } from '../lib/format';
import { exportControlledRegister } from '../lib/exports';
import { Button, Callout, DataTable, Field, Filter, PanelHeader } from './ui';

export function ControlledRegister() {
  const { state, toast } = useWorkspace();
  const [from, setFrom] = useState(A.shift(-365)),
    [to, setTo] = useState(A.today()),
    [productId, setProductId] = useState('');
  let moves: ReturnType<typeof A.controlledRegister> = [],
    error = '';
  try {
    moves = A.controlledRegister(state, { from, to, productId });
  } catch (cause) {
    error = errorMessage(cause);
  }
  return (
    <section className="panel">
      <PanelHeader
        title="Controlled substances register"
        subtitle="Stock movements and running balances by product and lot."
      />
      <div className="toolbar">
        <div className="toolbar-left">
          <Field
            label="Date from"
            name="registerFrom"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
          <Field
            label="Date to"
            name="registerTo"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          <Filter
            label="Register product"
            value={productId}
            onChange={setProductId}
            items={state.products.filter((p) => p.controlled)}
            placeholder="All controlled products"
          />
        </div>
        <Button
          tone="small"
          icon="download"
          disabled={!!error}
          onClick={() => {
            exportControlledRegister(state, moves);
            toast('Report downloaded.');
          }}
        >
          Export CSV
        </Button>
      </div>
      {error && <Callout>{error}</Callout>}
      <DataTable
        items={moves}
        filterKey={`${from}|${to}|${productId}`}
        columns={['Date', 'Reference', 'Counterparty', 'Lot', 'In', 'Out', 'Balance']}
        row={(m) => (
          <tr key={m.id}>
            <td>{date(m.date)}</td>
            <td className="mono">{m.reference}</td>
            <td>{A.contact(state, m.counterpartyId || '')?.name || '—'}</td>
            <td>{m.lotCode}</td>
            <td>{m.qty > 0 ? number(m.qty) : '—'}</td>
            <td>{m.qty < 0 ? number(-m.qty) : '—'}</td>
            <td>{number(m.balanceAfter)}</td>
          </tr>
        )}
      />
    </section>
  );
}
