# 001 — Customer accounts

## Goal
Give every customer the commercial settings a wholesaler needs:
- a **group** (used for pricing in 002)
- **payment terms**
- a **credit limit**
- a manual **credit hold**
- a **billing habit**

Then use them to decide whether a new sale is allowed.

## Data model
```ts
export interface CustomerGroup {
  id: string;            // uid('grp')
  name: string;          // unique, e.g. "Pharmacy", "Clinic", "Hospital"
  discountPercent: number; // used by 002; default 0
}
Workspace.customerGroups: CustomerGroup[];

// Contact additions (customers only; suppliers keep the defaults)
groupId: string;               // '' = no group
paymentTermsDays: number;      // 0 = due on the invoice date; default settings.defaultPaymentTermsDays
creditLimit: number | null;    // USD; null = no limit; 0 = no credit allowed (must prepay)
onHold: boolean;               // manual credit hold
holdReason: string;
billing: 'per_delivery' | 'monthly';  // billing habit, default 'per_delivery'

// Settings additions
defaultPaymentTermsDays: number;  // default 30, integer 0..365
overdueGraceDays: number;         // default 7, integer 0..365
```
`discountPercent` belongs to 002, but add the field here with value `0`, so groups are created once.

## Rules

### Groups
- Names are trimmed, 2–40 characters, and unique (case-insensitive).
- A group in use by a customer can't be deleted. Error: `<group> is used by <n> customers.`
- `saveCustomerGroup(s, data, id?)`, `deleteCustomerGroup(s, id)`.

### Customer fields
Validated in `saveContact`:
- `paymentTermsDays` is an integer from 0 to 365.
- `creditLimit` is `null` or a money value ≥ 0.
- `holdReason` is required when `onHold` is true.
- `groupId` is `''` or an existing group.
- Supplier contacts ignore these fields and store the defaults.

### Due dates
Any new invoice's due date **defaults** to invoice date + `paymentTermsDays`. The user can still change it. This applies to the existing invoice form now, and later to 003 and 005.

### Credit check
One shared function, used by 003 (confirm order) and 005 (issue invoice, including direct counter sales):
```ts
creditCheck(s, customerId, addAmount: number): {
  ok: boolean;
  reasons: string[];        // human-readable, all that apply
  exposure: number;         // see below
  limit: number | null;
  overdue: number;          // amount overdue beyond the grace period
}
```
**Exposure** = everything the customer owes or has committed to:
- open invoice balances (`total − paid − credited`)
- \+ value of deliveries not yet invoiced (005; 0 until then)
- \+ value of confirmed but undelivered order lines (003; 0 until then)
- − available customer credit (007; 0 until then)
- \+ `addAmount`

**Blocked (`ok: false`) when any of these is true:**
1. `onHold` → `Account on hold: <holdReason>.`
2. `creditLimit !== null` and exposure > `creditLimit` → `Credit limit $<limit> exceeded (exposure $<exposure>).`
3. Any issued invoice is more than `overdueGraceDays` past its due date and still has a balance → `$<amount> is overdue by more than <n> days.`

Build `creditCheck` so later specs only **add terms** to the exposure. Mark the places with `// 003:`, `// 005:`, `// 007:` comments.

### Override
Blocked operations accept `override?: { reason: string }`. The reason is required (trimmed, at least 5 characters). The operation stores:
```ts
creditOverride: { by: string; at: string; reason: string; reasons: string[] }
```
`by` is `CURRENT_USER`, `at` is an ISO timestamp, and `reasons` is the list from `creditCheck`. Add this comment: `// ponytail: anyone can override until roles exist; restrict to managers then`.

**In this spec:** apply the check to `issueInvoice` (direct sales). Add `creditOverride?` to `Invoice`. 003 and 005 reuse the same pattern.

## Migration
| Field | Default |
|---|---|
| `customerGroups` | `[]` |
| `Contact.groupId` | `''` |
| `Contact.paymentTermsDays` | `settings.defaultPaymentTermsDays` (30) |
| `Contact.creditLimit` | `null` |
| `Contact.onHold` | `false` |
| `Contact.holdReason` | `''` |
| `Contact.billing` | `'per_delivery'` |
| `settings.defaultPaymentTermsDays` | `30` |
| `settings.overdueGraceDays` | `7` |

## Backup validation
- Groups have valid, unique names and `0 ≤ discountPercent ≤ 100`.
- Contact fields are in range, and `groupId` references an existing group or is `''`.
- Settings ranges are valid.
- `creditOverride`, when present, has a non-empty `by` and `reason` and a valid `at`.

## UI
1. **Settings › Company:** *Default payment terms (days)* and *Overdue grace period (days)*.
2. **Customer groups:** a small manager (list, add, rename, delete) in **Contacts → "Customer groups"** tab.
3. **Contact form** (customers only), new section **Account**:
   - group select
   - payment terms (days)
   - credit limit ($, empty = no limit)
   - billing habit (*Invoice each delivery* or *Monthly billing*)
   - **On hold** checkbox with a reason
4. **Contact detail:**
   - an **Account** summary: group, terms, limit, current exposure, overdue amount, a status badge (`OK`, `On hold`, `Over limit`, `Overdue`)
   - a **Put on hold / Release hold** action
5. **Contacts list:** group column, plus a status badge when not `OK`.
6. **Invoice form:** the due date auto-fills from the customer's terms. When `creditCheck` fails on issue, show the reasons and an **Override and issue** button. It asks for a reason, then calls the operation with `override`.

## Sample data
- Groups:

  | Group | Discount |
  |---|---|
  | Pharmacy | 0% |
  | Clinic | 3% |
  | Hospital | 8% |

- Assign every seed customer to a group:
  - Greenlife and Lotus → Pharmacy
  - CarePlus and Wellness → Clinic
  - Sunrise → Hospital
- Terms: Sunrise 60 days, Lotus 0 (pays on delivery), the rest 30.
- Credit limits:
  - Greenlife $3,000, set so it's **close to** its current exposure
  - Lotus `0`
  - Sunrise `null`
  - the others $5,000
- Billing: Sunrise and Wellness `monthly`, the rest `per_delivery`.
- Put **Wellness Medical Center** on hold with reason *"Cheque returned unpaid"*.

## Tests
- Due date defaults to invoice date + terms.
- `creditCheck`:
  - on hold → blocked, with the reason
  - over limit → blocked
  - `creditLimit: null` → never blocked by the limit
  - `0` → any credit sale is blocked
  - overdue beyond grace → blocked; within grace → OK
  - several reasons are all listed
- `issueInvoice` without override is blocked and changes nothing. With override it succeeds and stores `creditOverride` with user and reasons. A reason shorter than 5 characters throws.
- A group in use can't be deleted. Duplicate group names throw.
- Migration fills the defaults idempotently, and invariants hold.

## Acceptance criteria
- [ ] Customers have a group, payment terms, a credit limit, a hold flag and a billing habit.
- [ ] Sales to customers on hold, over their limit, or with old overdue invoices are blocked, unless someone overrides with a recorded reason.
- [ ] Invoice due dates follow the customer's terms.
