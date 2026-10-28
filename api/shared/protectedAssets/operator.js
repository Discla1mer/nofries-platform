(function () {
    const root = document.getElementById('operatorRoot');
    const loadingPanel = document.getElementById('loadingPanel');
    const loadingStatus = document.getElementById('loadingStatus');
    const toast = document.getElementById('operatorToast');
    let state = null;
    let dattoStatus = null;
    let dattoSites = [];
    const dattoOnboardingHandoffs = new Map();

    if (!root || !loadingPanel) return;
    load();

    async function load() {
        setLoading('Loading customer records, outstanding items and activity.');
        try {
            state = await api('/api/lifecycle/bootstrap');
            dattoStatus = await api('/api/datto-rmm/status').catch((error) => ({
                provider: 'datto_rmm',
                state: 'unavailable',
                mode: 'disabled',
                configured: false,
                readOnly: true,
                writeOperationsEnabled: false,
                missing: [],
                error: error.message
            }));
            render();
        } catch (error) {
            setLoading(error.message || 'The operator console could not be loaded.');
        }
    }

    function render() {
        root.replaceChildren();
        root.append(heading());
        const proposalContinuation = proposalContinuationSection();
        if (proposalContinuation) root.append(proposalContinuation);
        root.append(metrics(), pipeline());
        const pilot = pilotCustomerSection();
        if (pilot) root.append(pilot);
        root.append(dattoRmmSection(), serviceProofSection(), recurringControlsSection(), operatorTasksSection(), exceptionsSection(), organisationsSection());
        loadingPanel.hidden = true;
        root.hidden = false;
        document.body.classList.remove('operator-loading');
    }

    function heading() {
        const refresh = button('Refresh', 'button button-secondary', load);
        const actions = [refresh];
        if (state.user.role === 'admin') {
            actions.unshift(button('Retention review', 'button button-secondary', reviewRetention));
        }
        return el('section', { className: 'console-heading' }, [
            el('div', {}, [
                el('p', { className: 'eyebrow', text: 'Operator console' }),
                el('h1', { text: 'Work that needs attention.' }),
                el('p', { text: `${state.tenant.name} · ${state.user.name || state.user.email} · ${pretty(state.user.role)}` })
            ]),
            el('div', { className: 'console-actions' }, actions)
        ]);
    }

    function proposalContinuationSection() {
        const params = new URLSearchParams(window.location.search);
        const proposalId = params.get('proposalId') || '';
        if (!proposalId) return null;

        const organisationId = params.get('organisationId') || '';
        const salesCustomerId = params.get('salesCustomerId') || '';
        const assessmentId = params.get('assessmentId') || '';
        const organisation = (state.organisations || []).find((candidate) => (
            candidate.organisationId === organisationId &&
            candidate.scope &&
            candidate.scope.salesCustomerId === salesCustomerId &&
            candidate.scope.assessmentId === assessmentId
        ));
        const actions = [];
        let title = 'Continue to customer acceptance';
        let description = 'The approved Sales proposal has been carried into Work so you do not need to find the customer or copy an ID.';

        if (!organisation) {
            title = 'The approved proposal is not linked to a Work record';
            description = 'Return to Sales from the exact prospect handoff, or review the customer link before continuing.';
            actions.push(el('a', { className: 'button', href: '/scoping', text: 'Return to Sales' }));
        } else if (!organisation.scope.proposalId) {
            if (hasCapability('customer:accept')) {
                actions.push(button('Verify approved proposal', 'button', (event) => (
                    bindApprovedProposal(organisation, event.currentTarget, proposalId)
                )));
            } else {
                description = 'The approved proposal is linked to this customer. An authorised service owner must verify it before acceptance.';
            }
        } else if (organisation.scope.proposalId !== proposalId) {
            title = 'A different proposal is already bound';
            description = 'Review the existing sealed proposal before replacing or recording customer acceptance.';
            actions.push(el('a', {
                className: 'button',
                href: `#organisation-${organisation.organisationId}`,
                text: 'Review customer'
            }));
        } else if (organisation.lifecycleState === 'proposal') {
            if (hasCapability('customer:accept')) {
                actions.push(button('Record customer acceptance', 'button', (event) => (
                    recordCommercialAcceptance(organisation, event.currentTarget, proposalId)
                )));
            } else {
                description = 'The sealed proposal is ready. An authorised service owner must record customer acceptance.';
            }
        } else if (organisation.lifecycleState === 'accepted') {
            title = 'Customer acceptance is recorded';
            if (hasCapability('onboarding:write')) {
                description = 'Start the controlled customer set-up using the accepted and sealed proposal.';
                actions.push(button('Start set-up', 'button', (event) => (
                    startExternalOnboarding(organisation, event.currentTarget)
                )));
            } else {
                description = 'An authorised operator must start the controlled customer set-up.';
            }
        } else {
            title = organisation.lifecycleState === 'onboarding' ? 'Customer set-up is underway' : 'Proposal handoff complete';
            description = organisation.nextAction && organisation.nextAction.detail || 'Open the exact customer record to continue.';
            actions.push(organisation.lifecycleState === 'active'
                ? el('a', {
                    className: 'button',
                    href: `/support?customerId=${encodeURIComponent(organisation.organisationId)}`,
                    text: 'Open service desk'
                })
                : el('a', {
                    className: 'button',
                    href: `#organisation-${organisation.organisationId}`,
                    text: 'Continue set-up'
                }));
        }

        return el('section', { className: 'console-section continuation-section' }, [
            sectionTitle(title, description),
            el('div', { className: 'continuation-card' }, [
                el('div', {}, [
                    el('span', { text: organisation ? pretty(organisation.lifecycleState) : 'Link required' }),
                    el('strong', { text: organisation && organisation.displayName || 'Approved Sales proposal' }),
                    el('small', { text: `Proposal ${proposalId}` })
                ]),
                el('div', { className: 'organisation-actions' }, actions)
            ])
        ]);
    }

    function metrics() {
        const values = [
            ['Needs attention', state.counts.exceptions, true],
            ['Open operator tasks', state.counts.operatorTasks],
            ['Active conversations', state.counts.conversations],
            ['Pending approvals', state.counts.approvals],
            ['Approx. automation cost (USD)', money(state.ai.approximateCostUsd)]
        ];
        return el('section', { className: 'metric-grid', ariaLabel: 'Current operator summary' }, values.map(([label, value, attention]) => (
            el('article', { className: `metric-card${attention ? ' is-attention' : ''}` }, [
                el('span', { text: label }),
                el('strong', { text: String(value) })
            ])
        )));
    }

    function pipeline() {
        const order = [
            ['prospect', 'Prospect'],
            ['discovery', 'Discovery'],
            ['scoping', 'Service review'],
            ['proposal', 'Proposal'],
            ['accepted', 'Accepted'],
            ['onboarding', 'Set-up'],
            ['active', 'Active'],
            ['suspended', 'Suspended'],
            ['offboarding', 'Offboarding'],
            ['former', 'Former']
        ];
        return el('section', { className: 'pipeline', ariaLabel: 'Customer progress' }, order.map(([stage, label]) => (
            el('div', { className: 'pipeline-stage' }, [
                el('span', { text: label }),
                el('strong', { text: String(state.lifecycle[stage] || 0) })
            ])
        )));
    }

    function pilotCustomerSection() {
        if (state.user.role !== 'admin' || !state.user.capabilities.includes('lifecycle:transition')) return null;
        const existing = state.organisations.find((organisation) => (
            organisation.source && organisation.source.channel === 'operator_internal_pilot'
        )) || state.organisations.find((organisation) => (
            isNoFriesHqLabel(organisation.displayName)
        ));
        if (existing) {
            const devices = existing.onboarding && existing.onboarding.devices || [];
            const gates = existing.onboarding && existing.onboarding.gates || [];
            const verified = devices.filter((device) => device.status === 'verified').length;
            const complete = gates.filter((gate) => gate.status === 'complete').length;
            const actions = [el('a', {
                className: 'button',
                href: `#organisation-${existing.organisationId}`,
                text: existing.lifecycleState === 'active' ? 'Review customer' : 'Continue set-up'
            })];
            if (existing.lifecycleState === 'active' && existing.onboarding.status === 'complete') {
                actions.push(el('a', { className: 'button button-secondary', href: `/support?customerId=${encodeURIComponent(existing.organisationId)}`, text: 'Open Service Desk' }));
            }
            return el('section', { className: 'console-section' }, [
                sectionTitle('Customer set-up', 'Continue the existing No Fries HQ workshop record through its governed next step; do not create a duplicate internal customer.'),
                el('article', { className: 'organisation-card' }, [
                    el('div', { className: 'organisation-summary' }, [
                        el('div', { className: 'organisation-name' }, [
                            el('span', { className: 'pill', text: pretty(existing.lifecycleState) }),
                            el('strong', { text: existing.displayName }),
                            el('span', { text: `${verified} of ${devices.length} computers verified · ${complete} of ${gates.length} checks complete` })
                        ]),
                        el('div', { className: 'organisation-next' }, [
                            el('span', { text: 'Next action' }),
                            el('strong', { text: existing.nextAction.detail || pretty(existing.nextAction.type) })
                        ]),
                        el('div', { className: 'organisation-actions' }, actions)
                    ])
                ])
            ]);
        }
        const customerName = el('input', {
            name: 'customerName', type: 'text', value: 'No Fries Headquarters', maxlength: '180', required: 'required'
        });
        const contactName = el('input', {
            name: 'contactName', type: 'text', value: state.user.name || 'Joel Harvey', maxlength: '180', required: 'required'
        });
        const contactEmail = el('input', {
            name: 'contactEmail', type: 'email', value: state.user.email || '', maxlength: '254', required: 'required'
        });
        const location = el('input', {
            name: 'location', type: 'text', value: 'No Fries Headquarters', maxlength: '240', required: 'required'
        });
        const users = el('input', { name: 'users', type: 'number', value: '1', min: '1', max: '50', required: 'required' });
        const endpoints = el('input', { name: 'endpoints', type: 'number', value: '2', min: '1', max: '50', required: 'required' });
        const platform = el('select', { name: 'platform', ariaLabel: 'Productivity platform' }, [
            el('option', { value: 'google_workspace', text: 'Google Workspace' }),
            el('option', { value: 'microsoft_365', text: 'Microsoft 365' }),
            el('option', { value: 'mixed', text: 'Mixed' }),
            el('option', { value: 'other', text: 'Other' })
        ]);
        const devicePlan = el('textarea', {
            name: 'devicePlan',
            rows: '5',
            maxlength: '10000',
            required: 'required',
            text: 'dell_laptop | Dell laptop | windows\napple_macbook | Older Apple MacBook | macos'
        });
        const confirmation = el('input', { name: 'confirmation', type: 'checkbox', required: 'required' });
        const submit = el('button', { className: 'button', type: 'submit', text: 'Create set-up customer' });
        const form = el('form', { className: 'pilot-form' }, [
            formField('Customer name', customerName),
            formField('Primary contact', contactName),
            formField('Contact email', contactEmail),
            formField('Location', location),
            formField('Users', users),
            formField('Expected total computers', endpoints),
            formField('Productivity platform', platform),
            formField('Planned representative computers (editable examples; one per line: ID | label | platform)', devicePlan),
            el('label', { className: 'pilot-confirmation' }, [
                confirmation,
                el('span', { text: 'I confirm this is an isolated No Fries-owned internal pilot. Supplier changes, software installation and fixes still require approval.' })
            ]),
            el('div', { className: 'pilot-form-actions' }, [
                submit,
                el('span', { text: 'Creates a recorded set-up plan; it does not install software or change Datto.' })
            ])
        ]);
        form.addEventListener('submit', (event) => createInternalPilot(event, form, submit));
        const details = el('details', { className: 'pilot-create' }, [
            el('summary', { text: 'Create the first internal customer' }),
            form
        ]);
        return el('section', { className: 'console-section' }, [
            sectionTitle(
                'Customer set-up',
                'Create a controlled internal customer, track each computer and keep changes behind an approval.'
            ),
            details
        ]);
    }

    function formField(label, control) {
        return el('label', { className: 'pilot-field' }, [el('span', { text: label }), control]);
    }

    function serviceProofSection() {
        const proof = state.serviceProof || {};
        const values = [
            ['Tickets raised', proof.ticketsRaised || 0],
            ['Tickets resolved', proof.ticketsResolved || 0],
            ['Fixes completed', proof.remediations || 0],
            ['Needs attention', proof.needsAttention || 0],
            ['Lab simulations', proof.simulatedEvents || 0]
        ];
        const cards = el('div', { className: 'proof-grid' }, values.map(([label, value]) => (
            el('article', { className: 'proof-card' }, [
                el('span', { text: label }),
                el('strong', { text: String(value) })
            ])
        )));
        const recent = el('div', { className: 'proof-events' });
        if (!proof.recentEvents || !proof.recentEvents.length) {
            recent.append(el('div', { className: 'empty-state', text: 'No linked service activity has been recorded for this month.' }));
        } else {
            proof.recentEvents.slice(0, 8).forEach((event) => recent.append(el('article', { className: 'proof-event' }, [
                el('div', {}, [
                    el('strong', { text: event.summary || pretty(event.type) }),
                    el('span', { text: `${pretty(event.type)} · ${event.ticketId}` })
                ]),
                el('small', { text: event.simulated ? 'Mock evidence' : 'Recorded evidence' })
            ])));
        }
        return el('section', { className: 'console-section' }, [
            sectionTitle(
                `Proof every month · ${periodLabel(proof.period)}`,
                `${proof.evidenceEvents || 0} operational service events. ${proof.simulatedEvents || 0} lab simulations are shown separately and excluded from the totals.`
            ),
            hasCapability('customer-controls:run')
                ? el('div', { className: 'organisation-actions' }, [
                    button('Generate due internal controls', 'button button-secondary', runCustomerControls)
                ])
                : null,
            cards,
            recent
        ]);
    }

    function recurringControlsSection() {
        const section = el('section', { className: 'console-section', ariaLabel: 'Recurring service reviews and controls' }, [
            sectionTitle('Recurring service reviews and controls',
                'Saved service-control schedules, not assessment-review schedules. A generated task does not mean a review is complete or evidence is verified.'),
            el('p', { text: 'This snapshot includes up to 200 schedules and 100 recent runs. Older records may not be included. Refresh to read the current records.' })
        ]);
        const controls = state.customerControls;
        if (!controls || !Array.isArray(controls.schedules) || !Array.isArray(controls.recentRuns)) {
            section.append(el('p', { className: 'empty-state', text: 'Recurring service-control records are unavailable in this snapshot.' }));
            return section;
        }
        const organisations = new Map();
        (state.organisations || []).forEach(organisation => {
            if (!organisation || typeof organisation.organisationId !== 'string') return;
            const id = organisation.organisationId;
            organisations.set(id, organisations.has(id) ? null : organisation);
        });
        const schedules = controls.schedules.slice(0, 200).filter(schedule => schedule &&
            typeof schedule.id === 'string' && schedule.id && typeof schedule.jobType === 'string' && schedule.jobType &&
            typeof schedule.organisationId === 'string' && organisations.get(schedule.organisationId));
        if (!schedules.length) {
            section.append(el('p', { className: 'empty-state', text: 'No recurring service schedules for the loaded organisations are included in this snapshot.' }));
            return section;
        }
        const titles = { connector_freshness: 'Connector freshness', sla_exception_review: 'SLA exception review',
            monthly_proof: 'Monthly Proof preparation', managed_count_reconciliation: 'Managed-count reconciliation',
            quarterly_service_review: 'Service review' };
        const cadenceLabels = { daily: 'Daily', monthly: 'Monthly', quarterly: 'Quarterly' };
        const runLabels = { generated: 'Task generated', completed: 'Run recorded completed', failed: 'Run failed', dead_letter: 'Run needs operator attention' };
        schedules.forEach(schedule => {
            const organisation = organisations.get(schedule.organisationId);
            const title = Object.hasOwn(titles, schedule.jobType) ? titles[schedule.jobType] : 'Service control';
            const detail = el('details', { className: 'organisation-card' }, [
                el('summary', { text: `${organisation.displayName || 'Organisation'} · ${title}` })
            ]);
            const facts = el('dl', { className: 'known-grid' });
            const fact = (label, value) => facts.append(el('dt', { text: label }), el('dd', { text: value }));
            const due = recurringControlTime(schedule.nextDueAt, schedule.timezone);
            fact('Schedule state', schedule.enabled === true ? 'Enabled' : schedule.enabled === false ? 'Paused' : 'Unknown');
            fact('Recorded cadence', Object.hasOwn(cadenceLabels, schedule.cadence) ? cadenceLabels[schedule.cadence] : 'Unknown');
            fact('Time zone', due.timezone);
            fact('Next scheduled (local)', due.local);
            fact('Next scheduled (UTC)', due.utc);
            const matching = controls.recentRuns.slice(0, 100).filter(run => run &&
                run.scheduleId === schedule.id && run.organisationId === schedule.organisationId && run.jobType === schedule.jobType);
            const dated = matching.filter(run => recurringControlInstant(run.scheduledFor))
                .sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor));
            const latest = dated[0];
            if (!matching.length) fact('Latest included run', 'No run included in this snapshot');
            else if (dated.length !== matching.length || dated.length > 1 && dated[1].scheduledFor === latest.scheduledFor) {
                fact('Latest included run', 'Unavailable: included run dates are invalid or ambiguous');
            } else {
                fact('Latest included run', Object.hasOwn(runLabels, latest.status) ? runLabels[latest.status] : 'Unknown');
                const runTime = recurringControlTime(latest.scheduledFor, schedule.timezone);
                fact('Run scheduled for (local)', runTime.local);
                fact('Run scheduled for (UTC)', runTime.utc);
            }
            detail.append(facts); section.append(detail);
        });
        return section;
    }

    function recurringControlInstant(value) {
        if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
        const date = new Date(value);
        return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
    }

    function recurringControlTime(value, timezone) {
        const date = recurringControlInstant(value);
        const missingDate = value === null || value === undefined || value === '';
        const result = { utc: date ? value : missingDate ? 'Not recorded' : 'Unavailable: invalid date',
            local: date ? 'Unavailable: no valid time zone' : missingDate ? 'Not recorded' : 'Unavailable: invalid date',
            timezone: timezone === null || timezone === undefined || timezone === '' ? 'Not recorded' : 'Unavailable: invalid time zone' };
        if (typeof timezone !== 'string' || !timezone || timezone.length > 80 || timezone.trim() !== timezone || /^[+-]/.test(timezone)) return result;
        try {
            const format = new Intl.DateTimeFormat('en-NZ-u-nu-latn', { timeZone: timezone, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' });
            result.timezone = timezone;
            if (date) {
                const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
                const offset = parts.timeZoneName === 'GMT' ? 'GMT+00:00' : parts.timeZoneName;
                result.local = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`;
            }
        } catch (_) { /* Keep an explicit unavailable state; never use the browser's zone. */ }
        return result;
    }

    function dattoRmmSection() {
        const status = dattoStatus || {
            state: 'unavailable',
            mode: 'disabled',
            configured: false,
            writeOperationsEnabled: false,
            missing: []
        };
        const mode = status.mode || 'disabled';
        const writeOperationsEnabled = status.writeOperationsEnabled === true;
        const linked = state.organisations.filter((organisation) => (
            organisation.links && organisation.links.dattoRmmSiteUid
        )).length;
        const values = [
            ['Connection', pretty(status.state)],
            ['Mode', pretty(mode)],
            ['Onboarding writes', writeOperationsEnabled ? 'Enabled' : 'Disabled'],
            ['Sites discovered', dattoSites.length],
            ['Customers linked', linked]
        ];
        const cards = el('div', { className: 'proof-grid' }, values.map(([label, value]) => (
            el('article', { className: 'proof-card' }, [
                el('span', { text: label }),
                el('strong', { text: String(value) })
            ])
        )));
        const actions = el('div', { className: 'console-actions' });
        if (status.configured) {
            actions.append(
                button('Check connection', 'button button-secondary', checkDattoConnection),
                button('Discover sites', 'button', discoverDattoSites)
            );
        }
        const content = el('div', { className: 'organisation-list' });
        dattoOnboardingHandoffs.forEach((result, organisationId) => {
            content.append(dattoOnboardingHandoffCard(organisationId, result));
        });
        if (!status.configured) {
            const missing = status.missing && status.missing.length
                ? ` Awaiting: ${status.missing.join(', ')}.`
                : '';
            content.append(el('div', {
                className: 'empty-state',
                text: `${status.error || status.configurationError || 'The Datto RMM bridge is not configured.'}${missing}`
            }));
        } else if (!dattoSites.length) {
            content.append(el('div', {
                className: 'empty-state',
                text: 'The connection is ready. Find sites to link accepted customers and compare computer counts.'
            }));
        } else {
            dattoSites.forEach((site) => content.append(dattoSiteCard(site)));
        }
        const description = writeOperationsEnabled
            ? 'Controlled onboarding can create or reuse a customer site and issue site-scoped installer handoffs. Local installation and device privacy approvals remain human-confirmed.'
            : mode === 'readonly'
                ? 'Site, device and alert information is read only. Supplier-side changes and automatic fixes are disabled.'
                : 'The Datto RMM bridge is disabled until an approved connection mode and credentials are configured.';
        return el('section', { className: 'console-section' }, [
            sectionTitle(
                'Datto RMM onboarding',
                description
            ),
            cards,
            actions,
            content
        ]);
    }

    function dattoOnboardingHandoffCard(organisationId, result) {
        const organisation = state.organisations.find((item) => item.organisationId === organisationId);
        const site = result && result.site || {};
        const handoffs = Array.isArray(result && result.handoffs) ? result.handoffs : [];
        const manualTasks = Array.isArray(result && result.manualTasks) ? result.manualTasks : [];
        const manualGates = Array.isArray(result && result.manualGates) ? result.manualGates : [];
        const links = el('div', { className: 'onboarding-devices' });
        handoffs.forEach((handoff) => {
            const platform = String(handoff && handoff.platform || 'other').toLowerCase();
            const downloadUrl = safeHttpsUrl(handoff && handoff.downloadUrl);
            const approvals = Array.isArray(handoff && handoff.requiredApprovals)
                ? handoff.requiredApprovals
                : [];
            const actions = el('div', { className: 'organisation-actions' });
            if (downloadUrl) {
                actions.append(el('a', {
                    className: 'button',
                    href: downloadUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: `Open ${platform === 'macos' ? 'macOS' : pretty(platform)} installer`
                }));
            } else {
                actions.append(el('span', { text: 'Installer link unavailable' }));
            }
            links.append(el('div', { className: 'onboarding-device' }, [
                el('div', {}, [
                    el('strong', { text: handoff && handoff.label || pretty(platform) }),
                    el('span', {
                        text: `${platform === 'macos' ? 'macOS' : pretty(platform)} · ${handoff && handoff.requiresLocalAdmin === false ? 'No local admin reported' : 'Local administrator required'}`
                    }),
                    approvals.length
                        ? el('small', { text: `Approvals: ${approvals.map(checklistText).filter(Boolean).join(' · ')}` })
                        : null
                ]),
                actions
            ]));
        });
        const manualTaskList = el('div', { className: 'onboarding-devices' });
        manualTasks.forEach((task) => {
            const documentationUrl = safeHttpsUrl(task && task.documentationUrl);
            const actions = el('div', { className: 'organisation-actions' });
            if (documentationUrl) {
                actions.append(el('a', {
                    className: 'button button-secondary',
                    href: documentationUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: 'Open vendor instructions'
                }));
            }
            manualTaskList.append(el('div', { className: 'onboarding-device' }, [
                el('div', {}, [
                    el('strong', { text: task && task.label || pretty(task && task.platform) }),
                    el('span', { text: checklistText(task && task.title || 'Manual installer task') }),
                    el('small', { text: checklistText(task && task.detail) })
                ]),
                actions
            ]));
        });
        const checklist = el('ul');
        manualGates.forEach((gate) => {
            const title = checklistText(gate && gate.title || gate && gate.id || gate);
            const detail = checklistText(gate && gate.detail);
            checklist.append(el('li', { text: [title, detail].filter(Boolean).join(' — ') }));
        });
        return el('article', { className: 'organisation-card' }, [
            el('div', { className: 'organisation-summary' }, [
                el('div', { className: 'organisation-name' }, [
                    el('span', { className: 'pill', text: 'Installer handoff' }),
                    el('strong', { text: organisation && organisation.displayName || site.name || organisationId }),
                    el('span', {
                        text: `${site.created ? 'Created' : 'Reused'} Datto site${site.name ? ` · ${site.name}` : ''}`
                    })
                ])
            ]),
            handoffs.length
                ? el('section', { className: 'organisation-detail' }, [el('h3', { text: 'Device installer handoffs' }), links])
                : manualTasks.length ? null : el('div', { className: 'empty-state', text: 'Datto did not return an installer handoff.' }),
            manualTasks.length
                ? el('section', { className: 'organisation-detail' }, [
                    el('h3', { text: 'Manual platform tasks' }),
                    manualTaskList
                ])
                : null,
            manualGates.length
                ? el('section', { className: 'organisation-detail' }, [
                    el('h3', { text: 'Human-required checklist' }),
                    checklist
                ])
                : null
        ]);
    }

    function dattoSiteCard(site) {
        const mapped = state.organisations.find((organisation) => (
            organisation.links && organisation.links.dattoRmmSiteUid === site.siteUid
        ));
        const canLink = state.user.capabilities && state.user.capabilities.includes('lifecycle:transition');
        const actions = el('div', { className: 'organisation-actions' });
        if (!canLink) {
            actions.append(el('span', { text: 'Service-owner approval required' }));
        } else if (mapped) {
            actions.append(button('Sync snapshot', 'button', (event) => (
                linkDattoSite(site, mapped.organisationId, event.currentTarget)
            )));
        } else {
            const eligible = state.organisations.filter((organisation) => (
                ['accepted', 'onboarding', 'active'].includes(organisation.lifecycleState) &&
                !(organisation.links && organisation.links.dattoRmmSiteUid)
            ));
            const select = el('select', { ariaLabel: `Lifecycle customer for ${site.name}` }, [
                el('option', { value: '', text: 'Choose accepted customer' }),
                ...eligible.map((organisation) => el('option', {
                    value: organisation.organisationId,
                    text: `${organisation.displayName} · ${pretty(organisation.lifecycleState)}`
                }))
            ]);
            const link = button('Link & sync', 'button', (event) => (
                linkDattoSite(site, select.value, event.currentTarget)
            ));
            link.disabled = true;
            select.addEventListener('change', () => { link.disabled = !select.value; });
            actions.append(select, link);
        }
        return el('article', { className: 'organisation-card' }, [
            el('div', { className: 'organisation-summary' }, [
                el('div', { className: 'organisation-name' }, [
                    el('span', { className: 'pill', text: 'Datto site' }),
                    el('strong', { text: site.name || site.siteUid }),
                    el('span', { text: site.siteUid })
                ]),
                el('div', { className: 'organisation-need' }, [
                    el('span', { text: 'Datto reported devices' }),
                    el('strong', { text: site.deviceCount == null ? 'Discover on sync' : String(site.deviceCount) })
                ]),
                el('div', { className: 'organisation-next' }, [
                    el('span', { text: 'Lifecycle mapping' }),
                    el('strong', { text: mapped ? mapped.displayName : 'Not linked' })
                ]),
                actions
            ])
        ]);
    }

    function exceptionsSection() {
        const list = el('div', { className: 'exception-list' });
        if (!state.exceptions.length) {
            list.append(el('div', { className: 'empty-state', text: 'No lifecycle exceptions need attention.' }));
        } else {
            state.exceptions.forEach((item) => list.append(el('article', { className: `exception-card priority-${item.priority}` }, [
                el('div', {}, [el('strong', { text: item.organisationName }), el('span', { text: pretty(item.priority) })]),
                el('span', { text: `${item.title}. ${item.detail || ''}` }),
                el('small', { text: pretty(item.code) })
            ])));
        }
        return el('section', { className: 'console-section' }, [
            sectionTitle('Needs attention', 'Items that need a decision, missing detail, approval or personal follow-up.'),
            list
        ]);
    }

    function operatorTasksSection() {
        const allTasks = state.operatorTasks || [];
        const openTasks = allTasks.filter((task) => task.status === 'open');
        const recentlyCompleted = allTasks.filter((task) => task.status === 'completed').slice(0, 5);
        const tasks = openTasks.concat(recentlyCompleted);
        const list = el('div', { className: 'operator-task-list' });
        if (!tasks.length) {
            list.append(el('div', { className: 'empty-state', text: 'No prospect handoff tasks have been generated yet.' }));
        } else {
            tasks.forEach((task) => {
                const organisation = state.organisations.find((item) => item.organisationId === task.organisationId);
                const actions = organisation ? [
                    el('a', {
                        className: 'button button-secondary',
                        href: `#organisation-${organisation.organisationId}`,
                        text: task.status === 'open' ? 'Review record' : 'View record'
                    })
                ] : [];
                list.append(el('article', { className: `operator-task status-${task.status} priority-${task.priority}` }, [
                    el('div', { className: 'operator-task-main' }, [
                        el('div', { className: 'operator-task-heading' }, [
                            el('span', { className: 'pill', text: pretty(task.status) }),
                            el('strong', { text: task.title })
                        ]),
                        el('span', { text: organisation && organisation.displayName || task.organisationId }),
                        el('p', { text: task.detail || 'Review the captured discovery context and provenance.' })
                    ]),
                    el('dl', { className: 'operator-task-meta' }, [
                        el('dt', { text: 'Owner' }), el('dd', { text: pretty(task.ownerRole) }),
                        el('dt', { text: 'Source' }), el('dd', { text: pretty(task.source) }),
                        el('dt', { text: 'Created' }), el('dd', { text: dateTime(task.createdAt) }),
                        el('dt', { text: task.status === 'completed' ? 'Completed' : 'Core gaps at handoff' }),
                        el('dd', {
                            text: task.status === 'completed'
                                ? dateTime(task.completedAt)
                                : String(task.evidence && task.evidence.missingCoreFieldCount || 0)
                        })
                    ]),
                    el('div', { className: 'organisation-actions' }, actions)
                ]));
            });
        }
        return el('section', { className: 'console-section' }, [
            sectionTitle(
                'Operator tasks',
                'Recorded handoffs from the reusable customer workflow. A discovery review task completes when an authorised operator prepares the service review.'
            ),
            list
        ]);
    }

    function organisationsSection() {
        const list = el('div', { className: 'organisation-list' });
        if (!state.organisations.length) {
            list.append(el('div', { className: 'empty-state', text: 'No prospects or customers have been created yet.' }));
        } else {
            state.organisations
                .slice()
                .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
                .forEach((organisation) => list.append(organisationCard(organisation)));
        }
        return el('section', { className: 'console-section' }, [
            sectionTitle('Customer records', 'A compact view of what is recorded, what is still unknown and the next useful action.'),
            list
        ]);
    }

    function organisationCard(organisation) {
        const detail = organisationDetail(organisation);
        detail.hidden = true;
        const toggle = button('Review context', 'button button-secondary', () => {
            detail.hidden = !detail.hidden;
            toggle.textContent = detail.hidden ? 'Review context' : 'Hide context';
        });
        const actions = [
            toggle,
            button('Export JSON', 'button button-secondary', () => {
                window.location.assign(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/export`);
            })
        ];
        if (organisation.lifecycleState === 'discovery') {
            actions.push(button('Prepare service review', 'button', (event) => prepareScoping(organisation, event.currentTarget)));
        }
        if (
            ['scoping', 'proposal'].includes(organisation.lifecycleState) &&
            organisation.scope && organisation.scope.salesCustomerId && organisation.scope.assessmentId &&
            !organisation.scope.proposalId &&
            hasCapability('customer:accept')
        ) {
            actions.push(button('Bind approved proposal', 'button', (event) => bindApprovedProposal(organisation, event.currentTarget)));
        }
        if (organisation.lifecycleState === 'proposal' && hasCapability('customer:accept')) {
            actions.push(button('Record acceptance', 'button', (event) => recordCommercialAcceptance(organisation, event.currentTarget)));
        }
        if (organisation.lifecycleState === 'accepted' && hasCapability('onboarding:write')) {
            actions.push(button('Start onboarding', 'button', (event) => startExternalOnboarding(organisation, event.currentTarget)));
        }
        const dattoSiteUid = organisation.links && organisation.links.dattoRmmSiteUid ||
            organisation.integrations && organisation.integrations.dattoRmm && organisation.integrations.dattoRmm.siteUid;
        if (organisation.lifecycleState === 'onboarding' && hasCapability('integration:provision')) {
            const prepareDatto = button(dattoSiteUid ? 'Prepare customer installers' : 'Prepare customer site & installers', 'button', (event) => (
                prepareDattoOnboarding(organisation, event.currentTarget)
            ));
            if (!(dattoStatus && dattoStatus.writeOperationsEnabled === true)) {
                prepareDatto.disabled = true;
                prepareDatto.title = 'Enable Datto RMM controlled-write mode before preparing onboarding.';
            }
            actions.push(prepareDatto);
        }
        if (organisation.recordType === 'customer' && hasCapability('integration:map')) {
            actions.push(button('Add system ID', 'button button-secondary', (event) => addExternalReference(organisation, event.currentTarget)));
        }
        if (organisation.recordType === 'customer' && organisation.lifecycleState !== 'former' && hasCapability('onboarding:write')) {
            actions.push(button('Update customer master', 'button button-secondary', (event) => updateCustomerMaster(organisation, event.currentTarget)));
        }
        if (organisation.recordType === 'customer' && organisation.lifecycleState !== 'former' && hasCapability('service-status:write')) {
            actions.push(button('Update support access', 'button button-secondary', (event) => updateSupportProfile(organisation, event.currentTarget)));
        }
        if (['active', 'suspended'].includes(organisation.lifecycleState) && hasCapability('proof:write')) {
            actions.push(button('Add proof evidence', 'button button-secondary', (event) => recordProofEvidence(organisation, event.currentTarget)));
        }
        if (organisation.lifecycleState === 'active' && hasCapability('service-status:write')) {
            actions.push(button('Suspend service', 'button button-secondary', (event) => changeServiceStatus(organisation, 'suspend', event.currentTarget)));
        }
        if (organisation.lifecycleState === 'suspended' && hasCapability('service-status:write')) {
            actions.push(button('Resume service', 'button button-secondary', (event) => changeServiceStatus(organisation, 'resume', event.currentTarget)));
            actions.push(button('Start offboarding', 'button button-danger', (event) => changeServiceStatus(organisation, 'start_offboarding', event.currentTarget)));
        }
        const setUpDevices = organisation.onboarding && organisation.onboarding.devices || [];
        const serviceDeskReady = (
            organisation.recordType === 'customer' &&
            organisation.lifecycleState === 'active' &&
            organisation.serviceStatus && organisation.serviceStatus.state === 'active' &&
            organisation.onboarding && organisation.onboarding.status === 'complete' &&
            setUpDevices.length > 0 &&
            setUpDevices.every((device) => device.status === 'verified' && device.matchStatus === 'confirmed')
        );
        if (serviceDeskReady) {
            actions.push(el('a', {
                className: 'button',
                href: `/support?customerId=${encodeURIComponent(organisation.organisationId)}`,
                text: 'Open service desk'
            }));
        }
        if (state.user.role === 'admin') {
            actions.push(button('Delete', 'button button-danger', (event) => deleteOrganisation(organisation, event.currentTarget)));
        }
        const card = el('article', { className: 'organisation-card', id: `organisation-${organisation.organisationId}` }, [
            el('div', { className: 'organisation-summary' }, [
                el('div', { className: 'organisation-name' }, [
                    el('span', { className: 'pill', text: pretty(organisation.lifecycleState) }),
                    el('strong', { text: organisation.displayName }),
                    el('span', { text: coreDiscoveryLabel(organisation) })
                ]),
                el('div', { className: 'organisation-need' }, [
                    el('span', { text: 'Current need' }),
                    el('strong', { text: organisation.conversation && organisation.conversation.currentNeed || organisation.discovery.summary || 'Not yet known' })
                ]),
                el('div', { className: 'organisation-next' }, [
                    el('span', { text: 'Next action' }),
                    el('strong', { text: organisation.nextAction.detail || pretty(organisation.nextAction.type) })
                ]),
                el('div', { className: 'organisation-actions' }, actions)
            ]),
            detail
        ]);
        return card;
    }

    function organisationDetail(organisation) {
        const context = organisation.context;
        const known = [
            ['Contact', context.contacts.primary.name || 'Unknown', 'contacts.primary.name'],
            ['Email', context.contacts.primary.email || 'Unknown', 'contacts.primary.email'],
            ['Users', context.users.estimatedCount == null ? 'Unknown' : context.users.estimatedCount, 'users.estimatedCount'],
            ['Endpoints', context.endpoints.estimatedCount == null ? 'Unknown' : context.endpoints.estimatedCount, 'endpoints.estimatedCount'],
            ['Platform', pretty(context.productivity.platform), 'productivity.platform'],
            ['IT model', pretty(context.itProvider.model), 'itProvider.model']
        ];
        const knownList = el('dl', { className: 'known-grid' });
        known.forEach(([label, value, field]) => {
            const provenance = organisation.fieldStates && organisation.fieldStates[field] || {};
            const provenanceText = provenance.status === 'known'
                ? `${pretty(provenance.certainty)} · ${pretty(provenance.source)}`
                : 'Not provided';
            knownList.append(
                el('dt', { text: label }),
                el('dd', {}, [
                    el('strong', { text: String(value) }),
                    el('small', { className: 'field-provenance', text: provenanceText })
                ])
            );
        });
        const gaps = organisation.discovery.missingFields.length
            ? el('ul', {}, organisation.discovery.missingFields.slice(0, 10).map((item) => el('li', { text: item.label })))
            : el('p', { text: 'The key discovery details are recorded. Technical details still need to be checked during the service review.' });
        const summary = organisation.conversation && organisation.conversation.summary || organisation.discovery.summary || 'No conversation summary yet.';
        const supportEvidence = organisation.support && organisation.support.evidence || [];
        const support = supportEvidence.length
            ? el('ul', {}, supportEvidence.slice(-5).reverse().map((event) => el('li', {
                text: `${pretty(event.type)} · ${event.summary || event.ticketId}${event.simulated ? ' (mock)' : ''}`
            })))
            : el('p', { text: 'No linked service evidence yet.' });
        const datto = organisation.integrations && organisation.integrations.dattoRmm;
        const dattoDetail = datto && datto.status === 'linked'
            ? el('dl', { className: 'known-grid' }, [
                el('dt', { text: 'Site' }), el('dd', { text: datto.siteName || datto.siteUid }),
                el('dt', { text: 'Devices' }), el('dd', { text: String(datto.deviceCount) }),
                el('dt', { text: 'Open alerts' }), el('dd', { text: String(datto.openAlertCount) }),
                el('dt', { text: 'Reconciliation' }), el('dd', { text: pretty(datto.reconciliationStatus) }),
                el('dt', { text: 'Last sync' }), el('dd', { text: datto.lastSyncedAt || 'Not yet synced' })
            ])
            : el('p', { text: 'No Datto RMM site linked.' });
        const agentic = agenticManagementPanel(organisation);
        return el('div', { className: 'organisation-detail' }, [
            el('section', { className: 'detail-panel' }, [el('h3', { text: 'Known context' }), knownList]),
            el('section', { className: 'detail-panel' }, [el('h3', { text: 'Still to confirm' }), gaps]),
            el('section', { className: 'detail-panel' }, [el('h3', { text: 'Conversation summary' }), el('p', { text: summary })]),
            el('section', { className: 'detail-panel' }, [el('h3', { text: 'Service proof' }), support]),
            el('section', { className: 'detail-panel' }, [el('h3', { text: 'Datto RMM' }), dattoDetail]),
            agentic
        ]);
    }

    function agenticManagementPanel(organisation) {
        const plan = organisation.agenticManagement;
        if (!plan) return null;
        const gates = organisation.onboarding && organisation.onboarding.gates || [];
        const devices = organisation.onboarding && organisation.onboarding.devices || [];
        const observedDevices = organisation.integrations && organisation.integrations.dattoRmm && organisation.integrations.dattoRmm.devices || [];
        const gateStatuses = new Map(gates.map((gate) => [gate.id, gate.status]));
        const deviceList = el('div', { className: 'onboarding-devices' });
        devices.forEach((device) => {
            const next = {
                planned: ['installer_ready', 'Installer ready'],
                installer_ready: ['enrolled', 'Mark enrolled'],
                enrolled: ['verified', 'Verify computer'],
                blocked: ['planned', 'Restart set-up']
            }[device.status];
            const actions = [];
            if (organisation.lifecycleState === 'onboarding' && device.matchStatus !== 'confirmed' && observedDevices.length) {
                actions.push(button('Match Datto device', 'button button-secondary', (event) => (
                    matchOnboardingDevice(organisation, device, observedDevices, event.currentTarget)
                )));
            }
            if (next && organisation.lifecycleState === 'onboarding') {
                const nextButton = button(next[1], 'button button-secondary', (event) => (
                    updateOnboardingDevice(organisation, device, next[0], event.currentTarget)
                ));
                if (next[0] === 'verified' && device.matchStatus !== 'confirmed') nextButton.disabled = true;
                actions.push(nextButton);
            }
            if (!['verified', 'blocked'].includes(device.status) && organisation.lifecycleState === 'onboarding') {
                actions.push(button('Mark blocked', 'button button-secondary', (event) => (
                    updateOnboardingDevice(organisation, device, 'blocked', event.currentTarget)
                )));
            }
            deviceList.append(el('div', { className: 'onboarding-device' }, [
                el('div', {}, [
                    el('strong', { text: device.label }),
                    el('span', { text: `${pretty(device.platform)} · ${pretty(device.status)} · ${pretty(device.matchStatus || 'unmatched')}` })
                ]),
                el('div', { className: 'organisation-actions' }, actions)
            ]));
        });
        const gateList = el('ol', { className: 'onboarding-gates' });
        gates.forEach((gate) => {
            const actions = [];
            const dependenciesComplete = (gate.dependencies || []).every((dependency) => gateStatuses.get(dependency) === 'complete');
            const unmetDependencies = (gate.dependencies || []).filter((dependency) => gateStatuses.get(dependency) !== 'complete');
            if (gate.id === 'monitoring_acceptance' && gate.status !== 'complete') {
                const accept = button('Accept starting checks', 'button button-secondary', (event) => (
                    recordMonitoringAcceptance(organisation, gate, event.currentTarget)
                ));
                accept.disabled = !dependenciesComplete;
                actions.push(accept);
            }
            if (gate.id === 'active_service_approval' && gate.status !== 'complete') {
                const request = (organisation.activationRequests || []).slice().reverse().find((item) => ['pending', 'approved'].includes(item.status));
                const currentEmail = String(state.user.email || '').toLowerCase();
                let label = 'Request activation';
                let action = 'request';
                let disabled = !dependenciesComplete;
                if (request && request.status === 'pending') {
                    label = 'Approve activation';
                    action = 'review';
                    disabled = String(request.maker && request.maker.email || '').toLowerCase() === currentEmail;
                } else if (request && request.status === 'approved') {
                    label = 'Execute activation';
                    action = 'execute';
                    disabled = [request.maker, request.checker].some((actor) => String(actor && actor.email || '').toLowerCase() === currentEmail);
                }
                const activate = button(label, 'button', (event) => activationAction(organisation, request, action, event.currentTarget));
                activate.disabled = disabled;
                actions.push(activate);
            }
            gateList.append(el('li', { className: `gate-${gate.status}` }, [
                el('div', {}, [
                    el('strong', { text: gate.title }),
                    el('span', { text: pretty(gate.status) }),
                    el('small', { text: `Owner: ${pretty(gate.owner || 'onboarding coordinator')}${unmetDependencies.length ? ` · Waiting for ${unmetDependencies.length} earlier ${unmetDependencies.length === 1 ? 'check' : 'checks'}` : ''}` })
                ]),
                ...actions
            ]));
        });
        return el('section', { className: 'detail-panel detail-panel-wide agentic-panel' }, [
            el('div', { className: 'agentic-heading' }, [
                el('div', {}, [
                    el('p', { className: 'eyebrow', text: 'Customer set-up' }),
                    el('h3', { text: 'Set-up coordinator' })
                ]),
                el('span', { className: 'pill', text: pretty(plan.status) })
            ]),
            el('p', { className: 'agentic-next', text: `Next action: ${plan.nextAction}` }),
            el('p', { text: plan.guardrail }),
            devices.length ? el('div', {}, [el('h4', { text: 'Computer set-up' }), deviceList]) : null,
            el('div', {}, [el('h4', { text: 'Set-up checks' }), gateList])
        ]);
    }

    async function createInternalPilot(event, form, target) {
        event.preventDefault();
        const confirmation = form.elements.namedItem('confirmation');
        if (!confirmation || !confirmation.checked) {
            showToast('Confirm the isolated internal-pilot boundary first.');
            return;
        }

        const expectedEndpoints = Number(form.elements.namedItem('endpoints').value);
        const parsedRows = String(form.elements.namedItem('devicePlan').value || '')
            .split(/\r?\n/)
            .map((row) => row.trim())
            .filter(Boolean)
            .map((row) => row.split('|').map((part) => part.trim()));
        if (!Number.isInteger(expectedEndpoints) || expectedEndpoints < 1 || expectedEndpoints > 50) {
            showToast('Expected computers must be a whole number from 1 to 50.');
            return;
        }
        if (!parsedRows.length || parsedRows.length > expectedEndpoints) {
            showToast(`Provide between 1 and ${expectedEndpoints} representative computer row${expectedEndpoints === 1 ? '' : 's'}.`);
            return;
        }
        const supportedPlatforms = new Set(['windows', 'macos', 'linux']);
        if (parsedRows.some((parts) => (
            parts.length !== 3 ||
            !parts[0] ||
            !parts[1] ||
            !supportedPlatforms.has(parts[2].toLowerCase())
        ))) {
            showToast('Each planned computer must use: ID | label | windows, macos or linux.');
            return;
        }
        const deviceIds = parsedRows.map((parts) => parts[0].toLowerCase());
        if (new Set(deviceIds).size !== deviceIds.length) {
            showToast('Every planned computer must have a unique ID.');
            return;
        }
        const devices = parsedRows.map(([id, label, platform]) => ({
            id,
            label,
            platform: platform.toLowerCase(),
            status: 'planned'
        }));

        if (!window.confirm('Create this customer directly in set-up with a recorded internal-pilot approval?')) return;
        setBusy(target, true, 'Creating…');
        try {
            const body = {
                expectedRevision: state.revision,
                displayName: form.elements.namedItem('customerName').value,
                primaryContactName: form.elements.namedItem('contactName').value,
                primaryEmail: form.elements.namedItem('contactEmail').value,
                location: form.elements.namedItem('location').value,
                expectedUsers: Number(form.elements.namedItem('users').value),
                expectedEndpoints,
                productivityPlatform: form.elements.namedItem('platform').value,
                devices,
                confirmInternalPilot: true
            };
            const result = await api('/api/lifecycle/organisations/pilot', { method: 'POST', body });
            showToast(`${result.organisation.displayName} created in set-up with ${devices.length} computer ${devices.length === 1 ? 'plan that requires' : 'plans that require'} approval.`);
            await load();
        } catch (error) {
            showToast(error.message || 'The internal pilot customer could not be created.');
            setBusy(target, false, 'Create set-up customer');
        }
    }

    async function updateOnboardingDevice(organisation, device, status, target) {
        setBusy(target, true, 'Saving…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/onboarding-device`, {
                method: 'POST',
                body: { expectedRevision: state.revision, deviceId: device.id, status }
            });
            showToast(`${device.label} is now ${pretty(status).toLowerCase()}.`);
            await load();
        } catch (error) {
            showToast(error.message || 'The computer set-up status could not be updated.');
            setBusy(target, false, 'Save status');
        }
    }

    async function matchOnboardingDevice(organisation, device, observedDevices, target) {
        const choices = observedDevices.map((item) => `${item.uid} · ${item.hostname || 'Unknown host'} · ${item.operatingSystem || 'Unknown OS'}`).join('\n');
        const providerDeviceUid = window.prompt(`Enter the exact Datto UID for ${device.label}:\n\n${choices}`, observedDevices[0] && observedDevices[0].uid || '');
        if (!providerDeviceUid || !window.confirm(`Bind ${device.label} to Datto UID ${providerDeviceUid}?`)) return;
        setBusy(target, true, 'Matching…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/device-match`, {
                method: 'POST',
                body: { expectedRevision: state.revision, deviceId: device.id, providerDeviceUid, confirmMatch: true }
            });
            showToast(`${device.label} identity matched to Datto evidence.`);
            await load();
        } catch (error) {
            showToast(error.message || 'The Datto device match could not be recorded.');
            setBusy(target, false, 'Match Datto device');
        }
    }

    async function recordMonitoringAcceptance(organisation, gate, target) {
        if (!window.confirm(`Record customer acceptance of monitoring and monthly proof for ${organisation.displayName}?`)) return;
        const evidenceRef = window.prompt('Evidence reference (agreement register or signed schedule ID):', 'agreement-register:monitoring-acceptance');
        const checksum = window.prompt('SHA-256 checksum of the accepted evidence:');
        const customerAuthorityRef = window.prompt('Customer authority reference:', 'authority-register:sponsor');
        if (!evidenceRef || !checksum || !customerAuthorityRef) return;
        const capturedAt = new Date().toISOString();
        setBusy(target, true, 'Recording…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/onboarding/evidence`, {
                method: 'POST',
                body: {
                    expectedRevision: state.revision,
                    gateId: gate.id,
                    evidenceType: 'customer_monitoring_acceptance',
                    source: 'signed_service_schedule',
                    sourceMode: 'manual',
                    evidenceRef,
                    checksum,
                    capturedAt,
                    validUntil: new Date(Date.now() + (365 * 24 * 60 * 60 * 1000)).toISOString(),
                    customerAcceptedAt: capturedAt,
                    customerAuthorityRef
                }
            });
            showToast('Customer monitoring acceptance recorded with evidence.');
            await load();
        } catch (error) {
            showToast(error.message || 'Monitoring acceptance could not be recorded.');
            setBusy(target, false, 'Accept starting checks');
        }
    }

    async function activationAction(organisation, request, action, target) {
        try {
            if (action === 'request') {
                const customerAuthorityRef = window.prompt('Customer authority reference for activation:', 'authority-register:sponsor');
                if (!customerAuthorityRef || !window.confirm('Submit G5 activation for review by a different person?')) return;
                setBusy(target, true, 'Submitting…');
                await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/activation-requests`, {
                    method: 'POST',
                    body: {
                        expectedRevision: state.revision,
                        idempotencyKey: `activate:${organisation.organisationId}:${organisation.onboarding.planRevision}`,
                        customerAuthorityRef,
                        confirmNoUnresolvedHighRiskExceptions: true
                    }
                });
                showToast('Activation requested. A different signed-in person must review it.');
            } else if (action === 'review') {
                if (!window.confirm('Approve this exact G5 activation request as the independent checker?')) return;
                setBusy(target, true, 'Approving…');
                await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/activation-requests/${encodeURIComponent(request.id)}/review`, {
                    method: 'POST',
                    body: { expectedRevision: state.revision, decision: 'approve' }
                });
                showToast('Activation approved. A third signed-in identity must execute it.');
            } else {
                if (!window.confirm(`Activate ${organisation.displayName}? You must be different from both maker and checker.`)) return;
                setBusy(target, true, 'Activating…');
                await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/activation-requests/${encodeURIComponent(request.id)}/execute`, {
                    method: 'POST',
                    body: { expectedRevision: state.revision, confirmActivation: true }
                });
                showToast('Customer activated after maker, checker and executor separation.');
            }
            await load();
        } catch (error) {
            showToast(error.message || 'The activation control could not be completed.');
            setBusy(target, false, action === 'execute' ? 'Execute activation' : 'Save');
        }
    }

    async function checkDattoConnection(event) {
        const target = event && event.currentTarget;
        setBusy(target, true, 'Checking…');
        try {
            const result = await api('/api/datto-rmm/health');
            const mode = result.mode || dattoStatus && dattoStatus.mode || 'disabled';
            const version = result.platform && result.platform.version;
            showToast(`Datto RMM connected · ${pretty(mode)} mode${version ? ` · ${version}` : ''}.`);
        } catch (error) {
            showToast(error.message || 'Datto RMM connection check failed.');
        } finally {
            setBusy(target, false, 'Check connection');
        }
    }

    async function discoverDattoSites(event) {
        const target = event && event.currentTarget;
        setBusy(target, true, 'Discovering…');
        try {
            const result = await api('/api/datto-rmm/sites');
            dattoSites = result.sites || [];
            showToast(`${dattoSites.length} Datto RMM site${dattoSites.length === 1 ? '' : 's'} discovered.`);
            render();
        } catch (error) {
            showToast(error.message || 'Datto RMM sites could not be discovered.');
            setBusy(target, false, 'Discover sites');
        }
    }

    async function linkDattoSite(site, organisationId, target) {
        if (!organisationId) return;
        setBusy(target, true, 'Syncing…');
        try {
            const result = await api(`/api/datto-rmm/sites/${encodeURIComponent(site.siteUid)}/link`, {
                method: 'POST',
                body: { organisationId, expectedRevision: state.revision }
            });
            const integration = result.organisation.integrations.dattoRmm;
            showToast(`${site.name} linked and synced · ${integration.deviceCount} devices · ${integration.openAlertCount} open alerts.`);
            await load();
        } catch (error) {
            showToast(error.message || 'The Datto RMM site could not be linked.');
            setBusy(target, false, 'Link & sync');
        }
    }

    async function prepareDattoOnboarding(organisation, target) {
        if (!(dattoStatus && dattoStatus.writeOperationsEnabled === true)) {
            showToast('Datto RMM controlled-write mode is not enabled.');
            return;
        }
        const mappedSiteUid = organisation.links && organisation.links.dattoRmmSiteUid ||
            organisation.integrations && organisation.integrations.dattoRmm && organisation.integrations.dattoRmm.siteUid;
        const plannedDevices = organisation.onboarding && organisation.onboarding.devices || [];
        const deviceSummary = plannedDevices.map((device) => (
            `• ${device.label} · ${pretty(device.platform)} · owner: ${device.owner || 'missing'} · ${pretty(device.status)}`
        )).join('\n');
        if (!window.confirm([
            `Prepare the canonical Datto site for “${organisation.displayName}” and these exact devices?`,
            '',
            deviceSummary || '• No planned devices',
            '',
            'Confirm all five controls: the accepted customer authority covers this onboarding plan; every endpoint is customer-owned or explicitly authorised; no incumbent or other provider has an unresolved management claim; each recorded Windows edition, macOS version or Linux distribution meets Datto’s current requirements; and Datto New Device Approval is enabled.'
        ].join('\n'))) return;
        setBusy(target, true, 'Preparing…');
        try {
            const result = await api('/api/datto-rmm/onboarding/prepare', {
                method: 'POST',
                body: {
                    organisationId: organisation.organisationId,
                    expectedRevision: state.revision,
                    siteName: organisation.displayName,
                    confirmCustomerAuthority: true,
                    confirmAuthorisedDevices: true,
                    confirmNoConflictingManagement: true,
                    confirmSupportedOperatingSystems: true,
                    confirmNewDeviceApprovalEnabled: true,
                    confirm: true
                }
            });
            dattoOnboardingHandoffs.set(organisation.organisationId, result);
            showToast(
                `${result.site && result.site.name || organisation.displayName} is ready. Use the installer links and complete every human-required check.`
            );
            await load();
        } catch (error) {
            showToast(error.message || 'Datto RMM onboarding could not be prepared.');
            setBusy(target, false, mappedSiteUid ? 'Prepare customer installers' : 'Prepare customer site & installers');
        }
    }

    async function bindApprovedProposal(organisation, target, proposalIdOverride) {
        const proposalId = proposalIdOverride || window.prompt('Approved Sales proposal ID:');
        if (!proposalId) return;
        setBusy(target, true, 'Verifying proposal…');
        try {
            const proposalResult = await api(`/api/sales/proposals/${encodeURIComponent(proposalId)}`);
            const proposal = proposalResult.proposal || {};
            const approvalSeal = proposal.approvalSeal || {};
            if (proposal.status !== 'approved' || approvalSeal.status !== 'sealed' || !approvalSeal.version || !approvalSeal.sha256) {
                throw new Error('Approve and seal this proposal version in Sales before binding it.');
            }
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/proposal-ready`, {
                method: 'POST',
                body: {
                    expectedRevision: state.revision,
                    proposalId,
                    proposalVersion: approvalSeal.version,
                    proposalSha256: approvalSeal.sha256,
                    confirmApprovedProposal: true
                }
            });
            showToast(`Proposal ${proposalId} verified and bound. The record is ready for customer acceptance.`);
            await load();
        } catch (error) {
            showToast(error.message || 'The approved proposal could not be bound.');
            setBusy(target, false, proposalIdOverride ? 'Verify approved proposal' : 'Bind approved proposal');
        }
    }

    async function recordCommercialAcceptance(organisation, target, proposalIdOverride) {
        const proposalId = proposalIdOverride || window.prompt('Approved proposal ID:', organisation.scope && organisation.scope.proposalId || '');
        if (!proposalId) return;
        setBusy(target, true, 'Verifying proposal…');
        try {
            const proposalResult = await api(`/api/sales/proposals/${encodeURIComponent(proposalId)}`);
            const proposal = proposalResult.proposal || {};
            const approvalSeal = proposal.approvalSeal || {};
            if (proposal.status !== 'approved' || approvalSeal.status !== 'sealed' || !approvalSeal.version || !approvalSeal.sha256) {
                throw new Error('Approve and seal this proposal version in Sales before recording acceptance.');
            }
            const proposalVersion = approvalSeal.version;
            const proposalSha256 = approvalSeal.sha256;
            const signatoryName = window.prompt('Customer signatory name:', organisation.context.contacts.primary.name || '');
            const signatoryEmail = window.prompt('Customer signatory email:', organisation.context.contacts.primary.email || '');
            const signatoryTitle = window.prompt('Customer signatory title:');
            const authorityEvidenceId = window.prompt('Signed agreement/authority evidence reference:');
            const authorityEvidenceSha256 = window.prompt('SHA-256 of the authority evidence:');
            if (![signatoryName, signatoryEmail, signatoryTitle, authorityEvidenceId, authorityEvidenceSha256].every(Boolean)) {
                setBusy(target, false, proposalIdOverride ? 'Record customer acceptance' : 'Record acceptance');
                return;
            }
            const acceptedAt = new Date().toISOString();
            setBusy(target, true, 'Recording…');
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/commercial-acceptance`, {
                method: 'POST',
                body: {
                    expectedRevision: state.revision,
                    idempotencyKey: `accept:${organisation.organisationId}:${proposalVersion}`,
                    proposalId,
                    proposalVersion,
                    proposalSha256,
                    acceptedAt,
                    effectiveDate: acceptedAt,
                    signatoryName,
                    signatoryEmail,
                    signatoryTitle,
                    authorityBasis: 'Customer signatory authority confirmed against the authority register',
                    authorityEvidenceId,
                    authorityEvidenceSha256,
                    authorityMatrixVersion: 'customer-authority-v1',
                    confirmCustomerAuthority: true
                }
            });
            showToast('Commercial acceptance recorded. Customer master is ready for onboarding.');
            await load();
        } catch (error) {
            showToast(error.message || 'Commercial acceptance could not be recorded.');
            setBusy(target, false, proposalIdOverride ? 'Record customer acceptance' : 'Record acceptance');
        }
    }

    async function startExternalOnboarding(organisation, target) {
        const contractedEndpointCount = Number(window.prompt(
            'Total contracted managed endpoints:',
            String(organisation.context.endpoints.estimatedCount || 1)
        ));
        if (!Number.isInteger(contractedEndpointCount) || contractedEndpointCount < 1 || contractedEndpointCount > 1000000) return;
        const plannedDeviceCount = Number(window.prompt(
            'Number of named devices in this representative onboarding plan (1-50, no more than the contracted total):',
            String(Math.min(contractedEndpointCount, 2))
        ));
        if (
            !Number.isInteger(plannedDeviceCount) || plannedDeviceCount < 1 ||
            plannedDeviceCount > 50 || plannedDeviceCount > contractedEndpointCount
        ) return;
        const labelsInput = window.prompt('Device labels separated by commas:', Array.from({ length: plannedDeviceCount }, (_, index) => `Device ${index + 1}`).join(', '));
        const labels = String(labelsInput || '').split(',').map((item) => item.trim()).filter(Boolean);
        const uniqueLabels = new Set(labels.map((label) => label.toLowerCase()));
        if (labels.length !== plannedDeviceCount || uniqueLabels.size !== labels.length) {
            showToast('Provide one unique device label for every planned device.', true);
            return;
        }
        const allowedPlatforms = new Set(['windows', 'macos', 'linux']);
        const plannedDevices = [];
        for (const [index, label] of labels.entries()) {
            const labelHint = label.toLowerCase();
            const defaultPlatform = /mac|apple/.test(labelHint)
                ? 'macos'
                : /linux|ubuntu|debian|fedora|red hat|rhel/.test(labelHint) ? 'linux' : 'windows';
            const platformInput = window.prompt(
                `Platform for “${label}” (windows, macos or linux):`,
                defaultPlatform
            );
            if (platformInput == null) return;
            const platform = String(platformInput).trim().toLowerCase();
            if (!allowedPlatforms.has(platform)) {
                showToast(`Choose windows, macos or linux for ${label}.`);
                return;
            }
            plannedDevices.push({
                id: `planned_device_${index + 1}`,
                label,
                platform,
                status: 'planned'
            });
        }
        const primaryName = organisation.context.contacts.primary.name || organisation.displayName;
        const sponsorEmail = window.prompt('Sponsor email:', organisation.context.contacts.primary.email || '');
        if (!sponsorEmail) return;
        for (const device of plannedDevices) {
            const owner = window.prompt(
                `Customer/device owner or authorised installer email for “${device.label}”:`,
                sponsorEmail
            );
            if (!owner) return;
            device.owner = String(owner).trim().toLowerCase();
        }
        const technicalEmail = window.prompt('Technical contact email:', sponsorEmail || '');
        const securityEmail = window.prompt('Security contact email:', sponsorEmail || '');
        const billingEmail = window.prompt('Billing contact email:', sponsorEmail || '');
        const emergencyEmail = window.prompt('After-hours emergency contact email:', sponsorEmail || '');
        const agreementId = window.prompt('Signed service agreement ID:');
        const agreementVersion = window.prompt('Agreement version:', 'v1');
        const agreementHash = window.prompt('SHA-256 of the signed service schedule:');
        const slaId = window.prompt('SLA schedule ID:', 'business-hours-v1');
        const supportHours = window.prompt('Support hours:', '08:30-17:00 Monday-Friday');
        const billingProfileId = window.prompt('Billing profile ID:');
        const currentExternalRefs = organisation.customerMaster && organisation.customerMaster.externalRefs || [];
        const currentReference = (system, recordType) => currentExternalRefs.find((reference) => (
            reference.system === system && reference.recordType === recordType && reference.status === 'verified'
        ));
        const currentHubspot = currentReference('hubspot', 'company');
        const currentAutotask = currentReference('autotask', 'account');
        const hubspotCompanyId = window.prompt(
            'Verified HubSpot company ID:',
            currentHubspot && currentHubspot.externalId || ''
        );
        const autotaskAccountId = window.prompt(
            'Verified Autotask account ID:',
            currentAutotask && currentAutotask.externalId || ''
        );
        const mappingRequired = !currentHubspot || currentHubspot.externalId !== hubspotCompanyId ||
            !currentAutotask || currentAutotask.externalId !== autotaskAccountId;
        const crosswalkEvidenceRef = mappingRequired ? window.prompt('Crosswalk verification evidence reference:') : '';
        if (
            ![sponsorEmail, technicalEmail, securityEmail, billingEmail, emergencyEmail, agreementId, agreementVersion, agreementHash, slaId, supportHours, billingProfileId, hubspotCompanyId, autotaskAccountId].every(Boolean) ||
            (mappingRequired && !crosswalkEvidenceRef)
        ) return;
        const now = new Date().toISOString();
        const contact = (name, email, role) => ({ name, email, role, evidenceRef: `authority-register:${role}` });
        setBusy(target, true, 'Starting…');
        try {
            let expectedRevision = state.revision;
            for (const reference of [
                { system: 'hubspot', recordType: 'company', externalId: hubspotCompanyId },
                { system: 'autotask', recordType: 'account', externalId: autotaskAccountId }
            ]) {
                const existing = currentReference(reference.system, reference.recordType);
                if (existing && existing.externalId === reference.externalId) continue;
                if (!hasCapability('integration:map')) {
                    throw new Error(`An administrator or service owner must verify the ${pretty(reference.system)} system ID before onboarding.`);
                }
                const mapped = await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/external-reference`, {
                    method: 'POST',
                    body: Object.assign({}, reference, {
                        expectedRevision,
                        status: 'verified',
                        verificationMode: 'manual',
                        evidenceRef: crosswalkEvidenceRef,
                        confirmManuallyVerified: true
                    })
                });
                expectedRevision = mapped.revision;
            }
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/onboarding/start`, {
                method: 'POST',
                body: {
                    expectedRevision,
                    customerMaster: {
                        identity: { legalName: organisation.displayName, tradingName: organisation.displayName, domains: [] },
                        contacts: {
                            sponsor: contact(primaryName, sponsorEmail, 'sponsor'),
                            technical: contact('Technical contact', technicalEmail, 'technical'),
                            security: contact('Security contact', securityEmail, 'security'),
                            billing: contact('Billing contact', billingEmail, 'billing'),
                            emergencyAfterHours: contact('Emergency contact', emergencyEmail, 'emergency')
                        },
                        serviceSchedule: {
                            agreementId,
                            version: agreementVersion,
                            contentHash: agreementHash,
                            startAt: now,
                            supportHours,
                            slaId,
                            timezone: 'Pacific/Auckland'
                        },
                        entitlements: [{ code: 'managed_endpoint', name: 'Managed endpoint', quantity: contractedEndpointCount, effectiveFrom: now }],
                        estate: { contractedEndpoints: contractedEndpointCount, plannedDevices: plannedDeviceCount },
                        billing: { profileId: billingProfileId, currency: 'NZD', taxTreatment: 'gst_standard', billingCadence: 'monthly' },
                        governance: { serviceOwner: state.user.email, proofDueRule: 'monthly' }
                    },
                    supportProfile: {
                        contractStatus: 'signed',
                        serviceStartAt: now,
                        slaScheduleRef: `${agreementId}:${slaId}`,
                        slaVersion: agreementVersion,
                        timezone: 'Pacific/Auckland',
                        supportHours,
                        channels: ['email', 'phone', 'portal'],
                        authorisedRequesters: [{
                            name: primaryName,
                            email: sponsorEmail,
                            role: 'Sponsor',
                            verificationMethod: 'Customer authority register',
                            evidenceRef: 'authority-register:sponsor',
                            effectiveFrom: now,
                            canApproveRiskyActions: true
                        }]
                    },
                    devices: plannedDevices
                }
            });
            showToast(`Customer onboarding started for ${plannedDeviceCount} planned device${plannedDeviceCount === 1 ? '' : 's'} across ${contractedEndpointCount} contracted endpoint${contractedEndpointCount === 1 ? '' : 's'}.`);
            await load();
        } catch (error) {
            showToast(error.message || 'External onboarding could not be started.');
            setBusy(target, false, 'Start onboarding');
        }
    }

    async function addExternalReference(organisation, target) {
        const system = window.prompt('System (hubspot, apollo, autotask, datto_rmm, kaseya_mdr, backup):');
        const recordType = window.prompt('Record type (company, contact, deal, account, contract, site, device, organisation, tenant):');
        const externalId = window.prompt('Exact external record ID:');
        const action = String(window.prompt('Action (verify or retire):', 'verify') || '').trim().toLowerCase();
        const evidenceRef = window.prompt(action === 'retire' ? 'Retirement evidence reference:' : 'Manual verification evidence reference:');
        const retirementReason = action === 'retire' ? window.prompt('Reason for retiring this exact mapping:') : '';
        if (![system, recordType, externalId, evidenceRef].every(Boolean) || !['verify', 'retire'].includes(action) || (action === 'retire' && !retirementReason)) return;
        setBusy(target, true, 'Saving…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/external-reference`, {
                method: 'POST',
                body: {
                    expectedRevision: state.revision,
                    system,
                    recordType,
                    externalId,
                    status: action === 'retire' ? 'retired' : 'verified',
                    verificationMode: 'manual',
                    evidenceRef,
                    confirmManuallyVerified: action === 'verify',
                    confirmRetirement: action === 'retire',
                    retirementReason
                }
            });
            showToast(`${pretty(system)} system ID ${action === 'retire' ? 'retired' : 'saved and uniqueness-checked'}.`);
            await load();
        } catch (error) {
            showToast(error.message || 'The system ID could not be saved.');
            setBusy(target, false, 'Add system ID');
        }
    }

    async function updateCustomerMaster(organisation, target) {
        const customerMaster = JSON.parse(JSON.stringify(organisation.customerMaster || {}));
        const contacts = customerMaster.contacts || {};
        for (const role of ['sponsor', 'technical', 'security', 'billing', 'emergencyAfterHours']) {
            const contact = contacts[role] || {};
            const email = window.prompt(`${pretty(role)} contact email:`, contact.email || '');
            if (email === null) return;
            contact.email = email;
            contacts[role] = contact;
        }
        customerMaster.contacts = contacts;
        const billingProfileId = window.prompt('Billing profile ID:', customerMaster.billing && customerMaster.billing.profileId || '');
        const contractedEndpoints = Number(window.prompt('Contracted endpoint count:', String(customerMaster.estate && customerMaster.estate.contractedEndpoints || 0)));
        const reason = window.prompt('Reason for this customer-master change:');
        const evidenceRef = window.prompt('Approved change evidence reference:');
        if (!billingProfileId || !Number.isInteger(contractedEndpoints) || contractedEndpoints < 0 || !reason || !evidenceRef) return;
        customerMaster.billing = Object.assign({}, customerMaster.billing, { profileId: billingProfileId });
        customerMaster.estate = Object.assign({}, customerMaster.estate, { contractedEndpoints });
        delete customerMaster.customerId;
        delete customerMaster.externalRefs;
        delete customerMaster.authority;
        setBusy(target, true, 'Updating…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/customer-master/change`, {
                method: 'POST',
                body: {
                    expectedRevision: state.revision,
                    customerMaster,
                    reason,
                    evidenceRef,
                    confirmChange: true
                }
            });
            showToast('Customer master updated and the prior version retained.');
            await load();
        } catch (error) {
            showToast(error.message || 'The customer master could not be updated.');
            setBusy(target, false, 'Update customer master');
        }
    }

    async function updateSupportProfile(organisation, target) {
        const supportProfile = JSON.parse(JSON.stringify(organisation.supportProfile || {}));
        const currentRequesters = supportProfile.authorisedRequesters || [];
        const requesterEmails = window.prompt(
            'Authorised requester emails, separated by commas:',
            currentRequesters.map((requester) => requester.email).join(', ')
        );
        if (requesterEmails === null) return;
        const emails = requesterEmails.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
        const channelsInput = window.prompt('Authorised channels (email, phone, portal):', (supportProfile.channels || []).join(', '));
        const reason = window.prompt('Reason for this support-access change:');
        const evidenceRef = window.prompt('Approved change evidence reference:');
        if (!emails.length || !channelsInput || !reason || !evidenceRef) return;
        supportProfile.channels = channelsInput.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
        supportProfile.authorisedRequesters = emails.map((email) => {
            const existing = currentRequesters.find((requester) => requester.email === email);
            return existing || {
                name: email,
                email,
                role: 'Authorised requester',
                verificationMethod: 'Customer-approved requester change',
                evidenceRef,
                effectiveFrom: new Date().toISOString(),
                canApproveRiskyActions: false
            };
        });
        setBusy(target, true, 'Updating…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/support-profile/change`, {
                method: 'POST',
                body: {
                    expectedRevision: state.revision,
                    supportProfile,
                    reason,
                    evidenceRef,
                    confirmChange: true
                }
            });
            showToast('Support access updated and the prior version retained.');
            await load();
        } catch (error) {
            showToast(error.message || 'Support access could not be updated.');
            setBusy(target, false, 'Update support access');
        }
    }

    async function recordProofEvidence(organisation, target) {
        const timezone = organisation.supportProfile && organisation.supportProfile.timezone || 'Pacific/Auckland';
        let periodParts;
        try {
            periodParts = new Intl.DateTimeFormat('en-CA', {
                timeZone: timezone,
                year: 'numeric',
                month: '2-digit'
            }).formatToParts(new Date());
        } catch (error) {
            showToast('The customer Proof timezone is invalid. Correct the support profile before recording evidence.');
            return;
        }
        const localYear = Number(periodParts.find((item) => item.type === 'year').value);
        const localMonth = Number(periodParts.find((item) => item.type === 'month').value);
        const completedMonth = localMonth === 1
            ? { year: localYear - 1, month: 12 }
            : { year: localYear, month: localMonth - 1 };
        const defaultPeriod = `${String(completedMonth.year).padStart(4, '0')}-${String(completedMonth.month).padStart(2, '0')}`;
        const period = window.prompt('Proof period (YYYY-MM):', defaultPeriod);
        if (!period) return;
        setBusy(target, true, 'Loading period…');
        let proofView;
        try {
            proofView = await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/proof?period=${encodeURIComponent(period)}`);
        } catch (error) {
            showToast(error.message || 'Proof-period coverage could not be loaded.');
            setBusy(target, false, 'Add proof evidence');
            return;
        }
        const coverage = proofView && proofView.proof && proofView.proof.coverage;
        if (!coverage || !coverage.periodStart || !coverage.periodEnd) {
            showToast('Canonical Proof-period coverage is unavailable. Correct the customer timezone before recording evidence.');
            setBusy(target, false, 'Add proof evidence');
            return;
        }
        const source = window.prompt('Proof source (service_desk, datto_rmm, mdr, backup, change, risk, billing, roadmap):');
        const evidenceRef = window.prompt('Evidence record reference:');
        const checksum = window.prompt('SHA-256 checksum of the evidence:');
        if (![source, evidenceRef, checksum].every(Boolean)) {
            setBusy(target, false, 'Add proof evidence');
            return;
        }
        if (!window.confirm(
            `Confirm this source actually covers the complete ${period} reporting month in ${timezone}:\n` +
            `${coverage.periodStart} through ${coverage.periodEnd} (inclusive).`
        )) {
            setBusy(target, false, 'Add proof evidence');
            return;
        }
        const capturedAt = new Date().toISOString();
        setBusy(target, true, 'Recording…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/proof`, {
                method: 'POST',
                body: {
                    expectedRevision: proofView.revision,
                    period,
                    source,
                    category: `${source}_monthly_evidence`,
                    sourceMode: 'manual',
                    evidenceRef,
                    checksum,
                    periodStart: coverage.periodStart,
                    periodEnd: coverage.periodEnd,
                    capturedAt,
                    freshUntil: new Date(Date.now() + (40 * 24 * 60 * 60 * 1000)).toISOString()
                }
            });
            showToast(`${pretty(source)} proof evidence recorded with coverage and freshness metadata.`);
            await load();
        } catch (error) {
            showToast(error.message || 'Proof evidence could not be recorded.');
            setBusy(target, false, 'Add proof evidence');
        }
    }

    async function changeServiceStatus(organisation, action, target) {
        const reason = window.prompt(`Reason to ${pretty(action).toLowerCase()} service:`);
        const customerAuthorityRef = window.prompt('Customer authority reference:');
        if (!reason || !customerAuthorityRef || !window.confirm(`Apply ${pretty(action)} to ${organisation.displayName}?`)) return;
        setBusy(target, true, 'Saving…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/service-status`, {
                method: 'POST',
                body: { expectedRevision: state.revision, action, reason, customerAuthorityRef }
            });
            showToast(`Service status updated for ${organisation.displayName}.`);
            await load();
        } catch (error) {
            showToast(error.message || 'Service status could not be changed.');
            setBusy(target, false, pretty(action));
        }
    }

    async function runCustomerControls(event) {
        const target = event && event.currentTarget;
        if (!window.confirm('Generate only due internal operator tasks? No Autotask or vendor writes will occur.')) return;
        setBusy(target, true, 'Generating…');
        try {
            const result = await api('/api/lifecycle/controls/run', {
                method: 'POST',
                body: { expectedRevision: state.revision, confirmInternalOnly: true }
            });
            showToast(`${result.generated.length} due internal control task${result.generated.length === 1 ? '' : 's'} generated.`);
            await load();
        } catch (error) {
            showToast(error.message || 'Due customer controls could not be generated.');
            setBusy(target, false, 'Generate due internal controls');
        }
    }

    async function prepareScoping(organisation, target) {
        setBusy(target, true, 'Preparing…');
        try {
            const result = await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}/prepare-scoping`, {
                method: 'POST',
                body: { expectedRevision: state.revision }
            });
            showToast('Known discovery information is ready for the operator-confirmed service review.');
            window.location.assign(result.handoff.url);
        } catch (error) {
            showToast(error.message || 'The service review could not be prepared.');
            setBusy(target, false, 'Prepare service review');
        }
    }

    async function deleteOrganisation(organisation, target) {
        const confirmation = window.prompt(`Type “${organisation.displayName}” to delete this unlinked lifecycle record and its prospect conversation.`);
        if (confirmation == null) return;
        setBusy(target, true, 'Deleting…');
        try {
            await api(`/api/lifecycle/organisations/${encodeURIComponent(organisation.organisationId)}`, {
                method: 'DELETE',
                body: {
                    expectedRevision: state.revision,
                    confirmName: confirmation
                }
            });
            showToast('Lifecycle prospect data deleted. A minimal deletion audit event remains.');
            await load();
        } catch (error) {
            showToast(error.message || 'The lifecycle record could not be deleted.');
            setBusy(target, false, 'Delete');
        }
    }

    async function reviewRetention(event) {
        const target = event && event.currentTarget;
        setBusy(target, true, 'Reviewing…');
        try {
            const preview = await api('/api/lifecycle/retention');
            const total = preview.expiredOrganisations.length + preview.expiredRawMessageCount + preview.expiredObservabilityCount;
            if (!total) {
                showToast('No lifecycle data currently meets the configured retention cutoffs.');
                setBusy(target, false, 'Retention review');
                return;
            }
            const detail = `${preview.expiredOrganisations.length} abandoned prospects, ${preview.expiredRawMessageCount} raw messages and ${preview.expiredObservabilityCount} old automation activity records meet the cutoffs. Type PURGE EXPIRED PROSPECT DATA to continue.`;
            const confirmation = window.prompt(detail);
            if (confirmation == null) {
                setBusy(target, false, 'Retention review');
                return;
            }
            const result = await api('/api/lifecycle/retention', {
                method: 'POST',
                body: {
                    expectedRevision: state.revision,
                    confirmation
                }
            });
            showToast(`${result.result.expiredOrganisations.length} abandoned prospect records processed by retention.`);
            await load();
        } catch (error) {
            showToast(error.message || 'Retention could not be completed.');
            setBusy(target, false, 'Retention review');
        }
    }

    function sectionTitle(title, description) {
        return el('div', { className: 'section-title' }, [el('h2', { text: title }), el('p', { text: description })]);
    }

    function button(label, className, handler) {
        const value = el('button', { className, text: label, type: 'button' });
        value.addEventListener('click', handler);
        return value;
    }

    function el(tag, attributes, children) {
        const node = document.createElement(tag);
        Object.entries(attributes || {}).forEach(([key, value]) => {
            if (key === 'className') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'ariaLabel') node.setAttribute('aria-label', value);
            else node.setAttribute(key, value);
        });
        (children || []).forEach((child) => child && node.append(child));
        return node;
    }

    async function api(url, options) {
        const init = Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, options || {});
        if (init.body && typeof init.body !== 'string') {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(init.body);
        }
        const response = await fetch(url, init);
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) {
            window.location.replace('/api/auth/login?returnTo=%2Foperator');
            const authenticationError = new Error(payload.error || 'Sign-in is required.');
            authenticationError.code = payload.code || 'authentication_required';
            authenticationError.status = 401;
            throw authenticationError;
        }
        if (!response.ok) throw new Error(payload.error || 'No Fries could not complete that request.');
        return payload;
    }

    function setLoading(message) {
        loadingStatus.textContent = message;
    }

    function setBusy(target, busy, label) {
        if (!target) return;
        target.disabled = busy;
        target.textContent = label;
    }

    function showToast(message) {
        toast.textContent = message;
        toast.hidden = false;
        window.setTimeout(() => { toast.hidden = true; }, 5000);
    }

    function hasCapability(capability) {
        return Boolean(state.user && Array.isArray(state.user.capabilities) && state.user.capabilities.includes(capability));
    }

    function safeHttpsUrl(value) {
        try {
            const url = new URL(String(value || ''));
            if (url.protocol !== 'https:' || url.username || url.password) return '';
            return url.href;
        } catch (error) {
            return '';
        }
    }

    function checklistText(value) {
        if (value == null) return '';
        if (typeof value !== 'object') return String(value);
        const title = value.title || value.label || value.name || value.id || value.code || '';
        const detail = value.detail || value.description || '';
        return [title, detail].filter(Boolean).map(String).join(' — ');
    }

    function isNoFriesHqLabel(value) {
        const name = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return /^(no fries (?:hq|headquarters))(?: (?:workshop|internal pilot|pilot))?$/.test(name);
    }

    function pretty(value) {
        return String(value || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function coreDiscoveryLabel(organisation) {
        const count = organisation.discovery.missingFields.length;
        return count
            ? `${count} ${count === 1 ? 'detail' : 'details'} still to confirm`
            : 'Key discovery details recorded · service review pending';
    }

    function dateTime(value) {
        const date = new Date(String(value || ''));
        if (!Number.isFinite(date.getTime())) return 'Not recorded';
        return new Intl.DateTimeFormat('en-NZ', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Pacific/Auckland'
        }).format(date);
    }

    function money(value) {
        return Number(value || 0).toFixed(4);
    }

    function periodLabel(value) {
        const date = new Date(`${String(value || '')}-01T00:00:00Z`);
        if (!Number.isFinite(date.getTime())) return 'current month';
        return new Intl.DateTimeFormat('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
    }
}());
