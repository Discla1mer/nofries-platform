(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NoFriesPaidResults = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const mounts = new WeakMap();
    const sha256 = /^[a-f0-9]{64}$/;
    const profiles = new Map([
        ['nf-nist-csf-2-0-core', ['2026-09-08.1', 'nist-cybersecurity-framework', '2.0', 'NIST CSF 2.0']],
        ['nf-iso-27001-2022-readiness', ['2026-11-19.1', 'iso-iec-27001', '2022', 'ISO 27001 readiness self-assessment']]
    ]);
    const inOrder = rows => [...rows].sort((a, b) => a.order - b.order);
    function requireValue(condition) {
        if (!condition) throw new Error('paid_results_unavailable');
    }

    // Only consume the selected server read and its authorised, registered publication.
    // Server-side sealing, scope and access checks belong to the loader's read.
    function project(record, publication) {
        const a = record.assessment, ref = a.profileRef, expected = profiles.get(ref.profileId);
        requireValue(record.schemaVersion === 1 && a.moduleId === 'cyber_security' && expected &&
            ref.profileVersion === expected[0] && ref.frameworkId === expected[1] && ref.frameworkVersion === expected[2] &&
            publication.framework.id === ref.frameworkId && publication.framework.version === ref.frameworkVersion &&
            publication.profile.id === ref.profileId && publication.profile.version === ref.profileVersion &&
            ['catalogueSha256', 'sourceCatalogueSha256'].every(key => sha256.test(ref[key]) && ref[key] === publication[key]));
        requireValue(a.status === 'submitted' && a.submission && sha256.test(a.submission.responseSetSha256) &&
            typeof a.assessmentId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(a.assessmentId) &&
            Number.isSafeInteger(a.revision) && a.revision > 0 && a.submission.revision === a.revision &&
            typeof a.submission.submittedAt === 'string' && new Date(a.submission.submittedAt).toISOString() === a.submission.submittedAt);
        const iso = ref.frameworkId === 'iso-iec-27001';
        const answers = new Map(a.responses.map(row => [row.itemId, row]));
        requireValue(a.responses.length === answers.size && answers.size === publication.questions.length);
        const options = new Map(publication.responseOptions.map(option => [option.id, option]));
        const domains = inOrder(publication.domains).map(domain => ({ ...domain, rows: [] }));
        const groups = new Map(domains.map(domain => [domain.id, domain]));
        const questions = new Map();
        for (const question of inOrder(publication.questions)) {
            if (!questions.has(question.controlId)) questions.set(question.controlId, []);
            questions.get(question.controlId).push(question);
        }
        const statement = [], gaps = [];
        for (const control of inOrder(publication.controls)) {
            for (const question of questions.get(control.id)) {
                const answer = answers.get(question.id), option = options.get(answer?.optionId);
                requireValue(option && question.responseOptionIds.includes(option.id));
                const annex = iso && /^A\.[5-8]\.\d+$/.test(control.id);
                const reason = answer.rationale?.text;
                requireValue(option.applicable ? answer.rationale === null :
                    (!iso || annex) && typeof reason === 'string' && reason.trim().length > 0);
                const row = { id: control.id, title: control.title, status: option.label, reason, applies: option.applicable,
                    factor: option.implementationFactor, weight: question.weight, action: question.guidance.startingActions[0] };
                groups.get(control.domainId).rows.push(row);
                if (annex) statement.push(row);
                if ((row.applies || !iso) && row.factor !== 1) gaps.push(row);
            }
        }
        // Known gaps first, then uncertain answers. A tie stays in publication order.
        const rank = row => row.factor === null ? 2 : row.factor;
        gaps.sort((a, b) => rank(a) - rank(b));
        return { title: expected[3], iso, identity: 'Assessment ' + a.assessmentId + ' · Revision ' + a.revision + ' · Submitted ' + a.submission.submittedAt.slice(0, 10) + ' UTC',
            groups: domains.map(domain => groupSummary(domain, iso)), statement, gaps: gaps.slice(0, 3) };
    }

    function groupSummary(domain, iso) {
        let weight = 0, credit = 0, unknown = 0, excluded = 0;
        for (const row of domain.rows) {
            if (!row.applies) {
                excluded++;
                if (iso) continue;
            }
            weight += row.weight;
            if (row.factor === null) unknown += row.weight;
            else credit += row.weight * row.factor;
        }
        const percent = value => (iso ? Math.round(100 * value / weight) : (100 * value / weight).toFixed(1)) + '%';
        let readiness = 'No applicable controls';
        if (weight) readiness = unknown ? percent(credit) + '–' + percent(credit + unknown) : percent(credit);
        const applicable = domain.rows.length - excluded;
        return { title: domain.id + ' · ' + domain.title, readiness,
            detail: iso ? applicable + ' applicable · ' + excluded + ' marked not applicable' :
                domain.rows.length + ' outcomes · ' + excluded + ' marked not applicable, to confirm' };
    }

    function mount(container, { record, publication, isCurrent, authoriseExport }) {
        mounts.get(container)?.destroy();
        const doc = container.ownerDocument, win = doc.defaultView;
        function node(tag, text, className) {
            const el = doc.createElement(tag);
            if (text !== undefined) el.textContent = text;
            if (className) el.className = className;
            return el;
        }
        const panel = node('section', undefined, 'paid-results');
        let paper;
        const handle = { destroy() {
            if (mounts.get(container) !== handle) return;
            paper?.remove();
            panel.remove();
            mounts.delete(container);
        } };
        const live = () => mounts.get(container) === handle && container.contains(panel) && isCurrent() === true;
        mounts.set(container, handle);
        container.replaceChildren(panel);
        let model;
        try {
            requireValue(live());
            model = project(record, publication);
        } catch {
            panel.textContent = 'These saved results are unavailable.';
            return handle;
        }
        const heading = node('h2', model.title);
        panel.append(heading, node('p', model.identity));
        const board = node('section');
        const groupHeading = 'Readiness by ' + (model.iso ? 'clause group and theme' : 'function');
        board.append(node('h3', 'Board summary'), node('h4', groupHeading));
        const list = node('ul', undefined, 'paid-readiness-groups');
        const groupLines = model.groups.map(group => group.title + ' — ' + group.readiness + ' (' + group.detail + ')');
        for (const group of model.groups) {
            const item = node('li');
            item.append(node('strong', group.title), node('span', group.readiness), node('small', group.detail));
            list.append(item);
        }
        const explanation = 'Figures use the answers in this submission. Partly in place counts as half. ' +
            (model.iso ? 'Items marked not applicable are excluded.' :
                'Unknown answers and claims of non-applicability stay in the range until confirmed.');
        board.append(list, node('p', explanation), node('h4', 'Top gaps'));
        const gapList = node('ol'), gapLines = [];
        for (const gap of model.gaps) {
            const label = gap.id + ' · ' + gap.title + ' — ' + gap.status;
            const item = node('li'); item.append(node('strong', label));
            if (gap.action) item.append(node('p', gap.action));
            gapList.append(item);
            gapLines.push(label);
        }
        const gapNote = gapLines.length ? 'Lower reported readiness comes first. Ties follow publication order.' :
            'No gaps were identified in the applicable answers.';
        board.append(node('p', gapNote), gapList);
        const limit = model.iso ? 'This is a readiness self-assessment, not certification. For accredited certification, use an accredited certification body.' :
            'This summary reflects your own answers about the functions in scope. ' + publication.statements.attribution;
        board.append(node('p', limit));
        panel.append(board);

        function exportControls(section, name, blocks, headings = []) {
            if (typeof authoriseExport !== 'function') return;
            const notice = node('p'); notice.setAttribute('role', 'status');
            const controls = node('div', undefined, 'paid-results-controls');
            let pending = false;
            for (const verb of ['Copy', 'Print']) {
                const button = node('button', verb + ' ' + name.toLowerCase(), 'dashboard-button dashboard-button-secondary');
                button.type = 'button';
                button.addEventListener('click', async function () {
                    if (pending || !live()) return;
                    pending = true;
                    try {
                        if (await authoriseExport() !== true || !live()) throw new Error();
                        if (verb === 'Copy') {
                            await win.navigator.clipboard.writeText(blocks.join('\n\n'));
                            if (live()) notice.textContent = name + ' copied.';
                        } else {
                            paper = node('article', undefined, 'paid-results-paper');
                            paper.append(node('h1', blocks[0]));
                            for (const block of blocks.slice(1)) paper.append(node(headings.includes(block) ? 'h2' : 'p', block));
                            doc.body.append(paper);
                            try { win.print(); } finally { paper.remove(); }
                        }
                    } catch {
                        if (live()) notice.textContent = verb + ' is unavailable for this assessment.';
                    } finally { pending = false; }
                });
                controls.append(button);
            }
            section.append(controls, notice);
        }
        exportControls(board, 'Board summary', ['Board summary', model.title, model.identity, groupHeading,
            ...groupLines, explanation, 'Top gaps', gapNote, ...gapLines, limit], [groupHeading, 'Top gaps']);
        if (model.iso) {
            const section = node('section'), title = 'Statement of Applicability';
            section.append(node('h3', title));
            const blocks = [title, model.title, model.identity];
            exportControls(section, title, blocks);
            for (const row of model.statement) {
                const label = row.id + ' · ' + row.title;
                const detail = 'Applicability: ' + (row.applies ? 'Applicable' : 'Marked not applicable') +
                    '\nReason: ' + (row.reason || 'No reason recorded') + '\nStatus: ' + row.status;
                const item = node('article');
                item.append(node('h4', label), node('p', detail));
                section.append(item);
                blocks.push(label + '\n' + detail);
            }
            panel.append(section);
        }
        return handle;
    }
    return Object.freeze({ mount });
}));
