// Reviewed opposite cash consumes exact original funding; reads never invent capacity from incomplete history.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const lifecycle = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentLifecycle.js")
const settlement = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentSettlement.js")
const sourceGuard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
const legacy = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
const {lib, P, A} = workflow
const {find, one, rows, map, call, policy, hash, denied} = lib
const PREVIEW = "mantle.account.payment.PaymentRefundPreview",
    RECORD = "mantle.account.payment.PaymentRefundRecord",
    CLAIM = "mantle.account.payment.PaymentRefundDraftClaim",
    TX = "mantle.ledger.transaction.AcctgTrans",
    ENTRY = "mantle.ledger.transaction.AcctgTransEntry"
const financialWriterAvailable = true
const publicReasons = new Set([
    "REFUND_SOURCE_UNAVAILABLE",
    "REFUND_BACKING_INVALID",
    "REFUND_HISTORY_LIMIT",
    "REFUND_HISTORY_INCONSISTENT",
    "REFUND_RECORD_INVALID",
    "REFUND_CAPACITY_INCONSISTENT",
    "GATEWAY_HOLD_UNAVAILABLE",
    "MAPPING_MISSING",
    "SOURCE_NOT_POSTED",
    "SOURCE_POSTING_UNSUPPORTED",
    "CURRENCY_MISMATCH"
])
function publicReason(error) {
    const reason = String(error?.message || "").match(/(?:^|\b)([A-Z][A-Z0-9_]+):/)?.[1]
    return publicReasons.has(reason) ? reason : "REFUND_EVIDENCE_UNAVAILABLE"
}
function json(value) {
    try {
        return JSON.parse(value || "{}")
    } catch (_) {
        denied("REFUND_EVIDENCE_UNAVAILABLE", "Retained refund evidence is unavailable")
    }
}
function treasury(scope, write = false) {
    if (
        !scope.broad ||
        !(lib.has("PAYMENT_EDIT") || lib.has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()) ||
        (write && !lib.has("PAYMENT_EDIT"))
    )
        denied("PERMISSION_DENIED", "Current Treasury payment authority is required")
    return scope
}
function scopeFor(p, write = false, lock = false) {
    return treasury(workflow.paymentScope(p, write, lock), write)
}
function heldDraftClaim(p) {
    if (!p.paymentId) denied("PAYMENT_REQUIRED", "A draft payment identity is required")
    const row = find(CLAIM, {refundPaymentId: p.paymentId}).useCache(false).forUpdate(Boolean(p.lock)).one()
    if (!row || row.status !== "held") return null
    if (p.organizationPartyId && row.organizationPartyId !== p.organizationPartyId)
        denied("REFUND_CLAIM_INVALID", "Draft claim organization is inconsistent")
    return Object.assign(
        policy.pick(map(row), ["refundPaymentId", "originalPaymentId", "organizationPartyId", "attemptId", "status"]),
        {version: hash(map(row))}
    )
}
function completedFunding(p) {
    const cf = ec.entity.conditionFactory,
        conditions = []
    if (p.paymentApplicationId) conditions.push(cf.makeCondition("paymentApplicationId", "equals", p.paymentApplicationId))
    if (p.paymentId)
        for (const field of ["originalPaymentId", "refundPaymentId"])
            conditions.push(cf.makeCondition(field, "equals", p.paymentId))
    if (p.acctgTransId)
        for (const field of ["originalAcctgTransId", "cashAcctgTransId", "applicationAcctgTransId"])
            conditions.push(cf.makeCondition(field, "equals", p.acctgTransId))
    if (!conditions.length) denied("REFUND_IDENTITY_REQUIRED", "Select an actual refund funding identity")
    const records = Array.from(
        find(RECORD)
            .condition(cf.makeCondition(conditions, "or"))
            .orderBy("refundPaymentId")
            .useCache(false)
            .forUpdate(Boolean(p.lock))
            .list()
    ).map(map)
    for (const row of records)
        if (
            !row.originalPaymentId ||
            !row.refundPaymentId ||
            !row.paymentApplicationId ||
            !row.currencyUomId ||
            toDecimal(row.amount || 0).compare(0) <= 0
        )
            denied("REFUND_RECORD_INVALID", "Recorded refund funding identity is incomplete")
    return {
        records,
        protectedApplicationIds: [...new Set(records.map(row => row.paymentApplicationId))],
        originalPaymentIds: [...new Set(records.map(row => row.originalPaymentId))],
        refundPaymentIds: [...new Set(records.map(row => row.refundPaymentId))],
        acctgTransIds: [
            ...new Set(
                records
                    .flatMap(row => [row.originalAcctgTransId, row.cashAcctgTransId, row.applicationAcctgTransId])
                    .filter(Boolean)
            )
        ]
    }
}
function applications(ids, lock = false) {
    if (!ids.length) return []
    const cf = ec.entity.conditionFactory,
        out = Array.from(
            find(A)
                .condition(
                    cf.makeCondition([cf.makeCondition("paymentId", "in", ids), cf.makeCondition("toPaymentId", "in", ids)], "or")
                )
                .orderBy("paymentApplicationId")
                .useCache(false)
                .forUpdate(lock)
                .limit(10001)
                .list()
        )
    if (out.length > 10000) denied("REFUND_HISTORY_LIMIT", "Refund funding history requires a bounded reconciliation review")
    return out
}
function controlAccount(scope, payment = scope.record) {
    const cache = scope._refundControlAccounts || (scope._refundControlAccounts = {}),
        key = payment.paymentTypeEnumId + ":" + (payment.fromPartyId === scope.organizationPartyId ? "Y" : "N")
    if (cache[key]) return cache[key]
    const mapped = call("mantle.ledger.PaymentAutoPostServices.get#PaymentTypeGlAccount", {
        organizationPartyId: scope.organizationPartyId,
        paymentTypeEnumId: payment.paymentTypeEnumId,
        isApplied: "N",
        isPayable: payment.fromPartyId === scope.organizationPartyId ? "Y" : "N",
        otherPartyId: scope.partyId
    })
    if (!mapped.glAccountId) denied("MAPPING_MISSING", "Configure the payment's unapplied control account")
    cache[key] = mapped.glAccountId
    return mapped.glAccountId
}
function cashEvidence(scope, lock = false, loaded = null) {
    const r = scope.record,
        transactions = loaded
            ? loaded.transactions.filter(row => row.paymentId === r.paymentId)
            : lifecycle.nativeTransactions(r.paymentId, scope.organizationPartyId, lock)
    if (transactions.length !== 1) denied("REFUND_BACKING_INVALID", "One complete original cash posting is required")
    const tx = transactions[0],
        pref = policy.preference(scope.organizationPartyId),
        entries = loaded
            ? loaded.entries.filter(row => row.acctgTransId === tx.acctgTransId)
            : Array.from(
                  find(ENTRY, {acctgTransId: tx.acctgTransId})
                      .orderBy("acctgTransEntrySeqId")
                      .useCache(false)
                      .forUpdate(lock)
                      .list()
              )
    if (
        tx.organizationPartyId !== scope.organizationPartyId ||
        tx.amountUomId !== r.amountUomId ||
        tx.isPosted !== "Y" ||
        tx.glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
        tx.reverseOfAcctgTransId ||
        tx.reversedByAcctgTransId ||
        (pref.errorGlJournalId && pref.errorGlJournalId === tx.glJournalId) ||
        (loaded
            ? loaded.reversedIds.has(tx.acctgTransId)
            : Boolean(find(TX, {reverseOfAcctgTransId: tx.acctgTransId, isPosted: "Y"}).limit(1).one()))
    )
        denied("REFUND_BACKING_INVALID", "Original cash must retain complete actual-currency posted evidence")
    let debit = toDecimal(0),
        credit = toDecimal(0)
    for (const entry of entries) {
        if (!entry.glAccountId || !["D", "C"].includes(entry.debitCreditFlag) || toDecimal(entry.amount || 0).compare(0) < 0)
            denied("REFUND_BACKING_INVALID", "Original cash entries are invalid")
        if (entry.debitCreditFlag === "D") debit = debit.add(entry.amount)
        else credit = credit.add(entry.amount)
    }
    if (!entries.length || !debit.eq(r.amount) || !credit.eq(r.amount))
        denied("REFUND_BACKING_INVALID", "Original cash amount does not match its actual posting")
    const control = controlAccount(scope, r)
    sourceGuard.controlProof({entries}, control, r.fromPartyId === scope.organizationPartyId ? "D" : "C", r.amount)
    const cache = scope._refundCashAccounts || (scope._refundCashAccounts = {}),
        mappingKey = hash(
            policy.pick(map(r), [
                "paymentTypeEnumId",
                "paymentInstrumentEnumId",
                "fromPartyId",
                "toPartyId",
                "paymentMethodId",
                "toPaymentMethodId",
                "overrideGlAccountId",
                "overrideOrgPartyId",
                "finAccountId"
            ])
        ),
        cashAccount =
            cache[mappingKey] ||
            call("mantle.ledger.PaymentAutoPostServices.get#PaymentMethodGlAccount", {
                paymentId: r.paymentId,
                organizationPartyId: scope.organizationPartyId,
                otherPartyId: scope.partyId
            }).glAccountId,
        accounts = scope._refundCashAccountRows || (scope._refundCashAccountRows = {}),
        account = cashAccount && (accounts[cashAccount] || one("mantle.ledger.account.GlAccount", {glAccountId: cashAccount}))
    if (cashAccount) {
        cache[mappingKey] = cashAccount
        accounts[cashAccount] = account
    }
    if (!account || account.glAccountClassEnumId !== "CASH_EQUIVALENT" || cashAccount === control)
        denied("REFUND_BACKING_INVALID", "Original payment lacks an unambiguous mapped cash account")
    sourceGuard.controlProof({entries}, cashAccount, r.fromPartyId === scope.organizationPartyId ? "C" : "D", r.amount)
    return {
        transaction: tx,
        entries,
        controlGlAccountId: control,
        cashGlAccountId: cashAccount,
        postingDay: policy.postingDay(tx),
        version: hash({transaction: map(tx), entries: entries.map(map)})
    }
}
function eligibility(scope) {
    const r = scope.record
    if (
        scope.tradeExcluded ||
        r.paymentTypeEnumId !== "PtInvoicePayment" ||
        r.refundForPaymentId ||
        !["PmntDelivered", "PmntConfirmed"].includes(r.statusId) ||
        r.gatewayRole === "authorization"
    )
        denied("REFUND_SOURCE_UNAVAILABLE", "Choose an actual delivered trade cash payment")
    if (toDecimal(r.amount || 0).compare(0) <= 0 || !r.amountUomId)
        denied("REFUND_BACKING_INVALID", "Original cash money is invalid")
}
function funding(scope, lock = false) {
    eligibility(scope)
    const r = scope.record,
        apps = applications([r.paymentId], lock),
        cash = cashEvidence(scope, lock),
        totals = workflow.paymentTotals(r, apps),
        holds = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentGatewayReservations.js")
            .cashHoldSummary({organizationPartyId: scope.organizationPartyId, paymentId: r.paymentId, lock}),
        refunds = Array.from(
            find(P, {refundForPaymentId: r.paymentId}).orderBy("paymentId").useCache(false).forUpdate(lock).limit(10001).list()
        )
    if (refunds.length > 10000) denied("REFUND_HISTORY_LIMIT", "Refund history requires a bounded reconciliation review")
    if (apps.some(row => toDecimal(row.amountApplied || 0).compare(0) < 0) || totals.unappliedTotal.compare(0) < 0)
        denied("REFUND_HISTORY_INCONSISTENT", "Original funding applications are inconsistent")
    const ids = refunds.map(row => row.paymentId),
        refundApps = applications(ids, lock),
        childTransactions = ids.length
            ? Array.from(
                  find(TX)
                      .condition(
                          ec.entity.conditionFactory.makeCondition(
                              [
                                  ec.entity.conditionFactory.makeCondition("paymentId", "in", ids),
                                  ec.entity.conditionFactory.makeCondition("toPaymentId", "in", ids)
                              ],
                              "or"
                          )
                      )
                      .orderBy("acctgTransId")
                      .useCache(false)
                      .forUpdate(lock)
                      .list()
              )
            : [],
        childResponses = ids.length
            ? Array.from(find("mantle.account.method.PaymentGatewayResponse").condition("paymentId", "in", ids).list())
            : [],
        txs = ids.length
            ? Array.from(
                  find(TX)
                      .condition("paymentId", "in", ids)
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
                      .useCache(false)
                      .forUpdate(lock)
                      .list()
              )
            : [],
        txIds = txs.map(row => row.acctgTransId),
        applicationIds = refundApps.map(row => row.paymentApplicationId),
        applicationTransactions = applicationIds.length
            ? Array.from(
                  find(TX)
                      .condition("paymentApplicationId", "in", applicationIds)
                      .orderBy("acctgTransId")
                      .useCache(false)
                      .forUpdate(lock)
                      .list()
              )
            : [],
        applicationTxIds = applicationTransactions.map(row => row.acctgTransId),
        applicationEntries = applicationTxIds.length
            ? Array.from(
                  find(ENTRY)
                      .condition("acctgTransId", "in", applicationTxIds)
                      .orderBy("acctgTransId,acctgTransEntrySeqId")
                      .useCache(false)
                      .forUpdate(lock)
                      .list()
              )
            : [],
        entries = txIds.length
            ? Array.from(
                  find(ENTRY)
                      .condition("acctgTransId", "in", txIds)
                      .orderBy("acctgTransId,acctgTransEntrySeqId")
                      .useCache(false)
                      .forUpdate(lock)
                      .list()
              )
            : [],
        reversals =
            txIds.length || applicationTxIds.length
                ? Array.from(
                      find(TX)
                          .condition("reverseOfAcctgTransId", "in", [...txIds, ...applicationTxIds])
                          .condition("isPosted", "Y")
                          .list()
                  )
                : [],
        records = Array.from(
            find(RECORD, {originalPaymentId: r.paymentId}).orderBy("refundPaymentId").useCache(false).forUpdate(lock).list()
        ),
        errors = [],
        evidence = []
    let completed = toDecimal(0)
    for (const refund of refunds) {
        try {
            if (
                refund.fromPartyId !== r.toPartyId ||
                refund.toPartyId !== r.fromPartyId ||
                refund.amountUomId !== r.amountUomId ||
                refund.paymentTypeEnumId !== "PtRefund"
            )
                denied("REFUND_HISTORY_INCONSISTENT", "A linked refund has inconsistent party, type or currency identity")
            if (["PmntCancelled", "PmntVoid", "PmntDeclined"].includes(refund.statusId)) {
                if (
                    childTransactions.some(tx => tx.paymentId === refund.paymentId || tx.toPaymentId === refund.paymentId) ||
                    refundApps.some(ap => ap.paymentId === refund.paymentId || ap.toPaymentId === refund.paymentId) ||
                    childResponses.some(row => row.paymentId === refund.paymentId) ||
                    records.some(row => row.refundPaymentId === refund.paymentId) ||
                    refund.finAccountAuthId ||
                    refund.finAccountTransId
                )
                    denied("REFUND_HISTORY_INCONSISTENT", "An abandoned refund still has cash, application or provider history")
                continue
            }
            if (
                refund.fromPartyId !== r.toPartyId ||
                refund.toPartyId !== r.fromPartyId ||
                refund.amountUomId !== r.amountUomId ||
                refund.paymentTypeEnumId !== "PtRefund" ||
                !["PmntDelivered", "PmntConfirmed"].includes(refund.statusId)
            )
                denied("REFUND_HISTORY_INCONSISTENT", "A prior refund has inconsistent identity or unresolved local state")
            const ownApps = refundApps.filter(row => row.paymentId === refund.paymentId || row.toPaymentId === refund.paymentId),
                backing = ownApps.filter(
                    row =>
                        row.paymentId === refund.paymentId &&
                        row.toPaymentId === r.paymentId &&
                        !row.invoiceId &&
                        !row.toInvoiceId
                )
            if (ownApps.length !== 1 || backing.length !== 1 || !toDecimal(backing[0].amountApplied).eq(refund.amount))
                denied("REFUND_HISTORY_INCONSISTENT", "A prior refund lacks exact consumed original funding")
            const rcash = cashEvidence(Object.assign({}, scope, {record: refund}), lock, {
                    transactions: txs,
                    entries,
                    reversedIds: new Set(reversals.map(row => row.reverseOfAcctgTransId))
                }),
                record = records.find(row => row.refundPaymentId === refund.paymentId)
            const reclasses = applicationTransactions.filter(
                    tx => tx.paymentApplicationId === backing[0].paymentApplicationId && !tx.reverseOfAcctgTransId
                ),
                reclass = reclasses[0],
                appDay = reclass && policy.postingDay(reclass),
                outgoing = refund.fromPartyId === scope.organizationPartyId
            if (
                reclasses.length !== 1 ||
                !reclass ||
                reclass.paymentId !== refund.paymentId ||
                reclass.toPaymentId !== r.paymentId ||
                reclass.invoiceId ||
                reclass.toInvoiceId ||
                reclass.reversedByAcctgTransId ||
                reversals.some(tx => tx.reverseOfAcctgTransId === reclass.acctgTransId) ||
                (policy.preference(scope.organizationPartyId).errorGlJournalId &&
                    reclass.glJournalId === policy.preference(scope.organizationPartyId).errorGlJournalId) ||
                appDay < cash.postingDay ||
                appDay < rcash.postingDay ||
                (backing[0].currencyUomId && backing[0].currencyUomId !== r.amountUomId) ||
                (backing[0].accountingDate && policy.calendarDateText(backing[0].accountingDate) !== appDay)
            )
                denied("REFUND_HISTORY_INCONSISTENT", "A prior refund lacks its exact live original-funding reclassification")
            const reclassEntries = applicationEntries.filter(entry => entry.acctgTransId === reclass.acctgTransId)
            exactEntries(
                reclass,
                {
                    organizationPartyId: scope.organizationPartyId,
                    amountUomId: r.amountUomId,
                    acctgTransTypeEnumId: "AttPaymentInOutAppl",
                    lines: [
                        {
                            glAccountId: rcash.controlGlAccountId,
                            debitCreditFlag: outgoing ? "C" : "D",
                            amount: String(refund.amount)
                        },
                        {
                            glAccountId: cash.controlGlAccountId,
                            debitCreditFlag: outgoing ? "D" : "C",
                            amount: String(refund.amount)
                        }
                    ]
                },
                lock,
                reclassEntries
            )
            if (
                record &&
                (record.organizationPartyId !== scope.organizationPartyId ||
                    record.currencyUomId !== r.amountUomId ||
                    record.paymentApplicationId !== backing[0].paymentApplicationId ||
                    !toDecimal(record.amount).eq(refund.amount) ||
                    record.cashAcctgTransId !== rcash.transaction.acctgTransId ||
                    record.applicationAcctgTransId !== reclass.acctgTransId)
            )
                denied("REFUND_RECORD_INVALID", "Recorded refund money disagrees with actual cash and application")
            completed = completed.add(refund.amount)
            evidence.push({
                refund: map(refund),
                application: map(backing[0]),
                cashVersion: rcash.version,
                applicationTransaction: map(reclass),
                applicationEntries: reclassEntries.map(map),
                record: record && map(record)
            })
        } catch (error) {
            ec.logger.error("Refund history payment " + refund.paymentId + ": " + error.message)
            errors.push({reasonCode: String(error.message).split(":")[0]})
        }
    }
    if (records.some(record => !ids.includes(record.refundPaymentId)) || errors.length)
        denied("REFUND_HISTORY_INCONSISTENT", "Prior refund cash or funding is incomplete; review its accounting history")
    const available = totals.unappliedTotal.subtract(holds.heldAmount),
        gross = toDecimal(r.amount).subtract(completed).subtract(holds.heldAmount)
    if (available.compare(0) < 0 || gross.compare(0) < 0)
        denied("REFUND_CAPACITY_INCONSISTENT", "Recorded refunds and reservations exceed original cash")
    const refundable = available.compare(gross) < 0 ? available : gross,
        unrecordedRefunds = evidence
            .map(row => row.refund.paymentId)
            .filter(id => !records.some(record => record.refundPaymentId === id)),
        version = hash({source: workflow.paymentVersion(r, apps), cash: cash.version, refunds: evidence, holds: holds.version})
    return {
        scope,
        applications: apps,
        cash,
        totals,
        holds,
        completed,
        unrecordedRefunds,
        refundable,
        version,
        summary: {
            originalPaymentId: r.paymentId,
            originalCashAmount: String(r.amount),
            completedRefundAmount: String(completed),
            heldRefundAmount: String(holds.heldAmount),
            providerRefundedAmount: null,
            providerRefundableAmount: null,
            unappliedTotal: String(totals.unappliedTotal),
            reservedAmount: String(holds.heldAmount),
            availableAmount: String(available),
            refundableAmount: String(refundable),
            currencyUomId: r.amountUomId,
            refundCashDirection: scope.cashDirection === "incoming" ? "outgoing" : "incoming",
            financeDirection: scope.financeDirection,
            version,
            complete: true,
            errors: [],
            reasons: unrecordedRefunds.length ? ["LEGACY_REFUND_HISTORY_REVIEW_REQUIRED"] : []
        }
    }
}
function defaults(scope) {
    const request = lifecycle.methodRequest(scope),
        r = scope.record
    return Object.assign(
        policy.pick(request, [
            "organizationPaymentMethodId",
            "organizationMethodVersion",
            "counterpartyPaymentMethodId",
            "counterpartyMethodVersion"
        ]),
        {
            paymentInstrumentEnumId: workflow.manualInstruments.includes(r.paymentInstrumentEnumId)
                ? r.paymentInstrumentEnumId
                : "PiOther"
        }
    )
}
function providerBacked(scope) {
    return Boolean(
        scope.record.gatewayRole ||
            scope.record.gatewayAttemptId ||
            find("mantle.account.method.PaymentGatewayResponse", {paymentId: scope.record.paymentId}).limit(1).one()
    )
}
function capabilities(scope, summary) {
    const provider = Boolean(providerBacked(scope) || legacy.adoptionRefusal(scope.record)),
        currencyMatches = scope.record.amountUomId === policy.preference(scope.organizationPartyId).baseCurrencyUomId,
        canPreview = Boolean(
            scope.broad &&
                lib.has("PAYMENT_EDIT") &&
                scope.guardEnabled &&
                currencyMatches &&
                summary.complete &&
                !provider &&
                !summary.reasons.includes("LEGACY_REFUND_HISTORY_REVIEW_REQUIRED") &&
                toDecimal(summary.refundableAmount || 0).compare(0) > 0
        ),
        reasons = []
    if (!lib.has("PAYMENT_EDIT")) reasons.push("PERMISSION_DENIED")
    if (!scope.guardEnabled) reasons.push("SETTLEMENT_GUARD_REQUIRED")
    if (provider) reasons.push("GATEWAY_REFUND_REQUIRED")
    if (!currencyMatches) reasons.push("CURRENCY_MISMATCH")
    if (summary.complete && toDecimal(summary.refundableAmount || 0).compare(0) <= 0) reasons.push("REFUND_FUNDS_UNAVAILABLE")
    if (!summary.complete) reasons.push(...summary.reasons)
    else if (summary.reasons.includes("LEGACY_REFUND_HISTORY_REVIEW_REQUIRED"))
        reasons.push("LEGACY_REFUND_HISTORY_REVIEW_REQUIRED")
    return {
        canPreviewRefund: canPreview,
        canRefund: canPreview && financialWriterAvailable,
        canGatewayRefund:
            scope.record.gatewayRole === "capture" && summary.complete
                ? ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayRefunds.js").capabilities(scope)
                      .canGatewayRefund
                : false,
        canReadLedger: workflow.ledgerRead(),
        guardEnabled: scope.guardEnabled,
        reasons,
        refundUnavailableReason: financialWriterAvailable ? null : "REFUND_CONFIRM_UNAVAILABLE"
    }
}
function summary(p) {
    const scope = scopeFor(p)
    let result
    try {
        result =
            scope.record.gatewayRole === "capture"
                ? ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayRefunds.js").summary(scope)
                      .summary
                : funding(scope).summary
    } catch (error) {
        ec.logger.error("Refund summary original " + scope.record.paymentId + ": " + error.message)
        result = {
            originalPaymentId: scope.record.paymentId,
            currencyUomId: scope.record.amountUomId,
            refundCashDirection: scope.cashDirection === "incoming" ? "outgoing" : "incoming",
            financeDirection: scope.financeDirection,
            complete: false,
            errors: [{reasonCode: publicReason(error)}],
            reasons: [publicReason(error)]
        }
    }
    let refundDefaults = {}
    try {
        refundDefaults = scope.record.gatewayRole === "capture" ? {} : defaults(scope)
    } catch (error) {
        ec.logger.error("Refund default methods for original " + scope.record.paymentId + ": " + error.message)
        result.errors.push({reasonCode: "REFUND_DEFAULTS_UNAVAILABLE"})
    }
    return {refundSummary: result, refundDefaults, capabilities: capabilities(scope, result)}
}
function draftQuery(scope, p, text = true) {
    const r = scope.record,
        cf = ec.entity.conditionFactory
    let q = find("mantle.account.payment.PaymentRefundDraftRead")
        .condition("fromPartyId", r.toPartyId)
        .condition("toPartyId", r.fromPartyId)
        .condition("amountUomId", r.amountUomId)
        .condition("statusId", "in", ["PmntProposed", "PmntPromised"])
        .condition("paymentTypeEnumId", "PtInvoicePayment")
        .condition("refundForPaymentId", "is-null", null)
        .condition("gatewayRole", "is-null", null)
        .condition("gatewayInstructionId", "is-null", null)
        .condition("gatewayAttemptId", "is-null", null)
    q = q.condition("paymentId", "not-equals", r.paymentId)
    for (const field of [
        "sourceApplicationCount",
        "targetApplicationCount",
        "postingCount",
        "targetPostingCount",
        "providerCount"
    ])
        q = q.condition(field, "equals", 0)
    q = q.condition(
        cf.makeCondition(
            [
                cf.makeCondition("lifecycleManaged", "equals", "Y"),
                cf.makeCondition(
                    [
                        cf.makeCondition("sourceGatewayConfigId", "is-null", null),
                        cf.makeCondition("targetGatewayConfigId", "is-null", null),
                        cf.makeCondition("paymentGatewayConfigId", "is-null", null),
                        cf.makeCondition("finAccountId", "is-null", null),
                        cf.makeCondition(
                            [
                                cf.makeCondition("sourceMethodTypeEnumId", "is-null", null),
                                cf.makeCondition("sourceMethodTypeEnumId", "in", ["PmtBankAccount", "PmtOther"])
                            ],
                            "or"
                        ),
                        cf.makeCondition(
                            [
                                cf.makeCondition("targetMethodTypeEnumId", "is-null", null),
                                cf.makeCondition("targetMethodTypeEnumId", "in", ["PmtBankAccount", "PmtOther"])
                            ],
                            "or"
                        ),
                        cf.makeCondition("paymentInstrumentEnumId", "in", workflow.manualInstruments)
                    ],
                    "and"
                )
            ],
            "or"
        )
    )
    q = q.condition(
        cf.makeCondition(
            [cf.makeCondition("draftClaimStatus", "is-null", null), cf.makeCondition("draftClaimStatus", "not-equals", "held")],
            "or"
        )
    )
    q = q.condition(
        cf.makeCondition(
            [
                cf.makeCondition("everEnteredProvider", "is-null", null),
                cf.makeCondition("everEnteredProvider", "not-equals", "Y")
            ],
            "or"
        )
    )
    if (text && p.text) {
        const needle = "%" + String(p.text).trim() + "%"
        q = q.condition(
            cf.makeCondition(
                ["paymentId", "paymentRefNum", "comments"].map(field => cf.makeCondition(field, "like", needle).ignoreCase()),
                "or"
            )
        )
    }
    return q
}
function findDrafts(p) {
    const scope = scopeFor(p, true),
        ids = [...new Set(Array.from(p.selectedPaymentIdList || []).map(String))]
    eligibility(scope)
    if (ids.length > 200) denied("PAYMENT_SELECTION_LIMIT", "Select at most two hundred refund drafts")
    const count = draftQuery(scope, p).count(),
        page = lib.page(draftQuery(scope, p).orderBy("effectiveDate,paymentId"), p, "records", count),
        selected = ids.length ? Array.from(draftQuery(scope, p, false).condition("paymentId", "in", ids).list()) : [],
        all = [...page.rows, ...selected],
        baseRows = all.length
            ? Array.from(
                  find(P)
                      .condition("paymentId", "in", [...new Set(all.map(row => row.paymentId))])
                      .list()
              )
            : [],
        names = lib.partyNames([scope.partyId, scope.organizationPartyId]),
        labels = Object.fromEntries(
            Array.from(find("moqui.basic.StatusItem").condition("statusId", "in", ["PmntProposed", "PmntPromised"]).list()).map(
                row => [row.statusId, row.description]
            )
        ),
        project = row => ({
            paymentId: row.paymentId,
            sourceVersion: workflow.paymentVersion(
                baseRows.find(base => base.paymentId === row.paymentId),
                []
            ),
            amount: String(row.amount),
            currencyUomId: row.amountUomId,
            cashDirection: row.fromPartyId === scope.organizationPartyId ? "outgoing" : "incoming",
            partyId: scope.partyId,
            partyName: names[scope.partyId],
            accountingDateText: row.accountingDate
                ? policy.calendarDateText(row.accountingDate)
                : ec.l10n.format(row.effectiveDate, "yyyy-MM-dd"),
            statusId: row.statusId,
            statusDescription: labels[row.statusId] || row.statusId,
            referenceNumber: row.paymentRefNum,
            canSelect: true,
            reasons: []
        })
    return Object.assign(
        policy.pick(page, ["recordCount", "pageIndex", "pageSize", "pageMaxIndex", "pageRangeLow", "pageRangeHigh"]),
        {rows: page.rows.map(project), selectedRows: selected.map(project), complete: true, errors: []}
    )
}
function draft(scope, p, lock = false, claimAttemptId = null) {
    if (!p.refundPaymentId) return null
    const candidate = scopeFor({organizationPartyId: scope.organizationPartyId, paymentId: p.refundPaymentId}, true, lock)
    if (!p.refundSourceVersion || workflow.paymentVersion(candidate.record) !== p.refundSourceVersion)
        denied("STALE_REVISION", "The selected refund draft changed")
    const row = candidate.record,
        r = scope.record
    if (
        row.fromPartyId !== r.toPartyId ||
        row.toPartyId !== r.fromPartyId ||
        row.amountUomId !== r.amountUomId ||
        row.paymentTypeEnumId !== "PtInvoicePayment" ||
        !["PmntProposed", "PmntPromised"].includes(row.statusId) ||
        row.refundForPaymentId ||
        row.gatewayRole ||
        row.gatewayInstructionId ||
        row.gatewayAttemptId ||
        legacy.adoptionRefusal(row)
    )
        denied("REFUND_DRAFT_UNAVAILABLE", "Select an opposing clean manual draft in the original currency")
    const claim = heldDraftClaim({paymentId: row.paymentId, organizationPartyId: scope.organizationPartyId, lock})
    if (claim && claim.attemptId !== claimAttemptId) denied("REFUND_DRAFT_CLAIMED", "This draft is held by a provider refund")
    if (
        applications([row.paymentId], lock).length ||
        find(TX)
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("paymentId", "equals", row.paymentId),
                        ec.entity.conditionFactory.makeCondition("toPaymentId", "equals", row.paymentId)
                    ],
                    "or"
                )
            )
            .useCache(false)
            .forUpdate(lock)
            .limit(1)
            .one() ||
        find("mantle.account.method.PaymentGatewayResponse", {paymentId: row.paymentId}).limit(1).one()
    )
        denied("REFUND_DRAFT_UNAVAILABLE", "The refund draft already has financial or provider history")
    return candidate
}
function normalized(p, lock = false, provider = null) {
    const scope = scopeFor(p, true, lock),
        r = scope.record
    lifecycle.requireGuard(scope)
    if (r.amountUomId !== policy.preference(scope.organizationPartyId).baseCurrencyUomId)
        denied("CURRENCY_MISMATCH", "Refunds require the organization's adopted base currency")
    eligibility(scope)
    if (!provider && providerBacked(scope))
        denied("GATEWAY_REFUND_REQUIRED", "Provider-backed cash requires its original provider refund workflow")
    if (!provider) legacy.assertAdoptable(r)
    const f = funding(scope, lock)
    if (f.unrecordedRefunds.length)
        denied(
            "LEGACY_REFUND_HISTORY_REVIEW_REQUIRED",
            "Verified prior legacy refunds require a separate historical funding review before new refunds"
        )
    if (!p.sourceVersion || p.sourceVersion !== workflow.paymentVersion(r, f.applications))
        denied("STALE_REVISION", "Original cash or its applications changed")
    let amount
    try {
        amount = toDecimal(p.amount)
    } catch (_) {
        denied("AMOUNT_INVALID", "Enter a positive refund amount")
    }
    if (!amount || amount.compare(0) <= 0) denied("AMOUNT_INVALID", "Enter a positive refund amount")
    if (!amount.eq(ec.l10n.roundCurrency(amount, r.amountUomId)))
        denied("CURRENCY_PRECISION", "The refund exceeds currency precision")
    if (!provider?.reserved && amount.compare(f.refundable) > 0)
        denied("REFUND_FUNDS_UNAVAILABLE", "The refund exceeds currently available unreserved original cash")
    const date = settlement.dateInput(p.effectiveDate, p._accountingDay || null)
    if (date.day < f.cash.postingDay)
        denied("REFUND_BEFORE_ORIGINAL_CASH", "The refund day cannot precede original actual cash posting")
    const linked = provider && Object.prototype.hasOwnProperty.call(provider, "linked") ? provider.linked : draft(scope, p, lock),
        instrument =
            p.paymentInstrumentEnumId || linked?.record.paymentInstrumentEnumId || defaults(scope).paymentInstrumentEnumId
    if (!provider && (!workflow.manualInstruments.includes(instrument) || ["PiWriteOff", "PiDiscount"].includes(instrument)))
        denied("REFUND_INSTRUMENT_UNAVAILABLE", "Choose a manual cash refund instrument")
    const referenceNumber = String(p.referenceNumber || "").trim(),
        reason = String(p.reason || "").trim()
    if ((!provider && !referenceNumber) || referenceNumber.length > 60 || !reason || reason.length > 4000)
        denied("PAYMENT_EVIDENCE_REQUIRED", "Enter a human reference and reason for the refund")
    const requestMethods = {
            partyId: scope.partyId,
            currencyUomId: r.amountUomId,
            organizationPaymentMethodId: p.organizationPaymentMethodId,
            organizationMethodVersion: p.organizationMethodVersion,
            counterpartyPaymentMethodId: p.counterpartyPaymentMethodId || null,
            counterpartyMethodVersion: p.counterpartyMethodVersion || null
        },
        methods = provider?.methods || lifecycle.methodEvidence(scope, requestMethods, date.timestamp, lock)
    const outgoing = scope.cashDirection === "incoming",
        refund = Object.assign({}, map(r), {
            paymentId: linked?.record.paymentId || null,
            paymentTypeEnumId: "PtRefund",
            paymentInstrumentEnumId: instrument,
            fromPartyId: r.toPartyId,
            toPartyId: r.fromPartyId,
            paymentMethodId: outgoing ? p.organizationPaymentMethodId : p.counterpartyPaymentMethodId || null,
            toPaymentMethodId: outgoing ? p.counterpartyPaymentMethodId || null : p.organizationPaymentMethodId,
            amount,
            currencyUomId: r.amountUomId,
            amountUomId: r.amountUomId,
            effectiveDate: date.timestamp,
            accountingDate: date.day,
            refundForPaymentId: r.paymentId,
            forInvoiceId: null,
            overrideGlAccountId: null,
            overrideOrgPartyId: null,
            paymentGatewayConfigId: null,
            gatewayInstructionId: null,
            gatewayAttemptId: null,
            gatewayRole: null,
            financeOrganizationPartyId: scope.organizationPartyId,
            financeDirection: scope.financeDirection
        }),
        refundScope = Object.assign({}, scope, {record: refund, cashDirection: outgoing ? "outgoing" : "incoming"}),
        refundControl = controlAccount(refundScope, refund),
        cashPlan = refundCashPlan(refundScope, methods, refundControl),
        applicationPlan = {
            organizationPartyId: scope.organizationPartyId,
            acctgTransTypeEnumId: "AttPaymentInOutAppl",
            amountUomId: r.amountUomId,
            transactionDate: date.timestamp,
            lines: [
                {glAccountId: refundControl, debitCreditFlag: outgoing ? "C" : "D", amount: String(amount)},
                {glAccountId: f.cash.controlGlAccountId, debitCreditFlag: outgoing ? "D" : "C", amount: String(amount)}
            ]
        },
        plans = [cashPlan, applicationPlan],
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
        evidence =
            provider && Object.prototype.hasOwnProperty.call(provider, "evidence")
                ? provider.evidence
                : lifecycle.selectedEvidence(scope, p, lock),
        names = lib.partyNames([scope.partyId, scope.organizationPartyId]),
        after = Object.assign({}, f.summary, {
            completedRefundAmount: String(f.completed.add(amount)),
            unappliedTotal: String(f.totals.unappliedTotal.subtract(amount)),
            availableAmount: String(toDecimal(f.summary.availableAmount).subtract(amount)),
            refundableAmount: String(f.refundable.subtract(amount))
        }),
        request = {
            organizationPartyId: scope.organizationPartyId,
            paymentId: r.paymentId,
            sourceVersion: p.sourceVersion,
            refundPaymentId: linked?.record.paymentId || null,
            refundSourceVersion: p.refundSourceVersion || null,
            amount: String(amount),
            effectiveDate: date.timestamp,
            _accountingDay: date.day,
            paymentInstrumentEnumId: instrument,
            referenceNumber,
            reason,
            ...policy.pick(requestMethods, [
                "organizationPaymentMethodId",
                "organizationMethodVersion",
                "counterpartyPaymentMethodId",
                "counterpartyMethodVersion"
            ]),
            evidenceContentIdList: evidence.map(row => row.manifest.paymentContentId),
            evidenceVersions: Object.fromEntries(evidence.map(row => [row.manifest.paymentContentId, row.manifest.version]))
        },
        dto = {
            organizationPartyId: scope.organizationPartyId,
            paymentId: r.paymentId,
            originalPaymentId: r.paymentId,
            refundPaymentId: request.refundPaymentId,
            sourceVersion: request.sourceVersion,
            refundSourceVersion: request.refundSourceVersion,
            previewKind: "refund",
            paymentInstrumentEnumId: instrument,
            paymentSummary: {
                paymentId: r.paymentId,
                amount: String(amount),
                currencyUomId: r.amountUomId,
                partyId: scope.partyId,
                partyName: names[scope.partyId],
                organizationName: names[scope.organizationPartyId],
                cashDirection: refundScope.cashDirection,
                accountingDateText: date.day,
                maskedMethodLabel: workflow.methodRows([methods.organizationMethod])[0].label,
                referenceNumber
            },
            refundSummary: f.summary,
            refundDefaults: policy.pick(request, [
                "paymentInstrumentEnumId",
                "organizationPaymentMethodId",
                "organizationMethodVersion",
                "counterpartyPaymentMethodId",
                "counterpartyMethodVersion"
            ]),
            reviewedMethods: {
                organization: {
                    paymentMethodId: methods.organizationMethod.paymentMethodId,
                    version: request.organizationMethodVersion,
                    label: workflow.methodRows([methods.organizationMethod])[0].label
                },
                counterparty: methods.counterpartyMethod
                    ? {
                          paymentMethodId: methods.counterpartyMethod.paymentMethodId,
                          version: request.counterpartyMethodVersion,
                          label: workflow.methodRows([methods.counterpartyMethod])[0].label
                      }
                    : null
            },
            before: f.summary,
            after,
            applicationEffects: [
                {
                    paymentId: request.refundPaymentId,
                    toPaymentId: r.paymentId,
                    amountOriginallyApplied: "0",
                    afterAmountApplied: String(amount),
                    currencyUomId: r.amountUomId,
                    accountingDateText: date.day
                }
            ],
            postingSummary: {
                cashPostingCount: 1,
                applicationPostingCount: 1,
                effect: "Post opposite cash and consume the same amount of original unapplied funding"
            },
            ledgerPreview: plans,
            evidenceRows: evidence.map(row => row.manifest),
            capabilities: capabilities(scope, f.summary),
            canApply: financialWriterAvailable,
            blockers: financialWriterAvailable
                ? []
                : [
                      {
                          reasonCode: "REFUND_CONFIRM_UNAVAILABLE",
                          message: "Reviewed confirmation is not available in this foundation checkpoint"
                      }
                  ],
            effectiveDateText: date.day,
            reason,
            referenceNumber
        }
    const fingerprint = hash({
        request,
        funding: f.version,
        draft: linked && workflow.paymentVersion(linked.record, []),
        methods: methods.versions,
        policy: policyEvidence,
        plans,
        evidence: dto.evidenceRows
    })
    return {
        scope,
        funding: f,
        linked,
        amount,
        date,
        methods,
        refundScope,
        request,
        dto,
        plans,
        policyEvidence,
        evidence,
        fingerprint
    }
}
function refundCashPlan(scope, methods, control) {
    const r = scope.record,
        outgoing = scope.cashDirection === "outgoing"
    let cash = methods.organizationMethod.glAccountId
    if (!cash) {
        const chain = call("mantle.ledger.LedgerServices.expand#ParentOrganizationList", {
            organizationPartyId: scope.organizationPartyId
        }).orgPartyIdList || [scope.organizationPartyId]
        for (const payable of [outgoing ? "Y" : "N", "E"]) {
            const mapped = find("mantle.ledger.config.PaymentInstrumentGlAccount")
                .condition("organizationPartyId", "in", chain)
                .condition("paymentInstrumentEnumId", r.paymentInstrumentEnumId)
                .condition("isPayable", payable)
                .one()
            if (mapped?.glAccountId) {
                cash = mapped.glAccountId
                break
            }
        }
    }
    if (!cash) denied("MAPPING_MISSING", "Configure the refund cash account for the selected method or instrument")
    if (one("mantle.ledger.account.GlAccount", {glAccountId: cash})?.glAccountClassEnumId !== "CASH_EQUIVALENT")
        denied("MAPPING_MISSING", "Configure an actual cash account for the selected refund method or instrument")
    return {
        organizationPartyId: scope.organizationPartyId,
        acctgTransTypeEnumId: outgoing ? "AttOutgoingPayment" : "AttIncomingPayment",
        amountUomId: r.amountUomId,
        transactionDate: r.effectiveDate,
        lines: [
            {glAccountId: control, debitCreditFlag: outgoing ? "D" : "C", amount: String(r.amount)},
            {glAccountId: cash, debitCreditFlag: outgoing ? "C" : "D", amount: String(r.amount)}
        ]
    }
}
function projectPreview(row, scope) {
    const out = Object.assign({}, json(row.payloadJson), {
        previewId: row.previewId,
        inputFingerprint: row.inputFingerprint,
        status: row.status,
        operationKey: row.operationKey,
        expiresDate: row.expiresDate
    })
    out.capabilities = capabilities(scope, out.refundSummary)
    out.canApply =
        financialWriterAvailable &&
        row.status === "review" &&
        lib.ms(row.expiresDate) > Number(ec.user.nowTimestamp) &&
        out.capabilities.canRefund
    if (!workflow.ledgerRead()) delete out.ledgerPreview
    if (row.resultJson) out.results = projectResult(json(row.resultJson), scope)
    return out
}
function preview(p) {
    const n = normalized(p),
        previewId = ec.user.randomString(32)
    call("create#" + PREVIEW, {
        previewId,
        organizationPartyId: n.scope.organizationPartyId,
        paymentId: n.scope.record.paymentId,
        refundPaymentId: n.request.refundPaymentId || ec.user.randomString(32),
        userId: ec.user.userId,
        sourceVersion: n.request.sourceVersion,
        refundSourceVersion: n.request.refundSourceVersion,
        amount: n.amount,
        currencyUomId: n.scope.record.amountUomId,
        effectiveDate: n.date.timestamp,
        accountingDate: n.date.day,
        inputFingerprint: n.fingerprint,
        requestJson: JSON.stringify(n.request),
        payloadJson: JSON.stringify(n.dto),
        status: "review",
        createdDate: ec.user.nowTimestamp,
        expiresDate: Number(ec.user.nowTimestamp) + 1800000
    })
    return projectPreview(one(PREVIEW, {previewId}), n.scope)
}
function retained(p, write = false, lock = false) {
    let row = one(PREVIEW, {previewId: p.previewId})
    if (!row || row.userId !== ec.user.userId) denied("REFUND_PREVIEW_UNAVAILABLE", "The refund review is unavailable")
    const scope = scopeFor(
        {organizationPartyId: p.organizationPartyId || row.organizationPartyId, paymentId: row.paymentId},
        write,
        lock
    )
    if (scope.organizationPartyId !== row.organizationPartyId)
        denied("REFUND_PREVIEW_UNAVAILABLE", "The refund review belongs to another organization")
    if (lock) row = find(PREVIEW, {previewId: row.previewId}).useCache(false).forUpdate(true).one()
    return {row, scope, request: json(row.requestJson)}
}
function getPreview(p) {
    const r = retained(p)
    return projectPreview(r.row, r.scope)
}
function projectResult(result, scope) {
    const out = Object.assign({}, result)
    if (!workflow.ledgerRead()) delete out.acctgTransIds
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
function lockReview(p) {
    const first = retained(p, true, false),
        org = first.scope.organizationPartyId
    lib.organization(org, null, true)
    const initial = Array.from(find(P, {refundForPaymentId: first.row.paymentId}).useCache(false).limit(10001).list())
    if (initial.length > 10000) denied("REFUND_HISTORY_LIMIT", "Refund history requires a bounded reconciliation review")
    for (const child of initial)
        if (
            child.fromPartyId !== first.scope.record.toPartyId ||
            child.toPartyId !== first.scope.record.fromPartyId ||
            child.amountUomId !== first.scope.record.amountUomId
        )
            denied("REFUND_HISTORY_INCONSISTENT", "A prior refund has inconsistent party or currency identity")
    const ids = [
        ...new Set([first.row.paymentId, first.request.refundPaymentId, ...initial.map(row => row.paymentId)].filter(Boolean))
    ].sort()
    Array.from(find(P).condition("paymentId", "in", ids).orderBy("paymentId").useCache(false).forUpdate(true).list())
    const current = Array.from(find(P, {refundForPaymentId: first.row.paymentId}).useCache(false).forUpdate(true).list())
    if (current.some(child => !ids.includes(child.paymentId)))
        denied("REFUND_HISTORY_CHANGED", "Refund child membership changed; review it again")
    return retained(p, true, true)
}
function exactEntries(tx, plan, lock = false, loaded = null) {
    if (
        !tx ||
        tx.isPosted !== "Y" ||
        tx.glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
        tx.amountUomId !== plan.amountUomId ||
        tx.organizationPartyId !== plan.organizationPartyId ||
        tx.acctgTransTypeEnumId !== plan.acctgTransTypeEnumId
    )
        denied("REFUND_POSTING_MISMATCH", "The actual refund posting does not match its reviewed identity")
    const entries =
            loaded ||
            Array.from(
                find(ENTRY, {acctgTransId: tx.acctgTransId})
                    .orderBy("acctgTransEntrySeqId")
                    .useCache(false)
                    .forUpdate(lock)
                    .list()
            ),
        actual = {},
        expected = {}
    for (const [target, lines] of [
        [actual, entries],
        [expected, plan.lines]
    ])
        for (const line of lines) {
            if (!line.glAccountId || !["D", "C"].includes(line.debitCreditFlag) || toDecimal(line.amount || 0).compare(0) < 0)
                denied("REFUND_POSTING_MISMATCH", "Refund entries are invalid")
            const key = line.glAccountId + ":" + line.debitCreditFlag
            target[key] = (target[key] || toDecimal(0)).add(line.amount)
        }
    if (
        Object.keys(actual).length !== Object.keys(expected).length ||
        Object.keys(expected).some(key => !actual[key] || !actual[key].eq(expected[key]))
    )
        denied("REFUND_POSTING_MISMATCH", "Actual refund accounts, sides and amounts differ from review")
    return entries
}
function refund(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const retainedReview = lockReview(p),
        row = retainedReview.row,
        scope = retainedReview.scope,
        operationKey = String(p.operationKey || ""),
        operationType = "PaymentRefund",
        requestHash = hash({previewId: p.previewId, inputFingerprint: p.inputFingerprint})
    if (!operationKey || operationKey.length > 40)
        denied("OPERATION_KEY_REQUIRED", "Use an operation key of at most forty characters")
    const old = find(lib.operationEntity, {operationKey}).useCache(false).forUpdate(true).one()
    if (old) {
        if (
            old.operationType !== operationType ||
            old.organizationPartyId !== scope.organizationPartyId ||
            old.userId !== ec.user.userId ||
            old.requestHash !== requestHash
        )
            denied("OPERATION_KEY_CONFLICT", "This key belongs to another reviewed operation")
        return projectResult(lib.previous({old}), scope)
    }
    if (p.inputFingerprint !== row.inputFingerprint) denied("REFUND_PREVIEW_MISMATCH", "Confirm the retained refund review")
    if (row.status !== "review") denied("REFUND_PREVIEW_CONSUMED", "This refund review already has a recorded confirmation")
    if (lib.ms(row.expiresDate) <= Number(ec.user.nowTimestamp))
        denied("REFUND_PREVIEW_EXPIRED", "Review the refund again before confirmation")
    const n = normalized(retainedReview.request, true)
    if (n.fingerprint !== row.inputFingerprint)
        denied("STALE_PREVIEW", "Original funding, draft, banking identity, policy or evidence changed")
    // All rows and financial evidence are already locked. Fence acquisition is deliberately last, immediately before
    // adoption/money, so an old provider leaf cannot enter after a reviewed manual source has been adopted.
    legacy.assertAdoptable(n.scope.record, true)
    if (n.linked) legacy.assertAdoptable(n.linked.record, true)
    const op = {operationKey, operationType, organizationPartyId: scope.organizationPartyId, requestHash}
    if (n.scope.record.lifecycleManaged !== "Y") {
        n.scope.record.set("lifecycleManaged", "Y")
        n.scope.record.set("financeOrganizationPartyId", scope.organizationPartyId)
        n.scope.record.set("financeDirection", scope.financeDirection)
        n.scope.record.update()
    }
    const refundPaymentId = row.refundPaymentId,
        result = completeMoney(n, refundPaymentId, op)
    row.set("status", "complete")
    row.set("operationKey", operationKey)
    row.set("resultJson", JSON.stringify(result))
    row.update()
    lib.complete(op, RECORD, refundPaymentId, result)
    return projectResult(result, scope)
}
function completeMoney(n, refundPaymentId, op, attempt = null) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const controller = ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => name.startsWith("mantle.account.PaymentServices."))
    if (
        controller !== "mantle.account.PaymentServices.refund#ReviewedPayment" &&
        controller !== "mantle.account.PaymentServices.complete#PaymentGatewayAttempt"
    )
        denied("REFUND_REVIEW_REQUIRED", "Use the exact reviewed refund controller")
    if (
        attempt &&
        (controller !== "mantle.account.PaymentServices.complete#PaymentGatewayAttempt" ||
            attempt.action !== "refund" ||
            attempt.providerState !== "accepted" ||
            attempt.cashPaymentId !== refundPaymentId)
    )
        denied("GATEWAY_NOT_ACCEPTED", "Provider refund money requires its exact accepted attempt")
    const scope = n.scope,
        operationKey = op.operationKey,
        existing = find(P, {paymentId: refundPaymentId}).useCache(false).forUpdate(true).one()
    if ((n.linked && !existing) || (!n.linked && existing))
        denied("REFUND_DRAFT_UNAVAILABLE", "The reviewed child identity is no longer available")
    const values = {
        paymentId: refundPaymentId,
        paymentTypeEnumId: "PtRefund",
        paymentInstrumentEnumId: n.request.paymentInstrumentEnumId,
        statusId: "PmntDelivered",
        fromPartyId: n.scope.record.toPartyId,
        toPartyId: n.scope.record.fromPartyId,
        amount: n.amount,
        amountUomId: n.scope.record.amountUomId,
        effectiveDate: n.date.timestamp,
        accountingDate: n.date.day,
        financeOrganizationPartyId: scope.organizationPartyId,
        financeDirection: scope.financeDirection,
        lifecycleManaged: "Y",
        refundForPaymentId: n.scope.record.paymentId,
        paymentMethodId: n.refundScope.record.paymentMethodId,
        toPaymentMethodId: n.refundScope.record.toPaymentMethodId,
        paymentGatewayConfigId: attempt?.paymentGatewayConfigId || null,
        gatewayInstructionId: attempt?.instructionId || null,
        gatewayAttemptId: attempt?.attemptId || null,
        gatewayRole: attempt ? "refund" : null,
        overrideGlAccountId: null,
        overrideOrgPartyId: null,
        forInvoiceId: null,
        paymentRefNum: n.request.referenceNumber,
        paymentAuthCode: null,
        comments: n.request.reason,
        reconcileStatusId: "PmtrNot",
        orderId: n.scope.record.orderId || null,
        orderPartSeqId: n.scope.record.orderPartSeqId || null,
        orderItemSeqId: n.scope.record.orderItemSeqId || null
    }
    const child = existing || ec.entity.makeValue(P)
    for (const [field, value] of Object.entries(values)) child.set(field, value)
    if (existing) child.update()
    else child.create()
    if (
        !attempt &&
        n.refundScope.cashDirection === "outgoing" &&
        ["PiCompanyCheck", "PiCertifiedCheck"].includes(n.request.paymentInstrumentEnumId)
    ) {
        const check = one("mantle.account.method.BankAccountCheck", {paymentId: refundPaymentId})
        if (check && check.paymentMethodId !== values.paymentMethodId)
            denied("CHECK_NUMBER_CONFLICT", "The existing check belongs to a different refund bank account")
        if (!check) call("mantle.account.PaymentServices.assign#BankAccountCheckNumber", {paymentId: refundPaymentId})
    }
    call("mantle.ledger.PaymentAutoPostServices.post#Payment", {paymentId: refundPaymentId})
    let actualScope = workflow.paymentScope(
        {organizationPartyId: scope.organizationPartyId, paymentId: refundPaymentId},
        true,
        true
    )
    const cashIds = lifecycle.verifyCash(actualScope, [n.plans[0]])
    if (cashIds.length !== 1) denied("REFUND_POSTING_MISMATCH", "The refund requires one actual cash posting")
    const cashTx = find(TX, {acctgTransId: cashIds[0]}).useCache(false).forUpdate(true).one()
    if (policy.postingDay(cashTx) !== n.date.day || lib.ms(cashTx.transactionDate) !== lib.ms(n.date.timestamp))
        denied("REFUND_POSTING_MISMATCH", "Refund cash must retain its reviewed timestamp and SQL day")
    exactEntries(cashTx, n.plans[0], true)
    const applicationId = ec.user.randomString(32)
    call("create#" + A, {
        paymentApplicationId: applicationId,
        paymentId: refundPaymentId,
        toPaymentId: n.scope.record.paymentId,
        amountApplied: n.amount,
        currencyUomId: n.scope.record.amountUomId,
        appliedDate: n.date.timestamp,
        accountingDate: n.date.day
    })
    const application = find(A, {paymentApplicationId: applicationId}).useCache(false).forUpdate(true).one(),
        apTx = Array.from(
            find(TX, {paymentApplicationId: applicationId, organizationPartyId: scope.organizationPartyId})
                .useCache(false)
                .forUpdate(true)
                .list()
        )
    if (
        !application ||
        !toDecimal(application.amountApplied).eq(n.amount) ||
        application.paymentId !== refundPaymentId ||
        application.toPaymentId !== n.scope.record.paymentId ||
        application.currencyUomId !== n.scope.record.amountUomId ||
        policy.calendarDateText(application.accountingDate) !== n.date.day ||
        apTx.length !== 1 ||
        apTx[0].paymentId !== refundPaymentId ||
        apTx[0].toPaymentId !== n.scope.record.paymentId ||
        policy.postingDay(apTx[0]) !== n.date.day
    )
        denied("REFUND_POSTING_MISMATCH", "The actual refund application and book day must equal the reviewed exact amount")
    exactEntries(apTx[0], n.plans[1], true)
    actualScope = workflow.paymentScope({organizationPartyId: scope.organizationPartyId, paymentId: refundPaymentId}, true, true)
    const source = find(P, {paymentId: n.scope.record.paymentId}).useCache(false).forUpdate(true).one(),
        remaining = workflow.paymentTotals(source, applications([source.paymentId], true)),
        refundTotals = workflow.paymentTotals(actualScope.record, applications([refundPaymentId], true))
    if (!remaining.unappliedTotal.eq(n.funding.totals.unappliedTotal.subtract(n.amount)) || !refundTotals.unappliedTotal.isZero())
        denied("REFUND_POSTING_MISMATCH", "Actual consumed funding differs from review")
    const acctgTransIds = [cashIds[0], apTx[0].acctgTransId],
        event = lifecycle.event(
            actualScope,
            attempt ? "gatewayRefund" : "refund",
            n.linked?.record.statusId || null,
            op,
            {
                reason: n.request.reason,
                referenceNumber: n.request.referenceNumber,
                sourceVersion: workflow.paymentVersion(actualScope.record),
                postingEffects: {originalPaymentId: source.paymentId, refundPaymentId, paymentApplicationId: applicationId}
            },
            [],
            acctgTransIds
        )
    lifecycle.freezeEvidence(actualScope, event.paymentLifecycleEventId, n.evidence)
    const outputRows = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentOutput.js")
            .issue(actualScope, Object.assign({}, n.request, {paymentSummary: n.dto.paymentSummary}), operationKey)
            .map(output => Object.assign({}, output, {paymentId: refundPaymentId})),
        result = {
            paymentId: source.paymentId,
            originalPaymentId: source.paymentId,
            refundPaymentId,
            paymentApplicationId: applicationId,
            amount: String(n.amount),
            currencyUomId: source.amountUomId,
            accountingDateText: n.date.day,
            statusId: actualScope.record.statusId,
            paymentLifecycleEventId: event.paymentLifecycleEventId,
            applicationResults: [
                {
                    paymentApplicationId: applicationId,
                    paymentId: refundPaymentId,
                    toPaymentId: source.paymentId,
                    amountApplied: String(n.amount)
                }
            ],
            acctgTransIds,
            outputRows,
            reasonCode: "REFUND_COMPLETED",
            alreadyApplied: false
        }
    call("create#" + RECORD, {
        refundPaymentId,
        originalPaymentId: source.paymentId,
        organizationPartyId: scope.organizationPartyId,
        partyId: scope.partyId,
        financeDirection: scope.financeDirection,
        cashDirection: actualScope.cashDirection,
        amount: n.amount,
        currencyUomId: source.amountUomId,
        accountingDate: n.date.day,
        effectiveDate: n.date.timestamp,
        paymentApplicationId: applicationId,
        originalAcctgTransId: n.funding.cash.transaction.acctgTransId,
        cashAcctgTransId: cashIds[0],
        applicationAcctgTransId: apTx[0].acctgTransId,
        sourceControlGlAccountId: n.funding.cash.controlGlAccountId,
        refundControlGlAccountId: n.plans[1].lines[0].glAccountId,
        cashGlAccountId: n.plans[0].lines[1].glAccountId,
        sourceVersion: n.request.sourceVersion,
        refundSourceVersion: n.request.refundSourceVersion,
        methodEvidenceHash: hash(n.methods.versions),
        evidenceHash: hash(n.dto.evidenceRows),
        operationKey,
        paymentLifecycleEventId: event.paymentLifecycleEventId,
        createdDate: ec.user.nowTimestamp,
        userId: ec.user.userId,
        resultJson: JSON.stringify(result),
        gatewayAttemptId: attempt?.attemptId || null
    })
    return result
}
;({
    PREVIEW,
    RECORD,
    CLAIM,
    heldDraftClaim,
    completedFunding,
    scopeFor,
    funding,
    summary,
    defaults,
    capabilities,
    findDrafts,
    normalized,
    preview,
    retained,
    getPreview,
    projectPreview,
    projectResult,
    refund,
    completeMoney,
    draft,
    cashEvidence,
    controlAccount,
    refundCashPlan,
    applications,
    providerBacked
})
