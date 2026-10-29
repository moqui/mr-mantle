// The finance posting choke point. Verification reads only; callers decide whether a refusal is an error or a queue item.
const lib = ec.resource.script(
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js",
)
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry"
const { find, one, rows, map, ms, active, preference, hash } = lib
function fiscal(org, date, lock = false, visited = []) {
    if (visited.includes(org))
        return {
            periods: [],
            findings: [
                {
                    code: "PERIOD_CYCLE",
                    message: "Fiscal organization hierarchy contains a cycle",
                },
            ],
        }
    if (ms(date) == null || !Number.isFinite(ms(date)))
        return {
            periods: [],
            findings: [
                { code: "DATE_INVALID", message: "Choose a transaction date" },
            ],
        }
    const at = ec.l10n.format(date, "yyyy-MM-dd")
    const periods = Array.from(
        find("mantle.party.time.TimePeriodAndType", {
            partyId: org,
            periodPurposeEnumId: "Fiscal",
        })
            .condition("fromDate", "less-equals", at)
            .condition("thruDate", "greater-equals", at)
            .orderBy("timePeriodId")
            .list(),
    )
    const findings = []
    let selected = []
    for (const period of periods) {
        const current = lock
            ? find("mantle.party.time.TimePeriod", {
                  timePeriodId: period.timePeriodId,
              })
                  .forUpdate(true)
                  .one()
            : period
        selected.push(current)
        if (current.isClosed === "Y")
            findings.push({
                code: "PERIOD_CLOSED",
                message: "Fiscal period " + current.timePeriodId + " is closed",
            })
    }
    const parents = rows("mantle.party.PartyRelationship", {
        fromPartyId: org,
        relationshipTypeEnumId: "PrtOrgRollup",
    }).filter((r) => active(r, date))
    for (const parent of parents) {
        const out = fiscal(parent.toPartyId, date, lock, [...visited, org])
        selected = selected.concat(out.periods)
        findings.push(...out.findings)
    }
    if (!selected.length)
        findings.push({
            code: "PERIOD_MISSING",
            message: "No fiscal period configured for this date",
        })
    return { periods: selected, findings }
}
function scopes(tx, lines) {
    const scopes = new Set(["all"])
    if (tx.invoiceId) {
        const invoice = one("mantle.account.invoice.Invoice", {
            invoiceId: tx.invoiceId,
        })
        if (invoice?.fromPartyId === tx.organizationPartyId) scopes.add("sales")
        if (invoice?.toPartyId === tx.organizationPartyId)
            scopes.add("purchases")
    }
    if (
        ["AttTaxDue", "AttTaxInvoice"].includes(tx.acctgTransTypeEnumId) ||
        lines.some((line) => {
            const account =
                line.glAccountId &&
                one("mantle.ledger.account.GlAccount", {
                    glAccountId: line.glAccountId,
                })
            return (
                line.glAccountTypeEnumId === "GatTax" ||
                account?.glAccountTypeEnumId === "GatTax"
            )
        })
    )
        scopes.add("tax")
    return [...scopes]
}
function automatic(tx) {
    // Only physical source posters choose error-journal behavior; a direct caller cannot supply the mode.
    const stack = ec.artifactExecution.getStackNameString()
    return (
        !!(
            tx.assetReceiptId ||
            tx.assetIssuanceId ||
            tx.physicalInventoryId ||
            tx.finAccountTransId
        ) &&
        /mantle\.ledger\.(AssetAutoPostServices|OtherAutoPostServices)\.(?:post|repost)#/.test(
            stack,
        ) &&
        !stack.includes("mantle.ledger.JournalServices.")
    )
}
function validate(p, lock = false) {
    const tx = (
        lock
            ? find(T, { acctgTransId: p.acctgTransId }).forUpdate(true)
            : find(T, { acctgTransId: p.acctgTransId })
    ).one()
    if (!tx) throw new Error("Accounting transaction is not available")
    const lines = Array.from(
        find(E, { acctgTransId: tx.acctgTransId })
            .orderBy("acctgTransEntrySeqId")
            .list(),
    )
    const pref = preference(tx.organizationPartyId),
        enabled = pref.postingGuardEnabled === "Y"
    if (lock && enabled) {
        const ids = [
            ...new Set(lines.map((r) => r.glAccountId).filter(Boolean)),
        ].sort()
        if (ids.length) {
            Array.from(
                find("mantle.ledger.account.GlAccount")
                    .condition("glAccountId", "in", ids)
                    .orderBy("glAccountId")
                    .forUpdate(true)
                    .list(),
            )
            Array.from(
                find("mantle.ledger.account.GlAccountOrganization")
                    .condition("glAccountId", "in", ids)
                    .condition(
                        "organizationPartyId",
                        "in",
                        lib.organizationChain(
                            tx.organizationPartyId,
                            tx.transactionDate,
                        ),
                    )
                    .orderBy("glAccountId,organizationPartyId")
                    .forUpdate(true)
                    .list(),
            )
        }
    }
    const findings = [],
        debit = lines
            .filter((r) => r.debitCreditFlag === "D")
            .reduce((a, r) => a.add(r.amount ?? 0), toDecimal(0)),
        credit = lines
            .filter((r) => r.debitCreditFlag === "C")
            .reduce((a, r) => a.add(r.amount ?? 0), toDecimal(0))
    const fail = (code, message) => findings.push({ code, message })
    if (!debit.eq(credit) || !lines.length)
        fail(
            "UNBALANCED",
            "Transaction must have balanced debit and credit lines",
        )
    if (
        tx.scheduledPostingDate &&
        ms(tx.scheduledPostingDate) > ms(ec.user.nowTimestamp)
    )
        fail("NOT_DUE", "Scheduled posting date has not arrived")
    const fiscalOut = fiscal(tx.organizationPartyId, tx.transactionDate, lock)
    findings.push(...fiscalOut.findings)
    if (enabled) {
        if (
            !one("mantle.party.PartyRole", {
                partyId: tx.organizationPartyId,
                roleTypeId: "OrgInternal",
            })
        )
            fail("ORGANIZATION", "Posting organization must be internal")
        const currency =
            tx.amountUomId && one("moqui.basic.Uom", { uomId: tx.amountUomId })
        if (
            !currency ||
            currency.uomTypeEnumId !== "UT_CURRENCY_MEASURE" ||
            !pref.baseCurrencyUomId ||
            tx.amountUomId !== pref.baseCurrencyUomId
        )
            fail(
                "CURRENCY_MISMATCH",
                "Posting requires the organization's base currency until currency conversion is enabled",
            )
        const domain = ec.resource.script(
            "component://mr-mantle/service/mantle/product/ProductAccess.js",
        )
        const orgs =
            domain.systemAdmin() || domain.has("ACCOUNTING_ADMIN")
                ? null
                : lib.call(
                      "mantle.party.PartyServices.get#PartyOrganizationInfo",
                  ).userOrgIds || []
        if (orgs && !orgs.includes(tx.organizationPartyId))
            fail("ORGANIZATION", "Posting organization is not available")
    }
    for (const line of lines) {
        const account =
            line.glAccountId &&
            one("mantle.ledger.account.GlAccount", {
                glAccountId: line.glAccountId,
            })
        if (
            !account ||
            account.disallowPosting === "Y" ||
            line.amount == null ||
            !["D", "C"].includes(line.debitCreditFlag)
        )
            fail(
                "ENTRY_INVALID",
                "Line " +
                    line.acctgTransEntrySeqId +
                    " needs an amount and a posting account",
            )
        if (enabled) {
            try {
                lib.dimensions(tx.organizationPartyId, line, tx.transactionDate)
            } catch (error) {
                fail(
                    "DIMENSION_SCOPE",
                    "Line " + line.acctgTransEntrySeqId + ": " + error.message,
                )
            }
        }
        if (enabled && account) {
            const assignment = lib.accountAssignment(
                tx.organizationPartyId,
                account.glAccountId,
                tx.transactionDate,
            )
            if (!assignment || !active(assignment, tx.transactionDate))
                fail(
                    "ACCOUNT_INACTIVE",
                    "Account " +
                        account.glAccountId +
                        " is not active for this organization and date",
                )
            if (pref.requiredLedgerDimensionsEnabled === "Y" && assignment) {
                for (const [field, required] of [
                    ["facilityId", "facilityRequired"],
                    ["costCenterId", "costCenterRequired"],
                ]) {
                    if (assignment[required] === "Y" && !line[field])
                        fail(
                            "DIMENSION_REQUIRED",
                            "Line " +
                                line.acctgTransEntrySeqId +
                                " requires " +
                                field,
                        )
                }
            }
        }
    }
    const sourceEvidence = {}
    for (const [field, entity, key] of [["invoiceId","mantle.account.invoice.Invoice","invoiceId"],["paymentId","mantle.account.payment.Payment","paymentId"]]) {
        if(!tx[field])continue
        const source = (lock && enabled ? find(entity,{[key]:tx[field]}).forUpdate(true) : find(entity,{[key]:tx[field]})).one()
        sourceEvidence[field] = map(source)
        if(enabled && (!source || ![source.fromPartyId,source.toPartyId].includes(tx.organizationPartyId)))
            fail("SOURCE_SCOPE", "The posting source does not belong to this organization")
    }
    const applicable = scopes(tx, lines)
    const locks = enabled
        ? rows("mantle.ledger.config.AccountingLock", {
              organizationPartyId: tx.organizationPartyId,
          })
        : []
    for (const initial of locks.sort((a, b) =>
        a.accountingLockId.localeCompare(b.accountingLockId),
    )) {
        const row = lock
            ? find("mantle.ledger.config.AccountingLock", {
                  accountingLockId: initial.accountingLockId,
              })
                  .forUpdate(true)
                  .one()
            : initial
        if (
            !applicable.includes(row.lockScope) ||
            ec.l10n.format(tx.transactionDate, "yyyy-MM-dd") >
                new Date(ms(row.lockThroughDate)).toISOString().slice(0, 10)
        )
            continue
        const exceptions =
            row.isHard === "Y"
                ? []
                : rows("mantle.ledger.config.AccountingLockException", {
                      accountingLockId: row.accountingLockId,
                  })
        const allowed = exceptions.some(
            (e) =>
                active(e) &&
                e.organizationPartyId === tx.organizationPartyId &&
                (e.userId === ec.user.userId ||
                    (e.userGroupId && ec.user.isInGroup(e.userGroupId))) &&
                (!e.acctgTransId || e.acctgTransId === tx.acctgTransId) &&
                e.lockScope === row.lockScope,
        )
        if (!allowed)
            fail(
                row.isHard === "Y" ? "HARD_LOCK" : "SOFT_LOCK",
                "Posting lock " +
                    row.accountingLockId +
                    " (" +
                    row.lockScope +
                    "): " +
                    row.changeReason,
            )
    }
    const evidence = {
        sources:sourceEvidence,
        tx: map(tx),
        lines: lines.map(map),
        periods: fiscalOut.periods.map((r) =>
            lib.pick(map(r), [
                "timePeriodId",
                "partyId",
                "timePeriodTypeId",
                "fromDate",
                "thruDate",
                "isClosed",
            ]),
        ),
        locks: locks.map((r) => ({
            lock: map(r),
            exceptions: rows("mantle.ledger.config.AccountingLockException", {
                accountingLockId: r.accountingLockId,
            }).map(map),
        })),
        preferences: lib.pick(map(pref), [
            "postingGuardEnabled",
            "requiredLedgerDimensionsEnabled",
            "baseCurrencyUomId",
        ]),
        accounts: lines.map((r) => ({
            account: map(
                one("mantle.ledger.account.GlAccount", {
                    glAccountId: r.glAccountId,
                }),
            ),
            assignment: map(
                lib.accountAssignment(
                    tx.organizationPartyId,
                    r.glAccountId,
                    tx.transactionDate,
                ),
            ),
        })),
    }
    return {
        tx,
        lines,
        preference: pref,
        enabled,
        findings,
        periods: fiscalOut.periods,
        debitTotal: debit,
        creditTotal: credit,
        inputFingerprint: hash(evidence),
        valid: findings.length === 0,
        automatic: automatic(tx),
    }
}
function check(p) {
    const initial = one(T, { acctgTransId: p.acctgTransId })
    if (!initial) throw new Error("Accounting transaction is not available")
    const adopted =
        preference(initial.organizationPartyId).postingGuardEnabled === "Y"
    if (!p.verifyOnly && !adopted)
        return { handled: false, valid: true, findings: [] }
    if (!p.verifyOnly)
        find("mantle.party.Party", { partyId: initial.organizationPartyId })
            .forUpdate(true)
            .one()
    const out = validate(p, !p.verifyOnly)
    if (out.findings.some((r) => r.code === "ORGANIZATION"))
        throw new Error("Posting organization is not available")
    if (!p.verifyOnly && out.enabled && out.valid) {
        const stack = ec.artifactExecution.getStackNameString()
        const reviewed =
            /mantle\.ledger\.JournalServices\.(post|reverse)#Entry/.test(stack)
        const source =
            /mantle\.ledger\.(InvoiceAutoPostServices|PaymentAutoPostServices|AssetAutoPostServices|OtherAutoPostServices|AssetBookServices)\./.test(
                stack,
            )
        if (!reviewed && !source)
            throw new Error("REVIEW_REQUIRED: Use a reviewed posting operation")
    }
    if (!p.verifyOnly && out.enabled && !out.valid) {
        if (out.automatic && out.preference.errorGlJournalId) {
            lib.call("update#" + T, {
                acctgTransId: p.acctgTransId,
                glJournalId: out.preference.errorGlJournalId,
                postingFailureCode: out.findings[0].code,
                postingFailureMessage: out.findings
                    .map((r) => r.message)
                    .join("; "),
            })
        } else
            throw new Error(
                out.findings[0].code +
                    ": " +
                    out.findings.map((r) => r.message).join("; "),
            )
    }
    return {
        handled: p.verifyOnly || (out.enabled && !out.valid),
        valid: out.valid,
        findings: out.findings,
        timePeriodList: out.periods.map(map),
        debitTotal: out.debitTotal,
        creditTotal: out.creditTotal,
    }
}
function completed(acctgTransId) {
    const tx = one(T, { acctgTransId })
    if (
        !tx ||
        preference(tx.organizationPartyId).postingGuardEnabled !== "Y" ||
        tx.isPosted !== "Y"
    )
        return
    const operationKey = "lp:" + hash(acctgTransId).slice(0, 37),
        entity = "mantle.ledger.transaction.PostingOperation"
    if (!one(entity, { operationKey }))
        lib.call("create#" + entity, {
            operationKey,
            operationType: "LedgerPost",
            organizationPartyId: tx.organizationPartyId,
            userId: ec.user.userId,
            submittedDate: ec.user.nowTimestamp,
            requestHash: hash({
                acctgTransId,
                lines: rows(E, { acctgTransId }).map(map),
            }),
            status: "complete",
            resultEntityName: T,
            resultId: acctgTransId,
            completedDate: ec.user.nowTimestamp,
        })
}
;({ validate, check, completed, fiscal, scopes })
