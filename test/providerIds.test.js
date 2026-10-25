const { isCanonicalProviderId, parseCanonicalProviderId } = require('../api/shared/serviceDesk/providerIds');

describe('canonical provider IDs', () => {
    test.each([
        ['10', '10'],
        [10, '10'],
        [String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER)]
    ])('accepts canonical positive safe integer %p', (value, expected) => {
        expect(parseCanonicalProviderId(value)).toBe(expected);
        expect(isCanonicalProviderId(value)).toBe(true);
    });

    test.each(['010', '0', '', '10.0', '1e2', String(Number.MAX_SAFE_INTEGER) + '1', Number.MAX_SAFE_INTEGER + 1])(
        'rejects non-canonical provider ID %p',
        (value) => {
            expect(parseCanonicalProviderId(value)).toBe('');
            expect(isCanonicalProviderId(value)).toBe(false);
        }
    );
});
