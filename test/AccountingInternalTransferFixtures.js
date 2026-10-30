// Standalone paired transfers use two distinct owned banks; sharing one cash GL account is intentional.
const lifecycle = ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const {lib, call, native} = lifecycle
function fixtures(prefix) {
    const f = lifecycle.fixtures(prefix)
    f.feeAccountId = "710000000"
    if (!lib.one("mantle.ledger.account.GlAccountOrganization", {organizationPartyId: f.org, glAccountId: f.feeAccountId}))
        call("create#mantle.ledger.account.GlAccountOrganization", {organizationPartyId: f.org, glAccountId: f.feeAccountId})
    f.toMethodId = prefix + "_DEST_BANK"
    call("create#mantle.account.method.PaymentMethod", {
        paymentMethodId: f.toMethodId,
        ownerPartyId: f.org,
        paymentMethodTypeEnumId: "PmtBankAccount",
        currencyUomId: "USD",
        fromDate: 0,
        description: "Destination reserve bank",
        glAccountId: "111100000"
    })
    call("create#mantle.account.method.BankAccount", {
        paymentMethodId: f.toMethodId,
        bankName: "Native destination bank",
        typeEnumId: "BatChecking",
        accountNumber: "123123456",
        routingNumber: "111000025",
        lastCheckNumber: 1
    })
    return f
}
function request(f, extra = {}) {
    const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
    return Object.assign(
        {
            organizationPartyId: f.org,
            fromPaymentMethodId: f.methodId,
            fromMethodVersion: workflow.methodVersion(
                lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.methodId})
            ),
            toPaymentMethodId: f.toMethodId,
            toMethodVersion: workflow.methodVersion(
                lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.toMethodId})
            ),
            amount: "50",
            feeAmount: "0",
            currencyUomId: "USD",
            effectiveDate: f.timestamp,
            referenceNumber: "Reviewed internal bank transfer",
            reason: "Move principal between owned cash accounts"
        },
        extra
    )
}
function preview(f, extra = {}) {
    return native("preview#InternalTransfer", request(f, extra))
}
function confirm(review, operationKey = "transfer-" + ec.user.randomString(24)) {
    return native("create#InternalTransfer", {
        previewId: review.previewId,
        inputFingerprint: review.inputFingerprint,
        operationKey
    })
}
function counts(f) {
    return {
        pairs: lib.find("mantle.account.payment.PaymentInternalTransfer", {organizationPartyId: f.org}).count(),
        payments: lib
            .find("mantle.account.payment.Payment", {financeOrganizationPartyId: f.org, paymentTypeEnumId: "PtInternalTransfer"})
            .count(),
        transactions: lib.find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: f.org}).count(),
        outputs: lib.find("mantle.account.payment.PaymentContent").condition("contentTypeEnumId", "in", ["PctReceipt", "PctPaymentDocument", "PctCheckImage"]).count()
    }
}
;({lifecycle, lib, call, native, fixtures, request, preview, confirm, counts})
