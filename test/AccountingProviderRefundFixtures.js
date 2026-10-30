// Provider refund tests compose real stages and independent policy changes after a committed provider effect.
const gateway = ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const {lib, call, native, lifecycle} = gateway
function captured(f, direction = "incoming", amount = "20") {
    const parent = gateway.draft(f, {cashDirection: direction})
    gateway.execute(gateway.preview(f, parent))
    return {parent, ...gateway.execute(gateway.preview(f, parent, "capture", {amount}))}
}
function refresh(f, attemptId, key = "pr-ref-lookup-" + ec.user.randomString(20)) {
    const current = native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId})
    return native("refresh#PaymentGatewayAttempt", {
        organizationPartyId: f.org,
        attemptId,
        attemptVersion: current.attemptVersion,
        operationKey: key
    })
}
function acceptedUnposted(f, review, change) {
    const entity = "mantle.account.payment.PaymentGatewayTestControl",
        control = lib.one(entity, {paymentGatewayConfigId: f.gatewayId}),
        saved = lib.policy.pick(lib.map(control), [
            "holdAfterAccept",
            "releaseProvider",
            "barrierPaymentId",
            "barrierAction",
            "outcomesJson"
        ]),
        attemptId = lib.one("mantle.account.payment.PaymentGatewayPreview", {previewId: review.previewId}).attemptId,
        lockId = "PRV_REF_LOCK_" + ec.user.randomString(20),
        username = ec.user.username
    call("update#" + entity, {
        paymentGatewayConfigId: f.gatewayId,
        outcomesJson: JSON.stringify({refund: "accepted"}),
        holdAfterAccept: "Y",
        releaseProvider: "N",
        barrierPaymentId: review.paymentId,
        barrierAction: "refund"
    })
    let results
    try {
        results = parallel(
            2,
            (thread, args) => {
                login(args.username)
                ec.artifactExecution.disableAuthz()
                const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
                if (thread === 0)
                    return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
                const deadline = Date.now() + 15000,
                    accepted = () =>
                        lib
                            .find("mantle.account.payment.PaymentGatewayTestEffect", {
                                paymentId: args.paymentId,
                                action: "refund",
                                outcome: "accepted"
                            })
                            .useCache(false)
                            .count() > 0
                while (!accepted() && Date.now() < deadline) {}
                if (!accepted())
                    throw new Error("TEST_REFUND_ACCEPT_TIMEOUT: Refund did not reach an independent provider effect")
                if (args.change.kind === "mapping") call("update#mantle.ledger.config.PaymentTypeGlAccount", args.change.values)
                else
                    call("create#mantle.ledger.config.AccountingLock", {
                        accountingLockId: args.lockId,
                        organizationPartyId: args.org,
                        lockScope: "all",
                        lockThroughDate: args.day,
                        isHard: "Y",
                        changeReason: "Independent accepted refund completion refusal"
                    })
                try {
                    call("update#mantle.account.payment.PaymentGatewayTestControl", {
                        paymentGatewayConfigId: args.gatewayId,
                        releaseProvider: "Y"
                    })
                    const current = () =>
                            lib
                                .find("mantle.account.payment.PaymentGatewayAttempt", {attemptId: args.attemptId})
                                .useCache(false)
                                .one(),
                        end = Date.now() + 15000
                    while (current()?.reasonCode !== args.expectedReason && Date.now() < end) {}
                    if (current()?.financialState !== "accepted_unposted" || current()?.reasonCode !== args.expectedReason)
                        throw new Error(
                            "TEST_REFUND_REFUSAL_MISSING: Expected actual " + args.expectedReason + " after provider acceptance"
                        )
                    return {refusalVerified: true}
                } finally {
                    if (
                        args.change.kind !== "mapping" &&
                        lib.one("mantle.ledger.config.AccountingLock", {accountingLockId: args.lockId})
                    )
                        call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: args.lockId})
                }
            },
            {
                username,
                org: f.org,
                paymentId: review.paymentId,
                gatewayId: f.gatewayId,
                attemptId,
                lockId,
                day: review.effectiveDateText,
                change,
                expectedReason: change.kind === "mapping" ? "STALE_PREVIEW" : "HARD_LOCK",
                confirm: {
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: "pr-ref-failed-" + ec.user.randomString(20)
                }
            },
            {transaction: false, timeout: 45}
        )
    } finally {
        login(username)
        call("update#" + entity, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
    }
    if (!results[1].refusalVerified) throw new Error("TEST_REFUND_REFUSAL_MISSING: No independent financial refusal")
    return results[0].result
}
function recover(f, attemptId, key = "pr-ref-recover-" + ec.user.randomString(20)) {
    const current = native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId}),
        review = native("preview#PaymentGatewayRecovery", {
            organizationPartyId: f.org,
            attemptId,
            attemptVersion: current.attemptVersion,
            reason: "Complete accepted original-reference refund using reviewed current policy"
        }),
        result = native("complete#PaymentGatewayAttempt", {
            previewId: review.previewId,
            inputFingerprint: review.inputFingerprint,
            operationKey: key
        })
    return {review, result}
}
;({gateway, lib, call, native, lifecycle, captured, refresh, acceptedUnposted, recover})
