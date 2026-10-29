const lib = ec.resource.script(
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
)
const R = "moqui.basic.UomConversion"
function rate(p) {
    lib.organization(p, "admin")
    const why = lib.reason(p)
    lib.currency(p.uomId)
    lib.currency(p.toUomId)
    if (
        p.uomId === p.toUomId ||
        p.conversionFactor == null ||
        toDecimal(p.conversionFactor).compare(0) <= 0 ||
        !Number.isFinite(lib.ms(p.fromDate)) ||
        !String(p.rateSource || "").trim()
    )
        throw new Error(
            "Choose distinct currencies, a positive factor, an effective date and source",
        )
    if (p.thruDate && lib.ms(p.thruDate) <= lib.ms(p.fromDate))
        throw new Error("Rate end must follow its start")
    for (const id of [p.uomId, p.toUomId].sort())
        lib.find("moqui.basic.Uom", { uomId: id }).forUpdate(true).one()
    const existing = lib.rows(R, { uomId: p.uomId, toUomId: p.toUomId })
    const equal = existing.find(
        (r) => lib.ms(r.fromDate) === lib.ms(p.fromDate),
    )
    if (equal) {
        if (
            toDecimal(equal.conversionFactor).eq(p.conversionFactor) &&
            equal.rateSource === p.rateSource &&
            lib.ms(equal.thruDate) === lib.ms(p.thruDate)
        )
            return {
                uomConversionId: equal.uomConversionId,
                alreadyStored: true,
            }
        throw new Error(
            "A rate already starts at this time; preserve it and choose a later date",
        )
    }
    const after = existing
        .filter((r) => lib.ms(r.fromDate) > lib.ms(p.fromDate))
        .sort((a, b) => lib.ms(a.fromDate) - lib.ms(b.fromDate))[0]
    if (after && p.thruDate && lib.ms(p.thruDate) > lib.ms(after.fromDate))
        throw new Error("Rate overlaps a future dated rate")
    const before = existing.find(
        (r) =>
            lib.ms(r.fromDate) < lib.ms(p.fromDate) &&
            (lib.ms(r.thruDate) ?? Infinity) > lib.ms(p.fromDate),
    )
    lib.audit(["fromDate", "thruDate", "conversionFactor", "rateSource"], why)
    if (before)
        lib.call("update#" + R, {
            uomConversionId: before.uomConversionId,
            thruDate: p.fromDate,
        })
    return lib.call("create#" + R, {
        uomId: p.uomId,
        toUomId: p.toUomId,
        conversionFactor: p.conversionFactor,
        conversionOffset: 0,
        fromDate: p.fromDate,
        thruDate: p.thruDate || after?.fromDate,
        rateSource: p.rateSource,
    })
}
function currency(p) {
    lib.organization(p, "admin")
    const why = lib.reason(p)
    if (
        !/^[A-Z]{3}$/.test(p.uomId || "") ||
        !p.description ||
        !Number.isInteger(Number(p.fractionDigits)) ||
        Number(p.fractionDigits) < 0 ||
        Number(p.fractionDigits) > 6
    )
        throw new Error(
            "Supply a three-letter currency code, name and 0–6 decimals",
        )
    const old = lib
        .find("moqui.basic.Uom", { uomId: p.uomId })
        .forUpdate(true)
        .one()
    if (old) {
        lib.currency(p.uomId)
        lib.revision(old, p.lastUpdatedStamp)
        if (
            Number(old.fractionDigits) !== Number(p.fractionDigits) &&
            lib
                .find("mantle.ledger.transaction.AcctgTrans", {
                    amountUomId: p.uomId,
                    isPosted: "Y",
                })
                .count()
        )
            throw new Error("Posted currency precision requires a migration")
    }
    lib.audit(["description", "fractionDigits"], why)
    lib.call((old ? "update#" : "create#") + "moqui.basic.Uom", {
        uomId: p.uomId,
        uomTypeEnumId: "UT_CURRENCY_MEASURE",
        description: p.description,
        abbreviation: p.uomId,
        fractionDigits: Number(p.fractionDigits),
    })
    return { complete: true }
}
function csv(text) {
    const result = [],
        row = []
    let value = "",
        quoted = false
    for (let i = 0; i <= text.length; i++) {
        const ch = text[i] || "\n"
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
                value += '"'
                i++
            } else if (ch === '"') quoted = false
            else if (i === text.length)
                throw new Error("CSV has an unterminated quoted field")
            else value += ch
        } else if (ch === '"' && !value) quoted = true
        else if (ch === ",") {
            row.push(value)
            value = ""
        } else if (ch === "\n") {
            row.push(value.replace(/\r$/, ""))
            if (row.some((v) => v !== "")) result.push(row.slice())
            row.length = 0
            value = ""
        } else value += ch
    }
    return result
}
function importRates(p) {
    lib.organization(p, "admin")
    lib.reason(p)
    const text = String(p.csvText || "")
    if (!text || text.length > 2097152)
        throw new Error("Supply a CSV file of at most 2 MiB")
    const parsed = csv(text),
        header = parsed.shift() || [],
        fields = [
            "uomId",
            "toUomId",
            "fromDate",
            "thruDate",
            "conversionFactor",
            "rateSource",
        ]
    if (
        header.some((h) => !fields.includes(h)) ||
        fields
            .filter((f) => f !== "thruDate")
            .some((f) => !header.includes(f)) ||
        new Set(header).size !== header.length ||
        parsed.length > 5000
    )
        throw new Error(
            "CSV needs currency, target, effective date, factor and source headers; at most 5,000 rows",
        )
    const results = []
    for (const [i, row] of parsed.entries()) {
        ec.message.pushErrors()
        try {
            if (row.length !== header.length)
                throw new Error("Column count does not match headers")
            const params = Object.assign(
                Object.fromEntries(header.map((h, j) => [h, row[j] || null])),
                {
                    organizationPartyId: p.organizationPartyId,
                    changeReason: p.changeReason,
                },
            )
            const out = ec.service
                .sync()
                .name("mantle.ledger.CurrencyServices.store#Rate")
                .parameters(params)
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError())
                throw new Error(ec.message.getErrorsString())
            results.push({
                rowNumber: i + 2,
                success: true,
                uomConversionId: out.uomConversionId,
                message: out.alreadyStored ? "Already stored" : "Stored",
            })
        } catch (error) {
            ec.logger.error(
                "Currency CSV row " + (i + 2) + ": " + error.message,
            )
            results.push({
                rowNumber: i + 2,
                success: false,
                message: error.message,
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const importId = "rates-" + ec.user.randomString(24)
    lib.call("create#mantle.ledger.config.CurrencyRateImport", {
        importId,
        organizationPartyId: p.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        resultJson: JSON.stringify(results),
    })
    return { importId, results, complete: results.every((r) => r.success) }
}
function importResult(p) {
    const s = lib.organization(p, "admin"),
        row = lib.one("mantle.ledger.config.CurrencyRateImport", {
            importId: p.importId,
        })
    if (
        !row ||
        row.organizationPartyId !== s.organizationPartyId ||
        row.userId !== ec.user.userId
    )
        throw new Error("Open your own rate import result")
    const results = JSON.parse(row.resultJson)
    return {
        importId: row.importId,
        results,
        complete: results.every((r) => r.success),
    }
}
const operations = { rate, currency, importRates, importResult }
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown currency operation " + op)
        return operations[op](p)
    },
})
