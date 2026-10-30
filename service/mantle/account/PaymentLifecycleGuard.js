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
function refundDraftAdoption(before, after) {
    const controller = ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => name.startsWith("mantle.account.PaymentServices."))
    if (controller !== "mantle.account.PaymentServices.reserve#PaymentGatewayAction") return false
    const provenance = new Set(["lifecycleManaged", "financeOrganizationPartyId", "financeDirection"])
    if (
        !before ||
        before.lifecycleManaged === "Y" ||
        after.lifecycleManaged !== "Y" ||
        !["PmntProposed", "PmntPromised"].includes(before.statusId) ||
        before.paymentTypeEnumId !== "PtInvoicePayment" ||
        before.refundForPaymentId ||
        financialFields.some(field => !provenance.has(field) && !same(field, before[field], after[field]))
    )
        return false
    const attempt = lib
        .find("mantle.account.payment.PaymentGatewayAttempt", {
            refundDraftPaymentId: after.paymentId,
            action: "refund",
            providerState: "reserved",
            financialState: "none"
        })
        .useCache(false)
        .forUpdate(true)
        .one()
    const preview =
        attempt &&
        lib
            .find("mantle.account.payment.PaymentGatewayPreview", {previewId: attempt.previewId})
            .useCache(false)
            .forUpdate(true)
            .one()
    let reviewed = {}
    try {
        reviewed = JSON.parse(preview?.requestJson || "{}")
    } catch (_) {
        return false
    }
    if (
        !preview ||
        preview.userId !== ec.user.userId ||
        preview.organizationPartyId !== attempt.organizationPartyId ||
        preview.paymentId !== attempt.paymentId ||
        preview.action !== "refund" ||
        reviewed.refundPaymentId !== after.paymentId ||
        reviewed.refundSourceVersion !==
            ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js").paymentVersion(before)
    )
        return false
    const original = attempt && lib.find(P, {paymentId: attempt.paymentId}).useCache(false).forUpdate(true).one()
    if (
        !attempt ||
        !original ||
        attempt.userId !== ec.user.userId ||
        attempt.organizationPartyId !== after.financeOrganizationPartyId ||
        original.lifecycleManaged !== "Y" ||
        original.gatewayRole !== "capture" ||
        original.financeOrganizationPartyId !== attempt.organizationPartyId ||
        original.financeDirection !== after.financeDirection ||
        original.fromPartyId !== after.toPartyId ||
        original.toPartyId !== after.fromPartyId ||
        original.amountUomId !== after.amountUomId ||
        attempt.currencyUomId !== after.amountUomId
    )
        return false
    return true
}
function guard(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const values = lib.map(p.entityValue || p)
    const before = p.originalValue
        ? lib.map(p.originalValue)
        : values.paymentId
          ? lib.one(P, {paymentId: values.paymentId})
          : null
    const after = Object.assign({}, lib.map(before), values),
        financialChanged =
            !before || p.eecaOperation === "delete" || financialFields.some(field => !same(field, before[field], after[field])),
        stack = ec.artifactExecution.getStackNameString(),
        refundController =
            /mantle\.account\.PaymentServices\.(refund#ReviewedPayment|complete#PaymentGatewayAttempt)(?:\b|$)/.test(stack)
    if (financialChanged && !refundController) {
        const legacy = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js"),
            originals = [...new Set([before?.refundForPaymentId, after.refundForPaymentId].filter(Boolean))]
        for (const id of originals)
            if (legacy.isManaged(lib.one(P, {paymentId: id})))
                lib.denied("PAYMENT_REFUND_REVIEW_REQUIRED", "Use the reviewed refund workflow for this original payment")
        // Raw links need the same sorted source+child boundary as legacy refund wrappers. Lock before the
        // child-only common path, and re-read provenance so a waited first adoption cannot gain a late link.
        if (originals.length) legacy.lockUnmanagedPayments([before?.paymentId, after.paymentId, ...originals])
    }
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefundBackingGuard.js").payment({
        before,
        after,
        operation: p.eecaOperation,
        financialChanged
    })
    if (
        ec.resource.script("component://mr-mantle/service/mantle/account/PaymentTransferGuard.js").payment({
            before,
            after,
            operation: p.eecaOperation,
            financialChanged
        })
    )
        return
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
    if ([before, after].some(row => row?.gatewayInstructionId || row?.gatewayAttemptId || row?.gatewayRole)) {
        if (!/mantle\.account\.PaymentServices\.complete#PaymentGatewayAttempt(?:\b|$)/.test(stack))
            lib.denied("GATEWAY_PAYMENT_MANAGED", "Use the reviewed provider workflow to change this payment")
        return
    }
    if (refundDraftAdoption(before, after)) return
    const reviewed =
        /mantle\.account\.PaymentServices\.(create#PaymentDraft|store#PaymentDraft|change#PaymentState|unapply#ReviewedPayment|refund#ReviewedPayment|create#InternalTransfer)(?:\b|$)/.test(
            stack
        )
    if (!reviewed) lib.denied("PAYMENT_REVIEW_REQUIRED", "Use the reviewed payment workflow to change financial details or state")
}
;({guard})
