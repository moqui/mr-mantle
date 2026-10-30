// Native finance authorization. No artifact authorization or request-supplied scope can replace these checks.
const domain = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const map = row => (row?.getMap ? row.getMap() : Object.assign({}, row || {}))
const call = (name, parameters = {}) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const ms = value =>
    value == null || value === "" ? null : /^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value))
const active = (row, date = ec.user.nowTimestamp) =>
    (ms(row.fromDate) ?? -Infinity) <= ms(date) && (ms(row.thruDate) ?? Infinity) > ms(date)
const pick = (row, fields) => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))
const hash = value => ec.user.singleUseCodeHash(JSON.stringify(value))
// A date or stamp as display text in the user's time zone: the day alone at midnight, else with the time.
function dateText(value) {
    if (value == null || value === "") return ""
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value)
    const text = ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd HH:mm")
    return text.endsWith(" 00:00") ? text.slice(0, 10) : text
}
// A SQL DATE is a calendar value, not a timestamp in the viewing user's zone.
function calendarDateText(value) {
    if (value == null || value === "") return ""
    const text = String(value)
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
    const date = new Date(ms(value))
    if (!Number.isFinite(date.getTime())) throw new Error("A calendar date is required")
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-")
}
// Persisted SQL days are authoritative. Undated ledger history keeps the core ledger's UTC timestamp day.
function postingDay(transaction) {
    const day = calendarDateText(transaction.accountingDate || transaction.transactionDate)
    if (!day) throw new Error("POSTING_DATE_INVALID: A ledger posting needs its original accounting day or timestamp")
    return day
}
// New postings carry a fixed business day; older postings retain their existing timestamp range semantics.
function accountingDateCondition({fromDate, thruDate, fromDay, thruDay, inclusive = false}) {
    if (!fromDate && !thruDate && !fromDay && !thruDay) return null
    if (!fromDay && fromDate) fromDay = ec.l10n.format(fromDate, "yyyy-MM-dd")
    if (!thruDay && thruDate) thruDay = ec.l10n.format(thruDate, "yyyy-MM-dd")
    const cf = ec.entity.conditionFactory
    const dated = [cf.makeCondition("accountingDate", "is-not-null", null)]
    const legacy = [cf.makeCondition("accountingDate", "is-null", null)]
    if (fromDay) dated.push(cf.makeCondition("accountingDate", "greater-equals", fromDay))
    if (thruDay) dated.push(cf.makeCondition("accountingDate", inclusive ? "less-equals" : "less", thruDay))
    if (fromDate) legacy.push(cf.makeCondition("transactionDate", "greater-equals", fromDate))
    if (thruDate) legacy.push(cf.makeCondition("transactionDate", inclusive ? "less-equals" : "less", thruDate))
    return cf.makeCondition([cf.makeCondition(dated, "and"), cf.makeCondition(legacy, "and")], "or")
}
// A row for a screen: a plain map with <field>Text for each date and stamp, since JSON drops their types. Not for
// fingerprints, which use map.
function display(row) {
    const out = map(row)
    for (const field of Object.keys(out)) {
        if (!/(Date|Stamp)$/.test(field) || out[field] == null) continue
        try {
            out[field + "Text"] = field === "accountingDate" ? calendarDateText(out[field]) : dateText(out[field])
        } catch (error) {
            ec.logger.error("Accounting date " + field + ": " + error.message)
            out[field + "Text"] = ""
        }
    }
    if (out.accountingDate && out.transactionDate) out.transactionDateText = calendarDateText(out.accountingDate)
    return out
}
function capabilities() {
    const has = domain.has
    const admin = has("ACCOUNTING_ADMIN")
    const out = {
        systemAdmin: domain.systemAdmin(),
        admin,
        glPost: has("ACCOUNTING_GL_POST"),
        reportRead: has("ACCOUNTING_VIEW"),
        arRead: has("RECEIVABLE_VIEW"),
        apRead: has("PAYABLE_VIEW"),
        paymentRead: has("PAYMENT_VIEW"),
        arEdit: has("RECEIVABLE_EDIT"),
        apEdit: has("PAYABLE_EDIT"),
        paymentEdit: has("PAYMENT_EDIT"),
        match: has("INVOICE_MATCH"),
        taxEdit: has("TAX_STATEMENT_EDIT"),
        approve: has("INVOICE_APPROVE"),
        fiscalClose: has("FISCAL_CLOSE"),
        fiscalReopen: has("FISCAL_REOPEN")
    }
    // An edit permission alone opens no reads: other apps' groups hold some (Projects' RECEIVABLE_EDIT for billing).
    out.read = [
        out.systemAdmin,
        out.admin,
        out.glPost,
        out.reportRead,
        out.arRead,
        out.apRead,
        out.paymentRead,
        out.match,
        out.taxEdit,
        out.approve,
        out.fiscalClose,
        out.fiscalReopen
    ].some(Boolean)
    return out
}
function access() {
    const c = capabilities()
    if (!c.read) throw new Error("Accounting access is required")
    let ids, activeId
    if (c.admin) {
        ids = Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
            r => r.partyId
        )
        activeId = ec.user.getPreference("ACTIVE_ORGANIZATION") || null
    } else {
        const org = call("mantle.party.PartyServices.get#PartyOrganizationInfo")
        ids = Array.from(org.userOrgIds || [])
        activeId = org.activeOrgId || null
    }
    if (!ids.includes(activeId)) activeId = null
    return {
        capabilities: c,
        organizationPartyIds: ids,
        activeOrganizationPartyId: activeId,
        allowedOrganizationPartyIds: activeId ? [activeId] : ids
    }
}
function scope(p = {}, need = "read") {
    const a = access()
    if (!Object.prototype.hasOwnProperty.call(a.capabilities, need) || !a.capabilities[need])
        throw new Error("Accounting " + need + " authority is required")
    const org =
        p.organizationPartyId ||
        a.activeOrganizationPartyId ||
        (a.allowedOrganizationPartyIds.length === 1 ? a.allowedOrganizationPartyIds[0] : null)
    if (org && !a.allowedOrganizationPartyIds.includes(org)) throw new Error("Accounting organization is not available")
    return Object.assign(a, {organizationPartyId: org})
}
// The organizations a scope covers: the chosen one, else every one the user may work in.
function organizationIds(scope) {
    return scope.organizationPartyId ? [scope.organizationPartyId] : scope.allowedOrganizationPartyIds
}
function organization(p, need = "read") {
    const s = scope(p, need)
    if (!s.organizationPartyId) throw new Error("Choose an internal organization")
    return s
}
function preference(org) {
    return (
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {
            organizationPartyId: org
        }).partyAcctgPreference || {}
    )
}
function reason(p) {
    const value = String(p.changeReason || "").trim()
    if (!value || value.length > 255) throw new Error("Give a change reason of 1–255 characters")
    return value
}
function audit(fields, why) {
    ec.context.putAll(Object.fromEntries(fields.map(f => [f + "_changeReason", why])))
}
function revision(row, expected) {
    if (row && (expected == null || ms(row.lastUpdatedStamp) !== ms(expected)))
        throw new Error("Record changed; reload before saving")
}
function organizationChain(org, date = ec.user.nowTimestamp, visited = []) {
    if (visited.includes(org)) throw new Error("Organization configuration hierarchy contains a cycle")
    const parents = rows("mantle.party.PartyRelationship", {
        fromPartyId: org,
        relationshipTypeEnumId: "PrtOrgRollup"
    }).filter(r => active(r, date))
    return [org].concat(parents.flatMap(r => organizationChain(r.toPartyId, date, [...visited, org])))
}
function accountAssignment(org, id, date = ec.user.nowTimestamp) {
    for (const organizationPartyId of organizationChain(org, date)) {
        const row = one("mantle.ledger.account.GlAccountOrganization", {
            glAccountId: id,
            organizationPartyId
        })
        if (row) return row
    }
    return null
}
function account(org, id, date = ec.user.nowTimestamp) {
    const row = one("mantle.ledger.account.GlAccount", {glAccountId: id})
    const assignment = accountAssignment(org, id, date)
    if (!row || row.disallowPosting === "Y" || !assignment || !active(assignment, date))
        throw new Error("Choose an active posting account assigned to this organization")
    return {row, assignment}
}
function dimensions(org, values, date = ec.user.nowTimestamp) {
    if (values.facilityId && one("mantle.facility.Facility", {facilityId: values.facilityId})?.ownerPartyId !== org)
        throw new Error("DIMENSION_SCOPE: Facility is outside the posting organization")
    if (
        values.costCenterId &&
        (!one("mantle.party.PartyRole", {
            partyId: values.costCenterId,
            roleTypeId: "OrgInternal"
        }) ||
            !organizationChain(values.costCenterId, date).includes(org))
    )
        throw new Error("DIMENSION_SCOPE: Cost centre is outside the posting organization")
}
function counterparty(id) {
    if (!id) return
    const party = one("mantle.party.Party", {partyId: id})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId))
        throw new Error("Counterparty is not available")
}
function currency(id) {
    const r = one("moqui.basic.Uom", {uomId: id})
    if (!r || r.uomTypeEnumId !== "UT_CURRENCY_MEASURE") throw new Error("Choose a currency")
    return r
}
const kinds = {
    invoices: ["mantle.account.invoice.InvoiceFinance", "invoiceId", "fromPartyId", "arRead"],
    bills: ["mantle.account.invoice.InvoiceFinance", "invoiceId", "toPartyId", "apRead"],
    payments: ["mantle.account.payment.Payment", "paymentId", "fromPartyId", "paymentRead"],
    accounts: ["mantle.ledger.account.GlAccountAndOrganization", "glAccountId", "organizationPartyId", "glPost"],
    journals: ["mantle.ledger.transaction.AcctgTrans", "acctgTransId", "organizationPartyId", "glPost"],
    entries: ["mantle.ledger.transaction.AcctgTransAndEntry", "acctgTransId", "organizationPartyId", "glPost"],
    periods: ["mantle.party.time.TimePeriod", "timePeriodId", "partyId", "glPost"],
    batches: ["mantle.ledger.transaction.GlJournal", "glJournalId", "organizationPartyId", "glPost"],
    templates: ["mantle.ledger.transaction.AcctgTransTemplate", "acctgTransTemplateId", "organizationPartyId", "glPost"],
    locks: ["mantle.ledger.config.AccountingLock", "accountingLockId", "organizationPartyId", "admin"],
    exceptions: ["mantle.ledger.config.AccountingLockException", "accountingLockExceptionId", "organizationPartyId", "admin"]
}
// The fields a search text matches, ignoring case: the record's id and its names.
const searchFields = {
    invoices: ["invoiceId", "description", "referenceNumber"],
    bills: ["invoiceId", "description", "referenceNumber"],
    payments: ["paymentId", "paymentRefNum", "comments"],
    accounts: ["glAccountId", "accountCode", "accountName"],
    journals: ["acctgTransId", "description"],
    entries: ["acctgTransId", "txDescription", "description"],
    periods: ["timePeriodId", "periodName"],
    batches: ["glJournalId", "glJournalName"],
    templates: ["acctgTransTemplateId", "templateName", "description"],
    locks: ["accountingLockId", "lockScope", "changeReason"],
    exceptions: ["accountingLockExceptionId", "lockScope", "changeReason"]
}
// A linked credit belongs to its source's financial side even though Mantle reverses its parties.
function invoiceDirectionCondition(kind, ids) {
    const cf = ec.entity.conditionFactory
    const partyIds = ids.length ? ids : ["_DENIED_"]
    const receivable = kind === "invoices"
    return cf.makeCondition(
        [
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "equals", receivable ? "receivable" : "payable"),
                    cf.makeCondition("financeOrganizationPartyId", "in", partyIds)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "is-null", null),
                    cf.makeCondition("creditForInvoiceId", "is-not-null", null),
                    cf.makeCondition(receivable ? "sourceFromPartyId" : "sourceToPartyId", "in", partyIds)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "is-null", null),
                    cf.makeCondition("creditForInvoiceId", "is-null", null),
                    cf.makeCondition(receivable ? "fromPartyId" : "toPartyId", "in", partyIds)
                ],
                "and"
            )
        ],
        "or"
    )
}
function query(p) {
    const kind = kinds[p.kind]
    if (!kind) throw new Error("Unknown accounting record kind")
    const s = scope(p)
    if (
        !s.capabilities.reportRead &&
        !s.capabilities.admin &&
        !s.capabilities[kind[3]] &&
        !(p.kind === "payments" && (s.capabilities.arRead || s.capabilities.apRead))
    )
        throw new Error("Accounting record is not available")
    let ids = organizationIds(s)
    if (["accounts", "periods"].includes(p.kind)) ids = [...new Set(ids.flatMap(id => organizationChain(id)))]
    let q = find(kind[0])
    if (["invoices", "bills"].includes(p.kind)) {
        q = q.condition(invoiceDirectionCondition(p.kind, ids))
        if (!s.capabilities.systemAdmin) {
            const cf = ec.entity.conditionFactory
            for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
                q = q.condition(
                    cf.makeCondition(
                        [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)],
                        "or"
                    )
                )
        }
    } else if (p.kind === "payments") {
        const cf = ec.entity.conditionFactory
        q = q.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("fromPartyId", "in", ids.length ? ids : ["_DENIED_"]),
                    cf.makeCondition("toPartyId", "in", ids.length ? ids : ["_DENIED_"])
                ],
                "or"
            )
        )
    } else q = q.condition(kind[2], "in", ids.length ? ids : ["_DENIED_"])
    if (p.recordId) q = q.condition(kind[1], p.recordId)
    if (p.acctgTransId && p.kind === "entries") q = q.condition("acctgTransId", p.acctgTransId)
    if (p.parentGlAccountId && p.kind === "accounts") q = q.condition("parentGlAccountId", p.parentGlAccountId)
    if (p.glAccountId && ["accounts", "entries"].includes(p.kind)) q = q.condition("glAccountId", p.glAccountId)
    if (p.isPosted && ["journals", "entries"].includes(p.kind)) q = q.condition("isPosted", p.isPosted)
    if (p.glJournalId && p.kind === "journals") q = q.condition("glJournalId", p.glJournalId)
    const text = String(p.text || "").trim()
    if (text) {
        const cf = ec.entity.conditionFactory
        q = q.condition(
            cf.makeCondition(
                (searchFields[p.kind] || [kind[1]]).map(field => cf.makeCondition(field, "like", "%" + text + "%").ignoreCase()),
                "or"
            )
        )
    }
    return {q, s, kind}
}
function record(p, need = "read", lock = false) {
    if (!p.recordId) throw new Error("An accounting record ID is required")
    const {q, s} = query(p)
    if (need !== "read" && !s.capabilities[need]) throw new Error("Accounting " + need + " authority is required")
    const row = (lock ? q.forUpdate(true) : q).one()
    if (!row) throw new Error("Accounting record is not available")
    return row
}
;({
    find,
    one,
    rows,
    map,
    display,
    dateText,
    calendarDateText,
    postingDay,
    accountingDateCondition,
    call,
    ms,
    active,
    pick,
    hash,
    capabilities,
    access,
    scope,
    organizationIds,
    organization,
    preference,
    reason,
    audit,
    revision,
    account,
    accountAssignment,
    organizationChain,
    currency,
    dimensions,
    counterparty,
    invoiceDirectionCondition,
    kinds,
    query,
    record
})
