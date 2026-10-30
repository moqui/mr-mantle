// Reviewed payment lifecycle. Financial inputs are retained before a confirm-only operation executes them.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {
    lib,
    P,
    A,
    paymentContext,
    paymentScope,
    paymentApplications,
    paymentVersion,
    paymentTotals,
    paymentCapabilities,
    methodVersion
} = workflow
const {find, one, rows, call, denied, map, hash, policy} = lib
const settlement = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentSettlement.js")
const PREVIEW = "mantle.account.payment.PaymentStatePreview",
    EVENT = "mantle.account.payment.PaymentLifecycleEvent",
    CONTENT = "mantle.account.payment.PaymentContent",
    TX = "mantle.ledger.transaction.AcctgTrans",
    ENTRY = "mantle.ledger.transaction.AcctgTransEntry"
const maxEvidenceCount = 10,
    maxEvidenceBytes = 10485760,
    maxTotalEvidenceBytes = 20971520
function setFields(record, fields) {
    for (const [field, value] of Object.entries(fields)) record.set(field, value)
}
function projectResult(result) {
    if (!workflow.ledgerRead())
        for (const field of ["acctgTransIds", "originalAcctgTransIds", "reversalAcctgTransIds", "replacementAcctgTransIds"])
            delete result[field]
    if (
        !(workflow.broadRead() && (lib.has("PAYMENT_EDIT") || lib.has("ACCOUNTING_ADMIN") || lib.access.systemAdmin())) &&
        result.outputRows
    )
        result.outputRows = result.outputRows.filter(row => row.outputType !== "check")
    return result
}
function stateLabel(statusId) {
    return one("moqui.basic.StatusItem", {statusId})?.description || statusId
}
function requireGuard(scope) {
    if (!scope.guardEnabled)
        denied("SETTLEMENT_GUARD_REQUIRED", "Enable settlement application controls before using the payment lifecycle")
}
function amountInput(value, currency) {
    let amount
    try {
        amount = toDecimal(value)
    } catch (_) {
        denied("AMOUNT_INVALID", "Enter a positive payment amount")
    }
    if (!amount || amount.compare(0) <= 0) denied("AMOUNT_INVALID", "Enter a positive payment amount")
    if (!amount.eq(ec.l10n.roundCurrency(amount, currency)))
        denied("CURRENCY_PRECISION", "The amount exceeds the currency precision")
    return amount
}
function counterparty(p, org) {
    const party = one("mantle.party.Party", {partyId: p.partyId})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("PARTY_UNAVAILABLE", "Choose an available counterparty")
    if (party.partyId === org || one("mantle.party.PartyRole", {partyId: party.partyId, roleTypeId: "OrgInternal"}))
        denied("INTERCOMPANY_EXCLUDED", "Internal parties use the transfer or intercompany workflow")
    return party
}
function validateMethod(method, owner, version, currency, date, identities = null) {
    if (!method || method.ownerPartyId !== owner) denied("PAYMENT_METHOD_UNAVAILABLE", "The chosen payment method is unavailable")
    if (methodVersion(method, identities || workflow.methodIdentities(method)) !== version)
        denied("STALE_PAYMENT_METHOD", "The payment method changed; review it again")
    if (!policy.active(method, date)) denied("PAYMENT_METHOD_INACTIVE", "The payment method is not active on the chosen date")
    if (method.currencyUomId !== currency) denied("CURRENCY_MISMATCH", "The payment method currency does not match the payment")
    return method
}
function checkedMethod(id, owner, version, currency, date) {
    if (!id || !version) denied("PAYMENT_METHOD_REVIEW_REQUIRED", "Review each chosen payment method")
    return validateMethod(
        find("mantle.account.method.PaymentMethod", {paymentMethodId: id}).one(),
        owner,
        version,
        currency,
        date
    )
}
function methodEvidence(scope, p, date, lock = false) {
    checkedMethod(p.organizationPaymentMethodId, scope.organizationPartyId, p.organizationMethodVersion, p.currencyUomId, date)
    if (p.counterpartyPaymentMethodId)
        checkedMethod(p.counterpartyPaymentMethodId, p.partyId, p.counterpartyMethodVersion, p.currencyUomId, date)
    const ids = [...new Set([p.organizationPaymentMethodId, p.counterpartyPaymentMethodId].filter(Boolean))].sort(),
        locked = {}
    if (lock)
        for (const id of ids) {
            const method = find("mantle.account.method.PaymentMethod", {paymentMethodId: id})
                .useCache(false)
                .forUpdate(true)
                .one()
            if (!method) denied("PAYMENT_METHOD_UNAVAILABLE", "The chosen payment method is unavailable")
            locked[id] = {method, identities: workflow.methodIdentities(method, true)}
        }
    // Financial writes validate and return the same fresh locked values. Ordinary rereads may retain the
    // transaction's earlier method/subtype snapshot after waiting on a concurrent credential or mapping edit.
    const selected = (id, owner, version) =>
            lock
                ? validateMethod(locked[id].method, owner, version, p.currencyUomId, date, locked[id].identities)
                : checkedMethod(id, owner, version, p.currencyUomId, date),
        organizationMethod = selected(p.organizationPaymentMethodId, scope.organizationPartyId, p.organizationMethodVersion),
        counterpartyMethod = p.counterpartyPaymentMethodId
            ? selected(p.counterpartyPaymentMethodId, p.partyId, p.counterpartyMethodVersion)
            : null
    return {
        organizationMethod,
        counterpartyMethod,
        versions: {
            organizationMethodVersion: methodVersion(
                organizationMethod,
                lock ? locked[organizationMethod.paymentMethodId].identities : null
            ),
            counterpartyMethodVersion: counterpartyMethod
                ? methodVersion(counterpartyMethod, lock ? locked[counterpartyMethod.paymentMethodId].identities : null)
                : null
        }
    }
}
function nativeTransactions(paymentId, org, lock = false) {
    return Array.from(
        find(TX, {paymentId, organizationPartyId: org})
            .condition("acctgTransTypeEnumId", "in", [
                "AttPayment",
                "AttDisbursement",
                "AttReceipt",
                "AttIncomingPayment",
                "AttOutgoingPayment"
            ])
            .condition("reverseOfAcctgTransId", "is-null", null)
            .condition("reversedByAcctgTransId", "is-null", null)
            .orderBy("acctgTransId")
            .forUpdate(lock)
            .list()
    )
}
function requireMutable(scope) {
    const r = scope.record
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefundBackingGuard.js").assertDraftAvailable({
        organizationPartyId: scope.organizationPartyId,
        paymentId: r.paymentId,
        lock: true
    })
    ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js").assertAdoptable(r)
    if (!["PmntProposed", "PmntPromised"].includes(r.statusId))
        denied("PAYMENT_STATE_INVALID", "Only a proposed or promised payment can be edited")
    if (r.refundForPaymentId || r.paymentTypeEnumId !== "PtInvoicePayment")
        denied("PAYMENT_SLICE_UNAVAILABLE", "This payment uses a later lifecycle workflow")
    if (paymentApplications([r.paymentId]).length || find(TX, {paymentId: r.paymentId}).limit(1).one())
        denied("PAYMENT_ALREADY_FINANCIAL", "A payment with applications or cash postings cannot be edited")
    if (find("mantle.account.method.PaymentGatewayResponse", {paymentId: r.paymentId}).limit(1).one())
        denied("GATEWAY_PAYMENT_MANAGED", "A gateway instruction cannot be edited here")
}
function draftRequest(p, scope) {
    if (!["incoming", "outgoing"].includes(p.cashDirection))
        denied("PAYMENT_DIRECTION_INVALID", "Choose an incoming receipt or outgoing disbursement")
    counterparty(p, scope.organizationPartyId)
    policy.currency(p.currencyUomId)
    if (policy.preference(scope.organizationPartyId).baseCurrencyUomId !== p.currencyUomId)
        denied("CURRENCY_MISMATCH", "Payment lifecycle currently requires the organization base currency")
    const date = settlement.dateInput(p.effectiveDate, p._accountingDay),
        amount = amountInput(p.amount, p.currencyUomId),
        instrument = one("moqui.basic.Enumeration", {enumId: p.paymentInstrumentEnumId, enumTypeId: "PaymentInstrument"})
    if (!instrument || ["PiWriteOff", "PiDiscount"].includes(instrument.enumId))
        denied("PAYMENT_INSTRUMENT_INVALID", "Choose a payment instrument")
    return {
        organizationPartyId: scope.organizationPartyId,
        cashDirection: p.cashDirection,
        partyId: p.partyId,
        amount: String(amount),
        currencyUomId: p.currencyUomId,
        effectiveDate: date.timestamp,
        _accountingDay: date.day,
        paymentInstrumentEnumId: instrument.enumId,
        organizationPaymentMethodId: p.organizationPaymentMethodId,
        organizationMethodVersion: p.organizationMethodVersion,
        counterpartyPaymentMethodId: p.counterpartyPaymentMethodId || null,
        counterpartyMethodVersion: p.counterpartyPaymentMethodId ? p.counterpartyMethodVersion : null,
        referenceNumber: String(p.referenceNumber || "")
            .trim()
            .slice(0, 60),
        comments: String(p.comments || "").slice(0, 4000)
    }
}
function draftFields(request, methods) {
    const incoming = request.cashDirection === "incoming"
    return {
        paymentTypeEnumId: "PtInvoicePayment",
        fromPartyId: incoming ? request.partyId : request.organizationPartyId,
        toPartyId: incoming ? request.organizationPartyId : request.partyId,
        amount: request.amount,
        amountUomId: request.currencyUomId,
        effectiveDate: request.effectiveDate,
        accountingDate: request._accountingDay,
        paymentInstrumentEnumId: request.paymentInstrumentEnumId,
        paymentMethodId: incoming
            ? methods.counterpartyMethod?.paymentMethodId || null
            : methods.organizationMethod.paymentMethodId,
        toPaymentMethodId: incoming
            ? methods.organizationMethod.paymentMethodId
            : methods.counterpartyMethod?.paymentMethodId || null,
        financeOrganizationPartyId: request.organizationPartyId,
        financeDirection: incoming ? "receivable" : "payable",
        lifecycleManaged: "Y",
        paymentRefNum: request.referenceNumber || null,
        comments: request.comments || null
    }
}
function draftResult(record) {
    return {
        paymentId: record.paymentId,
        statusId: record.statusId,
        sourceVersion: paymentVersion(record),
        accountingDateText: record.accountingDate
            ? policy.calendarDateText(record.accountingDate)
            : policy.dateText(record.effectiveDate),
        alreadyApplied: false,
        validationRequired: record.statusId === "PmntProposed"
    }
}
function event(scope, action, before, op, p = {}, evidence = [], acctgTransIds = []) {
    return call("create#" + EVENT, {
        organizationPartyId: scope.organizationPartyId,
        paymentId: scope.record.paymentId,
        userId: ec.user.userId,
        action,
        beforeStatusId: before,
        afterStatusId: scope.record.statusId,
        accountingDate: scope.record.accountingDate,
        settlementAccountingDate: scope.record.settlementAccountingDate,
        referenceNumber: p.referenceNumber || scope.record.paymentRefNum,
        reason: p.reason,
        createdDate: ec.user.nowTimestamp,
        operationKey: op.operationKey,
        evidenceJson: JSON.stringify(evidence),
        acctgTransIdsJson: JSON.stringify(acctgTransIds),
        postingEffectsJson: JSON.stringify(p.postingEffects || {}),
        expectedSourceVersion: p.expectedSourceVersion || p.sourceVersion || null,
        validationPolicyJson: p.validationPolicy ? JSON.stringify(p.validationPolicy) : null,
        sourceValidationEventId: p.sourceValidationEventId || null
    })
}
function createDraft(p) {
    const scope = paymentContext(p, true, true)
    requireGuard(scope)
    const request = draftRequest(p, scope),
        op = lib.operation(p, "PaymentDraftCreate", scope.organizationPartyId, request)
    if (op.old) return lib.previous(op)
    const methods = methodEvidence(scope, request, request.effectiveDate, true),
        fields = draftFields(request, methods)
    const made = call("create#" + P, Object.assign(fields, {statusId: "PmntProposed"})),
        record = one(P, {paymentId: made.paymentId})
    const result = draftResult(record)
    const createdEvent = event(
        Object.assign(scope, {record}),
        "create",
        null,
        op,
        Object.assign({}, request, {expectedSourceVersion: result.sourceVersion, validationPolicy: methods.versions})
    )
    if (result.validationRequired)
        Object.assign(result, {
            validationEventId: createdEvent.paymentLifecycleEventId,
            validationSourceVersion: result.sourceVersion
        })
    lib.complete(op, P, record.paymentId, result)
    return result
}
function storeDraft(p) {
    const initial = paymentScope(p, true, true)
    requireGuard(initial)
    const request = draftRequest(p, initial),
        op = lib.operation(p, "PaymentDraftStore", initial.organizationPartyId, {
            paymentId: p.paymentId,
            sourceVersion: p.sourceVersion,
            request
        })
    if (op.old) return lib.previous(op)
    requireMutable(initial)
    if (!p.sourceVersion || paymentVersion(initial.record) !== p.sourceVersion)
        denied("STALE_REVISION", "The payment changed; reload before editing")
    const methods = methodEvidence(initial, request, request.effectiveDate, true),
        before = initial.record.statusId
    ec.resource
        .script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
        .assertAdoptable(initial.record, true)
    setFields(initial.record, draftFields(request, methods))
    initial.record.update()
    const result = draftResult(one(P, {paymentId: p.paymentId}))
    const editEvent = event(
        initial,
        "edit",
        before,
        op,
        Object.assign({}, request, {expectedSourceVersion: result.sourceVersion, validationPolicy: methods.versions})
    )
    if (result.validationRequired)
        Object.assign(result, {
            validationEventId: editEvent.paymentLifecycleEventId,
            validationSourceVersion: result.sourceVersion
        })
    lib.complete(op, P, p.paymentId, result)
    return result
}
function canonicalDbLocation(value) {
    const text = String(value || "")
    if (!text.startsWith("dbresource:")) return text
    return (
        "dbresource://" +
        text
            .slice(text.startsWith("dbresource://") ? 13 : 11)
            .split("/")
            .filter(Boolean)
            .join("/")
    )
}
function evidenceFile(row, budget = maxTotalEvidenceBytes) {
    const location = canonicalDbLocation(row.contentLocation),
        roots = [
            ...new Set(
                [
                    "dbresource://mantle/content",
                    ec.user.getPreference("mantle.content.root"),
                    ec.user.getPreference("mantle.content.large.root")
                ]
                    .filter(Boolean)
                    .map(canonicalDbLocation)
            )
        ],
        prefix = roots.find(root =>
            location.startsWith(root.replace(/\/+$/, "") + "/payment/" + row.paymentId + "/content_" + row.paymentContentId + "/")
        )
    if (
        !prefix ||
        /[\\?#\x00-\x1f]|%2e|%2f|%5c/i.test(location) ||
        location.split("/").some(part => part === "." || part === "..") ||
        location.slice(prefix.replace(/\/+$/, "").length + 1).split("/").length !== 4
    )
        denied("PAYMENT_EVIDENCE_LOCATION_INVALID", "Choose a supported local payment evidence file")
    const ref = ec.resource.getLocationReference(location)
    if (!ref.getExists() || !ref.isFile()) denied("PAYMENT_EVIDENCE_UNAVAILABLE", "The selected evidence file is missing")
    const size = Number(ref.getSize())
    if (!Number.isSafeInteger(size) || size < 0 || size > maxEvidenceBytes || size > budget)
        denied("PAYMENT_EVIDENCE_SIZE_LIMIT", "Evidence files are limited to 10 MiB each and 20 MiB total")
    const stream = ref.getInputStream()
    if (!stream) denied("PAYMENT_EVIDENCE_UNAVAILABLE", "The selected evidence file is missing")
    try {
        const bytes = stream.readAllBytes()
        if (bytes.length !== size) denied("STALE_PAYMENT_EVIDENCE", "The evidence changed; review it again")
        const contentHash = hash(StringUtilities.base64Encode(bytes)),
            fileName = String(ref.getFileName())
                .replace(/[\\/:?*"<>\x00-\x1f\x7f]/g, "_")
                .slice(0, 180),
            manifest = {
                paymentContentId: row.paymentContentId,
                fileName,
                contentType: ref.getContentType() || "application/octet-stream",
                contentSize: size,
                contentHash,
                version: hash({
                    paymentContentId: row.paymentContentId,
                    stamp: String(row.lastUpdatedStamp),
                    location,
                    size,
                    contentHash
                })
            }
        return {manifest, bytes}
    } finally {
        stream.close()
    }
}
function evidenceOptions(scope, contentRows) {
    const evidenceRows = [],
        errors = []
    let budget = maxTotalEvidenceBytes
    for (const row of contentRows.slice(0, 100)) {
        try {
            const file = evidenceFile(row, budget)
            budget -= file.manifest.contentSize
            evidenceRows.push(file.manifest)
        } catch (error) {
            const reasonCode = String(error.message).split(":")[0]
            if (reasonCode.startsWith("PAYMENT_EVIDENCE_") || reasonCode === "STALE_PAYMENT_EVIDENCE")
                ec.logger.warn("Payment evidence " + row.paymentContentId + ": " + error.message)
            else ec.logger.error("Payment evidence " + row.paymentContentId + ": " + error.message)
            errors.push({paymentContentId: row.paymentContentId, reasonCode})
        }
    }
    return {
        evidenceRows,
        errors,
        incomplete: contentRows.length > 100 || errors.some(row => row.reasonCode === "PAYMENT_EVIDENCE_SIZE_LIMIT")
    }
}
function selectedEvidence(scope, p, lock = false) {
    if (typeof p.evidenceContentIdList === "string")
        denied("PAYMENT_EVIDENCE_SELECTION_INVALID", "Select payment evidence identifiers")
    const ids = [...new Set(Array.from(p.evidenceContentIdList || []).map(String))].sort()
    if (ids.length > maxEvidenceCount) denied("PAYMENT_EVIDENCE_COUNT_LIMIT", "Select at most ten payment evidence files")
    if (!ids.length) return []
    const records = Array.from(
        find(CONTENT, {paymentId: scope.record.paymentId})
            .condition("paymentContentId", "in", ids)
            .orderBy("paymentContentId")
            .forUpdate(lock)
            .list()
    )
    if (records.length !== ids.length)
        denied("PAYMENT_EVIDENCE_UNAVAILABLE", "A selected evidence file does not belong to this payment")
    let budget = maxTotalEvidenceBytes
    return records.map(row => {
        const file = evidenceFile(row, budget)
        if (!p.evidenceVersions?.[row.paymentContentId] || p.evidenceVersions[row.paymentContentId] !== file.manifest.version)
            denied("STALE_PAYMENT_EVIDENCE", "The evidence changed; review it again")
        budget -= file.manifest.contentSize
        return file
    })
}
function freezeEvidence(scope, eventId, files) {
    const manifest = files.map(file => {
        const location =
            "dbresource://mantle/content/payment-issued/" +
            scope.record.paymentId +
            "/evidence/" +
            eventId +
            "/" +
            file.manifest.paymentContentId +
            "/" +
            file.manifest.fileName
        ec.resource.getLocationReference(location).putBytes(file.bytes)
        return Object.assign({}, file.manifest, {archiveLocation: location})
    })
    if (manifest.length) call("update#" + EVENT, {paymentLifecycleEventId: eventId, evidenceJson: JSON.stringify(manifest)})
    return manifest
}
function methodRequest(scope) {
    const r = scope.record,
        incoming = scope.cashDirection === "incoming",
        organizationPaymentMethodId = incoming ? r.toPaymentMethodId : r.paymentMethodId,
        counterpartyPaymentMethodId = incoming ? r.paymentMethodId : r.toPaymentMethodId,
        organizationMethod =
            organizationPaymentMethodId &&
            one("mantle.account.method.PaymentMethod", {paymentMethodId: organizationPaymentMethodId}),
        counterpartyMethod =
            counterpartyPaymentMethodId &&
            one("mantle.account.method.PaymentMethod", {paymentMethodId: counterpartyPaymentMethodId})
    return {
        partyId: scope.partyId,
        currencyUomId: r.amountUomId,
        organizationPaymentMethodId,
        organizationMethodVersion: organizationMethod ? methodVersion(organizationMethod) : null,
        counterpartyPaymentMethodId,
        counterpartyMethodVersion: counterpartyMethod ? methodVersion(counterpartyMethod) : null
    }
}
function cashPlan(scope, methods) {
    const r = scope.record,
        outgoing = scope.cashDirection === "outgoing",
        organizationPartyId = scope.organizationPartyId,
        mapped = call("mantle.ledger.PaymentAutoPostServices.get#PaymentTypeGlAccount", {
            organizationPartyId,
            paymentTypeEnumId: r.paymentTypeEnumId,
            isApplied: "N",
            isPayable: outgoing ? "Y" : "N",
            otherPartyId: scope.partyId
        }),
        cash = call("mantle.ledger.PaymentAutoPostServices.get#PaymentMethodGlAccount", {
            paymentId: r.paymentId,
            organizationPartyId,
            otherPartyId: scope.partyId
        })
    if (!mapped.glAccountId || !cash.glAccountId) denied("MAPPING_MISSING", "Configure both the payment and cash accounts")
    return {
        organizationPartyId,
        amountUomId: r.amountUomId,
        acctgTransTypeEnumId: outgoing ? "AttOutgoingPayment" : "AttIncomingPayment",
        transactionDate: r.effectiveDate,
        lines: [
            {glAccountId: mapped.glAccountId, debitCreditFlag: outgoing ? "D" : "C", amount: String(r.amount)},
            {glAccountId: cash.glAccountId, debitCreditFlag: outgoing ? "C" : "D", amount: String(r.amount)}
        ]
    }
}
function cashEvidence(scope, transactions, lock = false) {
    const r = scope.record,
        pref = policy.preference(scope.organizationPartyId)
    if (
        transactions.length !== 1 ||
        transactions[0].isPosted !== "Y" ||
        transactions[0].glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
        transactions[0].amountUomId !== r.amountUomId ||
        (pref.errorGlJournalId && transactions[0].glJournalId === pref.errorGlJournalId)
    )
        denied("PAYMENT_NOT_POSTED", "The complete actual cash posting is required")
    if (find(TX, {reverseOfAcctgTransId: transactions[0].acctgTransId, isPosted: "Y"}).limit(1).one())
        denied("PAYMENT_CASH_REVERSED", "This payment cash posting has been reversed")
    const entries = Array.from(
            find(ENTRY, {acctgTransId: transactions[0].acctgTransId}).orderBy("acctgTransEntrySeqId").forUpdate(lock).list()
        ),
        debits = entries.filter(row => row.debitCreditFlag === "D").reduce((sum, row) => sum.add(row.amount || 0), toDecimal(0)),
        credits = entries.filter(row => row.debitCreditFlag === "C").reduce((sum, row) => sum.add(row.amount || 0), toDecimal(0))
    if (
        !debits.eq(r.amount) ||
        !credits.eq(r.amount) ||
        entries.some(row => !row.glAccountId || !["D", "C"].includes(row.debitCreditFlag))
    )
        denied("POSTING_MISMATCH", "The cash posting does not match the payment amount")
    return entries.map(row =>
        policy.pick(map(row), [
            "acctgTransId",
            "acctgTransEntrySeqId",
            "glAccountId",
            "debitCreditFlag",
            "amount",
            "lastUpdatedStamp"
        ])
    )
}
function stateNormalized(p, lock = false) {
    if (p.action === "void") return unapplyNormalized(p, lock, true)
    const scope = paymentScope(p, true, lock),
        r = scope.record
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefundBackingGuard.js").assertDraftAvailable({
        organizationPartyId: scope.organizationPartyId,
        paymentId: r.paymentId,
        lock
    })
    ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js").assertAdoptable(r)
    requireGuard(scope)
    counterparty({partyId: scope.partyId}, scope.organizationPartyId)
    if (!p.sourceVersion || paymentVersion(r) !== p.sourceVersion)
        denied("STALE_REVISION", "The payment changed; review it again")
    if (r.refundForPaymentId || r.paymentTypeEnumId !== "PtInvoicePayment")
        denied("PAYMENT_SLICE_UNAVAILABLE", "This payment uses a later lifecycle workflow")
    const action = p.action,
        before = r.statusId,
        applications = paymentApplications([r.paymentId]),
        transactions = nativeTransactions(r.paymentId, scope.organizationPartyId, lock),
        positive = applications.some(row => toDecimal(row.amountApplied || 0).compare(0) > 0),
        date =
            action === "cancel" && !r.effectiveDate
                ? {day: null, timestamp: null}
                : settlement.dateInput(
                      r.effectiveDate,
                      r.accountingDate ? policy.calendarDateText(r.accountingDate) : p._paymentDay || null
                  )
    const referenceNumber = String(p.referenceNumber || "").trim(),
        reason = String(p.reason || "").trim()
    if (!["validate", "deliver", "confirm", "cancel"].includes(action))
        denied("PAYMENT_STATE_ACTION_UNAVAILABLE", "This payment action is not available in this checkpoint")
    const allowed = {
        validate: ["PmntProposed"],
        deliver: ["PmntProposed", "PmntPromised"],
        confirm: ["PmntDelivered"],
        cancel: ["PmntProposed", "PmntPromised"]
    }
    if (!allowed[action].includes(before)) denied("PAYMENT_STATE_INVALID", "The payment is not in a state for this action")
    if (["deliver", "confirm"].includes(action) && (!referenceNumber || !reason))
        denied("PAYMENT_EVIDENCE_REQUIRED", "Enter a human payment reference and reason")
    if (referenceNumber.length > 60 || reason.length > 4000)
        denied("PAYMENT_EVIDENCE_INVALID", "The reference or reason is too long")
    if (action !== "confirm" && (positive || transactions.length))
        denied("PAYMENT_ALREADY_FINANCIAL", "The payment already has cash or application evidence")
    if (["validate", "deliver"].includes(action) && (applications.length || find(TX, {paymentId: r.paymentId}).limit(1).one()))
        denied("PAYMENT_PRIOR_FINANCIAL_HISTORY", "A previously applied or posted payment needs a reviewed correction")
    if (find("mantle.account.method.PaymentGatewayResponse", {paymentId: r.paymentId}).limit(1).one())
        denied("GATEWAY_PAYMENT_MANAGED", "Existing provider instructions require the gateway workflow")
    const methodInput = methodRequest(scope),
        methods = action === "cancel" ? null : methodEvidence(scope, methodInput, date.timestamp, lock),
        gatewayManaged =
            r.paymentGatewayConfigId ||
            methods?.organizationMethod.paymentGatewayConfigId ||
            methods?.counterpartyMethod?.paymentGatewayConfigId ||
            !workflow.manualInstruments.includes(r.paymentInstrumentEnumId)
    if (["deliver", "confirm"].includes(action) && gatewayManaged)
        denied("GATEWAY_PAYMENT_MANAGED", "Use the reviewed gateway workflow for this payment")
    scope.gatewayManaged = Boolean(gatewayManaged)
    if (action === "deliver" && r.forInvoiceId)
        denied("INVOICE_APPLICATION_REVIEW_REQUIRED", "Invoice application needs a separately authorized settlement review")
    const evidence = selectedEvidence(scope, p, lock),
        readinessPlans = ["validate", "deliver"].includes(action) ? [cashPlan(scope, methods)] : [],
        plans = action === "deliver" ? readinessPlans : [],
        initialPolicyEvidence = ["validate", "deliver"].includes(action)
            ? settlement.validatePolicy(
                  {
                      organizationPartyId: scope.organizationPartyId,
                      partyId: scope.partyId,
                      direction: scope.financeDirection,
                      currencyUomId: r.amountUomId
                  },
                  date,
                  readinessPlans,
                  lock
              )
            : null,
        postedEntries = action === "confirm" ? cashEvidence(scope, transactions, lock) : []
    let policyEvidence = initialPolicyEvidence
    let settlementDate = null
    if (action === "confirm") {
        if (transactions.length !== 1 || transactions[0].isPosted !== "Y")
            denied("PAYMENT_NOT_POSTED", "Delivered cash posting must be complete before confirming")
        settlementDate = settlement.dateInput(p.settlementDate, p._settlementDay || null)
        if (settlementDate.day < date.day || transactions.some(tx => settlementDate.day < policy.postingDay(tx)))
            denied("SETTLEMENT_BEFORE_PAYMENT", "Settlement cannot precede the payment or its actual cash posting")
        policyEvidence = settlement.validatePolicy(
            {
                organizationPartyId: scope.organizationPartyId,
                partyId: scope.partyId,
                direction: scope.financeDirection,
                currencyUomId: r.amountUomId
            },
            settlementDate,
            [],
            lock
        )
    }
    if (policyEvidence) policyEvidence.methods = methodInput
    const after = {validate: "PmntPromised", deliver: "PmntDelivered", confirm: "PmntConfirmed", cancel: "PmntCancelled"}[action],
        names = lib.partyNames([scope.organizationPartyId, scope.partyId]),
        paymentSummary = {
            paymentId: r.paymentId,
            amount: String(r.amount),
            currencyUomId: r.amountUomId,
            organizationName: names[scope.organizationPartyId],
            partyId: scope.partyId,
            partyName: names[scope.partyId],
            cashDirection: scope.cashDirection,
            accountingDateText: date.day,
            maskedMethodLabel: methods ? workflow.methodRows([methods.organizationMethod])[0].label : null,
            referenceNumber
        },
        request = {
            organizationPartyId: scope.organizationPartyId,
            paymentId: r.paymentId,
            sourceVersion: p.sourceVersion,
            action,
            referenceNumber,
            reason,
            _paymentDay: date.day,
            sourceValidationEventId: p._validationEventId || p.sourceValidationEventId || null,
            settlementDate: settlementDate?.timestamp || null,
            _settlementDay: settlementDate?.day || null,
            evidenceContentIdList: evidence.map(file => file.manifest.paymentContentId),
            evidenceVersions: Object.fromEntries(evidence.map(file => [file.manifest.paymentContentId, file.manifest.version]))
        },
        payload = {
            paymentId: r.paymentId,
            action,
            before: {statusId: before, statusDescription: stateLabel(before)},
            after: {statusId: after, statusDescription: stateLabel(after)},
            effectiveDateText: date.day,
            settlementDateText: settlementDate?.day || null,
            referenceNumber,
            reason,
            evidenceRows: evidence.map(file => file.manifest),
            applicationEffects: [],
            sourceVersions: {[r.paymentId]: p.sourceVersion},
            paymentSummary,
            postingSummary: {
                cashPostingCount: plans.length,
                applicationPostingCount: 0,
                effect: action === "deliver" ? "One cash transaction" : "No cash posting"
            },
            ledgerPreview: plans,
            blockers: [],
            capabilities: paymentCapabilities(scope, applications, transactions.length > 0)
        }
    return {scope, request, payload, plans, policyEvidence, evidence, transactions, postedEntries}
}
function projectPreview(row, payload, scope) {
    const dto = Object.assign({}, payload, {
        previewId: row.previewId,
        inputFingerprint: row.inputFingerprint,
        operationKey: row.operationKey || null,
        expiresAt: row.expiresDate,
        expiresDate: row.expiresDate,
        status: row.status,
        canApply:
            row.status === "review" &&
            lib.ms(row.expiresDate) > Number(ec.user.nowTimestamp) &&
            scope.broad &&
            lib.has("PAYMENT_EDIT") &&
            scope.guardEnabled
    })
    dto.capabilities = paymentCapabilities(scope)
    const outputFlags = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js").available(scope)
    Object.assign(dto.capabilities, policy.pick(outputFlags, ["canPrintReceipt", "canPrintDetail", "canPrintCheck"]))
    if (!workflow.ledgerRead()) delete dto.ledgerPreview
    if (
        ["void", "unapply"].includes(payload.action) &&
        payload.applicationEffects?.length &&
        !lib.has(scope.financeDirection === "receivable" ? "RECEIVABLE_EDIT" : "PAYABLE_EDIT")
    )
        dto.canApply = false
    if (row.resultJson) dto.results = projectResult(JSON.parse(row.resultJson))
    return dto
}
function previewState(p) {
    const n = stateNormalized(p),
        now = Number(ec.user.nowTimestamp),
        inputFingerprint =
            p.action === "void"
                ? correctionFingerprint(n)
                : hash({
                      request: n.request,
                      plans: n.plans,
                      policy: n.policyEvidence,
                      transactions: n.transactions.map(map),
                      entries: n.postedEntries,
                      summary: n.payload.paymentSummary
                  })
    const made = call("create#" + PREVIEW, {
        organizationPartyId: n.scope.organizationPartyId,
        paymentId: p.paymentId,
        userId: ec.user.userId,
        previewKind: "state",
        inputFingerprint,
        requestJson: JSON.stringify(n.request),
        payloadJson: JSON.stringify(n.payload),
        createdDate: now,
        expiresDate: now + 600000,
        status: "review"
    })
    return projectPreview(
        Object.assign(made, {inputFingerprint, expiresDate: now + 600000, status: "review"}),
        n.payload,
        n.scope
    )
}
function retained(p, write = false, lock = false) {
    const initial = one(PREVIEW, {previewId: p.previewId})
    if (!initial || initial.userId !== ec.user.userId) denied("PAYMENT_PREVIEW_UNAVAILABLE", "The payment review is unavailable")
    if (p.organizationPartyId && initial.organizationPartyId !== p.organizationPartyId)
        denied("ORGANIZATION_DENIED", "The payment review belongs to another organization")
    const scope = paymentScope(initial, write, lock),
        row = lock ? find(PREVIEW, {previewId: p.previewId}).forUpdate(true).one() : initial
    return {row, scope, request: JSON.parse(row.requestJson), payload: JSON.parse(row.payloadJson)}
}
function getStatePreview(p) {
    const r = retained(p)
    if (r.row.previewKind !== "state") denied("PAYMENT_PREVIEW_MISMATCH", "Choose a payment state review")
    return projectPreview(r.row, r.payload, r.scope)
}
function verifyCash(scope, plans) {
    const actual = nativeTransactions(scope.record.paymentId, scope.organizationPartyId),
        plan = plans[0],
        pref = policy.preference(scope.organizationPartyId)
    if (
        actual.length !== 1 ||
        actual[0].isPosted !== "Y" ||
        actual[0].amountUomId !== scope.record.amountUomId ||
        actual[0].glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
        actual[0].acctgTransTypeEnumId !== plan.acctgTransTypeEnumId ||
        (pref.errorGlJournalId && actual[0].glJournalId === pref.errorGlJournalId)
    )
        denied("PAYMENT_NOT_POSTED", "The exact cash posting did not complete")
    const entries = rows(ENTRY, {acctgTransId: actual[0].acctgTransId}),
        expected = {},
        posted = {}
    for (const [lines, target] of [
        [plan.lines, expected],
        [entries, posted]
    ])
        for (const line of lines) {
            const key = line.glAccountId + ":" + line.debitCreditFlag
            target[key] = (target[key] || toDecimal(0)).add(line.amount || 0)
        }
    if (
        Object.keys(posted).length !== Object.keys(expected).length ||
        Object.keys(expected).some(key => !posted[key] || !posted[key].eq(expected[key]))
    )
        denied("POSTING_MISMATCH", "The cash posting differs from the reviewed accounts and amounts")
    return actual.map(row => row.acctgTransId)
}
function changeState(p) {
    const r = retained(p, true, true)
    if (r.row.previewKind !== "state" || p.inputFingerprint !== r.row.inputFingerprint)
        denied("PAYMENT_PREVIEW_MISMATCH", "Confirm the reviewed payment state change")
    const op = lib.operation(p, "PaymentState", r.scope.organizationPartyId, {
        previewId: p.previewId,
        inputFingerprint: p.inputFingerprint
    })
    if (op.old) return projectResult(lib.previous(op))
    if (r.row.status !== "review") denied("PAYMENT_PREVIEW_CONSUMED", "The review was already confirmed with another operation")
    if (lib.ms(r.row.expiresDate) <= Number(ec.user.nowTimestamp))
        denied("PAYMENT_PREVIEW_EXPIRED", "Review the payment again before confirming")
    if (r.request.action === "void") {
        const correction = unapplyNormalized(r.request, true, true)
        if (correctionFingerprint(correction) !== r.row.inputFingerprint)
            denied("STALE_PREVIEW", "The reviewed financial history changed")
        const result = executeCorrection(correction, op)
        setFields(r.row, {status: "complete", operationKey: op.operationKey, resultJson: JSON.stringify(result)})
        r.row.update()
        lib.complete(op, P, correction.scope.record.paymentId, result)
        return projectResult(result)
    }
    const n = stateNormalized(r.request, true),
        fingerprint = hash({
            request: n.request,
            plans: n.plans,
            policy: n.policyEvidence,
            transactions: n.transactions.map(map),
            entries: n.postedEntries,
            summary: n.payload.paymentSummary
        })
    if (fingerprint !== r.row.inputFingerprint)
        denied("STALE_PREVIEW", "The payment or its posting policy changed; review it again")
    if (n.request.action === "deliver" || n.evidence.length)
        ec.resource.script("component://mr-mantle/service/mantle/account/PaymentArchiveGuard.js").prepare()
    ec.resource
        .script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
        .assertAdoptable(n.scope.record, true)
    let record = n.scope.record
    const before = record.statusId,
        action = n.request.action
    if (action === "deliver" && record.statusId === "PmntProposed") {
        record.set("statusId", "PmntPromised")
        record.update()
        record = find(P, {paymentId: record.paymentId}).forUpdate(true).one()
        n.scope.record = record
    }
    setFields(record, {statusId: n.payload.after.statusId, lifecycleManaged: "Y"})
    if (["validate", "deliver"].includes(action) && !record.accountingDate) record.set("accountingDate", n.request._paymentDay)
    if (n.request.referenceNumber) record.set("paymentRefNum", n.request.referenceNumber)
    if (action === "confirm") {
        record.set("settlementDate", n.request.settlementDate)
        record.set("settlementAccountingDate", n.request._settlementDay)
    }
    record.update()
    n.scope.record = find(P, {paymentId: record.paymentId}).forUpdate(true).one()
    let acctgTransIds = []
    let outputRows = []
    if (action === "deliver") {
        if (
            n.scope.cashDirection === "outgoing" &&
            ["PiCompanyCheck", "PiCertifiedCheck"].includes(record.paymentInstrumentEnumId)
        ) {
            const existingCheck = one("mantle.account.method.BankAccountCheck", {paymentId: record.paymentId})
            if (existingCheck && existingCheck.paymentMethodId !== record.paymentMethodId)
                denied("CHECK_NUMBER_CONFLICT", "The existing check number belongs to a different bank account")
            if (!existingCheck)
                call("mantle.account.PaymentServices.assign#BankAccountCheckNumber", {paymentId: record.paymentId})
            n.scope.record = find(P, {paymentId: record.paymentId}).forUpdate(true).one()
        }
        call("mantle.ledger.PaymentAutoPostServices.post#Payment", {paymentId: record.paymentId})
        n.scope.record = find(P, {paymentId: record.paymentId}).forUpdate(true).one()
        acctgTransIds = verifyCash(n.scope, n.plans)
        outputRows = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentOutput.js")
            .issue(n.scope, Object.assign({}, n.request, {paymentSummary: n.payload.paymentSummary}), op.operationKey)
    }
    const eventResult = event(n.scope, action, before, op, n.request, [], acctgTransIds)
    freezeEvidence(n.scope, eventResult.paymentLifecycleEventId, n.evidence)
    const result = Object.assign(draftResult(one(P, {paymentId: record.paymentId})), {
        action,
        settlementDateText: n.request._settlementDay,
        applicationResults: [],
        acctgTransIds,
        paymentLifecycleEventId: eventResult.paymentLifecycleEventId,
        outputRows,
        outputId: outputRows.find(row => row.outputType === "receipt")?.outputId,
        reasonCode: "PAYMENT_STATE_CHANGED"
    })
    setFields(r.row, {status: "complete", operationKey: op.operationKey, resultJson: JSON.stringify(result)})
    r.row.update()
    lib.complete(op, P, record.paymentId, result)
    return projectResult(result)
}
const applicationTypes = [
    "AttOutgoingPaymentAp",
    "AttIncomingPaymentAp",
    "AttPaymentInOutAppl",
    "AttInvoiceInOutAppl",
    "AttPaymentApplied"
]
function reversalPolicy(scope, transaction, entries, lock) {
    const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js"),
        day = policy.postingDay(transaction),
        fiscal = guard.fiscal(scope.organizationPartyId, transaction.transactionDate, lock, [], day),
        locks = guard.postingLocks(transaction, guard.scopes(transaction, entries), lock, day, true),
        findings = [...fiscal.findings, ...locks.findings],
        pref = policy.preference(scope.organizationPartyId)
    if (findings.length) denied(findings[0].code, findings.map(row => row.message).join("; "))
    if (
        transaction.amountUomId !== scope.record.amountUomId ||
        transaction.glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
        transaction.isPosted !== "Y" ||
        transaction.amountUomId !== pref.baseCurrencyUomId ||
        (pref.errorGlJournalId && transaction.glJournalId === pref.errorGlJournalId)
    )
        denied("PAYMENT_POSTING_UNAVAILABLE", "The original actual same-currency posting is required")
    let debit = toDecimal(0),
        credit = toDecimal(0)
    const accounts = entries.map(line => {
        if (!line.glAccountId || !["D", "C"].includes(line.debitCreditFlag))
            denied("ENTRY_INVALID", "The original posting contains an invalid entry")
        if (line.debitCreditFlag === "D") debit = debit.add(line.amount || 0)
        else credit = credit.add(line.amount || 0)
        const account = policy.account(scope.organizationPartyId, line.glAccountId, transaction.transactionDate)
        policy.dimensions(scope.organizationPartyId, line, transaction.transactionDate)
        if (
            pref.requiredLedgerDimensionsEnabled === "Y" &&
            ((account.assignment.facilityRequired === "Y" && !line.facilityId) ||
                (account.assignment.costCenterRequired === "Y" && !line.costCenterId))
        )
            denied("DIMENSION_REQUIRED", "The original posting lacks a required ledger dimension")
        return {
            account: policy.pick(map(account.row), [
                "glAccountId",
                "accountCode",
                "accountName",
                "glAccountClassEnumId",
                "disallowPosting"
            ]),
            assignment: policy.pick(map(account.assignment), [
                "glAccountId",
                "organizationPartyId",
                "fromDate",
                "thruDate",
                "facilityRequired",
                "costCenterRequired"
            ])
        }
    })
    if (!entries.length || !debit.eq(credit)) denied("UNBALANCED", "The original posting is not balanced")
    return {
        day,
        periods: fiscal.periods.map(row =>
            policy.pick(map(row), ["timePeriodId", "partyId", "timePeriodTypeId", "fromDate", "thruDate", "isClosed"])
        ),
        locks: locks.locks.map(row => ({
            lock: map(row),
            exceptions: rows("mantle.ledger.config.AccountingLockException", {accountingLockId: row.accountingLockId}).map(map)
        })),
        accounts,
        preference: policy.pick(map(pref), [
            "baseCurrencyUomId",
            "postingGuardEnabled",
            "requiredLedgerDimensionsEnabled",
            "settlementApplicationGuardEnabled"
        ])
    }
}
function applicationDocuments(scope, applications, lock) {
    const invoiceIds = [...new Set(applications.flatMap(row => [row.invoiceId, row.toInvoiceId]).filter(Boolean))].sort(),
        paymentIds = [
            ...new Set([scope.record.paymentId, ...applications.flatMap(row => [row.paymentId, row.toPaymentId]).filter(Boolean)])
        ].sort(),
        documents = []
    // Resolve scope and write authority for all documents before taking any additional document locks.
    for (const id of invoiceIds) {
        const source = lib.invoice({organizationPartyId: scope.organizationPartyId, invoiceId: id}),
            direction = source.receivable ? "receivable" : "payable"
        workflow.context(
            {
                organizationPartyId: scope.organizationPartyId,
                partyId: source.partyId,
                direction,
                currencyUomId: source.record.currencyUomId
            },
            true
        )
        if (
            source.partyId !== scope.partyId ||
            direction !== scope.financeDirection ||
            source.record.currencyUomId !== scope.record.amountUomId
        )
            denied("APPLICATION_SCOPE_INVALID", "Every application must match this payment's party, logical side and currency")
        documents.push({entity: workflow.I, id, record: source.record, kind: "invoice"})
    }
    for (const id of paymentIds) {
        const source = paymentScope({organizationPartyId: scope.organizationPartyId, paymentId: id})
        if (applications.length)
            workflow.context(
                {
                    organizationPartyId: scope.organizationPartyId,
                    partyId: source.partyId,
                    direction: source.financeDirection,
                    currencyUomId: source.record.amountUomId
                },
                true
            )
        if (
            source.partyId !== scope.partyId ||
            source.financeDirection !== scope.financeDirection ||
            source.record.amountUomId !== scope.record.amountUomId
        )
            denied("APPLICATION_SCOPE_INVALID", "Every application must match this payment's party, logical side and currency")
        documents.push({entity: P, id, record: source.record, kind: "payment"})
    }
    if (lock)
        for (const document of documents)
            document.record = find(document.entity, {[document.kind === "invoice" ? "invoiceId" : "paymentId"]: document.id})
                .forUpdate(true)
                .one()
    return documents
}
function allDocumentApplications(documents, lock = false) {
    const cf = ec.entity.conditionFactory,
        conditions = documents.flatMap(document =>
            (document.kind === "invoice" ? ["invoiceId", "toInvoiceId"] : ["paymentId", "toPaymentId"]).map(field =>
                cf.makeCondition(field, "equals", document.id)
            )
        ),
        records = Array.from(
            find(A)
                .condition(cf.makeCondition(conditions, "or"))
                .orderBy("paymentApplicationId")
                .forUpdate(lock)
                .limit(10001)
                .list()
        )
    if (records.length > 10000)
        denied("APPLICATION_HISTORY_LIMIT", "The selected financial history needs a bounded reconciliation review")
    return records
}
function unapplyNormalized(p, lock = false, voidPayment = false) {
    const scope = paymentScope(p, true, lock),
        r = scope.record
    ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js").assertAdoptable(r)
    requireGuard(scope)
    counterparty({partyId: scope.partyId}, scope.organizationPartyId)
    if (!p.sourceVersion || p.sourceVersion !== paymentVersion(r))
        denied("STALE_REVISION", "The payment changed; review it again")
    if (
        r.paymentTypeEnumId !== "PtInvoicePayment" ||
        r.refundForPaymentId ||
        !["PmntDelivered", "PmntConfirmed"].includes(r.statusId)
    )
        denied("PAYMENT_STATE_INVALID", "Only a delivered trade payment can be unapplied or voided here")
    const reason = String(p.reason || "").trim()
    if (!reason || reason.length > 4000) denied("PAYMENT_REASON_REQUIRED", "Enter a reason for the correction")
    const related = paymentApplications([r.paymentId]),
        positive = related.filter(row => toDecimal(row.amountApplied || 0).compare(0) > 0),
        ids = voidPayment
            ? positive.map(row => row.paymentApplicationId).sort()
            : [...new Set(Array.from(p.paymentApplicationIdList || []).map(String))].sort()
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefundBackingGuard.js").assertCorrection({
        organizationPartyId: scope.organizationPartyId,
        paymentId: r.paymentId,
        voidPayment,
        paymentApplicationIdList: ids,
        lock
    })
    if ((!voidPayment && !ids.length) || ids.length > 200)
        denied("APPLICATION_SELECTION_INVALID", "Select between one and two hundred positive applications")
    const selected = related.filter(row => ids.includes(row.paymentApplicationId))
    if (selected.length !== ids.length || selected.some(row => toDecimal(row.amountApplied || 0).compare(0) <= 0))
        denied("APPLICATION_UNAVAILABLE", "A selected positive application is unavailable")
    if (
        !voidPayment &&
        selected.some(
            row =>
                !p.applicationVersions?.[row.paymentApplicationId] ||
                p.applicationVersions[row.paymentApplicationId] !== hash(map(row))
        )
    )
        denied("STALE_APPLICATION", "An application changed; review it again")
    const evidence = selectedEvidence(scope, p, lock),
        documents = applicationDocuments(scope, selected, lock),
        allApplications = allDocumentApplications(documents, lock),
        currentSelected = allApplications.filter(row => ids.includes(row.paymentApplicationId))
    if (hash(currentSelected.map(map)) !== hash(selected.map(map)))
        denied("STALE_APPLICATION", "The applications changed while being reviewed")
    const transactionIds = new Set(),
        cf = ec.entity.conditionFactory,
        applicationTransactions = ids.length
            ? Array.from(
                  find(TX, {organizationPartyId: scope.organizationPartyId})
                      .condition("paymentApplicationId", "in", ids)
                      .condition("acctgTransTypeEnumId", "in", applicationTypes)
                      .condition("reverseOfAcctgTransId", "is-null", null)
                      .condition("reversedByAcctgTransId", "is-null", null)
                      .orderBy("acctgTransId")
                      .forUpdate(lock)
                      .list()
              )
            : [],
        cash = nativeTransactions(r.paymentId, scope.organizationPartyId, lock),
        cashEntries = cashEvidence(scope, cash, lock),
        sourceGuard = ec.resource.script("component://mr-mantle/service/mantle/account/SourcePostingGuard.js"),
        policies = [],
        plans = []
    for (const application of currentSelected) {
        const evidence = sourceGuard.applicationEvidence(application),
            date = settlement.dateInput(evidence.effectiveDate, evidence.day)
        policies.push(
            settlement.validatePolicy(
                {
                    organizationPartyId: scope.organizationPartyId,
                    partyId: scope.partyId,
                    direction: scope.financeDirection,
                    currencyUomId: r.amountUomId
                },
                date,
                [],
                lock
            )
        )
    }
    const cashIsDirect = Boolean(cash[0].invoiceId || cash[0].paymentApplicationId),
        direct = cashIsDirect
    if (direct && !voidPayment && ids.length !== positive.length)
        denied("DIRECT_PAYMENT_UNAPPLY_REQUIRED", "Unapply the entire dependent application set from a directly posted payment")
    if (direct) {
        sourceGuard.directHistory(r, cash[0].invoiceId, cash, positive)
        const originalInvoice = one(workflow.I, {invoiceId: cash[0].invoiceId}),
            outgoing = scope.cashDirection === "outgoing",
            control = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceTypeTransType", {
                organizationPartyId: scope.organizationPartyId,
                invoiceTypeEnumId: originalInvoice?.invoiceTypeEnumId,
                isPayable: outgoing ? "Y" : "N"
            }).glAccountId,
            cashAccount = call("mantle.ledger.PaymentAutoPostServices.get#PaymentMethodGlAccount", {
                paymentId: r.paymentId,
                organizationPartyId: scope.organizationPartyId,
                otherPartyId: scope.partyId
            }).glAccountId
        if (!control || !cashAccount) denied("MAPPING_MISSING", "The original direct cash accounts are not configured")
        sourceGuard.controlProof({entries: cashEntries}, control, outgoing ? "D" : "C", r.amount)
        sourceGuard.controlProof({entries: cashEntries}, cashAccount, outgoing ? "C" : "D", r.amount)
    }
    for (const application of currentSelected) {
        const matches = applicationTransactions.filter(tx => tx.paymentApplicationId === application.paymentApplicationId)
        if (matches.length > 1 || (!matches.length && !direct))
            denied("APPLICATION_POSTING_UNAVAILABLE", "The exact original application posting could not be identified")
    }
    for (const tx of applicationTransactions) transactionIds.add(tx.acctgTransId)
    if (voidPayment || direct) {
        if (r.reconcileStatusId && r.reconcileStatusId !== "PmtrNot")
            denied("PAYMENT_RECONCILED", "A reconciled payment needs a reconciliation correction first")
        const entries = Array.from(
            find(ENTRY, {acctgTransId: cash[0].acctgTransId}).orderBy("acctgTransEntrySeqId").forUpdate(lock).list()
        )
        if (entries.some(line => line.reconcileStatusId && line.reconcileStatusId !== "AterNot"))
            denied("PAYMENT_RECONCILED", "Reconciled cash entries cannot be reversed here")
        transactionIds.add(cash[0].acctgTransId)
    }
    const originalTransactions = Array.from(
            find(TX)
                .condition("acctgTransId", "in", [...transactionIds])
                .orderBy("acctgTransId")
                .forUpdate(lock)
                .list()
        ),
        entryEvidence = []
    for (const tx of originalTransactions) {
        if (find(TX, {reverseOfAcctgTransId: tx.acctgTransId, isPosted: "Y"}).limit(1).one())
            denied("PAYMENT_POSTING_REVERSED", "An original posting was already reversed")
        const entries = Array.from(
            find(ENTRY, {acctgTransId: tx.acctgTransId}).orderBy("acctgTransEntrySeqId").forUpdate(lock).list()
        )
        policies.push(reversalPolicy(scope, tx, entries, lock))
        entryEvidence.push(...entries.map(map))
        plans.push({
            kind: applicationTypes.includes(tx.acctgTransTypeEnumId) ? "reverseApplication" : "reverseCash",
            originalAcctgTransId: tx.acctgTransId,
            paymentApplicationId: tx.paymentApplicationId || null,
            accountingDateText: policy.postingDay(tx),
            currencyUomId: tx.amountUomId,
            lines: entries.map(line => ({
                glAccountId: line.glAccountId,
                debitCreditFlag: line.debitCreditFlag === "D" ? "C" : "D",
                amount: String(line.amount)
            }))
        })
    }
    let replacement = null
    if (direct && !voidPayment) {
        const methodInput = methodRequest(scope),
            methods = methodInput.organizationPaymentMethodId
                ? methodEvidence(scope, methodInput, cash[0].transactionDate, lock)
                : null
        replacement = Object.assign(cashPlan(scope, methods), {
            transactionDate: cash[0].transactionDate,
            accountingDate: policy.postingDay(cash[0])
        })
        const replacementPolicy = settlement.validatePolicy(
            {
                organizationPartyId: scope.organizationPartyId,
                partyId: scope.partyId,
                direction: scope.financeDirection,
                currencyUomId: r.amountUomId
            },
            settlement.dateInput(cash[0].transactionDate, policy.postingDay(cash[0])),
            [replacement],
            lock
        )
        replacementPolicy.methods = methodInput
        policies.push(replacementPolicy)
        plans.push(Object.assign({kind: "replaceUnappliedCash", accountingDateText: policy.postingDay(cash[0])}, replacement))
    }
    plans.sort(
        (a, b) =>
            ({reverseApplication: 0, reverseCash: 1, replaceUnappliedCash: 2})[a.kind] -
            {reverseApplication: 0, reverseCash: 1, replaceUnappliedCash: 2}[b.kind]
    )
    const balances = documents.map(document => {
            const fields = document.kind === "invoice" ? ["invoiceId", "toInvoiceId"] : ["paymentId", "toPaymentId"],
                matches = allApplications.filter(row => fields.some(field => row[field] === document.id)),
                consumed = matches.reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0)),
                total =
                    document.kind === "invoice"
                        ? lib.totals(document.record).invoiceTotal
                        : toDecimal(document.record.amount || 0),
                removed = currentSelected
                    .filter(row => fields.some(field => row[field] === document.id))
                    .reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
            return {
                sourceKind: document.kind,
                sourceId: document.id,
                original: String(total),
                beforeRemaining: String(total.subtract(consumed)),
                afterRemaining: String(total.subtract(consumed).add(removed)),
                currencyUomId: r.amountUomId,
                version: hash({record: map(document.record), applications: matches.map(map)})
            }
        }),
        names = lib.partyNames([scope.organizationPartyId, scope.partyId]),
        summary = {
            paymentId: r.paymentId,
            amount: String(r.amount),
            currencyUomId: r.amountUomId,
            accountingDateText:
                p._paymentDay ||
                (r.accountingDate ? policy.calendarDateText(r.accountingDate) : ec.l10n.format(r.effectiveDate, "yyyy-MM-dd")),
            partyId: scope.partyId,
            partyName: names[scope.partyId],
            organizationName: names[scope.organizationPartyId],
            cashDirection: scope.cashDirection,
            referenceNumber: r.paymentRefNum
        },
        request = {
            organizationPartyId: scope.organizationPartyId,
            paymentId: r.paymentId,
            sourceVersion: p.sourceVersion,
            reason,
            action: voidPayment ? "void" : "unapply",
            _paymentDay: summary.accountingDateText,
            paymentApplicationIdList: ids,
            applicationVersions: Object.fromEntries(currentSelected.map(row => [row.paymentApplicationId, hash(map(row))])),
            evidenceContentIdList: evidence.map(file => file.manifest.paymentContentId),
            evidenceVersions: Object.fromEntries(evidence.map(file => [file.manifest.paymentContentId, file.manifest.version]))
        },
        payload = {
            paymentId: r.paymentId,
            action: request.action,
            before: {statusId: r.statusId, statusDescription: stateLabel(r.statusId)},
            after: {
                statusId: voidPayment ? "PmntVoid" : r.statusId,
                statusDescription: stateLabel(voidPayment ? "PmntVoid" : r.statusId)
            },
            paymentSummary: summary,
            postingSummary: {
                cashPostingCount: Number(voidPayment || direct) + Number(Boolean(replacement)),
                applicationPostingCount: applicationTransactions.length,
                effect: voidPayment
                    ? "Reverse reviewed applications, then cash"
                    : direct
                      ? "Unapply the entire direct set and restore unapplied cash"
                      : "Reverse only the selected application postings"
            },
            applicationEffects: currentSelected.map(row =>
                Object.assign(
                    policy.pick(map(row), [
                        "paymentApplicationId",
                        "paymentId",
                        "toPaymentId",
                        "invoiceId",
                        "toInvoiceId",
                        "amountApplied",
                        "appliedDate"
                    ]),
                    {
                        amountOriginallyApplied: String(row.amountApplied),
                        afterAmountApplied: "0",
                        originalDateText: sourceGuard.applicationDay(row)
                    }
                )
            ),
            beforeBalances: balances.map(row => Object.assign({}, row, {remaining: row.beforeRemaining})),
            afterBalances: balances.map(row => Object.assign({}, row, {remaining: row.afterRemaining})),
            sourceVersions: Object.fromEntries(balances.map(row => [workflow.key(row.sourceKind, row.sourceId), row.version])),
            ledgerPreview: plans,
            reason,
            blockers: [],
            evidenceRows: evidence.map(file => file.manifest),
            effectiveDateText: summary.accountingDateText,
            capabilities: paymentCapabilities(scope, related, true)
        }
    return {
        scope,
        request,
        payload,
        documents,
        applications: currentSelected,
        originalTransactions,
        entryEvidence,
        cashEntries,
        policies,
        plans,
        replacement,
        evidence
    }
}
function correctionFingerprint(n) {
    return hash({
        request: n.request,
        payload: policy.pick(n.payload, [
            "paymentSummary",
            "postingSummary",
            "before",
            "after",
            "applicationEffects",
            "beforeBalances",
            "afterBalances",
            "sourceVersions",
            "ledgerPreview",
            "reason",
            "evidenceRows"
        ]),
        originals: n.originalTransactions.map(map),
        entries: n.entryEvidence,
        policies: n.policies,
        cash: n.cashEntries
    })
}
function previewUnapply(p) {
    const n = unapplyNormalized(p),
        now = Number(ec.user.nowTimestamp),
        inputFingerprint = correctionFingerprint(n),
        made = call("create#" + PREVIEW, {
            organizationPartyId: n.scope.organizationPartyId,
            paymentId: p.paymentId,
            userId: ec.user.userId,
            previewKind: "unapply",
            inputFingerprint,
            requestJson: JSON.stringify(n.request),
            payloadJson: JSON.stringify(n.payload),
            createdDate: now,
            expiresDate: now + 600000,
            status: "review"
        })
    return projectPreview(
        Object.assign(made, {inputFingerprint, expiresDate: now + 600000, status: "review"}),
        n.payload,
        n.scope
    )
}
function getUnapplyPreview(p) {
    const r = retained(p)
    if (r.row.previewKind !== "unapply") denied("PAYMENT_PREVIEW_MISMATCH", "Choose an unapplication review")
    return projectPreview(r.row, r.payload, r.scope)
}
function verifyReversal(original, reversalId, expected) {
    const tx = one(TX, {acctgTransId: reversalId}),
        entries = tx ? rows(ENTRY, {acctgTransId: reversalId}) : [],
        actual = {},
        plan = {}
    if (
        !tx ||
        tx.isPosted !== "Y" ||
        tx.reverseOfAcctgTransId !== original.acctgTransId ||
        tx.organizationPartyId !== original.organizationPartyId ||
        tx.amountUomId !== original.amountUomId ||
        policy.postingDay(tx) !== policy.postingDay(original)
    )
        denied("PAYMENT_REVERSAL_NOT_POSTED", "The original-day reversal did not post exactly")
    for (const [lines, target] of [
        [expected, plan],
        [entries, actual]
    ])
        for (const line of lines) {
            const key = line.glAccountId + ":" + line.debitCreditFlag
            target[key] = (target[key] || toDecimal(0)).add(line.amount || 0)
        }
    if (
        Object.keys(actual).length !== Object.keys(plan).length ||
        Object.keys(plan).some(key => !actual[key] || !actual[key].eq(plan[key]))
    )
        denied("POSTING_MISMATCH", "The reversal differs from the reviewed original entries")
    return tx.acctgTransId
}
function executeCorrection(n, op) {
    if (n.evidence.length) ec.resource.script("component://mr-mantle/service/mantle/account/PaymentArchiveGuard.js").prepare()
    ec.resource
        .script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
        .assertAdoptable(n.scope.record, true)
    const reversalIds = [],
        replacementIds = [],
        before = n.scope.record.statusId
    for (const application of n.applications) {
        const current = find(A, {paymentApplicationId: application.paymentApplicationId}).forUpdate(true).one()
        current.set("amountOriginallyApplied", current.amountApplied)
        current.set("amountApplied", toDecimal(0))
        current.update()
    }
    for (const plan of n.plans.filter(row => row.kind === "reverseApplication" || row.kind === "reverseCash")) {
        const original = n.originalTransactions.find(row => row.acctgTransId === plan.originalAcctgTransId),
            result = call("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
                acctgTransId: original.acctgTransId,
                changeReason: n.request.reason
            })
        reversalIds.push(verifyReversal(original, result.acctgTransId, plan.lines))
    }
    for (const document of n.documents.filter(row => row.kind === "invoice")) {
        const record = find(workflow.I, {invoiceId: document.id}).forUpdate(true).one(),
            totals = lib.totals(record)
        if (totals.unpaidTotal.compare(0) > 0 && ["InvoicePmtRecvd", "InvoicePmtSent"].includes(record.statusId)) {
            record.set("statusId", record.statusId === "InvoicePmtRecvd" ? "InvoiceFinalized" : "InvoiceApproved")
            record.set("paidDate", null)
            record.update()
        }
    }
    n.scope.record = find(P, {paymentId: n.scope.record.paymentId}).forUpdate(true).one()
    if (n.scope.record.lifecycleManaged !== "Y") {
        n.scope.record.set("lifecycleManaged", "Y")
        n.scope.record.update()
        n.scope.record = find(P, {paymentId: n.scope.record.paymentId}).forUpdate(true).one()
    }
    if (n.replacement) {
        if (paymentApplications([n.scope.record.paymentId]).some(row => toDecimal(row.amountApplied || 0).compare(0) > 0))
            denied("DIRECT_PAYMENT_UNAPPLY_REQUIRED", "Replacement cash requires all dependent applications to be zero")
        const made = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
                organizationPartyId: n.scope.organizationPartyId,
                otherPartyId: n.scope.partyId,
                paymentId: n.scope.record.paymentId,
                acctgTransTypeEnumId: n.replacement.acctgTransTypeEnumId,
                amountUomId: n.replacement.amountUomId,
                transactionDate: n.replacement.transactionDate,
                glFiscalTypeEnumId: "GLFT_ACTUAL",
                description: "Reviewed original-day unapplied cash replacement"
            }),
            transaction = find(TX, {acctgTransId: made.acctgTransId}).forUpdate(true).one()
        transaction.set("accountingDate", n.replacement.accountingDate)
        transaction.update()
        for (const line of n.replacement.lines)
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", Object.assign({acctgTransId: made.acctgTransId}, line))
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: made.acctgTransId})
        n.scope.record = find(P, {paymentId: n.scope.record.paymentId}).forUpdate(true).one()
        replacementIds.push(...verifyCash(n.scope, [n.replacement]))
        if (
            replacementIds.length !== 1 ||
            policy.postingDay(one(TX, {acctgTransId: replacementIds[0]})) !== n.replacement.accountingDate
        )
            denied("POSTING_MISMATCH", "Replacement cash did not retain the original accounting day")
    }
    if (n.request.action === "void") {
        n.scope.record.set("statusId", "PmntVoid")
        n.scope.record.update()
        n.scope.record = find(P, {paymentId: n.scope.record.paymentId}).forUpdate(true).one()
    }
    const postingEffects = {
            originalAcctgTransIds: n.originalTransactions.map(row => row.acctgTransId),
            reversalAcctgTransIds: reversalIds,
            replacementAcctgTransIds: replacementIds
        },
        ev = event(
            n.scope,
            n.request.action,
            before,
            op,
            Object.assign({}, n.request, {postingEffects}),
            [],
            [...reversalIds, ...replacementIds]
        )
    freezeEvidence(n.scope, ev.paymentLifecycleEventId, n.evidence)
    return Object.assign(draftResult(n.scope.record), {
        action: n.request.action,
        applicationResults: n.applications.map(row => ({
            paymentApplicationId: row.paymentApplicationId,
            amountOriginallyApplied: row.amountApplied,
            amountApplied: "0"
        })),
        acctgTransIds: [...reversalIds, ...replacementIds],
        ...postingEffects,
        paymentLifecycleEventId: ev.paymentLifecycleEventId,
        reasonCode: n.request.action === "void" ? "PAYMENT_VOIDED" : "PAYMENT_UNAPPLIED"
    })
}
function unapplyReviewed(p) {
    const r = retained(p, true, true)
    if (r.row.previewKind !== "unapply" || r.row.inputFingerprint !== p.inputFingerprint)
        denied("PAYMENT_PREVIEW_MISMATCH", "Confirm the retained unapplication review")
    const op = lib.operation(p, "PaymentUnapply", r.scope.organizationPartyId, {
        previewId: p.previewId,
        inputFingerprint: p.inputFingerprint
    })
    if (op.old) return projectResult(lib.previous(op))
    if (r.row.status !== "review") denied("PAYMENT_PREVIEW_CONSUMED", "This review was already confirmed")
    if (lib.ms(r.row.expiresDate) <= Number(ec.user.nowTimestamp))
        denied("PAYMENT_PREVIEW_EXPIRED", "Review the applications again before confirming")
    const n = unapplyNormalized(r.request, true)
    if (correctionFingerprint(n) !== r.row.inputFingerprint) denied("STALE_PREVIEW", "The reviewed financial history changed")
    const result = executeCorrection(n, op)
    setFields(r.row, {status: "complete", operationKey: op.operationKey, resultJson: JSON.stringify(result)})
    r.row.update()
    lib.complete(op, P, n.scope.record.paymentId, result)
    return projectResult(result)
}
function validationNotice(p, approve) {
    const notification = one("moqui.security.user.NotificationMessage", {notificationMessageId: p.notificationMessageId})
    let message
    try {
        message = JSON.parse(notification?.messageJson || "{}")
    } catch (_) {
        denied("PAYMENT_VALIDATION_NOTICE_INVALID", "The validation notice payload is invalid")
    }
    if (
        !notification ||
        notification.topic !== "PaymentValidation" ||
        notification.recordEntityName !== P ||
        p.recordEntityName !== P ||
        String(notification.recordId) !== String(p.recordId) ||
        String(message.paymentId) !== String(p.recordId) ||
        !one("moqui.security.user.NotificationMessageUser", {
            notificationMessageId: p.notificationMessageId,
            userId: ec.user.userId
        })
    )
        denied("PAYMENT_VALIDATION_NOTICE_UNAVAILABLE", "This validation notice is not assigned to you")
    const sourceEvent = one(EVENT, {paymentLifecycleEventId: message.validationEventId})
    if (
        !sourceEvent ||
        !["create", "edit"].includes(sourceEvent.action) ||
        sourceEvent.afterStatusId !== "PmntProposed" ||
        sourceEvent.paymentId !== p.recordId ||
        sourceEvent.organizationPartyId !== message.organizationPartyId ||
        sourceEvent.expectedSourceVersion !== message.sourceVersion ||
        notification.actorUserId !== sourceEvent.userId
    )
        denied("PAYMENT_VALIDATION_NOTICE_INVALID", "The notice does not match its original native validation request")
    if (
        !p.message ||
        p.message.validationEventId !== message.validationEventId ||
        p.message.sourceVersion !== message.sourceVersion ||
        p.message.paymentId !== message.paymentId ||
        p.message.organizationPartyId !== message.organizationPartyId
    )
        denied("PAYMENT_VALIDATION_NOTICE_INVALID", "The supplied message does not match the stored notice")
    const scope = paymentScope(
        {organizationPartyId: sourceEvent.organizationPartyId, paymentId: sourceEvent.paymentId},
        true,
        true
    )
    requireGuard(scope)
    const decision = approve ? "approved" : "refused",
        reason = approve ? "Approved from payment validation notice" : String(p.reason || "").trim()
    if (!reason || reason.length > 4000) denied("PAYMENT_REASON_REQUIRED", "Give a reason for refusing validation")
    const operationKey = "pval:" + hash(sourceEvent.paymentLifecycleEventId).slice(0, 35),
        op = lib.operation({operationKey}, "PaymentValidationDecision", scope.organizationPartyId, {
            validationEventId: sourceEvent.paymentLifecycleEventId,
            notificationMessageId: p.notificationMessageId,
            decision,
            reason
        })
    if (op.old) return projectResult(lib.previous(op))
    if (scope.record.statusId !== "PmntProposed" || paymentVersion(scope.record) !== sourceEvent.expectedSourceVersion)
        denied("STALE_REVISION", "The payment changed after this validation request")
    const methods = methodRequest(scope),
        frozenPolicy = JSON.parse(sourceEvent.validationPolicyJson || "{}")
    if (
        methods.organizationMethodVersion !== frozenPolicy.organizationMethodVersion ||
        methods.counterpartyMethodVersion !== frozenPolicy.counterpartyMethodVersion
    )
        denied("STALE_PAYMENT_METHOD", "The banking identity changed after this validation request")
    let result
    if (approve) {
        const preview = previewState({
            organizationPartyId: scope.organizationPartyId,
            paymentId: scope.record.paymentId,
            sourceVersion: sourceEvent.expectedSourceVersion,
            action: "validate",
            reason,
            _validationEventId: sourceEvent.paymentLifecycleEventId
        })
        result = call("mantle.account.PaymentServices.change#PaymentState", {
            previewId: preview.previewId,
            inputFingerprint: preview.inputFingerprint,
            operationKey: "pvstate:" + hash(sourceEvent.paymentLifecycleEventId).slice(0, 32)
        })
    } else {
        const ev = event(scope, "validationRejected", scope.record.statusId, op, {
            reason,
            expectedSourceVersion: sourceEvent.expectedSourceVersion,
            sourceValidationEventId: sourceEvent.paymentLifecycleEventId
        })
        result = Object.assign(draftResult(scope.record), {
            paymentLifecycleEventId: ev.paymentLifecycleEventId,
            reasonCode: "PAYMENT_VALIDATION_REFUSED"
        })
    }
    Object.assign(result, {
        validationEventId: sourceEvent.paymentLifecycleEventId,
        decision,
        reasonCode: approve ? "PAYMENT_VALIDATION_APPROVED" : "PAYMENT_VALIDATION_REFUSED"
    })
    lib.complete(op, EVENT, result.paymentLifecycleEventId, result)
    return projectResult(result)
}
function approveValidation(p) {
    return validationNotice(p, true)
}
function refuseValidation(p) {
    return validationNotice(p, false)
}
;({
    createDraft,
    storeDraft,
    previewState,
    getStatePreview,
    changeState,
    stateNormalized,
    retained,
    projectPreview,
    evidenceOptions,
    selectedEvidence,
    methodRequest,
    methodEvidence,
    cashPlan,
    freezeEvidence,
    canonicalDbLocation,
    nativeTransactions,
    verifyCash,
    requireGuard,
    event,
    unapplyNormalized,
    correctionFingerprint,
    previewUnapply,
    getUnapplyPreview,
    unapplyReviewed,
    executeCorrection,
    approveValidation,
    refuseValidation
})
