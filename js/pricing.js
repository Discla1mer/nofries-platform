(function () {
    const price = document.getElementById('paid-assessment-price');
    if (!price) return;
    fetch('/api/pricing/paid', { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } })
        .then(response => response.ok ? response.json() : {})
        .then(data => {
            if (typeof data?.price === 'string') price.textContent = data.price;
        })
        .catch(() => { /* The default copy remains visible when pricing is unavailable. */ });
}());
