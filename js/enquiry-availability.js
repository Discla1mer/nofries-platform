(function () {
    // Campaign tag for enquiries. On landing from an ad link, keep only the
    // utm_source, utm_medium and utm_campaign labels (or "meta" when Meta adds
    // fbclid without UTM tags) in this tab's sessionStorage. No cookie, no
    // click ID and nothing is sent until the visitor submits the contact form.
    window.enquiryCampaign = function () {
        try { return String(window.sessionStorage.getItem('nofries-enquiry-campaign') || ''); } catch (_) { return ''; }
    };
    try {
        const params = new URLSearchParams(window.location.search);
        const label = function (value) {
            const text = String(value || '').trim().toLowerCase();
            return /^[a-z0-9._-]{1,40}$/.test(text) ? text : '';
        };
        let source = label(params.get('utm_source'));
        if (!source && params.has('fbclid')) source = 'meta';
        if (source && !window.enquiryCampaign()) {
            const tag = [source, label(params.get('utm_medium')), label(params.get('utm_campaign'))].join('/');
            window.sessionStorage.setItem('nofries-enquiry-campaign', tag);
        }
    } catch (_) { /* storage blocked: no tag */ }

    // Read configuration only. Never submit an enquiry or consume a quota permit.
    window.enquiryAvailability = async function () {
        const controller = new AbortController();
        let timer;
        try {
            const deadline = new Promise(function (_, reject) {
                timer = setTimeout(function () { controller.abort(); reject(new Error('unavailable')); }, 5000);
            });
            const read = (async function () {
                const response = await fetch('/api/enquiry', {
                    credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
                    headers: { Accept: 'application/json' }
                });
                if (!response.ok) throw new Error('unavailable');
                const body = await response.json();
                // #151 F4: the server marks API responses only while funnel counts are on.
                const funnel = Boolean(response.headers && typeof response.headers.get === 'function' &&
                    response.headers.get('x-nofries-funnel') === 'on');
                return { available: body.available === true, promote: body.available === true && body.promote === true,
                    ...(funnel ? { funnel: true } : {}) };
            }());
            return await Promise.race([read, deadline]);
        } catch (_) {
            return { available: false, promote: false };
        } finally {
            clearTimeout(timer);
            controller.abort();
        }
    };
}());
