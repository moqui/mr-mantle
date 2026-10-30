// Generic entity writers meet the adopted application invariant even when no GL application is posted.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const A = "mantle.account.payment.PaymentApplication"
const P = "mantle.account.payment.Payment"
const T = "mantle.ledger.transaction.AcctgTrans"
let f, foreign

function pair(fixture = f, invoiceAmount = "100", paymentAmount = "60", extra = {}) {
    const h = helper()
    const invoiceId = h.invoice(fixture, invoiceAmount, "receivable", extra)
    // Entity-auto creation intentionally has no Delivered transition, so the source has no GL posting.
    const paymentId = h.call("create#" + P, {
        fromPartyId: fixture.customer,
        toPartyId: fixture.org,
        paymentTypeEnumId: "PtInvoicePayment",
        paymentInstrumentEnumId: "PiCompanyCheck",
        amount: paymentAmount,
        amountUomId: "USD",
        statusId: "PmntDelivered",
        effectiveDate: extra.invoiceDate || fixture.timestamp,
        accountingDate: extra.accountingDate || null
    }).paymentId
    return {invoiceId, paymentId}
}
function parameters(records, id, amount = "10", extra = {}) {
    return Object.assign(
        {
            paymentApplicationId: id,
            invoiceId: records.invoiceId,
            paymentId: records.paymentId,
            amountApplied: amount,
            appliedDate: f.timestamp
        },
        extra
    )
}
function application(id) {
    return helper().lib.one(A, {paymentApplicationId: id})
}
function counts() {
    const h = helper()
    return {
        applications: h.lib.find(A).condition("paymentApplicationId", "like", "APP_GUARD_%").count(),
        transactions: h.count(T, {organizationPartyId: f.org}),
        audit: h.lib
            .find("moqui.entity.EntityAuditLog", {changedEntityName: A})
            .condition("pkPrimaryValue", "like", "APP_GUARD_%")
            .count()
    }
}
function currentPeriod() {
    const result = ec.resource
        .script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
        .fiscal(f.org, f.timestamp, false, [], f.day)
    assert(result.periods.length > 0 && result.findings.length === 0, "The invariant fixture needs an open fiscal period")
    return helper().lib.map(result.periods[0])
}
function rawUpsert(values) {
    return parallel(
        1,
        (thread, values) => {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            try {
                const value = ec.entity.makeValue("mantle.account.payment.PaymentApplication")
                for (const [field, input] of Object.entries(values)) value.set(field, input)
                value.createOrUpdate()
                return ""
            } catch (error) {
                ec.message.clearErrors()
                return error.message
            }
        },
        values,
        {transaction: true, timeout: 30}
    )[0]
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("APP_GUARD")
        foreign = helper().fixtures("APP_GUARD_OFF")
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: foreign.org,
            settlementApplicationGuardEnabled: "N",
            postingGuardEnabled: "N"
        })
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        login("john.doe")
        helper().base.cleanupLocks(f.org)
        helper().base.cleanupLocks(foreign.org)
    }
})

feature("generic applications enforce the aggregate #limited balance without a source GL transaction", {
    where: [
        {limited: "source", invoiceAmount: "100", paymentAmount: "60"},
        {limited: "target", invoiceAmount: "60", paymentAmount: "100"}
    ],
    when({limited, invoiceAmount, paymentAmount}) {
        const h = helper(),
            records = pair(f, invoiceAmount, paymentAmount)
        const good = parameters(records, "APP_GUARD_CAP_" + limited, "50")
        h.call("create#" + A, good)
        const before = counts()
        const refused = h.rejected("create#" + A, parameters(records, "APP_GUARD_OVER_" + limited, "11"))
        return {
            good: application(good.paymentApplicationId),
            refused,
            before,
            after: counts(),
            sourcePostings: h.count(T, {paymentId: records.paymentId})
        }
    },
    then({good, refused, before, after, sourcePostings}) {
        good.amountApplied == 50
        good.acctgTransResultEnumId == "AtrPaymentNotPosted"
        sourcePostings == 0
        refused.includes("APPLICATION_BALANCE_CHANGED")
        after.applications == before.applications
        after.transactions == before.transactions
        after.audit == before.audit
    }
})

feature("generic applications refuse sub-minor-unit amounts before totals or postings", {
    when() {
        const h = helper(),
            records = pair()
        const good = parameters(records, "APP_GUARD_PRECISION_OK", "1.01")
        h.call("create#" + A, good)
        const before = counts()
        const refused = h.rejected("create#" + A, parameters(records, "APP_GUARD_PRECISION_BAD", "0.001"))
        return {good: application(good.paymentApplicationId), refused, before, after: counts()}
    },
    then({good, refused, before, after}) {
        good.amountApplied == 1.01
        refused.includes("APPLICATION_AMOUNT_PRECISION")
        after.applications == before.applications
        after.transactions == before.transactions
        after.audit == before.audit
    }
})

feature("the current application period is checked even when the poster would return PaymentNotPosted", {
    when() {
        const h = helper(),
            records = pair(),
            period = currentPeriod()
        const input = parameters(records, "APP_GUARD_PERIOD")
        let refused, before, afterRefusal
        try {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
            before = counts()
            refused = h.rejected("create#" + A, input)
            afterRefusal = counts()
        } finally {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: period.isClosed})
        }
        h.call("create#" + A, input)
        return {
            refused,
            before,
            afterRefusal,
            good: application(input.paymentApplicationId),
            sourcePostings: h.count(T, {paymentId: records.paymentId})
        }
    },
    then({refused, before, afterRefusal, good, sourcePostings}) {
        refused.includes("PERIOD_CLOSED")
        afterRefusal.applications == before.applications
        afterRefusal.transactions == before.transactions
        afterRefusal.audit == before.audit
        good.amountApplied == 10
        good.acctgTransResultEnumId == "AtrPaymentNotPosted"
        sourcePostings == 0
    }
})

feature("an adopted positive application cannot move both links into a non-adopted organization", {
    when() {
        const h = helper(),
            records = pair(),
            outside = pair(foreign)
        const input = parameters(records, "APP_GUARD_MOVE")
        h.call("create#" + A, input)
        const before = counts()
        const refused = h.rejected("update#" + A, {paymentApplicationId: input.paymentApplicationId, ...outside})
        return {refused, input, after: application(input.paymentApplicationId), before, counts: counts()}
    },
    then({refused, input, after, before, counts}) {
        refused.includes("APPLICATION_IMMUTABLE")
        after.invoiceId == input.invoiceId
        after.paymentId == input.paymentId
        after.amountApplied == input.amountApplied
        counts.applications == before.applications
        counts.transactions == before.transactions
        counts.audit == before.audit
    }
})

feature("unapplication preserves original effective and calendar dates while a plain zero is allowed", {
    when() {
        const h = helper(),
            records = pair()
        const input = parameters(records, "APP_GUARD_UNAPPLY", "10", {accountingDate: f.day})
        h.call("create#" + A, input)
        const tomorrow = new Date(Number(f.timestamp) + 86400000)
        const refusals = [
            h.rejected("update#" + A, {
                paymentApplicationId: input.paymentApplicationId,
                amountApplied: "0",
                appliedDate: tomorrow
            }),
            h.rejected("update#" + A, {
                paymentApplicationId: input.paymentApplicationId,
                amountApplied: "0",
                accountingDate: ec.l10n.format(tomorrow, "yyyy-MM-dd")
            })
        ]
        const retained = h.lib.map(application(input.paymentApplicationId))
        h.call("update#" + A, {
            paymentApplicationId: input.paymentApplicationId,
            amountApplied: "0",
            amountOriginallyApplied: "10"
        })
        return {
            refusals,
            retained,
            input,
            zero: application(input.paymentApplicationId),
            invoiceBalance: h.lib.totals(h.lib.one(h.lib.invoiceEntity, {invoiceId: records.invoiceId})).unpaidTotal
        }
    },
    then({refusals, retained, input, zero, invoiceBalance}) {
        refusals.length == 2
        refusals.every(message => message.includes("APPLICATION_IMMUTABLE"))
        retained.amountApplied == 10
        helper().lib.ms(retained.appliedDate) == helper().lib.ms(input.appliedDate)
        helper().lib.policy.calendarDateText(retained.accountingDate) == f.day
        zero.amountApplied == 0
        helper().lib.ms(zero.appliedDate) == helper().lib.ms(input.appliedDate)
        helper().lib.policy.calendarDateText(zero.accountingDate) == f.day
        invoiceBalance == 100
    }
})

feature("#writer cannot overwrite an existing adopted application through a store alias", {
    where: [{writer: "entity-auto store"}, {writer: "raw createOrUpdate"}],
    when({writer}) {
        const h = helper(),
            records = pair(),
            outside = pair(foreign)
        const input = parameters(records, writer === "entity-auto store" ? "APP_GUARD_STORE" : "APP_GUARD_UPSERT")
        const valid = writer === "entity-auto store" ? (h.call("store#" + A, input), "") : rawUpsert(input)
        const replacement = Object.assign({}, input, outside)
        const before = counts()
        const refused = writer === "entity-auto store" ? h.rejected("store#" + A, replacement) : rawUpsert(replacement)
        return {valid, refused, input, retained: application(input.paymentApplicationId), before, after: counts()}
    },
    then({valid, refused, input, retained, before, after}) {
        valid == ""
        refused.includes("APPLICATION_IMMUTABLE")
        retained.invoiceId == input.invoiceId
        retained.paymentId == input.paymentId
        retained.amountApplied == 10
        after.applications == before.applications
        after.transactions == before.transactions
        after.audit == before.audit
    }
})

feature("positive applications cannot be deleted while an unapplied zero can be removed", {
    when() {
        const h = helper(),
            records = pair(),
            input = parameters(records, "APP_GUARD_DELETE")
        h.call("create#" + A, input)
        const refused = h.rejected("delete#" + A, {paymentApplicationId: input.paymentApplicationId})
        const positive = h.lib.map(application(input.paymentApplicationId))
        h.call("update#" + A, {
            paymentApplicationId: input.paymentApplicationId,
            amountApplied: "0",
            amountOriginallyApplied: "10"
        })
        h.call("delete#" + A, {paymentApplicationId: input.paymentApplicationId})
        return {refused, positive, exists: !!application(input.paymentApplicationId)}
    },
    then({refused, positive, exists}) {
        refused.includes("APPLICATION_DELETE_REFUSED")
        positive.amountApplied == 10
        exists == false
    }
})

feature("raw deletion cannot disguise a positive stored application with unsaved zero and foreign links", {
    when() {
        const h = helper(),
            records = pair(),
            outside = pair(foreign),
            input = parameters(records, "APP_GUARD_RAW_DELETE")
        h.call("create#" + A, input)
        const original = JSON.stringify(h.lib.map(application(input.paymentApplicationId))),
            before = counts()
        const refusal = parallel(
            1,
            (thread, values) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                try {
                    const row = ec.entity
                        .find("mantle.account.payment.PaymentApplication")
                        .condition("paymentApplicationId", values.paymentApplicationId)
                        .one()
                    row.set("amountApplied", toDecimal(0))
                    row.set("invoiceId", values.invoiceId)
                    row.set("paymentId", values.paymentId)
                    row.delete()
                    return ""
                } catch (error) {
                    ec.message.clearErrors()
                    return error.message
                }
            },
            {paymentApplicationId: input.paymentApplicationId, ...outside},
            {transaction: true, timeout: 30}
        )[0]
        return {
            refusal,
            original,
            retained: JSON.stringify(h.lib.map(application(input.paymentApplicationId))),
            before,
            after: counts()
        }
    },
    then({refusal, original, retained, before, after}) {
        refusal.includes("APPLICATION_DELETE_REFUSED")
        retained == original
        JSON.stringify(after) == JSON.stringify(before)
    }
})

feature("posting-result metadata can update closed history without rewriting financial values or audit dates", {
    when() {
        const h = helper(),
            records = pair(),
            input = parameters(records, "APP_GUARD_METADATA")
        h.call("create#" + A, input)
        const original = h.lib.map(application(input.paymentApplicationId)),
            period = currentPeriod()
        let before, after, retained
        try {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
            before = counts()
            h.call("update#" + A, {paymentApplicationId: input.paymentApplicationId, acctgTransResultEnumId: "AtrSuccess"})
            retained = h.lib.map(application(input.paymentApplicationId))
            after = counts()
        } finally {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: period.isClosed})
        }
        return {original, retained, before, after}
    },
    then({original, retained, before, after}) {
        retained.acctgTransResultEnumId == "AtrSuccess"
        retained.amountApplied == original.amountApplied
        helper().lib.ms(retained.appliedDate) == helper().lib.ms(original.appliedDate)
        helper().lib.policy.calendarDateText(original.accountingDate) == f.day
        helper().lib.policy.calendarDateText(retained.accountingDate) == f.day
        retained.currencyUomId == original.currencyUomId
        after.applications == before.applications
        after.transactions == before.transactions
        after.audit == before.audit
    }
})

feature("default-off legacy no-posting application keeps its fields and audit behavior", {
    when() {
        const h = helper(),
            records = pair(),
            input = parameters(records, "APP_GUARD_DEFAULT_OFF"),
            period = currentPeriod()
        let refused, before, after, legacy
        try {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
            refused = h.rejected("create#" + A, input)
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "N",
                postingGuardEnabled: "N"
            })
            before = counts()
            h.call("create#" + A, input)
            legacy = h.lib.map(application(input.paymentApplicationId))
            after = counts()
        } finally {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: period.isClosed})
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y",
                postingGuardEnabled: "Y"
            })
        }
        return {refused, legacy, before, after}
    },
    then({refused, legacy, before, after}) {
        refused.includes("PERIOD_CLOSED")
        legacy.amountApplied == 10
        legacy.acctgTransResultEnumId == "AtrPaymentNotPosted"
        legacy.accountingDate == null
        legacy.currencyUomId == null
        legacy.settlementOperationKey == null
        after.applications == before.applications + 1
        after.transactions == before.transactions
        after.audit == before.audit
    }
})

feature("raw calendar days must match source evidence before any optional posting", {
    when() {
        const h = helper(),
            records = pair(),
            tomorrow = ec.l10n.format(new Date(Number(f.timestamp) + 86400000), "yyyy-MM-dd")
        const input = parameters(records, "APP_GUARD_DAY", "10", {accountingDate: f.day})
        const refused = h.rejected("create#" + A, Object.assign({}, input, {accountingDate: tomorrow}))
        h.call("create#" + A, input)
        return {refused, good: application(input.paymentApplicationId)}
    },
    then({refused, good}) {
        refused.includes("APPLICATION_DATE_INVALID")
        helper().lib.policy.calendarDateText(good.accountingDate) == f.day
        good.acctgTransResultEnumId == "AtrPaymentNotPosted"
    }
})

feature("a UTC actor cannot bypass a hard lock on captured Chicago source days", {
    when() {
        const h = helper()
        h.call("update#moqui.security.UserAccount", {userId: f.users.ar, timeZone: "America/Chicago"})
        h.call("update#moqui.security.UserAccount", {userId: f.users.approve, timeZone: "UTC"})
        login(f.users.ar)
        const sourceTime = ec.l10n.parseTimestamp(f.day + " 23:30:00", "yyyy-MM-dd HH:mm:ss")
        const records = pair(f, "100", "60", {invoiceDate: sourceTime, accountingDate: f.day})
        login(f.users.approve)
        const input = parameters(records, "APP_GUARD_ZONE_OK", "5", {appliedDate: sourceTime, accountingDate: f.day})
        h.call("create#" + A, input)
        const visibleSourceDay = ec.l10n.format(sourceTime, "yyyy-MM-dd")
        const lockId = "APP_GUARD_ZONE_LOCK"
        let refused
        try {
            h.call("create#mantle.ledger.config.AccountingLock", {
                accountingLockId: lockId,
                organizationPartyId: f.org,
                lockScope: "sales",
                lockThroughDate: f.day,
                isHard: "Y",
                changeReason: "Captured source day is locked in every actor zone"
            })
            refused = h.rejected("create#" + A, Object.assign({}, input, {paymentApplicationId: "APP_GUARD_ZONE_BAD"}))
        } finally {
            h.call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: lockId})
        }
        return {refused, visibleSourceDay, good: application(input.paymentApplicationId)}
    },
    then({refused, visibleSourceDay, good}) {
        visibleSourceDay != f.day
        good.amountApplied == 5
        helper().lib.policy.calendarDateText(good.accountingDate) == f.day
        refused.includes("HARD_LOCK")
        !application("APP_GUARD_ZONE_BAD")
    }
})

feature("#writer cannot reactivate an unapplied row while a fresh application identity can consume the same balance", {
    where: [{writer: "update"}, {writer: "store"}, {writer: "createOrUpdate"}],
    when({writer}) {
        const h = helper(),
            records = pair()
        const suffix = writer === "createOrUpdate" ? "RAW" : writer.toUpperCase()
        const original = parameters(records, "APP_GUARD_REACTIVATE_" + suffix)
        h.call("create#" + A, original)
        h.call("update#" + A, {
            paymentApplicationId: original.paymentApplicationId,
            amountApplied: "0",
            amountOriginallyApplied: "10"
        })
        const before = counts(),
            restore = {paymentApplicationId: original.paymentApplicationId, amountApplied: "10"}
        const refused = writer === "createOrUpdate" ? rawUpsert(restore) : h.rejected(writer + "#" + A, restore)
        const afterRefusal = counts(),
            retained = helper().lib.map(application(original.paymentApplicationId))
        const fresh = parameters(records, "APP_GUARD_NEW_" + suffix)
        h.call("create#" + A, fresh)
        return {refused, before, afterRefusal, retained, fresh: application(fresh.paymentApplicationId)}
    },
    then({refused, before, afterRefusal, retained, fresh}) {
        refused.includes("APPLICATION_IMMUTABLE")
        retained.amountApplied == 0
        afterRefusal.applications == before.applications
        afterRefusal.transactions == before.transactions
        afterRefusal.audit == before.audit
        fresh.amountApplied == 10
        fresh.acctgTransResultEnumId == "AtrPaymentNotPosted"
    }
})

feature("a retained adopted application SQL day survives zero unapplication by another actor zone", {
    when() {
        const h = helper()
        h.call("update#moqui.security.UserAccount", {userId: f.users.ar, timeZone: "America/Chicago"})
        h.call("update#moqui.security.UserAccount", {userId: f.users.approve, timeZone: "UTC"})
        login(f.users.ar)
        const late = ec.l10n.parseTimestamp(f.day + " 23:30:00", "yyyy-MM-dd HH:mm:ss")
        const invoiceId = h.invoice(f, "100", "receivable", {invoiceDate: late, accountingDate: f.day})
        const paymentId = h.call("create#" + P, {
            fromPartyId: f.customer,
            toPartyId: f.org,
            paymentTypeEnumId: "PtInvoicePayment",
            amount: "60",
            amountUomId: "USD",
            statusId: "PmntDelivered",
            effectiveDate: late
        }).paymentId
        const input = parameters({invoiceId, paymentId}, "APP_GUARD_RETAINED_DAY", "10", {appliedDate: late})
        h.call("create#" + A, input)
        const captured = h.lib.map(application(input.paymentApplicationId))
        login(f.users.approve)
        const viewingDay = ec.l10n.format(late, "yyyy-MM-dd")
        h.call("update#" + A, {
            paymentApplicationId: input.paymentApplicationId,
            amountApplied: "0",
            amountOriginallyApplied: "10"
        })
        return {captured, zero: application(input.paymentApplicationId), viewingDay, payment: h.lib.one(P, {paymentId})}
    },
    then({captured, zero, viewingDay, payment}) {
        viewingDay != f.day
        helper().lib.policy.calendarDateText(captured.accountingDate) == f.day
        helper().lib.policy.calendarDateText(zero.accountingDate) == f.day
        helper().lib.ms(zero.appliedDate) == helper().lib.ms(captured.appliedDate)
        zero.amountApplied == 0
        payment.accountingDate == null
    }
})

feature("generic application refuses #kind ledger-day evidence even when no application journal would be needed", {
    where: [
        {kind: "source", reason: "APPLICATION_BEFORE_SOURCE_POSTING"},
        {kind: "target", reason: "APPLICATION_BEFORE_SOURCE_POSTING"},
        {kind: "missing target", reason: "POSTING_DATE_INVALID"}
    ],
    when({kind}) {
        const h = helper(),
            records = kind === "source" ? {invoiceId: h.invoice(f, "100")} : pair()
        if (kind === "source") records.paymentId = h.legacyDirectPayment(f, records.invoiceId, "10").paymentId
        const tx = h.lib
            .rows(T, kind === "source" ? {paymentId: records.paymentId} : {invoiceId: records.invoiceId})
            .find(
                row =>
                    !row.reverseOfAcctgTransId &&
                    (kind === "source"
                        ? ["AttPayment", "AttDisbursement", "AttReceipt", "AttIncomingPayment", "AttOutgoingPayment"].includes(
                              row.acctgTransTypeEnumId
                          )
                        : !row.paymentId)
            )
        assert(tx && tx.isPosted === "Y", "The case needs real original posted evidence")
        const original = h.lib.map(tx),
            tomorrow = ec.l10n.format(new Date(Number(f.timestamp) + 86400000), "yyyy-MM-dd")
        const input = parameters(
            records,
            "APP_GUARD_POSTDAY_" + (kind === "source" ? "SOURCE" : kind === "target" ? "TARGET" : "MISSING")
        )
        let refused, before, afterRefusal
        try {
            h.call("update#" + T, {
                acctgTransId: tx.acctgTransId,
                accountingDate: kind === "missing target" ? null : tomorrow,
                transactionDate: kind === "missing target" ? null : original.transactionDate
            })
            before = counts()
            refused = h.rejected("create#" + A, input)
            afterRefusal = counts()
        } finally {
            h.call("update#" + T, {
                acctgTransId: tx.acctgTransId,
                accountingDate: original.accountingDate,
                transactionDate: original.transactionDate
            })
        }
        h.call("create#" + A, input)
        return {refused, before, afterRefusal, good: application(input.paymentApplicationId)}
    },
    then({refused, before, afterRefusal, good, reason}) {
        refused.includes(reason)
        afterRefusal.applications == before.applications
        afterRefusal.transactions == before.transactions
        afterRefusal.audit == before.audit
        good.amountApplied == 10
        good.acctgTransResultEnumId == "AtrPaymentNotPosted"
    }
})

feature("a first cash posting cannot arrive after an already captured positive application day", {
    when() {
        const h = helper(),
            records = pair(),
            input = parameters(records, "APP_GUARD_FIRST_CASH")
        h.call("create#" + A, input)
        const tx = h.call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            organizationPartyId: f.org,
            paymentId: records.paymentId,
            amountUomId: "USD",
            acctgTransTypeEnumId: "AttIncomingPayment",
            transactionDate: Number(f.timestamp) + 86400000
        }).acctgTransId
        const cash = h.call("mantle.ledger.PaymentAutoPostServices.get#PaymentMethodGlAccount", {
            organizationPartyId: f.org,
            paymentId: records.paymentId
        }).glAccountId
        const unapplied = h.call("mantle.ledger.PaymentAutoPostServices.get#PaymentTypeGlAccount", {
            organizationPartyId: f.org,
            otherPartyId: f.customer,
            paymentTypeEnumId: "PtInvoicePayment",
            isApplied: "N",
            isPayable: "N"
        }).glAccountId
        assert(cash && unapplied, "The original cash posting needs actual cash and unapplied mappings")
        for (const [glAccountId, debitCreditFlag] of [
            [cash, "D"],
            [unapplied, "C"]
        ])
            h.call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId: tx,
                glAccountId,
                debitCreditFlag,
                amount: "60"
            })
        const preview = h.call("mantle.ledger.JournalServices.preview#Entry", {acctgTransId: tx})
        assert(preview.valid, "The negative must reach actual source-day validation through a valid reviewed journal")
        const before = counts()
        const refused = h.rejected("mantle.ledger.JournalServices.post#Entry", {
            acctgTransId: tx,
            previewId: preview.previewId,
            inputFingerprint: preview.inputFingerprint,
            operationKey: "app-guard-first-cash-late",
            changeReason: "Source day is too late"
        })
        const afterRefusal = counts(),
            unposted = h.lib.map(h.lib.one(T, {acctgTransId: tx}))
        h.call("update#" + T, {acctgTransId: tx, transactionDate: f.timestamp})
        h.repostReviewed(tx)
        h.call("mantle.ledger.PaymentAutoPostServices.post#PaymentApplication", {
            paymentApplicationId: input.paymentApplicationId
        })
        return {
            refused,
            before,
            afterRefusal,
            unposted,
            posted: h.lib.one(T, {acctgTransId: tx}),
            good: application(input.paymentApplicationId)
        }
    },
    then({refused, before, afterRefusal, unposted, posted, good}) {
        refused.includes("APPLICATION_BEFORE_SOURCE_POSTING")
        unposted.isPosted == "N"
        afterRefusal.transactions == before.transactions
        afterRefusal.applications == before.applications
        afterRefusal.audit == before.audit
        posted.isPosted == "Y"
        good.amountApplied == 10
        good.acctgTransResultEnumId == "AtrSuccess"
    }
})

feature("an undated legacy application unapplies by its real posting day without backfilling its nullable dates", {
    when() {
        const h = helper(),
            invoiceId = h.invoice(f, "100"),
            paymentId = h.payment(f, "60")
        const id = "APP_GUARD_NULL_HISTORY"
        try {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "N"
            })
            h.call("create#" + A, {paymentApplicationId: id, invoiceId, paymentId, amountApplied: "10"})
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y"
            })
        }
        const original = h.lib.map(application(id))
        const own = h.lib.rows(T, {paymentApplicationId: id}).find(tx => !tx.reverseOfAcctgTransId)
        assert(own && own.isPosted === "Y", "The old nullable application must have actual posted GL evidence")
        const actualDay = h.lib.policy.postingDay(own),
            period = currentPeriod()
        const input = {paymentApplicationId: id, amountApplied: "0", amountOriginallyApplied: "10"}
        let refused, before, afterRefusal, retained
        try {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
            before = counts()
            refused = h.rejected("update#" + A, input)
            retained = h.lib.map(application(id))
            afterRefusal = counts()
        } finally {
            h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: period.isClosed})
        }
        h.call("update#" + A, input)
        return {
            original,
            actualDay,
            refused,
            before,
            afterRefusal,
            retained,
            zero: application(id),
            reversed: h.lib.one(T, {acctgTransId: own.acctgTransId})
        }
    },
    then({original, actualDay, refused, before, afterRefusal, retained, zero, reversed}) {
        original.accountingDate == null
        original.appliedDate == null
        actualDay == f.day
        refused.includes("PERIOD_CLOSED")
        retained.amountApplied == 10
        retained.accountingDate == null
        retained.appliedDate == null
        afterRefusal.applications == before.applications
        afterRefusal.transactions == before.transactions
        afterRefusal.audit == before.audit
        zero.amountApplied == 0
        zero.accountingDate == null
        zero.appliedDate == null
        !!reversed.reversedByAcctgTransId
    }
})

feature("raw direct cash restores its entire original invoice while genuinely unapplied cash permits a partial application", {
    when() {
        const h = helper(),
            invoiceId = h.invoice(f, "100"),
            otherInvoiceId = h.invoice(f, "100"),
            direct = h.legacyDirectPayment(f, invoiceId, "60"),
            unappliedInvoiceId = h.invoice(f, "100"),
            unappliedPaymentId = h.payment(f, "60")
        const main = h.lib
            .rows(T, {paymentId: direct.paymentId})
            .find(tx =>
                ["AttPayment", "AttDisbursement", "AttReceipt", "AttIncomingPayment", "AttOutgoingPayment"].includes(
                    tx.acctgTransTypeEnumId
                )
            )
        assert(main && main.isPosted === "Y", "The direct fixture must retain its actual original cash posting")
        assert(main.invoiceId === invoiceId, "The retained cash must name its original invoice")
        assert(
            toDecimal(application(direct.originalApplicationId).amountApplied).isZero(),
            "The imported direct link must already be zero"
        )
        const original = JSON.stringify(h.lib.map(main)),
            before = counts()
        const partialRefusal = h.rejected(
            "create#" + A,
            parameters({invoiceId, paymentId: direct.paymentId}, "APP_GUARD_DIRECT_PARTIAL", "5")
        )
        const foreignTargetRefusal = h.rejected(
            "create#" + A,
            parameters({invoiceId: otherInvoiceId, paymentId: direct.paymentId}, "APP_GUARD_DIRECT_OTHER", "60")
        )
        const afterRefusal = counts(),
            retained = JSON.stringify(h.lib.map(h.lib.one(T, {acctgTransId: main.acctgTransId})))
        h.call("create#" + A, parameters({invoiceId, paymentId: direct.paymentId}, "APP_GUARD_DIRECT_FULL", "60"))
        h.call(
            "create#" + A,
            parameters({invoiceId: unappliedInvoiceId, paymentId: unappliedPaymentId}, "APP_GUARD_UNAPPLIED_PARTIAL", "5")
        )
        return {
            partialRefusal,
            foreignTargetRefusal,
            before,
            afterRefusal,
            original,
            retained,
            full: application("APP_GUARD_DIRECT_FULL"),
            fullTransactions: h.count(T, {paymentApplicationId: "APP_GUARD_DIRECT_FULL"}),
            partial: application("APP_GUARD_UNAPPLIED_PARTIAL"),
            partialTransactions: h.lib.rows(T, {paymentApplicationId: "APP_GUARD_UNAPPLIED_PARTIAL"}),
            directRemaining: h.lib.totals(h.lib.one(h.lib.invoiceEntity, {invoiceId})).unpaidTotal
        }
    },
    then({
        partialRefusal,
        foreignTargetRefusal,
        before,
        afterRefusal,
        original,
        retained,
        full,
        fullTransactions,
        partial,
        partialTransactions,
        directRemaining
    }) {
        partialRefusal.includes("DIRECT_PAYMENT_RESTORE_REQUIRED")
        foreignTargetRefusal.includes("DIRECT_PAYMENT_HISTORY_INCONSISTENT")
        JSON.stringify(afterRefusal) == JSON.stringify(before)
        retained == original
        full.amountApplied == 60
        full.acctgTransResultEnumId == "AtrPaymentNotPosted"
        fullTransactions == 0
        directRemaining == 40
        partial.amountApplied == 5
        partial.acctgTransResultEnumId == "AtrSuccess"
        partialTransactions.length == 1
        partialTransactions.every(tx => tx.isPosted === "Y")
    }
})

feature("an overstated imported #backing payment cannot fund a raw application beyond its actual cash evidence", {
    where: [{backing: "direct"}, {backing: "unapplied"}],
    when({backing}) {
        const h = helper(),
            invoiceId = h.invoice(f, "100"),
            paymentId = backing === "direct" ? h.legacyDirectPayment(f, invoiceId, "60").paymentId : h.payment(f, "60"),
            input = parameters({invoiceId, paymentId}, "APP_GUARD_BACKING_" + backing, backing === "direct" ? "60" : "5")
        const originalCash = JSON.stringify(h.lib.rows(T, {paymentId}).map(h.lib.map))
        let refusal, before, afterRefusal, retainedCash
        try {
            h.call("update#" + P, {paymentId, amount: "100"})
            before = counts()
            refusal = h.rejected("create#" + A, input)
            afterRefusal = counts()
            retainedCash = JSON.stringify(h.lib.rows(T, {paymentId}).map(h.lib.map))
        } finally {
            h.call("update#" + P, {paymentId, amount: "60"})
        }
        h.call("create#" + A, input)
        return {
            backing,
            refusal,
            before,
            afterRefusal,
            originalCash,
            retainedCash,
            input,
            good: application(input.paymentApplicationId),
            transactions: h.lib.rows(T, {paymentApplicationId: input.paymentApplicationId})
        }
    },
    then({backing, refusal, before, afterRefusal, originalCash, retainedCash, input, good, transactions}) {
        refusal.includes("SOURCE_POSTING_INCOMPLETE")
        JSON.stringify(afterRefusal) == JSON.stringify(before)
        retainedCash == originalCash
        good.amountApplied == input.amountApplied
        good.acctgTransResultEnumId == (backing === "direct" ? "AtrPaymentNotPosted" : "AtrSuccess")
        transactions.length == (backing === "direct" ? 0 : 1)
        transactions.every(tx => tx.isPosted === "Y")
    }
})

feature("unapplying undated November history keeps its reversal out of the invoice's October display day", {
    when() {
        const h = helper(),
            sourceTime = Date.UTC(2026, 10, 1, 4, 30),
            originalDay = "2026-11-01"
        const october = h.lib
            .rows("mantle.party.time.TimePeriod", {partyId: f.org, timePeriodTypeId: "FiscalMonth"})
            .find(row => h.lib.policy.calendarDateText(row.fromDate) === "2026-10-01")
        assert(october, "The standalone fixture requires its October fiscal month")
        h.call("mantle.party.TimeServices.getOrCreate#NextTimePeriod", {timePeriodId: october.timePeriodId})
        const november = h.lib
            .rows("mantle.party.time.TimePeriod", {partyId: f.org, timePeriodTypeId: "FiscalMonth"})
            .find(row => h.lib.policy.calendarDateText(row.fromDate) === originalDay)
        assert(november, "The legacy history proof requires a distinct November fiscal month")
        const preference = h.lib.policy.preference(f.org)
        const movement = id =>
            h.lib
                .rows("mantle.ledger.account.GlAccountOrgTimePeriod", {organizationPartyId: f.org, timePeriodId: id})
                .reduce((total, row) => total.add(row.postedDebits || 0), toDecimal(0))
        try {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                postingGuardEnabled: "N",
                settlementApplicationGuardEnabled: "N",
                realTimeGlSummary: "Y"
            })
            const invoiceId = h.invoice(f, "100", "receivable", {invoiceDate: sourceTime, accountingDate: "2026-10-31"})
            const paymentId = h.payment(f, "60", "receivable", {effectiveDate: sourceTime})
            const id = "APP_GUARD_UTC_HISTORY"
            h.call("create#" + A, {paymentApplicationId: id, invoiceId, paymentId, amountApplied: "10"})
            const original = h.lib.map(application(id)),
                own = h.lib.rows(T, {paymentApplicationId: id}).find(tx => !tx.reverseOfAcctgTransId)
            assert(own && own.isPosted === "Y", "The undated legacy application must have a real posted original")
            const beforeOct = movement(october.timePeriodId),
                beforeNov = movement(november.timePeriodId)
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                settlementApplicationGuardEnabled: "Y"
            })
            h.call("update#" + A, {paymentApplicationId: id, amountApplied: "0", amountOriginallyApplied: "10"})
            const after = h.lib.one(T, {acctgTransId: own.acctgTransId})
            return {
                original,
                own: h.lib.map(own),
                after: h.lib.map(after),
                reverse: h.lib.one(T, {acctgTransId: after.reversedByAcctgTransId}),
                zero: application(id),
                originalDay,
                sourceTime,
                octoberDelta: movement(october.timePeriodId).subtract(beforeOct),
                novemberDelta: movement(november.timePeriodId).subtract(beforeNov)
            }
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                postingGuardEnabled: preference.postingGuardEnabled,
                settlementApplicationGuardEnabled: preference.settlementApplicationGuardEnabled,
                realTimeGlSummary: preference.realTimeGlSummary || null
            })
        }
    },
    then({original, own, after, reverse, zero, originalDay, sourceTime, octoberDelta, novemberDelta}) {
        original.accountingDate == null
        original.appliedDate == null
        own.accountingDate == null
        after.accountingDate == null
        helper().lib.policy.postingDay(own) == originalDay
        reverse.isPosted == "Y"
        helper().lib.policy.postingDay(reverse) == originalDay
        helper().lib.ms(reverse.transactionDate) == sourceTime
        zero.accountingDate == null
        zero.appliedDate == null
        zero.amountApplied == 0
        octoberDelta == 0
        novemberDelta == 10
    }
})
