// Native authority, reviewed banking identity and policy are checked independently of artifact authorization.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingInternalTransferFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_XFRIN")
        f.users.transferTreasury = helper().lifecycle.settlement.user(f, "TRANSFER_SAFE", ["PAYMENT_VIEW", "PAYMENT_EDIT"])
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
    "method and fee searches filter before paging and retain selected rows while only current Treasury authority can prepare or confirm",
    {
        when() {
            const h = helper(),
                request = h.request(f),
                before = h.counts(f),
                methods = h.native("find#InternalTransferMethods", {
                    organizationPartyId: f.org,
                    currencyUomId: "USD",
                    effectiveDate: f.timestamp,
                    text: "oPeRaTiNg",
                    selectedIdList: [f.toMethodId],
                    pageSize: 1
                }),
                fees = h.native("find#InternalTransferFeeAccounts", {
                    organizationPartyId: f.org,
                    effectiveDate: f.timestamp,
                    text: "no-such-fee-account",
                    selectedIdList: [f.feeAccountId],
                    pageSize: 1
                })
            login(f.users.ar)
            const ar = h.lifecycle.rejected("preview#InternalTransfer", request),
                choicesDenied = h.lifecycle.rejected("find#InternalTransferMethods", {
                    organizationPartyId: f.org,
                    currencyUomId: "USD",
                    effectiveDate: f.timestamp
                }),
                read = h.native("find#Payments", {organizationPartyId: f.org})
            login(f.users.transferTreasury)
            const reviewed = h.native("preview#InternalTransfer", request),
                result = h.confirm(reviewed, "xfer-treasury-no-ledger"),
                detail = h.lifecycle.detail(f, result.toPaymentId)
            return {methods, fees, ar, choicesDenied, read, reviewed, result, detail, before}
        },
        then({methods, fees, ar, choicesDenied, read, reviewed, result, detail}) {
            methods.complete == true
            methods.recordCount == 1
            methods.rows[0].paymentMethodId == f.methodId
            methods.selectedRows[0].paymentMethodId == f.toMethodId
            Boolean(methods.rows[0].version)
            methods.rows[0].accountNumber == null
            fees.complete == true
            fees.recordCount == 0
            fees.selectedRows[0].glAccountId == f.feeAccountId
            fees.selectedRows[0].postedBalance == null
            ar.includes("PERMISSION_DENIED")
            choicesDenied.includes("PERMISSION_DENIED")
            read.capabilities.canTransfer == false
            reviewed.canApply == true
            reviewed.ledgerPreview == null
            result.reasonCode == "INTERNAL_TRANSFER_COMPLETED"
            result.acctgTransIds == null
            result.legRows.every(row => !row.acctgTransId)
            result.outputRows.every(row => row.canOpen === true)
            detail.payment.cashDirection == "incoming"
            detail.ledgerRows == null
        }
    }
)
feature("invalid principal fee currency methods and transit mappings refuse without financial or output side effects", {
    when() {
        const h = helper(),
            before = h.counts(f),
            errors = [],
            mapping = {organizationPartyId: f.org, paymentTypeEnumId: "PtInternalTransfer", isPayable: "Y", isApplied: "N"},
            saved = h.lib.one("mantle.ledger.config.PaymentTypeGlAccount", mapping)
        for (const [extra, expected] of [
            [{amount: "0"}, "AMOUNT_INVALID"],
            [{amount: "1.001"}, "CURRENCY_PRECISION"],
            [{feeAmount: "-1"}, "TRANSFER_FEE_INVALID"],
            [{feeAmount: "0.001"}, "CURRENCY_PRECISION"],
            [{feeAmount: "2"}, "TRANSFER_FEE_ACCOUNT_REQUIRED"],
            [{feeAmount: "2", feeGlAccountId: "111100000"}, "TRANSFER_FEE_ACCOUNT_REQUIRED"],
            [{feeAmount: "2", feeGlAccountId: "412000000"}, "TRANSFER_FEE_ACCOUNT_REQUIRED"],
            [{currencyUomId: "EUR"}, "CURRENCY_MISMATCH"],
            [{toPaymentMethodId: f.methodId}, "TRANSFER_METHODS_DISTINCT"]
        ])
            errors.push({expected, error: h.lifecycle.rejected("preview#InternalTransfer", h.request(f, extra))})
        const module = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
            foreign = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId})
        errors.push({
            expected: "PAYMENT_METHOD_UNAVAILABLE",
            error: h.lifecycle.rejected(
                "preview#InternalTransfer",
                h.request(f, {fromPaymentMethodId: f.customerMethodId, fromMethodVersion: module.methodVersion(foreign)})
            )
        })
        try {
            h.call("update#mantle.ledger.config.PaymentTypeGlAccount", Object.assign({}, mapping, {glAccountId: null}))
            errors.push({
                expected: "TRANSFER_TRANSIT_REQUIRED",
                error: h.lifecycle.rejected("preview#InternalTransfer", h.request(f))
            })
        } finally {
            h.call(
                "update#mantle.ledger.config.PaymentTypeGlAccount",
                Object.assign({}, mapping, {glAccountId: saved.glAccountId})
            )
        }
        try {
            h.call("update#mantle.ledger.config.PaymentTypeGlAccount", Object.assign({}, mapping, {glAccountId: "111100000"}))
            errors.push({
                expected: "TRANSFER_TRANSIT_MISMATCH",
                error: h.lifecycle.rejected("preview#InternalTransfer", h.request(f))
            })
        } finally {
            h.call(
                "update#mantle.ledger.config.PaymentTypeGlAccount",
                Object.assign({}, mapping, {glAccountId: saved.glAccountId})
            )
        }
        return {before, after: h.counts(f), errors, positive: h.preview(f, {feeAmount: "2", feeGlAccountId: f.feeAccountId})}
    },
    then({before, after, errors, positive}) {
        errors.length == 12
        errors.every(row => row.error.includes(row.expected))
        JSON.stringify(after) == JSON.stringify(before)
        positive.canApply == true
        positive.legRows.length == 2
    }
})
feature("confirmation rechecks current permission private-owner banking identity and hard locks before any paired money", {
    when() {
        const h = helper(),
            errors = [],
            permission = {userGroupId: f.users.transferTreasury, userPermissionId: "PAYMENT_EDIT", fromDate: 0},
            bank = h.lib.one("mantle.account.method.BankAccount", {paymentMethodId: f.methodId}),
            org = h.lib.one("mantle.party.Party", {partyId: f.org}),
            before = h.counts(f)
        let lastReview
        for (const kind of ["permission", "private", "bank", "lock"]) {
            login(f.users.transferTreasury)
            const review = h.preview(f)
            lastReview = review
            login("john.doe")
            const lockId = "XFR_REVIEW_" + ec.user.randomString(20)
            try {
                if (kind === "permission") h.call("delete#moqui.security.UserGroupPermission", permission)
                if (kind === "private") h.call("update#mantle.party.Party", {partyId: f.org, privateOwnerUserId: f.users.ar})
                if (kind === "bank")
                    h.call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, accountNumber: "456789012"})
                if (kind === "lock")
                    h.call("create#mantle.ledger.config.AccountingLock", {
                        accountingLockId: lockId,
                        organizationPartyId: f.org,
                        lockScope: "all",
                        lockThroughDate: f.day,
                        isHard: "Y",
                        changeReason: "Transfer confirm recheck"
                    })
                login(f.users.transferTreasury)
                errors.push({
                    kind,
                    error: h.lifecycle.rejected("create#InternalTransfer", {
                        previewId: review.previewId,
                        inputFingerprint: review.inputFingerprint,
                        operationKey: "xfer-review-" + kind
                    })
                })
            } finally {
                login("john.doe")
                if (kind === "permission") h.call("create#moqui.security.UserGroupPermission", permission)
                if (kind === "private")
                    h.call("update#mantle.party.Party", {partyId: f.org, privateOwnerUserId: org.privateOwnerUserId})
                if (kind === "bank")
                    h.call("update#mantle.account.method.BankAccount", {
                        paymentMethodId: f.methodId,
                        accountNumber: bank.accountNumber
                    })
                if (kind === "lock") h.call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: lockId})
            }
        }
        const after = h.counts(f)
        login(f.users.transferTreasury)
        const positive = h.confirm(lastReview, "xfer-review-restored")
        return {before, after, errors, positive}
    },
    then({before, after, errors, positive}) {
        errors.find(row => row.kind === "permission").error.includes("PERMISSION_DENIED")
        errors.find(row => row.kind === "private").error.includes("PARTY_UNAVAILABLE")
        errors.find(row => row.kind === "bank").error.includes("STALE_PAYMENT_METHOD")
        errors.find(row => row.kind === "lock").error.includes("HARD_LOCK")
        JSON.stringify(after) == JSON.stringify(before)
        positive.reasonCode == "INTERNAL_TRANSFER_COMPLETED"
        positive.outputRows.length == 2
    }
})
