const lib = ec.resource.script(
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
)
function account(p) {
    const s = lib.organization(p, "glPost"),
        why = lib.reason(p)
    lib.find("mantle.party.Party", { partyId: s.organizationPartyId })
        .forUpdate(true)
        .one()
    const old = p.glAccountId
        ? lib.one("mantle.ledger.account.GlAccount", {
              glAccountId: p.glAccountId,
          })
        : null
    if (old) {
        lib.record(
            {
                kind: "accounts",
                recordId: p.glAccountId,
                organizationPartyId: s.organizationPartyId,
            },
            "glPost",
            true,
        )
        lib.revision(old, p.lastUpdatedStamp)
        if (
            !s.capabilities.admin &&
            lib
                .find("mantle.ledger.account.GlAccountOrganization", {
                    glAccountId: old.glAccountId,
                })
                .count() > 1
        )
            throw new Error(
                "Changing a shared chart account requires finance administration",
            )
    }
    const values = lib.pick(p, [
        "accountCode",
        "accountName",
        "parentGlAccountId",
        "glAccountClassEnumId",
        "glAccountTypeEnumId",
        "description",
        "disallowPosting",
    ])
    if (
        !p.accountName ||
        !/^\d+$/.test(p.accountCode || old?.accountCode || "")
    )
        throw new Error("Give an account name and digits-only code")
    if (values.parentGlAccountId) {
        lib.record({kind:"accounts",recordId:values.parentGlAccountId,organizationPartyId:s.organizationPartyId})
        const visited = new Set([p.glAccountId])
        let id = values.parentGlAccountId
        while (id) {
            if (visited.has(id))
                throw new Error("Account hierarchy would contain a cycle")
            visited.add(id)
            const parent = lib.one("mantle.ledger.account.GlAccount", {
                glAccountId: id,
            })
            if (!parent) throw new Error("Parent account is not available")
            id = parent.parentGlAccountId
        }
    }
    if (
        old &&
        lib
            .find("mantle.ledger.transaction.AcctgTransAndEntry", {
                glAccountId: old.glAccountId,
                isPosted: "Y",
            })
            .count() &&
        ["glAccountClassEnumId", "glAccountTypeEnumId"].some(
            (f) => values[f] !== undefined && values[f] !== old[f],
        )
    )
        throw new Error("Account meaning cannot change after posting")
    lib.audit(Object.keys(values), why)
    const out = lib.call(
        old
            ? "update#mantle.ledger.account.GlAccount"
            : "mantle.ledger.LedgerServices.create#GlAccount",
        Object.assign(values, old ? { glAccountId: old.glAccountId } : {}),
    )
    const glAccountId = old?.glAccountId || out.glAccountId
    lib.call("mantle.ledger.LedgerServices.set#GlAccountFlags", { glAccountId })
    if (!old)
        lib.call("create#mantle.ledger.account.GlAccountOrganization", {
            glAccountId,
            organizationPartyId: s.organizationPartyId,
            fromDate: ec.user.nowTimestamp,
        })
    return { glAccountId }
}
function assignment(p) {
    const s = lib.organization(p, "glPost"),
        why = lib.reason(p)
    lib.find("mantle.party.Party", { partyId: s.organizationPartyId })
        .forUpdate(true)
        .one()
    if (
        !lib.one("mantle.ledger.account.GlAccount", {
            glAccountId: p.glAccountId,
        })
    )
        throw new Error("Account is not available")
    const key = {
        glAccountId: p.glAccountId,
        organizationPartyId: s.organizationPartyId,
    }
    const old = lib
        .find("mantle.ledger.account.GlAccountOrganization", key)
        .forUpdate(true)
        .one()
    if (old) lib.revision(old, p.lastUpdatedStamp)
    if (p.fromDate && p.thruDate && lib.ms(p.fromDate) >= lib.ms(p.thruDate))
        throw new Error("Account assignment end must follow start")
    const values = lib.pick(p, [
        "fromDate",
        "thruDate",
        "facilityRequired",
        "costCenterRequired",
    ])
    lib.audit(Object.keys(values), why)
    lib.call(
        (old ? "update#" : "create#") +
            "mantle.ledger.account.GlAccountOrganization",
        Object.assign(key, values),
    )
    return { glAccountId: p.glAccountId }
}
function periods(p) {
    const s = lib.organization(p, "glPost")
    lib.call("mantle.ledger.LedgerServices.check#NextFiscalTimePeriods", {
        organizationPartyId: s.organizationPartyId,
        basisDate: p.basisDate,
    })
    return { complete: true }
}
function classifications(p) {
    lib.record({
        kind: "accounts",
        recordId: p.glAccountId,
        organizationPartyId: p.organizationPartyId,
    })
    return {
        categoryRows: Array.from(
            lib
                .find("mantle.ledger.account.GlAccountCategoryMember", {
                    glAccountId: p.glAccountId,
                })
                .orderBy("-fromDate")
                .limit(100)
                .list(),
        ).map(lib.map),
        groupRows: lib
            .rows("mantle.ledger.account.GlAccountGroupMember", {
                glAccountId: p.glAccountId,
            })
            .map(lib.map),
    }
}
function classification(p) {
    lib.organization(p, "admin")
    lib.record({
        kind: "accounts",
        recordId: p.glAccountId,
        organizationPartyId: p.organizationPartyId,
    })
    const why = lib.reason(p)
    lib.audit(["fromDate", "thruDate", "glAccountGroupId"], why)
    if (p.glAccountCategoryId) {
        if (
            !lib.one("mantle.ledger.account.GlAccountCategory", {
                glAccountCategoryId: p.glAccountCategoryId,
            })
        )
            throw new Error("Choose an account category")
        const from = p.fromDate || ec.user.nowTimestamp
        for (const row of lib.rows(
            "mantle.ledger.account.GlAccountCategoryMember",
            {
                glAccountId: p.glAccountId,
                glAccountCategoryId: p.glAccountCategoryId,
            },
        )) {
            if (lib.active(row, from)) {
                if (lib.ms(row.fromDate) >= lib.ms(from))
                    throw new Error("Choose a later category effective date")
                lib.call(
                    "update#mantle.ledger.account.GlAccountCategoryMember",
                    {
                        glAccountId: p.glAccountId,
                        glAccountCategoryId: p.glAccountCategoryId,
                        fromDate: row.fromDate,
                        thruDate: from,
                    },
                )
            }
        }
        lib.audit(["fromDate", "thruDate"], why)
        lib.call("create#mantle.ledger.account.GlAccountCategoryMember", {
            glAccountId: p.glAccountId,
            glAccountCategoryId: p.glAccountCategoryId,
            fromDate: from,
            thruDate: p.thruDate,
        })
    } else if (p.glAccountGroupId) {
        const group = lib.one("mantle.ledger.account.GlAccountGroup", {
            glAccountGroupId: p.glAccountGroupId,
        })
        if (!group) throw new Error("Choose an account group")
        const key = {
            glAccountId: p.glAccountId,
            groupTypeEnumId: group.groupTypeEnumId,
        }
        const old = lib.one("mantle.ledger.account.GlAccountGroupMember", key)
        if (old) lib.revision(old, p.lastUpdatedStamp)
        lib.audit(["glAccountGroupId"], why)
        lib.call(
            (old ? "update#" : "create#") +
                "mantle.ledger.account.GlAccountGroupMember",
            Object.assign(key, { glAccountGroupId: group.glAccountGroupId }),
        )
    } else throw new Error("Choose a category or group")
    return { glAccountId: p.glAccountId }
}
const operations = {
    classifications,
    classification,
    account,
    assignment,
    periods,
}
;({
    execute: (op, p) => {
        if (!operations[op])
            throw new Error("Unknown ledger configuration operation")
        return operations[op](p)
    },
})
