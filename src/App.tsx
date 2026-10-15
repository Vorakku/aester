import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pageNames, useWorkspace, WorkspaceProvider } from './context/WorkspaceContext';
import {
  Button,
  Callout,
  Icon,
  IconButton,
  Mark,
  useStockAlerts,
  type IconName,
} from './components/ui';
import { DialogHost } from './components/Dialogs';
import { AccountingPage } from './pages/Accounting';
import { AnalyticsPage, DashboardPage } from './pages/Dashboard';
import {
  BatchesPage,
  ContactsPage,
  InventoryPage,
  InvoicesPage,
  PurchasingPage,
  WarehousesPage,
} from './pages/Operations';
import { SettingsPage } from './pages/Settings';
import { PricingPage } from './pages/Pricing';
import type { Page } from './types';
import { A } from './lib/model';
import { download } from './lib/format';

function WorkspaceApp() {
  const { state, recoveryData, page, navigate, dialog, open, close, toasts } = useWorkspace();
  const { expiry, low, recalls, holds, overReserved } = useStockAlerts();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [page]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open('search');
      }
      if (event.key === 'Escape') {
        close();
        setMenu(false);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [open, close]);
  const nav = (target: Page, icon: IconName, count?: number) => (
    <button
      key={target}
      className={`nav-item ${page === target ? 'active' : ''}`}
      aria-current={page === target ? 'page' : undefined}
      onClick={() => {
        navigate(target);
        setMenu(false);
      }}
    >
      <Icon name={icon} />
      {pageNames[target]}
      {count !== undefined && <span className="nav-badge">{count}</span>}
    </button>
  );
  const views: Record<Page, ReactNode> = {
    dashboard: <DashboardPage />,
    analytics: <AnalyticsPage />,
    inventory: <InventoryPage />,
    batches: <BatchesPage />,
    warehouses: <WarehousesPage />,
    purchasing: <PurchasingPage />,
    invoices: <InvoicesPage />,
    pricing: <PricingPage />,
    accounting: <AccountingPage />,
    contacts: <ContactsPage />,
    settings: <SettingsPage />,
  };
  return (
    <>
      <div inert={dialog ? true : undefined}>
        <aside
          className={`sidebar ${menu ? 'open' : ''}`}
          id="sidebar"
          aria-label="Main navigation"
        >
          <a
            className="brand"
            href="#dashboard"
            aria-label="Aster home"
            onClick={() => setMenu(false)}
          >
            <span className="brand-mark">
              <Mark />
            </span>
            aster<em>®</em>
          </a>
          <button className="workspace-switch" onClick={() => navigate('settings')}>
            <span className="avatar">AP</span>
            <span>
              <strong>{state.settings.company}</strong>
              <small>Pharmacy workspace</small>
            </span>
            <Icon name="down" />
          </button>
          <nav>
            <div className="nav-label">WORKSPACE</div>
            {nav('dashboard', 'grid')}
            {nav('analytics', 'chart')}
            <div className="nav-label">OPERATIONS</div>
            {nav('inventory', 'box')}
            {nav('batches', 'layers', expiry.length)}
            {nav('warehouses', 'warehouse')}
            {nav('purchasing', 'cart', A.reorderSuggestions(state).length)}
            <div className="nav-label">SALES</div>
            {nav('invoices', 'invoice')}
            {nav('pricing', 'invoice')}
            <div className="nav-label">FINANCE & PEOPLE</div>
            {nav('accounting', 'wallet')}
            {nav('contacts', 'users')}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <Icon name="shield" />
              <strong>A little peace of mind</strong>
              <p>
                Stock, sales, and accounts.
                <br />
                Always in the same picture.
              </p>
            </div>
            <button
              className={`nav-item ${page === 'settings' ? 'active' : ''}`}
              onClick={() => navigate('settings')}
            >
              <Icon name="settings" />
              Workspace settings
            </button>
            <div className="profile">
              <span className="avatar">KS</span>
              <span>
                <strong>Krisstoff</strong>
                <small>Workspace administrator</small>
              </span>
              <IconButton name="more" label="Workspace guide" onClick={() => open('help')} />
            </div>
          </div>
        </aside>
        <div className={`mobile-scrim ${menu ? 'open' : ''}`} onClick={() => setMenu(false)} />
        <div className="workspace">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                className="icon-button mobile-menu"
                aria-label="Open navigation"
                aria-expanded={menu}
                aria-controls="sidebar"
                onClick={() => setMenu((value) => !value)}
              >
                <Icon name="menu" />
              </button>
              <span>Workspace</span>
              <Icon name="chevron" />
              <strong>{pageNames[page]}</strong>
            </div>
            <div className="topbar-actions">
              <button
                className="global-search"
                onClick={() => open('search')}
                aria-label="Search workspace"
              >
                <Icon name="search" />
                <span>Search anything...</span>
                <kbd>Ctrl K</kbd>
              </button>
              <button
                className="icon-button help-top"
                onClick={() => open('help')}
                aria-label="Open workspace guide"
              >
                <Icon name="help" />
              </button>
              <button
                className="icon-button"
                onClick={() => open('alerts')}
                aria-label="View stock alerts"
              >
                <Icon name="bell" />
                {low.length + expiry.length + recalls.length + holds.length + overReserved.length >
                  0 && <i className="notification-dot" />}
              </button>
              <span className="topbar-divider" />
              <span className="avatar" aria-label="Krisstoff">
                KS
              </span>
            </div>
          </header>
          <main id="app" tabIndex={-1} key={page}>
            {recoveryData !== null && (
              <div role="alert">
                <Callout>
                  <p>
                    Your saved workspace could not be loaded. Sample data was opened instead. Your
                    unreadable data has been kept on this browser for recovery.
                  </p>
                  <Button
                    tone=""
                    icon="download"
                    onClick={() =>
                      download('aster-unreadable-data.json', recoveryData, 'application/json')
                    }
                  >
                    Download unreadable data
                  </Button>
                </Callout>
              </div>
            )}
            {views[page]}
          </main>
          <footer className="workspace-footer">
            <span>
              <i className="status-dot" /> Your workspace is up to date
            </span>
            <span>
              Aster Pharmacy OS <span className="footer-dot">·</span> Browser demo
            </span>
          </footer>
        </div>
      </div>
      <DialogHost />
      {createPortal(
        <div id="toast-root" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.error ? 'error' : ''}`}>
              <Icon name={toast.error ? 'alert' : 'check'} />
              <span>{toast.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
export default function App() {
  return (
    <WorkspaceProvider>
      <WorkspaceApp />
    </WorkspaceProvider>
  );
}
