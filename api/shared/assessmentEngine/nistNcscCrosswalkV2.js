'use strict';

// Scoring v2 (#399), item 4: the NIST CSF 2.0 reference crosswalk for the
// 16-question NCSC-aligned profile 2026-11-18.1. It sits beside the fixed v1
// crosswalk (nistNcscCrosswalk.js), which is not changed. Like v1 it compares
// exact question prompts with official CSF 2.0 subcategory outcomes, gives no
// score or answer transfer, and is keyed to both endpoints' six-field profile
// references. Unlike v1 its endpoints are questions, because MF-01 and DR-01
// each have two questions in v2. Every record states how it relates to v1.
const crypto = require('crypto');
const { publishFrameworkProfile } = require('./frameworkProfileRegistry');
const { createNcscFrameworkProfileV2 } = require('./ncscFrameworkProfileV2');
const { createNistFrameworkProfile } = require('./nistFrameworkProfile');
const { createNistNcscCrosswalk, NistNcscCrosswalkError } = require('./nistNcscCrosswalk');

const EXPECTED_CROSSWALK_V2_SHA256 = '0c609059e63a1235af2796cc23dd1b5d9fcd2cb3e575c97cdb17281047fcc5d8';
const HASH_PREFIX = 'no-fries-nist-ncsc-crosswalk-v2\n';
const NIST_SOURCE_ID = 'nist-cswp-29-final-2024-02-26';
const SOURCE_COUNT = 16;
const SOURCE_CONTROL_COUNT = 14;
const TARGET_COUNT = 106;
const ALL_SOURCES = 'ALL-NCSC-V2-16';
const ALL_TARGETS = 'ALL-NIST106';
const PROFILE_REF_KEYS = [
    'frameworkId', 'frameworkVersion', 'profileId', 'profileVersion',
    'catalogueSha256', 'sourceCatalogueSha256'
];
const LINEAGE = ['reused', 'restated', 'new'];
const CONTROL_LINEAGE = ['same-meaning', 'restated', 'new-control'];
const SHARED_PROVENANCE_KEYS = ['author', 'nistSourceUrl', 'nistSourceVersion', 'nistSourceFileSha256',
    'nistOutcomeTranscriptionSha256'];

const RM = 'NF-NCSC-MCSS-RM-01';
const SA = 'NF-NCSC-MCSS-SA-01';
const AI = 'NF-NCSC-MCSS-AI-01';
const PA = 'NF-NCSC-MCSS-PA-01';
const MF = 'NF-NCSC-MCSS-MF-01';
const DU = 'NF-NCSC-MCSS-DU-01';
const LP = 'NF-NCSC-MCSS-LP-01';
const DR = 'NF-NCSC-MCSS-DR-01';
const RP = 'NF-NCSC-MCSS-RP-01';
const PM = 'NF-NCSC-CC-PM-01';
const SV = 'NF-NCSC-CC-SV-01';
const NS = 'NF-NCSC-CC-NS-01';
const SU = 'NF-NCSC-CC-SU-01';
const EM = 'NF-NCSC-CC-EM-01';

// Positive question-to-outcome records, in question order. `v1` says how the
// record relates to the v1 record for the same control and outcome: `reused`
// copies it word for word, because the v2 prompt still means the same for that
// outcome; `restated` keeps the outcome but re-justifies it, because the
// wording or scope changed; `new` has no v1 record for that pair.
const POSITIVE = [
    [`${RM}-Q1`, 'GV.RM-03', 'restated',
        'The source asks for the main cyber risks to be written down and reviewed with whoever runs the business, bringing them into business-level risk discussion.',
        'Integration of all cybersecurity risk activities and outcomes into an enterprise risk management process is broader than a reviewed list of main risks.'],
    [`${RM}-Q1`, 'GV.RR-01', 'new',
        'The source asks for the main cyber risks to be reviewed with whoever runs the business. That review is a weak tie: it only partly shows leadership taking accountability for cybersecurity risk.',
        'Leadership responsibility and accountability for cybersecurity risk beyond that review, and fostering a risk-aware, ethical and continually improving culture, are not asked for.'],
    [`${RM}-Q1`, 'GV.RR-02', 'restated',
        'The source asks for a named owner for each main cyber risk.',
        'All cybersecurity roles, responsibilities and authorities, their communication, understanding and enforcement are not covered.'],
    [`${SA}-Q1`, 'PR.AT-01', 'restated',
        'The source asks for practical phishing and scam awareness for staff when they start and at least yearly.',
        'Knowledge and skills for general tasks beyond spotting phishing and scams, and demonstrated competence, are not assessed.'],
    [`${AI}-Q1`, 'ID.AM-01', 'reused'],
    [`${AI}-Q1`, 'ID.AM-02', 'reused'],
    [`${AI}-Q1`, 'ID.AM-07', 'reused'],
    [`${PA}-Q1`, 'PR.PS-02', 'restated',
        'The source asks for important computers, phones and business systems, and any website or online service software, to be kept up to date.',
        'Risk-based replacement and removal of software, and maintenance of software outside the important-system subset, are not asked for.'],
    [`${MF}-Q1`, 'PR.AA-03', 'restated',
        'The source asks for MFA on email, remote access, admin accounts, finance tools and other important online services.',
        'Authentication of all users, services and hardware outside those services is not established.'],
    [`${MF}-Q2`, 'PR.AA-03', 'restated',
        'The source asks which extra login method protects the most important accounts, ranking phishing-resistant methods above text or email codes.',
        'Whether all users, services and hardware are authenticated is not assessed; the question covers only the method on the most important accounts.'],
    [`${DU}-Q1`, 'PR.PS-04', 'restated',
        'The source asks for login, email and device activity records from important systems to be collected in one place.',
        'Generation and availability of logs across the wider platform population, for continuous monitoring, are not fully covered.'],
    [`${DU}-Q1`, 'DE.CM-03', 'new',
        'The source names login and email activity records as the population to collect and alert on.',
        'Monitoring of all personnel activity and technology usage beyond login and email records on important systems is broader.'],
    [`${DU}-Q1`, 'DE.CM-09', 'restated',
        'The source asks for collected activity records from important systems to raise an alert when something looks wrong.',
        'Monitoring the complete hardware, software, runtime-environment and data population through all relevant signals is broader.'],
    [`${DU}-Q1`, 'DE.AE-06', 'new',
        'The source asks for someone to be alerted when activity records look wrong.',
        'Providing adverse-event information to all authorized staff and tools that need it is broader than alerting one person.'],
    [`${LP}-Q1`, 'PR.AA-01', 'restated',
        'The source asks for people\'s access to be removed or reviewed when they join, change role or leave.',
        'Identity and credential management for services and hardware and the full credential lifecycle are not covered.'],
    [`${LP}-Q1`, 'PR.AA-05', 'restated',
        'The source asks for people to get only the access they need for their job, with a separate admin login from everyday email, and for access to be removed or reviewed when someone joins, changes role or leaves.',
        'An explicit authorization policy, all entitlements, separation of duties and review of access on a periodic cycle rather than only at joiner, mover and leaver events are not required.'],
    [`${DR}-Q1`, 'PR.DS-11', 'restated',
        'The source asks for automatic backups with three copies on two kinds of storage, one offsite and one offline or out of reach of ransomware.',
        'Testing (asked separately in DR-01-Q2), the wider data population and full maintenance of backups are not covered by this question.'],
    [`${DR}-Q1`, 'PR.IR-03', 'restated',
        'The source asks for an offsite copy and a copy out of reach of ransomware, a resilience mechanism for an adverse situation.',
        'Defined resilience requirements, other resilience mechanisms and normal-operation resilience are not asked for.'],
    [`${DR}-Q2`, 'PR.DS-11', 'restated',
        'The source asks for a single-file restore test every three months and a fuller system or mailbox restore every 12 months.',
        'Creating, protecting and maintaining backups (asked separately in DR-01-Q1) and the wider data population are not covered by this question.'],
    [`${RP}-Q1`, 'GV.SC-08', 'new',
        'The source asks for the written incident plan to say when to call the IT provider.',
        'Including all relevant suppliers and third parties in response and recovery activities, not only a planned call, is broader.'],
    [`${RP}-Q1`, 'ID.IM-04', 'restated',
        'The source asks for a written first-hours incident plan with contacts, practised in the last 12 months.',
        'Other cybersecurity plans that affect operations, and explicit communication, maintenance and improvement of the plan, are broader.'],
    [`${PM}-Q1`, 'PR.AA-01', 'restated',
        'The source asks for a business password manager that staff use for unique passwords and shared logins.',
        'Identity and credential management beyond these password practices, including services and hardware, is broader.'],
    [`${NS}-Q1`, 'PR.IR-01', 'restated',
        'The source asks for protected office Wi-Fi with guest Wi-Fi kept separate from staff and backup access.',
        'All controls against unauthorized network and environment access and usage beyond the office network are broader.'],
    [`${NS}-Q1`, 'PR.PS-01', 'new',
        'The source asks for the router\'s default admin password to be changed and Wi-Fi protection to be set, a narrow secure-configuration check.',
        'Configuration management practices for all other hardware and software are not assessed.'],
    [`${SU}-Q1`, 'GV.SC-05', 'new',
        'The source asks for a written agreement in which suppliers with access promise to tell you promptly about a breach.',
        'Other cybersecurity requirements, their prioritization and their integration into all supplier and third-party agreements are broader.'],
    [`${SU}-Q1`, 'PR.AA-03', 'new',
        'The source asks for an extra login step on supplier logins to your data or systems.',
        'Authentication of all other users, services and hardware is not established by this question.'],
    [`${SU}-Q1`, 'PR.AA-05', 'new',
        'The source asks for supplier access to your data and systems to be limited.',
        'An explicit authorization policy, all entitlements and separation of duties are not fully required.'],
    [`${EM}-Q1`, 'PR.PS-01', 'new',
        'The source asks for business email to be set up so others cannot easily send messages that look like they came from you.',
        'Configuration management practices for all other hardware and software are not assessed.'],
    [`${EM}-Q1`, 'DE.CM-09', 'new',
        'The source asks for junk and phishing mail to be filtered before it reaches inboxes. Inbound filtering inspects incoming email for malicious content, which partly covers the monitoring of data in this outcome.',
        'Monitoring of hardware, software, runtime environments and data other than incoming email is not asked for, and inbound filtering is not monitoring to find potentially adverse events in general.']
];

// Source questions with no positive record. Each is reviewed against all 106 outcomes.
const SOURCE_NO_MATCH = [
    [`${SV}-Q1`, 'reused']
];

const NOT_ASSERTED = 'No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.';

// Outcomes with no positive record, grouped by shared reason. A `reused` group
// copies the v1 no-match text for the same outcome; a `restated` group rewrites
// it because the v2 prompts changed; `new` marks an outcome that had a v1
// positive record and has none in v2.
const TARGET_NO_MATCH = [
    ['GV.OC-01 GV.OC-02 GV.OC-03 GV.OC-04 GV.OC-05', 'reused'],
    ['GV.RM-01 GV.RM-04 GV.RM-05 GV.RM-06 GV.RM-07', 'restated',
        'Written main risks with owners and a leadership review are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities.'],
    ['GV.RM-02', 'new',
        'The v2 risk question no longer asks for risk tolerance, and no prompt asks for risk appetite and tolerance statements to be established, communicated and maintained.'],
    ['GV.RR-03 GV.RR-04', 'restated',
        'Risk owners, leadership review, starter awareness and joiner or leaver access reviews do not directly assess commensurate resources or cybersecurity across human-resources practices.'],
    ['GV.PO-01 GV.PO-02', 'restated',
        'A written list of main risks does not directly ask for the organization-wide cybersecurity policy lifecycle and enforcement described here.'],
    ['GV.OV-01 GV.OV-03', 'restated',
        'A leadership review of the main risks does not directly ask for strategy-outcome review or organization-wide cybersecurity performance evaluation.'],
    ['GV.OV-02', 'new',
        'The v2 risk question asks for the main risks to be reviewed, not for the cyber risk management strategy to be reviewed and adjusted for coverage of organizational requirements and risks.'],
    ['GV.SC-01 GV.SC-02 GV.SC-03 GV.SC-04 GV.SC-06 GV.SC-07 GV.SC-09 GV.SC-10', 'restated',
        'The supplier question asks for limited access, an extra login step and a breach-notice agreement, and the incident plan names the IT provider. The patching question asks whether a website host or developer has confirmed that its software is patched and checked for signs of compromise; that is a one-off confirmation about one provider, not supplier risk monitored over the course of the relationship. No prompt directly assesses a supply chain risk programme, supplier roles, integration, prioritization, due diligence, ongoing supplier risk monitoring or end-of-relationship provisions.'],
    ['ID.AM-03 ID.AM-04 ID.AM-05', 'restated',
        'The inventory question does not explicitly require documented authorized data-flow representations, a supplier-service inventory or the stated multi-criterion asset prioritization; cloud apps are not necessarily supplier-provided, and the supplier question does not ask for an inventory of supplier services.'],
    ['ID.AM-08', 'new',
        'The v2 inventory question keeps named owners but no longer asks for lifecycle status, and no prompt asks for systems, hardware, software, services and data to be managed throughout their life cycles.'],
    ['ID.RA-01 ID.RA-02 ID.RA-03 ID.RA-04 ID.RA-05 ID.RA-06 ID.RA-08 ID.RA-09 ID.RA-10', 'reused'],
    ['ID.RA-07', 'new',
        'The v2 profile retires the secure-configuration question, and no prompt asks for changes and exceptions to be managed, assessed for risk impact, recorded and tracked.'],
    ['ID.IM-01', 'restated',
        'No prompt expressly asks for improvements to be identified from evaluations as a general practice.'],
    ['ID.IM-02 ID.IM-03', 'new',
        'The v2 incident-plan question asks for the plan to be practised, but no prompt asks for improvements to be identified from tests, exercises or the execution of operational activities.'],
    ['PR.AA-02 PR.AA-04 PR.AA-06', 'reused'],
    ['PR.AT-02', 'new',
        'The v2 awareness question no longer asks for role-appropriate guidance, and no prompt assesses awareness and training for individuals in specialized roles.'],
    ['PR.DS-01 PR.DS-02 PR.DS-10', 'reused'],
    ['PR.PS-03 PR.PS-06', 'restated',
        'Keeping devices and systems up to date does not directly assess risk-based hardware replacement or removal, or secure software-development lifecycle practices.'],
    ['PR.PS-05', 'new',
        'The v2 profile retires the application-control question; its idea survives only in patching guidance, which is not the compared prompt, and no prompt asks for unauthorized software installation and execution to be prevented.'],
    ['PR.IR-02 PR.IR-04', 'reused'],
    ['DE.CM-01 DE.CM-02 DE.CM-06', 'restated',
        'The activity-records question selects login, email and device activity on important systems. The patching question asks whether a website host or developer has confirmed that its software is patched and checked for signs of compromise; that is a one-off confirmation about one provider, not ongoing monitoring of external service provider activities and services. No prompt expressly selects network-service, physical-environment or ongoing external-provider monitoring populations and signals.'],
    ['DE.AE-02', 'new',
        'The v2 activity-records question asks for a person to be alerted, but no longer asks for collected records to be reviewed, and no prompt asks for potentially adverse events to be analyzed to understand associated activities.'],
    ['DE.AE-03 DE.AE-04 DE.AE-07 DE.AE-08', 'restated',
        'Collecting activity records and alerting a person do not explicitly require source correlation, impact and scope estimation, threat-intelligence integration or incident-declaration criteria.'],
    ['RS.MA-01 RS.MA-02 RS.MA-03 RS.MA-04 RS.MA-05', 'reused'],
    ['RS.AN-03 RS.AN-06 RS.AN-07 RS.AN-08', 'reused'],
    ['RS.CO-02 RS.CO-03', 'reused'],
    ['RS.MI-01 RS.MI-02', 'reused'],
    ['RC.RP-01 RC.RP-02 RC.RP-03 RC.RP-04 RC.RP-05 RC.RP-06', 'restated',
        'Backup readiness and periodic restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure.'],
    ['RC.CO-03 RC.CO-04', 'reused']
];

// One entry per v2 control, in profile order. `droppedV1Targets` lists every
// v1 positive outcome for the control that v2 no longer asserts, with a reason.
const CONTROL_NOTES = [
    [RM, 'restated', 'v1 asked for a documented business risk process with tolerance, owners and regular review; v2 asks for written main risks, an owner each and a review with whoever runs the business.',
        [['GV.RM-02', 'Risk tolerance is no longer asked for.'],
            ['GV.OV-02', 'v2 reviews the main risks, not the risk management strategy.']]],
    [SA, 'restated', 'v1 asked for current, role-appropriate guidance reported to leadership; v2 asks for phishing and scam awareness at start and yearly.',
        [['PR.AT-02', 'Role-appropriate guidance for specialized roles is no longer asked for.']]],
    [AI, 'restated', 'v1 asked for owners and lifecycle status; v2 keeps named owners for the same asset classes but drops lifecycle status.',
        [['ID.AM-08', 'Lifecycle status is no longer asked for.']]],
    [PA, 'restated', 'v1 asked for a repeatable patch process with testing, rollback and retirement; v2 asks for devices, systems and any website software to be kept up to date.', []],
    [MF, 'restated', 'v1 asked for MFA on critical, internet-accessible, privileged and third-party access with failures reviewed; v2 splits coverage (Q1, third-party access moves to SU-01) from method strength (Q2).', []],
    [DU, 'restated', 'v1 asked for logs to be gathered, reviewed and turned into alerts; v2 names login, email and device activity and asks for a person to be alerted, without review.',
        [['DE.AE-02', 'Review and analysis of gathered logs is no longer asked for.']]],
    [LP, 'restated', 'v1 asked for least access, separate privileged accounts and repeatable joiner, mover, leaver and review processes; v2 asks the same in plain words but as removal or review when someone joins, changes role or leaves, not on a periodic cycle, so both the identity-lifecycle and least-privilege records are restated.', []],
    [DR, 'restated', 'v1 asked for backups to defined recovery requirements with protected copies and sampled restore tests; v2 splits protected copies (Q1) from dated restore tests (Q2) and drops defined recovery requirements.', []],
    [RP, 'restated', 'v1 asked for a risk-based plan with named responsibilities, management support, contacts and lessons from exercises or incidents; v2 asks for a first-hours plan with who to call, practised in 12 months.',
        [['GV.RR-02', 'Named incident responsibilities are no longer asked for; who to call is a contact path, not a role.'],
            ['ID.IM-02', 'Identifying improvements from exercises is no longer asked for.'],
            ['ID.IM-03', 'Identifying improvements from incidents or operations is no longer asked for.']]],
    [PM, 'restated', 'v1 asked for a governed password manager with approved sharing; v2 asks for a provided password manager used for unique passwords and shared logins.', []],
    [SV, 'same-meaning', 'v1 and v2 both ask for sensitive payment, credential and login changes to be checked by a second method outside the original request; v1 had no positive mapping and v2 keeps that review.', []],
    [NS, 'restated', 'v1 asked for users, guests, administration, backups and important services to be separated; v2 narrows to the office router and Wi-Fi, adding a default-password change.', []],
    [SU, 'new-control', 'No Fries addition in v2; not an NCSC Minimum Cyber Security Standard or Critical Control.', []],
    [EM, 'new-control', 'No Fries addition in v2; not an NCSC Minimum Cyber Security Standard or Critical Control. SPF, DKIM and DMARC are named only in help text, which is not the compared prompt.', []]
];

const RETIRED_V1_CONTROLS = [
    ['NF-NCSC-MCSS-SC-01', 'Folded into v2: default passwords move to the network question and software settings to patching guidance. PR.PS-01 is now asserted from the network and email questions; ID.RA-07 has no v2 source.'],
    ['NF-NCSC-CC-AC-01', 'Cut in v2 and kept only as a patching tip, which is not a compared prompt. PR.PS-05 has no v2 source.']
];

const LIMITATIONS = [
    'Direction is source NCSC question to target NIST outcome; neither exact nor partial establishes an automatic inverse relationship.',
    'Exact would require the source prompt to assess the entire target outcome within the same declared scope; no exact mapping is asserted in this edition.',
    'Partial identifies a concrete overlap and explicitly names omitted target scope; it does not give fractional attainment credit.',
    'No match means no sufficiently specific direct editorial relationship is asserted after review of the declared opposite universe. It is not proof that implementations cannot overlap.',
    'A target no-match record has null source and refers to all 16 reviewed source questions. A source no-match record has null target and refers to all 106 reviewed target outcomes.',
    'An absent individual source-target pair is unasserted, not implicitly no-match. Every source question, source control and target endpoint has an explicit positive or no-match disposition.',
    'Endpoints are questions, not controls: NF-NCSC-MCSS-MF-01 and NF-NCSC-MCSS-DR-01 each have two questions, and each question has its own records.',
    'Only the exact question prompt is compared. Help text, next steps, evidence examples, answer credits and weights are not the compared unit.',
    'The supplier-access and email-protection questions are No Fries additions, not NCSC Minimum Cyber Security Standards or NCSC Critical Controls.',
    'Many-to-many references do not create scored atoms or a combined denominator. Repeated source references retain their original profile and question identities.',
    'Native NIST assessment requires its own complete input set and existing applicability/evidence decisions; source NCSC answers are never copied automatically.',
    'Each record states whether it reuses, restates or is new against the v1 crosswalk for profile 2026-09-02.1. That crosswalk and its results are unchanged and still apply only to that profile.',
    'Source-only construction does not install a runtime profile, public endpoint, questionnaire, report or paid/customer-facing release.',
    'The accepted NCSC profile attribution, source-specific rights states and exact-publication legal-review limitation remain unchanged.'
];

let cached;

function createNistNcscCrosswalkV2() {
    if (!cached) cached = JSON.stringify(build());
    return freeze(JSON.parse(cached));
}

function build() {
    let sourceProfile;
    let targetProfile;
    let v1;
    try {
        sourceProfile = publishFrameworkProfile(createNcscFrameworkProfileV2());
        targetProfile = publishFrameworkProfile(createNistFrameworkProfile());
        v1 = createNistNcscCrosswalk();
    } catch (_) {
        throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
    }
    try {
        const publication = assemble(sourceProfile, targetProfile, v1);
        validate(publication, sourceProfile, targetProfile, v1);
        const actualDigest = digest(publication);
        if (actualDigest !== EXPECTED_CROSSWALK_V2_SHA256) {
            throw new NistNcscCrosswalkError('crosswalk_digest_mismatch');
        }
        publication.crosswalkSha256 = actualDigest;
        return publication;
    } catch (error) {
        if (error instanceof NistNcscCrosswalkError) throw error;
        throw new NistNcscCrosswalkError('crosswalk_invalid');
    }
}

function digest(body) {
    return crypto.createHash('sha256').update(HASH_PREFIX + canonicalJson(body), 'utf8').digest('hex');
}

function assemble(sourceProfile, targetProfile, v1) {
    const questionIndex = new Map(sourceProfile.questions.map((question, index) => [question.id, index]));
    const controlOf = new Map(sourceProfile.questions.map((question) => [question.id, question.controlId]));
    const v1ByKey = new Map(v1.records.map((record) => [key(record.source && record.source.controlId,
        record.target && record.target.controlId), record]));
    const pageByTarget = new Map(v1.records.filter((record) => record.target)
        .map((record) => [record.target.controlId, record.locators.targetReference.pdfPage]));
    const source = (questionId) => (questionId === null ? null
        : { controlId: controlOf.get(questionId), questionId });
    const target = (controlId) => (controlId === null ? null : { controlId, questionId: `${controlId}-Q1` });
    const locators = (questionId, controlId) => ({
        sourceQuestionPointer: questionId === null ? null : `/questions/${questionIndex.get(questionId)}/prompt`,
        targetReference: controlId === null ? null
            : { sourceId: NIST_SOURCE_ID, referenceId: controlId, pdfPage: pageByTarget.get(controlId) }
    });
    const fromV1 = (questionId, controlId) => {
        const record = v1ByKey.get(key(questionId === null ? null : controlOf.get(questionId), controlId));
        if (!record) invalid();
        return record;
    };
    const records = [];
    const push = (questionId, controlId, relationship, v1Lineage, rationale, omitted) => records.push({
        id: `${questionId === null ? ALL_SOURCES : questionId}--${controlId === null ? ALL_TARGETS : controlId}`,
        order: records.length + 1,
        source: source(questionId),
        target: target(controlId),
        relationship,
        rationale,
        omittedTargetScope: omitted,
        v1Lineage,
        locators: locators(questionId, controlId)
    });
    POSITIVE.forEach(([questionId, controlId, lineage, rationale, omitted]) => {
        if (lineage === 'reused') {
            const prior = fromV1(questionId, controlId);
            push(questionId, controlId, prior.relationship, lineage, prior.rationale, [...prior.omittedTargetScope]);
        } else push(questionId, controlId, 'partial', lineage, rationale, [omitted]);
    });
    const targetOrder = targetProfile.controls.map((control) => control.id);
    const noMatchByTarget = new Map();
    TARGET_NO_MATCH.forEach(([ids, lineage, rationale]) => ids.split(' ').forEach((id) => {
        if (noMatchByTarget.has(id)) invalid();
        noMatchByTarget.set(id, [lineage, rationale]);
    }));
    targetOrder.filter((id) => noMatchByTarget.has(id)).forEach((id) => {
        const [lineage, rationale] = noMatchByTarget.get(id);
        const text = lineage === 'reused' ? fromV1(null, id).rationale : `${rationale} ${NOT_ASSERTED}`;
        push(null, id, 'no_match', lineage, text, []);
    });
    SOURCE_NO_MATCH.forEach(([questionId, lineage]) => {
        if (lineage !== 'reused') invalid();
        push(questionId, null, 'no_match', lineage, fromV1(questionId, null).rationale, []);
    });
    const controlDispositions = CONTROL_NOTES.map(([controlId, lineage, note, dropped]) => {
        const questionIds = sourceProfile.questions.filter((question) => question.controlId === controlId)
            .map((question) => question.id);
        const mapped = records.some((record) => record.relationship === 'partial'
            && record.source.controlId === controlId);
        return {
            controlId,
            questionIds,
            disposition: mapped ? 'mapped' : 'unmapped',
            mappedTargetControlIds: [...new Set(records.filter((record) => record.relationship === 'partial'
                && record.source.controlId === controlId).map((record) => record.target.controlId))],
            v1Lineage: lineage,
            changeNote: note,
            droppedV1Targets: dropped.map(([targetId, reason]) => ({ targetControlId: targetId, reason }))
        };
    });
    return {
        schemaVersion: 2,
        id: 'nf-ncsc-to-nist-csf-2-0',
        version: '2026-11-20.2',
        publishedAt: '2026-11-20',
        direction: 'ncsc-question-to-nist-outcome',
        comparisonBasis: 'no-fries-ncsc-v2-question-prompt-to-official-nist-subcategory-outcome',
        fromProfileRef: profileRef(sourceProfile),
        toProfileRef: profileRef(targetProfile),
        priorEdition: {
            id: v1.id, version: v1.version, crosswalkSha256: v1.crosswalkSha256,
            fromProfileRef: { ...v1.fromProfileRef },
            retiredSourceControls: RETIRED_V1_CONTROLS.map(([controlId, reason]) => ({ controlId, reason }))
        },
        reviewedSourceQuestionIds: sourceProfile.questions.map((question) => question.id),
        reviewedSourceControlIds: sourceProfile.controls.map((control) => control.id),
        reviewedTargetControlIds: targetOrder,
        provenance: {
            author: v1.provenance.author,
            authoredAt: '2026-11-20',
            methodVersion: 'prompt-to-outcome-editorial-v2',
            nistSourceUrl: v1.provenance.nistSourceUrl,
            nistSourceVersion: v1.provenance.nistSourceVersion,
            nistSourceFileSha256: v1.provenance.nistSourceFileSha256,
            nistOutcomeTranscriptionSha256: v1.provenance.nistOutcomeTranscriptionSha256
        },
        statements: {
            attribution: v1.statements.attribution,
            basis: 'No Fries editorial comparison of the 16 exact NCSC-aligned v2 question prompts (profile 2026-11-18.1) and 106 final CSF 2.0 subcategory outcomes. Help text, next steps, labels, inferred implementations and all cumulative official NCSC requirements are not the compared unit.',
            claim: v1.statements.claim,
            limitations: [...LIMITATIONS]
        },
        controlDispositions,
        records
    };
}

function validate(value, sourceProfile, targetProfile, v1) {
    keys(value, [
        'schemaVersion', 'id', 'version', 'publishedAt', 'direction', 'comparisonBasis', 'fromProfileRef',
        'toProfileRef', 'priorEdition', 'reviewedSourceQuestionIds', 'reviewedSourceControlIds',
        'reviewedTargetControlIds', 'provenance', 'statements', 'controlDispositions', 'records'
    ]);
    if (sourceProfile.questions.length !== SOURCE_COUNT || sourceProfile.controls.length !== SOURCE_CONTROL_COUNT
        || targetProfile.controls.length !== TARGET_COUNT || targetProfile.questions.length !== TARGET_COUNT) {
        throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
    }
    if (value.fromProfileRef.profileVersion !== '2026-11-18.1'
        || same(value.fromProfileRef, v1.fromProfileRef) || !same(value.toProfileRef, v1.toProfileRef)) {
        throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
    }
    SHARED_PROVENANCE_KEYS.forEach((name) => { if (value.provenance[name] !== v1.provenance[name]) invalid(); });
    Object.values(value.provenance).forEach(text);
    ['attribution', 'basis', 'claim'].forEach((name) => text(value.statements[name]));
    textList(value.statements.limitations, true);

    const questions = new Map(sourceProfile.questions.map((question, index) => [question.id, { question, index }]));
    const targets = new Map(targetProfile.controls.map((control) => [control.id, control]));
    const v1ByKey = new Map(v1.records.map((record) => [key(record.source && record.source.controlId,
        record.target && record.target.controlId), record]));
    const v1Pages = new Map(v1.records.filter((record) => record.target)
        .map((record) => [record.target.controlId, record.locators.targetReference.pdfPage]));
    const lane = () => ({ positive: 0, noMatch: 0 });
    const sourceLanes = new Map([...questions.keys()].map((id) => [id, lane()]));
    const targetLanes = new Map([...targets.keys()].map((id) => [id, lane()]));
    const ids = new Set();
    value.records.forEach((record, index) => {
        keys(record, ['id', 'order', 'source', 'target', 'relationship', 'rationale', 'omittedTargetScope',
            'v1Lineage', 'locators']);
        if (record.order !== index + 1 || ids.has(record.id)) invalid();
        ids.add(record.id);
        const source = record.source;
        const target = record.target;
        if (source) {
            keys(source, ['controlId', 'questionId']);
            const found = questions.get(source.questionId);
            if (!found || found.question.controlId !== source.controlId) invalid();
            if (record.locators.sourceQuestionPointer !== `/questions/${found.index}/prompt`) invalid();
        } else if (record.locators.sourceQuestionPointer !== null) invalid();
        if (target) {
            keys(target, ['controlId', 'questionId']);
            const control = targets.get(target.controlId);
            if (!control || target.questionId !== `${target.controlId}-Q1`) invalid();
            if (!same(record.locators.targetReference, { sourceId: NIST_SOURCE_ID, referenceId: target.controlId,
                pdfPage: v1Pages.get(target.controlId) })
                || !same(control.sourceReferences, [{ sourceId: NIST_SOURCE_ID, referenceId: target.controlId, order: 1 }])) invalid();
        } else if (record.locators.targetReference !== null) invalid();
        if (!source && !target) invalid();
        if (record.id !== `${source ? source.questionId : ALL_SOURCES}--${target ? target.controlId : ALL_TARGETS}`) invalid();
        text(record.rationale);
        textList(record.omittedTargetScope, false);
        if (record.relationship === 'no_match') {
            if (Boolean(source) === Boolean(target) || record.omittedTargetScope.length !== 0) invalid();
        } else if (record.relationship === 'partial') {
            if (!source || !target || record.omittedTargetScope.length === 0) invalid();
        } else invalid();
        if (!LINEAGE.includes(record.v1Lineage)) invalid();
        const prior = v1ByKey.get(key(source && source.controlId, target && target.controlId));
        if (record.v1Lineage === 'new' && prior) invalid();
        if (record.v1Lineage !== 'new' && !prior) invalid();
        const unchanged = prior && prior.relationship === record.relationship && prior.rationale === record.rationale
            && same(prior.omittedTargetScope, record.omittedTargetScope);
        if ((record.v1Lineage === 'reused') !== Boolean(unchanged)) invalid();
        const laneName = record.relationship === 'no_match' ? 'noMatch' : 'positive';
        if (source) sourceLanes.get(source.questionId)[laneName] += 1;
        if (target) targetLanes.get(target.controlId)[laneName] += 1;
    });
    for (const disposition of [...sourceLanes.values(), ...targetLanes.values()]) {
        if (disposition.noMatch > 1 || (disposition.positive > 0 && disposition.noMatch !== 0)
            || (disposition.positive === 0 && disposition.noMatch !== 1)) invalid();
    }
    if (!same(value.reviewedSourceQuestionIds, [...questions.keys()])
        || !same(value.reviewedSourceControlIds, sourceProfile.controls.map((control) => control.id))
        || !same(value.reviewedTargetControlIds, [...targets.keys()])) invalid();

    // Every v2 control is disposed exactly once, in profile order.
    if (!same(value.controlDispositions.map((entry) => entry.controlId), value.reviewedSourceControlIds)) invalid();
    const v1Controls = new Set(v1.records.filter((record) => record.source).map((record) => record.source.controlId));
    value.controlDispositions.forEach((entry) => {
        keys(entry, ['controlId', 'questionIds', 'disposition', 'mappedTargetControlIds', 'v1Lineage', 'changeNote',
            'droppedV1Targets']);
        text(entry.changeNote);
        if (!CONTROL_LINEAGE.includes(entry.v1Lineage)
            || (entry.v1Lineage === 'new-control') === v1Controls.has(entry.controlId)) invalid();
        const own = value.records.filter((record) => record.source && record.source.controlId === entry.controlId);
        const positives = own.filter((record) => record.relationship === 'partial');
        if (!same(entry.questionIds, sourceProfile.questions.filter((question) => question.controlId === entry.controlId)
            .map((question) => question.id))) invalid();
        if (entry.disposition !== (positives.length ? 'mapped' : 'unmapped')) invalid();
        if (entry.disposition === 'unmapped' && own.length !== entry.questionIds.length) invalid();
        if (!same(entry.mappedTargetControlIds, [...new Set(positives.map((record) => record.target.controlId))])) invalid();
        if (entry.v1Lineage === 'same-meaning' && own.some((record) => record.v1Lineage !== 'reused')) invalid();
        const v1Targets = v1.records.filter((record) => record.relationship !== 'no_match'
            && record.source.controlId === entry.controlId).map((record) => record.target.controlId);
        const expectedDropped = v1Targets.filter((id) => !entry.mappedTargetControlIds.includes(id));
        entry.droppedV1Targets.forEach((dropped) => {
            keys(dropped, ['targetControlId', 'reason']);
            text(dropped.reason);
        });
        if (!same(entry.droppedV1Targets.map((dropped) => dropped.targetControlId), expectedDropped)) invalid();
        if (entry.v1Lineage === 'same-meaning' && expectedDropped.length) invalid();
    });
    const retired = value.priorEdition.retiredSourceControls.map((entry) => entry.controlId);
    const expectedRetired = [...v1Controls].filter((id) => !value.reviewedSourceControlIds.includes(id));
    if (!same(retired, expectedRetired)) invalid();
    value.priorEdition.retiredSourceControls.forEach((entry) => text(entry.reason));
}

function profileRef(profile) {
    return {
        frameworkId: profile.framework.id,
        frameworkVersion: profile.framework.version,
        profileId: profile.profile.id,
        profileVersion: profile.profile.version,
        catalogueSha256: profile.catalogueSha256,
        sourceCatalogueSha256: profile.sourceCatalogueSha256
    };
}

function key(sourceControlId, targetControlId) {
    return JSON.stringify([sourceControlId || null, targetControlId || null]);
}

function keys(value, expected) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    if (!same(Object.keys(value).sort(), [...expected].sort())) invalid();
}

function text(value) {
    if (typeof value !== 'string' || value.trim().length === 0) invalid();
}

function textList(value, nonempty) {
    if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid();
    value.forEach(text);
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function same(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}

function freeze(value) {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function invalid() {
    throw new NistNcscCrosswalkError('crosswalk_invalid');
}

module.exports = { createNistNcscCrosswalkV2, NistNcscCrosswalkError };
