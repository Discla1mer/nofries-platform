'use strict';

// Read only public, flag-dependent offer information; omit cookies and attribution.
(function () {
    const counts = document.querySelectorAll('[data-free-check-count]');
    const home = document.querySelectorAll('#homepageLead, [aria-label="Dashboard benefits"] p');
    if (!counts.length && !home.length) return;
    fetch('/api/pricing/paid', { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' } })
        .then(response => response.ok ? response.json() : {})
        .then(body => {
            if (body?.freeCheckQuestions !== 16) return;
            counts.forEach(node => { node.textContent = '16'; });
            // The home hero can be replaced by campaign copy. Never replace the
            // whole paragraph or touch examples, headings, links or other numbers.
            home.forEach(node => node.childNodes.forEach(child => {
                if (child.nodeType === 3) child.data = child.data.replace(/\b14 questions\b/g, '16 questions');
            }));
        })
        .catch(() => { /* The original public wording remains visible. */ });
}());
