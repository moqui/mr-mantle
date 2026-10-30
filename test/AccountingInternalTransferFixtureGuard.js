// No effects outside an exact test control and the native transfer's real first posted leg.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
function firstPosted(p) {
    const controller = ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => name.startsWith("mantle.account.PaymentServices."))
    if (controller !== "mantle.account.PaymentServices.create#InternalTransfer") return
    const tx = lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: p.acctgTransId}),
        payment = tx?.paymentId && lib.one("mantle.account.payment.Payment", {paymentId: tx.paymentId})
    if (!payment?.internalTransferId || payment.internalTransferLeg !== "outgoing") return
    const pair = lib.one("mantle.account.payment.PaymentInternalTransfer", {internalTransferId: payment.internalTransferId}),
        control = pair && lib.one("mantle.account.payment.PaymentTransferTestControl", {operationKey: pair.operationKey})
    if (!control || control.organizationPartyId !== pair.organizationPartyId || control.failAfterOutgoing !== "Y") return
    const posted = Array.from(
        lib
            .find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: pair.organizationPartyId, isPosted: "Y"})
            .condition("paymentId", "in", [pair.fromPaymentId, pair.toPaymentId])
            .useCache(false)
            .list()
    )
    if (
        pair.status !== "constructing" ||
        pair.fromAcctgTransId !== tx.acctgTransId ||
        tx.isPosted !== "Y" ||
        posted.length !== 1 ||
        posted[0].acctgTransId !== tx.acctgTransId
    )
        throw new Error("TEST_TRANSFER_FIRST_POST_MISSING: Fixture did not observe the real first posting")
    throw new Error("TEST_TRANSFER_AFTER_FIRST_POST: posted=1 " + tx.acctgTransId)
}
;({firstPosted})
