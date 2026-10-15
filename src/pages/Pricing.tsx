import { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { A } from '../lib/model';
import { errorMessage, money } from '../lib/format';
import { exportPrices } from '../lib/exports';
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Field,
  Filter,
  FormFooter,
  Heading,
  SearchInput,
  SelectField,
} from '../components/ui';
import { WorkspaceForm } from '../components/forms';
import type { CustomerGroup, PriceEntry, Product, Unit } from '../types';

function PriceCell({
  product,
  unit,
  groupId,
  customerId,
  fallback,
}: {
  product: Product;
  unit: Unit;
  groupId?: string;
  customerId?: string;
  fallback?: number;
}) {
  const { state, mutate, toast } = useWorkspace();
  const entry = state.prices.find(
    (e) =>
      e.productId === product.id &&
      e.unit === unit &&
      (groupId ? e.groupId === groupId : e.customerId === customerId),
  );
  const displayed = entry?.price ?? fallback;
  const below = displayed !== undefined && A.belowCost(state, product.id, unit, displayed);
  const label = `${state.customerGroups.find((g) => g.id === groupId)?.name || 'Special'} price for ${product.name} (${unit})`;
  return (
    <input
      key={`${entry?.id}-${entry?.price}-${fallback}`}
      aria-label={label}
      className={`price-cell ${!entry && fallback !== undefined ? 'price-computed' : ''} ${below ? 'price-below-cost' : ''}`}
      title={below ? `Below cost (${money(A.unitPrice(product, unit, true))})` : undefined}
      type="number"
      min="0.01"
      step="0.01"
      defaultValue={entry?.price ?? ''}
      placeholder={fallback !== undefined ? fallback.toFixed(2) : ''}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          event.currentTarget.value = entry ? String(entry.price) : '';
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const value = event.currentTarget.value;
        if ((!entry && !value) || (entry && value !== '' && Number(value) === entry.price)) return;
        try {
          mutate(
            (s) =>
              value === '' && entry
                ? A.deletePrice(s, entry.id)
                : A.savePrice(
                    s,
                    {
                      productId: product.id,
                      unit,
                      price: value,
                      groupId,
                      customerId,
                      note: entry?.note,
                    },
                    entry?.id,
                  ),
            value === '' ? 'Price deleted.' : 'Price saved.',
            undefined,
            true,
          );
        } catch (error) {
          toast(errorMessage(error), true);
          event.currentTarget.value = entry ? String(entry.price) : '';
        }
      }}
    />
  );
}

function GroupHeader({ group }: { group: CustomerGroup }) {
  const { mutate } = useWorkspace();
  return (
    <WorkspaceForm
      onSubmit={(data) =>
        mutate(
          (s) =>
            A.saveCustomerGroup(
              s,
              { name: group.name, discountPercent: Number(data[`discount-${group.id}`]) },
              group.id,
            ),
          'Group discount saved.',
          undefined,
          true,
        )
      }
    >
      <span>
        {group.name} · {group.discountPercent}% off default
      </span>
      <div className="flex items-end gap-[6px] mt-[8px]">
        <Field
          label={`${group.name} discount (%)`}
          name={`discount-${group.id}`}
          type="number"
          min="0"
          max="100"
          step="0.01"
          defaultValue={group.discountPercent}
          required
        />
        <Button type="submit" tone="" icon="check">
          Save
        </Button>
      </div>
    </WorkspaceForm>
  );
}

export function PricingPage() {
  const { state } = useWorkspace();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('');
  const [inactive, setInactive] = useState(false);
  const rows = state.products
    .filter(
      (p) =>
        (p.active || inactive) &&
        (!category || p.category === category) &&
        `${p.name} ${p.sku} ${p.generic}`.toLowerCase().includes(search.toLowerCase()),
    )
    .flatMap((p) =>
      [p.unit, ...p.packs.map((pack) => pack.unit)]
        .filter((u) => !unit || u === unit)
        .map((unit) => ({ product: p, unit })),
    );
  return (
    <>
      <Heading
        title="Price lists"
        subtitle="Group prices and discounts, per product and pack. Clear an entry to use the default."
        actions={
          <Button tone="" icon="download" onClick={() => exportPrices(state, rows)}>
            Export CSV
          </Button>
        }
      />
      <section className="panel">
        <div className="panel-body flex flex-wrap items-center gap-[12px]">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search prices, product or SKU..."
          />
          <Filter
            label="Price category"
            value={category}
            onChange={setCategory}
            items={A.categories}
            placeholder="All categories"
          />
          <Filter
            label="Price unit"
            value={unit}
            onChange={setUnit}
            items={A.units}
            placeholder="All units"
          />
          <label>
            <input
              type="checkbox"
              checked={inactive}
              onChange={(e) => setInactive(e.target.checked)}
            />{' '}
            Show inactive
          </label>
        </div>
        <DataTable
          items={rows}
          filterKey={`${search}-${category}-${unit}-${inactive}`}
          columns={[
            'Product',
            'Unit',
            'Cost',
            'Default price',
            ...state.customerGroups.map((g) => <GroupHeader key={g.id} group={g} />),
          ]}
          row={({ product: p, unit }) => (
            <tr key={`${p.id}-${unit}`}>
              <td>
                <strong>{p.name}</strong>
                <small className="muted block">
                  {p.sku}
                  {!p.active ? ' · Inactive' : ''}
                </small>
              </td>
              <td>{unit}</td>
              <td>{money(A.unitPrice(p, unit, true))}</td>
              <td>
                <span
                  className={
                    A.belowCost(state, p.id, unit, A.unitPrice(p, unit)) ? 'price-below-cost' : ''
                  }
                  title={
                    A.belowCost(state, p.id, unit, A.unitPrice(p, unit))
                      ? `Below cost (${money(A.unitPrice(p, unit, true))})`
                      : undefined
                  }
                >
                  {money(A.unitPrice(p, unit))}
                </span>
              </td>
              {state.customerGroups.map((g) => {
                const resolved = A.groupPriceFor(state, { productId: p.id, unit, groupId: g.id });
                return (
                  <td key={g.id}>
                    <PriceCell
                      product={p}
                      unit={unit}
                      groupId={g.id}
                      fallback={resolved.source === 'group_discount' ? resolved.price : undefined}
                    />
                  </td>
                );
              })}
            </tr>
          )}
        />
      </section>
    </>
  );
}

export function SpecialPrices({ customerId }: { customerId: string }) {
  const { state, mutate, confirm, open } = useWorkspace();
  const [inactive, setInactive] = useState(false);
  const [productId, setProductId] = useState('');
  const [unit, setUnit] = useState<Unit | ''>('');
  const [price, setPrice] = useState('');
  const p = A.product(state, productId);
  const groupId = A.contact(state, customerId)?.groupId;
  const entries = state.prices.filter(
    (e) => e.customerId === customerId && (inactive || A.product(state, e.productId)?.active),
  );
  const otherwise = (e: PriceEntry) =>
    A.groupPriceFor(state, { productId: e.productId, unit: e.unit, groupId }).price;
  return (
    <>
      <h3 className="detail-label">Special prices</h3>
      <label>
        <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />{' '}
        Show inactive
      </label>
      <DataTable
        items={entries}
        columns={['Product', 'Unit', 'Price', 'Otherwise', 'Difference', '']}
        row={(e) => (
          <tr key={e.id}>
            <td>
              {A.product(state, e.productId)?.name}
              {!A.product(state, e.productId)?.active && <Badge status="Inactive" />}
            </td>
            <td>{e.unit}</td>
            <td>
              <PriceCell
                product={A.product(state, e.productId)!}
                unit={e.unit}
                customerId={customerId}
              />
            </td>
            <td>{money(otherwise(e))}</td>
            <td>{money(A.round(e.price - otherwise(e)))}</td>
            <td>
              <Button
                tone="danger"
                icon="trash"
                onClick={() =>
                  confirm(
                    'Delete special price?',
                    `${A.product(state, e.productId)?.name} (${e.unit})`,
                    () =>
                      mutate(
                        (s) => A.deletePrice(s, e.id),
                        'Special price deleted.',
                        () => open('contact-detail', customerId),
                      ),
                    'Delete',
                  )
                }
              >
                Delete
              </Button>
            </td>
          </tr>
        )}
      />
      <WorkspaceForm
        onSubmit={(data) => {
          mutate(
            (s) =>
              A.savePrice(s, {
                productId,
                unit: unit as Unit,
                price: data.specialPrice,
                customerId,
                note: data.priceNote,
              }),
            'Special price added.',
            undefined,
            true,
          );
          setProductId('');
          setUnit('');
          setPrice('');
        }}
      >
        <div className="form-grid mt-[16px]">
          <SelectField
            key={productId || 'blank'}
            label="Special price product"
            name="specialProduct"
            defaultValue={productId}
            onChange={(value) => {
              setProductId(value);
              setUnit(A.product(state, value)?.unit || '');
            }}
          >
            <option value="">Select product</option>
            {state.products
              .filter((p) => p.active || inactive)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.active ? '' : ' · Inactive'}
                </option>
              ))}
          </SelectField>
          <SelectField
            key={`${productId}-${unit}`}
            label="Special price unit"
            name="specialUnit"
            defaultValue={unit}
            onChange={(value) => setUnit(value as Unit)}
          >
            {!p && <option value="">Select unit</option>}
            {p &&
              [p.unit, ...p.packs.map((pack) => pack.unit)].map((unit) => (
                <option key={unit}>{unit}</option>
              ))}
          </SelectField>
          <Field
            label="Special price ($)"
            name="specialPrice"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            type="number"
            min="0.01"
            step="0.01"
            required
          />
          <Field label="Price note" name="priceNote" />
        </div>
        {p && unit && price && A.belowCost(state, p.id, unit, Number(price)) && (
          <Callout>
            <Badge status="Below cost" /> Cost: {money(A.unitPrice(p, unit, true))}
          </Callout>
        )}
        <FormFooter label="Add special price" />
      </WorkspaceForm>
    </>
  );
}
