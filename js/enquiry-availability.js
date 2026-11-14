(function () {
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
