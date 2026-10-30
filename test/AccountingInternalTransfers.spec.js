// Exactly two local cash/transit postings; no provider, trade application, or org-self autoposter shortcut.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingInternalTransferFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_XFER")
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
    "principal fifty and fee two create two exact cash/transit postings with zero transit net and independent same-control-bank legs",
    {
        when() {
            const h = helper(),
                review = h.preview(f, {feeAmount: "2", feeGlAccountId: "710000000"}),
                result = h.confirm(review, "xfer-fifty-fee-two"),
                pair = h.lib.one("mantle.account.payment.PaymentInternalTransfer", {
                    internalTransferId: result.internalTransferId
                }),
                out = h.lifecycle.detail(f, result.fromPaymentId),
                incoming = h.lifecycle.detail(f, result.toPaymentId),
                transactions = h.lib
                    .rows("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: f.org})
                    .filter(row => [result.fromPaymentId, result.toPaymentId].includes(row.paymentId)),
                entries = transactions.flatMap(row =>
                    h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: row.acctgTransId})
                ),
                transit = entries
                    .filter(row => row.glAccountId === pair.transitGlAccountId)
                    .reduce(
                        (sum, row) => (row.debitCreditFlag === "D" ? sum.add(row.amount) : sum.subtract(row.amount)),
                        toDecimal(0)
                    ),
                outputs = result.outputRows.map(row =>
                    h.native("get#PaymentOutput", {organizationPartyId: f.org, paymentId: row.paymentId, outputId: row.outputId})
                )
            return {
                review,
                result,
                pair,
                out,
                incoming,
                transactions,
                entries,
                transit,
                outputs,
                unapplied: h.native("find#Payments", {organizationPartyId: f.org, queue: "unapplied", pageSize: 100}),
                transfers: h.native("find#Payments", {organizationPartyId: f.org, queue: "transfers", pageSize: 100}),
                applications: h.lib
                    .find("mantle.account.payment.PaymentApplication")
                    .condition("paymentId", "in", [result.fromPaymentId, result.toPaymentId])
                    .count(),
                stored: [result.fromPaymentId, result.toPaymentId].map(paymentId =>
                    h.lib.one("mantle.account.payment.Payment", {paymentId})
                )
            }
        },
        then({
            review,
            result,
            pair,
            out,
            incoming,
            transactions,
            entries,
            transit,
            outputs,
            applications,
            stored,
            unapplied,
            transfers
        }) {
            review.previewKind == "internalTransfer"
            review.ledgerPreview.length == 2
            review.feeAccountLabel.includes("710000000")
            result.reasonCode == "INTERNAL_TRANSFER_COMPLETED"
            result.transferId == result.internalTransferId
            result.fromPaymentId != result.toPaymentId
            result.acctgTransIds.length == 2
            pair.status == "completed"
            transactions.length == 2
            transactions.every(row => row.isPosted === "Y" && row.glFiscalTypeEnumId === "GLFT_ACTUAL")
            entries.length == 5
            transit.isZero()
            entries.some(row => row.glAccountId === "710000000" && row.debitCreditFlag === "D" && toDecimal(row.amount).eq(2))
            entries.some(row => row.glAccountId === "111100000" && row.debitCreditFlag === "C" && toDecimal(row.amount).eq(52))
            entries.some(row => row.glAccountId === "111100000" && row.debitCreditFlag === "D" && toDecimal(row.amount).eq(50))
            applications == 0
            unapplied.rows.every(row => ![result.fromPaymentId, result.toPaymentId].includes(row.paymentId))
            unapplied.recordCount == 0
            transfers.rows.some(row => row.paymentId === result.fromPaymentId)
            transfers.rows.some(row => row.paymentId === result.toPaymentId)
            out.payment.cashDirection == "outgoing"
            incoming.payment.cashDirection == "incoming"
            out.payment.financeDirection == "transfer"
            incoming.payment.financeDirection == "transfer"
            out.transferLegRows.length == 2
            out.transferSummary.internalTransferId == result.internalTransferId
            toDecimal(out.transferSummary.principalAmount).eq(50)
            toDecimal(incoming.totals.unappliedTotal).isZero()
            stored[0].paymentMethodId == f.methodId
            stored[0].toPaymentMethodId == null
            stored[1].paymentMethodId == null
            stored[1].toPaymentMethodId == f.toMethodId
            stored.every(row => row.fromPartyId === f.org && row.toPartyId === f.org && row.lifecycleManaged === "Y")
            result.outputRows.length == 2
            result.outputRows.every(
                row =>
                    row.outputType === "detail" &&
                    row.canOpen === true &&
                    [result.fromPaymentId, result.toPaymentId].includes(row.paymentId)
            )
            outputs.every(row => row.documentHtml.includes("Internal transfer"))
        }
    }
)
feature("exact completed transfer retry returns the recorded pair and changed key reuse refuses without another posting", {
    when() {
        const h = helper(),
            review = h.preview(f),
            first = h.confirm(review, "xfer-exact-retry"),
            again = h.confirm(review, "xfer-exact-retry"),
            retained = h.native("get#InternalTransferPreview", {previewId: review.previewId}),
            different = h.preview(f, {amount: "25"}),
            refused = h.lifecycle.rejected("create#InternalTransfer", {
                previewId: different.previewId,
                inputFingerprint: different.inputFingerprint,
                operationKey: "xfer-exact-retry"
            })
        return {
            first,
            again,
            retained,
            refused,
            count: h.lib.find("mantle.account.payment.PaymentInternalTransfer", {operationKey: "xfer-exact-retry"}).count()
        }
    },
    then({first, again, retained, refused, count}) {
        again.fromPaymentId == first.fromPaymentId
        again.toPaymentId == first.toPaymentId
        again.transferId == first.transferId
        again.alreadyApplied == true
        retained.status == "complete"
        retained.operationKey == "xfer-exact-retry"
        retained.results.fromPaymentId == first.fromPaymentId
        retained.results.outputRows.every(row => row.canOpen === true)
        refused.includes("OPERATION_KEY_CONFLICT")
        count == 1
    }
})
