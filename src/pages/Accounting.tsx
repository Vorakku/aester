import { Receivables } from '../components/receivables';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { compactMoney, date, money } from '../lib/format';
import {
  Badge,
  Button,
  Empty,
  Heading,
  Icon,
  Metric,
  PanelHeader,
  PeriodControl,
  Summary,
} from '../components/ui';
import { ExportButton } from './Operations';

export function AccountingPage() {
  const { state, period, open, accountingTab: tab, setAccountingTab: setTab } = useWorkspace();
  const b = A.balances(state),
    p = A.balances(state, A.shift(-period + 1));
  const profit = A.round(p.revenue.balance - p.cogs.balance - p.expense.balance - p.loss.balance);
  const bills = [...state.receipts].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <Heading
        title="Accounting"
        subtitle="Stock and sales, translated into a balanced business."
        actions={
          <>
            <ExportButton type="ledger" label="Export ledger" small={false} />
            <Button onClick={() => open('expense-form')}>Add expense</Button>
          </>
        }
      />
      <div className="metrics">
        <Metric
          label="Cash & bank"
          value={compactMoney(b.cash.balance)}
          icon="bank"
          foot="Current balance across payments"
        />
        <Metric
          label="Accounts receivable"
          value={compactMoney(b.receivable.balance)}
          icon="invoice"
          foot="Outstanding customer balances"
        />
        <Metric
          label="Accounts payable"
          value={compactMoney(b.payable.balance)}
          icon="cart"
          foot="Unpaid supplier bills"
        />
        <Metric
          label="Net profit"
          value={compactMoney(profit)}
          icon="trend"
          foot={`Last ${period} days`}
        />
      </div>
      <div className="tab-bar">
        {[
          ['overview', 'Overview'],
          ['ledger', 'General ledger'],
          ['receivables', 'Receivables'],
          ['payables', 'Payables'],
          ['expenses', 'Expenses'],
          ['accounts', 'Accounts'],
        ].map(([value, text]) => (
          <button
            key={value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {text}
          </button>
        ))}
      </div>
      {tab === 'receivables' && <Receivables />}
      {tab === 'overview' && (
        <>
          <div className="two-columns">
            <section className="panel">
              <PanelHeader
                title="Profit & loss"
                subtitle={`For the last ${period} days`}
                action={<PeriodControl />}
              />
              <div className="panel-body">
                <Summary
                  items={[
                    ['Sales revenue (net of discounts, excluding tax)', money(p.revenue.balance)],
                    ['Cost of goods sold', money(p.cogs.balance)],
                    ['Gross profit', money(p.revenue.balance - p.cogs.balance)],
                    ['Operating expenses', money(p.expense.balance)],
                    ['Stock write-offs & adjustments', money(p.loss.balance)],
                    ['Net profit', <span className="text-aster text-[14px]">{money(profit)}</span>],
                  ]}
                />
              </div>
            </section>
            <section className="panel">
              <PanelHeader
                title="Balance sheet"
                subtitle={`Cumulative balances as of ${date(A.today())}`}
              />
              <div className="panel-body">
                <Summary
                  items={[
                    ['Cash & bank', money(b.cash.balance)],
                    ['Accounts receivable', money(b.receivable.balance)],
                    ['Inventory', money(b.inventory.balance)],
                    [
                      'Total assets',
                      money(b.cash.balance + b.receivable.balance + b.inventory.balance),
                    ],
                    ['Accounts payable', money(b.payable.balance)],
                    ['Tax payable', money(b.tax.balance)],
                    ['Opening equity', money(b.equity.balance)],
                    [
                      'Retained earnings',
                      money(
                        b.revenue.balance - b.cogs.balance - b.expense.balance - b.loss.balance,
                      ),
                    ],
                  ]}
                />
                <Summary
                  items={[
                    [
                      'Delivered, not invoiced',
                      money(A.sum(A.deliveredNotInvoiced(state), (r) => r.value)),
                    ],
                    [
                      'Cost already posted without matching revenue',
                      money(A.sum(A.deliveredNotInvoiced(state), (r) => r.delivery.cost)),
                    ],
                  ]}
                />
              </div>
            </section>
          </div>
          <div className="account-banner">
            <Icon name="shield" />
            <div>
              <strong>Everything stays connected.</strong>
              <p>
                Sales, stock receipts, expenses, and payments generate balanced journal entries
                automatically.
              </p>
            </div>
          </div>
        </>
      )}
      {tab === 'ledger' && (
        <section className="panel">
          <PanelHeader
            title="General ledger"
            subtitle="Every posting, with its source reference."
            action={<ExportButton type="ledger" label="Export ledger" />}
          />
          <div className="table-wrap mt-[18px]">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference / description</th>
                  <th>Account</th>
                  <th>Debit</th>
                  <th>Credit</th>
                </tr>
              </thead>
              <tbody>
                {[...state.journal]
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .slice(0, 50)
                  .flatMap((j) =>
                    j.entries.map((entry, index) => (
                      <tr key={`${j.id}-${index}`}>
                        <td>{index === 0 ? date(j.date) : ''}</td>
                        <td>
                          {index === 0 && (
                            <>
                              <strong>{j.reference}</strong>
                              <div className="text-[9px] mt-[5px] text-[#a0ae94]">
                                {j.description}
                              </div>
                            </>
                          )}
                        </td>
                        <td>{A.accounts.find((a) => a.id === entry.account)?.name}</td>
                        <td className="num">{entry.debit ? money(entry.debit) : '—'}</td>
                        <td className="num">{entry.credit ? money(entry.credit) : '—'}</td>
                      </tr>
                    )),
                  )}
              </tbody>
            </table>
          </div>
          <div className="ledger-note">
            Showing the latest 50 entries. Export includes the complete ledger.
          </div>
        </section>
      )}
      {tab === 'payables' && (
        <section className="panel">
          <PanelHeader
            title="Supplier bills"
            subtitle="Payables created when inventory is received."
          />
          <div className="table-wrap mt-[18px]">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Supplier</th>
                  <th>Received</th>
                  <th>Total</th>
                  <th>Balance</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => {
                  const balance = A.billBalance(bill);
                  const status = A.billStatus(bill);
                  return (
                    <tr key={bill.id}>
                      <td>
                        <button
                          className="table-link mono font-semibold"
                          onClick={() => open('receipt-detail', bill.id)}
                        >
                          {bill.number}
                        </button>
                      </td>
                      <td>{A.contact(state, bill.supplierId)?.name || 'Direct stock receipt'}</td>
                      <td>{date(bill.date)}</td>
                      <td>{money(bill.total)}</td>
                      <td>
                        <strong>{money(balance)}</strong>
                      </td>
                      <td>
                        <Badge status={status} />
                      </td>
                      <td>
                        {balance > 0 ? (
                          <Button
                            tone="small"
                            icon="wallet"
                            onClick={() => open('bill-payment', bill.id)}
                          >
                            Pay bill
                          </Button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!bills.length && (
                  <tr>
                    <td colSpan={7}>
                      <Empty
                        title="No supplier bills"
                        description="Receive a purchase order to create a payable."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === 'expenses' && (
        <section className="panel">
          <PanelHeader
            title="Operating expenses"
            subtitle="A clear record of the cost of doing business."
            action={
              <Button tone="small" onClick={() => open('expense-form')}>
                Add expense
              </Button>
            }
          />
          <div className="table-wrap mt-[18px]">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {[...state.expenses]
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .map((e) => (
                    <tr key={e.id}>
                      <td>{date(e.date)}</td>
                      <td>{e.reference}</td>
                      <td>
                        <strong>{e.description}</strong>
                      </td>
                      <td>{e.category}</td>
                      <td>{money(e.amount)}</td>
                    </tr>
                  ))}
                {!state.expenses.length && (
                  <tr>
                    <td colSpan={5}>
                      <Empty
                        title="No expenses recorded"
                        description="Add an operating expense to get started."
                        icon="wallet"
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === 'accounts' && (
        <section className="panel">
          <PanelHeader
            title="Chart of accounts & trial balance"
            subtitle="Debit and credit totals for the complete ledger."
            action={<Badge status="Balanced" />}
          />
          <div className="table-wrap mt-[18px]">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Debit total</th>
                  <th>Credit total</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {A.accounts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                    </td>
                    <td>{a.type}</td>
                    <td>{money(b[a.id].debit)}</td>
                    <td>{money(b[a.id].credit)}</td>
                    <td>
                      <strong>{money(b[a.id].balance)}</strong>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Totals</strong>
                  </td>
                  <td />
                  <td>
                    <strong>{money(A.sum(A.accounts, (a) => b[a.id].debit))}</strong>
                  </td>
                  <td>
                    <strong>{money(A.sum(A.accounts, (a) => b[a.id].credit))}</strong>
                  </td>
                  <td>
                    <Badge status="Balanced" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
