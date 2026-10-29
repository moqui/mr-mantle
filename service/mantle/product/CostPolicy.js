// Standard-estimate capabilities are independent of method, supplier-price and GL mutation grants.
const helper = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const find = (n, p = {}) => helper().find(n, p),
    one = (n, p) => helper().one(n, p),
    rows = (n, p) => helper().rows(n, p),
    call = (n, p = {}) => helper().call(n, p),
    map = r => helper().map(r),
    ms = v => helper().ms(v),
    iso = v => helper().iso(v),
    active = (r, d) => helper().active(r, d),
    pick = (p, f) => helper().pick(p, f)
function capabilities() {
    const access = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js"),
        has = access.has
    return {
        systemAdmin: access.systemAdmin(),
        read: [
            "PRODUCT_COST_VIEW",
            "PRODUCT_COST_ESTIMATE",
            "PRODUCT_COST_APPROVE",
            "ACCOUNTING_VIEW",
            "ACCOUNTING_GL_POST"
        ].some(has),
        edit: has("PRODUCT_COST_ESTIMATE"),
        approve: has("PRODUCT_COST_APPROVE"),
        glPost: has("ACCOUNTING_GL_POST"),
        financeRead: ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST"].some(has),
        supplierRead: ["SUPPLIER_PRICE_VIEW", "SUPPLIER_PRICE_EDIT"].some(has),
        methodRead: helper().capabilities().read,
        priceRead: ["PRICE_VIEW", "PRICE_EDIT"].some(has)
    }
}

function scope(p = {}, need = "read") {
    const a = capabilities()
    if (!["read", "edit", "approve", "glPost"].includes(need) || !a[need])
        throw new Error("Standard-cost " + need + " authority is required")
    const s = call("mantle.product.ProductServices.get#CatalogOwnerScope"),
        organizationPartyId = p.organizationPartyId || s.activeOrganizationPartyId || s.organizationPartyIds[0]
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        (!a.systemAdmin && !s.ownerPartyIds.includes(organizationPartyId))
    )
        throw new Error("Cost organization is not available")
    const out = Object.assign({}, s, a, {organizationPartyId})
    if (p.productId) helper().product(p.productId, out)
    if (p.facilityId) helper().facility(p.facilityId, out)
    return out
}
function currency(id) {
    const r = one("moqui.basic.Uom", {uomId: id})
    if (!r || r.uomTypeEnumId !== "UT_CURRENCY_MEASURE") throw new Error("Choose a cost currency")
    return r
}
function convertCurrency(amount, from, to, date) {
    currency(from)
    currency(to)
    if (from === to) return {amount: toDecimal(amount), factor: toDecimal(1), uomConversionId: null, source: null}
    let reverse = false,
        row = rows("moqui.basic.UomConversion", {uomId: from, toUomId: to})
            .filter(r => active(r, date))
            .sort(
                (a, b) => ms(b.fromDate) - ms(a.fromDate) || String(b.uomConversionId).localeCompare(String(a.uomConversionId))
            )[0]
    if (!row) {
        reverse = true
        row = rows("moqui.basic.UomConversion", {uomId: to, toUomId: from})
            .filter(r => active(r, date))
            .sort(
                (a, b) => ms(b.fromDate) - ms(a.fromDate) || String(b.uomConversionId).localeCompare(String(a.uomConversionId))
            )[0]
    }
    if (
        !row ||
        row.conversionFactor == null ||
        toDecimal(row.conversionFactor).compare(0) <= 0 ||
        (row.conversionOffset != null && !toDecimal(row.conversionOffset).isZero())
    )
        throw new Error("Missing currency conversion from " + from + " to " + to)
    return {
        amount: reverse ? toDecimal(amount).divide(row.conversionFactor) : toDecimal(amount).multiply(row.conversionFactor),
        factor: reverse ? toDecimal(1).divide(row.conversionFactor) : toDecimal(row.conversionFactor),
        uomConversionId: row.uomConversionId,
        source: map(row)
    }
}
const reason = p => helper().reason(p),
    audit = (f, r) => helper().audit(f, r),
    fingerprint = p => helper().fingerprint(p),
    unit = id => helper().unit(id),
    convert = (q, a, b, d) => helper().convert(q, a, b, d),
    product = (id, s) => helper().product(id, s),
    facility = (id, s) => helper().facility(id, s)
function execute(op, p) {
    if (op === "capabilities") return capabilities()
    if (op === "scope") return scope(p, p.need || "read")
    throw new Error("Unknown cost-policy operation")
}
;({
    execute,
    capabilities,
    scope,
    currency,
    convertCurrency,
    reason,
    audit,
    fingerprint,
    unit,
    convert,
    product,
    facility,
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
