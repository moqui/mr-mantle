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
    const guardEnabled = lib.policy.preference(organizationPartyId).settlementApplicationGuardEnabled === "Y"
    return {
        organizationPartyId,
        partyId: p.partyId,
        direction,
        currencyUomId: p.currencyUomId,
        capabilities: {
            canRead: true,
            canApply: has(side + "_EDIT") && guardEnabled,
            guardEnabled,
            reasons: guardEnabled ? [] : ["SETTLEMENT_GUARD_REQUIRED"],
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
    let q = find("mantle.account.payment.Settlement" + (invoice ? "Invoice" : "Payment") + "Balance")
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
        q = q.condition("balanceRemaining", "greater", 0)
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
        names = lib.partyNames([scope.partyId])
    return records.map(record => {
        const id = invoice ? record.invoiceId : record.paymentId
        const evidence = applied.filter(row =>
            invoice ? [row.invoiceId, row.toInvoiceId].includes(id) : [row.paymentId, row.toPaymentId].includes(id)
        )
        const original = invoice ? invoiceTotals[id].invoiceTotal : toDecimal(record.amount || 0)
        const used = invoice
            ? invoiceTotals[id].appliedPayments
            : evidence.reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
        const remaining = original.subtract(used),
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
;({lib, I, P, A, kinds, context, key, parseKey, query, project, selected, applications, openItems})
