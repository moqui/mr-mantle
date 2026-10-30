const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_CORR")
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
        if (f?.org) helper().settlement.base.cleanupLocks(f.org)
    }
})
function unapply(h, request, key) {
    const p = h.native("preview#PaymentUnapply", request)
    return h.native("unapply#ReviewedPayment", {previewId: p.previewId, inputFingerprint: p.inputFingerprint, operationKey: key})
}
feature("unapplying one of two receipts restores only its own original application and keeps the other receipt", {
    when() {
        const h = helper(),
            invoiceId = h.settlement.invoice(f, "100"),
            first = h.delivered(f, {amount: "60"}),
            second = h.delivered(f, {amount: "40"})
        h.apply(f, first, invoiceId, "60")
        h.apply(f, second, invoiceId, "40")
        const beforeCash = h.lib
                .rows("mantle.ledger.transaction.AcctgTrans", {paymentId: first})
                .find(row => row.acctgTransTypeEnumId === "AttIncomingPayment"),
            request = h.unapplyRequest(f, first)
        login(f.users.treasury)
        const denied = h.rejected("preview#PaymentUnapply", request)
        login("john.doe")
        const preview = h.native("preview#PaymentUnapply", request),
            result = h.native("unapply#ReviewedPayment", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-one-of-two"
            }),
            again = h.native("unapply#ReviewedPayment", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-one-of-two"
            })
        return {
            denied,
            result,
            again,
            first: h.detail(f, first),
            second: h.detail(f, second),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId}),
            cash: h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: beforeCash.acctgTransId})
        }
    },
    then({denied, result, again, first, second, invoice, cash}) {
        denied.includes("PERMISSION_DENIED")
        result.reversalAcctgTransIds.length == 1
        result.replacementAcctgTransIds.length == 0
        again.alreadyApplied == true
        toDecimal(first.totals.unappliedTotal).eq(60)
        toDecimal(second.totals.unappliedTotal).isZero()
        second.applicationRows.some(row => toDecimal(row.amountApplied).eq(40))
        invoice.statusId == "InvoiceFinalized"
        toDecimal(invoice.unpaidTotal).eq(60)
        invoice.paidDate == null
        cash.isPosted == "Y"
        cash.reversedByAcctgTransId == null
    }
})
feature("a selected ordinary application reverses exactly while another application on the same payment remains", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            a = h.settlement.invoice(f, "30"),
            b = h.settlement.invoice(f, "30")
        h.apply(f, paymentId, a, "30")
        h.apply(f, paymentId, b, "30")
        const application = h.detail(f, paymentId).applicationRows.find(row => row.invoiceId === a),
            result = unapply(h, h.unapplyRequest(f, paymentId, [application.paymentApplicationId]), "corr-selected-ordinary")
        return {
            result,
            view: h.detail(f, paymentId),
            a: h.lib.one(h.lib.invoiceEntity, {invoiceId: a}),
            b: h.lib.one(h.lib.invoiceEntity, {invoiceId: b})
        }
    },
    then({result, view, a, b}) {
        result.applicationResults.length == 1
        result.reversalAcctgTransIds.length == 1
        toDecimal(view.totals.unappliedTotal).eq(30)
        toDecimal(a.unpaidTotal).eq(30)
        toDecimal(b.unpaidTotal).isZero()
        b.statusId == "InvoicePmtRecvd"
    }
})
feature("void zeroes every application before exact application and cash reversals and retries once", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            a = h.settlement.invoice(f, "30"),
            b = h.settlement.invoice(f, "30")
        h.apply(f, paymentId, a, "30")
        h.apply(f, paymentId, b, "30")
        const reviewed = h.preview(f, paymentId, "void", {reason: "Duplicate receipt correction"}),
            result = h.confirm(reviewed, "corr-void-complete"),
            again = h.confirm(reviewed, "corr-void-complete")
        return {
            result,
            again,
            row: h.lib.one("mantle.account.payment.Payment", {paymentId}),
            applications: h.lib.rows("mantle.account.payment.PaymentApplication", {paymentId}),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            a: h.lib.one(h.lib.invoiceEntity, {invoiceId: a}),
            b: h.lib.one(h.lib.invoiceEntity, {invoiceId: b})
        }
    },
    then({result, again, row, applications, transactions, a, b}) {
        row.statusId == "PmntVoid"
        result.reversalAcctgTransIds.length == 3
        result.replacementAcctgTransIds.length == 0
        transactions.length == 6
        transactions.every(tx => tx.isPosted === "Y")
        applications.every(ap => toDecimal(ap.amountApplied).isZero())
        toDecimal(a.unpaidTotal).eq(30)
        toDecimal(b.unpaidTotal).eq(30)
        again.alreadyApplied == true
    }
})
feature("a closed original fiscal period refuses application reversal with every original amount and posting intact", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            invoiceId = h.settlement.invoice(f, "60")
        h.apply(f, paymentId, invoiceId, "60")
        const request = h.unapplyRequest(f, paymentId),
            preview = h.native("preview#PaymentUnapply", request),
            before = h.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            periods = Array.from(
                h.lib
                    .find("mantle.party.time.TimePeriod", {partyId: f.org})
                    .condition("fromDate", "less-equals", f.day)
                    .condition("thruDate", "greater-equals", f.day)
                    .list()
            ),
            states = periods.map(row => ({timePeriodId: row.timePeriodId, isClosed: row.isClosed}))
        if (!periods.length) throw new Error("The financial fixture requires an original fiscal period")
        let refusal
        try {
            for (const period of periods)
                h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
            refusal = h.rejected("unapply#ReviewedPayment", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-closed-original"
            })
        } finally {
            for (const state of states) h.call("update#mantle.party.time.TimePeriod", state)
        }
        return {
            refusal,
            before,
            after: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            view: h.detail(f, paymentId)
        }
    },
    then({refusal, before, after, view}) {
        refusal.includes("PERIOD_CLOSED")
        after == before
        view.applicationRows.some(row => toDecimal(row.amountApplied).eq(60))
        view.payment.statusId == "PmntDelivered"
    }
})
feature("direct cash unapplication is whole-set only and preserves original, reversal and exact unapplied replacement", {
    when() {
        const h = helper(),
            invoiceId = h.settlement.invoice(f, "10"),
            direct = h.settlement.legacyDirectPayment(f, invoiceId, "10")
        const sourceKey = h.settlement.key("payment", direct.paymentId),
            targetKey = h.settlement.key("invoice", invoiceId)
        h.settlement.confirm(
            h.settlement.review(f, [
                {sourceKey, targetKey, amount: "4"},
                {sourceKey, targetKey, amount: "6"}
            ]),
            "corr-direct-aggregate-restore"
        )
        const view = h.detail(f, direct.paymentId),
            positive = view.applicationRows.filter(row => toDecimal(row.amountApplied).compare(0) > 0),
            partial = h.rejected(
                "preview#PaymentUnapply",
                h.unapplyRequest(f, direct.paymentId, [positive[0].paymentApplicationId])
            ),
            before = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: direct.paymentId}),
            result = unapply(h, h.unapplyRequest(f, direct.paymentId), "corr-direct-whole")
        return {
            partial,
            before,
            result,
            after: h.detail(f, direct.paymentId),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: direct.paymentId}),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId})
        }
    },
    then({partial, before, result, after, transactions, invoice}) {
        partial.includes("DIRECT_PAYMENT_UNAPPLY_REQUIRED")
        before.length == 1
        result.originalAcctgTransIds.length == 1
        result.reversalAcctgTransIds.length == 1
        result.replacementAcctgTransIds.length == 1
        transactions.length == 3
        transactions.filter(tx => !tx.reverseOfAcctgTransId && !tx.reversedByAcctgTransId).length == 1
        toDecimal(after.totals.unappliedTotal).eq(10)
        toDecimal(invoice.unpaidTotal).eq(10)
        after.applicationRows.every(row => toDecimal(row.amountApplied).isZero())
    }
})
feature("NULL-day direct cash at next UTC date retains its actual original SQL day on replacement without history backfill", {
    when() {
        const h = helper(),
            userId = ec.user.userId,
            timeZone = ec.user.userAccount.timeZone
        try {
            h.call("update#moqui.security.UserAccount", {userId, timeZone: "America/Chicago"})
            login("john.doe")
            const boundary = Object.assign({}, f, {
                    timestamp: ec.l10n.parseTimestamp(f.day + " 23:30:00", "yyyy-MM-dd HH:mm:ss")
                }),
                invoiceId = h.settlement.invoice(boundary, "10"),
                direct = h.settlement.legacyDirectPayment(boundary, invoiceId, "10")
            h.apply(boundary, direct.paymentId, invoiceId, "10")
            const original = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: direct.paymentId})[0],
                review = h.native("preview#PaymentUnapply", h.unapplyRequest(boundary, direct.paymentId))
            h.call("update#moqui.security.UserAccount", {userId, timeZone: "UTC"})
            login("john.doe")
            const result = h.native("unapply#ReviewedPayment", {
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: "corr-direct-book-day"
                }),
                replacement = h.lib.one("mantle.ledger.transaction.AcctgTrans", {
                    acctgTransId: result.replacementAcctgTransIds[0]
                })
            return {
                original,
                result,
                replacement,
                payment: h.lib.one("mantle.account.payment.Payment", {paymentId: direct.paymentId})
            }
        } finally {
            h.lib.probe("update#moqui.security.UserAccount", {userId, timeZone})
            login("john.doe")
        }
    },
    then({original, result, replacement, payment}) {
        helper().lib.policy.postingDay(original) == f.day
        helper().lib.policy.calendarDateText(original.transactionDate) > f.day
        payment.accountingDate == null
        helper().lib.policy.postingDay(replacement) == f.day
        Number(replacement.transactionDate) == Number(original.transactionDate)
        replacement.invoiceId == null
        replacement.paymentApplicationId == null
        replacement.isPosted == "Y"
        result.replacementAcctgTransIds.length == 1
    }
})
feature("an unreviewed ledger reversal is refused for the same treasury actor whose reviewed native void succeeds", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.delivered(f, {amount: "15"}),
            original = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})[0],
            denied = h.rejected("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
                acctgTransId: original.acctgTransId,
                changeReason: "Unreviewed direct attempt"
            }),
            afterDenied = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            originalAfterDenied = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: original.acctgTransId}),
            result = h.confirm(h.preview(f, paymentId, "void", {reason: "Reviewed correction"}), "corr-native-versus-direct"),
            after = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        return {denied, afterDenied, originalAfterDenied, result, after}
    },
    then({denied, afterDenied, originalAfterDenied, result, after}) {
        denied.includes("REVIEW_REQUIRED")
        afterDenied.length == 1
        originalAfterDenied.isPosted == "Y"
        originalAfterDenied.reversedByAcctgTransId == null
        result.statusId == "PmntVoid"
        result.reversalAcctgTransIds.length == 1
        after.length == 2
        after.every(tx => tx.isPosted === "Y")
    }
})
feature("bank identity changes invalidate reviewed draft methods and retained delivery without changing money", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            preview = h.preview(f, paymentId, "deliver"),
            request = h.request(f),
            bank = h.lib.one("mantle.account.method.BankAccount", {paymentMethodId: f.methodId}),
            old = bank.accountNumber
        let draftDenied, deliveryDenied
        try {
            h.call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, accountNumber: "999999999"})
            draftDenied = h.rejected("create#PaymentDraft", request)
            deliveryDenied = h.rejected("change#PaymentState", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-bank-changed"
            })
        } finally {
            h.call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, accountNumber: old})
        }
        return {
            draftDenied,
            deliveryDenied,
            count: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            status: h.detail(f, paymentId).payment.statusId
        }
    },
    then({draftDenied, deliveryDenied, count, status}) {
        draftDenied.includes("STALE_PAYMENT_METHOD")
        deliveryDenied.includes("STALE_PREVIEW")
        count == 0
        status == "PmntProposed"
    }
})
feature("AP bill unapplication restores paid status and date while preserving its original outgoing cash", {
    when() {
        const h = helper(),
            invoiceId = h.settlement.invoice(f, "25", "payable"),
            paymentId = h.delivered(f, {cashDirection: "outgoing", amount: "25"})
        h.apply(f, paymentId, invoiceId, "25", "payable")
        const result = unapply(h, h.unapplyRequest(f, paymentId), "corr-payable-unapply")
        return {result, invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId}), view: h.detail(f, paymentId)}
    },
    then({result, invoice, view}) {
        invoice.statusId == "InvoiceApproved"
        invoice.paidDate == null
        toDecimal(invoice.unpaidTotal).eq(25)
        result.reversalAcctgTransIds.length == 1
        view.payment.cashDirection == "outgoing"
        toDecimal(view.totals.unappliedTotal).eq(25)
    }
})
