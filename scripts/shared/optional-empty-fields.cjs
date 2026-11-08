'use strict';

/**
 * Test selected optional fields on an already-validated JSON object.
 *
 * The caller supplies a dense array of string keys. Each field must either be
 * absent as an own property or contain the literal empty string. This helper
 * does not validate the record schema, normalize values, or mutate either input.
 */
function hasOnlyEmptyOptionalFields(record, keys) {
    return keys.every(key => !Object.hasOwn(record, key) || record[key] === '');
}

module.exports = { hasOnlyEmptyOptionalFields };
