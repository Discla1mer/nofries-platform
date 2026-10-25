const crypto = require('crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');
const { parseCanonicalProviderId } = require('./providerIds');

const SCHEMA_VERSION = 2;
const MAX_OPERATIONS = 5000;
// The hot ledger is deliberately small. Terminal receipts are archived per operation;
// the hot audit is only the bounded operational window returned by audit().
const MAX_AUDIT = 500;
const REPEAT_TOKEN_TTL_MS = 10 * 60 * 1000;
const DUPLICATE_INTENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPEAT_CONFIRMATIONS = 500;
const MAX_REPEAT_CONFIRMATION_BYTES = 512 * 1024;
const MAX_HOT_LEDGER_BYTES = 7 * 1024 * 1024;
const NOTE_ORIGINS = new Set(['customer_portal_submission', 'customer_reply', 'service_desk_update']);
// Autotask documents that a request may continue executing for up to five
// minutes. An ambiguous dispatch must therefore remain fenced beyond that
// window and be followed by a second, independent exact-provider read.
const PROVIDER_ABSENCE_SETTLEMENT_MS = 6 * 60 * 1000;

class ProviderOperationFenceError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createProviderOperationFence(options = {}) {
    const env = options.env || process.env;
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const store = options.store || createFenceStore(Object.assign({}, options, { env }));
    const maxActiveOperations = positiveInteger(options.maxActiveOperations, MAX_OPERATIONS, 1, MAX_OPERATIONS);

    function status() {
        const storage = store.status();
        return {
            provider: 'service_desk_operation_fence',
            storageProvider: storage.provider,
            configured: storage.configured,
            durable: storage.durable === true,
            crossInstanceExclusive: storage.crossInstanceExclusive === true,
            leaseRenewal: storage.leaseRenewal === true,
            immutableOperationBinding: storage.immutableOperationBinding === true,
            terminalReceiptArchive: storage.terminalReceiptArchive === true,
            boundedDuplicateIntentIndex: storage.boundedDuplicateIntentIndex === true,
            state: storage.state
        };
    }

    async function reserve(input = {}) {
        const scope = operationScope(input);
        const operationId = requireOperationId(input.operationId);
        const operationType = requireOperationType(input.operationType);
        const resourceKey = cleanResourceKey(input.resourceKey);
        const repeatToken = cleanToken(input.repeatToken);
        const actorSubjectSha256 = cleanActorHash(input.actorSubjectSha256 || input.actorHash);
        const requesterEmailSha256 = cleanActorHash(input.requesterEmailSha256 || input.requesterEmailHash);
        const intakeChannel = cleanIdentifier(input.intakeChannel, 40);
        const noteMessageSha256 = cleanSha256(input.noteMessageSha256);
        const noteOrigin = cleanNoteOrigin(input.noteOrigin);
        if (Boolean(noteMessageSha256) !== Boolean(noteOrigin)) {
            throw fenceError(400, 'The note provenance hash and origin must be supplied together', 'provider_note_provenance_invalid');
        }
        const requestFingerprint = normaliseFingerprint(input.fingerprint || input.request);
        const fingerprint = normaliseFingerprint({
            requestFingerprint,
            providerScopeId: scope.providerScopeId,
            providerIdentitySha256: scope.providerIdentitySha256,
            companyId: scope.companyId,
            actorSubjectSha256,
            operationType,
            resourceKey,
            noteMessageSha256,
            noteOrigin
        });
        if (typeof store.claimOperationIdentity !== 'function') {
            throw fenceError(503, 'The durable operation identity binding is unavailable', 'provider_operation_identity_store_required');
        }
        await store.claimOperationIdentity(scope, { operationId, operationType, fingerprint });
        if (
            typeof store.readTerminalOperation !== 'function' || typeof store.readTerminalFingerprint !== 'function' ||
            typeof store.archiveTerminal !== 'function'
        ) {
            throw fenceError(503, 'The durable terminal receipt archive is unavailable', 'provider_operation_terminal_archive_required');
        }
        const archivedById = await store.readTerminalOperation(scope, operationId);
        const archivedByFingerprint = archivedById
            ? null
            : await store.readTerminalFingerprint(scope, fingerprint, now());
        let issuedRepeatToken = '';
        const outcome = await store.update(scope, (ledger) => {
            ledger.operationTombstones = ledger.operationTombstones || {};
            ledger.repeatConfirmations = ledger.repeatConfirmations || {};
            pruneRepeatConfirmations(ledger, now());
            let existing = ledger.operations[operationId] || ledger.operationTombstones[operationId] || archivedById;
            if (existing) {
                assertSameOperation(existing, operationType, fingerprint);
                appendAudit(ledger, existing, 'operation.replayed', now(), { status: existing.status });
                if (existing.status === 'completed') return publicReservation(existing, 'replay');
                if (existing.status === 'known_absent') {
                    if (!ledger.operations[operationId]) {
                        ledger.operations[operationId] = clone(existing);
                        delete ledger.operationTombstones[operationId];
                        existing = ledger.operations[operationId];
                    }
                    const resourceOwner = existing.resourceKey && ledger.resourceLocks[existing.resourceKey];
                    if (resourceOwner && resourceOwner !== existing.operationId) {
                        const owner = ledger.operations[resourceOwner];
                        if (owner && ['pending', 'uncertain', 'partial_applied'].includes(owner.status)) {
                            return publicReservation(owner, 'pending');
                        }
                    }
                    if (existing.resourceKey) ledger.resourceLocks[existing.resourceKey] = existing.operationId;
                    existing.status = 'pending';
                    existing.attempt = Number(existing.attempt || 1) + 1;
                    existing.updatedAt = now().toISOString();
                    appendAudit(ledger, existing, 'operation.retry_safe', now(), {});
                    return publicReservation(existing, 'reserved');
                }
                return publicReservation(existing, 'pending');
            }

            const matching = Object.values(ledger.operations).concat(
                Object.values(ledger.operationTombstones || {}),
                archivedByFingerprint ? [archivedByFingerprint] : []
            )
                .filter((record) => record.operationType === operationType && record.fingerprint === fingerprint)
                .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
            const blocking = matching.find((record) => ['pending', 'uncertain', 'partial_applied'].includes(record.status));
            if (blocking) {
                appendAudit(ledger, blocking, 'operation.duplicate_blocked', now(), { requestedOperationId: operationId });
                return publicReservation(blocking, 'pending');
            }
            const completed = matching.find((record) => record.status === 'completed');
            let repeatedFromOperationId = '';
            if (completed) {
                if (!repeatToken) {
                    assertRepeatConfirmationCapacity(ledger);
                    issuedRepeatToken = randomBytes(32).toString('base64url');
                    ledger.repeatConfirmations[operationId] = {
                        operationId,
                        operationType,
                        fingerprint,
                        priorOperationId: completed.operationId,
                        tokenSha256: hashToken(issuedRepeatToken),
                        issuedAt: now().toISOString(),
                        expiresAt: new Date(now().getTime() + REPEAT_TOKEN_TTL_MS).toISOString(),
                        consumedAt: '',
                        consumedByOperationId: ''
                    };
                    if (Buffer.byteLength(JSON.stringify(ledger.repeatConfirmations), 'utf8') > MAX_REPEAT_CONFIRMATION_BYTES) {
                        delete ledger.repeatConfirmations[operationId];
                        throw fenceError(503, 'Too many repeat confirmations are awaiting expiry', 'provider_repeat_confirmation_capacity');
                    }
                    appendAudit(ledger, completed, 'operation.repeat_confirmation_required', now(), { requestedOperationId: operationId });
                    return {
                        operationId,
                        status: 'confirmation_required',
                        disposition: 'confirmation_required',
                        repeatToken: issuedRepeatToken,
                        repeatedFromOperationId: completed.operationId
                    };
                }
                const confirmation = ledger.repeatConfirmations[operationId];
                if (!confirmation || confirmation.operationId !== operationId || confirmation.operationType !== operationType ||
                    confirmation.fingerprint !== fingerprint || confirmation.priorOperationId !== completed.operationId ||
                    confirmation.tokenSha256 !== hashToken(repeatToken) || confirmation.consumedAt ||
                    Date.parse(confirmation.expiresAt || '') <= now().getTime()) {
                    throw fenceError(409, 'The repeat confirmation is invalid or expired', 'repeat_confirmation_invalid');
                }
                confirmation.consumedAt = now().toISOString();
                confirmation.consumedByOperationId = operationId;
                repeatedFromOperationId = completed.operationId;
            } else if (repeatToken) {
                throw fenceError(409, 'The repeat confirmation is not valid for this operation', 'repeat_confirmation_invalid');
            }
            if (resourceKey) {
                const resourceOwner = ledger.resourceLocks[resourceKey];
                const owner = resourceOwner && ledger.operations[resourceOwner];
                if (owner && ['pending', 'uncertain', 'partial_applied'].includes(owner.status)) {
                    appendAudit(ledger, owner, 'operation.resource_blocked', now(), { requestedOperationId: operationId });
                    throw fenceError(409, 'Another unresolved provider operation holds this target', 'provider_operation_resource_locked', {
                        operationId: owner.operationId,
                        status: 'pending'
                    });
                }
                delete ledger.resourceLocks[resourceKey];
            }
            const at = now().toISOString();
            const record = {
                operationId,
                operationType,
                fingerprint,
                resourceKey,
                actorSubjectSha256,
                requesterEmailSha256,
                intakeChannel,
                noteMessageSha256,
                noteOrigin,
                status: 'pending',
                attempt: 1,
                repeatedFromOperationId,
                createdAt: at,
                updatedAt: at,
                completedAt: '',
                steps: {},
                result: null,
                failureCode: ''
            };
            ledger.operations[operationId] = record;
            if (resourceKey) ledger.resourceLocks[resourceKey] = operationId;
            appendAudit(ledger, record, 'operation.reserved', now(), { repeatedFromOperationId });
            compactOperationLedger(ledger, maxActiveOperations);
            return publicReservation(record, 'reserved');
        });
        if (outcome && outcome.status === 'completed') {
            await archiveAndEvict(scope, operationId);
        }
        return outcome;
    }

    async function beginStep(input = {}) {
        return mutateRecord(input, (ledger, record) => {
            const name = requireStepName(input.step);
            const prior = record.steps[name] || { status: 'not_started' };
            if (prior.status === 'applied') return publicStep(prior);
            if (prior.status === 'uncertain') {
                throw fenceError(409, 'The provider outcome must be reconciled before retrying', 'provider_outcome_unknown', {
                    operationId: record.operationId,
                    status: 'pending'
                });
            }
            if (prior.status === 'dispatching') {
                throw fenceError(409, 'The provider operation is already in progress', 'provider_operation_pending', {
                    operationId: record.operationId,
                    status: 'pending'
                });
            }
            const at = now().toISOString();
            const step = {
                status: 'dispatching',
                attempt: Number(prior.attempt || 0) + 1,
                startedAt: at,
                updatedAt: at,
                appliedAt: '',
                checkpoint: prior.checkpoint || null,
                failureCode: ''
            };
            record.steps[name] = step;
            record.status = 'pending';
            record.updatedAt = at;
            appendAudit(ledger, record, 'operation.step_dispatching', now(), { step: name, attempt: step.attempt });
            return publicStep(step);
        });
    }

    async function applyStep(input = {}) {
        return mutateRecord(input, (ledger, record) => {
            const name = requireStepName(input.step);
            const prior = record.steps[name] || { status: 'not_started' };
            if (prior.status === 'applied') return publicStep(prior);
            if (!['dispatching', 'uncertain', 'known_absent'].includes(prior.status) && input.reconciled !== true) {
                throw fenceError(409, 'The provider step was not dispatched', 'provider_step_state_invalid');
            }
            if (prior.status === 'uncertain' && input.reconciled !== true) {
                throw fenceError(409, 'Only reconciliation can resolve an uncertain provider step', 'provider_reconciliation_required');
            }
            const at = now().toISOString();
            const checkpoint = safeCheckpoint(input.checkpoint);
            record.steps[name] = Object.assign({}, prior, {
                status: 'applied',
                updatedAt: at,
                appliedAt: at,
                checkpoint,
                failureCode: ''
            });
            record.status = 'pending';
            record.updatedAt = at;
            appendAudit(ledger, record, input.reconciled === true ? 'operation.step_reconciled' : 'operation.step_applied', now(), { step: name });
            return publicStep(record.steps[name]);
        });
    }

    async function failStep(input = {}) {
        const scope = operationScope(input);
        let operationKnownAbsent = false;
        const outcome = await mutateRecord(input, (ledger, record) => {
            const name = requireStepName(input.step);
            const prior = record.steps[name] || { status: 'dispatching', attempt: 1 };
            if (prior.status === 'applied') return publicStep(prior);
            const effectAbsent = input.providerEffectAbsent === true;
            const at = now().toISOString();
            const statusValue = effectAbsent ? 'known_absent' : 'uncertain';
            record.steps[name] = Object.assign({}, prior, {
                status: statusValue,
                updatedAt: at,
                failureCode: cleanCode(input.failureCode)
            });
            const partialApplied = effectAbsent && Object.entries(record.steps || {}).some(([stepName, step]) => (
                stepName !== name && step.status === 'applied'
            ));
            record.status = partialApplied ? 'partial_applied' : statusValue;
            record.updatedAt = at;
            record.failureCode = cleanCode(input.failureCode);
            if (effectAbsent && !partialApplied && record.resourceKey && ledger.resourceLocks[record.resourceKey] === record.operationId) {
                delete ledger.resourceLocks[record.resourceKey];
            }
            operationKnownAbsent = effectAbsent && !partialApplied;
            appendAudit(ledger, record, effectAbsent ? 'operation.step_known_absent' : 'operation.step_uncertain', now(), {
                step: name,
                failureCode: record.failureCode
            });
            return publicStep(record.steps[name]);
        });
        if (operationKnownAbsent) await evictKnownAbsent(scope, requireOperationId(input.operationId));
        return outcome;
    }

    async function resolveStepAbsent(input = {}) {
        const step = requireStepName(input.step);
        const expectedAttempt = positiveInteger(input.expectedAttempt, 0, 1, 1000000);
        const providerEvidenceRef = cleanEvidenceReference(input.providerEvidenceRef);
        const operatorEvidenceRef = cleanEvidenceReference(input.operatorEvidenceRef || input.evidenceRef);
        const providerTargetKey = cleanProviderTargetKey(input.providerTargetKey);
        const resolverSubjectSha256 = cleanActorHash(input.resolverSubjectSha256);
        if (
            input.confirmation !== 'CONFIRM PROVIDER EFFECT ABSENT' || !expectedAttempt || !providerEvidenceRef ||
            !operatorEvidenceRef || !providerTargetKey || !resolverSubjectSha256
        ) {
            throw fenceError(400, 'An exact provider-absence confirmation, attempt and evidence reference are required', 'provider_absence_resolution_invalid');
        }
        return mutateRecord(input, (ledger, record) => {
            const prior = record.steps[step];
            if (!prior || !['dispatching', 'uncertain'].includes(prior.status) || Number(prior.attempt || 0) !== expectedAttempt) {
                throw fenceError(409, 'The provider step no longer matches the unresolved attempt', 'provider_absence_resolution_conflict');
            }
            const observation = prior.absenceObservation;
            if (!providerAbsenceReady(prior, observation, expectedAttempt, providerTargetKey, providerEvidenceRef)) {
                throw fenceError(409, 'The provider absence has not completed its settlement checks', 'provider_absence_settlement_required');
            }
            resolveAbsentStep(ledger, record, step, prior, expectedAttempt, providerEvidenceRef,
                operatorEvidenceRef, resolverSubjectSha256, now());
            return publicReservation(record, 'pending');
        });
    }

    async function recordAbsenceObservation(input = {}) {
        const step = requireStepName(input.step);
        const expectedAttempt = positiveInteger(input.expectedAttempt, 0, 1, 1000000);
        const providerEvidenceRef = cleanEvidenceReference(input.providerEvidenceRef);
        const providerCheckedAt = normaliseDate(input.providerCheckedAt);
        const operatorEvidenceRef = cleanEvidenceReference(input.operatorEvidenceRef || input.evidenceRef);
        const providerTargetKey = cleanProviderTargetKey(input.providerTargetKey);
        const resolveWhenReady = input.resolveWhenReady === true;
        const resolverSubjectSha256 = resolveWhenReady ? cleanActorHash(input.resolverSubjectSha256) : '';
        if (
            !expectedAttempt || !providerEvidenceRef || !providerCheckedAt || !providerTargetKey ||
            (resolveWhenReady && (
                input.confirmation !== 'CONFIRM PROVIDER EFFECT ABSENT' || !operatorEvidenceRef || !resolverSubjectSha256
            ))
        ) {
            throw fenceError(400, 'An exact provider absence observation is required', 'provider_absence_observation_invalid');
        }
        return mutateRecord(input, (ledger, record) => {
            const prior = record.steps[step];
            if (!prior || !['dispatching', 'uncertain'].includes(prior.status) || Number(prior.attempt || 0) !== expectedAttempt) {
                throw fenceError(409, 'The provider step no longer matches the unresolved attempt', 'provider_absence_resolution_conflict');
            }
            const atDate = now();
            const at = atDate.toISOString();
            const startedAt = Date.parse(prior.startedAt || '');
            const checkedAt = Date.parse(providerCheckedAt);
            if (
                !Number.isFinite(startedAt) || !Number.isFinite(checkedAt) || checkedAt < startedAt ||
                Math.abs(checkedAt - atDate.getTime()) > 60 * 1000
            ) {
                throw fenceError(409, 'The provider absence observation time is not bound to this attempt', 'provider_absence_observation_stale');
            }
            const existing = prior.absenceObservation;
            if (
                existing && Number(existing.attempt || 0) === expectedAttempt &&
                existing.providerTargetKey === providerTargetKey &&
                (
                    existing.lastProviderEvidenceRef === providerEvidenceRef ||
                    Date.parse(providerCheckedAt) <= Date.parse(existing.lastObservedAt || '')
                )
            ) {
                throw fenceError(409, 'A fresh provider absence observation is required', 'provider_absence_observation_not_fresh');
            }
            const observation = !existing || Number(existing.attempt || 0) !== expectedAttempt
                ? {
                    attempt: expectedAttempt,
                    count: 1,
                    firstObservedAt: providerCheckedAt,
                    lastObservedAt: providerCheckedAt,
                    firstProviderEvidenceRef: providerEvidenceRef,
                    lastProviderEvidenceRef: providerEvidenceRef,
                    providerTargetKey
                }
                : Object.assign({}, existing, {
                    count: existing.providerTargetKey === providerTargetKey &&
                        existing.lastProviderEvidenceRef !== providerEvidenceRef &&
                        Date.parse(providerCheckedAt) > Date.parse(existing.lastObservedAt || '')
                        ? Math.min(2, Number(existing.count || 1) + 1)
                        : existing.providerTargetKey === providerTargetKey ? Number(existing.count || 1) : 1,
                    firstObservedAt: existing.providerTargetKey === providerTargetKey ? existing.firstObservedAt : providerCheckedAt,
                    firstProviderEvidenceRef: existing.providerTargetKey === providerTargetKey
                        ? existing.firstProviderEvidenceRef
                        : providerEvidenceRef,
                    lastObservedAt: providerCheckedAt,
                    lastProviderEvidenceRef: providerEvidenceRef,
                    providerTargetKey
                });
            record.steps[step] = Object.assign({}, prior, { absenceObservation: observation, updatedAt: at });
            record.updatedAt = at;
            appendAudit(ledger, record, 'operation.step_absence_observed', now(), {
                step,
                attempt: expectedAttempt,
                count: observation.count,
                providerEvidenceRef,
                providerTargetKey
            });
            const ready = providerAbsenceReady(
                record.steps[step], observation, expectedAttempt, providerTargetKey, providerEvidenceRef
            );
            let resolved = false;
            if (resolveWhenReady && ready) {
                resolveAbsentStep(ledger, record, step, record.steps[step], expectedAttempt, providerEvidenceRef,
                    operatorEvidenceRef, resolverSubjectSha256, atDate);
                resolved = true;
            }
            return {
                ready,
                resolved,
                record: resolved ? publicReservation(record, 'pending') : undefined,
                firstObservedAt: observation.firstObservedAt,
                nextObservationAt: new Date(Math.max(
                    Date.parse(record.steps[step].startedAt || '') + PROVIDER_ABSENCE_SETTLEMENT_MS,
                    Date.parse(observation.firstObservedAt) + PROVIDER_ABSENCE_SETTLEMENT_MS
                )).toISOString(),
                count: observation.count
            };
        });
    }

    async function verifyNoteProvenance(input = {}) {
        const scope = operationScope(input);
        const operationId = requireOperationId(input.operationId);
        const messageSha256 = cleanSha256(input.noteMessageSha256);
        const origin = cleanNoteOrigin(input.noteOrigin);
        const ticketId = parseCanonicalProviderId(input.ticketId);
        const noteId = parseCanonicalProviderId(input.noteId);
        if (!messageSha256 || !ticketId || !noteId || !['customer_portal_submission', 'customer_reply'].includes(origin)) return false;
        const record = typeof store.readTerminalOperation === 'function'
            ? await store.readTerminalOperation(scope, operationId)
            : null;
        const noteReceipt = record && record.noteReceipt;
        return Boolean(
            record && record.status === 'completed' && record.noteMessageSha256 === messageSha256 && record.noteOrigin === origin &&
            record.intakeChannel === 'customer_portal' && record.actorSubjectSha256 && record.requesterEmailSha256 &&
            noteReceipt && noteReceipt.ticketId === ticketId && noteReceipt.noteId === noteId
        );
    }

    async function getResolutionContext(input = {}) {
        const scope = operationScope(input);
        const operationId = requireOperationId(input.operationId);
        const ledger = await store.read(scope);
        const record = ledger.operations[operationId];
        if (!record || record.status === 'completed') {
            throw fenceError(404, 'Provider operation not found', 'provider_operation_not_found');
        }
        const steps = {};
        for (const [name, value] of Object.entries(record.steps || {})) {
            steps[name] = {
                status: value && value.status || 'not_started',
                attempt: Number(value && value.attempt || 0),
                checkpoint: safeCheckpoint(value && value.checkpoint || null)
            };
        }
        return {
            operationId: record.operationId,
            operationType: record.operationType,
            resourceKey: record.resourceKey || '',
            noteMessageSha256: record.noteMessageSha256 || '',
            noteOrigin: record.noteOrigin || '',
            steps
        };
    }

    async function complete(input = {}) {
        const scope = operationScope(input);
        const completed = await mutateRecord(input, (ledger, record) => {
            if (record.status === 'completed') return publicReservation(record, 'replay');
            if (Object.values(record.steps).some((step) => step.status === 'uncertain' || step.status === 'dispatching')) {
                throw fenceError(409, 'The provider outcome is not fully reconciled', 'provider_outcome_unknown');
            }
            const at = now().toISOString();
            record.status = 'completed';
            record.result = safeResult(input.result);
            record.updatedAt = at;
            record.completedAt = at;
            record.failureCode = '';
            if (record.resourceKey && ledger.resourceLocks[record.resourceKey] === record.operationId) {
                delete ledger.resourceLocks[record.resourceKey];
            }
            appendAudit(ledger, record, 'operation.completed', now(), {});
            return publicReservation(record, 'completed');
        });
        await archiveAndEvict(scope, requireOperationId(input.operationId));
        return completed;
    }

    async function cancel(input = {}) {
        const scope = operationScope(input);
        const outcome = await mutateRecord(input, (ledger, record) => {
            if (record.status === 'completed') throw fenceError(409, 'A completed provider operation cannot be cancelled', 'provider_operation_state_invalid');
            if (Object.values(record.steps || {}).some((step) => ['dispatching', 'applied', 'uncertain'].includes(step.status))) {
                throw fenceError(409, 'A dispatched provider operation cannot be cancelled', 'provider_operation_state_invalid');
            }
            const at = now().toISOString();
            record.status = 'known_absent';
            record.updatedAt = at;
            record.failureCode = cleanCode(input.failureCode || 'pre_dispatch_cancelled');
            if (record.resourceKey && ledger.resourceLocks[record.resourceKey] === record.operationId) {
                delete ledger.resourceLocks[record.resourceKey];
            }
            appendAudit(ledger, record, 'operation.cancelled_before_dispatch', now(), { failureCode: record.failureCode });
            return publicReservation(record, 'cancelled');
        });
        await evictKnownAbsent(scope, requireOperationId(input.operationId));
        return outcome;
    }

    async function read(input = {}) {
        const scope = operationScope(input);
        const operationId = requireOperationId(input.operationId);
        const ledger = await store.read(scope);
        const record = ledger.operations[operationId] || ledger.operationTombstones[operationId];
        if (record) {
            assertOptionalActorBinding(record, input);
            return publicReservation(record, record.status === 'completed' ? 'replay' : 'pending');
        }
        const archived = typeof store.readTerminalOperation === 'function'
            ? await store.readTerminalOperation(scope, operationId)
            : null;
        if (archived) assertOptionalActorBinding(archived, input);
        return archived ? publicReservation(archived, 'replay') : null;
    }

    async function audit(input = {}) {
        const ledger = await store.read(operationScope(input));
        return ledger.audit.slice(-500).map((event) => Object.assign({}, event));
    }

    async function mutateRecord(input, mutator) {
        const scope = operationScope(input);
        const operationId = requireOperationId(input.operationId);
        return store.update(scope, (ledger) => {
            const record = ledger.operations[operationId];
            if (!record) throw fenceError(404, 'Provider operation not found', 'provider_operation_not_found');
            return mutator(ledger, record);
        });
    }

    async function archiveAndEvict(scope, operationId) {
        const ledger = await store.read(scope);
        const record = ledger.operations[operationId] || ledger.operationTombstones[operationId];
        if (!record || record.status !== 'completed') return;
        await store.archiveTerminal(scope, record, now());
        await store.update(scope, (current) => {
            const active = current.operations[operationId] || current.operationTombstones[operationId];
            if (active && active.status === 'completed' && active.fingerprint === record.fingerprint) {
                delete current.operations[operationId];
                delete current.operationTombstones[operationId];
            }
            return null;
        });
    }

    async function evictKnownAbsent(scope, operationId) {
        await store.update(scope, (ledger) => {
            const record = ledger.operations[operationId] || ledger.operationTombstones[operationId];
            if (record && record.status === 'known_absent') {
                if (record.resourceKey && ledger.resourceLocks[record.resourceKey] === operationId) {
                    delete ledger.resourceLocks[record.resourceKey];
                }
                delete ledger.operations[operationId];
                delete ledger.operationTombstones[operationId];
            }
            return null;
        });
    }

    return {
        applyStep,
        audit,
        beginStep,
        cancel,
        complete,
        failStep,
        getResolutionContext,
        read,
        recordAbsenceObservation,
        resolveStepAbsent,
        reserve,
        status,
        verifyNoteProvenance
    };
}

function createFenceStore(options = {}) {
    const env = options.env || process.env;
    const provider = String(options.provider || env.NOFRIES_SERVICE_DESK_OPERATION_STORAGE_PROVIDER || 'memory').trim().toLowerCase();
    if (provider === 'memory') return createMemoryFenceStore(options);
    if (provider !== 'azure') return invalidStore(provider);
    const account = cleanStorageName(env.NOFRIES_SERVICE_DESK_OPERATION_STORAGE_ACCOUNT);
    const containerName = cleanContainerName(env.NOFRIES_SERVICE_DESK_OPERATION_STORAGE_CONTAINER);
    if (!account || !containerName) return invalidStore('azure');
    const credential = options.credential || new DefaultAzureCredential();
    const serviceClient = options.blobServiceClient || new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
    const container = options.containerClient || serviceClient.getContainerClient(containerName);
    return createAzureFenceStore({ container, leaseSeconds: options.leaseSeconds });
}

function createMemoryFenceStore() {
    const ledgers = new Map();
    const locks = new Map();
    const operationIdentities = new Map();
    const terminalOperations = new Map();
    const terminalFingerprints = new Map();
    return {
        status: () => ({
            provider: 'memory',
            configured: true,
            durable: false,
            crossInstanceExclusive: false,
            leaseRenewal: false,
            immutableOperationBinding: true,
            terminalReceiptArchive: true,
            boundedDuplicateIntentIndex: true,
            state: 'test_only'
        }),
        async claimOperationIdentity(scope, binding) {
            const key = operationIdentityKey(scope, binding.operationId);
            const expected = operationIdentityRecord(scope, binding);
            const prior = operationIdentities.get(key);
            if (prior) return assertOperationIdentity(prior, expected);
            operationIdentities.set(key, clone(expected));
            return clone(expected);
        },
        async readTerminalOperation(scope, operationId) {
            const value = terminalOperations.get(operationIdentityKey(scope, operationId));
            if (!value) return null;
            assertTerminalScope(value, scope);
            return clone(value);
        },
        async readTerminalFingerprint(scope, fingerprint, at = new Date()) {
            const value = terminalFingerprints.get(terminalFingerprintKey(scope, fingerprint));
            if (!value || Date.parse(value.expiresAt || '') <= at.getTime()) return null;
            assertTerminalScope(value, scope);
            return clone(value);
        },
        async archiveTerminal(scope, record, at = new Date()) {
            const receipt = terminalReceipt(scope, record, at);
            const operationKey = operationIdentityKey(scope, record.operationId);
            const prior = terminalOperations.get(operationKey);
            if (prior) assertSameTerminalReceipt(prior, receipt);
            else terminalOperations.set(operationKey, clone(receipt));
            const fingerprintKey = terminalFingerprintKey(scope, record.fingerprint);
            const indexed = terminalFingerprints.get(fingerprintKey);
            if (!indexed || Date.parse(indexed.completedAt || '') <= Date.parse(receipt.completedAt || '')) {
                terminalFingerprints.set(fingerprintKey, clone(receipt));
            }
            return clone(receipt);
        },
        async read(scope) {
            return clone(ledgers.get(scope.key) || emptyLedger(scope));
        },
        async update(scope, mutator) {
            const previous = locks.get(scope.key) || Promise.resolve();
            let release;
            const gate = new Promise((resolve) => { release = resolve; });
            locks.set(scope.key, gate);
            await previous;
            try {
                const ledger = clone(ledgers.get(scope.key) || emptyLedger(scope));
                const result = await mutator(ledger);
                assertHotLedgerBounds(ledger);
                ledger.revision = Number(ledger.revision || 0) + 1;
                ledgers.set(scope.key, clone(ledger));
                return result;
            } finally {
                release();
                if (locks.get(scope.key) === gate) locks.delete(scope.key);
            }
        }
    };
}

function createAzureFenceStore(options = {}) {
    const container = options.container;
    const leaseSeconds = positiveInteger(options.leaseSeconds, 15, 15, 60);
    if (!container) return invalidStore('azure');
    return {
        status: () => ({
            provider: 'azure',
            configured: true,
            durable: true,
            crossInstanceExclusive: true,
            leaseRenewal: true,
            immutableOperationBinding: true,
            terminalReceiptArchive: true,
            boundedDuplicateIntentIndex: true,
            state: 'ready'
        }),
        async claimOperationIdentity(scope, binding) {
            const expected = operationIdentityRecord(scope, binding);
            const blob = container.getBlockBlobClient(operationIdentityBlobName(scope, binding.operationId));
            const payload = JSON.stringify(expected);
            try {
                await blob.upload(payload, Buffer.byteLength(payload), {
                    conditions: { ifNoneMatch: '*' },
                    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
                });
                return expected;
            } catch (error) {
                if (!isConflict(error)) throw storageError(error);
            }
            try {
                return assertOperationIdentity(await downloadJson(blob), expected);
            } catch (error) {
                if (error instanceof ProviderOperationFenceError) throw error;
                throw storageError(error);
            }
        },
        async readTerminalOperation(scope, operationId) {
            return readOptionalJson(container.getBlockBlobClient(terminalOperationBlobName(scope, operationId)), scope);
        },
        async readTerminalFingerprint(scope, fingerprint, at = new Date()) {
            const value = await readOptionalJson(container.getBlockBlobClient(terminalFingerprintBlobName(scope, fingerprint)), scope);
            return value && Date.parse(value.expiresAt || '') > at.getTime() ? value : null;
        },
        async archiveTerminal(scope, record, at = new Date()) {
            const receipt = terminalReceipt(scope, record, at);
            const operationBlob = container.getBlockBlobClient(terminalOperationBlobName(scope, record.operationId));
            const payload = JSON.stringify(receipt);
            try {
                await operationBlob.upload(payload, Buffer.byteLength(payload), {
                    conditions: { ifNoneMatch: '*' },
                    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
                });
            } catch (error) {
                if (!isConflict(error)) throw storageError(error);
                const prior = await readOptionalJson(operationBlob, scope);
                assertSameTerminalReceipt(prior, receipt);
            }
            await writeLatestFingerprintReceipt(
                container.getBlockBlobClient(terminalFingerprintBlobName(scope, record.fingerprint)),
                receipt,
                leaseSeconds,
                scope
            );
            return receipt;
        },
        async read(scope) {
            const blob = container.getBlockBlobClient(blobName(scope));
            try {
                return normaliseLedger(await downloadJson(blob), scope);
            } catch (error) {
                if (isNotFound(error)) return emptyLedger(scope);
                throw storageError(error);
            }
        },
        async update(scope, mutator) {
            const blob = container.getBlockBlobClient(blobName(scope));
            await ensureBlob(blob, emptyLedger(scope));
            const leaseClient = blob.getBlobLeaseClient(crypto.randomUUID());
            try {
                await leaseClient.acquireLease(leaseSeconds);
            } catch (error) {
                if (isConflict(error)) throw fenceError(409, 'Another provider operation is in progress', 'provider_operation_lease_held');
                throw storageError(error);
            }
            let renewalFailure = null;
            const renewal = setInterval(() => {
                leaseClient.renewLease().catch((error) => { renewalFailure = error; });
            }, Math.max(5000, Math.floor(leaseSeconds * 500)));
            if (typeof renewal.unref === 'function') renewal.unref();
            try {
                const ledger = normaliseLedger(await downloadJson(blob, leaseClient.leaseId), scope);
                const result = await mutator(ledger);
                if (renewalFailure) throw renewalFailure;
                ledger.revision = Number(ledger.revision || 0) + 1;
                assertHotLedgerBounds(ledger);
                const payload = JSON.stringify(ledger);
                await blob.upload(payload, Buffer.byteLength(payload), {
                    conditions: { leaseId: leaseClient.leaseId },
                    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
                });
                return result;
            } catch (error) {
                if (error instanceof ProviderOperationFenceError) throw error;
                throw storageError(error);
            } finally {
                clearInterval(renewal);
                await leaseClient.releaseLease().catch(() => {});
            }
        }
    };
}

function invalidStore(provider) {
    return {
        status: () => ({
            provider,
            configured: false,
            durable: false,
            crossInstanceExclusive: false,
            leaseRenewal: false,
            immutableOperationBinding: false,
            terminalReceiptArchive: false,
            boundedDuplicateIntentIndex: false,
            state: 'invalid_configuration'
        }),
        async read() { throw fenceError(503, 'The provider operation fence is not configured', 'provider_operation_fence_not_configured'); },
        async update() { throw fenceError(503, 'The provider operation fence is not configured', 'provider_operation_fence_not_configured'); }
    };
}

async function ensureBlob(blob, ledger) {
    const payload = JSON.stringify(ledger);
    try {
        await blob.upload(payload, Buffer.byteLength(payload), {
            conditions: { ifNoneMatch: '*' },
            blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
        });
    } catch (error) {
        if (!isConflict(error)) throw storageError(error);
    }
}

async function downloadJson(blob, leaseId) {
    const response = await blob.download(0, undefined, leaseId ? { conditions: { leaseId } } : undefined);
    const text = await streamToText(response.readableStreamBody);
    return JSON.parse(text || '{}');
}

async function readOptionalJson(blob, scope) {
    try {
        const value = await downloadJson(blob);
        assertTerminalScope(value, scope);
        return value;
    } catch (error) {
        if (isNotFound(error)) return null;
        if (error instanceof ProviderOperationFenceError) throw error;
        throw storageError(error);
    }
}

async function writeLatestFingerprintReceipt(blob, receipt, leaseSeconds, scope) {
    const payload = JSON.stringify(receipt);
    try {
        await blob.upload(payload, Buffer.byteLength(payload), {
            conditions: { ifNoneMatch: '*' },
            blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
        });
        return;
    } catch (error) {
        if (!isConflict(error)) throw storageError(error);
    }
    const leaseClient = blob.getBlobLeaseClient(crypto.randomUUID());
    try {
        await leaseClient.acquireLease(leaseSeconds);
        const prior = await downloadJson(blob, leaseClient.leaseId);
        assertTerminalScope(prior, scope);
        if (Date.parse(prior.completedAt || '') >= Date.parse(receipt.completedAt || '')) return;
        await blob.upload(payload, Buffer.byteLength(payload), {
            conditions: { leaseId: leaseClient.leaseId },
            blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
        });
    } catch (error) {
        if (error instanceof ProviderOperationFenceError) throw error;
        throw storageError(error);
    } finally {
        await leaseClient.releaseLease().catch(() => {});
    }
}

async function streamToText(stream) {
    if (!stream) return '';
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > 8 * 1024 * 1024) {
            throw fenceError(500, 'Stored provider operation data is too large', 'provider_operation_storage_invalid');
        }
        chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    return body.toString('utf8');
}

function operationScope(input) {
    const tenantId = cleanIdentifier(input.tenantId, 180);
    const customerId = cleanIdentifier(input.customerId, 180);
    const providerScopeId = cleanIdentifier(input.providerScopeId, 180);
    const providerIdentitySha256 = cleanActorHash(input.providerIdentitySha256);
    const companyId = parseCanonicalProviderId(input.companyId);
    if (
        !tenantId || !customerId || !providerScopeId || !providerIdentitySha256 ||
        !companyId
    ) {
        throw fenceError(
            400,
            'An exact tenant, customer, company and provider identity scope is required',
            'provider_operation_scope_required'
        );
    }
    return {
        tenantHash: sha256(tenantId),
        customerHash: sha256(customerId),
        providerScopeHash: sha256(providerScopeId),
        providerIdentitySha256,
        companyHash: sha256(companyId),
        providerScopeId,
        companyId,
        key: sha256(`${tenantId}\u0000${customerId}\u0000${companyId}\u0000${providerScopeId}\u0000${providerIdentitySha256}`)
    };
}

function emptyLedger(scope) {
    return {
        schemaVersion: SCHEMA_VERSION,
        scopeKey: scope.key,
        revision: 0,
        operations: {},
        operationTombstones: {},
        resourceLocks: {},
        repeatConfirmations: {},
        audit: []
    };
}

function normaliseLedger(value, scope) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.scopeKey !== scope.key) {
        throw fenceError(500, 'Stored provider operation data is invalid', 'provider_operation_storage_invalid');
    }
    return {
        schemaVersion: SCHEMA_VERSION,
        scopeKey: scope.key,
        revision: Number(value.revision || 0),
        operations: value.operations && typeof value.operations === 'object' && !Array.isArray(value.operations) ? value.operations : {},
        operationTombstones: value.operationTombstones && typeof value.operationTombstones === 'object' && !Array.isArray(value.operationTombstones)
            ? value.operationTombstones
            : {},
        resourceLocks: value.resourceLocks && typeof value.resourceLocks === 'object' && !Array.isArray(value.resourceLocks)
            ? value.resourceLocks
            : {},
        repeatConfirmations: value.repeatConfirmations && typeof value.repeatConfirmations === 'object' && !Array.isArray(value.repeatConfirmations)
            ? value.repeatConfirmations
            : {},
        audit: Array.isArray(value.audit) ? value.audit : []
    };
}

function publicReservation(record, disposition) {
    return {
        operationId: record.operationId,
        status: record.status,
        disposition,
        repeatedFromOperationId: record.repeatedFromOperationId || '',
        result: record.status === 'completed' ? clone(record.result) : undefined,
        steps: clone(record.steps || {})
    };
}

function publicStep(step) {
    return {
        status: step.status,
        attempt: Number(step.attempt || 0),
        checkpoint: clone(step.checkpoint || null)
    };
}

function assertSameOperation(existing, operationType, fingerprint) {
    if (existing.operationType !== operationType || existing.fingerprint !== fingerprint) {
        throw fenceError(409, 'The operation ID is already bound to different request details', 'operation_id_reused');
    }
}

function assertOptionalActorBinding(record, input) {
    if (input.requireActorMatch !== true) return;
    const actorSubjectSha256 = cleanActorHash(input.actorSubjectSha256);
    const requesterEmailSha256 = cleanActorHash(input.requesterEmailSha256);
    if (
        !actorSubjectSha256 || !requesterEmailSha256 ||
        record.actorSubjectSha256 !== actorSubjectSha256 || record.requesterEmailSha256 !== requesterEmailSha256
    ) {
        throw fenceError(404, 'Provider operation not found', 'provider_operation_not_found');
    }
}

function appendAudit(ledger, record, action, date, details) {
    const prior = ledger.audit[ledger.audit.length - 1];
    const event = {
        id: crypto.randomUUID(),
        at: date.toISOString(),
        operationId: record.operationId,
        operationType: record.operationType,
        actorSubjectSha256: record.actorSubjectSha256 || record.actorHash || '',
        requesterEmailSha256: record.requesterEmailSha256 || record.requesterEmailHash || '',
        intakeChannel: record.intakeChannel || '',
        noteMessageSha256: record.noteMessageSha256 || '',
        noteOrigin: record.noteOrigin || '',
        action,
        details: safeCheckpoint(details),
        previousHash: prior && prior.integritySha256 || ''
    };
    event.integritySha256 = sha256(JSON.stringify(event));
    ledger.audit.push(event);
    if (ledger.audit.length > MAX_AUDIT) ledger.audit = ledger.audit.slice(-MAX_AUDIT);
}

function compactOperationLedger(ledger, maximum = MAX_OPERATIONS) {
    if (Object.keys(ledger.operations).length > maximum) {
        throw fenceError(503, 'Too many provider operations still require reconciliation', 'provider_operation_reconciliation_capacity');
    }
}

function assertRepeatConfirmationCapacity(ledger) {
    const confirmations = ledger.repeatConfirmations && typeof ledger.repeatConfirmations === 'object'
        ? ledger.repeatConfirmations
        : {};
    if (
        Object.keys(confirmations).length >= MAX_REPEAT_CONFIRMATIONS ||
        Buffer.byteLength(JSON.stringify(confirmations), 'utf8') >= MAX_REPEAT_CONFIRMATION_BYTES
    ) {
        throw fenceError(503, 'Too many repeat confirmations are awaiting expiry', 'provider_repeat_confirmation_capacity');
    }
}

function assertHotLedgerBounds(ledger) {
    const bytes = Buffer.byteLength(JSON.stringify(ledger), 'utf8');
    if (bytes > MAX_HOT_LEDGER_BYTES) {
        throw fenceError(503, 'The provider operation ledger requires reconciliation before more writes', 'provider_operation_ledger_capacity');
    }
}

function pruneRepeatConfirmations(ledger, date) {
    const at = date.getTime();
    for (const [operationId, confirmation] of Object.entries(ledger.repeatConfirmations || {})) {
        const expiry = Date.parse(confirmation && confirmation.expiresAt || '');
        const consumed = Date.parse(confirmation && confirmation.consumedAt || '');
        if ((Number.isFinite(expiry) && expiry <= at) || (Number.isFinite(consumed) && consumed + REPEAT_TOKEN_TTL_MS <= at)) {
            delete ledger.repeatConfirmations[operationId];
        }
    }
}

function safeCheckpoint(value) {
    if (value == null) return null;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw fenceError(400, 'The provider checkpoint is too large', 'provider_checkpoint_too_large');
    const parsed = JSON.parse(text);
    rejectSensitiveKeys(parsed);
    return parsed;
}

function safeResult(value) {
    return safeCheckpoint(value == null ? {} : value);
}

function rejectSensitiveKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (/(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|connection[_-]?string)/i.test(key)) {
            throw fenceError(400, 'Sensitive data cannot be stored in a provider checkpoint', 'provider_checkpoint_sensitive');
        }
        rejectSensitiveKeys(child);
    }
}

function normaliseFingerprint(value) {
    if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) return value;
    return sha256(canonicalJson(value == null ? {} : value));
}

function canonicalJson(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function requireOperationId(value) {
    const id = cleanText(value, 180);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/.test(id)) throw fenceError(400, 'A stable operation ID is required', 'operation_id_required');
    return id;
}

function requireOperationType(value) {
    const type = cleanIdentifier(value, 80);
    if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(type)) throw fenceError(400, 'A valid provider operation type is required', 'operation_type_required');
    return type;
}

function requireStepName(value) {
    const name = cleanIdentifier(value, 80);
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(name)) throw fenceError(400, 'A valid provider step is required', 'provider_step_invalid');
    return name;
}

function cleanCode(value) {
    const code = cleanIdentifier(value, 120);
    return /^[a-z][a-z0-9_.-]{1,119}$/.test(code) ? code : 'provider_operation_failed';
}

function cleanResourceKey(value) {
    const key = cleanIdentifier(value, 180);
    if (!key) return '';
    if (!/^[a-z][a-z0-9:._-]{2,179}$/.test(key)) throw fenceError(400, 'A valid provider resource key is required', 'provider_resource_key_invalid');
    return key;
}

function cleanProviderTargetKey(value) {
    const key = String(value || '').trim().toLowerCase();
    if (
        !/^(?:ticket-operation:[a-f0-9]{64}|ticket-note:[1-9][0-9]{0,15}:[a-f0-9]{64})$/.test(key)
    ) return '';
    return key;
}

function providerAbsenceReady(step, observation, expectedAttempt, providerTargetKey, providerEvidenceRef) {
    const startedAt = Date.parse(step && step.startedAt || '');
    const firstObservedAt = Date.parse(observation && observation.firstObservedAt || '');
    const lastObservedAt = Date.parse(observation && observation.lastObservedAt || '');
    return Boolean(
        observation && Number(observation.attempt || 0) === expectedAttempt && Number(observation.count || 0) >= 2 &&
        observation.providerTargetKey === providerTargetKey &&
        observation.lastProviderEvidenceRef === providerEvidenceRef &&
        Number.isFinite(startedAt) && Number.isFinite(firstObservedAt) && Number.isFinite(lastObservedAt) &&
        firstObservedAt >= startedAt &&
        lastObservedAt - startedAt >= PROVIDER_ABSENCE_SETTLEMENT_MS &&
        lastObservedAt - firstObservedAt >= PROVIDER_ABSENCE_SETTLEMENT_MS
    );
}

function resolveAbsentStep(
    ledger,
    record,
    step,
    prior,
    expectedAttempt,
    providerEvidenceRef,
    operatorEvidenceRef,
    resolverSubjectSha256,
    atDate
) {
    const at = atDate.toISOString();
    record.steps[step] = Object.assign({}, prior, {
        status: 'known_absent',
        updatedAt: at,
        failureCode: 'provider_absence_manually_confirmed'
    });
    const partialApplied = Object.entries(record.steps || {}).some(([name, value]) => (
        name !== step && value.status === 'applied'
    ));
    record.status = partialApplied ? 'partial_applied' : 'pending';
    record.updatedAt = at;
    appendAudit(ledger, record, 'operation.step_absence_resolved', atDate, {
        step,
        attempt: expectedAttempt,
        providerEvidenceRef,
        operatorEvidenceRef,
        providerTargetKey: prior.absenceObservation && prior.absenceObservation.providerTargetKey || '',
        resolverSubjectSha256
    });
}

function cleanActorHash(value) {
    const hash = String(value || '').trim().toLowerCase();
    if (!hash) return '';
    if (!/^[a-f0-9]{64}$/.test(hash)) throw fenceError(400, 'A valid server-derived actor reference is required', 'provider_actor_reference_invalid');
    return hash;
}

function cleanSha256(value) {
    const hash = String(value || '').trim().toLowerCase();
    if (!hash) return '';
    if (!/^[a-f0-9]{64}$/.test(hash)) throw fenceError(400, 'A valid provider message fingerprint is required', 'provider_message_fingerprint_invalid');
    return hash;
}

function cleanNoteOrigin(value) {
    const origin = cleanIdentifier(value, 40);
    if (!origin) return '';
    if (!NOTE_ORIGINS.has(origin)) throw fenceError(400, 'A valid provider note origin is required', 'provider_note_origin_invalid');
    return origin;
}

function cleanEvidenceReference(value) {
    const reference = cleanText(value, 240);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,239}$/.test(reference) || /(?:token|secret|password|credential)=/i.test(reference)) return '';
    return reference;
}

function cleanToken(value) {
    const token = String(value || '').trim();
    return /^[A-Za-z0-9_-]{32,200}$/.test(token) ? token : '';
}

function hashToken(value) { return sha256(String(value || '')); }
function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function blobName(scope) {
    return `operations/${scope.tenantHash}/${scope.providerScopeHash}/${scope.providerIdentitySha256}/${scope.customerHash}/${scope.companyHash}.json`;
}
function operationIdentityBlobName(scope, operationId) {
    return `operation-identities/${scope.tenantHash}/${scope.customerHash}/${sha256(operationId)}.json`;
}
function terminalOperationBlobName(scope, operationId) {
    return `operation-receipts/${scope.tenantHash}/${scope.customerHash}/${sha256(operationId)}.json`;
}
function terminalFingerprintBlobName(scope, fingerprint) {
    return `intent-index/${scope.tenantHash}/${scope.providerScopeHash}/${scope.providerIdentitySha256}/${scope.customerHash}/${scope.companyHash}/${fingerprint}.json`;
}
function operationIdentityKey(scope, operationId) {
    return `${scope.tenantHash}:${scope.customerHash}:${sha256(operationId)}`;
}
function operationIdentityRecord(scope, binding) {
    return {
        schemaVersion: 1,
        scopeKey: scope.key,
        operationId: binding.operationId,
        operationType: binding.operationType,
        fingerprint: binding.fingerprint
    };
}
function terminalFingerprintKey(scope, fingerprint) { return `${scope.key}:${fingerprint}`; }
function terminalReceipt(scope, record, at = new Date()) {
    if (!record || record.status !== 'completed') {
        throw fenceError(409, 'Only a completed operation can be archived', 'provider_operation_terminal_receipt_invalid');
    }
    const completedAt = normaliseDate(record.completedAt) || at.toISOString();
    return {
        schemaVersion: 1,
        scopeKey: scope.key,
        operationId: record.operationId,
        operationType: record.operationType,
        fingerprint: record.fingerprint,
        status: 'completed',
        actorSubjectSha256: record.actorSubjectSha256 || '',
        requesterEmailSha256: record.requesterEmailSha256 || '',
        intakeChannel: record.intakeChannel || '',
        noteMessageSha256: record.noteMessageSha256 || '',
        noteOrigin: record.noteOrigin || '',
        resourceKey: record.resourceKey || '',
        noteReceipt: terminalNoteReceipt(record),
        repeatedFromOperationId: record.repeatedFromOperationId || '',
        result: safeResult(record.result),
        createdAt: normaliseDate(record.createdAt),
        completedAt,
        expiresAt: new Date(Date.parse(completedAt) + DUPLICATE_INTENT_WINDOW_MS).toISOString()
    };
}
function terminalNoteReceipt(record) {
    const stepName = record.operationType === 'autotask.ticket.create'
        ? 'original_request_note'
        : record.operationType === 'autotask.ticket.reply' ? 'reply_note' : 'status_note';
    const step = record.steps && record.steps[stepName];
    const noteId = parseCanonicalProviderId(step && step.status === 'applied' && step.checkpoint && step.checkpoint.noteId);
    const createdTicket = record.steps && record.steps.ticket_create && record.steps.ticket_create.checkpoint;
    const resultTicket = record.result && record.result.ticketReceipt;
    const resourceTicket = String(record.resourceKey || '').match(/^ticket:([1-9][0-9]*)$/);
    const ticketId = parseCanonicalProviderId(
        createdTicket && createdTicket.ticketId || resultTicket && resultTicket.ticketId || resourceTicket && resourceTicket[1]
    );
    return noteId && ticketId ? { step: stepName, ticketId, noteId } : null;
}
function assertTerminalScope(value, scope) {
    if (!value || value.schemaVersion !== 1 || value.scopeKey !== scope.key || value.status !== 'completed') {
        throw fenceError(500, 'The archived provider operation receipt is invalid', 'provider_operation_terminal_receipt_invalid');
    }
}
function assertSameTerminalReceipt(prior, expected) {
    if (canonicalJson(prior) !== canonicalJson(expected)) {
        throw fenceError(409, 'The archived provider operation receipt does not match', 'provider_operation_terminal_receipt_conflict', {
            operationId: expected.operationId
        });
    }
    return clone(prior);
}
function normaliseDate(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function assertOperationIdentity(prior, expected) {
    if (
        !prior || prior.schemaVersion !== expected.schemaVersion || prior.scopeKey !== expected.scopeKey ||
        prior.operationId !== expected.operationId || prior.operationType !== expected.operationType ||
        prior.fingerprint !== expected.fingerprint
    ) {
        throw fenceError(409, 'The operation ID is bound to a different provider identity or request', 'provider_operation_scope_rebound', {
            operationId: expected.operationId
        });
    }
    return clone(prior);
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function cleanStorageName(value) {
    const name = String(value || '').trim().toLowerCase();
    return /^[a-z0-9]{3,24}$/.test(name) ? name : '';
}

function cleanContainerName(value) {
    const name = String(value || '').trim().toLowerCase();
    return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(name) ? name : '';
}

function cleanText(value, maximum) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

function cleanIdentifier(value, maximum) { return cleanText(value, maximum).toLowerCase(); }
function positiveInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
function isNotFound(error) { return Number(error && (error.statusCode || error.status)) === 404; }
function isConflict(error) { return [409, 412].includes(Number(error && (error.statusCode || error.status))); }
function storageError(error) {
    if (error instanceof ProviderOperationFenceError) return error;
    return fenceError(503, 'The durable provider operation fence is unavailable', 'provider_operation_storage_unavailable');
}
function fenceError(statusCode, message, code, details) {
    return new ProviderOperationFenceError(statusCode, message, code, details);
}

module.exports = {
    ProviderOperationFenceError,
    canonicalJson,
    compactOperationLedger,
    createAzureFenceStore,
    createMemoryFenceStore,
    createProviderOperationFence,
    normaliseFingerprint,
    parseCanonicalProviderId
};
