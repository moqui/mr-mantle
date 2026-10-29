// Forward inventory revaluation. No historical receipt, issue or ledger transaction is reposted.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CostPolicy.js")
const A = "mantle.product.asset.Asset",
    DETAIL = "mantle.product.asset.AssetDetail",
    EVENT = "mantle.product.asset.AssetBookEvent"
const one = (n, p) => policy().one(n, p),
    rows = (n, p) => policy().rows(n, p),
    find = (n, p) => policy().find(n, p),
    call = (n, p) => policy().call(n, p),
    map = r => policy().map(r),
    ms = v => policy().ms(v)
function at(asset, date) {
    let unitCost = asset.acquireCost,
        amountUomId = asset.acquireCostUomId
    // Business effective dates, rather than the time an accountant entered the decision, define the forward cost.
    const changes = rows(EVENT, {assetId: asset.assetId})
        .filter(r => ms(r.eventDate) > ms(date))
        .sort((a, b) => ms(b.eventDate) - ms(a.eventDate))
    for (const change of changes) {
        unitCost = change.previousUnitCost
        amountUomId = change.unitCostUomId || change.amountUomId
    }
    return {unitCost, amountUomId}
}
function split(asset, date) {
    const quantity = toDecimal(asset.quantityOnHandTotal || 0),
        issued = rows("mantle.product.issuance.AssetIssuance", {assetId: asset.assetId}).length > 0
    if (!issued) return {assetId: asset.assetId, sourceAssetId: asset.assetId, split: false}
    const details = rows(DETAIL, {assetId: asset.assetId}),
        total = details.reduce((sum, r) => sum.add(r.quantityOnHandDiff || 0), toDecimal(0))
    if (total.compare(quantity) !== 0)
        throw new Error("Cannot split asset " + asset.assetId + ": movement facts do not match on-hand quantity")
    const reservations = rows("mantle.product.issuance.AssetReservation", {assetId: asset.assetId}).filter(
            r => toDecimal(r.quantityNotIssued || 0).compare(0) > 0
        ),
        reserved = reservations.reduce((sum, r) => sum.add(r.quantityNotIssued), toDecimal(0)),
        atp = toDecimal(asset.availableToPromiseTotal || 0),
        data = map(asset)
    delete data.assetId
    delete data.lastUpdatedStamp
    Object.assign(data, {
        quantityOnHandTotal: 0,
        availableToPromiseTotal: 0,
        originalQuantity: String(quantity),
        receivedDate: date
    })
    const created = call("create#" + A, data),
        newId = created.assetId
    // Retain an asset-specific inventory mapping so later issues hit the account revalued here.
    for (const row of rows("mantle.ledger.config.AssetTypeGlAccount", {assetId: asset.assetId})) {
        const mapping = map(row)
        delete mapping.assetTypeGlAccountId
        delete mapping.lastUpdatedStamp
        mapping.assetId = newId
        call("create#mantle.ledger.config.AssetTypeGlAccount", mapping)
    }
    call("create#" + DETAIL, {
        assetId: newId,
        productId: asset.productId,
        otherAssetId: asset.assetId,
        effectiveDate: date,
        quantityOnHandDiff: String(quantity),
        availableToPromiseDiff: String(atp.add(reserved))
    })
    for (const row of reservations)
        call("mantle.product.AssetServices.move#AssetReservation", {
            assetId: newId,
            assetReservationId: row.assetReservationId,
            quantity: row.quantityNotIssued
        })
    call("create#" + DETAIL, {
        assetId: asset.assetId,
        productId: asset.productId,
        otherAssetId: newId,
        effectiveDate: date,
        quantityOnHandDiff: String(quantity.negate()),
        availableToPromiseDiff: String(atp.add(reserved).negate())
    })
    return {assetId: newId, sourceAssetId: asset.assetId, split: true}
}
function apply(assetId, unitCost, why) {
    const asset = find(A, {assetId}).forUpdate(true).one()
    if (!asset || asset.assetTypeEnumId !== "AstTpInventory" || toDecimal(asset.quantityOnHandTotal || 0).compare(0) <= 0)
        throw new Error("Revalue only owned on-hand inventory")
    if (unitCost == null || toDecimal(unitCost).compare(0) < 0) throw new Error("Forward inventory cost must be zero or positive")
    policy().audit(["acquireCost"], why)
    asset.acquireCost = unitCost
    asset.update()
}
;({at, split, apply})
