// Reviewed provider instructions are distinct from their accepted cash legs. Provider I/O never posts local money.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const lifecycle = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentLifecycle.js")
const settlement = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentSettlement.js")
const {lib, P} = workflow
const {find, one, rows, call, map, hash, denied, policy} = lib
const PREVIEW = "mantle.account.payment.PaymentGatewayPreview",
    INSTRUCTION = "mantle.account.payment.PaymentGatewayInstruction",
    ATTEMPT = "mantle.account.payment.PaymentGatewayAttempt",
    RESERVATION = "mantle.account.payment.PaymentGatewayReservation",
    RESPONSE = "mantle.account.method.PaymentGatewayResponse",
    CONFIG = "mantle.account.method.PaymentGatewayConfig",
    BINDING = "mantle.account.method.PaymentGatewayOrganization"
const actions = ["authorize", "capture", "release"]
const operationEnums = {authorize: "PgoAuthorize", capture: "PgoCapture", release: "PgoRelease", refund: "PgoRefund"}
const pageFields = ["recordCount", "pageIndex", "pageSize", "pageMaxIndex", "pageRangeLow", "pageRangeHigh"]
const configFields = [
    "paymentGatewayConfigId",
    "reviewedOperationServiceName",
    "reviewedLookupServiceName",
    "reviewedAdapterVersion",
    "reviewedMerchantNamespace",
    "reviewedGuaranteesJson"
]
function set(record, fields) {
    for (const [field, value] of Object.entries(fields)) record.set(field, value)
    record.update()
}
function json(value, reason = "GATEWAY_EVIDENCE_UNAVAILABLE") {
    try {
        return JSON.parse(value || "{}")
    } catch (_) {
        denied(reason, "The gateway evidence is unavailable")
    }
}
function scopeFor(p, write = false, lock = false, adopted = false) {
    const scope = workflow.paymentScope(p, write, lock)
    if (!scope.broad || !(lib.has("PAYMENT_EDIT") || lib.has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()))
        denied("PERMISSION_DENIED", "Treasury authority is required for provider records")
    if (write && !lib.has("PAYMENT_EDIT")) denied("PERMISSION_DENIED", "Payment editing authority is required")
    scope.gatewayEnabled = policy.preference(scope.organizationPartyId).paymentGatewayWorkflowEnabled === "Y"
    if (adopted && !scope.guardEnabled) denied("SETTLEMENT_GUARD_REQUIRED", "Enable settlement application controls")
    if (adopted && !scope.gatewayEnabled) denied("GATEWAY_WORKFLOW_REQUIRED", "Enable the reviewed gateway workflow")
    if (scope.tradeExcluded || scope.record.refundForPaymentId || scope.record.paymentTypeEnumId !== "PtInvoicePayment")
        denied("GATEWAY_PAYMENT_UNAVAILABLE", "This payment is not an eligible trade gateway payment")
    return scope
}
function financialSource(record) {
    const fields = [
        "paymentId",
        "fromPartyId",
        "toPartyId",
        "paymentTypeEnumId",
        "paymentInstrumentEnumId",
        "paymentMethodId",
        "toPaymentMethodId",
        "amountUomId",
        "forInvoiceId",
        "refundForPaymentId",
        "orderId",
        "orderPartSeqId",
        "orderItemSeqId",
        "finAccountId",
        "finAccountAuthId",
        "finAccountTransId",
        "paymentMethodFileId",
        "financeOrganizationPartyId",
        "financeDirection",
        "overrideOrgPartyId",
        "overrideGlAccountId",
        "paymentGatewayConfigId",
        "paymentRefNum",
        "comments"
    ]
    return hash({
        header: Object.fromEntries(fields.map(field => [field, record[field] ?? null])),
        amount: String(ec.l10n.roundCurrency(toDecimal(record.amount || 0), record.amountUomId)),
        effectiveDate: lib.ms(record.effectiveDate),
        accountingDate: policy.calendarDateText(record.accountingDate)
    })
}
function instructionFor(record, lock = false) {
    let query = record.gatewayInstructionId
        ? find(INSTRUCTION, {instructionId: record.gatewayInstructionId})
        : find(INSTRUCTION, {paymentId: record.paymentId})
    const instruction = query.forUpdate(lock).useCache(false).one()
    if (instruction && instruction.paymentId !== record.paymentId && record.gatewayRole !== "capture")
        denied("GATEWAY_LINK_INVALID", "The gateway instruction belongs to another payment")
    return instruction
}
function instructionSummary(instruction) {
    if (!instruction) return null
    const totals = rows("mantle.account.payment.PaymentGatewayInstructionTotals", {instructionId: instruction.instructionId}),
        holds = rows("mantle.account.payment.PaymentGatewayInstructionHolds", {instructionId: instruction.instructionId}),
        sum = (action, completed) =>
            totals
                .filter(
                    row =>
                        row.action === action &&
                        row.providerState === "accepted" &&
                        (!completed || row.financialState === "completed")
                )
                .reduce((out, row) => out.add(row.totalAmount || 0), toDecimal(0)),
        held = kind =>
            holds
                .filter(row => row.holdKind === kind && row.status === "held")
                .reduce((out, row) => out.add(row.totalAmount || 0), toDecimal(0)),
        authorization = instruction.authorizationAttemptId && one(ATTEMPT, {attemptId: instruction.authorizationAttemptId}),
        authorizedAmount = authorization?.providerState === "accepted" ? toDecimal(instruction.authorizedAmount) : toDecimal(0),
        capturedAmount = sum("capture", true),
        captureHeldAmount = held("capture"),
        releasedAmount = sum("release", true),
        capturableAmount = authorizedAmount.subtract(capturedAmount).subtract(captureHeldAmount).subtract(releasedAmount),
        evidence = {
            instruction: policy.pick(map(instruction), [
                "instructionId",
                "paymentId",
                "organizationPartyId",
                "currencyUomId",
                "authorizedAmount",
                "state",
                "authorizationAttemptId"
            ]),
            totals: totals.map(map).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
            holds: holds.map(map).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        }
    if (capturableAmount.compare(0) < 0) denied("GATEWAY_CAPACITY_INCONSISTENT", "Gateway capacity evidence is inconsistent")
    return {
        instructionId: instruction.instructionId,
        authorizationAttemptId: instruction.authorizationAttemptId,
        paymentId: instruction.paymentId,
        state: instruction.state,
        currencyUomId: instruction.currencyUomId,
        authorizedAmount: String(authorizedAmount),
        capturedAmount: String(capturedAmount),
        providerCapturedAmount: String(sum("capture", false)),
        captureHeldAmount: String(captureHeldAmount),
        authorizationHeldAmount: String(held("authorization")),
        releaseHeldAmount: String(held("release")),
        releasedAmount: String(releasedAmount),
        capturableAmount: String(capturableAmount),
        authorizationCompleted: authorization?.providerState === "accepted" && authorization?.financialState === "completed",
        version: hash(evidence)
    }
}
function guarantees(config) {
    const declared = json(config.reviewedGuaranteesJson, "GATEWAY_ADAPTER_UNSUPPORTED")
    if (
        !config.reviewedOperationServiceName ||
        !config.reviewedLookupServiceName ||
        !config.reviewedAdapterVersion ||
        !config.reviewedMerchantNamespace
    )
        denied("GATEWAY_ADAPTER_UNSUPPORTED", "The gateway has no provisioned reviewed adapter")
    return Object.fromEntries(
        actions.map(action => {
            const value = declared[action] || {}
            return [
                action,
                {
                    enabled: value.enabled === true,
                    idempotent: value.idempotent === true,
                    exactLookup: value.exactLookup === true,
                    reviewedMethodSnapshot: value.reviewedMethodSnapshot === true,
                    partialCapture: value.partialCapture === true,
                    releaseRemaining: value.releaseRemaining === true
                }
            ]
        })
    )
}
function bindingEvidence(scope, id, methods, date, lock = false) {
    if (!id) denied("GATEWAY_BINDING_REQUIRED", "Choose an approved gateway")
    const binding = find(BINDING, {organizationPartyId: scope.organizationPartyId, paymentGatewayConfigId: id})
            .forUpdate(lock)
            .one(),
        config = find(CONFIG, {paymentGatewayConfigId: id}).forUpdate(lock).one()
    if (!binding || !config || binding.isEnabled !== "Y" || !policy.active(binding, date))
        denied("GATEWAY_BINDING_UNAVAILABLE", "The gateway is not enabled for this organization and date")
    const declared = guarantees(config),
        version = hash({
            organization: policy.pick(map(binding), [
                "organizationPartyId",
                "paymentGatewayConfigId",
                "fromDate",
                "thruDate",
                "isEnabled"
            ]),
            configuration: policy.pick(map(config), configFields),
            methods: methods.versions
        })
    return {binding, config, declared, version}
}
function methodEvidence(scope, date, lock = false) {
    const request = Object.assign(lifecycle.methodRequest(scope), {currencyUomId: scope.record.amountUomId})
    return Object.assign(lifecycle.methodEvidence(scope, request, date, lock), {request})
}
function defaultGateway(scope, methods, instruction = null) {
    return (
        instruction?.paymentGatewayConfigId ||
        scope.record.paymentGatewayConfigId ||
        methods.counterpartyMethod?.paymentGatewayConfigId ||
        methods.organizationMethod?.paymentGatewayConfigId ||
        null
    )
}
function assertAction(binding, action, partial = false) {
    const value = binding.declared[action]
    if (
        !value?.enabled ||
        !value.reviewedMethodSnapshot ||
        !value.exactLookup ||
        (!value.idempotent && !value.exactLookup) ||
        (partial && !value.partialCapture) ||
        (action === "release" && !value.releaseRemaining)
    )
        denied("GATEWAY_ADAPTER_UNSUPPORTED", "The reviewed adapter does not guarantee this operation")
}
function persistedEligibility(scope, methods = null) {
    const r = scope.record
    if (
        r.gatewayRole ||
        r.gatewayInstructionId ||
        r.paymentGatewayConfigId ||
        !workflow.manualInstruments.includes(r.paymentInstrumentEnumId)
    )
        return true
    const records = methods
        ? [methods.organizationMethod, methods.counterpartyMethod].filter(Boolean)
        : Array.from(
              find("mantle.account.method.PaymentMethod")
                  .condition("paymentMethodId", "in", [r.paymentMethodId, r.toPaymentMethodId].filter(Boolean))
                  .list()
          )
    return records.some(record => Boolean(record.paymentGatewayConfigId))
}
function findBindings(p) {
    const scope = scopeFor(p, true),
        date = settlement.dateInput(p.effectiveDate || scope.record.effectiveDate),
        methods = methodEvidence(scope, date.timestamp),
        cf = ec.entity.conditionFactory,
        ids = [...new Set(Array.from(p.selectedIdList || []).map(String))]
    if (ids.length > 200) denied("GATEWAY_SELECTION_LIMIT", "Select at most two hundred gateway bindings")
    function q(search = true) {
        let query = find("mantle.account.method.PaymentGatewayBindingRead", {
            organizationPartyId: scope.organizationPartyId,
            isEnabled: "Y"
        })
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("fromDate", "is-null", null),
                        cf.makeCondition("fromDate", "less-equals", new Date(date.timestamp).toISOString())
                    ],
                    "or"
                )
            )
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("thruDate", "is-null", null),
                        cf.makeCondition("thruDate", "greater", new Date(date.timestamp).toISOString())
                    ],
                    "or"
                )
            )
        if (search && String(p.text || "").trim())
            query = query.condition(
                cf.makeCondition(
                    ["paymentGatewayConfigId", "description"].map(field =>
                        cf.makeCondition(field, "like", "%" + String(p.text).trim().slice(0, 200) + "%").ignoreCase()
                    ),
                    "or"
                )
            )
        return query
    }
    if (!actions.includes(p.action || "authorize")) denied("GATEWAY_ACTION_UNAVAILABLE", "Choose a gateway action")
    if (!persistedEligibility(scope, methods))
        denied("GATEWAY_PAYMENT_INELIGIBLE", "The payment has no persisted gateway instrument or method binding")
    const errors = []
    function project(row) {
        const base = {
            paymentGatewayConfigId: row.paymentGatewayConfigId,
            description: row.description,
            adapterVersion: row.reviewedAdapterVersion,
            capabilities: {canAuthorize: false, canCapture: false, canRelease: false, canRefund: false, canLookup: false},
            reasons: []
        }
        try {
            const evidence = bindingEvidence(scope, row.paymentGatewayConfigId, methods, date.timestamp)
            base.bindingVersion = evidence.version
            for (const action of actions) {
                const declaration = evidence.declared[action]
                base.capabilities["can" + action[0].toUpperCase() + action.slice(1)] =
                    declaration.enabled &&
                    declaration.reviewedMethodSnapshot &&
                    declaration.exactLookup &&
                    scope.guardEnabled &&
                    scope.gatewayEnabled &&
                    (action !== "release" || declaration.releaseRemaining)
            }
            base.capabilities.canLookup = actions.some(
                action => evidence.declared[action].enabled && evidence.declared[action].exactLookup
            )
        } catch (error) {
            const code = String(error.message).split(":")[0]
            if (code === "GATEWAY_ADAPTER_UNSUPPORTED" || code === "GATEWAY_BINDING_UNAVAILABLE") base.reasons.push(code)
            else {
                ec.logger.error("Gateway binding " + row.paymentGatewayConfigId + ": " + error.message)
                errors.push({paymentGatewayConfigId: row.paymentGatewayConfigId, reasonCode: "GATEWAY_BINDING_READ_FAILED"})
                base.reasons.push("GATEWAY_BINDING_READ_FAILED")
            }
        }
        return base
    }
    // Organization gateway configurations are a small provisioning list. Check declared action eligibility before
    // count and pagination; never hide a supported gateway behind a page of unsupported legacy configurations.
    const actionKey = "can" + (p.action || "authorize")[0].toUpperCase() + (p.action || "authorize").slice(1),
        eligible = Array.from(q().orderBy("description,paymentGatewayConfigId").list())
            .map(project)
            .filter(row => row.capabilities[actionKey]),
        count = eligible.length,
        pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 20)),
        pageMaxIndex = Math.max(0, Math.ceil(count / pageSize) - 1),
        pageIndex = Math.min(pageMaxIndex, Math.max(0, Number(p.pageIndex) || 0))
    return {
        rows: eligible.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        recordCount: count,
        pageSize,
        pageIndex,
        pageMaxIndex,
        pageRangeLow: count ? pageIndex * pageSize + 1 : 0,
        pageRangeHigh: Math.min(count, (pageIndex + 1) * pageSize),
        selectedRows: ids.length ? Array.from(q(false).condition("paymentGatewayConfigId", "in", ids).list()).map(project) : [],
        complete: !errors.length,
        errors
    }
}
function amount(value, currency) {
    let out
    try {
        out = toDecimal(value)
    } catch (_) {
        denied("AMOUNT_INVALID", "Enter a positive gateway amount")
    }
    if (!out || out.compare(0) <= 0) denied("AMOUNT_INVALID", "Enter a positive gateway amount")
    if (!out.eq(ec.l10n.roundCurrency(out, currency)))
        denied("CURRENCY_PRECISION", "The gateway amount exceeds currency precision")
    return out
}
function capabilities(scope) {
    const available = Boolean(
            scope.record &&
                scope.record.lifecycleManaged === "Y" &&
                scope.broad &&
                lib.has("PAYMENT_EDIT") &&
                scope.guardEnabled &&
                policy.preference(scope.organizationPartyId).paymentGatewayWorkflowEnabled === "Y" &&
                !scope.tradeExcluded &&
                !scope.record.refundForPaymentId &&
                scope.record.paymentTypeEnumId === "PtInvoicePayment"
        ),
        out = {
            canGatewayAuthorize: false,
            canGatewayCapture: false,
            canGatewayRelease: false,
            canGatewayRefund: false,
            canGatewayRefresh: false,
            canGatewayRecover: false,
            canReadLedger: workflow.ledgerRead(),
            gatewayReasons: []
        }
    if (!available) {
        if (!scope.broad || !lib.has("PAYMENT_EDIT")) out.gatewayReasons.push("PERMISSION_DENIED")
        else if (!scope.guardEnabled) out.gatewayReasons.push("SETTLEMENT_GUARD_REQUIRED")
        else if (policy.preference(scope.organizationPartyId).paymentGatewayWorkflowEnabled !== "Y")
            out.gatewayReasons.push("GATEWAY_WORKFLOW_REQUIRED")
        else if (scope.record?.lifecycleManaged !== "Y") out.gatewayReasons.push("GATEWAY_DRAFT_REQUIRED")
        else out.gatewayReasons.push("GATEWAY_PAYMENT_UNAVAILABLE")
        return out
    }
    if (!persistedEligibility(scope)) {
        out.gatewayReasons.push("GATEWAY_PAYMENT_INELIGIBLE")
        return out
    }
    const instruction = instructionFor(scope.record),
        summary = instructionSummary(instruction),
        parent = !scope.record.gatewayRole || scope.record.gatewayRole === "authorization"
    let declared = null
    try {
        const date = settlement.dateInput(
                scope.record.effectiveDate,
                scope.record.accountingDate ? policy.calendarDateText(scope.record.accountingDate) : null
            ),
            methods = methodEvidence(scope, date.timestamp),
            gatewayId = defaultGateway(scope, methods, instruction)
        let binding = null,
            defaultError = null
        if (gatewayId)
            try {
                binding = bindingEvidence(scope, gatewayId, methods, date.timestamp)
            } catch (error) {
                if (instruction) throw error
                defaultError = error
            }
        if (
            !instruction &&
            (!binding?.declared.authorize.enabled ||
                !binding?.declared.authorize.reviewedMethodSnapshot ||
                !binding?.declared.authorize.exactLookup)
        ) {
            const selectable = findBindings({
                organizationPartyId: scope.organizationPartyId,
                paymentId: scope.record.paymentId,
                action: "authorize",
                effectiveDate: date.timestamp,
                pageSize: 1
            })
            if (selectable.rows[0])
                binding = bindingEvidence(scope, selectable.rows[0].paymentGatewayConfigId, methods, date.timestamp)
        }
        if (!binding) {
            if (defaultError) throw defaultError
            denied("GATEWAY_BINDING_REQUIRED", "Choose an approved gateway")
        }
        declared = binding.declared
        if (actions.some(action => declared[action].enabled && !declared[action].reviewedMethodSnapshot))
            out.gatewayReasons.push("GATEWAY_ADAPTER_UNSUPPORTED")
        if (
            !actions.some(
                action => declared[action].enabled && declared[action].reviewedMethodSnapshot && declared[action].exactLookup
            )
        )
            if (!out.gatewayReasons.includes("GATEWAY_ADAPTER_UNSUPPORTED"))
                out.gatewayReasons.push("GATEWAY_ADAPTER_UNSUPPORTED")
    } catch (error) {
        const code = String(error.message).split(":")[0]
        out.gatewayReasons.push(code)
        if (!/^(GATEWAY_|PAYMENT_METHOD_|STALE_PAYMENT_METHOD|CURRENCY_MISMATCH|EFFECTIVE_DATE_REQUIRED|DATE_INVALID)/.test(code))
            ec.logger.error("Payment " + scope.record.paymentId + " gateway capability: " + error.message)
    }
    out.canGatewayAuthorize =
        Boolean(declared?.authorize.enabled && declared?.authorize.reviewedMethodSnapshot && declared?.authorize.exactLookup) &&
        parent &&
        !scope.hasPriorFinancialHistory &&
        !find(RESPONSE, {paymentId: scope.record.paymentId}).condition("gatewayAttemptId", "is-null", null).limit(1).one() &&
        ["PmntProposed", "PmntPromised"].includes(scope.record.statusId) &&
        (!summary || (toDecimal(summary.authorizationHeldAmount).isZero() && toDecimal(summary.authorizedAmount).isZero()))
    out.canGatewayCapture =
        Boolean(declared?.capture.enabled && declared?.capture.reviewedMethodSnapshot && declared?.capture.exactLookup) &&
        Boolean(
            declared?.capture.partialCapture || (summary && toDecimal(summary.capturableAmount).eq(instruction.authorizedAmount))
        ) &&
        parent &&
        Boolean(summary?.authorizationCompleted) &&
        toDecimal(summary?.capturableAmount || 0).compare(0) > 0 &&
        toDecimal(summary?.releaseHeldAmount || 0).isZero()
    out.canGatewayRelease =
        Boolean(
            declared?.release.enabled &&
                declared?.release.reviewedMethodSnapshot &&
                declared?.release.exactLookup &&
                declared?.release.releaseRemaining
        ) &&
        parent &&
        Boolean(summary?.authorizationCompleted) &&
        toDecimal(summary?.capturableAmount || 0).compare(0) > 0 &&
        toDecimal(summary?.captureHeldAmount || 0).isZero() &&
        toDecimal(summary?.releaseHeldAmount || 0).isZero()
    if (instruction) {
        out.canGatewayRefresh = Boolean(
            find(ATTEMPT, {instructionId: instruction.instructionId})
                .condition("providerState", "in", ["reserved", "dispatched", "pending", "uncertain", "quarantined"])
                .condition(
                    ec.entity.conditionFactory.makeCondition(
                        [
                            ec.entity.conditionFactory.makeCondition("leaseExpiresDate", "is-null", null),
                            ec.entity.conditionFactory.makeCondition(
                                "leaseExpiresDate",
                                "less-equals",
                                new Date(Number(ec.user.nowTimestamp)).toISOString()
                            )
                        ],
                        "or"
                    )
                )
                .condition(
                    ec.entity.conditionFactory.makeCondition(
                        [
                            ec.entity.conditionFactory.makeCondition("lookupLeaseExpiresDate", "is-null", null),
                            ec.entity.conditionFactory.makeCondition(
                                "lookupLeaseExpiresDate",
                                "less-equals",
                                new Date(Number(ec.user.nowTimestamp)).toISOString()
                            )
                        ],
                        "or"
                    )
                )
                .limit(1)
                .one()
        )
        out.canGatewayRecover = Boolean(
            find(ATTEMPT, {
                instructionId: instruction.instructionId,
                providerState: "accepted",
                financialState: "accepted_unposted"
            })
                .limit(1)
                .one()
        )
    }
    return out
}
function plannedCapacity(summary, action, requested, currency) {
    const captured = toDecimal(summary?.capturedAmount || 0).add(action === "capture" ? requested : 0),
        held = toDecimal(summary?.captureHeldAmount || 0),
        released = toDecimal(summary?.releasedAmount || 0).add(action === "release" ? requested : 0),
        authorized = action === "authorize" ? requested : toDecimal(summary?.authorizedAmount || 0),
        remaining = authorized.subtract(captured).subtract(held).subtract(released)
    return {
        state:
            action === "authorize"
                ? "authorized"
                : action === "release"
                  ? "released"
                  : remaining.isZero() && held.isZero()
                    ? "captured"
                    : "partiallyCaptured",
        authorizedAmount: String(authorized),
        capturedAmount: String(captured),
        captureHeldAmount: String(held),
        releasedAmount: String(released),
        capturableAmount: String(remaining),
        currencyUomId: currency,
        assumption: "providerAcceptedAndLocalCompleted"
    }
}
function normalized(p, lock = false) {
    const scope = scopeFor(p, true, lock, true),
        r = scope.record,
        action = p.action
    if (r.lifecycleManaged !== "Y") denied("GATEWAY_DRAFT_REQUIRED", "Create a reviewed payment draft before using a gateway")
    if (!actions.includes(action)) denied("GATEWAY_ACTION_UNAVAILABLE", "This gateway action is not available")
    if (!p.sourceVersion || workflow.paymentVersion(r) !== p.sourceVersion)
        denied("STALE_REVISION", "The payment changed; review it again")
    if (r.gatewayRole && r.gatewayRole !== "authorization")
        denied("GATEWAY_PARENT_REQUIRED", "Use the authorization instruction for capture or release")
    if (
        workflow.paymentApplications([r.paymentId]).length ||
        find("mantle.ledger.transaction.AcctgTrans", {paymentId: r.paymentId}).limit(1).one()
    )
        denied("GATEWAY_PARENT_NOT_CASH", "An authorization parent must have no local cash or applications")
    if (r.forInvoiceId)
        denied("INVOICE_APPLICATION_REVIEW_REQUIRED", "Gateway capture and invoice settlement are separate reviews")
    if (find(RESPONSE, {paymentId: r.paymentId}).condition("gatewayAttemptId", "is-null", null).limit(1).one())
        denied("GATEWAY_LEGACY_HISTORY", "An existing legacy provider instruction needs its existing workflow")
    const date = settlement.dateInput(p.effectiveDate, p._accountingDay || null),
        sourceDay = r.accountingDate ? policy.calendarDateText(r.accountingDate) : ec.l10n.format(r.effectiveDate, "yyyy-MM-dd")
    if (date.day < sourceDay) denied("GATEWAY_BEFORE_PAYMENT", "The gateway day cannot precede the payment day")
    const instruction = instructionFor(r, lock),
        summary = instructionSummary(instruction),
        methods = methodEvidence(scope, date.timestamp, lock),
        gatewayId = p.paymentGatewayConfigId || defaultGateway(scope, methods, instruction),
        binding = bindingEvidence(scope, gatewayId, methods, date.timestamp, lock)
    if (!persistedEligibility(scope, methods))
        denied("GATEWAY_PAYMENT_INELIGIBLE", "The payment has no persisted gateway instrument or method binding")
    if (p.paymentGatewayConfigId && (!p.gatewayBindingVersion || p.gatewayBindingVersion !== binding.version))
        denied("STALE_GATEWAY_BINDING", "Review the chosen gateway binding again")
    if (
        instruction &&
        (gatewayId !== instruction.paymentGatewayConfigId ||
            binding.config.reviewedAdapterVersion !== instruction.adapterVersion ||
            binding.config.reviewedMerchantNamespace !== instruction.merchantNamespace)
    )
        denied("GATEWAY_BINDING_CHANGED", "The original gateway adapter or merchant identity changed")
    let requested
    if (action === "authorize") {
        if (
            !["PmntProposed", "PmntPromised"].includes(r.statusId) ||
            (summary && (!toDecimal(summary.authorizationHeldAmount).isZero() || !toDecimal(summary.authorizedAmount).isZero()))
        )
            denied("GATEWAY_STATE_INVALID", "The payment already has an authorization or unresolved request")
        requested = amount(r.amount, r.amountUomId)
        if (p.amount != null && !amount(p.amount, r.amountUomId).eq(requested))
            denied("GATEWAY_AMOUNT_INVALID", "Authorization must review the exact parent amount")
    } else {
        if (!summary?.authorizationCompleted || r.statusId !== "PmntAuthorized")
            denied("GATEWAY_STATE_INVALID", "A completed authorization is required")
        if (p.parentAttemptId && p.parentAttemptId !== instruction.authorizationAttemptId)
            denied("GATEWAY_PARENT_MISMATCH", "Use the original authorization attempt")
        if (!toDecimal(summary.releaseHeldAmount).isZero()) denied("GATEWAY_CAPACITY_RESERVED", "A release is already unresolved")
        if (action === "release" && !toDecimal(summary.captureHeldAmount).isZero())
            denied("GATEWAY_CAPACITY_RESERVED", "Resolve pending captures before releasing authorization")
        requested = action === "release" ? amount(summary.capturableAmount, r.amountUomId) : amount(p.amount, r.amountUomId)
        if (action === "release" && p.amount != null && !amount(p.amount, r.amountUomId).eq(requested))
            denied("GATEWAY_AMOUNT_INVALID", "Release must review the exact remaining authorization")
        if (requested.compare(summary.capturableAmount) > 0)
            denied("GATEWAY_CAPACITY_EXCEEDED", "The amount exceeds unreserved authorization")
    }
    assertAction(binding, action, action === "capture" && requested.compare(instruction.authorizedAmount) < 0)
    const reason = String(p.reason || "").trim(),
        referenceNumber = String(p.referenceNumber || "").trim()
    if (!reason || reason.length > 4000 || referenceNumber.length > 60)
        denied("GATEWAY_REASON_REQUIRED", "Enter a reason and a valid reference")
    const evidence = lifecycle.selectedEvidence(scope, p, lock),
        plannedScope = Object.assign({}, scope, {
            record: Object.assign(map(r), {amount: requested, effectiveDate: date.timestamp, accountingDate: date.day})
        }),
        plans = action === "capture" ? [lifecycle.cashPlan(plannedScope, methods)] : [],
        policyEvidence = settlement.validatePolicy(
            {
                organizationPartyId: scope.organizationPartyId,
                partyId: scope.partyId,
                direction: scope.financeDirection,
                currencyUomId: r.amountUomId
            },
            date,
            plans,
            lock
        ),
        names = lib.partyNames([scope.organizationPartyId, scope.partyId]),
        paymentSummary = {
            paymentId: r.paymentId,
            amount: String(requested),
            currencyUomId: r.amountUomId,
            organizationName: names[scope.organizationPartyId],
            partyId: scope.partyId,
            partyName: names[scope.partyId],
            cashDirection: scope.cashDirection,
            accountingDateText: date.day,
            maskedMethodLabel: workflow.methodRows([methods.organizationMethod])[0].label,
            referenceNumber
        },
        request = {
            organizationPartyId: scope.organizationPartyId,
            paymentId: r.paymentId,
            sourceVersion: p.sourceVersion,
            action,
            amount: String(requested),
            effectiveDate: date.timestamp,
            _accountingDay: date.day,
            _methods: methods.request,
            _policyEvidence: policyEvidence,
            _plans: plans,
            _financialSourceHash: financialSource(r),
            paymentGatewayConfigId: gatewayId,
            gatewayBindingVersion: binding.version,
            parentAttemptId: instruction?.authorizationAttemptId || null,
            referenceNumber,
            reason,
            evidenceContentIdList: evidence.map(file => file.manifest.paymentContentId),
            evidenceVersions: Object.fromEntries(evidence.map(file => [file.manifest.paymentContentId, file.manifest.version]))
        },
        payload = {
            organizationPartyId: scope.organizationPartyId,
            paymentId: r.paymentId,
            previewKind: "gatewayAction",
            action,
            financialOnly: false,
            paymentSummary,
            gatewaySummary: {
                paymentGatewayConfigId: gatewayId,
                description: binding.config.description,
                adapterVersion: binding.config.reviewedAdapterVersion,
                action,
                amount: String(requested),
                currencyUomId: r.amountUomId,
                accountingDateText: date.day,
                instruction: summary
            },
            before: summary || {
                state: "proposed",
                currencyUomId: r.amountUomId,
                authorizedAmount: "0",
                capturedAmount: "0",
                captureHeldAmount: "0",
                releasedAmount: "0",
                capturableAmount: "0"
            },
            after: plannedCapacity(summary, action, requested, r.amountUomId),
            reservationEffects: [
                {
                    sourceKind: "authorization",
                    sourceId: instruction?.instructionId || r.paymentId,
                    amount: String(requested),
                    currencyUomId: r.amountUomId,
                    status: "held",
                    holdKind: action === "authorize" ? "authorization" : action
                }
            ],
            applicationEffects: [],
            postingSummary: {
                cashPostingCount: plans.length,
                applicationPostingCount: 0,
                effect:
                    action === "capture"
                        ? "One separate cash payment and cash transaction after provider acceptance"
                        : "No cash posting"
            },
            ledgerPreview: plans,
            evidenceRows: evidence.map(file => file.manifest),
            capabilities: capabilities(scope),
            blockers: [],
            canApply: true,
            effectiveDateText: date.day,
            reason,
            referenceNumber
        },
        fingerprint = hash({
            request,
            source: financialSource(r),
            instruction: summary?.version || null,
            methods: methods.request,
            binding: binding.version,
            policy: policyEvidence,
            plans,
            evidence: payload.evidenceRows
        })
    return {scope, request, payload, date, methods, instruction, summary, binding, policyEvidence, plans, evidence, fingerprint}
}
function projectResult(result, scope) {
    const out = Object.assign({}, result)
    if (!workflow.ledgerRead())
        for (const field of ["acctgTransIds", "originalAcctgTransIds", "reversalAcctgTransIds"]) delete out[field]
    if (out.outputRows)
        out.outputRows = out.outputRows.map(row => {
            const child = workflow.paymentScope({organizationPartyId: scope.organizationPartyId, paymentId: row.paymentId}),
                available = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js").available(child)
            return Object.assign({}, row, {
                canOpen: Boolean(
                    available[
                        row.outputType === "receipt"
                            ? "canPrintReceipt"
                            : row.outputType === "detail"
                              ? "canPrintDetail"
                              : "canPrintCheck"
                    ]
                )
            })
        })
    return out
}
function projectPreview(row, scope) {
    const payload = json(row.payloadJson),
        out = Object.assign({}, payload, {
            previewId: row.previewId,
            inputFingerprint: row.inputFingerprint,
            previewKind: row.previewKind,
            financialOnly: row.previewKind === "gatewayRecovery",
            sourceVersion: row.sourceVersion,
            attemptVersion: row.attemptVersion,
            expiresDate: row.expiresDate,
            operationKey: row.operationKey,
            status: row.status,
            canApply:
                row.status === "review" &&
                lib.ms(row.expiresDate) > Number(ec.user.nowTimestamp) &&
                scope.gatewayEnabled &&
                scope.guardEnabled &&
                scope.broad &&
                lib.has("PAYMENT_EDIT"),
            capabilities: capabilities(scope)
        })
    if (!workflow.ledgerRead()) delete out.ledgerPreview
    if (row.resultJson) out.results = projectResult(json(row.resultJson), scope)
    else if (row.previewKind === "gatewayRecovery") {
        const accepted = one(ATTEMPT, {attemptId: row.attemptId})
        if (!accepted || accepted.paymentId !== row.paymentId || accepted.organizationPartyId !== scope.organizationPartyId)
            denied("GATEWAY_ATTEMPT_UNAVAILABLE", "The accepted recovery attempt is unavailable")
        // Accepted context is evidence for this new review, not a recorded confirmation or permission to retry a charge.
        out.results = projectResult(resultFor(accepted), scope)
    }
    return out
}
function previewAction(p) {
    const n = normalized(p),
        previewId = ec.user.randomString(32)
    call("create#" + PREVIEW, {
        previewId,
        organizationPartyId: n.scope.organizationPartyId,
        paymentId: n.scope.record.paymentId,
        userId: ec.user.userId,
        previewKind: "gatewayAction",
        action: n.request.action,
        instructionId: n.instruction?.instructionId || ec.user.randomString(32),
        attemptId: ec.user.randomString(32),
        sourceVersion: n.request.sourceVersion,
        inputFingerprint: n.fingerprint,
        requestJson: JSON.stringify(n.request),
        payloadJson: JSON.stringify(n.payload),
        createdDate: ec.user.nowTimestamp,
        expiresDate: Number(ec.user.nowTimestamp) + 1800000,
        status: "review"
    })
    return projectPreview(one(PREVIEW, {previewId}), n.scope)
}
function retained(p, write = false, lock = false) {
    let row = one(PREVIEW, {previewId: p.previewId})
    if (!row || row.userId !== ec.user.userId) denied("GATEWAY_PREVIEW_UNAVAILABLE", "The gateway review is unavailable")
    const scope = scopeFor(
        {organizationPartyId: p.organizationPartyId || row.organizationPartyId, paymentId: row.paymentId},
        write,
        lock
    )
    if (scope.organizationPartyId !== row.organizationPartyId)
        denied("GATEWAY_PREVIEW_UNAVAILABLE", "The gateway review belongs to another organization")
    if (lock) row = find(PREVIEW, {previewId: row.previewId}).forUpdate(true).useCache(false).one()
    return {row, scope, request: json(row.requestJson)}
}
function getPreview(p) {
    const r = retained(p)
    return projectPreview(r.row, r.scope)
}
function attemptVersion(row) {
    return hash(
        policy.pick(map(row), [
            "attemptId",
            "operationKey",
            "requestHash",
            "providerState",
            "financialState",
            "providerReference",
            "receiptJson",
            "responseCode",
            "reasonCode",
            "errorMessage",
            "leaseExpiresDate",
            "dispatchCount",
            "lookupCount",
            "completedDate",
            "resultJson",
            "lastUpdatedStamp"
        ])
    )
}
function attemptScope(p, write = false, lock = false) {
    let row = one(ATTEMPT, {attemptId: p.attemptId})
    if (!row) denied("GATEWAY_ATTEMPT_UNAVAILABLE", "The provider attempt is unavailable")
    const scope = scopeFor(
        {organizationPartyId: p.organizationPartyId || row.organizationPartyId, paymentId: row.paymentId},
        write,
        lock
    )
    if (scope.organizationPartyId !== row.organizationPartyId)
        denied("GATEWAY_ATTEMPT_UNAVAILABLE", "The provider attempt belongs to another organization")
    if (lock) row = find(ATTEMPT, {attemptId: row.attemptId}).forUpdate(true).useCache(false).one()
    return {row, scope}
}
function resultFor(row, alreadyApplied = false) {
    return Object.assign({}, json(row.resultJson), {
        attemptId: row.attemptId,
        providerOperationId: row.providerOperationId,
        organizationPartyId: row.organizationPartyId,
        paymentId: row.paymentId,
        cashPaymentId: row.financialState === "completed" ? row.cashPaymentId : null,
        action: row.action,
        outcome: row.providerState === "accepted" ? row.financialState : row.providerState,
        providerState: row.providerState,
        financialState: row.financialState,
        amount: String(row.amount),
        currencyUomId: row.currencyUomId,
        accountingDateText: policy.calendarDateText(row.accountingDate),
        reasonCode: row.reasonCode,
        errorMessage: row.errorMessage,
        alreadyApplied
    })
}
function getAttempt(p) {
    const r = attemptScope(p),
        preview = one(PREVIEW, {previewId: r.row.previewId}),
        payload = preview && json(preview.payloadJson)
    const available = r.scope.guardEnabled && r.scope.gatewayEnabled && r.scope.broad && lib.has("PAYMENT_EDIT")
    return Object.assign(projectResult(resultFor(r.row), r.scope), {
        attemptVersion: attemptVersion(r.row),
        operationKey: r.row.operationKey,
        capabilities: Object.assign(capabilities(r.scope), {
            canGatewayRefresh:
                available &&
                ["reserved", "dispatched", "pending", "uncertain", "quarantined"].includes(r.row.providerState) &&
                lib.ms(r.row.leaseExpiresDate) <= Number(ec.user.nowTimestamp) &&
                lib.ms(r.row.lookupLeaseExpiresDate) <= Number(ec.user.nowTimestamp),
            canGatewayRecover: available && r.row.providerState === "accepted" && r.row.financialState === "accepted_unposted"
        }),
        paymentSummary: payload?.paymentSummary,
        gatewaySummary: payload?.gatewaySummary
    })
}
function findProviders(p) {
    const context = workflow.paymentContext(p)
    if (!context.broad || !(lib.has("PAYMENT_EDIT") || lib.has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()))
        denied("PERMISSION_DENIED", "Treasury authority is required for provider identities")
    const cf = ec.entity.conditionFactory,
        ids = [...new Set(Array.from(p.selectedIdList || []).map(String))]
    if (ids.length > 200) denied("GATEWAY_SELECTION_LIMIT", "Select at most two hundred provider identities")
    let query = find("mantle.account.payment.PaymentGatewayTransactionRead")
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition("fromPartyId", "equals", context.organizationPartyId),
                    cf.makeCondition("toPartyId", "equals", context.organizationPartyId)
                ],
                "or"
            )
        )
        .condition("paymentGatewayConfigId", "is-not-null", null)
    if (!lib.access.systemAdmin())
        for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
            query = query.condition(
                cf.makeCondition(
                    [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)],
                    "or"
                )
            )
    const providerIds = Array.from(query.selectField("paymentGatewayConfigId").distinct(true).list()).map(
            row => row.paymentGatewayConfigId
        ),
        descriptions = providerIds.length
            ? Object.fromEntries(
                  Array.from(
                      find(CONFIG)
                          .condition("paymentGatewayConfigId", "in", providerIds)
                          .selectField("paymentGatewayConfigId")
                          .selectField("description")
                          .list()
                  ).map(row => [row.paymentGatewayConfigId, row.description])
              )
            : {},
        providers = providerIds
            .map(paymentGatewayConfigId => ({
                paymentGatewayConfigId,
                description: descriptions[paymentGatewayConfigId] || paymentGatewayConfigId
            }))
            .sort((a, b) => (a.description + a.paymentGatewayConfigId).localeCompare(b.description + b.paymentGatewayConfigId)),
        text = String(p.text || "")
            .trim()
            .slice(0, 200)
            .toLowerCase(),
        filtered = providers.filter(
            row => !text || (row.paymentGatewayConfigId + " " + row.description).toLowerCase().includes(text)
        ),
        count = filtered.length,
        pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 20)),
        pageMaxIndex = Math.max(0, Math.ceil(count / pageSize) - 1),
        pageIndex = Math.min(pageMaxIndex, Math.max(0, Number(p.pageIndex) || 0))
    return {
        rows: filtered.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        selectedRows: providers.filter(row => ids.includes(row.paymentGatewayConfigId)),
        recordCount: count,
        pageIndex,
        pageSize,
        pageMaxIndex,
        pageRangeLow: count ? pageIndex * pageSize + 1 : 0,
        pageRangeHigh: Math.min(count, (pageIndex + 1) * pageSize),
        complete: true,
        errors: []
    }
}
function findTransactions(p) {
    const context = workflow.paymentContext(p)
    if (!context.broad || !(lib.has("PAYMENT_EDIT") || lib.has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()))
        denied("PERMISSION_DENIED", "Treasury authority is required for provider records")
    const cf = ec.entity.conditionFactory,
        ids = [...new Set(Array.from(p.selectedAttemptIdList || []).map(String))]
    if (ids.length > 200) denied("GATEWAY_SELECTION_LIMIT", "Select at most two hundred attempts")
    function q(filters = true) {
        let query = find("mantle.account.payment.PaymentGatewayTransactionRead").condition(
            cf.makeCondition(
                [
                    cf.makeCondition("fromPartyId", "equals", context.organizationPartyId),
                    cf.makeCondition("toPartyId", "equals", context.organizationPartyId)
                ],
                "or"
            )
        )
        if (!lib.access.systemAdmin())
            for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
                query = query.condition(
                    cf.makeCondition(
                        [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)],
                        "or"
                    )
                )
        if (p.paymentId)
            query = query.condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("paymentId", "equals", p.paymentId),
                        cf.makeCondition("cashPaymentId", "equals", p.paymentId)
                    ],
                    "or"
                )
            )
        if (p.partyId)
            query = query.condition(
                cf.makeCondition(
                    [cf.makeCondition("fromPartyId", "equals", p.partyId), cf.makeCondition("toPartyId", "equals", p.partyId)],
                    "or"
                )
            )
        if (p.paymentGatewayConfigId) query = query.condition("paymentGatewayConfigId", p.paymentGatewayConfigId)
        if (filters) {
            if (p.action) {
                if (!operationEnums[p.action]) denied("GATEWAY_ACTION_UNAVAILABLE", "Choose a provider action")
                query = query.condition("paymentOperationEnumId", operationEnums[p.action])
            }
            if (p.outcome) {
                if (
                    ![
                        "reserved",
                        "dispatched",
                        "pending",
                        "uncertain",
                        "declined",
                        "accepted",
                        "quarantined",
                        "accepted_unposted",
                        "completed"
                    ].includes(p.outcome)
                )
                    denied("GATEWAY_OUTCOME_INVALID", "Choose a provider outcome")
                const field = ["accepted_unposted", "completed"].includes(p.outcome) ? "financialState" : "providerState"
                const legacy =
                    p.outcome === "accepted"
                        ? cf.makeCondition("resultSuccess", "equals", "Y")
                        : p.outcome === "declined"
                          ? cf.makeCondition("resultDeclined", "equals", "Y")
                          : p.outcome === "uncertain"
                            ? cf.makeCondition(
                                  [
                                      cf.makeCondition(
                                          [
                                              cf.makeCondition("resultSuccess", "is-null", null),
                                              cf.makeCondition("resultSuccess", "not-equals", "Y")
                                          ],
                                          "or"
                                      ),
                                      cf.makeCondition(
                                          [
                                              cf.makeCondition("resultDeclined", "is-null", null),
                                              cf.makeCondition("resultDeclined", "not-equals", "Y")
                                          ],
                                          "or"
                                      )
                                  ],
                                  "and"
                              )
                            : null
                query = query.condition(
                    legacy
                        ? cf.makeCondition(
                              [
                                  cf.makeCondition(field, "equals", p.outcome),
                                  cf.makeCondition([cf.makeCondition("attemptId", "is-null", null), legacy], "and")
                              ],
                              "or"
                          )
                        : cf.makeCondition(field, "equals", p.outcome)
                )
            }
            for (const [field, operator, suffix] of [
                ["fromDay", "greater-equals", " 00:00:00.000"],
                ["throughDay", "less-equals", " 23:59:59.999"]
            ])
                if (p[field]) {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p[field]))) denied("DATE_INVALID", "Choose a valid provider date")
                    query = query.condition(
                        "transactionDate",
                        operator,
                        ec.l10n.parseTimestamp(p[field] + suffix, "yyyy-MM-dd HH:mm:ss.SSS")
                    )
                }
            if (String(p.text || "").trim())
                query = query.condition(
                    cf.makeCondition(
                        ["paymentGatewayResponseId", "paymentId", "referenceNum", "responseCode"].map(field =>
                            cf.makeCondition(field, "like", "%" + String(p.text).trim().slice(0, 200) + "%").ignoreCase()
                        ),
                        "or"
                    )
                )
        }
        return query
    }
    function project(row) {
        return Object.assign(
            policy.pick(lib.display(row), [
                "paymentGatewayResponseId",
                "attemptId",
                "paymentId",
                "paymentGatewayConfigId",
                "paymentOperationEnumId",
                "action",
                "providerState",
                "financialState",
                "cashPaymentId",
                "amount",
                "amountUomId",
                "transactionDate",
                "transactionDateText",
                "referenceNum",
                "responseCode",
                "reasonCode",
                "resultSuccess",
                "resultDeclined",
                "resultError"
            ]),
            {
                isLegacy: !row.attemptId,
                cashPaymentId: row.financialState === "completed" ? row.cashPaymentId : null,
                currencyUomId: row.amountUomId,
                providerState:
                    row.providerState ||
                    (row.resultSuccess === "Y" ? "accepted" : row.resultDeclined === "Y" ? "declined" : "uncertain")
            }
        )
    }
    const count = q().count(),
        page = lib.page(q().orderBy("-transactionDate,paymentGatewayResponseId"), p, "records", count)
    return Object.assign(policy.pick(page, pageFields), {
        rows: page.rows.map(project),
        selectedRows: ids.length ? Array.from(q(false).condition("attemptId", "in", ids).list()).map(project) : [],
        complete: true,
        errors: []
    })
}
;({
    PREVIEW,
    INSTRUCTION,
    ATTEMPT,
    RESERVATION,
    RESPONSE,
    CONFIG,
    BINDING,
    scopeFor,
    normalized,
    findBindings,
    capabilities,
    instructionFor,
    instructionSummary,
    financialSource,
    bindingEvidence,
    guarantees,
    methodEvidence,
    previewAction,
    retained,
    getPreview,
    attemptVersion,
    attemptScope,
    getAttempt,
    findProviders,
    findTransactions,
    projectResult,
    projectPreview,
    resultFor,
    plannedCapacity
})
