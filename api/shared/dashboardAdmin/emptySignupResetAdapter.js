'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { fields, copy, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { starterAccountRecord, starterAccountKey } = require('../customerSignup/starterAccountAllocation');
const { subjectHash } = require('../customerSignup/customerAuthority');
const { createEmptySignupReset } = require('../customerSignup/emptySignupReset');
const { createAzureEmptySignupResetBinding } = require('../customerSignup/azureEmptySignupResetBinding');
const { DashboardAdminError } = require('./service');
const fail = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function readVersioned(container, key, maximum) {
    let response;
    try {
        response = await container.getBlockBlobClient(key).download(0, maximum + 1, { abortSignal: AbortSignal.timeout(4000) });
        if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > maximum ||
            typeof response.etag !== 'string' || typeof response.versionId !== 'string' || !response.versionId) fail();
        const chunks = []; let bytes = 0;
        for await (const part of response.readableStreamBody) { bytes += part.length; if (bytes > maximum) fail(); chunks.push(part); }
        if (bytes !== response.contentLength) fail();
        const body = Buffer.concat(chunks);
        return { record: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
            etag: response.etag, versionId: response.versionId, sha256: sha(body) };
    } catch (error) {
        if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null;
        fail();
    } finally { response?.readableStreamBody?.destroy(); }
}
// Only External ID accounts without ANY canonical account, organisation,
// registration or acceptance can use this port. Retained setup/claim/legal
// evidence is preserved. SQL, directory identities and trial limits are untouched.
function createEmptySignupResetAdapter({ container, index, writerFence, containerSha256, sourceSha, providerKey,
    readAdoption, inspectDependencies, audit, clock }) {
    async function inventory(request) {
        await readAdoption();
        const keys = { account: 'customer-starter/' + starterAccountKey(request.email) + '.json',
            authority: 'customer-subjects/' + subjectHash(request.customerSubjectKey) + '.json' };
        const account = await readVersioned(container, keys.account, 32768);
        if (!account) fail();
        const value = starterAccountRecord(account.record), slot = value.organisations[0];
        if (value.activation !== null || value.organisations.length !== 1 || slot.kind !== 'own' ||
            value.identitySubjectKey !== request.customerSubjectKey || value.email !== request.email) fail();
        const authority = await readVersioned(container, keys.authority, 16384);
        const dependencies = await inspectDependencies(value);
        if (dependencies?.empty !== true) fail();
        return { status: 'ready', target: { keys, account, authority, containerSha256, dependencyDigest: hash(dependencies) } };
    }
    const binding = createAzureEmptySignupResetBinding({ accountContainer: container, authorityContainer: container });
    function coordinator(check) {
        return createEmptySignupReset({ inspect: inventory, blobs: binding.blobs, now: () => Date.parse(clock()),
            withExclusiveTarget: (input, work) => binding.withExclusiveTarget(input, fence => work({
                async assertCurrent() { await check(); await fence.assertCurrent(); await check(); },
                retain: () => fence.retain(), complete: () => fence.complete()
            })) });
    }
    async function inspect(selector, context) {
        if (selector.provider !== 'external') return null;
        await context.check(); await readAdoption();
        const current = await index.readCurrentIndex(), references = current.sourceReferences.filter(ref =>
            ['provider', 'tenantId', 'organisationId', 'subjectKey'].every(key => ref.entry.binding[key] === selector[key]));
        if (references.length === 0) return null;
        if (references.length !== 1) fail();
        const account = await readVersioned(container, 'customer-starter/' + references[0].accountKey + '.json', 32768);
        if (!account) fail();
        const record = starterAccountRecord(account.record), slot = record.organisations[0];
        if (record.accountId !== references[0].entry.binding.accountId || record.activation !== null ||
            record.identitySubjectKey !== selector.subjectKey || slot.tenantId !== selector.tenantId || slot.organisationId !== selector.organisationId) return null;
        if ((await inspectDependencies(record))?.empty !== true) return null;
        const at = clock(), request = { schemaVersion: 1, operationId: randomUUID(), sourceSha, email: record.email,
            customerSubjectKey: selector.subjectKey, staffSubjectKey: context.actorSubjectKey, providerKey,
            createdAt: Date.parse(at), expiresAt: Date.parse(at) + 300000 };
        const observed = await coordinator(context.check).inventory(request);
        if (observed.status !== 'ready') fail();
        const witness = { kind: 'empty_signup_reset', authoritySha256: context.authoritySha256, restoreEpoch: context.restoreEpoch,
            request, plan: observed.plan };
        const version = hash({ selector, displayName: slot.organisationName, plan: observed.plan });
        await context.check();
        await audit.write('inspection', request.operationId, { actorSubjectKey: context.actorSubjectKey,
            targetSha256: hash(selector), operationId: request.operationId, occurredAt: at, version });
        await context.check();
        return { selector, version, displayName: slot.organisationName, displayLabel: null, membership: null,
            signup: { state: 'half_created', accountId: record.accountId, hasAuthority: observed.plan.records.authority !== null },
            actions: ['reset'], witness };
    }
    async function outcome(command) {
        let saved = await audit.read('completed', command.operationId);
        if (saved === null) {
            const running = await writerFence.readReset();
            saved = await audit.read('completed', command.operationId);
            if (saved === null) {
                const requested = await audit.read('requested', command.operationId);
                if (requested?.commandSha256 === command.commandSha256 || running?.operationId === command.operationId) {
                    return { operationId: command.operationId, commandSha256: command.commandSha256, status: 'pending',
                        version: command.expectedVersion, occurredAt: command.preparedAt };
                }
                return null;
            }
        }
        if (saved.commandSha256 !== command.commandSha256 || saved.actorSubjectKey !== command.actorSubjectKey ||
            saved.targetSha256 !== hash(command.selector)) fail();
        return saved.receipt;
    }
    async function commit(command, context) {
        const previous = await outcome(command); if (previous) return previous;
        const w = fields(copy(command.witness), ['kind', 'authoritySha256', 'restoreEpoch', 'request', 'plan']);
        if (w.kind !== 'empty_signup_reset' || command.action !== 'reset' || w.request.staffSubjectKey !== command.actorSubjectKey ||
            w.request.customerSubjectKey !== command.selector.subjectKey || w.request.sourceSha !== sourceSha || w.request.providerKey !== providerKey) fail();
        await context.check(); await readAdoption();
        return writerFence.withReset({ operationId: command.operationId, planSha256: hash(w.plan) }, async fence => {
            const check = async () => { await fence.check(); await context.check(); await readAdoption(); };
            await check();
            const fresh = await inventory(w.request);
            const account = starterAccountRecord(fresh.target.account.record), slot = account.organisations[0];
            if (slot.tenantId !== command.selector.tenantId || slot.organisationId !== command.selector.organisationId ||
                hash({ selector: command.selector, displayName: slot.organisationName, plan: w.plan }) !== command.expectedVersion) fail();
            await audit.write('requested', command.operationId, { actorSubjectKey: command.actorSubjectKey, targetSha256: hash(command.selector),
                operationId: command.operationId, commandSha256: command.commandSha256, occurredAt: clock(), version: command.expectedVersion });
            await check();
            const reset = coordinator(check);
            const result = await index.resetAccount({ key: starterAccountKey(w.request.email), version: w.plan.records.account.etag,
                planSha256: hash(w.plan), mutate: () => reset.reset(w.request, w.plan) });
            if (result.status !== 'reset') fail();
            await check();
            const receipt = { operationId: command.operationId, commandSha256: command.commandSha256, status: 'succeeded',
                version: hash({ commandSha256: command.commandSha256, result }), occurredAt: clock() };
            await audit.write('completed', command.operationId, { actorSubjectKey: command.actorSubjectKey, targetSha256: hash(command.selector),
                operationId: command.operationId, commandSha256: command.commandSha256, receipt });
            await fence.complete();
            return receipt;
        });
    }
    return Object.freeze({ inspect, commit, outcome });
}
module.exports = { createEmptySignupResetAdapter, readVersioned };
