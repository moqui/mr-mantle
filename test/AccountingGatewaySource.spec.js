// Exact common-guard bypass proofs use real captured cash, applications and concurrent native adoption.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const P = "mantle.account.payment.Payment",
    T = "mantle.ledger.transaction.AcctgTrans",
    A = "mantle.account.payment.PaymentApplication"
let f
function capture() {
    const h = helper(),
        paymentId = h.draft(f)
    h.execute(h.preview(f, paymentId))
    return h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
}
function header(extra = {}) {
    return Object.assign(
        {
            acctgTransId: "GWS_" + ec.user.randomString(24),
            organizationPartyId: f.org,
            acctgTransTypeEnumId: "AttIncomingPaymentAp",
            transactionDate: f.timestamp,
            accountingDate: f.day,
            amountUomId: "USD",
            glFiscalTypeEnumId: "GLFT_ACTUAL",
            isPosted: "N"
        },
        extra
    )
}
function withoutControls(action) {
    const h = helper(),
        saved = h.lib.policy.pick(h.lib.map(h.lib.policy.preference(f.org)), [
            "postingGuardEnabled",
            "settlementApplicationGuardEnabled",
            "paymentGatewayWorkflowEnabled"
        ])
    h.call("update#mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: f.org,
        postingGuardEnabled: "N",
        settlementApplicationGuardEnabled: "N",
        paymentGatewayWorkflowEnabled: "N"
    })
    try {
        return action()
    } finally {
        h.call("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: f.org}, saved))
    }
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWSOURCE")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().lifecycle.settlement.base.cleanupLocks(f.org)
    }
})

feature("authorization parents and gateway drafts cannot enter an AP header solely as its target with controls off", {
    when() {
        const h = helper(),
            draftId = h.draft(f),
            parentId = h.draft(f)
        h.execute(h.preview(f, parentId))
        const records = [header({toPaymentId: parentId}), header({toPaymentId: draftId})],
            errors = withoutControls(() => records.map(row => h.lifecycle.rejected("create#" + T, row)))
        return {errors, count: records.reduce((total, row) => total + h.lifecycle.count(T, {acctgTransId: row.acctgTransId}), 0)}
    },
    then({errors, count}) {
        errors[0].includes("GATEWAY_AUTHORIZATION_NOT_CASH")
        errors[1].includes("GATEWAY_CAPTURE_REQUIRED")
        count == 0
    }
})

feature("a real application id cannot disguise omitted invoice links or another currency on captured cash", {
    when() {
        const h = helper(),
            cash = capture(),
            invoiceId = h.lifecycle.settlement.invoice(f, "20")
        h.lifecycle.apply(f, cash.cashPaymentId, invoiceId, "20")
        const application = h.lib.one(A, {paymentId: cash.cashPaymentId, invoiceId}),
            records = [
                header({paymentId: cash.cashPaymentId, paymentApplicationId: application.paymentApplicationId}),
                header({
                    paymentId: cash.cashPaymentId,
                    invoiceId,
                    paymentApplicationId: application.paymentApplicationId,
                    amountUomId: "EUR"
                })
            ],
            errors = withoutControls(() => records.map(row => h.lifecycle.rejected("create#" + T, row)))
        return {
            errors,
            count: records.reduce((total, row) => total + h.lifecycle.count(T, {acctgTransId: row.acctgTransId}), 0),
            application
        }
    },
    then({errors, count, application}) {
        errors.length == 2
        errors.every(error => error.includes("GATEWAY_CASH_POSTING_IMMUTABLE"))
        count == 0
        toDecimal(application.amountApplied).eq(20)
    }
})

feature("a positive captured-cash application keeps its original payment when all controls are disabled", {
    when() {
        const h = helper(),
            cash = capture(),
            invoiceId = h.lifecycle.settlement.invoice(f, "20"),
            ordinaryId = h.lifecycle.settlement.payment(f, "20")
        h.lifecycle.apply(f, cash.cashPaymentId, invoiceId, "20")
        const application = h.lib.one(A, {paymentId: cash.cashPaymentId, invoiceId}),
            before = JSON.stringify(h.lib.map(application)),
            error = withoutControls(() =>
                h.lifecycle.rejected("update#" + A, {
                    paymentApplicationId: application.paymentApplicationId,
                    paymentId: ordinaryId
                })
            )
        return {
            error,
            before,
            after: JSON.stringify(h.lib.map(h.lib.one(A, {paymentApplicationId: application.paymentApplicationId})))
        }
    },
    then({error, before, after}) {
        error.includes("APPLICATION_IMMUTABLE")
        before == after
    }
})

feature("an AP header initially seeing an unmanaged payment waits for adoption and refuses the newly gateway-backed draft", {
    when() {
        const h = helper(),
            paymentId = h.call("create#" + P, {
                fromPartyId: f.customer,
                toPartyId: f.org,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiCash",
                amount: "60",
                amountUomId: "USD",
                statusId: "PmntProposed",
                effectiveDate: f.timestamp,
                accountingDate: f.day,
                toPaymentMethodId: f.methodId
            }).paymentId,
            workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
            method = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId}),
            request = h.lifecycle.request(f, {
                paymentId,
                sourceVersion: h.lifecycle.detail(f, paymentId).sourceVersion,
                paymentInstrumentEnumId: "PiAch",
                counterpartyPaymentMethodId: f.customerMethodId,
                counterpartyMethodVersion: workflow.methodVersion(method)
            }),
            candidate = header({paymentId, isPosted: "Y"})
        h.call("create#mantle.account.payment.PaymentLegacyGatewayTestProbe", {paymentId, providerEffects: 0})
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                const coordination = ec.resource.script("component://mr-mantle/test/AccountingLegacyGatewayFixture.js")
                if (thread === 0)
                    return call("mantle.account.PaymentLegacyGatewayTestServices.hold#NativeAdoption", {request: args.request})
                coordination.waitFor(args.paymentId, "nativeReady")
                coordination.store(args.paymentId, {legacyRequested: "Y"})
                const started = Date.now()
                try {
                    call("create#mantle.ledger.transaction.AcctgTrans", args.candidate)
                    return {unexpected: true}
                } catch (error) {
                    ec.message.clearErrors()
                    return {refusal: error.message, waitedMs: Date.now() - started}
                } finally {
                    coordination.store(args.paymentId, {legacyFinished: "Y"})
                }
            },
            {paymentId, request, candidate},
            {transaction: false, timeout: 30}
        )
        return {results, payment: h.lib.one(P, {paymentId}), count: h.lifecycle.count(T, {acctgTransId: candidate.acctgTransId})}
    },
    then({results, payment, count}) {
        results.some(result => result.blocked === true)
        results.some(result => result.refusal?.includes("GATEWAY_CAPTURE_REQUIRED") && result.waitedMs >= 200)
        payment.lifecycleManaged == "Y"
        payment.paymentInstrumentEnumId == "PiAch"
        count == 0
    }
})
