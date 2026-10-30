// Real native gateway stages: provider effects commit independently, accepted local cash remains exactly once.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const ATTEMPT = "mantle.account.payment.PaymentGatewayAttempt",
    EFFECT = "mantle.account.payment.PaymentGatewayTestEffect"
let f
function authorize(paymentId) {
    const h = helper()
    return h.execute(h.preview(f, paymentId))
}
function current(attemptId) {
    return helper().native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId})
}
function refresh(attemptId, key) {
    const value = current(attemptId)
    return helper().native("refresh#PaymentGatewayAttempt", {
        organizationPartyId: f.org,
        attemptId,
        attemptVersion: value.attemptVersion,
        operationKey: key || "gwy-lookup-" + ec.user.randomString(20)
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWEX")
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
feature("authorization completes without parent cash and exact operation replay invokes the provider only once", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            review = h.preview(f, paymentId),
            first = h.execute(review, "gwex-authorize-retry"),
            again = h.execute(review, "gwex-authorize-retry"),
            detail = h.lifecycle.detail(f, paymentId),
            effect = h.lib.one(EFFECT, {providerOperationId: first.providerOperationId, merchantNamespace: f.merchantNamespace})
        return {
            first,
            again,
            detail,
            effect,
            transactions: h.lifecycle.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            outputs: h.lifecycle.count("mantle.account.payment.PaymentIssuedOutput", {paymentId})
        }
    },
    then({first, again, detail, effect, transactions, outputs}) {
        first.providerState == "accepted"
        first.financialState == "completed"
        first.outcome == "completed"
        first.cashPaymentId == null
        first.outputRows.length == 0
        again.attemptId == first.attemptId
        again.providerOperationId == first.providerOperationId
        again.alreadyApplied == true
        Number(effect.invocationCount) == 1
        detail.payment.statusId == "PmntAuthorized"
        detail.payment.gatewayRole == "authorization"
        detail.payment.isCash == false
        detail.gatewayInstruction.authorizationAttemptId == first.attemptId
        toDecimal(detail.totals.amount).isZero()
        toDecimal(detail.totals.unappliedTotal).isZero()
        toDecimal(detail.gatewayInstruction.authorizedAmount).eq(60)
        toDecimal(detail.gatewayInstruction.capturableAmount).eq(60)
        detail.capabilities.canPrintReceipt == false
        transactions == 0
        outputs == 0
    }
})
feature("authorization sixty with captures twenty and forty creates two exact cash legs and no parent posting", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        const twenty = h.execute(h.preview(f, paymentId, "capture", {amount: "20"}), "gwex-capture-twenty"),
            forty = h.execute(h.preview(f, paymentId, "capture", {amount: "40"}), "gwex-capture-forty"),
            children = [twenty.cashPaymentId, forty.cashPaymentId],
            transactions = Array.from(
                h.lib.find("mantle.ledger.transaction.AcctgTrans").condition("paymentId", "in", children.filter(Boolean)).list()
            ),
            entries = transactions.flatMap(tx =>
                h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: tx.acctgTransId})
            ),
            detail = h.lifecycle.detail(f, paymentId)
        return {
            twenty,
            forty,
            children,
            transactions,
            entries,
            detail,
            parentCash: h.lifecycle.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            childDetails: children.filter(Boolean).map(id => h.lifecycle.detail(f, id))
        }
    },
    then({twenty, forty, children, transactions, entries, detail, parentCash, childDetails}) {
        twenty.financialState == "completed"
        forty.financialState == "completed"
        children.every(Boolean)
        children[0] != children[1]
        transactions.length == 2
        transactions.every(
            tx =>
                tx.isPosted === "Y" && tx.glFiscalTypeEnumId === "GLFT_ACTUAL" && tx.acctgTransTypeEnumId === "AttIncomingPayment"
        )
        entries
            .filter(row => row.glAccountId === "111100000" && row.debitCreditFlag === "D")
            .reduce((sum, row) => sum.add(row.amount), toDecimal(0))
            .eq(60)
        parentCash == 0
        childDetails.every(
            row => row.payment.gatewayRole === "capture" && row.payment.authorizationPaymentId === detail.payment.paymentId
        )
        childDetails.every(row => row.gatewayRows.some(transaction => transaction.cashPaymentId === row.payment.paymentId))
        twenty.outputRows.every(row => row.paymentId === children[0] && row.canOpen === true)
        forty.outputRows.every(row => row.paymentId === children[1] && row.canOpen === true)
        twenty.outputRows.length == 2
        forty.outputRows.length == 2
        toDecimal(detail.gatewayInstruction.capturedAmount).eq(60)
        toDecimal(detail.gatewayInstruction.providerCapturedAmount).eq(60)
        toDecimal(detail.gatewayInstruction.captureHeldAmount).isZero()
        toDecimal(detail.gatewayInstruction.capturableAmount).isZero()
    }
})
feature("release consumes only remaining authorization and creates no second cash instrument", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        const capture = h.execute(h.preview(f, paymentId, "capture", {amount: "20"})),
            review = h.preview(f, paymentId, "release"),
            released = h.execute(review, "gwex-release-rest"),
            again = h.execute(review, "gwex-release-rest"),
            detail = h.lifecycle.detail(f, paymentId)
        return {capture, released, again, detail, effects: h.lib.rows(EFFECT, {paymentId})}
    },
    then({capture, released, again, detail, effects}) {
        capture.financialState == "completed"
        released.financialState == "completed"
        toDecimal(released.amount).eq(40)
        released.cashPaymentId == null
        released.outputRows.length == 0
        again.attemptId == released.attemptId
        again.alreadyApplied == true
        effects.length == 3
        detail.gatewayInstruction.state == "released"
        toDecimal(detail.gatewayInstruction.capturedAmount).eq(20)
        toDecimal(detail.gatewayInstruction.releasedAmount).eq(40)
        toDecimal(detail.gatewayInstruction.capturableAmount).isZero()
        detail.capabilities.canGatewayCapture == false
    }
})
feature("pending capture retains a durable response and capacity hold then exact lookup completes the same operation", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        h.mode(f, "capture", "pending")
        let pending, replay, before, completed
        try {
            const review = h.preview(f, paymentId, "capture", {amount: "20"})
            pending = h.execute(review, "gwex-pending-capture")
            replay = h.execute(review, "gwex-pending-capture")
            before = h.lifecycle.detail(f, paymentId)
            h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                paymentGatewayConfigId: f.gatewayId,
                lookupOutcomesJson: JSON.stringify({capture: "accepted"})
            })
            completed = refresh(pending.attemptId)
        } finally {
            h.mode(f, "capture", "accepted")
            h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                paymentGatewayConfigId: f.gatewayId,
                lookupOutcomesJson: "{}"
            })
        }
        return {
            pending,
            replay,
            before,
            completed,
            effect: h.lib.one(EFFECT, {providerOperationId: pending.providerOperationId, merchantNamespace: f.merchantNamespace})
        }
    },
    then({pending, replay, before, completed, effect}) {
        pending.providerState == "pending"
        pending.financialState == "none"
        pending.cashPaymentId == null
        replay.attemptId == pending.attemptId
        replay.alreadyApplied == true
        before.gatewayRows.some(
            row => row.attemptId === pending.attemptId && row.providerState === "pending" && !row.cashPaymentId
        )
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        toDecimal(before.gatewayInstruction.capturableAmount).eq(40)
        completed.attemptId == pending.attemptId
        completed.providerOperationId == pending.providerOperationId
        completed.financialState == "completed"
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
feature("accepted-before-timeout stays uncertain until exact lookup and lookup replay never dispatches twice", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        h.mode(f, "capture", "accepted-timeout")
        let uncertain
        try {
            uncertain = h.execute(h.preview(f, paymentId, "capture", {amount: "10"}), "gwex-timeout-capture")
        } finally {
            h.mode(f, "capture", "accepted")
        }
        const before = current(uncertain.attemptId),
            lookup = {
                organizationPartyId: f.org,
                attemptId: uncertain.attemptId,
                attemptVersion: before.attemptVersion,
                operationKey: "gwex-timeout-lookup"
            },
            first = h.native("refresh#PaymentGatewayAttempt", lookup),
            replay = h.native("refresh#PaymentGatewayAttempt", lookup),
            effect = h.lib.one(EFFECT, {
                providerOperationId: uncertain.providerOperationId,
                merchantNamespace: f.merchantNamespace
            })
        return {uncertain, first, replay, effect}
    },
    then({uncertain, first, replay, effect}) {
        uncertain.providerState == "uncertain"
        uncertain.financialState == "none"
        uncertain.cashPaymentId == null
        first.financialState == "completed"
        replay.financialState == first.financialState
        replay.cashPaymentId == first.cashPaymentId
        replay.alreadyApplied == true
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
feature(
    "real independent typed lock after provider acceptance rolls local money back and financial-only recovery completes once",
    {
        when() {
            const h = helper(),
                paymentId = h.draft(f),
                failed = h.acceptedUnposted({
                    organizationPartyId: f.org,
                    paymentId,
                    paymentGatewayConfigId: f.gatewayId,
                    amount: "20",
                    effectiveDate: f.timestamp
                }),
                before = current(failed.attemptId),
                review = h.native("preview#PaymentGatewayRecovery", {
                    organizationPartyId: f.org,
                    attemptId: failed.attemptId,
                    attemptVersion: before.attemptVersion,
                    reason: "Real lock removed; complete already accepted cash"
                }),
                reloaded = h.native("get#PaymentGatewayActionPreview", {organizationPartyId: f.org, previewId: review.previewId}),
                result = h.native("complete#PaymentGatewayAttempt", {
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: "gwex-recover-local"
                }),
                again = h.native("complete#PaymentGatewayAttempt", {
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: "gwex-recover-local"
                }),
                effect = h.lib.one(EFFECT, {
                    providerOperationId: failed.providerOperationId,
                    merchantNamespace: f.merchantNamespace
                })
            return {failed, before, review, reloaded, result, again, effect}
        },
        then({failed, before, review, reloaded, result, again, effect}) {
            failed.providerState == "accepted"
            failed.financialState == "accepted_unposted"
            failed.reasonCode == "HARD_LOCK"
            failed.cashPaymentId == null
            before.capabilities.canGatewayRecover == true
            review.previewKind == "gatewayRecovery"
            review.financialOnly == true
            review.status == "review"
            review.canApply == true
            review.operationKey == null
            review.results.attemptId == failed.attemptId
            review.results.providerOperationId == failed.providerOperationId
            review.results.providerState == "accepted"
            review.results.financialState == "accepted_unposted"
            review.results.cashPaymentId == null
            Array.from(review.results.acctgTransIds || []).length == 0
            Array.from(review.results.applicationResults || []).length == 0
            Array.from(review.results.outputRows || []).length == 0
            review.postingSummary.cashPostingCount == 1
            reloaded.inputFingerprint == review.inputFingerprint
            result.financialState == "completed"
            result.cashPaymentId != null
            again.cashPaymentId == result.cashPaymentId
            again.alreadyApplied == true
            Number(effect.invocationCount) == 1
            result.accountingDateText == failed.accountingDateText
        }
    }
)
