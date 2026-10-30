// Provider requests retain bounded evidence bytes before I/O; completion never rereads mutable source files.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
let f
function read(location) {
    const stream = ec.resource.getLocationReference(location).getInputStream()
    try {
        return stream.readAllBytes()
    } finally {
        stream.close()
    }
}
function digest(bytes) {
    return helper().lib.hash(StringUtilities.base64Encode(bytes))
}
function hasPrivate(value) {
    const forbidden = new Set([
        "frozenEvidenceJson",
        "receiptJson",
        "requestJson",
        "adapterRequest",
        "adapterServiceName",
        "credentialSnapshot",
        "payloadJson",
        "dispatchToken",
        "lookupToken",
        "merchantNamespace",
        "operationServiceName",
        "lookupServiceName",
        "guaranteesJson",
        "reviewedOperationServiceName",
        "reviewedLookupServiceName",
        "reviewedMerchantNamespace",
        "reviewedGuaranteesJson",
        "accountNumber",
        "routingNumber"
    ])
    if (!value || typeof value !== "object") return false
    return Object.entries(value).some(([key, item]) => forbidden.has(key) || hasPrivate(item))
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWEVID")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().lifecycle.settlement.base.cleanupLocks(f.org)
    }
})
feature("pending capture freezes exact large supporting bytes despite later source replacement and deletion", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            files = []
        h.execute(h.preview(f, paymentId))
        for (const name of ["Replace.bin", "Delete.bin"]) {
            const id = "GWE_" + ec.user.randomString(24),
                data = new Uint8Array(71680),
                nonce = ec.user.randomString(40)
            for (let i = 0; i < data.length; i++) data[i] = (nonce.charCodeAt(i % nonce.length) + i) % 256
            const location = "dbresource://mantle/content/payment/" + paymentId + "/content_" + id + "/" + name
            ec.resource.getLocationReference(location).putBytes(data)
            h.call("create#mantle.account.payment.PaymentContent", {
                paymentContentId: id,
                paymentId,
                contentLocation: location,
                contentTypeEnumId: "PctPaymentDocument",
                description: name
            })
            files.push({id, location, hash: digest(data), size: data.length})
        }
        const detail = h.lifecycle.detail(f, paymentId),
            versions = Object.fromEntries(detail.evidenceRows.map(row => [row.paymentContentId, row.version])),
            review = h.preview(f, paymentId, "capture", {
                amount: "20",
                evidenceContentIdList: files.map(file => file.id),
                evidenceVersions: versions
            })
        h.mode(f, "capture", "pending")
        let pending, completed
        try {
            pending = h.execute(review, "gwe-frozen-evidence")
            ec.resource.getLocationReference(files[0].location).putBytes(new Uint8Array([1, 2, 3, 4]))
            h.call("delete#mantle.account.payment.PaymentContent", {paymentContentId: files[1].id})
            ec.resource.getLocationReference(files[1].location).delete()
            h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                paymentGatewayConfigId: f.gatewayId,
                lookupOutcomesJson: JSON.stringify({capture: "accepted"})
            })
            const current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: pending.attemptId})
            completed = h.native("refresh#PaymentGatewayAttempt", {
                organizationPartyId: f.org,
                attemptId: pending.attemptId,
                attemptVersion: current.attemptVersion,
                operationKey: "gwe-complete-frozen"
            })
        } finally {
            h.mode(f, "capture", "accepted")
            h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                paymentGatewayConfigId: f.gatewayId,
                lookupOutcomesJson: "{}"
            })
        }
        const event = h.lib.one("mantle.account.payment.PaymentLifecycleEvent", {
                paymentLifecycleEventId: completed.paymentLifecycleEventId
            }),
            archived = JSON.parse(event.evidenceJson || "[]").map(row =>
                Object.assign({}, row, {actualHash: digest(read(row.archiveLocation))})
            ),
            publicReads = [
                h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: completed.attemptId}),
                h.native("get#PaymentGatewayActionPreview", {organizationPartyId: f.org, previewId: review.previewId}),
                h.native("find#PaymentGatewayTransactions", {organizationPartyId: f.org, paymentId}),
                h.lifecycle.detail(f, paymentId),
                h.lifecycle.detail(f, completed.cashPaymentId),
                h.native("find#Payments", {organizationPartyId: f.org})
            ]
        login(f.users.gatewayTreasuryNoLedger)
        const treasury = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: completed.attemptId})
        login(f.users.ar)
        const ar = h.lifecycle.detail(f, completed.cashPaymentId),
            gatewayDenied = h.lifecycle.rejected("get#PaymentGatewayAttempt", {
                organizationPartyId: f.org,
                attemptId: completed.attemptId
            })
        return {
            files,
            review,
            pending,
            completed,
            archived,
            publicReads,
            treasury,
            ar,
            gatewayDenied,
            sourceHash: digest(read(files[0].location)),
            deleted: !ec.resource.getLocationReference(files[1].location).getExists(),
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
        }
    },
    then({files, review, pending, completed, archived, publicReads, treasury, ar, gatewayDenied, sourceHash, deleted, effect}) {
        pending.providerState == "pending"
        pending.cashPaymentId == null
        completed.financialState == "completed"
        review.evidenceRows.length == 2
        archived.length == 2
        archived.every(row => row.contentHash === files.find(file => file.id === row.paymentContentId).hash)
        archived.every(row => row.actualHash === row.contentHash && row.contentSize === 71680)
        archived.every(row =>
            row.archiveLocation.startsWith("dbresource://mantle/content/payment-issued/" + completed.cashPaymentId + "/evidence/")
        )
        sourceHash != files[0].hash
        deleted == true
        publicReads.every(value => !hasPrivate(value))
        treasury.acctgTransIds == null
        treasury.outputRows.length == 2
        treasury.outputRows.every(row => row.paymentId === completed.cashPaymentId && row.canOpen === true)
        ar.gatewayRows == null
        ar.ledgerRows == null
        gatewayDenied.includes("PERMISSION_DENIED")
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
