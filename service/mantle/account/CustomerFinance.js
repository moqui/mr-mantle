// A customer's payment methods for treasury, masked: a bank account shows its bank and last four digits only. A method
// whose bank account cannot be read is logged and left out.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, denied} = lib
function paymentMethods(p) {
    const methods = Array.from(
        find("mantle.account.method.PaymentMethod", {ownerPartyId: p.customerPartyId})
            .conditionDate("fromDate", "thruDate", null)
            .orderBy("paymentMethodId")
            .limit(100)
            .list()
    )
    const rows = []
    for (const method of methods) {
        try {
            const bank = one("mantle.account.method.BankAccount", {paymentMethodId: method.paymentMethodId})
            const digits = bank?.accountNumber ? String(bank.accountNumber).slice(-4) : ""
            rows.push({
                paymentMethodId: method.paymentMethodId,
                paymentMethodTypeEnumId: method.paymentMethodTypeEnumId,
                description: bank ? (bank.bankName || "Bank account") + (digits ? " •••• " + digits : "") : method.description,
                bankName: bank?.bankName || "",
                maskedAccountNumber: digits ? "•••• " + digits : "",
                fromDate: method.fromDate,
                thruDate: method.thruDate,
                lastUpdatedStamp: method.lastUpdatedStamp
            })
        } catch (error) {
            ec.logger.error("Customer " + p.customerPartyId + " payment method " + method.paymentMethodId + ": " + error.message)
        }
    }
    return {paymentMethods: rows}
}
const operations = {paymentMethods}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown customer finance operation " + op)
        return operations[op](parameters)
    }
})
