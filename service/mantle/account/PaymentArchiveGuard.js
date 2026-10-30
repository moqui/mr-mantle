// Protect the actual issued bytes and resource identity, including generic and artifact-off resource writers.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const NODE = "moqui.resource.DbResource",
    FILE = "moqui.resource.DbResourceFile",
    HISTORY = "moqui.resource.DbResourceFileHistory"
const root = "mantle/content/payment-issued"
function protectedPath(path) {
    return path === root || path.startsWith(root + "/")
}
function nodePath(id, replacement = null) {
    const parts = [],
        seen = new Set()
    while (id) {
        if (seen.has(id) || seen.size >= 128) lib.denied("PAYMENT_ARCHIVE_PATH_INVALID", "The resource ancestry is invalid")
        seen.add(id)
        const row = replacement?.resourceId === id ? replacement : lib.one(NODE, {resourceId: id})
        if (!row) return ""
        parts.unshift(String(row.filename || ""))
        id = row.parentResourceId
    }
    return parts.join("/")
}
function archiveExists() {
    let parent = null
    for (const filename of root.split("/")) {
        const node = lib.one(NODE, {parentResourceId: parent, filename})
        if (!node) return false
        parent = node.resourceId
    }
    return true
}
function lockAncestors() {
    let parent = null
    for (const filename of ["mantle", "content"]) {
        const node = lib.find(NODE, {parentResourceId: parent, filename}).forUpdate(true).one()
        if (!node) return false
        parent = node.resourceId
    }
    return true
}
function prepare() {
    if (
        !/mantle\.account\.PaymentServices\.(change#PaymentState|unapply#ReviewedPayment)(?:\b|$)/.test(
            ec.artifactExecution.getStackNameString()
        )
    )
        lib.denied("ISSUED_PAYMENT_IMMUTABLE", "Issued payment archives can only be created by a reviewed payment operation")
    // A first issuance and an ordinary move of its existing ancestors serialize on the same stable nodes.
    if (!lockAncestors())
        lib.denied("PAYMENT_ARCHIVE_PATH_INVALID", "The issued archive parent changed; retry the payment review")
}
function issuer(path) {
    prepare()
    const paymentId = path.slice(root.length + 1).split("/")[0]
    if (paymentId) {
        const scope = ec.resource
            .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
            .paymentScope({paymentId}, true)
        if (scope.record.lifecycleManaged !== "Y")
            lib.denied("PAYMENT_ARCHIVE_PATH_INVALID", "An issued archive requires a reviewed payment")
    }
}
function guard(p, kind) {
    const input = lib.map(p.entityValue || p)
    if (
        kind === "node" &&
        ["update", "delete"].includes(p.eecaOperation) &&
        ["mantle", "mantle/content"].includes(nodePath(input.resourceId))
    )
        lockAncestors()
    const values = lib.map(p.entityValue || p),
        entity = kind === "node" ? NODE : kind === "file" ? FILE : HISTORY,
        key =
            kind === "history"
                ? {resourceId: values.resourceId, versionName: values.versionName}
                : {resourceId: values.resourceId},
        original = p.originalValue ? lib.map(p.originalValue) : values.resourceId ? lib.one(entity, key) : null,
        candidate = Object.assign({}, lib.map(original), values),
        beforePath = nodePath(candidate.resourceId),
        afterPath = kind === "node" ? nodePath(candidate.resourceId, candidate) : beforePath
    if (kind === "node") {
        const ancestor = [beforePath, afterPath].some(path => path && root.startsWith(path + "/")) && archiveExists()
        if (!protectedPath(beforePath) && !protectedPath(afterPath) && !ancestor) return
        if (p.eecaOperation === "create" && !original && protectedPath(afterPath)) {
            issuer(afterPath)
            return
        }
        const identityChanged = ["filename", "parentResourceId", "isFile"].some(
            field => String(original?.[field] ?? "") !== String(candidate[field] ?? "")
        )
        if (p.eecaOperation === "update" && !identityChanged) return
    } else {
        if (!protectedPath(beforePath)) return
        if (p.eecaOperation === "create" && !original) {
            issuer(beforePath)
            if (kind === "file") return
            const file = lib.one(FILE, {resourceId: candidate.resourceId})
            if (
                candidate.versionName === "01" &&
                !candidate.previousVersionName &&
                !candidate.fileData &&
                !candidate.blobId &&
                file?.versionName === "01" &&
                !lib.find(HISTORY, {resourceId: candidate.resourceId}).count()
            )
                return
        }
    }
    lib.denied("ISSUED_PAYMENT_IMMUTABLE", "Issued payment bytes, versions and archive paths cannot be changed or removed")
}
function guardBlob(p, kind) {
    const values = lib.map(p.entityValue || p),
        entity = kind === "blob" ? "moqui.resource.ContentBlob" : "moqui.resource.ContentBlobChunk",
        key = kind === "blob" ? {blobId: values.blobId} : {storageKey: values.storageKey, chunkSeq: values.chunkSeq},
        persisted = () => lib.find(entity, key).useCache(false).one()
    if (p.eecaOperation === "create" && !persisted()) {
        // Blob uploads publish new identities in independent transactions while issuance holds the parent locks.
        // An unpublished upload has no archive reference; existing published storage must still serialize below.
        if (kind === "blob") return
        if (!lib.find("moqui.resource.ContentBlob", {storageKey: values.storageKey}).useCache(false).count()) return
    }
    // A first archive reference may still be uncommitted. Wait for the issuer before checking its visibility.
    lockAncestors()
    const original = persisted(),
        candidate = Object.assign({}, lib.map(original), values),
        ids =
            kind === "blob"
                ? [candidate.blobId, original?.blobId].filter(Boolean)
                : Array.from(
                      lib
                          .find("moqui.resource.ContentBlob")
                          .condition("storageKey", "in", [
                              ...new Set([candidate.storageKey, original?.storageKey].filter(Boolean))
                          ])
                          .selectField("blobId")
                          .list()
                  ).map(row => row.blobId)
    if (!ids.length) return
    for (const referenceEntity of [FILE, HISTORY]) {
        const references = lib
            .find(referenceEntity)
            .condition("blobId", "in", ids)
            .selectField("resourceId")
            .distinct(true)
            .list()
        for (const reference of references) {
            if (!protectedPath(nodePath(reference.resourceId))) continue
            // Content-addressed deduplication may freshen a blob's stamp; its storage identity and bytes stay fixed.
            const fields = ["blobSize", "storageKind", "storageKey", "chunkSize", "chunkCount", "createdDate"]
            if (
                kind === "blob" &&
                p.eecaOperation === "update" &&
                fields.every(field => String(original?.[field] ?? "") === String(candidate[field] ?? ""))
            )
                return
            lib.denied("ISSUED_PAYMENT_IMMUTABLE", "The content blob of an issued payment archive cannot change or be removed")
        }
    }
}
;({prepare, guard, guardBlob})
