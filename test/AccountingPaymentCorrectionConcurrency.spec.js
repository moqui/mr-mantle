const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_CORRC")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})
feature("simultaneous exact void confirmations reverse each original once and replay the recorded IDs", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            invoiceId = h.settlement.invoice(f, "60")
        h.apply(f, paymentId, invoiceId, "60")
        const preview = h.preview(f, paymentId, "void"),
            args = {previewId: preview.previewId, inputFingerprint: preview.inputFingerprint, operationKey: "corr-void-parallel"},
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    return call("mantle.account.PaymentServices.change#PaymentState", args)
                },
                args,
                {transaction: false, timeout: 30}
            )
        return {
            results,
            row: h.lib.one("mantle.account.payment.Payment", {paymentId}),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        }
    },
    then({results, row, transactions}) {
        results.length == 2
        results.filter(result => result.alreadyApplied).length == 1
        results[0].reversalAcctgTransIds.join(",") == results[1].reversalAcctgTransIds.join(",")
        row.statusId == "PmntVoid"
        transactions.length == 4
        transactions.filter(tx => tx.reverseOfAcctgTransId).length == 2
        transactions.every(tx => tx.isPosted === "Y")
    }
})
feature("competing different void reviews commit one correction and no partial second reversal", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            invoiceId = h.settlement.invoice(f, "60")
        h.apply(f, paymentId, invoiceId, "60")
        const previews = [h.preview(f, paymentId, "void"), h.preview(f, paymentId, "void")],
            args = {
                requests: previews.map((preview, index) => ({
                    previewId: preview.previewId,
                    inputFingerprint: preview.inputFingerprint,
                    operationKey: "corr-void-compete-" + index
                }))
            },
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
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
            row: h.lib.one("mantle.account.payment.Payment", {paymentId}),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        }
    },
    then({results, row, transactions}) {
        results.filter(value => value.result).length == 1
        results.filter(value => value.failure).length == 1
        row.statusId == "PmntVoid"
        transactions.length == 4
    }
})
feature("independent simultaneous check deliveries allocate distinct numbers and preserve exact original cash totals", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const payments = [
                h.draft(f, {cashDirection: "outgoing", amount: "20", paymentInstrumentEnumId: "PiCompanyCheck"}),
                h.draft(f, {cashDirection: "outgoing", amount: "30", paymentInstrumentEnumId: "PiCompanyCheck"})
            ],
            previews = payments.map(paymentId => h.preview(f, paymentId, "deliver")),
            args = {
                username: f.users.treasury,
                requests: previews.map((preview, index) => ({
                    previewId: preview.previewId,
                    inputFingerprint: preview.inputFingerprint,
                    operationKey: "corr-check-parallel-" + index
                }))
            },
            results = parallel(
                2,
                (thread, args) => {
                    login(args.username)
                    ec.artifactExecution.disableAuthz()
                    return call("mantle.account.PaymentServices.change#PaymentState", args.requests[thread])
                },
                args,
                {transaction: false, timeout: 60}
            ),
            checks = Array.from(
                h.lib.find("mantle.account.method.BankAccountCheck").condition("paymentId", "in", payments).list()
            ),
            transactions = Array.from(
                h.lib.find("mantle.ledger.transaction.AcctgTrans").condition("paymentId", "in", payments).list()
            ),
            entries = Array.from(
                h.lib
                    .find("mantle.ledger.transaction.AcctgTransEntry")
                    .condition(
                        "acctgTransId",
                        "in",
                        transactions.map(tx => tx.acctgTransId)
                    )
                    .list()
            )
        return {
            results,
            checks,
            transactions,
            entries,
            outputs: Array.from(
                h.lib
                    .find("mantle.account.payment.PaymentIssuedOutput")
                    .condition("paymentId", "in", payments)
                    .condition("outputType", "check")
                    .list()
            )
        }
    },
    then({results, checks, transactions, entries, outputs}) {
        results.length == 2
        results.every(result => result.statusId === "PmntDelivered")
        checks.length == 2
        String(checks[0].checkNumber) != String(checks[1].checkNumber)
        transactions.length == 2
        transactions.every(tx => tx.isPosted === "Y" && tx.acctgTransTypeEnumId === "AttOutgoingPayment")
        entries
            .filter(line => line.glAccountId === "111100000" && line.debitCreditFlag === "C")
            .reduce((sum, line) => sum.add(line.amount), toDecimal(0))
            .eq(50)
        outputs.length == 2
        new Set(outputs.map(row => JSON.parse(row.summaryJson).checkNumber)).size == 2
    }
})
