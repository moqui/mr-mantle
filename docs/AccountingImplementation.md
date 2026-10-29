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
