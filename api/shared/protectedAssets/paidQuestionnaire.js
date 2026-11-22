(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesPaidQuestionnaire = factory();
}(globalThis, function () {
    'use strict';

    // The host supplies the authorised GET/start envelope and pinned publication,
    // and disposes this mount whenever the organisation, session or selection changes.
    function mount(container, { record, publication, isCurrent, mutate, showResults }) {
        const doc = container.ownerDocument;
        function node(tag, text, className) {
            const el = doc.createElement(tag);
            if (text !== undefined) el.textContent = text;
            if (className) el.className = className;
            return el;
        }
        const view = node('section', undefined, 'ncsc-questionnaire');
        const id = record.assessment.assessmentId;
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id) || isCurrent() !== true) {
            throw new Error('assessment_unavailable');
        }
        const { framework, profile } = publication;
        const title = framework.id === 'iso-iec-27001' ? 'ISO 27001 readiness self-assessment' : profile.title;
        const endpoint = '/api/dashboard/frameworks/' + [profile.id, profile.version, 'assessments', id].map(encodeURIComponent).join('/');
        const choices = new Map(publication.responseOptions.map(option => [option.id, option]));
        const ordered = rows => rows.slice().sort((a, b) => a.order - b.order);
        const sections = ordered(publication.domains).map(domain => ({
            title: domain.title,
            questions: ordered(publication.controls.filter(control => control.domainId === domain.id))
                .flatMap(control => ordered(publication.questions.filter(q => q.controlId === control.id)))
        }));
        const questions = sections.flatMap(section => section.questions);
        const byId = new Map(questions.map(q => [q.id, q]));
        function read(envelope) {
            const a = envelope?.assessment, ref = a?.profileRef;
            if (envelope?.schemaVersion !== 1 || a?.assessmentId !== id || a.moduleId !== 'cyber_security' ||
                ref?.frameworkId !== framework.id || ref.frameworkVersion !== framework.version ||
                ref.profileId !== profile.id || ref.profileVersion !== profile.version ||
                !/^[a-f0-9]{64}$/.test(ref.catalogueSha256) || ref.catalogueSha256 !== publication.catalogueSha256 || ref.sourceCatalogueSha256 !== publication.sourceCatalogueSha256 ||
                !Number.isSafeInteger(a.revision) || a.revision < 0 || !Array.isArray(a.responses) ||
                !['created', 'in-progress', 'submitted', 'reviewed', 'archived'].includes(a.status)) throw new Error('assessment_mismatch');
            const entries = new Map();
            for (const {itemId, optionId, rationale} of a.responses) {
                if (entries.has(itemId) || !byId.get(itemId)?.responseOptionIds.includes(optionId) ||
                    (choices.get(optionId).applicable ? rationale !== null : typeof rationale?.text !== 'string' || !rationale.text.trim())) {
                    throw new Error('response_mismatch');
                }
                entries.set(itemId, {itemId, optionId, rationale: rationale?.text ?? null});
            }
            return entries;
        }
        let saved = read(record);
        const edits = new Map();
        let current = questions.find(q => !saved.has(q.id)) || questions[0], unanswered = false;
        let pending, busy = false, closed = false, message = '';
        const live = () => !closed && view.parentNode === container && isCurrent() === true;
        const answer = q => edits.get(q.id) || saved.get(q.id);
        const complete = q => {
            const value = answer(q);
            return !!value && (choices.get(value.optionId).applicable || !!value.rationale?.trim());
        };
        const same = (a, b) => a?.optionId === b?.optionId && a?.rationale === b?.rationale;
        const hasUnsavedChanges = () => edits.size > 0;
        // Warn before the tab closes or reloads only while answers are unsaved.
        const win = doc.defaultView;
        let guarded = false;
        function beforeUnload(event) {
            if (closed || !hasUnsavedChanges()) return undefined;
            event.preventDefault();
            event.returnValue = '';
            return '';
        }
        function guard() {
            const wanted = !closed && hasUnsavedChanges();
            if (wanted === guarded || typeof win?.addEventListener !== 'function') return;
            if (wanted) win.addEventListener('beforeunload', beforeUnload);
            else win.removeEventListener('beforeunload', beforeUnload);
            guarded = wanted;
        }
        function edit(value) {
            if (same(value, saved.get(value.itemId))) edits.delete(value.itemId);
            else edits.set(value.itemId, value);
            message = '';
            guard();
        }
        function destroy() {
            closed = true;
            guard();
            view.remove();
            view.replaceChildren();
            edits.clear();
            saved.clear();
            pending = null;
        }
        function stop(text) {
            destroy();
            container.replaceChildren(node('p', text));
        }
        function sealed() {
            if (record.assessment.submission && typeof showResults === 'function') {
                destroy();
                showResults(record);
            } else stop('This assessment is closed.');
        }
        function button(label, action, primary = false) {
            const b = node('button', label, 'dashboard-button' + (primary ? '' : ' dashboard-button-secondary'));
            b.type = 'button';
            b.onclick = () => { if (live() && !busy) action(); };
            return b;
        }
        function render(focus) {
            if (!live()) return;
            const section = sections.find(s => s.questions.includes(current));
            const header = node('h1', title);
            const status = node('p', '', 'ncsc-status');
            status.setAttribute('role', 'status');
            const progress = node('p', '', 'ncsc-navigation-summary');
            const sectionLabel = node('label', 'Section');
            const select = node('select');
            sectionLabel.append(select);
            function updateCounts() {
                sections.forEach((s, i) => {
                    const count = s.questions.filter(complete).length;
                    const option = select.options[i] || select.appendChild(node('option'));
                    const text = count + ' of ' + s.questions.length + ' answered · ' + s.title;
                    if (option.textContent !== text) option.textContent = text;
                });
                select.selectedIndex = sections.indexOf(section);
                const count = questions.filter(q => saved.has(q.id) && !edits.has(q.id)).length;
                progress.textContent = count + ' of ' + questions.length + ' answers saved';
                status.textContent = message || (edits.size ? 'Unsaved changes (' + edits.size + ').' : '');
            }
            const filterLabel = node('label', undefined, 'ncsc-option');
            const filter = node('input');
            filter.type = 'checkbox';
            filter.checked = unanswered;
            filterLabel.append(filter, 'Show unanswered questions only');
            const selectQuestion = q => { current = q; message = ''; render('question'); };
            select.onchange = () => {
                const chosen = sections[select.selectedIndex];
                selectQuestion(chosen.questions.find(q => !complete(q)) || chosen.questions[0]);
            };
            filter.onchange = () => {
                unanswered = filter.checked;
                selectQuestion(unanswered ? questions.find(q => !complete(q)) || current : current);
            };
            const jump = node('details'), jumpLabel = node('label', 'Question in this section'), questionList = node('select');
            jump.append(node('summary', 'Find a question'), jumpLabel);
            jumpLabel.append(questionList);
            const listed = section.questions.filter(q => !unanswered || !complete(q) || q === current);
            listed.forEach(q => questionList.append(node('option', q.id + ' · ' + q.prompt)));
            questionList.selectedIndex = listed.indexOf(current);
            questionList.onchange = () => selectQuestion(listed[questionList.selectedIndex]);
            const actions = node('div', undefined, 'ncsc-actions');
            const remaining = questions.filter(q => !complete(q));
            const visible = !unanswered || !complete(current);
            const eligible = questions.filter(q => !unanswered || !complete(q) || q === current);
            const index = eligible.indexOf(current);
            const question = node('fieldset', undefined, 'ncsc-answer');
            const heading = node('legend', visible ? current.prompt : 'No unanswered questions in this section.');
            heading.tabIndex = -1;
            question.append(heading);
            const reasonLabel = node('label', 'Why does this not apply to your scope?');
            const reason = node('textarea');
            reasonLabel.append(reason);
            reason.required = true;
            reason.maxLength = 4000;
            function updateReason() {
                const row = answer(current);
                reasonLabel.hidden = !row || choices.get(row.optionId).applicable;
                reason.value = row?.rationale || '';
                reason.setCustomValidity('');
            }
            const save = button('Save progress', () => write('save'));
            const submit = button('Submit assessment', () => {
                if (doc.defaultView.confirm('Submit your saved answers? You cannot change them after submitting.')) write('submit');
            });
            function refresh() {
                updateCounts();
                save.disabled = busy || !edits.size;
                submit.hidden = questions.some(q => !complete(q)) || edits.size > 0;
                submit.disabled = busy;
            }
            if (visible) {
                for (const optionId of current.responseOptionIds) {
                    const label = node('label', undefined, 'ncsc-option');
                    const radio = node('input');
                    radio.type = 'radio';
                    radio.name = 'answer';
                    radio.checked = answer(current)?.optionId === optionId;
                    radio.onchange = () => {
                        if (!live() || busy || pending) return;
                        edit({ itemId: current.id, optionId, rationale: choices.get(optionId).applicable ? null : '' });
                        updateReason();
                        refresh();
                    };
                    label.append(radio, choices.get(optionId).label);
                    question.append(label);
                }
                updateReason();
                reason.oninput = () => {
                    if (!live() || busy || pending) return;
                    edit({ ...answer(current), rationale: reason.value });
                    reason.setCustomValidity('');
                    refresh();
                };
                question.append(reasonLabel);
                const examples = current.guidance?.evidenceExamples || [];
                if (examples.length) {
                    const details = node('details', undefined, 'ncsc-question-help');
                    const list = node('ul');
                    examples.forEach(example => list.append(node('li', example)));
                    details.append(node('summary', 'Help with this question'));
                    if (current.guidance.summary) details.append(node('p', current.guidance.summary));
                    details.append(node('h3', 'Evidence to consider'), list);
                    for (const action of current.guidance.startingActions || []) details.append(node('p', action));
                    question.append(details);
                }
            }
            if (index > 0) actions.append(button('Previous', () => selectQuestion(eligible[index - 1])));
            if (index < eligible.length - 1) actions.append(button('Next', () => selectQuestion(eligible[index + 1]), true));
            actions.append(save, submit);
            view.replaceChildren(header, progress, sectionLabel, filterLabel, jump,
                node('p', visible ? section.title + ' · Question ' + (section.questions.indexOf(current) + 1) + ' of ' + section.questions.length :
                    remaining.length + ' unanswered overall', 'dashboard-eyebrow'), question, actions, status);
            if (publication.statements?.attribution) {
                const attribution = node('details');
                attribution.append(node('summary', 'About this publication'), node('p', publication.statements.attribution));
                view.append(attribution);
            }
            refresh();
            if (pending) {
                view.querySelectorAll('select,input,textarea,button').forEach(el => { el.disabled = true; });
                if (!busy) actions.append(button('Try again', () => write(pending.action), true));
            }
            if (focus === 'question') heading.focus();
            if (focus === 'reason') {
                reason.setCustomValidity('Enter a reason or choose another answer.');
                reason.focus();
                reason.reportValidity();
            }
            if (focus === 'status') { status.tabIndex = -1; status.focus(); }
        }
        async function write(action) {
            if (!live() || busy) return;
            if (!pending) {
                const invalid = questions.find(q => edits.has(q.id) && !complete(q));
                if (invalid) { current = invalid; render('reason'); return; }
                if (action === 'save' ? !edits.size : edits.size || questions.some(q => !complete(q))) return;
                // Leave room for the command envelope inside the dashboard's 64 KiB limit.
                const responses = [];
                let bytes = 0;
                for (const row of edits.values()) {
                    const response = { ...row, rationale: row.rationale === null ? null : {text: row.rationale.trim()} };
                    bytes += new TextEncoder().encode(JSON.stringify(response)).length + 1;
                    if (bytes > 60000) break;
                    responses.push(response);
                }
                pending = { action, body: { expectedRevision: record.assessment.revision, idempotencyKey: doc.defaultView.crypto.randomUUID(),
                    payload: action === 'save' ? {responses} : {} } };
            }
            const command = pending;
            let moreChanges = false;
            busy = true;
            message = action === 'save' ? 'Saving your answers…' : 'Submitting your answers…';
            render('status');
            try {
                const next = await mutate(endpoint + '/' + action, command.body);
                if (!live()) return;
                const accepted = read(next);
                const expected = new Map(saved);
                for (const row of command.body.payload.responses || []) {
                    expected.set(row.itemId, {...row, rationale: row.rationale?.text ?? null});
                }
                if (next.assessment.revision !== command.body.expectedRevision + 1 || accepted.size !== expected.size ||
                    [...expected.values()].some(row => !same(row, accepted.get(row.itemId))) ||
                    (action === 'save' ? next.assessment.status !== 'in-progress' :
                        next.assessment.status !== 'submitted' || !next.assessment.submission)) throw new Error('unconfirmed');
                saved = accepted;
                for (const row of command.body.payload.responses || []) edits.delete(row.itemId);
                guard();
                record = next;
                pending = null;
                if (action === 'submit') { sealed(); return; }
                moreChanges = edits.size > 0;
                message = moreChanges ? 'Saving your answers…' : 'Progress saved.';
                if (unanswered && complete(current)) current = questions.find(q => !complete(q)) || current;
            } catch (error) {
                if (!live()) return;
                if ([401, 403, 404].includes(error.status)) { stop('This assessment is unavailable.'); return; }
                if (error.status === 409) { stop('This assessment has changed. Reopen it to see the latest saved answers.'); return; }
                if (error.status >= 400 && error.status < 500) {
                    pending = null;
                    message = 'Your changes were declined. Check your answers and try again.';
                } else message = 'The outcome is unconfirmed. Try again to check the same request.';
            } finally {
                busy = false;
                if (live()) render('status');
            }
            if (moreChanges && live()) await write('save');
        }
        container.replaceChildren(view);
        if (['created', 'in-progress'].includes(record.assessment.status)) render();
        else sealed();
        return {
            destroy, hasUnsavedChanges,
            async requestLeave(commit) {
                if (busy) return false;
                if (!closed && pending && !doc.defaultView.confirm('The last request is unconfirmed. Leave and check the saved assessment later?')) return false;
                if (!closed && !pending && edits.size && !doc.defaultView.confirm('Leave and discard your unsaved changes?')) return false;
                commit();
                return true;
            }
        };
    }
    return { mount };
}));
