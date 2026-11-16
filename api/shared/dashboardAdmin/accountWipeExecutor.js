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
// A retry reference, taken before the first delete: the sign-in subject (so the
// External ID user can still be removed after the Blob records naming it are
// gone) and whether the database part is done (so an unactivated account whose
// subject was only in a now-deleted organisation context can still be
// finished). Process memory; the database-done fact is also kept durably,
// digest-only, through the optional retryMarkers port.
const PENDING_IDENTITY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_IDENTITIES = 256;
const WORDS = Object.freeze({ reset: 'RESET', delete: 'DELETE' });
const KINDS = new Set(['legacy_starter', 'external_starter']);
// The store a staff admin picked from the account list, when an email is in both.
const STORES = Object.freeze({ legacy: 'legacy_starter', external: 'external_starter' });
// Of the overall run deadline, this much is kept for the outcome record, so
// the whole apply (attempt record, stages, outcome record) ends by the deadline.
const OUTCOME_RESERVE_MS = 3000;
// Every audit write is bounded: a stalled audit store can never hold a run
// (or its per-account lock) open. The outcome write gets at least
// OUTCOME_MIN_MS even when the deadline has passed.
const AUDIT_TIMEOUT_MS = 3000, OUTCOME_MIN_MS = 1500;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const wipeCode = error => typeof error?.code === 'string' && /^account_wipe_[a-z_]+$/.test(error.code) ? error.code : 'account_wipe_unavailable';

function normaliseEmail(value) {
    if (typeof value !== 'string') fail('account_wipe_input_invalid');
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) fail('account_wipe_input_invalid');
    return email;
}
// Settles with the work, or rejects as soon as the signal aborts (the run
// signal carries the deadline), so no await on the apply path outlives it.
function bounded(work, signal) {
    if (!signal) return Promise.resolve().then(work);
    signal.throwIfAborted();
    let stop;
    return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        stop = () => reject(Object.assign(new Error('account_wipe_timed_out'), { code: 'account_wipe_timed_out' }));
        signal.addEventListener('abort', stop, { once: true });
    })]).finally(() => signal.removeEventListener('abort', stop));
}
const digestShape = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function createAccountWipeExecutor({ sources, repository, identity = null, ensureRole, legacyIndexConfigured, audit, targetDigest,
    retryMarkers = null, now = Date.now, newId = randomUUID, log = message => console.warn(message), auditTimeoutMs = AUDIT_TIMEOUT_MS }) {
    if (!Array.isArray(sources) || !sources.length || sources.length > 2 || new Set(sources.map(source => source?.kind)).size !== sources.length ||
        sources.some(source => !KINDS.has(source?.kind) || typeof source.storage?.inventory !== 'function' || typeof source.storage?.delete !== 'function') ||
        typeof repository?.reset !== 'function' || typeof repository?.delete !== 'function' ||
        identity !== null && (typeof identity?.remove !== 'function' || typeof identity?.check !== 'function') || typeof legacyIndexConfigured !== 'boolean' ||
        [ensureRole, audit, targetDigest, now, newId, log].some(value => typeof value !== 'function') ||
        retryMarkers !== null && (typeof retryMarkers?.read !== 'function' || typeof retryMarkers?.write !== 'function')) fail('account_wipe_configuration_invalid');
    const approvals = new Map(), pendingIdentities = new Map(), running = new Set();
    // Deleting unfinished signups needs the read-only database probe.
    const unfinishedDeletable = typeof repository.probe === 'function';

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
    async function preconditions(action, signal, deadline) {
        if (action === 'delete') {
            // The legacy signup listing publishes an index that is not
            // deletion-aware; a delete would leave a stale entry in it.
            if (legacyIndexConfigured) fail('account_wipe_legacy_index_configured');
            // Delete must be able to finish: without Graph it refuses up front.
            if (!identity) fail('account_wipe_identity_not_configured');
        }
        try { await bounded(() => ensureRole({ signal, deadline }), signal); }
        catch (error) { if (error?.code === 'account_wipe_timed_out') throw error; fail('account_wipe_role_unavailable'); }
        // A broken Graph credential is found here, not after the database and
        // Blob records are gone: a valid External ID token is required first.
        if (action === 'delete') await identity.check({ signal });
    }
    async function locate(email, signal, kind = null) {
        const found = [];
        for (const source of sources) {
            if (kind && source.kind !== kind) continue;
            signal.throwIfAborted();
            const inventory = await bounded(() => source.storage.inventory(email, signal), signal);
            if (inventory) found.push({ kind: source.kind, storage: source.storage, inventory });
        }
        // An email in both starter stores is never guessed between: the store
        // must be named.
        if (found.length > 1) fail('account_wipe_account_ambiguous');
        return found[0] || null;
    }
    // Whether an earlier attempt finished the database part for this account.
    // The durable marker holds digests only and is trusted only for the same account.
    async function databaseDone(targetSha256, accountId, signal) { return (await finished(targetSha256, accountId, signal)).done; }
    // The durable marker also says whether the account was an unfinished signup
    // (no sign-in subject ever recorded), so a retry after a restart still knows
    // there is no External ID user to remove.
    async function finished(targetSha256, accountId, signal) {
        const held = refs(targetSha256).find(ref => ref.databaseDone && ref.accountId === accountId);
        if (held) return { done: true, unfinished: held.unfinished === true };
        if (!retryMarkers) return { done: false, unfinished: false };
        try {
            const marker = await bounded(() => retryMarkers.read(targetSha256), signal);
            const done = marker?.databaseDone === true && marker.targetSha256 === targetSha256 && marker.accountSha256 === sha256(accountId);
            return { done, unfinished: done && marker.unfinished === true };
        } catch (_) { return { done: false, unfinished: false }; }
    }
    // A retry reference belongs to the store it was taken in: a delete aimed at
    // the other store never uses it.
    // References are kept per email and store, so finishing one store's delete
    // never replaces or clears the other store's.
    const refKey = (targetSha256, kind) => targetSha256 + '|' + kind;
    const refs = targetSha256 => [...pendingIdentities.values()].filter(ref => ref.targetSha256 === targetSha256);
    function heldIn(targetSha256, kind) {
        if (kind) return pendingIdentities.get(refKey(targetSha256, kind)) ?? null;
        const found = refs(targetSha256);
        // Partial deletes pending in both stores: the store must be named.
        if (found.length > 1) fail('account_wipe_account_ambiguous');
        return found[0] ?? null;
    }
    function hold(targetSha256, reference) {
        const key = refKey(targetSha256, reference.kind);
        if (!pendingIdentities.has(key) && pendingIdentities.size >= MAX_PENDING_IDENTITIES) pendingIdentities.delete(pendingIdentities.keys().next().value);
        pendingIdentities.set(key, Object.freeze({ ...reference, targetSha256, until: now() + PENDING_IDENTITY_MS }));
    }
    const forget = (targetSha256, kind) => pendingIdentities.delete(refKey(targetSha256, kind));
    // The account found now must be the one approved. With no account record
    // left (a partial delete being finished), the kept reference or the durable
    // marker must name the approved account.
    async function sameTarget(approval, located, targetSha256, signal) {
        const inventory = located?.inventory ?? null, accountId = inventory?.account?.accountId ?? null;
        const changed = () => fail('account_wipe_target_changed');
        if (accountId) {
            if (accountId !== approval.accountId || located.kind !== approval.kind) changed();
            if (inventory.subjectKey && approval.subjectSha256 && sha256(inventory.subjectKey) !== approval.subjectSha256) changed();
            return;
        }
        if (!approval.accountId) return;
        const held = heldIn(targetSha256, approval.storeKind ?? approval.kind ?? null);
        if (held?.accountId === approval.accountId) return;
        if (!await databaseDone(targetSha256, approval.accountId, signal)) changed();
    }
    const scope = inventory => ({ accountId: inventory.account.accountId, subjectKey: inventory.subjectKey, tenantIds: [...inventory.tenantIds] });
    async function record(operationId, phase, fields, timeoutMs = auditTimeoutMs) {
        const event = Object.freeze({ schemaVersion: 1, category: 'dashboard_admin_account_wipe', operationId, phase, ...fields, occurredAt: new Date(now()).toISOString() });
        const controller = new AbortController();
        let timer;
        try {
            await Promise.race([Promise.resolve().then(() => audit(event, controller.signal)),
                new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('audit_timeout')); }, Math.max(1, timeoutMs)); })]);
        } catch (_) { return false; }
        finally { clearTimeout(timer); }
        return true;
    }

    // Every refused approve or apply leaves a create-only record: actor digest,
    // keyed email digest (when the email is usable) and the code. Never the email.
    async function refusal(step, actor, email, error) {
        const code = wipeCode(error);
        let targetSha256 = null;
        try { targetSha256 = digestOf(normaliseEmail(email)); } catch (_) { /* unusable email: no target */ }
        await record(newId(), step === 'approve' ? 'approval_refused' : 'execute_refused',
            { actorSha256: typeof actor?.subjectKey === 'string' && actor.subjectKey ? sha256(actor.subjectKey) : null, targetSha256, outcome: 'refused', code });
    }
    function audited(step, work) {
        return async (input, signal) => {
            try { return await work(input, signal); }
            catch (error) { await refusal(step, input?.actor, input?.email, error); throw error; }
        };
    }

    async function approve({ actor, sessionSha256, action, email, confirmEmail, confirmWord, store = null }, signal) {
        if (!Object.hasOwn(WORDS, action ?? '')) fail('account_wipe_input_invalid');
        if (store !== null && !Object.hasOwn(STORES, store)) fail('account_wipe_input_invalid');
        const storeKind = store === null ? null : STORES[store];
        const actorSha256 = actorOf(actor, sessionSha256), target = normaliseEmail(email);
        let typed;
        try { typed = normaliseEmail(confirmEmail); } catch (_) { fail('account_wipe_confirmation_mismatch'); }
        if (typed !== target || confirmWord !== WORDS[action]) fail('account_wipe_confirmation_mismatch');
        await preconditions(action, signal);
        const targetSha256 = digestOf(target), located = await locate(target, signal, storeKind);
        prune();
        const inventory = located?.inventory ?? null;
        if (action === 'reset' && !inventory?.account || action === 'delete' && !inventory && !heldIn(targetSha256, storeKind)) fail('account_wipe_account_not_found');
        if (inventory?.account && !inventory.subjectKey) {
            const held = heldIn(targetSha256, located.kind);
            const resumable = action === 'delete' && (held?.accountId === inventory.account.accountId && held.subjectKey ||
                await databaseDone(targetSha256, inventory.account.accountId, signal));
            // A signup that never finished has no sign-in subject. Delete may still
            // remove it, but only if the database holds nothing of it (checked
            // again when applied); reset needs the subject.
            if (!resumable && !(action === 'delete' && unfinishedDeletable)) fail('account_wipe_subject_unknown');
        }
        if (approvals.size >= MAX_APPROVALS) fail('account_wipe_busy');
        const approvalId = newId(), expiresAt = now() + APPROVAL_MS;
        if (!await record(approvalId, 'approval', { action, actorSha256, targetSha256, outcome: 'approved', expiresAt: new Date(expiresAt).toISOString() }))
            fail('account_wipe_audit_unavailable');
        // Bound to the account seen now, not just the email: an account deleted and
        // signed up again with the same email is a different target.
        approvals.set(approvalId, Object.freeze({ actorSubjectKey: actor.subjectKey, sessionSha256, action, targetSha256, expiresAt,
            accountId: inventory?.account?.accountId ?? null, kind: located?.kind ?? null, storeKind,
            subjectSha256: inventory?.subjectKey ? sha256(inventory.subjectKey) : null }));
        return Object.freeze({ approvalId, action, approvalExpiresAt: new Date(expiresAt).toISOString(),
            organisations: inventory?.tenantIds.length ?? 0, store: located ? (located.kind === 'external_starter' ? 'external' : 'legacy') : null });
    }

    // deadline (epoch ms, optional) bounds the whole apply: the stages get it
    // less OUTCOME_RESERVE_MS (the database transaction enforces it from inside;
    // past it the transaction rolls back and the outcome is
    // 'timed_out_rolled_back'), and the outcome record uses the rest.
    async function execute({ actor, sessionSha256, approvalId, email, deadline }, signal) {
        if (deadline !== undefined && !Number.isFinite(deadline)) fail('account_wipe_input_invalid');
        const actorSha256 = actorOf(actor, sessionSha256), target = normaliseEmail(email), targetSha256 = digestOf(target);
        prune();
        // Single use: taken out before any check, so it can never be replayed.
        const approval = typeof approvalId === 'string' ? approvals.get(approvalId) : undefined;
        if (approval) approvals.delete(approvalId);
        if (!approval || approval.expiresAt <= now() || approval.actorSubjectKey !== actor.subjectKey ||
            approval.sessionSha256 !== sessionSha256 || approval.targetSha256 !== targetSha256) fail('account_wipe_approval_invalid');
        if (running.has(targetSha256)) fail('account_wipe_busy');
        running.add(targetSha256);
        let bound;
        if (deadline !== undefined) {
            const stageDeadline = deadline - OUTCOME_RESERVE_MS;
            bound = { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, stageDeadline - now()))]), deadline: stageDeadline };
        }
        try {
            const result = await run(approval.action, approvalId, actorSha256, target, targetSha256, bound?.signal ?? signal, bound, deadline, approval);
            // Once anything may have changed, every other approval for this email is void.
            if (['succeeded', 'partial', 'unknown'].includes(result.outcome))
                for (const [key, value] of approvals) if (value.targetSha256 === targetSha256) approvals.delete(key);
            return result;
        } finally { running.delete(targetSha256); }
    }

    async function run(action, operationId, actorSha256, email, targetSha256, signal, bound, deadline, approval) {
        const base = { action, actorSha256, targetSha256 };
        const left = () => deadline === undefined ? auditTimeoutMs : deadline - now();
        // With a deadline the attempt record must leave the outcome reserve; without one it gets the full timeout.
        if (!await record(operationId, 'attempt', { ...base, outcome: 'attempt' },
            deadline === undefined ? auditTimeoutMs : Math.min(auditTimeoutMs, left() - OUTCOME_RESERVE_MS)))
            fail('account_wipe_audit_unavailable');
        const stages = action === 'reset' ? { database: 'pending' } : { database: 'pending', storage: 'pending', identity: 'pending' };
        const counts = { databaseRows: 0, blobs: 0, versions: 0 };
        let stage = 'checks', outcome = 'succeeded', failedStage = null, code = null, heldBefore = null, refKind = null;
        try {
            await preconditions(action, signal, bound?.deadline);
            const located = await locate(email, signal, approval.storeKind ?? null), inventory = located?.inventory ?? null;
            await sameTarget(approval, located, targetSha256, signal);
            if (action === 'reset') {
                if (!inventory?.account) fail('account_wipe_account_not_found');
                if (!inventory.subjectKey) fail('account_wipe_subject_unknown');
                stage = 'database';
                const result = await repository.reset(scope(inventory), bound);
                counts.databaseRows = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
                stages.database = 'done';
            } else {
                prune();
                const held = heldIn(targetSha256, located?.kind ?? approval.storeKind ?? null);
                refKind = located?.kind ?? held?.kind ?? null;
                heldBefore = refKind ? pendingIdentities.get(refKey(targetSha256, refKind)) ?? null : null;
                // An earlier attempt deleted the user but could not yet remove it
                // permanently: only a confirmed permanent delete clears that.
                const identityPending = held?.identityPending === true;
                if (!inventory && !held) fail('account_wipe_account_not_found');
                const accountId = inventory?.account?.accountId ?? null;
                const subjectKey = inventory?.subjectKey ?? (held && (!accountId || held.accountId === accountId) ? held.subjectKey : null);
                const external = located ? located.kind === 'external_starter' : held.external;
                const before = accountId ? await finished(targetSha256, accountId, signal) : { done: true, unfinished: false };
                const finishedBefore = before.done;
                // An unfinished signup (no subject): its database part is absent only
                // when the database holds nothing of it; otherwise it needs a person.
                let unfinished = before.unfinished;
                if (accountId && !subjectKey && !finishedBefore) {
                    if (!unfinishedDeletable || !inventory.tenantIds.length) fail('account_wipe_subject_unknown');
                    const probe = await repository.probe({ accountId, subjectKey: null, tenantIds: [...inventory.tenantIds] }, bound);
                    if (probe.held !== false) fail('account_wipe_subject_unknown');
                    unfinished = true;
                }
                // The retry reference is taken before anything is deleted.
                const kind = refKind;
                hold(targetSha256, { subjectKey, external, kind, accountId: accountId ?? held?.accountId ?? null, databaseDone: finishedBefore || unfinished, identityPending,
                    unfinished: unfinished || held?.unfinished === true });
                stage = 'database';
                if (accountId && subjectKey) {
                    try {
                        const result = await repository.delete({ ...scope(inventory), subjectKey }, bound);
                        counts.databaseRows = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
                        stages.database = 'done';
                    } catch (error) {
                        // Already removed by an earlier attempt, or never activated.
                        if (error?.code !== 'account_wipe_account_not_found') throw error;
                        stages.database = 'absent';
                    }
                } else stages.database = 'absent';
                if (accountId) {
                    hold(targetSha256, { subjectKey, external, kind, accountId, databaseDone: true, identityPending, unfinished: unfinished || held?.unfinished === true });
                    if (retryMarkers) {
                        try { await bounded(() => retryMarkers.write(targetSha256, Object.freeze({ schemaVersion: 1, targetSha256, accountSha256: sha256(accountId),
                            databaseDone: true, ...(unfinished || held?.unfinished === true ? { unfinished: true } : {}), recordedAt: new Date(now()).toISOString() })), signal); }
                        catch (_) { /* The in-memory reference still covers a retry from this process. */ }
                    }
                }
                stage = 'storage';
                if (inventory) {
                    signal.throwIfAborted();
                    const removed = await bounded(() => located.storage.delete(inventory, signal), signal);
                    counts.blobs = removed.blobs; counts.versions = removed.versions;
                    stages.storage = 'done';
                } else stages.storage = 'absent';
                stage = 'identity';
                if (!external) { stages.identity = 'not_applicable'; forget(targetSha256, kind); }
                // No sign-in subject was ever recorded for this signup, so there is
                // no External ID user this account can name.
                else if (!subjectKey && (unfinished || held?.unfinished)) { stages.identity = 'none_recorded'; forget(targetSha256, kind); }
                else {
                    // The Blob records naming the user are gone and this process no
                    // longer holds its reference: staff must remove it by hand.
                    if (!subjectKey) fail('account_wipe_identity_reference_lost');
                    let removed;
                    try { removed = await identity.remove(subjectKey, { signal, deadline: bound?.deadline, pendingPermanent: identityPending }); }
                    catch (error) {
                        const current = pendingIdentities.get(refKey(targetSha256, kind));
                        if ((error?.code === 'account_wipe_identity_pending' || error?.softDeleted === true) && current) hold(targetSha256, { ...current, identityPending: true });
                        throw error;
                    }
                    stages.identity = removed.alreadyGone ? 'absent' : 'done';
                    forget(targetSha256, kind);
                }
            }
        } catch (error) {
            code = wipeCode(error);
            // Checks and the single database transaction change nothing when they fail.
            if (['checks', 'database'].includes(stage)) {
                // The run budget ran out inside the transaction: rolled back, nothing
                // committed, safe to approve and apply again.
                outcome = code === 'account_wipe_timed_out' ? 'timed_out_rolled_back' : 'refused';
                if (code === 'account_wipe_commit_unknown') {
                    // COMMIT was sent and its result is unknown: the change may or may
                    // not be applied. The retry reference stays, so a delete retry converges.
                    outcome = 'unknown'; stages.database = 'unknown';
                } else if (stage === 'database') {
                    stages.database = 'failed';
                    // Nothing was deleted, so no new retry reference is kept.
                    if (refKind) { if (heldBefore) pendingIdentities.set(refKey(targetSha256, refKind), heldBefore); else forget(targetSha256, refKind); }
                }
            }
            else { outcome = 'partial'; failedStage = stage; stages[stage] = 'failed'; }
        }
        const recorded = await record(operationId, 'outcome', { ...base, outcome, stages, failedStage, code, counts },
            Math.max(OUTCOME_MIN_MS, Math.min(auditTimeoutMs, left())));
        if (!recorded) { try { log('[dashboard-admin-account-wipe] outcome_unrecorded ' + operationId); } catch (_) { /* no logging authority */ } }
        return Object.freeze({ operationId, action, outcome, stages: Object.freeze(stages), failedStage, code, counts: Object.freeze(counts), recorded });
    }

    return Object.freeze({ approve: audited('approve', approve), execute: audited('execute', execute),
        // For refusals decided before the executor (a malformed request body).
        refused: ({ actor, step, email = null, code }) => refusal(step === 'approve' ? 'approve' : 'execute', actor, email, { code }) });
}

module.exports = { createAccountWipeExecutor, APPROVAL_MS, WORDS, OUTCOME_RESERVE_MS, OUTCOME_MIN_MS };
