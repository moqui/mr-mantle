// Deterministic legacy-interface provider; its independently committed effect is separate from local Payment/GL writes.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const PROBE = "mantle.account.payment.PaymentLegacyGatewayTestProbe"
const service = "mantle.account.PaymentLegacyGatewayTestServices."
function probe(paymentId) {
    return lib.find(PROBE, {paymentId}).useCache(false).one()
}
function waitFor(paymentId, field) {
    const until = Date.now() + 10000
    while (Date.now() < until) {
        if (probe(paymentId)?.[field] === "Y") return
    }
    throw new Error("LEGACY_TEST_TIMEOUT: " + paymentId + " waiting for " + field)
}
function storeProbe(p) {
    const row = lib.find(PROBE, {paymentId: p.paymentId}).forUpdate(true).one()
    if (!row) throw new Error("LEGACY_TEST_UNAVAILABLE: Missing test coordination")
    for (const [field, value] of Object.entries(p.values || {})) {
        if (!["providerEntered", "releaseProvider", "nativeReady", "legacyRequested", "legacyFinished"].includes(field))
            throw new Error("LEGACY_TEST_FIELD_INVALID")
        row.set(field, value)
    }
    if (p.incrementEffect) row.set("providerEffects", Number(row.providerEffects || 0) + 1)
    row.update()
    return {complete: true}
}
function store(paymentId, values, incrementEffect = false) {
    return lib.call(service + "store#Probe", {paymentId, values, incrementEffect})
}
function provider(p) {
    const config = lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: p.paymentGatewayConfigId}),
        state = probe(p.paymentId)
    if (!config?.reviewedMerchantNamespace?.startsWith("native-fixture/") || !state)
        throw new Error("LEGACY_TEST_UNAVAILABLE: This fixture requires its explicit test merchant and coordination")
    const fence = lib.find("mantle.account.payment.PaymentLegacyGatewayFence", {paymentId: p.paymentId}).useCache(false).one()
    if (fence?.everEnteredProvider !== "Y") throw new Error("LEGACY_TEST_ADMISSION_MISSING")
    store(p.paymentId, {providerEntered: "Y"})
    if (state.waitForAdoption === "Y") waitFor(p.paymentId, "releaseProvider")
    store(p.paymentId, {}, true)
    const payment = lib.one("mantle.account.payment.Payment", {paymentId: p.paymentId})
    return lib.call("create#mantle.account.method.PaymentGatewayResponse", {
        paymentId: p.paymentId,
        paymentGatewayConfigId: p.paymentGatewayConfigId,
        paymentOperationEnumId: "PgoAuthorize",
        amount: payment.amount,
        amountUomId: payment.amountUomId,
        referenceNum: "LEGACY-FIXTURE-" + ec.user.randomString(12),
        transactionDate: ec.user.nowTimestamp,
        resultSuccess: "Y"
    })
}
function rollbackProvider(p) {
    lib.find("mantle.account.payment.Payment", {paymentId: p.paymentId}).forUpdate(true).one()
    lib.call(service + "authorize#ManualPayment", p)
    throw new Error("LEGACY_TEST_OUTER_ROLLBACK")
}
function holdAdoption(p) {
    lib.call("mantle.account.PaymentServices.store#PaymentDraft", p.request)
    store(p.request.paymentId, {nativeReady: "Y"})
    waitFor(p.request.paymentId, "legacyRequested")
    const until = Date.now() + 250
    while (Date.now() < until) {}
    const current = probe(p.request.paymentId)
    return {blocked: !Number(current.providerEffects || 0) && current.legacyFinished !== "Y"}
}
;({provider, storeProbe, rollbackProvider, holdAdoption, waitFor, store, probe})
