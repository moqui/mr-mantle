const lib = ec.resource.script(
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
)
function create(p) {
    const tx = lib.record(
        { kind: "journals", recordId: p.acctgTransId },
        "glPost",
        false,
    )
    if (p.contentTypeEnumId) {
        const type = lib.one("moqui.basic.Enumeration", {
            enumId: p.contentTypeEnumId,
        })
        if (type?.enumTypeId !== "AcctgTransContentType")
            throw new Error("Choose a journal attachment type")
    }
    const out = lib.call("create#mantle.ledger.transaction.AcctgTransContent", {
        acctgTransId: tx.acctgTransId,
        contentTypeEnumId: p.contentTypeEnumId,
        contentDate: ec.user.nowTimestamp,
        description: p.description,
        userId: ec.user.userId,
    })
    if (p.contentFile && Number(p.contentFile.size) > 0)
        save(Object.assign({}, p, out))
    return out
}
function save(p) {
    const content = lib.one("mantle.ledger.transaction.AcctgTransContent", {
        acctgTransContentId: p.acctgTransContentId,
    })
    if (!content || content.acctgTransId !== p.acctgTransId)
        throw new Error("Journal attachment is not available")
    lib.record(
        { kind: "journals", recordId: content.acctgTransId },
        "glPost",
        false,
    )
    if (!p.contentFile || Number(p.contentFile.size) <= 0)
        throw new Error("Choose a nonempty attachment")
    const name = String(p.contentFile.getName()).split(/[\\/]/).pop()
    if (!name || [".", ".."].includes(name) || name.includes("\u0000"))
        throw new Error("Invalid attachment filename")
    const contentLocation =
        "dbresource://mantle/content/journal/" +
        content.acctgTransId +
        "/content_" +
        content.acctgTransContentId +
        "/" +
        name
    const stream = p.contentFile.getInputStream()
    try {
        ec.resource.getLocationReference(contentLocation).putStream(stream)
    } finally {
        stream.close()
    }
    lib.call("update#mantle.ledger.transaction.AcctgTransContent", {
        acctgTransContentId: content.acctgTransContentId,
        contentLocation,
    })
    return { contentLocation }
}
const operations = { create, save }
;({
    execute: (op, p) => {
        if (!operations[op])
            throw new Error("Unknown journal content operation")
        return operations[op](p)
    },
})
