(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesPaidCollection = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function mount(root, { ref, element, button, back, host, win }) {
        const collection = host.prefix + '/assessments';
        async function readPage(after) {
            const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
            if (after !== null && !id.test(after)) throw host.invalid();
            const path = '/assessments' + (after === null ? '' : '?afterAssessmentId=' + encodeURIComponent(after));
            const page = await host.request(path);
            if (!host.fields(page, ['schemaVersion', 'publication', 'assessments', 'nextAfterAssessmentId']) || page.schemaVersion !== 1 ||
                page.publication?.status !== 'published' || page.publication.profile?.id !== ref.profileId ||
                page.publication.profile.version !== ref.version || !Array.isArray(page.assessments) || page.assessments.length > 25) throw host.invalid();
            let previous = after;
            for (const row of page.assessments) {
                if (!host.fields(row, ['assessmentId', 'status', 'revision', 'updatedAt']) || typeof row.assessmentId !== 'string' ||
                    !id.test(row.assessmentId) || previous !== null && row.assessmentId <= previous ||
                    !['created', 'in-progress', 'submitted', 'reviewed', 'archived'].includes(row.status) ||
                    !Number.isSafeInteger(row.revision) || row.revision < 0 || !host.canonicalDate(row.updatedAt)) throw host.invalid();
                previous = row.assessmentId;
            }
            if (page.nextAfterAssessmentId !== null && (!page.assessments.length || page.nextAfterAssessmentId !== previous)) throw host.invalid();
            return page;
        }
        async function readRecord(id, action, body) {
            if (!host.live() || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) throw host.invalid();
            const detail = collection + '/' + encodeURIComponent(id);
            const path = action === 'start' ? collection : action === 'read' ? detail : action;
            if (action !== 'start' && action !== 'read' && path !== detail + '/save' && path !== detail + '/submit') throw host.invalid();
            const envelope = await host.request(path.slice(host.prefix.length), body), item = envelope?.assessment;
            if (envelope.schemaVersion !== 1 || item?.assessmentId !== id || item.moduleId !== ref.moduleId ||
                item.profileRef?.profileId !== ref.profileId || item.profileRef.profileVersion !== ref.version) throw host.invalid();
            return envelope;
        }

        const heading = element('h2', '', ref.label); heading.tabIndex = -1;
        const list = element('ul', 'ncsc-assessment-list'), status = element('p');
        status.setAttribute('role', 'status');
        const more = button('Load more assessments', function () { load(cursor); }, 'dashboard-button dashboard-button-secondary');
        more.hidden = true;
        root.replaceChildren(back, heading, status, list, more); heading.focus();
        const states = { created: 'Started', 'in-progress': 'In progress', submitted: 'Submitted', reviewed: 'Reviewed', archived: 'Archived' };
        let disposed = false, cursor = null;
        let publication = null, mounted = null, busy = false, listing = false, pending = null, startDispatched = false;
        const controls = element('div', 'ncsc-questionnaire'), display = element('div');
        root.append(controls, display);
        const controller = { destroy() {
            disposed = true; if (mounted) mounted.destroy();
            publication = null; pending = null; root.replaceChildren();
        }, requestLeave(commit) {
            if (busy) return Promise.resolve(false);
            if (mounted && mounted.requestLeave) return mounted.requestLeave(commit);
            if (pending && !win.confirm('Leave and check the saved assessment later?')) return Promise.resolve(false);
            commit(); return Promise.resolve(true);
        } };
        function unavailable() {
            if (disposed) return;
            if (mounted) { mounted.destroy(); mounted = null; }
            heading.hidden = false;
            list.replaceChildren(); controls.replaceChildren(); display.replaceChildren(); more.hidden = true; pending = null;
            status.textContent = 'This assessment is unavailable. Return to the assessment choices to try again.';
        }
        function focusRecord() {
            const title = display.querySelector('h1, h2');
            if (title) { heading.hidden = true; title.tabIndex = -1; title.focus(); }
        }
        async function showRecord(id, start) {
            if (busy || listing || !host.live() || (pending && start !== pending)) return;
            busy = true;
            try {
                // For a new run prove the renderer is available before creating a record.
                const form = start ? await host.renderer('questionnaire') : null;
                if (start) startDispatched = true;
                const record = await readRecord(id, start ? 'start' : 'read', start || undefined);
                pending = null;
                const results = async sealed => {
                    const factory = await host.renderer('results');
                    if (!host.live()) return;
                    mounted = factory.mount(display, { record: sealed, publication, isCurrent: host.live });
                    focusRecord();
                };
                if (!host.editable && !record.assessment.submission) { unavailable(); return; }
                list.replaceChildren(); controls.replaceChildren(); more.hidden = true; status.textContent = '';
                if (record.assessment.submission) await results(record);
                else {
                    const factory = form || await host.renderer('questionnaire');
                    if (!host.live()) return;
                    mounted = factory.mount(display, { record, publication, isCurrent: host.live,
                        mutate: (path, body) => readRecord(id, path, body),
                        showResults: sealed => { results(sealed).catch(unavailable); } });
                    focusRecord();
                }
            } catch (error) {
                if (disposed) return;
                if (pending && startDispatched && (error.status === undefined || error.status >= 500)) {
                    status.textContent = 'The start could not be confirmed. Try again to check the same request.';
                } else unavailable();
            } finally { busy = false; }
        }
        function startControls() {
            const label = element('label', '', 'What part of your organisation will you assess?');
            const scope = element('textarea'); scope.maxLength = 4000; label.append(scope);
            const start = button('Start assessment', () => {
                if (busy || listing || !host.live()) return;
                if (!scope.value.trim()) { status.textContent = 'Describe the scope before you start.'; scope.focus(); return; }
                if (!pending) pending = { assessmentId: host.newId(), idempotencyKey: host.newId(), expectedRevision: null,
                    payload: { scopePopulation: { description: scope.value.trim() } } };
                scope.disabled = true; showRecord(pending.assessmentId, pending);
            });
            controls.replaceChildren(label, start);
        }
        async function load(after) {
            if (listing || busy || pending) return;
            listing = true; more.disabled = true; status.textContent = 'Loading assessments…';
            try {
                const page = await readPage(after);
                if (disposed) return;
                publication ||= page.publication;
                for (const row of page.assessments) {
                    const item = element('li', 'ncsc-assessment-card');
                    item.append(element('strong', '', states[row.status]), element('p', '', 'Last saved ' + row.updatedAt.slice(0, 10) + ' UTC'),
                        element('p', 'ncsc-preserve-text', 'Assessment reference: ' + row.assessmentId));
                    if (row.status === 'submitted' || host.editable && ['created', 'in-progress'].includes(row.status)) {
                        item.append(button(row.status === 'submitted' ? 'View results' : 'Resume assessment', () => showRecord(row.assessmentId)));
                    }
                    list.append(item);
                }
                cursor = page.nextAfterAssessmentId;
                more.hidden = cursor === null; more.disabled = false;
                if (after === null && host.editable) startControls();
                status.textContent = list.children.length ? '' : 'No saved assessments yet.';
            } catch (_) {
                if (disposed) return;
                unavailable();
            } finally { listing = false; }
        }
        load(null);
        return controller;
    }
    return Object.freeze({ mount });
}));
