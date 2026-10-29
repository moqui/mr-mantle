const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js"),
    identifiers = () => ec.resource.script("component://mr-mantle/service/mantle/product/Identifiers.js"),
    A = "mantle.product.ProductAssoc"
const find = (n, p = {}) => policy().find(n, p),
    one = (n, p) => policy().one(n, p),
    rows = (n, p = {}) => policy().rows(n, p),
    call = (n, p = {}) => policy().call(n, p),
    map = r => policy().map(r),
    ms = v => policy().ms(v),
    iso = v => policy().iso(v),
    active = (r, d) => policy().active(r, d),
    hash = v => policy().fingerprint(v),
    edges = id => rows(A, {productId: id, productAssocTypeEnumId: "PatPackagingFor"})
const key = r => ({
    productId: r.productId,
    toProductId: r.toProductId,
    productAssocTypeEnumId: "PatPackagingFor",
    fromDate: iso(r.fromDate)
})
function revision(id) {
    return hash(
        edges(id)
            .map(map)
            .sort((a, b) => ms(a.fromDate) - ms(b.fromDate) || a.toProductId.localeCompare(b.toProductId))
    )
}
function content(row, s, date, path = []) {
    if (path.includes(row.productId) || path.length >= 64)
        throw new Error("Packaging graph contains a cycle or exceeds 64 levels")
    const pack = policy().product(row.productId, s),
        base = policy().product(row.toProductId, s),
        quantity = toDecimal(row.quantity || 0)
    if (quantity.compare(0) <= 0) throw new Error("Packaging quantity must be positive")
    const entered = row.quantityUomId || base.amountUomId
    if (!entered || !base.amountUomId) throw new Error("Packaging has no usable base stock unit")
    const normalized = policy().convert(quantity, entered, base.amountUomId, date),
        children = edges(base.productId).filter(r => active(r, date)),
        step = {
            packProductId: pack.productId,
            baseProductId: base.productId,
            fromDate: row.fromDate,
            quantity: String(quantity),
            quantityUomId: entered,
            normalizedQuantity: String(normalized.quantity),
            baseUomId: base.amountUomId,
            legacyUnit: !row.quantityUomId,
            uomConversionId: normalized.uomConversionId,
            appliedConversionFactor: String(normalized.factor),
            revision: hash(map(row))
        }
    if (children.length > 1) throw new Error("Several packaging definitions apply to this product and date")
    if (children.length) {
        const child = content(children[0], s, date, [...path, row.productId]),
            factor = normalized.quantity.multiply(child.containedQuantity)
        return {
            productId: child.productId,
            packProductId: pack.productId,
            containedQuantity: String(factor),
            quantityUomId: child.quantityUomId,
            appliedConversionFactor: String(factor),
            packPath: [step, ...child.packPath]
        }
    }
    return {
        productId: base.productId,
        packProductId: pack.productId,
        containedQuantity: String(normalized.quantity),
        quantityUomId: base.amountUomId,
        appliedConversionFactor: String(normalized.quantity),
        packPath: [step]
    }
}
function list(p) {
    const s = policy().scope(p),
        date = p.asOfDate || ec.user.nowTimestamp,
        out = [],
        findings = []
    if (p.baseProductId) policy().product(p.baseProductId, s)
    if (p.packProductId) policy().product(p.packProductId, s)
    for (const row of rows(A, {productAssocTypeEnumId: "PatPackagingFor"})) {
        if (
            (p.baseProductId && row.toProductId !== p.baseProductId) ||
            (p.packProductId && row.productId !== p.packProductId) ||
            (!p.includeHistory && !active(row, date))
        )
            continue
        try {
            const pack = policy().product(row.productId, s),
                base = policy().product(row.toProductId, s)
            const data = Object.assign(map(row), {
                packProductId: row.productId,
                baseProductId: row.toProductId,
                packName: pack.productName,
                baseName: base.productName,
                expectedRevision: revision(row.productId),
                legacyUnit: !row.quantityUomId,
                canEdit: s.edit && (s.systemAdmin || (pack.ownerPartyId && pack.ownerPartyId !== "_NA_"))
            })
            if (active(row, date)) {
                const resolved = content(row, s, date)
                Object.assign(data, resolved, {resolvedProductId: resolved.productId, productId: row.productId})
            }
            out.push(data)
        } catch (e) {
            ec.logger.error("Packaging " + row.productId + ": " + e)
            try {
                policy().product(row.productId, s)
                policy().product(row.toProductId, s)
                findings.push({packProductId: row.productId, message: String(e.message || e)})
            } catch (hidden) {}
        }
    }
    return {packagingRows: out, findings, canEdit: s.edit}
}
function store(p) {
    const s = policy().scope(p, "edit"),
        why = policy().reason(p),
        packId = p.packProductId || p.productId,
        baseId = p.baseProductId || p.toProductId
    find("moqui.basic.EnumerationType", {enumTypeId: "ProductAssocType"}).forUpdate(true).one()
    const pack = policy().product(packId, s, true),
        base = policy().product(baseId, s)
    if (packId === baseId) throw new Error("A pack cannot contain itself")
    if ((base.ownerPartyId || "_NA_") !== "_NA_" && pack.ownerPartyId !== base.ownerPartyId)
        throw new Error("Pack and base must have the same catalog owner, or the base must be shared")
    find("mantle.product.Product", {productId: packId}).forUpdate(true).one()
    find("mantle.product.Product", {productId: baseId}).forUpdate(true).one()
    const history = edges(packId)
    if (history.length && (!p.expectedRevision || p.expectedRevision !== revision(packId)))
        throw new Error("Packaging changed; reload before saving")
    const now = ms(ec.user.nowTimestamp),
        current = history.filter(r => active(r, ec.user.nowTimestamp)),
        date = p.fromDate == null ? Math.max(now, ...current.map(r => (ms(r.fromDate) || 0) + 1)) : ms(p.fromDate)
    if (!Number.isFinite(date) || date < now) throw new Error("Packaging changes must start now or later")
    const next = history.filter(r => ms(r.fromDate) > date).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0],
        end = p.thruDate ? ms(p.thruDate) : next ? ms(next.fromDate) : null
    if (end != null && (!Number.isFinite(end) || end <= date)) throw new Error("Packaging end must follow its start")
    if (history.some(r => ms(r.fromDate) === date))
        throw new Error("A packaging definition already starts on this date; choose a later start")
    const quantity = toDecimal(p.quantity ?? 0),
        unit = p.quantityUomId || base.amountUomId
    if (quantity.compare(0) <= 0) throw new Error("Packaging quantity must be positive")
    policy().convert(quantity, unit, base.amountUomId, iso(date))
    const walk = (id, low, high, ancestors = []) => {
        if (id === packId || ancestors.includes(id) || ancestors.length >= 64)
            throw new Error("Packaging would contain a cycle or exceed 64 levels")
        for (const edge of edges(id)) {
            const a = Math.max(low, ms(edge.fromDate) ?? -Infinity),
                b = Math.min(high, ms(edge.thruDate) ?? Infinity)
            if (a < b) walk(edge.toProductId, a, b, [...ancestors, id])
        }
    }
    walk(baseId, date, end ?? Infinity)
    const method = ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
    policy().audit(["quantityUomId"], why)
    for (const old of history.filter(r => (ms(r.fromDate) ?? -Infinity) <= date && (ms(r.thruDate) ?? Infinity) > date)) {
        call("update#" + A, Object.assign(key(old), {thruDate: iso(date), reason: why}))
        method.recordAudit(A, key(old), ["thruDate"], map(old), {thruDate: iso(date)}, why)
    }
    const data = {
        productId: packId,
        toProductId: baseId,
        productAssocTypeEnumId: "PatPackagingFor",
        fromDate: iso(date),
        thruDate: end == null ? null : iso(end),
        quantity: String(quantity),
        quantityUomId: unit,
        reason: why
    }
    call("create#" + A, data)
    method.recordAudit(A, key(data), ["fromDate", "thruDate", "quantity", "reason"], {}, data, why)
    if (p.idValue)
        call("mantle.product.ProductServices.store#ProductIdentifier", {
            productId: packId,
            productIdTypeEnumId: p.productIdTypeEnumId || "PidtSku",
            idValue: p.idValue,
            changeReason: why
        })
    return {packProductId: packId, baseProductId: baseId, fromDate: iso(date), expectedRevision: revision(packId)}
}
function scan(p) {
    const s = policy().scope(p),
        date = p.asOfDate || ec.user.nowTimestamp,
        code = String(p.scanId || p.idValue || "").replace(/[\r\n]+$/, ""),
        found = new Set(),
        findings = [],
        parsedCandidates = []
    if (!code) return {found: false, ambiguous: false, ambiguityList: [], findings}
    let gs1 = null
    const looksGs1 = /^(?:\]C1|\]d2|\]Q3|\()/.test(code) || code.includes("\x1d")
    try {
        if (looksGs1 || /^01\d{14}/.test(code)) gs1 = ec.resource.parseGs1(code)
    } catch (e) {
        if (looksGs1) return {found: false, ambiguous: false, ambiguityList: [], findings: [{message: String(e.message || e)}]}
    }
    const values = [code]
    if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length) && ec.resource.isValidGs1CheckDigit(code))
        values.push(...identifiers().variants(code.padStart(14, "0")))
    if (gs1?.applicationIdentifiers["01"]) values.push(...identifiers().variants(gs1.applicationIdentifiers["01"]))
    const unique = [...new Set(values)]
    for (const field of ["productId", "pseudoId"])
        for (const row of Array.from(find("mantle.product.Product").condition(field, "in", unique).list()))
            found.add(row.productId)
    for (const entity of ["mantle.product.ProductIdentification", "mantle.product.ProductOtherIdentification"])
        for (const row of Array.from(find(entity).condition("idValue", "in", unique).list())) {
            if (
                entity.endsWith("OtherIdentification") &&
                ((row.productStoreId && row.productStoreId !== p.productStoreId) ||
                    (row.marketSegmentId && row.marketSegmentId !== p.marketSegmentId))
            )
                continue
            found.add(row.productId)
        }
    const candidates = []
    for (const id of found)
        try {
            const product = policy().product(id, s),
                packs = edges(id).filter(r => active(r, date))
            if (packs.length > 1) {
                candidates.push({
                    productId: id,
                    packProductId: id,
                    invalid: true,
                    message: "Several packaging definitions apply to this product and date"
                })
                continue
            }
            const result = packs.length
                ? content(packs[0], s, date)
                : {
                      productId: id,
                      packProductId: null,
                      containedQuantity: "1",
                      quantityUomId: product.amountUomId,
                      appliedConversionFactor: "1",
                      packPath: []
                  }
            candidates.push(Object.assign(result, {matchedProductId: id, productName: product.productName}))
        } catch (e) {
            ec.logger.error("Scanned product " + id + ": " + e)
        }
    if (candidates.length !== 1 || candidates[0]?.invalid)
        return {
            found: false,
            ambiguous: candidates.length > 1 || !!candidates[0]?.invalid,
            ambiguityList: candidates,
            findings,
            gs1,
            scanId: code
        }
    return Object.assign({found: true, ambiguous: false, ambiguityList: [], findings, gs1, scanId: code}, candidates[0])
}
function stockUnit(p) {
    const old = one("mantle.product.Product", {productId: p.productId})
    if (!old) return {}
    if (p.amountUomId) policy().unit(p.amountUomId)
    const used =
        rows("mantle.product.asset.Asset", {productId: p.productId}).length ||
        rows("mantle.order.OrderItem", {productId: p.productId}).length ||
        rows(A, {productId: p.productId}).some(r => r.productAssocTypeEnumId === "PatPackagingFor") ||
        rows(A, {toProductId: p.productId}).some(r => r.productAssocTypeEnumId === "PatPackagingFor") ||
        rows("mantle.product.bom.ProductBom", {productId: p.productId}).length ||
        rows("mantle.product.bom.ProductBomItem", {productId: p.productId}).length ||
        rows("mantle.product.cost.ProductStandardCost", {productId: p.productId}).length
    if (used)
        throw new Error(
            "The stock unit is in use by stock, transactions, packaging, methods or estimates; create another product for a different stock unit"
        )
    return {}
}
function execute(op, p) {
    return {list, store, scan, stockUnit}[op](p)
}
;({execute, content, revision})
