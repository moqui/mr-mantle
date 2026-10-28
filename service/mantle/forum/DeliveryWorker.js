/* Item-isolated durable delivery. Workers are internal-only. CC0 plus patent grant. */
const F = 'mantle.forum.',
    S = 'mantle.public.',
    E = 'mantle.party.communication.'
const find = (n, p) => ec.entity.find(n).condition(p || {})
const one = (n, p) => find(n, p).one()
const write = (n, p) => {
    const v = ec.entity.makeValue(n)
    for (const [k, x] of Object.entries(p)) v.set(k, x)
    v.create()
    return v
}
const set = (v, p) => {
    if (v.deliveryId) p = { ...p, revision: Number(v.revision || 0) + 1 }
    for (const [k, x] of Object.entries(p)) v.set(k, x)
    v.update()
}
const now = () => ec.user.nowTimestamp
const time = () => ec.user.timestampMillis(now())
const firstLine = (error) =>
    String(error?.message || error || '')
        .split('\n')[0]
        .slice(0, 200)
const policy = () =>
    ec.resource.script('component://mr-mantle/service/mantle/forum/Forum.js')
function audience(box, partyId) {
    const membership = one(S + 'PublicSiteParty', {
        siteId: box.siteId,
        partyId,
    })
    if (
        !membership ||
        membership.state !== 'active' ||
        (membership.thruDate &&
            ec.user.timestampMillis(membership.thruDate) <= time())
    )
        return null
    const event = one(E + 'CommunicationEvent', {
            communicationEventId: box.communicationEventId,
        }),
        st = one(F + 'ForumPostState', {
            communicationEventId: box.communicationEventId,
        })
    if (
        !event ||
        !st ||
        st.visibility !== 'approved' ||
        event.fromPartyId === partyId
    )
        return null
    const a = policy().categoryAccess(event.contactListId, partyId)
    if (
        !a ||
        !(
            a.canRead ||
            (a.canReadOwn &&
                (event.fromPartyId === partyId ||
                    find(E + 'CommunicationEvent', {
                        rootCommEventId: st.rootCommEventId,
                        fromPartyId: partyId,
                    }).count() > 0))
        )
    )
        return null
    const rootState = one(F + 'ForumPostState', {
            communicationEventId: st.rootCommEventId,
        }),
        rootEvent = one(E + 'CommunicationEvent', {
            communicationEventId: st.rootCommEventId,
        })
    if (
        rootState?.visibility !== 'approved' &&
        rootEvent?.fromPartyId !== partyId &&
        !a.canModerate
    )
        return null
    const scopes = [
        ['topic', st.rootCommEventId],
        ['category', event.contactListId],
        ['site', '_SITE_'],
    ]
    let watch = null,
        watchScope = null,
        email = null
    for (const [scopeType, scopeId] of scopes) {
        const key = { siteId: box.siteId, partyId, scopeType, scopeId }
        const level = one(F + 'ForumPreference', key)?.watchLevel
        if (!watch && level) {
            watch = level
            watchScope = { scopeType, scopeId }
        }
        const pref = one(F + 'ForumDeliveryPreference', key)
        if (pref?.suppressed === 'Y') email = 'None'
        email = email || pref?.emailMode
    }
    if (watch === 'Muted') return null
    const parent = event.parentCommEventId
        ? one(E + 'CommunicationEvent', {
              communicationEventId: event.parentCommEventId,
          })
        : null
    const repliedTo = parent?.fromPartyId === partyId
    if (watch !== 'Watching' && !repliedTo) return null
    // An opt-out link stops the delivery that caused this mail: the watched scope, or the topic for a reply.
    const scope =
        watch === 'Watching' && watchScope.scopeType !== 'site'
            ? watchScope
            : { scopeType: 'topic', scopeId: st.rootCommEventId }
    return { event, st, email: email || 'Notifications', scope }
}
/* Who can be notified at all: the parent post's author, then the topic, category and site watchers. */
function candidateSources(box) {
    const event = one(E + 'CommunicationEvent', {
            communicationEventId: box.communicationEventId,
        }),
        st = one(F + 'ForumPostState', {
            communicationEventId: box.communicationEventId,
        })
    if (!event || !st) return []
    const parent = event.parentCommEventId
        ? one(E + 'CommunicationEvent', {
              communicationEventId: event.parentCommEventId,
          })
        : null
    const watchers = (scopeType, scopeId) => (after, limit) =>
        Array.from(
            find(F + 'ForumPreference', {
                siteId: box.siteId,
                scopeType,
                scopeId,
                watchLevel: 'Watching',
            })
                .condition('partyId', 'greater', after || '')
                .orderBy('partyId')
                .limit(limit)
                .list(),
        ).map((row) => row.partyId)
    return [
        (after) =>
            !after && parent?.fromPartyId ? [parent.fromPartyId] : [],
        watchers('topic', st.rootCommEventId),
        watchers('category', event.contactListId),
        watchers('site', '_SITE_'),
    ]
}
function prepare(p) {
    const box = find(F + 'ForumOutbox', { outboxId: p.outboxId })
        .forUpdate(true)
        .one()
    if (!box || box.state !== 'pending') return { done: true }
    const sources = candidateSources(box)
    let position = { source: 0, after: null }
    try {
        if (box.cursor) position = JSON.parse(box.cursor)
    } catch (e) {
        // A cursor from before candidate sources restarts; existing deliveries are not duplicated.
    }
    let examined = 0
    while (position.source < sources.length && examined < 100) {
        const want = 100 - examined
        const partyIds = sources[position.source](position.after, want)
        for (const partyId of partyIds) {
            examined++
            position.after = partyId
            const allowed = audience(box, partyId)
            if (!allowed) continue
            for (const channel of [
                'in-app',
                ...(allowed.email === 'Notifications' ? ['email'] : []),
            ]) {
                if (
                    one(F + 'ForumDelivery', {
                        outboxId: box.outboxId,
                        partyId,
                        channel,
                    })
                )
                    continue
                write(F + 'ForumDelivery', {
                    deliveryId: ec.user.randomString(32),
                    siteId: box.siteId,
                    outboxId: box.outboxId,
                    partyId,
                    channel,
                    state: 'pending',
                    attempts: 0,
                    revision: 1,
                    dueAt: now(),
                })
            }
        }
        // A source that returned less than asked for is exhausted.
        if (partyIds.length < want)
            position = { source: position.source + 1, after: null }
    }
    const done = position.source >= sources.length
    set(box, {
        cursor: JSON.stringify(position),
        state: done ? 'prepared' : 'pending',
    })
    return { prepared: examined, done }
}
function claim(p) {
    const v = find(F + 'ForumDelivery', { deliveryId: p.deliveryId })
        .forUpdate(true)
        .one()
    if (
        !v ||
        !['pending', 'retry'].includes(v.state) ||
        ec.user.timestampMillis(v.dueAt) > time()
    )
        return { claimed: false }
    set(v, {
        state: 'sending',
        startedAt: now(),
        attempts: Number(v.attempts) + 1,
    })
    return { claimed: true }
}
function deliver(p) {
    const v = find(F + 'ForumDelivery', { deliveryId: p.deliveryId })
        .forUpdate(true)
        .one()
    if (!v || v.state !== 'sending') return {}
    const box = one(F + 'ForumOutbox', { outboxId: v.outboxId }),
        allowed = box ? audience(box, v.partyId) : null
    if (!allowed) {
        set(v, { state: 'suppressed' })
        return { state: 'suppressed' }
    }
    if (v.channel === 'in-app') {
        set(v, { state: 'sent' })
        return { state: 'sent' }
    }
    const settings = one(F + 'ForumMailSettings', { siteId: v.siteId }),
        ua = Array.from(
            find('moqui.security.UserAccount', { partyId: v.partyId })
                .orderBy('userId')
                .limit(100)
                .list(),
        ).find((u) => u.disabled !== 'Y')
    if (!settings || !ua?.emailAddress) {
        set(v, {
            state: 'failed',
            lastError: 'Mail settings or verified recipient are unavailable',
        })
        return { state: 'failed' }
    }
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    ) {
        set(v, { state: 'suppressed' })
        return { state: 'suppressed' }
    }
    const token = ec.user.randomString(64),
        host = one(S + 'PublicSiteHost', { siteId: v.siteId, canonical: 'Y' }),
        mountBase = (app) => {
            const m = one(S + 'PublicSiteApp', {
                siteId: v.siteId,
                app,
                enabled: 'Y',
            })
            return m ? (m.pathPrefix === '/' ? '' : m.pathPrefix) : null
        },
        accountBase = mountBase('account'),
        forumBase = mountBase('forum')
    if (!host || accountBase == null || forumBase == null) {
        set(v, {
            state: 'failed',
            lastError:
                'Canonical public host or account/forum mount is not configured',
        })
        return { state: 'failed' }
    }
    write(F + 'ForumOptOut', {
        tokenHash: ec.user.singleUseCodeHash(token),
        siteId: v.siteId,
        partyId: v.partyId,
        scopeType: allowed.scope.scopeType,
        scopeId: allowed.scope.scopeId,
        expiresAt: time() + 365 * 86400000,
    })
    const origin = 'https://' + host.hostname,
        unsubscribeUrl =
            origin +
            accountBase +
            '/Unsubscribe?token=' +
            encodeURIComponent(token),
        oneClickUrl =
            origin +
            accountBase +
            '/Unsubscribe/oneClick?token=' +
            encodeURIComponent(token),
        postUrl =
            origin +
            forumBase +
            '/p/' +
            encodeURIComponent(allowed.st.communicationEventId)
    const out = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.EmailServices.send#EmailTemplate')
        .parameters({
            emailTemplateId: settings.templateId,
            toAddresses: ua.emailAddress,
            extraHeaders: {
                'List-Unsubscribe': '<' + oneClickUrl + '>',
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                'List-Id': v.siteId + '.' + host.hostname,
            },
            bodyParameters: {
                unsubscribeUrl,
                postUrl,
                title: allowed.event.subject,
                siteId: v.siteId,
                rootCommEventId: allowed.st.rootCommEventId,
                postId: allowed.st.communicationEventId,
            },
        })
        .call()
    // A provider result without confirmation is uncertain; never automatically resend an ambiguous send.
    const outcome = out.messageId
        ? 'sent'
        : out.deliveryOutcome === 'retryable'
          ? Number(v.attempts) >= 5
              ? 'failed'
              : 'retry'
          : out.deliveryOutcome === 'permanent'
            ? 'failed'
            : 'uncertain'
    set(v, {
        state: outcome,
        providerId: out.messageId || null,
        dueAt:
            outcome === 'retry'
                ? time() +
                  Math.min(3600, Math.pow(2, Number(v.attempts)) * 60) * 1000
                : v.dueAt,
        lastError: out.messageId
            ? null
            : outcome === 'uncertain'
              ? 'Provider acceptance is unknown'
              : 'Provider rejected delivery',
    })
    return { state: v.state }
}
function reconcile(p) {
    const v = find(F + 'ForumDelivery', { deliveryId: p.deliveryId })
        .forUpdate(true)
        .one()
    if (
        v?.state === 'sending' &&
        ec.user.timestampMillis(v.startedAt || v.dueAt) < time() - 300000
    )
        // An in-app notice has no outside effect, so it simply retries; only mail can be ambiguous.
        set(
            v,
            v.channel === 'in-app'
                ? { state: 'retry', dueAt: now() }
                : {
                      state: 'uncertain',
                      lastError:
                          'Worker ended before provider acceptance was recorded',
                  },
        )
    return { state: v?.state }
}
function dispatch() {
    const failures = []
    let processed = 0
    for (const item of Array.from(
        find(F + 'ForumDelivery', { state: 'sending' })
            .orderBy('dueAt,deliveryId')
            .limit(100)
            .list(),
    )) {
        try {
            ec.service
                .sync()
                .throwOnError(true)
                .name('mantle.forum.DeliveryWorkerServices.reconcile#Delivery')
                .parameters({ deliveryId: item.deliveryId })
                .requireNewTransaction(true)
                .call()
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum delivery reconciliation failed for ' +
                    item.deliveryId +
                    ': ' +
                    firstLine(error),
            )
            failures.push(item.deliveryId)
        }
    }
    const items = Array.from(
        find(F + 'ForumOutbox', { state: 'pending' })
            .orderBy('createdAt,outboxId')
            .limit(100)
            .list(),
    )
    // Each page is its own transaction; keep preparing until done or the run's time budget is spent.
    const deadline = time() + 20000
    for (const item of items) {
        try {
            for (;;) {
                const page = ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.forum.DeliveryWorkerServices.prepare#Outbox')
                    .parameters({ outboxId: item.outboxId })
                    .requireNewTransaction(true)
                    .call().result
                processed++
                if (page.done || time() > deadline) break
            }
        } catch (e) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum outbox ' + item.outboxId + ' failed: ' + firstLine(e),
            )
            failures.push(item.outboxId)
        }
        if (time() > deadline) break
    }
    for (const item of Array.from(
        find(F + 'ForumDelivery', {})
            .condition('state', 'in', ['pending', 'retry'])
            .orderBy('dueAt,deliveryId')
            .limit(100)
            .list(),
    )) {
        try {
            const c = ec.service
                .sync()
                .throwOnError(true)
                .name('mantle.forum.DeliveryWorkerServices.claim#Delivery')
                .parameters({ deliveryId: item.deliveryId })
                .requireNewTransaction(true)
                .call().result
            if (c.claimed)
                ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.forum.DeliveryWorkerServices.send#Delivery')
                    .parameters({ deliveryId: item.deliveryId })
                    .requireNewTransaction(true)
                    .call()
            processed++
        } catch (e) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum delivery ' +
                    item.deliveryId +
                    ' failed; inspect uncertain attempt: ' +
                    firstLine(e),
            )
            failures.push(item.deliveryId)
        }
    }
    return { processed, failedItemIds: failures }
}
function execute(op, p) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return { prepare, claim, deliver, reconcile, dispatch }[op](p || {})
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
;({ execute })
