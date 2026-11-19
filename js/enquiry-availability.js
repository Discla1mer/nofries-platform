(function () {
    function captureEnquiryCampaign(window) {
        try {
            const params = new URLSearchParams(window.location.search);
            const label = function (value) {
                const text = String(value || '').trim().toLowerCase();
                return /^[a-z0-9._-]{1,40}$/.test(text) ? text : '';
            };
            let source = label(params.get('utm_source'));
            if (!source && params.has('fbclid')) source = 'meta';
            if (source && !window.sessionStorage.getItem('nofries-enquiry-campaign')) {
                const tag = [source, label(params.get('utm_medium')), label(params.get('utm_campaign'))].join('/');
                window.sessionStorage.setItem('nofries-enquiry-campaign', tag);
            }
        } catch (_) { /* storage blocked: no tag */ }
    }
    if (typeof module === 'object' && module.exports) {
        module.exports = captureEnquiryCampaign;
        return;
    }
    // Campaign tag for enquiries. On landing from an ad link, keep only the
    // utm_source, utm_medium and utm_campaign labels (or "meta" when Meta adds
    // fbclid without UTM tags) in this tab's sessionStorage. No cookie, no
    // click ID and nothing is sent until the visitor submits the contact form.
    window.enquiryCampaign = function () {
        try { return String(window.sessionStorage.getItem('nofries-enquiry-campaign') || ''); } catch (_) { return ''; }
    };
    // Called only after the server confirms an enquiry was sent; a failed send keeps the tag.
    window.clearEnquiryCampaign = function () {
        try { window.sessionStorage.removeItem('nofries-enquiry-campaign'); } catch (_) { /* nothing stored */ }
    };
    captureEnquiryCampaign(window);

    // Service named by a dashboard "Ask No Fries about this service" link.
    // Only a known key is accepted and only its fixed label is returned, so
    // nothing from the address bar is ever written into the form.
    const SERVICE_TOPICS = {
        // The standing paid offer (pricing.html), named from results and Services.
        managed_security_90: '90-day managed security',
        fractional_advisory: 'Fractional CIO, CTO and CISO',
        managed_endpoint: 'IRMM / RMM monitoring',
        endpoint_security: 'MDR / endpoint security',
        tier1_support: 'Tier 1 support',
        managed_it_core: 'Managed IT',
        work_file_backup: 'Work-file backup',
        microsoft_365_admin: 'Microsoft 365 administration',
        google_workspace_admin: 'Google Workspace administration',
        supplier_coordination: 'Supplier coordination',
        monthly_proof: 'Monthly service proof',
        customer_onboarding: 'Customer onboarding',
        ai_service_desk: 'AI-assisted service desk'
    };
    window.enquiryTopic = function () {
        try {
            const key = String(new URLSearchParams(window.location.search).get('service') || '');
            return Object.prototype.hasOwnProperty.call(SERVICE_TOPICS, key) ? SERVICE_TOPICS[key] : '';
        } catch (_) { return ''; }
    };

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
