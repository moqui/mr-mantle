// Accepted cash remains exact after configuration flags change; legitimate application corrections preserve that cash.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
let f
function capture() {
    const h = helper(),
        paymentId = h.draft(f)
    h.execute(h.preview(f, paymentId))
    return h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
}
function snapshot(result) {
    const h = helper()
    return JSON.stringify({
        payment: h.lib.map(h.lib.one("mantle.account.payment.Payment", {paymentId: result.cashPaymentId})),
        attempt: h.lib.map(h.lib.one("mantle.account.payment.PaymentGatewayAttempt", {attemptId: result.attemptId})),
        transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: result.cashPaymentId}).map(row => ({
            header: h.lib.map(row),
            entries: h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: row.acctgTransId}).map(h.lib.map)
        }))
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWCASH")
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
        if (f?.org) helper().lifecycle.settlement.base.cleanupLocks(f.org)
    }
})
feature(
    "accepted cash and its original posting resist generic duplicate, detach, relabel and monetary edits with all adoption flags off",
    {
        when() {
            const h = helper(),
                result = capture(),
                tx = h.lib.one("mantle.ledger.transaction.AcctgTrans", {paymentId: result.cashPaymentId}),
                entry = h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: tx.acctgTransId})[0],
                before = snapshot(result),
                pref = h.lib.policy.preference(f.org),
                saved = h.lib.policy.pick(h.lib.map(pref), [
                    "postingGuardEnabled",
                    "settlementApplicationGuardEnabled",
                    "paymentGatewayWorkflowEnabled"
                ]),
                errors = []
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                postingGuardEnabled: "N",
                settlementApplicationGuardEnabled: "N",
                paymentGatewayWorkflowEnabled: "N"
            })
            try {
                for (const [service, values] of [
                    [
                        "create#mantle.ledger.transaction.AcctgTrans",
                        {
                            acctgTransId: "GWC_DUP_" + ec.user.randomString(20),
                            organizationPartyId: f.org,
                            paymentId: result.cashPaymentId,
                            acctgTransTypeEnumId: "AttIncomingPayment",
                            transactionDate: tx.transactionDate,
                            accountingDate: tx.accountingDate,
                            amountUomId: "USD",
                            glFiscalTypeEnumId: "GLFT_ACTUAL",
                            isPosted: "N"
                        }
                    ],
                    ["update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId, paymentId: null}],
                    [
                        "update#mantle.ledger.transaction.AcctgTrans",
                        {
                            acctgTransId: tx.acctgTransId,
                            acctgTransTypeEnumId: "AttIncomingPaymentAp",
                            paymentApplicationId: "NONEXISTENT_AP"
                        }
                    ],
                    ["update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId, amountUomId: "EUR"}],
                    [
                        "update#mantle.ledger.transaction.AcctgTransEntry",
                        {acctgTransId: entry.acctgTransId, acctgTransEntrySeqId: entry.acctgTransEntrySeqId, amount: "1"}
                    ],
                    [
                        "delete#mantle.ledger.transaction.AcctgTransEntry",
                        {acctgTransId: entry.acctgTransId, acctgTransEntrySeqId: entry.acctgTransEntrySeqId}
                    ],
                    ["mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: tx.acctgTransId}],
                    [
                        "mantle.ledger.LedgerServices.post#ReverseAcctgTrans",
                        {acctgTransId: tx.acctgTransId, changeReason: "Unreviewed cash reversal"}
                    ],
                    ["update#mantle.account.payment.Payment", {paymentId: result.cashPaymentId, amount: "1"}],
                    [
                        "update#mantle.account.payment.Payment",
                        {paymentId: result.cashPaymentId, gatewayAttemptId: null, gatewayInstructionId: null, gatewayRole: null}
                    ],
                    [
                        "update#mantle.account.payment.PaymentGatewayAttempt",
                        {attemptId: result.attemptId, providerState: "declined", receiptJson: "{}"}
                    ],
                    ["delete#mantle.account.payment.Payment", {paymentId: result.cashPaymentId}]
                ])
                    errors.push(h.lifecycle.rejected(service, values))
            } finally {
                h.call("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: f.org}, saved))
            }
            return {errors, before, after: snapshot(result)}
        },
        then({errors, before, after}) {
            errors.length == 12
            errors.slice(0, 8).every(error => error.includes("GATEWAY_CASH_POSTING_IMMUTABLE"))
            errors.slice(8).every(error => /GATEWAY_RECORD_IMMUTABLE|GATEWAY_REVIEW_REQUIRED/.test(error))
            before == after
        }
    }
)
feature("authorization parents remain noncash while ordinary posted-cash metadata and reconciliation can change", {
    when() {
        const h = helper(),
            result = capture(),
            tx = h.lib.one("mantle.ledger.transaction.AcctgTrans", {paymentId: result.cashPaymentId}),
            entry = h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: tx.acctgTransId})[0],
            denied = h.lifecycle.rejected("create#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: "GWC_PARENT_" + ec.user.randomString(20),
                organizationPartyId: f.org,
                paymentId: result.paymentId,
                acctgTransTypeEnumId: "AttIncomingPayment",
                transactionDate: tx.transactionDate,
                amountUomId: "USD",
                glFiscalTypeEnumId: "GLFT_ACTUAL",
                isPosted: "N"
            })
        h.call("update#mantle.ledger.transaction.AcctgTrans", {
            acctgTransId: tx.acctgTransId,
            description: "Cash reconciliation annotation"
        })
        h.call("update#mantle.ledger.transaction.AcctgTransEntry", {
            acctgTransId: entry.acctgTransId,
            acctgTransEntrySeqId: entry.acctgTransEntrySeqId,
            reconcileStatusId: "AterRec",
            description: "Matched bank entry"
        })
        const after = h.lib.one("mantle.ledger.transaction.AcctgTransEntry", {
            acctgTransId: entry.acctgTransId,
            acctgTransEntrySeqId: entry.acctgTransEntrySeqId
        })
        return {
            denied,
            after,
            entry,
            payment: h.lib.one("mantle.account.payment.Payment", {paymentId: result.cashPaymentId}),
            header: h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId})
        }
    },
    then({denied, after, entry, payment, header}) {
        denied.includes("GATEWAY_AUTHORIZATION_NOT_CASH")
        payment.gatewayRole == "capture"
        toDecimal(payment.amount).eq(20)
        header.description == "Cash reconciliation annotation"
        header.isPosted == "Y"
        after.reconcileStatusId == "AterRec"
        toDecimal(after.amount).eq(entry.amount)
    }
})
feature("genuine settlement and reviewed application unapply preserve the exact accepted cash and provider instruction", {
    when() {
        const h = helper(),
            result = capture(),
            invoiceId = h.lifecycle.settlement.invoice(f, "20"),
            tx = h.lib.one("mantle.ledger.transaction.AcctgTrans", {paymentId: result.cashPaymentId}),
            application = h.lifecycle.apply(f, result.cashPaymentId, invoiceId, "20"),
            paid = h.lifecycle.detail(f, result.cashPaymentId),
            request = h.lifecycle.unapplyRequest(f, result.cashPaymentId),
            review = h.native("preview#PaymentUnapply", request),
            unapplied = h.native("unapply#ReviewedPayment", {
                previewId: review.previewId,
                inputFingerprint: review.inputFingerprint,
                operationKey: "gwc-unapply-real"
            })
        return {
            result,
            application,
            paid,
            unapplied,
            after: h.lifecycle.detail(f, result.cashPaymentId),
            cash: h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: tx.acctgTransId}),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId}),
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId: result.paymentId, action: "capture"})
        }
    },
    then({result, application, paid, unapplied, after, cash, invoice, effect}) {
        application.allocationResults.length == 1
        toDecimal(paid.totals.unappliedTotal).isZero()
        unapplied.applicationResults.length == 1
        unapplied.reversalAcctgTransIds.length == 1
        unapplied.replacementAcctgTransIds.length == 0
        toDecimal(after.totals.unappliedTotal).eq(20)
        after.payment.gatewayAttemptId == result.attemptId
        after.payment.gatewayRole == "capture"
        cash.isPosted == "Y"
        cash.reversedByAcctgTransId == null
        toDecimal(invoice.unpaidTotal).eq(20)
        Number(effect.invocationCount) == 1
    }
})
