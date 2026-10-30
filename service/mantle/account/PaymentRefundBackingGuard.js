// Completed refunds retain their exact cash/funding history; unresolved provider claims freeze their chosen draft.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const legacy = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
const P = "mantle.account.payment.Payment"
const identityFields = [
    "paymentTypeEnumId",
    "paymentInstrumentEnumId",
    "paymentGatewayConfigId",
    "fromPartyId",
    "toPartyId",
    "paymentMethodId",
    "toPaymentMethodId",
    "amount",
    "amountUomId",
    "effectiveDate",
    "accountingDate",
    "financeOrganizationPartyId",
    "financeDirection",
    "forInvoiceId",
    "refundForPaymentId",
    "orderId",
    "orderPartSeqId",
    "orderItemSeqId",
    "overrideGlAccountId",
    "overrideOrgPartyId",
    "finAccountId",
    "finAccountAuthId",
    "finAccountTransId",
    "paymentMethodFileId",
    "lifecycleManaged"
]
function refunds() {
    return ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefunds.js")
}
function same(field, before, after) {
    if (field === "amount") return toDecimal(before ?? 0).eq(after ?? 0)
    if (field === "accountingDate") return lib.policy.calendarDateText(before) === lib.policy.calendarDateText(after)
    if (field.endsWith("Date")) return lib.ms(before) === lib.ms(after)
    return String(before ?? "") === String(after ?? "")
}
function lockPayments(paymentIds) {
    const ids = [...new Set(paymentIds.filter(Boolean))].sort()
    if (!ids.length) return []
    const initial = Array.from(lib.find(P).condition("paymentId", "in", ids).useCache(false).list())
    if (!initial.some(legacy.isManaged)) return legacy.lockUnmanagedPayments(ids)
    const orgs = [...new Set(initial.map(payment => payment.financeOrganizationPartyId).filter(Boolean))].sort()
    if (orgs.length)
        Array.from(lib.find("mantle.party.Party").condition("partyId", "in", orgs).orderBy("partyId").forUpdate(true).list())
    const current = Array.from(
        lib.find(P).condition("paymentId", "in", ids).useCache(false).orderBy("paymentId").forUpdate(true).list()
    )
    if (current.some(payment => payment.financeOrganizationPartyId && !orgs.includes(payment.financeOrganizationPartyId)))
        lib.denied("PAYMENT_SOURCE_CHANGED", "The payment scope changed; retry the operation")
    return current
}
function assertDraftAvailable(p) {
    if (refunds().heldDraftClaim({paymentId: p.paymentId, organizationPartyId: p.organizationPartyId, lock: !!p.lock}))
        lib.denied("REFUND_DRAFT_CLAIMED", "Resolve the pending provider refund before changing its chosen draft")
}
function payment(p) {
    if (!p.financialChanged || !p.before?.paymentId) return
    const records = lockPayments([p.before.paymentId]),
        current = records.find(row => row.paymentId === p.before.paymentId)
    if (!current) lib.denied("PAYMENT_SOURCE_CHANGED", "The payment is no longer available")
    assertDraftAvailable({paymentId: current.paymentId, organizationPartyId: current.financeOrganizationPartyId, lock: true})
    const funding = refunds().completedFunding({paymentId: current.paymentId, lock: true})
    if (!funding.records.length) return
    if (p.operation === "delete" || identityFields.some(field => !same(field, p.before[field], p.after?.[field])))
        lib.denied("REFUND_PAYMENT_IMMUTABLE", "A refunded cash payment keeps its original money and source identity")
    if (!["PmntDelivered", "PmntConfirmed"].includes(p.after.statusId))
        lib.denied("REFUND_PAYMENT_IMMUTABLE", "A completed refund prevents cancelling or voiding its cash source")
}
function application(p) {
    let hasBacking = false
    for (const paymentId of [
        ...new Set([p.before?.paymentId, p.before?.toPaymentId, p.after?.paymentId, p.after?.toPaymentId].filter(Boolean))
    ].sort()) {
        assertDraftAvailable({paymentId, lock: true})
        if (refunds().completedFunding({paymentId, lock: true}).records.length) hasBacking = true
    }
    const ids = [...new Set([p.before?.paymentApplicationId, p.after?.paymentApplicationId].filter(Boolean))].sort()
    for (const paymentApplicationId of ids)
        if (refunds().completedFunding({paymentApplicationId, lock: true}).records.length)
            lib.denied("REFUND_FUNDING_IMMUTABLE", "A completed refund keeps its exact funding application")
    return hasBacking
}
function source(tx, types) {
    if (!tx || (!tx.paymentId && !tx.toPaymentId && !tx.paymentApplicationId)) return
    const paymentIds = [...new Set([tx.paymentId, tx.toPaymentId].filter(Boolean))].sort()
    for (const paymentId of paymentIds) assertDraftAvailable({paymentId, lock: true})
    if (tx.acctgTransId && refunds().completedFunding({acctgTransId: tx.acctgTransId, lock: true}).records.length)
        lib.denied("REFUND_SOURCE_IMMUTABLE", "Completed refund cash and funding postings cannot be rewritten or reversed")
    if (!types.cashTypes.includes(tx.acctgTransTypeEnumId)) return
    for (const paymentId of paymentIds)
        if (refunds().completedFunding({paymentId, lock: true}).records.length)
            lib.denied("REFUND_SOURCE_IMMUTABLE", "A refunded cash payment keeps its original cash posting")
}
function assertCorrection(p) {
    assertDraftAvailable({paymentId: p.paymentId, organizationPartyId: p.organizationPartyId, lock: !!p.lock})
    const funding = refunds().completedFunding({paymentId: p.paymentId, lock: !!p.lock})
    if (p.voidPayment && funding.records.length)
        lib.denied("REFUND_SOURCE_IMMUTABLE", "A completed refund prevents voiding its original cash payment")
    if (Array.from(p.paymentApplicationIdList || []).some(id => funding.protectedApplicationIds.includes(id)))
        lib.denied("REFUND_FUNDING_IMMUTABLE", "Unapply invoice allocations separately; a completed refund keeps its funding")
}
;({assertDraftAvailable, payment, application, source, assertCorrection})
