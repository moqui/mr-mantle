// Immutable issued records and archives are protected at the entity boundary, including artifact-off writers.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const output = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentOutput.js")
const {lib} = workflow
const CONTENT = "mantle.account.payment.PaymentContent",
    OUTPUT = "mantle.account.payment.PaymentIssuedOutput"
function reviewed() {
    return /mantle\.account\.PaymentServices\.(create#PaymentDraft|store#PaymentDraft|change#PaymentState|unapply#ReviewedPayment|refund#ReviewedPayment|complete#PaymentGatewayAttempt|create#InternalTransfer)(?:\b|$)/.test(
        ec.artifactExecution.getStackNameString()
    )
}
function assertMutableContent(p) {
    const row = lib.find(CONTENT, {paymentContentId: p.paymentContentId}).forUpdate(true).one()
    if (!row) lib.denied("PAYMENT_CONTENT_UNAVAILABLE", "The payment file is unavailable")
    if (p.paymentId && p.paymentId !== row.paymentId)
        lib.denied("PAYMENT_CONTENT_MISMATCH", "The file belongs to a different payment")
    if (output.issuedReference(row) || output.reservedLocation(row.contentLocation))
        lib.denied("ISSUED_PAYMENT_IMMUTABLE", "An issued payment file cannot be replaced or removed")
    const payment = lib.one(workflow.P, {paymentId: row.paymentId})
    if (payment?.lifecycleManaged === "Y")
        workflow.paymentScope({organizationPartyId: p.organizationPartyId, paymentId: row.paymentId}, true)
    return row
}
function guardContent(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const updates = lib.map(p.entityValue || p),
        original = p.originalValue
            ? lib.map(p.originalValue)
            : updates.paymentContentId
              ? lib.one(CONTENT, {paymentContentId: updates.paymentContentId})
              : null,
        candidate = Object.assign({}, lib.map(original), updates),
        originalOutput = output.issuedReference(original),
        candidateOutput = output.issuedReference(candidate),
        immutable =
            originalOutput ||
            candidateOutput ||
            output.reservedLocation(original?.contentLocation) ||
            output.reservedLocation(candidate.contentLocation)
    if (!immutable) {
        const parents = [...new Set([original?.paymentId, candidate.paymentId].filter(Boolean))].map(paymentId =>
            lib.one(workflow.P, {paymentId})
        )
        if (parents.some(payment => payment?.lifecycleManaged === "Y"))
            for (const payment of parents) {
                if (!payment) lib.denied("PAYMENT_CONTENT_UNAVAILABLE", "The payment file owner is unavailable")
                workflow.paymentScope({paymentId: payment.paymentId}, true)
            }
        return
    }
    if (p.eecaOperation === "create") {
        const issuer =
            reviewed() &&
            candidateOutput &&
            candidate.paymentContentId === candidateOutput.paymentContentId &&
            candidate.paymentId === candidateOutput.paymentId &&
            candidate.paymentOutputId === candidateOutput.paymentOutputId &&
            candidate.isImmutable === "Y" &&
            output.canonicalLocation(candidate.contentLocation) === output.canonicalLocation(candidateOutput.contentLocation)
        if (!issuer) lib.denied("ISSUED_PAYMENT_IMMUTABLE", "A private issued archive cannot be linked as a mutable payment file")
        workflow.paymentScope({organizationPartyId: candidateOutput.organizationPartyId, paymentId: candidate.paymentId}, true)
        return
    }
    if (p.eecaOperation === "delete") lib.denied("ISSUED_PAYMENT_IMMUTABLE", "An issued payment file cannot be removed")
    workflow.paymentScope(
        {
            organizationPartyId: originalOutput?.organizationPartyId || candidateOutput?.organizationPartyId,
            paymentId: candidate.paymentId
        },
        true
    )
    for (const field of [
        "paymentContentId",
        "paymentId",
        "paymentOutputId",
        "contentLocation",
        "isImmutable",
        "contentDate",
        "userId"
    ]) {
        const same =
            field === "contentDate"
                ? lib.ms(original?.[field]) === lib.ms(candidate[field])
                : String(original?.[field] ?? "") === String(candidate[field] ?? "")
        if (!same) lib.denied("ISSUED_PAYMENT_IMMUTABLE", "The identity of an issued payment file cannot change")
    }
}
function guardOutput(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    if (p.eecaOperation !== "create" || !reviewed())
        lib.denied("ISSUED_PAYMENT_IMMUTABLE", "Issued payment output is an immutable lifecycle record")
    const row = lib.map(p.entityValue || p),
        scope = workflow.paymentScope({organizationPartyId: row.organizationPartyId, paymentId: row.paymentId}, true)
    if (scope.record.statusId !== "PmntDelivered" || !["receipt", "detail", "check"].includes(row.outputType))
        lib.denied("PAYMENT_OUTPUT_STATE_INVALID", "Only delivery issues a payment document")
    if (row.outputType === "check" && !output.treasury(scope))
        lib.denied("PERMISSION_DENIED", "Treasury authority is required to issue a check")
    const prefix =
        "dbresource://mantle/content/payment-issued/" + row.paymentId + "/" + row.paymentOutputId + "/" + row.outputType + "/"
    if (!output.canonicalLocation(row.contentLocation).startsWith(prefix))
        lib.denied("PAYMENT_OUTPUT_LOCATION_INVALID", "Issued output must use its private immutable archive")
}
function guardEvent(p) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const callback =
        /mantle\.account\.PaymentServices\.(approve#PaymentValidationNotice|refuse#PaymentValidationNotice)(?:\b|$)/.test(
            ec.artifactExecution.getStackNameString()
        )
    if (p.eecaOperation === "delete" || (!reviewed() && !callback))
        lib.denied("PAYMENT_HISTORY_IMMUTABLE", "Payment lifecycle evidence is an immutable native record")
    const row = lib.map(p.entityValue || p),
        original = p.originalValue ? lib.map(p.originalValue) : null
    if (p.eecaOperation === "update")
        for (const field of Object.keys(row)) {
            if (["evidenceJson", "lastUpdatedStamp"].includes(field)) continue
            if (String(row[field] ?? "") !== String(original?.[field] ?? ""))
                lib.denied("PAYMENT_HISTORY_IMMUTABLE", "Payment lifecycle history cannot be rewritten")
        }
}
;({assertMutableContent, guardContent, guardOutput, guardEvent})
