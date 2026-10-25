'use strict';

// Provider record IDs are kept as canonical decimal strings so they can be
// compared and hashed without losing precision in JavaScript numbers.
function parseCanonicalProviderId(value) {
    if (value == null) return '';
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return '';
    const text = String(value);
    if (!/^[1-9][0-9]*$/.test(text)) return '';
    const numeric = Number(text);
    return Number.isSafeInteger(numeric) && numeric > 0 ? text : '';
}

function isCanonicalProviderId(value) {
    return Boolean(parseCanonicalProviderId(value));
}

module.exports = {
    isCanonicalProviderId,
    parseCanonicalProviderId
};
