// Exact manual opposite cash and permanent original funding identities, using the real native money controller.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentRefundFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_REF_MONEY")
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
feature("partial manual refunds consume exact original cash once and exact retry survives later original balance changes", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            review = h.preview(f, paymentId),
            first = h.confirm(review, "refund-partial-twenty"),
            second = h.confirm(h.preview(f, paymentId, {amount: "40"}), "refund-remaining-forty"),
            again = h.confirm(review, "refund-partial-twenty"),
            records = h.lib.rows("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}),
            summary = h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}),
            children = records.map(row => h.lifecycle.detail(f, row.refundPaymentId)),
            transactions = records.flatMap(row =>
                h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: row.refundPaymentId})
            )
        return {
            paymentId,
            first,
            second,
            again,
            records,
            summary,
            children,
            transactions,
            original: h.lib.one("mantle.account.payment.Payment", {paymentId})
        }
    },
    then({paymentId, first, second, again, records, summary, children, transactions, original}) {
        first.originalPaymentId == paymentId
        first.paymentId == paymentId
        first.refundPaymentId != paymentId
        first.reasonCode == "REFUND_COMPLETED"
        first.acctgTransIds.length == 2
        second.acctgTransIds.length == 2
        first.outputRows.every(row => row.paymentId === first.refundPaymentId && row.canOpen === true)
        again.refundPaymentId == first.refundPaymentId
        again.paymentApplicationId == first.paymentApplicationId
        again.alreadyApplied == true
        records.length == 2
        records.every(row => row.currencyUomId === "USD" && row.originalPaymentId === paymentId && row.paymentApplicationId)
        children.every(
            row =>
                row.payment.paymentTypeEnumId === "PtRefund" &&
                row.payment.cashDirection === "outgoing" &&
                row.payment.financeDirection === "receivable"
        )
        children.every(row => toDecimal(row.totals.unappliedTotal).isZero())
        transactions.length == 4
        transactions.every(row => row.isPosted === "Y" && row.glFiscalTypeEnumId === "GLFT_ACTUAL")
        toDecimal(summary.refundSummary.completedRefundAmount).eq(60)
        toDecimal(summary.refundSummary.refundableAmount).isZero()
        summary.capabilities.canRefund == false
        toDecimal(original.amount).eq(60)
        original.statusId == "PmntDelivered"
    }
})
feature("supplier refund reverses outgoing cash while preserving payable side and exact funding application", {
    when() {
        const h = helper(),
            paymentId = h.cash(f, "outgoing", "50"),
            result = h.confirm(h.preview(f, paymentId, {amount: "15"}), "refund-supplier-fifteen"),
            record = h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: result.refundPaymentId}),
            tx = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: record.cashAcctgTransId})
        return {
            result,
            record,
            tx,
            entries: h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: tx.acctgTransId}),
            child: h.lifecycle.detail(f, result.refundPaymentId),
            summary: h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
        }
    },
    then({result, record, tx, entries, child, summary}) {
        child.payment.cashDirection == "incoming"
        child.payment.financeDirection == "payable"
        record.financeDirection == "payable"
        record.cashDirection == "incoming"
        tx.acctgTransTypeEnumId == "AttIncomingPayment"
        entries.some(row => row.glAccountId === "111100000" && row.debitCreditFlag === "D" && toDecimal(row.amount).eq(15))
        result.applicationResults.length == 1
        toDecimal(summary.refundSummary.refundableAmount).eq(35)
    }
})
feature("an opposing reviewed clean draft becomes the actual refund child with immutable links and owned outputs", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            draft = h.lifecycle.draft(f, {cashDirection: "outgoing", amount: "20"}),
            view = h.lifecycle.detail(f, draft),
            review = h.preview(f, paymentId, {refundPaymentId: draft, refundSourceVersion: view.sourceVersion}),
            result = h.confirm(review, "refund-existing-draft"),
            record = h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: draft}),
            reopened = h.native("get#PaymentRefundPreview", {organizationPartyId: f.org, previewId: review.previewId}),
            changed = h.lifecycle.rejected("refund#ReviewedPayment", {
                previewId: review.previewId,
                inputFingerprint: "changed-fingerprint",
                operationKey: "refund-existing-draft"
            })
        return {paymentId, draft, result, record, reopened, changed}
    },
    then({paymentId, draft, result, record, reopened, changed}) {
        result.refundPaymentId == draft
        record.originalPaymentId == paymentId
        result.outputRows.every(row => row.paymentId === draft)
        reopened.status == "complete"
        reopened.operationKey == "refund-existing-draft"
        reopened.results.refundPaymentId == draft
        changed.includes("OPERATION_KEY_CONFLICT")
    }
})
