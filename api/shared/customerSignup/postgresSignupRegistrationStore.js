'use strict';

const { createHash } = require('node:crypto');
const { isProxy } = require('node:util').types;
const { validateAcceptanceReceipt } = require('./invitationAcceptance');
const SUBJECT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const BASE_BINDING = ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion', 'termsDigest'];
const bindingKeys = value => [...BASE_BINDING, ...(Object.hasOwn(value, 'scheduleId') ? ['scheduleId', 'scheduleDigest'] : [])];
const SCOPE = ['tenantId', 'organisationId', 'invitationId'];
const MAX_REGISTRATIONS = 128;
const MAX_BYTES = 256 * 1024;

class SignupRegistrationError extends Error {
    constructor(code = 'signup_registration_unavailable', statusCode = 503) {
        super(code); this.name = 'SignupRegistrationError'; this.code = code; this.statusCode = statusCode;
    }
}
const fail = (code, status) => { throw new SignupRegistrationError(code, status); };
const conflict = () => fail('signup_registration_conflict', 409);

function exact(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) throw new Error();
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error();
    const result = {};
    for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
        result[key] = descriptor.value;
    }
    return result;
}
function subject(value) {
    if (typeof value !== 'string' || !SUBJECT.test(value)) throw new Error();
    return value;
}
function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new Error();
    return value;
}
function identifier(value) {
    if (typeof value !== 'string' || !value || value.length > 180 || value.trim() !== value ||
        /[\u0000-\u001f\u007f]/.test(value) || Buffer.from(value).toString('utf8') !== value) throw new Error();
    return value;
}
function scope(value) {
    const result = exact(value, SCOPE);
    SCOPE.forEach(key => identifier(result[key]));
    return result;
}
const sameScope = (a, b) => SCOPE.every(key => a[key] === b[key]);
function reference(value) {
    const keys = bindingKeys(value);
    const result = exact(value, [...keys, 'status']);
    subject(result.subjectKey);
    for (const key of ['tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion']) identifier(result[key]);
    if (typeof result.termsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(result.termsDigest) ||
        (Object.hasOwn(result, 'scheduleId') && (identifier(result.scheduleId),
            typeof result.scheduleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(result.scheduleDigest))) ||
        !['pending_admission', 'revoked'].includes(result.status)) throw new Error();
    return result;
}
function state(value, expectedSubject) {
    const result = exact(value, ['schemaVersion', 'subjectKey', 'revision', 'selected', 'registrations']);
    if (result.schemaVersion !== 1 || subject(result.subjectKey) !== expectedSubject) throw new Error();
    revision(result.revision);
    const items = result.registrations;
    if (!Array.isArray(items) || isProxy(items) || items.length > MAX_REGISTRATIONS ||
        Reflect.ownKeys(items).length !== items.length + 1) throw new Error();
    result.registrations = [];
    for (let index = 0; index < items.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(items, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
        const item = reference(descriptor.value);
        if (item.subjectKey !== expectedSubject || result.registrations.some(other => sameScope(other, item))) throw new Error();
        result.registrations.push(item);
    }
    if (result.selected !== null) {
        result.selected = scope(result.selected);
        if (!result.registrations.some(item => sameScope(item, result.selected) && item.status === 'pending_admission')) throw new Error();
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error();
    return result;
}
function input(work) {
    try { return work(); } catch (_) { fail('signup_registration_input_invalid', 400); }
}
function project(item, version) { return item ? Object.freeze({ ...item, revision: version }) : null; }
const MAX_SCOPED_BYTES = 8192;
function scopeKey(value) { return createHash('sha256').update(JSON.stringify(SCOPE.map(key => value[key]))).digest('hex'); }
function scopedHeader(value, expectedSubject) {
    const result = exact(value, ['schemaVersion', 'subjectKey', 'revision', 'selected']);
    if (result.schemaVersion !== 2 || subject(result.subjectKey) !== expectedSubject ||
        Buffer.byteLength(JSON.stringify(result)) > MAX_SCOPED_BYTES) throw new Error();
    revision(result.revision); if (result.selected !== null) result.selected = scope(result.selected); return result;
}
function headerRow(row, expectedSubject, scoped) {
    try {
        if (!row || row.identity_tenant_id !== expectedSubject.slice(0, 36) || row.subject_key !== expectedSubject ||
            scoped && row.row_key !== '') throw new Error();
        const result = row.payload?.schemaVersion === 2 ? scopedHeader(row.payload, expectedSubject) : state(row.payload, expectedSubject);
        if (result.schemaVersion === 2 && !scoped || String(result.revision) !== String(row.revision)) throw new Error();
        return result;
    } catch (_) { fail('signup_registration_record_invalid'); }
}
function entryRow(row, expectedSubject, header, expectedScope) {
    try {
        if (!row || row.identity_tenant_id !== expectedSubject.slice(0, 36) || row.subject_key !== expectedSubject ||
            typeof row.row_key !== 'string' || !/^[a-f0-9]{64}$/.test(row.row_key)) throw new Error();
        const value = exact(row.payload, ['schemaVersion', 'subjectKey', 'revision', 'binding']);
        if (value.schemaVersion !== 2 || subject(value.subjectKey) !== expectedSubject ||
            revision(value.revision) > header.revision || String(value.revision) !== String(row.revision) ||
            Buffer.byteLength(JSON.stringify(value)) > MAX_SCOPED_BYTES) throw new Error();
        const binding = reference(value.binding);
        if (binding.subjectKey !== expectedSubject || scopeKey(binding) !== row.row_key ||
            expectedScope && !sameScope(binding, expectedScope)) throw new Error();
        return binding;
    } catch (_) { fail('signup_registration_record_invalid'); }
}
async function storageLayout(tx) {
    // The runtime has no migration-ledger privilege. This bounded catalog read
    // recognises only the additive scoped-key column, never grants authority.
    const result = await tx.query(`SELECT a.atttypid = 'pg_catalog.text'::pg_catalog.regtype AS is_text, a.attnotnull AS not_null,
        EXISTS (SELECT 1 FROM pg_catalog.pg_constraint p
          JOIN pg_catalog.pg_attribute t ON t.attrelid=c.oid AND t.attname='identity_tenant_id' AND NOT t.attisdropped
          JOIN pg_catalog.pg_attribute s ON s.attrelid=c.oid AND s.attname='subject_key' AND NOT s.attisdropped
          WHERE p.conrelid=c.oid AND p.contype='p' AND p.conkey=ARRAY[t.attnum,s.attnum,a.attnum]::smallint[]) AS scoped_primary_key
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='nofries' AND c.relname='signup_registrations' AND c.relkind='r'
          AND a.attname='row_key' AND a.attnum>0 AND NOT a.attisdropped LIMIT 2`, []);
    if (!Array.isArray(result?.rows) || result.rows.length > 1) fail('signup_registration_record_invalid');
    if (!result.rows.length) return false;
    const row = result.rows[0];
    if (!row || row.is_text !== true || row.not_null !== true || row.scoped_primary_key !== true || Object.keys(row).length !== 3) fail('signup_registration_record_invalid');
    return true;
}
async function readSignupRegistrationLayout(tx) {
    return await storageLayout(tx) ? 'scoped' : 'legacy';
}
const columns = scoped => 'identity_tenant_id, subject_key, revision, payload' + (scoped ? ', row_key' : '');
async function loadEntry(tx, subjectKey, header, target) {
    const result = await tx.query(`SELECT ${columns(true)} FROM nofries.signup_registrations
        WHERE identity_tenant_id=$1 AND subject_key=$2 AND row_key=$3 LIMIT 2`,
    [subjectKey.slice(0, 36), subjectKey, scopeKey(target)]);
    if (!Array.isArray(result?.rows) || result.rows.length > 1) fail('signup_registration_record_invalid');
    return result.rows.length ? entryRow(result.rows[0], subjectKey, header, target) : null;
}
async function hasEntries(tx, subjectKey) {
    const result = await tx.query(`SELECT row_key FROM nofries.signup_registrations
        WHERE identity_tenant_id=$1 AND subject_key=$2 AND row_key>'' ORDER BY row_key LIMIT 1`, [subjectKey.slice(0, 36), subjectKey]);
    if (!Array.isArray(result?.rows) || result.rows.length > 1) fail('signup_registration_record_invalid');
    return result.rows.length === 1;
}
async function loadHeader(tx, subjectKey, scoped, lock = 'SHARE') {
    async function read() {
        const result = await tx.query(`SELECT ${columns(scoped)} FROM nofries.signup_registrations
            WHERE identity_tenant_id=$1 AND subject_key=$2${scoped ? " AND row_key=''" : ''} LIMIT 2 FOR ${lock}`,
        [subjectKey.slice(0, 36), subjectKey]);
        if (!Array.isArray(result?.rows) || result.rows.length > 1) fail('signup_registration_record_invalid');
        return result.rows.length ? headerRow(result.rows[0], subjectKey, scoped) : null;
    }
    let header = await read();
    if (scoped && !header && await hasEntries(tx, subjectKey)) {
        // Under READ COMMITTED another first acceptance can commit its header
        // and entry between our missing-header read and orphan check. Recheck
        // the exact header once under the requested lock; a real orphan fails.
        header = await read();
        if (!header) fail('signup_registration_record_invalid');
    }
    if (scoped && header?.schemaVersion === 1 && await hasEntries(tx, subjectKey)) fail('signup_registration_record_invalid');
    if (header?.schemaVersion === 2 && header.selected !== null) {
        const selected = await loadEntry(tx, subjectKey, header, header.selected);
        if (!selected || selected.status !== 'pending_admission') fail('signup_registration_record_invalid');
    }
    return header;
}
async function readSignupRegistrationHeader(tx, subjectKey, options = {}) {
    const lock = input(() => {
        subject(subjectKey);
        if (!options || typeof options !== 'object' || isProxy(options)) throw new Error();
        const value = exact(options, Object.hasOwn(options, 'lock') ? ['lock'] : []);
        const result = value.lock === undefined ? 'SHARE' : value.lock;
        if (!['SHARE', 'UPDATE'].includes(result)) throw new Error();
        return result;
    });
    const scoped = await storageLayout(tx), header = await loadHeader(tx, subjectKey, scoped, lock);
    return header ? Object.freeze({ subjectKey, storageMode: header.schemaVersion === 2 ? 'scoped' : 'legacy' }) : null;
}
const lockSignupRegistrationHeader = (tx, subjectKey) => readSignupRegistrationHeader(tx, subjectKey, { lock: 'UPDATE' });

/** Current receipt references only; membership and admission remain separate. */
function createPostgresSignupRegistrationStore({ database, allowScopedWrites = false } = {}) {
    if (!database || isProxy(database) || typeof database.withTenantTransaction !== 'function' || typeof allowScopedWrites !== 'boolean') {
        throw new TypeError('signup_registration_database_required');
    }
    async function transaction(subjectKey, work) {
        try {
            return await database.withTenantTransaction(subjectKey.slice(0, 36), async tx => {
                await tx.query("SELECT set_config('nofries.signup_subject_key', $1, true)", [subjectKey]);
                return work(tx, await storageLayout(tx));
            });
        } catch (error) { if (error instanceof SignupRegistrationError) throw error; throw new SignupRegistrationError(); }
    }
    async function saveHeader(tx, before, next, scoped) {
        try { next = next.schemaVersion === 2 ? scopedHeader(next, next.subjectKey) : state(next, next.subjectKey); }
        catch (_) { fail('signup_registration_record_invalid'); }
        const result = await tx.query(`UPDATE nofries.signup_registrations SET revision=$3, payload=$4::jsonb
            WHERE identity_tenant_id=$1 AND subject_key=$2 AND revision=$5${scoped ? " AND row_key=''" : ''}
            RETURNING ${columns(scoped)}`, [next.subjectKey.slice(0, 36), next.subjectKey, next.revision, JSON.stringify(next), before.revision]);
        if (!Array.isArray(result?.rows) || result.rows.length !== 1 ||
            JSON.stringify(headerRow(result.rows[0], next.subjectKey, scoped)) !== JSON.stringify(next)) conflict();
        return next;
    }
    function advanced(header) { if (header.revision >= Number.MAX_SAFE_INTEGER) conflict(); return header.revision + 1; }
    async function insertEntry(tx, header, binding, at) {
        const payload = { schemaVersion: 2, subjectKey: header.subjectKey, revision: at, binding };
        if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SCOPED_BYTES) fail('signup_registration_record_invalid');
        const result = await tx.query(`INSERT INTO nofries.signup_registrations (identity_tenant_id,subject_key,row_key,revision,payload)
            VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING ${columns(true)}`,
        [header.subjectKey.slice(0, 36), header.subjectKey, scopeKey(binding), at, JSON.stringify(payload)]);
        if (!Array.isArray(result?.rows) || result.rows.length !== 1 ||
            JSON.stringify(entryRow(result.rows[0], header.subjectKey, { ...header, revision: at }, binding)) !== JSON.stringify(binding)) conflict();
    }
    async function updateEntry(tx, header, binding, at) {
        const payload = { schemaVersion: 2, subjectKey: header.subjectKey, revision: at, binding };
        const result = await tx.query(`UPDATE nofries.signup_registrations SET revision=$4,payload=$5::jsonb
            WHERE identity_tenant_id=$1 AND subject_key=$2 AND row_key=$3 RETURNING ${columns(true)}`,
        [header.subjectKey.slice(0, 36), header.subjectKey, scopeKey(binding), at, JSON.stringify(payload)]);
        if (!Array.isArray(result?.rows) || result.rows.length !== 1 ||
            JSON.stringify(entryRow(result.rows[0], header.subjectKey, { ...header, revision: at }, binding)) !== JSON.stringify(binding)) conflict();
    }
    async function convert(tx, header) {
        for (const binding of header.registrations) await insertEntry(tx, header, binding, header.revision);
        return saveHeader(tx, header, { schemaVersion: 2, subjectKey: header.subjectKey, revision: header.revision, selected: header.selected }, true);
    }
    function matching(existing, binding, strict = false) {
        if (existing.status === 'revoked') fail('signup_registration_revoked', 403);
        if (strict && bindingKeys(existing).length !== bindingKeys(binding).length ||
            bindingKeys(binding).some(key => existing[key] !== binding[key])) conflict();
        return existing;
    }
    async function register(value, scopedWrite) {
        if (scopedWrite && !allowScopedWrites) fail('signup_registration_read_only', 403);
        const receipt = input(() => validateAcceptanceReceipt(value));
        const keys = bindingKeys(receipt), binding = input(() => reference(Object.fromEntries([...keys, 'status'].map(key => [key, receipt[key]]))));
        return transaction(binding.subjectKey, async (tx, scoped) => {
            if (scoped && !allowScopedWrites) fail('signup_registration_read_only', 403);
            if (scopedWrite && !scoped) fail('signup_registration_layout_required', 503);
            let header = await loadHeader(tx, binding.subjectKey, scoped, 'UPDATE');
            if (!header) {
                const empty = { schemaVersion: 1, subjectKey: binding.subjectKey, revision: 0, selected: null, registrations: [] };
                await tx.query(`INSERT INTO nofries.signup_registrations (identity_tenant_id, subject_key, revision, payload)
                    VALUES ($1,$2,0,$3::jsonb) ON CONFLICT ${scoped ? '(identity_tenant_id,subject_key,row_key)' : '(identity_tenant_id,subject_key)'} DO NOTHING`,
                [binding.subjectKey.slice(0, 36), binding.subjectKey, JSON.stringify(empty)]);
                header = await loadHeader(tx, binding.subjectKey, scoped, 'UPDATE');
                if (!header) fail('signup_registration_not_found', 404);
            }
            if (header.schemaVersion === 1) {
                const existing = header.registrations.find(item => sameScope(item, binding));
                if (existing) return project(matching(existing, binding), header.revision);
                if (scopedWrite) header = await convert(tx, header);
                else {
                    if (header.registrations.length >= MAX_REGISTRATIONS) fail('signup_registration_capacity', 409);
                    const next = { ...header, registrations: [...header.registrations, binding], revision: advanced(header) };
                    const pending = next.registrations.filter(item => item.status === 'pending_admission');
                    next.selected = pending.length === 1 ? Object.fromEntries(SCOPE.map(key => [key, binding[key]])) : null;
                    await saveHeader(tx, header, next, scoped); return project(binding, next.revision);
                }
            }
            const existing = await loadEntry(tx, binding.subjectKey, header, binding);
            if (existing) return project(matching(existing, binding, true), header.revision);
            const next = { ...header, revision: advanced(header) };
            await insertEntry(tx, header, binding, next.revision);
            const pending = await tx.query(`SELECT ${columns(true)} FROM nofries.signup_registrations
                WHERE identity_tenant_id=$1 AND subject_key=$2 AND row_key<>''
                  AND payload#>>'{binding,status}'='pending_admission' ORDER BY row_key LIMIT 2`, [binding.subjectKey.slice(0, 36), binding.subjectKey]);
            if (!Array.isArray(pending?.rows) || pending.rows.length > 2) fail('signup_registration_record_invalid');
            const bindings = pending.rows.map(row => entryRow(row, binding.subjectKey, next));
            if (bindings.some(item => item.status !== 'pending_admission') || !bindings.length) fail('signup_registration_record_invalid');
            next.selected = bindings.length === 1 ? Object.fromEntries(SCOPE.map(key => [key, bindings[0][key]])) : null;
            await saveHeader(tx, header, next, true); return project(binding, next.revision);
        });
    }
    function target(command) {
        return input(() => { const result = exact(command, ['subjectKey', ...SCOPE, 'expectedRevision']);
            subject(result.subjectKey); SCOPE.forEach(key => identifier(result[key])); revision(result.expectedRevision); return Object.freeze(result); });
    }
    async function change(command, revoke) {
        const query = target(command);
        return transaction(query.subjectKey, async (tx, scoped) => {
            const header = await loadHeader(tx, query.subjectKey, scoped, 'UPDATE');
            if (!header) fail('signup_registration_not_found', 404);
            if (!revoke && query.expectedRevision !== header.revision) conflict();
            const item = header.schemaVersion === 1 ? header.registrations.find(row => sameScope(row, query)) : await loadEntry(tx, query.subjectKey, header, query);
            if (!item) fail('signup_registration_not_found', 404);
            if (revoke && item.status === 'revoked') return project(item, header.revision);
            if (query.expectedRevision !== header.revision) conflict();
            if (item.status !== 'pending_admission') fail('signup_registration_revoked', 403);
            const selected = Object.fromEntries(SCOPE.map(key => [key, item[key]]));
            const next = { ...header, selected: revoke ? header.selected && sameScope(header.selected, item) ? null : header.selected : selected };
            const updated = revoke ? { ...item, status: 'revoked' } : item;
            if (!revoke && JSON.stringify(next) === JSON.stringify(header)) return project(item, header.revision);
            next.revision = advanced(header);
            if (header.schemaVersion === 1) next.registrations = header.registrations.map(entry => sameScope(entry, item) ? updated : entry);
            else if (revoke) await updateEntry(tx, header, updated, next.revision);
            await saveHeader(tx, header, next, scoped); return project(updated, next.revision);
        });
    }
    return Object.freeze({
        registerAcceptance: value => register(value, false),
        registerScopedAcceptance: value => register(value, true),
        async assertAcceptanceWritable(value) {
            const subjectKey = input(() => subject(exact(value, ['subjectKey']).subjectKey));
            return transaction(subjectKey, async (tx, scoped) => {
                if (scoped && !allowScopedWrites) fail('signup_registration_read_only', 403);
                await loadHeader(tx, subjectKey, scoped);
            });
        },
        async readStorageLayout(value) {
            const subjectKey = input(() => subject(exact(value, ['subjectKey']).subjectKey));
            return transaction(subjectKey, async (tx, scoped) => {
                await loadHeader(tx, subjectKey, scoped);
                return scoped ? 'scoped' : 'legacy';
            });
        },
        async readStorageMode(value) {
            const subjectKey = input(() => subject(exact(value, ['subjectKey']).subjectKey));
            return transaction(subjectKey, async (tx, scoped) => { const header = await loadHeader(tx, subjectKey, scoped);
                return header ? header.schemaVersion === 2 ? 'scoped' : 'legacy' : null; });
        },
        async readRegistration(value) {
            const subjectKey = input(() => subject(exact(value, ['subjectKey']).subjectKey));
            return transaction(subjectKey, async (tx, scoped) => {
                const header = await loadHeader(tx, subjectKey, scoped); if (!header?.selected) return null;
                const item = header.schemaVersion === 1 ? header.registrations.find(item => sameScope(item, header.selected)) : await loadEntry(tx, subjectKey, header, header.selected);
                return project(item, header.revision);
            });
        },
        async readForInvitation(value) {
            const query = input(() => { const result = exact(value, ['subjectKey', ...SCOPE]); subject(result.subjectKey); SCOPE.forEach(key => identifier(result[key])); return result; });
            return transaction(query.subjectKey, async (tx, scoped) => {
                const header = await loadHeader(tx, query.subjectKey, scoped); if (!header) return null;
                const item = header.schemaVersion === 1 ? header.registrations.find(item => sameScope(item, query)) : await loadEntry(tx, query.subjectKey, header, query);
                return project(item, header.revision);
            });
        },
        selectRegistration: command => change(command, false),
        revokeRegistration: command => change(command, true)
    });
}

module.exports = Object.freeze({ createPostgresSignupRegistrationStore, SignupRegistrationError, readSignupRegistrationLayout,
    readSignupRegistrationHeader, lockSignupRegistrationHeader });
