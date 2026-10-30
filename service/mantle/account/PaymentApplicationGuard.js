// Adopted application invariants run before parent totals or GL hooks, including when no extra GL transaction is needed.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
const A = "mantle.account.payment.PaymentApplication"
const I = "mantle.account.invoice.Invoice"
const P = "mantle.account.payment.Payment"
const {find, one, map, ms, denied} = lib
const keys = ["invoiceId", "toInvoiceId", "paymentId", "toPaymentId"]
const identityFields = [...keys, "billingAccountId", "overrideGlAccountId", "taxAuthGeoId", "currencyUomId"]
const financialFields = [...identityFields, "amountApplied", "appliedDate", "accountingDate"]

function same(field, left, right) {
    if (field === "amountApplied") return toDecimal(left ?? 0).eq(right ?? 0)
    if (field === "appliedDate") return ms(left) === ms(right)
    if (field === "accountingDate") return lib.policy.calendarDateText(left) === lib.policy.calendarDateText(right)
    return String(left ?? "") === String(right ?? "")
}
function documents(application, lock = false) {
    const invoices = [...new Set([application.invoiceId, application.toInvoiceId].filter(Boolean))].sort()
    const payments = [...new Set([application.paymentId, application.toPaymentId].filter(Boolean))].sort()
    const records = []
    for (const [entity, field, ids] of [
        [I, "invoiceId", invoices],
        [P, "paymentId", payments]
    ]) {
        if (!ids.length) continue
        let query = find(entity).condition(field, "in", ids).orderBy(field)
        if (lock) query = query.forUpdate(true)
        for (const value of Array.from(query.list())) records.push({entity, field, id: value[field], value})
    }
    return records
}
function organizations(records) {
    const parties = [...new Set(records.flatMap(({value}) => [value.fromPartyId, value.toPartyId]).filter(Boolean))]
    if (!parties.length) return []
    return Array.from(
        find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).condition("partyId", "in", parties).orderBy("partyId").list()
    ).map(row => row.partyId)
}
function pair(application, records) {
    const get = (entity, id) => records.find(record => record.entity === entity && record.id === id)?.value
    const present = keys.filter(field => application[field])
    let left, right
    if (present.length === 2 && application.paymentId && application.invoiceId) {
        left = get(P, application.paymentId)
        right = get(I, application.invoiceId)
    } else if (present.length === 2 && application.paymentId && application.toPaymentId) {
        left = get(P, application.paymentId)
        right = get(P, application.toPaymentId)
    } else if (present.length === 2 && application.invoiceId && application.toInvoiceId) {
        left = get(I, application.invoiceId)
        right = get(I, application.toInvoiceId)
    }
    if (!left || !right || left === right)
        denied("APPLICATION_LINKS_INVALID", "An application needs two available opposing financial records")
    if (left.fromPartyId !== right.toPartyId || left.toPartyId !== right.fromPartyId)
        denied("APPLICATION_PARTIES_INVALID", "The application records must have the same opposing parties")
    const currency = left.currencyUomId || left.amountUomId
    if (!currency || currency !== (right.currencyUomId || right.amountUomId))
        denied("CURRENCY_MISMATCH", "Application records must have the same currency")
    if (application.currencyUomId && application.currencyUomId !== currency)
        denied("CURRENCY_MISMATCH", "The application currency must match its financial records")
    for (const record of records) {
        if (record.entity === P && record.value.paymentTypeEnumId === "PtInternalTransfer")
            denied("TRANSFER_SETTLEMENT_REFUSED", "Internal transfer legs cannot settle trade documents")
        const valid =
            record.entity === I
                ? [
                      "InvoiceFinalized",
                      "InvoiceSent",
                      "InvoiceAcked",
                      "InvoicePmtRecvd",
                      "InvoiceApproved",
                      "InvoicePmtSent",
                      "InvoiceWriteOff"
                  ]
                : ["PmntDelivered", "PmntConfirmed"]
        if (!valid.includes(record.value.statusId))
            denied("APPLICATION_STATE_INVALID", "The financial record is not eligible for application")
    }
    return currency
}
function applicationRows(records, ownId) {
    const cf = ec.entity.conditionFactory
    const conditions = records.flatMap(record => {
        const fields = record.entity === I ? ["invoiceId", "toInvoiceId"] : ["paymentId", "toPaymentId"]
        return fields.map(field => cf.makeCondition(field, "equals", record.id))
    })
    if (!conditions.length) return []
    let query = find(A).condition(cf.makeCondition(conditions, "or")).orderBy("paymentApplicationId").forUpdate(true)
    if (ownId) query = query.condition("paymentApplicationId", "not-equals", ownId)
    return Array.from(query.list())
}
function cashHold(record, organizationPartyId) {
    if (record.entity !== P) return {heldAmount: toDecimal(0)}
    return ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayReservations.js").cashHoldSummary({
        organizationPartyId,
        paymentId: record.id,
        lock: true
    })
}
function assertGatewaySettlement(records) {
    const gateway = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
    for (const record of records.filter(row => row.entity === P)) {
        if (record.value.gatewayRole === "authorization")
            denied("GATEWAY_AUTHORIZATION_NOT_CASH", "An authorization instruction cannot enter trade settlement")
        if (
            record.value.lifecycleManaged === "Y" &&
            record.value.paymentTypeEnumId === "PtInvoicePayment" &&
            !record.value.gatewayRole &&
            gateway.gatewayCapable(record.value) &&
            !gateway.hasManualCash(record.value)
        )
            denied("GATEWAY_CAPTURE_REQUIRED", "Only a completed reviewed provider capture can enter trade settlement")
    }
}
function capacity(record, applications, organizationPartyId) {
    const fields = record.entity === I ? ["invoiceId", "toInvoiceId"] : ["paymentId", "toPaymentId"]
    const consumed = applications
        .filter(row => fields.some(field => row[field] === record.id))
        .reduce((total, row) => total.add(row.amountApplied ?? 0), toDecimal(0))
    const original = record.entity === I ? lib.totals(record.value).invoiceTotal : toDecimal(record.value.amount ?? 0)
    return original.subtract(consumed).subtract(cashHold(record, organizationPartyId).heldAmount)
}
function bookDay(application, records, retained = false) {
    if (retained)
        return ec.resource
            .script("component://mr-mantle/service/mantle/account/SourcePostingGuard.js")
            .applicationDay(application)
    const date = ms(application.appliedDate)
    if (date == null || !Number.isFinite(date)) denied("APPLICATION_DATE_INVALID", "Choose an application effective date")
    const nativeReviewed = /mantle\.account\.PaymentServices\.(apply#Settlement|autoApply#Payment)(?:\b|$)/.test(
        ec.artifactExecution.getStackNameString()
    )
    const source = (entity, id) => records.find(record => record.entity === entity && record.id === id)?.value
    const inferred =
        posting.calendarDay(
            {transactionDate: application.appliedDate},
            {
                paymentId: source(P, application.paymentId),
                invoiceId: source(I, application.invoiceId || application.toInvoiceId)
            },
            true
        ) || lib.policy.calendarDateText(application.appliedDate)
    const day = nativeReviewed && application.accountingDate ? lib.policy.calendarDateText(application.accountingDate) : inferred
    if (!nativeReviewed && application.accountingDate && lib.policy.calendarDateText(application.accountingDate) !== inferred)
        denied("APPLICATION_DATE_INVALID", "Application book day must match its effective date")
    // A viewer's zone never changes a SQL source day or the day of an existing ledger posting.
    if (records.some(record => record.value.accountingDate && lib.policy.calendarDateText(record.value.accountingDate) > day))
        denied("APPLICATION_DATE_INVALID", "Application date cannot precede its financial records")
    return day
}
function checkDate(application, records, organizationPartyId, retained = false, resolvedDay = null) {
    const evidence = retained
        ? ec.resource
              .script("component://mr-mantle/service/mantle/account/SourcePostingGuard.js")
              .applicationEvidence(application)
        : null
    const day = resolvedDay || evidence?.day || bookDay(application, records)
    const effectiveDate = evidence?.effectiveDate || application.appliedDate
    const tx = {
        organizationPartyId,
        transactionDate: effectiveDate,
        invoiceId: application.invoiceId || application.toInvoiceId
    }
    const fiscal = posting.fiscal(organizationPartyId, effectiveDate, true, [], day)
    const scopes = new Set(posting.scopes(tx, []))
    if (!tx.invoiceId) {
        for (const record of records.filter(record => record.entity === P)) {
            const base = record.value.refundForPaymentId ? one(P, {paymentId: record.value.refundForPaymentId}) : record.value
            const direction =
                base?.financeDirection ||
                (base?.toPartyId === organizationPartyId
                    ? "receivable"
                    : base?.fromPartyId === organizationPartyId
                      ? "payable"
                      : null)
            if (direction) scopes.add(direction === "receivable" ? "sales" : "purchases")
        }
    }
    const locks = posting.postingLocks(tx, [...scopes], true, day)
    const findings = [...fiscal.findings, ...locks.findings]
    if (findings.length) denied(findings[0].code, findings.map(row => row.message).join("; "))
}
function guard(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const updates = map(p.entityValue || p)
    // Entity upsert/createOrUpdate also reports create; an existing identity still has immutable financial history.
    const original = p.originalValue
        ? map(p.originalValue)
        : updates.paymentApplicationId
          ? one(A, {paymentApplicationId: updates.paymentApplicationId})
          : null
    // A delete's unpersisted field changes cannot disguise a positive stored amount or move its financial links.
    const candidate = p.eecaOperation === "delete" && original ? map(original) : Object.assign({}, map(original), updates)
    if (
        p.eecaOperation !== "delete" &&
        original &&
        financialFields.every(field => same(field, original[field], candidate[field]))
    )
        return
    let records = documents(candidate)
    const originalRecords = original ? documents(original) : []
    const initialOrgs = [...new Set([...organizations(records), ...organizations(originalRecords)])].sort()
    const legacy = ec.resource.script("component://mr-mantle/service/mantle/account/LegacyPaymentGatewayGuard.js")
    if (
        !initialOrgs.some(org => lib.policy.preference(org).settlementApplicationGuardEnabled === "Y") &&
        [...records, ...originalRecords].filter(record => record.entity === P).every(record => !legacy.isManaged(record.value))
    ) {
        const lockedPayments = legacy.lockUnmanagedPayments(
                [...records, ...originalRecords].filter(record => record.entity === P).map(record => record.id)
            ),
            fresh = input =>
                input.map(record =>
                    record.entity === P
                        ? Object.assign({}, record, {
                              value: lockedPayments.find(payment => payment.paymentId === record.id)
                          })
                        : record
                ),
            freshRecords = fresh(documents(candidate)),
            freshOriginals = original ? fresh(documents(original)) : [],
            identity = input =>
                input.map(record => ({
                    entity: record.entity,
                    id: record.id,
                    fromPartyId: record.value.fromPartyId,
                    toPartyId: record.value.toPartyId,
                    financeOrganizationPartyId: record.value.financeOrganizationPartyId,
                    financeDirection: record.value.financeDirection,
                    currencyUomId: record.value.currencyUomId || record.value.amountUomId
                }))
        if (
            lib.hash(identity([...records, ...originalRecords])) !== lib.hash(identity([...freshRecords, ...freshOriginals])) ||
            JSON.stringify([...new Set([...organizations(freshRecords), ...organizations(freshOriginals)])].sort()) !==
                JSON.stringify(initialOrgs)
        )
            denied("APPLICATION_SOURCE_CHANGED", "The financial record scope changed; retry the operation")
        if (initialOrgs.some(org => lib.policy.preference(org).settlementApplicationGuardEnabled === "Y"))
            denied("APPLICATION_SOURCE_CHANGED", "Settlement controls changed; retry the operation")
        if (
            ec.resource
                .script("component://mr-mantle/service/mantle/account/PaymentRefundBackingGuard.js")
                .application({before: original, after: candidate})
        )
            denied("APPLICATION_SOURCE_CHANGED", "A reviewed refund changed the financial source; retry the operation")
        return
    }
    // Lock organizations before document and application rows, matching the reviewed settlement writer.
    Array.from(find("mantle.party.Party").condition("partyId", "in", initialOrgs).orderBy("partyId").forUpdate(true).list())
    records = documents(candidate, true)
    const lockedOriginalRecords = original ? documents(original, true) : [],
        financialRecords = [...records, ...lockedOriginalRecords]
    const refundBacked = ec.resource
        .script("component://mr-mantle/service/mantle/account/PaymentRefundBackingGuard.js")
        .application({before: original, after: candidate})
    assertGatewaySettlement(records)
    const lockedOrgs = [...new Set(organizations(financialRecords))].sort()
    if (JSON.stringify(lockedOrgs) !== JSON.stringify(initialOrgs))
        denied("APPLICATION_SOURCE_CHANGED", "Application organization changed; retry the operation")
    const holdOrgs = lockedOrgs.filter(org =>
        financialRecords.some(record => record.entity === P && cashHold(record, org).heldAmount.compare(0) > 0)
    )
    const gatewayCash = financialRecords.some(
        record => record.entity === P && ["capture", "refund"].includes(record.value.gatewayRole)
    )
    if (
        !lockedOrgs.some(org => lib.policy.preference(org).settlementApplicationGuardEnabled === "Y") &&
        !holdOrgs.length &&
        !gatewayCash &&
        !refundBacked
    )
        return
    if (original && !toDecimal(original.amountApplied ?? 0).isZero()) {
        const immutable = [...identityFields, "appliedDate", "accountingDate"]
        if (immutable.some(field => !same(field, original[field], candidate[field])))
            denied("APPLICATION_IMMUTABLE", "An application keeps its original records and dates when it is unapplied")
    }
    if (lockedOrgs.length !== 1) denied("INTERCOMPANY_SETTLEMENT_UNAVAILABLE", "Intercompany settlement is not available")
    const amount = toDecimal(candidate.amountApplied ?? 0)
    if (original && toDecimal(original.amountApplied ?? 0).isZero() && amount.compare(0) > 0)
        denied("APPLICATION_IMMUTABLE", "Create a new reviewed application instead of restoring an unapplied row")
    if (p.eecaOperation === "delete") {
        const current = candidate.paymentApplicationId
            ? find(A, {paymentApplicationId: candidate.paymentApplicationId}).forUpdate(true).one()
            : null
        if (!toDecimal(current?.amountApplied ?? amount).isZero())
            denied("APPLICATION_DELETE_REFUSED", "Unapply a financial application before removing it")
        return
    }
    if (original && !toDecimal(original.amountApplied ?? 0).isZero()) {
        const identitiesChanged = identityFields.some(field => !same(field, original[field], candidate[field]))
        if (
            identitiesChanged ||
            (!amount.isZero() && financialFields.some(field => !same(field, original[field], candidate[field])))
        )
            denied("APPLICATION_IMMUTABLE", "Unapply the original application before changing its financial values")
        if (amount.isZero()) {
            // Legacy unapplication keeps its reversal rules; a closed original day cannot be silently rewritten.
            checkDate(original, records, lockedOrgs[0], true)
            return
        }
    }
    if (amount.isZero()) return
    if (amount.compare(0) < 0) denied("APPLICATION_AMOUNT_INVALID", "Application amount must be positive")
    const currency = pair(candidate, records)
    if (!ec.l10n.roundCurrency(amount, currency).eq(amount))
        denied("APPLICATION_AMOUNT_PRECISION", "Application amount must use its currency's precision")
    const applications = applicationRows(records, candidate.paymentApplicationId)
    const day = bookDay(candidate, records)
    const sources = ec.resource.script("component://mr-mantle/service/mantle/account/SourcePostingGuard.js")
    const originals = sources.lockForApplication(records, day)
    for (const record of records) {
        if (amount.compare(capacity(record, applications, lockedOrgs[0])) > 0)
            denied("APPLICATION_BALANCE_CHANGED", "Application exceeds an available financial balance; review it again")
    }
    const sourcePayment = records.find(record => record.entity === P && record.id === candidate.paymentId)
    if (sourcePayment)
        sources.checkDirectApplication(
            candidate,
            records,
            applications,
            originals,
            amount,
            capacity(sourcePayment, applications, lockedOrgs[0]),
            /mantle\.account\.PaymentServices\.(apply#Settlement|autoApply#Payment)(?:\b|$)/.test(
                ec.artifactExecution.getStackNameString()
            )
        )
    checkDate(candidate, records, lockedOrgs[0], false, day)
    // Only new records in an adopted organization capture these values. Existing and default-off history is untouched.
    if (!original) {
        if (!candidate.accountingDate) p.entityValue.set("accountingDate", day)
        if (!candidate.currencyUomId) p.entityValue.set("currencyUomId", currency)
    }
}
;({guard})
