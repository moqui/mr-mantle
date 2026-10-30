// Issued documents are reached through native Payment output/Files authority, never a general drive or public link.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const root = "dbresource://mantle/content/payment-issued"
function location(driveId, path = "") {
    const drive = lib.one("moqui.resource.ResourceDrive", {driveId})
    if (!drive?.rootLocation?.startsWith("dbresource:")) return ""
    const base =
            "dbresource://" +
            String(drive.rootLocation)
                .replace(/^dbresource:(?:\/\/)?/, "")
                .split("/")
                .filter(Boolean)
                .join("/"),
        suffix = String(path || "")
            .split("/")
            .filter(part => part && part !== ".")
            .join("/")
    return base + (suffix ? "/" + suffix : "")
}
function privateLocation(value) {
    return value === root || value.startsWith(root + "/")
}
function overlaps(value) {
    return !!value && (privateLocation(value) || root.startsWith(value + "/"))
}
function access(p) {
    if (!privateLocation(location(p.driveId, p.path))) return
    Object.assign(p.results, {
        level: 0,
        permissionEnumId: null,
        canWrite: false,
        canUpload: false,
        viaShareId: null,
        drive: null,
        recordList: []
    })
}
function recursive(p) {
    const paths = p.pathList ? Array.from(p.pathList) : [p.path || ""]
    if (paths.some(path => overlaps(location(p.driveId, path))))
        lib.denied("PAYMENT_ARCHIVE_PRIVATE", "Use the payment's authorized issued document to read this archive")
}
function listing(p, key) {
    const rows = Array.from(p.results?.[key] || [])
    p.results[key] = rows.filter(row => !privateLocation(location(row.driveId || p.driveId, row.path)))
}
function search(p) {
    p.parameters.excludeLocationPrefixList = [...new Set([...Array.from(p.excludeLocationPrefixList || []), root])]
}
function publicToken(p) {
    if (!p.results?.valid) return
    const shares = Array.from(
        lib
            .find("moqui.resource.ResourceShare", {linkTokenHash: ec.user.singleUseCodeHash(String(p.token)), isLink: "Y"})
            .limit(2)
            .list()
    )
    if (shares.length === 1 && overlaps(location(shares[0].driveId, shares[0].path)))
        Object.assign(p.results, {valid: false, routeContext: null})
}
;({access, recursive, listing, search, publicToken})
