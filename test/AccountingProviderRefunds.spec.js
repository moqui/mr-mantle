// Actual reference refunds: provider effect, opposing cash and exact consumed original funding remain distinct.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
let f
function captured(direction = "incoming", amount = "20") {
    const h = helper(),
        parent = h.draft(f, {cashDirection: direction})
    h.execute(h.preview(f, parent))
    return {parent, result: h.execute(h.preview(f, parent, "capture", {amount}))}
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_PRVREF")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().lifecycle.settlement.base.cleanupLocks(f.org)
    }
})
feature("partial provider refunds consume both exact holds once and never restore authorization capture capacity", {
    when() {
        const h = helper(),
            cash = captured(),
            paymentId = cash.result.cashPaymentId,
            review = h.preview(f, paymentId, "refund", {amount: "7"}),
            first = h.execute(review, "prv-ref-seven"),
            second = h.execute(h.preview(f, paymentId, "refund", {amount: "13"}), "prv-ref-thirteen"),
            again = h.execute(review, "prv-ref-seven"),
            summary = h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}),
            parent = h.lifecycle.detail(f, cash.parent),
            record = h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: first.cashPaymentId}),
            holds = h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {attemptId: first.attemptId}),
            effect = h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {
                providerOperationId: first.providerOperationId,
                merchantNamespace: f.merchantNamespace
            })
        return {
            paymentId,
            review,
            first,
            second,
            again,
            summary,
            parent,
            record,
            holds,
            effect,
            child: h.lifecycle.detail(f, first.cashPaymentId),
            childRecord: h.lib.one("mantle.account.payment.Payment", {paymentId: first.cashPaymentId})
        }
    },
    then({paymentId, review, first, second, again, summary, parent, record, holds, effect, child, childRecord}) {
        review.refundSummary.complete == true
        review.reservationEffects.length == 2
        toDecimal(review.before.providerRefundedAmount).isZero()
        toDecimal(review.after.providerRefundedAmount).eq(7)
        review.reservationEffects.some(row => row.holdKind === "refund" && row.paymentId === paymentId)
        review.reservationEffects.some(row => row.holdKind === "cash" && row.paymentId === paymentId)
        first.providerState == "accepted"
        first.financialState == "completed"
        first.paymentId == paymentId
        first.originalPaymentId == paymentId
        first.refundPaymentId == first.cashPaymentId
        first.cashPaymentId != paymentId
        first.applicationResults.length == 1
        first.acctgTransIds.length == 2
        first.outputRows.length == 2
        first.outputRows.every(row => row.paymentId === first.cashPaymentId && row.canOpen === true && row.outputType !== "check")
        child.payment.paymentTypeEnumId == "PtRefund"
        child.payment.gatewayRole == "refund"
        childRecord.refundForPaymentId == paymentId
        child.payment.cashDirection == "outgoing"
        toDecimal(child.totals.unappliedTotal).isZero()
        record.gatewayAttemptId == first.attemptId
        record.paymentApplicationId == first.applicationResults[0].paymentApplicationId
        holds.length == 2
        holds.every(row => row.status === "consumed" && toDecimal(row.amount).eq(7))
        toDecimal(second.amount).eq(13)
        again.cashPaymentId == first.cashPaymentId
        again.applicationResults[0].paymentApplicationId == first.applicationResults[0].paymentApplicationId
        again.alreadyApplied == true
        Number(effect.invocationCount) == 1
        toDecimal(summary.refundSummary.completedRefundAmount).eq(20)
        toDecimal(summary.refundSummary.providerRefundedAmount).eq(20)
        toDecimal(summary.refundSummary.refundableAmount).isZero()
        toDecimal(parent.gatewayInstruction.capturedAmount).eq(20)
        toDecimal(parent.gatewayInstruction.capturableAmount).eq(40)
    }
})
feature("an outgoing capture refunds inward on the payable side with exact linked cash and application postings", {
    when() {
        const h = helper(),
            cash = captured("outgoing"),
            paymentId = cash.result.cashPaymentId,
            result = h.execute(h.preview(f, paymentId, "refund", {amount: "9"})),
            record = h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: result.cashPaymentId})
        return {
            result,
            record,
            child: h.lifecycle.detail(f, result.cashPaymentId),
            summary: h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
        }
    },
    then({result, record, child, summary}) {
        result.financialState == "completed"
        child.payment.gatewayRole == "refund"
        child.payment.cashDirection == "incoming"
        child.payment.financeDirection == "payable"
        record.financeDirection == "payable"
        record.gatewayAttemptId == result.attemptId
        result.acctgTransIds.length == 2
        toDecimal(summary.refundSummary.refundableAmount).eq(11)
    }
})
feature(
    "a clean unmanaged opposing draft is claimed by reviewed revision before conversion to the actual provider refund child",
    {
        when() {
            const h = helper(),
                cash = captured(),
                paymentId = cash.result.cashPaymentId,
                draftId = ec.user.randomString(32)
            h.call("create#mantle.account.payment.Payment", {
                paymentId: draftId,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiOther",
                statusId: "PmntProposed",
                fromPartyId: f.org,
                toPartyId: f.customer,
                amount: "3",
                amountUomId: "USD",
                effectiveDate: f.timestamp,
                paymentMethodId: f.methodId
            })
            const draft = h.lifecycle.detail(f, draftId),
                review = h.preview(f, paymentId, "refund", {
                    amount: "7",
                    refundPaymentId: draftId,
                    refundSourceVersion: draft.sourceVersion
                }),
                result = h.execute(review),
                claim = h.lib.one("mantle.account.payment.PaymentRefundDraftClaim", {refundPaymentId: draftId})
            return {
                draftId,
                review,
                result,
                claim,
                child: h.lifecycle.detail(f, draftId),
                attempt: h.lib.one("mantle.account.payment.PaymentGatewayAttempt", {attemptId: result.attemptId})
            }
        },
        then({draftId, review, result, claim, child, attempt}) {
            review.refundPaymentId == draftId
            review.draftClaim.refundPaymentId == draftId
            result.financialState == "completed"
            result.cashPaymentId == draftId
            claim.status == "consumed"
            claim.attemptId == result.attemptId
            attempt.refundDraftPaymentId == draftId
            Boolean(attempt.refundDraftVersion)
            child.payment.lifecycleManaged == "Y"
            child.payment.gatewayRole == "refund"
            toDecimal(child.payment.amount).eq(7)
        }
    }
)
