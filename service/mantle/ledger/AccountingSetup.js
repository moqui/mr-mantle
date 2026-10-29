const lib=ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find}=lib
function readiness(p) {
    const s = lib.scope(p),
        findings = []
    if (!s.organizationPartyId)
        return {
            findings: [
                {
                    code: "ORGANIZATION",
                    message: "Choose an organization to check accounting setup",
                },
            ],
        }
    const org = s.organizationPartyId
    for (const [name, check] of [
        [
            "PREFERENCES",
            () => {
                const pref = lib.preference(org)
                if (!pref.baseCurrencyUomId)
                    throw new Error("Choose a base currency")
                if (!pref.errorGlJournalId)
                    throw new Error("Choose an error journal")
            },
        ],
        [
            "PERIODS",
            () => {
                if (
                    !find("mantle.party.time.TimePeriod")
                        .condition("partyId", "in", lib.organizationChain(org))
                        .count()
                )
                    throw new Error("Generate fiscal periods")
            },
        ],
        [
            "CHART",
            () => {
                if (
                    !find("mantle.ledger.account.GlAccountOrganization")
                        .condition(
                            "organizationPartyId",
                            "in",
                            lib.organizationChain(org),
                        )
                        .count()
                )
                    throw new Error("Assign a chart of accounts")
            },
        ],
    ]) {
        try {
            check()
        } catch (error) {
            ec.logger.error(
                "Accounting readiness " + name + ": " + error.message,
            )
            findings.push({ code: name, message: error.message })
        }
    }
    return { findings }
}

;({execute:(op,p)=>{if(op!=="readiness")throw new Error("Unknown setup operation");return readiness(p)}})
