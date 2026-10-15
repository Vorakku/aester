import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, money, number, errorMessage } from '../lib/format';
import type { CreditNote, CreditNoteInput, CreditNoteLine, CreditReason } from '../types';
import { Badge, Button, Callout, DataTable, Empty, Field, SelectField, Summary } from './ui';
import { WorkspaceForm } from './forms';

const reasonLabel = (reason: string) => reason.replaceAll('_', ' ');

export function CreditNotesTable({
  invoiceId,
  customerId,
}: {
  invoiceId?: string;
  customerId?: string;
}) {
  const { state, open } = useWorkspace();
  return (
    <DataTable
      items={state.creditNotes.filter(
        (cn) =>
          (!invoiceId || cn.invoiceId === invoiceId) &&
          (!customerId || cn.customerId === customerId),
      )}
      columns={[
        'Number',
        'Invoice',
        'Customer',
        'Date',
        'Kind',
        'Reason',
        'Total',
        'Settlement',
        'Status',
      ]}
      row={(cn) => (
        <tr key={cn.id}>
          <td>
            <button className="table-link" onClick={() => open('credit-note-detail', cn.id)}>
              {cn.number}
            </button>
          </td>
          <td>
            <button className="table-link" onClick={() => open('invoice-detail', cn.invoiceId)}>
              {state.invoices.find((i) => i.id === cn.invoiceId)?.number}
            </button>
          </td>
          <td>{A.contact(state, cn.customerId)?.name}</td>
          <td>{date(cn.date)}</td>
          <td>{cn.kind}</td>
          <td>{reasonLabel(cn.reason)}</td>
          <td>{money(cn.total)}</td>
          <td>{cn.settlement}</td>
          <td>
            <Badge status={cn.status} />
          </td>
        </tr>
      )}
    />
  );
}

export function CreditNoteForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const existing = state.creditNotes.find((cn) => cn.id === id);
  const invoice = state.invoices.find((i) => i.id === (existing?.invoiceId || id))!;
  const [kind, setKind] = useState<CreditNote['kind']>(existing?.kind || 'return');
  const [settlement, setSettlement] = useState<CreditNote['settlement']>(
    existing?.settlement || 'credit',
  );
  const [reason, setReason] = useState<CreditReason>(existing?.reason || 'wrong_prescription');
  const [rows, setRows] = useState(() =>
    invoice.lines.map((line, index) => {
      const saved = existing?.lines.find((l) => l.invoiceLineIndex === index);
      return {
        qty: String(saved?.qty || 0),
        price: String(saved?.price || line.price),
        returns: saved
          ? Object.fromEntries(saved.returns.map((p) => [p.batchId, String(p.qty)]))
          : (undefined as Record<string, string> | undefined),
      };
    }),
  );
  const changeRow = (index: number, change: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r, n) => (n === index ? { ...r, ...change } : r)));
  const pending: CreditNoteLine[] = [];
  const returnPlans = rows.map((row, index) => {
    const line = invoice.lines[index];
    const options = A.creditReturnOptions(state, invoice, line.productId, pending);
    const quantities =
      row.returns ||
      Object.fromEntries(
        A.proposeCreditReturns(options, (Number(row.qty) || 0) * line.factor).map((p) => [
          p.batchId,
          String(p.qty),
        ]),
      );
    pending.push({
      ...line,
      invoiceLineIndex: index,
      qty: Number(row.qty) || 0,
      returns: options
        .filter((p) => Number(quantities[p.batchId]) > 0)
        .map((p) => ({
          batchId: p.batchId,
          warehouseId: p.warehouseId,
          lotCode: p.lotCode,
          cost: p.cost,
          qty: Number(quantities[p.batchId]),
        })),
    });
    return { options, quantities };
  });
  const preview = A.creditNoteAmounts(
    invoice,
    rows.map((r, index) => ({
      qty: Number(r.qty) || 0,
      price: kind === 'return' ? invoice.lines[index].price : Number(r.price) || 0,
    })),
  );
  const applied = Math.min(preview.total, A.invoiceBalance(invoice));
  const remainder = A.round(preview.total - applied);
  return (
    <WorkspaceForm
      onSubmit={(data, mode) => {
        const input: CreditNoteInput = {
          invoiceId: invoice.id,
          kind,
          reason,
          date: data.date,
          note: data.note,
          settlement,
          refundMethod: data.refundMethod,
          lines: rows.flatMap((r, index) =>
            Number(r.qty) > 0
              ? [
                  {
                    invoiceLineIndex: index,
                    qty: r.qty,
                    ...(kind === 'correction'
                      ? { price: r.price }
                      : {
                          returns: r.returns
                            ? Object.entries(r.returns)
                                .filter(([, qty]) => Number(qty) > 0)
                                .map(([batchId, qty]) => ({ batchId, qty }))
                            : undefined,
                        }),
                  },
                ]
              : [],
          ),
        };
        mutate(
          (s) => {
            const cn = A.saveCreditNote(s, input, existing?.id);
            return mode === 'issue' ? A.issueCreditNote(s, cn.id) : cn;
          },
          mode === 'issue' ? 'Credit note issued.' : 'Credit note draft saved.',
          (cn) => open('credit-note-detail', cn.id),
        );
      }}
    >
      <Callout>
        {invoice.number} · {A.contact(state, invoice.customerId)?.name}
      </Callout>
      <div className="form-grid">
        <fieldset className="field">
          <legend>Credit note kind</legend>
          <div className="segmented">
            {(['return', 'correction'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                className={kind === value ? 'active' : ''}
                onClick={() => {
                  setKind(value);
                  setRows(
                    rows.map((r, index) => ({
                      ...r,
                      price: String(invoice.lines[index].price),
                      returns: undefined,
                    })),
                  );
                }}
              >
                {value === 'return' ? 'Return goods' : 'Price correction'}
              </button>
            ))}
          </div>
        </fieldset>
        <SelectField
          label="Reason"
          name="reason"
          defaultValue={reason}
          onChange={(e) => setReason(e as CreditReason)}
        >
          {A.creditReasons.map((r) => (
            <option key={r} value={r}>
              {reasonLabel(r)}
            </option>
          ))}
        </SelectField>
        <Field
          label="Credit note date"
          name="date"
          type="date"
          defaultValue={existing?.date || A.today()}
          min={invoice.date}
          max={A.today()}
          required
        />
        <Field
          label="Note"
          name="note"
          defaultValue={existing?.note}
          required={reason === 'other'}
        />
      </div>
      {invoice.lines.map((line, index) => {
        const already = A.sum(
          state.creditNotes.filter((cn) => cn.invoiceId === invoice.id && cn.status === 'Issued'),
          (cn) =>
            A.sum(
              cn.lines.filter((l) => l.invoiceLineIndex === index),
              (l) => l.qty * l.price,
            ),
        );
        const { options: picks, quantities } = returnPlans[index];
        return (
          <section className="panel p-[16px] mb-[12px]" key={index}>
            <strong>{line.name}</strong>
            <p>
              Invoiced: {number(line.qty)} {A.unitLabel(line.unit, line.qty)} · Already credited:{' '}
              {money(already)}
            </p>
            <div className="form-grid">
              <Field
                name={`qty-${index}`}
                label={`Qty to credit ${index + 1}`}
                type="number"
                min="0"
                max={line.qty}
                step="1"
                value={rows[index].qty}
                onChange={(e) => changeRow(index, { qty: e.target.value, returns: undefined })}
              />
              <Field
                name={`price-${index}`}
                label={`Credit price ${index + 1}`}
                type="number"
                min="0.01"
                step="0.01"
                max={line.price}
                readOnly={kind === 'return'}
                value={kind === 'return' ? line.price : rows[index].price}
                onChange={(e) => changeRow(index, { price: e.target.value })}
              />
            </div>
            {kind === 'return' &&
              picks.map((p) => (
                <Field
                  key={p.batchId}
                  name={`return-${index}-${p.batchId}`}
                  label={`Return ${index + 1}: ${p.lotCode} · ${date(p.expiry)} · ${A.warehouse(state, p.warehouseId)?.name} (${p.remaining} available base units)`}
                  type="number"
                  min="0"
                  max={p.remaining}
                  step="1"
                  value={quantities[p.batchId] || '0'}
                  onChange={(e) =>
                    changeRow(index, { returns: { ...quantities, [p.batchId]: e.target.value } })
                  }
                />
              ))}
          </section>
        );
      })}
      <Summary items={[['Credit note total', money(preview.total)]]} />
      <Callout>
        Reduces {invoice.number}'s balance by {money(applied)}.
        {remainder > 0 && (
          <>
            {' '}
            {money(remainder)} more:{' '}
            {settlement === 'refund' ? 'Refund' : 'Keep as customer credit'}.
          </>
        )}
      </Callout>
      <fieldset className="field">
        <legend>Settlement</legend>
        <div className="flex gap-[16px]">
          <label>
            <input
              type="radio"
              name="settlement"
              value="refund"
              checked={settlement === 'refund'}
              onChange={() => setSettlement('refund')}
            />{' '}
            Refund
          </label>
          <label>
            <input
              type="radio"
              name="settlement"
              value="credit"
              checked={settlement === 'credit'}
              onChange={() => setSettlement('credit')}
            />{' '}
            Keep as customer credit
          </label>
        </div>
      </fieldset>
      {settlement === 'refund' && (
        <SelectField
          label="Refund method"
          name="refundMethod"
          defaultValue={existing?.refundMethod || 'Cash'}
          required
        >
          {['Cash', 'Bank transfer', 'Card', 'Other'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </SelectField>
      )}
      <div className="form-footer">
        <Button tone="" type="submit" value="draft">
          Save draft
        </Button>
        <Button type="submit" value="issue">
          Issue credit note
        </Button>
      </div>
    </WorkspaceForm>
  );
}

export function CreditNoteDetail({ id }: { id: string }) {
  const { state, mutate, open, confirm, toast } = useWorkspace();
  const cn = state.creditNotes.find((cn) => cn.id === id);
  if (!cn) return <Empty />;
  const invoice = state.invoices.find((i) => i.id === cn.invoiceId)!;
  return (
    <>
      <div className="invoice-document" id="print-document">
        <div className="invoice-document-header">
          <div>
            <div className="invoice-brand">
              aster<small>{state.settings.company}</small>
            </div>
            <p>{state.settings.address}</p>
            <p>{state.settings.email}</p>
            <p>{state.settings.phone}</p>
          </div>
          <div>
            <h3>CREDIT NOTE</h3>
            <p>{cn.number}</p>
            <p>{date(cn.date)}</p>
            <Badge status={cn.status} />
          </div>
        </div>
        <div className="invoice-document-parties">
          <div>
            <span>Customer</span>
            <strong>{A.contact(state, cn.customerId)?.name}</strong>
            {A.contact(state, cn.customerId)?.address}
          </div>
          <div>
            Invoice: {invoice.number}
            <p>
              {cn.kind} · {reasonLabel(cn.reason)}
            </p>
          </div>
        </div>
        <DataTable
          pageSize={cn.lines.length}
          items={cn.lines}
          columns={['Product', 'Qty', 'Price', 'Amount']}
          row={(l) => (
            <tr key={l.invoiceLineIndex}>
              <td>
                {l.name}
                <small>{l.sku}</small>
                {l.returns.map((p) => (
                  <p key={p.batchId}>
                    Lot {p.lotCode} · {A.warehouse(state, p.warehouseId)?.name} · {number(p.qty)}{' '}
                    base units
                  </p>
                ))}
              </td>
              <td>
                {number(l.qty)} {A.unitLabel(l.unit, l.qty)}
              </td>
              <td>{money(l.price)}</td>
              <td>{money(l.qty * l.price)}</td>
            </tr>
          )}
        />
        <div className="invoice-summary">
          {[
            ['Subtotal', cn.subtotal],
            ['Discount', cn.discount],
            [`Tax (${cn.taxRate}%)`, cn.taxAmount],
            ['Total', cn.total],
            ['Applied to invoices', A.sum(cn.allocations, (a) => a.amount)],
            ['Refunded', cn.refunded],
            ['Available credit', cn.status === 'Issued' ? A.creditAvailable(cn) : 0],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{money(Number(value))}</strong>
            </div>
          ))}
        </div>
        <p>
          Settlement: {cn.settlement}
          {cn.settlement === 'refund' ? ` · ${cn.refundMethod}` : ''}
        </p>
        {cn.note && <div className="invoice-note">{cn.note}</div>}
      </div>
      {cn.status === 'Issued' && cn.kind === 'return' && (
        <Callout>Returned stock is in quarantine — release or write it off in Batches.</Callout>
      )}
      <div className="detail-actions">
        <Button tone="" icon="print" onClick={() => window.print()}>
          Print / PDF
        </Button>
        <Button tone="" onClick={() => open('invoice-detail', invoice.id)}>
          View invoice
        </Button>
        {cn.status === 'Draft' && (
          <>
            <Button tone="" onClick={() => open('credit-note-form', id)}>
              Edit draft
            </Button>
            <Button
              onClick={() => {
                try {
                  mutate(
                    (s) => A.issueCreditNote(s, id),
                    'Credit note issued.',
                    (c) => open('credit-note-detail', c.id),
                  );
                } catch (error) {
                  toast(errorMessage(error), true);
                }
              }}
            >
              Issue credit note
            </Button>
            <Button
              tone="danger"
              onClick={() =>
                confirm(
                  'Delete this draft?',
                  cn.number,
                  () => mutate((s) => A.deleteCreditNote(s, id), 'Draft deleted.'),
                  'Delete draft',
                )
              }
            >
              Delete draft
            </Button>
          </>
        )}
      </div>
    </>
  );
}
