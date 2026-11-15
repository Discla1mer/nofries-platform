'use strict';

// One bounded way to send a query for the account wipe. PostgreSQL's
// statement_timeout cannot settle a client promise whose answer never arrives
// (a stalled connection), so every query is also raced against a client-side
// timer and the run signal. On expiry the connection is marked broken: the
// caller must destroy it (release(true)) without sending, or awaiting,
// anything queued behind the stalled query.
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function createBoundedSender(client, signal) {
    let broken = false;
    function send(sql, params, ms, code) {
        if (broken) fail(code);
        if (signal?.aborted) { broken = true; fail(code); }
        let timer, onAbort;
        const call = params === undefined ? client.query(sql) : client.query(sql, params);
        const expired = new Promise((_, reject) => {
            const stop = () => { broken = true; reject(Object.assign(new Error(code), { code })); };
            timer = setTimeout(stop, Math.max(1, Math.floor(ms)));
            onAbort = stop; signal?.addEventListener('abort', onAbort, { once: true });
        });
        return Promise.race([call, expired]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
    }
    return Object.freeze({ send, get broken() { return broken; } });
}

module.exports = { createBoundedSender };
