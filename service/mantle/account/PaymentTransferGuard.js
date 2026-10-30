// Paired transfers are permanent financial identities, including after adoption flags are disabled.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {lib, P} = workflow
const {find, one, map, denied, policy} = lib
const RECORD = "mantle.account.payment.PaymentInternalTransfer",
    PREVIEW = "mantle.account.payment.PaymentTransferPreview",
    TX = "mantle.ledger.transaction.AcctgTrans"
function controller() {
    return ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => name.startsWith("mantle.account.PaymentServices."))
        ?.slice("mantle.account.PaymentServices.".length)
}
function same(field, a, b) {
    if (["amount", "principalAmount", "feeAmount"].includes(field)) return toDecimal(a ?? 0).eq(b ?? 0)
    if (field === "accountingDate") return policy.calendarDateText(a) === policy.calendarDateText(b)
    if (field.endsWith("Date") || field.endsWith("Stamp")) return lib.ms(a) === lib.ms(b)
    return String(a ?? "") === String(b ?? "")
}
function recordFor(paymentId, marker = null, lock = false) {
    if (!paymentId && !marker) return null
    const cf = ec.entity.conditionFactory,
        conditions = []
    if (paymentId)
        for (const field of ["fromPaymentId", "toPaymentId"]) conditions.push(cf.makeCondition(field, "equals", paymentId))
    if (marker) conditions.push(cf.makeCondition("internalTransferId", "equals", marker))
    const rows = Array.from(
        find(RECORD)
            .condition(cf.makeCondition(conditions, "or"))
            .orderBy("internalTransferId")
            .useCache(false)
            .forUpdate(lock)
            .list()
    )
    if (rows.length > 1) denied("TRANSFER_IDENTITY_INVALID", "Transfer payment identity is inconsistent")
    return rows[0] || null
}
function payment(p) {
    if (
        ![p.before, p.after].some(
            row => row && (row.internalTransferId || row.internalTransferLeg || row.paymentTypeEnumId === "PtInternalTransfer")
        ) &&
        !recordFor(p.before?.paymentId || p.after?.paymentId)
    )
        return false
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const row = recordFor(
            p.before?.paymentId || p.after?.paymentId,
            p.before?.internalTransferId || p.after?.internalTransferId,
            p.financialChanged === true
        ),
        a = p.after
    if (!row || p.operation === "delete")
        denied("TRANSFER_PAYMENT_IMMUTABLE", "An internal transfer payment cannot be deleted or detached")
    const leg = row.fromPaymentId === a.paymentId ? "outgoing" : row.toPaymentId === a.paymentId ? "incoming" : null,
        amount = leg === "outgoing" ? toDecimal(row.principalAmount).add(row.feeAmount) : toDecimal(row.principalAmount)
    if (
        !leg ||
        a.internalTransferId !== row.internalTransferId ||
        a.internalTransferLeg !== leg ||
        a.paymentTypeEnumId !== "PtInternalTransfer" ||
        a.lifecycleManaged !== "Y" ||
        a.fromPartyId !== row.organizationPartyId ||
        a.toPartyId !== row.organizationPartyId ||
        a.financeOrganizationPartyId !== row.organizationPartyId ||
        a.financeDirection !== "transfer" ||
        a.amountUomId !== row.currencyUomId ||
        !toDecimal(a.amount || 0).eq(amount) ||
        policy.calendarDateText(a.accountingDate) !== policy.calendarDateText(row.accountingDate) ||
        lib.ms(a.effectiveDate) !== lib.ms(row.effectiveDate) ||
        a.statusId !== "PmntDelivered" ||
        a.paymentInstrumentEnumId !== "PiOther" ||
        a.paymentMethodId !== (leg === "outgoing" ? row.fromPaymentMethodId : null) ||
        a.toPaymentMethodId !== (leg === "incoming" ? row.toPaymentMethodId : null) ||
        a.forInvoiceId ||
        a.refundForPaymentId ||
        a.gatewayRole ||
        a.gatewayInstructionId ||
        a.gatewayAttemptId ||
        a.paymentGatewayConfigId ||
        a.overrideGlAccountId ||
        a.overrideOrgPartyId ||
        a.finAccountId ||
        a.finAccountAuthId ||
        a.finAccountTransId ||
        a.paymentMethodFileId
    )
        denied("TRANSFER_PAYMENT_IMMUTABLE", "Transfer money, book day, methods and paired source identity are immutable")
    if (p.before) {
        for (const field of ["paymentRefNum", "orderId", "orderPartSeqId", "orderItemSeqId"])
            if (!same(field, p.before[field], a[field]))
                denied("TRANSFER_PAYMENT_IMMUTABLE", "Transfer source reference is immutable")
    } else if (controller() !== "create#InternalTransfer" || row.status !== "constructing")
        denied("TRANSFER_REVIEW_REQUIRED", "Only the reviewed transfer controller creates its exact legs")
    return true
}
function source(tx, options = {}) {
    if (!tx) return false
    let found = false
    for (const paymentId of [...new Set([tx.paymentId, tx.toPaymentId].filter(Boolean))].sort()) {
        const p = find(P, {paymentId}).useCache(false).forUpdate(true).one(),
            row = recordFor(paymentId, p?.internalTransferId, true)
        if (!row && p?.paymentTypeEnumId !== "PtInternalTransfer" && !p?.internalTransferId) continue
        found = true
        if (
            !row ||
            !p ||
            row.status !== "constructing" ||
            options.alreadyPosted ||
            options.operation === "delete" ||
            controller() !== "create#InternalTransfer"
        )
            denied("TRANSFER_POSTING_IMMUTABLE", "A transfer keeps its exact paired original cash postings")
        const outgoing = paymentId === row.fromPaymentId,
            id = outgoing ? row.fromAcctgTransId : row.toAcctgTransId,
            type = outgoing ? "AttOutgoingPayment" : "AttIncomingPayment"
        if (
            tx.paymentId !== paymentId ||
            tx.toPaymentId ||
            tx.paymentApplicationId ||
            tx.invoiceId ||
            tx.toInvoiceId ||
            tx.reverseOfAcctgTransId ||
            tx.reversedByAcctgTransId ||
            tx.acctgTransTypeEnumId !== type ||
            tx.organizationPartyId !== row.organizationPartyId ||
            tx.amountUomId !== row.currencyUomId ||
            tx.glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
            lib.ms(tx.transactionDate) !== lib.ms(row.effectiveDate) ||
            (tx.accountingDate && policy.calendarDateText(tx.accountingDate) !== policy.calendarDateText(row.accountingDate)) ||
            (id && id !== tx.acctgTransId)
        )
            denied("TRANSFER_POSTING_IMMUTABLE", "Transfer posting identity does not match its exact reviewed leg")
        if (
            Array.from(
                find(TX, {paymentId})
                    .condition("acctgTransId", "not-equals", tx.acctgTransId)
                    .useCache(false)
                    .forUpdate(true)
                    .list()
            ).length
        )
            denied("TRANSFER_POSTING_IMMUTABLE", "A transfer leg has exactly one original cash posting")
    }
    return found
}
function application(p) {
    for (const id of [
        ...new Set([p.before?.paymentId, p.before?.toPaymentId, p.after?.paymentId, p.after?.toPaymentId].filter(Boolean))
    ]) {
        const payment = one(P, {paymentId: id})
        if (payment?.paymentTypeEnumId === "PtInternalTransfer" || payment?.internalTransferId || recordFor(id))
            denied("TRANSFER_APPLICATION_REFUSED", "Internal transfer legs cannot fund trade applications or refunds")
    }
}
function guard(p, kind) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const values = map(p.entityValue || p),
        entity = kind === "preview" ? PREVIEW : RECORD,
        key = kind === "preview" ? "previewId" : "internalTransferId",
        before =
            values[key] &&
            find(entity, {[key]: values[key]})
                .useCache(false)
                .one(),
        after = Object.assign({}, map(before), values),
        service = controller()
    if (p.eecaOperation === "delete") denied("TRANSFER_RECORD_IMMUTABLE", "Transfer review and pair identity cannot be deleted")
    if (kind === "preview") {
        if (!before) {
            if (
                service !== "preview#InternalTransfer" ||
                after.userId !== ec.user.userId ||
                after.status !== "review" ||
                !after.inputFingerprint
            )
                denied("TRANSFER_REVIEW_REQUIRED", "Create an owner-bound native transfer review")
        } else {
            if (
                service !== "create#InternalTransfer" ||
                before.status !== "review" ||
                after.status !== "complete" ||
                !after.operationKey ||
                !after.resultJson
            )
                denied("TRANSFER_REVIEW_REQUIRED", "A transfer review completes once through its native controller")
            for (const field of Object.keys(after).filter(
                f => !["status", "operationKey", "resultJson", "lastUpdatedStamp"].includes(f)
            ))
                if (!same(field, before[field], after[field]))
                    denied("TRANSFER_RECORD_IMMUTABLE", "Reviewed transfer intent is immutable")
        }
        return
    }
    if (service !== "create#InternalTransfer") denied("TRANSFER_REVIEW_REQUIRED", "Use the exact reviewed transfer controller")
    if (!before) {
        if (
            after.status !== "constructing" ||
            after.userId !== ec.user.userId ||
            !after.fromPaymentId ||
            !after.toPaymentId ||
            after.fromPaymentId === after.toPaymentId ||
            after.fromPaymentMethodId === after.toPaymentMethodId ||
            toDecimal(after.principalAmount || 0).compare(0) <= 0 ||
            toDecimal(after.feeAmount || 0).compare(0) < 0
        )
            denied("TRANSFER_IDENTITY_INVALID", "Transfer pair money and distinct leg identities are required")
    } else {
        if (before.status !== "constructing" || !["constructing", "completed"].includes(after.status))
            denied("TRANSFER_RECORD_IMMUTABLE", "A completed transfer pair is permanent")
        for (const field of Object.keys(after).filter(
            f => !["fromAcctgTransId", "toAcctgTransId", "status", "resultJson", "completedDate", "lastUpdatedStamp"].includes(f)
        ))
            if (!same(field, before[field], after[field]))
                denied("TRANSFER_RECORD_IMMUTABLE", "Paired transfer identity is immutable")
        for (const field of ["fromAcctgTransId", "toAcctgTransId"])
            if (before[field] && before[field] !== after[field])
                denied("TRANSFER_RECORD_IMMUTABLE", "Transfer original posting identity cannot change")
        if (after.status === "completed")
            for (const field of ["fromAcctgTransId", "toAcctgTransId"]) {
                const tx = one(TX, {acctgTransId: after[field]})
                if (!tx || tx.isPosted !== "Y")
                    denied("TRANSFER_NOT_POSTED", "Both actual transfer postings must be verified before completion")
            }
    }
}
;({payment, source, application, guard, recordFor})
