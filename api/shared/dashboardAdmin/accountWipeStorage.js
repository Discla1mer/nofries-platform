'use strict';

// Blob half of the staff account delete. Works out every record an account
// owns from the account record itself: in its customer authority container,
// and its email proof in the session container. Deletes the email proof first
// (its name is derived from the sign-in authority record), then the sign-in
// authority, and the account record last, so a retry after a partial failure
// can still find everything that remains. Each
// name is deleted with its stored versions where the storage account keeps
// versions. Shared records (terms, schedules) and the legacy signup index
// are never touched. Returns
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
    const accountName = `customer-starter/${starterAccountKey(email)}.json`;
    const loaded = await store.load(starterAccountKey(email));
    if (!loaded) {
        // An earlier attempt may have removed the account record but not all its
        // versions. Its name comes from the email alone, so offer just that.
        let leftover = false;
        try {
            for await (const item of container.listBlobsFlat({ prefix: accountName, includeVersions: true, abortSignal: signal }))
                if (item.name === accountName) { leftover = true; break; }
        } catch (_) { fail('account_wipe_storage_unavailable'); }
        return leftover ? Object.freeze({ account: null, subjectKey: null, tenantIds: Object.freeze([]), exact: Object.freeze([]),
            session: Object.freeze([]), prefixes: Object.freeze([]), accountRecord: accountName }) : null;
    }
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
    const exact = [], session = [], prefixes = [`customer-starter/starter-clients/${uuid(account.accountId)}/`, `customer-starter/starter-client-bindings/${account.accountId}/`];
    if (subjectKey) {
        exact.push(`customer-subjects/${subjectHash(subjectKey)}.json`, `customer-signup-recoveries/${subjectHash(subjectKey)}.json`);
        const authority = await readJson(container, `customer-subjects/${subjectHash(subjectKey)}.json`, signal);
        if (authority && typeof authority.invitationDigest === 'string' && /^[a-f0-9]{64}$/.test(authority.invitationDigest))
            // Same key as customerAuthority's proofKey; the proof lives in the session container.
            session.push(`customer-email-proofs/${sha256(`${subjectKey}\0${authority.invitationDigest}`)}.json`);
    }
    for (const slot of slots) {
        exact.push(`customer-starter/starter-setups/${uuid(slot.organisationId)}.json`, `customer-activations/${uuid(slot.activationId)}.json`,
            termsOfferKey(slot.tenantId, slot.organisationId));
    }
    // The legacy signup index (NOFRIES_DASHBOARD_ADMIN_BINDING) is not touched:
    // removing only its writer ticket would leave a stale reference. Delete is
    // refused while that listing is configured (see docs/staff-admin.md).
    return Object.freeze({ account, subjectKey, tenantIds: Object.freeze([...new Set(slots.map(slot => slot.tenantId))]),
        exact: Object.freeze([...new Set(exact)]), session: Object.freeze(session), prefixes: Object.freeze(prefixes), accountRecord: accountName });
}

// Delete one name and, where kept, its versions. With versioning on, deleting
// the base blob turns its current version into a previous one, so versions are
// listed after the base delete. A version the identity may not delete is
// counted as remaining rather than failing the whole delete.
async function removeName(container, name, signal, counts) {
    try {
        const result = await container.getBlobClient(name).deleteIfExists({ deleteSnapshots: 'include', abortSignal: signal });
        if (result.succeeded) counts.blobs += 1;
    } catch (_) { fail('account_wipe_storage_unavailable'); }
    try {
        for await (const item of container.listBlobsFlat({ prefix: name, includeVersions: true, abortSignal: signal })) {
            if (item.name !== name || !item.versionId) continue;
            try { await container.getBlobClient(name).withVersion(item.versionId).delete({ abortSignal: signal }); counts.versions += 1; }
            catch (error) { if (error?.statusCode !== 404) counts.versionsRemaining += 1; }
        }
    } catch (_) {
        // Versions could not be listed, so whether any remain is unknown.
        counts.versionsUnverified += 1;
    }
}

const usable = value => value && typeof value.getBlobClient === 'function' && typeof value.listBlobsFlat === 'function';
function createAccountWipeStorage(container, sessionContainer) {
    if (!usable(container) || !usable(sessionContainer)) fail('account_wipe_configuration_invalid');
    return Object.freeze({
        inventory: (email, signal) => inventory(container, email, signal),
        async delete(found, signal) {
            const counts = { blobs: 0, versions: 0, versionsRemaining: 0, versionsUnverified: 0 };
            // Each stage must be confirmed complete, versions included, before the
            // records a retry needs to rediscover it are removed:
            //   1. the email proof (its name comes from the sign-in authority record);
            //   2. the authority and per-organisation records (their names come from
            //      the account and client records);
            //   3. client records and bindings (found from the account record);
            //   4. the account record (its name comes from the email alone).
            const complete = () => { if (counts.versionsRemaining || counts.versionsUnverified) fail('account_wipe_storage_incomplete'); };
            for (const name of found.session) { signal.throwIfAborted(); await removeName(sessionContainer, name, signal, counts); }
            complete();
            for (const name of found.exact) { signal.throwIfAborted(); await removeName(container, name, signal, counts); }
            complete();
            for (const prefix of found.prefixes) {
                // Include names that only have previous versions left (from an earlier
                // partial attempt), so a retry still removes them.
                const names = new Set();
                try { for await (const item of container.listBlobsFlat({ prefix, includeVersions: true, abortSignal: signal })) names.add(item.name); }
                catch (_) { fail('account_wipe_storage_unavailable'); }
                for (const name of names) { signal.throwIfAborted(); await removeName(container, name, signal, counts); }
            }
            complete();
            await removeName(container, found.accountRecord, signal, counts);
            complete();
            return Object.freeze(counts);
        }
    });
}

module.exports = { createAccountWipeStorage };
