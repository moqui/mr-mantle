// Completed transfer pairs retain both exact financial legs independently of later adoption settings.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingInternalTransferFixtures.js")
const P = "mantle.account.payment.Payment",
    T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry"
const A = "mantle.account.payment.PaymentApplication",
    PAIR = "mantle.account.payment.PaymentInternalTransfer"
const paymentCases = ["amount", "detach", "leg", "type", "void", "delete"]
const postingCases = ["duplicate", "detach", "relabel", "entry", "entryDelete", "unpost", "reverse", "candidate"]
let f
function header(extra = {}) {
    return Object.assign(
        {
            acctgTransId: "TRG_" + ec.user.randomString(24),
            organizationPartyId: f.org,
            acctgTransTypeEnumId: "AttOutgoingPayment",
            transactionDate: f.timestamp,
            accountingDate: f.day,
            amountUomId: "USD",
            glFiscalTypeEnumId: "GLFT_ACTUAL",
            isPosted: "N"
        },
        extra
    )
}
function controls(enabled) {
    helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: f.org,
        postingGuardEnabled: enabled,
        settlementApplicationGuardEnabled: enabled
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_TR_GUARD")
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
    "completed transfer money and both posting identities resist raw mutations with flags off while reconciliation metadata stays editable",
    {
        when() {
            const h = helper(),
                result = h.confirm(h.preview(f, {amount: "25", feeAmount: "2", feeGlAccountId: "710000000"})),
                pair = h.lib.one(PAIR, {internalTransferId: result.internalTransferId}),
                beforePair = JSON.stringify(h.lib.map(pair)),
                tx = h.lib.one(T, {acctgTransId: pair.fromAcctgTransId}),
                entry = h.lib.rows(E, {acctgTransId: tx.acctgTransId}).find(row => row.debitCreditFlag === "C"),
                ordinary = header({acctgTransTypeEnumId: "AttInternal"}),
                errors = {}
            controls("N")
            try {
                h.lib.probe("create#" + T, ordinary)
                for (const [name, service, values] of [
                    ["amount", "update#" + P, {paymentId: result.fromPaymentId, amount: "25"}],
                    ["detach", "update#" + P, {paymentId: result.fromPaymentId, internalTransferId: null}],
                    ["leg", "update#" + P, {paymentId: result.toPaymentId, internalTransferLeg: "outgoing"}],
                    ["type", "update#" + P, {paymentId: result.fromPaymentId, paymentTypeEnumId: "PtInvoicePayment"}],
                    ["void", "update#" + P, {paymentId: result.fromPaymentId, statusId: "PmntVoid"}],
                    ["delete", "delete#" + P, {paymentId: result.toPaymentId}],
                    ["duplicate", "create#" + T, header({paymentId: result.fromPaymentId})],
                    ["detach", "update#" + T, {acctgTransId: tx.acctgTransId, paymentId: null}],
                    ["relabel", "update#" + T, {acctgTransId: tx.acctgTransId, acctgTransTypeEnumId: "AttInternal"}],
                    [
                        "entry",
                        "update#" + E,
                        {acctgTransId: entry.acctgTransId, acctgTransEntrySeqId: entry.acctgTransEntrySeqId, amount: "1"}
                    ],
                    [
                        "entryDelete",
                        "delete#" + E,
                        {acctgTransId: entry.acctgTransId, acctgTransEntrySeqId: entry.acctgTransEntrySeqId}
                    ],
                    ["unpost", "mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: tx.acctgTransId}],
                    [
                        "reverse",
                        "mantle.ledger.LedgerServices.post#ReverseAcctgTrans",
                        {acctgTransId: tx.acctgTransId, changeReason: "Attempt a partial transfer reversal"}
                    ],
                    ["candidate", "update#" + T, {acctgTransId: ordinary.acctgTransId, paymentId: result.toPaymentId}],
                    ["pair", "update#" + PAIR, {internalTransferId: pair.internalTransferId, feeAmount: "0"}]
                ])
                    errors[(service.endsWith(P) ? "payment:" : "posting:") + name] = h.lifecycle.rejected(service, values)
                h.lib.probe("update#" + P, {paymentId: result.fromPaymentId, reconcileStatusId: "PmtrRec"})
                h.lib.probe("update#" + T, {acctgTransId: tx.acctgTransId, description: "Outgoing bank reconciliation note"})
                h.lib.probe("update#" + E, {
                    acctgTransId: entry.acctgTransId,
                    acctgTransEntrySeqId: entry.acctgTransEntrySeqId,
                    reconcileStatusId: "AterRec",
                    description: "Matched source bank statement"
                })
                h.lib.probe("update#" + T, {
                    acctgTransId: ordinary.acctgTransId,
                    description: "Ordinary journal remains editable"
                })
            } finally {
                controls("Y")
            }
            return {
                result,
                errors,
                beforePair,
                afterPair: JSON.stringify(h.lib.map(h.lib.one(PAIR, {internalTransferId: pair.internalTransferId}))),
                outgoing: h.lib.one(P, {paymentId: result.fromPaymentId}),
                incoming: h.lib.one(P, {paymentId: result.toPaymentId}),
                afterTx: h.lib.one(T, {acctgTransId: tx.acctgTransId}),
                ordinary: h.lib.one(T, {acctgTransId: ordinary.acctgTransId}),
                entry: h.lib.one(E, {acctgTransId: entry.acctgTransId, acctgTransEntrySeqId: entry.acctgTransEntrySeqId}),
                cashRows: Array.from(
                    h.lib.find(T).condition("paymentId", "in", [result.fromPaymentId, result.toPaymentId]).list()
                )
            }
        },
        then({result, errors, beforePair, afterPair, outgoing, incoming, afterTx, ordinary, entry, cashRows}) {
            paymentCases.every(name => errors["payment:" + name].includes("TRANSFER_PAYMENT_IMMUTABLE"))
            postingCases.every(name => errors["posting:" + name].includes("TRANSFER_POSTING_IMMUTABLE"))
            errors["posting:pair"].includes("TRANSFER_REVIEW_REQUIRED")
            beforePair == afterPair
            outgoing.internalTransferId == result.internalTransferId
            incoming.internalTransferId == result.internalTransferId
            outgoing.internalTransferLeg == "outgoing"
            incoming.internalTransferLeg == "incoming"
            toDecimal(outgoing.amount).eq(27)
            toDecimal(incoming.amount).eq(25)
            outgoing.reconcileStatusId == "PmtrRec"
            afterTx.isPosted == "Y"
            afterTx.description == "Outgoing bank reconciliation note"
            toDecimal(entry.amount).eq(27)
            entry.reconcileStatusId == "AterRec"
            ordinary.paymentId == null
            ordinary.description == "Ordinary journal remains editable"
            cashRows.length == 2
            cashRows.every(row => row.isPosted === "Y" && !row.reverseOfAcctgTransId)
        }
    }
)
feature("transfer legs cannot enter trade applications, provider operations or refund workflows", {
    when() {
        const h = helper(),
            result = h.confirm(h.preview(f)),
            errors = []
        controls("N")
        try {
            for (const [paymentId, toPaymentId] of [
                [result.fromPaymentId, result.toPaymentId],
                [result.toPaymentId, result.fromPaymentId]
            ])
                errors.push(
                    h.lifecycle.rejected("create#" + A, {
                        paymentApplicationId: ec.user.randomString(32),
                        paymentId,
                        toPaymentId,
                        amountApplied: "1",
                        currencyUomId: "USD",
                        appliedDate: f.timestamp,
                        accountingDate: f.day
                    })
                )
        } finally {
            controls("Y")
        }
        const original = h.lifecycle.detail(f, result.fromPaymentId),
            gatewayEnabled = h.lib.policy.preference(f.org).paymentGatewayWorkflowEnabled
        let gateway
        try {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                paymentGatewayWorkflowEnabled: "Y"
            })
            gateway = h.lifecycle.rejected("preview#PaymentGatewayAction", {
                organizationPartyId: f.org,
                paymentId: result.fromPaymentId,
                sourceVersion: original.sourceVersion,
                action: "authorize",
                effectiveDate: f.timestamp,
                reason: "Invalid transfer gateway instruction"
            })
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                paymentGatewayWorkflowEnabled: gatewayEnabled || "N"
            })
        }
        const refund = h.lifecycle.rejected("preview#PaymentRefund", {
                organizationPartyId: f.org,
                paymentId: result.fromPaymentId,
                sourceVersion: original.sourceVersion,
                amount: "1",
                effectiveDate: f.timestamp,
                reason: "Invalid transfer refund",
                referenceNumber: "TRANSFER",
                paymentInstrumentEnumId: "PiOther",
                organizationPaymentMethodId: f.methodId,
                organizationMethodVersion: h.request(f).fromMethodVersion
            }),
            repost = h.lifecycle.rejected("mantle.ledger.PaymentAutoPostServices.repost#PaymentAndApplications", {
                paymentId: result.fromPaymentId
            })
        return {
            errors,
            gateway,
            refund,
            repost,
            original,
            applications: h.lib
                .find(A)
                .condition(
                    ec.entity.conditionFactory.makeCondition(
                        [
                            ec.entity.conditionFactory.makeCondition("paymentId", "in", [
                                result.fromPaymentId,
                                result.toPaymentId
                            ]),
                            ec.entity.conditionFactory.makeCondition("toPaymentId", "in", [
                                result.fromPaymentId,
                                result.toPaymentId
                            ])
                        ],
                        "or"
                    )
                )
                .count()
        }
    },
    then({errors, gateway, refund, repost, original, applications}) {
        errors.length == 2
        errors.every(message => message.includes("TRANSFER_APPLICATION_REFUSED"))
        gateway.includes("GATEWAY_PAYMENT_UNAVAILABLE")
        refund.includes("REFUND_SOURCE_UNAVAILABLE")
        repost.includes("TRANSFER_POSTING_IMMUTABLE")
        original.payment.financeDirection == "transfer"
        original.capabilities.canPreviewRefund == false
        original.capabilities.canGatewayAuthorize == false
        applications == 0
    }
})
