'use strict';

const { types: { isPromise } } = require('node:util');

const { copy, fields, freeze, id, revision, instant, subject, equal } =
    require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { MODULE_ID, ACCEPTED_PROFILE_REF } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');

const POLICY_KEYS = ['schemaVersion', 'tenantId', 'organisationId', 'productGrantId', 'agreementRef',
    'moduleId', 'profileRef', 'policyId', 'policyRevision', 'validFrom', 'validUntil', 'limit', 'amount'];
const SELECTION_KEYS = ['tenantId', 'organisationId', 'assessmentId', 'actorSubjectKey', 'moduleId',
    'profileRef', 'productGrantId', 'agreementRef', 'expectedRevision', 'submissionRevision', 'at'];
const TARGET_KEYS = ['tenantId', 'organisationId', 'productGrantId', 'agreementRef', 'moduleId'];
const unavailable = () => { throw new Error('ncsc_submission_policy_unavailable'); };
const noPolicy = () => {
    const error = new Error('ncsc_submission_policy_unavailable');
    error.code = 'ncsc_submission_unavailable';
    throw error;
};
const sameTarget = (a, b) => TARGET_KEYS.every(key => a[key] === b[key]) && equal(a.profileRef, b.profileRef);

function normaliseNcscSubmissionSelection(input) {
    try {
        const selection = fields(copy(input, 16384), SELECTION_KEYS);
        for (const key of [...TARGET_KEYS, 'assessmentId']) id(selection[key]);
        subject(selection.actorSubjectKey); instant(selection.at);
        revision(selection.expectedRevision); revision(selection.submissionRevision);
        if (selection.expectedRevision >= Number.MAX_SAFE_INTEGER ||
            selection.submissionRevision !== selection.expectedRevision + 1 ||
            selection.moduleId !== MODULE_ID || !equal(selection.profileRef, ACCEPTED_PROFILE_REF)) unavailable();
        return freeze(selection);
    } catch (_) { unavailable(); }
}

// Pure synchronous lookup of a reviewed release's retained policy revisions.
// Membership, product validity and the finite usage counter remain SQL authority.
function createNcscSubmissionQuotaResolver(input) {
    let policies;
    try {
        const manifest = fields(copy(input, 262144), ['schemaVersion', 'policies']);
        if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.policies) ||
            manifest.policies.length > 128) unavailable();
        policies = manifest.policies;
        const revisions = new Set();
        for (const policy of policies) {
            fields(policy, POLICY_KEYS);
            for (const key of [...TARGET_KEYS, 'policyId']) id(policy[key]);
            revision(policy.policyRevision); revision(policy.amount);
            instant(policy.validFrom); instant(policy.validUntil);
            if (policy.schemaVersion !== 1 || policy.moduleId !== MODULE_ID ||
                !equal(policy.profileRef, ACCEPTED_PROFILE_REF) || policy.limit !== 'assessment_runs' ||
                policy.amount < 1 || policy.validFrom >= policy.validUntil) unavailable();
            const key = JSON.stringify([policy.policyId, policy.policyRevision]);
            if (revisions.has(key)) unavailable();
            revisions.add(key);
        }
        for (let i = 0; i < policies.length; i++) {
            for (let j = i + 1; j < policies.length; j++) {
                if (sameTarget(policies[i], policies[j]) && policies[i].validFrom < policies[j].validUntil &&
                    policies[j].validFrom < policies[i].validUntil) unavailable();
            }
        }
        freeze(policies);
    } catch (_) { unavailable(); }
    return function resolveSubmissionQuota(inputSelection) {
        let selected;
        try {
            const selection = normaliseNcscSubmissionSelection(inputSelection);
            selected = policies.find(policy => sameTarget(policy, selection) &&
                policy.validFrom <= selection.at && selection.at < policy.validUntil);
        } catch (_) { unavailable(); }
        // A valid empty release manifest denies submit before SQL writes.
        // Unknown policy selection and malformed input remain fail-closed.
        if (!policies.length) noPolicy();
        if (!selected) unavailable();
        return selected;
    };
}

// The application can read approved records, never publish them. The request
// guard separately bounds the Promise and rechecks authority after its I/O.
function createDurableNcscSubmissionQuotaResolver({ readPolicies }) {
    if (typeof readPolicies !== 'function') unavailable();
    return function resolveSubmissionQuota(input) {
        const selection = normaliseNcscSubmissionSelection(input);
        let pending;
        try { pending = readPolicies(selection); } catch (_) { unavailable(); }
        if (!isPromise(pending)) unavailable();
        return Promise.prototype.then.call(pending, manifest => {
            if (manifest === null) noPolicy();
            return createNcscSubmissionQuotaResolver(manifest)(selection);
        });
    };
}

module.exports = { createNcscSubmissionQuotaResolver, createDurableNcscSubmissionQuotaResolver,
    normaliseNcscSubmissionSelection };
