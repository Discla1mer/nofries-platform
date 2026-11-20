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
    // Board prompts are editorial guidance. The registered publication supplies the
    // outcomes, response factors, function order and attribution.
    const functionPurpose = {
        GV: 'Set direction and accountability', ID: 'Understand assets and risks', PR: 'Safeguard services and data',
        DE: 'Spot signs of an incident', RS: 'Manage an incident', RC: 'Restore services'
    };
    const nistTopics = {
        'GV.OC': { topic: 'business needs', action: 'Pick a critical service and ask who relies on it and which commitments are at stake.' },
        'GV.RM': { topic: 'risk decisions', action: 'Ask the risk owner to show how a recent cyber risk decision was made.' },
        'GV.RR': { topic: 'roles and responsibilities', action: 'Name the person accountable for this outcome and check they have the authority to act.' },
        'GV.PO': { topic: 'security policy', action: 'Ask the policy owner to show where staff find the current policy and how changes reach them.' },
        'GV.OV': { topic: 'oversight', action: 'Agree which evidence the board will review and when it will check progress.' },
        'GV.SC': { topic: 'supplier risk', action: 'Choose a critical supplier and ask its owner to show how this outcome is checked.' },
        'ID.AM': { topic: 'assets and dependencies', action: 'Trace one critical service and check its assets and dependencies against the inventory.' },
        'ID.RA': { topic: 'assessing risk', action: 'Ask the risk owner to walk through a recent assessment and its evidence.' },
        'ID.IM': { topic: 'learning from experience', action: 'Choose a lesson from a recent review and check who will act on it.' },
        'PR.AA': { topic: 'identity and access', action: 'Ask the system owner to demonstrate this access safeguard on a critical service.' },
        'PR.AT': { topic: 'staff training', action: 'Ask someone in the affected role to demonstrate what they would do in a realistic situation.' },
        'PR.DS': { topic: 'protecting data', action: 'Choose a sensitive record and check how it is protected throughout its use.' },
        'PR.PS': { topic: 'platform security', action: 'Ask the platform owner to show the safeguard working on a system in scope.' },
        'PR.IR': { topic: 'keeping services running', action: 'Rehearse a disruption with the service owner and record how the service would keep running.' },
        'DE.CM': { topic: 'security monitoring', action: 'Ask the monitoring team to show what it can see for one critical service and where coverage stops.' },
        'DE.AE': { topic: 'investigating unusual activity', action: 'Walk through a recent alert and check what information helped staff decide what to do.' },
        'RS.MA': { topic: 'managing incidents', action: 'Rehearse an incident handover and check who can make the next decision.' },
        'RS.AN': { topic: 'incident analysis', action: 'Ask an investigator to show how they established what happened in a sample incident.' },
        'RS.CO': { topic: 'incident communications', action: 'Practise one incident update and check who must send it and who needs to receive it.' },
        'RS.MI': { topic: 'limiting incident damage', action: 'Ask responders to demonstrate how they would contain a realistic incident.' },
        'RC.RP': { topic: 'restoring services', action: 'Ask the recovery lead to exercise this outcome and show what needs to change.' },
        'RC.CO': { topic: 'recovery communications', action: 'Practise a recovery update and check that affected people receive the information they need.' }
    };
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
                const row = { id: control.id, domainId: control.domainId, title: control.title, status: option.label, reason, applies: option.applicable,
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
            boardBrief: iso ? null : nistBoardBrief(gaps, answers.size, groups),
            groups: domains.map(domain => groupSummary(domain, iso)), statement, gaps: gaps.slice(0, 3) };
    }

    function nistBoardBrief(gaps, total, groups) {
        if (!gaps.length) return 'The team marked all ' + total + ' outcomes Yes. At the next board meeting, ask a service owner to show recent evidence that these practices are working.';
        const first = gaps[0], functionName = groups.get(first.domainId).title;
        const toConfirm = gaps.filter(row => row.factor === null).length;
        const known = gaps.length - toConfirm;
        const counts = 'The team reported gaps in ' + known + ' of ' + total + ' outcomes. ' +
            (toConfirm ? toConfirm + (toConfirm === 1 ? ' answer needs' : ' answers need') + ' confirmation.' : 'None were marked Unknown or Not applicable.');
        const priority = nistTopic(first).topic + ' (' + functionName + ', ' + first.id + ')';
        const decision = known
            ? 'Start with ' + priority + '. Agree who owns the next step, when it is due and what evidence the board will see.'
            : 'Ask management to check the answer about ' + priority + ' and bring supporting evidence to the next meeting.';
        return counts + ' ' + decision;
    }

    function nistTopic(row) {
        return nistTopics[row.id.split('-')[0]] || { topic: row.title, action: row.action };
    }

    function nistGapAction(gap) {
        if (gap.factor !== null) return nistTopic(gap).action;
        return gap.applies ? 'Find the person who can answer this question and ask for a dated example.'
            : 'Check the recorded reason against the scope and confirm whether this outcome applies.';
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
                functionPurpose[domain.id] + ' · ' + domain.rows.length + ' outcomes · ' +
                    domain.rows.filter(row => row.applies && row.factor === null).length + ' unknown · ' + excluded + ' marked not applicable' };
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
        board.append(node('h3', 'Board summary'));
        if (model.boardBrief) board.append(node('p', model.boardBrief));
        board.append(node('h4', groupHeading));
        const list = node('ul', undefined, 'paid-readiness-groups');
        const groupLines = model.groups.map(group => group.title + ' — ' + group.readiness + ' (' + group.detail + ')');
        for (const group of model.groups) {
            const item = node('li');
            item.append(node('strong', group.title), node('span', group.readiness), node('small', group.detail));
            list.append(item);
        }
        const explanation = model.iso
            ? 'Figures use the answers in this submission. Partly in place counts as half. Items marked not applicable are excluded.'
            : 'Yes counts in full and Partial counts as half. A range starts at the reported readiness and ends at the result if every Unknown or Not applicable outcome were in place.';
        if (model.iso) board.append(list, node('p', explanation));
        else board.append(node('p', explanation), list);
        board.append(node('h4', 'Top gaps'));
        const gapList = node('ol'), gapLines = [];
        for (const gap of model.gaps) {
            const label = gap.id + ' · ' + gap.title + ' — ' + gap.status;
            const item = node('li'); item.append(node('strong', label));
            const action = model.iso ? gap.action : nistGapAction(gap);
            if (action) item.append(node('p', action));
            gapList.append(item);
            gapLines.push(label);
        }
        const gapOrder = model.iso ? 'Lower reported readiness comes first. Ties follow publication order.' :
            'Outcomes marked No come first, followed by those marked Partial. Unknown and Not applicable answers are items to check. Ties follow questionnaire order.';
        const gapNote = gapLines.length ? gapOrder :
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
        exportControls(board, 'Board summary', ['Board summary', model.title, model.identity, ...(model.boardBrief ? [model.boardBrief] : []), groupHeading,
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
