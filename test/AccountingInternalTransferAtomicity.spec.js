const helper = () => ec.resource.script("component://mr-mantle/test/AccountingInternalTransferFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_XFRAT")
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
    "failure after the first actual outgoing posting rolls back both legs, pair, money and key before identical retry succeeds",
    {
        when() {
            const h = helper(),
                review = h.preview(f, {feeAmount: "2", feeGlAccountId: "710000000"}),
                key = "xfer-after-first-atomic",
                entity = "mantle.account.payment.PaymentTransferTestControl",
                before = h.counts(f)
            h.call("create#" + entity, {operationKey: key, organizationPartyId: f.org, failAfterOutgoing: "Y"})
            let failure
            try {
                failure = h.lifecycle.rejected("create#InternalTransfer", {
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: key
                })
            } finally {
                h.call("delete#" + entity, {operationKey: key})
            }
            const after = h.counts(f),
                retained = h.native("get#InternalTransferPreview", {previewId: review.previewId}),
                operations = h.lib.find(h.lib.operationEntity, {operationKey: key}).count(),
                success = h.confirm(review, key)
            return {failure, before, after, retained, operations, success}
        },
        then({failure, before, after, retained, operations, success}) {
            failure.includes("TEST_TRANSFER_AFTER_FIRST_POST: posted=1")
            JSON.stringify(after) == JSON.stringify(before)
            retained.status == "review"
            retained.operationKey == null
            operations == 0
            success.reasonCode == "INTERNAL_TRANSFER_COMPLETED"
            success.acctgTransIds.length == 2
            success.outputRows.length == 2
        }
    }
)
