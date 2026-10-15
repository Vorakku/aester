import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, money } from '../lib/format';
import { exportAging, exportStatement } from '../lib/exports';
import { Button, Callout, DataTable, Empty, Field, PanelHeader, Summary } from './ui';
import type { AgingRow } from '../types';

const buckets = [
  ['current', 'Current'],
  ['d1_30', '1–30'],
  ['d31_60', '31–60'],
  ['d61_90', '61–90'],
  ['d90plus', '90+'],
] as const;

function AgingSummary({ row }: { row: AgingRow }) {
  return (
    <section aria-label="Aging summary" className="panel mt-[18px]">
      <PanelHeader title="Aging summary" />
      <Summary
        items={[
          ...buckets.map(([key, label]): [string, string] => [label, money(row[key])]),
          ['Unapplied credit', money(row.credit)],
          ['Total due', <strong data-testid="statement-aging-total">{money(row.total)}</strong>],
        ]}
      />
    </section>
  );
}

export function Receivables() {
  const { state, open } = useWorkspace();
  const [asOf, setAsOf] = useState(A.today());
  const rows = A.agingReport(state, asOf);
  return (
    <section className="panel">
      <PanelHeader
        title="Receivables"
        subtitle="Outstanding invoices by days past due, less unapplied credit."
        action={
          <Button tone="small" icon="download" onClick={() => exportAging(state, asOf)}>
            Export CSV
          </Button>
        }
      />
      <div className="toolbar">
        <Field
          label="As of"
          name="aging-as-of"
          type="date"
          value={asOf}
          max={A.today()}
          onChange={(e) => {
            if (e.target.value) setAsOf(e.target.value);
          }}
        />
      </div>
      <DataTable
        items={rows}
        pageSize={Math.max(8, rows.length)}
        filterKey={asOf}
        columns={['Customer', ...buckets.map(([, label]) => label), 'Credit', 'Total']}
        row={(r) => (
          <tr key={r.customerId || 'totals'}>
            <td>
              {r.customerId ? (
                <button
                  className="table-link"
                  onClick={() => open('customer-statement', r.customerId, undefined, asOf)}
                >
                  {A.contact(state, r.customerId)?.name}
                </button>
              ) : (
                <strong>Totals</strong>
              )}
            </td>
            {buckets.map(([key]) => (
              <td
                key={key}
                className={`num ${['d61_90', 'd90plus'].includes(key) && r[key] > 0 ? 'text-[#b65340] bg-[#fff1e9]' : ''}`}
              >
                {money(r[key])}
              </td>
            ))}
            <td className="num">{money(r.credit)}</td>
            <td className="num">
              <strong>{money(r.total)}</strong>
            </td>
          </tr>
        )}
      />
    </section>
  );
}

export function CustomerStatement({ id, asOf = A.today() }: { id: string; asOf?: string }) {
  const { state } = useWorkspace();
  const [from, setFrom] = useState(() => A.shift(-1, asOf.slice(0, 7) + '-01').slice(0, 7) + '-01');
  const [to, setTo] = useState(asOf);
  const customer = A.contact(state, id);
  if (!customer || customer.type !== 'Customer') return <Empty />;
  const valid = !!from && !!to && from <= to;
  const statement = valid ? A.customerStatement(state, id, { from, to }) : null;
  return (
    <>
      <div className="toolbar no-print">
        <Field
          label="From"
          name="statement-from"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          label="To"
          name="statement-to"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      {!statement ? (
        <Callout>Choose a valid date range with the end on or after the start.</Callout>
      ) : (
        <>
          <div className="invoice-document" id="print-document">
            <div className="invoice-document-header">
              <div>
                <h3>{state.settings.company}</h3>
                <p>{state.settings.address}</p>
                <p>
                  {state.settings.phone} · {state.settings.email}
                </p>
              </div>
              <div>
                <h3>CUSTOMER STATEMENT</h3>
                <p>
                  {date(from)} – {date(to)}
                </p>
              </div>
            </div>
            <div className="invoice-document-parties">
              <strong>{customer.name}</strong>
              <p>{customer.address}</p>
              <p>
                {customer.email} · {customer.phone}
              </p>
            </div>
            <Summary
              items={[
                ['Opening balance', money(statement.opening)],
                [
                  'Closing balance',
                  <strong data-testid="statement-closing">{money(statement.closing)}</strong>,
                ],
              ]}
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {['Date', 'Type / reference', 'Description', 'Debit', 'Credit', 'Balance'].map(
                      (label) => (
                        <th key={label}>{label}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {statement.lines.map((l, index) => (
                    <tr key={index}>
                      <td>{date(l.date)}</td>
                      <td>
                        <strong>{l.type}</strong>
                        <div>{l.reference}</div>
                      </td>
                      <td>{l.description}</td>
                      <td className="num">{l.debit ? money(l.debit) : '—'}</td>
                      <td className="num">{l.credit ? money(l.credit) : '—'}</td>
                      <td className="num">{money(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!statement.lines.length && <p>No movements in this period.</p>}
            <AgingSummary row={statement.aging} />
            <p className="mt-[18px]">
              {statement.closing > 0
                ? `Please pay the amount due by ${date(A.shift(customer.paymentTermsDays, to))}. Please include your invoice numbers with payment.`
                : statement.closing < 0
                  ? 'Your account has a credit balance.'
                  : 'Your account is settled.'}
            </p>
          </div>
          <div className="detail-actions no-print">
            <Button tone="" icon="print" onClick={() => window.print()}>
              Print
            </Button>
            <Button
              tone=""
              icon="download"
              onClick={() => exportStatement(state, id, { from, to })}
            >
              Export CSV
            </Button>
          </div>
        </>
      )}
    </>
  );
}

export function AgingBar() {
  const { state, navigate, setAccountingTab } = useWorkspace();
  const totals = A.agingReport(state).at(-1)!;
  const gross = A.sum(
    buckets.map(([key]) => totals[key]),
    (amount) => amount,
  );
  const colors = ['#548569', '#9caa59', '#d0a147', '#cb7e42', '#b65340'];
  return (
    <button
      className="panel w-full text-left mb-[20px]"
      aria-label="View receivables aging"
      onClick={() => {
        setAccountingTab('receivables');
        navigate('accounting');
      }}
    >
      <strong>Receivables aging · {money(totals.total)}</strong>
      <div className="flex h-[12px] rounded overflow-hidden my-[12px]" aria-hidden="true">
        {buckets.map(([key], i) => (
          <span
            key={key}
            style={{ width: `${gross ? (totals[key] / gross) * 100 : 0}%`, background: colors[i] }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-[16px]">
        {buckets.map(([key, label], i) => (
          <span key={key}>
            <span style={{ color: colors[i] }}>●</span> {label}: {money(totals[key])}
          </span>
        ))}
        <span>Credit: {money(totals.credit)}</span>
      </div>
    </button>
  );
}
