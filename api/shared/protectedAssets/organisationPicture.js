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
    const { topGaps, confirmNext, v2Shortfall } = questionnaire;
    const V2_PROFILE_REF = Object.freeze({ frameworkId: 'nz-ncsc-cyber-security-framework', frameworkVersion: 'beta-verified-2026-09-02',
        profileId: 'nz-ncsc-mcss-2025-v3-sme', profileVersion: '2026-11-18.1',
        catalogueSha256: 'c90e999f627308f326a403b1d779e68087e3eaadab5149070f1df5e350daa537',
        sourceCatalogueSha256: 'c6120192675c9d12cdab296d6f5a84f014d613b300001394790f3ccf79692b71' });
    const v2Profile = metadata => !!metadata && !!metadata.profileRef && typeof metadata.profileRef === 'object' &&
        PROFILE_FIELDS.every(key => metadata.profileRef[key] === V2_PROFILE_REF[key]);
    // A supplied extra profile must be exactly the pinned v2 profile: six own
    // fields, each equal. A near match (for example a re-hashed catalogue) would
    // otherwise be readable while v2Profile() is false, giving v2 results the
    // accepted profile's Overview logic. The accepted profile itself is the base
    // metadata and a duplicate of it is already refused.
    const exactV2Profile = ref => !!ref && typeof ref === 'object' && !Array.isArray(ref) &&
        Reflect.ownKeys(ref).length === PROFILE_FIELDS.length &&
        PROFILE_FIELDS.every(key => Object.hasOwn(ref, key) && ref[key] === V2_PROFILE_REF[key]);
    // "Actions" card: display-only over improvement/list responses the host
    // already read. Overdue uses the server's isOverdue. Due-soon and review
    // windows use the Pacific/Auckland calendar day of each list's asOf, matching
    // the rest of the dashboard. Owner names come only from ownerLabel.
    const ACTION_LIMIT = 3, DUE_SOON_DAYS = 14;
    const DAY = /^\d{4}-\d\d-\d\d$/;
    function calendarDay(value) {
        if (typeof value !== 'string' || !DAY.test(value)) return false;
        const parsed = new Date(value + 'T00:00:00.000Z');
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }
    // Plain control name for an action's question, from the same metadata the
    // results view uses ("Patching", "Sensitive-request verification check").
    function controlName(metadata, itemId) {
        if (!metadata || !Array.isArray(metadata.questions) || typeof itemId !== 'string') return null;
        const question = metadata.questions.find(entry => entry && entry.id === itemId);
        const control = question && (metadata.controls || []).find(entry => entry && entry.id === question.controlId);
        const title = control && typeof control.title === 'string' ? control.title.split(' — ').pop().trim() : '';
        return title || null;
    }
    // With several readable profiles an action's question can exist in more than
    // one. A plan action does not say which profile it came from, so its control
    // is named only when every profile that has the question gives it the same
    // name; otherwise the suggested action stands alone. One profile: unchanged.
    function sharedControlName(profiles, itemId) {
        const names = profiles.filter(metadata => metadata && Array.isArray(metadata.questions) &&
            metadata.questions.some(entry => entry && entry.id === itemId)).map(metadata => controlName(metadata, itemId));
        return names.length && names.every(name => name !== null && name === names[0]) ? names[0] : null;
    }
    function actionSummary(input, metadata, profileMetadata) {
        const profiles = [metadata].concat(Array.isArray(profileMetadata) ? profileMetadata : []);
        if (!input || !Array.isArray(input.lists) || typeof input.more !== 'boolean') return null;
        let today = null; const rows = [];
        for (const list of input.lists) {
            if (!list || typeof list.asOf !== 'string' || !calendarDay(list.asOf.slice(0, 10)) || !Array.isArray(list.actions)) return null;
            const day = nzCalendarDay(list.asOf) || list.asOf.slice(0, 10);
            const planId = list.scope && typeof list.scope.planId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(list.scope.planId) ? list.scope.planId : null;
            const planRevision = Number.isSafeInteger(list.planRevision) && list.planRevision >= 0 && list.planRevision <= 1024 ? list.planRevision : null;
            if (today === null || day < today) today = day;
            for (const action of list.actions) {
                if (!action || typeof action.actionId !== 'string' || typeof action.status !== 'string' ||
                    typeof action.isOverdue !== 'boolean' || action.isOverdue && action.dueDate === null || action.dueDate !== null && !calendarDay(action.dueDate) ||
                    !action.rationale || typeof action.rationale.suggestedAction !== 'string' || !action.rationale.suggestedAction.trim() ||
                    Object.hasOwn(action, 'ownerLabel') && typeof action.ownerLabel !== 'string') return null;
                if (Object.hasOwn(action.completion || {}, 'nextReviewDate') &&
                    (action.status !== 'completed' || !calendarDay(action.completion.nextReviewDate))) return null;
                rows.push({ ...action, planId, planRevision });
            }
        }
        const horizon = today && new Date(Date.parse(today + 'T00:00:00.000Z') + DUE_SOON_DAYS * 86400000).toISOString().slice(0, 10);
        const byDue = (a, b) => a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0;
        const item = action => ({ title: (name => name ? name + ': ' + action.rationale.suggestedAction.charAt(0).toLowerCase() +
                action.rationale.suggestedAction.slice(1) : action.rationale.suggestedAction)(profiles.length === 1
                ? controlName(metadata, action.itemId) : sharedControlName(profiles, action.itemId)),
            dueDate: action.dueDate, status: action.status,
            actionId: action.actionId, planId: action.planId, planRevision: action.planRevision,
            owner: Object.hasOwn(action, 'ownerLabel') && action.ownerLabel.trim() ? action.ownerLabel : null });
        const dueKey = action => action.dueDate || '9999-99-99';
        const byOpen = (a, b) => (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1) ||
            (dueKey(a) < dueKey(b) ? -1 : dueKey(a) > dueKey(b) ? 1 : a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0);
        const next = rows.filter(action => action.status !== 'completed').sort(byOpen).slice(0, ACTION_LIMIT).map(item);
        const overdue = rows.filter(action => action.isOverdue).sort(byDue);
        const dueSoon = rows.filter(action => !action.isOverdue && action.status !== 'completed' && action.dueDate !== null &&
            action.dueDate >= today && action.dueDate <= horizon).sort(byDue);
        // Use current completion only: a historical completion does not keep a
        // reopened action on the review list. Never reopen or mark a review done.
        const reviews = rows.filter(action => action.status === 'completed' && action.completion &&
            Object.hasOwn(action.completion, 'nextReviewDate'))
            .sort((a, b) => a.completion.nextReviewDate.localeCompare(b.completion.nextReviewDate) || a.actionId.localeCompare(b.actionId))
            .map(action => ({ ...item(action), reviewDate: action.completion.nextReviewDate }));
        const reviewsDue = reviews.filter(action => action.reviewDate <= today);
        const reviewsSoon = reviews.filter(action => action.reviewDate > today && action.reviewDate <= horizon);
        return { total: rows.length, more: input.more, next,
            overdue: { count: overdue.length, items: overdue.slice(0, ACTION_LIMIT).map(item) },
            dueSoon: { count: dueSoon.length, items: dueSoon.slice(0, ACTION_LIMIT).map(item) },
            reviews: { total: reviews.length, asOfDay: today,
                due: { count: reviewsDue.length, items: reviewsDue.slice(0, ACTION_LIMIT) },
                soon: { count: reviewsSoon.length, items: reviewsSoon.slice(0, ACTION_LIMIT) } } };
    }
    function nzCalendarDay(iso) {
        try {
            const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
            const part = type => parts.find(item => item.type === type);
            const day = part('year').value + '-' + part('month').value + '-' + part('day').value;
            return calendarDay(day) ? day : null;
        } catch (_) { return null; }
    }
    // A saved due date is a calendar day. Midnight UTC is still that day in
    // New Zealand (the zone is ahead of UTC), matching the rest of the dashboard.
    const displayDay = value => new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeZone: 'Pacific/Auckland' })
        .format(new Date(value + 'T00:00:00.000Z'));
    function sameProfile(actual, expected) {
        return actual && expected && Object.keys(expected).every(key => actual[key] === expected[key]);
    }

    // Read-only presentation over the existing authorised client. A score is
    // displayed only after the submitted-result validator accepts the complete
    // organisation/profile/revision binding. Never score drafts or uploaded files.
    function newestRow(list) {
        return list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assessmentId.localeCompare(b.assessmentId))[0] || null;
    }
    function preferredAssessmentId(list) {
        const submitted = newestRow(list.filter(row => row.status === 'submitted'));
        if (submitted) return submitted.assessmentId;
        const draft = newestRow(list.filter(row => row.status !== 'submitted'));
        return draft ? draft.assessmentId : '';
    }
    // Chart kit (#604): small SVG charts drawn with presentation attributes only,
    // so they work under the dashboard CSP (no inline styles, no libraries).
    // Builders return plain specs; draw() turns a spec into DOM nodes.
    const CHART_TONES = Object.freeze({ solid: '#65470d', partial: '#dbb157', no: '#8a2b21', unknown: '#b9ae9b', track: '#e2d9c7', ink: '#17140f' });
    const clampPercent = value => { const number = Number(value); return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0; };
    const svgNode = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: children || [] });
    // Half-circle gauge: the reported figure is solid; the "up to" figure adds a hatched band.
    function gaugeSpec(lower, upper, label) {
        const low = clampPercent(lower), high = Math.max(low, clampPercent(upper)), id = 'nf-chart-hatch';
        const arc = 'M24 120 A96 96 0 0 1 216 120', angle = Math.PI * (1 - low / 100);
        const tip = [120 + 70 * Math.cos(angle), 120 - 70 * Math.sin(angle)].map(value => Math.round(value * 10) / 10);
        return svgNode('svg', { viewBox: '0 0 240 132', class: 'nf-chart nf-chart-gauge', role: 'img', 'aria-label': label }, [
            svgNode('defs', {}, [svgNode('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
                [svgNode('rect', { width: 3, height: 6, fill: CHART_TONES.partial })])]),
            svgNode('path', { d: arc, fill: 'none', stroke: CHART_TONES.track, 'stroke-width': 20, 'stroke-linecap': 'round', pathLength: 100 }),
            svgNode('path', { d: arc, fill: 'none', stroke: 'url(#' + id + ')', 'stroke-width': 20, pathLength: 100,
                'stroke-dasharray': (high - low) + ' 100', 'stroke-dashoffset': String(-low), 'data-band': 'upper' }),
            svgNode('path', { d: arc, fill: 'none', stroke: CHART_TONES.solid, 'stroke-width': 20, pathLength: 100,
                'stroke-dasharray': low + ' 100', 'data-band': 'lower' }),
            svgNode('line', { x1: 120, y1: 120, x2: tip[0], y2: tip[1], stroke: CHART_TONES.ink, 'stroke-width': 4, 'stroke-linecap': 'round' }),
            svgNode('circle', { cx: 120, cy: 120, r: 8, fill: CHART_TONES.ink })
        ]);
    }
    // Donut of answer counts; segments with no answers are left out.
    function donutSpec(segments, centre, label) {
        const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value || 0), 0);
        let offset = 0;
        const rings = total ? segments.filter(segment => segment.value > 0).map(segment => {
            const share = segment.value / total * 100, ring = svgNode('circle', { cx: 80, cy: 80, r: 60, fill: 'none', stroke: CHART_TONES[segment.tone],
                'stroke-width': 22, pathLength: 100, 'stroke-dasharray': Math.round(share * 100) / 100 + ' 100', 'stroke-dashoffset': String(-Math.round(offset * 100) / 100),
                transform: 'rotate(-90 80 80)', 'data-tone': segment.tone });
            offset += share; return ring;
        }) : [];
        return svgNode('svg', { viewBox: '0 0 160 160', class: 'nf-chart nf-chart-donut', role: 'img', 'aria-label': label }, [
            svgNode('circle', { cx: 80, cy: 80, r: 60, fill: 'none', stroke: CHART_TONES.track, 'stroke-width': 22 }), ...rings,
            svgNode('text', { x: 80, y: 88, 'text-anchor': 'middle', 'font-size': 28, 'font-weight': 600, fill: CHART_TONES.ink }, [String(centre)])
        ]);
    }
    // Small ring for one NCSC function: reported figure solid, "up to" figure paler behind it.
    function ringSpec(lower, upper, label, text) {
        const low = clampPercent(lower), high = Math.max(low, clampPercent(upper)), round = value => Math.round(value * 10) / 10;
        const arc = { cx: 40, cy: 40, r: 30, fill: 'none', 'stroke-width': 9, pathLength: 100, transform: 'rotate(-90 40 40)' };
        return svgNode('svg', { viewBox: '0 0 80 80', class: 'nf-chart nf-chart-ring', role: 'img', 'aria-label': label }, [
            svgNode('circle', Object.assign({}, arc, { stroke: CHART_TONES.track, transform: undefined })),
            svgNode('circle', Object.assign({}, arc, { stroke: CHART_TONES.partial, 'stroke-dasharray': round(high) + ' 100', 'data-band': 'upper' })),
            svgNode('circle', Object.assign({}, arc, { stroke: CHART_TONES.solid, 'stroke-dasharray': round(low) + ' 100', 'data-band': 'lower' })),
            svgNode('text', { x: 40, y: 45, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: CHART_TONES.ink }, [text])
        ]);
    }
    function draw(doc, spec) {
        if (typeof spec === 'string') return doc.createTextNode ? doc.createTextNode(spec) : spec;
        const element = typeof doc.createElementNS === 'function' ? doc.createElementNS('http://www.w3.org/2000/svg', spec.tag) : doc.createElement(spec.tag);
        Object.keys(spec.attrs).forEach(key => { if (spec.attrs[key] !== undefined) element.setAttribute(key, String(spec.attrs[key])); });
        spec.children.forEach(child => { if (typeof child === 'string') element.textContent = child; else element.append(draw(doc, child)); });
        if (spec.attrs.role === 'img') element.setAttribute('focusable', 'false');
        return element;
    }
    function afterHeading(card, element) {
        const children = Array.from(card.children); card.replaceChildren(children[0], element, ...children.slice(1));
    }
    const percentNumber = display => { const match = /^(\d+(?:\.\d+)?)%$/.exec(String(display || '')); return match ? Number(match[1]) : null; };
    function mount(root, options) {
        if (!root || !root.ownerDocument || !options || !options.client ||
            typeof options.client.list !== 'function' || typeof options.client.read !== 'function' ||
            !options.metadata || typeof options.organisationId !== 'string' || !options.organisationId ||
            !questionnaire || typeof questionnaire.resultModel !== 'function' || typeof questionnaire.enoughAnswersToEstimate !== 'function') throw new Error('picture_composition_required');
        if (mounted.has(root)) mounted.get(root).destroy();
        const doc = root.ownerDocument, client = options.client, metadata = copy(options.metadata);
        // Scoring v2 (#399): further readable profiles, sent by the server only
        // while their flag is on. Each assessment is shown with the profile its
        // stored reference names, matched on all six fields. Without them this
        // is exactly the single accepted profile. Each one supplied must be
        // exactly the pinned v2 profile; anything else fails closed.
        const profileMetadata = options.profileMetadata === undefined ? [] : copy(options.profileMetadata);
        if (!Array.isArray(profileMetadata) || profileMetadata.length > 4 ||
            profileMetadata.some(value => !value || !exactV2Profile(value.profileRef) || value.moduleId !== metadata.moduleId ||
                !Array.isArray(value.questions) || !Array.isArray(value.controls) || !Array.isArray(value.domains)) ||
            [metadata].concat(profileMetadata).some((value, index, all) => all.some((other, earlier) =>
                earlier < index && sameProfile(value.profileRef, other.profileRef)))) throw new Error('picture_composition_required');
        const profiles = [metadata].concat(profileMetadata);
        // The metadata for a stored profile reference, or null when no supplied profile matches.
        const metadataFor = profileRef => profiles.find(value => sameProfile(profileRef, value.profileRef)) || null;
        // The profile of the selected assessment. Reads accept only known profiles.
        const selectedMetadata = () => detail && metadataFor(detail.profileRef) || metadata;
        const organisationId = options.organisationId, organisationName = options.displayName || organisationId;
        const openImprovement = typeof options.openImprovement === 'function' ? options.openImprovement : null;
        const planGap = typeof options.planGap === 'function' ? options.planGap : null;
        const gated = typeof options.detailsGate === 'function' ? options.detailsGate : content => content();
        const contactControl = typeof options.contactControl === 'function' ? options.contactControl : null;
        const readActions = openImprovement && typeof options.readActions === 'function' ? options.readActions : null;
        let actions = null, displayedGaps = [];
        const id = 'picture-assessment-' + (++sequence);
        const initialAssessmentId = typeof options.initialAssessmentId === 'string' ? options.initialAssessmentId : null;
        let disposed = false, epoch = 0, requests = new Set(), rows = [], after = null, allowance = null;
        let selected = initialAssessmentId || '', detail = null, loading = false, message = '', denied = false;
        // D-013: the assessment a previous visit showed by default. Only a hint:
        // it is read beside the first list and used only if that fresh list
        // picks the same assessment. The server authorises the read as usual.
        let likelyAssessmentId = !initialAssessmentId && typeof options.likelyAssessmentId === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(options.likelyAssessmentId) ? options.likelyAssessmentId : null;
        let loaded = false, retry = null, explanationController = null;
        let trend = null;
        let gapPlan = null;
        function live(token) { return !disposed && (token === undefined || token === epoch); }
        function node(tag, cls, text) {
            const value = doc.createElement(tag); if (cls) value.className = cls;
            if (text !== undefined) value.textContent = String(text); return value;
        }
        // D-004: a scope written one item per line is shown as a list. The
        // saved declaration is unchanged and remains the compared value.
        function scopeText(description) {
            const lines = String(description).split(/\r?\n/).map(line => line.trim().replace(/^[-*\u2022]\s+/, '')).filter(Boolean);
            const list = node('ul', 'ncsc-scope-list');
            list.setAttribute('role', 'list');
            (lines.length ? lines : [description]).forEach(line => list.append(node('li', 'dashboard-badge ncsc-preserve-text', line)));
            return list;
        }
        // One live region for the whole view, kept across repaints so screen
        // readers hear both "Loading…" and the end of loading.
        const liveStatus = node('p', 'picture-status'); liveStatus.setAttribute('role', 'status');
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
                && questionnaire.resultModel(detail, selectedMetadata(), organisationId) !== null;
        }
        function improvementSelection() {
            if (!detail || detail.status !== 'submitted' || detail.assessmentId !== selected ||
                !questionnaire.resultModel(detail, selectedMetadata(), organisationId) ||
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
            const facts = [['Organisation name', organisationName],
                ['Saved status', detail.status], ['Saved revision', String(detail.revision)],
                ['Framework', selectedMetadata().title], ['Profile version', selectedMetadata().profileRef.profileVersion],
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
            const scope = node('section', 'picture-scope scope-copy');
            scope.append(node('h3', '', 'Scope'), scopeText(detail.scopePopulation.description), node('p', 'dashboard-muted', 'Scope is fixed when an assessment starts. If it is wrong, start a new assessment with the corrected scope.'));
            draft.append(heading, saved, progress, scope);
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
            if (gaps && detail) {
                const ranked = displayedGaps;
                if (ranked.length) {
                    card.append(node('h4', '', 'Start with these gaps'));
                    const list = node('ol');
                    ranked.forEach(gap => list.append(node('li', '', gap.title + ' — ' + gap.firstCheck)));
                    card.append(list, node('p', '', 'Why the first gap matters: ' + ranked[0].why),
                        node('p', '', 'First safe step: Ask the person responsible to check what is already in place before changing settings.'));
                } else card.append(node('p', '', gaps.querySelector('p').textContent));
            } else card.append(node('p', '', 'A first gap is only available for a submitted assessment with results.'));
            if (!actions.total) {
                const empty = node('p', 'picture-actions-empty', 'No actions yet. ');
                const start = detail && v2Profile(selectedMetadata()) ? 'Start with your top gaps.' : 'Start with your top three gaps.';
                if (gaps) {
                    const link = node('a', '', start); link.href = '#' + id + '-top-gaps';
                    link.addEventListener('click', event => {
                        event.preventDefault();
                        const target = root.querySelector('.picture-top-gaps'), title = target && target.querySelector('h3');
                        if (!live() || !title) return;
                        if (typeof title.scrollIntoView === 'function') title.scrollIntoView({ block: 'start' });
                        title.focus();
                    });
                    empty.append(link);
                } else empty.append(node('span', '', start));
                card.append(empty); root.prepend(card); return;
            }
            if (actions.next && actions.next.length) {
                card.append(node('h4', '', 'Next open actions'));
                const list = node('ul', 'picture-actions-next');
                const statusLabel = { in_progress: 'In progress', blocked: 'Blocked', open: 'Open' };
                actions.next.forEach(entry => {
                    const row = node('li', 'picture-action');
                    const link = node('a', 'picture-action-title', entry.title);
                    link.setAttribute('href', '#improvement-plan');
                    link.href = '#improvement-plan';
                    link.addEventListener('click', event => {
                        event.preventDefault();
                        if (!live() || denied) return;
                        if (entry.planId && entry.actionId && Number.isSafeInteger(entry.planRevision) && typeof options.openAction === 'function') {
                            options.openAction({ planId: entry.planId, actionId: entry.actionId, planRevision: entry.planRevision });
                        } else if (openImprovement) openImprovement();
                    });
                    row.append(link, node('span', 'picture-action-meta dashboard-muted',
                        (statusLabel[entry.status] || 'Open') + (entry.dueDate ? ' · Due ' + displayDay(entry.dueDate) : ' · No due date') +
                        (entry.owner ? ' · Owner: ' + entry.owner : '')));
                    list.append(row);
                });
                card.append(list);
            }
            const groups = [['Overdue', actions.overdue], ['Due in the next 14 days', actions.dueSoon]];
            if (actions.reviews.total) groups.push(['Reviews due', actions.reviews.due], ['Reviews in the next 14 days', actions.reviews.soon]);
            groups.forEach(([label, group]) => {
                card.append(node('h4', '', label + ' (' + group.count + ')'));
                if (!group.items.length) return;
                const list = node('ul', 'picture-actions-list');
                group.items.forEach(entry => {
                    const row = node('li', 'picture-action');
                    row.append(node('span', 'picture-action-title', entry.title),
                        node('span', 'picture-action-meta dashboard-muted', (entry.reviewDate ? 'Review ' + displayDay(entry.reviewDate) : 'Due ' + displayDay(entry.dueDate)) +
                            (entry.owner ? ' · Owner: ' + entry.owner : '')));
                    list.append(row);
                });
                card.append(list);
            });
            if (actions.reviews.total) card.append(node('p', 'picture-review-note dashboard-muted',
                'Review dates use saved action records, checked against ' + displayDay(actions.reviews.asOfDay) + ' (New Zealand time). ' +
                'A review date does not confirm a review took place, verify evidence or change a score.'));
            if (actions.more) card.append(node('p', 'dashboard-muted', 'Counts cover the first five saved plans.'));
            const full = node('a', 'picture-actions-plan', 'View the full plan'); full.href = '#improvement-plan';
            full.addEventListener('click', event => { event.preventDefault(); if (live() && !denied) openImprovement(); });
            card.append(full); root.prepend(card);
        }
        function paint() {
            if (!live()) return;
            clearExplanation(); displayedGaps = [];
            Array.from(root.children).forEach(child => { if (child !== liveStatus) child.remove(); });
            root.classList.add('organisation-picture');
            if (liveStatus.parentElement !== root) root.append(liveStatus);
            const isEmpty = !loading && !rows.length && loaded && !message && !selected && after === null;
            if (!isEmpty) {
                const header = node('header', 'picture-heading');
                header.append(node('h2', '', 'Cyber baseline'));
                root.prepend(header);
            }
            // After loading, the status stays in place but only for screen readers.
            const done = detail ? 'Saved assessment loaded.' : isEmpty ? 'No saved assessments yet.' : loaded ? 'Saved assessments loaded.' : '';
            const text = message || (loading ? 'Loading saved assessment…' : done);
            if (liveStatus.textContent !== text) liveStatus.textContent = text;
            liveStatus.className = message || loading ? 'picture-status' : 'picture-status picture-status-quiet';
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
                const labelFor = row => {
                    const selectedDetail = detail && row.assessmentId === detail.assessmentId ? detail : row;
                    const scope = selectedDetail.scopePopulation || row.scopePopulation;
                    return (scope ? scope.description.replace(/\s+/g, ' ').trim() + ' · ' : '') +
                        pictureStatus(row) + ' · ' + displayDate(row.updatedAt);
                };
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
                    const caption = detail && row.assessmentId === detail.assessmentId ? 'Selected · ' + pictureStatus(row) : label;
                    const item = node('option', '', caption + suffix);
                    item.title = caption + suffix;
                    item.value = row.assessmentId; picker.append(item);
                });
                picker.value = selected;
                const chosen = Array.from(picker.querySelectorAll('option')).find(item => item.value === selected);
                if (chosen) picker.title = chosen.title;
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
                const art = node('img', 'picture-illustration'); art.src = '/images/illustrations/overview-empty.webp'; art.alt = '';
                empty.append(art, node('p', 'picture-first-use-eyebrow', 'Welcome to No Fries'),
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
            const scope = node('section', 'picture-scope scope-copy');
            scope.append(node('h3', '', 'Scope'), scopeText(detail.scopePopulation.description), node('p', 'dashboard-muted', 'Scope is fixed when an assessment starts. If it is wrong, start a new assessment with the corrected scope.')); root.append(scope);
            const result = questionnaire.resultModel(detail, selectedMetadata(), organisationId);
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
            const attribution = renderResult(result);
            if (explanation && typeof explanation.mount === 'function') {
                const child = node('section', 'picture-explanation ncsc-results'); root.append(child);
                // The explanation is optional. If it cannot start, keep the
                // results above it and say so plainly instead of blanking the page.
                try { explanationController = explanation.mount(child, { client, metadata: selectedMetadata(), organisationId,
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
            root.append(attribution);
        }
        const newestFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assessmentId.localeCompare(b.assessmentId);
        // Display-only view over results the validator already accepted. The
        // contract pins the profile and included question set, but contains no
        // evidence that two declarations cover the same real-world population.
        // Neither equal descriptions nor record-bound scope hashes establish it.
        function trendPoint(value, result) {
            // v2 (#399): any answer other than "I don't know" or Not applicable counts as answered.
            const answered = v2Profile(metadataFor(value.profileRef)) ? row => !['unknown', 'not_applicable'].includes(row.responseOptionId)
                : row => ['yes', 'partial', 'no'].includes(row.responseOptionId);
            return { assessmentId: value.assessmentId, submittedAt: value.updatedAt, scope: value.scopePopulation.description,
                attainment: result.attainment, total: result.total,
                answered: new Set(result.domains.flatMap(domain => domain.controls.flatMap(control => control.questions))
                    .filter(answered).map(question => question.itemId)),
                domains: result.domains.map(domain => ({ title: domain.title, attainment: domain.attainment })),
                // Each saved answer by question, so Compare can list the answers
                // behind a changed figure (#731).
                answers: new Map(result.domains.flatMap(domain => domain.controls.flatMap(control => control.questions.map((question, index) =>
                    [question.itemId, { answer: question.answer, title: control.questions.length > 1 ? control.title + ' (question ' + (index + 1) + ')' : control.title }])))) };
        }
        function trendSection(result) {
            const section = node('section', 'picture-trend'), key = epoch + ':' + detail.assessmentId;
            if (trend && trend.key === key) { trend.section = section; paintTrend(); return section; }
            // Order the loaded submitted results by saved time, never by list position:
            // the list pages by assessment ID, so an unloaded page can hold any date.
            // Scoring v2 (#399): only results on the selected assessment's own profile
            // are compared. Scores from different question sets are never set side by side.
            const others = rows.filter(row => row.status === 'submitted' && row.assessmentId !== detail.assessmentId);
            const otherProfiles = others.filter(row => !sameProfile(row.profileRef, detail.profileRef)).length;
            const ordered = others.filter(row => sameProfile(row.profileRef, detail.profileRef))
                .concat([{ assessmentId: detail.assessmentId, updatedAt: detail.updatedAt }]).sort(newestFirst);
            const index = ordered.findIndex(row => row.assessmentId === detail.assessmentId);
            const start = Math.max(0, index + 2 - TREND_LIMIT), shown = ordered.slice(start, start + TREND_LIMIT);
            const state = trend = { key, section, status: 'ready', total: ordered.length, otherProfiles, v2: v2Profile(selectedMetadata()), profileRef: copy(detail.profileRef), order: shown.map(row => row.assessmentId),
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
                // Only an earlier result on the same profile as the one shown is compared.
                if (!value || value.assessmentId !== row.assessmentId || value.moduleId !== metadata.moduleId ||
                    !sameProfile(value.profileRef, state.profileRef) || !metadataFor(value.profileRef)) return;
                const earlier = questionnaire.resultModel(value, metadataFor(value.profileRef), organisationId);
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
            if (trend.otherProfiles) section.append(node('p', 'dashboard-muted picture-trend-break', (trend.otherProfiles === 1
                ? '1 other submitted assessment used a different set of questions, so it is'
                : trend.otherProfiles + ' other submitted assessments used a different set of questions, so they are') +
                ' not compared with this one or listed here. Results from different sets of questions are not comparable.'));
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
                section.append(node('p', '', trend.otherProfiles ? 'This is the only submitted assessment with this set of questions so far. Another submitted assessment with the same questions is needed to compare saved results and answer coverage.'
                    : 'This is the only submitted assessment so far. Another submitted assessment is needed to compare saved results and answer coverage.'));
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
                    ' answered Yes, Partial or No. ' + shared + ' questions have one of these answers in both. Unknown and Not applicable answers stay unresolved.'));
                // One message from one comparability state (#441 M6-01, #731): the
                // question set is always the same here (other sets are left out
                // above), so say that once, then why no change is calculated.
                const count = selectedMetadata().questions.length;
                section.append(node('p', 'ncsc-warning', (trend.v2 ? 'Same ' + count + ' questions and weights in both'
                    : 'Same accepted questions and weights in both') +
                    (previous.scope !== current.scope ? ', but your business details (scope) differ, so this is not a measure of improvement or decline.'
                        : ' and the same saved scope description. That still does not show the same real-world setup, so this is not a measure of improvement or decline.') +
                    (!sameCoverage ? ' The set of questions answered Yes, Partial or No also differs.' : '') +
                    ' Saved results are shown side by side; no change is calculated.'));
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
                table.append(head, body); section.append(table);
                // The answers behind any changed figure, in question order.
                const changed = [...current.answers].filter(([itemId, now]) => previous.answers.has(itemId) && previous.answers.get(itemId).answer !== now.answer);
                section.append(node('h4', '', 'Answers that changed'));
                if (changed.length) {
                    const list = node('ul', 'picture-trend-changes');
                    changed.forEach(([itemId, now]) => {
                        const item = node('li', '', now.title + ': ' + previous.answers.get(itemId).answer + ' → ' + now.answer);
                        item.dataset.itemId = itemId; list.append(item);
                    });
                    section.append(list);
                } else section.append(node('p', 'picture-trend-changes-none', 'No answers changed.'));
                section.append(node('p', 'dashboard-muted', 'Shared question coverage is not proof of equivalent scope, control effectiveness or a risk trend. Unknown and Not applicable answers still add to the higher figure; no subset is re-scored.'));
            }
            section.append(node('h4', '', 'Submitted assessments'));
            const list = node('ol', 'picture-trend-history');
            trend.order.forEach(assessmentId => {
                const point = trend.points.get(assessmentId), row = rows.find(item => item.assessmentId === assessmentId);
                const item = node('li', '', assessmentId === detail.assessmentId ? 'Selected assessment' : point ? displayDate(point.submittedAt) + ' · ' + point.attainment + ' reported implementation · ' + point.scope
                    : displayDate(row.updatedAt) + ' · Result unavailable');
                if (assessmentId === detail.assessmentId) item.setAttribute('aria-current', 'true');
                list.append(item);
            });
            section.append(list);
            if (trend.order.length < trend.total || after !== null) section.append(node('p', 'dashboard-muted',
                'Showing ' + trend.order.length + ' of ' + trend.total + ' loaded submitted assessments, newest first.' + (after !== null ? ' Other saved assessments are not loaded yet and may be from any date. Load more to include them.' : '')));
            return heading;
        }
        function gapSection(result) {
            const section = questionnaire.rankedGapSection(node, result, selectedMetadata(), id + '-top-gaps',
                gap => planGap && improvementSelection() ? gapPlanControls(gap) : [], displayedGaps);
            for (const owner of section.querySelectorAll('.picture-gap-owner')) {
                if (owner.textContent === 'Ask your IT provider to help with this.') owner.remove();
            }
            if (section.querySelector('ol')) section.append(helpPanel());
            return section;
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
            const questions = selectedMetadata().questions.map(question => indexed.get(question.id))
                .filter(question => ['unknown', 'not_applicable'].includes(question.responseOptionId));
            const unknown = questions.filter(question => question.responseOptionId === 'unknown').length;
            const pending = questions.length - unknown;
            section.append(node('p', '', unknown + ' saved Unknown ' + (unknown === 1 ? 'answer' : 'answers') +
                ' · ' + pending + ' saved Not applicable ' + (pending === 1 ? 'answer' : 'answers') + '.'));
            if (!questions.length) {
                section.append(node('p', '', 'No information requests are suggested by these saved answers.'));
                return section;
            }
            const list = node('ul', 'picture-information-list');
            questions.forEach(question => {
                const item = node('li');
                item.append(node('h4', '', question.prompt), node('p', '', question.responseOptionId === 'unknown'
                    ? 'Saved answer: Unknown. Find out what is in place.'
                    : 'Saved answer: Not applicable. Confirm whether this applies to the assessment scope.'));
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
            }
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
            const offer = questionnaire.managedSecurityOffer(node, gated, doc.defaultView, () => live(token));
            // The shared offer also serves the questionnaire. Keep its gated actions intact.
            const contactNote = Array.from(offer.children).find(child => child.classList.contains('dashboard-muted') &&
                child.textContent.startsWith('Opens the contact form'));
            if (contactNote) contactNote.remove();
            panel.append(offer);
            // #409: present only when the host negotiated contact requests.
            if (contactControl) panel.append(contactControl());
            return panel;
        }
        function summaryHandoff() {
            const win = doc.defaultView, handoff = node('details', 'picture-summary');
            handoff.append(node('summary', '', 'Copy or print a summary'));
            const label = node('label', '', 'Copy this summary into an email or document');
            const input = node('textarea', 'ncsc-textarea'); input.id = id + '-summary'; label.htmlFor = input.id;
            input.readOnly = true; input.rows = 8; input.value = questionnaire.providerSummary(detail, selectedMetadata(), displayedGaps).text;
            // The field scrolls on screen, so paper gets the full text instead.
            const printed = node('pre', 'picture-summary-print', input.value); printed.setAttribute('aria-hidden', 'true');
            const status = node('p', 'dashboard-muted'); status.setAttribute('role', 'status');
            const copyButton = button('Copy summary', () => questionnaire.copySummary(win, input, status));
            copyButton.classList.add('dashboard-button-secondary'); handoff.append(label, input, printed, copyButton);
            // #441: the same answers, written for a board or insurer.
            if (typeof questionnaire.boardSummary === 'function') {
                const token = epoch;
                const boardExport = boardBlock => {
                    if (!live(token)) return boardBlock;
                    return questionnaire.boardSummaryBlock(node, button, win, detail, selectedMetadata(),
                        id + '-board-summary', status, boardBlock,
                        (board, printed, copy, print) => boardPlanControls(handoff, boardBlock, board, printed, copy, print), displayedGaps, previousSubmission());
                };
                if (options.boardExportGate) handoff.append(options.boardExportGate(() => boardExport(node('div', 'picture-board-summary'))));
                else if (typeof options.readBoardPlan === 'function' && typeof options.openAction === 'function') {
                    handoff.append(boardExport(node('div', 'picture-board-summary')));
                } else boardExport(handoff);
            }
            if (win && typeof win.print === 'function') {
                // Paper gets the summary alone, not the whole dashboard (#662).
                const printButton = button('Print these results', () => typeof questionnaire.printOnly === 'function' ? questionnaire.printOnly(win, printed) : win.print());
                printButton.classList.add('dashboard-button-secondary'); handoff.append(printButton);
            }
            handoff.append(status); return handoff;
        }
        // #733: the submitted assessment just before this one, on the same
        // questions, read once per view so the board summary can say it
        // supersedes it. Skipped while other pages are unloaded, because an
        // unseen submission could fall between the two.
        let previousRead = null;
        function previousSubmission() {
            const key = epoch + ':' + detail.assessmentId;
            if (previousRead && previousRead.key === key) return previousRead.promise;
            const token = epoch, submittedAt = Date.parse(detail.updatedAt);
            const earlier = after !== null ? [] : rows.filter(row => row.status === 'submitted' && row.assessmentId !== detail.assessmentId &&
                sameProfile(row.profileRef, detail.profileRef) && Date.parse(row.updatedAt) < submittedAt).sort(newestFirst);
            const promise = !earlier.length ? Promise.resolve(null) : call('read', earlier[0].assessmentId, token).then(response => {
                const value = response && response.assessment;
                return value && value.assessmentId === earlier[0].assessmentId && value.status === 'submitted' &&
                    sameProfile(value.profileRef, detail.profileRef) ? value : null;
            }, error => {
                // A refusal clears the picture, as Compare does; other failures leave the summary as shown.
                if (live(token) && refused(error)) { abort(); epoch++; failure({ statusCode: 403 }, null); render(); }
                return null;
            });
            previousRead = { key, promise };
            return promise;
        }
        function boardPlanControls(handoff, boardBlock, board, boardPrinted, boardCopy, boardPrint) {
            if (typeof options.readBoardPlan !== 'function' || typeof options.openAction !== 'function') return;
            const source = improvementSelection(), token = epoch, binding = sourceBinding();
            if (!source) return;
            let baseText = board.value, lastExtra = '';
            const assignments = node('section', 'picture-board-actions');
            const note = node('p', 'dashboard-muted'); note.setAttribute('role', 'status');
            boardBlock.append(assignments, note);
            let attempt = 0;
            const current = () => currentSubmitted(token, binding, board);
            const setText = extra => { lastExtra = extra; board.value = baseText + extra; boardPrinted.textContent = board.value; };
            const lock = busy => { boardCopy.disabled = busy; if (boardPrint) boardPrint.disabled = busy; };
            lock(true);
            async function checkAssignments() {
                if (!current()) return;
                const read = ++attempt;
                assignments.replaceChildren(); lock(true);
                if (!handoff.open) return;
                setText('');
                note.textContent = 'Checking saved owners and due dates…';
                try {
                    const actions = await options.readBoardPlan(source);
                    if (read !== attempt || !current()) return;
                    const list = node('ol'), lines = [];
                    displayedGaps.forEach((gap, index) => {
                        const question = selectedMetadata().questions.find(row => row.id === gap.itemId);
                        const matches = (actions || []).filter(row => row.itemId === gap.itemId);
                        if (matches.length !== 1) return;
                        const action = matches[0], kind = gap.responseOptionId === 'unknown' ? 'assessment' : 'implementation';
                        if (action.controlId !== question.controlId || action.kind !== kind) return;
                        const title = displayedGaps.some(other => other !== gap && other.title === gap.title) ? question.prompt : gap.title;
                        const item = node('li'); item.value = index + 1;
                        item.append(node('strong', '', title));
                        const saved = (action.owner || 'Unassigned') + ' · ' + (action.dueDate ? 'Due ' + displayDay(action.dueDate) : 'No due date');
                        item.append(node('p', '', saved));
                        if (action.owner && action.dueDate) lines.push((index + 1) + '. ' + title + ' — ' + saved);
                        if (action.editTarget) {
                            const edit = button('Set owner and due date', async () => {
                                if (!currentSubmitted(token, binding, edit) || read !== attempt || edit.disabled) return;
                                edit.disabled = true;
                                try { if (await options.openAction(action.editTarget, true)) return; }
                                catch (_) { /* Keep the saved values visible. */ }
                                if (currentSubmitted(token, binding, edit)) {
                                    edit.disabled = false; note.textContent = 'Couldn’t open this action. Try again.';
                                }
                            });
                            edit.setAttribute('aria-label', 'Set owner and due date for ' + title);
                            item.append(edit);
                        }
                        list.append(item);
                    });
                    if (list.children.length) {
                        assignments.append(node('h4', '', 'Owners and due dates for your top gaps'), list);
                        note.textContent = list.querySelector('button') ? 'Save changes in Improvement Plan, then return to Overview to print.' : '';
                    } else {
                        note.textContent = 'There are no matching saved actions for these gaps.';
                        if (!actions && openImprovement) {
                            const open = button('Open Improvement Plan for this assessment', () => {
                                if (currentSubmitted(token, binding, open)) openImprovement(source);
                            });
                            assignments.append(open);
                        }
                    }
                    setText(lines.length ? '\n' + lines.join('\n') : '');
                } catch (_) {
                    if (read !== attempt || !current()) return;
                    note.textContent = 'Couldn’t check saved owners and due dates. Close and reopen this summary to try again.';
                    setText('\nSaved owners and due dates could not be checked.');
                } finally { if (read === attempt && current()) lock(false); }
            }
            handoff.addEventListener('toggle', checkAssignments);
            // A gate may release its content after the disclosure is already open.
            if (handoff.open) Promise.resolve().then(checkAssignments);
            // #733: the summary text can gain its supersedes lines later; keep the saved owners after it.
            return text => { baseText = text; setText(lastExtra); };
        }
        // Lead with the reported (lower) figure and explain both figures in plain words.
        function leadWithLowerBound(card, model) {
            const value = card.querySelector('.picture-large');
            if (!value || !model.lowerDisplay || model.lowerDisplay === model.upperDisplay || value.textContent !== model.attainment) return;
            value.textContent = model.lowerDisplay + ' in place';
            card.replaceChildren(card.querySelector('h3'), value,
                node('p', 'picture-metric-upper', 'Up to ' + model.upperDisplay + ' if every answer still to confirm turns out to be in place.'),
                node('p', '', 'The first figure is what you reported as in place. The higher figure adds answers still to confirm: Unknown, and Not applicable.'));
        }
        function renderResult(result) {
            const profile = selectedMetadata(), v2 = v2Profile(profile);
            displayedGaps = topGaps(result, profile);
            root.append(gapSection(result));
            const metrics = node('div', 'picture-metrics');
            function metric(label, value, copyText, primary) {
                const card = node('section', primary ? 'picture-metric picture-primary' : 'picture-metric');
                card.append(node('h3', '', label), node('strong', 'picture-large', value), node('p', '', copyText)); metrics.append(card); return card;
            }
            // Mention answers marked not applicable only when there are some.
            const awaitingReview = result.pending ? ', including ' + result.pending + ' marked not applicable' : '';
            const rangeHelp = 'The lower figure is what you reported as in place. The higher figure includes unknown answers and answers marked not applicable, to confirm.';
            // A submitted result is read-only, so do not ask the customer to confirm answers here.
            const implementationMetric = questionnaire.enoughAnswersToEstimate(result)
                ? metric('Reported implementation', result.attainment, rangeHelp, true)
                : metric('Reported implementation', 'Not enough answers to estimate yet, confirm your Unknowns first', result.unknown + ' answers still to confirm. Only ' + result.completed + ' of ' + result.total +
                    ' answers are Yes, Partial or No. Most answers are Unknown or Not applicable, so the range is too wide to be useful. Range so far: ' + result.attainment + '. ' +
                    (typeof options.openCyber === 'function' ? 'Start a new assessment once more answers are known. ' : '') + rangeHelp, true);
            const completionMetric = metric('Answers confirmed', result.completion, result.completed + ' of ' + result.total + ' questions have a yes, partial or no response. ' + result.unknown + ' still to confirm' + awaitingReview + '. All ' + detail.progress.answered + ' responses are saved; submission does not mean all controls are implemented.');
            const calculation = node('details', 'picture-calculation');
            const summary = node('summary', '', 'How the implementation range is calculated');
            summary.id = id + '-reading-guide';
            const guide = node('a', '', 'How to read this'); guide.href = '#' + summary.id;
            guide.addEventListener('click', event => {
                event.preventDefault();
                if (!live() || !root.contains(guide)) return;
                calculation.open = true; summary.focus();
            });
            root.append(guide, metrics, informationSection(result));
            const domains = node('section', 'picture-domains');
            domains.append(node('h3', '', 'Implementation by NCSC function'), node('p', 'dashboard-muted', 'The dark part shows what you reported as in place. The lighter part shows answers still to confirm.'));
            leadWithLowerBound(implementationMetric, result);
            const lowerPercent = percentNumber(result.lowerDisplay), upperPercent = percentNumber(result.upperDisplay);
            if (lowerPercent !== null && upperPercent !== null && questionnaire.enoughAnswersToEstimate(result)) {
                afterHeading(implementationMetric, draw(doc, gaugeSpec(lowerPercent, upperPercent,
                    lowerPercent + ' percent in place' + (upperPercent > lowerPercent ? ', up to ' + upperPercent + ' percent once answers are confirmed' : ''))));
            }
            const yes = Math.max(0, result.completed - result.partial - result.no), toConfirm = Math.max(0, result.total - result.completed);
            const answers = node('div', 'picture-answer-mix');
            const legend = node('ul', 'picture-answer-legend');
            [['Yes', yes, 'solid'], ['Partial', result.partial, 'partial'], ['No', result.no, 'no'], ['To confirm', toConfirm, 'unknown']].forEach(entry => {
                const item = node('li', 'picture-answer-' + entry[2], entry[0] + ' · ' + entry[1]); legend.append(item);
            });
            answers.append(draw(doc, donutSpec([{ value: yes, tone: 'solid' }, { value: result.partial, tone: 'partial' }, { value: result.no, tone: 'no' }, { value: toConfirm, tone: 'unknown' }],
                result.total, 'Answers: ' + yes + ' yes, ' + result.partial + ' partial, ' + result.no + ' no, ' + toConfirm + ' to confirm')), legend);
            afterHeading(completionMetric, answers);
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
                    // Wide screens show a ring instead of the bar (CSS shows one or the other, never both).
                    const low = domain.lowerPercentTenths / 10, high = domain.upperPercentTenths / 10;
                    row.prepend(draw(doc, ringSpec(low, high, domain.title + ': ' + domain.attainment + ' reported as in place',
                        high > low ? Math.round(low) + '–' + Math.round(high) : Math.round(low) + '%')));
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
            profile.domains.forEach(domain => {
                const option = node('option', '', domain.title); option.value = domain.id; filter.append(option);
            });
            filter.value = '';
            const filterStatus = node('p', 'picture-follow-up-status dashboard-muted', 'Showing all functions.');
            filterStatus.setAttribute('role', 'status'); filterStatus.setAttribute('aria-live', 'polite');
            filterToolbar.append(filterLabel, filter); follow.append(filterToolbar, filterStatus);
            const domainByControl = new Map(profile.controls.map(control => [control.id, control.domainId]));
            const domainByQuestion = new Map(profile.questions.map(question => [question.id, domainByControl.get(question.controlId)]));
            const indexed = new Map(result.domains.flatMap(domain => domain.controls.flatMap(control =>
                control.questions.map(question => [question.itemId, question]))));
            // These are display categories over the validated saved result,
            // in accepted profile order. They create no actions or new scores.
            const ordered = profile.questions.map(question => indexed.get(question.id));
            const categories = [
                ['Unresolved answers', ordered.filter(question => ['unknown', 'not_applicable'].includes(question.responseOptionId)),
                    result.unknown ? result.unknown + ' answers still to confirm: check the position. Not applicable answers count as not yet met, and they stay in your result. There is no review that changes that.'
                        : 'No unresolved answers in this saved submission. Confirm the scope still matches the organisation.'],
                // v2 (#399): every answer short of full credit except "I don't know", which is unresolved above.
                ['Reported implementation gaps', ordered.filter(question => v2 ? v2Shortfall(question.responseOptionId)
                    : ['partial', 'no'].includes(question.responseOptionId)),
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
                const domain = profile.domains.find(value => value.id === filter.value);
                if (filter.value && !domain) return;
                renderFilter(domain);
            });
            root.append(follow);
            calculation.append(summary, node('p', '', 'This self-reported assessment helps you plan improvements. It does not establish risk priority, control effectiveness, audit assurance or certification.'), v2
                // v2 (#399): weighted questions and graded credit, held in hundredths.
                ? node('p', '', 'Each question has a weight of 1, 2 or 3. Your answer earns all, part or none of that weight: Yes, in place and checked earns all of it, Partly in place half, Sometimes but not written down or checked a quarter, and No nothing. The extra login method question earns part of its weight by method. I don\'t know, missing and Not applicable answers earn nothing in the lower figure and all of the weight in the upper figure.')
                : node('p', '', 'No Fries gives each question equal weight: Yes = 1, Partial = 0.5 and No = 0. Unknown, missing and Not applicable answers contribute 0 to the lower figure and 1 to the higher figure. A Not applicable answer stays in the count. There is no review that takes it out.'),
                node('p', '', 'This saved result: ' + (v2 ? result.lowerCreditUnits / 100 : result.lowerCreditUnits / 2) + '–' + (v2 ? result.upperCreditUnits / 100 : result.upperCreditUnits / 2) + ' reported or possible credits ÷ ' + result.denominatorWeight + ' included question weights × 100 = ' + result.attainment + '. Percentages are rounded to one decimal place.'),
                node('p', '', 'The overall result weights questions across the five functions. Each function contains a different number of questions. Evidence and confidence do not increase this measure.'));
            root.append(calculation);
            root.append(sourceDetails());
            const attribution = node('footer', 'dashboard-muted');
            const licence = node('a', '', 'CC BY 4.0'); licence.href = 'https://creativecommons.org/licenses/by/4.0/';
            const [credit, changes] = profile.attribution.split('CC BY 4.0');
            attribution.append(node('span', '', credit), licence, node('span', '', changes || ''));
            return attribution;
        }
        async function load(append, firstPaint) {
            if (!live() || denied || loading) return;
            const savedFocus = captureFocus();
            abort(); const token = ++epoch; loading = true; message = ''; detail = null; retry = null; render();
            let early = null;
            if (!firstPaint && !append && !selected && likelyAssessmentId) {
                // One attempt per mount. Any failure is ignored here; the normal read then decides.
                const likely = likelyAssessmentId, request = new AbortController(); likelyAssessmentId = null; requests.add(request);
                early = { assessmentId: likely, cancel() { request.abort(); },
                    response: Promise.resolve().then(() => client.read(likely, { signal: request.signal }))
                        .then(value => value, () => null).finally(() => { requests.delete(request); }) };
            }
            try {
                const response = firstPaint ? firstPaint.page : await call('list', { limit: 50, afterAssessmentId: append ? after : null }, token);
                if (!response) return;
                if (!Array.isArray(response.assessments) || response.assessments.some(row =>
                    row.moduleId !== metadata.moduleId || !metadataFor(row.profileRef))) throw new Error('picture_response_invalid');
                const combined = new Map((append ? rows : []).map(row => [row.assessmentId, row]));
                response.assessments.forEach(row => combined.set(row.assessmentId, copy(row)));
                rows = Array.from(combined.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.assessmentId.localeCompare(b.assessmentId));
                if (firstPaint && firstPaint.detail) {
                    early = { assessmentId: firstPaint.detail.assessment.assessmentId,
                        response: firstPaint.detail, cancel() {} };
                }
                after = response.nextAfterAssessmentId; loaded = true;
                allowance = response.submissionAllowance ? copy(response.submissionAllowance) : null;
                // Keep a carried or manual selection across refresh. Otherwise prefer
                // the latest submitted record on this page, then the latest unfinished one.
                if (!selected) selected = preferredAssessmentId(rows);
            } catch (error) { if (live(token)) failure(error, () => load(append)); }
            finally { if (live(token)) { loading = false; render(); restoreFocus(savedFocus); } }
            const usable = !!early && live(token) && !message && early.assessmentId === selected;
            if (early && !usable) early.cancel();
            if (live(token) && !message && selected) await read(selected, undefined, usable ? early : null);
        }
        async function read(assessmentId, source, early) {
            if (!live() || denied || !rows.some(row => row.assessmentId === assessmentId) && assessmentId !== initialAssessmentId && assessmentId !== selected) return;
            // An early read for this same assessment is still in flight: keep it. Anything else is cancelled.
            if (early) clearExplanation(); else abort();
            const token = ++epoch; const savedFocus = captureFocus(); selected = assessmentId; detail = null; message = ''; retry = null; loading = true; render();
            try {
                const started = early ? await early.response : null;
                if (!live(token)) return;
                // The early read ran beside the list. Use it only if it is the exact revision the list reported;
                // if the assessment was saved or submitted in between, read it again.
                const row = rows.find(item => item.assessmentId === assessmentId), earlier = started && started.assessment;
                const same = !!earlier && !!row && earlier.revision === row.revision && earlier.revisionSha256 === row.revisionSha256 &&
                    earlier.status === row.status && earlier.updatedAt === row.updatedAt;
                const response = same ? started : await call('read', assessmentId, token); if (!response) return;
                const value = response.assessment;
                if (!value || value.assessmentId !== assessmentId || value.moduleId !== metadata.moduleId ||
                    !metadataFor(value.profileRef)) throw new Error('picture_response_invalid');
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
        mounted.set(root, controller);
        function start(firstPaint) {
            if (!live()) return;
            load(false, firstPaint);
            if (readActions) {
                const result = firstPaint && firstPaint.actions ? Promise.resolve(firstPaint.actions) : Promise.resolve().then(readActions);
                result.then(value => {
                    if (!live()) return; actions = actionSummary(value, metadata, profileMetadata); placeActions();
                }, () => {});
            }
        }
        if (options.readFirstPaint) {
            loading = true; render();
            options.readFirstPaint().then(value => {
                loading = false; start(value);
            }, () => {
                loading = false; start(null);
            });
        } else start(null);
        return controller;
    }
    return Object.freeze({ mount, topGaps, confirmNext, actionSummary, preferredAssessmentId, charts: Object.freeze({ gaugeSpec, donutSpec, ringSpec, draw, percentNumber }) });
}));
