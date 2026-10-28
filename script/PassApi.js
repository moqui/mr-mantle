/* Restricted public API. No generic service or entity dispatch. CC0 plus patent grant. */
const routes = ec.resource.script('component://mr-mantle/script/PassRoutes.js')
const schema = ec.resource.script(
    'component://mr-mantle/service/mantle/forum/ForumSchema.js',
)
const fail = (kind, message) => {
    const e = new Error(message)
    e.moquiErrorKind = kind
    throw e
}
;({
    service(request, response) {
        try {
            const parts = request.requestURI.split('/').filter(Boolean)
            if (
                parts.slice(0, 6).join('/') !==
                'rest/s1/pass/v1/sites/' + parts[5]
            ) {
                fail('NotFound', 'Resource not found')
            }
            const siteId = parts[5],
                path = parts.slice(6),
                method = request.method.toUpperCase()
            const bearer = request.getHeader('authorization') || '',
                clientId = request.getHeader('x-pass-client') || ''
            const account = ec.resource.script(
                'component://framework/service/org/moqui/public/Account.js',
            )
            const registeredClient = account.clientRegistered(
                clientId,
                request.getHeader('x-pass-client-secret') || '',
                siteId,
            )
            let delegation = null
            if (bearer.startsWith('Bearer ')) {
                // A credential is only good from the deployment it was issued to.
                if (!registeredClient)
                    fail('AuthenticationRequired', 'Registered client required')
                const was = ec.artifactExecution.disableAuthz()
                try {
                    delegation = account.authenticateDelegation(
                        bearer.slice(7),
                        clientId,
                        siteId,
                    )
                } finally {
                    if (!was) ec.artifactExecution.enableAuthz()
                }
            }
            if (
                !['GET', 'HEAD'].includes(method) &&
                !(path[0] === 'account' && registeredClient) &&
                !(path.join('/') === 'opt-out' && method === 'POST') &&
                !bearer.startsWith('Bearer ') &&
                request.getHeader('x-csrf-token') !== ec.web.sessionToken
            )
                fail('Unauthorized', 'Invalid session token')
            response.setHeader('Cache-Control', 'no-store')
            response.setHeader('X-Content-Type-Options', 'nosniff')
            const raw = { ...request.getParameterMap() }
            if (raw._requestBodyJsonParseError || raw._requestBodyJsonList)
                fail('Unprocessable', 'JSON object required')
            delete raw.moquiSessionToken
            delete raw._requestBodyText
            delete raw._fileUploadList
            if (path[0] === 'account') {
                if (
                    [
                        'sso',
                        'sso-complete',
                        'sso-prepare',
                        'sso-exchange',
                    ].includes(path[1])
                ) {
                    const frontChannel = ['sso', 'sso-complete'].includes(
                        path[1],
                    )
                    if (
                        frontChannel
                            ? method !== 'GET'
                            : method !== 'POST' || !registeredClient
                    )
                        fail(
                            'Unauthorized',
                            'Registered sign-in client required',
                        )
                    const allowed = frontChannel
                        ? ['handoffId']
                        : [
                              'handoffId',
                              'authFlowId',
                              'state',
                              'code',
                              'verifier',
                          ]
                    if (Object.keys(raw).some((k) => !allowed.includes(k)))
                        fail('Unprocessable', 'Unsupported sign-in field')
                    const input = {
                        ...raw,
                        siteId,
                        clientId,
                        clientSecret: request.getHeader('x-pass-client-secret'),
                    }
                    const action = {
                        sso: 'start',
                        'sso-complete': 'complete',
                        'sso-prepare': 'prepare',
                        'sso-exchange': 'exchange',
                    }[path[1]]
                    if (
                        action === 'complete' &&
                        !ec.user.userId &&
                        ec.web.sessionAttributes.moquiPreAuthcUsername
                    ) {
                        response.sendRedirect(
                            '/Login?returnTo=' +
                                encodeURIComponent(
                                    request.requestURI +
                                        '?handoffId=' +
                                        encodeURIComponent(raw.handoffId),
                                ),
                        )
                        return
                    }
                    const result = ec.service
                        .sync()
                        .throwOnError(true)
                        .name(
                            'org.moqui.public.AccountServices.' +
                                action +
                                '#Sso',
                        )
                        .parameters({ input })
                        .call().result
                    if (result.redirectUrl)
                        response.sendRedirect(result.redirectUrl)
                    else if (!frontChannel) {
                        response.setContentType('application/json')
                        response.write(JSON.stringify(result))
                    }
                    return
                }
                const accountActions = {
                    session: 'start',
                    challenge: 'complete',
                    registration: 'begin',
                    verification: 'verify',
                    recovery: 'request',
                    logout: 'end',
                    security: 'manage',
                }
                if (method !== 'POST' || !accountActions[path[1]]) {
                    fail('NotFound', 'Resource not found')
                }
                const allowed = [
                    'username',
                    'password',
                    'code',
                    'emailAddress',
                    'token',
                    'action',
                    'oldPassword',
                    'newPassword',
                    'newPasswordVerify',
                    'visitId',
                    'invitationToken',
                ]
                if (Object.keys(raw).some((k) => !allowed.includes(k)))
                    fail('Unprocessable', 'Unsupported account field')
                const was = ec.artifactExecution.disableAuthz()
                let result
                try {
                    if (path[1] === 'registration') {
                        const s = ec.entity
                            .find('mantle.public.PublicSite')
                            .condition('siteId', siteId)
                            .one()
                        if (!s || s.state !== 'published')
                            fail('Unauthorized', 'Registration is closed')
                        if (s.registrationMode !== 'open') {
                            if (
                                s.registrationMode !== 'invitation' ||
                                !raw.invitationToken
                            )
                                fail('Unauthorized', 'Registration is closed')
                            ec.service
                                .sync()
                                .throwOnError(true)
                                .name(
                                    'mantle.public.SiteServices.inspect#Invitation',
                                )
                                .parameters({
                                    input: {
                                        siteId,
                                        token: raw.invitationToken,
                                        emailAddress: raw.emailAddress,
                                    },
                                })
                                .call()
                        }
                    }
                    if (path[1] === 'logout' && delegation) {
                        delegation.set('revokedAt', ec.user.nowTimestamp)
                        delegation.update()
                    }
                    const noun = ['registration', 'verification'].includes(
                        path[1],
                    )
                        ? 'Registration'
                        : path[1] === 'recovery'
                          ? 'Recovery'
                          : path[1] === 'security'
                            ? 'Account'
                            : 'Session'
                    result = ec.service
                        .sync()
                        .throwOnError(true)
                        .name(
                            'org.moqui.public.AccountServices.' +
                                accountActions[path[1]] +
                                '#' +
                                noun,
                        )
                        .parameters({ input: raw })
                        .call().result
                    if (result.authenticated && clientId) {
                        const clientSecret =
                            request.getHeader('x-pass-client-secret') || ''
                        result = {
                            ...result,
                            ...ec.service
                                .sync()
                                .throwOnError(true)
                                .name(
                                    'org.moqui.public.AccountServices.issue#Delegation',
                                )
                                .parameters({
                                    input: { siteId, clientId, clientSecret },
                                })
                                .call().result,
                        }
                    }
                } finally {
                    if (!was) ec.artifactExecution.enableAuthz()
                }
                response.setContentType('application/json')
                response.write(JSON.stringify(result))
                return
            }
            for (const [verb, pattern, op] of routes) {
                const expected = pattern.split('/')
                if (verb !== method || expected.length !== path.length) continue
                const ids = {}
                let matches = true
                for (let i = 0; i < expected.length; i++) {
                    if (expected[i].startsWith('{'))
                        try {
                            ids[expected[i].slice(1, -1)] = decodeURIComponent(
                                path[i],
                            )
                        } catch (e) {
                            fail('NotFound', 'Resource not found')
                        }
                    else if (expected[i] !== path[i]) matches = false
                }
                if (!matches) continue
                const input = { ...raw, ...ids, siteId }
                if (
                    (raw.siteId && raw.siteId !== siteId) ||
                    Object.keys(input).some(
                        (k) => !schema[op].fields.includes(k),
                    )
                )
                    fail(
                        'Unprocessable',
                        'Unsupported request field: ' +
                            Object.keys(input)
                                .filter((k) => !schema[op].fields.includes(k))
                                .join(',')
                                .slice(0, 120),
                    )
                if (op === 'stageAttachment')
                    input.file = ec.web.multiPartParameters.file
                const result = ec.service
                    .sync()
                    .throwOnError(true)
                    .name(schema[op].service)
                    .parameters({ input })
                    .call().result
                if (op === 'getAttachment' || op === 'getExport') {
                    const file = result.attachment || result.export
                    response.setContentType(file.mimeType)
                    response.setHeader('Cache-Control', 'no-store')
                    response.setHeader(
                        'Content-Disposition',
                        (file.variant === 'thumbnail'
                            ? 'inline'
                            : 'attachment') +
                            '; filename="' +
                            String(file.filename).replace(/["\\\r\n]/g, '_') +
                            '"',
                    )
                    const stream = ec.resource
                        .getLocationReference(result.location)
                        .openStream()
                    try {
                        response.write(stream.readAllBytes())
                    } finally {
                        stream.close()
                    }
                    return
                }
                response.setContentType('application/json')
                response.write(JSON.stringify(result))
                return
            }
            fail('NotFound', 'Resource not found')
        } catch (error) {
            const kind = error.moquiErrorKind || 'Unavailable'
            const status =
                {
                    AuthenticationRequired: 401,
                    Unauthorized: 403,
                    NotFound: 404,
                    Conflict: 409,
                    Unprocessable: 422,
                    Tarpit: 429,
                    MethodNotAllowed: 405,
                }[kind] || 503
            const correlationId = ec.user.randomString(24)
            ec.logger.warn(
                'PASS request ' +
                    correlationId +
                    ' failed (' +
                    kind +
                    '): ' +
                    String(error.message || 'Request failed').split('\n')[0],
            )
            ec.message.clearErrors()
            response.setStatus(status)
            response.setContentType('application/json')
            response.setHeader('Cache-Control', 'no-store')
            if (status === 429) response.setHeader('Retry-After', '10')
            const message =
                {
                    401: 'Sign in to continue',
                    403: 'Action is not permitted',
                    404: 'Resource not found',
                    409: 'State changed; reload and compare',
                    422: 'Invalid request fields',
                    429: 'Too many requests',
                }[status] || 'Authority temporarily unavailable'
            response.write(
                JSON.stringify({
                    code: kind,
                    message,
                    fieldErrors: [],
                    correlationId,
                }),
            )
        }
    },
})
