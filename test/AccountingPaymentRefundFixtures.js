// Standalone refund sources use actual native manual cash and independent organizations.
const lifecycle = ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const {lib, call, native} = lifecycle
function fixtures(prefix) {
    return lifecycle.fixtures(prefix)
}
function cash(f, direction = "incoming", amount = "60") {
    return lifecycle.delivered(f, {cashDirection: direction, amount, paymentInstrumentEnumId: "PiOther"})
}
function request(f, paymentId, extra = {}) {
    const view = lifecycle.detail(f, paymentId),
        defaults = native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}).refundDefaults
    return Object.assign(
        {
            organizationPartyId: f.org,
            paymentId,
            sourceVersion: view.sourceVersion,
            amount: "20",
            effectiveDate: f.timestamp,
            reason: "Return original unused cash",
            referenceNumber: "Manual refund reviewed"
        },
        defaults,
        extra
    )
}
function preview(f, paymentId, extra = {}) {
    return native("preview#PaymentRefund", request(f, paymentId, extra))
}
function confirm(review, operationKey = "refund-" + ec.user.randomString(24)) {
    return native("refund#ReviewedPayment", {
        previewId: review.previewId,
        inputFingerprint: review.inputFingerprint,
        operationKey
    })
}
function counts(paymentId) {
    return {
        payments: lib.find("mantle.account.payment.Payment", {refundForPaymentId: paymentId}).count(),
        applications: lib.find("mantle.account.payment.PaymentApplication", {toPaymentId: paymentId}).count(),
        transactions: lib.find("mantle.ledger.transaction.AcctgTrans").count(),
        outputs: lib.find("mantle.account.payment.PaymentContent").condition("contentTypeEnumId", "in", ["PctReceipt", "PctPaymentDocument", "PctCheckImage"]).count(),
        provider: lib.find("mantle.account.method.PaymentGatewayResponse").count()
    }
}
;({lifecycle, lib, call, native, fixtures, cash, request, preview, confirm, counts})
