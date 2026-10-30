// Accepted gateway cash keeps one original posting. Genuine later applications retain their own financial rules.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const legacy = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
const P = "mantle.account.payment.Payment",
    T = "mantle.ledger.transaction.AcctgTrans"
function lockSources(transactions) {
    const txs = transactions.filter(tx => tx?.paymentId || tx?.toPaymentId),
        ids = [...new Set(txs.flatMap(tx => [tx.paymentId, tx.toPaymentId]).filter(Boolean))].sort()
    if (!ids.length) return {payments: {}, legacyOnly: false}
    const initial = Array.from(lib.find(P).condition("paymentId", "in", ids).useCache(false).list()),
        txOrgs = [...new Set(txs.map(tx => tx.organizationPartyId).filter(Boolean))].sort(),
        adopted = org => lib.policy.preference(org).postingGuardEnabled === "Y",
        needsOrganization = initial.some(legacy.isManaged) || txOrgs.some(adopted)
    if (!needsOrganization) {
        const records = legacy.lockUnmanagedPayments(ids)
        if (txOrgs.some(adopted)) lib.denied("PAYMENT_SOURCE_CHANGED", "Financial controls changed; retry the operation")
        return {payments: Object.fromEntries(records.map(payment => [payment.paymentId, payment])), legacyOnly: true}
    }
    const orgs = [...new Set([...txOrgs, ...initial.map(payment => payment.financeOrganizationPartyId)].filter(Boolean))].sort()
    if (orgs.length)
        Array.from(lib.find("mantle.party.Party").condition("partyId", "in", orgs).orderBy("partyId").forUpdate(true).list())
    const records = Array.from(
        lib.find(P).condition("paymentId", "in", ids).useCache(false).orderBy("paymentId").forUpdate(true).list()
    )
    return {payments: Object.fromEntries(records.map(payment => [payment.paymentId, payment])), legacyOnly: false}
}

function eligible(payment) {
    if (!payment) return
    if (payment.gatewayRole === "authorization")
        lib.denied("GATEWAY_AUTHORIZATION_NOT_CASH", "An authorization instruction cannot create a financial posting")
    if (
        payment.lifecycleManaged === "Y" &&
        payment.paymentTypeEnumId === "PtInvoicePayment" &&
        !payment.gatewayRole &&
        legacy.gatewayCapable(payment) &&
        !legacy.hasManualCash(payment)
    )
        lib.denied("GATEWAY_CAPTURE_REQUIRED", "Only a completed reviewed provider capture can create cash for this payment")
}
function application(tx, payment, types) {
    if (!types.applicationTypes.includes(tx.acctgTransTypeEnumId) || !tx.paymentApplicationId) return false
    const row = lib
        .find("mantle.account.payment.PaymentApplication", {paymentApplicationId: tx.paymentApplicationId})
        .useCache(false)
        .one()
    return (
        !!row &&
        [row.paymentId, row.toPaymentId].includes(payment.paymentId) &&
        tx.organizationPartyId === payment.financeOrganizationPartyId &&
        tx.amountUomId === payment.amountUomId &&
        (!row.currencyUomId || row.currencyUomId === payment.amountUomId) &&
        ["paymentId", "toPaymentId", "invoiceId", "toInvoiceId"].every(
            field => String(tx[field] || "") === String(row[field] || "")
        )
    )
}
function eachSource(tx, payments, callback) {
    for (const id of [...new Set([tx?.paymentId, tx?.toPaymentId].filter(Boolean))]) callback(payments[id])
}

function cashWrite(tx, payment, types, alreadyPosted = false) {
    eligible(payment)
    if (!["capture", "refund"].includes(payment?.gatewayRole) || application(tx, payment, types)) return
    if (tx.paymentId !== payment.paymentId)
        lib.denied("GATEWAY_CASH_SOURCE_INVALID", "A cash target needs its exact payment application")
    const attempt = lib
        .find("mantle.account.payment.PaymentGatewayAttempt", {attemptId: payment.gatewayAttemptId})
        .useCache(false)
        .forUpdate(true)
        .one()
    if (alreadyPosted || attempt?.financialState === "completed")
        lib.denied("GATEWAY_CASH_POSTING_IMMUTABLE", "A posted provider cash payment keeps its original financial posting")
    const controller = ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => name.startsWith("mantle.account.PaymentServices."))
    if (controller !== "mantle.account.PaymentServices.complete#PaymentGatewayAttempt")
        lib.denied("GATEWAY_POSTING_REVIEW_REQUIRED", "Only reviewed provider completion can construct the original cash posting")
    if (
        !attempt ||
        attempt.providerState !== "accepted" ||
        attempt.action !== payment.gatewayRole ||
        attempt.cashPaymentId !== payment.paymentId ||
        attempt.instructionId !== payment.gatewayInstructionId ||
        attempt.organizationPartyId !== payment.financeOrganizationPartyId ||
        !toDecimal(attempt.amount).eq(payment.amount) ||
        attempt.currencyUomId !== payment.amountUomId
    )
        lib.denied("GATEWAY_CASH_SOURCE_INVALID", "The cash posting needs its exact accepted provider attempt")
    if (payment.gatewayRole === "refund") {
        const capture =
            attempt.parentAttemptId &&
            lib
                .find("mantle.account.payment.PaymentGatewayAttempt", {
                    attemptId: attempt.parentAttemptId
                })
                .useCache(false)
                .forUpdate(true)
                .one()
        if (
            payment.paymentTypeEnumId !== "PtRefund" ||
            payment.refundForPaymentId !== attempt.paymentId ||
            !capture ||
            capture.action !== "capture" ||
            capture.providerState !== "accepted" ||
            capture.financialState !== "completed" ||
            capture.cashPaymentId !== attempt.paymentId ||
            capture.instructionId !== attempt.instructionId ||
            capture.organizationPartyId !== attempt.organizationPartyId ||
            capture.currencyUomId !== attempt.currencyUomId ||
            capture.merchantNamespace !== attempt.merchantNamespace ||
            !capture.providerReference ||
            capture.providerReference !== attempt.parentProviderReference
        )
            lib.denied("GATEWAY_CASH_SOURCE_INVALID", "Refund cash needs its exact completed original capture")
    }
    if (
        !types.cashTypes.includes(tx.acctgTransTypeEnumId) ||
        tx.reverseOfAcctgTransId ||
        tx.organizationPartyId !== payment.financeOrganizationPartyId ||
        tx.amountUomId !== payment.amountUomId ||
        lib.ms(tx.transactionDate) !== lib.ms(payment.effectiveDate) ||
        (tx.accountingDate &&
            lib.policy.calendarDateText(tx.accountingDate) !== lib.policy.calendarDateText(payment.accountingDate))
    )
        lib.denied(
            "GATEWAY_CASH_SOURCE_INVALID",
            "The original cash posting must retain its actual child currency, organization and day"
        )
    let duplicate = lib
        .find(T, {paymentId: payment.paymentId})
        .condition("reverseOfAcctgTransId", "is-null", null)
        .condition("acctgTransTypeEnumId", "not-in", types.applicationTypes)
    if (tx.acctgTransId) duplicate = duplicate.condition("acctgTransId", "not-equals", tx.acctgTransId)
    if (duplicate.selectField("acctgTransId").limit(1).one())
        lib.denied("GATEWAY_CASH_POSTING_DUPLICATE", "The accepted provider cash already has its original posting")
}
function posting(tx, types) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const {payments, legacyOnly} = lockSources([tx])
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefundBackingGuard.js").source(tx, types)
    eachSource(tx, payments, payment => cashWrite(tx, payment, types, tx.isPosted === "Y"))
    return legacyOnly
}
// A payment with a pending provider refund hold keeps its original cash posting.
function heldCash(tx, cashTypes) {
    if (!tx?.paymentId || !cashTypes.includes(tx.acctgTransTypeEnumId) || !tx.organizationPartyId) return
    const initial = lib.one(P, {paymentId: tx.paymentId})
    if (!legacy.isManaged(initial)) {
        legacy.lockUnmanagedPayments([tx.paymentId])
        return
    }
    lib.find("mantle.party.Party", {partyId: tx.organizationPartyId}).forUpdate(true).one()
    lib.find(P, {paymentId: tx.paymentId}).forUpdate(true).one()
    const held = lib
        .find("mantle.account.payment.PaymentGatewayReservation", {
            organizationPartyId: tx.organizationPartyId,
            paymentId: tx.paymentId,
            holdKind: "cash",
            status: "held"
        })
        .useCache(false)
        .limit(1)
        .one()
    if (!held) return
    const hold = ec.resource
        .script("component://mr-mantle/service/mantle/account/PaymentGatewayReservations.js")
        .cashHoldSummary({organizationPartyId: tx.organizationPartyId, paymentId: tx.paymentId})
    if (hold.heldAmount.compare(0) > 0)
        lib.denied("GATEWAY_CASH_RESERVED", "Resolve the pending provider refund before changing its original cash posting")
}
;({posting, heldCash})
