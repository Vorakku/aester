import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { date, errorMessage, money, number } from '../lib/format';
import type { CountLine, Product, StockCount } from '../types';
import { WorkspaceForm } from './forms';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Field,
  FormFooter,
  PanelHeader,
  SelectField,
  Summary,
  WarehouseOptions,
} from './ui';

const progress = (count: StockCount) => count.lines.filter((l) => l.counted !== null).length;
const hidden = (count: StockCount) => count.blind && progress(count) < count.lines.length;

export function CountFreezeBanner({ warehouseId }: { warehouseId?: string }) {
  const { state } = useWorkspace();
  return (
    <>
      {state.stockCounts
        .filter((c) => c.status === 'Open' && (!warehouseId || c.warehouseId === warehouseId))
        .map((c) => (
          <Callout key={c.id}>
            Counting in progress ({c.number}) — stock movements in{' '}
            {A.warehouse(state, c.warehouseId)?.name} are paused.
          </Callout>
        ))}
    </>
  );
}

export function StockCountsTable() {
  const { state, open } = useWorkspace();
  return (
    <section className="panel">
      <PanelHeader
        title="Stock counts"
        subtitle="Count shelves, review differences, and post adjustments."
        action={<Button onClick={() => open('start-count')}>Start count</Button>}
      />
      <DataTable
        items={state.stockCounts}
        columns={[
          'Number',
          'Warehouse',
          'Status',
          'Progress',
          'Difference value',
          'Created by',
          'Date',
        ]}
        row={(c) => (
          <tr key={c.id}>
            <td>
              <button className="table-link mono" onClick={() => open('count-sheet', c.id)}>
                {c.number}
              </button>
            </td>
            <td>{A.warehouse(state, c.warehouseId)?.name}</td>
            <td>
              <Badge status={c.status} />
            </td>
            <td>
              {progress(c)} / {c.lines.length}
            </td>
            <td>
              {hidden(c)
                ? 'Hidden'
                : money(
                    A.sum(c.lines, (l) =>
                      l.counted === null
                        ? 0
                        : A.round(
                            (l.counted - l.expected) *
                              state.batches.find((b) => b.id === l.batchId)!.cost,
                          ),
                    ),
                  )}
            </td>
            <td>{c.createdBy}</td>
            <td>{date(c.createdAt.slice(0, 10))}</td>
          </tr>
        )}
      />
    </section>
  );
}

export function StartCountForm() {
  const { mutate, open } = useWorkspace();
  const [categories, setCategories] = useState<string[]>([]);
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.startCount(s, {
              warehouseId: data.warehouseId,
              categories,
              blind: data.blind === 'on',
              note: data.note,
            }),
          'Stock count started.',
          (c) => open('count-sheet', c.id),
        )
      }
    >
      <div className="form-grid">
        <SelectField label="Warehouse" name="warehouseId" defaultValue="wh_main">
          <WarehouseOptions />
        </SelectField>
        <div className="form-field">
          <label htmlFor="count-categories">Categories (empty = all)</label>
          <select
            id="count-categories"
            multiple
            value={categories}
            onChange={(event) =>
              setCategories(Array.from(event.target.selectedOptions, (option) => option.value))
            }
          >
            {A.categories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </div>
        <Field label="Blind count" name="blind" type="checkbox" />
        <Field label="Note" name="note" full />
      </div>
      <Callout>
        Stock movements in this whole warehouse pause until the count is posted or canceled. Keep
        counts short, after hours.
      </Callout>
      <FormFooter label="Start count" />
    </WorkspaceForm>
  );
}

function PackCountHelper({
  product,
  line,
  countId,
}: {
  product: Product;
  line: CountLine;
  countId: string;
}) {
  const { mutate } = useWorkspace();
  const [show, setShow] = useState(false);
  if (!product.packs.length) return null;
  return (
    <>
      <Button tone="small" onClick={() => setShow(!show)}>
        + packs
      </Button>
      {show && (
        <WorkspaceForm
          onSubmit={(data) => {
            const packs = Number(data[`packs-${line.batchId}`]),
              remainder = Number(data[`remainder-${line.batchId}`]);
            mutate(
              (s) =>
                A.recordCount(
                  s,
                  countId,
                  line.batchId,
                  packs * A.unitFactor(product, data[`unit-${line.batchId}`] as Product['unit']) +
                    remainder,
                ),
              'Count saved.',
              undefined,
              true,
            );
            setShow(false);
          }}
        >
          <Field
            label={`Packs for ${line.lotCode}`}
            name={`packs-${line.batchId}`}
            type="number"
            min="0"
            step="1"
            defaultValue="0"
            required
          />
          <SelectField
            label={`Pack unit for ${line.lotCode}`}
            name={`unit-${line.batchId}`}
            defaultValue={product.packs[0].unit}
          >
            {product.packs.map((pack) => (
              <option key={pack.id} value={pack.unit}>
                {pack.unit} (×{pack.factor})
              </option>
            ))}
          </SelectField>
          <Field
            label={`Extra ${product.unit}s for ${line.lotCode}`}
            name={`remainder-${line.batchId}`}
            type="number"
            min="0"
            step="1"
            defaultValue="0"
            required
          />
          <Button type="submit" tone="small" icon="check">
            Save packs + base units
          </Button>
        </WorkspaceForm>
      )}
    </>
  );
}

export function CountSheet({ id }: { id: string }) {
  const { state, mutate, open, confirm, toast } = useWorkspace();
  const [search, setSearch] = useState('');
  const count = state.stockCounts.find((c) => c.id === id);
  if (!count) return null;
  const hide = hidden(count);
  return (
    <>
      <div className="count-controls">
        <Summary
          items={[
            [count.number, <Badge status={count.status} />],
            ['Warehouse', A.warehouse(state, count.warehouseId)?.name],
            ['Progress', `${progress(count)} / ${count.lines.length} counted`],
          ]}
        />
        {count.note && <Callout>{count.note}</Callout>}
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const code = search.trim().toLowerCase(),
              barcode = A.findBarcode(state, search);
            const line =
              count.lines.find(
                (l) => l.lotCode.toLowerCase() === code || l.productId === barcode?.product.id,
              ) ||
              count.lines.find((l) =>
                A.product(state, l.productId)?.name.toLowerCase().includes(code),
              );
            if (!code || !line) {
              toast('No matching lot in this count.', true);
              return;
            }
            const row = document.getElementById(`count-line-${line.batchId}`);
            row?.scrollIntoView({ block: 'center' });
            row?.querySelector<HTMLInputElement>('input')?.focus();
          }}
        >
          <Field
            label="Scan / search"
            name="countSearch"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Lot code, product or pack barcode"
          />
          <Button type="submit" icon="search" tone="small">
            Find line
          </Button>
        </form>
        <Callout>
          Count in base units. Use + packs to enter packs plus loose units. Lots absent from the
          system must be received with Receive stock after posting.
        </Callout>
        {hide && (
          <Callout>
            Blind count: expected quantities and differences stay hidden until every line is
            counted.
          </Callout>
        )}
      </div>
      <div className="count-sheet-print">
        <h3 className="print-only">
          {count.number} — {A.warehouse(state, count.warehouseId)?.name}
        </h3>
        <DataTable
          items={count.lines}
          pageSize={count.lines.length}
          columns={[
            'Product',
            'Lot',
            'Expiry',
            ...(!hide ? ['Expected'] : []),
            'Counted',
            ...(!hide ? ['Difference'] : []),
          ]}
          row={(l) => {
            const product = A.product(state, l.productId)!;
            return (
              <tr key={l.batchId} id={`count-line-${l.batchId}`}>
                <td>
                  {product.name}
                  <small className="block muted">Base unit: {product.unit}</small>
                </td>
                <td>{l.lotCode}</td>
                <td>{date(l.expiry)}</td>
                {!hide && <td>{number(l.expected)}</td>}
                <td className="counted-cell">
                  {count.status === 'Open' ? (
                    <>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={`Counted ${l.lotCode}`}
                        value={l.counted ?? ''}
                        onChange={(event) => {
                          try {
                            mutate(
                              (s) =>
                                A.recordCount(
                                  s,
                                  id,
                                  l.batchId,
                                  event.target.value === '' ? null : event.target.value,
                                ),
                              'Count saved.',
                              undefined,
                              true,
                            );
                          } catch (error) {
                            toast(errorMessage(error), true);
                          }
                        }}
                      />
                      <PackCountHelper product={product} line={l} countId={id} />
                    </>
                  ) : l.counted === null ? (
                    'Not counted'
                  ) : (
                    number(l.counted)
                  )}
                </td>
                {!hide && (
                  <td>
                    {l.counted === null
                      ? '—'
                      : `${l.counted - l.expected > 0 ? '+' : ''}${l.counted - l.expected}`}
                  </td>
                )}
              </tr>
            );
          }}
        />
      </div>
      <div className="detail-actions count-controls">
        <Button tone="" icon="print" onClick={() => window.print()}>
          Print count sheet
        </Button>
        {count.status === 'Open' && (
          <>
            <Button tone="" onClick={() => open('add-count-lot', id)}>
              Add lot
            </Button>
            <Button
              tone=""
              icon="close"
              onClick={() =>
                confirm(
                  'Cancel this count?',
                  `${count.number}: stock stays unchanged and movements resume.`,
                  () => mutate((s) => A.cancelCount(s, id), 'Count canceled.'),
                  'Cancel count',
                )
              }
            >
              Cancel count
            </Button>
            <Button
              icon="check"
              onClick={() => {
                const missing = count.lines.length - progress(count);
                if (missing) {
                  toast(`${missing} lines are not counted yet.`, true);
                  return;
                }
                open('count-review', id);
              }}
            >
              Review &amp; post
            </Button>
          </>
        )}
      </div>
    </>
  );
}

export function AddCountLotForm({ id }: { id: string }) {
  const { state, mutate, open } = useWorkspace();
  const count = state.stockCounts.find((c) => c.id === id);
  if (!count) return null;
  const lots = state.batches.filter(
    (b) => b.warehouseId === count.warehouseId && !count.lines.some((l) => l.batchId === b.id),
  );
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) => A.addCountLine(s, id, data.batchId),
          'Lot added to count.',
          () => open('count-sheet', id),
        )
      }
    >
      <SelectField label="Lot" name="batchId">
        <option value="">Select a lot</option>
        {lots.map((b) => (
          <option key={b.id} value={b.id}>
            {A.product(state, b.productId)?.name} · {b.code}
          </option>
        ))}
      </SelectField>
      <Callout>
        Only existing lots in this warehouse can be added. Receive lots absent from the system with
        Receive stock after posting.
      </Callout>
      <FormFooter label="Add lot">
        <Button tone="" icon="left" onClick={() => open('count-sheet', id)}>
          Back to count
        </Button>
      </FormFooter>
    </WorkspaceForm>
  );
}

export function CountReview({ id }: { id: string }) {
  const { state, open, mutate, confirm, setWarehouseTab } = useWorkspace();
  const count = state.stockCounts.find((c) => c.id === id);
  if (!count) return null;
  const lines = count.lines.filter((l) => l.counted !== null && l.counted !== l.expected);
  const value = (l: CountLine) =>
    A.round((l.counted! - l.expected) * state.batches.find((b) => b.id === l.batchId)!.cost);
  return (
    <>
      <Callout>
        Review {count.number}. Each difference becomes a count adjustment in inventory and inventory
        write-offs.
      </Callout>
      <DataTable
        items={lines}
        pageSize={Math.max(1, lines.length)}
        columns={['Product', 'Lot', 'Expected', 'Counted', '± Qty', '± Value']}
        row={(l) => (
          <tr key={l.batchId}>
            <td>{A.product(state, l.productId)?.name}</td>
            <td>{l.lotCode}</td>
            <td>{number(l.expected)}</td>
            <td>{number(l.counted!)}</td>
            <td>
              {l.counted! > l.expected ? '+' : ''}
              {number(l.counted! - l.expected)}
            </td>
            <td>
              {value(l) > 0 ? '+' : value(l) < 0 ? '−' : ''}
              {money(Math.abs(value(l)))}
            </td>
          </tr>
        )}
      />
      <Summary items={[['Total difference value', money(A.sum(lines, value))]]} />
      <div className="form-footer">
        <Button tone="" icon="left" onClick={() => open('count-sheet', id)}>
          Back to count
        </Button>
        <Button
          icon="check"
          onClick={() =>
            confirm(
              'Post this count?',
              `${count.number}: ${lines.length} differences, total ${money(A.sum(lines, value))}. Posting resumes stock movements.`,
              () =>
                mutate(
                  (s) => A.postCount(s, id),
                  'Stock count posted.',
                  () => setWarehouseTab('adjustments'),
                ),
              'Post count',
            )
          }
        >
          Confirm posting
        </Button>
      </div>
    </>
  );
}
