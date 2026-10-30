// Real independent server transactions. Inputs cross the harness boundary explicitly; no closure state or Node dependency.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
let f
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("SETTLE_CONC")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
})
feature("simultaneous exact confirmation retries create one application and operation", {
    when() {
        const h = helper(),
            invoice = h.invoice(f, "60"),
            payment = h.payment(f, "60"),
            preview = h.review(f, [{sourceKey: h.key("payment", payment), targetKey: h.key("invoice", invoice), amount: "60"}])
        const args = {
            previewId: preview.previewId,
            inputFingerprint: preview.inputFingerprint,
            operationKey: "settle-concurrent-replay"
        }
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                return call("mantle.account.PaymentServices.apply#Settlement", args)
            },
            args,
            {transaction: false, timeout: 30}
        )
        return {
            results,
            count: h.count("mantle.account.payment.PaymentApplication", {paymentId: payment}),
            operations: h.count("mantle.ledger.transaction.PostingOperation", {operationKey: args.operationKey})
        }
    },
    then({results, count, operations}) {
        results.length == 2
        results.filter(row => row.alreadyApplied).length == 1
        count == 1
        operations == 1
    }
})
feature("two reviewed transactions cannot overconsume one shared source payment", {
    when() {
        const h = helper(),
            payment = h.payment(f, "60"),
            a = h.invoice(f, "40"),
            b = h.invoice(f, "40"),
            previews = [a, b].map(id =>
                h.review(f, [{sourceKey: h.key("payment", payment), targetKey: h.key("invoice", id), amount: "40"}])
            )
        const args = {
            requests: previews.map((p, index) => ({
                previewId: p.previewId,
                inputFingerprint: p.inputFingerprint,
                operationKey: "settle-shared-source-" + index
            }))
        }
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call("mantle.account.PaymentServices.apply#Settlement", args.requests[thread])}
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        const apps = h.lib.rows("mantle.account.payment.PaymentApplication", {paymentId: payment})
        return {results, applied: apps.reduce((sum, row) => sum.add(row.amountApplied), toDecimal(0))}
    },
    then({results, applied}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.error && row.error.includes("STALE_PREVIEW")).length == 1
        applied == 40
    }
})
feature("two source payments cannot overconsume one shared invoice target", {
    when() {
        const h = helper(),
            invoice = h.invoice(f, "60"),
            payments = [h.payment(f, "40"), h.payment(f, "40")],
            previews = payments.map(id =>
                h.review(f, [{sourceKey: h.key("payment", id), targetKey: h.key("invoice", invoice), amount: "40"}])
            )
        const args = {
            requests: previews.map((p, index) => ({
                previewId: p.previewId,
                inputFingerprint: p.inputFingerprint,
                operationKey: "settle-shared-target-" + index
            }))
        }
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call("mantle.account.PaymentServices.apply#Settlement", args.requests[thread])}
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        return {results, balance: h.lib.totals(h.lib.one(h.lib.invoiceEntity, {invoiceId: invoice})).unpaidTotal}
    },
    then({results, balance}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.error && row.error.includes("STALE_PREVIEW")).length == 1
        balance == 20
    }
})
feature("disjoint reviewed documents sharing control accounts both complete concurrently", {
    when() {
        const h = helper(),
            previews = [0, 1].map(() => {
                const invoice = h.invoice(f, "10"),
                    payment = h.payment(f, "10")
                return h.review(f, [{sourceKey: h.key("payment", payment), targetKey: h.key("invoice", invoice), amount: "10"}])
            })
        const args = {
            requests: previews.map((p, index) => ({
                previewId: p.previewId,
                inputFingerprint: p.inputFingerprint,
                operationKey: "settle-disjoint-" + index
            }))
        }
        return {
            value: parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    return call("mantle.account.PaymentServices.apply#Settlement", args.requests[thread])
                },
                args,
                {transaction: false, timeout: 30}
            )
        }
    },
    then({value: results}) {
        results.length == 2
        results.every(row => row.reasonCode === "OK" && !row.alreadyApplied)
    }
})
feature("legacy and reviewed apply compete safely for a shared source under adopted guards", {
    when() {
        const h = helper(),
            payment = h.payment(f, "60"),
            a = h.invoice(f, "40"),
            b = h.invoice(f, "40"),
            preview = h.review(f, [{sourceKey: h.key("payment", payment), targetKey: h.key("invoice", a), amount: "40"}])
        const args = {
            requests: [
                {
                    service: "mantle.account.PaymentServices.apply#Settlement",
                    params: {
                        previewId: preview.previewId,
                        inputFingerprint: preview.inputFingerprint,
                        operationKey: "settle-legacy-source"
                    }
                },
                {
                    service: "mantle.account.PaymentServices.apply#InvoicePayment",
                    params: {paymentId: payment, invoiceId: b, amount: "40"}
                }
            ]
        }
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call(args.requests[thread].service, args.requests[thread].params)}
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        const apps = h.lib.rows("mantle.account.payment.PaymentApplication", {paymentId: payment})
        return {results, applied: apps.reduce((sum, row) => sum.add(row.amountApplied), toDecimal(0))}
    },
    then({results, applied}) {
        results.some(row => row.result)
        toDecimal(applied).compare(60) <= 0
        toDecimal(applied).compare(40) >= 0
    }
})
feature("legacy and reviewed apply compete safely for a shared target under adopted guards", {
    when() {
        const h = helper(),
            invoice = h.invoice(f, "60"),
            a = h.payment(f, "40"),
            b = h.payment(f, "40"),
            preview = h.review(f, [{sourceKey: h.key("payment", a), targetKey: h.key("invoice", invoice), amount: "40"}])
        const args = {
            requests: [
                {
                    service: "mantle.account.PaymentServices.apply#Settlement",
                    params: {
                        previewId: preview.previewId,
                        inputFingerprint: preview.inputFingerprint,
                        operationKey: "settle-legacy-target"
                    }
                },
                {
                    service: "mantle.account.PaymentServices.apply#InvoicePayment",
                    params: {paymentId: b, invoiceId: invoice, amount: "40"}
                }
            ]
        }
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call(args.requests[thread].service, args.requests[thread].params)}
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        const balance = h.lib.totals(h.lib.one(h.lib.invoiceEntity, {invoiceId: invoice})).unpaidTotal
        return {results, balance}
    },
    then({results, balance}) {
        results.some(row => row.result)
        toDecimal(balance).compare(0) >= 0
        toDecimal(balance).compare(20) <= 0
    }
})
feature("application invariant also serializes competing raw applications when no source GL exists", {
    when() {
        const h = helper(),
            invoice = h.invoice(f, "100"),
            payment = h.call("create#mantle.account.payment.Payment", {
                fromPartyId: f.customer,
                toPartyId: f.org,
                statusId: "PmntDelivered",
                paymentTypeEnumId: "PtInvoicePayment",
                amount: "60",
                amountUomId: "USD",
                effectiveDate: f.timestamp
            }).paymentId
        const args = {paymentId: payment, invoiceId: invoice, amountApplied: "40", appliedDate: f.timestamp}
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call("create#mantle.account.payment.PaymentApplication", args)}
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        const apps = h.lib.rows("mantle.account.payment.PaymentApplication", {paymentId: payment})
        return {results, apps}
    },
    then({results, apps}) {
        results.filter(row => row.result).length == 1
        results.some(row => row.error && row.error.includes("APPLICATION_BALANCE_CHANGED"))
        apps.length == 1
        apps[0].acctgTransResultEnumId == "AtrPaymentNotPosted"
    }
})
