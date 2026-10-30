// Positive applications retain their original source postings through named and generic entity writers.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const T = "mantle.ledger.transaction.AcctgTrans"
const E = "mantle.ledger.transaction.AcctgTransEntry"
const A = "mantle.account.payment.PaymentApplication"
const ledger = (verb, input) => helper().call("mantle.ledger.LedgerServices." + verb, input)
let f

function row(entity, input) {
    return helper().lib.one(entity, input)
}
function snapshot(transactionId) {
    const h = helper()
    return JSON.stringify({
        transaction: h.lib.map(row(T, {acctgTransId: transactionId})),
        entries: h.lib.rows(E, {acctgTransId: transactionId}).map(h.lib.map)
    })
}
function counts() {
    const h = helper()
    return {transactions: h.count(T, {organizationPartyId: f.org}), applications: h.count(A)}
}
function fresh() {
    const h = helper(),
        invoiceId = h.invoice(f, "100"),
        paymentId = h.payment(f, "60")
    const own = field =>
        h.lib
            .rows(T, {[field]: field === "invoiceId" ? invoiceId : paymentId, organizationPartyId: f.org})
            .find(tx => !tx.paymentApplicationId && !tx.reverseOfAcctgTransId && (field !== "invoiceId" || !tx.paymentId))
    const invoice = own("invoiceId"),
        cash = own("paymentId")
    if (!invoice || !cash || invoice.isPosted !== "Y" || cash.isPosted !== "Y")
        throw new Error("Source-guard fixtures require posted invoice and original cash")
    return {invoiceId, paymentId, invoice, cash}
}
function apply(records, id) {
    const made = helper().call("create#" + A, {
        paymentApplicationId: id,
        invoiceId: records.invoiceId,
        paymentId: records.paymentId,
        amountApplied: "10",
        appliedDate: f.timestamp
    })
    const application = row(A, {paymentApplicationId: made.paymentApplicationId})
    if (!application || !toDecimal(application.amountApplied).eq(10))
        throw new Error("Source-guard fixture needs a positive application")
    return application
}
function entry(transaction) {
    const first = helper().lib.rows(E, {acctgTransId: transaction.acctgTransId})[0]
    if (!first) throw new Error("Source posting has no entries")
    return first
}
function mutation(action, transaction) {
    const key = {acctgTransId: transaction.acctgTransId}
    if (action === "unpost") return {service: "mantle.ledger.LedgerServices.unpost#AcctgTrans", input: key}
    if (action === "reverse")
        return {
            service: "mantle.ledger.LedgerServices.post#ReverseAcctgTrans",
            input: Object.assign({}, key, {reversalDate: f.timestamp, changeReason: "Source guard verification"})
        }
    return {
        service: "mantle.ledger.LedgerServices.move#AcctgTransEntry",
        input: Object.assign({}, key, {acctgTransEntrySeqId: entry(transaction).acctgTransEntrySeqId, glAccountId: "550000000"})
    }
}
function freeMutation(action, transaction) {
    const h = helper(),
        request = mutation(action, transaction)
    const result = h.call(request.service, request.input)
    if (action === "unpost") {
        const unposted = row(T, {acctgTransId: transaction.acctgTransId}).isPosted === "N"
        ledger("post#AcctgTrans", {acctgTransId: transaction.acctgTransId})
        return unposted && row(T, {acctgTransId: transaction.acctgTransId}).isPosted === "Y"
    }
    const made = row(T, {acctgTransId: result.acctgTransId})
    const valid = !!made && made.acctgTransId !== transaction.acctgTransId && made.isPosted === "Y"
    assert(valid, "The permitted source mutation must create an actually posted transaction")
    ledger("unpost#AcctgTrans", {acctgTransId: made.acctgTransId})
    ledger("delete#AcctgTrans", {acctgTransId: made.acctgTransId})
    return valid && !row(T, {acctgTransId: transaction.acctgTransId}).reversedByAcctgTransId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("SOURCE_GUARD")
        // Named legacy reversal/move is a valid positive control here, without the separate reviewed-posting prerequisite.
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, postingGuardEnabled: "N"})
        helper().call("create#mantle.ledger.transaction.GlJournal", {
            glJournalId: "SOURCE_GUARD_ERROR",
            organizationPartyId: f.org,
            glJournalTypeEnumId: "GLJRNL_ERROR",
            glJournalName: "Source invariant error journal"
        })
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        login("john.doe")
        helper().base.cleanupLocks(f.org)
    }
})

feature("#kind source #action succeeds without applications and refuses the same request once applied", {
    where: [
        {kind: "invoice", action: "unpost"},
        {kind: "cash", action: "unpost"},
        {kind: "invoice", action: "reverse"},
        {kind: "cash", action: "reverse"},
        {kind: "invoice", action: "move"},
        {kind: "cash", action: "move"}
    ],
    when({kind, action}) {
        const h = helper(),
            records = fresh(),
            source = records[kind]
        const positive = freeMutation(action, source)
        apply(records, "SOURCE_GUARD_" + kind + "_" + action)
        const request = mutation(action, source),
            before = counts(),
            original = snapshot(source.acctgTransId)
        const refused = h.rejected(request.service, request.input)
        return {positive, refused, before, after: counts(), original, retained: snapshot(source.acctgTransId)}
    },
    then({positive, refused, before, after, original, retained}) {
        positive == true
        refused.includes("SOURCE_HAS_APPLICATIONS")
        after.transactions == before.transactions
        after.applications == before.applications
        retained == original
    }
})

feature("generic #kind header and entry financial changes refuse while positive application evidence remains exact", {
    where: [{kind: "invoice"}, {kind: "cash"}],
    when({kind}) {
        const h = helper(),
            records = fresh(),
            source = records[kind],
            first = entry(source)
        apply(records, "SOURCE_GUARD_RAW_" + kind)
        const before = counts(),
            original = snapshot(source.acctgTransId),
            key = {acctgTransId: source.acctgTransId}
        const failures = []
        for (const change of [
            {isPosted: "N"},
            {amountUomId: "EUR"},
            {transactionDate: Number(f.timestamp) + 86400000},
            {glJournalId: "SOURCE_GUARD_ERROR"},
            {glFiscalTypeEnumId: "GLFT_BUDGET"},
            {localCurrencyUomId: "EUR"},
            {originalCurrencyUomId: "EUR"}
        ])
            failures.push(h.rejected("update#" + T, Object.assign({}, key, change)))
        failures.push(h.rejected("delete#" + T, key))
        const entryKey = Object.assign({}, key, {acctgTransEntrySeqId: first.acctgTransEntrySeqId})
        for (const change of [
            {amount: toDecimal(first.amount).add(1)},
            {debitCreditFlag: first.debitCreditFlag === "D" ? "C" : "D"},
            {glAccountId: "550000000"},
            {localCurrencyAmount: "1"},
            {originalCurrencyAmount: "1"}
        ])
            failures.push(h.rejected("update#" + E, Object.assign({}, entryKey, change)))
        failures.push(h.rejected("delete#" + E, entryKey))
        failures.push(
            h.rejected(
                "create#" + E,
                Object.assign({}, key, {
                    acctgTransEntrySeqId: "SOURCE_EXTRA",
                    debitCreditFlag: "D",
                    glAccountId: "550000000",
                    amount: "1"
                })
            )
        )
        return {failures, before, after: counts(), original, retained: snapshot(source.acctgTransId)}
    },
    then({failures, before, after, original, retained}) {
        failures.length == 15
        failures.every(message => message.includes("SOURCE_HAS_APPLICATIONS"))
        after.transactions == before.transactions
        after.applications == before.applications
        retained == original
    }
})

feature("source description and bank reconciliation metadata remain editable with active applications", {
    when() {
        const h = helper(),
            records = fresh(),
            first = entry(records.cash)
        apply(records, "SOURCE_GUARD_METADATA")
        const before = counts(),
            amount = first.amount
        h.call("update#" + T, {acctgTransId: records.cash.acctgTransId, description: "Bank statement reviewed"})
        h.call("update#" + E, {
            acctgTransId: records.cash.acctgTransId,
            acctgTransEntrySeqId: first.acctgTransEntrySeqId,
            description: "Matched bank receipt",
            reconcileStatusId: "AterRec"
        })
        return {
            before,
            after: counts(),
            transaction: row(T, {acctgTransId: records.cash.acctgTransId}),
            entry: row(E, {acctgTransId: records.cash.acctgTransId, acctgTransEntrySeqId: first.acctgTransEntrySeqId}),
            amount
        }
    },
    then({before, after, transaction, entry, amount}) {
        transaction.description == "Bank statement reviewed"
        transaction.isPosted == "Y"
        entry.description == "Matched bank receipt"
        entry.reconcileStatusId == "AterRec"
        entry.amount == amount
        after.transactions == before.transactions
        after.applications == before.applications
    }
})

feature("generic zero unapplication reverses its application and permits original source unposting", {
    when() {
        const h = helper(),
            records = fresh(),
            application = apply(records, "SOURCE_GUARD_ZERO")
        const own = h.lib.rows(T, {paymentApplicationId: application.paymentApplicationId}).find(tx => !tx.reverseOfAcctgTransId)
        assert(own && own.isPosted === "Y", "The positive application needs its real reclassification posting")
        const refused = h.rejected("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: records.cash.acctgTransId})
        h.call("update#" + A, {
            paymentApplicationId: application.paymentApplicationId,
            amountApplied: "0",
            amountOriginallyApplied: "10"
        })
        ledger("unpost#AcctgTrans", {acctgTransId: records.cash.acctgTransId})
        const zero = row(A, {paymentApplicationId: application.paymentApplicationId}),
            unposted = row(T, {acctgTransId: records.cash.acctgTransId}).isPosted
        const reversed = row(T, {acctgTransId: own.acctgTransId})
        ledger("post#AcctgTrans", {acctgTransId: records.cash.acctgTransId})
        return {refused, zero, unposted, reversed}
    },
    then({refused, zero, unposted, reversed}) {
        refused.includes("SOURCE_HAS_APPLICATIONS")
        zero.amountApplied == 0
        unposted == "N"
        !!reversed.reversedByAcctgTransId
    }
})

feature("default-off permits the exact legacy unpost request and leaves applications untouched", {
    when() {
        const h = helper(),
            records = fresh(),
            application = apply(records, "SOURCE_GUARD_OFF")
        const input = {acctgTransId: records.cash.acctgTransId}
        const refused = h.rejected("mantle.ledger.LedgerServices.unpost#AcctgTrans", input)
        let legacyStatus
        try {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "N"
            })
            ledger("unpost#AcctgTrans", input)
            legacyStatus = row(T, input).isPosted
            ledger("post#AcctgTrans", input)
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y"
            })
        }
        return {
            refused,
            legacyStatus,
            application: row(A, {paymentApplicationId: application.paymentApplicationId}),
            restored: row(T, input).isPosted
        }
    },
    then({refused, legacyStatus, application, restored}) {
        refused.includes("SOURCE_HAS_APPLICATIONS")
        legacyStatus == "N"
        application.amountApplied == 10
        restored == "Y"
    }
})

feature("a real full-single original cash posting retains its application ID and remains protected", {
    when() {
        const h = helper(),
            invoiceId = h.invoice(f, "10")
        const made = h.call("mantle.account.PaymentServices.create#InvoicePayment", {
            invoiceId,
            amount: "10",
            effectiveDate: f.timestamp,
            paymentStatusId: "PmntDelivered",
            paymentInstrumentEnumId: "PiCompanyCheck"
        })
        const cash = h.lib
            .rows(T, {paymentId: made.paymentId})
            .find(tx => tx.acctgTransTypeEnumId === "AttIncomingPayment" && !tx.reverseOfAcctgTransId)
        assert(cash && cash.isPosted === "Y", "The legacy full-single flow must post actual original cash")
        const application = row(A, {paymentApplicationId: cash.paymentApplicationId}),
            before = counts()
        const failures = ["unpost", "reverse", "move"].map(action => {
            const request = mutation(action, cash)
            return h.rejected(request.service, request.input)
        })
        return {cash, application, failures, before, after: counts()}
    },
    then({cash, application, failures, before, after}) {
        cash.acctgTransTypeEnumId == "AttIncomingPayment"
        !!cash.paymentApplicationId
        application.amountApplied == 10
        failures.length == 3
        failures.every(message => message.includes("SOURCE_HAS_APPLICATIONS"))
        after.transactions == before.transactions
        after.applications == before.applications
    }
})

feature("generic application creation and raw #kind unpost cannot commit an unbacked positive application", {
    where: [{kind: "invoice"}, {kind: "cash"}],
    when({kind}) {
        const h = helper(),
            records = fresh(),
            source = records[kind]
        const input = {
            paymentApplicationId: "SOURCE_GUARD_RACE_" + kind,
            invoiceId: records.invoiceId,
            paymentId: records.paymentId,
            amountApplied: "10",
            appliedDate: f.timestamp
        }
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    if (thread === 0) call("create#mantle.account.payment.PaymentApplication", args.application)
                    else call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: args.transactionId, isPosted: "N"})
                    return {ok: true}
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: error.message}
                }
            },
            {application: input, transactionId: source.acctgTransId},
            {transaction: false, timeout: 30}
        )
        const stored = row(T, {acctgTransId: source.acctgTransId}),
            application = row(A, {paymentApplicationId: input.paymentApplicationId})
        const outcome = {results, posted: stored.isPosted, applied: application ? String(application.amountApplied) : "0"}
        if (stored.isPosted === "N") h.call("update#" + T, {acctgTransId: stored.acctgTransId, isPosted: "Y"})
        return outcome
    },
    then({results, posted, applied}) {
        results.filter(result => result.ok).length == 1
        results.filter(result => result.error && /SOURCE_HAS_APPLICATIONS|APPLICATION_SOURCE_NOT_POSTED/.test(result.error))
            .length == 1
        toDecimal(applied).isZero() ? posted == "N" : posted == "Y"
        toDecimal(applied).isZero() || toDecimal(applied).eq(10)
    }
})

feature("an application's own positive GL posting is immutable until zero unapplication reverses it", {
    when() {
        const h = helper(),
            records = fresh(),
            application = apply(records, "SOURCE_GUARD_OWN")
        const own = h.lib.rows(T, {paymentApplicationId: application.paymentApplicationId}).find(tx => !tx.reverseOfAcctgTransId)
        assert(own && own.isPosted === "Y", "The application needs an actual posted reclassification")
        const first = entry(own),
            before = counts(),
            original = snapshot(own.acctgTransId)
        const failures = ["unpost", "reverse", "move"].map(action => {
            const request = mutation(action, own)
            return h.rejected(request.service, request.input)
        })
        failures.push(h.rejected("update#" + T, {acctgTransId: own.acctgTransId, isPosted: "N"}))
        failures.push(h.rejected("delete#" + T, {acctgTransId: own.acctgTransId}))
        failures.push(
            h.rejected("update#" + E, {
                acctgTransId: own.acctgTransId,
                acctgTransEntrySeqId: first.acctgTransEntrySeqId,
                amount: "11"
            })
        )
        failures.push(
            h.rejected("delete#" + E, {acctgTransId: own.acctgTransId, acctgTransEntrySeqId: first.acctgTransEntrySeqId})
        )
        const afterRefusal = counts(),
            retained = snapshot(own.acctgTransId)
        h.call("update#" + A, {
            paymentApplicationId: application.paymentApplicationId,
            amountApplied: "0",
            amountOriginallyApplied: "10"
        })
        const reversed = row(T, {acctgTransId: own.acctgTransId})
        ledger("unpost#AcctgTrans", {acctgTransId: own.acctgTransId})
        const zeroUnposted = row(T, {acctgTransId: own.acctgTransId}).isPosted
        ledger("post#AcctgTrans", {acctgTransId: own.acctgTransId})
        return {
            failures,
            before,
            afterRefusal,
            original,
            retained,
            reversed,
            zeroUnposted,
            application: row(A, {paymentApplicationId: application.paymentApplicationId})
        }
    },
    then({failures, before, afterRefusal, original, retained, reversed, zeroUnposted, application}) {
        failures.length == 7
        failures.every(message => message.includes("SOURCE_HAS_APPLICATIONS"))
        afterRefusal.transactions == before.transactions
        afterRefusal.applications == before.applications
        retained == original
        application.amountApplied == 0
        !!reversed.reversedByAcctgTransId
        zeroUnposted == "N"
    }
})

feature("raw reversal construction cannot bypass the original source mutation guard", {
    when() {
        const h = helper(),
            records = fresh(),
            source = records.cash
        const input = {
            acctgTransId: "SOURCE_GUARD_RAW_REVERSE",
            organizationPartyId: f.org,
            paymentId: records.paymentId,
            reverseOfAcctgTransId: source.acctgTransId,
            acctgTransTypeEnumId: source.acctgTransTypeEnumId,
            amountUomId: "USD",
            glFiscalTypeEnumId: "GLFT_ACTUAL",
            transactionDate: f.timestamp,
            isPosted: "N"
        }
        h.call("create#" + T, input)
        const permitted = row(T, {acctgTransId: input.acctgTransId})
        h.call("delete#" + T, {acctgTransId: input.acctgTransId})
        apply(records, "SOURCE_GUARD_RAW_REVERSE_AP")
        const unrelated = h.call("create#" + T, {
            acctgTransId: "SOURCE_GUARD_UNLINKED",
            organizationPartyId: f.org,
            acctgTransTypeEnumId: "AttInternal",
            amountUomId: "USD",
            glFiscalTypeEnumId: "GLFT_ACTUAL",
            transactionDate: f.timestamp,
            isPosted: "N"
        })
        const before = counts(),
            original = snapshot(source.acctgTransId)
        const failures = [
            h.rejected("create#" + T, input),
            h.rejected("create#" + T, Object.assign({}, input, {acctgTransId: "SOURCE_GUARD_RAW_POSTED_REVERSE", isPosted: "Y"})),
            h.rejected("update#" + T, {acctgTransId: unrelated.acctgTransId, reverseOfAcctgTransId: source.acctgTransId})
        ]
        const after = counts()
        h.call("delete#" + T, {acctgTransId: unrelated.acctgTransId})
        return {
            permitted: !!permitted && permitted.reverseOfAcctgTransId === source.acctgTransId,
            failures,
            before,
            after,
            original,
            retained: snapshot(source.acctgTransId),
            empty: !row(T, {acctgTransId: input.acctgTransId}) && !row(T, {acctgTransId: "SOURCE_GUARD_RAW_POSTED_REVERSE"})
        }
    },
    then({permitted, failures, before, after, original, retained, empty}) {
        permitted == true
        failures.length == 3
        failures.every(message => message.includes("SOURCE_HAS_APPLICATIONS"))
        after.transactions == before.transactions
        after.applications == before.applications
        retained == original
        empty == true
    }
})
