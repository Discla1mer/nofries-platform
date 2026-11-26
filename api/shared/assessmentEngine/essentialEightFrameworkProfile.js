'use strict';

const { createHash } = require('node:crypto');
const { publishFrameworkProfile } = require('./frameworkProfileRegistry');

const DATE = '2026-11-26';
const SOURCE = 'asd-e8-2023-11';
const AUTHORITY = 'Australian Signals Directorate';
const LICENCE = 'CC BY 4.0';
const SOURCE_PIN = 'a8b86a91c812efe5b683a45b4d70124a6d5d905419c893f190ad602636195df4';
const PROFILE_PIN = '44bb97f76e24e96e55b462581a91f5ba052f26172ccade7964771e0b05fc962f';
const OPTIONS = [
    { id: 'yes', label: 'Yes', applicable: true, implementationFactor: 1 },
    { id: 'partial', label: 'Partly', applicable: true, implementationFactor: 0.5 },
    { id: 'no', label: 'No', applicable: true, implementationFactor: 0 },
    { id: 'unknown', label: 'Unknown', applicable: true, implementationFactor: null }
];

// No Fries adaptation of ASD's November 2023 model, Appendix A (CC BY 4.0).
// The short keys are ours, not ASD requirement numbers. Keep them stable when editing copy.
const STRATEGIES = [
    ['apps', 'Patch applications', 'Keep the software your team and customers use up to date.',
        'A dated report from your IT provider showing which updates were installed and when.',
        'Ask your provider to show one online service and one staff app in its update report.', [
            ['find', 'Does a tool look for software assets at least every two weeks, and does your update checker use a current list of known faults?'],
            ['scan', 'Do you check online services for missing fixes daily, and office apps, browsers and their extensions, email, PDF readers and security tools at least weekly?'],
            ['online', 'For online services, do you install a fix or follow the supplier’s workaround within 48 hours of release for critical faults or faults with a known working attack, and within two weeks for other faults?'],
            ['staff', 'Do you fix office apps, browsers and extensions, email, PDF readers and security tools within two weeks of a fix becoming available?'],
            ['retire', 'Do you remove unsupported online services and staff apps, including old browser components such as Flash?']
        ]],
    ['os', 'Patch operating systems', 'Remember the software that runs computers, servers and network equipment.',
        'An inventory and update report covering work computers, servers and network devices.',
        'Choose a device with your provider and compare the fix release date with its installation date.', [
            ['find', 'Does a tool look for devices at least every two weeks, with a current list of known faults for checking their operating systems?'],
            ['scan', 'Do you check internet-facing servers and network devices for missing fixes daily, and other servers, network devices and work computers at least every two weeks?'],
            ['online', 'For internet-facing servers and network devices, do you apply a fix or supplier workaround within 48 hours of release for critical faults or faults with a known working attack, and within two weeks for other faults?'],
            ['internal', 'Do you fix operating systems on work computers, internal servers and internal network devices within one month of a fix becoming available?'],
            ['retire', 'Do you replace operating systems when their supplier stops providing security fixes?']
        ]],
    ['mfa', 'Multi-factor authentication', 'Make a password alone insufficient to get into important online services.',
        'A sign-in settings report for staff and customer accounts, including services a supplier hosts.',
        'List your online services and ask the owner of each how a user proves who they are.', [
            ['staff', 'Do staff need more than a password for every online service that handles sensitive business or customer information, whether you or a supplier runs it?'],
            ['other', 'For supplier services that handle only non-sensitive business information, do staff use a second factor wherever the service offers it?'],
            ['customers', 'Do customers also need a second factor to sign in to services that handle their sensitive information?'],
            ['factors', 'Do people need a device or key as well as a password, or use a device or key unlocked by a PIN or fingerprint?']
        ]],
    ['admin', 'Restrict administrative privileges', 'Separate everyday work from work that can change systems or other people’s access.',
        'A record approving someone’s admin access and the separate account and workspace they use.',
        'Walk through one person’s admin access with your IT provider, from approval to sign-in.', [
            ['approve', 'Does someone check the need before granting powerful access to systems, apps or stored data?'],
            ['dedicated', 'Do administrators use a separate account just for tasks that need extra rights?'],
            ['online', 'Are admin accounts blocked from email, browsing and other internet access, except for the specific online services approved for their job?'],
            ['separate', 'Is admin work done in a separate work environment that blocks ordinary accounts, with admin accounts blocked from ordinary environments except local device administrators?']
        ]],
    ['app-control', 'Application control', 'Work computers should only run code your business has approved.',
        'The allow-list policy for a work computer, including download and temporary folders.',
        'Ask your provider to show which files the policy covers on a typical work computer.', [
            ['allow', 'Do your work computers block unapproved programs, libraries, scripts, installers, compiled HTML help files, HTML apps, and control panel tools?'],
            ['folders', 'Does that rule cover people’s profile folders and the temporary folders Windows, browsers and email apps use?']
        ]],
    ['macros', 'Restrict Microsoft Office macros', 'A macro is a set of instructions embedded in an Office document.',
        'Office policy showing who can run macros, how they are checked and which files are blocked.',
        'Ask who needs macros for their work and compare that list with the Office settings.', [
            ['need', 'Are Office macros switched off unless someone has shown they need them for work?'],
            ['internet', 'Even for people allowed to use macros, are macros blocked in documents from the internet?'],
            ['settings', 'Does antivirus check Office macros, and are staff prevented from changing the macro security settings?']
        ]],
    ['browser', 'User application hardening', 'Lock down browser features your team does not need.',
        'The browser policy applied to a staff computer.',
        'Check the settings on one staff computer with your provider rather than relying on a policy document.', [
            ['legacy', 'Is Internet Explorer 11 disabled or removed from work computers?'],
            ['block', 'Do work browsers block internet advertisements and prevent Java content from the internet from running?'],
            ['lock', 'Are staff prevented from changing the browser security settings?']
        ]],
    ['backup', 'Regular backups', 'Make sure you can restore the business, not just find a copy of a file.',
        'The backup schedule, access settings and a dated record of a recovery practice.',
        'Choose a business service and ask to see when it was last restored from backup in a practice run.', [
            ['schedule', 'Do you back up important data, apps and settings often enough, and keep the copies long enough, for the business to recover?'],
            ['protect', 'Are backups kept somewhere secure that can survive the loss of a system, with ordinary accounts unable to change or erase copies or read someone else’s backups?'],
            ['restore', 'Are backups lined up to the same recovery point, and have you practised restoring the data, apps and settings together to that point?']
        ]]
];

function createEssentialEightFrameworkProfile() {
    const sourceCatalogueSha256 = createHash('sha256').update(JSON.stringify(STRATEGIES)).digest('hex');
    if (sourceCatalogueSha256 !== SOURCE_PIN) throw new Error('essential_eight_source_digest_mismatch');
    const sourceIds = [SOURCE];
    const domains = [], controls = [], questions = [];
    for (const [key, title, summary, evidence, action, items] of STRATEGIES) {
        const guidance = { summary, evidenceExamples: [evidence], startingActions: [action] };
        const controlId = 'ml1-' + key;
        domains.push({ id: key, title, order: domains.length + 1, guidance, sourceIds });
        controls.push({ id: controlId, domainId: key, title, order: controls.length + 1, guidance, sourceIds,
            sourceReferences: [{ sourceId: SOURCE, referenceId: 'appendix-a-' + key, order: 1 }] });
        items.forEach(([id, prompt], index) => questions.push({
            id: controlId + '-' + id, controlId, order: index + 1, prompt, weight: 1,
            responseOptionIds: OPTIONS.map(o => o.id), guidance, sourceIds
        }));
    }

    return publishFrameworkProfile({
        schemaVersion: 1, status: 'published', publishedAt: DATE, catalogueSha256: PROFILE_PIN, sourceCatalogueSha256,
        framework: { id: 'asd-essential-eight', version: '2023-11', title: 'Essential Eight maturity model',
            authority: AUTHORITY, description: 'November 2023 edition, Appendix A: Maturity Level One.', sourceIds },
        profile: { id: 'nf-essential-eight-ml1', version: '2026-11-26.1', title: 'Essential Eight: Maturity Level One self-check',
            effectiveFrom: DATE, description: 'Check everyday safeguards across eight strategies for your business.', sourceIds },
        statements: {
            attribution: 'Australian Signals Directorate, Essential Eight maturity model (November 2023), © Commonwealth of Australia 2023, CC BY 4.0. No Fries adapted Appendix A into questions, examples and actions.',
            basis: 'Answer for all the people, systems and services in the scope you chose. Include work your IT provider does for you.',
            claim: 'This is a self-check. It does not establish a maturity level or imply ASD endorsement.',
            limitations: ['Choose Partly when the safeguard covers only some of the scope or only some of the steps.',
                'Choose Unknown if you cannot confirm the answer. Unknown does not mean No or that the question does not apply.',
                'Use the source model for full requirements and exceptions. An average across strategies cannot establish Maturity Level One.']
        },
        sources: [{ id: SOURCE, title: 'Essential Eight maturity model: Appendix A', authority: AUTHORITY,
            url: 'https://www.cyber.gov.au/sites/default/files/2025-03/Essential%20Eight%20maturity%20model%20%28November%202023%29.pdf',
            version: '2023-11', lastVerifiedAt: DATE, rightsStatus: 'verified', licence: LICENCE,
            licenceUrl: 'https://creativecommons.org/licenses/by/4.0/', reviewDueAt: '2027-11-26', reviewCadence: 'annual' }],
        domains, controls, questions, responseOptions: OPTIONS
    });
}

module.exports = { createEssentialEightFrameworkProfile };
