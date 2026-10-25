const SERVICE_SCOPE = {
    version: '2026.08.3',
    title: 'No Fries Managed IT — standard service guide',
    summary: 'The standard service covers the people and company devices listed in the customer service schedule. No Fries provides support by phone, chat and email, looks after covered devices, helps with agreed business apps and shows the work completed each month. The schedule clearly records what is included, who can approve changes, anything that still needs attention and work that will be quoted separately.',
    appliesTo: 'Covered users and supported company laptops or desktops',
    standardisation: 'Every customer follows the same clear service and set-up process. The customer schedule lists the business apps, Protect & Recover services, people, devices, locations, authorised contacts and approval rules that apply.',
    serviceHours: {
        userSupport: 'Normal New Zealand business hours, excluding public holidays',
        aiIntake: 'Requests can be logged by phone, chat or email at any time; this is not 24/7 staffed user support',
        securityMonitoring: 'After-hours security alert review applies only when it is listed in the customer schedule'
    },
    offerStructure: [
        {
            name: 'No Fries Managed IT',
            type: 'ongoing monthly service',
            includes: 'Phone, chat and email support; remote help during business hours; care for covered devices; help with agreed business apps; supplier follow-up; and Proof every month.'
        },
        {
            name: 'No Fries Protect & Recover',
            type: 'optional ongoing protection',
            includes: 'The threat protection, after-hours security help and work-file backup services listed in the customer schedule.'
        },
        {
            name: 'No Fries Set-up & Change',
            type: 'initial set-up and separately quoted work',
            includes: 'Initial set-up and service checks, plus separately agreed projects, major fixes, on-site work and large application or cloud changes.'
        }
    ],
    sections: [
        {
            title: 'Support and ownership',
            introduction: 'No Fries is the first point of contact for covered user support, service requests and standard changes. Common low-risk requests are handled quickly. Higher-risk, uncertain or disruptive changes wait for approval or specialist help.',
            items: [
                {
                    name: 'Request logging',
                    included: 'Receive requests through the agreed phone, chat, email or customer-portal channels and record the requester, what is affected, the impact and the next action.',
                    boundary: 'Social messages and requests sent to personal accounts are not logged service requests. Callers must complete the agreed identity check before account, access or device information is shared.'
                },
                {
                    name: 'Common requests',
                    included: 'Understand the request, review the relevant customer and device information, follow the approved steps, check the result and keep the service record current.',
                    boundary: 'Changes involving privileged access, disruption, deletion, spending or work outside the agreed service require approval or specialist help.'
                },
                {
                    name: 'Phone support',
                    included: 'Provide a phone channel for logging requests, working through common problems, giving updates and handing the request to a person when needed.',
                    boundary: 'Identity checks, call recording or transcription, retention and privacy notices are listed in the customer schedule and privacy notice.'
                },
                {
                    name: 'Verified closure',
                    included: 'Close a ticket only after the technical checks pass and the requester confirms the outcome, or after the documented no-response closure period expires.',
                    boundary: 'A request that fails the final check, repeats, does not match the approved steps or shows serious risk is passed to the right person instead of being marked resolved.'
                },
                {
                    name: 'Remote user support',
                    included: 'Diagnose and resolve common computer, supported business-app, printing, accessory, connection and access issues for covered users and devices.',
                    boundary: 'On-site attendance, unsupported software and problems on personal devices are not included.'
                },
                {
                    name: 'Ticket ownership',
                    included: 'Keep one named owner, status, history and next action on each request until it is resolved, accepted as an open issue or moved into separately quoted work.',
                    boundary: 'How long a fix takes depends on the impact, access, supplier response and the availability of parts or licences.'
                },
                {
                    name: 'Supplier follow-up',
                    included: 'Open and follow up support cases with an agreed internet, software, hardware or cloud supplier when the customer has provided the required entitlement and authority.',
                    boundary: 'Supplier fees, replacement hardware and work that the supplier will not perform remain the customer’s responsibility.'
                },
                {
                    name: 'Standard service requests',
                    included: 'Handle routine password resets, approved software installation, mailbox or group changes, device checks and access requests using the agreed approval process.',
                    boundary: 'Requests that make a large change, increase security risk or cost, or affect many users are reviewed as separately quoted work.'
                }
            ]
        },
        {
            title: 'Business apps and user access',
            introduction: 'No Fries handles day-to-day user, sign-in, email and shared-work changes for the business platform listed in the customer schedule and under the customer’s approval rules.',
            items: [
                {
                    name: 'Staff joining, moving and leaving',
                    included: 'Create, change, suspend or remove user access from an authorised request; apply the agreed licence, groups and sign-in protection; and record completion.',
                    boundary: 'The customer must provide accurate instructions, ownership decisions and enough notice. Decisions about keeping or transferring data remain with the customer.'
                },
                {
                    name: 'Sign-in and account protection',
                    included: 'Administer standard sign-in protection, password resets, account suspension and agreed access groups for covered users.',
                    boundary: 'Complex sign-in rules, privileged-access programmes and account migrations are quoted separately.'
                },
                {
                    name: 'Microsoft 365 administration',
                    included: 'Perform routine administration for Exchange Online, Teams, SharePoint and OneDrive, including standard mailbox, group, permission and sharing changes.',
                    boundary: 'Applies only when Microsoft 365 is listed in the customer schedule. Major redesign, data migration, records work, legal discovery and complex SharePoint development are not included.'
                },
                {
                    name: 'Google Workspace administration',
                    included: 'Perform routine administration for Gmail, Drive, shared drives, groups, licences, standard permissions and sharing controls.',
                    boundary: 'Applies only when Google Workspace is listed in the customer schedule. Major redesign, data migration, cloud engineering, records work and application development are not included.'
                },
                {
                    name: 'Licence administration',
                    included: 'Assign and remove the customer’s existing business-app licences and flag obvious shortages or unused licences.',
                    boundary: 'Supplier licence charges are not part of the managed service unless they are shown in the signed customer schedule.'
                },
                {
                    name: 'Administrative control',
                    included: 'Use named administrator accounts, strong sign-in protection and only the access needed for the job, and record important access changes.',
                    boundary: 'No Fries does not approve its own high-risk access; the customer’s authorised contact remains the decision-maker.'
                }
            ]
        },
        {
            title: 'Company device care',
            introduction: 'Supported company laptops and desktops are added to the standard device-care service and recorded against the customer.',
            items: [
                {
                    name: 'Add devices',
                    included: 'Set up the device-care, protection and backup services listed in the customer schedule; identify the assigned user; and record key computer, operating-system and warranty information where available.',
                    boundary: 'A device must be supportable, company-authorised and able to run the required software. Unsupported devices are recorded as needing a decision.'
                },
                {
                    name: 'Health checks',
                    included: 'Check device availability, storage space, key services and selected health conditions, then record anything that needs attention.',
                    boundary: 'Health checks cannot guarantee that a device or application will not fail.'
                },
                {
                    name: 'Operating-system updates',
                    included: 'Apply the agreed computer update policy, check installation results, retry common failures and report devices that remain out of date.',
                    boundary: 'Large upgrades, unsupported operating systems and updates that need application fixes may require separately planned work.'
                },
                {
                    name: 'Supported app updates',
                    included: 'Apply updates for common supported applications and report repeated failures.',
                    boundary: 'Specialist, line-of-business and unsupported applications remain subject to their supplier’s support method.'
                },
                {
                    name: 'Remote maintenance',
                    included: 'Use approved remote tools for common checks, clean-up and fixes, with each action linked to a device or service request.',
                    boundary: 'New repeatable actions are tested on a small group before wider use and never override a customer approval requirement.'
                },
                {
                    name: 'Device list and replacement planning',
                    included: 'Maintain a working list of covered devices and identify warranty, age, operating-system or capacity risks that are visible to the service.',
                    boundary: 'This is a practical device list, not a financial asset register or certified software-licence audit.'
                }
            ]
        },
        {
            title: 'Threat protection and after-hours security help',
            introduction: 'Covered devices receive only the protection and after-hours security services listed in the customer schedule. Device care by itself does not include threat protection, after-hours alert review or backup.',
            items: [
                {
                    name: 'Threat protection',
                    included: 'Set up and maintain the agreed malware and threat-protection service on covered devices, check coverage and investigate supported alerts.',
                    boundary: 'Devices without working protection are recorded as uncovered until the customer makes them available for a fix.'
                },
                {
                    name: 'After-hours alert review',
                    included: 'When listed in the customer schedule, supported security alerts are reviewed around the clock and serious events are passed to No Fries and the nominated customer contact.',
                    boundary: 'This service depends on the selected protection plan. It covers security alerts, not round-the-clock general user support.'
                },
                {
                    name: 'Urgent protective action',
                    included: 'Isolate a covered device or block a known threat when the alert, approval and risk justify that action, then record what was done.',
                    boundary: 'Protective action can interrupt work. Major recovery, forensic work, legal notification and crisis management are handled separately.'
                },
                {
                    name: 'Ransomware warning',
                    included: 'Use the ransomware-warning features included in the selected protection service and investigate supported warnings.',
                    boundary: 'No security control prevents every attack; customer decisions, identity controls, backups and supported software remain necessary.'
                },
                {
                    name: 'Other security signals',
                    included: 'Connect agreed business-platform and firewall alerts to the security service when the customer’s services and technical connection support it.',
                    boundary: 'Unsupported products, extra history and extensive connection work are not included by default.'
                },
                {
                    name: 'Security incident record',
                    included: 'Record the alert, review, protective action, customer contact, current risk and required follow-up for a serious security event.',
                    boundary: 'The customer must maintain current after-hours contacts and decision authority.'
                }
            ]
        },
        {
            title: 'Work-file backup and recovery',
            introduction: 'When backup is listed in the customer schedule, agreed work files on covered devices are backed up and can be restored from an available recovery point.',
            items: [
                {
                    name: 'Set up backup',
                    included: 'Enable the agreed backup service on covered devices and apply the file-selection and retention settings listed in the customer schedule.',
                    boundary: 'Backup is not included with device care alone. It is not a full copy of the whole computer and does not automatically protect every local file, server, network storage device or cloud application.'
                },
                {
                    name: 'Backup monitoring',
                    included: 'Check backup status, investigate common failures and report devices that cannot complete a current backup.',
                    boundary: 'A device must be online, healthy and connected long enough to back up changed data.'
                },
                {
                    name: 'File restore',
                    included: 'Restore an available protected file or folder for an authorised covered user and record the restore result.',
                    boundary: 'Recovery is limited to data in an available recovery point and within the agreed retention period.'
                },
                {
                    name: 'Recovery check',
                    included: 'Perform and record a sample file restore during initial set-up and at the agreed regular service check.',
                    boundary: 'This does not replace an application, server or business-continuity recovery test.'
                },
                {
                    name: 'Storage decisions',
                    included: 'Track storage pressure, unusually large data sets and devices that need a backup decision.',
                    boundary: 'Extra storage and longer or unusual retention are agreed before use.'
                }
            ]
        },
        {
            title: 'Proof every month and improvements',
            introduction: 'The service produces a practical monthly record of what is covered, what was done and what needs attention next.',
            items: [
                {
                    name: 'Monthly service record',
                    included: 'Provide a clear monthly view of covered devices, update status, protection and backup coverage, support activity, serious alerts and open issues.',
                    boundary: 'The report is limited to the people, systems and devices included in the service and the information available to No Fries.'
                },
                {
                    name: 'Items needing attention',
                    included: 'Record important gaps with an owner, due date, current decision and the practical consequence of leaving the item open.',
                    boundary: 'The customer remains responsible for accepting risk or approving work and expenditure.'
                },
                {
                    name: 'Recurring service checks',
                    included: 'Run the standard review list for device coverage, updates, threat protection, backup, administrator access and overdue requests.',
                    boundary: 'This is a service health check, not an independent audit or compliance certification.'
                },
                {
                    name: 'Quarterly priorities',
                    included: 'Maintain a short, ordered view of the next practical improvements, business decisions and separately quoted work worth considering.',
                    boundary: 'Formal strategy, large system design, compliance and part-time technology leadership are separate services.'
                },
                {
                    name: 'Service review',
                    included: 'Review repeat issues, customer feedback, items needing attention and agreed next actions with the nominated customer contact.',
                    boundary: 'Meeting frequency and attendees are recorded in the customer service schedule.'
                }
            ]
        },
        {
            title: 'Getting started and service checks',
            introduction: 'Every customer follows the same clear checks before the service is treated as live.',
            items: [
                {
                    name: 'What is included and who can approve changes',
                    included: 'Confirm covered users, devices and sites; authorised contacts; suppliers; support channels; after-hours security contacts; and approval rules.',
                    boundary: 'Set-up does not begin until the customer has provided the necessary approval and access.'
                },
                {
                    name: 'Check the starting point',
                    included: 'Record the starting business apps, device condition, protection, backup, supplier and known-problem position before applying the agreed service settings.',
                    boundary: 'Previously unknown faults and older unresolved problems are recorded and prioritised rather than treated as unlimited work.'
                },
                {
                    name: 'Test representative devices',
                    included: 'Set up the service on an agreed representative group of low-risk devices, sized to the customer’s environment and rollout risk, and confirm device health, updates, applicable protection and backup, remote support and request handling.',
                    boundary: 'The remaining devices are not added until the first checks pass or the customer agrees how to handle an open issue.'
                },
                {
                    name: 'Add the rest in stages',
                    included: 'Add the remaining covered devices in agreed groups, track failures and check the device list against the service record.',
                    boundary: 'Devices not made available remain outside confirmed coverage.'
                },
                {
                    name: 'Confirm the service works',
                    included: 'Test a user support request, an urgent security issue, a sample file restore and instructions for staff joining or leaving before the service starts.',
                    boundary: 'Failed checks must be corrected or accepted as named open issues.'
                },
                {
                    name: 'Review after 30 days',
                    included: 'Review what is covered, early requests, alerts, backup status, known risks and the first ordered improvement list after the first month.',
                    boundary: 'Large fixes identified during the starting checks are quoted separately when they are outside the standard service.'
                }
            ]
        }
    ],
    customerResponsibilities: [
        'Nominate authorised contacts and maintain accurate business-hours and after-hours contact details.',
        'Provide timely approvals, administrator access, supplier support rights and supported devices for set-up and fixes.',
        'Tell No Fries promptly about new staff, role changes, departing staff, lost devices and suspected security events.',
        'Keep the agreed business-app, device-care, protection, backup and other supplier services in place and pay supplier, hardware and connection charges.',
        'Tell users about any agreed call recording or transcription and the related privacy notices.',
        'Decide data ownership, access, retention, accepted risk and spending when the service identifies an open issue.',
        'Ensure users follow the customer’s acceptable-use, security and device policies.'
    ],
    outsideScope: [
        '24/7 staffed general user support; around-the-clock request logging does not change the agreed staffed support hours.',
        'Unlimited on-site work, travel, hardware delivery or physical cabling.',
        'Unlimited remote support, repeated fixes for older unresolved problems, or work outside the agreed usage limits and supported applications.',
        'Projects such as major platform migrations, office moves, large application roll-outs or system redesign.',
        'Servers, network storage devices, production systems or industrial-control environments unless they are added in writing.',
        'Specialist application support where the supplier or customer does not provide support rights, documentation or access.',
        'Digital forensics, regulatory notification, legal advice, crisis communications and major incident recovery.',
        'Independent audit, certification, security testing, compliance assurance or part-time technology leadership.',
        'Replacement hardware, business-app licences, extra phone usage, supplier subscriptions and supplier charges unless they are listed.'
    ],
    monthlyRecord: [
        'Covered-device count and device-care coverage.',
        'Operating-system update position and devices that still need attention.',
        'Threat-protection coverage, serious alerts and recorded actions.',
        'Backup coverage, failed backups and restore-check results.',
        'Request volumes, resolved issues, items needing more help, repeat problems, older requests and supplier follow-up.',
        'Named risks or open issues with an owner, decision and next review date.',
        'The next practical service improvements or business decisions.'
    ],
    customerSchedule: [
        'Legal customer name, sites and normal business-hours timezone.',
        'Covered users, devices and any additional systems included in writing.',
        'Authorised contacts, approval levels and after-hours security contacts.',
        'Supported business platform, suppliers, licences and administrator-access method.',
        'Selected device care, threat protection, after-hours security help and backup services.',
        'Phone, chat and email channels; caller-verification method; changes that need approval; when extra help is required; recording or transcription notice; and retention period.',
        'Usage limits, expected response times, no-response closure period and separately chargeable work.',
        'Known open issues accepted when the service starts and their review dates.',
        'Meeting frequency and any separately agreed additions.',
        'Service start date and signed commercial terms.'
    ]
};

function getServiceScope() {
    return JSON.parse(JSON.stringify(SERVICE_SCOPE));
}

module.exports = {
    getServiceScope
};
