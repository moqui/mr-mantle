const helper = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
let f, invoiceId, receiptId, creditId, reviewed, result
function validPreviewRequest() {
    const h = helper(),
        documentId = h.invoice(f, "1"),
        paymentId = h.payment(f, "1")
    const scope = h.scope(f),
        sourceKey = h.key("payment", paymentId),
        targetKey = h.key("invoice", documentId)
    const selected = h.native("find#OpenItems", Object.assign({}, scope, {selectedKeyList: [sourceKey, targetKey]}))
    return Object.assign({}, scope, {
        effectiveDate: f.timestamp,
        sourceVersions: selected.sourceVersions,
        allocations: [{sourceKey, targetKey, amount: "1"}]
    })
}
function ensureFiscalMonth(fixture, day) {
    const h = helper(),
        types = [],
        seen = new Set()
    let type = h.lib.one("mantle.party.time.TimePeriodType", {timePeriodTypeId: "FiscalMonth"})
    while (type) {
        if (type.periodPurposeEnumId !== "Fiscal" || seen.has(type.timePeriodTypeId))
            throw new Error("Fixture requires a valid fiscal month hierarchy")
        types.unshift(type)
        seen.add(type.timePeriodTypeId)
        type = type.parentPeriodTypeId
            ? h.lib.one("mantle.party.time.TimePeriodType", {timePeriodTypeId: type.parentPeriodTypeId})
            : null
    }
    if (!types.length) throw new Error("Fiscal month type is required")
    h.call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
        organizationPartyId: fixture.org,
        filterDate: ec.l10n.parseTimestamp(day + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
    })
    let parent = h.lib
        .find("mantle.party.time.TimePeriod", {partyId: fixture.org, timePeriodTypeId: types[0].timePeriodTypeId})
        .condition("fromDate", "less-equals", day)
        .condition("thruDate", "greater-equals", day)
        .one()
    if (!parent) throw new Error("Scoped fiscal parent is required for " + day)
    for (const childType of types.slice(1)) {
        let child = h.call("mantle.party.TimeServices.getOrCreate#TimePeriod", {
                partyId: fixture.org,
                timePeriodTypeId: childType.timePeriodTypeId,
                parentPeriodId: parent.timePeriodId,
                fromDate: parent.fromDate
            }).timePeriod,
            steps = 0
        while (h.lib.policy.calendarDateText(child.thruDate) < day) {
            if (++steps > 16) throw new Error("Fixture fiscal child did not reach " + day)
            child = h.call("mantle.party.TimeServices.getOrCreate#NextTimePeriod", {
                timePeriodId: child.timePeriodId
            }).nextTimePeriod
        }
        if (
            child.partyId !== fixture.org ||
            child.parentPeriodId !== parent.timePeriodId ||
            h.lib.policy.calendarDateText(child.fromDate) > day
        )
            throw new Error("Fixture fiscal child has invalid scope or parent")
        parent = child
    }
    return parent
}
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_SETTLE")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().base.cleanupLocks(f.org)
    }
})
feature("open items expose narrow authoritative current balances and independent page metadata", {
    when() {
        const h = helper()
        invoiceId = h.invoice(f)
        receiptId = h.payment(f)
        creditId = h.credit(f, invoiceId)
        login(f.users.ar)
        return {value: h.native("find#OpenItems", h.scope(f))}
    },
    then({value: view}) {
        view.complete == true
        view.balanceBasis == "current"
        view.invoiceRows.some(row => row.sourceId === invoiceId && toDecimal(row.remaining).eq(100))
        view.creditRows.some(row => row.sourceId === creditId && toDecimal(row.remaining).eq(25))
        view.paymentRows.some(row => row.sourceId === receiptId && toDecimal(row.remaining).eq(60))
        view.pageInfo.invoice.recordCount == 1
        view.paymentRows.every(
            row => row.paymentMethodId == null && row.paymentGatewayConfigId == null && row.overrideGlAccountId == null
        )
    }
})
feature("receipt60 and linkedcredit25 settle invoice100 atomically with remaining15", {
    when() {
        const h = helper()
        login(f.users.ar)
        reviewed = h.review(f, [
            {sourceKey: h.key("payment", receiptId), targetKey: h.key("invoice", invoiceId), amount: "60"},
            {sourceKey: h.key("credit", creditId), targetKey: h.key("invoice", invoiceId), amount: "25"}
        ])
        const retained = h.native("get#SettlementPreview", {previewId: reviewed.previewId})
        result = h.confirm(reviewed, "native-settlement-combined")
        return {retained, result}
    },
    then({retained, result}) {
        retained.inputFingerprint == reviewed.inputFingerprint
        retained.beforeBalances.find(row => row.sourceId === invoiceId).remaining == "100"
        result.applicationIds.length == 2
        result.remainingRows.find(row => row.sourceId === invoiceId).remaining == 15
        result.acctgTransIds.length == 0
        result.reasonCode == "OK"
        result.allocationResults.every(row => toDecimal(row.amountApplied).compare(0) > 0)
    }
})
feature("exact operation replay precedes consumed balances and changed reuse refuses", {
    when() {
        const h = helper()
        login(f.users.ar)
        const replay = h.confirm(reviewed, "native-settlement-combined")
        const bad = h.rejected("apply#Settlement", {
            previewId: reviewed.previewId,
            inputFingerprint: "changed",
            operationKey: "native-settlement-combined"
        })
        return {replay, bad}
    },
    then({replay, bad}) {
        replay.alreadyApplied == true
        JSON.stringify(replay.applicationIds) == JSON.stringify(result.applicationIds)
        bad.includes("OPERATION_KEY_CONFLICT")
    }
})
feature("new applications retain currency and reviewed canonical day before posting", {
    when() {
        const h = helper()
        return {
            value: result.applicationIds.map(id => ({
                application: h.lib.one("mantle.account.payment.PaymentApplication", {paymentApplicationId: id}),
                transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentApplicationId: id})
            }))
        }
    },
    then({value: rows}) {
        rows.every(
            row =>
                row.application.currencyUomId === "USD" &&
                helper().lib.policy.calendarDateText(row.application.accountingDate) === f.day
        )
        rows.every(
            row =>
                row.transactions.length === 1 &&
                row.transactions[0].isPosted === "Y" &&
                helper().lib.policy.calendarDateText(row.transactions[0].accountingDate) === f.day
        )
    }
})
feature("read only and Projects edit only cannot confirm or enumerate unauthorized balances", {
    when() {
        const h = helper(),
            denied = [],
            payload = validPreviewRequest()
        login(f.users.ar)
        const positive = h.native("preview#Settlement", payload)
        login(f.users.edit)
        denied.push(h.rejected("find#OpenItems", h.scope(f)))
        denied.push(h.rejected("preview#Settlement", payload))
        login(f.users.read)
        const read = h.native("find#OpenItems", h.scope(f))
        denied.push(h.rejected("preview#Settlement", payload))
        denied.push(
            h.rejected("find#SettlementAdjustmentAccounts", {
                organizationPartyId: f.org,
                direction: "receivable",
                effectiveDate: f.timestamp
            })
        )
        return {read, denied, positive}
    },
    then({read, denied, positive}) {
        positive.canApply == true
        read.complete == true
        read.capabilities.canApply == false
        denied.every(message => message.includes("PERMISSION_DENIED"))
    }
})
feature("treasury PAYMENT_EDIT alone never substitutes for side edit", {
    when() {
        const payload = validPreviewRequest()
        login(f.users.treasury)
        return {
            value: helper().rejected("preview#Settlement", payload)
        }
    },
    then({value: message}) {
        message.includes("PERMISSION_DENIED")
    }
})
feature("explicit account and reason writeoff completes invoice without a writeoff status", {
    when() {
        const h = helper()
        login(f.users.ar)
        const accounts = h.native("find#SettlementAdjustmentAccounts", {
            organizationPartyId: f.org,
            direction: "receivable",
            effectiveDate: f.timestamp,
            selectedIdList: ["550000000"]
        })
        const preview = h.review(
            f,
            [],
            [{invoiceId, kind: "writeoff", amount: "15", glAccountId: "550000000", reason: "Approved small residual"}]
        )
        const applied = h.confirm(preview, "native-settlement-writeoff")
        return {accounts, applied, invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId})}
    },
    then({accounts, applied, invoice}) {
        accounts.selectedRows[0].glAccountId == "550000000"
        accounts.selectedRows.every(row => row.postedBalance == null)
        applied.adjustmentInvoiceIds.length == 1
        invoice.statusId == "InvoicePmtRecvd"
        applied.remainingRows.find(row => row.sourceId === invoiceId).remaining == 0
    }
})
feature("split receipt applies exact reviewed amounts across two invoices", {
    when() {
        const h = helper(),
            a = h.invoice(f, "30"),
            b = h.invoice(f, "50"),
            p = h.payment(f, "70")
        login(f.users.ar)
        const preview = h.review(f, [
            {sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "30"},
            {sourceKey: h.key("payment", p), targetKey: h.key("invoice", b), amount: "40"}
        ])
        return {value: h.confirm(preview, "native-settlement-split")}
    },
    then({value: applied}) {
        applied.applicationIds.length == 2
        applied.remainingRows.filter(row => row.sourceKind === "invoice").some(row => toDecimal(row.remaining).eq(10))
    }
})
feature("aggregate source and target caps refuse before any application or adjustment", {
    when() {
        const h = helper(),
            a = h.invoice(f, "50"),
            b = h.invoice(f, "50"),
            p = h.payment(f, "60"),
            q = h.payment(f, "60"),
            before = h.count("mantle.account.payment.PaymentApplication")
        login(f.users.ar)
        const failures = []
        try {
            h.review(f, [
                {sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "40"},
                {sourceKey: h.key("payment", p), targetKey: h.key("invoice", b), amount: "40"}
            ])
        } catch (error) {
            failures.push(error.message)
            ec.message.clearErrors()
        }
        try {
            h.review(f, [
                {sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "40"},
                {sourceKey: h.key("payment", q), targetKey: h.key("invoice", a), amount: "40"}
            ])
        } catch (error) {
            failures.push(error.message)
            ec.message.clearErrors()
        }
        return {failures, before, after: h.count("mantle.account.payment.PaymentApplication")}
    },
    then({failures, before, after}) {
        failures.length == 2
        failures.every(message => message.includes("SETTLEMENT_EXCEEDS_BALANCE"))
        before == after
    }
})
feature("every selected target requires its original reviewed revision", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            p = h.payment(f, "10")
        login(f.users.ar)
        const list = h.native(
            "find#OpenItems",
            Object.assign(h.scope(f), {selectedKeyList: [h.key("payment", p), h.key("invoice", a)]})
        )
        return {
            value: h.rejected(
                "preview#Settlement",
                Object.assign(h.scope(f), {
                    effectiveDate: f.timestamp,
                    sourceVersions: {[h.key("payment", p)]: list.sourceVersions[h.key("payment", p)]},
                    allocations: [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "10"}]
                })
            )
        }
    },
    then({value: message}) {
        message.includes("STALE_PREVIEW")
    }
})
feature("AP side settlement posts payment to bill and refuses AR same parameters", {
    when() {
        const h = helper(),
            a = h.invoice(f, "20", "payable"),
            p = h.payment(f, "20", "payable")
        login(f.users.ar)
        const denied = h.rejected("find#OpenItems", h.scope(f, "payable"))
        login(f.users.ap)
        const preview = h.review(
            f,
            [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "20"}],
            [],
            "payable"
        )
        return {
            denied,
            applied: h.confirm(preview, "native-settlement-ap"),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId: a})
        }
    },
    then({denied, applied, invoice}) {
        denied.includes("PERMISSION_DENIED")
        applied.applicationIds.length == 1
        invoice.statusId == "InvoicePmtSent"
    }
})
feature("default off auto application changes no operation application or audit rows", {
    when() {
        const h = helper(),
            p = h.payment(f, "1")
        login(f.users.ar)
        const before = {
            ap: h.count("mantle.account.payment.PaymentApplication"),
            op: h.count("mantle.ledger.transaction.PostingOperation"),
            audit: h.auditCount()
        }
        const disabled = h.native("autoApply#Payment", {organizationPartyId: f.org, paymentId: p})
        return {
            before,
            disabled,
            after: {
                ap: h.count("mantle.account.payment.PaymentApplication"),
                op: h.count("mantle.ledger.transaction.PostingOperation"),
                audit: h.auditCount()
            }
        }
    },
    then({before, disabled, after}) {
        disabled.enabled == false
        disabled.reasonCode == "AUTO_APPLICATION_DISABLED"
        JSON.stringify(before) == JSON.stringify(after)
    }
})
feature("guard adoption is explicit and read capability explains default off", {
    when() {
        const h = helper(),
            payload = validPreviewRequest()
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            settlementApplicationGuardEnabled: "N"
        })
        login(f.users.ar)
        try {
            return {
                view: h.native("find#OpenItems", h.scope(f)),
                denied: h.rejected("preview#Settlement", payload)
            }
        } finally {
            login("john.doe")
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y"
            })
        }
    },
    then({view, denied}) {
        view.capabilities.guardEnabled == false
        view.capabilities.canApply == false
        denied.includes("SETTLEMENT_GUARD_REQUIRED")
    }
})
feature("foreign organizations and private counterparties remain unavailable with artifact authz off", {
    when() {
        const h = helper(),
            foreign = "SETTLE_FOREIGN"
        h.call("create#mantle.party.Party", {partyId: foreign, partyTypeEnumId: "PtyOrganization"})
        h.call("create#mantle.party.PartyRole", {partyId: foreign, roleTypeId: "OrgInternal"})
        login(f.users.ar)
        const org = h.rejected("find#OpenItems", Object.assign(h.scope(f), {organizationPartyId: foreign}))
        login("john.doe")
        h.call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: f.users.ap})
        login(f.users.ar)
        try {
            return {org, privateParty: h.rejected("find#OpenItems", h.scope(f))}
        } finally {
            login("john.doe")
            h.call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: null})
        }
    },
    then({org, privateParty}) {
        org.includes("ORGANIZATION_DENIED")
        privateParty.includes("PARTY_UNAVAILABLE")
    }
})
feature("active scope narrows a permitted child organization for settlement reads and confirmation", {
    when() {
        const h = helper(),
            child = h.fixtures("SETTLE_CHILD")
        h.call("create#mantle.party.PartyRelationship", {
            fromPartyId: child.org,
            toPartyId: f.org,
            relationshipTypeEnumId: "PrtOrgRollup",
            fromDate: 0
        })
        login(f.users.ar)
        const old = ec.user.getPreference("ACTIVE_ORGANIZATION")
        try {
            ec.user.setPreference("ACTIVE_ORGANIZATION", null)
            const allowed = h.native("find#OpenItems", h.scope(child))
            ec.user.setPreference("ACTIVE_ORGANIZATION", f.org)
            const denied = h.rejected("find#OpenItems", h.scope(child))
            return {allowed, denied}
        } finally {
            ec.user.setPreference("ACTIVE_ORGANIZATION", old)
        }
    },
    then({allowed, denied}) {
        allowed.complete == true
        denied.includes("ORGANIZATION_DENIED")
    }
})
feature("date-only cutoff includes the complete captured book day and preview refuses later selected rows", {
    when() {
        const h = helper(),
            late = ec.l10n.parseTimestamp(f.day + " 23:30:00", "yyyy-MM-dd HH:mm:ss"),
            a = h.invoice(f, "4", "receivable", {invoiceDate: late, accountingDate: f.day}),
            p = h.payment(f, "4"),
            cutoff = ec.l10n.parseTimestamp(f.day + " 00:00:00", "yyyy-MM-dd HH:mm:ss"),
            prior = Number(cutoff) - 86400000
        login(f.users.ar)
        const view = h.native(
            "find#OpenItems",
            Object.assign(h.scope(f), {asOfDate: cutoff, selectedKeyList: [h.key("invoice", a)]})
        )
        let denied = ""
        try {
            h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "4"}], [], "receivable", {
                asOfDate: prior
            })
        } catch (error) {
            denied = error.message
            ec.message.clearErrors()
        }
        return {view, denied, a}
    },
    then({view, denied, a}) {
        view.invoiceRows.some(row => row.sourceId === a)
        view.selectionThroughDateText == f.day
        denied.includes("OUTSIDE_SELECTION_DATE")
    }
})
feature("historical eligibility still returns current availability after later application", {
    when() {
        const h = helper(),
            a = h.invoice(f, "8"),
            p = h.payment(f, "8")
        login(f.users.ar)
        h.confirm(
            h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "8"}]),
            "settle-current-cutoff"
        )
        return {
            value: h.native(
                "find#OpenItems",
                Object.assign(h.scope(f), {asOfDate: f.timestamp, selectedKeyList: [h.key("invoice", a), h.key("payment", p)]})
            )
        }
    },
    then({value: view}) {
        view.balanceBasis == "current"
        view.selectedRows.every(row => toDecimal(row.remaining).isZero() && row.reasons.includes("NO_REMAINING_BALANCE"))
        view.invoiceRows.every(row => toDecimal(row.remaining).compare(0) > 0)
    }
})
feature("currency precision and effective dates earlier than source documents refuse without writes", {
    when() {
        const h = helper(),
            a = h.invoice(f, "5"),
            p = h.payment(f, "5"),
            before = h.count("mantle.account.payment.PaymentApplication"),
            messages = []
        login(f.users.ar)
        for (const extra of [
            {allocations: [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "0.001"}]},
            {effectiveDate: Number(f.timestamp) - 86400000}
        ])
            try {
                h.review(
                    f,
                    [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "1"}],
                    [],
                    "receivable",
                    extra
                )
            } catch (error) {
                messages.push(error.message)
                ec.message.clearErrors()
            }
        return {messages, before, after: h.count("mantle.account.payment.PaymentApplication")}
    },
    then({messages, before, after}) {
        messages.some(message => message.includes("CURRENCY_PRECISION"))
        messages.some(message => message.includes("APPLICATION_BEFORE_SOURCE"))
        before == after
    }
})
feature("fresh review refuses cross currency selections through the same scoped key contract", {
    when() {
        const h = helper(),
            p = h.payment(f, "3"),
            foreign = h.call("create#mantle.account.invoice.Invoice", {
                fromPartyId: f.org,
                toPartyId: f.customer,
                invoiceTypeEnumId: "InvoiceSales",
                statusId: "InvoiceInProcess",
                invoiceDate: f.timestamp,
                accountingDate: f.day,
                currencyUomId: "EUR"
            }).invoiceId
        login(f.users.ar)
        const list = h.native(
            "find#OpenItems",
            Object.assign(h.scope(f), {selectedKeyList: [h.key("payment", p), h.key("invoice", foreign)]})
        )
        return {
            list,
            message: h.rejected(
                "preview#Settlement",
                Object.assign(h.scope(f), {
                    effectiveDate: f.timestamp,
                    sourceVersions: list.sourceVersions,
                    allocations: [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", foreign), amount: "1"}]
                })
            )
        }
    },
    then({list, message}) {
        list.selectedRows.length == 1
        message.includes("SETTLEMENT_RECORD_UNAVAILABLE")
    }
})
feature("a changed application invalidates retained review before any new money is written", {
    when() {
        const h = helper(),
            a = h.invoice(f, "20"),
            p = h.payment(f, "20")
        login(f.users.ar)
        const preview = h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "20"}])
        h.call("mantle.account.PaymentServices.apply#InvoicePayment", {paymentId: p, invoiceId: a, amount: "1"})
        login(f.users.ar)
        const denied = h.rejected("apply#Settlement", {
            previewId: preview.previewId,
            inputFingerprint: preview.inputFingerprint,
            operationKey: "settle-stale-review"
        })
        return {denied, count: h.count("mantle.account.payment.PaymentApplication", {paymentId: p})}
    },
    then({denied, count}) {
        denied.includes("STALE_PREVIEW")
        count == 1
    }
})
feature("an unrelated posting does not stale reviewed assignment policy", {
    when() {
        const h = helper(),
            a = h.invoice(f, "9"),
            p = h.payment(f, "9")
        login(f.users.ar)
        const preview = h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "9"}])
        login("john.doe")
        h.invoice(f, "11")
        h.payment(f, "11")
        login(f.users.ar)
        return {value: h.confirm(preview, "settle-unrelated-post")}
    },
    then({value: applied}) {
        applied.reasonCode == "OK"
        applied.applicationIds.length == 1
    }
})
feature("closed original fiscal history does not prevent a new application in an open current month", {
    when() {
        const h = helper(),
            date = new Date(Number(f.timestamp))
        date.setUTCDate(15)
        date.setUTCMonth(date.getUTCMonth() - 1)
        const oldDay = ec.l10n.format(date, "yyyy-MM-dd"),
            oldTimestamp = ec.l10n.parseTimestamp(oldDay + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
        const period = ensureFiscalMonth(f, oldDay),
            currentPeriod = ensureFiscalMonth(f, f.day)
        if (period.timePeriodId === currentPeriod.timePeriodId || h.lib.policy.calendarDateText(period.thruDate) >= f.day)
            throw new Error("A distinct prior fiscal month is required")
        const currentFiscal = Array.from(
            h.lib
                .find("mantle.party.time.TimePeriodAndType", {partyId: f.org, periodPurposeEnumId: "Fiscal"})
                .condition("fromDate", "less-equals", f.day)
                .condition("thruDate", "greater-equals", f.day)
                .list()
        )
        if (!currentFiscal.length || currentFiscal.some(row => row.isClosed === "Y"))
            throw new Error("Current fiscal application periods must be open")
        const a = h.invoice(f, "7", "receivable", {invoiceDate: oldTimestamp, accountingDate: oldDay}),
            p = h.payment(f, "7")
        const wasClosed = period.isClosed || "N"
        h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
        try {
            login(f.users.ar)
            return {
                value: h.confirm(
                    h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "7"}]),
                    "settle-closed-original"
                )
            }
        } finally {
            login("john.doe")
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: wasClosed})
        }
    },
    then({value: applied}) {
        applied.reasonCode == "OK"
        applied.accountingDateText == f.day
    }
})
feature("automatic plan is retained deterministic and replays without duplicate applications", {
    when() {
        const h = helper()
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            paymentAutoApplicationEnabled: "Y"
        })
        const p = h.payment(f, "2")
        login(f.users.ar)
        const list = h.native("find#OpenItems", Object.assign(h.scope(f), {selectedKeyList: [h.key("payment", p)]}))
        const preview = h.native("preview#PaymentAutoApplication", {
            organizationPartyId: f.org,
            paymentId: p,
            effectiveDate: f.timestamp,
            sourceVersion: list.sourceVersions[h.key("payment", p)]
        })
        const params = {
            organizationPartyId: f.org,
            paymentId: p,
            previewId: preview.previewId,
            inputFingerprint: preview.inputFingerprint,
            operationKey: "settle-auto-reviewed"
        }
        const first = h.native("autoApply#Payment", params),
            retry = h.native("autoApply#Payment", params)
        return {first, retry, preview, expectedFirst: list.invoiceRows[0].sourceId}
    },
    then({first, retry, preview, expectedFirst}) {
        first.enabled == true
        first.applicationIds.length > 0
        retry.alreadyApplied == true
        JSON.stringify(first.applicationIds) == JSON.stringify(retry.applicationIds)
        preview.allocationRows.every(row => row.sourceKind === "payment")
        preview.allocationRows[0].targetId == expectedFirst
    }
})
feature("PAYMENT_VIEW alone reads safe balances but cannot preview and never receives bank details", {
    when() {
        const h = helper(),
            user = h.user(f, "PAY_READ", ["PAYMENT_VIEW"]),
            payload = validPreviewRequest()
        login(user)
        return {
            view: h.native("find#OpenItems", h.scope(f)),
            denied: h.rejected("preview#Settlement", payload)
        }
    },
    then({view, denied}) {
        view.complete == true
        view.capabilities.canApply == false
        view.paymentRows.every(
            row => row.paymentMethodId == null && row.paymentGatewayConfigId == null && row.bankAccountNumber == null
        )
        denied.includes("PERMISSION_DENIED")
    }
})
feature("retained ledger evidence is redacted after the owner loses ledger view authority", {
    when() {
        const h = helper(),
            user = h.user(f, "LEDGER", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW", "ACCOUNTING_VIEW"]),
            a = h.invoice(f, "3"),
            p = h.payment(f, "3")
        login(user)
        const preview = h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "3"}])
        login("john.doe")
        h.call("delete#moqui.security.UserGroupPermission", {userGroupId: user, userPermissionId: "ACCOUNTING_VIEW", fromDate: 0})
        login(user)
        const retained = h.native("get#SettlementPreview", {previewId: preview.previewId})
        return {preview, retained}
    },
    then({preview, retained}) {
        preview.ledgerPreview.length == 2
        retained.capabilities.canReadLedger == false
        retained.ledgerPreview.length == 0
        retained.canApply == true
    }
})
feature("expired previews remain readable but cannot be confirmed", {
    when() {
        const h = helper(),
            a = h.invoice(f, "2"),
            p = h.payment(f, "2")
        login(f.users.ar)
        const preview = h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "2"}])
        h.call("update#mantle.account.payment.SettlementPreview", {
            previewId: preview.previewId,
            expiresDate: Number(ec.user.nowTimestamp) - 1
        })
        return {
            retained: h.native("get#SettlementPreview", {previewId: preview.previewId}),
            denied: h.rejected("apply#Settlement", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "settle-expired"
            })
        }
    },
    then({retained, denied}) {
        retained.status == "review"
        retained.canApply == false
        denied.includes("SETTLEMENT_PREVIEW_EXPIRED")
    }
})
feature("active dated account choices omit an expired nearest assignment and preserve selected valid identities", {
    when() {
        const h = helper(),
            account = "550000000",
            assignment = h.lib.one("mantle.ledger.account.GlAccountOrganization", {
                organizationPartyId: f.org,
                glAccountId: account
            })
        h.call("update#mantle.ledger.account.GlAccountOrganization", {
            organizationPartyId: f.org,
            glAccountId: account,
            thruDate: Number(f.timestamp) - 1
        })
        login(f.users.ar)
        try {
            return {
                value: h.native("find#SettlementAdjustmentAccounts", {
                    organizationPartyId: f.org,
                    direction: "receivable",
                    effectiveDate: f.timestamp,
                    text: "550000000",
                    selectedIdList: [account, "412000000"]
                })
            }
        } finally {
            login("john.doe")
            h.call("update#mantle.ledger.account.GlAccountOrganization", {
                organizationPartyId: f.org,
                glAccountId: account,
                thruDate: assignment.thruDate
            })
        }
    },
    then({value: view}) {
        view.rows.length == 0
        view.selectedRows.every(row => row.glAccountId !== "550000000")
        view.selectedRows.some(row => row.glAccountId === "412000000")
        view.complete == true
    }
})
feature("a payment already posted directly against its invoice needs no extra application journal", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            direct = h.legacyDirectPayment(f, a, "10"),
            p = direct.paymentId
        login(f.users.ar)
        const preview = h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "10"}])
        const applied = h.confirm(preview, "settle-direct-posted")
        return {
            applied,
            application: h.lib.one("mantle.account.payment.PaymentApplication", {
                paymentApplicationId: applied.applicationIds[0]
            }),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentApplicationId: applied.applicationIds[0]}),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId: a})
        }
    },
    then({applied, application, transactions, invoice}) {
        applied.allocationResults[0].reasonCode == "ALREADY_POSTED_DIRECT"
        application.acctgTransResultEnumId == "AtrPaymentNotPosted"
        transactions.length == 0
        invoice.statusId == "InvoicePmtRecvd"
        helper().lib.ms(invoice.paidDate) == Number(f.timestamp)
    }
})
feature("incomplete posted source control amount cannot fund a larger payment record", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            p = h.directPayment(f, a, "10", "1"),
            before = h.count("mantle.account.payment.PaymentApplication")
        login(f.users.ar)
        let message = ""
        try {
            h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "10"}])
        } catch (error) {
            message = error.message
            ec.message.clearErrors()
        }
        return {message, before, after: h.count("mantle.account.payment.PaymentApplication")}
    },
    then({message, before, after}) {
        message.includes("SOURCE_POSTING_INCOMPLETE")
        before == after
    }
})
feature("fully settled finalized invoices and credits retain the reviewed paid effective timestamp", {
    when() {
        const h = helper()
        return {
            value: [invoiceId, creditId, ...result.adjustmentInvoiceIds].map(id =>
                h.lib.one(h.lib.invoiceEntity, {invoiceId: id})
            )
        }
    },
    then({value: rows}) {
        rows.every(
            row =>
                ["InvoicePmtRecvd", "InvoicePmtSent"].includes(row.statusId) &&
                helper().lib.ms(row.paidDate) === Number(f.timestamp)
        )
    }
})
feature("caller failure after a complete settlement rolls back applications adjustments postings and operation evidence", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            p = h.payment(f, "5"),
            preview = h.review(
                f,
                [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "5"}],
                [{invoiceId: a, kind: "discount", amount: "5", glAccountId: "550000000", reason: "Reviewed discount"}]
            )
        const before = {
            applications: h.count("mantle.account.payment.PaymentApplication"),
            invoices: h.count("mantle.account.invoice.Invoice"),
            transactions: h.count("mantle.ledger.transaction.AcctgTrans")
        }
        let failure = ""
        try {
            parallel(
                1,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    const result = call("mantle.account.PaymentServices.apply#Settlement", args)
                    if (result.applicationIds.length !== 2) throw new Error("Unexpected result")
                    throw new Error("CALLER_FAILURE_AFTER_SETTLEMENT")
                },
                {
                    previewId: preview.previewId,
                    inputFingerprint: preview.inputFingerprint,
                    operationKey: "settle-caller-rollback"
                },
                {transaction: true, timeout: 30}
            )
        } catch (error) {
            failure = error.message
            ec.message.clearErrors()
        }
        return {
            failure,
            before,
            after: {
                applications: h.count("mantle.account.payment.PaymentApplication"),
                invoices: h.count("mantle.account.invoice.Invoice"),
                transactions: h.count("mantle.ledger.transaction.AcctgTrans")
            },
            operation: h.lib.one("mantle.ledger.transaction.PostingOperation", {operationKey: "settle-caller-rollback"}),
            retained: h.native("get#SettlementPreview", {previewId: preview.previewId})
        }
    },
    then({failure, before, after, operation, retained}) {
        failure.includes("CALLER_FAILURE_AFTER_SETTLEMENT")
        JSON.stringify(before) == JSON.stringify(after)
        operation == null
        retained.status == "review"
    }
})
feature("more than200 open invoices stay paginated while a small selected subset remains settleable", {
    when() {
        const h = helper(),
            many = Object.assign({}, f, {customer: "SETTLE_MANY_CUSTOMER"})
        h.call("create#mantle.party.Party", {partyId: many.customer, partyTypeEnumId: "PtyOrganization"})
        h.call("create#mantle.party.Organization", {partyId: many.customer, organizationName: "Large open-item customer"})
        h.call("create#mantle.party.PartyRole", {partyId: many.customer, roleTypeId: "Customer"})
        const ids = []
        for (let i = 0; i < 201; i++) ids.push(h.invoice(many, "1"))
        const payment = h.payment(many, "3")
        login(f.users.ar)
        const view = h.native(
            "find#OpenItems",
            Object.assign(h.scope(many), {
                sourceKind: "invoice",
                pageSize: 20,
                text: ids[0],
                selectedKeyList: [h.key("invoice", ids[200])]
            })
        )
        const full = h.native(
            "find#OpenItems",
            Object.assign(h.scope(many), {sourceKind: "invoice", pageIndex: 10, pageSize: 20})
        )
        const applied = h.confirm(
            h.review(
                many,
                ids.slice(-3).map(id => ({sourceKey: h.key("payment", payment), targetKey: h.key("invoice", id), amount: "1"}))
            ),
            "settle-large-selected"
        )
        return {view, full, applied, last: ids[200], first: ids[0]}
    },
    then({view, full, applied, last, first}) {
        view.complete == true
        view.rows.length == 1
        view.rows[0].sourceId == first
        view.selectedRows.some(row => row.sourceId === last)
        full.recordCount == 201
        full.pageIndex == 10
        full.rows.length == 1
        applied.applicationIds.length == 3
    }
})
feature("reviewed direct cash inherits its invoice bookday across Chicago to UTC without stamping legacy payment", {
    when() {
        const h = helper(),
            user = h.user(f, "BOOK_DAY", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW"]),
            late = ec.l10n.parseTimestamp(f.day + " 23:30:00", "yyyy-MM-dd HH:mm:ss"),
            a = h.invoice(f, "6", "receivable", {invoiceDate: late, accountingDate: f.day}),
            p = h.legacyDirectPayment(Object.assign({}, f, {timestamp: late}), a, "6").paymentId
        login(user)
        const preview = h.review(
            f,
            [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "6"}],
            [],
            "receivable",
            {effectiveDate: late, asOfDate: late}
        )
        login("john.doe")
        h.call("update#moqui.security.UserAccount", {userId: user, timeZone: "UTC"})
        login(user)
        const applied = h.confirm(preview, "settle-viewer-zone")
        const payment = h.lib.one("mantle.account.payment.Payment", {paymentId: p})
        return {preview, applied, payment}
    },
    then({preview, applied, payment}) {
        preview.accountingDateText == f.day
        applied.accountingDateText == f.day
        payment.accountingDate == null
        applied.reasonCode == "OK"
    }
})
feature("original #kind posting currency must match both scoped financial records", {
    where: [{kind: "source"}, {kind: "target"}],
    when({kind}) {
        const h = helper(),
            a = h.invoice(f, "3"),
            p = h.payment(f, "3"),
            tx = h.lib.rows("mantle.ledger.transaction.AcctgTrans", kind === "source" ? {paymentId: p} : {invoiceId: a})[0]
        h.call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: tx.acctgTransId})
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, postingGuardEnabled: "N"})
        let message = ""
        try {
            h.call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId, amountUomId: "EUR"})
            h.repostReviewed(tx.acctgTransId)
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, postingGuardEnabled: "Y"})
            login(f.users.ar)
            try {
                h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "3"}])
            } catch (error) {
                message = error.message
                ec.message.clearErrors()
            }
        } finally {
            login("john.doe")
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, postingGuardEnabled: "Y"})
            const current = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId})
            if (current.isPosted === "Y")
                h.call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: tx.acctgTransId})
            h.call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId, amountUomId: "USD"})
            h.repostReviewed(tx.acctgTransId)
        }
        return {message, applications: h.count("mantle.account.payment.PaymentApplication", {paymentId: p})}
    },
    then({message, applications}) {
        message.includes("SOURCE_POSTING_CURRENCY_MISMATCH")
        applications == 0
    }
})
feature("budget #kind backing cannot fund an actual trade settlement", {
    where: [{kind: "source"}, {kind: "target"}],
    when({kind}) {
        const h = helper(),
            a = h.invoice(f, "3"),
            p = h.payment(f, "3"),
            tx = h.lib.rows("mantle.ledger.transaction.AcctgTrans", kind === "source" ? {paymentId: p} : {invoiceId: a})[0]
        h.call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: tx.acctgTransId})
        let message = ""
        try {
            h.call("update#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: tx.acctgTransId,
                glFiscalTypeEnumId: "GLFT_BUDGET"
            })
            h.repostReviewed(tx.acctgTransId)
            login(f.users.ar)
            try {
                h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "3"}])
            } catch (error) {
                message = error.message
                ec.message.clearErrors()
            }
        } finally {
            login("john.doe")
            const current = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId})
            if (current.isPosted === "Y")
                h.call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: tx.acctgTransId})
            h.call("update#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: tx.acctgTransId,
                glFiscalTypeEnumId: "GLFT_ACTUAL"
            })
            h.repostReviewed(tx.acctgTransId)
        }
        return {message, applications: h.count("mantle.account.payment.PaymentApplication", {paymentId: p})}
    },
    then({message, applications}) {
        message.includes("SOURCE_POSTING_NOT_ACTUAL")
        applications == 0
    }
})
feature("independently adopted settlement captures application and adjustment bookday with general posting guard off", {
    when() {
        const h = helper(),
            g = h.fixtures("SETTLE_INDEP"),
            bookDay = "2026-10-31",
            sourceTime = Date.UTC(2026, 10, 1, 4, 30),
            effectiveDate = Date.UTC(2026, 10, 1, 4, 45),
            user = h.user(g, "INDEP_DAY", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW"]),
            prior = h.lib.policy.preference(g.org)
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: g.org,
            postingGuardEnabled: "N",
            realTimeGlSummary: "Y"
        })
        try {
            const october = ensureFiscalMonth(g, bookDay),
                november = ensureFiscalMonth(g, "2026-11-01")
            const a = h.invoice(g, "10", "receivable", {invoiceDate: sourceTime, accountingDate: bookDay}),
                p = h.legacyDirectPayment(Object.assign({}, g, {timestamp: sourceTime}), a, "5").paymentId
            const movement = id =>
                h.lib
                    .rows("mantle.ledger.account.GlAccountOrgTimePeriod", {organizationPartyId: g.org, timePeriodId: id})
                    .reduce((total, row) => total.add(row.postedDebits || 0), toDecimal(0))
            const beforeOct = movement(october.timePeriodId),
                beforeNov = movement(november.timePeriodId)
            login(user)
            const preview = h.review(
                g,
                [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "5"}],
                [{invoiceId: a, kind: "discount", amount: "5", glAccountId: "550000000", reason: "Reviewed independent control"}],
                "receivable",
                {effectiveDate, asOfDate: effectiveDate}
            )
            login("john.doe")
            h.call("update#moqui.security.UserAccount", {userId: user, timeZone: "UTC"})
            login(user)
            const applied = h.confirm(preview, "settle-independent-day"),
                transactions = []
            for (const id of applied.applicationIds)
                transactions.push(...h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentApplicationId: id}))
            for (const id of applied.adjustmentInvoiceIds)
                transactions.push(
                    ...h.lib
                        .rows("mantle.ledger.transaction.AcctgTrans", {invoiceId: id})
                        .filter(row => !row.paymentApplicationId)
                )
            return {
                preview,
                applied,
                transactions,
                payment: h.lib.one("mantle.account.payment.Payment", {paymentId: p}),
                octoberDelta: movement(october.timePeriodId).subtract(beforeOct),
                novemberDelta: movement(november.timePeriodId).subtract(beforeNov),
                bookDay,
                effectiveDate
            }
        } finally {
            login("john.doe")
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: g.org,
                postingGuardEnabled: prior.postingGuardEnabled,
                realTimeGlSummary: prior.realTimeGlSummary || null
            })
        }
    },
    then({preview, applied, transactions, payment, octoberDelta, novemberDelta, bookDay, effectiveDate}) {
        preview.accountingDateText == bookDay
        applied.accountingDateText == bookDay
        payment.accountingDate == null
        applied.applicationIds.length == 2
        applied.allocationResults[0].reasonCode == "ALREADY_POSTED_DIRECT"
        transactions.length == 2
        transactions.every(
            row =>
                row.isPosted === "Y" &&
                helper().lib.policy.calendarDateText(row.accountingDate) === bookDay &&
                helper().lib.ms(row.transactionDate) === effectiveDate
        )
        octoberDelta == 10
        novemberDelta == 0
    }
})
feature("a posted orphan reversal invalidates original cash even without its reverse backlink", {
    when() {
        const h = helper(),
            a = h.invoice(f, "3"),
            p = h.payment(f, "3"),
            original = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: p})[0],
            reverse = h.call("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
                acctgTransId: original.acctgTransId,
                createOnly: true,
                changeReason: "Legacy orphan reversal fixture"
            }).acctgTransId
        let message = ""
        try {
            h.call("update#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: original.acctgTransId,
                reversedByAcctgTransId: null
            })
            h.repostReviewed(reverse)
            login(f.users.ar)
            try {
                h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "3"}])
            } catch (error) {
                message = error.message
                ec.message.clearErrors()
            }
        } finally {
            login("john.doe")
            const reversal = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: reverse})
            if (reversal?.isPosted === "Y") h.call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: reverse})
            for (const entry of h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: reverse}))
                h.call("delete#mantle.ledger.transaction.AcctgTransEntry", {
                    acctgTransId: reverse,
                    acctgTransEntrySeqId: entry.acctgTransEntrySeqId
                })
            if (reversal) h.call("delete#mantle.ledger.transaction.AcctgTrans", {acctgTransId: reverse})
            h.call("update#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: original.acctgTransId,
                reversedByAcctgTransId: null
            })
        }
        return {message, applications: h.count("mantle.account.payment.PaymentApplication", {paymentId: p})}
    },
    then({message, applications}) {
        message.includes("SOURCE_POSTING_REVERSED")
        applications == 0
    }
})
feature("undated #kind GL history in the next UTC day refuses an earlier Chicago application without backfill", {
    where: [{kind: "source"}, {kind: "target"}],
    when({kind}) {
        const h = helper(),
            late = ec.l10n.parseTimestamp(f.day + " 23:30:00", "yyyy-MM-dd HH:mm:ss"),
            a = h.invoice(f, "4", "receivable", kind === "target" ? {invoiceDate: late, accountingDate: null} : {}),
            p = h.payment(f, "4", "receivable", kind === "source" ? {effectiveDate: late} : {}),
            tx = h.lib.rows("mantle.ledger.transaction.AcctgTrans", kind === "source" ? {paymentId: p} : {invoiceId: a})[0]
        login(f.users.ar)
        let message = ""
        try {
            h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "4"}], [], "receivable", {
                asOfDate: late
            })
        } catch (error) {
            message = error.message
            ec.message.clearErrors()
        }
        return {
            message,
            beforeDay: tx.accountingDate,
            after: h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId}),
            applications: h.count("mantle.account.payment.PaymentApplication", {paymentId: p}),
            expected: new Date(h.lib.ms(late)).toISOString().slice(0, 10)
        }
    },
    then({message, beforeDay, after, applications, expected}) {
        message.includes("APPLICATION_BEFORE_SOURCE_POSTING")
        beforeDay == null
        after.accountingDate == null
        helper().lib.policy.postingDay(after) == expected
        expected > f.day
        applications == 0
    }
})
feature("partial restoration of directly posted cash refuses without any new application or GL", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            p = h.legacyDirectPayment(f, a, "10").paymentId,
            before = {
                applications: h.count("mantle.account.payment.PaymentApplication"),
                transactions: h.count("mantle.ledger.transaction.AcctgTrans")
            }
        login(f.users.ar)
        let message = ""
        try {
            h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "5"}])
        } catch (error) {
            message = error.message
            ec.message.clearErrors()
        }
        return {
            message,
            before,
            after: {
                applications: h.count("mantle.account.payment.PaymentApplication"),
                transactions: h.count("mantle.ledger.transaction.AcctgTrans")
            }
        }
    },
    then({message, before, after}) {
        message.includes("DIRECT_PAYMENT_RESTORE_REQUIRED")
        JSON.stringify(before) == JSON.stringify(after)
    }
})
feature("direct cash restores its whole currently remaining amount after legacy same-invoice consumption", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            p = h.legacyDirectPayment(f, a, "10").paymentId,
            earlier = h.importedApplication(f, {paymentId: p, invoiceId: a, amount: "4"})
        login(f.users.ar)
        const applied = h.confirm(
            h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "6"}]),
            "settle-direct-remaining"
        )
        return {
            applied,
            earlier: h.lib.one("mantle.account.payment.PaymentApplication", {paymentApplicationId: earlier.paymentApplicationId}),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentApplicationId: applied.applicationIds[0]})
        }
    },
    then({applied, earlier, transactions}) {
        applied.allocationResults[0].amountApplied == 6
        applied.allocationResults[0].reasonCode == "ALREADY_POSTED_DIRECT"
        earlier.amountApplied == 4
        transactions.length == 0
        applied.remainingRows.every(row => toDecimal(row.remaining).isZero())
    }
})
feature("inconsistent prior off-invoice direct applications refuse restoration instead of claiming no-extra GL", {
    when() {
        const h = helper(),
            a = h.invoice(f, "10"),
            b = h.invoice(f, "3"),
            p = h.legacyDirectPayment(f, a, "10").paymentId,
            other = h.importedApplication(f, {paymentId: p, invoiceId: b, amount: "3"})
        let message = ""
        const before = h.count("mantle.account.payment.PaymentApplication")
        try {
            login(f.users.ar)
            try {
                h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "7"}])
            } catch (error) {
                message = error.message
                ec.message.clearErrors()
            }
            return {
                message,
                before,
                after: h.count("mantle.account.payment.PaymentApplication"),
                other: h.lib.one("mantle.account.payment.PaymentApplication", {paymentApplicationId: other.paymentApplicationId})
            }
        } finally {
            login("john.doe")
            h.clearImportedApplication(other.paymentApplicationId, b)
        }
    },
    then({message, before, after, other}) {
        message.includes("DIRECT_PAYMENT_HISTORY_INCONSISTENT")
        other.acctgTransResultEnumId == "AtrPaymentNotPosted"
        before == after
    }
})
feature("correctly posted off-invoice history remains eligible when actual cash backing is unapplied", {
    when() {
        const h = helper(),
            a = h.invoice(f, "5"),
            b = h.invoice(f, "5"),
            p = h.payment(f, "10"),
            record = h.lib.one("mantle.account.payment.Payment", {paymentId: p})
        record.set("forInvoiceId", a)
        record.update()
        const earlier = h.native("apply#InvoicePayment", {paymentId: p, invoiceId: b, amount: "5"})
        login(f.users.ar)
        const applied = h.confirm(
            h.review(f, [{sourceKey: h.key("payment", p), targetKey: h.key("invoice", a), amount: "5"}]),
            "settle-unapplied-history"
        )
        return {
            applied,
            previous: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentApplicationId: earlier.paymentApplicationId}),
            current: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentApplicationId: applied.applicationIds[0]})
        }
    },
    then({applied, previous, current}) {
        applied.allocationResults[0].reasonCode == "OK"
        previous.length == 1
        previous[0].isPosted == "Y"
        current.length == 1
        current[0].isPosted == "Y"
        applied.remainingRows.every(row => toDecimal(row.remaining).isZero())
    }
})
