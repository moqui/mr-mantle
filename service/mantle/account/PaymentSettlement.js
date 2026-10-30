// Reviewed trade settlement. The retained preview is authority; confirmation accepts no financial input.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {lib, context, key, parseKey, selected, query, project} = workflow
const {find, one, rows, call, denied, map, hash, policy} = lib
const PREVIEW = "mantle.account.payment.SettlementPreview",
    T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry"
const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
const sourcePosting = ec.resource.script("component://mr-mantle/service/mantle/account/SourcePostingGuard.js")
const controlProof = sourcePosting.controlProof
function dateInput(value, canonicalDay = null) {
    if (!value) denied("EFFECTIVE_DATE_REQUIRED", "Choose an effective accounting date")
    const day = canonicalDay || (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : ec.l10n.format(value, "yyyy-MM-dd"))
    const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
        ? ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
        : lib.ms(value)
    if (!timestamp || !/^\d{4}-\d{2}-\d{2}$/.test(day) || (!canonicalDay && ec.l10n.format(timestamp, "yyyy-MM-dd") !== day))
        denied("DATE_INVALID", "Choose a valid accounting date")
    return {day, timestamp}
}
function money(value, currency) {
    let amount
    try {
        amount = toDecimal(value)
    } catch (_) {
        denied("AMOUNT_INVALID", "Enter a positive amount")
    }
    if (!amount || amount.compare(0) <= 0) denied("AMOUNT_INVALID", "Enter a positive amount")
    if (!amount.eq(ec.l10n.roundCurrency(amount, currency)))
        denied("CURRENCY_PRECISION", "The amount exceeds the currency's precision")
    return amount
}
function invoiceAccount(scope, invoice, payable) {
    const result = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceTypeTransType", {
        organizationPartyId: scope.organizationPartyId,
        invoiceTypeEnumId: invoice.invoiceTypeEnumId,
        isPayable: payable ? "Y" : "N"
    })
    if (!result.glAccountId) denied("MAPPING_MISSING", "The invoice control account is not configured")
    return result.glAccountId
}
function paymentAccount(scope, payment, payable) {
    const result = call("mantle.ledger.PaymentAutoPostServices.get#PaymentTypeGlAccount", {
        organizationPartyId: scope.organizationPartyId,
        paymentTypeEnumId: payment.paymentTypeEnumId,
        isApplied: "N",
        isPayable: payable ? "Y" : "N",
        otherPartyId: scope.partyId
    })
    if (!result.glAccountId) denied("MAPPING_MISSING", "The unapplied payment account is not configured")
    return result.glAccountId
}
function activeTransactions(field, id, org) {
    let q = find(T, {[field]: id, organizationPartyId: org, isPosted: "Y"})
        .condition("reversedByAcctgTransId", "is-null", null)
        .condition("reverseOfAcctgTransId", "is-null", null)
    if (field === "invoiceId") q = q.condition("paymentId", "is-null", null).condition("paymentApplicationId", "is-null", null)
    else
        q = q.condition("acctgTransTypeEnumId", "in", [
            "AttPayment",
            "AttDisbursement",
            "AttReceipt",
            "AttIncomingPayment",
            "AttOutgoingPayment"
        ])
    return Array.from(q.orderBy("acctgTransId").list())
}
function lockPostings(scope, selectedRows) {
    const ids = [
        ...new Set(
            selectedRows.flatMap(row =>
                activeTransactions(
                    ["invoice", "credit"].includes(row.sourceKind) ? "invoiceId" : "paymentId",
                    row.sourceId,
                    scope.organizationPartyId
                ).map(tx => tx.acctgTransId)
            )
        )
    ].sort()
    if (!ids.length) return
    Array.from(find(T).condition("acctgTransId", "in", ids).orderBy("acctgTransId").forUpdate(true).list())
    Array.from(find(E).condition("acctgTransId", "in", ids).orderBy("acctgTransId,acctgTransEntrySeqId").forUpdate(true).list())
}
function postedEvidence(record, invoice, scope) {
    const transactions = activeTransactions(
        invoice ? "invoiceId" : "paymentId",
        invoice ? record.invoiceId : record.paymentId,
        scope.organizationPartyId
    )
    if (!transactions.length) denied("SOURCE_NOT_POSTED", "Settlement requires a successfully posted source document")
    if (
        find(T, {isPosted: "Y"})
            .condition(
                "reverseOfAcctgTransId",
                "in",
                transactions.map(row => row.acctgTransId)
            )
            .limit(1)
            .one()
    )
        denied("SOURCE_POSTING_REVERSED", "An original posting has a posted reversal and cannot fund settlement")
    if (transactions.some(row => row.glFiscalTypeEnumId !== "GLFT_ACTUAL"))
        denied("SOURCE_POSTING_NOT_ACTUAL", "Settlement requires actual ledger backing")
    if (transactions.some(row => row.amountUomId !== scope.currencyUomId))
        denied("SOURCE_POSTING_CURRENCY_MISMATCH", "The original posting currency does not match its financial document")
    const pref = policy.preference(scope.organizationPartyId)
    if (transactions.some(row => row.glJournalId && row.glJournalId === pref.errorGlJournalId))
        denied("SOURCE_NOT_POSTED", "An error journal cannot fund settlement")
    const entries = Array.from(
        find(E)
            .condition(
                "acctgTransId",
                "in",
                transactions.map(row => row.acctgTransId)
            )
            .orderBy("acctgTransId,acctgTransEntrySeqId")
            .list()
    )
    return {
        transactions: transactions.map(map),
        entries: entries.map(map),
        postingDays: transactions.map(row => ({acctgTransId: row.acctgTransId, day: policy.postingDay(row)}))
    }
}
function allocationPlan(scope, source, target, amount, postingByKey = {}, recordByKey = {}) {
    const sp = parseKey(source.sourceKey),
        tp = parseKey(target.sourceKey)
    if (
        !["payment", "credit"].includes(sp.kind) ||
        !["invoice", "paymentTarget"].includes(tp.kind) ||
        (sp.kind === "credit" && tp.kind !== "invoice")
    )
        denied("SETTLEMENT_PAIR_INVALID", "Choose a payment or credit against an invoice, or opposite payments")
    const s = recordByKey[source.sourceKey] || one(sp.entity, {[sp.entity === workflow.I ? "invoiceId" : "paymentId"]: sp.id}),
        t = recordByKey[target.sourceKey] || one(tp.entity, {[tp.entity === workflow.I ? "invoiceId" : "paymentId"]: tp.id})
    if (s.fromPartyId !== t.toPartyId || s.toPartyId !== t.fromPartyId)
        denied("SETTLEMENT_PARTIES_MISMATCH", "The selected records do not have opposite parties")
    const outgoing = s.fromPartyId === scope.organizationPartyId
    const evidence = postingByKey[source.sourceKey] || postedEvidence(s, sp.kind === "credit", scope)
    const targetEvidence = postingByKey[target.sourceKey] || postedEvidence(t, tp.kind === "invoice", scope)
    controlProof(
        targetEvidence,
        tp.kind === "invoice"
            ? invoiceAccount(scope, t, t.toPartyId === scope.organizationPartyId)
            : paymentAccount(scope, t, t.fromPartyId === scope.organizationPartyId),
        t.fromPartyId === scope.organizationPartyId ? "D" : "C",
        target.original
    )
    const lines = [],
        add = (glAccountId, debitCreditFlag) => lines.push({glAccountId, debitCreditFlag, amount: String(amount)})
    let direct = false
    if (sp.kind === "payment") {
        const unapplied = paymentAccount(scope, s, outgoing)
        const hasUnapplied = evidence.entries.some(row => row.glAccountId === unapplied)
        const posterHasUnapplied = evidence.entries.some(row =>
            ["UNEARNED_REVENUE", "PREPAID_EXPENSE"].includes(
                one("mantle.ledger.account.GlAccount", {glAccountId: row.glAccountId})?.glAccountClassEnumId
            )
        )
        if (hasUnapplied !== posterHasUnapplied)
            denied("SOURCE_POSTING_UNSUPPORTED", "The current payment mapping and original unapplied posting disagree")
        if (!hasUnapplied) {
            if (tp.kind !== "invoice" || s.forInvoiceId !== t.invoiceId)
                denied("SOURCE_NOT_UNAPPLIED", "The payment was not posted to an available unapplied account")
            const history = workflow.applications([s]).filter(row => toDecimal(row.amountApplied || 0).compare(0) > 0)
            sourcePosting.directHistory(s, t.invoiceId, evidence.transactions, history)
            const applied = invoiceAccount(scope, t, outgoing)
            const total = evidence.entries
                .filter(row => row.glAccountId === applied && row.debitCreditFlag === (outgoing ? "D" : "C"))
                .reduce((sum, row) => sum.add(row.amount || 0), toDecimal(0))
            controlProof(evidence, applied, outgoing ? "D" : "C", s.amount)
            if (total.compare(s.amount || 0) < 0)
                denied("SOURCE_NOT_POSTED", "The payment's direct invoice posting is incomplete")
            direct = true
        } else {
            controlProof(evidence, unapplied, outgoing ? "D" : "C", s.amount)
            add(unapplied, outgoing ? "C" : "D")
            add(
                tp.kind === "invoice" ? invoiceAccount(scope, t, outgoing) : paymentAccount(scope, t, !outgoing),
                outgoing ? "D" : "C"
            )
        }
    } else {
        controlProof(evidence, invoiceAccount(scope, s, !outgoing), outgoing ? "D" : "C", source.original)
        add(invoiceAccount(scope, s, !outgoing), outgoing ? "C" : "D")
        add(invoiceAccount(scope, t, outgoing), outgoing ? "D" : "C")
    }
    return {
        sourceKey: source.sourceKey,
        targetKey: target.sourceKey,
        amount: String(amount),
        direct,
        lines,
        sourcePosting: evidence,
        targetPosting: targetEvidence
    }
}
function validatePolicy(scope, date, plans, lock = false) {
    const pref = policy.preference(scope.organizationPartyId)
    if (pref.baseCurrencyUomId !== scope.currencyUomId)
        denied("CURRENCY_MISMATCH", "Settlement requires the organization's base currency")
    const fiscal = guard.fiscal(scope.organizationPartyId, date.timestamp, lock, [], date.day)
    const lockOut = guard.postingLocks(
        {organizationPartyId: scope.organizationPartyId, transactionDate: date.timestamp},
        ["all", scope.direction === "receivable" ? "sales" : "purchases"],
        lock,
        date.day,
        true
    )
    const findings = [...fiscal.findings, ...lockOut.findings]
    if (findings.length) denied(findings[0].code, findings.map(row => row.message).join("; "))
    const accountIds = [...new Set(plans.flatMap(row => row.lines).map(row => row.glAccountId))].sort()
    const accounts = accountIds.map(id => {
        const checked = policy.account(scope.organizationPartyId, id, date.timestamp)
        if (
            pref.requiredLedgerDimensionsEnabled === "Y" &&
            (checked.assignment.facilityRequired === "Y" || checked.assignment.costCenterRequired === "Y")
        )
            denied("DIMENSION_REQUIRED", "Settlement account " + id + " requires ledger dimensions")
        return {
            account: policy.pick(map(checked.row), [
                "glAccountId",
                "accountCode",
                "accountName",
                "glAccountTypeEnumId",
                "glAccountClassEnumId",
                "disallowPosting",
                "parentGlAccountId"
            ]),
            assignment: policy.pick(map(checked.assignment), [
                "glAccountId",
                "organizationPartyId",
                "fromDate",
                "thruDate",
                "facilityRequired",
                "costCenterRequired"
            ])
        }
    })
    return {
        preference: policy.pick(map(pref), [
            "baseCurrencyUomId",
            "postingGuardEnabled",
            "requiredLedgerDimensionsEnabled",
            "paymentAutoApplicationEnabled",
            "settlementApplicationGuardEnabled"
        ]),
        periods: fiscal.periods.map(row =>
            policy.pick(map(row), ["timePeriodId", "partyId", "timePeriodTypeId", "fromDate", "thruDate", "isClosed"])
        ),
        locks: lockOut.locks.map(row => ({
            lock: map(row),
            exceptions: rows("mantle.ledger.config.AccountingLockException", {accountingLockId: row.accountingLockId}).map(map)
        })),
        accounts
    }
}
function normalized(p, lock = false) {
    const scope = context(p, true, lock),
        date = dateInput(p.effectiveDate, p.accountingDate),
        selectionThroughDate = p.asOfDate || ec.user.nowTimestamp,
        selectionThroughDay = p.selectionThroughDay || ec.l10n.format(selectionThroughDate, "yyyy-MM-dd")
    if (!scope.capabilities.guardEnabled)
        denied("SETTLEMENT_GUARD_REQUIRED", "Enable settlement application controls before confirming new settlements")
    const allocations = Array.from(p.allocations || []),
        adjustments = Array.from(p.adjustments || [])
    if (!allocations.length && !adjustments.length) denied("SETTLEMENT_EMPTY", "Add at least one allocation or adjustment")
    if (allocations.length > 200 || adjustments.length > 50)
        denied("SETTLEMENT_ROW_LIMIT", "Use at most 200 allocations and 50 adjustments")
    const keys = [
        ...new Set([
            ...allocations.flatMap(row => [String(row.sourceKey || ""), String(row.targetKey || "")]),
            ...adjustments.map(row => key("invoice", row.invoiceId))
        ])
    ].sort()
    if (keys.length > 200) denied("SETTLEMENT_SELECTION_LIMIT", "Select at most 200 records")
    const selectedRows = selected(scope, keys, lock),
        byKey = Object.fromEntries(selectedRows.map(row => [row.sourceKey, row]))
    if (keys.some(value => !byKey[value])) denied("SETTLEMENT_RECORD_UNAVAILABLE", "A selected record is unavailable")
    for (const row of selectedRows) {
        if (!p.sourceVersions?.[row.sourceKey] || p.sourceVersions[row.sourceKey] !== row.version)
            denied("STALE_PREVIEW", "A selected record changed; review current balances")
        if (row.reasons.length) denied(row.reasons[0], "A selected record is not available for settlement")
        if ((p.sourceDays?.[row.sourceKey] || row.accountingDateText) > selectionThroughDay)
            denied("OUTSIDE_SELECTION_DATE", "A selected record is later than the eligibility date")
        if (date.day < (p.sourceDays?.[row.sourceKey] || row.accountingDateText))
            denied("APPLICATION_BEFORE_SOURCE", "The accounting date cannot precede a selected document")
    }
    const consumption = {},
        take = (k, amount) => {
            consumption[k] = (consumption[k] || toDecimal(0)).add(amount)
        }
    const allocationRows = allocations.map((row, index) => {
        const source = byKey[row.sourceKey],
            target = byKey[row.targetKey],
            amount = money(row.amount, scope.currencyUomId)
        take(source.sourceKey, amount)
        take(target.sourceKey, amount)
        return {
            rowSeq: String(index + 1),
            sourceKey: source.sourceKey,
            targetKey: target.sourceKey,
            sourceId: source.sourceId,
            targetId: target.sourceId,
            sourceKind: source.sourceKind,
            targetKind: target.sourceKind,
            counterpartyName: source.counterpartyName,
            amount: String(amount),
            currencyUomId: scope.currencyUomId
        }
    })
    const adjustmentRows = adjustments.map((row, index) => {
        if (!["discount", "writeoff"].includes(row.kind) || !String(row.reason || "").trim())
            denied("ADJUSTMENT_REASON_REQUIRED", "Choose discount or write-off and enter a reason")
        const target = byKey[key("invoice", row.invoiceId)],
            amount = money(row.amount, scope.currencyUomId)
        if (!row.glAccountId) denied("ADJUSTMENT_ACCOUNT_REQUIRED", "Choose an explicit adjustment account")
        const account = policy.account(scope.organizationPartyId, row.glAccountId, date.timestamp)
        take(target.sourceKey, amount)
        return {
            rowSeq: String(index + 1),
            invoiceId: row.invoiceId,
            targetKey: target.sourceKey,
            kind: row.kind,
            amount: String(amount),
            currencyUomId: scope.currencyUomId,
            glAccountId: row.glAccountId,
            accountCode: account.row.accountCode,
            accountName: account.row.accountName,
            reason: String(row.reason).trim()
        }
    })
    for (const [k, amount] of Object.entries(consumption))
        if (amount.compare(byKey[k].remaining) > 0)
            denied("SETTLEMENT_EXCEEDS_BALANCE", "Combined allocations exceed a selected record's current balance")
    for (const invoiceId of [...new Set(adjustmentRows.map(row => row.invoiceId))]) {
        const existing = rows(workflow.I, {creditForInvoiceId: invoiceId}).filter(row => row.statusId !== "InvoiceCancelled")
        const issued = Object.values(lib.totalsMany(existing)).reduce((sum, row) => sum.add(row.invoiceTotal), toDecimal(0))
        const added = adjustmentRows
            .filter(row => row.invoiceId === invoiceId)
            .reduce((sum, row) => sum.add(row.amount), toDecimal(0))
        if (issued.add(added).compare(byKey[key("invoice", invoiceId)].original) > 0)
            denied("CREDIT_EXCEEDS_INVOICE", "Combined linked credits and adjustments exceed the original invoice")
    }
    if (lock) lockPostings(scope, selectedRows)
    const recordByKey = Object.fromEntries(
        selectedRows.map(row => {
            const parsed = parseKey(row.sourceKey)
            return [row.sourceKey, one(parsed.entity, {[parsed.entity === workflow.I ? "invoiceId" : "paymentId"]: parsed.id})]
        })
    )
    const postingByKey = Object.fromEntries(
        selectedRows.map(row => [
            row.sourceKey,
            postedEvidence(recordByKey[row.sourceKey], ["invoice", "credit"].includes(row.sourceKind), scope)
        ])
    )
    for (const evidence of Object.values(postingByKey)) {
        if (evidence.postingDays.some(row => date.day < row.day))
            denied(
                "APPLICATION_BEFORE_SOURCE_POSTING",
                "The accounting date cannot precede original posting day " +
                    evidence.postingDays
                        .map(row => row.day)
                        .sort()
                        .slice(-1)[0]
            )
    }
    const plans = allocationRows.map(row =>
        allocationPlan(scope, byKey[row.sourceKey], byKey[row.targetKey], row.amount, postingByKey, recordByKey)
    )
    for (const sourceKey of [...new Set(plans.filter(row => row.direct).map(row => row.sourceKey))])
        if (!consumption[sourceKey].eq(byKey[sourceKey].remaining))
            denied(
                "DIRECT_PAYMENT_RESTORE_REQUIRED",
                "Restore the entire currently available direct payment to its original invoice"
            )
    for (const row of adjustmentRows) {
        const invoice = one(workflow.I, {invoiceId: row.invoiceId}),
            ar = scope.direction === "receivable"
        const control = invoiceAccount(scope, invoice, !ar)
        controlProof(postingByKey[row.targetKey], control, ar ? "D" : "C", byKey[row.targetKey].original)
        // The generated opposite credit posts to its own control account; the application nets that control to the target.
        const creditControl = invoiceAccount(scope, {invoiceTypeEnumId: "InvoiceCreditMemo"}, ar)
        plans.push({
            adjustmentRowSeq: row.rowSeq,
            amount: row.amount,
            targetPosting: postingByKey[row.targetKey],
            lines: [
                {glAccountId: row.glAccountId, debitCreditFlag: ar ? "D" : "C", amount: row.amount},
                {glAccountId: creditControl, debitCreditFlag: ar ? "C" : "D", amount: row.amount}
            ],
            applicationLines: [
                {glAccountId: creditControl, debitCreditFlag: ar ? "D" : "C", amount: row.amount},
                {glAccountId: control, debitCreditFlag: ar ? "C" : "D", amount: row.amount}
            ]
        })
    }
    const allPlans = plans.flatMap(row => (row.applicationLines ? [row, {lines: row.applicationLines}] : [row]))
    const policyEvidence = validatePolicy(scope, date, allPlans, lock)
    const sourceVersions = Object.fromEntries(selectedRows.map(row => [row.sourceKey, row.version]))
    const request = {
        organizationPartyId: scope.organizationPartyId,
        partyId: scope.partyId,
        direction: scope.direction,
        currencyUomId: scope.currencyUomId,
        asOfDate: selectionThroughDate,
        selectionThroughDay,
        sourceDays: Object.fromEntries(
            selectedRows.map(row => [row.sourceKey, p.sourceDays?.[row.sourceKey] || row.accountingDateText])
        ),
        effectiveDate: date.timestamp,
        accountingDate: date.day,
        allocations: allocationRows.map(row => lib.policy.pick(row, ["sourceKey", "targetKey", "amount"])),
        adjustments: adjustmentRows.map(row => lib.policy.pick(row, ["invoiceId", "kind", "amount", "glAccountId", "reason"])),
        sourceVersions
    }
    const beforeBalances = selectedRows.map(row => ({
            sourceKey: row.sourceKey,
            sourceKind: row.sourceKind,
            sourceId: row.sourceId,
            original: String(row.original),
            remaining: String(row.remaining),
            currencyUomId: scope.currencyUomId
        })),
        afterBalances = beforeBalances.map(row =>
            Object.assign({}, row, {remaining: String(toDecimal(row.remaining).subtract(consumption[row.sourceKey] || 0))})
        )
    const ledgerPreview = scope.capabilities.canReadLedger
        ? allPlans.flatMap((row, index) => row.lines.map(line => Object.assign({rowSeq: String(index + 1)}, line)))
        : adjustmentRows.map(row => ({
              kind: row.kind,
              glAccountId: row.glAccountId,
              accountCode: row.accountCode,
              accountName: row.accountName,
              amount: row.amount
          }))
    return {
        scope,
        request,
        plans,
        policyEvidence,
        payload: {
            organizationPartyId: scope.organizationPartyId,
            partyId: scope.partyId,
            partyName: lib.partyNames([scope.partyId])[scope.partyId],
            direction: scope.direction,
            currencyUomId: scope.currencyUomId,
            balanceBasis: "current",
            selectionThroughDate,
            selectionThroughDateText: selectionThroughDay,
            balanceAsOfDate: ec.user.nowTimestamp,
            effectiveDate: date.timestamp,
            accountingDate: date.day,
            accountingDateText: date.day,
            allocationRows,
            adjustmentRows,
            beforeBalances,
            afterBalances,
            sourceVersions,
            ledgerPreview,
            capabilities: scope.capabilities,
            canApply: true,
            errors: []
        }
    }
}
function preview(p) {
    const n = normalized(p),
        now = Number(ec.user.nowTimestamp)
    const inputFingerprint = hash({request: n.request, plans: n.plans, policy: n.policyEvidence})
    const made = call("create#" + PREVIEW, {
        organizationPartyId: n.scope.organizationPartyId,
        userId: ec.user.userId,
        partyId: n.scope.partyId,
        direction: n.scope.direction,
        currencyUomId: n.scope.currencyUomId,
        previewKind: p._previewKind || "manual",
        sourcePaymentId: p._sourcePaymentId,
        effectiveDate: n.request.effectiveDate,
        accountingDate: n.request.accountingDate,
        inputFingerprint,
        requestJson: JSON.stringify(n.request),
        payloadJson: JSON.stringify({dto: n.payload, plans: n.plans, policyEvidence: n.policyEvidence}),
        createdDate: now,
        expiresDate: now + 600000,
        status: "review"
    })
    return Object.assign({}, n.payload, {
        previewId: made.previewId,
        inputFingerprint,
        expiresDate: now + 600000,
        status: "review"
    })
}
function retained(p, write = false) {
    const row = one(PREVIEW, {previewId: p.previewId})
    if (!row || row.userId !== ec.user.userId) denied("SETTLEMENT_PREVIEW_UNAVAILABLE", "Settlement preview is unavailable")
    if (p.organizationPartyId && p.organizationPartyId !== row.organizationPartyId)
        denied("ORGANIZATION_DENIED", "The settlement belongs to another organization")
    const scope = context(row, write),
        payload = JSON.parse(row.payloadJson),
        request = JSON.parse(row.requestJson)
    return {row, scope, payload, request}
}
function getPreview(p) {
    const r = retained(p)
    const dto = Object.assign({}, r.payload.dto, {
        capabilities: r.scope.capabilities,
        ledgerPreview: r.scope.capabilities.canReadLedger
            ? r.payload.dto.ledgerPreview
            : r.payload.dto.adjustmentRows.map(row =>
                  policy.pick(row, ["kind", "glAccountId", "accountCode", "accountName", "amount"])
              )
    })
    const results = r.row.resultJson ? JSON.parse(r.row.resultJson) : null
    if (results && !r.scope.capabilities.canReadLedger) {
        results.acctgTransIds = []
        for (const row of [...(results.allocationResults || []), ...(results.adjustmentResults || [])]) row.acctgTransIds = []
    }
    return Object.assign({}, dto, {
        previewId: r.row.previewId,
        inputFingerprint: r.row.inputFingerprint,
        expiresDate: r.row.expiresDate,
        status: r.row.status,
        operationKey: r.row.operationKey,
        results,
        canApply:
            r.scope.capabilities.canApply && r.row.status === "review" && lib.ms(r.row.expiresDate) > Number(ec.user.nowTimestamp)
    })
}
function adjustmentAccounts(p) {
    const scope = context(p, true, false, false),
        date = dateInput(p.effectiveDate, p.accountingDate)
    const ids = [...new Set(Array.from(p.selectedIdList || []).map(String))]
    if (ids.length > 200) denied("SETTLEMENT_SELECTION_LIMIT", "Select at most 200 accounts")
    const orgs = policy.organizationChain(scope.organizationPartyId, date.timestamp),
        cf = ec.entity.conditionFactory
    const candidateQuery = () => {
        let q = find("mantle.ledger.account.GlAccountAndOrganization")
            .condition("organizationPartyId", "in", orgs)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("disallowPosting", "not-equals", "Y"),
                        cf.makeCondition("disallowPosting", "is-null", null)
                    ],
                    "or"
                )
            )
        if (p.text)
            q = q.condition(
                cf.makeCondition(
                    ["glAccountId", "accountCode", "accountName"].map(field =>
                        cf.makeCondition(field, "like", "%" + p.text + "%").ignoreCase()
                    ),
                    "or"
                )
            )
        return q
            .selectField("glAccountId")
            .selectField("accountCode")
            .selectField("accountName")
            .distinct(true)
            .orderBy("accountCode,glAccountId")
    }
    const out = [],
        selectedRows = [],
        errors = []
    const add = (id, list) => {
        if (list.some(row => row.glAccountId === id)) return
        try {
            const checked = policy.account(scope.organizationPartyId, id, date.timestamp)
            list.push(policy.pick(map(checked.row), ["glAccountId", "accountCode", "accountName"]))
        } catch (error) {
            if (!String(error.message).includes("Choose an active posting account assigned to this organization")) {
                ec.logger.error("Settlement account " + id + ": " + error.message)
                errors.push({reasonCode: "ACCOUNT_UNAVAILABLE", message: "An account could not be read"})
            }
        }
    }
    // Search is in SQL; bounded cursor chunks avoid materializing an arbitrary entire chart.
    // Nearest assignment is checked by policy.account, so an inactive child cannot inherit its active parent's assignment.
    let offset = 0,
        exhausted = false
    try {
        while (offset < 1000) {
            const candidates = Array.from(candidateQuery().offset(offset).limit(100).list())
            for (const row of candidates) add(row.glAccountId, out)
            offset += candidates.length
            if (candidates.length < 100) {
                exhausted = true
                break
            }
        }
        if (!exhausted && !candidateQuery().offset(offset).limit(1).one()) exhausted = true
    } catch (error) {
        ec.logger.error("Settlement account search " + scope.organizationPartyId + " at " + offset + ": " + error.message)
        errors.push({reasonCode: "ACCOUNT_UNAVAILABLE", message: "Some accounts could not be read"})
    }
    if (!exhausted)
        errors.push({
            reasonCode: "ACCOUNT_SEARCH_INCOMPLETE",
            message: "Narrow the account search to obtain a complete eligible list"
        })
    for (const id of ids) add(id, selectedRows)
    const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 20)),
        pageMaxIndex = Math.max(0, Math.ceil(out.length / pageSize) - 1),
        pageIndex = Math.min(pageMaxIndex, Math.max(0, Number(p.pageIndex) || 0))
    return {
        rows: out.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        selectedRows,
        recordCount: exhausted && !errors.length ? out.length : null,
        pageSize,
        pageIndex,
        pageMaxIndex: exhausted && !errors.length ? pageMaxIndex : null,
        pageRangeLow: out.length ? pageIndex * pageSize + 1 : 0,
        pageRangeHigh: Math.min(out.length, (pageIndex + 1) * pageSize),
        complete: !errors.length,
        incomplete: !!errors.length,
        errors
    }
}
function entrySet(lines) {
    const sums = {}
    for (const line of lines) {
        const k = line.glAccountId + ":" + line.debitCreditFlag
        sums[k] = (sums[k] || toDecimal(0)).add(line.amount || 0)
    }
    return Object.fromEntries(
        Object.keys(sums)
            .sort()
            .map(k => [k, String(sums[k])])
    )
}
function verifyPosting(transactions, expected, org, direct = false) {
    const actual = transactions.filter(
        row => row.organizationPartyId === org && !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId
    )
    if (direct) {
        if (actual.length) denied("POSTING_MISMATCH", "The reviewed direct application produced an unexpected posting")
        return []
    }
    const pref = policy.preference(org)
    if (
        actual.length !== 1 ||
        actual.some(row => row.isPosted !== "Y" || (pref.errorGlJournalId && row.glJournalId === pref.errorGlJournalId))
    )
        denied("SETTLEMENT_NOT_POSTED", "The complete settlement posting could not be verified")
    const entries = Array.from(
        find(E)
            .condition(
                "acctgTransId",
                "in",
                actual.map(row => row.acctgTransId)
            )
            .list()
    )
    const actualSet = entrySet(entries),
        expectedSet = entrySet(expected),
        accountSides = Object.keys(expectedSet)
    if (
        Object.keys(actualSet).length !== accountSides.length ||
        accountSides.some(k => !Object.prototype.hasOwnProperty.call(actualSet, k) || !toDecimal(actualSet[k]).eq(expectedSet[k]))
    )
        denied("POSTING_MISMATCH", "The actual posting differs from the reviewed accounts and amounts")
    return actual.map(row => row.acctgTransId)
}
function writeApplication(row, plan, request, operationKey, rowSeq) {
    const source = parseKey(row.sourceKey),
        target = parseKey(row.targetKey)
    const fields =
        source.kind === "credit"
            ? {invoiceId: source.id, toInvoiceId: target.id}
            : target.kind === "invoice"
              ? {paymentId: source.id, invoiceId: target.id}
              : {paymentId: source.id, toPaymentId: target.id}
    const made = call(
        "create#" + workflow.A,
        Object.assign(fields, {
            amountApplied: row.amount,
            appliedDate: request.effectiveDate,
            accountingDate: request.accountingDate,
            currencyUomId: request.currencyUomId,
            settlementOperationKey: operationKey,
            settlementRowSeq: rowSeq
        })
    )
    const application = one(workflow.A, {paymentApplicationId: made.paymentApplicationId})
    if (!application || !toDecimal(application.amountApplied).eq(row.amount))
        denied("APPLICATION_AMOUNT_MISMATCH", "The actual applied amount differs from the reviewed amount")
    const transactions = rows(T, {paymentApplicationId: application.paymentApplicationId})
    const ids = verifyPosting(transactions, plan.lines, request.organizationPartyId, plan.direct)
    if (plan.direct && application.acctgTransResultEnumId !== "AtrPaymentNotPosted")
        denied("POSTING_MISMATCH", "The direct invoice payment evidence changed")
    if (!plan.direct && application.acctgTransResultEnumId !== "AtrSuccess")
        denied("SETTLEMENT_NOT_POSTED", "The application was not posted successfully")
    return {
        paymentApplicationId: application.paymentApplicationId,
        amountApplied: String(application.amountApplied),
        acctgTransIds: ids,
        sourceKey: row.sourceKey,
        targetKey: row.targetKey,
        reasonCode: plan.direct ? "ALREADY_POSTED_DIRECT" : "OK"
    }
}
function paidStatus(invoiceId, effectiveDate) {
    const invoice = one(workflow.I, {invoiceId}),
        balance = lib.totals(invoice).unpaidTotal
    if (!balance.isZero()) return
    const status = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked"].includes(invoice.statusId)
        ? "InvoicePmtRecvd"
        : invoice.statusId === "InvoiceApproved"
          ? "InvoicePmtSent"
          : null
    if (status || ["InvoicePmtRecvd", "InvoicePmtSent"].includes(invoice.statusId))
        call("update#" + workflow.I, Object.assign({invoiceId, paidDate: effectiveDate}, status ? {statusId: status} : {}))
}
function createAdjustment(row, plan, request, operationKey) {
    const target = one(workflow.I, {invoiceId: row.invoiceId})
    const made = call("create#" + workflow.I, {
        invoiceTypeEnumId: "InvoiceCreditMemo",
        fromPartyId: target.toPartyId,
        toPartyId: target.fromPartyId,
        statusId: "InvoiceInProcess",
        invoiceDate: request.effectiveDate,
        accountingDate: request.accountingDate,
        currencyUomId: request.currencyUomId,
        creditForInvoiceId: target.invoiceId,
        financeOrganizationPartyId: request.organizationPartyId,
        financeDirection: request.direction,
        draftedByUserId: ec.user.userId,
        settlementOperationKey: operationKey,
        settlementAdjustmentKind: row.kind,
        description: row.kind + ": " + row.reason
    })
    call("mantle.account.InvoiceServices.create#InvoiceItem", {
        invoiceId: made.invoiceId,
        itemTypeEnumId: "ItemTimeEntry",
        quantity: "1",
        amount: row.amount,
        overrideGlAccountId: row.glAccountId,
        description: row.reason
    })
    call("update#" + workflow.I, {invoiceId: made.invoiceId, statusId: "InvoiceFinalized", statusId_changeReason: row.reason})
    const invoiceIds = verifyPosting(rows(T, {invoiceId: made.invoiceId}), plan.lines, request.organizationPartyId)
    const application = writeApplication(
        {sourceKey: key("credit", made.invoiceId), targetKey: row.targetKey, amount: row.amount},
        {lines: plan.applicationLines},
        request,
        operationKey,
        "adjustment-" + row.rowSeq
    )
    return Object.assign(
        {
            invoiceId: row.invoiceId,
            adjustmentInvoiceId: made.invoiceId,
            kind: row.kind,
            glAccountId: row.glAccountId,
            reason: row.reason
        },
        application,
        {acctgTransIds: [...invoiceIds, ...application.acctgTransIds]}
    )
}
function apply(p) {
    const r = retained(p, true)
    const operation = lib.operation(p, "Settlement", r.scope.organizationPartyId, {
        previewId: r.row.previewId,
        inputFingerprint: p.inputFingerprint
    })
    if (operation.old) {
        const old = lib.previous(operation)
        if (!r.scope.capabilities.canReadLedger) {
            old.acctgTransIds = []
            for (const row of [...(old.allocationResults || []), ...(old.adjustmentResults || [])]) row.acctgTransIds = []
        }
        return old
    }
    if (!p.inputFingerprint || p.inputFingerprint !== r.row.inputFingerprint)
        denied("STALE_PREVIEW", "Confirm the retained settlement fingerprint")
    // Organization lock precedes the preview/documents/applications and serializes both fresh confirmation and exact retries.
    const previewRow = find(PREVIEW, {previewId: r.row.previewId}).forUpdate(true).one()
    if (previewRow.status !== "review") denied("SETTLEMENT_ALREADY_APPLIED", "This preview has already been confirmed")
    if (lib.ms(previewRow.expiresDate) <= Number(ec.user.nowTimestamp))
        denied("SETTLEMENT_PREVIEW_EXPIRED", "Review the settlement again before applying")
    if (previewRow.previewKind === "auto" && policy.preference(r.scope.organizationPartyId).paymentAutoApplicationEnabled !== "Y")
        denied("AUTO_APPLICATION_DISABLED", "Automatic application is disabled")
    const n = normalized(r.request, true)
    if (hash({request: n.request, plans: n.plans, policy: n.policyEvidence}) !== previewRow.inputFingerprint)
        denied("STALE_PREVIEW", "Balances, accounts or posting policy changed; review again")
    const settlementId = operation.operationKey,
        allocationResults = [],
        adjustmentResults = [],
        allIds = []
    for (let index = 0; index < n.payload.allocationRows.length; index++) {
        const row = n.payload.allocationRows[index],
            result = writeApplication(row, n.plans[index], n.request, operation.operationKey, row.rowSeq)
        allocationResults.push(Object.assign({rowSeq: row.rowSeq}, result))
        allIds.push(...result.acctgTransIds)
        call("create#mantle.account.payment.SettlementAllocation", {
            settlementId,
            rowSeq: row.rowSeq,
            previewId: previewRow.previewId,
            organizationPartyId: r.scope.organizationPartyId,
            sourceKey: row.sourceKey,
            targetKey: row.targetKey,
            amount: row.amount,
            currencyUomId: n.request.currencyUomId,
            paymentApplicationId: result.paymentApplicationId,
            acctgTransIdsJson: JSON.stringify(result.acctgTransIds)
        })
    }
    for (let index = 0; index < n.payload.adjustmentRows.length; index++) {
        const row = n.payload.adjustmentRows[index],
            result = createAdjustment(row, n.plans[n.payload.allocationRows.length + index], n.request, operation.operationKey)
        adjustmentResults.push(Object.assign({rowSeq: row.rowSeq}, result))
        allIds.push(...result.acctgTransIds)
        call("create#mantle.account.payment.SettlementAllocation", {
            settlementId,
            rowSeq: "adjustment-" + row.rowSeq,
            previewId: previewRow.previewId,
            organizationPartyId: r.scope.organizationPartyId,
            sourceKey: key("credit", result.adjustmentInvoiceId),
            targetKey: row.targetKey,
            amount: row.amount,
            currencyUomId: n.request.currencyUomId,
            paymentApplicationId: result.paymentApplicationId,
            adjustmentInvoiceId: result.adjustmentInvoiceId,
            acctgTransIdsJson: JSON.stringify(result.acctgTransIds)
        })
    }
    const invoices = [
        ...new Set([
            ...Object.keys(n.request.sourceVersions)
                .map(parseKey)
                .filter(row => row.entity === workflow.I)
                .map(row => row.id),
            ...adjustmentResults.map(row => row.adjustmentInvoiceId)
        ])
    ].sort()
    for (const id of invoices) paidStatus(id, n.request.effectiveDate)
    const remaining = selected(r.scope, Object.keys(n.request.sourceVersions))
    for (const row of remaining) {
        const reviewed = n.payload.afterBalances.find(item => item.sourceKey === row.sourceKey)
        if (!reviewed || !toDecimal(row.remaining).eq(reviewed.remaining))
            denied("SETTLEMENT_BALANCE_MISMATCH", "The actual remaining balance differs from the reviewed result")
    }
    const result = {
        settlementId,
        previewId: previewRow.previewId,
        accountingDate: n.request.accountingDate,
        accountingDateText: n.request.accountingDate,
        applicationIds: [...allocationResults, ...adjustmentResults].map(row => row.paymentApplicationId),
        adjustmentInvoiceIds: adjustmentResults.map(row => row.adjustmentInvoiceId),
        acctgTransIds: r.scope.capabilities.canReadLedger ? allIds : [],
        allocationResults: allocationResults.map(row =>
            Object.assign({}, row, {acctgTransIds: r.scope.capabilities.canReadLedger ? row.acctgTransIds : []})
        ),
        adjustmentResults: adjustmentResults.map(row =>
            Object.assign({}, row, {acctgTransIds: r.scope.capabilities.canReadLedger ? row.acctgTransIds : []})
        ),
        remainingRows: remaining,
        reasonCode: "OK",
        alreadyApplied: false
    }
    call("update#" + PREVIEW, {
        previewId: previewRow.previewId,
        status: "complete",
        operationKey: operation.operationKey,
        resultJson: JSON.stringify(result)
    })
    lib.complete(operation, PREVIEW, previewRow.previewId, result)
    return result
}
function paymentScope(p, write = true) {
    const payment = one(workflow.P, {paymentId: p.paymentId})
    if (!payment) denied("PAYMENT_UNAVAILABLE", "Payment is unavailable")
    let org = p.organizationPartyId || payment.financeOrganizationPartyId
    if (!org)
        org = one("mantle.party.PartyRole", {partyId: payment.fromPartyId, roleTypeId: "OrgInternal"})
            ? payment.fromPartyId
            : payment.toPartyId
    const original = payment.refundForPaymentId ? one(workflow.P, {paymentId: payment.refundForPaymentId}) : payment
    const direction =
        payment.financeDirection || original?.financeDirection || (original?.toPartyId === org ? "receivable" : "payable")
    const scope = context(
        {
            organizationPartyId: org,
            partyId: payment.fromPartyId === org ? payment.toPartyId : payment.fromPartyId,
            direction,
            currencyUomId: payment.amountUomId
        },
        write
    )
    const available = selected(scope, [key("payment", payment.paymentId)])
    if (available.length !== 1) denied("PAYMENT_UNAVAILABLE", "The payment is not an available settlement source")
    return {scope, payment, row: available[0]}
}
function previewAuto(p) {
    const r = paymentScope(p)
    if (!r.scope.capabilities.guardEnabled)
        denied("SETTLEMENT_GUARD_REQUIRED", "Enable settlement application controls before automatic application")
    if (policy.preference(r.scope.organizationPartyId).paymentAutoApplicationEnabled !== "Y")
        denied("AUTO_APPLICATION_DISABLED", "Automatic application is disabled")
    if (!p.sourceVersion || p.sourceVersion !== r.row.version)
        denied("STALE_PREVIEW", "Review the current payment before automatic application")
    let remaining = toDecimal(r.row.remaining),
        offset = 0,
        allocations = [],
        versions = {[r.row.sourceKey]: r.row.version}
    while (remaining.compare(0) > 0) {
        const records = Array.from(
            query(r.scope, "invoice", {asOfDate: ec.user.nowTimestamp})
                .orderBy("dueDate,invoiceDate,invoiceId")
                .offset(offset)
                .limit(100)
                .list()
        )
        if (!records.length) break
        for (const invoice of project(r.scope, "invoice", records)) {
            if (allocations.length >= 199)
                denied(
                    "SETTLEMENT_SELECTION_LIMIT",
                    "Automatic application exceeds 200 selected records; use a smaller manual selection"
                )
            if (invoice.reasons.length) continue
            const amount = remaining.compare(invoice.remaining) < 0 ? remaining : toDecimal(invoice.remaining)
            allocations.push({sourceKey: r.row.sourceKey, targetKey: invoice.sourceKey, amount: String(amount)})
            versions[invoice.sourceKey] = invoice.version
            remaining = remaining.subtract(amount)
            if (remaining.isZero()) break
        }
        offset += records.length
    }
    if (!allocations.length) denied("NO_ELIGIBLE_INVOICES", "No open invoice is eligible for this payment")
    return preview(
        Object.assign({}, r.scope, {
            effectiveDate: p.effectiveDate,
            sourceVersions: versions,
            allocations,
            _previewKind: "auto",
            _sourcePaymentId: p.paymentId
        })
    )
}
function autoApply(p) {
    const r = paymentScope(p)
    if (!p.previewId && policy.preference(r.scope.organizationPartyId).paymentAutoApplicationEnabled !== "Y")
        return {enabled: false, invoiceIdList: [], reasonCode: "AUTO_APPLICATION_DISABLED", alreadyApplied: false}
    if (!p.previewId || !p.inputFingerprint || !p.operationKey)
        denied("SETTLEMENT_PREVIEW_REQUIRED", "Review automatic application before confirming")
    const reviewed = retained(p, true)
    if (
        reviewed.row.previewKind !== "auto" ||
        reviewed.row.sourcePaymentId !== p.paymentId ||
        reviewed.row.organizationPartyId !== r.scope.organizationPartyId
    )
        denied("SETTLEMENT_PREVIEW_MISMATCH", "The reviewed automatic application belongs to another payment")
    const result = apply(p)
    return Object.assign(result, {
        enabled: true,
        invoiceIdList: [
            ...new Set(reviewed.payload.dto.allocationRows.filter(row => row.targetKind === "invoice").map(row => row.targetId))
        ]
    })
}
;({
    preview,
    getPreview,
    adjustmentAccounts,
    normalized,
    retained,
    dateInput,
    allocationPlan,
    validatePolicy,
    apply,
    previewAuto,
    autoApply
})
