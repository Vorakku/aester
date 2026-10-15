import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useState,
  useEffect,
} from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Box,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  Ellipsis,
  Eye,
  FileText,
  Grid2X2,
  Layers,
  Leaf,
  LockKeyhole,
  Menu,
  PackageCheck,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Trash2,
  TriangleAlert,
  Truck,
  Upload,
  Users,
  Wallet,
  X,
  ArrowLeftRight,
} from 'lucide-react';
import { A } from '../lib/model';
import { useWorkspace } from '../context/WorkspaceContext';
import type { Product } from '../types';

const icons = {
  grid: Grid2X2,
  chart: ChartNoAxesCombined,
  box: Box,
  layers: Layers,
  warehouse: Building2,
  cart: ShoppingCart,
  invoice: FileText,
  wallet: Wallet,
  users: Users,
  settings: Settings,
  down: ArrowDown,
  arrow: ArrowRight,
  trend: ArrowUpRight,
  bell: Bell,
  help: CircleHelp,
  more: Ellipsis,
  menu: Menu,
  chevron: ChevronRight,
  left: ChevronLeft,
  calendar: CalendarDays,
  check: Check,
  clock: Clock3,
  alert: TriangleAlert,
  leaf: Leaf,
  shield: ShieldCheck,
  lock: LockKeyhole,
  search: Search,
  plus: Plus,
  receive: PackageCheck,
  transfer: ArrowLeftRight,
  edit: Pencil,
  eye: Eye,
  download: Download,
  upload: Upload,
  close: X,
  trash: Trash2,
  print: Printer,
  refresh: RefreshCw,
  bank: Building2,
  file: FileText,
  spark: Sparkles,
  truck: Truck,
};
export type IconName = keyof typeof icons;
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const Component = icons[name];
  return <Component className={`icon ${className}`} aria-hidden="true" strokeWidth={1.65} />;
}
export function Mark() {
  return (
    <svg viewBox="0 0 40 40" fill="currentColor" aria-hidden="true">
      <path d="M17 2h6v10l7-7 4 4-7 8h11v6H27l7 7-4 4-7-7v11h-6V27l-8 7-4-4 7-7H2v-6h10L5 9l4-4 8 7V2Z" />
    </svg>
  );
}
export function ProductArt({ product }: { product?: Product }) {
  const c = product && /^#[0-9a-f]{6}$/i.test(product.color) ? product.color : '#80a58c';
  return (
    <span className="product-art">
      <svg viewBox="0 0 38 45" aria-hidden="true">
        {product?.shape === 'bottle' ? (
          <>
            <rect x="11" y="4" width="14" height="5" rx="1.5" fill={c} />
            <rect x="9" y="9" width="18" height="30" rx="4" fill="#fff" stroke="#e3e9df" />
            <rect x="9" y="17" width="18" height="12" fill={c} opacity=".9" />
            <path d="M15 21h6m-3-3v6" stroke="white" strokeWidth="1.7" />
            <path d="M13 33h10M13 35h7" stroke="#d5dfd0" strokeWidth="1.2" />
          </>
        ) : product?.shape === 'tube' ? (
          <>
            <path d="M10 5h17l-3 30H13L10 5Z" fill="white" stroke="#e3e9df" />
            <path d="M11 12h15l-1 13H12l-1-13Z" fill={c} />
            <path d="M15 18h7m-3.5-3v6" stroke="white" strokeWidth="1.5" />
            <rect x="13" y="35" width="11" height="5" rx="1" fill={c} />
          </>
        ) : product?.shape === 'device' ? (
          <>
            <rect x="6" y="9" width="25" height="26" rx="5" fill="white" stroke="#dce5d8" />
            <rect x="10" y="13" width="17" height="11" rx="2" fill={c} opacity=".3" />
            <path d="m11 19 3-1 2 3 3-6 3 4h4" fill="none" stroke={c} strokeWidth="1.4" />
            <circle cx="19" cy="29" r="2" fill={c} />
          </>
        ) : (
          <>
            <path d="M7 6h21l3 3v30H7V6Z" fill="white" stroke="#dfe7dc" />
            <path d="m28 6 3 3v30h-3V6Z" fill={c} opacity=".6" />
            <path d="M7 6h21v10H7z" fill={c} />
            <path d="M11 10h8" stroke="white" strokeWidth="1.2" opacity=".8" />
            <path d="M14 23h8m-4-4v8" stroke={c} strokeWidth="2" />
            <path d="M11 32h13M11 35h9" stroke="#d6e2cf" strokeWidth="1.1" />
          </>
        )}
      </svg>
    </span>
  );
}
export function Button({
  children,
  icon = 'plus',
  tone = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; tone?: string }) {
  return (
    <button type="button" className={`btn ${tone} ${className}`} {...props}>
      <Icon name={icon} />
      {children}
    </button>
  );
}
export function IconButton({
  name,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { name: IconName; label: string }) {
  return (
    <button type="button" className="icon-button" aria-label={label} {...props}>
      <Icon name={name} />
    </button>
  );
}
export function StockQuantity({ product, qty }: { product?: Product; qty: number }) {
  const formatted = product ? A.formatQty(product, qty) : { main: String(qty) };
  return (
    <span className="inline-block">
      <span className="block">{formatted.main}</span>
      {formatted.packs && (
        <small className="muted block text-[9px] font-normal mt-[5px]">{formatted.packs}</small>
      )}
    </span>
  );
}
export function Badge({ status }: { status: string }) {
  const tone = [
    'Paid',
    'OK',
    'In stock',
    'Active',
    'Received',
    'Balanced',
    'opening',
    'receipt',
    'transfer_in',
    'Posted',
    'Closed',
    'Fulfilled',
  ].includes(status)
    ? ''
    : [
          'Low stock',
          'Expiring soon',
          'Short-dated',
          'Partial',
          'Ordered',
          'Unpaid',
          'Due',
          'Open',
          'No reg.',
        ].includes(status)
      ? 'amber'
      : [
            'Out of stock',
            'Expired',
            'Overdue',
            'On hold',
            'Over limit',
            'Below cost',
            'Recalled',
            'Over-reserved',
            'sale',
            'transfer_out',
            'adjustment',
          ].includes(status)
        ? 'red'
        : ['Quarantined', 'Rx', 'Cold', '❄ Cold', 'Reserved', 'Released'].includes(status)
          ? 'blue'
          : status === 'CD'
            ? 'red'
            : 'gray';
  return <span className={`badge ${tone}`}>{status}</span>;
}
export function ProductBadges({ product: p }: { product: Product }) {
  return (
    <span className="flex flex-wrap gap-[4px] mt-[5px]">
      {p.rx && <Badge status="Rx" />}
      {p.controlled && <Badge status="CD" />}
      {p.storage === 'cold' && <Badge status="❄ Cold" />}
      {!p.active && <Badge status="Inactive" />}
      {A.missingRegistration(p) && <Badge status="No reg." />}
    </span>
  );
}
export function Heading({
  title,
  subtitle,
  actions,
  eyebrow = 'Your pharmacy, connected',
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <section className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </section>
  );
}
export function Metric({
  label,
  value,
  icon,
  foot,
  trend,
  tone = '',
}: {
  label: string;
  value: ReactNode;
  icon: IconName;
  foot: string;
  trend?: string;
  tone?: string;
}) {
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon name={icon} />
        </span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot">
        {trend && (
          <span className={`metric-trend ${tone}`}>
            <Icon name={tone === 'red' ? 'down' : 'trend'} />
            {trend}
          </span>
        )}
        <span>{foot}</span>
      </div>
    </div>
  );
}
export function PanelHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-header">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function Empty({
  title = 'No results found',
  description = 'Try changing your search or filters.',
  icon = 'box',
}: {
  title?: string;
  description?: string;
  icon?: IconName;
}) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
export function PeriodControl() {
  const { period, setPeriod } = useWorkspace();
  return (
    <div className="date-control">
      <Icon name="calendar" />
      <select
        value={period}
        onChange={(event) => setPeriod(Number(event.target.value))}
        aria-label="Reporting period"
      >
        {[
          [30, 'Last 30 days'],
          [90, 'Last 90 days'],
          [180, 'Last 6 months'],
          [365, 'Last 12 months'],
        ].map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search-input">
      <Icon name="search" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}
export function Filter({
  label,
  value,
  onChange,
  items,
  placeholder = 'All statuses',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: (string | { id: string; name: string })[];
  placeholder?: string;
}) {
  return (
    <select
      className="filter-select"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
    >
      <option value="">{placeholder}</option>
      {items.map((item) =>
        typeof item === 'string' ? (
          <option key={item}>{item}</option>
        ) : (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ),
      )}
    </select>
  );
}
export function DataTable<T>({
  items,
  columns,
  row,
  filterKey = '',
  pageSize = 8,
}: {
  items: T[];
  columns: ReactNode[];
  row: (item: T, index: number) => ReactNode;
  filterKey?: string;
  pageSize?: number;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [filterKey]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={index} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.slice((current - 1) * pageSize, current * pageSize).map(row)
            ) : (
              <tr>
                <td colSpan={columns.length}>
                  <Empty />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="table-footer">
        <span>
          {items.length
            ? `${(current - 1) * pageSize + 1}–${Math.min(current * pageSize, items.length)} of ${items.length} records`
            : '0 records'}
        </span>
        <div className="pagination">
          <button
            aria-label="Previous page"
            disabled={current === 1}
            onClick={() => setPage(current - 1)}
          >
            <Icon name="left" />
          </button>
          {Array.from({ length: pages }, (_, index) => index + 1)
            .filter((index) => Math.abs(index - current) <= 2 || index === 1 || index === pages)
            .map((index) => (
              <button
                key={index}
                className={index === current ? 'active' : ''}
                aria-current={index === current ? 'page' : undefined}
                onClick={() => setPage(index)}
              >
                {index}
              </button>
            ))}
          <button
            aria-label="Next page"
            disabled={current === pages}
            onClick={() => setPage(current + 1)}
          >
            <Icon name="chevron" />
          </button>
        </div>
      </div>
    </>
  );
}
export function Field({
  label,
  name,
  full = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; name: string; full?: boolean }) {
  return (
    <div className={`form-field ${full ? 'full' : ''}`}>
      <label htmlFor={`f-${name}`}>
        {label}
        {props.required && <span className="text-[#afc69e]"> *</span>}
      </label>
      <input id={`f-${name}`} name={name} {...props} />
    </div>
  );
}
export function SelectField({
  label,
  name,
  children,
  defaultValue,
  full = false,
  required = true,
  onChange,
  disabled = false,
}: {
  label: string;
  name: string;
  children: ReactNode;
  defaultValue?: string;
  full?: boolean;
  required?: boolean;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`form-field ${full ? 'full' : ''}`}>
      <label htmlFor={`f-${name}`}>
        {label}
        {required && <span className="text-[#afc69e]"> *</span>}
      </label>
      <select
        name={name}
        id={`f-${name}`}
        defaultValue={defaultValue}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {children}
      </select>
    </div>
  );
}
export function ContactOptions({
  type,
  placeholder = `Select ${type.toLowerCase()}`,
}: {
  type: 'Customer' | 'Supplier';
  placeholder?: string;
}) {
  const { state } = useWorkspace();
  return (
    <>
      <option value="">{placeholder}</option>
      {state.contacts
        .filter((contact) => contact.type === type)
        .map((contact) => (
          <option key={contact.id} value={contact.id}>
            {contact.name}
          </option>
        ))}
    </>
  );
}
export function WarehouseOptions({
  placeholder = 'Select warehouse',
  coldOnly = false,
  includeId,
}: {
  placeholder?: string;
  coldOnly?: boolean;
  includeId?: string;
}) {
  const { state } = useWorkspace();
  return (
    <>
      <option value="">{placeholder}</option>
      {state.warehouses
        .filter((w) => !coldOnly || w.storage === 'cold' || w.id === includeId)
        .map((warehouse) => (
          <option key={warehouse.id} value={warehouse.id}>
            {warehouse.name}
          </option>
        ))}
    </>
  );
}
export function Callout({ children }: { children: ReactNode }) {
  return <div className="info-callout">{children}</div>;
}
export function FormFooter({ label = 'Save', children }: { label?: string; children?: ReactNode }) {
  const { close } = useWorkspace();
  return (
    <div className="form-footer">
      {children}
      <Button tone="" icon="close" onClick={close}>
        Cancel
      </Button>
      <Button type="submit" icon="check">
        {label}
      </Button>
    </div>
  );
}
export function Summary({ items }: { items: [string, ReactNode][] }) {
  return (
    <ul className="summary-list">
      {items.map(([label, value]) => (
        <li key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </li>
      ))}
    </ul>
  );
}
export function useStockAlerts() {
  const { state } = useWorkspace();
  return {
    holds: state.reservations.filter(
      (r) => r.source === 'hold' && A.reservationStatus(r) === 'Active' && r.expires! <= A.shift(1),
    ),
    overReserved: state.products.filter((p) => A.free(state, p.id) < 0),
    recalls: state.recalls.filter(
      (r) => r.status === 'Open' && A.recallTrace(state, r.id).totals.onHand > 0,
    ),
    low: state.products
      .filter((product) => A.available(state, product.id) <= product.reorder)
      .sort((a, b) => A.available(state, a.id) - A.available(state, b.id)),
    expiry: state.batches
      .filter((batch) => batch.qty > 0 && A.daysLeft(batch.expiry) <= state.settings.expiryWindow)
      .sort((a, b) => a.expiry.localeCompare(b.expiry)),
  };
}
