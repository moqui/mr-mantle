// Real provider reservations exercise the shared financial boundaries; no synthetic holds or claims.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
const P = "mantle.account.payment.Payment",
    A = "mantle.account.payment.PaymentApplication"
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry"
const CLAIM = "mantle.account.payment.PaymentRefundDraftClaim",
    HOLD = "mantle.account.payment.PaymentGatewayReservation"
const draftErrorKeys = ["draftEdit", "draftState", "draftDelete", "draftHeader", "draftCandidate", "draftPost", "draftApply"]
const cashErrorKeys = ["cashCandidate", "cashEntry", "cashReverse"]
let f
function capture() {
    const h = helper(),
        paymentId = h.draft(f)
    h.execute(h.preview(f, paymentId))
    return h.execute(h.preview(f, paymentId, "capture", {amount: "20"}))
}
function refund(cash, draft = null) {
    const h = helper(),
        extra = {amount: "7"}
    if (draft) Object.assign(extra, {refundPaymentId: draft, refundSourceVersion: h.lifecycle.detail(f, draft).sourceVersion})
    h.mode(f, "refund", "pending")
    try {
        const review = h.preview(f, cash.cashPaymentId, "refund", extra)
        return Object.assign(h.execute(review), {testPreviewId: review.previewId})
    } finally {
        h.mode(f, "refund", "accepted")
    }
}
function draft() {
    return helper().lifecycle.draft(f, {cashDirection: "outgoing", amount: "7"})
}
function summary(paymentId) {
    return helper().native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}).refundSummary
}
function rawApplication(paymentId, target, amount) {
    return Object.assign(
        {
            paymentApplicationId: ec.user.randomString(32),
            paymentId,
            amountApplied: amount,
            currencyUomId: "USD",
            appliedDate: f.timestamp,
            accountingDate: f.day
        },
        target
    )
}
function header(extra = {}) {
    return Object.assign(
        {
            acctgTransId: "RFG_" + ec.user.randomString(24),
            organizationPartyId: f.org,
            acctgTransTypeEnumId: "AttIncomingPayment",
            transactionDate: f.timestamp,
            accountingDate: f.day,
            amountUomId: "USD",
            glFiscalTypeEnumId: "GLFT_ACTUAL",
            isPosted: "N"
        },
        extra
    )
}
function refresh(attemptId) {
    const h = helper(),
        current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId})
    return h.native("refresh#PaymentGatewayAttempt", {
        organizationPartyId: f.org,
        attemptId,
        attemptVersion: current.attemptVersion,
        operationKey: "rfg-lookup-" + ec.user.randomString(20)
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures("ACCT_P5_RF_GUARD")
        const config = h.lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: f.gatewayId}),
            guarantees = JSON.parse(config.reviewedGuaranteesJson)
        guarantees.refund = {
            enabled: true,
            originalCaptureOnly: true,
            partialRefund: true,
            idempotent: true,
            exactLookup: true,
            reviewedMethodSnapshot: true
        }
        h.call("update#mantle.account.method.PaymentGatewayConfig", {
            paymentGatewayConfigId: f.gatewayId,
            reviewedGuaranteesJson: JSON.stringify(guarantees)
        })
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
feature("a real pending provider refund reduces raw and native application capacity without inventing a payment", {
    when() {
        const h = helper(),
            cash = capture(),
            pending = refund(cash),
            before = summary(cash.cashPaymentId),
            invoiceId = h.lifecycle.settlement.invoice(f, "20"),
            raw = h.lifecycle.rejected("create#" + A, rawApplication(cash.cashPaymentId, {invoiceId}, "14"))
        let native = ""
        try {
            h.lifecycle.settlement.review(f, [
                {
                    sourceKey: h.lifecycle.settlement.key("payment", cash.cashPaymentId),
                    targetKey: h.lifecycle.settlement.key("invoice", invoiceId),
                    amount: "14"
                }
            ])
        } catch (error) {
            ec.message.clearErrors()
            native = error.message
        }
        const applied = h.lib.probe("create#" + A, rawApplication(cash.cashPaymentId, {invoiceId}, "13"))
        return {
            pending,
            before,
            raw,
            native,
            applied,
            after: summary(cash.cashPaymentId),
            holds: h.lib.rows(HOLD, {attemptId: pending.attemptId}),
            refunds: h.lib.find(P, {refundForPaymentId: cash.cashPaymentId}).count()
        }
    },
    then({pending, before, raw, native, applied, after, holds, refunds}) {
        pending.providerState == "pending"
        pending.cashPaymentId == null
        toDecimal(before.reservedAmount).eq(7)
        toDecimal(before.availableAmount).eq(13)
        raw.includes("APPLICATION_BALANCE_CHANGED")
        native.includes("SETTLEMENT_EXCEEDS_BALANCE")
        applied.paymentApplicationId != null
        toDecimal(after.unappliedTotal).eq(7)
        toDecimal(after.availableAmount).isZero()
        holds
            .filter(row => row.status === "held")
            .map(row => row.holdKind)
            .sort() == ["cash", "refund"]
        refunds == 0
    }
})
feature("a real held refund draft and captured cash resist raw candidate source and posting writes with flags off", {
    when() {
        const h = helper(),
            cash = capture(),
            refundDraft = draft(),
            pending = refund(cash, refundDraft),
            claim = h.lib.one(CLAIM, {refundPaymentId: refundDraft}),
            cashTx = h.lib.one(T, {paymentId: cash.cashPaymentId}),
            entry = h.lib.rows(E, {acctgTransId: cashTx.acctgTransId})[0],
            pref = h.lib.policy.preference(f.org),
            saved = h.lib.policy.pick(h.lib.map(pref), [
                "postingGuardEnabled",
                "settlementApplicationGuardEnabled",
                "paymentGatewayWorkflowEnabled"
            ]),
            errors = {},
            blank = header()
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            postingGuardEnabled: "N",
            settlementApplicationGuardEnabled: "N",
            paymentGatewayWorkflowEnabled: "N"
        })
        try {
            h.lib.probe("create#" + T, blank)
            for (const [name, service, values] of [
                ["draftEdit", "update#" + P, {paymentId: refundDraft, amount: "8"}],
                ["draftState", "update#" + P, {paymentId: refundDraft, statusId: "PmntCancelled"}],
                ["draftDelete", "delete#" + P, {paymentId: refundDraft}],
                ["draftHeader", "create#" + T, header({paymentId: refundDraft, acctgTransTypeEnumId: "AttOutgoingPayment"})],
                ["draftCandidate", "update#" + T, {acctgTransId: blank.acctgTransId, toPaymentId: refundDraft}],
                ["draftPost", "mantle.ledger.PaymentAutoPostServices.post#Payment", {paymentId: refundDraft}],
                ["draftApply", "create#" + A, rawApplication(refundDraft, {toPaymentId: cash.cashPaymentId}, "1")],
                ["cashCandidate", "update#" + T, {acctgTransId: blank.acctgTransId, paymentId: cash.cashPaymentId}],
                [
                    "cashEntry",
                    "update#" + E,
                    {acctgTransId: entry.acctgTransId, acctgTransEntrySeqId: entry.acctgTransEntrySeqId, amount: "1"}
                ],
                [
                    "cashReverse",
                    "mantle.ledger.LedgerServices.post#ReverseAcctgTrans",
                    {acctgTransId: cashTx.acctgTransId, changeReason: "Attempt to reuse reserved original cash"}
                ]
            ])
                errors[name] = h.lifecycle.rejected(service, values)
            h.lib.probe("update#" + T, {acctgTransId: blank.acctgTransId, description: "Allowed ordinary journal annotation"})
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: f.org}, saved))
        }
        return {
            claim,
            errors,
            pending,
            draft: h.lib.one(P, {paymentId: refundDraft}),
            blank: h.lib.one(T, {acctgTransId: blank.acctgTransId}),
            draftTxCount: h.lib.find(T, {paymentId: refundDraft}).count(),
            cashEntry: h.lib.one(E, {acctgTransId: entry.acctgTransId, acctgTransEntrySeqId: entry.acctgTransEntrySeqId}),
            originalEntry: entry,
            claims: h.lib.rows(CLAIM, {refundPaymentId: refundDraft}),
            holds: h.lib.rows(HOLD, {attemptId: pending.attemptId})
        }
    },
    then({claim, errors, pending, draft, blank, draftTxCount, cashEntry, originalEntry, claims, holds}) {
        claim.status == "held"
        claim.attemptId == pending.attemptId
        pending.draftClaim.status == "held"
        pending.draftClaim.refundPaymentId == draft.paymentId
        draftErrorKeys.every(key => errors[key].includes("REFUND_DRAFT_CLAIMED"))
        cashErrorKeys.every(key => errors[key].includes("GATEWAY_CASH_POSTING_IMMUTABLE"))
        draft.gatewayRole == null
        draft.lifecycleManaged == "Y"
        toDecimal(draft.amount).eq(7)
        blank.paymentId == null
        blank.toPaymentId == null
        blank.description == "Allowed ordinary journal annotation"
        draftTxCount == 0
        toDecimal(cashEntry.amount).eq(originalEntry.amount)
        claims.length == 1
        claims[0].status == "held"
        holds.every(row => row.status === "held")
    }
})
feature("authoritative decline releases both holds and the draft for a fresh reviewed operation whose completion consumes them", {
    when() {
        const h = helper(),
            cash = capture(),
            refundDraft = draft(),
            pending = refund(cash, refundDraft)
        let declined
        try {
            h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                paymentGatewayConfigId: f.gatewayId,
                lookupOutcomesJson: JSON.stringify({refund: "declined"})
            })
            declined = refresh(pending.attemptId)
        } finally {
            h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                paymentGatewayConfigId: f.gatewayId,
                lookupOutcomesJson: "{}"
            })
        }
        const released = h.lib.map(h.lib.one(CLAIM, {refundPaymentId: refundDraft})),
            releasedHolds = h.lib.rows(HOLD, {attemptId: pending.attemptId}).map(h.lib.map),
            current = h.lifecycle.detail(f, refundDraft)
        h.native(
            "store#PaymentDraft",
            h.lifecycle.request(f, {
                paymentId: refundDraft,
                sourceVersion: current.sourceVersion,
                cashDirection: "outgoing",
                amount: "8"
            })
        )
        const confirmed = h.execute(
                h.preview(f, cash.cashPaymentId, "refund", {
                    amount: "8",
                    refundPaymentId: refundDraft,
                    refundSourceVersion: h.lifecycle.detail(f, refundDraft).sourceVersion
                })
            ),
            consumed = h.lib.one(CLAIM, {refundPaymentId: refundDraft}),
            record = h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: refundDraft})
        return {
            pending,
            declined,
            released,
            releasedHolds,
            confirmed,
            consumed,
            record,
            oldAttempt: h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: pending.attemptId}),
            oldReview: h.native("get#PaymentGatewayActionPreview", {
                organizationPartyId: f.org,
                previewId: pending.testPreviewId
            }),
            holds: h.lib.rows(HOLD, {attemptId: confirmed.attemptId}),
            after: summary(cash.cashPaymentId)
        }
    },
    then({pending, declined, released, releasedHolds, confirmed, consumed, record, oldAttempt, oldReview, holds, after}) {
        pending.draftClaim.status == "held"
        declined.providerState == "declined"
        declined.cashPaymentId == null
        declined.draftClaim.status == "released"
        released.status == "released"
        releasedHolds.length == 2
        releasedHolds.every(row => row.status === "released")
        confirmed.financialState == "completed"
        confirmed.cashPaymentId == released.refundPaymentId
        confirmed.refundPaymentId == confirmed.cashPaymentId
        confirmed.draftClaim.status == "consumed"
        consumed.status == "consumed"
        consumed.attemptId == confirmed.attemptId
        consumed.attemptId != declined.attemptId
        oldAttempt.attemptId == pending.attemptId
        oldAttempt.draftClaim.status == "released"
        oldReview.results.attemptId == pending.attemptId
        oldReview.draftClaim.status == "released"
        record.gatewayAttemptId == confirmed.attemptId
        holds.length == 2
        holds.every(row => row.status === "consumed")
        toDecimal(after.completedRefundAmount).eq(8)
        toDecimal(after.reservedAmount).isZero()
        toDecimal(after.refundableAmount).eq(12)
    }
})
