const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentRefundFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_REFUND")
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
feature("incoming original cash has an exact outgoing refund review with zero new money or provider effects", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            before = h.counts(paymentId),
            review = h.preview(f, paymentId),
            retained = h.native("get#PaymentRefundPreview", {organizationPartyId: f.org, previewId: review.previewId}),
            summary = h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
        return {before, review, retained, summary, after: h.counts(paymentId)}
    },
    then({before, review, retained, summary, after}) {
        summary.refundSummary.complete == true
        toDecimal(summary.refundSummary.originalCashAmount).eq(60)
        toDecimal(summary.refundSummary.refundableAmount).eq(60)
        summary.refundSummary.refundCashDirection == "outgoing"
        summary.refundSummary.financeDirection == "receivable"
        summary.capabilities.canPreviewRefund == true
        review.previewKind == "refund"
        review.status == "review"
        review.paymentSummary.cashDirection == "outgoing"
        toDecimal(review.paymentSummary.amount).eq(20)
        toDecimal(review.before.refundableAmount).eq(60)
        toDecimal(review.after.refundableAmount).eq(40)
        review.postingSummary.cashPostingCount == 1
        review.postingSummary.applicationPostingCount == 1
        review.ledgerPreview.length == 2
        review.ledgerPreview[0].acctgTransTypeEnumId == "AttOutgoingPayment"
        review.ledgerPreview[1].acctgTransTypeEnumId == "AttPaymentInOutAppl"
        retained.inputFingerprint == review.inputFingerprint
        retained.refundDefaults.organizationMethodVersion == review.refundDefaults.organizationMethodVersion
        JSON.stringify(before) == JSON.stringify(after)
    }
})
feature("outgoing original cash inherits payable side while reviewing a precise incoming supplier refund", {
    when() {
        const h = helper(),
            paymentId = h.cash(f, "outgoing"),
            before = h.counts(paymentId),
            review = h.preview(f, paymentId)
        return {review, before, after: h.counts(paymentId)}
    },
    then({review, before, after}) {
        review.refundSummary.financeDirection == "payable"
        review.refundSummary.refundCashDirection == "incoming"
        review.paymentSummary.cashDirection == "incoming"
        review.ledgerPreview[0].acctgTransTypeEnumId == "AttIncomingPayment"
        review.ledgerPreview[0].lines.some(row => row.debitCreditFlag === "D" && row.glAccountId === "111100000")
        toDecimal(review.after.availableAmount).eq(40)
        JSON.stringify(before) == JSON.stringify(after)
    }
})
feature("the same valid refund request requires Treasury read and edit even when artifact authorization is disabled", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            request = h.request(f, paymentId),
            errors = []
        for (const username of [f.users.ar, f.users.paymentView, f.users.paymentEditOnly]) {
            login(username)
            errors.push(h.lifecycle.rejected("preview#PaymentRefund", request))
            errors.push(h.lifecycle.rejected("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}))
        }
        login(f.users.treasury)
        const positive = h.native("preview#PaymentRefund", request)
        return {errors, positive}
    },
    then({errors, positive}) {
        errors.length == 6
        errors.every(error => error.includes("PERMISSION_DENIED"))
        positive.previewKind == "refund"
        toDecimal(positive.paymentSummary.amount).eq(20)
    }
})
feature("foreign organization and private original cash refuse the same payload while restored visibility permits review", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            request = h.request(f, paymentId),
            foreign = h.lifecycle.rejected(
                "preview#PaymentRefund",
                Object.assign({}, request, {organizationPartyId: "ORG_ZIZI_RETAIL"})
            ),
            john = ec.user.userId
        h.call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: john})
        let privateDenied
        try {
            login(f.users.treasury)
            privateDenied = h.lifecycle.rejected("preview#PaymentRefund", request)
        } finally {
            login("john.doe")
            h.call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: null})
        }
        login(f.users.treasury)
        return {foreign, privateDenied, positive: h.native("preview#PaymentRefund", request)}
    },
    then({foreign, privateDenied, positive}) {
        foreign.includes("PAYMENT_UNAVAILABLE")
        privateDenied.includes("PAYMENT_UNAVAILABLE")
        positive.previewKind == "refund"
    }
})
feature("fully allocated funding, currency precision, date and stale method revisions refuse before another cash payment", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            request = h.request(f, paymentId),
            errors = [
                h.lifecycle.rejected("preview#PaymentRefund", Object.assign({}, request, {amount: "0.001"})),
                h.lifecycle.rejected("preview#PaymentRefund", Object.assign({}, request, {amount: "60.01"})),
                h.lifecycle.rejected(
                    "preview#PaymentRefund",
                    Object.assign({}, request, {effectiveDate: Number(f.timestamp) - 86400000})
                ),
                h.lifecycle.rejected(
                    "preview#PaymentRefund",
                    Object.assign({}, request, {organizationMethodVersion: "stale-real-method"})
                )
            ]
        const invoiceId = h.lifecycle.settlement.invoice(f, "60")
        h.lifecycle.apply(f, paymentId, invoiceId, "60")
        const full = h.lifecycle.rejected("preview#PaymentRefund", h.request(f, paymentId)),
            summary = h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
        return {
            errors,
            full,
            summary,
            refunds: h.lib.find("mantle.account.payment.Payment", {refundForPaymentId: paymentId}).count()
        }
    },
    then({errors, full, summary, refunds}) {
        errors[0].includes("CURRENCY_PRECISION")
        errors[1].includes("REFUND_FUNDS_UNAVAILABLE")
        errors[2].includes("REFUND_BEFORE_ORIGINAL_CASH")
        errors[3].includes("STALE_PAYMENT_METHOD")
        full.includes("REFUND_FUNDS_UNAVAILABLE")
        toDecimal(summary.refundSummary.refundableAmount).isZero()
        summary.capabilities.canPreviewRefund == false
        refunds == 0
    }
})
feature("selected clean draft rows survive text and page filtering with exact base revisions", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            first = h.lifecycle.draft(f, {cashDirection: "outgoing", amount: "20", referenceNumber: "FIRST"}),
            selected = h.lifecycle.draft(f, {cashDirection: "outgoing", amount: "20", referenceNumber: "SELECTED"}),
            options = h.native("find#PaymentRefundDrafts", {
                organizationPartyId: f.org,
                paymentId,
                text: "FIRST",
                pageSize: 1,
                selectedPaymentIdList: [selected]
            }),
            chosen = options.selectedRows[0],
            review = h.preview(f, paymentId, {refundPaymentId: selected, refundSourceVersion: chosen?.sourceVersion})
        return {first, selected, options, review}
    },
    then({first, selected, options, review}) {
        options.complete == true
        options.recordCount == 1
        options.rows[0].paymentId == first
        options.selectedRows[0].paymentId == selected
        options.selectedRows[0].sourceVersion != null
        review.refundPaymentId == selected
        review.refundSourceVersion == options.selectedRows[0].sourceVersion
    }
})
feature("owner-bound retained refund money cannot be rewritten or forged by artifact-off entity services", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            review = h.preview(f, paymentId),
            errors = [
                h.lifecycle.rejected("update#mantle.account.payment.PaymentRefundPreview", {
                    previewId: review.previewId,
                    amount: "1",
                    payloadJson: "{}"
                }),
                h.lifecycle.rejected("delete#mantle.account.payment.PaymentRefundPreview", {previewId: review.previewId}),
                h.lifecycle.rejected("create#mantle.account.payment.PaymentRefundRecord", {
                    refundPaymentId: "forged-refund",
                    originalPaymentId: paymentId,
                    organizationPartyId: f.org,
                    amount: "1",
                    currencyUomId: "USD"
                })
            ]
        login(f.users.treasury)
        const ownerDenied = h.lifecycle.rejected("get#PaymentRefundPreview", {
            organizationPartyId: f.org,
            previewId: review.previewId
        })
        login("john.doe")
        return {errors, ownerDenied, retained: h.native("get#PaymentRefundPreview", {previewId: review.previewId})}
    },
    then({errors, ownerDenied, retained}) {
        errors[0].includes("REFUND_REVIEW_REQUIRED")
        errors[1].includes("REFUND_RECORD_IMMUTABLE")
        errors[2].includes("REFUND_REVIEW_REQUIRED")
        ownerDenied.includes("REFUND_PREVIEW_UNAVAILABLE")
        toDecimal(retained.paymentSummary.amount).eq(20)
    }
})
