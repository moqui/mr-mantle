// Real legacy-provider/adoption races, including an outer transaction that already owns its Payment row.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const fixture = () => ec.resource.script("component://mr-mantle/test/AccountingLegacyGatewayFixture.js")
const FENCE = "mantle.account.payment.PaymentLegacyGatewayFence"
const P = "mantle.account.payment.Payment"
const service = "mantle.account.PaymentLegacyGatewayTestServices."
let f
function source(waitForAdoption = false) {
    const h = helper(),
        paymentId = h.call("create#" + P, {
            fromPartyId: f.customer,
            toPartyId: f.org,
            paymentTypeEnumId: "PtInvoicePayment",
            paymentInstrumentEnumId: "PiCash",
            amount: "60",
            amountUomId: "USD",
            statusId: "PmntProposed",
            effectiveDate: f.timestamp,
            accountingDate: f.day,
            toPaymentMethodId: f.methodId
        }).paymentId
    h.call("create#mantle.account.payment.PaymentLegacyGatewayTestProbe", {
        paymentId,
        waitForAdoption: waitForAdoption ? "Y" : "N",
        providerEffects: 0
    })
    return paymentId
}
function adoption(paymentId) {
    const h = helper()
    return h.lifecycle.request(f, {
        paymentId,
        sourceVersion: h.lifecycle.detail(f, paymentId).sourceVersion,
        operationKey: "legacy-adopt-" + ec.user.randomString(20)
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_FENCE")
        helper().call("update#mantle.account.method.PaymentGatewayConfig", {
            paymentGatewayConfigId: f.gatewayId,
            authorizeServiceName: service + "authorize#ManualPayment"
        })
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

feature("direct legacy manual provider admission commits before I/O and defeats concurrent native adoption", {
    when() {
        const h = helper(),
            paymentId = source(true),
            request = adoption(paymentId),
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    const coordination = ec.resource.script("component://mr-mantle/test/AccountingLegacyGatewayFixture.js")
                    if (thread === 0)
                        return {
                            provider: call("mantle.account.PaymentLegacyGatewayTestServices.authorize#ManualPayment", {
                                paymentId: args.paymentId,
                                paymentGatewayConfigId: args.gatewayId
                            })
                        }
                    coordination.waitFor(args.paymentId, "providerEntered")
                    let refusal
                    try {
                        refusal = ec.resource
                            .script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
                            .probe("mantle.account.PaymentServices.store#PaymentDraft", args.request)
                        return {unexpected: refusal}
                    } catch (error) {
                        return {refusal: error.message}
                    } finally {
                        coordination.store(args.paymentId, {releaseProvider: "Y"})
                    }
                },
                {paymentId, gatewayId: f.gatewayId, request},
                {transaction: false, timeout: 30}
            )
        return {
            results,
            state: fixture().probe(paymentId),
            fence: h.lib.one(FENCE, {paymentId}),
            payment: h.lib.one(P, {paymentId})
        }
    },
    then({results, state, fence, payment}) {
        results.some(result => result.provider?.paymentGatewayResponseId != null)
        results.some(result => result.refusal?.includes("LEGACY_GATEWAY_ADOPTION_REFUSED"))
        state.providerEffects == 1
        fence.everEnteredProvider == "Y"
        payment.lifecycleManaged != "Y"
        payment.paymentGatewayConfigId == null
        payment.paymentInstrumentEnumId == "PiCash"
    }
})

feature("native adoption retains its real fence until commit and a waiting legacy leaf refuses before provider effects", {
    when() {
        const h = helper(),
            paymentId = source(),
            request = adoption(paymentId),
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    const coordination = ec.resource.script("component://mr-mantle/test/AccountingLegacyGatewayFixture.js")
                    if (thread === 0)
                        return call("mantle.account.PaymentLegacyGatewayTestServices.hold#NativeAdoption", {
                            request: args.request
                        })
                    coordination.waitFor(args.paymentId, "nativeReady")
                    coordination.store(args.paymentId, {legacyRequested: "Y"})
                    const started = Date.now()
                    try {
                        call("mantle.account.PaymentLegacyGatewayTestServices.authorize#ManualPayment", {
                            paymentId: args.paymentId,
                            paymentGatewayConfigId: args.gatewayId
                        })
                        return {unexpected: true}
                    } catch (error) {
                        ec.message.clearErrors()
                        return {refusal: error.message, waitedMs: Date.now() - started}
                    } finally {
                        coordination.store(args.paymentId, {legacyFinished: "Y"})
                    }
                },
                {paymentId, gatewayId: f.gatewayId, request},
                {transaction: false, timeout: 30}
            )
        return {
            results,
            state: fixture().probe(paymentId),
            payment: h.lib.one(P, {paymentId}),
            fence: h.lib.one(FENCE, {paymentId})
        }
    },
    then({results, state, payment, fence}) {
        results.some(result => result.blocked == true)
        results.some(result => result.refusal?.includes("GATEWAY_REVIEW_REQUIRED") && result.waitedMs >= 200)
        state.providerEffects == 0
        payment.lifecycleManaged == "Y"
        fence.everEnteredProvider != "Y"
    }
})

feature("a legacy caller holding Payment can publish admission independently and its marker survives caller rollback", {
    when() {
        const h = helper(),
            paymentId = source(),
            request = adoption(paymentId),
            outer = h.lifecycle.rejected(service + "rollback#ProviderCall", {paymentId, paymentGatewayConfigId: f.gatewayId}),
            refused = h.lifecycle.rejected("store#PaymentDraft", request),
            original = h.lib.map(h.lib.one(FENCE, {paymentId})),
            mutations = [
                h.lifecycle.rejected("delete#" + FENCE, {paymentId}),
                h.lifecycle.rejected("update#" + FENCE, {paymentId, everEnteredProvider: "N"}),
                h.lifecycle.rejected("update#" + FENCE, {paymentId, firstServiceName: "forged"})
            ]
        return {
            outer,
            refused,
            original,
            mutations,
            current: h.lib.map(h.lib.one(FENCE, {paymentId})),
            state: fixture().probe(paymentId),
            responseCount: h.lifecycle.count("mantle.account.method.PaymentGatewayResponse", {paymentId})
        }
    },
    then({outer, refused, original, mutations, current, state, responseCount}) {
        outer.includes("LEGACY_TEST_OUTER_ROLLBACK")
        refused.includes("LEGACY_GATEWAY_ADOPTION_REFUSED")
        original.everEnteredProvider == "Y"
        JSON.stringify(original) == JSON.stringify(current)
        mutations.every(message => message.includes("LEGACY_GATEWAY_FENCE_IMMUTABLE"))
        state.providerEffects == 1
        responseCount == 0
    }
})

feature("concurrent first legacy admission creates one permanent fence and preserves independent legacy calls", {
    when() {
        const h = helper(),
            paymentId = source(),
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    return call("mantle.account.PaymentLegacyGatewayTestServices.authorize#ManualPayment", args)
                },
                {paymentId, paymentGatewayConfigId: f.gatewayId},
                {transaction: false, timeout: 30}
            )
        return {results, fenceCount: h.lifecycle.count(FENCE, {paymentId}), state: fixture().probe(paymentId)}
    },
    then({results, fenceCount, state}) {
        results.length == 2
        results.every(result => result.paymentGatewayResponseId != null)
        fenceCount == 1
        state.providerEffects == 2
    }
})
