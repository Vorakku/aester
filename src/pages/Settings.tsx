import { useRef, useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { download, errorMessage } from '../lib/format';
import {
  Button,
  Callout,
  Field,
  Heading,
  Icon,
  PanelHeader,
  Summary,
  type IconName,
} from '../components/ui';
import { WorkspaceForm } from '../components/forms';

export function HelpContent() {
  const steps: [IconName, string, string][] = [
    [
      'box',
      '01 · Build your catalog',
      'Add products with purchase cost, selling price, stock units, and a reorder threshold.',
    ],
    [
      'receive',
      '02 · Bring stock in',
      'Receive batches directly or create a purchase order. Enter the actual lot and expiry date.',
    ],
    [
      'invoice',
      '03 · Make the sale',
      'Save a draft or issue an invoice. Stock is allocated from sellable batches by earliest expiry.',
    ],
    [
      'wallet',
      '04 · Close the loop',
      'Record customer payments, supplier payments, and expenses. Your ledger and reports update together.',
    ],
  ];
  return (
    <>
      <div className="help-grid">
        {steps.map(([icon, title, text]) => (
          <div className="help-step" key={title}>
            <Icon name={icon} />
            <strong>{title}</strong>
            <p>{text}</p>
          </div>
        ))}
      </div>
      <Callout>
        This is a browser-based demonstration with sample data. Your changes are saved on this
        device. Use Settings → Data & backups to export records, restore a backup, or start an empty
        workspace.
      </Callout>
    </>
  );
}
export function SettingsPage() {
  const { state, mutate, replace, confirm, toast } = useWorkspace();
  const [tab, setTab] = useState('company');
  const fileRef = useRef<HTMLInputElement>(null);
  const s = state.settings;
  async function restore(file?: File) {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Backup must be smaller than 10 MB.');
      const backup = A.validateBackup(JSON.parse(await file.text()));
      confirm(
        'Restore this backup?',
        `Replace your workspace with ${backup.products.length} products and ${backup.invoices.length} invoices from the selected backup.`,
        () => replace(backup, 'Backup restored.'),
        'Restore backup',
      );
    } catch (error) {
      toast(errorMessage(error), true);
    }
    if (fileRef.current) fileRef.current.value = '';
  }
  return (
    <>
      <Heading title="Workspace settings" subtitle="Make Aster fit the way your pharmacy works." />
      <div className="settings-layout">
        <div className="settings-nav">
          {(
            [
              ['company', 'warehouse', 'Company profile'],
              ['data', 'layers', 'Data & backups'],
              ['guide', 'help', 'Workspace guide'],
            ] as [string, IconName, string][]
          ).map(([value, icon, text]) => (
            <button
              key={value}
              className={tab === value ? 'active' : ''}
              onClick={() => setTab(value)}
            >
              <Icon name={icon} />
              {text}
            </button>
          ))}
        </div>
        {tab === 'company' && (
          <section className="panel">
            <PanelHeader title="Company profile" subtitle="Used on invoices and purchase orders." />
            <WorkspaceForm
              className="panel-body"
              onSubmit={(data) =>
                mutate((draft) => {
                  A.setMinShelfLife(draft, data.minShelfLifeDays);
                  const taxRate = Number(data.taxRate),
                    expiryWindow = Number(data.expiryWindow),
                    invoicePrefix = String(data.invoicePrefix || '')
                      .trim()
                      .toUpperCase();
                  if (!data.company.trim()) throw new Error('Enter a company name.');
                  if (!/^[A-Z0-9-]{1,12}$/.test(invoicePrefix))
                    throw new Error('Invoice prefix must have 1–12 letters, digits, or hyphens.');
                  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)
                    throw new Error('Tax rate must be between 0 and 100.');
                  if (!Number.isInteger(expiryWindow) || expiryWindow < 1 || expiryWindow > 365)
                    throw new Error('Expiry window must be between 1 and 365 days.');
                  draft.settings = {
                    ...draft.settings,
                    company: data.company.trim(),
                    email: data.email,
                    phone: data.phone,
                    address: data.address,
                    invoicePrefix,
                    taxRate: A.round(taxRate),
                    expiryWindow,
                  };
                }, 'Settings saved.')
              }
            >
              <div className="form-grid">
                <Field label="Company name" name="company" defaultValue={s.company} full required />
                <Field label="Email address" name="email" type="email" defaultValue={s.email} />
                <Field label="Phone number" name="phone" defaultValue={s.phone} />
                <Field label="Business address" name="address" defaultValue={s.address} full />
                <Field label="Invoice prefix" name="invoicePrefix" defaultValue={s.invoicePrefix} />
                <Field
                  label="Default invoice tax (%)"
                  name="taxRate"
                  type="number"
                  defaultValue={s.taxRate}
                  min="0"
                  max="100"
                  step="0.01"
                />
                <Field
                  label="Expiry warning window (days)"
                  name="expiryWindow"
                  type="number"
                  defaultValue={s.expiryWindow}
                  min="1"
                  max="365"
                  step="1"
                />
                <Field
                  label="Minimum shelf life on sale (days)"
                  name="minShelfLifeDays"
                  type="number"
                  defaultValue={s.minShelfLifeDays}
                  min="0"
                  max="1095"
                  step="1"
                  required
                />
                <div className="form-field">
                  <label htmlFor="currency">Currency</label>
                  <input id="currency" value="USD — US Dollar" disabled readOnly />
                  <small>All stock costs and ledger balances use USD.</small>
                </div>
              </div>
              <div className="form-footer">
                <Button type="submit" icon="check">
                  Save changes
                </Button>
              </div>
            </WorkspaceForm>
          </section>
        )}
        {tab === 'data' && (
          <section className="panel">
            <PanelHeader title="Workspace data" subtitle="Keep a copy of your records." />
            <div className="panel-body">
              <div className="account-banner">
                <Icon name="lock" />
                <div>
                  <strong>Saved on this browser</strong>
                  <p>
                    Your workspace saves changes locally. Records are not shared between devices.
                  </p>
                </div>
              </div>
              <div className="my-[20px]">
                <Summary
                  items={[
                    ['Products / batches', `${state.products.length} / ${state.batches.length}`],
                    [
                      'Invoices / purchase orders',
                      `${state.invoices.length} / ${state.purchases.length}`,
                    ],
                    ['Balanced journal entries', state.journal.length],
                  ]}
                />
              </div>
              <div className="flex gap-[10px] flex-wrap">
                <Button
                  tone=""
                  icon="download"
                  onClick={() => {
                    download(
                      `aster-backup-${A.today()}.json`,
                      JSON.stringify(state, null, 2),
                      'application/json',
                    );
                    toast('Backup downloaded.');
                  }}
                >
                  Download backup
                </Button>
                <Button tone="" icon="upload" onClick={() => fileRef.current?.click()}>
                  Restore backup
                </Button>
              </div>
              <input
                ref={fileRef}
                type="file"
                aria-label="Restore backup file"
                accept="application/json,.json"
                hidden
                onChange={(event) => void restore(event.target.files?.[0])}
              />
              <Callout>
                Restore a previously downloaded Aster JSON backup. The existing workspace is
                replaced only after validation and confirmation.
              </Callout>
              <div className="form-section">Start over</div>
              <p className="muted text-[10px] leading-[1.8]">
                Restore the original sample workspace, or begin with an empty catalog and no
                financial records.
              </p>
              <div className="flex gap-[10px] flex-wrap">
                <Button
                  tone=""
                  icon="refresh"
                  onClick={() =>
                    confirm(
                      'Restore sample workspace?',
                      'All current records will be replaced with fresh sample data. Download a backup first if you want to keep your work.',
                      () => replace(A.seed(), 'Sample workspace restored.'),
                      'Restore samples',
                    )
                  }
                >
                  Reset sample data
                </Button>
                <Button
                  tone="danger"
                  icon="trash"
                  onClick={() =>
                    confirm(
                      'Begin an empty workspace?',
                      'All products, batches, contacts, invoices, purchase orders, and financial records will be cleared. Company settings and warehouse locations are kept.',
                      () => replace(A.emptyWorkspace(state), 'Your empty workspace is ready.'),
                      'Start empty',
                    )
                  }
                >
                  Start empty workspace
                </Button>
              </div>
            </div>
          </section>
        )}
        {tab === 'guide' && (
          <section className="panel">
            <PanelHeader
              title="Your workspace guide"
              subtitle="A few simple steps from receiving to reporting."
            />
            <div className="panel-body">
              <HelpContent />
            </div>
          </section>
        )}
      </div>
    </>
  );
}
