// Payment-specific trade settlement scope and narrow balance projections. No bank or gateway data leaves these reads.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const I = "mantle.account.invoice.Invoice",
    P = "mantle.account.payment.Payment",
    A = "mantle.account.payment.PaymentApplication"
const kinds = ["invoice", "credit", "payment", "paymentTarget"]
function context(p, write = false, lock = false, requireParty = true) {
    const direction = p.direction || "receivable"
    if (!["receivable", "payable"].includes(direction)) denied("SETTLEMENT_DIRECTION_INVALID", "Choose receivables or payables")
    const organizationPartyId = lib.organization(
        p.organizationPartyId || lib.policy.access().activeOrganizationPartyId,
        null,
        lock
    )
    const side = direction === "receivable" ? "RECEIVABLE" : "PAYABLE"
    if (
        !has(side + "_VIEW") &&
        !has("PAYMENT_VIEW") &&
        !has("ACCOUNTING_VIEW") &&
        !has("ACCOUNTING_ADMIN") &&
        !lib.access.systemAdmin()
    )
        denied("PERMISSION_DENIED", "Settlement read authority is required")
    if (write) lib.requirePermission(side + "_EDIT")
    const party = requireParty ? one("mantle.party.Party", {partyId: p.partyId}) : null
    if (
        requireParty &&
        (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
    )
        denied("PARTY_UNAVAILABLE", "Choose an available counterparty")
    if (p.partyId === organizationPartyId) denied("SETTLEMENT_PARTY_INVALID", "Trade settlement needs a counterparty")
    if (requireParty && one("mantle.party.PartyRole", {partyId: p.partyId, roleTypeId: "OrgInternal"}))
        denied("INTERCOMPANY_EXCLUDED", "Internal counterparties use the intercompany workflow")
    if (requireParty) lib.policy.currency(p.currencyUomId)
    return {
        organizationPartyId,
        partyId: p.partyId,
        direction,
        currencyUomId: p.currencyUomId,
        capabilities: {
            canRead: true,
            canApply: has(side + "_EDIT"),
            canReadLedger:
                has("ACCOUNTING_VIEW") || has("ACCOUNTING_GL_POST") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()
        }
    }
}
function key(kind, id) {
    return kind + ":" + encodeURIComponent(String(id))
}
function parseKey(value) {
    const text = String(value || ""),
        index = text.indexOf(":")
    const kind = text.slice(0, index)
    let id
    try {
        id = decodeURIComponent(text.slice(index + 1))
    } catch (_) {
        denied("SETTLEMENT_KEY_INVALID", "Choose a settlement record")
    }
    if (index < 0 || !kinds.includes(kind) || !id || id.length > 40 || key(kind, id) !== text)
        denied("SETTLEMENT_KEY_INVALID", "Choose a settlement record")
    return {kind, id, key: text, entity: ["invoice", "credit"].includes(kind) ? I : P}
}
function privateQuery(query) {
    if (lib.access.systemAdmin()) return query
    const cf = ec.entity.conditionFactory
    for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
        query = query.condition(
            cf.makeCondition([cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)], "or")
        )
    return query
}
function query(scope, kind, filters = {}) {
    const invoice = ["invoice", "credit"].includes(kind),
        cf = ec.entity.conditionFactory
    let q = find(
        invoice ? "mantle.account.payment.SettlementInvoiceBalance" : "mantle.account.payment.PaymentGatewayAvailableBalance"
    )
    const org = scope.organizationPartyId
    if (invoice)
        q = q.condition(lib.policy.invoiceDirectionCondition(scope.direction === "receivable" ? "invoices" : "bills", [org]))
    else {
        const normal = scope.direction === "receivable" ? "toPartyId" : "fromPartyId"
        const original = scope.direction === "receivable" ? "originalToPartyId" : "originalFromPartyId"
        q = q
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition(
                            [
                                cf.makeCondition("financeOrganizationPartyId", "equals", org),
                                cf.makeCondition("financeDirection", "equals", scope.direction)
                            ],
                            "and"
                        ),
                        cf.makeCondition(
                            [
                                cf.makeCondition("financeDirection", "is-null", null),
                                cf.makeCondition("refundForPaymentId", "is-null", null),
                                cf.makeCondition(normal, "equals", org)
                            ],
                            "and"
                        ),
                        cf.makeCondition(
                            [
                                cf.makeCondition("financeDirection", "is-null", null),
                                cf.makeCondition("originalFinanceOrganizationPartyId", "equals", org),
                                cf.makeCondition("originalFinanceDirection", "equals", scope.direction)
                            ],
                            "and"
                        ),
                        cf.makeCondition(
                            [
                                cf.makeCondition("financeDirection", "is-null", null),
                                cf.makeCondition("originalFinanceDirection", "is-null", null),
                                cf.makeCondition(original, "equals", org)
                            ],
                            "and"
                        )
                    ],
                    "or"
                )
            )
            .condition("paymentTypeEnumId", "not-equals", "PtInternalTransfer")
    }
    q = q
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition(
                        [cf.makeCondition("fromPartyId", "equals", org), cf.makeCondition("toPartyId", "equals", scope.partyId)],
                        "and"
                    ),
                    cf.makeCondition(
                        [cf.makeCondition("toPartyId", "equals", org), cf.makeCondition("fromPartyId", "equals", scope.partyId)],
                        "and"
                    )
                ],
                "or"
            )
        )
        .condition(invoice ? "currencyUomId" : "amountUomId", scope.currencyUomId)
    q = privateQuery(q)
    if (invoice) q = q.condition("invoiceTypeEnumId", kind === "credit" ? "equals" : "not-equals", "InvoiceCreditMemo")
    else {
        const sourceField = scope.direction === "receivable" ? "toPartyId" : "fromPartyId"
        q = q.condition(sourceField, kind === "payment" ? "equals" : "not-equals", org)
    }
    if (filters.ids) q = q.condition(invoice ? "invoiceId" : "paymentId", "in", filters.ids)
    if (!filters.selected) {
        q = q.condition(
            "statusId",
            "in",
            invoice
                ? ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoiceApproved", "InvoicePmtRecvd", "InvoicePmtSent"]
                : ["PmntDelivered", "PmntConfirmed"]
        )
        q = q.condition(invoice ? "balanceRemaining" : "availableAmount", "greater", 0)
        if (filters.asOfDate) {
            const day = ec.l10n.format(filters.asOfDate, "yyyy-MM-dd"),
                end = ec.l10n.parseTimestamp(day + " 23:59:59.999", "yyyy-MM-dd HH:mm:ss.SSS")
            q = q.condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("accountingDate", "less-equals", day),
                        cf.makeCondition(
                            [
                                cf.makeCondition("accountingDate", "is-null", null),
                                cf.makeCondition(invoice ? "invoiceDate" : "effectiveDate", "less-equals", end)
                            ],
                            "and"
                        )
                    ],
                    "or"
                )
            )
        }
        const today = ec.l10n.parseTimestamp(
            ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd") + " 00:00:00",
            "yyyy-MM-dd HH:mm:ss"
        )
        if (filters.dueBucket === "overdue" && invoice) q = q.condition("dueDate", "less", today)
        if (filters.dueBucket === "current" && invoice)
            q = q.condition(
                cf.makeCondition(
                    [cf.makeCondition("dueDate", "greater-equals", today), cf.makeCondition("dueDate", "is-null", null)],
                    "or"
                )
            )
        if (filters.text)
            q = q.condition(
                cf.makeCondition(
                    (invoice ? ["invoiceId", "referenceNumber", "description"] : ["paymentId", "paymentRefNum", "comments"]).map(
                        field => cf.makeCondition(field, "like", "%" + filters.text + "%").ignoreCase()
                    ),
                    "or"
                )
            )
    }
    return q
}
function applications(records) {
    const invoiceIds = records.filter(row => row.invoiceId).map(row => row.invoiceId),
        paymentIds = records.filter(row => row.paymentId).map(row => row.paymentId)
    const cf = ec.entity.conditionFactory,
        conditions = []
    for (const field of ["invoiceId", "toInvoiceId"])
        if (invoiceIds.length) conditions.push(cf.makeCondition(field, "in", invoiceIds))
    for (const field of ["paymentId", "toPaymentId"])
        if (paymentIds.length) conditions.push(cf.makeCondition(field, "in", paymentIds))
    return conditions.length
        ? Array.from(find(A).condition(cf.makeCondition(conditions, "or")).orderBy("paymentApplicationId").list())
        : []
}
function project(scope, kind, records, asOfDate = null) {
    if (!records.length) return []
    const invoice = ["invoice", "credit"].includes(kind),
        applied = applications(records)
    const invoiceTotals = invoice ? lib.totalsMany(records) : {},
        names = lib.partyNames([scope.partyId]),
        holdEvidence = invoice
            ? {}
            : ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayReservations.js").cashHoldSummaries({
                  organizationPartyId: scope.organizationPartyId,
                  paymentIdList: records.map(row => row.paymentId)
              })
    return records.map(record => {
        const id = invoice ? record.invoiceId : record.paymentId
        const evidence = applied.filter(row =>
            invoice ? [row.invoiceId, row.toInvoiceId].includes(id) : [row.paymentId, row.toPaymentId].includes(id)
        )
        const original = invoice ? invoiceTotals[id].invoiceTotal : toDecimal(record.amount || 0)
        const used = invoice
            ? invoiceTotals[id].appliedPayments
            : evidence.reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
        const held = invoice ? toDecimal(0) : holdEvidence[id].heldAmount,
            remaining = original.subtract(used).subtract(held),
            date = invoice ? record.invoiceDate : record.effectiveDate
        const accountingDateText = record.accountingDate
            ? lib.policy.calendarDateText(record.accountingDate)
            : date
              ? ec.l10n.format(date, "yyyy-MM-dd")
              : ""
        const reasons = []
        if (
            !(
                invoice
                    ? ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoiceApproved", "InvoicePmtRecvd", "InvoicePmtSent"]
                    : ["PmntDelivered", "PmntConfirmed"]
            ).includes(record.statusId)
        )
            reasons.push("SETTLEMENT_STATE_INVALID")
        if (remaining.compare(0) <= 0) reasons.push("NO_REMAINING_BALANCE")
        if (!date) reasons.push("SOURCE_DATE_REQUIRED")
        if (asOfDate && accountingDateText > ec.l10n.format(asOfDate, "yyyy-MM-dd")) reasons.push("OUTSIDE_SELECTION_DATE")
        const version = lib.hash({
            record: lib.map(record),
            original: String(original),
            remaining: String(remaining),
            holdVersion: invoice ? null : holdEvidence[id].version,
            applications: evidence.map(lib.map)
        })
        return {
            sourceKey: key(kind, id),
            sourceKind: kind,
            sourceId: id,
            counterpartyId: scope.partyId,
            counterpartyName: names[scope.partyId],
            date,
            dateText: accountingDateText,
            accountingDateText,
            dueDate: invoice ? record.dueDate : record.dueDate,
            dueDateText: lib.policy.dateText(record.dueDate),
            original,
            remaining,
            reservedAmount: held,
            availableAmount: remaining,
            currencyUomId: scope.currencyUomId,
            statusId: record.statusId,
            version,
            statusDescription: one("moqui.basic.StatusItem", {statusId: record.statusId})?.description || record.statusId,
            capabilities: {canAllocate: scope.capabilities.canApply && !reasons.length},
            reasons
        }
    })
}
function selected(scope, selectedKeys, lock = false, asOfDate = null) {
    const keys = [...new Set(Array.from(selectedKeys || []).map(String))].sort()
    if (keys.length > 200) denied("SETTLEMENT_SELECTION_LIMIT", "Select at most 200 records")
    const parsed = keys.map(parseKey),
        out = []
    for (const kind of kinds) {
        const ids = parsed.filter(row => row.kind === kind).map(row => row.id)
        if (!ids.length) continue
        const records = Array.from(query(scope, kind, {ids, selected: true}).list())
        out.push(...project(scope, kind, records, asOfDate))
    }
    if (lock) {
        if (out.length !== parsed.length) denied("SETTLEMENT_RECORD_UNAVAILABLE", "A selected record is unavailable")
        for (const record of [...parsed].sort((a, b) => (a.entity + a.id).localeCompare(b.entity + b.id)))
            find(record.entity, {[record.entity === I ? "invoiceId" : "paymentId"]: record.id})
                .forUpdate(true)
                .one()
        const records = parsed.map(row => ({[row.entity === I ? "invoiceId" : "paymentId"]: row.id}))
        const apps = applications(records)
        for (const row of apps) find(A, {paymentApplicationId: row.paymentApplicationId}).forUpdate(true).one()
        return selected(scope, keys, false, asOfDate)
    }
    return out
}
function openItems(p) {
    const scope = context(p),
        activeKinds = p.sourceKind ? [p.sourceKind] : kinds
    if (activeKinds.some(kind => !kinds.includes(kind))) denied("SETTLEMENT_KIND_INVALID", "Choose a settlement record type")
    const result = {
        invoiceRows: [],
        creditRows: [],
        paymentRows: [],
        paymentTargetRows: [],
        pageInfo: {},
        selectedRows: [],
        sourceVersions: {},
        complete: true,
        incomplete: false,
        errors: [],
        capabilities: scope.capabilities,
        balanceBasis: "current",
        balanceAsOfDate: ec.user.nowTimestamp,
        selectionThroughDate: p.asOfDate || ec.user.nowTimestamp,
        selectionThroughDateText: ec.l10n.format(p.asOfDate || ec.user.nowTimestamp, "yyyy-MM-dd"),
        totals: {basis: "page"}
    }
    for (const kind of activeKinds) {
        const paging = Object.assign({}, p, p.pageByKind?.[kind] || {})
        const filters = Object.assign({}, p, {asOfDate: result.selectionThroughDate})
        try {
            const count = query(scope, kind, filters).count()
            const page = lib.page(
                query(scope, kind, filters).orderBy(
                    kind === "invoice" || kind === "credit" ? "dueDate,invoiceDate,invoiceId" : "effectiveDate,paymentId"
                ),
                paging,
                "records",
                count
            )
            const list = project(scope, kind, page.rows, result.selectionThroughDate)
            result[kind + "Rows"] = list
            result.pageInfo[kind] = lib.policy.pick(page, [
                "recordCount",
                "pageIndex",
                "pageSize",
                "pageMaxIndex",
                "pageRangeLow",
                "pageRangeHigh"
            ])
            result.totals[kind] = list.reduce((sum, row) => sum.add(row.remaining), toDecimal(0))
            if (p.sourceKind) Object.assign(result, result.pageInfo[kind], {rows: list})
        } catch (error) {
            ec.logger.error("Settlement " + kind + " balances: " + error.message)
            result.complete = false
            result.incomplete = true
            result.errors.push({reasonCode: "BALANCE_UNAVAILABLE", message: "The requested balances are unavailable"})
        }
    }
    result.selectedRows = selected(scope, p.selectedKeyList || [], false, result.selectionThroughDate)
    for (const row of [...activeKinds.flatMap(kind => result[kind + "Rows"]), ...result.selectedRows])
        result.sourceVersions[row.sourceKey] = row.version
    result.selectedTotals = result.selectedRows.reduce((sum, row) => sum.add(row.remaining), toDecimal(0))
    return result
}
// Payment lifecycle reads deliberately have a separate read gate from settlement writes.
const paymentFields = [
    "paymentId",
    "paymentTypeEnumId",
    "fromPartyId",
    "toPartyId",
    "paymentInstrumentEnumId",
    "paymentMethodId",
    "toPaymentMethodId",
    "statusId",
    "effectiveDate",
    "accountingDate",
    "settlementDate",
    "settlementAccountingDate",
    "dueDate",
    "paymentRefNum",
    "comments",
    "amount",
    "amountUomId",
    "forInvoiceId",
    "refundForPaymentId",
    "orderId",
    "orderPartSeqId",
    "reconcileStatusId",
    "lifecycleManaged",
    "gatewayInstructionId",
    "gatewayAttemptId",
    "gatewayRole",
    "lastUpdatedStamp"
]
const manualInstruments = [
    "PiCash",
    "PiPersonalCheck",
    "PiCompanyCheck",
    "PiCertifiedCheck",
    "PiMoneyOrder",
    "PiWireTransfer",
    "PiAch",
    "PiCod",
    "PiOther"
]
function broadRead() {
    return has("PAYMENT_VIEW") || has("ACCOUNTING_VIEW") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()
}
function ledgerRead() {
    return has("ACCOUNTING_VIEW") || has("ACCOUNTING_GL_POST") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()
}
function paymentContext(p, write = false, lock = false) {
    const organizationPartyId = lib.organization(
        p.organizationPartyId || lib.policy.access().activeOrganizationPartyId,
        null,
        lock
    )
    const broad = broadRead()
    if (!broad && !has("RECEIVABLE_VIEW") && !has("PAYABLE_VIEW"))
        denied("PERMISSION_DENIED", "Payment view authority is required")
    if (write && (!broad || !has("PAYMENT_EDIT")))
        denied("PERMISSION_DENIED", "Payment editing and payment view authority are required")
    const guardEnabled = lib.policy.preference(organizationPartyId).settlementApplicationGuardEnabled === "Y"
    return {organizationPartyId, broad, guardEnabled}
}
function sideCondition(org, direction) {
    const cf = ec.entity.conditionFactory,
        normal = direction === "receivable" ? "toPartyId" : "fromPartyId",
        original = direction === "receivable" ? "originalToPartyId" : "originalFromPartyId"
    return cf.makeCondition(
        [
            cf.makeCondition(
                [
                    cf.makeCondition("financeOrganizationPartyId", "equals", org),
                    cf.makeCondition("financeDirection", "equals", direction)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "is-null", null),
                    cf.makeCondition("refundForPaymentId", "is-null", null),
                    cf.makeCondition(normal, "equals", org)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "is-null", null),
                    cf.makeCondition("originalFinanceOrganizationPartyId", "equals", org),
                    cf.makeCondition("originalFinanceDirection", "equals", direction)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "is-null", null),
                    cf.makeCondition("originalFinanceDirection", "is-null", null),
                    cf.makeCondition(original, "equals", org)
                ],
                "and"
            )
        ],
        "or"
    )
}
function paymentQuery(scope, p = {}) {
    const cf = ec.entity.conditionFactory,
        org = scope.organizationPartyId
    let q = privateQuery(
        find("mantle.account.payment.PaymentGatewayLifecycleBalance").condition(
            cf.makeCondition([cf.makeCondition("fromPartyId", "equals", org), cf.makeCondition("toPartyId", "equals", org)], "or")
        )
    )
    if (!scope.broad) {
        const sides = []
        if (has("RECEIVABLE_VIEW")) sides.push(sideCondition(org, "receivable"))
        if (has("PAYABLE_VIEW")) sides.push(sideCondition(org, "payable"))
        q = q.condition(cf.makeCondition(sides, "or")).condition("paymentTypeEnumId", "not-equals", "PtInternalTransfer")
    }
    const queue = p.queue || "all"
    if (!["all", "incoming", "outgoing", "toValidate", "unapplied", "refunds", "transfers"].includes(queue))
        denied("PAYMENT_QUEUE_INVALID", "Choose a payment queue")
    if (queue === "incoming") q = q.condition("toPartyId", org).condition("fromPartyId", "not-equals", org)
    if (queue === "outgoing") q = q.condition("fromPartyId", org).condition("toPartyId", "not-equals", org)
    if (queue === "toValidate") q = q.condition("statusId", "PmntProposed")
    if (queue === "unapplied")
        q = q
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .condition("availableAmount", "greater", 0)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("paymentTypeEnumId", "is-null", null),
                        cf.makeCondition("paymentTypeEnumId", "not-equals", "PtInternalTransfer")
                    ],
                    "or"
                )
            )
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("gatewayRole", "is-null", null),
                        cf.makeCondition("gatewayRole", "not-equals", "authorization")
                    ],
                    "or"
                )
            )
    if (queue === "refunds") q = q.condition("refundForPaymentId", "is-not-null", null)
    if (queue === "transfers") q = q.condition("paymentTypeEnumId", "PtInternalTransfer")
    for (const field of ["paymentInstrumentEnumId", "statusId"]) if (p[field]) q = q.condition(field, p[field])
    if (p.currencyUomId) q = q.condition("amountUomId", p.currencyUomId)
    if (p.partyId)
        q = q.condition(
            cf.makeCondition(
                [cf.makeCondition("fromPartyId", "equals", p.partyId), cf.makeCondition("toPartyId", "equals", p.partyId)],
                "or"
            )
        )
    for (const [field, operator] of [
        ["fromDay", "greater-equals"],
        ["throughDay", "less-equals"]
    ])
        if (p[field]) {
            const day = String(p[field])
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) denied("DATE_INVALID", "Choose a valid payment date")
            const stamp = ec.l10n.parseTimestamp(
                day + (field === "throughDay" ? " 23:59:59.999" : " 00:00:00.000"),
                "yyyy-MM-dd HH:mm:ss.SSS"
            )
            q = q.condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("accountingDate", operator, day),
                        cf.makeCondition(
                            [
                                cf.makeCondition("accountingDate", "is-null", null),
                                cf.makeCondition("effectiveDate", operator, stamp)
                            ],
                            "and"
                        )
                    ],
                    "or"
                )
            )
        }
    if (String(p.text || "").trim())
        q = q.condition(
            cf.makeCondition(
                [
                    "paymentId",
                    "paymentRefNum",
                    "comments",
                    "fromOrganizationName",
                    "fromFirstName",
                    "fromLastName",
                    "toOrganizationName",
                    "toFirstName",
                    "toLastName"
                ].map(field => cf.makeCondition(field, "like", "%" + String(p.text).trim().slice(0, 200) + "%").ignoreCase()),
                "or"
            )
        )
    return q
}
function paymentScope(p, write = false, lock = false) {
    let parameters = p
    if (!p.organizationPartyId && !lib.policy.access().activeOrganizationPartyId) {
        const source = one(P, {paymentId: p.paymentId})
        if (!source) denied("PAYMENT_UNAVAILABLE", "Payment is not available")
        const internal = [...new Set([source.fromPartyId, source.toPartyId])].filter(partyId =>
            one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        )
        const organizationPartyId = source.financeOrganizationPartyId || (internal.length === 1 ? internal[0] : null)
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the organization for this payment")
        parameters = Object.assign({}, p, {organizationPartyId})
    }
    const scope = paymentContext(parameters, write, lock)
    let record = paymentQuery(scope).condition("paymentId", p.paymentId).one()
    if (!record) denied("PAYMENT_UNAVAILABLE", "Payment is not available")
    // The balance view authorizes selection; financial revisions always use the same base entity as locked writers.
    record = find(P, {paymentId: p.paymentId}).forUpdate(lock).one()
    if (!record || ![record.fromPartyId, record.toPartyId].includes(scope.organizationPartyId))
        denied("PAYMENT_UNAVAILABLE", "Payment is not available")
    const org = scope.organizationPartyId,
        original = record.refundForPaymentId ? one(P, {paymentId: record.refundForPaymentId}) : null,
        directionRecord = original || record
    const financeDirection =
        record.paymentTypeEnumId === "PtInternalTransfer"
            ? "transfer"
            : record.financeOrganizationPartyId === org && record.financeDirection
              ? record.financeDirection
              : directionRecord.financeOrganizationPartyId === org && directionRecord.financeDirection
                ? directionRecord.financeDirection
                : directionRecord.toPartyId === org
                  ? "receivable"
                  : "payable"
    const partyId = record.fromPartyId === org ? record.toPartyId : record.fromPartyId
    const party = one("mantle.party.Party", {partyId})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("PAYMENT_UNAVAILABLE", "Payment is not available")
    if (
        !scope.broad &&
        (financeDirection === "transfer" || !has(financeDirection === "receivable" ? "RECEIVABLE_VIEW" : "PAYABLE_VIEW"))
    )
        denied("PERMISSION_DENIED", "Matching side payment view authority is required")
    return Object.assign(scope, {
        record,
        original,
        financeDirection,
        tradeExcluded: partyId === org || Boolean(one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})),
        cashDirection:
            record.paymentTypeEnumId === "PtInternalTransfer" ? "transfer" : record.fromPartyId === org ? "outgoing" : "incoming",
        partyId
    })
}
function paymentApplications(ids) {
    if (!ids.length) return []
    const cf = ec.entity.conditionFactory
    return Array.from(
        find(A)
            .condition(
                cf.makeCondition([cf.makeCondition("paymentId", "in", ids), cf.makeCondition("toPaymentId", "in", ids)], "or")
            )
            .orderBy("paymentApplicationId")
            .list()
    )
}
function paymentVersion(record, applicationRows = null) {
    const fields = paymentFields.concat([
            "financeOrganizationPartyId",
            "financeDirection",
            "paymentGatewayConfigId",
            "overrideGlAccountId",
            "overrideOrgPartyId"
        ]),
        header = Object.fromEntries(
            fields.map(field => {
                const value = record[field]
                if (value == null) return [field, null]
                if (["accountingDate", "settlementAccountingDate"].includes(field))
                    return [field, lib.policy.calendarDateText(value)]
                if (field.endsWith("Date") || field.endsWith("Stamp")) return [field, lib.ms(value)]
                if (field === "amount") return [field, String(ec.l10n.roundCurrency(toDecimal(value), record.amountUomId))]
                return [field, String(value)]
            })
        )
    return lib.hash({header, applications: (applicationRows || paymentApplications([record.paymentId])).map(lib.map)})
}
function paymentTotals(record, applicationRows) {
    const amount = toDecimal(record.amount || 0),
        appliedTotal = applicationRows.reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
    return {amount, appliedTotal, unappliedTotal: amount.subtract(appliedTotal), currencyUomId: record.amountUomId}
}
function paymentCapabilities(scope, applicationRows = [], posted = false) {
    const r = scope.record,
        draft = r && ["PmntProposed", "PmntPromised"].includes(r.statusId),
        canWrite = scope.broad && has("PAYMENT_EDIT"),
        supported =
            r &&
            !r.refundForPaymentId &&
            r.gatewayRole !== "authorization" &&
            r.paymentTypeEnumId === "PtInvoicePayment" &&
            !scope.tradeExcluded,
        hasApplications = applicationRows.some(row => toDecimal(row.amountApplied || 0).compare(0) > 0),
        sideEdit = has(scope.financeDirection === "receivable" ? "RECEIVABLE_EDIT" : "PAYABLE_EDIT"),
        gateway = Boolean(
            scope.gatewayManaged || r?.paymentGatewayConfigId || !manualInstruments.includes(r?.paymentInstrumentEnumId)
        )
    const capabilities = {
        canRead: true,
        canCreate: scope.broad && has("PAYMENT_EDIT"),
        canEdit: Boolean(
            canWrite &&
            supported &&
            draft &&
            !posted &&
            !hasApplications &&
            !scope.hasGatewayInstruction &&
            !scope.hasPriorFinancialHistory
        ),
        canEditDraft: Boolean(
            canWrite &&
            supported &&
            draft &&
            !posted &&
            !hasApplications &&
            !scope.hasGatewayInstruction &&
            !scope.hasPriorFinancialHistory
        ),
        canValidate: Boolean(
            canWrite &&
            supported &&
            r.statusId === "PmntProposed" &&
            Boolean(r.effectiveDate) &&
            !posted &&
            !scope.hasPriorFinancialHistory &&
            !scope.hasGatewayInstruction
        ),
        canDeliver: Boolean(
            canWrite &&
            supported &&
            draft &&
            !gateway &&
            Boolean(r.effectiveDate) &&
            !posted &&
            !hasApplications &&
            !r.forInvoiceId &&
            !scope.hasPriorFinancialHistory &&
            !scope.hasGatewayInstruction
        ),
        canManualDeliver: Boolean(
            canWrite &&
            supported &&
            draft &&
            !gateway &&
            Boolean(r.effectiveDate) &&
            !posted &&
            !hasApplications &&
            !r.forInvoiceId &&
            !scope.hasPriorFinancialHistory &&
            !scope.hasGatewayInstruction
        ),
        canConfirm: Boolean(canWrite && supported && r.statusId === "PmntDelivered" && !gateway && posted),
        canCancel: Boolean(canWrite && supported && draft && !posted && !hasApplications && !scope.hasGatewayInstruction),
        canVoid: Boolean(
            canWrite &&
            supported &&
            !r.gatewayRole &&
            ["PmntDelivered", "PmntConfirmed"].includes(r.statusId) &&
            posted &&
            (!hasApplications || sideEdit) &&
            (!r.reconcileStatusId || r.reconcileStatusId === "PmtrNot")
        ),
        canUnapply: Boolean(
            canWrite &&
            supported &&
            hasApplications &&
            sideEdit &&
            ["PmntDelivered", "PmntConfirmed"].includes(r.statusId) &&
            posted
        ),
        canReadGateway: scope.broad && (has("PAYMENT_EDIT") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin()),
        canReadLedger: ledgerRead(),
        canReadFiles: true,
        canUploadContent: Boolean(canWrite && supported),
        canPrintReceipt: false,
        canPrintDetail: false,
        canPrintCheck: false,
        canGatewayAuthorize: false,
        canGatewayCapture: false,
        canGatewayRelease: false,
        canGatewayRefund: false,
        canRefund: false,
        canPreviewRefund: false,
        canTransfer: Boolean(scope.broad && has("PAYMENT_EDIT")),
        reasons: [],
        unavailableReason: "PAYMENT_SLICE_UNAVAILABLE"
    }
    if (r && ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js").adoptionRefusal(r)) {
        Object.assign(capabilities, {
            canEdit: false,
            canEditDraft: false,
            canValidate: false,
            canDeliver: false,
            canManualDeliver: false,
            canConfirm: false,
            canCancel: false,
            canVoid: false,
            canUnapply: false
        })
        capabilities.reasons.push("LEGACY_GATEWAY_ADOPTION_REFUSED")
    }
    return Object.assign(
        capabilities,
        ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayWorkflow.js").capabilities(scope)
    )
}
function paymentProjection(scope, record, appRows, names = {}) {
    if (!scope.labels)
        scope.labels = {
            statuses: Object.fromEntries(
                rows("moqui.basic.StatusItem", {statusTypeId: "Payment"}).map(row => [row.statusId, row.description])
            ),
            instruments: Object.fromEntries(
                rows("moqui.basic.Enumeration", {enumTypeId: "PaymentInstrument"}).map(row => [row.enumId, row.description])
            )
        }
    const org = scope.organizationPartyId,
        cashDirection =
            record.paymentTypeEnumId === "PtInternalTransfer" ? "transfer" : record.fromPartyId === org ? "outgoing" : "incoming",
        partyId = cashDirection === "outgoing" ? record.toPartyId : record.fromPartyId,
        financeDirection =
            record.paymentTypeEnumId === "PtInternalTransfer"
                ? "transfer"
                : record.financeDirection ||
                  record.originalFinanceDirection ||
                  scope.original?.financeDirection ||
                  ((record.refundForPaymentId ? record.originalToPartyId || scope.original?.toPartyId : record.toPartyId) === org
                      ? "receivable"
                      : "payable"),
        out = lib.policy.pick(
            lib.display(record),
            paymentFields
                .filter(field => !["forInvoiceId", "refundForPaymentId", "orderId", "orderPartSeqId"].includes(field))
                .concat(paymentFields.filter(field => /Date$|Stamp$/.test(field)).map(field => field + "Text"))
        )
    out.effectiveDateValue = record.accountingDate
        ? lib.policy.calendarDateText(record.accountingDate)
        : record.effectiveDate
          ? ec.l10n.format(record.effectiveDate, "yyyy-MM-dd")
          : null
    out.accountingDateText = out.effectiveDateValue
    out.effectiveDateText = record.accountingDate ? out.effectiveDateValue : lib.policy.dateText(record.effectiveDate)
    out.settlementDateText = record.settlementAccountingDate
        ? lib.policy.calendarDateText(record.settlementAccountingDate)
        : lib.policy.dateText(record.settlementDate)
    Object.assign(out, paymentTotals(record, appRows), {
        partyId,
        partyName: names[partyId] || partyId,
        fromName: names[record.fromPartyId],
        toName: names[record.toPartyId],
        cashDirection,
        financeDirection,
        referenceNumber: record.paymentRefNum,
        currencyUomId: record.amountUomId,
        sourceVersion: paymentVersion(scope.versionRecords?.[record.paymentId] || record, appRows),
        statusDescription: scope.labels.statuses[record.statusId] || record.statusId,
        instrumentDescription: scope.labels.instruments[record.paymentInstrumentEnumId] || record.paymentInstrumentEnumId
    })
    const held =
        record.reservedAmount != null ? toDecimal(record.reservedAmount) : scope.holdEvidence?.[record.paymentId]?.heldAmount
    if (held != null) {
        out.reservedAmount = held
        out.availableAmount = out.unappliedTotal.subtract(held)
    }
    out.isCash = record.gatewayRole !== "authorization"
    if (record.gatewayRole === "authorization") {
        out.instructionAmount = out.amount
        out.appliedTotal = toDecimal(0)
        out.unappliedTotal = toDecimal(0)
        out.reservedAmount = toDecimal(0)
        out.availableAmount = toDecimal(0)
    }
    if (record.paymentTypeEnumId === "PtInternalTransfer") {
        out.transferSummary = transferProjection(record).transferSummary
        Object.assign(out, {
            appliedTotal: toDecimal(0),
            unappliedTotal: toDecimal(0),
            reservedAmount: toDecimal(0),
            availableAmount: toDecimal(0)
        })
    }
    if (record.gatewayInstructionId && record.gatewayRole === "capture") {
        const instruction = one("mantle.account.payment.PaymentGatewayInstruction", {instructionId: record.gatewayInstructionId})
        if (instruction?.organizationPartyId === org && instruction.partyId === partyId)
            out.authorizationPaymentId = instruction.paymentId
    }
    return out
}
function payments(p) {
    const scope = paymentContext(p),
        count = paymentQuery(scope, p).count(),
        page = lib.page(paymentQuery(scope, p).orderBy("-effectiveDate,paymentId"), p, "records", count),
        ids = [...new Set(Array.from(p.selectedPaymentIdList || []).map(String))]
    if (ids.length > 200) denied("PAYMENT_SELECTION_LIMIT", "Select at most two hundred payments")
    const selectedRows = ids.length ? Array.from(paymentQuery(scope).condition("paymentId", "in", ids).list()) : [],
        records = [...page.rows, ...selectedRows],
        apps = paymentApplications(records.map(row => row.paymentId)),
        names = lib.partyNames(records.flatMap(row => [row.fromPartyId, row.toPartyId])),
        errors = []
    scope.holdEvidence = ec.resource
        .script("component://mr-mantle/service/mantle/account/PaymentGatewayReservations.js")
        .cashHoldSummaries({organizationPartyId: scope.organizationPartyId, paymentIdList: records.map(row => row.paymentId)})
    scope.versionRecords = records.length
        ? Object.fromEntries(
              Array.from(
                  find(P)
                      .condition("paymentId", "in", [...new Set(records.map(row => row.paymentId))])
                      .list()
              ).map(row => [row.paymentId, row])
          )
        : {}
    function projectRow(record) {
        try {
            return paymentProjection(
                scope,
                record,
                apps.filter(row => row.paymentId === record.paymentId || row.toPaymentId === record.paymentId),
                names
            )
        } catch (error) {
            ec.logger.error("Payment " + record.paymentId + " projection: " + error.message)
            errors.push({paymentId: record.paymentId, reasonCode: "PAYMENT_READ_FAILED"})
            return null
        }
    }
    return Object.assign(
        lib.policy.pick(page, ["recordCount", "pageIndex", "pageSize", "pageMaxIndex", "pageRangeLow", "pageRangeHigh"]),
        {
            rows: page.rows.map(projectRow).filter(Boolean),
            selectedRows: selectedRows.map(projectRow).filter(Boolean),
            complete: !errors.length,
            errors,
            capabilities: paymentCapabilities(scope),
            totals: {basis: "page", currencies: [...new Set(page.rows.map(row => row.amountUomId))]}
        }
    )
}
const bankIdentityFields = ["paymentMethodId", "bankName", "typeEnumId", "routingNumber", "accountNumber"]
const cardIdentityFields = ["paymentMethodId", "creditCardTypeEnumId", "cardNumber", "validFromDate", "expireDate", "issueNumber"]
const methodIdentityFields = [
    "paymentMethodId",
    "paymentMethodTypeEnumId",
    "ownerPartyId",
    "fromDate",
    "thruDate",
    "currencyUomId",
    "glAccountId",
    "paymentGatewayConfigId",
    "originalPaymentMethodId",
    "description",
    "titleOnAccount",
    "firstNameOnAccount",
    "middleNameOnAccount",
    "lastNameOnAccount",
    "suffixOnAccount",
    "companyNameOnAccount",
    "postalContactMechId",
    "gatewayCimId"
]
function subtypeQuery(entity, fields) {
    let query = find(entity)
    for (const field of fields) query = query.selectField(field)
    return query
}
function methodIdentities(method, lock = false) {
    return {
        bank:
            method.paymentMethodTypeEnumId === "PmtBankAccount"
                ? subtypeQuery("mantle.account.method.BankAccount", bankIdentityFields)
                      .condition("paymentMethodId", method.paymentMethodId)
                      .forUpdate(lock)
                      .one()
                : null,
        card:
            method.paymentMethodTypeEnumId === "PmtCreditCard"
                ? subtypeQuery("mantle.account.method.CreditCard", cardIdentityFields)
                      .condition("paymentMethodId", method.paymentMethodId)
                      .forUpdate(lock)
                      .one()
                : null
    }
}
function methodVersion(method, identities = null) {
    const {bank, card} = identities || methodIdentities(method)
    return lib.hash({
        method: lib.policy.pick(lib.map(method), methodIdentityFields),
        bank: bank ? lib.policy.pick(lib.map(bank), bankIdentityFields) : null,
        card: card ? lib.policy.pick(lib.map(card), cardIdentityFields) : null
    })
}
// An internal transfer: one payment from the organization's from method (paymentMethodId) to its to method
// (toPaymentMethodId), shown as its outgoing and incoming sides with masked method labels.
function transferProjection(record) {
    const label = paymentMethodId => {
            const method = paymentMethodId && one("mantle.account.method.PaymentMethod", {paymentMethodId})
            return method ? methodRows([method])[0].label : null
        },
        summary = {
            paymentId: record.paymentId,
            principalAmount: String(record.amount ?? 0),
            currencyUomId: record.amountUomId,
            accountingDateText: record.effectiveDate ? ec.l10n.format(record.effectiveDate, "yyyy-MM-dd") : null,
            fromMethodLabel: label(record.paymentMethodId),
            toMethodLabel: label(record.toPaymentMethodId),
            referenceNumber: record.paymentRefNum,
            reason: record.comments
        },
        side = (leg, maskedMethodLabel) => ({
            paymentId: record.paymentId,
            leg,
            maskedMethodLabel,
            amount: summary.principalAmount,
            currencyUomId: summary.currencyUomId,
            accountingDateText: summary.accountingDateText
        })
    return {
        transferSummary: summary,
        transferLegRows: [side("outgoing", summary.fromMethodLabel), side("incoming", summary.toMethodLabel)]
    }
}
function methodRows(records) {
    const ids = records.map(row => row.paymentMethodId),
        banks = ids.length
            ? Array.from(
                  subtypeQuery("mantle.account.method.BankAccount", bankIdentityFields)
                      .condition("paymentMethodId", "in", ids)
                      .list()
              )
            : [],
        cards = ids.length
            ? Array.from(
                  subtypeQuery("mantle.account.method.CreditCard", cardIdentityFields)
                      .condition("paymentMethodId", "in", ids)
                      .list()
              )
            : [],
        types = rows("moqui.basic.Enumeration", {enumTypeId: "PaymentMethodType"})
    return records.map(method => {
        const bank = banks.find(row => row.paymentMethodId === method.paymentMethodId),
            card = cards.find(row => row.paymentMethodId === method.paymentMethodId),
            number = bank?.accountNumber || card?.cardNumber,
            lastFour = number ? String(number).slice(-4) : null,
            typeDescription =
                types.find(row => row.enumId === method.paymentMethodTypeEnumId)?.description || method.paymentMethodTypeEnumId
        return {
            paymentMethodId: method.paymentMethodId,
            ownerPartyId: method.ownerPartyId,
            paymentMethodTypeEnumId: method.paymentMethodTypeEnumId,
            typeDescription,
            description: method.description,
            currencyUomId: method.currencyUomId,
            maskedNumber: lastFour ? "•••• " + lastFour : null,
            label: [method.description || typeDescription, lastFour ? "•••• " + lastFour : null].filter(Boolean).join(" · "),
            version: methodVersion(method, {bank, card}),
            gatewayManaged: Boolean(method.paymentGatewayConfigId)
        }
    })
}
// Treasury reads issued checks: payment view and payment edit (or accounting administration).
function treasury(scope) {
    return scope.broad && (has("PAYMENT_EDIT") || has("ACCOUNTING_ADMIN") || lib.access.systemAdmin())
}
// The payment's content the user may read: check images only with treasury authority.
function contentQuery(scope) {
    const cf = ec.entity.conditionFactory
    let query = find("mantle.account.payment.PaymentContent", {paymentId: scope.record.paymentId})
    if (!treasury(scope))
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("contentTypeEnumId", "is-null", null),
                    cf.makeCondition("contentTypeEnumId", "not-equals", "PctCheckImage")
                ],
                "or"
            )
        )
    return query
}
// A payment the user may read, and what they may do with its files: add them (canChange), replace or remove them
// (not once the payment is posted: contentLocked) and read check images (canReadCheck).
function access(p) {
    const scope = paymentScope(p),
        posted = find("mantle.ledger.transaction.AcctgTrans", {paymentId: scope.record.paymentId, isPosted: "Y"}).count() > 0
    return {
        organizationPartyId: scope.organizationPartyId,
        partyId: scope.partyId,
        cashDirection: scope.cashDirection,
        canChange: scope.broad && has("PAYMENT_EDIT"),
        contentLocked: posted,
        canReadCheck: treasury(scope)
    }
}
// The organization whose payment methods a user with payment view authority may choose from.
function methodScope(p) {
    const scope = paymentContext(p)
    if (!scope.broad) denied("PERMISSION_DENIED", "Payment method choices require payment view authority")
    return {organizationPartyId: scope.organizationPartyId}
}
// Masked rows of the given payment methods, for a service's paymentMethodList.
function maskedMethods(p) {
    return {methodRows: methodRows(Array.from(p.paymentMethodList || []))}
}
function visibleApplications(scope, applicationRows) {
    if (!applicationRows.length && !scope.record.forInvoiceId) return {rows: [], restricted: false, invoiceIds: new Set()}
    const invoiceIds = [
            ...new Set(
                [...applicationRows.flatMap(row => [row.invoiceId, row.toInvoiceId]), scope.record.forInvoiceId].filter(Boolean)
            )
        ],
        paymentIds = [...new Set(applicationRows.flatMap(row => [row.paymentId, row.toPaymentId]).filter(Boolean))],
        allowedInvoices = new Set(),
        allowedPayments = new Set()
    try {
        const trade = context({
            organizationPartyId: scope.organizationPartyId,
            partyId: scope.partyId,
            direction: scope.financeDirection,
            currencyUomId: scope.record.amountUomId
        })
        for (const [ids, types, field, target] of [
            [invoiceIds, ["invoice", "credit"], "invoiceId", allowedInvoices],
            [paymentIds, ["payment", "paymentTarget"], "paymentId", allowedPayments]
        ]) {
            if (!ids.length) continue
            for (const kind of types)
                for (const row of query(trade, kind, {ids, selected: true}).selectField(field).list()) target.add(row[field])
        }
    } catch (error) {
        ec.logger.error("Payment " + scope.record.paymentId + " linked record read: " + error.message)
        return {rows: [], restricted: true, invoiceIds: allowedInvoices}
    }
    const visible = applicationRows.filter(
        row =>
            [row.invoiceId, row.toInvoiceId].filter(Boolean).every(id => allowedInvoices.has(id)) &&
            [row.paymentId, row.toPaymentId].filter(Boolean).every(id => allowedPayments.has(id))
    )
    return {rows: visible, restricted: visible.length !== applicationRows.length, invoiceIds: allowedInvoices}
}
function paymentDetailRead(p) {
    const scope = paymentScope(p),
        record = scope.record,
        apps = paymentApplications([p.paymentId]),
        names = lib.partyNames([record.fromPartyId, record.toPartyId]),
        transactions = Array.from(
            find("mantle.ledger.transaction.AcctgTrans", {paymentId: p.paymentId, organizationPartyId: scope.organizationPartyId})
                .orderBy("transactionDate,acctgTransId")
                .limit(501)
                .list()
        ),
        posted = transactions.some(row => row.isPosted === "Y" && !row.reversedByAcctgTransId && !row.reverseOfAcctgTransId),
        methodIds = [record.paymentMethodId, record.toPaymentMethodId].filter(Boolean),
        maskedMethodRows = methodIds.length
            ? methodRows(
                  Array.from(find("mantle.account.method.PaymentMethod").condition("paymentMethodId", "in", methodIds).list())
              )
            : []
    scope.holdEvidence = ec.resource
        .script("component://mr-mantle/service/mantle/account/PaymentGatewayReservations.js")
        .cashHoldSummaries({organizationPartyId: scope.organizationPartyId, paymentIdList: [record.paymentId]})
    scope.gatewayManaged = maskedMethodRows.some(row => row.gatewayManaged)
    scope.hasGatewayInstruction = Boolean(
        find("mantle.account.method.PaymentGatewayResponse", {paymentId: p.paymentId}).limit(1).one()
    )
    scope.hasPriorFinancialHistory = apps.length > 0 || transactions.length > 0
    const visible = visibleApplications(scope, apps),
        capabilities = paymentCapabilities(scope, apps, posted),
        out = {
            payment: paymentProjection(scope, record, apps, names),
            sourceVersion: paymentVersion(record, apps),
            totals: paymentTotals(record, apps),
            maskedMethodRows,
            applicationRows: visible.rows.map(row =>
                Object.assign(
                    lib.policy.pick(lib.display(row), [
                        "paymentApplicationId",
                        "paymentId",
                        "toPaymentId",
                        "invoiceId",
                        "toInvoiceId",
                        "amountApplied",
                        "appliedDate",
                        "appliedDateText",
                        "currencyUomId"
                    ]),
                    {version: lib.hash(lib.map(row))}
                )
            ),
            refundRows: [],
            contentRows: [],
            historyRows: [],
            sourceRows: [],
            capabilities,
            reasons: capabilities.reasons,
            refundableAvailable: false,
            refundableReason: "PAYMENT_SLICE_UNAVAILABLE",
            complete: transactions.length <= 500,
            errors: []
        }
    out.totals.reservedAmount = scope.holdEvidence[record.paymentId].heldAmount
    out.totals.availableAmount = out.totals.unappliedTotal.subtract(out.totals.reservedAmount)
    if (visible.restricted) {
        out.complete = false
        out.errors.push({reasonCode: "APPLICATIONS_RESTRICTED", message: "Some application links are unavailable"})
        capabilities.canVoid = false
    }
    out.refundRows = Array.from(
        paymentQuery(scope, {partyId: scope.partyId, currencyUomId: record.amountUomId})
            .condition(sideCondition(scope.organizationPartyId, scope.financeDirection))
            .condition("refundForPaymentId", p.paymentId)
            .orderBy("effectiveDate,paymentId")
            .limit(100)
            .list()
    ).map(row => paymentProjection(scope, row, paymentApplications([row.paymentId]), names))
    const outputService = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js")
    Object.assign(capabilities, outputService.available(scope))
    out.outputRows = capabilities.outputRows
    delete capabilities.outputRows
    if (record.paymentTypeEnumId === "PtInternalTransfer") {
        Object.assign(out, transferProjection(record))
        Object.assign(out.totals, {
            appliedTotal: toDecimal(0),
            unappliedTotal: toDecimal(0),
            reservedAmount: toDecimal(0),
            availableAmount: toDecimal(0)
        })
    }
    if (record.gatewayRole === "authorization") {
        Object.assign(out.totals, {
            amount: toDecimal(0),
            appliedTotal: toDecimal(0),
            unappliedTotal: toDecimal(0),
            reservedAmount: toDecimal(0),
            availableAmount: toDecimal(0)
        })
        Object.assign(capabilities, {canPrintReceipt: false, canPrintDetail: false, canPrintCheck: false})
    }
    if (capabilities.canReadGateway && record.gatewayInstructionId) {
        const gateway = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayWorkflow.js"),
            instruction = gateway.instructionFor(record)
        if (instruction?.organizationPartyId === scope.organizationPartyId)
            out.gatewayInstruction = gateway.instructionSummary(instruction)
    }
    out.contentRows = contentQuery(scope)
        .orderBy("-contentDate,paymentContentId")
        .limit(100)
        .list()
        .map(row =>
            lib.policy.pick(lib.display(row), [
                "paymentContentId",
                "contentTypeEnumId",
                "description",
                "contentDate",
                "contentDateText",
                "userId"
            ])
        )
    out.historyRows = Array.from(
        find("mantle.account.payment.PaymentLifecycleEvent", {
            paymentId: p.paymentId,
            organizationPartyId: scope.organizationPartyId
        })
            .orderBy("-createdDate,paymentLifecycleEventId")
            .limit(100)
            .list()
    ).map(row =>
        lib.policy.pick(lib.display(row), [
            "paymentLifecycleEventId",
            "action",
            "beforeStatusId",
            "afterStatusId",
            "referenceNumber",
            "reason",
            "userId",
            "createdDate",
            "createdDateText"
        ])
    )
    out.sourceRows = [
        record.forInvoiceId && visible.invoiceIds.has(record.forInvoiceId)
            ? {sourceKind: "invoice", sourceId: record.forInvoiceId}
            : null
    ].filter(Boolean)
    if (record.orderId) {
        let order = find("mantle.order.OrderPart", {
            orderId: record.orderId,
            vendorPartyId: scope.financeDirection === "receivable" ? scope.organizationPartyId : scope.partyId,
            customerPartyId: scope.financeDirection === "receivable" ? scope.partyId : scope.organizationPartyId
        })
        if (record.orderPartSeqId) order = order.condition("orderPartSeqId", record.orderPartSeqId)
        if (order.limit(1).one()) out.sourceRows.push({sourceKind: "order", sourceId: record.orderId})
    }
    if (
        scope.original &&
        [scope.original.fromPartyId, scope.original.toPartyId].includes(scope.organizationPartyId) &&
        [scope.original.fromPartyId, scope.original.toPartyId].includes(scope.partyId) &&
        scope.original.amountUomId === record.amountUomId
    )
        out.sourceRows.push({sourceKind: "payment", sourceId: scope.original.paymentId})
    if (capabilities.canReadLedger)
        out.ledgerRows = transactions
            .slice(0, 500)
            .map(row =>
                lib.policy.pick(lib.display(row), [
                    "acctgTransId",
                    "acctgTransTypeEnumId",
                    "transactionDate",
                    "transactionDateText",
                    "accountingDate",
                    "isPosted",
                    "reverseOfAcctgTransId",
                    "reversedByAcctgTransId",
                    "amountUomId"
                ])
            )
    if (capabilities.canReadGateway)
        out.gatewayRows = Array.from(
            find("mantle.account.method.PaymentGatewayResponse", {paymentId: p.paymentId})
                .orderBy("-transactionDate")
                .limit(100)
                .list()
        ).map(row =>
            lib.policy.pick(lib.display(row), [
                "paymentGatewayResponseId",
                "paymentOperationEnumId",
                "transactionDate",
                "transactionDateText",
                "amount",
                "amountUomId",
                "resultSuccess",
                "resultDeclined",
                "resultError",
                "referenceNum",
                "transactionStatus",
                "responseCode",
                "reasonCode"
            ])
        )
    if (capabilities.canReadGateway && record.gatewayRole) {
        out.gatewayRows = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentGatewayWorkflow.js")
            .findTransactions({organizationPartyId: scope.organizationPartyId, paymentId: record.paymentId, pageSize: 100}).rows
    }
    if (
        capabilities.canReadGateway &&
        record.paymentTypeEnumId === "PtInvoicePayment" &&
        !record.refundForPaymentId &&
        record.gatewayRole !== "authorization" &&
        ["PmntDelivered", "PmntConfirmed"].includes(record.statusId)
    ) {
        const refunds = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentRefunds.js")
            .summary({organizationPartyId: scope.organizationPartyId, paymentId: record.paymentId})
        out.refundSummary = refunds.refundSummary
        out.refundDefaults = refunds.refundDefaults
        Object.assign(
            capabilities,
            lib.policy.pick(refunds.capabilities, [
                "canPreviewRefund",
                "canRefund",
                "canGatewayRefund",
                "refundUnavailableReason"
            ])
        )
        capabilities.refundReasons = refunds.capabilities.reasons
    }
    if (scope.broad && has("PAYMENT_EDIT")) {
        const evidence = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentLifecycle.js")
            .evidenceOptions(
                scope,
                Array.from(
                    contentQuery(scope)
                        .orderBy("-contentDate,paymentContentId")
                        .limit(101)
                        .list()
                )
            )
        out.evidenceRows = evidence.evidenceRows
        out.evidenceIncomplete = evidence.incomplete
        const byId = Object.fromEntries(evidence.evidenceRows.map(row => [row.paymentContentId, row]))
        out.contentRows = out.contentRows.map(row => Object.assign(row, byId[row.paymentContentId] || {}))
    }
    return out
}
const operations = {openItems, payments, paymentDetail: paymentDetailRead, access, methodScope, maskedMethods}
// Runs one payment read for its service and puts the results in the service's context.
function execute(op, context) {
    if (!operations[op]) throw new Error("Unknown payment workflow operation " + op)
    const result = operations[op](context)
    ec.context.putAll(result)
    return result
}
const paymentDetail = paymentDetailRead
;({
    execute,
    lib,
    I,
    P,
    A,
    kinds,
    context,
    key,
    parseKey,
    query,
    project,
    selected,
    applications,
    openItems,
    broadRead,
    ledgerRead,
    treasury,
    paymentContext,
    paymentQuery,
    paymentScope,
    paymentApplications,
    paymentVersion,
    paymentTotals,
    paymentCapabilities,
    paymentProjection,
    payments,
    methodVersion,
    methodIdentityFields,
    bankIdentityFields,
    cardIdentityFields,
    methodIdentities,
    methodRows,
    paymentDetail,
    manualInstruments
})
