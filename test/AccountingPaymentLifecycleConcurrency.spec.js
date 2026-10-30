// Actual simultaneous server transactions, with all inputs passed across the worker boundary explicitly.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_LIFEC")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})
feature("simultaneous exact delivery confirmations retain one cash transaction and one completed operation", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.draft(f),
            preview = h.preview(f, paymentId, "deliver"),
            args = {
                username: f.users.treasury,
                request: {
                    previewId: preview.previewId,
                    inputFingerprint: preview.inputFingerprint,
                    operationKey: "life-concurrent-exact"
                }
            }
        const results = parallel(
            2,
            (thread, args) => {
                login(args.username)
                ec.artifactExecution.disableAuthz()
                return call("mantle.account.PaymentServices.change#PaymentState", args.request)
            },
            args,
            {transaction: false, timeout: 30}
        )
        return {
            results,
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            operations: h.count("mantle.ledger.transaction.PostingOperation", {operationKey: args.request.operationKey})
        }
    },
    then({results, transactions, operations}) {
        results.length == 2
        results.filter(row => row.alreadyApplied).length == 1
        transactions.length == 1
        transactions[0].isPosted == "Y"
        operations == 1
    }
})
feature("competing different delivery reviews cannot issue the same cash twice", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.draft(f),
            previews = [h.preview(f, paymentId, "deliver"), h.preview(f, paymentId, "deliver")],
            args = {
                username: f.users.treasury,
                requests: previews.map((preview, index) => ({
                    previewId: preview.previewId,
                    inputFingerprint: preview.inputFingerprint,
                    operationKey: "life-compete-deliver-" + index
                }))
            }
        const results = parallel(
            2,
            (thread, args) => {
                login(args.username)
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call("mantle.account.PaymentServices.change#PaymentState", args.requests[thread])}
                } catch (error) {
                    ec.message.clearErrors()
                    return {failure: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        return {results, transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})}
    },
    then({results, transactions}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.failure).length == 1
        transactions.length == 1
        transactions[0].isPosted == "Y"
    }
})
feature("competing cancellation and delivery commit one finite transition and consistent cash evidence", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.draft(f),
            previews = [h.preview(f, paymentId, "deliver"), h.preview(f, paymentId, "cancel")],
            args = {
                username: f.users.treasury,
                requests: previews.map((preview, index) => ({
                    previewId: preview.previewId,
                    inputFingerprint: preview.inputFingerprint,
                    operationKey: "life-compete-cancel-" + index
                }))
            }
        const results = parallel(
            2,
            (thread, args) => {
                login(args.username)
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call("mantle.account.PaymentServices.change#PaymentState", args.requests[thread])}
                } catch (error) {
                    ec.message.clearErrors()
                    return {failure: error.message}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        return {
            results,
            state: h.lib.one("mantle.account.payment.Payment", {paymentId}).statusId,
            count: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId})
        }
    },
    then({results, state, count}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.failure).length == 1
        count == (state === "PmntDelivered" ? 1 : 0)
        ;["PmntDelivered", "PmntCancelled"].includes(state)
    }
})
