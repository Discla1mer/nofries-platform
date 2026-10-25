'use strict';

// Install immediately after creating a test pool, before submitting any work.
// pg-pool can resolve end() after removing a client but before its socket closes.
function trackPoolClientEnds(pool) {
    const clientEnds = [];
    const trackClient = client => {
        clientEnds.push(new Promise(resolve => client.once('end', resolve)));
    };
    pool.on('connect', trackClient);

    let closePromise;
    return function closeAfterClientEnds() {
        if (!closePromise) {
            closePromise = (async () => {
                try {
                    await pool.end();
                } finally {
                    pool.removeListener('connect', trackClient);
                }
                await Promise.all(clientEnds);
            })();
        }
        return closePromise;
    };
}

module.exports = { trackPoolClientEnds };
