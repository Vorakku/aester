import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { compactMoney, date, money, number } from '../lib/format';
import {
  Empty,
  Heading,
  Icon,
  IconButton,
  Metric,
  PanelHeader,
  PeriodControl,
  ProductArt,
  useStockAlerts,
} from '../components/ui';
import { InventoryHealth, RevenuePanel, usePeriodInvoices } from '../components/charts';
import { ExportButton, InvoiceRow, movementIcons } from './Operations';
import { ReservationAlerts } from '../components/reservations';

function AttentionPanel() {
  const { state, open, navigate } = useWorkspace();
  const { low, expiry, recalls, holds, overReserved } = useStockAlerts();
  const [tab, setTab] = useState('low');
  return (
    <section className="panel">
      <PanelHeader
        title="Needs a little attention"
        subtitle="Small actions. Smoother operations."
        action={
          <button
            className="text-button"
            onClick={() =>
              tab === 'reservations'
                ? open('alerts')
                : navigate(tab === 'low' ? 'inventory' : 'batches')
            }
          >
            View all <Icon name="arrow" />
          </button>
        }
      />
      <div className="attention-tabs flex-wrap">
        <button className={tab === 'low' ? 'active' : ''} onClick={() => setTab('low')}>
          Low stock <span className="count-chip">{low.length}</span>
        </button>
        <button className={tab === 'expiry' ? 'active' : ''} onClick={() => setTab('expiry')}>
          Expiring soon <span className="count-chip">{expiry.length}</span>
        </button>
        <button className={tab === 'recalls' ? 'active' : ''} onClick={() => setTab('recalls')}>
          Recalls <span className="count-chip">{recalls.length}</span>
        </button>
        <button
          className={tab === 'reservations' ? 'active' : ''}
          onClick={() => setTab('reservations')}
        >
          Reservations <span className="count-chip">{holds.length + overReserved.length}</span>
        </button>
      </div>
      {tab === 'reservations' ? (
        <ReservationAlerts />
      ) : tab === 'low' ? (
        low.slice(0, 4).map((p) => (
          <div className="attention-item" key={p.id}>
            <ProductArt product={p} />
            <div className="product-info">
              <strong>{p.name}</strong>
              <small>
                {p.sku} · Reorder at {p.reorder} {p.unit}s
              </small>
            </div>
            <div className="attention-amount">
              <strong>
                {number(A.available(state, p.id))} {p.unit}s
              </strong>
              <small>available to sell</small>
            </div>
            <IconButton
              name="chevron"
              label={`View ${p.name}`}
              onClick={() => open('product-detail', p.id)}
            />
          </div>
        ))
      ) : tab === 'recalls' ? (
        recalls.slice(0, 4).map((r) => (
          <div className="attention-item" key={r.id}>
            <Icon name="alert" />
            <div className="product-info">
              <strong>
                {r.number} · {A.product(state, r.productId)?.name}
              </strong>
              <small>
                Lot {r.lotCode} · {A.recallTrace(state, r.id).totals.onHand} units still in stock
              </small>
            </div>
            <IconButton
              name="chevron"
              label={`View recall ${r.number}`}
              onClick={() => open('recall-detail', r.id)}
            />
          </div>
        ))
      ) : (
        expiry.slice(0, 4).map((b) => (
          <div className="attention-item" key={b.id}>
            <ProductArt product={A.product(state, b.productId)} />
            <div className="product-info">
              <strong>{A.product(state, b.productId)?.name}</strong>
              <small>{b.code}</small>
            </div>
            <div className="attention-amount">
              <strong>
                {A.daysLeft(b.expiry) <= 0 ? 'Expired' : `${A.daysLeft(b.expiry)} days left`}
              </strong>
              <small>{date(b.expiry)}</small>
            </div>
            <IconButton
              name="chevron"
              label={`View ${b.code}`}
              onClick={() => open('batch-detail', b.id)}
            />
          </div>
        ))
      )}
      {tab !== 'reservations' &&
        !(tab === 'low' ? low : tab === 'recalls' ? recalls : expiry).length && (
          <Empty
            title="Looking good"
            description="There are no stock alerts right now."
            icon="check"
          />
        )}
    </section>
  );
}
export function DashboardPage() {
  const { state, period, open, navigate } = useWorkspace();
  const { low, expiry } = useStockAlerts();
  const issued = usePeriodInvoices();
  const revenue = A.sum(issued, (i) => i.subtotal - i.discount);
  const previous = A.sum(
    state.invoices.filter(
      (i) =>
        i.status !== 'Draft' && i.date >= A.shift(-period * 2 + 1) && i.date < A.shift(-period + 1),
    ),
    (i) => i.subtotal - i.discount,
  );
  const growth = previous ? A.round(((revenue - previous) / previous) * 100) : 0;
  return (
    <>
      <Heading
        title="Warehouse overview"
        subtitle="A fresh perspective on your pharmacy operations."
        eyebrow="WELCOME BACK, KRISSTOFF"
        actions={
          <>
            <PeriodControl />
            <ExportButton type="overview" label="Export report" small={false} />
          </>
        }
      />
      <div className="overview-strip">
        <span>
          {new Date().toLocaleDateString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </span>
        <span className="status-label">
          <i className="status-dot" />
          All systems operational
        </span>
      </div>
      <div className="metrics">
        <Metric
          label="Total inventory value"
          value={compactMoney(A.inventoryValue(state))}
          icon="box"
          foot={`Across ${state.warehouses.length} warehouses`}
          trend={`${number(state.products.length)} SKUs`}
        />
        <Metric
          label="Sales revenue"
          value={compactMoney(revenue)}
          icon="trend"
          foot={`vs. previous ${period} days`}
          trend={`${growth > 0 ? '+' : ''}${growth}%`}
          tone={growth < 0 ? 'red' : ''}
        />
        <Metric
          label="Low-stock products"
          value={String(low.length).padStart(2, '0')}
          icon="alert"
          foot="Products below reorder level"
          trend="Replenish"
          tone="amber"
        />
        <Metric
          label="Expiry alerts"
          value={String(expiry.length).padStart(2, '0')}
          icon="clock"
          foot={`Within ${state.settings.expiryWindow} days`}
          trend={`${expiry.filter((b) => A.daysLeft(b.expiry) <= 0).length} expired`}
          tone="amber"
        />
      </div>
      <div className="dashboard-top">
        <RevenuePanel />
        <InventoryHealth />
      </div>
      <div className="dashboard-bottom">
        <AttentionPanel />
        <section className="panel">
          <PanelHeader
            title="Recent activity"
            subtitle="The latest around your warehouse."
            action={<span className="badge gray">Live workspace</span>}
          />
          <div className="activity">
            {state.movements.slice(0, 4).map((m) => (
              <div className="activity-item" key={m.id}>
                <span
                  className={`activity-icon ${m.type === 'sale' ? 'blue' : m.type === 'adjust' ? 'amber' : ''}`}
                >
                  <Icon name={movementIcons[m.type] || 'box'} />
                </span>
                <strong>{m.title}</strong>
                <p>{m.description}</p>
                <time>{m.date === A.today() ? 'Today' : date(m.date)}</time>
              </div>
            ))}
            {!state.movements.length && (
              <Empty title="No activity yet" description="Your operations will appear here." />
            )}
          </div>
          <div className="panel-bottom">
            <button onClick={() => open('activity')}>
              View activity log <Icon name="arrow" />
            </button>
          </div>
        </section>
      </div>
      <section className="panel dashboard-invoices">
        <PanelHeader
          title="Recent invoices"
          subtitle="From your shelves to their customers."
          action={
            <button className="text-button" onClick={() => navigate('invoices')}>
              View invoices <Icon name="arrow" />
            </button>
          }
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {['Invoice', 'Customer', 'Issue date', 'Amount', 'Status', 'Due date', ''].map(
                  (t, index) => (
                    <th key={index}>{t}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {[...state.invoices]
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, 4)
                .map((i) => (
                  <InvoiceRow key={i.id} invoice={i} />
                ))}
              {!state.invoices.length && (
                <tr>
                  <td colSpan={7}>
                    <Empty
                      title="No invoices yet"
                      description="Create your first invoice to get started."
                      icon="invoice"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
export function AnalyticsPage() {
  const { state, open } = useWorkspace();
  const invoices = usePeriodInvoices();
  const revenue = A.sum(invoices, (i) => i.subtotal - i.discount),
    cost = A.sum(invoices, (i) => i.cogs || 0),
    units = A.sum(invoices, (i) => A.sum(i.lines, (l) => l.qty));
  const ranking: Record<string, { qty: number; revenue: number }> = {};
  invoices.forEach((i) =>
    i.lines.forEach((l) => {
      const factor = (i.subtotal - i.discount) / (i.subtotal || 1);
      ranking[l.productId] ||= { qty: 0, revenue: 0 };
      ranking[l.productId].qty += l.qty;
      ranking[l.productId].revenue += l.qty * l.price * factor;
    }),
  );
  const best = Object.entries(ranking)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 6);
  const categories = A.categories
    .map((name) => ({
      name,
      value: A.sum(
        Object.entries(ranking).filter(([id]) => A.product(state, id)?.category === name),
        ([, x]) => x.revenue,
      ),
    }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);
  const topCategory = Math.max(1, ...categories.map((c) => c.value));
  const customers = state.contacts
    .filter((c) => c.type === 'Customer')
    .map((c) => {
      const items = invoices.filter((i) => i.customerId === c.id);
      return { c, count: items.length, revenue: A.sum(items, (i) => i.subtotal - i.discount) };
    })
    .sort((a, b) => b.revenue - a.revenue);
  return (
    <>
      <Heading
        title="Business analytics"
        subtitle="Turn everyday operations into better decisions."
        actions={
          <>
            <PeriodControl />
            <ExportButton type="analysis" label="Export analysis" small={false} />
          </>
        }
      />
      <div className="metrics">
        <Metric
          label="Net sales"
          value={compactMoney(revenue)}
          icon="trend"
          foot={`${invoices.length} issued invoices`}
        />
        <Metric
          label="Gross profit"
          value={compactMoney(revenue - cost)}
          icon="wallet"
          foot="Revenue less actual batch cost"
        />
        <Metric
          label="Average order value"
          value={money(invoices.length ? revenue / invoices.length : 0)}
          icon="invoice"
          foot="Based on issued invoices"
        />
        <Metric
          label="Units sold"
          value={number(units)}
          icon="box"
          foot="Across all product categories"
        />
      </div>
      <div className="analytics-grid">
        <RevenuePanel />
        <section className="panel">
          <PanelHeader
            title="Sales by category"
            subtitle="Net revenue, allocated after discounts."
          />
          <div className="panel-body">
            {categories.map((c) => (
              <div className="bar-row" key={c.name}>
                <span>{c.name}</span>
                <div className="progress-track">
                  <span style={{ width: `${(c.value / topCategory) * 100}%` }} />
                </div>
                <strong>{compactMoney(c.value)}</strong>
              </div>
            ))}
            {!categories.length && (
              <Empty
                title="No sales this period"
                description="Issue an invoice to start seeing insights."
                icon="chart"
              />
            )}
          </div>
          <div className="analysis-insight">
            <Icon name="spark" />{' '}
            {categories[0]
              ? `${categories[0].name} leads sales this period.`
              : 'Your next insight starts with a sale.'}
          </div>
        </section>
      </div>
      <div className="analytics-grid">
        <section className="panel">
          <PanelHeader title="Best-selling products" subtitle="Ranked by net sales revenue." />
          <div className="table-wrap mt-[18px]">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Units sold</th>
                  <th>Net sales</th>
                </tr>
              </thead>
              <tbody>
                {best.map(([id, value]) => {
                  const p = A.product(state, id);
                  return (
                    <tr key={id}>
                      <td>
                        <button
                          className="table-product text-left p-0"
                          onClick={() => open('product-detail', id)}
                        >
                          <ProductArt product={p} />
                          <div>
                            <strong>{p?.name}</strong>
                            <small>{p?.category}</small>
                          </div>
                        </button>
                      </td>
                      <td>{number(value.qty)}</td>
                      <td>
                        <strong>{money(value.revenue)}</strong>
                      </td>
                    </tr>
                  );
                })}
                {!best.length && (
                  <tr>
                    <td colSpan={3}>
                      <Empty
                        title="No product sales"
                        description="Try a different reporting period."
                        icon="chart"
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <PanelHeader
            title="Customer contribution"
            subtitle="Your most active business relationships."
          />
          <div className="panel-body">
            {customers.map((x) => (
              <div className="attention-item !px-0" key={x.c.id}>
                <span className="contact-initials">
                  {x.c.name
                    .split(' ')
                    .slice(0, 2)
                    .map((word) => word[0])
                    .join('')}
                </span>
                <div className="product-info">
                  <strong>{x.c.name}</strong>
                  <small>{x.count} invoices this period</small>
                </div>
                <strong className="text-[11px] text-[#617a5b] font-[550]">
                  {compactMoney(x.revenue)}
                </strong>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
