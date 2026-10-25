# NIST CSF 2.0 native assessment and NCSC reference crosswalk

The NIST profile provides one independently answered No Fries question for each
of the 106 outcomes in the final NIST Cybersecurity Framework (CSF) 2.0 Core.
The separate crosswalk explains which of the existing fourteen No Fries NCSC
questions have a direct, partial relationship to those outcomes, and what they
leave out. It never converts NCSC answers into NIST answers or a combined score.

Both publications are fixed, deterministic data. Constructing them does not
register a default profile, change the accepted NCSC evaluator or enable a
runtime endpoint, questionnaire, report or customer rollout.

## Construct the fixed publications

```js
const { createNistFrameworkProfile } = require('../api/shared/assessmentEngine/nistFrameworkProfile');
const { createNistNcscCrosswalk } = require('../api/shared/assessmentEngine/nistNcscCrosswalk');

const nativeProfile = createNistFrameworkProfile();
const referenceCrosswalk = createNistNcscCrosswalk();
```

The paths above are relative to this documentation directory. Each constructor
takes zero arguments and returns detached, deeply frozen data. Repeated calls
return equal content without exposing mutable module data. There is no URL,
clock, registry, source override, arbitrary import or callback argument. Only
the two constructors and their corresponding error classes are exported.

| Module | Safe error class and codes |
| --- | --- |
| `nistFrameworkProfile.js` | `NistFrameworkProfileError`: `nist_source_digest_mismatch`, `nist_profile_digest_mismatch`, `nist_profile_invalid` |
| `nistNcscCrosswalk.js` | `NistNcscCrosswalkError`: `crosswalk_profile_mismatch`, `crosswalk_invalid`, `crosswalk_digest_mismatch` |

These errors identify invalid fixed publication content or endpoint drift.
They do not define HTTP statuses, expose rejected content or authorize a
fallback version. The crosswalk revalidates both fixed endpoint publications
through the existing registry publisher before comparing their six-field
profile references. A reported catalogue digest cannot hide changed content.

## Native profile identity and question method

| Property | Value |
| --- | --- |
| Framework | `nist-cybersecurity-framework@2.0` |
| No Fries profile | `nf-nist-csf-2-0-core@2026-09-08.1` |
| Schema/status | `1` / `published` (source publication, not deployment) |
| No Fries publication/effective date | `2026-09-08` |
| NIST publication date | `2024-02-26` |
| Source verification/review due | `2026-09-08` / `2027-09-02`, annual review |
| Domain order | GV, ID, PR, DE, RS, RC |
| Granularity | 6 domains, 22 category contexts, 106 controls, 106 questions |
| Question identifiers | `<subcategoryId>-Q1` |
| Weights | Positive integer 1 per native outcome |
| Native source catalogue SHA-256 | ab75b51c3561c50cb48cd21b96c01afa2aecafb2efc6b46ae4a8ef8cd753a656 |
| Native catalogue SHA-256 | ec394a65b11417b67201f96af57a7eabeb284376bb0651b816b40017476b6073 |

Functions contain 31, 21, 22, 11, 13 and 8 outcomes respectively. Equal outcome
weights give functions different total weights; this is a No Fries convention,
not a weighting scheme prescribed by NIST. Each outcome is one control and one
Q1 leaf. Category names provide context without adding scoreable controls.
The control's sole source reference is the exact NIST subcategory ID, so it
applies to the one child question. Mapping strength is never inserted into the
registry's closed `sourceReferences` shape.

Every question uses this exact prefix followed by its official outcome below:

> Within the declared assessment scope, how fully is this outcome achieved?

Assess every named subject, action and condition within the declared population,
systems, services and assessment period. A Yes answer concerns the whole
outcome, not one example. Partial means some but not all is achieved; its 0.5
factor is a No Fries convention, not a literal percentage of NIST requirements.

| Option | Applicable | Implementation factor |
| --- | --- | --- |
| Yes | true | 1 |
| Partial | true | 0.5 |
| No | true | 0 |
| Unknown | true | null |
| Not applicable | false | null |

Unknown and approved Not applicable retain the unchanged PROD-003-R1 semantics.
The crosswalk cannot approve applicability, substantiate evidence or select a
score date. Native evaluation requires all 106 native atom inputs, the exact
profile reference and the existing scope/evidence context. Use the generic
`evaluateAssessment(input, { registry })`, with the existing optional
`applicabilityDecisionRegistry` only when needed. Construct a separate local
registry explicitly; the accepted NCSC adapter remains closed to its profile.
See [the deterministic evaluator contract](assessment-engine/deterministic-evaluator.md).

Call the result No Fries implementation attainment for the declared NIST outcome
scope. It is not an official NIST score, a CSF Tier, a NIST Organizational Current
or Target Profile, certification, endorsement, a compliance determination or a
prediction of breach likelihood. The CSF defines outcomes and does not prescribe
these questions, evidence examples, response factors or weights.

The common No Fries guidance asks for dated, scope-specific policies/procedures
or configurations, operating samples or exercise results, and a named owner
with current exceptions/gaps. Starting actions are to record the population and
period, compare current practice with every part of the outcome, then assign an
owner and review date to the next improvement. Linked NCSC references do not
establish native achievement.

## Complete native Core outcomes

Each row below is one control and one Q1 question. Category titles follow the
official hierarchy; PDF pages are physical page numbers (the printed numbering
is five lower). Outcome text retains the final PDF wording with line wrapping
joined and line-break hyphens retained.

| Control / Q1 prefix | Category | Official outcome | PDF page |
| --- | --- | --- | --- |
| GV.OC-01 | Organizational Context | The organizational mission is understood and informs cybersecurity risk management | 21 |
| GV.OC-02 | Organizational Context | Internal and external stakeholders are understood, and their needs and expectations regarding cybersecurity risk management are understood and considered | 21 |
| GV.OC-03 | Organizational Context | Legal, regulatory, and contractual requirements regarding cybersecurity — including privacy and civil liberties obligations — are understood and managed | 21 |
| GV.OC-04 | Organizational Context | Critical objectives, capabilities, and services that external stakeholders depend on or expect from the organization are understood and communicated | 21 |
| GV.OC-05 | Organizational Context | Outcomes, capabilities, and services that the organization depends on are understood and communicated | 21 |
| GV.RM-01 | Risk Management Strategy | Risk management objectives are established and agreed to by organizational stakeholders | 21 |
| GV.RM-02 | Risk Management Strategy | Risk appetite and risk tolerance statements are established, communicated, and maintained | 21 |
| GV.RM-03 | Risk Management Strategy | Cybersecurity risk management activities and outcomes are included in enterprise risk management processes | 21 |
| GV.RM-04 | Risk Management Strategy | Strategic direction that describes appropriate risk response options is established and communicated | 21 |
| GV.RM-05 | Risk Management Strategy | Lines of communication across the organization are established for cybersecurity risks, including risks from suppliers and other third parties | 21 |
| GV.RM-06 | Risk Management Strategy | A standardized method for calculating, documenting, categorizing, and prioritizing cybersecurity risks is established and communicated | 21 |
| GV.RM-07 | Risk Management Strategy | Strategic opportunities (i.e., positive risks) are characterized and are included in organizational cybersecurity risk discussions | 21 |
| GV.RR-01 | Roles, Responsibilities, and Authorities | Organizational leadership is responsible and accountable for cybersecurity risk and fosters a culture that is risk-aware, ethical, and continually improving | 22 |
| GV.RR-02 | Roles, Responsibilities, and Authorities | Roles, responsibilities, and authorities related to cybersecurity risk management are established, communicated, understood, and enforced | 22 |
| GV.RR-03 | Roles, Responsibilities, and Authorities | Adequate resources are allocated commensurate with the cybersecurity risk strategy, roles, responsibilities, and policies | 22 |
| GV.RR-04 | Roles, Responsibilities, and Authorities | Cybersecurity is included in human resources practices | 22 |
| GV.PO-01 | Policy | Policy for managing cybersecurity risks is established based on organizational context, cybersecurity strategy, and priorities and is communicated and enforced | 22 |
| GV.PO-02 | Policy | Policy for managing cybersecurity risks is reviewed, updated, communicated, and enforced to reflect changes in requirements, threats, technology, and organizational mission | 22 |
| GV.OV-01 | Oversight | Cybersecurity risk management strategy outcomes are reviewed to inform and adjust strategy and direction | 22 |
| GV.OV-02 | Oversight | The cybersecurity risk management strategy is reviewed and adjusted to ensure coverage of organizational requirements and risks | 22 |
| GV.OV-03 | Oversight | Organizational cybersecurity risk management performance is evaluated and reviewed for adjustments needed | 22 |
| GV.SC-01 | Cybersecurity Supply Chain Risk Management | A cybersecurity supply chain risk management program, strategy, objectives, policies, and processes are established and agreed to by organizational stakeholders | 22 |
| GV.SC-02 | Cybersecurity Supply Chain Risk Management | Cybersecurity roles and responsibilities for suppliers, customers, and partners are established, communicated, and coordinated internally and externally | 22 |
| GV.SC-03 | Cybersecurity Supply Chain Risk Management | Cybersecurity supply chain risk management is integrated into cybersecurity and enterprise risk management, risk assessment, and improvement processes | 22 |
| GV.SC-04 | Cybersecurity Supply Chain Risk Management | Suppliers are known and prioritized by criticality | 22 |
| GV.SC-05 | Cybersecurity Supply Chain Risk Management | Requirements to address cybersecurity risks in supply chains are established, prioritized, and integrated into contracts and other types of agreements with suppliers and other relevant third parties | 23 |
| GV.SC-06 | Cybersecurity Supply Chain Risk Management | Planning and due diligence are performed to reduce risks before entering into formal supplier or other third-party relationships | 23 |
| GV.SC-07 | Cybersecurity Supply Chain Risk Management | The risks posed by a supplier, their products and services, and other third parties are understood, recorded, prioritized, assessed, responded to, and monitored over the course of the relationship | 23 |
| GV.SC-08 | Cybersecurity Supply Chain Risk Management | Relevant suppliers and other third parties are included in incident planning, response, and recovery activities | 23 |
| GV.SC-09 | Cybersecurity Supply Chain Risk Management | Supply chain security practices are integrated into cybersecurity and enterprise risk management programs, and their performance is monitored throughout the technology product and service life cycle | 23 |
| GV.SC-10 | Cybersecurity Supply Chain Risk Management | Cybersecurity supply chain risk management plans include provisions for activities that occur after the conclusion of a partnership or service agreement | 23 |
| ID.AM-01 | Asset Management | Inventories of hardware managed by the organization are maintained | 23 |
| ID.AM-02 | Asset Management | Inventories of software, services, and systems managed by the organization are maintained | 23 |
| ID.AM-03 | Asset Management | Representations of the organization’s authorized network communication and internal and external network data flows are maintained | 23 |
| ID.AM-04 | Asset Management | Inventories of services provided by suppliers are maintained | 23 |
| ID.AM-05 | Asset Management | Assets are prioritized based on classification, criticality, resources, and impact on the mission | 23 |
| ID.AM-07 | Asset Management | Inventories of data and corresponding metadata for designated data types are maintained | 23 |
| ID.AM-08 | Asset Management | Systems, hardware, software, services, and data are managed throughout their life cycles | 23 |
| ID.RA-01 | Risk Assessment | Vulnerabilities in assets are identified, validated, and recorded | 23 |
| ID.RA-02 | Risk Assessment | Cyber threat intelligence is received from information sharing forums and sources | 24 |
| ID.RA-03 | Risk Assessment | Internal and external threats to the organization are identified and recorded | 24 |
| ID.RA-04 | Risk Assessment | Potential impacts and likelihoods of threats exploiting vulnerabilities are identified and recorded | 24 |
| ID.RA-05 | Risk Assessment | Threats, vulnerabilities, likelihoods, and impacts are used to understand inherent risk and inform risk response prioritization | 24 |
| ID.RA-06 | Risk Assessment | Risk responses are chosen, prioritized, planned, tracked, and communicated | 24 |
| ID.RA-07 | Risk Assessment | Changes and exceptions are managed, assessed for risk impact, recorded, and tracked | 24 |
| ID.RA-08 | Risk Assessment | Processes for receiving, analyzing, and responding to vulnerability disclosures are established | 24 |
| ID.RA-09 | Risk Assessment | The authenticity and integrity of hardware and software are assessed prior to acquisition and use | 24 |
| ID.RA-10 | Risk Assessment | Critical suppliers are assessed prior to acquisition | 24 |
| ID.IM-01 | Improvement | Improvements are identified from evaluations | 24 |
| ID.IM-02 | Improvement | Improvements are identified from security tests and exercises, including those done in coordination with suppliers and relevant third parties | 24 |
| ID.IM-03 | Improvement | Improvements are identified from execution of operational processes, procedures, and activities | 24 |
| ID.IM-04 | Improvement | Incident response plans and other cybersecurity plans that affect operations are established, communicated, maintained, and improved | 24 |
| PR.AA-01 | Identity Management, Authentication, and Access Control | Identities and credentials for authorized users, services, and hardware are managed by the organization | 24 |
| PR.AA-02 | Identity Management, Authentication, and Access Control | Identities are proofed and bound to credentials based on the context of interactions | 24 |
| PR.AA-03 | Identity Management, Authentication, and Access Control | Users, services, and hardware are authenticated | 24 |
| PR.AA-04 | Identity Management, Authentication, and Access Control | Identity assertions are protected, conveyed, and verified | 24 |
| PR.AA-05 | Identity Management, Authentication, and Access Control | Access permissions, entitlements, and authorizations are defined in a policy, managed, enforced, and reviewed, and incorporate the principles of least privilege and separation of duties | 25 |
| PR.AA-06 | Identity Management, Authentication, and Access Control | Physical access to assets is managed, monitored, and enforced commensurate with risk | 25 |
| PR.AT-01 | Awareness and Training | Personnel are provided with awareness and training so that they possess the knowledge and skills to perform general tasks with cybersecurity risks in mind | 25 |
| PR.AT-02 | Awareness and Training | Individuals in specialized roles are provided with awareness and training so that they possess the knowledge and skills to perform relevant tasks with cybersecurity risks in mind | 25 |
| PR.DS-01 | Data Security | The confidentiality, integrity, and availability of data-at-rest are protected | 25 |
| PR.DS-02 | Data Security | The confidentiality, integrity, and availability of data-in-transit are protected | 25 |
| PR.DS-10 | Data Security | The confidentiality, integrity, and availability of data-in-use are protected | 25 |
| PR.DS-11 | Data Security | Backups of data are created, protected, maintained, and tested | 25 |
| PR.PS-01 | Platform Security | Configuration management practices are established and applied | 25 |
| PR.PS-02 | Platform Security | Software is maintained, replaced, and removed commensurate with risk | 25 |
| PR.PS-03 | Platform Security | Hardware is maintained, replaced, and removed commensurate with risk | 25 |
| PR.PS-04 | Platform Security | Log records are generated and made available for continuous monitoring | 25 |
| PR.PS-05 | Platform Security | Installation and execution of unauthorized software are prevented | 25 |
| PR.PS-06 | Platform Security | Secure software development practices are integrated, and their performance is monitored throughout the software development life cycle | 25 |
| PR.IR-01 | Technology Infrastructure Resilience | Networks and environments are protected from unauthorized logical access and usage | 25 |
| PR.IR-02 | Technology Infrastructure Resilience | The organization’s technology assets are protected from environmental threats | 26 |
| PR.IR-03 | Technology Infrastructure Resilience | Mechanisms are implemented to achieve resilience requirements in normal and adverse situations | 26 |
| PR.IR-04 | Technology Infrastructure Resilience | Adequate resource capacity to ensure availability is maintained | 26 |
| DE.CM-01 | Continuous Monitoring | Networks and network services are monitored to find potentially adverse events | 26 |
| DE.CM-02 | Continuous Monitoring | The physical environment is monitored to find potentially adverse events | 26 |
| DE.CM-03 | Continuous Monitoring | Personnel activity and technology usage are monitored to find potentially adverse events | 26 |
| DE.CM-06 | Continuous Monitoring | External service provider activities and services are monitored to find potentially adverse events | 26 |
| DE.CM-09 | Continuous Monitoring | Computing hardware and software, runtime environments, and their data are monitored to find potentially adverse events | 26 |
| DE.AE-02 | Adverse Event Analysis | Potentially adverse events are analyzed to better understand associated activities | 26 |
| DE.AE-03 | Adverse Event Analysis | Information is correlated from multiple sources | 26 |
| DE.AE-04 | Adverse Event Analysis | The estimated impact and scope of adverse events are understood | 26 |
| DE.AE-06 | Adverse Event Analysis | Information on adverse events is provided to authorized staff and tools | 26 |
| DE.AE-07 | Adverse Event Analysis | Cyber threat intelligence and other contextual information are integrated into the analysis | 26 |
| DE.AE-08 | Adverse Event Analysis | Incidents are declared when adverse events meet the defined incident criteria | 26 |
| RS.MA-01 | Incident Management | The incident response plan is executed in coordination with relevant third parties once an incident is declared | 27 |
| RS.MA-02 | Incident Management | Incident reports are triaged and validated | 27 |
| RS.MA-03 | Incident Management | Incidents are categorized and prioritized | 27 |
| RS.MA-04 | Incident Management | Incidents are escalated or elevated as needed | 27 |
| RS.MA-05 | Incident Management | The criteria for initiating incident recovery are applied | 27 |
| RS.AN-03 | Incident Analysis | Analysis is performed to establish what has taken place during an incident and the root cause of the incident | 27 |
| RS.AN-06 | Incident Analysis | Actions performed during an investigation are recorded, and the records’ integrity and provenance are preserved | 27 |
| RS.AN-07 | Incident Analysis | Incident data and metadata are collected, and their integrity and provenance are preserved | 27 |
| RS.AN-08 | Incident Analysis | An incident’s magnitude is estimated and validated | 27 |
| RS.CO-02 | Incident Response Reporting and Communication | Internal and external stakeholders are notified of incidents | 27 |
| RS.CO-03 | Incident Response Reporting and Communication | Information is shared with designated internal and external stakeholders | 27 |
| RS.MI-01 | Incident Mitigation | Incidents are contained | 27 |
| RS.MI-02 | Incident Mitigation | Incidents are eradicated | 27 |
| RC.RP-01 | Incident Recovery Plan Execution | The recovery portion of the incident response plan is executed once initiated from the incident response process | 27 |
| RC.RP-02 | Incident Recovery Plan Execution | Recovery actions are selected, scoped, prioritized, and performed | 28 |
| RC.RP-03 | Incident Recovery Plan Execution | The integrity of backups and other restoration assets is verified before using them for restoration | 28 |
| RC.RP-04 | Incident Recovery Plan Execution | Critical mission functions and cybersecurity risk management are considered to establish post-incident operational norms | 28 |
| RC.RP-05 | Incident Recovery Plan Execution | The integrity of restored assets is verified, systems and services are restored, and normal operating status is confirmed | 28 |
| RC.RP-06 | Incident Recovery Plan Execution | The end of incident recovery is declared based on criteria, and incident-related documentation is completed | 28 |
| RC.CO-03 | Incident Recovery Communication | Recovery activities and progress in restoring operational capabilities are communicated to designated internal and external stakeholders | 28 |
| RC.CO-04 | Incident Recovery Communication | Public updates on incident recovery are shared using approved methods and messaging | 28 |

## Accepted NCSC endpoint and compared prompts

The source is the existing No Fries NCSC questionnaire, not every cumulative
official Minimum Standard requirement. Only the exact prompt is the compared
unit: guidance, titles and inferred implementations are not substituted for it.
The historical NCSC default and accepted adapter remain unchanged.

| Endpoint property | Frozen value |
| --- | --- |
| frameworkId | nz-ncsc-cyber-security-framework |
| frameworkVersion | beta-verified-2026-09-02 |
| profileId | nz-ncsc-mcss-2025-v3-sme |
| profileVersion | 2026-09-02.1 |
| catalogueSha256 | 32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375 |
| sourceCatalogueSha256 | 26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee |

The question pointer below is a JSON pointer into that exact published profile.

| Source control | Question pointer | Exact source prompt |
| --- | --- | --- |
| NF-NCSC-MCSS-RM-01 | /questions/0/prompt | Are cyber risks managed through a documented business risk process with tolerance, owners and regular review? |
| NF-NCSC-MCSS-SA-01 | /questions/1/prompt | Do people receive current, role-appropriate security guidance from onboarding onward, with results reported to leadership? |
| NF-NCSC-MCSS-AI-01 | /questions/2/prompt | Is there a current inventory of important hardware, software, cloud services and data with owners and lifecycle status? |
| NF-NCSC-MCSS-SC-01 | /questions/3/prompt | Are secure configuration baselines applied to new and existing systems, with exceptions reviewed when software changes? |
| NF-NCSC-MCSS-PA-01 | /questions/4/prompt | Are patches prioritised, sourced, tested, deployed and verified through a repeatable process that includes rollback and retirement? |
| NF-NCSC-MCSS-MF-01 | /questions/5/prompt | Is MFA enforced for critical, internet-accessible, privileged and relevant third-party access, with failures reviewed? |
| NF-NCSC-MCSS-DU-01 | /questions/6/prompt | Are useful logs from critical and externally facing systems brought together, reviewed and turned into actionable alerts? |
| NF-NCSC-MCSS-LP-01 | /questions/7/prompt | Is access limited to what each person needs, with separate privileged accounts and repeatable joiner, mover, leaver and review processes? |
| NF-NCSC-MCSS-DR-01 | /questions/8/prompt | Are critical systems and data backed up to defined recovery requirements, with protected copies and sampled restore tests? |
| NF-NCSC-MCSS-RP-01 | /questions/9/prompt | Is there a risk-based incident response plan with named responsibilities, management support, contact paths and lessons from exercises or incidents? |
| NF-NCSC-CC-PM-01 | /questions/10/prompt | Does the organisation provide and govern a password manager that people actually use for unique passwords and approved sharing? |
| NF-NCSC-CC-SV-01 | /questions/11/prompt | Do payment, credential, account-recovery and sensitive-data changes require a trusted verification step outside the original request? |
| NF-NCSC-CC-AC-01 | /questions/12/prompt | Are unapproved or risky applications, scripts, macros and file types restricted on systems where they could cause material harm? |
| NF-NCSC-CC-NS-01 | /questions/13/prompt | Are users, guests, administration, backups and important services separated so one compromise cannot freely spread? |

## Typed directional relationships

Crosswalk `nf-ncsc-to-nist-csf-2-0@2026-09-08.1` uses direction
`ncsc-question-to-nist-outcome` and method
`prompt-to-outcome-editorial-v1`. No Fries Limited authored it on 2026-09-08.
Both endpoint references carry exactly framework/profile IDs and versions plus
catalogue/source-catalogue digests. The target is the independently published
native profile above.

| Relationship | Meaning |
| --- | --- |
| `exact` | The source prompt assesses every target subject, action and condition in the same declared scope. This edition asserts zero exact relationships. Exact would still not transfer an answer or evidence state. |
| `partial` | A direct overlap exists and the record names omitted target scope. This does not give fractional attainment credit or establish an inverse relationship. |
| Target `no_match` | Source is null. Review of all fourteen source prompts supports no sufficiently specific direct relationship asserted by this edition. |
| Source `no_match` | Target is null. Review of all 106 outcomes supports no sufficiently specific direct relationship asserted by this edition. |

No-match is a documented editorial disposition, not proof that implementations
cannot overlap. An unlisted individual source-target pair is unasserted, not
implicitly no-match. Every source and target has a positive or explicit
no-match disposition; an endpoint with positive relationships cannot also have
a no-match record. Both sides are never null.

There are 109 records: 28 partial links reach 26 distinct targets, 80 records
explicitly mark other targets no-match, and one marks the sensitive-change
verification source no-match. These are publication audit counts, not an
attainment or coverage percentage. Cloud services are not assumed to be
supplier-provided. Planning is not mapped to incident execution. A trusted
sensitive-change check is not assumed to prove and bind credentials.

The exact root keys are `schemaVersion`, `id`, `version`, `publishedAt`,
`direction`, `comparisonBasis`, `fromProfileRef`, `toProfileRef`,
`reviewedSourceQuestionIds`, `reviewedTargetControlIds`, `provenance`,
`statements`, `records` and `crosswalkSha256`. Every record has exactly `id`,
`order`, `source`, `target`, `relationship`, `rationale`, `omittedTargetScope`
and `locators`. A present endpoint has `{controlId, questionId}`. Locators have
the source question pointer and `{sourceId, referenceId, pdfPage}` for a present
target, or null on the absent side. Empty omissions are required for exact and
no-match; partial omissions are nonempty. These are crosswalk-only fields.

### Complete relationship record table

`ALL-NCSC14` means the complete reviewed source-question universe; `ALL-NIST106`
means the complete reviewed native-outcome universe. They identify the absent
side in a no-match record ID, not additional controls or questions. Present
control IDs below imply their exact `-Q1` question. Source pointers are in the
preceding table and target PDF locators are in the Core table.

| Record ID (published order) | Relationship | Rationale | Omitted target scope |
| --- | --- | --- | --- |
| NF-NCSC-MCSS-RM-01--GV.RM-02 | partial | The source asks for a documented risk process with tolerance. | Explicit risk appetite, communication and maintenance of both appetite and tolerance statements are not all asked for. |
| NF-NCSC-MCSS-RM-01--GV.RM-03 | partial | The source places cyber risk in a documented business risk process. | Explicit integration of all cybersecurity risk activities and outcomes into enterprise risk management is broader than the concise source prompt. |
| NF-NCSC-MCSS-RM-01--GV.RR-02 | partial | The source asks for accountable owners in the cyber risk process. | All cybersecurity roles, responsibilities and authorities, their communication, understanding and enforcement are not covered. |
| NF-NCSC-MCSS-RM-01--GV.OV-02 | partial | The source asks for regular review of the business cyber-risk process. | Explicit strategy adjustment and demonstrated coverage of organizational requirements and risks are not required by the prompt. |
| NF-NCSC-MCSS-SA-01--PR.AT-01 | partial | The source asks for current security guidance from onboarding onward. | Demonstrating the knowledge and skills to perform general tasks across the personnel population is broader than providing guidance. |
| NF-NCSC-MCSS-SA-01--PR.AT-02 | partial | The source asks for role-appropriate security guidance. | Specialized-role competence and all relevant tasks are not explicitly assessed. |
| NF-NCSC-MCSS-AI-01--ID.AM-01 | partial | The source asks for a current inventory of important hardware. | Hardware outside the important-asset subset is not expressly included. |
| NF-NCSC-MCSS-AI-01--ID.AM-02 | partial | The source asks for a current inventory of important software and cloud services. | All managed systems, services and software are broader than this important-asset subset. |
| NF-NCSC-MCSS-AI-01--ID.AM-07 | partial | The source includes important data in the current inventory. | Designated data types and their corresponding metadata are not expressly required. |
| NF-NCSC-MCSS-AI-01--ID.AM-08 | partial | The source asks for owners and lifecycle status for hardware, software, cloud services and data. | Maintaining status is narrower than managing every asset throughout its lifecycle. |
| NF-NCSC-MCSS-SC-01--PR.PS-01 | partial | The source asks for secure baselines on new and existing systems and review of exceptions. | Configuration-management practices beyond secure baselines and these exception reviews are not fully assessed. |
| NF-NCSC-MCSS-SC-01--ID.RA-07 | partial | The source asks for configuration exceptions to be reviewed when software changes. | Risk-impact assessment, recording and tracking of all changes and exceptions are not expressly required. |
| NF-NCSC-MCSS-PA-01--PR.PS-02 | partial | The source asks for repeatable prioritized patching with verification, rollback and retirement. | All software maintenance, replacement and removal decisions commensurate with risk extend beyond the patch process. |
| NF-NCSC-MCSS-MF-01--PR.AA-03 | partial | The source asks for MFA on critical, internet-accessible, privileged and relevant third-party access. | Authentication of all users, services and hardware outside those access classes is not established. |
| NF-NCSC-MCSS-DU-01--PR.PS-04 | partial | The source asks for useful logs from critical and externally facing systems to be gathered for review and alerting. | Generation and availability of logs across the wider platform population are not fully covered. |
| NF-NCSC-MCSS-DU-01--DE.CM-09 | partial | The source asks for review and actionable alerts from critical and externally facing system logs. | Monitoring the complete hardware, software, runtime-environment and data population through all relevant signals is broader. |
| NF-NCSC-MCSS-DU-01--DE.AE-02 | partial | The source asks for gathered logs to be reviewed and turned into actionable alerts. | Analysis that explains the associated activities of all potentially adverse events is not expressly required. |
| NF-NCSC-MCSS-LP-01--PR.AA-01 | partial | The source asks for repeatable joiner, mover, leaver and access review processes for people. | Identity and credential management for services and hardware and the full credential lifecycle are not covered. |
| NF-NCSC-MCSS-LP-01--PR.AA-05 | partial | The source asks for least-needed access, separate privileged accounts and repeated lifecycle reviews. | An explicit authorization policy, all entitlements and separation of duties are not fully required. |
| NF-NCSC-MCSS-DR-01--PR.DS-11 | partial | The source asks for backups of critical systems and data, protected copies and sampled restoration tests. | The wider data population and the full maintenance of backups are not expressly covered. |
| NF-NCSC-MCSS-DR-01--PR.IR-03 | partial | The source asks for backups tied to defined recovery requirements and sampled restore tests. | Other resilience mechanisms and normal-operation resilience requirements are not covered. |
| NF-NCSC-MCSS-RP-01--GV.RR-02 | partial | The source asks for named incident-response responsibilities and management support. | Roles and authorities outside response, and their communication, understanding and enforcement, are broader. |
| NF-NCSC-MCSS-RP-01--ID.IM-02 | partial | The source names exercise or incident lessons as inputs to the response plan. | The source permits incident lessons alone; it does not require all security tests and exercises or supplier and third-party coordination. |
| NF-NCSC-MCSS-RP-01--ID.IM-03 | partial | The source names incident or exercise lessons in the response plan. | The source permits exercise lessons alone; improvements from the complete range of actual operational processes, procedures and activities are broader. |
| NF-NCSC-MCSS-RP-01--ID.IM-04 | partial | The source asks for a risk-based response plan, named responsibilities, contact paths and exercise or incident lessons. | Other cybersecurity plans affecting operations and explicit continuing communication and maintenance are broader. |
| NF-NCSC-CC-PM-01--PR.AA-01 | partial | The source asks for governed use of unique passwords and approved sharing through a password manager. | Identity and credential management beyond these password practices, including services and hardware, is broader. |
| NF-NCSC-CC-AC-01--PR.PS-05 | partial | The source asks for restriction of unapproved or risky applications, scripts, macros and file types on high-impact systems. | Prevention of all unauthorized software installation and execution across the whole platform population is broader. |
| NF-NCSC-CC-NS-01--PR.IR-01 | partial | The source asks for separation of user, guest, administrative, backup and important-service environments. | All controls against unauthorized network and environment access and usage are broader than segmentation. |
| ALL-NCSC14--GV.OC-01 | no_match | The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.OC-02 | no_match | The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.OC-03 | no_match | The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.OC-04 | no_match | The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.OC-05 | no_match | The concise prompts do not directly assess mission, stakeholder expectations, legal obligations or dependency communication as these Organizational Context outcomes require. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RM-01 | no_match | Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RM-04 | no_match | Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RM-05 | no_match | Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RM-06 | no_match | Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RM-07 | no_match | Risk-process ownership and tolerance are present, but these prompts do not explicitly assess agreed objectives, strategic response direction, cross-organizational communications, a standardized risk calculation method or positive risk opportunities. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RR-01 | no_match | Named risk and response owners do not directly assess leadership accountability and culture, commensurate resources or cybersecurity across human-resources practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RR-03 | no_match | Named risk and response owners do not directly assess leadership accountability and culture, commensurate resources or cybersecurity across human-resources practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.RR-04 | no_match | Named risk and response owners do not directly assess leadership accountability and culture, commensurate resources or cybersecurity across human-resources practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.PO-01 | no_match | A risk process or secure baseline does not directly ask for the organization-wide cybersecurity policy lifecycle and enforcement described here. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.PO-02 | no_match | A risk process or secure baseline does not directly ask for the organization-wide cybersecurity policy lifecycle and enforcement described here. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.OV-01 | no_match | Regular risk-process review and security-guidance reporting do not directly ask for strategy-outcome review or organization-wide cybersecurity performance evaluation. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.OV-03 | no_match | Regular risk-process review and security-guidance reporting do not directly ask for strategy-outcome review or organization-wide cybersecurity performance evaluation. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-01 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-02 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-03 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-04 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-05 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-06 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-07 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-08 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-09 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--GV.SC-10 | no_match | The prompts mention selected third-party access and cloud assets, but do not directly assess the supplier-governance, relationship or supply-chain lifecycle outcomes in this category. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.AM-03 | no_match | Inventory and network separation do not explicitly require documented authorized data-flow representations, a supplier-service inventory or the stated multi-criterion asset prioritization; cloud services are not necessarily supplier-provided. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.AM-04 | no_match | Inventory and network separation do not explicitly require documented authorized data-flow representations, a supplier-service inventory or the stated multi-criterion asset prioritization; cloud services are not necessarily supplier-provided. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.AM-05 | no_match | Inventory and network separation do not explicitly require documented authorized data-flow representations, a supplier-service inventory or the stated multi-criterion asset prioritization; cloud services are not necessarily supplier-provided. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-01 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-02 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-03 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-04 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-05 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-06 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-08 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-09 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.RA-10 | no_match | Risk management and patching are related themes, but do not directly ask for this specific threat, vulnerability, impact, response, disclosure or pre-acquisition assessment outcome. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--ID.IM-01 | no_match | Exercise and incident lessons are linked separately; no source prompt expressly asks for improvements identified from evaluations as a general practice. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.AA-02 | no_match | Trusted verification of sensitive changes is narrower than identity proofing and binding to credentials; the prompts also do not directly assess protected identity assertions or physical access management. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.AA-04 | no_match | Trusted verification of sensitive changes is narrower than identity proofing and binding to credentials; the prompts also do not directly assess protected identity assertions or physical access management. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.AA-06 | no_match | Trusted verification of sensitive changes is narrower than identity proofing and binding to credentials; the prompts also do not directly assess protected identity assertions or physical access management. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.DS-01 | no_match | Backup protection does not establish the distinct confidentiality, integrity and availability outcomes for data at rest, in transit or in use. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.DS-02 | no_match | Backup protection does not establish the distinct confidentiality, integrity and availability outcomes for data at rest, in transit or in use. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.DS-10 | no_match | Backup protection does not establish the distinct confidentiality, integrity and availability outcomes for data at rest, in transit or in use. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.PS-03 | no_match | Asset lifecycle status and patch retirement do not directly assess risk-based hardware replacement/removal or secure software-development lifecycle practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.PS-06 | no_match | Asset lifecycle status and patch retirement do not directly assess risk-based hardware replacement/removal or secure software-development lifecycle practices. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.IR-02 | no_match | Recovery backups and segmentation do not directly assess environmental-threat protection or resource-capacity maintenance. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--PR.IR-04 | no_match | Recovery backups and segmentation do not directly assess environmental-threat protection or resource-capacity maintenance. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.CM-01 | no_match | The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.CM-02 | no_match | The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.CM-03 | no_match | The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.CM-06 | no_match | The system-log prompt does not expressly select these network, physical, personnel-activity or supplier-service monitoring populations and signals. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.AE-03 | no_match | Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.AE-04 | no_match | Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.AE-06 | no_match | Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.AE-07 | no_match | Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--DE.AE-08 | no_match | Gathering and reviewing logs does not explicitly require source correlation, impact/scope estimation, authorized distribution, threat-intelligence integration or incident-declaration criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.MA-01 | no_match | Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.MA-02 | no_match | Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.MA-03 | no_match | Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.MA-04 | no_match | Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.MA-05 | no_match | Preparing a response plan is not the same assessed activity as executing it, triaging, prioritizing, escalating incidents or applying recovery-initiation criteria. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.AN-03 | no_match | Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.AN-06 | no_match | Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.AN-07 | no_match | Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.AN-08 | no_match | Logging and response planning do not expressly assess incident investigation, forensic records/provenance or validated magnitude. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.CO-02 | no_match | A response-plan contact path does not directly assess actual incident notification or sharing with designated stakeholders. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.CO-03 | no_match | A response-plan contact path does not directly assess actual incident notification or sharing with designated stakeholders. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.MI-01 | no_match | Response planning and preventive segmentation do not directly assess actual incident containment or eradication. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RS.MI-02 | no_match | Response planning and preventive segmentation do not directly assess actual incident containment or eradication. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.RP-01 | no_match | Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.RP-02 | no_match | Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.RP-03 | no_match | Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.RP-04 | no_match | Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.RP-05 | no_match | Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.RP-06 | no_match | Backup readiness and sampled restore tests do not establish execution of incident recovery, pre-use integrity verification for an actual restoration, post-incident norms or recovery closure. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.CO-03 | no_match | Response-plan contacts do not directly assess communication of actual recovery progress or approved public recovery updates. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| ALL-NCSC14--RC.CO-04 | no_match | Response-plan contacts do not directly assess communication of actual recovery progress or approved public recovery updates. No sufficiently specific direct mapping is asserted in this reviewed version; a native answer is required. | None asserted |
| NF-NCSC-CC-SV-01--ALL-NIST106 | no_match | Independent verification of sensitive changes is useful, but this concise prompt does not expressly require the full identity-proofing and credential-binding activity of PR.AA-02 or another selected Core outcome. No direct mapping is asserted after review of all 106 outcomes. | None asserted |

## Source provenance, reuse and attribution

The authoritative source is the final [NIST CSWP 29 publication](https://csrc.nist.gov/pubs/cswp/29/the-nist-cybersecurity-framework-csf-20/final),
DOI [10.6028/NIST.CSWP.29](https://doi.org/10.6028/NIST.CSWP.29), dated February
26, 2024. Its 32-page [PDF](https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf)
places Appendix A's hierarchy on physical page 20 and the Core outcomes on
pages 21–28. HTTP modification dates do not change that publication identity.
The withdrawn initial public draft and CSF 1.1 are not used.

The following are exact saved origin-byte observations. Retrieval timestamps
are evidence, not runtime clocks. Raw-file digests are distinct from normalized
source-catalogue, profile and crosswalk digests.

| Origin evidence | Retrieved at UTC | Bytes | Raw SHA-256 |
| --- | --- | --- | --- |
| [nist-cswp-29.pdf](https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf) | 2026-09-08T04:01:09.112403+00:00 | 1518858 | 3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c |
| [nist-reuse-terms.html](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications) | 2026-09-08T04:01:15.220536+00:00 | 64706 | a6de990069c7d522965b97926b58f78d5c1f7d9013fec53d55f29344aa97da18 |
| [nist-disclaimers.html](https://www.nist.gov/copyrights-disclaimers) | 2026-09-08T04:01:20.554965+00:00 | 79183 | 62236b9e26227697c0bfc8f3c0259f5b34e42e18f0589f8dcab78ab33f8febb3 |
| [nist-cswp-29-publication.html](https://csrc.nist.gov/pubs/cswp/29/the-nist-cybersecurity-framework-csf-20/final) | 2026-09-08T04:01:25.064258+00:00 | 46856 | e707a9e430e5cd4c5b387084be16d911840f9252a3feea9933097ea41c9c79cf |

National Institute of Standards and Technology (2024) The NIST Cybersecurity Framework (CSF) 2.0. (National Institute of Standards and Technology, Gaithersburg, MD), NIST Cybersecurity White Paper (CSWP) NIST CSWP 29. https://doi.org/10.6028/NIST.CSWP.29. Republished courtesy of the National Institute of Standards and Technology. No Fries Limited, 2026-09-08: selected the complete CSF 2.0 Core, joined PDF line wrapping, and authored assessment prompts, evidence guidance, identifiers for questions, equal outcome weights, response labels and separate editorial crosswalks. The NIST outcome text and subcategory identifiers are retained. No NIST endorsement is implied.

The applicable [NIST Technical Series reuse terms](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications)
cover worldwide reprint and derivative-work rights to the extent NIST asserts
foreign rights, with the recommended citation and courtesy acknowledgement.
The schema's licence label describes those terms; it is not CC BY. Only
NIST-authored Core text is reused. Logos, imagery, third-party Informative
References, other standards and separately updated Implementation Examples are
excluded. No NIST endorsement is implied.

Adapted by No Fries Limited from the NCSC Cyber Security Framework and Minimum Cyber Security Standards 2025, © Crown copyright, GCSB on behalf of the Crown, licensed under CC BY 4.0. Changes were made for New Zealand SMEs. No NCSC endorsement is implied.

The accepted NCSC source-specific rights statuses and limitations remain
unchanged, including its existing separate legal review for the exact paid or
customer-facing publication. Current [NCSC terms](https://www.ncsc.govt.nz/legal-privacy-and-copyright/)
describe Crown material reuse under CC BY 4.0 with stated exceptions; NCSC
cannot grant third-party rights. No logos, emblems, trademarks, site design,
photos or other imagery are included. The current terms were read through the
web tool; direct origin HTML retrieval returned 403 and is retained as a failed
observation, not a fabricated origin-byte hash. No source's existing rights
status was upgraded by this crosswalk.

## Reproducible content identities and no double counting

The NIST source seed contains the fixed origin observations, Core transcription
digest, function order, category titles and full native definition before its
digest fields are added. Canonical source hashing sorts object keys ordinally,
preserves arrays, uses UTF-8 JSON and no insignificant whitespace. The generic
registry then calculates and enforces the profile digest. The crosswalk depends
on finalized endpoint digests; the native seed never depends on the crosswalk.

Crosswalk hashing removes only root `crosswalkSha256`, canonicalizes its known
JSON shape in the same way, prefixes exact ASCII
`no-fries-nist-ncsc-crosswalk-v1` followed by LF, then applies SHA-256. The
constructors compare literal expected pins and fail closed on drift. There is
no general ingestion framework or mutable global registry.

| Identity | SHA-256 |
| --- | --- |
| Core transcription file | d74aec7af57ae8fc7f78b55df698a316cb0bec911b6e3af3a8967c21ad2e4e4c |
| Native source catalogue | ab75b51c3561c50cb48cd21b96c01afa2aecafb2efc6b46ae4a8ef8cd753a656 |
| Native profile catalogue | ec394a65b11417b67201f96af57a7eabeb284376bb0651b816b40017476b6073 |
| Native published JSON (two-space indentation and trailing LF) | ea58442266e9676b5f5fe129428b701a20b1ff1189bc3a69e973d4e9fda7adfc |
| Accepted NCSC source catalogue | 26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee |
| Accepted NCSC profile catalogue | 32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375 |
| Reviewed accepted NCSC module bytes | 18e0b79f4527c419f09f38be4fa01b083bccbaa310a65f0de1cfdac45769fe58 |
| Crosswalk canonical publication | 61f68fba7bfd3ce9480a0db5f6e4d297bdcf1aff63e80073bffd27dc2abf1e17 |
| Crosswalk JSON (two-space indentation and trailing LF) | 4fd74a503472b531d9a408041c9b11178ae360cebe67a756ec9e754af122e54e |

NIST's 106 atoms and NCSC's fourteen atoms are independent assessment inputs.
Repeated source references retain their original `(profileRef, questionId)`
identity. They never become extra `atomInputs`, an evaluator call, a combined
score field or a shared denominator. Source evidence can inform a later explicit
review, but even an exact relationship would not grant target applicability or
copy a target answer/evidence state.

## Verification surface

From the repository root, the focused tests exercise the actual generic
publisher/evaluator, complete frozen content, explicit relationship/locator
coverage, trusted applicability decisions, endpoint drift and unchanged NCSC
results/defaults:

```sh
node node_modules/jest/bin/jest.js --runInBand test/nistFrameworkProfile.test.js test/nistNcscCrosswalk.test.js
node --check api/shared/assessmentEngine/nistFrameworkProfile.js
node --check api/shared/assessmentEngine/nistNcscCrosswalk.js
npm run validate:governance
```

Actual run counts, source reviews and exact-branch/resulting-main evidence are
recorded in the FRAME-001 ExecPlan and evidence ledger. The source construction
and tests do not claim NIST customer activation, tenant proof, deployment or
completion of another task's browser acceptance.
