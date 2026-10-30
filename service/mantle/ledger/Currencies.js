// The currency rate CSV import; the other currency services are inline XML Actions in CurrencyServices.xml.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
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
            else if (i === text.length) throw new Error("CSV has an unterminated quoted field")
            else value += ch
        } else if (ch === '"' && !value) quoted = true
        else if (ch === ",") {
            row.push(value)
            value = ""
        } else if (ch === "\n") {
            row.push(value.replace(/\r$/, ""))
            if (row.some(v => v !== "")) result.push(row.slice())
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
    if (!text || text.length > 2097152) throw new Error("Supply a CSV file of at most 2 MiB")
    const parsed = csv(text),
        header = parsed.shift() || [],
        fields = ["uomId", "toUomId", "fromDate", "thruDate", "conversionFactor", "rateSource"]
    if (
        header.some(h => !fields.includes(h)) ||
        fields.filter(f => f !== "thruDate").some(f => !header.includes(f)) ||
        new Set(header).size !== header.length ||
        parsed.length > 5000
    )
        throw new Error("CSV needs currency, target, effective date, factor and source headers; at most 5,000 rows")
    const results = []
    for (const [i, row] of parsed.entries()) {
        ec.message.pushErrors()
        try {
            if (row.length !== header.length) throw new Error("Column count does not match headers")
            const params = Object.assign(Object.fromEntries(header.map((h, j) => [h, row[j] || null])), {
                organizationPartyId: p.organizationPartyId,
                changeReason: p.changeReason
            })
            const out = ec.service
                .sync()
                .name("mantle.ledger.CurrencyServices.store#Rate")
                .parameters(params)
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push({
                rowNumber: i + 2,
                success: true,
                uomConversionId: out.uomConversionId,
                message: out.alreadyStored ? "Already stored" : "Stored"
            })
        } catch (error) {
            ec.logger.error("Currency CSV row " + (i + 2) + ": " + error.message)
            results.push({
                rowNumber: i + 2,
                success: false,
                message: error.message
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const {importId} = lib.call("create#mantle.ledger.config.CurrencyRateImport", {
        organizationPartyId: p.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        resultJson: JSON.stringify(results)
    })
    return {importId, results, complete: results.every(r => r.success)}
}
const operations = {importRates}
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown currency operation " + op)
        return operations[op](p)
    }
})
