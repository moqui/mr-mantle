// mantle.product.AssetServices.get#ProductStockTotals: one product's stock at one facility for one owner, from its own
// assets and reservations. New spec, no Groovy original.
const facilityId = "ZIRET_WH",
    ownerPartyId = "ORG_ZIZI_RETAIL",
    productId = "PST_PRODUCT"

spec({
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

feature("totals separate held and available-status stock and net out reservations", {
    when() {
        call("create#mantle.product.Product", {productId, productName: "Stock totals sample", productTypeEnumId: "PtAsset"})
        const asset = (assetId, statusId, quantity) =>
            call("create#mantle.product.asset.Asset", {
                assetId,
                productId,
                facilityId,
                ownerPartyId,
                statusId,
                assetTypeEnumId: "AstTpInventory",
                quantityOnHandTotal: quantity,
                availableToPromiseTotal: statusId === "AstAvailable" ? quantity : 0
            })
        asset("PST_AVAILABLE", "AstAvailable", 10)
        asset("PST_HELD", "AstQuarantine", 3)
        call("create#mantle.product.issuance.AssetReservation", {
            assetReservationId: "PST_RESERVED",
            assetId: "PST_AVAILABLE",
            productId,
            quantity: 4,
            quantityNotIssued: 4,
            quantityNotAvailable: 1
        })
        return call("mantle.product.AssetServices.get#ProductStockTotals", {productId, facilityId, ownerPartyId})
    },
    then(totals) {
        toDecimal(totals.quantityOnHandTotal).compare(13) == 0
        toDecimal(totals.heldQuantity).compare(3) == 0
        toDecimal(totals.availableStatusQuantity).compare(10) == 0
        toDecimal(totals.reservedQuantity).compare(3) == 0
        totals.availableToPromiseTotal != null
    }
})
