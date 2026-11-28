(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./parseRequirements'));
    else root.NoFriesRequirementsReview = factory(root.NoFriesRequirementsParser);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (parser) {
    'use strict';
    // Local-only component, deliberately not in a dashboard manifest or route.
    function mountRequirementsReview(host) {
        const doc = host.ownerDocument;
        function element(tag, text, className) {
            const el = doc.createElement(tag);
            if (text !== undefined) el.textContent = text;
            if (className) el.className = className;
            return el;
        }
        const section = element('section', undefined, 'dashboard-panel ncsc-questionnaire');
        const heading = element('h2', 'Review your requirements');
        const help = element('p', 'Paste one requirement per line. Numbered lists and bullets work too. Indent a line to continue the previous item.');
        const label = element('label', 'Requirements to review');
        const input = element('textarea');
        input.rows = 6;
        label.append(input);
        const preview = element('button', 'Preview requirements', 'dashboard-button');
        preview.type = 'button';
        const status = element('p');
        status.setAttribute('role', 'status');
        const list = element('ol');
        list.setAttribute('aria-label', 'Requirements in pasted order');
        const note = element('p', 'This preview stays on this page. It does not save anything or change your assessment.', 'dashboard-muted');
        function clear() {
            list.replaceChildren();
            list.hidden = true;
            status.textContent = '';
            input.removeAttribute('aria-invalid');
        }
        function review() {
            clear();
            let rows;
            try { rows = parser.parseRequirements(input.value); }
            catch (error) {
                if (!(error instanceof RangeError)) throw error;
                status.textContent = error.message;
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }
            if (!rows.length) {
                status.textContent = 'Paste at least one requirement, then choose Preview requirements.';
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }
            const content = doc.createDocumentFragment();
            for (const row of rows) {
                const item = element('li');
                if (row.sourceNumber !== null) item.append(element('strong', 'Source ' + row.sourceNumber + ': '));
                item.append(doc.createTextNode(row.text));
                content.append(item);
            }
            list.append(content);
            list.hidden = false;
            status.textContent = rows.length + (rows.length === 1 ? ' requirement' : ' requirements') + ' to review.';
        }
        clear();
        input.addEventListener('input', clear);
        preview.addEventListener('click', review);
        section.append(heading, help, label, preview, status, list, note);
        host.replaceChildren(section);
    }
    return { mountRequirementsReview };
}));
