(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./dashboardRegistry'));
    else root.NoFriesDashboard = factory(root.NoFriesDashboardRegistry);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (registry) {
    'use strict';

    const mounted = new WeakMap();
    let mountSequence = 0;
    const moduleStates = { ready: 'Included', planned: 'Included · workspace coming next', disabled: 'Included · unavailable' };
    const serviceStates = { not_included: 'Available to scope', disabled: 'Included · unavailable', setup_required: 'Waiting for setup' };
    const metricLabels = { implementation: 'Implementation attainment', evidence: 'Evidence confidence', risk: 'Risk priority', trend: 'Trend' };

    // The shell performs no authorisation, storage or scoring. An explicitly
    // composed ready Cyber child owns its client operations and leave lifecycle.
    // Mount only the current server-authorised display projection, never a grant.
    function mount(root, input, options) {
        options = options || {};
        if (!root || !root.ownerDocument) throw new Error('dashboard_root_required');
        if (mounted.has(root)) mounted.get(root).destroy();
        root.replaceChildren();
        const doc = root.ownerDocument;
        const win = options.window || doc.defaultView;
        let model;
        try { model = validate(input); } catch (error) { return showState(root, 'denied'); }
        const permitted = model.modules.map(function (item) { return item.key; });
        const available = registry.modules.filter(function (item) { return permitted.includes(item.key); });
        // Presentation priority only: destinations still come from the current
        // server-filtered registry, and readiness comes from its display state.
        const primary = available.filter(function (item) {
            const implemented = ['overview', 'cyber_security', 'services'].includes(item.key) ||
                item.key === 'improvement_plan' && typeof options.mountImprovement === 'function';
            return implemented && stateFor(item.key) === 'ready';
        });
        const secondary = available.filter(function (item) { return !primary.includes(item); });
        const pictureAvailable = typeof options.mountPicture === 'function' && model.modules.some(function (item) {
            return item.key === 'cyber_security' && item.state === 'ready';
        });
        const first = available.find(function (item) { return item.key === 'overview'; }) || available[0];
        let current = first;
        let disposed = false;
        let main;
        let status;
        let groups;
        let rail;
        let child = null;
        let navigation = null;
        const generation = Object.freeze({ mount: ++mountSequence });
        const historySession = 'nofries-dashboard-' + generation.mount;
        const historyEntries = new Map();
        let managedHistory = (typeof options.mountCyber === 'function' || typeof options.mountPicture === 'function' ||
            typeof options.mountImprovement === 'function') && win && win.history &&
            typeof win.history.replaceState === 'function' && typeof win.history.go === 'function';
        let entrySequence = 0;
        let committedEntry = null;
        let observedEntry = null;
        let travelling = null;
        let eventQueued = false;
        let queuedEvent = null;
        let unmanagedBoundaryHash = null;

        function element(tag, className, text) {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            if (text != null) node.textContent = String(text);
            return node;
        }
        function button(label, action, className) {
            const node = element('button', className || 'dashboard-button', label);
            node.type = 'button'; node.addEventListener('click', action); return node;
        }
        function badge(label) { return element('span', 'dashboard-badge', label); }
        function stateFor(key) { return model.modules.find(function (item) { return item.key === key; }).state; }
        function routeLink(item, className, availability) {
            const link = element('a', className || 'dashboard-module-link');
            link.href = '#' + item.route;
            link.dataset.module = item.key;
            const icon = element('span', 'dashboard-icon', item.icon); icon.setAttribute('aria-hidden', 'true');
            const label = element('span', '', item.label);
            if (availability) label.append(element('span', 'dashboard-menu-state dashboard-muted', availability));
            link.append(icon, label);
            if (item.key === current.key) link.setAttribute('aria-current', 'page');
            link.addEventListener('click', function (event) { event.preventDefault(); navigate(item.route, true); });
            return link;
        }
        function appendMenu(nav, mobile) {
            const links = element('div', 'dashboard-menu-primary');
            links.append(element('p', 'dashboard-eyebrow', 'Workspace'));
            primary.forEach(function (item) {
                links.append(routeLink(item, mobile ? 'dashboard-module-link dashboard-task' : null));
            });
            nav.append(links);
            if (!secondary.length) return;
            const other = element('details', 'dashboard-menu-other');
            other.append(element('summary', '', 'More tools'));
            secondary.forEach(function (item) {
                const labels = { ready: 'Available', planned: 'Coming next', disabled: 'Unavailable' };
                other.append(routeLink(item, null, labels[stateFor(item.key)]));
            });
            nav.append(other);
        }
        function panel(title, copy) {
            const section = element('section', 'dashboard-panel');
            section.append(element('h2', '', title));
            if (copy) section.append(element('p', 'dashboard-muted', copy));
            return section;
        }
        function initialise() {
            root.classList.add('nofries-dashboard');
            const skip = element('a', 'dashboard-skip', 'Skip to dashboard content'); skip.href = '#dashboard-content';
            skip.addEventListener('click', function (event) { event.preventDefault(); main.focus(); });
            const layout = element('div', 'dashboard-layout');
            rail = element('aside', 'dashboard-rail');
            const brand = element('div', 'dashboard-brand');
            brand.append(element('span', 'dashboard-brand-mark', 'NF'), element('strong', '', 'No Fries'));
            const context = element('div', 'dashboard-context');
            context.append(element('span', 'dashboard-eyebrow', 'Organisation'),
                element('strong', '', model.context.displayName));
            if (model.currentUser.jobTitle !== null) context.append(element('span', 'dashboard-muted', model.currentUser.jobTitle));
            const nav = element('nav'); nav.setAttribute('aria-label', 'Workspace');
            appendMenu(nav, false);
            const subscription = element('div', 'dashboard-subscription');
            subscription.append(element('span', 'dashboard-eyebrow', 'Dashboard subscription'), element('strong', '', model.subscription),
                element('p', '', 'Managed and advisory services are scoped separately.'));
            rail.append(brand, context, nav, subscription);
            const workspace = element('div', 'dashboard-workspace');
            const top = element('header', 'dashboard-topbar');
            top.append(element('strong', '', model.context.displayName));
            if (model.currentUser.jobTitle !== null) top.append(element('span', 'dashboard-muted', model.currentUser.jobTitle));
            status = element('p', 'dashboard-route-status'); status.setAttribute('role', 'status'); status.hidden = true;
            main = element('main', 'dashboard-main'); main.id = 'dashboard-content'; main.tabIndex = -1;
            groups = element('nav', 'dashboard-mobile-nav'); groups.setAttribute('aria-label', 'Dashboard tasks');
            appendMenu(groups, true);
            workspace.append(top, status, groups, main); layout.append(rail, workspace); root.append(skip, layout);
            navigate(options.initialRoute == null ? (win && win.location.hash || '') : options.initialRoute, false);
        }
        function updateNavigation() {
            [rail, groups].forEach(function (nav) {
                nav.querySelectorAll('[data-module]').forEach(function (link) {
                    if (link.dataset.module === current.key) link.setAttribute('aria-current', 'page');
                    else link.removeAttribute('aria-current');
                });
                const other = nav.querySelector('.dashboard-menu-other');
                if (other && secondary.includes(current)) other.open = true;
            });
        }
        function active() { return !disposed; }
        function stateWith(entry) {
            const prior = win.history.state;
            const next = prior && typeof prior === 'object' && !Array.isArray(prior) ? Object.assign({}, prior) : {};
            next.nofriesDashboard = { session: historySession, entry: entry.id };
            return next;
        }
        function makeEntry(route, position, hash) {
            const entry = { id: String(++entrySequence), route: route, position: position, hash: hash };
            historyEntries.set(entry.id, entry); return entry;
        }
        function readEntry() {
            const token = win.history.state && win.history.state.nofriesDashboard;
            if (!token || token.session !== historySession || typeof token.entry !== 'string') return null;
            const entry = historyEntries.get(token.entry);
            return entry && entry.hash === win.location.hash ? entry : null;
        }
        function tagInitial() {
            if (!managedHistory) return;
            committedEntry = makeEntry(current.route, 0, win.location.hash);
            observedEntry = committedEntry;
            win.history.replaceState(stateWith(committedEntry), '', win.location.hash || '#' + current.route);
            committedEntry.hash = win.location.hash;
        }
        function pushEntry(route) {
            const hash = '#' + route;
            if (!managedHistory) { if (win && win.history) win.history.pushState(null, '', hash); return; }
            const position = (observedEntry || committedEntry).position + 1;
            const entry = makeEntry(route, position, hash);
            win.history.pushState(stateWith(entry), '', hash);
            observedEntry = entry; committedEntry = entry;
        }
        function travelTo(entry) {
            if (!active() || !managedHistory || !entry || !observedEntry) return Promise.resolve(false);
            if (observedEntry.id === entry.id) return Promise.resolve(true);
            if (observedEntry.position === entry.position) return Promise.resolve(false);
            if (travelling) return travelling.promise.then(function (arrived) { return arrived && active() ? travelTo(entry) : false; });
            let resolve;
            const promise = new Promise(function (done) { resolve = done; });
            travelling = { entry: entry, resolve: resolve, promise: promise, issuedFrom: observedEntry.id };
            win.history.go(entry.position - observedEntry.position);
            return promise;
        }
        function commitNavigation(route, changeLocation, focus, initialAssessmentId, sourceAssessment) {
            if (!active()) return;
            const requested = registry.resolveRoute(route, permitted);
            const target = requested || first;
            if (child && current.key === target.key) {
                if (focus) main.querySelector('h1').focus();
                return;
            }
            const repeatedRoute = current.key === target.key && win && win.location.hash === '#' + target.route;
            current = target;
            status.hidden = !!requested || !route;
            status.textContent = requested || !route ? '' : 'That view is not available for this organisation. Showing ' + target.label + '.';
            if (changeLocation && !repeatedRoute) pushEntry(current.route);
            render(initialAssessmentId, sourceAssessment); updateNavigation();
            if (focus) main.querySelector('h1').focus();
        }
        function navigate(route, changeLocation, historyTarget, initialAssessmentId, sourceAssessment) {
            if (!active()) return Promise.resolve(false);
            const requested = registry.resolveRoute(route, permitted) || first;
            if (navigation) return navigation.promise;
            if (!child && !historyTarget || child && current.key === requested.key && !historyTarget) {
                commitNavigation(route, changeLocation, changeLocation, initialAssessmentId, sourceAssessment); return Promise.resolve(true);
            }
            let resolve;
            const promise = new Promise(function (done) { resolve = done; });
            const transition = { route: route, target: historyTarget, assessmentId: initialAssessmentId, sourceAssessment: sourceAssessment,
                accepted: false, work: null, promise: promise, resolve: resolve };
            navigation = transition;
            async function accept() {
                if (!active() || navigation !== transition) return false;
                transition.accepted = true;
                if (transition.target) {
                    if (!await travelTo(transition.target) || !active() || navigation !== transition) return false;
                    committedEntry = transition.target;
                }
                commitNavigation(transition.route, !transition.target && changeLocation, true, transition.assessmentId, transition.sourceAssessment);
                return true;
            }
            async function decide() {
                // Return the browser cursor to the committed owned entry before
                // opening a leave dialog. Cancellation never overwrites history.
                if (historyTarget && !await travelTo(committedEntry)) return false;
                if (!active() || navigation !== transition) return false;
                if (child) {
                    await child.requestLeave(function () { transition.work = accept(); });
                    if (!transition.accepted) return false;
                    return transition.work ? await transition.work : false;
                }
                return accept();
            }
            decide().then(function (accepted) {
                if (navigation === transition) navigation = null;
                resolve(!!accepted && active());
            }, function () {
                if (navigation === transition) navigation = null;
                resolve(false);
            });
            return promise;
        }
        function render(initialAssessmentId, sourceAssessment) {
            if (child) { child.destroy(); child = null; }
            main.replaceChildren();
            const head = element('header', 'dashboard-page-heading');
            const title = element('h1', '', current.label); title.tabIndex = -1;
            head.append(element('p', 'dashboard-eyebrow', 'Your organisation / ' + current.label), title,
                badge(moduleStates[stateFor(current.key)]));
            main.append(head);
            const siblings = primary.filter(function (item) { return item.group === current.group; });
            if (siblings.length > 1) {
                const subnav = element('nav', 'dashboard-group-links'); subnav.setAttribute('aria-label', current.group + ' modules');
                subnav.append.apply(subnav, siblings.map(function (item) { return routeLink(item); })); main.append(subnav);
            }
            if (stateFor(current.key) === 'disabled') {
                main.append(panel('This module is temporarily unavailable', 'Your subscription includes this module, but it has not been enabled. Other included modules remain available.'));
            } else if (current.key === 'overview') renderOverview();
            else if (current.key === 'services') renderServices();
            else if (current.key === 'cyber_security' && stateFor(current.key) === 'ready' && typeof options.mountCyber === 'function') renderCyber(initialAssessmentId);
            else if (current.key === 'improvement_plan' && stateFor(current.key) === 'ready' && typeof options.mountImprovement === 'function') renderImprovement(sourceAssessment);
            else renderModule();
            const footer = element('footer', 'dashboard-provenance');
            const stamp = element('time', '', model.generatedAt.replace('T', ' ').replace('.000Z', ' UTC'));
            stamp.dateTime = model.generatedAt;
            footer.append(element('span', '', 'Display snapshot · '), stamp,
                element('p', '', 'Assessment indicators are not audit, assurance or certification.'));
            main.append(footer);
        }
        function renderOverview() {
            const connectedPicture = pictureAvailable;
            if (connectedPicture) renderPicture();
            if (model.summary.state === 'stale') {
                const notice = panel('This snapshot needs a refresh', 'These figures are historical. Reopen through the authenticated dashboard before relying on them.');
                notice.classList.add('dashboard-warning'); main.append(notice);
            }
            const grid = element('div', 'dashboard-overview-grid');
            const attention = panel('Needs attention', 'Named owners. Clear next steps.');
            attention.classList.add('dashboard-attention');
            if (!model.summary.attention.length) {
                attention.append(element('h3', '', 'Build your first baseline'), element('p', '', 'No assessment or improvement record has been shared with this view yet.'));
                const assessment = available.find(function (item) { return item.group === 'Assess' && stateFor(item.key) === 'ready'; });
                if (assessment) attention.append(button('View ' + assessment.label, function () { navigate(assessment.route, true); }));
                else attention.append(element('p', 'dashboard-muted', 'An organisation administrator can confirm your assessment scope.'));
            } else {
                const list = element('ol', 'dashboard-attention-list');
                model.summary.attention.forEach(function (item, index) {
                    const row = element('li', 'dashboard-attention-item');
                    const trigger = button(item.title, function () { openAttention(index); }, 'dashboard-record-link');
                    trigger.dataset.attention = String(index);
                    row.append(badge(item.priority + ' priority'), trigger,
                        element('p', 'dashboard-owner', item.owner + ' · ' + item.due), element('p', '', item.nextAction));
                    if (index > 2) row.classList.add('dashboard-extra-attention');
                    list.append(row);
                });
                attention.append(list);
                if (model.summary.attention.length > 3) attention.append(button('View all attention items', function (event) {
                    attention.classList.add('dashboard-show-all'); event.currentTarget.hidden = true;
                    const next = attention.querySelectorAll('[data-attention]')[3]; if (next) next.focus();
                }, 'dashboard-button dashboard-view-all'));
            }
            const posture = panel('The current picture', 'Separate measures, with their evidence.');
            const metrics = element('div', 'dashboard-metrics');
            Object.keys(metricLabels).forEach(function (kind) {
                const values = model.summary.metrics.filter(function (metric) { return metric.kind === kind; });
                if (!values.length) {
                    const card = element('article', 'dashboard-metric'); card.append(element('h3', '', metricLabels[kind]),
                        element('strong', 'dashboard-metric-value', 'Not assessed'), element('p', 'dashboard-muted', 'No figure is inferred from missing data.')); metrics.append(card);
                }
                values.forEach(function (metric) {
                    const card = element('article', 'dashboard-metric');
                    card.append(element('h3', '', metricLabels[kind]), element('strong', 'dashboard-metric-value', metric.value),
                        element('p', '', registry.modules.find(function (item) { return item.key === metric.module; }).label + ' · ' + metric.period),
                        element('p', 'dashboard-muted', metric.version + ' · ' + metric.revision),
                        element('p', 'dashboard-muted', metric.evidence), element('p', 'dashboard-muted', 'As at ' + metric.asAt.replace('T', ' ').replace('.000Z', ' UTC')));
                    metrics.append(card);
                });
            });
            posture.append(metrics); grid.append(attention, posture);
            if (!connectedPicture) main.append(grid);
            else if (model.summary.attention.length) main.append(attention);
            const modules = element('details', 'dashboard-panel dashboard-availability');
            modules.append(element('summary', '', 'Other dashboard areas and availability'),
                element('p', 'dashboard-muted', 'Use the dashboard navigation to open an area. Planned areas have no connected assessment data.'));
            const list = element('ul');
            available.filter(function (item) { return item.key !== 'overview'; }).forEach(function (item) {
                list.append(element('li', '', item.label + ' · ' + moduleStates[stateFor(item.key)]));
            });
            modules.append(list); main.append(modules);
        }
        function renderPicture() {
            const childRoot = element('div', 'dashboard-picture-workspace'); main.append(childRoot);
            const cyber = available.find(function (item) { return item.key === 'cyber_security' && stateFor(item.key) === 'ready'; });
            const improvement = typeof options.mountImprovement === 'function' && available.find(function (item) {
                return item.key === 'improvement_plan' && stateFor(item.key) === 'ready';
            });
            let pictureChild = null;
            try {
                const result = options.mountPicture(childRoot, { generation: generation,
                    displayName: model.context.displayName,
                    openCyber: cyber ? function (assessmentId) {
                        if (!active() || !pictureChild || child !== pictureChild) return Promise.resolve(false);
                        return navigate(cyber.route, true, undefined, assessmentId);
                    } : undefined,
                    openImprovement: improvement ? function (sourceAssessment) {
                        if (!active() || !pictureChild || child !== pictureChild) return Promise.resolve(false);
                        return navigate(improvement.route, true, undefined, undefined, sourceAssessment);
                    } : undefined });
                if (!result || typeof result.destroy !== 'function' || typeof result.requestLeave !== 'function') throw new Error('invalid_child');
                pictureChild = result; child = result;
            } catch (_) {
                childRoot.replaceChildren(); childRoot.append(panel('The organisation picture could not load', 'Reopen this view to retrieve your authorised saved assessment.'));
            }
        }
        function openAttention(index) {
            const item = model.summary.attention[index]; if (!item || disposed) return;
            if (child) { child.destroy(); child = null; }
            main.replaceChildren();
            const back = button('Back to Overview', function () {
                render(); const trigger = main.querySelector('[data-attention="' + index + '"]');
                if (trigger) { const panel = trigger.closest('.dashboard-attention'); if (panel) panel.classList.add('dashboard-show-all'); trigger.focus(); }
            }, 'dashboard-text-button');
            const title = element('h1', '', item.title); title.tabIndex = -1;
            const details = panel('Next action', item.nextAction);
            const facts = element('dl', 'dashboard-facts');
            [['Owner', item.owner], ['Due state', item.due], ['Priority', item.priority], ['Source', item.source]].forEach(function (pair) {
                facts.append(element('dt', '', pair[0]), element('dd', '', pair[1]));
            });
            const destination = available.find(function (entry) { return entry.key === item.module; });
            details.append(facts, routeLink(destination)); main.append(back, title, details); title.focus();
        }
        function renderCyber(initialAssessmentId) {
            const childRoot = element('div', 'dashboard-cyber-workspace'); main.append(childRoot);
            try {
                const presentation = { generation: generation };
                if (initialAssessmentId !== undefined) presentation.initialAssessmentId = initialAssessmentId;
                const result = options.mountCyber(childRoot, presentation);
                if (!result || typeof result.destroy !== 'function' || typeof result.requestLeave !== 'function') throw new Error('invalid_child');
                child = result;
            } catch (error) {
                childRoot.replaceChildren();
                childRoot.append(element('p', '', 'The Cyber workspace could not load. Reopen it through your authenticated dashboard.'));
            }
        }
        function renderImprovement(sourceAssessment) {
            const childRoot = element('div', 'dashboard-improvement-workspace'); main.append(childRoot);
            try {
                const presentation = { generation: generation };
                if (sourceAssessment !== undefined) presentation.sourceAssessment = sourceAssessment;
                const result = options.mountImprovement(childRoot, presentation);
                if (!result || typeof result.destroy !== 'function' || typeof result.requestLeave !== 'function') throw new Error('invalid_child');
                child = result;
            } catch (_) {
                childRoot.replaceChildren();
                childRoot.append(element('p', '', 'The Improvement Plan could not load. Reopen it through your authenticated dashboard.'));
            }
        }
        function renderModule() {
            const section = panel('Your ' + current.label.toLowerCase() + ' workspace is coming next',
                'This tool is included for your organisation and is not available yet.');
            section.append(element('p', '', 'No assessment is started, evidence uploaded or report issued from this screen.'));
            const home = available.find(function (item) { return item.key === 'overview'; });
            if (home) section.append(button('Return to Overview', function () { navigate(home.route, true); }));
            main.append(section);
        }
        function renderServices() {
            main.append(element('p', 'dashboard-intro', 'What is included, what needs setup and what can be scoped separately?'));
            const subscription = panel('No Fries ' + model.subscription, 'Your dashboard subscription does not automatically include monitoring, support or advisory services.');
            subscription.classList.add('dashboard-subscription-panel'); main.append(subscription);
            const cards = element('div', 'dashboard-service-cards');
            model.services.forEach(function (service) {
                const item = registry.services.find(function (entry) { return entry.key === service.key; });
                const card = panel(item.label, item.description);
                card.append(badge(serviceStates[service.state]));
                const detail = element('div', 'dashboard-service-detail'); detail.hidden = true;
                detail.append(element('p', '', service.state === 'not_included'
                    ? 'Next step: agree the organisation, coverage, deliverables, term and commercial scope with No Fries.'
                    : service.state === 'disabled'
                    ? 'This included service is disabled in the current build. No Fries must confirm readiness before enabling it; a provider connection alone will not activate it.'
                    : 'Next step: verify the agreed assignment, coverage and any required provider connection before activation.'),
                    element('p', 'dashboard-muted', 'This is information only. No request, purchase, assignment or activation has been submitted.'));
                const control = button(service.state === 'not_included' ? 'How to scope this service'
                    : service.state === 'disabled' ? 'About availability' : 'What is needed for setup', function () {
                    detail.hidden = !detail.hidden; control.setAttribute('aria-expanded', String(!detail.hidden));
                }, 'dashboard-text-button');
                control.setAttribute('aria-expanded', 'false');
                detail.id = 'dashboard-service-' + item.key; control.setAttribute('aria-controls', detail.id);
                card.append(control, detail); cards.append(card);
            });
            main.append(cards);
        }
        function handleLocation(eventType) {
            if (!active()) return;
            if (unmanagedBoundaryHash !== null && win.location.hash === unmanagedBoundaryHash) { unmanagedBoundaryHash = null; return; }
            unmanagedBoundaryHash = null;
            if (!managedHistory) { navigate(win.location.hash, false); main.querySelector('h1').focus(); return; }
            let entry = readEntry();
            if (!entry && eventType === 'hashchange' && observedEntry) {
                const target = registry.resolveRoute(win.location.hash, permitted) || first;
                entry = makeEntry(target.route, observedEntry.position + 1, win.location.hash);
                win.history.replaceState(stateWith(entry), '', win.location.hash);
            }
            if (!entry) {
                // A pre-mount/foreign history entry has no trusted position.
                // This is an unmanaged boundary, never a guessed go() delta.
                if (travelling) { travelling.resolve(false); travelling = null; }
                if (navigation) { navigation.resolve(false); navigation = null; }
                if (child) { child.destroy(); child = null; }
                managedHistory = false; observedEntry = null; committedEntry = null;
                unmanagedBoundaryHash = win.location.hash;
                commitNavigation(win.location.hash, false, true);
                return;
            }
            observedEntry = entry;
            if (travelling) {
                const trip = travelling;
                if (entry.id === trip.entry.id) { travelling = null; trip.resolve(true); }
                else if (trip.entry.position === entry.position) { travelling = null; trip.resolve(false); }
                else if (trip.issuedFrom !== entry.id) { trip.issuedFrom = entry.id; win.history.go(trip.entry.position - entry.position); }
                return;
            }
            if (navigation) {
                if (committedEntry && entry.id !== committedEntry.id) travelTo(committedEntry);
                return;
            }
            if (committedEntry && entry.id === committedEntry.id) return;
            navigate(entry.route, false, entry);
        }
        function locationChanged(event) {
            if (!managedHistory) { handleLocation(event && event.type || 'hashchange'); return; }
            const type = event && event.type || 'hashchange';
            if (type === 'popstate' || !queuedEvent) queuedEvent = type;
            if (eventQueued) return;
            eventQueued = true;
            Promise.resolve().then(function () {
                const eventType = queuedEvent; eventQueued = false; queuedEvent = null;
                if (active()) handleLocation(eventType);
            });
        }
        const controller = { navigate: function (route) { return navigate(route, true); }, requestLeave: function (commit) {
            if (disposed) return Promise.resolve(false);
            if (child) return child.requestLeave(commit);
            if (typeof commit === 'function') commit();
            return Promise.resolve(true);
        }, destroy: function () {
            if (disposed) return;
            disposed = true;
            if (child) { child.destroy(); child = null; }
            if (navigation) { navigation.resolve(false); navigation = null; }
            if (travelling) { travelling.resolve(false); travelling = null; }
            historyEntries.clear();
            if (win) { win.removeEventListener('hashchange', locationChanged); win.removeEventListener('popstate', locationChanged); }
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        } };
        initialise(); tagInitial();
        if (win) { win.addEventListener('hashchange', locationChanged); win.addEventListener('popstate', locationChanged); }
        mounted.set(root, controller); return controller;
    }

    function validate(input) {
        // Copy only a JSON display snapshot; no executable callbacks or DOM input.
        const model = JSON.parse(JSON.stringify(input));
        if (!model || model.schemaVersion !== 1 || !model.context || !safeText(model.context.organisationId) ||
            !safeText(model.context.displayName) || !['IT manager', 'Executive / board', 'Scoped advisor'].includes(model.audience) ||
            !['Score', 'Govern'].includes(model.subscription) || model.admissionGranted !== false || model.providerAccessGranted !== false ||
            !canonicalInstant(model.generatedAt) || !Array.isArray(model.modules) || !model.modules.length ||
            !Array.isArray(model.services) || !model.summary || !['empty', 'current', 'stale'].includes(model.summary.state)) throw new Error('invalid');
        // Old display payloads have no per-user title. Audience remains a
        // permission-derived classification, never a fallback job title.
        if (!Object.prototype.hasOwnProperty.call(model, 'currentUser')) model.currentUser = { jobTitle: null };
        if (!model.currentUser || typeof model.currentUser !== 'object' || Array.isArray(model.currentUser) ||
            Object.keys(model.currentUser).length !== 1 || !Object.prototype.hasOwnProperty.call(model.currentUser, 'jobTitle') ||
            model.currentUser.jobTitle !== null && !safeJobTitle(model.currentUser.jobTitle)) throw new Error('invalid');
        const keys = model.modules.map(function (item) {
            if (!registry.modules.some(function (entry) { return entry.key === item.key; }) ||
                !Object.prototype.hasOwnProperty.call(moduleStates, item.state)) throw new Error('invalid');
            return item.key;
        });
        if (new Set(keys).size !== keys.length) throw new Error('invalid');
        function readable(key) { return model.modules.some(function (item) { return item.key === key && item.state !== 'disabled'; }); }
        const services = new Set();
        model.services.forEach(function (item) {
            if (!readable('services') || !registry.services.some(function (entry) { return entry.key === item.key; }) ||
                !Object.prototype.hasOwnProperty.call(serviceStates, item.state) || item.operational !== false || services.has(item.key)) throw new Error('invalid');
            services.add(item.key);
        });
        if (!Array.isArray(model.summary.attention) || !Array.isArray(model.summary.metrics) ||
            (!readable('overview') && (model.summary.attention.length || model.summary.metrics.length))) throw new Error('invalid');
        model.summary.attention.forEach(function (item) {
            if (!readable(item.module) || !['title', 'owner', 'due', 'source', 'nextAction'].every(function (key) { return safeText(item[key]); }) ||
                !['High', 'Medium', 'Low', 'Unrated'].includes(item.priority)) throw new Error('invalid');
        });
        model.summary.metrics.forEach(function (item) {
            if (!readable(item.module) || !Object.prototype.hasOwnProperty.call(metricLabels, item.kind) ||
                !['value', 'period', 'version', 'revision', 'evidence'].every(function (key) { return safeText(item[key]); }) ||
                !canonicalInstant(item.asAt) || Date.parse(item.asAt) > Date.parse(model.generatedAt)) throw new Error('invalid');
        });
        return model;
    }
    function safeText(value) { return typeof value === 'string' && !!value.trim() && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value); }
    function safeJobTitle(value) { return typeof value === 'string' && !!value && value.length <= 120 &&
        value === value.trim().normalize('NFC') && !/[\u0000-\u001f\u007f-\u009f<>]/u.test(value); }
    function canonicalInstant(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
            Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    }
    function showState(root, state) {
        if (mounted.has(root)) mounted.get(root).destroy();
        root.replaceChildren(); root.classList.add('nofries-dashboard');
        const doc = root.ownerDocument;
        const panel = doc.createElement('section'); panel.className = 'dashboard-status-panel'; panel.setAttribute('role', 'status');
        const heading = doc.createElement('h1');
        heading.textContent = state === 'loading' ? 'Loading your dashboard' : state === 'error' ? 'The dashboard could not load' : 'This dashboard is not available';
        const copy = doc.createElement('p'); copy.textContent = state === 'loading' ? 'Checking the latest authorised organisation context.'
            : 'No organisation records are shown. Reopen the dashboard through your authenticated organisation context.';
        panel.append(heading, copy); root.append(panel);
        let disposed = false;
        const controller = { destroy: function () {
            if (disposed) return;
            disposed = true;
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        } };
        mounted.set(root, controller); return controller;
    }
    return Object.freeze({ mount: mount, showState: showState, validate: validate });
}));
