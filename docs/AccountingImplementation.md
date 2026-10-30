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
with the app's verification. Current user scope completes P6 and pauses before P7.
