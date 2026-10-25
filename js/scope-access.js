(function () {
    if (document.body.dataset.page !== 'scope') {
        return;
    }

    const loading = document.getElementById('scope-loading');
    const errorPanel = document.getElementById('scope-error');
    const documentPanel = document.getElementById('scope-document');
    const verifiedEmail = document.getElementById('verified-email');
    const printButton = document.getElementById('print-scope');

    printButton.addEventListener('click', function () {
        window.print();
    });

    loadScope();

    async function loadScope() {
        try {
            const response = await fetch('/api/scope/content', {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            });
            if (!response.ok) {
                throw new Error('verified_access_required');
            }
            const payload = await response.json();
            renderScope(payload.scope);
            verifiedEmail.textContent = payload.viewer && payload.viewer.emailHint
                ? `Verified: ${payload.viewer.emailHint}`
                : 'Verified access';
            printButton.hidden = false;
            loading.classList.add('is-hidden');
            documentPanel.classList.remove('is-hidden');
        } catch (error) {
            loading.classList.add('is-hidden');
            errorPanel.classList.remove('is-hidden');
        }
    }

    function renderScope(scope) {
        document.getElementById('scope-title').textContent = scope.title;
        document.getElementById('scope-summary').textContent = scope.summary;
        document.getElementById('scope-principle').textContent = scope.standardisation;

        const meta = document.getElementById('scope-meta');
        appendDefinition(meta, 'Version', scope.version);
        appendDefinition(meta, 'Applies to', scope.appliesTo);
        appendDefinition(meta, 'User support', scope.serviceHours.userSupport);
        appendDefinition(meta, 'Security', scope.serviceHours.securityMonitoring);

        const content = document.getElementById('scope-content');
        scope.sections.forEach(function (section, index) {
            const article = element('section', 'scope-section');
            const header = element('header', 'scope-section-header');
            const number = element('span', 'scope-section-index', String(index + 1).padStart(2, '0'));
            const headingBody = element('div');
            headingBody.appendChild(element('h2', '', section.title));
            headingBody.appendChild(element('p', '', section.introduction));
            header.append(number, headingBody);

            const list = element('ul', 'scope-items');
            section.items.forEach(function (item) {
                const row = element('li', 'scope-item');
                row.appendChild(element('strong', '', item.name));
                const body = element('div', 'scope-item-body');
                body.appendChild(element('p', '', item.included));
                if (item.boundary) {
                    const boundary = element('p', 'scope-boundary');
                    const label = element('b', '', 'Limit: ');
                    boundary.append(label, document.createTextNode(item.boundary));
                    body.appendChild(boundary);
                }
                row.appendChild(body);
                list.appendChild(row);
            });
            article.append(header, list);
            content.appendChild(article);
        });

        const lists = document.getElementById('scope-lists');
        lists.appendChild(listCard('Customer responsibilities', scope.customerResponsibilities));
        lists.appendChild(listCard('Not included in the standard service', scope.outsideScope));
        lists.appendChild(listCard('Monthly service record', scope.monthlyRecord));
        lists.appendChild(listCard('Your service schedule', scope.customerSchedule));
    }

    function appendDefinition(list, term, description) {
        const row = element('div');
        row.append(element('dt', '', term), element('dd', '', description));
        list.appendChild(row);
    }

    function listCard(title, items) {
        const article = element('section', 'scope-list-card');
        article.appendChild(element('h2', '', title));
        const list = element('ul');
        items.forEach(function (item) {
            list.appendChild(element('li', '', item));
        });
        article.appendChild(list);
        return article;
    }

    function element(tagName, className, text) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
}());
