// Unresolved noncash transitions and immutable merchant lookup identity retain their own capacity reservations.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
let f
function lookup(attemptId, key) {
    const h = helper(),
        current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId})
    return h.native("refresh#PaymentGatewayAttempt", {
        organizationPartyId: f.org,
        attemptId,
        attemptVersion: current.attemptVersion,
        operationKey: key
    })
}
function outcome(action, value) {
    helper().call("update#mantle.account.payment.PaymentGatewayTestControl", {
        paymentGatewayConfigId: f.gatewayId,
        lookupOutcomesJson: JSON.stringify({[action]: value})
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWSTATE")
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
feature("pending authorization retains noncash capacity and blocks another authorization until exact lookup completes", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        h.mode(f, "authorize", "pending")
        let pending, before, errors, completed
        try {
            pending = h.execute(h.preview(f, paymentId))
            before = h.lifecycle.detail(f, paymentId)
            errors = [
                h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId)),
                h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId, "capture", {amount: "20"}))
            ]
            outcome("authorize", "accepted")
            completed = lookup(pending.attemptId, "gwstate-auth-lookup")
        } finally {
            h.mode(f, "authorize", "accepted")
            outcome("authorize", null)
        }
        return {
            pending,
            before,
            errors,
            completed,
            after: h.lifecycle.detail(f, paymentId),
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "authorize"}),
            cash: h.lifecycle.count("mantle.ledger.transaction.AcctgTrans", {paymentId})
        }
    },
    then({pending, before, errors, completed, after, effect, cash}) {
        pending.providerState == "pending"
        pending.cashPaymentId == null
        before.payment.statusId == "PmntProposed"
        before.payment.isCash == false
        toDecimal(before.gatewayInstruction.authorizationHeldAmount).eq(60)
        errors.every(error => error.includes("GATEWAY_STATE_INVALID"))
        completed.financialState == "completed"
        completed.cashPaymentId == null
        completed.outputRows.length == 0
        after.payment.statusId == "PmntAuthorized"
        toDecimal(after.gatewayInstruction.authorizationHeldAmount).isZero()
        toDecimal(after.gatewayInstruction.authorizedAmount).eq(60)
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
        cash == 0
    }
})
feature("pending remaining release blocks new captures and retains its exact forty-unit amount through lookup", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        h.execute(h.preview(f, paymentId))
        h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
        h.mode(f, "release", "pending")
        let pending, before, errors, completed
        try {
            pending = h.execute(h.preview(f, paymentId, "release"))
            before = h.lifecycle.detail(f, paymentId)
            errors = [
                h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId, "capture", {amount: "20"})),
                h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId, "release"))
            ]
            outcome("release", "accepted")
            completed = lookup(pending.attemptId, "gwstate-release-lookup")
        } finally {
            h.mode(f, "release", "accepted")
            outcome("release", null)
        }
        return {
            pending,
            before,
            errors,
            completed,
            after: h.lifecycle.detail(f, paymentId),
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "release"})
        }
    },
    then({pending, before, errors, completed, after, effect}) {
        pending.providerState == "pending"
        toDecimal(pending.amount).eq(40)
        pending.cashPaymentId == null
        toDecimal(before.gatewayInstruction.releaseHeldAmount).eq(40)
        before.capabilities.canGatewayCapture == false
        errors.every(error => error.includes("GATEWAY_CAPACITY_RESERVED"))
        completed.financialState == "completed"
        completed.cashPaymentId == null
        toDecimal(after.gatewayInstruction.capturedAmount).eq(20)
        toDecimal(after.gatewayInstruction.releasedAmount).eq(40)
        toDecimal(after.gatewayInstruction.releaseHeldAmount).isZero()
        toDecimal(after.gatewayInstruction.capturableAmount).isZero()
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
feature("exact lookup refuses a different merchant namespace without invoking it or releasing the original capacity", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            config = h.lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: f.gatewayId}),
            originalNamespace = config.reviewedMerchantNamespace
        h.execute(h.preview(f, paymentId))
        h.mode(f, "capture", "pending")
        let pending, refused, before, completed, observedCount
        try {
            pending = h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
            h.call("update#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gatewayId,
                reviewedMerchantNamespace: originalNamespace + "/OTHER"
            })
            refused = lookup(pending.attemptId, "gwstate-wrong-merchant")
            before = h.lifecycle.detail(f, paymentId)
            observedCount = Number(
                h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"}).lookupCount
            )
            h.call("update#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gatewayId,
                reviewedMerchantNamespace: originalNamespace
            })
            outcome("capture", "accepted")
            completed = lookup(pending.attemptId, "gwstate-original-merchant")
        } finally {
            h.mode(f, "capture", "accepted")
            outcome("capture", null)
            h.call("update#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gatewayId,
                reviewedMerchantNamespace: originalNamespace
            })
        }
        return {
            pending,
            refused,
            before,
            completed,
            observedCount,
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
        }
    },
    then({pending, refused, before, completed, observedCount, effect}) {
        refused.providerState == "uncertain"
        refused.cashPaymentId == null
        refused.providerOperationId == pending.providerOperationId
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        observedCount == 0
        completed.financialState == "completed"
        completed.providerOperationId == pending.providerOperationId
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
