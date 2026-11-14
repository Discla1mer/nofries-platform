'use strict';

// Lifecycle email enqueue at starter activation (#151, slice E3). Runs on the
// activation transaction client, so a failed enqueue fails the activation and
// rolls back every activation write, as the submit enqueue does.
const outbox = require('./outboxWriter');

const NUDGE_DELAY_MS = 7 * 86400000;

// Both rows are keyed by the account: one welcome and one nudge per account,
// ever. A retried or replayed activation hits the same keys and writes nothing,
// and a nudge that submit cancelled keeps its key, so it is never queued again.
// Returns false, issuing no SQL, while the enqueue flag is off.
async function enqueueActivationEmails(client, input, env = process.env) {
    if (!outbox.lifecycleEmailEnqueueEnabled(env)) return false;
    if (!input || typeof input !== 'object') throw new outbox.OutboxWriteError();
    const { tenantId, organisationId, accountId, activatedAt } = input;
    const at = typeof activatedAt === 'string' ? Date.parse(activatedAt) : NaN;
    if (!Number.isFinite(at)) throw new outbox.OutboxWriteError();
    const scope = { tenantId, organisationId, accountId };
    await outbox.enqueue(client, { ...scope, type: 'welcome', dedupeKey: accountId,
        notBefore: new Date(at).toISOString(), params: {} });
    await outbox.enqueue(client, { ...scope, type: 'nudge_unfinished', dedupeKey: accountId,
        notBefore: new Date(at + NUDGE_DELAY_MS).toISOString(), params: {} });
    return true;
}

module.exports = { enqueueActivationEmails, NUDGE_DELAY_MS };
