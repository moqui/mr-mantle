// Selected invoice files are reviewed by opaque content versions, then copied into the durable delivery archive.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, denied} = lib
const C = "mantle.account.invoice.InvoiceContent"
const D = "mantle.account.invoice.InvoiceDelivery"
const maxAttachmentCount = 10,
    maxAttachmentBytes = 10485760,
    maxTotalAttachmentBytes = 20971520
// Match DbResource's db_parts: both prefixes and empty slash-separated segments name the same resource.
function canonicalDbLocation(value) {
    const location = String(value || "")
    if (!location.startsWith("dbresource:")) return location
    const rest = location.startsWith("dbresource://")
        ? location.slice("dbresource://".length)
        : location.slice("dbresource:".length)
    return "dbresource://" + rest.split("/").filter(Boolean).join("/")
}
function selection(p, strict = true) {
    if (strict && p.attachmentContentIdList != null && typeof p.attachmentContentIdList === "string")
        denied("ATTACHMENT_SELECTION_INVALID", "Choose invoice attachment identifiers")
    const ids = [
        ...new Set(
            (typeof p.attachmentContentIdList === "string"
                ? [p.attachmentContentIdList]
                : Array.from(p.attachmentContentIdList || [])
            ).map(String)
        )
    ].sort()
    if (strict && ids.length > maxAttachmentCount) denied("ATTACHMENT_COUNT_LIMIT", "Select at most ten supporting attachments")
    if (strict && ids.some(id => !/^[A-Za-z0-9_-]{1,40}$/.test(id)))
        denied("ATTACHMENT_UNAVAILABLE", "An attachment is not available")
    const versions = Object.fromEntries(ids.map(id => [id, String(p.attachmentVersions?.[id] || "")]))
    if (strict && ids.some(id => !versions[id])) denied("STALE_ATTACHMENT", "Review each selected attachment before sending")
    return {ids, versions}
}
function source(row) {
    const location = canonicalDbLocation(row.contentLocation)
    const roots = [
        ...new Set(
            [
                "dbresource://mantle/content",
                ec.user.getPreference("mantle.content.root"),
                ec.user.getPreference("mantle.content.large.root")
            ]
                .filter(root => root && String(root).startsWith("dbresource:"))
                .map(root => canonicalDbLocation(root).replace(/\/+$/, ""))
        )
    ]
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(row.invoiceId) || !/^[A-Za-z0-9_-]{1,40}$/.test(row.invoiceContentId))
        denied("ATTACHMENT_LOCATION_INVALID", "The attachment is not a supported local invoice file")
    const prefix = roots.find(root =>
        location.startsWith(root + "/invoice/" + row.invoiceId + "/content_" + row.invoiceContentId + "/")
    )
    const relative = prefix ? location.slice(prefix.length + 1) : ""
    if (
        !prefix ||
        /[\\?#\x00-\x1f]|%2e|%2f|%5c/i.test(location) ||
        location
            .slice("dbresource://".length)
            .split("/")
            .some(part => !part || part === "." || part === "..") ||
        relative.split("/").length !== 4
    )
        denied("ATTACHMENT_LOCATION_INVALID", "The attachment is not a supported local invoice file")
    if (one("mantle.account.invoice.InvoiceDelivery", {invoiceContentId: row.invoiceContentId}))
        denied("ATTACHMENT_ARCHIVED_INVOICE", "A previous issued invoice cannot be a supporting attachment")
    const ref = ec.resource.getLocationReference(location)
    if (!ref.getExists() || !ref.isFile()) denied("ATTACHMENT_UNAVAILABLE", "The selected attachment file is missing")
    const size = Number(ref.getSize())
    if (!Number.isSafeInteger(size) || size < 0 || size > maxAttachmentBytes)
        denied("ATTACHMENT_SIZE_LIMIT", "Each supporting attachment must be at most 10 MiB")
    const fileName = String(ref.getFileName())
        .replace(/[\\/:?*"<>\x00-\x1f\x7f]/g, "_")
        .slice(0, 180)
    return {ref, fileName, contentType: ref.getContentType() || "application/octet-stream", contentSize: size}
}
function read(row, metadata, byteBudget) {
    const stream = metadata.ref.getInputStream()
    if (!stream) denied("ATTACHMENT_UNAVAILABLE", "The selected attachment file is missing")
    try {
        const size = Number(stream.size)
        if (!Number.isSafeInteger(size) || size < 0 || size > maxAttachmentBytes || size > byteBudget)
            denied("ATTACHMENT_TOTAL_SIZE_LIMIT", "Supporting attachments must total at most 20 MiB")
        const bytes = stream.readAllBytes()
        if (bytes.length !== size || size !== metadata.contentSize)
            denied("STALE_ATTACHMENT", "An attachment changed; review it before sending")
        const contentHash = lib.hash(StringUtilities.base64Encode(bytes))
        const attachmentVersion = lib.hash({
            invoiceContentId: row.invoiceContentId,
            lastUpdatedStamp: String(row.lastUpdatedStamp),
            location: row.contentLocation,
            fileName: metadata.fileName,
            contentType: metadata.contentType,
            size,
            contentHash
        })
        return {bytes, contentHash, attachmentVersion}
    } finally {
        stream.close()
    }
}
function project(scope, contentRows = null) {
    const records =
        contentRows ||
        Array.from(find(C, {invoiceId: scope.record.invoiceId}).orderBy("-contentDate,invoiceContentId").limit(101).list())
    const attachmentRows = [],
        annotations = {}
    let remaining = maxTotalAttachmentBytes,
        incomplete = records.length > 100
    for (const row of records.slice(0, 100)) {
        try {
            const metadata = source(row)
            if (metadata.contentSize > remaining) {
                incomplete = true
                annotations[row.invoiceContentId] = {attachable: false, attachmentReasonCode: "ATTACHMENT_DISCOVERY_LIMIT"}
                continue
            }
            const reviewed = read(row, metadata, remaining)
            remaining -= metadata.contentSize
            const option = {
                invoiceContentId: row.invoiceContentId,
                fileName: metadata.fileName,
                contentType: metadata.contentType,
                contentSize: metadata.contentSize,
                attachmentVersion: reviewed.attachmentVersion,
                description: row.description,
                contentDate: row.contentDate,
                contentDateText: lib.policy.dateText(row.contentDate),
                attachable: true
            }
            attachmentRows.push(option)
            annotations[row.invoiceContentId] = option
        } catch (error) {
            const reasonCode = String(error.message).split(":")[0]
            annotations[row.invoiceContentId] = {attachable: false, attachmentReasonCode: reasonCode}
            const message = "Invoice attachment " + row.invoiceContentId + " is unavailable for delivery: " + error.message
            if (
                [
                    "ATTACHMENT_LOCATION_INVALID",
                    "ATTACHMENT_ARCHIVED_INVOICE",
                    "ATTACHMENT_UNAVAILABLE",
                    "ATTACHMENT_SIZE_LIMIT",
                    "ATTACHMENT_TOTAL_SIZE_LIMIT",
                    "STALE_ATTACHMENT"
                ].includes(reasonCode)
            )
                ec.logger.warn(message)
            else ec.logger.error(message)
        }
    }
    return {attachmentRows, annotations, incomplete, maxAttachmentCount, maxAttachmentBytes, maxTotalAttachmentBytes}
}
function options(p) {
    const scope = lib.writeInvoice(p, false)
    if (!scope.receivable) denied("INVOICE_DIRECTION_INVALID", "Only customer invoice attachments are sent here")
    if (p.attachmentContentIdList?.length) {
        const ids = Array.from(p.attachmentContentIdList).map(String)
        if (ids.length > 100) denied("ATTACHMENT_COUNT_LIMIT", "Review at most one hundred attachment identifiers")
        return project(
            scope,
            Array.from(
                find(C, {invoiceId: scope.record.invoiceId})
                    .condition("invoiceContentId", "in", ids)
                    .orderBy("-contentDate,invoiceContentId")
                    .limit(101)
                    .list()
            )
        )
    }
    return project(scope)
}
function freeze(scope, selected, deliveryId) {
    if (!selected.ids.length) return []
    const records = Array.from(
        find(C, {invoiceId: scope.record.invoiceId})
            .condition("invoiceContentId", "in", selected.ids)
            .orderBy("invoiceContentId")
            .forUpdate(true)
            .list()
    )
    if (records.length !== selected.ids.length)
        denied("ATTACHMENT_UNAVAILABLE", "A selected attachment does not belong to this invoice")
    const manifest = []
    let remaining = maxTotalAttachmentBytes
    for (const row of records) {
        const metadata = source(row),
            reviewed = read(row, metadata, remaining)
        if (reviewed.attachmentVersion !== selected.versions[row.invoiceContentId])
            denied("STALE_ATTACHMENT", "An attachment changed; review it before sending")
        remaining -= metadata.contentSize
        const attachmentLocation =
            "dbresource://mantle/content/invoice-issued/" +
            scope.record.invoiceId +
            "/" +
            deliveryId +
            "/attachments/" +
            row.invoiceContentId +
            "/" +
            metadata.fileName
        ec.resource.getLocationReference(attachmentLocation).putBytes(reviewed.bytes)
        manifest.push({
            invoiceContentId: row.invoiceContentId,
            fileName: metadata.fileName,
            contentType: metadata.contentType,
            contentSize: metadata.contentSize,
            attachmentVersion: reviewed.attachmentVersion,
            contentHash: reviewed.contentHash,
            attachmentLocation
        })
    }
    return manifest
}
function issuedReference(row) {
    if (!row) return null
    if (row.invoiceContentId) {
        const delivery = one(D, {invoiceContentId: row.invoiceContentId})
        if (delivery) return delivery
    }
    if (row.contentLocation) {
        const location = canonicalDbLocation(row.contentLocation)
        const delivery = one(D, {contentLocation: location})
        if (delivery) return delivery
        const privatePath = /^dbresource:\/\/mantle\/content\/invoice-issued\/([^/]+)\/([^/]+)\//.exec(location)
        if (privatePath) return one(D, {invoiceId: privatePath[1], deliveryId: privatePath[2]})
    }
    return null
}
function assertMutableContent(p) {
    const row = find(C, {invoiceContentId: p.invoiceContentId}).forUpdate(true).one()
    if (issuedReference(row)) denied("ISSUED_INVOICE_IMMUTABLE", "An issued invoice file cannot be replaced or removed")
}
function guardContent(p) {
    const updates = lib.map(p.entityValue || p)
    const original = p.originalValue ? lib.map(p.originalValue) : one(C, {invoiceContentId: updates.invoiceContentId})
    const candidate = Object.assign({}, lib.map(original), updates)
    if (!issuedReference(original) && !issuedReference(candidate)) return
    if (["create", "delete"].includes(p.eecaOperation))
        denied("ISSUED_INVOICE_IMMUTABLE", "Issued invoice evidence cannot be removed or linked as a mutable file")
    for (const field of ["invoiceContentId", "invoiceId", "contentLocation", "contentDate", "userId", "isImmutable"]) {
        const before = original?.[field],
            after = candidate[field]
        if (field === "contentDate" ? lib.ms(before) !== lib.ms(after) : String(before ?? "") !== String(after ?? ""))
            denied("ISSUED_INVOICE_IMMUTABLE", "An issued invoice file's identity cannot be changed")
    }
}
function manifestInfo(delivery) {
    try {
        return (JSON.parse(delivery.sourceJson || "{}").attachmentManifest || []).map(row =>
            lib.policy.pick(row, [
                "invoiceContentId",
                "fileName",
                "contentType",
                "contentSize",
                "contentHash",
                "attachmentVersion"
            ])
        )
    } catch (error) {
        ec.logger.error("Invoice delivery " + delivery.deliveryId + " attachment manifest: " + error.message)
        return []
    }
}
;({selection, project, options, freeze, manifestInfo, assertMutableContent, guardContent})
