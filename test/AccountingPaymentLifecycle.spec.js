const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_LIFE")
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
        if (f?.org) helper().settlement.base.cleanupLocks(f.org)
    }
})
feature("treasury creates and edits a reviewed proposed payment with canonical day and exact replay", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const request = h.request(f),
            created = h.native("create#PaymentDraft", request),
            replay = h.native("create#PaymentDraft", request),
            edited = h.native(
                "store#PaymentDraft",
                h.request(f, {
                    paymentId: created.paymentId,
                    sourceVersion: created.sourceVersion,
                    amount: "75",
                    operationKey: "life-edit-reviewed"
                })
            ),
            view = h.detail(f, created.paymentId)
        return {created, replay, edited, view}
    },
    then({created, replay, edited, view}) {
        created.statusId == "PmntProposed"
        replay.paymentId == created.paymentId
        replay.alreadyApplied == true
        edited.statusId == "PmntProposed"
        toDecimal(view.payment.amount).eq(75)
        view.payment.accountingDateText == f.day
        view.payment.cashDirection == "incoming"
        view.payment.financeDirection == "receivable"
        view.maskedMethodRows[0].maskedNumber == "•••• 6789"
        view.maskedMethodRows.every(row => row.accountNumber == null && row.routingNumber == null && row.glAccountId == null)
    }
})
feature("payment edit authority alone cannot browse or create and side readers cannot create the same request", {
    when() {
        const h = helper(),
            request = h.request(f)
        login(f.users.paymentEditOnly)
        const listDenied = h.rejected("find#Payments", {organizationPartyId: f.org}),
            editDenied = h.rejected("create#PaymentDraft", request)
        login(f.users.ar)
        const arDenied = h.rejected("create#PaymentDraft", request)
        login(f.users.treasury)
        return {listDenied, editDenied, arDenied, positive: h.native("create#PaymentDraft", request)}
    },
    then({listDenied, editDenied, arDenied, positive}) {
        listDenied.includes("PERMISSION_DENIED")
        editDenied.includes("PERMISSION_DENIED")
        arDenied.includes("PERMISSION_DENIED")
        positive.paymentId != null
    }
})
feature("AR and PAYMENT_VIEW readers receive narrow money and masked methods without gateway or ledger evidence", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f)
        h.call("create#mantle.account.method.PaymentGatewayResponse", {
            paymentId,
            paymentOperationEnumId: "PgoCapture",
            resultSuccess: "Y",
            amount: "60",
            amountUomId: "USD",
            transactionDate: f.timestamp,
            referenceNum: "SAFE_REFERENCE",
            reasonMessage: "Provider raw text must not leave native projection"
        })
        login(f.users.ar)
        const ar = h.detail(f, paymentId)
        login(f.users.paymentView)
        const read = h.detail(f, paymentId)
        login(f.users.treasury)
        const treasury = h.detail(f, paymentId)
        return {ar, read, treasury}
    },
    then({ar, read, treasury}) {
        ar.ledgerRows == null
        ar.gatewayRows == null
        read.ledgerRows == null
        read.gatewayRows == null
        read.capabilities.canReadGateway == false
        read.capabilities.canDeliver == false
        treasury.gatewayRows.length == 1
        treasury.gatewayRows[0].reasonMessage == null
        treasury.gatewayRows[0].paymentGatewayConfigId == null
        treasury.ledgerRows.length == 1
    }
})
feature("validate, deliver without scanned files and confirm produce one exact posted receipt", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.draft(f),
            validated = h.confirm(h.preview(f, paymentId, "validate")),
            delivery = h.preview(f, paymentId, "deliver"),
            first = h.confirm(delivery, "life-delivery-replay"),
            again = h.confirm(delivery, "life-delivery-replay"),
            confirmed = h.confirm(h.preview(f, paymentId, "confirm")),
            transactions = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            entries = h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: transactions[0].acctgTransId})
        return {validated, first, again, confirmed, transactions, entries, view: h.detail(f, paymentId)}
    },
    then({validated, first, again, confirmed, transactions, entries, view}) {
        validated.statusId == "PmntPromised"
        first.statusId == "PmntDelivered"
        again.statusId == first.statusId
        again.alreadyApplied == true
        confirmed.statusId == "PmntConfirmed"
        transactions.length == 1
        transactions[0].isPosted == "Y"
        transactions[0].glFiscalTypeEnumId == "GLFT_ACTUAL"
        entries.some(row => row.glAccountId === "111100000" && row.debitCreditFlag === "D" && toDecimal(row.amount).eq(60))
        entries
            .filter(row => row.debitCreditFlag === "C")
            .reduce((sum, row) => sum.add(row.amount), toDecimal(0))
            .eq(60)
        view.payment.settlementDateText == f.day
        view.historyRows.filter(row => row.action === "deliver").length == 1
    }
})
feature("outgoing manual delivery credits the owned cash account and remains an unapplied payable payment", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f, {cashDirection: "outgoing", amount: "25"}),
            transactions = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        return {
            view: h.detail(f, paymentId),
            transactions,
            entries: h.lib.rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: transactions[0].acctgTransId})
        }
    },
    then({view, transactions, entries}) {
        view.payment.financeDirection == "payable"
        view.payment.cashDirection == "outgoing"
        toDecimal(view.totals.unappliedTotal).eq(25)
        transactions.length == 1
        transactions[0].acctgTransTypeEnumId == "AttOutgoingPayment"
        entries.some(row => row.glAccountId === "111100000" && row.debitCreditFlag === "C" && toDecimal(row.amount).eq(25))
    }
})
feature("draft cancellation is reviewed, idempotent and creates no cash posting", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            review = h.preview(f, paymentId, "cancel"),
            result = h.confirm(review, "life-cancel-replay"),
            again = h.confirm(review, "life-cancel-replay")
        return {result, again, count: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId})}
    },
    then({result, again, count}) {
        result.statusId == "PmntCancelled"
        again.alreadyApplied == true
        count == 0
    }
})
feature("human reference and reason are required while optional evidence is not invented as policy", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            base = {organizationPartyId: f.org, paymentId, sourceVersion: h.detail(f, paymentId).sourceVersion, action: "deliver"}
        return {
            reference: h.rejected("preview#PaymentState", Object.assign({}, base, {reason: "Verified"})),
            reason: h.rejected("preview#PaymentState", Object.assign({}, base, {referenceNumber: "MANUAL-1"})),
            positive: h.native("preview#PaymentState", Object.assign({}, base, {reason: "Verified", referenceNumber: "MANUAL-1"}))
        }
    },
    then({reference, reason, positive}) {
        reference.includes("PAYMENT_EVIDENCE_REQUIRED")
        reason.includes("PAYMENT_EVIDENCE_REQUIRED")
        positive.evidenceRows.length == 0
        positive.canApply == true
    }
})
feature("reviewed delivery refuses changed financial header and changed payment method without durable effects", {
    when() {
        const h = helper(),
            a = h.draft(f),
            review = h.preview(f, a, "deliver"),
            before = h.detail(f, a)
        h.native("store#PaymentDraft", h.request(f, {paymentId: a, sourceVersion: before.sourceVersion, amount: "65"}))
        const staleHeader = h.rejected("change#PaymentState", {
                previewId: review.previewId,
                inputFingerprint: review.inputFingerprint,
                operationKey: "life-stale-header"
            }),
            b = h.draft(f),
            methodReview = h.preview(f, b, "deliver"),
            method = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.methodId}),
            oldThru = method.thruDate
        h.call("update#mantle.account.method.PaymentMethod", {
            paymentMethodId: f.methodId,
            thruDate: Number(f.timestamp) + 86400000
        })
        let staleMethod
        try {
            staleMethod = h.rejected("change#PaymentState", {
                previewId: methodReview.previewId,
                inputFingerprint: methodReview.inputFingerprint,
                operationKey: "life-stale-method"
            })
        } finally {
            h.call("update#mantle.account.method.PaymentMethod", {paymentMethodId: f.methodId, thruDate: oldThru})
        }
        return {
            staleHeader,
            staleMethod,
            count:
                h.count("mantle.ledger.transaction.AcctgTrans", {paymentId: a}) +
                h.count("mantle.ledger.transaction.AcctgTrans", {paymentId: b})
        }
    },
    then({staleHeader, staleMethod, count}) {
        staleHeader.includes("STALE_REVISION")
        staleMethod.includes("STALE_PREVIEW")
        count == 0
    }
})
feature("search happens before paging and selected rows outside text retain their current authorized revision", {
    when() {
        const h = helper(),
            a = h.draft(f, {referenceNumber: "ALPHA-SEARCH"}),
            b = h.draft(f, {referenceNumber: "OMEGA-SEARCH"})
        login(f.users.ar)
        return {
            a,
            b,
            value: h.native("find#Payments", {
                organizationPartyId: f.org,
                text: "omega-search",
                pageSize: 1,
                selectedPaymentIdList: [a]
            })
        }
    },
    then({a, b, value}) {
        value.complete == true
        value.recordCount == 1
        value.rows[0].paymentId == b
        value.selectedRows[0].paymentId == a
        value.selectedRows[0].sourceVersion != null
    }
})
feature("foreign owner methods, currency precision and native guard disabled refuse the same authorized draft request", {
    when() {
        const h = helper(),
            request = h.request(f),
            method = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId}),
            workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
        const owner = h.rejected(
                "create#PaymentDraft",
                Object.assign({}, request, {
                    organizationPaymentMethodId: method.paymentMethodId,
                    organizationMethodVersion: workflow.methodVersion(method)
                })
            ),
            precision = h.rejected("create#PaymentDraft", Object.assign({}, request, {amount: "1.001"}))
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            settlementApplicationGuardEnabled: "N"
        })
        let guard
        try {
            guard = h.rejected("create#PaymentDraft", request)
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y"
            })
        }
        return {owner, precision, guard, positive: h.native("create#PaymentDraft", request)}
    },
    then({owner, precision, guard, positive}) {
        owner.includes("PAYMENT_METHOD_UNAVAILABLE")
        precision.includes("CURRENCY_PRECISION")
        guard.includes("SETTLEMENT_GUARD_REQUIRED")
        positive.paymentId != null
    }
})
feature("manual delivery refuses gateway instruments and legacy for-invoice auto application", {
    when() {
        const h = helper(),
            gateway = h.draft(f, {paymentInstrumentEnumId: "PiCreditCard"}),
            paymentId = h.draft(f),
            invoiceId = h.settlement.invoice(f)
        // This is an unmanaged legacy row; managed native payments forbid raw linkage changes.
        const legacy = h.call("create#mantle.account.payment.Payment", {
            fromPartyId: f.customer,
            toPartyId: f.org,
            statusId: "PmntPromised",
            paymentTypeEnumId: "PtInvoicePayment",
            amount: "10",
            amountUomId: "USD",
            effectiveDate: f.timestamp,
            paymentInstrumentEnumId: "PiOther",
            toPaymentMethodId: f.methodId,
            forInvoiceId: invoiceId
        }).paymentId
        return {
            gateway: h.rejected("preview#PaymentState", {
                organizationPartyId: f.org,
                paymentId: gateway,
                sourceVersion: h.detail(f, gateway).sourceVersion,
                action: "deliver",
                referenceNumber: "R",
                reason: "Manual"
            }),
            linked: h.rejected("preview#PaymentState", {
                organizationPartyId: f.org,
                paymentId: legacy,
                sourceVersion: h.detail(f, legacy).sourceVersion,
                action: "deliver",
                referenceNumber: "R",
                reason: "Manual"
            }),
            view: h.detail(f, gateway),
            unused: paymentId
        }
    },
    then({gateway, linked, view}) {
        gateway.includes("GATEWAY_PAYMENT_MANAGED")
        linked.includes("INVOICE_APPLICATION_REVIEW_REQUIRED")
        view.capabilities.canDeliver == false
    }
})
