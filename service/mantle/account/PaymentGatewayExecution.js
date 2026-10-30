// Provider requests, durable outcomes and reviewed local money are separate transaction stages.
const gateway = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayWorkflow.js")
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const lifecycle = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentLifecycle.js")
const settlement = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentSettlement.js")
const isolation = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js")
const {lib, P} = workflow
const {find, one, rows, map, call, hash, policy, denied} = lib
const {PREVIEW, INSTRUCTION, ATTEMPT, RESERVATION, RESPONSE, CONFIG, BINDING} = gateway
const operations = {authorize: "PgoAuthorize", capture: "PgoCapture", release: "PgoRelease", refund: "PgoRefund"}
const namespace = "mantle.account.PaymentServices."
const refundGateway = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayRefunds.js")
const refunds = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefunds.js")
function json(value) {
    try {
        return JSON.parse(value || "{}")
    } catch (_) {
        denied("GATEWAY_EVIDENCE_UNAVAILABLE", "The retained gateway evidence is unavailable")
    }
}
function update(row, values) {
    for (const [field, value] of Object.entries(values)) row.set(field, value)
    row.update()
}
function stage(name, parameters) {
    return lib.probe(namespace + name, parameters)
}
function requireParent(allowed) {
    const frames = ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .filter(name => name.startsWith(namespace))
    if (!allowed.some(name => frames[1] === namespace + name))
        denied("GATEWAY_INTERNAL_ONLY", "This gateway stage requires its native orchestrator")
}
function operationKey(value) {
    const key = String(value || "")
    if (!key || key.length > 40) denied("OPERATION_KEY_REQUIRED", "Use an operation key of at most forty characters")
    return key
}
function reasonCode(error) {
    return String(error?.message || error || "").match(/(?:^|\b)([A-Z][A-Z0-9_]{3,}):/)?.[1] || "GATEWAY_LOCAL_POSTING_FAILED"
}
function frozenEvidence(files) {
    if (files.length > 10) denied("PAYMENT_EVIDENCE_COUNT_LIMIT", "Select at most ten evidence files")
    let total = 0
    return JSON.stringify(
        files.map(file => {
            total += file.bytes.length
            if (
                file.bytes.length > 10485760 ||
                total > 20971520 ||
                file.bytes.length !== Number(file.manifest.contentSize) ||
                hash(StringUtilities.base64Encode(file.bytes)) !== file.manifest.contentHash
            )
                denied("PAYMENT_EVIDENCE_SIZE_LIMIT", "Evidence bytes do not match the bounded reviewed selection")
            return {manifest: file.manifest, data: StringUtilities.base64Encode(file.bytes)}
        })
    )
}
function decodeEvidence(attempt) {
    const data = json(attempt.frozenEvidenceJson || "[]")
    if (!Array.isArray(data) || data.length > 10)
        denied("GATEWAY_EVIDENCE_UNAVAILABLE", "The frozen evidence selection is invalid")
    let total = 0
    return data.map(file => {
        const bytes = StringUtilities.base64Decode(file.data || "")
        total += bytes.length
        if (
            bytes.length > 10485760 ||
            total > 20971520 ||
            bytes.length !== Number(file.manifest?.contentSize) ||
            hash(StringUtilities.base64Encode(bytes)) !== file.manifest?.contentHash
        )
            denied("GATEWAY_EVIDENCE_UNAVAILABLE", "Frozen evidence bytes do not match their immutable manifest")
        return {manifest: file.manifest, bytes}
    })
}
function assertReview(row, p) {
    if (p.inputFingerprint !== row.inputFingerprint) denied("GATEWAY_PREVIEW_MISMATCH", "Confirm the retained gateway review")
    if (row.status !== "review") denied("GATEWAY_PREVIEW_CONSUMED", "The review was confirmed with another operation")
    if (lib.ms(row.expiresDate) <= Number(ec.user.nowTimestamp))
        denied("GATEWAY_PREVIEW_EXPIRED", "Review the gateway action again")
}
function storeOperation(op, attempt, result, complete = false) {
    const old = one(lib.operationEntity, {operationKey: op.operationKey}),
        values = {
            status: complete ? "complete" : "pending",
            resultEntityName: ATTEMPT,
            resultId: attempt.attemptId,
            resultJson: JSON.stringify(result),
            completedDate: complete ? ec.user.nowTimestamp : null
        }
    if (old) update(old, values)
    else
        call(
            "create#" + lib.operationEntity,
            Object.assign(values, {
                operationKey: op.operationKey,
                operationType: op.operationType,
                organizationPartyId: op.organizationPartyId,
                requestHash: op.requestHash,
                userId: ec.user.userId,
                submittedDate: ec.user.nowTimestamp
            })
        )
}
function reserve(p) {
    isolation.assertNoProviderWrite()
    requireParent(["execute#PaymentGatewayAction"])
    const retained = gateway.retained(p, true, true),
        row = retained.row,
        op = lib.operation(p, "PaymentGatewayAction", retained.scope.organizationPartyId, {
            previewId: p.previewId,
            inputFingerprint: p.inputFingerprint
        }),
        old = find(ATTEMPT, {organizationPartyId: retained.scope.organizationPartyId, operationKey: op.operationKey})
            .forUpdate(true)
            .one()
    if (old) {
        if (old.previewId !== row.previewId || old.requestHash !== op.requestHash || old.userId !== ec.user.userId)
            denied("OPERATION_KEY_CONFLICT", "This key belongs to another gateway request")
        return {attemptId: old.attemptId, shouldDispatch: false, alreadyApplied: true}
    }
    if (op.old) denied("OPERATION_KEY_CONFLICT", "This key belongs to another operation")
    if (row.previewKind !== "gatewayAction") denied("GATEWAY_PREVIEW_MISMATCH", "Use an action review to dispatch provider work")
    assertReview(row, p)
    const n = gateway.normalized(retained.request, true)
    if (n.fingerprint !== row.inputFingerprint)
        denied("STALE_PREVIEW", "The payment, methods, binding, capacity or policy changed")
    let instruction = n.instruction
    if (!instruction) {
        call("create#" + INSTRUCTION, {
            instructionId: row.instructionId,
            organizationPartyId: n.scope.organizationPartyId,
            paymentId: row.paymentId,
            partyId: n.scope.partyId,
            authorizedAmount: n.scope.record.amount,
            currencyUomId: n.scope.record.amountUomId,
            accountingDate: n.scope.record.accountingDate,
            paymentGatewayConfigId: n.binding.config.paymentGatewayConfigId,
            bindingVersion: n.binding.version,
            adapterVersion: n.binding.config.reviewedAdapterVersion,
            merchantNamespace: n.binding.config.reviewedMerchantNamespace,
            state: "pending",
            createdDate: ec.user.nowTimestamp,
            userId: ec.user.userId
        })
        instruction = find(INSTRUCTION, {instructionId: row.instructionId}).forUpdate(true).one()
    }
    if (instruction.instructionId !== row.instructionId) denied("STALE_PREVIEW", "The payment acquired another instruction")
    const attemptId = row.attemptId,
        token = ec.user.randomString(40),
        parent =
            n.request.action === "refund"
                ? n.capture
                : n.request.parentAttemptId && one(ATTEMPT, {attemptId: n.request.parentAttemptId}),
        responseId = ec.user.randomString(32),
        cashPaymentId = n.request.action === "capture" ? ec.user.randomString(32) : null
    call("create#" + ATTEMPT, {
        attemptId,
        organizationPartyId: n.scope.organizationPartyId,
        paymentId: row.paymentId,
        partyId: n.scope.partyId,
        instructionId: instruction.instructionId,
        parentAttemptId: n.request.action === "refund" ? n.capture.attemptId : n.request.parentAttemptId,
        refundDraftPaymentId: n.request.action === "refund" ? n.request.refundPaymentId : null,
        previewId: row.previewId,
        paymentGatewayResponseId: responseId,
        userId: ec.user.userId,
        operationKey: op.operationKey,
        requestHash: op.requestHash,
        action: n.request.action,
        amount: n.request.amount,
        currencyUomId: n.scope.record.amountUomId,
        effectiveDate: n.request.effectiveDate,
        accountingDate: n.request._accountingDay,
        sourceVersion: n.request.sourceVersion,
        financialSourceHash: gateway.financialSource(n.scope.record),
        paymentGatewayConfigId: n.binding.config.paymentGatewayConfigId,
        bindingVersion: n.binding.version,
        adapterVersion: n.binding.config.reviewedAdapterVersion,
        merchantNamespace: n.binding.config.reviewedMerchantNamespace,
        operationServiceName: n.binding.config.reviewedOperationServiceName,
        lookupServiceName: n.binding.config.reviewedLookupServiceName,
        guaranteesJson: JSON.stringify(n.binding.declared),
        providerOperationId: ec.user.randomString(32),
        parentProviderReference: parent?.providerReference || null,
        providerState: n.request.action === "refund" ? "reserved" : "dispatched",
        financialState: "none",
        dispatchToken: token,
        leaseExpiresDate: Number(ec.user.nowTimestamp) + 300000,
        dispatchCount: 1,
        lookupCount: 0,
        frozenEvidenceJson: frozenEvidence(n.evidence),
        cashPaymentId,
        createdDate: ec.user.nowTimestamp,
        dispatchedDate: ec.user.nowTimestamp
    })
    if (n.request.action === "refund" && n.linked) {
        const version = refundGateway.claim(find(ATTEMPT, {attemptId}).useCache(false).forUpdate(true).one(), n)
        update(find(ATTEMPT, {attemptId}).useCache(false).forUpdate(true).one(), {refundDraftVersion: version})
    }
    if (n.request.action === "refund")
        update(find(ATTEMPT, {attemptId}).useCache(false).forUpdate(true).one(), {providerState: "dispatched"})
    call("create#" + RESERVATION, {
        reservationId: ec.user.randomString(32),
        organizationPartyId: n.scope.organizationPartyId,
        attemptId,
        instructionId: instruction.instructionId,
        paymentId: row.paymentId,
        sourceKind: n.request.action === "refund" ? "capture" : "authorization",
        sourceId: n.request.action === "refund" ? n.capture.attemptId : instruction.instructionId,
        holdKind: n.request.action === "authorize" ? "authorization" : n.request.action,
        amount: n.request.amount,
        currencyUomId: n.scope.record.amountUomId,
        accountingDate: n.request._accountingDay,
        status: "held",
        createdDate: ec.user.nowTimestamp
    })
    if (n.request.action === "refund")
        call("create#" + RESERVATION, {
            reservationId: ec.user.randomString(32),
            organizationPartyId: n.scope.organizationPartyId,
            attemptId,
            instructionId: instruction.instructionId,
            paymentId: row.paymentId,
            sourceKind: "payment",
            sourceId: row.paymentId,
            holdKind: "cash",
            amount: n.request.amount,
            currencyUomId: n.scope.record.amountUomId,
            accountingDate: n.request._accountingDay,
            status: "held",
            createdDate: ec.user.nowTimestamp
        })
    // Every dispatched request has a durable response identity, including pending/uncertain work with no receipt yet.
    call("create#" + RESPONSE, {
        paymentGatewayResponseId: responseId,
        gatewayAttemptId: attemptId,
        paymentId: row.paymentId,
        paymentGatewayConfigId: n.binding.config.paymentGatewayConfigId,
        paymentOperationEnumId: operations[n.request.action],
        paymentMethodId: n.scope.record.paymentMethodId,
        amount: n.request.amount,
        amountUomId: n.scope.record.amountUomId,
        transactionDate: ec.user.nowTimestamp,
        transactionStatus: "dispatched",
        resultSuccess: "N",
        resultDeclined: "N",
        resultError: "N"
    })
    if (!n.scope.record.gatewayRole)
        update(n.scope.record, {gatewayInstructionId: instruction.instructionId, gatewayRole: "authorization"})
    if (n.request.action === "authorize") update(instruction, {authorizationAttemptId: attemptId, state: "pending"})
    const attempt = one(ATTEMPT, {attemptId})
    update(row, {status: "submitted", operationKey: op.operationKey, resultJson: JSON.stringify(gateway.resultFor(attempt))})
    storeOperation(op, attempt, gateway.resultFor(attempt))
    return {attemptId, token, shouldDispatch: true, alreadyApplied: false}
}
function providerRequest(attempt) {
    const original = one(PREVIEW, {previewId: attempt.previewId}),
        request = original && json(original.requestJson),
        methods = request?._methods
    if (!methods) denied("GATEWAY_EVIDENCE_UNAVAILABLE", "Original approved method identities are unavailable")
    const parent = one(P, {paymentId: attempt.paymentId}),
        incoming = parent?.toPartyId === attempt.organizationPartyId
    if (!parent || gateway.financialSource(parent) !== attempt.financialSourceHash)
        denied("GATEWAY_SOURCE_CHANGED", "The original provider source changed")
    return {
        providerOperationId: attempt.providerOperationId,
        merchantNamespace: attempt.merchantNamespace,
        adapterVersion: attempt.adapterVersion,
        action: attempt.action,
        parentProviderReference: attempt.parentProviderReference,
        paymentId: attempt.paymentId,
        paymentGatewayConfigId: attempt.paymentGatewayConfigId,
        sourcePaymentMethodId: incoming ? methods.counterpartyPaymentMethodId : methods.organizationPaymentMethodId,
        destinationPaymentMethodId: incoming ? methods.organizationPaymentMethodId : methods.counterpartyPaymentMethodId,
        sourceMethodVersion: incoming ? methods.counterpartyMethodVersion : methods.organizationMethodVersion,
        destinationMethodVersion: incoming ? methods.organizationMethodVersion : methods.counterpartyMethodVersion,
        originalCapture: request._capture || null,
        amount: attempt.amount,
        currencyUomId: attempt.currencyUomId
    }
}
function assertOriginalAdapter(attempt) {
    const config = one(CONFIG, {paymentGatewayConfigId: attempt.paymentGatewayConfigId}),
        binding = one(BINDING, {
            organizationPartyId: attempt.organizationPartyId,
            paymentGatewayConfigId: attempt.paymentGatewayConfigId
        })
    if (
        !config ||
        !binding ||
        binding.isEnabled !== "Y" ||
        !policy.active(binding, ec.user.nowTimestamp) ||
        config.reviewedMerchantNamespace !== attempt.merchantNamespace ||
        config.reviewedAdapterVersion !== attempt.adapterVersion ||
        config.reviewedOperationServiceName !== attempt.operationServiceName ||
        config.reviewedLookupServiceName !== attempt.lookupServiceName
    )
        denied("GATEWAY_BINDING_CHANGED", "The original provider adapter or merchant namespace is unavailable")
    const declared = gateway.guarantees(config)[attempt.action]
    if (!declared?.enabled || !declared.exactLookup) denied("GATEWAY_ADAPTER_UNSUPPORTED", "Exact provider lookup is unavailable")
}
function dispatch(p) {
    requireParent(["execute#PaymentGatewayAction"])
    // The preparation transaction ends before the leaf sees this by-value credential snapshot. No mutable method
    // lookup or financial lock is carried across provider I/O, including when execute joined a caller transaction.
    const prepared = stage("prepare#PaymentGatewayDispatch", p)
    return {providerEvidence: call(prepared.adapterServiceName, prepared.adapterRequest)}
}
function prepareDispatch(p) {
    requireParent(["dispatch#PaymentGatewayAttempt"])
    const r = gateway.attemptScope(p, true, true)
    gateway.scopeFor({organizationPartyId: r.row.organizationPartyId, paymentId: r.row.paymentId}, true, false, true)
    if (!p.token || p.token !== r.row.dispatchToken || r.row.providerState !== "dispatched")
        denied("GATEWAY_DISPATCH_INVALID", "The provider request has no current native dispatch claim")
    assertOriginalAdapter(r.row)
    if (
        !gateway.guarantees(one(CONFIG, {paymentGatewayConfigId: r.row.paymentGatewayConfigId}))[r.row.action]
            .reviewedMethodSnapshot
    )
        denied("GATEWAY_ADAPTER_UNSUPPORTED", "The adapter must use the reviewed credential snapshot")
    const original = one(PREVIEW, {previewId: r.row.previewId}),
        request = original && json(original.requestJson)
    if (!request?._methods) denied("GATEWAY_EVIDENCE_UNAVAILABLE", "Original reviewed method identities are unavailable")
    if (r.row.action === "refund") {
        gateway.assertAction(
            {declared: gateway.guarantees(one(CONFIG, {paymentGatewayConfigId: r.row.paymentGatewayConfigId}))},
            "refund",
            true
        )
        const c = refundGateway.capture(r.scope, true)
        if (
            c.attemptId !== r.row.parentAttemptId ||
            c.providerReference !== r.row.parentProviderReference ||
            c.merchantNamespace !== r.row.merchantNamespace
        )
            denied("GATEWAY_REFUND_SOURCE_INVALID", "Refund reference no longer matches original capture")
        return {
            adapterServiceName: r.row.operationServiceName,
            adapterRequest: Object.assign(providerRequest(r.row), {credentialSnapshot: null})
        }
    }
    const methods = request._methods,
        sides = [
            {
                name: "organization",
                id: methods.organizationPaymentMethodId,
                version: methods.organizationMethodVersion,
                owner: r.scope.organizationPartyId
            },
            {
                name: "counterparty",
                id: methods.counterpartyPaymentMethodId,
                version: methods.counterpartyMethodVersion,
                owner: r.scope.partyId
            }
        ],
        locked = {}
    if (!sides[0].id || !sides[0].version)
        denied("PAYMENT_METHOD_REVIEW_REQUIRED", "The organization payment method requires its reviewed identity")
    // At repeatable-read, an ordinary read after FOR UPDATE can still return the transaction's older snapshot.
    // Both the version comparison and credential DTO must use these exact fresh locking-read values, with no
    // subsequent ordinary method/subtype reread between validation and by-value projection.
    for (const id of [...new Set(sides.map(side => side.id).filter(Boolean))].sort()) {
        const method = find("mantle.account.method.PaymentMethod", {paymentMethodId: id}).useCache(false).forUpdate(true).one()
        if (!method) denied("PAYMENT_METHOD_UNAVAILABLE", "The original payment method is unavailable")
        locked[id] = {method, identities: workflow.methodIdentities(method, true)}
    }
    const snapshots = {}
    for (const side of sides) {
        if (!side.id) {
            snapshots[side.name] = null
            continue
        }
        const current = locked[side.id],
            method = current.method,
            identities = current.identities
        if (method.ownerPartyId !== side.owner) denied("PAYMENT_METHOD_UNAVAILABLE", "The original payment method owner changed")
        if (!side.version || workflow.methodVersion(method, identities) !== side.version)
            denied("STALE_PAYMENT_METHOD", "The payment method changed; review it again")
        if (!policy.active(method, r.row.effectiveDate))
            denied("PAYMENT_METHOD_INACTIVE", "The payment method is not active on the reviewed day")
        if (method.currencyUomId !== r.row.currencyUomId)
            denied("CURRENCY_MISMATCH", "The payment method currency does not match the reviewed operation")
        snapshots[side.name] = {
            method: policy.pick(map(method), workflow.methodIdentityFields),
            bank: identities.bank ? policy.pick(map(identities.bank), workflow.bankIdentityFields) : null,
            card: identities.card ? policy.pick(map(identities.card), workflow.cardIdentityFields) : null
        }
    }
    const incoming = r.scope.cashDirection === "incoming",
        adapterRequest = Object.assign(providerRequest(r.row), {
            credentialSnapshot: {
                source: incoming ? snapshots.counterparty : snapshots.organization,
                destination: incoming ? snapshots.organization : snapshots.counterparty
            }
        })
    return {adapterServiceName: r.row.operationServiceName, adapterRequest}
}
function lookup(p) {
    requireParent(["refresh#PaymentGatewayAttempt"])
    const r = gateway.attemptScope(p, true)
    gateway.scopeFor({organizationPartyId: r.row.organizationPartyId, paymentId: r.row.paymentId}, true, false, true)
    if (!p.token || p.token !== r.row.lookupToken) denied("GATEWAY_DISPATCH_INVALID", "The lookup has no current native claim")
    assertOriginalAdapter(r.row)
    return {providerEvidence: call(r.row.lookupServiceName, providerRequest(r.row))}
}
function lockEvidenceAttempt(p) {
    let attempt = one(ATTEMPT, {attemptId: p.attemptId})
    if (!attempt) denied("GATEWAY_ATTEMPT_UNAVAILABLE", "The provider attempt is unavailable")
    // This internal evidence stage persists the actual provider result even if caller permissions changed during I/O.
    find("mantle.party.Party", {partyId: attempt.organizationPartyId}).forUpdate(true).one()
    const ids =
        attempt.action === "refund"
            ? [
                  ...new Set(
                      [
                          attempt.paymentId,
                          attempt.refundDraftPaymentId,
                          ...Array.from(find(P, {refundForPaymentId: attempt.paymentId}).useCache(false).list()).map(
                              row => row.paymentId
                          )
                      ].filter(Boolean)
                  )
              ].sort()
            : [attempt.paymentId]
    Array.from(find(P).condition("paymentId", "in", ids).orderBy("paymentId").useCache(false).forUpdate(true).list())
    find(INSTRUCTION, {instructionId: attempt.instructionId}).forUpdate(true).one()
    attempt = find(ATTEMPT, {attemptId: attempt.attemptId}).forUpdate(true).useCache(false).one()
    return attempt
}
function typedReceipt(attempt, p) {
    const reply = p.providerEvidence || {},
        state = reply.outcome,
        identity =
            reply.providerOperationId === attempt.providerOperationId &&
            reply.merchantNamespace === attempt.merchantNamespace &&
            reply.adapterVersion === attempt.adapterVersion &&
            reply.action === attempt.action,
        money = (() => {
            try {
                return toDecimal(reply.amount).eq(attempt.amount) && reply.currencyUomId === attempt.currencyUomId
            } catch (_) {
                return false
            }
        })()
    if (p.transportFailure)
        return {
            providerState: "uncertain",
            reasonCode: "GATEWAY_OUTCOME_UNCERTAIN",
            errorMessage: "Provider outcome is uncertain; look up this exact request"
        }
    if (
        !identity ||
        !money ||
        !["accepted", "declined", "pending", "uncertain", "not_found"].includes(state) ||
        (state === "not_found" && p.kind !== "lookup") ||
        (state === "accepted" && !reply.providerReference)
    )
        return {
            providerState: "quarantined",
            reasonCode: "GATEWAY_RECEIPT_MISMATCH",
            errorMessage: "Provider evidence does not match the reviewed operation"
        }
    const receipt = {
        providerOperationId: reply.providerOperationId,
        merchantNamespace: reply.merchantNamespace,
        adapterVersion: reply.adapterVersion,
        action: reply.action,
        amount: String(attempt.amount),
        currencyUomId: reply.currencyUomId,
        outcome: state,
        providerReference: String(reply.providerReference || "").slice(0, 255),
        providerDate: reply.providerDate ? lib.ms(reply.providerDate) : null,
        providerSettlementDate: reply.providerSettlementDate ? lib.ms(reply.providerSettlementDate) : null,
        responseCode: String(reply.responseCode || "").slice(0, 60),
        reasonCode: String(reply.reasonCode || "").slice(0, 60),
        definitiveNonexecution: state === "not_found" && reply.definitiveNonexecution === true
    }
    return {
        providerState: state === "not_found" ? (receipt.definitiveNonexecution ? "declined" : "uncertain") : state,
        reasonCode:
            state === "not_found"
                ? receipt.definitiveNonexecution
                    ? "GATEWAY_NOT_EXECUTED"
                    : "GATEWAY_OUTCOME_UNCERTAIN"
                : state === "accepted"
                  ? "GATEWAY_ACCEPTED_UNPOSTED"
                  : state === "declined"
                    ? "GATEWAY_DECLINED"
                    : "GATEWAY_OUTCOME_PENDING",
        receiptJson: JSON.stringify(receipt),
        providerReference: receipt.providerReference || null,
        providerDate: receipt.providerDate,
        providerSettlementDate: receipt.providerSettlementDate,
        responseCode: receipt.responseCode,
        errorMessage: null
    }
}
function persistVisibleResult(attempt) {
    const result = gateway.resultFor(attempt),
        preview = one(PREVIEW, {previewId: attempt.previewId}),
        operation = one(lib.operationEntity, {operationKey: attempt.operationKey})
    if (preview)
        update(preview, {
            status:
                ["declined"].includes(attempt.providerState) || attempt.financialState === "completed" ? "complete" : "submitted",
            resultJson: JSON.stringify(result)
        })
    if (operation)
        update(operation, {
            status: attempt.providerState === "declined" || attempt.financialState === "completed" ? "complete" : "pending",
            completedDate:
                attempt.providerState === "declined" || attempt.financialState === "completed" ? ec.user.nowTimestamp : null,
            resultJson: JSON.stringify(result)
        })
    const response = one(RESPONSE, {paymentGatewayResponseId: attempt.paymentGatewayResponseId})
    if (response)
        update(response, {
            transactionDate: attempt.providerDate || attempt.createdDate,
            referenceNum: attempt.providerReference,
            transactionStatus: attempt.providerState,
            resultSuccess: attempt.providerState === "accepted" ? "Y" : "N",
            resultDeclined: attempt.providerState === "declined" ? "Y" : "N",
            resultError: ["uncertain", "quarantined"].includes(attempt.providerState) ? "Y" : "N",
            responseCode: attempt.responseCode,
            reasonCode: attempt.reasonCode
        })
    return result
}
function record(p) {
    isolation.assertNoProviderWrite()
    requireParent(["execute#PaymentGatewayAction", "refresh#PaymentGatewayAttempt"])
    const attempt = lockEvidenceAttempt(p),
        expected = p.kind === "lookup" ? attempt.lookupToken : attempt.dispatchToken
    if (!p.token || p.token !== expected || !["dispatch", "lookup"].includes(p.kind))
        denied("GATEWAY_DISPATCH_INVALID", "The result is not bound to the native provider claim")
    if (attempt.providerState === "accepted" || attempt.providerState === "declined") return {attemptId: attempt.attemptId}
    const result = typedReceipt(attempt, p)
    update(
        attempt,
        Object.assign(result, {
            financialState: result.providerState === "accepted" ? "accepted_unposted" : "none",
            leaseExpiresDate: null,
            lookupLeaseExpiresDate: null
        })
    )
    if (result.providerState === "declined")
        for (const hold of find(RESERVATION, {attemptId: attempt.attemptId, status: "held"}).forUpdate(true).list())
            update(hold, {status: "released"})
    if (attempt.action === "refund" && result.providerState === "declined") refundGateway.releaseClaim(attempt, "released")
    if (attempt.action === "authorize" && result.providerState === "declined")
        update(one(INSTRUCTION, {instructionId: attempt.instructionId}), {state: "declined"})
    persistVisibleResult(attempt)
    return {attemptId: attempt.attemptId}
}
function claimLookup(p) {
    isolation.assertNoProviderWrite()
    requireParent(["refresh#PaymentGatewayAttempt"])
    const r = gateway.attemptScope(p, true, true),
        op = lib.operation(p, "PaymentGatewayLookup", r.scope.organizationPartyId, {
            attemptId: p.attemptId,
            attemptVersion: p.attemptVersion
        })
    if (op.old) return {attemptId: r.row.attemptId, shouldLookup: false, alreadyApplied: true, savedResultJson: op.old.resultJson}
    gateway.scopeFor({organizationPartyId: r.row.organizationPartyId, paymentId: r.row.paymentId}, true, false, true)
    if (!p.attemptVersion || p.attemptVersion !== gateway.attemptVersion(r.row))
        denied("STALE_REVISION", "The provider attempt changed; reload it")
    if (["accepted", "declined"].includes(r.row.providerState))
        denied("GATEWAY_LOOKUP_UNAVAILABLE", "This attempt already has a definitive provider outcome")
    if (
        lib.ms(r.row.leaseExpiresDate) > Number(ec.user.nowTimestamp) ||
        lib.ms(r.row.lookupLeaseExpiresDate) > Number(ec.user.nowTimestamp)
    )
        denied("GATEWAY_ATTEMPT_BUSY", "The provider request is still in progress")
    const token = ec.user.randomString(40)
    update(r.row, {
        lookupToken: token,
        lookupLeaseExpiresDate: Number(ec.user.nowTimestamp) + 300000,
        lookupCount: Number(r.row.lookupCount || 0) + 1
    })
    const claimed = find(ATTEMPT, {attemptId: r.row.attemptId}).useCache(false).one(),
        original = one(PREVIEW, {previewId: claimed.previewId}),
        payload = original && json(original.payloadJson)
    storeOperation(
        op,
        claimed,
        Object.assign(gateway.resultFor(claimed), {
            attemptVersion: gateway.attemptVersion(claimed),
            operationKey: claimed.operationKey,
            paymentSummary: payload?.paymentSummary,
            gatewaySummary: payload?.gatewaySummary
        })
    )
    return {attemptId: r.row.attemptId, token, shouldLookup: true, alreadyApplied: false}
}
function financialPlan(attempt, scope, lock = false) {
    if (attempt.action === "refund") {
        const original = one(PREVIEW, {previewId: attempt.previewId}),
            request = original && json(original.requestJson)
        if (
            !request ||
            gateway.financialSource(scope.record) !== attempt.financialSourceHash ||
            request._financialSourceHash !== attempt.financialSourceHash ||
            !toDecimal(request.amount).eq(attempt.amount) ||
            request._accountingDay !== policy.calendarDateText(attempt.accountingDate)
        )
            denied("GATEWAY_SOURCE_CHANGED", "The accepted refund source or money changed")
        refundGateway.held(attempt, lock)
        const n = refundGateway.normalized(request, lock, attempt, decodeEvidence(attempt))
        // Fresh financial policy/plans are compared against the immutable original review below. Preserve
        // that original request separately; replacing its private plans here would compare fresh with fresh.
        return Object.assign(n, {original, request})
    }
    const preview = one(PREVIEW, {previewId: attempt.previewId}),
        request = preview && json(preview.requestJson)
    if (
        !request?._methods ||
        gateway.financialSource(scope.record) !== attempt.financialSourceHash ||
        request._financialSourceHash !== attempt.financialSourceHash
    )
        denied("GATEWAY_SOURCE_CHANGED", "The accepted operation's original financial source changed")
    if (
        !toDecimal(request.amount).eq(attempt.amount) ||
        request._accountingDay !== policy.calendarDateText(attempt.accountingDate)
    )
        denied("GATEWAY_EVIDENCE_UNAVAILABLE", "The accepted amount or accounting day changed")
    const date = settlement.dateInput(attempt.effectiveDate, policy.calendarDateText(attempt.accountingDate)),
        methods = lifecycle.methodEvidence(
            scope,
            Object.assign({}, request._methods, {currencyUomId: attempt.currencyUomId}),
            date.timestamp,
            lock
        ),
        planned = Object.assign({}, scope, {
            record: Object.assign(map(scope.record), {
                amount: toDecimal(request.amount),
                effectiveDate: request.effectiveDate,
                accountingDate: request._accountingDay
            })
        }),
        plans = attempt.action === "capture" ? [lifecycle.cashPlan(planned, methods)] : [],
        policyEvidence = settlement.validatePolicy(
            {
                organizationPartyId: scope.organizationPartyId,
                partyId: scope.partyId,
                direction: scope.financeDirection,
                currencyUomId: attempt.currencyUomId
            },
            date,
            plans,
            lock
        )
    return {request, plans, policyEvidence, methods, date, evidence: decodeEvidence(attempt), original: preview}
}
function previewRecovery(p) {
    isolation.assertNoProviderWrite()
    const r = gateway.attemptScope(p, true)
    gateway.scopeFor({organizationPartyId: r.row.organizationPartyId, paymentId: r.row.paymentId}, true, false, true)
    if (!p.attemptVersion || p.attemptVersion !== gateway.attemptVersion(r.row))
        denied("STALE_REVISION", "The accepted attempt changed; reload it")
    if (r.row.providerState !== "accepted" || r.row.financialState !== "accepted_unposted")
        denied("GATEWAY_RECOVERY_UNAVAILABLE", "Only accepted unposted provider work needs financial recovery")
    const ownHolds = rows(RESERVATION, {attemptId: r.row.attemptId, status: "held"})
    if (
        ownHolds.length !== (r.row.action === "refund" ? 2 : 1) ||
        ownHolds.some(hold => !toDecimal(hold.amount).eq(r.row.amount))
    )
        denied("GATEWAY_HOLD_UNAVAILABLE", "The accepted operation has no exact capacity hold")
    const reason = String(p.reason || "").trim()
    if (!reason || reason.length > 4000) denied("GATEWAY_REASON_REQUIRED", "Enter the financial recovery reason")
    const n = financialPlan(r.row, r.scope),
        previewId = ec.user.randomString(32),
        originalPayload = json(n.original.payloadJson),
        before =
            r.row.action === "refund" ? n.payload.before : gateway.instructionSummary(gateway.instructionFor(r.scope.record)),
        adjusted = Object.assign(
            {},
            before,
            r.row.action === "capture"
                ? {captureHeldAmount: String(toDecimal(before.captureHeldAmount).subtract(r.row.amount))}
                : {}
        ),
        request = {
            attemptId: r.row.attemptId,
            attemptVersion: p.attemptVersion,
            reason,
            _plans: n.plans,
            _policyEvidence: n.policyEvidence
        },
        payload = Object.assign({}, originalPayload, {
            previewKind: "gatewayRecovery",
            financialOnly: true,
            reason,
            before,
            after: Object.assign(
                r.row.action === "refund"
                    ? n.payload.after
                    : gateway.plannedCapacity(adjusted, r.row.action, toDecimal(r.row.amount), r.row.currencyUomId),
                {
                    assumption: "localCompleted"
                }
            ),
            reservationEffects: (originalPayload.reservationEffects || []).map(row =>
                Object.assign({}, row, {status: "consumed", effect: "consumeExistingHold"})
            ),
            ledgerPreview: n.plans,
            postingSummary: {
                cashPostingCount: r.row.action === "refund" ? 1 : n.plans.length,
                applicationPostingCount: r.row.action === "refund" ? 1 : 0,
                effect: "Complete the accepted provider operation locally; no provider request"
            }
        }),
        fingerprint = hash({
            request,
            receipt: r.row.receiptJson,
            source: r.row.financialSourceHash,
            evidence: n.evidence.map(file => file.manifest)
        })
    call("create#" + PREVIEW, {
        previewId,
        organizationPartyId: r.row.organizationPartyId,
        paymentId: r.row.paymentId,
        userId: ec.user.userId,
        previewKind: "gatewayRecovery",
        action: r.row.action,
        instructionId: r.row.instructionId,
        attemptId: r.row.attemptId,
        sourceVersion: workflow.paymentVersion(r.scope.record),
        attemptVersion: p.attemptVersion,
        inputFingerprint: fingerprint,
        requestJson: JSON.stringify(request),
        payloadJson: JSON.stringify(payload),
        createdDate: ec.user.nowTimestamp,
        expiresDate: Number(ec.user.nowTimestamp) + 1800000,
        status: "review"
    })
    return gateway.projectPreview(one(PREVIEW, {previewId}), r.scope)
}
function complete(p) {
    isolation.assertNoProviderWrite()
    const retained = gateway.retained(p, true, true),
        review = retained.row,
        op = lib.operation(p, "PaymentGatewayCompletion", retained.scope.organizationPartyId, {
            previewId: p.previewId,
            inputFingerprint: p.inputFingerprint
        })
    if (op.old) return gateway.projectResult(lib.previous(op), retained.scope)
    if (p.inputFingerprint !== review.inputFingerprint) denied("GATEWAY_PREVIEW_MISMATCH", "Confirm the reviewed financial plan")
    const attempt = find(ATTEMPT, {attemptId: review.attemptId}).forUpdate(true).useCache(false).one()
    if (!attempt || attempt.paymentId !== review.paymentId || attempt.organizationPartyId !== review.organizationPartyId)
        denied("GATEWAY_ATTEMPT_UNAVAILABLE", "The accepted provider attempt is unavailable")
    if (attempt.financialState === "completed")
        denied("GATEWAY_PREVIEW_CONSUMED", "The accepted attempt was completed under its recorded operation")
    gateway.scopeFor({organizationPartyId: review.organizationPartyId, paymentId: review.paymentId}, true, false, true)
    if (attempt.providerState !== "accepted" || attempt.financialState !== "accepted_unposted")
        denied("GATEWAY_NOT_ACCEPTED", "Local money requires a durable accepted provider receipt")
    if (review.previewKind === "gatewayRecovery") {
        assertReview(review, p)
        if (retained.request.attemptVersion !== gateway.attemptVersion(attempt))
            denied("STALE_PREVIEW", "The accepted operation changed")
    } else if (
        review.previewKind !== "gatewayAction" ||
        review.previewId !== attempt.previewId ||
        review.operationKey !== attempt.operationKey
    )
        denied("GATEWAY_PREVIEW_MISMATCH", "The financial review is not bound to this accepted request")
    const n = financialPlan(attempt, retained.scope, true),
        expected = review.previewKind === "gatewayRecovery" ? retained.request : n.request
    if (hash({plans: n.plans, policy: n.policyEvidence}) !== hash({plans: expected._plans, policy: expected._policyEvidence}))
        denied("STALE_PREVIEW", "Posting policy changed; review financial recovery")
    const receipt = json(attempt.receiptJson)
    if (
        receipt.outcome !== "accepted" ||
        receipt.providerOperationId !== attempt.providerOperationId ||
        receipt.merchantNamespace !== attempt.merchantNamespace ||
        receipt.action !== attempt.action ||
        receipt.currencyUomId !== attempt.currencyUomId ||
        !toDecimal(receipt.amount).eq(attempt.amount)
    )
        denied("GATEWAY_RECEIPT_MISMATCH", "The accepted provider receipt is inconsistent")
    const instruction = find(INSTRUCTION, {instructionId: attempt.instructionId}).forUpdate(true).one(),
        held = Array.from(find(RESERVATION, {attemptId: attempt.attemptId, status: "held"}).forUpdate(true).list())
    if (
        !instruction ||
        held.length !== (attempt.action === "refund" ? 2 : 1) ||
        held.some(hold => !toDecimal(hold.amount).eq(attempt.amount))
    )
        denied("GATEWAY_HOLD_UNAVAILABLE", "The accepted operation has no exact durable capacity hold")
    for (const hold of held) update(hold, {status: "consumed", consumedDate: ec.user.nowTimestamp})
    if (attempt.action === "refund") {
        refundGateway.releaseClaim(attempt, "consumed")
        const cashPaymentId = attempt.refundDraftPaymentId || ec.user.randomString(32)
        update(attempt, {cashPaymentId})
        // Consuming both own holds in this transaction exposes only this exact reserved amount. Other holds
        // remain in the authoritative availability calculation; no caller-supplied exclusion is accepted.
        const available = refunds.funding(retained.scope, true)
        if (toDecimal(attempt.amount).compare(available.refundable) > 0)
            denied("REFUND_FUNDS_UNAVAILABLE", "Reserved refund cash is no longer available")
        n.funding = available
        const money = refunds.completeMoney(n, cashPaymentId, op, attempt),
            result = Object.assign({}, money, {
                attemptId: attempt.attemptId,
                providerOperationId: attempt.providerOperationId,
                organizationPartyId: attempt.organizationPartyId,
                paymentId: attempt.paymentId,
                originalPaymentId: attempt.paymentId,
                cashPaymentId,
                refundPaymentId: cashPaymentId,
                action: "refund",
                outcome: "completed",
                providerState: "accepted",
                financialState: "completed",
                reasonCode: "GATEWAY_COMPLETED"
            })
        update(attempt, {
            financialState: "completed",
            completedDate: ec.user.nowTimestamp,
            reasonCode: "GATEWAY_COMPLETED",
            errorMessage: null,
            resultJson: JSON.stringify(result)
        })
        update(review, {
            status: "complete",
            operationKey: review.previewKind === "gatewayRecovery" ? op.operationKey : attempt.operationKey,
            resultJson: JSON.stringify(result)
        })
        persistVisibleResult(attempt)
        lib.complete(op, ATTEMPT, attempt.attemptId, Object.assign({}, result, {operationKey: op.operationKey}))
        return gateway.projectResult(Object.assign({}, result, {operationKey: op.operationKey}), retained.scope)
    }
    let actualScope = retained.scope,
        acctgTransIds = [],
        outputRows = []
    let before = actualScope.record.statusId
    if (attempt.action === "capture") {
        before = null
        if (one(P, {paymentId: attempt.cashPaymentId}))
            denied("GATEWAY_FINANCIAL_INCONSISTENT", "Cash exists without the completed attempt")
        ec.resource.script("component://mr-mantle/service/mantle/account/PaymentArchiveGuard.js").prepare()
        const parent = retained.scope.record,
            child = ec.entity.makeValue(P),
            values = {
                paymentId: attempt.cashPaymentId,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: parent.paymentInstrumentEnumId,
                fromPartyId: parent.fromPartyId,
                toPartyId: parent.toPartyId,
                paymentMethodId: parent.paymentMethodId,
                toPaymentMethodId: parent.toPaymentMethodId,
                paymentGatewayConfigId: attempt.paymentGatewayConfigId,
                paymentRefNum: attempt.providerReference,
                amount: attempt.amount,
                amountUomId: attempt.currencyUomId,
                effectiveDate: attempt.effectiveDate,
                accountingDate: policy.calendarDateText(attempt.accountingDate),
                statusId: "PmntDelivered",
                lifecycleManaged: "Y",
                financeOrganizationPartyId: attempt.organizationPartyId,
                financeDirection: retained.scope.financeDirection,
                gatewayInstructionId: attempt.instructionId,
                gatewayAttemptId: attempt.attemptId,
                gatewayRole: "capture",
                comments: n.request.reason
            }
        for (const [field, value] of Object.entries(values)) child.set(field, value)
        child.create()
        actualScope = workflow.paymentScope(
            {organizationPartyId: attempt.organizationPartyId, paymentId: attempt.cashPaymentId},
            true,
            true
        )
        call("mantle.ledger.PaymentAutoPostServices.post#Payment", {paymentId: attempt.cashPaymentId})
        actualScope.record = find(P, {paymentId: attempt.cashPaymentId}).forUpdate(true).one()
        acctgTransIds = lifecycle.verifyCash(actualScope, n.plans)
        outputRows = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentOutput.js")
            .issue(
                actualScope,
                Object.assign({}, n.request, {paymentSummary: json(n.original.payloadJson).paymentSummary}),
                op.operationKey
            )
            .map(row => Object.assign({}, row, {paymentId: attempt.cashPaymentId}))
    } else {
        if (attempt.action === "authorize") {
            if (!["PmntProposed", "PmntPromised"].includes(actualScope.record.statusId))
                denied("GATEWAY_STATE_INVALID", "The authorization parent changed state")
            update(actualScope.record, {statusId: "PmntAuthorized"})
        } else if (attempt.action !== "release" || actualScope.record.statusId !== "PmntAuthorized")
            denied("GATEWAY_STATE_INVALID", "The release parent changed state")
        actualScope.record = find(P, {paymentId: attempt.paymentId}).forUpdate(true).one()
        if (n.evidence.length) ec.resource.script("component://mr-mantle/service/mantle/account/PaymentArchiveGuard.js").prepare()
    }
    const event = lifecycle.event(
        actualScope,
        "gateway" + attempt.action[0].toUpperCase() + attempt.action.slice(1),
        before,
        op,
        {
            reason: retained.request.reason || n.request.reason,
            referenceNumber: n.request.referenceNumber,
            sourceVersion: workflow.paymentVersion(actualScope.record),
            postingEffects: {
                attemptId: attempt.attemptId,
                authorizationPaymentId: attempt.paymentId,
                cashPaymentId: attempt.cashPaymentId
            }
        },
        [],
        acctgTransIds
    )
    lifecycle.freezeEvidence(actualScope, event.paymentLifecycleEventId, n.evidence)
    const result = {
        attemptId: attempt.attemptId,
        providerOperationId: attempt.providerOperationId,
        organizationPartyId: attempt.organizationPartyId,
        paymentId: attempt.paymentId,
        cashPaymentId: attempt.action === "capture" ? attempt.cashPaymentId : null,
        action: attempt.action,
        outcome: "completed",
        providerState: "accepted",
        financialState: "completed",
        amount: String(attempt.amount),
        currencyUomId: attempt.currencyUomId,
        accountingDateText: policy.calendarDateText(attempt.accountingDate),
        applicationResults: [],
        acctgTransIds,
        outputRows,
        paymentLifecycleEventId: event.paymentLifecycleEventId,
        reasonCode: "GATEWAY_COMPLETED",
        alreadyApplied: false
    }
    update(attempt, {
        financialState: "completed",
        completedDate: ec.user.nowTimestamp,
        reasonCode: "GATEWAY_COMPLETED",
        errorMessage: null,
        resultJson: JSON.stringify(result)
    })
    const summary = gateway.instructionSummary(instruction)
    update(instruction, {
        state:
            attempt.action === "release"
                ? "released"
                : attempt.action === "authorize"
                  ? "authorized"
                  : toDecimal(summary.capturableAmount).isZero() && toDecimal(summary.captureHeldAmount).isZero()
                    ? "captured"
                    : "partiallyCaptured"
    })
    update(review, {
        status: "complete",
        operationKey: review.previewKind === "gatewayRecovery" ? op.operationKey : attempt.operationKey,
        resultJson: JSON.stringify(result)
    })
    persistVisibleResult(attempt)
    lib.complete(op, ATTEMPT, attempt.attemptId, Object.assign({}, result, {operationKey: op.operationKey}))
    return gateway.projectResult(Object.assign({}, result, {operationKey: op.operationKey}), retained.scope)
}
function failCompletion(p) {
    isolation.assertNoProviderWrite()
    requireParent(["execute#PaymentGatewayAction", "refresh#PaymentGatewayAttempt"])
    const attempt = lockEvidenceAttempt(p)
    if (attempt.providerState === "accepted" && attempt.financialState !== "completed") {
        update(attempt, {
            financialState: "accepted_unposted",
            reasonCode: String(p.reasonCode || "GATEWAY_LOCAL_POSTING_FAILED").slice(0, 60),
            errorMessage: "The provider accepted; review and complete local posting without another provider request"
        })
        persistVisibleResult(attempt)
    }
    return {attemptId: attempt.attemptId}
}
function autoComplete(attemptId) {
    const fresh = stage("get#FreshPaymentGatewayAttempt", {attemptId})
    if (fresh.providerState !== "accepted" || fresh.financialState === "completed") return
    try {
        stage("complete#PaymentGatewayAttempt", {
            previewId: fresh.previewId,
            inputFingerprint: fresh.inputFingerprint,
            operationKey: "gwf:" + hash(attemptId).slice(0, 36)
        })
    } catch (error) {
        ec.logger.error("Gateway attempt " + attemptId + " local completion: " + error.message)
        stage("fail#PaymentGatewayCompletion", {attemptId, reasonCode: reasonCode(error)})
    }
}
function execute(p) {
    operationKey(p.operationKey)
    const reserved = stage("reserve#PaymentGatewayAction", {
        previewId: p.previewId,
        inputFingerprint: p.inputFingerprint,
        operationKey: p.operationKey
    })
    if (reserved.shouldDispatch) {
        let evidence = null,
            transportFailure = false
        try {
            evidence = stage("dispatch#PaymentGatewayAttempt", {
                attemptId: reserved.attemptId,
                token: reserved.token
            }).providerEvidence
        } catch (error) {
            transportFailure = true
            ec.logger.error("Gateway attempt " + reserved.attemptId + " provider dispatch: " + error.message)
        }
        stage("record#PaymentGatewayResult", {
            attemptId: reserved.attemptId,
            token: reserved.token,
            kind: "dispatch",
            providerEvidence: evidence,
            transportFailure
        })
    }
    if (reserved.shouldDispatch) autoComplete(reserved.attemptId)
    return Object.assign(stage("get#FreshPaymentGatewayAttempt", {attemptId: reserved.attemptId}).result, {
        alreadyApplied: Boolean(reserved.alreadyApplied)
    })
}
function refresh(p) {
    operationKey(p.operationKey)
    const claim = stage("claim#PaymentGatewayLookup", {
        organizationPartyId: p.organizationPartyId,
        attemptId: p.attemptId,
        attemptVersion: p.attemptVersion,
        operationKey: p.operationKey
    })
    if (claim.alreadyApplied && claim.savedResultJson) {
        return Object.assign(
            stage("get#FreshPaymentGatewayAttempt", {attemptId: claim.attemptId, savedResultJson: claim.savedResultJson}).result,
            {alreadyApplied: true}
        )
    }
    if (claim.shouldLookup) {
        let evidence = null,
            transportFailure = false
        try {
            evidence = stage("lookup#PaymentGatewayAttempt", {attemptId: claim.attemptId, token: claim.token}).providerEvidence
        } catch (error) {
            transportFailure = true
            ec.logger.error("Gateway attempt " + claim.attemptId + " provider lookup: " + error.message)
        }
        stage("record#PaymentGatewayResult", {
            attemptId: claim.attemptId,
            token: claim.token,
            kind: "lookup",
            providerEvidence: evidence,
            transportFailure
        })
    }
    if (claim.shouldLookup) autoComplete(claim.attemptId)
    stage("finish#PaymentGatewayLookup", {attemptId: claim.attemptId, operationKey: p.operationKey})
    return Object.assign(stage("get#FreshPaymentGatewayAttempt", {attemptId: claim.attemptId}).result, {
        alreadyApplied: Boolean(claim.alreadyApplied)
    })
}
function freshRead(p) {
    isolation.assertNoProviderWrite()
    requireParent(["execute#PaymentGatewayAction", "refresh#PaymentGatewayAttempt"])
    // Ignore services retain an existing caller transaction. Every interstage observation and projection therefore
    // runs in this force-new read transaction, never in a caller's retained entity snapshot or rollback scope.
    const r = gateway.attemptScope({attemptId: p.attemptId}),
        current = gateway.getAttempt({attemptId: p.attemptId}),
        original = one(PREVIEW, {previewId: r.row.previewId}),
        cached = p.savedResultJson ? json(p.savedResultJson) : null,
        result = cached
            ? Object.assign(gateway.projectResult(cached, r.scope), {
                  attemptVersion: cached.attemptVersion || current.attemptVersion,
                  capabilities: current.capabilities
              })
            : current
    return {
        attemptId: r.row.attemptId,
        providerState: r.row.providerState,
        financialState: r.row.financialState,
        previewId: original?.previewId,
        inputFingerprint: original?.inputFingerprint,
        result
    }
}
function finishLookup(p) {
    isolation.assertNoProviderWrite()
    requireParent(["refresh#PaymentGatewayAttempt"])
    const attempt = lockEvidenceAttempt(p),
        operation = find(lib.operationEntity, {operationKey: p.operationKey}).forUpdate(true).one()
    if (
        !operation ||
        operation.operationType !== "PaymentGatewayLookup" ||
        operation.userId !== ec.user.userId ||
        operation.resultId !== attempt.attemptId ||
        operation.organizationPartyId !== attempt.organizationPartyId
    )
        denied("OPERATION_KEY_CONFLICT", "The lookup key belongs to another operation")
    const original = one(PREVIEW, {previewId: attempt.previewId}),
        payload = original && json(original.payloadJson),
        result = Object.assign(gateway.resultFor(attempt), {
            attemptVersion: gateway.attemptVersion(attempt),
            operationKey: attempt.operationKey,
            paymentSummary: payload?.paymentSummary,
            gatewaySummary: payload?.gatewaySummary
        })
    update(operation, {status: "complete", completedDate: ec.user.nowTimestamp, resultJson: JSON.stringify(result)})
    return {attemptId: attempt.attemptId}
}
;({
    reserve,
    dispatch,
    prepareDispatch,
    lookup,
    record,
    claimLookup,
    finishLookup,
    freshRead,
    financialPlan,
    previewRecovery,
    complete,
    failCompletion,
    execute,
    refresh
})
