# 002 — Purchase order lifecycle

## Goal
Make the purchase order a real working document:
- start as a **Draft** that can be edited freely
- big orders need **approval** before they go out
- **Send** it (print or save a PDF for the supplier), which marks it as ordered
- keep it **editable until the goods arrive**
- cancel it with a reason if the order falls through

Today `createPurchase` makes an `Ordered` PO that can't be edited, and there's no approval or print.

## Data model
```ts
export interface PurchaseApproval {
  by: string;          // CURRENT_USER
  at: string;          // ISO timestamp
  amount: number;      // the PO total that was approved
  note: string;
}
// Purchase — changed / new fields
status: 'Draft' | 'Sent' | 'Received' | 'Canceled';   // 'Ordered' is gone (migrates to 'Sent')
approval?: PurchaseApproval;
sentAt?: string;      // business date the PO was sent
sentBy?: string;
createdAt: string;    // ISO
createdBy: string;
cancelReason?: string;

// Settings
poApprovalLimit: number;   // USD; POs with total above this need approval. 0 = approval off. Default 2000.
```
`PurchaseInput` gains `send?: boolean`.

## Operations

### `approvalRequired(s, po): boolean`
`s.settings.poApprovalLimit > 0 && po.total > s.settings.poApprovalLimit && !(po.approval && po.approval.amount >= po.total)`

### `createPurchase(s, data)` (change)
- Same validation as today (plus 001's price defaults). The PO starts as **`Draft`**, with `createdAt` / `createdBy`.
- When `data.send` is true, call `sendPurchase` in the same transaction. If approval is required, that throws and nothing is saved.
- The reorder-suggestion prefill (inventory 007) still opens the form; it simply creates a Draft.

### `savePurchase(s, data, id)` (new: edit)
- The PO must be `Draft` or `Sent`, error `Only open purchase orders can be edited.`
- The **supplier** can only change while `Draft`, error `The supplier can't change after the order was sent. Cancel it and create a new one.`
- Re-validate everything like `createPurchase` and recompute `total`. Keep `number`, `createdAt`, `createdBy`, `approval`, `sentAt`.
- **Re-approval:** if after the edit `approvalRequired(s, po)` is true and the PO had an `approval`, the edit raised the total above the approved amount:
  - remove `approval`
  - if it was `Sent`, set it back to `Draft` and clear `sentAt` / `sentBy`
  - activity `Purchase order changed — needs approval again`
- Leave a marker for 003: `// 003: lines already received can't be removed or go below the received qty`.

### `approvePurchase(s, id, note = '')`
- `Draft`, error `Only draft purchase orders can be approved.`
- The total must be above the limit, error `This purchase order doesn't need approval.`
- Set `approval = { by: CURRENT_USER, at: now, amount: po.total, note: note.trim() }`. Activity `Purchase order approved`.
- `// ponytail: anyone can approve until roles exist; restrict to managers then` (same as the sales credit override).

### `sendPurchase(s, id, date = today())`
- `Draft`, error `Only draft purchase orders can be sent.`
- `!approvalRequired(s, po)`, error `Purchase orders over $<limit> need approval before sending.` (format the limit with 2 decimals).
- `po.date ≤ date ≤ today()`, error `Send date must be between the order date and today.`
- Status `Sent`, `sentAt = date`, `sentBy = CURRENT_USER`. Activity `Purchase order sent`.
- Sending doesn't email anything. The UI offers Print / PDF right after.

### `cancelPurchase(s, id, reason = '')` (change)
- `Draft` or `Sent`, error `Only open purchase orders can be canceled.`
- A `Sent` PO needs a reason (the supplier has to be told), error `Enter a reason for canceling a sent order.`
- Set `cancelReason`. Status `Canceled`.
- Leave a marker for 003: `// 003: refuse when anything was received`.

### `receivePurchase` (change)
Accept only `Sent` POs. A Draft throws `Send this purchase order before receiving it.` Everything else is unchanged until 003.

### `onOrder` (inventory 007)
Count lines of **`Draft` and `Sent`** POs (was `Ordered`), so reorder suggestions don't suggest the same thing twice.

### `setPurchaseSettings(s, { poApprovalLimit })`
`moneyCheck(value, 'Approval limit')`, must be ≥ 0.

## Migration
- `Ordered` → `Sent`, with `sentAt = po.date` and `sentBy = CURRENT_USER`.
- Every PO without `createdAt` gets `${po.date}T00:00:00.000Z`, and `createdBy = CURRENT_USER`.
- `Received` and `Canceled` POs keep their status. Migrated POs get no `approval`.
- `Settings.poApprovalLimit` defaults to `2000`.

## Backup validation
- Status is one of the four. `Sent` and `Received` POs have `sentAt` (a valid date) and `sentBy`. `Draft` POs have neither.
- `approval`, when present, has `by`, `at`, a `moneyCheck`-valid `amount`, and a string `note`.
- `poApprovalLimit` passes `moneyCheck` and is ≥ 0.

## UI
1. **Purchase order form:**
   - Footer buttons: **Save draft** and **Save & send**. *Save & send* is disabled with a hint when approval is required.
   - The same form opens for **editing** a Draft or Sent PO (from the detail view). The supplier field is locked when the PO is Sent.
   - When the total is above the limit, show a `Callout`: *"Orders over $2,000.00 need approval before they're sent."*
2. **Purchase order detail:**
   - Status badge, plus a **Needs approval** badge when `approvalRequired`.
   - *Approved by Krisstoff on 17 Oct* (with the note) when approved.
   - Actions by status:
     - Draft: **Edit**, **Approve** (only when the total is over the limit; asks for an optional note), **Send**, **Cancel order**
     - Sent: **Edit**, **Print / PDF**, **Receive**, **Cancel order** (asks for a reason)
   - **Print / PDF** layout (reuse the print pattern from `orders.tsx`): company header from Settings, *PURCHASE ORDER*, number, order date, expected delivery, supplier name / address / phone, deliver-to warehouse name and address, lines (product, SKU, qty, unit, cost, total), order total, notes, and *Approved by* when approved.
3. **Purchasing page, Purchase orders tab:** the status filter offers `Draft`, `Sent`, `Received`, `Canceled`. The row action is *Send* for Drafts and *Receive* for Sent POs. The *Open purchase orders* metric counts Draft + Sent.
4. **Settings:** *Purchase approval limit ($)*, with the hint *"0 turns approval off."*
5. **Badge colours:** `Draft` (if it doesn't already have one), `Sent`, `Needs approval`, `Approved`.

## Sample data
- The two existing open seed POs are **sent** through `sendPurchase`.
- Add one **Draft** PO over $2,000 from MediCore Distribution that is **waiting for approval**.
- Add one PO over $2,000 that was **approved** (note "Quarterly stock-up") and **sent**.
- The historical received POs in the seed are created, sent and then received, through the operations.

## Tests
- `createPurchase` makes a Draft. With `send: true` it's Sent, and over the limit without approval it throws and saves nothing.
- `approvePurchase`:
  - records the user, time, amount and note
  - refuses a PO under the limit, and a non-Draft
- `sendPurchase`:
  - refuses when approval is required, with the spec's message
  - works after approval, and when the limit is `0`
  - refuses a date before the order date or in the future
- `savePurchase`:
  - edits a Draft and a Sent PO and recomputes the total
  - refuses a supplier change on a Sent PO
  - raising an approved Sent PO above its approved amount clears the approval and returns it to Draft
  - lowering it keeps the approval
- `cancelPurchase` needs a reason for a Sent PO, not for a Draft.
- `receivePurchase` refuses a Draft.
- `onOrder` counts Draft and Sent lines.
- Migration: an `Ordered` PO in a v3 backup becomes `Sent` with `sentAt = date`. Invariants hold.
- **Browser test:** create a PO over the limit, see *Save & send* disabled, save the draft, approve it, send it, and see it as *Sent* with the Print / PDF button.

## Acceptance criteria
- [ ] POs start as Drafts and can be edited until they're received.
- [ ] POs over the approval limit can't be sent until approved; the approval is recorded.
- [ ] Raising an approved PO above the approved amount requires approval again.
- [ ] A sent PO can be printed / saved as PDF for the supplier.
- [ ] Old `Ordered` POs load as `Sent`.
