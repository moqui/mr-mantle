// Adopted applications keep their original posted backing. Reconciliation and descriptive metadata remain editable.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, map, denied, ms} = lib
const T = "mantle.ledger.transaction.AcctgTrans"
const E = "mantle.ledger.transaction.AcctgTransEntry"
const A = "mantle.account.payment.PaymentApplication"
const applicationTypes = [
    "AttOutgoingPaymentAp",
    "AttIncomingPaymentAp",
    "AttPaymentInOutAppl",
    "AttInvoiceInOutAppl",
    "AttPaymentApplied",
    "AttPaymentAdjust"
]
const cashTypes = ["AttPayment", "AttDisbursement", "AttReceipt", "AttIncomingPayment", "AttOutgoingPayment"]
const headerFields = [
    "organizationPartyId",
    "invoiceId",
    "paymentId",
    "toInvoiceId",
    "toPaymentId",
    "paymentApplicationId",
    "acctgTransTypeEnumId",
    "glJournalId",
    "glFiscalTypeEnumId",
    "amountUomId",
    "localCurrencyUomId",
    "originalCurrencyUomId",
    "otherPartyId",
    "transactionDate",
    "accountingDate",
    "postedDate",
    "isPosted",
    "reverseOfAcctgTransId",
    "reversedByAcctgTransId"
]
const entryFields = [
    "acctgTransId",
    "acctgTransEntrySeqId",
    "glAccountId",
    "glAccountTypeEnumId",
    "debitCreditFlag",
    "amount",
    "localCurrencyAmount",
    "originalCurrencyAmount",
    "organizationPartyId",
    "partyId",
    "productId",
    "facilityId",
    "costCenterId",
    "workEffortId",
    "isSummary"
]
function adopted(tx) {
    return !!tx?.organizationPartyId && lib.policy.preference(tx.organizationPartyId).settlementApplicationGuardEnabled === "Y"
}
function changed(before, after, fields) {
    return fields.some(field => {
        if (["amount", "localCurrencyAmount", "originalCurrencyAmount"].includes(field))
            return !toDecimal(before[field] ?? 0).eq(after[field] ?? 0)
        if (field === "accountingDate")
            return lib.policy.calendarDateText(before[field]) !== lib.policy.calendarDateText(after[field])
        if (field.endsWith("Date")) return ms(before[field]) !== ms(after[field])
        return String(before[field] ?? "") !== String(after[field] ?? "")
    })
}
function financial(tx) {
    return tx && (tx.invoiceId || tx.paymentId || tx.paymentApplicationId)
}
function positiveApplications(tx) {
    const cf = ec.entity.conditionFactory
    const conditions = []
    const linked = tx.paymentApplicationId ? one(A, {paymentApplicationId: tx.paymentApplicationId}) : null
    for (const [sources, fields] of [
        [
            [tx.invoiceId, tx.toInvoiceId, linked?.invoiceId, linked?.toInvoiceId],
            ["invoiceId", "toInvoiceId"]
        ],
        [
            [tx.paymentId, tx.toPaymentId, linked?.paymentId, linked?.toPaymentId],
            ["paymentId", "toPaymentId"]
        ]
    ])
        for (const id of [...new Set(sources.filter(Boolean))])
            for (const field of fields) conditions.push(cf.makeCondition(field, "equals", id))
    return conditions.length
        ? Array.from(
              find(A)
                  .condition(cf.makeCondition(conditions, "or"))
                  .condition("amountApplied", "greater", 0)
                  .orderBy("paymentApplicationId")
                  .list()
          )
        : []
}
function applicationEvidence(application) {
    const retainedDay = application.accountingDate ? lib.policy.calendarDateText(application.accountingDate) : null
    const retainedDate = ms(application.appliedDate)
    if (retainedDay && retainedDate != null && Number.isFinite(retainedDate))
        return {day: retainedDay, effectiveDate: application.appliedDate}
    const transactions = Array.from(
        find(T, {paymentApplicationId: application.paymentApplicationId, isPosted: "Y"})
            .condition("reverseOfAcctgTransId", "is-null", null)
            .condition("reversedByAcctgTransId", "is-null", null)
            .orderBy("acctgTransId")
            .list()
    )
    const days = [...new Set(transactions.map(tx => lib.policy.postingDay(tx)))].sort()
    if (days.length > 1)
        denied(
            "APPLICATION_DATE_UNAVAILABLE",
            "The legacy application has conflicting posting days; review its financial history"
        )
    const sourceDate =
        transactions[0]?.transactionDate ||
        (application.paymentId
            ? one("mantle.account.payment.Payment", {paymentId: application.paymentId})?.effectiveDate
            : null) ||
        (application.invoiceId ? one("mantle.account.invoice.Invoice", {invoiceId: application.invoiceId})?.invoiceDate : null)
    const effectiveDate = retainedDate != null && Number.isFinite(retainedDate) ? application.appliedDate : sourceDate
    const day = retainedDay || days[0] || lib.policy.calendarDateText(effectiveDate)
    if (!day || ms(effectiveDate) == null || !Number.isFinite(ms(effectiveDate)))
        denied("APPLICATION_DATE_UNAVAILABLE", "The legacy application needs an original posting or source effective date")
    return {day, effectiveDate}
}
function applicationDay(application) {
    return applicationEvidence(application).day
}
function checkSourceDay(tx) {
    if (
        !financial(tx) ||
        !adopted(tx) ||
        tx.isPosted !== "Y" ||
        tx.reverseOfAcctgTransId ||
        applicationTypes.includes(tx.acctgTransTypeEnumId)
    )
        return
    const day = lib.policy.postingDay(tx)
    if (positiveApplications(tx).some(application => applicationDay(application) < day))
        denied("APPLICATION_BEFORE_SOURCE_POSTING", "A source cannot post after the effective day of an existing application")
}
function assertLocked(tx) {
    if (!financial(tx) || tx.isPosted !== "Y" || !adopted(tx)) return
    // A full-single cash posting has an AP id too; its base cash type still protects the entire source balance.
    const ownApplication = applicationTypes.includes(tx.acctgTransTypeEnumId) && !tx.reverseOfAcctgTransId
    const linked = ownApplication && tx.paymentApplicationId ? one(A, {paymentApplicationId: tx.paymentApplicationId}) : null
    const consumed = ownApplication ? toDecimal(linked?.amountApplied ?? 0).compare(0) > 0 : positiveApplications(tx).length > 0
    if (consumed) denied("SOURCE_HAS_APPLICATIONS", "Unapply the financial application before changing its posting evidence")
}
function assertMutable(p) {
    const initial = one(T, {acctgTransId: p.acctgTransId})
    if (!financial(initial) || !adopted(initial)) return
    // Public mutation entry points take the organization first, before their existing transaction/entry locks.
    find("mantle.party.Party", {partyId: initial.organizationPartyId}).forUpdate(true).one()
    assertLocked(find(T, {acctgTransId: p.acctgTransId}).forUpdate(true).one())
}
function guardTransaction(p) {
    const values = map(p.entityValue || p)
    const before = p.originalValue
        ? map(p.originalValue)
        : values.acctgTransId
          ? one(T, {acctgTransId: values.acctgTransId})
          : null
    const after = Object.assign({}, map(before), values)
    // New source creation joins the same organization mutex as applications, including raw already-posted imports.
    // This also covers a legacy application created before its first cash transaction in one transaction.
    if (!before && financial(after) && adopted(after))
        find("mantle.party.Party", {partyId: after.organizationPartyId}).forUpdate(true).one()
    if ((!before || before.isPosted !== "Y") && after.isPosted === "Y") checkSourceDay(after)
    if (
        after.reverseOfAcctgTransId &&
        (p.eecaOperation === "create" || !before?.reverseOfAcctgTransId || before.isPosted !== after.isPosted)
    ) {
        const referenced = one(T, {acctgTransId: after.reverseOfAcctgTransId})
        if (financial(referenced) && adopted(referenced))
            assertLocked(find(T, {acctgTransId: after.reverseOfAcctgTransId}).forUpdate(true).one())
    }
    if (!before || !financial(before) || !adopted(before)) return
    if (p.eecaOperation !== "delete" && !changed(before, after, headerFields)) return
    // Raw writes lock the authoritative source before inspecting applications, without a new org-after-TX inversion.
    assertLocked(find(T, {acctgTransId: before.acctgTransId}).forUpdate(true).one())
}
function guardEntry(p) {
    const values = map(p.entityValue || p)
    const before = p.originalValue
        ? map(p.originalValue)
        : values.acctgTransId && values.acctgTransEntrySeqId
          ? one(E, {
                acctgTransId: values.acctgTransId,
                acctgTransEntrySeqId: values.acctgTransEntrySeqId
            })
          : null
    const after = Object.assign({}, map(before), values)
    if (before && p.eecaOperation !== "delete" && !changed(before, after, entryFields)) return
    for (const id of [...new Set([before?.acctgTransId, after.acctgTransId].filter(Boolean))].sort()) {
        const initial = one(T, {acctgTransId: id})
        if (financial(initial) && adopted(initial)) assertLocked(find(T, {acctgTransId: id}).forUpdate(true).one())
    }
}
function lockForApplication(records, applicationDay) {
    const cf = ec.entity.conditionFactory
    const conditions = records.map(record =>
        cf.makeCondition(record.entity === "mantle.account.invoice.Invoice" ? "invoiceId" : "paymentId", "equals", record.id)
    )
    if (!conditions.length) return []
    const candidates = Array.from(
        find(T)
            .condition(cf.makeCondition(conditions, "or"))
            .condition("acctgTransTypeEnumId", "not-in", applicationTypes)
            .condition("reverseOfAcctgTransId", "is-null", null)
            .orderBy("acctgTransId")
            .forUpdate(true)
            .list()
    )
    for (const record of records) {
        const field = record.entity === "mantle.account.invoice.Invoice" ? "invoiceId" : "paymentId"
        const own = candidates.filter(tx => tx[field] === record.id && (field !== "invoiceId" || !tx.paymentId))
        // Legacy delivery can create its application before the first main cash posting in the same transaction.
        if (!own.length) continue
        const active = own.filter(tx => !tx.reversedByAcctgTransId)
        if (!active.length || active.some(tx => tx.isPosted !== "Y"))
            denied("APPLICATION_SOURCE_NOT_POSTED", "An existing source posting is no longer available for application")
        if (applicationDay && active.some(tx => lib.policy.postingDay(tx) > applicationDay))
            denied(
                "APPLICATION_BEFORE_SOURCE_POSTING",
                "Application date cannot precede an original source or target ledger posting"
            )
        const reversals = find(T)
            .condition(
                "reverseOfAcctgTransId",
                "in",
                active.map(tx => tx.acctgTransId)
            )
            .condition("isPosted", "Y")
            .selectField("acctgTransId")
            .limit(1)
            .one()
        if (reversals) denied("APPLICATION_SOURCE_NOT_POSTED", "An existing source posting has a posted reversal")
    }
    return candidates
}
function directHistory(payment, invoiceId, transactions, history) {
    if (
        !payment.forInvoiceId ||
        invoiceId !== payment.forInvoiceId ||
        transactions.some(tx => tx.invoiceId !== payment.forInvoiceId)
    )
        denied("DIRECT_PAYMENT_HISTORY_INCONSISTENT", "Direct cash can only restore its original invoice application")
    if (
        history.some(
            row =>
                row.paymentId !== payment.paymentId ||
                row.invoiceId !== payment.forInvoiceId ||
                row.toInvoiceId ||
                row.toPaymentId
        )
    )
        denied("DIRECT_PAYMENT_HISTORY_INCONSISTENT", "Reconcile prior off-invoice applications before restoring direct cash")
    if (
        history.length &&
        find(T, {isPosted: "Y"})
            .condition(
                "paymentApplicationId",
                "in",
                history.map(row => row.paymentApplicationId)
            )
            .condition("reverseOfAcctgTransId", "is-null", null)
            .condition("reversedByAcctgTransId", "is-null", null)
            .condition("acctgTransTypeEnumId", "not-in", cashTypes)
            .limit(1)
            .one()
    )
        denied("DIRECT_PAYMENT_HISTORY_INCONSISTENT", "Reconcile additional application postings before restoring direct cash")
}
function controlProof(evidence, account, flag, amount) {
    const net = evidence.entries
        .filter(row => row.glAccountId === account)
        .reduce(
            (sum, row) => (row.debitCreditFlag === flag ? sum.add(row.amount || 0) : sum.subtract(row.amount || 0)),
            toDecimal(0)
        )
    if (!net.eq(amount || 0))
        denied("SOURCE_POSTING_INCOMPLETE", "The posted control amount does not match its financial document")
}
function checkDirectApplication(application, records, applications, originals, amount, available, reviewed) {
    const payment = records.find(
        record => record.entity === "mantle.account.payment.Payment" && record.id === application.paymentId
    )?.value
    if (!payment) return
    const cash = originals.filter(
        tx => tx.paymentId === payment.paymentId && cashTypes.includes(tx.acctgTransTypeEnumId) && !tx.reversedByAcctgTransId
    )
    // Before the first main posting the legacy poster selects direct versus unapplied from the complete application set.
    if (!cash.length) return
    const outgoing = payment.fromPartyId === cash[0].organizationPartyId
    const entries = Array.from(
        find(E)
            .condition(
                "acctgTransId",
                "in",
                cash.map(tx => tx.acctgTransId)
            )
            .list()
    )
    const accountIds = [...new Set(entries.map(entry => entry.glAccountId).filter(Boolean))]
    const hasUnapplied =
        accountIds.length &&
        Array.from(
            find("mantle.ledger.account.GlAccount")
                .condition("glAccountId", "in", accountIds)
                .selectField("glAccountClassEnumId")
                .list()
        ).some(account => ["UNEARNED_REVENUE", "PREPAID_EXPENSE"].includes(account.glAccountClassEnumId))
    if (hasUnapplied) {
        const account = lib.call("mantle.ledger.PaymentAutoPostServices.get#PaymentTypeGlAccount", {
            organizationPartyId: cash[0].organizationPartyId,
            otherPartyId: outgoing ? payment.toPartyId : payment.fromPartyId,
            paymentTypeEnumId: payment.paymentTypeEnumId,
            isApplied: "N",
            isPayable: outgoing ? "Y" : "N"
        }).glAccountId
        if (!account) denied("MAPPING_MISSING", "The unapplied payment control account is not configured")
        controlProof({entries}, account, outgoing ? "D" : "C", payment.amount)
        return
    }
    if (application.toInvoiceId || application.toPaymentId)
        denied("DIRECT_PAYMENT_HISTORY_INCONSISTENT", "Direct cash can only restore its original invoice application")
    const history = applications.filter(
        row =>
            (row.paymentId === payment.paymentId || row.toPaymentId === payment.paymentId) &&
            toDecimal(row.amountApplied || 0).compare(0) > 0
    )
    directHistory(payment, application.invoiceId, cash, history)
    const invoice = records.find(
        record => record.entity === "mantle.account.invoice.Invoice" && record.id === application.invoiceId
    )?.value
    const account = lib.call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceTypeTransType", {
        organizationPartyId: cash[0].organizationPartyId,
        invoiceTypeEnumId: invoice?.invoiceTypeEnumId,
        isPayable: outgoing ? "Y" : "N"
    }).glAccountId
    if (!account) denied("MAPPING_MISSING", "The direct invoice control account is not configured")
    controlProof({entries}, account, outgoing ? "D" : "C", payment.amount)
    // The reviewed writer validates aggregate direct allocations before any row; legacy/raw callers need one full restoration.
    if (!reviewed && !amount.eq(available))
        denied("DIRECT_PAYMENT_RESTORE_REQUIRED", "Restore the entire currently available direct payment to its original invoice")
}
;({
    assertMutable,
    guardTransaction,
    guardEntry,
    lockForApplication,
    applicationDay,
    applicationEvidence,
    checkDirectApplication,
    directHistory,
    controlProof
})
