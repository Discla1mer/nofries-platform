(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesNcscQuestionnaire = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const mounted = new WeakMap();
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
    const LIMIT = 65536;
    const SAVE_CEILING = 127;
    const ANSWER_GUIDANCE = {
        yes: 'All parts of this statement are in place across your declared scope.',
        partial: 'Some parts are in place, or only part of your scope is covered. Plans alone do not count.',
        no: 'None of this is in place yet, including when work is only planned.',
        unknown: 'You do not have enough information to confirm what is in place.',
        not_applicable: 'You believe this does not apply to your scope. Explain why; this remains unresolved.'
    };
    // Display aids only. The accepted catalogue still owns each question and
    // answer meaning; these examples neither choose an answer nor prove it.
    const QUESTION_INPUT_GUIDANCE = {
        'NF-NCSC-MCSS-RM-01-Q1': {
            consider: 'Check whether cyber risks are recorded with your other business risks, what level of risk is acceptable, who is responsible, and when risks are reviewed.',
            example: 'Cyber risks have named owners in a register, but no agreed tolerance or regular review. This matches Partial.'
        },
        'NF-NCSC-MCSS-SA-01-Q1': {
            consider: 'Think about security guidance given when people join, updates for their role, and how leaders hear about participation or results.',
            example: 'New starters receive security guidance, but there are no role-specific updates or reports to leadership. This matches Partial.'
        },
        'NF-NCSC-MCSS-AI-01-Q1': {
            consider: 'Check your lists of important devices, software, cloud services and data. Are they up to date, with a responsible owner and support or retirement status for each?',
            example: 'A current register lists hardware, software, cloud services and data, with an owner and lifecycle status for each. If it covers your full declared scope, this matches Yes.'
        },
        'NF-NCSC-MCSS-SC-01-Q1': {
            consider: 'Check whether a standard set of safer settings is applied to new systems and those already in use. When software changes, are exceptions reviewed?',
            example: 'A settings checklist is planned, but no secure settings have been applied. Plans alone match No.'
        },
        'NF-NCSC-MCSS-PA-01-Q1': {
            consider: 'Think through how updates are prioritised, obtained, tested, installed and checked. Include how a failed update is reversed and unsupported systems are retired.',
            example: 'Nobody can confirm how software updates are managed. This matches Unknown until you have enough information to answer.'
        },
        'NF-NCSC-MCSS-MF-01-Q1': {
            consider: 'Multi-factor authentication (MFA) means proving your identity in more than one way. Check that it is required for important systems, internet-facing access, administrators and relevant suppliers, and that failed attempts are reviewed.',
            example: 'Administrators must use MFA, but some important services still accept a password alone. This matches Partial.'
        },
        'NF-NCSC-MCSS-DU-01-Q1': {
            consider: 'Check whether important and internet-facing systems send useful activity records to one place, someone reviews them, and alerts lead to action.',
            example: 'Logs are collected centrally, but nobody reviews them or responds to alerts. This matches Partial.'
        },
        'NF-NCSC-MCSS-LP-01-Q1': {
            consider: 'Think about who can access each system and why. Include separate administrator accounts, access changes when people join, change roles or leave, and regular reviews.',
            example: 'Administrator accounts are separate, but access is not reviewed and leavers are removed inconsistently. This matches Partial.'
        },
        'NF-NCSC-MCSS-DR-01-Q1': {
            consider: 'Check which important systems and data are backed up, what the business needs to recover, how copies are protected, and whether sample restores have been tested.',
            example: 'Protected backups run successfully, but no sample restore has been tested. This matches Partial; a successful backup job alone does not show that recovery works.'
        },
        'NF-NCSC-MCSS-RP-01-Q1': {
            consider: 'Think about your plan for likely cyber incidents: who does what, management support, who to contact, and changes made after exercises or real incidents.',
            example: 'An incident plan names responders, but contact paths are missing and lessons from exercises are not used. This matches Partial.'
        },
        'NF-NCSC-CC-PM-01-Q1': {
            consider: 'Check whether the organisation manages a password manager, sets rules for sharing, and confirms that people use unique passwords through it.',
            example: 'A managed password tool is provided, but most people still reuse passwords. This matches Partial.'
        },
        'NF-NCSC-CC-SV-01-Q1': {
            consider: 'Think about requests to change payments, sign-in details, account recovery or sensitive data. Is the request checked through a trusted route separate from the original message?',
            example: 'Payment changes are checked using a known phone number, but password and MFA resets are not independently checked. This matches Partial.'
        },
        'NF-NCSC-CC-AC-01-Q1': {
            consider: 'Check what prevents unapproved or risky programs, scripts, macros and files from running on systems where they could cause serious harm.',
            example: 'Nobody can confirm whether risky applications or macros are restricted. This matches Unknown until you can check what is enforced.'
        },
        'NF-NCSC-CC-NS-01-Q1': {
            consider: 'Check how guest users, everyday users, administrators, backups and important services are kept apart, so a compromised account or device cannot freely reach the others.',
            example: 'Guest Wi-Fi is separate, but everyday user devices can freely reach backup and administration systems. This matches Partial.'
        }
    };
    const PROFILE_FIELDS = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
    function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function profileMatches(value, expected) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== PROFILE_FIELDS.length) return false;
        return PROFILE_FIELDS.every(function (key) {
            const field = Object.getOwnPropertyDescriptor(value, key);
            return field && field.enumerable === true && Object.prototype.hasOwnProperty.call(field, 'value') && field.value === expected[key];
        });
    }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function textProblem(value) {
        if (typeof value !== 'string' || !value.trim()) return 'blank';
        if (value.length > 4000) return 'length';
        for (let i = 0; i < value.length; i += 1) {
            const unit = value.charCodeAt(i);
            if (unit === 0 || unit >= 0xdc00 && unit <= 0xdfff) return 'character';
            if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = value.charCodeAt(++i);
                if (!(next >= 0xdc00 && next <= 0xdfff)) return 'character';
            }
        }
        return null;
    }
    function validText(value) { return textProblem(value) === null; }
    function textError(value, scope) {
        const problem = textProblem(value), label = scope ? 'scope' : 'explanation';
        if (problem === 'blank') return scope ? 'Enter the assessment scope.' : 'Explain why this does not apply.';
        if (problem === 'length') return 'Shorten the ' + label + ' to 4,000 characters or fewer. Some emoji count as two.';
        return 'Re-enter the ' + label + ' to remove an unsupported character.';
    }
    function answer(response) {
        return { itemId: response.itemId, optionId: response.optionId, rationale: response.rationale === null ? null : { text: response.rationale.text } };
    }
    // Presentation only: never calculate or repair a server score in the browser.
    // A malformed result does not invalidate an acknowledged write or its answers.
    function resultModel(assessment, metadata, organisationId) {
        try {
            const submission = assessment.submission, value = submission.evaluation;
            const provenance = value.provenance;
            function requireValue(condition) { if (!condition) throw new Error('ncsc_results_unavailable'); }
            function text(value) { requireValue(typeof value === 'string' && value.length > 0 && value.length <= 4000); return value; }
            function digest(value) { requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value; }
            function count(value) { requireValue(Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)); return value; }
            function percent(value, display) {
                if (value === null) { requireValue(display === null); return 'Not scored'; }
                count(value); requireValue(value <= 1000 && display === (value / 10).toFixed(1) + '%'); return display;
            }
            function range(source) {
                requireValue(source && ['scored', 'not_scored'].includes(source.status));
                if (source.status === 'not_scored') {
                    requireValue(source.lowerPercentTenths === null && source.upperPercentTenths === null && source.lowerDisplay === null && source.upperDisplay === null);
                    return 'Not scored';
                }
                requireValue(source.lowerPercentTenths !== null && source.upperPercentTenths !== null && source.lowerPercentTenths <= source.upperPercentTenths);
                const lower = percent(source.lowerPercentTenths, source.lowerDisplay), upper = percent(source.upperPercentTenths, source.upperDisplay);
                return lower === upper ? lower : lower + '–' + upper;
            }
            function coverage(source) {
                count(source.numerator); count(source.denominator); requireValue(source.numerator <= source.denominator);
                requireValue((source.denominator === 0) === (source.percentTenths === null));
                return percent(source.percentTenths, source.display);
            }
            function indexed(rows, key, expected) {
                requireValue(Array.isArray(rows) && rows.length === expected.length);
                const index = new Map(rows.map(row => [row[key], row]));
                requireValue(index.size === expected.length && expected.every(row => index.has(row.id))); return index;
            }
            requireValue(assessment.status === 'submitted' && value.schemaVersion === 1 && value.status === value.attainment.status &&
                submission.revision === assessment.revision && submission.submittedAt === assessment.updatedAt &&
                provenance.assessmentId === assessment.assessmentId && provenance.moduleId === metadata.moduleId &&
                typeof organisationId === 'string' && organisationId.trim().length > 0 && provenance.organisationId === organisationId &&
                provenance.assessmentRevision === 'rev-' + assessment.revision && provenance.scoreAsOf === submission.submittedAt &&
                profileMatches(assessment.profileRef, metadata.profileRef) && profileMatches(provenance.profileRef, metadata.profileRef));
            requireValue(provenance.scoreContractVersion === 'PROD-003-R1' &&
                provenance.roundingRule === 'decimal-half-up-one-place-v1' &&
                provenance.evaluatorId === 'no-fries-deterministic-assessment-evaluator' &&
                provenance.evaluatorVersion === '2026-09-02.1' &&
                provenance.evaluatorSourceSha256 === 'd27f39d71d191fc8ca63eb1c4f4df7ab2368a72732894f120ab5bc8500eddb9e' &&
                provenance.mappingVersion === 'framework-profile-question-mapping-v1' &&
                provenance.weightSetVersion === 'prod-003-r1-profile-integer-weights-v1' &&
                provenance.mappingSha256 === '84fa629455099448afeb23c7e5360b15b45dc926e652d1e6eda4bb18047dcc89' &&
                provenance.weightSetSha256 === '190b2060f31dcbe69a6e619809333d26fac4e94344048feda3a6233b080d73df' &&
                provenance.scoredAtomSetSha256 === 'b0093a01234f0ca4646629b09b01acc69f8f482b8227c49f1b98b58132f4dc42' &&
                provenance.applicabilityBasisSha256 === '88793977aebd91833cd806f85505cd53b0568a6bb5e4b45e08c4d56bd906f1eb' &&
                provenance.evidenceSnapshot.sha256 === 'bf79464bbd1d3f8c910951c55e471f4c491a336fd062acd55f942f312ceb7e86' &&
                provenance.riskContextSnapshot.sha256 === 'ca2d09c331e62808057d0645ff8fa0900ac03a41a548ab3e4aae534d31909927' &&
                value.remediationPriority.status === 'not_calculated' && value.remediationPriority.reason === 'priority_adapter_required' &&
                value.trend.status === 'not_requested');
            const domains = indexed(value.domains, 'domainId', metadata.domains);
            const controls = indexed(value.controls, 'controlId', metadata.controls);
            const atoms = indexed(value.atoms, 'itemId', metadata.questions);
            const responses = indexed(assessment.responses, 'itemId', metadata.questions);
            const evidenceLabels = { not_provided: 'Not provided', attested: 'Self-attested', documented_current: 'Current documentation',
                tested_or_observed_current: 'Currently tested or observed', independently_reviewed_current: 'Currently independently reviewed',
                stale: 'Stale', inaccessible: 'Inaccessible', disputed: 'Disputed', unavailable: 'Unavailable' };

            // Consistency checks only. Never substitute a locally derived figure.
            function percentageMatches(numerator, denominator, percentTenths) {
                count(numerator); count(denominator);
                if (denominator === 0) { requireValue(percentTenths === null); return; }
                count(percentTenths); requireValue(percentTenths <= 1000);
                const n = BigInt(numerator) * 2000n, d = BigInt(denominator), p = BigInt(percentTenths) * d * 2n;
                requireValue(p > n - d && p <= n + d);
            }
            function sum(rows, field) {
                const value = rows.reduce((total, row) => total + count(row[field]), 0); count(value); return value;
            }
            const provided = ['attested', 'documented_current', 'tested_or_observed_current', 'independently_reviewed_current'];
            const substantiated = ['documented_current', 'tested_or_observed_current', 'independently_reviewed_current'];
            const tested = ['tested_or_observed_current', 'independently_reviewed_current'];
            const allAtoms = Array.from(atoms.values());
            allAtoms.forEach(function (atom) {
                const response = responses.get(atom.itemId);
                const semantic = response.optionId === 'not_applicable' ? 'unknown' : response.optionId;
                const origin = response.optionId === 'not_applicable' ? 'claimed_not_applicable' : response.optionId === 'unknown' ? 'direct_unknown' : 'direct';
                requireValue(atom.applicable === true && atom.response === semantic && atom.responseOrigin === origin &&
                    atom.evidenceState === 'not_provided' && atom.applicabilityDecisionId === null && atom.applicabilityDecisionSha256 === null);
                // The pinned accepted NCSC profile assigns weight 1 to every question.
                // Payload totals cannot authorise a different weight set.
                requireValue(atom.weight === 1);
                const lower = semantic === 'yes' ? atom.weight * 2 : semantic === 'partial' ? atom.weight : 0;
                const upper = semantic === 'unknown' ? atom.weight * 2 : lower;
                requireValue(atom.lowerCreditUnits === lower && atom.upperCreditUnits === upper);
            });
            function aggregateMatches(source, rows) {
                const counts = source.countsCompletion, attainment = source.attainment, evidence = source.evidence;
                const unknown = rows.filter(atom => atom.response === 'unknown').length;
                const expected = { totalAtoms: rows.length, applicableAtoms: rows.length, approvedNotApplicableAtoms: 0,
                    claimedNotApplicableAtoms: rows.filter(atom => atom.responseOrigin === 'claimed_not_applicable').length,
                    yes: rows.filter(atom => atom.response === 'yes').length, partial: rows.filter(atom => atom.response === 'partial').length,
                    no: rows.filter(atom => atom.response === 'no').length, unknown: unknown,
                    directUnknown: rows.filter(atom => atom.responseOrigin === 'direct_unknown').length, missing: 0,
                    completionNumerator: rows.length - unknown, completionDenominator: rows.length };
                requireValue(Object.keys(expected).every(key => counts[key] === expected[key]) &&
                    counts.completionStatus === (rows.length === 0 ? 'not_scored' : unknown ? 'provisional' : 'complete'));
                percentageMatches(counts.completionNumerator, counts.completionDenominator, counts.completionPercentTenths);
                percent(counts.completionPercentTenths, counts.completionDisplay);
                requireValue(attainment.creditUnitScale === 2 && attainment.denominatorWeight === sum(rows, 'weight') &&
                    attainment.lowerCreditUnits === sum(rows, 'lowerCreditUnits') && attainment.upperCreditUnits === sum(rows, 'upperCreditUnits') &&
                    attainment.status === (rows.length ? 'scored' : 'not_scored'));
                count(attainment.denominatorWeight * 2);
                percentageMatches(attainment.lowerCreditUnits, attainment.denominatorWeight * 2, attainment.lowerPercentTenths);
                percentageMatches(attainment.upperCreditUnits, attainment.denominatorWeight * 2, attainment.upperPercentTenths);
                range(attainment);
                requireValue(evidence.denominator === rows.length && Object.keys(evidence.distribution).length === Object.keys(evidenceLabels).length &&
                    Object.keys(evidenceLabels).every(key => evidence.distribution[key] === rows.filter(atom => atom.evidenceState === key).length));
                [['providedCoverage', provided], ['substantiatedCoverage', substantiated], ['testedCoverage', tested]].forEach(function (entry) {
                    const covered = evidence[entry[0]];
                    requireValue(covered.denominator === rows.length && covered.numerator === rows.filter(atom => entry[1].includes(atom.evidenceState)).length);
                    percentageMatches(covered.numerator, covered.denominator, covered.percentTenths); coverage(covered);
                });
            }
            aggregateMatches(value, allAtoms);
            metadata.domains.forEach(domain => aggregateMatches(domains.get(domain.id), allAtoms.filter(atom => atom.domainId === domain.id)));
            metadata.controls.forEach(control => aggregateMatches(controls.get(control.id), allAtoms.filter(atom => atom.controlId === control.id)));
            const projectedDomains = metadata.domains.map(domain => ({ title: domain.title, attainment: range(domains.get(domain.id).attainment),
                lowerPercentTenths: domains.get(domain.id).attainment.lowerPercentTenths,
                upperPercentTenths: domains.get(domain.id).attainment.upperPercentTenths,
                denominatorWeight: domains.get(domain.id).attainment.denominatorWeight,
                completed: domains.get(domain.id).countsCompletion.completionNumerator,
                total: domains.get(domain.id).countsCompletion.completionDenominator,
                controls: metadata.controls.filter(control => control.domainId === domain.id).map(control => {
                    const result = controls.get(control.id); requireValue(result.domainId === domain.id);
                    return { title: control.title, attainment: range(result.attainment), questions: metadata.questions.filter(question => question.controlId === control.id).map(question => {
                        const atom = atoms.get(question.id), response = responses.get(question.id);
                        const option = metadata.responseOptions.find(option => option.id === response.optionId);
                        requireValue(atom.controlId === control.id && atom.domainId === domain.id && atom.responseOptionId === response.optionId &&
                            option && Object.hasOwn(evidenceLabels, atom.evidenceState));
                        count(atom.weight); requireValue(atom.weight > 0);
                        return { itemId: question.id, responseOptionId: response.optionId, evidenceState: atom.evidenceState,
                            prompt: question.prompt, answer: option.label, evidence: evidenceLabels[atom.evidenceState], weight: atom.weight,
                            rationale: response.rationale ? text(response.rationale.text) : null,
                            actions: question.guidance.startingActions.slice(), examples: question.guidance.evidenceExamples.slice() };
                    }) };
                }) }));
            const inputs = [ ['Organisation', text(provenance.organisationId)], ['Assessment', assessment.assessmentId],
                ['Submitted revision', String(submission.revision)], ['Calculated at', text(provenance.scoreAsOf)],
                ['Evaluator', text(provenance.evaluatorId)], ['Evaluator version', text(provenance.evaluatorVersion)],
                ['Score contract', provenance.scoreContractVersion], ['Rounding rule', text(provenance.roundingRule)],
                ...PROFILE_FIELDS.map(key => [key, text(provenance.profileRef[key])]),
                ...['evaluatorSourceSha256', 'scopePopulationSha256', 'mappingSha256', 'weightSetSha256', 'scoredAtomSetSha256',
                    'applicabilityBasisSha256', 'resolvedInputSha256'].map(key => [key, digest(provenance[key])]),
                ['Mapping version', text(provenance.mappingVersion)], ['Weight set version', text(provenance.weightSetVersion)],
                ['Evidence snapshot', text(provenance.evidenceSnapshot.id)], ['Evidence snapshot SHA-256', digest(provenance.evidenceSnapshot.sha256)],
                ['Risk context snapshot', text(provenance.riskContextSnapshot.id)], ['Risk context SHA-256', digest(provenance.riskContextSnapshot.sha256)],
                ['Response set SHA-256', digest(submission.responseSetSha256)], ['Output SHA-256', digest(value.outputSha256)] ];
            return { attainment: range(value.attainment), substantiated: coverage(value.evidence.substantiatedCoverage),
                denominatorWeight: value.attainment.denominatorWeight,
                lowerCreditUnits: value.attainment.lowerCreditUnits, upperCreditUnits: value.attainment.upperCreditUnits,
                completion: value.countsCompletion.completionDisplay,
                completed: value.countsCompletion.completionNumerator, total: value.countsCompletion.completionDenominator,
                partial: value.countsCompletion.partial, no: value.countsCompletion.no,
                tested: coverage(value.evidence.testedCoverage), pending: count(value.countsCompletion.claimedNotApplicableAtoms),
                unknown: count(value.countsCompletion.unknown), domains: projectedDomains, inputs: inputs };
        } catch (_) { return null; }
    }
    function mount(root, options) {
        options = options || {};
        if (!root || !root.ownerDocument) throw new Error('ncsc_root_required');
        if (mounted.has(root)) mounted.get(root).destroy();
        const doc = root.ownerDocument;
        const win = options.window || doc.defaultView;
        const metadata = copy(options.metadata);
        const client = options.client;
        const organisationId = options.organisationId;
        const initialAssessmentId = options.initialAssessmentId;
        if (!metadata || metadata.schemaVersion !== 1 || !Array.isArray(metadata.questions) || !metadata.questions.length ||
            initialAssessmentId !== undefined && (typeof initialAssessmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(initialAssessmentId)) ||
            !client || !['list', 'read', 'create', 'save', 'submit', 'normaliseCommand', 'commandByteLength'].every(function (key) { return typeof client[key] === 'function'; })) {
            throw new Error('ncsc_composition_required');
        }
        const editable = options.presentationMode === 'editable';
        const questions = metadata.questions;
        const optionById = new Map(metadata.responseOptions.map(function (item) { return [item.id, item]; }));
        const questionById = new Map(questions.map(function (item) { return [item.id, item]; }));
        const requests = new Set();
        let disposed = false;
        let epoch = 0;
        let editGeneration = 0;
        let selected = null;
        let acknowledged = null;
        let drafts = new Map();
        const assistanceNotes = new Map();
        let activeQuestion = 0;
        let summaries = [];
        let listSearch = '';
        let listStatus = 'all';
        let nextAfter = null;
        let listLoaded = false;
        let loading = false;
        let refreshing = false;
        let busy = false;
        let pending = null;
        let conflict = false;
        let currentChecked = true;
        let statusText = '';
        let errors = [];
        let leave = null;
        let view = 'list';
        let declaration = '';
        let content;
        let status;
        let errorBox;
        let controls;
        let dialog;
        let questionRegion;
        let questionIndex;
        let questionProgress;
        let navigationSummary;
        let nextUnanswered;
        let nextUnresolved;
        let assistanceRequest = null;
        let assistanceGeneration = 0;
        let unloadAttached = false;
        let workshopPanel;
        const controller = { requestLeave: requestLeave, destroy: destroy };
        mounted.set(root, controller);
        root.replaceChildren(); root.classList.add('ncsc-questionnaire');
        const heading = node('h2', '', metadata.title); heading.id = 'ncsc-title';
        status = node('p', 'ncsc-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
        root.append(heading, status);

        function live(expected) { return !disposed && mounted.get(root) === controller && (expected === undefined || expected === epoch); }
        function needsUnloadWarning() {
            return live() && view !== 'denied' && (!!pending || (view === 'create' ? declaration.trim().length > 0 : dirtyEntries().length > 0));
        }
        function beforeUnload(event) {
            if (!needsUnloadWarning()) { syncUnloadWarning(); return; }
            event.preventDefault(); event.returnValue = true;
        }
        function syncUnloadWarning() {
            if (!win || typeof win.addEventListener !== 'function' || typeof win.removeEventListener !== 'function') return;
            const needed = needsUnloadWarning();
            if (needed && !unloadAttached) { win.addEventListener('beforeunload', beforeUnload); unloadAttached = true; }
            else if (!needed && unloadAttached) { win.removeEventListener('beforeunload', beforeUnload); unloadAttached = false; }
        }
        function node(tag, cls, text) {
            const result = doc.createElement(tag);
            if (cls) result.className = cls;
            if (text !== undefined && text !== null) result.textContent = String(text);
            return result;
        }
        function button(label, action, cls) {
            const result = node('button', cls || 'dashboard-button', label); const createdEpoch = epoch;
            result.type = 'button'; result.addEventListener('click', function () { if (live(createdEpoch) && !result.disabled) action(); });
            return result;
        }
        function newId() {
            const crypto = win && win.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto);
            const value = options.createId ? options.createId() : crypto && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : null;
            if (!UUID.test(value || '')) throw new Error('ncsc_identifier_unavailable');
            return value;
        }
        function abortAssistance() {
            assistanceGeneration += 1;
            if (assistanceRequest) { assistanceRequest.abort(); assistanceRequest = null; }
        }
        function abortRequests() { abortAssistance(); requests.forEach(function (request) { request.abort(); }); requests.clear(); }
        async function call(method, args, expected) {
            const request = new AbortController(); requests.add(request);
            try {
                const result = method === 'list' ? await client.list(Object.assign({}, args, { signal: request.signal }))
                    : await client[method](args, { signal: request.signal });
                return live(expected) ? result : null;
            } finally { requests.delete(request); }
        }
        function cleanDetail(value, id) {
            if (!value || value.assessmentId !== id || value.moduleId !== metadata.moduleId || !profileMatches(value.profileRef, metadata.profileRef) ||
                !Array.isArray(value.responses) || value.responses.some(function (item) { return !questionById.has(item.itemId); })) throw new Error('ncsc_invalid_response');
            const result = copy(value);
            if (result.submission) result.submission = { revision: result.submission.revision, submittedAt: result.submission.submittedAt,
                responseSetSha256: result.submission.responseSetSha256, results: resultModel(result, metadata, organisationId) };
            return result;
        }
        function savedAnswer(id, source) {
            const response = (source || acknowledged).responses.find(function (item) { return item.itemId === id; });
            return response ? answer(response) : { itemId: id, optionId: null, rationale: null };
        }
        function resetDrafts() {
            drafts = new Map();
            questions.forEach(function (item) { drafts.set(item.id, { value: savedAnswer(item.id), generation: ++editGeneration }); });
        }
        function dirtyEntries() {
            if (!acknowledged) return [];
            return Array.from(drafts.values()).filter(function (item) { return !equal(item.value, savedAnswer(item.value.itemId)); });
        }
        function displayedAnswer(question) {
            return acknowledged.status === 'submitted' ? savedAnswer(question.id) : drafts.get(question.id).value;
        }
        function unansweredIndex(start) {
            for (let offset = 1; offset <= questions.length; offset += 1) {
                const index = (start + offset) % questions.length;
                if (displayedAnswer(questions[index]).optionId === null) return index;
            }
            return -1;
        }
        function unresolvedIndex(start) {
            for (let offset = 1; offset <= questions.length; offset += 1) {
                const index = (start + offset) % questions.length;
                if ([null, 'unknown', 'not_applicable'].includes(displayedAnswer(questions[index]).optionId)) return index;
            }
            return -1;
        }
        function updateQuestionNavigation() {
            if (!live() || !acknowledged || !questionIndex || !questionProgress) return;
            const sealed = acknowledged.status === 'submitted';
            let answered = 0, resolved = 0;
            questions.forEach(function (question, index) {
                const value = displayedAnswer(question), option = optionById.get(value.optionId);
                if (value.optionId !== null) answered += 1;
                if (['yes', 'partial', 'no'].includes(value.optionId)) resolved += 1;
                const label = value.optionId === 'not_applicable' ? 'Pending N/A' : option ? option.label : 'Unanswered';
                const unsaved = !sealed && !equal(value, savedAnswer(question.id)) ? ' *' : '';
                questionIndex.children[index].textContent = (index + 1) + ' of ' + questions.length + ' · ' + label + unsaved;
            });
            const missing = questions.length - answered, dirty = sealed ? 0 : dirtyEntries().length;
            questionProgress.textContent = (sealed || !editable ? 'Saved answers: ' : 'Local draft: ') + answered + ' of ' + questions.length +
                ' answers selected · ' + resolved + ' resolved · ' + missing + ' unanswered' + (dirty ? ' · ' + dirty + ' with unsaved changes' : '') + '. Counts are not a score.';
            if (navigationSummary) navigationSummary.textContent = 'Question ' + (activeQuestion + 1) + ' of ' + questions.length + ' · ' + missing + ' unanswered';
            if (nextUnanswered) nextUnanswered.disabled = unansweredIndex(activeQuestion) === -1;
            if (nextUnresolved) nextUnresolved.disabled = unresolvedIndex(activeQuestion) === -1;
        }
        function deny() {
            abortRequests(); epoch += 1; selected = null; acknowledged = null; drafts.clear(); assistanceNotes.clear(); summaries = [];
            pending = null; busy = false; loading = false; declaration = ''; errors = []; conflict = false;
            finishLeave(false); view = 'denied'; statusText = ''; render();
        }
        function fixedFailure(error) {
            if (error && (error.statusCode === 403 || error.code === 'ncsc_access_denied')) { deny(); return; }
            statusText = view === 'assessment' && !acknowledged
                ? 'The saved assessment could not be loaded. Retry this assessment or go back to the list.'
                : error && error.code === 'ncsc_request_too_large'
                ? 'This assessment is too large for this operation. Your saved answers and unsent text remain here. ' + (view === 'create' ? 'Shorten the scope description, then try again.' : acknowledged && acknowledged.revision >= SAVE_CEILING ? 'This assessment has reached its save limit. Start a new assessment with shorter rationales.' : 'Shorten one or more rationales, save the corrected draft, then try again.')
                : error && error.code === 'ncsc_submission_unavailable' ? 'Submission is not available yet. Your saved answers remain editable.'
                : error && error.code === 'ncsc_quota_exceeded' ? 'Submission is unavailable under the current allowance. Your saved answers remain available.'
                : view === 'list' ? 'The assessment service is unavailable. Retry loading the list to check your saved work.'
                : 'The assessment service is unavailable. Your unsent draft remains in this view.';
            updateStatus();
        }
        function provenance() {
            const section = node('details', 'ncsc-provenance');
            section.append(node('summary', '', 'About this questionnaire and its sources'));
            [metadata.description, metadata.claim, metadata.attribution].forEach(function (text) { if (text) section.append(node('p', '', text)); });
            (Array.isArray(metadata.limitations) ? metadata.limitations : [metadata.limitations]).forEach(function (text) { if (text) section.append(node('p', '', text)); });
            if (metadata.licence) {
                const link = node('a', '', metadata.licence.label + ' (opens in a new tab)');
                if (metadata.licence.url === 'https://creativecommons.org/licenses/by/4.0/') link.href = metadata.licence.url;
                link.target = '_blank'; link.rel = 'noopener noreferrer';
                section.append(link);
            }
            return section;
        }
        function workshopDownloads() {
            const section = node('details', 'ncsc-workshop'); section.id = 'ncsc-workshop';
            section.setAttribute('aria-labelledby', 'ncsc-workshop-title');
            const title = node('summary', '', 'Optional: Download workshop slides'); title.id = 'ncsc-workshop-title';
            section.append(title,
                node('p', '', 'A workshop companion with explanations and example answers for the 14 questionnaire prompts.'),
                node('p', '', 'Includes selected NZISM v3.9 starting-point references for further review.'),
                node('p', 'dashboard-muted', 'Version 2 · Prepared 20 October 2026 (NZDT).'),
                node('p', 'dashboard-muted', 'Source: No Fries questionnaire adapted from the NCSC Cyber Security Framework and Minimum Cyber Security Standards 2025, with selected NZISM v3.9 references.'));
            const links = node('div', 'ncsc-workshop-links');
            [['pptx', 'Download PowerPoint (.pptx)'], ['pdf', 'Download PDF (.pdf)']].forEach(function (format) {
                const filename = 'No_Fries_Questionnaire_Onsite_Companion_v2_NZISM.' + format[0];
                const link = node('a', 'dashboard-button', format[1]);
                link.id = 'ncsc-workshop-' + format[0];
                link.setAttribute('href', '/assets/workshops/' + filename);
                link.setAttribute('download', filename);
                links.append(link);
            });
            section.append(links);
            const sources = node('details', 'ncsc-workshop-sources');
            const sourceSummary = node('summary', '', 'Sources and reuse'); sourceSummary.id = 'ncsc-workshop-sources-title'; sources.append(sourceSummary);
            const sourceLinks = node('p');
            [
                ['NCSC Cyber Security Framework', 'https://www.ncsc.govt.nz/protect-your-organisation/ncsc-cyber-security-framework/'],
                ['Minimum Cyber Security Standards 2025', 'https://www.ncsc.govt.nz/protect-your-organisation/minimum-standards/'],
                ['NCSC Critical Controls', 'https://www.ncsc.govt.nz/protect-your-organisation/summary/'],
                ['NCSC reuse terms', 'https://www.ncsc.govt.nz/legal-privacy-and-copyright/'],
                ['NZISM v3.9 manual (November 2025)', 'https://nzism.gcsb.govt.nz/ism-document/pdf'],
                ['NZISM reuse terms', 'https://nzism.gcsb.govt.nz/legal-privacy-and-copyright'],
                ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/']
            ].forEach(function (source, index) {
                if (index) sourceLinks.append(node('span', '', ' · '));
                const link = node('a', '', source[0] + ' (opens in a new tab)');
                link.id = 'ncsc-workshop-source-' + index;
                link.setAttribute('href', source[1]); link.target = '_blank'; link.rel = 'noopener noreferrer';
                sourceLinks.append(link);
            });
            sources.append(sourceLinks, node('p', 'dashboard-muted', metadata.attribution));
            sources.append(node('p', 'dashboard-muted', 'Optional NZISM references are No Fries interpretations of NZISM v3.9 (November 2025), © Crown copyright, GCSB, licensed under CC BY 4.0. Changes were made for this workshop. No endorsement is implied.'));
            section.append(sources);
            return section;
        }
        function captureFocus(region) {
            const active = doc.activeElement;
            let ancestor = active;
            while (ancestor && ancestor !== region) ancestor = ancestor.parentElement;
            if (!active || ancestor !== region) return null;
            return { id: active.id, start: active.selectionStart, end: active.selectionEnd };
        }
        function restoreFocus(region, saved, fallback) {
            if (!saved || !live()) return;
            const replacement = saved.id && region.querySelector('[id="' + saved.id + '"]');
            const target = replacement && !replacement.disabled ? replacement : fallback;
            if (!target) return;
            if (target === fallback) target.tabIndex = -1;
            target.focus();
            if (target === replacement && typeof target.setSelectionRange === 'function' && Number.isInteger(saved.start)) {
                target.setSelectionRange(saved.start, saved.end);
            }
        }
        function render() {
            if (!live()) return;
            const focused = captureFocus(root);
            questionIndex = null; questionProgress = null; navigationSummary = null; nextUnanswered = null; nextUnresolved = null;
            // Keep the live region attached so asynchronous updates change an
            // existing accessible status rather than insert prefilled content.
            Array.from(root.children).forEach(function (child) { if (child !== heading && child !== status) child.remove(); });
            errorBox = node('div', 'ncsc-errors'); errorBox.tabIndex = -1;
            content = node('section', 'ncsc-content');
            root.append(errorBox, content);
            if (view === 'denied') content.append(node('p', '', 'This assessment is not available. Reopen the dashboard through your authenticated organisation context.'));
            else if (view === 'create') renderCreate();
            else if (acknowledged) renderAssessment();
            else if (view === 'assessment' && selected) renderAssessmentRead();
            else renderList();
            // Reuse the optional disclosure so open state survives save/recovery
            // renders. Stable IDs also restore keyboard focus inside it.
            if (view !== 'denied') { if (!workshopPanel) workshopPanel = workshopDownloads(); root.append(workshopPanel); }
            root.append(provenance()); updateStatus(); renderErrors();
            if (leave) renderLeave();
            else restoreFocus(root, focused, heading);
        }
        function updateStatus() {
            syncUnloadWarning();
            if (!live() || !status) return;
            const saved = acknowledged ? 'Saved revision ' + acknowledged.revision + '. ' + acknowledged.progress.answered + ' of ' + acknowledged.progress.total + ' answered. ' : '';
            const dirty = dirtyEntries().length;
            status.textContent = statusText || (busy ? 'Saving. ' + saved : loading ?
                view === 'assessment' && !acknowledged ? 'Loading the selected assessment.' : 'Loading assessments.'
                : saved + (dirty ? dirty + (dirty === 1 ? ' answer has' : ' answers have') + ' unsaved changes.' : ''));
            if (controls) controls.querySelectorAll('button').forEach(function (control) {
                if (control.dataset.mutation === 'true') control.disabled = busy || !!pending || conflict || !currentChecked;
            });
            updateQuestionNavigation();
        }
        function edited() {
            if (!pending && !busy && !conflict) statusText = '';
            updateStatus();
        }
        function returnToList() {
            abortRequests(); epoch += 1; loading = false;
            acknowledged = null; selected = null; drafts.clear(); assistanceNotes.clear();
            // Validation belongs to the departed form. Clear it before the list
            // renders, because its question controls and drafts no longer exist.
            view = 'list'; declaration = ''; errors = []; statusText = ''; loadList(false);
        }
        function renderAssessmentRead() {
            const target = selected;
            if (!loading) content.append(button('Retry loading this assessment', function () {
                if (!loading && selected === target && !acknowledged) openAssessment(target);
            }));
            content.append(button('Back to assessments', function () { requestLeave(returnToList); }, 'dashboard-text-button'));
        }
        function renderList() {
            const introduction = node('div', 'ncsc-assessment-intro');
            introduction.append(node('p', '', 'Pick up where you left off, or view the results of a submitted assessment. Only saved progress appears here.'));
            if (editable) introduction.append(button('Start an assessment', function () {
                view = 'create'; declaration = ''; errors = []; render();
                const scope = content.querySelector('textarea'); if (scope) scope.focus();
            }, summaries.length ? 'dashboard-button dashboard-button-secondary' : 'dashboard-button'));
            content.append(introduction);
            if (!loading && listLoaded && !summaries.length) content.append(node('p', '', 'No saved assessments yet.'));
            const filters = node('div', 'ncsc-assessment-filters');
            const searchLabel = node('label', '', 'Find a saved assessment'); searchLabel.htmlFor = 'ncsc-assessment-search';
            const search = node('input'); search.type = 'search'; search.id = searchLabel.htmlFor;
            search.placeholder = 'Date or assessment reference'; search.value = listSearch;
            search.setAttribute('aria-describedby', 'ncsc-assessment-filter-note');
            const statusLabel = node('label', '', 'Status'); statusLabel.htmlFor = 'ncsc-assessment-status';
            const filter = node('select'); filter.id = statusLabel.htmlFor;
            [['all', 'All assessments'], ['unfinished', 'In progress'], ['submitted', 'Submitted']].forEach(function (entry) {
                const option = node('option', '', entry[1]); option.value = entry[0]; filter.append(option);
            });
            filter.value = listStatus;
            const searchField = node('div'), statusField = node('div');
            searchField.append(searchLabel, search); statusField.append(statusLabel, filter); filters.append(searchField, statusField);
            const list = node('ul', 'ncsc-assessment-list');
            const count = node('p', 'dashboard-muted'); count.setAttribute('role', 'status'); count.setAttribute('aria-atomic', 'true');
            const note = node('p', 'dashboard-muted', nextAfter !== null
                ? 'Search and filters cover loaded assessments. Load more to include more saved records.'
                : 'Search by the date created, date last saved, or assessment reference.');
            note.id = 'ncsc-assessment-filter-note';
            const empty = node('div', 'ncsc-assessment-empty');
            empty.append(node('p', '', 'No loaded assessments match your search and status.'));
            const clear = button('Clear filters', function () {
                listSearch = ''; listStatus = 'all'; search.value = ''; filter.value = 'all'; updateList(); search.focus();
            }, 'dashboard-button dashboard-button-secondary');
            empty.append(clear);
            function updateList() {
                if (!live() || view !== 'list') return;
                list.replaceChildren();
                const query = listSearch.trim().toLowerCase();
                summaries.forEach(function (item, index) {
                    const submitted = item.status === 'submitted';
                    if (listStatus === 'submitted' && !submitted || listStatus === 'unfinished' && submitted ||
                        query && ![item.assessmentId, item.createdAt, item.updatedAt].some(function (value) { return value.toLowerCase().includes(query); })) return;
                    const row = node('li', 'ncsc-assessment-card');
                    const heading = node('div', 'ncsc-assessment-card-heading');
                    heading.append(node('h3', '', 'Assessment started ' + item.createdAt.slice(0, 10)),
                        node('span', 'dashboard-badge', submitted ? 'Submitted' : item.status === 'created' ? 'Not started' : 'In progress'));
                    const saved = node('p', 'ncsc-assessment-saved', item.progress.answered + ' of ' + item.progress.total + ' responses saved');
                    const progress = node('progress', 'ncsc-saved-progress'); progress.max = item.progress.total; progress.value = item.progress.answered;
                    progress.setAttribute('aria-label', 'Saved responses');
                    const action = submitted ? 'View results' : editable ? 'Continue assessment' : 'View assessment';
                    const open = button(action, function () { requestLeave(function () { openAssessment(item.assessmentId); }); },
                        submitted || !editable ? 'dashboard-button dashboard-button-secondary' : 'dashboard-button');
                    open.id = 'ncsc-assessment-open-' + index; open.dataset.assessmentId = item.assessmentId;
                    const reference = node('p', 'dashboard-muted ncsc-preserve-text', 'Last saved: ' + item.updatedAt.replace('T', ' ').replace('Z', ' UTC') + '\nAssessment reference: ' + item.assessmentId);
                    reference.id = 'ncsc-assessment-reference-' + index; open.setAttribute('aria-describedby', reference.id);
                    const details = node('details', 'ncsc-assessment-reference'), summary = node('summary', '', 'Saved record details');
                    summary.id = 'ncsc-assessment-details-' + index; details.append(summary, reference);
                    row.append(heading, saved, progress,
                        node('p', 'dashboard-muted ncsc-assessment-date', 'Last saved ' + item.updatedAt.slice(0, 10)), open, details); list.append(row);
                });
                const matches = list.children.length;
                count.textContent = matches + ' of ' + summaries.length + ' loaded assessments shown';
                empty.hidden = matches !== 0 || !summaries.length;
            }
            search.addEventListener('input', function () { listSearch = search.value; updateList(); });
            filter.addEventListener('change', function () { listStatus = filter.value; updateList(); });
            if (summaries.length) content.append(filters, note, count, empty);
            updateList();
            content.append(list);
            if (listLoaded && nextAfter !== null) {
                const more = button('Load more assessments', function () { loadList(true); }, 'dashboard-button dashboard-button-secondary');
                more.id = 'ncsc-assessment-more'; more.disabled = loading; content.append(more);
            }
            if (!loading && !listLoaded) content.append(button('Retry loading assessments', function () { loadList(false); }));
        }
        async function loadList(append) {
            if (!live() || loading) return;
            const previousIds = new Set(summaries.map(function (item) { return item.assessmentId; }));
            let ownsFocus = append && doc.activeElement === root.querySelector('[id="ncsc-assessment-more"]');
            let appended = false;
            function releaseFocus() { ownsFocus = false; }
            // An old empty page cannot establish that a fresh list is empty.
            // Failed replacement reads must retain an explicit retry path.
            if (!append) { listLoaded = false; summaries = []; nextAfter = null; }
            const expected = epoch; loading = true; statusText = ''; render();
            // The disabled loading control temporarily hands focus to the heading.
            // Any deliberate move away cancels this request's eventual handoff.
            if (ownsFocus) heading.addEventListener('blur', releaseFocus);
            try {
                const result = await call('list', { limit: 50, afterAssessmentId: append ? nextAfter : null }, expected);
                if (!result) return;
                if (result.assessments.some(function (item) { return item.moduleId !== metadata.moduleId || !profileMatches(item.profileRef, metadata.profileRef); })) throw new Error('ncsc_invalid_response');
                const map = new Map((append ? summaries : []).map(function (item) { return [item.assessmentId, item]; }));
                result.assessments.forEach(function (item) { map.set(item.assessmentId, copy(item)); });
                summaries = Array.from(map.values()); nextAfter = result.nextAfterAssessmentId; listLoaded = true;
                appended = append;
            } catch (error) { if (live(expected)) fixedFailure(error); }
            finally {
                heading.removeEventListener('blur', releaseFocus);
                if (live(expected)) {
                    const restorePageFocus = ownsFocus && doc.activeElement === heading && view === 'list' && !leave;
                    loading = false; render();
                    if (restorePageFocus) {
                        const list = root.querySelector('.ncsc-assessment-list');
                        const firstNew = appended && list && Array.from(list.querySelectorAll('button')).find(function (control) {
                            return !previousIds.has(control.dataset.assessmentId);
                        });
                        const target = firstNew || root.querySelector('[id="ncsc-assessment-more"]') || root.querySelector('[id="ncsc-assessment-search"]');
                        if (target && !target.disabled) target.focus();
                    }
                }
            }
        }
        async function openAssessment(id) {
            if (!live() || loading && view === 'assessment' && selected === id) return;
            abortRequests(); epoch += 1; const expected = epoch;
            selected = id; acknowledged = null; drafts.clear(); assistanceNotes.clear(); conflict = false; currentChecked = true; errors = []; pending = null; view = 'assessment';
            loading = true; statusText = ''; render();
            try {
                const result = await call('read', id, expected);
                if (!result) return;
                acknowledged = cleanDetail(result.assessment, id); resetDrafts();
                activeQuestion = acknowledged.status === 'submitted' ? 0 : Math.max(0, unansweredIndex(-1));
            } catch (error) { if (live(expected)) fixedFailure(error); }
            finally { if (live(expected)) { loading = false; render(); } }
        }
        function renderCreate() {
            const renderedEpoch = epoch;
            content.append(node('p', '', 'Describe the organisation, systems and people covered. This is your declaration, not verified inventory. It cannot be changed after creation.'));
            const label = node('label', '', 'Assessment scope'); label.setAttribute('for', 'ncsc-scope');
            const input = node('textarea', 'ncsc-textarea'); input.id = 'ncsc-scope'; input.value = declaration; input.rows = 5; input.readOnly = busy || !!pending;
            input.setAttribute('aria-describedby', 'ncsc-scope-help'); input.required = true;
            input.addEventListener('input', function () { if (live(renderedEpoch) && !busy && !pending) { declaration = input.value; edited(); } });
            content.append(label, input, node('p', 'dashboard-muted', 'Describe the people, systems and locations covered, in up to 4,000 characters. For example: our Auckland office, staff laptops and Microsoft 365; excluding the warehouse systems.'));
            content.children[content.children.length - 1].id = 'ncsc-scope-help';
            controls = node('div', 'ncsc-actions');
            const start = button('Create assessment', createAssessment); start.dataset.mutation = 'true';
            controls.append(start, button('Back to assessments', function () { requestLeave(returnToList); }, 'dashboard-text-button'));
            content.append(controls);
            if (pending) renderPending();
        }
        async function createAssessment() {
            if (!editable || busy || pending || !live()) return false;
            if (!validText(declaration)) { errors = [{ id: 'scope', message: textError(declaration, true) }]; renderErrors(true); return false; }
            errors = []; renderErrors();
            try {
                const command = client.normaliseCommand({ assessmentId: newId(), action: 'create', idempotencyKey: newId(), expectedRevision: null, payload: { scopePopulation: { description: declaration } } });
                return await perform(command, []);
            } catch (error) { fixedFailure(error); return false; }
        }
        function renderAssessment() {
            const renderedEpoch = epoch;
            const sealed = acknowledged.status === 'submitted';
            const progress = acknowledged.progress;
            content.append(node('p', 'ncsc-saved-progress', 'Saved responses: ' + progress.answered + ' of ' + progress.total + ' selected; ' + progress.missing + ' unanswered; ' + progress.unknown + ' Unknown; ' + progress.notApplicableClaims + ' pending N/A claims.'));
            content.append(node('p', 'dashboard-muted', 'Saved resolved answers: ' + (progress.answered - progress.unknown - progress.notApplicableClaims) + ' of ' + progress.total + ' (Yes, Partial or No). Unknown and pending N/A are saved responses but remain unresolved.'));
            content.append(button('Back to assessments', function () { requestLeave(returnToList); }, 'dashboard-text-button'));
            const declarationPanel = node('details', 'ncsc-scope'); declarationPanel.append(node('summary', '', 'Assessment scope (saved declaration)'), node('p', 'ncsc-preserve-text', acknowledged.scopePopulation.description)); content.append(declarationPanel);
            if (sealed) {
                content.append(node('p', 'ncsc-sealed', 'Submitted ' + acknowledged.submission.submittedAt + ' at revision ' + acknowledged.submission.revision + '. Answers below are the saved, read-only submission.'));
                renderResults(acknowledged.submission.results);
                if (dirtyEntries().length) {
                    const unsent = node('details', 'ncsc-warning'); unsent.append(node('summary', '', 'Unsubmitted local changes (' + dirtyEntries().length + ')'));
                    unsent.append(node('p', '', 'These retained local changes were not part of the submission. The question form shows the saved submission separately.'));
                    dirtyEntries().forEach(function (entry) {
                        const option = optionById.get(entry.value.optionId);
                        unsent.append(node('h3', '', questionById.get(entry.value.itemId).prompt), node('p', '', option ? option.label : 'Answer cleared'));
                        if (entry.value.rationale) unsent.append(node('p', 'ncsc-preserve-text', entry.value.rationale.text));
                    }); content.append(unsent);
                }
            }
            else if (!editable) content.append(node('p', '', 'Read-only view. Editing is not enabled in this dashboard presentation.'));
            if (conflict) renderConflict();
            if (pending) renderPending();
            questionProgress = node('p', 'ncsc-draft-progress'); questionProgress.id = 'ncsc-draft-progress'; content.append(questionProgress);
            const indexLabel = node('label', '', 'Question'); indexLabel.setAttribute('for', 'ncsc-question-index');
            const index = node('select', 'ncsc-question-index'); index.id = 'ncsc-question-index';
            index.setAttribute('aria-describedby', 'ncsc-question-index-help');
            questionIndex = index;
            questions.forEach(function (_item, i) { const option = node('option', '', (i + 1) + ' of ' + questions.length); option.value = String(i); index.append(option); });
            index.value = String(activeQuestion);
            index.addEventListener('change', function () { const i = Number(index.value); if (live(renderedEpoch) && index.parentElement === content && Number.isInteger(i) && i >= 0 && i < questions.length) { activeQuestion = i; renderQuestion(); } });
            content.append(indexLabel, index);
            const indexHelp = node('p', 'dashboard-muted', 'The full question is below. * marks unsaved changes.');
            indexHelp.id = 'ncsc-question-index-help'; content.append(indexHelp);
            questionRegion = node('div', 'ncsc-question'); content.append(questionRegion); renderQuestion();
            controls = node('div', 'ncsc-actions');
            if (editable && !sealed) {
                const save = button('Save progress', function () { saveAll(false); }); save.dataset.mutation = 'true';
                const final = node('section', 'ncsc-final-submission'); final.setAttribute('aria-labelledby', 'ncsc-submit-title');
                const title = node('h3', '', 'Finish this baseline'); title.id = 'ncsc-submit-title';
                const consequence = node('p', 'dashboard-muted', 'Submitting makes this baseline read-only. Your latest answers are saved first. You can keep saving progress until you are ready.'); consequence.id = 'ncsc-submit-consequence';
                const submit = button('Submit assessment', submitAssessment, 'dashboard-text-button'); submit.dataset.mutation = 'true'; submit.setAttribute('aria-describedby', consequence.id);
                final.append(title, consequence, submit); controls.append(save, final);
            }
            content.append(controls);
            content.append(node('p', 'dashboard-muted', 'Resolved means answered Yes, Partial or No; it does not mean implemented. Submission requires an answer to every question and a rationale for each N/A; Unknown and pending N/A are allowed. A submitted baseline is read-only and is not a certification.'));
        }
        function canEdit() { return editable && acknowledged && acknowledged.status !== 'submitted' && !conflict && !(pending && pending.command.action === 'submit'); }
        function renderResults(results) {
            const panel = node('section', 'ncsc-results'); panel.setAttribute('aria-label', 'Assessment results');
            panel.append(node('h2', '', 'Assessment results'));
            content.append(panel);
            if (!results) {
                panel.append(node('p', 'ncsc-warning', 'Results are unavailable for this submission. Your saved answers remain below. Reopen the assessment to try again.'));
                return;
            }
            panel.append(node('p', 'dashboard-muted', 'These results describe the saved submission and its declared scope. They are gap indicators, not an audit or certification.'));
            const metrics = node('div', 'ncsc-result-metrics'); panel.append(metrics);
            function metric(title, value, explanation) {
                const card = node('section', 'ncsc-result-metric'); card.append(node('h3', '', title), node('p', 'ncsc-result-value', value), node('p', '', explanation)); metrics.append(card);
            }
            metric('Reported implementation', results.attainment, 'Weighted implementation range. Unknown answers and pending N/A claims widen the range; they do not count as implemented.');
            metric('Resolved answers', results.completed + ' of ' + results.total, results.completion + ' answered Yes, Partial or No. This measures how much is known, not how much is implemented.');
            metric('Supporting evidence', results.substantiated, 'Current substantiated evidence coverage. Tested coverage: ' + results.tested + '. Confidence is not assessed. Self-attested answers alone do not demonstrate effectiveness.');
            panel.append(node('p', 'dashboard-muted', 'Risk priority: Not calculated. Suggested actions follow framework order, not risk order. Trend: No comparison available; changes require comparable assessment versions and scope.'));
            panel.append(node('p', '', 'Unknown or unresolved answers: ' + results.unknown + '. Pending N/A claims: ' + results.pending + '.'));
            panel.append(node('p', 'dashboard-muted', 'No Fries weights every question equally: Yes earns 1, Partial 0.5 and No 0. The lower end gives unresolved answers 0; the upper end gives them 1. N/A stays in the denominator unless formally approved; N/A approval is not available in this journey. This is a No Fries calculation, not an NCSC score.'));
            panel.append(node('h3', '', 'Explore NCSC functions and assessment topics'));
            results.domains.forEach(function (domain) {
                const detail = node('details', 'ncsc-result-domain'); detail.append(node('summary', '', domain.title + ' — ' + domain.attainment));
                domain.controls.forEach(function (control) {
                    const item = node('details', 'ncsc-result-control'); item.append(node('summary', '', control.title + ' — ' + control.attainment));
                    control.questions.forEach(function (question) {
                        item.append(node('h4', '', question.prompt), node('p', '', 'Saved answer: ' + question.answer + '. Evidence: ' + question.evidence + '. Weight: ' + question.weight + '.'));
                        if (question.rationale) item.append(node('p', 'ncsc-preserve-text', 'Pending N/A rationale: ' + question.rationale));
                        [['Suggested next actions', question.actions], ['Useful evidence', question.examples]].forEach(function (group) {
                            item.append(node('h4', '', group[0])); const list = node('ul'); group[1].forEach(function (text) { list.append(node('li', '', text)); }); item.append(list);
                        });
                    }); detail.append(item);
                }); panel.append(detail);
            });
            const provenance = node('details', 'ncsc-result-provenance'); provenance.append(node('summary', '', 'Calculation inputs and versions'));
            provenance.append(node('p', '', 'Percentages are supplied by the deterministic server evaluator. This view does not recalculate them. Input fingerprints identify the saved calculation; they are not downloadable evidence.'));
            const list = node('dl'); results.inputs.forEach(function (row) { list.append(node('dt', '', row[0]), node('dd', '', row[1])); }); provenance.append(list); panel.append(provenance);
        }
        function renderQuestion() {
            if (!live() || !questionRegion || !acknowledged) return;
            abortAssistance();
            const focused = captureFocus(questionRegion);
            questionRegion.replaceChildren();
            const renderedEpoch = epoch;
            const question = questions[activeQuestion];
            const entry = acknowledged.status === 'submitted' ? { value: savedAnswer(question.id) } : drafts.get(question.id);
            const control = metadata.controls.find(function (item) { return item.id === question.controlId; });
            const domain = metadata.domains.find(function (item) { return control && item.id === control.domainId; });
            questionRegion.append(node('p', 'dashboard-eyebrow', [domain && domain.title, control && control.title].filter(Boolean).join(' · ')));
            const fieldset = node('fieldset', 'ncsc-answer'); fieldset.append(node('legend', '', question.prompt));
            const inputGuidance = QUESTION_INPUT_GUIDANCE[question.id];
            const hint = node('p', 'ncsc-input-guidance', inputGuidance ? inputGuidance.consider : question.guidance && question.guidance.summary || question.prompt);
            hint.id = 'ncsc-input-guidance-' + question.id; fieldset.setAttribute('aria-describedby', hint.id); fieldset.append(hint);
            const writable = canEdit();
            question.responseOptionIds.forEach(function (id) {
                const option = optionById.get(id); const label = node('label', 'ncsc-option');
                const input = node('input'); input.type = 'radio'; input.name = 'ncsc-answer-' + question.id; input.id = 'ncsc-answer-' + question.id + '-' + id;
                input.value = id; input.checked = entry.value.optionId === id; input.disabled = !writable;
                const title = node('strong', '', option.label); title.id = input.id + '-label';
                const help = node('span', 'dashboard-muted', ANSWER_GUIDANCE[id]); help.id = input.id + '-help';
                input.setAttribute('aria-labelledby', title.id); input.setAttribute('aria-describedby', help.id);
                const description = node('span'); description.append(title, node('br'), help);
                label.setAttribute('for', input.id); label.append(input, description);
                input.addEventListener('change', function () {
                    if (!live(renderedEpoch) || !writable || !canEdit() || !input.checked) return;
                    const old = drafts.get(question.id).value;
                    drafts.set(question.id, { value: { itemId: question.id, optionId: id, rationale: option.applicable ? null : { text: old.rationale ? old.rationale.text : '' } }, generation: ++editGeneration });
                    renderQuestion(); edited();
                    const current = questionRegion.querySelector('[id="' + input.id + '"]'); if (current) current.focus();
                });
                fieldset.append(label);
            });
            questionRegion.append(fieldset);
            const selectedOption = optionById.get(entry.value.optionId);
            if (selectedOption && !selectedOption.applicable) {
                const label = node('label', '', 'Rationale for pending N/A claim'); label.setAttribute('for', 'ncsc-rationale-' + question.id);
                const rationale = node('textarea', 'ncsc-textarea'); rationale.id = 'ncsc-rationale-' + question.id; rationale.value = entry.value.rationale ? entry.value.rationale.text : '';
                rationale.rows = 6; rationale.required = true; rationale.readOnly = !writable;
                rationale.setAttribute('aria-describedby', 'ncsc-rationale-help-' + question.id);
                const help = node('p', 'dashboard-muted', 'Explain why this does not apply, in up to 4,000 characters. This remains unresolved and included in the score denominator unless formally approved. N/A approval is not available in this journey.'); help.id = 'ncsc-rationale-help-' + question.id;
                rationale.addEventListener('input', function () {
                    if (!live(renderedEpoch) || !writable || !canEdit()) return;
                    drafts.set(question.id, { value: { itemId: question.id, optionId: selectedOption.id, rationale: { text: rationale.value } }, generation: ++editGeneration });
                    edited();
                });
                questionRegion.append(label, rationale, help);
            }
            if (writable) {
                const clear = button('Clear answer', function () {
                    drafts.set(question.id, { value: { itemId: question.id, optionId: null, rationale: null }, generation: ++editGeneration }); renderQuestion(); edited();
                }, 'dashboard-text-button');
                clear.id = 'ncsc-clear-answer'; questionRegion.append(clear);
            }
            const guidance = node('details', 'ncsc-guidance'); guidance.append(node('summary', '', 'Guidance and evidence examples'));
            if (inputGuidance) guidance.append(node('p', 'ncsc-input-example', 'Example: ' + inputGuidance.example));
            if (question.guidance) {
                guidance.append(node('p', '', question.guidance.summary));
                [['Evidence examples', question.guidance.evidenceExamples], ['Starting actions', question.guidance.startingActions]].forEach(function (pair) {
                    guidance.append(node('h3', '', pair[0])); const list = node('ul'); (pair[1] || []).forEach(function (text) { list.append(node('li', '', text)); }); guidance.append(list);
                });
            }
            guidance.append(node('p', 'dashboard-muted', 'Evidence examples are records you can consult to check your answer. Document upload is not enabled here.'));
            if (Array.isArray(question.sources) && question.sources.length) {
                guidance.append(node('h3', '', 'Why we ask'), node('p', 'dashboard-muted', metadata.sourceDisclosure));
                const sources = node('ul');
                question.sources.forEach(function (source) {
                    // Keep the protected assessment open while consulting official guidance.
                    let url;
                    try { url = new URL(source.url); } catch (_) { return; }
                    if (url.protocol !== 'https:' || url.hostname !== 'www.ncsc.govt.nz' || url.port ||
                        url.username || url.password || url.search || url.hash) return;
                    const link = node('a', '', source.title + ' (opens in a new tab)');
                    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
                    const item = node('li'); item.append(link, node('span', '', ' · Catalogue source verified ' + source.lastVerifiedAt)); sources.append(item);
                });
                guidance.append(sources);
            }
            questionRegion.append(guidance);
            renderAssistance(question, writable);
            const nav = node('div', 'ncsc-question-navigation');
            const previous = button('Previous question', function () {
                if (questionRegion.contains(previous) && activeQuestion > 0) { activeQuestion -= 1; renderAssessmentQuestion(); }
            }); previous.disabled = activeQuestion === 0;
            const next = button('Next question', function () {
                if (questionRegion.contains(next) && activeQuestion < questions.length - 1) { activeQuestion += 1; renderAssessmentQuestion(); }
            }); next.disabled = activeQuestion === questions.length - 1;
            navigationSummary = node('span', 'ncsc-navigation-summary');
            const navigationActions = node('div', 'ncsc-navigation-actions'); navigationActions.append(previous, next);
            nextUnanswered = null;
            if (acknowledged.status !== 'submitted') {
                const jump = button('Next unanswered question', function () {
                    if (!questionRegion.contains(jump)) return;
                    const index = unansweredIndex(activeQuestion);
                    if (index !== -1) { activeQuestion = index; renderAssessmentQuestion(); }
                }, 'dashboard-text-button');
                nextUnanswered = jump; navigationActions.append(jump);
            }
            const unresolved = button('Next unresolved question', function () {
                if (!questionRegion.contains(unresolved)) return;
                const index = unresolvedIndex(activeQuestion);
                if (index !== -1) { activeQuestion = index; renderAssessmentQuestion(); }
            }, 'dashboard-text-button');
            nextUnresolved = unresolved; navigationActions.append(unresolved);
            nav.append(navigationSummary, navigationActions); questionRegion.append(nav); updateQuestionNavigation();
            questionRegion.append(node('p', 'dashboard-muted', 'Unresolved includes unanswered, Unknown and pending N/A. Unknown and pending N/A remain valid responses for submission.'));
            applyInlineErrors();
            restoreFocus(questionRegion, focused, fieldset.querySelector('legend'));
        }
        function renderAssistance(question, writable) {
            if (acknowledged.status === 'submitted') assistanceNotes.clear();
            const panel = node('details', 'ncsc-guidance');
            panel.append(node('summary', '', 'Help me answer this question'));
            panel.append(node('p', '', question.guidance && question.guidance.summary || question.prompt));
            panel.append(node('p', 'dashboard-muted', 'Describe what actually happens, who manages it, and what information supports it. Unknown is a valid answer. AI suggestions need your review and do not verify evidence.'));
            questionRegion.append(panel);
            const assistant = options.assistance;
            if (!writable || !assistant || typeof assistant.suggest !== 'function') {
                panel.append(node('p', 'dashboard-muted', 'AI assistance and document interpretation are not enabled in this assessment. You can still use the guidance and answer manually.'));
                return;
            }
            const label = node('label', '', 'Describe your setup or paste relevant information');
            const notes = node('textarea', 'ncsc-textarea'); notes.id = 'ncsc-assistance-notes-' + question.id;
            notes.value = assistanceNotes.get(question.id) || '';
            notes.maxLength = 4000; label.setAttribute('for', notes.id);
            panel.append(label, notes, node('p', 'dashboard-muted', 'Use only information approved for this assessment. Do not include passwords, tokens or personal information. Document upload is not enabled here.'));
            panel.append(node('p', 'dashboard-muted', 'Notes stay only while this assessment is open. They are not saved with answers and will be cleared when you leave or refresh.'));
            const output = node('div'); output.setAttribute('role', 'status'); output.setAttribute('aria-live', 'polite');
            const panelLive = () => live() && canEdit() && questionRegion && questionRegion.contains(notes);
            async function requestHelp(explainOnly) {
                if (!panelLive()) return;
                if (!explainOnly && !validText(notes.value)) {
                    output.replaceChildren(node('p', '', 'Enter relevant information in 1–4,000 characters first.')); return;
                }
                abortAssistance();
                const request = new AbortController(); assistanceRequest = request;
                const token = assistanceGeneration, localGeneration = editGeneration, revision = acknowledged.revision;
                const assessmentId = acknowledged.assessmentId, expectedEpoch = epoch, inputText = notes.value;
                const valid = () => live(expectedEpoch) && token === assistanceGeneration && canEdit() &&
                    acknowledged.assessmentId === assessmentId && acknowledged.revision === revision &&
                    questions[activeQuestion].id === question.id && localGeneration === editGeneration && notes.value === inputText;
                requestButton.disabled = true; explainButton.disabled = true;
                output.replaceChildren(node('p', '', explainOnly ? 'Explaining the question. Your notes are not sent and your answer has not changed.' : 'Preparing a suggestion. Your answer has not changed.'));
                const timer = setTimeout(() => { request.abort(); if (valid()) {
                    assistanceGeneration += 1; requestButton.disabled = false; explainButton.disabled = false;
                    output.replaceChildren(node('p', '', 'Assistance timed out. Your answer has not changed.'));
                } }, 30000);
                try {
                    const suggestion = await assistant.suggest({ assessmentId, revision, questionId: question.id,
                        mode: explainOnly ? 'explain' : 'suggest', notes: explainOnly ? '' : inputText }, { signal: request.signal });
                    if (!valid()) return;
                    // Treat all model text as data. The server adapter must perform
                    // full citation/provenance and tenant validation before this DTO.
                    if (!suggestion || suggestion.questionId !== question.id || suggestion.status !== 'suggested_not_confirmed' ||
                        !validText(suggestion.explanation) || suggestion.optionId !== null && !question.responseOptionIds.includes(suggestion.optionId) ||
                        !Array.isArray(suggestion.followUp) || suggestion.followUp.length > 3 || !suggestion.followUp.every(validText) ||
                        !Array.isArray(suggestion.citations) || suggestion.citations.length > 8 ||
                        !suggestion.citations.every(c => c && validText(c.sourceId) && validText(c.quote)) ||
                        suggestion.optionId !== null && !suggestion.citations.length ||
                        suggestion.optionId === 'not_applicable' && !validText(suggestion.rationale) ||
                        suggestion.optionId !== 'not_applicable' && suggestion.rationale !== null) throw new Error();
                    if (explainOnly && (suggestion.optionId !== null || suggestion.citations.length)) throw new Error();
                    output.replaceChildren(node('p', '', suggestion.explanation));
                    suggestion.citations.forEach(c => output.append(node('p', 'ncsc-preserve-text', c.sourceId + ': “' + c.quote + '”')));
                    suggestion.followUp.forEach(q => output.append(node('p', '', q)));
                    if (suggestion.optionId !== null) {
                        output.append(node('p', '', 'Suggested answer: ' + optionById.get(suggestion.optionId).label));
                        if (suggestion.rationale) output.append(node('p', '', 'Proposed N/A rationale: ' + suggestion.rationale));
                        output.append(button('Use this answer in my draft', function () {
                            if (!valid()) return;
                            drafts.set(question.id, { value: { itemId: question.id, optionId: suggestion.optionId,
                                rationale: suggestion.rationale === null ? null : { text: suggestion.rationale } }, generation: ++editGeneration });
                            renderQuestion(); edited();
                            statusText = 'Suggestion added to your unsaved draft. Review it and use Save progress to record the answer. AI provenance logging is not enabled in this source preview.';
                            updateStatus();
                        }));
                    }
                } catch (_) { if (valid()) output.replaceChildren(node('p', '', 'Assistance is unavailable. Your answer has not changed; you can continue manually.')); }
                finally { clearTimeout(timer); if (token === assistanceGeneration) { assistanceRequest = null; requestButton.disabled = false; explainButton.disabled = false; } }
            }
            const requestButton = button('Suggest an answer', function () { return requestHelp(false); });
            const explainButton = button('Explain this question', function () { return requestHelp(true); });
            notes.addEventListener('input', function () {
                if (!panelLive()) return;
                // Browser maxlength is not the memory boundary (paste/programmatic input).
                assistanceNotes.set(question.id, notes.value.slice(0, 4000));
                abortAssistance(); requestButton.disabled = false; explainButton.disabled = false; output.replaceChildren();
            });
            panel.append(explainButton, requestButton, button('Clear these notes', function () {
                if (!panelLive()) return;
                assistanceNotes.delete(question.id); notes.value = ''; abortAssistance();
                requestButton.disabled = false; explainButton.disabled = false; output.replaceChildren(); notes.focus();
            }), output);
        }
        function renderAssessmentQuestion() {
            if (!live()) return;
            const index = content.querySelector('select'); if (index) index.value = String(activeQuestion);
            renderQuestion(); const legend = questionRegion.querySelector('legend'); legend.tabIndex = -1; legend.focus();
        }
        function validateDraft(requireComplete) {
            errors = [];
            questions.forEach(function (question) {
                const value = drafts.get(question.id).value; const option = optionById.get(value.optionId);
                if (value.optionId === null && requireComplete) errors.push({ id: question.id, message: 'Choose an answer, including Unknown when appropriate.' });
                else if (option && !option.applicable && (!value.rationale || !validText(value.rationale.text))) errors.push({ id: question.id, message: textError(value.rationale && value.rationale.text, false) });
            });
            renderErrors(errors.length > 0); return !errors.length;
        }
        function answerErrorTarget(question) {
            return Array.from(questionRegion.querySelectorAll('textarea')).find(function (input) { return input.id === 'ncsc-rationale-' + question.id; }) ||
                Array.from(questionRegion.querySelectorAll('input')).find(function (input) { return input.id === 'ncsc-answer-' + question.id + '-' + question.responseOptionIds[0]; });
        }
        function applyInlineErrors() {
            if (!questionRegion) return;
            const question = questions[activeQuestion]; const error = errors.find(function (item) { return item.id === question.id; });
            if (!error) return;
            const message = node('p', 'ncsc-inline-error', error.message); message.id = 'ncsc-error-' + question.id; questionRegion.append(message);
            const rationale = questionRegion.querySelector('[id="ncsc-rationale-' + question.id + '"]');
            const inputs = rationale ? [rationale] : Array.from(questionRegion.querySelectorAll('input')).filter(function (input) { return input.type === 'radio'; });
            if (!rationale) {
                const fieldset = questionRegion.querySelector('fieldset');
                fieldset.setAttribute('aria-describedby', fieldset.getAttribute('aria-describedby') + ' ' + message.id);
            }
            inputs.forEach(function (input) {
                input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', ((input.getAttribute('aria-describedby') || '') + ' ' + message.id).trim());
            });
        }
        function renderErrors(focus) {
            if (!live() || !errorBox) return;
            errorBox.replaceChildren(); errorBox.hidden = !errors.length;
            if (errors.length) {
                errorBox.setAttribute('role', 'alert'); errorBox.append(node('h3', '', 'Please check these answers'));
                const list = node('ul'); errors.forEach(function (error) {
                    const question = questions.find(function (item) { return item.id === error.id; });
                    const row = node('li'); const link = node('a', '', (question ? 'Question ' + (questions.indexOf(question) + 1) : 'Assessment scope') + ': ' + error.message);
                    link.href = error.id === 'scope' ? '#ncsc-scope' : drafts.get(error.id).value.optionId === 'not_applicable'
                        ? '#ncsc-rationale-' + error.id : '#ncsc-answer-' + error.id + '-' + question.responseOptionIds[0];
                    link.addEventListener('click', function (event) {
                        event.preventDefault(); if (!live()) return;
                        if (error.id !== 'scope') { activeQuestion = questions.findIndex(function (item) { return item.id === error.id; }); renderAssessmentQuestion(); }
                        const input = error.id === 'scope' ? content.querySelector('textarea') : answerErrorTarget(question);
                        if (input) input.focus();
                    }); row.append(link); list.append(row);
                }); errorBox.append(list);
            }
            if (view === 'create') {
                const input = content.querySelector('textarea');
                if (input) {
                    if (errors.length) { input.setAttribute('aria-invalid', 'true'); errorBox.id = 'ncsc-scope-error'; input.setAttribute('aria-describedby', 'ncsc-scope-help ncsc-scope-error'); }
                    else { input.removeAttribute('aria-invalid'); input.setAttribute('aria-describedby', 'ncsc-scope-help'); }
                }
            }
            if (questionRegion && acknowledged) renderQuestion();
            if (focus && errors.length) errorBox.focus();
        }
        function planBatches(entries) {
            const batches = []; let batch = [];
            const sorted = entries.slice().sort(function (a, b) { return a.value.itemId < b.value.itemId ? -1 : a.value.itemId > b.value.itemId ? 1 : 0; });
            function size(items) { return client.commandByteLength({ assessmentId: selected, action: 'save', idempotencyKey: PLACEHOLDER, expectedRevision: SAVE_CEILING, payload: { responses: items.map(function (item) { return item.value; }) } }); }
            sorted.forEach(function (entry) {
                if (size([entry]) > LIMIT) throw new Error('single_answer_too_large');
                if (batch.length && size(batch.concat(entry)) > LIMIT) { batches.push(batch); batch = []; }
                batch.push({ value: copy(entry.value), generation: entry.generation });
            });
            if (batch.length) batches.push(batch);
            if (batches.length > SAVE_CEILING - acknowledged.revision) throw new Error('save_capacity_exceeded');
            return batches;
        }
        async function saveAll(drain) {
            if (!live() || !editable || !acknowledged || acknowledged.status === 'submitted' || busy || pending || conflict || !currentChecked) return false;
            const expected = epoch;
            do {
                if (!validateDraft(false)) return false;
                let batches;
                try { batches = planBatches(dirtyEntries()); }
                catch (error) { statusText = error.message === 'save_capacity_exceeded' ? 'There are not enough remaining save revisions for this draft. No new batch was sent.' : 'An answer cannot fit in a save request. Correct the draft; no text has been truncated.'; updateStatus(); return false; }
                for (const batch of batches) {
                    if (!live(expected) || pending || conflict) return false;
                    try {
                        const command = client.normaliseCommand({ assessmentId: selected, action: 'save', idempotencyKey: newId(), expectedRevision: acknowledged.revision, payload: { responses: batch.map(function (item) { return item.value; }) } });
                        if (!await perform(command, batch)) return false;
                    } catch (error) { if (live(expected)) fixedFailure(error); return false; }
                }
                if (!live(expected)) return false;
            } while (drain && dirtyEntries().length);
            return !dirtyEntries().length || !drain;
        }
        async function submitAssessment() {
            if (!live() || busy || pending || conflict || !currentChecked || !acknowledged || acknowledged.status === 'submitted' || !editable) return;
            if (!validateDraft(true)) return;
            const expected = epoch;
            if (!await saveAll(true) || !live(expected) || pending || dirtyEntries().length || !validateDraft(true)) return;
            try {
                const command = client.normaliseCommand({ assessmentId: selected, action: 'submit', idempotencyKey: newId(), expectedRevision: acknowledged.revision, payload: {} });
                await perform(command, []);
            } catch (error) { if (live(expected)) fixedFailure(error); }
        }
        async function perform(command, captures, retry) {
            if (!live() || busy || pending && !retry) return false;
            const expected = epoch;
            if (!retry) pending = { command: command, captures: captures, uncertain: false };
            const operation = pending; busy = true; statusText = ''; render();
            let failed = false;
            try {
                const result = await call(command.action, command, expected);
                if (!result || !live(expected) || pending !== operation) return false;
                const detail = cleanDetail(result.assessment, command.assessmentId);
                if (command.action === 'create') {
                    selected = command.assessmentId; acknowledged = detail; resetDrafts(); declaration = ''; view = 'assessment'; activeQuestion = 0;
                } else if (!acknowledged || detail.revision >= acknowledged.revision) {
                    const old = acknowledged; acknowledged = detail;
                    questions.forEach(function (question) {
                        const draft = drafts.get(question.id); const captured = captures.find(function (item) { return item.value.itemId === question.id; });
                        if (captured && draft.generation === captured.generation || !captured && equal(draft.value, savedAnswer(question.id, old))) {
                            drafts.set(question.id, { value: savedAnswer(question.id), generation: draft.generation });
                        }
                    });
                }
                pending = null; busy = false; errors = []; statusText = 'Saved revision ' + acknowledged.revision + '. ' + (dirtyEntries().length ? 'Newer edits are still unsaved.' : 'Your progress is saved.');
                if (operation.uncertain) {
                    if (!await refreshCurrent(false, expected)) return false;
                    statusText = conflict ? 'The current saved version differs from your draft. Choose how to continue.' : 'The operation is confirmed and the current saved version has been checked. Review any unsent changes before saving again.';
                }
                return !conflict;
            } catch (error) {
                if (!live(expected) || pending !== operation) return false;
                failed = true;
                busy = false;
                if (error && (error.statusCode === 403 || error.code === 'ncsc_access_denied')) { deny(); return false; }
                const ambiguous = !error || error.ambiguous === true || error.statusCode === 503 || ![400, 403, 404, 405, 409, 413].includes(error.statusCode);
                if (ambiguous) {
                    operation.uncertain = true; statusText = 'This operation is unconfirmed. Retry the same operation to establish its result. Unsent changes remain here.';
                } else {
                    pending = null;
                    if (error.statusCode === 409 && command.action !== 'create' && !['ncsc_quota_exceeded', 'ncsc_submission_unavailable'].includes(error.code)) await refreshCurrent(true, expected);
                    else fixedFailure(error);
                }
                return false;
            } finally {
                if (live(expected)) {
                    const focusFailure = failed && (doc.activeElement === heading || doc.activeElement === status) && !leave && view !== 'denied';
                    busy = false; render();
                    if (focusFailure) { status.tabIndex = -1; status.focus(); }
                }
            }
        }
        async function refreshCurrent(forceConflict, expected) {
            if (refreshing || !live(expected)) return false;
            refreshing = true;
            const before = acknowledged;
            const captured = new Map(Array.from(drafts.entries()).map(function (pair) { return [pair[0], { generation: pair[1].generation, value: copy(pair[1].value) }]; }));
            loading = true; currentChecked = false;
            try {
                const result = await call('read', selected, expected);
                if (!result) return false;
                const fresh = cleanDetail(result.assessment, selected);
                if (fresh.revision < acknowledged.revision) throw new Error('ncsc_revision_regressed');
                acknowledged = fresh;
                questions.forEach(function (question) {
                    const local = drafts.get(question.id); const original = captured.get(question.id);
                    const unchanged = local.generation === original.generation;
                    const wasClean = equal(original.value, savedAnswer(question.id, before));
                    if (unchanged && wasClean) drafts.set(question.id, { value: savedAnswer(question.id, fresh), generation: ++editGeneration });
                    else if (!equal(savedAnswer(question.id, before), savedAnswer(question.id, fresh)) && !equal(local.value, savedAnswer(question.id, fresh))) conflict = true;
                });
                conflict = conflict || forceConflict; currentChecked = true;
                return true;
            } catch (error) {
                if (live(expected)) { conflict = true; fixedFailure(error); statusText = 'The current saved version could not be checked. Reload it before making another change.'; }
                return false;
            } finally { if (live(expected)) { loading = false; refreshing = false; } }
        }
        function renderPending() {
            const panel = node('section', 'ncsc-warning');
            panel.append(node('h3', '', busy ? 'Operation in progress' : 'Operation unconfirmed'), node('p', '', 'The exact operation is retained in this view. Leaving cannot discard it while its result is unknown.'));
            if (!busy) panel.append(button('Retry same operation', function () { if (pending && !busy) perform(pending.command, pending.captures, true); }));
            content.append(panel);
        }
        function renderConflict() {
            const panel = node('section', 'ncsc-warning'); panel.append(node('h3', '', 'Saved answers need review'), node('p', '', 'Your unsaved answers are retained. Choose whether to reapply them to the current saved revision or use the saved answers.'));
            panel.append(button('Reload current saved answers', async function () { const expected = epoch; await refreshCurrent(true, expected); if (live(expected)) render(); }));
            if (acknowledged.status !== 'submitted') {
                const keep = button('Keep my draft on current revision', function () { if (!currentChecked) return; conflict = false; statusText = 'Draft retained on the current revision. Review it and save explicitly.'; render(); });
                keep.disabled = !currentChecked; panel.append(keep);
            }
            panel.append(button('Use saved answers', function () { resetDrafts(); conflict = !currentChecked; errors = []; statusText = 'Showing saved answers.'; render(); }, 'dashboard-text-button')); content.append(panel);
        }
        function hasDraft() { return view === 'create' ? declaration.length > 0 : dirtyEntries().length > 0; }
        function requestLeave(commit) {
            if (!live()) return Promise.resolve(false);
            if (leave) return leave.promise;
            if (pending || busy) { statusText = 'Resolve the running or unconfirmed operation before leaving this view.'; updateStatus(); return Promise.resolve(false); }
            if (!hasDraft()) { if (typeof commit === 'function') commit(); return Promise.resolve(true); }
            let resolve;
            const promise = new Promise(function (done) { resolve = done; });
            leave = { promise: promise, resolve: resolve, commit: commit, epoch: epoch, focus: doc.activeElement };
            renderLeave(); return promise;
        }
        function renderLeave() {
            if (!live() || !leave) return;
            removeDialog();
            dialog = node('dialog', 'ncsc-leave-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'ncsc-leave-title');
            const title = node('h3', '', 'Leave with unsaved changes?'); title.id = 'ncsc-leave-title';
            dialog.append(title, node('p', '', 'Save your changes, discard only the unsent draft, or stay here.'));
            const save = button('Save and leave', async function () {
                const decision = leave; if (!decision) return;
                save.disabled = true; discard.disabled = true;
                const ok = view === 'create' ? await createAssessment() : await saveAll(true);
                if (live(decision.epoch) && leave === decision) { decision.showErrors = !ok && errors.length > 0; finishLeave(ok); }
            });
            save.disabled = busy || !!pending;
            const discard = button('Discard unsent changes', function () { if (pending || busy) return; if (acknowledged) resetDrafts(); declaration = ''; errors = []; finishLeave(true); }, 'dashboard-text-button');
            const stay = button('Stay here', function () { finishLeave(false); }, 'dashboard-text-button');
            discard.disabled = busy || !!pending; dialog.append(save, discard, stay);
            dialog.addEventListener('keydown', function (event) {
                if (!live() || !leave) return;
                if (event.key === 'Escape') { event.preventDefault(); finishLeave(false); }
                if (event.key === 'Tab') {
                    const items = Array.from(dialog.querySelectorAll('button')).filter(function (item) { return !item.disabled; });
                    const index = items.indexOf(doc.activeElement); const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
                    event.preventDefault(); if (items[next]) items[next].focus();
                }
            });
            dialog.addEventListener('cancel', function (event) { event.preventDefault(); if (live() && leave) finishLeave(false); });
            root.append(dialog);
            if (typeof dialog.showModal !== 'function') {
                finishLeave(false); statusText = 'This browser cannot open the leave dialog. Save your changes before navigating.'; updateStatus(); return;
            }
            try { dialog.showModal(); stay.focus(); }
            catch (error) { finishLeave(false); statusText = 'The leave dialog could not open. Your draft remains here.'; updateStatus(); }
        }
        function removeDialog() {
            if (!dialog) return;
            if (dialog.open && typeof dialog.close === 'function') dialog.close();
            if (dialog.parentElement) dialog.parentElement.removeChild(dialog);
        }
        function finishLeave(allowed) {
            syncUnloadWarning();
            if (!leave) return;
            const decision = leave; leave = null;
            removeDialog(); dialog = null;
            if (live(decision.epoch)) {
                if (allowed && typeof decision.commit === 'function') decision.commit();
                else if (!allowed && decision.showErrors && errorBox && errors.length) errorBox.focus();
                else if (!allowed && decision.focus && typeof decision.focus.focus === 'function') {
                    let ancestor = decision.focus;
                    while (ancestor && ancestor !== root) ancestor = ancestor.parentElement;
                    if (ancestor === root) decision.focus.focus();
                    else { const target = questionRegion && questionRegion.querySelector('textarea') || root.querySelector('h2'); if (target) { target.tabIndex = -1; target.focus(); } }
                }
            }
            decision.resolve(allowed === true && live());
        }
        function destroy() {
            if (disposed) return;
            disposed = true; epoch += 1; abortRequests();
            syncUnloadWarning();
            if (leave) { leave.resolve(false); leave = null; }
            removeDialog(); dialog = null;
            pending = null; drafts.clear(); assistanceNotes.clear(); summaries = []; selected = null; acknowledged = null; declaration = ''; errors = []; workshopPanel = null;
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        }
        render();
        if (initialAssessmentId === undefined) loadList(false);
        else openAssessment(initialAssessmentId);
        return controller;
    }
    return Object.freeze({ mount: mount, resultModel: resultModel });
}));
