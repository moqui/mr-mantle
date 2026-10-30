// Lifecycle provenance marks reviewed-native records; it never replaces the native service's permission/scope checks.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const P = "mantle.account.payment.Payment"
const financialFields = [
    "statusId",
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
    "settlementDate",
    "settlementAccountingDate",
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
    "paymentRefNum",
    "comments",
    "finAccountTransId",
    "paymentMethodFileId"
]
function same(field, before, after) {
    if (field === "amount") return toDecimal(before ?? 0).eq(after ?? 0)
    if (["accountingDate", "settlementAccountingDate"].includes(field))
        return lib.policy.calendarDateText(before) === lib.policy.calendarDateText(after)
    if (field.endsWith("Date")) return lib.ms(before) === lib.ms(after)
    return String(before ?? "") === String(after ?? "")
}
function guard(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const values = lib.map(p.entityValue || p)
    const before = p.originalValue
        ? lib.map(p.originalValue)
        : values.paymentId
          ? lib.one(P, {paymentId: values.paymentId})
          : null
    const after = Object.assign({}, lib.map(before), values)
    if (!before || p.eecaOperation === "delete" || financialFields.some(field => !same(field, before[field], after[field]))) {
        const legacy = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
        for (const id of [...new Set([before?.refundForPaymentId, after.refundForPaymentId].filter(Boolean))]) {
            if (
                legacy.isManaged(lib.one(P, {paymentId: id})) &&
                !/mantle\.account\.PaymentServices\.complete#PaymentGatewayAttempt(?:\b|$)/.test(
                    ec.artifactExecution.getStackNameString()
                )
            )
                lib.denied("PAYMENT_REFUND_REVIEW_REQUIRED", "Use the reviewed refund workflow for this original payment")
        }
    }
    if (before?.lifecycleManaged !== "Y" && after.lifecycleManaged !== "Y") {
        if (before && (p.eecaOperation === "delete" || financialFields.some(field => !same(field, before[field], after[field]))))
            ec.resource
                .script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
                .lockUnmanagedPayments([before.paymentId])
        return
    }
    if (p.eecaOperation === "delete")
        lib.denied("PAYMENT_DELETE_REFUSED", "Cancel or void a reviewed payment instead of deleting its history")
    if (before?.lifecycleManaged === "Y" && after.lifecycleManaged !== "Y")
        lib.denied("PAYMENT_PROVENANCE_IMMUTABLE", "A reviewed payment keeps its lifecycle provenance")
    const changed =
        !before || before.lifecycleManaged !== "Y" || financialFields.some(field => !same(field, before[field], after[field]))
    if (!changed) return
    const stack = ec.artifactExecution.getStackNameString()
    if ([before, after].some(row => row?.gatewayInstructionId || row?.gatewayAttemptId || row?.gatewayRole)) {
        if (!/mantle\.account\.PaymentServices\.complete#PaymentGatewayAttempt(?:\b|$)/.test(stack))
            lib.denied("GATEWAY_PAYMENT_MANAGED", "Use the reviewed provider workflow to change this payment")
        return
    }
    const reviewed =
        /mantle\.account\.PaymentServices\.(create#PaymentDraft|store#PaymentDraft|change#PaymentState|unapply#ReviewedPayment)(?:\b|$)/.test(
            stack
        )
    if (!reviewed) lib.denied("PAYMENT_REVIEW_REQUIRED", "Use the reviewed payment workflow to change financial details or state")
}
;({guard})
