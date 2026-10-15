import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, errorMessage, money } from '../lib/format';
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
  Summary,
} from './ui';
import { WorkspaceForm } from './forms';
import type { CustomerPayment } from '../types';

export function CustomerPaymentForm({ id }: { id?: string }) {
  const { state, mutate } = useWorkspace();
  const invoice = state.invoices.find((i) => i.id === id);
  const initialCustomer =
    invoice?.customerId || (A.contact(state, id || '')?.type === 'Customer' ? id! : '');
  const [customerId, setCustomerId] = useState(initialCustomer);
  const [amount, setAmount] = useState(invoice ? String(A.invoiceBalance(invoice)) : '');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const invoices = A.openInvoices(state, customerId);
  let remaining = Math.max(0, Number(amount) || 0);
  const applied: Record<string, number> = {};
  const prioritized =
    invoice?.customerId === customerId
      ? [
          ...invoices.filter((i) => i.id === invoice.id),
          ...invoices.filter((i) => i.id !== invoice.id),
        ]
      : invoices;
  prioritized.forEach((i) => {
    const n =
      edits[i.id] === undefined
        ? Math.min(A.invoiceBalance(i), remaining)
        : Number(edits[i.id]) || 0;
    applied[i.id] = n;
    remaining = Math.max(0, A.round(remaining - n));
  });
  const total = A.sum(invoices, (i) => applied[i.id]);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.recordPayment(s, {
              customerId,
              date: data.date,
              amount,
              method: data.method as CustomerPayment['method'],
              reference: data.reference,
              note: data.note,
              allocations: invoices
                .filter((i) => applied[i.id] > 0)
                .map((i) => ({ invoiceId: i.id, amount: applied[i.id] })),
            }),
          'Payment recorded. Accounts updated.',
        )
      }
    >
      <div className="form-grid">
        <SelectField
          label="Customer"
          name="customerId"
          defaultValue={customerId}
          onChange={(value) => {
            setCustomerId(value);
            setEdits({});
          }}
        >
          <ContactOptions type="Customer" />
        </SelectField>
        <Field
          label="Payment date"
          name="date"
          type="date"
          defaultValue={A.today()}
          max={A.today()}
          required
        />
        <Field
          label="Payment amount ($)"
          name="amount"
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setEdits({});
          }}
          required
        />
        <SelectField label="Payment method" name="method">
          {['Bank transfer', 'Cash', 'Card', 'Cheque', 'Other'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </SelectField>
        <Field label="Reference" name="reference" />
        <Field label="Note" name="note" />
      </div>
      <DataTable
        items={invoices}
        pageSize={Math.max(1, invoices.length)}
        columns={['Invoice', 'Due date', 'Balance', 'Apply']}
        row={(i) => (
          <tr key={i.id}>
            <td>{i.number}</td>
            <td>{date(i.due)}</td>
            <td>{money(A.invoiceBalance(i))}</td>
            <td>
              <input
                aria-label={`Apply ${i.number}`}
                type="number"
                min="0"
                max={A.invoiceBalance(i)}
                step="0.01"
                value={edits[i.id] ?? applied[i.id]}
                onChange={(e) => setEdits({ ...edits, [i.id]: e.target.value })}
              />
            </td>
          </tr>
        )}
      />
      <Callout>
        {money(total)} applied &#183; {money(A.round((Number(amount) || 0) - total))} kept as credit
      </Callout>
      <FormFooter label="Record payment" />
    </WorkspaceForm>
  );
}

export function PaymentsTable({ customerId }: { customerId?: string }) {
  const { state, open } = useWorkspace();
  return (
    <DataTable
      items={state.payments.filter((p) => !customerId || p.customerId === customerId)}
      columns={[
        'Payment',
        'Date',
        'Customer',
        'Method',
        'Reference',
        'Amount',
        'Applied',
        'Credit left',
        'Status',
      ]}
      row={(p) => (
        <tr key={p.id}>
          <td>
            <button className="table-link" onClick={() => open('payment-detail', p.id)}>
              {p.number}
            </button>
          </td>
          <td>{date(p.date)}</td>
          <td>{A.contact(state, p.customerId)?.name}</td>
          <td>{p.method}</td>
          <td>{p.reference || '\u2014'}</td>
          <td>{money(p.amount)}</td>
          <td>{money(A.sum(p.allocations, (a) => a.amount))}</td>
          <td>{money(A.paymentCredit(p))}</td>
          <td>
            <Badge status={p.status} />
          </td>
        </tr>
      )}
    />
  );
}

export function PaymentDetail({ id }: { id: string }) {
  const { state, mutate, open, toast } = useWorkspace();
  const p = state.payments.find((p) => p.id === id);
  if (!p) return <Empty />;
  return (
    <>
      <div className="invoice-document" id="print-document">
        <div className="invoice-document-header">
          <div>
            <h3>{state.settings.company}</h3>
            <p>{state.settings.address}</p>
          </div>
          <div>
            <h3>OFFICIAL RECEIPT</h3>
            <p>{p.number}</p>
            <p>{date(p.date)}</p>
            <Badge status={p.status} />
          </div>
        </div>
        <Summary
          items={[
            ['Customer', A.contact(state, p.customerId)?.name || ''],
            ['Amount received', money(p.amount)],
            ['Method', p.method],
            ['Reference', p.reference || '\u2014'],
            ['Available credit', money(A.paymentCredit(p))],
            ['Refunded', money(p.refunded)],
            ['Note', p.note],
          ]}
        />
        <h3 className="detail-label">Invoices paid</h3>
        {p.allocations.map((a, index) => (
          <div className="detail-batch" key={index}>
            <button className="table-link" onClick={() => open('invoice-detail', a.invoiceId)}>
              {state.invoices.find((i) => i.id === a.invoiceId)?.number}
            </button>
            <span>
              {date(a.date)} &#183; {money(a.amount)}
            </span>
            <Button
              className="no-print"
              tone=""
              onClick={() => {
                try {
                  mutate(
                    (s) => A.removeAllocation(s, { source: 'payment', id, invoiceId: a.invoiceId }),
                    'Allocation removed.',
                    undefined,
                    true,
                  );
                } catch (error) {
                  toast(errorMessage(error), true);
                }
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        {p.status === 'Voided' && (
          <Callout>
            Voided {date(p.voidDate)}: {p.voidReason}
          </Callout>
        )}
      </div>
      <div className="detail-actions">
        <Button tone="" icon="print" onClick={() => window.print()}>
          Print receipt
        </Button>
      </div>
      {p.status === 'Posted' && (
        <WorkspaceForm
          onSubmit={(data) =>
            mutate(
              (s) => A.voidPayment(s, id, data.reason, data.date),
              'Payment voided.',
              undefined,
              true,
            )
          }
        >
          <Field label="Void reason" name="reason" required />
          <Field
            label="Void date"
            name="date"
            type="date"
            defaultValue={A.today()}
            min={p.date}
            max={A.today()}
            required
          />
          <FormFooter label="Void payment" />
        </WorkspaceForm>
      )}
    </>
  );
}

export function RefundCreditForm({ id }: { id: string }) {
  const { state, mutate } = useWorkspace();
  const available = A.customerCredit(state, id);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.refundCredit(s, {
              customerId: id,
              amount: data.amount,
              method: data.method,
              date: data.date,
            }),
          'Credit refunded.',
        )
      }
    >
      <Callout>Available credit {money(available)}</Callout>
      <Field
        label="Refund amount ($)"
        name="amount"
        type="number"
        min="0.01"
        max={available}
        step="0.01"
        defaultValue={available}
        required
      />
      <Field
        label="Refund date"
        name="date"
        type="date"
        defaultValue={A.today()}
        max={A.today()}
        required
      />
      <SelectField label="Refund method" name="method">
        {['Cash', 'Bank transfer', 'Card', 'Cheque', 'Other'].map((m) => (
          <option key={m}>{m}</option>
        ))}
      </SelectField>
      <FormFooter label="Refund credit" />
    </WorkspaceForm>
  );
}

export function CustomerCreditActions({
  customerId,
  invoiceId,
}: {
  customerId: string;
  invoiceId?: string;
}) {
  const { state, mutate, open, toast } = useWorkspace();
  const available = A.customerCredit(state, customerId);
  if (available <= 0) return null;
  return (
    <div className="detail-actions">
      <Button
        tone=""
        onClick={() => {
          try {
            mutate(
              (s) => {
                const invoices = invoiceId
                  ? s.invoices.filter((i) => i.id === invoiceId)
                  : A.openInvoices(s, customerId);
                invoices.forEach((i) => {
                  if (A.invoiceBalance(i) > 0 && A.customerCredit(s, customerId) > 0)
                    A.applyCredit(s, { customerId, invoiceId: i.id });
                });
              },
              'Credit applied.',
              undefined,
              true,
            );
          } catch (error) {
            toast(errorMessage(error), true);
          }
        }}
      >
        {invoiceId ? 'Apply credit' : 'Apply to oldest invoices'}
      </Button>
      {!invoiceId && (
        <Button tone="" onClick={() => open('refund-credit', customerId)}>
          Refund credit
        </Button>
      )}
    </div>
  );
}

export function InvoicePayments({ id }: { id: string }) {
  const { state, open } = useWorkspace();
  const sources = [
    ...state.payments
      .filter((p) => p.status === 'Posted')
      .map((p) => ({ ...p, kind: 'payment-detail' as const })),
    ...state.creditNotes
      .filter((cn) => cn.status === 'Issued')
      .map((cn) => ({ ...cn, kind: 'credit-note-detail' as const })),
  ];
  return (
    <>
      <h3 className="detail-label">Payments &amp; credits</h3>
      {sources.flatMap((p) =>
        p.allocations
          .filter((a) => a.invoiceId === id)
          .map((a, index) => (
            <div className="detail-batch" key={`${p.id}-${index}`}>
              <button className="table-link" onClick={() => open(p.kind, p.id)}>
                {p.number}
              </button>
              <span>{date(a.date)}</span>
              <strong>{money(a.amount)}</strong>
            </div>
          )),
      )}
    </>
  );
}
