const helper = () => ec.resource.script("component://mr-mantle/test/AccountingProviderRefundFixtures.js")
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
function forbidden(value) {
    if (!value || typeof value !== "object") return false
    return Object.entries(value).some(
        ([key, item]) =>
            [
                "accountNumber",
                "routingNumber",
                "credentialSnapshot",
                "requestJson",
                "frozenEvidenceJson",
                "merchantNamespace"
            ].includes(key) || forbidden(item)
    )
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().gateway.fixtures("ACCT_P5_PRVRC")
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
feature(
    "reference refund and exact lookup survive original credential rotation and expiry while frozen evidence survives live deletion",
    {
        when() {
            const h = helper(),
                cash = h.captured(f),
                paymentId = cash.cashPaymentId,
                id = "PRV_EVID_" + ec.user.randomString(20),
                location = "dbresource://mantle/content/payment/" + paymentId + "/content_" + id + "/Original.txt",
                data = new Uint8Array(71680)
            for (let i = 0; i < data.length; i++) data[i] = (i + paymentId.charCodeAt(i % paymentId.length)) % 256
            ec.resource.getLocationReference(location).putBytes(data)
            h.call("create#mantle.account.payment.PaymentContent", {
                paymentContentId: id,
                paymentId,
                contentLocation: location,
                contentTypeEnumId: "PctPaymentDocument",
                description: "Reviewed refund evidence"
            })
            const evidence = h.lifecycle.detail(f, paymentId).evidenceRows.find(row => row.paymentContentId === id),
                saved = [f.methodId, f.customerMethodId].map(paymentMethodId => ({
                    paymentMethodId,
                    method: h.lib.map(h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId})),
                    bank: h.lib.map(h.lib.one("mantle.account.method.BankAccount", {paymentMethodId}))
                }))
            let review, pending, completed, before
            try {
                for (const row of saved) {
                    h.call("update#mantle.account.method.PaymentMethod", {
                        paymentMethodId: row.paymentMethodId,
                        gatewayCimId: "ROTATED_REFUND_TOKEN",
                        thruDate: Number(f.timestamp) - 1
                    })
                    h.call("update#mantle.account.method.BankAccount", {
                        paymentMethodId: row.paymentMethodId,
                        accountNumber: "765432109"
                    })
                }
                review = h.gateway.preview(f, paymentId, "refund", {
                    amount: "7",
                    evidenceContentIdList: [id],
                    evidenceVersions: {[id]: evidence.version}
                })
                h.gateway.mode(f, "refund", "pending")
                pending = h.gateway.execute(review, "prv-ref-rotation")
                before = h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})
                h.call("delete#mantle.account.payment.PaymentContent", {paymentContentId: id})
                ec.resource.getLocationReference(location).delete()
                h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                    paymentGatewayConfigId: f.gatewayId,
                    lookupOutcomesJson: JSON.stringify({refund: "accepted"})
                })
                completed = h.refresh(f, pending.attemptId)
            } finally {
                for (const row of saved) {
                    h.call("update#mantle.account.method.PaymentMethod", {
                        paymentMethodId: row.paymentMethodId,
                        gatewayCimId: row.method.gatewayCimId,
                        thruDate: row.method.thruDate
                    })
                    h.call("update#mantle.account.method.BankAccount", {
                        paymentMethodId: row.paymentMethodId,
                        accountNumber: row.bank.accountNumber
                    })
                }
                h.gateway.mode(f, "refund", "accepted")
                h.call("update#mantle.account.payment.PaymentGatewayTestControl", {
                    paymentGatewayConfigId: f.gatewayId,
                    lookupOutcomesJson: "{}"
                })
            }
            const event = h.lib.one("mantle.account.payment.PaymentLifecycleEvent", {
                    paymentLifecycleEventId: completed.paymentLifecycleEventId
                }),
                archived = JSON.parse(event.evidenceJson || "[]"),
                publicViews = [
                    review,
                    h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: completed.attemptId}),
                    h.native("get#PaymentGatewayActionPreview", {previewId: review.previewId}),
                    h.native("find#PaymentGatewayTransactions", {organizationPartyId: f.org, paymentId})
                ]
            return {
                pending,
                completed,
                before,
                archived,
                hash: digest(data),
                actualHash: archived[0] && digest(read(archived[0].archiveLocation)),
                publicViews,
                effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {
                    providerOperationId: completed.providerOperationId,
                    merchantNamespace: f.merchantNamespace
                })
            }
        },
        then({pending, completed, before, archived, hash, actualHash, publicViews, effect}) {
            pending.providerState == "pending"
            pending.cashPaymentId == null
            toDecimal(before.refundSummary.availableAmount).eq(13)
            toDecimal(before.refundSummary.reservedAmount).eq(7)
            completed.financialState == "completed"
            completed.cashPaymentId != null
            archived.length == 1
            archived[0].contentHash == hash
            actualHash == hash
            publicViews.every(value => !forbidden(value))
            Number(effect.invocationCount) == 1
            Number(effect.lookupCount) == 1
        }
    }
)
feature("accepted timeout uses exact original lookup identity once and recorded lookup replay cannot create another refund", {
    when() {
        const h = helper(),
            cash = h.captured(f)
        h.gateway.mode(f, "refund", "accepted-timeout")
        let uncertain
        try {
            uncertain = h.gateway.execute(h.gateway.preview(f, cash.cashPaymentId, "refund", {amount: "6"}))
        } finally {
            h.gateway.mode(f, "refund", "accepted")
        }
        const view = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: uncertain.attemptId}),
            request = {
                organizationPartyId: f.org,
                attemptId: uncertain.attemptId,
                attemptVersion: view.attemptVersion,
                operationKey: "prv-ref-timeout-lookup"
            },
            first = h.native("refresh#PaymentGatewayAttempt", request),
            again = h.native("refresh#PaymentGatewayAttempt", request)
        return {
            uncertain,
            first,
            again,
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {
                providerOperationId: first.providerOperationId,
                merchantNamespace: f.merchantNamespace
            })
        }
    },
    then({uncertain, first, again, effect}) {
        uncertain.providerState == "uncertain"
        uncertain.cashPaymentId == null
        first.financialState == "completed"
        again.cashPaymentId == first.cashPaymentId
        again.alreadyApplied == true
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 1
    }
})
feature(
    "changed refund control mapping after provider acceptance requires new financial review and consumes held capacity exactly once",
    {
        when() {
            const h = helper(),
                cash = h.captured(f),
                paymentId = cash.cashPaymentId,
                mapping = {organizationPartyId: f.org, paymentTypeEnumId: "PtRefund", isApplied: "N", isPayable: "Y"},
                old = h.lib.map(h.lib.one("mantle.ledger.config.PaymentTypeGlAccount", mapping)),
                accountId = "PRV_REF_ALT_" + ec.user.randomString(16),
                original = h.lib.one("mantle.ledger.account.GlAccount", {glAccountId: old.glAccountId})
            h.call(
                "create#mantle.ledger.account.GlAccount",
                Object.assign(
                    h.lib.policy.pick(h.lib.map(original), [
                        "glAccountClassEnumId",
                        "glAccountTypeEnumId",
                        "glResourceTypeEnumId",
                        "disallowPosting",
                        "parentGlAccountId"
                    ]),
                    {glAccountId: accountId, accountCode: accountId, accountName: "Alternate reviewed refund control"}
                )
            )
            h.call("create#mantle.ledger.account.GlAccountOrganization", {organizationPartyId: f.org, glAccountId: accountId})
            const draftId = h.lifecycle.draft(f, {cashDirection: "outgoing", amount: "7"}),
                review = h.gateway.preview(f, paymentId, "refund", {
                    amount: "7",
                    refundPaymentId: draftId,
                    refundSourceVersion: h.lifecycle.detail(f, draftId).sourceVersion
                })
            let failed, recovery, summary, record
            try {
                failed = h.acceptedUnposted(f, review, {
                    kind: "mapping",
                    values: Object.assign({}, mapping, {glAccountId: accountId})
                })
                const partial = {
                    cash: h.lib.find("mantle.account.payment.Payment", {refundForPaymentId: paymentId}).count(),
                    records: h.lib.find("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}).count()
                }
                const current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: failed.attemptId}),
                    retained = h.native("preview#PaymentGatewayRecovery", {
                        organizationPartyId: f.org,
                        attemptId: failed.attemptId,
                        attemptVersion: current.attemptVersion,
                        reason: "Review corrected control account after accepted refund"
                    }),
                    confirm = {
                        previewId: retained.previewId,
                        inputFingerprint: retained.inputFingerprint,
                        operationKey: "prv-ref-policy-recovery"
                    }
                let rollbackFailure = ""
                try {
                    parallel(
                        1,
                        (thread, args) => {
                            login(args.username)
                            ec.artifactExecution.disableAuthz()
                            const result = call("mantle.account.PaymentServices.complete#PaymentGatewayAttempt", args.confirm),
                                lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js"),
                                record = lib.one("mantle.account.payment.PaymentRefundRecord", {
                                    refundPaymentId: result.cashPaymentId
                                })
                            if (
                                !record ||
                                result.acctgTransIds.length !== 2 ||
                                result.applicationResults.length !== 1 ||
                                result.outputRows.length !== 2
                            )
                                throw new Error(
                                    "TEST_REFUND_MONEY_MISSING: Completion did not create actual refund money before rollback"
                                )
                            throw new Error("TEST_PROVIDER_REFUND_ROLLBACK: " + result.cashPaymentId)
                        },
                        {username: ec.user.username, confirm},
                        {transaction: true, timeout: 60}
                    )
                } catch (error) {
                    ec.message.clearErrors()
                    rollbackFailure = error.message
                }
                const restored = {
                    outputs: h.lib.find("mantle.account.payment.PaymentIssuedOutput", {paymentId: draftId}).count(),
                    transactions: h.lib.find("mantle.ledger.transaction.AcctgTrans", {paymentId: draftId}).count(),
                    applications: h.lib.find("mantle.account.payment.PaymentApplication", {paymentId: draftId}).count(),
                    operation: h.lib.find(h.lib.operationEntity, {operationKey: confirm.operationKey}).count(),
                    failure: rollbackFailure,
                    claim: h.lib.one("mantle.account.payment.PaymentRefundDraftClaim", {refundPaymentId: draftId}),
                    holds: h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {attemptId: failed.attemptId}),
                    records: h.lib.find("mantle.account.payment.PaymentRefundRecord", {originalPaymentId: paymentId}).count(),
                    draft: h.lib.one("mantle.account.payment.Payment", {paymentId: draftId}),
                    attempt: h.lib.one("mantle.account.payment.PaymentGatewayAttempt", {attemptId: failed.attemptId}),
                    review: h.native("get#PaymentGatewayActionPreview", {previewId: retained.previewId})
                }
                recovery = {review: retained, result: h.native("complete#PaymentGatewayAttempt", confirm), restored, partial}
                summary = h.native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}).refundSummary
                record = h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: recovery.result.cashPaymentId})
            } finally {
                h.call(
                    "update#mantle.ledger.config.PaymentTypeGlAccount",
                    Object.assign({}, mapping, {glAccountId: old.glAccountId})
                )
            }
            return {
                failed,
                recovery,
                summary,
                record,
                accountId,
                effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {
                    providerOperationId: failed.providerOperationId,
                    merchantNamespace: f.merchantNamespace
                })
            }
        },
        then({failed, recovery, summary, record, accountId, effect}) {
            failed.providerState == "accepted"
            failed.financialState == "accepted_unposted"
            failed.reasonCode == "STALE_PREVIEW"
            failed.cashPaymentId == null
            recovery.partial.cash == 0
            recovery.partial.records == 0
            toDecimal(recovery.review.before.providerRefundedAmount).eq(7)
            toDecimal(recovery.review.after.providerRefundedAmount).eq(7)
            toDecimal(recovery.review.before.availableAmount).eq(13)
            toDecimal(recovery.review.before.reservedAmount).eq(7)
            toDecimal(recovery.review.after.unappliedTotal).eq(13)
            toDecimal(recovery.review.after.reservedAmount).isZero()
            toDecimal(recovery.review.after.heldRefundAmount).isZero()
            toDecimal(recovery.review.after.availableAmount).eq(13)
            toDecimal(recovery.review.after.providerRefundableAmount).eq(13)
            recovery.restored.failure.includes("TEST_PROVIDER_REFUND_ROLLBACK")
            recovery.restored.claim.status == "held"
            recovery.restored.holds.length == 2
            recovery.restored.holds.every(row => row.status === "held")
            recovery.restored.records == 0
            recovery.restored.outputs == 0
            recovery.restored.transactions == 0
            recovery.restored.applications == 0
            recovery.restored.operation == 0
            recovery.restored.draft.paymentTypeEnumId == "PtInvoicePayment"
            recovery.restored.draft.statusId == "PmntProposed"
            recovery.restored.attempt.financialState == "accepted_unposted"
            recovery.restored.attempt.cashPaymentId == null
            recovery.restored.review.status == "review"
            recovery.restored.review.operationKey == null
            recovery.result.financialState == "completed"
            record.refundControlGlAccountId == accountId
            toDecimal(summary.availableAmount).eq(recovery.review.after.availableAmount)
            toDecimal(summary.reservedAmount).eq(recovery.review.after.reservedAmount)
            toDecimal(summary.completedRefundAmount).eq(recovery.review.after.completedRefundAmount)
            Number(effect.invocationCount) == 1
            Number(effect.lookupCount) == 0
        }
    }
)
feature(
    "a clean legacy manual cash source adopts through the exact reviewed refund controller without rewriting its original day",
    {
        when() {
            const h = helper(),
                made = h.call("mantle.account.PaymentServices.create#Payment", {
                    fromPartyId: f.customer,
                    toPartyId: f.org,
                    paymentTypeEnumId: "PtInvoicePayment",
                    paymentInstrumentEnumId: "PiOther",
                    toPaymentMethodId: f.methodId,
                    amount: "25",
                    amountUomId: "USD",
                    effectiveDate: f.timestamp,
                    statusId: "PmntDelivered"
                }),
                paymentId = made.paymentId
            const before = h.lib.map(h.lib.one("mantle.account.payment.Payment", {paymentId})),
                manual = ec.resource.script("component://mr-mantle/test/AccountingPaymentRefundFixtures.js"),
                review = manual.preview(f, paymentId, {amount: "5"}),
                result = manual.confirm(review, "prv-ref-manual-adoption"),
                after = h.lib.one("mantle.account.payment.Payment", {paymentId})
            return {
                before,
                after,
                result,
                record: h.lib.one("mantle.account.payment.PaymentRefundRecord", {refundPaymentId: result.refundPaymentId})
            }
        },
        then({before, after, result, record}) {
            before.lifecycleManaged != "Y"
            after.lifecycleManaged == "Y"
            helper().lib.policy.calendarDateText(after.accountingDate) ==
                helper().lib.policy.calendarDateText(before.accountingDate)
            helper().lib.ms(after.effectiveDate) == helper().lib.ms(before.effectiveDate)
            result.reasonCode == "REFUND_COMPLETED"
            record.gatewayAttemptId == null
        }
    }
)
feature(
    "withdrawing a reference-refund guarantee after reservation prevents dispatch and preserves holds until exact nonexecution lookup",
    {
        when() {
            const h = helper(),
                cash = h.captured(f),
                paymentId = cash.cashPaymentId,
                review = h.gateway.preview(f, paymentId, "refund", {amount: "7"}),
                entity = "mantle.account.payment.PaymentGatewayTestControl",
                control = h.lib.one(entity, {paymentGatewayConfigId: f.gatewayId}),
                saved = h.lib.policy.pick(h.lib.map(control), [
                    "holdBeforePrepare",
                    "enteredPrepare",
                    "releasePrepare",
                    "barrierPaymentId",
                    "barrierAction",
                    "lookupNoExecution"
                ]),
                config = h.lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: f.gatewayId}),
                declarations = JSON.parse(config.reviewedGuaranteesJson),
                original = config.reviewedGuaranteesJson
            h.call("update#" + entity, {
                paymentGatewayConfigId: f.gatewayId,
                holdBeforePrepare: "Y",
                enteredPrepare: "N",
                releasePrepare: "N",
                barrierPaymentId: paymentId,
                barrierAction: "refund"
            })
            let results
            try {
                results = parallel(
                    2,
                    (thread, args) => {
                        login(args.username)
                        ec.artifactExecution.disableAuthz()
                        const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
                        if (thread === 0)
                            return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
                        const entered = () =>
                                lib
                                    .find("mantle.account.payment.PaymentGatewayTestControl", {
                                        paymentGatewayConfigId: args.gatewayId
                                    })
                                    .useCache(false)
                                    .one()?.enteredPrepare === "Y",
                            deadline = Date.now() + 15000
                        while (!entered() && Date.now() < deadline) {}
                        if (!entered())
                            throw new Error("TEST_REFUND_PREPARE_TIMEOUT: Reservation did not reach the pre-dispatch barrier")
                        const changed = JSON.parse(args.guarantees)
                        changed.refund.originalCaptureOnly = false
                        call("update#mantle.account.method.PaymentGatewayConfig", {
                            paymentGatewayConfigId: args.gatewayId,
                            reviewedGuaranteesJson: JSON.stringify(changed)
                        })
                        call("update#mantle.account.payment.PaymentGatewayTestControl", {
                            paymentGatewayConfigId: args.gatewayId,
                            releasePrepare: "Y"
                        })
                        return {changedAfterReservation: true}
                    },
                    {
                        username: ec.user.username,
                        gatewayId: f.gatewayId,
                        guarantees: original,
                        confirm: {
                            previewId: review.previewId,
                            inputFingerprint: review.inputFingerprint,
                            operationKey: "prv-ref-guarantee-withdrawn"
                        }
                    },
                    {transaction: false, timeout: 45}
                )
            } finally {
                h.call("update#mantle.account.method.PaymentGatewayConfig", {
                    paymentGatewayConfigId: f.gatewayId,
                    reviewedGuaranteesJson: original
                })
                h.call("update#" + entity, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
            }
            const result = results[0].result,
                held = h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {attemptId: result.attemptId}),
                effects = h.lib.find("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "refund"}).count()
            let declined
            try {
                h.call("update#" + entity, {paymentGatewayConfigId: f.gatewayId, lookupNoExecution: "Y"})
                declined = h.refresh(f, result.attemptId)
            } finally {
                h.call("update#" + entity, {paymentGatewayConfigId: f.gatewayId, lookupNoExecution: saved.lookupNoExecution})
            }
            return {
                result,
                held,
                effects,
                declined,
                changed: results[1].changedAfterReservation,
                released: h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {attemptId: result.attemptId})
            }
        },
        then({result, held, effects, declined, changed, released}) {
            changed == true
            result.providerState == "uncertain"
            result.cashPaymentId == null
            held.length == 2
            held.every(row => row.status === "held")
            effects == 0
            declined.providerState == "declined"
            declined.cashPaymentId == null
            released.every(row => row.status === "released")
        }
    }
)
