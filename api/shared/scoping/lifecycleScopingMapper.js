const { CONTEXT_FIELDS } = require('../lifecycle/lifecycleModel');
const {
    getAssessmentBlueprint,
    isQuestionVisible
} = require('../salesBlueprint');

const UNKNOWN_VALUES = new Set(['unknown', 'undecided', 'unsure']);

function buildLifecycleScopingPreview(organisation, salesState = {}) {
    if (!organisation || !organisation.organisationId) {
        throw new Error('A lifecycle organisation is required');
    }

    const blueprint = getAssessmentBlueprint();
    const questionMap = new Map(blueprint.questions.map((question) => [question.id, question]));
    const knownFacts = collectKnownFacts(organisation);
    const answerBuilder = createAnswerBuilder(questionMap);
    const context = organisation.context || {};

    addBusinessContext(answerBuilder, context);
    addEstateAnswers(answerBuilder, context);
    addSupportAnswers(answerBuilder, context);
    addSecurityAnswers(answerBuilder, context);
    addOperationsContext(answerBuilder, context);
    addTimingAnswer(answerBuilder, context);
    addNextActionContext(answerBuilder, organisation);

    const answers = answerBuilder.answers;
    const questionGaps = blueprint.questions
        .filter((question) => isQuestionVisible(question, answers))
        .filter((question) => !answerHasKnownValue(answers[question.id]))
        .map((question) => ({
            questionId: question.id,
            section: question.section,
            prompt: question.prompt,
            status: 'unknown'
        }));

    const customers = Array.isArray(salesState.customers) ? salesState.customers : [];
    const assessments = Array.isArray(salesState.assessments) ? salesState.assessments : [];
    const linkedCustomer = findLinkedCustomer(customers, organisation);
    const linkedAssessment = findLinkedAssessment(assessments, organisation);
    const companyName = knownText(organisation, 'company.name') || organisation.displayName || 'New website prospect';
    const candidateCustomers = customers
        .filter((customer) => !linkedCustomer || customer.id !== linkedCustomer.id)
        .filter((customer) => normaliseName(customer.name) === normaliseName(companyName))
        .slice(0, 10)
        .map((customer) => ({
            id: customer.id,
            name: customer.name,
            lifecycleOrganisationId: customer.lifecycleOrganisationId || ''
        }));

    return {
        organisationId: organisation.organisationId,
        displayName: companyName,
        lifecycleState: organisation.lifecycleState,
        discoverySummary: organisation.discovery && organisation.discovery.summary || '',
        knownFacts,
        missingContextFields: Array.isArray(organisation.discovery && organisation.discovery.missingFields)
            ? organisation.discovery.missingFields
            : [],
        answers,
        mappedQuestions: answerBuilder.mappings,
        questionGaps,
        candidateCustomers,
        linked: linkedCustomer ? {
            customerId: linkedCustomer.id,
            customerName: linkedCustomer.name,
            assessmentId: linkedAssessment && linkedAssessment.id || organisation.scope && organisation.scope.assessmentId || ''
        } : null
    };
}

function createAssessmentPrefill(preview, options = {}) {
    const at = options.at || new Date().toISOString();
    return {
        source: 'lifecycle_discovery',
        status: 'confirmed',
        organisationId: preview.organisationId,
        importedAt: at,
        importedBy: String(options.actorEmail || '').slice(0, 254),
        knownFactCount: preview.knownFacts.length,
        mappedQuestionIds: preview.mappedQuestions.filter((mapping) => mapping.hasKnownValue).map((mapping) => mapping.questionId),
        contextNoteQuestionIds: preview.mappedQuestions.filter((mapping) => !mapping.hasKnownValue).map((mapping) => mapping.questionId),
        gapQuestionIds: preview.questionGaps.map((gap) => gap.questionId),
        unknownContextFields: preview.missingContextFields.map((field) => field.field),
        lastSyncedAt: at
    };
}

function mergePrefillAnswers(existingAnswers, prefillAnswers) {
    const merged = Object.assign({}, existingAnswers || {});
    Object.entries(prefillAnswers || {}).forEach(([questionId, incoming]) => {
        const existing = merged[questionId];
        if (!existing) {
            merged[questionId] = incoming;
            return;
        }
        if (!answerHasKnownValue(existing) && answerHasKnownValue(incoming)) {
            merged[questionId] = Object.assign({}, incoming, {
                notes: joinNotes(existing.notes, incoming.notes),
                internalNotes: joinNotes(existing.internalNotes, incoming.internalNotes)
            });
            return;
        }
        merged[questionId] = Object.assign({}, existing, {
            notes: joinNotes(existing.notes, incoming.notes),
            evidence: existing.evidence || incoming.evidence,
            internalNotes: joinNotes(existing.internalNotes, incoming.internalNotes)
        });
    });
    return merged;
}

function collectKnownFacts(organisation) {
    const fieldStates = organisation.fieldStates || {};
    const context = organisation.context || {};
    return CONTEXT_FIELDS.flatMap((definition) => {
        const state = fieldStates[definition.path];
        const value = contextValue(context, definition.path);
        if (!state || state.status !== 'known' || !hasValue(value)) return [];
        return [{
            field: definition.path,
            label: definition.label,
            value,
            displayValue: displayValue(value),
            source: state.source || 'unknown',
            certainty: state.certainty || 'unknown'
        }];
    });
}

function addBusinessContext(builder, context) {
    const reason = valueAt(context, 'company.summary');
    if (reason) {
        builder.addNote('business.concerns', `Website discovery reason: ${reason}`, ['company.summary']);
        builder.addNote('business.priorities', `Use the stated reason to confirm what a better service should achieve: ${reason}`, ['company.summary']);
    }
    const concerns = arrayAt(context, 'security.concerns');
    const frustrations = arrayAt(context, 'support.frustrations');
    if (concerns.length || frustrations.length) {
        builder.addNote(
            'business.concerns',
            `Earlier concerns and support frustrations: ${concerns.concat(frustrations).join(' | ')}`,
            ['security.concerns', 'support.frustrations']
        );
    }
}

function addEstateAnswers(builder, context) {
    addCountBucket(builder, 'estate.users', valueAt(context, 'users.estimatedCount'), 'users.estimatedCount', 'users');
    addCountBucket(builder, 'estate.endpoints', valueAt(context, 'endpoints.estimatedCount'), 'endpoints.estimatedCount', 'managed devices');

    const locations = arrayAt(context, 'locations.items');
    if (locations.length) {
        const count = locations.length;
        let value = 'one';
        if (count >= 6) value = 'six_plus';
        else if (count >= 4) value = 'four_five';
        else if (count >= 2) value = 'two_three';
        builder.addValue('estate.locations', value, `Earlier discovery identified ${count} location${count === 1 ? '' : 's'}: ${locations.join(', ')}`, ['locations.items']);
    }

    const platform = String(valueAt(context, 'productivity.platform') || '').trim();
    if (['microsoft_365', 'google_workspace', 'mixed', 'other'].includes(platform)) {
        builder.addValue('productivity.platform', platform, `Earlier discovery recorded ${displayValue(platform)}.`, ['productivity.platform']);
    }

    const applications = arrayAt(context, 'applications.important');
    if (applications.length) {
        builder.addValue('applications.critical', applications.join(', '), 'Important applications captured during website discovery.', ['applications.important']);
    }
}

function addSupportAnswers(builder, context) {
    const providerModel = String(valueAt(context, 'itProvider.model') || '').trim();
    if (['managed_provider', 'internal', 'hybrid', 'none'].includes(providerModel)) {
        builder.addValue('support.model', providerModel, 'Current IT support model captured during website discovery.', ['itProvider.model']);
    }

    const supportRequirements = valueAt(context, 'support.requirements');
    if (supportRequirements) {
        builder.addNote('support.hours', `Earlier support requirement: ${supportRequirements}`, ['support.requirements']);
        builder.addNote('support.delivery', `Earlier support requirement: ${supportRequirements}`, ['support.requirements']);
    }

    const hours = String(valueAt(context, 'support.hours') || '').trim();
    if (['business_hours', 'extended', '24x7'].includes(hours)) {
        builder.addValue('support.hours', hours, 'Support-hours requirement captured earlier.', ['support.hours']);
    }

    const frustrations = arrayAt(context, 'support.frustrations');
    if (frustrations.length) {
        builder.addNote('support.frustrations', `Earlier support frustrations: ${frustrations.join(' | ')}`, ['support.frustrations']);
    }
}

function addSecurityAnswers(builder, context) {
    const tools = arrayAt(context, 'security.tools');
    if (tools.length) {
        builder.addValue('security.tools', tools.join(', '), 'Security tools captured during website discovery.', ['security.tools']);
        builder.addNote('security.endpoint', `Known tools: ${tools.join(', ')}. Confirm whether coverage is complete and managed.`, ['security.tools']);
        builder.addNote('security.monitoring', `Known tools: ${tools.join(', ')}. Confirm how alerts are monitored and responded to.`, ['security.tools']);
    }
    const concerns = arrayAt(context, 'security.concerns');
    if (concerns.length) {
        builder.addNote('security.endpoint', `Earlier security concerns: ${concerns.join(' | ')}`, ['security.concerns']);
        builder.addNote('resilience.backups', `Earlier security/backup concerns: ${concerns.join(' | ')}`, ['security.concerns']);
    }
}

function addOperationsContext(builder, context) {
    const providerModel = String(valueAt(context, 'itProvider.model') || '').trim();
    const providerName = String(valueAt(context, 'itProvider.name') || '').trim();
    if (providerModel === 'managed_provider' || providerModel === 'hybrid' || providerName) {
        builder.addNote(
            'operations.incumbent_handover',
            `An existing IT provider is recorded${providerName ? ` (${providerName})` : ''}. Confirm whether a formal handover is required.`,
            ['itProvider.model', providerName ? 'itProvider.name' : ''].filter(Boolean)
        );
    }
    const network = valueAt(context, 'network.summary');
    if (network) {
        builder.addNote('operations.suppliers', `Earlier network/environment note: ${network}`, ['network.summary']);
    }
}

function addTimingAnswer(builder, context) {
    const timing = String(valueAt(context, 'commercial.preferredTiming') || '').trim();
    if (!timing) return;
    const lower = timing.toLowerCase();
    let value = '';
    if (/urgent|immediate|as soon|within (?:30|60|90) days|this month|now/.test(lower)) value = 'now';
    else if (/two quarters|six months|6 months|this quarter|next quarter/.test(lower)) value = 'quarter';
    else if (/12 months|one year|within a year|this year/.test(lower)) value = 'year';

    if (value) {
        builder.addValue('priorities.timeframe', value, `Earlier preferred timing: ${timing}`, ['commercial.preferredTiming'], 'medium');
    } else {
        builder.addNote('priorities.timeframe', `Earlier preferred timing: ${timing}. Confirm the closest scoped timeframe.`, ['commercial.preferredTiming']);
    }
}

function addNextActionContext(builder, organisation) {
    const nextAction = organisation.nextAction || {};
    if (!nextAction.detail) return;
    if (nextAction.type === 'human_follow_up') {
        builder.addValue('priorities.next_step', 'human_call', `The prospect requested human contact: ${nextAction.detail}`, [], 'medium');
        return;
    }
    builder.addNote('priorities.next_step', `Earlier suggested next action: ${nextAction.detail}. Confirm the customer's preferred next step.`, []);
}

function addCountBucket(builder, questionId, rawCount, sourceField, label) {
    if (rawCount === null || rawCount === undefined || rawCount === '') return;
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < 0) return;
    let value = 'under_10';
    if (count >= 250) value = '250_plus';
    else if (count >= 100) value = '100_249';
    else if (count >= 50) value = '50_99';
    else if (count >= 25) value = '25_49';
    else if (count >= 10) value = '10_24';
    builder.addValue(questionId, value, `Earlier discovery recorded approximately ${count} ${label}.`, [sourceField]);
}

function createAnswerBuilder(questionMap) {
    const answers = {};
    const mappingByQuestion = new Map();

    function ensure(questionId) {
        if (!questionMap.has(questionId)) return null;
        if (!answers[questionId]) answers[questionId] = answer('', '', '', 'medium');
        if (!mappingByQuestion.has(questionId)) {
            mappingByQuestion.set(questionId, { questionId, sourceFields: [], hasKnownValue: false });
        }
        return answers[questionId];
    }

    function recordSources(questionId, sourceFields, hasKnownValue) {
        const mapping = mappingByQuestion.get(questionId);
        mapping.sourceFields = Array.from(new Set(mapping.sourceFields.concat(sourceFields || [])));
        mapping.hasKnownValue = mapping.hasKnownValue || hasKnownValue;
    }

    return {
        answers,
        get mappings() { return Array.from(mappingByQuestion.values()); },
        addValue(questionId, value, notes, sourceFields, confidence = 'high') {
            const target = ensure(questionId);
            if (!target) return;
            const question = questionMap.get(questionId);
            if (!validQuestionValue(question, value)) return;
            target.value = value;
            target.notes = joinNotes(target.notes, notes);
            target.evidence = evidenceLabel(sourceFields);
            target.confidence = confidence;
            target.internalNotes = joinNotes(target.internalNotes, 'Prefilled from structured lifecycle discovery; operator confirmation required.');
            recordSources(questionId, sourceFields, true);
        },
        addNote(questionId, notes, sourceFields) {
            const target = ensure(questionId);
            if (!target) return;
            target.notes = joinNotes(target.notes, notes);
            target.evidence = target.evidence || evidenceLabel(sourceFields);
            target.internalNotes = joinNotes(target.internalNotes, 'Context only; the scoped answer remains unknown until confirmed.');
            recordSources(questionId, sourceFields, false);
        }
    };
}

function answer(value, notes, evidence, confidence) {
    return { value, notes: notes || '', evidence: evidence || '', importance: 'medium', confidence: confidence || 'medium', internalNotes: '' };
}

function validQuestionValue(question, value) {
    if (!question) return false;
    if (question.type === 'text') return typeof value === 'string' && Boolean(value.trim());
    const allowed = new Set((question.options || []).map((option) => option.value));
    if (question.type === 'multi') return Array.isArray(value) && value.length > 0 && value.every((item) => allowed.has(item));
    return allowed.has(value);
}

function answerHasKnownValue(value) {
    if (!value) return false;
    const values = Array.isArray(value.value) ? value.value : [value.value];
    const populated = values.map((item) => String(item == null ? '' : item).trim()).filter(Boolean);
    return populated.length > 0 && !populated.every((item) => UNKNOWN_VALUES.has(item.toLowerCase()));
}

function findLinkedCustomer(customers, organisation) {
    const linkedId = organisation.links && organisation.links.salesCustomerId || organisation.scope && organisation.scope.salesCustomerId || '';
    return customers.find((customer) => customer.id === linkedId) || customers.find((customer) => customer.lifecycleOrganisationId === organisation.organisationId) || null;
}

function findLinkedAssessment(assessments, organisation) {
    const linkedId = organisation.scope && organisation.scope.assessmentId || '';
    return assessments.find((assessment) => assessment.id === linkedId) || assessments.find((assessment) => (
        assessment.lifecycleOrganisationId === organisation.organisationId || assessment.prefill && assessment.prefill.organisationId === organisation.organisationId
    )) || null;
}

function knownText(organisation, path) {
    const state = organisation.fieldStates && organisation.fieldStates[path];
    const value = valueAt(organisation.context || {}, path);
    return state && state.status === 'known' && typeof value === 'string' ? value : '';
}

function contextValue(context, path) {
    return path.split('.').reduce((value, segment) => value && value[segment], context);
}

function valueAt(context, path) { return contextValue(context, path); }
function arrayAt(context, path) { const value = valueAt(context, path); return Array.isArray(value) ? value.filter(Boolean) : []; }
function hasValue(value) { return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '' && value !== 'unknown'; }
function displayValue(value) { return Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value).replace(/_/g, ' '); }
function evidenceLabel(sourceFields) { return sourceFields && sourceFields.length ? `Structured website discovery: ${sourceFields.join(', ')}` : 'Structured website discovery'; }
function joinNotes(left, right) { return Array.from(new Set([left, right].map((value) => String(value || '').trim()).filter(Boolean))).join('\n'); }
function normaliseName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

module.exports = {
    answerHasKnownValue,
    buildLifecycleScopingPreview,
    createAssessmentPrefill,
    mergePrefillAnswers
};
