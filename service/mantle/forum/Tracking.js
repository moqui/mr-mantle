/* Group-derived mode changes take effect immediately; historic state converts per root with checkpoints. */
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
const now = () => ec.user.nowTimestamp
function refresh(p) {
    const account = one('moqui.security.UserAccount', { userId: p.userId })
    if (!account?.partyId) return {}
    const partyId = account.partyId,
        mode = ec.resource
            .script('component://mr-mantle/service/mantle/forum/Forum.js')
            .internalParty(partyId)
            ? 'internal'
            : 'public'
    let old = find(F + 'ForumTrackingMode', { partyId })
        .forUpdate(true)
        .one()
    const prior =
        old?.mode ||
        (mode === 'public' &&
        find(E + 'CommunicationEventParty', { partyId })
            .limit(1)
            .count() > 0
            ? 'internal'
            : mode === 'internal' &&
                find(F + 'ForumTopicUser', { partyId })
                    .limit(1)
                    .count() > 0
              ? 'public'
              : mode)
    if (old && prior === mode && !p.force) return { mode }
    const effectiveAt = now(),
        runId = ec.user.randomString(32),
        changed = prior !== mode || p.force === true
    const fields = {
        partyId,
        mode,
        effectiveAt,
        checkpoint: changed ? runId : null,
    }
    old ? update(old, fields) : create(F + 'ForumTrackingMode', fields)
    if (changed)
        create(F + 'ForumJobRun', {
            runId,
            partyId,
            jobType: 'tracking',
            state: 'pending',
            createdAt: effectiveAt,
            successCount: 0,
            failedCount: 0,
            checkpoint: JSON.stringify({
                partyId,
                mode,
                phase: 'markers',
                after: '',
            }),
        })
    return { mode, runId: changed ? runId : null }
}
function root(p) {
    const run = one(F + 'ForumJobRun', { runId: p.runId })
    if (!run || run.state !== 'pending') return {}
    const config = JSON.parse(run.checkpoint),
        mode = one(F + 'ForumTrackingMode', { partyId: config.partyId })
    if (mode?.checkpoint !== run.runId) return { cancelled: true }
    const key = { runId: p.runId, itemId: p.rootCommEventId }
    if (one(F + 'ForumJobItem', key)?.state === 'complete')
        return { alreadyComplete: true }
    const topic = find(F + 'ForumTopic', { rootCommEventId: p.rootCommEventId })
        .forUpdate(true)
        .one()
    if (!topic) throw new Error('Topic metadata conversion is required')
    if (config.mode === 'public') {
        const markerKey = {
                rootCommEventId: p.rootCommEventId,
                partyId: config.partyId,
            },
            old = find(F + 'ForumTopicUser', markerKey)
                .forUpdate(true)
                .one()
        const unread = Array.from(
            find(F + 'ForumReceiptState', {
                rootCommEventId: p.rootCommEventId,
                partyId: config.partyId,
                readDate: null,
            })
                .condition('roleTypeId', 'in', [
                    'MessageTo',
                    'MessageCc',
                    'MessageMailbox',
                ])
                .orderBy('ordinal')
                .limit(1)
                .list(),
        )[0]
        const lastReceipt = Array.from(
            find(F + 'ForumReceiptState', {
                rootCommEventId: p.rootCommEventId,
                partyId: config.partyId,
            })
                .condition('roleTypeId', 'in', [
                    'MessageTo',
                    'MessageCc',
                    'MessageMailbox',
                ])
                .orderBy('-ordinal')
                .limit(1)
                .list(),
        )[0]
        // New public posts can arrive before conversion. Missing receipts are not evidence of reading.
        const safeBoundary = unread
            ? Math.max(0, Number(unread.ordinal) - 1)
            : Number(lastReceipt?.ordinal || 0)
        const consumed = old
            ? Math.min(Number(old.consumedOrdinal || 0), safeBoundary)
            : safeBoundary
        const fields = {
            ...markerKey,
            consumedOrdinal: consumed,
            highestSeenOrdinal: Number(old?.highestSeenOrdinal || 0),
            markerRevision: Number(old?.markerRevision || 0) + 1,
        }
        old ? update(old, fields) : create(F + 'ForumTopicUser', fields)
    }
    // Public -> internal keeps the marker. Only future sends allocate individual receipts.
    const item = one(F + 'ForumJobItem', key)
    item
        ? update(item, {
              state: 'complete',
              attempts: Number(item.attempts) + 1,
              errorText: null,
          })
        : create(F + 'ForumJobItem', { ...key, state: 'complete', attempts: 1 })
    return { converted: true }
}
function dispatch() {
    const failed = []
    let scan = one(F + 'ForumJobRun', { runId: 'FORUM_MODE_SCAN' })
    if (!scan)
        scan = create(F + 'ForumJobRun', {
            runId: 'FORUM_MODE_SCAN',
            jobType: 'mode-scan',
            state: 'pending',
            createdAt: now(),
            checkpoint: '',
            successCount: 0,
            failedCount: 0,
        })
    let modes = find(F + 'ForumTrackingMode', {})
    if (scan.checkpoint)
        modes = modes.condition('partyId', 'greater', scan.checkpoint)
    const modePage = Array.from(modes.orderBy('partyId').limit(100).list())
    for (const mode of modePage) {
        try {
            const account = Array.from(
                find('moqui.security.UserAccount', { partyId: mode.partyId })
                    .orderBy('userId')
                    .limit(1)
                    .list(),
            )[0]
            if (account)
                ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.forum.TrackingServices.refresh#Mode')
                    .parameters({ userId: account.userId })
                    .requireNewTransaction(true)
                    .call()
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum tracking eligibility refresh failed for party ' +
                    mode.partyId,
            )
        }
    }
    update(scan, {
        checkpoint:
            modePage.length === 100
                ? modePage[modePage.length - 1].partyId
                : '',
    })
    for (const run of Array.from(
        find(F + 'ForumJobRun', { jobType: 'tracking', state: 'pending' })
            .orderBy('createdAt,runId')
            .limit(20)
            .list(),
    )) {
        const config = JSON.parse(run.checkpoint),
            mode = one(F + 'ForumTrackingMode', { partyId: config.partyId })
        if (mode?.checkpoint !== run.runId) {
            update(run, { state: 'cancelled' })
            continue
        }
        const source =
                config.phase === 'markers'
                    ? F + 'ForumTopicUser'
                    : F + 'ForumMailboxReceipt',
            keyField =
                config.phase === 'markers'
                    ? 'rootCommEventId'
                    : 'communicationEventId'
        let query = find(source, { partyId: config.partyId })
            .selectField(keyField)
            .selectField('rootCommEventId')
            .distinct(true)
            .orderBy(keyField)
        if (config.after)
            query = query.condition(keyField, 'greater', config.after)
        const roots = Array.from(query.limit(100).list())
        for (const entry of roots) {
            const rootCommEventId =
                entry.rootCommEventId || entry.communicationEventId
            if (
                one(F + 'ForumJobItem', {
                    runId: run.runId,
                    itemId: rootCommEventId,
                })?.state === 'failed'
            ) {
                config.after = entry[keyField]
                continue
            }
            try {
                ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.forum.TrackingServices.convert#Root')
                    .parameters({
                        runId: run.runId,
                        rootCommEventId: rootCommEventId,
                    })
                    .requireNewTransaction(true)
                    .call()
                update(run, { successCount: Number(run.successCount) + 1 })
            } catch (error) {
                ec.message.clearErrors()
                ec.logger.error(
                    'Forum tracking conversion failed for party ' +
                        config.partyId +
                        ' root ' +
                        rootCommEventId,
                )
                failed.push(rootCommEventId)
                const key = { runId: run.runId, itemId: rootCommEventId },
                    item = one(F + 'ForumJobItem', key)
                item
                    ? update(item, {
                          state: 'failed',
                          errorText:
                              'Tracking conversion requires reconciliation',
                          attempts: Number(item.attempts) + 1,
                      })
                    : create(F + 'ForumJobItem', {
                          ...key,
                          state: 'failed',
                          attempts: 1,
                          errorText:
                              'Tracking conversion requires reconciliation',
                      })
                update(run, { failedCount: Number(run.failedCount) + 1 })
            }
            config.after = entry[keyField]
            update(run, { checkpoint: JSON.stringify(config) })
        }
        if (roots.length < 100) {
            if (config.phase === 'markers') {
                config.phase = 'receipts'
                config.after = ''
                update(run, { checkpoint: JSON.stringify(config) })
            } else
                update(run, {
                    state: Number(run.failedCount) > 0 ? 'failed' : 'complete',
                })
        }
    }
    return { failedRootIds: failed }
}
function execute(op, p) {
    const old = ec.artifactExecution.disableAuthz()
    try {
        return { refresh, root, dispatch }[op](p || {})
    } finally {
        if (!old) ec.artifactExecution.enableAuthz()
    }
}
;({ execute })
