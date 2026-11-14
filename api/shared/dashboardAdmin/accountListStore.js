'use strict';

// Read-only signup list for the staff console. Enumerates starter account
// records in each starter store, newest first, with their organisation names
// and the state of the matching sign-in record. Nothing here writes storage,
// and no email reaches a URL or log line.
const { inspectCustomerAuthority } = require('./customerAuthorityRecords');
const { subjectHash } = require('../customerSignup/customerAuthority');
const { AzureStarterAccountStore } = require('../customerSignup/azureStarterAccountStore');
const { hash } = require('../appLifecycle/dashboardRuntimeRecords');
const MAX_ACCOUNTS = 200;
const MAX_RECORD_BYTES = 16384;
const PREFIX = 'customer-starter/starter-accounts/';
const NAME = /^customer-starter\/starter-accounts\/[a-f0-9]{64}\.json$/;
const unavailable = () => { throw new Error('account_list_unavailable'); };
const provider = source => source.kind === 'external_starter' ? 'external' : 'legacy';

async function readSubject(container, subjectKey, signal) {
    const name = `customer-subjects/${subjectHash(subjectKey)}.json`;
    try {
        const response = await container.getBlockBlobClient(name).download(0, MAX_RECORD_BYTES + 1, { abortSignal: signal });
        const chunks = []; let size = 0;
        try {
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > MAX_RECORD_BYTES) unavailable();
            for await (const chunk of response.readableStreamBody) {
                size += chunk.length; if (size > MAX_RECORD_BYTES) unavailable(); chunks.push(chunk);
            }
            if (size !== response.contentLength) unavailable();
            return { name, etag: response.etag, record: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) };
        } finally { response.readableStreamBody?.destroy(); }
    } catch (error) {
        if (error?.statusCode === 404 && error.code === 'BlobNotFound') return { name, etag: null, record: null };
        throw error;
    }
}

// The sign-in record must match the account's own organisation slot; a
// malformed or misbound record is reported as invalid, never as active.
async function signIn(source, container, account, signal, at) {
    const subjectKey = account.identitySubjectKey ?? account.activation?.subjectKey ?? null;
    if (!subjectKey) return { status: 'none', subjectKey: null };
    const own = account.organisations[0];
    const found = await readSubject(container, subjectKey, signal);
    try {
        const result = inspectCustomerAuthority({ source, blobName: found.name, etag: found.etag, observedAt: at, record: found.record },
            { sourceSha256: hash(source), subjectKey, tenantId: own.tenantId, organisationId: own.organisationId }, at);
        return { status: result.status === 'expired' ? 'active' : result.status, subjectKey };
    } catch (_) { return { status: 'invalid', subjectKey }; }
}

async function organisations(store, account) {
    const names = account.organisations.map(slot => ({ name: slot.organisationName, kind: slot.kind }));
    if (account.accountType !== 'consultant' || !account.activation) return names;
    let cursor = null;
    // Client records are bounded by the reservation ceiling; two pages is ample.
    for (let page = 0; page < 2; page += 1) {
        const result = await store.listClients(account.accountId, { cursor, limit: 50 });
        for (const slot of result.clients) {
            if (!names.some(item => item.kind === 'client' && item.name === slot.organisationName)) names.push({ name: slot.organisationName, kind: 'client' });
        }
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
    }
    return names;
}

const MAX_LISTED_NAMES = 5000;

// Blob names are email hashes, so the cap is applied only after every name in
// both stores is sorted newest first by blob creation time (names only, no
// record reads). Records are then loaded for the newest MAX_ACCOUNTS.
function createAccountListReader(sources, now = Date.now) {
    const starters = sources.filter(({ source }) => source.kind !== 'legacy_admin');
    return async function list(signal, includeSelector = false) {
        const names = [];
        for (const entry of starters) {
            for await (const blob of entry.container.listBlobsFlat({ prefix: PREFIX, abortSignal: signal })) {
                signal.throwIfAborted();
                if (!NAME.test(blob.name)) continue;
                if (names.length >= MAX_LISTED_NAMES) unavailable();
                const created = blob.properties?.createdOn instanceof Date ? blob.properties.createdOn.getTime() : 0;
                names.push({ entry, name: blob.name, created });
            }
        }
        names.sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
        const truncated = names.length > MAX_ACCOUNTS, rows = [];
        for (const { entry: { source, container }, name } of names.slice(0, MAX_ACCOUNTS)) {
            signal.throwIfAborted();
            const store = new AzureStarterAccountStore(container);
            const key = name.slice('customer-starter/'.length, -'.json'.length);
            let loaded;
            try { loaded = await store.load(key); } catch (_) { rows.push({ provider: provider(source), readable: false }); continue; }
            if (!loaded) continue;
            const account = loaded.record, at = new Date(now()).toISOString();
            const login = await signIn(source, container, account, signal, at);
            const row = { provider: provider(source), readable: true, email: account.email, accountType: account.accountType,
                plan: account.planId, createdAt: account.createdAt, activatedAt: account.activation?.activatedAt ?? null,
                signup: account.activation ? 'activated' : 'unfinished', signIn: login.status, organisationsComplete: true,
                organisations: account.organisations.map(slot => ({ name: slot.organisationName, kind: slot.kind })) };
            try { row.organisations = await organisations(store, account); } catch (_) { row.organisationsComplete = false; }
            if (includeSelector && login.subjectKey && login.status !== 'invalid') row.selector = { provider: provider(source),
                subjectKey: login.subjectKey, tenantId: account.organisations[0].tenantId, organisationId: account.organisations[0].organisationId };
            rows.push(row);
        }
        signal.throwIfAborted();
        rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
        return { rows, truncated };
    };
}

module.exports = { createAccountListReader, MAX_ACCOUNTS };
