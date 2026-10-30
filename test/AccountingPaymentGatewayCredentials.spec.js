// Invocation consumes a reviewed by-value credential snapshot; exact lookup never consults rotated credentials.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const CONTROL = "mantle.account.payment.PaymentGatewayTestControl",
    METHOD = "mantle.account.method.PaymentMethod",
    BANK = "mantle.account.method.BankAccount"
let f
const controlFields = [
    "holdBeforePrepare",
    "releasePrepare",
    "enteredPrepare",
    "holdBeforeEffect",
    "releaseEffect",
    "enteredEffect",
    "barrierPaymentId",
    "barrierAction",
    "lookupNoExecution",
    "lookupOutcomesJson"
]
function ready() {
    const h = helper(),
        paymentId = h.draft(f)
    h.execute(h.preview(f, paymentId))
    return paymentId
}
function runRace(paymentId, review, barrier, mutations, key) {
    return parallel(
        2,
        (thread, args) => {
            login(args.username)
            ec.artifactExecution.disableAuthz()
            if (thread === 0) return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
            const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js"),
                entered = () =>
                    lib
                        .find("mantle.account.payment.PaymentGatewayTestControl", {paymentGatewayConfigId: args.gatewayId})
                        .useCache(false)
                        .one()?.[args.barrier] === "Y",
                deadline = Date.now() + 15000
            try {
                while (!entered() && Date.now() < deadline) {}
                if (!entered()) throw new Error("TEST_CREDENTIAL_BARRIER_TIMEOUT: Native credential boundary was not reached")
                for (const mutation of args.mutations) call(mutation.service, mutation.values)
                return {changedAtBarrier: true}
            } finally {
                call(
                    "update#mantle.account.payment.PaymentGatewayTestControl",
                    Object.assign({paymentGatewayConfigId: args.gatewayId}, args.release)
                )
            }
        },
        {
            username: ec.user.username,
            gatewayId: f.gatewayId,
            barrier,
            mutations,
            release: barrier === "enteredPrepare" ? {releasePrepare: "Y"} : {releaseEffect: "Y"},
            confirm: {previewId: review.previewId, inputFingerprint: review.inputFingerprint, operationKey: key}
        },
        {transaction: false, timeout: 60}
    )
}
function exactLookup(attemptId, key) {
    const h = helper(),
        current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId})
    return h.native("refresh#PaymentGatewayAttempt", {
        organizationPartyId: f.org,
        attemptId,
        attemptVersion: current.attemptVersion,
        operationKey: key
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWCRED")
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
feature("an adapter without an explicit reviewed-method-snapshot guarantee cannot authorize", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            config = h.lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: f.gatewayId}),
            original = config.reviewedGuaranteesJson,
            declarations = JSON.parse(original)
        delete declarations.authorize.reviewedMethodSnapshot
        h.call("update#mantle.account.method.PaymentGatewayConfig", {
            paymentGatewayConfigId: f.gatewayId,
            reviewedGuaranteesJson: JSON.stringify(declarations)
        })
        let refused, detail
        try {
            refused = h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId))
            detail = h.lifecycle.detail(f, paymentId)
        } finally {
            h.call("update#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gatewayId,
                reviewedGuaranteesJson: original
            })
        }
        return {
            refused,
            detail,
            effects: h.lifecycle.count("mantle.account.payment.PaymentGatewayTestEffect", {paymentId}),
            positive: h.preview(f, paymentId)
        }
    },
    then({refused, detail, effects, positive}) {
        refused.includes("GATEWAY_ADAPTER_UNSUPPORTED")
        detail.capabilities.canGatewayAuthorize == false
        detail.capabilities.gatewayReasons.includes("GATEWAY_ADAPTER_UNSUPPORTED")
        effects == 0
        positive.canApply == true
    }
})
feature("a bank change after durable reserve refuses credential preparation before any provider effect", {
    when() {
        const h = helper(),
            paymentId = ready(),
            review = h.preview(f, paymentId, "capture", {amount: "20"}),
            method = h.lib.map(h.lib.one(METHOD, {paymentMethodId: f.customerMethodId})),
            bank = h.lib.map(h.lib.one(BANK, {paymentMethodId: f.customerMethodId})),
            saved = h.lib.policy.pick(h.lib.map(h.lib.one(CONTROL, {paymentGatewayConfigId: f.gatewayId})), controlFields),
            mutation =
                "bank" === "bank"
                    ? {service: "update#" + BANK, values: {paymentMethodId: f.customerMethodId, accountNumber: "432109876"}}
                    : {
                          service: "update#" + METHOD,
                          values: {paymentMethodId: f.customerMethodId, gatewayCimId: "ROTATED_AFTER_RESERVE"}
                      }
        h.call("update#" + CONTROL, {
            paymentGatewayConfigId: f.gatewayId,
            holdBeforePrepare: "Y",
            enteredPrepare: "N",
            releasePrepare: "N",
            barrierPaymentId: paymentId,
            barrierAction: "capture",
            lookupNoExecution: "Y"
        })
        let results, before, lookup
        try {
            results = runRace(paymentId, review, "enteredPrepare", [mutation], "gwcred-before-" + "bank")
            before = h.lifecycle.detail(f, paymentId)
            h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
            h.call("update#" + METHOD, {paymentMethodId: f.customerMethodId, gatewayCimId: method.gatewayCimId})
            lookup = exactLookup(results[0].result.attemptId, "gwcred-no-effect-" + "bank")
        } finally {
            h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
            h.call("update#" + METHOD, {paymentMethodId: f.customerMethodId, gatewayCimId: method.gatewayCimId})
            h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
        }
        return {
            results,
            before,
            lookup,
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"}),
            after: h.lifecycle.detail(f, paymentId)
        }
    },
    then({results, before, lookup, effects, after}) {
        results[1].changedAtBarrier == true
        results[0].result.providerState == "uncertain"
        results[0].result.cashPaymentId == null
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        effects.length == 0
        lookup.providerState == "declined"
        lookup.reasonCode == "GATEWAY_NOT_EXECUTED"
        lookup.cashPaymentId == null
        toDecimal(after.gatewayInstruction.captureHeldAmount).isZero()
        toDecimal(after.gatewayInstruction.capturableAmount).eq(60)
    }
})

feature("a token change after durable reserve refuses credential preparation before any provider effect", {
    when() {
        const h = helper(),
            paymentId = ready(),
            review = h.preview(f, paymentId, "capture", {amount: "20"}),
            method = h.lib.map(h.lib.one(METHOD, {paymentMethodId: f.customerMethodId})),
            bank = h.lib.map(h.lib.one(BANK, {paymentMethodId: f.customerMethodId})),
            saved = h.lib.policy.pick(h.lib.map(h.lib.one(CONTROL, {paymentGatewayConfigId: f.gatewayId})), controlFields),
            mutation =
                "token" === "bank"
                    ? {service: "update#" + BANK, values: {paymentMethodId: f.customerMethodId, accountNumber: "432109876"}}
                    : {
                          service: "update#" + METHOD,
                          values: {paymentMethodId: f.customerMethodId, gatewayCimId: "ROTATED_AFTER_RESERVE"}
                      }
        h.call("update#" + CONTROL, {
            paymentGatewayConfigId: f.gatewayId,
            holdBeforePrepare: "Y",
            enteredPrepare: "N",
            releasePrepare: "N",
            barrierPaymentId: paymentId,
            barrierAction: "capture",
            lookupNoExecution: "Y"
        })
        let results, before, lookup
        try {
            results = runRace(paymentId, review, "enteredPrepare", [mutation], "gwcred-before-" + "token")
            before = h.lifecycle.detail(f, paymentId)
            h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
            h.call("update#" + METHOD, {paymentMethodId: f.customerMethodId, gatewayCimId: method.gatewayCimId})
            lookup = exactLookup(results[0].result.attemptId, "gwcred-no-effect-" + "token")
        } finally {
            h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
            h.call("update#" + METHOD, {paymentMethodId: f.customerMethodId, gatewayCimId: method.gatewayCimId})
            h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
        }
        return {
            results,
            before,
            lookup,
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"}),
            after: h.lifecycle.detail(f, paymentId)
        }
    },
    then({results, before, lookup, effects, after}) {
        results[1].changedAtBarrier == true
        results[0].result.providerState == "uncertain"
        results[0].result.cashPaymentId == null
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        effects.length == 0
        lookup.providerState == "declined"
        lookup.reasonCode == "GATEWAY_NOT_EXECUTED"
        lookup.cashPaymentId == null
        toDecimal(after.gatewayInstruction.captureHeldAmount).isZero()
        toDecimal(after.gatewayInstruction.capturableAmount).eq(60)
    }
})
feature(
    "the adapter consumes its original credential snapshot and lookup reconciles after rotation and expiry without another charge",
    {
        when() {
            const h = helper(),
                paymentId = ready(),
                review = h.preview(f, paymentId, "capture", {amount: "20"}),
                workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
                provider = ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayProvider.js"),
                method = h.lib.map(h.lib.one(METHOD, {paymentMethodId: f.customerMethodId})),
                bank = h.lib.map(h.lib.one(BANK, {paymentMethodId: f.customerMethodId})),
                expectedVersion = workflow.methodVersion(h.lib.one(METHOD, {paymentMethodId: f.customerMethodId})),
                expectedHash = provider.credentialHash({method, bank}),
                saved = h.lib.policy.pick(h.lib.map(h.lib.one(CONTROL, {paymentGatewayConfigId: f.gatewayId})), controlFields)
            h.mode(f, "capture", "pending")
            h.call("update#" + CONTROL, {
                paymentGatewayConfigId: f.gatewayId,
                holdBeforeEffect: "Y",
                enteredEffect: "N",
                releaseEffect: "N",
                barrierPaymentId: paymentId,
                barrierAction: "capture",
                lookupOutcomesJson: JSON.stringify({capture: "accepted"})
            })
            let results, lookedUp, held, receipt, completed
            try {
                results = runRace(
                    paymentId,
                    review,
                    "enteredEffect",
                    [
                        {service: "update#" + BANK, values: {paymentMethodId: f.customerMethodId, accountNumber: "432109876"}},
                        {
                            service: "update#" + METHOD,
                            values: {
                                paymentMethodId: f.customerMethodId,
                                gatewayCimId: "ROTATED_WHILE_PROVIDER_WAITED",
                                thruDate: Number(f.timestamp) - 86400000
                            }
                        }
                    ],
                    "gwcred-frozen-snapshot"
                )
                lookedUp = exactLookup(results[0].result.attemptId, "gwcred-lookup-after-rotation")
                const attempt = h.lib.one("mantle.account.payment.PaymentGatewayAttempt", {attemptId: lookedUp.attemptId})
                held = h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {
                    attemptId: attempt.attemptId,
                    status: "held"
                })
                receipt = JSON.parse(attempt.receiptJson || "{}")
                h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
                h.call("update#" + METHOD, {
                    paymentMethodId: f.customerMethodId,
                    gatewayCimId: method.gatewayCimId,
                    thruDate: method.thruDate
                })
                const current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: attempt.attemptId}),
                    recovery = h.native("preview#PaymentGatewayRecovery", {
                        organizationPartyId: f.org,
                        attemptId: attempt.attemptId,
                        attemptVersion: current.attemptVersion,
                        reason: "Original reviewed banking identity restored; complete accepted money"
                    })
                completed = h.native("complete#PaymentGatewayAttempt", {
                    previewId: recovery.previewId,
                    inputFingerprint: recovery.inputFingerprint,
                    operationKey: "gwcred-financial-recovery"
                })
            } finally {
                h.mode(f, "capture", "accepted")
                h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
                h.call("update#" + METHOD, {
                    paymentMethodId: f.customerMethodId,
                    gatewayCimId: method.gatewayCimId,
                    thruDate: method.thruDate
                })
                h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
            }
            return {
                results,
                lookedUp,
                held,
                receipt,
                completed,
                expectedVersion,
                expectedHash,
                effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
            }
        },
        then({results, lookedUp, held, receipt, completed, expectedVersion, expectedHash, effect}) {
            results[1].changedAtBarrier == true
            results[0].result.providerState == "pending"
            effect.sourceMethodVersion == expectedVersion
            effect.sourceCredentialHash == expectedHash
            lookedUp.providerState == "accepted"
            lookedUp.financialState == "accepted_unposted"
            lookedUp.cashPaymentId == null
            lookedUp.reasonCode == "STALE_PAYMENT_METHOD"
            held.length == 1
            toDecimal(held[0].amount).eq(20)
            receipt.outcome == "accepted"
            completed.financialState == "completed"
            completed.attemptId == lookedUp.attemptId
            Number(effect.invocationCount) == 1
            Number(effect.lookupCount) == 1
        }
    }
)
feature("credential preparation waiting on a competing method lock compares only fresh locked method and subtype revisions", {
    when() {
        const h = helper(),
            paymentId = ready(),
            review = h.preview(f, paymentId, "capture", {amount: "20"}),
            method = h.lib.map(h.lib.one(METHOD, {paymentMethodId: f.customerMethodId})),
            bank = h.lib.map(h.lib.one(BANK, {paymentMethodId: f.customerMethodId})),
            expectedVersion = ec.resource
                .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
                .methodVersion(h.lib.one(METHOD, {paymentMethodId: f.customerMethodId})),
            saved = h.lib.policy.pick(h.lib.map(h.lib.one(CONTROL, {paymentGatewayConfigId: f.gatewayId})), controlFields)
        h.call("update#" + CONTROL, {
            paymentGatewayConfigId: f.gatewayId,
            holdBeforePrepare: "Y",
            enteredPrepare: "N",
            releasePrepare: "N",
            barrierPaymentId: paymentId,
            barrierAction: "capture",
            lookupNoExecution: "Y"
        })
        let results, before, lookup
        try {
            results = parallel(
                2,
                (thread, args) => {
                    login(args.username)
                    ec.artifactExecution.disableAuthz()
                    if (thread === 0)
                        return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
                    const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js"),
                        entered = () =>
                            lib
                                .find("mantle.account.payment.PaymentGatewayTestControl", {
                                    paymentGatewayConfigId: args.gatewayId
                                })
                                .useCache(false)
                                .one()?.enteredPrepare === "Y",
                        deadline = Date.now() + 15000
                    try {
                        while (!entered() && Date.now() < deadline) {}
                        if (!entered())
                            throw new Error("TEST_CREDENTIAL_BARRIER_TIMEOUT: The committed-reserve boundary was not reached")
                        return {
                            holder: call("mantle.account.PaymentGatewayTestServices.hold#CredentialChange", {
                                paymentGatewayConfigId: args.gatewayId,
                                paymentId: args.paymentId,
                                paymentMethodId: args.methodId
                            })
                        }
                    } finally {
                        call("update#mantle.account.payment.PaymentGatewayTestControl", {
                            paymentGatewayConfigId: args.gatewayId,
                            releasePrepare: "Y"
                        })
                    }
                },
                {
                    username: ec.user.username,
                    paymentId,
                    gatewayId: f.gatewayId,
                    methodId: f.customerMethodId,
                    confirm: {
                        previewId: review.previewId,
                        inputFingerprint: review.inputFingerprint,
                        operationKey: "gwcred-waiting-lock"
                    }
                },
                {transaction: false, timeout: 60}
            )
            before = h.lifecycle.detail(f, paymentId)
            h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
            h.call("update#" + METHOD, {paymentMethodId: f.customerMethodId, gatewayCimId: method.gatewayCimId})
            lookup = exactLookup(results[0].result.attemptId, "gwcred-waiting-no-effect")
        } finally {
            h.call("update#" + BANK, {paymentMethodId: f.customerMethodId, accountNumber: bank.accountNumber})
            h.call("update#" + METHOD, {paymentMethodId: f.customerMethodId, gatewayCimId: method.gatewayCimId})
            h.call("update#" + CONTROL, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
        }
        return {
            results,
            before,
            lookup,
            expectedVersion,
            effects: h.lib.rows("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
        }
    },
    then({results, before, lookup, expectedVersion, effects}) {
        results[1].holder.originalMethodVersion == expectedVersion
        Number(results[1].holder.heldMilliseconds) >= 250
        Number(results[1].holder.providerEffectsWhileLocked) == 0
        results[0].result.providerState == "uncertain"
        results[0].result.cashPaymentId == null
        toDecimal(before.gatewayInstruction.captureHeldAmount).eq(20)
        effects.length == 0
        lookup.providerState == "declined"
        lookup.reasonCode == "GATEWAY_NOT_EXECUTED"
    }
})
