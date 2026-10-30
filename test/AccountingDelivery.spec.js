const helper = () => ec.resource.script("component://mr-mantle/test/AccountingReceivablesFixtures.js")
const native = (name, p) => helper().call("mantle.account.InvoiceServices." + name, p)
const capture = ec.factory.getTool("MailCapture")
let f, first, sendParameters, invoiceId
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_SEND")
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
feature("an invoice without a store freezes its PDF and sends valid recipients past a bad address", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f)
        invoiceId = invoice.invoiceId
        capture.clear()
        sendParameters = {
            invoiceId,
            organizationPartyId: f.org,
            operationKey: "native-send-first",
            emailAccountId: f.emailAccountId,
            toAddresses: "customer@example.com,bad-address",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        }
        first = native("send#Invoice", sendParameters)
        const stored = helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: first.invoiceContentId})
        const file = ec.resource.getLocationReference(stored.contentLocation)
        return {first, count: capture.count(), exists: file.getExists(), size: file.getSize()}
    },
    then({first, count, exists, size}) {
        first.successCount == 1
        first.failureCount == 1
        first.statusId == "InvoiceSent"
        first.recipientResults.some(row => row.reasonCode == "RECIPIENT_INVALID")
        count == 1
        exists == true
        size > 100
    }
})
feature("same-key send replay retains exact issued outcome and never sends twice", {
    when() {
        login(f.users.ar)
        const before = capture.count()
        const repeated = native("send#Invoice", sendParameters)
        const check = native("check#InvoiceStoreEmail", {invoiceId})
        const detail = native("get#InvoiceFinanceDetail", {invoiceId})
        return {before, after: capture.count(), repeated, check, detail}
    },
    then({before, after, repeated, check, detail}) {
        repeated.alreadyApplied == true
        repeated.statusId == first.statusId
        repeated.deliveryId == first.deliveryId
        repeated.invoiceContentId == first.invoiceContentId
        before == after
        check.sendAllowed == false
        detail.deliveryRows.some(row =>
            row.recipients.some(item => item.recipient == "customer@example.com" && item.emailMessageId)
        )
        detail.deliveryRows.every(row => row.sourceJson == null && row.recipients.every(item => item.body == null))
    }
})
feature("a new operation refuses a stale reviewed invoice version before delivery", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f)
        native("store#InvoiceDraft", {
            invoiceId: invoice.invoiceId,
            lastUpdatedStamp: invoice.lastUpdatedStamp,
            description: "Changed after review"
        })
        const refused = helper().rejected("mantle.account.InvoiceServices.send#Invoice", {
            invoiceId: invoice.invoiceId,
            emailAccountId: f.emailAccountId,
            toAddresses: "customer@example.com",
            operationKey: "native-send-stale",
            lastUpdatedStamp: 0
        })
        const missing = helper().rejected("mantle.account.InvoiceServices.send#Invoice", {
            invoiceId: invoice.invoiceId,
            emailAccountId: f.emailAccountId,
            toAddresses: "customer@example.com",
            operationKey: "native-send-missing"
        })
        return {refused, missing}
    },
    then({refused, missing}) {
        refused.includes("STALE_REVISION")
        missing.includes("STALE_REVISION")
    }
})
feature("another operation cannot claim a prepared recipient or mark it sent before the canonical delivery", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f)
        const base = {
            invoiceId: invoice.invoiceId,
            organizationPartyId: f.org,
            emailAccountId: f.emailAccountId,
            toAddresses: "claim@example.com",
            sourceVersion: helper().lib.fingerprint(invoice)
        }
        const firstPrepared = native("prepare#InvoiceDelivery", Object.assign({}, base, {operationKey: "native-claim-first"}))
        const secondPrepared = native("prepare#InvoiceDelivery", Object.assign({}, base, {operationKey: "native-claim-second"}))
        const before = capture.count()
        const waiting = native("finish#InvoiceDelivery", {deliveryId: secondPrepared.deliveryId})
        native("deliver#InvoiceRecipient", {deliveryId: firstPrepared.deliveryId, recipient: "claim@example.com"})
        native("finish#InvoiceDelivery", {deliveryId: firstPrepared.deliveryId})
        const resolved = native("finish#InvoiceDelivery", {deliveryId: secondPrepared.deliveryId})
        return {waiting, resolved, sent: capture.count() - before}
    },
    then({waiting, resolved, sent}) {
        waiting.pendingCount == 1
        waiting.successCount == 0
        waiting.statusId == "InvoiceFinalized"
        resolved.pendingCount == 0
        resolved.successCount == 1
        sent == 1
    }
})
feature("accepted Outbox instructions remain queued and preserve one message on retry", {
    when() {
        capture.disable()
        login(f.users.ar)
        const invoice = helper().draft(f)
        const parameters = {
            invoiceId: invoice.invoiceId,
            organizationPartyId: f.org,
            emailAccountId: f.emailAccountId,
            toAddresses: "outbox@example.com",
            operationKey: "native-queued",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        }
        const queued = native("send#Invoice", parameters)
        const replay = native("send#Invoice", parameters)
        capture.enable()
        return {queued, replay}
    },
    then({queued, replay}) {
        queued.successCount == 1
        queued.statusId == "InvoiceSent"
        queued.recipientResults[0].status == "queued"
        replay.recipientResults[0].emailMessageId == queued.recipientResults[0].emailMessageId
    }
})
feature("reviewed batch results persist and name stale and independent successful documents", {
    when() {
        login(f.users.ar)
        const good = helper().draft(f),
            stale = helper().draft(f)
        const parameters = {
            organizationPartyId: f.org,
            invoiceIdList: [good.invoiceId, stale.invoiceId],
            action: "finalize",
            operationKey: "native-invoice-batch",
            sourceVersions: {[good.invoiceId]: good.lastUpdatedStamp, [stale.invoiceId]: 0}
        }
        const result = native("process#InvoiceBatch", parameters)
        const replay = native("process#InvoiceBatch", parameters)
        const op = helper().lib.one("mantle.ledger.transaction.PostingOperation", {operationKey: parameters.operationKey})
        return {result, replay, op}
    },
    then({result, replay, op}) {
        result.successCount == 1
        result.failureCount == 1
        result.results.some(row => !row.success && row.errorMessage.includes("STALE_REVISION"))
        replay.alreadyApplied == true
        op.status == "complete"
        JSON.parse(op.resultJson).results.length == 2
    }
})
feature("currency-separated statement snapshots retain reviewed amounts and reject unauthorized reads", {
    when() {
        login(f.users.ar)
        const snapshot = helper().call("mantle.account.CollectionServices.preview#Statements", {
            organizationPartyId: f.org,
            customerPartyIdList: [f.customer],
            asOfDate: ec.user.nowTimestamp
        })
        const restored = helper().call("mantle.account.CollectionServices.get#StatementPreview", {
            snapshotId: snapshot.snapshotId
        })
        login(f.users.read)
        const denied = helper().rejected("mantle.account.CollectionServices.get#StatementPreview", {
            snapshotId: snapshot.snapshotId
        })
        return {snapshot, restored, denied}
    },
    then({snapshot, restored, denied}) {
        snapshot.statementRows.length > 0
        snapshot.statementRows.every(row => row.currencyUomId == "USD")
        restored.inputFingerprint == snapshot.inputFingerprint
        restored.previewHtml == snapshot.previewHtml
        denied.includes("PERMISSION_DENIED")
    }
})
feature("a reviewed multi-currency statement sends each currency independently and replays the exact recipient results", {
    when() {
        const legacyFixture = helper().fixtures("NATIVE_STMT")
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: legacyFixture.org,
            postingGuardEnabled: "N",
            singleCurrencyDocumentsOnly: "N"
        })
        const local = helper().draft(legacyFixture, "31", "USD")
        native("change#InvoiceState", {invoiceId: local.invoiceId, action: "finalize", lastUpdatedStamp: local.lastUpdatedStamp})
        const foreign = helper().draft(legacyFixture, "24", "EUR")
        native("change#InvoiceState", {
            invoiceId: foreign.invoiceId,
            action: "finalize",
            lastUpdatedStamp: foreign.lastUpdatedStamp
        })
        helper().call("create#moqui.basic.email.EmailAccountUser", {
            emailAccountId: f.emailAccountId,
            userId: legacyFixture.users.ar,
            fromDate: 0,
            permissionEnumId: "EapSend"
        })
        login(legacyFixture.users.ar)
        const snapshot = helper().call("mantle.account.CollectionServices.preview#Statements", {
            organizationPartyId: legacyFixture.org,
            customerPartyIdList: [legacyFixture.customer],
            asOfDate: ec.user.nowTimestamp
        })
        const parameters = {
            snapshotId: snapshot.snapshotId,
            inputFingerprint: snapshot.inputFingerprint,
            operationKey: "native-statement-send",
            toAddresses: "statement@example.com,bad-address"
        }
        const before = capture.count()
        const reserved = helper().call("mantle.account.CollectionServices.prepare#StatementSend", parameters)
        const conflict = helper().rejected(
            "mantle.account.CollectionServices.send#Statements",
            Object.assign({}, parameters, {toAddresses: "other@example.com"})
        )
        const beforeSend = capture.count()
        const sent = helper().call("mantle.account.CollectionServices.send#Statements", parameters)
        const repeated = helper().call("mantle.account.CollectionServices.send#Statements", parameters)
        return {snapshot, sent, repeated, reserved, conflict, beforeSend, before, sentCount: capture.count() - before}
    },
    then({snapshot, sent, repeated, reserved, conflict, beforeSend, before, sentCount}) {
        snapshot.statementRows.length == 2
        snapshot.statementRows.some(row => row.currencyUomId == "EUR" && row.closingBalance.eq(24))
        sent.successCount == 2
        sent.failureCount == 2
        sent.results
            .filter(row => row.status == "failed")
            .every(row => row.currencyUomId && row.errorMessage && row.reasonCode == "RECIPIENT_INVALID")
        repeated.alreadyApplied == true
        repeated.results.length == sent.results.length
        sentCount == 2
        reserved.complete == false
        conflict.includes("OPERATION_KEY_CONFLICT")
        beforeSend == before
    }
})
feature("a configured transactional store notice sends normally and is suppressed for the durable manual delivery version", {
    when() {
        helper().call("create#mantle.product.store.ProductStore", {
            productStoreId: "NATIVE_SEND_STORE",
            storeName: "Native invoice notice store",
            organizationPartyId: f.org
        })
        helper().call("create#moqui.basic.email.EmailTemplate", {
            emailTemplateId: "NATIVE_SEND_STORE_NOTICE",
            emailServerId: "NATIVE_SEND_SMTP",
            fromAddress: "accounts@native.example",
            subject: "Store invoice finalized",
            bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
        })
        helper().call("create#mantle.product.store.ProductStoreEmail", {
            productStoreId: "NATIVE_SEND_STORE",
            emailTypeEnumId: "PsetInvoiceFinalized",
            fromDate: 0,
            emailTemplateId: "NATIVE_SEND_STORE_NOTICE"
        })
        helper().call("mantle.party.ContactServices.create#EmailAddress", {
            partyId: f.customer,
            emailAddress: "store@example.com",
            contactMechPurposeId: "EmailBilling"
        })
        const legacy = helper().draft(f, "11")
        helper().call("update#mantle.account.invoice.Invoice", {invoiceId: legacy.invoiceId, productStoreId: "NATIVE_SEND_STORE"})
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        capture.clear()
        native("change#InvoiceState", {
            invoiceId: legacy.invoiceId,
            action: "finalize",
            lastUpdatedStamp: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: legacy.invoiceId}).lastUpdatedStamp
        })
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        const legacyCount = capture.count()
        const manual = helper().draft(f, "13")
        helper().call("update#mantle.account.invoice.Invoice", {invoiceId: manual.invoiceId, productStoreId: "NATIVE_SEND_STORE"})
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        capture.clear()
        native("send#Invoice", {
            invoiceId: manual.invoiceId,
            emailAccountId: f.emailAccountId,
            toAddresses: "store@example.com",
            operationKey: "native-store-manual",
            lastUpdatedStamp: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: manual.invoiceId}).lastUpdatedStamp
        })
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        return {legacyCount, manualCount: capture.count()}
    },
    then({legacyCount, manualCount}) {
        legacyCount == 1
        manualCount == 1
    }
})
feature("a reviewed financial source version survives the asynchronous store notice's status-only stamp advance", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "19")
        const finalized = native("change#InvoiceState", {
            invoiceId: invoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        const afterNotice = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId})
        const before = capture.count()
        const parameters = {
            invoiceId: invoice.invoiceId,
            organizationPartyId: f.org,
            sourceVersion: finalized.sourceVersion,
            emailAccountId: f.emailAccountId,
            toAddresses: "reviewed@example.com"
        }
        const strictStamp = helper().rejected(
            "mantle.account.InvoiceServices.send#Invoice",
            Object.assign({}, parameters, {
                lastUpdatedStamp: finalized.lastUpdatedStamp,
                operationKey: "native-status-only-stamp"
            })
        )
        const beforeDeliveryCount = helper().lib.rows("mantle.account.invoice.InvoiceDelivery", {
            invoiceId: invoice.invoiceId
        }).length
        const sent = native("send#Invoice", Object.assign({}, parameters, {operationKey: "native-status-only-source"}))
        return {
            finalized,
            afterNotice,
            strictStamp,
            beforeDeliveryCount,
            sent,
            sentCount: capture.count() - before,
            unchangedSource: helper().lib.fingerprint(afterNotice)
        }
    },
    then({finalized, afterNotice, strictStamp, beforeDeliveryCount, sent, sentCount, unchangedSource}) {
        finalized.statusId == "InvoiceFinalized"
        afterNotice.statusId == "InvoiceSent"
        helper().lib.ms(afterNotice.lastUpdatedStamp) != helper().lib.ms(finalized.lastUpdatedStamp)
        unchangedSource == finalized.sourceVersion
        strictStamp.includes("STALE_REVISION")
        beforeDeliveryCount == 0
        sent.statusId == "InvoiceSent"
        sent.sourceVersion == finalized.sourceVersion
        sent.successCount == 1
        sentCount == 1
    }
})
feature("source-version-only delivery refuses reviewed financial header and line changes without durable output or mail", {
    when() {
        login(f.users.ar)
        const results = []
        for (const change of ["header", "line"]) {
            const invoice = helper().draft(f, "20")
            const sourceVersion = helper().lib.fingerprint(invoice)
            if (change === "header")
                native("store#InvoiceDraft", {
                    invoiceId: invoice.invoiceId,
                    lastUpdatedStamp: invoice.lastUpdatedStamp,
                    referenceNumber: "Changed after delivery review"
                })
            else {
                const line = helper().lib.rows("mantle.account.invoice.InvoiceItem", {invoiceId: invoice.invoiceId})[0]
                native("store#InvoiceDraftItem", {
                    invoiceId: invoice.invoiceId,
                    invoiceItemSeqId: line.invoiceItemSeqId,
                    lastUpdatedStamp: line.lastUpdatedStamp,
                    amount: "21"
                })
            }
            const before = capture.count()
            const refused = helper().rejected("mantle.account.InvoiceServices.send#Invoice", {
                invoiceId: invoice.invoiceId,
                organizationPartyId: f.org,
                sourceVersion,
                emailAccountId: f.emailAccountId,
                toAddresses: "stale@example.com",
                operationKey: "native-source-stale-" + change
            })
            results.push({
                change,
                refused,
                sentCount: capture.count() - before,
                state: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId}).statusId,
                deliveries: helper().lib.rows("mantle.account.invoice.InvoiceDelivery", {invoiceId: invoice.invoiceId}).length,
                outputs: helper().lib.rows("mantle.account.invoice.InvoiceContent", {invoiceId: invoice.invoiceId}).length
            })
        }
        return {results}
    },
    then({results}) {
        results.length == 2
        results.every(row => row.refused.includes("STALE_PREVIEW"))
        results.every(row => row.sentCount == 0 && row.state == "InvoiceInProcess" && row.deliveries == 0 && row.outputs == 0)
    }
})
