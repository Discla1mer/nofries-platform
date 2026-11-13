(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./ncscQuestionnaire'), require('./assessmentExplanation'));
    else root.NoFriesOrganisationPicture = factory(root.NoFriesNcscQuestionnaire, root.NoFriesAssessmentExplanation);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (questionnaire, explanation) {
    'use strict';
    const mounted = new WeakMap();
    const PROFILE_FIELDS = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
    let sequence = 0;
    // Bounded number of submitted results shown in the history. Each one is a
    // separate authorised read; nothing is cached across selections.
    const TREND_LIMIT = 5;
    const copy = value => JSON.parse(JSON.stringify(value));
    const displayDate = value => new Intl.DateTimeFormat('en-NZ', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Pacific/Auckland'
    }).format(new Date(value)) + ' NZ time';
    // "Your top three gaps": display-only over a result the validator already
    // accepted. No re-scoring and no model call. Fixed rule:
    //   1. A gap is a question saved as "no" (not in place) or "partial".
    //      Unknown and not-applicable answers are unresolved, not gaps.
    //   2. Higher existing profile weight first (the accepted profile weights
    //      every question 1, so this does not reorder today).
    //   3. "no" before "partial", matching the saved credit (0 before 1).
    //   4. Then accepted profile question order.
    const GAP_LIMIT = 3;
    const ENQUIRY_TIMEOUT_MS = 5000;
    const GAP_RANK = Object.freeze({ no: 0, partial: 1 });
    const GAP_WHY = 'This control helps lower the chance or impact of a cyber incident for your business.';
    const GAP_NEXT = 'Agree who will look at this control and when you will check it again.';
    const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim()) || null;
    function topGaps(result, metadata, limit = GAP_LIMIT) {
        if (!result || !Array.isArray(result.domains) || !metadata || !Array.isArray(metadata.questions)) return [];
        const rows = new Map();
        result.domains.forEach(domain => (domain.controls || []).forEach(control =>
            (control.questions || []).forEach(row => rows.set(row.itemId, row))));
        const controls = new Map((metadata.controls || []).map(control => [control.id, control]));
        return metadata.questions.map((question, position) => ({ question, position, row: rows.get(question.id) }))
            .filter(entry => entry.row && Object.hasOwn(GAP_RANK, entry.row.responseOptionId))
            .sort((a, b) => (b.row.weight || 0) - (a.row.weight || 0) ||
                GAP_RANK[a.row.responseOptionId] - GAP_RANK[b.row.responseOptionId] || a.position - b.position)
            .slice(0, limit)
            .map(({ question, row }) => {
                const control = controls.get(question.controlId), guidance = question.guidance || {};
                const plain = question.smallBusiness || {};
                const title = firstText(control && control.title, question.prompt);
                return { itemId: question.id, title: title.split(' — ').pop(), answer: row.answer,
                    responseOptionId: row.responseOptionId,
                    why: firstText(guidance.summary) || GAP_WHY,
                    next: firstText(plain.meaning, (guidance.startingActions || [])[0]) || GAP_NEXT };
            });
    }
    // "Actions" card: display-only over improvement/list responses the host
    // already read. Overdue uses the server's isOverdue; due-soon uses the same
    // UTC calendar day basis. Owner names come only from ownerLabel.
    const ACTION_LIMIT = 3, DUE_SOON_DAYS = 14;
    const DAY = /^\d{4}-\d\d-\d\d$/;
    function actionSummary(input) {
        if (!input || !Array.isArray(input.lists) || typeof input.more !== 'boolean') return null;
        let today = null; const rows = [];
        for (const list of input.lists) {
            if (!list || typeof list.asOf !== 'string' || !DAY.test(list.asOf.slice(0, 10)) || !Array.isArray(list.actions)) return null;
            if (today === null || list.asOf.slice(0, 10) < today) today = list.asOf.slice(0, 10);
            for (const action of list.actions) {
                if (!action || typeof action.actionId !== 'string' || typeof action.status !== 'string' ||
                    typeof action.isOverdue !== 'boolean' || action.isOverdue && action.dueDate === null || action.dueDate !== null && !(typeof action.dueDate === 'string' && DAY.test(action.dueDate)) ||
                    !action.rationale || typeof action.rationale.suggestedAction !== 'string' || !action.rationale.suggestedAction.trim() ||
                    Object.hasOwn(action, 'ownerLabel') && typeof action.ownerLabel !== 'string') return null;
                rows.push(action);
            }
        }
        const horizon = today && new Date(Date.parse(today + 'T00:00:00.000Z') + DUE_SOON_DAYS * 86400000).toISOString().slice(0, 10);
        const byDue = (a, b) => a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0;
        const item = action => ({ title: action.rationale.suggestedAction, dueDate: action.dueDate,
            owner: Object.hasOwn(action, 'ownerLabel') && action.ownerLabel.trim() ? action.ownerLabel : null });
        const overdue = rows.filter(action => action.isOverdue).sort(byDue);
        const dueSoon = rows.filter(action => !action.isOverdue && action.status !== 'completed' && action.dueDate !== null &&
            action.dueDate >= today && action.dueDate <= horizon).sort(byDue);
        return { total: rows.length, more: input.more,
            overdue: { count: overdue.length, items: overdue.slice(0, ACTION_LIMIT).map(item) },
            dueSoon: { count: dueSoon.length, items: dueSoon.slice(0, ACTION_LIMIT).map(item) } };
    }
    const displayDay = value => new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeZone: 'UTC' })
        .format(new Date(value + 'T00:00:00.000Z'));
    function sameProfile(actual, expected) {
        return actual && expected && Object.keys(expected).every(key => actual[key] === expected[key]);
    }

    // Read-only presentation over the existing authorised client. A score is
    // displayed only after the submitted-result validator accepts the complete
    // organisation/profile/revision binding. Never score drafts or uploaded files.
    function mount(root, options) {
        if (!root || !root.ownerDocument || !options || !options.client ||
            typeof options.client.list !== 'function' || typeof options.client.read !== 'function' ||
            !options.metadata || typeof options.organisationId !== 'string' || !options.organisationId ||
            !questionnaire || typeof questionnaire.resultModel !== 'function') throw new Error('picture_composition_required');
        if (mounted.has(root)) mounted.get(root).destroy();
        const doc = root.ownerDocument, client = options.client, metadata = copy(options.metadata);
        const organisationId = options.organisationId, organisationName = options.displayName || organisationId;
        const openImprovement = typeof options.openImprovement === 'function' ? options.openImprovement : null;
        const planGap = typeof options.planGap === 'function' ? options.planGap : null;
        const readActions = openImprovement && typeof options.readActions === 'function' ? options.readActions : null;
        let actions = null;
        const id = 'picture-assessment-' + (++sequence);
        const initialAssessmentId = typeof options.initialAssessmentId === 'string' ? options.initialAssessmentId : null;
        let disposed = false, epoch = 0, requests = new Set(), rows = [], after = null, allowance = null;
        let selected = initialAssessmentId || '', detail = null, loading = false, message = '', denied = false;
        let loaded = false, retry = null, explanationController = null;
        let trend = null;
        let gapPlan = null;
        function live(token) { return !disposed && (token === undefined || token === epoch); }
        function node(tag, cls, text) {
            const value = doc.createElement(tag); if (cls) value.className = cls;
            if (text !== undefined) value.textContent = String(text); return value;
        }
        function button(label, action) {
            const control = node('button', 'dashboard-button', label); control.type = 'button';
            control.addEventListener('click', () => { if (live() && !denied) action(); }); return control;
        }
        function openSavedAssessment(label) {
            const target = detail.assessmentId, token = epoch;
            return button(label, () => {
                if (live(token) && !loading && detail && detail.assessmentId === target) options.openCyber(target);
            });
        }
        function sourceBinding() {
            return JSON.stringify([detail.assessmentId, detail.revision, detail.revisionSha256,
                detail.profileRef, detail.submission.evaluation.outputSha256]);
        }
        function currentSubmitted(token, binding, control) {
            let ancestor = control;
            while (ancestor && ancestor !== root) ancestor = ancestor.parentElement;
            return live(token) && !loading && !denied && ancestor === root && detail && detail.status === 'submitted'
                && detail.assessmentId === selected && sourceBinding() === binding
                && questionnaire.resultModel(detail, metadata, organisationId) !== null;
        }
        function improvementSelection() {
            if (!detail || detail.status !== 'submitted' || detail.assessmentId !== selected ||
                !questionnaire.resultModel(detail, metadata, organisationId) ||
                !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(detail.assessmentId) ||
                !Number.isSafeInteger(detail.revision) || detail.revision < 0 || detail.revision > 128 ||
                typeof detail.revisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(detail.revisionSha256) ||
                Object.keys(detail.profileRef).length !== PROFILE_FIELDS.length) return null;
            const profileRef = Object.freeze(Object.fromEntries(PROFILE_FIELDS.map(key => [key, detail.profileRef[key]])));
            return Object.freeze({ assessmentId: detail.assessmentId, revision: detail.revision,
                revisionSha256: detail.revisionSha256, profileRef, outputSha256: detail.submission.evaluation.outputSha256 });
        }
        function captureFocus() {
            const active = doc.activeElement;
            if (active === root.querySelector('select')) return { key: 'select', element: active };
            const control = Array.from(root.querySelectorAll('button')).find(value => value === active);
            return control ? { key: control.textContent, element: control } : null;
        }
        // True when the user moved focus away from `element` (to anything but the page body) during a read.
        function focusMoved(element) {
            return !!doc.activeElement && doc.activeElement !== element && doc.activeElement.tagName !== 'BODY';
        }
        function restoreFocus(saved) {
            if (!saved || !live() || denied) return;
            // Do not steal focus if the user moved it elsewhere during the read.
            if (focusMoved(saved.element)) return;
            const control = saved.key === 'select' ? root.querySelector('select') :
                Array.from(root.querySelectorAll('button')).find(value => value.textContent === saved.key) || root.querySelector('select');
            if (control && !control.disabled) control.focus();
        }
        function clearExplanation() {
            if (explanationController) { explanationController.destroy(); explanationController = null; }
        }
        function abort() { clearExplanation(); requests.forEach(request => request.abort()); requests.clear(); }
        async function call(method, input, token) {
            const request = new AbortController(); requests.add(request);
            try {
                const result = method === 'list' ? await client.list(Object.assign({}, input, { signal: request.signal }))
                    : await client[method](input, { signal: request.signal });
                return live(token) ? result : null;
            } finally { requests.delete(request); }
        }
        function refused(error) { return [401, 403].includes(error && (error.status || error.statusCode)); }
        function failure(error, retryRequest) {
            detail = null; retry = retryRequest;
            if (refused(error)) {
                denied = true; rows = []; selected = ''; after = null; retry = null;
                message = 'This organisation picture is unavailable. Reopen your authenticated dashboard.';
            } else message = 'The saved assessment could not be confirmed. Retry to load a fresh picture.';
        }
        function sourceDetails() {
            const provenance = node('details', 'ncsc-result-provenance');
            provenance.append(node('summary', '', 'Source and calculation details'));
            const dl = node('dl');
            const facts = [['Organisation name', organisationName], ['Saved at', detail.updatedAt],
                ['Saved status', detail.status], ['Saved revision', String(detail.revision)],
                ['Framework', metadata.title], ['Profile version', metadata.profileRef.profileVersion],
                ['Organisation', organisationId], ['Assessment', detail.assessmentId]];
            facts.forEach(pair => dl.append(node('dt', '', pair[0]), node('dd', '', pair[1])));
            provenance.append(dl,
                node('p', '', 'Refresh reloads saved assessments. It does not check whether answers still reflect the organisation today.'),
                node('p', '', after !== null
                    ? 'More assessments are available. Showing one selected record; this list is not a complete organisation history.'
                    : 'Each assessment keeps its own scope and date. Scores from different scopes are not combined.'));
            return provenance;
        }
        function renderResume() {
            const draft = node('section', 'picture-empty picture-resume');
            const heading = node('div', 'picture-resume-heading');
            heading.append(node('h3', '', detail.progress.answered > 0 ? 'In progress' : 'Not started'));
            if (typeof options.openCyber === 'function') heading.append(openSavedAssessment('Continue saved assessment'));
            const saved = node('p', 'picture-large', detail.progress.answered + ' / ' + detail.progress.total + ' responses saved');
            const progress = node('progress', 'ncsc-saved-progress');
            progress.max = detail.progress.total; progress.value = detail.progress.answered;
            progress.setAttribute('aria-label', 'Saved responses');
            const scope = node('section', 'picture-scope');
            scope.append(node('h3', '', 'Scope'), node('p', 'ncsc-preserve-text', detail.scopePopulation.description), node('p', 'dashboard-muted', 'Scope is fixed when an assessment starts. If it is wrong, start a new assessment with the corrected scope.'));
            draft.append(heading, saved, progress, scope,
                node('p', 'dashboard-muted', 'Saved progress is not a score. Submit this assessment when it is ready; unknown answers remain visible as uncertainty.'));
            root.append(draft);
        }
        function render() { paint(); placeActions(); }
        // Optional and isolated: a failed or invalid read leaves no card and
        // never changes the assessment picture below it.
        function placeActions() {
            const previous = root.querySelector('.picture-actions'); if (previous) previous.remove();
            // Before any submitted result there is nothing to act on yet.
            if (!live() || denied || !actions || !actions.total && !rows.some(row => row.status === 'submitted')) return;
            const card = node('section', 'picture-actions'), heading = node('h3', '', 'Actions');
            heading.id = id + '-actions'; card.setAttribute('aria-labelledby', heading.id); card.append(heading);
            const gaps = root.querySelector('.picture-top-gaps');
            if (!actions.total) {
                const empty = node('p', 'picture-actions-empty', 'No actions yet. ');
                if (gaps) {
                    const link = node('a', '', 'Start with your top three gaps.'); link.href = '#' + id + '-top-gaps';
                    link.addEventListener('click', event => {
                        event.preventDefault();
                        const target = root.querySelector('.picture-top-gaps'), title = target && target.querySelector('h3');
                        if (!live() || !title) return;
                        if (typeof title.scrollIntoView === 'function') title.scrollIntoView({ block: 'start' });
                        title.focus();
                    });
                    empty.append(link);
                } else empty.append(node('span', '', 'Start with your top three gaps.'));
                card.append(empty); root.prepend(card); return;
            }
            [['Overdue', actions.overdue], ['Due in the next 14 days', actions.dueSoon]].forEach(([label, group]) => {
                card.append(node('h4', '', label + ' (' + group.count + ')'));
                if (!group.items.length) return;
                const list = node('ul', 'picture-actions-list');
                group.items.forEach(entry => {
                    const row = node('li', 'picture-action');
                    row.append(node('span', 'picture-action-title', entry.title),
                        node('span', 'picture-action-meta dashboard-muted', 'Due ' + displayDay(entry.dueDate) +
                            (entry.owner ? ' · Owner: ' + entry.owner : '')));
                    list.append(row);
                });
                card.append(list);
            });
            if (actions.more) card.append(node('p', 'dashboard-muted', 'Counts cover the first five saved plans.'));
            const full = node('a', 'picture-actions-plan', 'View the full plan'); full.href = '#improvement-plan';
            full.addEventListener('click', event => { event.preventDefault(); if (live() && !denied) openImprovement(); });
            card.append(full); root.prepend(card);
        }
        function paint() {
            if (!live()) return;
            clearExplanation();
            root.replaceChildren(); root.classList.add('organisation-picture');
            const isEmpty = !loading && !rows.length && loaded && !message && !selected && after === null;
            if (!isEmpty) {
                const header = node('header', 'picture-heading');
                header.append(node('h2', '', 'Cyber baseline'),
                    node('p', 'dashboard-muted', 'A saved assessment of the selected scope, not a live check of connected systems.'));
                root.append(header);
            }
            const status = node('p', 'picture-status', message || (loading ? 'Loading saved assessment…' : ''));
            status.setAttribute('role', 'status'); status.hidden = !message && !loading; root.append(status);
            if (denied) return;
            function appendAllowance() {
                if (!allowance) return;
                // Plan usage in plain English, so the limit is known before starting work.
                const exhausted = allowance.used >= allowance.limit;
                const usage = node('p', exhausted ? 'ncsc-warning picture-allowance' : 'dashboard-muted picture-allowance',
                    (allowance.limit === 0 ? 'Your plan does not include assessment submissions. You can still read your saved assessments. '
                        : allowance.used + ' of ' + allowance.limit + ' assessment ' + (allowance.limit === 1 ? 'submission' : 'submissions') + ' used on your plan.' +
                        (exhausted ? ' You can still read your saved assessments, but you cannot submit another assessment. ' : '')));
                if (exhausted) { const contact = node('a', '', 'Contact No Fries about more submissions'); contact.href = '/contact.html'; usage.append(contact); }
                root.append(usage);
            }
            if (!isEmpty) appendAllowance();
            if (detail && detail.status !== 'submitted') renderResume();
            if (rows.length) {
                const toolbar = node('div', 'picture-toolbar');
                const label = node('label', '', 'Saved assessment'); label.htmlFor = id;
                const picker = node('select'); picker.id = id; picker.disabled = loading;
                const pictureStatus = row => {
                    if (row.status === 'submitted') return 'Submitted';
                    const answered = row.progress && Number.isFinite(row.progress.answered) ? row.progress.answered : null;
                    if (answered === null) return row.status === 'created' ? 'Not started' : 'In progress';
                    return answered > 0 ? 'In progress' : 'Not started';
                };
                const labelFor = row => (row.scopePopulation ? row.scopePopulation.description + ' · ' : '') +
                    pictureStatus(row) + ' · ' + displayDate(row.updatedAt);
                const labelCounts = new Map(), referenceCounts = new Map();
                rows.forEach(row => {
                    const label = labelFor(row), key = JSON.stringify([label, row.assessmentId.slice(0, 8)]);
                    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
                    referenceCounts.set(key, (referenceCounts.get(key) || 0) + 1);
                });
                rows.forEach(row => {
                    const label = labelFor(row), reference = row.assessmentId.slice(0, 8);
                    const duplicate = labelCounts.get(label) > 1;
                    const ambiguous = referenceCounts.get(JSON.stringify([label, reference])) > 1;
                    const suffix = duplicate ? ' · ' + (ambiguous ? row.assessmentId
                        : reference + (row.assessmentId.length > 8 ? '…' : '')) : '';
                    const item = node('option', '', label + suffix);
                    item.value = row.assessmentId; picker.append(item);
                });
                picker.value = selected;
                picker.addEventListener('change', () => { if (live() && !denied) read(picker.value, 'user'); });
                const refresh = button('Refresh', () => load(false)); refresh.disabled = loading;
                refresh.classList.add('dashboard-button-secondary');
                toolbar.append(label, picker, refresh);
                if (after !== null) { const more = button('Load more', () => load(true)); more.disabled = loading; more.classList.add('dashboard-button-secondary'); toolbar.append(more); }
                root.append(toolbar);
                if (after !== null) root.append(node('p', 'dashboard-muted', 'More saved assessments are available. Load more to see them.'));
                if (!detail) root.append(node('p', 'dashboard-muted', 'Refresh reloads saved assessments. It does not check whether answers still reflect the organisation today.'));
            }
            if (isEmpty) {
                // A new organisation leads with one plain action, before any detail.
                const empty = node('section', 'picture-first-use');
                empty.append(node('p', 'picture-first-use-eyebrow', 'Welcome to No Fries'),
                    node('h2', '', 'Start your cyber check'),
                    node('p', 'picture-first-use-intro', 'No saved assessments yet. Answer questions about your business to see where you stand and what to fix first.'));
                if (typeof options.openCyber === 'function') {
                    const token = epoch;
                    const action = button('Start your cyber check', () => {
                        if (live(token) && !loading && !message && !rows.length && !selected && after === null &&
                            action.parentElement === empty && empty.parentElement === root) options.openCyber(undefined, { startNew: true });
                    });
                    action.classList.add('picture-first-use-action'); empty.append(action);
                }
                const steps = node('ol', 'picture-first-use-steps'); steps.setAttribute('role', 'list');
                [
                    ['Answer the questions', 'Tell us what is in place for the part of your business you choose.'],
                    ['See your results', 'Submit your answers to see where you stand.'],
                    ['Fix the gaps', 'Get your top three gaps and plan what to do next.']
                ].forEach((step, index) => {
                    const item = node('li', 'picture-first-use-step');
                    const number = node('span', 'picture-first-use-number', String(index + 1));
                    number.setAttribute('aria-hidden', 'true');
                    const content = node('div');
                    content.append(node('h3', '', step[0]), node('p', '', step[1]));
                    item.append(number, content); steps.append(item);
                });
                empty.append(steps);
                root.append(empty);
                appendAllowance();
            }
            if (message && !loading) root.append(button('Retry', () => { if (retry) retry(); }));
            if (!detail) return;
            const facts = node('p', 'picture-source', (detail.status === 'submitted' ? 'Submitted ' : 'Saved ') +
                displayDate(detail.updatedAt));
            root.append(facts);
            if (detail.status !== 'submitted') {
                root.append(sourceDetails()); return;
            }
            const scope = node('section', 'picture-scope');
            scope.append(node('h3', '', 'Scope'), node('p', 'ncsc-preserve-text', detail.scopePopulation.description), node('p', 'dashboard-muted', 'Scope is fixed when an assessment starts. If it is wrong, start a new assessment with the corrected scope.')); root.append(scope);
            const result = questionnaire.resultModel(detail, metadata, organisationId);
            if (!result) { root.append(node('p', 'ncsc-warning', 'Results are unavailable for this saved submission. No score has been inferred.'), sourceDetails()); return; }
            if (typeof options.openCyber === 'function') root.append(openSavedAssessment('View saved assessment'));
            if (openImprovement && improvementSelection()) {
                const token = epoch, binding = sourceBinding();
                const action = button('Plan improvements for this assessment', () => {
                    if (!currentSubmitted(token, binding, action)) return;
                    const selection = improvementSelection();
                    if (selection) openImprovement(selection);
                });
                root.append(action);
            }
            renderResult(result);
            if (explanation && typeof explanation.mount === 'function') {
                const child = node('section', 'picture-explanation ncsc-results'); root.append(child);
                // The explanation is optional. If it cannot start, keep the
                // results above it and say so plainly instead of blanking the page.
                try { explanationController = explanation.mount(child, { client, metadata, organisationId,
                    resultModel: questionnaire.resultModel, assessment: {
                        assessmentId: detail.assessmentId, revision: detail.revision, revisionSha256: detail.revisionSha256,
                        status: detail.status, profileRef: detail.profileRef, updatedAt: detail.updatedAt
                    },
                    onDenied() {
                        if (!live()) return;
                        abort(); epoch++;
                        failure({ statusCode: 403 }, null); render();
                    } });
                } catch (_error) {
                    explanationController = null;
                    child.replaceChildren(node('p', 'ncsc-warning', 'The explanation is unavailable right now. Your results above are unchanged.'));
                }
            }
        }
        const newestFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assessmentId.localeCompare(b.assessmentId);
        // Display-only view over results the validator already accepted. The
        // contract pins the profile and included question set, but contains no
        // evidence that two declarations cover the same real-world population.
        // Neither equal descriptions nor record-bound scope hashes establish it.
        function trendPoint(value, result) {
            return { assessmentId: value.assessmentId, submittedAt: value.updatedAt, scope: value.scopePopulation.description,
                attainment: result.attainment, total: result.total,
                answered: new Set(result.domains.flatMap(domain => domain.controls.flatMap(control => control.questions))
                    .filter(question => ['yes', 'partial', 'no'].includes(question.responseOptionId)).map(question => question.itemId)),
                domains: result.domains.map(domain => ({ title: domain.title, attainment: domain.attainment })) };
        }
        function trendSection(result) {
            const section = node('section', 'picture-trend'), key = epoch + ':' + detail.assessmentId;
            if (trend && trend.key === key) { trend.section = section; paintTrend(); return section; }
            // Order the loaded submitted results by saved time, never by list position:
            // the list pages by assessment ID, so an unloaded page can hold any date.
            const ordered = rows.filter(row => row.status === 'submitted' && row.assessmentId !== detail.assessmentId)
                .concat([{ assessmentId: detail.assessmentId, updatedAt: detail.updatedAt }]).sort(newestFirst);
            const index = ordered.findIndex(row => row.assessmentId === detail.assessmentId);
            const start = Math.max(0, index + 2 - TREND_LIMIT), shown = ordered.slice(start, start + TREND_LIMIT);
            const state = trend = { key, section, status: 'ready', total: ordered.length, order: shown.map(row => row.assessmentId),
                previousId: ordered[index + 1] ? ordered[index + 1].assessmentId : null,
                points: new Map([[detail.assessmentId, trendPoint(detail, result)]]) };
            state.reads = shown.filter(row => row.assessmentId !== detail.assessmentId);
            if (state.reads.length) state.status = 'idle';
            paintTrend(); return section;
        }
        // Earlier results are read only when asked: each read is a fresh,
        // authorised and audited request, and nothing is cached between views.
        function compareTrend(state, token, control) {
            if (!live(token) || loading || denied || trend !== state || state.status !== 'idle' ||
                !control || control.parentElement !== state.section || !root.contains(state.section)) return;
            state.status = 'loading'; paintTrend();
            // Settle every read so a refusal is never hidden behind an earlier failure.
            Promise.allSettled(state.reads.map(async row => {
                const response = await call('read', row.assessmentId, token);
                const value = response && response.assessment;
                if (!value || value.assessmentId !== row.assessmentId || value.moduleId !== metadata.moduleId ||
                    !sameProfile(value.profileRef, metadata.profileRef)) return;
                const earlier = questionnaire.resultModel(value, metadata, organisationId);
                if (earlier) state.points.set(value.assessmentId, trendPoint(value, earlier));
            })).then(results => {
                if (!live(token) || trend !== state) return;
                const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
                if (errors.some(refused)) {
                    abort(); epoch++; failure({ statusCode: 403 }, null); render(); return;
                }
                if (errors.length) { state.status = 'failed'; paintTrend(); return; }
                state.status = 'ready'; const heading = paintTrend();
                // The Compare button is replaced; keep keyboard users in this section,
                // but only if focus was lost with it, not moved elsewhere by the user.
                if (!focusMoved(control)) heading.focus();
            });
        }
        function paintTrend() {
            const section = trend.section, current = trend.points.get(detail.assessmentId);
            const heading = node('h3', '', 'Change over time'); heading.tabIndex = -1;
            section.replaceChildren(heading);
            if (trend.status === 'idle') {
                const others = trend.reads.length, state = trend, token = epoch;
                section.append(node('p', '', (others === 1 ? 'There is 1 other submitted assessment.'
                    : 'There are ' + others + ' other submitted assessments.') + ' Compare saved results and answer coverage.'));
                const action = button(trend.previousId ? (after !== null ? 'Compare with an earlier assessment'
                    : 'Compare with previous assessment') : 'Compare with later assessments',
                    () => compareTrend(state, token, action));
                action.classList.add('dashboard-button-secondary'); section.append(action); return heading;
            }
            if (trend.status === 'loading') {
                const status = node('p', 'dashboard-muted', 'Loading earlier submitted results…');
                status.setAttribute('role', 'status'); section.append(status); return heading;
            }
            if (trend.status === 'failed') {
                section.append(node('p', 'dashboard-muted', 'Earlier results could not be loaded, so no change is shown. Refresh to try again.')); return heading;
            }
            if (trend.total === 1) {
                section.append(node('p', '', 'This is the only submitted assessment so far. Another submitted assessment is needed to compare saved results and answer coverage.'));
                if (after !== null) section.append(node('p', 'dashboard-muted', 'Other saved assessments may not be loaded yet. Load more to include them.'));
                return heading;
            }
            const previous = trend.previousId && trend.points.get(trend.previousId);
            // While pages remain unloaded, an unseen submission may fall between
            // these two, so do not call the comparison "the previous assessment".
            const incomplete = after !== null, earlier = incomplete ? 'Earlier' : 'Previous';
            if (!trend.previousId) section.append(node('p', '', 'This is the earliest submitted assessment shown, so there is nothing earlier to compare it with. Choose a later assessment to compare saved results and answer coverage.'));
            else if (!previous) section.append(node('p', '', (incomplete ? 'The earlier' : 'The previous') + ' assessment\'s results could not be shown, so no change is shown.'));
            else {
                section.append(node('p', '', incomplete
                    ? 'Compared with the most recent earlier assessment loaded so far, submitted ' + displayDate(previous.submittedAt) +
                        '. Other saved assessments are not loaded yet, so there may be one in between. Load more to check.'
                    : 'Compared with the previous assessment, submitted ' + displayDate(previous.submittedAt) + '.'));
                const shared = [...previous.answered].filter(itemId => current.answered.has(itemId)).length;
                const sameCoverage = previous.total === current.total && shared === previous.answered.size && shared === current.answered.size;
                section.append(node('p', 'picture-trend-coverage', 'Question coverage: ' + earlier + ' ' +
                    previous.answered.size + ' of ' + previous.total + '; selected ' + current.answered.size + ' of ' + current.total +
                    ' answered Yes, Partial or No. ' + shared + ' questions have one of these answers in both. Unknown and unapproved N/A answers remain unresolved.'));
                section.append(node('p', 'ncsc-warning', 'Not comparable as improvement or decline: ' +
                    (previous.scope !== current.scope ? 'the saved scope declarations differ.'
                        : 'matching saved scope descriptions do not establish the same real-world population.') +
                    (!sameCoverage ? ' The set of questions answered Yes, Partial or No also differs.' : '') +
                    ' Saved ranges are shown separately; no change is calculated.'));
                const table = node('table', 'picture-trend-table');
                table.append(node('caption', '', 'Reported implementation, ' + earlier.toLowerCase() + ' and selected'));
                const head = node('thead'), headRow = node('tr');
                ['Area', earlier, 'Selected'].forEach(label => { const cell = node('th', '', label); cell.setAttribute('scope', 'col'); headRow.append(cell); });
                head.append(headRow);
                const body = node('tbody');
                const line = (label, before, now) => {
                    const row = node('tr'), title = node('th', '', label); title.setAttribute('scope', 'row');
                    row.append(title, node('td', '', before.attainment), node('td', '', now.attainment));
                    body.append(row);
                };
                line('Overall', previous, current);
                current.domains.forEach((domain, position) => line(domain.title, previous.domains[position], domain));
                table.append(head, body); section.append(table,
                    node('p', 'dashboard-muted', 'Both saved results use the accepted profile and included question weights. Shared question coverage is not proof of equivalent scope, control effectiveness or a risk trend. Unknown answers and unapproved N/A still contribute to the upper bound; no subset is re-scored.'));
            }
            section.append(node('h4', '', 'Submitted assessments'));
            const list = node('ol', 'picture-trend-history');
            trend.order.forEach(assessmentId => {
                const point = trend.points.get(assessmentId), row = rows.find(item => item.assessmentId === assessmentId);
                const item = node('li', '', point ? displayDate(point.submittedAt) + ' · ' + point.attainment + ' reported implementation · ' + point.scope
                    : displayDate(row.updatedAt) + ' · Result unavailable');
                if (assessmentId === detail.assessmentId) { item.append(node('strong', '', '(shown above)')); item.setAttribute('aria-current', 'true'); }
                list.append(item);
            });
            section.append(list);
            if (trend.order.length < trend.total || after !== null) section.append(node('p', 'dashboard-muted',
                'Showing ' + trend.order.length + ' of ' + trend.total + ' loaded submitted assessments, newest first.' + (after !== null ? ' Other saved assessments are not loaded yet and may be from any date. Load more to include them.' : '')));
            return heading;
        }
        function gapSection(result) {
            const gaps = topGaps(result, metadata), section = node('section', 'picture-top-gaps');
            const heading = node('h3', '', gaps.length === GAP_LIMIT ? 'Your top three gaps' : 'Your top gaps');
            heading.id = id + '-top-gaps'; heading.tabIndex = -1; section.setAttribute('aria-labelledby', heading.id); section.append(heading);
            if (!gaps.length) {
                section.append(node('p', '', 'You did not report any controls as not in place or partly in place.'));
                if (result.unknown > 0) section.append(node('p', 'dashboard-muted', result.unknown + (result.unknown === 1 ? ' answer is' : ' answers are') +
                    ' still unknown or to confirm. Confirm ' + (result.unknown === 1 ? 'it' : 'them') + ' to check for gaps.'));
                return section;
            }
            section.append(node('p', 'dashboard-muted', 'Chosen by a fixed rule from your saved answers. Controls not in place come first, then partly in place, then in NCSC framework order.'));
            const list = node('ol', 'picture-top-gaps-list');
            gaps.forEach(gap => {
                const item = node('li', 'picture-top-gap'); item.dataset.gapItem = gap.itemId;
                const why = node('p'), next = node('p');
                why.append(node('strong', '', 'Why it matters: '), node('span', '', gap.why));
                next.append(node('strong', '', 'What to do next: '), node('span', '', gap.next));
                const ownerStart = /^NF-NCSC-MCSS-(RM|SA|AI|RP)-01-Q1$|^NF-NCSC-CC-SV-01-Q1$/.test(gap.itemId);
                item.append(node('h4', '', gap.title), node('p', 'dashboard-muted', 'Your answer: ' + gap.answer),
                    node('p', 'picture-gap-owner', ownerStart ? 'You can start this with your team.' : 'Ask your IT provider to help with this.'), why, next);
                if (planGap && improvementSelection()) item.append(...gapPlanControls(gap));
                list.append(item);
            });
            section.append(list, helpPanel()); return section;
        }
        // Information needs are saved answers, not unanswered questions or a
        // risk ranking. Reuse the existing plan handoff without creating a plan.
        function informationSection(result) {
            const section = node('section', 'picture-information');
            const heading = node('h3', '', 'Information to confirm');
            heading.id = id + '-information'; section.setAttribute('aria-labelledby', heading.id);
            section.append(heading);
            const indexed = new Map(result.domains.flatMap(domain => domain.controls.flatMap(control =>
                control.questions.map(question => [question.itemId, question]))));
            const questions = metadata.questions.map(question => indexed.get(question.id))
                .filter(question => ['unknown', 'not_applicable'].includes(question.responseOptionId));
            const unknown = questions.filter(question => question.responseOptionId === 'unknown').length;
            const pending = questions.length - unknown;
            section.append(node('p', '', unknown + ' saved Unknown ' + (unknown === 1 ? 'answer' : 'answers') +
                ' · ' + pending + ' saved Not applicable ' + (pending === 1 ? 'answer' : 'answers') + ' awaiting review.'),
                node('p', 'dashboard-muted', 'These are saved answers to confirm, not unanswered questions or a risk score.'));
            if (!questions.length) {
                section.append(node('p', '', 'No information requests are suggested by these saved answers. This does not verify that controls are effective.'));
                return section;
            }
            const list = node('ul', 'picture-information-list');
            questions.forEach(question => {
                const item = node('li');
                item.append(node('h4', '', question.prompt), node('p', '', question.responseOptionId === 'unknown'
                    ? 'Saved answer: Unknown. Find out what is in place.'
                    : 'Saved answer: Not applicable, awaiting review. Confirm whether this applies to the assessment scope.'));
                list.append(item);
            });
            section.append(list);
            if (openImprovement && improvementSelection()) {
                const token = epoch, binding = sourceBinding();
                const action = button('Open plan for information requests', () => {
                    if (!currentSubmitted(token, binding, action)) return;
                    const selection = improvementSelection(); if (selection) openImprovement(selection);
                });
                section.append(node('p', 'dashboard-muted', 'Opening the plan creates or sends nothing. An authorised editor must choose Create improvement plan for this assessment to save requests. This may also create other recommended actions.'), action,
                    node('p', 'dashboard-muted', 'Use the plan to agree who will find the information and when. Completing an action does not approve a Not applicable answer, verify a control or change assessment scores.'));
            } else section.append(node('p', 'dashboard-muted', 'This view only lists information needs. Use the questions above to agree who will find the information and when to review it. No requests have been created or sent.'));
            return section;
        }
        // "Plan this" asks the host to open the improvement editor at this gap's
        // action, creating the plan for this exact submitted revision only if
        // none exists. One attempt at a time; a failure leaves Overview as it is.
        const GAP_PLAN_TEXT = Object.freeze({ opening: 'Opening plan…', failed: 'Couldn\'t open the plan. Try again.' });
        function paintGapPlan(attempt) {
            const view = attempt.view; if (!view) return;
            view.status.textContent = GAP_PLAN_TEXT[attempt.status] || ''; view.status.hidden = !GAP_PLAN_TEXT[attempt.status];
            view.action.disabled = attempt.status === 'opening';
        }
        function gapPlanControls(gap) {
            const token = epoch, binding = sourceBinding();
            const status = node('p', 'picture-gap-plan-status'); status.setAttribute('role', 'status'); status.hidden = true;
            const action = button('Plan this', () => {
                if (gapPlan && gapPlan.token === epoch && gapPlan.status === 'opening' || !currentSubmitted(token, binding, action)) return;
                const selection = improvementSelection(); if (!selection) return;
                const attempt = gapPlan = { token, binding, itemId: gap.itemId, status: 'opening', view: { action, status } };
                paintGapPlan(attempt);
                // A different selection, refresh or denial makes the attempt stale:
                // the host stops before creating or opening, and nothing is shown.
                const stillCurrent = () => gapPlan === attempt && live(token) && !denied;
                const settle = opened => {
                    if (!stillCurrent()) { if (gapPlan === attempt) gapPlan = null; return; }
                    if (opened === true) gapPlan = null;
                    attempt.status = opened === true ? '' : 'failed'; paintGapPlan(attempt);
                };
                Promise.resolve().then(() => planGap(selection, gap.itemId, stillCurrent)).then(settle, () => settle(false));
            });
            action.classList.add('picture-gap-plan'); action.setAttribute('aria-label', 'Plan this: ' + gap.title);
            if (gapPlan && gapPlan.token === token && gapPlan.binding === binding && gapPlan.itemId === gap.itemId) { gapPlan.view = { action, status }; paintGapPlan(gapPlan); }
            return [action, status];
        }
        // Copy or print reuses the results view's summary and copy behaviour.
        // The help link shows only when the public enquiry status says
        // enquiries are open. Nothing leaves the page: no share link is made.
        function helpPanel() {
            const panel = node('div', 'picture-next-steps'), token = epoch;
            panel.append(node('h4', '', 'Next step'));
            if (typeof questionnaire.providerSummary === 'function' && typeof questionnaire.copySummary === 'function') panel.append(summaryHandoff());
            const help = node('div', 'picture-next-steps-help'); help.hidden = true;
            const link = node('a', 'dashboard-button', 'Get help closing these gaps'); link.href = '/contact.html';
            help.append(node('p', 'dashboard-muted', 'Talk to No Fries about these gaps. The contact form does not include your answers.'), link);
            panel.append(help);
            enquiryAvailable().then(available => { if (available && live(token)) help.hidden = false; });
            return panel;
        }
        function summaryHandoff() {
            const win = doc.defaultView, handoff = node('details', 'picture-summary');
            handoff.append(node('summary', '', 'Copy or print this summary'));
            const label = node('label', '', 'Copy this summary into an email or document');
            const input = node('textarea', 'ncsc-textarea'); input.id = id + '-summary'; label.htmlFor = input.id;
            input.readOnly = true; input.rows = 8; input.value = questionnaire.providerSummary(detail, metadata).text;
            // The field scrolls on screen, so paper gets the full text instead.
            const printed = node('pre', 'picture-summary-print', input.value); printed.setAttribute('aria-hidden', 'true');
            const status = node('p', 'dashboard-muted'); status.setAttribute('role', 'status');
            const copyButton = button('Copy summary', () => questionnaire.copySummary(win, input, status));
            copyButton.classList.add('dashboard-button-secondary'); handoff.append(label, input, printed, copyButton);
            if (win && typeof win.print === 'function') {
                const printButton = button('Print these results', () => win.print());
                printButton.classList.add('dashboard-button-secondary'); handoff.append(printButton);
            }
            handoff.append(status); return handoff;
        }
        // Mirrors js/enquiry-availability.js: a bare read-only GET of the public
        // enquiry status. Any error, non-OK reply or 5-second timeout is unavailable.
        async function enquiryAvailable() {
            const win = doc.defaultView;
            if (!win || typeof win.fetch !== 'function' || typeof win.AbortController !== 'function') return false;
            const controller = new win.AbortController();
            let timer;
            try {
                const deadline = new Promise((_, reject) => {
                    timer = setTimeout(() => { controller.abort(); reject(new Error('unavailable')); }, ENQUIRY_TIMEOUT_MS);
                });
                const read = (async () => {
                    const response = await win.fetch('/api/enquiry', { method: 'GET', credentials: 'same-origin', cache: 'no-store',
                        signal: controller.signal, headers: { Accept: 'application/json' } });
                    if (!response || !response.ok) return false;
                    const body = await response.json();
                    return !!body && body.available === true;
                })();
                return await Promise.race([read, deadline]);
            } catch (_) {
                return false;
            } finally {
                clearTimeout(timer); controller.abort();
            }
        }
        function renderResult(result) {
            root.append(gapSection(result));
            const metrics = node('div', 'picture-metrics');
            function metric(label, value, copyText, primary) {
                const card = node('section', primary ? 'picture-metric picture-primary' : 'picture-metric');
                card.append(node('h3', '', label), node('strong', 'picture-large', value), node('p', '', copyText)); metrics.append(card); return card;
            }
            const awaitingReview = result.pending + (result.pending === 1 ? ' answer' : ' answers') + ' marked not applicable, to confirm';
            const implementationMetric = metric('Reported implementation', result.attainment,
                'The lower figure is what you reported as in place. The higher figure includes unknown answers and answers marked not applicable, to confirm. It is not a performance score.', true);
            const completionMetric = metric('Answers confirmed', result.completion, result.completed + ' of ' + result.total + ' questions have a yes, partial or no response. ' + result.unknown + ' unknown or unresolved, including ' + awaitingReview + '. All ' + detail.progress.answered + ' responses are saved; submission does not mean all controls are implemented.');
            root.append(metrics, informationSection(result));
            const domains = node('section', 'picture-domains');
            domains.append(node('h3', '', 'Implementation by NCSC function'), node('p', 'dashboard-muted', 'Solid bars show what you reported as in place. The striped extension shows answers still to confirm. The range is not a performance score.'));
            result.domains.forEach(domain => {
                const row = node('div', 'picture-domain');
                const label = node('strong', '', domain.title), value = node('span', '', domain.attainment);
                row.append(label, value);
                if (domain.lowerPercentTenths !== null) {
                    const meter = node('meter'); meter.min = 0; meter.max = 1000; meter.value = domain.lowerPercentTenths;
                    meter.setAttribute('aria-label', domain.title + ' reported implementation');
                    meter.setAttribute('aria-valuetext', domain.attainment + '; bar shows what you reported as in place');
                    const track = node('div', 'picture-domain-track');
                    track.style.setProperty('--picture-lower', domain.lowerPercentTenths / 10 + '%');
                    track.style.setProperty('--picture-upper', domain.upperPercentTenths / 10 + '%');
                    const uncertainty = node('span', 'picture-domain-uncertainty'); uncertainty.setAttribute('aria-hidden', 'true');
                    track.append(meter, uncertainty); row.append(track);
                }
                row.append(node('p', 'picture-domain-detail', domain.completed + ' of ' + domain.total + ' answers confirmed'));
                domains.append(row);
            }); root.append(domains);
            root.append(trendSection(result));
            const follow = node('section', 'picture-follow-up ncsc-results');
            follow.append(node('h3', '', 'What to do next'));
            const filterEpoch = epoch;
            const filterToolbar = node('div', 'picture-follow-up-filter');
            const filterLabel = node('label', '', 'Filter follow-up by NCSC function');
            const filter = node('select'); filter.id = id + '-follow-up-domain'; filterLabel.htmlFor = filter.id;
            const allDomains = node('option', '', 'All functions'); allDomains.value = ''; filter.append(allDomains);
            metadata.domains.forEach(domain => {
                const option = node('option', '', domain.title); option.value = domain.id; filter.append(option);
            });
            filter.value = '';
            const filterHelp = node('p', 'dashboard-muted', 'This filter changes only the follow-up lists. Assessment scores and totals stay unchanged. Refreshing or opening another saved assessment resets the filter.');
            filterHelp.id = filter.id + '-help'; filter.setAttribute('aria-describedby', filterHelp.id);
            const filterStatus = node('p', 'picture-follow-up-status dashboard-muted', 'Showing all functions.');
            filterStatus.setAttribute('role', 'status'); filterStatus.setAttribute('aria-live', 'polite');
            filterToolbar.append(filterLabel, filter); follow.append(filterToolbar, filterHelp, filterStatus);
            const domainByControl = new Map(metadata.controls.map(control => [control.id, control.domainId]));
            const domainByQuestion = new Map(metadata.questions.map(question => [question.id, domainByControl.get(question.controlId)]));
            const indexed = new Map(result.domains.flatMap(domain => domain.controls.flatMap(control =>
                control.questions.map(question => [question.itemId, question]))));
            // These are display categories over the validated saved result,
            // in accepted profile order. They create no actions or new scores.
            const ordered = metadata.questions.map(question => indexed.get(question.id));
            const categories = [
                ['Unresolved answers', ordered.filter(question => ['unknown', 'not_applicable'].includes(question.responseOptionId)),
                    result.unknown ? result.unknown + ' unknown or unresolved answers: confirm the position. Not applicable answers count as not yet met until a reviewer confirms them. Reviews are coming soon.'
                        : 'No unresolved answers in this saved submission. Confirm the scope still matches the organisation.'],
                ['Reported implementation gaps', ordered.filter(question => ['partial', 'no'].includes(question.responseOptionId)),
                    result.partial || result.no ? result.partial + ' partial and ' + result.no + ' absent implementations: review the relevant questions before agreeing improvements.'
                        : 'No saved answers report partial or absent implementation. This does not establish control effectiveness.']
            ];
            const categoryViews = categories.map(([label, questions, explanation]) => {
                const category = node('details', 'ncsc-result-domain');
                const summary = node('summary', '', label + ' · ' + (result.total === 0 ? 'Not assessed' : questions.length));
                category.append(summary,
                    node('p', 'dashboard-muted', result.total === 0 ? 'No questions in this category count towards your result.' : explanation));
                const items = questions.map(question => {
                    const item = node('article', 'ncsc-result-control'); item.setAttribute('data-question-id', question.itemId);
                    item.append(node('h4', '', question.prompt), node('p', '', 'Saved answer: ' + question.answer));
                    if (question.rationale) item.append(node('p', 'ncsc-preserve-text', question.rationale));
                    const guidance = node('details'); guidance.append(node('summary', '', 'Suggested next actions and useful evidence'));
                    const actions = node('ul'), evidence = node('ul');
                    question.actions.forEach(text => actions.append(node('li', '', text)));
                    question.examples.forEach(text => evidence.append(node('li', '', text)));
                    guidance.append(node('h5', '', 'Suggested next actions'), actions,
                        node('h5', '', 'Useful evidence'), evidence);
                    item.append(guidance); category.append(item);
                    return { item, domainId: domainByQuestion.get(question.itemId) };
                });
                const empty = node('p', 'picture-follow-up-empty dashboard-muted', 'No follow-up items in this function for this category.');
                empty.hidden = true; category.append(empty);
                follow.append(category);
                return { label, category, summary, items, empty };
            });
            function currentFilter() {
                return live(filterEpoch) && !loading && !denied && follow.parentElement === root &&
                    filterToolbar.parentElement === follow && filter.parentElement === filterToolbar;
            }
            function renderFilter(domain) {
                const counts = categoryViews.map(category => {
                    let shown = 0;
                    category.items.forEach(row => { row.item.hidden = !!domain && row.domainId !== domain.id; if (!row.item.hidden) shown++; });
                    category.summary.textContent = category.label + ' · ' + (result.total === 0 ? 'Not assessed'
                        : domain ? shown + ' of ' + category.items.length + ' shown' : category.items.length);
                    category.empty.hidden = !domain || shown !== 0;
                    return shown + ' ' + category.label.toLowerCase();
                });
                filterStatus.textContent = domain ? 'Showing ' + domain.title + ': ' + counts.join('; ') + '.' : 'Showing all functions.';
            }
            const reviewEpoch = epoch, reviewBinding = sourceBinding();
            function addReview(card, category, suffix, label) {
                category.category.id = id + '-' + suffix;
                const review = button(label, () => {
                    if (!currentSubmitted(reviewEpoch, reviewBinding, review) || !currentFilter() ||
                        category.category.parentElement !== follow) return;
                    // Metric totals cover the whole saved assessment. Reveal all
                    // matching follow-up items rather than a previously filtered subset.
                    filter.value = ''; renderFilter(null);
                    category.category.open = true; category.summary.focus();
                });
                review.classList.add('dashboard-button-secondary');
                review.setAttribute('aria-controls', category.category.id); card.append(review);
            }
            const implementationGaps = categoryViews[1].items.length, unresolvedAnswers = categoryViews[0].items.length;
            if (result.total > 0 && implementationGaps) addReview(implementationMetric, categoryViews[1], 'implementation-gaps',
                'Review ' + implementationGaps + (implementationGaps === 1 ? ' implementation gap' : ' implementation gaps'));
            else implementationMetric.append(node('p', 'dashboard-muted', result.total === 0
                ? 'Implementation gaps not assessed.' : 'No reported implementation gaps in this saved assessment.'));
            if (result.total > 0 && unresolvedAnswers) addReview(completionMetric, categoryViews[0], 'unresolved-answers',
                'Review ' + unresolvedAnswers + (unresolvedAnswers === 1 ? ' unresolved answer' : ' unresolved answers'));
            else completionMetric.append(node('p', 'dashboard-muted', result.total === 0
                ? 'Unresolved answers not assessed.' : 'No unresolved answers in this saved assessment.'));
            filter.addEventListener('change', () => {
                if (!currentFilter()) return;
                const domain = metadata.domains.find(value => value.id === filter.value);
                if (filter.value && !domain) return;
                renderFilter(domain);
            });
            follow.append(node('p', 'dashboard-muted', 'A question can appear in more than one category. Counts are not a combined total or a risk ranking. Questions follow the profile order.'));
            root.append(follow);
            const limits = node('section', 'picture-limitations');
            limits.append(node('h3', '', 'How to read this picture'), node('p', '',
                'Risk priority: not calculated. Change over time compares submitted answers only; it is not a risk trend. A high implementation score does not establish control effectiveness or low business risk.'),
                node('p', '', 'This is a self-reported gap assessment, not an audit, assurance opinion or certification. Reports and findings must be reviewed and linked before they can support evidence confidence.'));
            root.append(limits);
            const calculation = node('details', 'picture-calculation');
            calculation.append(node('summary', '', 'How the implementation range is calculated'),
                node('p', '', 'No Fries gives each question equal weight: Yes = 1, Partial = 0.5 and No = 0. Unknown, missing and unapproved N/A contribute 0 to the lower bound and 1 to the upper bound. Only a trusted approved exclusion can leave the denominator; that approval workflow is not available here.'),
                node('p', '', 'This saved result: ' + result.lowerCreditUnits / 2 + '–' + result.upperCreditUnits / 2 + ' reported or possible credits ÷ ' + result.denominatorWeight + ' included question weights × 100 = ' + result.attainment + '. Percentages are rounded to one decimal place.'),
                node('p', '', 'The overall result weights questions, not the five function percentages. Functions contain different numbers of questions. This is a No Fries implementation measure based on selected NCSC guidance, not an NCSC score or certification. Evidence and confidence do not increase this implementation measure.'));
            root.append(calculation);
            root.append(sourceDetails());
            const attribution = node('p', 'dashboard-muted', metadata.attribution);
            const licence = node('a', '', 'CC BY 4.0'); licence.href = 'https://creativecommons.org/licenses/by/4.0/';
            attribution.append(licence); root.append(attribution);
        }
        async function load(append) {
            if (!live() || denied || loading) return;
            const savedFocus = captureFocus();
            abort(); const token = ++epoch; loading = true; message = ''; detail = null; retry = null; render();
            try {
                const response = await call('list', { limit: 50, afterAssessmentId: append ? after : null }, token);
                if (!response) return;
                if (!Array.isArray(response.assessments) || response.assessments.some(row =>
                    row.moduleId !== metadata.moduleId || !sameProfile(row.profileRef, metadata.profileRef))) throw new Error('picture_response_invalid');
                const combined = new Map((append ? rows : []).map(row => [row.assessmentId, row]));
                response.assessments.forEach(row => combined.set(row.assessmentId, copy(row)));
                rows = Array.from(combined.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assessmentId.localeCompare(b.assessmentId));
                after = response.nextAfterAssessmentId; loaded = true;
                allowance = response.submissionAllowance ? copy(response.submissionAllowance) : null;
                // Keep a carried or manual selection across refresh. Otherwise prefer
                // the latest submitted record on this page, then the latest unfinished one.
                if (!selected) selected = preferredAssessmentId(rows);
            } catch (error) { if (live(token)) failure(error, () => load(append)); }
            finally { if (live(token)) { loading = false; render(); restoreFocus(savedFocus); } }
            if (live(token) && !message && selected) await read(selected);
        }
        function newestRow(list) {
            return list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assessmentId.localeCompare(b.assessmentId))[0] || null;
        }
        function preferredAssessmentId(list) {
            const submitted = newestRow(list.filter(row => row.status === 'submitted'));
            if (submitted) return submitted.assessmentId;
            const draft = newestRow(list.filter(row => row.status !== 'submitted'));
            return draft ? draft.assessmentId : '';
        }
        async function read(assessmentId, source) {
            if (!live() || denied || !rows.some(row => row.assessmentId === assessmentId) && assessmentId !== initialAssessmentId && assessmentId !== selected) return;
            abort(); const token = ++epoch; const savedFocus = captureFocus(); selected = assessmentId; detail = null; message = ''; retry = null; loading = true; render();
            try {
                const response = await call('read', assessmentId, token); if (!response) return;
                const value = response.assessment;
                if (!value || value.assessmentId !== assessmentId || value.moduleId !== metadata.moduleId ||
                    !sameProfile(value.profileRef, metadata.profileRef)) throw new Error('picture_response_invalid');
                detail = copy(value);
                // A selection carried across authorised views may be outside the
                // first page. Fetch it again, never reuse cached scores or assume
                // a saved identifier grants access to the record.
                if (!rows.some(row => row.assessmentId === assessmentId)) rows.push({ assessmentId: value.assessmentId,
                    moduleId: value.moduleId, profileRef: copy(value.profileRef), status: value.status, updatedAt: value.updatedAt,
                    progress: value.progress ? copy(value.progress) : undefined, scopePopulation: copy(value.scopePopulation) });
                if (typeof options.onSelection === 'function') options.onSelection(value.assessmentId, source);
            } catch (error) { if (live(token)) failure(error, () => read(assessmentId)); }
            finally { if (live(token)) { loading = false; render(); restoreFocus(savedFocus); } }
        }
        const controller = { requestLeave(commit) {
            if (!live()) return Promise.resolve(false);
            if (typeof commit === 'function') commit(); return Promise.resolve(true);
        }, destroy() {
            if (disposed) return; disposed = true; epoch++; abort(); rows = []; detail = null; selected = ''; retry = null;
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        } };
        mounted.set(root, controller); load(false);
        if (readActions) {
            // Started beside the assessment reads, never after them.
            Promise.resolve().then(readActions).then(value => {
                if (!live()) return; actions = actionSummary(value); placeActions();
            }, () => {});
        }
        return controller;
    }
    return Object.freeze({ mount, topGaps, actionSummary });
}));
