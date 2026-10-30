// Public gateway orchestrators race in independent server transactions; no financial lock spans provider I/O.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingProviderRefundFixtures.js")
let f
function compete(reviews, keys) {
    const requests = reviews.map((review, index) => ({
        previewId: review.previewId,
        inputFingerprint: review.inputFingerprint,
        operationKey: keys[index]
    }))
    return parallel(
        2,
        (thread, args) => {
            login(args.username)
            ec.artifactExecution.disableAuthz()
            try {
                return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.requests[thread])}
            } catch (error) {
                ec.message.clearErrors()
                return {failure: error.message}
            }
        },
        {username: ec.user.username, requests},
        {transaction: false, timeout: 60}
    )
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().gateway.fixtures("ACCT_P5_PRVCON")
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
feature("simultaneous exact refund keys produce one provider effect and one exact opposing cash/application pair", {
    when() {
        const h = helper(),
            cash = h.captured(f),
            paymentId = cash.cashPaymentId,
            review = h.gateway.preview(f, paymentId, "refund", {amount: "7"}),
            results = compete([review, review], ["prv-ref-exact-race", "prv-ref-exact-race"]),
            attempts = h.lib.rows("mantle.account.payment.PaymentGatewayAttempt", {paymentId, action: "refund"}),
            current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: attempts[0].attemptId})
        return {
            results,
            attempts,
            current,
            records: h.lib.rows("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}),
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "refund"})
        }
    },
    then({results, attempts, current, records, effects}) {
        results.every(row => row.result)
        results.every(row => row.result.attemptId === attempts[0].attemptId)
        results.filter(row => row.result.alreadyApplied).length == 1
        attempts.length == 1
        current.financialState == "completed"
        records.length == 1
        effects.length == 1
        Number(effects[0].invocationCount) == 1
        current.applicationResults.length == 1
        current.acctgTransIds.length == 2
    }
})
feature("different refund keys cannot reserve or pay more than the same capture's remaining cash", {
    when() {
        const h = helper(),
            cash = h.captured(f),
            paymentId = cash.cashPaymentId,
            reviews = [
                h.gateway.preview(f, paymentId, "refund", {amount: "14"}),
                h.gateway.preview(f, paymentId, "refund", {amount: "14"})
            ],
            results = compete(reviews, ["prv-ref-cap-first", "prv-ref-cap-second"])
        return {
            results,
            summary: h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}).refundSummary,
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "refund"}),
            holds: h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {paymentId, holdKind: "cash"}),
            records: h.lib.rows("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId})
        }
    },
    then({results, summary, effects, holds, records}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.failure).length == 1
        results.filter(row => row.failure).every(row => /REFUND_FUNDS_UNAVAILABLE|STALE_PREVIEW|STALE_REVISION/.test(row.failure))
        effects.length == 1
        Number(effects[0].invocationCount) == 1
        records.length == 1
        holds.length == 1
        holds[0].status == "consumed"
        toDecimal(summary.completedRefundAmount).eq(14)
        toDecimal(summary.refundableAmount).eq(6)
    }
})
