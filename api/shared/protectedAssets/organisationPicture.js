(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./ncscQuestionnaire'), require('./assessmentExplanation'));
    else root.NoFriesOrganisationPicture = factory(root.NoFriesNcscQuestionnaire, root.NoFriesAssessmentExplanation);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (questionnaire, explanation) {
    'use strict';
    const mounted = new WeakMap();
    const PROFILE_FIELDS = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
    let sequence = 0;
    const copy = value => JSON.parse(JSON.stringify(value));
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
        const id = 'picture-assessment-' + (++sequence);
        const initialAssessmentId = typeof options.initialAssessmentId === 'string' ? options.initialAssessmentId : null;
        let disposed = false, epoch = 0, requests = new Set(), rows = [], after = null;
        let selected = initialAssessmentId || '', detail = null, loading = false, message = '', denied = false;
        let loaded = false, retry = null, explanationController = null;
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
        function restoreFocus(saved) {
            if (!saved || !live() || denied) return;
            // Do not steal focus if the user moved it elsewhere during the read.
            if (doc.activeElement && doc.activeElement !== saved.element && doc.activeElement.tagName !== 'BODY') return;
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
        function failure(error, retryRequest) {
            detail = null; retry = retryRequest;
            if ([401, 403].includes(error && (error.status || error.statusCode))) {
                denied = true; rows = []; selected = ''; after = null; retry = null;
                message = 'This organisation picture is unavailable. Reopen your authenticated dashboard.';
            } else message = 'The saved assessment could not be confirmed. Retry to load a fresh picture.';
        }
        function sourceDetails(inputs) {
            const provenance = node('details', 'ncsc-result-provenance');
            provenance.append(node('summary', '', 'Source and calculation details'));
            const dl = node('dl');
            const facts = [['Organisation name', organisationName], ['Saved at', detail.updatedAt],
                ['Saved status', detail.status], ['Saved revision', String(detail.revision)],
                ['Framework', metadata.title], ['Profile version', metadata.profileRef.profileVersion],
                ...(inputs || [['Organisation', organisationId], ['Assessment', detail.assessmentId]])];
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
            heading.append(node('h3', '', 'Baseline in progress'));
            if (typeof options.openCyber === 'function') heading.append(openSavedAssessment('Continue saved assessment'));
            const saved = node('p', 'picture-large', detail.progress.answered + ' / ' + detail.progress.total + ' responses saved');
            const progress = node('progress', 'ncsc-saved-progress');
            progress.max = detail.progress.total; progress.value = detail.progress.answered;
            progress.setAttribute('aria-label', 'Saved responses');
            const scope = node('section', 'picture-scope');
            scope.append(node('h3', '', 'Scope'), node('p', '', detail.scopePopulation.description));
            draft.append(heading, saved, progress, scope,
                node('p', 'dashboard-muted', 'Saved progress is not a score. Submit this assessment when it is ready; unknown answers remain visible as uncertainty.'));
            root.append(draft);
        }
        function render() {
            if (!live()) return;
            clearExplanation();
            root.replaceChildren(); root.classList.add('organisation-picture');
            const header = node('header', 'picture-heading');
            header.append(node('h2', '', 'Cyber baseline'),
                node('p', 'dashboard-muted', 'A saved assessment of the selected scope, not a live check of connected systems.'));
            root.append(header);
            const status = node('p', 'picture-status', message || (loading ? 'Loading saved assessment…' : ''));
            status.setAttribute('role', 'status'); status.hidden = !message && !loading; root.append(status);
            if (denied) return;
            if (detail && detail.status !== 'submitted') renderResume();
            if (rows.length) {
                const toolbar = node('div', 'picture-toolbar');
                const label = node('label', '', 'Saved assessment'); label.htmlFor = id;
                const picker = node('select'); picker.id = id; picker.disabled = loading;
                const labelFor = row => row.updatedAt.slice(0, 10) + ' · ' + row.status + ' · revision ' + row.revision;
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
                picker.addEventListener('change', () => { if (live() && !denied) read(picker.value); });
                const refresh = button('Refresh', () => load(false)); refresh.disabled = loading;
                refresh.classList.add('dashboard-button-secondary');
                toolbar.append(label, picker, refresh);
                if (after !== null) { const more = button('Load more', () => load(true)); more.disabled = loading; more.classList.add('dashboard-button-secondary'); toolbar.append(more); }
                root.append(toolbar);
                if (after !== null) root.append(node('p', 'dashboard-muted', 'More saved assessments are available. Load more to see them.'));
                if (!detail) root.append(node('p', 'dashboard-muted', 'Refresh reloads saved assessments. It does not check whether answers still reflect the organisation today.'));
            }
            if (!loading && !rows.length && loaded && !message) {
                const empty = node('section', 'picture-empty');
                empty.append(node('h3', '', 'Start with an honest baseline'), node('p', '', 'No saved assessments yet. Complete and submit an assessment to see implementation and evidence measures here.'));
                if (typeof options.openCyber === 'function') empty.append(button('Open Cyber Security', options.openCyber));
                root.append(empty);
            }
            if (message && !loading) root.append(button('Retry', () => { if (retry) retry(); }));
            if (!detail) return;
            const facts = node('p', 'picture-source', 'Saved ' + detail.updatedAt.slice(0, 10) +
                ' · ' + detail.status + ' · revision ' + detail.revision);
            root.append(facts);
            if (detail.status !== 'submitted') {
                root.append(sourceDetails()); return;
            }
            const scope = node('section', 'picture-scope');
            scope.append(node('h3', '', 'Scope'), node('p', '', detail.scopePopulation.description)); root.append(scope);
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
                explanationController = explanation.mount(child, { client, metadata, organisationId,
                    resultModel: questionnaire.resultModel, assessment: {
                        assessmentId: detail.assessmentId, revision: detail.revision, revisionSha256: detail.revisionSha256,
                        status: detail.status, profileRef: detail.profileRef, updatedAt: detail.updatedAt
                    },
                    onDenied() {
                        if (!live()) return;
                        abort(); epoch++;
                        failure({ statusCode: 403 }, null); render();
                    } });
            }
        }
        function renderResult(result) {
            const metrics = node('div', 'picture-metrics');
            function metric(label, value, copyText, primary) {
                const card = node('section', primary ? 'picture-metric picture-primary' : 'picture-metric');
                card.append(node('h3', '', label), node('strong', 'picture-large', value), node('p', '', copyText)); metrics.append(card); return card;
            }
            const implementationMetric = metric('Reported implementation', result.attainment,
                'Lower bound: reported implementation. Upper bound: uncertainty from unknown answers and pending N/A claims, not achieved performance.', true);
            const completionMetric = metric('Resolved answers', result.completion, result.completed + ' of ' + result.total + ' questions have a yes, partial or no response. ' + result.unknown + ' unknown or unresolved, including ' + result.pending + ' pending N/A claims. All ' + detail.progress.answered + ' responses are saved; submission does not mean all controls are implemented.');
            const evidenceMetric = metric('Supporting evidence', result.substantiated, 'Coverage recorded in this saved assessment. Tested or observed coverage: ' + result.tested + '. This assessment journey does not yet accept evidence uploads or reviews. Zero coverage means evidence has not been supplied here; confidence is not assessed.');
            root.append(metrics);
            const domains = node('section', 'picture-domains');
            domains.append(node('h3', '', 'Implementation by NCSC function'), node('p', 'dashboard-muted', 'Solid bars show the reported lower bound; the striped extension shows uncertainty. The range is not achieved performance.'));
            result.domains.forEach(domain => {
                const row = node('div', 'picture-domain');
                const label = node('strong', '', domain.title), value = node('span', '', domain.attainment);
                row.append(label, value);
                if (domain.lowerPercentTenths !== null) {
                    const meter = node('meter'); meter.min = 0; meter.max = 1000; meter.value = domain.lowerPercentTenths;
                    meter.setAttribute('aria-label', domain.title + ' reported implementation');
                    meter.setAttribute('aria-valuetext', domain.attainment + '; bar shows lower bound');
                    const track = node('div', 'picture-domain-track');
                    track.style.setProperty('--picture-lower', domain.lowerPercentTenths / 10 + '%');
                    track.style.setProperty('--picture-upper', domain.upperPercentTenths / 10 + '%');
                    const uncertainty = node('span', 'picture-domain-uncertainty'); uncertainty.setAttribute('aria-hidden', 'true');
                    track.append(meter, uncertainty); row.append(track);
                }
                row.append(node('p', 'picture-domain-detail', domain.completed + ' / ' + domain.total + ' answers resolved · scoring weight ' + domain.denominatorWeight));
                domains.append(row);
            }); root.append(domains);
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
                    result.unknown ? result.unknown + ' unknown or unresolved answers: confirm the position. N/A claims remain unresolved; approval is not available in this journey.'
                        : 'No unresolved answers in this saved submission. Confirm the scope still matches the organisation.'],
                ['Reported implementation gaps', ordered.filter(question => ['partial', 'no'].includes(question.responseOptionId)),
                    result.partial || result.no ? result.partial + ' partial and ' + result.no + ' absent implementations: review the relevant questions before agreeing improvements.'
                        : 'No saved answers report partial or absent implementation. This does not establish control effectiveness.'],
                ['Supporting-evidence gaps', ordered.filter(question => question.evidenceState === 'not_provided'),
                    'Supporting evidence has not been supplied in this assessment. Evidence upload and review are not available here; confidence is not assessed.']
            ];
            const categoryViews = categories.map(([label, questions, explanation]) => {
                const category = node('details', 'ncsc-result-domain');
                const summary = node('summary', '', label + ' · ' + (result.total === 0 ? 'Not assessed' : questions.length));
                category.append(summary,
                    node('p', 'dashboard-muted', result.total === 0 ? 'No applicable question denominator is available for this category.' : explanation));
                const items = questions.map(question => {
                    const item = node('article', 'ncsc-result-control'); item.setAttribute('data-question-id', question.itemId);
                    item.append(node('h4', '', question.prompt), node('p', '', 'Saved answer: ' + question.answer),
                        node('p', '', 'Supporting evidence: ' + question.evidence));
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
            addReview(evidenceMetric, categoryViews[2], 'supporting-evidence-gaps', 'Review supporting-evidence gaps');
            filter.addEventListener('change', () => {
                if (!currentFilter()) return;
                const domain = metadata.domains.find(value => value.id === filter.value);
                if (filter.value && !domain) return;
                renderFilter(domain);
            });
            follow.append(node('p', 'dashboard-muted', 'A question can appear in more than one category. Counts are not a combined total or a risk ranking. Questions follow the profile order; no action is assigned or evidence uploaded here.'));
            root.append(follow);
            const limits = node('section', 'picture-limitations');
            limits.append(node('h3', '', 'How to read this picture'), node('p', '',
                'Risk priority: not calculated. Trend: no comparable assessment selected. A high implementation score does not establish control effectiveness or low business risk.'),
                node('p', '', 'This is a self-reported gap assessment, not an audit, assurance opinion or certification. Reports and findings must be reviewed and linked before they can support evidence confidence.'));
            root.append(limits);
            const calculation = node('details', 'picture-calculation');
            calculation.append(node('summary', '', 'How the implementation range is calculated'),
                node('p', '', 'No Fries gives each question equal weight: Yes = 1, Partial = 0.5 and No = 0. Unknown, missing and unapproved N/A contribute 0 to the lower bound and 1 to the upper bound. Only a trusted approved exclusion can leave the denominator; that approval workflow is not available here.'),
                node('p', '', 'This saved result: ' + result.lowerCreditUnits / 2 + '–' + result.upperCreditUnits / 2 + ' reported or possible credits ÷ ' + result.denominatorWeight + ' included question weights × 100 = ' + result.attainment + '. Percentages are rounded to one decimal place.'),
                node('p', '', 'The overall result weights questions, not the five function percentages. Functions contain different numbers of questions. This is a No Fries implementation measure based on selected NCSC guidance, not an NCSC score or certification. Evidence and confidence do not increase this implementation measure.'));
            root.append(calculation);
            root.append(sourceDetails(result.inputs));
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
                // Preserve an explicit selection across refresh/pagination. Its ID is
                // only a read target; the client must freshly authorize the record.
                if (!selected) selected = rows.length ? rows[0].assessmentId : '';
            } catch (error) { if (live(token)) failure(error, () => load(append)); }
            finally { if (live(token)) { loading = false; render(); restoreFocus(savedFocus); } }
            if (live(token) && !message && selected) await read(selected);
        }
        async function read(assessmentId) {
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
                    moduleId: value.moduleId, profileRef: copy(value.profileRef), status: value.status, updatedAt: value.updatedAt });
                if (typeof options.onSelection === 'function') options.onSelection(value.assessmentId);
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
        mounted.set(root, controller); load(false); return controller;
    }
    return Object.freeze({ mount });
}));
