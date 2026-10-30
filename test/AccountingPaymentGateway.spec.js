// Standalone gateway authorization/capture/release acceptance. Provider effects are independently committed evidence.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentGatewayFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_GATEWAY")
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

feature("gateway draft bindings and authorization review are real scoped reads without provider effects or cash", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            choices = h.native("find#PaymentGatewayBindings", {
                organizationPartyId: f.org,
                paymentId,
                action: "authorize",
                effectiveDate: f.timestamp
            }),
            option = choices.rows.find(row => row.paymentGatewayConfigId === f.gatewayId),
            review = h.preview(f, paymentId, "authorize", {
                paymentGatewayConfigId: f.gatewayId,
                gatewayBindingVersion: option?.bindingVersion
            }),
            again = h.native("get#PaymentGatewayActionPreview", {organizationPartyId: f.org, previewId: review.previewId})
        return {
            choices,
            option,
            review,
            again,
            payment: h.lib.one("mantle.account.payment.Payment", {paymentId}),
            attemptCount: h.lifecycle.count("mantle.account.payment.PaymentGatewayAttempt", {paymentId}),
            providerCount: h.lifecycle.count("mantle.account.payment.PaymentGatewayTestEffect", {paymentId}),
            transactionCount: h.lifecycle.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            outputCount: h.lifecycle.count("mantle.account.payment.PaymentIssuedOutput", {paymentId})
        }
    },
    then({choices, option, review, again, payment, attemptCount, providerCount, transactionCount, outputCount}) {
        choices.complete == true
        choices.recordCount == 1
        choices.pageRangeLow == 1
        choices.pageRangeHigh == 1
        option.capabilities.canAuthorize == true
        option.capabilities.canCapture == true
        option.capabilities.canRefund == false
        option.bindingVersion != null
        option.reviewedOperationServiceName == null
        option.merchantNamespace == null
        review.previewKind == "gatewayAction"
        review.financialOnly == false
        review.canApply == true
        toDecimal(review.paymentSummary.amount).eq(60)
        review.gatewaySummary.paymentGatewayConfigId == f.gatewayId
        review.postingSummary.cashPostingCount == 0
        review.applicationEffects.length == 0
        again.inputFingerprint == review.inputFingerprint
        again.paymentSummary.amount == review.paymentSummary.amount
        payment.statusId == "PmntProposed"
        payment.lifecycleManaged == "Y"
        payment.gatewayRole == null
        attemptCount == 0
        providerCount == 0
        transactionCount == 0
        outputCount == 0
    }
})

feature("same valid authorization payload requires both broad read and payment edit even artifact-off", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            request = h.request(f, paymentId),
            choices = {organizationPartyId: f.org, paymentId, effectiveDate: f.timestamp}
        const errors = []
        for (const username of [f.users.ar, f.users.paymentView, f.users.paymentEditOnly]) {
            login(username)
            errors.push(h.lifecycle.rejected("preview#PaymentGatewayAction", request))
            errors.push(h.lifecycle.rejected("find#PaymentGatewayBindings", choices))
        }
        login(f.users.gatewayTreasuryNoLedger)
        const positive = h.native("preview#PaymentGatewayAction", request),
            retained = h.native("get#PaymentGatewayActionPreview", {previewId: positive.previewId, organizationPartyId: f.org})
        return {errors, positive, retained}
    },
    then({errors, positive, retained}) {
        errors.length == 6
        errors.every(message => message.includes("PERMISSION_DENIED"))
        positive.canApply == true
        toDecimal(positive.paymentSummary.amount).eq(60)
        positive.ledgerPreview == null
        retained.ledgerPreview == null
        toDecimal(retained.paymentSummary.amount).eq(60)
    }
})

feature("gateway adoption is default-off independently of settlement and refusal leaves no instruction or external effect", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            request = h.request(f, paymentId)
        h.call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            paymentGatewayWorkflowEnabled: "N"
        })
        let refusal, detail
        try {
            refusal = h.lifecycle.rejected("preview#PaymentGatewayAction", request)
            detail = h.lifecycle.detail(f, paymentId)
        } finally {
            h.call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: f.org,
                paymentGatewayWorkflowEnabled: "Y"
            })
        }
        return {
            refusal,
            detail,
            positive: h.native("preview#PaymentGatewayAction", request),
            instructions: h.lifecycle.count("mantle.account.payment.PaymentGatewayInstruction", {paymentId}),
            effects: h.lifecycle.count("mantle.account.payment.PaymentGatewayTestEffect", {paymentId})
        }
    },
    then({refusal, detail, positive, instructions, effects}) {
        refusal.includes("GATEWAY_WORKFLOW_REQUIRED")
        detail.capabilities.canGatewayAuthorize == false
        positive.canApply == true
        instructions == 0
        effects == 0
    }
})

feature("retained gateway review keeps frozen financial summary after a later draft edit", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            review = h.preview(f, paymentId),
            before = h.lifecycle.detail(f, paymentId),
            gatewayMethod = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId}),
            methodVersion = ec.resource
                .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
                .methodVersion(gatewayMethod)
        h.native(
            "store#PaymentDraft",
            h.lifecycle.request(f, {
                paymentId,
                sourceVersion: before.sourceVersion,
                amount: "65",
                paymentInstrumentEnumId: "PiAch",
                counterpartyPaymentMethodId: f.customerMethodId,
                counterpartyMethodVersion: methodVersion
            })
        )
        return {
            review,
            current: h.lifecycle.detail(f, paymentId),
            retained: h.native("get#PaymentGatewayActionPreview", {organizationPartyId: f.org, previewId: review.previewId})
        }
    },
    then({review, current, retained}) {
        toDecimal(current.payment.amount).eq(65)
        retained.paymentSummary.amount == review.paymentSummary.amount
        toDecimal(retained.paymentSummary.amount).eq(60)
        retained.inputFingerprint == review.inputFingerprint
    }
})

feature("chosen binding revisions and declared adapter guarantees are authoritative before provider I/O", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            option = h.native("find#PaymentGatewayBindings", {organizationPartyId: f.org, paymentId, effectiveDate: f.timestamp})
                .rows[0],
            config = h.lib.one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: f.gatewayId}),
            oldGuarantees = config.reviewedGuaranteesJson
        let unsupported, stale
        try {
            h.call("update#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gatewayId,
                reviewedGuaranteesJson: JSON.stringify({authorize: {enabled: false, idempotent: true, exactLookup: true}})
            })
            unsupported = h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId))
            stale = h.lifecycle.rejected(
                "preview#PaymentGatewayAction",
                h.request(f, paymentId, "authorize", {
                    paymentGatewayConfigId: f.gatewayId,
                    gatewayBindingVersion: option.bindingVersion
                })
            )
        } finally {
            h.call("update#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gatewayId,
                reviewedGuaranteesJson: oldGuarantees
            })
        }
        return {
            unsupported,
            stale,
            positive: h.preview(f, paymentId),
            effects: h.lifecycle.count("mantle.account.payment.PaymentGatewayTestEffect", {paymentId})
        }
    },
    then({unsupported, stale, positive, effects}) {
        unsupported.includes("GATEWAY_ADAPTER_UNSUPPORTED")
        stale.includes("STALE_GATEWAY_BINDING")
        positive.canApply == true
        effects == 0
    }
})

feature("foreign and private payment sources refuse the same complete gateway request", {
    when() {
        const h = helper(),
            other = h.fixtures("ACCT_P5_GWO"),
            paymentId = h.draft(other),
            foreign = h.request(other, paymentId),
            ownId = h.draft(f),
            privateRequest = h.request(f, ownId)
        h.call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: f.users.read})
        let foreignDenied, privateDenied, positive
        try {
            login(f.users.treasury)
            foreignDenied = h.lifecycle.rejected("preview#PaymentGatewayAction", foreign)
            privateDenied = h.lifecycle.rejected("preview#PaymentGatewayAction", privateRequest)
            login("john.doe")
            positive = h.native("preview#PaymentGatewayAction", privateRequest)
        } finally {
            login("john.doe")
            h.call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: null})
        }
        return {foreignDenied, privateDenied, positive}
    },
    then({foreignDenied, privateDenied, positive}) {
        foreignDenied.includes("ORGANIZATION_DENIED")
        privateDenied.includes("PAYMENT_UNAVAILABLE")
        positive.canApply == true
    }
})

feature("artifact-off generic writers cannot rewrite retained reviews or forge gateway money and capacity", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            review = h.preview(f, paymentId),
            errors = [
                h.lifecycle.rejected("update#mantle.account.payment.PaymentGatewayPreview", {
                    previewId: review.previewId,
                    payloadJson: "{}"
                }),
                h.lifecycle.rejected("delete#mantle.account.payment.PaymentGatewayPreview", {previewId: review.previewId}),
                h.lifecycle.rejected("create#mantle.account.payment.PaymentGatewayAttempt", {
                    attemptId: "forged-" + paymentId,
                    organizationPartyId: f.org,
                    paymentId,
                    action: "authorize",
                    amount: "60",
                    currencyUomId: "USD",
                    providerState: "accepted",
                    financialState: "completed"
                }),
                h.lifecycle.rejected("create#mantle.account.payment.PaymentGatewayReservation", {
                    reservationId: "forged-" + paymentId,
                    organizationPartyId: f.org,
                    paymentId,
                    holdKind: "cash",
                    status: "held",
                    amount: "60",
                    currencyUomId: "USD"
                })
            ]
        return {
            errors,
            retained: h.native("get#PaymentGatewayActionPreview", {previewId: review.previewId}),
            attempts: h.lifecycle.count("mantle.account.payment.PaymentGatewayAttempt", {paymentId}),
            holds: h.lifecycle.count("mantle.account.payment.PaymentGatewayReservation", {paymentId})
        }
    },
    then({errors, retained, attempts, holds}) {
        errors[0].includes("GATEWAY_REVIEW_REQUIRED")
        errors[1].includes("GATEWAY_RECORD_IMMUTABLE")
        errors[2].includes("GATEWAY_REVIEW_REQUIRED")
        errors[3].includes("GATEWAY_REVIEW_REQUIRED")
        toDecimal(retained.paymentSummary.amount).eq(60)
        attempts == 0
        holds == 0
    }
})

feature("a retained review owner losing edit authority keeps a read-only summary with honest action flags", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        login(f.users.gatewayAdmin)
        const review = h.preview(f, paymentId)
        login("john.doe")
        h.call("update#moqui.security.UserGroupPermission", {
            userGroupId: f.users.gatewayAdmin,
            userPermissionId: "PAYMENT_EDIT",
            fromDate: 0,
            thruDate: Number(f.timestamp) - 86400000
        })
        let retained
        try {
            login(f.users.gatewayAdmin)
            retained = h.native("get#PaymentGatewayActionPreview", {organizationPartyId: f.org, previewId: review.previewId})
        } finally {
            login("john.doe")
            h.call("update#moqui.security.UserGroupPermission", {
                userGroupId: f.users.gatewayAdmin,
                userPermissionId: "PAYMENT_EDIT",
                fromDate: 0,
                thruDate: null
            })
        }
        return {retained}
    },
    then({retained}) {
        toDecimal(retained.paymentSummary.amount).eq(60)
        retained.canApply == false
        retained.capabilities.canGatewayAuthorize == false
        retained.capabilities.canGatewayRefresh == false
        retained.capabilities.canGatewayRecover == false
        retained.capabilities.gatewayReasons.includes("PERMISSION_DENIED")
        retained.capabilities.canReadLedger == true
    }
})

feature("an explicit safe gateway choice cannot convert a plain cash source into a provider instruction", {
    when() {
        const h = helper(),
            paymentId = h.lifecycle.draft(f, {paymentInstrumentEnumId: "PiCash"}),
            request = h.request(f, paymentId, "authorize", {
                paymentGatewayConfigId: f.gatewayId,
                gatewayBindingVersion: "explicit-unrelated-choice"
            }),
            refusal = h.lifecycle.rejected("preview#PaymentGatewayAction", request),
            detail = h.lifecycle.detail(f, paymentId),
            positive = h.preview(f, h.draft(f))
        return {refusal, detail, positive}
    },
    then({refusal, detail, positive}) {
        refusal.includes("GATEWAY_PAYMENT_INELIGIBLE")
        detail.capabilities.canGatewayAuthorize == false
        detail.capabilities.gatewayReasons.includes("GATEWAY_PAYMENT_INELIGIBLE")
        positive.canApply == true
    }
})

feature("binding action eligibility and search apply before count and pagination with selected labels retained", {
    when() {
        const h = helper(),
            paymentId = h.draft(f)
        for (let index = 0; index < 2; index++) {
            const id = f.gatewayId + "_U" + index
            h.call("create#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: id,
                description: "A legacy unsupported " + index,
                paymentGatewayTypeEnumId: "PgtTest"
            })
            h.call("create#mantle.account.method.PaymentGatewayOrganization", {
                organizationPartyId: f.org,
                paymentGatewayConfigId: id,
                fromDate: 0,
                isEnabled: "Y"
            })
        }
        const page = h.native("find#PaymentGatewayBindings", {
                organizationPartyId: f.org,
                paymentId,
                action: "authorize",
                effectiveDate: f.timestamp,
                pageSize: 1
            }),
            filtered = h.native("find#PaymentGatewayBindings", {
                organizationPartyId: f.org,
                paymentId,
                action: "authorize",
                effectiveDate: f.timestamp,
                text: "no matching provider",
                selectedIdList: [f.gatewayId],
                pageSize: 1
            })
        return {page, filtered}
    },
    then({page, filtered}) {
        page.recordCount == 1
        page.rows.length == 1
        page.rows[0].paymentGatewayConfigId == f.gatewayId
        page.rows[0].capabilities.canAuthorize == true
        filtered.recordCount == 0
        filtered.rows.length == 0
        filtered.selectedRows.length == 1
        filtered.selectedRows[0].paymentGatewayConfigId == f.gatewayId
        filtered.selectedRows[0].bindingVersion == page.rows[0].bindingVersion
        page.complete == true
        filtered.complete == true
    }
})

feature("org-wide provider filters expose only scoped legacy identities with exact legacy outcome paging", {
    when() {
        const h = helper(),
            paymentId = h.native("create#Payment", {
                fromPartyId: f.customer,
                toPartyId: f.org,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiAch",
                paymentMethodId: f.customerMethodId,
                toPaymentMethodId: f.methodId,
                paymentGatewayConfigId: f.gatewayId,
                statusId: "PmntProposed",
                amount: "5",
                amountUomId: "USD",
                effectiveDate: f.timestamp
            }).paymentId
        for (const [referenceNum, resultSuccess, resultDeclined] of [
            ["LEGACY-ACCEPTED", "Y", "N"],
            ["LEGACY-DECLINED", "N", "Y"]
        ])
            h.call("create#mantle.account.method.PaymentGatewayResponse", {
                paymentId,
                paymentGatewayConfigId: f.gatewayId,
                paymentOperationEnumId: "PgoAuthorize",
                amount: "5",
                amountUomId: "USD",
                transactionDate: f.timestamp,
                referenceNum,
                resultSuccess,
                resultDeclined
            })
        login(f.users.treasury)
        const providers = h.native("find#PaymentGatewayProviders", {organizationPartyId: f.org, pageSize: 1}),
            selected = h.native("find#PaymentGatewayProviders", {
                organizationPartyId: f.org,
                text: "no match",
                selectedIdList: [f.gatewayId]
            }),
            declined = h.native("find#PaymentGatewayTransactions", {
                organizationPartyId: f.org,
                paymentId,
                outcome: "declined",
                pageSize: 1
            })
        login(f.users.paymentView)
        const refusal = h.lifecycle.rejected("find#PaymentGatewayProviders", {organizationPartyId: f.org})
        return {providers, selected, declined, refusal}
    },
    then({providers, selected, declined, refusal}) {
        providers.recordCount == 1
        providers.rows[0].paymentGatewayConfigId == f.gatewayId
        providers.rows[0].description == "Reviewed fixture gateway"
        Object.keys(providers.rows[0]).sort().join(",") == "description,paymentGatewayConfigId"
        selected.recordCount == 0
        selected.selectedRows.length == 1
        declined.recordCount == 1
        declined.rows[0].isLegacy == true
        declined.rows[0].providerState == "declined"
        declined.rows[0].referenceNum == "LEGACY-DECLINED"
        refusal.includes("PERMISSION_DENIED")
    }
})

feature("an eligible card without a default gateway can open and review an explicitly approved binding", {
    when() {
        const h = helper(),
            cardId = f.org + "_CARD"
        h.call("create#mantle.account.method.PaymentMethod", {
            paymentMethodId: cardId,
            ownerPartyId: f.customer,
            paymentMethodTypeEnumId: "PmtCreditCard",
            currencyUomId: "USD",
            fromDate: 0,
            description: "Card without a gateway default"
        })
        h.call("create#mantle.account.method.CreditCard", {
            paymentMethodId: cardId,
            creditCardTypeEnumId: "CctVisa",
            cardNumber: "4111111111111111",
            expireDate: "12/2030"
        })
        const method = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: cardId}),
            paymentId = h.lifecycle.draft(f, {
                paymentInstrumentEnumId: "PiCreditCard",
                counterpartyPaymentMethodId: cardId,
                counterpartyMethodVersion: ec.resource
                    .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
                    .methodVersion(method)
            }),
            detail = h.lifecycle.detail(f, paymentId),
            choices = h.native("find#PaymentGatewayBindings", {
                organizationPartyId: f.org,
                paymentId,
                action: "authorize",
                effectiveDate: f.timestamp
            }),
            option = choices.rows.find(row => row.paymentGatewayConfigId === f.gatewayId),
            explicit = h.preview(f, paymentId, "authorize", {
                paymentGatewayConfigId: option.paymentGatewayConfigId,
                gatewayBindingVersion: option.bindingVersion
            }),
            missingChoice = h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId))
        return {detail, choices, explicit, missingChoice, parent: h.lib.one("mantle.account.payment.Payment", {paymentId})}
    },
    then({detail, choices, explicit, missingChoice, parent}) {
        parent.paymentGatewayConfigId == null
        detail.capabilities.canGatewayAuthorize == true
        detail.capabilities.canManualDeliver == false
        choices.rows.some(row => row.paymentGatewayConfigId === f.gatewayId && row.capabilities.canAuthorize)
        explicit.canApply == true
        explicit.gatewaySummary.paymentGatewayConfigId == f.gatewayId
        missingChoice.includes("GATEWAY_BINDING_REQUIRED")
    }
})

feature("an unsupported default leaves an eligible initial draft able to explicitly choose another safe gateway", {
    when() {
        const h = helper(),
            defaultId = f.gatewayId + "_DEFAULT",
            methodId = f.org + "_ALT_BANK"
        h.call("create#mantle.account.method.PaymentGatewayConfig", {
            paymentGatewayConfigId: defaultId,
            description: "Unsupported default provider",
            paymentGatewayTypeEnumId: "PgtTest"
        })
        h.call("create#mantle.account.method.PaymentGatewayOrganization", {
            organizationPartyId: f.org,
            paymentGatewayConfigId: defaultId,
            fromDate: 0,
            isEnabled: "Y"
        })
        h.call("create#mantle.account.method.PaymentMethod", {
            paymentMethodId: methodId,
            ownerPartyId: f.customer,
            paymentMethodTypeEnumId: "PmtBankAccount",
            currencyUomId: "USD",
            fromDate: 0,
            paymentGatewayConfigId: defaultId
        })
        h.call("create#mantle.account.method.BankAccount", {
            paymentMethodId: methodId,
            typeEnumId: "BatChecking",
            accountNumber: "987654321",
            routingNumber: "111000025"
        })
        const method = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: methodId}),
            paymentId = h.lifecycle.draft(f, {
                paymentInstrumentEnumId: "PiAch",
                counterpartyPaymentMethodId: methodId,
                counterpartyMethodVersion: ec.resource
                    .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
                    .methodVersion(method)
            }),
            detail = h.lifecycle.detail(f, paymentId),
            choices = h.native("find#PaymentGatewayBindings", {
                organizationPartyId: f.org,
                paymentId,
                action: "authorize",
                effectiveDate: f.timestamp
            }),
            safe = choices.rows.find(row => row.paymentGatewayConfigId === f.gatewayId),
            refusedDefault = h.lifecycle.rejected("preview#PaymentGatewayAction", h.request(f, paymentId)),
            explicit = h.preview(f, paymentId, "authorize", {
                paymentGatewayConfigId: safe.paymentGatewayConfigId,
                gatewayBindingVersion: safe.bindingVersion
            })
        return {detail, choices, refusedDefault, explicit}
    },
    then({detail, choices, refusedDefault, explicit}) {
        detail.capabilities.canGatewayAuthorize == true
        choices.rows.every(row => row.paymentGatewayConfigId !== f.gatewayId + "_DEFAULT")
        refusedDefault.includes("GATEWAY_ADAPTER_UNSUPPORTED")
        explicit.canApply == true
        explicit.gatewaySummary.paymentGatewayConfigId == f.gatewayId
    }
})
