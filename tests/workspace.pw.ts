import { expect, test, type Page } from '@playwright/test';

async function saved(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem('aster_pharmacy_workspace_v1') || 'null'),
  );
}

test('invalid mutation results show an internal-check toast and preserve the saved workspace', async ({
  page,
}) => {
  await page.goto('/#contacts');
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await dialog.getByLabel('Business / contact name').fill('Before internal check');
  await dialog.getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const before = await page.evaluate(() => localStorage.getItem('aster_pharmacy_workspace_v1'));
  const beforeState = await saved(page);

  // Inject a bad operation result through the real UI and WorkspaceContext.mutate path.
  await page.evaluate(async () => {
    const path = '/src/lib/model.ts';
    const { A } = (await import(/* @vite-ignore */ path)) as typeof import('../src/lib/model');
    const saveContact = A.saveContact;
    A.saveContact = (s, data, id) => {
      A.saveContact = saveContact;
      const result = saveContact(s, data, id);
      Object.assign(s, { version: 0 });
      return result;
    };
  });
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await dialog.getByLabel('Business / contact name').fill('Rejected internal check');
  await dialog.getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(page.locator('#toast-root .toast.error')).toContainText(
    'Internal check failed: This is not a supported Aster backup.',
  );
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('aster_pharmacy_workspace_v1'))).toBe(
    before,
  );
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Rejected internal check' })).toHaveCount(0);

  // The next valid save must start from the previous state, including its ref.
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await dialog.getByLabel('Business / contact name').fill('After internal check');
  await dialog.getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const after = await saved(page);
  expect(after.version).toBe(beforeState.version);
  expect(after.contacts).toHaveLength(beforeState.contacts.length + 1);
  expect(after.contacts.some((c: { name: string }) => c.name === 'Rejected internal check')).toBe(
    false,
  );
  await page.reload();
  expect(await saved(page)).toEqual(after);
  expect(await page.evaluate(() => localStorage.getItem('aster_pharmacy_recovery'))).toBeNull();
});

test('cancelling the remainder keeps a picking delivery dispatchable and closes the order on dispatch', async ({
  page,
}) => {
  await page.goto('/#orders');
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  await dialog.getByLabel('Customer', { exact: false }).selectOption('c5');
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p3');
  await dialog.getByLabel('Line quantity', { exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Save & confirm order', exact: true }).click();
  const order = (await saved(page)).orders[0];
  await dialog.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await dialog.getByLabel('Warehouse', { exact: false }).selectOption('wh_main');
  await dialog.getByRole('button', { name: 'Create delivery', exact: true }).click();
  const delivery = (await saved(page)).deliveries[0];
  expect(delivery.lines[0].qty).toBe(5);
  await dialog.getByRole('button', { name: order.number, exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel remaining', exact: true }).last().click();
  await dialog
    .getByLabel('Cancellation reason')
    .fill('Only the goods already being picked are needed');
  await dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  expect((await saved(page)).orders.find((o: { id: string }) => o.id === order.id)).toMatchObject({
    status: 'Confirmed',
    lines: [{ cancelledQty: 0 }],
  });
  await dialog.getByRole('button', { name: `${delivery.number} Picking`, exact: true }).click();
  await dialog.getByRole('button', { name: 'Dispatch', exact: true }).click();
  await dialog.getByLabel('Driver name').fill('Dara');
  await dialog.getByRole('button', { name: 'Dispatch goods', exact: true }).click();
  const after = await saved(page);
  expect(after.deliveries.find((d: { id: string }) => d.id === delivery.id).status).toBe(
    'Dispatched',
  );
  expect(after.orders.find((o: { id: string }) => o.id === order.id).status).toBe('Done');
  await page.reload();
  expect((await saved(page)).orders.find((o: { id: string }) => o.id === order.id).status).toBe(
    'Done',
  );
});

test('receivables at a past date reconcile with a printable customer statement', async ({
  page,
}) => {
  await page.goto('/#dashboard');
  await page.getByRole('button', { name: 'View receivables aging', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receivables', exact: true })).toBeVisible();
  const asOf = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await page.getByLabel('As of', { exact: true }).fill(asOf);
  const customerName = await page
    .locator('main table tbody')
    .getByRole('button')
    .first()
    .innerText();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: customerName, exact: true }) });
  const agingTotal = await row.getByRole('cell').last().innerText();
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  expect((await exportDownload).suggestedFilename()).toBe(`aster-aging-${asOf}.csv`);
  await row.getByRole('button', { name: customerName, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('To', { exact: true })).toHaveValue(asOf);
  await expect(dialog.getByTestId('statement-closing')).toHaveText(agingTotal);
  await expect(dialog.getByTestId('statement-aging-total')).toHaveText(agingTotal);
  await expect(dialog.locator('#print-document')).toContainText('CUSTOMER STATEMENT');
  await expect(dialog.locator('#print-document')).toContainText(customerName);
  const statementDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export CSV', exact: true }).click();
  expect((await statementDownload).suggestedFilename()).toContain('aster-statement-');
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printed = 'true';
    };
  });
  await dialog.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-printed', 'true');
  await page.emulateMedia({ media: 'print' });
  await expect(dialog.locator('#print-document')).toBeVisible();
  await expect(dialog.getByTestId('statement-closing')).toBeVisible();
  await expect(dialog.getByTestId('statement-aging-total')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

test('a paid invoice return is refunded, quarantined in its original lot, and released in Batches', async ({
  page,
}) => {
  await page.goto('/#invoices');
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'New invoice', exact: true }).click();
  await dialog.getByLabel('Customer', { exact: false }).selectOption('c5');
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p3');
  await dialog.getByLabel('Line quantity', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  const invoice = (await saved(page)).invoices[0];
  await dialog.getByRole('button', { name: 'Record payment', exact: true }).click();
  await dialog.getByRole('button', { name: 'Record payment', exact: true }).click();
  await page.getByPlaceholder('Search invoice or customer...').fill(invoice.number);
  await page.getByRole('button', { name: invoice.number, exact: true }).click();
  await dialog.getByRole('button', { name: 'Credit note / return', exact: true }).click();
  await dialog.getByRole('button', { name: 'Return goods', exact: true }).click();
  await dialog.getByLabel('Reason', { exact: false }).selectOption('wrong_prescription');
  await dialog.getByLabel('Qty to credit 1', { exact: false }).fill('1');
  await dialog.getByRole('radio', { name: 'Refund', exact: true }).check();
  await dialog.getByLabel('Refund method').selectOption('Cash');
  await expect(
    dialog.getByText(`Reduces ${invoice.number}'s balance by $0.00.`, { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Issue credit note', exact: true }).click();
  await expect(dialog.locator('#print-document')).toContainText('CREDIT NOTE');
  await expect(dialog.locator('#print-document')).toContainText(invoice.number);
  const returned = await saved(page);
  const cn = returned.creditNotes[0];
  expect(cn.status).toBe('Issued');
  expect(cn.reason).toBe('wrong_prescription');
  expect(cn.refunded).toBe(cn.total);
  const pick = cn.lines[0].returns[0];
  const original = returned.batches.find((b: { id: string }) => b.id === pick.batchId);
  const twin = returned.batches.find((b: { id: string }) => b.id === pick.returnBatchId);
  expect(twin).toMatchObject({
    code: original.code,
    expiry: original.expiry,
    cost: original.cost,
    warehouseId: original.warehouseId,
    quarantined: true,
  });
  await page.emulateMedia({ media: 'print' });
  await expect(dialog.locator('#print-document')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: /Batches & expiry/ }).click();
  await page.getByLabel('Batch status').selectOption('Quarantined');
  await page.getByPlaceholder('Search product or batch number...').fill(twin.code);
  const row = page
    .getByRole('row')
    .filter({ hasText: twin.code })
    .filter({ hasText: 'Returned' })
    .first();
  await expect(row.getByText('Returned', { exact: true })).toBeVisible();
  await row.getByRole('button').first().click();
  await dialog.getByRole('button', { name: 'Release batch', exact: true }).click();
  expect(
    (await saved(page)).batches.find((b: { id: string }) => b.id === twin.id).quarantined,
  ).toBe(false);
  await page.reload();
  expect((await saved(page)).creditNotes.find((c: { id: string }) => c.id === cn.id).refunded).toBe(
    cn.total,
  );
});

test('two deliveries of one customer are invoiced together and leave To invoice', async ({
  page,
}) => {
  await page.goto('/#orders');
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  await dialog.getByLabel('Customer', { exact: false }).selectOption('c5');
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p3');
  await dialog.getByLabel('Line quantity', { exact: true }).fill('1');
  await dialog.getByRole('button', { name: 'Save & confirm order', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await dialog.getByLabel('Warehouse', { exact: false }).selectOption('wh_main');
  await dialog.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await dialog.getByRole('button', { name: 'Dispatch', exact: true }).click();
  await dialog.getByLabel('Driver name').fill('Dara');
  await dialog.getByRole('button', { name: 'Dispatch goods', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  await page.getByRole('tab', { name: 'To invoice', exact: true }).click();
  const group = page.getByRole('region', { name: 'To invoice: Sunrise Hospital', exact: true });
  const choices = group.getByRole('checkbox');
  await expect(choices).toHaveCount(2);
  const labels = await choices.evaluateAll((elements) =>
    elements.map((e) => e.getAttribute('aria-label')!.replace('Select ', '')),
  );
  await choices.nth(0).check();
  await choices.nth(1).check();
  await group.getByRole('button', { name: 'Create invoice', exact: true }).click();
  await expect(
    dialog.getByText("Lines come from delivery notes and can't be edited.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Reserve stock', exact: true })).toHaveCount(0);
  for (const dn of labels)
    await expect(dialog.getByRole('button', { name: dn, exact: true })).toBeVisible();
  const drafted = await saved(page);
  const invoice = drafted.invoices[0];
  expect(invoice.deliveryIds).toHaveLength(2);
  await dialog.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
  const issued = await saved(page);
  expect(issued.invoices.find((i: { id: string }) => i.id === invoice.id).status).toBe('Issued');
  expect(issued.stockMoves).toEqual(drafted.stockMoves);
  for (const id of invoice.deliveryIds)
    expect(issued.deliveries.find((d: { id: string }) => d.id === id).invoiceId).toBe(invoice.id);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  for (const dn of labels)
    await expect(page.getByRole('button', { name: dn, exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: 'To invoice', exact: true }).click();
  for (const dn of labels)
    await expect(page.getByRole('button', { name: dn, exact: true })).toHaveCount(0);
});

test('an order is picked with an edited lot, dispatched, delivered and traceable by DN', async ({
  page,
}) => {
  await page.goto('/#inventory');
  // Ensure an alternative clean lot, regardless of the lot selected for the sample recall.
  await page.getByRole('button', { name: 'Receive stock', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Product', { exact: false }).selectOption('p1');
  await dialog.getByLabel('Warehouse', { exact: false }).selectOption('wh_main');
  await dialog.getByLabel('Quantity (boxes)', { exact: false }).fill('20');
  await dialog.getByLabel('Unit cost', { exact: false }).fill('2');
  await dialog.getByLabel('Batch / lot number').fill('DELIVERY-E2E');
  await dialog.getByLabel('Expiry date').fill('2030-12-31');
  await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
  await page.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  await dialog.getByLabel('Customer', { exact: false }).selectOption('c1');
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p1');
  await dialog.getByLabel('Line quantity', { exact: true }).fill('4');
  await dialog.getByRole('button', { name: 'Save & confirm order', exact: true }).click();
  const order = (await saved(page)).orders[0];
  await dialog.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await dialog.getByLabel('Warehouse', { exact: false }).selectOption('wh_main');
  await dialog.getByLabel('Method', { exact: false }).selectOption('delivery');
  await dialog.getByRole('button', { name: 'Create delivery', exact: true }).click();
  const delivery = (await saved(page)).deliveries[0];
  await dialog.getByRole('button', { name: 'Change lot', exact: true }).click();
  const quantities = dialog.getByRole('spinbutton');
  for (const input of await quantities.all()) await input.fill('0');
  await dialog.getByLabel('Pick DELIVERY-E2E', { exact: false }).fill('4');
  await dialog.getByRole('button', { name: 'Save picks', exact: true }).click();
  await expect(dialog.getByText('DELIVERY-E2E', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Dispatch', exact: true }).click();
  await dialog.getByLabel('Driver name').fill('Dara');
  await dialog.getByRole('button', { name: 'Dispatch goods', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm delivered', exact: true }).click();
  await dialog.getByLabel('Received by').fill('Greenlife receiving desk');
  await dialog.getByRole('button', { name: 'Confirm receipt', exact: true }).click();
  await expect(dialog.getByText('Delivered', { exact: true }).first()).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  const note = dialog.locator('#print-document');
  await expect(note).toBeVisible();
  await expect(note).toContainText('DELIVERY NOTE');
  await expect(note).toContainText('DELIVERY-E2E');
  await expect(note).toContainText('signature');
  await expect(note).not.toContainText('Price');
  await page.emulateMedia({ media: 'screen' });
  await dialog.getByRole('button', { name: order.number, exact: true }).click();
  await expect(dialog.getByText('Delivered', { exact: true }).first()).toBeVisible();
  await expect(
    dialog.locator('tbody tr').filter({ hasText: 'Paracetamol 500mg' }).first(),
  ).toContainText('4');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Deliveries', exact: true }).click();
  await page.getByRole('tab', { name: 'Delivered', exact: true }).click();
  await expect(page.getByRole('button', { name: delivery.number, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Warehouses', exact: true }).click();
  await page.getByLabel('Movement type').selectOption('sale');
  await expect(page.locator('tbody tr').filter({ hasText: delivery.number })).toContainText(
    'DELIVERY-E2E',
  );
  const state = await saved(page);
  expect(state.orders.find((o: { id: string }) => o.id === order.id).status).toBe('Done');
  expect(state.deliveries.find((d: { id: string }) => d.id === delivery.id)).toMatchObject({
    status: 'Delivered',
    lines: [{ picks: [{ lotCode: 'DELIVERY-E2E', qty: 4 }] }],
  });
  await page.reload();
  expect(
    (await saved(page)).deliveries.find((d: { id: string }) => d.id === delivery.id).status,
  ).toBe('Delivered');
});

test('a quotation confirms, reserves stock in product detail and closes after cancelling the remainder', async ({
  page,
}) => {
  await page.goto('/#orders');
  await page.getByRole('button', { name: 'New quotation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer', { exact: false }).selectOption('c1');
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p1');
  await expect(dialog.getByLabel('Line unit price', { exact: true })).toHaveValue('5.1');
  await expect(dialog.getByText('Special', { exact: true })).toBeVisible();
  await dialog.getByLabel('Line quantity', { exact: true }).fill('4');
  await dialog.getByRole('button', { name: 'Save quotation', exact: true }).click();
  let state = await saved(page);
  const order = state.orders[0];
  expect(order).toMatchObject({
    status: 'Quote',
    customerId: 'c1',
    lines: [{ productId: 'p1', qty: 4, price: 5.1, cancelledQty: 0 }],
  });
  await page.emulateMedia({ media: 'print' });
  await expect(dialog.locator('#print-document')).toBeVisible();
  await expect(dialog.locator('#print-document')).toContainText('QUOTATION');
  await page.emulateMedia({ media: 'screen' });
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create delivery', exact: true })).toBeEnabled();
  state = await saved(page);
  expect(state.orders[0].status).toBe('Confirmed');
  const reservation = state.reservations.find((r: { sourceId: string }) => r.sourceId === order.id);
  expect(reservation).toMatchObject({
    source: 'sales_order',
    productId: 'p1',
    qty: 4,
    status: 'Active',
  });
  await dialog.getByRole('button', { name: 'Paracetamol 500mg', exact: true }).click();
  const row = dialog.locator('tbody tr').filter({ hasText: reservation.number });
  await expect(row).toContainText('4 boxes');
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: order.number, exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel remaining', exact: true }).last().click();
  await dialog.getByLabel('Cancellation reason').fill('Customer cancelled the collection');
  await dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(dialog.getByText('Done', { exact: true }).first()).toBeVisible();
  state = await saved(page);
  expect(state.orders[0]).toMatchObject({ status: 'Done', lines: [{ cancelledQty: 4 }] });
  expect(state.reservations.find((r: { id: string }) => r.id === reservation.id).status).toBe(
    'Released',
  );
  await page.reload();
  expect((await saved(page)).orders[0].status).toBe('Done');
});

test('Clinic price lists fill invoice lines and customer changes reprice defaults while preserving manual prices', async ({
  page,
}) => {
  await page.goto('/#pricing');
  await expect(page.getByRole('heading', { name: 'Price lists', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search prices, product or SKU...' }).fill('AST-0001');
  const cell = page.getByRole('spinbutton', {
    name: 'Clinic price for Paracetamol 500mg (box)',
    exact: true,
  });
  await cell.fill('4.75');
  await cell.press('Tab');
  await expect(page.getByRole('status')).toContainText('Price saved.');
  const before = await saved(page);
  const clinic = before.customerGroups.find((g: { name: string }) => g.name === 'Clinic');
  const customer = before.contacts.find(
    (c: { type: string; groupId: string; onHold: boolean }) =>
      c.type === 'Customer' && c.groupId === clinic.id && !c.onHold,
  );
  expect(
    before.prices.find(
      (e: { productId: string; unit: string; groupId: string }) =>
        e.productId === 'p1' && e.unit === 'box' && e.groupId === clinic.id,
    ).price,
  ).toBe(4.75);
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  await page.getByRole('button', { name: 'New invoice', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer', { exact: false }).selectOption(customer.id);
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p1');
  await expect(dialog.getByLabel('Line unit price', { exact: true })).toHaveValue('4.75');
  await expect(dialog.getByText('Clinic price', { exact: true })).toBeVisible();
  // c4 is a Pharmacy customer without a special price for this product.
  await dialog.getByLabel('Customer', { exact: false }).selectOption('c4');
  await expect(dialog.getByLabel('Line unit price', { exact: true })).toHaveValue('5.8');
  await expect(dialog.getByText('Default', { exact: true })).toBeVisible();
  await dialog.getByLabel('Line unit price', { exact: true }).fill('5.25');
  await dialog.getByLabel('Customer', { exact: false }).selectOption(customer.id);
  await expect(dialog.getByLabel('Line unit price', { exact: true })).toHaveValue('5.25');
  await expect(dialog.getByText('Manual', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  expect((await saved(page)).invoices[0]).toMatchObject({
    customerId: customer.id,
    status: 'Draft',
    lines: [{ productId: 'p1', unit: 'box', price: 5.25 }],
  });
});

test('a customer hold blocks invoice issue with its reason and records an override before issuing', async ({
  page,
}) => {
  await page.goto('/#contacts');
  await page
    .getByRole('button', { name: /Greenlife Pharmacy/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Put on hold', exact: true }).click();
  await dialog.getByLabel('Hold reason').fill('Cheque awaiting clearance');
  await dialog.getByRole('button', { name: 'Put on hold', exact: true }).click();
  await expect(dialog.getByText('On hold', { exact: true })).toBeVisible();
  expect((await saved(page)).contacts.find((c: { id: string }) => c.id === 'c1')).toMatchObject({
    onHold: true,
    holdReason: 'Cheque awaiting clearance',
  });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.goto('/#invoices');
  await page.getByRole('button', { name: 'New invoice', exact: true }).click();
  await dialog.getByLabel('Customer', { exact: false }).selectOption('c1');
  const date = await dialog.getByLabel('Invoice date').inputValue();
  const due = new Date(`${date}T12:00:00`);
  due.setDate(due.getDate() + 30);
  const dueDate = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  await expect(dialog.getByLabel('Due date')).toHaveValue(dueDate);
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p1');
  await dialog.getByLabel('Line quantity', { exact: true }).fill('1');
  const before = await saved(page);
  await dialog.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Account on hold: Cheque awaiting clearance.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Override and issue', exact: true }),
  ).toBeVisible();
  expect(await saved(page)).toEqual(before);
  await dialog.getByLabel('Override reason').fill('Manager approved this collection');
  await dialog.getByRole('button', { name: 'Override and issue', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
  const after = await saved(page);
  expect(after.invoices[0]).toMatchObject({
    status: 'Issued',
    customerId: 'c1',
    creditOverride: {
      by: 'Krisstoff',
      reason: 'Manager approved this collection',
      reasons: ['Account on hold: Cheque awaiting clearance.'],
    },
  });
  expect(new Date(after.invoices[0].creditOverride.at).toISOString()).toBe(
    after.invoices[0].creditOverride.at,
  );
});

test('unreadable workspace data remains downloadable after navigation, mutations and reload', async ({
  page,
}) => {
  const raw = '  { "workspace": "unreadable data", broken JSON\n';
  await page.goto('/#settings');
  await page.evaluate((value) => localStorage.setItem('aster_pharmacy_workspace_v1', value), raw);
  await page.reload();
  const banner = page.getByRole('alert');
  await expect(banner).toContainText('Your saved workspace could not be loaded.');
  expect(await page.evaluate(() => localStorage.getItem('aster_pharmacy_workspace_v1'))).toBe(raw);
  expect(await page.evaluate(() => localStorage.getItem('aster_pharmacy_recovery'))).toBe(raw);
  await page.getByLabel('Company name').fill('Recovery workspace');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await saved(page)).settings.company).toBe('Recovery workspace');
  await page.goto('/#inventory');
  await expect(banner).toBeVisible();
  await page.reload();
  await expect(banner).toBeVisible();
  expect((await saved(page)).settings.company).toBe('Recovery workspace');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    banner.getByRole('button', { name: 'Download unreadable data', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('aster-unreadable-data.json');
  const stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toBe(raw);
  expect(await page.evaluate(() => localStorage.getItem('aster_pharmacy_recovery'))).toBe(raw);
  await expect(banner).toBeVisible();
});

test('hold stock lowers Free, converts to a reserved invoice, and is fulfilled on issue', async ({
  page,
}) => {
  await page.goto('/#inventory');
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('AST-0001');
  const row = page.locator('main tbody tr').filter({ hasText: 'Paracetamol 500mg' });
  const freeBefore = Number(
    (await row.locator('td').nth(4).locator('span.block').first().innerText()).replace(
      /[^\d-]/g,
      '',
    ),
  );
  await row.getByRole('button', { name: /Paracetamol 500mg.*AST-0001/ }).click();
  await page.getByRole('button', { name: 'Hold stock', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer').selectOption('c1');
  await dialog.getByLabel('Quantity (boxes)').fill('10');
  await dialog.getByLabel('Note').fill('Browser reservation flow');
  await dialog.getByRole('button', { name: 'Hold stock', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Reservations', exact: true })).toBeVisible();
  let state = await saved(page);
  const hold = state.reservations.find(
    (r: { note: string }) => r.note === 'Browser reservation flow',
  );
  expect(hold).toMatchObject({ source: 'hold', status: 'Active', qty: 10 });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(row.locator('td').nth(4)).toContainText(
    `${(freeBefore - 10).toLocaleString('en-US')} boxes`,
  );
  await page.goto('/#contacts');
  await page
    .getByRole('button', { name: /Greenlife Pharmacy/ })
    .first()
    .click();
  const holdRow = dialog.locator('tbody tr').filter({ hasText: hold.number });
  await holdRow.getByRole('button', { name: 'Create invoice', exact: true }).click();
  await expect(dialog.getByLabel('Customer')).toHaveValue('c1');
  await expect(dialog.getByLabel('Line product', { exact: true })).toHaveValue('p1');
  await expect(dialog.getByLabel('Line quantity', { exact: true })).toHaveValue('10');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByText('Reserved', { exact: true })).toBeVisible();
  state = await saved(page);
  const invoice = state.invoices[0];
  expect(state.reservations.find((r: { id: string }) => r.id === hold.id).status).toBe('Released');
  expect(
    state.reservations.find((r: { sourceId: string }) => r.sourceId === invoice.id),
  ).toMatchObject({ qty: 10, status: 'Active' });
  await dialog.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
  state = await saved(page);
  expect(state.invoices.find((i: { id: string }) => i.id === invoice.id).status).toBe('Issued');
  expect(
    state.reservations.find((r: { sourceId: string }) => r.sourceId === invoice.id).status,
  ).toBe('Fulfilled');
  await page.goto('/#inventory');
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('AST-0001');
  await expect(row.locator('td').nth(4)).toContainText(
    `${(freeBefore - 10).toLocaleString('en-US')} boxes`,
  );
});

test('reorder levels turn a reviewed supplier group into a PO and remove its suggestions', async ({
  page,
}) => {
  await page.goto('/#inventory');
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('AST-0001');
  await page.getByRole('button', { name: /Paracetamol 500mg.*AST-0001/ }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByRole('heading', { name: 'Reorder levels' })).toBeVisible();
  const branchRule = detail.locator('form').filter({ hasText: 'Riverside branch' });
  await branchRule.getByLabel('Min (boxes)').fill('250');
  await branchRule.getByLabel('Max (boxes)').fill('1000');
  await branchRule.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(detail).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.goto('/#purchasing');
  await page.getByRole('button', { name: 'Reorder suggestions', exact: true }).click();
  await page.getByLabel('Reorder warehouse').selectOption('wh_branch');
  const group = page
    .locator('main section[aria-label]')
    .filter({ hasText: 'Paracetamol 500mg' })
    .first();
  const groupLabel = await group.getAttribute('aria-label');
  const products = await group.locator('tbody .table-link').allTextContents();
  expect(products.length).toBeGreaterThan(0);
  await group.getByRole('button', { name: 'Create purchase order' }).click();
  const form = page.getByRole('dialog');
  await expect(form.getByLabel('Receiving warehouse')).toHaveValue('wh_branch');
  await expect(form.getByLabel('Supplier', { exact: false })).not.toHaveValue('');
  await expect(form.getByLabel('Line product', { exact: true })).toHaveCount(products.length);
  await expect(form.getByLabel('Line unit').first()).toHaveValue('carton');
  await form.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(page.getByRole('region', { name: groupLabel!, exact: true })).toHaveCount(0);
  const state = await saved(page);
  expect(state.purchases[0]).toMatchObject({ status: 'Draft', warehouseId: 'wh_branch' });
  expect(state.purchases[0].lines.map((l: { name: string }) => l.name)).toEqual(products);
});

test('short-dated consent, recall call list, CSV and recall write-off stay connected', async ({
  page,
}) => {
  await page.goto('/#settings');
  await page.getByLabel('Minimum shelf life on sale (days)').fill('180');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.goto('/#inventory');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Product name', { exact: false }).fill('Expiry workflow product');
  await page.getByRole('dialog').getByLabel('SKU', { exact: false }).fill('EXPIRY-006');
  await page.getByLabel('Default purchase cost').fill('2');
  await page.getByLabel('Selling price').fill('5');
  await page.getByLabel('Preferred supplier').selectOption('s1');
  await page.getByRole('dialog').getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('EXPIRY-006');
  await page.getByRole('button', { name: 'Receive Expiry workflow product', exact: true }).click();
  await page.getByLabel('Batch / lot number').fill('EXPIRY-LOT');
  await page.getByLabel('Quantity (boxes)').fill('10');
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 90);
  const expiryDate = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`;
  await page.getByLabel('Expiry date', { exact: false }).fill(expiryDate);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Receive stock', exact: true })
    .click();
  let state = await saved(page);
  const product = state.products.find((p: { sku: string }) => p.sku === 'EXPIRY-006');
  await page.goto('/#invoices');
  await page.getByRole('button', { name: 'New invoice', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Customer', { exact: false }).selectOption('c1');
  await page.getByLabel('Line product', { exact: true }).selectOption(product.id);
  await expect(
    page.getByRole('dialog').getByText('0 boxes free · 0 reserved', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Allow short-dated stock').check();
  await page.getByLabel('Line quantity', { exact: true }).fill('3');
  await expect(
    page.getByRole('dialog').getByText('10 boxes free · 0 reserved', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(`EXPIRY-LOT (expires ${expiryDate})`);
  await page.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  state = await saved(page);
  expect(state.invoices[0].allowShortDated).toBe(true);
  await page.goto('/#batches');
  await page.getByRole('textbox', { name: 'Search product or batch number...' }).fill('EXPIRY-LOT');
  await page.getByLabel('Batch status').selectOption('Short-dated');
  await expect(page.locator('main tbody tr')).toContainText('Short-dated');
  await page.getByRole('button', { name: 'View batch EXPIRY-LOT', exact: true }).click();
  await page.getByRole('button', { name: 'Start recall', exact: true }).click();
  await page.getByLabel('Reason', { exact: false }).fill('Supplier notice: seal defect');
  await page.getByRole('dialog').getByRole('button', { name: 'Start recall', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Sold to');
  await expect(page.getByRole('dialog')).toContainText(
    state.contacts.find((c: { id: string }) => c.id === 'c1').name,
  );
  await expect(
    page.getByRole('dialog').getByRole('row').filter({ hasText: state.invoices[0].number }),
  ).toContainText('3');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('dialog').getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^aster-recall-RCL-\d+-.*\.csv$/);
  const stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toContain(state.invoices[0].number);
  await page.getByRole('button', { name: 'Write off', exact: true }).click();
  await expect(page.getByLabel('Reason', { exact: false })).toHaveValue('recall');
  await page.getByRole('button', { name: 'Adjust stock', exact: true }).click();
  state = await saved(page);
  expect(state.adjustments[0]).toMatchObject({ reason: 'recall', qty: -7 });
  await page.locator('.tab-bar').getByRole('button', { name: 'Recalls', exact: true }).click();
  await page.getByRole('button', { name: state.recalls[0].number, exact: true }).click();
  await page.getByRole('button', { name: 'Close recall', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.badge')).toHaveText('Closed');
  expect((await saved(page)).recalls[0].status).toBe('Closed');
});

test('pharma fields, cold warehouse pickers, retirement and controlled register export stay connected', async ({
  page,
}) => {
  await page.goto('/#inventory');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('Product name', { exact: false }).fill('Pharma workflow medicine');
  await dialog.getByLabel('SKU', { exact: false }).fill('PHARMA-005');
  await page.getByLabel('Registration no.', { exact: true }).fill(' reg-ui-005 ');
  await page.getByLabel('Manufacturer', { exact: true }).fill('Test manufacturing');
  await page.getByLabel('Dosage form', { exact: false }).selectOption('injection');
  await page.getByLabel('Strength', { exact: true }).fill('100 IU/ml');
  await page.getByLabel('Prescription only', { exact: true }).check();
  await page.getByLabel('Controlled substance', { exact: true }).check();
  await dialog.getByLabel('Storage', { exact: false }).selectOption('cold');
  await page.getByLabel('Default purchase cost').fill('2');
  await page.getByLabel('Selling price').fill('5');
  await page.getByLabel('Preferred supplier').selectOption('s1');
  await dialog.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('PHARMA-005');
  await page.getByLabel('Product storage', { exact: true }).selectOption('cold');
  await page.getByLabel('Rx', { exact: true }).selectOption('yes');
  await page.getByLabel('Controlled', { exact: true }).selectOption('yes');
  await expect(page.locator('main tbody tr')).toHaveCount(1);
  await expect(page.locator('main tbody tr')).toContainText('Rx');
  await expect(page.locator('main tbody tr')).toContainText('CD');
  await expect(page.locator('main tbody tr')).toContainText('❄ Cold');
  await page.getByRole('button', { name: 'Edit Pharma workflow medicine', exact: true }).click();
  await page.getByLabel('Active', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page.getByText('No results found', { exact: true })).toBeVisible();
  await page.getByLabel('Show inactive', { exact: true }).check();
  await expect(page.locator('main tbody tr')).toContainText('Inactive');
  await page.getByRole('button', { name: 'Edit Pharma workflow medicine', exact: true }).click();
  await page.getByLabel('Active', { exact: true }).check();
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await page.getByRole('button', { name: 'Receive Pharma workflow medicine', exact: true }).click();
  await expect(dialog.getByLabel('Warehouse', { exact: false }).locator('option')).toHaveCount(2);
  await expect(dialog.getByLabel('Warehouse', { exact: false })).toHaveValue('wh_cold');
  await expect(dialog).toContainText('Cold-chain product — cold storage only');
  await page.getByLabel('Batch / lot number').fill('PHARMA-LOT');
  await page.getByLabel('Quantity (boxes)').fill('10');
  await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
  await page.locator('main .table-product').filter({ hasText: 'Pharma workflow medicine' }).click();
  await expect(dialog).toContainText('REG-UI-005');
  await expect(dialog).toContainText('Test manufacturing');
  await expect(dialog).toContainText('100 IU/ml');
  await dialog.getByRole('button', { name: 'Edit product', exact: true }).click();
  await expect(page.getByLabel('Active', { exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Pharma workflow medicine still has stock or open documents.');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const state = await saved(page);
  const product = state.products.find((p: { sku: string }) => p.sku === 'PHARMA-005');
  const batch = state.batches.find((b: { productId: string }) => b.productId === product.id);
  await page.goto('/#batches');
  await page.getByRole('button', { name: 'Transfer stock', exact: true }).click();
  await page.getByLabel('Source batch', { exact: false }).selectOption(batch.id);
  await expect(
    page.getByLabel('Destination warehouse', { exact: false }).locator('option'),
  ).toHaveCount(2);
  await expect(dialog).toContainText('Cold-chain product — cold storage only');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.goto('/#purchasing');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await page.getByLabel('Line product', { exact: true }).selectOption(product.id);
  await expect(page.getByLabel('Receiving warehouse', { exact: false })).toHaveValue('wh_cold');
  await expect(
    page.getByLabel('Receiving warehouse', { exact: false }).locator('option'),
  ).toHaveCount(2);
  await expect(dialog).toContainText('Cold-chain product — cold storage only');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.goto('/#batches');
  await page.getByRole('button', { name: 'Controlled substances register', exact: true }).click();
  await page.getByLabel('Register product', { exact: true }).selectOption(product.id);
  await expect(page.locator('main tbody tr')).toHaveCount(1);
  await expect(page.locator('main tbody tr')).toContainText('PHARMA-LOT');
  await expect(page.locator('main tbody tr td').last()).toHaveText('10');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^aster-controlled-register-.*\.csv$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain('"Date","Reference","Counterparty","Lot","In","Out","Balance"');
  expect(csv).toContain('"PHARMA-LOT","10","0","10"');
});

test('blind stock count hides expectations, reviews a difference and posts a count adjustment', async ({
  page,
}) => {
  await page.goto('/#warehouses');
  await page.getByRole('button', { name: 'Stock counts', exact: true }).click();
  await page.getByRole('button', { name: 'Start count', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Warehouse', { exact: false })
    .selectOption('wh_branch');
  await page.getByLabel('Blind count').check();
  await page.getByLabel('Note', { exact: true }).fill('Browser shelf count');
  await page.getByRole('dialog').getByRole('button', { name: 'Start count', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Count sheet', exact: true })).toBeVisible();
  await expect(
    page.getByRole('dialog').getByRole('columnheader', { name: 'Expected', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('dialog').getByRole('columnheader', { name: 'Difference', exact: true }),
  ).toHaveCount(0);
  let state = await saved(page);
  const count = state.stockCounts[0];
  const warehouse = state.warehouses.find((w: { id: string }) => w.id === count.warehouseId);
  await expect(
    page.getByText(
      `Counting in progress (${count.number}) — stock movements in ${warehouse.name} are paused.`,
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByLabel('Scan / search', { exact: true }).fill(count.lines[0].lotCode);
  await page.getByLabel('Scan / search', { exact: true }).press('Enter');
  await expect(page.getByLabel(`Counted ${count.lines[0].lotCode}`, { exact: true })).toBeFocused();
  const packLine = count.lines.find((line: { productId: string }) =>
    state.products
      .find((p: { id: string }) => p.id === line.productId)
      .packs.some((pack: { barcode: string }) => pack.barcode),
  );
  const packProduct = state.products.find((p: { id: string }) => p.id === packLine.productId);
  const pack = packProduct.packs[0];
  await page.getByLabel('Scan / search', { exact: true }).fill(pack.barcode);
  await page.getByLabel('Scan / search', { exact: true }).press('Enter');
  await expect(page.getByLabel(`Counted ${packLine.lotCode}`, { exact: true })).toBeFocused();
  const packRow = page
    .getByRole('dialog')
    .locator('tr')
    .filter({ has: page.getByLabel(`Counted ${packLine.lotCode}`, { exact: true }) });
  await packRow.getByRole('button', { name: '+ packs', exact: true }).click();
  await page.getByLabel(`Packs for ${packLine.lotCode}`, { exact: false }).fill('3');
  await page
    .getByLabel(`Extra ${packProduct.unit}s for ${packLine.lotCode}`, { exact: false })
    .fill('12');
  await page.getByRole('button', { name: 'Save packs + base units', exact: true }).click();
  await expect(page.getByLabel(`Counted ${packLine.lotCode}`, { exact: true })).toHaveValue(
    String(3 * pack.factor + 12),
  );
  for (let index = 0; index < count.lines.length; index++) {
    const line = count.lines[index];
    await page
      .getByLabel(`Counted ${line.lotCode}`, { exact: true })
      .fill(String(line.expected + (index === 0 ? -1 : 0)));
  }
  await expect(page.getByRole('dialog')).toContainText(
    `${count.lines.length} / ${count.lines.length} counted`,
  );
  await expect(
    page.getByRole('dialog').getByRole('columnheader', { name: 'Expected', exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('dialog').locator('.count-sheet-print')).toBeVisible();
  await expect(page.getByLabel(`Counted ${count.lines[0].lotCode}`, { exact: true })).toHaveCSS(
    'display',
    'none',
  );
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Review & post', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review count differences', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('dialog').locator('tbody tr')).toContainText(count.lines[0].lotCode);
  await page.getByRole('button', { name: 'Confirm posting', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Post count', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adjustments', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const adjustment = page.locator('main tbody tr').first();
  await expect(adjustment).toContainText('Count difference');
  await expect(adjustment).toContainText(count.lines[0].lotCode);
  state = await saved(page);
  expect(state.stockCounts[0].status).toBe('Posted');
  expect(state.adjustments[0]).toMatchObject({
    qty: -1,
    reason: 'count',
    note: count.number,
    sourceId: count.id,
    user: 'Krisstoff',
  });
  await expect(page.getByText(/^Counting in progress/)).toHaveCount(0);
});

test('partial adjustments, found stock, filtered exports, and write off all stay connected', async ({
  page,
}) => {
  await page.goto('/#batches');
  await page.getByRole('button', { name: 'Receive stock', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Product', { exact: false }).selectOption('p1');
  await page.getByLabel('Batch / lot number').fill('ADJUST-E2E');
  await page.getByLabel('Quantity (boxes)').fill('120');
  await page.getByLabel('Unit cost per box').fill('3');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Receive stock', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Search product or batch number...' }).fill('ADJUST-E2E');
  await page.getByRole('button', { name: 'View batch ADJUST-E2E', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Adjust stock', exact: true }).click();
  await page.getByLabel('Quantity (boxes)').fill('105');
  await page.getByLabel('Reason', { exact: false }).selectOption('damaged');
  await page.getByLabel('Note', { exact: false }).fill('Crushed boxes found during handling.');
  await expect(page.getByText('2 cartons + 5 boxes', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Stock 120 → 15 boxes · Inventory −$315.00', { exact: true }),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Adjust stock', exact: true }).click();
  let state = await saved(page);
  const batch = state.batches.find((b: { code: string }) => b.code === 'ADJUST-E2E');
  const removed = state.adjustments[0];
  expect(batch.qty).toBe(15);
  expect(removed).toMatchObject({
    qty: -105,
    value: -315,
    reason: 'damaged',
    user: 'Krisstoff',
    batchId: batch.id,
  });
  expect(state.stockMoves.at(-1)).toMatchObject({
    type: 'adjustment',
    sourceId: removed.id,
    reference: removed.number,
    qty: -105,
  });
  expect(state.journal[0].entries).toEqual([
    { account: 'loss', debit: 315, credit: 0 },
    { account: 'inventory', debit: 0, credit: 315 },
  ]);
  await page.getByRole('button', { name: 'View batch ADJUST-E2E', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Adjust stock', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Quantity (boxes)').fill('2');
  await expect(page.getByLabel('Reason', { exact: false })).toHaveValue('found');
  await page
    .getByLabel('Note', { exact: false })
    .fill('Recovered intact boxes from the packing shelf.');
  await expect(
    page.getByText('Stock 15 → 17 boxes · Inventory +$6.00', { exact: true }),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Adjust stock', exact: true }).click();
  state = await saved(page);
  const found = state.adjustments[0];
  expect(found).toMatchObject({ qty: 2, value: 6, reason: 'found' });
  await page.goto('/#warehouses');
  await page.locator('.tab-bar').getByRole('button', { name: 'Adjustments', exact: true }).click();
  await page.getByLabel('Adjustment warehouse').selectOption('wh_main');
  await page.getByLabel('Adjustment reason').selectOption('found');
  await page.getByLabel('Date from').fill(found.date);
  await page.getByLabel('Date to').fill(found.date);
  const row = page.locator('tbody tr').first();
  await expect(row).toContainText(found.number);
  await expect(row).toContainText('ADJUST-E2E');
  await expect(row).toContainText('+2');
  await expect(row).toContainText('+$6.00');
  await expect(row).toContainText('Krisstoff');
  await expect(page.getByText('1–1 of 1 records', { exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^aster-adjustments-.*\.csv$/);
  const stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv.trim().split('\r\n')).toHaveLength(2);
  expect(csv).toContain(`"${found.number}"`);
  expect(csv).toContain('"Found","Krisstoff"');
  await page.locator('.tab-bar').getByRole('button', { name: 'Stock ledger', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Search ledger products, SKU, barcode...' })
    .fill('Paracetamol');
  await page.getByLabel('Movement type').selectOption('adjustment');
  await expect(page.locator('tbody')).toContainText(found.number);
  await expect(page.locator('tbody')).toContainText(removed.number);
  await page
    .locator('tbody tr')
    .filter({ hasText: found.number })
    .getByRole('button', { name: 'ADJUST-E2E', exact: true })
    .click();
  await expect(page.getByRole('dialog').locator('tbody')).toContainText(removed.number);
  await expect(page.getByRole('dialog').locator('tbody')).toContainText(found.number);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Write off all', exact: true })
    .click();
  await expect(page.getByLabel('Quantity (boxes)')).toHaveValue('17');
  await expect(page.getByLabel('Quantity (boxes)')).toBeDisabled();
  await page.getByLabel('Reason', { exact: false }).selectOption('lost');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Write off all', exact: true })
    .click();
  state = await saved(page);
  expect(state.batches.find((b: { id: string }) => b.id === batch.id).qty).toBe(0);
  expect(state.adjustments[0]).toMatchObject({ qty: -17, value: -51, reason: 'lost' });
  await page.goto('/#accounting');
  await expect(page.getByText('Stock write-offs & adjustments', { exact: true })).toBeVisible();
});

test('packaging, carton receipts, barcode sales, and mixed purchase units stay connected', async ({
  page,
}) => {
  await page.goto('/#inventory');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Product name', { exact: false }).fill('Carton workflow product');
  await page.getByRole('dialog').getByLabel('SKU', { exact: false }).fill('PACK-TEST');
  await page.getByLabel('Barcode (optional)', { exact: true }).fill('PACK-BASE');
  await page.getByLabel('Default purchase cost').fill('2.9');
  await page.getByLabel('Selling price', { exact: false }).fill('5');
  await page.getByLabel('Preferred supplier').selectOption('s1');
  await page.getByRole('button', { name: 'Add pack', exact: true }).click();
  await page.getByLabel('Pack unit').selectOption('carton');
  await page.getByLabel('Contains (boxes)').fill('20');
  await page.getByLabel('Pack barcode (optional)').fill('PACK-CARTON');
  await page.getByLabel('Pack sale price (optional)').fill('90');
  await page.getByRole('button', { name: 'Add pack', exact: true }).click();
  await page.getByLabel('Pack unit').nth(1).selectOption('case');
  await page.getByLabel('Contains (boxes)').nth(1).fill('100');
  await page.getByLabel('Pack barcode (optional)').nth(1).fill('PACK-CASE');
  await page.getByRole('dialog').getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('PACK-TEST');
  await page.getByRole('button', { name: 'Receive Carton workflow product', exact: true }).click();
  await page.getByLabel('Receipt unit').selectOption('carton');
  await expect(page.getByLabel('Unit cost per carton')).toHaveValue('58');
  await page.getByLabel('Unit cost per carton').fill('58.50');
  await page.getByLabel('Quantity (cartons)').fill('3');
  await page.getByLabel('Batch / lot number').fill('PACK-RECEIPT');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Receive stock', exact: true })
    .click();
  await expect(page.locator('tbody tr').first()).toContainText('60 boxes');
  let state = await saved(page);
  const product = state.products.find((p: { sku: string }) => p.sku === 'PACK-TEST');
  expect(product.packs.map((p: { unit: string; factor: number }) => [p.unit, p.factor])).toEqual([
    ['carton', 20],
    ['case', 100],
  ]);
  expect(state.batches.find((b: { code: string }) => b.code === 'PACK-RECEIPT')).toMatchObject({
    qty: 60,
    cost: 2.93,
  });
  await page.getByRole('button', { name: 'Edit Carton workflow product', exact: true }).click();
  await expect(page.getByLabel('Base unit')).toBeDisabled();
  await expect(
    page.getByText("The base unit can't change after stock or documents exist."),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.goto('/#invoices');
  await page.getByRole('button', { name: 'New invoice', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Customer', { exact: false }).selectOption('c1');
  await page.getByLabel('Scan barcode').fill('PACK-CARTON');
  await page.getByLabel('Scan barcode').press('Enter');
  await page.getByLabel('Scan barcode').fill('PACK-CARTON');
  await page.getByLabel('Scan barcode').press('Enter');
  await expect(page.getByLabel('Line product', { exact: true })).toHaveValue(product.id);
  await expect(page.getByLabel('Line unit', { exact: true })).toHaveValue('carton');
  await expect(page.getByLabel('Line quantity', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Line unit price', { exact: true })).toHaveValue('90');
  await expect(page.getByRole('dialog').getByText('= 40 boxes', { exact: true })).toBeVisible();
  await page.getByLabel('Scan barcode').fill('PACK-BASE');
  await page.getByLabel('Scan barcode').press('Enter');
  await page.getByLabel('Line quantity', { exact: true }).nth(1).fill('10');
  await expect(page.getByRole('dialog').locator('.invoice-total')).toContainText('$230.00');
  await page.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Credit limit $3000.00 exceeded',
  );
  await page.getByLabel('Override reason').fill('Manager approved this carton sale.');
  await page.getByRole('button', { name: 'Override and issue', exact: true }).click();
  await expect(page.getByRole('dialog').locator('#print-document')).toContainText('2 cartons');
  await expect(page.getByRole('dialog').locator('#print-document')).toContainText('10 boxes');
  state = await saved(page);
  expect(
    state.invoices[0].lines.map((l: { unit: string; factor: number }) => [l.unit, l.factor]),
  ).toEqual([
    ['carton', 20],
    ['box', 1],
  ]);
  expect(
    state.deliveries
      .filter((d: { id: string }) => state.invoices[0].deliveryIds.includes(d.id))
      .flatMap((d: { lines: { picks: { qty: number }[] }[] }) => d.lines.flatMap((l) => l.picks))
      .reduce((n: number, p: { qty: number }) => n + p.qty, 0),
  ).toBe(50);
  expect(state.batches.find((b: { code: string }) => b.code === 'PACK-RECEIPT').qty).toBe(10);
  await page.goto('/#purchasing');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Supplier', { exact: false }).selectOption('s1');
  await page.getByLabel('Scan barcode').fill('PACK-CARTON');
  await page.getByLabel('Scan barcode').press('Enter');
  await expect(page.getByLabel('Line unit cost', { exact: true })).toHaveValue('58');
  await page.getByLabel('Line unit cost', { exact: true }).fill('58.50');
  await page.getByLabel('Line quantity', { exact: true }).fill('3');
  await page.getByLabel('Scan barcode').fill('PACK-BASE');
  await page.getByLabel('Scan barcode').press('Enter');
  await page.getByLabel('Line quantity', { exact: true }).nth(1).fill('5');
  await page.getByRole('button', { name: 'Save & send', exact: true }).click();
  await page
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: 'Receive', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('3 cartons (= 60 boxes)');
  await page.getByLabel('Actual batch / lot number').nth(0).fill('PACK-PO-CARTON');
  await page.getByLabel('Actual batch / lot number').nth(1).fill('PACK-PO-BOX');
  await page.getByLabel('Actual expiry date').nth(0).fill('2030-12-31');
  await page.getByLabel('Actual expiry date').nth(1).fill('2030-12-31');
  await page.getByRole('dialog').getByRole('button', { name: 'Receive', exact: true }).click();
  state = await saved(page);
  expect(state.purchases[0].status).toBe('Received');
  expect(
    state.batches
      .filter((b: { productId: string }) => b.productId === product.id)
      .reduce((n: number, b: { qty: number }) => n + b.qty, 0),
  ).toBe(75);
  expect(state.journal[0].entries).toEqual([
    { account: 'inventory', debit: 190.3, credit: 0 },
    { account: 'payable', debit: 0, credit: 190 },
    { account: 'loss', debit: 0, credit: 0.3 },
  ]);
  await page.goto('/#inventory');
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('PACK-TEST');
  await page.getByRole('button', { name: 'Edit Carton workflow product', exact: true }).click();
  await page.getByRole('button', { name: 'Remove pack', exact: true }).nth(1).click();
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toContainText('3 cartons + 15 boxes');
  await page.getByRole('button', { name: /Carton workflow product PACK-TEST/ }).click();
  await expect(page.getByRole('dialog')).toContainText('3 cartons + 15 boxes');
  await page.getByRole('button', { name: /PACK-PO-CARTON/ }).click();
  await expect(page.getByRole('dialog')).toContainText('3 cartons');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search workspace' }).fill('PACK-CARTON');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: /Carton workflow product/ }),
  ).toBeVisible();
});

test('stock ledger connects receipts, lot history, past stock, and filtered CSV', async ({
  page,
}) => {
  await page.goto('/#inventory');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Product name', { exact: false }).fill('Stock ledger test product');
  await page.getByRole('dialog').getByLabel('SKU', { exact: false }).fill('LEDGER-001');
  await page.getByLabel('Default purchase cost').fill('2');
  await page.getByLabel('Selling price').fill('5');
  await page.getByLabel('Preferred supplier').selectOption('s1');
  await page.getByRole('dialog').getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search products, SKU, barcode...' }).fill('LEDGER-001');
  await page
    .getByRole('button', { name: 'Receive Stock ledger test product', exact: true })
    .click();
  await page.getByLabel('Batch / lot number').fill('LEDGER-LOT');
  await page.getByLabel('Quantity (boxes)').fill('25');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Receive stock', exact: true })
    .click();
  const state = await saved(page);
  const move = state.stockMoves.at(-1);
  expect(move).toMatchObject({
    type: 'receipt',
    qty: 25,
    reference: expect.stringMatching(/^GRN-/),
    counterpartyId: 's1',
    user: 'Krisstoff',
  });
  const previous = new Date(`${move.date}T12:00:00`);
  previous.setDate(previous.getDate() - 1);
  const previousDate = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(previous.getDate()).padStart(2, '0')}`;
  await page.getByLabel('As of date').fill(previousDate);
  await expect(page.getByText(/^Showing stock as of/)).toBeVisible();
  await expect(page.locator('tbody tr').first().locator('td').nth(2)).toContainText('0');
  await page.getByLabel('As of date').fill(move.date);
  await expect(page.locator('tbody tr').first().locator('td').nth(2)).toContainText('25');
  await page.getByRole('button', { name: /Stock ledger test product LEDGER-001/ }).click();
  await page.getByRole('button', { name: 'View stock history', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stock ledger', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Clear product: Stock ledger test product' }),
  ).toBeVisible();
  await page.getByLabel('Ledger warehouse').selectOption('wh_main');
  await page.getByLabel('Movement type').selectOption('receipt');
  await page.getByLabel('Date from').fill(move.date);
  await page.getByLabel('Date to').fill(move.date);
  const row = page.locator('tbody tr').first();
  await expect(row).toContainText('LEDGER-LOT');
  await expect(row).toContainText('+25');
  await expect(row).toContainText('Krisstoff');
  await expect(page.getByText('1–1 of 1 records', { exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^aster-stock-ledger-.*\.csv$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain('"Date","Reference","Product","Lot","Warehouse","Type","Qty","User"');
  expect(csv.trim().split('\r\n')).toHaveLength(2);
  expect(csv).toContain('"LEDGER-LOT"');
  await row.getByRole('button', { name: 'LEDGER-LOT', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Movement history', exact: true })).toBeVisible();
  const history = page.getByRole('dialog').locator('tbody tr').first();
  await expect(history).toContainText('+25');
  await expect(history.locator('td').nth(4)).toHaveText('25');
  await expect(history).toContainText('Krisstoff');
});
test('all screens render without console or React errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  for (const [route, title] of [
    ['dashboard', 'Warehouse overview'],
    ['inventory', 'Inventory'],
    ['batches', 'Batches & expiry'],
    ['warehouses', 'Warehouses'],
    ['purchasing', 'Purchasing'],
    ['invoices', 'Invoices'],
    ['pricing', 'Price lists'],
    ['accounting', 'Accounting'],
    ['analytics', 'Business analytics'],
    ['contacts', 'Contacts'],
    ['settings', 'Workspace settings'],
  ]) {
    await page.goto(`/#${route}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Data & backups', exact: true }).click();
  await expect(page.getByText('Saved on this browser')).toBeVisible();
  await page.getByRole('button', { name: 'Workspace guide', exact: true }).last().click();
  await expect(page.getByText('01 · Build your catalog')).toBeVisible();
  await page.goto('/#accounting');
  for (const tab of ['General ledger', 'Payables', 'Expenses', 'Accounts', 'Overview']) {
    await page.locator('.tab-bar').getByRole('button', { name: tab, exact: true }).click();
    await expect(page.locator('main .panel').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('stock, invoices, payments, purchases, expenses, search, and backups remain connected', async ({
  page,
}) => {
  await page.goto('/#inventory');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await page.getByLabel('Product name', { exact: false }).fill('React migration test product');
  await page.getByRole('dialog').getByLabel('SKU', { exact: false }).fill('REACT-TEST');
  await page.getByLabel('Default purchase cost').fill('2');
  await page.getByLabel('Selling price').fill('5');
  await page.getByLabel('Preferred supplier').selectOption('s1');
  await page.getByRole('dialog').getByRole('button', { name: 'Add product', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Search products, SKU, barcode...' })
    .fill('React migration');
  await expect(
    page.getByRole('button', { name: /React migration test product REACT-TEST/ }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Receive React migration test product', exact: true })
    .click();
  await page.getByLabel('Batch / lot number').fill('REACT-BATCH');
  await page.getByLabel('Quantity (boxes)').fill('25');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Receive stock', exact: true })
    .click();
  let state = await saved(page);
  const product = state.products.find((p: { sku: string }) => p.sku === 'REACT-TEST');
  expect(state.batches.find((b: { code: string }) => b.code === 'REACT-BATCH').qty).toBe(25);
  await page.goto('/#invoices');
  await page.getByRole('button', { name: 'New invoice' }).click();
  await page.getByRole('dialog').getByLabel('Customer', { exact: false }).selectOption('c1');
  await page.getByLabel('Line product', { exact: true }).selectOption(product.id);
  await page.getByLabel('Line quantity', { exact: true }).fill('3');
  await expect(page.getByRole('dialog').locator('.invoice-total')).toContainText('$15.00');
  await page.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Record payment' }),
  ).toBeVisible();
  state = await saved(page);
  expect(state.batches.find((b: { code: string }) => b.code === 'REACT-BATCH').qty).toBe(22);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Record payment', exact: true })
    .click();
  await page.getByLabel('Payment amount').fill('5');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Record payment', exact: true })
    .click();
  state = await saved(page);
  expect(state.invoices[0].paid).toBe(5);
  expect(state.invoices[0].total).toBe(15);
  await page.goto('/#purchasing');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Supplier', { exact: false }).selectOption('s1');
  await page.getByLabel('Line product', { exact: true }).selectOption(product.id);
  await page.getByLabel('Line quantity', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Save & send', exact: true }).click();
  await page
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: 'Receive', exact: true })
    .click();
  await page.getByLabel('Actual batch / lot number').fill('REACT-ORDER');
  await page.getByLabel('Actual expiry date').fill('2030-12-31');
  await page.getByRole('dialog').getByRole('button', { name: 'Receive', exact: true }).click();
  state = await saved(page);
  expect(state.purchases[0].status).toBe('Received');
  expect(state.batches.find((b: { code: string }) => b.code === 'REACT-ORDER').qty).toBe(4);
  await page.goto('/#accounting');
  await page.getByRole('button', { name: 'Add expense', exact: true }).click();
  await page.getByLabel('Description', { exact: false }).fill('Migration delivery');
  await page.getByLabel('Amount ($)', { exact: false }).fill('12');
  await page.getByRole('button', { name: 'Record expense', exact: true }).click();
  state = await saved(page);
  expect(state.expenses[0].amount).toBe(12);
  await page.keyboard.press('Control+k');
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Search workspace' })
    .fill('REACT-TEST');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /React migration test product/ })
    .click();
  await expect(page.getByRole('dialog')).toContainText('REACT-TEST');
  await page.keyboard.press('Escape');
  await page.reload();
  expect(
    (await saved(page)).products.find((p: { sku: string }) => p.sku === 'REACT-TEST'),
  ).toBeTruthy();
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Data & backups', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download backup', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^aster-backup-.*\.json$/);
  const backup = await saved(page);
  await page.getByLabel('Restore backup file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByRole('dialog')).toContainText('Restore this backup?');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  expect((await saved(page)).products.length).toBe(31);
});

test('mobile navigation, modal focus, and empty/reset flows work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Warehouse overview' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('nav').getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(page.getByLabel('Product name', { exact: false })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add product', exact: true })).toBeFocused();
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Data & backups', exact: true }).click();
  await page.getByRole('button', { name: 'Start empty workspace' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start empty', exact: true }).click();
  expect((await saved(page)).reorderRules).toEqual([]);
  await page.reload();
  await page.getByLabel('Company name').fill('Empty workspace pharmacy');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await saved(page)).products).toEqual([]);
  expect((await saved(page)).settings.company).toBe('Empty workspace pharmacy');
  expect(await page.evaluate(() => localStorage.getItem('aster_pharmacy_recovery'))).toBeNull();
  await page.goto('/#dashboard');
  await expect(page.getByText('No invoices yet')).toBeVisible();
  await page.goto('/#analytics');
  await expect(page.getByText('No sales this period')).toBeVisible();
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Data & backups', exact: true }).click();
  await page.getByRole('button', { name: 'Reset sample data' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore samples' }).click();
  expect((await saved(page)).products.length).toBe(30);
});

test('one customer payment settles two invoices, keeps extra credit and applies it to the next invoice', async ({
  page,
}) => {
  await page.goto('/#invoices');
  const dialog = page.getByRole('dialog');
  // A fresh customer makes the allocation list and available credit unambiguous.
  await page.getByRole('button', { name: /Contacts/ }).click();
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await dialog.getByLabel('Business / contact name').fill('Payment allocation customer');
  await dialog.getByRole('button', { name: 'Save contact', exact: true }).click();
  const customerId = (await saved(page)).contacts.find(
    (c: { name: string }) => c.name === 'Payment allocation customer',
  ).id;
  await page
    .getByRole('button', { name: /Invoices/ })
    .first()
    .click();
  const issued: { id: string; number: string; total: number }[] = [];
  for (let n = 0; n < 2; n++) {
    await page.getByRole('button', { name: 'New invoice', exact: true }).click();
    await dialog.getByLabel('Customer', { exact: false }).selectOption(customerId);
    await dialog.getByLabel('Line product', { exact: true }).selectOption('p3');
    await dialog.getByLabel('Line quantity', { exact: true }).fill('1');
    await dialog.getByRole('button', { name: 'Issue invoice', exact: true }).click();
    issued.push((await saved(page)).invoices[0]);
    await page.getByRole('button', { name: 'Close dialog' }).click();
  }
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await dialog.getByLabel('Customer', { exact: false }).selectOption(customerId);
  const extra = 2;
  await dialog
    .getByLabel('Payment amount ($)')
    .fill(String(issued[0].total + issued[1].total + extra));
  await dialog.getByLabel('Payment method').selectOption('Bank transfer');
  await dialog.getByLabel('Reference').fill('TWO-INVOICES-007');
  await expect(dialog.getByText('$2.00 kept as credit', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Record payment', exact: true }).click();
  for (const invoice of issued) {
    await page.getByPlaceholder('Search invoice or customer...').fill(invoice.number);
    await expect(
      page.getByRole('row').filter({ hasText: invoice.number }).getByText('Paid', { exact: true }),
    ).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Payments', exact: true }).click();
  const paymentRow = page.getByRole('row').filter({ hasText: 'TWO-INVOICES-007' });
  await expect(paymentRow).toContainText('$2.00');
  await paymentRow.getByRole('button').click();
  await expect(dialog.locator('#print-document')).toContainText('OFFICIAL RECEIPT');
  await expect(dialog.locator('#print-document')).toContainText(issued[0].number);
  await expect(dialog.locator('#print-document')).toContainText(issued[1].number);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'New invoice', exact: true }).click();
  await dialog.getByLabel('Customer', { exact: false }).selectOption(customerId);
  await dialog.getByLabel('Line product', { exact: true }).selectOption('p3');
  await dialog.getByLabel('Line quantity', { exact: true }).fill('1');
  await dialog.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(dialog.getByText('Payments & credits', { exact: true })).toBeVisible();
  const result = await saved(page);
  expect(result.invoices[0].paid).toBe(extra);
  const payment = result.payments.find(
    (p: { reference: string }) => p.reference === 'TWO-INVOICES-007',
  );
  expect(payment.allocations).toHaveLength(3);
  expect(payment.allocations[2].invoiceId).toBe(result.invoices[0].id);
  expect(payment.allocations[2].amount).toBe(extra);
  await page.reload();
  expect((await saved(page)).invoices[0].paid).toBe(extra);
});

test('supplier lead time, last purchase price hint, and minimum order warning in PO form', async ({
  page,
}) => {
  await page.goto('/#contacts');
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Edit BioHealth Pharma' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Lead time (days)').fill('7');
  await dialog.getByLabel('Minimum order ($, optional)').fill('600');
  await dialog.getByRole('button', { name: 'Save contact', exact: true }).click();
  await expect(dialog).not.toBeVisible();

  const savedSupplier = (await saved(page)).contacts.find((c: { id: string }) => c.id === 's2');
  expect(savedSupplier.leadTimeDays).toBe(7);
  expect(savedSupplier.minOrderValue).toBe(600);

  await page.goto('/#purchasing');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Supplier', { exact: false }).selectOption('s2');

  const today = new Date();
  const shifted = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
  const expectedDate = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
  await expect(dialog.getByLabel('Expected delivery')).toHaveValue(expectedDate);

  await dialog.getByLabel('Line product', { exact: true }).selectOption('p2');
  await expect(dialog.getByLabel('Line unit cost', { exact: true })).toHaveValue('8.2');
  await expect(dialog.getByText(/Last paid \$8\.20 on .* \((PO-0209|GRN-\d+)\)/)).toBeVisible();
  await expect(
    dialog.getByText("BioHealth Pharma's minimum order is $600.00. This order is $8.20."),
  ).toBeVisible();

  const submit = dialog.getByRole('button', { name: 'Save draft', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).not.toBeVisible();

  const po = (await saved(page)).purchases[0];
  expect(po.supplierId).toBe('s2');
  expect(po.expected).toBe(expectedDate);
  expect(po.total).toBe(8.2);
});

test('purchase order approval workflow and print layout (spec 002)', async ({ page }) => {
  await page.goto('/#purchasing');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  const form = page.getByRole('dialog');
  await expect(form).toBeVisible();

  // Select supplier MediCore Distribution (s1)
  await form.getByLabel('Supplier', { exact: false }).selectOption('s1');
  // Select product Paracetamol 500mg (p1)
  await form.getByLabel('Line product', { exact: true }).selectOption('p1');
  // Fill unit cost 50 and qty 50 -> subtotal 2500 > 2000 approval limit
  await form.getByLabel('Line unit cost', { exact: true }).fill('50');
  await form.getByLabel('Line quantity', { exact: true }).fill('50');

  // Verify callout appears: "Orders over $2,000.00 need approval before they're sent."
  await expect(
    form.getByText("Orders over $2,000.00 need approval before they're sent."),
  ).toBeVisible();

  // Verify "Save & send" button is disabled
  const saveAndSend = form.getByRole('button', { name: 'Save & send', exact: true });
  await expect(saveAndSend).toBeDisabled();

  // Save draft
  await form.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(form).not.toBeVisible();

  // Find the newly created PO in the Purchasing table
  const newRow = page.locator('tbody tr').filter({ hasText: '$2,500.00' }).first();
  await expect(newRow).toBeVisible();
  await expect(newRow.getByText('Draft')).toBeVisible();
  await expect(newRow.getByText('Needs approval')).toBeVisible();

  // Open detail dialog
  await newRow.locator('.table-link').first().click();
  const detail = page.getByRole('dialog');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.badge').filter({ hasText: 'Draft' }).first()).toBeVisible();
  await expect(
    detail.locator('.badge').filter({ hasText: 'Needs approval' }).first(),
  ).toBeVisible();

  // Approve the PO with optional note
  await detail.getByRole('button', { name: 'Approve', exact: true }).click();
  await detail.getByLabel('Approval note (optional)').fill('Approved for quarterly stock');
  await detail.getByRole('button', { name: 'Confirm approval', exact: true }).click();

  // Approval record should be displayed
  await expect(
    detail.getByText(/Approved by Krisstoff on .*Approved for quarterly stock/).first(),
  ).toBeVisible();

  // Send the PO
  await detail.getByRole('button', { name: 'Send', exact: true }).click();

  // PO is now Sent
  await expect(detail.locator('.badge').filter({ hasText: 'Sent' }).first()).toBeVisible();

  // Print / PDF button is visible
  await expect(detail.getByRole('button', { name: 'Print / PDF', exact: true })).toBeVisible();
});

test('partial receiving, changed price, multiple lots, and remainder completion (spec 003)', async ({
  page,
}) => {
  await page.goto('/#purchasing');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  const form = page.getByRole('dialog');
  await expect(form).toBeVisible();

  // Create PO with 2 lines: p1 (qty 10, cost $2) and p2 (qty 20, cost $3)
  await form.getByLabel('Supplier', { exact: false }).selectOption('s1');
  await form.getByLabel('Line product', { exact: true }).nth(0).selectOption('p1');
  await form.getByLabel('Line quantity', { exact: true }).nth(0).fill('10');
  await form.getByLabel('Line unit cost', { exact: true }).nth(0).fill('2.00');

  await form.getByRole('button', { name: 'Add another product', exact: true }).click();
  await form.getByLabel('Line product', { exact: true }).nth(1).selectOption('p2');
  await form.getByLabel('Line quantity', { exact: true }).nth(1).fill('20');
  await form.getByLabel('Line unit cost', { exact: true }).nth(1).fill('3.00');

  await form.getByRole('button', { name: 'Save & send', exact: true }).click();
  await expect(form).not.toBeVisible();

  // Find the PO row in Purchasing table
  const poRow = page.locator('tbody tr').filter({ hasText: 'MediCore Distribution' }).first();
  await expect(poRow).toBeVisible();
  await expect(poRow.locator('.badge').filter({ hasText: 'Sent' })).toBeVisible();

  // Open Receive form
  await poRow.getByRole('button', { name: 'Receive', exact: true }).click();
  const receiveDialog = page.getByRole('dialog');
  await expect(receiveDialog).toBeVisible();

  await receiveDialog.getByLabel('Supplier invoice / delivery note no.').fill('INV-TEST-003');

  // Change actual price on line 1 from 2.00 to 2.40 (should show +$0.40 vs PO)
  await receiveDialog.getByLabel('Actual cost per box ($)').nth(0).fill('2.40');
  await expect(receiveDialog.getByText('+$0.40 vs PO')).toBeVisible();

  // Split lot on line 1
  await receiveDialog.getByRole('button', { name: 'Split lot', exact: true }).nth(0).click();

  // Line 1 now has two lots: receive 4 in first lot, 3 in second lot (7 total of 10)
  await receiveDialog.getByLabel('Receive now (boxes)').nth(0).fill('4');
  await receiveDialog.getByLabel('Actual batch / lot number').nth(0).fill('LOT-1A');
  await receiveDialog.getByLabel('Actual expiry date').nth(0).fill('2030-12-31');

  await receiveDialog.getByLabel('Receive now (boxes)').nth(1).fill('3');
  await receiveDialog.getByLabel('Actual batch / lot number').nth(1).fill('LOT-1B');
  await receiveDialog.getByLabel('Actual expiry date').nth(1).fill('2031-06-30');

  // Line 2: receive 0 for now (skip line)
  await receiveDialog
    .getByLabel(/Receive now/)
    .nth(2)
    .fill('0');

  // Footer summary should be present
  await expect(receiveDialog.getByText(/Bill total .* ordered value .* difference/)).toBeVisible();

  // Submit partial receive
  await receiveDialog.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(receiveDialog).not.toBeVisible();

  // PO now shows 'Partly received'
  await expect(
    page.locator('tbody tr').filter({ hasText: 'Partly received' }).first(),
  ).toBeVisible();

  // Check Receipts & bills tab
  await page.getByRole('button', { name: 'Receipts & bills', exact: true }).click();
  const grnRow = page.locator('tbody tr').filter({ hasText: 'INV-TEST-003' }).first();
  await expect(grnRow).toBeVisible();

  // Open receipt detail
  await grnRow.locator('.table-link').first().click();
  const receiptModal = page.getByRole('dialog');
  await expect(receiptModal).toBeVisible();
  await expect(receiptModal.getByText('+$0.40')).toBeVisible();
  await receiptModal.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(receiptModal).not.toBeVisible();

  // Switch back to Purchase orders tab and receive remainder
  await page.getByRole('button', { name: 'Purchase orders', exact: true }).click();
  const partlyRow = page.locator('tbody tr').filter({ hasText: 'Partly received' }).first();
  await partlyRow.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(receiveDialog).toBeVisible();

  // Remaining open quantities should default in: 3 for line 1, 20 for line 2
  await receiveDialog.getByLabel('Actual batch / lot number').nth(0).fill('LOT-1C');
  await receiveDialog.getByLabel('Actual expiry date').nth(0).fill('2030-12-31');

  await receiveDialog.getByLabel('Actual batch / lot number').nth(1).fill('LOT-2A');
  await receiveDialog.getByLabel('Actual expiry date').nth(1).fill('2030-12-31');

  await receiveDialog.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(receiveDialog).not.toBeVisible();

  // PO is now fully Received
  const finishedState = await saved(page);
  const finishedPo = finishedState.purchases[0];
  expect(finishedPo.status).toBe('Received');
  await expect(
    page.locator('tbody tr').filter({ hasText: finishedPo.number }).first().getByText('Received'),
  ).toBeVisible();
});
