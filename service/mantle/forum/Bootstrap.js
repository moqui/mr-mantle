/* Disabled-site, checkpointed legacy metadata conversion. Each root is its own transaction. */
const F = 'mantle.forum.',
    E = 'mantle.party.communication.'
const find = (n, p) => ec.entity.find(n).condition(p || {})
const one = (n, p) => find(n, p).one()
const create = (n, p) => {
    const v = ec.entity.makeValue(n)
    for (const [k, x] of Object.entries(p)) v.set(k, x)
    v.create()
    return v
}
const update = (v, p) => {
    for (const [k, x] of Object.entries(p)) v.set(k, x)
    v.update()
}
function root(p) {
    const run = one(F + 'ForumJobRun', { runId: p.runId })
    if (!run) return {}
    const config = JSON.parse(run.checkpoint),
        category = one(F + 'ForumCategory', {
            contactListId: config.contactListId,
        })
    if (category?.publicationState === 'published')
        throw new Error('Conversion requires a disabled category')
    const root = one(E + 'CommunicationEvent', {
        communicationEventId: p.rootCommEventId,
    })
    if (!root || root.contactListId !== config.contactListId)
        throw new Error('Conversion root is not in its category')
    let topic = find(F + 'ForumTopic', { rootCommEventId: p.rootCommEventId })
        .forUpdate(true)
        .one()
    if (!topic)
        topic = create(F + 'ForumTopic', {
            rootCommEventId: p.rootCommEventId,
            siteId: category?.siteId || null,
            contactListId: config.contactListId,
            kind: 'category',
            revision: 1,
            nextOrdinal: 1,
            visiblePostCount: 0,
        })
    if (
        one(F + 'ForumJobItem', { runId: p.runId, itemId: p.rootCommEventId })
            ?.state === 'complete'
    )
        return { alreadyComplete: true }
    const cf = ec.entity.conditionFactory,
        events = [],
        condition = cf.makeCondition(
            [
                cf.makeCondition(
                    'communicationEventId',
                    'equals',
                    p.rootCommEventId,
                ),
                cf.makeCondition(
                    'rootCommEventId',
                    'equals',
                    p.rootCommEventId,
                ),
            ],
            'or',
        )
    // Workers page the source; no public request performs this conversion.
    for (let offset = 0; ; offset += 100) {
        const batch = Array.from(
            find(E + 'CommunicationEvent', {
                contactListId: config.contactListId,
            })
                .condition(condition)
                .orderBy('entryDate,communicationEventId')
                .offset(offset)
                .limit(100)
                .list(),
        )
        events.push(...batch)
        if (batch.length < 100) break
    }
    const states = Array.from(
            find(F + 'ForumPostState', {
                rootCommEventId: p.rootCommEventId,
            }).list(),
        ),
        existing = new Map(states.map((s) => [s.communicationEventId, s]))
    const changes = events.some(
        (e, i) =>
            existing.has(e.communicationEventId) &&
            Number(existing.get(e.communicationEventId).ordinal) !== i + 1,
    )
    if (
        changes &&
        find(F + 'ForumTopicUser', {
            rootCommEventId: p.rootCommEventId,
        }).count() > 0
    )
        throw new Error(
            'Tracking positions need explicit reconciliation before ordinals change',
        )
    if (changes) {
        let temporary = -1
        for (const state of states) update(state, { ordinal: temporary-- })
    }
    let visible = 0,
        lastActivity = root.entryDate
    for (let i = 0; i < events.length; i++) {
        const event = events[i],
            old = existing.get(event.communicationEventId),
            visibility =
                old?.visibility ||
                (event.statusId === 'CeCancelled' ? 'deleted' : 'approved')
        if (old) update(old, { ordinal: i + 1 })
        else
            create(F + 'ForumPostState', {
                communicationEventId: event.communicationEventId,
                rootCommEventId: p.rootCommEventId,
                ordinal: i + 1,
                revision: 1,
                approvedRevision: visibility === 'approved' ? 1 : null,
                visibility,
            })
        if (
            !one(F + 'ForumPostRevision', {
                communicationEventId: event.communicationEventId,
                revision: 1,
            })
        )
            create(F + 'ForumPostRevision', {
                communicationEventId: event.communicationEventId,
                revision: 1,
                sourceFormat: 'html',
                sourceText: event.body || '',
                sanitizedBody: StringUtilities.cleanHtml(event.body || ''),
                editorPartyId: event.fromPartyId,
                editedAt: event.entryDate,
                publicHistoryAllowed: 'N',
            })
        if (visibility === 'approved') {
            visible++
            lastActivity = event.entryDate
        }
    }
    update(topic, {
        siteId: category?.siteId || null,
        contactListId: config.contactListId,
        nextOrdinal: events.length + 1,
        visiblePostCount: visible,
        lastActivity,
        revision: Number(topic.revision) + 1,
    })
    const key = { runId: p.runId, itemId: p.rootCommEventId },
        item = one(F + 'ForumJobItem', key)
    item
        ? update(item, {
              state: 'complete',
              errorText: null,
              attempts: Number(item.attempts) + 1,
          })
        : create(F + 'ForumJobItem', { ...key, state: 'complete', attempts: 1 })
    return { postCount: events.length }
}
function dispatch() {
    const failed = []
    for (const run of Array.from(
        find(F + 'ForumJobRun', { jobType: 'bootstrap', state: 'pending' })
            .limit(20)
            .list(),
    )) {
        // One run with a bad checkpoint must not stop the others.
        try {
            dispatchRun(run, failed)
        } catch (e) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum conversion run ' +
                    run.runId +
                    ' could not continue: ' +
                    String(e?.message || e).split('\n')[0],
            )
        }
    }
    return { failedRootIds: failed }
}
function dispatchRun(run, failed) {
    const config = JSON.parse(run.checkpoint)
    let query = find(E + 'CommunicationEvent', {
        contactListId: config.contactListId,
        rootCommEventId: null,
    })
    if (config.after)
        query = query.condition(
            'communicationEventId',
            'greater',
            config.after,
        )
    const roots = Array.from(
        query.orderBy('communicationEventId').limit(10).list(),
    )
    for (const event of roots) {
        const key = { runId: run.runId, itemId: event.communicationEventId }
        if (one(F + 'ForumJobItem', key)?.state === 'complete') {
            config.after = event.communicationEventId
            continue
        }
        try {
            ec.service
                .sync()
                .throwOnError(true)
                .name('mantle.forum.BootstrapServices.convert#Root')
                .parameters({
                    runId: run.runId,
                    rootCommEventId: event.communicationEventId,
                })
                .requireNewTransaction(true)
                .call()
            update(run, { successCount: Number(run.successCount) + 1 })
        } catch (e) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum conversion failed for root ' +
                    event.communicationEventId +
                    ' in run ' +
                    run.runId +
                    ': ' +
                    String(e?.message || e).split('\n')[0],
            )
            const item = one(F + 'ForumJobItem', key)
            item
                ? update(item, {
                      state: 'failed',
                      errorText:
                          'Root conversion failed; inspect correlation log',
                      attempts: Number(item.attempts) + 1,
                  })
                : create(F + 'ForumJobItem', {
                      ...key,
                      state: 'failed',
                      attempts: 1,
                      errorText:
                          'Root conversion failed; inspect correlation log',
                  })
            update(run, { failedCount: Number(run.failedCount) + 1 })
            failed.push(event.communicationEventId)
        }
        config.after = event.communicationEventId
        update(run, { checkpoint: JSON.stringify(config) })
    }
    update(run, { checkpoint: JSON.stringify(config) })
    if (roots.length < 10)
        update(run, {
            state: Number(run.failedCount) > 0 ? 'failed' : 'complete',
        })
}
function execute(op, p) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return op === 'root' ? root(p) : dispatch()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
;({ execute })
