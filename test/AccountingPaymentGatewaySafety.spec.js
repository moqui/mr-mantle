// Reviewed source freshness, exact provider evidence and scoped financial authority are separate admission gates.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const CONTROL = "mantle.account.payment.PaymentGatewayTestControl",
    EFFECT = "mantle.account.payment.PaymentGatewayTestEffect"
let f
function authorize(paymentId) {
    const h = helper()
    return h.execute(h.preview(f, paymentId))
}
function lookup(attemptId) {
    const h = helper(),
        view = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId})
    return h.native("refresh#PaymentGatewayAttempt", {
        organizationPartyId: f.org,
        attemptId,
        attemptVersion: view.attemptVersion,
        operationKey: "gws-lookup-" + ec.user.randomString(20)
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWSAFE")
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
feature("financial draft, bank identity and binding changes after review refuse before any provider operation", {
    when() {
        const h = helper(),
            errors = [],
            effectCounts = []
        for (const kind of ["draft", "bank", "binding"]) {
            const paymentId = h.draft(f),
                review = h.preview(f, paymentId),
                bank = h.lib.one("mantle.account.method.BankAccount", {paymentMethodId: f.customerMethodId}),
                config = h.lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: f.gatewayId})
            try {
                if (kind === "draft") {
                    const module = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
                        method = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId})
                    h.native(
                        "store#PaymentDraft",
                        h.lifecycle.request(f, {
                            paymentId,
                            sourceVersion: h.lifecycle.detail(f, paymentId).sourceVersion,
                            amount: "65",
                            paymentInstrumentEnumId: "PiAch",
                            counterpartyPaymentMethodId: f.customerMethodId,
                            counterpartyMethodVersion: module.methodVersion(method)
                        })
                    )
                } else if (kind === "bank")
                    h.call("update#mantle.account.method.BankAccount", {
                        paymentMethodId: f.customerMethodId,
                        accountNumber: "456789012"
                    })
                else
                    h.call("update#mantle.account.method.PaymentGatewayConfig", {
                        paymentGatewayConfigId: f.gatewayId,
                        reviewedAdapterVersion: "fixture-v2"
                    })
                errors.push(
                    h.lifecycle.rejected("execute#PaymentGatewayAction", {
                        previewId: review.previewId,
                        inputFingerprint: review.inputFingerprint,
                        operationKey: "gws-stale-" + kind
                    })
                )
                effectCounts.push(h.lifecycle.count(EFFECT, {paymentId}))
            } finally {
                if (kind === "bank")
                    h.call("update#mantle.account.method.BankAccount", {
                        paymentMethodId: f.customerMethodId,
                        accountNumber: bank.accountNumber
                    })
                if (kind === "binding")
                    h.call("update#mantle.account.method.PaymentGatewayConfig", {
                        paymentGatewayConfigId: f.gatewayId,
                        reviewedAdapterVersion: config.reviewedAdapterVersion
                    })
            }
        }
        return {errors, effectCounts, positive: authorize(h.draft(f))}
    },
    then({errors, effectCounts, positive}) {
        errors[0].includes("STALE_REVISION")
        errors.slice(1).every(error => /STALE_GATEWAY_BINDING|STALE_PREVIEW/.test(error))
        effectCounts.every(count => count === 0)
        positive.financialState == "completed"
    }
})
feature("capture precision, authorization cap and original reviewed day are checked before provider execution", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        return {
            errors: [
                h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId, "capture", {amount: "0.001"})),
                h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId, "capture", {amount: "60.01"})),
                h.lifecycle.rejected(
                    "preview#PaymentGatewayAction",
                    h.request(f, paymentId, "capture", {amount: "20", effectiveDate: Number(f.timestamp) - 86400000})
                )
            ],
            effects: h.lib.rows(EFFECT, {paymentId}),
            positive: h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
        }
    },
    then({errors, effects, positive}) {
        errors[0].includes("CURRENCY_PRECISION")
        errors[1].includes("GATEWAY_CAPACITY_EXCEEDED")
        errors[2].includes("GATEWAY_BEFORE_PAYMENT")
        effects.length == 1
        effects[0].action == "authorize"
        positive.financialState == "completed"
    }
})
feature("declined capture releases its hold and exact retry cannot call the provider again", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        h.mode(f, "capture", "declined")
        let first, replay
        try {
            const review = h.preview(f, paymentId, "capture", {amount: "20"})
            first = h.execute(review, "gws-declined")
            replay = h.execute(review, "gws-declined")
        } finally {
            h.mode(f, "capture", "accepted")
        }
        const before = h.lifecycle.detail(f, paymentId),
            positive = h.execute(h.preview(f, paymentId, "capture", {amount: "60"}))
        return {
            first,
            replay,
            before,
            positive,
            effect: h.lib.one(EFFECT, {providerOperationId: first.providerOperationId, merchantNamespace: f.merchantNamespace})
        }
    },
    then({first, replay, before, positive, effect}) {
        first.providerState == "declined"
        first.financialState == "none"
        first.cashPaymentId == null
        replay.attemptId == first.attemptId
        replay.alreadyApplied == true
        Number(effect.invocationCount) == 1
        toDecimal(before.gatewayInstruction.captureHeldAmount).isZero()
        toDecimal(before.gatewayInstruction.capturableAmount).eq(60)
        positive.financialState == "completed"
        toDecimal(positive.amount).eq(60)
    }
})
feature("mismatched provider amount is quarantined until exact lookup proves the original accepted effect", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        const override =
            "amount" === "amount"
                ? {replyAmount: "1"}
                : "amount" === "currency"
                  ? {replyCurrencyUomId: "EUR"}
                  : {replyOperationId: "WRONG_PROVIDER_ID"}
        h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, override))
        let quarantined
        try {
            quarantined = h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
        } finally {
            h.call("update#" + CONTROL, {
                paymentGatewayConfigId: f.gatewayId,
                replyAmount: null,
                replyCurrencyUomId: null,
                replyOperationId: null
            })
        }
        const before = h.lifecycle.detail(f, paymentId),
            completed = lookup(quarantined.attemptId)
        return {
            quarantined,
            before,
            completed,
            effect: h.lib.one(EFFECT, {
                providerOperationId: quarantined.providerOperationId,
                merchantNamespace: f.merchantNamespace
            })
        }
    },
    then({quarantined, before, completed, effect}) {
        quarantined.providerState == "quarantined"
        quarantined.reasonCode == "GATEWAY_RECEIPT_MISMATCH"
        quarantined.cashPaymentId == null
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        toDecimal(before.gatewayInstruction.capturableAmount).eq(40)
        completed.attemptId == quarantined.attemptId
        completed.providerOperationId == quarantined.providerOperationId
        completed.financialState == "completed"
        toDecimal(completed.amount).eq(20)
        completed.currencyUomId == "USD"
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})

feature("mismatched provider currency is quarantined until exact lookup proves the original accepted effect", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        const override =
            "currency" === "amount"
                ? {replyAmount: "1"}
                : "currency" === "currency"
                  ? {replyCurrencyUomId: "EUR"}
                  : {replyOperationId: "WRONG_PROVIDER_ID"}
        h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, override))
        let quarantined
        try {
            quarantined = h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
        } finally {
            h.call("update#" + CONTROL, {
                paymentGatewayConfigId: f.gatewayId,
                replyAmount: null,
                replyCurrencyUomId: null,
                replyOperationId: null
            })
        }
        const before = h.lifecycle.detail(f, paymentId),
            completed = lookup(quarantined.attemptId)
        return {
            quarantined,
            before,
            completed,
            effect: h.lib.one(EFFECT, {
                providerOperationId: quarantined.providerOperationId,
                merchantNamespace: f.merchantNamespace
            })
        }
    },
    then({quarantined, before, completed, effect}) {
        quarantined.providerState == "quarantined"
        quarantined.reasonCode == "GATEWAY_RECEIPT_MISMATCH"
        quarantined.cashPaymentId == null
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        toDecimal(before.gatewayInstruction.capturableAmount).eq(40)
        completed.attemptId == quarantined.attemptId
        completed.providerOperationId == quarantined.providerOperationId
        completed.financialState == "completed"
        toDecimal(completed.amount).eq(20)
        completed.currencyUomId == "USD"
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})

feature("mismatched provider identity is quarantined until exact lookup proves the original accepted effect", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        authorize(paymentId)
        const override =
            "identity" === "amount"
                ? {replyAmount: "1"}
                : "identity" === "currency"
                  ? {replyCurrencyUomId: "EUR"}
                  : {replyOperationId: "WRONG_PROVIDER_ID"}
        h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, override))
        let quarantined
        try {
            quarantined = h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
        } finally {
            h.call("update#" + CONTROL, {
                paymentGatewayConfigId: f.gatewayId,
                replyAmount: null,
                replyCurrencyUomId: null,
                replyOperationId: null
            })
        }
        const before = h.lifecycle.detail(f, paymentId),
            completed = lookup(quarantined.attemptId)
        return {
            quarantined,
            before,
            completed,
            effect: h.lib.one(EFFECT, {
                providerOperationId: quarantined.providerOperationId,
                merchantNamespace: f.merchantNamespace
            })
        }
    },
    then({quarantined, before, completed, effect}) {
        quarantined.providerState == "quarantined"
        quarantined.reasonCode == "GATEWAY_RECEIPT_MISMATCH"
        quarantined.cashPaymentId == null
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        toDecimal(before.gatewayInstruction.capturableAmount).eq(40)
        completed.attemptId == quarantined.attemptId
        completed.providerOperationId == quarantined.providerOperationId
        completed.financialState == "completed"
        toDecimal(completed.amount).eq(20)
        completed.currencyUomId == "USD"
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
