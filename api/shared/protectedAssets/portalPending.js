(function (root, factory) {
    'use strict';
    const value = factory();
    if (typeof module === 'object' && module.exports) module.exports = value;
    else root.NoFriesPortalPending = value;
}(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';

    const STORAGE_KEY = 'nofries.customer-portal.pending.v1';
    const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const SHA256_PATTERN = /^[a-f0-9]{64}$/;
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const MAX_RECORDS = 20;
    const MAX_STORAGE_BYTES = 24 * 1024;

    function createStore(options) {
        const settings = options || {};
        const storage = settings.storage;
        const customerScope = clean(settings.customerScope, 180);
        const now = typeof settings.now === 'function' ? settings.now : function () { return Date.now(); };
        const maxAgeMs = Number(settings.maxAgeMs) > 0 ? Number(settings.maxAgeMs) : MAX_AGE_MS;
        let expired = false;

        function load() {
            return readAll().filter(function (item) { return item.customerScope === customerScope; });
        }

        function readAll() {
            expired = false;
            const raw = String(storage && storage.getItem(STORAGE_KEY) || '');
            if (!raw) return [];
            if (utf8ByteLength(raw) > MAX_STORAGE_BYTES) {
                throw new Error('Pending operation storage exceeds the safe recovery limit. Existing operations were preserved.');
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                throw new Error('Pending operation recovery data is invalid. Existing data was preserved.');
            }
            if (!Array.isArray(parsed)) throw new Error('Pending operation recovery data is invalid. Existing data was preserved.');
            const at = now();
            const values = parsed.map(normalise);
            if (values.some(function (item) { return !item; })) {
                throw new Error('Pending operation recovery data is invalid. Existing data was preserved.');
            }
            const slots = new Set();
            for (const item of values) {
                const slot = recoverySlot(item);
                if (slots.has(slot)) {
                    throw new Error('Pending operation recovery data contains a duplicate slot. Existing data was preserved.');
                }
                slots.add(slot);
            }
            values.forEach(function (item) {
                if (at - item.timestamp > maxAgeMs || item.timestamp > at + 60000) {
                    if (item.customerScope === customerScope) expired = true;
                }
            });
            if (values.length > MAX_RECORDS) {
                throw new Error('Pending operation storage is full. Existing operations were preserved.');
            }
            return values.sort(compareNewestFirst);
        }

        function remember(value) {
            return rememberValue(value, false);
        }

        function rememberValue(value, allowOperationIdChange) {
            const item = normalise(Object.assign({}, value, { customerScope: customerScope }));
            if (!item) throw new Error('Pending operation metadata is invalid.');
            const current = readAll();
            const matching = current.filter(function (candidate) {
                return candidate.customerScope === customerScope &&
                    candidate.action === item.action && candidate.target === item.target;
            });
            if (matching.some(function (candidate) { return candidate.payloadHash !== item.payloadHash; })) {
                throw new Error('A different unresolved operation already occupies this recovery slot.');
            }
            if (!allowOperationIdChange && matching.some(function (candidate) { return candidate.operationId !== item.operationId; })) {
                throw new Error('Only a validated durable operation adoption may change an occupied operation ID.');
            }
            const values = current.filter(function (candidate) {
                return candidate.customerScope !== customerScope ||
                    candidate.action !== item.action || candidate.target !== item.target;
            });
            values.push(item);
            assertCapacity(values);
            save(values);
            return item;
        }

        function clearTerminal(action, target, outcome) {
            if (!['completed', 'rejected'].includes(outcome)) {
                throw new Error('Only a terminal operation may be cleared.');
            }
            const values = readAll().filter(function (candidate) {
                return candidate.customerScope !== customerScope ||
                    candidate.action !== action || candidate.target !== clean(target, 80);
            });
            save(values);
        }

        function find(action, target) {
            const exactTarget = clean(target, 80);
            return load().find(function (item) {
                return item.action === action && item.target === exactTarget;
            }) || null;
        }

        function adopt(value, durableOperationId, expectedPayloadHash) {
            const current = normalise(value);
            const nextId = clean(durableOperationId, 80);
            if (!current || !OPERATION_ID_PATTERN.test(nextId) || current.payloadHash !== expectedPayloadHash) {
                throw new Error('The durable operation response was invalid.');
            }
            return rememberValue(Object.assign({}, current, { operationId: nextId, timestamp: now() }), true);
        }

        function hadExpired() { return expired; }

        function save(values) {
            if (!storage || typeof storage.setItem !== 'function') {
                throw new Error('Pending operation recovery storage is unavailable. No request was sent.');
            }
            const serialized = JSON.stringify(values.map(publicMetadata));
            if (values.length > MAX_RECORDS || utf8ByteLength(serialized) > MAX_STORAGE_BYTES) {
                throw new Error('Pending operation storage is full. Existing operations were preserved.');
            }
            try {
                storage.setItem(STORAGE_KEY, serialized);
            } catch (error) {
                throw new Error('Pending operation recovery storage is unavailable. No request was sent.');
            }
        }

        return {
            adopt: adopt,
            clearTerminal: clearTerminal,
            find: find,
            hadExpired: hadExpired,
            load: load,
            remember: remember
        };
    }

    async function payloadHash(value, cryptoImplementation) {
        const cryptoValue = cryptoImplementation || (typeof crypto === 'object' ? crypto : null);
        if (!cryptoValue || !cryptoValue.subtle || typeof cryptoValue.subtle.digest !== 'function' || typeof TextEncoder !== 'function') {
            throw new Error('Secure retry protection is unavailable in this browser.');
        }
        const encoded = new TextEncoder().encode(JSON.stringify(value));
        const digest = await cryptoValue.subtle.digest('SHA-256', encoded);
        return Array.from(new Uint8Array(digest)).map(function (byte) {
            return byte.toString(16).padStart(2, '0');
        }).join('');
    }

    function operationDisposition(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const status = String(source.status || '');
        if (status === 'pending' || status === 'confirmation_required') return 'pending';
        if (status === 'completed' || status === 'known_absent' || status === 'rejected') return 'terminal';
        return 'unknown';
    }

    function normalise(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const action = value.action === 'create' || value.action === 'reply' ? value.action : '';
        const item = {
            operationId: clean(value.operationId, 80),
            action: action,
            target: clean(value.target, 80),
            payloadHash: clean(value.payloadHash, 64).toLowerCase(),
            customerScope: clean(value.customerScope, 180),
            timestamp: Number(value.timestamp)
        };
        if (!OPERATION_ID_PATTERN.test(item.operationId) || !item.action ||
            (item.action === 'create' ? item.target !== '' : !item.target) ||
            !SHA256_PATTERN.test(item.payloadHash) || !item.customerScope || !Number.isFinite(item.timestamp)) return null;
        return item;
    }

    function publicMetadata(value) {
        return {
            operationId: value.operationId,
            action: value.action,
            target: value.target,
            payloadHash: value.payloadHash,
            customerScope: value.customerScope,
            timestamp: value.timestamp
        };
    }

    function assertCapacity(values) {
        if (values.length > MAX_RECORDS) {
            throw new Error('Pending operation storage is full. Existing operations were preserved.');
        }
        const serialized = JSON.stringify(values.map(publicMetadata));
        if (utf8ByteLength(serialized) > MAX_STORAGE_BYTES) {
            throw new Error('Pending operation storage exceeds the safe recovery limit. Existing operations were preserved.');
        }
    }

    function compareNewestFirst(left, right) {
        return right.timestamp - left.timestamp ||
            left.customerScope.localeCompare(right.customerScope) ||
            left.action.localeCompare(right.action) || left.target.localeCompare(right.target);
    }

    function recoverySlot(value) {
        return `${value.customerScope}\u0000${value.action}\u0000${value.target}`;
    }

    function utf8ByteLength(value) {
        const text = String(value || '');
        let bytes = 0;
        for (let index = 0; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            if (code < 0x80) bytes += 1;
            else if (code < 0x800) bytes += 2;
            else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
                text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
                bytes += 4;
                index += 1;
            } else bytes += 3;
        }
        return bytes;
    }

    function clean(value, maximum) {
        return String(value == null ? '' : value).trim().slice(0, maximum);
    }

    return {
        OPERATION_ID_PATTERN: OPERATION_ID_PATTERN,
        MAX_RECORDS: MAX_RECORDS,
        MAX_STORAGE_BYTES: MAX_STORAGE_BYTES,
        STORAGE_KEY: STORAGE_KEY,
        createStore: createStore,
        operationDisposition: operationDisposition,
        payloadHash: payloadHash
    };
}));
