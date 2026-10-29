// Label jobs reference existing identifiers. A reviewed job never assigns a code or moves stock.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js"),
    identifiers = () => ec.resource.script("component://mr-mantle/service/mantle/product/Identifiers.js"),
    J = "mantle.product.ProductCatalogOperation"
const find = (n, p = {}) => policy().find(n, p),
    one = (n, p) => policy().one(n, p),
    rows = (n, p = {}) => policy().rows(n, p),
    call = (n, p = {}) => policy().call(n, p),
    map = r => policy().map(r),
    hash = v => policy().fingerprint(v)
const templates = [
    {value: "product-50x30", label: "Product · 50 × 30 mm", width: 50, height: 30, moduleWidth: 0.33, barcodeHeight: 19},
    {value: "shipping-100x60", label: "Shipping · 100 × 60 mm", width: 100, height: 60, moduleWidth: 0.5, barcodeHeight: 40}
]
const esc = v =>
        String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]),
    priceAccess = () =>
        ["PRICE_VIEW", "PRICE_EDIT"].some(n =>
            ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js").has(n)
        )
function scope(p) {
    const s = policy().scope(p)
    if (p.includePrice && !priceAccess()) throw new Error("Selling-price read authority is required for priced labels")
    return s
}
function normalize(p) {
    const s = scope(p),
        template = templates.find(t => t.value === (p.templateId || "product-50x30"))
    if (!template) throw new Error("Choose an approved label template")
    const raw = Array.isArray(p.items)
        ? p.items
        : (Array.isArray(p.productIds) ? p.productIds : String(p.productIds || p.productId || "").split(/[\s,]+/))
              .filter(Boolean)
              .map(productId => ({
                  productId,
                  productIdTypeEnumId: p.productIdTypeEnumId,
                  productOtherIdentId: p.productOtherIdentId,
                  copies: p.copies ?? 1
              }))
    if (!raw.length || raw.length > 200) throw new Error("Select between 1 and 200 products")
    const items = raw.map(r => ({
        productId: r.productId,
        productIdTypeEnumId: r.productIdTypeEnumId || null,
        productOtherIdentId: r.productOtherIdentId || null,
        copies: Number(r.copies ?? p.copies ?? 1)
    }))
    if (
        items.some(r => !Number.isInteger(r.copies) || r.copies < 1 || r.copies > 500) ||
        items.reduce((n, r) => n + r.copies, 0) > 2000
    )
        throw new Error("Choose 1–500 copies per product and at most 2000 labels")
    return {
        items,
        templateId: template.value,
        symbology: p.symbology || "auto",
        asOfDate: policy().iso(p.asOfDate || ec.user.nowTimestamp),
        includePrice: !!p.includePrice,
        priceUomId: p.priceUomId || ec.user.userAccount?.currencyUomId || "USD",
        organizationPartyId: s.organizationPartyId,
        locale: p.locale || ec.user.locale || "en"
    }
}
function calculate(request) {
    const s = scope(request),
        template = templates.find(t => t.value === request.templateId)
    if (!template) throw new Error("Label template is not available")
    const labelRows = [],
        findings = [],
        sources = []
    for (let i = 0; i < request.items.length; i++) {
        const item = request.items[i]
        try {
            const product = policy().product(item.productId, s),
                available = rows("mantle.product.ProductIdentification", {productId: item.productId}).sort((a, b) =>
                    String(a.productIdTypeEnumId).localeCompare(String(b.productIdTypeEnumId))
                ),
                source = item.productOtherIdentId
                    ? one("mantle.product.ProductOtherIdentification", {productOtherIdentId: item.productOtherIdentId})
                    : item.productIdTypeEnumId
                      ? available.find(r => r.productIdTypeEnumId === item.productIdTypeEnumId)
                      : available.find(r => r.productIdTypeEnumId === "PidtGtin") ||
                        available.find(r => r.productIdTypeEnumId === "PidtEan") ||
                        available.find(r => r.productIdTypeEnumId === "PidtSku") ||
                        available[0]
            if (!source || source.productId !== item.productId) throw new Error("Choose an existing identifier on this product")
            if (source.productStoreId || source.marketSegmentId)
                throw new Error("Choose an unqualified product or pack identifier for labels")
            const checked = call("mantle.product.ProductServices.validate#ProductIdentifier", {
                productId: item.productId,
                productIdTypeEnumId: source.productIdTypeEnumId,
                idValue: source.idValue,
                asOfDate: request.asOfDate,
                checkUniqueness: false
            })
            if (!checked.valid) throw new Error(checked.issues.join("; "))
            let symbology = request.symbology === "auto" ? checked.identifierPolicy.format : request.symbology
            if (symbology === "GTIN")
                symbology = {8: "EAN-8", 12: "UPC-A", 13: "EAN-13", 14: "ITF-14"}[String(source.idValue).length]
            let encodedValue = String(source.idValue)
            if (symbology === "GS1-128" && !encodedValue.startsWith("(") && !encodedValue.startsWith("]C1")) {
                if (
                    !identifiers().retailTypes.includes(source.productIdTypeEnumId) ||
                    !/^\d{8,14}$/.test(encodedValue) ||
                    !ec.resource.isValidGs1CheckDigit(encodedValue)
                )
                    throw new Error("GS1-128 needs an existing GTIN or an existing GS1 element string")
                encodedValue = "(01)" + encodedValue.padStart(14, "0")
            }
            const quietZone = symbology === "QR" ? 4 : symbology === "DataMatrix" ? 1 : 11,
                moduleWidth = template.value === "product-50x30" && symbology === "Code128" ? 0.21 : template.moduleWidth,
                svg = ec.resource.barcodeSvg(symbology, encodedValue, {
                    moduleWidth,
                    height: template.barcodeHeight,
                    quietZone,
                    humanReadable: true
                }),
                size = svg.match(/width="([\d.]+)mm" height="([\d.]+)mm"/)
            if (!size || Number(size[1]) > template.width - 4 || Number(size[2]) > template.height - 8)
                throw new Error("Barcode does not fit this label; choose the shipping template or a different symbology")
            if (symbology === "ITF-14" && template.value !== "shipping-100x60")
                throw new Error("ITF-14 uses the shipping template")
            const decoded = call("mantle.product.ProductServices.resolve#ScannedProduct", {
                scanId: encodedValue,
                asOfDate: request.asOfDate
            })
            if (!decoded.found || decoded.matchedProductId !== item.productId)
                throw new Error("This encoded value is ambiguous or does not resolve back to the selected product")
            let sellingPrice = null,
                priceSource = null
            if (request.includePrice) {
                if (!s.organizationPartyId) throw new Error("Choose a selling organization")
                const price = call("mantle.product.PriceServices.get#ProductPrice", {
                    productId: item.productId,
                    quantity: 1,
                    quantityUomId: product.amountUomId,
                    validDate: request.asOfDate,
                    priceUomId: request.priceUomId,
                    vendorPartyId: s.organizationPartyId,
                    organizationPartyId: s.organizationPartyId,
                    direction: "sales"
                })
                if (price.price == null || price.priceAvailable === false)
                    throw new Error("No readable selling price is available")
                sellingPrice = String(price.price)
                priceSource = {productPriceId: price.productPriceId, priceRuleId: price.priceRuleId, price: sellingPrice}
            }
            labelRows.push({
                itemSeqId: i + 1,
                productId: item.productId,
                productName: product.productName,
                productIdTypeEnumId: source.productIdTypeEnumId,
                idValue: source.idValue,
                encodedValue,
                symbology,
                svg,
                copies: item.copies,
                decodedProductId: decoded.productId,
                packProductId: decoded.packProductId,
                containedQuantity: decoded.containedQuantity,
                quantityUomId: decoded.quantityUomId,
                sellingPrice,
                priceUomId: request.priceUomId
            })
            sources.push({
                product: map(product),
                identifier: map(source),
                identifierPolicy: checked.identifierPolicy,
                packPath: decoded.packPath,
                priceSource
            })
        } catch (e) {
            ec.logger.error("Label product " + item.productId + ": " + e)
            findings.push({itemSeqId: i + 1, productId: item.productId, message: String(e.message || e)})
        }
    }
    return {
        labelRows,
        findings,
        labelCount: labelRows.reduce((n, r) => n + r.copies, 0),
        complete: findings.length === 0,
        inputFingerprint: hash({request, sources, findings}),
        template
    }
}
function job(p) {
    const row = one(J, {operationKey: p.operationKey})
    if (!row || row.operationType !== "labels") throw new Error("Label selection is not available")
    const request = JSON.parse(row.requestJson),
        s = scope(request)
    if (row.submittedByUserId !== ec.user.userId && !s.systemAdmin) throw new Error("Open your own label selection")
    for (const item of rows("mantle.product.ProductCatalogOperationItem", {operationKey: p.operationKey}).filter(
        r => r.result === "ready"
    ))
        policy().product(item.resultProductId, s)
    return {row, request, s}
}
function prepare(p) {
    const request = normalize(p),
        result = calculate(request),
        operationKey = "labels-" + ec.user.randomString(24)
    call("create#" + J, {
        operationKey,
        operationType: "labels",
        ownerPartyId: request.organizationPartyId,
        submittedByUserId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestJson: JSON.stringify(request),
        inputFingerprint: result.inputFingerprint,
        state: "prepared"
    })
    for (let i = 0; i < request.items.length; i++) {
        const ready = result.labelRows.find(r => r.itemSeqId === i + 1),
            failed = result.findings.find(r => r.itemSeqId === i + 1)
        call("create#mantle.product.ProductCatalogOperationItem", {
            operationKey,
            itemSeqId: i + 1,
            itemKey: request.items[i].productId,
            requestJson: JSON.stringify(request.items[i]),
            result: ready ? "ready" : "invalid",
            resultProductId: ready?.productId,
            errorMessage: failed?.message
        })
    }
    return Object.assign({}, result, {operationKey, request, templateOptions: templates, stale: false})
}
function get(p) {
    const g = job(p),
        result = calculate(g.request)
    return Object.assign({}, result, {
        operationKey: p.operationKey,
        request: g.request,
        inputFingerprint: g.row.inputFingerprint,
        stale: result.inputFingerprint !== g.row.inputFingerprint,
        state: g.row.state,
        lastError: g.row.lastError,
        printJobId: g.row.printJobId,
        artifactAvailable: !!g.row.outputContentLocation,
        templateOptions: templates
    })
}
function html(request, result) {
    let body = ""
    for (const r of result.labelRows) {
        const content =
            '<section class="label"><strong>' +
            esc(r.productName) +
            '</strong><div class="symbol">' +
            r.svg +
            "</div><div>" +
            esc(r.idValue) +
            "</div>" +
            (r.packProductId
                ? "<div>" + esc(r.containedQuantity) + " " + esc(r.quantityUomId) + " · " + esc(r.decodedProductId) + "</div>"
                : "") +
            (r.sellingPrice != null ? "<div>" + esc(r.sellingPrice) + " " + esc(r.priceUomId) + "</div>" : "") +
            "</section>"
        if (body.length + content.length * r.copies > 8 * 1024 * 1024)
            throw new Error("This print document is too large; prepare a smaller selection")
        body += content.repeat(r.copies)
    }
    const t = result.template
    return (
        '<!DOCTYPE html><html lang="' +
        esc(request.locale) +
        '"><head><meta charset="utf-8"><title>Product labels</title><style>@page{size:' +
        t.width +
        "mm " +
        t.height +
        "mm;margin:0}body{margin:0;color:#000;background:#fff;font:8pt Arial}.label{box-sizing:border-box;width:" +
        t.width +
        "mm;height:" +
        t.height +
        "mm;padding:2mm;break-after:page;overflow:hidden;text-align:center}.label:last-child{break-after:auto}.symbol{display:flex;align-items:center;justify-content:center}strong{display:block;font-size:8pt}</style></head><body>" +
        body +
        "</body></html>"
    )
}
function render(p) {
    const g = job(p)
    g.row = map(find(J, {operationKey: p.operationKey}).forUpdate(true).one())
    if (g.row.outputContentLocation) return {operationKey: p.operationKey, rendered: true, artifactAvailable: true}
    const result = calculate(g.request)
    if (
        !p.inputFingerprint ||
        p.inputFingerprint !== g.row.inputFingerprint ||
        result.inputFingerprint !== g.row.inputFingerprint
    )
        throw new Error("Label inputs changed; prepare and review a new selection")
    if (!result.labelRows.length) throw new Error("No valid labels are available to render")
    try {
        const printHtml = html(g.request, result),
            pdf = ec.resource.xslFoTransform(printHtml, null, null, "application/pdf"),
            location = "dbresource://mantle/labels/" + p.operationKey + "/labels.pdf"
        ec.resource.getLocationReference(location).putBytes(pdf)
        call("update#" + J, {operationKey: p.operationKey, state: "rendered", outputContentLocation: location, lastError: null})
        return {operationKey: p.operationKey, rendered: true, artifactAvailable: true, printHtml}
    } catch (e) {
        ec.logger.error("Label render " + p.operationKey + ": " + e)
        ec.message.clearErrors()
        call("update#" + J, {operationKey: p.operationKey, state: "render-failed", lastError: String(e.message || e)})
        return {operationKey: p.operationKey, rendered: false, lastError: String(e.message || e)}
    }
}
function printable(p) {
    const g = job(p),
        result = calculate(g.request)
    if (p.inputFingerprint !== g.row.inputFingerprint || result.inputFingerprint !== g.row.inputFingerprint)
        throw new Error("Label inputs changed; prepare and review a new selection")
    return {printHtml: html(g.request, result)}
}
function resource(p) {
    const g = job(p)
    if (!g.row.outputContentLocation) throw new Error("Render the label PDF first")
    return {contentLocation: g.row.outputContentLocation, filename: "Product-labels.pdf"}
}
function print(p) {
    const g = job(p)
    g.row = map(find(J, {operationKey: p.operationKey}).forUpdate(true).one())
    if (!g.row.outputContentLocation) throw new Error("Render the label PDF first")
    if (!p.networkPrinterId || !one("moqui.basic.print.NetworkPrinter", {networkPrinterId: p.networkPrinterId}))
        throw new Error("Choose a configured printer")
    if (g.row.printJobId) {
        const existing = one("moqui.basic.print.PrintJob", {printJobId: g.row.printJobId})
        if (existing?.statusId !== "PtjSendFailed" || !p.retry)
            return {operationKey: p.operationKey, printJobId: g.row.printJobId, alreadySent: true}
    }
    try {
        const out =
            ec.service
                .sync()
                .name("org.moqui.impl.PrintServices.print#ResourceDocument")
                .parameters({
                    networkPrinterId: p.networkPrinterId,
                    resourceLocation: g.row.outputContentLocation,
                    jobName: "Product labels " + p.operationKey,
                    copies: 1
                })
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        call("update#" + J, {operationKey: p.operationKey, state: "printed", printJobId: out.printJobId, lastError: null})
        return {operationKey: p.operationKey, printJobId: out.printJobId, alreadySent: false}
    } catch (e) {
        ec.logger.error("Label print " + p.operationKey + ": " + e)
        ec.message.clearErrors()
        call("update#" + J, {
            operationKey: p.operationKey,
            state: "print-failed",
            printJobId:
                rows("moqui.basic.print.PrintJob", {
                    jobName: "Product labels " + p.operationKey,
                    networkPrinterId: p.networkPrinterId
                }).sort((a, b) => (policy().ms(b.createdDate) || 0) - (policy().ms(a.createdDate) || 0))[0]?.printJobId ||
                g.row.printJobId,
            lastError: String(e.message || e)
        })
        return {operationKey: p.operationKey, lastError: String(e.message || e)}
    }
}
function access(p) {
    try {
        job(p)
        return {recordVisible: true}
    } catch (e) {
        return {recordVisible: false}
    }
}
function execute(op, p) {
    return {prepare, get, render, printable, resource, print, access}[op](p)
}
;({execute, templates})
