// Issued payment bytes remain immutable through the resource facade and generic storage entity writers.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const NODE = "moqui.resource.DbResource"
const FILE = "moqui.resource.DbResourceFile"
const HISTORY = "moqui.resource.DbResourceFileHistory"
const BLOB = "moqui.resource.ContentBlob"
const CHUNK = "moqui.resource.ContentBlobChunk"
const CONTENT = "mantle.account.payment.PaymentContent"
const OUTPUT = "mantle.account.payment.PaymentIssuedOutput"
let f, paymentId, issued, evidence, supporting, evidenceBytes

function bytes(location) {
    const stream = ec.resource.getLocationReference(location).getInputStream()
    if (!stream) throw new Error("Archive fixture has no readable bytes at " + location)
    try {
        return stream.readAllBytes()
    } finally {
        stream.close()
    }
}
function digest(data) {
    return data == null ? null : helper().lib.hash(StringUtilities.base64Encode(data))
}
function nodeAt(location) {
    const parts = String(location)
        .replace(/^dbresource:(\/\/)?/, "")
        .split("/")
        .filter(Boolean)
    let parentResourceId = null,
        result = null
    for (const filename of parts) {
        result = helper().lib.one(NODE, {parentResourceId, filename})
        if (!result) throw new Error("Archive fixture is missing a resource node: " + location)
        parentResourceId = result.resourceId
    }
    return result
}
function archive(location) {
    const h = helper(),
        node = nodeAt(location),
        file = h.lib.one(FILE, {resourceId: node.resourceId})
    if (!file) throw new Error("Archive fixture has no DbResourceFile")
    const histories = h.lib.rows(HISTORY, {resourceId: node.resourceId})
    return {
        location,
        resourceId: node.resourceId,
        file,
        histories,
        snapshot: JSON.stringify({
            node: h.lib.map(node),
            bytes: digest(bytes(location)),
            file: h.lib.policy.pick(h.lib.map(file), [
                "resourceId",
                "blobId",
                "fileSize",
                "mimeType",
                "versionName",
                "rootVersionName",
                "versionNote",
                "lastUpdatedStamp"
            ]),
            fileData: digest(file.fileData),
            histories: histories.map(row => ({
                row: h.lib.policy.pick(h.lib.map(row), [
                    "resourceId",
                    "versionName",
                    "previousVersionName",
                    "isDiff",
                    "versionDate",
                    "userId",
                    "versionNote",
                    "blobId",
                    "lastUpdatedStamp"
                ]),
                bytes: digest(row.fileData)
            }))
        })
    }
}
function retained() {
    return JSON.stringify({
        issued: archive(issued.contentLocation).snapshot,
        evidence: archive(evidence.archiveLocation).snapshot,
        output: helper().lib.map(helper().lib.one(OUTPUT, {paymentOutputId: issued.paymentOutputId}))
    })
}
function attempt(request) {
    return parallel(
        1,
        (thread, args) => {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            try {
                if (args.kind === "resource") {
                    const ref = ec.resource.getLocationReference(args.location)
                    if (args.action === "putText") ref.putText("Unreviewed replacement")
                    else if (args.action === "putBytes") ref.putBytes(new Uint8Array([0, 255, 128, 10]))
                    else if (args.action === "sameBytes") {
                        const stream = ref.getInputStream()
                        let original
                        try {
                            original = stream.readAllBytes()
                        } finally {
                            stream.close()
                        }
                        ref.putBytes(original)
                    } else if (args.action === "delete") ref.delete()
                    else if (args.action === "move") ref.move(args.newLocation)
                    else if (args.action === "restore")
                        ec.resource.restoreVersion(args.location, "01", "Archive immutability proof")
                    else throw new Error("Unknown resource operation")
                } else {
                    const values = Object.assign({}, args.values)
                    if (args.binaryField) values[args.binaryField] = new Uint8Array([0, 255, 128, 10])
                    if (args.sameBinaryField) {
                        const row = ec.entity.find(args.entity).condition(args.key).one()
                        values[args.sameBinaryField] = row[args.sameBinaryField]
                    }
                    if (args.writer === "generic") {
                        const result = ec.service
                            .sync()
                            .name(args.action + "#" + args.entity)
                            .parameters(values)
                            .requireNewTransaction(true)
                            .throwOnError(true)
                            .call()
                        if (ec.message.hasError()) throw new Error(ec.message.errorsString)
                    } else {
                        const value = ec.entity.makeValue(args.entity)
                        for (const [field, input] of Object.entries(values)) value.set(field, input)
                        if (args.action === "createOrUpdate") value.createOrUpdate()
                        else if (args.action === "create") value.create()
                        else if (args.action === "delete") value.delete()
                        else value.update()
                    }
                }
                return ""
            } catch (error) {
                ec.message.clearErrors()
                return error.message
            }
        },
        request,
        {transaction: true, timeout: 30}
    )[0]
}
function mutableFile(name, data = new Uint8Array([65, 66, 67])) {
    const id = "ACCT_P5_ARCH_" + ec.user.randomString(20),
        location = "dbresource://mantle/content/payment/" + paymentId + "/content_" + id + "/" + name
    ec.resource.getLocationReference(location).putBytes(data)
    helper().call("create#" + CONTENT, {
        paymentContentId: id,
        paymentId,
        contentLocation: location,
        contentTypeEnumId: "PctPaymentDocument",
        description: name
    })
    return {paymentContentId: id, location}
}
function driveFixture() {
    const h = helper(),
        outgoing = h.draft(f, {cashDirection: "outgoing", paymentInstrumentEnumId: "PiCompanyCheck"}),
        peer = mutableFile("Payment-" + outgoing + "-visible.txt")
    h.confirm(h.preview(f, outgoing, "deliver"))
    const check = h.lib.one(OUTPUT, {paymentId: outgoing, outputType: "check"}),
        driveId = "ACCT_P5_ARCH_" + ec.user.randomString(20)
    if (!check) throw new Error("Archive read fixture requires an actual issued check")
    h.call("create#moqui.resource.ResourceDrive", {
        driveId,
        driveName: "Broad content archive test",
        driveKindEnumId: "RdkShared",
        rootLocation: "dbresource:////mantle//content",
        ownerUserId: f.users.paymentView,
        createdDate: ec.user.nowTimestamp
    })
    return {
        outgoing,
        peer,
        check,
        driveId,
        checkPath: check.contentLocation.slice("dbresource://mantle/content/".length),
        peerPath: peer.location.slice("dbresource://mantle/content/".length)
    }
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures("ACCT_P5_ARCHIVE")
        paymentId = h.draft(f)
        evidenceBytes = new Uint8Array(70000)
        for (let index = 0; index < evidenceBytes.length; index++) evidenceBytes[index] = index % 251
        supporting = mutableFile("Large-evidence.bin", evidenceBytes)
        const option = h.detail(f, paymentId).evidenceRows.find(row => row.paymentContentId === supporting.paymentContentId)
        if (!option?.version) throw new Error("Archive fixture needs a native-reviewed evidence revision")
        const review = h.preview(f, paymentId, "deliver", {
            evidenceContentIdList: [supporting.paymentContentId],
            evidenceVersions: {[supporting.paymentContentId]: option.version}
        })
        h.confirm(review, "archive-reviewed-delivery")
        issued = h.lib.one(OUTPUT, {paymentId, outputType: "receipt"})
        const event = h.lib.one("mantle.account.payment.PaymentLifecycleEvent", {paymentId, action: "deliver"})
        evidence = event && JSON.parse(event.evidenceJson || "[]")[0]
        if (!issued || !evidence?.archiveLocation)
            throw new Error("Archive fixture needs actual issued output and frozen evidence")
        if (!archive(evidence.archiveLocation).file.blobId)
            throw new Error("Archive fixture must exercise actual blob-backed bytes")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().settlement.base.cleanupLocks(f.org)
    }
})

feature("initial reviewed issuance creates readable PDF and exact private evidence with only the initial versions", {
    when() {
        const h = helper(),
            output = h.native("get#PaymentOutput", {organizationPartyId: f.org, paymentId, outputId: issued.paymentOutputId}),
            receipt = archive(issued.contentLocation),
            frozen = archive(evidence.archiveLocation),
            body = bytes(issued.contentLocation)
        return {output, receipt, frozen, header: String.fromCharCode(...body.slice(0, 5)), original: digest(evidenceBytes)}
    },
    then({output, receipt, frozen, header, original}) {
        header == "%PDF-"
        output.contentHash == digest(bytes(issued.contentLocation))
        output.approvedHtml.includes("Payment receipt")
        receipt.file.versionName == "01"
        receipt.histories.length == 1
        frozen.histories.length == 1
        frozen.file.blobId != null
        digest(bytes(evidence.archiveLocation)) == original
        evidence.archiveLocation.includes("/payment-issued/" + paymentId + "/evidence/")
    }
})

feature("resource #action refuses issued bytes while the same operation remains valid for supporting files", {
    where: [
        {action: "putText"},
        {action: "putBytes"},
        {action: "sameBytes"},
        {action: "delete"},
        {action: "move"},
        {action: "restore"}
    ],
    when({action}) {
        const original = retained(),
            file = mutableFile("Mutable-" + action + ".txt"),
            moved = file.location + ".moved",
            before = archive(file.location),
            checks = [issued.contentLocation, evidence.archiveLocation].map(location => ({
                refused: attempt({kind: "resource", action, location, newLocation: moved}),
                unchanged: retained() === original
            })),
            afterRefusal = retained(),
            allowed = attempt({kind: "resource", action, location: file.location, newLocation: moved})
        let positive
        if (action === "delete") positive = !ec.resource.getLocationReference(file.location).getExists()
        else if (action === "move")
            positive =
                !ec.resource.getLocationReference(file.location).getExists() &&
                digest(bytes(moved)) === digest(new Uint8Array([65, 66, 67]))
        else positive = archive(file.location).file.versionName !== before.file.versionName
        return {checks, allowed, positive, original, afterRefusal, final: retained()}
    },
    then({checks, allowed, positive, original, afterRefusal, final}) {
        checks.length == 2
        checks.every(check => check.refused.includes("ISSUED_PAYMENT_IMMUTABLE") && check.unchanged)
        allowed == ""
        positive == true
        afterRefusal == original
        final == original
    }
})

feature("canonical resource URI aliases retain exactly the same immutable issued bytes", {
    when() {
        const original = retained(),
            file = mutableFile("Alias-positive.txt"),
            alias = location => [
                location.replace("dbresource://", "dbresource:"),
                location.replace("/mantle/content/", "//mantle//content/"),
                location.replace("dbresource://", "dbresource:////")
            ]
        const checks = alias(issued.contentLocation).map(location => ({
                refused: attempt({kind: "resource", action: "putText", location}),
                unchanged: retained() === original
            })),
            allowed = alias(file.location).map(location => attempt({kind: "resource", action: "putText", location}))
        return {checks, allowed, text: ec.resource.getLocationReference(file.location).getText()}
    },
    then({checks, allowed, text}) {
        checks.length == 3
        checks.every(row => row.refused.includes("ISSUED_PAYMENT_IMMUTABLE") && row.unchanged)
        allowed.every(value => value === "")
        text == "Unreviewed replacement"
    }
})

feature("#writer cannot rewrite or remove issued resource files and initial version history", {
    where: [{writer: "generic"}, {writer: "raw"}],
    when({writer}) {
        const current = archive(issued.contentLocation),
            original = retained(),
            key = {resourceId: current.resourceId},
            historyKey = {resourceId: current.resourceId, versionName: "01"},
            checks = []
        for (const request of [
            {entity: FILE, action: "update", values: key, binaryField: "fileData"},
            {entity: FILE, action: "update", values: key, sameBinaryField: "fileData", key},
            {entity: FILE, action: "update", values: {...key, fileSize: Number(current.file.fileSize) + 1}},
            {entity: FILE, action: "delete", values: key},
            {entity: FILE, action: "createOrUpdate", values: key, binaryField: "fileData"},
            {entity: HISTORY, action: "update", values: historyKey, binaryField: "fileData"},
            {entity: HISTORY, action: "delete", values: historyKey},
            {
                entity: HISTORY,
                action: "create",
                values: {...key, versionName: "02", previousVersionName: "01", isDiff: "N"},
                binaryField: "fileData"
            }
        ]) {
            // The implicit entity service is named store, whereas the raw EntityValue method is createOrUpdate.
            const actual = {...request, writer}
            if (writer === "generic" && actual.action === "createOrUpdate") actual.action = "store"
            checks.push({refused: attempt(actual), unchanged: retained() === original})
        }
        const file = mutableFile("Entity-positive-" + writer + ".txt"),
            mutable = archive(file.location),
            allowed = attempt({
                writer,
                entity: FILE,
                action: "update",
                values: {resourceId: mutable.resourceId},
                binaryField: "fileData"
            })
        return {checks, allowed, positive: digest(bytes(file.location)) === digest(new Uint8Array([0, 255, 128, 10]))}
    },
    then({checks, allowed, positive}) {
        checks.length == 8
        checks.every(check => check.refused.includes("ISSUED_PAYMENT_IMMUTABLE") && check.unchanged)
        allowed == ""
        positive == true
    }
})

feature("ancestor moves and deletes cannot remove the issued archive identity", {
    when() {
        const original = retained(),
            checks = []
        for (const location of [
            "dbresource://mantle",
            "dbresource://mantle/content",
            "dbresource://mantle/content/payment-issued",
            "dbresource://mantle/content/payment-issued/" + paymentId
        ]) {
            const node = nodeAt(location)
            for (const action of ["delete", "update"])
                checks.push({
                    refused: attempt({
                        writer: "raw",
                        entity: NODE,
                        action,
                        values:
                            action === "delete"
                                ? {resourceId: node.resourceId}
                                : {resourceId: node.resourceId, filename: node.filename + "-moved"}
                    }),
                    unchanged: retained() === original
                })
            checks.push({
                refused: attempt({kind: "resource", action: "delete", location}),
                expectedRefusal: "directory is not empty: " + location,
                unchanged: retained() === original
            })
        }
        checks.push({
            refused: attempt({
                kind: "resource",
                action: "move",
                location: "dbresource://mantle/content/payment-issued/" + paymentId,
                newLocation: "dbresource://mantle/content/payment/" + paymentId + "/moved-archive"
            }),
            unchanged: retained() === original
        })
        const file = mutableFile("Node-positive.txt"),
            node = nodeAt(file.location),
            renamed = helper().call("update#" + NODE, {resourceId: node.resourceId, filename: "Renamed-positive.txt"}),
            positive = ec.resource
                .getLocationReference(file.location.replace("Node-positive.txt", "Renamed-positive.txt"))
                .getExists()
        return {checks, positive}
    },
    then({checks, positive}) {
        checks.length == 13
        checks.every(
            check =>
                check.unchanged &&
                (check.expectedRefusal
                    ? check.refused === check.expectedRefusal
                    : check.refused.includes("ISSUED_PAYMENT_IMMUTABLE"))
        )
        positive == true
    }
})

feature("reserved resource paths cannot be forged or reached by moving an ordinary supporting file", {
    when() {
        const original = retained(),
            file = mutableFile("Path-positive.txt"),
            leaf = nodeAt(file.location),
            archiveParent = nodeAt(issued.contentLocation.slice(0, issued.contentLocation.lastIndexOf("/"))),
            requests = [
                {kind: "resource", action: "putText", location: issued.contentLocation + ".forged"},
                {kind: "resource", action: "move", location: file.location, newLocation: issued.contentLocation + ".forged"},
                {
                    writer: "raw",
                    entity: NODE,
                    action: "update",
                    values: {resourceId: leaf.resourceId, parentResourceId: archiveParent.resourceId}
                },
                {
                    writer: "raw",
                    entity: NODE,
                    action: "create",
                    values: {
                        resourceId: "ACCT_P5_ARCH_FORGED",
                        parentResourceId: archiveParent.resourceId,
                        filename: "Forged.pdf",
                        isFile: "Y"
                    }
                }
            ],
            checks = requests.map(request => ({refused: attempt(request), unchanged: retained() === original})),
            supportingStillExists = ec.resource.getLocationReference(file.location).getExists(),
            allowed = attempt({
                kind: "resource",
                action: "move",
                location: file.location,
                newLocation: file.location + ".ordinary"
            })
        return {
            checks,
            supportingStillExists,
            allowed,
            positive: ec.resource.getLocationReference(file.location + ".ordinary").getExists()
        }
    },
    then({checks, supportingStillExists, allowed, positive}) {
        checks.length == 4
        checks.every(check => check.refused.includes("ISSUED_PAYMENT_IMMUTABLE") && check.unchanged)
        supportingStillExists == true
        allowed == ""
        positive == true
    }
})

feature("#writer cannot mutate shared blob metadata or chunks backing frozen evidence", {
    where: [{writer: "generic"}, {writer: "raw"}],
    when({writer}) {
        const h = helper(),
            frozen = archive(evidence.archiveLocation),
            original = retained(),
            blob = h.lib.one(BLOB, {blobId: frozen.file.blobId}),
            chunk = h.lib.find(CHUNK, {storageKey: blob.storageKey}).orderBy("chunkSeq").one(),
            blobKey = {blobId: blob.blobId},
            chunkKey = {storageKey: chunk.storageKey, chunkSeq: chunk.chunkSeq},
            checks = []
        for (const request of [
            {entity: BLOB, action: "update", values: {...blobKey, blobSize: Number(blob.blobSize) + 1}},
            {entity: BLOB, action: "update", values: {...blobKey, storageKey: "Unreviewed-blob-storage"}},
            {entity: BLOB, action: "delete", values: blobKey},
            {entity: CHUNK, action: "update", values: chunkKey, binaryField: "chunkData"},
            {entity: CHUNK, action: "update", values: chunkKey, sameBinaryField: "chunkData", key: chunkKey},
            {entity: CHUNK, action: "delete", values: chunkKey}
        ])
            checks.push({refused: attempt({...request, writer}), unchanged: retained() === original})
        // Blob deduplication may refresh its stamp, and ordinary files sharing that blob may still be replaced.
        const stampAllowed = attempt({writer, entity: BLOB, action: "update", values: blobKey}),
            replacementAllowed = attempt({kind: "resource", action: "putBytes", location: supporting.location}),
            copied = mutableFile("Deduplicated-positive.bin", evidenceBytes)
        return {
            checks,
            stampAllowed,
            replacementAllowed,
            positive: digest(bytes(copied.location)) === evidence.contentHash,
            unchanged: retained() === original
        }
    },
    then({checks, stampAllowed, replacementAllowed, positive, unchanged}) {
        checks.length == 6
        checks.every(check => check.refused.includes("ISSUED_PAYMENT_IMMUTABLE") && check.unchanged)
        stampAllowed == ""
        replacementAllowed == ""
        positive == true
        unchanged == true
    }
})

feature("existing aliased broad drives cannot read issued checks while ordinary peer search and downloads remain useful", {
    when() {
        const h = helper(),
            fixture = driveFixture(),
            service = "org.moqui.impl.FileServices.",
            parameters = {driveId: fixture.driveId, path: fixture.checkPath}
        login(f.users.paymentView)
        const access = h.call(service + "get#DriveAccess", parameters),
            unavailable = ["get#ResourceInfo", "get#Versions", "get#Preview"].map(name => h.rejected(service + name, parameters)),
            zip = h.rejected(service + "download#Zip", {driveId: fixture.driveId, path: ""}),
            nativeDenied = h.rejected("get#PaymentOutput", {
                organizationPartyId: f.org,
                paymentId: fixture.outgoing,
                outputId: fixture.check.paymentOutputId
            }),
            folder = h.call(service + "list#Folder", {driveId: fixture.driveId, path: ""}),
            scoped = h.call(service + "find#Resources", {
                driveId: fixture.driveId,
                text: "Payment-" + fixture.outgoing,
                limit: 1
            }),
            global = h.call(service + "find#Resources", {text: "Payment-" + fixture.outgoing, limit: 1}),
            ordinary = h.call(service + "get#ResourceInfo", {driveId: fixture.driveId, path: fixture.peerPath}),
            ordinaryZip = h.call(service + "download#Zip", {driveId: fixture.driveId, path: fixture.peerPath})
        login(f.users.treasury)
        const approved = h.native("get#PaymentOutput", {
            organizationPartyId: f.org,
            paymentId: fixture.outgoing,
            outputId: fixture.check.paymentOutputId
        })
        return {fixture, access, unavailable, zip, nativeDenied, folder, scoped, global, ordinary, ordinaryZip, approved}
    },
    then({fixture, access, unavailable, zip, nativeDenied, folder, scoped, global, ordinary, ordinaryZip, approved}) {
        access.level == 0
        unavailable.length == 3
        unavailable.every(error => error.toLowerCase().includes("not found"))
        zip.includes("PAYMENT_ARCHIVE_PRIVATE")
        nativeDenied.includes("PERMISSION_DENIED")
        folder.fileList.some(row => row.name === "payment")
        !folder.fileList.some(row => row.name === "payment-issued")
        scoped.resultList.length == 1
        scoped.resultList[0].path == fixture.peerPath
        global.resultList.length == 1
        global.resultList[0].path == fixture.peerPath
        digest(bytes(ordinary.resource.location)) == digest(new Uint8Array([65, 66, 67]))
        ordinaryZip.fileCount == 1
        approved.outputId == fixture.check.paymentOutputId
        approved.outputType == "check"
        approved.contentHash == digest(bytes(fixture.check.contentLocation))
    }
})

feature("existing exact and ancestor public shares cannot expose the archive while ordinary supporting shares still download", {
    when() {
        const h = helper(),
            fixture = driveFixture(),
            service = "org.moqui.impl.FileServices.",
            tokens = []
        for (const path of [fixture.checkPath, ""]) {
            const token = ec.user.randomString(32)
            tokens.push(token)
            // Model existing administrator-created shares; a new normal share is already refused by the service hook.
            h.call("create#moqui.resource.ResourceShare", {
                shareId: "ACCT_P5_ARCH_" + ec.user.randomString(20),
                driveId: fixture.driveId,
                path,
                isDirectory: path ? "N" : "Y",
                isLink: "Y",
                linkTokenHash: ec.user.singleUseCodeHash(token),
                permissionEnumId: "RspView",
                createdByUserId: ec.user.userId,
                createdDate: ec.user.nowTimestamp
            })
        }
        login(f.users.paymentView)
        const checks = tokens.map(token => ({
                valid: h.call(service + "check#PublicShareToken", {token}).valid,
                list: h.rejected(service + "list#PublicShare", {token}),
                download: h.rejected(service + "download#PublicShare", {token})
            })),
            newShare = h.rejected(service + "share#Resource", {driveId: fixture.driveId, path: fixture.checkPath, isLink: "Y"}),
            ordinary = h.call(service + "share#Resource", {driveId: fixture.driveId, path: fixture.peerPath, isLink: "Y"}),
            positive = h.call(service + "download#PublicShare", {token: ordinary.linkToken})
        return {checks, newShare, positive, fixture}
    },
    then({checks, newShare, positive, fixture}) {
        checks.length == 2
        checks.every(
            check =>
                check.valid === false &&
                check.list.toLowerCase().includes("not found") &&
                check.download.toLowerCase().includes("not found")
        )
        newShare.includes("PAYMENT_ARCHIVE_PRIVATE")
        digest(bytes(positive.location)) == digest(new Uint8Array([65, 66, 67]))
        positive.fileName == fixture.peer.location.slice(fixture.peer.location.lastIndexOf("/") + 1)
    }
})
