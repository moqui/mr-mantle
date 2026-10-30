// External acceptance survives authority loss during I/O; only currently authorized reviewed local money may follow.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GWAUTH")
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
feature("accepted capture retains its evidence and hold when permission authority disappears during provider I/O", {
    when() {
        const h = helper(),
            username = f.users.gatewayTreasuryNoLedger,
            paymentId = h.draft(f)
        login(username)
        h.execute(h.preview(f, paymentId))
        const review = h.preview(f, paymentId, "capture", {amount: "20"}),
            controlEntity = "mantle.account.payment.PaymentGatewayTestControl",
            saved = h.lib.policy.pick(h.lib.map(h.lib.one(controlEntity, {paymentGatewayConfigId: f.gatewayId})), [
                "holdAfterAccept",
                "releaseProvider",
                "barrierPaymentId",
                "barrierAction"
            ]),
            actor = h.lib.one("moqui.security.UserAccount", {username}),
            mutation =
                "permission" === "permission"
                    ? {
                          service: "update#moqui.security.UserGroupPermission",
                          values: {
                              userGroupId: username,
                              userPermissionId: "PAYMENT_EDIT",
                              fromDate: 0,
                              thruDate: Number(f.timestamp) - 86400000
                          }
                      }
                    : "permission" === "organization"
                      ? {
                            service: "update#mantle.party.PartyRelationship",
                            values: {
                                partyRelationshipId: h.lib.one("mantle.party.PartyRelationship", {
                                    fromPartyId: actor.partyId,
                                    toPartyId: f.org,
                                    relationshipTypeEnumId: "PrtAgent"
                                }).partyRelationshipId,
                                thruDate: Number(f.timestamp) - 86400000
                            }
                        }
                      : {
                            service: "update#mantle.party.Party",
                            values: {
                                partyId: f.customer,
                                privateOwnerUserId: h.lib.one("moqui.security.UserAccount", {username: "john.doe"}).userId
                            }
                        },
            restore = Object.assign(
                {},
                mutation.values,
                "permission" === "private" ? {privateOwnerUserId: null} : {thruDate: null}
            )
        login("john.doe")
        h.call("update#" + controlEntity, {
            paymentGatewayConfigId: f.gatewayId,
            holdAfterAccept: "Y",
            releaseProvider: "N",
            barrierPaymentId: paymentId,
            barrierAction: "capture"
        })
        let results
        try {
            results = parallel(
                2,
                (thread, args) => {
                    login(thread === 0 ? args.username : "john.doe")
                    ec.artifactExecution.disableAuthz()
                    if (thread === 0) {
                        try {
                            return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
                        } catch (error) {
                            ec.message.clearErrors()
                            return {failure: error.message}
                        }
                    }
                    const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js"),
                        accepted = () =>
                            lib
                                .find("mantle.account.payment.PaymentGatewayTestEffect", {
                                    paymentId: args.paymentId,
                                    action: "capture",
                                    outcome: "accepted"
                                })
                                .useCache(false)
                                .one(),
                        deadline = Date.now() + 15000
                    try {
                        while (!accepted() && Date.now() < deadline) {}
                        if (!accepted()) throw new Error("TEST_AUTHORITY_BARRIER_TIMEOUT: Provider acceptance was not committed")
                        call(args.mutation.service, args.mutation.values)
                        return {acceptedBeforeAuthorityLoss: true}
                    } finally {
                        call("update#mantle.account.payment.PaymentGatewayTestControl", {
                            paymentGatewayConfigId: args.gatewayId,
                            releaseProvider: "Y"
                        })
                    }
                },
                {
                    username,
                    paymentId,
                    gatewayId: f.gatewayId,
                    mutation,
                    confirm: {
                        previewId: review.previewId,
                        inputFingerprint: review.inputFingerprint,
                        operationKey: "gwa-loss-" + "permission"
                    }
                },
                {transaction: false, timeout: 60}
            )
        } finally {
            login("john.doe")
            h.call(mutation.service, restore)
            h.call("update#" + controlEntity, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
        }
        const attempt = h.lib.one("mantle.account.payment.PaymentGatewayAttempt", {paymentId, action: "capture"}),
            held = h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {
                attemptId: attempt.attemptId,
                status: "held"
            }),
            cashBefore = h.lib.one("mantle.account.payment.Payment", {paymentId: attempt.cashPaymentId}),
            outputsBefore = h.lifecycle.count("mantle.account.payment.PaymentIssuedOutput", {
                paymentId: attempt.cashPaymentId
            }),
            receipt = JSON.parse(attempt.receiptJson || "{}")
        login(username)
        const current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: attempt.attemptId}),
            recovery = h.native("preview#PaymentGatewayRecovery", {
                organizationPartyId: f.org,
                attemptId: attempt.attemptId,
                attemptVersion: current.attemptVersion,
                reason: "Authority restored; complete accepted money without another charge"
            }),
            completed = h.native("complete#PaymentGatewayAttempt", {
                previewId: recovery.previewId,
                inputFingerprint: recovery.inputFingerprint,
                operationKey: "gwa-recover-" + "permission"
            })
        return {
            results,
            attempt,
            held,
            cashBefore,
            outputsBefore,
            receipt,
            completed,
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
        }
    },
    then({results, attempt, held, cashBefore, outputsBefore, receipt, completed, effect}) {
        results[1].acceptedBeforeAuthorityLoss == true
        results[0].result?.financialState !== "completed"
        Boolean(results[0].failure || results[0].result?.financialState === "accepted_unposted")
        attempt.providerState == "accepted"
        attempt.financialState == "accepted_unposted"
        receipt.outcome == "accepted"
        receipt.providerOperationId == attempt.providerOperationId
        toDecimal(receipt.amount).eq(20)
        held.length == 1
        toDecimal(held[0].amount).eq(20)
        cashBefore == null
        outputsBefore == 0
        completed.financialState == "completed"
        completed.attemptId == attempt.attemptId
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 0
    }
})

feature("accepted capture retains its evidence and hold when organization authority disappears during provider I/O", {
    when() {
        const h = helper(),
            username = f.users.gatewayTreasuryNoLedger,
            paymentId = h.draft(f)
        login(username)
        h.execute(h.preview(f, paymentId))
        const review = h.preview(f, paymentId, "capture", {amount: "20"}),
            controlEntity = "mantle.account.payment.PaymentGatewayTestControl",
            saved = h.lib.policy.pick(h.lib.map(h.lib.one(controlEntity, {paymentGatewayConfigId: f.gatewayId})), [
                "holdAfterAccept",
                "releaseProvider",
                "barrierPaymentId",
                "barrierAction"
            ]),
            actor = h.lib.one("moqui.security.UserAccount", {username}),
            mutation =
                "organization" === "permission"
                    ? {
                          service: "update#moqui.security.UserGroupPermission",
                          values: {
                              userGroupId: username,
                              userPermissionId: "PAYMENT_EDIT",
                              fromDate: 0,
                              thruDate: Number(f.timestamp) - 86400000
                          }
                      }
                    : "organization" === "organization"
                      ? {
                            service: "update#mantle.party.PartyRelationship",
                            values: {
                                partyRelationshipId: h.lib.one("mantle.party.PartyRelationship", {
                                    fromPartyId: actor.partyId,
                                    toPartyId: f.org,
                                    relationshipTypeEnumId: "PrtAgent"
                                }).partyRelationshipId,
                                thruDate: Number(f.timestamp) - 86400000
                            }
                        }
                      : {
                            service: "update#mantle.party.Party",
                            values: {
                                partyId: f.customer,
                                privateOwnerUserId: h.lib.one("moqui.security.UserAccount", {username: "john.doe"}).userId
                            }
                        },
            restore = Object.assign(
                {},
                mutation.values,
                "organization" === "private" ? {privateOwnerUserId: null} : {thruDate: null}
            )
        login("john.doe")
        h.call("update#" + controlEntity, {
            paymentGatewayConfigId: f.gatewayId,
            holdAfterAccept: "Y",
            releaseProvider: "N",
            barrierPaymentId: paymentId,
            barrierAction: "capture"
        })
        let results
        try {
            results = parallel(
                2,
                (thread, args) => {
                    login(thread === 0 ? args.username : "john.doe")
                    ec.artifactExecution.disableAuthz()
                    if (thread === 0) {
                        try {
                            return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
                        } catch (error) {
                            ec.message.clearErrors()
                            return {failure: error.message}
                        }
                    }
                    const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js"),
                        accepted = () =>
                            lib
                                .find("mantle.account.payment.PaymentGatewayTestEffect", {
                                    paymentId: args.paymentId,
                                    action: "capture",
                                    outcome: "accepted"
                                })
                                .useCache(false)
                                .one(),
                        deadline = Date.now() + 15000
                    try {
                        while (!accepted() && Date.now() < deadline) {}
                        if (!accepted()) throw new Error("TEST_AUTHORITY_BARRIER_TIMEOUT: Provider acceptance was not committed")
                        call(args.mutation.service, args.mutation.values)
                        return {acceptedBeforeAuthorityLoss: true}
                    } finally {
                        call("update#mantle.account.payment.PaymentGatewayTestControl", {
                            paymentGatewayConfigId: args.gatewayId,
                            releaseProvider: "Y"
                        })
                    }
                },
                {
                    username,
                    paymentId,
                    gatewayId: f.gatewayId,
                    mutation,
                    confirm: {
                        previewId: review.previewId,
                        inputFingerprint: review.inputFingerprint,
                        operationKey: "gwa-loss-" + "organization"
                    }
                },
                {transaction: false, timeout: 60}
            )
        } finally {
            login("john.doe")
            h.call(mutation.service, restore)
            h.call("update#" + controlEntity, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
        }
        const attempt = h.lib.one("mantle.account.payment.PaymentGatewayAttempt", {paymentId, action: "capture"}),
            held = h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {
                attemptId: attempt.attemptId,
                status: "held"
            }),
            cashBefore = h.lib.one("mantle.account.payment.Payment", {paymentId: attempt.cashPaymentId}),
            outputsBefore = h.lifecycle.count("mantle.account.payment.PaymentIssuedOutput", {
                paymentId: attempt.cashPaymentId
            }),
            receipt = JSON.parse(attempt.receiptJson || "{}")
        login(username)
        const current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: attempt.attemptId}),
            recovery = h.native("preview#PaymentGatewayRecovery", {
                organizationPartyId: f.org,
                attemptId: attempt.attemptId,
                attemptVersion: current.attemptVersion,
                reason: "Authority restored; complete accepted money without another charge"
            }),
            completed = h.native("complete#PaymentGatewayAttempt", {
                previewId: recovery.previewId,
                inputFingerprint: recovery.inputFingerprint,
                operationKey: "gwa-recover-" + "organization"
            })
        return {
            results,
            attempt,
            held,
            cashBefore,
            outputsBefore,
            receipt,
            completed,
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
        }
    },
    then({results, attempt, held, cashBefore, outputsBefore, receipt, completed, effect}) {
        results[1].acceptedBeforeAuthorityLoss == true
        results[0].result?.financialState !== "completed"
        Boolean(results[0].failure || results[0].result?.financialState === "accepted_unposted")
        attempt.providerState == "accepted"
        attempt.financialState == "accepted_unposted"
        receipt.outcome == "accepted"
        receipt.providerOperationId == attempt.providerOperationId
        toDecimal(receipt.amount).eq(20)
        held.length == 1
        toDecimal(held[0].amount).eq(20)
        cashBefore == null
        outputsBefore == 0
        completed.financialState == "completed"
        completed.attemptId == attempt.attemptId
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 0
    }
})

feature("accepted capture retains its evidence and hold when private authority disappears during provider I/O", {
    when() {
        const h = helper(),
            username = f.users.gatewayTreasuryNoLedger,
            paymentId = h.draft(f)
        login(username)
        h.execute(h.preview(f, paymentId))
        const review = h.preview(f, paymentId, "capture", {amount: "20"}),
            controlEntity = "mantle.account.payment.PaymentGatewayTestControl",
            saved = h.lib.policy.pick(h.lib.map(h.lib.one(controlEntity, {paymentGatewayConfigId: f.gatewayId})), [
                "holdAfterAccept",
                "releaseProvider",
                "barrierPaymentId",
                "barrierAction"
            ]),
            actor = h.lib.one("moqui.security.UserAccount", {username}),
            mutation =
                "private" === "permission"
                    ? {
                          service: "update#moqui.security.UserGroupPermission",
                          values: {
                              userGroupId: username,
                              userPermissionId: "PAYMENT_EDIT",
                              fromDate: 0,
                              thruDate: Number(f.timestamp) - 86400000
                          }
                      }
                    : "private" === "organization"
                      ? {
                            service: "update#mantle.party.PartyRelationship",
                            values: {
                                partyRelationshipId: h.lib.one("mantle.party.PartyRelationship", {
                                    fromPartyId: actor.partyId,
                                    toPartyId: f.org,
                                    relationshipTypeEnumId: "PrtAgent"
                                }).partyRelationshipId,
                                thruDate: Number(f.timestamp) - 86400000
                            }
                        }
                      : {
                            service: "update#mantle.party.Party",
                            values: {
                                partyId: f.customer,
                                privateOwnerUserId: h.lib.one("moqui.security.UserAccount", {username: "john.doe"}).userId
                            }
                        },
            restore = Object.assign({}, mutation.values, "private" === "private" ? {privateOwnerUserId: null} : {thruDate: null})
        login("john.doe")
        h.call("update#" + controlEntity, {
            paymentGatewayConfigId: f.gatewayId,
            holdAfterAccept: "Y",
            releaseProvider: "N",
            barrierPaymentId: paymentId,
            barrierAction: "capture"
        })
        let results
        try {
            results = parallel(
                2,
                (thread, args) => {
                    login(thread === 0 ? args.username : "john.doe")
                    ec.artifactExecution.disableAuthz()
                    if (thread === 0) {
                        try {
                            return {result: call("mantle.account.PaymentServices.execute#PaymentGatewayAction", args.confirm)}
                        } catch (error) {
                            ec.message.clearErrors()
                            return {failure: error.message}
                        }
                    }
                    const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js"),
                        accepted = () =>
                            lib
                                .find("mantle.account.payment.PaymentGatewayTestEffect", {
                                    paymentId: args.paymentId,
                                    action: "capture",
                                    outcome: "accepted"
                                })
                                .useCache(false)
                                .one(),
                        deadline = Date.now() + 15000
                    try {
                        while (!accepted() && Date.now() < deadline) {}
                        if (!accepted()) throw new Error("TEST_AUTHORITY_BARRIER_TIMEOUT: Provider acceptance was not committed")
                        call(args.mutation.service, args.mutation.values)
                        return {acceptedBeforeAuthorityLoss: true}
                    } finally {
                        call("update#mantle.account.payment.PaymentGatewayTestControl", {
                            paymentGatewayConfigId: args.gatewayId,
                            releaseProvider: "Y"
                        })
                    }
                },
                {
                    username,
                    paymentId,
                    gatewayId: f.gatewayId,
                    mutation,
                    confirm: {
                        previewId: review.previewId,
                        inputFingerprint: review.inputFingerprint,
                        operationKey: "gwa-loss-" + "private"
                    }
                },
                {transaction: false, timeout: 60}
            )
        } finally {
            login("john.doe")
            h.call(mutation.service, restore)
            h.call("update#" + controlEntity, Object.assign({paymentGatewayConfigId: f.gatewayId}, saved))
        }
        const attempt = h.lib.one("mantle.account.payment.PaymentGatewayAttempt", {paymentId, action: "capture"}),
            held = h.lib.rows("mantle.account.payment.PaymentGatewayReservation", {
                attemptId: attempt.attemptId,
                status: "held"
            }),
            cashBefore = h.lib.one("mantle.account.payment.Payment", {paymentId: attempt.cashPaymentId}),
            outputsBefore = h.lifecycle.count("mantle.account.payment.PaymentIssuedOutput", {
                paymentId: attempt.cashPaymentId
            }),
            receipt = JSON.parse(attempt.receiptJson || "{}")
        login(username)
        const current = h.native("get#PaymentGatewayAttempt", {organizationPartyId: f.org, attemptId: attempt.attemptId}),
            recovery = h.native("preview#PaymentGatewayRecovery", {
                organizationPartyId: f.org,
                attemptId: attempt.attemptId,
                attemptVersion: current.attemptVersion,
                reason: "Authority restored; complete accepted money without another charge"
            }),
            completed = h.native("complete#PaymentGatewayAttempt", {
                previewId: recovery.previewId,
                inputFingerprint: recovery.inputFingerprint,
                operationKey: "gwa-recover-" + "private"
            })
        return {
            results,
            attempt,
            held,
            cashBefore,
            outputsBefore,
            receipt,
            completed,
            effect: h.lib.one("mantle.account.payment.PaymentGatewayTestEffect", {paymentId, action: "capture"})
        }
    },
    then({results, attempt, held, cashBefore, outputsBefore, receipt, completed, effect}) {
        results[1].acceptedBeforeAuthorityLoss == true
        results[0].result?.financialState !== "completed"
        Boolean(results[0].failure || results[0].result?.financialState === "accepted_unposted")
        attempt.providerState == "accepted"
        attempt.financialState == "accepted_unposted"
        receipt.outcome == "accepted"
        receipt.providerOperationId == attempt.providerOperationId
        toDecimal(receipt.amount).eq(20)
        held.length == 1
        toDecimal(held[0].amount).eq(20)
        cashBefore == null
        outputsBefore == 0
        completed.financialState == "completed"
        completed.attemptId == attempt.attemptId
        Number(effect.invocationCount) == 1
        Number(effect.lookupCount) == 0
    }
})
