// Issued PDFs and per-recipient sends are committed independently; a retry never recreates successful mail.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, display, escapeHtml: esc} = lib
const D = "mantle.account.invoice.InvoiceDelivery"
const R = "mantle.account.invoice.InvoiceDeliveryRecipient"
const I = lib.invoiceEntity
const attachments = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceAttachments.js")
function contacts(partyId) {
    return Array.from(
        find("mantle.party.contact.PartyContactMechInfo", {partyId, contactMechPurposeId: "EmailBilling"})
            .conditionDate("fromDate", "thruDate", null)
            .orderBy("-fromDate")
            .limit(20)
            .list()
    )
        .map(row => row.infoString)
        .filter(Boolean)
}
function addresses(value) {
    return [
        ...new Set(
            (Array.isArray(value) ? value : String(value || "").split(/[,;\n]+/))
                .map(address =>
                    String(address || "")
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
        )
    ]
}
function output(p, authorized = null) {
    const scope = authorized || lib.readInvoice(p),
        record = scope.record
    const template = p.template || lib.policy.preference(scope.organizationPartyId).invoiceDocumentTemplate || "standard"
    if (template !== "standard") denied("DOCUMENT_TEMPLATE_INVALID", "Choose an approved invoice layout")
    const names = lib.partyNames([record.fromPartyId, record.toPartyId])
    const issuerPartyId = scope.receivable ? scope.organizationPartyId : record.fromPartyId
    const recipientPartyId = scope.receivable ? scope.partyId : record.toPartyId
    const totals = lib.totals(record),
        amount = value => esc(ec.l10n.formatCurrency(value, record.currencyUomId))
    const lines = Array.from(
        find("mantle.account.invoice.InvoiceItem", {invoiceId: record.invoiceId}).orderBy("invoiceItemSeqId").list()
    )
    const row = (name, value) =>
        value == null || value === "" ? "" : "<tr><th>" + esc(name) + "</th><td>" + esc(value) + "</td></tr>"
    const footer = lib.policy.preference(scope.organizationPartyId).documentFooter || ""
    const printHtml =
        '<!doctype html><html><head><meta charset="utf-8"><style>' +
        "@page{size:A4;margin:18mm}body{font:11pt sans-serif;color:#20252b}h1{font-size:22pt}table{border-collapse:collapse;width:100%}" +
        "td,th{padding:7px;text-align:left;vertical-align:top}thead{display:table-header-group}tbody tr{break-inside:avoid}" +
        ".lines td,.lines th{border-bottom:1px solid #ddd}.amount{text-align:right;white-space:nowrap}footer{margin-top:24px;font-size:9pt}" +
        "</style></head><body><h1>" +
        (record.invoiceTypeEnumId === "InvoiceCreditMemo" ? "Credit memo " : "Invoice ") +
        esc(record.invoiceId) +
        "</h1>" +
        "<p><strong>" +
        esc(names[issuerPartyId]) +
        "</strong></p><p>Bill to: " +
        esc(names[recipientPartyId]) +
        "</p><table>" +
        row(
            "Date",
            record.accountingDate ? lib.policy.calendarDateText(record.accountingDate) : lib.policy.dateText(record.invoiceDate)
        ) +
        row("Due", lib.policy.dateText(record.dueDate)) +
        row("Reference", record.referenceNumber) +
        row("Description", record.description) +
        "</table>" +
        '<table class="lines"><thead><tr><th>Line</th><th>Description</th><th class="amount">Quantity</th><th class="amount">Price</th><th class="amount">Amount</th></tr></thead><tbody>' +
        lines
            .map(
                line =>
                    "<tr><td>" +
                    esc(line.invoiceItemSeqId) +
                    "</td><td>" +
                    esc(line.description || line.productId || line.itemTypeEnumId) +
                    '</td><td class="amount">' +
                    esc(String(line.quantity ?? 1)) +
                    '</td><td class="amount">' +
                    amount(line.amount || 0) +
                    '</td><td class="amount">' +
                    amount(
                        ec.l10n.roundCurrency(toDecimal(line.quantity ?? 1).multiply(line.amount ?? 0), record.currencyUomId)
                    ) +
                    "</td></tr>"
            )
            .join("") +
        '</tbody></table><p class="amount"><strong>Total ' +
        amount(totals.invoiceTotal) +
        "</strong></p>" +
        "<p>" +
        esc(record.invoiceMessage || "").replace(/\n/g, "<br>") +
        "</p><footer>" +
        esc(footer) +
        "</footer></body></html>"
    const sourceVersion = lib.fingerprint(record)
    const summaryText =
        "Invoice " +
        record.invoiceId +
        " from " +
        names[issuerPartyId] +
        " to " +
        names[recipientPartyId] +
        "\n" +
        lines
            .map(
                line =>
                    String(line.description || line.itemTypeEnumId) +
                    " · " +
                    String(line.quantity ?? 1) +
                    " × " +
                    String(line.amount || 0)
            )
            .join("\n") +
        "\nTotal " +
        ec.l10n.formatCurrency(totals.invoiceTotal, record.currencyUomId)
    const result = {printHtml, summaryText, fromName: names[issuerPartyId], sourceVersion, contentHash: lib.hash(printHtml)}
    if (p.asPdf) {
        const bytes = ec.resource.xslFoTransform(printHtml, null, null, "application/pdf")
        const location =
            "dbresource://mantle/content/invoice-output/" + record.invoiceId + "/" + result.contentHash.slice(0, 32) + ".pdf"
        ec.resource.getLocationReference(location).putBytes(bytes)
        result.contentLocation = location
    }
    return result
}
function account(p) {
    return lib.emailAccount(p)
}
function prepare(p) {
    let scope = lib.writeInvoice(p)
    if (!scope.receivable) denied("INVOICE_DIRECTION_INVALID", "Only a customer invoice is sent here")
    const record = scope.record
    if (
        ![
            "InvoiceInProcess",
            "InvoiceIncoming",
            "InvoiceReceived",
            "InvoiceApproved",
            "InvoiceFinalized",
            "InvoiceSent",
            "InvoiceAcked"
        ].includes(record.statusId)
    )
        denied("INVOICE_SEND_STATE_INVALID", "This invoice cannot be sent now")
    const recipients = addresses(p.toAddresses || contacts(scope.partyId))
    if (!recipients.length) denied("RECIPIENT_REQUIRED", "Choose at least one invoice recipient")
    if (recipients.length > 100) denied("RECIPIENT_LIMIT", "Send to at most 100 recipients at once")
    const selectedAttachments = attachments.selection(p)
    const request = {
        invoiceId: record.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        recipients,
        note: p.note || null,
        template: p.template || "standard",
        emailTemplateId: p.emailTemplateId || null,
        emailAccountId: p.emailAccountId || null,
        printHash: p.printHtml ? lib.hash(p.printHtml) : null,
        subject: p.subject || null,
        summaryText: p.summaryText || null,
        resend: !!p.resend,
        attachmentContentIdList: selectedAttachments.ids,
        attachmentVersions: selectedAttachments.versions
    }
    const operation = lib.operation(p, "InvoiceSend", scope.organizationPartyId, request)
    if (operation.old) {
        const delivery = one(D, {deliveryId: operation.old.resultId})
        if (!delivery) denied("DELIVERY_UNAVAILABLE", "The stored delivery is not available")
        return {deliveryId: delivery.deliveryId, alreadyApplied: true}
    }
    if (p.lastUpdatedStamp != null) lib.revision(record, p.lastUpdatedStamp)
    else if (!p.sourceVersion) denied("STALE_REVISION", "Review the current invoice before sending")
    if (p.sourceVersion && p.sourceVersion !== lib.fingerprint(record))
        denied("STALE_PREVIEW", "Invoice changed; review it before sending")
    const emailAccountId = account(Object.assign({}, p, {organizationPartyId: scope.organizationPartyId}))
    const sourceVersion = lib.fingerprint(record)
    // Persist intent before finalization so its after-commit store notice sees this exact source version.
    const deliveryId = "invs-" + ec.user.randomString(24)
    const attachmentManifest = attachments.freeze(scope, selectedAttachments, deliveryId)
    const attachmentIdentity = attachmentManifest.length
        ? lib.hash(attachmentManifest.map(row => [row.invoiceContentId, row.attachmentVersion]))
        : null
    const rendered = output(p, scope)
    // HTML is an inert document supplied by a trusted application wrapper, never a screen/service name to execute.
    const printHtml = p.printHtml || rendered.printHtml
    if (/<script\b|\bon\w+\s*=|<iframe\b|<object\b|<embed\b|javascript\s*:/i.test(printHtml))
        denied("DOCUMENT_HTML_UNSAFE", "An invoice print cannot contain active content")
    const pdf = ec.resource.xslFoTransform(printHtml, null, null, "application/pdf")
    const contentHash = lib.hash(printHtml)
    const location =
        "dbresource://mantle/content/invoice-issued/" +
        record.invoiceId +
        "/" +
        deliveryId +
        "/Invoice-" +
        record.invoiceId +
        ".pdf"
    ec.resource.getLocationReference(location).putBytes(pdf)
    const content = call("create#mantle.account.invoice.InvoiceContent", {
        invoiceId: record.invoiceId,
        contentDate: ec.user.nowTimestamp,
        contentLocation: location,
        description: "Issued invoice " + record.invoiceId,
        isImmutable: "Y"
    })
    const subject = p.subject || "Invoice " + record.invoiceId + " from " + rendered.fromName
    const bodyText = [p.note || "", p.summaryText || rendered.summaryText].filter(Boolean).join("\n\n")
    call("create#" + D, {
        deliveryId,
        invoiceId: record.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        userId: ec.user.userId,
        operationKey: p.operationKey,
        sourceVersion,
        contentHash,
        invoiceContentId: content.invoiceContentId,
        contentLocation: location,
        sourceJson: JSON.stringify({
            invoice: mapRecord(record),
            emailAccountId,
            recipients,
            note: p.note || "",
            attachmentManifest
        }),
        printHtml,
        subject,
        bodyText,
        emailTemplateId: p.emailTemplateId || null,
        status: "preparing",
        createdDate: ec.user.nowTimestamp
    })
    if (["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived"].includes(record.statusId)) {
        call("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: record.invoiceId,
            organizationPartyId: scope.organizationPartyId,
            action: "finalize",
            lastUpdatedStamp: record.lastUpdatedStamp,
            changeReason: "Finalize invoice for delivery"
        })
        scope = lib.writeInvoice({invoiceId: record.invoiceId, organizationPartyId: scope.organizationPartyId})
    }
    for (const recipient of recipients) {
        let previous = null
        let priorDeliveryId = null
        if (!p.resend) {
            const claimId =
                "ic:" +
                lib
                    .hash(
                        attachmentIdentity
                            ? [record.invoiceId, sourceVersion, attachmentIdentity, recipient]
                            : [record.invoiceId, sourceVersion, recipient]
                    )
                    .slice(0, 37)
            const claim = one("mantle.account.invoice.InvoiceDeliveryClaim", {claimId})
            if (claim) {
                priorDeliveryId = claim.deliveryId
                previous = one(R, {deliveryId: claim.deliveryId, recipient})
            } else call("create#mantle.account.invoice.InvoiceDeliveryClaim", {claimId, deliveryId, recipient})
        }
        call("create#" + R, {
            deliveryId,
            recipient,
            priorDeliveryId,
            status: priorDeliveryId
                ? ["sent", "queued", "failed"].includes(previous?.status)
                    ? previous.status
                    : "pending"
                : "ready",
            emailMessageId: previous?.emailMessageId || null,
            reasonCode: priorDeliveryId ? "ALREADY_HANDLED" : null
        })
    }
    call("update#" + D, {deliveryId, status: "ready"})
    call("create#" + lib.operationEntity, {
        operationKey: p.operationKey,
        operationType: "InvoiceSend",
        organizationPartyId: scope.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestHash: operation.requestHash,
        status: "pending",
        resultEntityName: D,
        resultId: deliveryId
    })
    return {deliveryId, alreadyApplied: false}
}
function mapRecord(record) {
    return lib.map(record)
}
function recipient(p) {
    const delivery = one(D, {deliveryId: p.deliveryId})
    if (!delivery) denied("DELIVERY_UNAVAILABLE", "Invoice delivery is not available")
    lib.writeInvoice({invoiceId: delivery.invoiceId, organizationPartyId: delivery.organizationPartyId})
    if (delivery.userId !== ec.user.userId) denied("DELIVERY_DENIED", "Invoice delivery belongs to another user")
    const row = find(R, {deliveryId: p.deliveryId, recipient: p.recipient}).forUpdate(true).one()
    if (!row) denied("RECIPIENT_UNAVAILABLE", "Delivery recipient is not available")
    if (row.status !== "ready") return display(row)
    let status = "failed",
        reasonCode = "DELIVERY_FAILED",
        errorMessage = null,
        emailMessageId = null
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(row.recipient)) {
        reasonCode = "RECIPIENT_INVALID"
        errorMessage = "Invalid recipient address"
    } else {
        const source = JSON.parse(delivery.sourceJson)
        // Account access is checked by both native mail services; financial authority does not confer mail authority.
        const saved = call("org.moqui.impl.EmailClientServices.save#Draft", {
            emailAccountId: source.emailAccountId,
            toAddresses: row.recipient,
            subject: delivery.subject,
            body: (source.note ? "<p>" + esc(source.note).replace(/\n/g, "<br>") + "</p>" : "") + delivery.printHtml,
            bodyText: delivery.bodyText,
            attachmentList: [
                {
                    attachmentLocation: delivery.contentLocation,
                    fileName: "Invoice-" + delivery.invoiceId + ".pdf",
                    contentType: "application/pdf"
                },
                ...(source.attachmentManifest || []).map(item => ({
                    attachmentLocation: item.attachmentLocation,
                    fileName: item.fileName,
                    contentType: item.contentType
                }))
            ]
        })
        emailMessageId = saved.emailMessageId
        if (delivery.emailTemplateId) {
            if (!one("moqui.basic.email.EmailTemplate", {emailTemplateId: delivery.emailTemplateId}))
                denied("EMAIL_TEMPLATE_INVALID", "The approved email template is not available")
            call("update#moqui.basic.email.EmailMessage", {emailMessageId, emailTemplateId: delivery.emailTemplateId})
        }
        const sent = call("mantle.party.CommunicationServices.send#EmailDraft", {
            emailMessageId,
            recordEntityName: I,
            recordId: delivery.invoiceId
        })
        const accepted = ["ES_READY", "ES_SCHEDULED", "ES_SENT"].includes(sent.statusId)
        status = sent.sent ? "sent" : accepted ? "queued" : "failed"
        reasonCode = sent.sent ? "SENT" : accepted ? (sent.sendError ? "QUEUED_WITH_ERROR" : "QUEUED") : "DELIVERY_FAILED"
        errorMessage = sent.sendError || null
    }
    call("update#" + R, {
        deliveryId: p.deliveryId,
        recipient: row.recipient,
        emailMessageId,
        status,
        reasonCode,
        errorMessage,
        attemptDate: ec.user.nowTimestamp
    })
    if (errorMessage) ec.logger.error("Invoice " + delivery.invoiceId + " recipient " + row.recipient + ": " + errorMessage)
    return {recipient: row.recipient, emailMessageId, status, reasonCode, errorMessage}
}
function failure(p) {
    const delivery = one(D, {deliveryId: p.deliveryId})
    if (!delivery || delivery.userId !== ec.user.userId) denied("DELIVERY_DENIED", "Invoice delivery is not available")
    lib.writeInvoice({invoiceId: delivery.invoiceId, organizationPartyId: delivery.organizationPartyId})
    const existing = one(R, {deliveryId: p.deliveryId, recipient: p.recipient})
    if (!existing || existing.status !== "ready") return {}
    call("update#" + R, {
        deliveryId: p.deliveryId,
        recipient: p.recipient,
        status: "failed",
        reasonCode: "DELIVERY_FAILED",
        errorMessage: String(p.errorMessage || "Delivery failed").slice(0, 3000),
        attemptDate: ec.user.nowTimestamp
    })
    return {}
}
function finish(p) {
    const delivery = find(D, {deliveryId: p.deliveryId}).forUpdate(true).one()
    if (!delivery || delivery.userId !== ec.user.userId) denied("DELIVERY_DENIED", "Invoice delivery is not available")
    const scope = lib.writeInvoice({invoiceId: delivery.invoiceId, organizationPartyId: delivery.organizationPartyId})
    const recipientResults = rows(R, {deliveryId: p.deliveryId}).map(row => {
        if (!row.priorDeliveryId) return display(row)
        const canonical = one(R, {deliveryId: row.priorDeliveryId, recipient: row.recipient})
        return Object.assign(display(row), {
            status: ["sent", "queued", "failed"].includes(canonical?.status) ? canonical.status : "pending",
            emailMessageId: canonical?.emailMessageId || null,
            errorMessage: canonical?.errorMessage || null
        })
    })
    const successCount = recipientResults.filter(row => ["sent", "queued"].includes(row.status)).length
    const pendingCount = recipientResults.filter(row => ["pending", "ready"].includes(row.status)).length
    const failureCount = recipientResults.length - successCount - pendingCount
    const status = pendingCount ? "pending" : !successCount ? "failed" : failureCount ? "partial" : "complete"
    const result = {
        deliveryId: p.deliveryId,
        invoiceId: delivery.invoiceId,
        invoiceContentId: delivery.invoiceContentId,
        sourceVersion: delivery.sourceVersion,
        contentHash: delivery.contentHash,
        attachmentRows: attachments.manifestInfo(delivery),
        recipientResults,
        successCount,
        failureCount,
        pendingCount,
        statusId: scope.record.statusId,
        alreadyApplied: false
    }
    call("update#" + D, {deliveryId: p.deliveryId, status})
    if (successCount && scope.record.statusId === "InvoiceFinalized") {
        call("update#" + I, {invoiceId: delivery.invoiceId, statusId: "InvoiceSent"})
        result.statusId = one(I, {invoiceId: delivery.invoiceId}).statusId
    }
    call("update#" + D, {deliveryId: p.deliveryId, resultJson: JSON.stringify(result)})
    call("update#" + lib.operationEntity, {
        operationKey: delivery.operationKey,
        status: pendingCount ? "pending" : "complete",
        completedDate: pendingCount ? null : ec.user.nowTimestamp,
        resultJson: JSON.stringify(result)
    })
    return result
}
function send(p) {
    const prepared = lib.probe("mantle.account.InvoiceServices.prepare#InvoiceDelivery", p)
    const delivery = one(D, {deliveryId: prepared.deliveryId})
    if (prepared.alreadyApplied && ["complete", "partial", "failed"].includes(delivery.status))
        return Object.assign(JSON.parse(delivery.resultJson || "{}"), {alreadyApplied: true})
    for (const row of rows(R, {deliveryId: prepared.deliveryId})) {
        if (row.status !== "ready") continue
        try {
            lib.probe("mantle.account.InvoiceServices.deliver#InvoiceRecipient", {
                deliveryId: prepared.deliveryId,
                recipient: row.recipient
            })
        } catch (error) {
            ec.logger.error("Invoice " + delivery.invoiceId + " recipient " + row.recipient + ": " + error.message)
            try {
                lib.probe("mantle.account.InvoiceServices.record#InvoiceDeliveryFailure", {
                    deliveryId: prepared.deliveryId,
                    recipient: row.recipient,
                    errorMessage: error.message
                })
            } catch (recordError) {
                ec.logger.error("Invoice delivery " + prepared.deliveryId + " failure record: " + recordError.message)
            }
        }
    }
    return lib.probe("mantle.account.InvoiceServices.finish#InvoiceDelivery", {deliveryId: prepared.deliveryId})
}
function autoEmail(p) {
    const record = one(I, {invoiceId: p.invoiceId})
    if (!record) return {sendAllowed: false}
    return {sendAllowed: !find(D, {invoiceId: p.invoiceId, sourceVersion: lib.fingerprint(record)}).count()}
}
function checkAutoEmail(p) {
    lib.readInvoice(p)
    return autoEmail(p)
}
function batch(p) {
    lib.requirePermission("RECEIVABLE_EDIT")
    const ids = [...new Set(Array.from(p.invoiceIdList || []))]
    if (!ids.length || ids.length > 500) denied("BATCH_SELECTION_INVALID", "Select between one and 500 invoices")
    if (!p.operationKey || String(p.operationKey).length > 40)
        denied("OPERATION_KEY_REQUIRED", "A batch operation key is required")
    const begun = lib.probe("mantle.account.InvoiceServices.prepare#InvoiceBatch", p)
    if (begun.complete) return Object.assign(begun.result, {alreadyApplied: true})
    const results = []
    for (const invoiceId of ids) {
        const parameters = Object.assign({}, p, {
            invoiceId,
            attachmentContentIdList: p.attachmentSelectionsByInvoice?.[invoiceId]?.attachmentContentIdList || [],
            attachmentVersions: p.attachmentSelectionsByInvoice?.[invoiceId]?.attachmentVersions || {},
            operationKey: "ib:" + lib.hash([p.operationKey, invoiceId, p.action || "send"]).slice(0, 37)
        })
        try {
            const selected = lib.writeInvoice(parameters, false)
            if (p.action !== "print") {
                if (p.sourceVersions?.[invoiceId] == null)
                    denied("STALE_REVISION", "Review every selected invoice before processing the batch")
                parameters.lastUpdatedStamp = p.sourceVersions[invoiceId]
                lib.revision(selected.record, parameters.lastUpdatedStamp)
            }
            const result =
                p.action === "finalize"
                    ? lib.probe(
                          "mantle.account.InvoiceServices.change#InvoiceState",
                          Object.assign(parameters, {action: "finalize"})
                      )
                    : p.action === "print"
                      ? lib.probe("mantle.account.InvoiceServices.get#InvoiceOutput", Object.assign(parameters, {asPdf: true}))
                      : !p.action || p.action === "send"
                        ? send(parameters)
                        : denied("BATCH_ACTION_INVALID", "Choose send, finalize or print")
            results.push({invoiceId, success: !result.failureCount, result})
        } catch (error) {
            ec.logger.error("Invoice batch " + invoiceId + ": " + error.message)
            results.push({
                invoiceId,
                success: false,
                reasonCode: String(error.message).split(":")[0],
                errorMessage: error.message
            })
        }
    }
    const result = {
        results,
        successCount: results.filter(row => row.success).length,
        failureCount: results.filter(row => !row.success).length
    }
    lib.probe("mantle.account.InvoiceServices.finish#InvoiceBatch", Object.assign({}, p, {result}))
    return result
}
function batchPrepare(p) {
    const org = lib.organization(p.organizationPartyId, "RECEIVABLE_EDIT", true)
    const ids = [...new Set(Array.from(p.invoiceIdList || []))]
    const attachmentSelectionsByInvoice = Object.fromEntries(
        ids
            .map(id => {
                const selected = attachments.selection(p.attachmentSelectionsByInvoice?.[id] || {}, false)
                return [id, {attachmentContentIdList: selected.ids, attachmentVersions: selected.versions}]
            })
            .filter(([, selected]) => selected.attachmentContentIdList.length)
    )
    const operation = lib.operation(p, "InvoiceBatch", org, {
        invoiceIdList: ids,
        action: p.action || "send",
        template: p.template || "standard",
        emailAccountId: p.emailAccountId || null,
        toAddresses: p.toAddresses || null,
        sourceVersions: p.sourceVersions || null,
        attachmentSelectionsByInvoice
    })
    if (operation.old)
        return {
            complete: operation.old.status === "complete",
            result: operation.old.resultJson ? JSON.parse(operation.old.resultJson) : {}
        }
    call("create#" + lib.operationEntity, {
        operationKey: p.operationKey,
        operationType: "InvoiceBatch",
        organizationPartyId: org,
        userId: ec.user.userId,
        requestHash: operation.requestHash,
        submittedDate: ec.user.nowTimestamp,
        status: "pending"
    })
    return {complete: false}
}
function batchFinish(p) {
    const old = one(lib.operationEntity, {operationKey: p.operationKey})
    if (!old || old.operationType !== "InvoiceBatch" || old.userId !== ec.user.userId)
        denied("BATCH_UNAVAILABLE", "The invoice batch is not available")
    lib.organization(old.organizationPartyId, "RECEIVABLE_EDIT", true)
    call("update#" + lib.operationEntity, {
        operationKey: p.operationKey,
        status: "complete",
        completedDate: ec.user.nowTimestamp,
        resultJson: JSON.stringify(p.result)
    })
    return {}
}
const operations = {
    output,
    prepare,
    recipient,
    failure,
    finish,
    send,
    autoEmail,
    checkAutoEmail,
    batch,
    batchPrepare,
    batchFinish
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown invoice delivery operation " + op)
        return operations[op](parameters)
    }
})
