// Bounded review blockers and final financial refusal controls. No browser or screenshot dependency.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentRefundFixtures.js")
let f, l
function flags(fixture, posting, settlement) {
    helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: fixture.org,
        postingGuardEnabled: posting,
        settlementApplicationGuardEnabled: settlement
    })
}
function legacyCash(amount = "60", extra = {}) {
    return helper().lifecycle.settlement.payment(
        l,
        amount,
        "receivable",
        Object.assign({paymentInstrumentEnumId: "PiOther", toPaymentMethodId: l.methodId}, extra)
    )
}
function rawStatus(paymentId, statusId) {
    return parallel(
        1,
        (thread, args) => {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const row = ec.entity
                .find("mantle.account.payment.Payment")
                .condition("paymentId", args.paymentId)
                .forUpdate(true)
                .one()
            row.set("statusId", args.statusId)
            row.update()
            return true
        },
        {paymentId, statusId},
        {transaction: true, timeout: 30}
    )[0]
}
function month(day) {
    const h = helper(),
        types = [],
        seen = new Set()
    let type = h.lib.one("mantle.party.time.TimePeriodType", {timePeriodTypeId: "FiscalMonth"})
    while (type) {
        if (type.periodPurposeEnumId !== "Fiscal" || seen.has(type.timePeriodTypeId))
            throw new Error("Invalid fiscal fixture hierarchy")
        types.unshift(type)
        seen.add(type.timePeriodTypeId)
        type = type.parentPeriodTypeId
            ? h.lib.one("mantle.party.time.TimePeriodType", {timePeriodTypeId: type.parentPeriodTypeId})
            : null
    }
    h.call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
        organizationPartyId: f.org,
        filterDate: ec.l10n.parseTimestamp(day + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
    })
    let parent = h.lib
        .find("mantle.party.time.TimePeriod", {partyId: f.org, timePeriodTypeId: types[0].timePeriodTypeId})
        .condition("fromDate", "less-equals", day)
        .condition("thruDate", "greater-equals", day)
        .one()
    if (!parent) throw new Error("Fiscal fixture parent missing")
    for (const childType of types.slice(1)) {
        let child = h.call("mantle.party.TimeServices.getOrCreate#TimePeriod", {
                partyId: f.org,
                timePeriodTypeId: childType.timePeriodTypeId,
                parentPeriodId: parent.timePeriodId,
                fromDate: parent.fromDate
            }).timePeriod,
            steps = 0
        while (h.lib.policy.calendarDateText(child.thruDate) < day) {
            if (++steps > 16) throw new Error("Fiscal fixture did not reach requested month")
            child = h.call("mantle.party.TimeServices.getOrCreate#NextTimePeriod", {
                timePeriodId: child.timePeriodId
            }).nextTimePeriod
        }
        parent = child
    }
    return parent
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_REF_FINAL")
        l = helper().fixtures("ACCT_P5_RF_LEG")
        flags(l, "N", "N")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        for (const fixture of [f, l]) if (fixture?.org) helper().lifecycle.settlement.base.cleanupLocks(fixture.org)
    }
})
feature("legacy cash, reclassification and abandoned child history have truthful complete and unavailable outcomes", {
    when() {
        const h = helper()
        flags(l, "N", "N")
        const original = legacyCash(),
            refund = h.call("mantle.account.PaymentServices.create#RefundPayment", {
                paymentId: original,
                amount: "20",
                amountUomId: "USD",
                paymentInstrumentEnumId: "PiOther",
                paymentMethodId: l.methodId,
                statusId: "PmntDelivered",
                effectiveDate: l.timestamp
            }),
            appTx = h.lib.one("mantle.ledger.transaction.AcctgTrans", {paymentApplicationId: refund.paymentApplicationId}),
            badCash = legacyCash("60", {overrideGlAccountId: "550000000"}),
            clean = legacyCash("30")
        h.call("mantle.account.PaymentServices.create#RefundPayment", {
            paymentId: clean,
            amount: "5",
            amountUomId: "USD",
            paymentInstrumentEnumId: "PiOther",
            paymentMethodId: l.methodId,
            statusId: "PmntCancelled",
            effectiveDate: l.timestamp
        })
        flags(l, "N", "Y")
        const valid = h.native("get#PaymentRefundSummary", {organizationPartyId: l.org, paymentId: original}),
            legacyRefused = h.lifecycle.rejected("preview#PaymentRefund", h.request(l, original)),
            bad = h.native("get#PaymentRefundSummary", {organizationPartyId: l.org, paymentId: badCash}),
            abandoned = h.native("get#PaymentRefundSummary", {organizationPartyId: l.org, paymentId: clean})
        let missing, tampered
        flags(l, "N", "N")
        h.call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: appTx.acctgTransId})
        try {
            flags(l, "N", "Y")
            missing = h.native("get#PaymentRefundSummary", {organizationPartyId: l.org, paymentId: original})
        } finally {
            flags(l, "N", "N")
            h.call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: appTx.acctgTransId})
        }
        rawStatus(refund.paymentId, "PmntVoid")
        try {
            flags(l, "N", "Y")
            tampered = h.native("get#PaymentRefundSummary", {organizationPartyId: l.org, paymentId: original})
        } finally {
            flags(l, "N", "N")
            rawStatus(refund.paymentId, "PmntDelivered")
            flags(l, "N", "Y")
        }
        const euroMethod = "REF_EUR_" + ec.user.randomString(20)
        h.call("create#mantle.account.method.PaymentMethod", {
            paymentMethodId: euroMethod,
            ownerPartyId: l.org,
            paymentMethodTypeEnumId: "PmtOther",
            currencyUomId: "EUR",
            glAccountId: "111100000",
            fromDate: 0
        })
        flags(l, "N", "N")
        const foreign = legacyCash("60", {amountUomId: "EUR", toPaymentMethodId: euroMethod})
        flags(l, "N", "Y")
        const foreignMethod = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: euroMethod}),
            module = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
            foreignDenied = h.lifecycle.rejected(
                "preview#PaymentRefund",
                Object.assign(h.request(l, foreign), {
                    organizationPaymentMethodId: euroMethod,
                    organizationMethodVersion: module.methodVersion(foreignMethod)
                })
            )
        return {
            valid,
            legacyRefused,
            bad,
            abandoned,
            missing,
            tampered,
            foreignDenied,
            foreignTx: h.lib.one("mantle.ledger.transaction.AcctgTrans", {paymentId: foreign}),
            foreignMethod
        }
    },
    then({valid, legacyRefused, bad, abandoned, missing, tampered, foreignDenied, foreignTx, foreignMethod}) {
        valid.refundSummary.complete == true
        toDecimal(valid.refundSummary.completedRefundAmount).eq(20)
        toDecimal(valid.refundSummary.refundableAmount).eq(40)
        valid.capabilities.canRefund == false
        legacyRefused.includes("LEGACY_REFUND_HISTORY_REVIEW_REQUIRED")
        bad.refundSummary.complete == false
        bad.refundSummary.refundableAmount == null
        abandoned.refundSummary.complete == true
        toDecimal(abandoned.refundSummary.refundableAmount).eq(30)
        missing.refundSummary.complete == false
        missing.refundSummary.reasons.includes("REFUND_HISTORY_INCONSISTENT")
        tampered.refundSummary.complete == false
        tampered.refundSummary.reasons.includes("REFUND_HISTORY_INCONSISTENT")
        foreignMethod.currencyUomId == "EUR"
        foreignTx.isPosted == "Y"
        foreignDenied.includes("CURRENCY_MISMATCH")
    }
})
feature("confirmation rechecks stale source, draft, banking identity, evidence, policy and current owner authority", {
    when() {
        const h = helper(),
            errors = []
        for (const change of ["source", "draft", "method", "evidence", "lock"]) {
            const paymentId = h.cash(f),
                extra = {},
                draft = change === "draft" ? h.lifecycle.draft(f, {cashDirection: "outgoing", amount: "20"}) : null,
                bank = h.lib.one("mantle.account.method.BankAccount", {paymentMethodId: f.methodId}),
                lockId = "REF_LOCK_" + ec.user.randomString(20)
            if (draft) {
                extra.refundPaymentId = draft
                extra.refundSourceVersion = h.lifecycle.detail(f, draft).sourceVersion
            }
            let location
            if (change === "evidence") {
                const contentId = "REF_EVID_" + ec.user.randomString(20)
                location = "dbresource://mantle/content/payment/" + paymentId + "/content_" + contentId + "/proof.txt"
                ec.resource.getLocationReference(location).putText("Reviewed evidence")
                h.call("create#mantle.account.payment.PaymentContent", {
                    paymentContentId: contentId,
                    paymentId,
                    contentLocation: location,
                    contentTypeEnumId: "PctPaymentDocument",
                    description: "Reviewed proof"
                })
                const evidence = h.lifecycle.detail(f, paymentId).evidenceRows.find(row => row.paymentContentId === contentId)
                extra.evidenceContentIdList = [contentId]
                extra.evidenceVersions = {[contentId]: evidence.version}
            }
            const review = h.preview(f, paymentId, extra)
            try {
                if (change === "source") {
                    const invoice = h.lifecycle.settlement.invoice(f, "5")
                    h.lifecycle.apply(f, paymentId, invoice, "5")
                }
                if (change === "draft")
                    h.native(
                        "store#PaymentDraft",
                        h.lifecycle.request(f, {
                            paymentId: draft,
                            sourceVersion: extra.refundSourceVersion,
                            cashDirection: "outgoing",
                            amount: "21"
                        })
                    )
                if (change === "method")
                    h.call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, accountNumber: "987654321"})
                if (change === "evidence") ec.resource.getLocationReference(location).putText("Changed evidence")
                if (change === "lock")
                    h.call("create#mantle.ledger.config.AccountingLock", {
                        accountingLockId: lockId,
                        organizationPartyId: f.org,
                        lockScope: "all",
                        lockThroughDate: f.day,
                        isHard: "Y",
                        changeReason: "Refund policy recheck"
                    })
                errors.push(
                    h.lifecycle.rejected("refund#ReviewedPayment", {
                        previewId: review.previewId,
                        inputFingerprint: review.inputFingerprint,
                        operationKey: "ref-final-stale-" + change
                    })
                )
            } finally {
                if (change === "method")
                    h.call("update#mantle.account.method.BankAccount", {
                        paymentMethodId: f.methodId,
                        accountNumber: bank.accountNumber
                    })
                if (change === "lock") h.call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: lockId})
            }
        }
        const paymentId = h.cash(f),
            username = f.users.treasury
        login(username)
        const review = h.preview(f, paymentId),
            confirm = {
                previewId: review.previewId,
                inputFingerprint: review.inputFingerprint,
                operationKey: "ref-final-authority"
            }
        login("john.doe")
        h.call("update#moqui.security.UserGroupPermission", {
            userGroupId: username,
            userPermissionId: "PAYMENT_EDIT",
            fromDate: 0,
            thruDate: Number(f.timestamp) - 86400000
        })
        let denied
        try {
            login(username)
            denied = h.lifecycle.rejected("refund#ReviewedPayment", confirm)
        } finally {
            login("john.doe")
            h.call("update#moqui.security.UserGroupPermission", {
                userGroupId: username,
                userPermissionId: "PAYMENT_EDIT",
                fromDate: 0,
                thruDate: null
            })
        }
        login(username)
        return {errors, denied, positive: h.native("refund#ReviewedPayment", confirm)}
    },
    then({errors, denied, positive}) {
        errors[0].includes("STALE_REVISION")
        errors[1].includes("STALE_REVISION")
        errors[2].includes("STALE_PAYMENT_METHOD")
        errors[3].includes("STALE_PAYMENT_EVIDENCE")
        errors[4].includes("HARD_LOCK")
        denied.includes("PERMISSION_DENIED")
        positive.reasonCode == "REFUND_COMPLETED"
    }
})
feature("a genuine closed prior cash month funds a later open-day refund without changing original cash history", {
    when() {
        const h = helper(),
            date = new Date(Number(f.timestamp)),
            oldDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 15)).toISOString().slice(0, 10),
            oldPeriod = month(oldDay),
            current = month(f.day),
            oldTimestamp = ec.l10n.parseTimestamp(oldDay + " 12:00:00", "yyyy-MM-dd HH:mm:ss"),
            oldFixture = Object.assign({}, f, {timestamp: oldTimestamp, day: oldDay}),
            paymentId = h.cash(oldFixture),
            cash = h.lib.one("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            originalStamp = String(cash.lastUpdatedStamp),
            originalDay = h.lib.policy.postingDay(cash)
        if (oldPeriod.timePeriodId === current.timePeriodId) throw new Error("Prior and current fiscal months must differ")
        h.call("update#mantle.party.time.TimePeriod", {timePeriodId: oldPeriod.timePeriodId, isClosed: "Y"})
        let result
        try {
            result = h.confirm(h.preview(f, paymentId), "ref-final-closed-source")
        } finally {
            h.call("update#mantle.party.time.TimePeriod", {
                timePeriodId: oldPeriod.timePeriodId,
                isClosed: oldPeriod.isClosed || "N"
            })
        }
        const after = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: cash.acctgTransId})
        return {result, after, originalStamp, originalDay, current}
    },
    then({result, after, originalStamp, originalDay, current}) {
        result.reasonCode == "REFUND_COMPLETED"
        result.accountingDateText == f.day
        helper().lib.policy.postingDay(after) == originalDay
        String(after.lastUpdatedStamp) == originalStamp
        after.reversedByAcctgTransId == null
        after.isPosted == "Y"
        current.isClosed != "Y"
    }
})
