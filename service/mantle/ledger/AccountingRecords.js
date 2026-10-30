const lib = ec.resource.script(
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
)
const { call, map, pick, display } = lib
// Names of the parties a user may see, by party id, read in one query.
function partyNames(ids) {
    const names = {}
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return names
    for (const party of Array.from(
        lib.find("mantle.party.PartyDetail").condition("partyId", "in", wanted).list(),
    )) {
        if (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId)
            continue
        names[party.partyId] =
            party.organizationName ||
            [party.firstName, party.lastName].filter(Boolean).join(" ") ||
            party.partyId
    }
    return names
}
// Status names by status id, read in one query.
function statusNames(ids) {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(
            lib.find("moqui.basic.StatusItem").condition("statusId", "in", wanted).list(),
        ).map((row) => [row.statusId, row.description || row.statusId]),
    )
}
// The document rows' display values: party and status names, the counterparty (the party that is not one of the
// user's organizations), and the date, amount and currency of an invoice or payment alike. A draft invoice with no
// stored total gets its computed one.
function nameDocuments(rows, organizationPartyIds) {
    const parties = partyNames(rows.flatMap((row) => [row.fromPartyId, row.toPartyId]))
    const statuses = statusNames(rows.map((row) => row.statusId))
    for (const row of rows) {
        if (row.invoiceId && row.invoiceTotal == null)
            Object.assign(row, call("mantle.account.InvoiceServices.get#InvoiceTotal", { invoiceId: row.invoiceId }))
        row.fromPartyName = parties[row.fromPartyId] || null
        row.toPartyName = parties[row.toPartyId] || null
        row.statusText = statuses[row.statusId] || row.statusId || ""
        row.counterpartyName = organizationPartyIds.includes(row.fromPartyId) ? row.toPartyName : row.fromPartyName
        row.documentDateText = row.invoiceDateText || row.effectiveDateText || ""
        row.documentAmount = row.invoiceId ? row.invoiceTotal : row.amount
        row.documentCurrencyUomId = row.currencyUomId || row.amountUomId || null
    }
    return rows
}
// The audit of a journal entry: its header and its lines, newest first, with who changed them.
function journalAudit(acctgTransId) {
    const rows = Array.from(
        lib
            .find("moqui.entity.EntityAuditLog")
            .condition("changedEntityName", "in", [
                "mantle.ledger.transaction.AcctgTrans",
                "mantle.ledger.transaction.AcctgTransEntry",
            ])
            .condition("pkPrimaryValue", acctgTransId)
            .orderBy("-changedDate")
            .limit(200)
            .list(),
    ).map(display)
    const userIds = [...new Set(rows.map((row) => row.changedByUserId).filter(Boolean))]
    const users = userIds.length
        ? Object.fromEntries(
              Array.from(
                  lib.find("moqui.security.UserAccount").condition("userId", "in", userIds).list(),
              ).map((user) => [user.userId, user.userFullName || user.username || user.userId]),
          )
        : {}
    for (const row of rows) {
        row.changedByName = users[row.changedByUserId] || row.changedByUserId || ""
        row.lineText = row.changedEntityName.endsWith("AcctgTransEntry")
            ? "Line " + (row.pkSecondaryValue || "")
            : "Entry"
    }
    return rows
}
function list(p) {
    let { q, kind, s } = lib.query(p)
    const pageSize = Math.max(1, Math.min(100, Number(p.pageSize || 25)))
    const pageIndex = Math.max(0, Number(p.pageIndex || 0))
    const accountFields = [
        "glAccountId",
        "accountCode",
        "accountName",
        "parentGlAccountId",
        "glAccountClassEnumId",
        "glAccountTypeEnumId",
        "description",
        "disallowPosting",
        "isDebit",
        "isTemporary",
    ]
    let countQuery = lib.query(p).q
    if (p.kind === "accounts") {
        for (const field of accountFields) q = q.selectField(field)
        q = q.distinct(true)
        countQuery = countQuery.selectField("glAccountId").distinct(true)
    }
    const count = countQuery.count()
    const records = Array.from(
        q
            .orderBy({ accounts: "accountCode", periods: "fromDate,timePeriodTypeId" }[p.kind] || kind[1])
            .limit(pageSize)
            .offset(pageSize * pageIndex)
            .list(),
    ).map(display)
    if (["invoices", "bills", "payments"].includes(p.kind))
        nameDocuments(records, lib.organizationIds(s))
    if (p.kind === "accounts" && records.length) {
        const children = Array.from(
            lib
                .query(Object.assign({}, p, { parentGlAccountId: null }))
                .q.condition(
                    "parentGlAccountId",
                    "in",
                    records.map((r) => r.glAccountId),
                )
                .selectField("parentGlAccountId")
                .distinct(true)
                .list(),
        )
        const parents = new Set(children.map((r) => r.parentGlAccountId))
        for (const record of records)
            record.childCount = parents.has(record.glAccountId) ? 1 : 0
    }
    return {
        records,
        recordCount: count,
        pageSize,
        pageIndex,
        recordsCount: count,
        recordsPageSize: pageSize,
        recordsPageIndex: pageIndex,
        recordsPageMaxIndex: Math.max(0, Math.ceil(count / pageSize) - 1),
        recordsPageRangeLow: count ? pageIndex * pageSize + 1 : 0,
        recordsPageRangeHigh: Math.min(count, (pageIndex + 1) * pageSize),
    }
}
function read(p) {
    const row = lib.record(p)
    const out = { record: display(row) }
    if (["invoices", "bills", "payments"].includes(p.kind))
        nameDocuments([out.record], lib.organizationIds(lib.scope(p)))
    if (p.kind === "accounts") {
        const scope = lib.scope(p),
            org =
                p.organizationPartyId ||
                scope.allowedOrganizationPartyIds.find((id) =>
                    lib.accountAssignment(id, row.glAccountId),
                )
        const assignment = org
            ? lib.accountAssignment(org, row.glAccountId)
            : null
        const account = lib.one("mantle.ledger.account.GlAccount", {
            glAccountId: row.glAccountId,
        })
        out.record = Object.assign(
            display(account),
            assignment
                ? pick(map(assignment), [
                      "fromDate",
                      "thruDate",
                      "facilityRequired",
                      "costCenterRequired",
                  ])
                : {},
            {
                organizationPartyId: org,
                assignmentOrganizationPartyId: assignment?.organizationPartyId,
                assignmentLastUpdatedStamp:
                    assignment?.organizationPartyId === org
                        ? assignment.lastUpdatedStamp
                        : null,
            },
        )
    }
    if (p.kind === "journals") {
        out.lines = lib
            .rows("mantle.ledger.transaction.AcctgTransEntry", {
                acctgTransId: row.acctgTransId,
            })
            .map(display)
        out.auditRows = journalAudit(row.acctgTransId)
        Object.assign(
            out,
            call(
                "mantle.ledger.LedgerServices.calculate#AcctgTransTrialBalance",
                {
                    acctgTransId: row.acctgTransId,
                },
            ),
        )
    }
    if (p.kind === "templates")
        out.lines = lib
            .rows("mantle.ledger.transaction.AcctgTransTemplateEntry", {
                acctgTransTemplateId: row.acctgTransTemplateId,
            })
            .map(display)
    return out
}
function draft(p) {
    if (!["invoices", "bills", "payments"].includes(p.kind))
        throw new Error("Unknown document kind")
    const need = {
        invoices: "arEdit",
        bills: "apEdit",
        payments: "paymentEdit",
    }[p.kind]
    const s = lib.organization(p, need),
        organizationPartyId = s.organizationPartyId
    const currency =
        p.currencyUomId || lib.preference(organizationPartyId).baseCurrencyUomId
    lib.currency(currency)
    const otherParty =
        p.otherPartyId &&
        lib.one("mantle.party.Party", { partyId: p.otherPartyId })
    if (
        !otherParty ||
        (otherParty.privateOwnerUserId &&
            otherParty.privateOwnerUserId !== ec.user.userId)
    )
        throw new Error("Choose an available counterparty")
    const base = {
        fromPartyId: p.kind === "bills" ? p.otherPartyId : organizationPartyId,
        toPartyId: p.kind === "bills" ? organizationPartyId : p.otherPartyId,
        currencyUomId: currency,
        description: p.description,
    }
    let result
    if (p.kind === "payments") {
        if (p.amount == null || toDecimal(p.amount).compare(0) <= 0)
            throw new Error("Enter a positive payment amount")
        const amount = ec.l10n.roundCurrency(toDecimal(p.amount), currency)
        if (amount.compare(0) <= 0)
            throw new Error(
                "Enter a positive payment amount in the selected currency",
            )
        result = call(
            "mantle.account.PaymentServices.create#Payment",
            Object.assign(base, {
                // a payment keeps its description as its comments
                comments: p.description,
                paymentTypeEnumId: "PtDisbursement",
                paymentInstrumentEnumId: "PiOther",
                amountUomId: currency,
                amount,
                statusId: "PmntProposed",
            }),
        )
        return { recordId: result.paymentId }
    }
    result = call(
        "mantle.account.InvoiceServices.create#Invoice",
        Object.assign(base, {
            invoiceTypeEnumId: "InvoiceSales",
            statusId: "InvoiceInProcess",
            invoiceDate: p.invoiceDate || ec.user.nowTimestamp,
        }),
    )
    return { recordId: result.invoiceId }
}
const operations = { access: lib.access, list, read, draft }
;({
    execute: (op, p) => {
        if (!operations[op])
            throw new Error("Unknown accounting record operation " + op)
        return operations[op](p)
    },
})
