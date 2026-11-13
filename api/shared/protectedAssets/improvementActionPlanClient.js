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
    // assignNamed is a second way to send the existing assign command.
    const ACTION_BUTTONS = ['assignNamed', 'assign', 'start', 'block', 'complete', 'reopen'];
    const ACTION_LABELS = { assignNamed: 'Set owner and due date', assign: 'Assign to me', start: 'Start action', block: 'Block action',
        complete: 'Complete action', reopen: 'Reopen action' };
    const SAVE_LABELS = { assignNamed: 'Save owner and due date', assign: 'Save assignment', start: 'Start action', block: 'Record block',
        complete: 'Record completion', reopen: 'Reopen action' };
    const OWNER_LABEL_HELP = 'Enter the owner’s name in 1 to 80 characters. Use a name rather than an email address, ' +
        'and not the words “all” or “unassigned”.';
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
    function ownerLabel(value) {
        if (!view || typeof view.normaliseOwnerLabel !== 'function') invalid();
        try { return view.normaliseOwnerLabel(value); } catch (_) { return invalid(); }
    }
    const labelled = value => !!value && typeof value === 'object' && Object.hasOwn(value, 'ownerLabel');
    function actionField(name, value) {
        if (name === 'dueDate' || name === 'nextReviewDate') return date(value);
        if (name === 'ownerLabel') return ownerLabel(value);
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
    // The host's latest submitted assessment, offered when no plan exists yet.
    // It carries no output digest; the server still binds the exact revision.
    function latestSource(input) {
        if (input === undefined || input === null) return null;
        const value = fields(copy(input, 4096), ['assessmentId', 'revision', 'revisionSha256', 'profileRef', 'submittedAt']);
        identifier(value.assessmentId); number(value.revision, 128); digest(value.revisionSha256); timestamp(value.submittedAt);
        fields(value.profileRef, PROFILE);
        PROFILE.forEach(key => key.endsWith('Sha256') ? digest(value.profileRef[key]) : text(value.profileRef[key], 200));
        return value;
    }
    const NZ_ZONE = 'Pacific/Auckland';
    function nzDateTime(value) {
        try {
            return new Intl.DateTimeFormat('en-NZ', { timeZone: NZ_ZONE, day: 'numeric', month: 'short', year: 'numeric',
                hour: 'numeric', minute: '2-digit' }).format(new Date(value));
        } catch (_) { return value.slice(0, 10); }
    }
    function nzTime(value) {
        try { return new Intl.DateTimeFormat('en-NZ', { timeZone: NZ_ZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
        catch (_) { return value.slice(11, 16) + ' UTC'; }
    }
    function actionTarget(input) {
        if (input === undefined || input === null) return null;
        const value = fields(copy(input, 4096), ['planId', 'actionId', 'planRevision']);
        identifier(value.planId); identifier(value.actionId); number(value.planRevision, 1024);
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
            if (value.type === 'assign' && labelled(value.payload)) {
                fields(value.payload, ['ownerLabel', 'dueDate']);
                if (ownerLabel(value.payload.ownerLabel) !== value.payload.ownerLabel) invalid(); actionField('dueDate', value.payload.dueDate);
            } else if (value.type === 'assign') {
                fields(value.payload, ['ownerSubjectKey', 'dueDate']);
                if (typeof value.payload.ownerSubjectKey !== 'string' || !SUBJECT.test(value.payload.ownerSubjectKey)) invalid(); actionField('dueDate', value.payload.dueDate);
            } else if (value.type === 'start') fields(value.payload, []);
            else if (['block', 'reopen'].includes(value.type)) {
                actionField('reason', fields(value.payload, ['reason']).reason);
            }
            else if (value.type === 'complete') {
                fields(value.payload, ['note', 'evidenceReference', ...(Object.hasOwn(value.payload || {}, 'nextReviewDate') ? ['nextReviewDate'] : [])]);
                actionField('note', value.payload.note); actionField('evidenceReference', value.payload.evidenceReference);
                if (Object.hasOwn(value.payload, 'nextReviewDate')) actionField('nextReviewDate', value.payload.nextReviewDate);
            } else invalid();
        }
        return value;
    }

    // Optional host catalogue titles (control ID → plain title). Bounded text only.
    function titlesOption(input) {
        if (input === undefined || input === null) return null;
        const value = copy(input, 65536);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) invalid();
        Object.keys(value).forEach(key => { identifier(key); text(value[key], 200); });
        return value;
    }
    function mount(root, options) {
        if (!root || !root.ownerDocument || typeof root.replaceChildren !== 'function' || !options ||
            typeof options.request !== 'function' || typeof options.isCurrent !== 'function' || typeof options.newId !== 'function' ||
            !view || typeof view.mount !== 'function' || typeof view.mountLoading !== 'function' ||
            options.onAccepted !== undefined && typeof options.onAccepted !== 'function') invalid();
        const organisationId = identifier(options.organisationId), initialSource = source(options.sourceAssessment);
        let target = actionTarget(options.initialTarget);
        const request = options.request, isCurrent = options.isCurrent, newId = options.newId, doc = root.ownerDocument;
        // Reported only after a response has passed this client's validation.
        // A display hint for the host ("Information as at"); it grants nothing.
        const accepted = () => { if (options.onAccepted) { try { options.onAccepted(); } catch (_) { /* Display only. */ } } };
        let controlTitles = null;
        try { controlTitles = titlesOption(options.controlTitles); } catch (_) { controlTitles = null; /* Codes remain the fallback names. */ }
        let currentOwner = null;
        const actionName = action => typeof view.actionTitle === 'function' ? view.actionTitle(action, controlTitles) : action.controlId + ' · ' + action.labels.kind;
        const viewOptions = () => ({ actionEditorAbove: true, ...(controlTitles ? { controlTitles } : {}), ...(currentOwner ? { currentOwner } : {}) });
        const readLatest = !initialSource && typeof options.latestSource === 'function' ? options.latestSource : null;
        let latest = null, pageAsOf = null;
        const day = value => typeof view.calendarDay === 'function' ? view.calendarDay(value) : value || 'Not set';
        const when = value => typeof view.nzDateTime === 'function' ? view.nzDateTime(value) : value;
        // Plain plan names, learned from each plan's validated view. Plans not
        // yet opened are numbered by their place in the list.
        const planNames = new Map();
        const sourcePlanId = initialSource ? identifier('overview-plan-' + initialSource.revisionSha256) : null;
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
        const existingNote = node('p', 'A plan already exists for this assessment, so it is shown below.'); existingNote.hidden = true;
        const createControl = initialSource ? button('Create improvement plan for this assessment', generate) : null;
        const retryControl = button('Retry pending improvement command', retry);
        toolbar.append(picker, refreshControl, moreControl);
        if (initialSource) {
            const selectedSource = node('p', 'Plan for the assessment you chose on Overview. ' +
                'It uses your saved self-reported answers; creating a plan does not check controls or change your results.');
            selectedSource.className = 'ncsc-preserve-text'; toolbar.append(selectedSource, createControl, existingNote);
        }
        toolbar.append(retryControl);
        const editorPanel = node('section'), actionPicker = node('select'), actionSummary = node('p'), actionState = node('p');
        const actionControls = node('div'), editorMessage = node('p');
        editorPanel.className = 'dashboard-panel'; editorPanel.setAttribute('aria-label', 'Update an improvement action'); editorPanel.hidden = true;
        actionPicker.setAttribute('aria-label', 'Improvement action'); actionSummary.className = 'ncsc-preserve-text';
        actionControls.className = 'picture-toolbar'; editorMessage.setAttribute('role', 'status');
        const actionPickerRow = node('div'); actionPickerRow.className = 'picture-toolbar'; actionPickerRow.append(actionPicker);
        editorPanel.append(node('h2', 'Update an improvement action'), actionPickerRow, actionSummary, actionState, actionControls, editorMessage);
        const actionButtons = Object.fromEntries(ACTION_BUTTONS.map(type => {
            const control = button(ACTION_LABELS[type], function () { openDraft(type); }); control.hidden = true; control.disabled = true;
            actionControls.append(control); return [type, control];
        }));
        actionPicker.addEventListener('change', function () {
            if (!active() || busy || pending || draft || !editor || !model || !editor.actions.some(row => row.actionId === actionPicker.value)) return;
            target = null; selectedAction = actionPicker.value; render();
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
                    const option = node('option', actionName(action)); option.value = action.actionId; actionPicker.append(option);
                });
                actionPicker.value = selectedAction || ''; actionPicker.disabled = busy || !!pending;
            }
            const detail = selectedDetail(), authority = selectedAuthority();
            actionSummary.textContent = draft ? draft.name + ': ' + draft.work : detail ? actionName(detail) + ': ' + detail.rationale.suggestedAction : '';
            actionSummary.hidden = !draft && !permitted;
            actionState.textContent = detail ? 'Status: ' + detail.labels.status + '. Owner: ' + (labelled(detail) ? detail.ownerLabel :
                detail.ownerSubjectKey === null ? 'not set' : typeof currentOwner !== 'string' ? 'someone in your organisation' :
                detail.ownerSubjectKey === currentOwner ? 'you' : 'someone else in your organisation') + '. Due date: ' + day(detail.dueDate) + '.' : '';
            actionState.hidden = !!draft || !permitted || !detail;
            ACTION_BUTTONS.forEach(type => {
                const control = actionButtons[type], command = type === 'assignNamed' ? 'assign' : type;
                control.hidden = !!draft || !permitted || !authority || !authority.commands.includes(command) ||
                    type === 'assign' && editor.ownerChoices.length !== 1;
                control.disabled = busy || !!pending;
            });
            editorMessage.textContent = staleDraft ? 'Plan changed; cancel these changes and refresh.' : !editor && busy ?
                'Checking what you can change…' : !editor ?
                'Action updates are unavailable. Refresh the saved plan to check current access and revision.' : !permitted ?
                    'This plan is read-only for the current access.' : !draft && !editor.actions.some(row => row.commands.length) ?
                        'No action updates are available at this plan revision.' : '';
            if (draftForm) {
                const locked = busy || !!pending || staleDraft || !editor;
                Object.values(draftForm.inputs).forEach(input => { input.disabled = locked; });
                draftForm.save.disabled = locked; draftForm.cancel.disabled = busy || !!pending;
            }
        }
        function openDraft(choice) {
            if (!active() || busy || pending || draft || !editor || !editor.canWrite || !model) return false;
            const detail = selectedDetail(), authority = selectedAuthority(), named = choice === 'assignNamed', type = named ? 'assign' : choice;
            if (!detail || !authority || !authority.commands.includes(type) || choice === 'assign' && editor.ownerChoices.length !== 1) return false;
            draft = { type, named, actionId: detail.actionId, planId: selected, revision: selectedRevision, controlId: detail.controlId, name: actionName(detail),
                work: detail.rationale.suggestedAction, ownerSubjectKey: choice === 'assign' ? editor.ownerChoices[0].subjectKey : null };
            staleDraft = false;
            const form = node('form'); form.setAttribute('aria-label', 'Improvement action update'); form.className = 'ncsc-questionnaire improvement-action-form';
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
            form.append(node('h3', ACTION_LABELS[choice]));
            if (named) {
                form.append(node('p', 'Name the person responsible for this action. They do not need a No Fries account.'));
                input('ownerLabel', 'Owner name', 'text', 80, labelled(detail) ? detail.ownerLabel : '');
                inputs.ownerLabel.autocomplete = 'off'; input('dueDate', 'Due date', 'date', null, detail.dueDate);
            } else if (type === 'assign') { form.append(node('p', 'Assign this action to your current eligible membership.')); input('dueDate', 'Due date', 'date', null, detail.dueDate); }
            else if (type === 'block') input('reason', 'Block reason', 'textarea', 1000);
            else if (type === 'reopen') input('reason', 'Reopen reason', 'textarea', 1000);
            else if (type === 'complete') {
                input('note', 'Completion note', 'textarea', 1000); input('evidenceReference', 'Completion evidence reference (unverified)', 'text', 180);
                input('nextReviewDate', 'Next review date (optional)', 'date'); inputs.nextReviewDate.required = false;
                inputs.nextReviewDate.min = model.asOf.slice(0, 10);
                form.append(node('p', 'Choose today or a later date to review the completed work and evidence. This records a date, not a reminder or verification.'));
                form.append(node('p', 'The evidence reference is an unverified record ID. Workflow completion does not verify the control or change scores.'));
            } else form.append(node('p', 'Start the assigned action using this displayed plan revision.'));
            const save = node('button', SAVE_LABELS[choice]); save.type = 'submit'; save.className = 'dashboard-button';
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
                value.type === 'assign' && !labelled(value.payload) &&
                    !editor.ownerChoices.some(choice => choice.subjectKey === value.payload.ownerSubjectKey)) invalid();
        }
        function fieldError(key, text) {
            const input = draftForm.inputs[key], feedback = draftForm.feedback[key];
            message = text; feedback.textContent = text; feedback.hidden = false;
            input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', feedback.getAttribute('id'));
            render(); input.focus();
        }
        function submitDraft() {
            if (!active() || busy || pending || !draft || !draftForm || staleDraft || !editor) return Promise.resolve(false);
            Object.entries(draftForm.inputs).forEach(([key, input]) => {
                input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
                draftForm.feedback[key].textContent = ''; draftForm.feedback[key].hidden = true;
            });
            for (const [key, input] of Object.entries(draftForm.inputs)) {
                try {
                    if (key === 'nextReviewDate' && input.value === '') continue;
                    actionField(key, input.value);
                    if (key === 'nextReviewDate' && input.value < model.asOf.slice(0, 10)) invalid();
                }
                catch (_) {
                    fieldError(key, key === 'ownerLabel' ? OWNER_LABEL_HELP : key === 'nextReviewDate' ? 'Choose today or a later review date, or leave it empty.' : key === 'dueDate' ? 'Enter a valid due date, then save again.' :
                        key === 'evidenceReference' ? 'Enter an unverified record ID of up to 180 characters without surrounding spaces. URLs and file paths cannot be used.' :
                            'Enter a ' + (key === 'note' ? 'completion note' : draft.type === 'block' ? 'block reason' : 'reopen reason') +
                            ' of up to 1000 characters using plain text, then save again.'); return Promise.resolve(false);
                }
            }
            try {
                const values = Object.fromEntries(Object.entries(draftForm.inputs).map(([key, input]) => [key, input.value]));
                if (values.nextReviewDate === '') delete values.nextReviewDate;
                const payload = draft.named ? { ownerLabel: ownerLabel(values.ownerLabel), dueDate: values.dueDate } :
                    draft.type === 'assign' ? { ownerSubjectKey: draft.ownerSubjectKey, dueDate: values.dueDate } : values;
                const checked = command({ planId: draft.planId, type: draft.type, operationId: 'validate-action-details',
                    expectedRevision: draft.revision, actionId: draft.actionId, payload });
                authorisedCommand(checked);
                pending = command({ ...checked, operationId: identifier(newId()) });
            } catch (_) {
                message = 'Complete the required action details, then save again.'; render(); return Promise.resolve(false);
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
                picker.replaceChildren(node('option', 'Choose a plan')); picker.children[0].value = '';
                available.forEach((row, index) => {
                    const option = node('option', planNames.get(row.planId) || 'Saved plan ' + (index + 1)); option.value = row.planId; picker.append(option);
                });
                picker.value = selected || ''; refreshControl.disabled = busy || !!pending || !!draft;
                moreControl.hidden = next === null; moreControl.disabled = busy || !!pending || !!draft;
                const planExists = sourcePlanId !== null && (selected === sourcePlanId || rows.some(row => row.planId === sourcePlanId));
                if (createControl) { createControl.hidden = planExists; createControl.disabled = busy || !!pending || !!draft || scope === null; }
                existingNote.hidden = !planExists;
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
        function waitText(value) {
            let seconds = null;
            try { seconds = number(fields(copy(value, 1024), ['error', 'retryAfterSeconds']).retryAfterSeconds, 86400); }
            catch (_) { seconds = null; }
            if (!seconds) return 'a minute';
            if (seconds < 60) return seconds + (seconds === 1 ? ' second' : ' seconds');
            const minutes = Math.ceil(seconds / 60);
            return minutes + (minutes === 1 ? ' minute' : ' minutes');
        }
        function unavailable(status, uncertain, value) {
            clearView();
            if (status === 401 || status === 403) {
                denied = true; pending = null; rows = []; selected = null; selectedRevision = null; scope = null; removeDraft();
                focusAfterRead = null;
                message = 'Improvement Plan access is unavailable. Reopen the dashboard to check the current organisation and access.';
            } else if (status === 429) {
                message = 'Too many requests in a short time. Wait about ' + waitText(value) + ', then ' +
                    (uncertain ? 'select Retry pending improvement command.' : 'select Refresh improvement plan.');
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
        function errorCode(value) {
            try { return fields(copy(value, 1024), ['code']).code; } catch (_) { return null; }
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
                    (!value.canWrite || value.planRevision === 1024) && action.commands.length) invalid();
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
                if (result.status !== 200) { unavailable(result.status, false, result.value); return false; }
                const value = page(result.value, after); scope = value.scope; rows = value.plans; next = value.nextAfterPlanId; pageAsOf = value.asOf;
                accepted();
                message = rows.length ? 'Choose a saved plan or refresh the selected plan.' : 'No saved improvement plans are available for this organisation.';
                if (!more) clearView();
                if (!more && !rows.length && !target && readLatest) {
                    latest = null; message = 'Looking for your latest submitted assessment…'; render();
                    try { latest = latestSource(await readLatest()); } catch (_) { latest = undefined; }
                    if (!active() || token !== serial) return false;
                    busy = false; renderEmpty(); render(); return true;
                }
                busy = false; render();
                if (!more && target) return readView(target.planId, target);
                if (!more && selected === null && sourcePlanId !== null && rows.some(row => row.planId === sourcePlanId)) return readView(sourcePlanId);
                if (!more && (selected !== null || !initialSource && rows.length)) return readView(selected || rows[0].planId);
                return true;
            } catch (_) { if (active() && token === serial) unavailable(null, false); return false; }
            finally { if (alive && token === serial) { busy = false; render(); } }
        }
        function renderEmpty() {
            clearView();
            const panel = node('section'); panel.className = 'dashboard-panel'; panel.setAttribute('aria-label', 'No improvement plan yet');
            panel.append(node('h2', 'No improvement plan yet'));
            if (latest) {
                panel.append(node('p', 'Create a plan from your latest submitted assessment (submitted ' + nzDateTime(latest.submittedAt) + '). ' +
                    'It lists the gaps to fix and the answers to check, so you can give each one an owner and a due date.'),
                node('p', 'The plan uses your saved self-reported answers. Creating it does not change your results.'));
                const create = button('Create improvement plan from latest assessment', generate);
                create.disabled = busy || !!pending || scope === null; panel.append(create);
                message = 'No improvement plan yet. You can create one from your latest submitted assessment.';
            } else if (latest === null) {
                panel.append(node('p', 'Submit an assessment first. Your improvement plan is built from its results.'));
                message = 'No improvement plan yet. Submit an assessment to create one.';
            } else {
                panel.append(node('p', 'We could not check your submitted assessments just now. Select Refresh improvement plan to try again, ' +
                    'or open Overview and choose Plan improvements for this assessment.'));
                message = 'No improvement plan yet. Your submitted assessments could not be checked.';
            }
            content.replaceChildren(panel);
        }
        async function readView(planId, exactTarget) {
            if (!active() || busy || pending || draft || scope === null) return false;
            const token = ++serial; let targetLoaded = false;
            busy = true; clearView(); rendered = view.mountLoading(content); message = 'Loading improvement actions…'; render();
            try {
                // The plan and its editor options are independent reads of the
                // same plan. Send both together, one round trip instead of two;
                // the editor result is still used only after the plan is valid.
                // A work-queue target may be gone, so it reads the plan first.
                const editorPath = '/api/dashboard/improvement/editor?planId=' + encodeURIComponent(planId);
                const viewRequest = request('/api/dashboard/improvement/view?planId=' + encodeURIComponent(planId));
                const earlyEditor = exactTarget ? null : request(editorPath);
                if (earlyEditor) Promise.resolve(earlyEditor).catch(() => {});
                const result = response(await viewRequest);
                if (!active() || token !== serial) return false;
                if (result.status !== 200) {
                    unavailable(result.status, false, result.value);
                    if (exactTarget && result.status === 404) {
                        selected = null; selectedRevision = null; selectedAction = null;
                        message = 'This action is no longer available in this organisation. Return to the work queue or refresh to check again.'; render();
                    }
                    return false;
                }
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
                const generatedFrom = initialSource || latest;
                if (generatedPlanId === planId && (!value.source || !generatedFrom || value.source.assessmentId !== generatedFrom.assessmentId ||
                    initialSource && value.source.evaluationOutputSha256 !== initialSource.outputSha256)) invalid();
                if (exactTarget && !actionIds.has(exactTarget.actionId)) {
                    clearView(); selected = null; selectedRevision = null; selectedAction = null;
                    message = 'This action is no longer available in this plan. Return to the work queue or refresh to check again.'; render(); return false;
                }
                selected = planId; selectedRevision = value.planRevision; clearView(); rendered = view.mount(content, value, viewOptions());
                try { timestamp(value.source.scoreAsOf); planNames.set(planId, 'Plan: ' + when(value.source.scoreAsOf).split(',')[0]); }
                catch (_) { /* The renderer below withholds an invalid presentation. */ }
                // The reused renderer withholds invalid presentations. An editor
                // is offered only beside its successfully rendered plan panel.
                if (!Array.from(content.querySelectorAll('section')).some(section => section.getAttribute('aria-label') === 'Improvement action plan')) invalid();
                accepted();
                model = value; message = 'Checking current action options…'; render();
                let editorResult = response(await (earlyEditor || request(editorPath)));
                if (!active() || token !== serial) return false;
                // The editor must not describe the plan at an earlier moment than
                // the view shown. A parallel read can be stamped first, so retry
                // it once in sequence instead of rejecting the plan.
                if (earlyEditor && editorResult.status === 200 && editorResult.value && typeof editorResult.value.asOf === 'string' &&
                    editorResult.value.asOf < value.asOf) {
                    editorResult = response(await request(editorPath));
                    if (!active() || token !== serial) return false;
                }
                if (editorResult.status !== 200) {
                    if (editorResult.status === 401 || editorResult.status === 403) unavailable(editorResult.status, false);
                    else {
                        editor = null;
                        message = editorResult.status === 429 ? 'The saved plan is visible. Too many requests in a short time, so action options are not loaded. Wait about ' +
                            waitText(editorResult.value) + ', then select Refresh improvement plan.' :
                            'The saved plan is visible, but current action options are unavailable. Refresh to try again.';
                        render();
                    }
                    return false;
                }
                editor = editorContext(editorResult.value, model);
                // Name the signed-in person's own actions "You" once the editor
                // confirms who they are; re-render the already validated plan.
                const self = editor.ownerChoices.length === 1 ? editor.ownerChoices[0].subjectKey : null;
                if (self !== currentOwner) { currentOwner = self; if (rendered) rendered.destroy(); rendered = view.mount(content, model, viewOptions()); }
                if (exactTarget) selectedAction = exactTarget.actionId;
                else if (!editor.actions.some(action => action.actionId === selectedAction)) selectedAction = editor.actions[0]?.actionId || null;
                message = exactTarget ? value.planRevision !== exactTarget.planRevision ?
                    'This plan changed since the work queue was checked. The selected action shows the current saved state.' :
                    'Selected action and current options loaded.' : 'Saved plan and current action options loaded.';
                targetLoaded = !!exactTarget; render(); return true;
            } catch (_) { if (active() && token === serial) unavailable(null, false); return false; }
            finally {
                if (alive && token === serial) {
                    busy = false;
                    if (targetLoaded) focusAfterRead = null;
                    render();
                    if (targetLoaded && active() && rendered) rendered.focusAction(exactTarget.actionId);
                }
            }
        }
        async function refresh() {
            if (!active() || busy || pending || draft) return false;
            // Compare every listed plan (id and revision), the paging cursor and
            // the selected plan, so a change to any plan counts as an update.
            const listed = () => JSON.stringify([rows.map(row => [row.planId, row.planRevision]), next]);
            const before = { list: listed(), selected, revision: selectedRevision, latest: latest && latest.revisionSha256 };
            const result = await readPage(null, false);
            if (!result || !active() || busy || pending || draft || denied) return result;
            const changed = listed() !== before.list || selected !== before.selected || selectedRevision !== before.revision ||
                !rows.length && (latest && latest.revisionSha256) !== before.latest;
            const checked = pageAsOf ? ' Checked at ' + nzTime(pageAsOf) + '.' : '';
            message = (changed ? 'Updated with the latest saved changes.' : 'Up to date. Nothing has changed since you last looked.') + checked +
                (selected !== null && editor === null && model !== null ? ' ' + message : '');
            render(); return result;
        }
        function select(planId) {
            if (!active() || busy || pending || draft || !rows.some(row => row.planId === planId) && planId !== selected) return Promise.resolve(false);
            target = null;
            return readView(planId);
        }
        function openTarget(input) {
            if (!active() || busy || pending || draft || scope === null) return Promise.resolve(false);
            let checked;
            try { checked = actionTarget(input); if (!checked) invalid(); }
            catch (_) { return Promise.resolve(false); }
            target = checked;
            return readView(checked.planId, checked);
        }
        async function submit() {
            if (!active() || busy || pending === null || scope === null) return false;
            const token = ++serial, captured = pending; busy = true; message = 'Sending the retained improvement command…'; render();
            try {
                const result = response(await request('/api/dashboard/improvement/execute', captured));
                if (!active() || token !== serial || pending !== captured) return false;
                if (result.status !== 200) {
                    // Unexpected intermediary responses do not establish that the
                    // write failed. Retain its identity, as for a lost response.
                    if ([400, 401, 403, 404, 405, 409, 413].includes(result.status)) pending = null;
                    if (result.status === 409 && captured.type === 'generate') { generatedPlanId = captured.planId; busy = false; return readView(captured.planId); }
                    if (result.status === 400 && labelled(captured.payload) && draft && draftForm && draftForm.inputs.ownerLabel &&
                        ['owner_label_invalid', 'improvement_input_invalid'].includes(errorCode(result.value))) {
                        busy = false; fieldError('ownerLabel', OWNER_LABEL_HELP); return false;
                    }
                    if (result.status === 409) {
                        staleDraft = draft !== null; editor = null;
                        message = draft ? 'Plan changed; cancel these changes and refresh.' : 'Plan changed. Refresh the saved plan before making another update.';
                        render(); return false;
                    }
                    unavailable(result.status, pending !== null, result.value); return false;
                }
                const value = fields(copy(result.value, 8388608), ['schemaVersion', 'plan']);
                if (value.schemaVersion !== 1 || !value.plan || value.plan.planId !== captured.planId ||
                    value.plan.tenantId !== scope.tenantId || value.plan.organisationId !== scope.organisationId ||
                    value.plan.revision !== (captured.expectedRevision === null ? 0 : captured.expectedRevision + 1)) invalid();
                if (captured.type === 'generate') generatedPlanId = captured.planId;
                accepted();
                pending = null; removeDraft(); selected = captured.planId; selectedRevision = value.plan.revision; busy = false;
                return readView(selected);
            } catch (_) { if (active() && token === serial) unavailable(null, pending !== null); return false; }
            finally { if (alive && token === serial) { busy = false; render(); } }
        }
        function generate() {
            const planSource = initialSource || latest;
            if (!active() || busy || pending || draft || !planSource || scope === null) return Promise.resolve(false);
            try {
                // Same revision-derived IDs as Overview's "Plan this": one plan per
                // submitted revision, and a repeat create replays idempotently.
                const planId = identifier('overview-plan-' + planSource.revisionSha256);
                const operationId = identifier('overview-plan-generate-' + planSource.revisionSha256);
                pending = command({ planId, type: 'generate', operationId, expectedRevision: null, actionId: null,
                    payload: { assessmentId: planSource.assessmentId, assessmentRevision: planSource.revision,
                        assessmentRevisionSha256: planSource.revisionSha256 } });
                target = null;
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
            if (!alive) return; alive = false; serial++; pending = null; scope = null; rows = []; selectedAction = null; target = null; focusAfterRead = null; removeDraft(); clearView();
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
        controller = Object.freeze({ ready, destroy, requestLeave, refresh, select, openTarget, generate, execute, retry });
        mounted.set(root, controller); root.replaceChildren(toolbar, status, editorPanel, content); render();
        readPage(null, false).then(resolveReady, function () { resolveReady(false); });
        return controller;
    }
    return Object.freeze({ mount });
}));
