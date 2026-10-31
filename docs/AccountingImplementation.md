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

## Receivables (P4)

P4 and P5 use Mantle's existing services and extend them with parameters; the review R2 in mr-boss's
`plan/impl-accounting.md` removed what P4–P5 first built beside them.

- **State.** `InvoiceServices.change#InvoiceState` is the guarded status change over Mantle's status flow: finalize
  or approve, resume, cancel, receive and sent. It checks the side's edit permission (`INVOICE_APPROVE` to approve),
  the revision (`lastUpdatedStamp`), the period and accounting locks, the single-currency and approval preferences
  and that the posting is done. Drafts are edited through `create#Receivable`, `store#InvoiceDraft`,
  `store#InvoiceDraftItem` and `delete#InvoiceDraftItem`; `reverse#DraftInvoice` calls `reverse#Invoice`.
- **Reads.** `find#Receivables`, `get#ReceivableSummary` and `get#InvoiceFinanceDetail` read the stored
  `invoiceTotal` and `unpaidTotal`, and leave out parties another user keeps private.
- **Print and send.** `get#InvoiceOutput` renders `template/account/Invoice.print.html.fancy` over
  `get#InvoicePrintInfo`, or the template a store or party setting names; Mantle never takes HTML from its caller.
  `send#Invoice` finalizes a draft, freezes the print as an immutable PDF `InvoiceContent` with copies of the
  supporting files the sender chose by version (`get#InvoiceDeliveryAttachments`), and sends through
  `send#EmailTemplate` (`MANTLE_INVOICE_EMAIL`, body `InvoiceEmail.html.fancy`); the messages are recorded in
  `InvoiceEmailMessage`. A caller with its own print names it with `printLocation` (Projects, for its time detail).
  The `IssuedInvoiceContentImmutable` EECA keeps issued files as sent, and the `InvoiceFinalizedSendEmail` SECA skips
  an invoice `send#Invoice` issued. `process#InvoiceBatch` sends, finalizes or prints each selected invoice in its own
  transaction; `get#InvoiceBatchResult` reads the result.
- **Credits.** `create#InvoiceCreditMemo` with `linkToOriginal` makes a credit linked to its original
  (`Invoice.creditForInvoiceId`), within the original's total, optionally split over its lines (`allocateToLines`);
  `apply#InvoiceCredit` applies it through `apply#InvoiceToInvoice`.
- **Approved time.** `find#ApprovedTimeBilling` and `create#InvoiceFromApprovedTime` bill a project's approved time
  and worker expenses at their billing rates (`ApprovedTimeBilling.js`).
- **Statements.** `CollectionServices.get#Statements` gives one statement per customer and currency over
  `get#ReceivableStatementInfo`: today's open items with their aging as of a date, printed by
  `template/account/ReceivableStatement.print.html.fancy`. There is no opening balance and no stored snapshot.
  `send#Statements` sends each as a PDF through `MANTLE_STATEMENT_EMAIL`, each address in its own transaction.
- **Customer.** `CustomerFinanceServices.get#CustomerFinance` reads contacts, the billing addresses (`sendTo`),
  orders, receivables, payments, agreements and aging through the existing services; masked payment methods only for
  treasury. `store#CustomerIdentification`, `store#CustomerBankAccount` and `store#CustomerTaxRegistration` write the
  finance details.
- **Book day.** `create#Invoice` records the invoice's book day (`Invoice.accountingDate`) and drafter, both audited.

## Payments and settlement (P5)

**Reviews.** A change the user reviews and then confirms is a `PaymentReview` row: its kind (`previewKindEnumId`,
the `PaymentReviewKind` enumeration: settlement, automatic application, settlement draft, state change,
unapplication, gateway action, refund, internal transfer), its status (`PrvDraft`, `PrvReview`, `PrvComplete`), its
user, organization and payment, the fingerprint confirming must match, the request, what the user reviewed and the
result. `store#PaymentReview` keeps it, `get#PaymentReview` reads the user's own, `claim#PaymentReview` begins
confirming with an operation key and `complete#PaymentReview` records the result. A confirmation with the same key and
fingerprint returns the first result; another fingerprint under the key is refused. A payment's version is its
`lastUpdatedStamp`. Each `preview#` service changes no financial record.

**Settlement.** `find#OpenItems` finds a counterparty's open invoices, credits and payments in one currency, a page
for each kind, from the SQL views `SettlementInvoiceBalance` and `SettlementPaymentBalance`.
`find#SettlementAdjustmentAccounts` offers the accounts assigned to the organization chain on the date.
`preview#Settlement`, `get#SettlementPreview` and `apply#Settlement` review and confirm allocations, and discounts or
write-offs (`ItemPromptDiscount`, `ItemWriteOff`) on an explicit account. Confirming applies each allocation through
`apply#InvoicePayment`, `apply#PaymentToPayment` or `apply#InvoiceToInvoice` on the reviewed `appliedDate` and
`accountingDate`, and each adjustment as a credit memo from `create#InvoiceCreditMemo` applied to its invoice.
`store#SettlementDraft` and `get#SettlementDraft` keep the user's selection behind an id for a day.
`preview#PaymentAutoApplication` and `autoApply#Payment` apply a payment to the oldest due invoices.

The `apply#*` services lock the organization and both documents, and refuse for every caller an application dated
before a document's posting, an internal transfer, a gateway authorization or held gateway cash, and an amount finer
than the currency. `unapply#PaymentApplication` refuses the application that funds a completed refund, and leaves
`Invoice.paidDate` as it was. `PostingGuard`, inside `post#AcctgTrans` and the apply and unapply services, checks the
periods, locks, source postings and accounts.

**Payments.** `find#Payments` lists the organization's payments by queue (incoming, outgoing, to validate,
unapplied, refunds, transfers, all) with their application balances; the unapplied queue leaves out transfers.
`get#PaymentFinanceDetail` reads one payment: masked methods, applications, refunds, documents, files and history,
and ledger and gateway rows with their read authority. `get#PaymentAccess` answers what a user may do with its files.
`create#PaymentDraft` and `store#PaymentDraft` write a proposed receipt or disbursement through `create#`/`update#Payment`;
their tx-commit SECAs send a PaymentValidation notice (`send#PaymentValidationNotice`), which
`approve#PaymentValidationNotice` and `refuse#PaymentValidationNotice` answer. `preview#PaymentState`,
`get#PaymentStatePreview` and `change#PaymentState` validate, deliver, confirm, cancel or void through `update#Payment`
along `StatusFlowTransition`, so the Payment SECAs post, void, unapply and clear. `preview#PaymentUnapply`,
`get#PaymentUnapplyPreview` and `unapply#ReviewedPayment` unapply chosen applications through
`unapply#PaymentApplication`. `revert#PaymentPost` and `revert#PaymentApplicationPost` take a `reversalDate`.
`PaymentLifecycleEvent` keeps each change's reference and reason for History.

**Documents.** `issue#PaymentDocuments` issues a delivered payment's receipt (`PctReceipt`), detail
(`PctPaymentDocument`) and, with a check number, check (`PctCheckImage`), each a PDF of
`template/account/PaymentDocument.html.fancy` under `mantle.content.large.root`; a transfer gets its detail only.
`get#PaymentDocumentInfo` gives the template's values and `get#PaymentOutput` reads an issued document; a check needs
treasury authority. `save#PaymentContentFile` refuses to replace a file once the payment is posted.

**Gateway.** `authorize#`, `capture#`, `release#` and `refund#SinglePayment` take an optional `operationKey`, lock the
payment, and answer a retry with the first `PaymentGatewayResponse` without calling the gateway; the response records
the key and the refund payment (`operationKey`, `refundPaymentId`). `get#PaymentGatewayActions` finds the payment's
gateway as those services do and the actions the user may review. `preview#PaymentGatewayAction`,
`get#PaymentGatewayActionPreview` and `execute#PaymentGatewayAction` review and run them; a refund is a promised
`create#RefundPayment` and `refund#SinglePayment` for it. An accepted capture delivers and posts; an accepted refund is
delivered and applied to its original (`apply#RefundPayment`); a declined one is `PmntDeclined`; a pending one stays
promised until `lookup#PaymentGatewayDetails` (over `get#SinglePaymentGatewayDetails`) finds the gateway's answer.
`find#PaymentGatewayTransactions` and `find#PaymentGatewayProviders` search the responses. Real gateways (Braintree,
PayTrace, Authorize.Net) implement the same interfaces. There is no partial capture.

**Refunds.** `create#RefundPayment` takes an `accountingDate` and refuses more than the original less its other
refunds, pending ones included. `get#PaymentRefundSummary` gives what is left to refund, and `get#PaymentRefundPlan`,
`preview#PaymentRefund`, `get#PaymentRefundPreview` and `refund#ReviewedPayment` review and confirm a manual refund
through it, so the Payment SECAs post it and it is applied to the original.

**Transfers.** `get#InternalTransferPlan` checks a transfer and plans its payments and postings;
`preview#InternalTransfer`, `get#InternalTransferPreview` and `create#InternalTransfer` review and confirm it, with
`find#InternalTransferMethods` and `find#InternalTransferFeeAccounts` for the choices. A transfer is one delivered
`PtInternalTransfer` payment from the organization to itself, `paymentMethodId` the from method and
`toPaymentMethodId` the to method, through `create#Payment`. Its `PaymentGlPost` SECA runs `post#Payment`, which posts
the outgoing and incoming transactions through the `PtInternalTransfer` transit `PaymentTypeGlAccount` (258300000 by
default); `get#PaymentMethodGlAccount` takes `isPayable` so each side finds its own method's cash account. A fee is
its own `PtDisbursement` payment to an outside party, by default the from bank's party, posted to the chosen expense
account (`Payment.overrideTypeGlAccountId`), and points at its transfer (`Payment.feeForPaymentId`). One service
transaction holds them all, so they post together or not at all.

## Libraries

- `ledger/EntityLib.js`: the helpers the finance modules share: entity reads without artifact authorization (each
  module checks its permissions first), calls and probes, dates and book days (`bookDay`: the calendar day, else the
  timestamp's day in the user's zone), display values, amounts, refusals with reason codes (`denied`, `reasonCode`),
  party names that leave out private parties, paging and operation keys. Nothing in it authorizes.
- `ledger/AccountingPolicy.js`: permissions, organization scope and record checks; a refusal has a reason code.
- `ledger/PostingGuard.js`: the posting choke point. It decides an automatic posting from the transaction's source
  fields, and asks `ACCOUNTING_GL_POST` of a manual or reversal posting unless its caller passes `reviewed`.
- `account/InvoiceWorkflowLib.js`: an invoice's scope for a read or a write. `InvoiceWorkflow.js`,
  `InvoiceAttachments.js`, `PaymentWorkflow.js`, `PaymentLifecycle.js`, `PaymentSettlement.js` and `PaymentOutput.js`
  hold the logic too involved for XML Actions; the other services are inline XML Actions.

## The posting guard flag

`PartyAcctgPreference.postingGuardEnabled`, off by default, gates the posting guard and the invoice and payment
`MAPPING_MISSING` refusal. Mantle's OrderToCash, ProcureToPay, ReturnToResponse, InvoicePaymentMisc and Payroll
flow specs need them off: they post with the demo account assignments, and some of their postings go to the error
journal. The other P4–P5 controls hold whatever it says. BOSS's demo organization turns it on.

## Tests

The Accounting specs make their own data, users and spec-local permission groups, and no spec depends on BOSS. The
gateway specs use the test gateway in `service/mantle/account/PaymentTestServices.xml`: `alwaysPending#` for
authorization, capture and refund, `alwaysDecline#PaymentRelease`, `alwaysDecline#PaymentRefund` and
`alwaysApprove#PaymentDetails` for a lookup that approves, named in the spec's own `PaymentGatewayConfig`.

```sh
./moq test mr-mantle
./moq test mr-mantle --spec AccountingReceivables,AccountingDelivery,AccountingCustomerFinance
./moq test mr-mantle --spec AccountingSettlement,AccountingSettlementConcurrency,AccountingApplicationRules
./moq test mr-mantle --spec AccountingPaymentLifecycle,AccountingPaymentCorrections,AccountingPaymentOutput,AccountingPaymentNotifications
./moq test mr-mantle --spec AccountingPaymentGateway,AccountingPaymentRefunds,AccountingInternalTransfers
```

The PDF specs need a Chromium for PDF (`pdf_chromium_path`; see [Run-Deploy](../../../../docs/Run-Deploy.md) and
[Client-Testing](../../../../docs/dev/Client-Testing.md)); without one every PDF spec fails. The results are in
mr-boss's `plan/impl-accounting.md`.
