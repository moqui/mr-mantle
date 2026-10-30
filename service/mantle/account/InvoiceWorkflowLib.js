// Native invoice workflow helpers. Permissions and organization relationships remain authoritative with artifact authz disabled.
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const access = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
const invoiceEntity = "mantle.account.invoice.Invoice"
const operationEntity = "mantle.ledger.transaction.PostingOperation"
const find = policy.find
const one = policy.one
const rows = policy.rows
const call = policy.call
const probe = policy.probe
const ms = policy.ms
const map = policy.map
const display = policy.display
const hash = policy.hash
const has = access.has
function invoiceDisplay(record) {
    const out = display(record)
    if (record.accountingDate) {
        out.accountingDateText = policy.calendarDateText(record.accountingDate)
        out.invoiceDateText = out.accountingDateText
        out.invoiceDateValue = out.accountingDateText
    } else out.invoiceDateValue = record.invoiceDate ? ec.l10n.format(record.invoiceDate, "yyyy-MM-dd") : null
    return out
}
function denied(code, message) {
    throw new Error(code + ": " + message)
}
function requirePermission(permission) {
    if (!has(permission)) denied("PERMISSION_DENIED", permission + " authority is required")
}
function organization(organizationPartyId, permission, lock = false) {
    if (permission) requirePermission(permission)
    if (!organizationPartyId || !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}))
        denied("ORGANIZATION_REQUIRED", "Choose an internal organization")
    if (!access.systemAdmin()) {
        const financeAdmin = has("ACCOUNTING_ADMIN")
        const scope = call("mantle.party.PartyServices.get#PartyOrganizationInfo", {partyId: ec.user.userAccount?.partyId})
        const permitted = Array.from(scope.userOrgIds || [])
        const selected = ec.user.getPreference("ACTIVE_ORGANIZATION") || scope.activeOrgId || null
        const activeOrgId =
            selected &&
            (financeAdmin || permitted.includes(selected)) &&
            one("mantle.party.PartyRole", {partyId: selected, roleTypeId: "OrgInternal"})
                ? selected
                : null
        if ((!financeAdmin && !permitted.includes(organizationPartyId)) || (activeOrgId && activeOrgId !== organizationPartyId))
            denied("ORGANIZATION_DENIED", "The organization is not available")
    }
    if (lock) find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
    return organizationPartyId
}
function invoice(p, permission = null, lock = false) {
    let record = one(invoiceEntity, {invoiceId: p.invoiceId})
    if (!record) denied("INVOICE_UNAVAILABLE", "Invoice is not available")
    let organizationPartyId = p.organizationPartyId || record.financeOrganizationPartyId
    if (!organizationPartyId) {
        const internalFrom = one("mantle.party.PartyRole", {partyId: record.fromPartyId, roleTypeId: "OrgInternal"})
        organizationPartyId = internalFrom ? record.fromPartyId : record.toPartyId
    }
    if (![record.fromPartyId, record.toPartyId].includes(organizationPartyId))
        denied("ORGANIZATION_DENIED", "The invoice belongs to another organization")
    organization(organizationPartyId, permission, lock)
    if (lock) {
        record = find(invoiceEntity, {invoiceId: p.invoiceId}).forUpdate(true).one()
        if (!record || ![record.fromPartyId, record.toPartyId].includes(organizationPartyId))
            denied("ORGANIZATION_DENIED", "The invoice changed its organization")
    }
    const linked = record.creditForInvoiceId && one(invoiceEntity, {invoiceId: record.creditForInvoiceId})
    const receivable =
        record.financeOrganizationPartyId === organizationPartyId && record.financeDirection
            ? record.financeDirection === "receivable"
            : linked
              ? linked.fromPartyId === organizationPartyId
              : record.fromPartyId === organizationPartyId
    const partyId = record.fromPartyId === organizationPartyId ? record.toPartyId : record.fromPartyId
    const party = one("mantle.party.Party", {partyId})
    if (party?.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !access.systemAdmin())
        denied("INVOICE_UNAVAILABLE", "Invoice is not available")
    return {record, organizationPartyId, receivable, partyId, permission: receivable ? "RECEIVABLE_EDIT" : "PAYABLE_EDIT"}
}
function readInvoice(p) {
    const out = invoice(p)
    if (!has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN") && !has(out.receivable ? "RECEIVABLE_VIEW" : "PAYABLE_VIEW"))
        denied("PERMISSION_DENIED", "Invoice view authority is required")
    return out
}
function writeInvoice(p, lock = true) {
    const initial = invoice(p)
    requirePermission(initial.permission)
    return lock
        ? invoice(Object.assign({}, p, {organizationPartyId: initial.organizationPartyId}), initial.permission, true)
        : initial
}
function revision(record, expected) {
    if (expected == null || ms(record.lastUpdatedStamp) !== ms(expected))
        denied("STALE_REVISION", "Invoice changed; reload before saving")
}
function fingerprint(record) {
    const fields = [
        "invoiceId",
        "invoiceTypeEnumId",
        "fromPartyId",
        "toPartyId",
        "invoiceDate",
        "accountingDate",
        "dueDate",
        "settlementTermId",
        "referenceNumber",
        "description",
        "invoiceMessage",
        "currencyUomId"
    ]
    return hash({
        invoice: Object.fromEntries(
            fields.map(field => [
                field,
                record[field] == null
                    ? null
                    : field === "accountingDate"
                      ? policy.calendarDateText(record[field])
                      : String(record[field])
            ])
        ),
        lines: rows("mantle.account.invoice.InvoiceItem", {invoiceId: record.invoiceId})
            .map(row => map(row))
            .sort((a, b) => String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId)))
    })
}
function operation(p, type, organizationPartyId, request, lock = true) {
    const operationKey = String(p.operationKey || "")
    if (!operationKey || operationKey.length > 40)
        denied("OPERATION_KEY_REQUIRED", "An operation key of at most 40 characters is required")
    if (lock) organization(organizationPartyId, null, true)
    const requestHash = hash(request)
    const old = one(operationEntity, {operationKey})
    if (
        old &&
        (old.operationType !== type ||
            old.organizationPartyId !== organizationPartyId ||
            old.userId !== ec.user.userId ||
            old.requestHash !== requestHash)
    )
        denied("OPERATION_KEY_CONFLICT", "Operation key was used for another request")
    return {operationKey, requestHash, old, operationType: type, organizationPartyId}
}
function complete(op, resultEntityName, resultId, result) {
    call("create#" + operationEntity, {
        operationKey: op.operationKey,
        operationType: op.operationType,
        organizationPartyId: op.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        completedDate: ec.user.nowTimestamp,
        requestHash: op.requestHash,
        status: "complete",
        resultEntityName,
        resultId,
        resultJson: JSON.stringify(result)
    })
}
function previous(op) {
    if (!op.old) return null
    let result = {}
    try {
        result = JSON.parse(op.old.resultJson || "{}")
    } catch (_) {
        result = {}
    }
    return Object.assign(result, {alreadyApplied: true})
}
// One invoice line's amount, rounded to its currency.
function lineTotal(line, currencyUomId) {
    return ec.l10n.roundCurrency(toDecimal(line.quantity ?? 1).multiply(line.amount ?? 0), currencyUomId)
}
// The totals Mantle stores on the Invoice (update#InvoiceTotals, run by the InvoiceItem and PaymentApplication EECAs).
function storedTotals(row) {
    const appliedPayments = toDecimal(row.appliedPaymentsTotal ?? 0)
    return {
        invoiceTotal: toDecimal(row.invoiceTotal ?? 0),
        appliedPayments,
        appliedPaymentsTotal: appliedPayments,
        unpaidTotal: toDecimal(row.unpaidTotal ?? 0),
        currencyUomId: row.currencyUomId
    }
}
// The stored totals of an invoice, read again so a change earlier in the transaction is included.
function totals(record) {
    return storedTotals(one(invoiceEntity, {invoiceId: record.invoiceId}) || record)
}
// The stored totals of several invoices by invoice ID; with asOfDate also the applications on or before it, and the
// applied and unpaid amounts as of that date.
function totalsMany(records, asOfDate = null) {
    if (!records.length) return {}
    const ids = records.map(row => row.invoiceId)
    const stored = Object.fromEntries(
        Array.from(find(invoiceEntity).condition("invoiceId", "in", ids).list()).map(row => [row.invoiceId, row])
    )
    const values = Object.fromEntries(records.map(row => [row.invoiceId, storedTotals(stored[row.invoiceId] || row)]))
    if (asOfDate == null) return values
    for (const value of Object.values(values)) {
        value.applications = []
        value.appliedPayments = toDecimal(0)
    }
    const cf = ec.entity.conditionFactory
    const applications = find("mantle.account.payment.PaymentApplication")
        .condition(cf.makeCondition([cf.makeCondition("invoiceId", "in", ids), cf.makeCondition("toInvoiceId", "in", ids)], "or"))
        .condition("appliedDate", "less-equals", asOfDate)
    for (const item of applications.list())
        for (const id of new Set([item.invoiceId, item.toInvoiceId].filter(id => values[id]))) {
            values[id].appliedPayments = values[id].appliedPayments.add(item.amountApplied || 0)
            values[id].applications.push(map(item))
        }
    for (const value of Object.values(values)) {
        value.appliedPaymentsTotal = value.appliedPayments
        value.unpaidTotal = value.invoiceTotal.subtract(value.appliedPayments)
    }
    return values
}
// Names of the parties the user may see, by party ID, read in one query; a party another user keeps private is left out.
function partyNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))]
    if (!unique.length) return {}
    const names = {}
    for (const row of find("mantle.party.PartyDetail").condition("partyId", "in", unique).list()) {
        if (row.privateOwnerUserId && row.privateOwnerUserId !== ec.user.userId && !access.systemAdmin()) continue
        names[row.partyId] =
            row.organizationName || [row.firstName, row.middleName, row.lastName].filter(Boolean).join(" ") || row.partyId
    }
    return names
}
function page(query, p, field = "records", recordCount) {
    const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 20))
    const pageMaxIndex = Math.max(0, Math.ceil(recordCount / pageSize) - 1)
    const pageIndex = Math.min(pageMaxIndex, Math.max(0, Number(p.pageIndex) || 0))
    const result = {
        recordCount,
        pageSize,
        pageIndex,
        pageMaxIndex,
        pageRangeLow: recordCount ? pageIndex * pageSize + 1 : 0,
        pageRangeHigh: Math.min(recordCount, (pageIndex + 1) * pageSize)
    }
    result.rows = Array.from(
        query
            .offset(pageIndex * pageSize)
            .limit(pageSize)
            .list()
    )
    result[field] = result.rows
    result[field + "Count"] = recordCount
    for (const key of ["PageSize", "PageIndex", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"])
        result[field + key] = result[key[0].toLowerCase() + key.slice(1)]
    return result
}

function escapeHtml(value) {
    const entities = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}
    return String(value ?? "").replace(/[&<>"']/g, character => entities[character])
}
;({
    policy,
    access,
    invoiceEntity,
    operationEntity,
    find,
    one,
    rows,
    call,
    ms,
    map,
    display,
    invoiceDisplay,
    hash,
    has,
    denied,
    requirePermission,
    organization,
    invoice,
    readInvoice,
    writeInvoice,
    revision,
    fingerprint,
    operation,
    complete,
    previous,
    lineTotal,
    storedTotals,
    totals,
    totalsMany,
    partyNames,
    page,
    probe,
    escapeHtml
})
