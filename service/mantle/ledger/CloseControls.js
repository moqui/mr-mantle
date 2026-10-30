const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const L = "mantle.ledger.config.AccountingLock",
    X = "mantle.ledger.config.AccountingLockException"
function lock(p) {
    const s = lib.organization(p, "admin"),
        why = lib.reason(p)
    if (!["all", "sales", "purchases", "tax"].includes(p.lockScope) || !Number.isFinite(lib.ms(p.lockThroughDate)))
        throw new Error("Choose a lock scope and date")
    lib.find("mantle.party.Party", {partyId: s.organizationPartyId}).forUpdate(true).one()
    const old = p.accountingLockId ? lib.find(L, {accountingLockId: p.accountingLockId}).forUpdate(true).one() : null
    if (p.accountingLockId && (!old || old.organizationPartyId !== s.organizationPartyId))
        throw new Error("Posting lock is not available")
    if (old) {
        lib.revision(old, p.lastUpdatedStamp)
        if (
            old.isHard === "Y" &&
            (p.isHard !== "Y" || old.lockScope !== p.lockScope || lib.ms(p.lockThroughDate) < lib.ms(old.lockThroughDate))
        )
            throw new Error("A hard lock cannot be relaxed")
    }
    const values = {
        organizationPartyId: s.organizationPartyId,
        lockScope: p.lockScope,
        lockThroughDate: p.lockThroughDate,
        isHard: p.isHard === "Y" ? "Y" : "N",
        changeReason: why,
        changedByUserId: ec.user.userId
    }
    lib.audit(Object.keys(values), why)
    const out = lib.call(
        (old ? "update#" : "create#") + L,
        Object.assign(values, old ? {accountingLockId: old.accountingLockId} : {})
    )
    return {accountingLockId: old?.accountingLockId || out.accountingLockId}
}
function exception(p) {
    const s = lib.organization(p, "admin"),
        why = lib.reason(p)
    lib.find("mantle.party.Party", {partyId: s.organizationPartyId}).forUpdate(true).one()
    const row = lib.find(L, {accountingLockId: p.accountingLockId}).forUpdate(true).one()
    if (!row || row.organizationPartyId !== s.organizationPartyId || row.isHard === "Y")
        throw new Error("Choose a soft lock in this organization")
    if (!!p.userId === !!p.userGroupId || !p.thruDate || lib.ms(p.thruDate) <= lib.ms(ec.user.nowTimestamp))
        throw new Error("Choose one user or group and a future expiry")
    if (
        (p.userId && !lib.one("moqui.security.UserAccount", {userId: p.userId})) ||
        (p.userGroupId &&
            !lib.one("moqui.security.UserGroup", {
                userGroupId: p.userGroupId
            }))
    )
        throw new Error("Exception actor is not available")
    if (p.acctgTransId)
        lib.record({
            kind: "journals",
            recordId: p.acctgTransId,
            organizationPartyId: s.organizationPartyId
        })
    return lib.call("create#" + X, {
        accountingLockId: row.accountingLockId,
        organizationPartyId: s.organizationPartyId,
        userId: p.userId,
        userGroupId: p.userGroupId,
        acctgTransId: p.acctgTransId,
        lockScope: row.lockScope,
        fromDate: ec.user.nowTimestamp,
        thruDate: p.thruDate,
        changeReason: why,
        approvedByUserId: ec.user.userId
    })
}
;({
    execute: (op, p) => {
        const operations = {lock, exception}
        if (!operations[op]) throw new Error("Unknown lock operation")
        return operations[op](p)
    }
})
