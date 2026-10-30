// Guarded invoice states, draft editing, source billing and finance reads.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, display, map, ms, denied, has} = lib
const I = lib.invoiceEntity
const E = "mantle.account.invoice.InvoiceItem"
const T = "mantle.ledger.transaction.AcctgTrans"
const draftStatuses = ["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived"]

function requireDraft(scope) {
    if (!draftStatuses.includes(scope.record.statusId)) denied("INVOICE_NOT_DRAFT", "Only a draft invoice can be edited")
    if (find(T, {invoiceId: scope.record.invoiceId, isPosted: "Y"}).count())
        denied("INVOICE_POSTED", "Correct a posted invoice with a linked credit")
}
function creditCap(scope) {
    if (!scope.record.creditForInvoiceId) return
    const source = lib.invoice(
        {invoiceId: scope.record.creditForInvoiceId, organizationPartyId: scope.organizationPartyId},
        null,
        true
    )
    const credits = rows(I, {creditForInvoiceId: source.record.invoiceId}).filter(row => row.statusId !== "InvoiceCancelled")
    const totals = lib.totalsMany(credits)
    const amount = credits.reduce((sum, row) => sum.add(totals[row.invoiceId].invoiceTotal), toDecimal(0))
    if (amount.compare(lib.totals(source.record).invoiceTotal) > 0)
        denied("CREDIT_EXCEEDS_INVOICE", "Credits cannot exceed the original invoice total")
}
function period(scope) {
    if (scope.record.invoiceDate == null) denied("INVOICE_DATE_REQUIRED", "Choose an invoice date")
    const preference = lib.policy.preference(scope.organizationPartyId)
    if (preference.postingGuardEnabled !== "Y") return
    const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
    const date = scope.record.accountingDate
        ? lib.policy.calendarDateText(scope.record.accountingDate)
        : ec.l10n.format(scope.record.invoiceDate, "yyyy-MM-dd")
    const checked = guard.fiscal(
        scope.organizationPartyId,
        scope.record.invoiceDate,
        true,
        [],
        scope.record.accountingDate ? date : null
    )
    if (checked.findings.length) denied(checked.findings[0].code, checked.findings.map(row => row.message).join("; "))
    const lockScopes = ["all", scope.receivable ? "sales" : "purchases"]
    for (const lock of find("mantle.ledger.config.AccountingLock", {organizationPartyId: scope.organizationPartyId})
        .condition("lockScope", "in", lockScopes)
        .forUpdate(true)
        .list()) {
        const lockDay = lib.policy.calendarDateText(lock.lockThroughDate)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(lockDay)) denied("LOCK_DATE_INVALID", "The accounting lock has an invalid date")
        if (date > lockDay) continue
        const exceptions =
            lock.isHard === "Y"
                ? []
                : rows("mantle.ledger.config.AccountingLockException", {accountingLockId: lock.accountingLockId})
        const allowed = exceptions.some(
            row =>
                lib.policy.active(row) &&
                row.organizationPartyId === scope.organizationPartyId &&
                (row.userId === ec.user.userId || (row.userGroupId && ec.user.isInGroup(row.userGroupId))) &&
                !row.acctgTransId &&
                row.lockScope === lock.lockScope
        )
        if (!allowed) denied(lock.isHard === "Y" ? "HARD_LOCK" : "SOFT_LOCK", "Invoice date is protected by an accounting lock")
    }
}
function hold(scope) {
    // The hold policy and its model are installed together by payables; unadopted organizations retain legacy behavior.
    if (lib.policy.preference(scope.organizationPartyId).invoiceHoldGuardEnabled === "Y") {
        const open = find("mantle.account.invoice.InvoiceHold", {invoiceId: scope.record.invoiceId})
            .condition("releasedDate", "is-null", null)
            .limit(1)
            .list()
        if (open.length) denied("INVOICE_HELD", "The invoice has an open hold")
    }
}
function approve(scope) {
    lib.requirePermission("INVOICE_APPROVE")
    const original = scope.record
    const selfApproved = original.draftedByUserId === ec.user.userId
    if (selfApproved && lib.policy.preference(scope.organizationPartyId).allowAccountingSelfApproval !== "Y")
        denied("SELF_APPROVAL_DENIED", "Another finance approver must approve this invoice")
    call("update#" + I, {
        invoiceId: original.invoiceId,
        approvedByUserId: ec.user.userId,
        approvedDate: ec.user.nowTimestamp,
        approvedSourceVersion: lib.fingerprint(original),
        isSelfApproved: selfApproved ? "Y" : "N"
    })
}
function changeState(p) {
    const requestedAction =
        p.action ||
        {
            InvoiceFinalized: "finalize",
            InvoiceApproved: "approve",
            InvoiceCancelled: "cancel",
            InvoiceInProcess: "resume",
            InvoiceReceived: "receive",
            InvoiceSent: "sent"
        }[p.statusId]
    const scope = requestedAction === "approve" ? lib.invoice(p, "INVOICE_APPROVE", true) : lib.writeInvoice(p)
    const record = scope.record
    const action =
        p.action ||
        {
            InvoiceFinalized: "finalize",
            InvoiceApproved: "approve",
            InvoiceCancelled: "cancel",
            InvoiceInProcess: "resume",
            InvoiceReceived: "receive",
            InvoiceSent: "sent"
        }[p.statusId]
    if (!action) denied("STATE_ACTION_INVALID", "Choose an invoice action")
    const request = {
        invoiceId: record.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        action,
        lastUpdatedStamp: p.lastUpdatedStamp == null ? null : String(p.lastUpdatedStamp),
        changeReason: p.changeReason || null
    }
    const operation = p.operationKey && lib.operation(p, "InvoiceState", scope.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (p.lastUpdatedStamp != null) lib.revision(record, p.lastUpdatedStamp)
    else if (!p.sourceVersion || p.sourceVersion !== lib.fingerprint(record))
        denied("STALE_REVISION", "Review the current invoice before changing its state")
    if (action !== "sent") period(scope)
    let target
    if (["approve", "finalize"].includes(action)) {
        if (!draftStatuses.includes(record.statusId)) denied("STATE_TRANSITION_INVALID", "This invoice cannot be finalized now")
        if (!find(E, {invoiceId: record.invoiceId}).count()) denied("INVOICE_EMPTY", "An invoice needs at least one line")
        const totals = lib.totals(record)
        if (totals.invoiceTotal.compare(0) < 0) denied("INVOICE_NEGATIVE", "Reverse a negative draft before finalizing")
        hold(scope)
        creditCap(scope)
        const preference = lib.policy.preference(scope.organizationPartyId)
        if (preference.singleCurrencyDocumentsOnly === "Y" && record.currencyUomId !== preference.baseCurrencyUomId)
            denied("FOREIGN_CURRENCY_DISABLED", "The invoice currency must match the organization's base currency")
        if (action === "approve" || !scope.receivable) approve(scope)
        else if (
            preference.invoiceApprovalRequired === "Y" &&
            (!record.approvedByUserId || record.approvedSourceVersion !== lib.fingerprint(record))
        )
            denied("APPROVAL_REQUIRED", "A finance approver must approve this version before it is finalized")
        target = scope.receivable ? "InvoiceFinalized" : "InvoiceApproved"
    } else if (action === "resume" || action === "cancel") {
        if (lib.totals(record).appliedPayments.compare(0) !== 0)
            denied("INVOICE_APPLIED", "Unapply the invoice before changing its state")
        if (
            lib.policy.preference(scope.organizationPartyId).postingGuardEnabled === "Y" &&
            find(T, {invoiceId: record.invoiceId, isPosted: "Y"}).count()
        )
            denied("INVOICE_POSTED", "Correct a posted invoice with a linked credit")
        if (![...draftStatuses, "InvoiceFinalized", "InvoiceApproved", "InvoiceSent"].includes(record.statusId))
            denied("STATE_TRANSITION_INVALID", "This invoice cannot be changed that way now")
        if (!String(p.changeReason || "").trim()) denied("REASON_REQUIRED", "Give a reason for this invoice change")
        target =
            action === "cancel"
                ? "InvoiceCancelled"
                : record.fromPartyId === scope.organizationPartyId
                  ? "InvoiceInProcess"
                  : "InvoiceReceived"
    } else if (action === "receive") {
        if (record.statusId !== "InvoiceIncoming") denied("STATE_TRANSITION_INVALID", "Only an incoming invoice can be received")
        target = "InvoiceReceived"
    } else if (action === "sent") {
        if (record.statusId !== "InvoiceFinalized")
            denied("STATE_TRANSITION_INVALID", "Only a finalized invoice can be marked sent")
        if (
            !find("mantle.account.invoice.InvoiceDelivery", {invoiceId: record.invoiceId, sourceVersion: lib.fingerprint(record)})
                .condition("status", "in", ["complete", "partial"])
                .count()
        )
            denied("DELIVERY_REQUIRED", "Send this invoice before marking it sent")
        target = "InvoiceSent"
    } else denied("STATE_ACTION_INVALID", "Unknown invoice action")
    call("update#" + I, {
        invoiceId: record.invoiceId,
        statusId: target,
        statusId_changeReason: p.changeReason || "Invoice " + action
    })
    if (["approve", "finalize"].includes(action)) {
        const transactions = rows(T, {invoiceId: record.invoiceId, organizationPartyId: scope.organizationPartyId}).filter(
            row => !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId
        )
        const failed = transactions.find(row => row.isPosted !== "Y")
        if (failed)
            denied(
                failed.postingFailureCode || "INVOICE_POST_FAILED",
                failed.postingFailureMessage || "Invoice posting did not complete"
            )
        if (
            lib.policy.preference(scope.organizationPartyId).postingGuardEnabled === "Y" &&
            !transactions.length &&
            lib.totals(record).invoiceTotal.compare(0) > 0
        )
            denied("INVOICE_POST_FAILED", "Invoice finalization did not produce a posted ledger transaction")
    }
    const saved = one(I, {invoiceId: record.invoiceId})
    const result = {
        invoiceId: record.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        statusId: saved.statusId,
        lastUpdatedStamp: saved.lastUpdatedStamp,
        sourceVersion: lib.fingerprint(saved),
        reasonCode: "OK",
        alreadyApplied: false
    }
    if (operation) lib.complete(operation, I, record.invoiceId, result)
    return result
}
function storeDraft(p) {
    const scope = lib.writeInvoice(p)
    requireDraft(scope)
    lib.revision(scope.record, p.lastUpdatedStamp)
    const fields = {invoiceId: p.invoiceId}
    for (const field of ["invoiceDate", "dueDate", "settlementTermId", "referenceNumber", "description", "invoiceMessage"])
        if (Object.prototype.hasOwnProperty.call(p, field)) fields[field] = p[field] === "" ? null : p[field]
    if (Object.prototype.hasOwnProperty.call(fields, "invoiceDate")) {
        if (fields.invoiceDate == null) denied("INVOICE_DATE_REQUIRED", "Choose an invoice date")
        fields.accountingDate = ec.l10n.format(fields.invoiceDate, "yyyy-MM-dd")
    }
    if (fields.settlementTermId && !one("mantle.account.invoice.SettlementTerm", {settlementTermId: fields.settlementTermId}))
        denied("TERM_INVALID", "Choose an existing payment term")
    const dated = Object.assign({}, scope, {record: Object.assign(map(scope.record), fields)})
    period(dated)
    call("mantle.account.InvoiceServices.update#Invoice", fields)
    if (p.invoiceDate || Object.prototype.hasOwnProperty.call(p, "settlementTermId"))
        call("mantle.account.InvoiceServices.checkSet#InvoiceDueDate", {invoiceId: p.invoiceId, overrideExisting: true})
    const saved = one(I, {invoiceId: p.invoiceId})
    return {invoiceId: p.invoiceId, lastUpdatedStamp: saved.lastUpdatedStamp, sourceVersion: lib.fingerprint(saved)}
}
function storeItem(p) {
    const scope = lib.writeInvoice(p)
    requireDraft(scope)
    period(scope)
    const original = p.invoiceItemSeqId && one(E, {invoiceId: p.invoiceId, invoiceItemSeqId: p.invoiceItemSeqId})
    if (p.invoiceItemSeqId && !original) denied("LINE_UNAVAILABLE", "Invoice line is not available")
    if (original) lib.revision(original, p.lastUpdatedStamp)
    const typeId = p.itemTypeEnumId || original?.itemTypeEnumId
    if (!one("moqui.basic.Enumeration", {enumId: typeId, enumTypeId: "ItemType"}))
        denied("LINE_TYPE_INVALID", "Choose an invoice item type")
    if (p.productId && !one("mantle.product.Product", {productId: p.productId}))
        denied("PRODUCT_UNAVAILABLE", "Product is not available")
    const quantity = toDecimal(p.quantity ?? original?.quantity ?? 1)
    const amount = ec.l10n.roundCurrency(toDecimal(p.amount ?? original?.amount ?? 0), scope.record.currencyUomId)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Enter a positive quantity")
    const fields = {invoiceId: p.invoiceId, invoiceItemSeqId: p.invoiceItemSeqId, itemTypeEnumId: typeId, quantity, amount}
    for (const field of ["productId", "description", "itemDate"]) if (p[field] !== undefined) fields[field] = p[field] || null
    if (scope.receivable && scope.record.invoiceTypeEnumId === "InvoiceCreditMemo") {
        fields.overrideGlAccountId =
            original?.overrideGlAccountId ||
            call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                organizationPartyId: scope.organizationPartyId,
                otherPartyId: scope.partyId,
                itemTypeEnumId: typeId,
                productId: p.productId || original?.productId,
                direction: "O"
            }).glAccountId
        if (!fields.overrideGlAccountId) denied("CREDIT_ACCOUNT_MISSING", "Choose an item with an outgoing sales account")
    }
    const result = call("mantle.account.InvoiceServices." + (original ? "update" : "create") + "#InvoiceItem", fields)
    call("update#" + I, {invoiceId: p.invoiceId, approvedSourceVersion: null})
    creditCap(scope)
    return {
        invoiceId: p.invoiceId,
        invoiceItemSeqId: result.invoiceItemSeqId || p.invoiceItemSeqId,
        lastUpdatedStamp: one(I, {invoiceId: p.invoiceId}).lastUpdatedStamp
    }
}
function deleteItem(p) {
    const scope = lib.writeInvoice(p)
    requireDraft(scope)
    period(scope)
    const item = one(E, {invoiceId: p.invoiceId, invoiceItemSeqId: p.invoiceItemSeqId})
    if (!item) denied("LINE_UNAVAILABLE", "Invoice line is not available")
    lib.revision(item, p.lastUpdatedStamp)
    call("mantle.account.InvoiceServices.delete#InvoiceItem", {invoiceId: p.invoiceId, invoiceItemSeqId: p.invoiceItemSeqId})
    call("update#" + I, {invoiceId: p.invoiceId, approvedSourceVersion: null})
    creditCap(scope)
    return {invoiceId: p.invoiceId, lastUpdatedStamp: one(I, {invoiceId: p.invoiceId}).lastUpdatedStamp}
}
function detail(p) {
    const scope = lib.readInvoice(p),
        record = scope.record
    const names = lib.partyNames([record.fromPartyId, record.toPartyId])
    const invoice = Object.assign(lib.invoiceDisplay(record), {
        fromName: names[record.fromPartyId],
        toName: names[record.toPartyId],
        organizationPartyId: scope.organizationPartyId,
        sourceVersion: lib.fingerprint(record),
        statusDescription: one("moqui.basic.StatusItem", {statusId: record.statusId})?.description || record.statusId
    })
    const canEdit = has(scope.permission)
    const canReadLedger =
        lib.access.systemAdmin() || has("ACCOUNTING_VIEW") || has("ACCOUNTING_GL_POST") || has("ACCOUNTING_ADMIN")
    const posted = find(T, {invoiceId: p.invoiceId, isPosted: "Y"}).count() > 0
    const totals = lib.totals(record)
    const canChangeExistingState =
        canEdit &&
        totals.appliedPayments.isZero() &&
        !(posted && lib.policy.preference(scope.organizationPartyId).postingGuardEnabled === "Y") &&
        [...draftStatuses, "InvoiceFinalized", "InvoiceApproved", "InvoiceSent"].includes(record.statusId)
    const capabilities = {
        canDraftEdit: canEdit && draftStatuses.includes(record.statusId) && !posted,
        canApprove: has("INVOICE_APPROVE") && draftStatuses.includes(record.statusId),
        canFinalize:
            canEdit &&
            draftStatuses.includes(record.statusId) &&
            lib.policy.preference(scope.organizationPartyId).invoiceApprovalRequired !== "Y",
        canSend:
            canEdit &&
            scope.receivable &&
            ["InvoiceInProcess", "InvoiceFinalized", "InvoiceSent", "InvoiceAcked"].includes(record.statusId),
        canCredit: canEdit && !draftStatuses.includes(record.statusId) && record.statusId !== "InvoiceCancelled",
        canCancel: canChangeExistingState,
        canResume: canChangeExistingState && !draftStatuses.includes(record.statusId),
        canReverse:
            canEdit &&
            scope.receivable &&
            record.statusId === "InvoiceInProcess" &&
            !record.creditForInvoiceId &&
            totals.invoiceTotal.compare(0) < 0 &&
            !posted &&
            totals.appliedPayments.compare(0) === 0
    }
    const applications = find("mantle.account.payment.PaymentApplication")
        .condition(
            ec.entity.conditionFactory.makeCondition(
                [
                    ec.entity.conditionFactory.makeCondition("invoiceId", "equals", p.invoiceId),
                    ec.entity.conditionFactory.makeCondition("toInvoiceId", "equals", p.invoiceId)
                ],
                "or"
            )
        )
        .orderBy("appliedDate,paymentApplicationId")
        .limit(500)
        .list()
    const sourceRows = Array.from(find("mantle.order.OrderItemBilling", {invoiceId: p.invoiceId}).limit(500).list()).map(display)
    const shipmentRows = Array.from(find("mantle.shipment.ShipmentItemSource", {invoiceId: p.invoiceId}).limit(500).list()).map(
        display
    )
    sourceRows.push(...shipmentRows)
    const ledgerRows = canReadLedger
        ? Array.from(
              find(T, {invoiceId: p.invoiceId, organizationPartyId: scope.organizationPartyId})
                  .orderBy("transactionDate,acctgTransId")
                  .limit(500)
                  .list()
          ).map(display)
        : []
    const auditRows = Array.from(
        find("moqui.entity.EntityAuditLog", {changedEntityName: I, pkPrimaryValue: p.invoiceId})
            .orderBy("-changedDate")
            .limit(200)
            .list()
    ).map(display)
    const lines = Array.from(find(E, {invoiceId: p.invoiceId}).orderBy("invoiceItemSeqId").limit(1000).list()).map(row => {
        const line = display(row)
        if (!canReadLedger) delete line.overrideGlAccountId
        line.itemTypeDescription =
            one("moqui.basic.Enumeration", {enumId: line.itemTypeEnumId})?.description || line.itemTypeEnumId
        line.lineTotal = ec.l10n.roundCurrency(toDecimal(row.quantity ?? 1).multiply(row.amount ?? 0), record.currencyUomId)
        return line
    })
    const deliveries = Array.from(
        find("mantle.account.invoice.InvoiceDelivery", {invoiceId: p.invoiceId}).orderBy("-createdDate").limit(100).list()
    )
    const recipients = deliveries.length
        ? Array.from(
              find("mantle.account.invoice.InvoiceDeliveryRecipient")
                  .condition(
                      "deliveryId",
                      "in",
                      deliveries.map(row => row.deliveryId)
                  )
                  .list()
          )
        : []
    const priorIds = [...new Set(recipients.map(row => row.priorDeliveryId).filter(Boolean))]
    const priorRecipients = priorIds.length
        ? Array.from(find("mantle.account.invoice.InvoiceDeliveryRecipient").condition("deliveryId", "in", priorIds).list())
        : []
    const contentRecords = Array.from(
        find("mantle.account.invoice.InvoiceContent", {invoiceId: p.invoiceId})
            .orderBy("-contentDate,invoiceContentId")
            .limit(101)
            .list()
    )
    const attachmentService = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceAttachments.js")
    const attachmentOptions =
        scope.receivable && canEdit ? attachmentService.project(scope, contentRecords) : {annotations: {}, incomplete: false}
    return {
        invoice,
        lines,
        paymentRows: Array.from(applications).map(row =>
            lib.policy.pick(display(row), [
                "paymentApplicationId",
                "paymentId",
                "invoiceId",
                "invoiceItemSeqId",
                "toInvoiceId",
                "amountApplied",
                "appliedDate",
                "appliedDateText"
            ])
        ),
        sourceRows,
        shipmentRows,
        budgetRows: [],
        budgetAvailable: false,
        budgetUnavailableReason: "Invoice budget links are not available in the current budget model",
        ledgerRows,
        auditRows,
        contentRows: contentRecords
            .slice(0, 100)
            .map(row =>
                Object.assign(display(row), {attachable: false}, attachmentOptions.annotations[row.invoiceContentId] || {})
            ),
        attachmentDiscoveryIncomplete: attachmentOptions.incomplete,
        deliveryRows: deliveries.map(row => ({
            deliveryId: row.deliveryId,
            createdDate: row.createdDate,
            createdDateText: lib.policy.dateText(row.createdDate),
            status: row.status,
            sourceVersion: row.sourceVersion,
            attachmentRows: attachmentService.manifestInfo(row),
            attachments: attachmentService.manifestInfo(row),
            issuedFileName: "Invoice-" + record.invoiceId + ".pdf",
            recipients: recipients
                .filter(item => item.deliveryId === row.deliveryId)
                .map(item => {
                    const resolved =
                        item.priorDeliveryId &&
                        priorRecipients.find(
                            prior => prior.deliveryId === item.priorDeliveryId && prior.recipient === item.recipient
                        )
                    return lib.policy.pick(lib.display(resolved || item), [
                        "recipient",
                        "status",
                        "reasonCode",
                        "errorMessage",
                        "emailMessageId"
                    ])
                })
        })),
        totals,
        capabilities
    }
}
function receivables(p) {
    if (!has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN")) lib.requirePermission("RECEIVABLE_VIEW")
    const organizationPartyId = lib.organization(p.organizationPartyId || lib.policy.access().activeOrganizationPartyId)
    const cf = ec.entity.conditionFactory
    let query = find("mantle.account.invoice.InvoiceFinance").condition(
        cf.makeCondition(
            [
                cf.makeCondition(
                    [
                        cf.makeCondition("fromPartyId", "equals", organizationPartyId),
                        cf.makeCondition("creditForInvoiceId", "is-null", null),
                        cf.makeCondition("financeDirection", "is-null", null)
                    ],
                    "and"
                ),
                cf.makeCondition(
                    [
                        cf.makeCondition("sourceFromPartyId", "equals", organizationPartyId),
                        cf.makeCondition("financeDirection", "is-null", null)
                    ],
                    "and"
                ),
                cf.makeCondition(
                    [
                        cf.makeCondition("financeOrganizationPartyId", "equals", organizationPartyId),
                        cf.makeCondition("financeDirection", "equals", "receivable")
                    ],
                    "and"
                )
            ],
            "or"
        )
    )
    if (!lib.access.systemAdmin())
        for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
            query = query.condition(
                cf.makeCondition(
                    [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)],
                    "or"
                )
            )
    if (p.customerPartyId)
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("toPartyId", "equals", p.customerPartyId),
                    cf.makeCondition("fromPartyId", "equals", p.customerPartyId)
                ],
                "or"
            )
        )
    if (p.recordId || p.invoiceId) query = query.condition("invoiceId", p.recordId || p.invoiceId)
    if (p.text)
        query = query.condition(
            cf.makeCondition(
                ["invoiceId", "description", "referenceNumber"].map(field =>
                    cf.makeCondition(field, "like", "%" + p.text + "%").ignoreCase()
                ),
                "or"
            )
        )
    if (p.statusId) query = query.condition("statusId", p.statusId)
    if (p.invoiceTypeEnumId) query = query.condition("invoiceTypeEnumId", p.invoiceTypeEnumId)
    if (p.currencyUomId) query = query.condition("currencyUomId", p.currencyUomId)
    for (const [input, field, op] of [
        ["fromDate", "invoiceDate", "greater-equals"],
        ["thruDate", "invoiceDate", "less"],
        ["dueFromDate", "dueDate", "greater-equals"],
        ["dueThruDate", "dueDate", "less"]
    ])
        if (p[input]) query = query.condition(field, op, p[input])
    const queue = p.queue || "all"
    if (queue === "draft") query = query.condition("statusId", "InvoiceInProcess")
    else if (queue === "credits") query = query.condition("invoiceTypeEnumId", "InvoiceCreditMemo")
    else if (["unpaid", "overdue"].includes(queue)) {
        query = query.condition("statusId", "in", ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked"])
        query = query.condition("unpaidTotal", "greater", 0)
        if (queue === "overdue") query = query.condition("dueDate", "less", ec.user.nowTimestamp)
    } else if (queue !== "all") denied("QUEUE_INVALID", "Unknown receivables queue")
    if (p._queryOnly) return query
    const count = receivables(Object.assign({}, p, {_queryOnly: true})).count()
    const result = lib.page(query.orderBy("-invoiceDate,invoiceId"), p, "records", count)
    const names = lib.partyNames(result.rows.flatMap(row => [row.toPartyId, row.fromPartyId]))
    const totals = lib.totalsMany(result.rows)
    result.rows = result.rows.map(row =>
        Object.assign(lib.invoiceDisplay(row), totals[row.invoiceId], {
            toName: names[row.toPartyId],
            fromName: names[row.fromPartyId],
            statusDescription: one("moqui.basic.StatusItem", {statusId: row.statusId})?.description || row.statusId
        })
    )
    result.records = result.rows
    result.counts = {}
    return result
}
function summary(p) {
    const query = receivables(Object.assign({}, p, {_queryOnly: true}))
    const totalCount = receivables(Object.assign({}, p, {_queryOnly: true})).count()
    if (totalCount > 10000)
        return {
            summaryRows: [],
            calendarRows: [],
            complete: false,
            incomplete: true,
            errors: [{reasonCode: "REPORT_SCOPE_TOO_LARGE", message: "Narrow the report filters to at most 10000 invoices"}]
        }
    const records = Array.from(query.orderBy("invoiceId").limit(10000).list())
    const names = lib.partyNames(records.flatMap(row => [row.toPartyId, row.fromPartyId]))
    const grouped = {},
        calendarRows = []
    const totals = lib.totalsMany(records)
    for (const record of records) {
        const customerPartyId = record.fromPartyId === p.organizationPartyId ? record.toPartyId : record.fromPartyId
        const key = JSON.stringify([customerPartyId, record.currencyUomId, record.statusId])
        const item =
            grouped[key] ||
            (grouped[key] = {
                customerPartyId,
                customerName: names[customerPartyId],
                statusId: record.statusId,
                statusDescription: one("moqui.basic.StatusItem", {statusId: record.statusId})?.description || record.statusId,
                currencyUomId: record.currencyUomId,
                invoiceCount: 0,
                invoiceTotal: toDecimal(0),
                unpaidTotal: toDecimal(0)
            })
        const values = totals[record.invoiceId]
        item.invoiceCount++
        const sign = record.invoiceTypeEnumId === "InvoiceCreditMemo" ? -1 : 1
        item.invoiceTotal = item.invoiceTotal.add(values.invoiceTotal.multiply(sign))
        item.unpaidTotal = item.unpaidTotal.add(values.unpaidTotal.multiply(sign))
        calendarRows.push(Object.assign(lib.invoiceDisplay(record), values, {customerName: names[customerPartyId]}))
    }
    return {summaryRows: Object.values(grouped), calendarRows, complete: true, incomplete: false, errors: []}
}
function createReceivable(p) {
    lib.organization(p.organizationPartyId, "RECEIVABLE_EDIT", true)
    const customer = one("mantle.party.Party", {partyId: p.customerPartyId})
    if (!customer || (customer.privateOwnerUserId && customer.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("CUSTOMER_UNAVAILABLE", "Choose an available customer")
    const type = p.invoiceTypeEnumId || "InvoiceSales"
    if (!["InvoiceSales", "InvoiceCreditMemo"].includes(type))
        denied("INVOICE_TYPE_INVALID", "Choose an invoice or customer credit")
    const currency = p.currencyUomId || lib.policy.preference(p.organizationPartyId).baseCurrencyUomId
    lib.policy.currency(currency)
    const fields = {
        fromPartyId: type === "InvoiceCreditMemo" ? p.customerPartyId : p.organizationPartyId,
        toPartyId: type === "InvoiceCreditMemo" ? p.organizationPartyId : p.customerPartyId,
        invoiceTypeEnumId: type,
        currencyUomId: currency,
        draftedByUserId: ec.user.userId,
        financeOrganizationPartyId: p.organizationPartyId,
        financeDirection: "receivable"
    }
    for (const key of ["invoiceDate", "dueDate", "settlementTermId", "referenceNumber", "description"])
        if (p[key] !== undefined) fields[key] = p[key] || null
    const made =
        type === "InvoiceCreditMemo"
            ? call(
                  "create#" + I,
                  Object.assign(fields, {
                      statusId: "InvoiceInProcess",
                      invoiceDate: fields.invoiceDate || ec.user.nowTimestamp,
                      accountingDate: ec.l10n.format(fields.invoiceDate || ec.user.nowTimestamp, "yyyy-MM-dd")
                  })
              )
            : call("mantle.account.InvoiceServices.create#Invoice", fields)
    if (type !== "InvoiceCreditMemo")
        call("update#" + I, {
            invoiceId: made.invoiceId,
            draftedByUserId: ec.user.userId,
            accountingDate: ec.l10n.format(fields.invoiceDate || ec.user.nowTimestamp, "yyyy-MM-dd")
        })
    return {invoiceId: made.invoiceId, lastUpdatedStamp: one(I, {invoiceId: made.invoiceId}).lastUpdatedStamp}
}
function credit(p) {
    const scope = lib.writeInvoice(p)
    if (draftStatuses.includes(scope.record.statusId) || scope.record.statusId === "InvoiceCancelled")
        denied("CREDIT_SOURCE_INVALID", "Finalize the source invoice before making a credit")
    const amount = ec.l10n.roundCurrency(toDecimal(p.creditAmount ?? p.amount ?? 0), scope.record.currencyUomId)
    if (amount.compare(0) <= 0) denied("CREDIT_AMOUNT_INVALID", "Enter a positive credit amount")
    const operation = lib.operation(p, "InvoiceCredit", scope.organizationPartyId, {
        invoiceId: p.invoiceId,
        amount: String(amount),
        description: p.description || null,
        changeReason: p.changeReason || null
    })
    if (operation.old) return lib.previous(operation)
    const issued = rows(I, {creditForInvoiceId: p.invoiceId})
        .filter(row => row.statusId !== "InvoiceCancelled")
        .reduce((sum, row) => sum.add(lib.totals(row).invoiceTotal), toDecimal(0))
    if (issued.add(amount).compare(lib.totals(scope.record).invoiceTotal) > 0)
        denied("CREDIT_EXCEEDS_INVOICE", "Credits cannot exceed the original invoice total")
    const original = scope.record
    const made = call("create#" + I, {
        fromPartyId: original.toPartyId,
        toPartyId: original.fromPartyId,
        invoiceTypeEnumId: "InvoiceCreditMemo",
        invoiceDate: ec.user.nowTimestamp,
        accountingDate: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd"),
        currencyUomId: original.currencyUomId,
        statusId: scope.receivable ? "InvoiceInProcess" : "InvoiceIncoming",
        creditForInvoiceId: p.invoiceId,
        draftedByUserId: ec.user.userId,
        financeOrganizationPartyId: scope.organizationPartyId,
        financeDirection: scope.receivable ? "receivable" : "payable",
        description: p.description || "Credit for " + p.invoiceId
    })
    const sourceLines = Array.from(find(E, {invoiceId: p.invoiceId}).orderBy("invoiceItemSeqId").list())
    const sourceTransactions = rows(T, {invoiceId: p.invoiceId, organizationPartyId: scope.organizationPartyId, isPosted: "Y"})
        .filter(row => !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId)
        .map(row => row.acctgTransId)
    const entries = sourceTransactions.length
        ? Array.from(
              find("mantle.ledger.transaction.AcctgTransEntry")
                  .condition("acctgTransId", "in", sourceTransactions)
                  .condition("debitCreditFlag", scope.receivable ? "C" : "D")
                  .list()
          )
        : []
    const originalTotal = lib.totals(original).invoiceTotal
    let allocated = toDecimal(0)
    for (let index = 0; index < sourceLines.length; index++) {
        const source = sourceLines[index]
        const sourceAmount = toDecimal(source.quantity ?? 1).multiply(source.amount ?? 0)
        const portion =
            index === sourceLines.length - 1
                ? amount.subtract(allocated)
                : ec.l10n.roundCurrency(
                      sourceAmount.multiply(amount).divide(originalTotal, 12, "HALF_UP"),
                      original.currencyUomId
                  )
        allocated = allocated.add(portion)
        if (portion.isZero()) continue
        const matchingAccounts = [
            ...new Set(entries.filter(row => row.invoiceItemSeqId === source.invoiceItemSeqId).map(row => row.glAccountId))
        ]
        if (matchingAccounts.length > 1)
            denied("CREDIT_ACCOUNT_AMBIGUOUS", "Source line " + source.invoiceItemSeqId + " has several posted accounts")
        const account =
            matchingAccounts[0] ||
            source.overrideGlAccountId ||
            call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                organizationPartyId: scope.organizationPartyId,
                otherPartyId: scope.partyId,
                itemTypeEnumId: source.itemTypeEnumId,
                productId: source.productId,
                direction: scope.receivable ? "O" : "I"
            }).glAccountId
        if (!account)
            denied("CREDIT_ACCOUNT_MISSING", "Source line " + source.invoiceItemSeqId + " has no original posting account")
        call("mantle.account.InvoiceServices.create#InvoiceItem", {
            invoiceId: made.invoiceId,
            quantity: "1",
            amount: portion,
            itemTypeEnumId: source.itemTypeEnumId,
            productId: source.productId,
            overrideGlAccountId: account,
            description: p.description || source.description || "Credit for " + p.invoiceId
        })
    }
    const result = {invoiceId: p.invoiceId, creditMemoInvoiceId: made.invoiceId, alreadyApplied: false}
    lib.complete(operation, I, made.invoiceId, result)
    return result
}
function reverseDraft(p) {
    const scope = lib.writeInvoice(p)
    requireDraft(scope)
    lib.revision(scope.record, p.lastUpdatedStamp)
    period(scope)
    if (lib.totals(scope.record).appliedPayments.compare(0) !== 0)
        denied("INVOICE_APPLIED", "An applied invoice cannot be reversed")
    if (
        !scope.receivable ||
        scope.record.statusId !== "InvoiceInProcess" ||
        scope.record.creditForInvoiceId ||
        lib.totals(scope.record).invoiceTotal.compare(0) >= 0
    )
        denied("NEGATIVE_DRAFT_REQUIRED", "Only a negative customer invoice draft is reversed into a credit")
    for (const line of rows(E, {invoiceId: p.invoiceId})) {
        const account =
            line.overrideGlAccountId ||
            call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                organizationPartyId: scope.organizationPartyId,
                otherPartyId: scope.partyId,
                itemTypeEnumId: line.itemTypeEnumId,
                productId: line.productId,
                direction: "O"
            }).glAccountId
        if (!account) denied("CREDIT_ACCOUNT_MISSING", "The invoice line needs an outgoing sales account")
        call("mantle.account.InvoiceServices.update#InvoiceItem", {
            invoiceId: p.invoiceId,
            invoiceItemSeqId: line.invoiceItemSeqId,
            amount: toDecimal(line.amount || 0).multiply(-1),
            overrideGlAccountId: account
        })
    }
    call("mantle.account.InvoiceServices.update#Invoice", {
        invoiceId: p.invoiceId,
        fromPartyId: scope.record.toPartyId,
        toPartyId: scope.record.fromPartyId,
        invoiceTypeEnumId: "InvoiceCreditMemo",
        financeOrganizationPartyId: scope.organizationPartyId,
        financeDirection: "receivable"
    })
    return {invoiceId: p.invoiceId, lastUpdatedStamp: one(I, {invoiceId: p.invoiceId}).lastUpdatedStamp}
}
function applyCredit(p) {
    const credit = lib.writeInvoice(p)
    const target = lib.writeInvoice({invoiceId: p.toInvoiceId, organizationPartyId: credit.organizationPartyId})
    if (!credit.record.creditForInvoiceId || credit.record.creditForInvoiceId !== target.record.invoiceId)
        denied("CREDIT_SOURCE_INVALID", "Choose a credit linked to this invoice")
    if (
        credit.record.currencyUomId !== target.record.currencyUomId ||
        credit.record.fromPartyId !== target.record.toPartyId ||
        credit.record.toPartyId !== target.record.fromPartyId
    )
        denied("SETTLEMENT_SCOPE_INVALID", "A credit and invoice must have the same parties and currency")
    if ([credit.record, target.record].some(row => draftStatuses.includes(row.statusId) || row.statusId === "InvoiceCancelled"))
        denied("SETTLEMENT_STATE_INVALID", "Finalize the credit and invoice before applying them")
    hold(credit)
    hold(target)
    creditCap(credit)
    const creditBalance = lib.totals(credit.record).unpaidTotal,
        invoiceBalance = lib.totals(target.record).unpaidTotal
    const requested =
        p.amount == null ? (creditBalance.compare(invoiceBalance) < 0 ? creditBalance : invoiceBalance) : toDecimal(p.amount)
    const amount = ec.l10n.roundCurrency(requested, credit.record.currencyUomId)
    const operation = lib.operation(p, "InvoiceCreditApply", credit.organizationPartyId, {
        invoiceId: p.invoiceId,
        toInvoiceId: p.toInvoiceId,
        amount: p.amount == null ? null : String(p.amount),
        changeReason: p.changeReason || null
    })
    if (operation.old) return lib.previous(operation)
    // The primitive posts at the later source timestamp; closing the original invoice period does not close a later credit application.
    const dated = ms(credit.record.invoiceDate) >= ms(target.record.invoiceDate) ? credit.record : target.record
    period(
        Object.assign({}, credit, {
            record: Object.assign(map(credit.record), {
                invoiceDate: dated.invoiceDate || ec.user.nowTimestamp,
                accountingDate: dated.accountingDate || null
            })
        })
    )
    if (amount.compare(0) <= 0 || amount.compare(creditBalance) > 0 || amount.compare(invoiceBalance) > 0)
        denied("SETTLEMENT_AMOUNT_INVALID", "The amount must be positive and within both remaining balances")
    const result = call("mantle.account.PaymentServices.apply#InvoiceToInvoice", {
        invoiceId: p.invoiceId,
        toInvoiceId: p.toInvoiceId,
        amount
    })
    if (!result.paymentApplicationId || toDecimal(result.amountApplied || 0).compare(amount) !== 0)
        denied("SETTLEMENT_NOT_APPLIED", "The reviewed credit application did not complete")
    const out = Object.assign(result, {invoiceId: p.invoiceId, toInvoiceId: p.toInvoiceId, alreadyApplied: false})
    lib.complete(operation, "mantle.account.payment.PaymentApplication", result.paymentApplicationId, out)
    return out
}
const operations = {
    changeState,
    storeDraft,
    storeItem,
    deleteItem,
    detail,
    receivables,
    summary,
    createReceivable,
    credit,
    reverseDraft,
    applyCredit
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown invoice workflow operation " + op)
        return operations[op](parameters)
    }
})
