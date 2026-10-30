// Explicit reviewed-provider test double. Its effect transaction survives a caller rollback or timeout.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const CONTROL = "mantle.account.payment.PaymentGatewayTestControl",
    EFFECT = "mantle.account.payment.PaymentGatewayTestEffect"
function request(p) {
    const config = lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: p.paymentGatewayConfigId})
    if (
        !config ||
        !String(p.merchantNamespace || "").startsWith("native-fixture/") ||
        p.merchantNamespace !== config.reviewedMerchantNamespace ||
        p.adapterVersion !== config.reviewedAdapterVersion ||
        !p.providerOperationId ||
        !["authorize", "capture", "release"].includes(p.action)
    )
        throw new Error("TEST_PROVIDER_IDENTITY_INVALID: The deterministic provider requires its provisioned namespace")
    return {
        providerOperationId: p.providerOperationId,
        merchantNamespace: p.merchantNamespace,
        adapterVersion: p.adapterVersion,
        paymentGatewayConfigId: p.paymentGatewayConfigId,
        paymentId: p.paymentId,
        action: p.action,
        parentProviderReference: p.parentProviderReference || null,
        sourcePaymentMethodId: p.sourcePaymentMethodId || null,
        destinationPaymentMethodId: p.destinationPaymentMethodId || null,
        sourceMethodVersion: p.sourceMethodVersion || null,
        destinationMethodVersion: p.destinationMethodVersion || null,
        amount: String(ec.l10n.roundCurrency(toDecimal(p.amount), p.currencyUomId)),
        currencyUomId: p.currencyUomId
    }
}
function projection(row) {
    return {
        providerOperationId: row.providerOperationId,
        merchantNamespace: row.merchantNamespace,
        adapterVersion: row.adapterVersion,
        action: row.action,
        outcome: row.outcome,
        amount: row.amount,
        currencyUomId: row.currencyUomId,
        providerReference: row.providerReference,
        providerDate: row.providerDate,
        responseCode: row.outcome === "accepted" ? "APPROVED" : row.outcome === "declined" ? "DECLINED" : "WAITING",
        reasonCode: "TEST_PROVIDER_" + String(row.outcome).toUpperCase(),
        message: "Deterministic reviewed provider outcome"
    }
}
function record(p) {
    const r = request(p),
        fingerprint = lib.hash(r),
        control = lib.find(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId}).forUpdate(true).one()
    if (!control) throw new Error("TEST_PROVIDER_NOT_CONFIGURED: Missing deterministic provider control")
    const old = lib
        .find(EFFECT, {providerOperationId: r.providerOperationId, merchantNamespace: r.merchantNamespace})
        .forUpdate(true)
        .one()
    if (old) {
        if (old.requestHash !== fingerprint)
            throw new Error("TEST_PROVIDER_KEY_CONFLICT: Provider identity was reused for another request")
        old.set("invocationCount", Number(old.invocationCount || 0) + 1)
        old.update()
        return Object.assign(projection(old), {replayed: true})
    }
    const made = lib.call("create#" + EFFECT, {
        providerOperationId: r.providerOperationId,
        merchantNamespace: r.merchantNamespace,
        paymentGatewayConfigId: r.paymentGatewayConfigId,
        adapterVersion: r.adapterVersion,
        paymentId: r.paymentId,
        action: r.action,
        amount: r.amount,
        currencyUomId: r.currencyUomId,
        requestHash: fingerprint,
        outcome: p.fixtureOutcome,
        providerReference: "FIXTURE-" + r.providerOperationId,
        providerDate: ec.user.nowTimestamp,
        invocationCount: 1,
        lookupCount: 0,
        sourceMethodVersion: r.sourceMethodVersion,
        destinationMethodVersion: r.destinationMethodVersion,
        sourceCredentialHash: credentialHash(p.credentialSnapshot?.source),
        destinationCredentialHash: credentialHash(p.credentialSnapshot?.destination)
    })
    return Object.assign(
        projection(lib.one(EFFECT, {providerOperationId: r.providerOperationId, merchantNamespace: r.merchantNamespace})),
        {replayed: false}
    )
}
function invoke(p) {
    request(p)
    for (const [side, id, version] of [
        ["source", p.sourcePaymentMethodId, p.sourceMethodVersion],
        ["destination", p.destinationPaymentMethodId, p.destinationMethodVersion]
    ]) {
        const snapshot = p.credentialSnapshot?.[side]
        if ((id && (!version || !snapshot || snapshot.method?.paymentMethodId !== id)) || (!id && snapshot))
            throw new Error("TEST_PROVIDER_SNAPSHOT_REQUIRED: Invocation requires native reviewed method snapshots")
    }
    const control = lib.one(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId}),
        configured = JSON.parse(control?.outcomesJson || "{}"),
        mode = configured[p.action] || "accepted",
        outcome = mode === "accepted-timeout" ? "accepted" : mode
    if (!["accepted", "declined", "pending", "uncertain"].includes(outcome))
        throw new Error("TEST_PROVIDER_MODE_INVALID: Unknown provider mode")
    if (
        control.holdBeforeEffect === "Y" &&
        (!control.barrierPaymentId || control.barrierPaymentId === p.paymentId) &&
        (!control.barrierAction || control.barrierAction === p.action)
    ) {
        ec.service
            .sync()
            .name("update#" + CONTROL)
            .parameters({paymentGatewayConfigId: p.paymentGatewayConfigId, enteredEffect: "Y"})
            .disableAuthz()
            .requireNewTransaction(true)
            .throwOnError(true)
            .call()
        const deadline = Date.now() + 20000,
            released = () =>
                lib.find(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId}).useCache(false).one()?.releaseEffect === "Y"
        while (!released() && Date.now() < deadline) {}
        if (!released())
            throw new Error("TEST_PROVIDER_EFFECT_TIMEOUT: Reviewed credential snapshot reached the adapter but was not released")
    }
    const result = ec.service
        .sync()
        .name("mantle.account.PaymentGatewayTestServices.record#ReviewedEffect")
        .parameters(Object.assign({}, p, {fixtureOutcome: outcome}))
        .disableAuthz()
        .requireNewTransaction(true)
        .throwOnError(true)
        .call()
    if (
        outcome === "accepted" &&
        control.holdAfterAccept === "Y" &&
        (!control.barrierPaymentId || control.barrierPaymentId === p.paymentId) &&
        (!control.barrierAction || control.barrierAction === p.action)
    ) {
        const deadline = Date.now() + 20000
        const released = () =>
            lib.find(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId}).useCache(false).one()?.releaseProvider === "Y"
        while (!released() && Date.now() < deadline) {}
        if (!released()) throw new Error("TEST_PROVIDER_BARRIER_TIMEOUT: Accepted effect is durable but release was not signaled")
    }
    if (mode === "accepted-timeout") throw new Error("TEST_PROVIDER_TIMEOUT: Provider accepted before the connection was lost")
    if (control.replyAmount != null) result.amount = control.replyAmount
    if (control.replyCurrencyUomId) result.currencyUomId = control.replyCurrencyUomId
    if (control.replyOperationId) result.providerOperationId = control.replyOperationId
    return result
}
function lookup(p) {
    const result = ec.service
        .sync()
        .name("mantle.account.PaymentGatewayTestServices.observe#ReviewedEffect")
        .parameters(p)
        .disableAuthz()
        .requireNewTransaction(true)
        .throwOnError(true)
        .call()
    const control = lib.one(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId})
    if (
        control?.holdLookup === "Y" &&
        (!control.barrierPaymentId || control.barrierPaymentId === p.paymentId) &&
        (!control.barrierAction || control.barrierAction === p.action)
    ) {
        const deadline = Date.now() + 20000,
            released = () =>
                lib.find(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId}).useCache(false).one()?.releaseLookup === "Y"
        while (!released() && Date.now() < deadline) {}
        if (!released()) throw new Error("TEST_PROVIDER_LOOKUP_TIMEOUT: Exact lookup was observed but not released")
    }
    return result
}
function observe(p) {
    const r = request(p),
        row = lib
            .find(EFFECT, {providerOperationId: r.providerOperationId, merchantNamespace: r.merchantNamespace})
            .forUpdate(true)
            .one(),
        control = lib.one(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId})
    if (row && row.requestHash !== lib.hash(r))
        throw new Error("TEST_PROVIDER_KEY_CONFLICT: Lookup money differs from its original provider request")
    if (row) {
        const selected = JSON.parse(control?.lookupOutcomesJson || "{}")[row.action]
        if (
            ["pending", "uncertain"].includes(row.outcome) &&
            ["accepted", "declined", "pending", "uncertain"].includes(selected)
        ) {
            row.set("outcome", selected)
            if (selected === "accepted") row.set("providerDate", ec.user.nowTimestamp)
        }
        row.set("lookupCount", Number(row.lookupCount || 0) + 1)
        row.update()
        return projection(row)
    }
    return Object.assign({}, r, {
        outcome: "not_found",
        definitiveNonexecution: control?.lookupNoExecution === "Y",
        message: "No exact provider operation found"
    })
}
function callerRollback(p) {
    const cached = ec.transaction.isTransactionCacheActive(),
        inTransaction = ec.transaction.isTransactionInPlace(),
        workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
        before = workflow.paymentDetail({organizationPartyId: p.organizationPartyId, paymentId: p.paymentId})
    // Prime caller-local list and base-row caches before independent stages create their attempt and cash child.
    workflow.payments({organizationPartyId: p.organizationPartyId, pageSize: 100})
    lib.find("mantle.account.payment.PaymentGatewayAttempt", {paymentId: p.paymentId}).list()
    lib.find("mantle.account.payment.Payment", {paymentId: p.paymentId}).one()
    const marker = ec.entity.makeValue("mantle.account.payment.PaymentGatewayTestObservation")
    marker.set("observationId", p.markerId)
    marker.set("resultJson", "caller-owned")
    marker.create()
    let result = null,
        failure = null
    try {
        result = ec.service
            .sync()
            .name("mantle.account.PaymentServices.execute#PaymentGatewayAction")
            .parameters({previewId: p.previewId, inputFingerprint: p.inputFingerprint, operationKey: p.operationKey})
            .disableAuthz()
            .throwOnError(true)
            .call()
    } catch (error) {
        failure = error.message
        ec.message.clearErrors()
    }
    ec.service
        .sync()
        .name("update#mantle.account.payment.PaymentGatewayTestObservation")
        .parameters({
            observationId: p.observationId,
            resultJson: JSON.stringify({cached, inTransaction, beforeStatusId: before.payment.statusId, result, failure})
        })
        .disableAuthz()
        .requireNewTransaction(true)
        .throwOnError(true)
        .call()
    throw new Error("TEST_CALLER_ROLLBACK: Deliberately discard the caller transaction after observing committed gateway stages")
}
function credentialHash(snapshot) {
    if (!snapshot) return null
    return lib.hash({
        gatewayCimId: snapshot.method?.gatewayCimId || null,
        bank: snapshot.bank ? lib.policy.pick(snapshot.bank, ["routingNumber", "accountNumber", "typeEnumId"]) : null,
        card: snapshot.card
            ? lib.policy.pick(snapshot.card, ["cardNumber", "creditCardTypeEnumId", "validFromDate", "expireDate", "issueNumber"])
            : null
    })
}
function beforeDispatch(p) {
    const attempt = lib.one("mantle.account.payment.PaymentGatewayAttempt", {attemptId: p.attemptId}),
        config =
            attempt &&
            lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: attempt.paymentGatewayConfigId}),
        control = attempt && lib.one(CONTROL, {paymentGatewayConfigId: attempt.paymentGatewayConfigId})
    if (
        !attempt ||
        !String(config?.reviewedMerchantNamespace || "").startsWith("native-fixture/") ||
        control?.holdBeforePrepare !== "Y" ||
        control.barrierPaymentId !== attempt.paymentId ||
        control.barrierAction !== attempt.action
    )
        return
    ec.service
        .sync()
        .name("update#" + CONTROL)
        .parameters({paymentGatewayConfigId: attempt.paymentGatewayConfigId, enteredPrepare: "Y"})
        .disableAuthz()
        .requireNewTransaction(true)
        .throwOnError(true)
        .call()
    const deadline = Date.now() + 20000,
        released = () =>
            lib.find(CONTROL, {paymentGatewayConfigId: attempt.paymentGatewayConfigId}).useCache(false).one()?.releasePrepare ===
            "Y"
    while (!released() && Date.now() < deadline) {}
    if (!released()) throw new Error("TEST_PROVIDER_PREPARE_TIMEOUT: Committed reservation did not receive its fixture release")
}
function holdCredentialChange(p) {
    const config = lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: p.paymentGatewayConfigId}),
        control = lib.one(CONTROL, {paymentGatewayConfigId: p.paymentGatewayConfigId})
    if (
        !String(config?.reviewedMerchantNamespace || "").startsWith("native-fixture/") ||
        control?.holdBeforePrepare !== "Y" ||
        control.barrierPaymentId !== p.paymentId ||
        control.barrierAction !== "capture"
    )
        throw new Error("TEST_PROVIDER_IDENTITY_INVALID: Lock-race fixture requires its targeted native control")
    const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
        method = lib
            .find("mantle.account.method.PaymentMethod", {paymentMethodId: p.paymentMethodId})
            .useCache(false)
            .forUpdate(true)
            .one(),
        identities = workflow.methodIdentities(method, true),
        originalMethodVersion = workflow.methodVersion(method, identities)
    if (!identities.bank) throw new Error("TEST_PROVIDER_BANK_REQUIRED: Lock-race fixture requires its actual bank subtype")
    method.set("gatewayCimId", "UNCOMMITTED_TOKEN_ROTATION")
    method.update()
    identities.bank.set("accountNumber", "765432109")
    identities.bank.update()
    ec.service
        .sync()
        .name("update#" + CONTROL)
        .parameters({paymentGatewayConfigId: p.paymentGatewayConfigId, releasePrepare: "Y"})
        .disableAuthz()
        .requireNewTransaction(true)
        .throwOnError(true)
        .call()
    const started = Date.now()
    while (Date.now() - started < 350) {}
    const providerEffectsWhileLocked = Number(
        lib.find(EFFECT, {paymentId: p.paymentId, action: "capture"}).useCache(false).count()
    )
    return {originalMethodVersion, heldMilliseconds: Date.now() - started, providerEffectsWhileLocked}
}
;({invoke, lookup, observe, record, callerRollback, credentialHash, beforeDispatch, holdCredentialChange})
