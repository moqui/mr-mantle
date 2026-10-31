// Invoice scope for the account modules: the invoice and its organization for a read or a write, the side's
// permission, stored totals and fingerprints. The entity, value, paging and operation-key helpers are EntityLib's.
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const entityLib = policy.lib
const access = entityLib.access
const invoiceEntity = "mantle.account.invoice.Invoice"
const {find, one, rows, call, probe, ms, map, display, hash, denied, partyNames, page, operationEntity, complete, previous} =
    entityLib
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
// An operation key for an invoice operation, with the organization locked first.
function operation(p, type, organizationPartyId, request, lock = true) {
    if (lock && p.operationKey) organization(organizationPartyId, null, true)
    return entityLib.operation(p, type, organizationPartyId, request)
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
function escapeHtml(value) {
    const entities = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}
    return String(value ?? "").replace(/[&<>"']/g, character => entities[character])
}
;({
    entityLib,
    amount: entityLib.amount,
    json: entityLib.json,
    check: entityLib.check,
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
