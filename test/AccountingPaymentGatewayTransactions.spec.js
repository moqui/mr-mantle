// Real retained caller transactions and an interrupted exact lookup claim, without a simulated financial controller.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const CONTROL = "mantle.account.payment.PaymentGatewayTestControl",
    EFFECT = "mantle.account.payment.PaymentGatewayTestEffect",
    OBSERVATION = "mantle.account.payment.PaymentGatewayTestObservation"
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWTX")
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
feature("cached caller reads and rollback do not hide or roll back independently completed provider cash", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        h.execute(h.preview(f, paymentId))
        const review = h.preview(f, paymentId, "capture", {amount: "20"}),
            observationId = "GTW_OBS_" + ec.user.randomString(20),
            markerId = "GTW_MARK_" + ec.user.randomString(20)
        h.call("create#" + OBSERVATION, {observationId, resultJson: "{}"})
        const results = parallel(
            1,
            (thread, args) => {
                login(args.username)
                ec.artifactExecution.disableAuthz()
                try {
                    ec.service
                        .sync()
                        .name("mantle.account.PaymentGatewayTestServices.probe#CallerRollback")
                        .parameters(args.request)
                        .disableAuthz()
                        .throwOnError(true)
                        .call()
                    return {unexpectedSuccess: true}
                } catch (error) {
                    ec.message.clearErrors()
                    return {failure: error.message}
                }
            },
            {
                username: ec.user.username,
                request: {
                    organizationPartyId: f.org,
                    paymentId,
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: "gwtx-caller-rollback",
                    observationId,
                    markerId
                }
            },
            {transaction: false, timeout: 60}
        )
        const observation = JSON.parse(h.lib.one(OBSERVATION, {observationId}).resultJson),
            result = observation.result,
            current = result?.attemptId
                ? h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: result.attemptId})
                : null,
            cash = result?.cashPaymentId ? h.lifecycle.detail(f, result.cashPaymentId) : null
        return {
            results,
            observation,
            result,
            current,
            cash,
            marker: h.lib.one(OBSERVATION, {observationId: markerId}),
            effects: h.lib.rows(EFFECT, {paymentId, action: "capture"}),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: result?.cashPaymentId || "NONE"})
        }
    },
    then({results, observation, result, current, cash, marker, effects, transactions}) {
        results.length == 1
        results[0].failure.includes("TEST_CALLER_ROLLBACK")
        observation.cached == true
        observation.inTransaction == true
        observation.beforeStatusId == "PmntAuthorized"
        observation.failure == null
        result.financialState == "completed"
        result.cashPaymentId != null
        result.attemptVersion != null
        current.financialState == "completed"
        current.cashPaymentId == result.cashPaymentId
        cash.payment.gatewayRole == "capture"
        toDecimal(cash.totals.amount).eq(20)
        marker == null
        effects.length == 1
        Number(effects[0].invocationCount) == 1
        transactions.length == 1
        transactions[0].isPosted == "Y"
        result.outputRows.length == 2
        result.outputRows.every(row => row.paymentId === result.cashPaymentId)
    }
})
feature("same-key lookup replay before finish retains a usable claimed version and does not issue another lookup", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        h.execute(h.preview(f, paymentId))
        h.mode(f, "capture", "pending")
        let pending, results
        const saved = h.lib.policy.pick(h.lib.map(h.lib.one(CONTROL, {paymentGatewayConfigId: f.gatewayId})), [
            "lookupOutcomesJson",
            "holdLookup",
            "releaseLookup",
            "barrierPaymentId",
            "barrierAction"
        ])
        try {
            pending = h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
            const before = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: pending.attemptId}),
                request = {
                    organizationPartyId: f.org,
                    attemptId: pending.attemptId,
                    attemptVersion: before.attemptVersion,
                    operationKey: "gwtx-interrupted-lookup"
                }
            h.call("update#" + CONTROL, {
                paymentGatewayConfigId: f.gatewayId,
                lookupOutcomesJson: JSON.stringify({capture: "accepted"}),
                holdLookup: "Y",
                releaseLookup: "N",
                barrierPaymentId: paymentId,
                barrierAction: "capture"
            })
            results = parallel(
                2,
                (thread, args) => {
                    login(args.username)
                    ec.artifactExecution.disableAuthz()
                    if (thread === 0)
                        return {result: call("mantle.account.PaymentServices.refresh#PaymentGatewayAttempt", args.request)}
                    const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js"),
                        observed = () =>
                            lib
                                .find("mantle.account.payment.PaymentGatewayTestEffect", {
                                    providerOperationId: args.providerOperationId,
                                    merchantNamespace: args.merchantNamespace
                                })
                                .useCache(false)
                                .one(),
                        deadline = Date.now() + 15000
                    try {
                        while (Number(observed()?.lookupCount || 0) < 1 && Date.now() < deadline) {}
                        if (Number(observed()?.lookupCount || 0) !== 1)
                            throw new Error("TEST_LOOKUP_NOT_OBSERVED: Provider lookup did not reach its committed barrier")
                        const result = call("mantle.account.PaymentServices.refresh#PaymentGatewayAttempt", args.request),
                            effect = observed()
                        return {result, observedLookupCount: Number(effect.lookupCount), replayBeforeRelease: true}
                    } finally {
                        call("update#mantle.account.payment.PaymentGatewayTestControl", {
                            paymentGatewayConfigId: args.gatewayId,
                            releaseLookup: "Y"
                        })
                    }
                },
                {
                    username: ec.user.username,
                    request,
                    providerOperationId: pending.providerOperationId,
                    merchantNamespace: f.merchantNamespace,
                    gatewayId: f.gatewayId
                },
                {transaction: false, timeout: 60}
            )
        } finally {
            h.mode(f, "capture", "accepted")
            h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
        }
        return {
            pending,
            results,
            effect: h.lib.one(EFFECT, {providerOperationId: pending.providerOperationId, merchantNamespace: f.merchantNamespace})
        }
    },
    then({pending, results, effect}) {
        results.length == 2
        results[0].result.financialState == "completed"
        results[0].result.cashPaymentId != null
        results[1].replayBeforeRelease == true
        results[1].observedLookupCount == 1
        results[1].result.attemptId == pending.attemptId
        results[1].result.providerState == "pending"
        results[1].result.financialState == "none"
        results[1].result.attemptVersion != null
        results[1].result.attemptVersion.length > 0
        results[1].result.capabilities.canGatewayRefresh == false
        results[1].result.alreadyApplied == true
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
