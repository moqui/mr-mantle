// A first private archive reference must serialize with mutations of its already-published supporting blob.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const NODE = "moqui.resource.DbResource"
const FILE = "moqui.resource.DbResourceFile"
const HISTORY = "moqui.resource.DbResourceFileHistory"
const BLOB = "moqui.resource.ContentBlob"
const CHUNK = "moqui.resource.ContentBlobChunk"
const OUTPUT = "mantle.account.payment.PaymentIssuedOutput"
let f

function bytes(location) {
    const stream = ec.resource.getLocationReference(location).getInputStream()
    if (!stream) throw new Error("Archive race has no readable bytes at " + location)
    try {
        return stream.readAllBytes()
    } finally {
        stream.close()
    }
}
function digest(data) {
    return helper().lib.hash(StringUtilities.base64Encode(data))
}
function nodeAt(location) {
    let parentResourceId = null,
        node
    for (const filename of location
        .replace(/^dbresource:(\/\/)?/, "")
        .split("/")
        .filter(Boolean)) {
        node = helper().lib.one(NODE, {parentResourceId, filename})
        if (!node) throw new Error("Archive race is missing a resource node: " + location)
        parentResourceId = node.resourceId
    }
    return node
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_BLOBRACE")
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

feature("first issued evidence reference blocks a competing generic #mutation until commit and preserves exact shared bytes", {
    where: [{mutation: "chunk"}, {mutation: "metadata"}],
    timeout: 60,
    when({mutation}) {
        const h = helper(),
            paymentId = h.draft(f),
            contentId = "ACCT_P5_BR_" + ec.user.randomString(20),
            seed = mutation + "-" + ec.user.randomString(30),
            data = new Uint8Array(70000),
            location = "dbresource://mantle/content/payment/" + paymentId + "/content_" + contentId + "/Evidence.bin"
        for (let index = 0; index < data.length; index++) data[index] = (index + seed.charCodeAt(index % seed.length)) % 251
        ec.resource.getLocationReference(location).putBytes(data)
        h.call("create#mantle.account.payment.PaymentContent", {
            paymentContentId: contentId,
            paymentId,
            contentLocation: location,
            contentTypeEnumId: "PctPaymentDocument",
            description: "Unique large supporting evidence for " + mutation + " first-reference race"
        })
        const sourceNode = nodeAt(location),
            sourceFile = h.lib.one(FILE, {resourceId: sourceNode.resourceId}),
            blob = sourceFile?.blobId && h.lib.one(BLOB, {blobId: sourceFile.blobId}),
            chunk = blob && h.lib.find(CHUNK, {storageKey: blob.storageKey}).orderBy("chunkSeq").one(),
            sourceHash = digest(data)
        assert(blob && chunk, "The first-reference race requires an actual published, chunk-backed supporting blob")
        assert(
            [FILE, HISTORY].every(entity =>
                h.lib.rows(entity, {blobId: blob.blobId}).every(row => row.resourceId === sourceNode.resourceId)
            ),
            "Unique evidence bytes must have no previously committed private archive reference"
        )
        const originalBlobSize = String(blob.blobSize),
            originalChunkHash = digest(chunk.chunkData),
            option = h.detail(f, paymentId).evidenceRows.find(row => row.paymentContentId === contentId)
        assert(option?.version, "The issuer must review the actual supporting-file revision")
        const review = h.preview(f, paymentId, "deliver", {
                evidenceContentIdList: [contentId],
                evidenceVersions: {[contentId]: option.version}
            }),
            latchType = "P5BR_" + ec.user.randomString(16),
            phaseId = latchType + "_PHASE",
            finishedId = latchType + "_DONE"
        h.call("create#moqui.basic.EnumerationType", {enumTypeId: latchType, description: "First archive blob race"})
        for (const [enumId, description] of [
            [phaseId, "ready"],
            [finishedId, "no"]
        ])
            h.call("create#moqui.basic.Enumeration", {enumId, enumTypeId: latchType, description})
        assert(ec.factory.waitWorkerPoolEmpty(50), "Payment draft workers did not drain before the first-reference race")
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                const read = enumId =>
                        ec.entity.find("moqui.basic.Enumeration").condition("enumId", enumId).useCache(false).one().description,
                    signal = (enumId, description) =>
                        ec.service
                            .sync()
                            .name("update#moqui.basic.Enumeration")
                            .parameters({enumId, description})
                            .requireNewTransaction(true)
                            .throwOnError(true)
                            .call(),
                    waitFor = (enumId, expected) => {
                        const deadline = Date.now() + 15000
                        while (read(enumId) !== expected && Date.now() < deadline) {}
                        if (read(enumId) !== expected) throw new Error("First-reference race did not reach " + expected)
                    }
                if (thread === 0) {
                    // Join this worker's outer transaction: issuance has returned but its private references remain uncommitted.
                    const result = ec.service
                        .sync()
                        .name("mantle.account.PaymentServices.change#PaymentState")
                        .parameters(args.confirm)
                        .throwOnError(true)
                        .call()
                    signal(args.phaseId, "staged")
                    waitFor(args.phaseId, "attempted")
                    const deadline = Date.now() + 1000
                    while (read(args.finishedId) !== "yes" && Date.now() < deadline) {}
                    // Returning commits the financial operation and releases the shared archive ancestor locks.
                    return {result, blockedBeforeCommit: read(args.finishedId) !== "yes"}
                }
                waitFor(args.phaseId, "staged")
                const visibleOutputCount = ec.entity
                    .find("mantle.account.payment.PaymentIssuedOutput")
                    .condition("paymentId", args.paymentId)
                    .useCache(false)
                    .count()
                if (visibleOutputCount !== 0) throw new Error("Native issuance unexpectedly committed before the race")
                signal(args.phaseId, "attempted")
                let failure = ""
                try {
                    let entity, values
                    if (args.mutation === "chunk") {
                        entity = "moqui.resource.ContentBlobChunk"
                        const original = ec.entity
                                .find(entity)
                                .condition({storageKey: args.storageKey, chunkSeq: args.chunkSeq})
                                .useCache(false)
                                .one(),
                            changed = new Uint8Array(original.chunkData)
                        changed[0] = changed[0] ^ 255
                        values = {storageKey: args.storageKey, chunkSeq: args.chunkSeq, chunkData: changed}
                    } else {
                        entity = "moqui.resource.ContentBlob"
                        values = {blobId: args.blobId, blobSize: args.blobSize + 1}
                    }
                    // A refusal must roll back only this probe, leaving the worker's coordination transaction usable.
                    ec.service
                        .sync()
                        .name("update#" + entity)
                        .parameters(values)
                        .requireNewTransaction(true)
                        .throwOnError(true)
                        .call()
                } catch (error) {
                    failure = String(error.message)
                    ec.message.clearErrors()
                }
                signal(args.finishedId, "yes")
                return {failure, visibleOutputCount}
            },
            {
                mutation,
                paymentId,
                phaseId,
                finishedId,
                blobId: blob.blobId,
                blobSize: Number(String(blob.blobSize)),
                storageKey: blob.storageKey,
                chunkSeq: chunk.chunkSeq,
                confirm: {
                    previewId: review.previewId,
                    inputFingerprint: review.inputFingerprint,
                    operationKey: "archive-blob-race-" + mutation
                }
            },
            {transaction: true, timeout: 45}
        )
        const event = h.lib.one("mantle.account.payment.PaymentLifecycleEvent", {paymentId, action: "deliver"}),
            frozen = event && JSON.parse(event.evidenceJson || "[]").find(row => row.paymentContentId === contentId),
            outputs = h.lib.rows(OUTPUT, {paymentId}),
            frozenFile = frozen && h.lib.one(FILE, {resourceId: nodeAt(frozen.archiveLocation).resourceId}),
            unchangedBlobSize = String(h.lib.find(BLOB, {blobId: blob.blobId}).useCache(false).one().blobSize),
            unchangedChunkHash = digest(
                h.lib.find(CHUNK, {storageKey: blob.storageKey, chunkSeq: chunk.chunkSeq}).useCache(false).one().chunkData
            ),
            issuedHash = frozen && digest(bytes(frozen.archiveLocation)),
            outputHashesValid = outputs.length > 0 && outputs.every(row => digest(bytes(row.contentLocation)) === row.contentHash)
        // Replacing an ordinary supporting file publishes new bytes; it must remain allowed after the shared old blob is archived.
        const replacement = new Uint8Array(data)
        replacement[1] = replacement[1] ^ 255
        ec.resource.getLocationReference(location).putBytes(replacement)
        return {
            results,
            frozen,
            outputs,
            sharedBlob: frozenFile?.blobId === blob.blobId,
            sourceHash,
            issuedHash,
            outputHashesValid,
            originalBlobSize,
            unchangedBlobSize,
            originalChunkHash,
            unchangedChunkHash,
            replacementHash: digest(bytes(location)),
            expectedReplacementHash: digest(replacement),
            retainedHash: frozen && digest(bytes(frozen.archiveLocation))
        }
    },
    then({
        results,
        frozen,
        outputs,
        sharedBlob,
        sourceHash,
        issuedHash,
        outputHashesValid,
        originalBlobSize,
        unchangedBlobSize,
        originalChunkHash,
        unchangedChunkHash,
        replacementHash,
        expectedReplacementHash,
        retainedHash
    }) {
        results.length == 2
        results[0].result.statusId == "PmntDelivered"
        results[0].blockedBeforeCommit == true
        results[1].visibleOutputCount == 0
        results[1].failure.includes("ISSUED_PAYMENT_IMMUTABLE")
        sharedBlob == true
        frozen.contentHash == sourceHash
        issuedHash == sourceHash
        originalBlobSize == unchangedBlobSize
        originalChunkHash == unchangedChunkHash
        outputHashesValid == true
        outputs.every(row => row.contentLocation.includes("/payment-issued/"))
        replacementHash == expectedReplacementHash
        replacementHash != sourceHash
        retainedHash == sourceHash
    }
})
