// Currency-separated frozen customer statements. Independent deliveries retain their own outcomes.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, escapeHtml: esc} = lib
const S = "mantle.account.invoice.ReceivableStatementSnapshot"
const D = "mantle.account.invoice.ReceivableStatementDelivery"
function day(value, end = false) {
    if (value == null) return ec.user.nowTimestamp
    const text = ec.l10n.format(value, "yyyy-MM-dd")
    return ec.l10n.parseTimestamp(text + (end ? " 23:59:59.999" : " 00:00:00.000"), "yyyy-MM-dd HH:mm:ss.SSS")
}
function statementHtml(row, asOfDate, fromDate) {
    const amount = value => esc(ec.l10n.formatCurrency(toDecimal(value || 0), row.currencyUomId))
    return (
        '<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:11pt sans-serif}table{width:100%;border-collapse:collapse}td,th{padding:7px;border-bottom:1px solid #ddd;text-align:left}.amount{text-align:right}th,.amount{white-space:nowrap;overflow-wrap:normal;word-break:normal}@media screen and (max-width:480px){body{font-size:11px;margin:6px}td,th{padding:5px 3px}td:first-child{white-space:normal;overflow-wrap:anywhere}h1{font-size:20px}}</style></head><body>' +
        "<h1>Customer statement</h1><p>" +
        esc(row.customerName) +
        " · " +
        esc(row.currencyUomId) +
        "</p><p>" +
        (fromDate ? esc(lib.policy.dateText(fromDate)) + " through " : "As of ") +
        esc(lib.policy.dateText(asOfDate)) +
        "</p>" +
        '<table><thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th class="amount">Original</th><th class="amount">Remaining</th></tr></thead><tbody>' +
        row.invoiceRows
            .map(
                invoice =>
                    "<tr><td>" +
                    esc(invoice.invoiceId) +
                    "</td><td>" +
                    esc(invoice.invoiceDateText) +
                    "</td><td>" +
                    esc(invoice.dueDateText) +
                    '</td><td class="amount">' +
                    amount(invoice.invoiceTotal) +
                    '</td><td class="amount">' +
                    amount(invoice.unpaidTotal) +
                    "</td></tr>"
            )
            .join("") +
        "</tbody></table><p>Opening " +
        amount(row.openingBalance) +
        "</p><p>Unapplied receipts " +
        amount(row.unappliedTotal) +
        "</p><p><strong>Closing balance " +
        amount(row.closingBalance) +
        "</strong></p></body></html>"
    )
}
function preview(p) {
    lib.organization(p.organizationPartyId, "RECEIVABLE_EDIT")
    const asOfDate = day(p.asOfDate, true),
        fromDate = p.fromDate ? day(p.fromDate) : null
    if (fromDate && lib.ms(fromDate) > lib.ms(asOfDate)) denied("DATE_RANGE_INVALID", "The start must precede the statement date")
    const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflow.js")
    const selected = workflow.execute(
        "summary",
        Object.assign({}, p, {queue: "all", fromDate: null, thruDate: new Date(lib.ms(asOfDate) + 1)})
    )
    if (!selected.complete) denied("STATEMENT_SCOPE_TOO_LARGE", "Narrow the statement customer or date selection")
    const allowedCustomers = p.customerPartyIdList ? new Set(Array.from(p.customerPartyIdList)) : null
    const candidates = selected.calendarRows.filter(
        row =>
            lib.ms(row.invoiceDate) <= lib.ms(asOfDate) &&
            !["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived", "InvoiceCancelled"].includes(row.statusId)
    )
    const names = lib.partyNames(candidates.flatMap(row => [row.toPartyId, row.fromPartyId]))
    const invoiceTotals = lib.totalsMany(candidates, asOfDate)
    const grouped = {}
    function group(customerPartyId, currencyUomId) {
        const key = JSON.stringify([customerPartyId, currencyUomId])
        return (
            grouped[key] ||
            (grouped[key] = {
                customerPartyId,
                customerName: names[customerPartyId] || customerPartyId,
                currencyUomId,
                openingBalance: toDecimal(0),
                invoiceTotal: toDecimal(0),
                unpaidTotal: toDecimal(0),
                unappliedTotal: toDecimal(0),
                closingBalance: toDecimal(0),
                invoiceRows: [],
                paymentRows: []
            })
        )
    }
    for (const invoice of candidates) {
        const customerPartyId = invoice.fromPartyId === p.organizationPartyId ? invoice.toPartyId : invoice.fromPartyId
        if (allowedCustomers && !allowedCustomers.has(customerPartyId)) continue
        if (p.currencyUomId && p.currencyUomId !== invoice.currencyUomId) continue
        const item = group(customerPartyId, invoice.currencyUomId)
        const sign = invoice.invoiceTypeEnumId === "InvoiceCreditMemo" ? -1 : 1
        const original = toDecimal(invoice.invoiceTotal).multiply(sign)
        const applications = invoiceTotals[invoice.invoiceId].applications
        const applied = applications.reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0)).multiply(sign)
        const remaining = original.subtract(applied)
        item.invoiceTotal = item.invoiceTotal.add(original)
        item.unpaidTotal = item.unpaidTotal.add(remaining)
        if (fromDate && lib.ms(invoice.invoiceDate) < lib.ms(fromDate)) {
            const before = applications
                .filter(row => lib.ms(row.appliedDate) < lib.ms(fromDate))
                .reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
                .multiply(sign)
            item.openingBalance = item.openingBalance.add(original.subtract(before))
        }
        item.invoiceRows.push({
            invoiceId: invoice.invoiceId,
            invoiceDate: invoice.invoiceDate,
            invoiceDateText: invoice.invoiceDateText,
            dueDate: invoice.dueDate,
            dueDateText: lib.policy.dateText(invoice.dueDate),
            invoiceTotal: original,
            unpaidTotal: remaining,
            currencyUomId: invoice.currencyUomId
        })
    }
    let paymentQuery = find("mantle.account.payment.Payment", {toPartyId: p.organizationPartyId})
        .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
        .condition("effectiveDate", "less-equals", asOfDate)
    if (allowedCustomers) paymentQuery = paymentQuery.condition("fromPartyId", "in", Array.from(allowedCustomers))
    if (p.currencyUomId) paymentQuery = paymentQuery.condition("amountUomId", p.currencyUomId)
    const payments = Array.from(paymentQuery.limit(10001).list())
    if (payments.length > 10000) denied("STATEMENT_SCOPE_TOO_LARGE", "Narrow the statement payment selection")
    for (const payment of payments) {
        if (allowedCustomers && !allowedCustomers.has(payment.fromPartyId)) continue
        if (p.currencyUomId && p.currencyUomId !== payment.amountUomId) continue
        const party = one("mantle.party.Party", {partyId: payment.fromPartyId})
        if (party?.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()) continue
        const item = group(payment.fromPartyId, payment.amountUomId)
        const applied = Array.from(
            find("mantle.account.payment.PaymentApplication", {paymentId: payment.paymentId})
                .condition("appliedDate", "less-equals", asOfDate)
                .list()
        ).reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
        const unapplied = toDecimal(payment.amount || 0).subtract(applied)
        item.unappliedTotal = item.unappliedTotal.add(unapplied)
        if (fromDate && lib.ms(payment.effectiveDate) < lib.ms(fromDate)) {
            const before = Array.from(
                find("mantle.account.payment.PaymentApplication", {paymentId: payment.paymentId})
                    .condition("appliedDate", "less", fromDate)
                    .list()
            ).reduce((sum, row) => sum.add(row.amountApplied || 0), toDecimal(0))
            item.openingBalance = item.openingBalance.subtract(toDecimal(payment.amount || 0).subtract(before))
        }
        item.paymentRows.push({
            paymentId: payment.paymentId,
            amount: payment.amount,
            unappliedTotal: unapplied,
            effectiveDateText: lib.policy.dateText(payment.effectiveDate),
            currencyUomId: payment.amountUomId
        })
    }
    const statementRows = Object.values(grouped).filter(
        row => p.includeZeroBalance || !row.unpaidTotal.subtract(row.unappliedTotal).isZero()
    )
    for (const row of statementRows) {
        row.closingBalance = row.unpaidTotal.subtract(row.unappliedTotal)
        row.printHtml = statementHtml(row, asOfDate, fromDate)
        row.recipients = Array.from(
            find("mantle.party.contact.PartyContactMechInfo", {
                partyId: row.customerPartyId,
                contactMechPurposeId: "EmailBilling"
            })
                .conditionDate("fromDate", "thruDate", null)
                .limit(20)
                .list()
        )
            .map(item => item.infoString)
            .filter(Boolean)
    }
    const inputFingerprint = lib.hash({
        organizationPartyId: p.organizationPartyId,
        asOfDate: String(asOfDate),
        fromDate: fromDate ? String(fromDate) : null,
        statementRows
    })
    const snapshotId = "stmt-" + ec.user.randomString(24),
        previewHtml = statementRows.map(row => row.printHtml).join("\n")
    call("create#" + S, {
        snapshotId,
        organizationPartyId: p.organizationPartyId,
        userId: ec.user.userId,
        asOfDate,
        fromDate,
        inputFingerprint,
        snapshotJson: JSON.stringify(statementRows),
        printHtml: previewHtml,
        createdDate: ec.user.nowTimestamp,
        expiresDate: lib.ms(ec.user.nowTimestamp) + 600000
    })
    return {snapshotId, inputFingerprint, statementRows, previewHtml}
}
function get(p) {
    const row = one(S, {snapshotId: p.snapshotId})
    if (!row) denied("STATEMENT_UNAVAILABLE", "Statement preview is not available")
    lib.organization(row.organizationPartyId, "RECEIVABLE_EDIT")
    if (row.userId !== ec.user.userId || (p.organizationPartyId && p.organizationPartyId !== row.organizationPartyId))
        denied("STATEMENT_DENIED", "Statement preview belongs to another user or organization")
    return {
        snapshotId: row.snapshotId,
        inputFingerprint: row.inputFingerprint,
        statementRows: JSON.parse(row.snapshotJson),
        previewHtml: row.printHtml,
        results: row.resultJson ? JSON.parse(row.resultJson).results || [] : []
    }
}
function deliver(p) {
    const snapshot = one(S, {snapshotId: p.snapshotId})
    const reviewed = get(p)
    if (snapshot.inputFingerprint !== p.inputFingerprint || lib.ms(snapshot.expiresDate) <= lib.ms(ec.user.nowTimestamp))
        denied("STALE_PREVIEW", "Review a current statement preview before sending")
    const statement = reviewed.statementRows.find(
        row => row.customerPartyId === p.customerPartyId && row.currencyUomId === p.currencyUomId
    )
    if (!statement) denied("STATEMENT_UNAVAILABLE", "The selected statement is not in the reviewed snapshot")
    const deliveryKey = "sd:" + lib.hash([p.snapshotId, p.customerPartyId, p.currencyUomId, p.recipient]).slice(0, 37)
    lib.organization(snapshot.organizationPartyId, "RECEIVABLE_EDIT", true)
    const old = one(D, {deliveryKey})
    if (old) return Object.assign(lib.display(old), {alreadyApplied: true})
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(p.recipient)) {
        call("create#" + D, {
            deliveryKey,
            snapshotId: p.snapshotId,
            customerPartyId: p.customerPartyId,
            currencyUomId: p.currencyUomId,
            recipient: p.recipient,
            status: "failed",
            reasonCode: "RECIPIENT_INVALID",
            errorMessage: "Invalid recipient address",
            createdDate: ec.user.nowTimestamp
        })
        return {
            customerPartyId: p.customerPartyId,
            currencyUomId: p.currencyUomId,
            recipient: p.recipient,
            status: "failed",
            reasonCode: "RECIPIENT_INVALID",
            errorMessage: "Invalid recipient address"
        }
    }
    const emailAccountId = lib.emailAccount(Object.assign({}, p, {organizationPartyId: snapshot.organizationPartyId}))
    const bytes = ec.resource.xslFoTransform(statement.printHtml, null, null, "application/pdf")
    const location = "dbresource://mantle/content/statements/" + p.snapshotId + "/" + deliveryKey + ".pdf"
    ec.resource.getLocationReference(location).putBytes(bytes)
    const draft = call("org.moqui.impl.EmailClientServices.save#Draft", {
        emailAccountId,
        toAddresses: p.recipient,
        subject: "Customer statement · " + statement.currencyUomId,
        body: statement.printHtml,
        bodyText:
            "Statement as of " +
            lib.policy.dateText(snapshot.asOfDate) +
            " · " +
            statement.currencyUomId +
            " · " +
            statement.closingBalance,
        attachmentList: [
            {attachmentLocation: location, fileName: "Statement-" + p.snapshotId + ".pdf", contentType: "application/pdf"}
        ]
    })
    const sent = call("mantle.party.CommunicationServices.send#EmailDraft", {
        emailMessageId: draft.emailMessageId,
        recordEntityName: "mantle.party.Party",
        recordId: statement.customerPartyId
    })
    const status = sent.sent ? "sent" : ["ES_READY", "ES_SCHEDULED", "ES_SENT"].includes(sent.statusId) ? "queued" : "failed"
    call("create#" + D, {
        deliveryKey,
        snapshotId: p.snapshotId,
        customerPartyId: p.customerPartyId,
        currencyUomId: p.currencyUomId,
        recipient: p.recipient,
        emailMessageId: draft.emailMessageId,
        contentLocation: location,
        status,
        errorMessage: sent.sendError || null,
        createdDate: ec.user.nowTimestamp
    })
    return {
        customerPartyId: p.customerPartyId,
        currencyUomId: p.currencyUomId,
        recipient: p.recipient,
        status,
        emailMessageId: draft.emailMessageId,
        errorMessage: sent.sendError || null
    }
}
function prepare(p) {
    const snapshot = one(S, {snapshotId: p.snapshotId})
    get(p)
    const operation = lib.operation(p, "StatementSend", snapshot.organizationPartyId, {
        snapshotId: p.snapshotId,
        inputFingerprint: p.inputFingerprint,
        toAddresses: p.toAddresses || null,
        emailAccountId: p.emailAccountId || null
    })
    if (operation.old?.status === "complete")
        return {complete: true, result: lib.previous(operation), requestHash: operation.requestHash}
    if (snapshot.inputFingerprint !== p.inputFingerprint || lib.ms(snapshot.expiresDate) <= lib.ms(ec.user.nowTimestamp))
        denied("STALE_PREVIEW", "Review a current statement preview")
    if (!operation.old)
        call("create#" + lib.operationEntity, {
            operationKey: operation.operationKey,
            operationType: "StatementSend",
            organizationPartyId: snapshot.organizationPartyId,
            userId: ec.user.userId,
            submittedDate: ec.user.nowTimestamp,
            requestHash: operation.requestHash,
            status: "pending",
            resultEntityName: S,
            resultId: p.snapshotId
        })
    return {complete: false, requestHash: operation.requestHash}
}
function send(p) {
    const begun = lib.probe("mantle.account.CollectionServices.prepare#StatementSend", p)
    if (begun.complete) return begun.result
    const reviewed = get(p)
    const results = []
    for (const statement of reviewed.statementRows) {
        const recipients = [
            ...new Set(
                (p.toAddresses ? String(p.toAddresses).split(/[,;\n]+/) : statement.recipients || [])
                    .map(value => String(value).trim().toLowerCase())
                    .filter(Boolean)
            )
        ]
        if (!recipients.length)
            results.push({
                customerPartyId: statement.customerPartyId,
                currencyUomId: statement.currencyUomId,
                status: "failed",
                reasonCode: "RECIPIENT_REQUIRED",
                errorMessage: "No billing recipient"
            })
        for (const recipient of recipients) {
            try {
                results.push(
                    lib.probe(
                        "mantle.account.CollectionServices.deliver#StatementRecipient",
                        Object.assign({}, p, {
                            customerPartyId: statement.customerPartyId,
                            currencyUomId: statement.currencyUomId,
                            recipient
                        })
                    )
                )
            } catch (error) {
                ec.logger.error("Statement " + statement.customerPartyId + " recipient " + recipient + ": " + error.message)
                results.push({
                    customerPartyId: statement.customerPartyId,
                    currencyUomId: statement.currencyUomId,
                    recipient,
                    status: "failed",
                    reasonCode: String(error.message).split(":")[0],
                    errorMessage: error.message
                })
            }
        }
    }
    const result = {
        snapshotId: p.snapshotId,
        results,
        successCount: results.filter(row => ["sent", "queued"].includes(row.status)).length,
        failureCount: results.filter(row => !["sent", "queued"].includes(row.status)).length,
        alreadyApplied: false
    }
    lib.probe(
        "mantle.account.CollectionServices.record#StatementResult",
        Object.assign({}, p, {requestHash: begun.requestHash, result})
    )
    return result
}
function recordResult(p) {
    const snapshot = one(S, {snapshotId: p.snapshotId})
    get(p)
    lib.organization(snapshot.organizationPartyId, "RECEIVABLE_EDIT", true)
    const old = one(lib.operationEntity, {operationKey: p.operationKey})
    if (
        !old ||
        old.operationType !== "StatementSend" ||
        old.organizationPartyId !== snapshot.organizationPartyId ||
        old.resultId !== p.snapshotId ||
        old.requestHash !== p.requestHash ||
        old.userId !== ec.user.userId
    )
        denied("OPERATION_KEY_CONFLICT", "Statement operation key was used for another request")
    if (old.status === "complete") return {}
    call("update#" + lib.operationEntity, {
        operationKey: p.operationKey,
        operationType: "StatementSend",
        organizationPartyId: snapshot.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        completedDate: ec.user.nowTimestamp,
        requestHash: p.requestHash,
        status: "complete",
        resultEntityName: S,
        resultId: p.snapshotId,
        resultJson: JSON.stringify(p.result)
    })
    call("update#" + S, {snapshotId: p.snapshotId, resultJson: JSON.stringify(p.result)})
    return {}
}
const operations = {preview, get, prepare, deliver, send, recordResult}
;({
    execute: (op, p) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown statement operation " + op)
        return operations[op](p)
    }
})
