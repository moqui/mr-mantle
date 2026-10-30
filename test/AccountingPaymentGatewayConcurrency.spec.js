// Competing real gateway orchestrators use independent server transactions and durable provider request identities.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
let f
function start(paymentId) {
    const h = helper()
    h.execute(h.preview(f, paymentId))
}
function confirmations(reviews, keys) {
    return reviews.map((review, index) => ({
        previewId: review.previewId,
        inputFingerprint: review.inputFingerprint,
        operationKey: keys[index]
    }))
}
function compete(requests) {
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
        f = helper().fixtures("ACCT_P5_GWCON")
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
feature("simultaneous exact capture keys commit one provider effect, one cash leg and one pair of outputs", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        start(paymentId)
        const review = h.preview(f, paymentId, "capture", {amount: "20"}),
            results = compete(confirmations([review, review], ["gwcon-exact-capture", "gwcon-exact-capture"])),
            attempts = h.lib.rows("mantle.account.payment.PaymentGatewayAttempt", {paymentId, action: "capture"}),
            attempt = attempts[0],
            current = attempt && h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: attempt.attemptId})
        return {
            results,
            attempts,
            current,
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"}),
            cash: attempt?.cashPaymentId
                ? h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: attempt.cashPaymentId})
                : []
        }
    },
    then({results, attempts, current, effects, cash}) {
        results.every(row => row.result)
        results.every(row => row.result.attemptId === attempts[0].attemptId)
        results.filter(row => row.result.alreadyApplied).length == 1
        attempts.length == 1
        current.financialState == "completed"
        current.outputRows.length == 2
        effects.length == 1
        Number(effects[0].invocationCount) == 1
        cash.length == 1
        cash[0].isPosted == "Y"
    }
})
feature("different capture keys compete for one authorization without exceeding its sixty-unit capacity", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        start(paymentId)
        const reviews = [h.preview(f, paymentId, "capture", {amount: "40"}), h.preview(f, paymentId, "capture", {amount: "40"})],
            results = compete(confirmations(reviews, ["gwcon-cap-first", "gwcon-cap-second"]))
        return {
            results,
            detail: h.lifecycle.detail(f, paymentId),
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"}),
            holds: h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {paymentId, holdKind: "capture"})
        }
    },
    then({results, detail, effects, holds}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.failure?.includes("GATEWAY_CAPACITY_EXCEEDED")).length == 1
        effects.length == 1
        Number(effects[0].invocationCount) == 1
        toDecimal(detail.gatewayInstruction.capturedAmount).eq(40)
        toDecimal(detail.gatewayInstruction.capturableAmount).eq(20)
        toDecimal(detail.gatewayInstruction.captureHeldAmount).isZero()
        holds.length == 1
        holds[0].status == "consumed"
    }
})
feature("a capture and release race never both spend the same remaining authorization", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        start(paymentId)
        const reviews = [h.preview(f, paymentId, "capture", {amount: "20"}), h.preview(f, paymentId, "release")],
            results = compete(confirmations(reviews, ["gwcon-capture-race", "gwcon-release-race"]))
        return {
            results,
            detail: h.lifecycle.detail(f, paymentId),
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId})
        }
    },
    then({results, detail, effects}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.failure).length == 1
        results
            .filter(row => row.failure)
            .every(row =>
                /GATEWAY_CAPACITY_RESERVED|GATEWAY_AMOUNT_INVALID|GATEWAY_CAPACITY_EXCEEDED|STALE_PREVIEW/.test(row.failure)
            )
        effects.length == 2
        effects.every(row => Number(row.invocationCount) === 1)
        toDecimal(detail.gatewayInstruction.capturedAmount).add(detail.gatewayInstruction.releasedAmount).compare(60) <= 0
        toDecimal(detail.gatewayInstruction.captureHeldAmount).isZero()
        toDecimal(detail.gatewayInstruction.releaseHeldAmount).isZero()
    }
})
feature("disjoint authorization instructions sharing current cash mappings both complete under real competition", {
    when() {
        const h = helper(),
            ids = [h.draft(f), h.draft(f)]
        ids.forEach(start)
        const reviews = ids.map(id => h.preview(f, id, "capture", {amount: "20"})),
            results = compete(confirmations(reviews, ["gwcon-disjoint-first", "gwcon-disjoint-second"]))
        return {
            results,
            details: ids.map(id => h.lifecycle.detail(f, id)),
            effects: ids.flatMap(paymentId =>
                h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
            )
        }
    },
    then({results, details, effects}) {
        results.every(row => row.result?.financialState === "completed")
        results[0].result.cashPaymentId != results[1].result.cashPaymentId
        details.every(row => toDecimal(row.gatewayInstruction.capturedAmount).eq(20))
        effects.length == 2
        effects.every(row => Number(row.invocationCount) === 1)
    }
})
