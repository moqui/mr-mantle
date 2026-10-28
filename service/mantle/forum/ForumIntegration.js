/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Forum integrations: source-bound access grants, the subscription resource handlers that keep them in step with
 * the subscription lifecycle, and their staff and member views. Forum.js calls this with the shared core and its
 * methods map.
 */
;(core, methods) => {
    const {
        F,
        S,
        now,
        millis,
        id,
        find,
        one,
        rows,
        create,
        update,
        pick,
        fail,
        missing,
        invalid,
        me,
        isOperator,
        site,
        revision,
        bump,
        staff,
        page,
        receipt,
        audit,
        systemAudit,
        grantActive,
    } = core
    const SUB = 'mantle.product.subscription.'
    const HANDLERS = {
        initServiceName: 'mantle.forum.EntitlementServices.init#ForumAccess',
        renewServiceName: 'mantle.forum.EntitlementServices.renew#ForumAccess',
        revokeAccessServiceName:
            'mantle.forum.EntitlementServices.revoke#ForumAccess',
        restoreAccessServiceName:
            'mantle.forum.EntitlementServices.restore#ForumAccess',
        destroyServiceName:
            'mantle.forum.EntitlementServices.destroy#ForumAccess',
    }
    /* The scope a grant or binding names: the whole site, or one of its categories. */
    function grantTarget(siteId, targetType, contactListId) {
        if (targetType === 'site') return { targetType, targetId: siteId }
        if (targetType !== 'category' || !contactListId)
            invalid('Choose the site or one of its categories')
        const c = one(F + 'ForumCategory', { contactListId })
        if (!c || c.siteId !== siteId) missing()
        return { targetType, targetId: contactListId }
    }
    const scopeList = (target) =>
        target.targetType === 'category' ? target.targetId : null
    function partyByHandle(siteId, handle) {
        const profile = handle
            ? one(S + 'PublicSiteProfile', { siteId, handle })
            : null
        if (!profile) missing()
        return profile.partyId
    }
    /* Staff see the source kind and period, never the subscription or order behind it. */
    const grantProjection = (g) => ({
        ...pick(
            g,
            'grantId targetType targetId sourceType fromDate thruDate revokedAt reason revision',
        ),
        active: grantActive(g),
        handle:
            one(S + 'PublicSiteProfile', {
                siteId: g.siteId,
                partyId: g.partyId,
            })?.handle ?? null,
    })
    methods.setAccessGrant = (p) =>
        receipt(p, 'setAccessGrant', () => {
            site(p.siteId)
            const target = grantTarget(p.siteId, p.targetType, p.contactListId)
            staff(p.siteId, scopeList(target))
            if (!p.reason) invalid('A reason is required')
            if (p.thruDate != null && millis(p.thruDate) <= millis(now()))
                invalid('The grant must end in the future')
            const partyId = partyByHandle(p.siteId, p.handle)
            if (partyId === me())
                invalid('Staff cannot grant themselves access')
            const key = {
                partyId,
                siteId: p.siteId,
                ...target,
                sourceType: 'manual',
                sourceId: 'manual',
            }
            const old = one(S + 'PublicAccessGrant', key, true),
                before = old ? Number(old.revision || 1) : null
            const fields = {
                fromDate: p.fromDate ?? now(),
                thruDate: p.thruDate ?? null,
                revokedAt: null,
                reason: p.reason,
                grantedByPartyId: me(),
                revision: (before || 0) + 1,
            }
            const g = old
                ? update(old, fields)
                : create(S + 'PublicAccessGrant', {
                      grantId: id(),
                      createdAt: now(),
                      ...key,
                      ...fields,
                  })
            audit(
                p.siteId,
                scopeList(target),
                'grant',
                g.grantId,
                'grant',
                p.reason,
                before,
                fields.revision,
            )
            bump(p.siteId)
            return { grantId: g.grantId, revision: fields.revision }
        })
    methods.endAccessGrant = (p) => {
        site(p.siteId)
        const g = one(
            S + 'PublicAccessGrant',
            { siteId: p.siteId, grantId: p.grantId },
            true,
        )
        if (!g) missing()
        staff(p.siteId, g.targetType === 'category' ? g.targetId : null)
        if ((g.sourceType || 'manual') !== 'manual')
            fail(
                'Conflict',
                'A subscription grant follows its subscription and cannot be ended here',
            )
        revision({ revision: Number(g.revision || 1) }, p.expectedRevision)
        if (!p.reason) invalid('A reason is required')
        const next = Number(g.revision || 1) + 1
        update(g, { thruDate: now(), revision: next })
        audit(
            p.siteId,
            g.targetType === 'category' ? g.targetId : null,
            'grant',
            g.grantId,
            'end-grant',
            p.reason,
            next - 1,
            next,
        )
        bump(p.siteId)
        return { revision: next }
    }
    methods.findAccessGrants = (p) => {
        site(p.siteId)
        staff(p.siteId, p.contactListId)
        const fields = { siteId: p.siteId }
        if (p.contactListId) {
            fields.targetType = 'category'
            fields.targetId = p.contactListId
        }
        if (p.handle) fields.partyId = partyByHandle(p.siteId, p.handle)
        const pg = page(
                p,
                'grants:' +
                    p.siteId +
                    ':' +
                    (p.contactListId || '') +
                    ':' +
                    (p.handle || ''),
            ),
            list = Array.from(
                find(S + 'PublicAccessGrant', fields)
                    .orderBy('-createdAt,grantId')
                    .offset(pg.offset)
                    .limit(pg.limit + 1)
                    .list(),
            )
        return {
            grantList: list.slice(0, pg.limit).map(grantProjection),
            nextCursor:
                list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        }
    }
    /* Binding a subscription resource sets its lifecycle services, so only an operator changes it, and a bound
       resource keeps its scope: existing subscribers' grants were written for that scope. */
    methods.storeSubscriptionBinding = (p) => {
        site(p.siteId, true)
        if (!isOperator())
            fail('Unauthorized', 'An operator binds subscription resources')
        const resource = one(
            SUB + 'SubscriptionResource',
            { subscriptionResourceId: p.subscriptionResourceId },
            true,
        )
        if (!resource) missing()
        const target = grantTarget(p.siteId, p.targetType, p.contactListId)
        for (const [field, name] of Object.entries(HANDLERS))
            if (resource[field] && resource[field] !== name)
                fail(
                    'Conflict',
                    'This subscription resource already has other access services',
                )
        const old = one(S + 'PublicSubscriptionBinding', {
            subscriptionResourceId: p.subscriptionResourceId,
        })
        if (
            old &&
            (old.siteId !== p.siteId ||
                old.targetType !== target.targetType ||
                old.targetId !== target.targetId)
        )
            fail('Conflict', 'A bound subscription resource keeps its scope')
        if (!old)
            create(S + 'PublicSubscriptionBinding', {
                subscriptionResourceId: p.subscriptionResourceId,
                siteId: p.siteId,
                ...target,
                createdAt: now(),
                revision: 1,
            })
        update(resource, HANDLERS)
        audit(
            p.siteId,
            scopeList(target),
            'subscription-resource',
            p.subscriptionResourceId,
            'bind-subscription',
            p.reason || 'Subscription resource bound',
            null,
            1,
        )
        return { subscriptionResourceId: p.subscriptionResourceId }
    }
    methods.findSubscriptionBindings = (p) => {
        site(p.siteId, true)
        return {
            bindingList: rows(S + 'PublicSubscriptionBinding', {
                siteId: p.siteId,
            }).map((b) => ({
                ...pick(
                    b,
                    'subscriptionResourceId targetType targetId createdAt',
                ),
                description:
                    one(SUB + 'SubscriptionResource', {
                        subscriptionResourceId: b.subscriptionResourceId,
                    })?.description || '',
            })),
        }
    }
    /* The member's own grants on a site, for the memberships view. */
    function memberEntitlements(siteId, partyId) {
        if (!partyId) return []
        return Array.from(
            find(S + 'PublicAccessGrant', { siteId, partyId })
                .orderBy('-thruDate,grantId')
                .limit(50)
                .list(),
        ).map((g) => ({
            ...pick(g, 'targetType targetId sourceType fromDate thruDate'),
            active: grantActive(g),
            name:
                g.targetType === 'category'
                    ? one('mantle.marketing.contact.ContactList', {
                          contactListId: g.targetId,
                      })?.contactListName || ''
                    : one(S + 'PublicSite', { siteId })?.name || '',
        }))
    }
    /* The subscription resource handlers (EntitlementServices.xml). Each subscription period has its own grant, so
       renewal adds the next period and revoking one never touches a manual grant or another period. A replayed
       init or renew updates the same row and leaves a revocation in place; only restore lifts it. A resource with
       these handlers but no binding is logged and skipped, so order fulfillment does not fail. */
    function applySubscription(action, subscriptionId) {
        const was = ec.artifactExecution.disableAuthz()
        try {
            const sub = one(SUB + 'Subscription', { subscriptionId })
            if (!sub) missing()
            const binding = one(S + 'PublicSubscriptionBinding', {
                subscriptionResourceId: sub.subscriptionResourceId,
            })
            if (!binding) {
                ec.logger.error(
                    'Forum access handler ' +
                        action +
                        ' found no site binding for subscription ' +
                        subscriptionId,
                )
                return
            }
            const key = {
                partyId: sub.subscriberPartyId,
                siteId: binding.siteId,
                targetType: binding.targetType,
                targetId: binding.targetId,
                sourceType: 'subscription',
                sourceId: subscriptionId,
            }
            const old = one(S + 'PublicAccessGrant', key, true)
            let g = old
            if (['init', 'renew', 'restore'].includes(action)) {
                const fields = {
                    fromDate: sub.fromDate,
                    thruDate: sub.thruDate,
                    ...(action === 'restore' ? { revokedAt: null } : {}),
                    revision: Number(old?.revision || 0) + 1,
                }
                g = old
                    ? update(old, fields)
                    : create(S + 'PublicAccessGrant', {
                          grantId: id(),
                          createdAt: now(),
                          reason: 'Subscription',
                          ...key,
                          ...fields,
                      })
            } else if (old && !old.revokedAt)
                update(old, {
                    revokedAt: now(),
                    revision: Number(old.revision || 1) + 1,
                })
            if (!g) return
            systemAudit(
                binding.siteId,
                binding.targetType === 'category' ? binding.targetId : null,
                'grant',
                g.grantId,
                'subscription-' + action,
                'Subscription ' + action,
                null,
            )
            bump(binding.siteId)
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
    /* Whether a party holds any current grant on a site, which lets them join a site whose registration is closed. */
    const hasSiteGrant = (siteId, partyId) =>
        !!partyId &&
        rows(S + 'PublicAccessGrant', { siteId, partyId }).some(grantActive)
    return { applySubscription, memberEntitlements, hasSiteGrant }
}
