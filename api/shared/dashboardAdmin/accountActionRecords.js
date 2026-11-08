'use strict';

const { copy, fields, freeze, subject, uuid, id, instant, digest, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError, normaliseSelector } = require('./service');
const { createOrganisation } = require('../appLifecycle/tenantDomain');

const ACTIONS = Object.freeze(['edit', 'delete', 'restore', 'reset', 'archive', 'unarchive']);
const MAX_CONFIRMATION_BYTES = 32768;
const fail = (status = 400, suffix = 'input_invalid') => { throw new DashboardAdminError(status, 'dashboard_admin_' + suffix); };

function displayLabel(input) {
    if (typeof input !== 'string' || !input || input.length > 200 || Buffer.byteLength(input, 'utf8') > 800 ||
        input !== input.trim().normalize('NFC') || /[\p{Cc}\p{Cf}\u2028\u2029<>]/u.test(input)) fail();
    return input;
}
function actionPatch(action, input) {
    if (!ACTIONS.includes(action)) fail();
    if (action === 'edit') {
        const value = fields(copy(input, 1024), ['displayLabel']);
        displayLabel(value.displayLabel); return freeze(value);
    }
    if (input !== null) fail();
    return null;
}
function prepareInput(input) {
    try {
        const keys = ['selector', 'action', 'patch', ...(Object.hasOwn(input || {}, 'confirmationName') ? ['confirmationName'] : [])];
        const value = fields(copy(input, 4096), keys);
        if (Object.hasOwn(value, 'confirmationName') && (typeof value.confirmationName !== 'string' || value.confirmationName.length > 200)) fail();
        return freeze({ selector: normaliseSelector(value.selector), action: value.action, patch: actionPatch(value.action, value.patch),
            ...(Object.hasOwn(value, 'confirmationName') ? { confirmationName: value.confirmationName } : {}) });
    } catch (_) { fail(); }
}
function confirmationInput(input) {
    try {
        const value = fields(copy(input, 256), ['confirmationToken']);
        if (typeof value.confirmationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.confirmationToken) ||
            Buffer.from(value.confirmationToken, 'base64url').toString('base64url') !== value.confirmationToken) fail();
        return freeze(value);
    } catch (_) { fail(); }
}
function operatorPrincipal(input) {
    try {
        const value = copy(input, 4096);
        if (value.provider !== 'entra-bff' || value.isAuthenticated !== true) fail();
        subject(value.subjectKey);
        return freeze({ provider: value.provider, isAuthenticated: true, subjectKey: value.subjectKey });
    } catch (_) { fail(403, 'access_denied'); }
}
function membership(input) {
    fields(input, ['membershipId', 'status', 'validFrom', 'validUntil']);
    id(input.membershipId); instant(input.validFrom); instant(input.validUntil);
    if (!['active', 'suspended', 'removed'].includes(input.status) || input.validFrom >= input.validUntil) fail();
    return input;
}
function inspection(input, selector) {
    try {
        const expanded = Object.hasOwn(input || {}, 'members');
        const value = fields(copy(input, expanded ? 8388608 : MAX_CONFIRMATION_BYTES), ['selector', 'version', 'displayName', 'displayLabel', 'membership', 'actions', 'witness', ...(expanded ? ['members', 'invitations'] : []), ...(Object.hasOwn(input || {}, 'signup') ? ['signup'] : [])]);
        if (expanded) {
            for (const key of ['members', 'invitations']) {
                if (!Array.isArray(value[key]) || value[key].length > 10000) fail();
                for (const row of value[key]) {
                    fields(row, key === 'members' ? ['membershipId', 'subjectKey', 'status', 'roles', 'validFrom', 'validUntil', 'effectiveStatus'] :
                        ['invitationId', 'subjectKey', 'status', 'roles', 'validFrom', 'validUntil', 'expiresAt']);
                    subject(row.subjectKey); id(row[key === 'members' ? 'membershipId' : 'invitationId']);
                    instant(row.validFrom); instant(row.validUntil);
                    if (row.validFrom >= row.validUntil || !Array.isArray(row.roles) || !row.roles.length ||
                        row.roles.some(role => !['admin', 'editor', 'viewer', 'fractional_advisor'].includes(role))) fail();
                }
            }
        }
        value.selector = normaliseSelector(value.selector);
        if (!equal(value.selector, selector)) fail();
        digest(value.version);
        if (Object.hasOwn(value, 'signup')) {
            fields(value.signup, ['state', 'accountId', 'hasAuthority']); uuid(value.signup.accountId);
            if (value.signup.state !== 'half_created' || typeof value.signup.hasAuthority !== 'boolean' ||
                value.membership !== null || !equal(value.actions, ['reset'])) fail();
        } else membership(value.membership);
        // Existing accepted organisation names follow the canonical domain's
        // historical codec. A new staff-label restriction must not make a valid
        // existing account inaccessible to scoped recovery operations.
        if (createOrganisation({ tenantId: selector.tenantId, organisationId: selector.organisationId,
            displayName: value.displayName }).displayName !== value.displayName) fail();
        if (value.displayLabel !== null) displayLabel(value.displayLabel);
        if (!Array.isArray(value.actions) || new Set(value.actions).size !== value.actions.length ||
            value.actions.some(action => !ACTIONS.includes(action))) fail();
        // The native adapter owns this private witness's closed schema. It must
        // bind canonical revisions, provider/subject, restore epoch and recovery
        // receipt. It is retained verbatim and never sent to the browser.
        if (!value.witness || typeof value.witness !== 'object' || Array.isArray(value.witness)) fail();
        return freeze(value);
    } catch (_) { fail(503, 'unavailable'); }
}
function commandDigest(input) {
    const { commandSha256, ...command } = input;
    return hash(command);
}
function actionCommand(input) {
    try {
        const value = fields(copy(input, MAX_CONFIRMATION_BYTES), ['schemaVersion', 'operationId', 'actorSubjectKey',
            'selector', 'expectedVersion', 'action', 'patch', 'preparedAt', 'expiresAt', 'witness', 'commandSha256']);
        if (value.schemaVersion !== 1) fail();
        uuid(value.operationId); subject(value.actorSubjectKey); digest(value.expectedVersion); digest(value.commandSha256);
        value.selector = normaliseSelector(value.selector); value.patch = actionPatch(value.action, value.patch);
        instant(value.preparedAt); instant(value.expiresAt);
        if (value.preparedAt >= value.expiresAt || Date.parse(value.expiresAt) - Date.parse(value.preparedAt) > 300000 ||
            !value.witness || typeof value.witness !== 'object' || Array.isArray(value.witness) ||
            commandDigest(value) !== value.commandSha256) fail();
        return freeze(value);
    } catch (_) { fail(503, 'unavailable'); }
}
function actionReceipt(input, command) {
    try {
        const value = fields(copy(input, 2048), ['operationId', 'commandSha256', 'status', 'version', 'occurredAt']);
        if (value.operationId !== command.operationId || value.commandSha256 !== command.commandSha256 ||
            !['succeeded', 'pending'].includes(value.status)) fail();
        digest(value.version); instant(value.occurredAt);
        if (value.occurredAt < command.preparedAt) fail();
        return freeze(value);
    } catch (_) { fail(503, 'unavailable'); }
}

module.exports = Object.freeze({ ACTIONS, MAX_CONFIRMATION_BYTES, displayLabel, actionPatch, prepareInput,
    confirmationInput, operatorPrincipal, inspection, commandDigest, actionCommand, actionReceipt });
