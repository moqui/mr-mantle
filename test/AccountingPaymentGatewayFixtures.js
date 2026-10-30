// Standalone reviewed-gateway fixtures use their own organization, merchant namespace and exact provider effects.
const lifecycle = ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const {lib, call, native} = lifecycle
function fixtures(prefix) {
    const f = lifecycle.fixtures(prefix)
    f.gatewayId = prefix + "_GATEWAY"
    f.merchantNamespace = "native-fixture/" + f.org
    call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, paymentGatewayWorkflowEnabled: "Y"})
    call("create#mantle.account.method.PaymentGatewayConfig", {
        paymentGatewayConfigId: f.gatewayId,
        description: "Reviewed fixture gateway",
        paymentGatewayTypeEnumId: "PgtTest",
        reviewedOperationServiceName: "mantle.account.PaymentGatewayTestServices.invoke#ReviewedOperation",
        reviewedLookupServiceName: "mantle.account.PaymentGatewayTestServices.lookup#ReviewedOperation",
        reviewedAdapterVersion: "fixture-v1",
        reviewedMerchantNamespace: f.merchantNamespace,
        reviewedGuaranteesJson: JSON.stringify({
            authorize: {enabled: true, idempotent: true, exactLookup: true, reviewedMethodSnapshot: true},
            capture: {enabled: true, idempotent: true, exactLookup: true, partialCapture: true, reviewedMethodSnapshot: true},
            release: {enabled: true, idempotent: true, exactLookup: true, releaseRemaining: true, reviewedMethodSnapshot: true}
        })
    })
    call("create#mantle.account.method.PaymentGatewayOrganization", {
        organizationPartyId: f.org,
        paymentGatewayConfigId: f.gatewayId,
        fromDate: 0,
        isEnabled: "Y"
    })
    call("create#mantle.account.payment.PaymentGatewayTestControl", {paymentGatewayConfigId: f.gatewayId, outcomesJson: "{}"})
    call("update#mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId, paymentGatewayConfigId: f.gatewayId})
    f.users.gatewayTreasuryNoLedger = lifecycle.settlement.user(f, "GW_TREASURY", ["PAYMENT_VIEW", "PAYMENT_EDIT"])
    f.users.gatewayAdmin = lifecycle.settlement.user(f, "GW_ADMIN", ["ACCOUNTING_ADMIN", "PAYMENT_VIEW", "PAYMENT_EDIT"])
    return f
}
function draft(f, extra = {}) {
    const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
        customerMethod = lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId})
    return lifecycle.draft(
        f,
        Object.assign(
            {
                paymentInstrumentEnumId: "PiAch",
                counterpartyPaymentMethodId: f.customerMethodId,
                counterpartyMethodVersion: workflow.methodVersion(customerMethod)
            },
            extra
        )
    )
}
function request(f, paymentId, action = "authorize", extra = {}) {
    return Object.assign(
        {
            organizationPartyId: f.org,
            paymentId,
            sourceVersion: lifecycle.detail(f, paymentId).sourceVersion,
            action,
            effectiveDate: f.timestamp,
            reason: "Reviewed deterministic gateway request",
            referenceNumber: "Fixture gateway"
        },
        extra
    )
}
function preview(f, paymentId, action = "authorize", extra = {}) {
    return native("preview#PaymentGatewayAction", request(f, paymentId, action, extra))
}
function execute(review, operationKey = "gateway-" + ec.user.randomString(24)) {
    return native("execute#PaymentGatewayAction", {
        previewId: review.previewId,
        inputFingerprint: review.inputFingerprint,
        operationKey
    })
}
function mode(f, action, outcome) {
    const control = lib.one("mantle.account.payment.PaymentGatewayTestControl", {paymentGatewayConfigId: f.gatewayId}),
        values = JSON.parse(control.outcomesJson || "{}")
    values[action] = outcome
    call("update#mantle.account.payment.PaymentGatewayTestControl", {
        paymentGatewayConfigId: f.gatewayId,
        outcomesJson: JSON.stringify(values)
    })
}
function acceptedUnposted(p) {
    const controlEntity = "mantle.account.payment.PaymentGatewayTestControl",
        callingUsername = ec.user.username,
        username = p.username || callingUsername,
        effectiveTime = Number(ec.user.nowTimestamp),
        existing = lib
            .find("mantle.account.payment.PaymentGatewayAttempt", {
                organizationPartyId: p.organizationPartyId,
                paymentId: p.paymentId,
                action: "capture",
                providerState: "accepted",
                financialState: "accepted_unposted"
            })
            .one()
    if (existing)
        return native("get#PaymentGatewayAttempt", {organizationPartyId: p.organizationPartyId, attemptId: existing.attemptId})
    let control = lib.one(controlEntity, {paymentGatewayConfigId: p.paymentGatewayConfigId})
    if (!control) {
        call("create#" + controlEntity, {paymentGatewayConfigId: p.paymentGatewayConfigId, outcomesJson: "{}"})
        control = lib.one(controlEntity, {paymentGatewayConfigId: p.paymentGatewayConfigId})
    }
    const saved = lib.policy.pick(lib.map(control), [
            "outcomesJson",
            "lookupOutcomesJson",
            "holdAfterAccept",
            "releaseProvider",
            "barrierPaymentId",
            "barrierAction"
        ]),
        outcomes = Object.assign({}, JSON.parse(control.outcomesJson || "{}"), {authorize: "accepted", capture: "accepted"}),
        scope = {org: p.organizationPartyId, timestamp: p.effectiveDate},
        lockId = "GTW_RECOVER_" + ec.user.randomString(24)
    let results
    call("update#" + controlEntity, {
        paymentGatewayConfigId: p.paymentGatewayConfigId,
        outcomesJson: JSON.stringify(outcomes),
        holdAfterAccept: "N",
        releaseProvider: "N"
    })
    try {
        login(username)
        ec.artifactExecution.disableAuthz()
        const detail = lifecycle.detail(scope, p.paymentId)
        if (detail.payment.statusId !== "PmntAuthorized") execute(preview(scope, p.paymentId, "authorize"))
        const review = preview(scope, p.paymentId, "capture", {amount: p.amount || "20"}),
            attemptId = lib.one("mantle.account.payment.PaymentGatewayPreview", {previewId: review.previewId}).attemptId
        call("update#" + controlEntity, {
            paymentGatewayConfigId: p.paymentGatewayConfigId,
            holdAfterAccept: "Y",
            releaseProvider: "N",
            barrierPaymentId: p.paymentId,
            barrierAction: "capture"
        })
        results = parallel(
            2,
            (thread, args) => {
                login(thread === 0 ? args.username : args.policyUsername)
                ec.user.setEffectiveTime(args.effectiveTime)
                ec.artifactExecution.disableAuthz()
                const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
                if (thread === 0)
                    return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
                const deadline = Date.now() + 15000
                const accepted = () =>
                    lib
                        .find("mantle.account.payment.PaymentGatewayTestEffect", {
                            paymentId: args.paymentId,
                            action: "capture",
                            outcome: "accepted"
                        })
                        .useCache(false)
                        .count() > 0
                while (!accepted() && Date.now() < deadline) {}
                if (!accepted()) throw new Error("Gateway recovery fixture did not reach its independently accepted effect")
                try {
                    call("create#mantle.ledger.config.AccountingLock", {
                        accountingLockId: args.lockId,
                        organizationPartyId: args.organizationPartyId,
                        lockScope: "all",
                        lockThroughDate: args.day,
                        isHard: "Y",
                        changeReason: "Independent provider-completion recovery fixture"
                    })
                    call("update#mantle.account.payment.PaymentGatewayTestControl", {
                        paymentGatewayConfigId: args.gatewayId,
                        releaseProvider: "Y"
                    })
                    const finished = () =>
                            lib
                                .find("mantle.account.payment.PaymentGatewayAttempt", {attemptId: args.attemptId})
                                .useCache(false)
                                .one(),
                        deadline = Date.now() + 15000
                    while (finished()?.financialState !== "accepted_unposted" && Date.now() < deadline) {}
                    const attempt = finished()
                    if (!attempt || attempt.financialState !== "accepted_unposted")
                        throw new Error("Gateway recovery fixture did not retain accepted-unposted outcome")
                    // Wait for the finalizer's real lock refusal, not merely the accepted receipt preceding its attempt.
                    while (finished()?.reasonCode !== "HARD_LOCK" && Date.now() < deadline) {}
                    if (finished()?.reasonCode !== "HARD_LOCK")
                        throw new Error("Gateway recovery fixture did not prove the actual typed-lock refusal")
                    return {realTypedLockRefusal: true}
                } finally {
                    if (lib.one("mantle.ledger.config.AccountingLock", {accountingLockId: args.lockId}))
                        call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: args.lockId})
                }
            },
            {
                username,
                policyUsername: p.policyUsername || "john.doe",
                effectiveTime,
                organizationPartyId: p.organizationPartyId,
                paymentId: p.paymentId,
                gatewayId: p.paymentGatewayConfigId,
                attemptId,
                lockId,
                day: review.effectiveDateText,
                confirm: {
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: p.operationKey || "gtw-recover-" + ec.user.randomString(24)
                }
            },
            {transaction: false, timeout: 45}
        )
    } finally {
        login(p.policyUsername || "john.doe")
        try {
            call("update#" + controlEntity, Object.assign({paymentGatewayConfigId: p.paymentGatewayConfigId}, saved))
            if (lib.one("mantle.ledger.config.AccountingLock", {accountingLockId: lockId}))
                call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: lockId})
        } finally {
            login(callingUsername)
        }
    }
    if (!results[1]?.realTypedLockRefusal)
        throw new Error("Gateway recovery fixture needs the separate actor's real typed-lock proof")
    return results[0].result
}
;({lifecycle, lib, call, native, fixtures, draft, request, preview, execute, mode, acceptedUnposted})
