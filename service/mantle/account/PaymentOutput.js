// Issued payment documents are payment content (PctReceipt, PctPaymentDocument, PctCheckImage) written by
// mantle.account.PaymentServices.issue#PaymentDocuments. These helpers serve the refund, transfer and gateway modules.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {lib, treasury} = workflow
const outputTypes = {PctReceipt: "receipt", PctPaymentDocument: "detail", PctCheckImage: "check"}
// The issued documents of a payment the scope may read, and which of them can be printed.
function available(scope) {
    const rows = Array.from(
        lib
            .find("mantle.account.payment.PaymentContent", {paymentId: scope.record.paymentId})
            .condition("contentTypeEnumId", "in", Object.keys(outputTypes))
            .orderBy("-contentDate,paymentContentId")
            .limit(20)
            .list()
    )
    const canCheck = treasury(scope),
        outputRows = rows
            .filter(row => row.contentTypeEnumId !== "PctCheckImage" || canCheck)
            .map(row => ({
                outputId: row.paymentContentId,
                paymentContentId: row.paymentContentId,
                paymentId: row.paymentId,
                outputType: outputTypes[row.contentTypeEnumId],
                fileName: row.description,
                createdDate: row.contentDate,
                createdDateText: lib.policy.dateText(row.contentDate),
                canOpen: true
            }))
    return {
        canPrintReceipt: outputRows.some(row => row.outputType === "receipt"),
        canPrintDetail: outputRows.some(row => row.outputType === "detail"),
        canPrintCheck: outputRows.some(row => row.outputType === "check"),
        outputRows
    }
}
// Issues the documents of a delivered payment in the scope's organization.
function issue(scope, request = {}, operationKey = null) {
    return lib.call("mantle.account.PaymentServices.issue#PaymentDocuments", {
        paymentId: scope.record.paymentId,
        organizationPartyId: scope.organizationPartyId
    }).outputRows
}
;({available, issue})
