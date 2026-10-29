const lib=ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {call,pick,ms,one}=lib
const transaction=(p,lock=true)=>lib.record({kind:"journals",recordId:p.acctgTransId,organizationPartyId:p.organizationPartyId},"glPost",lock)
function draft(p) {
    const s = lib.organization(p, "glPost")
    const old = p.acctgTransId ? transaction(p) : null
    if (old?.isPosted === "Y") throw new Error("Posted entries are read only")
    if (old) lib.revision(old, p.lastUpdatedStamp)
    const amountUomId =
        p.amountUomId ||
        old?.amountUomId ||
        lib.preference(s.organizationPartyId).baseCurrencyUomId
    lib.currency(amountUomId)
    const values = Object.assign(
        pick(p, [
            "description",
            "transactionDate",
            "acctgTransTypeEnumId",
            "glJournalId",
            "otherPartyId",
            "workEffortId",
        ]),
        { organizationPartyId: s.organizationPartyId, amountUomId },
    )
    if (values.glJournalId)
        lib.record({
            kind: "batches",
            recordId: values.glJournalId,
            organizationPartyId: s.organizationPartyId,
        })
    values.transactionDate =
        p.transactionDate || old?.transactionDate || ec.user.nowTimestamp
    if (!Number.isFinite(ms(values.transactionDate)))
        throw new Error("Choose a transaction date")
    if (!values.acctgTransTypeEnumId)
        values.acctgTransTypeEnumId = old?.acctgTransTypeEnumId || "AttInternal"
    lib.counterparty(values.otherPartyId)
    if (
        values.workEffortId &&
        one("mantle.work.effort.WorkEffort", {
            workEffortId: values.workEffortId,
        })?.ownerPartyId !== s.organizationPartyId
    )
        throw new Error("Project is outside the posting organization")
    if (old) values.acctgTransId = old.acctgTransId
    if (!values.acctgTransTypeEnumId && !old)
        values.acctgTransTypeEnumId = "AttInternal"
    return call(
        "mantle.ledger.LedgerServices." +
            (old ? "update#AcctgTrans" : "create#AcctgTrans"),
        values,
    )
}

;({execute:(op,p)=>{if(op!=="draft")throw new Error("Unknown journal operation");return draft(p)}})
