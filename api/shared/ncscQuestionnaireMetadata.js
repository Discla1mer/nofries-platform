'use strict';

const { createAcceptedNcscFrameworkProfile } = require('./assessmentEngine/ncscAcceptedFrameworkProfile');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SOURCE_DISCLOSURE = 'These questions are No Fries adaptations, not official NCSC questions. Source verification dates come from the accepted catalogue; linked pages may have changed since those dates.';

// Reading aids only: the accepted questions, response options and scoring stay
// unchanged. A partial checklist is a Partial answer, not a separate assessment.
const SMALL_BUSINESS = {
    'NF-NCSC-MCSS-RM-01-Q1': {
        meaning: 'Write down the computer or online problems that could stop your business, who will deal with them and when you will check again.',
        example: 'A plumbing firm lists losing access to bookings as a risk, names the office manager to arrange backups, and reviews the list each quarter.',
        checks: ['List the main risks and their effect on the business.', 'Agree which risks you can accept and which need action.', 'Give each action an owner and review date.']
    },
    'NF-NCSC-MCSS-SA-01-Q1': {
        meaning: 'Show people how to spot scams, protect information and report a problem when they start work, then refresh that advice.',
        example: 'A café shows new staff how to check suspicious supplier emails, keeps a training list and tells the owner when training is overdue.',
        checks: ['Give new staff security advice for their work.', 'Refresh advice as scams or working practices change.', 'Check who has completed it and share the results with the person in charge.']
    },
    'NF-NCSC-MCSS-AI-01-Q1': {
        meaning: 'Keep a current list of the devices, apps, online services and important information your business depends on.',
        example: 'A shop lists its till, laptops, accounting service and customer records, with a person responsible and a date to replace unsupported equipment.',
        checks: ['Include devices, software, online services and important information.', 'Record who looks after each item and why it matters.', 'Check when updates or supplier support end and remove items no longer used.']
    },
    'NF-NCSC-MCSS-SC-01-Q1': {
        meaning: 'Use a standard set of safe settings on both new and existing devices and services, and check those settings after changes.',
        example: 'Your IT provider uses a setup checklist for screen locks, unwanted apps and email security, and records any device that needs different settings.',
        checks: ['Write down the safe settings your business expects.', 'Apply them to existing systems as well as new ones.', 'Review exceptions and check settings when software changes.']
    },
    'NF-NCSC-MCSS-PA-01-Q1': {
        meaning: 'Have a routine for installing security updates safely, checking they worked and replacing software that no longer receives fixes.',
        example: 'Your IT provider installs urgent fixes first, tests a till update, checks it installed, and keeps a way to recover if the update breaks the till.',
        checks: ['Get updates from trusted suppliers and install urgent security fixes first.', 'Test updates, install them and check they succeeded.', 'Have a recovery plan if an update fails and a replacement plan for unsupported systems.']
    },
    'NF-NCSC-MCSS-MF-01-Q1': {
        meaning: 'Require an extra sign-in check, such as an authenticator app or security key, on important accounts. This is multi-factor authentication (MFA).',
        example: 'Staff and your IT provider must use an extra check to access business email, online accounts and administrator settings; someone reviews failed sign-in alerts.',
        checks: ['Require the extra check for important online services and remote access.', 'Include administrator accounts and supplier access.', 'Review failed sign-ins and any accounts exempt from the extra check.']
    },
    'NF-NCSC-MCSS-DU-01-Q1': {
        meaning: 'Bring together activity records from important systems so someone can spot suspicious behaviour and act on alerts.',
        example: 'Your IT provider checks alerts for unusual email sign-ins and device activity, and calls a named person at your business when action is needed.',
        checks: ['Collect activity records from important systems, especially those reachable from the internet.', 'Bring the records together and review them.', 'Send useful alerts to someone responsible for responding.']
    },
    'NF-NCSC-MCSS-LP-01-Q1': {
        meaning: 'Give people only the access they need for their job, and update or remove it when they start, change roles or leave.',
        example: 'A receptionist can use bookings but cannot change payroll. Your IT provider uses a separate administrator account, and departing staff lose access promptly.',
        checks: ['Limit access to what each person needs.', 'Use separate accounts for administrator tasks.', 'Have a routine for starters, role changes and leavers, and review access regularly.']
    },
    'NF-NCSC-MCSS-DR-01-Q1': {
        meaning: 'Keep protected backup copies of important systems and information, and practise getting them back within the time your business needs.',
        example: 'A firm backs up its job records, protects a copy from changes or deletion, and tests restoring a sample to check how long recovery takes.',
        checks: ['Decide what must be backed up, how much recent work you could lose and how quickly you need it back.', 'Protect backup copies from attackers or accidental deletion.', 'Test restoring samples and record whether recovery meets your needs.']
    },
    'NF-NCSC-MCSS-RP-01-Q1': {
        meaning: 'Write down who does what if a cyber problem happens, keep useful phone numbers available and practise the plan.',
        example: 'The owner and office manager rehearse what to do if business email is taken over, using a one-page plan with their IT provider’s number.',
        checks: ['Plan for problems most likely to harm your business.', 'Agree responsibilities and contacts with the person in charge.', 'Practise the plan and improve it after exercises or real problems.']
    },
    'NF-NCSC-CC-PM-01-Q1': {
        meaning: 'Give people an approved password manager so they can use a different strong password for each service and share access safely when needed.',
        example: 'Staff use the business password manager for supplier accounts, with access limited to the people who need it instead of passwords in a shared spreadsheet.',
        checks: ['Provide a password manager approved by the business.', 'Check people actually use it for unique passwords.', 'Set rules for access and any necessary password sharing.']
    },
    'NF-NCSC-CC-SV-01-Q1': {
        meaning: 'Check important requests through a trusted second route before changing bank details, resetting access or sending sensitive information.',
        example: 'When a supplier emails new bank details, you call their existing number from your records before paying; you do not use the number in that email.',
        checks: ['Verify payment-detail and sensitive-information requests separately.', 'Check identity before resetting passwords or sign-in checks.', 'Use a trusted contact method already on record, not one supplied in the request.']
    },
    'NF-NCSC-CC-AC-01-Q1': {
        meaning: 'Restrict which programs and automated files can run on important devices, so an unexpected download or attachment cannot easily cause damage.',
        example: 'Your IT provider blocks unapproved software and automatic commands in spreadsheet attachments on the payroll laptop.',
        checks: ['Decide which devices and jobs would cause the most harm if compromised.', 'Restrict unapproved apps and automated commands, including scripts and document macros.', 'Check blocked activity and review requests for exceptions.']
    },
    'NF-NCSC-CC-NS-01-Q1': {
        meaning: 'Separate guest access, everyday work, administrator access, backups and important services so a problem in one cannot easily reach the others.',
        example: 'A café’s customer Wi-Fi cannot reach its till, office laptop or backups; the IT provider also limits how administrator accounts reach those systems.',
        checks: ['Keep guests separate from business devices and services.', 'Limit connections to administrator tools, backups and important services.', 'Check the separation works, including remote access.']
    }
};

/** Display data only. The accepted factory owns source verification and catalogue
 * pins; this projection grants no access and exposes no scoring implementation.
 */
function createNcscQuestionnaireMetadata() {
    const accepted = createAcceptedNcscFrameworkProfile();
    identifiers(accepted.sources);
    const sourceById = new Map(accepted.sources.map(source => [source.id, source]));
    const licenceSource = accepted.sources.find(source => source.id === 'ncsc-framework');
    if (!licenceSource || licenceSource.rightsStatus !== 'verified' ||
        typeof licenceSource.licence !== 'string' || typeof licenceSource.licenceUrl !== 'string' ||
        !licenceSource.licenceUrl.startsWith('https://')) invalid();

    const domains = ordered(accepted.domains).map(domain => ({ id: domain.id, order: domain.order,
        title: displayText(domain.title), guidance: guidance(domain.guidance) }));
    const controls = ordered(accepted.controls).map(control => ({ id: control.id, domainId: control.domainId,
        order: control.order, title: displayText(control.title), guidance: guidance(control.guidance) }));
    const questions = ordered(accepted.questions).map(question => ({ id: question.id, controlId: question.controlId,
        order: question.order, prompt: displayText(question.prompt), guidance: guidance(question.guidance),
        smallBusiness: smallBusiness(question.id),
        responseOptionIds: [...question.responseOptionIds], sources: questionSources(question, sourceById) }));
    const responseOptions = accepted.responseOptions.map(option => {
        if (typeof option.applicable !== 'boolean') invalid();
        return { id: option.id, label: displayText(option.label), applicable: option.applicable };
    });
    const domainIds = identifiers(domains), controlIds = identifiers(controls), questionIds = identifiers(questions),
        optionIds = identifiers(responseOptions);
    if (!domainIds.size || !controlIds.size || !questionIds.size || !optionIds.size ||
        controls.some(control => !domainIds.has(control.domainId)) ||
        domains.some(domain => !controls.some(control => control.domainId === domain.id)) ||
        controls.some(control => !questions.some(question => question.controlId === control.id)) ||
        questions.some(question => !controlIds.has(question.controlId) || !question.responseOptionIds.length ||
            new Set(question.responseOptionIds).size !== question.responseOptionIds.length ||
            question.responseOptionIds.some(optionId => !optionIds.has(optionId)))) invalid();

    return freeze({ schemaVersion: 1, moduleId: 'cyber_security', profileRef: {
        frameworkId: accepted.framework.id, frameworkVersion: accepted.framework.version,
        profileId: accepted.profile.id, profileVersion: accepted.profile.version,
        catalogueSha256: accepted.catalogueSha256, sourceCatalogueSha256: accepted.sourceCatalogueSha256
    }, title: displayText(accepted.profile.title), description: displayText(accepted.profile.description),
    attribution: displayText(accepted.statements.attribution), claim: displayText(accepted.statements.claim),
    sourceDisclosure: SOURCE_DISCLOSURE,
    licence: { label: displayText(licenceSource.licence), url: licenceSource.licenceUrl },
    limitations: accepted.statements.limitations.map(displayText), domains, controls, questions, responseOptions });
}

function ordered(values) {
    if (!Array.isArray(values) || values.some(value => !Number.isSafeInteger(value.order) || value.order < 0)) invalid();
    return [...values].sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
function identifiers(values) {
    const ids = new Set();
    for (const value of values) {
        if (typeof value.id !== 'string' || !ID.test(value.id) || ids.has(value.id)) invalid();
        ids.add(value.id);
    }
    return ids;
}
function guidance(value) {
    return { summary: displayText(value.summary), evidenceExamples: value.evidenceExamples.map(displayText),
        startingActions: value.startingActions.map(displayText) };
}
function smallBusiness(id) {
    const value = SMALL_BUSINESS[id];
    if (!value) invalid();
    return { meaning: displayText(value.meaning), example: displayText(value.example), checks: value.checks.map(displayText) };
}
function questionSources(question, sourceById) {
    if (!Array.isArray(question.sourceIds) || !question.sourceIds.length || question.sourceIds.length > 16 ||
        new Set(question.sourceIds).size !== question.sourceIds.length) invalid();
    return question.sourceIds.map(id => {
        const source = sourceById.get(id);
        if (!source) invalid();
        let url;
        try { url = new URL(source.url); } catch (_) { invalid(); }
        if (typeof source.url !== 'string' || url.href !== source.url || url.origin !== 'https://www.ncsc.govt.nz' ||
            url.username || url.password || url.search || url.hash) invalid();
        if (typeof source.lastVerifiedAt !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(source.lastVerifiedAt) ||
            !Number.isFinite(Date.parse(source.lastVerifiedAt)) ||
            new Date(source.lastVerifiedAt).toISOString().slice(0, 10) !== source.lastVerifiedAt) invalid();
        return { id, title: displayText(source.title), url: source.url, lastVerifiedAt: source.lastVerifiedAt };
    });
}
function displayText(value) {
    if (typeof value !== 'string' || !value.trim()) invalid();
    return value;
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
function invalid() { throw new Error('ncsc_metadata_invalid'); }

module.exports = { createNcscQuestionnaireMetadata };
