const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_OUTPUT")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})
feature("issued receipt read is pure, revision round-trips and immutable PDF bytes match the stored hash", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.delivered(f, {amount: "40"}),
            view = h.detail(f, paymentId),
            before = h.count("mantle.account.payment.PaymentIssuedOutput", {paymentId}),
            first = h.native("get#PaymentOutput", {
                organizationPartyId: f.org,
                paymentId,
                outputType: "receipt",
                sourceVersion: view.sourceVersion
            }),
            second = h.native("get#PaymentOutput", {
                organizationPartyId: f.org,
                paymentId,
                outputId: first.outputId,
                sourceVersion: first.sourceVersion
            }),
            row = h.lib.one("mantle.account.payment.PaymentIssuedOutput", {paymentOutputId: first.outputId}),
            stream = ec.resource.getLocationReference(row.contentLocation).getInputStream()
        let actualHash
        try {
            actualHash = h.lib.hash(StringUtilities.base64Encode(stream.readAllBytes()))
        } finally {
            stream.close()
        }
        return {first, second, before, after: h.count("mantle.account.payment.PaymentIssuedOutput", {paymentId}), row, actualHash}
    },
    then({first, second, before, after, row, actualHash}) {
        first.outputId == second.outputId
        first.contentHash == second.contentHash
        first.outputSourceVersion == second.outputSourceVersion
        first.contentHash == actualHash
        before == after
        toDecimal(first.summary.amount).eq(40)
        first.summary.currencyUomId == "USD"
        first.summary.accountingDateText == f.day
        first.summary.maskedMethodLabel.includes("6789")
        first.approvedHtml.includes("123456789") == false
        row.contentLocation.startsWith("dbresource://mantle/content/payment-issued/")
        row.contentLocation.includes("/payment/" + row.paymentId + "/") == false
        first.contentLocation == null
    }
})
feature("issued checks require treasury in output and content helpers and are omitted before ordinary file counts", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.delivered(f, {cashDirection: "outgoing", amount: "35", paymentInstrumentEnumId: "PiCompanyCheck"}),
            check = h.native("get#PaymentOutput", {organizationPartyId: f.org, paymentId, outputType: "check"}),
            row = h.lib.one("mantle.account.payment.PaymentIssuedOutput", {paymentOutputId: check.outputId}),
            bankBefore = h.lib.one("mantle.account.method.BankAccount", {paymentMethodId: f.methodId}).lastCheckNumber
        login(f.users.paymentView)
        const view = h.detail(f, paymentId),
            denied = h.rejected("get#PaymentOutput", {organizationPartyId: f.org, paymentId, outputType: "check"}),
            module = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js"),
            visible = Array.from(
                h.lib
                    .find(module.readEntityName, {paymentId})
                    .condition(module.readCondition({organizationPartyId: f.org, paymentId}))
                    .list()
            )
        let contentDenied
        try {
            module.canReadContent(row.paymentContentId, f.org)
            contentDenied = ""
        } catch (error) {
            contentDenied = error.message
        }
        return {
            check,
            view,
            denied,
            contentDenied,
            visible,
            bankBefore,
            bankAfter: h.lib.one("mantle.account.method.BankAccount", {paymentMethodId: f.methodId}).lastCheckNumber
        }
    },
    then({check, view, denied, contentDenied, visible, bankBefore, bankAfter}) {
        check.summary.checkNumber != null
        check.approvedHtml.includes("123456789")
        denied.includes("PERMISSION_DENIED")
        contentDenied.includes("PERMISSION_DENIED")
        view.capabilities.canPrintCheck == false
        view.contentRows.every(row => row.contentTypeEnumId !== "PctCheckImage")
        visible.length == 2
        visible.every(row => row.contentTypeEnumId !== "PctCheckImage")
        Number(bankBefore) == Number(bankAfter)
    }
})
feature(
    "completed custom operation keys reopen and replay exactly while pre-issuance reader conditions still exclude new checks",
    {
        when() {
            const h = helper()
            login(f.users.treasury)
            const paymentId = h.draft(f, {cashDirection: "outgoing", amount: "18", paymentInstrumentEnumId: "PiCompanyCheck"})
            login(f.users.paymentView)
            const module = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js"),
                condition = module.readCondition({organizationPartyId: f.org, paymentId})
            login(f.users.treasury)
            const preview = h.preview(f, paymentId, "deliver"),
                result = h.confirm(preview, "custom-payment-external-key"),
                completed = h.native("get#PaymentStatePreview", {organizationPartyId: f.org, previewId: preview.previewId}),
                again = h.confirm(completed, completed.operationKey),
                before = h.count("mantle.account.payment.PaymentIssuedOutput", {paymentId})
            login(f.users.paymentView)
            const rows = Array.from(h.lib.find(module.readEntityName, {paymentId}).condition(condition).list())
            return {
                result,
                completed,
                again,
                before,
                after: h.count("mantle.account.payment.PaymentIssuedOutput", {paymentId}),
                rows
            }
        },
        then({result, completed, again, before, after, rows}) {
            completed.operationKey == "custom-payment-external-key"
            completed.status == "complete"
            completed.capabilities.canPrintReceipt == true
            completed.capabilities.canPrintDetail == true
            completed.capabilities.canPrintCheck == true
            completed.capabilities.outputRows == null
            completed.results.outputRows.length == 3
            again.alreadyApplied == true
            again.outputId == result.outputId
            before == after
            rows.length == 2
            rows.every(row => row.issuedOutputType !== "check")
        }
    }
)
feature(
    "record scope infers an authoritative organization only with no selection and still denies another selected organization",
    {
        when() {
            const h = helper(),
                paymentId = h.draft(f),
                other = h.settlement.fixtures("ACCT_P5_OUTOTHER")
            login(f.users.paymentView)
            const saved = ec.user.getPreference("ACTIVE_ORGANIZATION")
            let positive,
                negative,
                linked = false
            try {
                ec.user.setPreference("ACTIVE_ORGANIZATION", "")
                login(f.users.paymentView)
                positive = ec.resource
                    .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
                    .paymentScope({paymentId}).organizationPartyId
                login("john.doe")
                h.call("create#mantle.party.PartyRelationship", {
                    partyRelationshipId: "OUT_OTHER_VIEW_REL",
                    fromPartyId: f.users.paymentView,
                    toPartyId: other.org,
                    relationshipTypeEnumId: "PrtAgent",
                    fromDate: 0
                })
                linked = true
                login(f.users.paymentView)
                ec.user.setPreference("ACTIVE_ORGANIZATION", other.org)
                login(f.users.paymentView)
                try {
                    ec.resource
                        .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
                        .paymentScope({paymentId})
                    negative = ""
                } catch (error) {
                    negative = error.message
                }
            } finally {
                login(f.users.paymentView)
                ec.user.setPreference("ACTIVE_ORGANIZATION", saved || "")
                login("john.doe")
                if (linked) h.call("delete#mantle.party.PartyRelationship", {partyRelationshipId: "OUT_OTHER_VIEW_REL"})
            }
            return {positive, negative}
        },
        then({positive, negative}) {
            positive == f.org
            negative.includes("PAYMENT_UNAVAILABLE") || negative.includes("ORGANIZATION_DENIED")
        }
    }
)
feature("legacy foreign and private application links are omitted while valid same-scope money remains readable", {
    when() {
        const h = helper(),
            other = h.settlement.fixtures("ACCT_P5_LINKORG"),
            privateParty = "ACCT_P5_OUT_PRIVATE"
        h.call("create#mantle.party.Party", {
            partyId: privateParty,
            partyTypeEnumId: "PtyOrganization",
            privateOwnerUserId: f.users.ap
        })
        h.call("create#mantle.party.Organization", {partyId: privateParty, organizationName: "Secret counterparty"})
        const visibleInvoice = h.settlement.invoice(f, "20"),
            privateInvoice = h.settlement.invoice(f, "20", "receivable", {
                invoiceId: "ACCT_P5_SECRET_INVOICE",
                toPartyId: privateParty
            }),
            foreignInvoice = h.settlement.invoice(other, "20", "receivable", {
                invoiceId: "ACCT_P5_FOREIGN_INVOICE",
                toPartyId: f.customer
            }),
            paymentId = h.call("create#mantle.account.payment.Payment", {
                fromPartyId: f.customer,
                toPartyId: f.org,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiOther",
                statusId: "PmntProposed",
                amount: "25",
                amountUomId: "USD",
                effectiveDate: f.timestamp
            }).paymentId,
            ids = []
        for (const org of [f.org, other.org])
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: org,
                settlementApplicationGuardEnabled: "N"
            })
        let view
        try {
            for (const invoiceId of [visibleInvoice, privateInvoice, foreignInvoice])
                ids.push(
                    h.rawApplication({paymentId, invoiceId, amountApplied: "5", appliedDate: f.timestamp}).paymentApplicationId
                )
            for (const org of [f.org, other.org])
                h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                    organizationPartyId: org,
                    settlementApplicationGuardEnabled: "Y"
                })
            login(f.users.paymentView)
            view = h.detail(f, paymentId)
        } finally {
            login("john.doe")
            for (const org of [f.org, other.org])
                h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                    organizationPartyId: org,
                    settlementApplicationGuardEnabled: "N"
                })
            for (const id of ids) h.settlement.clearImportedApplication(id)
            for (const org of [f.org, other.org])
                h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                    organizationPartyId: org,
                    settlementApplicationGuardEnabled: "Y"
                })
        }
        return {view, visibleInvoice, privateInvoice, foreignInvoice}
    },
    then({view, visibleInvoice, privateInvoice, foreignInvoice}) {
        view.applicationRows.length == 1
        view.applicationRows[0].invoiceId == visibleInvoice
        toDecimal(view.applicationRows[0].amountApplied).eq(5)
        view.complete == false
        view.errors.some(row => row.reasonCode === "APPLICATIONS_RESTRICTED")
        JSON.stringify(view).includes(privateInvoice) == false
        JSON.stringify(view).includes(foreignInvoice) == false
        toDecimal(view.totals.appliedTotal).eq(15)
        toDecimal(view.totals.unappliedTotal).eq(10)
    }
})
