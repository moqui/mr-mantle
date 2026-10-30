const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentRefundFixtures.js")
let f
function rawApplication(paymentId, target, amount) {
    return helper().lib.probe(
        "create#mantle.account.payment.PaymentApplication",
        Object.assign(
            {
                paymentApplicationId: ec.user.randomString(32),
                paymentId,
                amountApplied: amount,
                appliedDate: f.timestamp,
                accountingDate: f.day,
                currencyUomId: "USD"
            },
            target
        )
    )
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_REF_INV")
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
    "completed funding remains immutable with flags off while new applications respect actual remaining original and refund capacities",
    {
        when() {
            const h = helper(),
                paymentId = h.cash(f, "incoming", "50"),
                opposite = h.cash(f, "incoming", "20"),
                invoiceId = h.lifecycle.settlement.invoice(f, "60"),
                result = h.confirm(h.preview(f, paymentId), "ref-inv-flags-off"),
                record = h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: result.refundPaymentId}),
                pref = h.lib.policy.preference(f.org),
                saved = h.lib.policy.pick(h.lib.map(pref), ["postingGuardEnabled", "settlementApplicationGuardEnabled"])
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                postingGuardEnabled: "N",
                settlementApplicationGuardEnabled: "N"
            })
            let good, over, refundOver, zero, remove, reparent, source
            try {
                good = rawApplication(paymentId, {invoiceId}, "10")
                try {
                    rawApplication(paymentId, {invoiceId}, "21")
                    over = ""
                } catch (error) {
                    ec.message.clearErrors()
                    over = error.message
                }
                try {
                    rawApplication(result.refundPaymentId, {toPaymentId: opposite}, "1")
                    refundOver = ""
                } catch (error) {
                    ec.message.clearErrors()
                    refundOver = error.message
                }
                zero = h.lifecycle.rejected("update#mantle.account.payment.PaymentApplication", {
                    paymentApplicationId: result.paymentApplicationId,
                    amountApplied: "0"
                })
                remove = h.lifecycle.rejected("delete#mantle.account.payment.PaymentApplication", {
                    paymentApplicationId: result.paymentApplicationId
                })
                reparent = h.lifecycle.rejected("update#mantle.account.payment.PaymentApplication", {
                    paymentApplicationId: result.paymentApplicationId,
                    toPaymentId: opposite
                })
                source = h.lifecycle.rejected("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
                    acctgTransId: record.originalAcctgTransId,
                    changeReason: "Attempt to reuse refunded cash"
                })
            } finally {
                h.call("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: f.org}, saved))
            }
            return {
                good,
                over,
                refundOver,
                zero,
                remove,
                reparent,
                source,
                original: h.lifecycle.detail(f, paymentId),
                refund: h.lifecycle.detail(f, result.refundPaymentId),
                backing: h.lib.one("mantle.account.payment.PaymentApplication", {
                    paymentApplicationId: result.paymentApplicationId
                })
            }
        },
        then({good, over, refundOver, zero, remove, reparent, source, original, refund, backing}) {
            good.paymentApplicationId != null
            over.includes("APPLICATION_BALANCE_CHANGED")
            refundOver.includes("APPLICATION_BALANCE_CHANGED")
            zero.includes("REFUND_FUNDING_IMMUTABLE")
            remove.includes("REFUND_FUNDING_IMMUTABLE")
            reparent.includes("REFUND_FUNDING_IMMUTABLE")
            source.includes("REFUND_SOURCE_IMMUTABLE")
            toDecimal(original.totals.unappliedTotal).eq(20)
            toDecimal(refund.totals.unappliedTotal).isZero()
            toDecimal(backing.amountApplied).eq(20)
        }
    }
)
feature("unrelated invoice allocation can be unapplied while the exact completed refund funding cannot", {
    when() {
        const h = helper(),
            paymentId = h.cash(f, "incoming", "50"),
            result = h.confirm(h.preview(f, paymentId), "ref-inv-unrelated"),
            invoiceId = h.lifecycle.settlement.invoice(f, "20")
        h.lifecycle.apply(f, paymentId, invoiceId, "20")
        const view = h.lifecycle.detail(f, paymentId),
            invoiceApplication = view.applicationRows.find(row => row.invoiceId === invoiceId),
            request = h.lifecycle.unapplyRequest(f, paymentId, [invoiceApplication.paymentApplicationId]),
            review = h.native("preview#PaymentUnapply", request),
            unapplied = h.native("unapply#ReviewedPayment", {
                previewId: review.previewId,
                inputFingerprint: review.inputFingerprint,
                operationKey: "ref-inv-unapply-invoice"
            }),
            fundingDenied = h.lifecycle.rejected(
                "preview#PaymentUnapply",
                h.lifecycle.unapplyRequest(f, paymentId, [result.paymentApplicationId])
            )
        return {
            unapplied,
            fundingDenied,
            original: h.lifecycle.detail(f, paymentId),
            backing: h.lib.one("mantle.account.payment.PaymentApplication", {paymentApplicationId: result.paymentApplicationId})
        }
    },
    then({unapplied, fundingDenied, original, backing}) {
        unapplied.applicationResults.length == 1
        fundingDenied.includes("REFUND_FUNDING_IMMUTABLE")
        toDecimal(original.totals.unappliedTotal).eq(30)
        toDecimal(backing.amountApplied).eq(20)
    }
})
feature("a caller rollback after actual native cash and application posting removes the whole refund operation and outputs", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            review = h.preview(f, paymentId),
            before = h.counts(paymentId)
        let failure = ""
        try {
            parallel(
                1,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    const result = call("mantle.account.PaymentServices.refund#ReviewedPayment", args)
                    if (!result.refundPaymentId || !result.paymentApplicationId || result.acctgTransIds.length !== 2)
                        throw new Error("TEST_REFUND_POSTS_MISSING: Native operation did not reach both actual postings")
                    throw new Error("TEST_REFUND_CALLER_ROLLBACK: " + result.refundPaymentId)
                },
                {previewId: review.previewId, inputFingerprint: review.inputFingerprint, operationKey: "ref-inv-rollback"},
                {transaction: true, timeout: 60}
            )
        } catch (error) {
            ec.message.clearErrors()
            failure = error.message
        }
        return {
            failure,
            before,
            after: h.counts(paymentId),
            operations: h.lib.find(h.lib.operationEntity, {operationKey: "ref-inv-rollback"}).count(),
            records: h.lib.find("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}).count(),
            review: h.native("get#PaymentRefundPreview", {previewId: review.previewId}),
            source: h.lifecycle.detail(f, paymentId)
        }
    },
    then({failure, before, after, operations, records, review, source}) {
        failure.includes("TEST_REFUND_CALLER_ROLLBACK")
        JSON.stringify(before) == JSON.stringify(after)
        operations == 0
        records == 0
        review.status == "review"
        toDecimal(source.totals.unappliedTotal).eq(60)
    }
})
feature("a valid native refund source remains manually refundable when a bank later receives a provider configuration", {
    when() {
        const h = helper(),
            paymentId = h.cash(f),
            gatewayId = "REF_BANK_ROUTE_" + ec.user.randomString(16),
            method = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.methodId})
        h.call("create#mantle.account.method.PaymentGatewayConfig", {
            paymentGatewayConfigId: gatewayId,
            paymentGatewayTypeEnumId: "PgtTest",
            description: "Later route metadata"
        })
        h.call("update#mantle.account.method.PaymentMethod", {paymentMethodId: f.methodId, paymentGatewayConfigId: gatewayId})
        let result, summary
        try {
            summary = h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
            result = h.confirm(h.preview(f, paymentId), "ref-inv-route-metadata")
        } finally {
            h.call("update#mantle.account.method.PaymentMethod", {
                paymentMethodId: f.methodId,
                paymentGatewayConfigId: method.paymentGatewayConfigId
            })
        }
        return {
            summary,
            result,
            provider: h.lib.find("mantle.account.method.PaymentGatewayResponse", {paymentId: result.refundPaymentId}).count()
        }
    },
    then({summary, result, provider}) {
        summary.capabilities.canRefund == true
        result.reasonCode == "REFUND_COMPLETED"
        provider == 0
    }
})
