// Reference-based provider refunds share the strict cash/application writer without exposing credential overrides.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const refunds = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefunds.js")
const gateway = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayWorkflow.js")
const legacy = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
const {lib, P} = workflow
const {find, one, map, call, hash, policy, denied} = lib
function capture(scope, lock = false) {
    const r = scope.record,
        row = r.gatewayAttemptId && find(gateway.ATTEMPT, {attemptId: r.gatewayAttemptId}).useCache(false).forUpdate(lock).one()
    if (
        !row ||
        r.gatewayRole !== "capture" ||
        row.action !== "capture" ||
        row.providerState !== "accepted" ||
        row.financialState !== "completed" ||
        row.cashPaymentId !== r.paymentId ||
        row.organizationPartyId !== scope.organizationPartyId ||
        row.currencyUomId !== r.amountUomId ||
        !toDecimal(row.amount).eq(r.amount) ||
        row.instructionId !== r.gatewayInstructionId ||
        !row.providerReference
    )
        denied("GATEWAY_REFUND_SOURCE_INVALID", "Use the exact completed capture cash payment")
    return row
}
function lockRows(scope, selectedDraftId = null) {
    lib.organization(scope.organizationPartyId, null, true)
    const children = Array.from(find(P, {refundForPaymentId: scope.record.paymentId}).useCache(false).limit(10001).list())
    if (children.length > 10000) denied("REFUND_HISTORY_LIMIT", "Refund history requires a bounded reconciliation review")
    for (const child of children)
        if (
            child.fromPartyId !== scope.record.toPartyId ||
            child.toPartyId !== scope.record.fromPartyId ||
            child.amountUomId !== scope.record.amountUomId
        )
            denied("REFUND_HISTORY_INCONSISTENT", "Prior refund party or currency identity is inconsistent")
    if (selectedDraftId) refunds.scopeFor({organizationPartyId: scope.organizationPartyId, paymentId: selectedDraftId}, true)
    const ids = [
        ...new Set([scope.record.paymentId, selectedDraftId, ...children.map(row => row.paymentId)].filter(Boolean))
    ].sort()
    Array.from(find(P).condition("paymentId", "in", ids).orderBy("paymentId").useCache(false).forUpdate(true).list())
    const fresh = Array.from(find(P, {refundForPaymentId: scope.record.paymentId}).useCache(false).forUpdate(true).list())
    if (fresh.some(row => !ids.includes(row.paymentId)))
        denied("REFUND_HISTORY_CHANGED", "Refund membership changed; review again")
}
function capacity(scope, originalCapture = null, lock = false) {
    const c = originalCapture || capture(scope, lock),
        attempts = Array.from(
            find(gateway.ATTEMPT, {paymentId: scope.record.paymentId, action: "refund"})
                .orderBy("attemptId")
                .useCache(false)
                .forUpdate(lock)
                .list()
        ),
        holds = Array.from(
            find(gateway.RESERVATION, {paymentId: scope.record.paymentId, holdKind: "refund", status: "held"})
                .orderBy("reservationId")
                .useCache(false)
                .forUpdate(lock)
                .list()
        )
    let completed = toDecimal(0),
        held = toDecimal(0),
        providerRefunded = toDecimal(0)
    for (const a of attempts) {
        if (
            a.parentAttemptId !== c.attemptId ||
            a.parentProviderReference !== c.providerReference ||
            a.merchantNamespace !== c.merchantNamespace ||
            a.currencyUomId !== c.currencyUomId ||
            a.organizationPartyId !== scope.organizationPartyId
        )
            denied("REFUND_HISTORY_INCONSISTENT", "Provider refund history has inconsistent original capture identity")
        if (a.providerState === "accepted") providerRefunded = providerRefunded.add(a.amount)
        if (a.financialState === "completed") completed = completed.add(a.amount)
    }
    for (const h of holds) {
        const a = attempts.find(row => row.attemptId === h.attemptId)
        if (
            !a ||
            a.financialState === "completed" ||
            a.providerState === "declined" ||
            h.sourceKind !== "capture" ||
            h.sourceId !== c.attemptId ||
            h.currencyUomId !== c.currencyUomId ||
            !toDecimal(h.amount).eq(a.amount)
        )
            denied("GATEWAY_HOLD_UNAVAILABLE", "Provider refund hold does not match its exact capture and attempt")
        held = held.add(h.amount)
    }
    const available = toDecimal(c.amount).subtract(completed).subtract(held)
    if (available.compare(0) < 0) denied("REFUND_CAPACITY_INCONSISTENT", "Provider refund capacity exceeds the original capture")
    return {
        capture: c,
        completed,
        held,
        providerRefunded,
        available,
        version: hash({
            capture: c.attemptId,
            attempts: attempts.map(a =>
                policy.pick(map(a), ["attemptId", "amount", "providerState", "financialState", "parentAttemptId", "receiptJson"])
            ),
            holds: holds.map(map)
        })
    }
}
function summary(scope, lock = false) {
    const f = refunds.funding(scope, lock),
        c = capacity(scope, null, lock),
        refundable = f.refundable.compare(c.available) < 0 ? f.refundable : c.available
    return {
        funding: f,
        capacity: c,
        summary: Object.assign({}, f.summary, {
            providerRefundedAmount: String(c.providerRefunded),
            providerRefundableAmount: String(c.available),
            heldRefundAmount: String(c.held),
            refundableAmount: String(refundable),
            version: hash({cash: f.version, provider: c.version})
        })
    }
}
function methods(scope, c, lock = false) {
    const preview = one(gateway.PREVIEW, {previewId: c.previewId}),
        request = preview && gateway.json(preview.requestJson),
        original = request?._methods
    if (!original?.organizationPaymentMethodId || !original.organizationMethodVersion)
        denied("GATEWAY_EVIDENCE_UNAVAILABLE", "Original capture method provenance is unavailable")
    const selected = {}
    for (const id of [
        ...new Set([original.organizationPaymentMethodId, original.counterpartyPaymentMethodId].filter(Boolean))
    ].sort())
        selected[id] = find("mantle.account.method.PaymentMethod", {paymentMethodId: id}).useCache(false).forUpdate(lock).one()
    const org = selected[original.organizationPaymentMethodId],
        other = original.counterpartyPaymentMethodId ? selected[original.counterpartyPaymentMethodId] : null
    // Reference refunds never consume current charging credentials, expiry, token, or routing details. Current
    // basic method ownership/currency and its posting account still constrain local financial completion.
    if (
        !org ||
        org.ownerPartyId !== scope.organizationPartyId ||
        org.currencyUomId !== scope.record.amountUomId ||
        (original.counterpartyPaymentMethodId &&
            (!other || other.ownerPartyId !== scope.partyId || other.currencyUomId !== scope.record.amountUomId))
    )
        denied("PAYMENT_METHOD_UNAVAILABLE", "Original refund method ownership or posting currency is unavailable")
    return {
        organizationMethod: org,
        counterpartyMethod: other,
        request: original,
        versions: policy.pick(original, ["organizationMethodVersion", "counterpartyMethodVersion"]),
        maskedLabel: gateway.json(preview.payloadJson).paymentSummary?.maskedMethodLabel
    }
}
function binding(scope, c, m, date, lock = false) {
    const b = gateway.bindingEvidence(scope, c.paymentGatewayConfigId, m, date, lock)
    if (b.config.reviewedMerchantNamespace !== c.merchantNamespace)
        denied("GATEWAY_BINDING_CHANGED", "Refunds must use the original capture merchant")
    gateway.assertAction(b, "refund", true)
    return b
}
function normalized(p, lock = false, accepted = null, evidence = null) {
    const scope = gateway.scopeFor(p, true, false, true)
    if (lock) lockRows(scope, p.refundPaymentId || accepted?.refundDraftPaymentId)
    const actual = lock ? gateway.scopeFor(p, true, true, true) : scope,
        c = capture(actual, lock),
        m = methods(actual, c, lock)
    if (p.parentAttemptId || p.paymentGatewayConfigId || p.gatewayBindingVersion)
        denied("GATEWAY_REFUND_OVERRIDE_REFUSED", "Refund capture, merchant and method identities are derived from original cash")
    const input = Object.assign({}, p, m.request, {paymentInstrumentEnumId: actual.record.paymentInstrumentEnumId})
    let linked = null
    if (accepted) {
        input.sourceVersion = workflow.paymentVersion(actual.record)
        input.refundPaymentId = accepted.refundDraftPaymentId || null
        input.refundSourceVersion = accepted.refundDraftVersion || null
        if (input.refundPaymentId) linked = refunds.draft(actual, input, lock, accepted.attemptId)
    }
    const options = {methods: m, reserved: Boolean(accepted)}
    if (accepted) options.linked = linked
    if (evidence !== null) options.evidence = evidence
    const n = refunds.normalized(input, lock, options),
        b = binding(actual, c, m, n.date.timestamp, lock),
        cap = capacity(actual, c, lock),
        s = Object.assign({}, n.funding.summary, {
            providerRefundedAmount: String(cap.providerRefunded),
            providerRefundableAmount: String(cap.available),
            heldRefundAmount: String(cap.held)
        })
    const refundable = n.funding.refundable.compare(cap.available) < 0 ? n.funding.refundable : cap.available
    s.refundableAmount = String(refundable)
    if (!accepted && n.amount.compare(refundable) > 0)
        denied("REFUND_FUNDS_UNAVAILABLE", "The refund exceeds currently available capture and cash capacity")
    n.request = Object.assign({}, n.request, {
        action: "refund",
        _methods: m.request,
        _financialSourceHash: gateway.financialSource(actual.record),
        _capture: {
            attemptId: c.attemptId,
            paymentId: actual.record.paymentId,
            providerOperationId: c.providerOperationId,
            providerReference: c.providerReference,
            merchantNamespace: c.merchantNamespace
        },
        _plans: n.plans,
        _policyEvidence: n.policyEvidence
    })
    // Public input cannot supply these derived fields. They are retained privately for exact reserve/recovery.
    n.binding = b
    n.instruction = gateway.instructionFor(actual.record, lock)
    n.capture = c
    n.methods = m
    const after = Object.assign({}, s, {
        completedRefundAmount: String(toDecimal(s.completedRefundAmount).add(n.amount)),
        providerRefundedAmount: String(cap.providerRefunded.add(accepted ? 0 : n.amount)),
        heldRefundAmount: String(cap.held.subtract(accepted ? n.amount : 0)),
        reservedAmount: String(n.funding.holds.heldAmount.subtract(accepted ? n.amount : 0)),
        unappliedTotal: String(n.funding.totals.unappliedTotal.subtract(n.amount)),
        availableAmount: String(toDecimal(s.availableAmount).subtract(accepted ? 0 : n.amount)),
        providerRefundableAmount: String(cap.available.subtract(accepted ? 0 : n.amount)),
        refundableAmount: String(refundable.subtract(accepted ? 0 : n.amount))
    })
    n.payload = Object.assign({}, n.dto, {
        previewKind: "gatewayAction",
        action: "refund",
        financialOnly: false,
        refundSummary: s,
        before: s,
        after,
        gatewaySummary: {
            action: "refund",
            paymentGatewayConfigId: c.paymentGatewayConfigId,
            description: b.config.description,
            amount: String(n.amount),
            currencyUomId: c.currencyUomId,
            accountingDateText: n.date.day,
            originalCapture: {
                paymentId: actual.record.paymentId,
                attemptId: c.attemptId,
                providerOperationId: c.providerOperationId,
                providerReference: c.providerReference
            }
        },
        reservationEffects: ["refund", "cash"].map(holdKind => ({
            holdKind,
            paymentId: actual.record.paymentId,
            amount: String(n.amount),
            currencyUomId: c.currencyUomId,
            status: "held"
        })),
        draftClaim: n.request.refundPaymentId
            ? {refundPaymentId: n.request.refundPaymentId, status: "held", effect: "reserve"}
            : null
    })
    delete n.payload.refundDefaults
    delete n.payload.reviewedMethods
    n.payload.paymentSummary.maskedMethodLabel = m.maskedLabel || null
    n.fingerprint = hash({
        request: n.request,
        funding: n.funding.version,
        provider: cap.version,
        draft: n.linked && workflow.paymentVersion(n.linked.record),
        binding: b.version,
        policy: n.policyEvidence,
        plans: n.plans,
        evidence: n.payload.evidenceRows
    })
    return n
}
function held(attempt, lock = false) {
    const rows = Array.from(
        find(gateway.RESERVATION, {attemptId: attempt.attemptId, status: "held"})
            .orderBy("reservationId")
            .useCache(false)
            .forUpdate(lock)
            .list()
    )
    if (
        rows.length !== 2 ||
        new Set(rows.map(row => row.holdKind)).size !== 2 ||
        !rows.some(row => row.holdKind === "cash") ||
        !rows.some(row => row.holdKind === "refund") ||
        rows.some(
            row =>
                row.paymentId !== attempt.paymentId ||
                row.organizationPartyId !== attempt.organizationPartyId ||
                row.currencyUomId !== attempt.currencyUomId ||
                !toDecimal(row.amount).eq(attempt.amount)
        )
    )
        denied("GATEWAY_HOLD_UNAVAILABLE", "The refund requires exact original-cash and provider-capacity holds")
    if (attempt.refundDraftPaymentId) {
        const claim = refunds.heldDraftClaim({
            paymentId: attempt.refundDraftPaymentId,
            organizationPartyId: attempt.organizationPartyId,
            lock
        })
        if (!claim || claim.attemptId !== attempt.attemptId || claim.originalPaymentId !== attempt.paymentId)
            denied("REFUND_DRAFT_CLAIMED", "The refund draft is not held by this exact attempt")
    }
    return rows
}
function claim(attempt, n) {
    if (!attempt.refundDraftPaymentId) return
    const draft = n.linked.record
    legacy.assertAdoptable(draft, true)
    if (draft.lifecycleManaged !== "Y") {
        draft.set("lifecycleManaged", "Y")
        draft.set("financeOrganizationPartyId", n.scope.organizationPartyId)
        draft.set("financeDirection", n.scope.financeDirection)
        draft.update()
    }
    const old = find(refunds.CLAIM, {refundPaymentId: draft.paymentId}).useCache(false).forUpdate(true).one()
    const values = {
        refundPaymentId: draft.paymentId,
        originalPaymentId: attempt.paymentId,
        organizationPartyId: attempt.organizationPartyId,
        attemptId: attempt.attemptId,
        status: "held",
        createdDate: ec.user.nowTimestamp,
        releasedDate: null,
        consumedDate: null
    }
    if (old) {
        for (const [key, value] of Object.entries(values)) old.set(key, value)
        old.update()
    } else call("create#" + refunds.CLAIM, values)
    return workflow.paymentVersion(find(P, {paymentId: draft.paymentId}).useCache(false).forUpdate(true).one())
}
function releaseClaim(attempt, status) {
    if (!attempt.refundDraftPaymentId) return
    const row = find(refunds.CLAIM, {refundPaymentId: attempt.refundDraftPaymentId}).useCache(false).forUpdate(true).one()
    if (!row || row.attemptId !== attempt.attemptId || row.status !== "held")
        denied("REFUND_DRAFT_CLAIMED", "The draft claim does not belong to this exact attempt")
    row.set("status", status)
    row.set(status === "released" ? "releasedDate" : "consumedDate", ec.user.nowTimestamp)
    row.update()
}
function claimStatus(attempt) {
    if (!attempt.refundDraftPaymentId) return null
    const row = find(refunds.CLAIM, {refundPaymentId: attempt.refundDraftPaymentId}).useCache(false).one()
    if (
        row?.attemptId === attempt.attemptId &&
        row.originalPaymentId === attempt.paymentId &&
        row.organizationPartyId === attempt.organizationPartyId
    )
        return {refundPaymentId: attempt.refundDraftPaymentId, status: row.status}
    // A released claim may be reused by a later review. Reopening the declined attempt must show its own
    // definitive release, never the new attempt's held/consumed claim.
    if (attempt.providerState === "declined" && attempt.financialState === "none")
        return {refundPaymentId: attempt.refundDraftPaymentId, status: "released"}
    denied("REFUND_CLAIM_INVALID", "The provider attempt's exact draft claim is unavailable")
}
function capabilities(scope) {
    try {
        const c = capture(scope),
            m = methods(scope, c),
            b = binding(scope, c, m, ec.user.nowTimestamp),
            s = summary(scope)
        return {
            canGatewayRefund:
                scope.record.amountUomId === policy.preference(scope.organizationPartyId).baseCurrencyUomId &&
                scope.guardEnabled &&
                policy.preference(scope.organizationPartyId).paymentGatewayWorkflowEnabled === "Y" &&
                lib.has("PAYMENT_EDIT") &&
                toDecimal(s.summary.refundableAmount).compare(0) > 0,
            gatewayReasons: [],
            refundSummary: s.summary
        }
    } catch (error) {
        ec.logger.error("Provider refund capability payment " + scope.record.paymentId + ": " + error.message)
        return {canGatewayRefund: false, gatewayReasons: ["GATEWAY_REFUND_UNAVAILABLE"]}
    }
}
;({capture, lockRows, capacity, summary, methods, normalized, held, claim, releaseClaim, claimStatus, capabilities})
