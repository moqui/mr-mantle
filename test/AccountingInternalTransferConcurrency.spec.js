const helper = () => ec.resource.script("component://mr-mantle/test/AccountingInternalTransferFixtures.js")
let f
function compete(reviews, keys) {
    const requests = reviews.map((review, i) => ({
        previewId: review.previewId,
        inputFingerprint: review.inputFingerprint,
        operationKey: keys[i]
    }))
    return parallel(
        2,
        (thread, args) => {
            login(args.username)
            ec.artifactExecution.disableAuthz()
            try {
                return {result: call("mantle.account.PaymentServices.create#InternalTransfer", args.requests[thread])}
            } catch (error) {
                ec.message.clearErrors()
                return {failure: error.message}
            }
        },
        {username: ec.user.username, requests},
        {transaction: true, timeout: 60}
    )
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_XFRCN")
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
feature("simultaneous identical transfer keys return one pair and exactly two postings", {
    when() {
        const h = helper(),
            review = h.preview(f),
            results = compete([review, review], ["xfer-parallel-exact", "xfer-parallel-exact"]),
            pairs = h.lib.rows("mantle.account.payment.PaymentInternalTransfer", {operationKey: "xfer-parallel-exact"}),
            ids = pairs.length ? [pairs[0].fromPaymentId, pairs[0].toPaymentId] : []
        return {
            results,
            pairs,
            transactions: ids.length
                ? Array.from(h.lib.find("mantle.ledger.transaction.AcctgTrans").condition("paymentId", "in", ids).list())
                : []
        }
    },
    then({results, pairs, transactions}) {
        results.every(row => row.result)
        results.filter(row => row.result.alreadyApplied).length == 1
        pairs.length == 1
        results.every(row => row.result.internalTransferId === pairs[0].internalTransferId)
        transactions.length == 2
        transactions.every(row => row.isPosted === "Y")
    }
})
feature(
    "two separately reviewed transfers through the same bank and transit accounts both succeed without balance metadata staling policy",
    {
        when() {
            const h = helper(),
                reviews = [h.preview(f, {amount: "11"}), h.preview(f, {amount: "12"})],
                results = compete(reviews, ["xfer-parallel-first", "xfer-parallel-second"])
            return {
                results,
                pairs: Array.from(
                    h.lib
                        .find("mantle.account.payment.PaymentInternalTransfer")
                        .condition("operationKey", "in", ["xfer-parallel-first", "xfer-parallel-second"])
                        .list()
                )
            }
        },
        then({results, pairs}) {
            results.every(row => row.result)
            pairs.length == 2
            results[0].result.internalTransferId != results[1].result.internalTransferId
            pairs.every(row => row.status === "completed")
            results.every(row => row.result.acctgTransIds.length === 2)
        }
    }
)
