import { expect, test, type Page } from '@playwright/test';

async function saved(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem('aster_pharmacy_workspace_v1') || 'null'),
  );
}

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
  await form.getByRole('button', { name: 'Create purchase order', exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(page.getByRole('region', { name: groupLabel!, exact: true })).toHaveCount(0);
  const state = await saved(page);
  expect(state.purchases[0]).toMatchObject({ status: 'Ordered', warehouseId: 'wh_branch' });
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
    state.invoices[0].allocations.reduce((n: number, a: { qty: number }) => n + a.qty, 0),
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
  await page.getByRole('button', { name: 'Create purchase order', exact: true }).click();
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
  await page.getByRole('button', { name: 'Receive all items', exact: true }).click();
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
    reference: 'LEDGER-LOT',
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
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
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
  await page.getByRole('button', { name: 'Create purchase order', exact: true }).click();
  await page
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: 'Receive', exact: true })
    .click();
  await page.getByLabel('Actual batch / lot number').fill('REACT-ORDER');
  await page.getByLabel('Actual expiry date').fill('2030-12-31');
  await page.getByRole('button', { name: 'Receive all items', exact: true }).click();
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
