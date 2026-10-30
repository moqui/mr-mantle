// Read-only capacity evidence shared by native application/source guards. Callers retain org then payment locks.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const R = "mantle.account.payment.PaymentGatewayReservation"
function cashHoldSummaries(p) {
    const ids = [...new Set(Array.from(p.paymentIdList || []).map(String))]
    if (ids.length > 400) lib.denied("GATEWAY_SELECTION_LIMIT", "Read cash holds in bounded payment batches")
    if (!ids.length) return {}
    const payments = Array.from(
            lib.find("mantle.account.payment.Payment").condition("paymentId", "in", ids).useCache(false).list()
        ),
        records = Array.from(
            lib
                .find(R, {holdKind: "cash", status: "held"})
                .condition("paymentId", "in", ids)
                .useCache(false)
                .orderBy("reservationId")
                .list()
        ),
        out = {}
    if (payments.length !== ids.length) lib.denied("GATEWAY_HOLD_UNAVAILABLE", "A cash hold payment is unavailable")
    for (const payment of payments) {
        if (
            !p.organizationPartyId ||
            ![payment.fromPartyId, payment.toPartyId].includes(p.organizationPartyId) ||
            (payment.financeOrganizationPartyId && payment.financeOrganizationPartyId !== p.organizationPartyId)
        )
            lib.denied("GATEWAY_HOLD_UNAVAILABLE", "The cash hold payment or organization is unavailable")
        const evidence = records.filter(row => row.paymentId === payment.paymentId)
        let heldAmount = toDecimal(0)
        for (const row of evidence) {
            if (
                row.organizationPartyId !== p.organizationPartyId ||
                row.currencyUomId !== payment.amountUomId ||
                toDecimal(row.amount || 0).compare(0) <= 0
            )
                lib.denied("GATEWAY_HOLD_UNAVAILABLE", "Cash hold identity or currency is inconsistent")
            heldAmount = heldAmount.add(row.amount)
        }
        out[payment.paymentId] = {
            heldAmount,
            currencyUomId: payment.amountUomId,
            holdCount: evidence.length,
            version: lib.hash(
                evidence.map(row =>
                    lib.policy.pick(lib.map(row), [
                        "reservationId",
                        "organizationPartyId",
                        "paymentId",
                        "attemptId",
                        "amount",
                        "currencyUomId",
                        "status",
                        "createdDate"
                    ])
                )
            )
        }
    }
    return out
}
function cashHoldSummary(p) {
    return cashHoldSummaries({organizationPartyId: p.organizationPartyId, paymentIdList: [p.paymentId]})[p.paymentId]
}
;({cashHoldSummary, cashHoldSummaries})
