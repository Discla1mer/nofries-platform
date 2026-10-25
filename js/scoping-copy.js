(function () {
    const root = document.getElementById('viewRoot');
    if (!root) return;

    const observer = new MutationObserver(applyManagedItCopy);
    observer.observe(root, { childList: true, subtree: true });
    applyManagedItCopy();

    function applyManagedItCopy() {
        const heading = root.querySelector('.page > .page-heading h1, .page h1');
        const activeNav = document.querySelector('.nav-item.is-active');
        const view = activeNav && activeNav.dataset.view || '';

        if (heading && view === 'overview') {
            setText(heading, 'Customer set-up');
            setHeadingDescription(heading, 'Move a qualified prospect through the service review, plan, proposal and customer set-up.');
        }
        if (heading && view === 'discovery' && !root.querySelector('.question-list')) {
            setText(heading, 'Managed IT service review');
            setHeadingDescription(heading, 'Complete or review the customer information needed to confirm the standard managed IT service.');
        }
        if (heading && view === 'recommendations') {
            setText(heading, 'Managed IT service plan');
        }
        if (heading && view === 'proposals') {
            setText(heading, 'Proposal');
        }

        root.querySelectorAll('.quick-start article, .quick-start a, .quick-start button').forEach((item) => {
            const text = item.textContent || '';
            if (/continue a discovery/i.test(text)) replaceFirstText(item, 'Continue service review');
            if (/review matches/i.test(text)) replaceFirstText(item, 'Review service plan');
            if (/prepare a proposal/i.test(text)) replaceFirstText(item, 'Prepare proposal');
        });

        const catalogueLabel = root.querySelector('input[name="label"]');
        if (catalogueLabel) catalogueLabel.placeholder = 'No Fries managed IT catalogue — v1';

        if (view === 'admin') {
            root.querySelectorAll('.notice-warning').forEach((notice) => {
                const text = notice.textContent || '';
                if (/external hosting|IP or real customer information/i.test(text)) {
                    setHtml(notice, '<strong>Use authorised No Fries and customer information only.</strong><p>Do not copy employer, third-party or customer material into this workspace unless No Fries is authorised to process it.</p>');
                }
            });
        }
    }

    function setHeadingDescription(heading, text) {
        const container = heading.closest('.page-heading');
        if (!container) return;
        const paragraph = container.querySelector('p:not(.eyebrow)');
        setText(paragraph, text);
    }

    function replaceFirstText(element, replacement) {
        const strong = element.querySelector('strong');
        setText(strong, replacement);
    }

    function setText(element, value) {
        if (element && element.textContent !== value) {
            element.textContent = value;
        }
    }

    function setHtml(element, value) {
        if (element && element.innerHTML !== value) {
            element.innerHTML = value;
        }
    }
}());
