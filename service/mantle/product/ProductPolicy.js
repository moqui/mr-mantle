// Product usability and kit validation shared by the catalog and transaction entry points.
const find = (entity, fields) => ec.entity.find(entity).condition(fields || {})
const one = (entity, fields) => find(entity, fields).one()
const rows = (entity, fields) => Array.from(find(entity, fields).list())
const call = (name, p) => ec.service.sync().name(name).parameters(p || {}).call() || {}
const millis = value => value == null || value === '' ? null : Number(String(value))
const now = () => millis(ec.user.nowTimestamp)
function usable(p) {
    const product = one('mantle.product.Product', {productId: p.productId})
    const fail = reason => ({usable: false, reason, statusId: product?.statusId || null})
    if (!product) return fail('Product is not available')
    if (!['Sell', 'Purchase', 'Replenish', 'Produce', 'Receive', 'Return'].includes(p.usage)) return fail('Unknown product usage')
    const statusId = product.statusId || (millis(product.salesDiscontinuationDate) != null && millis(product.salesDiscontinuationDate) <= now() ? 'PrdDiscontinued' : 'PrdActive')
    if (['Receive', 'Return'].includes(p.usage)) return {usable: true, reason: null, statusId}
    if (p.usage === 'Sell' && product.salesAllowed === 'N') return {usable: false, reason: 'Sales are not allowed', statusId}
    if (['Purchase', 'Replenish'].includes(p.usage) && product.purchaseAllowed === 'N') return {usable: false, reason: 'Purchases are not allowed', statusId}
    if (['PrdDraft', 'PrdObsolete'].includes(statusId)) return {usable: false, reason: statusId === 'PrdDraft' ? 'Draft product' : 'Obsolete product', statusId}
    if (p.usage === 'Sell' && millis(product.salesIntroductionDate) > now()) return {usable: false, reason: 'Sales introduction date has not arrived', statusId}
    if (statusId === 'PrdDiscontinued') {
        if (p.usage !== 'Sell') return {usable: false, reason: 'Discontinued product cannot create new supply', statusId}
        if (!['PtAsset', 'PtDigitalAsset', 'PtAssetUse', 'PtPickAssembly'].includes(product.productTypeEnumId))
            return {usable: false, reason: 'Discontinued product has no remaining stock', statusId}
        const available = call('mantle.product.AssetServices.get#AvailableInventory', {productId: p.productId, facilityId:p.facilityId,productStoreId:p.productStoreId,vendorPartyId:p.vendorPartyId,customerPartyId:p.customerPartyId}).availableToPromiseTotal
        if (toDecimal(available || 0).compare(p.quantity || 1) < 0) return {usable: false, reason: 'Discontinued product has insufficient remaining stock', statusId}
    }
    if (!['PrdActive', 'PrdDiscontinued'].includes(statusId)) return {usable: false, reason: 'Unsupported product status', statusId}
    return {usable: true, reason: null, statusId}
}
function orderUsable(p) {
    const part = p.orderId && p.orderPartSeqId ? one('mantle.order.OrderPart', {orderId: p.orderId, orderPartSeqId: p.orderPartSeqId}) : null
    const vendor = part?.vendorPartyId || p.vendorPartyId
    const buyer = part?.customerPartyId || p.customerPartyId
    const internal = id => !!id && !!one('mantle.party.PartyRole', {partyId: id, roleTypeId: 'OrgInternal'})
    const header=p.orderId ? one('mantle.order.OrderHeader',{orderId:p.orderId}) : null
    const result = usable(Object.assign({}, p, {productStoreId:header?.productStoreId,vendorPartyId:vendor,customerPartyId:buyer,usage: !internal(vendor) && internal(buyer) ? 'Purchase' : 'Sell', facilityId: part?.facilityId}))
    if (!result.usable) ec.message.addError(`Product ${p.productId} (${result.statusId || 'unknown'}): ${result.reason}`)
    return result
}
function kit(p) {
    find('moqui.basic.EnumerationType', {enumTypeId: 'ProductAssocType'}).forUpdate(true).one()
    const parent = find('mantle.product.Product', {productId: p.productId}).forUpdate(true).one()
    if (parent?.productTypeEnumId !== 'PtPickAssembly') throw new Error('Kit components require a pick-assembly product')
    if (!one('mantle.product.Product', {productId: p.toProductId})) throw new Error('Component product is not available')
    if (toDecimal(p.quantity).compare(0) <= 0) throw new Error('Kit component quantity must be positive')
    const from = millis(p.fromDate) ?? now(), thru = millis(p.thruDate) ?? Infinity
    if (thru <= from) throw new Error('Kit component end must follow its start')
    // Graph lock precedes product locks so reciprocal writers cannot deadlock on different parents.
    const walk = (id, low, high, path) => {
        if (id === p.productId) throw new Error('Kit component cycle: ' + path.concat(id).join(' → '))
        if (path.length >= 100 || path.includes(id)) throw new Error('Invalid existing kit component path: ' + path.concat(id).join(' → '))
        if (one('mantle.product.Product', {productId: id})?.productTypeEnumId !== 'PtPickAssembly') return
        for (const edge of rows('mantle.product.ProductAssoc', {productId: id, productAssocTypeEnumId: 'PatMfgBom'})) {
            const a = Math.max(low, millis(edge.fromDate) ?? -Infinity), b = Math.min(high, millis(edge.thruDate) ?? Infinity)
            if (a < b) walk(edge.toProductId, a, b, path.concat(id))
        }
    }
    walk(p.toProductId, from, thru, [])
    call('store#mantle.product.ProductAssoc', {productId: p.productId, toProductId: p.toProductId, productAssocTypeEnumId: 'PatMfgBom',
        fromDate: p.fromDate, thruDate: p.thruDate || null, quantity: p.quantity, sequenceNum: p.sequenceNum})
    return {fromDate: p.fromDate}
}
function execute(op, p) {
    const disabled = ec.artifactExecution.disableAuthz()
    try { return ({usable, orderUsable, kit})[op](p || {}) }
    finally { if (!disabled) ec.artifactExecution.enableAuthz() }
}
;({execute})
