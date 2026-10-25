'use strict';

const DEPENDENCIES = Object.freeze(['identity', 'snapshotStore', 'auditStore']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Read-only operator observation, never an admission decision or public route.
// Adapters must honour the cooperative token and return exactly { ready: boolean }.
// The token is not an AbortSignal and must not be passed to a native SDK as one.
// No provider connectivity, binding or service entitlement participates here.
function createDashboardReadiness(adapters, timeoutMs = 1000) {
    const dependencies = record(adapters, [...DEPENDENCIES, 'clock']);
    if (Object.values(dependencies).some(value => typeof value !== 'function') ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
        throw new Error('dashboard_readiness_configuration_invalid');
    }
    return async function inspectReadiness() {
        const states = await Promise.all(DEPENDENCIES.map(key => probe(dependencies[key], timeoutMs)));
        let checkedAt = null;
        try { checkedAt = instant(dependencies.clock()); } catch (error) { /* Unavailable, no raw error. */ }
        return Object.freeze({ schemaVersion: 1, capability: 'dashboard',
            ready: checkedAt !== null && states.every(state => state === 'ready'), checkedAt,
            dependencies: Object.freeze(Object.fromEntries(DEPENDENCIES.map((key, index) => [key, states[index]]))) });
    };
}
function probe(callback, timeoutMs) {
    return new Promise(resolve => {
        const cancellation = createCancellation();
        let settled = false;
        const finish = state => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (state !== 'timed_out') cancellation.dispose();
            resolve(state);
        };
        const timer = setTimeout(() => {
            finish('timed_out');
            cancellation.cancel();
        }, timeoutMs);
        Promise.resolve().then(() => callback(Object.freeze({ cancellation: cancellation.token })))
            .then(value => {
                const result = record(value, ['ready']);
                finish(result.ready === true ? 'ready' : 'unavailable');
            }).catch(() => finish('unavailable'));
    });
}
function createCancellation() {
    let cancelled = false, disposed = false;
    const listeners = new Set();
    const invoke = listener => {
        try { Promise.resolve(listener()).catch(() => {}); } catch (error) { /* Redacted cancellation failure. */ }
    };
    const token = Object.freeze({
        isCancelled: () => cancelled,
        onCancel(listener) {
            if (typeof listener !== 'function') throw new Error('dashboard_readiness_invalid');
            if (cancelled) invoke(listener);
            else if (!disposed) listeners.add(listener);
            return () => listeners.delete(listener);
        }
    });
    return { token,
        cancel() {
            if (cancelled || disposed) return;
            cancelled = true;
            const pending = [...listeners];
            listeners.clear();
            for (const listener of pending) invoke(listener);
        },
        dispose() { disposed = true; listeners.clear(); }
    };
}
function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('dashboard_readiness_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) ||
        fields.some(key => !own(descriptors, key) || !own(descriptors[key], 'value'))) throw new Error('dashboard_readiness_invalid');
    return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('dashboard_readiness_invalid');
    return value;
}
module.exports = { DEPENDENCIES, createDashboardReadiness };
