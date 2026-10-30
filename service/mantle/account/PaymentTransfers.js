// Native internal transfers retain both cash legs and their exact shared transit posting as one operation.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const lifecycle = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentLifecycle.js")
const settlement = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentSettlement.js")
const {lib, P} = workflow
const {find, one, map, call, hash, policy, denied} = lib
const PREVIEW = "mantle.account.payment.PaymentTransferPreview",
    RECORD = "mantle.account.payment.PaymentInternalTransfer",
    TX = "mantle.ledger.transaction.AcctgTrans",
    ENTRY = "mantle.ledger.transaction.AcctgTransEntry"
const pageFields = ["recordCount", "pageIndex", "pageSize", "pageMaxIndex", "pageRangeLow", "pageRangeHigh"]
function json(value) {
    try {
        return value ? JSON.parse(value) : {}
    } catch (_) {
        denied("TRANSFER_EVIDENCE_UNAVAILABLE", "The retained transfer evidence is unavailable")
    }
}
function scopeFor(p, write = false, lock = false) {
    const scope = workflow.paymentContext(p, write, lock),
        org = find("mantle.party.Party", {partyId: scope.organizationPartyId}).useCache(false).forUpdate(lock).one()
    if (!scope.broad || !lib.has("PAYMENT_EDIT"))
        denied("PERMISSION_DENIED", "Treasury read and payment edit authority are required for internal transfers")
    if (!org || (org.privateOwnerUserId && org.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("PARTY_UNAVAILABLE", "The payment method owner is unavailable")
    return Object.assign(scope, {partyId: scope.organizationPartyId, financeDirection: "transfer"})
}
function capabilities(scope) {
    return {
        canTransfer: Boolean(scope.broad && lib.has("PAYMENT_EDIT") && scope.guardEnabled),
        canReadLedger: workflow.ledgerRead(),
        guardEnabled: scope.guardEnabled,
        reasons: scope.guardEnabled ? [] : ["SETTLEMENT_GUARD_REQUIRED"]
    }
}
function methodProjection(method) {
    return policy.pick(workflow.methodRows([method])[0], [
        "paymentMethodId",
        "version",
        "label",
        "maskedNumber",
        "paymentMethodTypeEnumId"
    ])
}
function methods(p) {
    const scope = scopeFor(p),
        date = settlement.dateInput(p.effectiveDate || ec.user.nowTimestamp),
        currency = p.currencyUomId || policy.preference(scope.organizationPartyId).baseCurrencyUomId,
        ids = [...new Set(Array.from(p.selectedIdList || []).map(String))],
        cf = ec.entity.conditionFactory
    policy.currency(currency)
    if (ids.length > 200) denied("PAYMENT_SELECTION_LIMIT", "Select at most two hundred methods")
    function q(search = true) {
        let query = find("mantle.account.method.PaymentMethod", {
            ownerPartyId: scope.organizationPartyId,
            currencyUomId: currency
        })
            .condition("paymentMethodTypeEnumId", "in", ["PmtBankAccount", "PmtOther"])
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
                    ["paymentMethodId", "description"].map(field =>
                        cf.makeCondition(field, "like", "%" + String(p.text).trim().slice(0, 200) + "%").ignoreCase()
                    ),
                    "or"
                )
            )
        return query
    }
    const count = q().count(),
        page = lib.page(q().orderBy("description,paymentMethodId"), p, "records", count)
    return Object.assign(policy.pick(page, pageFields), {
        rows: page.rows.map(methodProjection),
        selectedRows: ids.length ? Array.from(q(false).condition("paymentMethodId", "in", ids).list()).map(methodProjection) : [],
        complete: true,
        errors: []
    })
}
function expenseClasses() {
    const all = Array.from(find("moqui.basic.Enumeration", {enumTypeId: "GlAccountClass"}).list()),
        ids = new Set(["EXPENSE", "NON_OP_EXPENSE"])
    let changed = true
    while (changed) {
        changed = false
        for (const row of all)
            if (ids.has(row.parentEnumId) && !ids.has(row.enumId)) {
                ids.add(row.enumId)
                changed = true
            }
    }
    return [...ids]
}
function feeAccounts(p) {
    const scope = scopeFor(p),
        date = settlement.dateInput(p.effectiveDate || ec.user.nowTimestamp),
        ids = [...new Set(Array.from(p.selectedIdList || []).map(String))],
        orgs = policy.organizationChain(scope.organizationPartyId, date.timestamp),
        classes = expenseClasses(),
        cf = ec.entity.conditionFactory
    if (ids.length > 200) denied("PAYMENT_SELECTION_LIMIT", "Select at most two hundred fee accounts")
    function q() {
        let query = find("mantle.ledger.account.GlAccountAndOrganization")
            .condition("organizationPartyId", "in", orgs)
            .condition("glAccountClassEnumId", "in", classes)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("disallowPosting", "is-null", null),
                        cf.makeCondition("disallowPosting", "not-equals", "Y")
                    ],
                    "or"
                )
            )
        if (String(p.text || "").trim())
            query = query.condition(
                cf.makeCondition(
                    ["glAccountId", "accountCode", "accountName"].map(field =>
                        cf.makeCondition(field, "like", "%" + String(p.text).trim().slice(0, 200) + "%").ignoreCase()
                    ),
                    "or"
                )
            )
        return query
            .selectField("glAccountId")
            .selectField("accountCode")
            .selectField("accountName")
            .distinct(true)
            .orderBy("accountCode,glAccountId")
    }
    const out = [],
        selected = [],
        errors = []
    function add(id, list) {
        try {
            const checked = policy.account(scope.organizationPartyId, id, date.timestamp)
            if (classes.includes(checked.row.glAccountClassEnumId))
                list.push(
                    Object.assign(policy.pick(map(checked.row), ["glAccountId", "accountCode", "accountName"]), {
                        label: checked.row.accountCode + " · " + checked.row.accountName
                    })
                )
        } catch (error) {
            if (!String(error.message).includes("Choose an active posting account assigned to this organization")) {
                ec.logger.error("Transfer fee account " + id + ": " + error.message)
                errors.push({reasonCode: "TRANSFER_ACCOUNT_UNAVAILABLE"})
            }
        }
    }
    let offset = 0,
        exhausted = false
    try {
        while (offset < 1000) {
            const candidates = Array.from(q().offset(offset).limit(100).list())
            for (const row of candidates) add(row.glAccountId, out)
            offset += candidates.length
            if (candidates.length < 100) {
                exhausted = true
                break
            }
        }
        if (!exhausted && !q().offset(offset).limit(1).one()) exhausted = true
    } catch (error) {
        ec.logger.error("Transfer fee account search " + scope.organizationPartyId + ": " + error.message)
        errors.push({reasonCode: "TRANSFER_ACCOUNT_UNAVAILABLE"})
    }
    if (!exhausted) errors.push({reasonCode: "ACCOUNT_SEARCH_INCOMPLETE"})
    for (const id of ids) add(id, selected)
    const pageSize = Math.max(1, Math.min(100, Number(p.pageSize) || 20)),
        max = Math.max(0, Math.ceil(out.length / pageSize) - 1),
        index = Math.min(max, Math.max(0, Number(p.pageIndex) || 0))
    return {
        rows: out.slice(index * pageSize, (index + 1) * pageSize),
        selectedRows: selected,
        recordCount: exhausted && !errors.length ? out.length : null,
        pageIndex: index,
        pageSize,
        pageMaxIndex: exhausted && !errors.length ? max : null,
        pageRangeLow: out.length ? index * pageSize + 1 : 0,
        pageRangeHigh: Math.min(out.length, (index + 1) * pageSize),
        complete: !errors.length,
        incomplete: !!errors.length,
        errors
    }
}
function mapping(scope, lock = false) {
    const orgs = call("mantle.ledger.LedgerServices.expand#ParentOrganizationList", {
            organizationPartyId: scope.organizationPartyId
        }).orgPartyIdList || [scope.organizationPartyId],
        rows = Array.from(
            find("mantle.ledger.config.PaymentTypeGlAccount", {paymentTypeEnumId: "PtInternalTransfer"})
                .condition("organizationPartyId", "in", orgs)
                .condition("isApplied", "in", ["N", "E"])
                .orderBy("organizationPartyId,isPayable,isApplied")
                .useCache(false)
                .forUpdate(lock)
                .list()
        ),
        selected = []
    for (const payable of ["Y", "N"]) {
        let row = null
        for (const applied of ["N", "E"]) {
            for (const org of orgs) {
                row = rows.find(r => r.organizationPartyId === org && r.isPayable === payable && r.isApplied === applied)
                if (row) break
            }
            if (row) break
        }
        if (!row?.glAccountId)
            denied("TRANSFER_TRANSIT_REQUIRED", "Configure the internal transfer transit account for both legs")
        selected.push(row)
    }
    if (selected[0].glAccountId !== selected[1].glAccountId)
        denied("TRANSFER_TRANSIT_MISMATCH", "Both transfer legs require the same transit account")
    return {
        glAccountId: selected[0].glAccountId,
        evidence: selected.map(row =>
            policy.pick(map(row), ["paymentTypeEnumId", "organizationPartyId", "isPayable", "isApplied", "glAccountId"])
        )
    }
}
function lockAccounts(scope, date, evidence) {
    const ids = evidence.accounts.map(row => row.account.glAccountId).sort(),
        orgs = policy.organizationChain(scope.organizationPartyId, date.timestamp)
    const accounts = Array.from(
            find("mantle.ledger.account.GlAccount")
                .condition("glAccountId", "in", ids)
                .orderBy("glAccountId")
                .useCache(false)
                .forUpdate(true)
                .list()
        ),
        assignments = Array.from(
            find("mantle.ledger.account.GlAccountOrganization")
                .condition("glAccountId", "in", ids)
                .condition("organizationPartyId", "in", orgs)
                .orderBy("organizationPartyId,glAccountId")
                .useCache(false)
                .forUpdate(true)
                .list()
        )
    for (const item of evidence.accounts) {
        const account = accounts.find(row => row.glAccountId === item.account.glAccountId)
        let assignment = null
        for (const org of orgs) {
            assignment = assignments.find(row => row.glAccountId === item.account.glAccountId && row.organizationPartyId === org)
            if (assignment) break
        }
        if (
            !account ||
            !assignment ||
            account.disallowPosting === "Y" ||
            !policy.active(assignment, date.timestamp) ||
            hash(policy.pick(map(account), Object.keys(item.account))) !== hash(item.account) ||
            hash(policy.pick(map(assignment), Object.keys(item.assignment))) !== hash(item.assignment)
        )
            denied("STALE_PREVIEW", "A posting account or dated assignment changed while confirming")
    }
}
function amountInput(value, currency) {
    let amount
    try {
        amount = toDecimal(value)
    } catch (_) {
        denied("AMOUNT_INVALID", "Enter a positive principal amount")
    }
    if (!amount || amount.compare(0) <= 0) denied("AMOUNT_INVALID", "Enter a positive principal amount")
    if (!amount.eq(ec.l10n.roundCurrency(amount, currency)))
        denied("CURRENCY_PRECISION", "The principal exceeds currency precision")
    return amount
}
function verifyPosting(tx, plan) {
    const errorJournal = policy.preference(plan.organizationPartyId).errorGlJournalId
    if (
        !tx ||
        tx.isPosted !== "Y" ||
        tx.glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
        tx.organizationPartyId !== plan.organizationPartyId ||
        tx.amountUomId !== plan.amountUomId ||
        tx.acctgTransTypeEnumId !== plan.acctgTransTypeEnumId ||
        tx.reverseOfAcctgTransId ||
        tx.reversedByAcctgTransId ||
        (errorJournal && tx.glJournalId === errorJournal)
    )
        denied("TRANSFER_NOT_POSTED", "The actual transfer posting was not completed in the actual ledger")
    const entries = Array.from(
            find(ENTRY, {acctgTransId: tx.acctgTransId}).orderBy("acctgTransEntrySeqId").useCache(false).forUpdate(true).list()
        ),
        sums = lines => {
            const out = {}
            for (const row of lines) {
                if (!["D", "C"].includes(row.debitCreditFlag) || toDecimal(row.amount || 0).compare(0) <= 0)
                    denied("TRANSFER_NOT_POSTED", "Transfer entry amount and side must be exact")
                const key = row.glAccountId + ":" + row.debitCreditFlag
                out[key] = (out[key] || toDecimal(0)).add(row.amount)
            }
            return out
        },
        actual = sums(entries),
        expected = sums(plan.lines)
    if (
        JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
        Object.keys(expected).some(key => !expected[key].eq(actual[key]))
    )
        denied("TRANSFER_NOT_POSTED", "Actual transfer accounts, debit/credit sides or amounts differ from review")
}
function normalized(p, lock = false) {
    const scope = scopeFor(p, true, lock),
        date = settlement.dateInput(p.effectiveDate, p._accountingDay || null)
    lifecycle.requireGuard(scope)
    const currency = p.currencyUomId
    policy.currency(currency)
    if (currency !== policy.preference(scope.organizationPartyId).baseCurrencyUomId)
        denied("CURRENCY_MISMATCH", "Internal transfers require the organization's base currency")
    if (!p.fromPaymentMethodId || !p.toPaymentMethodId || p.fromPaymentMethodId === p.toPaymentMethodId)
        denied("TRANSFER_METHODS_DISTINCT", "Choose distinct organization cash methods")
    const methods = lifecycle.methodEvidence(
        scope,
        {
            partyId: scope.organizationPartyId,
            organizationPaymentMethodId: p.fromPaymentMethodId,
            organizationMethodVersion: p.fromMethodVersion,
            counterpartyPaymentMethodId: p.toPaymentMethodId,
            counterpartyMethodVersion: p.toMethodVersion,
            currencyUomId: currency
        },
        date.timestamp,
        lock
    )
    for (const method of [methods.organizationMethod, methods.counterpartyMethod])
        if (!["PmtBankAccount", "PmtOther"].includes(method.paymentMethodTypeEnumId) || !method.glAccountId)
            denied("TRANSFER_CASH_MAPPING_REQUIRED", "Choose organization bank or cash methods with actual cash posting accounts")
    const amount = amountInput(p.amount, currency)
    let fee
    try {
        fee = toDecimal(p.feeAmount || 0)
    } catch (_) {
        denied("TRANSFER_FEE_INVALID", "Enter a nonnegative fee")
    }
    if (fee.compare(0) < 0) denied("TRANSFER_FEE_INVALID", "Enter a nonnegative fee")
    if (!fee.eq(ec.l10n.roundCurrency(fee, currency))) denied("CURRENCY_PRECISION", "The fee exceeds currency precision")
    const transit = mapping(scope, lock),
        fromCash = methods.organizationMethod.glAccountId,
        toCash = methods.counterpartyMethod.glAccountId
    if ([fromCash, toCash].includes(transit.glAccountId))
        denied("TRANSFER_TRANSIT_MISMATCH", "Transit must differ from both cash accounts")
    for (const id of [fromCash, toCash])
        if (one("mantle.ledger.account.GlAccount", {glAccountId: id})?.glAccountClassEnumId !== "CASH_EQUIVALENT")
            denied("TRANSFER_CASH_MAPPING_REQUIRED", "Both methods require actual cash accounts")
    const feeAccount = fee.compare(0) > 0 ? String(p.feeGlAccountId || "") : null
    if (fee.compare(0) > 0 && (!feeAccount || [fromCash, toCash, transit.glAccountId].includes(feeAccount)))
        denied("TRANSFER_FEE_ACCOUNT_REQUIRED", "Choose a separate expense account for the fee")
    if (
        feeAccount &&
        !expenseClasses().includes(policy.account(scope.organizationPartyId, feeAccount, date.timestamp).row.glAccountClassEnumId)
    )
        denied("TRANSFER_FEE_ACCOUNT_REQUIRED", "The transfer fee requires an eligible expense account")
    const referenceNumber = String(p.referenceNumber || "").trim(),
        reason = String(p.reason || "").trim()
    if (!referenceNumber || referenceNumber.length > 60 || !reason || reason.length > 4000)
        denied("PAYMENT_EVIDENCE_REQUIRED", "Enter a human reference and reason for the internal transfer")
    const plans = [
            {
                organizationPartyId: scope.organizationPartyId,
                acctgTransTypeEnumId: "AttOutgoingPayment",
                transactionDate: date.timestamp,
                amountUomId: currency,
                lines: [
                    {glAccountId: transit.glAccountId, debitCreditFlag: "D", amount: String(amount)},
                    ...(fee.compare(0) > 0 ? [{glAccountId: feeAccount, debitCreditFlag: "D", amount: String(fee)}] : []),
                    {glAccountId: fromCash, debitCreditFlag: "C", amount: String(amount.add(fee))}
                ]
            },
            {
                organizationPartyId: scope.organizationPartyId,
                acctgTransTypeEnumId: "AttIncomingPayment",
                transactionDate: date.timestamp,
                amountUomId: currency,
                lines: [
                    {glAccountId: toCash, debitCreditFlag: "D", amount: String(amount)},
                    {glAccountId: transit.glAccountId, debitCreditFlag: "C", amount: String(amount)}
                ]
            }
        ],
        policyEvidence = settlement.validatePolicy(
            {
                organizationPartyId: scope.organizationPartyId,
                partyId: scope.organizationPartyId,
                direction: "transfer",
                currencyUomId: currency
            },
            date,
            plans,
            lock
        )
    if (lock) lockAccounts(scope, date, policyEvidence)
    const feeAccountLabel = feeAccount
        ? (() => {
              const row = policy.account(scope.organizationPartyId, feeAccount, date.timestamp).row
              return row.accountCode + " · " + row.accountName
          })()
        : null
    const maskedMethods = {from: methodProjection(methods.organizationMethod), to: methodProjection(methods.counterpartyMethod)},
        request = {
            organizationPartyId: scope.organizationPartyId,
            fromPaymentMethodId: p.fromPaymentMethodId,
            fromMethodVersion: p.fromMethodVersion,
            toPaymentMethodId: p.toPaymentMethodId,
            toMethodVersion: p.toMethodVersion,
            amount: String(amount),
            feeAmount: String(fee),
            feeGlAccountId: feeAccount,
            currencyUomId: currency,
            effectiveDate: date.timestamp,
            _accountingDay: date.day,
            referenceNumber,
            reason
        },
        transferSummary = {
            principalAmount: String(amount),
            feeAmount: String(fee),
            totalAmount: String(amount.add(fee)),
            currencyUomId: currency,
            accountingDateText: date.day,
            feeAccountLabel,
            fromMethodLabel: maskedMethods.from.label,
            toMethodLabel: maskedMethods.to.label,
            referenceNumber,
            reason
        },
        legRows = [
            {leg: "outgoing", amount: String(amount.add(fee)), maskedMethodLabel: maskedMethods.from.label},
            {leg: "incoming", amount: String(amount), maskedMethodLabel: maskedMethods.to.label}
        ].map(row => Object.assign({paymentId: null, currencyUomId: currency, accountingDateText: date.day}, row)),
        payload = Object.assign(
            {},
            policy.pick(request, [
                "organizationPartyId",
                "amount",
                "feeAmount",
                "feeGlAccountId",
                "currencyUomId",
                "fromPaymentMethodId",
                "fromMethodVersion",
                "toPaymentMethodId",
                "toMethodVersion",
                "referenceNumber",
                "reason"
            ]),
            transferSummary,
            {
                previewKind: "internalTransfer",
                maskedMethods,
                transferSummary,
                legRows,
                before: {
                    principalAmount: "0",
                    feeAmount: "0",
                    outgoingCashAmount: "0",
                    incomingCashAmount: "0",
                    transitNetAmount: "0",
                    currencyUomId: currency
                },
                after: {
                    principalAmount: String(amount),
                    feeAmount: String(fee),
                    outgoingCashAmount: String(amount.add(fee)),
                    incomingCashAmount: String(amount),
                    transitNetAmount: "0",
                    currencyUomId: currency
                },
                postingSummary: {
                    cashPostingCount: 2,
                    applicationPostingCount: 0,
                    effect: "Two atomic cash postings through the same transit account; no trade application"
                },
                ledgerPreview: plans,
                capabilities: capabilities(scope),
                canApply: true
            }
        )
    return {
        scope,
        date,
        amount,
        fee,
        methods,
        maskedMethods,
        transit,
        fromCash,
        toCash,
        feeAccount,
        request,
        payload,
        plans,
        policyEvidence,
        fingerprint: hash({request, methods: methods.versions, mapping: transit.evidence, policy: policyEvidence, plans})
    }
}
function retained(p, write = false, lock = false) {
    let row = one(PREVIEW, {previewId: p.previewId})
    if (!row || row.userId !== ec.user.userId) denied("TRANSFER_PREVIEW_UNAVAILABLE", "The transfer review is unavailable")
    const scope = scopeFor({organizationPartyId: p.organizationPartyId || row.organizationPartyId}, write, lock)
    if (scope.organizationPartyId !== row.organizationPartyId)
        denied("TRANSFER_PREVIEW_UNAVAILABLE", "The transfer belongs to another organization")
    if (lock) row = find(PREVIEW, {previewId: row.previewId}).useCache(false).forUpdate(true).one()
    return {row, scope, request: json(row.requestJson)}
}
function projectResult(result, scope) {
    const out = Object.assign({}, result)
    if (!workflow.ledgerRead()) {
        delete out.acctgTransIds
        out.legRows = (out.legRows || []).map(row => {
            const safe = Object.assign({}, row)
            delete safe.acctgTransId
            return safe
        })
    }
    if (out.outputRows)
        out.outputRows = out.outputRows.map(row => {
            const child = workflow.paymentScope({organizationPartyId: scope.organizationPartyId, paymentId: row.paymentId}),
                caps = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js").available(child)
            return Object.assign({}, row, {canOpen: Boolean(caps.canPrintDetail)})
        })
    return out
}
function projectPreview(row, scope) {
    const out = Object.assign({}, json(row.payloadJson), {
        previewId: row.previewId,
        internalTransferId: row.internalTransferId,
        transferId: row.internalTransferId,
        inputFingerprint: row.inputFingerprint,
        status: row.status,
        operationKey: row.operationKey,
        expiresDate: row.expiresDate,
        canApply:
            row.status === "review" && lib.ms(row.expiresDate) > Number(ec.user.nowTimestamp) && capabilities(scope).canTransfer,
        capabilities: capabilities(scope)
    })
    if (!workflow.ledgerRead()) delete out.ledgerPreview
    if (row.resultJson) out.results = projectResult(json(row.resultJson), scope)
    return out
}
function preview(p) {
    const n = normalized(p),
        previewId = ec.user.randomString(32),
        id = ec.user.randomString(32)
    call("create#" + PREVIEW, {
        previewId,
        internalTransferId: id,
        organizationPartyId: n.scope.organizationPartyId,
        userId: ec.user.userId,
        inputFingerprint: n.fingerprint,
        requestJson: JSON.stringify(n.request),
        payloadJson: JSON.stringify(n.payload),
        status: "review",
        createdDate: ec.user.nowTimestamp,
        expiresDate: Number(ec.user.nowTimestamp) + 1800000
    })
    return projectPreview(one(PREVIEW, {previewId}), n.scope)
}
function getPreview(p) {
    const r = retained(p)
    return projectPreview(r.row, r.scope)
}
function projection(scope, record) {
    if (!record.internalTransferId || !["outgoing", "incoming"].includes(record.internalTransferLeg))
        denied("TRANSFER_IDENTITY_INVALID", "The transfer leg identity is unavailable")
    const pair = find(RECORD, {internalTransferId: record.internalTransferId}).useCache(false).one()
    if (
        !pair ||
        pair.organizationPartyId !== scope.organizationPartyId ||
        ![pair.fromPaymentId, pair.toPaymentId].includes(record.paymentId)
    )
        denied("TRANSFER_IDENTITY_INVALID", "The transfer pair is unavailable")
    const methods = json(pair.methodsJson),
        summary = {
            internalTransferId: pair.internalTransferId,
            transferId: pair.internalTransferId,
            principalAmount: String(pair.principalAmount),
            feeAmount: String(pair.feeAmount),
            totalAmount: String(toDecimal(pair.principalAmount).add(pair.feeAmount)),
            currencyUomId: pair.currencyUomId,
            accountingDateText: policy.calendarDateText(pair.accountingDate),
            fromMethodLabel: methods.from.label,
            toMethodLabel: methods.to.label,
            referenceNumber: pair.referenceNumber,
            reason: pair.reason,
            leg: record.internalTransferLeg
        }
    return {
        transferSummary: summary,
        transferLegRows: [
            {paymentId: pair.fromPaymentId, leg: "outgoing", amount: summary.totalAmount, maskedMethodLabel: methods.from.label},
            {paymentId: pair.toPaymentId, leg: "incoming", amount: summary.principalAmount, maskedMethodLabel: methods.to.label}
        ].map(row => Object.assign({currencyUomId: pair.currencyUomId, accountingDateText: summary.accountingDateText}, row))
    }
}
function create(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const r = retained(p, true, true),
        row = r.row,
        op = lib.operation(p, "InternalTransfer", r.scope.organizationPartyId, {
            previewId: p.previewId,
            inputFingerprint: p.inputFingerprint
        })
    if (op.old) return projectResult(lib.previous(op), r.scope)
    if (p.inputFingerprint !== row.inputFingerprint)
        denied("TRANSFER_PREVIEW_MISMATCH", "Confirm the exact retained transfer review")
    if (row.status !== "review") denied("TRANSFER_PREVIEW_CONSUMED", "This transfer review already has a recorded operation")
    if (lib.ms(row.expiresDate) <= Number(ec.user.nowTimestamp)) denied("TRANSFER_PREVIEW_EXPIRED", "Review the transfer again")
    const n = normalized(r.request, true)
    if (n.fingerprint !== row.inputFingerprint) denied("STALE_PREVIEW", "Transfer methods, mapping or posting policy changed")
    const fromPaymentId = ec.user.randomString(32),
        toPaymentId = ec.user.randomString(32),
        pair = ec.entity.makeValue(RECORD),
        values = {
            internalTransferId: row.internalTransferId,
            organizationPartyId: n.scope.organizationPartyId,
            userId: ec.user.userId,
            principalAmount: n.amount,
            feeAmount: n.fee,
            currencyUomId: n.request.currencyUomId,
            effectiveDate: n.date.timestamp,
            accountingDate: n.date.day,
            fromPaymentMethodId: n.request.fromPaymentMethodId,
            fromMethodVersion: n.request.fromMethodVersion,
            toPaymentMethodId: n.request.toPaymentMethodId,
            toMethodVersion: n.request.toMethodVersion,
            fromPaymentId,
            toPaymentId,
            transitGlAccountId: n.transit.glAccountId,
            fromCashGlAccountId: n.fromCash,
            toCashGlAccountId: n.toCash,
            feeGlAccountId: n.feeAccount,
            referenceNumber: n.request.referenceNumber,
            reason: n.request.reason,
            status: "constructing",
            inputFingerprint: n.fingerprint,
            operationKey: op.operationKey,
            methodsJson: JSON.stringify(n.maskedMethods),
            plansJson: JSON.stringify(n.plans),
            createdDate: ec.user.nowTimestamp
        }
    for (const [field, value] of Object.entries(values)) pair.set(field, value)
    pair.create()
    const ids = [fromPaymentId, toPaymentId],
        acctgTransIds = [],
        outputRows = [],
        legRows = []
    // Construct both explicit native legs without invoking the org-to-itself legacy autoposter/SECAs.
    for (let i = 0; i < 2; i++) {
        const outgoing = i === 0,
            payment = ec.entity.makeValue(P),
            paymentValues = {
                paymentId: ids[i],
                paymentTypeEnumId: "PtInternalTransfer",
                paymentInstrumentEnumId: "PiOther",
                statusId: "PmntDelivered",
                fromPartyId: n.scope.organizationPartyId,
                toPartyId: n.scope.organizationPartyId,
                paymentMethodId: outgoing ? n.request.fromPaymentMethodId : null,
                toPaymentMethodId: outgoing ? null : n.request.toPaymentMethodId,
                amount: outgoing ? n.amount.add(n.fee) : n.amount,
                amountUomId: n.request.currencyUomId,
                effectiveDate: n.date.timestamp,
                accountingDate: n.date.day,
                financeOrganizationPartyId: n.scope.organizationPartyId,
                financeDirection: "transfer",
                lifecycleManaged: "Y",
                internalTransferId: row.internalTransferId,
                internalTransferLeg: outgoing ? "outgoing" : "incoming",
                paymentRefNum: n.request.referenceNumber,
                comments: n.request.reason,
                reconcileStatusId: "PmtrNot"
            }
        for (const [field, value] of Object.entries(paymentValues)) payment.set(field, value)
        payment.create()
    }
    for (let i = 0; i < 2; i++) {
        const outgoing = i === 0,
            plan = n.plans[i],
            made = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
                organizationPartyId: n.scope.organizationPartyId,
                otherPartyId: n.scope.organizationPartyId,
                paymentId: ids[i],
                acctgTransTypeEnumId: plan.acctgTransTypeEnumId,
                amountUomId: n.request.currencyUomId,
                transactionDate: n.date.timestamp,
                glFiscalTypeEnumId: "GLFT_ACTUAL",
                description: n.request.reason
            }),
            tx = find(TX, {acctgTransId: made.acctgTransId}).useCache(false).forUpdate(true).one()
        pair.set(outgoing ? "fromAcctgTransId" : "toAcctgTransId", made.acctgTransId)
        pair.update()
        tx.set("accountingDate", n.date.day)
        tx.update()
        for (const line of plan.lines)
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", Object.assign({acctgTransId: made.acctgTransId}, line))
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: made.acctgTransId})
        const posted = find(TX, {acctgTransId: made.acctgTransId}).useCache(false).forUpdate(true).one()
        verifyPosting(posted, plan)
        if (
            posted.paymentId !== ids[i] ||
            policy.postingDay(posted) !== n.date.day ||
            lib.ms(posted.transactionDate) !== lib.ms(n.date.timestamp)
        )
            denied("TRANSFER_NOT_POSTED", "The actual transfer posting differs from its reviewed source and book day")
        const postedPayment = find(P, {paymentId: ids[i]}).useCache(false).forUpdate(true).one()
        postedPayment.set("acctgTransResultEnumId", "AtrSuccess")
        postedPayment.update()
        acctgTransIds.push(made.acctgTransId)
        legRows.push(Object.assign({}, n.payload.legRows[i], {paymentId: ids[i], acctgTransId: made.acctgTransId}))
    }
    if (
        Array.from(find(TX).condition("paymentId", "in", ids).useCache(false).forUpdate(true).list()).length !== 2 ||
        workflow.paymentApplications(ids).length
    )
        denied("TRANSFER_NOT_POSTED", "Transfer requires exactly two original postings and no applications")
    for (let i = 0; i < 2; i++) {
        const child = workflow.paymentScope({organizationPartyId: n.scope.organizationPartyId, paymentId: ids[i]}, true, true),
            summary = Object.assign({}, n.payload.transferSummary, {
                paymentId: ids[i],
                amount: String(i === 0 ? n.amount.add(n.fee) : n.amount),
                maskedMethodLabel: i === 0 ? n.maskedMethods.from.label : n.maskedMethods.to.label,
                transferSummary: {
                    internalTransferId: row.internalTransferId,
                    principalAmount: String(n.amount),
                    feeAmount: String(n.fee),
                    leg: i === 0 ? "outgoing" : "incoming"
                }
            })
        lifecycle.event(
            child,
            "internalTransfer",
            null,
            op,
            {
                reason: n.request.reason,
                referenceNumber: n.request.referenceNumber,
                sourceVersion: workflow.paymentVersion(child.record),
                postingEffects: {internalTransferId: row.internalTransferId, otherPaymentId: ids[1 - i]}
            },
            [],
            [acctgTransIds[i]]
        )
        outputRows.push(
            ...ec.resource
                .script("component://mr-mantle/service/mantle/account/PaymentOutput.js")
                .issue(child, Object.assign({}, n.request, {paymentSummary: summary}), op.operationKey)
                .map(output => Object.assign({}, output, {paymentId: ids[i]}))
        )
    }
    const result = Object.assign({}, n.payload.transferSummary, {
        transferId: row.internalTransferId,
        internalTransferId: row.internalTransferId,
        fromPaymentId,
        toPaymentId,
        acctgTransIds,
        outputRows,
        legRows,
        operationKey: op.operationKey,
        reasonCode: "INTERNAL_TRANSFER_COMPLETED",
        alreadyApplied: false
    })
    pair.set("status", "completed")
    pair.set("completedDate", ec.user.nowTimestamp)
    pair.set("resultJson", JSON.stringify(result))
    pair.update()
    row.set("status", "complete")
    row.set("operationKey", op.operationKey)
    row.set("resultJson", JSON.stringify(result))
    row.update()
    lib.complete(op, RECORD, row.internalTransferId, result)
    return projectResult(result, n.scope)
}
;({
    PREVIEW,
    RECORD,
    scopeFor,
    capabilities,
    methods,
    feeAccounts,
    normalized,
    preview,
    retained,
    getPreview,
    projection,
    create,
    projectResult
})
