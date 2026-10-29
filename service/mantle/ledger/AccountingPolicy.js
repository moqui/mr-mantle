// Native finance authorization. No artifact authorization or request-supplied scope can replace these checks.
const domain = ec.resource.script(
    "component://mr-mantle/service/mantle/product/ProductAccess.js",
)
const find = (entity, conditions = {}) =>
    ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const map = (row) => (row?.getMap ? row.getMap() : Object.assign({}, row || {}))
const call = (name, parameters = {}) => {
    const out =
        ec.service
            .sync()
            .name(name)
            .parameters(parameters)
            .disableAuthz()
            .call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const ms = (value) =>
    value == null || value === ""
        ? null
        : /^-?\d+$/.test(String(value))
          ? Number(value)
          : Date.parse(String(value))
const active = (row, date = ec.user.nowTimestamp) =>
    (ms(row.fromDate) ?? -Infinity) <= ms(date) &&
    (ms(row.thruDate) ?? Infinity) > ms(date)
const pick = (row, fields) =>
    Object.fromEntries(
        fields
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]]),
    )
const hash = (value) => ec.user.singleUseCodeHash(JSON.stringify(value))
function capabilities() {
    const has = domain.has
    const admin = has("ACCOUNTING_ADMIN")
    const out = {
        systemAdmin: domain.systemAdmin(),
        admin,
        glPost: has("ACCOUNTING_GL_POST"),
        reportRead: has("ACCOUNTING_VIEW"),
        arEdit: has("RECEIVABLE_EDIT"),
        apEdit: has("PAYABLE_EDIT"),
        paymentEdit: has("PAYMENT_EDIT"),
        match: has("INVOICE_MATCH"),
        taxEdit: has("TAX_STATEMENT_EDIT"),
        approve: has("INVOICE_APPROVE"),
        fiscalClose: has("FISCAL_CLOSE"),
        fiscalReopen: has("FISCAL_REOPEN"),
    }
    out.read = Object.values(out).some(Boolean)
    return out
}
function access() {
    const c = capabilities()
    if (!c.read) throw new Error("Accounting access is required")
    let ids, activeId
    if (c.admin) {
        ids = Array.from(
            find("mantle.party.PartyRole", { roleTypeId: "OrgInternal" })
                .selectField("partyId")
                .list(),
        ).map((r) => r.partyId)
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
        allowedOrganizationPartyIds: activeId ? [activeId] : ids,
    }
}
function scope(p = {}, need = "read") {
    const a = access()
    if (
        !Object.prototype.hasOwnProperty.call(a.capabilities, need) ||
        !a.capabilities[need]
    )
        throw new Error("Accounting " + need + " authority is required")
    const org =
        p.organizationPartyId ||
        a.activeOrganizationPartyId ||
        (a.allowedOrganizationPartyIds.length === 1
            ? a.allowedOrganizationPartyIds[0]
            : null)
    if (org && !a.allowedOrganizationPartyIds.includes(org))
        throw new Error("Accounting organization is not available")
    return Object.assign(a, { organizationPartyId: org })
}
function organization(p, need = "read") {
    const s = scope(p, need)
    if (!s.organizationPartyId)
        throw new Error("Choose an internal organization")
    return s
}
function preference(org) {
    return (
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {
            organizationPartyId: org,
        }).partyAcctgPreference || {}
    )
}
function reason(p) {
    const value = String(p.changeReason || "").trim()
    if (!value || value.length > 255)
        throw new Error("Give a change reason of 1–255 characters")
    return value
}
function audit(fields, why) {
    ec.context.putAll(
        Object.fromEntries(fields.map((f) => [f + "_changeReason", why])),
    )
}
function revision(row, expected) {
    if (row && (expected == null || ms(row.lastUpdatedStamp) !== ms(expected)))
        throw new Error("Record changed; reload before saving")
}
function organizationChain(org, date = ec.user.nowTimestamp, visited = []) {
    if (visited.includes(org))
        throw new Error("Organization configuration hierarchy contains a cycle")
    const parents = rows("mantle.party.PartyRelationship", {
        fromPartyId: org,
        relationshipTypeEnumId: "PrtOrgRollup",
    }).filter((r) => active(r, date))
    return [org].concat(
        parents.flatMap((r) =>
            organizationChain(r.toPartyId, date, [...visited, org]),
        ),
    )
}
function accountAssignment(org, id, date = ec.user.nowTimestamp) {
    for (const organizationPartyId of organizationChain(org, date)) {
        const row = one("mantle.ledger.account.GlAccountOrganization", {
            glAccountId: id,
            organizationPartyId,
        })
        if (row) return row
    }
    return null
}
function account(org, id, date = ec.user.nowTimestamp) {
    const row = one("mantle.ledger.account.GlAccount", { glAccountId: id })
    const assignment = accountAssignment(org, id, date)
    if (
        !row ||
        row.disallowPosting === "Y" ||
        !assignment ||
        !active(assignment, date)
    )
        throw new Error(
            "Choose an active posting account assigned to this organization",
        )
    return { row, assignment }
}
function dimensions(org, values, date = ec.user.nowTimestamp) {
    if (
        values.facilityId &&
        one("mantle.facility.Facility", { facilityId: values.facilityId })
            ?.ownerPartyId !== org
    )
        throw new Error(
            "DIMENSION_SCOPE: Facility is outside the posting organization",
        )
    if (
        values.costCenterId &&
        (!one("mantle.party.PartyRole", {
            partyId: values.costCenterId,
            roleTypeId: "OrgInternal",
        }) ||
            !organizationChain(values.costCenterId, date).includes(org))
    )
        throw new Error(
            "DIMENSION_SCOPE: Cost centre is outside the posting organization",
        )
}
function counterparty(id) {
    if (!id) return
    const party = one("mantle.party.Party", { partyId: id })
    if (
        !party ||
        (party.privateOwnerUserId &&
            party.privateOwnerUserId !== ec.user.userId)
    )
        throw new Error("Counterparty is not available")
}
function currency(id) {
    const r = one("moqui.basic.Uom", { uomId: id })
    if (!r || r.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        throw new Error("Choose a currency")
    return r
}
const kinds = {
    invoices: [
        "mantle.account.invoice.Invoice",
        "invoiceId",
        "fromPartyId",
        "arEdit",
    ],
    bills: [
        "mantle.account.invoice.Invoice",
        "invoiceId",
        "toPartyId",
        "apEdit",
    ],
    payments: [
        "mantle.account.payment.Payment",
        "paymentId",
        "fromPartyId",
        "paymentEdit",
    ],
    accounts: [
        "mantle.ledger.account.GlAccountAndOrganization",
        "glAccountId",
        "organizationPartyId",
        "glPost",
    ],
    journals: [
        "mantle.ledger.transaction.AcctgTrans",
        "acctgTransId",
        "organizationPartyId",
        "glPost",
    ],
    entries: [
        "mantle.ledger.transaction.AcctgTransAndEntry",
        "acctgTransId",
        "organizationPartyId",
        "glPost",
    ],
    periods: [
        "mantle.party.time.TimePeriod",
        "timePeriodId",
        "partyId",
        "glPost",
    ],
    batches: [
        "mantle.ledger.transaction.GlJournal",
        "glJournalId",
        "organizationPartyId",
        "glPost",
    ],
    templates: [
        "mantle.ledger.transaction.AcctgTransTemplate",
        "acctgTransTemplateId",
        "organizationPartyId",
        "glPost",
    ],
    locks: [
        "mantle.ledger.config.AccountingLock",
        "accountingLockId",
        "organizationPartyId",
        "admin",
    ],
    exceptions: [
        "mantle.ledger.config.AccountingLockException",
        "accountingLockExceptionId",
        "organizationPartyId",
        "admin",
    ],
}
function query(p) {
    const kind = kinds[p.kind]
    if (!kind) throw new Error("Unknown accounting record kind")
    const s = scope(p)
    if (
        !s.capabilities.reportRead &&
        !s.capabilities.admin &&
        !s.capabilities[kind[3]] &&
        !(
            p.kind === "payments" &&
            (s.capabilities.arEdit || s.capabilities.apEdit)
        )
    )
        throw new Error("Accounting record is not available")
    let ids = s.organizationPartyId
        ? [s.organizationPartyId]
        : s.allowedOrganizationPartyIds
    if (["accounts", "periods"].includes(p.kind))
        ids = [...new Set(ids.flatMap((id) => organizationChain(id)))]
    let q = find(kind[0])
    if (p.kind === "payments") {
        const cf = ec.entity.conditionFactory
        q = q.condition(
            cf.makeCondition(
                [
                    cf.makeCondition(
                        "fromPartyId",
                        "in",
                        ids.length ? ids : ["_DENIED_"],
                    ),
                    cf.makeCondition(
                        "toPartyId",
                        "in",
                        ids.length ? ids : ["_DENIED_"],
                    ),
                ],
                "or",
            ),
        )
    } else q = q.condition(kind[2], "in", ids.length ? ids : ["_DENIED_"])
    if (p.recordId) q = q.condition(kind[1], p.recordId)
    if (p.acctgTransId && p.kind === "entries")
        q = q.condition("acctgTransId", p.acctgTransId)
    if (p.parentGlAccountId && p.kind === "accounts")
        q = q.condition("parentGlAccountId", p.parentGlAccountId)
    if (p.glAccountId && ["accounts", "entries"].includes(p.kind))
        q = q.condition("glAccountId", p.glAccountId)
    if (p.isPosted && ["journals", "entries"].includes(p.kind))
        q = q.condition("isPosted", p.isPosted)
    if (p.glJournalId && p.kind === "journals")
        q = q.condition("glJournalId", p.glJournalId)
    if (p.text) {
        const field =
            {
                accounts: "accountName",
                batches: "glJournalName",
                templates: "templateName",
            }[p.kind] || kind[1]
        q = q.condition(field, "like", "%" + p.text + "%")
    }
    return { q, s, kind }
}
function record(p, need = "read", lock = false) {
    if (!p.recordId) throw new Error("An accounting record ID is required")
    const { q, s } = query(p)
    if (need !== "read" && !s.capabilities[need])
        throw new Error("Accounting " + need + " authority is required")
    const row = (lock ? q.forUpdate(true) : q).one()
    if (!row) throw new Error("Accounting record is not available")
    return row
}
;({
    find,
    one,
    rows,
    map,
    call,
    ms,
    active,
    pick,
    hash,
    capabilities,
    access,
    scope,
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
    kinds,
    query,
    record,
})
