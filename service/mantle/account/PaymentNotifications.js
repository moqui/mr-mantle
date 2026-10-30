// Durable payment-validation delivery. Publication is separate from a completed financial transaction.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {lib} = workflow,
    {find, one, call, policy, denied} = lib
const EVENT = "mantle.account.payment.PaymentLifecycleEvent",
    PUBLICATION = "mantle.account.payment.PaymentValidationPublication",
    DELIVERY = "mantle.account.payment.PaymentValidationDelivery"
function prepare(p) {
    if (!p.validationRequired || !p.validationEventId) return {prepared: false}
    const event = one(EVENT, {paymentLifecycleEventId: p.validationEventId})
    if (
        !event ||
        event.paymentId !== p.paymentId ||
        !event.expectedSourceVersion ||
        event.expectedSourceVersion !== p.validationSourceVersion ||
        !["create", "edit"].includes(event.action)
    )
        denied("PAYMENT_VALIDATION_EVENT_INVALID", "The validation request does not match its native payment event")
    workflow.paymentScope({organizationPartyId: event.organizationPartyId, paymentId: event.paymentId}, true)
    if (!one(PUBLICATION, {validationEventId: p.validationEventId}))
        call("create#" + PUBLICATION, {
            validationEventId: p.validationEventId,
            organizationPartyId: event.organizationPartyId,
            paymentId: event.paymentId,
            sourceVersion: event.expectedSourceVersion,
            status: "pending",
            createdDate: ec.user.nowTimestamp
        })
    return {prepared: true}
}
function permissions(userId) {
    const groups = Array.from(ec.user.getUserGroupIdSet(userId)),
        admin = groups.includes("ADMIN")
    const granted = new Set(
        Array.from(
            find("moqui.security.UserGroupPermission")
                .condition("userGroupId", "in", groups)
                .conditionDate("fromDate", "thruDate", null)
                .list()
        ).map(row => row.userPermissionId)
    )
    return {
        groups,
        admin,
        granted,
        edit: admin || (!granted.has("PROJECT_CLIENT") && granted.has("PAYMENT_EDIT")),
        broad:
            admin ||
            (!granted.has("PROJECT_CLIENT") &&
                ["PAYMENT_VIEW", "ACCOUNTING_VIEW", "ACCOUNTING_ADMIN"].some(id => granted.has(id)))
    }
}
function activeOrganization(user, access) {
    const personal = one("moqui.security.UserPreference", {userId: user.userId, preferenceKey: "ACTIVE_ORGANIZATION"})
    if (personal) return personal.preferenceValue || null
    return (
        find("moqui.security.UserGroupPreference")
            .condition("userGroupId", "in", access.groups)
            .condition("preferenceKey", "ACTIVE_ORGANIZATION")
            .orderBy("-groupPriority,userGroupId")
            .one()?.preferenceValue || null
    )
}
function relatedOrganization(partyId, org) {
    if (!partyId) return false
    const parents = Array.from(
            find("mantle.party.PartyRelationship", {fromPartyId: org, relationshipTypeEnumId: "PrtOrgRollup"})
                .conditionDate("fromDate", "thruDate", null)
                .list()
        ).map(row => row.toPartyId),
        organizations = [org, ...parents].filter(id => one("mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"}))
    return (
        find("mantle.party.PartyRelationship", {fromPartyId: partyId})
            .condition("toPartyId", "in", organizations)
            .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee", "PrtMember"])
            .conditionDate("fromDate", "thruDate", null)
            .count() > 0
    )
}
function recipient(userId, publication) {
    const user = one("moqui.security.UserAccount", {userId}),
        access = permissions(userId)
    if (
        !user ||
        user.disabled === "Y" ||
        (user.terminateDate && policy.ms(user.terminateDate) <= policy.ms(ec.user.nowTimestamp)) ||
        !access.edit ||
        !access.broad
    )
        return false
    const payment = one(workflow.P, {paymentId: publication.paymentId})
    if (!payment) return false
    if (!access.admin) {
        for (const partyId of [payment.fromPartyId, payment.toPartyId]) {
            const party = one("mantle.party.Party", {partyId})
            if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== userId)) return false
        }
        const org = publication.organizationPartyId,
            related = relatedOrganization(user.partyId, org),
            financeAdmin = access.granted.has("ACCOUNTING_ADMIN"),
            active = activeOrganization(user, access)
        if (!financeAdmin && !related) return false
        // Native finance ignores an invalid active selection, and otherwise limits the selected organization.
        if (active && one("mantle.party.PartyRole", {partyId: active, roleTypeId: "OrgInternal"})) {
            const activeRelated = financeAdmin || relatedOrganization(user.partyId, active)
            if (activeRelated && active !== org) return false
        }
    }
    return true
}
function eligibleUsers(publication, failures = []) {
    const ids = new Set(
        Array.from(
            find("moqui.security.UserPermissionCheck", {userPermissionId: "PAYMENT_EDIT"})
                .conditionDate("groupFromDate", "groupThruDate", null)
                .conditionDate("permissionFromDate", "permissionThruDate", null)
                .selectField("userId")
                .distinct(true)
                .list()
        ).map(row => row.userId)
    )
    for (const member of find("moqui.security.UserGroupMember", {userGroupId: "ADMIN"})
        .conditionDate("fromDate", "thruDate", null)
        .list())
        ids.add(member.userId)
    const eligible = []
    for (const userId of [...ids].sort()) {
        ec.message.pushErrors()
        try {
            if (recipient(userId, publication)) eligible.push(userId)
        } catch (error) {
            ec.logger.error(
                "Payment validation " + publication.validationEventId + " recipient authority " + userId + ": " + error.message
            )
            // Unknown authority cannot disclose that user's identity in the caller's response.
            failures.push({status: "failed", reasonCode: "RECIPIENT_AUTHORITY_UNAVAILABLE"})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return eligible
}
function current(publication) {
    const event = one(EVENT, {paymentLifecycleEventId: publication.validationEventId})
    if (
        !event ||
        event.organizationPartyId !== publication.organizationPartyId ||
        event.paymentId !== publication.paymentId ||
        event.expectedSourceVersion !== publication.sourceVersion ||
        !["create", "edit"].includes(event.action)
    )
        denied("PAYMENT_VALIDATION_EVENT_INVALID", "The publication does not match its immutable validation event")
    // Transaction-commit workers have no login. The immutable event authorizes this internal-only work, while
    // each recipient is checked independently. Interactive callers retain the native payment write gate.
    if (ec.user.userId)
        workflow.paymentScope({organizationPartyId: publication.organizationPartyId, paymentId: publication.paymentId}, true)
    const payment = one(workflow.P, {paymentId: publication.paymentId})
    return (
        payment?.lifecycleManaged === "Y" &&
        payment.financeOrganizationPartyId === publication.organizationPartyId &&
        payment.statusId === "PmntProposed" &&
        workflow.paymentVersion(payment) === publication.sourceVersion
    )
}
function send(p) {
    const publication = find(PUBLICATION, {validationEventId: p.validationEventId}).forUpdate(true).one()
    if (!publication) denied("PAYMENT_VALIDATION_EVENT_INVALID", "The validation request is unavailable")
    if (decided(publication)) {
        if (ec.user.userId)
            workflow.paymentScope({organizationPartyId: publication.organizationPartyId, paymentId: publication.paymentId}, true)
        return {userId: p.userId, status: "decided"}
    }
    if (!current(publication) || !recipient(p.userId, publication)) return {userId: p.userId, status: "unavailable"}
    const old = one(DELIVERY, {validationEventId: p.validationEventId, userId: p.userId})
    if (old?.status === "sent")
        return {userId: p.userId, status: "sent", notificationMessageId: old.notificationMessageId, alreadySent: true}
    const message = {
        organizationPartyId: publication.organizationPartyId,
        paymentId: publication.paymentId,
        validationEventId: publication.validationEventId,
        sourceVersion: publication.sourceVersion
    }
    const notice = ec
        .makeNotificationMessage()
        .topic("PaymentValidation")
        .subTopic(publication.validationEventId)
        .userIds([p.userId])
        .actorUserId(one(EVENT, {paymentLifecycleEventId: publication.validationEventId}).userId)
        .message(message)
    notice.record(workflow.P, publication.paymentId)
    notice.send()
    const notificationMessageId = notice.getNotificationMessageId()
    if (!notificationMessageId) throw new Error("Payment validation notification did not retain a message identity")
    call("store#" + DELIVERY, {
        validationEventId: p.validationEventId,
        userId: p.userId,
        status: "sent",
        notificationMessageId,
        lastAttemptDate: ec.user.nowTimestamp,
        lastError: null
    })
    return {userId: p.userId, status: "sent", notificationMessageId, alreadySent: false}
}
function process(p) {
    if (ec.user.userId && !p.validationEventId && !lib.has("ACCOUNTING_ADMIN"))
        denied("PERMISSION_DENIED", "Accounting administration is required to retry pending validation notices")
    let query = find(PUBLICATION).condition("status", "in", ["pending", "failed"])
    if (ec.user.userId && !p.validationEventId)
        query = query.condition("organizationPartyId", "in", policy.access().allowedOrganizationPartyIds)
    if (p.validationEventId) query = query.condition("validationEventId", p.validationEventId)
    if (p.afterEventId) query = query.condition("validationEventId", "greater", p.afterEventId)
    const maximum = Math.max(1, Math.min(200, Number(p.limit || 100))),
        rows = Array.from(
            query
                .orderBy("validationEventId")
                .limit(maximum + 1)
                .list()
        ),
        results = []
    for (const publication of rows.slice(0, maximum)) {
        ec.message.pushErrors()
        try {
            results.push(
                ec.service
                    .sync()
                    .name("mantle.account.PaymentNotificationServices.publish#PaymentValidationNotice")
                    .parameters({validationEventId: publication.validationEventId})
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .throwOnError(true)
                    .call()
            )
        } catch (error) {
            ec.logger.error("Payment validation " + publication.validationEventId + ": " + error.message)
            results.push({validationEventId: publication.validationEventId, status: "failed", error: String(error.message)})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {
        results,
        incomplete: rows.length > maximum,
        nextEventId: rows.length > maximum ? rows[maximum - 1].validationEventId : null
    }
}
function publish(p) {
    const publication = one(PUBLICATION, {validationEventId: p.validationEventId})
    if (!publication) denied("PAYMENT_VALIDATION_EVENT_INVALID", "The validation request is unavailable")
    if (decided(publication)) return Object.assign(retireOne(p), {recipients: []})
    if (!current(publication)) return Object.assign(retireOne(p), {recipients: []})
    const recipients = [],
        failures = []
    for (const userId of eligibleUsers(publication, failures)) {
        ec.message.pushErrors()
        try {
            recipients.push(
                ec.service
                    .sync()
                    .name("mantle.account.PaymentNotificationServices.send#PaymentValidationNotice")
                    .parameters({validationEventId: publication.validationEventId, userId})
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .throwOnError(true)
                    .call()
            )
        } catch (error) {
            const failure = {userId, status: "failed", error: String(error.message)}
            ec.logger.error("Payment validation " + publication.validationEventId + " recipient " + userId + ": " + failure.error)
            failures.push(failure)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    // Child sends finish before this lock: a final decision must not be overwritten by a late publisher.
    const finalPublication = find(PUBLICATION, {validationEventId: p.validationEventId}).forUpdate(true).one()
    if (decided(finalPublication) || !current(finalPublication))
        return Object.assign(retireOne(p), {recipients: [...recipients, ...failures]})
    call("update#" + PUBLICATION, {
        validationEventId: publication.validationEventId,
        status: failures.length ? "failed" : "sent",
        lastAttemptDate: ec.user.nowTimestamp,
        lastError: failures.length ? JSON.stringify(failures) : null
    })
    return {
        validationEventId: publication.validationEventId,
        status: failures.length ? "failed" : "sent",
        recipients: [...recipients, ...failures]
    }
}
function decided(publication) {
    const operationKey = "pval:" + policy.hash(publication.validationEventId).slice(0, 35),
        operation = one("mantle.ledger.transaction.PostingOperation", {operationKey})
    if (
        operation?.status !== "complete" ||
        operation.operationType !== "PaymentValidationDecision" ||
        operation.organizationPartyId !== publication.organizationPartyId
    )
        return false
    const result = JSON.parse(operation.resultJson || "{}"),
        event = result.paymentLifecycleEventId && one(EVENT, {paymentLifecycleEventId: result.paymentLifecycleEventId})
    return (
        result.validationEventId === publication.validationEventId &&
        result.paymentId === publication.paymentId &&
        ["approved", "refused"].includes(result.decision) &&
        event?.paymentId === publication.paymentId &&
        event.organizationPartyId === publication.organizationPartyId &&
        event.sourceValidationEventId === publication.validationEventId &&
        event.action === (result.decision === "approved" ? "validate" : "validationRejected")
    )
}
function retireOne(p) {
    const publication = find(PUBLICATION, {validationEventId: p.validationEventId}).forUpdate(true).one()
    if (!publication) denied("PAYMENT_VALIDATION_EVENT_INVALID", "The validation request is unavailable")
    const live = current(publication),
        decision = decided(publication)
    if (live && !decision) return {validationEventId: publication.validationEventId, status: publication.status}
    const deliveries = Array.from(find(DELIVERY, {validationEventId: publication.validationEventId, status: "sent"}).list()),
        ids = deliveries.map(row => row.notificationMessageId).filter(Boolean)
    if (ids.length)
        for (const row of find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", ids)
            .condition("viewedDate", null)
            .list())
            call("update#moqui.security.user.NotificationMessageUser", {
                notificationMessageId: row.notificationMessageId,
                userId: row.userId,
                viewedDate: ec.user.nowTimestamp
            })
    const status = decision ? "decided" : "obsolete"
    call("update#" + PUBLICATION, {
        validationEventId: publication.validationEventId,
        status,
        lastAttemptDate: ec.user.nowTimestamp
    })
    return {validationEventId: publication.validationEventId, status}
}
function retire(p) {
    if (ec.user.userId) {
        const publication = one(PUBLICATION, {paymentId: p.paymentId})
        workflow.paymentScope({paymentId: p.paymentId, organizationPartyId: publication?.organizationPartyId}, true)
    }
    const results = []
    for (const publication of find(PUBLICATION, {paymentId: p.paymentId})
        .condition("status", "in", ["pending", "failed", "sent"])
        .orderBy("validationEventId")
        .list()) {
        ec.message.pushErrors()
        try {
            results.push(
                ec.service
                    .sync()
                    .name("mantle.account.PaymentNotificationServices.retire#PaymentValidationNotice")
                    .parameters({validationEventId: publication.validationEventId})
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .throwOnError(true)
                    .call()
            )
        } catch (error) {
            ec.logger.error("Payment validation retirement " + publication.validationEventId + ": " + error.message)
            results.push({validationEventId: publication.validationEventId, status: "failed", error: String(error.message)})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {results}
}
;({prepare, process, publish, send, recipient, eligibleUsers, retire, retireOne})
