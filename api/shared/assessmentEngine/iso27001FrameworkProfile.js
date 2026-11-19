'use strict';

const crypto = require('node:crypto');
const { publishFrameworkProfile } = require('./frameworkProfileRegistry');

const SOURCE_ID = 'iso-iec-27001-2022';
const DATE = '2026-11-19';
const TITLE = 'ISO 27001 readiness self-assessment';
const SOURCE_SHA256 = '0221ff4667e5471a50711bd4e64ae56b5f253889cdcc9817ce3bfdfda4dc5654';
const PROFILE_SHA256 = '58e37797ea4bf926ab0477522857cb9dd0ac2a84d3e1815829dee9b2390bd107';

const DOMAINS = [
    ['C4', 'Clause 4 · Scope and expectations', 'Describe the work, people and services covered by your answers.'],
    ['C5', 'Clause 5 · Leadership decisions', 'Consider the direction and support your leaders give teams.'],
    ['C6', 'Clause 6 · Risks and plans', 'Follow a risk from the first discussion to the work agreed.'],
    ['C7', 'Clause 7 · Support for staff', 'Consider the skills, resources and information people use.'],
    ['C8', 'Clause 8 · Putting plans to work', 'Look for recent examples from day-to-day operations.'],
    ['C9', 'Clause 9 · Checking results', 'Consider how teams and leaders decide whether the programme works.'],
    ['C10', 'Clause 10 · Learning and fixing', 'Look for changes that have made a lasting difference.'],
    ['A.5', 'Organisational safeguards', 'Consider how decisions, suppliers and working agreements protect information.'],
    ['A.6', 'People safeguards', 'Consider the support people receive from recruitment through departure.'],
    ['A.7', 'Physical safeguards', 'Consider the places, equipment and utilities your services depend on.'],
    ['A.8', 'Technological safeguards', 'Consider the systems that store, process and carry your information.']
];

const OPTIONS = [
    { id: 'not_started', label: 'Not started', applicable: true, implementationFactor: 0 },
    { id: 'partly_in_place', label: 'Partly in place', applicable: true, implementationFactor: 0.5 },
    { id: 'in_place', label: 'In place', applicable: true, implementationFactor: 1 },
    { id: 'in_place_with_evidence', label: 'In place with evidence', applicable: true, implementationFactor: 1 },
    { id: 'not_applicable', label: 'Not applicable with a reason', applicable: false, implementationFactor: null }
];

// Fixed authored rows: control ID, short title, question, why it matters, evidence example, next step.
// A.5–A.8 use the 2022 control numbering. C identifies our samples of the management-system clauses.
const ITEMS = [
    ["C4.1", "What shapes our risks", "Have you identified changes inside and outside the organisation that could affect how you protect information?",
        "Changes in customers, technology or climate can upset yesterday's assumptions.", "Notes from a planning meeting that link a change to a risk.", "Discuss one recent change with a service owner and record its effect."],
    ["C4.2", "Know whose requirements apply", "Have you identified whose information security requirements apply to your organisation, including duties set by law and by contract?",
        "A team can miss a duty if it only tracks what customers have asked for.", "A register showing who sets each requirement, where it is written and who looks after it.", "Trace one legal duty and one contract term to the teams responsible for meeting them."],
    ["C4.3", "Draw the boundary", "Have you written down which teams, sites and services you cover, including their dependencies?",
        "A vague boundary lets two teams assume the other protects the same information.", "A scope note showing a hosted service and the team that manages it.", "Walk through one customer journey and mark where information crosses the boundary."],
    ["C4.4", "How the work fits together", "Can staff follow how security decisions move from a concern through to a checked result?",
        "A risk can sit between teams if nobody owns the handover.", "A diagram that follows a risk decision into a review meeting.", "Trace one decision and agree who receives the outcome."],
    ["C5.1", "Leaders take part", "Can leaders show a recent decision where they backed a security priority with time or money?",
        "Staff need resources and visible support to carry out difficult changes.", "A leadership decision releasing staff time to fix a recurring issue.", "Take one blocked improvement to the person who can fund it."],
    ["C5.2", "Direction people can use", "Have leaders shared a current policy that staff can use when choosing how to handle information?",
        "A clear direction gives staff a basis for everyday decisions.", "A policy update and the message that explained it to staff.", "Ask a team member how the policy applies to a task they do."],
    ["C5.3", "Who can decide", "Do people know who can accept risk, direct security work and report its progress to leaders?",
        "Unclear authority can leave an urgent decision waiting.", "A role list naming the decision maker and their deputy.", "Check who would decide if the usual owner were away."],
    ["C6.1.2", "Compare risks consistently", "Do teams use agreed criteria to identify information risks and opportunities and decide which risks need attention first?",
        "Two teams may otherwise assign very different priorities to similar losses.", "Two risk entries assessed against the same likelihood and impact criteria.", "Rate one example together and record how the team reached its judgement."],
    ["C6.1.3", "Choose and justify safeguards", "Have risk owners agreed the work, the remaining risk and the reasons for including or excluding Annex A safeguards?",
        "A list of safeguards is only useful when people can explain what each one protects.", "A risk treatment decision linked to a Statement of Applicability entry.", "Trace one significant risk to the chosen safeguard and the owner's decision."],
    ["C6.2", "Give goals a measure", "Does each security goal have an owner, resources, a due date and a way to tell whether it was met?",
        "Teams can complete plenty of tasks without achieving the intended result.", "A goal to restore a service within an agreed time, with a named owner.", "Pick one goal and write down how and when you will measure it."],
    ["C6.3", "Change the programme deliberately", "Do you plan how changes to your security programme will affect people and existing work?",
        "A new process can quietly remove a check that another team depends on.", "A transition plan for moving responsibility between teams.", "Ask the receiving team to rehearse one handover."],
    ["C7.1", "Make time for the work", "Have you set aside enough people, tools and time to run the security work in scope?",
        "An owner cannot meet a deadline if all their time is already committed.", "A quarterly work plan with hours set aside for recovery exercises.", "Compare the next three commitments with the team's available time."],
    ["C7.2", "Build skills and understanding", "Can people show the skills their security tasks need and explain why their choices matter?",
        "Staff need both practical ability and a reason to use it under pressure.", "A supervisor's sign-off after a staff member practises a recovery task.", "Observe one task and arrange help with the least familiar step."],
    ["C7.4", "Get the message through", "Have you agreed who communicates security information to whom, when and how?",
        "An urgent decision may stall if nobody knows who should hear it.", "A communications schedule for customers and internal service owners.", "Try reaching a deputy through the agreed channel."],
    ["C7.5", "Keep instructions current", "Can staff find the approved version of a security record or instruction and tell who may change it?",
        "Using an old procedure can undo a recent improvement.", "A version history showing approval and withdrawal of a previous instruction.", "Check the link in a team handbook and retire any superseded copy."],
    ["C8.1", "Run the work as agreed", "Can you show that routine security work and work done by suppliers follow the agreed checks?",
        "A plan can look sound while everyday work skips a critical step.", "A completed service handover with its acceptance checks.", "Sample a busy shift and follow one task from start to sign-off."],
    ["C8.2", "Revisit real risks", "Do you reassess risks on a timetable and after changes that could alter their impact?",
        "A growing service may outgrow the assumptions behind its last risk rating.", "A revised rating after a supplier moved a service.", "Choose a recent service change and review the affected risk entries."],
    ["C8.3", "Carry out the treatment", "Can owners show which risk treatments they finished and what remains exposed?",
        "Marking work as planned leaves the original risk in place.", "A completed treatment ticket with its result and outstanding work.", "Check one completed action with the team that relies on it."],
    ["C9.1", "Measure what happens", "Do you collect and interpret measures that tell you whether your safeguards work?",
        "A rising count can signal either better detection or more incidents.", "A trend graph annotated with the service owner's interpretation.", "Choose a measure and record what would prompt a decision."],
    ["C9.2", "Check your own programme", "Do impartial reviewers examine the programme on a schedule and report findings to the people responsible?",
        "Someone outside the work can spot gaps that its owners have grown used to.", "A review plan, a sample finding and a record of who received it.", "Arrange for someone independent of the task to check a sample."],
    ["C9.3", "Leaders review progress", "Do leaders regularly consider results, feedback and changes, then record what they decide?",
        "A review only leads to improvement when decisions reach the people doing the work.", "Meeting minutes assigning a resource decision and a follow-up date.", "Take one unresolved trend to the next leadership meeting."],
    ["C10.1", "Keep improving the programme", "Do you use feedback and results to choose improvements and check their effect?",
        "A modest change can be repeated elsewhere once its benefit is clear.", "Before-and-after results from simplifying an access request.", "Pick one friction point and check the outcome after changing it."],
    ["C10.2", "Stop a problem recurring", "When a requirement is missed, do you put it right, find its cause and check the fix lasts?",
        "Fixing a single case can leave the same fault waiting in another team.", "A closed corrective action with a later check on a second sample.", "Trace one repeat issue to its cause and set a date to retest."],
    ["A.5.1", "Keep policy useful", "Do staff have current, approved security rules that make sense for the work they do?",
        "People make inconsistent choices when the only guidance is out of date.", "A policy owner's review note after a new service launched.", "Ask one team to apply its guidance to a recent decision."],
    ["A.5.2", "Assign safeguard owners", "Can each team name the person accountable for its safeguards and the person who carries them out?",
        "A recurring check can go undone when everyone thinks somebody else owns it.", "A team roster showing who reviews backup failures.", "Give one unowned check a named owner and deputy."],
    ["A.5.3", "Split sensitive decisions", "Do separate people request and approve changes where one person could misuse both powers?",
        "A second pair of eyes can catch an error or an unauthorised payment.", "A payment change with a requester and a different approver.", "Find one sensitive workflow and check how approvals are separated."],
    ["A.5.4", "Managers set expectations", "Do supervisors explain the security rules for their teams and follow up when practice drifts?",
        "Staff take their cue from what managers check in daily work.", "A team briefing followed by a manager's check of a sample handover.", "Ask a supervisor to review one routine with their team."],
    ["A.5.5", "Reach the right authority", "Can the duty team reach the appropriate public authority when a security matter calls for it?",
        "Time spent finding an official contact can delay action.", "A dated contact card with an after-hours route.", "Confirm the appropriate channel using the authority's published details."],
    ["A.5.6", "Learn from peers", "Does someone bring relevant security advice from trusted professional groups back to your team?",
        "Peers may notice a sector-wide change before it reaches your organisation.", "A sector briefing that led to a change in a team checklist.", "Assign someone to bring one relevant update to the next team meeting."],
    ["A.5.7", "Act on threat reports", "Do you assess threat reports against your own services and decide whether to act?",
        "A warning has little value until someone checks whether it affects your work.", "A threat bulletin with the affected service and the owner's decision.", "Review a recent bulletin against your current service list."],
    ["A.5.8", "Include security in projects", "Do project teams decide early which information risks to handle before delivery?",
        "Finding a security need late can force teams to redo finished work.", "A project decision log with a safeguard agreed before design sign-off.", "Add a risk discussion to the next project planning session."],
    ["A.5.9", "Know what you look after", "Do you keep an up-to-date list of important information and the assets and owners it depends on?",
        "An overlooked device or dataset can miss protection when a service changes.", "An inventory entry linking a customer dataset to a service and owner.", "Reconcile one team's live services against the inventory."],
    ["A.5.10", "Set boundaries for everyday use", "Can staff explain how they may use work devices, accounts and information?",
        "A convenient personal tool can take business information outside its intended setting.", "An induction example covering personal email and work files.", "Discuss a common grey area and add the agreed answer to staff guidance."],
    ["A.5.11", "Get issued items back", "Do you check that people return work equipment and information when their role ends or changes?",
        "A forgotten device can retain access or local copies of records.", "A handover receipt matched to an equipment issue record.", "Compare one recent departure with its issue list."],
    ["A.5.12", "Sort information by sensitivity", "Do owners decide how much protection each kind of information needs?",
        "Routine notices and sensitive client records call for different handling.", "A team register identifying the sensitivity of a customer file set.", "Classify one shared folder with its owner."],
    ["A.5.13", "Make handling cues visible", "Can a person receiving a file recognise its handling requirements from its label or context?",
        "A clear cue helps the recipient choose a suitable channel or storage location.", "A labelled sample report and a guide explaining its marking.", "Send a sample to a colleague and ask how they would handle it."],
    ["A.5.14", "Send information safely", "Do staff check the recipient, method and agreed handling rules before sharing information?",
        "A correct file sent to the wrong destination is hard to recover.", "A transfer checklist for sending a customer export.", "Walk through a routine transfer and verify the recipient list."],
    ["A.5.15", "Set access boundaries", "Have you agreed who should be able to enter each service or area and for what work?",
        "Written boundaries give owners a basis for granting and refusing requests.", "An access matrix linking job tasks to systems and rooms.", "Review one team's roles with the owners of the resources it uses."],
    ["A.5.16", "Track account ownership", "Can you trace every staff, contractor and service identity from creation to retirement?",
        "An account with no known owner can survive long after its purpose ends.", "An identity register entry with a sponsor and expiry date.", "Find accounts without a current owner and reconcile them."],
    ["A.5.17", "Protect sign-in secrets", "Do you issue, store and replace sign-in secrets through channels that protect them from others?",
        "A secret exposed during setup can defeat later sign-in checks.", "A record of a temporary credential delivery and mandatory replacement.", "Check how a new starter receives their first sign-in secret."],
    ["A.5.18", "Review granted access", "Do resource owners approve, revisit and promptly remove rights as people's work changes?",
        "Permissions often accumulate after transfers between teams.", "A dated access review showing a removed permission.", "Compare one transferred person's old and new permissions."],
    ["A.5.19", "Understand supplier exposure", "Before relying on a supplier, do you identify the information and services it could put at risk?",
        "A small supplier may hold the only working copy of an essential record.", "A supplier assessment linked to the service it supports.", "Rank suppliers by the harm their loss or misuse could cause."],
    ["A.5.20", "Put promises in supplier terms", "Do supplier agreements state the security duties each side has accepted?",
        "During an incident, an unwritten expectation is difficult to rely on.", "An agreed contract schedule covering incident notices and data return.", "Compare one live agreement with the risks identified at purchase."],
    ["A.5.21", "Follow risks through the supply chain", "Do you work with your technology suppliers to identify risks further up their supply chains and check that agreed actions are completed?",
        "A fault at a supplier's supplier can interrupt your service even when your direct supplier is ready to help.", "A review of a key supplier's reliance on one component, with a named owner and a test of the agreed fallback.", "Ask a supplier which dependency could stop delivery, agree what to do about it and set a date to check the result."],
    ["A.5.22", "Check suppliers over time", "Do owners review the service actually delivered and assess security effects of supplier changes?",
        "A supplier may change hosting or support arrangements after the contract starts.", "A service review noting a hosting change and follow-up.", "Put the next security review on the supplier owner's calendar."],
    ["A.5.23", "Plan the cloud service lifecycle", "Have you agreed who secures a cloud service from selection through use and exit?",
        "A gap between your duties and the provider's duties can expose data.", "A responsibility table and a tested data export for one cloud service.", "Check who owns backups and what happens when the subscription ends."],
    ["A.5.24", "Prepare the response team", "Have the people who would handle an incident practised their roles and communication routes?",
        "A first rehearsal during a real incident wastes recovery time.", "Exercise notes showing who took decisions and who briefed customers.", "Rehearse the first hour of a service interruption."],
    ["A.5.25", "Decide what needs a response", "Can staff consistently judge a reported event and decide when to declare an incident?",
        "A routine alert and an urgent customer incident need different treatment.", "A triage record showing severity and the reason for escalation.", "Compare two recent events against the agreed escalation criteria."],
    ["A.5.26", "Follow the incident through", "Do responders coordinate containment, recovery and communication until an incident is closed?",
        "Uncoordinated action can restore one service while another remains at risk.", "A response timeline with recovery checks and a closure decision.", "Review one closed incident for a clear decision at each handover."],
    ["A.5.27", "Turn incidents into changes", "Do incident reviews lead to changes that somebody checks afterwards?",
        "Teams otherwise spend time handling the same avoidable disruption.", "A lesson from an incident linked to a completed change.", "Assign the most important lesson an owner and review date."],
    ["A.5.28", "Preserve reliable evidence", "Can responders retain relevant records and track who handled them after an incident?",
        "An altered or untraceable record can leave the cause uncertain.", "A collection log with timestamps, integrity checks and handovers.", "Practise collecting a harmless sample and recording its custody."],
    ["A.5.29", "Keep safeguards during disruption", "Do fallback working arrangements still protect sensitive information?",
        "Emergency workarounds can move sensitive decisions into uncontrolled channels.", "A continuity exercise noting how temporary access was restricted.", "Review one manual workaround for privacy and access risks."],
    ["A.5.30", "Prove technology can recover", "Can your technology teams restore priority services within the times the business needs?",
        "A backup alone cannot show that people can resume work in time.", "A timed exercise with actual recovery and data-loss results.", "Test recovery of one critical dependency against its target."],
    ["A.5.31", "Keep track of obligations", "Does someone track the laws and agreements that affect your information and changes to them?",
        "A new obligation can change how long a record may be kept or who may see it.", "An obligations register with owners and review dates.", "Check a recent contract change against the register."],
    ["A.5.32", "Respect rights in others' work", "Do you check permission before using software, images, documents or other people's material?",
        "Paying for a copy does not always cover how the team plans to use it.", "A licence record linked to an installed tool or published image.", "Review the permission for one frequently reused asset."],
    ["A.5.33", "Keep records reliable", "Can you retain and retrieve important records while protecting them from loss or alteration?",
        "A missing or changed record can make a business decision hard to verify.", "A retrieval test for a retained decision record.", "Choose one record type and check protection through to disposal."],
    ["A.5.34", "Look after personal details", "Do owners know which personal details they hold and how to protect people throughout their use?",
        "Combining ordinary details can expose more about a person than intended.", "A data flow with a retention decision and access owner.", "Trace one personal detail from collection to deletion."],
    ["A.5.35", "Invite a fresh set of eyes", "Do independent reviewers examine how you manage security after major changes and at agreed intervals?",
        "A reviewer outside the work can challenge assumptions shared by the team.", "An independent review report and the owner's response.", "Name a reviewer with enough independence to challenge one service."],
    ["A.5.36", "Check practice against your rules", "Do managers check whether teams follow the security rules that apply to their work?",
        "A documented rule can drift away from the way work actually happens.", "A sample check that found and corrected an exception.", "Check one team against a rule it uses each week."],
    ["A.5.37", "Write repeatable instructions", "Can a colleague safely complete critical routine tasks using the current instructions?",
        "A service becomes fragile when only one person knows the sequence.", "A runbook updated after a colleague rehearsed a restart.", "Have a second person follow one procedure and note the gaps."],
    ["A.6.1", "Check before assigning trust", "Do you carry out proportionate, lawful checks before putting someone in a trusted role?",
        "A role with access to sensitive work may justify checks beyond a standard interview.", "A recruitment checklist recording completion of the agreed checks.", "Review one role and explain why each check is necessary."],
    ["A.6.2", "Agree duties at the start", "Do people accept clear security responsibilities before they start the work?",
        "Unstated expectations are harder to explain after something goes wrong.", "A signed employment agreement with a role-specific security schedule.", "Compare a recent starter's agreement with their actual duties."],
    ["A.6.3", "Practise the right skills", "Do staff and contractors receive security learning suited to their tasks, with chances to practise?",
        "Someone answering account queries faces different decisions from a server administrator.", "A practice exercise for the customer support team with feedback.", "Ask one team to rehearse its most common security decision."],
    ["A.6.4", "Handle misconduct fairly", "Do people know how suspected breaches of workplace security rules will be investigated and handled?",
        "A predictable process helps managers respond fairly and consistently.", "An induction note pointing to the agreed disciplinary procedure.", "Check that supervisors know whom to involve before taking action."],
    ["A.6.5", "Carry duties through a role change", "Do people understand which security duties continue when they move jobs or leave?",
        "Someone may retain confidential knowledge long after their access ends.", "A departure record covering continuing confidentiality duties.", "Discuss ongoing obligations at the next role handover."],
    ["A.6.6", "Agree how to keep confidences", "Have the people handling sensitive information agreed what they may share and for how long?",
        "Different assumptions about sharing can undo a customer's trust.", "A signed agreement linked to the type of information shared.", "Check one contractor's confidentiality terms against their current work."],
    ["A.6.7", "Protect work away from the office", "Can people protect work information when using home networks, travelling or sharing space?",
        "Private conversations and screens can be exposed outside the usual workspace.", "A remote-work checklist covering devices, calls and lost equipment.", "Ask a remote colleague to test the lost-device reporting route."],
    ["A.6.8", "Make concerns easy to report", "Can everyone quickly report something suspicious through a route that gets a response?",
        "An early report can give the team time to limit harm.", "A sample staff report with a response time and acknowledgement.", "Ask a new starter to find the reporting route without help."],
    ["A.7.1", "Control entry at the boundary", "Do the barriers around your protected work areas prevent people from entering without permission?",
        "A person who can walk straight from a public area into a restricted room can reach the equipment inside.", "A site check showing that a visitor can reach reception but needs staff assistance to go further.", "Walk each public approach with the site owner and check that doors, gates or staffed entry points restrict access."],
    ["A.7.2", "Control who comes in", "Do you check who enters protected spaces and remove entry rights when they expire?",
        "A borrowed pass or unescorted visitor can bypass digital access checks.", "A visitor sign-in matched to a host and departure time.", "Sample a day's visitor records against the entry rules."],
    ["A.7.3", "Secure the rooms you use", "Are doors, windows and room arrangements suited to the information and equipment inside?",
        "Sensitive work may be visible or reachable after the team goes home.", "A closing check for a room holding customer files.", "Inspect one room from the adjoining public space."],
    ["A.7.4", "Notice unexpected entry", "Would someone detect and respond to unauthorised entry into a protected space?",
        "An alarm is useful only if the alert reaches someone who can act.", "A door alarm test with the response time recorded.", "Run an agreed test with the person on duty."],
    ["A.7.5", "Prepare sites for local hazards", "Have you assessed hazards such as floods, earthquakes and fire and protected vulnerable equipment?",
        "A single physical event can remove several services at once.", "A site risk review showing why equipment was relocated.", "Check one critical room against the site's most likely hazards."],
    ["A.7.6", "Work safely inside restricted rooms", "Do people know what they may bring, do and record inside sensitive work areas?",
        "An authorised visitor can still expose information while inside.", "A secure-room briefing covering supervision and photography.", "Review the rules with a contractor before their next visit."],
    ["A.7.7", "Clear unattended workspaces", "Do people lock screens and put sensitive papers away when leaving a workspace?",
        "A short absence can leave private material in view of a visitor.", "A walk-through noting an unattended screen and the follow-up.", "Check what a visitor could see during a lunch break."],
    ["A.7.8", "Place equipment out of harm's way", "Is important equipment positioned to avoid accidental damage and casual viewing or access?",
        "A device beside a public counter or a water pipe has avoidable exposure.", "A room layout showing a moved terminal or protected cabinet.", "Inspect the placement of one shared terminal with its users."],
    ["A.7.9", "Track equipment off site", "Can you account for work equipment taken off site and protect it while it is away?",
        "Items in transit can be lost without anyone noticing promptly.", "A loan record with an assigned holder and expected return date.", "Check who holds each device lent out this month."],
    ["A.7.10", "Follow removable media from issue to disposal", "Do you control how storage media are issued, carried, stored and retired?",
        "A tiny drive can carry a large volume of sensitive records.", "A media register with an encrypted drive's issue and destruction records.", "Follow one drive through every stage of its use."],
    ["A.7.11", "Keep equipment running in an outage", "Have you tested how you will keep critical equipment running if power, cooling or another essential service fails?",
        "Backup power may keep a server on while a loss of cooling forces it to shut down.", "An exercise record showing how long backup power and cooling kept a critical system running under load.", "Agree a safe test with the site owner, compare the measured run time with the time the service needs and address any shortfall."],
    ["A.7.12", "Protect cables and connections", "Are important power and data cables protected from damage, interference and unauthorised connection?",
        "An exposed cable can interrupt a whole floor or connect an unexpected device.", "A site inspection noting a secured patch cabinet.", "Trace one critical cable and protect its most exposed section."],
    ["A.7.13", "Maintain equipment safely", "Do you service equipment on time and control who can handle it during repairs?",
        "Poor maintenance affects availability and may expose stored information.", "A service record naming the technician and the checks after repair.", "Review the next repair with the owner before the device leaves site."],
    ["A.7.14", "Clear devices before their next use", "Do you verify that information and credentials are removed before equipment is reused or disposed of?",
        "A retired device may still hold a previous user's files.", "A disposal record with device ID and verified erasure result.", "Match one retired device to proof of erasure or destruction."],
    ["A.8.1", "Protect devices people work on", "Are laptops, phones and other work devices set up and maintained to protect the information they handle?",
        "Work routinely leaves the office on a device small enough to lose.", "A device management report showing encryption and screen-lock coverage.", "Check one device against the setup agreed for its role."],
    ["A.8.2", "Limit administrator powers", "Do you give out elevated access only for an agreed purpose and review when it should end?",
        "A mistake with administrator rights can affect everyone using a service.", "A time-limited administrator grant with an owner and expiry.", "Review standing administrator grants and remove those no longer needed."],
    ["A.8.3", "Restrict access to actual records", "Do your systems limit which records and functions each person can use for their job?",
        "Signing in successfully should not expose another team's confidential files.", "A role test showing which customer folders a test account can see.", "Try an ordinary test account against a restricted sample record."],
    ["A.8.4", "Guard the code people ship", "Do you restrict who can read or change source repositories, build tools and shared libraries?",
        "Unreviewed access to source can affect every user of the resulting software.", "A repository permission review that removed an obsolete contributor.", "Check the access list on one production repository."],
    ["A.8.5", "Check who is signing in", "Do sensitive services verify users in a way that fits the risk, including during account recovery?",
        "A weak recovery route can undo otherwise strong sign-in checks.", "A sign-in configuration and a completed recovery exercise.", "Walk through recovery for a sensitive service using a test account."],
    ["A.8.6", "Plan for busy periods", "Do you measure service capacity and act before demand exceeds available resources?",
        "Ordinary growth can cause an outage without any equipment failing.", "A capacity graph with an agreed point for increasing storage.", "Compare the busiest recent period with your available headroom."],
    ["A.8.7", "Keep harmful software out", "Do you combine protective tools and staff routines to prevent and detect harmful software?",
        "An unprotected device can interrupt work for an entire team.", "A protection coverage report with a resolved gap.", "Check how the team notices when protection stops reporting."],
    ["A.8.8", "Deal with known weaknesses", "Do owners identify affected technology, prioritise fixes and check that the work succeeded?",
        "A published fix helps only after the affected systems receive it.", "A patch ticket linking an affected version to a verified update.", "Review the oldest outstanding high-priority fix with its owner."],
    ["A.8.9", "Keep settings under control", "Do you define safe settings and spot when live systems drift away from them?",
        "An overlooked setting can undo an otherwise careful deployment.", "A configuration comparison with an approved exception.", "Compare one live service with its agreed baseline."],
    ["A.8.10", "Remove information when due", "Do you remove information from relevant systems once its agreed retention period ends?",
        "Old copies can expose people and increase the work needed during an incident.", "A deletion job result matched to a retention rule.", "Trace an expired sample through active storage and backup expiry."],
    ["A.8.11", "Hide details people do not need", "Do you conceal sensitive values when a role needs only part of a record?",
        "A support worker may need to identify an account without seeing every private detail.", "A sample view showing only the last few digits of an account number.", "Compare one support screen with the minimum details needed for the task."],
    ["A.8.12", "Spot information leaving unexpectedly", "Do you prevent or detect sensitive information being sent beyond approved destinations?",
        "A misaddressed message or open sharing link can spread information quickly.", "A test showing a warning on a harmless sample marked sensitive.", "Test a common outbound channel with a synthetic example."],
    ["A.8.13", "Restore a usable copy", "Do you keep protected backup copies and regularly prove you can recover the information you need?",
        "A successful backup message does not tell you whether the restored data will open.", "A restore log showing a user checked the recovered file.", "Restore one representative dataset to an isolated location."],
    ["A.8.14", "Provide a working fallback", "Can critical processing continue if a component or site fails?",
        "Two copies in the same failure zone may stop at the same time.", "A failover exercise with the interruption and recovery time recorded.", "Identify one shared dependency between a service and its standby."],
    ["A.8.15", "Keep a trustworthy event history", "Do important systems record useful events and protect those records from alteration or early loss?",
        "A missing history makes it difficult to reconstruct a service failure.", "A retained event entry with restricted write access.", "Trace a test change through to the protected event store."],
    ["A.8.16", "Notice unusual activity", "Does someone review unusual behaviour and follow up alerts affecting important services?",
        "An alert that nobody investigates cannot reduce harm.", "An alert ticket with an investigation outcome and response time.", "Generate an agreed harmless event and check who receives it."],
    ["A.8.17", "Put events on the same clock", "Do systems use trusted time sources so staff can put events in the right order?",
        "Even a small clock difference can make two related events look unrelated.", "A time-drift report for the systems behind one service.", "Compare timestamps across a short test transaction."],
    ["A.8.18", "Control tools with exceptional powers", "Do you limit and record use of tools that can bypass normal system safeguards?",
        "A powerful maintenance tool can reach records ordinary accounts cannot.", "An approved maintenance session showing the tool used and its operator.", "Identify one such utility and check who can run it."],
    ["A.8.19", "Approve software on live systems", "Do you control who can install software on operational devices and how it is checked?",
        "An unplanned installation can change a service or introduce an unsupported dependency.", "An approved installation record with the package source and version.", "Compare a live software inventory with the approved list."],
    ["A.8.20", "Manage the network boundary", "Do you protect and manage the connections and devices that carry your organisation's traffic?",
        "A forgotten network device can become an unmonitored connection to a critical system.", "A network diagram with owners for gateways and remote links.", "Reconcile one site diagram against the connections actually in use."],
    ["A.8.21", "Know what network providers deliver", "Have you agreed the security features and service levels of your network services and checked delivery?",
        "A provider may assume that your team operates a safeguard you expected them to supply.", "A service agreement and review of its security commitments.", "Verify one promised feature with the person operating it."],
    ["A.8.22", "Keep network zones apart", "Are connections between guest, office and sensitive networks limited to what each service needs?",
        "A problem on a guest device should have few routes into business systems.", "An authorised test showing guest devices cannot reach a private service.", "Review the permitted routes between two network zones."],
    ["A.8.23", "Limit access to risky websites", "Do you manage which web destinations staff devices can reach and review exceptions?",
        "An unsafe destination can expose a device before its user realises anything is wrong.", "A filter policy with an approved, time-limited exception.", "Check that a harmless test category produces the expected block page."],
    ["A.8.24", "Choose and manage encryption", "Do you choose encryption for sensitive information and control the keys throughout their life?",
        "Losing a key can make protected data just as unavailable as losing the data itself.", "A key register with owners, rotation dates and a recovery test.", "Check how you would recover one critical key if its owner were away."],
    ["A.8.25", "Build security into delivery", "Does your development process include security work from design through release and maintenance?",
        "Teams can overlook security if it only appears at the final release meeting.", "A delivery checklist with security tasks completed at several stages.", "Add an owner for security decisions at the next planning session."],
    ["A.8.26", "Specify what an application must protect", "Before you buy or build an application, do you agree how it must protect its users and data?",
        "Missing requirements leave developers and suppliers to guess what matters.", "Acceptance criteria describing which roles can see a sensitive field.", "Write a testable security requirement for a planned feature."],
    ["A.8.27", "Design systems around trust boundaries", "Do designers apply agreed security principles when choosing how components connect and fail?",
        "A poor boundary can expose an entire service through one component.", "A design decision showing where access is checked between services.", "Review a system diagram and mark where trust changes."],
    ["A.8.28", "Write code with safe defaults", "Do developers apply secure coding practices and check one another's changes?",
        "A small coding mistake can expose every record handled by a shared feature.", "A code review that corrected unsafe handling of user input.", "Choose one recurring coding error and add a review or automated check."],
    ["A.8.29", "Test safeguards before release", "Do release decisions use test results showing the application's security requirements are met?",
        "A feature may work for its intended user while allowing access by somebody else.", "A release record with positive and negative access tests.", "Add a test for an action an ordinary user must be refused."],
    ["A.8.30", "Check externally built software", "Do you set security expectations for outside developers and verify what they deliver?",
        "Outsourcing development leaves your organisation relying on the delivered code.", "A supplier handover with review findings and retest results.", "Ask for evidence against one agreed requirement before accepting delivery."],
    ["A.8.31", "Separate live and trial systems", "Are development and test systems separated from live systems, credentials and data?",
        "A trial change or test account can otherwise affect real users.", "An environment diagram and separate access lists.", "Check whether a test credential can reach any live resource."],
    ["A.8.32", "Make changes recoverable", "Do you assess, approve, test and prepare to reverse changes to running services?",
        "A reversible change gives the duty team a way to restore service quickly.", "A change record with test results, approval and a rollback step.", "Rehearse the rollback for the next significant change."],
    ["A.8.33", "Choose safe test records", "Do testers use suitable sample information and protect or remove it when testing ends?",
        "A realistic dataset can expose real people if copied into a less protected environment.", "A test dataset created from invented records with an expiry date.", "Replace one copied customer sample with synthetic records."],
    ["A.8.34", "Keep live services safe during checks", "Before an independent check touches a live service, do you agree its scope, timing and safeguards with the owner?",
        "An otherwise legitimate check can interrupt a customer or expose live information.", "A test agreement naming the service owner, stop conditions and recovery contact.", "Agree the safe window and stop signal before the next live check."],
];

// Zero-argument publication. Registration and access decisions belong to the paid runtime.
function createIso27001FrameworkProfile() {
    const sourceCatalogueSha256 = crypto.createHash('sha256').update(JSON.stringify(ITEMS), 'utf8').digest('hex');
    if (sourceCatalogueSha256 !== SOURCE_SHA256) throw new Error('iso_27001_source_digest_mismatch');

    const sourceIds = [SOURCE_ID];
    const controls = [];
    const questions = [];
    const allOptions = OPTIONS.map(option => option.id);
    const clauseOptions = OPTIONS.filter(option => option.applicable).map(option => option.id);
    const otherReferences = { 'C6.1.2': ['6.1.1'], 'C7.2': ['7.3'] };

    for (const [id, title, prompt, why, example, nextStep] of ITEMS) {
        const annex = id.startsWith('A.');
        const referenceId = annex ? id : id.slice(1);
        const references = [referenceId, ...(otherReferences[id] || [])];
        const guidance = { summary: why, evidenceExamples: [example], startingActions: [nextStep] };
        controls.push({
            id, domainId: annex ? id.slice(0, id.lastIndexOf('.')) : id.split('.')[0],
            order: controls.length + 1, title, guidance, sourceIds,
            sourceReferences: references.map((ref, index) => ({ sourceId: SOURCE_ID, referenceId: ref, order: index + 1 }))
        });
        questions.push({
            id: `${id}-Q1`, controlId: id, order: 1, prompt, guidance, weight: 1,
            responseOptionIds: annex ? allOptions : clauseOptions, sourceIds
        });
    }

    return publishFrameworkProfile({
        schemaVersion: 1, status: 'published', publishedAt: DATE, catalogueSha256: PROFILE_SHA256, sourceCatalogueSha256,
        framework: {
            id: 'iso-iec-27001', version: '2022', title: 'ISO/IEC 27001:2022', authority: 'ISO and IEC',
            description: 'Reference edition for the management-system clauses and Annex A identifiers.', sourceIds
        },
        profile: {
            id: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1', title: TITLE, effectiveFrom: DATE,
            description: 'Assess how your organisation works today and record what you will improve next.', sourceIds
        },
        statements: {
            attribution: 'ISO and IEC publish the standard. No Fries wrote the questions, titles, examples and guidance.',
            basis: 'Use the scope you declared for this assessment. Consider each question across that whole scope.',
            claim: 'This is a readiness self-assessment, not certification. For accredited certification, use an accredited certification body.',
            limitations: [
                'The 23 management questions sample the requirements in clauses 4 to 10. Use the standard to check the full set.',
                'Use this Annex A view as a starting point. Your organisation still needs its own full Statement of Applicability, including any extra controls its risks require.',
                'Read each clause group and Annex A theme separately. Each applicable answer carries equal weight within its group. There is no overall pass mark.',
                'In place with evidence means you can point to a current example. Both in-place answers give full readiness credit.',
                'For an Annex A exclusion, record why the control does not apply to your scope. Keep the reason with its entry in your Statement of Applicability.',
                'Leave unfinished answers open. Exclude a control with a documented reason from its theme average. If all are excluded, show that the theme has no applicable controls.'
            ]
        },
        sources: [{
            id: SOURCE_ID, title: 'ISO/IEC 27001:2022', url: 'https://www.iso.org/standard/82875.html',
            authority: 'ISO and IEC', version: '2022', publishedAt: '2022-10-25', lastVerifiedAt: DATE,
            rightsStatus: 'verified', licence: 'Identifier references only. ISO and IEC reserve rights in their text.',
            licenceUrl: 'https://www.iso.org/copyright.html', reviewDueAt: '2027-11-19', reviewCadence: 'annual'
        }],
        domains: DOMAINS.map(([id, title, summary], index) => ({
            id, order: index + 1, title, sourceIds, guidance: { summary, evidenceExamples: [], startingActions: [] }
        })),
        controls, questions, responseOptions: OPTIONS
    });
}

module.exports = { createIso27001FrameworkProfile };
