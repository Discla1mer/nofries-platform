(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesImprovementActionPlanView = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const mounted = new WeakMap();
    const loadingState = Symbol('loading');
    const statuses = { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', completed: 'Completed' };
    const kinds = { implementation: 'Implementation gap', assessment: 'Assessment needed',
        applicability: 'Applicability review', evidence: 'Evidence gap' };
    const responses = { yes: 'Yes', no: 'No', partial: 'Partly implemented', unknown: 'Unknown' };
    const origins = { direct: 'Recorded response', direct_unknown: 'Recorded as unknown', missing: 'No response recorded',
        claimed_not_applicable: 'Not-applicable claim awaiting approval' };
    const evidenceStates = { not_provided: 'Not provided', attested: 'Self-attested', documented_current: 'Documented as current',
        tested_or_observed_current: 'Tested or observed as current', independently_reviewed_current: 'Independently reviewed as current',
        stale: 'Stale', inaccessible: 'Inaccessible', disputed: 'Disputed', unavailable: 'Unavailable' };
    const events = { assign: 'Assigned', start: 'Started', block: 'Blocked', complete: 'Completed', reopen: 'Reopened' };
    const notices = {
        priority: 'Risk priority has not been calculated.',
        order: 'Ordered by due date, then action ID. This is not a risk ranking.',
        evidence: 'Completion records workflow progress. Evidence references are unverified, downloads are unavailable, and scores are unchanged.',
        owner: 'Owner references do not confirm current membership or permission.'
    };
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    function invalid() { throw new Error('improvement_view_unavailable'); }
    function fields(value, names) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
        const keys = Object.keys(value);
        if (keys.length !== names.length || keys.some(key => !names.includes(key))) invalid();
    }
    function text(value, maximum) {
        if (typeof value !== 'string' || !value.trim() || value.length > (maximum || 1000)) invalid();
    }
    function number(value, maximum) {
        if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0) || value > maximum) invalid();
    }
    function instant(value) {
        text(value, 24);
        if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid();
        date(value.slice(0, 10));
        if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid();
    }
    function date(value) {
        if (value === null) return;
        text(value, 10); if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
        const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
        const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid();
    }
    function subject(value) {
        if (value !== null && (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))) invalid();
    }
    function label(map, key, actual) { if (!own(map, key) || actual !== map[key]) invalid(); }
    function nextStep(action) {
        if (action.status === 'completed') return 'Review the completion note and action history.';
        if (action.status === 'blocked') return 'Review the block reason and agree how to move forward.';
        if (action.ownerSubjectKey === null) return 'Agree an owner and due date before starting this action.';
        if (action.status === 'in_progress') return 'Review progress with the action owner against the due date.';
        return 'Confirm the owner and due date, then review the suggested work.';
    }

    // Snapshot own data properties before rendering. Accessors, cycles, custom
    // prototypes, sparse arrays and oversized input fail before any disclosure.
    function snapshot(input) {
        const active = new Set(); let nodes = 0, units = 0;
        function visit(value, depth) {
            if (++nodes > 400000 || depth > 20) invalid();
            if (value === null || typeof value === 'boolean') return value;
            if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
            if (typeof value === 'string') { units += value.length; if (units > 8388608) invalid(); return value; }
            if (!value || typeof value !== 'object' || active.has(value)) invalid();
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) invalid();
            active.add(value);
            const keys = Reflect.ownKeys(value), array = Array.isArray(value), result = array ? [] : Object.create(null);
            if (array && (value.length > 4096 || keys.length !== value.length + 1)) invalid();
            for (const key of keys) {
                if (array && key === 'length') continue;
                if (typeof key !== 'string' || array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) invalid();
                Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
            }
            active.delete(value); return result;
        }
        const result = visit(input, 0), json = JSON.stringify(result);
        let bytes = 0;
        for (const character of json) {
            const point = character.codePointAt(0); bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
            if (bytes > 8388608) invalid();
        }
        return result;
    }
    function count(value) {
        fields(value, ['total', 'unassigned', 'overdue', 'byStatus']);
        number(value.total, 4096); number(value.unassigned, value.total); number(value.overdue, value.total);
        fields(value.byStatus, Object.keys(statuses));
        Object.values(value.byStatus).forEach(item => number(item, value.total));
        if (Object.values(value.byStatus).reduce((sum, item) => sum + item, 0) !== value.total) invalid();
    }
    function validate(input) {
        const value = snapshot(input);
        fields(value, ['schemaVersion', 'scope', 'planRevision', 'updatedAt', 'asOf', 'dueDateBasis', 'source', 'priority',
            'order', 'filters', 'counts', 'actions', 'presentationVersion', 'notices']);
        if (value.schemaVersion !== 1 || value.presentationVersion !== 1 || value.dueDateBasis !== 'UTC_calendar_day' ||
            value.order !== 'due_date_then_action_id') invalid();
        fields(value.scope, ['tenantId', 'organisationId', 'planId']); Object.values(value.scope).forEach(item => text(item, 120));
        number(value.planRevision, 1024); instant(value.updatedAt); instant(value.asOf);
        fields(value.source, ['assessmentId', 'assessmentRevision', 'scoreAsOf', 'evaluationOutputSha256']);
        text(value.source.assessmentId, 180); text(value.source.assessmentRevision, 80); instant(value.source.scoreAsOf);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/.test(value.source.assessmentRevision) || value.source.assessmentRevision.toLowerCase() === 'latest') invalid();
        if (typeof value.source.evaluationOutputSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.source.evaluationOutputSha256)) invalid();
        fields(value.priority, ['status', 'reason']);
        if (value.priority.status !== 'not_calculated' || value.priority.reason !== 'priority_adapter_required') invalid();
        fields(value.notices, Object.keys(notices)); Object.keys(notices).forEach(key => { if (value.notices[key] !== notices[key]) invalid(); });
        fields(value.filters, ['status', 'owner', 'overdueOnly']);
        if (value.filters.status !== 'all' && !own(statuses, value.filters.status) || typeof value.filters.overdueOnly !== 'boolean') invalid();
        if (!['all', 'unassigned'].includes(value.filters.owner)) subject(value.filters.owner);
        fields(value.counts, ['all', 'visible']); count(value.counts.all); count(value.counts.visible);
        if (!Array.isArray(value.actions) || value.actions.length > 4096 || value.counts.visible.total !== value.actions.length ||
            value.counts.all.total < value.counts.visible.total) invalid();
        const ids = new Set(), revisions = new Set(); let historyCount = 0;
        value.actions.forEach(action => {
            fields(action, ['actionId', 'itemId', 'controlId', 'domainId', 'status', 'ownerSubjectKey', 'ownerEligibility', 'dueDate',
                'isOverdue', 'blockedReason', 'rationale', 'completion', 'evidence', 'history', 'labels']);
            ['actionId', 'itemId', 'controlId', 'domainId'].forEach(key => text(action[key], 180));
            if (ids.has(action.actionId)) invalid(); ids.add(action.actionId);
            subject(action.ownerSubjectKey); date(action.dueDate);
            if (action.ownerEligibility !== 'not_checked' || typeof action.isOverdue !== 'boolean') invalid();
            if (action.blockedReason !== null) text(action.blockedReason);
            fields(action.rationale, ['kind', 'response', 'responseOrigin', 'suggestedAction']); text(action.rationale.suggestedAction);
            fields(action.labels, ['status', 'kind', 'response', 'responseOrigin', 'evidenceState', 'owner']);
            label(statuses, action.status, action.labels.status); label(kinds, action.rationale.kind, action.labels.kind);
            label(responses, action.rationale.response, action.labels.response); label(origins, action.rationale.responseOrigin, action.labels.responseOrigin);
            if (action.labels.owner !== (action.ownerSubjectKey === null ? 'Unassigned' : 'Assigned (eligibility not checked)')) invalid();
            if (action.completion !== null) { fields(action.completion, ['at', 'note']); instant(action.completion.at); text(action.completion.note); }
            if ((action.status === 'completed') !== (action.completion !== null) || (action.status === 'blocked') !== (action.blockedReason !== null)) invalid();
            fields(action.evidence, ['assessmentState', 'completionReference', 'completionVerification', 'durableLinkStatus', 'downloadAllowed', 'scoreEffect']);
            label(evidenceStates, action.evidence.assessmentState, action.labels.evidenceState);
            if (action.evidence.completionReference !== null) text(action.evidence.completionReference, 180);
            if (action.evidence.completionVerification !== (action.completion === null ? 'not_recorded' : 'not_verified') ||
                action.evidence.durableLinkStatus !== 'not_established' || action.evidence.downloadAllowed !== false || action.evidence.scoreEffect !== 'none') invalid();
            if (!Array.isArray(action.history) || (historyCount += action.history.length) > 1024) invalid();
            let previous = 0;
            action.history.forEach(event => {
                fields(event, ['revision', 'at', 'type', 'details', 'label']);
                number(event.revision, value.planRevision); instant(event.at); label(events, event.type, event.label);
                if (event.revision <= previous || revisions.has(event.revision)) invalid(); previous = event.revision; revisions.add(event.revision);
                if (event.type === 'assign') { fields(event.details, ['ownerSubjectKey', 'dueDate']); subject(event.details.ownerSubjectKey); date(event.details.dueDate); }
                else if (event.type === 'block' || event.type === 'reopen') { fields(event.details, ['reason']); text(event.details.reason); }
                else if (event.type === 'complete') {
                    fields(event.details, ['note', 'evidenceReference', 'evidenceVerification', 'durableLinkStatus']); text(event.details.note);
                    if (event.details.evidenceReference !== null) text(event.details.evidenceReference, 180);
                    if (event.details.evidenceVerification !== 'not_verified' || event.details.durableLinkStatus !== 'not_established') invalid();
                } else fields(event.details, []);
            });
        });
        return value;
    }

    // A trusted host supplies a current authorised presentation. This component
    // grants no access, reads no clock and performs no requests or commands.
    function mount(root, presentation) {
        if (!root || !root.ownerDocument || typeof root.replaceChildren !== 'function') throw new Error('improvement_view_root_required');
        if (mounted.has(root)) mounted.get(root).destroy();
        const doc = root.ownerDocument;
        const controller = Object.freeze({ destroy() {
            if (mounted.get(root) === controller) { root.replaceChildren(); mounted.delete(root); }
        } });
        mounted.set(root, controller);
        function node(tag, className, value) {
            const element = doc.createElement(tag); if (className) element.className = className;
            if (value !== undefined) element.textContent = value; return element;
        }
        function fact(list, title, value) { list.append(node('dt', 'dashboard-muted', title), node('dd', 'ncsc-preserve-text', value)); }
        function record(title, values) {
            const section = node('section', 'dashboard-panel'); section.append(node('h3', '', title));
            const list = node('dl'); values.forEach(pair => fact(list, pair[0], pair[1])); section.append(list); return section;
        }
        function disclosure(title) { const details = node('details', 'dashboard-panel'); details.append(node('summary', '', title)); return details; }
        if (presentation === loadingState) {
            const loading = node('p', 'dashboard-status-panel', 'Loading improvement actions…');
            loading.setAttribute('role', 'status');
            root.replaceChildren(loading); return controller;
        }
        try {
            const model = validate(presentation), panel = node('section', 'dashboard-panel');
            panel.setAttribute('aria-label', 'Improvement action plan');
            panel.append(node('h2', '', 'Improvement action plan'));
            panel.append(node('p', 'dashboard-muted', 'Assessment ' + model.source.assessmentId + ' · revision ' + model.source.assessmentRevision +
                ' · As of ' + model.asOf + ' (UTC)'));
            panel.append(node('p', '', 'Showing ' + model.counts.visible.total + ' of ' + model.counts.all.total + ' actions. ' +
                'Visible overdue: ' + model.counts.visible.overdue + ' · Unassigned: ' + model.counts.visible.unassigned + '.'));
            panel.append(node('p', 'dashboard-muted', model.notices.priority + ' ' + model.notices.order),
                node('p', 'dashboard-muted', model.notices.evidence + ' ' + model.notices.owner));
            panel.append(node('p', '', 'Read-only plan. Review each action’s next step, owner and due date. ' +
                'Open Action history for earlier updates. Changes cannot be made in this view.'));
            const sourceDetails = disclosure('Source and plan metadata');
            sourceDetails.append(record('Retained source', [
                ['Plan ID', model.scope.planId], ['Plan revision', String(model.planRevision)], ['Plan last updated (UTC)', model.updatedAt],
                ['As of (UTC)', model.asOf], ['Assessment ID', model.source.assessmentId],
                ['Assessment revision', String(model.source.assessmentRevision)], ['Assessment scored at (UTC)', model.source.scoreAsOf],
                ['Evaluation output SHA-256', model.source.evaluationOutputSha256]
            ])); panel.append(sourceDetails);
            const countDetails = disclosure('Counts and filters');
            const counts = node('dl');
            ['visible', 'all'].forEach(key => {
                const values = model.counts[key], prefix = key === 'visible' ? 'Visible' : 'All';
                fact(counts, prefix + ' actions', String(values.total)); fact(counts, prefix + ' unassigned', String(values.unassigned));
                fact(counts, prefix + ' overdue', String(values.overdue));
                Object.keys(statuses).forEach(status => fact(counts, prefix + ' ' + statuses[status].toLowerCase(), String(values.byStatus[status])));
            });
            countDetails.append(counts);
            const filters = node('p', 'dashboard-muted', 'Filters: status ' + (model.filters.status === 'all' ? 'All' : statuses[model.filters.status]) +
                '; owner ' + model.filters.owner + '; overdue only ' + (model.filters.overdueOnly ? 'Yes' : 'No') + '.');
            countDetails.append(filters); panel.append(countDetails);
            if (!model.actions.length) panel.append(node('p', 'dashboard-muted', model.counts.all.total ?
                'No actions match these filters. Review the selection in Counts and filters to see what is included.' :
                'No retained improvement actions. Check that this is the assessment version you intended to review.'));
            model.actions.forEach(action => {
                const card = node('article', 'dashboard-panel');
                card.append(node('h3', '', action.controlId + ' · ' + action.labels.kind), node('span', 'dashboard-badge', action.labels.status),
                    node('p', 'ncsc-preserve-text', action.rationale.suggestedAction));
                const facts = node('dl');
                [['Next step', nextStep(action)], ['Owner', action.labels.owner],
                    ['Due date (UTC calendar day)', action.dueDate === null ? 'Not set' : action.dueDate],
                    ['Overdue at supplied as-of date (UTC)', action.isOverdue ? 'Yes' : 'No'], ['Assessment response', action.labels.response],
                    ['Response origin', action.labels.responseOrigin], ['Assessment evidence', action.labels.evidenceState]].forEach(pair => fact(facts, pair[0], pair[1]));
                if (action.blockedReason !== null) fact(facts, 'Block reason', action.blockedReason);
                if (action.completion !== null) {
                    fact(facts, 'Workflow completed at (UTC)', action.completion.at); fact(facts, 'Completion note', action.completion.note);
                    fact(facts, 'Completion evidence reference (unverified)', action.evidence.completionReference === null ? 'Not recorded' : action.evidence.completionReference);
                    fact(facts, 'Completion meaning', 'Workflow completed; control implementation has not been verified.');
                }
                card.append(facts);
                const identifiers = disclosure('Action identifiers'), idFacts = node('dl');
                [['Owner ID', action.ownerSubjectKey === null ? 'Unassigned' : action.ownerSubjectKey],
                    ['Owner eligibility', 'Current eligibility not checked'], ['Action ID', action.actionId],
                    ['Control ID', action.controlId], ['Item ID', action.itemId], ['Domain ID', action.domainId]]
                    .forEach(pair => fact(idFacts, pair[0], pair[1])); identifiers.append(idFacts); card.append(identifiers);
                const history = disclosure('Action history (' + action.history.length + ' events)');
                if (!action.history.length) history.append(node('p', 'dashboard-muted', 'No updates recorded for this action.'));
                const timeline = node('ol');
                action.history.forEach(event => {
                    const entry = node('li'); entry.append(node('h4', '', 'Plan revision ' + event.revision + ' · ' + event.label), node('p', '', event.at + ' (UTC)'));
                    const details = node('dl');
                    if (event.type === 'assign') { fact(details, 'Owner ID (current eligibility not checked)', event.details.ownerSubjectKey === null ? 'Unassigned' : event.details.ownerSubjectKey); fact(details, 'Due date (UTC calendar day)', event.details.dueDate === null ? 'Not set' : event.details.dueDate); }
                    if (event.type === 'block' || event.type === 'reopen') fact(details, 'Reason', event.details.reason);
                    if (event.type === 'complete') { fact(details, 'Completion note', event.details.note); fact(details, 'Evidence reference (unverified)', event.details.evidenceReference === null ? 'Not recorded' : event.details.evidenceReference); fact(details, 'Evidence status', 'Unverified; durable link not established.'); }
                    entry.append(details); timeline.append(entry);
                });
                history.append(timeline); card.append(history); panel.append(card);
            });
            root.replaceChildren(panel);
        } catch (_) {
            const error = node('p', 'dashboard-status-panel', 'Improvement action plan is unavailable. Refresh the page to try again. ' +
                'If the problem continues, contact your support team.'); error.setAttribute('role', 'status'); root.replaceChildren(error);
        }
        return controller;
    }
    // The trusted host decides when a read is pending and when to replace this
    // status with mount(). This component starts no request or automatic retry.
    function mountLoading(root) { return mount(root, loadingState); }
    return Object.freeze({ mount, mountLoading });
}));
