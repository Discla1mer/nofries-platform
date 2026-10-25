(function () {
    const app = {
        bootstrap: null,
        revision: 0,
        view: 'overview',
        busy: false,
        dirty: false,
        customerDetail: null,
        activeAssessment: null,
        activeCustomer: null,
        activeProposal: null,
        proposalReview: null,
        blueprint: null,
        catalogue: null,
        catalogueDraft: null,
        catalogueCsv: '',
        audit: null,
        discoverySection: 0,
        filters: {
            customer: '',
            fit: 'all'
        }
    };

    const elements = {
        sidebar: document.getElementById('appSidebar'),
        main: document.getElementById('appMain'),
        loading: document.getElementById('loadingPanel'),
        viewRoot: document.getElementById('viewRoot'),
        identity: document.getElementById('workspaceIdentity'),
        tenantName: document.getElementById('tenantName'),
        roleBadge: document.getElementById('roleBadge'),
        userName: document.getElementById('userName'),
        saveIndicator: document.getElementById('saveIndicator'),
        toastRegion: document.getElementById('toastRegion'),
        dialog: document.getElementById('appDialog'),
        dialogEyebrow: document.getElementById('dialogEyebrow'),
        dialogTitle: document.getElementById('dialogTitle'),
        dialogBody: document.getElementById('dialogBody')
    };

    window.NoFriesSales = { start };

    function start(bootstrap) {
        app.bootstrap = bootstrap;
        app.revision = bootstrap.revision;
        bindEvents();
        renderIdentity();
        document.body.classList.remove('app-loading');
        elements.loading.hidden = true;
        elements.sidebar.hidden = false;
        elements.identity.hidden = false;
        elements.viewRoot.hidden = false;
        render();
    }

    function bindEvents() {
        document.addEventListener('click', handleClick);
        document.addEventListener('submit', handleSubmit);
        document.addEventListener('input', handleInput);
        document.addEventListener('change', handleChange);
        window.addEventListener('beforeunload', function (event) {
            if (!app.dirty) {
                return;
            }
            event.preventDefault();
            event.returnValue = '';
        });
    }

    async function handleClick(event) {
        const nav = event.target.closest('[data-view]');
        if (nav) {
            event.preventDefault();
            await navigate(nav.dataset.view);
            return;
        }

        const actionElement = event.target.closest('[data-action]');
        if (!actionElement) {
            return;
        }
        const action = actionElement.dataset.action;
        event.preventDefault();

        try {
            if (action === 'close-dialog') {
                closeDialog();
            } else if (action === 'new-customer') {
                showCustomerDialog();
            } else if (action === 'open-customer') {
                await openCustomer(actionElement.dataset.customerId);
            } else if (action === 'back-customers') {
                app.customerDetail = null;
                render();
            } else if (action === 'edit-customer') {
                showCustomerDialog(app.customerDetail && app.customerDetail.customer);
            } else if (action === 'delete-customer') {
                showDeleteCustomerDialog(app.customerDetail && app.customerDetail.customer);
            } else if (action === 'new-assessment') {
                showAssessmentDialog(actionElement.dataset.customerId || activeCustomerId());
            } else if (action === 'open-assessment') {
                await openAssessment(actionElement.dataset.assessmentId, actionElement.dataset.targetView || 'discovery');
            } else if (action === 'discovery-section') {
                app.discoverySection = Number(actionElement.dataset.sectionIndex || 0);
                render();
            } else if (action === 'save-discovery') {
                await saveDiscovery('draft');
            } else if (action === 'complete-discovery') {
                await completeDiscovery();
            } else if (action === 'build-proposal') {
                await buildProposal();
            } else if (action === 'open-proposal') {
                await openProposal(actionElement.dataset.proposalId);
            } else if (action === 'back-proposals') {
                app.activeProposal = null;
                app.proposalReview = null;
                render();
            } else if (action === 'review-proposal') {
                await reviewProposal();
            } else if (action === 'apply-proposal-review') {
                applyProposalReview();
            } else if (action === 'dismiss-proposal-review') {
                app.proposalReview = null;
                render();
            } else if (action === 'download-word') {
                downloadProposal('word');
            } else if (action === 'print-proposal') {
                downloadProposal('html');
            } else if (action === 'dynamics-preview') {
                await previewDynamics();
            } else if (action === 'dynamics-send') {
                await sendDynamics();
            } else if (action === 'download-template') {
                window.location.assign('/api/sales/catalogue/template');
            } else if (action === 'publish-catalogue') {
                await publishCatalogue(actionElement.dataset.versionId);
            } else if (action === 'reload') {
                await refreshBootstrap();
                await navigate(app.view);
            }
        } catch (error) {
            showError(error);
        }
    }

    async function handleSubmit(event) {
        const form = event.target;
        if (!form.dataset.form) {
            return;
        }
        event.preventDefault();
        try {
            if (form.dataset.form === 'customer') {
                await submitCustomer(form);
            } else if (form.dataset.form === 'delete-customer') {
                await deleteCustomer(form);
            } else if (form.dataset.form === 'assessment') {
                await createAssessment(form);
            } else if (form.dataset.form === 'recommendation') {
                await saveRecommendation(form);
            } else if (form.dataset.form === 'proposal') {
                await saveProposal(form, event.submitter && event.submitter.value);
            } else if (form.dataset.form === 'catalogue-import') {
                await importCatalogue(form);
            }
        } catch (error) {
            showError(error);
        }
    }

    function handleInput(event) {
        const field = event.target;
        if (field.dataset.answerField) {
            captureAnswerInput(field);
            setDirty(true);
        }
        if (field.dataset.proposalField) {
            if (app.proposalReview) app.proposalReview.stale = true;
            setDirty(true);
        }
    }

    async function handleChange(event) {
        const field = event.target;
        if (field.dataset.answerField) {
            captureAnswerInput(field);
            setDirty(true);
        }
        if (field.dataset.proposalField) {
            if (app.proposalReview) app.proposalReview.stale = true;
            setDirty(true);
        }
        if (field.dataset.filter === 'customer') {
            app.filters.customer = field.value;
            render();
        }
        if (field.dataset.filter === 'fit') {
            app.filters.fit = field.value;
            render();
        }
        if (field.id === 'catalogueFile' && field.files && field.files[0]) {
            app.catalogueCsv = await readFile(field.files[0]);
            const label = document.getElementById('catalogueFileName');
            if (label) {
                label.textContent = `${field.files[0].name} · ${Math.ceil(field.files[0].size / 1024)} KB ready to validate`;
            }
        }
    }

    async function navigate(view) {
        if (app.dirty && view !== app.view && !window.confirm('You have unsaved changes. Leave this view?')) {
            return;
        }
        setDirty(false);
        app.view = view;
        app.customerDetail = view === 'customers' ? app.customerDetail : null;
        if (view !== 'discovery' && view !== 'recommendations') {
            app.activeAssessment = null;
            app.activeCustomer = null;
        }
        if (view !== 'proposals') {
            app.activeProposal = null;
            app.proposalReview = null;
        }
        if (view === 'catalogue') {
            await loadCatalogue();
        }
        if (view === 'admin' && can('audit:read')) {
            await loadAudit();
        }
        render();
    }

    function render() {
        renderNavigation();
        if (app.view === 'customers') {
            renderCustomers();
        } else if (app.view === 'discovery') {
            renderDiscovery();
        } else if (app.view === 'recommendations') {
            renderRecommendations();
        } else if (app.view === 'proposals') {
            renderProposals();
        } else if (app.view === 'catalogue') {
            renderCatalogue();
        } else if (app.view === 'admin') {
            renderAdmin();
        } else {
            renderOverview();
        }
    }

    function renderNavigation() {
        document.querySelectorAll('[data-view]').forEach(function (item) {
            item.classList.toggle('is-active', item.dataset.view === app.view);
        });
    }

    function renderIdentity() {
        elements.tenantName.textContent = app.bootstrap.tenant.name;
        elements.roleBadge.textContent = roleLabel(app.bootstrap.user.role);
        elements.userName.textContent = app.bootstrap.user.name || app.bootstrap.user.email;
    }

    function renderOverview() {
        const data = app.bootstrap;
        const recentAssessments = data.assessments.slice().sort(sortUpdated).slice(0, 5);
        const recentProposals = data.proposals.slice().sort(sortUpdated).slice(0, 5);
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Consultant workspace', `Turn a structured customer conversation into reviewed service recommendations and an approved proposal.`, [
                button('New customer', 'new-customer', 'button-primary'),
                button('Start discovery', 'new-assessment', 'button-accent')
            ]),
            '<div class="metric-grid">',
            metric(data.counts.customers, 'Customers'),
            metric(data.counts.activeAssessments, 'Active discoveries'),
            metric(data.counts.completedAssessments, 'Completed discoveries'),
            metric(data.counts.proposals, 'Proposals'),
            metric(data.counts.publishedServices, 'Published services'),
            '</div>',
            !data.catalogue.publishedVersionId
                ? notice('Service catalogue required', 'Import and approve a private service catalogue before matching an assessment.', 'notice-warning', button('Open catalogue', '', '', 'data-view="catalogue"'))
                : '',
            '<div class="dashboard-grid">',
            '<section class="panel">',
            panelHeader('Recent work', '<span class="pill">Tenant activity</span>'),
            recentWork(recentAssessments, recentProposals),
            '</section>',
            '<section class="panel">',
            panelHeader('Quick start', ''),
            '<div class="quick-start">',
            quickLink('Create a customer', 'Capture the account context before discovery.', 'new-customer'),
            quickLink('Continue a discovery', 'Resume a saved 30-minute conversation.', '', 'data-view="discovery"'),
            quickLink('Review matches', 'Accept, reject, or validate each service recommendation.', '', 'data-view="recommendations"'),
            quickLink('Prepare a proposal', 'Edit the customer-facing output before approval.', '', 'data-view="proposals"'),
            '</div>',
            '</section>',
            '</div>',
            '<div class="two-column">',
            '<section class="panel">',
            panelHeader('Service catalogue', data.catalogue.publishedVersionId ? '<span class="status-badge status-published">Published</span>' : '<span class="status-badge status-draft">Not published</span>'),
            `<p>${data.catalogue.publishedVersionId
                ? `${h(data.catalogue.publishedLabel)} contains ${data.catalogue.serviceCount} services.`
                : 'No approved services are available to the matching engine yet.'}</p>`,
            `<button class="button" type="button" data-view="catalogue">Manage catalogue</button>`,
            '</section>',
            '<section class="panel">',
            panelHeader('Dynamics handoff', `<span class="status-badge ${data.integration.configured ? 'status-published' : 'status-draft'}">${data.integration.configured ? 'Configured' : 'Not configured'}</span>`),
            `<p>${data.integration.configured
                ? 'Approved proposals can be sent through the tenant-controlled one-way bridge.'
                : 'Payload preview is available. Production CRM writes remain disabled.'}</p>`,
            `<button class="button" type="button" data-view="admin">View integration status</button>`,
            '</section>',
            '</div>',
            '</section>'
        ].join('');
    }

    function renderCustomers() {
        if (app.customerDetail) {
            renderCustomerDetail();
            return;
        }
        const customers = app.bootstrap.customers.filter(function (customer) {
            return !app.filters.customer || customer.name.toLowerCase().includes(app.filters.customer.toLowerCase());
        });
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Customers', 'Keep the minimum account context needed to run discovery and prepare an approved CRM handoff.', [
                button('New customer', 'new-customer', 'button-primary')
            ]),
            '<div class="toolbar">',
            '<label><span>Find customer</span><input type="search" data-filter="customer" value="' + h(app.filters.customer) + '" placeholder="Search by name"></label>',
            `<span class="pill">${customers.length} shown</span>`,
            '</div>',
            customers.length ? '<div class="customer-grid">' + customers.map(customerCard).join('') + '</div>' : emptyState('No customers yet', 'Create the first customer using fictional or specifically approved information.', button('Create customer', 'new-customer', 'button-primary')),
            '</section>'
        ].join('');
    }

    function renderCustomerDetail() {
        const detail = app.customerDetail;
        const customer = detail.customer;
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading(customer.name, 'Customer record and discovery history.', [
                button('Back', 'back-customers'),
                button('Edit customer', 'edit-customer'),
                `<button class="button button-primary" type="button" data-action="new-assessment" data-customer-id="${h(customer.id)}">Start discovery</button>`
            ]),
            '<dl class="detail-grid">',
            detailItem('Industry', customer.industry || 'Not captured'),
            detailItem('Region', customer.region || 'Not captured'),
            detailItem('Segment', customer.segment || 'Not captured'),
            detailItem('Account owner', customer.accountOwner || 'Not captured'),
            detailItem('Dynamics Account ID', customer.dynamicsAccountId || 'Not linked'),
            detailItem('Classification', classificationBadge(customer.classification), true),
            '</dl>',
            customer.notes ? `<section class="panel"><h2>Account notes</h2><p>${nl2br(customer.notes)}</p></section>` : '',
            '<div class="two-column">',
            '<section class="panel">',
            panelHeader('Assessments', `<span class="pill">${detail.assessments.length}</span>`),
            detail.assessments.length ? '<ul class="compact-list">' + detail.assessments.slice().sort(sortUpdated).map(function (assessment) {
                return `<li><strong>${h(assessment.title)}</strong><small>${h(statusLabel(assessment.status))} · Updated ${h(formatDate(assessment.updatedAt))}</small><button class="button button-small" type="button" data-action="open-assessment" data-assessment-id="${h(assessment.id)}" data-target-view="${assessment.recommendationCount ? 'recommendations' : 'discovery'}">Open</button></li>`;
            }).join('') + '</ul>' : '<p>No discovery has been started.</p>',
            '</section>',
            '<section class="panel">',
            panelHeader('Proposals', `<span class="pill">${detail.proposals.length}</span>`),
            detail.proposals.length ? '<ul class="compact-list">' + detail.proposals.slice().sort(sortUpdated).map(function (proposal) {
                return `<li><strong>${h(proposal.title)}</strong><small>${h(statusLabel(proposal.status))} · Updated ${h(formatDate(proposal.updatedAt))}</small><button class="button button-small" type="button" data-action="open-proposal" data-proposal-id="${h(proposal.id)}">Open</button></li>`;
            }).join('') + '</ul>' : '<p>No proposal has been created.</p>',
            '</section>',
            '</div>',
            can('tenant:admin') ? `<section class="panel"><div class="panel-header"><div><p class="eyebrow">Retention control</p><h2>Delete this customer</h2></div>${button('Delete customer', 'delete-customer', 'button-danger')}</div><p>Deletion removes this customer and their assessments, proposals, and recorded Dynamics handoffs. Audit metadata records that deletion occurred.</p></section>` : '',
            '</section>'
        ].join('');
    }

    function renderDiscovery() {
        if (!app.activeAssessment || !app.blueprint) {
            renderDiscoveryList();
            return;
        }
        const assessment = app.activeAssessment;
        const visibleQuestions = getVisibleQuestions();
        const answered = visibleQuestions.filter(function (question) {
            return answerHasValue(assessment.answers[question.id]);
        }).length;
        const progress = visibleQuestions.length ? Math.round((answered / visibleQuestions.length) * 100) : 0;
        const section = app.blueprint.sections[app.discoverySection] || app.blueprint.sections[0];
        const sectionQuestions = visibleQuestions.filter(function (question) {
            return question.section === section.id;
        });
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading(assessment.title, `${h(app.activeCustomer.name)} · ${app.blueprint.estimatedMinutes}-minute guided discovery`, [
                `<span class="status-badge status-${h(assessment.status)}">${h(statusLabel(assessment.status))}</span>`
            ]),
            '<div class="progress-shell">',
            `<div class="progress-meta"><span>${answered} of ${visibleQuestions.length} visible questions answered</span><strong>${progress}%</strong></div>`,
            `<progress class="progress-track" max="100" value="${progress}" aria-label="${progress}% complete">${progress}%</progress>`,
            '</div>',
            '<div class="section-tabs" role="tablist" aria-label="Discovery sections">',
            app.blueprint.sections.map(function (item, index) {
                const questions = visibleQuestions.filter(function (question) { return question.section === item.id; });
                const complete = questions.length && questions.every(function (question) { return answerHasValue(assessment.answers[question.id]); });
                return `<button class="section-tab ${index === app.discoverySection ? 'is-active' : ''} ${complete ? 'is-complete' : ''}" type="button" data-action="discovery-section" data-section-index="${index}">${h(item.title)} · ${item.minutes} min</button>`;
            }).join(''),
            '</div>',
            '<div class="question-list">',
            sectionQuestions.map(function (question, index) {
                return renderQuestion(question, visibleQuestions.indexOf(question) + 1);
            }).join(''),
            '</div>',
            '<div class="discovery-footer">',
            `<span class="meta">${app.dirty ? 'Unsaved answer changes' : `Workspace revision ${app.revision}`}</span>`,
            '<div class="button-row">',
            button('Save draft', 'save-discovery'),
            button('Complete and match services', 'complete-discovery', 'button-primary'),
            '</div>',
            '</div>',
            '</section>'
        ].join('');
    }

    function renderDiscoveryList() {
        const assessments = app.bootstrap.assessments.slice().sort(sortUpdated);
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Discovery', 'Run a branching customer conversation designed to fit a 30-minute meeting.', [
                button('Start discovery', 'new-assessment', 'button-primary')
            ]),
            !app.bootstrap.catalogue.publishedVersionId ? notice('Publish the service catalogue first', 'You can capture answers now, but matching needs an approved catalogue version.', 'notice-warning', '<button class="button" type="button" data-view="catalogue">Open catalogue</button>') : '',
            assessments.length ? '<div class="customer-grid">' + assessments.map(function (assessment) {
                const customer = customerById(assessment.customerId);
                return [
                    '<article class="assessment-card">',
                    '<div class="card-header"><div><p class="eyebrow">' + h(customer ? customer.name : 'Customer') + '</p><h2>' + h(assessment.title) + '</h2></div>',
                    `<span class="status-badge status-${h(assessment.status)}">${h(statusLabel(assessment.status))}</span></div>`,
                    `<p>${assessment.recommendationCount ? `${assessment.recommendationCount} service matches generated.` : 'No matching run yet.'}</p>`,
                    `<div class="card-meta"><span>Updated ${h(formatDate(assessment.updatedAt))}</span><span>${assessment.acceptedCount} accepted</span></div>`,
                    `<button class="button button-primary" type="button" data-action="open-assessment" data-assessment-id="${h(assessment.id)}" data-target-view="discovery">${assessment.status === 'completed' ? 'Review discovery' : 'Continue discovery'}</button>`,
                    '</article>'
                ].join('');
            }).join('') + '</div>' : emptyState('No discoveries yet', 'Choose a customer and start the guided conversation.', button('Start discovery', 'new-assessment', 'button-primary')),
            '</section>'
        ].join('');
    }

    function renderRecommendations() {
        if (!app.activeAssessment || !app.activeAssessment.recommendations || !app.activeAssessment.recommendations.length) {
            renderRecommendationList();
            return;
        }
        const recommendations = app.activeAssessment.recommendations.filter(function (item) {
            return app.filters.fit === 'all' || item.fit === app.filters.fit;
        });
        const accepted = app.activeAssessment.recommendations.filter(function (item) {
            return item.review && item.review.decision === 'accepted';
        }).length;
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Service recommendations', `${h(app.activeCustomer.name)} · Explainable matches from catalogue ${h(app.activeAssessment.catalogueVersionId || '')}`, [
                `<button class="button button-primary" type="button" data-action="build-proposal" ${accepted ? '' : 'disabled'}>Build proposal (${accepted} accepted)</button>`
            ]),
            '<div class="toolbar">',
            '<label><span>Filter by fit</span><select data-filter="fit">',
            fitOption('all', 'All recommendations'),
            fitOption('strong_fit', 'Strong fit'),
            fitOption('potential_fit', 'Potential fit — validate'),
            fitOption('insufficient_information', 'Insufficient information'),
            fitOption('not_currently_suitable', 'Not currently suitable'),
            '</select></label>',
            `<span class="pill">${recommendations.length} shown</span>`,
            '</div>',
            '<div class="recommendation-list">',
            recommendations.map(renderRecommendation).join(''),
            '</div>',
            '</section>'
        ].join('');
    }

    function renderRecommendationList() {
        const assessments = app.bootstrap.assessments.filter(function (item) {
            return item.recommendationCount > 0;
        }).sort(sortUpdated);
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Recommendations', 'Review deterministic matches before anything becomes a proposal or CRM opportunity.', []),
            assessments.length ? '<div class="customer-grid">' + assessments.map(function (assessment) {
                const customer = customerById(assessment.customerId);
                return [
                    '<article class="assessment-card">',
                    `<div class="card-header"><div><p class="eyebrow">${h(customer ? customer.name : 'Customer')}</p><h2>${h(assessment.title)}</h2></div><span class="pill">${assessment.recommendationCount} matches</span></div>`,
                    `<p>${assessment.acceptedCount} recommendations accepted for proposal.</p>`,
                    `<button class="button button-primary" type="button" data-action="open-assessment" data-assessment-id="${h(assessment.id)}" data-target-view="recommendations">Review matches</button>`,
                    '</article>'
                ].join('');
            }).join('') + '</div>' : emptyState('No recommendations yet', 'Complete a discovery and run service matching.', '<button class="button button-primary" type="button" data-view="discovery">Open discovery</button>'),
            '</section>'
        ].join('');
    }

    function renderRecommendation(item) {
        const review = item.review || {};
        return [
            '<article class="recommendation-card">',
            '<div class="recommendation-main">',
            '<div class="card-header">',
            `<div><p class="eyebrow">${h(item.category)}</p><h2>${h(item.serviceName)}</h2></div>`,
            `<span class="fit-badge fit-${h(item.fit)}">${h(fitLabel(item.fit))}</span>`,
            '</div>',
            `<p><strong>Customer outcome:</strong> ${h(review.customerOutcome || item.customerOutcome)}</p>`,
            reasonGroup('Why it matched', item.reasons),
            reasonGroup('Confirm or gather', item.missingInformation),
            reasonGroup('Prerequisites or blockers', item.blockers),
            '</div>',
            '<form class="recommendation-review" data-form="recommendation" data-recommendation-id="' + h(item.id) + '">',
            '<p class="eyebrow">Consultant review</p>',
            `<label><span>Decision</span><select name="decision">${selectOptions([
                ['pending', 'Pending review'],
                ['accepted', 'Accept for proposal'],
                ['validate', 'Potential fit — validate'],
                ['rejected', 'Reject']
            ], review.decision)}</select></label>`,
            `<label><span>Roadmap</span><select name="roadmap">${selectOptions([
                ['now', 'Now'],
                ['next', 'Next'],
                ['later', 'Later']
            ], review.roadmap)}</select></label>`,
            `<label><span>Customer-facing outcome</span><textarea name="customerOutcome">${h(review.customerOutcome || item.customerOutcome)}</textarea></label>`,
            `<label><span>Consultant rationale</span><textarea name="consultantRationale" placeholder="Explain why this should or should not proceed.">${h(review.consultantRationale)}</textarea></label>`,
            '<div class="inline-fields">',
            `<label><span>Estimated MRR</span><input name="estimatedMrr" type="number" min="0" step="0.01" value="${h(review.estimatedMrr)}"></label>`,
            `<label><span>One-off revenue</span><input name="oneOffRevenue" type="number" min="0" step="0.01" value="${h(review.oneOffRevenue)}"></label>`,
            '</div>',
            `<label><span>Owner</span><input name="owner" value="${h(review.owner)}"></label>`,
            `<label><span>Next action</span><textarea name="nextAction">${h(review.nextAction)}</textarea></label>`,
            '<button class="button button-primary" type="submit">Save review</button>',
            '</form>',
            '</article>'
        ].join('');
    }

    function renderProposals() {
        if (app.activeProposal) {
            renderProposalEditor();
            return;
        }
        const proposals = app.bootstrap.proposals.slice().sort(sortUpdated);
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Proposals', 'Customer-facing drafts contain approved outcomes only. Revenue and internal qualification stay in the recommendation view.', []),
            proposals.length ? '<div class="proposal-grid">' + proposals.map(function (proposal) {
                const customer = customerById(proposal.customerId);
                return [
                    '<article class="proposal-card">',
                    `<div class="card-header"><div><p class="eyebrow">${h(customer ? customer.name : 'Customer')}</p><h2>${h(proposal.title)}</h2></div><span class="status-badge status-${h(proposal.status)}">${h(statusLabel(proposal.status))}</span></div>`,
                    `<p>${proposal.recommendationCount} recommended services · Dynamics ${h(statusLabel(proposal.dynamics && proposal.dynamics.status || 'not_sent'))}.</p>`,
                    `<div class="card-meta"><span>Updated ${h(formatDate(proposal.updatedAt))}</span></div>`,
                    `<button class="button button-primary" type="button" data-action="open-proposal" data-proposal-id="${h(proposal.id)}">Open proposal</button>`,
                    '</article>'
                ].join('');
            }).join('') + '</div>' : emptyState('No proposals yet', 'Accept one or more service recommendations and build a proposal.', '<button class="button button-primary" type="button" data-view="recommendations">Review recommendations</button>'),
            '</section>'
        ].join('');
    }

    function renderProposalEditor() {
        const proposal = app.activeProposal;
        const pricing = Object.assign({}, proposal.pricing || {});
        const commercial = proposal.commercial || {};
        const approvalChecks = proposal.approvalChecks || { blockingCount: 0, warnings: [] };
        const policyStatus = proposal.commercialPolicyStatus || {};
        const policyMigrationRequired = policyStatus.status === 'migration_required';
        const pricingReady = [
            'onboardingFrom',
            'perUserMonthly',
            'additionalEndpointMonthly',
            'additionalLocationMonthly'
        ].every(function (field) {
            return Number.isFinite(Number(pricing[field]));
        });
        const monthlyTotal = commercial.monthlyTotalExGst == null
            ? 'Enter exact quantities to calculate the monthly total.'
            : `NZ$${formatMoney(commercial.monthlyTotalExGst)} + GST per month`;
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Proposal', `${h(app.activeCustomer.name)} · Customer-facing proposal editor`, [
                button('Back', 'back-proposals'),
                button('Review & polish', 'review-proposal', 'button-primary'),
                button('Download Word', 'download-word'),
                button('Print / PDF', 'print-proposal'),
                button('Preview Dynamics', 'dynamics-preview')
            ]),
            proposal.status === 'approved' ? notice('Proposal approved', `Approved by ${proposal.approvedBy || 'an authorised consultant'} on ${formatDate(proposal.approvedAt)}. Any edits will return it to draft.`, 'notice-success', '') : notice('Draft proposal', 'Check every statement, service and commercial figure before approval.', '', ''),
            policyMigrationRequired
                ? notice('Commercial policy migration required', 'This draft keeps its recorded pricing unchanged. Create a new proposal under the current policy before approval.', 'notice-warning', '')
                : '',
            renderProposalReviewPanel(app.proposalReview),
            approvalChecks.blockingCount ? notice('Approval checks still open', `${approvalChecks.blockingCount} item${approvalChecks.blockingCount === 1 ? '' : 's'} must be resolved before approval. Review and save the draft to refresh these checks.`, 'notice-warning', '') : '',
            '<form class="proposal-editor" data-form="proposal">',
            '<section class="panel">',
            '<div class="form-grid">',
            `<label class="wide"><span>Proposal title</span><input name="title" data-proposal-field="title" value="${h(proposal.title)}"></label>`,
            `<label class="wide"><span>Executive summary</span><textarea name="executiveSummary" data-proposal-field="executiveSummary">${h(proposal.executiveSummary)}</textarea></label>`,
            `<label><span>Customer objectives — one per line</span><textarea name="objectives" data-proposal-field="objectives">${h((proposal.objectives || []).join('\n'))}</textarea></label>`,
            `<label><span>Agreed observations — one per line</span><textarea name="observations" data-proposal-field="observations">${h((proposal.observations || []).join('\n'))}</textarea></label>`,
            '</div>',
            '</section>',
            '<section class="panel">',
            panelHeader('Recommended outcomes and services', `<span class="pill">${proposal.recommendations.length}</span>`),
            proposal.recommendations.map(function (item, index) {
                return [
                    `<section class="proposal-recommendation" data-proposal-recommendation="${index}">`,
                    `<label><span>Service</span><input name="recommendation_${index}_serviceName" data-proposal-field="recommendation" value="${h(item.serviceName)}"></label>`,
                    `<label><span>Timing</span><select name="recommendation_${index}_roadmap" data-proposal-field="recommendation">${selectOptions([['now', 'Service start'], ['next', 'Planned next phase'], ['later', 'Future option']], item.roadmap)}</select></label>`,
                    `<label class="full"><span>Customer outcome</span><textarea name="recommendation_${index}_outcome" data-proposal-field="recommendation">${h(item.outcome)}</textarea></label>`,
                    `<label class="full"><span>Why this is relevant</span><textarea name="recommendation_${index}_why" data-proposal-field="recommendation">${h(item.why)}</textarea></label>`,
                    `<label class="full"><span>What must be confirmed</span><textarea name="recommendation_${index}_confirm" data-proposal-field="recommendation">${h(item.confirm)}</textarea></label>`,
                    `<input type="hidden" name="recommendation_${index}_id" value="${h(item.recommendationId)}">`,
                    `<input type="hidden" name="recommendation_${index}_serviceKey" value="${h(item.serviceKey)}">`,
                    '</section>'
                ].join('');
            }).join(''),
            '</section>',
            '<section class="panel">',
            panelHeader('Commercial summary', commercial.monthlyTotalExGst == null ? '<span class="status-badge status-draft">Needs quantities</span>' : '<span class="status-badge status-published">Calculated</span>'),
            `<p><strong>${h(monthlyTotal)}</strong></p>`,
            '<div class="form-grid">',
            `<label><span>Supported people</span><input name="commercial_userCount" type="number" min="1" step="1" data-proposal-field="commercial" value="${commercial.userCount == null ? '' : h(commercial.userCount)}" placeholder="Exact count"></label>`,
            `<label><span>Managed computers</span><input name="commercial_managedEndpointCount" type="number" min="0" step="1" data-proposal-field="commercial" value="${commercial.managedEndpointCount == null ? '' : h(commercial.managedEndpointCount)}" placeholder="Exact count"></label>`,
            `<label><span>Supported locations</span><input name="commercial_locationCount" type="number" min="0" step="1" data-proposal-field="commercial" value="${commercial.locationCount == null ? '' : h(commercial.locationCount)}" placeholder="Exact count"></label>`,
            `<label><span>Set-up fee, excluding GST</span><input name="commercial_onboardingFeeExGst" type="number" min="0" step="0.01" data-proposal-field="commercial" value="${h(commercial.onboardingFeeExGst == null ? (pricingReady ? pricing.onboardingFrom : '') : commercial.onboardingFeeExGst)}"></label>`,
            `<label><span>Proposed term, months</span><input name="commercial_termMonths" type="number" min="1" step="1" data-proposal-field="commercial" value="${commercial.termMonths == null ? '' : h(commercial.termMonths)}" placeholder="Confirm with customer"></label>`,
            `<label><span>Planned start</span><input name="commercial_plannedStart" type="date" data-proposal-field="commercial" value="${h(commercial.plannedStart || '')}"></label>`,
            `<label class="wide choice"><input name="commercial_confirmed" type="checkbox" data-proposal-field="commercial" ${commercial.confirmed ? 'checked' : ''}><span>Quantities and commercial figures have been checked</span></label>`,
            '</div>',
            pricingReady
                ? `<p class="meta">Rate basis: NZ$${h(pricing.perUserMonthly)} per user each month, one main computer included per user, NZ$${h(pricing.additionalEndpointMonthly)} per extra computer and NZ$${h(pricing.additionalLocationMonthly)} per extra location. All figures exclude GST. Policy ${h(pricing.policyId || 'not loaded')}.</p>`
                : '<p class="meta">This proposal does not contain a complete recorded pricing basis.</p>',
            '</section>',
            '<section class="panel">',
            '<div class="form-grid">',
            `<label><span>Assumptions — one per line</span><textarea name="assumptions" data-proposal-field="assumptions">${h((proposal.assumptions || []).join('\n'))}</textarea></label>`,
            `<label><span>Proposed next step</span><textarea name="nextStep" data-proposal-field="nextStep">${h(proposal.nextStep)}</textarea></label>`,
            '</div>',
            '</section>',
            '<div class="discovery-footer">',
            `<span class="meta">${app.dirty ? 'Unsaved proposal changes' : `Workspace revision ${app.revision}`}</span>`,
            '<div class="button-row">',
            '<button class="button" type="submit" name="proposalStatus" value="draft">Save draft</button>',
            `<button class="button button-primary" type="submit" name="proposalStatus" value="approved" ${policyMigrationRequired ? 'disabled' : ''}>Approve proposal</button>`,
            `<button class="button button-accent" type="button" data-action="dynamics-send" ${proposal.status === 'approved' ? '' : 'disabled'}>Send approved handoff</button>`,
            '</div>',
            '</div>',
            '</form>',
            '</section>'
        ].join('');
    }

    function renderProposalReviewPanel(review) {
        if (!review) {
            return notice('Proposal quality review', 'Turn discovery notes into customer-ready wording and identify contradictions or missing commercial information.', '', button('Review & polish', 'review-proposal', 'button-primary'));
        }
        const warnings = review.warnings || [];
        const changed = review.changedSections || [];
        return [
            '<section class="panel">',
            panelHeader('Proposal review', `<span class="status-badge ${review.blockingCount ? 'status-draft' : 'status-published'}">${h(review.runtime && review.runtime.label || 'Review complete')}</span>`),
            `<p>${h(review.qualitySummary)}</p>`,
            changed.length ? `<p class="meta">Suggested updates: ${h(changed.join(', '))}.</p>` : '<p class="meta">No wording changes were needed.</p>',
            warnings.length ? `<ul class="validation-list">${warnings.map(function (warning) { return `<li><strong>${warning.blocking ? 'Resolve before approval' : 'Review'} · ${h(warning.section)}</strong><br>${h(warning.message)}</li>`; }).join('')}</ul>` : notice('Checks passed', 'No proposal-quality warnings were found.', 'notice-success', ''),
            '<div class="button-row">',
            review.applied ? '<span class="status-badge status-published">Suggested wording applied — save the draft</span>' : button('Apply suggested wording', 'apply-proposal-review', 'button-primary'),
            button('Dismiss review', 'dismiss-proposal-review'),
            '</div>',
            '</section>'
        ].join('');
    }

    function renderCatalogue() {
        if (!app.catalogue) {
            elements.viewRoot.innerHTML = '<section class="page">' + pageHeading('Service catalogue', 'Loading private tenant services…', []) + '</section>';
            return;
        }
        const catalogue = app.catalogue;
        const canWrite = can('catalogue:write');
        const published = catalogue.published;
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Service catalogue', 'Upload private service definitions, validate their matching signals, and explicitly approve a version.', [
                canWrite ? button('Download CSV template', 'download-template') : ''
            ]),
            notice('Tenant-private source data', 'Service catalogue content is stored server-side and is not included in the public site or static application shell. Use public or specifically approved source material only.', '', ''),
            canWrite ? [
                '<section class="catalogue-upload">',
                '<div><p class="eyebrow">Import and validate</p><h2>Upload service catalogue CSV</h2><p>Use <code>||</code> between list items and <code>;;</code> between signal rules. A rule looks like <code>security.monitoring=absent|business_hours</code>.</p></div>',
                '<form data-form="catalogue-import">',
                '<div class="form-grid">',
                '<label><span>Catalogue label</span><input name="label" placeholder="Kordia approved services — pilot v1"></label>',
                '<label><span>CSV file</span><input id="catalogueFile" type="file" accept=".csv,text/csv" required></label>',
                '<p class="wide meta" id="catalogueFileName">No file selected.</p>',
                '<div class="wide button-row"><button class="button button-primary" type="submit">Validate and stage draft</button></div>',
                '</div>',
                '</form>',
                '</section>'
            ].join('') : '',
            app.catalogueDraft ? renderCatalogueDraft(app.catalogueDraft) : '',
            '<section class="panel">',
            panelHeader('Catalogue versions', `<span class="pill">${catalogue.versions.length}</span>`),
            catalogue.versions.length ? '<div class="table-wrap"><table><thead><tr><th>Version</th><th>Status</th><th>Services</th><th>Imported</th><th>Action</th></tr></thead><tbody>' + catalogue.versions.slice().reverse().map(function (version) {
                return `<tr><td><strong>${h(version.label)}</strong><br><span class="meta">v${version.versionNumber}</span></td><td><span class="status-badge status-${h(version.status)}">${h(statusLabel(version.status))}</span></td><td>${version.serviceCount}</td><td>${h(formatDate(version.importedAt))}<br><span class="meta">${h(version.importedBy)}</span></td><td>${version.status === 'draft' && can('catalogue:publish') ? `<button class="button button-small" type="button" data-action="publish-catalogue" data-version-id="${h(version.id)}">Publish</button>` : ''}</td></tr>`;
            }).join('') + '</tbody></table></div>' : '<p>No catalogue versions uploaded.</p>',
            '</section>',
            '<section class="panel">',
            panelHeader('Published services', published ? `<span class="status-badge status-published">${published.services.length} active</span>` : '<span class="status-badge status-draft">None</span>'),
            published ? '<div class="catalogue-grid">' + published.services.map(function (service) {
                return [
                    '<article class="catalogue-card">',
                    `<div class="card-header"><div><p class="eyebrow">${h(service.category)}</p><h2>${h(service.name)}</h2></div>${classificationBadge(service.classification)}</div>`,
                    `<p>${h(service.customerOutcome)}</p>`,
                    `<div class="card-meta"><span>${service.rules.strong.length} strong signals</span><span>${service.rules.potential.length} potential signals</span><span>${service.rules.prerequisites.length} prerequisites</span></div>`,
                    '</article>'
                ].join('');
            }).join('') + '</div>' : emptyState('No services published', 'Matching remains unavailable until an administrator approves a catalogue version.', ''),
            '</section>',
            '</section>'
        ].join('');
    }

    function renderCatalogueDraft(version) {
        const warnings = version.warnings || [];
        return [
            '<section class="panel">',
            panelHeader(`Draft staged: ${version.label}`, `<span class="status-badge status-draft">${version.services.length} services</span>`),
            warnings.length ? `<div class="notice notice-warning"><strong>Validation warnings</strong><ul class="validation-list">${warnings.map(function (warning) { return `<li>Row ${warning.row}: ${h(warning.message)}</li>`; }).join('')}</ul></div>` : notice('Validation passed', 'All required fields, question IDs, and signal values are valid.', 'notice-success', ''),
            '<div class="table-wrap"><table><thead><tr><th>Service</th><th>Category</th><th>Classification</th><th>Signals</th></tr></thead><tbody>',
            version.services.map(function (service) {
                return `<tr><td><strong>${h(service.name)}</strong><br><span class="meta mono">${h(service.key)}</span></td><td>${h(service.category)}</td><td>${classificationBadge(service.classification)}</td><td>${service.rules.strong.length} strong · ${service.rules.potential.length} potential · ${service.rules.prerequisites.length} prerequisites · ${service.rules.disqualifiers.length} disqualifiers</td></tr>`;
            }).join(''),
            '</tbody></table></div>',
            can('catalogue:publish') ? `<button class="button button-primary" type="button" data-action="publish-catalogue" data-version-id="${h(version.id)}">Approve and publish this version</button>` : '',
            '</section>'
        ].join('');
    }

    function renderAdmin() {
        const integration = app.bootstrap.integration;
        elements.viewRoot.innerHTML = [
            '<section class="page">',
            pageHeading('Administration', 'Tenant access, auditability, data boundaries, and the controlled CRM bridge.', []),
            '<div class="two-column">',
            '<section class="panel">',
            panelHeader('Your access', `<span class="role-badge">${h(roleLabel(app.bootstrap.user.role))}</span>`),
            '<dl class="detail-grid">',
            detailItem('Microsoft identity', app.bootstrap.user.email),
            detailItem('Tenant', app.bootstrap.tenant.name),
            detailItem('Tenant key', `<span class="mono">${h(app.bootstrap.tenant.key)}</span>`, true),
            detailItem('Role', roleLabel(app.bootstrap.user.role)),
            '</dl>',
            '<p><strong>Capabilities:</strong></p>',
            `<ul class="bullet-list">${app.bootstrap.user.capabilities.map(function (capability) { return `<li>${h(capability)}</li>`; }).join('')}</ul>`,
            '</section>',
            '<section class="panel">',
            panelHeader('Dynamics 365 / Dataverse', `<span class="status-badge ${integration.configured ? 'status-published' : 'status-draft'}">${integration.configured ? 'Configured' : 'Not configured'}</span>`),
            '<dl class="detail-grid">',
            detailItem('Mode', integration.mode),
            detailItem('Authentication', statusLabel(integration.authentication)),
            detailItem('Endpoint', integration.endpointConfigured ? 'Configured server-side' : 'Not configured'),
            detailItem('Production writes', integration.productionWriteEnabled ? 'Enabled' : 'Disabled'),
            '</dl>',
            '<p>Only an approved proposal can be handed off. The endpoint and credentials never reach browser JavaScript.</p>',
            '</section>',
            '</div>',
            '<section class="panel">',
            panelHeader('Security and data rules', ''),
            '<div class="two-column">',
            notice('Use approved information only', 'Do not upload Kordia IP or real customer information until written approval covers external hosting, data classification, and acceptable use.', 'notice-warning', ''),
            notice('Never upload secrets', 'Do not enter credentials, API keys, passwords, private keys, or raw security configurations.', 'notice-danger', ''),
            notice('No automatic external action', 'Recommendations, proposals, exports, and CRM handoffs always require consultant review.', '', ''),
            notice('Deletion is controlled', 'Tenant administrators can delete a customer and all associated assessment, proposal, and handoff records.', '', ''),
            '</div>',
            '</section>',
            can('audit:read') ? [
                '<section class="panel">',
                panelHeader('Audit trail', `<span class="pill">${app.audit ? app.audit.events.length : 0} recent events</span>`),
                app.audit && app.audit.events.length ? '<div class="audit-list">' + app.audit.events.map(function (event) {
                    return `<article class="audit-event"><div><strong>${h(event.action)}</strong><p class="meta">${h(formatDateTime(event.at))}</p></div><div><p>${h(event.summary || event.targetType || 'Workspace action')}</p><p class="meta">${h(event.actorEmail)} · ${h(event.actorRole)} · ${h(event.targetId || '')}</p></div></article>`;
                }).join('') + '</div>' : '<p>No audit events recorded yet.</p>',
                '</section>'
            ].join('') : '',
            '</section>'
        ].join('');
    }

    function renderQuestion(question, number) {
        const answer = app.activeAssessment.answers[question.id] || emptyAnswer();
        let control = '';
        if (question.type === 'text') {
            control = `<textarea data-answer-field="value" data-question-id="${h(question.id)}" placeholder="Capture the customer’s words, not an inferred answer.">${h(answer.value)}</textarea>`;
        } else {
            const inputType = question.type === 'multi' ? 'checkbox' : 'radio';
            const selected = Array.isArray(answer.value) ? answer.value : [answer.value];
            control = '<div class="choice-grid">' + question.options.map(function (option) {
                return `<label class="choice"><input type="${inputType}" name="${h(question.id)}" value="${h(option.value)}" data-answer-field="value" data-question-id="${h(question.id)}" ${selected.includes(option.value) ? 'checked' : ''}><span>${h(option.label)}</span></label>`;
            }).join('') + '</div>';
        }
        return [
            '<article class="question-card">',
            `<div><span class="question-number">Question ${number}</span><h2>${h(question.prompt)}</h2></div>`,
            control,
            '<details>',
            '<summary>Notes, evidence, importance, and confidence</summary>',
            '<div class="answer-detail">',
            `<label class="wide"><span>Customer notes</span><textarea data-answer-field="notes" data-question-id="${h(question.id)}">${h(answer.notes)}</textarea></label>`,
            `<label><span>Importance to customer</span><select data-answer-field="importance" data-question-id="${h(question.id)}">${selectOptions([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], answer.importance)}</select></label>`,
            `<label><span>Consultant confidence</span><select data-answer-field="confidence" data-question-id="${h(question.id)}">${selectOptions([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], answer.confidence)}</select></label>`,
            `<label><span>Supporting evidence</span><input data-answer-field="evidence" data-question-id="${h(question.id)}" value="${h(answer.evidence)}" placeholder="Document, owner, or source"></label>`,
            `<label class="wide"><span>Internal-only notes</span><textarea data-answer-field="internalNotes" data-question-id="${h(question.id)}">${h(answer.internalNotes)}</textarea></label>`,
            '</div>',
            '</details>',
            '</article>'
        ].join('');
    }

    function showCustomerDialog(customer) {
        const editing = Boolean(customer);
        openDialog(editing ? 'Customer record' : 'New customer', editing ? 'Edit customer' : 'Create customer', [
            `<form data-form="customer" data-customer-id="${editing ? h(customer.id) : ''}">`,
            '<div class="form-grid">',
            `<label class="wide"><span>Customer name</span><input name="name" required maxlength="180" value="${editing ? h(customer.name) : ''}" placeholder="Fictional Customer Ltd"></label>`,
            `<label><span>Industry</span><input name="industry" value="${editing ? h(customer.industry) : ''}"></label>`,
            `<label><span>Region</span><input name="region" value="${editing ? h(customer.region) : ''}"></label>`,
            `<label><span>Segment</span><input name="segment" value="${editing ? h(customer.segment) : ''}"></label>`,
            `<label><span>Account owner</span><input name="accountOwner" value="${editing ? h(customer.accountOwner) : ''}"></label>`,
            `<label><span>Dynamics Account ID</span><input name="dynamicsAccountId" value="${editing ? h(customer.dynamicsAccountId) : ''}" placeholder="Leave blank until matched"></label>`,
            `<label><span>Classification</span><select name="classification">${selectOptions([['internal', 'Internal'], ['restricted', 'Restricted'], ['public', 'Public']], editing ? customer.classification : 'internal')}</select></label>`,
            `<label class="wide"><span>Account notes</span><textarea name="notes">${editing ? h(customer.notes) : ''}</textarea></label>`,
            '<div class="wide button-row"><button class="button button-primary" type="submit">' + (editing ? 'Save customer' : 'Create customer') + '</button><button class="button" type="button" data-action="close-dialog">Cancel</button></div>',
            '</div>',
            '</form>'
        ].join(''));
    }

    function showDeleteCustomerDialog(customer) {
        if (!customer) {
            return;
        }
        openDialog('Retention control', 'Delete customer data', [
            `<div class="notice notice-danger"><strong>This cannot be undone in the application.</strong><p>It deletes the customer, assessments, proposals, and Dynamics handoff history. The source repository and Azure backups may retain recoverable versions according to the operator’s retention policy.</p></div>`,
            `<form data-form="delete-customer" data-customer-id="${h(customer.id)}">`,
            `<label><span>Type “${h(customer.name)}” to confirm</span><input name="confirmName" required autocomplete="off"></label>`,
            '<div class="button-row"><button class="button button-danger" type="submit">Delete customer and related records</button><button class="button" type="button" data-action="close-dialog">Cancel</button></div>',
            '</form>'
        ].join(''));
    }

    function showAssessmentDialog(customerId) {
        if (!app.bootstrap.customers.length) {
            showToast('Create a customer before starting discovery.', true);
            showCustomerDialog();
            return;
        }
        openDialog('Guided discovery', 'Start a 30-minute assessment', [
            '<form data-form="assessment">',
            '<div class="form-grid">',
            `<label class="wide"><span>Customer</span><select name="customerId" required>${app.bootstrap.customers.map(function (customer) {
                return `<option value="${h(customer.id)}" ${customer.id === customerId ? 'selected' : ''}>${h(customer.name)}</option>`;
            }).join('')}</select></label>`,
            '<label class="wide"><span>Assessment title</span><input name="title" value="30-minute customer discovery" maxlength="180"></label>',
            '<div class="wide notice notice-warning"><strong>Use approved information only.</strong><p>For an internal pilot, use fictional or specifically approved customer data.</p></div>',
            '<div class="wide button-row"><button class="button button-primary" type="submit">Start discovery</button><button class="button" type="button" data-action="close-dialog">Cancel</button></div>',
            '</div>',
            '</form>'
        ].join(''));
    }

    async function submitCustomer(form) {
        setBusy(true, 'Saving customer…');
        const values = formValues(form);
        const id = form.dataset.customerId;
        const result = await api(id ? `/api/sales/customers/${encodeURIComponent(id)}` : '/api/sales/customers', {
            method: id ? 'PATCH' : 'POST',
            body: withRevision(values)
        });
        updateRevision(result);
        closeDialog();
        await refreshBootstrap(false);
        showToast(id ? 'Customer updated.' : 'Customer created.');
        if (id) {
            await openCustomer(id);
        } else {
            await openCustomer(result.customer.id);
        }
    }

    async function deleteCustomer(form) {
        setBusy(true, 'Deleting customer…');
        const id = form.dataset.customerId;
        const result = await api(`/api/sales/customers/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            body: withRevision({ confirmName: form.elements.confirmName.value })
        });
        updateRevision(result);
        closeDialog();
        app.customerDetail = null;
        await refreshBootstrap(false);
        render();
        showToast('Customer and related records deleted.');
    }

    async function createAssessment(form) {
        setBusy(true, 'Starting discovery…');
        const values = formValues(form);
        const result = await api('/api/sales/assessments', {
            method: 'POST',
            body: withRevision(values)
        });
        updateRevision(result);
        closeDialog();
        await refreshBootstrap(false);
        await openAssessment(result.assessment.id, 'discovery');
        showToast('Discovery started.');
    }

    async function openCustomer(id) {
        setBusy(true, 'Loading customer…');
        app.customerDetail = await api(`/api/sales/customers/${encodeURIComponent(id)}`);
        updateRevision(app.customerDetail);
        app.view = 'customers';
        setBusy(false);
        render();
    }

    async function openAssessment(id, targetView) {
        setBusy(true, 'Loading discovery…');
        const results = await Promise.all([
            api(`/api/sales/assessments/${encodeURIComponent(id)}`),
            app.blueprint ? Promise.resolve(app.blueprint) : api('/api/sales/blueprint')
        ]);
        updateRevision(results[0]);
        app.activeAssessment = results[0].assessment;
        app.activeCustomer = results[0].customer;
        app.blueprint = results[1];
        app.discoverySection = 0;
        app.view = targetView || 'discovery';
        setDirty(false);
        setBusy(false);
        render();
    }

    async function saveDiscovery(status) {
        if (!app.activeAssessment) {
            return;
        }
        setBusy(true, status === 'completed' ? 'Completing discovery…' : 'Saving discovery…');
        const result = await api(`/api/sales/assessments/${encodeURIComponent(app.activeAssessment.id)}/answers`, {
            method: 'PUT',
            body: withRevision({
                answers: app.activeAssessment.answers,
                status
            })
        });
        updateRevision(result);
        app.activeAssessment = result.assessment;
        setDirty(false);
        await refreshBootstrap(false);
        setBusy(false);
        render();
        showToast(status === 'completed' ? 'Discovery completed.' : 'Discovery saved.');
    }

    async function completeDiscovery() {
        await saveDiscovery('completed');
        if (!app.bootstrap.catalogue.publishedVersionId) {
            showToast('Discovery saved. Publish a catalogue before matching services.', true);
            return;
        }
        setBusy(true, 'Matching services…');
        const result = await api(`/api/sales/assessments/${encodeURIComponent(app.activeAssessment.id)}/match`, {
            method: 'POST',
            body: withRevision({})
        });
        updateRevision(result);
        app.activeAssessment = result.assessment;
        await refreshBootstrap(false);
        app.view = 'recommendations';
        setBusy(false);
        render();
        showToast(`${result.assessment.recommendations.length} explainable service matches generated.`);
    }

    async function saveRecommendation(form) {
        setBusy(true, 'Saving review…');
        const values = formValues(form);
        const result = await api(`/api/sales/assessments/${encodeURIComponent(app.activeAssessment.id)}/recommendations/${encodeURIComponent(form.dataset.recommendationId)}`, {
            method: 'POST',
            body: withRevision(values)
        });
        updateRevision(result);
        const index = app.activeAssessment.recommendations.findIndex(function (item) {
            return item.id === result.recommendation.id;
        });
        if (index >= 0) {
            app.activeAssessment.recommendations[index] = result.recommendation;
        }
        await refreshBootstrap(false);
        setBusy(false);
        render();
        showToast('Recommendation review saved.');
    }

    async function buildProposal() {
        setBusy(true, 'Building proposal…');
        const result = await api(`/api/sales/assessments/${encodeURIComponent(app.activeAssessment.id)}/proposal`, {
            method: 'POST',
            body: withRevision({})
        });
        updateRevision(result);
        await refreshBootstrap(false);
        app.activeProposal = result.proposal;
        app.proposalReview = null;
        app.view = 'proposals';
        setBusy(false);
        render();
        showToast('Customer-facing proposal draft created.');
    }

    async function openProposal(id) {
        setBusy(true, 'Loading proposal…');
        const result = await api(`/api/sales/proposals/${encodeURIComponent(id)}`);
        updateRevision(result);
        app.activeProposal = result.proposal;
        app.activeCustomer = result.customer;
        app.proposalReview = null;
        app.view = 'proposals';
        setDirty(false);
        setBusy(false);
        render();
    }

    async function reviewProposal() {
        if (!app.activeProposal) return;
        const form = elements.viewRoot.querySelector('[data-form="proposal"]');
        if (app.dirty && form) await saveProposal(form, 'draft', { silent: true });
        setBusy(true, 'Reviewing and polishing proposal…');
        const result = await api(`/api/sales/proposals/${encodeURIComponent(app.activeProposal.id)}/review`, {
            method: 'POST',
            body: withRevision({})
        });
        updateRevision(result);
        app.proposalReview = result.review;
        setBusy(false);
        render();
        showToast(result.review.blockingCount ? `Proposal review found ${result.review.blockingCount} approval blocker${result.review.blockingCount === 1 ? '' : 's'}.` : 'Proposal review complete.');
    }

    function applyProposalReview() {
        if (!app.activeProposal || !app.proposalReview || !app.proposalReview.suggestedProposal) return;
        if (app.proposalReview.stale) {
            showToast('The draft changed after this review. Run Review & polish again.', true);
            return;
        }
        const current = app.activeProposal;
        const suggestion = app.proposalReview.suggestedProposal;
        const suggestedById = new Map((suggestion.recommendations || []).map(function (item) { return [item.recommendationId, item]; }));
        app.activeProposal = Object.assign({}, current, {
            title: suggestion.title,
            executiveSummary: suggestion.executiveSummary,
            objectives: suggestion.objectives,
            observations: suggestion.observations,
            assumptions: suggestion.assumptions,
            nextStep: suggestion.nextStep,
            recommendations: current.recommendations.map(function (item) {
                const proposed = suggestedById.get(item.recommendationId);
                return proposed ? Object.assign({}, item, {
                    serviceName: proposed.serviceName,
                    outcome: proposed.outcome,
                    why: proposed.why,
                    confirm: proposed.confirm
                }) : item;
            }),
            pricing: current.pricing,
            commercial: current.commercial,
            status: 'draft'
        });
        app.proposalReview = Object.assign({}, app.proposalReview, { applied: true });
        setDirty(true);
        render();
        showToast('Suggested wording applied. Review it, then save the draft.');
    }

    async function saveProposal(form, status, options) {
        const saveOptions = options || {};
        setBusy(true, status === 'approved' ? 'Approving proposal…' : 'Saving proposal…');
        const values = formValues(form);
        const recommendations = app.activeProposal.recommendations.map(function (item, index) {
            return {
                recommendationId: values[`recommendation_${index}_id`],
                serviceKey: values[`recommendation_${index}_serviceKey`],
                serviceName: values[`recommendation_${index}_serviceName`],
                roadmap: values[`recommendation_${index}_roadmap`],
                outcome: values[`recommendation_${index}_outcome`],
                why: values[`recommendation_${index}_why`],
                confirm: values[`recommendation_${index}_confirm`]
            };
        });
        const result = await api(`/api/sales/proposals/${encodeURIComponent(app.activeProposal.id)}`, {
            method: 'PUT',
            body: withRevision({
                title: values.title,
                executiveSummary: values.executiveSummary,
                objectives: lines(values.objectives),
                observations: lines(values.observations),
                assumptions: lines(values.assumptions),
                nextStep: values.nextStep,
                commercial: {
                    userCount: values.commercial_userCount,
                    managedEndpointCount: values.commercial_managedEndpointCount,
                    locationCount: values.commercial_locationCount,
                    onboardingFeeExGst: values.commercial_onboardingFeeExGst,
                    termMonths: values.commercial_termMonths,
                    plannedStart: values.commercial_plannedStart,
                    confirmed: Boolean(form.elements.commercial_confirmed && form.elements.commercial_confirmed.checked)
                },
                recommendations,
                status: status === 'approved' ? 'approved' : 'draft'
            })
        });
        updateRevision(result);
        app.activeProposal = result.proposal;
        if (!saveOptions.keepReview) app.proposalReview = null;
        setDirty(false);
        await refreshBootstrap(false);
        setBusy(false);
        render();
        if (!saveOptions.silent) showToast(status === 'approved' ? 'Proposal approved.' : 'Proposal draft saved.');
        return result;
    }

    function downloadProposal(format) {
        if (!app.activeProposal) {
            return;
        }
        const url = `/api/sales/proposals/${encodeURIComponent(app.activeProposal.id)}/export?format=${encodeURIComponent(format)}`;
        if (format === 'html') {
            window.open(url, '_blank', 'noopener');
            return;
        }
        window.location.assign(url);
    }

    async function previewDynamics() {
        if (!app.activeProposal) {
            return;
        }
        setBusy(true, 'Building Dynamics payload…');
        const result = await api('/api/sales/integrations/dynamics/preview', {
            method: 'POST',
            body: { proposalId: app.activeProposal.id }
        });
        setBusy(false);
        openDialog('Controlled handoff', 'Dynamics payload preview', [
            `<div class="notice ${result.configured ? 'notice-success' : 'notice-warning'}"><strong>${result.configured ? 'Bridge configured' : 'Bridge not configured'}</strong><p>This preview does not write to Dynamics.</p></div>`,
            `<pre class="json-preview">${h(JSON.stringify(result.payload, null, 2))}</pre>`,
            '<div class="button-row"><button class="button" type="button" data-action="close-dialog">Close</button></div>'
        ].join(''));
    }

    async function sendDynamics() {
        if (!app.activeProposal || app.activeProposal.status !== 'approved') {
            showToast('Approve the proposal before CRM handoff.', true);
            return;
        }
        if (!window.confirm('Send the approved opportunities and next task to the configured Dynamics bridge?')) {
            return;
        }
        setBusy(true, 'Sending approved handoff…');
        const result = await api('/api/sales/integrations/dynamics/handoff', {
            method: 'POST',
            body: withRevision({
                proposalId: app.activeProposal.id,
                confirmed: true
            })
        });
        updateRevision(result);
        await refreshBootstrap(false);
        await openProposal(app.activeProposal.id);
        showToast('Approved handoff sent to Dynamics.');
    }

    async function loadCatalogue() {
        setBusy(true, 'Loading catalogue…');
        app.catalogue = await api('/api/sales/catalogue');
        updateRevision(app.catalogue);
        setBusy(false);
    }

    async function importCatalogue(form) {
        if (!app.catalogueCsv) {
            throw new Error('Choose a CSV file before importing.');
        }
        setBusy(true, 'Validating catalogue…');
        try {
            const result = await api('/api/sales/catalogue/import', {
                method: 'POST',
                body: withRevision({
                    label: form.elements.label.value,
                    csv: app.catalogueCsv
                })
            });
            updateRevision(result);
            app.catalogueDraft = result.version;
            app.catalogueCsv = '';
            await loadCatalogue();
            render();
            showToast('Catalogue validated and staged as a draft.');
        } catch (error) {
            if (error.data && error.data.errors) {
                openDialog('Catalogue validation', 'CSV needs attention', `<ul class="validation-list">${error.data.errors.map(function (item) {
                    return `<li>Row ${item.row}, ${h(item.field)}: ${h(item.message)}</li>`;
                }).join('')}</ul><div class="button-row"><button class="button" type="button" data-action="close-dialog">Close</button></div>`);
            }
            throw error;
        } finally {
            setBusy(false);
        }
    }

    async function publishCatalogue(versionId) {
        if (!window.confirm('Publish this version to the live matching engine for this tenant?')) {
            return;
        }
        setBusy(true, 'Publishing catalogue…');
        const result = await api('/api/sales/catalogue/publish', {
            method: 'POST',
            body: withRevision({ versionId })
        });
        updateRevision(result);
        app.catalogueDraft = null;
        await refreshBootstrap(false);
        await loadCatalogue();
        render();
        showToast('Service catalogue published.');
    }

    async function loadAudit() {
        setBusy(true, 'Loading audit trail…');
        app.audit = await api('/api/sales/audit');
        updateRevision(app.audit);
        setBusy(false);
    }

    function captureAnswerInput(field) {
        const questionId = field.dataset.questionId;
        const answerField = field.dataset.answerField;
        const answer = app.activeAssessment.answers[questionId] || emptyAnswer();
        if (answerField === 'value' && field.type === 'checkbox') {
            answer.value = Array.from(document.querySelectorAll(`[data-question-id="${cssEscape(questionId)}"][data-answer-field="value"]:checked`)).map(function (item) {
                return item.value;
            });
        } else if (answerField === 'value' && field.type === 'radio') {
            if (field.checked) {
                answer.value = field.value;
            }
        } else {
            answer[answerField] = field.value;
        }
        app.activeAssessment.answers[questionId] = answer;
    }

    function getVisibleQuestions() {
        const answers = app.activeAssessment.answers || {};
        return app.blueprint.questions.filter(function (question) {
            if (!question.showWhen) {
                return true;
            }
            const dependency = answers[question.showWhen.questionId];
            const value = dependency && dependency.value;
            const values = Array.isArray(value) ? value : [value];
            const matched = values.some(function (candidate) {
                return question.showWhen.values.includes(candidate);
            });
            return question.showWhen.operator === 'not_in' ? !matched : matched;
        });
    }

    async function refreshBootstrap(shouldRender) {
        const bootstrap = await api('/api/sales/bootstrap');
        app.bootstrap = bootstrap;
        app.revision = bootstrap.revision;
        renderIdentity();
        if (shouldRender !== false) {
            render();
        }
    }

    async function api(url, options) {
        const requestOptions = options || {};
        const fetchOptions = {
            method: requestOptions.method || 'GET',
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json'
            }
        };
        if (requestOptions.body !== undefined) {
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(requestOptions.body);
        }
        const response = await fetch(url, fetchOptions);
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json().catch(function () { return {}; })
            : await response.text();
        if (!response.ok) {
            const error = new Error(data && data.error || `Request failed (${response.status}).`);
            error.status = response.status;
            error.data = data;
            if (response.status === 409 && data && data.code === 'revision_conflict') {
                error.message = 'Someone else changed this workspace. Reload before trying again.';
            }
            throw error;
        }
        return data;
    }

    function withRevision(body) {
        return Object.assign({}, body || {}, { expectedRevision: app.revision });
    }

    function updateRevision(result) {
        if (result && Number.isInteger(result.revision)) {
            app.revision = result.revision;
        }
    }

    function setBusy(busy, message) {
        app.busy = busy;
        elements.saveIndicator.textContent = busy ? (message || 'Working…') : (app.dirty ? 'Unsaved changes' : `Revision ${app.revision}`);
        document.body.classList.toggle('is-busy', busy);
    }

    function setDirty(dirty) {
        app.dirty = dirty;
        elements.saveIndicator.textContent = dirty ? 'Unsaved changes' : `Revision ${app.revision}`;
    }

    function showError(error) {
        setBusy(false);
        if (error && error.data && error.data.code === 'revision_conflict') {
            showToast('This workspace changed elsewhere. Reload and review before saving.', true);
            return;
        }
        showToast(error && error.message || 'No Fries could not complete that action.', true);
    }

    function showToast(message, isError) {
        const toast = document.createElement('div');
        toast.className = `toast${isError ? ' toast-error' : ''}`;
        toast.textContent = message;
        elements.toastRegion.appendChild(toast);
        window.setTimeout(function () {
            toast.remove();
        }, 6000);
    }

    function openDialog(eyebrow, title, body) {
        elements.dialogEyebrow.textContent = eyebrow;
        elements.dialogTitle.textContent = title;
        elements.dialogBody.innerHTML = body;
        if (typeof elements.dialog.showModal === 'function') {
            elements.dialog.showModal();
        } else {
            elements.dialog.setAttribute('open', '');
        }
    }

    function closeDialog() {
        if (elements.dialog.open && typeof elements.dialog.close === 'function') {
            elements.dialog.close();
        } else {
            elements.dialog.removeAttribute('open');
        }
    }

    function pageHeading(title, description, actions) {
        return [
            '<header class="page-heading">',
            `<div><p class="eyebrow">${h(app.bootstrap.tenant.name)}</p><h1>${h(title)}</h1><p>${h(description)}</p></div>`,
            `<div class="page-actions">${(actions || []).filter(Boolean).join('')}</div>`,
            '</header>'
        ].join('');
    }

    function panelHeader(title, action) {
        return `<div class="panel-header"><h2>${h(title)}</h2>${action || ''}</div>`;
    }

    function metric(value, label) {
        return `<article class="metric-card"><strong>${h(value)}</strong><span>${h(label)}</span></article>`;
    }

    function notice(title, text, className, action) {
        return `<section class="notice ${className || ''}"><strong>${h(title)}</strong><p>${h(text)}</p>${action || ''}</section>`;
    }

    function button(label, action, className, extra) {
        return `<button class="button ${className || ''}" type="button" ${action ? `data-action="${h(action)}"` : ''} ${extra || ''}>${h(label)}</button>`;
    }

    function quickLink(title, text, action, extra) {
        return `<button class="button" type="button" ${action ? `data-action="${h(action)}"` : ''} ${extra || ''}><span><strong>${h(title)}</strong><br><small>${h(text)}</small></span></button>`;
    }

    function recentWork(assessments, proposals) {
        const items = assessments.map(function (assessment) {
            const customer = customerById(assessment.customerId);
            return {
                title: assessment.title,
                detail: `${customer ? customer.name : 'Customer'} · ${statusLabel(assessment.status)}`,
                updatedAt: assessment.updatedAt,
                action: `<button class="button button-small" type="button" data-action="open-assessment" data-assessment-id="${h(assessment.id)}" data-target-view="${assessment.recommendationCount ? 'recommendations' : 'discovery'}">Open</button>`
            };
        }).concat(proposals.map(function (proposal) {
            const customer = customerById(proposal.customerId);
            return {
                title: proposal.title,
                detail: `${customer ? customer.name : 'Customer'} · Proposal ${statusLabel(proposal.status)}`,
                updatedAt: proposal.updatedAt,
                action: `<button class="button button-small" type="button" data-action="open-proposal" data-proposal-id="${h(proposal.id)}">Open</button>`
            };
        })).sort(sortUpdated).slice(0, 6);
        if (!items.length) {
            return '<p>No customer work has been created yet.</p>';
        }
        return '<ul class="activity-list">' + items.map(function (item) {
            return `<li><strong>${h(item.title)}</strong><small>${h(item.detail)} · ${h(formatDate(item.updatedAt))}</small>${item.action}</li>`;
        }).join('') + '</ul>';
    }

    function customerCard(customer) {
        const assessments = app.bootstrap.assessments.filter(function (item) { return item.customerId === customer.id; });
        const proposals = app.bootstrap.proposals.filter(function (item) { return item.customerId === customer.id; });
        return [
            '<article class="customer-card">',
            `<div class="card-header"><div><p class="eyebrow">${h(customer.industry || 'Customer')}</p><h2>${h(customer.name)}</h2></div>${classificationBadge(customer.classification)}</div>`,
            `<p>${h(customer.region || 'Region not captured')}${customer.accountOwner ? ` · ${h(customer.accountOwner)}` : ''}</p>`,
            `<div class="card-meta"><span>${assessments.length} assessments</span><span>${proposals.length} proposals</span><span>Updated ${h(formatDate(customer.updatedAt))}</span></div>`,
            `<button class="button button-primary" type="button" data-action="open-customer" data-customer-id="${h(customer.id)}">Open customer</button>`,
            '</article>'
        ].join('');
    }

    function reasonGroup(title, items) {
        if (!items || !items.length) {
            return '';
        }
        return `<section class="reason-group"><h4>${h(title)}</h4><ul>${items.map(function (item) { return `<li>${h(item)}</li>`; }).join('')}</ul></section>`;
    }

    function detailItem(label, value, allowHtml) {
        return `<div><dt>${h(label)}</dt><dd>${allowHtml ? value : h(value)}</dd></div>`;
    }

    function classificationBadge(value) {
        const safe = value || 'internal';
        return `<span class="classification classification-${h(safe)}">${h(statusLabel(safe))}</span>`;
    }

    function emptyState(title, text, action) {
        return `<section class="empty-state"><h2>${h(title)}</h2><p>${h(text)}</p>${action || ''}</section>`;
    }

    function fitOption(value, label) {
        return `<option value="${h(value)}" ${app.filters.fit === value ? 'selected' : ''}>${h(label)}</option>`;
    }

    function selectOptions(options, selected) {
        return options.map(function (item) {
            return `<option value="${h(item[0])}" ${item[0] === selected ? 'selected' : ''}>${h(item[1])}</option>`;
        }).join('');
    }

    function customerById(id) {
        return app.bootstrap.customers.find(function (customer) { return customer.id === id; }) || null;
    }

    function activeCustomerId() {
        return app.activeCustomer && app.activeCustomer.id ||
            app.customerDetail && app.customerDetail.customer && app.customerDetail.customer.id ||
            '';
    }

    function can(capability) {
        return app.bootstrap.user.capabilities.includes(capability);
    }

    function emptyAnswer() {
        return {
            value: '',
            notes: '',
            evidence: '',
            importance: 'medium',
            confidence: 'medium',
            internalNotes: ''
        };
    }

    function answerHasValue(answer) {
        return Boolean(answer && (Array.isArray(answer.value) ? answer.value.length : String(answer.value || '').trim()));
    }

    function formValues(form) {
        return Object.fromEntries(new FormData(form).entries());
    }

    function lines(value) {
        return String(value || '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    }

    function readFile(file) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('The CSV file could not be read.')); };
            reader.readAsText(file);
        });
    }

    function roleLabel(value) {
        return {
            admin: 'Administrator',
            service_owner: 'Service owner',
            consultant: 'Consultant'
        }[value] || statusLabel(value);
    }

    function fitLabel(value) {
        return {
            strong_fit: 'Strong fit',
            potential_fit: 'Potential fit — validate',
            insufficient_information: 'Insufficient information',
            not_currently_suitable: 'Not currently suitable'
        }[value] || statusLabel(value);
    }

    function statusLabel(value) {
        return String(value || '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
    }

    function sortUpdated(a, b) {
        return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    }

    function formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleDateString('en-NZ', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });
    }

    function formatMoney(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number.toLocaleString('en-NZ', {
            minimumFractionDigits: number % 1 ? 2 : 0,
            maximumFractionDigits: 2
        }) : '';
    }

    function formatDateTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString('en-NZ', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function nl2br(value) {
        return h(value).replace(/\n/g, '<br>');
    }

    function cssEscape(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') {
            return window.CSS.escape(value);
        }
        return String(value).replace(/"/g, '\\"');
    }

    function h(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}());
