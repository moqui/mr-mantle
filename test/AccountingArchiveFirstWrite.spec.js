// Run before any reviewed payment delivery: the first archive must serialize with ordinary ancestor identity changes.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const NODE = "moqui.resource.DbResource"
let f
spec({
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().settlement.base.cleanupLocks(f.org)
    }
})

feature("the first real issued archive refuses a competing moved ancestor before any financial commit and retries safely", {
    when() {
        const h = helper()
        assert(
            !h.lib.one(NODE, {parentResourceId: "MANTLE_CONTENT", filename: "payment-issued"}),
            "First-write concurrency proof must run before every reviewed payment delivery"
        )
        assert(
            !h.lib.find("mantle.account.payment.PaymentIssuedOutput").count(),
            "First-write concurrency proof requires a fresh issued-output history"
        )
        f = h.fixtures("ACCT_P5_ARCHFIRST")
        const id = h.draft(f)
        assert(ec.factory.waitWorkerPoolEmpty(50), "Payment draft workers did not drain before archive race")
        const review = h.preview(f, id, "deliver"),
            operationKey = "archive-first-race",
            latchId = "ACCT_P5_ARCHFIRST_LATCH",
            original = JSON.stringify(h.lib.map(h.lib.one("mantle.account.payment.Payment", {paymentId: id}))),
            eventCount = h.count("mantle.account.payment.PaymentLifecycleEvent", {paymentId: id})
        h.call("create#moqui.basic.EnumerationType", {enumTypeId: latchId, description: "Archive first-write test coordination"})
        h.call("create#moqui.basic.Enumeration", {enumId: latchId, enumTypeId: latchId, description: "ready"})
        const movedName = "content-ACCT_P5_ARCHFIRST"
        let results, failedState, transactionCount, outputCount, retainedEvents, moved, misplacedArchiveCount
        try {
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    const latch = () =>
                            ec.entity.find("moqui.basic.Enumeration").condition("enumId", args.latchId).useCache(false).one(),
                        signal = description =>
                            ec.service
                                .sync()
                                .name("update#moqui.basic.Enumeration")
                                .parameters({enumId: args.latchId, description})
                                .requireNewTransaction(true)
                                .throwOnError(true)
                                .call(),
                        waitFor = expected => {
                            const deadline = Date.now() + 15000
                            while (latch().description !== expected && Date.now() < deadline) {}
                            if (latch().description !== expected) throw new Error("Archive race did not reach " + expected)
                        }
                    if (thread === 0) {
                        // The real raw writer and native issuer must share this order and retain both locks to commit.
                        const mantle = ec.entity
                                .find("moqui.resource.DbResource")
                                .condition("resourceId", "MANTLE")
                                .forUpdate(true)
                                .one(),
                            content = ec.entity
                                .find("moqui.resource.DbResource")
                                .condition("resourceId", "MANTLE_CONTENT")
                                .forUpdate(true)
                                .one()
                        if (!mantle || !content || content.filename !== "content")
                            throw new Error("Missing canonical archive ancestors")
                        signal("raw-locked")
                        waitFor("native-started")
                        const value = ec.entity.makeValue("moqui.resource.DbResource")
                        value.set("resourceId", content.resourceId)
                        value.set("filename", args.movedName)
                        value.update()
                        return {moved: true}
                    }
                    waitFor("raw-locked")
                    signal("native-started")
                    try {
                        const result = ec.service
                            .sync()
                            .name("mantle.account.PaymentServices.change#PaymentState")
                            .parameters(args.confirm)
                            .requireNewTransaction(true)
                            .throwOnError(true)
                            .call()
                        return {delivered: result}
                    } catch (error) {
                        ec.message.clearErrors()
                        return {nativeRefusal: error.message}
                    }
                },
                {
                    latchId,
                    movedName,
                    confirm: {previewId: review.previewId, inputFingerprint: review.inputFingerprint, operationKey}
                },
                {transaction: true, timeout: 45}
            )
            failedState = JSON.stringify(h.lib.map(h.lib.one("mantle.account.payment.Payment", {paymentId: id})))
            transactionCount = h.count("mantle.ledger.transaction.AcctgTrans", {paymentId: id})
            outputCount = h.count("mantle.account.payment.PaymentIssuedOutput", {paymentId: id})
            retainedEvents = h.count("mantle.account.payment.PaymentLifecycleEvent", {paymentId: id})
            moved = h.lib.one(NODE, {resourceId: "MANTLE_CONTENT"}).filename
            misplacedArchiveCount = h.count(NODE, {parentResourceId: "MANTLE_CONTENT", filename: "payment-issued"})
        } finally {
            // No archive may exist under the renamed parent; restore this shared seed folder for later specs.
            h.call("update#" + NODE, {resourceId: "MANTLE_CONTENT", filename: "content"})
        }
        const positive = h.confirm(review, operationKey),
            outputs = h.lib.rows("mantle.account.payment.PaymentIssuedOutput", {paymentId: id})
        return {
            results,
            original,
            failedState,
            transactionCount,
            outputCount,
            eventCount,
            retainedEvents,
            moved,
            movedName,
            misplacedArchiveCount,
            positive,
            outputs
        }
    },
    then({
        results,
        original,
        failedState,
        transactionCount,
        outputCount,
        eventCount,
        retainedEvents,
        moved,
        movedName,
        misplacedArchiveCount,
        positive,
        outputs
    }) {
        results.filter(row => row.moved === true).length == 1
        results.filter(row => row.nativeRefusal?.includes("PAYMENT_ARCHIVE_PATH_INVALID")).length == 1
        !results.some(row => row.delivered)
        moved == movedName
        failedState == original
        transactionCount == 0
        outputCount == 0
        misplacedArchiveCount == 0
        retainedEvents == eventCount
        positive.statusId == "PmntDelivered"
        outputs.length == 2
        outputs.every(
            row =>
                row.contentLocation.startsWith("dbresource://mantle/content/payment-issued/") &&
                ec.resource.getLocationReference(row.contentLocation).getExists()
        )
    }
})
