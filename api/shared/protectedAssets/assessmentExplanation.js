(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesAssessmentExplanation = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const mounted = new WeakMap();
    const TOPICS = Object.freeze({ range: 'Saved range', unresolved: 'Unresolved answers', actions: 'Framework starting actions' });
    const PROFILE_FIELDS = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
    const copy = value => JSON.parse(JSON.stringify(value));
    const freeze = value => {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    };
    function sameProfile(left, right) {
        return left && right && PROFILE_FIELDS.every(key => typeof right[key] === 'string' && left[key] === right[key]) &&
            Object.keys(left).length === PROFILE_FIELDS.length;
    }
    function summary(value, metadata) {
        if (!value || typeof value.assessmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value.assessmentId) ||
            !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision > 128 || Object.is(value.revision, -0) ||
            typeof value.revisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.revisionSha256) ||
            !['created', 'in-progress', 'submitted'].includes(value.status) || !sameProfile(value.profileRef, metadata.profileRef) ||
            (value.status === 'created' && value.revision !== 0) ||
            (value.status === 'in-progress' && (value.revision < 1 || value.revision > 127)) ||
            (value.status === 'submitted' && value.revision < 2) ||
            (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt) ||
                !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt))) return null;
        return freeze({ assessmentId: value.assessmentId, revision: value.revision, status: value.status,
            revisionSha256: value.revisionSha256, profileRef: copy(value.profileRef), ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}) });
    }
    function unavailable(status) {
        return freeze({ status: status || 'unavailable', title: 'Saved explanation unavailable', blocks: [{ title: '',
            text: status === 'draft' ? 'This is a saved draft. A saved submitted result is needed to explain a range. Your answers remain unchanged.' :
                'A matching saved submitted result could not be validated. No explanation or score is available. Your saved answers remain unchanged.', citations: [] }] });
    }
    // Presentation only. The injected questionnaire resultModel is the sole
    // validator/projector of server results; this module performs no scoring.
    function explain(assessment, options) {
        options = options || {};
        const metadata = options.metadata, topic = options.topic || 'range';
        try {
            if (!Object.hasOwn(TOPICS, topic) || !metadata || typeof options.resultModel !== 'function' || !summary(assessment, metadata)) return unavailable();
            if (assessment.status !== 'submitted') return unavailable('draft');
            const result = options.resultModel(assessment, metadata, options.organisationId);
            if (!result) return unavailable();
            const evaluation = assessment.submission.evaluation;
            const blocks = [];
            function saved(field, questionId) {
                return { kind: 'saved', assessmentId: assessment.assessmentId, revision: assessment.revision,
                    revisionSha256: assessment.revisionSha256, field, ...(questionId ? { questionId } : {}) };
            }
            function catalogue(field, questionId) {
                return { kind: 'catalogue', profileRef: copy(metadata.profileRef), field, ...(questionId ? { questionId } : {}) };
            }
            function block(title, text, citations) { blocks.push({ title, text, citations }); }
            const prefix = 'submission.evaluation.';
            block('Saved submission', 'Assessment ' + assessment.assessmentId + ', saved submitted revision ' + assessment.revision +
                ', submitted ' + assessment.submission.submittedAt + '. This explanation describes that saved result and declared scope.',
            [saved('submission.revision'), saved('submission.submittedAt'), saved('scopePopulation.description'),
                saved('submission.responseSetSha256'), saved(prefix + 'outputSha256'), catalogue('profileRef')]);
            if (topic === 'range') {
                block('Reported implementation', 'The saved implementation range is ' + result.attainment +
                    '. The endpoints are supplied by the saved server calculation. Unknown answers and pending N/A claims remain unresolved and can widen the range; they do not confirm implementation.',
                [saved(prefix + 'attainment.lowerDisplay'), saved(prefix + 'attainment.upperDisplay'),
                    saved(prefix + 'attainment.lowerCreditUnits'), saved(prefix + 'attainment.upperCreditUnits'),
                    saved(prefix + 'attainment.denominatorWeight'), saved(prefix + 'countsCompletion.unknown'),
                    saved(prefix + 'countsCompletion.claimedNotApplicableAtoms')]);
                block('Resolved answers and supporting evidence', result.completed + ' of ' + result.total + ' answers are resolved (' + result.completion +
                    '). Resolved means Yes, Partial or No; it does not mean implemented. Saved substantiated evidence coverage: ' + result.substantiated +
                    '. Saved tested evidence coverage: ' + result.tested + '. Answers alone do not demonstrate effectiveness; this explanation verifies no evidence.',
                [saved(prefix + 'countsCompletion.completionNumerator'), saved(prefix + 'countsCompletion.completionDenominator'),
                    saved(prefix + 'countsCompletion.completionDisplay'), saved(prefix + 'evidence.substantiatedCoverage.display'),
                    saved(prefix + 'evidence.testedCoverage.display'), catalogue('responseOptions')]);
            } else if (topic === 'unresolved') {
                block('Unresolved answers', 'The saved result contains ' + result.unknown + ' unresolved answers, including ' + result.pending +
                    ' pending N/A claims. A pending N/A claim remains in the calculation; it is not an approved exclusion.',
                [saved(prefix + 'countsCompletion.unknown'), saved(prefix + 'countsCompletion.claimedNotApplicableAtoms'),
                    saved(prefix + 'countsCompletion.approvedNotApplicableAtoms')]);
            } else {
                block('Framework starting actions', 'The following accepted catalogue starting actions relate to saved answers other than Yes. They follow framework question order. They are suggestions; no action, owner or due date has been created.',
                [catalogue('questions'), saved('responses')]);
            }
            if (topic !== 'range') {
                const questions = new Map(result.domains.flatMap(domain => domain.controls.flatMap(control => control.questions)).map(question => [question.itemId, question]));
                metadata.questions.forEach(function (question) {
                    const projected = questions.get(question.id);
                    if (!projected) throw new Error('saved_question_unavailable');
                    if (topic === 'unresolved' ? !['unknown', 'not_applicable'].includes(projected.responseOptionId) : projected.responseOptionId === 'yes') return;
                    const responsePath = 'responses[itemId="' + question.id + '"]';
                    const atomPath = prefix + 'atoms[itemId="' + question.id + '"]';
                    const questionPath = 'questions[id="' + question.id + '"]';
                    const citations = [saved(responsePath + '.optionId', question.id), saved(atomPath + '.responseOrigin', question.id),
                        saved(atomPath + '.evidenceState', question.id), catalogue(questionPath + '.prompt', question.id), catalogue('responseOptions')];
                    let text = 'Saved answer: ' + projected.answer + '. Saved evidence state: ' + projected.evidence + '.';
                    if (projected.rationale !== null) {
                        text += ' Saved N/A rationale (claim only): ' + projected.rationale;
                        citations.push(saved(responsePath + '.rationale.text', question.id));
                    }
                    block(question.prompt, text, citations);
                    if (topic === 'actions') question.guidance.startingActions.forEach(function (action, index) {
                        block('Suggested starting action', action, [saved(responsePath + '.optionId', question.id),
                            catalogue(questionPath + '.guidance.startingActions[' + index + ']', question.id)]);
                    });
                    block('Accepted source references', question.sources.map(source => source.id + ' — ' + source.title +
                        ' (catalogue verification date: ' + source.lastVerifiedAt + ')').join('; ') +
                        '. These recorded dates do not establish current source verification.', [catalogue(questionPath + '.sources', question.id)]);
                });
                if (!blocks.some(row => row.citations.some(citation => citation.questionId))) {
                    block('', topic === 'unresolved' ? 'There are no unresolved answers in this saved result.' :
                        'Every saved answer is Yes; there are no starting actions for non-Yes answers in this explanation.',
                    [saved(topic === 'unresolved' ? prefix + 'countsCompletion.unknown' : 'responses')]);
                }
            }
            block('Limits of this explanation', 'Risk priority is not calculated. The saved calculation has no trend. These gap indicators are not an audit, certification, compliance finding or proof of effective controls.',
            [saved(prefix + 'remediationPriority.status'), saved(prefix + 'trend.status'), catalogue('claim'), catalogue('limitations')]);
            // Access the validated saved evaluation, never a caller-supplied model
            // response, as the identity of the explanation's source.
            return freeze({ status: 'ready', title: TOPICS[topic], assessmentId: assessment.assessmentId,
                revision: assessment.revision, outputSha256: evaluation.outputSha256, blocks });
        } catch (_) { return unavailable(); }
    }
    function mount(root, options) {
        options = options || {};
        if (!root || !root.ownerDocument || !options.metadata || !options.client || typeof options.client.read !== 'function' ||
            typeof options.resultModel !== 'function') throw new Error('assessment_explanation_options_required');
        if (mounted.has(root)) mounted.get(root).destroy();
        const document = root.ownerDocument;
        const win = document.defaultView;
        let hostSelection = summary(options.assessment, options.metadata), selected = hostSelection;
        let topic = 'range', detail = null, refreshSelection = null;
        let generation = 0, controller = null, destroyed = false, busy = false, message = '', clearanceFrame = null;
        function node(tag, text) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; }
        function button(label, action, key) {
            const item = node('button', label); item.type = 'button'; item.className = 'dashboard-button';
            item.dataset.explanationControl = key;
            // Keep the load control focusable while busy. Its handler guards
            // repeated activation, and aria-disabled communicates its state.
            item.disabled = busy && key !== 'load'; item.setAttribute('aria-disabled', String(busy));
            item.addEventListener('click', action);
            item.addEventListener('focus', function () { clearNavigationOverlap(item); }); return item;
        }
        function clearNavigationOverlap(control, checkViewport) {
            if (destroyed || document.activeElement !== control) return;
            let parent = control;
            while (parent && parent !== root) parent = parent.parentElement;
            if (!parent) return;
            const shell = root.closest('.nofries-dashboard');
            const nav = shell && shell.querySelector('.dashboard-mobile-nav');
            if (!win || typeof control.getBoundingClientRect !== 'function' ||
                typeof control.scrollIntoView !== 'function') return;
            let bounds = null;
            if (nav && !nav.hidden && typeof win.getComputedStyle === 'function' && typeof nav.getBoundingClientRect === 'function') {
                const style = win.getComputedStyle(nav), rect = nav.getBoundingClientRect();
                if (style.position === 'fixed' && style.display !== 'none' && style.visibility === 'visible' &&
                    rect.width > 0 && rect.height > 0 && rect.top < win.innerHeight && rect.bottom > 0 &&
                    rect.left < win.innerWidth && rect.right > 0) bounds = rect;
            }
            const overlaps = rect => bounds && rect.width > 0 && rect.height > 0 && rect.bottom > bounds.top &&
                rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
            const current = control.getBoundingClientRect();
            const outside = checkViewport && current.width > 0 && current.height > 0 &&
                (current.top < 0 || current.bottom > win.innerHeight || current.left < 0 || current.right > win.innerWidth);
            if (!outside && !overlaps(current)) return;
            control.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            // Wrapped labels and safe-area padding can make the fixed nav taller
            // than half the viewport. Clear any overlap left by viewport centering.
            const centered = control.getBoundingClientRect();
            if (overlaps(centered) && typeof win.scrollBy === 'function') {
                win.scrollBy({ top: centered.bottom - bounds.top, behavior: 'instant' });
            }
        }
        function scheduleClearance() {
            if (destroyed || clearanceFrame !== null) return;
            const check = function () {
                clearanceFrame = null;
                if (!destroyed && focusedControl()) clearNavigationOverlap(document.activeElement, true);
            };
            clearanceFrame = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(check) : setTimeout(check, 0);
        }
        function focusedControl() {
            const active = document.activeElement;
            for (let parent = active; parent; parent = parent.parentElement) {
                if (parent === root) return active.dataset && active.dataset.explanationControl;
            }
            return null;
        }
        function restoreFocus(key) {
            if (!key) return;
            const control = Array.from(root.querySelectorAll('[data-explanation-control]')).find(item => item.dataset.explanationControl === key);
            if (control && !control.disabled) control.focus();
        }
        function cancel() { generation += 1; if (controller) controller.abort(); controller = null; busy = false; }
        function clear() { cancel(); detail = null; refreshSelection = null; message = ''; }
        function denied(error) { return error && (error.statusCode === 401 || error.statusCode === 403 || error.status === 401 || error.status === 403 || error.code === 'ncsc_access_denied'); }
        function render() {
            if (destroyed) return;
            const focus = focusedControl();
            root.replaceChildren(); root.setAttribute('aria-label', 'Saved assessment explanation');
            root.append(node('h3', 'Ask Fry · Saved result'), node('p', 'Choose a topic, then load the selected saved submission. This uses saved assessment data and the accepted catalogue.'));
            const topics = node('div'); topics.className = 'ncsc-actions';
            Object.keys(TOPICS).forEach(function (key) {
                const item = button(TOPICS[key], function () { if (busy || destroyed) return; topic = key; render(); }, 'topic-' + key);
                item.setAttribute('aria-pressed', String(topic === key)); topics.append(item);
            }); root.append(topics);
            if (!selected || selected.status !== 'submitted') {
                root.append(node('p', message || 'A saved submitted result must be selected before an explanation can be loaded.')); restoreFocus(focus); return;
            }
            root.append(button(refreshSelection ? 'Refresh saved explanation' : detail ? 'Reload saved explanation' : 'Explain this saved result', load, 'load'));
            const clearButton = button('Clear saved explanation', function () { if (destroyed) return; clear(); render(); }, 'clear');
            clearButton.disabled = false; clearButton.setAttribute('aria-disabled', 'false'); root.append(clearButton);
            if (busy || message) { const status = node('p', busy ? 'Loading the saved submission…' : message); status.setAttribute('role', 'status'); root.append(status); }
            if (!detail) { restoreFocus(focus); return; }
            const projected = explain(detail, { metadata: options.metadata, organisationId: options.organisationId, resultModel: options.resultModel, topic });
            if (projected.status === 'ready' && hostSelection &&
                (selected.revision !== hostSelection.revision || selected.revisionSha256 !== hostSelection.revisionSha256)) {
                const notice = node('p', 'Cyber baseline and this explanation show different saved versions. Use the baseline’s Refresh control to reload it.');
                notice.className = 'ncsc-warning'; notice.dataset.explanationVersionNotice = 'true'; notice.setAttribute('role', 'status'); root.append(notice);
            }
            const region = node('section'); region.setAttribute('aria-label', 'Saved explanation'); region.append(node('h4', projected.title));
            projected.blocks.forEach(function (block) {
                if (block.title) region.append(node('h5', block.title));
                region.append(node('p', block.text));
                if (block.citations.length) {
                    const references = node('ul'); references.className = 'ncsc-explanation-citations';
                    block.citations.forEach(function (citation) {
                        references.append(node('li', citation.kind === 'saved' ? 'Saved assessment ' + citation.assessmentId + ', revision ' + citation.revision +
                            ' · ' + citation.revisionSha256 + ' · ' + citation.field : 'Accepted catalogue ' + citation.profileRef.profileId + ' ' + citation.profileRef.profileVersion +
                            ' · ' + citation.profileRef.catalogueSha256 + ' · metadata.' + citation.field));
                    }); region.append(references);
                }
            }); root.append(region); restoreFocus(focus);
        }
        async function load() {
            if (destroyed || busy || !selected || selected.status !== 'submitted') return;
            const expected = refreshSelection || selected;
            cancel(); const token = generation; controller = new AbortController(); const signal = controller.signal;
            detail = null; busy = true; message = ''; render();
            try {
                const response = await options.client.read(expected.assessmentId, { signal });
                if (destroyed || token !== generation) return;
                const value = response && response.schemaVersion === 1 ? response.assessment : null;
                const received = summary(value, options.metadata);
                if (!received || received.assessmentId !== expected.assessmentId || received.status !== 'submitted') throw new Error('saved_result_mismatch');
                if (received.revision !== expected.revision || received.revisionSha256 !== expected.revisionSha256) {
                    refreshSelection = received;
                    message = 'The saved assessment revision or fingerprint changed. Choose Refresh saved explanation to load that version explicitly.';
                } else {
                    if (expected.updatedAt !== undefined && received.updatedAt !== expected.updatedAt) throw new Error('saved_result_mismatch');
                    const projected = explain(value, { metadata: options.metadata, organisationId: options.organisationId, resultModel: options.resultModel, topic });
                    if (projected.status !== 'ready') throw new Error('saved_result_unavailable');
                    selected = received; detail = value; refreshSelection = null;
                }
            } catch (error) {
                // A late access denial still belongs to the owning context's
                // teardown policy, even when this view has since been replaced.
                if (denied(error)) {
                    if (!destroyed) {
                        clear(); selected = null; message = 'Access to this saved assessment is unavailable.'; render();
                    }
                    if (typeof options.onDenied === 'function') options.onDenied();
                } else if (!destroyed && token === generation) {
                    detail = null; message = 'The saved explanation is unavailable. Choose the load button to try again.';
                }
            } finally {
                if (!destroyed && token === generation) { controller = null; busy = false; render(); }
            }
        }
        // Text reflow need not emit a window resize. Observe only this module
        // and its shell nav; scrolling changes neither observed box's size.
        const observer = win && typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(scheduleClearance) : null;
        if (observer) {
            observer.observe(root);
            const shell = root.closest('.nofries-dashboard'), nav = shell && shell.querySelector('.dashboard-mobile-nav');
            if (nav) observer.observe(nav);
        }
        if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', scheduleClearance);
        const api = Object.freeze({
            update(value) { if (destroyed) return; clear(); hostSelection = summary(value && value.assessment, options.metadata); selected = hostSelection; render(); },
            destroy() {
                if (destroyed) return;
                clear(); destroyed = true;
                if (observer) observer.disconnect();
                if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', scheduleClearance);
                if (clearanceFrame !== null) {
                    if (win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(clearanceFrame);
                    else clearTimeout(clearanceFrame);
                    clearanceFrame = null;
                }
                root.replaceChildren(); if (mounted.get(root) === api) mounted.delete(root);
            }
        });
        mounted.set(root, api); render(); return api;
    }
    return Object.freeze({ explain, mount });
}));
