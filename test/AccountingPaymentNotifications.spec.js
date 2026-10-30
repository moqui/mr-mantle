// Native draft validation uses durable committed publications and real framework recipient-bound decisions.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
const P = "mantle.account.payment.Payment"
const EVENT = "mantle.account.payment.PaymentLifecycleEvent"
const PUBLICATION = "mantle.account.payment.PaymentValidationPublication"
const DELIVERY = "mantle.account.payment.PaymentValidationDelivery"
const MESSAGE = "moqui.security.user.NotificationMessage"
const RECIPIENT = "moqui.security.user.NotificationMessageUser"
const notices = (name, parameters) => helper().call("mantle.account.PaymentNotificationServices." + name, parameters)
const decision = (name, parameters) =>
    helper().call("org.moqui.impl.NotificationServices." + name + "#NotificationMessage", parameters)
let f, foreign, alternate, activeForeign, privatePartyId

function one(entity, key) {
    return helper().lib.one(entity, key)
}
function drain() {
    assert(ec.factory.waitWorkerPoolEmpty(50), "Payment validation commit workers did not finish")
}
function draft(extra = {}) {
    const result = helper().native("create#PaymentDraft", helper().request(f, extra))
    drain()
    if (!result.validationEventId) throw new Error("Native draft did not return its validation event")
    return result
}
function notice(created, userId = f.users.treasury) {
    const delivery = one(DELIVERY, {validationEventId: created.validationEventId, userId})
    if (!delivery?.notificationMessageId || delivery.status !== "sent") {
        const publication = one(PUBLICATION, {validationEventId: created.validationEventId})
        throw new Error(
            "Actual native worker did not publish the scoped recipient's validation notice: " +
                JSON.stringify({
                    validationEventId: created.validationEventId,
                    userId,
                    publicationStatus: publication?.status,
                    lastError: publication?.lastError,
                    delivery: helper().lib.map(delivery)
                })
        )
    }
    const message = one(MESSAGE, {notificationMessageId: delivery.notificationMessageId})
    if (!message || !one(RECIPIENT, {notificationMessageId: message.notificationMessageId, userId}))
        throw new Error("Validation notice is missing its persisted framework message or recipient")
    return message
}
function snapshot(id) {
    return JSON.stringify(helper().lib.map(one(P, {paymentId: id})))
}
function counts() {
    const h = helper()
    return {
        payments: h.count(P, {financeOrganizationPartyId: f.org}),
        events: h.count(EVENT, {organizationPartyId: f.org}),
        publications: h.count(PUBLICATION, {organizationPartyId: f.org}),
        transactions: h.count("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: f.org})
    }
}
function directParameters(message) {
    return {
        notificationMessageId: message.notificationMessageId,
        recordEntityName: message.recordEntityName,
        recordId: message.recordId,
        message: JSON.parse(message.messageJson)
    }
}
function recipientStates(created) {
    const deliveries = helper().lib.rows(DELIVERY, {validationEventId: created.validationEventId, status: "sent"}),
        ids = deliveries.map(row => row.notificationMessageId)
    return {
        deliveries,
        rows: Array.from(helper().lib.find(RECIPIENT).condition("notificationMessageId", "in", ids).list()).map(helper().lib.map)
    }
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures("ACCT_P5_NOTICE")
        foreign = h.fixtures("ACCT_P5_NFOREIGN")
        alternate = h.settlement.user(f, "ALT_TREASURY", ["PAYMENT_VIEW", "PAYMENT_EDIT"])
        activeForeign = h.settlement.user(f, "ACTIVE_FOREIGN", ["PAYMENT_VIEW", "PAYMENT_EDIT"])
        h.call("create#mantle.party.PartyRelationship", {
            fromPartyId: activeForeign,
            toPartyId: foreign.org,
            relationshipTypeEnumId: "PrtAgent",
            fromDate: 0
        })
        h.call("store#moqui.security.UserPreference", {
            userId: activeForeign,
            preferenceKey: "ACTIVE_ORGANIZATION",
            preferenceValue: foreign.org
        })
        privatePartyId = "ACCT_P5_NOTICE_PRIVATE"
        h.call("create#mantle.party.Party", {
            partyId: privatePartyId,
            partyTypeEnumId: "PtyOrganization",
            privateOwnerUserId: f.users.treasury
        })
        h.call("create#mantle.party.Organization", {partyId: privatePartyId, organizationName: "Private payment counterparty"})
        h.call("create#mantle.party.PartyRole", {partyId: privatePartyId, roleTypeId: "Customer"})
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        drain()
    },
    cleanup() {
        login("john.doe")
        drain()
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().settlement.base.cleanupLocks(f.org)
        if (foreign?.org) helper().settlement.base.cleanupLocks(foreign.org)
    }
})

feature("a real native draft commits one revision-bound publication and stable per-recipient message on replay", {
    when() {
        const h = helper(),
            request = h.request(f),
            created = h.native("create#PaymentDraft", request)
        drain()
        const message = notice(created),
            event = one(EVENT, {paymentLifecycleEventId: created.validationEventId}),
            publication = one(PUBLICATION, {validationEventId: created.validationEventId}),
            before = h.count(MESSAGE, {topic: "PaymentValidation", subTopic: created.validationEventId}),
            replay = h.native("create#PaymentDraft", request)
        drain()
        const repeated = notices("publish#PaymentValidationNotice", {validationEventId: created.validationEventId}),
            stable = notice(created),
            stillLive = notices("retire#PaymentValidationNotice", {validationEventId: created.validationEventId}),
            liveRecipients = recipientStates(created)
        return {
            created,
            replay,
            message,
            event,
            publication,
            before,
            after: h.count(MESSAGE, {topic: "PaymentValidation", subTopic: created.validationEventId}),
            repeated,
            stable,
            stillLive,
            liveRecipients,
            body: JSON.parse(message.messageJson)
        }
    },
    then({created, replay, message, event, publication, before, after, repeated, stable, body, stillLive, liveRecipients}) {
        created.validationRequired == true
        created.validationSourceVersion == created.sourceVersion
        event.expectedSourceVersion == created.sourceVersion
        publication.sourceVersion == event.expectedSourceVersion
        publication.status == "sent"
        message.actorUserId == event.userId
        message.recordEntityName == P
        message.recordId == created.paymentId
        body.paymentId == created.paymentId
        body.validationEventId == created.validationEventId
        body.sourceVersion == created.sourceVersion
        Object.keys(body).sort().join(",") == "organizationPartyId,paymentId,sourceVersion,validationEventId"
        replay.alreadyApplied == true
        replay.validationEventId == created.validationEventId
        replay.validationSourceVersion == created.validationSourceVersion
        stable.notificationMessageId == message.notificationMessageId
        after == before
        repeated.recipients.every(row => row.status === "sent" && row.alreadySent === true)
        stillLive.status == "sent"
        liveRecipients.rows.length >= 2
        liveRecipients.rows.every(row => row.viewedDate == null)
    }
})

feature("rolling back the actual native draft also rolls back its reserved publication and sends nothing", {
    when() {
        const original = counts(),
            request = helper().request(f, {referenceNumber: "ROLLBACK-NOTICE"})
        let rollback = ""
        try {
            parallel(
                1,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    const h = ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
                    const created = h.native("create#PaymentDraft", args)
                    if (
                        !created.validationEventId ||
                        !h.lib.one("mantle.account.payment.PaymentValidationPublication", {
                            validationEventId: created.validationEventId
                        })
                    )
                        throw new Error("The native draft did not reserve an outbox row in its own transaction")
                    throw new Error("ROLLBACK_PAYMENT_NOTICE")
                },
                request,
                {transaction: true, timeout: 30}
            )
        } catch (error) {
            rollback = error.message
        }
        drain()
        return {
            rollback,
            original,
            retained: counts(),
            draftCount: helper().count(P, {financeOrganizationPartyId: f.org, paymentRefNum: "ROLLBACK-NOTICE"})
        }
    },
    then({rollback, original, retained, draftCount}) {
        rollback.includes("ROLLBACK_PAYMENT_NOTICE")
        JSON.stringify(retained) == JSON.stringify(original)
        draftCount == 0
    }
})

feature("only native payment editors with broad view and current organization scope receive validation notices", {
    when() {
        const h = helper(),
            created = draft(),
            message = notice(created),
            recipients = h.lib.rows(DELIVERY, {validationEventId: created.validationEventId}).map(row => row.userId),
            parameters = {organizationPartyId: f.org, paymentId: created.paymentId}
        login(activeForeign)
        const foreignScope = h.rejected("get#PaymentFinanceDetail", parameters)
        login(f.users.treasury)
        const positive = h.detail(f, created.paymentId)
        return {recipients, message, foreignScope, positive}
    },
    then({recipients, message, foreignScope, positive}) {
        recipients.includes(f.users.treasury)
        recipients.includes(alternate)
        !recipients.includes(f.users.paymentView)
        !recipients.includes(f.users.paymentEditOnly)
        !recipients.includes(f.users.ar)
        !recipients.includes(foreign.users.treasury)
        !recipients.includes(activeForeign)
        foreignScope.includes("ORGANIZATION_DENIED")
        positive.payment.paymentId == message.recordId
    }
})

feature("private counterparties keep validation notices within the native private owner scope", {
    when() {
        const h = helper(),
            created = draft({partyId: privatePartyId}),
            message = notice(created),
            recipients = h.lib.rows(DELIVERY, {validationEventId: created.validationEventId}).map(row => row.userId),
            parameters = {organizationPartyId: f.org, paymentId: created.paymentId}
        login(alternate)
        const denied = h.rejected("get#PaymentFinanceDetail", parameters)
        login(f.users.treasury)
        return {recipients, denied, positive: h.detail(f, created.paymentId), message}
    },
    then({recipients, denied, positive, message}) {
        recipients.includes(f.users.treasury)
        !recipients.includes(alternate)
        denied.includes("PAYMENT_UNAVAILABLE")
        positive.payment.paymentId == message.recordId
    }
})

feature("editing a proposed draft obsoletes its earlier request and only the current notice can validate", {
    when() {
        const h = helper(),
            created = draft({amount: "9"}),
            old = notice(created),
            edited = h.native(
                "store#PaymentDraft",
                h.request(f, {
                    paymentId: created.paymentId,
                    sourceVersion: h.detail(f, created.paymentId).sourceVersion,
                    amount: "10"
                })
            )
        drain()
        const fresh = notice(edited),
            before = snapshot(created.paymentId),
            oldViewedBefore = String(
                one(RECIPIENT, {notificationMessageId: old.notificationMessageId, userId: f.users.treasury}).viewedDate
            )
        login(f.users.treasury)
        const stale = h.rejected("org.moqui.impl.NotificationServices.approve#NotificationMessage", {
                notificationMessageId: old.notificationMessageId
            }),
            unchanged = snapshot(created.paymentId) === before,
            oldRecipient = one(RECIPIENT, {notificationMessageId: old.notificationMessageId, userId: f.users.treasury}),
            positive = decision("approve", {notificationMessageId: fresh.notificationMessageId})
        login("john.doe")
        const obsolete = notices("publish#PaymentValidationNotice", {validationEventId: created.validationEventId})
        return {
            created,
            edited,
            stale,
            unchanged,
            oldRecipient,
            oldViewedBefore,
            positive,
            obsolete,
            state: one(P, {paymentId: created.paymentId}),
            transactions: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId: created.paymentId})
        }
    },
    then({created, edited, stale, unchanged, oldRecipient, oldViewedBefore, positive, obsolete, state, transactions}) {
        edited.validationEventId != created.validationEventId
        edited.validationSourceVersion != created.validationSourceVersion
        stale.includes("STALE_REVISION")
        unchanged == true
        oldRecipient.viewedDate != null
        String(oldRecipient.viewedDate) == oldViewedBefore
        positive.results.reasonCode == "PAYMENT_VALIDATION_APPROVED"
        obsolete.status == "obsolete"
        state.statusId == "PmntPromised"
        toDecimal(state.amount).eq(10)
        transactions == 0
    }
})

feature("a malformed publication cannot stop an independent valid publication or duplicate its recipients", {
    when() {
        const h = helper(),
            created = draft(),
            stable = notice(created),
            badId = "000_ACCT_P5_NOTICE_INVALID"
        h.call("create#" + PUBLICATION, {
            validationEventId: badId,
            organizationPartyId: f.org,
            paymentId: created.paymentId,
            sourceVersion: "Invalid immutable event",
            status: "pending",
            createdDate: ec.user.nowTimestamp
        })
        h.call("update#" + PUBLICATION, {validationEventId: created.validationEventId, status: "pending"})
        let processed
        try {
            processed = notices("process#PaymentValidationNotices", {limit: 200})
        } finally {
            h.call("delete#" + PUBLICATION, {validationEventId: badId})
        }
        return {processed, badId, created, stable, repeated: notice(created), errors: ec.message.errorsString}
    },
    then({processed, badId, created, stable, repeated, errors}) {
        processed.results.some(
            row =>
                row.validationEventId === badId &&
                row.status === "failed" &&
                row.error.includes("PAYMENT_VALIDATION_EVENT_INVALID")
        )
        processed.results.some(row => row.validationEventId === created.validationEventId && row.status === "sent")
        repeated.notificationMessageId == stable.notificationMessageId
        !errors
    }
})

feature("unavailable recipients do not receive messages or prevent a later valid recipient from publishing", {
    when() {
        const h = helper(),
            created = draft(),
            invalid = notices("send#PaymentValidationNotice", {
                validationEventId: created.validationEventId,
                userId: "ACCT_P5_NOTICE_MISSING"
            }),
            noView = notices("send#PaymentValidationNotice", {
                validationEventId: created.validationEventId,
                userId: f.users.paymentEditOnly
            }),
            laterUser = h.settlement.user(f, "LATE_TREASURY", ["PAYMENT_VIEW", "PAYMENT_EDIT"]),
            positive = notices("publish#PaymentValidationNotice", {validationEventId: created.validationEventId})
        return {
            invalid,
            noView,
            positive,
            later: notice(created, laterUser),
            missing: h.count(DELIVERY, {validationEventId: created.validationEventId, userId: "ACCT_P5_NOTICE_MISSING"}),
            denied: h.count(DELIVERY, {validationEventId: created.validationEventId, userId: f.users.paymentEditOnly})
        }
    },
    then({invalid, noView, positive, later, missing, denied}) {
        invalid.status == "unavailable"
        noView.status == "unavailable"
        missing == 0
        denied == 0
        positive.status == "sent"
        later.topic == "PaymentValidation"
    }
})

feature("a real recipient can #action its exact committed native request and replay the same decision", {
    where: [
        {action: "approve", state: "PmntPromised", reasonCode: "PAYMENT_VALIDATION_APPROVED", eventAction: "validate"},
        {action: "refuse", state: "PmntProposed", reasonCode: "PAYMENT_VALIDATION_REFUSED", eventAction: "validationRejected"}
    ],
    when({action, eventAction, state, reasonCode}) {
        const h = helper(),
            created = draft(),
            message = notice(created),
            parameters = {notificationMessageId: message.notificationMessageId}
        if (action === "refuse") parameters.reason = "The submitted instruction needs correction"
        login(f.users.treasury)
        const result = decision(action, parameters),
            replay = decision(action, parameters)
        drain()
        login("john.doe")
        const lateUser = h.settlement.user(f, "POST_" + action.toUpperCase(), ["PAYMENT_VIEW", "PAYMENT_EDIT"]),
            latePublication = notices("publish#PaymentValidationNotice", {validationEventId: created.validationEventId}),
            lateDeliveries = h.count(DELIVERY, {validationEventId: created.validationEventId, userId: lateUser})
        const event = h.lib.one(EVENT, {
                paymentId: created.paymentId,
                action: eventAction,
                sourceValidationEventId: created.validationEventId
            }),
            payment = one(P, {paymentId: created.paymentId}),
            recipient = one(RECIPIENT, {notificationMessageId: message.notificationMessageId, userId: f.users.treasury}),
            transactions = h.count("mantle.ledger.transaction.AcctgTrans", {paymentId: created.paymentId})
        return {
            result,
            replay,
            event,
            payment,
            recipient,
            transactions,
            allRecipients: recipientStates(created),
            publication: one(PUBLICATION, {validationEventId: created.validationEventId}),
            latePublication,
            lateDeliveries,
            expectedState: state,
            expectedReasonCode: reasonCode
        }
    },
    then({
        result,
        replay,
        event,
        payment,
        recipient,
        transactions,
        allRecipients,
        publication,
        latePublication,
        lateDeliveries,
        expectedState,
        expectedReasonCode
    }) {
        result.results.reasonCode == expectedReasonCode
        replay.results.reasonCode == expectedReasonCode
        replay.results.alreadyApplied == true
        payment.statusId == expectedState
        event != null
        event.sourceValidationEventId != null
        recipient.viewedDate != null
        allRecipients.deliveries.length >= 2
        allRecipients.rows.length == allRecipients.deliveries.length
        allRecipients.rows.every(row => row.viewedDate != null)
        publication.status == "decided"
        latePublication.status == "decided"
        lateDeliveries == 0
        transactions == 0
    }
})

feature("real message recipient, stored payload and record binding are checked before a valid approval", {
    when() {
        const h = helper(),
            created = draft(),
            other = draft(),
            message = notice(created),
            input = directParameters(message),
            before = snapshot(created.paymentId)
        login(f.users.ar)
        const notRecipient = h.rejected("org.moqui.impl.NotificationServices.approve#NotificationMessage", {
                notificationMessageId: message.notificationMessageId
            }),
            nativeRecipient = h.rejected("approve#PaymentValidationNotice", input)
        login(f.users.treasury)
        const wrongRecord = h.rejected("approve#PaymentValidationNotice", {...input, recordId: other.paymentId}),
            wrongBody = h.rejected("approve#PaymentValidationNotice", {
                ...input,
                message: {...input.message, sourceVersion: "Unreviewed revision"}
            }),
            unchanged = snapshot(created.paymentId) === before,
            positive = decision("approve", {notificationMessageId: message.notificationMessageId})
        return {
            notRecipient,
            nativeRecipient,
            wrongRecord,
            wrongBody,
            unchanged,
            positive,
            otherState: one(P, {paymentId: other.paymentId}).statusId
        }
    },
    then({notRecipient, nativeRecipient, wrongRecord, wrongBody, unchanged, positive, otherState}) {
        notRecipient.includes("not addressed to you")
        nativeRecipient.includes("PAYMENT_VALIDATION_NOTICE_UNAVAILABLE")
        wrongRecord.includes("PAYMENT_VALIDATION_NOTICE_UNAVAILABLE")
        wrongBody.includes("PAYMENT_VALIDATION_NOTICE_INVALID")
        unchanged == true
        positive.results.reasonCode == "PAYMENT_VALIDATION_APPROVED"
        otherState == "PmntProposed"
    }
})

feature("recipient membership cannot replace current native payment authority and refusal requires a reason", {
    when() {
        const h = helper(),
            created = draft(),
            message = notice(created),
            parameters = {notificationMessageId: message.notificationMessageId},
            permission = {userGroupId: f.users.treasury, userPermissionId: "PAYMENT_EDIT", fromDate: 0}
        login(f.users.treasury)
        const noReason = h.rejected("org.moqui.impl.NotificationServices.refuse#NotificationMessage", parameters)
        login("john.doe")
        h.call("update#moqui.security.UserGroupPermission", {...permission, thruDate: Number(ec.user.nowTimestamp) - 1})
        let denied
        try {
            login(f.users.treasury)
            denied = h.rejected("org.moqui.impl.NotificationServices.approve#NotificationMessage", parameters)
        } finally {
            login("john.doe")
            h.call("update#moqui.security.UserGroupPermission", {...permission, thruDate: null})
        }
        login(f.users.treasury)
        const positive = decision("approve", parameters)
        return {noReason, denied, positive}
    },
    then({noReason, denied, positive}) {
        noReason.toLowerCase().includes("reason")
        denied.includes("PERMISSION_DENIED")
        positive.results.reasonCode == "PAYMENT_VALIDATION_APPROVED"
    }
})

feature("a notification cannot approve changed banking identity and its original native event stays immutable", {
    when() {
        const h = helper(),
            created = draft(),
            message = notice(created),
            before = snapshot(created.paymentId),
            event = one(EVENT, {paymentLifecycleEventId: created.validationEventId}),
            originalEvent = JSON.stringify(h.lib.map(event)),
            bank = one("mantle.account.method.BankAccount", {paymentMethodId: f.methodId})
        h.call("update#mantle.account.method.BankAccount", {
            paymentMethodId: f.methodId,
            accountNumber: "Changed banking identity"
        })
        let denied
        try {
            login(f.users.treasury)
            denied = h.rejected("org.moqui.impl.NotificationServices.approve#NotificationMessage", {
                notificationMessageId: message.notificationMessageId
            })
        } finally {
            login("john.doe")
            h.call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, accountNumber: bank.accountNumber})
        }
        const immutable = h.rejected("update#" + EVENT, {
                paymentLifecycleEventId: event.paymentLifecycleEventId,
                expectedSourceVersion: "Forged version"
            }),
            eventUnchanged =
                JSON.stringify(h.lib.map(one(EVENT, {paymentLifecycleEventId: event.paymentLifecycleEventId}))) === originalEvent,
            unchanged = snapshot(created.paymentId) === before
        // A newly issued request is a valid control after the method's revision legitimately changed.
        const edited = h.native(
            "store#PaymentDraft",
            h.request(f, {paymentId: created.paymentId, sourceVersion: h.detail(f, created.paymentId).sourceVersion})
        )
        drain()
        login(f.users.treasury)
        const positive = decision("approve", {notificationMessageId: notice(edited).notificationMessageId})
        return {denied, immutable, eventUnchanged, unchanged, positive}
    },
    then({denied, immutable, eventUnchanged, unchanged, positive}) {
        denied.includes("STALE_PAYMENT_METHOD")
        immutable.includes("PAYMENT_HISTORY_IMMUTABLE")
        eventUnchanged == true
        unchanged == true
        positive.results.reasonCode == "PAYMENT_VALIDATION_APPROVED"
    }
})
