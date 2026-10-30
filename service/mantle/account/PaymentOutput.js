// Issued payment documents are immutable snapshots. Reading a document never allocates a number or changes money.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {lib, paymentScope, paymentVersion, methodRows} = workflow
const {find, one, call, denied, hash, policy, escapeHtml: esc} = lib
const readEntityName = "mantle.account.payment.PaymentContentRead"
const OUTPUT = "mantle.account.payment.PaymentIssuedOutput",
    CONTENT = "mantle.account.payment.PaymentContent"
function canonicalLocation(value) {
    const text = String(value || "")
    if (!text.startsWith("dbresource:")) return text
    return (
        "dbresource://" +
        text
            .slice(text.startsWith("dbresource://") ? 13 : 11)
            .split("/")
            .filter(Boolean)
            .join("/")
    )
}
function treasury(scope) {
    return scope.broad && (lib.has("PAYMENT_EDIT") || lib.has("ACCOUNTING_ADMIN") || lib.access.systemAdmin())
}
function issuedReference(row) {
    if (!row) return null
    if (row.paymentContentId) {
        const output = one(OUTPUT, {paymentContentId: row.paymentContentId})
        if (output) return output
    }
    const location = canonicalLocation(row.contentLocation)
    if (row.paymentOutputId) {
        const output = one(OUTPUT, {paymentOutputId: row.paymentOutputId})
        if (output && output.paymentId === row.paymentId) return output
    }
    if (location.startsWith("dbresource://mantle/content/payment-issued/")) {
        const path = location.slice("dbresource://mantle/content/payment-issued/".length).split("/")
        if (path[0] && path[1] && path[1] !== "evidence") {
            const output = one(OUTPUT, {paymentId: path[0], paymentOutputId: path[1]})
            if (output) return output
        }
    }
    return null
}
function reservedLocation(value) {
    return canonicalLocation(value).startsWith("dbresource://mantle/content/payment-issued/")
}
function readCondition(p) {
    const scope = paymentScope(p),
        cf = ec.entity.conditionFactory,
        conditions = [cf.makeCondition("paymentId", "equals", scope.record.paymentId)]
    if (!treasury(scope))
        conditions.push(
            cf.makeCondition(
                [
                    cf.makeCondition("issuedOutputType", "is-null", null),
                    cf.makeCondition("issuedOutputType", "not-equals", "check")
                ],
                "or"
            )
        )
    return cf.makeCondition(conditions, "and")
}
function canReadContent(value, organizationPartyId = null) {
    const id = typeof value === "string" ? value : value?.paymentContentId,
        row = id && one(CONTENT, {paymentContentId: id})
    if (!row) denied("PAYMENT_CONTENT_UNAVAILABLE", "The payment file is unavailable")
    const scope = paymentScope({organizationPartyId, paymentId: row.paymentId}),
        output = issuedReference(row)
    if (output && (output.paymentId !== row.paymentId || output.organizationPartyId !== scope.organizationPartyId))
        denied("PAYMENT_CONTENT_UNAVAILABLE", "The payment file is unavailable")
    if (output?.outputType === "check" && !treasury(scope))
        denied("PERMISSION_DENIED", "Treasury authority is required to read an issued check")
    if (reservedLocation(row.contentLocation) && !output)
        denied("PAYMENT_CONTENT_UNAVAILABLE", "Private evidence is not a public payment file")
    return {
        canRead: true,
        isImmutable: Boolean(output || reservedLocation(row.contentLocation)),
        outputType: output?.outputType || null,
        paymentId: row.paymentId,
        organizationPartyId: scope.organizationPartyId
    }
}
function available(scope) {
    const outputs = Array.from(
        find(OUTPUT, {organizationPartyId: scope.organizationPartyId, paymentId: scope.record.paymentId})
            .orderBy("-createdDate,paymentOutputId")
            .limit(20)
            .list()
    )
    return {
        canPrintReceipt: outputs.some(row => row.outputType === "receipt"),
        canPrintDetail: outputs.some(row => row.outputType === "detail"),
        canPrintCheck: treasury(scope) && outputs.some(row => row.outputType === "check"),
        outputRows: outputs
            .filter(row => row.outputType !== "check" || treasury(scope))
            .map(row =>
                policy.pick(lib.display(row), [
                    "paymentOutputId",
                    "outputType",
                    "fileName",
                    "contentType",
                    "contentSize",
                    "createdDate",
                    "createdDateText",
                    "contentHash"
                ])
            )
    }
}
function documentHtml(type, summary, bank = null) {
    const heading =
            type === "check"
                ? "Check " + summary.checkNumber
                : type === "receipt"
                  ? summary.cashDirection === "incoming"
                      ? "Payment receipt"
                      : "Payment issued"
                  : "Payment details",
        amount = ec.l10n.formatCurrency(toDecimal(summary.amount), summary.currencyUomId),
        line = (label, value) =>
            value == null || value === "" ? "" : "<tr><th>" + esc(label) + "</th><td>" + esc(value) + "</td></tr>"
    return (
        '<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:11pt sans-serif;color:#20252b}h1{font-size:22pt}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;vertical-align:top}th{width:32%;white-space:nowrap}.amount{font-size:20pt;white-space:nowrap}footer{margin-top:28px;font-size:9pt}.check{border:1px solid #555;padding:20px}.bank{font-family:monospace;margin-top:30px;letter-spacing:1px}@media screen and (max-width:480px){body{font-size:10pt}th,td{padding:5px}td{overflow-wrap:anywhere}.check{padding:10px}}</style></head><body><h1>' +
        esc(heading) +
        '</h1><div class="' +
        (type === "check" ? "check" : "document") +
        '"><p><strong>' +
        esc(summary.organizationName) +
        '</strong></p><p class="amount">' +
        esc(amount) +
        "</p><table>" +
        line("Payment", summary.paymentId) +
        line("Date", summary.accountingDateText) +
        line(type === "check" || summary.cashDirection === "outgoing" ? "Pay to" : "Received from", summary.partyName) +
        line("Currency", summary.currencyUomId) +
        line("Method", summary.maskedMethodLabel) +
        line("Reference", summary.referenceNumber) +
        line("Reason", summary.reason) +
        (type === "check" ? line("Check number", summary.checkNumber) + line("Bank", bank?.bankName) : "") +
        "</table>" +
        (type === "check"
            ? '<p class="bank">' +
              esc(bank?.routingNumber || "") +
              " · " +
              esc(bank?.accountNumber || "") +
              " · " +
              esc(summary.checkNumber) +
              "</p>"
            : "") +
        "</div><footer>Issued payment document · " +
        esc(summary.paymentId) +
        "</footer></body></html>"
    )
}
function issue(scope, request, operationKey) {
    const actual = paymentScope({organizationPartyId: scope.organizationPartyId, paymentId: scope.record.paymentId}, true),
        r = actual.record
    if (r.statusId !== "PmntDelivered") denied("PAYMENT_OUTPUT_STATE_INVALID", "Issued output requires a delivered payment")
    const names = lib.partyNames([r.fromPartyId, r.toPartyId]),
        methodId = actual.cashDirection === "incoming" ? r.toPaymentMethodId : r.paymentMethodId,
        method = one("mantle.account.method.PaymentMethod", {paymentMethodId: methodId}),
        masked = method ? methodRows([method])[0] : null,
        check =
            !r.gatewayRole &&
            actual.cashDirection === "outgoing" &&
            ["PiCompanyCheck", "PiCertifiedCheck"].includes(r.paymentInstrumentEnumId),
        checkRow = check ? one("mantle.account.method.BankAccountCheck", {paymentId: r.paymentId}) : null,
        bank = check ? one("mantle.account.method.BankAccount", {paymentMethodId: methodId}) : null
    if (check && (!checkRow || !bank || !treasury(actual)))
        denied("CHECK_NUMBER_REQUIRED", "The reviewed check must have a reserved number and treasury authority")
    const summary = Object.assign({}, request.paymentSummary || {}, {
            paymentId: r.paymentId,
            amount: String(r.amount),
            currencyUomId: r.amountUomId,
            accountingDateText: r.accountingDate
                ? policy.calendarDateText(r.accountingDate)
                : ec.l10n.format(r.effectiveDate, "yyyy-MM-dd"),
            organizationName: request.paymentSummary?.organizationName || names[actual.organizationPartyId],
            partyName: request.paymentSummary?.partyName || names[actual.partyId],
            cashDirection: actual.cashDirection,
            maskedMethodLabel: request.paymentSummary?.maskedMethodLabel || masked?.label || "",
            referenceNumber: request.referenceNumber || r.paymentRefNum,
            reason: request.reason,
            checkNumber: checkRow ? String(checkRow.checkNumber) : null
        }),
        result = []
    for (const type of ["receipt", "detail", ...(check ? ["check"] : [])]) {
        const approvedHtml = documentHtml(type, summary, bank),
            pdf = ec.resource.xslFoTransform(approvedHtml, null, null, "application/pdf"),
            paymentOutputId = ec.user.randomString(32),
            paymentContentId = ec.user.randomString(32),
            fileName = "Payment-" + r.paymentId + "-" + type + ".pdf",
            location =
                "dbresource://mantle/content/payment-issued/" + r.paymentId + "/" + paymentOutputId + "/" + type + "/" + fileName,
            contentHash = hash(StringUtilities.base64Encode(pdf)),
            sourceVersion = hash({summary, type, contentHash})
        ec.resource.getLocationReference(location).putBytes(pdf)
        call("create#" + OUTPUT, {
            paymentOutputId,
            organizationPartyId: actual.organizationPartyId,
            paymentId: r.paymentId,
            paymentContentId,
            outputType: type,
            sourceVersion,
            amount: r.amount,
            currencyUomId: r.amountUomId,
            accountingDate: summary.accountingDateText,
            userId: ec.user.userId,
            createdDate: ec.user.nowTimestamp,
            contentLocation: location,
            contentHash,
            fileName,
            contentType: "application/pdf",
            contentSize: pdf.length,
            approvedHtml,
            summaryJson: JSON.stringify(summary),
            operationKey
        })
        call("create#" + CONTENT, {
            paymentContentId,
            paymentId: r.paymentId,
            paymentOutputId,
            contentLocation: location,
            isImmutable: "Y",
            contentTypeEnumId: type === "check" ? "PctCheckImage" : type === "receipt" ? "PctReceipt" : "PctPaymentDocument",
            description: fileName,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId
        })
        result.push({outputId: paymentOutputId, outputType: type, fileName, contentHash})
    }
    return result
}
function getOutput(p) {
    const selected = p.outputId ? one(OUTPUT, {paymentOutputId: p.outputId}) : null,
        scope = paymentScope({
            organizationPartyId: p.organizationPartyId || selected?.organizationPartyId,
            paymentId: p.paymentId || selected?.paymentId
        }),
        type = p.outputType || selected?.outputType || "receipt"
    if (!["receipt", "detail", "check"].includes(type)) denied("PAYMENT_OUTPUT_TYPE_INVALID", "Choose an issued payment document")
    if (type === "check" && !treasury(scope))
        denied("PERMISSION_DENIED", "Treasury authority is required to read an issued check")
    if (p.sourceVersion && p.sourceVersion !== paymentVersion(scope.record))
        denied("STALE_REVISION", "The payment changed; reload before printing")
    const row =
        selected ||
        find(OUTPUT, {organizationPartyId: scope.organizationPartyId, paymentId: scope.record.paymentId, outputType: type})
            .orderBy("-createdDate,paymentOutputId")
            .one()
    if (
        !row ||
        row.paymentId !== scope.record.paymentId ||
        row.organizationPartyId !== scope.organizationPartyId ||
        row.outputType !== type
    )
        denied("PAYMENT_OUTPUT_UNAVAILABLE", "The issued payment document is unavailable")
    const ref = ec.resource.getLocationReference(row.contentLocation)
    if (!ref.getExists() || !ref.isFile()) denied("PAYMENT_OUTPUT_UNAVAILABLE", "The archived payment document is unavailable")
    return {
        paymentId: row.paymentId,
        outputId: row.paymentOutputId,
        outputType: row.outputType,
        approvedHtml: row.approvedHtml,
        sourceVersion: paymentVersion(scope.record),
        outputSourceVersion: row.sourceVersion,
        contentHash: row.contentHash,
        fileName: row.fileName,
        contentType: row.contentType,
        contentSize: row.contentSize,
        accountingDateText: policy.calendarDateText(row.accountingDate),
        summary: JSON.parse(row.summaryJson)
    }
}
;({
    OUTPUT,
    readEntityName,
    canonicalLocation,
    issuedReference,
    reservedLocation,
    treasury,
    readCondition,
    canReadContent,
    available,
    issue,
    getOutput
})
