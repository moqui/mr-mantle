/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shared authority implementation. Only allow-listed service wrappers invoke execute().
 * Entity access is privileged here; every object projection passes current domain policy first.
 */
const F = 'mantle.forum.',
    S = 'mantle.public.',
    E = 'mantle.party.communication.'
const now = () => ec.user.nowTimestamp
const millis = (value) => (value == null ? 0 : ec.user.timestampMillis(value))
/* A time stamp for an entity condition from epoch milliseconds. */
const stamp = (ms) => new Date(ms)
const id = () => ec.user.randomString(32)
const hash = (text) => ec.user.singleUseCodeHash(String(text))
const me = () =>
    ec.user.userAccount?.partyId ||
    (ec.user.userId
        ? ec.entity
              .find('moqui.security.UserAccount')
              .condition('userId', ec.user.userId)
              .disableAuthz()
              .one()?.partyId
        : null) ||
    null
const find = (entity, fields) => ec.entity.find(entity).condition(fields || {})
const one = (entity, fields, lock) =>
    (lock ? find(entity, fields).forUpdate(true) : find(entity, fields)).one()
const rows = (entity, fields, limit = 100) =>
    Array.from(find(entity, fields).limit(limit).list())
const create = (entity, fields) => {
    const v = ec.entity.makeValue(entity)
    for (const [k, x] of Object.entries(fields)) v.set(k, x)
    v.create()
    return v
}
const update = (v, fields) => {
    for (const [k, x] of Object.entries(fields)) v.set(k, x)
    v.update()
    return v
}
const pick = (v, names) =>
    Object.fromEntries(names.split(' ').map((k) => [k, v?.[k] ?? null]))
function fail(kind, message) {
    const e = new Error(message)
    e.moquiErrorKind = kind
    throw e
}
const missing = () => fail('NotFound', 'Resource not found')
const invalid = (text) => fail('Unprocessable', text)
const requireUser = () => {
    const party = me()
    if (!party) fail('AuthenticationRequired', 'Sign in to continue')
    return party
}
const active = (row) =>
    row &&
    (!row.fromDate || millis(row.fromDate) <= millis(now())) &&
    (!row.thruDate || millis(row.thruDate) > millis(now()))
const member = (siteId, partyId = me()) =>
    partyId ? one(S + 'PublicSiteParty', { siteId, partyId }) : null
const isOperator = () => ec.user.isInGroup('ADMIN')
function site(id, staff = false) {
    const v = one(S + 'PublicSite', { siteId: id }, staff)
    if (!v) missing()
    const m = member(id),
        owner =
            active(m) &&
            m.state === 'active' &&
            m.role === 'owner' &&
            !sanctioned(id, m.partyId, null, 'suspend')
    if (staff && !owner && !isOperator())
        fail('Unauthorized', 'Site owner access required')
    // Internal staff keep using bound mailboxes through Comms before publication; category access still decides
    // what they can read there.
    if (
        v.state !== 'published' &&
        !owner &&
        !isOperator() &&
        !internalParty(me())
    )
        missing()
    return v
}
function revision(row, expected) {
    if (
        expected == null ||
        Number(expected) !== Number(row.revision ?? row.policyRevision)
    )
        fail('Conflict', 'State changed; reload and compare before saving')
}
function bump(siteId) {
    const s = one(S + 'PublicSite', { siteId }, true)
    update(s, { generation: Number(s.generation || 0) + 1 })
}
function sanctioned(siteId, partyId, contactListId, kind) {
    if (!partyId) return false
    const cf = ec.entity.conditionFactory
    return (
        find(F + 'ForumSanction', { siteId, partyId, kind })
            .conditionDate('fromDate', 'thruDate', now())
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('contactListId', 'equals', null),
                        cf.makeCondition(
                            'contactListId',
                            'equals',
                            contactListId || null,
                        ),
                    ],
                    'or',
                ),
            )
            .count() > 0
    )
}

function listMember(contactListId, partyId) {
    if (!partyId) return null
    return (
        Array.from(
            find('mantle.marketing.contact.ContactListParty', {
                contactListId,
                partyId,
                statusId: 'CLPT_ACCEPTED',
            })
                .conditionDate('fromDate', 'thruDate', now())
                .orderBy('-fromDate')
                .limit(1)
                .list(),
        )[0] || null
    )
}
/* Read-heavy loops (topic lists, search, summaries) evaluate the same category for the same actor many times.
   Inside withAccessMemo those answers are kept for the rest of that one call; writes never run inside it. */
let accessMemo = null
function withAccessMemo(work) {
    const outer = accessMemo
    accessMemo = outer || new Map()
    try {
        return work()
    } finally {
        accessMemo = outer
    }
}
function categoryAccess(contactListId, actor = me(), seen = new Set()) {
    if (accessMemo && seen.size === 0) {
        const key = contactListId + '|' + (actor || '')
        if (!accessMemo.has(key))
            accessMemo.set(
                key,
                evaluateCategoryAccess(contactListId, actor, seen),
            )
        return accessMemo.get(key)
    }
    return evaluateCategoryAccess(contactListId, actor, seen)
}
function evaluateCategoryAccess(contactListId, actor, seen) {
    const c = one(F + 'ForumCategory', { contactListId })
    if (!c || seen.has(contactListId)) return null
    seen.add(contactListId)
    const s = one(S + 'PublicSite', { siteId: c.siteId }),
        m = member(c.siteId, actor),
        lm = listMember(contactListId, actor)
    const joined =
        active(m) &&
        m.state === 'active' &&
        !sanctioned(c.siteId, actor, contactListId, 'suspend')
    const owner = joined && m.role === 'owner',
        staff = joined && ['owner', 'moderator'].includes(m.role)
    // Internal list members keep their mailbox through Comms whether or not they ever join the public site.
    const internalMember =
        !!lm &&
        internalParty(actor) &&
        !sanctioned(c.siteId, actor, contactListId, 'suspend')
    const participant = joined || internalMember
    const categoryStaff =
        participant &&
        !!lm &&
        ['ListOwner', 'ListModerator'].includes(lm.roleTypeId) &&
        !sanctioned(c.siteId, actor, contactListId, 'suspend')
    let moderate = staff || categoryStaff || (actor === me() && isOperator())
    const grants = actor
        ? rows(
              S + 'PublicAccessGrant',
              {
                  siteId: c.siteId,
                  partyId: actor,
                  targetType: 'category',
                  targetId: contactListId,
              },
              100,
          )
        : []
    const granted = grants.some((g) => active(g) && !g.revokedAt)
    const published =
        s?.state === 'published' && c.publicationState === 'published'
    let read =
        moderate ||
        internalMember ||
        (published &&
            (c.visibility === 'public' ||
                (joined && (c.visibility === 'members' || !!lm || granted))))
    if (c.visibility === 'help' && !moderate && !lm) read = false
    let own = !read && published && joined && c.visibility === 'help'
    if (c.parentContactListId) {
        const parent = categoryAccess(c.parentContactListId, actor, seen)
        if (!parent || parent.category.siteId !== c.siteId) return null
        read = read && parent.canRead
        own = own && parent.canRead
        moderate = moderate && parent.canRead
    }
    const list = one('mantle.marketing.contact.ContactList', { contactListId })
    const archived =
        list?.archivedDate && millis(list.archivedDate) <= millis(now())
    const post =
        participant &&
        !archived &&
        !sanctioned(c.siteId, actor, contactListId, 'silence') &&
        (read || own) &&
        (list?.postingEnumId === 'ClpAnyUser' ||
            (list?.postingEnumId === 'ClpModerators' ? moderate : !!lm))
    return {
        category: c,
        site: s,
        isOwner: owner,
        canDiscover: read,
        canRead: read,
        canReadOwn: own,
        canStartTopic: !!post,
        canReply: !!post,
        canEdit: !!post,
        canUpload: !!post,
        canFlag: participant && !!(read || own),
        canReact: !!post,
        canVote: !!post,
        canModerate: moderate,
        canInvite: owner || categoryStaff,
    }
}
function category(id, siteId) {
    const a = categoryAccess(id)
    if (
        !a ||
        a.category.siteId !== siteId ||
        !(a.canRead || a.canReadOwn || a.canModerate)
    )
        missing()
    return a
}
const capabilities = (a) =>
    pick(
        a,
        'canDiscover canRead canStartTopic canReply canEdit canUpload canFlag canReact canVote canModerate canInvite',
    )
/* The decorative part of a topic URL; the ID before it is what resolves. */
const slugify = (title) =>
    String(title || 'topic')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'topic'
function topic(root, siteId, lock = false) {
    const t = one(F + 'ForumTopic', { rootCommEventId: root }, lock)
    if (!t || t.siteId !== siteId || t.kind !== 'category') missing()
    const event = one(E + 'CommunicationEvent', { communicationEventId: root })
    if (!event) missing()
    const a = category(event.contactListId, siteId)
    // Help access follows authored participation, never a stale recipient row.
    if (
        !a.canRead &&
        !a.canModerate &&
        !find(E + 'CommunicationEvent', {
            rootCommEventId: root,
            fromPartyId: me(),
        }).count() &&
        event.fromPartyId !== me()
    )
        missing()
    const state = one(F + 'ForumPostState', { communicationEventId: root })
    if (
        state &&
        state.visibility !== 'approved' &&
        event.fromPartyId !== me() &&
        !a.canModerate
    )
        missing()
    return { t, event, a }
}
function postVisible(state, event, a) {
    return (
        state.visibility === 'approved' ||
        event.fromPartyId === me() ||
        a.canModerate
    )
}
const trustLevel = (siteId, partyId = me()) =>
    (partyId && one(F + 'ForumMemberState', { siteId, partyId })?.trustLevel) ||
    'new'
/* Authors edit for a day; a wiki post is open to basic-or-higher members who may write in the category. */
function canEditPost(state, event, a) {
    if (a.canModerate) return true
    if (!a.canEdit || state.visibility === 'deleted') return false
    if (
        event.fromPartyId === me() &&
        millis(now()) - millis(event.entryDate) <=
            editWindowMs(a.category.siteId)
    )
        return true
    return (
        state.wiki === 'Y' &&
        state.visibility === 'approved' &&
        trustLevel(a.category.siteId) !== 'new'
    )
}
const json = (text, fallback) => {
    try {
        return text ? JSON.parse(text) : fallback
    } catch (e) {
        return fallback
    }
}
function postProjection(state, event, a, t) {
    if (!postVisible(state, event, a)) return null
    const profile = one(S + 'PublicSiteProfile', {
        siteId: a.category.siteId,
        partyId: event.fromPartyId,
    })
    const deleted = state.visibility === 'deleted'
    return {
        postId: event.communicationEventId,
        rootCommEventId: state.rootCommEventId,
        ordinal: Number(state.ordinal),
        revision: Number(state.revision),
        author: pick(profile, 'handle displayName avatarId'),
        entryDate: event.entryDate,
        body: deleted ? '' : StringUtilities.cleanHtml(event.body || ''),
        visibility: state.visibility,
        parentCommEventId: event.parentCommEventId || null,
        wiki: state.wiki === 'Y',
        accepted: !!t && t.acceptedAnswerId === event.communicationEventId,
        hasHistory: Number(state.revision) > 1,
        reactions: deleted ? {} : json(state.reactionCounts, {}),
        myReactions:
            deleted || !me()
                ? []
                : rows(
                      F + 'ForumReaction',
                      {
                          communicationEventId: event.communicationEventId,
                          partyId: me(),
                      },
                      20,
                  ).map((v) => v.reactionKey),
        pollId: deleted
            ? null
            : one(F + 'ForumPoll', {
                  communicationEventId: event.communicationEventId,
              })?.pollId || null,
        capabilities: {
            ...capabilities(a),
            canEdit: canEditPost(state, event, a),
            canReact:
                a.canReact &&
                !deleted &&
                state.visibility === 'approved' &&
                event.fromPartyId !== me(),
            canDelete:
                !deleted &&
                state.rootCommEventId !== event.communicationEventId &&
                (a.canModerate ||
                    (event.fromPartyId === me() &&
                        millis(now()) - millis(event.entryDate) <=
                            editWindowMs(a.category.siteId))),
        },
        attachments: deleted
            ? []
            : rows(
                  F + 'ForumAttachment',
                  {
                      communicationEventId: event.communicationEventId,
                      scanState: 'clean',
                  },
                  100,
              ).map((v) =>
                  pick(v, 'attachmentId filename mimeType byteSize altText'),
              ),
    }
}
function page(p, scope) {
    const limit = p.limit == null ? 30 : Number(p.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        invalid('limit must be from 1 through 100')
    const actorKey = ec.user.userId || '_ANONYMOUS_',
        scopeHash = hash(scope)
    let offset = 0
    if (p.cursor) {
        if (
            typeof p.cursor !== 'string' ||
            !/^[A-Za-z0-9_-]{32}$/.test(p.cursor)
        )
            invalid('Invalid cursor')
        const cursor = one(F + 'ForumCursor', { cursorId: p.cursor })
        if (
            !cursor ||
            cursor.actorKey !== actorKey ||
            cursor.scopeHash !== scopeHash ||
            millis(cursor.expiresAt) <= millis(now())
        )
            invalid('Invalid cursor')
        offset = Number(cursor.position)
    }
    return {
        limit,
        offset,
        next: (position) => {
            const prior = Array.from(
                find(F + 'ForumCursor', { actorKey, scopeHash, position })
                    .orderBy('-expiresAt,cursorId')
                    .limit(1)
                    .list(),
            )[0]
            if (prior && millis(prior.expiresAt) > millis(now()))
                return prior.cursorId
            if (prior) prior.delete()
            const cursorId = id()
            create(F + 'ForumCursor', {
                cursorId,
                actorKey,
                scopeHash,
                position,
                expiresAt: millis(now()) + 15 * 60000,
            })
            return cursorId
        },
    }
}
/* The actor's own account row serializes that actor's retries and first inserts (receipts, reading markers)
   without making every other member on the site or topic wait. */
function lockActor() {
    if (ec.user.userId)
        ec.entity
            .find('moqui.security.UserAccount')
            .condition('userId', ec.user.userId)
            .forUpdate(true)
            .one()
}
function receipt(p, action, work) {
    const actorPartyId = requireUser()
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.operationId || ''))
        invalid(
            'operationId must contain 8–64 letters, numbers, underscores or hyphens',
        )
    lockActor()
    const key = {
            siteId: p.siteId,
            actorPartyId,
            operationId: p.operationId,
            action,
        },
        payload = { ...p }
    delete payload.operationId
    const payloadHash = hash(
        JSON.stringify(
            Object.fromEntries(
                Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
            ),
        ),
    )
    const old = one(F + 'ForumOperationReceipt', key)
    if (old) {
        if (old.payloadHash !== payloadHash)
            fail('Conflict', 'Operation ID was used with different input')
        return JSON.parse(old.resultJson)
    }
    const result = work()
    create(F + 'ForumOperationReceipt', {
        ...key,
        payloadHash,
        resultJson: JSON.stringify(
            Object.fromEntries(
                Object.entries(result).filter(
                    ([key]) => key !== 'token' && key !== 'credential',
                ),
            ),
        ),
    })
    return result
}
function ensureParty() {
    const ua = ec.user.userAccount
    if (!ua) fail('AuthenticationRequired', 'Sign in to join')
    if (ua.partyId) return ua.partyId
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    )
        fail('Unauthorized', 'Verify your email before joining')
    const account = one(
        'moqui.security.UserAccount',
        { userId: ua.userId },
        true,
    )
    if (account.partyId) return account.partyId
    const person = ec.service
        .sync()
        .throwOnError(true)
        .name('mantle.party.PartyServices.create#Person')
        .parameters({ firstName: 'Community member' })
        .call()
    if (!person.partyId)
        fail('Unavailable', 'Account membership is not available')
    update(account, { partyId: person.partyId })
    return person.partyId
}
function readingBoundary(root, siteId, contactListId) {
    const partyId = me()
    if (!partyId) return null
    const marker = one(F + 'ForumTopicUser', { rootCommEventId: root, partyId })
    if (marker)
        return pick(
            marker,
            'consumedOrdinal highestSeenOrdinal markerRevision unreadBoundary',
        )
    const joined =
        listMember(contactListId, partyId)?.fromDate ||
        member(siteId, partyId)?.joinedAt
    const boundary = joined
        ? Array.from(
              find(F + 'ForumPostSearch', {
                  rootCommEventId: root,
                  visibility: 'approved',
              })
                  .condition('entryDate', 'less-equals', joined)
                  .orderBy('-ordinal')
                  .limit(1)
                  .list(),
          )[0]
        : null
    return {
        consumedOrdinal: Number(boundary?.ordinal || 0),
        highestSeenOrdinal: 0,
        markerRevision: 0,
        unreadBoundary: null,
    }
}

const methods = {}
methods.findSites = (p) => {
    if (p.siteId) site(p.siteId, true)
    const pg = page(p, 'sites:' + (p.siteId || 'operator')),
        list = []
    let offset = pg.offset,
        more = false
    for (let batch = 0; batch < 10 && list.length <= pg.limit; batch++) {
        const rows = Array.from(
            find(S + 'PublicSite', p.siteId ? { siteId: p.siteId } : {})
                .orderBy('siteId')
                .offset(offset)
                .limit(100)
                .list(),
        )
        for (const s of rows) {
            offset++
            const m = member(s.siteId)
            if (
                !isOperator() &&
                !(active(m) && m.state === 'active' && m.role === 'owner')
            )
                continue
            if (list.length === pg.limit) {
                more = true
                offset--
                break
            }
            list.push(
                pick(
                    s,
                    'siteId name state locale timeZone policyRevision generation',
                ),
            )
        }
        if (more || rows.length < 100) break
        if (batch === 9) more = true
    }
    return { siteList: list, nextCursor: more ? pg.next(offset) : null }
}
methods.createSite = (p) => {
    if (!isOperator()) fail('Unauthorized', 'Operator access required')
    if (
        !p.name ||
        !p.ownerPartyId ||
        !one('mantle.party.Party', { partyId: p.ownerPartyId })
    )
        invalid('Name and an existing owner party are required')
    const siteId = id()
    create(S + 'PublicSite', {
        siteId,
        name: p.name,
        state: 'disabled',
        locale: p.locale || 'en',
        timeZone: p.timeZone || 'UTC',
        registrationMode: 'closed',
        approvalRequired: 'N',
        policyRevision: 1,
        generation: 1,
    })
    create(S + 'PublicSiteParty', {
        siteId,
        partyId: p.ownerPartyId,
        state: 'active',
        role: 'owner',
        joinedAt: now(),
        revision: 1,
    })
    return { siteId, state: 'disabled', revision: 1 }
}
methods.updateSite = (p) => {
    const s = site(p.siteId, true)
    revision(s, p.expectedRevision)
    if (p.state && !['disabled', 'published'].includes(p.state))
        invalid('Invalid publication state')
    update(s, {
        ...Object.fromEntries(
            ['name', 'locale', 'timeZone']
                .filter((k) => p[k] != null)
                .map((k) => [k, p[k]]),
        ),
        ...(p.state ? { state: p.state } : {}),
        policyRevision: Number(s.policyRevision) + 1,
        generation: Number(s.generation) + 1,
    })
    return pick(s, 'siteId name state policyRevision generation')
}
methods.getMembership = (p) => {
    site(p.siteId)
    if (!ec.user.userId) fail('AuthenticationRequired', 'Sign in to continue')
    return {
        membership: pick(
            member(p.siteId),
            'state role joinedAt fromDate thruDate revision',
        ),
    }
}
methods.joinSite = (p) => {
    const s = site(p.siteId)
    ensureParty()
    const partyId = requireUser()
    if (s.registrationMode !== 'open')
        fail('Unauthorized', 'An invitation is required')
    const ua = ec.user.userAccount
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    )
        fail('Unauthorized', 'Verify your email before joining')
    const old = member(p.siteId)
    if (old && old.state === 'active')
        return { state: old.state, revision: Number(old.revision) }
    // Staff suspensions and removals stand until staff change them.
    if (
        old &&
        (old.state === 'suspended' ||
            (old.state === 'ended' &&
                old.stateSetByPartyId &&
                old.stateSetByPartyId !== partyId))
    )
        fail('Unauthorized', 'Joining is not permitted')
    const fields = {
        siteId: p.siteId,
        partyId,
        state: s.approvalRequired === 'Y' ? 'pending' : 'active',
        role: 'member',
        joinedAt: now(),
        stateSetByPartyId: partyId,
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, fields) : create(S + 'PublicSiteParty', fields)
    if (fields.state === 'pending')
        review(p.siteId, null, 'account', partyId, fields.revision, 'account')
    return { state: fields.state, revision: fields.revision }
}
methods.leaveSite = (p) => {
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    site(p.siteId)
    const m = member(p.siteId, requireUser())
    if (!m) missing()
    if (m.role === 'owner') protectOwner(p.siteId, m.partyId)
    revision(m, p.expectedRevision)
    update(m, {
        state: 'ended',
        thruDate: now(),
        stateSetByPartyId: m.partyId,
        revision: Number(m.revision) + 1,
    })
    bump(p.siteId)
    return { state: 'ended' }
}
function protectOwner(siteId, partyId) {
    const replacements = rows(
        S + 'PublicSiteParty',
        { siteId, role: 'owner', state: 'active' },
        1000,
    ).some(
        (owner) =>
            owner.partyId !== partyId &&
            active(owner) &&
            !sanctioned(siteId, owner.partyId, null, 'suspend'),
    )
    if (!replacements) invalid('Assign another active owner first')
}
function protectListOwner(contactListId, partyId) {
    const binding = one(F + 'ForumCategory', { contactListId })
    if (!binding) return // Preserve unbound legacy mailbox ownership rules.
    one(S + 'PublicSite', { siteId: binding.siteId }, true)
    const current = listMember(contactListId, partyId)
    if (current?.roleTypeId !== 'ListOwner') return
    const replacements = rows(
        'mantle.marketing.contact.ContactListParty',
        { contactListId, statusId: 'CLPT_ACCEPTED', roleTypeId: 'ListOwner' },
        1000,
    ).some(
        (owner) =>
            owner.partyId !== partyId &&
            active(owner) &&
            active(member(binding.siteId, owner.partyId)) &&
            member(binding.siteId, owner.partyId).state === 'active' &&
            !sanctioned(
                binding.siteId,
                owner.partyId,
                contactListId,
                'suspend',
            ),
    )
    if (!replacements) invalid('Assign another active category owner first')
}
methods.setMembership = (p) => {
    site(p.siteId, true)
    const m = member(p.siteId, p.targetPartyId)
    if (!m) missing()
    revision(m, p.expectedRevision)
    if (!p.reason?.trim()) invalid('A membership decision reason is required')
    if (!['active', 'pending', 'suspended', 'ended'].includes(p.state))
        invalid('Invalid member state')
    if (m.role === 'owner' && p.state !== 'active')
        protectOwner(p.siteId, m.partyId)
    audit(
        p.siteId,
        null,
        'member',
        m.partyId,
        'membership',
        p.reason,
        m.revision,
        Number(m.revision) + 1,
    )
    update(m, {
        state: p.state,
        stateSetByPartyId: me(),
        revision: Number(m.revision) + 1,
    })
    bump(p.siteId)
    return { revision: Number(m.revision) }
}
methods.setSiteRole = (p) => {
    site(p.siteId, true)
    const auth = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.UserServices.login#UserAccount')
        .parameters({
            username: ec.user.userAccount.username,
            password: p.password,
            code: p.code,
        })
        .call()
    if (!auth.loggedIn)
        fail(
            'AuthenticationRequired',
            'Reauthenticate before changing site roles',
        )
    if (!['member', 'moderator', 'owner'].includes(p.role))
        invalid('Invalid role')
    const m = member(p.siteId, p.targetPartyId)
    if (!m) missing()
    revision(m, p.expectedRevision)
    if (!p.reason?.trim()) invalid('A membership decision reason is required')
    if (m.role === 'owner' && p.role !== 'owner')
        protectOwner(p.siteId, m.partyId)
    audit(
        p.siteId,
        null,
        'member',
        m.partyId,
        'role',
        p.reason,
        m.revision,
        Number(m.revision) + 1,
    )
    update(m, { role: p.role, revision: Number(m.revision) + 1 })
    bump(p.siteId)
    return { revision: Number(m.revision) }
}
methods.findMembers = (p) => {
    site(p.siteId, true)
    const pg = page(p, 'members:' + p.siteId)
    const list = Array.from(
        find(S + 'PublicSiteParty', { siteId: p.siteId })
            .orderBy('partyId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        memberList: list.slice(0, pg.limit).map((m) => ({
            ...pick(m, 'partyId state role revision'),
            profile: pick(
                one(S + 'PublicSiteProfile', {
                    siteId: p.siteId,
                    partyId: m.partyId,
                }),
                'handle displayName',
            ),
        })),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.storeProfile = (p) => {
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    site(p.siteId)
    const partyId = requireUser()
    const membership = member(p.siteId, partyId)
    if (!membership || !['active', 'pending'].includes(membership.state))
        fail('Unauthorized', 'Join this site before setting a profile')
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(p.handle || ''))
        invalid(
            'Handle must be 3–32 lowercase letters, numbers, underscores or hyphens',
        )
    if (
        !['public', 'members', 'hidden'].includes(
            p.discoverability || 'members',
        )
    )
        invalid('Invalid profile discovery')
    const old = one(
        S + 'PublicSiteProfile',
        { siteId: p.siteId, partyId },
        true,
    )
    revision({ revision: Number(old?.revision || 0) }, p.expectedRevision)
    const dup = one(S + 'PublicSiteProfile', {
        siteId: p.siteId,
        handle: p.handle,
    })
    if (dup && dup.partyId !== partyId)
        fail('Conflict', 'Handle is unavailable')
    const avatarId =
        p.avatarId === undefined ? old?.avatarId || null : p.avatarId || null
    if (avatarId && avatarId !== old?.avatarId) {
        const attachment = one(
            F + 'ForumAttachment',
            { attachmentId: avatarId },
            true,
        )
        if (
            !attachment ||
            attachment.siteId !== p.siteId ||
            attachment.ownerPartyId !== partyId ||
            attachment.purpose !== 'avatar' ||
            attachment.communicationEventId ||
            attachment.scanState !== 'clean' ||
            !String(attachment.mimeType).startsWith('image/') ||
            !attachment.expiresAt ||
            millis(attachment.expiresAt) <= millis(now())
        )
            invalid('Avatar is unavailable or has not passed scanning')
        update(attachment, { expiresAt: null, draftId: null })
    }
    if (old?.avatarId && old.avatarId !== avatarId) {
        const abandoned = one(
            F + 'ForumAttachment',
            { attachmentId: old.avatarId },
            true,
        )
        if (abandoned)
            update(abandoned, { expiresAt: millis(now()) + 7 * 86400000 })
    }
    const fields = {
        siteId: p.siteId,
        partyId,
        avatarId,
        handle: p.handle,
        displayName: String(p.displayName || p.handle).slice(0, 100),
        bio: StringUtilities.cleanHtml(p.bio || ''),
        discoverability: p.discoverability || 'members',
        locale: p.locale,
        timeZone: p.timeZone,
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, fields) : create(S + 'PublicSiteProfile', fields)
    return {
        profile: pick(
            fields,
            'handle displayName avatarId bio discoverability locale timeZone revision',
        ),
    }
}
methods.getProfile = (p) => {
    site(p.siteId)
    const v = one(S + 'PublicSiteProfile', {
        siteId: p.siteId,
        handle: p.handle,
    })
    if (
        !v ||
        (v.partyId !== me() && member(p.siteId, v.partyId)?.state !== 'active')
    )
        missing()
    if (
        v.partyId !== me() &&
        v.discoverability !== 'public' &&
        !(
            v.discoverability === 'members' &&
            member(p.siteId)?.state === 'active'
        )
    )
        missing()
    return {
        profile: {
            ...pick(
                v,
                'handle displayName avatarId bio locale timeZone revision',
            ),
            ...(v.partyId === me()
                ? { discoverability: v.discoverability }
                : {}),
        },
    }
}
methods.findCategories = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        const pg = page(p, 'categories:' + p.siteId)
        const list = []
        let offset = pg.offset,
            more = false
        for (let batch = 0; batch < 10 && list.length <= pg.limit; batch++) {
            const candidates = Array.from(
                find(F + 'ForumCategory', { siteId: p.siteId })
                    .orderBy('sequenceNum,contactListId')
                    .offset(offset)
                    .limit(100)
                    .list(),
            )
            if (!candidates.length) break
            for (const c of candidates) {
                const a = categoryAccess(c.contactListId)
                offset++
                if (a?.canDiscover || a?.canReadOwn || a?.canModerate) {
                    if (list.length === pg.limit) {
                        more = true
                        offset--
                        break
                    }
                    list.push(categoryProjection(a))
                }
            }
            if (more || candidates.length < 100) break
        }
        return { categoryList: list, nextCursor: more ? pg.next(offset) : null }
    })
function categoryProjection(a) {
    const l = one('mantle.marketing.contact.ContactList', {
        contactListId: a.category.contactListId,
    })
    return {
        ...pick(
            a.category,
            'contactListId parentContactListId sequenceNum slug rules visibility publicationState policyRevision mode',
        ),
        name: l?.contactListName || '',
        description: l?.description || '',
        capabilities: capabilities(a),
    }
}
methods.getCategory = (p) => ({
    category: categoryProjection(category(p.contactListId, p.siteId)),
})
methods.storeCategory = (p) =>
    p.contactListId
        ? storeCategory(p)
        : receipt(p, 'storeCategory', () => storeCategory(p))
function storeCategory(p) {
    site(p.siteId, true)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    let c = p.contactListId
        ? one(F + 'ForumCategory', { contactListId: p.contactListId })
        : null
    if (c && c.siteId !== p.siteId) missing()
    if (c) revision(c, p.expectedRevision)
    if (p.mode !== undefined && !['discussion', 'qa'].includes(p.mode))
        invalid('Category mode must be discussion or qa')
    if (
        c?.publicationState === 'published' &&
        p.parentContactListId !== undefined &&
        (c.parentContactListId || null) !== (p.parentContactListId || null) &&
        p.confirmAudience !== true
    )
        invalid('Confirm the parent audience preview')
    if (p.parentContactListId) {
        let parent = category(p.parentContactListId, p.siteId),
            seen = new Set([p.contactListId])
        while (parent) {
            if (seen.has(parent.category.contactListId))
                invalid('Category hierarchy cannot contain cycles')
            seen.add(parent.category.contactListId)
            parent = parent.category.parentContactListId
                ? category(parent.category.parentContactListId, p.siteId)
                : null
        }
    }
    let contactListId = p.contactListId
    if (!c) {
        const out = ec.service
            .sync()
            .throwOnError(true)
            .name('mantle.marketing.ContactListServices.create#ContactList')
            .parameters({
                contactListTypeEnumId: 'MAILBOX',
                contactListName: p.name,
                isPublic: 'N',
                postingEnumId: 'ClpMembers',
            })
            .call()
        contactListId = out.contactListId
        if (!contactListId || ec.message.hasError())
            fail('Unprocessable', 'Category could not be created')
        c = create(F + 'ForumCategory', {
            contactListId,
            siteId: p.siteId,
            publicationState: 'disabled',
            visibility: 'members',
            mode: 'discussion',
            policyRevision: 0,
        })
    }
    const l = one('mantle.marketing.contact.ContactList', { contactListId })
    if (p.name) update(l, { contactListName: p.name })
    // An omitted field keeps its value, so a rename cannot drop the parent (and its access ceiling).
    const given = (k) => p[k] !== undefined
    update(c, {
        parentContactListId: given('parentContactListId')
            ? p.parentContactListId || null
            : (c.parentContactListId ?? null),
        slug: given('slug') ? p.slug || contactListId : c.slug || contactListId,
        sequenceNum: given('sequenceNum')
            ? Number(p.sequenceNum || 0)
            : Number(c.sequenceNum || 0),
        rules: given('rules')
            ? StringUtilities.cleanHtml(p.rules || '')
            : (c.rules ?? ''),
        mode: given('mode') ? p.mode : c.mode || 'discussion',
        policyRevision: Number(c.policyRevision) + 1,
    })
    bump(p.siteId)
    return { contactListId, revision: Number(c.policyRevision) }
}
methods.previewCategoryAccess = (p) => {
    site(p.siteId, true)
    const a = category(p.contactListId, p.siteId)
    return {
        category: categoryProjection(a),
        proposedVisibility: p.visibility,
        topicCount: find(E + 'CommunicationEvent', {
            contactListId: p.contactListId,
        })
            .condition('rootCommEventId', null)
            .count(),
        expectedRevision: Number(a.category.policyRevision),
    }
}
methods.setCategoryAccess = (p) => {
    site(p.siteId, true)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const c = one(F + 'ForumCategory', { contactListId: p.contactListId }, true)
    if (!c || c.siteId !== p.siteId) missing()
    revision(c, p.expectedRevision)
    if (
        p.publicationState === 'published' &&
        find(F + 'ForumJobRun', { siteId: p.siteId, jobType: 'bootstrap' })
            .condition('state', 'not-equals', 'complete')
            .count() > 0
    )
        fail(
            'Conflict',
            'Reconcile mailbox tracking conversion before publication',
        )
    if (
        !['public', 'members', 'category', 'help'].includes(p.visibility) ||
        !['disabled', 'published'].includes(p.publicationState)
    )
        invalid('Invalid category access')
    if (p.confirm !== true) invalid('Confirm the audience preview')
    update(c, {
        visibility: p.visibility,
        publicationState: p.publicationState,
        policyRevision: Number(c.policyRevision) + 1,
    })
    bump(p.siteId)
    return { revision: Number(c.policyRevision) }
}
methods.findTopics = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        if (p.contactListId) category(p.contactListId, p.siteId)
        if (p.view && !['latest', 'new', 'unread', 'top'].includes(p.view))
            invalid('Invalid topic view')
        if (p.period && !TOP_PERIODS[p.period]) invalid('Invalid period')
        if (p.solved && !['Y', 'N'].includes(p.solved))
            invalid('Invalid solved filter')
        const tag = p.tag ? resolveTag(p.siteId, p.tag) : null
        // A member's activity: only when their profile is visible to this reader (getProfile conceals otherwise).
        const authorPartyId = p.authorHandle
            ? (methods.getProfile({ siteId: p.siteId, handle: p.authorHandle }),
              one(S + 'PublicSiteProfile', {
                  siteId: p.siteId,
                  handle: p.authorHandle,
              }).partyId)
            : null
        if (['new', 'unread'].includes(p.view)) requireUser()
        const pg = page(
                p,
                'topics:' +
                    p.siteId +
                    ':' +
                    (p.contactListId || '') +
                    ':' +
                    (p.query || '') +
                    ':' +
                    (p.view || 'latest') +
                    ':' +
                    (p.authorHandle || '') +
                    ':' +
                    (tag?.tagId || '') +
                    ':' +
                    (p.solved || '') +
                    ':' +
                    (p.period || ''),
            ),
            list = []
        let offset = pg.offset,
            more = false
        // Work is capped even when most candidates are concealed. Cursor advances over the inspected window.
        for (let batch = 0; batch < 10 && list.length <= pg.limit; batch++) {
            let q = find(tag ? F + 'ForumTaggedTopic' : F + 'ForumTopic', {
                siteId: p.siteId,
                kind: 'category',
                ...(p.contactListId ? { contactListId: p.contactListId } : {}),
                ...(tag ? { tagId: tag.tagId } : {}),
            })
            if (p.solved)
                q = q.condition(
                    'acceptedAnswerId',
                    p.solved === 'Y' ? 'not-equals' : 'equals',
                    null,
                )
            if (p.view === 'top' && p.period && p.period !== 'all')
                q = q.condition(
                    'lastActivity',
                    'greater-equals',
                    stamp(millis(now()) - TOP_PERIODS[p.period]),
                )
            const candidates = Array.from(
                q
                    .orderBy(
                        p.view === 'top'
                            ? '-reactionCount,-visiblePostCount,rootCommEventId'
                            : '-lastActivity,rootCommEventId',
                    )
                    .offset(offset)
                    .limit(100)
                    .list(),
            )
            if (!candidates.length) break
            for (const t of candidates) {
                offset++
                let out
                try {
                    out = topic(t.rootCommEventId, p.siteId)
                } catch (e) {
                    if (e.moquiErrorKind === 'NotFound') continue
                    throw e
                }
                const { event, a } = out
                if (
                    (p.contactListId &&
                        event.contactListId !== p.contactListId) ||
                    (authorPartyId && event.fromPartyId !== authorPartyId) ||
                    (t.unlisted === 'Y' && !a.canModerate) ||
                    (p.query &&
                        !String(event.subject || '')
                            .toLowerCase()
                            .includes(String(p.query).toLowerCase()))
                )
                    continue
                const marker = readingBoundary(
                    t.rootCommEventId,
                    p.siteId,
                    event.contactListId,
                )
                const unreadCount = marker
                    ? find(F + 'ForumPostSearch', {
                          rootCommEventId: t.rootCommEventId,
                          visibility: 'approved',
                      })
                          .condition(
                              'ordinal',
                              'greater',
                              Number(marker.consumedOrdinal || 0),
                          )
                          .condition('fromPartyId', 'not-equals', me())
                          .count()
                    : null
                if (
                    (p.view === 'unread' && !unreadCount) ||
                    (p.view === 'new' &&
                        (one(F + 'ForumTopicUser', {
                            rootCommEventId: t.rootCommEventId,
                            partyId: me(),
                        }) ||
                            millis(event.entryDate) <=
                                millis(member(p.siteId)?.joinedAt)))
                )
                    continue
                if (list.length === pg.limit) {
                    more = true
                    offset--
                    break
                }
                list.push({
                    unreadCount,
                    ...pick(
                        t,
                        'rootCommEventId revision pinned lastActivity visiblePostCount reactionCount',
                    ),
                    solved: !!visibleAnswer(t, a),
                    tags: topicTags(t.rootCommEventId),
                    title: event.subject,
                    category: categoryProjection(a),
                    capabilities: capabilities(a),
                })
            }
            if (more || candidates.length < 100) break
            if (batch === 9) more = true
        }
        return { topicList: list, nextCursor: more ? pg.next(offset) : null }
    })
methods.getTopic = (p) => {
    // A merged topic's old ID resolves to its destination after the destination's own access check.
    if (!one(F + 'ForumTopic', { rootCommEventId: p.rootCommEventId })) {
        const alias = one(F + 'ForumPermalink', {
            oldRootCommEventId: p.rootCommEventId,
        })
        if (alias && alias.siteId === p.siteId)
            return {
                topic: {
                    ...methods.getTopic({
                        siteId: p.siteId,
                        rootCommEventId: alias.targetRootCommEventId,
                    }).topic,
                    movedFrom: p.rootCommEventId,
                },
            }
    }
    const { t, event, a } = topic(p.rootCommEventId, p.siteId)
    return {
        topic: {
            ...pick(
                t,
                'rootCommEventId revision pinned unlisted slowIntervalSeconds visiblePostCount lastActivity',
            ),
            timers: a.canModerate
                ? rows(
                      F + 'ForumTopicTimer',
                      { rootCommEventId: t.rootCommEventId, state: 'pending' },
                      10,
                  ).map((v) => pick(v, 'timerId action dueAt reason'))
                : [],
            marker: readingBoundary(
                t.rootCommEventId,
                p.siteId,
                event.contactListId,
            ),
            title: event.subject,
            slug: slugify(event.subject),
            closed: event.statusId === 'CeResolved',
            acceptedAnswerId: visibleAnswer(t, a),
            tags: topicTags(t.rootCommEventId),
            category: categoryProjection(a),
            capabilities: {
                ...capabilities(a),
                canReply: a.canReply && event.statusId !== 'CeResolved',
                canAccept:
                    a.category.mode === 'qa' &&
                    (a.canModerate ||
                        (event.fromPartyId === me() && a.canReply)),
            },
        },
    }
}
methods.getPosts = (p) => {
    const { t, a } = topic(p.rootCommEventId, p.siteId)
    const scope =
            'posts:' +
            p.siteId +
            ':' +
            t.rootCommEventId +
            ':' +
            (p.around || '') +
            ':' +
            (p.before || '') +
            ':' +
            (p.after || ''),
        pg = page(p, scope)
    const visiblePosts = () => {
        const q = find(F + 'ForumPostSearch', {
            rootCommEventId: t.rootCommEventId,
        })
        if (a.canModerate) return q
        const cf = ec.entity.conditionFactory
        return q.condition(
            cf.makeCondition(
                [
                    cf.makeCondition('visibility', 'equals', 'approved'),
                    cf.makeCondition(
                        'fromPartyId',
                        'equals',
                        me() || '_ANONYMOUS_',
                    ),
                ],
                'or',
            ),
        )
    }
    let q = visiblePosts()
    if (p.around) {
        if (p.before != null || p.after != null)
            invalid('Use one post window locator')
        const target = one(F + 'ForumPostState', {
                communicationEventId: p.around,
                rootCommEventId: t.rootCommEventId,
            }),
            event = one(E + 'CommunicationEvent', {
                communicationEventId: p.around,
            })
        if (!target || !event || !postVisible(target, event, a)) missing()
        // Start a few visible posts before the target so it reads in context; stable ordinals make this one query.
        const earlier = Array.from(
            visiblePosts()
                .condition('ordinal', 'less', Number(target.ordinal))
                .orderBy('-ordinal')
                .limit(Math.min(5, Math.floor(pg.limit / 3)))
                .list(),
        )
        const start = earlier.length
            ? Number(earlier[earlier.length - 1].ordinal)
            : Number(target.ordinal)
        q = q.condition('ordinal', 'greater-equals', start)
    }
    for (const key of ['before', 'after'])
        if (p[key] != null) {
            if (!Number.isInteger(Number(p[key])) || Number(p[key]) < 1)
                invalid('Invalid ordinal')
            q = q.condition(
                'ordinal',
                key === 'after' ? 'greater' : 'less',
                Number(p[key]),
            )
        }
    if (pg.offset)
        q = q.condition(
            'ordinal',
            p.before != null ? 'less' : 'greater',
            pg.offset,
        )
    const list = [],
        candidates = Array.from(
            q
                .orderBy(p.before != null ? '-ordinal' : 'ordinal')
                .limit(pg.limit + 1)
                .list(),
        )
    const window = candidates.slice(0, pg.limit)
    if (p.before != null) window.reverse()
    for (const st of window) {
        const event = one(E + 'CommunicationEvent', {
            communicationEventId: st.communicationEventId,
        })
        if (event) {
            const out = postProjection(st, event, a, t)
            if (out) list.push(out)
        }
    }
    return {
        postList: list,
        nextCursor:
            candidates.length > pg.limit
                ? pg.next(Number(candidates[pg.limit - 1].ordinal))
                : null,
        revision: Number(t.revision),
        generation: Number(a.site.generation),
    }
}
methods.storeDraft = (p) => {
    site(p.siteId)
    const partyId = requireUser(),
        old = p.draftId ? one(F + 'ForumDraft', { draftId: p.draftId }) : null
    if (old && (old.siteId !== p.siteId || old.partyId !== partyId)) missing()
    if (p.draftId && !/^[A-Za-z0-9_-]{8,40}$/.test(p.draftId))
        invalid('Invalid draft ID')
    if (!old && Number(p.expectedRevision || 0) !== 0)
        fail('Conflict', 'Draft changed; reload and compare')
    if (p.poll && JSON.stringify(p.poll).length > 20000)
        invalid('The poll draft is too large')
    if (old) revision(old, p.expectedRevision)
    if (p.contactListId) category(p.contactListId, p.siteId)
    if (p.rootCommEventId) topic(p.rootCommEventId, p.siteId)
    const fields = {
        draftId: old?.draftId || p.draftId || id(),
        siteId: p.siteId,
        partyId,
        mode: p.mode || 'new',
        contactListId: p.contactListId,
        rootCommEventId: p.rootCommEventId,
        parentCommEventId: p.parentCommEventId,
        postId: p.postId || null,
        postRevision: p.postRevision || null,
        title: p.title || '',
        sourceText: p.body || '',
        sourceFormat: 'html',
        tagsJson: p.tags ? JSON.stringify(p.tags) : null,
        // A draft keeps an unfinished poll as typed; publishing validates it.
        pollJson: p.poll ? JSON.stringify(p.poll) : null,
        revision: Number(old?.revision || 0) + 1,
        updatedAt: now(),
    }
    old ? update(old, fields) : create(F + 'ForumDraft', fields)
    return { draftId: fields.draftId, revision: fields.revision }
}
methods.findDrafts = (p) => {
    site(p.siteId)
    const pg = page(p, 'drafts:' + p.siteId)
    const list = Array.from(
        find(F + 'ForumDraft', { siteId: p.siteId, partyId: requireUser() })
            .orderBy('-updatedAt,draftId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        draftList: list.slice(0, pg.limit).map((d) => ({
            ...pick(
                d,
                'draftId mode contactListId rootCommEventId parentCommEventId postId postRevision title revision updatedAt',
            ),
        })),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.discardDraft = (p) => {
    site(p.siteId)
    const d = one(F + 'ForumDraft', {
        draftId: p.draftId,
        siteId: p.siteId,
        partyId: requireUser(),
    })
    if (!d) missing()
    revision(d, p.expectedRevision)
    d.delete()
    return { discarded: true }
}
methods.previewPost = (p) => {
    site(p.siteId)
    requireUser()
    return { body: StringUtilities.cleanHtml(p.body || '') }
}
function review(
    siteId,
    contactListId,
    targetType,
    targetId,
    targetRevision,
    reasonFamily,
) {
    let r = find(F + 'ForumReviewItem', {
        siteId,
        targetType,
        targetId,
        reasonFamily,
    })
        .condition('state', 'in', ['pending', 'claimed'])
        .forUpdate(true)
        .one()
    if (r && Number(r.targetRevision) !== Number(targetRevision))
        update(r, {
            targetRevision,
            revision: Number(r.revision) + 1,
            state: 'pending',
            claimedByPartyId: null,
            claimExpiresAt: null,
        })
    if (!r)
        r = create(F + 'ForumReviewItem', {
            reviewId: id(),
            siteId,
            contactListId,
            targetType,
            targetId,
            targetRevision,
            reasonFamily,
            state: 'pending',
            revision: 1,
            createdAt: now(),
        })
    return r
}
function audit(
    siteId,
    contactListId,
    targetType,
    targetId,
    action,
    reason,
    before,
    after,
) {
    create(F + 'ForumModerationAction', {
        actionId: id(),
        siteId,
        contactListId,
        staffPartyId: requireUser(),
        targetType,
        targetId,
        action,
        reason: reason || '',
        beforeRevision: before,
        afterRevision: after,
        createdAt: now(),
    })
}
methods.publishPost = (p) => {
    requireUser()
    site(p.siteId)
    return receipt(p, 'publishPost', () => {
        if (
            find(F + 'ForumJobRun', { siteId: p.siteId, jobType: 'bootstrap' })
                .condition('state', 'not-equals', 'complete')
                .count() > 0
        )
            fail(
                'Conflict',
                'Mailbox conversion must reconcile before new posts',
            )
        const savedDraft = p.draftId
            ? one(F + 'ForumDraft', { draftId: p.draftId }, true)
            : null
        if (
            savedDraft &&
            (savedDraft.siteId !== p.siteId || savedDraft.partyId !== me())
        )
            missing()
        const existing = p.rootCommEventId
                ? topic(p.rootCommEventId, p.siteId, true)
                : null,
            a = existing?.a || category(p.contactListId, p.siteId)
        if (!(existing ? a.canReply : a.canStartTopic))
            fail('Unauthorized', 'Posting is not permitted')
        if (existing?.event.statusId === 'CeResolved')
            fail('Conflict', 'This topic is closed')
        const pol = policy(p.siteId)
        if (
            !String(p.body || '').trim() ||
            String(p.body).length > pol.maxPostLength
        )
            invalid('Body must contain 1–' + pol.maxPostLength + ' characters')
        if (!existing && (!p.title || String(p.title).length > 250))
            invalid('A title of at most 250 characters is required')
        if (p.parentCommEventId) {
            const parent = one(F + 'ForumPostState', {
                    communicationEventId: p.parentCommEventId,
                }),
                event = one(E + 'CommunicationEvent', {
                    communicationEventId: p.parentCommEventId,
                })
            if (
                !existing ||
                !parent ||
                parent.rootCommEventId !== existing.t.rootCommEventId ||
                !postVisible(parent, event, a)
            )
                missing()
        }
        const key = { siteId: p.siteId, partyId: me() }
        let memberState = one(F + 'ForumMemberState', key, true)
        if (!memberState)
            memberState = create(F + 'ForumMemberState', {
                ...key,
                trustLevel: 'new',
                approvedContributions: 0,
                dailyTopics: 0,
                dailyReplies: 0,
                revision: 1,
            })
        if (
            memberState.lastPostedAt &&
            millis(now()) - millis(memberState.lastPostedAt) <
                pol.postIntervalSeconds * 1000
        )
            fail(
                'Tarpit',
                'Wait ' + pol.postIntervalSeconds + ' seconds between posts',
            )
        // Slow mode spaces one member's replies in this topic; staff are not limited.
        const slow = Number(existing?.t.slowIntervalSeconds || 0)
        if (slow > 0 && !a.canModerate) {
            const last = Array.from(
                find(F + 'ForumPostSearch', {
                    rootCommEventId: existing.t.rootCommEventId,
                    fromPartyId: me(),
                })
                    .orderBy('-entryDate')
                    .limit(1)
                    .list(),
            )[0]
            if (last && millis(now()) - millis(last.entryDate) < slow * 1000)
                fail(
                    'Tarpit',
                    'This topic is in slow mode; wait ' +
                        slow +
                        ' seconds between replies',
                )
        }
        const day = String(now()).slice(0, 10),
            daily =
                memberState.dayKey === day
                    ? existing
                        ? Number(memberState.dailyReplies)
                        : Number(memberState.dailyTopics)
                    : 0
        const effects =
            TRUST_EFFECTS[memberState.trustLevel] || TRUST_EFFECTS.new
        if (
            !a.canModerate &&
            daily >= (existing ? effects.replies : effects.topics)
        )
            fail('Tarpit', 'Daily contribution limit reached')
        let body = StringUtilities.cleanHtml(p.body)
        const count = (pattern) => (body.match(pattern) || []).length
        if (
            !a.canModerate &&
            (count(/<a\b/gi) > effects.links ||
                count(/<img\b/gi) > effects.images ||
                mentionHandles(body).length > effects.mentions)
        )
            invalid(
                'Your trust level allows ' +
                    effects.links +
                    ' links, ' +
                    effects.images +
                    ' images and ' +
                    effects.mentions +
                    ' mentions per post',
            )
        const ruled = applyRules(p.siteId, a.category.contactListId, body)
        if (ruled.block && !a.canModerate)
            invalid('This post contains content the community does not allow')
        body = ruled.body
        const postId = id(),
            root = existing?.t.rootCommEventId || postId,
            ordinal = existing ? Number(existing.t.nextOrdinal) : 1
        const firstPost =
                Number(memberState.approvedContributions || 0) <
                    pol.firstContributionCount && !a.canModerate,
            pending = firstPost || (ruled.approve && !a.canModerate)
        create(E + 'CommunicationEvent', {
            communicationEventId: postId,
            communicationEventTypeId: 'Message',
            contactListId: a.category.contactListId,
            fromPartyId: me(),
            rootCommEventId: existing ? root : null,
            parentCommEventId: p.parentCommEventId || (existing ? root : null),
            subject: existing ? existing.event.subject : p.title,
            body,
            statusId: 'CeReceived',
            entryDate: now(),
        })
        if (existing)
            update(existing.t, {
                nextOrdinal: ordinal + 1,
                revision: Number(existing.t.revision) + 1,
                ...(!pending
                    ? {
                          lastActivity: now(),
                          visiblePostCount:
                              Number(existing.t.visiblePostCount) + 1,
                      }
                    : {}),
            })
        else
            create(F + 'ForumTopic', {
                rootCommEventId: root,
                siteId: p.siteId,
                contactListId: a.category.contactListId,
                kind: 'category',
                revision: 1,
                nextOrdinal: 2,
                visiblePostCount: pending ? 0 : 1,
                reactionCount: 0,
                lastActivity: now(),
                pinned: 'N',
                unlisted: 'N',
            })
        create(F + 'ForumPostState', {
            communicationEventId: postId,
            rootCommEventId: root,
            ordinal,
            revision: 1,
            visibility: pending ? 'pending' : 'approved',
            approvedRevision: pending ? null : 1,
            wiki: 'N',
            reactionCount: 0,
        })
        create(F + 'ForumPostRevision', {
            communicationEventId: postId,
            revision: 1,
            sourceFormat: 'html',
            sourceText: p.body,
            sanitizedBody: body,
            editorPartyId: me(),
            editedAt: now(),
            publicHistoryAllowed: 'Y',
        })

        attachToPost(p.siteId, postId, p.attachmentIds)
        if (!existing)
            setTopicTags(
                p.siteId,
                root,
                a,
                p.tags || json(savedDraft?.tagsJson, []),
            )
        const poll = p.poll || json(savedDraft?.pollJson, null)
        if (poll) createPoll(p.siteId, root, postId, poll)
        update(memberState, {
            lastPostedAt: now(),
            dayKey: day,
            dailyTopics: existing
                ? memberState.dayKey === day
                    ? memberState.dailyTopics
                    : 0
                : daily + 1,
            dailyReplies: existing
                ? daily + 1
                : memberState.dayKey === day
                  ? memberState.dailyReplies
                  : 0,
            revision: Number(memberState.revision) + 1,
        })
        if (pending)
            review(
                p.siteId,
                a.category.contactListId,
                'post',
                postId,
                1,
                firstPost ? 'first-post' : 'rule',
            )
        else {
            if (ruled.flag)
                review(
                    p.siteId,
                    a.category.contactListId,
                    'post',
                    postId,
                    1,
                    'rule',
                )
            allocateInternal(postId, a.category.contactListId, me())
            create(F + 'ForumOutbox', {
                outboxId: id(),
                siteId: p.siteId,
                communicationEventId: postId,
                eventType: 'post',
                state: 'pending',
                createdAt: now(),
            })
        }
        queueClassification(p.siteId, postId)
        if (savedDraft) savedDraft.delete()
        return {
            postId,
            rootCommEventId: root,
            ordinal,
            revision: 1,
            state: pending ? 'pending' : 'published',
        }
    })
}
/* A staged upload of the actor's, or one already on this post, that passed scanning and has not expired. */
function attachToPost(siteId, postId, attachmentIds) {
    for (const attachmentId of attachmentIds || []) {
        const att = one(F + 'ForumAttachment', { attachmentId }, true)
        const usable =
            att &&
            att.siteId === siteId &&
            ((att.ownerPartyId === me() && !att.communicationEventId) ||
                att.communicationEventId === postId) &&
            att.purpose !== 'avatar' &&
            att.scanState === 'clean' &&
            !(att.expiresAt && millis(att.expiresAt) <= millis(now()))
        if (!usable)
            invalid('Attachment is unavailable or has not passed scanning')
        update(att, {
            communicationEventId: postId,
            draftId: null,
            expiresAt: null,
        })
    }
}
function refreshReviews(siteId, postId, targetRevision) {
    for (const r of find(F + 'ForumReviewItem', {
        siteId,
        targetType: 'post',
        targetId: postId,
    })
        .condition('state', 'in', ['pending', 'claimed'])
        .forUpdate(true)
        .list())
        if (Number(r.targetRevision) !== Number(targetRevision))
            update(r, {
                targetRevision,
                revision: Number(r.revision) + 1,
                state: 'pending',
                claimedByPartyId: null,
                claimExpiresAt: null,
            })
}
methods.updatePost = (p) => {
    requireUser()
    site(p.siteId)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const st = one(
        F + 'ForumPostState',
        { communicationEventId: p.postId },
        true,
    )
    if (!st) missing()
    const { t, a } = topic(st.rootCommEventId, p.siteId, true),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    revision(st, p.expectedRevision)
    if (!canEditPost(st, event, a))
        fail('Unauthorized', 'Editing is not permitted')
    // A wiki editor changes the text; the author's attachments stay the author's.
    if (p.attachmentIds != null && !a.canModerate && event.fromPartyId !== me())
        invalid('Only the author changes attachments')
    if (a.canModerate && event.fromPartyId !== me() && !p.reason)
        invalid('Staff edits require a reason')
    const pol = policy(p.siteId)
    if (
        !String(p.body || '').trim() ||
        String(p.body).length > pol.maxPostLength
    )
        invalid('Body must contain 1–' + pol.maxPostLength + ' characters')
    const ruled = applyRules(
        p.siteId,
        a.category.contactListId,
        StringUtilities.cleanHtml(p.body),
    )
    if (ruled.block && !a.canModerate)
        invalid('This post contains content the community does not allow')
    const r = Number(st.revision) + 1,
        body = ruled.body
    create(F + 'ForumPostRevision', {
        communicationEventId: p.postId,
        revision: r,
        sourceFormat: 'html',
        sourceText: p.body,
        sanitizedBody: body,
        editorPartyId: me(),
        editedAt: now(),
        reason: p.reason,
        publicHistoryAllowed: 'Y',
    })
    update(event, { body, editedDate: now() })
    update(st, {
        revision: r,
        approvedRevision: st.visibility === 'approved' ? r : null,
    })
    update(t, { revision: Number(t.revision) + 1 })
    // An explicit attachment list is the desired set. Omission preserves legacy edits.
    if (p.attachmentIds != null)
        for (const existing of rows(
            F + 'ForumAttachment',
            { siteId: p.siteId, communicationEventId: p.postId },
            100,
        )) {
            if (!p.attachmentIds.includes(existing.attachmentId))
                update(existing, {
                    communicationEventId: null,
                    expiresAt: millis(now()) + 7 * 86400000,
                })
        }
    attachToPost(p.siteId, p.postId, p.attachmentIds)
    if (a.canModerate)
        audit(
            p.siteId,
            a.category.contactListId,
            'post',
            p.postId,
            'edit',
            p.reason,
            r - 1,
            r,
        )
    if (st.visibility === 'pending')
        review(
            p.siteId,
            a.category.contactListId,
            'post',
            p.postId,
            r,
            'first-post',
        )
    // Open reports now concern the edited text; decisions bind to that revision.
    refreshReviews(p.siteId, p.postId, r)
    if ((ruled.approve || ruled.flag) && !a.canModerate)
        review(p.siteId, a.category.contactListId, 'post', p.postId, r, 'rule')
    queueClassification(p.siteId, p.postId)
    bump(p.siteId)
    if (p.draftId) {
        const draft = one(F + 'ForumDraft', {
            draftId: p.draftId,
            siteId: p.siteId,
            partyId: me(),
        })
        if (draft) draft.delete()
    }
    return {
        postId: p.postId,
        rootCommEventId: st.rootCommEventId,
        revision: r,
    }
}
methods.markRead = (p) => {
    const { t, a } = topic(p.rootCommEventId, p.siteId),
        partyId = requireUser(),
        key = { rootCommEventId: t.rootCommEventId, partyId }
    lockActor()
    let marker = one(F + 'ForumTopicUser', key, true)
    if (marker)
        revision({ revision: marker.markerRevision }, p.expectedRevision)
    else if (Number(p.expectedRevision || 0) !== 0)
        fail('Conflict', 'Reading position changed')
    const ordinal = Number(p.ordinal)
    const st = one(F + 'ForumPostState', {
        rootCommEventId: t.rootCommEventId,
        ordinal,
    })
    if (
        !st ||
        !postVisible(
            st,
            one(E + 'CommunicationEvent', {
                communicationEventId: st.communicationEventId,
            }),
            a,
        )
    )
        missing()
    const initial = readingBoundary(
            t.rootCommEventId,
            p.siteId,
            a.category.contactListId,
        ),
        consumed = Number(
            marker?.consumedOrdinal ?? initial?.consumedOrdinal ?? 0,
        ),
        rendered = new Set(p.renderedPostIds || [])
    if (rendered.size > 100) invalid('Read window is too large')
    const between = Array.from(
        find(F + 'ForumPostSearch', {
            rootCommEventId: t.rootCommEventId,
            visibility: 'approved',
        })
            .condition('ordinal', 'greater', consumed)
            .condition('ordinal', 'less-equals', ordinal)
            .limit(101)
            .list(),
    )
    const continuous =
        between.length <= 100 &&
        between.every((post) => rendered.has(post.communicationEventId))
    const fields = {
        ...key,
        consumedOrdinal:
            p.markUnread === true
                ? Math.max(0, ordinal - 1)
                : p.jump === true || !continuous
                  ? consumed
                  : Math.max(consumed, ordinal),
        highestSeenOrdinal: Math.max(
            Number(marker?.highestSeenOrdinal || 0),
            ordinal,
        ),
        markerRevision: Number(marker?.markerRevision || 0) + 1,
        lastVisit: now(),
        unreadBoundary:
            p.markUnread === true
                ? ordinal
                : continuous &&
                    p.jump !== true &&
                    ordinal >= Number(marker?.unreadBoundary || 0)
                  ? null
                  : marker?.unreadBoundary,
    }
    marker ? update(marker, fields) : create(F + 'ForumTopicUser', fields)
    if (active(member(p.siteId, partyId)) && p.markUnread !== true)
        recordReading(
            p.siteId,
            partyId,
            Math.max(0, fields.consumedOrdinal - consumed),
            !marker,
        )
    if (internalParty(partyId) && p.markUnread !== true) {
        for (const postId of rendered) {
            const post = one(F + 'ForumPostState', {
                communicationEventId: postId,
                rootCommEventId: t.rootCommEventId,
            })
            if (
                !post ||
                !postVisible(
                    post,
                    one(E + 'CommunicationEvent', {
                        communicationEventId: postId,
                    }),
                    a,
                )
            )
                continue
            for (const receipt of rows(
                E + 'CommunicationEventParty',
                { communicationEventId: postId, partyId },
                10,
            ))
                if (!receipt.readDate) update(receipt, { readDate: now() })
        }
    }
    return {
        marker: pick(
            fields,
            'consumedOrdinal highestSeenOrdinal markerRevision unreadBoundary',
        ),
    }
}
methods.flagPost = (p) =>
    receipt(p, 'flagPost', () => {
        const st = one(F + 'ForumPostState', { communicationEventId: p.postId })
        if (!st) missing()
        const { a } = topic(st.rootCommEventId, p.siteId)
        if (!a.canFlag) fail('Unauthorized', 'Reporting is not permitted')
        const event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
        if (!postVisible(st, event, a)) missing()
        if (!p.reason) invalid('A reason is required')
        if (event.fromPartyId === me())
            invalid('Edit or delete your own post instead of reporting it')
        one(S + 'PublicSite', { siteId: p.siteId }, true)
        const r = review(
            p.siteId,
            a.category.contactListId,
            'post',
            p.postId,
            st.revision,
            'flag',
        )
        if (
            !one(F + 'ForumReviewReport', {
                reviewId: r.reviewId,
                reporterPartyId: requireUser(),
            })
        )
            create(F + 'ForumReviewReport', {
                reviewId: r.reviewId,
                reporterPartyId: me(),
                reason: p.reason,
                evidence: event.body,
                createdAt: now(),
            })
        const lockedState = one(
            F + 'ForumPostState',
            { communicationEventId: p.postId },
            true,
        )
        const hidden = hideIfFlagged(p.siteId, lockedState, event, r.reviewId)
        return { reviewId: r.reviewId, state: r.state, hidden }
    })
function staff(siteId, contactListId) {
    if (contactListId) {
        const a = category(contactListId, siteId)
        if (a.canModerate) return a
        fail('Unauthorized', 'Scoped moderator access required')
    }
    const m = member(siteId)
    if (
        !isOperator() &&
        !(
            active(m) &&
            m.state === 'active' &&
            !sanctioned(siteId, me(), null, 'suspend') &&
            ['owner', 'moderator'].includes(m.role)
        )
    )
        fail('Unauthorized', 'Scoped moderator access required')
    return null
}
methods.findReviews = (p) => {
    site(p.siteId)
    staff(p.siteId, p.contactListId)
    const pg = page(p, 'reviews:' + p.siteId + ':' + (p.contactListId || ''))
    const list = Array.from(
        find(F + 'ForumReviewItem', {
            siteId: p.siteId,
            ...(p.contactListId ? { contactListId: p.contactListId } : {}),
        })
            .condition('state', 'in', ['pending', 'claimed'])
            .orderBy('createdAt,reviewId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        reviewList: list
            .slice(0, pg.limit)
            .filter(
                (r) =>
                    !r.contactListId ||
                    categoryAccess(r.contactListId)?.canModerate,
            )
            .map((r) =>
                pick(
                    r,
                    'reviewId targetType targetId targetRevision reasonFamily state revision claimedByPartyId claimExpiresAt createdAt linkedReviewId',
                ),
            ),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.getReview = (p) => {
    const r = one(F + 'ForumReviewItem', {
        reviewId: p.reviewId,
        siteId: p.siteId,
    })
    if (!r) missing()
    staff(p.siteId, r.contactListId)
    return {
        review: pick(
            r,
            'reviewId targetType targetId targetRevision reasonFamily state revision claimedByPartyId claimExpiresAt createdAt decisionReason linkedReviewId detail',
        ),
        post:
            r.targetType === 'post'
                ? (() => {
                      const st = one(F + 'ForumPostState', {
                              communicationEventId: r.targetId,
                          }),
                          event = one(E + 'CommunicationEvent', {
                              communicationEventId: r.targetId,
                          })
                      return st && event
                          ? {
                                title: event.subject,
                                body: StringUtilities.cleanHtml(
                                    event.body || '',
                                ),
                                revision: st.revision,
                            }
                          : null
                  })()
                : null,
        notes: rows(F + 'ForumReviewNote', { reviewId: r.reviewId }, 30).map(
            (v) => pick(v, 'noteId staffPartyId noteText createdAt'),
        ),
        reports: rows(F + 'ForumReviewReport', { reviewId: r.reviewId }).map(
            (v) => pick(v, 'reporterPartyId reason evidence createdAt'),
        ),
    }
}
methods.addReviewNote = (p) =>
    receipt(p, 'addReviewNote', () => {
        const r = one(F + 'ForumReviewItem', {
            siteId: p.siteId,
            reviewId: p.reviewId,
        })
        if (!r) missing()
        staff(p.siteId, r.contactListId)
        if (!p.body || p.body.length > 10000)
            invalid('A note of at most 10000 characters is required')
        const noteId = id()
        create(F + 'ForumReviewNote', {
            noteId,
            reviewId: r.reviewId,
            staffPartyId: requireUser(),
            noteText: p.body,
            createdAt: now(),
        })
        audit(
            p.siteId,
            r.contactListId,
            'review',
            r.reviewId,
            'note',
            'Staff note recorded',
            r.revision,
            r.revision,
        )
        return { noteId }
    })
methods.claimReview = (p) => {
    requireUser()
    site(p.siteId)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const r = one(
        F + 'ForumReviewItem',
        { reviewId: p.reviewId, siteId: p.siteId },
        true,
    )
    if (!r) missing()
    staff(p.siteId, r.contactListId)
    revision(r, p.expectedRevision)
    if (!['pending', 'claimed'].includes(r.state))
        fail('Conflict', 'Review has ended')
    if (
        r.claimedByPartyId &&
        r.claimedByPartyId !== me() &&
        millis(r.claimExpiresAt) > millis(now())
    )
        fail('Conflict', 'Another moderator holds this review')
    update(r, {
        state: 'claimed',
        claimedByPartyId: requireUser(),
        claimExpiresAt: millis(now()) + 1800000,
        revision: Number(r.revision) + 1,
    })
    return { revision: Number(r.revision) }
}
methods.decideReview = (p) => {
    requireUser()
    site(p.siteId)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const r = one(
        F + 'ForumReviewItem',
        { reviewId: p.reviewId, siteId: p.siteId },
        true,
    )
    if (!r) missing()
    staff(p.siteId, r.contactListId)
    revision(r, p.expectedRevision)
    if (!['pending', 'claimed'].includes(r.state))
        fail('Conflict', 'Review has ended')
    if (
        !['approved', 'rejected', 'dismissed'].includes(p.decision) ||
        !p.reason
    )
        invalid('Decision and reason required')
    if (
        r.claimedByPartyId &&
        r.claimedByPartyId !== me() &&
        millis(r.claimExpiresAt) > millis(now())
    )
        fail('Conflict', 'Another moderator holds this review')
    if (r.targetType === 'post') {
        const st = one(
            F + 'ForumPostState',
            { communicationEventId: r.targetId },
            true,
        )
        if (!st || Number(st.revision) !== Number(r.targetRevision))
            fail('Conflict', 'Post changed; review current evidence')
        const event = one(E + 'CommunicationEvent', {
                communicationEventId: r.targetId,
            }),
            t = one(
                F + 'ForumTopic',
                { rootCommEventId: st.rootCommEventId },
                true,
            )
        if (st.visibility === 'hidden' && p.decision !== 'rejected') {
            // A post hidden by reports returns when staff dismiss the reports or approve the post.
            update(st, { visibility: 'approved' })
            if (st.communicationEventId !== t.rootCommEventId)
                update(t, {
                    visiblePostCount: Number(t.visiblePostCount) + 1,
                    revision: Number(t.revision) + 1,
                })
        } else if (p.decision === 'approved' && st.visibility !== 'approved') {
            update(st, {
                visibility: 'approved',
                approvedRevision: st.revision,
            })
            update(t, {
                visiblePostCount: Number(t.visiblePostCount) + 1,
                lastActivity: now(),
                revision: Number(t.revision) + 1,
            })
            const m = one(
                F + 'ForumMemberState',
                { siteId: p.siteId, partyId: event.fromPartyId },
                true,
            )
            if (m)
                update(m, {
                    approvedContributions: Number(m.approvedContributions) + 1,
                })
            allocateInternal(r.targetId, event.contactListId, event.fromPartyId)
            create(F + 'ForumOutbox', {
                outboxId: id(),
                siteId: p.siteId,
                communicationEventId: r.targetId,
                eventType: 'post',
                state: 'pending',
                createdAt: now(),
            })
        } else if (p.decision === 'rejected') {
            if (st.visibility === 'approved')
                update(t, {
                    visiblePostCount: Math.max(
                        0,
                        Number(t.visiblePostCount) - 1,
                    ),
                    revision: Number(t.revision) + 1,
                })
            update(st, { visibility: 'rejected' })
            clearAnswer(
                t,
                { category: { contactListId: r.contactListId } },
                r.targetId,
                p.reason,
            )
        }
    } else if (r.targetType === 'account') {
        const m = member(p.siteId, r.targetId)
        if (!m || Number(m.revision) !== Number(r.targetRevision))
            fail('Conflict', 'Membership changed')
        // Dismissing the review item is not a decision about the membership.
        if (p.decision !== 'dismissed')
            update(m, {
                state: p.decision === 'approved' ? 'active' : 'ended',
                stateSetByPartyId: me(),
                revision: Number(m.revision) + 1,
            })
    }
    audit(
        p.siteId,
        r.contactListId,
        r.targetType,
        r.targetId,
        p.decision,
        p.reason,
        r.revision,
        Number(r.revision) + 1,
    )
    update(r, {
        state: p.decision,
        decisionReason: p.reason,
        revision: Number(r.revision) + 1,
    })
    bump(p.siteId)
    return { state: r.state, revision: Number(r.revision) }
}
const TOPIC_ACTIONS = [
    'close',
    'reopen',
    'title',
    'category',
    'wiki',
    'pin',
    'unpin',
    'unlist',
    'list',
    'slow',
    'timer',
    'delete',
    'restore',
    'move-posts',
    'split',
    'merge',
]
methods.applyTopicAction = (p) => {
    requireUser()
    site(p.siteId)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const { t, event, a } = topic(p.rootCommEventId, p.siteId, true)
    if (!a.canModerate) fail('Unauthorized', 'Moderator access required')
    revision(t, p.expectedRevision)
    if (!p.reason) invalid('A reason is required')
    if (!TOPIC_ACTIONS.includes(p.action)) invalid('Unsupported topic action')
    if (['move-posts', 'split', 'merge'].includes(p.action)) {
        // Each root change is one transaction: a failure leaves both topics as they were.
        const before = Number(t.revision),
            out = restructure(p, t, event, a)
        audit(
            p.siteId,
            event.contactListId,
            'topic',
            t.rootCommEventId,
            p.action,
            p.reason + ' → ' + out.rootCommEventId,
            before,
            before + 1,
        )
        bump(p.siteId)
        return { revision: before + 1, ...out }
    }
    if (p.action === 'category') {
        const target = category(p.targetContactListId, p.siteId)
        if (!target.canModerate)
            fail('Unauthorized', 'Destination moderator access required')
        if (p.confirmAudience !== true)
            invalid('Review and confirm the destination audience')
        if (
            Number(p.expectedGeneration) !==
            audienceRevision(p.siteId, a, target)
        )
            fail('Conflict', 'Audience changed; preview the move again')
        const cf = ec.entity.conditionFactory
        let after = ''
        const sourceListId = event.contactListId
        for (;;) {
            let query = find(E + 'CommunicationEvent', {
                contactListId: sourceListId,
            }).condition(
                cf.makeCondition(
                    [
                        cf.makeCondition(
                            'communicationEventId',
                            'equals',
                            t.rootCommEventId,
                        ),
                        cf.makeCondition(
                            'rootCommEventId',
                            'equals',
                            t.rootCommEventId,
                        ),
                    ],
                    'or',
                ),
            )
            if (after)
                query = query.condition(
                    'communicationEventId',
                    'greater',
                    after,
                )
            const events = Array.from(
                query.orderBy('communicationEventId').limit(100).list(),
            )
            for (const item of events) {
                update(item, { contactListId: p.targetContactListId })
                find(F + 'ForumReviewItem', {
                    siteId: p.siteId,
                    targetType: 'post',
                    targetId: item.communicationEventId,
                }).updateAll({ contactListId: p.targetContactListId })
                for (const review of rows(
                    F + 'ForumReviewItem',
                    {
                        siteId: p.siteId,
                        targetType: 'post',
                        targetId: item.communicationEventId,
                    },
                    100,
                ))
                    if (['pending', 'claimed'].includes(review.state))
                        update(review, {
                            state: 'pending',
                            claimedByPartyId: null,
                            claimExpiresAt: null,
                            revision: Number(review.revision) + 1,
                        })
            }
            after = events[events.length - 1]?.communicationEventId || after
            if (events.length < 100) break
        }
    } else if (p.action === 'title') {
        if (!p.title) invalid('Title required')
        update(event, { subject: p.title })
    } else if (['pin', 'unpin', 'unlist', 'list'].includes(p.action)) {
        update(
            t,
            p.action === 'pin' || p.action === 'unpin'
                ? { pinned: p.action === 'pin' ? 'Y' : 'N' }
                : { unlisted: p.action === 'unlist' ? 'Y' : 'N' },
        )
    } else if (p.action === 'slow') {
        const seconds = Number(p.slowIntervalSeconds || 0)
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400)
            invalid('Slow mode is 0–86400 seconds')
        update(t, { slowIntervalSeconds: seconds })
    } else if (p.action === 'timer') {
        if (p.timerAction === 'cancel')
            find(F + 'ForumTopicTimer', {
                rootCommEventId: t.rootCommEventId,
                state: 'pending',
            }).updateAll({ state: 'cancelled', lastError: p.reason })
        else {
            if (!TIMER_ACTIONS.includes(p.timerAction))
                invalid('Invalid timer action')
            if (!(millis(p.dueAt) > millis(now())))
                invalid('A timer is due in the future')
            create(F + 'ForumTopicTimer', {
                timerId: id(),
                siteId: p.siteId,
                rootCommEventId: t.rootCommEventId,
                contactListId: event.contactListId,
                action: p.timerAction,
                dueAt: millis(p.dueAt),
                state: 'pending',
                reason: p.reason,
                createdByPartyId: me(),
                revision: 1,
            })
        }
    } else if (p.action === 'delete' || p.action === 'restore') {
        const postId = p.postId || t.rootCommEventId,
            st = one(
                F + 'ForumPostState',
                { communicationEventId: postId },
                true,
            )
        if (!st || st.rootCommEventId !== t.rootCommEventId) missing()
        const isRoot = postId === t.rootCommEventId
        if (p.action === 'delete') {
            if (st.visibility === 'deleted') fail('Conflict', 'Already deleted')
            // Deleting the root hides the whole topic from readers; replies keep their state for a restore.
            if (isRoot)
                update(st, {
                    visibility: 'deleted',
                    deletedAt: now(),
                    deletedByPartyId: me(),
                    deleteReason: p.reason,
                })
            else
                softDelete(
                    st,
                    one(E + 'CommunicationEvent', {
                        communicationEventId: postId,
                    }),
                    t,
                    a,
                    p.reason,
                )
        } else {
            if (!['deleted', 'hidden', 'rejected'].includes(st.visibility))
                fail('Conflict', 'Post is not removed')
            update(st, {
                visibility: 'approved',
                approvedRevision: st.revision,
                deletedAt: null,
                deletedByPartyId: null,
                deleteReason: null,
            })
            if (!isRoot) recount(t)
        }
    } else if (p.action === 'wiki') {
        // Wiki mode opens one post to versioned edits by eligible members; every edit stays in its history.
        const st = one(
            F + 'ForumPostState',
            { communicationEventId: p.postId },
            true,
        )
        if (!st || st.rootCommEventId !== t.rootCommEventId) missing()
        if (typeof p.active !== 'boolean')
            invalid('active must be true or false')
        update(st, { wiki: p.active ? 'Y' : 'N' })
    } else
        update(event, {
            statusId: p.action === 'close' ? 'CeResolved' : 'CeReceived',
        })
    audit(
        p.siteId,
        p.action === 'category' ? p.targetContactListId : event.contactListId,
        'topic',
        t.rootCommEventId,
        p.action,
        p.action === 'category'
            ? 'Moved from ' +
                  event.contactListId +
                  ' to ' +
                  p.targetContactListId +
                  ': ' +
                  p.reason
            : p.reason,
        t.revision,
        Number(t.revision) + 1,
    )
    update(t, {
        revision: Number(t.revision) + 1,
        ...(p.action === 'category'
            ? { contactListId: p.targetContactListId }
            : {}),
    })
    bump(p.siteId)
    return { revision: Number(t.revision) }
}
methods.findActions = (p) => {
    staff(p.siteId, p.contactListId)
    const pg = page(p, 'actions:' + p.siteId)
    const candidates = Array.from(
        find(F + 'ForumModerationAction', {
            siteId: p.siteId,
            ...(p.contactListId ? { contactListId: p.contactListId } : {}),
        })
            .orderBy('-createdAt,actionId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        nextCursor:
            candidates.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        actionList: candidates
            .slice(0, pg.limit)
            .filter((v) => {
                if (!['post', 'topic', 'review'].includes(v.targetType))
                    return true
                try {
                    const review =
                        v.targetType === 'review'
                            ? one(F + 'ForumReviewItem', {
                                  reviewId: v.targetId,
                              })
                            : null
                    const state =
                        v.targetType === 'post'
                            ? one(F + 'ForumPostState', {
                                  communicationEventId: v.targetId,
                              })
                            : review?.targetType === 'post'
                              ? one(F + 'ForumPostState', {
                                    communicationEventId: review.targetId,
                                })
                              : null
                    const root =
                        state?.rootCommEventId ||
                        (v.targetType === 'topic' ? v.targetId : null)
                    return !root || topic(root, p.siteId).a.canModerate
                } catch (error) {
                    if (error.moquiErrorKind === 'NotFound') return false
                    throw error
                }
            })
            .map((v) =>
                pick(
                    v,
                    'actionId contactListId staffPartyId targetType targetId action reason beforeRevision afterRevision createdAt',
                ),
            ),
    }
}
/* Staff act only on lower-ranked parties: operator > site owner > site moderator > list owner > list moderator > member. */
function rank(siteId, contactListId, partyId, actor) {
    if (actor && isOperator()) return 5
    const m = member(siteId, partyId)
    const siteRole =
        active(m) && m.state === 'active'
            ? { owner: 4, moderator: 3 }[m.role] || 0
            : 0
    const lm = contactListId ? listMember(contactListId, partyId) : null
    const listRole = { ListOwner: 2, ListModerator: 1 }[lm?.roleTypeId] || 0
    return Math.max(siteRole, listRole)
}
function requireHigherRank(siteId, contactListId, targetPartyId) {
    const self = me()
    if (targetPartyId === self) invalid('Staff cannot sanction themselves')
    if (
        rank(siteId, contactListId, self, true) <=
        rank(siteId, contactListId, targetPartyId, false)
    )
        fail(
            'Unauthorized',
            'Only higher-ranked staff can sanction this member',
        )
}
methods.setSanction = (p) =>
    receipt(p, 'setSanction', () => {
        staff(p.siteId, p.contactListId)
        const target = member(p.siteId, p.targetPartyId)
        if (!target) missing()
        requireHigherRank(p.siteId, p.contactListId, p.targetPartyId)
        if (p.thruDate && millis(p.thruDate) <= millis(now()))
            invalid('Sanction expiry must be in the future')
        if (target.role === 'owner' && p.kind === 'suspend' && !p.contactListId)
            protectOwner(p.siteId, p.targetPartyId)
        if (!['silence', 'suspend'].includes(p.kind) || !p.reason)
            invalid('Sanction kind and reason required')
        const sanctionId = id()
        create(F + 'ForumSanction', {
            sanctionId,
            revision: 1,
            siteId: p.siteId,
            contactListId: p.contactListId,
            partyId: p.targetPartyId,
            kind: p.kind,
            fromDate: now(),
            thruDate: p.thruDate,
            reason: p.reason,
            staffPartyId: me(),
        })
        audit(
            p.siteId,
            p.contactListId,
            'member',
            p.targetPartyId,
            p.kind,
            p.reason,
            null,
            null,
        )
        bump(p.siteId)
        return { sanctionId }
    })
methods.endSanction = (p) => {
    site(p.siteId)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const sanction = one(
        F + 'ForumSanction',
        { siteId: p.siteId, sanctionId: p.sanctionId },
        true,
    )
    if (!sanction) missing()
    staff(p.siteId, sanction.contactListId)
    revision({ revision: Number(sanction.revision || 1) }, p.expectedRevision)
    if (!p.reason) invalid('A reason is required')
    const next = Number(sanction.revision || 1) + 1
    update(sanction, { thruDate: now(), revision: next })
    audit(
        p.siteId,
        sanction.contactListId,
        'member',
        sanction.partyId,
        'end-sanction',
        p.reason,
        next - 1,
        next,
    )
    bump(p.siteId)
    return { revision: next }
}
methods.getMember = (p) => {
    staff(p.siteId, p.contactListId)
    return {
        membership: pick(
            member(p.siteId, p.targetPartyId),
            'state role joinedAt revision',
        ),
        memberState: pick(
            one(F + 'ForumMemberState', {
                siteId: p.siteId,
                partyId: p.targetPartyId,
            }),
            'trustLevel trustLocked trustReason approvedContributions lastPostedAt topicsEntered postsRead readingSeconds visitDays revision',
        ),
        sanctionList: rows(F + 'ForumSanction', {
            siteId: p.siteId,
            partyId: p.targetPartyId,
            ...(p.contactListId ? { contactListId: p.contactListId } : {}),
        }).map((s) =>
            pick(
                s,
                'sanctionId revision contactListId kind fromDate thruDate reason',
            ),
        ),
    }
}
methods.getHealth = (p) => {
    site(p.siteId, true)
    const runs = methods.findRuns(p)
    return {
        backend: 'local',
        search: 'database',
        runList: runs.runList,
        nextCursor: runs.nextCursor,
        outboxLagSeconds: (() => {
            const first = Array.from(
                find(F + 'ForumOutbox', { siteId: p.siteId, state: 'pending' })
                    .orderBy('createdAt')
                    .limit(1)
                    .list(),
            )[0]
            return first
                ? Math.max(
                      0,
                      Math.floor(
                          (millis(now()) - millis(first.createdAt)) / 1000,
                      ),
                  )
                : 0
        })(),
        pendingOutbox: find(F + 'ForumOutbox', {
            siteId: p.siteId,
            state: 'pending',
        }).count(),
        failedDeliveries: find(F + 'ForumDelivery', {
            siteId: p.siteId,
            state: 'failed',
        }).count(),
        uncertainDeliveries: find(F + 'ForumDelivery', { siteId: p.siteId })
            .condition('state', 'in', ['uncertain', 'sending'])
            .count(),
        conversionFailures: find(F + 'ForumJobRun', {
            siteId: p.siteId,
            state: 'failed',
        }).count(),
        scanFailures: find(F + 'ForumAttachment', {
            siteId: p.siteId,
            scanState: 'quarantined',
        }).count(),
        scanBacklog: find(F + 'ForumAttachment', {
            siteId: p.siteId,
            scanState: 'pending',
        }).count(),
        generation: Number(site(p.siteId).generation),
    }
}
methods.findDeliveries = (p) => {
    site(p.siteId, true)
    const pg = page(p, 'deliveries:' + p.siteId),
        list = Array.from(
            find(F + 'ForumDelivery', { siteId: p.siteId })
                .orderBy('-dueAt,deliveryId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
    return {
        deliveryList: list
            .slice(0, pg.limit)
            .map((v) =>
                pick(
                    v,
                    'deliveryId outboxId channel state attempts revision dueAt lastError',
                ),
            ),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.getPreferences = (p) => {
    site(p.siteId)
    const key = {
        siteId: p.siteId,
        partyId: requireUser(),
        scopeType: p.scopeType || 'site',
        scopeId: p.scopeId || '_SITE_',
    }
    const preference = one(F + 'ForumPreference', key),
        delivery = one(F + 'ForumDeliveryPreference', key)
    return {
        preferences: pick(preference, 'watchLevel revision'),
        delivery: pick(delivery, 'emailMode includeOwn suppressed revision'),
        revision: Math.max(
            Number(preference?.revision || 0),
            Number(delivery?.revision || 0),
        ),
    }
}
methods.setPreferences = (p) => {
    site(p.siteId)
    const partyId = requireUser()
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const key = {
        siteId: p.siteId,
        partyId,
        scopeType: p.scopeType || 'site',
        scopeId: p.scopeId || '_SITE_',
    }
    if (!['site', 'category', 'topic'].includes(key.scopeType))
        invalid('Invalid preference scope')
    if (key.scopeType === 'category') category(key.scopeId, p.siteId)
    if (key.scopeType === 'topic') topic(key.scopeId, p.siteId)
    const oldPreference = one(F + 'ForumPreference', key),
        oldDelivery = one(F + 'ForumDeliveryPreference', key),
        current = Math.max(
            Number(oldPreference?.revision || 0),
            Number(oldDelivery?.revision || 0),
        )
    if (Number(p.expectedRevision || 0) !== current)
        fail('Conflict', 'Preferences changed; reload and compare')
    if (p.watchLevel != null) {
        if (
            ![
                'Muted',
                'Normal',
                'Tracking',
                'Watching',
                'WatchingFirstPost',
            ].includes(p.watchLevel)
        )
            invalid('Invalid watch level')
        const values = {
            ...key,
            watchLevel: p.watchLevel,
            revision: current + 1,
        }
        oldPreference
            ? update(oldPreference, values)
            : create(F + 'ForumPreference', values)
    }
    if (p.emailMode != null) {
        if (!['None', 'Notifications'].includes(p.emailMode))
            invalid('Stage 1 email mode must be None or Notifications')
        const values = {
            ...key,
            emailMode: p.emailMode,
            includeOwn: 'N',
            suppressed: 'N',
            revision: current + 1,
        }
        oldDelivery
            ? update(oldDelivery, values)
            : create(F + 'ForumDeliveryPreference', values)
    }
    return methods.getPreferences(p)
}

methods.getSitePage = (p) => {
    site(p.siteId)
    if (!['guidelines', 'about'].includes(p.pageRole)) missing()
    const binding = one(S + 'PublicSitePage', {
        siteId: p.siteId,
        pageRole: p.pageRole,
    })
    if (!binding) missing()
    const page = one('moqui.resource.wiki.WikiPage', {
        wikiPageId: binding.wikiPageId,
    })
    if (!page || page.publishedVersionName !== binding.versionName) missing()
    const out = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.WikiServices.get#PublishedWikiPageText')
        .parameters({
            wikiSpaceId: page.wikiSpaceId,
            pagePath: page.pagePath,
            versionName: null,
        })
        .call()
    if (out.versionName && out.versionName !== binding.versionName) missing()
    return {
        page: {
            ...pick(binding, 'pageRole publicationRevision'),
            body: StringUtilities.cleanHtml(out.text || out.pageText || ''),
        },
    }
}
methods.checkReadiness = (p) => {
    site(p.siteId, true)
    let scannerReady = false
    try {
        scannerReady =
            !!System.getProperty('pass_scanner_service') &&
            !!ec.service.getServiceDefinition(
                System.getProperty('pass_scanner_service'),
            )
    } catch (error) {
        ec.message.clearErrors()
    }
    const checks = [
        { name: 'image derivatives', ready: ec.resource.imageAvailable },
        {
            name: 'SSO package',
            ready:
                !System.getProperty('pass_sso_flows') ||
                ec.service.ssoAvailable,
        },
        {
            name: 'hosts',
            ready: find(S + 'PublicSiteHost', { siteId: p.siteId }).count() > 0,
        },
        {
            name: 'mounts',
            ready:
                find(S + 'PublicSiteApp', {
                    siteId: p.siteId,
                    enabled: 'Y',
                }).count() > 0,
        },
        {
            name: 'mail',
            ready: !!one(F + 'ForumMailSettings', { siteId: p.siteId }),
        },
        { name: 'scanner', ready: scannerReady },
        {
            name: 'media storage',
            ready: !!System.getProperty('pass_media_root'),
        },
        {
            name: 'account verification',
            ready: !!System.getProperty('pass_verification_template'),
        },
        {
            name: 'mail conversion',
            ready:
                find(F + 'ForumJobRun', {
                    siteId: p.siteId,
                    jobType: 'bootstrap',
                })
                    .condition('state', 'not-equals', 'complete')
                    .count() === 0,
        },
    ]
    return { ready: checks.every((c) => c.ready), checks }
}
// Internal helpers are never routed by the public API.
function allocateInternal(postId, contactListId, author) {
    for (const partyId of internalMemberIds(contactListId)) {
        if (partyId === author) continue
        const a = categoryAccess(contactListId, partyId)
        if (a && !a.canRead) continue
        create(E + 'CommunicationEventParty', {
            communicationEventId: postId,
            partyId,
            roleTypeId: 'MessageMailbox',
            statusId: 'CepReceived',
        })
    }
}
/* Named internal recipients who can read the category: To beats Cc beats the plain mailbox receipt. */
function addNamedReceipts(postId, contactListId, author, toIds, ccIds) {
    const roles = new Map()
    for (const partyId of toIds || []) roles.set(partyId, 'MessageTo')
    for (const partyId of ccIds || [])
        if (!roles.has(partyId)) roles.set(partyId, 'MessageCc')
    for (const [partyId, roleTypeId] of roles) {
        if (partyId === author || !internalParty(partyId)) continue
        if (!categoryAccess(contactListId, partyId)?.canRead) continue
        for (const row of find(E + 'CommunicationEventParty', {
            communicationEventId: postId,
            partyId,
        }).list())
            row.delete()
        create(E + 'CommunicationEventParty', {
            communicationEventId: postId,
            partyId,
            roleTypeId,
            statusId: 'CepReceived',
        })
    }
}
function internalParty(partyId) {
    if (!partyId) return false
    const cf = ec.entity.conditionFactory
    return (
        find(F + 'ForumInternalAccount', { partyId })
            .conditionDate('fromDate', 'thruDate', now())
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('disabled', 'equals', null),
                        cf.makeCondition('disabled', 'not-equals', 'Y'),
                    ],
                    'or',
                ),
            )
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('terminateDate', 'equals', null),
                        cf.makeCondition('terminateDate', 'greater', now()),
                    ],
                    'or',
                ),
            )
            .limit(1)
            .list().length > 0
    )
}
function internalMemberIds(contactListId) {
    // A view joins only internal accounts/groups; no public membership scan at posting time.
    return new Set(
        Array.from(
            find(F + 'InternalMailboxMember', {
                contactListId,
                statusId: 'CLPT_ACCEPTED',
            })
                .conditionDate('fromDate', 'thruDate', now())
                .conditionDate('groupFromDate', 'groupThruDate', now())
                .condition(
                    ec.entity.conditionFactory.makeCondition(
                        'disabled',
                        'not-equals',
                        'Y',
                        true,
                    ),
                )
                .list(),
        )
            .filter(
                (v) =>
                    v.disabled !== 'Y' &&
                    (!v.terminateDate ||
                        millis(v.terminateDate) > millis(now())) &&
                    (!v.groupFromDate ||
                        millis(v.groupFromDate) <= millis(now())) &&
                    (!v.groupThruDate ||
                        millis(v.groupThruDate) > millis(now())),
            )
            .map((v) => v.partyId),
    )
}
methods.storeMounts = (p) => {
    const s = site(p.siteId, true)
    revision(s, p.expectedRevision)
    const mounts = p.mounts || [],
        hosts = p.hosts || [],
        reserved = [
            'apps',
            'qapps',
            'rest',
            'rpc',
            'status',
            'error',
            'health',
            'metrics',
            'fop',
            'js',
            'css',
            'libs',
            'images',
            'Login',
            'SecondFactor',
            'PasswordReset',
            'sso',
            'notws',
            'termws',
            'PublicShell',
            's',
            'u',
            'cal',
            'r',
        ]
    for (const h of hosts) {
        if (!isOperator())
            fail('Unauthorized', 'Host bindings require an operator')
        if (
            !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(h.hostname || '') ||
            h.hostname.includes('..')
        )
            invalid('Invalid hostname')
        const old = one(S + 'PublicSiteHost', { hostname: h.hostname })
        if (old && old.siteId !== p.siteId)
            invalid('Hostname already belongs to another site')
    }
    for (let i = 0; i < mounts.length; i++) {
        const m = mounts[i]
        if (
            !['forum', 'account', 'members', 'sites'].includes(m.app) ||
            !/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/.test(
                m.pathPrefix || '',
            ) ||
            reserved.includes(m.pathPrefix.split('/')[1])
        )
            invalid('Invalid or reserved mount')
        if (m.pathPrefix === '/' && m.app !== 'forum')
            invalid('Only Forum may mount at root')
        for (const other of mounts.slice(0, i)) {
            if (
                m.pathPrefix === other.pathPrefix ||
                (m.pathPrefix !== '/' &&
                    other.pathPrefix !== '/' &&
                    (m.pathPrefix.startsWith(other.pathPrefix + '/') ||
                        other.pathPrefix.startsWith(m.pathPrefix + '/')))
            )
                invalid('Mounts overlap')
        }
    }
    for (const old of rows(S + 'PublicSiteApp', { siteId: p.siteId }, 100))
        old.delete()
    for (const [i, m] of mounts.entries())
        create(S + 'PublicSiteApp', {
            siteId: p.siteId,
            appMountId: m.appMountId || String(i),
            app: m.app,
            pathPrefix: m.pathPrefix,
            enabled: m.enabled === false ? 'N' : 'Y',
        })
    if (hosts.filter((h) => h.canonical).length > 1)
        invalid('Choose one canonical hostname')
    if (hosts.some((h) => h.canonical))
        for (const old of rows(
            S + 'PublicSiteHost',
            { siteId: p.siteId, canonical: 'Y' },
            100,
        ))
            update(old, { canonical: 'N' })
    for (const h of hosts) {
        const old = one(S + 'PublicSiteHost', { hostname: h.hostname })
        const fields = {
            hostname: h.hostname,
            siteId: p.siteId,
            canonical: h.canonical ? 'Y' : 'N',
        }
        old ? update(old, fields) : create(S + 'PublicSiteHost', fields)
    }
    update(s, {
        policyRevision: Number(s.policyRevision) + 1,
        generation: Number(s.generation) + 1,
    })
    return { revision: Number(s.policyRevision) }
}
methods.updateMembershipPolicy = (p) => {
    const s = site(p.siteId, true)
    revision(s, p.expectedRevision)
    if (!['closed', 'invitation', 'open'].includes(p.registrationMode))
        invalid('Invalid registration mode')
    update(s, {
        registrationMode: p.registrationMode,
        approvalRequired: p.approvalRequired === true ? 'Y' : 'N',
        policyRevision: Number(s.policyRevision) + 1,
    })
    return { revision: Number(s.policyRevision) }
}
methods.createInvitation = (p) => {
    site(p.siteId, true)
    return receipt(p, 'createInvitation', () => {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.emailAddress || ''))
            invalid('Email address required')
        const token = id() + id(),
            invitationId = id(),
            expiresAt = p.expiresAt || millis(now()) + 7 * 86400000
        if (millis(expiresAt) <= millis(now()))
            invalid('Expiry must be in the future')
        create(S + 'PublicSiteInvitation', {
            invitationId,
            siteId: p.siteId,
            tokenHash: hash(token),
            emailHash: hash(p.emailAddress.trim().toLowerCase()),
            scopes: '[]',
            inviterPartyId: requireUser(),
            expiresAt,
        })
        return { invitationId, token, expiresAt }
    })
}
function invitation(p, lock = false) {
    const v = one(
        S + 'PublicSiteInvitation',
        { siteId: p.siteId, tokenHash: hash(p.token || '') },
        lock,
    )
    if (
        !v ||
        v.revokedAt ||
        v.redeemedAt ||
        millis(v.expiresAt) <= millis(now())
    )
        missing()
    return v
}
methods.inspectInvitation = (p) => {
    site(p.siteId)
    const v = invitation(p)
    if (
        p.emailAddress &&
        hash(String(p.emailAddress).trim().toLowerCase()) !== v.emailHash
    )
        missing()
    return { invitation: pick(v, 'siteId expiresAt') }
}
methods.redeemInvitation = (p) => {
    site(p.siteId)
    ensureParty()
    const partyId = requireUser(),
        v = invitation(p, true),
        ua = ec.user.userAccount
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        }) ||
        hash(String(ua.emailAddress || '').toLowerCase()) !== v.emailHash
    )
        fail('Unauthorized', 'Sign in with the verified intended address')
    const old = member(p.siteId)
    if (old && old.role !== 'member')
        fail(
            'Conflict',
            'Existing staff membership must be managed by its owner',
        )
    const values = {
        siteId: p.siteId,
        partyId,
        state: 'active',
        role: 'member',
        joinedAt: now(),
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, values) : create(S + 'PublicSiteParty', values)
    update(v, { redeemedAt: now() })
    return { state: 'active', revision: values.revision }
}
methods.revokeInvitation = (p) => {
    site(p.siteId, true)
    const v = one(S + 'PublicSiteInvitation', {
        invitationId: p.invitationId,
        siteId: p.siteId,
    })
    if (!v) missing()
    update(v, { revokedAt: now() })
    return { revoked: true }
}
methods.resolveDelivery = (p) => {
    site(p.siteId, true)
    const delivery = one(
        F + 'ForumDelivery',
        { siteId: p.siteId, deliveryId: p.deliveryId },
        true,
    )
    if (!delivery) missing()
    revision(delivery, p.expectedRevision)
    if (!p.reason) invalid('A reconciliation reason is required')
    let state
    if (delivery.state === 'failed' && p.decision === 'retry') state = 'retry'
    else if (
        delivery.state === 'uncertain' &&
        ['confirmed-sent', 'confirmed-not-sent'].includes(p.decision)
    )
        state = p.decision === 'confirmed-sent' ? 'sent' : 'retry'
    else fail('Conflict', 'Reconcile only a failed or uncertain delivery')
    const next = Number(delivery.revision || 0) + 1
    update(delivery, {
        state,
        revision: next,
        attempts: state === 'retry' ? 0 : delivery.attempts,
        dueAt: now(),
    })
    audit(
        p.siteId,
        null,
        'delivery',
        p.deliveryId,
        p.decision,
        p.reason,
        Number(delivery.revision) - 1,
        next,
    )
    return { state, revision: next }
}
methods.storeMailSettings = (p) => {
    site(p.siteId, true)
    const allowed = String(System.getProperty('pass_sender_addresses') || '')
        .split(',')
        .map((x) => x.trim())
    if (!allowed.includes(p.senderAddress))
        invalid('Sender must be registered by the operator')
    const template = one('moqui.basic.email.EmailTemplate', {
        emailTemplateId: p.templateId,
    })
    const templates = String(System.getProperty('pass_mail_template_ids') || '')
        .split(',')
        .map((x) => x.trim())
    if (
        !template ||
        template.fromAddress !== p.senderAddress ||
        !templates.includes(p.templateId)
    )
        invalid('Template and sender must be registered together')
    const old = one(F + 'ForumMailSettings', { siteId: p.siteId }, true)
    if (old) revision(old, p.expectedRevision)
    const values = {
        siteId: p.siteId,
        senderAddress: p.senderAddress,
        senderName: p.senderName,
        templateId: p.templateId,
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, values) : create(F + 'ForumMailSettings', values)
    return { revision: values.revision }
}
function optOut(p) {
    const v = one(F + 'ForumOptOut', {
        tokenHash: hash(p.token || ''),
        siteId: p.siteId,
    })
    if (!v || millis(v.expiresAt) <= millis(now())) missing()
    return v
}
methods.inspectOptOut = (p) => {
    const v = optOut(p)
    // Name only what the recipient can still see; a scope they lost access to stays generic.
    let scope = 'this site'
    if (v.scopeType === 'category') {
        const a = categoryAccess(v.scopeId, v.partyId)
        scope = a?.canRead
            ? 'the ' +
              (one('mantle.marketing.contact.ContactList', {
                  contactListId: v.scopeId,
              })?.contactListName || 'selected') +
              ' category'
            : 'a category'
    } else if (v.scopeType === 'topic') scope = 'one discussion'
    return {
        valid: true,
        optOut: {
            'Stops email for': scope,
            Keeps: 'Your membership, your access and in-app notifications',
        },
    }
}
methods.applyOptOut = (p) => {
    const v = optOut(p),
        key = pick(v, 'siteId partyId scopeType scopeId'),
        old = one(F + 'ForumDeliveryPreference', key, true),
        values = {
            ...key,
            emailMode: 'None',
            suppressed: 'Y',
            optOutAt: now(),
            revision: Number(old?.revision || 0) + 1,
        }
    old ? update(old, values) : create(F + 'ForumDeliveryPreference', values)
    return { suppressed: true }
}

methods.stageAttachment = (p) => {
    if (p.purpose === 'avatar') {
        site(p.siteId)
        const membership = member(p.siteId, requireUser())
        if (
            !active(membership) ||
            membership.state !== 'active' ||
            sanctioned(p.siteId, me(), null, 'suspend')
        )
            fail(
                'Unauthorized',
                'Active membership is required for avatar uploads',
            )
    } else {
        if (p.purpose && p.purpose !== 'post') invalid('Unknown upload purpose')
        const a = category(p.contactListId, p.siteId)
        if (!a.canUpload) fail('Unauthorized', 'Uploads are not permitted')
    }
    const partyId = requireUser(),
        file = p.file
    if (p.draftId) {
        const draft = one(F + 'ForumDraft', { draftId: p.draftId })
        if (draft && (draft.partyId !== partyId || draft.siteId !== p.siteId))
            missing()
    }
    if (!file || Number(file.size) > 10485760 || Number(file.size) < 1)
        invalid('Upload must contain 1 byte to 10 MiB')
    const type = String(file.contentType || 'application/octet-stream')
    if (
        ![
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/gif',
            'application/pdf',
            'text/plain',
        ].includes(type)
    )
        invalid('Unsupported attachment type')
    if (p.purpose === 'avatar' && !type.startsWith('image/'))
        invalid('Avatars require a raster image')
    const scanner = System.getProperty('pass_scanner_service'),
        root = System.getProperty('pass_media_root')
    if (!scanner || !root)
        fail('Unavailable', 'Media scanning and storage must be configured')
    const attachmentId = id(),
        location = String(root).replace(/\/$/, '') + '/' + attachmentId
    file.write(location)
    create(F + 'ForumAttachment', {
        attachmentId,
        siteId: p.siteId,
        purpose: p.purpose || 'post',
        ownerPartyId: partyId,
        draftId: p.draftId,
        location,
        filename: String(file.name || 'attachment')
            .replace(/[^a-zA-Z0-9._ -]/g, '_')
            .slice(0, 100),
        mimeType: type,
        byteSize: Number(file.size),
        scanState: 'pending',
        expiresAt: millis(now()) + 7 * 86400000,
        altText: p.altText || '',
    })
    let result = { clean: false }
    try {
        result = ec.service
            .sync()
            .throwOnError(true)
            .name(scanner)
            .parameters({ location, mimeType: type })
            .call()
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error(
            'Forum attachment ' +
                attachmentId +
                ' could not be scanned; held in quarantine',
        )
    }
    const att = one(F + 'ForumAttachment', { attachmentId })
    update(att, { scanState: result.clean === true ? 'clean' : 'quarantined' })
    return {
        attachment: pick(
            att,
            'attachmentId filename mimeType byteSize scanState altText',
        ),
    }
}
methods.removeStagedAttachment = (p) => {
    site(p.siteId)
    const v = one(F + 'ForumAttachment', {
        attachmentId: p.attachmentId,
        siteId: p.siteId,
        ownerPartyId: requireUser(),
    })
    if (
        !v ||
        v.communicationEventId ||
        one(S + 'PublicSiteProfile', {
            siteId: p.siteId,
            avatarId: p.attachmentId,
        })
    )
        missing()
    ec.resource.getLocationReference(v.location).delete()
    v.delete()
    return { removed: true }
}
methods.getAttachment = (p) => {
    site(p.siteId)
    const v = one(F + 'ForumAttachment', {
        attachmentId: p.attachmentId,
        siteId: p.siteId,
    })
    if (!v || v.scanState !== 'clean') missing()
    if (v.purpose === 'avatar') {
        const profile = one(S + 'PublicSiteProfile', {
            siteId: p.siteId,
            avatarId: p.attachmentId,
        })
        if (!profile) missing()
        methods.getProfile({ siteId: p.siteId, handle: profile.handle })
    } else {
        if (!v.communicationEventId) missing()
        const st = one(F + 'ForumPostState', {
            communicationEventId: v.communicationEventId,
        })
        if (!st) missing()
        const { a } = topic(st.rootCommEventId, p.siteId)
        if (
            st.visibility === 'deleted' ||
            !postVisible(
                st,
                one(E + 'CommunicationEvent', {
                    communicationEventId: st.communicationEventId,
                }),
                a,
            ) ||
            (!a.canRead && !a.canReadOwn)
        )
            missing()
    }
    if (p.variant && p.variant !== 'thumbnail') invalid('Unknown media variant')
    if (p.variant === 'thumbnail') {
        if (!ec.resource.imageAvailable)
            fail(
                'Unavailable',
                'Image derivatives are unavailable in this framework package',
            )
        if (!String(v.mimeType).startsWith('image/')) missing()
        const location = v.location + '.thumbnail.png'
        if (!ec.resource.getLocationReference(location).exists) {
            const result = ec.resource.makeThumbnail(v.location, location, 256)
            if (!result) missing()
        }
        return {
            attachment: {
                attachmentId: v.attachmentId,
                filename: 'thumbnail.png',
                mimeType: 'image/png',
                variant: 'thumbnail',
            },
            location,
        }
    }
    return {
        attachment: pick(v, 'attachmentId filename mimeType byteSize'),
        location: v.location,
    }
}
methods.findNotifications = (p) => {
    site(p.siteId)
    const partyId = requireUser(),
        pg = page(p, 'notifications:' + p.siteId + ':' + (p.view || 'all'))
    if (p.view && !['all', 'unread'].includes(p.view))
        invalid('Invalid notification view')
    const list = Array.from(
            find(F + 'ForumDelivery', {
                siteId: p.siteId,
                partyId,
                channel: 'in-app',
            })
                .condition(
                    'state',
                    'in',
                    p.view === 'unread' ? ['sent'] : ['sent', 'read'],
                )
                .orderBy('-dueAt,deliveryId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        ),
        visible = []
    for (const item of list.slice(0, pg.limit)) {
        const box = one(F + 'ForumOutbox', { outboxId: item.outboxId }),
            st = box
                ? one(F + 'ForumPostState', {
                      communicationEventId: box.communicationEventId,
                  })
                : null
        if (!st || st.visibility !== 'approved') continue
        try {
            const { event } = topic(st.rootCommEventId, p.siteId)
            visible.push({
                deliveryId: item.deliveryId,
                postId: st.communicationEventId,
                rootCommEventId: st.rootCommEventId,
                title: event.subject,
                createdAt: item.dueAt,
                read: item.state === 'read',
            })
        } catch (e) {
            if (e.moquiErrorKind !== 'NotFound') throw e
        }
    }
    return {
        notificationList: visible,
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.markNotifications = (p) => {
    site(p.siteId)
    const partyId = requireUser()
    for (const deliveryId of p.deliveryIds || []) {
        const v = one(F + 'ForumDelivery', {
            siteId: p.siteId,
            partyId,
            deliveryId,
            channel: 'in-app',
        })
        if (v?.state === 'sent') update(v, { state: 'read' })
    }
    // Read all: the actor's own unread notices on this site, in bounded pages.
    if (p.all === true)
        for (let pageCount = 0; pageCount < 20; pageCount++) {
            const unread = Array.from(
                find(F + 'ForumDelivery', {
                    siteId: p.siteId,
                    partyId,
                    channel: 'in-app',
                    state: 'sent',
                })
                    .limit(500)
                    .list(),
            )
            for (const v of unread) update(v, { state: 'read' })
            if (unread.length < 500) break
        }
    return { marked: true }
}
methods.storePolicy = (p) => {
    const s = site(p.siteId, true)
    revision(s, p.expectedRevision)
    if (!p.config) invalid('A policy configuration is required')
    validPolicy(p.config)
    // A section saves only its own settings; the rest carry over from the current revision.
    const config = { ...policy(p.siteId), ...p.config }
    const rev = Number(s.policyRevision) + 1
    create(F + 'ForumPolicy', {
        siteId: p.siteId,
        policyRevision: rev,
        config: JSON.stringify(config),
        createdAt: now(),
    })
    update(s, { policyRevision: rev, generation: Number(s.generation) + 1 })
    if (p.reason)
        audit(
            p.siteId,
            null,
            'policy',
            p.siteId,
            'policy',
            p.reason,
            rev - 1,
            rev,
        )
    return { revision: rev }
}
methods.getPolicy = (p) => {
    const s = site(p.siteId, true)
    return { policy: policy(p.siteId), revision: Number(s.policyRevision) }
}

methods.getSiteInfo = (p) => {
    const s = site(p.siteId)
    if (
        p.hostname &&
        !one(S + 'PublicSiteHost', { siteId: p.siteId, hostname: p.hostname })
    )
        missing()
    const membership = member(p.siteId),
        joined =
            active(membership) &&
            membership.state === 'active' &&
            !sanctioned(p.siteId, me(), null, 'suspend')
    return {
        capabilities: {
            canManageSite:
                isOperator() || (joined && membership.role === 'owner'),
            canModerateSite:
                isOperator() ||
                (joined && ['owner', 'moderator'].includes(membership.role)),
        },
        ssoFlows: String(
            ec.service.ssoAvailable
                ? System.getProperty('pass_sso_flows') || ''
                : '',
        )
            .split(',')
            .filter(Boolean)
            .filter((flowId) => {
                const flow = one('moqui.security.sso.AuthFlow', {
                    authFlowId: flowId,
                })
                return (
                    flow &&
                    flow.disabled !== 'Y' &&
                    flow.inbound !== 'Y' &&
                    ['AftOidc', 'AftOauth'].includes(flow.authFlowTypeEnumId)
                )
            })
            .map((flowId) => ({ flowId })),
        site: pick(
            s,
            'siteId name state locale timeZone registrationMode generation policyRevision',
        ),
        mounts: rows(S + 'PublicSiteApp', {
            siteId: p.siteId,
            enabled: 'Y',
        }).map((v) => pick(v, 'app pathPrefix')),
        authenticated: !!ec.user.userId,
        membershipState: member(p.siteId)?.state || null,
        recoveryKey: ec.user.userId
            ? hash(p.siteId + ':' + ec.user.userId)
            : null,
        profile: me()
            ? pick(
                  one(S + 'PublicSiteProfile', {
                      siteId: p.siteId,
                      partyId: me(),
                  }),
                  'handle displayName',
              )
            : null,
    }
}
function recordMailboxPost(postId) {
    const event = one(E + 'CommunicationEvent', {
        communicationEventId: postId,
    })
    if (!event?.contactListId) return
    const list = one('mantle.marketing.contact.ContactList', {
        contactListId: event.contactListId,
    })
    if (list?.contactListTypeEnumId !== 'MAILBOX') return
    const root = event.rootCommEventId || postId
    let t = one(F + 'ForumTopic', { rootCommEventId: root }, true)
    if (!t) {
        t = create(F + 'ForumTopic', {
            rootCommEventId: root,
            siteId: null,
            contactListId: event.contactListId,
            kind: 'category',
            revision: 1,
            nextOrdinal: 1,
            visiblePostCount: 0,
            lastActivity: event.entryDate,
        })
    }
    if (!one(F + 'ForumPostState', { communicationEventId: postId })) {
        const ordinal = Number(t.nextOrdinal)
        create(F + 'ForumPostState', {
            communicationEventId: postId,
            rootCommEventId: root,
            ordinal,
            revision: 1,
            visibility: 'approved',
            approvedRevision: 1,
        })
        update(t, {
            nextOrdinal: ordinal + 1,
            visiblePostCount: Number(t.visiblePostCount) + 1,
            lastActivity: event.entryDate,
            revision: Number(t.revision) + 1,
        })
    }
}

function legacyReading(event, partyId) {
    if (!event.contactListId || internalParty(partyId)) return null
    const list = one('mantle.marketing.contact.ContactList', {
        contactListId: event.contactListId,
    })
    if (list?.contactListTypeEnumId !== 'MAILBOX') return null
    const root = event.rootCommEventId || event.communicationEventId,
        t = one(F + 'ForumTopic', { rootCommEventId: root }),
        state = one(F + 'ForumPostState', {
            communicationEventId: event.communicationEventId,
        }),
        marker = one(F + 'ForumTopicUser', { rootCommEventId: root, partyId }),
        boundary = readingBoundary(root, t?.siteId, event.contactListId)
    return {
        isUnread: state
            ? state.visibility === 'approved' &&
              Number(state.ordinal) > Number(boundary?.consumedOrdinal || 0)
            : true,
        markerRevision: Number(marker?.markerRevision || 0),
        consumedOrdinal: Number(boundary?.consumedOrdinal || 0),
        highestSeenOrdinal: Number(marker?.highestSeenOrdinal || 0),
        archivedAt: marker?.archivedAt || null,
    }
}
/* A public member's inbox summary of one mailbox. Only the most recently active topics are counted, so one
   inbox load stays bounded however many threads the mailbox has; beyond them the count is a lower bound. */
const SUMMARY_TOPIC_LIMIT = 200
function legacyMailboxSummary(contactListId) {
    const partyId = me()
    if (!partyId || internalParty(partyId)) return null
    return withAccessMemo(() => {
        let unreadCount = 0,
            lastPostDate = null
        const topics = Array.from(
            find(F + 'ForumTopic', { contactListId, kind: 'category' })
                .orderBy('-lastActivity,rootCommEventId')
                .limit(SUMMARY_TOPIC_LIMIT + 1)
                .list(),
        )
        for (const t of topics.slice(0, SUMMARY_TOPIC_LIMIT)) {
            if (t.siteId) {
                try {
                    topic(t.rootCommEventId, t.siteId)
                } catch (error) {
                    if (error.moquiErrorKind === 'NotFound') continue
                    throw error
                }
            }
            if (!lastPostDate) lastPostDate = t.lastActivity
            const marker = one(F + 'ForumTopicUser', {
                    rootCommEventId: t.rootCommEventId,
                    partyId,
                }),
                boundary = readingBoundary(
                    t.rootCommEventId,
                    t.siteId,
                    contactListId,
                )
            if (!marker?.archivedAt)
                unreadCount += find(F + 'ForumPostState', {
                    rootCommEventId: t.rootCommEventId,
                    visibility: 'approved',
                })
                    .condition(
                        'ordinal',
                        'greater',
                        Number(boundary?.consumedOrdinal || 0),
                    )
                    .count()
        }
        return {
            unreadCount,
            lastPostDate,
            unreadCapped: topics.length > SUMMARY_TOPIC_LIMIT,
        }
    })
}

function legacyMarker(event, partyId, change, expected) {
    const root = event.rootCommEventId || event.communicationEventId,
        key = { rootCommEventId: root, partyId }
    lockActor()
    let topicRow = one(F + 'ForumTopic', { rootCommEventId: root })
    if (!topicRow)
        fail('Unavailable', 'Mailbox tracking conversion is required')
    const state = one(F + 'ForumPostState', {
        communicationEventId: event.communicationEventId,
    })
    if (!state) fail('Unavailable', 'Mailbox tracking conversion is required')
    const old = one(F + 'ForumTopicUser', key, true)
    if (
        (expected != null &&
            Number(expected) !== Number(old?.markerRevision || 0)) ||
        (change.read === false && expected == null)
    )
        fail('Conflict', 'Reading position changed; reload and compare')
    const initial = readingBoundary(root, topicRow.siteId, event.contactListId),
        consumed = Number(old?.consumedOrdinal ?? initial?.consumedOrdinal ?? 0)
    const noGap =
        find(F + 'ForumPostState', {
            rootCommEventId: root,
            visibility: 'approved',
        })
            .condition('ordinal', 'greater', consumed)
            .condition('ordinal', 'less', Number(state.ordinal))
            .limit(1)
            .list().length === 0
    const canConsume =
        change.read === true &&
        state.visibility === 'approved' &&
        noGap &&
        (expected != null || !old?.unreadBoundary)
    const values = {
        ...key,
        consumedOrdinal:
            change.read === false
                ? Math.max(0, Number(state.ordinal) - 1)
                : canConsume
                  ? Math.max(consumed, Number(state.ordinal))
                  : consumed,
        highestSeenOrdinal:
            change.read === true
                ? Math.max(
                      Number(old?.highestSeenOrdinal || 0),
                      Number(state.ordinal),
                  )
                : Number(old?.highestSeenOrdinal || 0),
        unreadBoundary:
            change.read === false
                ? Number(state.ordinal)
                : canConsume
                  ? null
                  : old?.unreadBoundary,
        markerRevision: Number(old?.markerRevision || 0) + 1,
        lastVisit: now(),
        archivedAt:
            change.archived === true
                ? now()
                : change.archived === false
                  ? null
                  : old?.archivedAt,
    }
    old ? update(old, values) : create(F + 'ForumTopicUser', values)
    return values
}
methods.getDraft = (p) => {
    site(p.siteId)
    const d = one(F + 'ForumDraft', {
        siteId: p.siteId,
        draftId: p.draftId,
        partyId: requireUser(),
    })
    if (!d) missing()
    if (d.rootCommEventId) topic(d.rootCommEventId, p.siteId)
    else if (d.contactListId) category(d.contactListId, p.siteId)
    return {
        draft: {
            ...pick(
                d,
                'draftId mode rootCommEventId parentCommEventId contactListId postId postRevision title revision',
            ),
            tags: json(d.tagsJson, []),
            poll: json(d.pollJson, null),
            body: StringUtilities.cleanHtml(d.sourceText || ''),
            attachments: rows(
                F + 'ForumAttachment',
                {
                    siteId: p.siteId,
                    ownerPartyId: me(),
                    draftId: d.draftId,
                    communicationEventId: null,
                },
                100,
            )
                .filter(
                    (v) => !v.expiresAt || millis(v.expiresAt) > millis(now()),
                )
                .map((v) =>
                    pick(
                        v,
                        'attachmentId filename mimeType byteSize scanState altText',
                    ),
                ),
        },
    }
}
methods.joinCategory = (p) => {
    site(p.siteId)
    const partyId = requireUser(),
        a = category(p.contactListId, p.siteId)
    // Joining a help category would open every other member's thread; staff add help members.
    if (
        member(p.siteId)?.state !== 'active' ||
        !a.canRead ||
        a.category.visibility === 'help'
    )
        fail('Unauthorized', 'Joining is not permitted')
    const old = listMember(p.contactListId, partyId)
    if (old) return { state: 'active' }
    const values = {
        contactListId: p.contactListId,
        partyId,
        fromDate: now(),
        revision: 1,
        statusId:
            a.category.joinApprovalRequired === 'Y'
                ? 'CLPT_PENDING'
                : 'CLPT_ACCEPTED',
    }
    create('mantle.marketing.contact.ContactListParty', values)
    return { state: values.statusId === 'CLPT_PENDING' ? 'pending' : 'active' }
}
methods.leaveCategory = (p) => {
    category(p.contactListId, p.siteId)
    requireUser()
    ec.service
        .sync()
        .throwOnError(true)
        .name('mantle.marketing.ContactListServices.leave#ContactList')
        .parameters({ contactListId: p.contactListId })
        .call()
    return { state: 'ended' }
}
methods.findCategoryMembers = (p) => {
    const a = category(p.contactListId, p.siteId)
    if (!a.canModerate)
        fail('Unauthorized', 'Category moderator access required')
    const pg = page(p, 'category-members:' + p.contactListId),
        list = Array.from(
            find('mantle.marketing.contact.ContactListParty', {
                contactListId: p.contactListId,
            })
                .conditionDate('fromDate', 'thruDate', now())
                .orderBy('partyId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
    return {
        memberList: list.slice(0, pg.limit).map((v) => ({
            ...pick(v, 'partyId roleTypeId statusId fromDate thruDate'),
            revision: Number(v.revision || 0),
        })),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.setCategoryMember = (p) => {
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    // Serialize decisions, including first membership creation, with the category.
    one(F + 'ForumCategory', { contactListId: p.contactListId }, true)
    const a = category(p.contactListId, p.siteId)
    if (!a.canModerate)
        fail('Unauthorized', 'Category moderator access required')
    const target = member(p.siteId, p.targetPartyId)
    if (!active(target) || target.state !== 'active') missing()
    if (!p.reason?.trim()) invalid('A membership decision reason is required')
    if (!['active', 'ended'].includes(p.state))
        invalid('Membership must be active or ended')
    if (p.roleTypeId && !['ListOwner', 'ListModerator'].includes(p.roleTypeId))
        invalid('Invalid category role')
    const current = Array.from(
        find('mantle.marketing.contact.ContactListParty', {
            contactListId: p.contactListId,
            partyId: p.targetPartyId,
        })
            .conditionDate('fromDate', 'thruDate', now())
            .orderBy('-fromDate')
            .forUpdate(true)
            .limit(1)
            .list(),
    )[0]
    const before = Number(current?.revision || 0)
    revision({ revision: before }, p.expectedRevision)
    const roleChange =
        (current?.roleTypeId || null) !== (p.roleTypeId || null) ||
        (p.state === 'ended' && !!current?.roleTypeId)
    if (roleChange) {
        if (!a.isOwner && !isOperator())
            fail(
                'Unauthorized',
                'Site owner approval is required to delegate category roles',
            )
        const auth = ec.service
            .sync()
            .throwOnError(true)
            .name('org.moqui.impl.UserServices.login#UserAccount')
            .parameters({
                username: ec.user.userAccount.username,
                password: p.password,
                code: p.code,
            })
            .call()
        if (!auth.loggedIn)
            fail(
                'AuthenticationRequired',
                'Reauthenticate before changing category roles',
            )
    }
    ec.service
        .sync()
        .throwOnError(true)
        .name(
            'mantle.marketing.ContactListServices.' +
                (p.state === 'ended'
                    ? 'remove#ContactListParty'
                    : 'add#ContactListParty'),
        )
        .parameters({
            contactListId: p.contactListId,
            partyId: p.targetPartyId,
            ...(p.state === 'active'
                ? { roleTypeId: p.roleTypeId || null }
                : {}),
        })
        .call()
    audit(
        p.siteId,
        p.contactListId,
        'member',
        p.targetPartyId,
        'category-membership',
        p.reason,
        before,
        before + 1,
    )
    bump(p.siteId)
    return { state: p.state, revision: before + 1 }
}
methods.bindMailbox = (p) => {
    site(p.siteId, true)
    return receipt(p, 'bindMailbox', () => {
        if (p.confirm !== true) invalid('Confirm the mailbox and its audience')
        const list = one('mantle.marketing.contact.ContactList', {
            contactListId: p.contactListId,
        })
        if (!list || list.contactListTypeEnumId !== 'MAILBOX') missing()
        // Binding exposes a mailbox's history to the site's staff: an operator, or an internal owner of that list.
        if (
            !isOperator() &&
            !(
                listMember(p.contactListId, me())?.roleTypeId === 'ListOwner' &&
                internalParty(me())
            )
        )
            missing()
        if (one(F + 'ForumCategory', { contactListId: p.contactListId }))
            fail('Conflict', 'Mailbox is already bound')
        const category = create(F + 'ForumCategory', {
            contactListId: p.contactListId,
            siteId: p.siteId,
            publicationState: 'disabled',
            visibility: 'category',
            mode: 'discussion',
            slug: p.contactListId,
            policyRevision: 1,
        })
        const runId = id()
        create(F + 'ForumJobRun', {
            runId,
            siteId: p.siteId,
            jobType: 'bootstrap',
            state: 'pending',
            checkpoint: JSON.stringify({ contactListId: p.contactListId }),
            createdAt: now(),
            successCount: 0,
            failedCount: 0,
        })
        return {
            contactListId: category.contactListId,
            state: 'disabled',
            runId,
        }
    })
}
methods.findRuns = (p) => {
    site(p.siteId, true)
    const pg = page(p, 'runs:' + p.siteId),
        list = Array.from(
            find(F + 'ForumJobRun', { siteId: p.siteId })
                .orderBy('-createdAt,runId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
    return {
        runList: list
            .slice(0, pg.limit)
            .map((v) =>
                pick(
                    v,
                    'runId jobType state checkpoint successCount failedCount createdAt',
                ),
            ),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.manageRun = (p) => {
    site(p.siteId, true)
    const run = one(F + 'ForumJobRun', { runId: p.runId }, true)
    if (!run || (run.siteId !== p.siteId && !(isOperator() && !run.siteId)))
        missing()
    if (!p.reason) invalid('A recovery reason is required')
    if (p.action === 'cancel' && run.state === 'pending')
        update(run, { state: 'cancelled' })
    else if (
        ['retry', 'resume'].includes(p.action) &&
        ['failed', 'cancelled'].includes(run.state)
    ) {
        find(F + 'ForumJobItem', { runId: p.runId, state: 'failed' }).updateAll(
            { state: 'pending' },
        )
        const config = JSON.parse(run.checkpoint)
        delete config.after
        if (run.jobType === 'tracking') {
            config.phase = 'markers'
            config.after = ''
        }
        update(run, {
            state: 'pending',
            checkpoint: JSON.stringify(config),
            failedCount: 0,
        })
    } else fail('Conflict', 'Job state changed')
    audit(p.siteId, null, 'job', p.runId, p.action, p.reason, null, null)
    return { state: run.state }
}
methods.publishSitePage = (p) => {
    site(p.siteId, true)
    if (!['guidelines', 'about'].includes(p.pageRole))
        invalid('Invalid page role')
    const access = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.WikiServices.get#WikiPageAccess')
        .parameters({ wikiPageId: p.wikiPageId })
        .call()
    if (!access.canUpdate)
        fail('Unauthorized', 'Wiki publication access required')
    const page = one('moqui.resource.wiki.WikiPage', {
        wikiPageId: p.wikiPageId,
    })
    if (!page || !p.versionName || page.publishedVersionName !== p.versionName)
        invalid('Select the exact currently published wiki revision')
    const old = one(
        S + 'PublicSitePage',
        { siteId: p.siteId, pageRole: p.pageRole },
        true,
    )
    if (
        p.expectedRevision == null ||
        Number(p.expectedRevision) !== Number(old?.publicationRevision || 0)
    )
        fail('Conflict', 'Published site page changed')
    const values = {
        siteId: p.siteId,
        pageRole: p.pageRole,
        wikiPageId: p.wikiPageId,
        versionName: p.versionName,
        publicationRevision: Number(old?.publicationRevision || 0) + 1,
    }
    old ? update(old, values) : create(S + 'PublicSitePage', values)
    bump(p.siteId)
    return { revision: values.publicationRevision }
}

/* Sanitized HTML as plain text; templates escape it once. */
function plainText(html) {
    return StringUtilities.cleanHtml(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
            String.fromCodePoint(parseInt(n, 16)),
        )
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
}
methods.searchForum = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        if (
            !p.query ||
            String(p.query).length < 2 ||
            String(p.query).length > 200
        )
            invalid('Search needs 2–200 characters')
        const allowed = []
        for (const c of rows(F + 'ForumCategory', { siteId: p.siteId }, 1000)) {
            const a = categoryAccess(c.contactListId)
            if (
                a &&
                (a.canRead || a.canReadOwn || a.canModerate) &&
                (!p.contactListId || p.contactListId === c.contactListId)
            )
                allowed.push(c.contactListId)
        }
        if (!allowed.length) return { topicList: [], nextCursor: null }
        const pg = page(
                p,
                'search:' +
                    p.siteId +
                    ':' +
                    p.query +
                    ':' +
                    (p.contactListId || ''),
            ),
            cf = ec.entity.conditionFactory
        const candidates = Array.from(
            find(F + 'ForumPostSearch', {
                siteId: p.siteId,
                visibility: 'approved',
            })
                .condition('contactListId', 'in', allowed)
                .condition(
                    cf.makeCondition('unlisted', 'not-equals', 'Y', true),
                )
                .condition(
                    cf.makeCondition(
                        [
                            // Replies keep the subject from when they were posted; only the root carries the title.
                            cf.makeCondition(
                                [
                                    cf.makeCondition(
                                        'subject',
                                        'like',
                                        '%' + p.query + '%',
                                    ),
                                    cf.makeCondition('ordinal', 'equals', 1),
                                ],
                                'and',
                            ),
                            cf.makeCondition(
                                'body',
                                'like',
                                '%' + p.query + '%',
                            ),
                        ],
                        'or',
                    ),
                )
                .orderBy('-entryDate,communicationEventId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        const literal = /[%_]/.test(p.query)
            ? String(p.query).toLowerCase()
            : null
        const list = []
        for (const candidate of candidates.slice(0, pg.limit)) {
            let out
            try {
                out = topic(candidate.rootCommEventId, p.siteId)
            } catch (e) {
                if (e.moquiErrorKind === 'NotFound') continue
                throw e
            }
            if (!postVisible(candidate, candidate, out.a)) continue
            const text = plainText(candidate.body)
            // LIKE treats % and _ as wildcards; keep only literal matches.
            if (
                literal &&
                !(
                    (Number(candidate.ordinal) === 1 &&
                        String(out.event.subject || '')
                            .toLowerCase()
                            .includes(literal)) ||
                    text.toLowerCase().includes(literal)
                )
            )
                continue
            list.push({
                rootCommEventId: candidate.rootCommEventId,
                postId: candidate.communicationEventId,
                title: out.event.subject,
                snippet: text.slice(0, 240),
                entryDate: candidate.entryDate,
                capabilities: capabilities(out.a),
            })
        }
        return {
            topicList: list,
            nextCursor:
                candidates.length > pg.limit
                    ? pg.next(pg.offset + pg.limit)
                    : null,
        }
    })
methods.getFeed = (p) => {
    const s = one(S + 'PublicSite', { siteId: p.siteId })
    if (!s || s.state !== 'published') missing()
    const publicCategories = rows(
        F + 'ForumCategory',
        { siteId: p.siteId, publicationState: 'published' },
        1000,
    )
        .filter((c) => categoryAccess(c.contactListId, null)?.canRead)
        .map((c) => c.contactListId)
    const topics = []
    for (const t of Array.from(
        find(F + 'ForumTopic', {
            siteId: p.siteId,
            kind: 'category',
            ...(p.contactListId ? { contactListId: p.contactListId } : {}),
        })
            .orderBy('-lastActivity,rootCommEventId')
            .limit(100)
            .list(),
    )) {
        const event = one(E + 'CommunicationEvent', {
                communicationEventId: t.rootCommEventId,
            }),
            state = one(F + 'ForumPostState', {
                communicationEventId: t.rootCommEventId,
            })
        if (
            event &&
            state?.visibility === 'approved' &&
            t.unlisted !== 'Y' &&
            publicCategories.includes(event.contactListId)
        )
            topics.push({
                id: t.rootCommEventId,
                title: event.subject,
                date: event.entryDate,
            })
    }
    const host = one(S + 'PublicSiteHost', { siteId: p.siteId, canonical: 'Y' })
    if (!host) missing()
    const mount = one(S + 'PublicSiteApp', {
        siteId: p.siteId,
        app: 'forum',
        enabled: 'Y',
    })
    if (!mount) missing()
    const base =
        'https://' +
        host.hostname +
        (mount.pathPrefix === '/' ? '' : mount.pathPrefix)
    const escape = (t) =>
        String(t || '').replace(
            /[&<>"']/g,
            (c) =>
                ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&apos;',
                })[c],
        )
    const link = (t) =>
        base +
        '/t/' +
        encodeURIComponent(t.id) +
        '/' +
        encodeURIComponent(slugify(t.title))
    if (p.format === 'sitemap')
        return {
            contentType: 'application/xml',
            body:
                '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
                topics
                    .map((t) => '<url><loc>' + escape(link(t)) + '</loc></url>')
                    .join('') +
                '</urlset>',
        }
    if (p.format === 'atom')
        return {
            contentType: 'application/atom+xml',
            body:
                '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>' +
                escape(base) +
                '</id><title>' +
                escape(s.name) +
                '</title><updated>' +
                new Date(topics[0]?.date || now()).toISOString() +
                '</updated>' +
                topics
                    .map(
                        (t) =>
                            '<entry><id>' +
                            escape(link(t)) +
                            '</id><title>' +
                            escape(t.title) +
                            '</title><link href="' +
                            escape(link(t)) +
                            '"/><updated>' +
                            new Date(t.date).toISOString() +
                            '</updated></entry>',
                    )
                    .join('') +
                '</feed>',
        }
    return {
        contentType: 'application/rss+xml',
        body:
            '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>' +
            escape(s.name) +
            '</title><link>' +
            escape(base) +
            '</link><description>Community topics</description>' +
            topics
                .map(
                    (t) =>
                        '<item><guid>' +
                        escape(link(t)) +
                        '</guid><title>' +
                        escape(t.title) +
                        '</title><link>' +
                        escape(link(t)) +
                        '</link></item>',
                )
                .join('') +
            '</channel></rss>',
    }
}

methods.getPostLocation = (p) => {
    const state = one(F + 'ForumPostState', { communicationEventId: p.postId })
    if (!state) missing()
    const { event, a } = topic(state.rootCommEventId, p.siteId)
    const post = one(E + 'CommunicationEvent', {
        communicationEventId: p.postId,
    })
    if (!postVisible(state, post, a) || state.visibility === 'deleted')
        missing()
    return {
        rootCommEventId: state.rootCommEventId,
        slug: slugify(event.subject),
        postId: p.postId,
    }
}
methods.getEditablePost = (p) => {
    requireUser()
    const state = one(F + 'ForumPostState', { communicationEventId: p.postId })
    if (!state) missing()
    const { event: root, a } = topic(state.rootCommEventId, p.siteId),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!canEditPost(state, event, a))
        fail('Unauthorized', 'Editing is not permitted')
    return {
        draft: {
            postId: p.postId,
            wiki: state.wiki === 'Y',
            postRevision: Number(state.revision),
            rootCommEventId: state.rootCommEventId,
            contactListId: event.contactListId,
            title: root.subject,
            body: StringUtilities.cleanHtml(event.body || ''),
            mode: 'edit',
            attachments: rows(
                F + 'ForumAttachment',
                { siteId: p.siteId, communicationEventId: p.postId },
                100,
            ).map((value) => ({
                ...pick(
                    value,
                    'attachmentId filename mimeType byteSize scanState altText',
                ),
                finalized: true,
            })),
        },
    }
}
methods.previewTopicAction = (p) => {
    const { t, event, a } = topic(p.rootCommEventId, p.siteId)
    if (!a.canModerate) fail('Unauthorized', 'Moderator access required')
    if (['move-posts', 'split', 'merge'].includes(p.action)) {
        const dest = destination(p, a)
        if (!dest.a.canModerate)
            fail('Unauthorized', 'Destination moderator access required')
        const states =
            p.action === 'merge'
                ? Array.from(
                      find(F + 'ForumPostState', {
                          rootCommEventId: t.rootCommEventId,
                      })
                          .limit(20000)
                          .list(),
                  )
                : selection(t, p.postIds)
        const ids = states.map((s) => s.communicationEventId)
        return {
            title: event.subject,
            action: p.action,
            sourceVisibility: a.category.visibility,
            targetVisibility: dest.a.category.visibility,
            targetRootCommEventId: dest.t?.rootCommEventId || null,
            selectedPostIds: ids.slice(0, 100),
            visiblePostCount: states.filter((s) => s.visibility === 'approved')
                .length,
            replyCount: Math.max(0, ids.length - (p.postIds?.length || 0)),
            attachmentCount: ids.reduce(
                (n, postId) =>
                    n +
                    find(F + 'ForumAttachment', {
                        communicationEventId: postId,
                    }).count(),
                0,
            ),
            acceptedAnswerAffected:
                !!t.acceptedAnswerId &&
                (p.action === 'merge' || ids.includes(t.acceptedAnswerId)),
            watcherCount: find(F + 'ForumPreference', {
                siteId: p.siteId,
                scopeType: 'topic',
                scopeId: t.rootCommEventId,
                watchLevel: 'Watching',
            }).count(),
            expectedRevision: Number(t.revision),
            expectedGeneration: audienceRevision(p.siteId, a, dest.a),
        }
    }
    const target = p.targetContactListId
        ? category(p.targetContactListId, p.siteId)
        : a
    if (!target.canModerate)
        fail('Unauthorized', 'Destination moderator access required')
    return {
        title: event.subject,
        sourceVisibility: a.category.visibility,
        targetVisibility: target.category.visibility,
        visiblePostCount: t.visiblePostCount,
        expectedRevision: Number(t.revision),
        expectedGeneration: audienceRevision(p.siteId, a, target),
    }
}
/* ---- Stage 2 participation: tags, reactions, accepted answers, polls, bookmarks, history ---- */
const TOP_PERIODS = {
    day: 86400000,
    week: 7 * 86400000,
    month: 30 * 86400000,
    year: 365 * 86400000,
    all: 0,
}
const REACTIONS = ['like', 'thanks', 'insightful', 'agree', 'laugh']
const tagKey = (name) =>
    String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
function resolveTag(siteId, name) {
    const key = tagKey(name)
    const tag =
        one(F + 'ForumTag', { siteId, normalizedName: key }) ||
        (() => {
            const alias = one(F + 'ForumTagAlias', {
                siteId,
                normalizedName: key,
            })
            return alias ? one(F + 'ForumTag', { tagId: alias.tagId }) : null
        })()
    if (!tag || !tagDiscoverable(tag)) missing()
    return tag
}
/* A tag limited to categories the reader cannot discover stays hidden, so it reveals none of them. */
function tagDiscoverable(tag) {
    const allowed = json(tag.allowedCategories, [])
    return (
        !allowed.length ||
        allowed.some((id) => {
            const a = categoryAccess(id)
            return a && (a.canDiscover || a.canReadOwn || a.canModerate)
        })
    )
}
const topicTags = (root) =>
    rows(F + 'ForumTopicTag', { rootCommEventId: root }, 10)
        .map((v) => one(F + 'ForumTag', { tagId: v.tagId })?.name)
        .filter(Boolean)
        .sort()
function setTopicTags(siteId, root, a, names) {
    if (!Array.isArray(names) || names.length > 5)
        invalid('A topic may have at most five tags')
    for (const old of rows(F + 'ForumTopicTag', { rootCommEventId: root }, 10))
        old.delete()
    const seen = new Set()
    for (const name of names) {
        if (typeof name !== 'string') invalid('Invalid tag')
        const tag = resolveTag(siteId, name)
        const allowed = json(tag.allowedCategories, [])
        if (allowed.length && !allowed.includes(a.category.contactListId))
            invalid('Tag ' + tag.name + ' is not used in this category')
        if (seen.has(tag.tagId)) continue
        seen.add(tag.tagId)
        create(F + 'ForumTopicTag', {
            rootCommEventId: root,
            tagId: tag.tagId,
            siteId,
        })
    }
}
/* The accepted answer shows only while its reply is visible to this reader. */
function visibleAnswer(t, a) {
    if (!t.acceptedAnswerId) return null
    const st = one(F + 'ForumPostState', {
        communicationEventId: t.acceptedAnswerId,
    })
    return st?.visibility === 'approved' ? t.acceptedAnswerId : null
}
function clearAnswer(t, a, postId, reason) {
    if (!postId || t.acceptedAnswerId !== postId) return
    update(t, { acceptedAnswerId: null, revision: Number(t.revision) + 1 })
    audit(
        t.siteId,
        a.category.contactListId,
        'topic',
        t.rootCommEventId,
        'answer-cleared',
        reason,
        Number(t.revision) - 1,
        Number(t.revision),
    )
}
methods.findTags = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        const pg = page(p, 'tags:' + p.siteId + ':' + (p.query || ''))
        let q = find(F + 'ForumTag', { siteId: p.siteId })
        if (p.query)
            q = q.condition(
                'normalizedName',
                'like',
                '%' + tagKey(p.query).replace(/[%_\\]/g, '\\$&') + '%',
            )
        const candidates = Array.from(
            q
                .orderBy('normalizedName,tagId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        const list = []
        for (const tag of candidates.slice(0, pg.limit)) {
            if (!tagDiscoverable(tag)) continue
            // Count only topics this reader may see; the inspected window is bounded.
            let count = 0
            for (const tt of rows(
                F + 'ForumTopicTag',
                { tagId: tag.tagId },
                1000,
            ))
                try {
                    const { t, a } = topic(tt.rootCommEventId, p.siteId)
                    if (t.unlisted !== 'Y' || a.canModerate) count++
                } catch (e) {
                    if (e.moquiErrorKind !== 'NotFound') throw e
                }
            list.push({
                ...pick(tag, 'tagId name description revision'),
                allowedCategories: json(tag.allowedCategories, []),
                topicCount: count,
            })
        }
        return {
            tagList: list,
            nextCursor:
                candidates.length > pg.limit
                    ? pg.next(pg.offset + pg.limit)
                    : null,
        }
    })
methods.storeTag = (p) =>
    receipt(p, 'storeTag', () => {
        site(p.siteId)
        staff(p.siteId)
        const key = tagKey(p.name)
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key))
            invalid('A tag name has 1–40 letters, numbers or hyphens')
        const allowed = p.allowedCategories || []
        if (!Array.isArray(allowed) || allowed.length > 50)
            invalid('Invalid category list')
        for (const id of allowed) category(id, p.siteId)
        let tag = p.tagId ? one(F + 'ForumTag', { tagId: p.tagId }, true) : null
        if (p.tagId && (!tag || tag.siteId !== p.siteId)) missing()
        if (tag) revision(tag, p.expectedRevision)
        const clash =
            one(F + 'ForumTag', { siteId: p.siteId, normalizedName: key }) ||
            one(F + 'ForumTagAlias', { siteId: p.siteId, normalizedName: key })
        if (clash && clash.tagId !== tag?.tagId)
            fail('Conflict', 'That tag name is already used')
        const fields = {
            name: String(p.name).trim(),
            normalizedName: key,
            description: p.description || '',
            allowedCategories: JSON.stringify(allowed),
            revision: Number(tag?.revision || 0) + 1,
        }
        tag = tag
            ? update(tag, fields)
            : create(F + 'ForumTag', {
                  tagId: id(),
                  siteId: p.siteId,
                  createdAt: now(),
                  ...fields,
              })
        audit(
            p.siteId,
            null,
            'tag',
            tag.tagId,
            'store',
            p.reason || '',
            fields.revision - 1,
            fields.revision,
        )
        bump(p.siteId)
        return { tagId: tag.tagId, revision: fields.revision }
    })
/* Merging moves every topic to the target and keeps the old name as an alias, so old tag links still resolve. */
methods.mergeTag = (p) =>
    receipt(p, 'mergeTag', () => {
        site(p.siteId)
        staff(p.siteId)
        const source = one(F + 'ForumTag', { tagId: p.tagId }, true),
            target = one(F + 'ForumTag', { tagId: p.targetTagId }, true)
        if (
            !source ||
            !target ||
            source.siteId !== p.siteId ||
            target.siteId !== p.siteId ||
            source.tagId === target.tagId
        )
            missing()
        revision(source, p.expectedRevision)
        if (!p.reason) invalid('A reason is required')
        let moved = 0
        for (;;) {
            const batch = rows(
                F + 'ForumTopicTag',
                { tagId: source.tagId },
                200,
            )
            for (const tt of batch) {
                if (
                    !one(F + 'ForumTopicTag', {
                        rootCommEventId: tt.rootCommEventId,
                        tagId: target.tagId,
                    })
                )
                    create(F + 'ForumTopicTag', {
                        rootCommEventId: tt.rootCommEventId,
                        tagId: target.tagId,
                        siteId: p.siteId,
                    })
                tt.delete()
                moved++
            }
            if (batch.length < 200) break
        }
        for (const alias of rows(
            F + 'ForumTagAlias',
            { tagId: source.tagId },
            1000,
        ))
            update(alias, { tagId: target.tagId })
        create(F + 'ForumTagAlias', {
            siteId: p.siteId,
            normalizedName: source.normalizedName,
            tagId: target.tagId,
            createdAt: now(),
        })
        source.delete()
        update(target, { revision: Number(target.revision) + 1 })
        audit(
            p.siteId,
            null,
            'tag',
            target.tagId,
            'merge',
            p.reason,
            null,
            Number(target.revision),
        )
        bump(p.siteId)
        return { tagId: target.tagId, movedTopics: moved }
    })
/* The desired state for one reaction: repeating it changes nothing. Counts are kept on the post under its lock. */
methods.setReaction = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    if (!REACTIONS.includes(p.reactionKey)) invalid('Unknown reaction')
    if (typeof p.active !== 'boolean') invalid('active must be true or false')
    const st = one(
        F + 'ForumPostState',
        { communicationEventId: p.postId },
        true,
    )
    if (!st) missing()
    const { t, a } = topic(st.rootCommEventId, p.siteId, true),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!postVisible(st, event, a)) missing()
    if (!a.canReact || st.visibility !== 'approved')
        fail('Unauthorized', 'Reacting is not permitted')
    if (event.fromPartyId === partyId)
        fail('Unauthorized', 'You cannot react to your own post')
    const key = {
            communicationEventId: p.postId,
            partyId,
            reactionKey: p.reactionKey,
        },
        old = one(F + 'ForumReaction', key)
    if (!!old === p.active)
        return { reactions: json(st.reactionCounts, {}), active: p.active }
    const counts = json(st.reactionCounts, {}),
        delta = p.active ? 1 : -1
    if (p.active)
        create(F + 'ForumReaction', {
            ...key,
            rootCommEventId: st.rootCommEventId,
            createdAt: now(),
        })
    else old.delete()
    counts[p.reactionKey] = Math.max(
        0,
        Number(counts[p.reactionKey] || 0) + delta,
    )
    if (!counts[p.reactionKey]) delete counts[p.reactionKey]
    update(st, {
        reactionCounts: JSON.stringify(counts),
        reactionCount: Math.max(0, Number(st.reactionCount || 0) + delta),
    })
    update(t, {
        reactionCount: Math.max(0, Number(t.reactionCount || 0) + delta),
    })
    return { reactions: counts, active: p.active }
}
/* Q&A categories only. Accepting never closes the topic; closure stays the root's CeResolved status. */
methods.acceptAnswer = (p) => {
    requireUser()
    site(p.siteId)
    const { t, event: root, a } = topic(p.rootCommEventId, p.siteId, true)
    revision(t, p.expectedRevision)
    if (a.category.mode !== 'qa')
        invalid('Accepted answers are used in Q&A categories')
    if (!a.canModerate && !(root.fromPartyId === me() && a.canReply))
        fail(
            'Unauthorized',
            'Only the question author or a moderator accepts an answer',
        )
    if (p.postId) {
        const st = one(F + 'ForumPostState', { communicationEventId: p.postId })
        if (
            !st ||
            st.rootCommEventId !== t.rootCommEventId ||
            st.communicationEventId === t.rootCommEventId ||
            st.visibility !== 'approved'
        )
            invalid('The answer must be a visible reply in this topic')
    }
    const before = Number(t.revision)
    update(t, { acceptedAnswerId: p.postId || null, revision: before + 1 })
    audit(
        p.siteId,
        a.category.contactListId,
        'topic',
        t.rootCommEventId,
        p.postId ? 'answer-accepted' : 'answer-cleared',
        p.reason || '',
        before,
        before + 1,
    )
    bump(p.siteId)
    return { acceptedAnswerId: p.postId || null, revision: before + 1 }
}
function validPoll(poll) {
    if (!poll || typeof poll !== 'object' || Array.isArray(poll))
        invalid('Invalid poll')
    const options = poll.options
    if (
        !poll.question ||
        String(poll.question).length > 250 ||
        !Array.isArray(options) ||
        options.length < 2 ||
        options.length > 20 ||
        options.some(
            (o) => typeof o !== 'string' || !o.trim() || o.length > 200,
        ) ||
        new Set(options.map((o) => o.trim().toLowerCase())).size !==
            options.length
    )
        invalid('A poll needs a question and 2–20 distinct choices')
    const maxChoices = Number(poll.maxChoices || 1)
    if (
        !Number.isInteger(maxChoices) ||
        maxChoices < 1 ||
        maxChoices > options.length
    )
        invalid('Invalid number of choices')
    if (!['always', 'voted', 'closed'].includes(poll.resultsPolicy || 'voted'))
        invalid('Invalid results policy')
    if (poll.closesAt != null && !(millis(poll.closesAt) > millis(now())))
        invalid('A poll closes in the future')
    return {
        question: String(poll.question),
        options: options.map((o) => o.trim()),
        maxChoices,
        closesAt: poll.closesAt ?? null,
        resultsPolicy: poll.resultsPolicy || 'voted',
        revealVoters: poll.revealVoters === true,
        allowChange: poll.allowChange !== false,
    }
}
function createPoll(siteId, root, postId, input) {
    const poll = validPoll(input),
        pollId = id()
    create(F + 'ForumPoll', {
        pollId,
        siteId,
        communicationEventId: postId,
        rootCommEventId: root,
        question: poll.question,
        maxChoices: poll.maxChoices,
        closesAt: poll.closesAt,
        resultsPolicy: poll.resultsPolicy,
        revealVoters: poll.revealVoters ? 'Y' : 'N',
        allowChange: poll.allowChange ? 'Y' : 'N',
        voterCount: 0,
        revision: 1,
    })
    poll.options.forEach((label, index) =>
        create(F + 'ForumPollOption', {
            pollId,
            optionId: String(index + 1),
            sequenceNum: index + 1,
            label,
            voteCount: 0,
        }),
    )
    return pollId
}
function pollAccess(p, lock) {
    const poll = one(F + 'ForumPoll', { pollId: p.pollId }, lock)
    if (!poll || poll.siteId !== p.siteId) missing()
    const st = one(F + 'ForumPostState', {
            communicationEventId: poll.communicationEventId,
        }),
        { a } = topic(poll.rootCommEventId, p.siteId),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: poll.communicationEventId,
        })
    if (!st || !postVisible(st, event, a) || st.visibility === 'deleted')
        missing()
    return { poll, a, approved: st.visibility === 'approved' }
}
methods.getPoll = (p) => {
    const { poll, a, approved } = pollAccess(p)
    const partyId = me(),
        mine = partyId
            ? rows(
                  F + 'ForumPollVote',
                  { pollId: poll.pollId, partyId },
                  20,
              ).map((v) => v.optionId)
            : [],
        closed = !!poll.closesAt && millis(poll.closesAt) <= millis(now())
    const showResults =
        poll.resultsPolicy === 'always' ||
        closed ||
        (poll.resultsPolicy === 'voted' && mine.length > 0) ||
        a.canModerate
    const options = Array.from(
        find(F + 'ForumPollOption', { pollId: poll.pollId })
            .orderBy('sequenceNum')
            .list(),
    ).map((o) => ({
        optionId: o.optionId,
        label: o.label,
        voteCount: showResults ? Number(o.voteCount || 0) : null,
        voters:
            showResults && poll.revealVoters === 'Y'
                ? rows(
                      F + 'ForumPollVote',
                      { pollId: poll.pollId, optionId: o.optionId },
                      100,
                  )
                      .map(
                          (v) =>
                              one(S + 'PublicSiteProfile', {
                                  siteId: p.siteId,
                                  partyId: v.partyId,
                              })?.handle,
                      )
                      .filter(Boolean)
                : null,
    }))
    return {
        poll: {
            ...pick(
                poll,
                'pollId question maxChoices closesAt resultsPolicy revealVoters allowChange revision',
            ),
            postId: poll.communicationEventId,
            voterCount: showResults ? Number(poll.voterCount || 0) : null,
            closed,
            myChoices: mine,
            options,
            canVote:
                approved &&
                a.canVote &&
                !closed &&
                (!mine.length || poll.allowChange === 'Y'),
        },
    }
}
/* One ballot per party, replaced whole under the poll lock; choices are fixed once the poll exists. */
methods.votePoll = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    const { poll, a, approved } = pollAccess(p, true)
    if (!approved || !a.canVote) fail('Unauthorized', 'Voting is not permitted')
    if (poll.closesAt && millis(poll.closesAt) <= millis(now()))
        fail('Conflict', 'This poll is closed')
    const choices = [...new Set(p.optionIds || [])]
    if (!choices.length || choices.length > Number(poll.maxChoices))
        invalid('Choose from 1 to ' + poll.maxChoices + ' options')
    const options = new Map(
        rows(F + 'ForumPollOption', { pollId: poll.pollId }, 20).map((o) => [
            o.optionId,
            o,
        ]),
    )
    if (choices.some((c) => !options.has(c))) invalid('Unknown choice')
    const old = rows(F + 'ForumPollVote', { pollId: poll.pollId, partyId }, 20)
    if (old.length && poll.allowChange !== 'Y')
        fail('Conflict', 'Votes in this poll cannot be changed')
    for (const v of old) {
        const o = options.get(v.optionId)
        update(o, { voteCount: Math.max(0, Number(o.voteCount || 0) - 1) })
        v.delete()
    }
    for (const optionId of choices) {
        const o = options.get(optionId)
        update(o, { voteCount: Number(o.voteCount || 0) + 1 })
        create(F + 'ForumPollVote', {
            pollId: poll.pollId,
            partyId,
            optionId,
            votedAt: now(),
        })
    }
    update(poll, {
        voterCount: Number(poll.voterCount || 0) + (old.length ? 0 : 1),
        revision: Number(poll.revision) + 1,
    })
    return methods.getPoll({ siteId: p.siteId, pollId: poll.pollId })
}
/* Bookmarks are personal and never reveal a target the owner can no longer read. */
function bookmarkTarget(siteId, postId) {
    const st = one(F + 'ForumPostState', { communicationEventId: postId })
    if (!st) missing()
    const { event: root, a } = topic(st.rootCommEventId, siteId),
        event = one(E + 'CommunicationEvent', { communicationEventId: postId })
    if (!postVisible(st, event, a) || st.visibility === 'deleted') missing()
    return { st, root }
}
methods.storeBookmark = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    if (p.note != null && p.note.length > 1000)
        invalid('A note has at most 1000 characters')
    if (p.remindAt != null && !(millis(p.remindAt) > millis(now())))
        invalid('A reminder is in the future')
    let b = p.bookmarkId
        ? one(F + 'ForumBookmark', { bookmarkId: p.bookmarkId }, true)
        : one(
              F + 'ForumBookmark',
              { partyId, communicationEventId: p.postId },
              true,
          )
    if (b && (b.partyId !== partyId || b.siteId !== p.siteId)) missing()
    const postId = b?.communicationEventId || p.postId
    if (!postId) invalid('A post is required')
    const { st } = bookmarkTarget(p.siteId, postId)
    if (b) revision(b, p.expectedRevision)
    else if (Number(p.expectedRevision || 0) !== 0)
        fail('Conflict', 'Bookmark changed; reload')
    const fields = {
        note: p.note ?? b?.note ?? '',
        remindAt: p.remindAt ?? null,
        remindedAt: null,
        revision: Number(b?.revision || 0) + 1,
    }
    b = b
        ? update(b, fields)
        : create(F + 'ForumBookmark', {
              bookmarkId: id(),
              siteId: p.siteId,
              partyId,
              rootCommEventId: st.rootCommEventId,
              communicationEventId: postId,
              createdAt: now(),
              ...fields,
          })
    return { bookmarkId: b.bookmarkId, revision: fields.revision }
}
methods.removeBookmark = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    const b = one(F + 'ForumBookmark', { bookmarkId: p.bookmarkId })
    if (!b || b.partyId !== partyId || b.siteId !== p.siteId) missing()
    b.delete()
    return { removed: true }
}
methods.findBookmarks = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        const partyId = requireUser(),
            pg = page(p, 'bookmarks:' + p.siteId)
        const list = Array.from(
            find(F + 'ForumBookmark', { siteId: p.siteId, partyId })
                .orderBy('-createdAt,bookmarkId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        return {
            bookmarkList: list.slice(0, pg.limit).map((b) => {
                const base = pick(
                    b,
                    'bookmarkId note remindAt createdAt revision',
                )
                try {
                    const { root } = bookmarkTarget(
                        p.siteId,
                        b.communicationEventId,
                    )
                    return {
                        ...base,
                        postId: b.communicationEventId,
                        rootCommEventId: b.rootCommEventId,
                        title: root.subject,
                    }
                } catch (e) {
                    if (e.moquiErrorKind !== 'NotFound') throw e
                    return {
                        ...base,
                        unavailable: true,
                        title: 'Unavailable post',
                    }
                }
            }),
            nextCursor:
                list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        }
    })
/* Worker: one in-app notice per due reminder, each in its own transaction so one bad row does not stop the rest. */
function remindBookmarks() {
    let sent = 0,
        failed = 0
    for (const b of Array.from(
        find(F + 'ForumBookmark', { remindedAt: null })
            .condition('remindAt', 'less-equals', now())
            .orderBy('remindAt')
            .limit(200)
            .list(),
    ))
        try {
            ec.service
                .sync()
                .requireNewTransaction(true)
                .throwOnError(true)
                .name('mantle.forum.ForumServices.remind#Bookmark')
                .parameters({ bookmarkId: b.bookmarkId })
                .call()
            sent++
        } catch (e) {
            failed++
            ec.logger.error(
                'Bookmark reminder ' +
                    b.bookmarkId +
                    ' failed: ' +
                    String(e?.message || e).split('\n')[0],
            )
        }
    return { sent, failed }
}
function remindBookmark(bookmarkId) {
    const b = one(F + 'ForumBookmark', { bookmarkId }, true)
    if (!b || b.remindedAt || !b.remindAt) return { sent: false }
    update(b, { remindedAt: now() })
    // The reminder notice resolves its post again when listed, so a lost permission hides it.
    const outboxId = id()
    create(F + 'ForumOutbox', {
        outboxId,
        siteId: b.siteId,
        communicationEventId: b.communicationEventId,
        eventType: 'reminder',
        state: 'complete',
        createdAt: now(),
    })
    create(F + 'ForumDelivery', {
        deliveryId: id(),
        revision: 1,
        outboxId,
        siteId: b.siteId,
        partyId: b.partyId,
        channel: 'in-app',
        state: 'sent',
        attempts: 1,
        dueAt: now(),
    })
    return { sent: true }
}
/* History follows current access: staff and the author see every revision, other readers the public ones. */
function historyAccess(p) {
    const st = one(F + 'ForumPostState', { communicationEventId: p.postId })
    if (!st) missing()
    const { a } = topic(st.rootCommEventId, p.siteId),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!postVisible(st, event, a) || st.visibility === 'deleted') missing()
    const all = a.canModerate || event.fromPartyId === me()
    const permitted = (r) => all || r.publicHistoryAllowed === 'Y'
    return { st, event, a, permitted }
}
const revisionText = (html) =>
    String(html || '')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>|<br\s*\/?>/gi, '\n')
        .split('\n')
        .map(plainText)
        .filter((line) => line)
        .join('\n') + '\n'
methods.getPostHistory = (p) => {
    const { st, event, permitted } = historyAccess(p)
    const list = Array.from(
        find(F + 'ForumPostRevision', { communicationEventId: p.postId })
            .orderBy('-revision')
            .limit(200)
            .list(),
    )
        .filter(permitted)
        .map((r) => {
            const editor = one(S + 'PublicSiteProfile', {
                siteId: p.siteId,
                partyId: r.editorPartyId,
            })
            return {
                ...pick(r, 'revision editedAt reason'),
                editor: pick(editor, 'handle displayName'),
                current: Number(r.revision) === Number(st.revision),
            }
        })
    return {
        postId: p.postId,
        rootCommEventId: st.rootCommEventId,
        revision: Number(st.revision),
        canRestore: canEditPost(st, event, historyAccess(p).a),
        revisionList: list,
    }
}
methods.comparePostRevisions = (p) => {
    const { permitted } = historyAccess(p)
    const load = (n) => {
        const r = one(F + 'ForumPostRevision', {
            communicationEventId: p.postId,
            revision: Number(n),
        })
        if (!r || !permitted(r)) missing()
        return r
    }
    const from = load(p.fromRevision),
        to = load(p.toRevision)
    const diff = ec.resource.textDiff(
        revisionText(from.sanitizedBody),
        revisionText(to.sanitizedBody),
        'Revision ' + from.revision,
        'Revision ' + to.revision,
    )
    return {
        diff: {
            html: diff.html,
            unifiedDiff: diff.unifiedDiff,
            stats: diff.stats,
            fromRevision: Number(from.revision),
            toRevision: Number(to.revision),
        },
    }
}
/* Restoring writes a new revision through the normal edit path, so sanitizing, review and conflicts all apply. */
methods.restorePostRevision = (p) => {
    requireUser()
    const { permitted } = historyAccess(p)
    const r = one(F + 'ForumPostRevision', {
        communicationEventId: p.postId,
        revision: Number(p.revision),
    })
    if (!r || !permitted(r)) missing()
    return methods.updatePost({
        siteId: p.siteId,
        postId: p.postId,
        body: r.sourceText || r.sanitizedBody,
        expectedRevision: p.expectedRevision,
        reason: p.reason || 'Restored revision ' + r.revision,
    })
}
/* Soft delete keeps the post row and its ordinal; replies that depend on it keep the author from removing it. */
function softDelete(st, event, t, a, reason) {
    if (st.communicationEventId === t.rootCommEventId)
        invalid('Delete a whole topic through moderation')
    const wasVisible = st.visibility === 'approved'
    update(st, {
        visibility: 'deleted',
        deletedAt: now(),
        deletedByPartyId: me(),
        deleteReason: reason || '',
        revision: Number(st.revision) + 1,
        approvedRevision: null,
    })
    update(t, {
        visiblePostCount: wasVisible
            ? Math.max(0, Number(t.visiblePostCount) - 1)
            : Number(t.visiblePostCount),
        reactionCount: Math.max(
            0,
            Number(t.reactionCount || 0) - Number(st.reactionCount || 0),
        ),
        revision: Number(t.revision) + 1,
    })
    clearAnswer(t, a, st.communicationEventId, reason || 'Answer deleted')
    refreshReviews(t.siteId, st.communicationEventId, Number(st.revision))
}
methods.deletePost = (p) => {
    requireUser()
    site(p.siteId)
    const st = one(
        F + 'ForumPostState',
        { communicationEventId: p.postId },
        true,
    )
    if (!st) missing()
    const { t, a } = topic(st.rootCommEventId, p.siteId, true),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!postVisible(st, event, a) || st.visibility === 'deleted') missing()
    revision(st, p.expectedRevision)
    const author =
        event.fromPartyId === me() &&
        millis(now()) - millis(event.entryDate) <= editWindowMs(p.siteId)
    if (!a.canModerate && !author)
        fail('Unauthorized', 'Ask a moderator to remove this post')
    if (a.canModerate && event.fromPartyId !== me() && !p.reason)
        invalid('Staff deletions require a reason')
    if (
        !a.canModerate &&
        find(F + 'ForumPostSearch', {
            rootCommEventId: st.rootCommEventId,
            parentCommEventId: p.postId,
        })
            .condition('visibility', 'in', ['approved', 'pending'])
            .count() > 0
    )
        fail(
            'Conflict',
            'Replies depend on this post; ask a moderator to remove it',
        )
    softDelete(st, event, t, a, p.reason)
    if (a.canModerate)
        audit(
            p.siteId,
            a.category.contactListId,
            'post',
            p.postId,
            'delete',
            p.reason || '',
            Number(st.revision) - 1,
            Number(st.revision),
        )
    bump(p.siteId)
    return { postId: p.postId, revision: Number(st.revision), state: 'deleted' }
}
/* ---- Stage 2 moderation: versioned policy, trust, content rules, flag hiding, classifier, topic tools, timers ---- */
/* Numeric settings are [default, minimum, maximum]. Owners may be stricter than a default, never laxer. */
const POLICY_NUMBERS = {
    firstContributionCount: [2, 2, 20],
    postIntervalSeconds: [10, 10, 86400],
    editWindowHours: [24, 0, 24],
    maxPostLength: [100000, 1000, 100000],
    slowModeSeconds: [0, 0, 86400],
    basicTopicsEntered: [5, 5, 10000],
    basicPostsRead: [20, 20, 100000],
    basicReadingMinutes: [10, 10, 100000],
    basicVisitDays: [2, 2, 1000],
    memberVisitDays: [15, 15, 1000],
    memberTopicsEntered: [20, 20, 10000],
    memberPostsRead: [100, 100, 100000],
    memberReadingMinutes: [60, 60, 100000],
    regularVisitDays: [50, 50, 1000],
    regularTopicsEntered: [100, 100, 10000],
    regularPostsRead: [500, 500, 100000],
    regularApprovedContributions: [10, 10, 10000],
    abuseFreeDays: [30, 30, 365],
    flagHideCount: [3, 2, 10],
    privateRecipientLimit: [10, 1, 10],
    mediaMaxBytes: [10485760, 1024, 10485760],
    mediaFilesPerPost: [10, 0, 10],
}
const POLICY_FLAGS = {
    classifierEnabled: false,
    privateEnabled: true,
    privateExistingReplies: true,
    privateFullBodyEmail: false,
}
const POLICY_CHOICES = {
    privateMinTrust: ['basic', ['new', 'basic', 'member', 'regular']],
}
const TRUST_ORDER = ['new', 'basic', 'member', 'regular']
const TRUST_EFFECTS = {
    new: { topics: 3, replies: 10, links: 2, images: 1, mentions: 2 },
    basic: { topics: 10, replies: 50, links: 10, images: 10, mentions: 5 },
    member: { topics: 20, replies: 100, links: 20, images: 20, mentions: 10 },
    regular: { topics: 20, replies: 100, links: 20, images: 20, mentions: 10 },
}
const trustRank = (level) => Math.max(0, TRUST_ORDER.indexOf(level))
function policy(siteId) {
    const v = Array.from(
        find(F + 'ForumPolicy', { siteId })
            .orderBy('-policyRevision')
            .limit(1)
            .list(),
    )[0]
    const out = {
        ...Object.fromEntries(
            Object.entries(POLICY_NUMBERS).map(([k, [d]]) => [k, d]),
        ),
        ...POLICY_FLAGS,
        ...Object.fromEntries(
            Object.entries(POLICY_CHOICES).map(([k, [d]]) => [k, d]),
        ),
    }
    return Object.assign(out, json(v?.config, {}))
}
function validPolicy(config) {
    for (const [k, v] of Object.entries(config)) {
        if (POLICY_NUMBERS[k]) {
            const [, min, max] = POLICY_NUMBERS[k]
            if (!Number.isInteger(v) || v < min || v > max)
                invalid(k + ' must be ' + min + '–' + max)
        } else if (k in POLICY_FLAGS) {
            if (typeof v !== 'boolean') invalid(k + ' must be true or false')
        } else if (POLICY_CHOICES[k]) {
            if (!POLICY_CHOICES[k][1].includes(v)) invalid('Invalid ' + k)
        } else invalid('Unsupported policy: ' + k)
    }
}
const editWindowMs = (siteId) => policy(siteId).editWindowHours * 3600000
const mentionHandles = (html) => [
    ...new Set(
        Array.from(
            plainText(html).matchAll(/(?:^|[^\w@.])@([A-Za-z0-9_.-]{2,40})/g),
        ).map((m) => m[1].toLowerCase()),
    ),
]
/* ---- Content rules ---- */
const escapeRegex = (text) =>
    String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function validRule(type, pattern) {
    if (!['word', 'regex', 'link'].includes(type)) invalid('Invalid rule type')
    if (!pattern || String(pattern).length > 200)
        invalid('A pattern of 1–200 characters is required')
    if (type === 'regex') {
        // Patterns run on every post: refuse nested quantifiers and back references that can backtrack badly.
        if (
            /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern) ||
            /\\[1-9]/.test(pattern)
        )
            invalid('Nested repetition and back references are not allowed')
        try {
            new RegExp(pattern, 'i')
        } catch (e) {
            invalid('Invalid pattern')
        }
    }
}
function ruleRegex(r) {
    if (r.ruleType === 'regex') return new RegExp(r.pattern, 'i')
    if (r.ruleType === 'link')
        return new RegExp(
            '(?:https?://|www\\.)(?:[^\\s/"\'<>]*\\.)?' +
                escapeRegex(r.pattern),
            'i',
        )
    return new RegExp('\\b' + escapeRegex(r.pattern) + '\\b', 'i')
}
/* Censoring masks matched text outside tags; the author's original stays in the revision source for staff. */
function censor(html, re) {
    const global = new RegExp(re.source, re.flags.replace('g', '') + 'g')
    return String(html)
        .split(/(<[^>]*>)/)
        .map((part) =>
            part.startsWith('<')
                ? part
                : part.replace(global, (m) => '■'.repeat(m.length)),
        )
        .join('')
}
function applyRules(siteId, contactListId, html) {
    const text = plainText(html) + ' ' + String(html),
        out = { block: null, approve: false, flag: false, body: html }
    for (const r of Array.from(
        find(F + 'ForumRule', { siteId, enabled: 'Y' })
            .orderBy('priority,ruleId')
            .limit(200)
            .list(),
    )) {
        if (r.contactListId && r.contactListId !== contactListId) continue
        let re
        try {
            re = ruleRegex(r)
        } catch (e) {
            ec.logger.error('Forum rule ' + r.ruleId + ' is invalid; skipped')
            continue
        }
        if (!re.test(r.action === 'censor' ? plainText(out.body) : text))
            continue
        if (r.action === 'block') out.block = r
        else if (r.action === 'approve') out.approve = true
        else if (r.action === 'flag') out.flag = true
        else if (r.action === 'censor') out.body = censor(out.body, re)
    }
    return out
}
methods.storeRule = (p) =>
    receipt(p, 'storeRule', () => {
        site(p.siteId, true)
        validRule(p.ruleType, p.pattern)
        if (!['block', 'approve', 'flag', 'censor'].includes(p.action))
            invalid('Invalid rule action')
        if (p.contactListId) category(p.contactListId, p.siteId)
        let r = p.ruleId
            ? one(F + 'ForumRule', { ruleId: p.ruleId }, true)
            : null
        if (p.ruleId && (!r || r.siteId !== p.siteId)) missing()
        if (r) revision(r, p.expectedRevision)
        const fields = {
            contactListId: p.contactListId || null,
            ruleType: p.ruleType,
            pattern: p.pattern,
            action: p.action,
            enabled: p.active === false ? 'N' : 'Y',
            priority: Number(p.sequenceNum || 0),
            revision: Number(r?.revision || 0) + 1,
        }
        r = r
            ? update(r, fields)
            : create(F + 'ForumRule', {
                  ruleId: id(),
                  siteId: p.siteId,
                  createdAt: now(),
                  ...fields,
              })
        audit(
            p.siteId,
            fields.contactListId,
            'rule',
            r.ruleId,
            'store',
            p.reason || '',
            fields.revision - 1,
            fields.revision,
        )
        return { ruleId: r.ruleId, revision: fields.revision }
    })
methods.findRules = (p) => {
    site(p.siteId, true)
    return {
        ruleList: Array.from(
            find(F + 'ForumRule', { siteId: p.siteId })
                .orderBy('priority,ruleId')
                .limit(200)
                .list(),
        ).map((r) =>
            pick(
                r,
                'ruleId contactListId ruleType pattern action enabled priority revision',
            ),
        ),
    }
}
/* A bounded test against sample text: what each action would do, with no post written. */
methods.testRule = (p) => {
    site(p.siteId, true)
    validRule(p.ruleType, p.pattern)
    if (String(p.body || '').length > 10000)
        invalid('Sample text is limited to 10000 characters')
    const re = ruleRegex({ ruleType: p.ruleType, pattern: p.pattern })
    const sample = String(p.body || '')
    return {
        matched: re.test(sample),
        censored: censor(WebUtilities.encodeHtml(sample), re),
    }
}
/* ---- Trust ---- */
function memberStateFor(siteId, partyId) {
    const key = { siteId, partyId }
    return (
        one(F + 'ForumMemberState', key, true) ||
        create(F + 'ForumMemberState', {
            ...key,
            trustLevel: 'new',
            approvedContributions: 0,
            dailyTopics: 0,
            dailyReplies: 0,
            revision: 1,
        })
    )
}
/* Reading telemetry is measured on the server from the reader's own position updates, never from client counters. */
function recordReading(siteId, partyId, newlyRead, firstVisit) {
    const m = memberStateFor(siteId, partyId),
        day = String(now()).slice(0, 10),
        gap = m.lastReadAt ? millis(now()) - millis(m.lastReadAt) : 0
    update(m, {
        postsRead: Number(m.postsRead || 0) + Math.min(100, newlyRead),
        topicsEntered: Number(m.topicsEntered || 0) + (firstVisit ? 1 : 0),
        readingSeconds:
            Number(m.readingSeconds || 0) +
            (gap > 0 && gap < 300000
                ? Math.min(60, Math.floor(gap / 1000))
                : 0),
        visitDays: Number(m.visitDays || 0) + (m.lastVisitDay === day ? 0 : 1),
        lastVisitDay: day,
        lastReadAt: now(),
    })
}
function earnedTrust(m, pol) {
    const entered = Number(m.topicsEntered || 0),
        read = Number(m.postsRead || 0),
        minutes = Number(m.readingSeconds || 0) / 60,
        days = Number(m.visitDays || 0)
    if (!(
        entered >= pol.basicTopicsEntered &&
        read >= pol.basicPostsRead &&
        minutes >= pol.basicReadingMinutes &&
        days >= pol.basicVisitDays
    ))
        return 'new'
    if (!(
        days >= pol.memberVisitDays &&
        entered >= pol.memberTopicsEntered &&
        read >= pol.memberPostsRead &&
        minutes >= pol.memberReadingMinutes
    ))
        return 'basic'
    if (!(
        days >= pol.regularVisitDays &&
        entered >= pol.regularTopicsEntered &&
        read >= pol.regularPostsRead &&
        Number(m.approvedContributions || 0) >= pol.regularApprovedContributions
    ))
        return 'member'
    return 'regular'
}
/* Worker step: promotion only, never past an owner lock or a recent sanction. Trust grants no staff authority. */
function recomputeMemberTrust(siteId, partyId) {
    const m = one(F + 'ForumMemberState', { siteId, partyId }, true)
    if (!m || m.trustLocked === 'Y') return { changed: false }
    const pol = policy(siteId)
    if (
        find(F + 'ForumSanction', { siteId, partyId })
            .condition(
                'fromDate',
                'greater-equals',
                stamp(millis(now()) - pol.abuseFreeDays * 86400000),
            )
            .count() > 0
    )
        return { changed: false }
    const earned = earnedTrust(m, pol)
    if (trustRank(earned) <= trustRank(m.trustLevel)) return { changed: false }
    update(m, {
        trustLevel: earned,
        trustSetAt: now(),
        revision: Number(m.revision) + 1,
    })
    return { changed: true, trustLevel: earned }
}
function recomputeTrust() {
    const run =
        one(F + 'ForumJobRun', { runId: 'TRUST_SCAN' }, true) ||
        create(F + 'ForumJobRun', {
            runId: 'TRUST_SCAN',
            jobType: 'trust',
            state: 'running',
            checkpoint: '',
            createdAt: now(),
            successCount: 0,
            failedCount: 0,
        })
    const [afterSite, afterParty] = String(run.checkpoint || '|').split('|')
    const cf = ec.entity.conditionFactory
    let q = find(F + 'ForumMemberState', {})
    if (afterSite)
        q = q.condition(
            cf.makeCondition(
                [
                    cf.makeCondition('siteId', 'greater', afterSite),
                    cf.makeCondition(
                        [
                            cf.makeCondition('siteId', 'equals', afterSite),
                            cf.makeCondition('partyId', 'greater', afterParty),
                        ],
                        'and',
                    ),
                ],
                'or',
            ),
        )
    const batch = Array.from(q.orderBy('siteId,partyId').limit(500).list())
    let changed = 0,
        failed = 0
    for (const m of batch)
        try {
            if (
                ec.service
                    .sync()
                    .requireNewTransaction(true)
                    .throwOnError(true)
                    .name(
                        'mantle.forum.ModerationWorkerServices.recompute#MemberTrust',
                    )
                    .parameters({ siteId: m.siteId, partyId: m.partyId })
                    .call().result.changed
            )
                changed++
        } catch (e) {
            ec.message.clearErrors()
            failed++
            ec.logger.error(
                'Trust recompute for ' +
                    m.siteId +
                    '/' +
                    m.partyId +
                    ' failed: ' +
                    String(e?.message || e).split('\n')[0],
            )
        }
    const last = batch[batch.length - 1]
    update(run, {
        checkpoint: batch.length < 500 ? '' : last.siteId + '|' + last.partyId,
        successCount: Number(run.successCount || 0) + batch.length - failed,
        failedCount: Number(run.failedCount || 0) + failed,
    })
    return { inspected: batch.length, changed, failed }
}
methods.setTrust = (p) => {
    site(p.siteId, true)
    if (!TRUST_ORDER.includes(p.trustLevel)) invalid('Invalid trust level')
    if (!p.reason) invalid('A reason is required')
    if (!member(p.siteId, p.targetPartyId)) missing()
    const m = memberStateFor(p.siteId, p.targetPartyId)
    revision(m, p.expectedRevision)
    const before = Number(m.revision)
    update(m, {
        trustLevel: p.trustLevel,
        trustLocked: p.locked === true ? 'Y' : 'N',
        trustReason: p.reason,
        trustSetAt: now(),
        revision: before + 1,
    })
    audit(
        p.siteId,
        null,
        'member',
        p.targetPartyId,
        'trust-' + p.trustLevel + (p.locked === true ? '-locked' : ''),
        p.reason,
        before,
        before + 1,
    )
    return { trustLevel: p.trustLevel, revision: before + 1 }
}
/* ---- Flag hiding and automatic review ---- */
function systemAudit(
    siteId,
    contactListId,
    targetType,
    targetId,
    action,
    reason,
    staffPartyId,
) {
    create(F + 'ForumModerationAction', {
        actionId: id(),
        siteId,
        contactListId,
        staffPartyId: staffPartyId || null,
        targetType,
        targetId,
        action,
        reason: reason || '',
        createdAt: now(),
    })
}
/* Enough distinct basic-or-higher reporters hide a post until staff decide; the author's own and repeat reports do not count. */
function hideIfFlagged(siteId, st, event, reviewId) {
    if (st.visibility !== 'approved') return false
    const pol = policy(siteId)
    const reporters = rows(F + 'ForumReviewReport', { reviewId }, 100).filter(
        (r) =>
            r.reporterPartyId !== event.fromPartyId &&
            trustRank(trustLevel(siteId, r.reporterPartyId)) >= 1 &&
            !memberBlocks(siteId, event.fromPartyId, r.reporterPartyId),
    )
    if (reporters.length < pol.flagHideCount) return false
    const t = one(
        F + 'ForumTopic',
        { rootCommEventId: st.rootCommEventId },
        true,
    )
    update(st, { visibility: 'hidden' })
    if (st.communicationEventId !== t.rootCommEventId)
        update(t, {
            visiblePostCount: Math.max(0, Number(t.visiblePostCount) - 1),
            revision: Number(t.revision) + 1,
        })
    if (t.acceptedAnswerId === st.communicationEventId)
        update(t, { acceptedAnswerId: null })
    systemAudit(
        siteId,
        event.contactListId,
        'post',
        st.communicationEventId,
        'auto-hide',
        reporters.length + ' community reports',
    )
    bump(siteId)
    return true
}
/* Classification is queued with the post and runs after commit; an unavailable classifier only delays review. */
function queueClassification(siteId, postId) {
    if (!policy(siteId).classifierEnabled) return
    create(F + 'ForumOutbox', {
        outboxId: id(),
        siteId,
        communicationEventId: postId,
        eventType: 'classify',
        state: 'classify',
        cursor: '0',
        createdAt: now(),
    })
}
function classifyPost(outboxId) {
    const box = one(F + 'ForumOutbox', { outboxId }, true)
    if (!box || box.state !== 'classify') return { classified: false }
    const service = System.getProperty('pass_classifier_service')
    const st = one(F + 'ForumPostState', {
            communicationEventId: box.communicationEventId,
        }),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: box.communicationEventId,
        })
    if (!service || !st || !event || st.visibility === 'deleted') {
        update(box, { state: 'complete' })
        return { classified: false }
    }
    let result
    try {
        // Its own transaction, so a failing classifier cannot roll back this queue item's bookkeeping.
        result = ec.service
            .sync()
            .requireNewTransaction(true)
            .throwOnError(true)
            .name(service)
            .parameters({
                siteId: box.siteId,
                postId: box.communicationEventId,
                revision: Number(st.revision),
                text: plainText(event.body),
            })
            .call()
    } catch (e) {
        ec.message.clearErrors()
        const attempts = Number(box.cursor || 0) + 1
        update(box, {
            cursor: String(attempts),
            state: attempts >= 3 ? 'failed' : 'classify',
        })
        ec.logger.error(
            'Forum classifier for post ' +
                box.communicationEventId +
                ' failed (attempt ' +
                attempts +
                '): ' +
                String(e?.message || e).split('\n')[0],
        )
        return { classified: false }
    }
    if (result?.decision === 'review') {
        const r = review(
            box.siteId,
            event.contactListId,
            'post',
            box.communicationEventId,
            Number(st.revision),
            'classifier',
        )
        update(r, {
            detail: JSON.stringify({
                model: String(result.model || ''),
                version: String(result.version || ''),
                reason: String(result.reason || '').slice(0, 1000),
            }),
        })
    }
    update(box, { state: 'complete' })
    return { classified: true, decision: result?.decision || 'none' }
}
function classifyPosts() {
    let done = 0,
        failed = 0
    for (const box of Array.from(
        find(F + 'ForumOutbox', { state: 'classify' })
            .orderBy('createdAt,outboxId')
            .limit(100)
            .list(),
    ))
        try {
            ec.service
                .sync()
                .requireNewTransaction(true)
                .throwOnError(true)
                .name('mantle.forum.ModerationWorkerServices.classify#Post')
                .parameters({ outboxId: box.outboxId })
                .call()
            done++
        } catch (e) {
            ec.message.clearErrors()
            failed++
            ec.logger.error(
                'Forum classification ' +
                    box.outboxId +
                    ' failed: ' +
                    String(e?.message || e).split('\n')[0],
            )
        }
    return { done, failed }
}
/* ---- Bulk decisions and appeals ---- */
methods.decideReviews = (p) => {
    requireUser()
    site(p.siteId)
    if (!Array.isArray(p.reviewIds) || !p.reviewIds.length)
        invalid('Select at least one review')
    const results = []
    for (const reviewId of p.reviewIds) {
        // Each decision is its own transaction with its own checks; one refusal does not undo the others.
        try {
            const r = one(F + 'ForumReviewItem', { reviewId, siteId: p.siteId })
            if (!r) missing()
            const out = ec.service
                .sync()
                .requireNewTransaction(true)
                .throwOnError(true)
                .name('mantle.forum.ModerationServices.decide#Review')
                .parameters({
                    input: {
                        siteId: p.siteId,
                        reviewId,
                        decision: p.decision,
                        reason: p.reason,
                        expectedRevision: Number(r.revision),
                    },
                })
                .call().result
            results.push({ reviewId, ok: true, state: out.state })
        } catch (e) {
            ec.message.clearErrors()
            results.push({
                reviewId,
                ok: false,
                error: String(e?.message || e)
                    .split('\n')[0]
                    .replace(/^(Error: )+/, ''),
            })
        }
    }
    return { results }
}
/* An author appeals a rejection with a new linked review item; the decision itself is never reopened. */
methods.appealReview = (p) =>
    receipt(p, 'appealReview', () => {
        site(p.siteId)
        const r = one(F + 'ForumReviewItem', {
            reviewId: p.reviewId,
            siteId: p.siteId,
        })
        if (!r || r.targetType !== 'post') missing()
        const event = one(E + 'CommunicationEvent', {
            communicationEventId: r.targetId,
        })
        if (!event || event.fromPartyId !== me()) missing()
        if (r.state !== 'rejected')
            fail('Conflict', 'Only a rejected decision can be appealed')
        if (!p.reason || p.reason.length > 2000)
            invalid('An appeal reason of at most 2000 characters is required')
        const appeal = review(
            p.siteId,
            r.contactListId,
            'post',
            r.targetId,
            r.targetRevision,
            'appeal',
        )
        update(appeal, { linkedReviewId: r.reviewId, detail: p.reason })
        return { reviewId: appeal.reviewId, state: appeal.state }
    })
/* The actor's own removed posts with the safe staff reason, so an author can understand and appeal a decision. */
methods.findMyReviews = (p) => {
    site(p.siteId)
    const partyId = requireUser()
    const list = []
    for (const st of Array.from(
        find(F + 'ForumPostSearch', {
            siteId: p.siteId,
            fromPartyId: partyId,
            visibility: 'rejected',
        })
            .orderBy('-entryDate')
            .limit(50)
            .list(),
    )) {
        const decided = Array.from(
            find(F + 'ForumReviewItem', {
                siteId: p.siteId,
                targetType: 'post',
                targetId: st.communicationEventId,
            })
                .orderBy('-createdAt')
                .limit(5)
                .list(),
        )
        const rejected = decided.find((r) => r.state === 'rejected')
        if (!rejected) continue
        const appeal = decided.find(
            (r) =>
                r.reasonFamily === 'appeal' &&
                r.linkedReviewId === rejected.reviewId,
        )
        list.push({
            reviewId: rejected.reviewId,
            postId: st.communicationEventId,
            title: st.subject,
            decisionReason: rejected.decisionReason,
            appealState: appeal?.state || null,
        })
    }
    return { reviewList: list }
}
/* ---- Topic tools: selection, relocation and timers ---- */
const TIMER_ACTIONS = ['close', 'reopen', 'unpin', 'list', 'unlist']
/* A moved post takes its whole reply subtree, so no reply is left pointing into another thread. */
function selection(t, postIds) {
    if (!Array.isArray(postIds) || !postIds.length || postIds.length > 100)
        invalid('Select 1–100 posts')
    const picked = new Set(),
        queue = [...postIds]
    while (queue.length) {
        const postId = queue.shift()
        if (picked.has(postId)) continue
        const st = one(F + 'ForumPostState', { communicationEventId: postId })
        if (!st || st.rootCommEventId !== t.rootCommEventId)
            invalid('Selected posts must belong to this topic')
        if (postId === t.rootCommEventId)
            invalid('Move the whole topic with merge or a category change')
        picked.add(postId)
        if (picked.size > 1000) invalid('The selection is too large')
        for (const child of rows(
            F + 'ForumPostSearch',
            { rootCommEventId: t.rootCommEventId, parentCommEventId: postId },
            1000,
        ))
            queue.push(child.communicationEventId)
    }
    return Array.from(picked)
        .map((postId) =>
            one(F + 'ForumPostState', { communicationEventId: postId }),
        )
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
}
function relocate(states, dest, destListId, newRootId) {
    const ids = new Set(states.map((s) => s.communicationEventId))
    let next = Number(dest.nextOrdinal || 1)
    const destRoot = dest.rootCommEventId,
        destEvent = one(E + 'CommunicationEvent', {
            communicationEventId: destRoot,
        })
    for (const st of states) {
        const postId = st.communicationEventId,
            ev = one(
                E + 'CommunicationEvent',
                { communicationEventId: postId },
                true,
            ),
            isRoot = postId === newRootId
        update(ev, {
            rootCommEventId: isRoot ? null : destRoot,
            parentCommEventId: isRoot
                ? null
                : ids.has(ev.parentCommEventId)
                  ? ev.parentCommEventId
                  : destRoot,
            contactListId: destListId,
            subject: isRoot ? ev.subject : destEvent?.subject || ev.subject,
        })
        update(
            one(F + 'ForumPostState', { communicationEventId: postId }, true),
            {
                rootCommEventId: destRoot,
                ordinal: next++,
            },
        )
        for (const entity of ['ForumReaction', 'ForumPoll', 'ForumBookmark'])
            find(F + entity, { communicationEventId: postId }).updateAll({
                rootCommEventId: destRoot,
            })
        // Open reviews now sit in the destination audience; a claim made under the old one is released.
        for (const r of rows(
            F + 'ForumReviewItem',
            { siteId: dest.siteId, targetType: 'post', targetId: postId },
            100,
        ))
            update(
                r,
                ['pending', 'claimed'].includes(r.state)
                    ? {
                          contactListId: destListId,
                          state: 'pending',
                          claimedByPartyId: null,
                          claimExpiresAt: null,
                          revision: Number(r.revision) + 1,
                      }
                    : { contactListId: destListId },
            )
    }
    update(dest, { nextOrdinal: next })
}
/* Counters are derived again after a structural change; they never decide access. */
function recount(t) {
    let visible = 0,
        reactions = 0,
        last = null
    for (const st of Array.from(
        find(F + 'ForumPostSearch', {
            rootCommEventId: t.rootCommEventId,
            visibility: 'approved',
        })
            .limit(20000)
            .list(),
    )) {
        visible++
        reactions += Number(st.reactionCount || 0)
        if (!last || millis(st.entryDate) > millis(last)) last = st.entryDate
    }
    update(t, {
        visiblePostCount: visible,
        reactionCount: reactions,
        lastActivity: last || t.lastActivity,
        revision: Number(t.revision) + 1,
    })
}
function retireTopic(t, targetRoot) {
    for (const entity of ['ForumTopicTag', 'ForumTopicUser', 'ForumTopicTimer'])
        find(F + entity, { rootCommEventId: t.rootCommEventId }).deleteAll()
    find(F + 'ForumDraft', { rootCommEventId: t.rootCommEventId }).updateAll({
        rootCommEventId: targetRoot,
    })
    find(F + 'ForumPermalink', {
        targetRootCommEventId: t.rootCommEventId,
    }).updateAll({ targetRootCommEventId: targetRoot })
    create(F + 'ForumPermalink', {
        oldRootCommEventId: t.rootCommEventId,
        siteId: t.siteId,
        targetRootCommEventId: targetRoot,
        createdAt: now(),
    })
    t.delete()
}
/* The destination of a move, split or merge, with the same audience confirmation a category move needs. */
function destination(p, a) {
    if (p.action === 'split') {
        const target = p.targetContactListId
            ? category(p.targetContactListId, p.siteId)
            : a
        return { a: target, t: null }
    }
    if (
        !p.targetRootCommEventId ||
        p.targetRootCommEventId === p.rootCommEventId
    )
        invalid('Choose a different destination topic')
    const out = topic(p.targetRootCommEventId, p.siteId, true)
    return { a: out.a, t: out.t }
}
function checkAudience(p, a, target) {
    if (!target.canModerate)
        fail('Unauthorized', 'Destination moderator access required')
    if (target.category.contactListId === a.category.contactListId) return
    if (p.confirmAudience !== true)
        invalid('Review and confirm the destination audience')
    if (Number(p.expectedGeneration) !== audienceRevision(p.siteId, a, target))
        fail('Conflict', 'Audience changed; preview the move again')
}
function restructure(p, t, event, a) {
    const dest = destination(p, a)
    checkAudience(p, a, dest.a)
    const destListId = dest.a.category.contactListId
    if (p.action === 'merge') {
        const states = Array.from(
            find(F + 'ForumPostState', { rootCommEventId: t.rootCommEventId })
                .orderBy('ordinal')
                .limit(20000)
                .list(),
        )
        relocate(states, dest.t, destListId, null)
        recount(dest.t)
        retireTopic(t, dest.t.rootCommEventId)
        return { rootCommEventId: dest.t.rootCommEventId, moved: states.length }
    }
    const states = selection(t, p.postIds)
    if (
        t.acceptedAnswerId &&
        states.some((s) => s.communicationEventId === t.acceptedAnswerId)
    )
        update(t, { acceptedAnswerId: null })
    let target = dest.t
    if (p.action === 'split') {
        if (!p.title || p.title.length > 250)
            invalid('A title of at most 250 characters is required')
        const newRoot = states[0].communicationEventId
        update(
            one(
                E + 'CommunicationEvent',
                { communicationEventId: newRoot },
                true,
            ),
            {
                subject: p.title,
            },
        )
        target = create(F + 'ForumTopic', {
            rootCommEventId: newRoot,
            siteId: p.siteId,
            contactListId: destListId,
            kind: 'category',
            revision: 0,
            nextOrdinal: 1,
            visiblePostCount: 0,
            reactionCount: 0,
            lastActivity: now(),
            pinned: 'N',
            unlisted: 'N',
            slowIntervalSeconds: 0,
        })
        relocate(states, target, destListId, newRoot)
    } else relocate(states, target, destListId, null)
    recount(target)
    recount(t)
    return { rootCommEventId: target.rootCommEventId, moved: states.length }
}
function fireTimer(timerId) {
    const timer = one(F + 'ForumTopicTimer', { timerId }, true)
    if (!timer || timer.state !== 'pending') return { fired: false }
    const t = one(
        F + 'ForumTopic',
        { rootCommEventId: timer.rootCommEventId },
        true,
    )
    const end = (state, error) => {
        update(timer, { state, lastError: error || null })
        return { fired: state === 'done', state }
    }
    // The scope is checked when the timer fires: a moved topic or a creator who lost moderation cancels it.
    if (!t || t.contactListId !== timer.contactListId)
        return end('cancelled', 'Topic moved or removed')
    if (!categoryAccess(t.contactListId, timer.createdByPartyId)?.canModerate)
        return end(
            'cancelled',
            'Timer creator no longer moderates this category',
        )
    const event = one(
        E + 'CommunicationEvent',
        { communicationEventId: t.rootCommEventId },
        true,
    )
    if (timer.action === 'close' || timer.action === 'reopen')
        update(event, {
            statusId: timer.action === 'close' ? 'CeResolved' : 'CeReceived',
        })
    else if (timer.action === 'unpin') update(t, { pinned: 'N' })
    else update(t, { unlisted: timer.action === 'unlist' ? 'Y' : 'N' })
    update(t, { revision: Number(t.revision) + 1 })
    systemAudit(
        t.siteId,
        t.contactListId,
        'topic',
        t.rootCommEventId,
        'timer-' + timer.action,
        timer.reason,
        timer.createdByPartyId,
    )
    bump(t.siteId)
    return end('done')
}
function fireTimers() {
    let fired = 0,
        failed = 0
    for (const timer of Array.from(
        find(F + 'ForumTopicTimer', { state: 'pending' })
            .condition('dueAt', 'less-equals', now())
            .orderBy('dueAt,timerId')
            .limit(100)
            .list(),
    ))
        try {
            ec.service
                .sync()
                .requireNewTransaction(true)
                .throwOnError(true)
                .name('mantle.forum.ModerationWorkerServices.fire#TopicTimer')
                .parameters({ timerId: timer.timerId })
                .call()
            fired++
        } catch (e) {
            ec.message.clearErrors()
            failed++
            ec.logger.error(
                'Forum topic timer ' +
                    timer.timerId +
                    ' failed: ' +
                    String(e?.message || e).split('\n')[0],
            )
        }
    return { fired, failed }
}
/* A member's own mute or block of another member on one site. */
function memberBlocks(siteId, partyId, targetPartyId) {
    const v =
        partyId && targetPartyId
            ? one(F + 'ForumMemberPreference', {
                  siteId,
                  partyId,
                  targetPartyId,
              })
            : null
    return (
        v?.preference === 'block' &&
        (!v.expiresAt || millis(v.expiresAt) > millis(now()))
    )
}
/* Policy revisions only grow, so their sum over the site and both category chains changes whenever either audience can. */
function audienceRevision(siteId, source, target) {
    let total = Number(one(S + 'PublicSite', { siteId })?.policyRevision || 0)
    for (const start of [source.category, target.category]) {
        const seen = new Set()
        for (let c = start; c && !seen.has(c.contactListId);) {
            seen.add(c.contactListId)
            total += Number(c.policyRevision || 0)
            c = c.parentContactListId
                ? one(F + 'ForumCategory', {
                      contactListId: c.parentContactListId,
                  })
                : null
        }
    }
    return total
}
function execute(operation, p) {
    const schema = ec.resource.script(
        'component://mr-mantle/service/mantle/forum/ForumSchema.js',
    )[operation]
    if (!schema) missing()
    for (const field of Object.keys(p || {}))
        if (!schema.fields.includes(field))
            invalid('Unsupported field: ' + field)
    for (const key of [
        'siteId',
        'contactListId',
        'rootCommEventId',
        'postId',
        'draftId',
        'reviewId',
        'targetPartyId',
        'title',
        'body',
        'handle',
        'name',
        'reason',
        'token',
    ])
        if (p?.[key] != null && typeof p[key] !== 'string')
            invalid('Invalid field type: ' + key)
    for (const key of [
        'attachmentIds',
        'renderedPostIds',
        'deliveryIds',
        'tags',
        'optionIds',
        'allowedCategories',
        'postIds',
        'reviewIds',
    ])
        if (
            p?.[key] != null &&
            (!Array.isArray(p[key]) ||
                p[key].length > 100 ||
                p[key].some(
                    (value) => typeof value !== 'string' || value.length > 40,
                ))
        )
            invalid('Invalid list field: ' + key)
    const numeric = new Set([
        'expectedRevision',
        'expectedGeneration',
        'sequenceNum',
        'limit',
        'ordinal',
        'before',
        'after',
        'postRevision',
        'fromRevision',
        'toRevision',
        'revision',
        'slowIntervalSeconds',
    ])
    const booleans = new Set([
        'confirm',
        'confirmAudience',
        'approvalRequired',
        'markUnread',
        'jump',
        'all',
        'active',
        'locked',
    ])
    const listFields = new Set([
        'attachmentIds',
        'renderedPostIds',
        'deliveryIds',
        'tags',
        'optionIds',
        'allowedCategories',
        'postIds',
        'reviewIds',
    ])
    for (const [key, value] of Object.entries(p || {})) {
        if (value == null) continue
        if (numeric.has(key)) {
            if (
                !['number', 'string'].includes(typeof value) ||
                !Number.isInteger(Number(value))
            )
                invalid('Invalid numeric field: ' + key)
        } else if (booleans.has(key)) {
            if (typeof value !== 'boolean')
                invalid('Invalid Boolean field: ' + key)
        } else if (listFields.has(key)) continue
        else if (['expiresAt', 'thruDate', 'remindAt', 'dueAt'].includes(key)) {
            if (!['number', 'string'].includes(typeof value))
                invalid('Invalid date field: ' + key)
        } else if (key === 'poll') {
            if (typeof value !== 'object' || Array.isArray(value))
                invalid('Invalid poll')
        } else if (key === 'config') {
            if (typeof value !== 'object' || Array.isArray(value))
                invalid('Invalid policy configuration')
        } else if (key === 'file') {
            if (typeof value !== 'object') invalid('Invalid upload')
        } else if (['hosts', 'mounts'].includes(key)) {
            if (!Array.isArray(value) || value.length > 100)
                invalid('Invalid configuration list')
            const allowed =
                key === 'hosts'
                    ? ['hostname', 'canonical']
                    : ['appMountId', 'app', 'pathPrefix', 'enabled']
            for (const item of value) {
                if (
                    !item ||
                    typeof item !== 'object' ||
                    Array.isArray(item) ||
                    Object.keys(item).some((field) => !allowed.includes(field))
                )
                    invalid('Invalid configuration fields')
                for (const [field, data] of Object.entries(item))
                    if (
                        data != null &&
                        (['canonical', 'enabled'].includes(field)
                            ? typeof data !== 'boolean'
                            : typeof data !== 'string')
                    )
                        invalid('Invalid configuration field type')
            }
        } else if (typeof value !== 'string')
            invalid('Invalid field type: ' + key)
    }
    const fn = methods[operation]
    if (!fn) missing()
    const was = ec.artifactExecution.disableAuthz()
    try {
        return fn(p || {})
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
;({
    execute,
    categoryAccess,
    internalParty,
    internalMemberIds,
    capabilities,
    topic,
    postVisible,
    methods,
    legacyMarker,
    legacyReading,
    legacyMailboxSummary,
    protectListOwner,
    recordMailboxPost,
    addNamedReceipts,
    remindBookmarks,
    remindBookmark,
    recomputeTrust,
    recomputeMemberTrust,
    classifyPosts,
    classifyPost,
    fireTimers,
    fireTimer,
})
