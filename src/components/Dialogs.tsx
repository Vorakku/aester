import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace, type Dialog } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { initials, money } from '../lib/format';
import { Button, Callout, Empty, Icon, IconButton, ProductArt, useStockAlerts } from './ui';
import {
  ContactForm,
  ContactHoldForm,
  AdjustmentForm,
  ExpenseForm,
  PaymentForm,
  ProductForm,
  PurchaseReceiveForm,
  ReceiveForm,
  TransactionForm,
  TransferForm,
} from './forms';
import {
  BatchDetail,
  ContactDetail,
  InvoiceDetail,
  ProductDetail,
  PurchaseDetail,
} from './details';
import { HelpContent } from '../pages/Settings';
import { MovementTable } from '../pages/Operations';
import { AddCountLotForm, CountReview, CountSheet, StartCountForm } from './stockCounts';
import { RecallForm, RecallDetail } from './recalls';
import { HoldStockForm, ReservationAlerts } from './reservations';

function SearchDialog() {
  const { state, open } = useWorkspace();
  const [q, setQ] = useState('');
  const query = q.toLowerCase();
  const products = state.products
    .filter((p) =>
      `${p.name} ${p.sku} ${p.barcode} ${p.packs.map((pack) => pack.barcode).join(' ')}`
        .toLowerCase()
        .includes(query),
    )
    .slice(0, 4);
  const invoices = query
    ? state.invoices
        .filter((i) =>
          `${i.number} ${A.contact(state, i.customerId)?.name}`.toLowerCase().includes(query),
        )
        .slice(0, 3)
    : [];
  const contacts = query
    ? state.contacts
        .filter((c) => `${c.name} ${c.email} ${c.phone}`.toLowerCase().includes(query))
        .slice(0, 3)
    : [];
  return (
    <>
      <div className="command-input">
        <Icon name="search" />
        <input
          placeholder="Search products, invoices, contacts..."
          aria-label="Search workspace"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
      </div>
      <div className="command-results">
        {products.map((p) => (
          <button
            className="command-result"
            key={p.id}
            onClick={() => open('product-detail', p.id)}
          >
            <ProductArt product={p} />
            <div>
              <strong>{p.name}</strong>
              <small>
                Product · {p.sku} · {A.available(state, p.id)} sellable
              </small>
            </div>
            <Icon name="chevron" />
          </button>
        ))}
        {invoices.map((i) => (
          <button
            className="command-result"
            key={i.id}
            onClick={() => open('invoice-detail', i.id)}
          >
            <span className="contact-initials">
              <Icon name="invoice" />
            </span>
            <div>
              <strong>
                {i.number} · {A.contact(state, i.customerId)?.name}
              </strong>
              <small>
                Invoice · {money(i.total)} · {A.invoiceStatus(i)}
              </small>
            </div>
            <Icon name="chevron" />
          </button>
        ))}
        {contacts.map((c) => (
          <button
            className="command-result"
            key={c.id}
            onClick={() => open('contact-detail', c.id)}
          >
            <span className="contact-initials">{initials(c.name)}</span>
            <div>
              <strong>{c.name}</strong>
              <small>
                {c.type} · {c.email}
              </small>
            </div>
            <Icon name="chevron" />
          </button>
        ))}
        {!products.length && !invoices.length && !contacts.length && (
          <Empty description="Try a different name or reference." icon="search" />
        )}
      </div>
      <div className="search-tip">
        Type a name, SKU, barcode, or invoice number. Press Esc to close.
      </div>
    </>
  );
}
function StockAlerts() {
  const { state, open } = useWorkspace();
  const { low, expiry, recalls, holds, overReserved } = useStockAlerts();
  return (
    <>
      <div className="account-banner">
        <Icon name="bell" />
        <div>
          <strong>
            {low.length + expiry.length + recalls.length + holds.length + overReserved.length} items
            need attention
          </strong>
          <p>
            {low.length} low-stock products · {expiry.length} expiry alerts · {recalls.length}{' '}
            recalls · {holds.length} expiring holds · {overReserved.length} over-reserved products
          </p>
        </div>
      </div>
      {recalls.map((r) => (
        <div className="notification-item" key={r.id}>
          <span className="activity-icon red">
            <Icon name="alert" />
          </span>
          <div>
            <strong>
              {r.number} · {A.product(state, r.productId)?.name}
            </strong>
            <p>
              Lot {r.lotCode} · {A.recallTrace(state, r.id).totals.onHand} units still in stock.
            </p>
            <button className="text-button" onClick={() => open('recall-detail', r.id)}>
              Review recall <Icon name="arrow" />
            </button>
          </div>
        </div>
      ))}
      {low.map((p) => (
        <div className="notification-item" key={p.id}>
          <span className="activity-icon amber">
            <Icon name="box" />
          </span>
          <div>
            <strong>{p.name} is running low</strong>
            <p>
              {A.available(state, p.id)} {p.unit}s available · reorder at {p.reorder}.
            </p>
            <button className="text-button" onClick={() => open('receive', p.id)}>
              Receive stock <Icon name="arrow" />
            </button>
          </div>
        </div>
      ))}
      {expiry.map((b) => (
        <div className="notification-item" key={b.id}>
          <span className="activity-icon amber">
            <Icon name="clock" />
          </span>
          <div>
            <strong>{A.product(state, b.productId)?.name}</strong>
            <p>
              Batch {b.code} ·{' '}
              {A.daysLeft(b.expiry) <= 0 ? 'Expired' : `Expires in ${A.daysLeft(b.expiry)} days`} ·{' '}
              {b.qty} units.
            </p>
            <button className="text-button" onClick={() => open('batch-detail', b.id)}>
              Review batch <Icon name="arrow" />
            </button>
          </div>
        </div>
      ))}
      {(holds.length > 0 || overReserved.length > 0) && <ReservationAlerts />}
      {!low.length &&
        !expiry.length &&
        !recalls.length &&
        !holds.length &&
        !overReserved.length && (
          <Empty
            title="All clear"
            description="There are no stock or expiry alerts."
            icon="check"
          />
        )}
    </>
  );
}
function DialogContents({ dialog }: { dialog: Dialog }) {
  const { state, close } = useWorkspace();
  const id = 'id' in dialog ? dialog.id || '' : '';
  const contents: Partial<Record<Dialog['kind'], ReactNode>> = {
    'product-form': <ProductForm id={id || undefined} />,
    'product-detail': <ProductDetail id={id} />,
    receive: <ReceiveForm id={id || undefined} />,
    'batch-detail': <BatchDetail id={id} />,
    'recall-form': <RecallForm id={id} />,
    'recall-detail': <RecallDetail id={id} />,
    'recall-write-off': <AdjustmentForm id={id} recall />,
    transfer: <TransferForm id={id || undefined} />,
    'adjust-stock': <AdjustmentForm id={id} />,
    'write-off-all': <AdjustmentForm id={id} writeOffAll />,
    'start-count': <StartCountForm />,
    'count-sheet': <CountSheet id={id} />,
    'count-review': <CountReview id={id} />,
    'add-count-lot': <AddCountLotForm id={id} />,
    'hold-stock': <HoldStockForm id={id} />,
    'invoice-form': (
      <TransactionForm
        id={id || undefined}
        initial={'initial' in dialog ? dialog.initial : undefined}
      />
    ),
    'invoice-detail': <InvoiceDetail id={id} />,
    'invoice-payment': <PaymentForm id={id} />,
    'bill-payment': <PaymentForm id={id} bill />,
    'purchase-form': (
      <TransactionForm purchase initial={'initial' in dialog ? dialog.initial : undefined} />
    ),
    'purchase-detail': <PurchaseDetail id={id} />,
    'purchase-receive': <PurchaseReceiveForm id={id} />,
    'expense-form': <ExpenseForm />,
    'contact-form': <ContactForm id={id || undefined} />,
    'contact-detail': <ContactDetail id={id} />,
    'contact-hold': <ContactHoldForm id={id} />,
    help: <HelpContent />,
    alerts: <StockAlerts />,
    search: <SearchDialog />,
    activity: <MovementTable items={state.movements} />,
  };
  if (dialog.kind === 'confirm')
    return (
      <>
        <Callout>{dialog.description}</Callout>
        <div className="form-footer">
          <Button tone="" icon="close" onClick={close}>
            Cancel
          </Button>
          <Button icon="check" onClick={dialog.onConfirm}>
            {dialog.label}
          </Button>
        </div>
      </>
    );
  return contents[dialog.kind] || null;
}
export function DialogHost() {
  const { state, dialog, close } = useWorkspace();
  const ref = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const active = !!dialog;
  useEffect(() => {
    if (!active) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [active]);
  useEffect(() => {
    if (dialog)
      (
        ref.current?.querySelector<HTMLElement>(
          'input:not([disabled]),select:not([disabled]),textarea',
        ) ||
        ref.current?.querySelector<HTMLElement>('button') ||
        ref.current
      )?.focus();
  }, [dialog]);
  if (!dialog) return null;
  const id = 'id' in dialog ? dialog.id || '' : '';
  const titles: Record<Exclude<Dialog['kind'], 'confirm'>, [string, string]> = {
    'product-form': [
      id ? 'Edit product' : 'Add a product',
      'Build your catalog. Receive batches separately to add stock.',
    ],
    'product-detail': ['Product details', A.product(state, id)?.sku || ''],
    'hold-stock': ['Hold stock', 'Promise available stock to a customer until collection.'],
    receive: ['Receive stock', 'Record an incoming batch and its payment source.'],
    'batch-detail': ['Batch details', 'Traceability from receipt to sale.'],
    'recall-form': ['Start recall', 'Block this lot in every warehouse.'],
    'recall-detail': ['Recall details', 'Trace customers and remove recalled stock.'],
    'recall-write-off': ['Write off recalled stock', 'Record removal with a recall reason.'],
    transfer: ['Transfer stock', 'Move a traceable batch between warehouse locations.'],
    'adjust-stock': ['Adjust stock', 'Correct a batch quantity and record its value change.'],
    'write-off-all': ['Write off all', 'Remove the whole batch and record its value change.'],
    'start-count': ['Start count', 'Take a snapshot of stock in a warehouse.'],
    'count-sheet': ['Count sheet', 'Record physical stock in base units.'],
    'count-review': [
      'Review count differences',
      'Check quantity and value differences before posting.',
    ],
    'add-count-lot': ['Add lot to count', 'Include a lot found on the shelf.'],
    'invoice-form': [
      id ? 'Edit draft invoice' : 'Create an invoice',
      'Review, issue, and receive payment in one connected flow.',
    ],
    'invoice-detail': [
      state.invoices.find((i) => i.id === id)?.number || 'Invoice',
      A.contact(state, state.invoices.find((i) => i.id === id)?.customerId || '')?.name || '',
    ],
    'invoice-payment': ['Record a payment', 'Keep your customer balances up to date.'],
    'bill-payment': ['Pay supplier bill', 'Record a payment against the outstanding balance.'],
    'purchase-form': ['New purchase order', 'Plan incoming stock and track its delivery.'],
    'purchase-detail': [
      state.purchases.find((p) => p.id === id)?.number || 'Purchase order',
      'Track delivery and supplier payments.',
    ],
    'purchase-receive': [
      `Receive ${state.purchases.find((p) => p.id === id)?.number || 'purchase order'}`,
      'Confirm the actual lot number and expiry of every product.',
    ],
    'expense-form': ['Record an expense', 'Keep the costs of your operation in the picture.'],
    'contact-form': [
      id ? 'Edit contact' : 'Add a contact',
      'Keep customers and suppliers close at hand.',
    ],
    'contact-detail': [A.contact(state, id)?.name || 'Contact', A.contact(state, id)?.type || ''],
    'contact-hold': [
      A.contact(state, id)?.onHold ? 'Release hold' : 'Put on hold',
      A.contact(state, id)?.name || 'Customer',
    ],
    help: ['Meet your pharmacy workspace', 'One place for a clearer day.'],
    alerts: ['Your stock alerts', 'Keep tomorrow’s operations running smoothly.'],
    search: ['Search workspace', 'Find products, invoices, and contacts.'],
    activity: ['Workspace activity', 'A traceable history of every operation.'],
  };
  const [title, subtitle] = dialog.kind === 'confirm' ? [dialog.title, ''] : titles[dialog.kind];
  const drawer = [
    'product-detail',
    'batch-detail',
    'recall-detail',
    'contact-detail',
    'alerts',
  ].includes(dialog.kind);
  const large = [
    'invoice-form',
    'invoice-detail',
    'purchase-form',
    'purchase-detail',
    'purchase-receive',
    'activity',
    'help',
    'count-sheet',
    'count-review',
  ].includes(dialog.kind);
  return createPortal(
    <div id="overlay-root">
      <div
        className={`overlay ${drawer ? 'drawer-overlay' : ''}`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <section
          ref={ref}
          className={`modal ${drawer ? 'drawer' : ''} ${large ? 'large' : ''} ${dialog.kind === 'search' ? 'search-modal' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
            if (event.key === 'Tab') {
              const items = Array.from(
                ref.current?.querySelectorAll<HTMLElement>(
                  'button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),a[href]',
                ) || [],
              );
              const first = items[0],
                last = items[items.length - 1];
              if (first && event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (last && !event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
        >
          <div className="modal-header">
            <div>
              <h2 id="dialog-title">{title}</h2>
              <p>{subtitle}</p>
            </div>
            <IconButton name="close" label="Close dialog" onClick={close} />
          </div>
          <div className="modal-body">
            <DialogContents key={`${dialog.kind}-${id}`} dialog={dialog} />
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
