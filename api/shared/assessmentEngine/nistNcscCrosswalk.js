'use strict';

const crypto = require('crypto');
const { publishFrameworkProfile } = require('./frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('./ncscAcceptedFrameworkProfile');
const { createNistFrameworkProfile } = require('./nistFrameworkProfile');

const EXPECTED_CROSSWALK_SHA256 = '61f68fba7bfd3ce9480a0db5f6e4d297bdcf1aff63e80073bffd27dc2abf1e17';
const HASH_PREFIX = 'no-fries-nist-ncsc-crosswalk-v1\n';
const NIST_SOURCE_ID = 'nist-cswp-29-final-2024-02-26';
const PROFILE_REF_KEYS = [
    'frameworkId', 'frameworkVersion', 'profileId', 'profileVersion',
    'catalogueSha256', 'sourceCatalogueSha256'
];

class NistNcscCrosswalkError extends Error {
    constructor(code) {
        super(`NIST/NCSC crosswalk construction failed (${code})`);
        this.name = 'NistNcscCrosswalkError';
        this.code = code;
    }
}

function createNistNcscCrosswalk() {
    let sourceProfile;
    let targetProfile;
    try {
        // Reuse the existing publisher's content verification, not just reported pins.
        sourceProfile = publishFrameworkProfile(createAcceptedNcscFrameworkProfile());
        targetProfile = publishFrameworkProfile(createNistFrameworkProfile());
    } catch (_) {
        throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
    }
    try {
        const publication = JSON.parse(JSON.stringify(CROSSWALK_PUBLICATION));
        validateFixedPublication(publication, sourceProfile, targetProfile);
        const { crosswalkSha256, ...body } = publication;
        const actualDigest = crypto.createHash('sha256')
            .update(HASH_PREFIX + canonicalJson(body), 'utf8').digest('hex');
        if (crosswalkSha256 !== EXPECTED_CROSSWALK_SHA256 || actualDigest !== EXPECTED_CROSSWALK_SHA256) {
            throw new NistNcscCrosswalkError('crosswalk_digest_mismatch');
        }
        return freeze(publication);
    } catch (error) {
        if (error instanceof NistNcscCrosswalkError) throw error;
        throw new NistNcscCrosswalkError('crosswalk_invalid');
    }
}

// Only this module's fixed authored JSON and the two fixed publishers reach these
// checks. There is deliberately no arbitrary crosswalk ingestion or validator API.
function validateFixedPublication(value, sourceProfile, targetProfile) {
    keys(value, [
        'schemaVersion', 'id', 'version', 'publishedAt', 'direction', 'comparisonBasis',
        'fromProfileRef', 'toProfileRef', 'reviewedSourceQuestionIds',
        'reviewedTargetControlIds', 'provenance', 'statements', 'records', 'crosswalkSha256'
    ]);
    if (value.schemaVersion !== 1 || value.id !== 'nf-ncsc-to-nist-csf-2-0'
        || value.version !== '2026-09-08.1' || value.publishedAt !== '2026-09-08'
        || value.direction !== 'ncsc-question-to-nist-outcome'
        || value.comparisonBasis !== 'accepted-no-fries-ncsc-question-prompt-to-official-nist-subcategory-outcome') invalid();
    keys(value.fromProfileRef, PROFILE_REF_KEYS);
    keys(value.toProfileRef, PROFILE_REF_KEYS);
    if (!same(value.fromProfileRef, profileRef(sourceProfile))
        || !same(value.toProfileRef, profileRef(targetProfile))) {
        throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
    }
    const sourceItems = items(sourceProfile, 14);
    const targetItems = items(targetProfile, 106);
    if (!same(value.reviewedSourceQuestionIds, sourceProfile.questions.map((question) => question.id))
        || !same(value.reviewedTargetControlIds, targetProfile.controls.map((control) => control.id))) invalid();
    keys(value.provenance, [
        'author', 'authoredAt', 'methodVersion', 'nistSourceUrl', 'nistSourceVersion',
        'nistSourceFileSha256', 'nistOutcomeTranscriptionSha256', 'acceptedNcscModuleSha256'
    ]);
    Object.values(value.provenance).forEach(text);
    keys(value.statements, ['attribution', 'basis', 'claim', 'limitations']);
    ['attribution', 'basis', 'claim'].forEach((key) => text(value.statements[key]));
    textList(value.statements.limitations, true);
    if (!Array.isArray(value.records) || value.records.length !== 109) invalid();

    const recordIds = new Set();
    const pairs = new Set();
    const sourceDispositions = new Map([...sourceItems.keys()].map((id) => [id, { positive: 0, noMatch: 0 }]));
    const targetDispositions = new Map([...targetItems.keys()].map((id) => [id, { positive: 0, noMatch: 0 }]));
    value.records.forEach((record, index) => {
        keys(record, ['id', 'order', 'source', 'target', 'relationship', 'rationale', 'omittedTargetScope', 'locators']);
        if (record.order !== index + 1) invalid();
        const source = endpoint(record.source, sourceItems);
        const target = endpoint(record.target, targetItems);
        if (!source && !target) invalid();
        const expectedId = `${source ? source.controlId : 'ALL-NCSC14'}--${target ? target.controlId : 'ALL-NIST106'}`;
        if (record.id !== expectedId || recordIds.has(record.id)) invalid();
        recordIds.add(record.id);
        const pair = JSON.stringify([source && source.controlId, target && target.controlId]);
        if (pairs.has(pair)) invalid();
        pairs.add(pair);
        text(record.rationale);
        textList(record.omittedTargetScope, false);
        if (record.relationship === 'no_match') {
            if (Boolean(source) === Boolean(target) || record.omittedTargetScope.length !== 0) invalid();
        } else if (record.relationship === 'partial' || record.relationship === 'exact') {
            if (!source || !target) invalid();
            if ((record.relationship === 'partial') !== (record.omittedTargetScope.length > 0)) invalid();
        } else invalid();

        keys(record.locators, ['sourceQuestionPointer', 'targetReference']);
        const expectedPointer = source ? `/questions/${source.index}/prompt` : null;
        if (record.locators.sourceQuestionPointer !== expectedPointer) invalid();
        if (target) {
            keys(record.locators.targetReference, ['sourceId', 'referenceId', 'pdfPage']);
            if (record.locators.targetReference.sourceId !== NIST_SOURCE_ID
                || record.locators.targetReference.referenceId !== target.controlId
                || record.locators.targetReference.pdfPage !== PDF_PAGE_BY_CONTROL[target.controlId]
                || !same(target.control.sourceReferences, [{ sourceId: NIST_SOURCE_ID, referenceId: target.controlId, order: 1 }])) invalid();
        } else if (record.locators.targetReference !== null) invalid();
        const lane = record.relationship === 'no_match' ? 'noMatch' : 'positive';
        if (source) sourceDispositions.get(source.controlId)[lane] += 1;
        if (target) targetDispositions.get(target.controlId)[lane] += 1;
    });
    for (const disposition of [...sourceDispositions.values(), ...targetDispositions.values()]) {
        if (disposition.noMatch > 1 || (disposition.positive > 0 && disposition.noMatch !== 0)
            || (disposition.positive === 0 && disposition.noMatch !== 1)) invalid();
    }
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

function items(profile, count) {
    if (profile.controls.length !== count || profile.questions.length !== count) {
        throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
    }
    const controls = new Map(profile.controls.map((control) => [control.id, control]));
    const result = new Map();
    profile.questions.forEach((question, index) => {
        if (!controls.has(question.controlId) || result.has(question.controlId)
            || question.id !== `${question.controlId}-Q1`) {
            throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
        }
        result.set(question.controlId, {
            controlId: question.controlId, questionId: question.id, index,
            control: controls.get(question.controlId)
        });
    });
    return result;
}

function endpoint(value, catalogue) {
    if (value === null) return null;
    keys(value, ['controlId', 'questionId']);
    const item = catalogue.get(value.controlId);
    if (!item || item.questionId !== value.questionId) invalid();
    return item;
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
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
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

// Physical pages of the pinned final PDF; this is independent locator metadata.
const PDF_PAGE_BY_CONTROL = {
    "GV.OC-01": 21,
    "GV.OC-02": 21,
    "GV.OC-03": 21,
    "GV.OC-04": 21,
    "GV.OC-05": 21,
    "GV.RM-01": 21,
    "GV.RM-02": 21,
    "GV.RM-03": 21,
    "GV.RM-04": 21,
    "GV.RM-05": 21,
    "GV.RM-06": 21,
    "GV.RM-07": 21,
    "GV.RR-01": 22,
    "GV.RR-02": 22,
    "GV.RR-03": 22,
    "GV.RR-04": 22,
    "GV.PO-01": 22,
    "GV.PO-02": 22,
    "GV.OV-01": 22,
    "GV.OV-02": 22,
    "GV.OV-03": 22,
    "GV.SC-01": 22,
    "GV.SC-02": 22,
    "GV.SC-03": 22,
    "GV.SC-04": 22,
    "GV.SC-05": 23,
    "GV.SC-06": 23,
    "GV.SC-07": 23,
    "GV.SC-08": 23,
    "GV.SC-09": 23,
    "GV.SC-10": 23,
    "ID.AM-01": 23,
    "ID.AM-02": 23,
    "ID.AM-03": 23,
    "ID.AM-04": 23,
    "ID.AM-05": 23,
    "ID.AM-07": 23,
    "ID.AM-08": 23,
    "ID.RA-01": 23,
    "ID.RA-02": 24,
    "ID.RA-03": 24,
    "ID.RA-04": 24,
    "ID.RA-05": 24,
    "ID.RA-06": 24,
    "ID.RA-07": 24,
    "ID.RA-08": 24,
    "ID.RA-09": 24,
    "ID.RA-10": 24,
    "ID.IM-01": 24,
    "ID.IM-02": 24,
    "ID.IM-03": 24,
    "ID.IM-04": 24,
    "PR.AA-01": 24,
    "PR.AA-02": 24,
    "PR.AA-03": 24,
    "PR.AA-04": 24,
    "PR.AA-05": 25,
    "PR.AA-06": 25,
    "PR.AT-01": 25,
    "PR.AT-02": 25,
    "PR.DS-01": 25,
    "PR.DS-02": 25,
    "PR.DS-10": 25,
    "PR.DS-11": 25,
    "PR.PS-01": 25,
    "PR.PS-02": 25,
    "PR.PS-03": 25,
    "PR.PS-04": 25,
    "PR.PS-05": 25,
    "PR.PS-06": 25,
    "PR.IR-01": 25,
    "PR.IR-02": 26,
    "PR.IR-03": 26,
    "PR.IR-04": 26,
    "DE.CM-01": 26,
    "DE.CM-02": 26,
    "DE.CM-03": 26,
    "DE.CM-06": 26,
    "DE.CM-09": 26,
    "DE.AE-02": 26,
    "DE.AE-03": 26,
    "DE.AE-04": 26,
    "DE.AE-06": 26,
    "DE.AE-07": 26,
    "DE.AE-08": 26,
    "RS.MA-01": 27,
    "RS.MA-02": 27,
    "RS.MA-03": 27,
    "RS.MA-04": 27,
    "RS.MA-05": 27,
    "RS.AN-03": 27,
    "RS.AN-06": 27,
    "RS.AN-07": 27,
    "RS.AN-08": 27,
    "RS.CO-02": 27,
    "RS.CO-03": 27,
    "RS.MI-01": 27,
    "RS.MI-02": 27,
    "RC.RP-01": 27,
    "RC.RP-02": 28,
    "RC.RP-03": 28,
    "RC.RP-04": 28,
    "RC.RP-05": 28,
    "RC.RP-06": 28,
    "RC.CO-03": 28,
    "RC.CO-04": 28
};

// Exact reviewed editorial publication. It contains references, never answers.
const CROSSWALK_PUBLICATION = {
    "schemaVersion": 1,
    "id": "nf-ncsc-to-nist-csf-2-0",
    "version": "2026-09-08.1",
    "publishedAt": "2026-09-08",
    "direction": "ncsc-question-to-nist-outcome",
    "comparisonBasis": "accepted-no-fries-ncsc-question-prompt-to-official-nist-subcategory-outcome",
    "fromProfileRef": {
        "frameworkId": "nz-ncsc-cyber-security-framework",
        "frameworkVersion": "beta-verified-2026-09-02",
        "profileId": "nz-ncsc-mcss-2025-v3-sme",
        "profileVersion": "2026-09-02.1",
        "catalogueSha256": "32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375",
        "sourceCatalogueSha256": "26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee"
    },
    "toProfileRef": {
        "frameworkId": "nist-cybersecurity-framework",
        "frameworkVersion": "2.0",
        "profileId": "nf-nist-csf-2-0-core",
        "profileVersion": "2026-09-08.1",
        "catalogueSha256": "ec394a65b11417b67201f96af57a7eabeb284376bb0651b816b40017476b6073",
        "sourceCatalogueSha256": "ab75b51c3561c50cb48cd21b96c01afa2aecafb2efc6b46ae4a8ef8cd753a656"
    },
    "reviewedSourceQuestionIds": [
        "NF-NCSC-MCSS-RM-01-Q1",
        "NF-NCSC-MCSS-SA-01-Q1",
        "NF-NCSC-MCSS-AI-01-Q1",
        "NF-NCSC-MCSS-SC-01-Q1",
        "NF-NCSC-MCSS-PA-01-Q1",
        "NF-NCSC-MCSS-MF-01-Q1",
        "NF-NCSC-MCSS-DU-01-Q1",
        "NF-NCSC-MCSS-LP-01-Q1",
        "NF-NCSC-MCSS-DR-01-Q1",
        "NF-NCSC-MCSS-RP-01-Q1",
        "NF-NCSC-CC-PM-01-Q1",
        "NF-NCSC-CC-SV-01-Q1",
        "NF-NCSC-CC-AC-01-Q1",
        "NF-NCSC-CC-NS-01-Q1"
    ],
    "reviewedTargetControlIds": [
        "GV.OC-01",
        "GV.OC-02",
        "GV.OC-03",
        "GV.OC-04",
        "GV.OC-05",
        "GV.RM-01",
        "GV.RM-02",
        "GV.RM-03",
        "GV.RM-04",
        "GV.RM-05",
        "GV.RM-06",
        "GV.RM-07",
        "GV.RR-01",
        "GV.RR-02",
        "GV.RR-03",
        "GV.RR-04",
        "GV.PO-01",
        "GV.PO-02",
        "GV.OV-01",
        "GV.OV-02",
        "GV.OV-03",
        "GV.SC-01",
        "GV.SC-02",
        "GV.SC-03",
        "GV.SC-04",
        "GV.SC-05",
        "GV.SC-06",
        "GV.SC-07",
        "GV.SC-08",
        "GV.SC-09",
        "GV.SC-10",
        "ID.AM-01",
        "ID.AM-02",
        "ID.AM-03",
        "ID.AM-04",
        "ID.AM-05",
        "ID.AM-07",
        "ID.AM-08",
        "ID.RA-01",
        "ID.RA-02",
        "ID.RA-03",
        "ID.RA-04",
        "ID.RA-05",
        "ID.RA-06",
        "ID.RA-07",
        "ID.RA-08",
        "ID.RA-09",
        "ID.RA-10",
        "ID.IM-01",
        "ID.IM-02",
        "ID.IM-03",
        "ID.IM-04",
        "PR.AA-01",
        "PR.AA-02",
        "PR.AA-03",
        "PR.AA-04",
        "PR.AA-05",
        "PR.AA-06",
        "PR.AT-01",
        "PR.AT-02",
        "PR.DS-01",
        "PR.DS-02",
        "PR.DS-10",
        "PR.DS-11",
        "PR.PS-01",
        "PR.PS-02",
        "PR.PS-03",
        "PR.PS-04",
        "PR.PS-05",
        "PR.PS-06",
        "PR.IR-01",
        "PR.IR-02",
        "PR.IR-03",
        "PR.IR-04",
        "DE.CM-01",
        "DE.CM-02",
        "DE.CM-03",
        "DE.CM-06",
        "DE.CM-09",
        "DE.AE-02",
        "DE.AE-03",
        "DE.AE-04",
        "DE.AE-06",
        "DE.AE-07",
        "DE.AE-08",
        "RS.MA-01",
        "RS.MA-02",
        "RS.MA-03",
        "RS.MA-04",
        "RS.MA-05",
        "RS.AN-03",
        "RS.AN-06",
        "RS.AN-07",
        "RS.AN-08",
        "RS.CO-02",
        "RS.CO-03",
        "RS.MI-01",
        "RS.MI-02",
        "RC.RP-01",
        "RC.RP-02",
        "RC.RP-03",
        "RC.RP-04",
        "RC.RP-05",
        "RC.RP-06",
        "RC.CO-03",
        "RC.CO-04"
    ],
    "provenance": {
        "author": "No Fries Limited",
        "authoredAt": "2026-09-08",
        "methodVersion": "prompt-to-outcome-editorial-v1",
        "nistSourceUrl": "https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf",
        "nistSourceVersion": "CSF 2.0 / CSWP 29 / final / 2024-02-26",
        "nistSourceFileSha256": "3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c",
        "nistOutcomeTranscriptionSha256": "d74aec7af57ae8fc7f78b55df698a316cb0bec911b6e3af3a8967c21ad2e4e4c",
        "acceptedNcscModuleSha256": "18e0b79f4527c419f09f38be4fa01b083bccbaa310a65f0de1cfdac45769fe58"
    },
    "statements": {
        "attribution": "National Institute of Standards and Technology (2024) The NIST Cybersecurity Framework (CSF) 2.0. (National Institute of Standards and Technology, Gaithersburg, MD), NIST Cybersecurity White Paper (CSWP) NIST CSWP 29. https://doi.org/10.6028/NIST.CSWP.29. Republished courtesy of the National Institute of Standards and Technology. No Fries Limited, 2026-09-08: selected the complete CSF 2.0 Core, joined PDF line wrapping, and authored assessment prompts, evidence guidance, identifiers for questions, equal outcome weights, response labels and separate editorial crosswalks. The NIST outcome text and subcategory identifiers are retained. No NIST endorsement is implied. Adapted by No Fries Limited from the NCSC Cyber Security Framework and Minimum Cyber Security Standards 2025, © Crown copyright, GCSB on behalf of the Crown, licensed under CC BY 4.0. Changes were made for New Zealand SMEs. No NCSC endorsement is implied.",
        "basis": "No Fries editorial comparison of the 14 exact accepted NCSC question prompts and 106 final CSF 2.0 subcategory outcomes. Guidance, labels, inferred implementations and all cumulative official NCSC requirements are not the compared unit.",
        "claim": "Mapped reference coverage only. This is not an official NIST or NCSC crosswalk, an answer/evidence transfer, a NIST score, Tier, certification, endorsement or compliance determination.",
        "limitations": [
            "Direction is source NCSC question to target NIST outcome; neither exact nor partial establishes an automatic inverse relationship.",
            "Exact would require the source prompt to assess the entire target outcome within the same declared scope; no exact mapping is asserted in this edition.",
            "Partial identifies a concrete overlap and explicitly names omitted target scope; it does not give fractional attainment credit.",
            "No match means no sufficiently specific direct editorial relationship is asserted after review of the declared opposite universe. It is not proof that implementations cannot overlap.",
            "A target no-match record has null source and refers to all 14 reviewed source questions. A source no-match record has null target and refers to all 106 reviewed target outcomes.",
            "An absent individual source-target pair is unasserted, not implicitly no-match. Every source and target endpoint has an explicit positive or no-match disposition.",
            "Many-to-many references do not create scored atoms or a combined denominator. Repeated source references retain their original profile and question identities.",
            "Native NIST assessment requires its own complete input set and existing applicability/evidence decisions; source NCSC answers are never copied automatically.",
            "Source-only construction does not install a runtime profile, public endpoint, questionnaire, report or paid/customer-facing release.",
            "The accepted NCSC profile attribution, source-specific rights states and exact-publication legal-review limitation remain unchanged."
        ]
    },
    "records": [
        {
            "id": "NF-NCSC-MCSS-RM-01--GV.RM-02",
            "order": 1,
            "source": {
                "controlId": "NF-NCSC-MCSS-RM-01",
                "questionId": "NF-NCSC-MCSS-RM-01-Q1"
            },
            "target": {
                "controlId": "GV.RM-02",
                "questionId": "GV.RM-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for a documented risk process with tolerance.",
            "omittedTargetScope": [
                "Explicit risk appetite, communication and maintenance of both appetite and tolerance statements are not all asked for."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/0/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RM-02",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-RM-01--GV.RM-03",
            "order": 2,
            "source": {
                "controlId": "NF-NCSC-MCSS-RM-01",
                "questionId": "NF-NCSC-MCSS-RM-01-Q1"
            },
            "target": {
                "controlId": "GV.RM-03",
                "questionId": "GV.RM-03-Q1"
            },
            "relationship": "partial",
            "rationale": "The source places cyber risk in a documented business risk process.",
            "omittedTargetScope": [
                "Explicit integration of all cybersecurity risk activities and outcomes into enterprise risk management is broader than the concise source prompt."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/0/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RM-03",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-RM-01--GV.RR-02",
            "order": 3,
            "source": {
                "controlId": "NF-NCSC-MCSS-RM-01",
                "questionId": "NF-NCSC-MCSS-RM-01-Q1"
            },
            "target": {
                "controlId": "GV.RR-02",
                "questionId": "GV.RR-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for accountable owners in the cyber risk process.",
            "omittedTargetScope": [
                "All cybersecurity roles, responsibilities and authorities, their communication, understanding and enforcement are not covered."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/0/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RR-02",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-RM-01--GV.OV-02",
            "order": 4,
            "source": {
                "controlId": "NF-NCSC-MCSS-RM-01",
                "questionId": "NF-NCSC-MCSS-RM-01-Q1"
            },
            "target": {
                "controlId": "GV.OV-02",
                "questionId": "GV.OV-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for regular review of the business cyber-risk process.",
            "omittedTargetScope": [
                "Explicit strategy adjustment and demonstrated coverage of organizational requirements and risks are not required by the prompt."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/0/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OV-02",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-SA-01--PR.AT-01",
            "order": 5,
            "source": {
                "controlId": "NF-NCSC-MCSS-SA-01",
                "questionId": "NF-NCSC-MCSS-SA-01-Q1"
            },
            "target": {
                "controlId": "PR.AT-01",
                "questionId": "PR.AT-01-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for current security guidance from onboarding onward.",
            "omittedTargetScope": [
                "Demonstrating the knowledge and skills to perform general tasks across the personnel population is broader than providing guidance."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/1/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AT-01",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-SA-01--PR.AT-02",
            "order": 6,
            "source": {
                "controlId": "NF-NCSC-MCSS-SA-01",
                "questionId": "NF-NCSC-MCSS-SA-01-Q1"
            },
            "target": {
                "controlId": "PR.AT-02",
                "questionId": "PR.AT-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for role-appropriate security guidance.",
            "omittedTargetScope": [
                "Specialized-role competence and all relevant tasks are not explicitly assessed."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/1/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AT-02",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-AI-01--ID.AM-01",
            "order": 7,
            "source": {
                "controlId": "NF-NCSC-MCSS-AI-01",
                "questionId": "NF-NCSC-MCSS-AI-01-Q1"
            },
            "target": {
                "controlId": "ID.AM-01",
                "questionId": "ID.AM-01-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for a current inventory of important hardware.",
            "omittedTargetScope": [
                "Hardware outside the important-asset subset is not expressly included."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/2/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.AM-01",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-AI-01--ID.AM-02",
            "order": 8,
            "source": {
                "controlId": "NF-NCSC-MCSS-AI-01",
                "questionId": "NF-NCSC-MCSS-AI-01-Q1"
            },
            "target": {
                "controlId": "ID.AM-02",
                "questionId": "ID.AM-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for a current inventory of important software and cloud services.",
            "omittedTargetScope": [
                "All managed systems, services and software are broader than this important-asset subset."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/2/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.AM-02",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-AI-01--ID.AM-07",
            "order": 9,
            "source": {
                "controlId": "NF-NCSC-MCSS-AI-01",
                "questionId": "NF-NCSC-MCSS-AI-01-Q1"
            },
            "target": {
                "controlId": "ID.AM-07",
                "questionId": "ID.AM-07-Q1"
            },
            "relationship": "partial",
            "rationale": "The source includes important data in the current inventory.",
            "omittedTargetScope": [
                "Designated data types and their corresponding metadata are not expressly required."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/2/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.AM-07",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-AI-01--ID.AM-08",
            "order": 10,
            "source": {
                "controlId": "NF-NCSC-MCSS-AI-01",
                "questionId": "NF-NCSC-MCSS-AI-01-Q1"
            },
            "target": {
                "controlId": "ID.AM-08",
                "questionId": "ID.AM-08-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for owners and lifecycle status for hardware, software, cloud services and data.",
            "omittedTargetScope": [
                "Maintaining status is narrower than managing every asset throughout its lifecycle."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/2/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.AM-08",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-SC-01--PR.PS-01",
            "order": 11,
            "source": {
                "controlId": "NF-NCSC-MCSS-SC-01",
                "questionId": "NF-NCSC-MCSS-SC-01-Q1"
            },
            "target": {
                "controlId": "PR.PS-01",
                "questionId": "PR.PS-01-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for secure baselines on new and existing systems and review of exceptions.",
            "omittedTargetScope": [
                "Configuration-management practices beyond secure baselines and these exception reviews are not fully assessed."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/3/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.PS-01",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-SC-01--ID.RA-07",
            "order": 12,
            "source": {
                "controlId": "NF-NCSC-MCSS-SC-01",
                "questionId": "NF-NCSC-MCSS-SC-01-Q1"
            },
            "target": {
                "controlId": "ID.RA-07",
                "questionId": "ID.RA-07-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for configuration exceptions to be reviewed when software changes.",
            "omittedTargetScope": [
                "Risk-impact assessment, recording and tracking of all changes and exceptions are not expressly required."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/3/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-07",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-PA-01--PR.PS-02",
            "order": 13,
            "source": {
                "controlId": "NF-NCSC-MCSS-PA-01",
                "questionId": "NF-NCSC-MCSS-PA-01-Q1"
            },
            "target": {
                "controlId": "PR.PS-02",
                "questionId": "PR.PS-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for repeatable prioritized patching with verification, rollback and retirement.",
            "omittedTargetScope": [
                "All software maintenance, replacement and removal decisions commensurate with risk extend beyond the patch process."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/4/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.PS-02",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-MF-01--PR.AA-03",
            "order": 14,
            "source": {
                "controlId": "NF-NCSC-MCSS-MF-01",
                "questionId": "NF-NCSC-MCSS-MF-01-Q1"
            },
            "target": {
                "controlId": "PR.AA-03",
                "questionId": "PR.AA-03-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for MFA on critical, internet-accessible, privileged and relevant third-party access.",
            "omittedTargetScope": [
                "Authentication of all users, services and hardware outside those access classes is not established."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/5/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AA-03",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-DU-01--PR.PS-04",
            "order": 15,
            "source": {
                "controlId": "NF-NCSC-MCSS-DU-01",
                "questionId": "NF-NCSC-MCSS-DU-01-Q1"
            },
            "target": {
                "controlId": "PR.PS-04",
                "questionId": "PR.PS-04-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for useful logs from critical and externally facing systems to be gathered for review and alerting.",
            "omittedTargetScope": [
                "Generation and availability of logs across the wider platform population are not fully covered."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/6/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.PS-04",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-DU-01--DE.CM-09",
            "order": 16,
            "source": {
                "controlId": "NF-NCSC-MCSS-DU-01",
                "questionId": "NF-NCSC-MCSS-DU-01-Q1"
            },
            "target": {
                "controlId": "DE.CM-09",
                "questionId": "DE.CM-09-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for review and actionable alerts from critical and externally facing system logs.",
            "omittedTargetScope": [
                "Monitoring the complete hardware, software, runtime-environment and data population through all relevant signals is broader."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/6/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.CM-09",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-DU-01--DE.AE-02",
            "order": 17,
            "source": {
                "controlId": "NF-NCSC-MCSS-DU-01",
                "questionId": "NF-NCSC-MCSS-DU-01-Q1"
            },
            "target": {
                "controlId": "DE.AE-02",
                "questionId": "DE.AE-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for gathered logs to be reviewed and turned into actionable alerts.",
            "omittedTargetScope": [
                "Analysis that explains the associated activities of all potentially adverse events is not expressly required."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/6/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.AE-02",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-LP-01--PR.AA-01",
            "order": 18,
            "source": {
                "controlId": "NF-NCSC-MCSS-LP-01",
                "questionId": "NF-NCSC-MCSS-LP-01-Q1"
            },
            "target": {
                "controlId": "PR.AA-01",
                "questionId": "PR.AA-01-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for repeatable joiner, mover, leaver and access review processes for people.",
            "omittedTargetScope": [
                "Identity and credential management for services and hardware and the full credential lifecycle are not covered."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/7/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AA-01",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-LP-01--PR.AA-05",
            "order": 19,
            "source": {
                "controlId": "NF-NCSC-MCSS-LP-01",
                "questionId": "NF-NCSC-MCSS-LP-01-Q1"
            },
            "target": {
                "controlId": "PR.AA-05",
                "questionId": "PR.AA-05-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for least-needed access, separate privileged accounts and repeated lifecycle reviews.",
            "omittedTargetScope": [
                "An explicit authorization policy, all entitlements and separation of duties are not fully required."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/7/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AA-05",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-DR-01--PR.DS-11",
            "order": 20,
            "source": {
                "controlId": "NF-NCSC-MCSS-DR-01",
                "questionId": "NF-NCSC-MCSS-DR-01-Q1"
            },
            "target": {
                "controlId": "PR.DS-11",
                "questionId": "PR.DS-11-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for backups of critical systems and data, protected copies and sampled restoration tests.",
            "omittedTargetScope": [
                "The wider data population and the full maintenance of backups are not expressly covered."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/8/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.DS-11",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-DR-01--PR.IR-03",
            "order": 21,
            "source": {
                "controlId": "NF-NCSC-MCSS-DR-01",
                "questionId": "NF-NCSC-MCSS-DR-01-Q1"
            },
            "target": {
                "controlId": "PR.IR-03",
                "questionId": "PR.IR-03-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for backups tied to defined recovery requirements and sampled restore tests.",
            "omittedTargetScope": [
                "Other resilience mechanisms and normal-operation resilience requirements are not covered."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/8/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.IR-03",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-RP-01--GV.RR-02",
            "order": 22,
            "source": {
                "controlId": "NF-NCSC-MCSS-RP-01",
                "questionId": "NF-NCSC-MCSS-RP-01-Q1"
            },
            "target": {
                "controlId": "GV.RR-02",
                "questionId": "GV.RR-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for named incident-response responsibilities and management support.",
            "omittedTargetScope": [
                "Roles and authorities outside response, and their communication, understanding and enforcement, are broader."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/9/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RR-02",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-RP-01--ID.IM-02",
            "order": 23,
            "source": {
                "controlId": "NF-NCSC-MCSS-RP-01",
                "questionId": "NF-NCSC-MCSS-RP-01-Q1"
            },
            "target": {
                "controlId": "ID.IM-02",
                "questionId": "ID.IM-02-Q1"
            },
            "relationship": "partial",
            "rationale": "The source names exercise or incident lessons as inputs to the response plan.",
            "omittedTargetScope": [
                "The source permits incident lessons alone; it does not require all security tests and exercises or supplier and third-party coordination."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/9/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.IM-02",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-RP-01--ID.IM-03",
            "order": 24,
            "source": {
                "controlId": "NF-NCSC-MCSS-RP-01",
                "questionId": "NF-NCSC-MCSS-RP-01-Q1"
            },
            "target": {
                "controlId": "ID.IM-03",
                "questionId": "ID.IM-03-Q1"
            },
            "relationship": "partial",
            "rationale": "The source names incident or exercise lessons in the response plan.",
            "omittedTargetScope": [
                "The source permits exercise lessons alone; improvements from the complete range of actual operational processes, procedures and activities are broader."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/9/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.IM-03",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "NF-NCSC-MCSS-RP-01--ID.IM-04",
            "order": 25,
            "source": {
                "controlId": "NF-NCSC-MCSS-RP-01",
                "questionId": "NF-NCSC-MCSS-RP-01-Q1"
            },
            "target": {
                "controlId": "ID.IM-04",
                "questionId": "ID.IM-04-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for a risk-based response plan, named responsibilities, contact paths and exercise or incident lessons.",
            "omittedTargetScope": [
                "Other cybersecurity plans affecting operations and explicit continuing communication and maintenance are broader."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/9/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.IM-04",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "NF-NCSC-CC-PM-01--PR.AA-01",
            "order": 26,
            "source": {
                "controlId": "NF-NCSC-CC-PM-01",
                "questionId": "NF-NCSC-CC-PM-01-Q1"
            },
            "target": {
                "controlId": "PR.AA-01",
                "questionId": "PR.AA-01-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for governed use of unique passwords and approved sharing through a password manager.",
            "omittedTargetScope": [
                "Identity and credential management beyond these password practices, including services and hardware, is broader."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/10/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AA-01",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "NF-NCSC-CC-AC-01--PR.PS-05",
            "order": 27,
            "source": {
                "controlId": "NF-NCSC-CC-AC-01",
                "questionId": "NF-NCSC-CC-AC-01-Q1"
            },
            "target": {
                "controlId": "PR.PS-05",
                "questionId": "PR.PS-05-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for restriction of unapproved or risky applications, scripts, macros and file types on high-impact systems.",
            "omittedTargetScope": [
                "Prevention of all unauthorized software installation and execution across the whole platform population is broader."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/12/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.PS-05",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "NF-NCSC-CC-NS-01--PR.IR-01",
            "order": 28,
            "source": {
                "controlId": "NF-NCSC-CC-NS-01",
                "questionId": "NF-NCSC-CC-NS-01-Q1"
            },
            "target": {
                "controlId": "PR.IR-01",
                "questionId": "PR.IR-01-Q1"
            },
            "relationship": "partial",
            "rationale": "The source asks for separation of user, guest, administrative, backup and important-service environments.",
            "omittedTargetScope": [
                "All controls against unauthorized network and environment access and usage are broader than segmentation."
            ],
            "locators": {
                "sourceQuestionPointer": "/questions/13/prompt",
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.IR-01",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.OC-01",
            "order": 29,
            "source": null,
            "target": {
                "controlId": "GV.OC-01",
                "questionId": "GV.OC-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OC-01",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.OC-02",
            "order": 30,
            "source": null,
            "target": {
                "controlId": "GV.OC-02",
                "questionId": "GV.OC-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OC-02",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.OC-03",
            "order": 31,
            "source": null,
            "target": {
                "controlId": "GV.OC-03",
                "questionId": "GV.OC-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OC-03",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.OC-04",
            "order": 32,
            "source": null,
            "target": {
                "controlId": "GV.OC-04",
                "questionId": "GV.OC-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OC-04",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.OC-05",
            "order": 33,
            "source": null,
            "target": {
                "controlId": "GV.OC-05",
                "questionId": "GV.OC-05-Q1"
            },
            "relationship": "no_match",
            "rationale": "The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OC-05",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RM-01",
            "order": 34,
            "source": null,
            "target": {
                "controlId": "GV.RM-01",
                "questionId": "GV.RM-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RM-01",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RM-04",
            "order": 35,
            "source": null,
            "target": {
                "controlId": "GV.RM-04",
                "questionId": "GV.RM-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RM-04",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RM-05",
            "order": 36,
            "source": null,
            "target": {
                "controlId": "GV.RM-05",
                "questionId": "GV.RM-05-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RM-05",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RM-06",
            "order": 37,
            "source": null,
            "target": {
                "controlId": "GV.RM-06",
                "questionId": "GV.RM-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RM-06",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RM-07",
            "order": 38,
            "source": null,
            "target": {
                "controlId": "GV.RM-07",
                "questionId": "GV.RM-07-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RM-07",
                    "pdfPage": 21
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RR-01",
            "order": 39,
            "source": null,
            "target": {
                "controlId": "GV.RR-01",
                "questionId": "GV.RR-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Named risk and response owners do not directly assess leadership accountability and culture, commensurate resources or cybersecurity across human-resources practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RR-01",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RR-03",
            "order": 40,
            "source": null,
            "target": {
                "controlId": "GV.RR-03",
                "questionId": "GV.RR-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Named risk and response owners do not directly assess leadership accountability and culture, commensurate resources or cybersecurity across human-resources practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RR-03",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.RR-04",
            "order": 41,
            "source": null,
            "target": {
                "controlId": "GV.RR-04",
                "questionId": "GV.RR-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Named risk and response owners do not directly assess leadership accountability and culture, commensurate resources or cybersecurity across human-resources practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.RR-04",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.PO-01",
            "order": 42,
            "source": null,
            "target": {
                "controlId": "GV.PO-01",
                "questionId": "GV.PO-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "A risk process or secure baseline does not directly ask for the organization-wide cybersecurity policy lifecycle and enforcement described here. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.PO-01",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.PO-02",
            "order": 43,
            "source": null,
            "target": {
                "controlId": "GV.PO-02",
                "questionId": "GV.PO-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "A risk process or secure baseline does not directly ask for the organization-wide cybersecurity policy lifecycle and enforcement described here. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.PO-02",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.OV-01",
            "order": 44,
            "source": null,
            "target": {
                "controlId": "GV.OV-01",
                "questionId": "GV.OV-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Regular risk-process review and security-guidance reporting do not directly ask for strategy-outcome review or organization-wide cybersecurity performance evaluation. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OV-01",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.OV-03",
            "order": 45,
            "source": null,
            "target": {
                "controlId": "GV.OV-03",
                "questionId": "GV.OV-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Regular risk-process review and security-guidance reporting do not directly ask for strategy-outcome review or organization-wide cybersecurity performance evaluation. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.OV-03",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-01",
            "order": 46,
            "source": null,
            "target": {
                "controlId": "GV.SC-01",
                "questionId": "GV.SC-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-01",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-02",
            "order": 47,
            "source": null,
            "target": {
                "controlId": "GV.SC-02",
                "questionId": "GV.SC-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-02",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-03",
            "order": 48,
            "source": null,
            "target": {
                "controlId": "GV.SC-03",
                "questionId": "GV.SC-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-03",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-04",
            "order": 49,
            "source": null,
            "target": {
                "controlId": "GV.SC-04",
                "questionId": "GV.SC-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-04",
                    "pdfPage": 22
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-05",
            "order": 50,
            "source": null,
            "target": {
                "controlId": "GV.SC-05",
                "questionId": "GV.SC-05-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-05",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-06",
            "order": 51,
            "source": null,
            "target": {
                "controlId": "GV.SC-06",
                "questionId": "GV.SC-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-06",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-07",
            "order": 52,
            "source": null,
            "target": {
                "controlId": "GV.SC-07",
                "questionId": "GV.SC-07-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-07",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-08",
            "order": 53,
            "source": null,
            "target": {
                "controlId": "GV.SC-08",
                "questionId": "GV.SC-08-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-08",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-09",
            "order": 54,
            "source": null,
            "target": {
                "controlId": "GV.SC-09",
                "questionId": "GV.SC-09-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-09",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--GV.SC-10",
            "order": 55,
            "source": null,
            "target": {
                "controlId": "GV.SC-10",
                "questionId": "GV.SC-10-Q1"
            },
            "relationship": "no_match",
            "rationale": "The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "GV.SC-10",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.AM-03",
            "order": 56,
            "source": null,
            "target": {
                "controlId": "ID.AM-03",
                "questionId": "ID.AM-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Inventory and network separation do not explicitly require documented authorized data-flow representations, a supplier-service inventory or the stated multi-criterion asset prioritization; cloud services are not necessarily supplier-provided. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.AM-03",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.AM-04",
            "order": 57,
            "source": null,
            "target": {
                "controlId": "ID.AM-04",
                "questionId": "ID.AM-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Inventory and network separation do not explicitly require documented authorized data-flow representations, a supplier-service inventory or the stated multi-criterion asset prioritization; cloud services are not necessarily supplier-provided. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.AM-04",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.AM-05",
            "order": 58,
            "source": null,
            "target": {
                "controlId": "ID.AM-05",
                "questionId": "ID.AM-05-Q1"
            },
            "relationship": "no_match",
            "rationale": "Inventory and network separation do not explicitly require documented authorized data-flow representations, a supplier-service inventory or the stated multi-criterion asset prioritization; cloud services are not necessarily supplier-provided. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.AM-05",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-01",
            "order": 59,
            "source": null,
            "target": {
                "controlId": "ID.RA-01",
                "questionId": "ID.RA-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-01",
                    "pdfPage": 23
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-02",
            "order": 60,
            "source": null,
            "target": {
                "controlId": "ID.RA-02",
                "questionId": "ID.RA-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-02",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-03",
            "order": 61,
            "source": null,
            "target": {
                "controlId": "ID.RA-03",
                "questionId": "ID.RA-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-03",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-04",
            "order": 62,
            "source": null,
            "target": {
                "controlId": "ID.RA-04",
                "questionId": "ID.RA-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-04",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-05",
            "order": 63,
            "source": null,
            "target": {
                "controlId": "ID.RA-05",
                "questionId": "ID.RA-05-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-05",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-06",
            "order": 64,
            "source": null,
            "target": {
                "controlId": "ID.RA-06",
                "questionId": "ID.RA-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-06",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-08",
            "order": 65,
            "source": null,
            "target": {
                "controlId": "ID.RA-08",
                "questionId": "ID.RA-08-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-08",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-09",
            "order": 66,
            "source": null,
            "target": {
                "controlId": "ID.RA-09",
                "questionId": "ID.RA-09-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-09",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.RA-10",
            "order": 67,
            "source": null,
            "target": {
                "controlId": "ID.RA-10",
                "questionId": "ID.RA-10-Q1"
            },
            "relationship": "no_match",
            "rationale": "Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.RA-10",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--ID.IM-01",
            "order": 68,
            "source": null,
            "target": {
                "controlId": "ID.IM-01",
                "questionId": "ID.IM-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Exercise and incident lessons are linked separately; no source prompt expressly asks for improvements identified from evaluations as a general practice. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "ID.IM-01",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.AA-02",
            "order": 69,
            "source": null,
            "target": {
                "controlId": "PR.AA-02",
                "questionId": "PR.AA-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "Trusted verification of sensitive changes is narrower than identity proofing and binding to credentials; the prompts also do not directly assess protected identity assertions or physical access management. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AA-02",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.AA-04",
            "order": 70,
            "source": null,
            "target": {
                "controlId": "PR.AA-04",
                "questionId": "PR.AA-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Trusted verification of sensitive changes is narrower than identity proofing and binding to credentials; the prompts also do not directly assess protected identity assertions or physical access management. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AA-04",
                    "pdfPage": 24
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.AA-06",
            "order": 71,
            "source": null,
            "target": {
                "controlId": "PR.AA-06",
                "questionId": "PR.AA-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "Trusted verification of sensitive changes is narrower than identity proofing and binding to credentials; the prompts also do not directly assess protected identity assertions or physical access management. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.AA-06",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.DS-01",
            "order": 72,
            "source": null,
            "target": {
                "controlId": "PR.DS-01",
                "questionId": "PR.DS-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup protection does not establish the distinct confidentiality, integrity and availability outcomes for data at rest, in transit or in use. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.DS-01",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.DS-02",
            "order": 73,
            "source": null,
            "target": {
                "controlId": "PR.DS-02",
                "questionId": "PR.DS-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup protection does not establish the distinct confidentiality, integrity and availability outcomes for data at rest, in transit or in use. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.DS-02",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.DS-10",
            "order": 74,
            "source": null,
            "target": {
                "controlId": "PR.DS-10",
                "questionId": "PR.DS-10-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup protection does not establish the distinct confidentiality, integrity and availability outcomes for data at rest, in transit or in use. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.DS-10",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.PS-03",
            "order": 75,
            "source": null,
            "target": {
                "controlId": "PR.PS-03",
                "questionId": "PR.PS-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Asset lifecycle status and patch retirement do not directly assess risk-based hardware replacement/removal or secure software-development lifecycle practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.PS-03",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.PS-06",
            "order": 76,
            "source": null,
            "target": {
                "controlId": "PR.PS-06",
                "questionId": "PR.PS-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "Asset lifecycle status and patch retirement do not directly assess risk-based hardware replacement/removal or secure software-development lifecycle practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.PS-06",
                    "pdfPage": 25
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.IR-02",
            "order": 77,
            "source": null,
            "target": {
                "controlId": "PR.IR-02",
                "questionId": "PR.IR-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "Recovery backups and segmentation do not directly assess environmental-threat protection or resource-capacity maintenance. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.IR-02",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--PR.IR-04",
            "order": 78,
            "source": null,
            "target": {
                "controlId": "PR.IR-04",
                "questionId": "PR.IR-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Recovery backups and segmentation do not directly assess environmental-threat protection or resource-capacity maintenance. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "PR.IR-04",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.CM-01",
            "order": 79,
            "source": null,
            "target": {
                "controlId": "DE.CM-01",
                "questionId": "DE.CM-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.CM-01",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.CM-02",
            "order": 80,
            "source": null,
            "target": {
                "controlId": "DE.CM-02",
                "questionId": "DE.CM-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.CM-02",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.CM-03",
            "order": 81,
            "source": null,
            "target": {
                "controlId": "DE.CM-03",
                "questionId": "DE.CM-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.CM-03",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.CM-06",
            "order": 82,
            "source": null,
            "target": {
                "controlId": "DE.CM-06",
                "questionId": "DE.CM-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.CM-06",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.AE-03",
            "order": 83,
            "source": null,
            "target": {
                "controlId": "DE.AE-03",
                "questionId": "DE.AE-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.AE-03",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.AE-04",
            "order": 84,
            "source": null,
            "target": {
                "controlId": "DE.AE-04",
                "questionId": "DE.AE-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.AE-04",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.AE-06",
            "order": 85,
            "source": null,
            "target": {
                "controlId": "DE.AE-06",
                "questionId": "DE.AE-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.AE-06",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.AE-07",
            "order": 86,
            "source": null,
            "target": {
                "controlId": "DE.AE-07",
                "questionId": "DE.AE-07-Q1"
            },
            "relationship": "no_match",
            "rationale": "Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.AE-07",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--DE.AE-08",
            "order": 87,
            "source": null,
            "target": {
                "controlId": "DE.AE-08",
                "questionId": "DE.AE-08-Q1"
            },
            "relationship": "no_match",
            "rationale": "Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "DE.AE-08",
                    "pdfPage": 26
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.MA-01",
            "order": 88,
            "source": null,
            "target": {
                "controlId": "RS.MA-01",
                "questionId": "RS.MA-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.MA-01",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.MA-02",
            "order": 89,
            "source": null,
            "target": {
                "controlId": "RS.MA-02",
                "questionId": "RS.MA-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.MA-02",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.MA-03",
            "order": 90,
            "source": null,
            "target": {
                "controlId": "RS.MA-03",
                "questionId": "RS.MA-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.MA-03",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.MA-04",
            "order": 91,
            "source": null,
            "target": {
                "controlId": "RS.MA-04",
                "questionId": "RS.MA-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.MA-04",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.MA-05",
            "order": 92,
            "source": null,
            "target": {
                "controlId": "RS.MA-05",
                "questionId": "RS.MA-05-Q1"
            },
            "relationship": "no_match",
            "rationale": "Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.MA-05",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.AN-03",
            "order": 93,
            "source": null,
            "target": {
                "controlId": "RS.AN-03",
                "questionId": "RS.AN-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.AN-03",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.AN-06",
            "order": 94,
            "source": null,
            "target": {
                "controlId": "RS.AN-06",
                "questionId": "RS.AN-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.AN-06",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.AN-07",
            "order": 95,
            "source": null,
            "target": {
                "controlId": "RS.AN-07",
                "questionId": "RS.AN-07-Q1"
            },
            "relationship": "no_match",
            "rationale": "Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.AN-07",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.AN-08",
            "order": 96,
            "source": null,
            "target": {
                "controlId": "RS.AN-08",
                "questionId": "RS.AN-08-Q1"
            },
            "relationship": "no_match",
            "rationale": "Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.AN-08",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.CO-02",
            "order": 97,
            "source": null,
            "target": {
                "controlId": "RS.CO-02",
                "questionId": "RS.CO-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "A response-plan contact path does not directly assess actual incident notification or sharing with designated stakeholders. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.CO-02",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.CO-03",
            "order": 98,
            "source": null,
            "target": {
                "controlId": "RS.CO-03",
                "questionId": "RS.CO-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "A response-plan contact path does not directly assess actual incident notification or sharing with designated stakeholders. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.CO-03",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.MI-01",
            "order": 99,
            "source": null,
            "target": {
                "controlId": "RS.MI-01",
                "questionId": "RS.MI-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Response planning and preventive segmentation do not directly assess actual incident containment or eradication. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.MI-01",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RS.MI-02",
            "order": 100,
            "source": null,
            "target": {
                "controlId": "RS.MI-02",
                "questionId": "RS.MI-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "Response planning and preventive segmentation do not directly assess actual incident containment or eradication. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RS.MI-02",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.RP-01",
            "order": 101,
            "source": null,
            "target": {
                "controlId": "RC.RP-01",
                "questionId": "RC.RP-01-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.RP-01",
                    "pdfPage": 27
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.RP-02",
            "order": 102,
            "source": null,
            "target": {
                "controlId": "RC.RP-02",
                "questionId": "RC.RP-02-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.RP-02",
                    "pdfPage": 28
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.RP-03",
            "order": 103,
            "source": null,
            "target": {
                "controlId": "RC.RP-03",
                "questionId": "RC.RP-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.RP-03",
                    "pdfPage": 28
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.RP-04",
            "order": 104,
            "source": null,
            "target": {
                "controlId": "RC.RP-04",
                "questionId": "RC.RP-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.RP-04",
                    "pdfPage": 28
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.RP-05",
            "order": 105,
            "source": null,
            "target": {
                "controlId": "RC.RP-05",
                "questionId": "RC.RP-05-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.RP-05",
                    "pdfPage": 28
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.RP-06",
            "order": 106,
            "source": null,
            "target": {
                "controlId": "RC.RP-06",
                "questionId": "RC.RP-06-Q1"
            },
            "relationship": "no_match",
            "rationale": "Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.RP-06",
                    "pdfPage": 28
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.CO-03",
            "order": 107,
            "source": null,
            "target": {
                "controlId": "RC.CO-03",
                "questionId": "RC.CO-03-Q1"
            },
            "relationship": "no_match",
            "rationale": "Response-plan contacts do not directly assess communication of actual recovery progress or approved public recovery updates. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.CO-03",
                    "pdfPage": 28
                }
            }
        },
        {
            "id": "ALL-NCSC14--RC.CO-04",
            "order": 108,
            "source": null,
            "target": {
                "controlId": "RC.CO-04",
                "questionId": "RC.CO-04-Q1"
            },
            "relationship": "no_match",
            "rationale": "Response-plan contacts do not directly assess communication of actual recovery progress or approved public recovery updates. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": null,
                "targetReference": {
                    "sourceId": "nist-cswp-29-final-2024-02-26",
                    "referenceId": "RC.CO-04",
                    "pdfPage": 28
                }
            }
        },
        {
            "id": "NF-NCSC-CC-SV-01--ALL-NIST106",
            "order": 109,
            "source": {
                "controlId": "NF-NCSC-CC-SV-01",
                "questionId": "NF-NCSC-CC-SV-01-Q1"
            },
            "target": null,
            "relationship": "no_match",
            "rationale": "Independent verification of sensitive changes is useful, but this concise prompt does not expressly require the full identity-proofing and credential-binding activity of PR.AA-02 or another selected Core outcome. No direct mapping is asserted after review of all 106 outcomes.",
            "omittedTargetScope": [],
            "locators": {
                "sourceQuestionPointer": "/questions/11/prompt",
                "targetReference": null
            }
        }
    ],
    "crosswalkSha256": "61f68fba7bfd3ce9480a0db5f6e4d297bdcf1aff63e80073bffd27dc2abf1e17"
};

module.exports = { createNistNcscCrosswalk, NistNcscCrosswalkError };
