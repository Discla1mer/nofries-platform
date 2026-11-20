'use strict';

// Scoring v2 (#399): the 16-question profile, published beside the accepted
// 2026-09-02.1 profile. It reuses that profile's framework, domains and
// recorded sources, and is scored by assessmentEvaluatorV2 (graded answers).
// Nothing selects this profile yet; results submitted under 2026-09-02.1 keep
// their own profile and evaluator.
const crypto = require('crypto');
const { createAcceptedNcscFrameworkProfile } = require('./ncscAcceptedFrameworkProfile');
const { calculateFrameworkProfileSha256, publishFrameworkProfile } = require('./frameworkProfileRegistry');

const NCSC_PROFILE_V2_VERSION = '2026-11-18.1';
const NCSC_PROFILE_V2_PUBLISHED_AT = '2026-11-18';
const EXPECTED_NCSC_PROFILE_V2_SOURCE_SHA256 = 'c6120192675c9d12cdab296d6f5a84f014d613b300001394790f3ccf79692b71';
const EXPECTED_NCSC_PROFILE_V2_SHA256 = 'c90e999f627308f326a403b1d779e68087e3eaadab5149070f1df5e350daa537';
const PLANNING_SCORE_STATEMENT = 'This is a No Fries planning score from your answers, not an official NCSC or CS-CMM rating.';

const STANDARD_OPTION_IDS = Object.freeze(['yes', 'partly', 'ad_hoc', 'no', 'unknown', 'not_applicable']);
const MFA_METHOD_OPTION_IDS = Object.freeze([
    'mfa_key', 'mfa_number_matching', 'mfa_push', 'mfa_authenticator', 'mfa_text_code', 'mfa_mixed', 'mfa_none', 'unknown'
]);
const RESPONSE_OPTIONS = Object.freeze([
    option('yes', 'Yes, in place and checked', 1),
    option('partly', 'Partly in place', 0.5),
    option('ad_hoc', 'Sometimes, but not written down or checked', 0.25),
    option('no', 'No', 0),
    option('unknown', 'I don\'t know', null),
    { id: 'not_applicable', label: 'Not applicable', applicable: false, implementationFactor: null },
    option('mfa_key', 'Security key or passkey', 1),
    option('mfa_number_matching', 'App approval where you type a matching number', 0.85),
    option('mfa_push', 'App approval by tapping a notification', 0.7),
    option('mfa_authenticator', 'Code from an authenticator app', 0.55),
    option('mfa_text_code', 'Text or email code only', 0.3),
    option('mfa_mixed', 'A mix, where an important account still uses text or email codes', 0.3),
    option('mfa_none', 'No extra login step yet', 0)
]);

const ADDED_LIMITATIONS = Object.freeze([
    PLANNING_SCORE_STATEMENT,
    'Answer credits, question weights and the order of extra login methods are No Fries readings of NCSC guidance, not an official NCSC ranking. Grouping passkeys with security keys is a No Fries interpretation.',
    'The supplier-access and email-protection questions are No Fries additions. They are not NCSC Minimum Cyber Security Standards or NCSC Critical Controls.',
    'The profile makes no SMB1001 claim and must not be read as an SMB1001 level or certification.'
]);

// Plain titles for the No Fries extension controls carried over from the accepted profile.
const TITLE_BY_CONTROL_ID = Object.freeze({
    'NF-NCSC-CC-PM-01': 'Provide and use a password manager',
    'NF-NCSC-CC-SV-01': 'Check sensitive requests a second way',
    'NF-NCSC-CC-NS-01': 'Protect and separate your network'
});

const NEW_CONTROLS = Object.freeze([
    { id: 'NF-NCSC-CC-SU-01', domainId: 'prevent-protect', order: 15, title: 'Limit supplier access',
        summary: 'Keep supplier access to your data and systems limited, protected by an extra login step and covered by a promise to tell you about a breach.',
        evidenceExamples: ['List of suppliers with access', 'Supplier login settings', 'Agreement with a breach-notice clause'] },
    { id: 'NF-NCSC-CC-EM-01', domainId: 'prevent-protect', order: 16, title: 'Protect your business email',
        summary: 'Make it hard for others to send email that looks like it came from you, and filter junk and phishing before it reaches people. Your provider may call the anti-spoofing settings SPF, DKIM and DMARC.',
        evidenceExamples: ['Email domain anti-spoofing settings', 'Mail filter settings', 'Confirmation from your email or IT provider'] }
]);

// Order, weight, control, wording and first step for each question. `hint`
// replaces the control summary where the answer needs a pointer.
const QUESTIONS = Object.freeze([
    q('NF-NCSC-MCSS-RM-01', 1, 1, 'Do you write down your main cyber risks, who owns each one, and review them with whoever runs the business?',
        'List your top five risks with an owner, next step and review date.'),
    q('NF-NCSC-MCSS-SA-01', 1, 2, 'Do staff get short, practical advice on spotting phishing and scams, including realistic or AI-written messages, when they start and at least once a year after that?',
        'Give a starter briefing, then a yearly refresher with one realistic fake-invoice example.'),
    q('NF-NCSC-MCSS-AI-01', 1, 1, 'Do you keep an up-to-date list of your important devices, software, cloud apps and business data, with a named owner for each?',
        'Write the list, name an owner for each item, and include personal devices used for work.'),
    q('NF-NCSC-MCSS-PA-01', 1, 2, 'Are your important computers, phones and business systems kept up to date? If you have a website or online service, has your host or developer confirmed that its software is patched, and checked for signs of compromise?',
        'Turn on automatic updates. If you have a website, ask your host or developer to confirm it is patched.',
        'If you have no website or online service, answer for your devices and systems only. If devices are updated but you have not asked your host or developer, answer Partly. Keeping safe default settings, and limiting which apps can run, are part of the same routine.'),
    q('NF-NCSC-MCSS-MF-01', 1, 3, 'Is an extra login step (MFA) required for email, remote access, admin accounts, finance tools and other important online services?',
        'Turn the extra login step on for these services, then review any exceptions.'),
    q('NF-NCSC-MCSS-MF-01', 2, 2, 'For your most important accounts (email, banking or finance, and admin logins), what extra login method do you mainly use?',
        'Move those accounts off text or email codes to an app, passkey or security key.',
        'Choose the weakest method still used on an important account. Text and email codes are the easiest to intercept; passkeys and security keys are the hardest.',
        MFA_METHOD_OPTION_IDS),
    q('NF-NCSC-MCSS-DU-01', 1, 1, 'Are login, email and device activity records for your important systems collected in one place, and is someone alerted when something looks wrong, such as repeated failed logins?',
        'Ask your IT provider to send high-risk alerts to a named person.'),
    q('NF-NCSC-MCSS-LP-01', 1, 2, 'Do people only get the access they need for their job, with a separate admin login from everyday email, and do you remove or review access when someone joins, changes role or leaves?',
        'Separate admin logins from everyday ones, and check access every three months, including people who have left.'),
    q('NF-NCSC-MCSS-DR-01', 1, 3, 'Are your important files and systems backed up automatically, with at least three copies on two kinds of storage, including one copy offsite and one copy offline or otherwise out of reach of ransomware?',
        'Add one offline copy, or one that cannot be changed or deleted.',
        'If your only backup is in the cloud, with no offline copy and no copy in a separate account, answer Partly or Sometimes.'),
    q('NF-NCSC-MCSS-DR-01', 2, 3, 'Have you tested restoring a single important file in the last three months, and done a fuller restore of a system or mailbox in the last 12 months?',
        'Restore one real file now, and put a fuller test in the diary.',
        'If you have only restored a single file, or your tests are older than these windows, answer Partly.'),
    q('NF-NCSC-MCSS-RP-01', 1, 1, 'Do you have a written plan for the first hours of a cyber incident, saying who to call (including your IT provider and NCSC if needed), and have you practised it in the last 12 months?',
        'Write a one-page first-hour guide and run a short practice.'),
    q('NF-NCSC-CC-PM-01', 1, 2, 'Does the business provide a password manager, and do staff actually use it for unique passwords and shared logins?',
        'Move shared, admin and finance logins into the password manager first.',
        'If a password manager exists but is barely used, answer Partly.'),
    q('NF-NCSC-CC-SV-01', 1, 3, 'If someone asks you to change bank or invoice details, reset a password or change a sensitive login, do you check the request by a second method, such as a call to a known number, rather than replying to the same message?',
        'Require a check by a second method, and never approve from the original message alone.'),
    q('NF-NCSC-CC-NS-01', 1, 1, 'Have you changed the default admin password on your router, is office Wi-Fi protected (WPA2 or later), and is guest Wi-Fi kept separate from staff and backup access?',
        'Change the router admin login, and keep guests off staff and backup access.',
        'If you have no office network, choose Not applicable and say why.'),
    q('NF-NCSC-CC-SU-01', 1, 2, 'For suppliers who can see your data or systems, such as your accountant or your IT or hosting provider, do you limit what they can access, require an extra login step on those logins, and have a written agreement that they will tell you promptly about a breach?',
        'List who has access, turn on the extra login step, and add a breach-notice clause.'),
    q('NF-NCSC-CC-EM-01', 1, 2, 'Is your business email set up so others cannot easily send messages that look like they came from you, and is junk or phishing mail filtered before it reaches inboxes?',
        'Ask your email or IT provider to switch on anti-spoofing and phishing filters.')
]);

// Display grouping only (the three homepage topics); scoring uses the five domains.
const NCSC_PROFILE_V2_DISPLAY_TOPICS = Object.freeze([
    topic('people-access', 'People & Access', ['NF-NCSC-MCSS-RM-01-Q1', 'NF-NCSC-MCSS-SA-01-Q1', 'NF-NCSC-MCSS-MF-01-Q1', 'NF-NCSC-MCSS-MF-01-Q2',
        'NF-NCSC-MCSS-LP-01-Q1', 'NF-NCSC-CC-PM-01-Q1', 'NF-NCSC-CC-SV-01-Q1', 'NF-NCSC-CC-SU-01-Q1']),
    topic('systems-protection', 'Systems & Protection', ['NF-NCSC-MCSS-AI-01-Q1', 'NF-NCSC-MCSS-PA-01-Q1', 'NF-NCSC-MCSS-DU-01-Q1',
        'NF-NCSC-CC-NS-01-Q1', 'NF-NCSC-CC-EM-01-Q1']),
    topic('backup-recovery', 'Backup & Recovery', ['NF-NCSC-MCSS-DR-01-Q1', 'NF-NCSC-MCSS-DR-01-Q2', 'NF-NCSC-MCSS-RP-01-Q1'])
]);

let published;

function createNcscFrameworkProfileV2() {
    if (published) return published;
    const definition = buildDefinition();
    const sourceDigest = digest({ basedOnCatalogueSha256: createAcceptedNcscFrameworkProfile().catalogueSha256,
        controls: definition.controls, questions: definition.questions, responseOptions: definition.responseOptions,
        statements: definition.statements });
    assertPinned(EXPECTED_NCSC_PROFILE_V2_SOURCE_SHA256, sourceDigest, 'source');
    definition.sourceCatalogueSha256 = sourceDigest;
    const profileDigest = calculateFrameworkProfileSha256(definition);
    assertPinned(EXPECTED_NCSC_PROFILE_V2_SHA256, profileDigest, 'profile');
    definition.catalogueSha256 = profileDigest;
    published = publishFrameworkProfile(definition);
    return published;
}

function buildDefinition() {
    const accepted = JSON.parse(JSON.stringify(createAcceptedNcscFrameworkProfile()));
    const usedControlIds = new Set(QUESTIONS.map((question) => question.controlId));
    const controls = accepted.controls.filter((control) => usedControlIds.has(control.id)).map((control) => ({
        ...control, title: TITLE_BY_CONTROL_ID[control.id] || control.title
    }));
    NEW_CONTROLS.forEach((control) => controls.push({ id: control.id, domainId: control.domainId, order: control.order,
        title: control.title,
        guidance: { summary: control.summary, evidenceExamples: [...control.evidenceExamples], startingActions: [] },
        sourceIds: ['ncsc-framework'], sourceReferences: [] }));
    const controlById = new Map(controls.map((control) => [control.id, control]));
    const questions = QUESTIONS.map((question) => {
        const control = controlById.get(question.controlId);
        return { id: `${question.controlId}-Q${question.order}`, controlId: question.controlId, order: question.order,
            prompt: question.prompt,
            guidance: { summary: question.hint || control.guidance.summary,
                evidenceExamples: [...control.guidance.evidenceExamples], startingActions: [question.nextStep] },
            weight: question.weight, responseOptionIds: [...question.responseOptionIds], sourceIds: [...control.sourceIds] };
    });
    const usedSourceIds = new Set([...accepted.framework.sourceIds, ...accepted.profile.sourceIds,
        ...accepted.domains.flatMap((domain) => domain.sourceIds), ...controls.flatMap((control) => control.sourceIds)]);
    return { schemaVersion: accepted.schemaVersion, status: 'published', publishedAt: NCSC_PROFILE_V2_PUBLISHED_AT,
        framework: accepted.framework,
        profile: { ...accepted.profile, version: NCSC_PROFILE_V2_VERSION,
            title: 'NCSC-aligned cyber-security planning assessment',
            description: 'A version-pinned 16-question planning assessment for New Zealand small and medium-sized organisations, with graded answers and weighted questions. The recorded date is the Minimum Cyber Security Standards 2025 v3 publication date, not an NCSC-asserted effective date.' },
        statements: { ...accepted.statements, limitations: [...accepted.statements.limitations, ...ADDED_LIMITATIONS] },
        sources: accepted.sources.filter((source) => usedSourceIds.has(source.id)),
        domains: accepted.domains, controls, questions,
        responseOptions: RESPONSE_OPTIONS.map((value) => ({ ...value })) };
}

function option(id, label, implementationFactor) {
    return Object.freeze({ id, label, applicable: true, implementationFactor });
}

function q(controlId, order, weight, prompt, nextStep, hint, responseOptionIds = STANDARD_OPTION_IDS) {
    return Object.freeze({ controlId, order, weight, prompt, nextStep, hint, responseOptionIds });
}

function topic(id, title, questionIds) {
    return Object.freeze({ id, title, questionIds: Object.freeze(questionIds) });
}

function assertPinned(expected, actual, name) {
    if (expected !== actual) throw new Error(`NCSC profile v2 ${name} digest does not match its pin`);
}

function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

module.exports = {
    EXPECTED_NCSC_PROFILE_V2_SHA256,
    EXPECTED_NCSC_PROFILE_V2_SOURCE_SHA256,
    NCSC_PROFILE_V2_DISPLAY_TOPICS,
    NCSC_PROFILE_V2_VERSION,
    PLANNING_SCORE_STATEMENT,
    createNcscFrameworkProfileV2
};
