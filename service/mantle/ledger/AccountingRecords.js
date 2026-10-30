// Lists of finance records of every kind, paged in the database, and the display values of document rows. The other
// record services (get#Access, get#Record, create#DraftDocument) are inline XML Actions in AccountingServices.xml.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {call, display} = lib
// Names of the parties a user may see, by party id, read in one query.
function partyNames(ids) {
    const names = {}
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return names
    for (const party of Array.from(lib.find("mantle.party.PartyDetail").condition("partyId", "in", wanted).list())) {
        if (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) continue
        names[party.partyId] =
            party.organizationName || [party.firstName, party.lastName].filter(Boolean).join(" ") || party.partyId
    }
    return names
}
// Status names by status id, read in one query.
function statusNames(ids) {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(lib.find("moqui.basic.StatusItem").condition("statusId", "in", wanted).list()).map(row => [
            row.statusId,
            row.description || row.statusId
        ])
    )
}
// The document rows' display values: party and status names, the counterparty (the party that is not one of the
// user's organizations), and the date, amount and currency of an invoice or payment alike. A draft invoice with no
// stored total gets its computed one.
function nameDocuments(rows, organizationPartyIds) {
    const parties = partyNames(rows.flatMap(row => [row.fromPartyId, row.toPartyId]))
    const statuses = statusNames(rows.map(row => row.statusId))
    for (const row of rows) {
        if (row.invoiceId && row.invoiceTotal == null)
            Object.assign(row, call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId: row.invoiceId}))
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
function list(p) {
    let {q, kind, s} = lib.query(p)
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
        "isTemporary"
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
            .orderBy({accounts: "accountCode", periods: "fromDate,timePeriodTypeId"}[p.kind] || kind[1])
            .limit(pageSize)
            .offset(pageSize * pageIndex)
            .list()
    ).map(display)
    if (["invoices", "bills", "payments"].includes(p.kind)) nameDocuments(records, lib.organizationIds(s))
    if (p.kind === "accounts" && records.length) {
        const children = Array.from(
            lib
                .query(Object.assign({}, p, {parentGlAccountId: null}))
                .q.condition(
                    "parentGlAccountId",
                    "in",
                    records.map(r => r.glAccountId)
                )
                .selectField("parentGlAccountId")
                .distinct(true)
                .list()
        )
        const parents = new Set(children.map(r => r.parentGlAccountId))
        for (const record of records) record.childCount = parents.has(record.glAccountId) ? 1 : 0
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
        recordsPageRangeHigh: Math.min(count, (pageIndex + 1) * pageSize)
    }
}
// Display values of invoice, bill or payment rows read elsewhere (get#Record): the rows with their names added.
function documents(p) {
    return {records: nameDocuments(Array.from(p.records || []), Array.from(p.organizationPartyIds || []))}
}
const operations = {list, documents}
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown accounting record operation " + op)
        return operations[op](p)
    }
})
