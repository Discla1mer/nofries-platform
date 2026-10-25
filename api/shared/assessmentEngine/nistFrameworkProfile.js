'use strict';

const crypto = require('crypto');
const {
    calculateFrameworkProfileSha256,
    publishFrameworkProfile
} = require('./frameworkProfileRegistry');

const EXPECTED_SOURCE_SHA256 = 'ab75b51c3561c50cb48cd21b96c01afa2aecafb2efc6b46ae4a8ef8cd753a656';
const EXPECTED_PROFILE_SHA256 = 'ec394a65b11417b67201f96af57a7eabeb284376bb0651b816b40017476b6073';
const SOURCE_ID = 'nist-cswp-29-final-2024-02-26';

class NistFrameworkProfileError extends Error {
    constructor(code) {
        super(`NIST framework profile construction failed (${code})`);
        this.name = 'NistFrameworkProfileError';
        this.code = code;
    }
}

// These zero-argument publications have no registry, runtime or network side effect.
function createNistFrameworkProfile() {
    try {
        const definition = buildDefinition();
        const seed = { ...clone(SOURCE_SEED_BASE), definition };
        const sourceDigest = digest(seed);
        if (sourceDigest !== EXPECTED_SOURCE_SHA256) {
            throw new NistFrameworkProfileError('nist_source_digest_mismatch');
        }
        definition.sourceCatalogueSha256 = sourceDigest;
        const profileDigest = calculateFrameworkProfileSha256(definition);
        if (profileDigest !== EXPECTED_PROFILE_SHA256) {
            throw new NistFrameworkProfileError('nist_profile_digest_mismatch');
        }
        definition.catalogueSha256 = profileDigest;
        return publishFrameworkProfile(definition);
    } catch (error) {
        if (error instanceof NistFrameworkProfileError) throw error;
        throw new NistFrameworkProfileError('nist_profile_invalid');
    }
}

function buildDefinition() {
    const definition = clone(PROFILE_BASE);
    definition.controls = [];
    definition.questions = [];
    CORE_OUTCOMES.forEach(([id, outcome], index) => {
        const category = SOURCE_SEED_BASE.categoryTitles[id.split('-')[0]];
        const summary = `No Fries assessment of ${id} (${category}). Assess the complete outcome; linked NCSC references do not establish achievement.`;
        definition.controls.push({
            id,
            domainId: id.slice(0, 2),
            order: index + 1,
            title: outcome,
            guidance: { summary, ...clone(GUIDANCE_BASE) },
            sourceIds: [SOURCE_ID],
            sourceReferences: [{ sourceId: SOURCE_ID, referenceId: id, order: 1 }]
        });
        definition.questions.push({
            id: `${id}-Q1`,
            controlId: id,
            order: 1,
            prompt: `Within the declared assessment scope, how fully is this outcome achieved? ${outcome}`,
            guidance: { summary, ...clone(GUIDANCE_BASE) },
            weight: 1,
            responseOptionIds: ['yes', 'partial', 'no', 'unknown', 'not_applicable'],
            sourceIds: [SOURCE_ID]
        });
    });
    return definition;
}

// Only fixed authored JSON reaches these private helpers; there is no import API.
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function digest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// Reviewed NIST CSWP 29 final (2024-02-26). Raw source and editorial content are
// independently pinned; this seed never includes the separate crosswalk.
const SOURCE_SEED_BASE = {
    "schemaVersion": 1,
    "kind": "no-fries-nist-profile-source-seed-v1",
    "sourceEvidence": {
        "nist-cswp-29.pdf": {
            "url": "https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf",
            "retrievedAt": "2026-09-08T04:01:09.112403+00:00",
            "bytes": 1518858,
            "sha256": "3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c"
        },
        "nist-reuse-terms.html": {
            "url": "https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications",
            "retrievedAt": "2026-09-08T04:01:15.220536+00:00",
            "bytes": 64706,
            "sha256": "a6de990069c7d522965b97926b58f78d5c1f7d9013fec53d55f29344aa97da18"
        },
        "nist-disclaimers.html": {
            "url": "https://www.nist.gov/copyrights-disclaimers",
            "retrievedAt": "2026-09-08T04:01:20.554965+00:00",
            "bytes": 79183,
            "sha256": "62236b9e26227697c0bfc8f3c0259f5b34e42e18f0589f8dcab78ab33f8febb3"
        },
        "nist-cswp-29-publication.html": {
            "url": "https://csrc.nist.gov/pubs/cswp/29/the-nist-cybersecurity-framework-csf-20/final",
            "retrievedAt": "2026-09-08T04:01:25.064258+00:00",
            "bytes": 46856,
            "sha256": "e707a9e430e5cd4c5b387084be16d911840f9252a3feea9933097ea41c9c79cf"
        }
    },
    "outcomeTranscriptionSha256": "d74aec7af57ae8fc7f78b55df698a316cb0bec911b6e3af3a8967c21ad2e4e4c",
    "functionOrder": [
        "GV",
        "ID",
        "PR",
        "DE",
        "RS",
        "RC"
    ],
    "categoryTitles": {
        "GV.OC": "Organizational Context",
        "GV.RM": "Risk Management Strategy",
        "GV.RR": "Roles, Responsibilities, and Authorities",
        "GV.PO": "Policy",
        "GV.OV": "Oversight",
        "GV.SC": "Cybersecurity Supply Chain Risk Management",
        "ID.AM": "Asset Management",
        "ID.RA": "Risk Assessment",
        "ID.IM": "Improvement",
        "PR.AA": "Identity Management, Authentication, and Access Control",
        "PR.AT": "Awareness and Training",
        "PR.DS": "Data Security",
        "PR.PS": "Platform Security",
        "PR.IR": "Technology Infrastructure Resilience",
        "DE.CM": "Continuous Monitoring",
        "DE.AE": "Adverse Event Analysis",
        "RS.MA": "Incident Management",
        "RS.AN": "Incident Analysis",
        "RS.CO": "Incident Response Reporting and Communication",
        "RS.MI": "Incident Mitigation",
        "RC.RP": "Incident Recovery Plan Execution",
        "RC.CO": "Incident Recovery Communication"
    }
};

const PROFILE_BASE = {
    "schemaVersion": 1,
    "status": "published",
    "publishedAt": "2026-09-08",
    "framework": {
        "id": "nist-cybersecurity-framework",
        "version": "2.0",
        "title": "NIST Cybersecurity Framework (CSF) 2.0",
        "authority": "National Institute of Standards and Technology",
        "description": "The six functions and complete subcategory outcome set of the final NIST CSWP 29 CSF 2.0 Core.",
        "sourceIds": [
            "nist-cswp-29-final-2024-02-26"
        ]
    },
    "profile": {
        "id": "nf-nist-csf-2-0-core",
        "version": "2026-09-08.1",
        "title": "No Fries implementation assessment of NIST CSF 2.0 Core outcomes",
        "description": "One No Fries assessment question per CSF 2.0 subcategory outcome, with equal outcome weights. This assessment definition is not an organization-specific NIST Current or Target Profile.",
        "effectiveFrom": "2026-09-08",
        "sourceIds": [
            "nist-cswp-29-final-2024-02-26"
        ]
    },
    "statements": {
        "attribution": "National Institute of Standards and Technology (2024) The NIST Cybersecurity Framework (CSF) 2.0. (National Institute of Standards and Technology, Gaithersburg, MD), NIST Cybersecurity White Paper (CSWP) NIST CSWP 29. https://doi.org/10.6028/NIST.CSWP.29. Republished courtesy of the National Institute of Standards and Technology. No Fries Limited, 2026-09-08: selected the complete CSF 2.0 Core, joined PDF line wrapping, and authored assessment prompts, evidence guidance, identifiers for questions, equal outcome weights, response labels and separate editorial crosswalks. The NIST outcome text and subcategory identifiers are retained. No NIST endorsement is implied.",
        "basis": "Final NIST CSWP 29, February 26, 2024, Appendix A. Native NIST outcome questions are authored independently of the NCSC reference crosswalk.",
        "claim": "A deterministic No Fries implementation assessment of declared-scope CSF 2.0 outcomes; no official NIST score, Tier, certification, endorsement, compliance determination or breach-likelihood claim.",
        "limitations": [
            "NIST CSF 2.0 defines outcomes and does not prescribe these questions, evidence examples, response factors or weights.",
            "One question represents each of the 106 subcategory outcomes; equal question weights give functions different total weights according to their number of outcomes.",
            "The assessment is not a NIST Organizational Current or Target Profile and does not determine a CSF Implementation Tier.",
            "A broad outcome can contain multiple subjects and actions; a Yes answer asserts the whole stated outcome within the declared scope, not one example.",
            "Partial means some but not all of the outcome is achieved; the generic 0.5 factor is a No Fries scoring convention and is not a literal percentage of NIST requirements.",
            "Unknown and Not applicable retain the existing No Fries evaluator semantics; a crosswalk never approves applicability or supplies an answer.",
            "Every assessment must state its population, systems, services and relevant assessment period.",
            "The separate NCSC crosswalk is editorial reference coverage only; it neither transfers answers or evidence states nor implies complete NIST outcome achievement.",
            "No combined NCSC and NIST attainment total or shared-control denominator is defined.",
            "Only NIST-authored Core text is reused. Logos, imagery, third-party Informative References, other standards and separately updated Implementation Examples are excluded.",
            "NIST Technical Series reprint terms, recommended citation and acknowledgement apply; no NIST endorsement is implied.",
            "Source files, publication date, retrieval date, raw byte digest and No Fries publication date are distinct provenance facts."
        ]
    },
    "sources": [
        {
            "id": "nist-cswp-29-final-2024-02-26",
            "title": "The NIST Cybersecurity Framework (CSF) 2.0 — final NIST CSWP 29",
            "url": "https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf",
            "authority": "National Institute of Standards and Technology",
            "version": "CSWP-29-final-2024-02-26",
            "publishedAt": "2024-02-26",
            "lastVerifiedAt": "2026-09-08",
            "rightsStatus": "verified",
            "licence": "NIST Technical Series Publications reprint terms (U.S. government work; worldwide reprint and derivative-work permission)",
            "licenceUrl": "https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications",
            "reviewDueAt": "2027-09-02",
            "reviewCadence": "annual"
        }
    ],
    "domains": [
        {
            "id": "GV",
            "order": 1,
            "title": "Govern",
            "guidance": {
                "summary": "The organization’s cybersecurity risk management strategy, expectations, and policy are established, communicated, and monitored",
                "evidenceExamples": [
                    "A dated policy, procedure or system configuration addressing the complete outcome in the declared scope.",
                    "Dated operational samples or exercise results showing the practice operating across the declared population.",
                    "A named owner and current record of exceptions and remaining gaps."
                ],
                "startingActions": [
                    "Record the systems, services, people and period covered by this answer.",
                    "Compare current practice with every subject, action and condition in the outcome; record what is missing.",
                    "Assign an owner and review date to the next improvement and retain the supporting evidence references."
                ]
            },
            "sourceIds": [
                "nist-cswp-29-final-2024-02-26"
            ]
        },
        {
            "id": "ID",
            "order": 2,
            "title": "Identify",
            "guidance": {
                "summary": "The organization’s current cybersecurity risks are understood",
                "evidenceExamples": [
                    "A dated policy, procedure or system configuration addressing the complete outcome in the declared scope.",
                    "Dated operational samples or exercise results showing the practice operating across the declared population.",
                    "A named owner and current record of exceptions and remaining gaps."
                ],
                "startingActions": [
                    "Record the systems, services, people and period covered by this answer.",
                    "Compare current practice with every subject, action and condition in the outcome; record what is missing.",
                    "Assign an owner and review date to the next improvement and retain the supporting evidence references."
                ]
            },
            "sourceIds": [
                "nist-cswp-29-final-2024-02-26"
            ]
        },
        {
            "id": "PR",
            "order": 3,
            "title": "Protect",
            "guidance": {
                "summary": "Safeguards to manage the organization’s cybersecurity risks are used",
                "evidenceExamples": [
                    "A dated policy, procedure or system configuration addressing the complete outcome in the declared scope.",
                    "Dated operational samples or exercise results showing the practice operating across the declared population.",
                    "A named owner and current record of exceptions and remaining gaps."
                ],
                "startingActions": [
                    "Record the systems, services, people and period covered by this answer.",
                    "Compare current practice with every subject, action and condition in the outcome; record what is missing.",
                    "Assign an owner and review date to the next improvement and retain the supporting evidence references."
                ]
            },
            "sourceIds": [
                "nist-cswp-29-final-2024-02-26"
            ]
        },
        {
            "id": "DE",
            "order": 4,
            "title": "Detect",
            "guidance": {
                "summary": "Possible cybersecurity attacks and compromises are found and analyzed",
                "evidenceExamples": [
                    "A dated policy, procedure or system configuration addressing the complete outcome in the declared scope.",
                    "Dated operational samples or exercise results showing the practice operating across the declared population.",
                    "A named owner and current record of exceptions and remaining gaps."
                ],
                "startingActions": [
                    "Record the systems, services, people and period covered by this answer.",
                    "Compare current practice with every subject, action and condition in the outcome; record what is missing.",
                    "Assign an owner and review date to the next improvement and retain the supporting evidence references."
                ]
            },
            "sourceIds": [
                "nist-cswp-29-final-2024-02-26"
            ]
        },
        {
            "id": "RS",
            "order": 5,
            "title": "Respond",
            "guidance": {
                "summary": "Actions regarding a detected cybersecurity incident are taken",
                "evidenceExamples": [
                    "A dated policy, procedure or system configuration addressing the complete outcome in the declared scope.",
                    "Dated operational samples or exercise results showing the practice operating across the declared population.",
                    "A named owner and current record of exceptions and remaining gaps."
                ],
                "startingActions": [
                    "Record the systems, services, people and period covered by this answer.",
                    "Compare current practice with every subject, action and condition in the outcome; record what is missing.",
                    "Assign an owner and review date to the next improvement and retain the supporting evidence references."
                ]
            },
            "sourceIds": [
                "nist-cswp-29-final-2024-02-26"
            ]
        },
        {
            "id": "RC",
            "order": 6,
            "title": "Recover",
            "guidance": {
                "summary": "Assets and operations affected by a cybersecurity incident are restored",
                "evidenceExamples": [
                    "A dated policy, procedure or system configuration addressing the complete outcome in the declared scope.",
                    "Dated operational samples or exercise results showing the practice operating across the declared population.",
                    "A named owner and current record of exceptions and remaining gaps."
                ],
                "startingActions": [
                    "Record the systems, services, people and period covered by this answer.",
                    "Compare current practice with every subject, action and condition in the outcome; record what is missing.",
                    "Assign an owner and review date to the next improvement and retain the supporting evidence references."
                ]
            },
            "sourceIds": [
                "nist-cswp-29-final-2024-02-26"
            ]
        }
    ],
    "responseOptions": [
        {
            "id": "yes",
            "label": "Yes",
            "applicable": true,
            "implementationFactor": 1
        },
        {
            "id": "partial",
            "label": "Partial",
            "applicable": true,
            "implementationFactor": 0.5
        },
        {
            "id": "no",
            "label": "No",
            "applicable": true,
            "implementationFactor": 0
        },
        {
            "id": "unknown",
            "label": "Unknown",
            "applicable": true,
            "implementationFactor": null
        },
        {
            "id": "not_applicable",
            "label": "Not applicable",
            "applicable": false,
            "implementationFactor": null
        }
    ]
};

const GUIDANCE_BASE = {
    "evidenceExamples": [
        "A dated policy, procedure or system configuration addressing the complete outcome in the declared scope.",
        "Dated operational samples or exercise results showing the practice operating across the declared population.",
        "A named owner and current record of exceptions and remaining gaps."
    ],
    "startingActions": [
        "Record the systems, services, people and period covered by this answer.",
        "Compare current practice with every subject, action and condition in the outcome; record what is missing.",
        "Assign an owner and review date to the next improvement and retain the supporting evidence references."
    ]
};

const CORE_OUTCOMES = [
    [
        "GV.OC-01",
        "The organizational mission is understood and informs cybersecurity risk management"
    ],
    [
        "GV.OC-02",
        "Internal and external stakeholders are understood, and their needs and expectations regarding cybersecurity risk management are understood and considered"
    ],
    [
        "GV.OC-03",
        "Legal, regulatory, and contractual requirements regarding cybersecurity — including privacy and civil liberties obligations — are understood and managed"
    ],
    [
        "GV.OC-04",
        "Critical objectives, capabilities, and services that external stakeholders depend on or expect from the organization are understood and communicated"
    ],
    [
        "GV.OC-05",
        "Outcomes, capabilities, and services that the organization depends on are understood and communicated"
    ],
    [
        "GV.RM-01",
        "Risk management objectives are established and agreed to by organizational stakeholders"
    ],
    [
        "GV.RM-02",
        "Risk appetite and risk tolerance statements are established, communicated, and maintained"
    ],
    [
        "GV.RM-03",
        "Cybersecurity risk management activities and outcomes are included in enterprise risk management processes"
    ],
    [
        "GV.RM-04",
        "Strategic direction that describes appropriate risk response options is established and communicated"
    ],
    [
        "GV.RM-05",
        "Lines of communication across the organization are established for cybersecurity risks, including risks from suppliers and other third parties"
    ],
    [
        "GV.RM-06",
        "A standardized method for calculating, documenting, categorizing, and prioritizing cybersecurity risks is established and communicated"
    ],
    [
        "GV.RM-07",
        "Strategic opportunities (i.e., positive risks) are characterized and are included in organizational cybersecurity risk discussions"
    ],
    [
        "GV.RR-01",
        "Organizational leadership is responsible and accountable for cybersecurity risk and fosters a culture that is risk-aware, ethical, and continually improving"
    ],
    [
        "GV.RR-02",
        "Roles, responsibilities, and authorities related to cybersecurity risk management are established, communicated, understood, and enforced"
    ],
    [
        "GV.RR-03",
        "Adequate resources are allocated commensurate with the cybersecurity risk strategy, roles, responsibilities, and policies"
    ],
    [
        "GV.RR-04",
        "Cybersecurity is included in human resources practices"
    ],
    [
        "GV.PO-01",
        "Policy for managing cybersecurity risks is established based on organizational context, cybersecurity strategy, and priorities and is communicated and enforced"
    ],
    [
        "GV.PO-02",
        "Policy for managing cybersecurity risks is reviewed, updated, communicated, and enforced to reflect changes in requirements, threats, technology, and organizational mission"
    ],
    [
        "GV.OV-01",
        "Cybersecurity risk management strategy outcomes are reviewed to inform and adjust strategy and direction"
    ],
    [
        "GV.OV-02",
        "The cybersecurity risk management strategy is reviewed and adjusted to ensure coverage of organizational requirements and risks"
    ],
    [
        "GV.OV-03",
        "Organizational cybersecurity risk management performance is evaluated and reviewed for adjustments needed"
    ],
    [
        "GV.SC-01",
        "A cybersecurity supply chain risk management program, strategy, objectives, policies, and processes are established and agreed to by organizational stakeholders"
    ],
    [
        "GV.SC-02",
        "Cybersecurity roles and responsibilities for suppliers, customers, and partners are established, communicated, and coordinated internally and externally"
    ],
    [
        "GV.SC-03",
        "Cybersecurity supply chain risk management is integrated into cybersecurity and enterprise risk management, risk assessment, and improvement processes"
    ],
    [
        "GV.SC-04",
        "Suppliers are known and prioritized by criticality"
    ],
    [
        "GV.SC-05",
        "Requirements to address cybersecurity risks in supply chains are established, prioritized, and integrated into contracts and other types of agreements with suppliers and other relevant third parties"
    ],
    [
        "GV.SC-06",
        "Planning and due diligence are performed to reduce risks before entering into formal supplier or other third-party relationships"
    ],
    [
        "GV.SC-07",
        "The risks posed by a supplier, their products and services, and other third parties are understood, recorded, prioritized, assessed, responded to, and monitored over the course of the relationship"
    ],
    [
        "GV.SC-08",
        "Relevant suppliers and other third parties are included in incident planning, response, and recovery activities"
    ],
    [
        "GV.SC-09",
        "Supply chain security practices are integrated into cybersecurity and enterprise risk management programs, and their performance is monitored throughout the technology product and service life cycle"
    ],
    [
        "GV.SC-10",
        "Cybersecurity supply chain risk management plans include provisions for activities that occur after the conclusion of a partnership or service agreement"
    ],
    [
        "ID.AM-01",
        "Inventories of hardware managed by the organization are maintained"
    ],
    [
        "ID.AM-02",
        "Inventories of software, services, and systems managed by the organization are maintained"
    ],
    [
        "ID.AM-03",
        "Representations of the organization’s authorized network communication and internal and external network data flows are maintained"
    ],
    [
        "ID.AM-04",
        "Inventories of services provided by suppliers are maintained"
    ],
    [
        "ID.AM-05",
        "Assets are prioritized based on classification, criticality, resources, and impact on the mission"
    ],
    [
        "ID.AM-07",
        "Inventories of data and corresponding metadata for designated data types are maintained"
    ],
    [
        "ID.AM-08",
        "Systems, hardware, software, services, and data are managed throughout their life cycles"
    ],
    [
        "ID.RA-01",
        "Vulnerabilities in assets are identified, validated, and recorded"
    ],
    [
        "ID.RA-02",
        "Cyber threat intelligence is received from information sharing forums and sources"
    ],
    [
        "ID.RA-03",
        "Internal and external threats to the organization are identified and recorded"
    ],
    [
        "ID.RA-04",
        "Potential impacts and likelihoods of threats exploiting vulnerabilities are identified and recorded"
    ],
    [
        "ID.RA-05",
        "Threats, vulnerabilities, likelihoods, and impacts are used to understand inherent risk and inform risk response prioritization"
    ],
    [
        "ID.RA-06",
        "Risk responses are chosen, prioritized, planned, tracked, and communicated"
    ],
    [
        "ID.RA-07",
        "Changes and exceptions are managed, assessed for risk impact, recorded, and tracked"
    ],
    [
        "ID.RA-08",
        "Processes for receiving, analyzing, and responding to vulnerability disclosures are established"
    ],
    [
        "ID.RA-09",
        "The authenticity and integrity of hardware and software are assessed prior to acquisition and use"
    ],
    [
        "ID.RA-10",
        "Critical suppliers are assessed prior to acquisition"
    ],
    [
        "ID.IM-01",
        "Improvements are identified from evaluations"
    ],
    [
        "ID.IM-02",
        "Improvements are identified from security tests and exercises, including those done in coordination with suppliers and relevant third parties"
    ],
    [
        "ID.IM-03",
        "Improvements are identified from execution of operational processes, procedures, and activities"
    ],
    [
        "ID.IM-04",
        "Incident response plans and other cybersecurity plans that affect operations are established, communicated, maintained, and improved"
    ],
    [
        "PR.AA-01",
        "Identities and credentials for authorized users, services, and hardware are managed by the organization"
    ],
    [
        "PR.AA-02",
        "Identities are proofed and bound to credentials based on the context of interactions"
    ],
    [
        "PR.AA-03",
        "Users, services, and hardware are authenticated"
    ],
    [
        "PR.AA-04",
        "Identity assertions are protected, conveyed, and verified"
    ],
    [
        "PR.AA-05",
        "Access permissions, entitlements, and authorizations are defined in a policy, managed, enforced, and reviewed, and incorporate the principles of least privilege and separation of duties"
    ],
    [
        "PR.AA-06",
        "Physical access to assets is managed, monitored, and enforced commensurate with risk"
    ],
    [
        "PR.AT-01",
        "Personnel are provided with awareness and training so that they possess the knowledge and skills to perform general tasks with cybersecurity risks in mind"
    ],
    [
        "PR.AT-02",
        "Individuals in specialized roles are provided with awareness and training so that they possess the knowledge and skills to perform relevant tasks with cybersecurity risks in mind"
    ],
    [
        "PR.DS-01",
        "The confidentiality, integrity, and availability of data-at-rest are protected"
    ],
    [
        "PR.DS-02",
        "The confidentiality, integrity, and availability of data-in-transit are protected"
    ],
    [
        "PR.DS-10",
        "The confidentiality, integrity, and availability of data-in-use are protected"
    ],
    [
        "PR.DS-11",
        "Backups of data are created, protected, maintained, and tested"
    ],
    [
        "PR.PS-01",
        "Configuration management practices are established and applied"
    ],
    [
        "PR.PS-02",
        "Software is maintained, replaced, and removed commensurate with risk"
    ],
    [
        "PR.PS-03",
        "Hardware is maintained, replaced, and removed commensurate with risk"
    ],
    [
        "PR.PS-04",
        "Log records are generated and made available for continuous monitoring"
    ],
    [
        "PR.PS-05",
        "Installation and execution of unauthorized software are prevented"
    ],
    [
        "PR.PS-06",
        "Secure software development practices are integrated, and their performance is monitored throughout the software development life cycle"
    ],
    [
        "PR.IR-01",
        "Networks and environments are protected from unauthorized logical access and usage"
    ],
    [
        "PR.IR-02",
        "The organization’s technology assets are protected from environmental threats"
    ],
    [
        "PR.IR-03",
        "Mechanisms are implemented to achieve resilience requirements in normal and adverse situations"
    ],
    [
        "PR.IR-04",
        "Adequate resource capacity to ensure availability is maintained"
    ],
    [
        "DE.CM-01",
        "Networks and network services are monitored to find potentially adverse events"
    ],
    [
        "DE.CM-02",
        "The physical environment is monitored to find potentially adverse events"
    ],
    [
        "DE.CM-03",
        "Personnel activity and technology usage are monitored to find potentially adverse events"
    ],
    [
        "DE.CM-06",
        "External service provider activities and services are monitored to find potentially adverse events"
    ],
    [
        "DE.CM-09",
        "Computing hardware and software, runtime environments, and their data are monitored to find potentially adverse events"
    ],
    [
        "DE.AE-02",
        "Potentially adverse events are analyzed to better understand associated activities"
    ],
    [
        "DE.AE-03",
        "Information is correlated from multiple sources"
    ],
    [
        "DE.AE-04",
        "The estimated impact and scope of adverse events are understood"
    ],
    [
        "DE.AE-06",
        "Information on adverse events is provided to authorized staff and tools"
    ],
    [
        "DE.AE-07",
        "Cyber threat intelligence and other contextual information are integrated into the analysis"
    ],
    [
        "DE.AE-08",
        "Incidents are declared when adverse events meet the defined incident criteria"
    ],
    [
        "RS.MA-01",
        "The incident response plan is executed in coordination with relevant third parties once an incident is declared"
    ],
    [
        "RS.MA-02",
        "Incident reports are triaged and validated"
    ],
    [
        "RS.MA-03",
        "Incidents are categorized and prioritized"
    ],
    [
        "RS.MA-04",
        "Incidents are escalated or elevated as needed"
    ],
    [
        "RS.MA-05",
        "The criteria for initiating incident recovery are applied"
    ],
    [
        "RS.AN-03",
        "Analysis is performed to establish what has taken place during an incident and the root cause of the incident"
    ],
    [
        "RS.AN-06",
        "Actions performed during an investigation are recorded, and the records’ integrity and provenance are preserved"
    ],
    [
        "RS.AN-07",
        "Incident data and metadata are collected, and their integrity and provenance are preserved"
    ],
    [
        "RS.AN-08",
        "An incident’s magnitude is estimated and validated"
    ],
    [
        "RS.CO-02",
        "Internal and external stakeholders are notified of incidents"
    ],
    [
        "RS.CO-03",
        "Information is shared with designated internal and external stakeholders"
    ],
    [
        "RS.MI-01",
        "Incidents are contained"
    ],
    [
        "RS.MI-02",
        "Incidents are eradicated"
    ],
    [
        "RC.RP-01",
        "The recovery portion of the incident response plan is executed once initiated from the incident response process"
    ],
    [
        "RC.RP-02",
        "Recovery actions are selected, scoped, prioritized, and performed"
    ],
    [
        "RC.RP-03",
        "The integrity of backups and other restoration assets is verified before using them for restoration"
    ],
    [
        "RC.RP-04",
        "Critical mission functions and cybersecurity risk management are considered to establish post-incident operational norms"
    ],
    [
        "RC.RP-05",
        "The integrity of restored assets is verified, systems and services are restored, and normal operating status is confirmed"
    ],
    [
        "RC.RP-06",
        "The end of incident recovery is declared based on criteria, and incident-related documentation is completed"
    ],
    [
        "RC.CO-03",
        "Recovery activities and progress in restoring operational capabilities are communicated to designated internal and external stakeholders"
    ],
    [
        "RC.CO-04",
        "Public updates on incident recovery are shared using approved methods and messaging"
    ]
];

module.exports = { createNistFrameworkProfile, NistFrameworkProfileError };
