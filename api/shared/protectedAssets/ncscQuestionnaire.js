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
    // Each save uses one of an assessment's revisions. Automatic saves wait
    // for a short pause, so a burst of edits is one save, send pending answers
    // at once when the page is hidden or left or review opens, and stop early
    // enough to leave revisions for Save progress and Submit.
    const AUTOSAVE_IDLE_MS = 1500;
    // Browsers refuse keepalive requests whose bodies total more than 64 KiB.
    const KEEPALIVE_LIMIT = 60000;
    const AUTOSAVE_RESERVE = 27;
    // An automatic save whose outcome is unconfirmed (HTTP 503 or a network
    // failure) resends the identical command, with the same idempotency key
    // and expected revision, after each delay. The server returns the stored
    // result for a key it has already applied, so a resend never writes twice
    // and never uses another revision. After the last delay the person gets
    // the manual "Try the save again" panel as before.
    const AUTOSAVE_RETRY_DELAYS_MS = [1000, 3000];
    const ANSWER_GUIDANCE = {
        yes: 'All parts of this statement are in place across your declared scope.',
        partial: 'Some parts are in place, or only part of your scope is covered. Plans alone do not count.',
        no: 'None of this is in place yet, including when work is only planned.',
        unknown: 'You do not have enough information to confirm what is in place.',
        not_applicable: 'You believe this does not apply to your scope. Explain why. Not applicable answers count as not yet met, and they stay in your result. There is no review that changes that.',
        // Scoring v2 (#399): answers used only by profile 2026-11-18.1.
        partly: 'Some parts are in place, or only part of your scope is covered. Plans alone do not count.',
        ad_hoc: 'It happens sometimes, but it is not written down, owned or checked.',
        mfa_key: 'Important accounts sign in with a passkey or a physical security key.',
        mfa_number_matching: 'You approve each sign-in in an app by typing the number shown on screen.',
        mfa_push: 'You approve each sign-in by tapping a notification in an app.',
        mfa_authenticator: 'You type a code from an authenticator app.',
        mfa_text_code: 'You get a code by text message or email.',
        mfa_mixed: 'At least one important account still uses a text or email code, even if others use something stronger.',
        mfa_none: 'Important accounts do not ask for an extra login step yet.'
    };
    const TILE_HINT = {
        yes: 'In place across your scope.', partial: 'Some parts are in place.', partly: 'Some parts are in place.',
        no: 'Planned or yet to start.', unknown: 'Not sure? You can check later.', not_applicable: 'Explain why it does not apply.',
        ad_hoc: 'Occasional and informal.', mfa_key: 'Passkey or physical key.', mfa_number_matching: 'Match a number in an app.',
        mfa_push: 'Approve an app notification.', mfa_authenticator: 'Enter a code from an app.',
        mfa_text_code: 'Enter a text or email code.', mfa_mixed: 'Includes text or email codes.', mfa_none: 'No extra sign-in step.'
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
            example: 'Payment changes are checked using a known phone number, but password and MFA resets are not independently checked. This matches Partial.',
            notApplicable: 'Not handling payments is not enough to make this whole question Not applicable. Explain why payment or bank-detail changes, password or MFA resets, account recovery and sensitive-data changes are all outside your declared scope. If you are unsure, choose Unknown.'
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
    // Scope builder (#605): choices compose the scope statement, so the saved
    // declaration stays plain text with the same limits and validation.
    const SCOPE_CHOICES = Object.freeze({
        headcount: ['Just me', '2 to 5 people', '6 to 20 people', '21 to 50 people', '51 to 200 people', 'More than 200 people'],
        sites: ['One site', 'Two sites', '3 to 5 sites', 'More than 5 sites', 'No fixed site'],
        people: ['Owners and directors', 'Office staff', 'Site or field staff', 'Contractors', 'Volunteers'],
        devices: ['Laptops', 'Desktop computers', 'Shared office computer', 'Company phones', 'Personal phones used for work', 'Tablets', 'Till or EFTPOS', 'Servers', 'Printers and scanners', 'Cameras and smart devices'],
        services: ['Microsoft 365', 'Google Workspace', 'Xero', 'MYOB', 'Online banking', 'Website', 'Online shop', 'Booking system', 'Customer database or CRM', 'Cloud file storage'],
        excluded: ['Staff personal phones', 'Guest Wi-Fi', 'Systems another company runs', 'Home networks']
    });
    const SCOPE_GROUPS = [['people', 'Who is included'], ['devices', 'Devices'], ['services', 'Online services'], ['excluded', 'Leaving out']];
    const KEEP_CASE = /^(Microsoft|Google|Xero|MYOB|EFTPOS|CRM|Wi-Fi)/;
    function emptyScopeChoices() {
        return { headcount: '', sites: '', homeWorking: false, people: [], devices: [], services: [], excluded: [], otherServices: '' };
    }
    function listText(items) {
        const words = items.map(item => item.split(' ').map(word => KEEP_CASE.test(word) ? word : word.toLowerCase()).join(' '));
        if (words.length < 2) return words.join('');
        // An item that already contains "and" gets a serial comma so the list still reads clearly.
        const last = words.some(word => word.includes(' and ')) ? ', and ' : ' and ';
        return words.slice(0, -1).join(', ') + last + words[words.length - 1];
    }
    function composeScope(choices) {
        const lines = [], services = choices.services.concat(choices.otherServices.split(',').map(item => item.trim()).filter(Boolean));
        if (choices.headcount || choices.people.length) lines.push('People: ' + [choices.headcount, choices.people.length ? listText(choices.people) : ''].filter(Boolean).join(': ') + '.');
        if (choices.devices.length) lines.push('Devices: ' + listText(choices.devices) + '.');
        if (choices.sites || choices.homeWorking) lines.push('Places: ' + [choices.sites ? choices.sites.toLowerCase() : '', choices.homeWorking ? 'people working from home' : ''].filter(Boolean).join(', plus ') + '.');
        if (services.length) lines.push('Online services: ' + listText(services) + '.');
        if (choices.excluded.length) lines.push('Not included: ' + listText(choices.excluded) + '.');
        return lines.map(line => line.charAt(0).toUpperCase() + line.slice(1)).join('\n');
    }
    function scopeSectionsDone(choices) {
        return [choices.headcount || choices.people.length, choices.devices.length, choices.sites || choices.homeWorking,
            choices.services.length || choices.otherServices.trim(), choices.excluded.length].filter(Boolean).length;
    }
    const SCOPE_DESCRIBED_BY = 'ncsc-scope-note ncsc-scope-help';
    const PROFILE_FIELDS = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
    // Scoring v2 (#399): the 16-question profile 2026-11-18.1 and the graded
    // evaluator 2026-11-17.1 that scores it. A result is checked against these
    // only when its stored profile reference equals V2_PROFILE_REF on every
    // field. Weights and credits are pinned here, as the accepted profile's are
    // below, so a payload cannot authorise different ones. Tests compare them
    // with the server profile and evaluator.
    const V2_PROFILE_REF = Object.freeze({ frameworkId: 'nz-ncsc-cyber-security-framework', frameworkVersion: 'beta-verified-2026-09-02',
        profileId: 'nz-ncsc-mcss-2025-v3-sme', profileVersion: '2026-11-18.1',
        catalogueSha256: 'c90e999f627308f326a403b1d779e68087e3eaadab5149070f1df5e350daa537',
        sourceCatalogueSha256: 'c6120192675c9d12cdab296d6f5a84f014d613b300001394790f3ccf79692b71' });
    const V2_PROVENANCE = Object.freeze({ scoreContractVersion: 'PROD-003-R2', evaluatorVersion: '2026-11-17.1',
        evaluatorSourceSha256: '96a19bc4059932c8c34fae576db2efbfad445831aeba74d8a5c9f53042def885',
        weightSetVersion: 'prod-003-r2-profile-integer-weights-graded-credit-v1',
        mappingSha256: '9877a0686a213b7777f1f135214a759505646d414d0bdd5f30a39ac8970e4663',
        weightSetSha256: 'b07f5c271f7fdd0eeca60a9841a8d6380a739464e064da83fe7c2134f326b80d',
        scoredAtomSetSha256: '00e7045f784b3be45523e5341c16016d196e94fda14f377e5e0e48e60da74f6f',
        applicabilityBasisSha256: '88793977aebd91833cd806f85505cd53b0568a6bb5e4b45e08c4d56bd906f1eb',
        evidenceSnapshotSha256: '44c075f260001b52983f4bc93ec3d2f6082b00153032826706ddcefc209d8742',
        riskContextSnapshotSha256: '1c7078ff4cf2961c9dae0c9368db7e7b06f46e7896bdd98215aa36add9ba9e30' });
    const V2_WEIGHT = Object.freeze({ 'NF-NCSC-MCSS-RM-01-Q1': 1, 'NF-NCSC-MCSS-SA-01-Q1': 2, 'NF-NCSC-MCSS-AI-01-Q1': 1,
        'NF-NCSC-MCSS-PA-01-Q1': 2, 'NF-NCSC-MCSS-MF-01-Q1': 3, 'NF-NCSC-MCSS-MF-01-Q2': 2, 'NF-NCSC-MCSS-DU-01-Q1': 1,
        'NF-NCSC-MCSS-LP-01-Q1': 2, 'NF-NCSC-MCSS-DR-01-Q1': 3, 'NF-NCSC-MCSS-DR-01-Q2': 3, 'NF-NCSC-MCSS-RP-01-Q1': 1,
        'NF-NCSC-CC-PM-01-Q1': 2, 'NF-NCSC-CC-SV-01-Q1': 3, 'NF-NCSC-CC-NS-01-Q1': 1, 'NF-NCSC-CC-SU-01-Q1': 2, 'NF-NCSC-CC-EM-01-Q1': 2 });
    // Credit in hundredths for each answer that earns a fixed credit. "I don't
    // know" and Not applicable earn none at the lower end and full at the upper.
    const V2_CREDIT = Object.freeze({ yes: 100, partly: 50, ad_hoc: 25, no: 0, mfa_key: 100, mfa_number_matching: 85,
        mfa_push: 70, mfa_authenticator: 55, mfa_text_code: 30, mfa_mixed: 30, mfa_none: 0 });
    // How each v2 answer is grouped in summaries: full credit with Yes, none with No, the rest with Partial.
    // The accepted profile's answers map to themselves.
    function answerGroup(optionId) {
        if (!Object.hasOwn(V2_CREDIT, optionId)) return optionId;
        return V2_CREDIT[optionId] === 100 ? 'yes' : V2_CREDIT[optionId] === 0 ? 'no' : 'partial';
    }
    function isV2(metadata) { return !!metadata && profileMatches(metadata.profileRef, V2_PROFILE_REF); }
    // UX log A-019: when fewer than about half the questions are answered Yes,
    // Partial or No, the range is too wide to tell anyone anything, so it is
    // not used as the headline. Display only; scoring is unchanged.
    const ESTIMATE_MIN_ANSWERED_SHARE = 0.5;
    function enoughAnswersToEstimate(result) {
        return !!result && result.total > 0 && result.completed / result.total >= ESTIMATE_MIN_ANSWERED_SHARE;
    }
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
    function localDate(value) {
        return new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Pacific/Auckland' }).format(new Date(value)) + ' NZ time';
    }
    // Plain-text summary of a submitted assessment for an IT provider. The
    // results view and the Overview share it, so both copy the same text.
    // Grouped by answer (No, Partial, Unknown, Not applicable), not by risk.
    // gaps (optional): the ranked top gaps shown on screen. Gaps listed there
    // lead the summary in that order, so the IT-provider copy matches (#441).
    function providerSummary(assessment, metadata, gaps) {
        const ranked = new Map((Array.isArray(gaps) ? gaps : []).map(function (gap, index) { return [gap.itemId, index]; }));
        const rank = function (id) { return ranked.has(id) ? ranked.get(id) : Infinity; };
        const labels = new Map(metadata.responseOptions.map(function (item) { return [item.id, item.label]; }));
        const optionOf = function (id) { const response = assessment.responses.find(function (item) { return item.itemId === id; }); return response ? response.optionId : null; };
        const items = [];
        // Accepted profile: gaps (No and Partial) follow the same order as "Your
        // top three gaps": priority tier, then No before Partial, then question
        // order (#441 M1-12, M1-13). Scoring v2 ranks by saved weight, which is
        // not in the metadata, so v2 keeps grouping by answer (No, then Partial).
        // Answers to check follow, Unknown then Not applicable.
        const v2 = isV2(metadata);
        const gapQuestions = metadata.questions.map(function (question, position) { return { question: question, position: position, group: answerGroup(optionOf(question.id)) }; })
            .filter(function (entry) { return Object.hasOwn(GAP_RANK, entry.group); })
            .sort(function (a, b) { return (rank(a.question.id) - rank(b.question.id) || 0) || (v2 ? 0 : gapTier(a.question.id) - gapTier(b.question.id)) || GAP_RANK[a.group] - GAP_RANK[b.group] || a.position - b.position; });
        [['gap', gapQuestions], ['unknown'], ['not_applicable']].forEach(function (pass) {
            const entries = pass[1] || metadata.questions.filter(function (question) { return answerGroup(optionOf(question.id)) === pass[0]; })
                .map(function (question) { return { question: question, group: pass[0] }; });
            entries.forEach(function (entry) {
                const question = entry.question, optionId = entry.group;
                const control = metadata.controls.find(function (item) { return item.id === question.controlId; });
                const action = optionId === 'unknown' ? 'Not sure? No Fries can check what is in place with you.' : optionId === 'not_applicable' ? 'Not sure this applies? No Fries can confirm it with you.' : question.smallBusiness && question.smallBusiness.checks.join(' ') || question.guidance && question.guidance.startingActions && question.guidance.startingActions[0] || 'Talk to No Fries about the next improvement.';
                const ownerStart = ['no', 'partial'].includes(optionId) && /^NF-NCSC-MCSS-(RM|SA|AI|RP)-01-Q1$|^NF-NCSC-CC-SV-01-Q1$/.test(question.id);
                items.push({ title: (control ? control.title : question.prompt) + ' — ' + labels.get(optionOf(question.id)), action: action,
                    owner: ownerStart ? 'You can start this with your team.' : '' });
            });
        });
        const lines = ['Cyber security assessment', 'Scope: ' + assessment.scopePopulation.description, 'Submitted: ' + localDate(assessment.submission.submittedAt), 'Self-reported gaps; not a risk ranking or certification.'];
        return { items: items, text: lines.concat(items.map(function (item) { return item.title + ': ' + (item.owner ? item.owner + ' ' : '') + item.action; })).join('\n') };
    }
    // Plain-text summary of a submitted assessment for a board or insurer
    // (#441): what is in place, partly in place, not in place and not yet
    // known, by control, in the customer's own words. Self-reported, so it
    // says so, and the next-step line is left for the customer to fill in.
    // gaps: the ranked top gaps shown on screen (#441 M1-13). The board summary
    // opens with them, in the same order, before the answers grouped by status.
    // #733: the earlier submitted assessment on the same questions, if the
    // caller could load it. Returns null for anything that is not one.
    function earlierSubmission(assessment, previous) {
        if (!previous || !Array.isArray(previous.responses) || !previous.submission || !previous.submission.submittedAt ||
            previous.assessmentId === assessment.assessmentId || !profileMatches(previous.profileRef, assessment.profileRef) ||
            !(Date.parse(previous.submission.submittedAt) < Date.parse(assessment.submission.submittedAt))) return null;
        return previous;
    }
    // #696: scoring v2 has controls with two questions (backups and restore
    // tests; MFA coverage and method). A bare control title then appears twice,
    // under two different answers. Name the part each question covers; an
    // unknown two-question control falls back to its question number.
    const QUESTION_ASPECT = Object.freeze({
        'NF-NCSC-MCSS-MF-01-Q1': 'coverage', 'NF-NCSC-MCSS-MF-01-Q2': 'method',
        'NF-NCSC-MCSS-DR-01-Q1': 'backups', 'NF-NCSC-MCSS-DR-01-Q2': 'restore tests'
    });
    function questionTitle(metadata, question, base) {
        const siblings = metadata.questions.filter(function (item) { return item.controlId === question.controlId; });
        if (siblings.length < 2) return base;
        return base + ': ' + (QUESTION_ASPECT[question.id] || 'question ' + (siblings.indexOf(question) + 1));
    }
    function boardSummary(assessment, metadata, gaps, previousInput) {
        const optionOf = function (id) { const response = assessment.responses.find(function (item) { return item.itemId === id; }); return response ? response.optionId : null; };
        const previous = earlierSubmission(assessment, previousInput);
        const groups = [['yes', 'In place'], ['partial', 'Partly in place'], ['no', 'Not in place yet'], ['unknown', 'Not yet confirmed'], ['not_applicable', 'Marked not applicable (to be confirmed)']];
        const lines = ['Cyber security position: summary for the board or insurer', 'Scope: ' + assessment.scopePopulation.description,
            'Assessed: ' + localDate(assessment.submission.submittedAt),
            ...(previous ? ['This summary updates and supersedes the summary assessed ' + localDate(previous.submission.submittedAt) + '.'] : []),
            'Basis: self-assessment using the No Fries questionnaire adapted from New Zealand NCSC guidance. Not certification or independent assurance.'];
        if (Array.isArray(gaps) && gaps.length) lines.push('', 'What needs attention first:', ...gaps.map(function (gap, index) { return (index + 1) + '. ' + gap.title + ' (your answer: ' + gap.answer + ')'; }));
        if (previous) {
            // The answers that moved, in question order, by plain title (#733).
            const label = function (optionId) { const option = (metadata.responseOptions || []).find(function (item) { return item.id === optionId; }); return option ? option.label : 'Not answered'; };
            const earlierOf = function (id) { const response = previous.responses.find(function (item) { return item.itemId === id; }); return response ? response.optionId : null; };
            const changes = metadata.questions.filter(function (question) { return earlierOf(question.id) !== optionOf(question.id); }).map(function (question) {
                const control = metadata.controls.find(function (item) { return item.id === question.controlId; });
                const title = questionTitle(metadata, question, (control ? control.title : question.prompt).replace(/^No Fries Critical Control extension — /, ''));
                return '- ' + title + ': ' + label(earlierOf(question.id)) + ' → ' + label(optionOf(question.id));
            });
            lines.push('', 'Changes since the previous assessment:', ...(changes.length ? changes : ['- No answers changed.']));
        }
        groups.forEach(function (group) {
            const titles = [];
            metadata.questions.filter(function (question) { return answerGroup(optionOf(question.id)) === group[0]; }).forEach(function (question) {
                const control = metadata.controls.find(function (item) { return item.id === question.controlId; });
                // Plain titles for a board: drop the internal extension prefix.
                const title = questionTitle(metadata, question, (control ? control.title : question.prompt).replace(/^No Fries Critical Control extension — /, ''));
                if (titles.indexOf(title) === -1) titles.push(title);
            });
            if (titles.length) lines.push('', group[1] + ':', ...titles.map(function (title) { return '- ' + title; }));
        });
        lines.push('', 'Next steps agreed (owner and date): ');
        return { text: lines.join('\n') };
    }
    // Read-only suggestions for the current catalogue, never evidence or scores.
    // For v1, narrower questions cannot inherit a broader Partial answer. For
    // v2, report the actual question and its saved label, not its scoring credit.
    function questionnaireAnswers(assessment, metadata) {
        const title = 'Answers for your insurer or customer questionnaire';
        const footer = 'These are self-assessed answers to check before submitting, not a guarantee an insurer or customer accepts them.';
        const v2 = isV2(metadata);
        const supported = assessment.status === 'submitted' && profileMatches(assessment.profileRef, metadata.profileRef) &&
            (v2 || metadata.profileRef.catalogueSha256 === '32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375');
        const definitions = [
            ['mfa', 'Is multi-factor authentication (MFA) required for business email and remote access?', 'NF-NCSC-MCSS-MF-01-Q1', false,
                'Require MFA for business email and every remote-access route, and check for exceptions.',
                'Ask IT for an MFA coverage report that includes exceptions for email and remote access.'],
            ['backup-storage', 'Do you keep an offline or immutable backup copy (one that cannot be changed or deleted)?', null, false,
                'Keep a backup copy offline or locked against changes and deletion, and confirm how it is protected.',
                'Ask the backup owner for the settings showing whether a copy is offline or locked against changes and deletion.'],
            ['restore-tests', 'Have you tested restoring important systems and files from backup?', 'NF-NCSC-MCSS-DR-01-Q1', false,
                'Restore samples of important systems and files, and record the results and recovery time.',
                'Check the last restore test record for what was recovered, the result and the time taken.'],
            ['patch-speed', 'Are urgent security updates installed within the deadline your insurer or customer asks for?', null, false,
                'Confirm the required deadline, install urgent fixes within it, and keep dated installation records.',
                'Get the installation dates from your patch report and compare them with the requested deadline.'],
            ['endpoint', 'Are work devices covered by endpoint protection and endpoint detection and response (EDR)?', null, false,
                'Confirm protection and EDR coverage for work devices, with someone responsible for responding to alerts.',
                'Ask IT for the device list showing which work devices have endpoint protection and EDR.'],
            ['training', 'Do staff receive ongoing guidance on spotting and reporting phishing and scams?', 'NF-NCSC-MCSS-SA-01-Q1', false,
                'Give staff practical phishing guidance when they start and refresh it, keeping completion records.',
                'Ask the training organiser for completion records covering phishing induction and refreshers.'],
            ['incident-plan', 'Do you have an incident response plan with named roles, contacts, management support and lessons from practice or incidents?', 'NF-NCSC-MCSS-RP-01-Q1', true,
                'Write down the response plan, agree roles and contacts, practise it and record improvements.',
                'Ask the incident lead for the current response plan and notes from the last exercise or incident.'],
            ['admin-rights', 'Is access limited to job needs, with separate admin accounts and checks when people join, change roles or leave?', 'NF-NCSC-MCSS-LP-01-Q1', true,
                'Limit access to job needs, separate admin accounts, and regularly review access and staff changes.',
                'Ask whoever manages accounts for the latest access review showing who has admin rights and why.'],
            ['payment-checks', 'Are payment and bank-detail changes checked through a trusted route separate from the original request?', 'NF-NCSC-CC-SV-01-Q1', false,
                'Check payment and bank-detail changes using a known phone number or another trusted, separate route.',
                'Ask accounts for a payment-change record showing the call to a known number or another independent check.']
        ];
        if (v2) definitions.push(
            // #702: every v2 answer reaches the pack, including the asset list.
            ['assets', '', 'NF-NCSC-MCSS-AI-01-Q1', true, '', 'Ask IT for the current list of important devices, software, cloud apps and data, with owners.'],
            ['supplier-access', '', 'NF-NCSC-CC-SU-01-Q1', true, '', 'Get the supplier access list, sign-in settings and written breach-notification terms.'],
            ['email-protection', '', 'NF-NCSC-CC-EM-01-Q1', true, '', 'Ask your email provider for the domain protection and phishing filter settings.']
        );
        const items = definitions.map(function ([id, question, source, allowPartial, action, evidence]) {
            if (v2 && id === 'backup-storage') source = 'NF-NCSC-MCSS-DR-01-Q1';
            if (v2 && id === 'restore-tests') source = 'NF-NCSC-MCSS-DR-01-Q2';
            // #702: v2 asks whether systems are kept up to date, not the insurer's
            // deadline; answer from it and say the deadline still needs confirming.
            const deadline = v2 && id === 'patch-speed';
            if (deadline) source = 'NF-NCSC-MCSS-PA-01-Q1';
            const sourceQuestion = source && metadata.questions.find(item => item.id === source);
            if (v2 && sourceQuestion && !deadline) {
                question = sourceQuestion.prompt;
                action = sourceQuestion.guidance.startingActions[0];
                allowPartial = true;
            }
            const responses = supported && sourceQuestion
                ? assessment.responses.filter(item => item.itemId === source) : [];
            const saved = responses.length === 1 ? responses[0].optionId : null;
            const option = v2 ? (sourceQuestion && sourceQuestion.responseOptionIds.includes(saved)
                ? ({ partly: 'partial', ad_hoc: 'partial' }[saved] || saved) : null) : saved;
            if (deadline) allowPartial = true;
            const notCovered = v2 && !source;
            const unknown = v2 && option === 'unknown';
            const answer = option === 'yes' ? 'Yes' : option === 'no' ? 'No' : option === 'partial' && allowPartial ? 'Partly'
                : notCovered ? 'Not covered by this check' : unknown ? 'Not confirmed' : v2 && option === 'not_applicable' ? 'Marked not applicable' : 'Not answered';
            const savedLabel = v2 && saved && metadata.responseOptions.find(item => item.id === saved);
            const basis = notCovered ? 'This check does not ask about this. Confirm it before answering.'
                : deadline && savedLabel ? 'From your answer to "kept up to date": ' + savedLabel.label + '. This check did not ask for your insurer\'s deadline, so confirm it.'
                : unknown ? 'Your saved answer: I don\'t know. Confirm this before answering.'
                : !source ? 'This assessment does not ask for this detail.'
                : option === 'partial' && !allowPartial ? 'The broader answer is Partial; it does not confirm this specific detail.'
                : option === 'not_applicable' ? 'Marked Not applicable in the assessment; this is not confirmation of the control.'
                : answer === 'Not answered' ? 'The saved answers do not confirm this detail.'
                : v2 ? 'Your saved answer: ' + metadata.responseOptions.find(item => item.id === saved).label + '.'
                : 'Based on your saved ' + (option === 'partial' ? 'Partial' : answer) + ' answer; check the exact coverage before using it.';
            return { id: id, question: question, answer: answer, basis: basis, action: 'To answer Yes: ' + action,
                evidence: answer === 'Yes' ? '' : 'What to gather: ' + evidence };
        });
        const scope = 'Scope: ' + assessment.scopePopulation.description;
        // v2 copies the answers only; "To answer Yes" and evidence stay on screen (#702).
        const lines = [title, scope, ...items.map(item => item.question + '\nSuggested answer: ' + item.answer + '\n' + item.basis +
            (v2 ? '' : '\n' + item.action + (item.evidence ? '\n' + item.evidence : ''))), footer];
        return { title: title, scope: scope, items: items, footer: footer, text: lines.join('\n\n') };
    }
    // Copies with the clipboard when the browser allows it; otherwise selects
    // the read-only text so the person can copy it themselves.
    function copySummary(win, input, status) {
        const clipboard = win && win.navigator && win.navigator.clipboard;
        const fallback = function () { input.focus(); if (typeof input.select === 'function') input.select(); status.textContent = 'Summary selected. Press Ctrl+C or Cmd+C to copy it.'; };
        if (!clipboard || typeof clipboard.writeText !== 'function') { fallback(); return; }
        Promise.resolve(clipboard.writeText(input.value)).then(function () { status.textContent = 'Summary copied.'; }, fallback);
    }
    // Read only the existing canonical source/medium/campaign tag in this tab.
    // Do not capture URL tags, normalise new values, persist or forward attribution.
    function resultsCampaign(win) {
        try {
            const tag = win.sessionStorage.getItem('nofries-enquiry-campaign');
            const match = typeof tag === 'string' && /^[a-z0-9._-]{1,40}\/[a-z0-9._-]{0,40}\/(insurance|supplier|board|scam)$/.exec(tag);
            return match ? match[1] : '';
        } catch (_) { return ''; }
    }
    // Shared with Overview so campaign presentation keeps the same copy, print,
    // enquiry availability and representative-details controls.
    // previous (#733): the earlier submitted assessment, or a promise of it.
    // The summary shows at once and gains the supersedes lines when it arrives.
    function boardSummaryBlock(node, button, win, detail, metadata, inputId, status, boardBlock = node('div', 'picture-board-summary'), addPlanControls, gaps, previous) {
        const boardLabel = node('label', '', 'Summary for your board or insurer');
        const board = node('textarea', 'ncsc-textarea'); board.id = inputId; boardLabel.htmlFor = board.id;
        const settled = previous && typeof previous.then === 'function' ? null : previous;
        board.readOnly = true; board.rows = 8; board.value = boardSummary(detail, metadata, gaps, settled).text;
        const boardPrinted = node('pre', 'picture-summary-print picture-board-print', board.value); boardPrinted.setAttribute('aria-hidden', 'true');
        if (previous && typeof previous.then === 'function') previous.then(function (value) {
            if (!earlierSubmission(detail, value)) return;
            const text = boardSummary(detail, metadata, gaps, value).text;
            if (typeof rebase === 'function') rebase(text); else { board.value = text; boardPrinted.textContent = text; }
        }, function () { /* Without the earlier result the summary stays as shown. */ });
        const boardCopy = button('Copy board summary', () => copySummary(win, board, status));
        boardCopy.classList.add('dashboard-button-secondary'); boardBlock.append(boardLabel, board, boardPrinted);
        const boardPrint = win && typeof win.print === 'function' ? button('Print board summary', () => printOnly(win, boardPrinted)) : null;
        const rebase = addPlanControls ? addPlanControls(board, boardPrinted, boardCopy, boardPrint) : null;
        boardBlock.append(boardCopy);
        if (boardPrint) { boardPrint.classList.add('dashboard-button-secondary'); boardBlock.append(boardPrint); }
        return boardBlock;
    }
    // "Your top three gaps": display-only over a result the validator already
    // accepted. No re-scoring and no model call. Fixed rule:
    //   1. A gap is a question saved as "no" (not in place) or "partial".
    //      Unknown and not-applicable answers are unresolved, not gaps.
    //   2. Higher existing profile weight first (the accepted profile weights
    //      every question 1, so this does not reorder today).
    //   3. Fixed priority tier (GAP_TIER): the controls that stop the most
    //      common attacks on small businesses (account takeover, ransomware,
    //      invoice fraud) first. Display order only; scores are unchanged.
    //   4. "no" before "partial", matching the saved credit (0 before 1).
    //   5. Then accepted profile question order.
    const GAP_LIMIT = 3;
    // Tier 1: MFA, patching, data recovery, sensitive-request (payment change) checks.
    // Tier 2: least privilege, password manager, awareness, secure configuration.
    // Anything else, including future questions, is tier 3.
    const GAP_TIER = Object.freeze({ MF: 1, PA: 1, DR: 1, SV: 1, LP: 2, PM: 2, SA: 2, SC: 2 });
    const gapTier = itemId => {
        const code = /^NF-NCSC-(?:MCSS|CC)-([A-Z]{2})-\d\d-Q\d+$/.exec(itemId);
        return code && Object.hasOwn(GAP_TIER, code[1]) ? GAP_TIER[code[1]] : 3;
    };
    const GAP_RANK = Object.freeze({ no: 0, partial: 1 });
    const V2_GAP_LIMIT = 5;
    const V2_GAP_FACTOR = Object.freeze({ no: 100, unknown: 85, ad_hoc: 75, partly: 50, mfa_none: 100,
        mfa_text_code: 70, mfa_mixed: 70, mfa_authenticator: 45, mfa_push: 30, mfa_number_matching: 15 });
    const V2_CRITICAL_CONTROL = /^NF-NCSC-CC-(?:PM|SV|NS)-01-Q\d+$/;
    // A v2 answer that falls short of full credit, other than "I don't know".
    const v2Shortfall = optionId => Object.hasOwn(V2_GAP_FACTOR, optionId) && optionId !== 'unknown';
    const attention = row => (row.weight || 0) * V2_GAP_FACTOR[row.responseOptionId];
    const GAP_WHY = 'This control helps lower the chance or impact of a cyber incident for your business.';
    const GAP_NEXT = 'Agree who will look at this control and when you will check it again.';
    // #714: "Why it matters" on a v2 gap names the business harm in one plain
    // sentence. The profile's guidance summary is answering help for the form,
    // so it is not shown on results. Wording approved by the owner in review.
    const V2_GAP_WHY = Object.freeze({
        'NF-NCSC-MCSS-RM-01-Q1': 'Risks nobody owns tend to get no budget or attention until something goes wrong.',
        'NF-NCSC-MCSS-SA-01-Q1': 'Many attacks start with a message that tricks a staff member. People who know the signs can stop one before it costs money.',
        'NF-NCSC-MCSS-AI-01-Q1': 'You can\'t protect or update a device, app or data set you don\'t know you have, and forgotten ones are easy targets.',
        'NF-NCSC-MCSS-PA-01-Q1': 'Attackers use known flaws in out-of-date software to break in. Updates close those flaws.',
        'NF-NCSC-MCSS-MF-01-Q1': 'A stolen or guessed password is enough to take over an account unless a second login step stands in the way.',
        'NF-NCSC-MCSS-MF-01-Q2': 'Text and email codes can be intercepted or tricked out of people. Passkeys and security keys are much harder to steal.',
        'NF-NCSC-MCSS-DU-01-Q1': 'Without activity records and alerts, a break-in can go unnoticed for weeks and you can\'t tell what was taken.',
        'NF-NCSC-MCSS-LP-01-Q1': 'The more each account can reach, the more damage a stolen login or a mistake can do.',
        'NF-NCSC-MCSS-DR-01-Q1': 'If ransomware, theft or a fault wipes your files, a backup the attacker can\'t reach is how you get the business running again.',
        'NF-NCSC-MCSS-DR-01-Q2': 'A backup that has never been restored may not work when you need it. Testing shows how long recovery really takes.',
        'NF-NCSC-MCSS-RP-01-Q1': 'In the first hours of an incident, not knowing who to call or what to do costs time, money and data.',
        'NF-NCSC-CC-PM-01-Q1': 'Reused or shared passwords mean one leaked login can open several accounts. A password manager makes unique passwords practical.',
        'NF-NCSC-CC-SV-01-Q1': 'Scammers pose as suppliers, managers or staff to get bank details or logins changed. A second check stops the payment or reset going to them.',
        'NF-NCSC-CC-NS-01-Q1': 'A router with its default password, or Wi-Fi shared with guests, gives a stranger a way into your business systems.',
        'NF-NCSC-CC-SU-01-Q1': 'A supplier\'s stolen login can become a way into your data. Limits and an extra login step reduce what an attacker can reach.',
        'NF-NCSC-CC-EM-01-Q1': 'If others can send email that looks like yours, your customers and staff can be tricked into paying or sharing logins.'
    });
    const gapWhy = (metadata, question) => isV2(metadata) && V2_GAP_WHY[question.id] ||
        firstText(question.guidance && question.guidance.summary) || GAP_WHY;
    const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim()) || null;
    function rankedGaps(result, metadata) {
        if (!result || !Array.isArray(result.domains) || !metadata || !Array.isArray(metadata.questions)) return [];
        const rows = new Map();
        result.domains.forEach(domain => (domain.controls || []).forEach(control =>
            (control.questions || []).forEach(row => rows.set(row.itemId, row))));
        const controls = new Map((metadata.controls || []).map(control => [control.id, control]));
        const entries = metadata.questions.map((question, position) => ({ question, position, row: rows.get(question.id) }));
        const ranked = isV2(metadata)
            ? entries.filter(entry => entry.row && Object.hasOwn(V2_GAP_FACTOR, entry.row.responseOptionId))
                .sort((a, b) => attention(b.row) - attention(a.row) || (b.row.weight || 0) - (a.row.weight || 0) ||
                    Number(V2_CRITICAL_CONTROL.test(b.question.id)) - Number(V2_CRITICAL_CONTROL.test(a.question.id)) ||
                    a.position - b.position)
            : entries.filter(entry => entry.row && Object.hasOwn(GAP_RANK, entry.row.responseOptionId))
                .sort((a, b) => (b.row.weight || 0) - (a.row.weight || 0) ||
                    gapTier(a.question.id) - gapTier(b.question.id) ||
                    GAP_RANK[a.row.responseOptionId] - GAP_RANK[b.row.responseOptionId] || a.position - b.position);
        return ranked.map(({ question, row }) => {
            const control = controls.get(question.controlId), guidance = question.guidance || {};
            const plain = question.smallBusiness || {};
            const title = firstText(control && control.title, question.prompt);
            return { itemId: question.id, title: questionTitle(metadata, question, title.split(' — ').pop()), answer: row.answer,
                responseOptionId: row.responseOptionId,
                firstCheck: firstText((plain.checks || [])[0], (guidance.startingActions || [])[0]) || GAP_NEXT,
                why: gapWhy(metadata, question),
                next: firstText(plain.meaning, (guidance.startingActions || [])[0]) || GAP_NEXT };
        });
    }
    // The accepted profile shows three gaps; v2 shows up to five.
    function topGaps(result, metadata, limit) {
        return rankedGaps(result, metadata).slice(0, limit === undefined ? isV2(metadata) ? V2_GAP_LIMIT : GAP_LIMIT : limit);
    }
    // Scoring v2 only: "I don't know" answers that miss the top five. Empty for
    // the accepted profile, where unknown answers are not gaps.
    function confirmNext(result, metadata) {
        if (!isV2(metadata)) return [];
        return rankedGaps(result, metadata).slice(V2_GAP_LIMIT).filter(gap => gap.responseOptionId === 'unknown');
    }
    function rankedGapSection(node, result, metadata, headingId, controls, gaps = topGaps(result, metadata), help = GAP_HELP) {
        const v2 = isV2(metadata);
        const unconfirmed = v2 ? confirmNext(result, metadata) : [];
        const section = node('section', 'picture-top-gaps');
        const heading = node('h3', '', v2 ? gaps.length === V2_GAP_LIMIT ? 'Your top five gaps' : 'Your top gaps'
            : gaps.length === GAP_LIMIT ? 'Your top three gaps' : 'Your top gaps');
        heading.id = headingId; heading.tabIndex = -1; section.setAttribute('aria-labelledby', heading.id); section.append(heading);
        if (!gaps.length && v2) {
            section.append(node('p', '', 'None of your answers show a gap to fix first.'));
            return section;
        }
        if (!gaps.length) {
            section.append(node('p', '', 'You did not report any controls as not in place or partly in place.'));
            if (result.unknown > 0) section.append(node('p', 'dashboard-muted', result.unknown + (result.unknown === 1 ? ' answer is' : ' answers are') +
                ' still unknown or to confirm. Confirm ' + (result.unknown === 1 ? 'it' : 'them') + ' to check for gaps.'));
            return section;
        }
        section.append(node('p', 'dashboard-muted', v2
            ? 'Start with the first gap below. Gaps are ordered by how much each question counts and how far your answer is from fully in place. "I don\'t know" counts as a gap. This is a No Fries planning list from your answers, not an official NCSC priority.'
            : 'Start with the first gap below. Account sign-in checks, updates, backups and payment checks come first. The order is a guide based on your answers.'));
        section.append(node('p', 'picture-gap-help', help));
        const list = node('ol', 'picture-top-gaps-list');
        gaps.forEach(gap => {
            const item = node('li', 'picture-top-gap'); item.dataset.gapItem = gap.itemId;
            const why = node('p'), next = node('p');
            why.append(node('strong', '', 'Why it matters: '), node('span', '', gap.why));
            // Lead with the first specific check, not the restated question (#441 RANGI-13).
            next.append(node('strong', '', 'What to do next: '), node('span', '', gap.firstCheck));
            const ownerStart = /^NF-NCSC-MCSS-(RM|SA|AI|RP)-01-Q1$|^NF-NCSC-CC-SV-01-Q1$/.test(gap.itemId);
            item.append(node('h4', '', gap.title), node('p', 'dashboard-muted', 'Your answer: ' + gap.answer));
            // #714: the help line shows once above the list, not on every card.
            if (ownerStart) item.append(node('p', 'picture-gap-owner', 'You can start this with your team.'));
            item.append(why, next);
            if (controls) item.append(...controls(gap));
            list.append(item);
        });
        section.append(list);
        if (v2 && unconfirmed.length) {
            const confirm = node('section', 'picture-confirm-next');
            const confirmHeading = node('h4', '', 'Confirm these next');
            confirmHeading.id = headingId + '-confirm-next'; confirm.setAttribute('aria-labelledby', confirmHeading.id);
            const confirmList = node('ul', 'picture-confirm-next-list');
            unconfirmed.forEach(gap => {
                const item = node('li', '', gap.title); item.dataset.gapItem = gap.itemId; confirmList.append(item);
            });
            confirm.append(confirmHeading, node('p', 'dashboard-muted', 'You answered "I don\'t know" to ' +
                (unconfirmed.length === 1 ? 'this question' : 'these questions') + '. Find out what is in place, because ' +
                (unconfirmed.length === 1 ? 'it' : 'each one') + ' counts as a gap until you do.'), confirmList);
            section.append(confirm);
        }
        return section;
    }
    const campaignOfferBridge = {
        scam: 'A fake invoice can start with a compromised mailbox. Once you have verified the payment details, MFA, email protection and staff awareness can help reduce the risk of another scam.',
        insurance: 'For renewal, use your gaps to choose a next step, such as testing a backup, enabling MFA or catching up on patches. Record what changed so your renewal answers reflect the work done.',
        supplier: 'Use any gaps behind your questionnaire answers to choose an improvement. For example, review access to customer files and keep the updated access list as evidence for your next answer.',
        board: 'Choose a practical improvement from your top gaps. The written progress summary can show your board what changed and what still needs attention.'
    };
    // Owner direction (28 Nov 2026): point people to No Fries for fixing gaps.
    const GAP_HELP = 'No Fries can help you fix any of these.';
    // #724: a consultant reads these pages on behalf of an organisation, so the
    // copy does not address them as its owner. The loader sets the account type
    // on <body>; it cannot yet tell a consultant's own workspace from a client's,
    // so the wording fits both.
    const CONSULTANT_GAP_HELP = 'You can plan these with this organisation in the Improvement Plan.';
    const consultantViewer = doc => Boolean(doc && doc.body && doc.body.dataset && doc.body.dataset.dashboardAccountType === 'consultant');
    const gapHelp = doc => consultantViewer(doc) ? CONSULTANT_GAP_HELP : GAP_HELP;
    // #657: the standing offer and its price, as on /pricing. One place for the dashboard copy.
    const MANAGED_SECURITY_PRICE = 'NZ$1,250 + GST';
    const MANAGED_SECURITY_OFFER = 'No Fries can fix these with you: 90-day managed security, ' + MANAGED_SECURITY_PRICE + '.';
    function managedSecurityOffer(node, gated, win, stillCurrent, campaign) {
        const help = node('div', 'picture-next-steps-help'); help.hidden = true;
        const link = node('a', 'dashboard-button', 'Fix these with No Fries'); link.href = '/contact.html?service=managed_security_90';
        const pricing = node('a', '', 'See pricing and what’s included'); pricing.href = '/pricing#pricing-pilot';
        if (campaignOfferBridge[campaign]) help.append(node('p', '', campaignOfferBridge[campaign]));
        // The links only open public pages, so they are not behind the details gate.
        const actions = node('div', ''); actions.append(link, pricing);
        help.append(node('p', 'picture-offer', MANAGED_SECURITY_OFFER), actions,
            node('p', 'dashboard-muted', 'Opens the contact form with this service named. The contact form does not include your answers.'));
        enquiryAvailable(win).then(available => { if (available && stillCurrent()) help.hidden = false; });
        return help;
    }
    // Prints one block on its own (one A4 page for the board summary): every
    // sibling along its path to <body> is hidden for print only, then
    // restored. Nothing leaves the page.
    function printOnly(win, target) {
        const doc = target.ownerDocument;
        const hidden = [];
        for (let element = target; element && element.parentElement && element !== doc.body; element = element.parentElement) {
            Array.from(element.parentElement.children || []).forEach(sibling => {
                if (sibling !== element && !sibling.classList.contains('picture-print-hide')) { sibling.classList.add('picture-print-hide'); hidden.push(sibling); }
            });
        }
        target.classList.add('picture-print-only');
        try { win.print(); } finally {
            hidden.forEach(sibling => sibling.classList.remove('picture-print-hide'));
            target.classList.remove('picture-print-only');
        }
    }
    // Mirrors js/enquiry-availability.js: a bare read-only GET of the public
    // enquiry status. Any error, non-OK reply or 5-second timeout is unavailable.
    async function enquiryAvailable(win) {
        if (!win || typeof win.fetch !== 'function' || typeof win.AbortController !== 'function') return false;
        const controller = new win.AbortController();
        let timer;
        try {
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('unavailable')); }, 5000);
            });
            const read = (async () => {
                const response = await win.fetch('/api/enquiry', { method: 'GET', credentials: 'same-origin', cache: 'no-store',
                    signal: controller.signal, headers: { Accept: 'application/json' } });
                if (!response || !response.ok) return false;
                const body = await response.json();
                return !!body && body.available === true;
            })();
            return await Promise.race([read, deadline]);
        } catch (_) {
            return false;
        } finally {
            clearTimeout(timer); controller.abort();
        }
    }
    // The accepted NCSC profile's credit rule, in credit units (scale 2):
    // Yes earns full credit, Partial half and No none. Answers still to
    // confirm earn none at the lower end and full credit at the upper end.
    // resultModel checks server results against it; the review step uses it
    // only to preview a draft, never in place of a submitted score.
    function creditUnits(semantic, weight) {
        const lower = semantic === 'yes' ? weight * 2 : semantic === 'partial' ? weight : 0;
        return { lower: lower, upper: semantic === 'unknown' ? weight * 2 : lower };
    }
    // The evaluator's decimal-half-up-one-place-v1 rounding, in tenths of a percent.
    function percentTenths(numerator, denominator) {
        const scaled = BigInt(numerator) * 1000n, whole = BigInt(denominator);
        return Number(scaled / whole + (scaled % whole * 2n >= whole ? 1n : 0n));
    }
    function percentDisplay(tenths) { return (tenths / 10).toFixed(1) + '%'; }
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
            // Scoring v2 (#399): chosen by the stored profile reference, never by its version alone.
            const v2 = profileMatches(assessment.profileRef, V2_PROFILE_REF), scale = v2 ? 100 : 2;
            if (v2) requireValue(['scoreContractVersion', 'evaluatorVersion', 'evaluatorSourceSha256', 'weightSetVersion',
                'mappingSha256', 'weightSetSha256', 'scoredAtomSetSha256', 'applicabilityBasisSha256'].every(key => provenance[key] === V2_PROVENANCE[key]) &&
                provenance.roundingRule === 'decimal-half-up-one-place-v1' &&
                provenance.evaluatorId === 'no-fries-deterministic-assessment-evaluator' &&
                provenance.mappingVersion === 'framework-profile-question-mapping-v1' &&
                provenance.evidenceSnapshot.sha256 === V2_PROVENANCE.evidenceSnapshotSha256 &&
                provenance.riskContextSnapshot.sha256 === V2_PROVENANCE.riskContextSnapshotSha256 &&
                value.remediationPriority.status === 'not_calculated' && value.remediationPriority.reason === 'priority_adapter_required' &&
                value.trend.status === 'not_requested');
            else requireValue(provenance.scoreContractVersion === 'PROD-003-R1' &&
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
                requireValue(atom.applicable === true && atom.response === (v2 ? answerGroup(semantic) : semantic) && atom.responseOrigin === origin &&
                    atom.evidenceState === 'not_provided' && atom.applicabilityDecisionId === null && atom.applicabilityDecisionSha256 === null);
                if (v2) {
                    const hundredths = Object.hasOwn(V2_CREDIT, response.optionId) ? V2_CREDIT[response.optionId] : null;
                    const lower = atom.weight * (hundredths || 0);
                    requireValue(atom.weight === V2_WEIGHT[atom.itemId] && atom.responseCreditHundredths === hundredths &&
                        atom.lowerCreditUnits === lower && atom.upperCreditUnits === (hundredths === null ? atom.weight * 100 : lower));
                    return;
                }
                // The pinned accepted NCSC profile assigns weight 1 to every question.
                // Payload totals cannot authorise a different weight set.
                requireValue(atom.weight === 1);
                const credit = creditUnits(semantic, atom.weight);
                requireValue(atom.lowerCreditUnits === credit.lower && atom.upperCreditUnits === credit.upper);
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
                requireValue(attainment.creditUnitScale === scale && attainment.denominatorWeight === sum(rows, 'weight') &&
                    attainment.lowerCreditUnits === sum(rows, 'lowerCreditUnits') && attainment.upperCreditUnits === sum(rows, 'upperCreditUnits') &&
                    attainment.status === (rows.length ? 'scored' : 'not_scored'));
                count(attainment.denominatorWeight * scale);
                percentageMatches(attainment.lowerCreditUnits, attainment.denominatorWeight * scale, attainment.lowerPercentTenths);
                percentageMatches(attainment.upperCreditUnits, attainment.denominatorWeight * scale, attainment.upperPercentTenths);
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
            // Provenance stays in the stored record and API. It is checked here but not shown to customers.
            [provenance.organisationId, provenance.scoreAsOf, provenance.evaluatorId, provenance.evaluatorVersion,
                provenance.roundingRule, ...PROFILE_FIELDS.map(key => provenance.profileRef[key]),
                provenance.mappingVersion, provenance.weightSetVersion,
                provenance.evidenceSnapshot.id, provenance.riskContextSnapshot.id].forEach(text);
            [...['evaluatorSourceSha256', 'scopePopulationSha256', 'mappingSha256', 'weightSetSha256', 'scoredAtomSetSha256',
                'applicabilityBasisSha256', 'resolvedInputSha256'].map(key => provenance[key]),
                provenance.evidenceSnapshot.sha256, provenance.riskContextSnapshot.sha256,
                submission.responseSetSha256, value.outputSha256].forEach(digest);
            return { attainment: range(value.attainment), substantiated: coverage(value.evidence.substantiatedCoverage),
                // Validated by range(): the overall lower and upper figures, for leading with the lower one.
                lowerDisplay: value.attainment.status === 'scored' ? value.attainment.lowerDisplay : null,
                upperDisplay: value.attainment.status === 'scored' ? value.attainment.upperDisplay : null,
                denominatorWeight: value.attainment.denominatorWeight,
                lowerCreditUnits: value.attainment.lowerCreditUnits, upperCreditUnits: value.attainment.upperCreditUnits,
                completion: value.countsCompletion.completionDisplay,
                completed: value.countsCompletion.completionNumerator, total: value.countsCompletion.completionDenominator,
                partial: value.countsCompletion.partial, no: value.countsCompletion.no,
                tested: coverage(value.evidence.testedCoverage), pending: count(value.countsCompletion.claimedNotApplicableAtoms),
                unknown: count(value.countsCompletion.unknown), domains: projectedDomains };
        } catch (_) { return null; }
    }
    function mount(root, options) {
        options = options || {};
        if (!root || !root.ownerDocument) throw new Error('ncsc_root_required');
        if (mounted.has(root)) mounted.get(root).destroy();
        const doc = root.ownerDocument;
        const win = options.window || doc.defaultView;
        let stopNavigation = null;
        const baseMetadata = copy(options.metadata);
        let metadata = baseMetadata;
        const client = options.client;
        const organisationId = options.organisationId;
        const initialAssessmentId = options.initialAssessmentId;
        // Opened from the first-use action: go straight to the new-assessment step if nothing is saved yet.
        let startNewWhenEmpty = options.startNew === true && initialAssessmentId === undefined && options.presentationMode === 'editable';
        // Scoring v2 (#399): further readable profiles, sent only while their flag is on.
        // Each must be exactly the pinned v2 profile (all six fields); a near
        // match would otherwise be read and scored with the accepted profile's scale.
        const profileMetadata = options.profileMetadata === undefined ? [] : copy(options.profileMetadata);
        const usable = function (value) { return !!value && value.schemaVersion === 1 && Array.isArray(value.questions) && value.questions.length > 0; };
        if (!usable(metadata) || !Array.isArray(profileMetadata) || profileMetadata.length > 4 ||
            !profileMetadata.every(function (value) { return usable(value) && value.moduleId === metadata.moduleId && !profileMatches(value.profileRef, metadata.profileRef) && isV2(value); }) ||
            initialAssessmentId !== undefined && (typeof initialAssessmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(initialAssessmentId)) ||
            !client || !['list', 'read', 'create', 'save', 'submit', 'normaliseCommand', 'commandByteLength'].every(function (key) { return typeof client[key] === 'function'; })) {
            throw new Error('ncsc_composition_required');
        }
        const editable = options.presentationMode === 'editable';
        // Optional anonymous funnel hook (#151 F4): the composer sends at most
        // one count per step per page view. Never affects the questionnaire.
        const funnelStep = function (step) {
            if (typeof options.onFunnelStep !== 'function') return;
            try { options.onFunnelStep(step); } catch (_) { /* counts are best-effort */ }
        };
        let questions, optionById, questionById;
        // The metadata of the profile an assessment's stored reference names,
        // matched on every field, or null. The accepted profile comes first.
        function profileFor(profileRef) {
            return [baseMetadata].concat(profileMetadata).find(function (value) { return profileMatches(profileRef, value.profileRef); }) || null;
        }
        function useProfile(value) {
            metadata = value; questions = value.questions;
            optionById = new Map(value.responseOptions.map(function (item) { return [item.id, item]; }));
            questionById = new Map(questions.map(function (item) { return [item.id, item]; }));
        }
        useProfile(baseMetadata);
        const requests = new Set();
        let disposed = false;
        let epoch = 0;
        let renderedErrorKey = '[]';
        let busyAction = null;
        let editGeneration = 0;
        let selected = null;
        let acknowledged = null;
        let drafts = new Map();
        const assistanceNotes = new Map();
        // Open state of each question's "Help with this question" section,
        // kept while answering re-renders the question.
        const questionHelpOpen = new Map();
        let activeQuestion = 0;
        let summaries = [];
        let listSearch = '';
        let listStatus = 'all';
        let nextAfter = null;
        let allowance = null;
        let listLoaded = false;
        let loading = false;
        let refreshing = false;
        let busy = false;
        let pending = null;
        let conflict = false;
        let currentChecked = true;
        let statusText = '';
        let saveStatus;
        let errors = [];
        let leave = null;
        let view = 'list';
        let declaration = '', scopeChoices = null, scopeGenerated = '';
        let content;
        let status;
        let errorBox;
        let controls;
        let dialog;
        let submitPrompt = false;
        let submitLocked = false;
        let questionRegion;
        let questionProgress, progressArc, functionSteps;
        let nextUnanswered;
        let nextUnresolved;
        // The question bar's Next button and its parent; Review and submit
        // joins them once every answer is in or on the last question (#725).
        let navigationNext = null;
        let navigationReview = null;
        let navigationReviewSlot = null;
        let navigationReady = null;
        let assistanceRequest = null;
        let assistanceGeneration = 0;
        let unloadAttached = false;
        let workshopPanel;
        // Review is a local presentation of the current draft. Entering it
        // saves pending answers when automatic saving is on; editing from or
        // leaving it never sends a command.
        let reviewing = false;
        let returnToReview = null;
        let autosaveTimer = null;
        // A flush requested while a save is in flight runs as soon as it ends.
        let flushQueued = false;
        const autosaveIdleMs = options.autosaveIdleMs === undefined ? AUTOSAVE_IDLE_MS : options.autosaveIdleMs;
        const autosaveEnabled = Number.isFinite(autosaveIdleMs) && autosaveIdleMs > 0;
        const autosaveRetryDelays = Array.isArray(options.autosaveRetryDelaysMs) && options.autosaveRetryDelaysMs.length <= 5 &&
            options.autosaveRetryDelaysMs.every(function (value) { return Number.isFinite(value) && value >= 0 && value <= 30000; })
            ? options.autosaveRetryDelaysMs.slice() : AUTOSAVE_RETRY_DELAYS_MS;
        let restoringQuestion = false;
        const controller = { requestLeave: requestLeave, destroy: destroy, showQuestion: function (location) {
            if (!location || !live() || !acknowledged || view !== 'assessment' || reviewing || pending || leave ||
                location.assessmentId !== acknowledged.assessmentId || !Number.isInteger(location.questionIndex) ||
                location.questionIndex < 0 || location.questionIndex >= questions.length) return false;
            restoringQuestion = true;
            try { activeQuestion = location.questionIndex; renderAssessmentQuestion(); }
            finally { restoringQuestion = false; }
            return true;
        } };
        mounted.set(root, controller);
        root.replaceChildren(); root.classList.add('ncsc-questionnaire');
        const heading = node('h2', '', 'Cyber security assessment'); heading.id = 'ncsc-title';
        const alignment = node('p', 'dashboard-muted', 'A short check of your answers against NCSC guidelines. It is not a certification.');
        status = node('p', 'ncsc-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
        root.append(heading, alignment, status);

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
        // D-004: a scope written one item per line is shown as a list on the
        // review step. The saved-declaration panel deliberately keeps the exact
        // saved text, and the saved declaration remains the compared value.
        function scopeText(description) {
            const lines = String(description).split(/\r?\n/).map(line => line.trim().replace(/^[-*\u2022]\s+/, '')).filter(Boolean);
            if (lines.length < 2) return node('p', 'ncsc-preserve-text', description);
            const list = node('ul', 'ncsc-scope-list');
            lines.forEach(line => list.append(node('li', 'ncsc-preserve-text', line)));
            return list;
        }
        // Plain-English meanings of the words used in the progress line and the
        // finish path. Terms already explained where they appear (Resolved on
        // the finish path, * for unsaved in the question index) are not
        // repeated here.
        let glossaryOpen = false;
        function glossary() {
            const section = node('details', 'ncsc-guidance ncsc-glossary'); section.id = 'ncsc-glossary'; section.open = glossaryOpen;
            section.addEventListener('toggle', function () { glossaryOpen = section.open; });
            section.append(node('summary', '', 'What these words mean'));
            const list = node('dl');
            [['To check later', 'Answers marked Unknown, or Not applicable. They do not count as in place. You can still submit with Unknown and Not applicable answers.'],
                ['Marked not applicable, to confirm', 'You answered Not applicable and explained why. Not applicable answers count as not yet met, and they stay in your result. There is no review that changes that.'],
                ['Saved and not saved yet', 'Saved answers are kept with this draft, so you can come back to them before you submit. Not saved yet means a change is only on this page so far.'],
                ['Reported implementation range', 'After you submit, your result is shown as a range. It leads with the lower figure. The lower figure is what you reported as in place. The higher figure adds answers still to confirm. It is not a performance score.']
            ].forEach(function (entry) { list.append(node('dt', '', entry[0]), node('dd', '', entry[1])); });
            section.append(list);
            return section;
        }
        function button(label, action, cls) {
            const result = node('button', cls || 'dashboard-button', label); const createdEpoch = epoch;
            result.type = 'button'; result.addEventListener('click', function () { if (live(createdEpoch) && root.contains(result) && !result.disabled) action(); });
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
        async function call(method, args, expected, keepalive) {
            const request = new AbortController(); requests.add(request);
            try {
                const result = method === 'list' ? await client.list(Object.assign({}, args, { signal: request.signal }))
                    : await client[method](args, keepalive ? { signal: request.signal, keepalive: true } : { signal: request.signal });
                return live(expected) ? result : null;
            } finally { requests.delete(request); }
        }
        // #733: the submitted assessment just before the one shown, on the same
        // questions, read once per view. Uses the loaded list, or reads its first
        // page when Results was opened directly; only a complete list counts,
        // because an unloaded page could hold a submission between the two. A
        // refusal takes the normal denial path; any other failure just leaves
        // the summary without the supersedes lines.
        let previousRead = null;
        function previousSubmission() {
            const current = acknowledged, key = epoch + ':' + (current && current.assessmentId);
            if (previousRead && previousRead.key === key) return previousRead.promise;
            const expected = epoch, submittedAt = current && current.submission ? Date.parse(current.submission.submittedAt) : NaN;
            const pick = function (items) {
                return items.filter(function (item) {
                    return item.status === 'submitted' && item.assessmentId !== current.assessmentId &&
                        profileMatches(item.profileRef, current.profileRef) && Date.parse(item.updatedAt) < submittedAt;
                }).sort(function (left, right) { return right.updatedAt.localeCompare(left.updatedAt); })[0] || null;
            };
            const history = !current || !current.submission ? Promise.resolve([])
                : listLoaded ? Promise.resolve(nextAfter === null ? summaries : [])
                : call('list', { limit: 50, afterAssessmentId: null }, expected).then(function (result) {
                    return result && Array.isArray(result.assessments) && result.nextAfterAssessmentId === null ? result.assessments : [];
                });
            const promise = history.then(function (items) {
                const earlier = pick(items);
                return earlier ? call('read', earlier.assessmentId, expected).then(function (result) {
                    const value = result && result.assessment;
                    return value && value.assessmentId === earlier.assessmentId && value.status === 'submitted' ? value : null;
                }) : null;
            }).catch(function (error) {
                if (live(expected) && error && (error.statusCode === 403 || error.status === 403 || error.statusCode === 401 || error.status === 401 ||
                    error.code === 'ncsc_access_denied')) deny();
                return null;
            });
            previousRead = { key: key, promise: promise };
            return promise;
        }
        function cleanDetail(value, id) {
            const profile = value && profileFor(value.profileRef);
            if (!value || !profile || value.assessmentId !== id || value.moduleId !== profile.moduleId ||
                !Array.isArray(value.responses) || value.responses.some(function (item) { return !profile.questions.some(function (question) { return question.id === item.itemId; }); })) throw new Error('ncsc_invalid_response');
            useProfile(profile);
            const result = copy(value);
            if (result.submission) {
                const outputSha256 = value.submission && value.submission.evaluation && value.submission.evaluation.outputSha256;
                const results = resultModel(result, metadata, organisationId);
                result.submission = { revision: result.submission.revision, submittedAt: result.submission.submittedAt,
                    responseSetSha256: result.submission.responseSetSha256, results: results };
                // Kept only so the plan hand-off can name this exact submission. It is not shown.
                if (results && typeof outputSha256 === 'string' && /^[a-f0-9]{64}$/.test(outputSha256)) result.submission.outputSha256 = outputSha256;
            }
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
        // An answer counts once it can be saved: a Not applicable answer needs
        // its explanation first (#441 RANGI-14).
        function answerComplete(value) {
            const option = optionById.get(value.optionId);
            return !!option && (option.applicable || !!value.rationale && validText(value.rationale.text));
        }
        function unansweredIndex(start) {
            for (let offset = 1; offset <= questions.length; offset += 1) {
                const index = (start + offset) % questions.length;
                if (!answerComplete(displayedAnswer(questions[index]))) return index;
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
            if (!live() || !acknowledged || !questionProgress) return;
            const answered = questions.filter(question => answerComplete(displayedAnswer(question))).length;
            const missing = questions.length - answered;
            questionProgress.textContent = answered + ' of ' + questions.length + ' answered · ' +
                (missing ? 'About ' + missing + ' min left' : 'Complete');
            progressArc.setAttribute('stroke-dasharray', answered + ' ' + missing);
            const control = metadata.controls.find(item => item.id === questions[activeQuestion].controlId);
            for (const step of functionSteps.querySelectorAll('button')) {
                if (step.dataset.domain === control.domainId) step.setAttribute('aria-current', 'step');
                else step.removeAttribute('aria-current');
            }
            if (nextUnanswered) nextUnanswered.disabled = unansweredIndex(activeQuestion) === -1;
            if (nextUnresolved) nextUnresolved.disabled = unresolvedIndex(activeQuestion) === -1;
            updateReviewInNavigation(!missing);
        }
        // Once every question is answered, or on the last question, the bar
        // offers Review and submit as its main button instead of leaving a
        // faint, disabled Next as the only way forward (#441 M5-02, #725).
        function updateReviewInNavigation(allAnswered) {
            if (!navigationNext || !navigationReviewSlot || !navigationReady) return;
            const last = activeQuestion === questions.length - 1;
            const offer = editable && acknowledged.status !== 'submitted' && (allAnswered || last);
            if (offer && !navigationReview) {
                navigationReview = button('Review and submit', openReview);
                navigationReview.id = 'ncsc-navigation-review';
                navigationReviewSlot.append(navigationReview);
            } else if (!offer && navigationReview) {
                navigationReview.remove(); navigationReview = null;
            }
            // On the last question Next has nowhere to go, so it leaves the bar;
            // elsewhere it stays, as a secondary button once Review is offered.
            navigationNext.hidden = last && !!navigationReview;
            navigationNext.className = navigationReview ? 'dashboard-button dashboard-button-secondary' : 'dashboard-button';
            const ready = allAnswered && !!navigationReview;
            navigationReady.hidden = !ready;
            navigationReady.textContent = ready ? 'All ' + questions.length + ' answered. Review and submit when ready.' : '';
        }
        // True while a save is running, or an automatic save is waiting for
        // the short pause and will be allowed to send this draft.
        function savingNow() {
            if (!acknowledged || acknowledged.status === 'submitted' || !editable || !dirtyEntries().length) return false;
            return busy && !!pending && pending.command.action === 'save' || autosaveTimer !== null && canAutosave(false);
        }
        function deny() {
            abortRequests(); epoch += 1; selected = null; acknowledged = null; drafts.clear(); assistanceNotes.clear(); summaries = [];
            pending = null; busy = false; loading = false; declaration = ''; scopeChoices = null; scopeGenerated = ''; errors = []; conflict = false; reviewing = false; returnToReview = null;
            finishLeave(false); view = 'denied'; statusText = ''; render();
        }
        function fixedFailure(error) {
            if (error && (error.statusCode === 403 || error.code === 'ncsc_access_denied')) { deny(); return; }
            statusText = view === 'assessment' && !acknowledged
                ? 'The saved assessment could not be loaded. Retry this assessment or go back to the list.'
                : error && error.code === 'ncsc_request_too_large'
                ? 'This assessment is too large for this operation. Your saved answers and unsaved changes on this device are still here. ' + (view === 'create' ? 'Shorten the scope description, then try again.' : acknowledged && acknowledged.revision >= SAVE_CEILING ? 'This assessment has reached its save limit. Start a new assessment with shorter explanations.' : 'Shorten one or more explanations, save your changes, then try again.')
                : error && error.code === 'ncsc_submission_unavailable' ? 'Submission is not available yet. Your saved answers remain editable.'
                : error && error.code === 'ncsc_quota_exceeded' ? quotaMessage()
                : view === 'list' ? 'The assessment service is unavailable. Retry loading the list to check your saved work.'
                : 'The assessment service is unavailable. Your unsaved changes on this device are still here.';
            updateStatus();
        }
        function allowanceExhausted() { return !!allowance && allowance.used >= allowance.limit; }
        function allowanceUsage() {
            if (allowance.limit === 0) return 'Your plan does not include assessment submissions.';
            return allowance.used + ' of ' + allowance.limit + ' assessment ' + (allowance.limit === 1 ? 'submission' : 'submissions') + ' used on your plan.';
        }
        // Plain-English plan usage, shown before anyone starts work it cannot submit.
        function allowanceNote() {
            if (!allowance) return null;
            const exhausted = allowanceExhausted();
            const note = node('p', exhausted ? 'ncsc-warning ncsc-allowance' : 'dashboard-muted ncsc-allowance', allowanceUsage() +
                (!exhausted ? '' : allowance.limit === 0 ? ' You can still open and read your saved assessments. '
                    : ' You can still open and read your saved assessments, but you cannot submit another assessment. '));
            note.id = 'ncsc-allowance';
            if (exhausted) { const contact = node('a', '', 'Contact No Fries about more submissions'); contact.href = '/contact.html'; note.append(contact); }
            return note;
        }
        function quotaMessage() {
            // The server refused because the plan's submissions are used up; keep later views consistent with that.
            if (allowance) allowance = { used: Math.max(allowance.used, allowance.limit), limit: allowance.limit };
            return (allowance && allowance.limit === 0 ? 'This assessment was not submitted. Your plan does not include assessment submissions.'
                : allowance ? 'This assessment was not submitted. All ' + allowance.limit + ' assessment submissions on your plan have been used (' + allowance.used + ' of ' + allowance.limit + ').'
                : 'This assessment was not submitted. All assessment submissions on your plan have been used.') +
                ' Your saved answers are kept and you can still read them. To ask about more submissions, contact No Fries.';
        }
        function provenance() {
            const section = node('details', 'ncsc-provenance');
            section.append(node('summary', '', 'About this questionnaire and its sources'));
            [metadata.description, metadata.claim, metadata.attribution].forEach(function (text) { if (text) section.append(node('p', '', text)); });
            // The legal-review limitation is an internal release condition, not reader guidance (#441 RANGI-16).
            (Array.isArray(metadata.limitations) ? metadata.limitations : [metadata.limitations]).forEach(function (text) { if (text && !/^Paid or customer-facing release requires/.test(text)) section.append(node('p', '', text)); });
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
                node('p', '', 'A workshop companion with explanations and example answers for the original 14-question check.'),
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
            const target = replacement && !replacement.disabled ? replacement : saved.id === 'ncsc-save' && saveStatus && root.contains(saveStatus) ? saveStatus : fallback;
            if (!target) return;
            if (target === fallback || target === saveStatus) target.tabIndex = -1;
            target.focus({ preventScroll: true });
            if (target === replacement && typeof target.setSelectionRange === 'function' && Number.isInteger(saved.start)) {
                target.setSelectionRange(saved.start, saved.end);
            }
        }
        function render() {
            if (!live()) return;
            // The open assessment's own profile; the accepted one everywhere else.
            useProfile(acknowledged && !['create', 'denied'].includes(view) && profileFor(acknowledged.profileRef) || baseMetadata);
            const focused = captureFocus(root);
            const observations = root.querySelector('.ncsc-draft-observations');
            const observationsOpen = !!(observations && observations.open && acknowledged &&
                observations.dataset.assessmentId === acknowledged.assessmentId);
            const scrollX = win && win.scrollX, scrollY = win && win.scrollY;
            questionProgress = null; progressArc = null; functionSteps = null; nextUnanswered = null; nextUnresolved = null; navigationNext = null; navigationReview = null; navigationReviewSlot = null; navigationReady = null; questionRegion = null;
            if (!acknowledged || acknowledged.status === 'submitted' || !editable) { reviewing = false; returnToReview = null; }
            // Keep the live region attached so asynchronous updates change an
            // existing accessible status rather than insert prefilled content.
            Array.from(root.children).forEach(function (child) { if (child !== heading && child !== status) child.remove(); });
            errorBox = node('div', 'ncsc-errors'); errorBox.tabIndex = -1;
            content = node('section', 'ncsc-content');
            root.append(errorBox, content);
            if (view === 'denied') content.append(node('p', '', 'This assessment is not available. Reopen the dashboard through your authenticated organisation context.'));
            else if (view === 'create') renderCreate();
            else if (acknowledged) renderAssessment(observationsOpen);
            else if (view === 'assessment' && selected) renderAssessmentRead();
            else renderList();
            // Reuse the optional disclosure so open state survives save/recovery
            // renders. Stable IDs also restore keyboard focus inside it.
            if (view !== 'denied') { if (!workshopPanel) workshopPanel = workshopDownloads(); root.append(workshopPanel); }
            root.append(provenance()); updateStatus(); renderErrors();
            if (leave) renderLeave();
            else if (submitPrompt) renderSubmitDialog();
            else restoreFocus(root, focused, heading);
            if (focused && win && typeof win.scrollTo === 'function' && Number.isFinite(scrollY)) win.scrollTo(scrollX, scrollY);
        }
        function updateStatus() {
            syncUnloadWarning();
            if (!live() || !status) return;
            // A submitted assessment is read-only; saving progress no longer applies.
            const saved = acknowledged && acknowledged.status !== 'submitted' ? savedText() : '';
            const dirty = dirtyEntries().length;
            // Keep draft feedback beside Save so changing status text cannot move its pointer target.
            status.hidden = editable && !!acknowledged && acknowledged.status !== 'submitted' && !reviewing;
            // Only a save of answers says "Saving your answers" (#699): creating the
            // assessment, before anything is answered, says what it is doing.
            status.textContent = statusText || (busy ? busyAction === 'create' ? 'Setting up your assessment.' : busyAction === 'submit' ? 'Submitting your answers.' : 'Saving your answers. ' + saved : loading ?
                view === 'assessment' && !acknowledged ? 'Loading the selected assessment.' : 'Loading assessments.'
                : savingNow() ? 'Saving…' : saved + (dirty ? 'Newer changes are not saved yet.' : ''));
            if (saveStatus && root.contains(saveStatus)) saveStatus.textContent = status.textContent;
            if (controls) controls.querySelectorAll('button').forEach(function (control) {
                if (control.dataset.mutation === 'true') control.disabled = busy || !!pending || conflict || !currentChecked;
            });
            updateQuestionNavigation();
        }
        // Plain saved status: when the draft was last saved, in NZ time. The
        // per-answer counts live only in the progress line above the question.
        function savedText() {
            return acknowledged ? 'Last saved ' + localDate(acknowledged.updatedAt) + '. ' : '';
        }
        function edited() {
            if (!pending && !busy && !conflict) statusText = '';
            scheduleAutosave(); updateStatus();
        }
        function cancelAutosave() { if (autosaveTimer !== null) { clearTimeout(autosaveTimer); autosaveTimer = null; } }
        function scheduleAutosave(delay) {
            cancelAutosave();
            if (!autosaveEnabled || !live()) return;
            const flush = delay === 0;
            autosaveTimer = setTimeout(function () { autosaveTimer = null; autosave(flush, flush); }, flush ? 0 : autosaveIdleMs);
            if (autosaveTimer && typeof autosaveTimer.unref === 'function') autosaveTimer.unref();
            updateStatus();
        }
        // Silent: an automatic save never shows validation messages, opens a
        // dialog or sends a draft the person could not save by hand.
        function canAutosave(flush) {
            if (!autosaveEnabled || !live() || !editable || !acknowledged || acknowledged.status === 'submitted' || view !== 'assessment' ||
                busy || pending || conflict || !currentChecked || reviewing && !flush || leave || !dirtyEntries().length ||
                SAVE_CEILING - acknowledged.revision <= AUTOSAVE_RESERVE) return false;
            return questions.every(function (question) {
                const value = drafts.get(question.id).value, option = optionById.get(value.optionId);
                return !option || option.applicable || !!value.rationale && validText(value.rationale.text);
            });
        }
        // One save runs at a time. A successful save schedules the next one
        // for edits made meanwhile; see perform().
        function autosave(flush, keepalive) {
            cancelAutosave();
            if (flush && busy && pending && pending.command.action === 'save') { flushQueued = true; return; }
            // Replace "Saving…" with the real state when this save cannot go.
            if (!canAutosave(flush)) { updateStatus(); return; }
            // One automatic save may need several byte-bounded requests. Budget
            // the whole draft before sending any batch, not just its first one.
            try {
                if (planBatches(dirtyEntries()).length > SAVE_CEILING - acknowledged.revision - AUTOSAVE_RESERVE) {
                    statusText = 'Automatic saving is paused to keep room for your final changes. Use Save progress to save these answers.';
                    updateStatus(); return;
                }
            } catch (error) { updateStatus(); return; }
            flushQueued = false;
            saveAll(false, keepalive, true).catch(function () {});
        }
        // The page may be discarded after either event, so the request is
        // sent with keepalive and the same cookies and headers as any save.
        function autosaveWhenHidden() { if (doc.visibilityState === 'hidden') autosave(true, true); }
        function autosaveOnPageHide() { autosave(true, true); }
        if (autosaveEnabled && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', autosaveWhenHidden);
        if (autosaveEnabled && win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', autosaveOnPageHide);
        function returnToList() {
            abortRequests(); epoch += 1; loading = false;
            acknowledged = null; selected = null; drafts.clear(); assistanceNotes.clear(); reviewing = false; returnToReview = null;
            // Validation belongs to the departed form. Clear it before the list
            // renders, because its question controls and drafts no longer exist.
            view = 'list'; declaration = ''; scopeChoices = null; scopeGenerated = ''; errors = []; statusText = ''; loadList(false);
        }
        function renderAssessmentRead() {
            const target = selected;
            if (!loading) content.append(button('Retry loading this assessment', function () {
                if (!loading && selected === target && !acknowledged) openAssessment(target);
            }));
            content.append(button('Back to assessments', function () { requestLeave(returnToList); }, 'dashboard-text-button'));
        }
        function renderList() {
            if (typeof options.onLocation === 'function') options.onLocation(null);
            const introduction = node('div', 'ncsc-assessment-intro');
            introduction.append(node('p', '', 'Pick up where you left off, or view the results of a submitted assessment. Only saved progress appears here.'));
            if (editable) {
                const start = button('Start an assessment', function () {
                    view = 'create'; declaration = ''; scopeChoices = null; scopeGenerated = ''; errors = []; render();
                    const scope = content.querySelector('textarea'); if (scope) scope.focus();
                }, summaries.length ? 'dashboard-button dashboard-button-secondary' : 'dashboard-button');
                // Starting is pointless once nothing more can be submitted; say why beside the control.
                if (allowanceExhausted()) { start.disabled = true; start.setAttribute('aria-describedby', 'ncsc-allowance'); }
                introduction.append(start);
            }
            const usage = allowanceNote(); if (usage) introduction.append(usage);
            content.append(introduction);
            content.append(node('p', 'dashboard-muted', 'Most recently saved or submitted first. This order applies to the assessments loaded so far.'));
            if (!loading && listLoaded && !summaries.length) content.append(node('p', '', 'No saved assessments yet.'));
            const filters = node('div', 'ncsc-assessment-filters');
            const searchLabel = node('label', '', 'Find a saved assessment'); searchLabel.htmlFor = 'ncsc-assessment-search';
            const search = node('input'); search.type = 'search'; search.id = searchLabel.htmlFor;
            search.placeholder = 'Scope, date or assessment reference'; search.value = listSearch;
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
                ? 'Search applies to assessments shown so far. Load more to include older saved assessments.'
                : 'Search by scope, the date created, date last saved, or assessment reference.');
            note.id = 'ncsc-assessment-filter-note';
            const empty = node('div', 'ncsc-assessment-empty');
            const emptyCopy = node('p', '');
            empty.append(emptyCopy);
            const clear = button('Clear filters', function () {
                listSearch = ''; listStatus = 'all'; search.value = ''; filter.value = 'all'; updateList(); search.focus();
            }, 'dashboard-button dashboard-button-secondary');
            empty.append(clear);
            function updateList() {
                if (!live() || view !== 'list') return;
                list.replaceChildren();
                const query = listSearch.trim().toLowerCase();
                summaries.slice().sort(function (left, right) {
                    return right.updatedAt.localeCompare(left.updatedAt) || left.assessmentId.localeCompare(right.assessmentId);
                }).forEach(function (item) {
                    const submitted = item.status === 'submitted';
                    if (listStatus === 'submitted' && !submitted || listStatus === 'unfinished' && submitted ||
                        query && ![item.assessmentId, item.createdAt, item.updatedAt, localDate(item.createdAt), localDate(item.updatedAt),
                            item.scopePopulation ? item.scopePopulation.description : ''].some(function (value) { return value.toLowerCase().includes(query); })) return;
                    const row = node('li', 'ncsc-assessment-card');
                    const heading = node('div', 'ncsc-assessment-card-heading');
                    heading.append(node('h3', '', 'Assessment started ' + localDate(item.createdAt)),
                        node('span', 'dashboard-badge', submitted ? 'Submitted' : unfinishedStatusLabel(item)));
                    const saved = node('p', 'ncsc-assessment-saved', item.progress.answered + ' of ' + item.progress.total + ' responses saved');
                    const progress = node('progress', 'ncsc-saved-progress'); progress.max = item.progress.total; progress.value = item.progress.answered;
                    progress.setAttribute('aria-label', 'Saved responses');
                    const action = submitted ? 'View results' : editable ? 'Continue assessment' : 'View assessment';
                    const open = button(action, function () { requestLeave(function () { openAssessment(item.assessmentId); }); },
                        submitted || !editable ? 'dashboard-button dashboard-button-secondary' : 'dashboard-button');
                    open.id = 'ncsc-assessment-open-' + item.assessmentId; open.dataset.assessmentId = item.assessmentId;
                    const reference = node('p', 'dashboard-muted ncsc-preserve-text', 'Last saved: ' + item.updatedAt.replace('T', ' ').replace('Z', ' UTC') + '\nAssessment reference: ' + item.assessmentId);
                    reference.id = 'ncsc-assessment-reference-' + item.assessmentId; open.setAttribute('aria-describedby', reference.id);
                    const details = node('details', 'ncsc-assessment-reference'), summary = node('summary', '', 'Saved record details');
                    summary.id = 'ncsc-assessment-details-' + item.assessmentId; details.append(summary, reference);
                    if (item.scopePopulation) row.append(node('p', 'ncsc-assessment-scope ncsc-preserve-text', item.scopePopulation.description));
                    row.append(heading, saved, progress,
                        node('p', 'dashboard-muted ncsc-assessment-date', 'Last saved ' + localDate(item.updatedAt)), open, details); list.append(row);
                });
                const matches = list.children.length;
                const submittedLoaded = summaries.some(function (item) { return item.status === 'submitted'; });
                emptyCopy.textContent = listStatus === 'submitted' && !submittedLoaded
                    ? 'No submitted assessments yet. Results appear here once an assessment is submitted.'
                    : 'No assessments match your search and status.';
                count.textContent = matches === summaries.length
                    ? summaries.length + (summaries.length === 1 ? ' assessment' : ' assessments')
                    : matches + ' of ' + summaries.length + ' assessments';
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
            let appended = false, autoStarted = false;
            function releaseFocus() { ownsFocus = false; }
            // An old empty page cannot establish that a fresh list is empty.
            // Failed replacement reads must retain an explicit retry path.
            if (!append) { listLoaded = false; summaries = []; nextAfter = null; allowance = null; }
            const expected = epoch; loading = true; statusText = ''; render();
            // The disabled loading control temporarily hands focus to the heading.
            // Any deliberate move away cancels this request's eventual handoff.
            if (ownsFocus) heading.addEventListener('blur', releaseFocus);
            try {
                const result = await call('list', { limit: 50, afterAssessmentId: append ? nextAfter : null }, expected);
                if (!result) return;
                if (result.assessments.some(function (item) { return item.moduleId !== metadata.moduleId || !profileFor(item.profileRef); })) throw new Error('ncsc_invalid_response');
                const map = new Map((append ? summaries : []).map(function (item) { return [item.assessmentId, item]; }));
                result.assessments.forEach(function (item) { map.set(item.assessmentId, copy(item)); });
                summaries = Array.from(map.values()); nextAfter = result.nextAfterAssessmentId; listLoaded = true;
                allowance = result.submissionAllowance ? copy(result.submissionAllowance) : null;
                appended = append;
                if (startNewWhenEmpty && !append && view === 'list' && !summaries.length && !allowanceExhausted()) { view = 'create'; declaration = ''; scopeChoices = null; scopeGenerated = ''; errors = []; autoStarted = true; }
                startNewWhenEmpty = false;
            } catch (error) { if (live(expected)) fixedFailure(error); }
            finally {
                heading.removeEventListener('blur', releaseFocus);
                if (live(expected)) {
                    const restorePageFocus = ownsFocus && doc.activeElement === heading && view === 'list' && !leave;
                    loading = false; render();
                    if (autoStarted) { const scope = content.querySelector('textarea'); if (scope) scope.focus(); }
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
            selected = id; acknowledged = null; drafts.clear(); assistanceNotes.clear(); conflict = false; reviewing = false; returnToReview = null; currentChecked = true; errors = []; pending = null; view = 'assessment';
            loading = true; statusText = ''; render();
            try {
                const result = await call('read', id, expected);
                if (!result) return;
                acknowledged = cleanDetail(result.assessment, id); resetDrafts();
                activeQuestion = acknowledged.status === 'submitted' ? 0 : Math.max(0, unansweredIndex(-1));
                if (id === initialAssessmentId && acknowledged.status !== 'submitted' && Number.isInteger(options.initialQuestionIndex) &&
                    options.initialQuestionIndex >= 0 && options.initialQuestionIndex < questions.length) activeQuestion = options.initialQuestionIndex;
            } catch (error) { if (live(expected)) fixedFailure(error); }
            finally { if (live(expected)) { loading = false; render(); } }
        }
        function renderCreate() {
            const renderedEpoch = epoch;
            if (!scopeChoices) scopeChoices = emptyScopeChoices();
            const locked = () => busy || !!pending || !live(renderedEpoch);
            content.append(node('p', '', 'Pick what this assessment covers. We write the scope statement for you, and you can edit it.'));
            const builder = node('div', 'ncsc-scope-builder');
            const meter = node('p', 'ncsc-scope-meter'); meter.id = 'ncsc-scope-meter'; meter.setAttribute('aria-live', 'polite');
            function refresh(fromChoices) {
                const done = scopeSectionsDone(scopeChoices); meter.dataset.done = String(done);
                meter.textContent = done === 5 ? 'Scope ready' : done + ' of 5 sections chosen';
                if (!fromChoices) return;
                const text = composeScope(scopeChoices);
                // Rewrite the statement only while it is still ours, so hand edits are never lost.
                if (input.value === scopeGenerated || !input.value.trim()) { input.value = text; declaration = text; scopeGenerated = text; edited(); update.hidden = true; }
                else update.hidden = false;
            }
            function select(key, label) {
                const field = node('label', 'ncsc-scope-field', label), control = node('select');
                control.id = 'ncsc-scope-' + key; control.append(node('option', '', 'Choose'));
                control.children[0].value = '';
                SCOPE_CHOICES[key].forEach(function (text) { const option = node('option', '', text); option.value = text; control.append(option); });
                control.value = scopeChoices[key]; control.disabled = locked();
                control.addEventListener('change', function () { if (locked()) return; scopeChoices[key] = control.value; refresh(true); });
                field.append(control); return field;
            }
            const basics = node('div', 'ncsc-scope-row');
            const home = node('label', 'ncsc-scope-check'), homeBox = node('input'); homeBox.type = 'checkbox'; homeBox.id = 'ncsc-scope-home';
            homeBox.checked = scopeChoices.homeWorking; homeBox.disabled = locked();
            homeBox.addEventListener('change', function () { if (locked()) return; scopeChoices.homeWorking = !!homeBox.checked; refresh(true); });
            home.append(homeBox, node('span', '', 'People work from home'));
            basics.append(select('headcount', 'How many people use your systems?'), select('sites', 'Sites'), home);
            builder.append(basics);
            SCOPE_GROUPS.forEach(function (group) {
                const set = node('fieldset', 'ncsc-scope-group'); set.append(node('legend', '', group[1]));
                const chips = node('div', 'ncsc-scope-chips');
                SCOPE_CHOICES[group[0]].forEach(function (text) {
                    const chip = button(text, function () {
                        if (locked()) return;
                        const list = scopeChoices[group[0]], at = list.indexOf(text);
                        if (at >= 0) list.splice(at, 1); else list.push(text);
                        chip.setAttribute('aria-pressed', String(at < 0)); refresh(true);
                    }, 'ncsc-scope-chip');
                    chip.setAttribute('aria-pressed', String(scopeChoices[group[0]].includes(text))); chip.disabled = locked();
                    chips.append(chip);
                });
                set.append(chips);
                if (group[0] === 'services') {
                    const other = node('label', 'ncsc-scope-field', 'Other online services (separate with commas)'), otherInput = node('input');
                    otherInput.id = 'ncsc-scope-other'; otherInput.value = scopeChoices.otherServices; otherInput.maxLength = 300; otherInput.readOnly = locked();
                    otherInput.addEventListener('input', function () { if (locked()) return; scopeChoices.otherServices = otherInput.value; refresh(true); });
                    other.append(otherInput); set.append(other);
                }
                builder.append(set);
            });
            content.append(builder);
            const label = node('label', 'ncsc-scope-label', 'Your scope statement'); label.setAttribute('for', 'ncsc-scope');
            // Linked to the box so keyboard and screen reader users hear it when they reach the field.
            const note = node('p', 'dashboard-muted', 'You can\'t edit the scope once the assessment starts. If it needs to change later, you can start a new assessment.'); note.id = 'ncsc-scope-note';
            const input = node('textarea', 'ncsc-textarea'); input.id = 'ncsc-scope'; input.value = declaration; input.rows = 6; input.readOnly = busy || !!pending;
            input.setAttribute('aria-describedby', SCOPE_DESCRIBED_BY); input.required = true;
            input.addEventListener('input', function () { if (live(renderedEpoch) && !busy && !pending) { declaration = input.value; edited(); refresh(false); } });
            input.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || !live(renderedEpoch)) return;
                event.preventDefault(); if (!start.disabled) createAssessment();
            });
            const update = button('Update from my choices', function () {
                if (locked()) return; scopeGenerated = input.value; refresh(true); input.focus();
            }, 'dashboard-text-button'); update.id = 'ncsc-scope-update'; update.hidden = true;
            const help = node('p', 'dashboard-muted', 'Press Ctrl+Enter, or Cmd+Enter on a Mac, to start.'); help.id = 'ncsc-scope-help';
            content.append(meter, label, note, input, update, help);
            refresh(false);
            const usage = allowanceNote(); if (usage) content.append(usage);
            controls = node('div', 'ncsc-actions');
            const start = button('Create assessment', createAssessment);
            if (allowanceExhausted()) { start.disabled = true; start.setAttribute('aria-describedby', 'ncsc-allowance'); }
            else start.dataset.mutation = 'true';
            controls.append(start, button('Back to assessments', function () { requestLeave(returnToList); }, 'dashboard-text-button'));
            content.append(controls);
            if (pending) renderPending();
        }
        async function createAssessment() {
            if (!editable || busy || pending || !live()) return false;
            if (allowanceExhausted()) { statusText = allowanceUsage() + (allowance.limit === 0 ? '' : ' You cannot submit another assessment.'); updateStatus(); return false; }
            if (!validText(declaration)) { errors = [{ id: 'scope', message: textError(declaration, true) }]; renderErrors(true); return false; }
            errors = []; renderErrors();
            try {
                const command = client.normaliseCommand({ assessmentId: newId(), action: 'create', idempotencyKey: newId(), expectedRevision: null, payload: { scopePopulation: { description: declaration } } });
                return await perform(command, []);
            } catch (error) { fixedFailure(error); return false; }
        }
        function renderAssessment(observationsOpen) {
            const renderedEpoch = epoch;
            const sealed = acknowledged.status === 'submitted';
            content.append(button('Back to assessments', function () { requestLeave(returnToList); }, 'dashboard-text-button'));
            const declarationPanel = node('details', 'ncsc-scope'); declarationPanel.append(node('summary', '', 'Assessment scope (saved declaration)'), node('p', 'ncsc-preserve-text', acknowledged.scopePopulation.description),
                node('p', 'dashboard-muted', 'Answer every question for this scope. If it contains a mistake, go Back to assessments and start a new assessment with the corrected scope; this saved declaration stays with its original answers.')); content.append(declarationPanel);
            if (sealed) {
                const sealedNote = node('p', 'ncsc-sealed', 'Submitted ' + localDate(acknowledged.submission.submittedAt) + '. Your results are below, followed by your read-only answers.');
                sealedNote.id = 'ncsc-sealed'; content.append(sealedNote);
                renderResults(acknowledged.submission.results);
                // Only a result that actually rendered counts; "Results are unavailable" does not.
                if (acknowledged.submission.results) funnelStep('result_viewed');
                if (dirtyEntries().length) {
                    const unsent = node('details', 'ncsc-warning'); unsent.append(node('summary', '', 'Unsaved changes on this device (' + dirtyEntries().length + ')'));
                    unsent.append(node('p', '', 'These unsaved changes on this device were not part of the submission. The question form shows the saved submission separately.'));
                    dirtyEntries().forEach(function (entry) {
                        const option = optionById.get(entry.value.optionId);
                        unsent.append(node('h3', '', questionById.get(entry.value.itemId).prompt), node('p', '', option ? option.label : 'Answer cleared'));
                        if (entry.value.rationale) unsent.append(node('p', 'ncsc-preserve-text', entry.value.rationale.text));
                    }); content.append(unsent);
                }
            }
            else if (!editable) content.append(node('p', '', 'Read-only view.'));
            if (conflict) renderConflict();
            if (pending) renderPending();
            if (reviewing) { renderReview(); return; }
            const header = node('div', 'ncsc-focus-header');
            functionSteps = node('ol', 'ncsc-function-steps');
            functionSteps.setAttribute('aria-label', 'Assessment functions');
            for (const domain of metadata.domains) {
                const item = node('li');
                const step = button(domain.title, () => {
                    if (!live(renderedEpoch) || !content.contains(step)) return;
                    const controls = metadata.controls.filter(control => control.domainId === domain.id);
                    activeQuestion = questions.findIndex(question => controls.some(control => control.id === question.controlId));
                    renderAssessmentQuestion();
                }, 'ncsc-function-step');
                step.id = 'ncsc-step-' + domain.id;
                step.dataset.domain = domain.id;
                item.append(step); functionSteps.append(item);
            }
            const svg = name => doc.createElementNS('http://www.w3.org/2000/svg', name);
            const ring = svg('svg');
            ring.setAttribute('viewBox', '0 0 40 40'); ring.setAttribute('aria-hidden', 'true');
            const track = svg('circle'); progressArc = svg('circle');
            for (const circle of [track, progressArc]) {
                circle.setAttribute('cx', '20'); circle.setAttribute('cy', '20'); circle.setAttribute('r', '16');
                ring.append(circle);
            }
            progressArc.setAttribute('pathLength', String(questions.length));
            progressArc.setAttribute('transform', 'rotate(-90 20 20)');
            questionProgress = node('span'); questionProgress.id = 'ncsc-draft-progress';
            const progress = node('div', 'ncsc-focus-progress'); progress.append(ring, questionProgress);
            header.append(functionSteps, progress); content.append(header);
            questionRegion = node('div', 'ncsc-question'); content.append(questionRegion); renderQuestion();
            controls = node('div', 'ncsc-actions');
            if (editable && !sealed) {
                // Autosave covers most edits, so the manual Save is secondary. It
                // stays because autosave skips drafts with an N/A that has no
                // explanation, stops near the save limit and can be turned off.
                const save = button('Save progress', function () { saveAll(false); }, autosaveEnabled ? 'dashboard-button dashboard-button-secondary' : 'dashboard-button');
                save.id = 'ncsc-save'; save.dataset.mutation = 'true';
                if (!saveStatus) saveStatus = node('p', 'ncsc-save-status'); else saveStatus.remove();
                saveStatus.id = 'ncsc-save-status'; saveStatus.setAttribute('role', 'status'); saveStatus.setAttribute('aria-live', 'polite'); saveStatus.setAttribute('aria-atomic', 'true');
                controls.append(save, saveStatus);
                controls.addEventListener('pointerdown', function (event) {
                    if (save.disabled && (event.target === save || save.contains(event.target))) event.preventDefault();
                });
                if (returnToReview) {
                    const back = button('Return to review', resumeReview, 'dashboard-button dashboard-button-secondary'); back.id = 'ncsc-return-to-review';
                    controls.append(back);
                }
                // The main action below the question; Save is secondary while
                // autosave is on, so this is the one primary button (#725).
                controls.append(button('Review and submit', openReview, autosaveEnabled ? 'dashboard-button' : 'dashboard-button dashboard-button-secondary'));
            }
            content.append(controls);
            if (!sealed) renderDraftObservations(observationsOpen);
        }
        // Counts and navigation from acknowledged answers only. Never evaluate a
        // draft, infer a risk ranking, or reuse another assessment's baseline.
        // Replace the saved-observations panel in place after a quiet save,
        // keeping its open state; the question being answered is not rebuilt.
        function refreshDraftObservations() {
            const old = root.querySelector('.ncsc-draft-observations');
            if (!old || !acknowledged || acknowledged.status === 'submitted' || !content.contains(old)) return;
            const open = old.open && old.dataset.assessmentId === acknowledged.assessmentId;
            const focused = old.contains(doc.activeElement) ? doc.activeElement.id : '';
            renderDraftObservations(open);
            const fresh = content.children[content.children.length - 1];
            if (!fresh || fresh === old || fresh.className !== old.className) return;
            content.removeChild(fresh);
            old.replaceChildren(...Array.from(fresh.children)); old.open = open;
            if (focused) { const target = old.querySelector('[id="' + focused + '"]'); if (target) target.focus({ preventScroll: true }); }
        }
        function renderDraftObservations(expanded) {
            const panel = node('details', 'ncsc-guidance ncsc-draft-observations');
            panel.dataset.assessmentId = acknowledged.assessmentId; panel.open = expanded;
            const summary = node('summary', '', 'Saved draft observations'); summary.id = 'ncsc-draft-observations-summary';
            panel.append(summary, node('p', 'dashboard-muted', 'Last saved ' + localDate(acknowledged.updatedAt) +
                '. Only saved answers are included. Unsaved changes are not included until a save is confirmed.'));
            panel.append(node('p', '', 'These are self-reported draft observations, not a score, risk ranking or verified evidence. They do not change any submitted baseline.'));
            const rows = questions.map(function (question, index) { return { question: question, index: index, value: savedAnswer(question.id) }; });
            const saved = rows.filter(function (row) { return row.value.optionId !== null; }).length;
            const yes = rows.filter(function (row) { return row.value.optionId === 'yes'; }).length;
            panel.append(node('p', 'ncsc-draft-observation-counts', saved + ' of ' + questions.length + ' responses saved. ' +
                yes + ' answered Yes (self-reported, not verified).'));
            if (!saved) panel.append(node('p', '', 'No saved answers yet. Observations appear after answers are saved.'));
            [
                ['Reported gaps', ['no', 'partial'], 'Check what is missing and agree a next step with your team or No Fries.'],
                ['Information to confirm', ['unknown'], 'Ask whoever looks after these systems what is in place.'],
                ['Applicability to confirm', ['not_applicable'], 'These answers say the question does not apply. Check whether it really is outside this scope. They still count as not yet met.'],
                ['Not answered in this save', [null], 'Answer these questions, or choose Unknown when you cannot confirm what is in place.']
            ].forEach(function (group) {
                const matches = rows.filter(function (row) { return group[1].includes(answerGroup(row.value.optionId)); });
                const section = node('section', 'ncsc-draft-observation-group');
                section.append(node('h3', '', group[0] + ' · ' + matches.length));
                if (matches.length) {
                    section.append(node('p', '', group[2]));
                    const list = node('ul', 'ncsc-draft-observation-list');
                    matches.forEach(function (row) {
                        const control = metadata.controls.find(function (entry) { return entry.id === row.question.controlId; });
                        const label = row.value.optionId === 'not_applicable' ? 'Not applicable, to confirm' :
                            row.value.optionId === null ? 'Unanswered' : optionById.get(row.value.optionId).label;
                        const jump = button('Question ' + (row.index + 1) + ': ' + (control ? plainControlTitle(control.title) : row.question.prompt) + ' · ' + label,
                            function () { if (questionRegion) { activeQuestion = row.index; renderAssessmentQuestion(); } }, 'dashboard-text-button');
                        jump.id = 'ncsc-draft-observation-' + row.question.id;
                        const item = node('li'); item.append(jump); list.append(item);
                    });
                    section.append(list);
                }
                panel.append(section);
            });
            panel.append(node('p', 'dashboard-muted', 'Grouped by saved answer, with questions in framework order. A zero count is not assurance that there are no gaps. Open a question to review its current answer, including any newer unsaved change.'));
            content.append(panel);
        }
        // "2 Unknown and 1 not applicable", leaving out a part that is zero.
        function confirmBreakdown(unknown, notApplicable) {
            return [unknown ? unknown + ' Unknown' : '', notApplicable ? notApplicable + ' not applicable' : ''].filter(Boolean).join(' and ');
        }
        // The plain-language question people answer. The framework prompt is
        // kept for reference but never replaces it where answers are shown.
        function plainQuestion(question) { return question.smallBusiness ? question.smallBusiness.question : question.prompt; }
        // The four controls No Fries adds carry a framework label in the pinned profile. On screen the
        // control is named the same way as in the Improvement Plan; the label stays in the source details.
        function plainControlTitle(title) {
            return String(title || '').replace(/^No Fries Critical Control extension\s*[—–·:-]\s*/i, '').trim() || String(title || '');
        }
        function reviewState() {
            return questions.map(function (question, index) {
                const value = drafts.get(question.id).value, saved = savedAnswer(question.id), option = optionById.get(value.optionId);
                return { question: question, index: index, value: value, option: option, unsaved: !equal(value, saved),
                    cleared: value.optionId === null && saved.optionId !== null,
                    missingRationale: !!option && !option.applicable && (!value.rationale || !validText(value.rationale.text)) };
            });
        }
        function renderReview() {
            const rows = reviewState();
            const unanswered = rows.filter(function (row) { return !row.option; }).length;
            const unexplained = rows.filter(function (row) { return row.missingRationale; }).length;
            const notApplicable = rows.filter(function (row) { return row.value.optionId === 'not_applicable'; }).length;
            const toConfirm = rows.filter(function (row) { return ['unknown', 'not_applicable'].includes(row.value.optionId); }).length;
            const unsaved = rows.filter(function (row) { return row.unsaved; }).length;
            const panel = node('section', 'ncsc-review'); panel.setAttribute('aria-labelledby', 'ncsc-review-title');
            const title = node('h3', '', 'Review your answers before submitting'); title.id = 'ncsc-review-title'; title.tabIndex = -1;
            panel.append(title, node('p', 'dashboard-muted', 'Check these answers before you submit. Nothing is submitted until you choose Save and submit assessment.'));
            const counts = node('ul', 'ncsc-review-counts'); counts.id = 'ncsc-review-counts';
            [(questions.length - unanswered) + ' of ' + questions.length + ' answered', unanswered + ' unanswered',
                unexplained + ' N/A ' + (unexplained === 1 ? 'answer needs' : 'answers need') + ' an explanation',
                unsaved + (unsaved === 1 ? ' answer is' : ' answers are') + ' not saved yet'].forEach(function (text) { counts.append(node('li', '', text)); });
            panel.append(counts, glossary());
            const blockers = [];
            if (unanswered) blockers.push('answer ' + unanswered + (unanswered === 1 ? ' question' : ' questions') + ' (Unknown is allowed)');
            if (unexplained) blockers.push('explain ' + unexplained + ' N/A ' + (unexplained === 1 ? 'answer' : 'answers'));
            const readiness = node('p', blockers.length ? 'ncsc-review-blocked' : 'ncsc-review-ready', blockers.length
                ? 'Before you can submit, ' + blockers.join(' and ') + '.'
                // Mention only what applies: no N/A sentence without N/A answers.
                : 'Every question has an answer.' + (notApplicable ? ' ' + (notApplicable === 1 ? 'Your not applicable answer has an explanation.' : 'Each not applicable answer has an explanation.') : '') +
                    (toConfirm ? ' ' + toConfirm + (toConfirm === 1 ? ' answer is' : ' answers are') + ' still to confirm (' + confirmBreakdown(toConfirm - notApplicable, notApplicable) +
                        '). You can submit with ' + (toConfirm === 1 ? 'it' : 'them') + ', but ' + (toConfirm === 1 ? 'it does' : 'they do') + ' not count as in place.' : ''));
            readiness.id = 'ncsc-review-readiness'; panel.append(readiness);
            // Name each question that blocks submitting, with a jump to it (#669).
            const incomplete = rows.filter(function (row) { return !row.option || row.missingRationale; });
            if (incomplete.length) {
                const jumps = node('ul', 'ncsc-review-jumps'); jumps.id = 'ncsc-review-jumps';
                incomplete.forEach(function (row) {
                    const item = node('li');
                    item.append(button('Question ' + (row.index + 1) + ': ' + plainQuestion(row.question) + (row.option ? ' (needs an explanation)' : ''),
                        function () { editFromReview(row.index); }, 'dashboard-text-button'));
                    jumps.append(item);
                });
                panel.append(jumps);
            }
            renderReviewRange(panel, rows, unanswered);
            const scope = node('section', 'ncsc-review-scope'); scope.append(node('h4', '', 'Assessment scope'), scopeText(acknowledged.scopePopulation.description));
            panel.append(scope);
            const list = node('ol', 'ncsc-review-list');
            rows.forEach(function (row) {
                const item = node('li', 'ncsc-review-item' + (row.unsaved ? ' ncsc-review-unsaved' : '') + (!row.option || row.missingRationale ? ' ncsc-review-incomplete' : ''));
                item.id = 'ncsc-review-item-' + row.question.id;
                const control = metadata.controls.find(function (entry) { return entry.id === row.question.controlId; });
                item.append(node('p', 'dashboard-eyebrow', 'Question ' + (row.index + 1) + (control ? ' · ' + plainControlTitle(control.title) : '')), node('h4', '', plainQuestion(row.question)));
                // The same plain question that was answered; the framework wording stays one click away.
                if (row.question.smallBusiness) {
                    const wording = node('details', 'ncsc-review-framework'); wording.append(node('summary', '', 'Full framework question'), node('p', '', row.question.prompt));
                    item.append(wording);
                }
                const answerText = row.option ? (row.option.applicable ? row.option.label : 'N/A (pending claim)') : row.cleared ? 'Unanswered (answer cleared)' : 'Unanswered';
                item.append(node('p', 'ncsc-review-answer', 'Answer: ' + answerText));
                if (row.option && !row.option.applicable) {
                    item.append(row.missingRationale ? node('p', 'ncsc-review-problem', 'N/A explanation missing. Add an explanation before submitting.')
                        : node('p', 'ncsc-preserve-text', 'N/A explanation: ' + row.value.rationale.text));
                }
                if (row.unsaved) item.append(node('p', 'ncsc-review-badge', 'Not saved yet'));
                const edit = button('Edit question ' + (row.index + 1), function () { editFromReview(row.index); }, 'dashboard-text-button');
                edit.id = 'ncsc-review-edit-' + row.question.id; item.append(edit);
                list.append(item);
            });
            panel.append(list);
            controls = node('div', 'ncsc-actions ncsc-review-actions');
            const consequence = node('p', 'dashboard-muted', (unsaved ? 'When you submit, your ' + unsaved + ' unsaved ' + (unsaved === 1 ? 'answer is' : 'answers are') + ' saved first, then these answers are used. ' : 'When you submit, these saved answers are used. ') +
                'A submitted assessment is read-only and cannot be edited.');
            consequence.id = 'ncsc-review-consequence';
            const confirm = button('Save and submit assessment', requestSubmit); confirm.id = 'ncsc-review-submit'; confirm.dataset.mutation = 'true'; confirm.setAttribute('aria-describedby', consequence.id);
            controls.append(confirm, button('Back to questions', closeReview, 'dashboard-text-button'));
            if (allowanceExhausted()) panel.append(allowanceNote());
            panel.append(consequence, controls);
            content.append(panel);
        }
        // Preview of the draft only. The accepted profile weights every
        // question 1; the submitted score always comes from the server.
        function projectRange(rows) {
            if (isV2(metadata)) {
                // Scoring v2 (#399): the pinned weights and credits, in hundredths.
                let low = 0, high = 0, total = 0;
                rows.forEach(function (row) {
                    const weight = V2_WEIGHT[row.question.id], credit = Object.hasOwn(V2_CREDIT, row.value.optionId) ? V2_CREDIT[row.value.optionId] : null;
                    total += weight * 100; low += weight * (credit || 0); high += credit === null ? weight * 100 : weight * credit;
                });
                return { lower: percentTenths(low, total), upper: percentTenths(high, total) };
            }
            let lower = 0, upper = 0;
            rows.forEach(function (row) {
                const credit = creditUnits(row.value.optionId === 'not_applicable' ? 'unknown' : row.value.optionId, 1);
                lower += credit.lower; upper += credit.upper;
            });
            return { lower: percentTenths(lower, rows.length * 2), upper: percentTenths(upper, rows.length * 2) };
        }
        function renderReviewRange(panel, rows, unanswered) {
            const pendingRows = rows.filter(function (row) { return row.value.optionId === 'not_applicable'; });
            const section = node('section', 'ncsc-review-range'); section.id = 'ncsc-review-range';
            section.setAttribute('aria-labelledby', 'ncsc-review-range-title');
            const heading = node('h4', '', 'Projected score range'); heading.id = 'ncsc-review-range-title'; section.append(heading);
            const count = pendingRows.length;
            // Mention not applicable answers only when there are some (#297).
            if (count) section.append(node('p', '', count + (count === 1 ? ' answer' : ' answers') + ' marked not applicable, to confirm.'));
            if (unanswered) {
                section.append(node('p', '', 'Answer ' + unanswered + ' more ' +
                    (unanswered === 1 ? 'question' : 'questions') + ' to see your projected range.'));
            } else {
                const range = projectRange(rows);
                const shown = range.lower === range.upper ? percentDisplay(range.lower) : percentDisplay(range.lower) + '–' + percentDisplay(range.upper);
                const value = node('p', '', 'With your current answers, reported implementation would be ' + shown + '.'); value.id = 'ncsc-review-range-value';
                section.append(value);
                if (count) {
                    const weightOf = function (list) { return list.reduce(function (total, row) { return total + V2_WEIGHT[row.question.id]; }, 0); };
                    const widened = isV2(metadata) ? percentTenths(weightOf(pendingRows), weightOf(rows))
                        : percentTenths(count * creditUnits('unknown', 1).upper, rows.length * 2);
                    section.append(node('p', '', 'Answers marked not applicable, to confirm, are not counted as in place: they add nothing to the lower figure and full credit to the upper figure. Yours widen the range by ' +
                        (widened / 10).toFixed(1) + ' percentage points.'));
                }
            }
            if (count) {
                section.append(node('p', '', 'Not applicable answers count as not yet met, and they stay in your result. There is no review that changes that. If you can say what is in place, change the answer to Yes, Partial or No.'));
                const list = node('ul', 'ncsc-review-pending-list');
                pendingRows.forEach(function (row) {
                    const change = button('Change question ' + (row.index + 1), function () { editFromReview(row.index); }, 'dashboard-text-button');
                    change.id = 'ncsc-review-pending-edit-' + row.question.id;
                    const item = node('li'); item.append(change); list.append(item);
                });
                section.append(list);
            }
            section.append(node('p', 'dashboard-muted', 'This is a preview of your draft. The results page shows the figures calculated from the submitted answers.'));
            panel.append(section);
        }
        function focusTarget(target) {
            if (!target || !live()) return;
            if (['H3', 'LEGEND'].includes(String(target.tagName).toUpperCase())) target.tabIndex = -1;
            target.focus();
        }
        function openReview() {
            if (!live() || !editable || !acknowledged || acknowledged.status === 'submitted' || leave) return;
            autosave(true);
            reviewing = true; returnToReview = null; errors = []; render();
            focusTarget(content.querySelector('[id="ncsc-review-title"]'));
        }
        function closeReview() {
            if (!live() || !reviewing) return;
            reviewing = false; returnToReview = null; render();
            focusTarget(questionRegion && questionRegion.querySelector('legend'));
        }
        function editFromReview(index) {
            if (!live() || !reviewing || !Number.isInteger(index) || index < 0 || index >= questions.length) return;
            reviewing = false; returnToReview = questions[index].id; activeQuestion = index; render();
            focusTarget(questionRegion && questionRegion.querySelector('legend'));
        }
        function resumeReview() {
            if (!live() || !returnToReview || !acknowledged || acknowledged.status === 'submitted') return;
            const id = returnToReview; reviewing = true; returnToReview = null; errors = []; render();
            focusTarget(content.querySelector('[id="ncsc-review-edit-' + id + '"]') || content.querySelector('[id="ncsc-review-title"]'));
        }
        function canEdit() { return editable && acknowledged && acknowledged.status !== 'submitted' && !conflict && !(pending && pending.command.action === 'submit'); }
        // The same source Overview uses for "Plan this": this displayed submission, not the latest or the first saved plan.
        function displayedPlanSource() {
            const detail = acknowledged, submission = detail && detail.submission, profile = detail && detail.profileRef;
            const outputSha256 = submission && submission.outputSha256;
            const keys = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
            if (!detail || detail.status !== 'submitted' || !submission || !submission.results) return null;
            if (typeof detail.assessmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(detail.assessmentId)) return null;
            if (!Number.isSafeInteger(detail.revision) || detail.revision < 0 || detail.revision > 128) return null;
            if (typeof detail.revisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(detail.revisionSha256)) return null;
            if (typeof outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(outputSha256)) return null;
            if (!profile || typeof profile !== 'object') return null;
            const profileRef = {};
            for (let index = 0; index < keys.length; index += 1) {
                const key = keys[index], item = profile[key];
                if (typeof item !== 'string' || !item || item.length > 200 || key.endsWith('Sha256') && !/^[a-f0-9]{64}$/.test(item)) return null;
                profileRef[key] = item;
            }
            return { assessmentId: detail.assessmentId, revision: detail.revision, revisionSha256: detail.revisionSha256, profileRef: profileRef, outputSha256: outputSha256 };
        }
        function renderResults(results) {
            const panel = node('section', 'ncsc-results'); panel.setAttribute('aria-label', 'Assessment results');
            panel.append(node('h2', '', 'Assessment results'));
            content.append(panel);
            const campaign = resultsCampaign(win);
            const boardExportGate = options.boardExportGate || (content => content());
            const gated = typeof options.detailsGate === 'function' ? options.detailsGate : content => content();
            // Keep the same gated anchor and keyboard focus while one shared probe settles.
            const availability = enquiryAvailable(win);
            let offered = false;
            const resultHelp = (label, full = false) => {
                const slot = node('div', full ? 'picture-next-steps-help' : 'ncsc-results-contact');
                if (full && campaignOfferBridge[campaign]) slot.append(node('p', '', campaignOfferBridge[campaign]));
                slot.append(node('p', 'picture-offer', MANAGED_SECURITY_OFFER));
                // The link only opens the public contact page, so it is not behind the details gate.
                slot.append((() => {
                    const link = node('a', 'dashboard-button');
                    function show(available) {
                        link.textContent = available ? 'Fix these with No Fries' : 'Email hello@nofries.nz';
                        link.href = available ? '/contact.html?service=managed_security_90' : 'mailto:hello@nofries.nz';
                        if (label) link.setAttribute('aria-label', link.textContent + ': ' + label);
                    }
                    show(false);
                    availability.then(available => { if (live()) show(available); });
                    return link;
                })());
                const pricing = node('a', '', 'See pricing and what’s included'); pricing.href = '/pricing#pricing-pilot';
                slot.append(pricing);
                return slot;
            };
            function appendBoardSummary() {
                const section = node('section', 'ncsc-board-next-step picture-summary');
                const copied = node('p', 'dashboard-muted'); copied.setAttribute('role', 'status');
                section.append(node('h3', '', 'Summary for your board or insurer'),
                    boardExportGate(() => boardSummaryBlock(node, button, win, acknowledged, metadata, 'ncsc-board-summary', copied, undefined, undefined, topGaps(results, metadata), previousSubmission())), copied);
                if (campaign === 'board' && topGaps(results, metadata, 1).length) {
                    section.append(node('p', '', 'Use a reported gap to agree a next action, an owner and a date with your board.'),
                        button('Go to your top gaps', function () {
                            focusTarget(panel.querySelector('[id="ncsc-results-top-gaps"]'));
                        }, 'dashboard-button dashboard-button-secondary'));
                }
                panel.append(section);
            }
            if (campaign === 'board') appendBoardSummary();
            else if (campaign === 'scam') {
                const payment = questionnaireAnswers(acknowledged, metadata).items.find(item => item.id === 'payment-checks');
                const section = node('section', 'ncsc-payment-next-step');
                section.append(node('h3', '', payment.answer === 'No' ? 'Payment-check gap and next step' : 'Check payment changes safely'),
                    node('p', '', payment.answer === 'No'
                        ? 'Your saved No answer reports a gap in checking payment and bank-detail changes through a trusted, separate route.'
                        : 'Confirm how payment and bank-detail changes are checked. These saved answers do not establish a payment-check gap.'));
                const paymentChecks = node('ol');
                paymentChecks.append(
                    node('li', '', 'Pause the payment when the account details change.'),
                    node('li', '', 'Check payment and bank-detail changes using a known phone number or another trusted, separate route. Do not use contact details from the new request.'),
                    node('li', '', 'Record who confirmed the details and when. If you cannot confirm the change, do not pay yet.'));
                section.append(paymentChecks);
                panel.append(section, resultHelp('', true)); offered = true;
            }
            const questionnaireFirst = campaign === 'insurance' || campaign === 'supplier';
            if (questionnaireFirst) renderQuestionnaireAnswers(panel);
            if (questionnaireFirst && campaign === 'insurance') appendBoardSummary();
            if (results) {
                // #657: one offer block straight after the gaps, not a button on every gap.
                panel.append(rankedGapSection(node, results, metadata, 'ncsc-results-top-gaps', undefined, undefined, gapHelp(doc)));
                if (!offered) { panel.append(resultHelp('', true)); offered = true; }
            }
            if (results && options.appendFrameworkComparison) options.appendFrameworkComparison(panel);
            renderNextSteps(panel, results ? topGaps(results, metadata) : undefined);
            // The board or insurer summary is on Results for every visit, not only
            // when a board or insurance campaign tag survived sign-up (#441 G04).
            if (results && campaign !== 'board' && campaign !== 'insurance') appendBoardSummary();
            if (!questionnaireFirst) renderQuestionnaireAnswers(panel);
            if (!results) {
                panel.append(node('p', 'ncsc-warning', 'Results are unavailable for this submission. Your saved answers remain below. Reopen the assessment to try again.'),
                    button('Retry loading results', async function () {
                        if (loading) return; const expected = epoch; await refreshCurrent(false, expected); if (live(expected)) render();
                    }, 'dashboard-button dashboard-button-secondary'));
                return;
            }
            panel.append(node('p', 'dashboard-muted', 'These results describe the saved submission and its declared scope. They are gap indicators, not an audit or certification.'));
            const metrics = node('div', 'ncsc-result-metrics'); panel.append(metrics);
            function metric(title, value, explanation) {
                const card = node('section', 'ncsc-result-metric'); card.append(node('h3', '', title), node('p', 'ncsc-result-value', value), node('p', '', explanation)); metrics.append(card);
            }
            // Describe only what is shown: a range has a lower and higher figure, a single figure does not.
            const rangeHelp = results.lowerCreditUnits === results.upperCreditUnits
                ? 'This is what you reported as in place. Every answer is Yes, Partial or No, so there is one figure.'
                : 'The lower figure is what you reported as in place. The higher figure adds answers still to confirm: Unknown, and Not applicable. Those do not count as in place.';
            if (enoughAnswersToEstimate(results)) metric('Reported implementation', results.attainment, rangeHelp);
            // Results exist only for a submitted, read-only assessment, so do not ask the customer to confirm answers here.
            else metric('Reported implementation', 'Not enough answers to estimate yet, confirm your Unknowns first', results.unknown + ' answers still to confirm. Only ' + results.completed + ' of ' + results.total +
                ' answers are Yes, Partial or No. Most answers are Unknown or Not applicable, so the range is too wide to be useful. Range so far: ' + results.attainment + '. ' +
                (editable && !allowanceExhausted() ? 'Start a new assessment once more answers are known. ' : '') + rangeHelp);
            metric('Answers confirmed', results.completed + ' of ' + results.total, results.completion + ' answered Yes, Partial or No. This measures how much is known, not how much is implemented.');
            leadWithLowerBound(metrics.querySelector('.ncsc-result-metric'), '.ncsc-result-value', results);
            panel.append(node('p', 'dashboard-muted', 'Risk priority: Not calculated. Suggested actions follow framework order, not risk order. Trend: Not shown here. To compare submitted assessments, use Change over time on the Overview.'));
            // After the score, so the lower figure leads. The link carries this submission,
            // so an older saved plan is not offered in its place.
            const planSource = displayedPlanSource();
            if (typeof options.openImprovement === 'function' && planSource) {
                const follow = node('section', 'ncsc-plan-followup');
                follow.append(node('h3', '', 'Follow up on this assessment'));
                const preview = node('details'), steps = providerSummary(acknowledged, metadata, results ? topGaps(results, metadata) : undefined).items;
                preview.append(node('summary', '', 'Assessment follow-ups (' + steps.length + ')'));
                const list = node('ol');
                steps.forEach(step => {
                    const item = node('li');
                    item.append(node('strong', '', step.title), node('p', '', step.action));
                    list.append(item);
                });
                preview.append(steps.length ? list : node('p', '', 'No answers were marked No, Partial, Unknown or Not applicable.'));
                const link = node('a', '', 'Open improvement plan'); link.href = '#improvement-plan';
                link.addEventListener('click', function (event) {
                    event.preventDefault();
                    if (live()) options.openImprovement(planSource);
                });
                follow.append(preview, node('p', '', 'Open Improvement Plan to review proposed actions, including evidence to update for Yes answers. You can give each item an owner and a due date.'), link);
                panel.append(follow);
            }
            // results.unknown already includes answers marked not applicable, so state one total.
            panel.append(node('p', '', results.unknown ? 'Answers still to confirm: ' + results.unknown + ' (' + confirmBreakdown(results.unknown - results.pending, results.pending) + ').'
                : 'Every answer is confirmed as Yes, Partial or No.'));
            panel.append(node('p', 'dashboard-muted', isV2(metadata)
                ? 'Each question has a weight from 1 to 3, shown below. Yes, in place and checked earns its full weight, Partly in place half, Sometimes a quarter and No nothing. Extra login methods earn from 30% for text or email codes to full weight for a passkey or security key. The lower end gives I don\'t know nothing; the upper end gives it full weight. Not applicable answers count as not yet met, and they stay in your result. There is no review that changes that. This is a No Fries planning score from your answers, not an official NCSC or CS-CMM rating.'
                : 'No Fries weights every question equally: Yes earns 1, Partial 0.5 and No 0. The lower end gives answers still to confirm 0; the upper end gives them 1. Not applicable answers count as not yet met, and they stay in your result. There is no review that changes that. This is a No Fries calculation, not an NCSC score.'));
            panel.append(node('h3', '', 'Explore NCSC functions and assessment topics'));
            results.domains.forEach(function (domain) {
                const detail = node('details', 'ncsc-result-domain'); detail.append(node('summary', '', domain.title + ' — ' + domain.attainment));
                domain.controls.forEach(function (control) {
                    const item = node('details', 'ncsc-result-control'); item.append(node('summary', '', plainControlTitle(control.title) + ' — ' + control.attainment));
                    control.questions.forEach(function (question) {
                        item.append(node('h4', '', question.prompt), node('p', '', 'Saved answer: ' + question.answer + '. Weight: ' + question.weight + '.'));
                        if (question.rationale) item.append(node('p', 'ncsc-preserve-text', 'Why it is marked not applicable: ' + question.rationale));
                        [['Suggested next actions', question.actions], ['Useful evidence', question.examples]].forEach(function (group) {
                            item.append(node('h4', '', group[0])); const list = node('ul'); group[1].forEach(function (text) { list.append(node('li', '', text)); }); item.append(list);
                        });
                    }); detail.append(item);
                }); panel.append(detail);
            });
            if (!offered) panel.append(resultHelp('', true));
        }
        // Show the reported (lower) figure first; the upper figure follows in a plain sentence.
        function leadWithLowerBound(card, valueSelector, model) {
            const value = card && card.querySelector(valueSelector);
            if (!value || !model.lowerDisplay || model.lowerDisplay === model.upperDisplay || value.textContent !== model.attainment) return;
            value.textContent = model.lowerDisplay + ' in place';
            const upTo = node('p', 'ncsc-result-upper', 'Up to ' + model.upperDisplay + ' if every answer still to confirm turns out to be in place.');
            const children = Array.from(card.children); children.splice(children.indexOf(value) + 1, 0, upTo); card.replaceChildren.apply(card, children);
        }
        function renderNextSteps(panel, gaps) {
            const section = node('section', 'ncsc-next-steps'); section.append(node('h3', '', 'Suggested follow-ups'));
            const countOf = function (ids) { return questions.filter(function (question) { return ids.includes(answerGroup(savedAnswer(question.id).optionId)); }).length; };
            const toFix = countOf(['no', 'partial']), toCheck = countOf(['unknown', 'not_applicable']);
            const plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
            // One plain verdict before any percentages. The list follows answer groups, not risk.
            if (toFix || toCheck) section.append(node('p', 'ncsc-verdict', 'You have ' + plural(toFix, 'gap', 'gaps') + ' to fix and ' + plural(toCheck, 'answer', 'answers') + ' to check.'));
            if (toCheck) section.append(node('p', 'dashboard-muted', 'Not sure who to ask? No Fries can check these with you.'));
            const list = node('ol'), summary = providerSummary(acknowledged, metadata, gaps);
            summary.items.forEach(function (entry) {
                const item = node('li'); item.append(node('strong', '', entry.title)); if (entry.owner) item.append(node('p', 'dashboard-muted', entry.owner)); item.append(node('p', '', entry.action)); list.append(item);
            });
            const followUpCount = list.children.length;
            if (followUpCount) section.append(node('p', '', 'Suggested follow-ups: ' + followUpCount + '. Your top gaps come first, in the same order, then other gaps and answers to check.'));
            if (followUpCount > 3) Array.prototype.forEach.call(list.children, function (item, index) { if (index >= 3) item.hidden = true; });
            section.append(list);
            if (followUpCount > 3) {
                const items = Array.prototype.slice.call(list.children);
                const more = button('View all ' + followUpCount + ' follow-ups', function () {
                    items.forEach(function (item) { item.hidden = false; });
                    more.remove();
                    // The button is gone, so keep keyboard focus on the first follow-up it revealed.
                    items[3].tabIndex = -1; items[3].focus();
                }, 'dashboard-button dashboard-button-secondary');
                section.append(more);
            }
            if (!followUpCount) section.append(node('p', '', 'You answered Yes throughout. No Fries can check these answers with you and agree when to review them.'));
            const handoff = node('details'); handoff.append(node('summary', '', 'Summary to share with whoever is fixing these'));
            const label = node('label', '', 'Copy this summary into an email or document'); label.htmlFor = 'ncsc-provider-summary';
            const input = node('textarea', 'ncsc-textarea'); input.id = label.htmlFor; input.readOnly = true; input.rows = 8; input.value = summary.text; handoff.append(label, input);
            const copied = node('p', 'dashboard-muted'); copied.setAttribute('role', 'status');
            const copy = button('Copy summary', function () { copySummary(win, input, copied); }, 'dashboard-button dashboard-button-secondary');
            handoff.append(copy);
            // Paper gets the summary itself, not the whole dashboard (#662): title,
            // scope, date and the follow-ups, with no navigation or account details.
            const printed = node('pre', 'picture-summary-print', summary.text); printed.setAttribute('aria-hidden', 'true'); handoff.append(printed);
            if (win && typeof win.print === 'function') handoff.append(button('Print these results', function () { printOnly(win, printed); }, 'dashboard-button dashboard-button-secondary'));
            handoff.append(copied); section.append(handoff); panel.append(section);
        }
        function renderQuestionnaireAnswers(panel) {
            const report = questionnaireAnswers(acknowledged, metadata);
            const section = node('section', 'ncsc-questionnaire-answers'); section.setAttribute('aria-labelledby', 'ncsc-questionnaire-answers-title');
            const title = node('h3', '', report.title); title.id = 'ncsc-questionnaire-answers-title';
            section.append(title, node('p', '', 'Suggested answers from this saved assessment. Not answered means the detail is missing or cannot be confirmed from your answers.'), node('p', '', report.scope));
            const nextEvidence = resultsCampaign(win) === 'supplier' && report.items.find(item => item.evidence);
            if (nextEvidence) {
                const next = button('Jump to the first answer to verify', function () {
                    focusTarget(section.querySelector('[id="ncsc-supplier-first-evidence"]'));
                }, 'dashboard-button dashboard-button-secondary');
                section.append(node('p', '', 'Start with an answer that needs evidence. Verify the exact question before giving it to your customer.'), next);
            }
            const list = node('ol');
            report.items.forEach(function (item) {
                const row = node('li'); row.setAttribute('data-answer-id', item.id);
                const question = node('h4', '', item.question);
                if (item === nextEvidence) { question.id = 'ncsc-supplier-first-evidence'; question.tabIndex = -1; }
                row.append(question, node('strong', '', 'Suggested answer: ' + item.answer),
                    node('p', 'dashboard-muted', item.basis), node('p', '', item.action));
                if (item.evidence) row.append(node('p', '', item.evidence));
                list.append(row);
            });
            section.append(list);
            const gated = typeof options.questionnaireExportGate === 'function';
            if (gated) section.setAttribute('data-export-ready', 'false');
            const exports = function () {
                const controls = node('div', 'ncsc-questionnaire-answer-controls');
                const label = node('label', '', 'Answers to copy'); label.htmlFor = 'ncsc-questionnaire-answer-text';
                const input = node('textarea', 'ncsc-textarea'); input.id = label.htmlFor; input.readOnly = true; input.rows = 5; input.value = report.text;
                const copied = node('p', 'dashboard-muted'); copied.setAttribute('role', 'status');
                controls.append(label, input, button('Copy answers', function () { copySummary(win, input, copied); }, 'dashboard-button dashboard-button-secondary'));
                if (win && typeof win.print === 'function') controls.append(button('Print answers', function () { printOnly(win, section); }, 'dashboard-button dashboard-button-secondary'));
                controls.append(copied);
                if (gated) section.setAttribute('data-export-ready', 'true');
                return controls;
            };
            section.append(gated ? options.questionnaireExportGate(exports) : exports(), node('footer', '', report.footer)); panel.append(section);
        }
        function renderQuestion() {
            if (!live() || !questionRegion || !acknowledged) return;
            if (!restoringQuestion && typeof options.onLocation === 'function') options.onLocation({ assessmentId: acknowledged.assessmentId, questionIndex: activeQuestion });
            abortAssistance();
            const focused = captureFocus(questionRegion);
            questionRegion.replaceChildren();
            const renderedEpoch = epoch;
            const question = questions[activeQuestion];
            const entry = acknowledged.status === 'submitted' ? { value: savedAnswer(question.id) } : drafts.get(question.id);
            const control = metadata.controls.find(function (item) { return item.id === question.controlId; });
            const domain = metadata.domains.find(function (item) { return control && item.id === control.domainId; });
            const layout = node('div', 'ncsc-focus-layout');
            const answers = node('div', 'ncsc-focus-answers');
            layout.append(answers); questionRegion.append(layout);
            answers.append(node('p', 'dashboard-eyebrow', [domain && domain.title, control && plainControlTitle(control.title)].filter(Boolean).join(' · ')));
            // A stable id lets a save that re-renders the page keep focus on the
            // question text instead of dropping it to the page heading.
            const legend = node('legend', '', plainQuestion(question));
            legend.id = 'ncsc-question-text'; legend.tabIndex = -1;
            const fieldset = node('fieldset', 'ncsc-answer'); fieldset.append(legend);
            // The worked examples describe the accepted profile's questions and answers only.
            const inputGuidance = isV2(metadata) ? undefined : QUESTION_INPUT_GUIDANCE[question.id];
            const sealed = acknowledged.status === 'submitted';
            if (sealed || !question.smallBusiness) {
                const hint = node('p', 'ncsc-input-guidance', sealed ? 'This is the answer you submitted. Submitted answers cannot be changed.'
                    : inputGuidance ? inputGuidance.consider : question.guidance && question.guidance.summary || question.prompt);
                hint.id = 'ncsc-input-guidance-' + question.id; fieldset.setAttribute('aria-describedby', hint.id); fieldset.append(hint);
            }
            // The choices follow the question directly. The example, checks, full
            // framework wording and answer meanings sit in one native disclosure
            // after them: open by default on wider screens, closed on narrow ones.
            const help = node('details', 'ncsc-question-help'); help.id = 'ncsc-question-help-' + question.id;
            help.append(node('summary', '', 'Help with this question'));
            if (question.smallBusiness) {
                help.append(node('p', 'ncsc-input-example', 'Example: ' + question.smallBusiness.example));
                const checks = node('ul');
                question.smallBusiness.checks.forEach(function (text) { checks.append(node('li', '', text)); });
                help.append(node('h3', '', 'What to check'), checks,
                    node('h3', '', 'Full framework question'), node('p', '', question.prompt));
            }
            const meanings = node('div', 'ncsc-help-answers'); meanings.append(node('h3', '', 'What the answers mean'));
            const meaningList = node('ul');
            question.responseOptionIds.forEach(function (id) {
                const option = optionById.get(id); const item = node('li');
                item.append(node('strong', '', option.label + ': '), node('span', '', ANSWER_GUIDANCE[id])); meaningList.append(item);
            });
            meanings.append(meaningList); help.append(meanings);
            const narrow = !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(max-width: 30rem)').matches);
            help.open = questionHelpOpen.has(question.id) ? questionHelpOpen.get(question.id) : !sealed && !narrow;
            help.addEventListener('toggle', function () { if (live(renderedEpoch)) questionHelpOpen.set(question.id, help.open); });
            if (acknowledged.status === 'submitted') fieldset.append(node('p', 'dashboard-badge', 'Your answer: ' + (optionById.get(entry.value.optionId)?.label || 'Not answered')));
            const tiles = node('div', 'ncsc-answer-tiles'); fieldset.append(tiles);
            const writable = canEdit();
            question.responseOptionIds.forEach(function (id) {
                const option = optionById.get(id); const label = node('label', 'ncsc-option');
                const input = node('input'); input.type = 'radio'; input.name = 'ncsc-answer-' + question.id; input.id = 'ncsc-answer-' + question.id + '-' + id;
                input.value = id; input.checked = entry.value.optionId === id; input.disabled = !writable;
                const title = node('strong', '', option.label); title.id = input.id + '-label';
                const definition = node('span', 'dashboard-muted ncsc-option-help', TILE_HINT[id]); definition.id = input.id + '-help';
                input.setAttribute('aria-labelledby', title.id); input.setAttribute('aria-describedby', definition.id);
                const description = node('span'); description.append(title, node('br', 'ncsc-option-break'), definition);
                label.setAttribute('for', input.id); label.append(input, description);
                input.addEventListener('change', function () {
                    if (!live(renderedEpoch) || !writable || !canEdit() || !input.checked) return;
                    const old = drafts.get(question.id).value;
                    const firstAnswer = questions.every(function (item) { return displayedAnswer(item).optionId === null; });
                    drafts.set(question.id, { value: { itemId: question.id, optionId: id, rationale: option.applicable ? null : { text: old.rationale ? old.rationale.text : '' } }, generation: ++editGeneration });
                    renderQuestion(); edited();
                    if (firstAnswer) funnelStep('first_answer');
                    const current = questionRegion.querySelector('[id="' + input.id + '"]'); if (current) current.focus();
                });
                tiles.append(label);
            });
            answers.append(fieldset);
            const selectedOption = optionById.get(entry.value.optionId);
            if (selectedOption && !selectedOption.applicable) {
                const label = node('label', '', 'Why this does not apply'); label.setAttribute('for', 'ncsc-rationale-' + question.id);
                const rationale = node('textarea', 'ncsc-textarea'); rationale.id = 'ncsc-rationale-' + question.id; rationale.value = entry.value.rationale ? entry.value.rationale.text : '';
                rationale.rows = 6; rationale.required = true; rationale.readOnly = !writable;
                // Say at once why the answer is not saved yet, instead of only when Save progress is pressed.
                const needed = node('p', 'ncsc-rationale-needed', autosaveEnabled ? 'Add an explanation to save this answer.' : 'Add an explanation before you save this answer.');
                needed.id = 'ncsc-rationale-needed-' + question.id;
                const showNeeded = function () {
                    needed.hidden = !writable || validText(rationale.value) || errors.some(function (item) { return item.id === question.id; });
                    rationale.setAttribute('aria-describedby', (needed.hidden ? '' : needed.id + ' ') + 'ncsc-rationale-help-' + question.id);
                };
                showNeeded();
                const scopeHelp = writable && inputGuidance && inputGuidance.notApplicable ? inputGuidance.notApplicable + ' ' : '';
                const help = node('p', 'dashboard-muted', scopeHelp + 'Explain why this does not apply, in up to 4,000 characters. Not applicable answers count as not yet met, and they stay in your result. There is no review that changes that.'); help.id = 'ncsc-rationale-help-' + question.id;
                rationale.addEventListener('input', function () {
                    if (!live(renderedEpoch) || !writable || !canEdit()) return;
                    drafts.set(question.id, { value: { itemId: question.id, optionId: selectedOption.id, rationale: { text: rationale.value } }, generation: ++editGeneration });
                    showNeeded(); edited();
                });
                answers.append(label, needed, rationale, help);
            }
            if (writable) {
                const clear = button('Clear answer', function () {
                    drafts.set(question.id, { value: { itemId: question.id, optionId: null, rationale: null }, generation: ++editGeneration }); renderQuestion(); edited();
                }, 'dashboard-text-button');
                clear.id = 'ncsc-clear-answer'; answers.append(clear);
            }
            const side = node('aside', 'ncsc-focus-help'); side.setAttribute('aria-label', 'Question guidance');
            side.append(help); layout.append(side);
            const guidance = node('details', 'ncsc-guidance'); guidance.append(node('summary', '', 'Guidance and evidence examples'));
            if (inputGuidance) guidance.append(node('p', 'ncsc-input-example', 'Example: ' + inputGuidance.example));
            if (question.guidance) {
                guidance.append(node('p', '', question.guidance.summary));
                [['Evidence examples', question.guidance.evidenceExamples], ['Starting actions', question.guidance.startingActions]].forEach(function (pair) {
                    guidance.append(node('h3', '', pair[0])); const list = node('ul'); (pair[1] || []).forEach(function (text) { list.append(node('li', '', text)); }); guidance.append(list);
                });
            }
            guidance.append(node('p', 'dashboard-muted', 'Evidence examples are records you can consult to check your answer.'));
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
            help.append(guidance);
            renderAssistance(question, writable, side);
            if (!sealed) side.append(glossary());
            const nav = node('div', 'ncsc-question-navigation');
            const previous = button('Previous question', function () {
                if (questionRegion.contains(previous) && activeQuestion > 0) { activeQuestion -= 1; renderAssessmentQuestion(); }
            }, 'dashboard-button dashboard-button-secondary'); previous.disabled = activeQuestion === 0;
            const next = button('Next question', function () {
                if (questionRegion.contains(next) && activeQuestion < questions.length - 1) { activeQuestion += 1; renderAssessmentQuestion(); }
            }); next.disabled = activeQuestion === questions.length - 1;
            // Fixed slots, filled by updateReviewInNavigation, so nothing in the
            // bar is moved (and focus is kept) when the last answer arrives.
            const reviewSlot = node('span', 'ncsc-navigation-review-slot');
            const ready = node('p', 'ncsc-navigation-ready'); ready.id = 'ncsc-navigation-ready'; ready.hidden = true;
            ready.setAttribute('role', 'status');
            const navigationActions = node('div', 'ncsc-navigation-actions'); navigationActions.append(previous, next, reviewSlot);
            nav.append(ready);
            navigationNext = next; navigationReview = null; navigationReviewSlot = reviewSlot; navigationReady = ready;
            // On narrow screens the bar sticks to the bottom of the screen with
            // Previous and Next; the two jump buttons sit behind More. Wider
            // screens show all four and no More button. DOM order is the tab order.
            const more = node('div', 'ncsc-navigation-more ncsc-navigation-collapsed'); more.id = 'ncsc-navigation-more';
            const moreToggle = button('More', function () {
                const expanded = moreToggle.getAttribute('aria-expanded') !== 'true';
                moreToggle.setAttribute('aria-expanded', String(expanded));
                more.classList[expanded ? 'remove' : 'add']('ncsc-navigation-collapsed');
            }, 'dashboard-button dashboard-button-secondary ncsc-navigation-more-toggle');
            moreToggle.id = 'ncsc-navigation-more-toggle'; moreToggle.setAttribute('aria-expanded', 'false'); moreToggle.setAttribute('aria-controls', more.id);
            navigationActions.append(moreToggle, more);
            nextUnanswered = null;
            if (acknowledged.status !== 'submitted') {
                const jump = button('Next unanswered question', function () {
                    if (!questionRegion.contains(jump)) return;
                    const index = unansweredIndex(activeQuestion);
                    if (index !== -1) { activeQuestion = index; renderAssessmentQuestion(); }
                }, 'dashboard-text-button');
                nextUnanswered = jump; more.append(jump);
            }
            const unresolved = button('Next question still to confirm', function () {
                if (!questionRegion.contains(unresolved)) return;
                const index = unresolvedIndex(activeQuestion);
                if (index !== -1) { activeQuestion = index; renderAssessmentQuestion(); }
            }, 'dashboard-text-button');
            nextUnresolved = unresolved; more.append(unresolved);
            nav.append(navigationActions); questionRegion.append(nav); updateQuestionNavigation();
            // A bar taller than a quarter of the screen (enlarged text, a short
            // landscape phone) would cover answers, so it stays in the page below
            // the choices instead of sticking (WCAG 1.4.4, 1.4.10).
            stopNavigationFit();
            const header = functionSteps.parentElement;
            const fitNavigation = function () {
                if (!nav.isConnected) { stopNavigationFit(); return; }
                header.classList[win && header.offsetHeight > win.innerHeight / 3 ? 'add' : 'remove']('ncsc-stepper-static');
                const tall = Boolean(win && nav.offsetHeight > (win.innerHeight || 0) / 4);
                nav.classList[tall ? 'add' : 'remove']('ncsc-navigation-static');
            };
            fitNavigation();
            // Re-check when the bar changes size (text size) or the screen does
            // (rotation, browser bars); stopped when the question is replaced.
            const watcher = win && typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(fitNavigation) : null;
            if (watcher) watcher.observe(nav);
            if (watcher) watcher.observe(header);
            if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', fitNavigation);
            stopNavigation = function () {
                if (watcher) watcher.disconnect();
                if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', fitNavigation);
            };
            applyInlineErrors();
            restoreFocus(questionRegion, focused, fieldset.querySelector('legend'));
        }
        function renderAssistance(question, writable, side) {
            if (acknowledged.status === 'submitted') assistanceNotes.clear();
            const assistant = options.assistance;
            const assisted = writable && assistant && typeof assistant.suggest === 'function';
            const panel = node('details', 'ncsc-guidance');
            // Without AI the panel is plain guidance; do not promise help that is switched off.
            panel.append(node('summary', '', assisted ? 'Help me answer this question' : 'How to answer this question'));
            panel.append(node('p', '', question.guidance && question.guidance.summary || question.prompt));
            panel.append(node('p', 'dashboard-muted', 'Describe what actually happens, who manages it, and what information supports it. Unknown is a valid answer.' + (assisted ? ' AI suggestions need your review and do not verify evidence.' : '')));
            side.append(panel);
            if (!assisted) return;
            const label = node('label', '', 'Describe your setup or paste relevant information');
            const notes = node('textarea', 'ncsc-textarea'); notes.id = 'ncsc-assistance-notes-' + question.id;
            notes.value = assistanceNotes.get(question.id) || '';
            notes.maxLength = 4000; label.setAttribute('for', notes.id);
            panel.append(label, notes, node('p', 'dashboard-muted', 'Use only information approved for this assessment. Do not include passwords, tokens or personal information.'));
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
            renderQuestion(); const legend = questionRegion.querySelector('legend'); legend.tabIndex = -1; legend.focus();
            // Navigation is often pressed from below the question; bring the new question into view.
            if (typeof questionRegion.scrollIntoView === 'function') questionRegion.scrollIntoView({ block: 'start' });
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
                fieldset.setAttribute('aria-describedby', ((fieldset.getAttribute('aria-describedby') || '') + ' ' + message.id).trim());
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
                        if (error.id !== 'scope') {
                            activeQuestion = questions.findIndex(function (item) { return item.id === error.id; });
                            if (reviewing) { reviewing = false; returnToReview = error.id; render(); }
                            renderAssessmentQuestion();
                        }
                        const input = error.id === 'scope' ? content.querySelector('textarea') : answerErrorTarget(question);
                        if (input) input.focus();
                    }); row.append(link); list.append(row);
                }); errorBox.append(list);
            }
            if (view === 'create') {
                const input = content.querySelector('textarea');
                if (input) {
                    if (errors.length) { input.setAttribute('aria-invalid', 'true'); errorBox.id = 'ncsc-scope-error'; input.setAttribute('aria-describedby', SCOPE_DESCRIBED_BY + ' ncsc-scope-error'); }
                    else { input.removeAttribute('aria-invalid'); input.setAttribute('aria-describedby', SCOPE_DESCRIBED_BY); }
                }
            }
            // Repaint the question only when its errors change; a clean check
            // before each autosave must not rebuild the tiles being tapped (#699).
            const errorKey = JSON.stringify(errors);
            if (questionRegion && acknowledged && (errorKey !== renderedErrorKey || focus)) renderQuestion();
            renderedErrorKey = errorKey;
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
        async function saveAll(drain, keepalive, automatic) {
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
                        if (!await perform(command, batch, false, keepalive && client.commandByteLength(command) <= KEEPALIVE_LIMIT, automatic === true)) return false;
                    } catch (error) { if (live(expected)) fixedFailure(error); return false; }
                }
                if (!live(expected)) return false;
            } while (drain && dirtyEntries().length);
            return !dirtyEntries().length || !drain;
        }
        function unfinishedStatusLabel(item) {
            const answered = item.progress && Number.isFinite(item.progress.answered) ? item.progress.answered : 0;
            return answered > 0 ? 'In progress' : 'Not started';
        }
        function requestSubmit() {
            if (!live() || submitPrompt || submitLocked || busy || pending || conflict || !currentChecked || leave ||
                !reviewing || !editable || !acknowledged || acknowledged.status === 'submitted') return;
            if (!validateDraft(true)) return;
            submitPrompt = true; renderSubmitDialog();
        }
        function renderSubmitDialog() {
            if (!live() || !submitPrompt) return;
            removeDialog();
            dialog = node('dialog', 'ncsc-leave-dialog ncsc-submit-dialog');
            dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'ncsc-submit-title');
            const title = node('h3', '', 'Submit this assessment?'); title.id = 'ncsc-submit-title';
            dialog.append(title, node('p', '', 'Submitting locks this assessment and its scope. The assessment becomes read-only.'));
            const submit = button('Submit', acceptSubmit);
            const cancel = button('Cancel', cancelSubmit, 'dashboard-text-button');
            dialog.append(submit, cancel);
            dialog.addEventListener('keydown', function (event) {
                if (!live() || !submitPrompt) return;
                if (event.key === 'Escape') { event.preventDefault(); cancelSubmit(); }
                if (event.key === 'Tab') {
                    const items = Array.from(dialog.querySelectorAll('button')).filter(function (item) { return !item.disabled; });
                    const index = items.indexOf(doc.activeElement);
                    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
                    event.preventDefault(); if (items[next]) items[next].focus();
                }
            });
            dialog.addEventListener('cancel', function (event) { event.preventDefault(); if (live() && submitPrompt) cancelSubmit(); });
            root.append(dialog);
            if (typeof dialog.showModal !== 'function') {
                submitPrompt = false; removeDialog(); dialog = null;
                statusText = 'This browser cannot open the confirmation. The assessment was not submitted.'; updateStatus(); return;
            }
            try { dialog.showModal(); cancel.focus(); }
            catch (error) {
                submitPrompt = false; removeDialog(); dialog = null;
                statusText = 'The confirmation could not open. The assessment was not submitted.'; updateStatus();
            }
        }
        function acceptSubmit() {
            if (!live() || !submitPrompt || submitLocked) return;
            submitLocked = true; submitPrompt = false; removeDialog(); dialog = null;
            Promise.resolve(submitAssessment()).finally(function () { submitLocked = false; });
        }
        function cancelSubmit() {
            if (!submitPrompt) return;
            submitPrompt = false; removeDialog(); dialog = null;
            const opener = live() ? root.querySelector('[id="ncsc-review-submit"]') : null;
            if (opener) opener.focus();
        }
        async function submitAssessment() {
            if (!live() || busy || pending || conflict || !currentChecked || !acknowledged || acknowledged.status === 'submitted' || !editable) return;
            if (!validateDraft(true)) return;
            const expected = epoch;
            if (!await saveAll(true) || !live(expected) || pending || dirtyEntries().length || !validateDraft(true)) return;
            try {
                const command = client.normaliseCommand({ assessmentId: selected, action: 'submit', idempotencyKey: newId(), expectedRevision: acknowledged.revision, payload: {} });
                await perform(command, [], false, false, true);
            } catch (error) { if (live(expected)) fixedFailure(error); }
        }
        // Replay the same command after a 503. A committed submit returns its
        // receipt without consuming another submission from the allowance.
        async function sendWithAutomaticRetry(command, expected, operation, automatic) {
            const delays = !automatic ? [] : command.action === 'submit' ? [500] : autosaveRetryDelays;
            for (let attempt = 0; ; attempt += 1) {
                try { return await call(command.action, command, expected, operation.keepalive); }
                catch (error) {
                    if (attempt >= delays.length || !error || error.statusCode !== 503 || error.code === 'ncsc_access_denied' ||
                        !live(expected) || pending !== operation) throw error;
                    statusText = command.action === 'submit' ? 'Submission is taking longer than usual. Checking the result.'
                        : 'Saving is taking longer than usual. Trying again automatically.';
                    updateStatus();
                    await new Promise(function (resolve) { const timer = setTimeout(resolve, delays[attempt]); if (timer && typeof timer.unref === 'function') timer.unref(); });
                    if (!live(expected) || pending !== operation) throw error;
                }
            }
        }
        async function perform(command, captures, retry, keepalive, automatic) {
            if (!live() || busy || pending && !retry) return false;
            const expected = epoch;
            if (!retry) pending = { command: command, captures: captures, uncertain: false, keepalive: keepalive === true };
            const operation = pending; busy = true; busyAction = operation && operation.command ? operation.command.action : null; statusText = '';
            const focusBeforeMutation = doc.activeElement;
            operation.restoreSave = focusBeforeMutation && (focusBeforeMutation.id === 'ncsc-save' || focusBeforeMutation.id === 'ncsc-save-status');
            // Keep Save mounted while a request runs; a second press cannot hit a replacement control.
            if (command.action === 'save' && !reviewing) {
                updateStatus();
                if (operation.restoreSave && saveStatus && root.contains(saveStatus)) { saveStatus.tabIndex = -1; saveStatus.focus({ preventScroll: true }); }
            } else render();
            let failed = false;
            try {
                const result = await sendWithAutomaticRetry(command, expected, operation, automatic === true && !retry);
                if (!result || !live(expected) || pending !== operation) return false;
                const detail = cleanDetail(result.assessment, command.assessmentId);
                if (command.action === 'create') {
                    selected = command.assessmentId; acknowledged = detail; resetDrafts(); declaration = ''; scopeChoices = null; scopeGenerated = ''; view = 'assessment'; activeQuestion = 0;
                } else if (!acknowledged || detail.revision >= acknowledged.revision) {
                    const old = acknowledged; acknowledged = detail;
                    questions.forEach(function (question) {
                        const draft = drafts.get(question.id); const captured = captures.find(function (item) { return item.value.itemId === question.id; });
                        if (captured && draft.generation === captured.generation || !captured && equal(draft.value, savedAnswer(question.id, old))) {
                            drafts.set(question.id, { value: savedAnswer(question.id), generation: draft.generation });
                        }
                    });
                }
                pending = null; busy = false; errors = [];
                statusText = acknowledged.status === 'submitted' ? 'Assessment submitted. Your answers are now read-only.'
                    : dirtyEntries().length ? savedText() + 'Newer changes are not saved yet.' : 'Your progress is saved. ' + savedText().trim();
                // The read-only answers start from question 1, not the last question edited.
                if (command.action === 'submit' && acknowledged.status === 'submitted') activeQuestion = 0;
                if (operation.uncertain) {
                    if (!await refreshCurrent(false, expected)) return false;
                    statusText = conflict ? 'The current saved version differs from your draft. Choose how to continue.' : 'The operation is confirmed and the current saved version has been checked. Review any unsaved changes on this device before saving again.';
                }
                return !conflict;
            } catch (error) {
                if (!live(expected) || pending !== operation) return false;
                failed = true;
                busy = false;
                if (error && (error.statusCode === 403 || error.code === 'ncsc_access_denied')) { deny(); return false; }
                const ambiguous = !error || error.ambiguous === true || error.statusCode === 503 || ![400, 403, 404, 405, 409, 413].includes(error.statusCode);
                if (ambiguous) {
                    operation.uncertain = true; statusText = 'This operation is unconfirmed. Retry the same operation to establish its result. Your unsaved changes on this device are still here.';
                } else {
                    pending = null;
                    if (error.statusCode === 409 && command.action !== 'create' && !['ncsc_quota_exceeded', 'ncsc_submission_unavailable'].includes(error.code)) await refreshCurrent(true, expected);
                    else fixedFailure(error);
                }
                return false;
            } finally {
                if (live(expected)) {
                    const focusFailure = failed && (doc.activeElement === heading || doc.activeElement === status || doc.activeElement === saveStatus) && !leave && view !== 'denied';
                    const restoreSave = operation.restoreSave && doc.activeElement === saveStatus;
                    busy = false;
                    // A confirmed background save changes nothing on the question
                    // being answered, so update the status and progress in place.
                    // Rebuilding the question here replaced its answer tiles and
                    // Next button mid-tap on slow phones, and the tap was lost
                    // (#699 M4-04).
                    const quiet = !failed && command.action === 'save' && !pending && !conflict && !operation.uncertain &&
                        view === 'assessment' && !reviewing && !leave && !submitPrompt && !errors.length && questionRegion && root.contains(questionRegion);
                    if (quiet) { updateStatus(); updateQuestionNavigation(); refreshDraftObservations(); } else render();
                    if (!failed && command.action === 'save' && !pending && !conflict && dirtyEntries().length) scheduleAutosave(flushQueued ? 0 : undefined);
                    else flushQueued = false;
                    if (restoreSave && !pending && !conflict) { const save = root.querySelector('[id="ncsc-save"]'); if (save && !save.disabled) save.focus({ preventScroll: true }); }
                    if (!failed && command.action === 'submit' && !pending && !conflict && acknowledged && acknowledged.status === 'submitted') {
                        // Confirm the submission where the person is looking, not only in an off-screen heading.
                        const sealedNote = root.querySelector('[id="ncsc-sealed"]');
                        if (sealedNote) { sealedNote.tabIndex = -1; sealedNote.focus({ preventScroll: true }); if (typeof sealedNote.scrollIntoView === 'function') sealedNote.scrollIntoView({ block: 'start' }); }
                    }
                    if (focusFailure) { const feedback = status.hidden && saveStatus && root.contains(saveStatus) ? saveStatus : status; feedback.tabIndex = -1; feedback.focus({ preventScroll: true }); }
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
            const creating = busyAction === 'create';
            panel.append(node('h3', '', busy ? creating ? 'Setting up your assessment' : 'Saving your answers' : 'We could not confirm the save'),
                node('p', '', busy ? creating ? 'Please wait a moment. Your scope stays on this page until it finishes.' : 'Please wait and do not submit again. Your answers stay on this page until the save finishes.' : 'Your answers are still on this page. Use the retry button below; do not start again.'));
            if (!busy) panel.append(button('Try the save again', function () { if (pending && !busy) perform(pending.command, pending.captures, true); }));
            content.append(panel);
        }
        function renderConflict() {
            const panel = node('section', 'ncsc-warning'); panel.append(node('h3', '', 'These answers were changed somewhere else'), node('p', '', 'Someone saved newer answers to this assessment, in another tab or on another device, after you opened it. Your unsaved answers are still here.'), node('p', '', 'Keep my answers puts your answers on top of the newer saved ones so you can review and save them. Use saved answers drops your unsaved changes.'));
            renderConflictDifferences(panel);
            panel.append(button('Reload current saved answers', async function () { const expected = epoch; await refreshCurrent(true, expected); if (live(expected)) render(); }));
            if (acknowledged.status !== 'submitted') {
                const keep = button('Keep my answers', function () { if (!currentChecked) return; conflict = false; statusText = 'Your answers are kept on top of the newer saved ones. Review them, then save.'; render(); });
                keep.disabled = !currentChecked; panel.append(keep);
            }
            panel.append(button('Use saved answers', function () { resetDrafts(); conflict = !currentChecked; errors = []; statusText = 'Showing saved answers.'; render(); }, 'dashboard-text-button')); content.append(panel);
        }
        // Once the newest saved answers are loaded, name each question where this
        // page's answer differs from them, with both answers.
        function renderConflictDifferences(panel) {
            if (!currentChecked || acknowledged.status === 'submitted') return;
            const differences = dirtyEntries().map(function (entry) {
                return { index: questions.findIndex(function (question) { return question.id === entry.value.itemId; }), mine: entry.value, saved: savedAnswer(entry.value.itemId) };
            }).filter(function (item) { return item.index !== -1; }).sort(function (a, b) { return a.index - b.index; });
            if (!differences.length) return;
            const label = function (value) { const option = optionById.get(value.optionId); return option ? option.label : 'No answer'; };
            panel.append(node('p', '', differences.length === 1 ? '1 answer on this page differs from the newer saved answers:' : differences.length + ' answers on this page differ from the newer saved answers:'));
            const list = node('ul', 'ncsc-conflict-differences');
            differences.forEach(function (item) {
                const row = node('li');
                const sameOption = item.mine.optionId === item.saved.optionId;
                row.append(node('strong', '', 'Question ' + (item.index + 1) + ': ' + plainQuestion(questions[item.index])), node('br'),
                    node('span', '', 'Your answer: ' + label(item.mine) + (sameOption ? ', with a different explanation' : '') + ' · Saved answer: ' + label(item.saved)));
                list.append(row);
            });
            panel.append(list);
        }
        function hasDraft() { return view === 'create' ? declaration.length > 0 : dirtyEntries().length > 0; }
        function requestLeave(commit) {
            if (!live()) return Promise.resolve(false);
            if (submitPrompt) { submitPrompt = false; removeDialog(); dialog = null; }
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
            dialog.append(title, node('p', '', 'Save your changes, discard your unsent changes, or stay here.'));
            const save = button('Save and leave', async function () {
                const decision = leave; if (!decision) return;
                save.disabled = true; discard.disabled = true;
                const ok = view === 'create' ? await createAssessment() : await saveAll(true);
                if (live(decision.epoch) && leave === decision) { decision.showErrors = !ok && errors.length > 0; finishLeave(ok); }
            });
            save.disabled = busy || !!pending;
            const discard = button('Discard unsent changes', function () { if (pending || busy) return; if (acknowledged) resetDrafts(); declaration = ''; scopeChoices = null; scopeGenerated = ''; errors = []; finishLeave(true); }, 'dashboard-text-button');
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
            catch (error) { finishLeave(false); statusText = 'The leave dialog could not open. Your unsaved changes on this device are still here.'; updateStatus(); }
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
        function stopNavigationFit() { const stop = stopNavigation; stopNavigation = null; if (stop) stop(); }
        function destroy() {
            if (disposed) return;
            disposed = true; epoch += 1; abortRequests(); cancelAutosave(); stopNavigationFit();
            if (autosaveEnabled && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', autosaveWhenHidden);
            if (autosaveEnabled && win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', autosaveOnPageHide);
            syncUnloadWarning();
            submitPrompt = false; submitLocked = false;
            if (leave) { leave.resolve(false); leave = null; }
            removeDialog(); dialog = null;
            pending = null; drafts.clear(); assistanceNotes.clear(); summaries = []; selected = null; acknowledged = null; declaration = ''; scopeChoices = null; scopeGenerated = ''; errors = []; workshopPanel = null; reviewing = false; returnToReview = null;
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        }
        render();
        if (initialAssessmentId === undefined) loadList(false);
        else openAssessment(initialAssessmentId);
        return controller;
    }
    return Object.freeze({ mount: mount, consultantViewer, gapHelp, managedSecurityPrice: MANAGED_SECURITY_PRICE, gapWhy, topGaps, confirmNext, v2Shortfall, rankedGapSection, resultModel: resultModel, providerSummary: providerSummary, boardSummary: boardSummary, questionnaireAnswers: questionnaireAnswers, resultsCampaign: resultsCampaign, boardSummaryBlock: boardSummaryBlock, printOnly: printOnly, managedSecurityOffer: managedSecurityOffer, copySummary: copySummary, enoughAnswersToEstimate: enoughAnswersToEstimate });
}));
