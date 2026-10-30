// Reviewed refunds permanently bind their exact consumed funding, independently of current adoption flags.
const refunds = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentRefunds.js")
const {lib} = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {find, one, map, denied} = lib
function controller() {
    return ec.artifactExecution
        .getStackNameString()
        .split(", ")
        .find(name => name.startsWith("mantle.account.PaymentServices."))
        ?.slice("mantle.account.PaymentServices.".length)
}
function guard(p, kind) {
    ec.resource.script("component://mr-mantle/service/mantle/account/PaymentGatewayIsolation.js").assertNoProviderWrite()
    const entity = {preview: refunds.PREVIEW, record: refunds.RECORD, claim: refunds.CLAIM}[kind],
        key = kind === "preview" ? "previewId" : "refundPaymentId",
        values = map(p.entityValue || p),
        before =
            values[key] &&
            find(entity, {[key]: values[key]})
                .useCache(false)
                .one(),
        after = Object.assign({}, map(before), values),
        service = controller()
    if (p.eecaOperation === "delete")
        denied("REFUND_RECORD_IMMUTABLE", "Refund reviews, claims and completed funding cannot be deleted")
    if (kind === "preview") {
        if (!before) {
            if (service !== "preview#PaymentRefund") denied("REFUND_REVIEW_REQUIRED", "Create an owner-bound refund review")
            const scope = refunds.scopeFor({organizationPartyId: after.organizationPartyId, paymentId: after.paymentId}, true)
            if (
                after.userId !== ec.user.userId ||
                after.status !== "review" ||
                !after.inputFingerprint ||
                !after.refundPaymentId ||
                !after.accountingDate ||
                after.currencyUomId !== scope.record.amountUomId ||
                toDecimal(after.amount || 0).compare(0) <= 0
            )
                denied("REFUND_PREVIEW_INVALID", "A refund review requires its real owner, source and explicit money")
        } else {
            if (service !== "refund#ReviewedPayment") denied("REFUND_REVIEW_REQUIRED", "Use the reviewed refund confirmation")
            const mutable = new Set(["status", "operationKey", "resultJson", "lastUpdatedStamp"])
            for (const field of Object.keys(after))
                if (!mutable.has(field) && String(after[field] ?? "") !== String(before[field] ?? ""))
                    denied("REFUND_RECORD_IMMUTABLE", "The reviewed refund identity is immutable")
            if (before.status !== "review" || after.status !== "complete" || !after.operationKey || !after.resultJson)
                denied("REFUND_STATE_INVALID", "A review completes once with its recorded operation")
        }
        return
    }
    if (kind === "record") {
        if (before) denied("REFUND_RECORD_IMMUTABLE", "Completed refund money and funding are permanent")
        if (!["refund#ReviewedPayment", "complete#PaymentGatewayAttempt"].includes(service))
            denied("REFUND_REVIEW_REQUIRED", "Completed refund funding requires its exact native financial controller")
        const original = one("mantle.account.payment.Payment", {paymentId: after.originalPaymentId}),
            child = one("mantle.account.payment.Payment", {paymentId: after.refundPaymentId}),
            application = one("mantle.account.payment.PaymentApplication", {paymentApplicationId: after.paymentApplicationId})
        if (
            !original ||
            !child ||
            !application ||
            child.refundForPaymentId !== original.paymentId ||
            child.paymentTypeEnumId !== "PtRefund" ||
            child.lifecycleManaged !== "Y" ||
            original.lifecycleManaged !== "Y" ||
            child.fromPartyId !== original.toPartyId ||
            child.toPartyId !== original.fromPartyId ||
            child.financeOrganizationPartyId !== after.organizationPartyId ||
            child.financeDirection !== after.financeDirection ||
            child.amountUomId !== after.currencyUomId ||
            !toDecimal(child.amount).eq(after.amount) ||
            application.paymentId !== child.paymentId ||
            application.toPaymentId !== original.paymentId ||
            application.invoiceId ||
            application.toInvoiceId ||
            !toDecimal(application.amountApplied).eq(after.amount) ||
            application.currencyUomId !== after.currencyUomId ||
            lib.policy.calendarDateText(application.accountingDate) !== lib.policy.calendarDateText(after.accountingDate)
        )
            denied("REFUND_RECORD_INVALID", "Completed refund identity must match its actual child and exact original funding")
        for (const [field, paymentId] of [
            ["originalAcctgTransId", original.paymentId],
            ["cashAcctgTransId", child.paymentId],
            ["applicationAcctgTransId", child.paymentId]
        ]) {
            const tx = one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: after[field]})
            if (
                !tx ||
                tx.paymentId !== paymentId ||
                tx.organizationPartyId !== after.organizationPartyId ||
                tx.isPosted !== "Y" ||
                tx.glFiscalTypeEnumId !== "GLFT_ACTUAL" ||
                tx.amountUomId !== after.currencyUomId ||
                (field === "applicationAcctgTransId" &&
                    (tx.paymentApplicationId !== application.paymentApplicationId || tx.toPaymentId !== original.paymentId))
            )
                denied("REFUND_RECORD_INVALID", "Completed refund postings must retain their actual source identities")
        }
        return
    }
    if (!["reserve#PaymentGatewayAction", "record#PaymentGatewayResult", "complete#PaymentGatewayAttempt"].includes(service))
        denied("REFUND_REVIEW_REQUIRED", "A draft claim requires its native provider controller")
    const attempt = one("mantle.account.payment.PaymentGatewayAttempt", {attemptId: after.attemptId}),
        draft = one("mantle.account.payment.Payment", {paymentId: after.refundPaymentId})
    if (
        !attempt ||
        attempt.action !== "refund" ||
        attempt.refundDraftPaymentId !== after.refundPaymentId ||
        attempt.paymentId !== after.originalPaymentId ||
        attempt.organizationPartyId !== after.organizationPartyId ||
        !draft ||
        draft.lifecycleManaged !== "Y"
    )
        denied("REFUND_CLAIM_INVALID", "A draft claim needs its exact reviewed refund attempt and managed draft")
    if (!before) {
        if (
            service !== "reserve#PaymentGatewayAction" ||
            after.status !== "held" ||
            attempt.providerState !== "reserved" ||
            attempt.financialState !== "none"
        )
            denied("REFUND_CLAIM_INVALID", "Only an exact reserved provider attempt can create a held draft claim")
        return
    }
    if (before.status === "consumed") denied("REFUND_RECORD_IMMUTABLE", "Consumed draft claims never recycle")
    if (before.status === "held") {
        for (const field of Object.keys(after).filter(
            field => !["status", "releasedDate", "consumedDate", "lastUpdatedStamp"].includes(field)
        ))
            if (String(before[field] ?? "") !== String(after[field] ?? ""))
                denied("REFUND_CLAIM_INVALID", "A held draft claim cannot be rebound to another attempt or source")
        if (
            !(
                (service === "record#PaymentGatewayResult" &&
                    after.status === "released" &&
                    attempt.providerState === "declined" &&
                    attempt.financialState === "none") ||
                (service === "complete#PaymentGatewayAttempt" &&
                    after.status === "consumed" &&
                    attempt.providerState === "accepted" &&
                    attempt.financialState === "accepted_unposted")
            )
        )
            denied("REFUND_CLAIM_INVALID", "A held claim requires definitive decline or accepted financial completion")
        return
    }
    const prior =
        before.status === "released" && one("mantle.account.payment.PaymentGatewayAttempt", {attemptId: before.attemptId})
    if (
        !prior ||
        prior.providerState !== "declined" ||
        prior.financialState !== "none" ||
        service !== "reserve#PaymentGatewayAction" ||
        after.status !== "held" ||
        attempt.providerState !== "reserved" ||
        attempt.financialState !== "none" ||
        after.attemptId === before.attemptId
    )
        denied("REFUND_CLAIM_INVALID", "Only a fresh reserved review after definitive decline may reclaim a released clean draft")
}
;({guard})
