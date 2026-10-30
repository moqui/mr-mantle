// Legacy provider entry points must refuse reviewed records before performing any external operation.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const P = "mantle.account.payment.Payment"
const FENCE = "mantle.account.payment.PaymentLegacyGatewayFence"
const internalPrefix = "mantle.account.LegacyPaymentGatewayServices."
const legacyFields = [
    "authorizeServiceName",
    "captureServiceName",
    "releaseServiceName",
    "refundServiceName",
    "detailsServiceName"
]
const wrappers = new Set(
    [
        "authorize#StorePayment",
        "authorize#SinglePayment",
        "capture#SinglePayment",
        "capture#AppliedPayment",
        "release#SinglePayment",
        "refund#SinglePayment",
        "create#RefundPayment",
        "set#PaymentRefundFor",
        "get#SinglePaymentGatewayDetails"
    ].map(name => "mantle.account.PaymentServices." + name)
)
const shipped = new Set([
    ...["alwaysApprove", "alwaysDecline", "alwaysFail", "alwaysBadCardNumber", "alwaysBadExpire", "alwaysNsf"].map(
        verb => "mantle.account.PaymentTestServices." + verb + "#PaymentAuthorization"
    ),
    ...["alwaysApprove", "alwaysDecline"].map(verb => "mantle.account.PaymentTestServices." + verb + "#PaymentCapture"),
    "mantle.account.PaymentTestServices.alwaysApprove#PaymentRelease",
    "mantle.account.PaymentTestServices.alwaysApprove#PaymentRefund",
    ...["authorize", "capture", "release", "refund"].map(
        verb => "mantle.account.FinancialAccountServices." + verb + "#FinancialAccountPayment"
    )
])
function isManaged(payment) {
    return Boolean(
        payment &&
            (payment.lifecycleManaged === "Y" || payment.gatewayInstructionId || payment.gatewayAttemptId || payment.gatewayRole)
    )
}
function persistedPayments(p) {
    const ids = new Set(
        [p.paymentId, p.refundPaymentId, p.refundForPaymentId, p.payment?.paymentId, p.refundPayment?.paymentId].filter(Boolean)
    )
    if (p.paymentApplicationId) {
        const application = lib.one("mantle.account.payment.PaymentApplication", {paymentApplicationId: p.paymentApplicationId})
        if (application?.paymentId) ids.add(application.paymentId)
        if (application?.toPaymentId) ids.add(application.toPaymentId)
    }
    if (!ids.size) return []
    const payments = Array.from(
        lib
            .find(P)
            .condition("paymentId", "in", [...ids])
            .useCache(false)
            .list()
    )
    const originals = [...new Set(payments.map(payment => payment.refundForPaymentId).filter(id => id && !ids.has(id)))]
    return originals.length
        ? payments.concat(Array.from(lib.find(P).condition("paymentId", "in", originals).useCache(false).list()))
        : payments
}
function providerLeaf(name) {
    if (name.startsWith(internalPrefix)) return false
    if (shipped.has(name)) return true
    const cf = ec.entity.conditionFactory
    return Boolean(
        lib
            .find("mantle.account.method.PaymentGatewayConfig")
            .condition(
                cf.makeCondition(
                    legacyFields.map(field => cf.makeCondition(field, "equals", name)),
                    "or"
                )
            )
            .useCache(false)
            .selectField("paymentGatewayConfigId")
            .limit(1)
            .one()
    )
}
function guard(p) {
    const name = ec.artifactExecution.getStackNameString().split(", ")[0]
    if (name.startsWith(internalPrefix)) return
    const leaf = providerLeaf(name)
    if (!wrappers.has(name) && !leaf) return
    const payments = persistedPayments(p)
    if (payments.some(isManaged)) lib.denied("GATEWAY_REVIEW_REQUIRED", "Use the reviewed payment workflow for this payment")
    if (
        ["mantle.account.PaymentServices.refund#SinglePayment", "mantle.account.PaymentServices.set#PaymentRefundFor"].includes(
            name
        )
    )
        lockUnmanagedPayments([p.paymentId, p.refundPaymentId, p.refundForPaymentId])
    if (leaf && payments.length) {
        const paymentIdList = payments.map(payment => payment.paymentId).sort()
        durable("prepare#Fence", {paymentIdList})
        durable("record#Use", {paymentIdList, serviceName: name, paymentGatewayConfigId: p.paymentGatewayConfigId})
    }
}
function gatewayCapable(payment) {
    if (!payment) return false
    const manual = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js").manualInstruments
    if (payment.paymentGatewayConfigId || payment.finAccountId || !manual.includes(payment.paymentInstrumentEnumId)) return true
    const ids = [payment.paymentMethodId, payment.toPaymentMethodId].filter(Boolean)
    if (!ids.length) return false
    return Array.from(
        lib.find("mantle.account.method.PaymentMethod").condition("paymentMethodId", "in", ids).useCache(false).list()
    ).some(method => method.paymentGatewayConfigId || !["PmtBankAccount", "PmtOther"].includes(method.paymentMethodTypeEnumId))
}
function hasManualCash(payment) {
    // A later route configuration does not turn already posted native manual cash into a provider capture.
    if (
        payment?.lifecycleManaged !== "Y" ||
        payment.gatewayRole ||
        payment.gatewayAttemptId ||
        payment.gatewayInstructionId ||
        payment.paymentGatewayConfigId ||
        !["PmntDelivered", "PmntConfirmed"].includes(payment.statusId)
    )
        return false
    if (lib.find("mantle.account.method.PaymentGatewayResponse", {paymentId: payment.paymentId}).useCache(false).limit(1).one())
        return false
    const transactions = Array.from(
        lib
            .find("mantle.ledger.transaction.AcctgTrans", {paymentId: payment.paymentId})
            .condition("acctgTransTypeEnumId", "in", [
                "AttPayment",
                "AttDisbursement",
                "AttReceipt",
                "AttIncomingPayment",
                "AttOutgoingPayment"
            ])
            .condition("reverseOfAcctgTransId", "is-null", null)
            .condition("reversedByAcctgTransId", "is-null", null)
            .useCache(false)
            .forUpdate(true)
            .list()
    )
    if (transactions.length !== 1) return false
    const tx = transactions[0],
        pref = lib.policy.preference(payment.financeOrganizationPartyId)
    if (
        tx.isPosted !== "Y" ||
        tx.glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
        tx.reverseOfAcctgTransId ||
        tx.reversedByAcctgTransId ||
        tx.organizationPartyId !== payment.financeOrganizationPartyId ||
        tx.amountUomId !== payment.amountUomId ||
        (pref.errorGlJournalId && tx.glJournalId === pref.errorGlJournalId) ||
        lib
            .find("mantle.ledger.transaction.AcctgTrans", {reverseOfAcctgTransId: tx.acctgTransId, isPosted: "Y"})
            .useCache(false)
            .forUpdate(true)
            .limit(1)
            .one()
    )
        return false
    const entries = Array.from(
        lib
            .find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: tx.acctgTransId})
            .useCache(false)
            .forUpdate(true)
            .list()
    )
    if (
        !entries.length ||
        entries.some(
            row => !row.glAccountId || !["D", "C"].includes(row.debitCreditFlag) || toDecimal(row.amount || 0).compare(0) < 0
        )
    )
        return false
    return ["D", "C"].every(flag =>
        entries
            .filter(row => row.debitCreditFlag === flag)
            .reduce((total, row) => total.add(row.amount || 0), toDecimal(0))
            .eq(payment.amount)
    )
}
function assertAdoptable(payment, lock = false) {
    if (isManaged(payment)) return
    let fence = lib.find(FENCE, {paymentId: payment.paymentId}).useCache(false).one()
    if (lock) {
        durable("prepare#Fence", {paymentIdList: [payment.paymentId]})
        fence = lib.find(FENCE, {paymentId: payment.paymentId}).useCache(false).forUpdate(true).one()
    }
    // A legacy request may already be at its provider. Do not adopt that original instruction while its result is in flight.
    if (gatewayCapable(payment) || fence?.everEnteredProvider === "Y")
        lib.denied(
            "LEGACY_GATEWAY_ADOPTION_REFUSED",
            "Keep this legacy provider instruction in its existing workflow; create a reviewed payment for new work"
        )
}
function adoptionRefusal(payment) {
    if (!payment || isManaged(payment)) return false
    return (
        gatewayCapable(payment) ||
        lib.find(FENCE, {paymentId: payment.paymentId}).useCache(false).one()?.everEnteredProvider === "Y"
    )
}
function durable(name, parameters) {
    const out = ec.service
        .sync()
        .name(internalPrefix + name)
        .parameters(parameters)
        .disableAuthz()
        .requireNewTransaction(true)
        .throwOnError(true)
        .call()
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
function fenceIds(p) {
    const ids = [...new Set(Array.from(p.paymentIdList || []).map(String))].sort()
    if (!ids.length || ids.length > 8 || ids.some(id => !id || id.length > 40))
        lib.denied("LEGACY_GATEWAY_IDENTITY_INVALID", "Legacy admission needs bounded persisted payment identities")
    return ids
}
function assertInternalCaller(recording = false) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const caller = ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => !name.startsWith(internalPrefix))
    const adoption =
        /^mantle\.account\.PaymentServices\.(store#PaymentDraft|preview#PaymentState|change#PaymentState|preview#PaymentUnapply|unapply#ReviewedPayment|refund#ReviewedPayment|reserve#PaymentGatewayAction)$/.test(
            caller || ""
        )
    if (!caller || (!providerLeaf(caller) && (recording || !adoption)))
        lib.denied("LEGACY_GATEWAY_INTERNAL_ONLY", "Legacy admission is an internal financial boundary")
    return caller
}
function prepareFence(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const ids = fenceIds(p)
    // This locking read must be the transaction's first SQL. Later ordinary reads then start after its wait even
    // on retained-snapshot engines. Never acquire a Fence or Payment lock while owning this creation mutex.
    if (!lib.find("mantle.account.payment.PaymentLegacyGatewayMutex", {mutexId: "admission"}).forUpdate(true).one())
        lib.denied("LEGACY_GATEWAY_MUTEX_UNAVAILABLE", "Legacy provider admission is unavailable")
    assertInternalCaller()
    for (const paymentId of ids) if (!lib.find(FENCE, {paymentId}).useCache(false).one()) lib.call("create#" + FENCE, {paymentId})
    return {complete: true}
}
function recordUse(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const ids = fenceIds(p)
    const fences = Array.from(
        lib.find(FENCE).condition("paymentId", "in", ids).useCache(false).orderBy("paymentId").forUpdate(true).list()
    )
    if (fences.length !== ids.length)
        lib.denied("LEGACY_GATEWAY_MUTEX_UNAVAILABLE", "Prepare legacy admission before entering the provider")
    // Classify the configured caller only after the locking read, so no older consistent snapshot survives its wait.
    const caller = assertInternalCaller(true)
    if (caller !== p.serviceName) lib.denied("LEGACY_GATEWAY_IDENTITY_INVALID", "Legacy provider identity changed")
    // Deliberately no Payment lock or FK. The legacy caller may already own an uncommitted financial row.
    if (Array.from(lib.find(P).condition("paymentId", "in", ids).useCache(false).list()).some(isManaged))
        lib.denied("GATEWAY_REVIEW_REQUIRED", "Use the reviewed payment workflow for this payment")
    for (const fence of fences) {
        if (fence.everEnteredProvider === "Y") continue
        fence.set("everEnteredProvider", "Y")
        fence.set("firstServiceName", p.serviceName)
        fence.set("firstGatewayConfigId", p.paymentGatewayConfigId || null)
        fence.set("enteredDate", ec.user.nowTimestamp)
        fence.update()
    }
    return {complete: true}
}
function guardFence(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const values = lib.map(p.entityValue || p),
        before = values.paymentId && lib.find(FENCE, {paymentId: values.paymentId}).useCache(false).one(),
        stage = ec.artifactExecution
            .getStackNameString()
            .split(", ")
            .find(name => name.startsWith(internalPrefix))
    if (p.eecaOperation === "delete")
        lib.denied("LEGACY_GATEWAY_FENCE_IMMUTABLE", "Legacy provider admission history cannot be deleted")
    if (
        !before &&
        stage === internalPrefix + "prepare#Fence" &&
        !values.everEnteredProvider &&
        !values.enteredDate &&
        !values.firstServiceName &&
        !values.firstGatewayConfigId
    )
        return
    if (
        before &&
        stage === internalPrefix + "record#Use" &&
        before.everEnteredProvider !== "Y" &&
        values.everEnteredProvider === "Y" &&
        values.firstServiceName &&
        values.enteredDate
    )
        return
    lib.denied("LEGACY_GATEWAY_FENCE_IMMUTABLE", "Legacy provider admission history cannot be changed")
}
function lockUnmanagedPayments(ids) {
    const unique = [...new Set(ids.filter(Boolean))].sort()
    if (!unique.length) return []
    const records = Array.from(
        lib.find(P).condition("paymentId", "in", unique).useCache(false).orderBy("paymentId").forUpdate(true).list()
    )
    if (records.some(isManaged))
        lib.denied("PAYMENT_SOURCE_CHANGED", "The payment entered the reviewed workflow; retry the operation")
    if (
        lib
            .find("mantle.account.payment.PaymentGatewayReservation")
            .condition("paymentId", "in", unique)
            .condition("holdKind", "cash")
            .condition("status", "held")
            .useCache(false)
            .forUpdate(true)
            .limit(1)
            .one()
    )
        lib.denied("GATEWAY_CASH_RESERVED", "Resolve the pending provider refund before changing its original cash")
    // First native adoption and every first cash hold require this same Payment lock. No org lock is needed or taken
    // for an unchanged, unmanaged legacy source, including legacy controllers that already own its Payment lock.
    return records
}
;({
    guard,
    isManaged,
    gatewayCapable,
    hasManualCash,
    adoptionRefusal,
    assertAdoptable,
    lockUnmanagedPayments,
    prepareFence,
    recordUse,
    guardFence
})
