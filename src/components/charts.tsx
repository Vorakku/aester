import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { compactMoney, money, number, shortDate } from '../lib/format';
import { Icon, PanelHeader } from './ui';

export function usePeriodInvoices() {
  const { state, period } = useWorkspace();
  return state.invoices.filter(
    (i) => i.status !== 'Draft' && i.date >= A.shift(-period + 1) && i.date <= A.today(),
  );
}
export function usePeriodCredits() {
  const { state, period } = useWorkspace();
  return state.creditNotes.filter(
    (cn) => cn.status === 'Issued' && cn.date >= A.shift(-period + 1) && cn.date <= A.today(),
  );
}
export function RevenuePanel() {
  const { state, period } = useWorkspace();
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const invoices = usePeriodInvoices();
  const credits = usePeriodCredits();
  const revenue = A.netSales(state, A.shift(-period + 1));
  const cogs = A.round(
    A.sum(invoices, (i) => A.invoiceCost(state, i)) - A.sum(credits, (cn) => cn.returnCost),
  );
  const from = A.shift(-period + 1);
  const count =
    mode === 'week'
      ? Math.ceil(period / 7)
      : period <= 30
        ? 6
        : Math.min(12, Math.ceil(period / 30));
  const data = Array.from({ length: count }, (_, index) => {
    const begin = A.shift(Math.floor((index * period) / count), from);
    const last = A.shift(Math.floor(((index + 1) * period) / count) - 1, from);
    const items = invoices.filter((i) => i.date >= begin && i.date <= last);
    return {
      label: shortDate(begin),
      sales: A.netSales(state, begin, last),
      cost: A.round(
        A.sum(items, (i) => A.invoiceCost(state, i)) -
          A.sum(
            credits.filter((cn) => cn.date >= begin && cn.date <= last),
            (cn) => cn.returnCost,
          ),
      ),
    };
  });
  const w = 650,
    h = 195,
    left = 45,
    right = 18,
    top = 16,
    bottom = 28;
  const max = Math.max(1, ...data.map((d) => Math.max(d.sales, d.cost))) * 1.25;
  const x = (index: number) => left + (index * (w - left - right)) / Math.max(data.length - 1, 1);
  const y = (value: number) => top + (1 - value / max) * (h - top - bottom);
  const points = data.map((d, index) => `${x(index)},${y(d.sales)}`).join(' ');
  const costs = data.map((d, index) => `${x(index)},${y(d.cost)}`).join(' ');
  return (
    <section className="panel">
      <PanelHeader
        title="Revenue overview"
        subtitle="A healthy business starts with a clear view."
        action={
          <div className="segmented">
            {(['month', 'week'] as const).map((value) => (
              <button
                key={value}
                className={mode === value ? 'active' : ''}
                onClick={() => setMode(value)}
              >
                {value === 'month' ? 'Monthly' : 'Weekly'}
              </button>
            ))}
          </div>
        }
      />
      <div className="panel-body">
        <div className="chart-summary">
          <strong>{compactMoney(revenue)}</strong>
          <span>in the last {period} days</span>
        </div>
        <div className="legend">
          <span>
            <i className="legend-dot" />
            Revenue
          </span>
          <span>
            <i className="legend-dot gray" />
            Cost of goods
          </span>
        </div>
        <svg
          className="line-chart"
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          aria-label="Revenue and cost of goods chart"
          role="img"
        >
          <defs>
            <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#77aa8b" stopOpacity=".17" />
              <stop offset="1" stopColor="#77aa8b" stopOpacity=".015" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((n) => (
            <g key={n}>
              <line
                x1={left}
                y1={y(n * max)}
                x2={w - right}
                y2={y(n * max)}
                stroke="#eef2ec"
                strokeDasharray="3 4"
              />
              <text x={left - 9} y={y(n * max) + 3} textAnchor="end">
                {n * max >= 1000 ? `$${((n * max) / 1000).toFixed(1)}k` : `$${Math.round(n * max)}`}
              </text>
            </g>
          ))}
          <path
            d={`M${x(0)} ${h - bottom} L${points.split(' ').join(' L')} L${x(data.length - 1)} ${h - bottom} Z`}
            fill="url(#revenueFill)"
          />
          <polyline
            points={costs}
            fill="none"
            stroke="#c7d9c9"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <polyline points={points} className="chart-line" />
          {data.map((d, index) => (
            <g key={index}>
              <circle
                cx={x(index)}
                cy={y(d.sales)}
                r="3.4"
                fill="white"
                stroke="#438f6b"
                strokeWidth="1.5"
              />
              <circle cx={x(index)} cy={y(d.sales)} r="14" fill="transparent">
                <title>
                  {d.label} · Sales: {money(d.sales)} · Cost: {money(d.cost)}
                </title>
              </circle>
              {index % Math.ceil(data.length / 12) === 0 && (
                <text x={x(index)} y={h - 7} textAnchor="middle">
                  {d.label}
                </text>
              )}
            </g>
          ))}
        </svg>
        <div className="chart-footer">
          <span>{invoices.length} issued invoices in this period</span>
          <strong>
            {revenue ? Math.round(((revenue - cogs) / revenue) * 100) : 0}% gross margin{' '}
            <Icon name="trend" />
          </strong>
        </div>
      </div>
    </section>
  );
}
export function InventoryHealth() {
  const { state, navigate } = useWorkspace();
  const normal = state.products.filter((p) => A.productStatus(state, p) === 'In stock').length;
  const low = state.products.filter((p) => A.productStatus(state, p) === 'Low stock').length;
  const values = [normal, low, state.products.length - normal - low];
  const colors = ['#458b68', '#dcc68b', '#db9b8d'];
  const total = state.products.length || 1;
  return (
    <section className="panel">
      <PanelHeader
        title="Inventory health"
        subtitle="A snapshot of your catalog."
        action={
          <button className="text-button" onClick={() => navigate('inventory')}>
            View all <Icon name="arrow" />
          </button>
        }
      />
      <div className="panel-body">
        <div className="health-donut">
          <svg
            viewBox="0 0 180 180"
            role="img"
            aria-label={`${normal} in stock, ${low} low stock, ${values[2]} out of stock`}
          >
            <circle cx="90" cy="90" r="64" fill="none" stroke="#f0f4ed" strokeWidth="15" />
            {values.map((value, index) => (
              <circle
                key={index}
                cx="90"
                cy="90"
                r="64"
                fill="none"
                stroke={colors[index]}
                strokeWidth="15"
                strokeDasharray={`${Math.max(0, (value / total) * 402.12 - (value ? 5 : 0))} 402.12`}
                strokeDashoffset={
                  -values.slice(0, index).reduce((sum, v) => sum + (v / total) * 402.12, 0)
                }
                strokeLinecap="round"
              />
            ))}
          </svg>
          <div className="donut-content">
            <strong>{number(state.products.length)}</strong>
            <span>total products</span>
          </div>
        </div>
        <div className="health-list">
          {['In stock', 'Low stock', 'Out of stock'].map((label, index) => (
            <div className="health-row" key={label}>
              <span>
                <i style={{ background: colors[index] }} />
                {label}
              </span>
              <strong>
                {values[index]}{' '}
                <span className="muted inline ml-[7px] text-[9px]">
                  {Math.round((values[index] / total) * 100)}%
                </span>
              </strong>
            </div>
          ))}
          <div className="health-note">
            <Icon name="leaf" />
            {Math.round((normal / total) * 100)}% of your products are well stocked.
          </div>
        </div>
      </div>
    </section>
  );
}
