import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { errorMessage, money, number } from '../lib/format';
import type { Product, Suggestion, Warehouse } from '../types';
import { Button, Callout, DataTable, Empty, Field, Filter, PanelHeader } from './ui';
import { WorkspaceForm } from './forms';

function ReorderLevelRow({ product: p, warehouse: w }: { product: Product; warehouse: Warehouse }) {
  const { state, mutate, toast } = useWorkspace();
  const rule = state.reorderRules.find((r) => r.productId === p.id && r.warehouseId === w.id);
  const [min, setMin] = useState(String(rule?.min ?? '')),
    [max, setMax] = useState(String(rule?.max ?? ''));
  function remove() {
    mutate((s) => A.deleteReorderRule(s, p.id, w.id), 'Reorder rule removed.', undefined, true);
    setMin('');
    setMax('');
  }
  return (
    <WorkspaceForm
      onSubmit={() => {
        if (min === '' && max === '') return remove();
        if (min === '' || max === '')
          throw new Error('Enter both minimum and maximum reorder levels.');
        mutate(
          (s) =>
            A.saveReorderRule(s, {
              productId: p.id,
              warehouseId: w.id,
              min: Number(min),
              max: Number(max),
            }),
          'Reorder rule saved.',
          undefined,
          true,
        );
      }}
    >
      <strong>{w.name}</strong>
      <p className="muted text-[10px] my-[8px]">
        Available: {number(A.available(state, p.id, w.id))} · On order:{' '}
        {number(A.onOrder(state, p.id, w.id))} {A.unitLabel(p.unit)}
      </p>
      <div className="form-grid">
        <Field
          label={`Min (${A.unitLabel(p.unit)})`}
          name={`reorder-min-${w.id}`}
          type="number"
          min="0"
          step="1"
          value={min}
          disabled={!p.active}
          onChange={(e) => setMin(e.target.value)}
        />
        <Field
          label={`Max (${A.unitLabel(p.unit)})`}
          name={`reorder-max-${w.id}`}
          type="number"
          min="1"
          step="1"
          value={max}
          disabled={!p.active}
          onChange={(e) => setMax(e.target.value)}
        />
      </div>
      <div className="detail-actions">
        <Button type="submit" tone="small" icon="check" disabled={!p.active}>
          Save
        </Button>
        <Button
          tone="small"
          icon="trash"
          disabled={!rule}
          onClick={() => {
            try {
              remove();
            } catch (error) {
              toast(errorMessage(error), true);
            }
          }}
        >
          Remove
        </Button>
      </div>
    </WorkspaceForm>
  );
}

export function ReorderLevels({ product }: { product: Product }) {
  const { state } = useWorkspace();
  return (
    <>
      <h3 className="detail-label">Reorder levels</h3>
      <Callout>Levels are in {A.unitLabel(product.unit)}. Empty fields mean no rule.</Callout>
      {state.warehouses.map((w) => (
        <ReorderLevelRow key={w.id} product={product} warehouse={w} />
      ))}
    </>
  );
}

function SuggestionGroup({ items }: { items: Suggestion[] }) {
  const { state, open } = useWorkspace();
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const first = items[0],
    supplier = A.contact(state, first.supplierId)?.name || 'No preferred supplier',
    warehouse = A.warehouse(state, first.warehouseId)?.name;
  const selected = items.filter((s) => !unchecked.includes(s.productId));
  return (
    <section className="panel mb-[18px]" aria-label={`${supplier} · ${warehouse}`}>
      <PanelHeader
        title={supplier}
        subtitle={warehouse}
        action={
          <Button
            icon="cart"
            disabled={!selected.length}
            onClick={() =>
              open('purchase-form', undefined, {
                supplierId: first.supplierId,
                warehouseId: first.warehouseId,
                lines: selected.map((s) => ({
                  productId: s.productId,
                  unit: s.orderUnit,
                  qty: s.orderQty,
                  cost: A.unitPrice(A.product(state, s.productId)!, s.orderUnit, true),
                })),
              })
            }
          >
            Create purchase order
          </Button>
        }
      />
      <DataTable
        items={items}
        columns={[
          '',
          'Product',
          'Warehouse',
          'Available',
          'On order',
          'Min / max',
          'Suggested',
          'Est. cost',
        ]}
        row={(s) => {
          const p = A.product(state, s.productId)!;
          return (
            <tr key={s.productId}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Reorder ${p.name}`}
                  checked={!unchecked.includes(p.id)}
                  onChange={(e) =>
                    setUnchecked((ids) =>
                      e.target.checked ? ids.filter((id) => id !== p.id) : [...ids, p.id],
                    )
                  }
                />
              </td>
              <td>
                <button className="table-link" onClick={() => open('product-detail', p.id)}>
                  {p.name}
                </button>
              </td>
              <td>{warehouse}</td>
              <td>{number(s.available)}</td>
              <td>{number(s.onOrder)}</td>
              <td>
                {number(s.min)} / {number(s.max)}
              </td>
              <td>
                {number(s.orderQty)} {A.unitLabel(s.orderUnit, s.orderQty)}
                {s.orderUnit !== p.unit &&
                  ` (${number(s.orderBase)} ${A.unitLabel(p.unit, s.orderBase)})`}
              </td>
              <td className="num">{money(s.estimatedCost)}</td>
            </tr>
          );
        }}
      />
    </section>
  );
}

export function ReorderSuggestions() {
  const { state } = useWorkspace();
  const [warehouse, setWarehouse] = useState('');
  const groups = new Map<string, Suggestion[]>();
  A.reorderSuggestions(state, warehouse).forEach((s) => {
    const key = JSON.stringify([s.supplierId, s.warehouseId]);
    groups.set(key, [...(groups.get(key) || []), s]);
  });
  return (
    <>
      <div className="toolbar">
        <Filter
          label="Reorder warehouse"
          value={warehouse}
          onChange={setWarehouse}
          items={state.warehouses}
          placeholder="All warehouses"
        />
      </div>
      {[...groups].map(([key, items]) => (
        <SuggestionGroup key={key} items={items} />
      ))}
      {!groups.size && (
        <Empty
          title="No reorder suggestions"
          description="Stock and incoming orders cover your reorder levels."
        />
      )}
    </>
  );
}
