'use strict';

// Staff account reset and delete, one account at a time. Each run needs an
// approval: the staff admin types the account email and RESET or DELETE; the
// approval is held here (server-side), bound to that staff subject and session
// for 15 minutes, and used once.
//
// Reset clears the account's assessments, evidence and improvement plans in
// the database and keeps its sign-in, email and organisations. The storage
// records hold no assessment, evidence or plan data, so reset is database only.
// Delete removes the database rows, then the Blob records, then the External
// ID user. A stage that fails after an earlier stage has run is reported as a
// 'partial' outcome naming that stage; approving and applying again repeats
// the run, and every stage treats what is already gone as done.
//
// Audit records hold digests, stage names and counts only: never the email,
// the subject key or any record content.
const { randomUUID, createHash } = require('node:crypto');

const APPROVAL_MS = 15 * 60 * 1000;
const MAX_APPROVALS = 32;
// Kept so the External ID user can still be removed after the Blob records
// that name it are gone (process memory only; see docs/staff-admin.md).
const PENDING_IDENTITY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_IDENTITIES = 256;
const WORDS = Object.freeze({ reset: 'RESET', delete: 'DELETE' });
const KINDS = new Set(['legacy_starter', 'external_starter']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const wipeCode = error => typeof error?.code === 'string' && /^account_wipe_[a-z_]+$/.test(error.code) ? error.code : 'account_wipe_unavailable';

function normaliseEmail(value) {
    if (typeof value !== 'string') fail('account_wipe_input_invalid');
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) fail('account_wipe_input_invalid');
    return email;
}
const digestShape = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function createAccountWipeExecutor({ sources, repository, identity = null, ensureRole, legacyIndexConfigured, audit, targetDigest,
    now = Date.now, newId = randomUUID }) {
    if (!Array.isArray(sources) || !sources.length || sources.length > 2 || new Set(sources.map(source => source?.kind)).size !== sources.length ||
        sources.some(source => !KINDS.has(source?.kind) || typeof source.storage?.inventory !== 'function' || typeof source.storage?.delete !== 'function') ||
        typeof repository?.reset !== 'function' || typeof repository?.delete !== 'function' ||
        identity !== null && typeof identity?.remove !== 'function' || typeof legacyIndexConfigured !== 'boolean' ||
        [ensureRole, audit, targetDigest, now, newId].some(value => typeof value !== 'function')) fail('account_wipe_configuration_invalid');
    const approvals = new Map(), pendingIdentities = new Map(), running = new Set();

    function prune() {
        const at = now();
        for (const [key, value] of approvals) if (value.expiresAt <= at) approvals.delete(key);
        for (const [key, value] of pendingIdentities) if (value.until <= at) pendingIdentities.delete(key);
    }
    function digestOf(email) {
        const digest = targetDigest(email);
        if (!digestShape(digest)) fail('account_wipe_configuration_invalid');
        return digest;
    }
    function actorOf(actor, sessionSha256) {
        if (typeof actor?.subjectKey !== 'string' || !actor.subjectKey || !digestShape(sessionSha256)) fail('account_wipe_approval_invalid');
        return sha256(actor.subjectKey);
    }
    // Refusals that need no customer data, checked before anything is read.
    async function preconditions(action) {
        if (action === 'delete') {
            // The legacy signup listing publishes an index that is not
            // deletion-aware; a delete would leave a stale entry in it.
            if (legacyIndexConfigured) fail('account_wipe_legacy_index_configured');
            // Delete must be able to finish: without Graph it refuses up front.
            if (!identity) fail('account_wipe_identity_not_configured');
        }
        try { await ensureRole(); } catch (_) { fail('account_wipe_role_unavailable'); }
    }
    async function locate(email, signal) {
        const found = [];
        for (const source of sources) {
            signal.throwIfAborted();
            const inventory = await source.storage.inventory(email, signal);
            if (inventory) found.push({ kind: source.kind, storage: source.storage, inventory });
        }
        // An email in both starter stores is never guessed between.
        if (found.length > 1) fail('account_wipe_account_ambiguous');
        return found[0] || null;
    }
    const scope = inventory => ({ accountId: inventory.account.accountId, subjectKey: inventory.subjectKey, tenantIds: [...inventory.tenantIds] });
    async function record(operationId, phase, fields) {
        try { await audit(Object.freeze({ schemaVersion: 1, category: 'dashboard_admin_account_wipe', operationId, phase, ...fields, occurredAt: new Date(now()).toISOString() })); }
        catch (_) { return false; }
        return true;
    }

    async function approve({ actor, sessionSha256, action, email, confirmEmail, confirmWord }, signal) {
        if (!Object.hasOwn(WORDS, action ?? '')) fail('account_wipe_input_invalid');
        const actorSha256 = actorOf(actor, sessionSha256), target = normaliseEmail(email);
        let typed;
        try { typed = normaliseEmail(confirmEmail); } catch (_) { fail('account_wipe_confirmation_mismatch'); }
        if (typed !== target || confirmWord !== WORDS[action]) fail('account_wipe_confirmation_mismatch');
        await preconditions(action);
        const targetSha256 = digestOf(target), located = await locate(target, signal);
        prune();
        const inventory = located?.inventory ?? null;
        if (action === 'reset' && !inventory?.account || action === 'delete' && !inventory && !pendingIdentities.has(targetSha256)) fail('account_wipe_account_not_found');
        if (inventory?.account && !inventory.subjectKey) fail('account_wipe_subject_unknown');
        if (approvals.size >= MAX_APPROVALS) fail('account_wipe_busy');
        const approvalId = newId(), expiresAt = now() + APPROVAL_MS;
        if (!await record(approvalId, 'approval', { action, actorSha256, targetSha256, outcome: 'approved', expiresAt: new Date(expiresAt).toISOString() }))
            fail('account_wipe_audit_unavailable');
        approvals.set(approvalId, Object.freeze({ actorSubjectKey: actor.subjectKey, sessionSha256, action, targetSha256, expiresAt }));
        return Object.freeze({ approvalId, action, approvalExpiresAt: new Date(expiresAt).toISOString(),
            organisations: inventory?.tenantIds.length ?? 0, store: located ? (located.kind === 'external_starter' ? 'external' : 'legacy') : null });
    }

    async function execute({ actor, sessionSha256, approvalId, email }, signal) {
        const actorSha256 = actorOf(actor, sessionSha256), target = normaliseEmail(email), targetSha256 = digestOf(target);
        prune();
        // Single use: taken out before any check, so it can never be replayed.
        const approval = typeof approvalId === 'string' ? approvals.get(approvalId) : undefined;
        if (approval) approvals.delete(approvalId);
        if (!approval || approval.expiresAt <= now() || approval.actorSubjectKey !== actor.subjectKey ||
            approval.sessionSha256 !== sessionSha256 || approval.targetSha256 !== targetSha256) fail('account_wipe_approval_invalid');
        if (running.has(targetSha256)) fail('account_wipe_busy');
        running.add(targetSha256);
        try { return await run(approval.action, approvalId, actorSha256, target, targetSha256, signal); }
        finally { running.delete(targetSha256); }
    }

    async function run(action, operationId, actorSha256, email, targetSha256, signal) {
        const base = { action, actorSha256, targetSha256 };
        if (!await record(operationId, 'attempt', { ...base, outcome: 'attempt' })) fail('account_wipe_audit_unavailable');
        const stages = action === 'reset' ? { database: 'pending' } : { database: 'pending', storage: 'pending', identity: 'pending' };
        const counts = { databaseRows: 0, blobs: 0, versions: 0 };
        let stage = 'checks', outcome = 'succeeded', failedStage = null, code = null;
        try {
            await preconditions(action);
            const located = await locate(email, signal), inventory = located?.inventory ?? null;
            if (inventory?.account && !inventory.subjectKey) fail('account_wipe_subject_unknown');
            if (action === 'reset') {
                if (!inventory?.account) fail('account_wipe_account_not_found');
                stage = 'database';
                const result = await repository.reset(scope(inventory));
                counts.databaseRows = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
                stages.database = 'done';
            } else {
                prune();
                const held = pendingIdentities.get(targetSha256) ?? null;
                if (!inventory && !held) fail('account_wipe_account_not_found');
                const subjectKey = inventory?.subjectKey ?? held?.subjectKey ?? null;
                const external = located ? located.kind === 'external_starter' : held.external;
                stage = 'database';
                if (inventory?.account) {
                    try {
                        const result = await repository.delete(scope(inventory));
                        counts.databaseRows = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
                        stages.database = 'done';
                    } catch (error) {
                        // Already removed by an earlier attempt, or never activated.
                        if (error?.code !== 'account_wipe_account_not_found') throw error;
                        stages.database = 'absent';
                    }
                } else stages.database = 'absent';
                stage = 'storage';
                if (external && subjectKey) {
                    if (pendingIdentities.size >= MAX_PENDING_IDENTITIES) pendingIdentities.delete(pendingIdentities.keys().next().value);
                    pendingIdentities.set(targetSha256, Object.freeze({ subjectKey, external, until: now() + PENDING_IDENTITY_MS }));
                }
                if (inventory) {
                    signal.throwIfAborted();
                    const removed = await located.storage.delete(inventory, signal);
                    counts.blobs = removed.blobs; counts.versions = removed.versions;
                    stages.storage = 'done';
                } else stages.storage = 'absent';
                stage = 'identity';
                if (!external) stages.identity = 'not_applicable';
                else {
                    // The Blob records naming the user are gone and this process no
                    // longer holds its reference: staff must remove it by hand.
                    if (!subjectKey) fail('account_wipe_identity_reference_lost');
                    const removed = await identity.remove(subjectKey);
                    stages.identity = removed.alreadyGone ? 'absent' : 'done';
                    pendingIdentities.delete(targetSha256);
                }
            }
        } catch (error) {
            code = wipeCode(error);
            // Checks and the single database transaction change nothing when they fail.
            if (['checks', 'database'].includes(stage)) { outcome = 'refused'; if (stage === 'database') stages.database = 'failed'; }
            else { outcome = 'partial'; failedStage = stage; stages[stage] = 'failed'; }
        }
        const recorded = await record(operationId, 'outcome', { ...base, outcome, stages, failedStage, code, counts });
        return Object.freeze({ operationId, action, outcome, stages: Object.freeze(stages), failedStage, code, counts: Object.freeze(counts), recorded });
    }

    return Object.freeze({ approve, execute });
}

module.exports = { createAccountWipeExecutor, APPROVAL_MS, WORDS };
