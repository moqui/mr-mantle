const lib = ec.resource.script(
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
)
const { call, map, pick } = lib
function list(p) {
    let { q, kind } = lib.query(p)
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
            .orderBy(kind[1])
            .limit(pageSize)
            .offset(pageSize * pageIndex)
            .list(),
    ).map(map)
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
    const out = { record: map(row) }
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
            map(account),
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
            .map(map)
        Object.assign(
            out,
            call(
                "mantle.ledger.LedgerServices.calculate#AcctgTransTrialBalance",
                { acctgTransId: row.acctgTransId },
            ),
        )
    }
    if (p.kind === "templates")
        out.lines = lib
            .rows("mantle.ledger.transaction.AcctgTransTemplateEntry", {
                acctgTransTemplateId: row.acctgTransTemplateId,
            })
            .map(map)
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
        result = call(
            "mantle.account.PaymentServices.create#Payment",
            Object.assign(base, {
                paymentTypeEnumId: "PtDisbursement",
                paymentInstrumentEnumId: "PiOther",
                amountUomId: currency,
                amount: p.amount,
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
