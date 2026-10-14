import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { A } from '../lib/model';
import { errorMessage } from '../lib/format';
import type { InvoiceInitial, Page, PurchaseInitial, Workspace } from '../types';

export const pageNames: Record<Page, string> = {
  dashboard: 'Overview',
  inventory: 'Inventory',
  batches: 'Batches & expiry',
  warehouses: 'Warehouses',
  purchasing: 'Purchasing',
  invoices: 'Invoices',
  accounting: 'Accounting',
  analytics: 'Analytics',
  contacts: 'Contacts',
  settings: 'Settings',
};
export const isPage = (value: string): value is Page => Object.hasOwn(pageNames, value);
export type DialogKind =
  | 'product-form'
  | 'product-detail'
  | 'hold-stock'
  | 'receive'
  | 'batch-detail'
  | 'recall-form'
  | 'recall-detail'
  | 'recall-write-off'
  | 'transfer'
  | 'adjust-stock'
  | 'write-off-all'
  | 'start-count'
  | 'count-sheet'
  | 'count-review'
  | 'add-count-lot'
  | 'invoice-form'
  | 'invoice-detail'
  | 'invoice-payment'
  | 'bill-payment'
  | 'purchase-form'
  | 'purchase-detail'
  | 'purchase-receive'
  | 'expense-form'
  | 'contact-form'
  | 'contact-detail'
  | 'help'
  | 'alerts'
  | 'search'
  | 'activity';
export type Dialog =
  | { kind: DialogKind; id?: string; initial?: PurchaseInitial | InvoiceInitial }
  | { kind: 'confirm'; title: string; description: string; label: string; onConfirm: () => void };
interface Toast {
  id: number;
  message: string;
  error: boolean;
}
interface Context {
  state: Workspace;
  recoveryData: string | null;
  page: Page;
  period: number;
  setPeriod: (value: number) => void;
  dialog: Dialog | null;
  open: (kind: DialogKind, id?: string, initial?: PurchaseInitial | InvoiceInitial) => void;
  close: () => void;
  navigate: (page: Page, warehouse?: string, productId?: string) => void;
  ledgerProductFilter: string;
  setLedgerProductFilter: (value: string) => void;
  warehouseTab: 'ledger' | 'adjustments' | 'counts';
  setWarehouseTab: (value: 'ledger' | 'adjustments' | 'counts') => void;
  warehouseFilter: string;
  setWarehouseFilter: (value: string) => void;
  mutate: <T>(
    operation: (state: Workspace) => T,
    message: string,
    after?: (value: T) => void,
    keepDialog?: boolean,
  ) => T;
  replace: (state: Workspace, message: string) => void;
  confirm: (title: string, description: string, operation: () => void, label?: string) => void;
  toast: (message: string, error?: boolean) => void;
  toasts: Toast[];
}
const WorkspaceContext = createContext<Context | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Workspace>(A.load);
  const [recoveryData] = useState(() => localStorage.getItem(A.RECOVERY_KEY));
  const stateRef = useRef(state);
  const [page, setPage] = useState<Page>(() =>
    isPage(location.hash.slice(1)) ? (location.hash.slice(1) as Page) : 'dashboard',
  );
  const [period, setPeriod] = useState(30);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [warehouseFilter, setWarehouseFilter] = useState('');
  const [ledgerProductFilter, setLedgerProductFilter] = useState('');
  const [warehouseTab, setWarehouseTab] = useState<'ledger' | 'adjustments' | 'counts'>('ledger');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toast = useCallback((message: string, error = false) => {
    const id = ++toastId.current;
    setToasts((list) => [...list, { id, message, error }]);
    timers.current.push(
      setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 4500),
    );
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const change = () => {
      const hash = location.hash.slice(1);
      if (isPage(hash)) {
        setPage(hash);
        setDialog(null);
      }
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    document.title = `${pageNames[page]} — Aster Pharmacy`;
  }, [page]);
  const open = useCallback(
    (kind: DialogKind, id?: string, initial?: PurchaseInitial | InvoiceInitial) =>
      setDialog({ kind, id, initial }),
    [],
  );
  const close = useCallback(() => setDialog(null), []);
  const navigate = (next: Page, warehouse?: string, productId?: string) => {
    setDialog(null);
    setPage(next);
    location.hash = next;
    if (warehouse !== undefined) setWarehouseFilter(warehouse);
    if (next === 'warehouses') {
      setLedgerProductFilter(productId || '');
      setWarehouseTab('ledger');
    }
    window.scrollTo(0, 0);
  };
  const replace = (next: Workspace, message: string, keepDialog = false) => {
    A.persist(next);
    stateRef.current = next;
    setState(next);
    if (!keepDialog) close();
    toast(message);
  };
  function mutate<T>(
    operation: (state: Workspace) => T,
    message: string,
    after?: (value: T) => void,
    keepDialog = false,
  ): T {
    const result = A.transact(stateRef.current, operation);
    replace(result.state, message, keepDialog);
    after?.(result.value);
    return result.value;
  }
  const confirm = (title: string, description: string, operation: () => void, label = 'Confirm') =>
    setDialog({
      kind: 'confirm',
      title,
      description,
      label,
      onConfirm: () => {
        try {
          operation();
        } catch (error) {
          toast(errorMessage(error), true);
        }
      },
    });
  return (
    <WorkspaceContext.Provider
      value={{
        state,
        recoveryData,
        page,
        period,
        setPeriod,
        dialog,
        open,
        close,
        navigate,
        warehouseFilter,
        setWarehouseFilter,
        ledgerProductFilter,
        setLedgerProductFilter,
        warehouseTab,
        setWarehouseTab,
        mutate,
        replace,
        confirm,
        toast,
        toasts,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('WorkspaceProvider is missing.');
  return context;
}
