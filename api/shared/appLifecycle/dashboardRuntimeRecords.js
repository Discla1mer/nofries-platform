'use strict';

// Pure, fixed current-record codecs shared by the runtime store and request guard.
const crypto = require('node:crypto');
const { isProxy } = require('node:util').types;
const domain = require('./dashboardOnboardingDomain');

const MAX_OPERATION = 524288, MAX_EFFECT = 262144, MAX_SMALL = 16384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code, status) => { throw new domain.DashboardOnboardingError(code, status); };
const invalid = () => fail('onboarding_input_invalid', 400);
const large = () => fail('onboarding_request_too_large', 413);
const bad = () => fail('onboarding_record_invalid', 503);
function retained(work) { try { return work(); } catch (_) { bad(); } }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function unicode(value) {
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c === 0 || c >= 0xdc00 && c <= 0xdfff) invalid();
        if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) invalid(); }
    }
    return value;
}
function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) invalid();
    return value;
}
function fields(value, keys) {
    plain(value);
    const found = Reflect.ownKeys(value);
    if (found.length !== keys.length || found.some(key => !keys.includes(key))) invalid();
    for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !d.enumerable || !own(d, 'value')) invalid(); }
    return value;
}
function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function copy(value, maximum = MAX_OPERATION) {
    const active = new Set(); let nodes = 0;
    function visit(item, depth) {
        if (++nodes > 200000 || depth > 128) large();
        if (item === null || typeof item === 'boolean') return item;
        if (typeof item === 'string') return unicode(item);
        if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) invalid(); return item; }
        if (!item || typeof item !== 'object' || isProxy(item) || active.has(item)) invalid();
        active.add(item); let result;
        if (Array.isArray(item)) {
            const keys = Reflect.ownKeys(item);
            if (keys.length !== item.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(String(key)))) invalid();
            result = [];
            for (let i = 0; i < item.length; i++) {
                const d = Object.getOwnPropertyDescriptor(item, String(i));
                if (!d || !d.enumerable || !own(d, 'value')) invalid(); result.push(visit(d.value, depth + 1));
            }
        } else {
            plain(item); result = {};
            const keys = Reflect.ownKeys(item); if (keys.some(key => typeof key !== 'string')) invalid();
            for (const key of keys.sort()) {
                unicode(key);
                const d = Object.getOwnPropertyDescriptor(item, key);
                if (!d || !d.enumerable || !own(d, 'value')) invalid();
                Object.defineProperty(result, key, { value: visit(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
            }
        }
        active.delete(item); return result;
    }
    const result = visit(value, 0);
    if (Buffer.byteLength(canonical(result), 'utf8') > maximum) large();
    return result;
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function digest(value) { if (typeof value !== 'string' || !DIGEST.test(value)) invalid(); return value; }
function id(value) { if (typeof value !== 'string' || !value || value.length > 180 || value !== value.trim() || /[\u0000-\u001f\u007f*]/.test(value)) invalid(); return unicode(value); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid(); return value; }
function instant(value) {
    if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) invalid();
    const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid(); return value;
}
function scope(value) { fields(value, ['tenantId', 'organisationId']); id(value.tenantId); id(value.organisationId); return value; }
function subject(value) { if (typeof value !== 'string' || value.length !== 73 || value[36] !== ':') invalid(); uuid(value.slice(0, 36)); uuid(value.slice(37)); return value; }
const hash = value => crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const equal = (a, b) => canonical(a) === canonical(b);

const CURRENT_COLUMNS = freeze({
    instance: 'instance_id revision restore_epoch ingress_status changed_at evidence_ref evidence_sha256 record_sha256 head_receipt_id'.split(' '),
    authority: 'authority_id tenant_id organisation_id head_revision head_sha256 status updated_at'.split(' '),
    admission: 'authority_id revision tenant_id organisation_id parent_revision parent_sha256 decision_sha256 occurred_at actor_subject_key payload'.split(' '),
    binding: 'binding_id tenant_id organisation_id membership_id invitation_id grant_evidence_id identity_sha256 identity_payload subject_key binding_origin case_id approval_id approval_revision approval_sha256 acceptance_receipt_id publication_receipt_id authority_id authority_revision authority_sha256 revision status valid_from valid_until created_at updated_at organisation_label'.split(' '),
    session: 'session_sha256 kind parent_session_sha256 operator_issuance_sha256 identity_sha256 identity_payload subject_key status revision selection_generation generation_token selected_binding_id selected_tenant_id selected_organisation_id discovery_case_id discovery_proof_id issued_at expires_at restore_epoch instance_id created_at updated_at revoked_at'.split(' ')
});
const JSON_COLUMNS = new Set(['payload', 'identity_payload', 'scope_json']);
const NUMBER_COLUMNS = new Set(['revision', 'head_revision', 'parent_revision', 'case_revision', 'approval_revision', 'authority_revision', 'selection_generation', 'instance_result_revision']);
const TIME_COLUMNS = new Set(['created_at', 'updated_at', 'changed_at', 'occurred_at', 'accept_before', 'verified_at', 'fresh_until', 'valid_from', 'valid_until', 'issued_at', 'expires_at', 'revoked_at']);
const snake = key => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const sqlScope = value => ({ tenant_id: value ? value.tenantId : null, organisation_id: value ? value.organisationId : null });
const readScope = row => row.tenant_id === null && row.organisation_id === null ? null : scope({ tenantId: row.tenant_id, organisationId: row.organisation_id });

function cleanCurrentRow(kind, input) {
    return retained(() => {
        fields(input, CURRENT_COLUMNS[kind]); const row = {};
        for (const key of CURRENT_COLUMNS[kind]) {
            const value = input[key];
            if (value === null) row[key] = null;
            else if (NUMBER_COLUMNS.has(key)) {
                if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) bad();
                row[key] = revision(Number(value));
            } else if (TIME_COLUMNS.has(key)) row[key] = instant(value instanceof Date && !isProxy(value) ? value.toISOString() : value);
            else row[key] = copy(value, JSON_COLUMNS.has(key) ? MAX_EFFECT : MAX_SMALL);
        }
        return row;
    });
}

function projectCurrentRow(kind, value, meta = {}) {
    let result;
    switch (kind) {
        case 'instance': result = { instance_id: value.instanceId, revision: value.revision, restore_epoch: value.restoreEpoch, ingress_status: value.ingressStatus, changed_at: value.changedAt, evidence_ref: value.evidenceRef, evidence_sha256: value.evidenceSha256, record_sha256: hash(value), head_receipt_id: meta.receiptId }; break;
        case 'authority': result = { authority_id: value.authorityId, ...sqlScope(value.scope), head_revision: value.revision, head_sha256: value.decisionSha256, status: value.payload.decision, updated_at: value.payload.occurredAt }; break;
        case 'admission': result = { authority_id: value.authorityId, revision: value.revision, ...sqlScope(value.scope), parent_revision: value.parentRevision, parent_sha256: value.parentSha256, decision_sha256: value.decisionSha256, occurred_at: value.payload.occurredAt, actor_subject_key: value.payload.actorSubjectKey, payload: value.payload }; break;
        case 'binding': {
            const omit = new Set(['schemaVersion', 'scope', 'identity', 'origin', 'authorityRef']); result = {};
            for (const key of Object.keys(value)) if (!omit.has(key)) result[snake(key)] = value[key];
            Object.assign(result, sqlScope(value.scope), { identity_payload: value.identity, binding_origin: value.origin, authority_id: value.authorityRef.authorityId, authority_revision: value.authorityRef.revision, authority_sha256: value.authorityRef.sha256 }); break;
        }
        case 'session': result = {}; for (const key of Object.keys(value)) if (key !== 'schemaVersion') result[snake(key)] = value[key]; break;
        default: bad();
    }
    fields(result, CURRENT_COLUMNS[kind]); return result;
}

const OUTER_INSTANCE_FIELDS = ['schemaVersion', 'instanceId', 'revision', 'restoreEpoch',
    'ingressStatus', 'changedAt', 'evidenceRef', 'evidenceSha256'];
function instanceRecordValue(value) {
    fields(value, OUTER_INSTANCE_FIELDS);
    if (value.schemaVersion !== 1) invalid();
    uuid(value.instanceId); revision(value.revision); uuid(value.restoreEpoch);
    if (!['fenced', 'enabled'].includes(value.ingressStatus) ||
        value.revision === 0 && value.ingressStatus !== 'fenced') invalid();
    instant(value.changedAt); id(value.evidenceRef); digest(value.evidenceSha256);
    return freeze(value);
}
function normalizeInstance(value) {
    return retained(() => instanceRecordValue(copy(value, MAX_SMALL)));
}

function prepareCurrentRow(kind, raw) {
    if (!own(CURRENT_COLUMNS, kind)) bad();
    const row = cleanCurrentRow(kind, raw); let value = null;
    switch (kind) {
        case 'session':
            value = { schemaVersion: 1 };
            for (const [key, field] of Object.entries(row)) value[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = field;
            break;
        case 'binding': {
            value = { schemaVersion: 1, scope: readScope(row), identity: row.identity_payload,
                origin: row.binding_origin, authorityRef: { authorityId: row.authority_id, revision: row.authority_revision, sha256: row.authority_sha256 } };
            const omitted = new Set(['tenant_id', 'organisation_id', 'identity_payload', 'binding_origin', 'authority_id', 'authority_revision', 'authority_sha256']);
            for (const [key, field] of Object.entries(row)) if (!omitted.has(key)) value[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = field;
            break;
        }
        case 'admission':
            value = { schemaVersion: 1, authorityId: row.authority_id, scope: readScope(row), revision: row.revision,
                parentRevision: row.parent_revision, parentSha256: row.parent_sha256, decisionSha256: row.decision_sha256, payload: row.payload };
            break;
        case 'instance':
            value = { schemaVersion: 1, instanceId: row.instance_id, revision: row.revision,
                restoreEpoch: row.restore_epoch, ingressStatus: row.ingress_status, changedAt: row.changed_at, evidenceRef: row.evidence_ref, evidenceSha256: row.evidence_sha256 };
            break;
        case 'authority': break;
        default: bad();
    }
    return { row, value };
}

function currentRowAgrees(kind, row, value, meta) { if (!equal(row, projectCurrentRow(kind, value, meta))) bad(); return value; }
function normaliseSessionRow(raw) {
    return retained(() => { const { row, value } = prepareCurrentRow('session', raw);
        return currentRowAgrees('session', row, domain.normaliseSessionRecord(value)); });
}
function normaliseBindingRow(raw) {
    return retained(() => { const { row, value } = prepareCurrentRow('binding', raw);
        return currentRowAgrees('binding', row, domain.normaliseIdentityBinding(value)); });
}
function normaliseAdmissionRow(raw) {
    return retained(() => { const { row, value } = prepareCurrentRow('admission', raw);
        return currentRowAgrees('admission', row, domain.normaliseAdmissionRecord(value)); });
}
function normaliseInstanceRow(raw) {
    return retained(() => { const { row, value } = prepareCurrentRow('instance', raw);
        const record = normalizeInstance(value); uuid(row.head_receipt_id);
        currentRowAgrees('instance', row, record, { receiptId: row.head_receipt_id });
        return freeze({ record, receiptId: row.head_receipt_id }); });
}
function normaliseAdmissionRows(input) {
    return retained(() => { fields(input, ['head', 'decision']);
        const { row } = prepareCurrentRow('authority', input.head), value = normaliseAdmissionRow(input.decision);
        return currentRowAgrees('authority', row, value); });
}

module.exports = Object.freeze({ copy, fields, freeze, canonical, hash, equal, uuid, digest, id, revision, instant, scope, subject, unicode,
    CURRENT_COLUMNS, prepareCurrentRow, projectCurrentRow, instanceRecordValue, normalizeInstance,
    normaliseSessionRow, normaliseInstanceRow, normaliseBindingRow, normaliseAdmissionRow, normaliseAdmissionRows });
