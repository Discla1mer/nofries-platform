(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesTryDemo = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Fictional demonstration only (#29). No real organisation, person, record,
    // credential or framework text. Nothing here reads or writes beyond STORAGE_KEY.
    const STORAGE_KEY = 'nofries.tryDemo.v1';
    const BUSINESS = 'Brightwater Joinery (fictional)';
    const OPTIONS = [['yes', 'Yes', 2], ['partly', 'Partly', 1], ['no', 'No', 0], ['unsure', 'Not sure', 0]];
    const AREAS = ['People and access', 'Devices and protection', 'Backup and recovery'];
    const QUESTIONS = [
        ['mfa', 0, 'Does everyone sign in to email and files with a second step, such as an app code?', 'Turn on two-step sign-in for every account, starting with owners and finance.', 'Office manager'],
        ['admins', 0, 'Is administrator access limited to the people who need it, and reviewed at least once a year?', 'List who has administrator access, remove anyone who no longer needs it and book a yearly review.', 'Business owner'],
        ['updates', 1, 'Do work laptops and phones install security updates automatically?', 'Switch on automatic updates and check monthly that every device is current.', 'IT provider'],
        ['protection', 1, 'Is security software running and watched on every work device?', 'Confirm which devices are protected and who responds to alerts.', 'IT provider'],
        ['backup', 2, 'Are important work files backed up somewhere separate from your everyday systems?', 'Agree what must be backed up and keep a copy separate from day-to-day accounts.', 'Business owner'],
        ['restore', 2, 'Have you restored a file from backup in the last six months to prove it works?', 'Restore a sample file this month and record the date and result.', 'Office manager']
    ].map(function (row) { return Object.freeze({ id: row[0], area: row[1], text: row[2], action: row[3], owner: row[4] }); });
    const EXAMPLE_ANSWERS = Object.freeze({ mfa: 'partly', admins: 'unsure', updates: 'yes', protection: 'partly', backup: 'yes', restore: 'no' });

    function projection() {
        const asAt = '2026-10-30T09:00:00.000Z';
        function metric(kind, value) {
            return { module: 'cyber_security', kind: kind, value: value, period: 'Example review · October 2026',
                version: 'Sample question set', revision: 'Fictional example data', evidence: 'No evidence is collected in this demo', asAt: asAt };
        }
        function attention(title, owner, due, priority, area, nextAction) {
            return { module: 'cyber_security', title: title, owner: owner, due: due, priority: priority,
                source: 'Example Cyber Security review · ' + area, nextAction: nextAction };
        }
        return {
            schemaVersion: 1, context: { organisationId: 'fictional-demo', displayName: BUSINESS }, currentUser: { jobTitle: null },
            audience: 'IT manager', subscription: 'Govern', admissionGranted: false, providerAccessGranted: false,
            generatedAt: '2026-11-01T09:00:00.000Z',
            modules: ['overview', 'ai_governance', 'cyber_security', 'it_optimisation', 'improvement_plan', 'evidence', 'board_reports', 'services']
                .map(function (key) { return { key: key, state: ['overview', 'cyber_security', 'services'].includes(key) ? 'ready' : 'planned' }; }),
            services: ['managed_endpoint', 'work_file_backup', 'microsoft_365_admin', 'fractional_advisory']
                .map(function (key) { return { key: key, state: 'not_included', operational: false }; }),
            summary: { state: 'current', attention: [
                attention('Review who has administrator access', 'Business owner', 'Due this week', 'High', AREAS[0], QUESTIONS[1].action),
                attention('Prove the backup can be restored', 'Office manager', 'Due this month', 'High', AREAS[2], QUESTIONS[5].action),
                attention('Confirm who responds to device alerts', 'IT provider', 'Awaiting decision', 'Medium', AREAS[1], QUESTIONS[3].action)
            ], metrics: [metric('implementation', '50%'), metric('risk', '2 high priorities'), metric('trend', '+8 points since July')] }
        };
    }

    function points(optionId) { const option = OPTIONS.find(function (row) { return row[0] === optionId; }); return option ? option[2] : 0; }
    function results(answers) {
        const areas = AREAS.map(function (name, index) {
            const items = QUESTIONS.filter(function (question) { return question.area === index; });
            const percent = Math.round(items.reduce(function (sum, question) { return sum + points(answers[question.id]); }, 0) / (items.length * 2) * 100);
            return { name: name, percent: percent, label: percent >= 75 ? 'In good shape' : percent >= 50 ? 'Some gaps' : 'Needs attention' };
        });
        const rank = { High: 0, Medium: 1 };
        const actions = QUESTIONS.filter(function (question) { return answers[question.id] !== 'yes'; }).map(function (question) {
            return { id: question.id, area: AREAS[question.area], action: question.action, owner: question.owner,
                priority: answers[question.id] === 'partly' ? 'Medium' : 'High' };
        }).sort(function (a, b) { return rank[a.priority] - rank[b.priority]; });
        return { areas: areas, actions: actions, complete: QUESTIONS.every(function (question) { return !!answers[question.id]; }) };
    }

    // Browser storage is optional. A blocked or throwing store falls back to memory.
    function createStore(storage) {
        let memory = null;
        function empty() { return { answers: {}, view: 'intro' }; }
        function clean(value) {
            const state = empty();
            if (!value || typeof value !== 'object') return state;
            QUESTIONS.forEach(function (question) {
                const answer = value.answers && value.answers[question.id];
                if (OPTIONS.some(function (row) { return row[0] === answer; })) state.answers[question.id] = answer;
            });
            if (['intro', 'questions', 'results'].includes(value.view)) state.view = value.view;
            return state;
        }
        return {
            read: function () { if (memory) return clean(memory); try { return clean(JSON.parse(storage.getItem(STORAGE_KEY) || 'null')); } catch (_) { return empty(); } },
            save: function (state) { memory = null; try { storage.setItem(STORAGE_KEY, JSON.stringify(clean(state))); } catch (_) { memory = clean(state); } },
            clear: function () { memory = null; try { storage.removeItem(STORAGE_KEY); } catch (_) { /* nothing stored */ } }
        };
    }

    function mountAssessment(store) {
        return function (childRoot) {
            const doc = childRoot.ownerDocument;
            let state = store.read();
            function el(tag, className, text) { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
            function button(label, handler, secondary) {
                const node = el('button', 'dashboard-button' + (secondary ? ' dashboard-button-secondary' : ''), label);
                node.type = 'button'; node.addEventListener('click', handler); return node;
            }
            function answered() { return QUESTIONS.filter(function (question) { return state.answers[question.id]; }).length; }
            function show(view) { state.view = view; store.save(state); render(true); }
            function heading(text) { const node = el('h2', '', text); node.tabIndex = -1; return node; }
            function render(focus) {
                childRoot.replaceChildren();
                const section = el('section', 'dashboard-panel try-demo-assessment');
                const view = state.view === 'results' && !results(state.answers).complete ? 'questions' : state.view;
                const title = view === 'questions' ? renderQuestions(section) : view === 'results' ? renderResults(section) : renderIntro(section);
                childRoot.append(section);
                if (focus) title.focus();
            }
            function renderIntro(section) {
                const title = heading('Sample cyber security check');
                const count = answered();
                section.append(title, el('p', '', 'Six questions about the everyday IT at ' + BUSINESS + '. The full assessment goes further; this sample shows how answers become results and next actions.'),
                    el('p', 'dashboard-muted', 'Your answers stay in this browser. Nothing is sent to No Fries.'));
                const actions = el('div', 'ncsc-actions');
                actions.append(results(state.answers).complete ? button('View sample results', function () { show('results'); })
                    : button(count ? 'Continue the sample questions (' + count + ' of 6 answered)' : 'Start the sample questions', function () { show('questions'); }));
                section.append(actions);
                return title;
            }
            function renderQuestions(section) {
                const title = heading('Sample questions');
                const progress = el('p', 'dashboard-muted', ''); progress.setAttribute('role', 'status');
                const error = el('p', 'ncsc-inline-error', ''); error.setAttribute('role', 'alert'); error.hidden = true;
                const form = el('form', 'ncsc-questionnaire'); form.noValidate = true;
                function updateProgress() { progress.textContent = answered() + ' of 6 answered'; }
                AREAS.forEach(function (area, index) {
                    form.append(el('h3', '', area));
                    QUESTIONS.filter(function (question) { return question.area === index; }).forEach(function (question) {
                        const fieldset = el('fieldset', 'ncsc-answer'); fieldset.dataset.question = question.id;
                        fieldset.append(el('legend', '', question.text));
                        OPTIONS.forEach(function (option) {
                            const label = el('label', 'ncsc-option');
                            const input = el('input'); input.type = 'radio'; input.name = 'try-demo-' + question.id; input.value = option[0];
                            input.checked = state.answers[question.id] === option[0];
                            input.addEventListener('change', function () { state.answers[question.id] = option[0]; store.save(state); updateProgress(); error.hidden = true; });
                            label.append(input, el('span', '', option[1])); fieldset.append(label);
                        });
                        form.append(fieldset);
                    });
                });
                const submit = el('button', 'dashboard-button', 'See sample results'); submit.type = 'submit';
                const actions = el('div', 'ncsc-actions');
                actions.append(submit, button('Use example answers', function () { state.answers = Object.assign({}, EXAMPLE_ANSWERS); show('questions'); }, true),
                    button('Back', function () { show('intro'); }, true));
                form.append(error, actions);
                form.addEventListener('submit', function (event) {
                    event.preventDefault();
                    const missing = QUESTIONS.find(function (question) { return !state.answers[question.id]; });
                    if (!missing) { show('results'); return; }
                    error.textContent = 'Answer all six questions to see results. Next unanswered: ' + missing.text;
                    error.hidden = false;
                    const first = form.querySelector('[data-question="' + missing.id + '"]').querySelector('input');
                    if (first) first.focus();
                });
                updateProgress(); section.append(title, progress, form);
                return title;
            }
            function renderResults(section) {
                const outcome = results(state.answers);
                const title = heading('Sample results');
                section.append(title, el('p', '', 'Based on your answers for ' + BUSINESS + '.'),
                    el('p', 'dashboard-muted', 'An illustration only, not a security assessment, audit or certification.'));
                const metrics = el('div', 'ncsc-result-metrics');
                outcome.areas.forEach(function (area) {
                    const card = el('article', 'ncsc-result-metric');
                    card.append(el('h3', '', area.name), el('strong', 'ncsc-result-value', area.percent + '%'), el('p', '', area.label));
                    metrics.append(card);
                });
                const next = el('section', 'ncsc-results'); next.append(el('h3', '', 'Next actions'));
                if (!outcome.actions.length) next.append(el('p', '', 'No gaps in this sample. The full assessment checks more areas.'));
                else {
                    const list = el('ol', 'try-demo-actions-list');
                    outcome.actions.forEach(function (item) {
                        const row = el('li'); row.dataset.action = item.id;
                        const badge = el('span', 'dashboard-badge', item.priority + ' priority'); badge.dataset.priority = item.priority;
                        row.append(badge, el('p', '', item.action), el('p', 'dashboard-muted', item.owner + ' · ' + item.area));
                        list.append(row);
                    });
                    next.append(list);
                }
                const talk = el('a', 'dashboard-button', 'Talk to No Fries about your real IT'); talk.href = '/contact.html';
                const actions = el('div', 'ncsc-actions'); actions.append(talk, button('Change answers', function () { show('questions'); }, true));
                section.append(metrics, next, actions);
                return title;
            }
            render();
            return { destroy: function () { childRoot.replaceChildren(); },
                requestLeave: function (commit) { if (typeof commit === 'function') commit(); return Promise.resolve(true); } };
        };
    }

    function start(win) {
        const doc = win.document;
        const root = doc.getElementById('try-demo-dashboard');
        const status = doc.getElementById('try-demo-status');
        let storage = null; try { storage = win.localStorage; } catch (_) { storage = null; }
        const store = createStore(storage);
        function mountDashboard(route) { win.NoFriesDashboard.mount(root, projection(), { initialRoute: route, mountCyber: mountAssessment(store) }); }
        doc.getElementById('try-demo-reset').addEventListener('click', function () {
            store.clear();
            win.history.replaceState(null, '', win.location.pathname);
            mountDashboard('');
            status.textContent = (/^Demo reset\./.test(status.textContent) ? 'Demo reset again.' : 'Demo reset.') + ' Your sample answers were cleared.';
        });
        mountDashboard(null);
    }

    return Object.freeze({ STORAGE_KEY: STORAGE_KEY, BUSINESS: BUSINESS, QUESTIONS: QUESTIONS, EXAMPLE_ANSWERS: EXAMPLE_ANSWERS,
        projection: projection, results: results, createStore: createStore, mountAssessment: mountAssessment, start: start });
}));
