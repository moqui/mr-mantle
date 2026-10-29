const policy = () =>
    ec.resource.script(
        "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
    )
const org = "NATIVE_FIN_REPORTS"
const call = (name, p) =>
    policy().call(
        name.startsWith("mantle.") || name.includes("#mantle.")
            ? name
            : "mantle.ledger." + name,
        p,
    )
let today, thru
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {
            partyId: org,
            partyTypeEnumId: "PtyOrganization",
        })
        call("create#mantle.party.Organization", {
            partyId: org,
            organizationName: "Native reports",
        })
        call("create#mantle.party.PartyRole", {
            partyId: org,
            roleTypeId: "OrgInternal",
        })
        call("LedgerServices.init#PartyAccountingConfiguration", {
            sourcePartyId: "DefaultSettings",
            organizationPartyId: org,
            baseCurrencyUomId: "USD",
        })
        today = new Date(Number(ec.user.nowTimestamp) - 3600000).toISOString()
        thru = new Date(Number(ec.user.nowTimestamp) + 3600000).toISOString()
        for (const [amountUomId, amount] of [
            ["USD", 100],
            ["EUR", 50],
        ]) {
            const id = call("LedgerServices.create#AcctgTrans", {
                organizationPartyId: org,
                amountUomId,
                acctgTransTypeEnumId: "AttInternal",
            }).acctgTransId
            for (const [glAccountId, debitCreditFlag] of [
                ["111100000", "D"],
                ["331100000", "C"],
            ])
                call("LedgerServices.create#AcctgTransEntry", {
                    acctgTransId: id,
                    glAccountId,
                    debitCreditFlag,
                    amount,
                })
            call("LedgerServices.post#AcctgTrans", { acctgTransId: id })
        }
    },
})
feature("live trial balance and ledger never combine document currencies", {
    when() {
        return {
            trial: call("FinanceReportServices.run#TrialBalance", {
                organizationPartyId: org,
                fromDate: today,
                thruDate: thru,
            }),
            ledger: call("FinanceReportServices.run#GeneralLedger", {
                organizationPartyId: org,
                fromDate: today,
                thruDate: thru,
            }),
        }
    },
    then({ trial, ledger }) {
        trial.reportRows.length == 4
        ledger.reportRows.length == 4
        trial.reportRows
            .find((r) => r.glAccountId == "111100000" && r.amountUomId == "USD")
            .ending.eq(100)
        trial.reportRows
            .find((r) => r.glAccountId == "111100000" && r.amountUomId == "EUR")
            .ending.eq(50)
    },
})
feature(
    "comparison uses the same scoped calculation and preserves empty prior balances",
    {
        when() {
            return call("FinanceReportServices.run#TrialBalance", {
                organizationPartyId: org,
                fromDate: today,
                thruDate: thru,
                compareFromDate: "2000-01-01",
                compareThruDate: "2000-01-02",
            })
        },
        then({ reportRows }) {
            reportRows.length == 4
            reportRows.every(
                (r) => r.comparisonEnding.isZero() && r.change.eq(r.ending),
            )
        },
    },
)
feature("a closed fiscal month reads its stored base-currency summary", {
    when() {
        const period = policy()
            .rows("mantle.party.time.TimePeriod", {
                partyId: org,
                timePeriodTypeId: "FiscalMonth",
            })
            .find(
                (r) =>
                    policy().ms(r.fromDate) <= Number(ec.user.nowTimestamp) &&
                    policy().ms(r.thruDate) >= Number(ec.user.nowTimestamp),
            )
        const key = {
                organizationPartyId: org,
                glAccountId: "111100000",
                timePeriodId: period.timePeriodId,
            },
            old = policy().one(
                "mantle.ledger.account.GlAccountOrgTimePeriod",
                key,
            )
        call(
            (old ? "update#" : "create#") +
                "mantle.ledger.account.GlAccountOrgTimePeriod",
            Object.assign({}, key, {
                beginningBalance: 0,
                postedDebits: 999,
                postedCredits: 0,
                endingBalance: 999,
            }),
        )
        call("update#mantle.party.time.TimePeriod", {
            timePeriodId: period.timePeriodId,
            isClosed: "Y",
        })
        const result = call("FinanceReportServices.run#TrialBalance", {
            organizationPartyId: org,
            glAccountId: "111100000",
            amountUomId: "USD",
            timePeriodId: period.timePeriodId,
        })
        call("update#mantle.party.time.TimePeriod", {
            timePeriodId: period.timePeriodId,
            isClosed: "N",
        })
        return result
    },
    then({ reportRows }) {
        reportRows.length == 1
        reportRows[0].closedSummary == true
        reportRows[0].ending.eq(999)
    },
})
