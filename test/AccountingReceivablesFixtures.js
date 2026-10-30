// Shared standalone fixture builder: spec-local organizations, permissions and mail accounts, with no application dependency.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const call = lib.call
function fixtures(prefix) {
    const org = prefix + "_ORG",
        customer = prefix + "_CUSTOMER"
    call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId: org, organizationName: prefix + " finance organization"})
    call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
    call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
        organizationPartyId: org,
        sourcePartyId: "DefaultSettings",
        baseCurrencyUomId: "USD"
    })
    call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
        organizationPartyId: org,
        filterDate: ec.user.nowTimestamp
    })
    call("update#mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: org,
        postingGuardEnabled: "Y",
        singleCurrencyDocumentsOnly: "Y"
    })
    call("create#mantle.party.Party", {partyId: customer, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId: customer, organizationName: prefix + " customer"})
    call("create#mantle.party.PartyRole", {partyId: customer, roleTypeId: "Customer"})
    const users = {}
    for (const [kind, permissions] of Object.entries({
        ar: ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW"],
        ap: ["PAYABLE_EDIT", "PAYABLE_VIEW"],
        edit: ["RECEIVABLE_EDIT"],
        approve: ["INVOICE_APPROVE", "ACCOUNTING_VIEW"],
        read: ["ACCOUNTING_VIEW"],
        treasury: ["ACCOUNTING_VIEW", "PAYMENT_EDIT", "BANK_RECONCILE"],
        tax: ["ACCOUNTING_VIEW", "TAX_STATEMENT_EDIT"],
        financeadmin: ["ACCOUNTING_ADMIN", "RECEIVABLE_EDIT", "RECEIVABLE_VIEW"]
    })) {
        const id = prefix + "_" + kind.toUpperCase()
        users[kind] = id
        call("create#moqui.security.UserGroup", {userGroupId: id, description: "Native finance " + kind})
        for (const permission of permissions)
            call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
        call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
        call("create#moqui.security.UserAccount", {
            userId: id,
            username: id,
            partyId: id,
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA",
            timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
        })
        call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
        call("create#mantle.party.PartyRelationship", {
            partyRelationshipId: id,
            fromPartyId: id,
            toPartyId: org,
            relationshipTypeEnumId: "PrtAgent",
            fromDate: 0
        })
    }
    const server = prefix + "_SMTP",
        emailAccountId = prefix + "_MAIL"
    call("create#moqui.basic.email.EmailServer", {
        emailServerId: server,
        smtpHost: "127.0.0.1",
        smtpPort: "9",
        smtpStartTls: "N",
        smtpSsl: "N"
    })
    call("create#moqui.basic.email.EmailAccount", {
        emailAccountId,
        ownerPartyId: org,
        accountKindEnumId: "EakShared",
        emailServerId: server,
        emailAddress: "accounts@native.example",
        accountName: "Native finance mail",
        statusId: "EasActive",
        recordFilingEnumId: "ErfLinkedOnly"
    })
    for (const id of [users.ar, users.edit, ec.user.userId])
        call("create#moqui.basic.email.EmailAccountUser", {emailAccountId, userId: id, fromDate: 0, permissionEnumId: "EapSend"})
    return {org, customer, users, emailAccountId}
}
function draft(f, amount = "100", currencyUomId = "USD") {
    const made = call("mantle.account.InvoiceServices.create#Receivable", {
        organizationPartyId: f.org,
        customerPartyId: f.customer,
        currencyUomId
    })
    call("mantle.account.InvoiceServices.store#InvoiceDraftItem", {
        invoiceId: made.invoiceId,
        itemTypeEnumId: "ItemTimeEntry",
        quantity: "1",
        amount,
        description: "Approved consulting"
    })
    return lib.one(lib.invoiceEntity, {invoiceId: made.invoiceId})
}
function rejected(name, p) {
    try {
        lib.probe(name, p)
        return ""
    } catch (error) {
        return error.message
    }
}
function cleanupLocks(organizationPartyId) {
    for (const [entity, field] of [
        ["mantle.ledger.config.AccountingLockException", "accountingLockExceptionId"],
        ["mantle.ledger.config.AccountingLock", "accountingLockId"]
    ]) {
        for (const row of lib.rows(entity, {organizationPartyId})) {
            try {
                call("delete#" + entity, {[field]: row[field]})
            } catch (error) {
                ec.logger.error("Native fixture cleanup " + entity + " " + row[field] + ": " + error.message)
            }
        }
    }
}
;({fixtures, draft, rejected, cleanupLocks, call, lib})
