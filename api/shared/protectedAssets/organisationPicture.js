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
    const displayDate = value => new Intl.DateTimeFormat('en-NZ', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Pacific/Auckland'
    }).format(new Date(value)) + ' NZ time';
    const shortDate = value => new Intl.DateTimeFormat('en-NZ', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Pacific/Auckland'
    }).format(new Date(value));
    function sameProfile(actual, expected) {
        return actual && expected && Object.keys(expected).every(key => actual[key] === expected[key]);
    }
    // Trend and comparison derive only from figures the submitted-result
    // validator already accepted. The displayed percentage is authoritative, so
    // tenths are recovered from it rather than recomputed; scoring maths is never
    // repeated here. A null means there is no comparable overall score.
    function parseScoreTenths(display) {
        if (typeof display !== 'string') return null;
        const match = /^(\d+(?:\.\d)?)%$/.exec(display.trim());
        return match ? Math.round(parseFloat(match[1]) * 10) : null;
    }
    function overallBounds(result) {
        if (!result || typeof result.attainment !== 'string' || result.attainment === 'Not scored') return null;
        const parts = result.attainment.split('–');
        const lower = parseScoreTenths(parts[0]), upper = parseScoreTenths(parts[parts.length - 1]);
        if (lower === null || upper === null || lower > upper) return null;
        return { lower, upper };
    }
    // Pure comparison over chronological points; no network, no scoring. The
    // previous point is the submission immediately before the selected one.
    function trendModel(points, selectedId) {
        if (!Array.isArray(points) || !points.length) return null;
        let index = points.findIndex(point => point.assessmentId === selectedId);
        if (index < 0) index = points.length - 1;
        const current = points[index], previous = index > 0 ? points[index - 1] : null;
        const values = points.map(point => point.lower);
        return { current, previous, index, count: points.length,
            delta: previous ? current.lower - previous.lower : null,
            min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
    }
    // Plot coordinates for a mini line chart on a fixed 0-100% scale, so small
    // changes are never exaggerated by a truncated axis.
    function sparklineGeometry(points, width, height, pad) {
        const inner = { w: width - pad * 2, h: height - pad * 2 }, n = points.length;
        const coords = points.map((point, i) => ({
            x: n <= 1 ? width / 2 : pad + (inner.w * i) / (n - 1),
            y: pad + inner.h * (1 - Math.max(0, Math.min(1000, point.lower)) / 1000),
            lower: point.lower, assessmentId: point.assessmentId }));
        const d = coords.map((coord, i) => (i === 0 ? 'M' : 'L') + coord.x.toFixed(1) + ' ' + coord.y.toFixed(1)).join(' ');
        return { coords, d };
    }
    // Two saved assessments are like-for-like only when their saved scope text
    // is identical and they were answered against the same questionnaire
    // profile. Anything else is reported as a difference, never ignored.
    function scopeCompatibility(previous, current) {
        const scopeOf = record => record && record.scopePopulation &&
            typeof record.scopePopulation.description === 'string' ? record.scopePopulation.description : null;
        const previousScope = scopeOf(previous), currentScope = scopeOf(current);
        const previousProfile = previous && previous.profileRef || {}, currentProfile = current && current.profileRef || {};
        const sameScope = previousScope !== null && previousScope === currentScope;
        const changedFields = PROFILE_FIELDS.filter(key => typeof previousProfile[key] !== 'string' ||
            previousProfile[key] !== currentProfile[key]);
        const sameQuestionnaire = changedFields.length === 0;
        const differences = [];
        if (!sameScope) differences.push({ field: 'scope', previous: previousScope, current: currentScope });
        if (!sameQuestionnaire) differences.push({ field: 'questionnaire', fields: changedFields,
            previous: previousProfile.profileVersion || null, current: currentProfile.profileVersion || null });
        return { comparable: sameScope && sameQuestionnaire, sameScope, sameQuestionnaire,
            scope: sameScope ? currentScope : null, profileVersion: sameQuestionnaire ? currentProfile.profileVersion : null,
            differences };
    }
    // Pure difference of two validated result models. Every figure is a saved
    // display string or saved tenths; deltas are plain subtraction of saved
    // lower bounds. Questions are matched by saved item ID, functions by title.
    function compareModel(previous, current) {
        if (!previous || !current || !Array.isArray(previous.domains) || !Array.isArray(current.domains)) return null;
        const tenths = value => Number.isSafeInteger(value) ? value : null;
        const difference = (before, after) => before === null || after === null ? null : after - before;
        const questionsOf = domain => domain.controls.flatMap(control => control.questions);
        const previousDomains = new Map(previous.domains.map(domain => [domain.title, domain]));
        const previousAnswers = new Map(previous.domains.flatMap(domain => questionsOf(domain).map(question => [question.itemId, question])));
        let changedCount = 0, unchangedCount = 0, notComparedCount = 0;
        const domains = current.domains.map(domain => {
            const before = previousDomains.get(domain.title) || null, changed = [];
            let unchanged = 0, notCompared = 0;
            questionsOf(domain).forEach(question => {
                const earlier = previousAnswers.get(question.itemId);
                if (!earlier) { notCompared++; return; }
                if (earlier.responseOptionId === question.responseOptionId) { unchanged++; return; }
                changed.push({ itemId: question.itemId, prompt: question.prompt,
                    previous: earlier.answer, current: question.answer,
                    previousOptionId: earlier.responseOptionId, currentOptionId: question.responseOptionId });
            });
            changedCount += changed.length; unchangedCount += unchanged; notComparedCount += notCompared;
            const previousLower = before ? tenths(before.lowerPercentTenths) : null, currentLower = tenths(domain.lowerPercentTenths);
            return { title: domain.title, previous: before ? before.attainment : null, current: domain.attainment,
                previousLower, currentLower, delta: difference(previousLower, currentLower), changed, unchanged, notCompared };
        });
        const previousBounds = overallBounds(previous), currentBounds = overallBounds(current);
        return { previous: { attainment: previous.attainment, bounds: previousBounds },
            current: { attainment: current.attainment, bounds: currentBounds },
            delta: previousBounds && currentBounds ? currentBounds.lower - previousBounds.lower : null,
            domains, changedCount, unchangedCount, notComparedCount };
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
        // Trend/compare reads the organisation's other submitted assessments on
        // explicit request only; it never auto-fetches and is bound to the epoch
        // it loaded under, so any selection or refresh invalidates it.
        let history = null, historyEpoch = -1, historyLoading = false, historyFailed = false;
        // Compare-with-previous follows the same rule: an explicit request, one
        // fresh authorised read of the chosen earlier record (or a record the
        // trend already read in this epoch), and no figures kept across epochs.
        let compareTarget = '', compareState = null, recordCache = new Map(), recordCacheEpoch = -1;
        const HISTORY_LIMIT = 24, SVG_NS = 'http://www.w3.org/2000/svg';
        function live(token) { return !disposed && (token === undefined || token === epoch); }
        function node(tag, cls, text) {
            const value = doc.createElement(tag); if (cls) value.className = cls;
            if (text !== undefined) value.textContent = String(text); return value;
        }
        function svgNode(tag, attrs) {
            const value = doc.createElementNS(SVG_NS, tag);
            if (attrs) Object.keys(attrs).forEach(key => value.setAttribute(key, String(attrs[key])));
            return value;
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
        function render() {
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
                const empty = node('section', 'picture-first-use');
                empty.append(node('p', 'picture-first-use-eyebrow', 'Welcome to No Fries'),
                    node('h2', '', 'Build your first baseline'),
                    node('p', 'picture-first-use-intro', 'No saved assessments yet. A cyber assessment helps you understand where you stand.'));
                const steps = node('ol', 'picture-first-use-steps'); steps.setAttribute('role', 'list');
                [
                    ['Assessment', 'Answer questions about your chosen scope.'],
                    ['Results', 'Submit to see your saved baseline and its limitations.'],
                    ['Next steps', 'Review follow-up points from your results.']
                ].forEach((step, index) => {
                    const item = node('li', 'picture-first-use-step');
                    const number = node('span', 'picture-first-use-number', String(index + 1));
                    number.setAttribute('aria-hidden', 'true');
                    const content = node('div');
                    content.append(node('h3', '', step[0]), node('p', '', step[1]));
                    item.append(number, content); steps.append(item);
                });
                empty.append(steps);
                if (typeof options.openCyber === 'function') {
                    const token = epoch;
                    const action = button('Open assessment', () => {
                        if (live(token) && !loading && !message && !rows.length && !selected && after === null &&
                            action.parentElement === empty && empty.parentElement === root) options.openCyber(undefined, { startNew: true });
                    });
                    action.classList.add('picture-first-use-action'); empty.append(action);
                }
                root.append(empty);
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
            root.append(renderTrend());
            root.append(renderCompare(result));
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
            const trendSentence = submittedRows().length >= 2
                ? 'Trend and comparison across your submitted assessments are shown above, using each assessment’s reported implementation lower bound; scores from different scopes are not directly comparable.'
                : 'Trend: submit another assessment to compare your reported implementation over time.';
            limits.append(node('h3', '', 'How to read this picture'), node('p', '',
                'Risk priority: not calculated. ' + trendSentence + ' A high implementation score does not establish control effectiveness or low business risk.'),
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
            abort(); const token = ++epoch; loading = true; message = ''; detail = null; retry = null; resetHistory(); render();
            try {
                const response = await call('list', { limit: 50, afterAssessmentId: append ? after : null }, token);
                if (!response) return;
                if (!Array.isArray(response.assessments) || response.assessments.some(row =>
                    row.moduleId !== metadata.moduleId || !sameProfile(row.profileRef, metadata.profileRef))) throw new Error('picture_response_invalid');
                const combined = new Map((append ? rows : []).map(row => [row.assessmentId, row]));
                response.assessments.forEach(row => combined.set(row.assessmentId, copy(row)));
                rows = Array.from(combined.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assessmentId.localeCompare(b.assessmentId));
                after = response.nextAfterAssessmentId; loaded = true;
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
            abort(); const token = ++epoch; const savedFocus = captureFocus(); selected = assessmentId; detail = null; message = ''; retry = null; loading = true; resetHistory(); render();
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
        function resetHistory() {
            history = null; historyEpoch = -1; historyLoading = false; historyFailed = false;
            compareTarget = ''; compareState = null; recordCache = new Map(); recordCacheEpoch = -1;
        }
        function cacheRecord(token, record) {
            if (recordCacheEpoch !== token) { recordCache = new Map(); recordCacheEpoch = token; }
            recordCache.set(record.assessmentId, copy(record));
        }
        function cachedRecord(assessmentId) { return recordCacheEpoch === epoch ? recordCache.get(assessmentId) || null : null; }
        const chronological = (a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.assessmentId.localeCompare(b.assessmentId);
        // Submitted assessments before the selected one, most recent first, in
        // the same order the trend uses. The first is "immediately before".
        function earlierSubmitted() {
            if (!detail) return [];
            return submittedRows().filter(row => row.assessmentId !== detail.assessmentId && chronological(row, detail) < 0)
                .sort(chronological).reverse();
        }
        function validSubmitted(record, assessmentId) {
            return !!record && record.assessmentId === assessmentId && record.moduleId === metadata.moduleId &&
                sameProfile(record.profileRef, metadata.profileRef) && record.status === 'submitted' &&
                questionnaire.resultModel(record, metadata, organisationId) !== null;
        }
        async function loadCompare(targetId) {
            if (!live() || denied || loading || !detail || detail.status !== 'submitted' ||
                compareState && compareState.loading && compareState.epoch === epoch) return;
            if (!earlierSubmitted().some(row => row.assessmentId === targetId)) return;
            const token = epoch, currentId = detail.assessmentId, hadFocus = doc.activeElement && root.contains(doc.activeElement);
            compareTarget = targetId;
            compareState = { epoch: token, currentId, targetId, loading: true, failed: false, invalid: false, record: null }; render();
            let record = cachedRecord(targetId), failed = false;
            try {
                if (!record) {
                    const response = await call('read', targetId, token);
                    if (!response) return;
                    record = response.assessment;
                }
            } catch (_) { failed = true; }
            if (!live(token) || !compareState || compareState.epoch !== token || compareState.targetId !== targetId) return;
            const valid = !failed && validSubmitted(record, targetId);
            if (valid) cacheRecord(token, record);
            compareState = { epoch: token, currentId, targetId, loading: false, failed,
                invalid: !failed && !valid, record: valid ? copy(record) : null };
            render();
            if (hadFocus) {
                const section = root.querySelector('.picture-compare');
                const target = section && (section.querySelector('h4') || section.querySelector('button'));
                if (target) { if (target.tagName === 'H4') target.tabIndex = -1; target.focus(); }
            }
        }
        function submittedRows() { return rows.filter(row => row.status === 'submitted'); }
        // Read the overall score of each accessible submitted assessment, reusing
        // the already-authorised selected record and freshly authorising the rest.
        // Never mutates the current selection; a failed point is skipped, a failed
        // batch degrades the trend without clearing the saved result.
        async function loadHistory() {
            if (!live() || denied || loading || historyLoading) return;
            const token = epoch, hadFocus = doc.activeElement && root.contains(doc.activeElement);
            historyLoading = true; historyFailed = false; render();
            const submitted = submittedRows(), limited = submitted.slice(0, HISTORY_LIMIT);
            if (detail && detail.status === 'submitted' && !limited.some(row => row.assessmentId === detail.assessmentId)) {
                const chosen = submitted.find(row => row.assessmentId === detail.assessmentId);
                if (chosen) limited.push(chosen);
            }
            const points = [];
            try {
                for (const row of limited) {
                    let record = detail && detail.assessmentId === row.assessmentId ? detail : null;
                    if (!record) {
                        const response = await call('read', row.assessmentId, token);
                        if (!response) return;
                        record = response.assessment;
                    }
                    if (!record || record.assessmentId !== row.assessmentId || record.moduleId !== metadata.moduleId ||
                        !sameProfile(record.profileRef, metadata.profileRef) || record.status !== 'submitted') continue;
                    const model = questionnaire.resultModel(record, metadata, organisationId);
                    if (model && record !== detail) cacheRecord(token, record);
                    const bounds = overallBounds(model);
                    if (bounds) points.push({ assessmentId: record.assessmentId, submittedAt: record.updatedAt,
                        lower: bounds.lower, upper: bounds.upper });
                }
                if (!live(token)) return;
                points.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.assessmentId.localeCompare(b.assessmentId));
                history = points; historyEpoch = token;
            } catch (_) { if (live(token)) historyFailed = true; }
            finally {
                if (live(token)) {
                    historyLoading = false; render();
                    if (hadFocus && history && historyEpoch === token) {
                        const heading = root.querySelector('.picture-trend');
                        const target = heading && heading.querySelector('h3');
                        if (target) { target.tabIndex = -1; target.focus(); }
                    }
                }
            }
        }
        function renderTrend() {
            const display = tenths => (tenths / 10).toFixed(1) + '%';
            const section = node('section', 'picture-trend');
            section.append(node('h3', '', 'Trend and comparison'));
            const submitted = submittedRows();
            if (submitted.length <= 1) {
                section.append(node('p', 'dashboard-muted',
                    'Submit another assessment to see your trend. This is your only submitted assessment, so there is nothing to compare yet.'));
                return section;
            }
            if (historyEpoch !== epoch || !history) {
                section.append(node('p', 'dashboard-muted',
                    'Compare this assessment with your other submitted assessments. Loading reads each saved assessment your access allows; scores from different scopes are not combined.'));
                if (historyFailed) section.append(node('p', 'picture-status',
                    'The trend could not be loaded. Retry to read your submitted assessments again.'));
                if (historyLoading) {
                    const status = node('p', 'picture-status', 'Reading your submitted assessments…');
                    status.setAttribute('role', 'status'); section.append(status);
                }
                const action = button(historyFailed ? 'Retry trend' : 'Compare to previous and show trend',
                    () => { if (!loading && !historyLoading) loadHistory(); });
                action.classList.add('dashboard-button-secondary'); action.disabled = loading || historyLoading;
                section.append(action);
                return section;
            }
            const model = trendModel(history, detail.assessmentId);
            if (!model) { section.append(node('p', 'dashboard-muted',
                'No comparable overall scores are available across your submitted assessments.')); return section; }
            const compare = node('div', 'picture-trend-compare');
            const current = node('p', 'picture-trend-current');
            current.append(node('span', 'picture-trend-label', 'Reported implementation (lower bound)'),
                node('strong', 'picture-large', display(model.current.lower)));
            compare.append(current);
            if (model.previous) {
                const delta = model.delta;
                const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'none';
                const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '●';
                const phrase = delta > 0 ? (delta / 10).toFixed(1) + ' points higher than the previous assessment'
                    : delta < 0 ? (Math.abs(delta) / 10).toFixed(1) + ' points lower than the previous assessment'
                    : 'No change from the previous assessment';
                const badge = node('span', 'picture-trend-delta picture-trend-delta-' + direction);
                const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
                const glyph = node('span', 'picture-trend-arrow', arrow); glyph.setAttribute('aria-hidden', 'true');
                badge.append(glyph, node('span', '', sign + Math.abs(delta / 10).toFixed(1)));
                const vs = node('p', 'picture-trend-vs');
                vs.append(badge, node('span', '', ' ' + phrase + ' (' + display(model.previous.lower) +
                    '), submitted ' + shortDate(model.previous.submittedAt) + '.'));
                compare.append(vs);
            } else {
                compare.append(node('p', 'dashboard-muted',
                    'This is your earliest submitted assessment, so there is no previous assessment to compare. Later submissions appear in the trend.'));
            }
            section.append(compare);
            const summaryText = 'Trend of reported implementation lower bound across ' + model.count +
                ' submitted assessments, from ' + display(history[0].lower) + ' on ' + shortDate(history[0].submittedAt) +
                ' to ' + display(history[history.length - 1].lower) + ' on ' + shortDate(history[history.length - 1].submittedAt) +
                '. Selected assessment: ' + display(model.current.lower) + '.';
            const width = 320, height = 56, pad = 6, geo = sparklineGeometry(history, width, height, pad);
            const chart = svgNode('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'picture-trend-sparkline',
                role: 'img', focusable: 'false' });
            chart.setAttribute('aria-label', summaryText);
            if (geo.coords.length > 1) chart.append(svgNode('path', { d: geo.d, class: 'picture-trend-line', fill: 'none' }));
            geo.coords.forEach(coord => {
                const selectedPoint = coord.assessmentId === detail.assessmentId;
                chart.append(svgNode('circle', { cx: coord.x.toFixed(1), cy: coord.y.toFixed(1), r: selectedPoint ? 4 : 2.5,
                    class: selectedPoint ? 'picture-trend-dot picture-trend-dot-selected' : 'picture-trend-dot' }));
            });
            section.append(chart, node('p', 'picture-trend-summary dashboard-muted', summaryText));
            const table = node('table'), thead = node('thead'), head = node('tr');
            head.append(node('th', '', 'Submitted'), node('th', '', 'Reported implementation (lower)'), node('th', '', 'Range'));
            thead.append(head); table.append(thead);
            const body = node('tbody');
            history.forEach(point => {
                const row = node('tr');
                row.append(node('td', '', shortDate(point.submittedAt)), node('td', '', display(point.lower)),
                    node('td', '', point.upper !== point.lower ? display(point.lower) + '–' + display(point.upper) : display(point.lower)));
                body.append(row);
            });
            table.append(body);
            const data = node('details', 'picture-trend-data');
            data.append(node('summary', '', 'Trend values'), table); section.append(data);
            if (submitted.length > model.count) section.append(node('p', 'dashboard-muted',
                'Showing your ' + model.count + ' most recent comparable submitted assessments.'));
            if (after !== null) section.append(node('p', 'dashboard-muted',
                'More saved assessments are available. Load more to include them in the trend.'));
            section.append(node('p', 'dashboard-muted',
                'Comparison uses each assessment’s reported implementation lower bound. Scores from different scopes are not directly comparable.'));
            return section;
        }
        function srText(text) { return node('span', 'picture-compare-sr', text); }
        function visual(text) { const value = node('span', 'picture-compare-answer', text); value.setAttribute('aria-hidden', 'true'); return value; }
        function pointsText(delta) {
            if (delta === null) return 'Not comparable';
            if (delta === 0) return 'No change';
            return (delta > 0 ? '+' : '−') + (Math.abs(delta) / 10).toFixed(1) + ' points';
        }
        function renderCompare(result) {
            const section = node('section', 'picture-compare');
            const heading = node('h3', '', 'Compare with previous'); heading.id = id + '-compare-heading';
            section.setAttribute('aria-labelledby', heading.id); section.append(heading);
            if (submittedRows().length <= 1) {
                section.append(node('p', 'dashboard-muted',
                    'Only one submitted assessment is available, so there is nothing to compare with yet. Submit a re-assessment of the same scope to see what changed.'));
                return section;
            }
            const candidates = earlierSubmitted();
            if (!candidates.length) {
                section.append(node('p', 'dashboard-muted', 'This is your earliest submitted assessment, so there is no earlier assessment to compare with. Select a later assessment to compare it with this one.' +
                    (after !== null ? ' More saved assessments are available; load more to include older ones.' : '')));
                return section;
            }
            if (!candidates.some(row => row.assessmentId === compareTarget)) compareTarget = candidates[0].assessmentId;
            const state = compareState && compareState.epoch === epoch && compareState.currentId === detail.assessmentId &&
                compareState.targetId === compareTarget ? compareState : null;
            const busy = loading || !!(state && state.loading), token = epoch;
            section.append(node('p', 'dashboard-muted', 'Choose an earlier submitted assessment. Scope and questionnaire version are checked first, then score, function and answer changes are shown from the saved results. Nothing is re-scored.'));
            const toolbar = node('div', 'picture-compare-toolbar');
            const label = node('label', '', 'Compare with'), picker = node('select');
            picker.id = id + '-compare'; label.htmlFor = picker.id; picker.disabled = busy;
            const labelFor = (row, index) => (index === 0 ? 'Previous · ' : '') + displayDate(row.updatedAt) +
                (row.scopePopulation ? ' · ' + row.scopePopulation.description : '');
            const counts = new Map();
            candidates.forEach((row, index) => { const text = labelFor(row, index); counts.set(text, (counts.get(text) || 0) + 1); });
            candidates.forEach((row, index) => {
                const text = labelFor(row, index);
                const item = node('option', '', text + (counts.get(text) > 1 ? ' · ' + row.assessmentId : ''));
                item.value = row.assessmentId; picker.append(item);
            });
            picker.value = compareTarget;
            picker.addEventListener('change', () => {
                if (!live(token) || denied || loading || !candidates.some(row => row.assessmentId === picker.value)) return;
                compareTarget = picker.value; render();
                const next = root.querySelector('.picture-compare'), control = next && next.querySelector('select');
                if (control) control.focus();
            });
            const action = button(state && state.failed ? 'Retry comparison' : 'Compare with previous', () => {
                if (live(token) && !loading) loadCompare(picker.value);
            });
            action.classList.add('dashboard-button-secondary'); action.disabled = busy;
            toolbar.append(label, picker, action); section.append(toolbar);
            if (after !== null) section.append(node('p', 'dashboard-muted', 'More saved assessments are available. Load more to choose from older ones.'));
            if (state && state.loading) {
                const status = node('p', 'picture-status', 'Reading the earlier assessment…');
                status.setAttribute('role', 'status'); section.append(status);
            } else if (state && state.failed) {
                const status = node('p', 'picture-status', 'The earlier assessment could not be read. Retry the comparison; no figures are shown from an unconfirmed read.');
                status.setAttribute('role', 'status'); section.append(status);
            } else if (state && state.invalid) {
                section.append(node('p', 'ncsc-warning', 'Results are unavailable for the earlier saved submission. No comparison has been inferred.'));
            } else if (state && state.record) section.append(renderComparison(state.record, result));
            return section;
        }
        function renderComparison(record, result) {
            const wrap = node('div', 'picture-compare-result');
            wrap.append(node('h4', '', 'Changes since ' + displayDate(record.updatedAt)));
            const compatibility = scopeCompatibility(record, detail);
            const model = compareModel(questionnaire.resultModel(record, metadata, organisationId), result);
            if (!model) { wrap.append(node('p', 'ncsc-warning', 'Results are unavailable for the earlier saved submission. No comparison has been inferred.')); return wrap; }
            if (compatibility.comparable) {
                wrap.append(node('p', 'picture-compare-compatible', 'Like-for-like: both assessments use identical scope text and the same questionnaire version (' +
                    compatibility.profileVersion + ').'));
                const scope = node('p', 'dashboard-muted ncsc-preserve-text', 'Scope: ' + compatibility.scope); wrap.append(scope);
                wrap.append(renderChanges(model, record));
                return wrap;
            }
            const warning = node('div', 'ncsc-warning picture-compare-warning');
            warning.append(node('h5', '', 'Not a like-for-like comparison'));
            const reasons = node('ul');
            compatibility.differences.forEach(difference => {
                const item = node('li');
                if (difference.field === 'scope') {
                    item.append(node('p', '', 'The saved scope text differs.'),
                        node('p', 'ncsc-preserve-text', 'Earlier: ' + (difference.previous === null ? 'not recorded' : difference.previous)),
                        node('p', 'ncsc-preserve-text', 'Selected: ' + (difference.current === null ? 'not recorded' : difference.current)));
                } else item.append(node('p', '', 'The questionnaire version differs (earlier ' + (difference.previous || 'unknown') +
                    ', selected ' + (difference.current || 'unknown') + '). Questions and weights may not match.'));
                reasons.append(item);
            });
            warning.append(reasons, node('p', '', 'Changes may reflect different systems, people or questions rather than a change in security practice. Treat the figures as indicative only.'));
            wrap.append(warning);
            const anyway = node('details', 'picture-compare-anyway');
            anyway.append(node('summary', '', 'Show changes anyway (not like-for-like)'), renderChanges(model, record));
            wrap.append(anyway);
            return wrap;
        }
        function renderChanges(model, record) {
            const body = node('div', 'picture-compare-body'), earlierDate = shortDate(record.updatedAt);
            const range = node('p', 'picture-compare-range');
            const values = node('strong', 'picture-large', model.previous.attainment + ' → ' + model.current.attainment);
            values.setAttribute('aria-hidden', 'true');
            range.append(node('span', 'picture-trend-label', 'Reported implementation range'), values,
                srText('From ' + model.previous.attainment + ' on ' + earlierDate + ' to ' + model.current.attainment + ' in the selected assessment.'));
            if (model.delta !== null) {
                const direction = model.delta > 0 ? 'up' : model.delta < 0 ? 'down' : 'none';
                const badge = node('span', 'picture-trend-delta picture-trend-delta-' + direction);
                const glyph = node('span', 'picture-trend-arrow', direction === 'up' ? '▲' : direction === 'down' ? '▼' : '●');
                glyph.setAttribute('aria-hidden', 'true');
                badge.append(glyph, node('span', '', pointsText(model.delta) + ' in the reported lower bound'));
                range.append(badge);
            }
            body.append(range);
            body.append(node('h5', '', 'Change by NCSC function'));
            const table = node('table', 'picture-compare-table');
            table.append(node('caption', '', 'Reported implementation by NCSC function: earlier (' + earlierDate + ') and selected assessment. Change is in the reported lower bound.'));
            const thead = node('thead'), head = node('tr');
            ['NCSC function', 'Earlier', 'Selected', 'Change'].forEach(text => { const cell = node('th', '', text); cell.setAttribute('scope', 'col'); head.append(cell); });
            thead.append(head); table.append(thead);
            const tbody = node('tbody');
            model.domains.forEach(domain => {
                const row = node('tr'), title = node('th', '', domain.title); title.setAttribute('scope', 'row');
                row.append(title, node('td', '', domain.previous === null ? 'Not available' : domain.previous),
                    node('td', '', domain.current), node('td', '', pointsText(domain.delta)));
                tbody.append(row);
            });
            table.append(tbody); body.append(table);
            body.append(node('h5', '', 'Answer changes'));
            const total = model.changedCount + model.unchangedCount;
            body.append(node('p', 'picture-compare-summary', model.changedCount + ' of ' + total + (total === 1 ? ' answer' : ' answers') +
                ' changed; ' + model.unchangedCount + ' unchanged.' +
                (model.notComparedCount ? ' ' + model.notComparedCount + ' not in the earlier assessment.' : '')));
            model.domains.forEach(domain => {
                const group = node('section', 'picture-compare-function');
                group.append(node('h6', '', domain.title), node('p', 'dashboard-muted',
                    (domain.changed.length ? domain.changed.length + ' changed' : 'No answers changed') + ' · ' + domain.unchanged + ' unchanged'));
                if (domain.changed.length) {
                    const list = node('ul', 'picture-compare-answers');
                    domain.changed.forEach(change => {
                        const item = node('li'); item.setAttribute('data-question-id', change.itemId);
                        item.append(node('span', 'picture-compare-prompt', change.prompt),
                            visual(change.previous + ' → ' + change.current),
                            srText('changed from ' + change.previous + ' to ' + change.current));
                        list.append(item);
                    });
                    group.append(list);
                }
                body.append(group);
            });
            body.append(node('p', 'dashboard-muted', 'Figures are the saved results of each assessment; nothing is re-scored. A changed answer is self-reported and does not establish control effectiveness.'));
            return body;
        }
        const controller = { requestLeave(commit) {
            if (!live()) return Promise.resolve(false);
            if (typeof commit === 'function') commit(); return Promise.resolve(true);
        }, destroy() {
            if (disposed) return; disposed = true; epoch++; abort(); rows = []; detail = null; selected = ''; retry = null; resetHistory();
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        } };
        mounted.set(root, controller); load(false); return controller;
    }
    return Object.freeze({ mount, overallBounds, trendModel, sparklineGeometry, scopeCompatibility, compareModel });
}));
