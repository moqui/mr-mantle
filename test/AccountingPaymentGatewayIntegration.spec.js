// Common gateway admission: legacy I/O stays outside reviewed records and first adoption cannot race old providers.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const P = "mantle.account.payment.Payment"
const R = "mantle.account.method.PaymentGatewayResponse"
let f
function legacyPayment(extra = {}) {
    const h = helper()
    return h.call(
        "create#" + P,
        Object.assign(
            {
                fromPartyId: f.customer,
                toPartyId: f.org,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiCreditCard",
                amount: "60",
                amountUomId: "USD",
                statusId: "PmntPromised",
                effectiveDate: f.timestamp,
                accountingDate: f.day,
                paymentMethodId: f.customerMethodId,
                toPaymentMethodId: f.methodId
            },
            extra
        )
    ).paymentId
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWINT")
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
    "shipped legacy provider leaves refuse native drafts before provider response creation while unmanaged calls still work",
    {
        when() {
            const h = helper(),
                managedId = h.draft(f),
                legacyId = legacyPayment(),
                service = "mantle.account.PaymentTestServices.alwaysApprove#PaymentAuthorization",
                positive = h.call(service, {paymentId: legacyId, paymentGatewayConfigId: f.gatewayId}),
                refusal = h.lifecycle.rejected(service, {paymentId: managedId, paymentGatewayConfigId: f.gatewayId})
            return {positive, refusal, responses: h.lifecycle.count(R, {paymentId: managedId})}
        },
        then({positive, refusal, responses}) {
            positive.paymentGatewayResponseId != null
            refusal.includes("GATEWAY_REVIEW_REQUIRED")
            responses == 0
        }
    }
)

feature("legacy single store details and refund wrappers reload both payment identities before I/O", {
    when() {
        const h = helper(),
            managedId = h.draft(f),
            legacyId = legacyPayment(),
            forged = ec.entity.makeValue(P, {paymentId: managedId, lifecycleManaged: "N", amount: "1"}),
            errors = [
                h.lifecycle.rejected("authorize#SinglePayment", {
                    paymentId: managedId,
                    payment: forged,
                    paymentGatewayConfigId: f.gatewayId
                }),
                h.lifecycle.rejected("authorize#StorePayment", {
                    paymentId: managedId,
                    payment: forged,
                    productStoreId: "NOT_USED"
                }),
                h.lifecycle.rejected("capture#SinglePayment", {paymentId: managedId, payment: forged}),
                h.lifecycle.rejected("release#SinglePayment", {paymentId: managedId, payment: forged}),
                h.lifecycle.rejected("get#SinglePaymentGatewayDetails", {paymentId: managedId, payment: forged}),
                h.lifecycle.rejected("refund#SinglePayment", {paymentId: legacyId, refundPaymentId: managedId, amount: "1"})
            ]
        return {errors, responses: h.lifecycle.count(R, {paymentId: managedId})}
    },
    then({errors, responses}) {
        errors.length == 6
        errors.every(message => message.includes("GATEWAY_REVIEW_REQUIRED"))
        responses == 0
    }
})

feature("a configured legacy adapter with an arbitrary service name is gated before its independently committed effect", {
    when() {
        const h = helper(),
            managedId = h.draft(f),
            legacyId = legacyPayment(),
            service = "mantle.account.PaymentGatewayTestServices.invoke#ReviewedOperation"
        h.call("update#mantle.account.method.PaymentGatewayConfig", {
            paymentGatewayConfigId: f.gatewayId,
            authorizeServiceName: service
        })
        const request = {
            providerOperationId: "legacy-probe-" + ec.user.randomString(16),
            merchantNamespace: f.merchantNamespace,
            adapterVersion: "fixture-v1",
            action: "authorize",
            paymentGatewayConfigId: f.gatewayId,
            amount: "60",
            currencyUomId: "USD"
        }
        let positive, refusal
        try {
            positive = h.call(service, Object.assign({}, request, {paymentId: legacyId}))
            refusal = h.lifecycle.rejected(
                service,
                Object.assign({}, request, {paymentId: managedId, providerOperationId: "refused-" + ec.user.randomString(16)})
            )
        } finally {
            h.call("update#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gatewayId,
                authorizeServiceName: null
            })
        }
        return {
            positive,
            refusal,
            effects: h.lifecycle.count("mantle.account.payment.PaymentGatewayTestEffect", {paymentId: managedId})
        }
    },
    then({positive, refusal, effects}) {
        positive.outcome == "accepted"
        refusal.includes("GATEWAY_REVIEW_REQUIRED")
        effects == 0
    }
})

feature("first adoption checks the original gateway method before a caller can replace it with cash", {
    when() {
        const h = helper(),
            paymentId = legacyPayment({statusId: "PmntProposed"}),
            request = h.lifecycle.request(f, {
                paymentId,
                paymentInstrumentEnumId: "PiCash",
                counterpartyPaymentMethodId: null,
                counterpartyMethodVersion: null,
                sourceVersion: h.lifecycle.detail(f, paymentId).sourceVersion,
                operationKey: "adoption-refused-" + ec.user.randomString(16)
            }),
            refusal = h.lifecycle.rejected("store#PaymentDraft", request),
            payment = h.lib.one(P, {paymentId})
        return {refusal, payment}
    },
    then({refusal, payment}) {
        refusal.includes("LEGACY_GATEWAY_ADOPTION_REFUSED")
        payment.lifecycleManaged != "Y"
        payment.paymentInstrumentEnumId == "PiCreditCard"
        payment.paymentMethodId == f.customerMethodId
    }
})

feature("clean legacy manual payments can still be adopted and new native gateway drafts remain supported", {
    when() {
        const h = helper(),
            legacyId = legacyPayment({
                statusId: "PmntProposed",
                paymentInstrumentEnumId: "PiCash",
                paymentMethodId: null
            }),
            saved = h.native(
                "store#PaymentDraft",
                h.lifecycle.request(f, {
                    paymentId: legacyId,
                    sourceVersion: h.lifecycle.detail(f, legacyId).sourceVersion,
                    operationKey: "adoption-manual-" + ec.user.randomString(16)
                })
            ),
            nativeId = h.draft(f),
            review = h.preview(f, nativeId)
        return {saved, adopted: h.lib.one(P, {paymentId: legacyId}), review}
    },
    then({saved, adopted, review}) {
        saved.paymentId == adopted.paymentId
        adopted.lifecycleManaged == "Y"
        review.canApply == true
    }
})

feature("managed gateway instructions cannot create cash or applications with adoption flags disabled", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            invoiceId = h.lifecycle.settlement.invoice(f)
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            settlementApplicationGuardEnabled: "N",
            postingGuardEnabled: "N"
        })
        const errors = []
        try {
            for (const acctgTransTypeEnumId of ["AttIncomingPayment", "AttPaymentApplied"])
                errors.push(
                    h.lifecycle.rejected("create#mantle.ledger.transaction.AcctgTrans", {
                        organizationPartyId: f.org,
                        paymentId,
                        acctgTransTypeEnumId,
                        transactionDate: f.timestamp,
                        isPosted: "N"
                    })
                )
            errors.push(
                h.lifecycle.rejected("create#mantle.account.payment.PaymentApplication", {
                    paymentId,
                    invoiceId,
                    amountApplied: "1",
                    currencyUomId: "USD",
                    accountingDate: f.day,
                    appliedDate: f.timestamp
                })
            )
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y",
                postingGuardEnabled: "Y"
            })
        }
        return {
            errors,
            transactions: h.lifecycle.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            applications: h.lifecycle.count("mantle.account.payment.PaymentApplication", {paymentId})
        }
    },
    then({errors, transactions, applications}) {
        errors.length == 3
        errors.every(message => message.includes("GATEWAY_CAPTURE_REQUIRED"))
        transactions == 0
        applications == 0
    }
})

feature("reviewed gateway adoption is an audited administrator preference that requires settlement controls", {
    when() {
        const h = helper(),
            pref = "mantle.ledger.config.PartyAcctgPreference",
            defaults = h.lifecycle.fixtures("ACCT_P5_GWDEF"),
            defaultFlag = h.lib.one(pref, {organizationPartyId: defaults.org}).paymentGatewayWorkflowEnabled,
            parameters = {
                organizationPartyId: f.org,
                lastUpdatedStamp: h.lib.one(pref, {organizationPartyId: f.org}).lastUpdatedStamp,
                settings: {paymentGatewayWorkflowEnabled: "N"},
                changeReason: "Pause reviewed provider processing"
            }
        login(f.users.paymentView)
        const permission = h.lifecycle.rejected("mantle.ledger.SetupServices.store#Preferences", parameters)
        login("john.doe")
        h.call("mantle.ledger.SetupServices.store#Preferences", parameters)
        const audit = h.lib
                .find("moqui.entity.EntityAuditLog", {
                    changedEntityName: pref,
                    changedFieldName: "paymentGatewayWorkflowEnabled",
                    pkPrimaryValue: f.org
                })
                .orderBy("-changedDate")
                .list(),
            before = h.lib.one(pref, {organizationPartyId: f.org}),
            dependency = h.lifecycle.rejected("mantle.ledger.SetupServices.store#Preferences", {
                organizationPartyId: f.org,
                lastUpdatedStamp: before.lastUpdatedStamp,
                settings: {paymentGatewayWorkflowEnabled: "Y", settlementApplicationGuardEnabled: "N"},
                changeReason: "Invalid dependency"
            }),
            after = h.lib.one(pref, {organizationPartyId: f.org})
        h.call("mantle.ledger.SetupServices.store#Preferences", {
            organizationPartyId: f.org,
            lastUpdatedStamp: after.lastUpdatedStamp,
            settings: {paymentGatewayWorkflowEnabled: "Y"},
            changeReason: "Resume reviewed provider processing"
        })
        return {defaultFlag, permission, auditCount: Array.from(audit).length, dependency, after}
    },
    then({defaultFlag, permission, auditCount, dependency, after}) {
        defaultFlag == "N"
        permission.includes("Accounting admin authority is required")
        auditCount > 0
        dependency.includes("GATEWAY_SETTLEMENT_REQUIRED")
        after.paymentGatewayWorkflowEnabled == "N"
        after.settlementApplicationGuardEnabled == "Y"
    }
})

feature("legacy and raw refund creation cannot bypass a managed original's reviewed refund workflow", {
    when() {
        const h = helper(),
            managedId = h.lifecycle.delivered(f),
            legacyId = legacyPayment({statusId: "PmntDelivered", paymentInstrumentEnumId: "PiCash", paymentMethodId: null}),
            refundId = legacyPayment({
                fromPartyId: f.org,
                toPartyId: f.customer,
                paymentTypeEnumId: "PtRefund",
                paymentInstrumentEnumId: "PiCash",
                paymentMethodId: f.methodId,
                toPaymentMethodId: null
            })
        h.native("set#PaymentRefundFor", {paymentId: refundId, refundForPaymentId: legacyId})
        const legacyLinked = h.lib.one(P, {paymentId: refundId}).refundForPaymentId,
            counts = () => ({
                payments: h.lifecycle.count(P, {toPartyId: f.org}),
                transactions: h.lifecycle.count("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: f.org}),
                applications: h.lifecycle.count("mantle.account.payment.PaymentApplication", {toPaymentId: managedId})
            }),
            before = counts(),
            wrapperErrors = [
                h.lifecycle.rejected("create#RefundPayment", {paymentId: managedId, amount: "1", statusId: "PmntDelivered"}),
                h.lifecycle.rejected("set#PaymentRefundFor", {paymentId: refundId, refundForPaymentId: managedId})
            ],
            rawErrors = [
                h.lifecycle.rejected("create#" + P, {
                    fromPartyId: f.org,
                    toPartyId: f.customer,
                    paymentTypeEnumId: "PtRefund",
                    paymentInstrumentEnumId: "PiCash",
                    amount: "1",
                    amountUomId: "USD",
                    statusId: "PmntDelivered",
                    effectiveDate: f.timestamp,
                    refundForPaymentId: managedId
                }),
                h.lifecycle.rejected("update#" + P, {paymentId: refundId, refundForPaymentId: managedId})
            ]
        return {
            legacyLinked,
            legacyId,
            wrapperErrors,
            rawErrors,
            before,
            after: counts(),
            linked: h.lib.one(P, {paymentId: refundId}).refundForPaymentId
        }
    },
    then({legacyLinked, legacyId, wrapperErrors, rawErrors, before, after, linked}) {
        legacyLinked == legacyId
        wrapperErrors.every(message => message.includes("GATEWAY_REVIEW_REQUIRED"))
        rawErrors.every(message => message.includes("PAYMENT_REFUND_REVIEW_REQUIRED"))
        JSON.stringify(before) == JSON.stringify(after)
        linked == legacyId
    }
})

feature("default-off legacy refund and raw application can finish concurrently without reversing the org and Payment locks", {
    where: [{iteration: 1}, {iteration: 2}, {iteration: 3}],
    when({iteration}) {
        const h = helper(),
            paymentId = legacyPayment({statusId: "PmntDelivered", paymentInstrumentEnumId: "PiCash", paymentMethodId: null}),
            invoiceId = h.lifecycle.settlement.invoice(f)
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            settlementApplicationGuardEnabled: "N",
            postingGuardEnabled: "N"
        })
        let results
        try {
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    try {
                        if (thread === 0) {
                            const result = call("mantle.account.PaymentServices.create#RefundPayment", {
                                paymentId: args.paymentId,
                                amount: "10",
                                statusId: "PmntDelivered",
                                effectiveDate: args.timestamp
                            })
                            return {ok: true, refundPaymentId: result.paymentId}
                        }
                        const result = call("create#mantle.account.payment.PaymentApplication", {
                            paymentId: args.paymentId,
                            invoiceId: args.invoiceId,
                            amountApplied: "10",
                            appliedDate: args.timestamp
                        })
                        return {ok: true, paymentApplicationId: result.paymentApplicationId}
                    } catch (error) {
                        ec.message.clearErrors()
                        return {error: error.message}
                    }
                },
                {paymentId, invoiceId, timestamp: f.timestamp},
                {transaction: false, timeout: 30}
            )
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y",
                postingGuardEnabled: "Y"
            })
        }
        return {results, iteration}
    },
    then({results, iteration}) {
        iteration > 0
        results.length == 2
        results.every(result => result.ok == true)
        results.some(result => result.refundPaymentId != null)
        results.some(result => result.paymentApplicationId != null)
    }
})
