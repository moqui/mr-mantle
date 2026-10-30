# Accounting native implementation

P1 establishes `AccountingPolicy`, permission-derived capabilities, organization/record checks, scoped queries,
draft document creation, draft journal headers, search documents and read-only setup health. The additive model
contains the locks, dimensions, previews, templates, content and audit fields needed by P2/P3; adoption flags default
to N. No new service references BOSS. Existing financial mutation authorization remains unchanged.

P2 adds the opt-in choke-point guard, typed locks and named exceptions, read-only verification, reviewed
fingerprints and PostingOperation identities, dated reversal and forward issuance deltas. Journal batches use
one transaction per constituent for validation and posting. Templates publish immutable versions and instantiate
unposted drafts. Account assignment dates, required dimensions and scoped journal content are enforced natively.
Reports keep currencies separate and read stored closed-period summaries or live open-period postings.

P3 adds SetupServices configuration validation and conflict-preview cloning, due-only terms, manual dated
CurrencyServices rates and CSV import outcomes, and payment method metadata/masking. PaymentGatewayOrganization
is provisioned outside finance forms; active organization bindings constrain new method gateway choices. The
configuration forms never receive credentials or executable service names. Posted accounting basis and issued
identities are preserved. Generic missing invoice-item defaults are checked using the native invoice resolver;
product and category mappings retain its established precedence.

AccountingControls uses spec-local permission groups and covers authorization with artifact checks disabled,
read-only verification, stale previews, concurrent retries, changed-key reuse, lock scopes/expiry/hard boundaries,
closed parents, required dimensions, rollback, reversals, partial batches, immutable templates, attachments,
cloning conflicts, dated rates/CSV failures, masking, gateway bindings and mapping repair. AccountingReports checks
separate currencies, comparison calculations and stored closed summaries. The original ledger baseline remains
18/18 passing. Final full results are recorded in mr-boss/docs/AccountingImplementation.md, including the four
unchanged baseline failures. Revaluation and Projects billing regressions execute with the installed Chrome PDF
renderer. No Node test dependency or BOSS group/service reference was added to a native service, data file or spec.

Final integration: 863 standalone features, 842 passed, four pre-existing failures and 17 skipped. The unchanged
b48e696c baseline reproduces InboxThreads, MantleSearch, WorkTimeEntries and WorkTimesheets. The focused native
controls/reports, original ledger baseline, Products standard costs/revaluation and Projects billing pass 82/82.
Journal/template/payment writers round to the selected currency; clone previews identify destination-incompatible
mappings without blocking independent compatible rows.

Authorized invoice/bill reads compute totals through the existing read-only InvoiceServices.get#InvoiceTotal when
stored totals are absent. The parent record's permission and organization checks precede the child calculation.

Document projections include public or actor-owned counterparty names after the parent record is authorized;
other users' private names are omitted even when artifact authorization is disabled.

## Receivables, settlement and payment lifecycle

P4 implements native invoice state guards, durable sending/batches and statements. P5a implements authoritative
open items, retained atomic settlement and automatic application, with exact retry, actual source backing, SQL posting
days and adopted application/source guards. Their acceptance records and commits are in
[Accounting implementation](../../mr-boss/docs/AccountingImplementation.md).

P5b1 adds native payment list/detail/method reads, reviewed drafts, validate/deliver/confirm/cancel/void and selected
unapplication. Authoritative revisions include actual source/method/posting evidence. Direct cash restoration reverses
the complete direct set and posts its exact unapplied replacement at the unchanged original SQL day. Ordinary release
and void use the actual applications and separate postings; closed history refuses atomically. Exact state/unapply
controllers join PostingGuard validation while the same actor's unreviewed Ledger reversal remains refused.

Issued payment outputs and frozen evidence retain immutable resource identities, versions, blobs and bytes. Native
archive/private-drive guards also cover raw/generic writes, shares, public tokens, searches and aliased locations.
First-reference issuance and raw mutations serialize on stable archive ancestors, including shared deduplicated blobs;
new unpublished upload identities remain compatible with independent storage transactions. Real races verify exact
hashes and ordinary source replacement; an isolated control without the shared blob lock reproduces corruption.

PaymentValidation stores event-bound publication and per-recipient delivery identity, independent permission/private/
organization checks, guarded decisions and durable retirement. Commit workers retain the immutable actor instead of
depending on interactive login state. Native services and tests have no BOSS dependency. Provider operations and
refunds/transfers remain the subsequent P5b2/P5b3 contracts; their actions are unavailable in this slice.

Final native server gate: 1,074 passed, the same four reproduced baseline failures, 17 skipped, 1,095 features across
117 specs. All 75 added native cases pass. BOSS's full suite passes 1,145 with no failures and five skips; all seven
payment browser walks and independent output review pass. XML validation and unchanged screen-lint findings are recorded
with the app's verification. Current user scope completes P5 and pauses before P6 with a recorded checkpoint.

## Reviewed provider operations P5b2a

Native gateway instructions retain reviewed organization, currency, SQL day, source/method/binding revisions and
operation identity. Durable reservation, provider invocation, typed evidence and local completion are separate
transactions. Authorization parents never post or settle cash; each partial capture creates its own exact cash
Payment, posting and issued outputs. Pending, uncertain and accepted-unposted outcomes retain capacity. Exact lookup
cannot initiate another provider operation; reviewed recovery completes only the original accepted local money.

Private dispatch preparation validates fresh locked method and subtype values and passes those exact credentials
by value after releasing financial locks. Safe adapters explicitly guarantee that contract. Current credential
rotation does not alter exact lookup identity. Provider ancestors never acquire financial-finalizer admission.

Legacy provider wrappers, configured leaves, refund links, order/invoice loops and polling exclude native records.
Permanent independently committed admission fences serialize old I/O against first adoption, including caller rollback.
Common guards protect both original and candidate application/source identities, accepted cash provenance and original
postings even when adoption is later disabled. Ordinary GL descriptions and reconciliation remain editable.

The full standalone gate has 1,160 features across 130 specs: 1,139 pass, the same four reproduced baseline failures
and 17 skips. All 65 added cases pass, including actual permission loss, competing capacity writes, caller rollback,
credential contention, retained large evidence, unsafe legacy entry and initially unmanaged source/adoption races.
The final safe identity/recovery DTO corrections pass their focused checks. Final BOSS acceptance passes 1,162/0/5
and all 78 browser cases with independent visual review. Implementation commits are Mantle `5c24c2fa` and BOSS
`4b92e2c`; the app's implementation record retains the detailed verification. Manual/provider refunds
and transfers remain P5b2b/P5b3; execution pauses after their P5 checkpoint and before P6.

## P5b2b1 manual refunds

Owner-bound reviews and `refund#ReviewedPayment` create opposite cash and its exact original-funding application,
verify both actual postings, and retain immutable backing, events, evidence and child-owned issued documents in one
transaction. Partial and multiple customer/supplier refunds use the original logical finance side. Fully allocated
cash requires a separately reviewed unapplication first. Clean legacy manual cash can adopt under the permanent
provider fence; verified old refunds without native backing records remain readable and require a separate historical
review before new native refunds. Malformed financial history is incomplete rather than an invented zero balance.

Common entity/posting boundaries protect the original, refund child and exact funding even with adoption flags N.
Unrelated invoice allocations may still be unapplied. Manual cash remains manual when a bank later acquires provider
route metadata; original actual financial provenance governs. A held provider draft is unavailable to lifecycle,
application and cash-posting writers, including before it receives a gateway role.

Per the user's code-completion priority, this delivery uses independent code review and focused server checks instead
of further browser/screenshot cycles. The first frozen money/invariant/concurrency/shared-regression gate passes all
45 cases; the app gate passes 24, including real Treasury/admin money, exact retries and actual child-owned documents.
The final 25-case gate also passes, including all 21 new native cases; 53 distinct focused native cases pass across the two gates. Acceptance commits are recorded in the app's implementation plan.

## P5b2b2 provider refunds

Reference-based refunds bind actual completed capture money and reuse the strict refund cash/application core.
Original capture reference/merchant/currency remain authoritative through credential rotation/expiry and exact lookup.
Two durable capacity holds and an optional reviewed draft claim survive pending, uncertain and accepted-unposted
states. Accepted local completion consumes them in the same transaction as exact opposite cash, funding, immutable
backing, events and issued documents. Caller rollback restores held capacity and the clean draft. A changed financial
plan requires newly reviewed recovery; the provider operation is never repeated for financial repair.

Independent review accepts all production/shared corrections. All 13 added native cases pass; the final focused gate's
44 cases pass across its 43-pass run and corrected one-case fixture rerun. BOSS passes 34/34 including all eight new
provider cases. Further screenshot/browser/full-suite cycles are omitted under the user's code-completion priority.
Transfers remain the last P5 assignment; execution pauses before P6. Detailed findings and commits are in the app plan.

## P5b3 paired transfers and checkpoint

`preview#InternalTransfer`, `get#InternalTransferPreview` and `create#InternalTransfer` now provide one reviewed atomic
pair with exact retry identity. Source cash is principal plus explicit expense fee; destination cash is principal.
Exactly two verified transactions clear one shared transit account. Two distinct owned methods may share a cash GL;
one-sided Payment method slots and immutable leg identity preserve independent reconciliation. Native reads derive
cash direction from the leg. The operation invokes no legacy org-self autoposter and creates no trade application.

Common guards permanently protect paired money/GL identity with flags N. Current authority, private organization,
fresh banking/subtype/policy/account rows, fiscal/typed locks and base currency are checked under lock. Each leg owns
one immutable detail output; it cannot issue a check or receipt. Default transit mappings now include the missing
258300000 template assignment. An explicitly targeted inert test fixture proves rollback after the first actual
posting, followed by same-key success; it grants no financial admission.

Independent review is complete. The final focused native gate passes 45/45 across 13 specs, all 10 added transfer cases;
BOSS passes 40/40 including its eight added cases. Changed XML validates and screen lint has no new failures/sites.
Further screenshots/browser/full-suite sweeps were omitted under the user's code-completion priority. P0–P5 are code
complete; execution is paused before P6. See the app plan for commits, earlier complete-suite evidence and deferrals.
