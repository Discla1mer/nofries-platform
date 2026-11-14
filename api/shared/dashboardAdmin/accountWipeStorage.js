'use strict';

// Blob half of the staff account delete. Works out every record an account
// owns in one customer authority container from the account record itself,
// then deletes them, sign-in authority first and the account record last, so a
// retry after a partial failure can still find everything that remains. Each
// name is deleted with its stored versions where the storage account keeps
// versions. Shared records (terms, schedules) are never touched. Returns
// counts only; no email or key leaves this module.
const { createHash } = require('node:crypto');
const { AzureStarterAccountStore } = require('../customerSignup/azureStarterAccountStore');
const { starterAccountKey } = require('../customerSignup/starterAccountAllocation');
const { subjectHash, termsOfferKey } = require('../customerSignup/customerAuthority');
const { uuid } = require('../appLifecycle/dashboardRuntimeRecords');
const MAX_CLIENT_PAGES = 20;
const MAX_RECORD_BYTES = 16384;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function readJson(container, name, signal) {
    try {
        const response = await container.getBlockBlobClient(name).download(0, MAX_RECORD_BYTES + 1, { abortSignal: signal });
        const chunks = []; let size = 0;
        try {
            for await (const chunk of response.readableStreamBody) { size += chunk.length; if (size > MAX_RECORD_BYTES) fail('account_wipe_storage_record_invalid'); chunks.push(chunk); }
        } finally { response.readableStreamBody?.destroy(); }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
        if (error?.statusCode === 404) return null;
        if (error?.code === 'account_wipe_storage_record_invalid') throw error;
        fail('account_wipe_storage_unavailable');
    }
}

// Every record name (exact names and per-account prefixes) the account owns.
async function inventory(container, email, signal) {
    const store = new AzureStarterAccountStore(container);
    const loaded = await store.load(starterAccountKey(email));
    if (!loaded) return null;
    const account = loaded.record;
    const slots = [...account.organisations];
    if (account.accountType === 'consultant') {
        let cursor = null;
        for (let page = 0; page < MAX_CLIENT_PAGES; page += 1) {
            const result = await store.listClients(account.accountId, { cursor, limit: 50 });
            slots.push(...result.clients);
            if (!result.nextCursor) break;
            if (page === MAX_CLIENT_PAGES - 1) fail('account_wipe_storage_too_many_clients');
            cursor = result.nextCursor;
        }
    }
    const subjectKey = account.identitySubjectKey ?? account.activation?.subjectKey ?? null;
    const exact = [], prefixes = [`customer-starter/starter-clients/${uuid(account.accountId)}/`, `customer-starter/starter-client-bindings/${account.accountId}/`];
    if (subjectKey) {
        exact.push(`customer-subjects/${subjectHash(subjectKey)}.json`, `customer-signup-recoveries/${subjectHash(subjectKey)}.json`);
        const authority = await readJson(container, `customer-subjects/${subjectHash(subjectKey)}.json`, signal);
        if (authority && typeof authority.invitationDigest === 'string' && /^[a-f0-9]{64}$/.test(authority.invitationDigest))
            // Same key as customerAuthority's proofKey.
            exact.push(`customer-email-proofs/${sha256(`${subjectKey}\0${authority.invitationDigest}`)}.json`);
    }
    for (const slot of slots) {
        exact.push(`customer-starter/starter-setups/${uuid(slot.organisationId)}.json`, `customer-activations/${uuid(slot.activationId)}.json`,
            termsOfferKey(slot.tenantId, slot.organisationId));
    }
    const accountKey = starterAccountKey(email);
    exact.push(`customer-starter/dashboard-admin-signup-index/writers/accounts/${accountKey.slice('starter-accounts/'.length)}.json`);
    return Object.freeze({ account, subjectKey, tenantIds: Object.freeze([...new Set(slots.map(slot => slot.tenantId))]),
        exact: Object.freeze([...new Set(exact)]), prefixes: Object.freeze(prefixes), accountRecord: `customer-starter/${accountKey}.json` });
}

// Delete one name and, where kept, its versions. A version the identity may not
// delete is counted as remaining rather than failing the whole delete.
async function removeName(container, name, signal, counts) {
    let versionsRemaining = 0;
    try {
        for await (const item of container.listBlobsFlat({ prefix: name, includeVersions: true, abortSignal: signal })) {
            if (item.name !== name || !item.versionId || item.isCurrentVersion) continue;
            try { await container.getBlobClient(name).withVersion(item.versionId).delete({ abortSignal: signal }); counts.versions += 1; }
            catch (error) { if (error?.statusCode !== 404) versionsRemaining += 1; }
        }
    } catch (_) { /* Listing versions is unsupported or refused: delete the current blob only. */ }
    try {
        const result = await container.getBlobClient(name).deleteIfExists({ deleteSnapshots: 'include', abortSignal: signal });
        if (result.succeeded) counts.blobs += 1;
    } catch (_) { fail('account_wipe_storage_unavailable'); }
    counts.versionsRemaining += versionsRemaining;
}

function createAccountWipeStorage(container) {
    if (!container || typeof container.getBlobClient !== 'function' || typeof container.listBlobsFlat !== 'function') fail('account_wipe_configuration_invalid');
    return Object.freeze({
        inventory: (email, signal) => inventory(container, email, signal),
        async delete(found, signal) {
            const counts = { blobs: 0, versions: 0, versionsRemaining: 0 };
            // The sign-in authority goes first so the account stops working at once.
            for (const name of found.exact) { signal.throwIfAborted(); await removeName(container, name, signal, counts); }
            for (const prefix of found.prefixes) {
                const names = [];
                try { for await (const item of container.listBlobsFlat({ prefix, abortSignal: signal })) names.push(item.name); }
                catch (_) { fail('account_wipe_storage_unavailable'); }
                for (const name of names) { signal.throwIfAborted(); await removeName(container, name, signal, counts); }
            }
            await removeName(container, found.accountRecord, signal, counts);
            return Object.freeze(counts);
        }
    });
}

module.exports = { createAccountWipeStorage };
