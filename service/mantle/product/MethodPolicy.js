// Shared Manufacturing method policy. Organization membership and grants are checked even for internal callbacks.
const find = (n, p = {}) => ec.entity.find(n).condition(p).disableAuthz(),
    one = (n, p) => find(n, p).one(),
    rows = (n, p) => Array.from(find(n, p).list())
const call = (n, p = {}) => {
    const out = ec.service.sync().name(n).parameters(p).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const map = r => (r?.getMap ? r.getMap() : Object.assign({}, r || {})),
    ms = v => (v == null || v === "" ? null : Number.isFinite(Number(String(v))) ? Number(String(v)) : Date.parse(String(v))),
    iso = v => new Date(ms(v)).toISOString()
const active = (r, date) => (ms(r.fromDate) ?? -Infinity) <= ms(date) && (ms(r.thruDate) ?? Infinity) > ms(date)
const pick = (p, fields) =>
    Object.fromEntries(fields.filter(k => Object.keys(p).includes(k)).map(k => [k, p[k] === "" ? null : p[k]]))
function capabilities() {
    const access = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js"),
        has = access.has
    return {
        systemAdmin: access.systemAdmin(),
        read: ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"].some(has),
        edit: has("METHOD_EDIT"),
        approve: has("METHOD_APPROVE"),
        resources: has("METHOD_RESOURCES"),
        costRead: [
            "PRODUCT_COST_VIEW",
            "PRODUCT_COST_ESTIMATE",
            "PRODUCT_COST_APPROVE",
            "ACCOUNTING_VIEW",
            "ACCOUNTING_GL_POST"
        ].some(has),
        costWrite: ["PRODUCT_COST_ESTIMATE", "PRODUCT_COST_APPROVE", "METHOD_COST_EDIT"].some(has),
        costApprove: ["PRODUCT_COST_APPROVE", "METHOD_COST_APPROVE"].some(has)
    }
}

function scope(p = {}, need = "read") {
    if (!["read", "edit", "approve", "resources", "costRead", "costWrite", "costApprove"].includes(need))
        throw new Error("Unknown method capability")
    const a = capabilities()
    if (!a.read || !a[need]) throw new Error("Manufacturing " + need + " authority is required")
    const s = call("mantle.product.ProductServices.get#CatalogOwnerScope"),
        organizationPartyId = p.organizationPartyId || s.activeOrganizationPartyId || s.organizationPartyIds[0]
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        (!a.systemAdmin && !s.ownerPartyIds.includes(organizationPartyId))
    )
        throw new Error("Method organization is not available")
    return Object.assign(a, s, {organizationPartyId})
}
function product(id, s) {
    const r = one("mantle.product.Product", {productId: id})
    if (!r || (!s.systemAdmin && !s.ownerPartyIds.includes(r.ownerPartyId || "_NA_")))
        throw new Error("Method product is not available")
    return r
}
function party(id, s) {
    const r = one("mantle.party.Party", {partyId: id})
    if (
        !r ||
        (r.privateOwnerUserId && r.privateOwnerUserId !== ec.user.userId) ||
        (!s.systemAdmin && !s.ownerPartyIds.includes(r.ownerPartyId) && !s.organizationPartyIds.includes(id))
    )
        throw new Error("Method counterparty is not available")
    return r
}
function facility(id, s) {
    const r = one("mantle.facility.Facility", {facilityId: id})
    if (!r || r.ownerPartyId !== s.organizationPartyId) throw new Error("Work center facility is not in the method organization")
    return r
}
function reason(p) {
    const r = String(p.changeReason || "").trim()
    if (!r || r.length > 255) throw new Error("Give a change reason of 1–255 characters")
    return r
}
function audit(fields, why) {
    ec.context.putAll(Object.fromEntries(fields.map(k => [k + "_changeReason", why])))
}
function unit(id) {
    const r = one("moqui.basic.Uom", {uomId: id})
    if (!r || r.uomTypeEnumId === "UT_CURRENCY_MEASURE") throw new Error("Choose a quantity or duration unit")
    return r
}
function convert(amount, from, to, date) {
    if (!from || !to) throw new Error("A quantity unit is required")
    unit(from)
    unit(to)
    const seconds = {TF_ms: "0.001", TF_s: 1, TF_min: 60, TF_hr: 3600, TF_day: 86400}
    if (seconds[from] && seconds[to])
        return {
            quantity: toDecimal(amount).multiply(seconds[from]).divide(seconds[to]),
            factor: toDecimal(seconds[from]).divide(seconds[to]),
            uomConversionId: null
        }
    if (from === to) return {quantity: toDecimal(amount), factor: toDecimal(1), uomConversionId: null}
    const a = one("moqui.basic.Uom", {uomId: from}),
        b = one("moqui.basic.Uom", {uomId: to})
    if (a.uomTypeEnumId !== b.uomTypeEnumId) throw new Error("Incompatible units " + from + " and " + to)
    let reverse = false,
        r = rows("moqui.basic.UomConversion", {uomId: from, toUomId: to})
            .filter(r => active(r, date))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    if (!r) {
        reverse = true
        r = rows("moqui.basic.UomConversion", {uomId: to, toUomId: from})
            .filter(r => active(r, date))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    }
    if (
        !r ||
        r.conversionFactor == null ||
        toDecimal(r.conversionFactor).compare(0) <= 0 ||
        (r.conversionOffset != null && !toDecimal(r.conversionOffset).isZero())
    )
        throw new Error("Missing linear conversion from " + from + " to " + to)
    const factor = reverse ? toDecimal(1).divide(r.conversionFactor) : toDecimal(r.conversionFactor)
    return {quantity: toDecimal(amount).multiply(factor), factor, uomConversionId: r.uomConversionId}
}
// Approval evidence stores audit IDs, never copies of method values. This also disambiguates changes in the same millisecond.
function capture(entity, id, fields, secondary) {
    const refs = Object.fromEntries(fields.map(k => [k, null])),
        logs = Array.from(
            find("moqui.entity.EntityAuditLog", {changedEntityName: entity, pkPrimaryValue: id})
                .condition("changedFieldName", "in", fields)
                .list()
        ).sort(
            (a, b) =>
                ms(a.changedDate) - ms(b.changedDate) ||
                String(a.auditHistorySeqId).padStart(40, "0").localeCompare(String(b.auditHistorySeqId).padStart(40, "0"))
        )
    for (const r of logs)
        if (secondary === undefined || r.pkSecondaryValue === secondary) refs[r.changedFieldName] = r.auditHistorySeqId
    return refs
}
function atAudit(entity, id, fields, refs, secondary) {
    const out = {}
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(refs || {}, field))
            throw new Error("Missing method approval evidence for " + field)
        const ref = refs[field]
        if (!ref) {
            out[field] = null
            continue
        }
        const row = one("moqui.entity.EntityAuditLog", {auditHistorySeqId: ref})
        if (
            !row ||
            row.changedEntityName !== entity ||
            row.pkPrimaryValue !== id ||
            row.changedFieldName !== field ||
            (secondary !== undefined && row.pkSecondaryValue !== secondary)
        )
            throw new Error("Method approval audit evidence is unavailable")
        out[field] = row.newValueText
    }
    return out
}

// Existing WorkEffort fields keep their legacy audit policy. Method-only writes add the same audit facts explicitly.
function recordAudit(entity, keys, fields, before, after, why) {
    const keyFields = Object.keys(ec.entity.makeValue(entity).getPrimaryKeys()),
        primary = keys[keyFields[0]],
        secondary = keyFields[1] ? keys[keyFields[1]] : null,
        rest =
            keyFields
                .slice(2)
                .map(k => k + ":'" + (k.endsWith("Date") ? ms(keys[k]) : String(keys[k])) + "'")
                .join(",") || null
    for (const field of fields) {
        const old = before?.[field],
            value = after?.[field]
        if (String(old ?? "") === String(value ?? "")) continue
        call("create#moqui.entity.EntityAuditLog", {
            changedEntityName: entity,
            changedFieldName: field,
            pkPrimaryValue: String(primary),
            pkSecondaryValue: secondary == null ? null : String(secondary),
            pkRestCombinedValue: rest,
            oldValueText: old == null ? null : String(old),
            newValueText: value == null ? null : String(value),
            changedDate: ec.user.nowTimestamp,
            changedByUserId: ec.user.userId,
            changeReason: why
        })
    }
}
function fingerprint(value) {
    return ec.user.singleUseCodeHash(JSON.stringify(value))
}
function execute(op, p) {
    if (op === "capabilities") return capabilities()
    if (op === "scope") return scope(p, p.need || "read")
    throw new Error("Unknown method policy operation")
}
;({
    execute,
    scope,
    capabilities,
    product,
    party,
    facility,
    reason,
    audit,
    recordAudit,
    unit,
    convert,
    capture,
    atAudit,
    fingerprint,
    find,
    one,
    rows,
    call,
    map,
    ms,
    iso,
    active,
    pick
})
