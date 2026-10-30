const helper = () => ec.resource.script("component://mr-mantle/test/AccountingReceivablesFixtures.js")
const native = (name, p) => helper().call("mantle.account.InvoiceServices." + name, p)
const capture = ec.factory.getTool("MailCapture")
let f, selectedParameters, issued, selectedContent, extraContent
function file(invoiceId, id, name, bytes, root = "dbresource://mantle/content") {
    const location = root + "/invoice/" + invoiceId + "/content_" + id + "/" + name
    ec.resource.getLocationReference(location).putBytes(bytes)
    helper().call("create#mantle.account.invoice.InvoiceContent", {
        invoiceContentId: id,
        invoiceId,
        contentLocation: location,
        contentTypeEnumId: "IctNote",
        description: name
    })
    return {id, location}
}
function parameters(invoice, key, ids = [], versions = {}) {
    return {
        invoiceId: invoice.invoiceId,
        organizationPartyId: f.org,
        operationKey: key,
        sourceVersion: helper().lib.fingerprint(invoice),
        emailAccountId: f.emailAccountId,
        toAddresses: "attachments@example.com",
        attachmentContentIdList: ids,
        attachmentVersions: versions
    }
}
function choices(invoiceId, ids = null) {
    return native("get#InvoiceDeliveryAttachments", {invoiceId, organizationPartyId: f.org, attachmentContentIdList: ids})
}
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_ATTACH")
        capture.enable()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        capture.reset()
    }
})
feature("sender attachment choices expose bounded metadata while readers receive no attachment versions", {
    when() {
        const invoice = helper().draft(f, "12")
        file(invoice.invoiceId, "NATIVE_ATTACH_CHOICE", "Scope.txt", new Uint8Array([83, 99, 111, 112, 101]))
        login(f.users.ar)
        const options = choices(invoice.invoiceId)
        const detail = native("get#InvoiceFinanceDetail", {invoiceId: invoice.invoiceId})
        login(f.users.read)
        const denied = helper().rejected("mantle.account.InvoiceServices.get#InvoiceDeliveryAttachments", {
            invoiceId: invoice.invoiceId
        })
        const read = native("get#InvoiceFinanceDetail", {invoiceId: invoice.invoiceId})
        return {options, detail, denied, read}
    },
    then({options, detail, denied, read}) {
        options.attachmentRows.length == 1
        options.attachmentRows[0].fileName == "Scope.txt"
        !!options.attachmentRows[0].attachmentVersion
        options.maxAttachmentCount == 10
        options.maxTotalAttachmentBytes == 20971520
        options.attachmentRows.every(row => row.contentLocation == null && row.bytes == null)
        detail.contentRows.some(row => row.attachable && row.attachmentVersion)
        denied.includes("PERMISSION_DENIED")
        read.contentRows.every(row => !row.attachmentVersion)
    }
})
feature("default delivery attaches only the issued PDF even when invoice note files exist", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "13")
        file(invoice.invoiceId, "NATIVE_ATTACH_INTERNAL", "Internal.txt", new Uint8Array([73, 110, 116]))
        const sent = native("send#Invoice", parameters(invoice, "native-attachments-default"))
        const files = helper().lib.rows("moqui.basic.email.EmailMessageAttachment", {
            emailMessageId: sent.recipientResults[0].emailMessageId
        })
        return {files, sent}
    },
    then({files, sent}) {
        files.length == 1
        files[0].fileName.endsWith(".pdf")
        sent.attachmentRows.length == 0
    }
})
feature("selected exact binary bytes survive source mutation and deletion for every recipient and retry", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "14")
        selectedContent = file(invoice.invoiceId, "NATIVE_ATTACH_FROZEN", "Evidence.bin", new Uint8Array([0, 255, 128, 10]))
        extraContent = file(invoice.invoiceId, "NATIVE_ATTACH_EXTRA", "Unselected.txt", new Uint8Array([78, 111]))
        const available = choices(invoice.invoiceId)
        const chosen = available.attachmentRows.find(row => row.invoiceContentId == selectedContent.id)
        selectedParameters = parameters(invoice, "native-attachments-frozen", [chosen.invoiceContentId], {
            [chosen.invoiceContentId]: chosen.attachmentVersion
        })
        selectedParameters.toAddresses = "first@example.com,second@example.com,bad-address"
        const prepared = native("prepare#InvoiceDelivery", selectedParameters)
        ec.resource.getLocationReference(selectedContent.location).putBytes(new Uint8Array([67, 104, 97, 110, 103, 101, 100]))
        helper().call("delete#mantle.account.invoice.InvoiceContent", {invoiceContentId: selectedContent.id})
        ec.resource.getLocationReference(selectedContent.location).delete()
        const before = capture.count()
        issued = native("send#Invoice", selectedParameters)
        const replay = native(
            "send#Invoice",
            Object.assign({}, selectedParameters, {
                attachmentContentIdList: [
                    ...selectedParameters.attachmentContentIdList,
                    ...selectedParameters.attachmentContentIdList
                ],
                attachmentVersions: Object.assign({UNSELECTED: "unrelated change"}, selectedParameters.attachmentVersions)
            })
        )
        const files = issued.recipientResults
            .filter(row => row.emailMessageId)
            .map(row => helper().lib.rows("moqui.basic.email.EmailMessageAttachment", {emailMessageId: row.emailMessageId}))
        const bytes = files.map(list => {
            const attachment = list.find(row => row.fileName == "Evidence.bin")
            const stream = ec.resource.getLocationReference(attachment.attachmentLocation).getInputStream()
            try {
                return StringUtilities.base64Encode(stream.readAllBytes())
            } finally {
                stream.close()
            }
        })
        const detail = native("get#InvoiceFinanceDetail", {invoiceId: invoice.invoiceId})
        return {issued, replay, files, bytes, count: capture.count() - before, detail, prepared}
    },
    then({issued, replay, files, bytes, count, detail, prepared}) {
        issued.deliveryId == prepared.deliveryId
        issued.successCount == 2
        issued.failureCount == 1
        count == 2
        files.every(rows => rows.length == 2 && !rows.some(row => row.fileName == "Unselected.txt"))
        bytes.every(value => value == "AP+ACg==")
        replay.alreadyApplied == true
        replay.attachmentRows[0].contentHash == issued.attachmentRows[0].contentHash
        detail.deliveryRows.some(row => row.attachments.some(item => item.fileName == "Evidence.bin" && item.contentHash))
        detail.deliveryRows.every(row => row.attachments.every(item => item.attachmentLocation == null))
    }
})
feature("same operation cannot change the selected supporting file set", {
    when() {
        login(f.users.ar)
        const option = choices(selectedParameters.invoiceId).attachmentRows.find(row => row.invoiceContentId == extraContent.id)
        const before = capture.count()
        const denied = helper().rejected(
            "mantle.account.InvoiceServices.send#Invoice",
            Object.assign({}, selectedParameters, {
                attachmentContentIdList: [option.invoiceContentId],
                attachmentVersions: {[option.invoiceContentId]: option.attachmentVersion}
            })
        )
        return {denied, count: capture.count() - before}
    },
    then({denied, count}) {
        denied.includes("OPERATION_KEY_CONFLICT")
        count == 0
    }
})
feature("wrong-invoice stale missing and external supporting files refuse before invoice issuance", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "15"),
            other = helper().draft(f, "16")
        const foreign = file(other.invoiceId, "NATIVE_ATTACH_FOREIGN", "Other.txt", new Uint8Array([1]))
        const local = file(invoice.invoiceId, "NATIVE_ATTACH_STALE", "Current.txt", new Uint8Array([1]))
        const version = choices(invoice.invoiceId).attachmentRows[0].attachmentVersion
        ec.resource.getLocationReference(local.location).putBytes(new Uint8Array([2]))
        const failures = []
        failures.push(
            helper().rejected(
                "mantle.account.InvoiceServices.send#Invoice",
                parameters(invoice, "native-attach-foreign", [foreign.id], {[foreign.id]: "reviewed"})
            )
        )
        failures.push(
            helper().rejected(
                "mantle.account.InvoiceServices.send#Invoice",
                parameters(invoice, "native-attach-stale", [local.id], {[local.id]: version})
            )
        )
        ec.resource.getLocationReference(local.location).delete()
        failures.push(
            helper().rejected(
                "mantle.account.InvoiceServices.send#Invoice",
                parameters(invoice, "native-attach-missing", [local.id], {[local.id]: version})
            )
        )
        helper().call("create#mantle.account.invoice.InvoiceContent", {
            invoiceContentId: "NATIVE_ATTACH_URL",
            invoiceId: invoice.invoiceId,
            contentLocation: "https://example.com/private.pdf"
        })
        failures.push(
            helper().rejected(
                "mantle.account.InvoiceServices.send#Invoice",
                parameters(invoice, "native-attach-url", ["NATIVE_ATTACH_URL"], {NATIVE_ATTACH_URL: "reviewed"})
            )
        )
        return {
            failures,
            stored: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId}),
            deliveries: helper().lib.rows("mantle.account.invoice.InvoiceDelivery", {invoiceId: invoice.invoiceId})
        }
    },
    then({failures, stored, deliveries}) {
        failures[0].includes("ATTACHMENT_UNAVAILABLE")
        failures[1].includes("STALE_ATTACHMENT")
        failures[2].includes("ATTACHMENT_UNAVAILABLE")
        failures[3].includes("ATTACHMENT_LOCATION_INVALID")
        stored.statusId == "InvoiceInProcess"
        deliveries.length == 0
    }
})
feature("attachment count per-file and aggregate byte limits refuse before issuance", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "17")
        const ids = Array.from({length: 11}, (_, i) => "NATIVE_ATTACH_COUNT_" + i)
        const count = helper().rejected(
            "mantle.account.InvoiceServices.send#Invoice",
            parameters(invoice, "native-attach-count", ids, Object.fromEntries(ids.map(id => [id, "reviewed"])))
        )
        const large = file(invoice.invoiceId, "NATIVE_ATTACH_LARGE", "Large.bin", new Uint8Array(10485761))
        const size = helper().rejected(
            "mantle.account.InvoiceServices.send#Invoice",
            parameters(invoice, "native-attach-size", [large.id], {[large.id]: "reviewed"})
        )
        const aggregateIds = [],
            versions = {}
        for (let index = 0; index < 3; index++) {
            const content = file(
                invoice.invoiceId,
                "NATIVE_ATTACH_TOTAL_" + index,
                "Part" + index + ".bin",
                new Uint8Array(7340032)
            )
            aggregateIds.push(content.id)
            versions[content.id] = choices(invoice.invoiceId, [content.id]).attachmentRows[0].attachmentVersion
        }
        const total = helper().rejected(
            "mantle.account.InvoiceServices.send#Invoice",
            parameters(invoice, "native-attach-total", aggregateIds, versions)
        )
        return {count, size, total, stored: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId})}
    },
    then({count, size, total, stored}) {
        count.includes("ATTACHMENT_COUNT_LIMIT")
        size.includes("ATTACHMENT_SIZE_LIMIT")
        total.includes("ATTACHMENT_TOTAL_SIZE_LIMIT")
        stored.statusId == "InvoiceInProcess"
    }
})
feature("new operation delivery claims distinguish reviewed file sets and deduplicate the same set", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "18")
        const a = file(invoice.invoiceId, "NATIVE_ATTACH_SET_A", "A.txt", new Uint8Array([65]))
        const b = file(invoice.invoiceId, "NATIVE_ATTACH_SET_B", "B.txt", new Uint8Array([66]))
        const options = choices(invoice.invoiceId),
            versions = Object.fromEntries(options.attachmentRows.map(row => [row.invoiceContentId, row.attachmentVersion]))
        const first = native("send#Invoice", parameters(invoice, "native-attach-set-first", [a.id], versions))
        const before = capture.count()
        const duplicate = native("send#Invoice", parameters(invoice, "native-attach-set-duplicate", [a.id], versions))
        const duplicateCount = capture.count() - before
        const changed = native("send#Invoice", parameters(invoice, "native-attach-set-changed", [b.id], versions))
        return {first, duplicate, changed, duplicateCount, changedCount: capture.count() - before}
    },
    then({first, duplicate, changed, duplicateCount, changedCount}) {
        duplicateCount == 0
        duplicate.recipientResults[0].emailMessageId == first.recipientResults[0].emailMessageId
        changedCount == 1
        changed.recipientResults[0].emailMessageId != first.recipientResults[0].emailMessageId
        changed.attachmentRows[0].fileName == "B.txt"
    }
})
feature("issued PDFs and supporting delivery copies live outside the mutable invoice file folder", {
    when() {
        const delivery = helper().lib.one("mantle.account.invoice.InvoiceDelivery", {deliveryId: issued.deliveryId})
        const content = helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: issued.invoiceContentId})
        const manifest = JSON.parse(delivery.sourceJson).attachmentManifest
        return {delivery, content, manifest}
    },
    then({delivery, content, manifest}) {
        content.isImmutable == "Y"
        content.contentLocation == delivery.contentLocation
        delivery.contentLocation.startsWith("dbresource://mantle/content/invoice-issued/" + delivery.invoiceId + "/")
        !delivery.contentLocation.startsWith("dbresource://mantle/content/invoice/" + delivery.invoiceId + "/")
        manifest.every(row =>
            row.attachmentLocation.startsWith("dbresource://mantle/content/invoice-issued/" + delivery.invoiceId + "/")
        )
    }
})
feature("native issued-content guards refuse raw deletion identity changes and file saves before bytes are written", {
    when() {
        login(f.users.ar)
        const content = helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: issued.invoiceContentId})
        const before = ec.resource.digest(content.contentLocation, "sha256")
        const key = {invoiceContentId: content.invoiceContentId}
        const failures = [
            helper().rejected("delete#mantle.account.invoice.InvoiceContent", key),
            helper().rejected(
                "update#mantle.account.invoice.InvoiceContent",
                Object.assign({}, key, {contentLocation: "dbresource://mantle/content/replaced.pdf"})
            ),
            helper().rejected(
                "update#mantle.account.invoice.InvoiceContent",
                Object.assign({}, key, {invoiceId: "NOT_THE_ISSUED_INVOICE"})
            ),
            helper().rejected("update#mantle.account.invoice.InvoiceContent", Object.assign({}, key, {isImmutable: "N"}))
        ]
        const temporaryRoot = "file:///private/tmp/accounting-issued-save-" + ec.user.randomString(16)
        const previousRoot = ec.user.getPreference("mantle.content.root")
        const target = temporaryRoot + "/invoice/" + content.invoiceId + "/content_" + content.invoiceContentId + "/Overwrite.txt"
        try {
            ec.user.setPreference("mantle.content.root", temporaryRoot)
            failures.push(
                helper().rejected(
                    "mantle.account.InvoiceServices.update#InvoiceContent",
                    Object.assign({}, key, {contentFile: uploadedFile("Overwrite.txt", "Changed issued file")})
                )
            )
            failures.push(
                helper().rejected(
                    "mantle.account.InvoiceServices.save#InvoiceContentFile",
                    Object.assign({}, key, {
                        invoiceId: content.invoiceId,
                        saveContentLocation: false,
                        contentFile: uploadedFile("Overwrite.txt", "Changed issued file")
                    })
                )
            )
        } finally {
            ec.user.setPreference("mantle.content.root", previousRoot)
        }
        native("update#InvoiceContent", Object.assign({}, key, {description: "Retained issued PDF evidence"}))
        const after = helper().lib.one("mantle.account.invoice.InvoiceContent", key)
        return {
            failures,
            before,
            afterDigest: ec.resource.digest(after.contentLocation, "sha256"),
            after,
            exists: ec.resource.getLocationReference(target).getExists()
        }
    },
    then({failures, before, afterDigest, after, exists}) {
        failures.length == 6
        failures.every(message => message.includes("ISSUED_INVOICE_IMMUTABLE"))
        before == afterDigest
        after.isImmutable == "Y"
        after.description == "Retained issued PDF evidence"
        exists == false
    }
})
feature("mutable content cannot alias private delivery evidence while ordinary supporting files remain editable", {
    when() {
        login(f.users.ar)
        const delivery = helper().lib.one("mantle.account.invoice.InvoiceDelivery", {deliveryId: issued.deliveryId})
        const manifest = JSON.parse(delivery.sourceJson).attachmentManifest
        const mainAlias = helper().rejected("create#mantle.account.invoice.InvoiceContent", {
            invoiceContentId: "NATIVE_ATTACH_ALIAS_PDF",
            invoiceId: delivery.invoiceId,
            contentLocation: delivery.contentLocation,
            isImmutable: "N"
        })
        const supportAlias = helper().rejected("create#mantle.account.invoice.InvoiceContent", {
            invoiceContentId: "NATIVE_ATTACH_ALIAS_SUPPORT",
            invoiceId: delivery.invoiceId,
            contentLocation: manifest[0].attachmentLocation,
            isImmutable: "N"
        })
        const aliases = []
        for (const [kind, location] of [
            ["PDF", delivery.contentLocation],
            ["SUPPORT", manifest[0].attachmentLocation]
        ]) {
            for (const [spelling, equivalent] of [
                ["SLASHES", location.replace("mantle/content/", "mantle//content//")],
                ["PREFIX", "dbresource:" + location.slice("dbresource://".length)],
                ["BOTH", "dbresource:////" + location.slice("dbresource://".length).replaceAll("/", "//") + "/"]
            ])
                aliases.push(
                    helper().rejected("create#mantle.account.invoice.InvoiceContent", {
                        invoiceContentId: "NATIVE_ALIAS_" + kind + "_" + spelling,
                        invoiceId: delivery.invoiceId,
                        contentLocation: equivalent,
                        isImmutable: "N"
                    })
                )
        }
        native("update#InvoiceContent", {
            invoiceContentId: extraContent.id,
            contentFile: uploadedFile("Editable.txt", "Updated live supporting file")
        })
        const live = helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: extraContent.id})
        const updated = ec.resource.getLocationReference(live.contentLocation).getText()
        helper().call("delete#mantle.account.invoice.InvoiceContent", {invoiceContentId: extraContent.id})
        ec.resource.getLocationReference(live.contentLocation).delete()
        return {
            mainAlias,
            supportAlias,
            aliases,
            updated,
            deleted: helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: extraContent.id}) == null,
            archivedStillExists: ec.resource.getLocationReference(manifest[0].attachmentLocation).getExists()
        }
    },
    then({mainAlias, supportAlias, aliases, updated, deleted, archivedStillExists}) {
        mainAlias.includes("ISSUED_INVOICE_IMMUTABLE")
        supportAlias.includes("ISSUED_INVOICE_IMMUTABLE")
        aliases.length == 6
        aliases.every(message => message.includes("ISSUED_INVOICE_IMMUTABLE"))
        updated == "Updated live supporting file"
        deleted == true
        archivedStillExists == true
    }
})
