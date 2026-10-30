// Reviewed gateway identities and evidence remain protected when artifact authorization is disabled.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {lib} = workflow
const {find, one, map, denied, policy} = lib
const entities = {
    preview: "mantle.account.payment.PaymentGatewayPreview",
    instruction: "mantle.account.payment.PaymentGatewayInstruction",
    attempt: "mantle.account.payment.PaymentGatewayAttempt",
    reservation: "mantle.account.payment.PaymentGatewayReservation",
    response: "mantle.account.method.PaymentGatewayResponse",
    payment: workflow.P
}
const keys = {
    preview: "previewId",
    instruction: "instructionId",
    attempt: "attemptId",
    reservation: "reservationId",
    response: "paymentGatewayResponseId",
    payment: "paymentId"
}
const names = {
    preview: [
        "preview#PaymentGatewayAction",
        "preview#PaymentGatewayRecovery",
        "reserve#PaymentGatewayAction",
        "record#PaymentGatewayResult",
        "fail#PaymentGatewayCompletion",
        "complete#PaymentGatewayAttempt"
    ],
    instruction: ["reserve#PaymentGatewayAction", "record#PaymentGatewayResult", "complete#PaymentGatewayAttempt"],
    attempt: [
        "reserve#PaymentGatewayAction",
        "claim#PaymentGatewayLookup",
        "record#PaymentGatewayResult",
        "complete#PaymentGatewayAttempt",
        "fail#PaymentGatewayCompletion"
    ],
    reservation: ["reserve#PaymentGatewayAction", "record#PaymentGatewayResult", "complete#PaymentGatewayAttempt"],
    response: [
        "reserve#PaymentGatewayAction",
        "record#PaymentGatewayResult",
        "complete#PaymentGatewayAttempt",
        "fail#PaymentGatewayCompletion"
    ],
    payment: ["reserve#PaymentGatewayAction", "complete#PaymentGatewayAttempt"]
}
function stage() {
    const prefix = "mantle.account.PaymentServices."
    return ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => name.startsWith(prefix))
        ?.slice(prefix.length)
}
function same(field, left, right) {
    if (["amount", "authorizedAmount"].includes(field)) return toDecimal(left ?? 0).eq(right ?? 0)
    if (field === "accountingDate") return policy.calendarDateText(left) === policy.calendarDateText(right)
    if (field.endsWith("Date") || field.endsWith("Stamp")) return lib.ms(left) === lib.ms(right)
    return String(left ?? "") === String(right ?? "")
}
function immutable(before, after, fields) {
    for (const field of fields)
        if (!same(field, before[field], after[field]))
            denied("GATEWAY_RECORD_IMMUTABLE", "Gateway " + field + " cannot be changed")
}
function guard(p, kind) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const values = map(p.entityValue || p),
        key = keys[kind],
        entity = entities[kind]
    if (!entity) denied("GATEWAY_RECORD_INVALID", "Unknown gateway record")
    const original = values[key]
            ? find(entity, {[key]: values[key]})
                  .useCache(false)
                  .one()
            : null,
        before = original && map(original),
        after = Object.assign({}, before || {}, values),
        operation = p.eecaOperation
    if (
        kind === "payment" &&
        !before?.gatewayRole &&
        !after.gatewayRole &&
        !before?.gatewayInstructionId &&
        !after.gatewayInstructionId &&
        !before?.gatewayAttemptId &&
        !after.gatewayAttemptId
    )
        return
    if (kind === "response" && !before?.gatewayAttemptId && !after.gatewayAttemptId) {
        const payment = after.paymentId && one(workflow.P, {paymentId: after.paymentId})
        if (!payment?.gatewayRole) return
    }
    if (operation === "delete") denied("GATEWAY_RECORD_IMMUTABLE", "Gateway financial identities and evidence cannot be deleted")
    if (kind === "payment" && before?.gatewayRole) {
        immutable(before, after, ["gatewayInstructionId", "gatewayAttemptId", "gatewayRole"])
        immutable(before, after, [
            "paymentTypeEnumId",
            "paymentInstrumentEnumId",
            "fromPartyId",
            "toPartyId",
            "paymentMethodId",
            "toPaymentMethodId",
            "paymentGatewayConfigId",
            "amount",
            "amountUomId",
            "effectiveDate",
            "accountingDate",
            "financeOrganizationPartyId",
            "financeDirection",
            "forInvoiceId",
            "refundForPaymentId",
            "orderId",
            "orderPartSeqId",
            "orderItemSeqId",
            "finAccountId",
            "finAccountAuthId",
            "finAccountTransId",
            "paymentMethodFileId",
            "overrideOrgPartyId",
            "overrideGlAccountId"
        ])
        if (after.gatewayRole === "authorization" && ["PmntDelivered", "PmntConfirmed"].includes(after.statusId))
            denied("GATEWAY_PARENT_NOT_CASH", "An authorization instruction is not a cash payment")
        // The common lifecycle guard controls financial changes. Application totals and other nonfinancial metadata
        // still update through their normal EECAs without gaining permission to alter these immutable links.
        return
    }
    const service = stage()
    if (!names[kind].includes(service)) denied("GATEWAY_REVIEW_REQUIRED", "Use the reviewed gateway workflow")
    if (kind === "preview") {
        if (!before) {
            workflow.paymentScope({organizationPartyId: after.organizationPartyId, paymentId: after.paymentId}, true)
            if (
                after.userId !== ec.user.userId ||
                after.status !== "review" ||
                !["gatewayAction", "gatewayRecovery"].includes(after.previewKind)
            )
                denied("GATEWAY_PREVIEW_INVALID", "A gateway review must bind its real owner and payment")
        } else {
            immutable(
                before,
                after,
                Object.keys(after).filter(field => !["status", "operationKey", "resultJson", "lastUpdatedStamp"].includes(field))
            )
            if (before.operationKey && before.operationKey !== after.operationKey)
                denied("OPERATION_KEY_CONFLICT", "The gateway review already has a confirmation key")
            if (
                !(
                    {review: ["review", "submitted", "complete"], submitted: ["submitted", "complete"], complete: ["complete"]}[
                        before.status
                    ] || []
                ).includes(after.status)
            )
                denied("GATEWAY_STATE_INVALID", "The gateway review cannot move backwards")
        }
        return
    }
    if (kind === "payment") {
        if (before?.gatewayRole) immutable(before, after, ["gatewayInstructionId", "gatewayAttemptId", "gatewayRole"])
        const instruction = after.gatewayInstructionId && one(entities.instruction, {instructionId: after.gatewayInstructionId})
        if (
            !instruction ||
            instruction.organizationPartyId !== after.financeOrganizationPartyId ||
            after.lifecycleManaged !== "Y"
        )
            denied("GATEWAY_LINK_INVALID", "A gateway payment needs its authoritative instruction and organization")
        if (after.gatewayRole === "authorization") {
            if (
                instruction.paymentId !== after.paymentId ||
                after.gatewayAttemptId ||
                after.statusId === "PmntDelivered" ||
                after.statusId === "PmntConfirmed"
            )
                denied("GATEWAY_PARENT_NOT_CASH", "An authorization instruction is not a cash payment")
            if (!toDecimal(after.amount || 0).eq(instruction.authorizedAmount) || after.amountUomId !== instruction.currencyUomId)
                denied("GATEWAY_LINK_INVALID", "The authorization payment must match its instruction")
        } else if (after.gatewayRole === "capture") {
            const attempt = after.gatewayAttemptId && one(entities.attempt, {attemptId: after.gatewayAttemptId}),
                parent = instruction.paymentId && one(workflow.P, {paymentId: instruction.paymentId})
            if (
                service !== "complete#PaymentGatewayAttempt" ||
                !attempt ||
                attempt.providerState !== "accepted" ||
                attempt.action !== "capture" ||
                attempt.cashPaymentId !== after.paymentId ||
                attempt.instructionId !== instruction.instructionId ||
                !parent ||
                after.fromPartyId !== parent.fromPartyId ||
                after.toPartyId !== parent.toPartyId ||
                after.amountUomId !== attempt.currencyUomId ||
                !toDecimal(after.amount || 0).eq(attempt.amount) ||
                after.forInvoiceId ||
                after.refundForPaymentId
            )
                denied("GATEWAY_LINK_INVALID", "Only an accepted capture can create its exact cash leg")
        } else denied("GATEWAY_ACTION_UNAVAILABLE", "This gateway role is unavailable")
        return
    }
    const attempt =
        kind === "attempt"
            ? after
            : after.attemptId || after.gatewayAttemptId
              ? one(entities.attempt, {attemptId: after.attemptId || after.gatewayAttemptId})
              : null
    if (kind === "instruction") {
        const payment = one(workflow.P, {paymentId: after.paymentId})
        if (
            !payment ||
            after.currencyUomId !== payment.amountUomId ||
            !toDecimal(after.authorizedAmount || 0).eq(payment.amount || 0) ||
            ![payment.fromPartyId, payment.toPartyId].includes(after.organizationPartyId)
        )
            denied("GATEWAY_LINK_INVALID", "An instruction must bind its actual payment")
        if (before)
            immutable(
                before,
                after,
                Object.keys(after).filter(field => !["state", "authorizationAttemptId", "lastUpdatedStamp"].includes(field))
            )
        return
    }
    if (
        !attempt ||
        !attempt.organizationPartyId ||
        !attempt.paymentId ||
        !["authorize", "capture", "release"].includes(attempt.action)
    )
        denied("GATEWAY_LINK_INVALID", "Gateway evidence needs its native attempt")
    if (kind === "attempt") {
        if (before) {
            const mutable = [
                "providerReference",
                "providerState",
                "financialState",
                "responseCode",
                "reasonCode",
                "errorMessage",
                "providerDate",
                "providerSettlementDate",
                "receiptJson",
                "dispatchToken",
                "leaseExpiresDate",
                "lookupToken",
                "lookupLeaseExpiresDate",
                "dispatchCount",
                "lookupCount",
                "dispatchedDate",
                "completedDate",
                "resultJson",
                "lastUpdatedStamp"
            ]
            immutable(
                before,
                after,
                Object.keys(after).filter(field => !mutable.includes(field))
            )
            if (before.providerState === "accepted")
                immutable(before, after, [
                    "providerState",
                    "receiptJson",
                    "providerReference",
                    "providerDate",
                    "providerSettlementDate"
                ])
            if (before.providerState === "declined" && after.providerState !== "declined")
                denied("GATEWAY_STATE_INVALID", "A definitive declined operation cannot become accepted")
            if (before.financialState === "completed") immutable(before, after, ["financialState", "completedDate", "resultJson"])
        }
        if (
            toDecimal(after.amount || 0).compare(0) <= 0 ||
            !after.currencyUomId ||
            !after.providerOperationId ||
            !after.merchantNamespace ||
            !after.requestHash
        )
            denied("GATEWAY_ATTEMPT_INVALID", "Gateway money and provider identity are required")
        if (
            !["reserved", "dispatched", "pending", "uncertain", "declined", "accepted", "quarantined"].includes(
                after.providerState
            ) ||
            !["none", "accepted_unposted", "completed"].includes(after.financialState)
        )
            denied("GATEWAY_STATE_INVALID", "Unknown gateway outcome")
        if (after.financialState === "completed" && after.providerState !== "accepted")
            denied("GATEWAY_STATE_INVALID", "Only accepted provider work can complete financially")
        return
    }
    if (kind === "reservation") {
        if (
            attempt.organizationPartyId !== after.organizationPartyId ||
            attempt.currencyUomId !== after.currencyUomId ||
            !toDecimal(after.amount || 0).eq(attempt.amount) ||
            after.instructionId !== attempt.instructionId ||
            !["authorization", "capture", "release", "cash"].includes(after.holdKind)
        )
            denied("GATEWAY_HOLD_INVALID", "A hold must match its exact gateway attempt")
        if (before) {
            immutable(
                before,
                after,
                Object.keys(after).filter(field => !["status", "consumedDate", "lastUpdatedStamp"].includes(field))
            )
            if (before.status !== "held" && after.status !== before.status)
                denied("GATEWAY_HOLD_IMMUTABLE", "A completed hold cannot be reused")
        }
        if (
            !["held", "consumed", "released"].includes(after.status) ||
            (after.status === "released" && attempt.providerState !== "declined") ||
            (after.status === "consumed" &&
                (attempt.providerState !== "accepted" || service !== "complete#PaymentGatewayAttempt"))
        )
            denied("GATEWAY_HOLD_INVALID", "A hold requires authoritative decline or accepted financial completion")
        return
    }
    if (
        after.paymentId !== attempt.paymentId ||
        after.paymentGatewayResponseId !== attempt.paymentGatewayResponseId ||
        after.paymentGatewayConfigId !== attempt.paymentGatewayConfigId ||
        after.amountUomId !== attempt.currencyUomId ||
        !toDecimal(after.amount || 0).eq(attempt.amount)
    )
        denied("GATEWAY_RESPONSE_INVALID", "Gateway response identity must match its exact attempt")
}
;({guard, stage})
