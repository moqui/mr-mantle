// Reviewed bulk price changes (mantle.product.PriceServices preview#, apply# and get#PriceChanges). A preview pins
// each selected price row (its stamp and state) and the new amount in a ProductCatalogOperation; applying replaces each
// pinned row with a dated successor in its own transaction, so one failure leaves the others, and a retry skips the
// rows already replaced. PricePolicy checks every row: readable product and counterparties, the organization and the
// edit permission of the row's direction.
const P = "mantle.product.",
    E = P + "ProductPrice",
    M = P + "PriceServices.",
    OPERATION = P + "ProductCatalogOperation",
    ITEM = P + "ProductCatalogOperationItem"
const pricePolicy = ec.resource.script("component://mr-mantle/service/mantle/product/PricePolicy.js")
const find = (n, p) =>
    ec.entity
        .find(n)
        .condition(p || {})
        .disableAuthz()
const one = (n, p) => find(n, p).one()
const rows = (n, p) => Array.from(find(n, p).list())
const ms = v => (v == null || v === "" ? null : Number.isFinite(Number(String(v))) ? Number(String(v)) : Date.parse(String(v)))
const call = (name, p, newTransaction = false) => {
    let caller = ec.service
        .sync()
        .name(name)
        .parameters(p || {})
        .disableAuthz()
    if (newTransaction) caller = caller.requireNewTransaction(true)
    const out = caller.call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const ids = value => [
    ...new Set(
        (Array.isArray(value) ? value : [value || ""])
            .flatMap(item => String(item).split(","))
            .map(item => item.trim())
            .filter(Boolean)
    )
]
const has = permission => ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js").has(permission)
const editPermission = direction => (direction === "purchase" ? "SUPPLIER_PRICE_EDIT" : "PRICE_EDIT")
// A price row the user may change: PricePolicy's write check.
function editableRow(productPriceId) {
    const row = one(E, {productPriceId})
    if (!row) throw new Error("Price record is not available")
    pricePolicy.execute("writeAccess", row.getMap())
    return row
}
// The effective rows of a product that match the requested scope, as PricePolicy lets the user read them.
function scopedRows(productId, p) {
    return pricePolicy
        .execute("findPrices", {productId, direction: p.direction, priceTypeEnumId: p.priceTypeEnumId, includeHistory: false})
        .productPriceList.filter(
            row =>
                (!p.organizationPartyId ||
                    row.vendorPartyId === p.organizationPartyId ||
                    row.customerPartyId === p.organizationPartyId) &&
                (!p.priceUomId || row.priceUomId === p.priceUomId) &&
                (!p.pricePurposeEnumId || row.pricePurposeEnumId === p.pricePurposeEnumId) &&
                (!p.vendorPartyId || row.vendorPartyId === p.vendorPartyId) &&
                (!p.customerPartyId || row.customerPartyId === p.customerPartyId) &&
                (!p.productStoreId || row.productStoreId === p.productStoreId) &&
                (!p.agreementId || row.agreementId === p.agreementId)
        )
        .slice(0, 100)
}
function previewChanges(p) {
    const scope = call(P + "ProductServices.get#CatalogOwnerScope"),
        org = p.organizationPartyId || scope.activeOrganizationPartyId || scope.organizationPartyIds[0],
        direction = p.direction || "sales"
    if (!["sales", "purchase"].includes(direction)) throw new Error("Choose a sales or supplier direction")
    if (
        !org ||
        (!scope.systemAdmin && !scope.ownerPartyIds.includes(org)) ||
        !(scope.systemAdmin || has(editPermission(direction)))
    )
        throw new Error("Price editor authority in the selected organization is required")
    if (!p.effectiveDate || ms(p.effectiveDate) < ms(ec.user.nowTimestamp))
        throw new Error("Choose an effective date now or later")
    if (!String(p.changeReason || "").trim()) throw new Error("Give a reason for the reviewed change")
    let selected = ids(p.productPriceIds)
    const results = []
    if (!selected.length)
        for (const productId of ids(p.productIds)) {
            let found = []
            try {
                found = scopedRows(productId, Object.assign({}, p, {organizationPartyId: org, direction}))
            } catch (e) {
                ec.logger.error("Price-change preview product " + productId + " failed: " + e)
            }
            selected.push(...found.map(row => row.productPriceId))
            if (!found.length)
                results.push({productId, result: "failed", error: "No readable effective price matches this product and scope"})
        }
    selected = ids(selected)
    if ((!selected.length && !results.length) || selected.length > 1000) throw new Error("Select between 1 and 1000 price rows")
    const operationKey = p.operationKey || ec.user.randomString(32)
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(operationKey) || one(OPERATION, {operationKey})) throw new Error("Use a new operation key")
    const plan = []
    for (const productPriceId of selected) {
        try {
            const old = editableRow(productPriceId),
                rowDirection = pricePolicy.execute("direction", old),
                rowOrg = rowDirection === "purchase" ? old.customerPartyId : old.vendorPartyId
            if ((rowDirection !== "public" && rowDirection !== direction) || rowOrg !== org)
                throw new Error("Price row is outside the reviewed scope")
            for (const field of [
                "priceTypeEnumId",
                "pricePurposeEnumId",
                "priceUomId",
                "productStoreId",
                "agreementId",
                "vendorPartyId",
                "customerPartyId"
            ])
                if (p[field] && p[field] !== old[field]) throw new Error("Price row does not match the reviewed " + field)
            const amount =
                p.fixedPrice != null
                    ? toDecimal(p.fixedPrice)
                    : toDecimal(old.price)
                          .multiply(toDecimal(1).add(toDecimal(p.percentChange || 0).divide(100)))
                          .add(p.amountChange || 0)
            // the new price in the currency's precision
            const price = ec.l10n.roundCurrency(amount, old.priceUomId)
            if (price.compare(0) < 0) throw new Error("Resulting price cannot be negative")
            plan.push({
                productPriceId,
                productId: old.productId,
                expectedLastUpdatedStamp: old.lastUpdatedStamp,
                expectedState: ec.user.singleUseCodeHash(JSON.stringify(old.getMap())),
                effectiveDate: p.effectiveDate,
                price: String(price),
                beforePrice: String(old.price),
                priceUomId: old.priceUomId,
                minQuantity: old.minQuantity == null ? null : String(old.minQuantity),
                changeReason: p.changeReason
            })
            results.push({
                productPriceId,
                productId: old.productId,
                productName: one(P + "Product", {productId: old.productId})?.productName,
                priceUomId: old.priceUomId,
                minQuantity: old.minQuantity,
                vendorPartyId: old.vendorPartyId,
                customerPartyId: old.customerPartyId,
                productStoreId: old.productStoreId,
                agreementId: old.agreementId,
                beforePrice: old.price,
                afterPrice: price,
                result: "ready"
            })
        } catch (e) {
            ec.logger.error("Price-change preview row " + productPriceId + " failed: " + e)
            results.push({productPriceId, result: "failed", error: String(e.message || e)})
        }
    }
    const previewToken = ec.user.singleUseCodeHash(JSON.stringify(plan))
    call("create#" + OPERATION, {
        operationKey,
        operationType: "price-change",
        ownerPartyId: org,
        submittedByUserId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestJson: JSON.stringify({
            organizationPartyId: org,
            direction,
            previewToken,
            changeReason: p.changeReason,
            previewFailures: results.filter(row => row.result === "failed")
        })
    })
    plan.forEach((request, itemSeqId) =>
        call("create#" + ITEM, {operationKey, itemSeqId, itemKey: request.productPriceId, requestJson: JSON.stringify(request)})
    )
    return {operationKey, previewToken, previewRows: results, readyCount: plan.length, failedCount: results.length - plan.length}
}
// A price-change operation of the user's organizations and direction grant.
function operation(p) {
    const scope = call(P + "ProductServices.get#CatalogOwnerScope"),
        op = one(OPERATION, {operationKey: p.operationKey})
    if (!op || op.operationType !== "price-change") throw new Error("Price-change operation is not available")
    const request = JSON.parse(op.requestJson)
    if (
        (!scope.systemAdmin && !scope.ownerPartyIds.includes(op.ownerPartyId)) ||
        !(scope.systemAdmin || has(editPermission(request.direction)))
    )
        throw new Error("Price-change operation is not available")
    return {op, request}
}
function applyItem(p) {
    operation(p)
    const item = find(ITEM, {operationKey: p.operationKey, itemSeqId: p.itemSeqId}).forUpdate(true).one()
    if (!item) throw new Error("Price-change item is not available")
    if (item.result === "created") return {}
    const request = JSON.parse(item.requestJson)
    editableRow(request.productPriceId)
    const changed = call(M + "replace#ProductPrice", request)
    call("update#" + ITEM, {
        operationKey: p.operationKey,
        itemSeqId: p.itemSeqId,
        result: "created",
        resultRecordId: changed.productPriceId,
        resultEntityName: E,
        errorMessage: null,
        completedDate: ec.user.nowTimestamp
    })
    return {}
}
function failItem(p) {
    operation(p)
    const item = find(ITEM, {operationKey: p.operationKey, itemSeqId: p.itemSeqId}).forUpdate(true).one()
    if (item && item.result !== "created")
        call("update#" + ITEM, {
            operationKey: p.operationKey,
            itemSeqId: p.itemSeqId,
            result: "failed",
            errorMessage: p.errorMessage,
            completedDate: ec.user.nowTimestamp
        })
    return {}
}
function applyChanges(p) {
    const {request} = operation(p)
    if (!p.previewToken || request.previewToken !== p.previewToken)
        throw new Error("Confirm the exact reviewed price-change preview")
    for (const item of rows(ITEM, {operationKey: p.operationKey}).filter(item => item.result !== "created")) {
        ec.message.pushErrors()
        try {
            call(M + "apply#PriceChangeItem", {operationKey: p.operationKey, itemSeqId: item.itemSeqId}, true)
        } catch (e) {
            ec.logger.error("Price-change operation " + p.operationKey + " row " + item.itemKey + " failed: " + e)
            ec.message.clearErrors()
            try {
                call(
                    M + "fail#PriceChangeItem",
                    {operationKey: p.operationKey, itemSeqId: item.itemSeqId, errorMessage: String(e.message || e)},
                    true
                )
            } catch (storeError) {
                ec.logger.error("Could not save price-change failure " + item.itemKey + ": " + storeError)
            }
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return changeResult(p)
}
function changeResult(p) {
    const {request} = operation(p),
        results = Array.from(request.previewFailures || [])
    for (const item of rows(ITEM, {operationKey: p.operationKey})) {
        const saved = JSON.parse(item.requestJson)
        try {
            editableRow(saved.productPriceId)
            results.push({
                productPriceId: saved.productPriceId,
                productId: saved.productId,
                successorProductPriceId: item.resultRecordId,
                result: item.result || "pending",
                error: item.errorMessage
            })
        } catch (e) {
            results.push({result: "unavailable", error: "Price row is no longer available"})
        }
    }
    return {
        operationKey: p.operationKey,
        previewToken: request.previewToken,
        results,
        successCount: results.filter(row => row.result === "created").length,
        failedCount: results.filter(row => row.result === "failed").length
    }
}
// The operation as reviewed and as it stands: each row's amounts, and whether its source changed since the preview.
function changeInfo(p) {
    const {request: manifest} = operation(p)
    const previewRows = rows(ITEM, {operationKey: p.operationKey}).map(item => {
        const request = JSON.parse(item.requestJson),
            old = editableRow(request.productPriceId)
        return {
            productPriceId: old.productPriceId,
            productId: old.productId,
            productName: one(P + "Product", {productId: old.productId})?.productName,
            beforePrice: request.beforePrice,
            afterPrice: request.price,
            priceUomId: request.priceUomId,
            minQuantity: request.minQuantity,
            changeReason: request.changeReason,
            result: item.result || (ms(old.lastUpdatedStamp) === ms(request.expectedLastUpdatedStamp) ? "ready" : "stale")
        }
    })
    return Object.assign(changeResult(p), {
        previewRows: previewRows.concat(manifest.previewFailures || []),
        readyCount: previewRows.filter(row => row.result === "ready").length
    })
}
function execute(op, p) {
    const operations = {previewChanges, applyChanges, applyItem, failItem, changeInfo}
    if (!operations[op]) throw new Error("Unknown price-change operation " + op)
    return operations[op](p || {})
}
;({execute})
