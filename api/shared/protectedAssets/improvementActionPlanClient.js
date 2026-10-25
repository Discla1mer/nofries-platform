(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./improvementActionPlanView'), require('node:util').types.isProxy);
    else root.NoFriesImprovementActionPlanClient = factory(root.NoFriesImprovementActionPlanView, function () { return false; });
}(typeof globalThis !== 'undefined' ? globalThis : this, function (view, isProxy) {
    'use strict';

    const mounted = new WeakMap(), PAGE_SIZE = 20;
    let fieldFeedbackSequence = 0;
    const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/, SHA = /^[a-f0-9]{64}$/;
    const SUBJECT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const PROFILE = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
    const ACTION_COMMANDS = ['assign', 'start', 'block', 'complete', 'reopen'];
    const ACTION_LABELS = { assign: 'Assign to me', start: 'Start action', block: 'Block action', complete: 'Complete action', reopen: 'Reopen action' };
    const SAVE_LABELS = { assign: 'Save assignment', start: 'Start action', block: 'Record block', complete: 'Record completion', reopen: 'Reopen action' };
    function invalid() { throw new Error('improvement_client_invalid'); }
    function fields(value, names) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
        const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
        if (keys.length !== names.length || keys.some(key => !names.includes(key) ||
            !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) invalid();
        return value;
    }
    function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
    function number(value, maximum) {
        if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > maximum) invalid(); return value;
    }
    function text(value, maximum) { if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid(); return value; }
    function digest(value) { if (typeof value !== 'string' || !SHA.test(value)) invalid(); return value; }
    function unicode(value) {
        for (let index = 0; index < value.length; index++) {
            const unit = value.charCodeAt(index);
            if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
            if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
            }
        }
    }
    function timestamp(value) {
        if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
            !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
    }
    function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) invalid(); timestamp(value + 'T00:00:00.000Z'); }
    function actionField(name, value) {
        if (name === 'dueDate') return date(value);
        if (!['reason', 'note', 'evidenceReference'].includes(name)) invalid();
        text(value, name === 'evidenceReference' ? 180 : 1000); unicode(value);
        if (name === 'evidenceReference') {
            if (value.trim() !== value || /[\u0000-\u001F\u007F]/.test(value) ||
                /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|ftp|file|data|javascript|vbscript):|[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(value)) invalid();
        } else if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) invalid();
    }
    // The host supplies parsed, bounded JSON. Capture own data before an await;
    // CommonJS also rejects proxies without invoking their traps.
    function copy(input, maximum) {
        const seen = new Set(); let nodes = 0, units = 0;
        function visit(value, depth) {
            if (++nodes > 400000 || depth > 32) invalid();
            if (value === null || typeof value === 'boolean') return value;
            if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) invalid(); return value; }
            if (typeof value === 'string') { units += value.length; if (units > maximum) invalid(); unicode(value); return value; }
            if (!value || typeof value !== 'object' || isProxy(value) || seen.has(value)) invalid();
            const array = Array.isArray(value), proto = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
            if (array ? proto !== Array.prototype || value.length > 4096 || keys.length !== value.length + 1 :
                ![Object.prototype, null].includes(proto)) invalid();
            seen.add(value); const result = array ? [] : {};
            for (const key of keys) {
                if (array && key === 'length') continue;
                if (typeof key !== 'string' || array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
                Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
            }
            seen.delete(value); return Object.freeze(result);
        }
        const value = visit(input, 0), encoded = JSON.stringify(value); let bytes = 0;
        for (const character of encoded) { const point = character.codePointAt(0); bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4; }
        if (bytes > maximum) invalid(); return value;
    }
    function source(input) {
        if (input === undefined || input === null) return null;
        const value = fields(copy(input, 4096), ['assessmentId', 'revision', 'revisionSha256', 'profileRef', 'outputSha256']);
        identifier(value.assessmentId); number(value.revision, 128); digest(value.revisionSha256); digest(value.outputSha256);
        fields(value.profileRef, PROFILE);
        PROFILE.forEach(key => key.endsWith('Sha256') ? digest(value.profileRef[key]) : text(value.profileRef[key], 200));
        return value;
    }
    function command(input) {
        const value = fields(copy(input, 16384), ['planId', 'type', 'operationId', 'expectedRevision', 'actionId', 'payload']);
        identifier(value.planId); identifier(value.operationId);
        if (value.type === 'generate') {
            if (value.expectedRevision !== null || value.actionId !== null) invalid();
            fields(value.payload, ['assessmentId', 'assessmentRevision', 'assessmentRevisionSha256']);
            identifier(value.payload.assessmentId); number(value.payload.assessmentRevision, 128); digest(value.payload.assessmentRevisionSha256);
        } else {
            number(value.expectedRevision, 1023); identifier(value.actionId);
            if (value.type === 'assign') {
                fields(value.payload, ['ownerSubjectKey', 'dueDate']);
                if (typeof value.payload.ownerSubjectKey !== 'string' || !SUBJECT.test(value.payload.ownerSubjectKey)) invalid(); actionField('dueDate', value.payload.dueDate);
            } else if (value.type === 'start') fields(value.payload, []);
            else if (['block', 'reopen'].includes(value.type)) {
                actionField('reason', fields(value.payload, ['reason']).reason);
            }
            else if (value.type === 'complete') {
                fields(value.payload, ['note', 'evidenceReference']); actionField('note', value.payload.note); actionField('evidenceReference', value.payload.evidenceReference);
            } else invalid();
        }
        return value;
    }

    function mount(root, options) {
        if (!root || !root.ownerDocument || typeof root.replaceChildren !== 'function' || !options ||
            typeof options.request !== 'function' || typeof options.isCurrent !== 'function' || typeof options.newId !== 'function' ||
            !view || typeof view.mount !== 'function' || typeof view.mountLoading !== 'function') invalid();
        const organisationId = identifier(options.organisationId), initialSource = source(options.sourceAssessment);
        const request = options.request, isCurrent = options.isCurrent, newId = options.newId, doc = root.ownerDocument;
        if (mounted.has(root)) mounted.get(root).destroy();
        let alive = true, denied = false, serial = 0, busy = false, scope = null, rows = [], next = null;
        let selected = null, selectedRevision = null, generatedPlanId = null, pending = null, rendered = null, message = '', controller;
        let model = null, editor = null, selectedAction = null, draft = null, draftForm = null, staleDraft = false;
        const content = doc.createElement('div'); content.className = 'improvement-plan-content';
        function active() {
            if (!alive || mounted.get(root) !== controller) return false;
            let current = false; try { current = isCurrent() === true; } catch (_) { /* No authority is inferred. */ }
            if (!current) { destroy(); return false; } return !denied;
        }
        function node(tag, value) { const item = doc.createElement(tag); if (value !== undefined) item.textContent = value; return item; }
        function button(label, action, disabled) {
            const item = node('button', label); item.type = 'button'; item.className = 'dashboard-button'; item.disabled = !!disabled;
            item.addEventListener('click', function () { if (active() && !item.disabled) action(); }); return item;
        }
        const toolbar = node('section'), status = node('p'), picker = node('select');
        toolbar.className = 'picture-toolbar'; toolbar.setAttribute('aria-label', 'Improvement plan controls');
        status.setAttribute('role', 'status'); picker.setAttribute('aria-label', 'Saved improvement plans');
        picker.addEventListener('change', function () { if (active() && !picker.disabled && picker.value) select(picker.value); });
        const refreshControl = button('Refresh improvement plan', refresh), moreControl = button('More saved plans', function () { readPage(next, true); });
        const createControl = initialSource ? button('Create improvement plan for this assessment', generate) : null;
        const retryControl = button('Retry pending improvement command', retry);
        toolbar.append(picker, refreshControl, moreControl);
        if (initialSource) {
            const selectedSource = node('p', 'Selected saved assessment ' + initialSource.assessmentId + ' · revision ' + initialSource.revision +
                '. These are saved self-reported results; creating a plan does not verify controls or change scores.');
            selectedSource.className = 'ncsc-preserve-text'; toolbar.append(selectedSource, createControl);
        }
        toolbar.append(retryControl);
        const editorPanel = node('section'), actionPicker = node('select'), actionSummary = node('p'), actionControls = node('div'), editorMessage = node('p');
        editorPanel.className = 'dashboard-panel'; editorPanel.setAttribute('aria-label', 'Update an improvement action'); editorPanel.hidden = true;
        actionPicker.setAttribute('aria-label', 'Improvement action'); actionSummary.className = 'ncsc-preserve-text';
        actionControls.className = 'picture-toolbar'; editorMessage.setAttribute('role', 'status');
        const actionPickerRow = node('div'); actionPickerRow.className = 'picture-toolbar'; actionPickerRow.append(actionPicker);
        editorPanel.append(node('h2', 'Update an improvement action'), actionPickerRow, actionSummary, actionControls, editorMessage);
        const actionButtons = Object.fromEntries(ACTION_COMMANDS.map(type => {
            const control = button(ACTION_LABELS[type], function () { openDraft(type); }); control.hidden = true; control.disabled = true;
            actionControls.append(control); return [type, control];
        }));
        actionPicker.addEventListener('change', function () {
            if (!active() || busy || pending || draft || !editor || !model || !editor.actions.some(row => row.actionId === actionPicker.value)) return;
            selectedAction = actionPicker.value; render();
        });
        let focusAfterRead = null;
        function clearView() {
            if (rendered) rendered.destroy(); rendered = null; model = null; editor = null; content.replaceChildren();
        }
        function selectedDetail() { return model && model.actions.find(action => action.actionId === selectedAction); }
        function selectedAuthority() { return editor && editor.actions.find(action => action.actionId === selectedAction); }
        function inControls(element) {
            for (let item = element; item; item = item.parentElement) if (item === toolbar || item === editorPanel) return true;
            return false;
        }
        function renderEditor() {
            const visible = !denied && (model !== null || draft !== null);
            editorPanel.hidden = !visible;
            if (!visible) return;
            const permitted = editor && editor.canWrite === true;
            actionPickerRow.hidden = !permitted || draft !== null;
            if (permitted && !draft) {
                if (!editor.actions.some(row => row.actionId === selectedAction)) selectedAction = editor.actions[0]?.actionId || null;
                actionPicker.replaceChildren();
                model.actions.forEach(action => {
                    const option = node('option', action.controlId + ' · ' + action.labels.kind); option.value = action.actionId; actionPicker.append(option);
                });
                actionPicker.value = selectedAction || ''; actionPicker.disabled = busy || !!pending;
            }
            const detail = selectedDetail(), authority = selectedAuthority();
            actionSummary.textContent = draft ? draft.controlId + ' · ' + draft.work : detail ? detail.controlId + ' · ' + detail.rationale.suggestedAction : '';
            actionSummary.hidden = !draft && !permitted;
            ACTION_COMMANDS.forEach(type => {
                const control = actionButtons[type];
                control.hidden = !!draft || !permitted || !authority || !authority.commands.includes(type);
                control.disabled = busy || !!pending;
            });
            editorMessage.textContent = staleDraft ? 'Plan changed; cancel these changes and refresh.' : !editor ?
                'Action updates are unavailable. Refresh the saved plan to check current access and revision.' : !permitted ?
                    'This plan is read-only for the current access.' : !draft && !editor.actions.some(row => row.commands.length) ?
                        'No action updates are available at this plan revision.' : '';
            if (draftForm) {
                const locked = busy || !!pending || staleDraft || !editor;
                Object.values(draftForm.inputs).forEach(input => { input.disabled = locked; });
                draftForm.save.disabled = locked; draftForm.cancel.disabled = busy || !!pending;
            }
        }
        function openDraft(type) {
            if (!active() || busy || pending || draft || !editor || !editor.canWrite || !model) return false;
            const detail = selectedDetail(), authority = selectedAuthority();
            if (!detail || !authority || !authority.commands.includes(type) || type === 'assign' && editor.ownerChoices.length !== 1) return false;
            draft = { type, actionId: detail.actionId, planId: selected, revision: selectedRevision, controlId: detail.controlId,
                work: detail.rationale.suggestedAction, ownerSubjectKey: type === 'assign' ? editor.ownerChoices[0].subjectKey : null };
            staleDraft = false;
            const form = node('form'); form.setAttribute('aria-label', 'Improvement action update'); form.className = 'ncsc-questionnaire';
            const inputs = {}, feedback = {};
            function input(name, label, kind, maximum, initial) {
                const container = node('label', label), field = node(kind === 'textarea' ? 'textarea' : 'input');
                if (kind !== 'textarea') field.type = kind;
                field.setAttribute('aria-label', label); field.required = true;
                const error = node('span'); error.className = 'dashboard-status-panel'; error.hidden = true;
                error.setAttribute('id', 'improvement-action-field-feedback-' + ++fieldFeedbackSequence);
                if (maximum) field.maxLength = maximum; field.value = initial || '';
                container.append(field, error); form.append(container); inputs[name] = field; feedback[name] = error;
            }
            form.append(node('h3', ACTION_LABELS[type]));
            if (type === 'assign') { form.append(node('p', 'Assign this action to your current eligible membership.')); input('dueDate', 'Due date (UTC)', 'date', null, detail.dueDate); }
            else if (type === 'block') input('reason', 'Block reason', 'textarea', 1000);
            else if (type === 'reopen') input('reason', 'Reopen reason', 'textarea', 1000);
            else if (type === 'complete') {
                input('note', 'Completion note', 'textarea', 1000); input('evidenceReference', 'Completion evidence reference (unverified)', 'text', 180);
                form.append(node('p', 'The evidence reference is an unverified record ID. Workflow completion does not verify the control or change scores.'));
            } else form.append(node('p', 'Start the assigned action using this displayed plan revision.'));
            const save = node('button', SAVE_LABELS[type]); save.type = 'submit'; save.className = 'dashboard-button';
            const cancel = button('Cancel changes', cancelDraft); form.append(save, cancel);
            form.addEventListener('submit', function (event) { event.preventDefault(); submitDraft(); });
            draftForm = { element: form, inputs, feedback, save, cancel }; editorPanel.append(form); render();
            (Object.values(inputs)[0] || save).focus(); return true;
        }
        function removeDraft() {
            if (draftForm) draftForm.element.remove(); draftForm = null; draft = null; staleDraft = false;
        }
        function cancelDraft() {
            if (!active() || busy || pending || !draft) return false;
            const wasStale = staleDraft; removeDraft();
            message = wasStale ? 'Changes cancelled. Refresh the saved plan before making another update.' : 'Action changes cancelled. No command was sent.';
            render(); if (editor && editor.canWrite) actionPicker.focus(); else refreshControl.focus(); return true;
        }
        function authorisedCommand(value) {
            if (!editor || !editor.canWrite || !model || editor.planRevision !== selectedRevision || value.type === 'generate' ||
                value.planId !== selected || value.expectedRevision !== selectedRevision ||
                !editor.actions.some(row => row.actionId === value.actionId && row.commands.includes(value.type)) ||
                value.type === 'assign' && !editor.ownerChoices.some(choice => choice.subjectKey === value.payload.ownerSubjectKey)) invalid();
        }
        function submitDraft() {
            if (!active() || busy || pending || !draft || !draftForm || staleDraft || !editor) return Promise.resolve(false);
            Object.entries(draftForm.inputs).forEach(([key, input]) => {
                input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
                draftForm.feedback[key].textContent = ''; draftForm.feedback[key].hidden = true;
            });
            for (const [key, input] of Object.entries(draftForm.inputs)) {
                try { actionField(key, input.value); }
                catch (_) {
                    message = key === 'dueDate' ? 'Enter a valid due date in UTC (YYYY-MM-DD), then save again.' :
                        key === 'evidenceReference' ? 'Enter an unverified record ID of up to 180 characters without surrounding spaces. URLs and file paths cannot be used.' :
                            'Enter a ' + (key === 'note' ? 'completion note' : draft.type === 'block' ? 'block reason' : 'reopen reason') +
                            ' of up to 1000 characters using plain text, then save again.';
                    const feedback = draftForm.feedback[key]; feedback.textContent = message; feedback.hidden = false;
                    input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', feedback.getAttribute('id'));
                    render(); input.focus(); return Promise.resolve(false);
                }
            }
            try {
                const values = Object.fromEntries(Object.entries(draftForm.inputs).map(([key, input]) => [key, input.value]));
                const payload = draft.type === 'assign' ? { ownerSubjectKey: draft.ownerSubjectKey, dueDate: values.dueDate } : values;
                const checked = command({ planId: draft.planId, type: draft.type, operationId: 'validate-action-details',
                    expectedRevision: draft.revision, actionId: draft.actionId, payload });
                authorisedCommand(checked);
                pending = command({ ...checked, operationId: identifier(newId()) });
            } catch (_) {
                message = 'Complete the required action details using a UTC date or an unverified record ID, then save again.'; render(); return Promise.resolve(false);
            }
            return submit();
        }
        function render() {
            if (!alive || mounted.get(root) !== controller) return;
            status.textContent = message;
            if (busy && !focusAfterRead) {
                if (inControls(doc.activeElement)) focusAfterRead = doc.activeElement;
            }
            if (!denied) {
                picker.disabled = busy || !!pending || !!draft;
                const available = rows.slice();
                if (selected !== null && !available.some(row => row.planId === selected)) available.unshift({ planId: selected, planRevision: selectedRevision });
                picker.replaceChildren(node('option', 'Choose a saved improvement plan')); picker.children[0].value = '';
                available.forEach(row => { const option = node('option', row.planId + ' · revision ' + row.planRevision); option.value = row.planId; picker.append(option); });
                picker.value = selected || ''; refreshControl.disabled = busy || !!pending || !!draft;
                moreControl.hidden = next === null; moreControl.disabled = busy || !!pending || !!draft;
                if (createControl) createControl.disabled = busy || !!pending || !!draft || scope === null;
                retryControl.hidden = !pending || busy; retryControl.disabled = busy;
                renderEditor();
                if (!busy && focusAfterRead) {
                    if (!doc.activeElement || doc.activeElement === doc.body || doc.activeElement === focusAfterRead) {
                        const target = inControls(focusAfterRead) && !focusAfterRead.disabled && !focusAfterRead.hidden ? focusAfterRead :
                            !retryControl.hidden ? retryControl : draftForm && !draftForm.cancel.disabled ? draftForm.cancel :
                                !editorPanel.hidden && editor && editor.canWrite ? actionPicker : picker;
                        if (!target.disabled) target.focus();
                    }
                    focusAfterRead = null;
                }
            } else { toolbar.remove(); editorPanel.remove(); }
        }
        function unavailable(status, uncertain) {
            clearView();
            if (status === 401 || status === 403) {
                denied = true; pending = null; rows = []; selected = null; selectedRevision = null; scope = null; removeDraft();
                focusAfterRead = null;
                message = 'Improvement Plan access is unavailable. Reopen the dashboard to check the current organisation and access.';
            } else message = uncertain ? 'The command outcome is unconfirmed. Retry the same pending command before leaving.' :
                'Improvement Plan is unavailable. Refresh to try the current saved state again.';
            render();
        }
        function checkedScope(value) {
            fields(value, ['tenantId', 'organisationId']); identifier(value.tenantId); identifier(value.organisationId);
            if (value.organisationId !== organisationId || scope && (value.tenantId !== scope.tenantId || value.organisationId !== scope.organisationId)) invalid();
        }
        function page(input, after) {
            const value = fields(copy(input, 32768), ['schemaVersion', 'scope', 'asOf', 'plans', 'nextAfterPlanId']);
            if (value.schemaVersion !== 1 || !Array.isArray(value.plans) || value.plans.length > PAGE_SIZE) invalid();
            checkedScope(value.scope); timestamp(value.asOf); let previous = after;
            value.plans.forEach(row => {
                fields(row, ['planId', 'planRevision']); identifier(row.planId); number(row.planRevision, 1024);
                if (previous !== null && row.planId <= previous) invalid(); previous = row.planId;
            });
            if (value.nextAfterPlanId !== null && (value.plans.length !== PAGE_SIZE || identifier(value.nextAfterPlanId) !== previous)) invalid();
            return value;
        }
        function response(result) {
            fields(result, ['status', 'value']); number(result.status, 599); if (result.status < 100) invalid(); return result;
        }
        function editorContext(input, displayed) {
            const value = fields(copy(input, 1048576), ['schemaVersion', 'scope', 'planRevision', 'asOf', 'canWrite', 'ownerChoices', 'actions']);
            if (value.schemaVersion !== 1 || typeof value.canWrite !== 'boolean' || !Array.isArray(value.ownerChoices) || value.ownerChoices.length > 1 ||
                !Array.isArray(value.actions) || value.actions.length !== displayed.actions.length) invalid();
            fields(value.scope, ['tenantId', 'organisationId', 'planId']); checkedScope({ tenantId: value.scope.tenantId, organisationId: value.scope.organisationId });
            if (value.scope.planId !== displayed.scope.planId || value.planRevision !== displayed.planRevision) invalid();
            number(value.planRevision, 1024); timestamp(value.asOf); if (value.asOf < displayed.asOf) invalid();
            value.ownerChoices.forEach(choice => {
                fields(choice, ['subjectKey', 'label']);
                if (typeof choice.subjectKey !== 'string' || !SUBJECT.test(choice.subjectKey) || choice.label !== 'Assign to me') invalid();
            });
            if (!value.canWrite && value.ownerChoices.length) invalid();
            const remaining = new Set(displayed.actions.map(action => action.actionId));
            value.actions.forEach(action => {
                fields(action, ['actionId', 'commands']); identifier(action.actionId);
                if (!remaining.delete(action.actionId) || !Array.isArray(action.commands) || action.commands.length > ACTION_COMMANDS.length ||
                    new Set(action.commands).size !== action.commands.length || action.commands.some(type => !ACTION_COMMANDS.includes(type)) ||
                    (!value.canWrite || value.planRevision === 1024) && action.commands.length ||
                    action.commands.includes('assign') && value.ownerChoices.length !== 1) invalid();
            });
            if (remaining.size) invalid(); return value;
        }
        async function readPage(after, more) {
            if (!active() || busy || pending || draft) return false;
            const token = ++serial; busy = true; message = 'Loading saved improvement plans…';
            if (!more) { clearView(); rendered = view.mountLoading(content); } render();
            try {
                const result = response(await request('/api/dashboard/improvement/plans?limit=' + PAGE_SIZE + (after === null ? '' : '&afterPlanId=' + encodeURIComponent(after))));
                if (!active() || token !== serial) return false;
                if (result.status !== 200) { unavailable(result.status, false); return false; }
                const value = page(result.value, after); scope = value.scope; rows = value.plans; next = value.nextAfterPlanId;
                message = rows.length ? 'Choose a saved plan or refresh the selected plan.' : 'No saved improvement plans are available for this organisation.';
                if (!more) clearView();
                busy = false; render();
                if (!more && (selected !== null || !initialSource && rows.length)) return readView(selected || rows[0].planId);
                return true;
            } catch (_) { if (active() && token === serial) unavailable(null, false); return false; }
            finally { if (alive && token === serial) { busy = false; render(); } }
        }
        async function readView(planId) {
            if (!active() || busy || pending || draft || scope === null) return false;
            const token = ++serial; busy = true; clearView(); rendered = view.mountLoading(content); message = 'Loading improvement actions…'; render();
            try {
                const result = response(await request('/api/dashboard/improvement/view?planId=' + encodeURIComponent(planId)));
                if (!active() || token !== serial) return false;
                if (result.status !== 200) { unavailable(result.status, false); return false; }
                const value = fields(copy(result.value, 8388608), ['schemaVersion', 'scope', 'planRevision', 'updatedAt', 'asOf',
                    'dueDateBasis', 'source', 'priority', 'order', 'filters', 'counts', 'actions', 'presentationVersion', 'notices']);
                fields(value.scope, ['tenantId', 'organisationId', 'planId']);
                checkedScope({ tenantId: value.scope.tenantId, organisationId: value.scope.organisationId });
                if (value.schemaVersion !== 1 || value.presentationVersion !== 1 || value.scope.planId !== planId) invalid();
                number(value.planRevision, 1024);
                if (!Array.isArray(value.actions) || value.actions.length > 4096) invalid();
                const actionIds = new Set();
                value.actions.forEach(action => {
                    identifier(action.actionId); if (actionIds.has(action.actionId)) invalid(); actionIds.add(action.actionId);
                    text(action.controlId, 180); text(action.labels.kind, 180); text(action.rationale.suggestedAction, 1000);
                    if (action.dueDate !== null) date(action.dueDate);
                });
                if (generatedPlanId === planId && (!value.source || value.source.assessmentId !== initialSource.assessmentId ||
                    value.source.evaluationOutputSha256 !== initialSource.outputSha256)) invalid();
                selected = planId; selectedRevision = value.planRevision; clearView(); rendered = view.mount(content, value);
                // The reused renderer withholds invalid presentations. An editor
                // is offered only beside its successfully rendered plan panel.
                if (!Array.from(content.querySelectorAll('section')).some(section => section.getAttribute('aria-label') === 'Improvement action plan')) invalid();
                model = value; message = 'Checking current action options…'; render();
                const editorResult = response(await request('/api/dashboard/improvement/editor?planId=' + encodeURIComponent(planId)));
                if (!active() || token !== serial) return false;
                if (editorResult.status !== 200) {
                    if (editorResult.status === 401 || editorResult.status === 403) unavailable(editorResult.status, false);
                    else { editor = null; message = 'The saved plan is visible, but current action options are unavailable. Refresh to try again.'; render(); }
                    return false;
                }
                editor = editorContext(editorResult.value, model);
                if (!editor.actions.some(action => action.actionId === selectedAction)) selectedAction = editor.actions[0]?.actionId || null;
                message = 'Saved plan and current action options loaded.'; render(); return true;
            } catch (_) { if (active() && token === serial) unavailable(null, false); return false; }
            finally { if (alive && token === serial) { busy = false; render(); } }
        }
        function refresh() { return readPage(null, false); }
        function select(planId) {
            if (!active() || busy || pending || draft || !rows.some(row => row.planId === planId) && planId !== selected) return Promise.resolve(false);
            return readView(planId);
        }
        async function submit() {
            if (!active() || busy || pending === null || scope === null) return false;
            const token = ++serial, captured = pending; busy = true; message = 'Sending the retained improvement command…'; render();
            try {
                const result = response(await request('/api/dashboard/improvement/execute', captured));
                if (!active() || token !== serial || pending !== captured) return false;
                if (result.status !== 200) {
                    if (result.status >= 400 && result.status < 500) pending = null;
                    if (result.status === 409) {
                        staleDraft = draft !== null; editor = null;
                        message = draft ? 'Plan changed; cancel these changes and refresh.' : 'Plan changed. Refresh the saved plan before making another update.';
                        render(); return false;
                    }
                    unavailable(result.status, pending !== null); return false;
                }
                const value = fields(copy(result.value, 8388608), ['schemaVersion', 'plan']);
                if (value.schemaVersion !== 1 || !value.plan || value.plan.planId !== captured.planId ||
                    value.plan.tenantId !== scope.tenantId || value.plan.organisationId !== scope.organisationId ||
                    value.plan.revision !== (captured.expectedRevision === null ? 0 : captured.expectedRevision + 1)) invalid();
                if (captured.type === 'generate') generatedPlanId = captured.planId;
                pending = null; removeDraft(); selected = captured.planId; selectedRevision = value.plan.revision; busy = false;
                return readView(selected);
            } catch (_) { if (active() && token === serial) unavailable(null, pending !== null); return false; }
            finally { if (alive && token === serial) { busy = false; render(); } }
        }
        function generate() {
            if (!active() || busy || pending || draft || !initialSource || scope === null) return Promise.resolve(false);
            try {
                const planId = identifier(newId()), operationId = identifier(newId()); if (planId === operationId) invalid();
                pending = command({ planId, type: 'generate', operationId, expectedRevision: null, actionId: null,
                    payload: { assessmentId: initialSource.assessmentId, assessmentRevision: initialSource.revision,
                        assessmentRevisionSha256: initialSource.revisionSha256 } });
            } catch (_) { unavailable(null, false); return Promise.resolve(false); }
            return submit();
        }
        function execute(input) {
            if (!active() || busy || pending || draft || selected === null || selectedRevision === null) return Promise.resolve(false);
            try {
                const value = command(input);
                authorisedCommand(value);
                pending = value;
            } catch (_) { unavailable(null, false); return Promise.resolve(false); }
            return submit();
        }
        function retry() { return submit(); }
        function destroy() {
            if (!alive) return; alive = false; serial++; pending = null; scope = null; rows = []; selectedAction = null; focusAfterRead = null; removeDraft(); clearView();
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        }
        function requestLeave(commit) {
            if (!active() || typeof commit !== 'function') return Promise.resolve(false);
            if (pending) { message = 'Resolve the pending improvement command before leaving. Retry uses the same command identity.'; render(); return Promise.resolve(false); }
            if (draft) { message = 'Save or cancel the action changes before leaving.'; render(); return Promise.resolve(false); }
            return Promise.resolve().then(function () { if (!active()) return false; commit(); return true; });
        }
        let resolveReady;
        const ready = new Promise(resolve => { resolveReady = resolve; });
        controller = Object.freeze({ ready, destroy, requestLeave, refresh, select, generate, execute, retry });
        mounted.set(root, controller); root.replaceChildren(toolbar, status, editorPanel, content); render();
        readPage(null, false).then(resolveReady, function () { resolveReady(false); });
        return controller;
    }
    return Object.freeze({ mount });
}));
