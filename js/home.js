(function () {
    function selectDetailTab(dialog, tab, focus) {
        const tabs = Array.from(dialog.querySelectorAll('[data-detail-tab]'));
        const panels = Array.from(dialog.querySelectorAll('[data-detail-panel]'));
        if (!tabs.includes(tab) || tab.disabled || !panels.some(panel => panel.dataset.detailPanel === tab.dataset.detailTab)) return;
        tabs.forEach(function (button, index) {
            const active = button === tab;
            button.id = button.id || dialog.id + '-tab-' + index;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
            const panel = panels.find(item => item.dataset.detailPanel === button.dataset.detailTab);
            if (panel) {
                panel.id = panel.id || dialog.id + '-panel-' + index;
                button.setAttribute('aria-controls', panel.id);
                panel.setAttribute('role', 'tabpanel');
                panel.setAttribute('aria-labelledby', button.id);
                panel.tabIndex = 0;
                panel.classList.toggle('is-active', active);
                panel.hidden = !active;
            }
        });
        if (focus) tab.focus();
    }

    document.addEventListener('keydown', function (event) {
        if (!event.target || typeof event.target.closest !== 'function' || event.altKey || event.ctrlKey || event.metaKey) return;
        const tab = event.target.closest('[data-detail-tab]');
        const dialog = tab && tab.closest('dialog');
        if (!dialog || !dialog.open) return;
        const tabs = Array.from(dialog.querySelectorAll('[data-detail-tab]')).filter(button => !button.disabled);
        const index = tabs.indexOf(tab);
        if (index < 0) return;
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        selectDetailTab(dialog, tabs[next], true);
    });
    document.addEventListener('click', function (event) {
        if (!event.target || typeof event.target.closest !== 'function') return;
        const opener = event.target.closest('[data-dialog]');
        if (opener) {
            const dialog = document.getElementById(opener.dataset.dialog);
            if (dialog && !dialog.open && typeof dialog.showModal === 'function') {
                // Configure only service-detail tabs; native dialog focus/close stays intact.
                if (typeof dialog.querySelectorAll === 'function') {
                    const tabs = Array.from(dialog.querySelectorAll('[data-detail-tab]'));
                    const selected = tabs.find(tab => !tab.disabled && tab.getAttribute('aria-selected') === 'true') || tabs.find(tab => !tab.disabled);
                    if (selected) selectDetailTab(dialog, selected, false);
                }
                dialog.showModal();
            }
            return;
        }

        const detailTab = event.target.closest('[data-detail-tab]');
        if (detailTab) {
            const dialog = detailTab.closest('dialog');
            if (dialog) selectDetailTab(dialog, detailTab, false);
            return;
        }

        const closer = event.target.closest('[data-close-dialog]');
        if (closer) {
            const dialog = closer.closest('dialog');
            if (dialog) dialog.close();
            return;
        }

        // Discovery input focus belongs to the service client once its async
        // initialisation enables the input; dialog opening alone is too early.
    });

    document.querySelectorAll('dialog.home-dialog').forEach(function (dialog) {
        let startedOnBackdrop = false;
        function outsideDialog(event) {
            if (event.target !== dialog || !dialog.open ||
                typeof dialog.getBoundingClientRect !== 'function') return false;
            const bounds = dialog.getBoundingClientRect();
            if (![event.clientX, event.clientY, bounds.left, bounds.right, bounds.top, bounds.bottom]
                .every(Number.isFinite) || bounds.right < bounds.left || bounds.bottom < bounds.top) return false;
            return event.clientX < bounds.left || event.clientX > bounds.right ||
                event.clientY < bounds.top || event.clientY > bounds.bottom;
        }
        dialog.addEventListener('pointerdown', function (event) {
            startedOnBackdrop = event.button === 0 && event.isPrimary !== false && outsideDialog(event);
        });
        function clearGesture() { startedOnBackdrop = false; }
        dialog.addEventListener('pointercancel', clearGesture);
        dialog.addEventListener('close', clearGesture);
        dialog.addEventListener('click', function (event) {
            // Text selection or dragging out of the dialog is not a backdrop
            // dismissal. Both ends of an intentional pointer click must be outside.
            const dismiss = startedOnBackdrop && event.detail !== 0 && outsideDialog(event);
            clearGesture();
            if (dismiss) dialog.close();
        });
    });
}());

// Carry campaign labels only on the four public ad pages. Reuse this script:
// no storage, click IDs, requests or changes to sign-in/service parameters.
(function () {
    if (!document.body || document.body.dataset.page !== 'ad-landing') return;
    const campaign = [...new URLSearchParams(window.location.search)]
        .filter(([name]) => /^utm_[a-z0-9_]+$/i.test(name));
    if (!campaign.length) return;
    document.querySelectorAll('a[href^="/"]').forEach(function (link) {
        const target = new URL(link.getAttribute('href'), window.location.href);
        if (target.origin !== window.location.origin) return;
        for (const name of new Set(campaign.map(([name]) => name))) target.searchParams.delete(name);
        for (const [name, value] of campaign) target.searchParams.append(name, value);
        link.setAttribute('href', target.pathname + target.search + target.hash);
    });
}());

// Ad landing (#441): match the headline to the trigger a Meta campaign was
// written for. Reads only utm_campaign from this page's address and checks
// it against a closed list; only fixed sentences are written. Nothing is
// stored or sent. Any other visitor sees the page unchanged.
(function () {
    const MESSAGES = {
        insurance: ['Filling out a cyber insurance form?',
            'List your key accounts, including email and online banking, and mark which ones have multi-factor authentication turned on. The free check takes about 15 minutes and covers New Zealand’s National Cyber Security Centre (NCSC) guidance.'],
        supplier: ['Has a customer sent you a security questionnaire?',
            'Pick one question about who can see customer files. Check the access list for the folder where you keep them. The free check takes about 15 minutes and covers New Zealand’s National Cyber Security Centre (NCSC) guidance.'],
        board: ['Has your board asked about cyber security?',
            'For your next board meeting, write down when your team last restored a file from backup. If nobody knows, record that as an open question. The free check takes about 15 minutes and covers New Zealand’s National Cyber Security Centre (NCSC) guidance.'],
        scam: ['Could your team spot a fake invoice?',
            'If bank details change, call your supplier on a number you already know to verify the change before paying. Do not use the number on the invoice. The free check takes about 15 minutes and covers New Zealand’s National Cyber Security Centre (NCSC) guidance.']
    };
    try {
        if (!document.body || document.body.dataset.page !== 'dashboard-home') return;
        const campaign = String(new URLSearchParams(window.location.search).get('utm_campaign') || '').toLowerCase();
        const key = campaign.split(/[-_ ]/)[0];
        if (!Object.prototype.hasOwnProperty.call(MESSAGES, key)) return;
        const headline = document.getElementById('home-title');
        const lead = document.getElementById('homepageLead');
        if (headline) headline.textContent = MESSAGES[key][0];
        if (lead) {
            lead.textContent = MESSAGES[key][1];
            lead.classList.add('homepage-campaign-lead');
        }
    } catch (_) { /* leave the page unchanged */ }
}());
