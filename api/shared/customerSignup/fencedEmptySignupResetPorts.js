'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { observeWrite } = require('./signupWriterFence');
const fail = () => { throw new Error('signup_reset_fence_unavailable'); };

// Unwired composition: target version/ETag protection is necessary, but cannot
// exclude an already-dispatched creator. Every reset also needs the common fence.
function createFencedEmptySignupResetPorts({ writerFence, withExclusiveTarget, blobs }) {
    if (typeof writerFence?.withReset !== 'function' || typeof withExclusiveTarget !== 'function' ||
        !['readCurrent', 'readVersion', 'remove', 'restore'].every(k => typeof blobs?.[k] === 'function')) fail();
    const active = new AsyncLocalStorage();
    const mutate = (method, args) => {
        const context = active.getStore();
        if (!context?.open) fail();
        return observeWrite(async () => {
            if (!context.open) fail();
            await context.check();
            if (!context.open) fail();
            return blobs[method](...args);
        });
    };
    return Object.freeze({ blobs: Object.freeze({
        readCurrent: (...args) => blobs.readCurrent(...args), readVersion: (...args) => blobs.readVersion(...args),
        remove: (...args) => mutate('remove', args), restore: (...args) => mutate('restore', args)
    }), withExclusiveTarget: (binding, work) => writerFence.withReset({
        operationId: binding.request.operationId, planSha256: hash(binding.plan)
    }, async common => {
        let open = true, calls = 0, answer, joined = false;
        try {
            const returned = await withExclusiveTarget(binding, async target => {
                if (!open || ++calls !== 1) fail();
                const context = { open: true, async check() {
                    if (!open || !context.open || calls !== 1) fail();
                    await common.check(); await target.assertCurrent(); await common.check();
                    if (!open || !context.open || calls !== 1) fail();
                } };
                try {
                    answer = await active.run(context, () => work(Object.freeze({ assertCurrent: context.check,
                        retain: () => target.retain(), async complete() {
                            await context.check();
                            await observeWrite(() => target.complete());
                            await common.complete();
                        } })));
                    joined = true; return answer;
                } finally { context.open = false; }
            });
            if (!joined || calls !== 1 || returned !== answer) fail();
            return answer;
        } finally { open = false; }
    }) });
}
module.exports = { createFencedEmptySignupResetPorts };
