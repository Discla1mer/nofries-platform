'use strict';

const { isProxy } = require('node:util').types;
const { createHash } = require('node:crypto');
const { SignupError, createInvitationAcceptance, validateInvitationRecord,
    validateAcceptanceReceipt } = require('./invitationAcceptance');
const { createPostgresSignupAcceptanceJournal, SignupAcceptanceJournalError } = require('./postgresSignupAcceptanceJournal');
const { createSignupDiagnostics } = require('./signupDiagnostics');

function snapshotData(value, required, optional = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
        throw new SignupError('signup_request_invalid');
    }
    const keys = Reflect.ownKeys(value);
    if (required.some(key => !Object.hasOwn(value, key)) ||
        keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) {
        throw new SignupError('signup_request_invalid');
    }
    const result = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
            throw new SignupError('signup_request_invalid');
        }
        result[key] = descriptor.value;
    }
    return Object.freeze(result);
}

function registrationReference(receipt) {
    return Object.freeze({ subjectKey: receipt.subjectKey, tenantId: receipt.tenantId,
        organisationId: receipt.organisationId, invitationId: receipt.invitationId });
}
function matchingRegistration(value, receipt) {
    const keys = ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion', 'termsDigest',
        ...(Object.hasOwn(receipt, 'scheduleId') ? ['scheduleId', 'scheduleDigest'] : [])];
    const record = snapshotData(value, [...keys, 'status', 'revision']);
    if (record.status !== 'pending_admission' || !Number.isSafeInteger(record.revision) ||
        record.revision < 0 || Object.is(record.revision, -0) || keys.some(key => record[key] !== receipt[key])) {
        throw new SignupError('signup_registration_unavailable', 403);
    }
    return record;
}

/**
 * Build customerSignupRuntime's acceptTerms({ req, input }) callback.
 * resolveContext must read the server-held signup session, never identity,
 * tenant or invitation fields supplied by the request body. The existing
 * runtime still owns origin, CSRF and body-size checks before invoking this.
 * This factory neither mounts a route nor issues memberships or sessions.
 */
function buildAcceptance(options) {
    let dependencies;
    try {
        dependencies = snapshotData(options,
            ['store', 'verifyIdentity', 'database', 'resolveContext'],
            ['now', 'registrationStore', 'contextMode', 'authorizeNewAcceptance']);
    } catch (_) { throw new TypeError('signup_journal_composition_dependencies_required'); }
    const { store, verifyIdentity, database, resolveContext, registrationStore, authorizeNewAcceptance } = dependencies;
    if (Object.hasOwn(dependencies, 'registrationStore') && (!registrationStore || isProxy(registrationStore) ||
        ['registerAcceptance', 'readForInvitation'].some(key => typeof registrationStore[key] !== 'function' || isProxy(registrationStore[key])))) {
        throw new TypeError('signup_registration_store_required');
    }
    if (registrationStore && Object.hasOwn(registrationStore, 'assertAcceptanceWritable') &&
        (typeof registrationStore.assertAcceptanceWritable !== 'function' || isProxy(registrationStore.assertAcceptanceWritable))) {
        throw new TypeError('signup_registration_store_required');
    }
    if (Object.hasOwn(dependencies, 'authorizeNewAcceptance') &&
        (typeof authorizeNewAcceptance !== 'function' || isProxy(authorizeNewAcceptance))) {
        throw new TypeError('signup_journal_composition_dependencies_required');
    }
    const now = Object.hasOwn(dependencies, 'now') ? dependencies.now : Date.now;
    for (const fn of [verifyIdentity, resolveContext, now]) {
        if (typeof fn !== 'function' || isProxy(fn)) {
            throw new TypeError('signup_journal_composition_dependencies_required');
        }
    }
    if (!store || isProxy(store) || typeof store.transact !== 'function' ||
        isProxy(store.transact) || !database || isProxy(database)) {
        throw new TypeError('signup_journal_composition_dependencies_required');
    }
    const journal = createPostgresSignupAcceptanceJournal({ database });
    const scopedRead = record => journal.readForInvitation({ tenantId: record.tenantId,
        organisationId: record.organisationId, invitationId: record.invitationId });

    function hydrate(record, saved) {
        if (!saved || record.status === 'revoked') return record;
        const receipt = validateAcceptanceReceipt(saved);
        if (record.status === 'accepted' &&
            JSON.stringify(validateAcceptanceReceipt(record.acceptance)) !== JSON.stringify(receipt)) {
            throw new SignupError('signup_acceptance_journal_conflict', 409);
        }
        // The original invitation validator checks tenant, organisation, terms,
        // invitation ID and acceptedAt against the original validity window.
        try {
            return validateInvitationRecord({ ...record, status: 'accepted',
                revision: record.status === 'accepted' ? record.revision : record.revision + 1,
                acceptance: receipt });
        } catch (_) { throw new SignupError('signup_acceptance_journal_conflict', 409); }
    }

    const journaledStore = {
        async read(digest) {
            const raw = await store.read(digest);
            if (!raw) return null;
            const record = validateInvitationRecord(raw);
            if (record.status === 'revoked') return record;
            return hydrate(record, await scopedRead(record));
        },
        async transact(digest, work) {
            let registrationBeforeWrite;
            let recheckIdentity;
            const result = await store.transact(digest, async raw => {
                if (!raw) return work(null);
                const record = validateInvitationRecord(raw);
                if (record.status === 'revoked') return work(record);
                try {
                    const saved = await scopedRead(record);
                    const outcome = await work(hydrate(record, saved));
                    // A resolver-backed applicability gate runs at the durable
                    // consent boundary. Historical receipts bypass it because a
                    // withdrawn offer must not make earlier proof unrecoverable.
                    if (!saved && authorizeNewAcceptance) {
                        await authorizeNewAcceptance(validateAcceptanceReceipt(outcome.result));
                    }
                    // Persist decision proof BEFORE transient accepted state.
                    // A DB failure cannot leave a new unjournaled acceptance.
                    // A compatible reader must also close receipt-present
                    // retries before either journal or invitation persistence.
                    if (registrationStore?.assertAcceptanceWritable) {
                        await registrationStore.assertAcceptanceWritable({ subjectKey: outcome.result.subjectKey });
                    }
                    await journal.persist(outcome.result);
                    if (registrationStore) {
                        // The receipt is permanent before registration is populated.
                        // A failed registry write withholds success; explicit retry
                        // reuses the receipt and cannot revive a revoked registration.
                        work(outcome.record);
                        const registered = matchingRegistration(await registrationStore.registerAcceptance(outcome.result), outcome.result);
                        const latest = matchingRegistration(await registrationStore.readForInvitation(registrationReference(outcome.result)), outcome.result);
                        if (latest.revision !== registered.revision) throw new SignupError('signup_registration_changed', 409);
                        registrationBeforeWrite = latest;
                    }
                    // Recheck the domain's identity expiry after awaited I/O.
                    // The durable receipt is reused; no second consent is minted.
                    // Retain the domain's synchronous proof/clock validation
                    // for the final boundary, including store callback retries.
                    recheckIdentity = () => work(outcome.record);
                    return recheckIdentity();
                } catch (error) {
                    if (error instanceof SignupAcceptanceJournalError) {
                        throw new SignupError(error.code, error.statusCode);
                    }
                    throw error;
                }
            });
            // The durable invitation store still performs awaited I/O after its
            // callback. A revocation or revision during that write must withhold
            // acknowledgement even though the immutable receipt was committed.
            if (registrationStore) {
                const receipt = validateAcceptanceReceipt(result);
                const current = matchingRegistration(await registrationStore
                    .readForInvitation(registrationReference(receipt)), receipt);
                if (!registrationBeforeWrite || current.revision !== registrationBeforeWrite.revision) {
                    throw new SignupError('signup_registration_changed', 409);
                }
            }
            // No awaited I/O may follow this proof-expiry check. The callback
            // reuses the same receipt and does not write or mint new consent.
            if (recheckIdentity) recheckIdentity();
            return result;
        }
    };
    const contextMode = Object.hasOwn(dependencies, 'contextMode') ? dependencies.contextMode : 'token';
    const invitationField = contextMode === 'verified-digest' ? 'invitationDigest' : 'invitationToken';
    const acceptance = createInvitationAcceptance({ store: journaledStore, verifyIdentity, now, contextMode });
    async function contextFor(req) {
        try {
            return snapshotData(await resolveContext(req), [invitationField, 'identityProofHandle']);
        } catch (_) { throw new SignupError('signup_identity_required', 401); }
    }
    const acceptTerms = Object.freeze(async function acceptTerms(command) {
        const { req, input } = snapshotData(command, ['req', 'input']);
        // Detach the three user-confirmed primitives before any awaited work.
        const scheduled = !isProxy(input) && !!input && typeof input === 'object' &&
            Reflect.ownKeys(input).some(key => ['scheduleId', 'scheduleDigest'].includes(key));
        const terms = snapshotData(input, ['accepted', 'termsVersion', 'termsDigest',
            ...(scheduled ? ['scheduleId', 'scheduleDigest'] : [])]);
        if (terms.accepted !== true || typeof terms.termsVersion !== 'string' ||
            !terms.termsVersion || terms.termsVersion.length > 180 ||
            terms.termsVersion.trim() !== terms.termsVersion ||
            /[\u0000-\u001f\u007f]/.test(terms.termsVersion) ||
            typeof terms.termsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(terms.termsDigest) ||
            (scheduled && (typeof terms.scheduleId !== 'string' || !terms.scheduleId || terms.scheduleId.length > 180 ||
                terms.scheduleId.trim() !== terms.scheduleId || /[\u0000-\u001f\u007f]/.test(terms.scheduleId) ||
                typeof terms.scheduleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(terms.scheduleDigest)))) {
            throw new SignupError('signup_terms_required');
        }
        const context = await contextFor(req);
        await acceptance.accept(Object.freeze({ ...context, ...terms }));
        // This is an acknowledgement, not application access. Keep immutable
        // identity, organisation IDs and bootstrap material out of the response.
        return Object.freeze({ status: 'pending_admission' });
    });
    const resumeAcceptance = Object.freeze(async function resumeAcceptance(command) {
        const { req } = snapshotData(command, ['req']);
        const context = await contextFor(req);
        const inspection = await acceptance.inspectWithRecheck(context);
        const saved = await scopedRead(inspection.record);
        if (!saved) throw new SignupError('signup_acceptance_journal_unavailable', 503);
        inspection.recheck();
        const terms = { accepted: true, termsVersion: saved.termsVersion, termsDigest: saved.termsDigest };
        if (Object.hasOwn(saved, 'scheduleId')) {
            terms.scheduleId = saved.scheduleId; terms.scheduleDigest = saved.scheduleDigest;
        }
        await acceptance.accept(Object.freeze({ ...context, ...terms }));
        return Object.freeze({ status: 'pending_admission' });
    });
    return { acceptTerms, resumeAcceptance, acceptance, contextFor, scopedRead, store };
}

function createJournaledTermsAcceptance(options) {
    return buildAcceptance(options).acceptTerms;
}

/**
 * Compose the existing HTTP runtime's loadState and acceptTerms ports.
 * Both resolvers are server-owned. This does not mount routes or grant access.
 * resolveTerms returns the exact approved plain text whose UTF-8 SHA-256 is
 * the invitation termsDigest; it must not substitute a different version.
 */
function createJournaledSignupHandlers(options) {
    let dependencies;
    try {
        dependencies = snapshotData(options,
            ['store', 'verifyIdentity', 'database', 'resolveContext', 'resolveTerms'],
            ['now', 'loadContinuationState', 'registrationStore', 'contextMode', 'diagnostics']);
    } catch (_) { throw new TypeError('signup_state_dependencies_required'); }
    const { resolveTerms, loadContinuationState, diagnostics, ...acceptanceOptions } = dependencies;
    const report = createSignupDiagnostics({ sink: diagnostics });
    if (Object.hasOwn(dependencies, 'loadContinuationState') &&
        (typeof loadContinuationState !== 'function' || isProxy(loadContinuationState))) {
        throw new TypeError('signup_state_dependencies_required');
    }
    if (typeof resolveTerms !== 'function' || isProxy(resolveTerms) ||
        typeof dependencies.store?.read !== 'function') {
        throw new TypeError('signup_state_dependencies_required');
    }
    async function resolveApplicableTerms(reference) {
        try {
            const scheduled = Object.hasOwn(reference, 'scheduleId');
            const query = { termsVersion: reference.termsVersion, termsDigest: reference.termsDigest };
            if (typeof reference.tenantId === 'string') query.tenantId = reference.tenantId;
            if (typeof reference.organisationId === 'string') query.organisationId = reference.organisationId;
            if (Number.isSafeInteger(reference.acceptedAt) && reference.acceptedAt >= 0 &&
                !Object.is(reference.acceptedAt, -0)) query.acceptedAt = reference.acceptedAt;
            if (scheduled) { query.scheduleId = reference.scheduleId; query.scheduleDigest = reference.scheduleDigest; }
            const terms = snapshotData(await resolveTerms(Object.freeze(query)),
                ['termsText', 'termsVersion', 'termsDigest',
                    ...(scheduled ? ['scheduleId', 'scheduleText', 'scheduleDigest'] : [])]);
            if (terms.termsVersion !== reference.termsVersion || terms.termsDigest !== reference.termsDigest ||
                typeof terms.termsText !== 'string' || !terms.termsText || terms.termsText.length > 32768 ||
                createHash('sha256').update(terms.termsText, 'utf8').digest('hex') !== terms.termsDigest ||
                (scheduled && (terms.scheduleId !== reference.scheduleId || terms.scheduleDigest !== reference.scheduleDigest ||
                    typeof terms.scheduleText !== 'string' || !terms.scheduleText || terms.scheduleText.length > 32768 ||
                    createHash('sha256').update(terms.scheduleText, 'utf8').digest('hex') !== terms.scheduleDigest))) {
                throw new Error();
            }
            return terms;
        } catch (_) {
            throw new SignupError('signup_terms_unavailable', 503);
        }
    }
    const { acceptTerms, resumeAcceptance: resumeFromInvitation, acceptance, scopedRead } = buildAcceptance({
        ...acceptanceOptions, authorizeNewAcceptance: resolveApplicableTerms
    });
    return Object.freeze({
        acceptTerms,
        resumeAcceptance: resumeFromInvitation,
        async loadState(req) {
            let stage = 'signup_context';
            try {
                const rawContext = await dependencies.resolveContext(req);
                // Only explicit server-declared bootstrap absence selects this
                // path. An invalid, expired or revoked invitation must not fall
                // through to a second route after an authentication failure.
                if (rawContext === null && loadContinuationState) {
                    stage = 'signup_continuation';
                    const continuation = snapshotData(await loadContinuationState(req), ['status']);
                    if (!['resume_acceptance', 'pending_admission', 'unavailable'].includes(continuation.status)) throw new Error();
                    // A receipt without a registration cannot distinguish lifecycle
                    // cleanup from an erased revocation tombstone. Never recreate
                    // admission authority after the invitation record is absent.
                    if (continuation.status !== 'pending_admission') report(stage, undefined, 'signup_continuation_unavailable');
                    return Object.freeze({ status: continuation.status === 'resume_acceptance'
                        ? 'unavailable' : continuation.status });
                }
                const context = snapshotData(rawContext, [dependencies.contextMode === 'verified-digest' ? 'invitationDigest' : 'invitationToken', 'identityProofHandle']);
                stage = 'invitation_inspection';
                const inspection = await acceptance.inspectWithRecheck(context);
                const current = inspection.record;
                if (current.status === 'accepted') {
                    stage = 'acceptance_journal';
                    const saved = await scopedRead(current);
                    if (saved) {
                        if (JSON.stringify(validateAcceptanceReceipt(current.acceptance)) !==
                            JSON.stringify(validateAcceptanceReceipt(saved))) throw new Error();
                        if (!dependencies.registrationStore) {
                            stage = 'proof_recheck';
                            inspection.recheck();
                            return Object.freeze({ status: 'pending_admission' });
                        }
                        stage = 'registration';
                        const registration = await dependencies.registrationStore.readForInvitation(registrationReference(saved));
                        if (registration) {
                            const beforeIdentity = matchingRegistration(registration, saved);
                            stage = 'identity_recheck';
                            const finalInspection = await acceptance.inspectWithRecheck(context);
                            const rechecked = finalInspection.record;
                            if (rechecked.status !== 'accepted' || JSON.stringify(validateAcceptanceReceipt(rechecked.acceptance)) !==
                                JSON.stringify(validateAcceptanceReceipt(saved))) throw new Error();
                            // Identity inspection awaits provider and durable-store I/O.
                            // A valid immutable receipt cannot override a registration
                            // revoked or revised while those reads were in progress.
                            stage = 'registration_recheck';
                            const latest = matchingRegistration(await dependencies.registrationStore
                                .readForInvitation(registrationReference(saved)), saved);
                            if (latest.revision !== beforeIdentity.revision) throw new Error();
                            stage = 'proof_recheck';
                            finalInspection.recheck();
                            return Object.freeze({ status: 'pending_admission' });
                        }
                        // A durable receipt without registration needs an explicit,
                        // CSRF-protected reconciliation action. It does not display
                        // or re-offer withdrawn terms and cannot mint new consent.
                        stage = 'proof_recheck';
                        inspection.recheck();
                        return Object.freeze({ status: 'resume_acceptance' });
                    }
                    // A legacy transient-only acceptance is not success.
                    // Display the SAME terms for an explicit, CSRF-checked retry.
                }
                stage = 'terms_offer';
                const terms = await resolveApplicableTerms(current);
                stage = 'proof_recheck';
                inspection.recheck();
                return Object.freeze({ status: 'terms', ...terms });
            } catch (error) {
                report(stage, error);
                return Object.freeze({ status: 'unavailable' });
            }
        }
    });
}

module.exports = Object.freeze({ createJournaledTermsAcceptance, createJournaledSignupHandlers });
