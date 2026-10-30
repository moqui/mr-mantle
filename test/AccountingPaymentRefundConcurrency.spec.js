// Actual competing server transactions; reviewed refunds must share capacity with native and legacy applications.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentRefundFixtures.js")
let f
function confirmInput(review, key) {
    return {previewId: review.previewId, inputFingerprint: review.inputFingerprint, operationKey: key}
}
function race(requests) {
    return parallel(
        2,
        (thread, args) => {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            try {
                return {result: call(args.requests[thread].name, args.requests[thread].parameters)}
            } catch (error) {
                ec.message.clearErrors()
                return {failure: error.message}
            }
        },
        {requests},
        {transaction: false, timeout: 60}
    )
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_REF_CON")
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
feature("simultaneous identical refund confirmation keys create one child, backing application and operation", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            review = h.preview(f, paymentId),
            request = {
                name: "mantle.account.PaymentServices.refund#ReviewedPayment",
                parameters: confirmInput(review, "ref-con-exact")
            },
            results = race([request, request])
        return {
            results,
            records: h.lib.rows("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}),
            operations: h.lib.find(h.lib.operationEntity, {operationKey: "ref-con-exact"}).count(),
            summary: h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
        }
    },
    then({results, records, operations, summary}) {
        results.every(row => row.result?.reasonCode === "REFUND_COMPLETED")
        results[0].result.refundPaymentId == results[1].result.refundPaymentId
        results.filter(row => row.result.alreadyApplied).length == 1
        records.length == 1
        operations == 1
        toDecimal(summary.refundSummary.refundableAmount).eq(40)
    }
})
feature("competing different refund reviews cannot consume more than one fifty-unit cash source", {
    when() {
        const h = helper(),
            paymentId = h.cash(f, "incoming", "50"),
            reviews = [h.preview(f, paymentId, {amount: "30"}), h.preview(f, paymentId, {amount: "30"})],
            results = race(
                reviews.map((review, index) => ({
                    name: "mantle.account.PaymentServices.refund#ReviewedPayment",
                    parameters: confirmInput(review, "ref-con-cap-" + index)
                }))
            )
        return {
            results,
            records: h.lib.rows("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}),
            summary: h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
        }
    },
    then({results, records, summary}) {
        results.filter(row => row.result).length == 1
        results.filter(row =>
            /STALE_REVISION|REFUND_FUNDS_UNAVAILABLE|STALE_PREVIEW|REFUND_HISTORY_CHANGED/.test(row.failure || "")
        ).length == 1
        records.length == 1
        toDecimal(summary.refundSummary.completedRefundAmount).eq(30)
        toDecimal(summary.refundSummary.refundableAmount).eq(20)
    }
})
feature("a raw legacy application competes with a refund through the same authoritative original funding locks", {
    when() {
        const h = helper(),
            paymentId = h.cash(f, "incoming", "50"),
            invoiceId = h.lifecycle.settlement.invoice(f, "40"),
            review = h.preview(f, paymentId, {amount: "30"}),
            results = race([
                {name: "mantle.account.PaymentServices.refund#ReviewedPayment", parameters: confirmInput(review, "ref-con-raw")},
                {
                    name: "create#mantle.account.payment.PaymentApplication",
                    parameters: {
                        paymentApplicationId: "REF_RACE_" + ec.user.randomString(20),
                        paymentId,
                        invoiceId,
                        amountApplied: "40",
                        currencyUomId: "USD",
                        appliedDate: f.timestamp,
                        accountingDate: f.day
                    }
                }
            ])
        return {
            results,
            records: h.lib.rows("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}),
            applications: h.lib.rows("mantle.account.payment.PaymentApplication", {paymentId}),
            targetApplications: h.lib.rows("mantle.account.payment.PaymentApplication", {toPaymentId: paymentId}),
            view: h.lifecycle.detail(f, paymentId)
        }
    },
    then({results, records, applications, targetApplications, view}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.failure).length == 1
        results
            .filter(row => row.failure)
            .every(row => /STALE_REVISION|REFUND_FUNDS_UNAVAILABLE|APPLICATION_BALANCE_CHANGED|STALE_PREVIEW/.test(row.failure))
        applications
            .concat(targetApplications)
            .reduce((sum, row) => sum.add(row.amountApplied), toDecimal(0))
            .compare(50) <= 0
        records.length <= 1
        toDecimal(view.totals.unappliedTotal).compare(0) >= 0
    }
})
feature("first native legacy adoption races a raw refund link under sorted original and child locks", {
    when() {
        const h = helper(),
            paymentId = h.lifecycle.settlement.payment(f, "60", "receivable", {
                paymentInstrumentEnumId: "PiOther",
                toPaymentMethodId: f.methodId
            }),
            draft = h.call("mantle.account.PaymentServices.create#Payment", {
                fromPartyId: f.org,
                toPartyId: f.customer,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiOther",
                statusId: "PmntProposed",
                amount: "20",
                amountUomId: "USD",
                effectiveDate: f.timestamp,
                paymentMethodId: f.methodId
            }).paymentId,
            before = h.lib.one("mantle.account.payment.Payment", {paymentId}),
            review = h.preview(f, paymentId),
            results = race([
                {
                    name: "mantle.account.PaymentServices.refund#ReviewedPayment",
                    parameters: confirmInput(review, "ref-con-first-adopt")
                },
                {
                    name: "update#mantle.account.payment.Payment",
                    parameters: {paymentId: draft, refundForPaymentId: paymentId, paymentTypeEnumId: "PtRefund"}
                }
            ])
        return {
            before,
            results,
            records: h.lib.rows("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}),
            original: h.lib.one("mantle.account.payment.Payment", {paymentId}),
            draft: h.lib.one("mantle.account.payment.Payment", {paymentId: draft})
        }
    },
    then({before, results, records, original, draft}) {
        before.lifecycleManaged != "Y"
        results.filter(row => row.result).length == 1
        results.filter(row => row.failure).length == 1
        results
            .filter(row => row.failure)
            .every(row =>
                /PAYMENT_REFUND_REVIEW_REQUIRED|REFUND_HISTORY_CHANGED|REFUND_HISTORY_INCONSISTENT|PAYMENT_SOURCE_CHANGED/.test(
                    row.failure
                )
            )
        records.length <= 1
        toDecimal(original.amount).eq(60)
        records.length === 1
            ? original.lifecycleManaged === "Y" && draft.refundForPaymentId == null
            : draft.refundForPaymentId === original.paymentId && original.lifecycleManaged !== "Y"
    }
})
