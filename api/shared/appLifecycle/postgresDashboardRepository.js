'use strict';

const { types: { isPromise } } = require('node:util');

const { transitionTenant, transitionOrganisation } = require('./tenantDomain');
const { applyMembershipCommand, resolveActiveMembership } = require('./membershipDomain');
const { normaliseEntitlementState, resolveEntitlements, consumeEntitlementLimit, TIERS } = require('./entitlementDomain');
const { normaliseAdvisorAssignment, resolvePortalPermission } = require('./portalPermissions');
const { modules } = require('../protectedAssets/dashboardRegistry');
const { resolveNcscAccess: ncscAccess, normalRole, selectAdvisor } = require('./dashboardResourceAuthority');
const ncscStore = require('../assessmentLifecycle/postgresNcscAssessmentStore');
const { MODULE_ID: NCSC_MODULE, ACCEPTED_PROFILE_REF } = require('../assessmentEngine/ncscAssessmentEvaluator');
const { NcscAssessmentError, normaliseNcscCommand, normaliseNcscPage, normaliseNcscSelector,
    requireNcscContext } = require('../ncscAssessmentService');

const { DashboardPersistenceError, createBootstrapOperations, dataStorage, dataCodec } = require('./postgresDashboardBootstrap');
const { LIMIT_PERMISSIONS, AI_PERMISSIONS, LIMIT_MODULES, fail, own, fields, detach,
    freeze, hash, normaliseScope, subject, identifier, integer, instant,
    normaliseCommand, revisionVector, assertNext, equalScope, newUsage,
    validateUsage, assertReceiptIncluded, administer: administerWith } = dataCodec;
const { loadSnapshotForShare, loadSnapshotForUpdate, readOperationReceipt: receipt,
    saveOperationReceipt: saveReceipt } = dataStorage;

// Explicit trusted composition only. No environment selection or live factory.
function createPostgresDashboardRepository(options) {
    const configured = fields(options, ['database', 'clock', 'authoriseAdministration', 'ncsc'], false);
    const { database, clock, authoriseAdministration } = configured;
    if (!database || typeof database.withTenantTransaction !== 'function' || typeof clock !== 'function' ||
        typeof authoriseAdministration !== 'function') fail('dependencies_invalid');
    let ncsc = null;
    if (own(configured, 'ncsc')) {
        const setting = fields(configured.ncsc, ['audit', 'resolveSubmissionQuota']);
        const audit = fields(setting.audit, ['createEvent', 'writeEvent']);
        if (typeof audit.createEvent !== 'function' || typeof audit.writeEvent !== 'function' ||
            typeof setting.resolveSubmissionQuota !== 'function') fail('dependencies_invalid');
        ncsc = Object.freeze({ audit: Object.freeze(audit), resolveSubmissionQuota: setting.resolveSubmissionQuota });
    }

    function now() { return instant(clock()); }
    const bootstrap = createBootstrapOperations({ clock, authoriseAdministration });
    function administer(command, snapshot) { return administerWith(authoriseAdministration, command, snapshot); }
    function load(tx, scope, lock) {
        if (lock === 'SHARE') return loadSnapshotForShare(tx, scope);
        if (lock === 'UPDATE') return loadSnapshotForUpdate(tx, scope);
        fail('dependencies_invalid');
    }

    async function readAdmissionSnapshot(scopeInput, principalInput) {
        const scope = normaliseScope(detach(scopeInput));
        const principal = fields(detach(principalInput), ['authenticated', 'subjectKey']);
        if (principal.authenticated !== true) fail('authentication_required', 403);
        const subjectKey = subject(principal.subjectKey);
        return database.withTenantTransaction(scope.tenantId, async tx => {
            const snapshot = await load(tx, scope, 'SHARE');
            const at = now();
            const member = resolveActiveMembership(snapshot.membershipState, snapshot.tenantAggregate, { ...scope, subjectKey }, at);
            const advisorAssignments = {};
            for (const module of modules) {
                if (normalRole(member, module.permission)) continue;
                const assignment = selectAdvisor(snapshot, member, module.key, module.permission, at);
                if (assignment) advisorAssignments[module.key] = assignment;
            }
            return freeze({ tenantAggregate: snapshot.tenantAggregate, membershipState: snapshot.membershipState,
                entitlementState: snapshot.entitlementState, flags: snapshot.flags, advisorAssignments, summary: null });
        });
    }

    async function readAuthoritySnapshot(scopeInput, principalInput) {
        const scope = normaliseScope(detach(scopeInput));
        const principal = fields(detach(principalInput), ['authenticated', 'subjectKey']);
        if (principal.authenticated !== true) fail('authentication_required', 403);
        const command = freeze({ ...scope, actorSubjectKey: subject(principal.subjectKey), type: 'authority.read' });
        return database.withTenantTransaction(scope.tenantId, async tx => {
            const snapshot = await load(tx, scope, 'SHARE');
            administer(command, snapshot);
            return freeze({ snapshot, revisions: revisionVector(snapshot), evaluatedAt: now() });
        });
    }

    async function run(command, prepared = null, initialMembership = false) {
        function authoriseReservation(snapshot, at) {
            if (initialMembership) {
                // This private port is for processing an exact independently
                // approved first membership. It is not an HTTP quota override.
                administer(command, snapshot);
                if (command.payload.limit !== 'memberships' || command.payload.amount !== 1 ||
                    command.payload.moduleId !== 'overview' || command.payload.framework !== null ||
                    snapshot.membershipState.memberships.length !== 1 ||
                    snapshot.membershipState.memberships[0].subjectKey !== command.actorSubjectKey) fail('quota_scope_invalid');
            }
            authoriseUsage(snapshot, command, at, initialMembership);
        }
        const digest = prepared ? null : hash({ command, initialState: null });
        const tenantId = prepared ? prepared.tenantId : command.tenantId;
        const attempt = async reconcile => database.withTenantTransaction(tenantId, async tx => {
            if (prepared) {
                const outcome = await (reconcile ? bootstrap.reconcileInTransaction(tx, prepared) : bootstrap.executeInTransaction(tx, prepared));
                return outcome.result;
            }
            const snapshot = await load(tx, command, 'UPDATE');
            const at = now();
            if (command.type === 'usage.reserve') authoriseReservation(snapshot, at);
            else administer(command, snapshot);
            const original = await receipt(tx, command, digest, snapshot);
            // Receipt I/O can cross a time boundary even though the tenant fence
            // prevents authority writers. Re-evaluate expiry before returning or
            // calculating a reservation with a freshly sampled trusted instant.
            const executionAt = now();
            if (command.type === 'usage.reserve') authoriseReservation(snapshot, executionAt);
            if (original) return original;
            if (reconcile) fail('commit_ambiguous', 503);
            if (hash(command.expectedRevisions) !== hash(revisionVector(snapshot))) fail('revision_conflict', 409);
            const next = detach(snapshot);
            let consumed = null;
            if (command.type === 'usage.reserve') {
                const payload = command.payload, current = snapshot.usage.find(item => item.grantId === payload.grantId);
                consumed = consumeEntitlementLimit(snapshot.entitlementState, snapshot.tenantAggregate, current,
                    { ...normaliseScope(command, false), ...payload, expectedEntitlementRevision: snapshot.entitlementState.revision,
                        expectedFlagRevision: snapshot.flags.revision, expectedUsageRevision: current.revision }, executionAt, snapshot.flags);
                await dataStorage.updateUsage(tx, consumed);
                next.usage = next.usage.map(item => item.grantId === consumed.grantId ? consumed : item);
            } else await mutate(tx, command, next, executionAt);
            return saveReceipt(tx, command, digest, next, now(), consumed);
        });
        try { return await attempt(false); } catch (error) {
            // The existing helper cannot distinguish a failed rollback following
            // COMMIT loss from one following an application error. Both must avoid
            // repeating the mutation and reconcile only immutable evidence.
            if (!['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw error;
            try { return await attempt(true); } catch (recovery) {
                if (recovery instanceof DashboardPersistenceError || (recovery.statusCode >= 400 && recovery.statusCode < 500)) throw recovery;
                fail('commit_ambiguous', 503);
            }
        }
    }

    async function mutate(tx, command, next, at) {
        const payload = command.payload;
        if (command.type === 'tenant.transition') {
            next.tenantAggregate.tenant = transitionTenant(next.tenantAggregate.tenant,
                { expectedRevision: next.tenantAggregate.tenant.revision, ...fields(payload, ['toStatus']) });
            await dataStorage.updateTenant(tx, next.tenantAggregate.tenant);
        } else if (command.type === 'organisation.transition') {
            next.tenantAggregate.organisations[0] = transitionOrganisation(next.tenantAggregate.organisations[0],
                { expectedRevision: next.tenantAggregate.organisations[0].revision, ...fields(payload, ['toStatus']) });
            await dataStorage.updateOrganisation(tx, next.tenantAggregate.organisations[0]);
        } else if (command.type === 'membership.command') {
            next.membershipState = applyMembershipCommand(next.membershipState, next.tenantAggregate,
                { ...normaliseScope(command, false), expectedRevision: next.membershipState.revision,
                    actorSubjectKey: command.actorSubjectKey, now: at, ...fields(payload, ['action', 'payload']) });
            await dataStorage.updateMembershipState(tx, next.membershipState);
        } else if (command.type === 'flags.update') {
            assertNext(payload, next.flags, command);
            resolveEntitlements(next.entitlementState, next.tenantAggregate, normaliseScope(command, false), at, payload);
            next.flags = payload;
            await dataStorage.updateFlags(tx, payload);
        } else if (command.type === 'entitlement.update') {
            const proposed = normaliseEntitlementState(payload, next.tenantAggregate);
            assertNext(proposed, next.entitlementState, command);
            for (const old of next.entitlementState.grants) {
                const replacement = proposed.grants.find(grant => grant.grantId === old.grantId);
                if (!replacement || hash({ ...old, status: null }) !== hash({ ...replacement, status: null }) ||
                    (old.status === 'revoked' && replacement.status !== 'revoked')) fail('grant_history_invalid', 409);
            }
            const added = proposed.grants.filter(grant => own(TIERS, grant.code) && !next.entitlementState.grants.some(old => old.grantId === grant.grantId));
            next.entitlementState = proposed;
            await dataStorage.updateEntitlementState(tx, proposed);
            for (const grant of added) {
                const usage = newUsage(grant); await dataStorage.insertUsage(tx, usage); next.usage.push(usage);
            }
        } else if (command.type === 'advisor.put') {
            // updatedAt is server-owned transition metadata. The submitted value
            // remains in the stable command intent, never a predicted commit time.
            const proposed = normaliseAdvisorAssignment({ ...payload, updatedAt: at });
            equalScope(proposed, command);
            const old = next.advisorAssignments.find(item => item.assignmentId === proposed.assignmentId);
            if (old) {
                assertNext(proposed, old, command);
                const immutable = row => ({ ...row, status: null, updatedAt: null, revision: null });
                if (hash(immutable(old)) !== hash(immutable(proposed)) || (old.status === 'revoked' && proposed.status !== 'revoked') ||
                    proposed.updatedAt < old.updatedAt) fail('assignment_history_invalid', 409);
            } else if (proposed.revision !== 0) fail('revision_conflict', 409);
            if (!next.membershipState.memberships.some(member => member.membershipId === proposed.membershipId &&
                member.subjectKey === proposed.subjectKey)) fail('assignment_owner_invalid', 409);
            next.advisorAssignments = [...next.advisorAssignments.filter(item => item.assignmentId !== proposed.assignmentId), proposed];
            await (old ? dataStorage.updateAdvisorAssignment(tx, proposed) : dataStorage.insertAdvisorAssignment(tx, proposed));
        } else fail('command_invalid');
    }

    function ncscFail(code = 'ncsc_unavailable', status = 503) { throw new NcscAssessmentError(code, status); }
    function ncscReady(context) {
        if (!ncsc) ncscFail();
        return requireNcscContext(context);
    }
    function ncscError(error) {
        if (error instanceof NcscAssessmentError) return error;
        return new NcscAssessmentError('ncsc_unavailable', 503);
    }
    async function ncscLoad(tx, scope, lock) {
        try { return await load(tx, scope, lock); }
        catch (error) {
            // Unknown selected ownership is an access denial, not a foreign-record oracle.
            if (error instanceof DashboardPersistenceError && error.statusCode === 404) ncscFail('ncsc_access_denied', 403);
            throw error;
        }
    }

    function quotaPolicy(policyInput, selection, product) {
        const policy = fields(detach(policyInput), ['schemaVersion', 'tenantId', 'organisationId', 'productGrantId',
            'agreementRef', 'moduleId', 'profileRef', 'policyId', 'policyRevision', 'validFrom', 'validUntil', 'limit', 'amount']);
        identifier(policy.policyId); integer(policy.policyRevision); integer(policy.amount);
        instant(policy.validFrom); instant(policy.validUntil);
        if (policy.schemaVersion !== 1 || policy.tenantId !== selection.tenantId || policy.organisationId !== selection.organisationId ||
            policy.productGrantId !== selection.productGrantId || policy.agreementRef !== selection.agreementRef ||
            policy.moduleId !== NCSC_MODULE || !ncscStore.same(policy.profileRef, ACCEPTED_PROFILE_REF) ||
            policy.limit !== 'assessment_runs' || policy.amount < 1 ||
            !(policy.validFrom <= selection.at && selection.at < policy.validUntil) ||
            product.grantId !== policy.productGrantId || product.agreementRef !== policy.agreementRef ||
            !(product.validFrom <= selection.at && selection.at < product.validUntil)) ncscFail();
        return freeze(policy);
    }
    async function selectQuota(snapshot, context, command, decision, version, at) {
        const selection = freeze({ ...context.scope, assessmentId: command.assessmentId,
            actorSubjectKey: context.identity.subjectKey, moduleId: NCSC_MODULE, profileRef: ACCEPTED_PROFILE_REF,
            productGrantId: decision.product.grantId, agreementRef: decision.product.agreementRef,
            expectedRevision: command.expectedRevision, submissionRevision: version.envelope.revision, at });
        let selected;
        try {
            selected = ncsc.resolveSubmissionQuota(selection);
            // Only genuine Promises extend the trusted adapter; arbitrary
            // thenables remain data and are rejected by the closed policy codec.
            if (isPromise(selected)) selected = await new Promise((resolve, reject) =>
                Promise.prototype.then.call(selected, resolve, reject));
        } catch (error) {
            // A fixed empty policy set rejects submission before any assessment
            // write. Distinguish it from an unknown policy/provider failure,
            // whose mutation outcome must remain unavailable/ambiguous.
            if (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ncsc_submission_unavailable')
                ncscFail('ncsc_submission_unavailable', 409);
            ncscFail();
        }
        // Strict record validation also rejects thenable/getter-bearing results without invoking them.
        const product = snapshot.entitlementState.grants.find(row => row.grantId === decision.product.grantId);
        const policy = quotaPolicy(selected, selection, product);
        const before = snapshot.usage.find(row => row.grantId === policy.productGrantId);
        if (!before) ncscFail('ncsc_access_denied', 403);
        let after;
        try {
            after = consumeEntitlementLimit(snapshot.entitlementState, snapshot.tenantAggregate, before,
                { ...context.scope, grantId: policy.productGrantId, expectedEntitlementRevision: snapshot.entitlementState.revision,
                    expectedFlagRevision: snapshot.flags.revision, expectedUsageRevision: before.revision,
                    moduleId: NCSC_MODULE, limit: 'assessment_runs', amount: policy.amount,
                    framework: { profileId: ACCEPTED_PROFILE_REF.profileId, version: ACCEPTED_PROFILE_REF.profileVersion } }, at, snapshot.flags);
        } catch (error) {
            if (error.code === 'entitlement_limit_exceeded') ncscFail('ncsc_quota_exceeded', 409);
            ncscFail('ncsc_access_denied', 403);
        }
        return freeze({ selection, policy, policySha256: ncscStore.digest('policy', policy), productGrant: product, before, after });
    }
    function validateQuotaEvidence(receiptValue, snapshot) {
        if (receiptValue.action !== 'submit') return;
        const quota = fields(detach(receiptValue.quota), ['selection', 'policy', 'policySha256', 'productGrant', 'before', 'after']);
        const selection = fields(quota.selection, ['tenantId', 'organisationId', 'assessmentId', 'actorSubjectKey',
            'moduleId', 'profileRef', 'productGrantId', 'agreementRef', 'expectedRevision', 'submissionRevision', 'at']);
        const expectedSelection = { tenantId: receiptValue.tenantId, organisationId: receiptValue.organisationId,
            assessmentId: receiptValue.assessmentId, actorSubjectKey: receiptValue.actorSubjectKey, moduleId: NCSC_MODULE,
            profileRef: ACCEPTED_PROFILE_REF, productGrantId: quota.productGrant.grantId, agreementRef: quota.productGrant.agreementRef,
            expectedRevision: receiptValue.intent.expectedRevision, submissionRevision: receiptValue.resultRevision, at: receiptValue.executionAt };
        if (!ncscStore.same(selection, expectedSelection)) ncscFail();
        const policy = quotaPolicy(quota.policy, selection, quota.productGrant);
        if (quota.policySha256 !== ncscStore.digest('policy', policy)) ncscFail();
        const retained = snapshot.entitlementState.grants.find(row => row.grantId === policy.productGrantId);
        if (!retained || quota.productGrant.status !== 'active' ||
            !ncscStore.same({ ...retained, status: null }, { ...quota.productGrant, status: null })) ncscFail();
        const before = validateUsage(quota.before, snapshot.entitlementState), after = validateUsage(quota.after, snapshot.entitlementState);
        equalScope(before, receiptValue); equalScope(after, receiptValue);
        if (before.grantId !== policy.productGrantId || after.grantId !== policy.productGrantId ||
            !own(before.counters, 'assessment_runs') || !own(after.counters, 'assessment_runs') ||
            !ncscStore.same(after, { ...before, revision: before.revision + 1,
                counters: { ...before.counters, assessment_runs: before.counters.assessment_runs + policy.amount } })) ncscFail();
        const oldVector = receiptValue.expectedAuthority, resultVector = receiptValue.resultAuthority;
        const prior = oldVector.usage.find(row => row.grantId === policy.productGrantId);
        if (!prior || prior.revision !== before.revision || !ncscStore.same(resultVector,
            { ...oldVector, usage: oldVector.usage.map(row => row.grantId === policy.productGrantId ? { ...row, revision: after.revision } : row) })) ncscFail();
    }
    async function ncscRead(contextInput, input, listing) {
        try {
            const context = ncscReady(contextInput);
            const selected = listing ? normaliseNcscPage(input) : normaliseNcscSelector(input);
            return await database.withTenantTransaction(context.scope.tenantId, async tx => {
                const snapshot = await ncscLoad(tx, context.scope, 'SHARE');
                ncscAccess(snapshot, context, 'assessment.read', now());
                let result;
                if (listing) {
                    const heads = await ncscStore.listHeads(tx, context.scope, selected);
                    const assessments = [];
                    let versions = 0;
                    for (const head of heads.slice(0, selected.limit)) {
                        // listHeads validates all scoped head revisions first.
                        // A complete 129-version history always fits an empty
                        // page; never skip or partly validate an assessment.
                        if (versions + head.revision + 1 > ncscStore.PAGE_VERSION_BUDGET) break;
                        const scope = { ...context.scope, assessmentId: head.assessment_id };
                        const history = await ncscStore.readHistory(tx, scope, head, [], snapshot.tenantAggregate);
                        assessments.push(ncscStore.projectNcscSummary(history.get(head.revision)));
                        versions += head.revision + 1;
                    }
                    result = { schemaVersion: 1, assessments,
                        nextAfterAssessmentId: heads.length > assessments.length ? assessments.at(-1).assessmentId : null };
                } else {
                    const scope = { ...context.scope, assessmentId: selected.assessmentId };
                    const head = await ncscStore.readHead(tx, scope);
                    const history = await ncscStore.readHistory(tx, scope, head, [], snapshot.tenantAggregate);
                    if (!head) ncscFail('ncsc_not_found', 404);
                    result = { schemaVersion: 1, assessment: ncscStore.projectNcscDetail(history.get(head.revision)) };
                }
                ncscAccess(snapshot, context, 'assessment.read', now());
                const event = ncsc.audit.createEvent(context, { action: 'assessment.read', module: NCSC_MODULE, result: 'succeeded' });
                await ncsc.audit.writeEvent(event);
                ncscAccess(snapshot, context, 'assessment.read', now());
                return freeze(result);
            });
        } catch (error) { throw ncscError(error); }
    }
    async function executeNcscAssessment(contextInput, input) {
        let context, command, intent;
        try {
            context = ncscReady(contextInput); command = normaliseNcscCommand(input);
            intent = ncscStore.stableIntent(context, command);
        } catch (error) { throw ncscError(error); }
        const attempt = reconcile => database.withTenantTransaction(context.scope.tenantId, async tx => {
            const snapshot = await ncscLoad(tx, context.scope, 'UPDATE');
            ncscAccess(snapshot, context, 'assessment.write', now());
            const scope = { ...context.scope, assessmentId: command.assessmentId };
            const head = await ncscStore.readHead(tx, scope), receiptRow = await ncscStore.readReceipt(tx, scope, command.idempotencyKey);
            const history = await ncscStore.readHistory(tx, scope, head,
                receiptRow ? [receiptRow.result_revision, command.expectedRevision] : [], snapshot.tenantAggregate);
            const at = now(), decision = ncscAccess(snapshot, context, 'assessment.write', at);
            if (receiptRow) {
                const original = ncscStore.validateReceipt(receiptRow, intent, command.idempotencyKey, history, snapshot.tenantAggregate);
                validateQuotaEvidence(original, snapshot);
                assertReceiptIncluded(snapshot, { resultRevisions: original.resultAuthority,
                    reserved: original.quota !== null, usage: original.quota?.after ?? null });
                ncscAccess(snapshot, context, 'assessment.write', now());
                return freeze(original.result);
            }
            if (reconcile) ncscFail('ncsc_outcome_ambiguous', 503);
            if (command.action === 'create' && head) ncscFail('ncsc_state_conflict', 409);
            if (command.action !== 'create' && !head) ncscFail('ncsc_not_found', 404);
            const version = ncscStore.makeVersion(intent, command.idempotencyKey,
                head ? history.get(head.revision) : null, snapshot.tenantAggregate, at);
            await ncscStore.assertPersistableCandidate(tx, version);
            const quota = command.action === 'submit' ? await selectQuota(snapshot, context, command, decision, version, at) : null;
            // Policy I/O must not let elapsed identity, membership or product
            // authority reach the first assessment write.
            ncscAccess(snapshot, context, 'assessment.write', now());
            const next = detach(snapshot);
            if (quota) next.usage = next.usage.map(row => row.grantId === quota.after.grantId ? quota.after : row);
            const event = ncsc.audit.createEvent(context, { action: 'assessment.write', module: NCSC_MODULE, result: 'succeeded' });
            const receiptValue = ncscStore.makeReceipt(intent, command.idempotencyKey, version, revisionVector(snapshot), revisionVector(next), quota, event);
            await ncscStore.appendVersion(tx, version);
            await ncscStore.moveHead(tx, version);
            if (quota) await dataStorage.updateUsage(tx, quota.after);
            await ncscStore.insertReceipt(tx, receiptValue);
            const finalAt = now();
            const finalDecision = ncscAccess(snapshot, context, 'assessment.write', finalAt);
            if (quota && (finalDecision.product.grantId !== quota.policy.productGrantId ||
                !(quota.productGrant.validFrom <= finalAt && finalAt < quota.productGrant.validUntil) ||
                !(quota.policy.validFrom <= finalAt && finalAt < quota.policy.validUntil))) ncscFail('ncsc_access_denied', 403);
            return freeze(receiptValue.result);
        });
        try { return await attempt(false); }
        catch (error) {
            if (!['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw ncscError(error);
            try { return await attempt(true); }
            catch (recovery) {
                if (recovery instanceof NcscAssessmentError && recovery.code === 'ncsc_access_denied') throw recovery;
                throw new NcscAssessmentError('ncsc_outcome_ambiguous', 503);
            }
        }
    }

    return Object.freeze({
        readAdmissionSnapshot,
        readAuthoritySnapshot,
        initialiseOrganisation(commandInput, initialInput) {
            return run(null, bootstrap.prepareInitialisation(commandInput, initialInput));
        },
        executeAuthorityCommand(commandInput) {
            const command = normaliseCommand(commandInput);
            if (['organisation.initialise', 'usage.reserve'].includes(command.type)) fail('command_invalid');
            return run(command);
        },
        reserveUsage(commandInput) { return run(normaliseCommand(commandInput, 'usage.reserve')); },
        reserveInitialMembership(commandInput) { return run(normaliseCommand(commandInput, 'usage.reserve'), null, true); },
        listNcscAssessments(context, page) { return ncscRead(context, page, true); },
        readNcscAssessment(context, selector) { return ncscRead(context, selector, false); },
        executeNcscAssessment
    });
}

function authoriseUsage(snapshot, command, at, initialMembership = false) {
    const payload = fields(command.payload, ['grantId', 'moduleId', 'limit', 'amount', 'framework']);
    identifier(payload.grantId); integer(payload.amount);
    if (!payload.amount || !own(LIMIT_MODULES, payload.limit) || !LIMIT_MODULES[payload.limit].includes(payload.moduleId)) fail('quota_scope_invalid');
    const scope = normaliseScope(command, false);
    const member = resolveActiveMembership(snapshot.membershipState, snapshot.tenantAggregate, { ...scope, subjectKey: command.actorSubjectKey }, at);
    const permission = payload.limit === 'ai_requests' ? AI_PERMISSIONS[payload.moduleId] : LIMIT_PERMISSIONS[payload.limit];
    const assignment = initialMembership || normalRole(member, permission) ? null : selectAdvisor(snapshot, member, payload.moduleId, permission, at);
    const permissionDecision = initialMembership ? { role: null } : resolvePortalPermission(snapshot.membershipState, snapshot.tenantAggregate,
        { ...scope, subjectKey: command.actorSubjectKey, permission, module: payload.moduleId }, assignment, at);
    const decision = resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate, scope, at, snapshot.flags);
    if (permissionDecision.role === 'fractional_advisor' && decision.services.fractional_advisory.enabled !== true) fail('quota_denied', 403);
    const usage = snapshot.usage.find(item => item.grantId === payload.grantId);
    if (!decision.product || decision.product.grantId !== payload.grantId || !decision.modules[payload.moduleId].eligible ||
        !own(decision.product.limits, payload.limit) || !usage || !own(usage.counters, payload.limit) ||
        (payload.limit === 'ai_requests' && snapshot.flags.enabled.ai_drafting !== true)) fail('quota_denied', 403);
    if (payload.limit === 'assessment_runs') {
        const framework = fields(payload.framework, ['profileId', 'version']);
        identifier(framework.profileId); identifier(framework.version);
        if (!decision.frameworks.some(item => item.moduleId === payload.moduleId && item.profileId === framework.profileId && item.version === framework.version)) fail('quota_denied', 403);
    } else if (payload.framework !== null) fail('quota_scope_invalid');
}

module.exports = { DashboardPersistenceError, createPostgresDashboardRepository };
