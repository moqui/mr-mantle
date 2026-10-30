const lib = ec.resource.script(
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
)
const SUMMARY = "mantle.ledger.transaction.AcctgTransAndEntrySummary"
function base(p, before = false) {
    const s = lib.organization(p, "reportRead")
    lib.dimensions(s.organizationPartyId, p)
    if (p.amountUomId) lib.currency(p.amountUomId)
    let q = lib.find(SUMMARY, {
        organizationPartyId: s.organizationPartyId,
        isPosted: "Y",
    })
    for (const field of [
        "glAccountId",
        "amountUomId",
        "debitCreditFlag",
        "amount",
    ])
        q = q.selectField(field)
    if (p.glAccountId) {
        lib.record({
            kind: "accounts",
            recordId: p.glAccountId,
            organizationPartyId: s.organizationPartyId,
        })
        q = q.condition("glAccountId", p.glAccountId)
    }
    if (p.amountUomId) q = q.condition("amountUomId", p.amountUomId)
    if (p.facilityId) q = q.condition("facilityId", p.facilityId)
    if (p.costCenterId) q = q.condition("costCenterId", p.costCenterId)
    if (before && p.fromDate)
        q = q.condition("transactionDate", "less", p.fromDate)
    else if (before)
        q = q.condition("transactionDate", "less", new Date(0).toISOString())
    else {
        if (p.fromDate)
            q = q.condition("transactionDate", "greater-equals", p.fromDate)
        if (p.thruDate) q = q.condition("transactionDate", "less", p.thruDate)
    }
    return { q, s }
}
function options(p) {
    const out = Object.assign({}, p)
    if (p.timePeriodId) {
        const period = lib.record({
            kind: "periods",
            recordId: p.timePeriodId,
            organizationPartyId: p.organizationPartyId,
        })
        out.fromDate = new Date(lib.ms(period.fromDate)).toISOString()
        out.thruDate = new Date(
            lib.ms(period.thruDate) + 86400000,
        ).toISOString()
        out.period = period
    }
    if (
        (out.fromDate && !Number.isFinite(lib.ms(out.fromDate))) ||
        (out.thruDate && !Number.isFinite(lib.ms(out.thruDate))) ||
        (out.fromDate &&
            out.thruDate &&
            lib.ms(out.fromDate) >= lib.ms(out.thruDate))
    )
        throw new Error("Choose an increasing report date range")
    return out
}
function trial(p) {
    p = options(p)
    const { q, s } = base(p),
        totals = new Map()
    const entry = (r) => {
        const key = r.glAccountId + ":" + r.amountUomId
        if (!totals.has(key))
            totals.set(key, {
                glAccountId: r.glAccountId,
                amountUomId: r.amountUomId,
                beginning: toDecimal(0),
                debits: toDecimal(0),
                credits: toDecimal(0),
                ending: toDecimal(0),
            })
        return totals.get(key)
    }
    const movement = Array.from(q.list()),
        beginning = Array.from(base(p, true).q.list())
    if (p.period?.isClosed === "Y" && !p.facilityId && !p.costCenterId) {
        const currencies = [...new Set(movement.map((r) => r.amountUomId))],
            baseCurrency = lib.preference(
                s.organizationPartyId,
            ).baseCurrencyUomId
        if (p.amountUomId && p.amountUomId !== baseCurrency && !movement.length)
            return {
                reportRows: [],
                organizationPartyId: s.organizationPartyId,
                asOf: ec.l10n.format(
                    ec.user.nowTimestamp,
                    "yyyy-MM-dd HH:mm:ss",
                ),
                complete: true,
            }
        if (currencies.some((c) => c !== baseCurrency))
            throw new Error(
                "Closed-period summaries cannot represent mixed currencies",
            )
        let summaries = lib.find(
            "mantle.ledger.account.GlAccountOrgTimePeriod",
            {
                organizationPartyId: s.organizationPartyId,
                timePeriodId: p.timePeriodId,
            },
        )
        if (p.glAccountId)
            summaries = summaries.condition("glAccountId", p.glAccountId)
        const stored = Array.from(summaries.list())
        if (
            [...movement, ...beginning].some(
                (r) =>
                    !stored.some(
                        (summary) => summary.glAccountId === r.glAccountId,
                    ),
            )
        )
            throw new Error(
                "Closed-period summary is incomplete; run period close reconciliation",
            )
        for (const row of stored)
            Object.assign(
                entry({
                    glAccountId: row.glAccountId,
                    amountUomId: baseCurrency,
                }),
                {
                    beginning: toDecimal(row.beginningBalance || 0),
                    debits: toDecimal(row.postedDebits || 0),
                    credits: toDecimal(row.postedCredits || 0),
                    ending: toDecimal(row.endingBalance || 0),
                    closedSummary: true,
                },
            )
    } else {
        for (const row of beginning) {
            const total = entry(row)
            total.beginning = total.beginning.add(
                toDecimal(row.amount).multiply(
                    row.debitCreditFlag === "D" ? 1 : -1,
                ),
            )
        }
        for (const row of movement) {
            const total = entry(row)
            const field = row.debitCreditFlag === "D" ? "debits" : "credits"
            total[field] = total[field].add(row.amount)
        }
        for (const row of totals.values())
            row.ending = row.beginning.add(row.debits).subtract(row.credits)
    }
    const ids = [...new Set([...totals.values()].map((r) => r.glAccountId))]
    const names = Object.fromEntries(
        ids.length
            ? Array.from(
                  lib
                      .find("mantle.ledger.account.GlAccount")
                      .condition("glAccountId", "in", ids)
                      .list(),
              ).map((r) => [
                  r.glAccountId,
                  { name: r.accountName, isDebit: r.isDebit },
              ])
            : [],
    )
    return {
        reportRows: [...totals.values()].map((r) => {
            const account = names[r.glAccountId]
            if (r.closedSummary && account?.isDebit !== "Y") {
                r.beginning = r.beginning.negate()
                r.ending = r.ending.negate()
            }
            return Object.assign(r, { accountName: account?.name })
        }),
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        organizationPartyId: s.organizationPartyId,
        complete: true,
    }
}
function ledger(p) {
    p = options(p)
    const { s } = base(p)
    let q = lib.find("mantle.ledger.transaction.AcctgTransAndEntry", {
        organizationPartyId: s.organizationPartyId,
        isPosted: "Y",
    })
    for (const field of [
        "glAccountId",
        "amountUomId",
        "facilityId",
        "costCenterId",
    ])
        if (p[field]) q = q.condition(field, p[field])
    if (p.fromDate)
        q = q.condition("transactionDate", "greater-equals", p.fromDate)
    if (p.thruDate) q = q.condition("transactionDate", "less", p.thruDate)

    const balances = {}
    for (const row of Array.from(base(p, true).q.list())) {
        const key = row.glAccountId + ":" + row.amountUomId
        balances[key] = (balances[key] || toDecimal(0)).add(
            toDecimal(row.amount).multiply(
                row.debitCreditFlag === "D" ? 1 : -1,
            ),
        )
    }
    const selected = Array.from(
        q
            .orderBy(
                "glAccountId,transactionDate,acctgTransId,acctgTransEntrySeqId",
            )
            .limit(10001)
            .list(),
    )
    if (selected.length > 10000)
        throw new Error("Narrow the ledger to at most 10,000 lines")
    const reportRows = selected.map((row) => {
        const key = row.glAccountId + ":" + row.amountUomId
        balances[key] = (balances[key] || toDecimal(0)).add(
            toDecimal(row.amount).multiply(
                row.debitCreditFlag === "D" ? 1 : -1,
            ),
        )
        return Object.assign(lib.display(row), {
            debits: row.debitCreditFlag === "D" ? row.amount : toDecimal(0),
            credits: row.debitCreditFlag === "C" ? row.amount : toDecimal(0),
            ending: balances[key],
        })
    })
    return {
        reportRows,
        organizationPartyId: s.organizationPartyId,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        complete: true,
    }
}
function report(op, p) {
    const result = (op === "trial" ? trial : ledger)(p)
    if (!p.compareFromDate && !p.compareThruDate)
        return Object.assign(result, { comparisonRows: [] })
    if (!p.compareFromDate || !p.compareThruDate)
        throw new Error("Choose both comparison dates")
    const comparison = (op === "trial" ? trial : ledger)(
        Object.assign({}, p, {
            timePeriodId: null,
            fromDate: p.compareFromDate,
            thruDate: p.compareThruDate,
        }),
    )
    if (op === "trial") {
        const values = new Map(
            comparison.reportRows.map((row) => [
                row.glAccountId + ":" + row.amountUomId,
                row,
            ]),
        )
        for (const row of result.reportRows) {
            const key = row.glAccountId + ":" + row.amountUomId
            row.comparisonEnding = values.get(key)?.ending || toDecimal(0)
            row.change = row.ending.subtract(row.comparisonEnding)
            values.delete(key)
        }
        for (const row of values.values())
            result.reportRows.push(
                Object.assign({}, row, {
                    beginning: toDecimal(0),
                    debits: toDecimal(0),
                    credits: toDecimal(0),
                    ending: toDecimal(0),
                    comparisonEnding: row.ending,
                    change: row.ending.negate(),
                }),
            )
    }
    return Object.assign(result, { comparisonRows: comparison.reportRows })
}
;({
    execute: (op, p) => {
        if (!["trial", "ledger"].includes(op))
            throw new Error("Unknown finance report")
        return report(op, p)
    },
})
