// Scoped customer finance details: sensitive methods and registrations are projected only for their permissions.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, display, denied, has} = lib
function scope(p, permission = null) {
    lib.organization(p.organizationPartyId, permission)
    const party = one("mantle.party.PartyDetail", {partyId: p.customerPartyId})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("CUSTOMER_UNAVAILABLE", "Customer is not available")
    const cf = ec.entity.conditionFactory
    const knownInvoice = find(lib.invoiceEntity)
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition(
                        [
                            cf.makeCondition("fromPartyId", "equals", p.organizationPartyId),
                            cf.makeCondition("toPartyId", "equals", p.customerPartyId)
                        ],
                        "and"
                    ),
                    cf.makeCondition(
                        [
                            cf.makeCondition("toPartyId", "equals", p.organizationPartyId),
                            cf.makeCondition("fromPartyId", "equals", p.customerPartyId)
                        ],
                        "and"
                    )
                ],
                "or"
            )
        )
        .limit(1)
        .list().length
    const knownOrder = find("mantle.order.OrderPart", {vendorPartyId: p.organizationPartyId, customerPartyId: p.customerPartyId})
        .limit(1)
        .list().length
    const relationship = find("mantle.party.PartyRelationship")
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition(
                        [
                            cf.makeCondition("fromPartyId", "equals", p.organizationPartyId),
                            cf.makeCondition("toPartyId", "equals", p.customerPartyId)
                        ],
                        "and"
                    ),
                    cf.makeCondition(
                        [
                            cf.makeCondition("toPartyId", "equals", p.organizationPartyId),
                            cf.makeCondition("fromPartyId", "equals", p.customerPartyId)
                        ],
                        "and"
                    )
                ],
                "or"
            )
        )
        .conditionDate("fromDate", "thruDate", null)
        .limit(1)
        .list().length
    if (!knownInvoice && !knownOrder && !relationship)
        denied("CUSTOMER_SCOPE_INVALID", "Customer has no business relationship with this organization")
    return party
}
function capabilities() {
    return {
        canEditIdentifications: has("RECEIVABLE_EDIT"),
        canReadPaymentMethods: has("BANK_RECONCILE") && has("PAYMENT_EDIT"),
        canEditPaymentMethods: has("BANK_RECONCILE") && has("PAYMENT_EDIT"),
        canReadTaxRegistrations: has("TAX_STATEMENT_EDIT"),
        canEditTaxRegistrations: has("TAX_STATEMENT_EDIT")
    }
}
function customerContacts(customerPartyId) {
    const contacts = Array.from(
        find("mantle.party.contact.PartyContactMechInfo", {partyId: customerPartyId})
            .conditionDate("fromDate", "thruDate", null)
            .orderBy("contactMechPurposeId,contactMechId")
            .limit(100)
            .list()
    )
    if (!contacts.length) return []
    const ids = type => [...new Set(contacts.filter(row => row.contactMechTypeEnumId === type).map(row => row.contactMechId))]
    const postalIds = ids("CmtPostalAddress"),
        telecomIds = ids("CmtTelecomNumber")
    const byId = records => Object.fromEntries(records.map(row => [row.contactMechId, row]))
    const postal = postalIds.length
        ? byId(Array.from(find("mantle.party.contact.PostalAddress").condition("contactMechId", "in", postalIds).list()))
        : {}
    const telecom = telecomIds.length
        ? byId(Array.from(find("mantle.party.contact.TelecomNumber").condition("contactMechId", "in", telecomIds).list()))
        : {}
    const purposeIds = [...new Set(contacts.map(row => row.contactMechPurposeId).filter(Boolean))]
    const purposes = purposeIds.length
        ? Object.fromEntries(
              Array.from(
                  find("mantle.party.contact.ContactMechPurpose").condition("contactMechPurposeId", "in", purposeIds).list()
              ).map(row => [row.contactMechPurposeId, row.description])
          )
        : {}
    const geoIds = [
        ...new Set(
            Object.values(postal)
                .flatMap(row => [row.stateProvinceGeoId, row.countryGeoId])
                .filter(Boolean)
        )
    ]
    const geos = geoIds.length
        ? Object.fromEntries(
              Array.from(find("moqui.basic.Geo").condition("geoId", "in", geoIds).list()).map(row => [row.geoId, row.geoName])
          )
        : {}
    return contacts.map(row => {
        const result = lib.policy.pick(display(row), [
            "contactMechId",
            "contactMechPurposeId",
            "contactMechTypeEnumId",
            "infoString",
            "extension"
        ])
        const address = postal[row.contactMechId],
            phone = telecom[row.contactMechId]
        if (address)
            Object.assign(
                result,
                lib.policy.pick(display(address), [
                    "address1",
                    "address2",
                    "unitNumber",
                    "city",
                    "stateProvinceGeoId",
                    "countryGeoId",
                    "postalCode",
                    "postalCodeExt"
                ]),
                {stateProvinceGeoName: geos[address.stateProvinceGeoId] || "", countryGeoName: geos[address.countryGeoId] || ""}
            )
        if (phone) Object.assign(result, lib.policy.pick(display(phone), ["countryCode", "areaCode", "contactNumber"]))
        result.purposeDescription = purposes[row.contactMechPurposeId] || row.contactMechPurposeId
        result.purposeText = result.purposeDescription
        return result
    })
}
function get(p) {
    if (!has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN")) lib.requirePermission("RECEIVABLE_VIEW")
    const customer = lib.policy.pick(display(scope(p)), [
            "partyId",
            "partyTypeEnumId",
            "organizationName",
            "firstName",
            "middleName",
            "lastName"
        ]),
        allowed = capabilities()
    const invoiceWorkflow = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflow.js")
    const invoiceRecords = Array.from(
        invoiceWorkflow
            .execute("receivables", {
                organizationPartyId: p.organizationPartyId,
                customerPartyId: p.customerPartyId,
                _queryOnly: true
            })
            .orderBy("-invoiceDate,invoiceId")
            .limit(201)
            .list()
    )
    const invoiceTotals = lib.totalsMany(invoiceRecords)
    const invoices = invoiceRecords.map(row => Object.assign(lib.invoiceDisplay(row), invoiceTotals[row.invoiceId]))
    const payments = Array.from(
        find("mantle.account.payment.Payment", {fromPartyId: p.customerPartyId, toPartyId: p.organizationPartyId})
            .orderBy("-effectiveDate,paymentId")
            .limit(201)
            .list()
    ).map(row =>
        lib.policy.pick(display(row), [
            "paymentId",
            "statusId",
            "effectiveDate",
            "effectiveDateText",
            "amount",
            "amountUomId",
            "paymentRefNum",
            "unappliedTotal"
        ])
    )
    const summary = {}
    const dayNumber = value => {
        const parts = ec.l10n.format(value, "yyyy-MM-dd").split("-").map(Number)
        return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000
    }
    const today = dayNumber(ec.user.nowTimestamp)
    const currencySummary = currencyUomId =>
        summary[currencyUomId] ||
        (summary[currencyUomId] = {
            currencyUomId,
            openReceivable: toDecimal(0),
            overdue: toDecimal(0),
            billedThisYear: toDecimal(0),
            current: toDecimal(0),
            days1To30: toDecimal(0),
            days31To60: toDecimal(0),
            days61To90: toDecimal(0),
            over90: toDecimal(0),
            lastPaymentAmount: null,
            lastPaymentDate: null,
            lastPaymentDateText: ""
        })
    for (const invoice of invoices) {
        if (["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived", "InvoiceCancelled"].includes(invoice.statusId)) continue
        const currency = invoice.currencyUomId
        const row = currencySummary(currency)
        const sign = invoice.invoiceTypeEnumId === "InvoiceCreditMemo" ? -1 : 1
        const unpaid = toDecimal(invoice.unpaidTotal).multiply(sign)
        const daysPastDue = invoice.dueDate == null ? 0 : today - dayNumber(invoice.dueDate)
        const bucket =
            daysPastDue <= 0
                ? "current"
                : daysPastDue <= 30
                  ? "days1To30"
                  : daysPastDue <= 60
                    ? "days31To60"
                    : daysPastDue <= 90
                      ? "days61To90"
                      : "over90"
        row[bucket] = row[bucket].add(unpaid)
        row.openReceivable = row.openReceivable.add(unpaid)
        if (daysPastDue > 0) row.overdue = row.overdue.add(unpaid)
        if (String(invoice.invoiceDateValue || "").slice(0, 4) === ec.l10n.format(ec.user.nowTimestamp, "yyyy"))
            row.billedThisYear = row.billedThisYear.add(toDecimal(invoice.invoiceTotal).multiply(sign))
    }
    // Latest received payment is independent of the bounded recent-payment table and excludes drafts, failures and future entries.
    const paymentCurrencies = Array.from(
        find("mantle.account.payment.Payment", {
            fromPartyId: p.customerPartyId,
            toPartyId: p.organizationPartyId
        })
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .condition("effectiveDate", "less-equals", ec.user.nowTimestamp)
            .selectField("amountUomId")
            .distinct(true)
            .list()
    )
    for (const currency of paymentCurrencies) {
        const latest = Array.from(
            find("mantle.account.payment.Payment", {
                fromPartyId: p.customerPartyId,
                toPartyId: p.organizationPartyId,
                amountUomId: currency.amountUomId
            })
                .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
                .condition("effectiveDate", "less-equals", ec.user.nowTimestamp)
                .orderBy("-effectiveDate,-paymentId")
                .limit(1)
                .list()
        )[0]
        if (!latest) continue
        Object.assign(currencySummary(currency.amountUomId), {
            lastPaymentAmount: latest.amount,
            lastPaymentDate: latest.effectiveDate,
            lastPaymentDateText: lib.policy.dateText(latest.effectiveDate)
        })
    }
    const agreementIds = Array.from(
        find("mantle.party.agreement.AgreementParty", {partyId: p.customerPartyId}).selectField("agreementId").limit(501).list()
    ).map(row => row.agreementId)
    const organizationAgreements = agreementIds.length
        ? Array.from(
              find("mantle.party.agreement.AgreementParty", {partyId: p.organizationPartyId})
                  .condition("agreementId", "in", agreementIds)
                  .selectField("agreementId")
                  .list()
          ).map(row => row.agreementId)
        : []
    const result = {
        customer,
        capabilities: allowed,
        contacts: customerContacts(p.customerPartyId),
        orders: Array.from(
            find("mantle.order.OrderPart", {vendorPartyId: p.organizationPartyId, customerPartyId: p.customerPartyId})
                .orderBy("-orderId,orderPartSeqId")
                .limit(200)
                .list()
        ).map(display),
        invoices: invoices.slice(0, 200),
        payments: payments.slice(0, 200),
        agreements: organizationAgreements.length
            ? Array.from(
                  find("mantle.party.agreement.Agreement")
                      .condition("agreementId", "in", organizationAgreements)
                      .orderBy("-fromDate")
                      .limit(200)
                      .list()
              ).map(display)
            : [],
        summaryRows: invoices.length > 200 ? [] : Object.values(summary),
        incomplete: invoices.length > 200 || payments.length > 200,
        paymentMethods: [],
        identifications: [],
        taxRegistrations: []
    }
    if (allowed.canReadPaymentMethods) {
        const methods = Array.from(
            find("mantle.account.method.PaymentMethod", {ownerPartyId: p.customerPartyId})
                .conditionDate("fromDate", "thruDate", null)
                .limit(100)
                .list()
        )
        for (const method of methods) {
            try {
                const bank = one("mantle.account.method.BankAccount", {paymentMethodId: method.paymentMethodId})
                const digits = bank?.accountNumber ? String(bank.accountNumber).slice(-4) : ""
                result.paymentMethods.push({
                    paymentMethodId: method.paymentMethodId,
                    paymentMethodTypeEnumId: method.paymentMethodTypeEnumId,
                    description: bank
                        ? (bank.bankName || "Bank account") + (digits ? " •••• " + digits : "")
                        : method.description,
                    bankName: bank?.bankName || "",
                    maskedAccountNumber: digits ? "•••• " + digits : "",
                    fromDate: method.fromDate,
                    thruDate: method.thruDate,
                    fromDateText: lib.policy.dateText(method.fromDate),
                    thruDateText: lib.policy.dateText(method.thruDate),
                    lastUpdatedStamp: method.lastUpdatedStamp
                })
            } catch (error) {
                ec.logger.error("Customer payment method " + method.paymentMethodId + ": " + error.message)
            }
        }
    }
    if (allowed.canEditIdentifications)
        result.identifications = Array.from(
            find("mantle.party.PartyIdentification", {partyId: p.customerPartyId}).limit(100).list()
        ).map(display)
    if (allowed.canReadTaxRegistrations)
        result.taxRegistrations = Array.from(
            find("mantle.other.tax.TaxAuthorityParty", {partyId: p.customerPartyId}).limit(100).list()
        ).map(display)
    return result
}
function identification(p) {
    scope(p, "RECEIVABLE_EDIT")
    if (!one("moqui.basic.Enumeration", {enumId: p.partyIdTypeEnumId, enumTypeId: "PartyIdType"}))
        denied("IDENTIFICATION_TYPE_INVALID", "Choose an identification type")
    const keys = {partyId: p.customerPartyId, partyIdTypeEnumId: p.partyIdTypeEnumId}
    const old = find("mantle.party.PartyIdentification", keys).forUpdate(true).one()
    if (old) lib.revision(old, p.lastUpdatedStamp)
    const fields = Object.assign({}, keys)
    for (const key of ["idValue", "issuedBy", "issuedByPartyId", "expireDate"])
        if (p[key] !== undefined) fields[key] = p[key] || null
    call((old ? "update#" : "create#") + "mantle.party.PartyIdentification", fields)
    return {customerPartyId: p.customerPartyId, partyIdTypeEnumId: p.partyIdTypeEnumId}
}
function tax(p) {
    scope(p, "TAX_STATEMENT_EDIT")
    if (!one("mantle.other.tax.TaxAuthority", {taxAuthorityId: p.taxAuthorityId}))
        denied("TAX_AUTHORITY_INVALID", "Choose a tax authority")
    const fromDate = p.fromDate ?? ec.user.nowTimestamp
    const keys = {partyId: p.customerPartyId, taxAuthorityId: p.taxAuthorityId, fromDate}
    const old = find("mantle.other.tax.TaxAuthorityParty", keys).forUpdate(true).one()
    if (old) lib.revision(old, p.lastUpdatedStamp)
    if (p.thruDate && lib.ms(p.thruDate) <= lib.ms(fromDate)) denied("DATE_RANGE_INVALID", "The end date must follow the start")
    const fields = Object.assign({}, keys)
    for (const key of ["partyTaxId", "isExempt", "isNexus", "thruDate"]) if (p[key] !== undefined) fields[key] = p[key] || null
    call((old ? "update#" : "create#") + "mantle.other.tax.TaxAuthorityParty", fields)
    return {customerPartyId: p.customerPartyId, taxAuthorityId: p.taxAuthorityId, fromDate}
}
function bank(p) {
    scope(p, "PAYMENT_EDIT")
    lib.requirePermission("BANK_RECONCILE")
    const old =
        p.paymentMethodId &&
        find("mantle.account.method.PaymentMethod", {paymentMethodId: p.paymentMethodId}).forUpdate(true).one()
    if (p.paymentMethodId && (!old || old.ownerPartyId !== p.customerPartyId))
        denied("PAYMENT_METHOD_UNAVAILABLE", "The bank account does not belong to this customer")
    if (old) lib.revision(old, p.lastUpdatedStamp)
    const fields = {ownerPartyId: p.customerPartyId, paymentMethodId: p.paymentMethodId}
    for (const key of ["bankName", "accountNumber", "routingNumber", "typeEnumId", "description", "fromDate", "thruDate"])
        if (p[key] !== undefined) fields[key] = p[key] || null
    // A human description never defaults to a full bank account number.
    if (!fields.description)
        fields.description =
            (p.bankName || "Bank account") + (p.accountNumber ? " •••• " + String(p.accountNumber).slice(-4) : "")
    const result = call("mantle.account.PaymentMethodServices." + (old ? "update" : "create") + "#BankAccount", fields)
    return {customerPartyId: p.customerPartyId, paymentMethodId: result.paymentMethodId || p.paymentMethodId}
}
const operations = {get, identification, tax, bank}
;({
    execute: (op, p) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown customer finance operation " + op)
        return operations[op](p)
    }
})
