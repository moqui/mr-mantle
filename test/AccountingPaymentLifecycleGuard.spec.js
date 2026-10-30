// Reviewed payment provenance is authoritative under generic services and raw entity writers, without artifact authz.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const P = "mantle.account.payment.Payment"
const EVENT = "mantle.account.payment.PaymentLifecycleEvent"
let f, off, sourceInvoiceId, refundPaymentId

function payment(id) {
    return helper().lib.one(P, {paymentId: id})
}
function snapshot(id) {
    return JSON.stringify(helper().lib.map(payment(id)))
}
function counts() {
    const h = helper()
    return {
        payments: h.count(P),
        events: h.count(EVENT),
        transactions: h.count("mantle.ledger.transaction.AcctgTrans"),
        audit: h.count("moqui.entity.EntityAuditLog", {changedEntityName: P})
    }
}
function legacy(fixture = f, extra = {}) {
    return helper().call(
        "create#" + P,
        Object.assign(
            {
                paymentTypeEnumId: "PtInvoicePayment",
                fromPartyId: fixture.customer,
                toPartyId: fixture.org,
                amount: "60",
                amountUomId: "USD",
                statusId: "PmntProposed",
                effectiveDate: fixture.timestamp,
                paymentInstrumentEnumId: "PiOther",
                toPaymentMethodId: fixture.methodId,
                paymentRefNum: "Legacy reference",
                comments: "Legacy payment"
            },
            extra
        )
    ).paymentId
}
function rawWrite(mode, values) {
    return parallel(
        1,
        (thread, args) => {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            try {
                const value = ec.entity.makeValue("mantle.account.payment.Payment")
                for (const [field, input] of Object.entries(args.values)) value.set(field, input)
                if (args.mode === "createOrUpdate") value.createOrUpdate()
                else if (args.mode === "create") value.create()
                else if (args.mode === "delete") value.delete()
                else value.update()
                return ""
            } catch (error) {
                ec.message.clearErrors()
                return error.message
            }
        },
        {mode, values},
        {transaction: true, timeout: 30}
    )[0]
}
function write(writer, values) {
    if (writer === "generic update") return helper().rejected("update#" + P, values)
    return rawWrite(writer, values)
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures("ACCT_P5_MGUARD")
        off = h.fixtures("ACCT_P5_MGOFF")
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: off.org,
            settlementApplicationGuardEnabled: "N",
            postingGuardEnabled: "N"
        })
        sourceInvoiceId = h.settlement.invoice(f, "100")
        refundPaymentId = legacy()
        h.call("create#moqui.basic.EnumerationType", {
            enumTypeId: "ACCT_P5_MGUARD_LATCH",
            description: "Payment guard test coordination"
        })
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().settlement.base.cleanupLocks(f.org)
        if (off?.org) helper().settlement.base.cleanupLocks(off.org)
    }
})

feature("#writer cannot change managed financial fields while the same legacy field edits remain valid", {
    where: [{writer: "generic update"}, {writer: "raw update"}, {writer: "createOrUpdate"}],
    when({writer}) {
        const h = helper(),
            id = h.draft(f),
            original = snapshot(id),
            tomorrow = Number(f.timestamp) + 86400000,
            tomorrowDay = ec.l10n.format(tomorrow, "yyyy-MM-dd")
        const changes = [
            {statusId: "PmntPromised"},
            {paymentTypeEnumId: "PtPrePayment"},
            {paymentInstrumentEnumId: "PiCash"},
            {fromPartyId: off.customer},
            {toPartyId: off.org},
            {paymentMethodId: f.customerMethodId},
            {toPaymentMethodId: off.methodId},
            {amount: "61"},
            {amountUomId: "EUR"},
            {effectiveDate: tomorrow},
            {accountingDate: tomorrowDay},
            {settlementDate: tomorrow},
            {settlementAccountingDate: f.day},
            {financeOrganizationPartyId: off.org},
            {financeDirection: "payable"},
            {forInvoiceId: sourceInvoiceId},
            {refundForPaymentId: refundPaymentId},
            {overrideGlAccountId: "111100000"},
            {overrideOrgPartyId: off.org},
            {paymentRefNum: "Unreviewed reference"},
            {comments: "Unreviewed financial instruction"}
        ]
        const checks = []
        for (const change of changes) {
            const before = counts(),
                refusal = write(writer, {paymentId: id, ...change}),
                after = counts(),
                retained = snapshot(id)
            const legacyId = legacy(),
                allowed = write(writer, {paymentId: legacyId, ...change})
            checks.push({refusal, allowed, unchanged: retained === original && JSON.stringify(after) === JSON.stringify(before)})
        }
        return {checks}
    },
    then({checks}) {
        checks.length == 21
        checks.every(check => check.refusal.includes("PAYMENT_REVIEW_REQUIRED"))
        checks.every(check => check.unchanged)
        checks.every(check => check.allowed === "")
    }
})

feature("#writer cannot forge, adopt, unset or delete reviewed provenance", {
    where: [{writer: "generic"}, {writer: "raw"}],
    when({writer}) {
        const h = helper(),
            managedId = h.draft(f),
            legacyId = legacy(),
            forgedId = "ACCT_P5_MGUARD_FORGE_" + writer,
            original = snapshot(managedId),
            oldLegacy = snapshot(legacyId),
            before = counts()
        const update = values => (writer === "generic" ? h.rejected("update#" + P, values) : rawWrite("update", values))
        const creation = {
            paymentId: forgedId,
            paymentTypeEnumId: "PtInvoicePayment",
            fromPartyId: f.customer,
            toPartyId: f.org,
            amount: "60",
            amountUomId: "USD",
            statusId: "PmntProposed",
            paymentInstrumentEnumId: "PiOther",
            effectiveDate: f.timestamp,
            lifecycleManaged: "Y"
        }
        const createRefusal = writer === "generic" ? h.rejected("create#" + P, creation) : rawWrite("create", creation),
            adoptRefusal = update({paymentId: legacyId, lifecycleManaged: "Y"}),
            unsetRefusals = ["N", null].map(lifecycleManaged => update({paymentId: managedId, lifecycleManaged}))
        const deleteRefusal =
            writer === "generic"
                ? h.rejected("delete#" + P, {paymentId: managedId})
                : rawWrite("delete", {
                      paymentId: managedId,
                      lifecycleManaged: "N",
                      amount: "0",
                      fromPartyId: off.customer,
                      toPartyId: off.org
                  })
        return {
            createRefusal,
            adoptRefusal,
            unsetRefusals,
            deleteRefusal,
            original,
            retained: snapshot(managedId),
            oldLegacy,
            retainedLegacy: snapshot(legacyId),
            before,
            after: counts(),
            forgedExists: !!payment(forgedId)
        }
    },
    then({
        createRefusal,
        adoptRefusal,
        unsetRefusals,
        deleteRefusal,
        original,
        retained,
        oldLegacy,
        retainedLegacy,
        before,
        after,
        forgedExists
    }) {
        createRefusal.includes("PAYMENT_REVIEW_REQUIRED")
        adoptRefusal.includes("PAYMENT_REVIEW_REQUIRED")
        unsetRefusals.length == 2
        unsetRefusals.every(message => message.includes("PAYMENT_PROVENANCE_IMMUTABLE"))
        deleteRefusal.includes("PAYMENT_DELETE_REFUSED")
        retained == original
        retainedLegacy == oldLegacy
        JSON.stringify(after) == JSON.stringify(before)
        forgedExists == false
    }
})

feature("managed reconciliation metadata and equal financial values remain writable without a new lifecycle event", {
    when() {
        const h = helper(),
            id = h.draft(f),
            before = counts(),
            original = h.lib.map(payment(id))
        h.call("update#" + P, {paymentId: id, reconcileStatusId: "PmtrPartly", acctgTransResultEnumId: "AtrSuccess"})
        const raw = rawWrite("update", {paymentId: id, reconcileStatusId: "PmtrRec"}),
            noop = rawWrite("createOrUpdate", {paymentId: id, amount: "60.00", accountingDate: f.day, lifecycleManaged: "Y"})
        return {raw, noop, original, retained: payment(id), before, after: counts()}
    },
    then({raw, noop, original, retained, before, after}) {
        raw == ""
        noop == ""
        retained.lifecycleManaged == "Y"
        retained.reconcileStatusId == "PmtrRec"
        retained.acctgTransResultEnumId == "AtrSuccess"
        toDecimal(retained.amount).eq(original.amount)
        retained.statusId == original.statusId
        helper().lib.policy.calendarDateText(retained.accountingDate) == f.day
        after.payments == before.payments
        after.events == before.events
        after.transactions == before.transactions
    }
})

feature("unmanaged payments retain generic legacy updates and nullable dates with the guard #flag", {
    where: [{flag: "Y"}, {flag: "N"}],
    when({flag}) {
        const h = helper(),
            fixture = flag === "Y" ? f : off,
            id = legacy(fixture),
            before = counts()
        h.call("update#" + P, {paymentId: id, statusId: "PmntPromised", amount: "61"})
        const raw = rawWrite("createOrUpdate", {paymentId: id, paymentRefNum: "Legacy correction"}),
            retained = h.lib.map(payment(id)),
            events = h.count(EVENT, {paymentId: id}),
            transactions = h.count("mantle.ledger.transaction.AcctgTrans", {paymentId: id})
        h.call("delete#" + P, {paymentId: id})
        return {raw, retained, events, transactions, exists: !!payment(id), before, after: counts()}
    },
    then({raw, retained, events, transactions, exists, before, after}) {
        raw == ""
        retained.statusId == "PmntPromised"
        retained.amount == 61
        retained.paymentRefNum == "Legacy correction"
        retained.lifecycleManaged != "Y"
        retained.accountingDate == null
        retained.settlementAccountingDate == null
        events == 0
        transactions == 0
        exists == false
        after.payments == before.payments - 1
        after.events == before.events
        after.transactions == before.transactions
        after.audit > before.audit
    }
})

feature("native adoption defeats a simultaneous #writer retaining no caller revision", {
    where: [{writer: "loaded update"}, {writer: "no-version update"}, {writer: "createOrUpdate"}],
    when({writer}) {
        const h = helper(),
            id = legacy(),
            latchId = "ACCT_P5_MGUARD_" + writer.replace(/[^A-Za-z]/g, "").slice(0, 20)
        h.call("create#moqui.basic.Enumeration", {enumId: latchId, enumTypeId: "ACCT_P5_MGUARD_LATCH", description: "pending"})
        const input = h.request(f, {
            paymentId: id,
            sourceVersion: h.detail(f, id).sourceVersion,
            operationKey: "guard-adopt-" + writer.replace(/[^A-Za-z]/g, "")
        })
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                const entity = "mantle.account.payment.Payment"
                const latch = () =>
                    ec.entity.find("moqui.basic.Enumeration").condition("enumId", args.latchId).useCache(false).one()
                const signal = description =>
                    ec.service
                        .sync()
                        .name("update#moqui.basic.Enumeration")
                        .parameters({enumId: args.latchId, description})
                        .requireNewTransaction(true)
                        .throwOnError(true)
                        .call()
                if (thread === 0) {
                    const deadline = Date.now() + 15000
                    while (latch().description !== "raw-read" && Date.now() < deadline) {}
                    if (latch().description !== "raw-read") throw new Error("The raw writer did not reach its pre-adoption read")
                    try {
                        return {adopted: call("mantle.account.PaymentServices.store#PaymentDraft", args.input)}
                    } catch (error) {
                        ec.message.clearErrors()
                        signal("adoption-failed")
                        return {adoptionFailure: error.message}
                    }
                }
                const old = ec.entity.find(entity).condition("paymentId", args.paymentId).useCache(false).one()
                if (old.lifecycleManaged === "Y") throw new Error("The race fixture must start before native adoption")
                const value = args.writer === "loaded update" ? old : ec.entity.makeValue(entity)
                if (args.writer !== "loaded update") value.set("paymentId", args.paymentId)
                value.set("amount", toDecimal(61))
                signal("raw-read")
                const deadline = Date.now() + 15000
                let current
                do {
                    current = ec.entity.find(entity).condition("paymentId", args.paymentId).useCache(false).one()
                    if (latch().description === "adoption-failed") throw new Error("Native adoption failed before the raw write")
                } while (current.lifecycleManaged !== "Y" && Date.now() < deadline)
                if (current.lifecycleManaged !== "Y") throw new Error("Native adoption did not commit before the stale raw write")
                try {
                    if (args.writer === "createOrUpdate") value.createOrUpdate()
                    else value.update()
                    return {rawWrote: true}
                } catch (error) {
                    ec.message.clearErrors()
                    return {
                        rawRefusal: error.message,
                        observedManaged: current.lifecycleManaged,
                        hadCallerStamp: args.writer === "loaded update"
                    }
                }
            },
            {writer, paymentId: id, latchId, input},
            {transaction: true, timeout: 30}
        )
        return {
            results,
            retained: payment(id),
            events: h.count(EVENT, {paymentId: id}),
            transactions: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId: id})
        }
    },
    then({results, retained, events, transactions}) {
        results.filter(result => result.adopted).length == 1
        results.filter(result => result.rawRefusal && /PAYMENT_REVIEW_REQUIRED|updated by someone else/.test(result.rawRefusal))
            .length == 1
        results.filter(result => result.observedManaged === "Y").length == 1
        !results.some(result => result.rawWrote)
        retained.lifecycleManaged == "Y"
        retained.amount == 60
        events == 1
        transactions == 0
    }
})
