'use strict';

const {
    AssessmentDomainError, normaliseAssessmentCommand, normaliseAssessmentSelector,
    assertAssessmentOrganisation, createAssessment, normaliseAssessmentState,
    applyAssessmentCommand, assessmentCommandFingerprint
} = require('./assessmentDomain');

// Deliberately absent from runtime factories. Synthetic, process-local reference only.
// Never evict receipts silently: reaching capacity rejects a new command unchanged.
const REFERENCE_LIMITS = Object.freeze({ assessments: 64, receiptsPerAssessment: 128 });

function createInMemoryAssessmentRepository({ registry } = {}) {
    if (!registry || typeof registry.getProfile !== 'function') throw new AssessmentDomainError('registry_required');
    const entries = new Map();

    return Object.freeze({
        async read(tenantAggregate, selectorInput) {
            const selector = normaliseAssessmentSelector(selectorInput);
            assertAssessmentOrganisation(tenantAggregate, selector);
            const entry = entries.get(scopeKey(selector));
            if (!entry) throw new AssessmentDomainError('not_found', 404);
            return normaliseAssessmentState(entry.state, registry);
        },

        async execute(tenantAggregate, commandInput) {
            const command = normaliseAssessmentCommand(commandInput);
            assertAssessmentOrganisation(tenantAggregate, command, command.action !== 'archive');
            const key = scopeKey(command), entry = entries.get(key);
            const fingerprint = assessmentCommandFingerprint(command);
            const prior = entry?.receipts.get(command.idempotencyKey);
            if (prior) {
                if (prior.commandSha256 !== fingerprint) throw new AssessmentDomainError('idempotency_conflict', 409);
                // Replay the original result, never today's state presented as the old result.
                return Object.freeze({ ...prior, state: normaliseAssessmentState(prior.state, registry), replayed: true });
            }
            if (command.action === 'create' && entry) throw new AssessmentDomainError('already_exists', 409);
            if (command.action !== 'create' && !entry) throw new AssessmentDomainError('not_found', 404);
            if ((!entry && entries.size >= REFERENCE_LIMITS.assessments) ||
                (entry && entry.receipts.size >= REFERENCE_LIMITS.receiptsPerAssessment)) {
                throw new AssessmentDomainError('reference_capacity_reached', 503);
            }
            const state = entry
                ? applyAssessmentCommand(entry.state, tenantAggregate, command, registry)
                : createAssessment(tenantAggregate, command, registry);
            const receipt = Object.freeze({ state, commandSha256: fingerprint, replayed: false });
            const receipts = new Map(entry?.receipts);
            receipts.set(command.idempotencyKey, receipt);
            // This replacement is the sole commit point. No await or mutation of the old
            // entry occurs between the revision check and publishing state plus receipt.
            entries.set(key, Object.freeze({ state, receipts }));
            return receipt;
        }
    });
}

// Adapter-facing contract. A future durable adapter must preserve execute's atomic
// revision/receipt semantics; the service must be called after live access checks.
function createAssessmentLifecycleService({ repository } = {}) {
    if (!repository || typeof repository.read !== 'function' || typeof repository.execute !== 'function') {
        throw new AssessmentDomainError('repository_required');
    }
    return Object.freeze({
        async read(tenantAggregate, selector) {
            return repository.read(tenantAggregate, normaliseAssessmentSelector(selector));
        },
        async execute(tenantAggregate, command) {
            return repository.execute(tenantAggregate, normaliseAssessmentCommand(command));
        }
    });
}

// JSON tuple encoding prevents separator collisions and scopes IDs/receipts together.
function scopeKey(selector) {
    return JSON.stringify([selector.tenantId, selector.organisationId, selector.assessmentId]);
}

module.exports = { REFERENCE_LIMITS, createInMemoryAssessmentRepository, createAssessmentLifecycleService };
